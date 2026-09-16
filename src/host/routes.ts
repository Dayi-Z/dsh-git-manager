/**
 * dsh-git-manager — /gitm/* HTTP routes: workspace-bounded git operations plus
 * GitHub auth / PR endpoints. All git ops pass the workspace gate; GitHub ops
 * never expose the token to the client.
 * @module dsh-git-manager/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { access, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GitError, WorkspaceEntry } from '../core/types.ts'
import type { GitService } from './git-service.ts'
import type { EventBus } from './event-bus.ts'
import { preApprove, panelApprovalBroker, listPreApprovals, revokePreApproval } from './event-bus.ts'
import {
  clearToken, ghLoggedIn, pollDeviceFlow, readToken, saveToken, startDeviceFlow, syncToGh,
} from './github-auth.ts'
import {
  authState as ghAuthState, commentPR, createPR, findPRForBranch, getIssueDetail, getPRDetail, listIssues, listPRs,
  mergePR, prMapByCommit, repoFromUrl, reviewPR, commentIssue, createIssue,
} from './github-service.ts'
import { ancestorOriginUrl } from './git-service.ts'
import { shelfAdd, shelfList, shelfRemove } from './repo-store.ts'

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
  const entries = new Map<string, WorkspaceEntry>()
  for (const workspace of ctx.workspaceRegistry.list()) {
    try {
      await access(join(workspace.path, GIT_MARK))
      entries.set(workspace.path, { path: workspace.path, title: workspace.title })
    } catch { /* not a git repo — skip */ }
  }
  // 插件自持仓库清单：嵌套独立仓库（如 monorepo 内的子仓库）在这里补充。
  for (const repo of shelfList()) {
    try {
      await access(join(repo.path, GIT_MARK))
      if (!entries.has(repo.path)) {
        entries.set(repo.path, { path: repo.path, title: repo.title ?? repo.path.split(/[\\/]/).pop() ?? repo.path })
      }
    } catch { /* moved/deleted — ignore */ }
  }
  return [...entries.values()]
}

/** 从 workspace 的 origin 解析 GitHub 仓库 + 当前分支的开放 PR。
 *  monorepo 子目录（自身 .git 无 remote）时向上回溯父仓库 origin。 */
