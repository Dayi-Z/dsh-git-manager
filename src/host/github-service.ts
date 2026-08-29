/**
 * gitcompass — GitHub REST wrapper (host side, token never leaves the host).
 * Layered channel: direct fetch → gh CLI fallback (`gh api`) when the direct
 * connection fails (Node fetch ignores system proxy; gh applies its own
 * network config). Every endpoint in PR/Issues/GitHub tabs funnels through
 * here, so the gh channel covers all of them.
 * @module gitcompass/host/github-service
 */

import { spawn } from 'node:child_process'
import type { CheckRun, GitHubAuthState, IssueSummary, PullRequestDetail, PullRequestSummary, ReviewComment } from '../core/types.ts'
import { resolveToken, ghToken } from './github-auth.ts'

export class GitHubApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

interface GhResult<T> {
  json: T
  scopes: string[]
}

/** 直连通道：单次 HTTP 尝试。网络级失败抛普通 Error；HTTP 状态错误抛 GitHubApiError。 */
async function directGh<T>(method: string, path: string, body: unknown, token: string): Promise<GhResult<T>> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'gitcompass-dsh-plugin',
      ...body !== undefined ? { 'content-type': 'application/json' } : {},
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!res.ok) {
    let detail = ''
    try {
      const j = (await res.json()) as { message?: string }
      detail = j.message ?? ''
    } catch { /* non-json */ }
    throw new GitHubApiError(`GitHub API ${res.status}${detail ? `: ${detail}` : ''}`, res.status)
  }
  if (res.status === 204) return { json: undefined as T, scopes }
  return { json: (await res.json()) as T, scopes }
}

/** gh CLI 通道：`gh api` 走 gh 自己的网络/代理配置。仅在网络直连失败时启用。 */
function cliGh<T>(method: string, path: string, body?: unknown): Promise<GhResult<T>> {
  const GH_TIMEOUT = 10_000
  return new Promise((resolve, reject) => {
    const args = ['api', path, '--method', method]
    // gh api 默认不读 stdin：带 body 的请求必须显式 --input -，否则载荷静默丢失
    if (body !== undefined) args.push('--input', '-')
    const child = spawn('gh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let done = false
    const to = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      if (!done) { done = true; reject(new Error('gh CLI timed out')) }
    }, GH_TIMEOUT)
    const finish = () => { clearTimeout(to) }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => { stdout += c })
    child.stderr.on('data', (c: string) => { stderr += c })
    child.on('error', () => { if (!done) { done = true; finish(); reject(new Error('gh CLI unavailable for API fallback')) } })
    child.on('close', (code) => {
      if (done) return
      done = true
      finish()
      if (code === 0) {
        try { resolve({ json: stdout.trim() === '' ? undefined as T : JSON.parse(stdout) as T, scopes: [] }) }
        catch (e) { reject(new Error(`gh api parse error: ${String(e instanceof Error ? e.message : e)}`)) }
        return
      }
      // gh 把 HTTP 状态写进 stderr（如 "Not Found (HTTP 404)"）。
      const m = /\(HTTP (\d{3})\)/.exec(stderr)
      reject(new GitHubApiError(`GitHub API via gh ${m ? m[1] : 'failed'}: ${stderr.trim().slice(0, 200)}`, m ? Number(m[1]) : undefined))
    })
    if (body !== undefined) child.stdin.write(JSON.stringify(body))
    child.stdin.end()
  })
}

/**
 * 统一入口：候选令牌逐一尝试直连；401/403 换下一个候选；
 * 纯网络失败 → 整体切到 gh CLI 通道（覆盖 PR / Issues / 认证检查全部端点）。
 */
async function gh<T>(method: string, path: string, body?: unknown): Promise<GhResult<T>> {
  const stored = await resolveToken()
  const ghTok = await ghToken()
  const candidates: Array<{ token: string; source: 'stored' | 'gh' }> = []
  if (stored?.token) candidates.push({ token: stored.token, source: 'stored' })
  if (ghTok && ghTok !== stored?.token) candidates.push({ token: ghTok, source: 'gh' })

  let networkFailed = false
  for (const c of candidates) {
    try {
      return await directGh<T>(method, path, body, c.token)
    } catch (e) {
      if (e instanceof GitHubApiError) {
        // 该令牌无效：换下一个候选。其他 HTTP 错误（404/422…）是权威响应，直接抛。
        if ((e.status === 401 || e.status === 403) && c.source === 'stored' && candidates.length > 1) continue
        throw e
      }
      // 网络级失败：不再遍历候选（同一网络环境），切换 CLI 通道。
      networkFailed = true
      break
    }
  }
  // 到这里要么网络失败、要么本地完全无令牌——gh 可能已登录，CLI 是唯一通道。
  return cliGh<T>(method, path, body)
}

