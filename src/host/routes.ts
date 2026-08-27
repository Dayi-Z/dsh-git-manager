/**
 * gitcompass — /gitu/* HTTP routes: workspace-bounded git operations plus
 * GitHub auth / PR endpoints. All git ops pass the workspace gate; GitHub ops
 * never expose the token to the client.
 * @module gitcompass/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GitError, WorkspaceEntry } from '../core/types.ts'
import type { GitService } from './git-service.ts'
import {
  clearToken, ghLoggedIn, pollDeviceFlow, readToken, saveToken, startDeviceFlow, syncToGh,
} from './github-auth.ts'
import {
  authState as ghAuthState, commentPR, createPR, findPRForBranch, getPRDetail, listIssues, listPRs,
  mergePR, prMapByCommit, repoFromUrl, reviewPR, commentIssue, createIssue,
} from './github-service.ts'

type Envelope<T> = { ok: true; value: T } | { ok: false; error: GitError }

const BODY_CAP_BYTES = 1 << 20

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const part = chunk as Buffer
    total += part.length
    if (total > BODY_CAP_BYTES) { req.destroy(); return null }
    chunks.push(part)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try { return JSON.parse(text) as unknown } catch { return null }
}

function json(res: ServerResponse, envelope: Envelope<unknown>, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

function ok<T>(res: ServerResponse, value: T): void { json(res, { ok: true, value }) }
function fail(res: ServerResponse, error: GitError, status = 200): void { json(res, { ok: false, error }, status) }
function field(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}
function numField(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function boolField(payload: unknown, key: string): boolean | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : null
}

const BAD_REQUEST: GitError = { code: 'bad-request', message: 'malformed request' }
const GIT_MARK = '.git'

async function listGitWorkspaces(ctx: Context): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    try {
      await access(join(workspace.path, GIT_MARK))
      entries.push({ path: workspace.path, title: workspace.title })
    } catch { /* not a git repo — skip */ }
  }
  return entries
}

/** 从 workspace 的 origin 解析 GitHub 仓库 + 当前分支的开放 PR。 */
async function githubRepoForPath(ctx: Context, service: GitService, path: string): Promise<Envelope<{ owner: string; repo: string; branch: string; prNumber: number | null; connected: boolean; login?: string }>> {
  try {
    const [origin, branch] = await Promise.all([service.originUrl(path), service.currentBranch(path)])
    const parsed = repoFromUrl(origin)
    if (!parsed) return { ok: false, error: { code: 'no-github-remote', message: 'origin 不是 GitHub 仓库' } }
    const state = await ghAuthState()
    let prNumber: number | null = null
    if (state.connected && branch) {
      const pr = await findPRForBranch(parsed.owner, parsed.repo, branch).catch(() => null)
      prNumber = pr?.number ?? null
    }
    return { ok: true, value: { owner: parsed.owner, repo: parsed.repo, branch, prNumber, connected: state.connected, login: state.login } }
  } catch (error) {
    return { ok: false, error: { code: 'github-repo-failed', message: String(error instanceof Error ? error.message : error) } }
  }
}

interface Services {
  service: GitService
  ctx: Context
}

