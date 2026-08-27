/**
 * gitcompass — GitHub REST wrapper (host side, token never leaves the host).
 * Uses the global fetch against api.github.com with the resolved token.
 * @module gitcompass/host/github-service
 */

import type { CheckRun, GitHubAuthState, IssueSummary, PullRequestDetail, PullRequestSummary, ReviewComment } from '../core/types.ts'
import { resolveToken } from './github-auth.ts'

export class GitHubApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

interface GhResult<T> {
  json: T
  scopes: string[]
}

async function gh<T>(method: string, path: string, body?: unknown): Promise<GhResult<T>> {
  const auth = await resolveToken()
  if (!auth) throw new GitHubApiError('not connected to GitHub — connect in the panel first')
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${auth.token}`,
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
  } catch {
    return { connected: false, source: 'none' }
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