/** 统一 gh 通道的裸导出：直连优先、网络失败自动降级 `gh api`。 */
export async function ghApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await gh<T>(method, path, body)).json
}

/** 从 origin 远程 URL 解析 GitHub 仓库（owner/repo）。支持 https、ssh、git@。 */
export function repoFromUrl(url: string): { owner: string; repo: string } | null {
  let m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') }
  m = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') }
  m = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') }
  return null
}

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

export async function authState(): Promise<GitHubAuthState> {
  const auth = await resolveToken()
  if (!auth) return { connected: false, source: 'none' }
  try {
    const { json, scopes } = await gh<{ login: string }>('GET', '/user')
    return { connected: true, login: json.login, scopes, source: auth.source }
  } catch (error) {
    // 令牌在握，但要区分「GitHub 拒绝」与「网络不通」——后者不应把用户
    // 打回登录页形成死循环。
    if (error instanceof GitHubApiError && error.status !== undefined) {
      return { connected: false, source: 'none', hasToken: true, invalidToken: true }
    }
    return { connected: false, source: 'none', hasToken: true, reachabilityError: String(error instanceof Error ? error.message : error) }
  }
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

interface RawPR {
  number: number
  title: string
  state: string
  draft: boolean
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string }
  user: { login: string }
  created_at: string
  updated_at: string
  additions?: number
  deletions?: number
  mergeable?: boolean | null
  mergeable_state?: string
  body?: string | null
  merge_commit_sha?: string | null
}

function prSummary(raw: RawPR): PullRequestSummary {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state === 'closed' && raw.merge_commit_sha ? 'merged' : (raw.state as 'open' | 'closed' | 'merged'),
    draft: raw.draft,
    head: raw.head.ref,
    base: raw.base.ref,
    user: raw.user.login,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    additions: raw.additions,
    deletions: raw.deletions,
    mergeable: raw.mergeable,
  }
}

export async function listPRs(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', scope: 'mine' | 'all' = 'all', limit = 30): Promise<PullRequestSummary[]> {
  const { json } = await gh<RawPR[]>(`GET`, `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${limit}&sort=updated&direction=desc`)
  return json.map(prSummary)
}

export async function findPRForBranch(owner: string, repo: string, branch: string): Promise<PullRequestSummary | null> {
  const { json } = await gh<RawPR[]>(`GET`, `/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`)
  return json.length > 0 ? prSummary(json[0]) : null
}

/** 为 commit graph 构建 sha→PR 映射（合并 PR 用 merge_commit_sha，开放 PR 用 head.sha）。 */
export async function prMapByCommit(owner: string, repo: string, limit = 60): Promise<Record<string, PullRequestSummary>> {
  const map: Record<string, PullRequestSummary> = {}
  const { json } = await gh<RawPR[]>(`GET`, `/repos/${owner}/${repo}/pulls?state=all&per_page=${limit}&sort=updated&direction=desc`)
  for (const raw of json) {
    const summary = prSummary(raw)
    if (raw.merge_commit_sha) map[raw.merge_commit_sha] = summary
    if (raw.head.sha) map[raw.head.sha] = summary
  }
  return map
}

export interface CreatePROptions {
  title: string
  body?: string
  head: string
  base: string
  draft?: boolean
}

export async function createPR(owner: string, repo: string, opts: CreatePROptions): Promise<PullRequestSummary> {
  const { json } = await gh<RawPR>('POST', `/repos/${owner}/${repo}/pulls`, {
    title: opts.title,
    head: opts.head,
    base: opts.base,
    ...opts.body !== undefined && opts.body !== '' ? { body: opts.body } : {},
    ...opts.draft === true ? { draft: true } : {},
  })
  return prSummary(json)
}

export async function mergePR(owner: string, repo: string, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
  await gh('PUT', `/repos/${owner}/${repo}/pulls/${number}/merge`, { merge_method: method })
}

export async function commentPR(owner: string, repo: string, number: number, body: string): Promise<void> {
  await gh('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body })
}

export async function reviewPR(owner: string, repo: string, number: number, state: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body?: string): Promise<void> {
  await gh('POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    event: state,
    ...body !== undefined && body !== '' ? { body } : {},
  })
}

