/**
 * gitcompass — client API: typed fetch wrapper over the /gitu/* host routes.
 * @module gitcompass/client/api
 */

type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const envelope = (await res.json()) as Envelope<T>
  if (!envelope.ok) throw new Error(envelope.error.message)
  return envelope.value
}

export interface WorkspaceEntry { path: string; title: string }
export interface BranchesView {
  repo: string
  current: string
  local: Array<{ name: string; sha: string; date: string; subject: string; current: boolean; ahead?: number; behind?: number }>
  remote: Array<{ name: string; sha: string; date: string; subject: string; current: boolean }>
}
export interface GraphCommit { sha: string; parents: string[]; author: string; date: string; subject: string; prNumber?: number | null }
export interface GraphView { repo: string; current: string; commits: GraphCommit[]; tips: Record<string, string> }
export interface FlowSnapshot {
  repo: string
  current: string
  ahead: number
  behind: number
  hasRemote: boolean
  upstreamSet: boolean
  prNumber: number | null
  dirty: boolean
  steps: Array<{ id: string; phase: 0 | 1 | 2 }>
}
export interface GitHubAuthState {
  connected: boolean
  login?: string
  scopes?: string[]
  source: 'stored' | 'gh' | 'none'
  ghAvailable?: boolean
}
export interface DeviceInfo { userCode: string; verificationUri: string; interval: number; deviceCode: string }
export interface PullRequestSummary {
  number: number
  title: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  head: string
  base: string
  user: string
  createdAt: string
  updatedAt: string
  checks?: { total: number; passing: number; failing: number; pending: number }
}
export interface PullRequestDetail extends PullRequestSummary {
  body?: string
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>
  reviews: Array<{ user: string; state: string; submittedAt?: string; body?: string }>
  comments: Array<{ id: number; user: string; path: string; line?: number | null; body: string; createdAt: string }>
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>
}
export interface RepoInfo { owner: string; repo: string; branch: string; prNumber: number | null; connected: boolean; login?: string }
export interface OpResult { ok: boolean; output: string; error?: { code: string; message: string } }

export class GitcompassApi {
  workspaces(): Promise<WorkspaceEntry[]> { return call('/gitu/workspaces') }
  branches(path: string): Promise<BranchesView> { return call('/gitu/branches', { path }) }
  graph(path: string): Promise<GraphView> { return call('/gitu/graph', { path }) }
  flow(path: string): Promise<FlowSnapshot> { return call('/gitu/flow', { path }) }
  status(path: string): Promise<OpResult> { return call('/gitu/status', { path }) }
  diff(path: string, file: string): Promise<OpResult> { return call('/gitu/diff', { path, file }) }
  commit(path: string, message: string): Promise<OpResult> { return call('/gitu/commit', { path, message }) }
  stage(path: string, file: string): Promise<OpResult> { return call('/gitu/stage', { path, file }) }
  unstage(path: string, file: string): Promise<OpResult> { return call('/gitu/unstage', { path, file }) }
  stageAll(path: string): Promise<OpResult> { return call('/gitu/stage-all', { path }) }
  push(path: string): Promise<OpResult> { return call('/gitu/push', { path }) }
  pull(path: string): Promise<OpResult> { return call('/gitu/pull', { path }) }
  fetch(path: string): Promise<OpResult> { return call('/gitu/fetch', { path }) }
  switchBranch(path: string, branch: string): Promise<OpResult> { return call('/gitu/switch', { path, branch }) }
  createBranch(path: string, branch: string): Promise<OpResult> { return call('/gitu/create-branch', { path, branch }) }

  githubAuth(): Promise<GitHubAuthState> { return call('/gitu/github/auth') }
  deviceStart(): Promise<DeviceInfo> { return call('/gitu/github/device') }
  devicePoll(deviceCode: string, interval: number): Promise<{ pending?: boolean } & GitHubAuthState> {
    return call('/gitu/github/poll', { deviceCode, interval })
  }
  tokenInput(token: string): Promise<GitHubAuthState> { return call('/gitu/github/token', { token }) }
  logout(): Promise<GitHubAuthState> { return call('/gitu/github/logout') }
  repoInfo(path: string): Promise<RepoInfo> { return call('/gitu/github/repo', { path }) }
  listPRs(owner: string, repo: string, state = 'open'): Promise<PullRequestSummary[]> { return call('/gitu/github/prs', { owner, repo, state }) }
  prDetail(owner: string, repo: string, number: number): Promise<PullRequestDetail> { return call('/gitu/github/pr', { owner, repo, number }) }
  createPR(owner: string, repo: string, opts: { title: string; body?: string; head: string; base: string; draft?: boolean }): Promise<PullRequestSummary> {
    return call('/gitu/github/pr-create', { owner, repo, ...opts })
  }
  mergePR(owner: string, repo: string, number: number, method: string): Promise<{ merged: boolean }> {
    return call('/gitu/github/pr-merge', { owner, repo, number, method })
  }
}