export function route(services: Services) {
  const { service, ctx } = services
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://dsh')
    const path = url.pathname
    if (req.method !== 'POST') { fail(res, { code: 'method', message: 'method not allowed' }, 405); return }
    const payload = await readJsonBody(req)
    const root = field(payload, 'path')

    const wrap = async (fn: () => Promise<unknown>): Promise<void> => {
      try {
        const result = await fn()
        if (result !== null && typeof result === 'object' && 'ok' in result) {
          const r = result as { ok: boolean; error?: GitError }
          if (r.ok) { json(res, { ok: true, value: result }); return }
          json(res, { ok: false, error: r.error ?? { code: 'internal', message: 'operation failed' } })
          return
        }
        json(res, { ok: true, value: result })
      } catch (error) {
        const gitError: GitError = (error as { gitError?: GitError }).gitError ?? { code: 'internal', message: String(error instanceof Error ? error.message : error) }
        fail(res, gitError)
      }
    }

    switch (path) {
      // ---------------- workspaces / git ----------------
      case '/gitu/workspaces': return ok(res, await listGitWorkspaces(ctx))
      case '/gitu/current': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.current(root))
      }
      case '/gitu/branches': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.branches(root))
      }
      case '/gitu/graph': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          const graph = await service.graph(root)
          // 附加 PR 徽章：用合并提交/分支头映射到 PR。
          try {
            const origin = await service.originUrl(root)
            const parsed = repoFromUrl(origin)
            if (parsed) {
              const map = await prMapByCommit(parsed.owner, parsed.repo).catch(() => ({}) as Record<string, import('../core/types.ts').PullRequestSummary>)
              for (const commit of graph.commits) {
                if (map[commit.sha]) commit.prNumber = map[commit.sha].number
              }
            }
          } catch { /* badges are best-effort */ }
          return graph
        })
      }
      case '/gitu/flow': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          const [repo, current, aheadBehind, upstream, dirty] = await Promise.all([
            service.current(root).then((c) => c.repo),
            service.current(root).then((c) => c.current),
            service.aheadBehind(root),
            service.upstream(root),
            service.isDirty(root),
          ])
          const origin = await service.originUrl(root)
          const parsed = repoFromUrl(origin)
          let prNumber: number | null = null
          if (parsed && current) {
            prNumber = (await findPRForBranch(parsed.owner, parsed.repo, current).catch(() => null))?.number ?? null
          }
          const hasRemote = origin !== ''
          const steps = [
            { id: 'branch', phase: current ? 2 : 0 },
            { id: 'commit', phase: !dirty ? 2 : 1 },
            { id: 'push', phase: hasRemote && aheadBehind.ahead === 0 ? 2 : dirty ? 0 : 1 },
            { id: 'pr', phase: prNumber ? 2 : 1 },
            { id: 'review', phase: 1 },
            { id: 'merge', phase: 1 },
          ] as Array<{ id: 'branch' | 'commit' | 'push' | 'pr' | 'review' | 'merge'; phase: 0 | 1 | 2 }>
          return { repo, current, ...aheadBehind, hasRemote, upstreamSet: upstream !== '', prNumber, dirty, steps }
        })
      }
      case '/gitu/switch': {
        const branch = field(payload, 'branch'); if (root === null || branch === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.switchBranch(root, branch))
      }
      case '/gitu/create-branch': {
        const branch = field(payload, 'branch'); if (root === null || branch === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.createBranch(root, branch))
      }
      case '/gitu/pull': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.pull(root))
      }
      case '/gitu/fetch': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.fetchAll(root))
      }
      case '/gitu/push': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        const remote = field(payload, 'remote') ?? undefined
        const branch = field(payload, 'branch') ?? undefined
        return wrap(async () => await service.push(root, remote, branch))
      }
      case '/gitu/commit': {
        const message = field(payload, 'message'); if (root === null || message === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.commit(root, message))
      }
      case '/gitu/stage': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.stageFile(root, file))
      }
      case '/gitu/unstage': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.unstageFile(root, file))
      }
      case '/gitu/stage-all': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.stageAll(root))
      }
      case '/gitu/status': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.status(root))
      }
      case '/gitu/diff': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.diffFile(root, file))
      }
      case '/gitu/delete': {
        const branch = field(payload, 'branch'); if (root === null || branch === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.deleteBranch(root, branch))
      }

      // ---------------- GitHub auth ----------------
      // 注意：这些返回值不能带 `ok` 键（wrap 会把带 ok 的对象当 OpResult 再包一层）。
      case '/gitu/github/auth': return wrap(async () => {
        const state = await ghAuthState()
        const ghAvailable = await ghLoggedIn()
        return { ...state, ghAvailable }
      })
      case '/gitu/github/device': return wrap(async () => {
        const code = await startDeviceFlow()
        return { userCode: code.userCode, verificationUri: code.verificationUri, interval: code.interval, deviceCode: code.deviceCode }
      })
      case '/gitu/github/poll': {
        const deviceCode = field(payload, 'deviceCode')
        const interval = numField(payload, 'interval') ?? 5
        if (deviceCode === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          const token = await pollDeviceFlow(deviceCode, interval)
          if (!token) return { pending: true }
          await saveToken(token)
          await syncToGh(token)
          const state = await ghAuthState()
          return { pending: false, ...state }
        })
      }
      case '/gitu/github/token': {
        const token = field(payload, 'token'); if (token === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          await saveToken(token)
          await syncToGh(token)
          return await ghAuthState()
        })
      }
      case '/gitu/github/logout': return wrap(async () => {
        await clearToken()
        return await ghAuthState()
      })
      case '/gitu/github/repo': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => { const r = await githubRepoForPath(ctx, service, root); if (!r.ok) throw Object.assign(new Error(r.error.message), { gitError: r.error }); return r.value })
      }

      // ---------------- GitHub PRs / issues ----------------
      case '/gitu/github/prs': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo')
        if (owner === null || repo === null) return fail(res, BAD_REQUEST, 400)
        const state = field(payload, 'state') ?? 'open'
        return wrap(async () => await listPRs(owner, repo, state as 'open' | 'closed' | 'all'))
      }
      case '/gitu/github/pr': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number')
        if (owner === null || repo === null || number === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await getPRDetail(owner, repo, number))
      }
      case '/gitu/github/pr-create': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo')
        const title = field(payload, 'title'); const head = field(payload, 'head'); const base = field(payload, 'base')
        if (owner === null || repo === null || title === null || head === null || base === null) return fail(res, BAD_REQUEST, 400)
        const body = field(payload, 'body') ?? undefined
        const draft = boolField(payload, 'draft') ?? false
        return wrap(async () => await createPR(owner, repo, { title, body, head, base, draft }))
      }
      case '/gitu/github/pr-merge': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number')
        const method = (field(payload, 'method') ?? 'squash') as 'merge' | 'squash' | 'rebase'
        if (owner === null || repo === null || number === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => { await mergePR(owner, repo, number, method); return { merged: true } })
      }
      case '/gitu/github/pr-comment': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number'); const body = field(payload, 'body')
        if (owner === null || repo === null || number === null || body === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => { await commentPR(owner, repo, number, body); return { commented: true } })
      }
      case '/gitu/github/pr-review': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number')
        const state = field(payload, 'state'); const body = field(payload, 'body') ?? undefined
        if (owner === null || repo === null || number === null || state === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          await reviewPR(owner, repo, number, state as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body)
          return { reviewed: true }
        })
      }
      case '/gitu/github/issues': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo')
        if (owner === null || repo === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await listIssues(owner, repo))
      }
      case '/gitu/github/issue-create': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const title = field(payload, 'title')
        const body = field(payload, 'body') ?? undefined
        if (owner === null || repo === null || title === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await createIssue(owner, repo, title, body))
      }
      case '/gitu/github/issue-comment': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number'); const body = field(payload, 'body')
        if (owner === null || repo === null || number === null || body === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => { await commentIssue(owner, repo, number, body); return { commented: true } })
      }
      default:
        return fail(res, { code: 'unknown', message: `unknown route ${path}` }, 404)
    }
  }
}

export function registerGitcompassRoutes(ctx: Context, service: GitService): () => void {
  return ctx.webServer.register({ kind: 'prefix', path: '/gitu', handler: route({ service, ctx }) })
}

// Re-exported for tests/tools.
export { readToken }