export async function getPRDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail> {
  const pr = await gh<RawPR>('GET', `/repos/${owner}/${repo}/pulls/${number}`)
  const [filesJson, reviewsJson, commentsJson, checksJson] = await Promise.all([
    gh<Array<{ filename: string; status: string; additions: number; deletions: number }>>('GET', `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`).catch(() => ({ json: [], scopes: [] })),
    gh<Array<{ user: { login: string }; state: string; submitted_at?: string; body?: string }>>('GET', `/repos/${owner}/${repo}/pulls/${number}/reviews`).catch(() => ({ json: [], scopes: [] })),
    gh<Array<{ id: number; user: { login: string }; path: string; line?: number | null; body: string; created_at: string }>>('GET', `/repos/${owner}/${repo}/pulls/${number}/comments`).catch(() => ({ json: [], scopes: [] })),
    gh<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(`GET`, `/repos/${owner}/${repo}/commits/${pr.json.head.sha}/check-runs`).catch(() => ({ json: { check_runs: [] }, scopes: [] })),
  ])

  const summary = prSummary(pr.json)
  const checkRuns: CheckRun[] = checksJson.json.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion }))
  const passing = checkRuns.filter((c) => c.conclusion === 'success').length
  const failing = checkRuns.filter((c) => c.conclusion === 'failure' || c.conclusion === 'cancelled' || c.conclusion === 'timed_out').length
  const pending = checkRuns.filter((c) => c.status === 'queued' || c.status === 'in_progress' || c.conclusion === null).length

  return {
    ...summary,
    body: pr.json.body ?? undefined,
    mergeableState: pr.json.mergeable_state,
    files: filesJson.json,
    reviews: reviewsJson.json.map((r) => ({ user: r.user.login, state: r.state, submittedAt: r.submitted_at, body: r.body })),
    comments: commentsJson.json.map((c): ReviewComment => ({ id: c.id, user: c.user.login, path: c.path, line: c.line ?? null, body: c.body, createdAt: c.created_at })),
    checkRuns,
    checks: { total: checkRuns.length, passing, failing, pending },
  }
}

// ---------------------------------------------------------------------------
// Issues (v1.5 — minimal list/create here for the agent tools)
// ---------------------------------------------------------------------------

export async function listIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', limit = 30): Promise<IssueSummary[]> {
  const { json } = await gh<Array<{
    number: number; title: string; state: string; user: { login: string }; created_at: string; labels: Array<{ name: string }>; comments: number
  }>>('GET', `/repos/${owner}/${repo}/issues?state=${state}&per_page=${limit}&sort=updated&direction=desc`)
  return json.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state as 'open' | 'closed',
    user: i.user.login,
    createdAt: i.created_at,
    labels: i.labels.map((l) => l.name),
    comments: i.comments,
  }))
}

export async function createIssue(owner: string, repo: string, title: string, body?: string): Promise<IssueSummary> {
  const { json } = await gh<{ number: number; title: string; state: string; user: { login: string }; created_at: string; labels: Array<{ name: string }>; comments: number }>(
    'POST', `/repos/${owner}/${repo}/issues`, { title, ...body !== undefined && body !== '' ? { body } : {} },
  )
  return {
    number: json.number,
    title: json.title,
    state: json.state as 'open' | 'closed',
    user: json.user.login,
    createdAt: json.created_at,
    labels: json.labels.map((l) => l.name),
    comments: json.comments,
  }
}

export async function commentIssue(owner: string, repo: string, number: number, body: string): Promise<void> {
  await gh('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body })
}

/** Issue 详情（正文 + 评论），供 agent issue 读取工具与面板使用。 */
export async function getIssueDetail(owner: string, repo: string, number: number): Promise<{
  number: number
  title: string
  state: 'open' | 'closed'
  user: string
  createdAt: string
  updatedAt?: string
  labels: string[]
  body?: string
  comments: Array<{ id: number; user: string; body: string; createdAt: string }>
}> {
  const issue = await gh<{
    number: number; title: string; state: string; user: { login: string }; created_at: string; updated_at: string;
    labels: Array<{ name: string }>; body?: string | null
  }>('GET', `/repos/${owner}/${repo}/issues/${number}`)
  const comments = await gh<Array<{ id: number; user: { login: string }; body: string; created_at: string }>>(
    'GET', `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
  ).catch(() => ({ json: [], scopes: [] }))
  return {
    number: issue.json.number,
    title: issue.json.title,
    state: issue.json.state as 'open' | 'closed',
    user: issue.json.user.login,
    createdAt: issue.json.created_at,
    updatedAt: issue.json.updated_at,
    labels: issue.json.labels.map((l) => l.name),
    body: issue.json.body ?? undefined,
    comments: comments.json.map((c) => ({ id: c.id, user: c.user.login, body: c.body, createdAt: c.created_at })),
  }
}
