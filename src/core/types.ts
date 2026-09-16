/**
 * dsh-git-manager — shared host types.
 */

/** A git op that can fail with a structured error. */
export interface GitError {
  code: string
  message: string
}

/** Result of a git op that returns output. */
export interface OpResult {
  ok: boolean
  output: string
  error?: GitError
}

/** Workspace entry for the repo picker. */
export interface WorkspaceEntry {
  path: string
  title: string
}

/** One branch row. */
export interface BranchRow {
  name: string
  sha: string
  date: string
  subject: string
  current: boolean
  ahead?: number
  behind?: number
  /** 上游分支名（如 origin/main），未设置时为空。 */
  upstream?: string
  /** PR number open for this branch (when GitHub is connected). */
  prNumber?: number | null
}

export interface BranchesView {
  repo: string
  current: string
  local: BranchRow[]
  remote: BranchRow[]
}

/** One commit in the graph. */
export interface GraphCommit {
  sha: string
  parents: string[]
  author: string
  date: string
  subject: string
  /** PR number this commit is associated with (from GitHub). */
  prNumber?: number | null
  /** CI conclusion for the associated check run, if known. */
  check?: { name: string; conclusion: string } | null
}

/** Graph tips: ref name -> sha. */
export type GraphTips = Record<string, string>

export interface GraphView {
  repo: string
  current: string
  commits: GraphCommit[]
  tips: GraphTips
}

/** GitHub auth state exposed to the client. Never includes the token. */
export interface GitHubAuthState {
  connected: boolean
  login?: string
  scopes?: string[]
  source: 'stored' | 'gh' | 'none'
  /** 令牌已保存但 GitHub API 暂不可达（网络/代理问题）。 */
  hasToken?: boolean
  reachabilityError?: string
  /** 令牌存在但被 GitHub 拒绝（401/403），需要重新登录。 */
  invalidToken?: boolean
}

/** A GitHub pull request (summary shape). */
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
  additions?: number
  deletions?: number
  mergeable?: boolean | null
  checks?: { total: number; passing: number; failing: number; pending: number }
}

/** A GitHub issue (summary shape). */
export interface IssueSummary {
  number: number
  title: string
  state: 'open' | 'closed'
  user: string
  createdAt: string
  labels: string[]
  comments: number
}

/** A check run. */
export interface CheckRun {
  name: string
  status: string
  conclusion: string | null
}

/** Review comment thread summary. */
export interface ReviewComment {
  id: number
  user: string
  path: string
  line?: number | null
  body: string
  createdAt: string
}

/** PR detail payload. */
export interface PullRequestDetail extends PullRequestSummary {
  body?: string
  mergeableState?: string
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>
  reviews: Array<{ user: string; state: string; submittedAt?: string; body?: string }>
  comments: ReviewComment[]
  checkRuns: CheckRun[]
}

/** Stepboard step state. */
export type FlowStepId = 'branch' | 'commit' | 'push' | 'pr' | 'review' | 'merge'

export interface FlowStepState {
  id: FlowStepId
  /** 0=idle 1=active 2=done */
  phase: 0 | 1 | 2
  detail?: string
}

export interface FlowSnapshot {
  repo: string
  current: string
  ahead: number
  behind: number
  hasRemote: boolean
  upstreamSet: boolean
  prNumber: number | null
  dirty: boolean
  steps: FlowStepState[]
}