async function githubRepoForPath(ctx: Context, service: GitService, path: string): Promise<Envelope<{ owner: string; repo: string; branch: string; prNumber: number | null; connected: boolean; login?: string }>> {
  try {
    const [originRaw, branch] = await Promise.all([service.originUrl(path), service.currentBranch(path)])
    let parsed = repoFromUrl(originRaw)
    let origin = originRaw
    if (!parsed) {
      const anc = await ancestorOriginUrl(path)
      if (anc) {
        parsed = repoFromUrl(anc.url)
        if (parsed) origin = `${anc.url} (inherited from parent repo ${anc.dir})`
      }
    }
    if (!parsed) return { ok: false, error: { code: 'no-github-remote', message: `origin 未指向 GitHub 仓库：${origin || '(未配置任何 remote)'}` } }
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
  eventBus: EventBus
}

export function route(services: Services) {
  const { service, ctx, eventBus } = services
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://dsh')
    const path = url.pathname

    // SSE endpoint: live event stream for the activity monitor
    if (path === '/gitm/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      })
      const send = (event: { id: string; type: string; timestamp: number; data: Record<string, unknown> }): void => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      // 发送最近历史
      for (const event of eventBus.getHistory(100)) send(event)
      const unsub = eventBus.subscribe('*', send)
      const unpanel = eventBus.markPanelConnected()
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 25_000)
      req.on('close', () => { clearInterval(ping); unsub(); unpanel() })
      return
    }

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
      case '/gitm/workspaces': return ok(res, await listGitWorkspaces(ctx))
      case '/gitm/repos-add': {
        const p = field(payload, 'path')
        if (p === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          let canonical: string
          try { canonical = await realpath(p) } catch { throw Object.assign(new Error('路径不存在'), { gitError: { code: 'bad-request', message: 'path not found' } }) }
          if (!existsSync(join(canonical, GIT_MARK))) throw Object.assign(new Error('该目录不是 git 仓库（缺 .git）'), { gitError: { code: 'bad-request', message: 'not a git repo' } })
          shelfAdd({ path: canonical, title: canonical.split(/[\\/]/).pop() })
          return await listGitWorkspaces(ctx)
        })
      }
      case '/gitm/repos-remove': {
        const p = field(payload, 'path')
        if (p === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          shelfRemove(await realpath(p).catch(() => p))
          return await listGitWorkspaces(ctx)
        })
      }
      case '/gitm/current': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.current(root))
      }
      case '/gitm/branches': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.branches(root))
      }
      case '/gitm/graph': {
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
      case '/gitm/flow': {
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
      case '/gitm/switch': {
        const branch = field(payload, 'branch'); if (root === null || branch === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.switchBranch(root, branch))
      }
      case '/gitm/create-branch': {
        const branch = field(payload, 'branch'); if (root === null || branch === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.createBranch(root, branch))
      }
      case '/gitm/pull': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        const rebase = boolField(payload, 'rebase') ?? false
        return wrap(async () => await service.pull(root, rebase))
      }
      case '/gitm/fetch': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.fetchAll(root))
      }
      case '/gitm/push': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        const remote = field(payload, 'remote') ?? undefined
        const branch = field(payload, 'branch') ?? undefined
        return wrap(async () => await service.push(root, remote, branch))
      }
      case '/gitm/commit': {
        const message = field(payload, 'message'); if (root === null || message === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.commit(root, message))
      }
      case '/gitm/stage': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.stageFile(root, file))
      }
      case '/gitm/unstage': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.unstageFile(root, file))
      }
      case '/gitm/stage-all': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.stageAll(root))
      }
      case '/gitm/status': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.status(root))
      }
      case '/gitm/diff': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.diffFile(root, file))
      }
      // 全文件对照（文件审批标签页）：before/after 全文 + 增删行号集合
      // 注意：service.reviewFile 自带一层 {ok,value} 信封——这里必须解包，
      // 否则客户端拿到双重信封，把内层信封当 ComparePayload 渲染直接崩溃。
      case '/gitm/review-file': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          const r = await service.reviewFile(root, file)
          if (!r.ok || r.value === undefined) throw { code: 'review-failed', message: 'review-file failed' } as GitError
          return r.value
        })
      }
      case '/gitm/delete': {
        const branch = field(payload, 'branch'); if (root === null || branch === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.deleteBranch(root, branch))
      }
      // 传出的更改：@{u}..HEAD 的提交列表（无上游 → 空数组）。
      case '/gitm/outgoing':
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.outgoing(root))
      // 丢弃单文件本地更改（已跟踪 checkout --；未跟踪 clean -f --）。
      case '/gitm/discard': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.discardFile(root, file))
      }
      // 图谱下钻：单个提交的变更文件清单 / 单文件补丁。
      case '/gitm/commit-files': {
        const sha = field(payload, 'sha'); if (root === null || sha === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.commitFiles(root, sha))
      }
      case '/gitm/commit-patch': {
        const sha = field(payload, 'sha'); const file = field(payload, 'file')
        if (root === null || sha === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.commitPatch(root, sha, file))
      }
      // gh/API 通道推送：github.com 直连不可用时的恢复路径（逐提交在 GitHub 端重建）。
      case '/gitm/api-push':
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.apiPush(root))
      case '/gitm/rename': {
        const branch = field(payload, 'branch'); const newName = field(payload, 'newName')
        if (root === null || branch === null || newName === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.renameBranch(root, branch, newName))
      }
      case '/gitm/delete-remote': {
        const branch = field(payload, 'branch'); if (root === null || branch === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.deleteRemoteBranch(root, branch))
      }
      case '/gitm/merge': {
        const branch = field(payload, 'branch'); if (root === null || branch === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.mergeBranch(root, branch))
      }
      case '/gitm/stash-list': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.stashList(root))
      }
      case '/gitm/stash-push': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        const message = field(payload, 'message') ?? undefined
        return wrap(async () => await service.stashPush(root, message))
      }
      case '/gitm/stash-pop': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.stashPop(root))
      }
      // 贮藏明细：按引用 应用（保留栈）/ 丢弃
      case '/gitm/stash-apply': {
        const ref = field(payload, 'ref'); const action = field(payload, 'action') ?? 'apply'
        if (root === null || ref === null || (action !== 'apply' && action !== 'drop')) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.stashAction(root, action, ref))
      }
      // 撤销最近一次提交（soft reset，改动保留在暂存区）
      case '/gitm/undo-commit':
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.undoCommit(root))
      // 修补最近一次提交（amend）
      case '/gitm/amend': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        const message = field(payload, 'message') ?? undefined
        return wrap(async () => await service.amendCommit(root, message))
      }
      // 冲突状态与出口：逐文件 我方/对方、中止、变基继续
      case '/gitm/conflict-state':
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.conflictState(root))
      case '/gitm/conflict-resolve': {
        const file = field(payload, 'file'); const side = field(payload, 'side')
        if (root === null || file === null || (side !== 'ours' && side !== 'theirs')) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.resolveConflict(root, file, side))
      }
      case '/gitm/conflict-abort': {
        const kind = field(payload, 'kind')
        if (root === null || (kind !== 'merge' && kind !== 'rebase')) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.abortConflict(root, kind))
      }
      case '/gitm/rebase-continue':
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.continueRebase(root))
      // 标签：列表 / 建（可注释）/ 删 / 推
      case '/gitm/tags':
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.tags(root))
      case '/gitm/tag-create': {
        const name = field(payload, 'name'); if (root === null || name === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.tagCreate(root, name, field(payload, 'message') ?? undefined))
      }
      case '/gitm/tag-delete': {
        const name = field(payload, 'name'); if (root === null || name === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.tagDelete(root, name))
      }
      case '/gitm/tag-push': {
        const name = field(payload, 'name'); if (root === null || name === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.tagPush(root, name))
      }
      // 未跟踪文件一键加入 .gitignore
      case '/gitm/gitignore-add': {
        const file = field(payload, 'file'); if (root === null || file === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.gitignoreAdd(root, file))
      }
      // 从 URL 克隆到父目录并登记书架，返回完整清单
      case '/gitm/clone': {
        const parent = field(payload, 'parent'); const url = field(payload, 'url')
        if (parent === null || url === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          const r = await service.cloneRepo(parent, url)
          const canonical = await realpath(r.path)
          shelfAdd({ path: canonical, title: canonical.split(/[\\/]/).pop() })
          return { path: canonical, workspaces: await listGitWorkspaces(ctx) }
        })
      }
      case '/gitm/cherry-pick': {
        const sha = field(payload, 'sha'); if (root === null || sha === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.cherryPick(root, sha))
      }
      case '/gitm/revert': {
        const sha = field(payload, 'sha'); if (root === null || sha === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await service.revertCommit(root, sha))
      }

      // ---------------- GitHub auth ----------------
      // 注意：这些返回值不能带 `ok` 键（wrap 会把带 ok 的对象当 OpResult 再包一层）。
      case '/gitm/github/auth': return wrap(async () => {
        const state = await ghAuthState()
        const ghAvailable = await ghLoggedIn()
        return { ...state, ghAvailable }
      })
      case '/gitm/github/device': return wrap(async () => {
        const code = await startDeviceFlow()
        return { userCode: code.userCode, verificationUri: code.verificationUri, interval: code.interval, deviceCode: code.deviceCode }
      })
      case '/gitm/github/poll': {
        const deviceCode = field(payload, 'deviceCode')
        const interval = numField(payload, 'interval') ?? 5
        if (deviceCode === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          const token = await pollDeviceFlow(deviceCode, interval)
          if (!token) return { pending: true }
          await saveToken(token)
          // gh CLI 同步不阻塞登录响应；即使 gh 缺失/失败也不影响面板状态。
          void syncToGh(token).catch(() => {})
          return { pending: false }
        })
      }
      case '/gitm/github/token': {
        const token = field(payload, 'token'); if (token === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          await saveToken(token)
          void syncToGh(token).catch(() => {})
          return { saved: true }
        })
      }
      case '/gitm/github/logout': return wrap(async () => {
        await clearToken()
        return await ghAuthState()
      })
      case '/gitm/github/repo': {
        if (root === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => { const r = await githubRepoForPath(ctx, service, root); if (!r.ok) throw Object.assign(new Error(r.error.message), { gitError: r.error }); return r.value })
      }

      // ---------------- GitHub PRs / issues ----------------
      case '/gitm/github/prs': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo')
        if (owner === null || repo === null) return fail(res, BAD_REQUEST, 400)
        const state = field(payload, 'state') ?? 'open'
        return wrap(async () => await listPRs(owner, repo, state as 'open' | 'closed' | 'all'))
      }
      case '/gitm/github/pr': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number')
        if (owner === null || repo === null || number === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await getPRDetail(owner, repo, number))
      }
      case '/gitm/github/pr-create': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo')
        const title = field(payload, 'title'); const head = field(payload, 'head'); const base = field(payload, 'base')
        if (owner === null || repo === null || title === null || head === null || base === null) return fail(res, BAD_REQUEST, 400)
        const body = field(payload, 'body') ?? undefined
        const draft = boolField(payload, 'draft') ?? false
        return wrap(async () => await createPR(owner, repo, { title, body, head, base, draft }))
      }
      case '/gitm/github/pr-merge': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number')
        const method = (field(payload, 'method') ?? 'squash') as 'merge' | 'squash' | 'rebase'
        if (owner === null || repo === null || number === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => { await mergePR(owner, repo, number, method); return { merged: true } })
      }
      case '/gitm/github/pr-comment': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number'); const body = field(payload, 'body')
        if (owner === null || repo === null || number === null || body === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => { await commentPR(owner, repo, number, body); return { commented: true } })
      }
      case '/gitm/github/pr-review': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number')
        const state = field(payload, 'state'); const body = field(payload, 'body') ?? undefined
        if (owner === null || repo === null || number === null || state === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => {
          await reviewPR(owner, repo, number, state as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body)
          return { reviewed: true }
        })
      }
      case '/gitm/github/issues': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo')
        if (owner === null || repo === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await listIssues(owner, repo))
      }
      case '/gitm/github/issue-create': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const title = field(payload, 'title')
        const body = field(payload, 'body') ?? undefined
        if (owner === null || repo === null || title === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await createIssue(owner, repo, title, body))
      }
      case '/gitm/github/issue-comment': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number'); const body = field(payload, 'body')
        if (owner === null || repo === null || number === null || body === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => { await commentIssue(owner, repo, number, body); return { commented: true } })
      }
      case '/gitm/github/issue': {
        const owner = field(payload, 'owner'); const repo = field(payload, 'repo'); const number = numField(payload, 'number')
        if (owner === null || repo === null || number === null) return fail(res, BAD_REQUEST, 400)
        return wrap(async () => await getIssueDetail(owner, repo, number))
      }
      // Panel → host: pre-approve a tool (skip modal dialog when agent requests it)
      case '/gitm/preapprove': {
        const tool = field(payload, 'tool'); const callId = field(payload, 'callId')
        if (tool === null) return fail(res, BAD_REQUEST, 400)
        preApprove(tool, callId ?? undefined)
        return json(res, { ok: true, value: { preApproved: true } })
      }
      // Panel → host: list / revoke session pre-approvals (visibility + undo).
      case '/gitm/preapprove-list':
        return json(res, { ok: true, value: { tools: listPreApprovals() } })
      case '/gitm/preapprove-clear': {
        const tool = field(payload, 'tool')
        revokePreApproval(tool ?? undefined)
        return json(res, { ok: true, value: { cleared: true, tools: listPreApprovals() } })
      }
      // Panel → host: resolve a LIVE approval request (approve/reject button).
      case '/gitm/approval': {
        const callId = field(payload, 'callId'); const decisionRaw = field(payload, 'decision')
        if (callId === null || (decisionRaw !== 'approved' && decisionRaw !== 'rejected')) return fail(res, BAD_REQUEST, 400)
        const resolved = panelApprovalBroker.decide(callId, decisionRaw)
        if (eventBus) {
          eventBus.emit(decisionRaw === 'approved' ? 'approval:approved' : 'approval:rejected', {
            tool: field(payload, 'tool') ?? '',
            callId,
            summary: `panel ${decisionRaw}`,
            source: 'panel',
          })
        }
        return json(res, { ok: true, value: { resolved } })
      }
      // Demo: emit a fabricated file-review approval card so the UI can be
      // exercised without a real agent write. Nothing is executed; the card
      // resolves nothing (broker has no waiter) and is purely cosmetic.
      case '/gitm/preview-review': {
        const sampleFiles = [
          {
            path: 'src/client/Panel.tsx',
            additions: 4, deletions: 1,
            diff: '',
            beforeFull: { exists: true, text: 'import { t } from \'./i18n.ts\'\n\nconst css = ``\n\nexport function CompassPanel() {\n  return (\n    <div className="gm-panel">\n    </div>\n  )\n}\n' },
            afterFull: { text: 'import { t } from \'./i18n.ts\'\n\nconst css = `\n.panel-grid{display:grid;grid-template-columns:1fr 1fr}\n.panel-grid .del{background:rgba(248,81,73,.16)}\n.panel-grid .add{background:rgba(46,160,67,.16)}\n`\n\nexport function CompassPanel() {\n  const [tab, setTab] = useState<TabId>(\'changes\')\n  return (\n    <div className="gm-panel">\n    </div>\n  )\n}\n' },
            delLines: [3],
            addLines: [3, 4, 5, 6, 9],
          },
          {
            path: 'README.zh.md',
            additions: 2, deletions: 0,
            diff: '',
            beforeFull: { exists: true, text: '# dsh-git-manager\n\n## 功能特性\n\n- 引导式 GitHub Flow 流程条\n\n## 安装\n' },
            afterFull: { text: '# dsh-git-manager\n\n## 功能特性\n\n- 引导式 GitHub Flow 流程条\n- **Agent 活动监视器**：实时 SSE 事件流\n- **面板内审批**：批准 / 拒绝 / 本会话允许\n\n## 安装\n' },
            delLines: [],
            addLines: [5, 6],
          },
          {
            path: 'assets/logo.png',
            additions: null, deletions: null,
            binary: true, diff: '',
          },
        ]
        eventBus.emit('approval:requested', {
          tool: 'git_commit',
          callId: `preview-${Date.now()}`,
          summary: 'demo · git commit "Review all staged changes before push" (workspace: D:\\project\\sample)',
          files: sampleFiles,
        })
        return json(res, { ok: true, value: { emitted: true } })
      }
      default:
        return fail(res, { code: 'unknown', message: `unknown route ${path}` }, 404)
    }
  }
}

export function registerGitManagerRoutes(ctx: Context, service: GitService, eventBus: EventBus): () => void {
  return ctx.webServer.register({ kind: 'prefix', path: '/gitm', handler: route({ service, ctx, eventBus }) })
}

// Re-exported for tests/tools.
export { readToken }





