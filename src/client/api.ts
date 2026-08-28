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
  local: Array<{ name: string; sha: string; date: string; subject: string; current: boolean; ahead?: number; behind?: number; upstream?: string }>
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
  /** 令牌已保存但 GitHub API 暂不可达。 */
  hasToken?: boolean
  reachabilityError?: string
  invalidToken?: boolean
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
export interface IssueSummary {
  number: number; title: string; state: 'open' | 'closed'; user: string;
  createdAt: string; labels: string[]; commentCount: number
}
export interface IssueDetail {
  number: number; title: string; state: 'open' | 'closed'; user: string;
  createdAt: string; updatedAt?: string; labels: string[];
  body?: string;
  comments: Array<{ id: number; user: string; body: string; createdAt: string }>
}

export class GitcompassApi {
  workspaces(): Promise<WorkspaceEntry[]> { return call('/gitu/workspaces') }
  /** 手动收录本地仓库（monorepo 内嵌套仓库等 DSH 未注册场景）。 */
  addRepo(path: string): Promise<WorkspaceEntry[]> { return call('/gitu/repos-add', { path }) }
  removeRepo(path: string): Promise<WorkspaceEntry[]> { return call('/gitu/repos-remove', { path }) }
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
  pull(path: string, rebase = false): Promise<OpResult> { return call('/gitu/pull', { path, rebase }) }
  fetch(path: string): Promise<OpResult> { return call('/gitu/fetch', { path }) }
  switchBranch(path: string, branch: string): Promise<OpResult> { return call('/gitu/switch', { path, branch }) }
  createBranch(path: string, branch: string): Promise<OpResult> { return call('/gitu/create-branch', { path, branch }) }
  renameBranch(path: string, branch: string, newName: string): Promise<OpResult> { return call('/gitu/rename', { path, branch, newName }) }
  deleteBranch(path: string, branch: string): Promise<OpResult> { return call('/gitu/delete', { path, branch }) }
  deleteRemoteBranch(path: string, branch: string): Promise<OpResult> { return call('/gitu/delete-remote', { path, branch }) }
  mergeBranch(path: string, branch: string): Promise<OpResult> { return call('/gitu/merge', { path, branch }) }
  stashList(path: string): Promise<OpResult> { return call('/gitu/stash-list', { path }) }
  stashPush(path: string, message?: string): Promise<OpResult> { return call('/gitu/stash-push', { path, message: message ?? '' }) }
  stashPop(path: string): Promise<OpResult> { return call('/gitu/stash-pop', { path }) }
  cherryPick(path: string, sha: string): Promise<OpResult> { return call('/gitu/cherry-pick', { path, sha }) }
  revertCommit(path: string, sha: string): Promise<OpResult> { return call('/gitu/revert', { path, sha }) }

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
  commentPR(owner: string, repo: string, number: number, body: string): Promise<{ commented: boolean }> {
    return call('/gitu/github/pr-comment', { owner, repo, number, body })
  }
  reviewPR(owner: string, repo: string, number: number, state: string, body?: string): Promise<{ reviewed: boolean }> {
    return call('/gitu/github/pr-review', { owner, repo, number, state, body: body ?? '' })
  }
  listIssues(owner: string, repo: string, state = 'open'): Promise<IssueSummary[]> {
    return call('/gitu/github/issues', { owner, repo, state })
  }
  issueDetail(owner: string, repo: string, number: number): Promise<IssueDetail> {
    return call('/gitu/github/issue', { owner, repo, number })
  }
  createIssue(owner: string, repo: string, title: string, body?: string): Promise<IssueSummary> {
    return call('/gitu/github/issue-create', { owner, repo, title, body: body ?? '' })
  }
  commentIssue(owner: string, repo: string, number: number, body: string): Promise<{ commented: boolean }> {
    return call('/gitu/github/issue-comment', { owner, repo, number, body })
  }
  /** 面板内预先批准某工具的某次调用（agent 随后请求审批时跳过弹窗）。 */
  preApprove(tool: string, callId?: string): Promise<{ preApproved: boolean }> {
    return call('/gitu/preapprove', { tool, callId: callId ?? '' })
  }
  /** 本会话当前生效的预批准清单（tool 或 tool#callId）。 */
  preApproveList(): Promise<{ tools: string[] }> {
    return call('/gitu/preapprove-list', {})
  }
  /** 撤销会话预批准（tool 省略时清空全部）。 */
  clearPreApprove(tool?: string): Promise<{ cleared: boolean; tools: string[] }> {
    return call('/gitu/preapprove-clear', { tool: tool ?? '' })
  }
  /** 对一次“正在等待”的审批请求给出实时决定（批准/拒绝）。 */
  decideApproval(callId: string, decision: 'approved' | 'rejected'): Promise<{ resolved: boolean }> {
    return call('/gitu/approval', { callId, decision })
  }
  /** 发送一张演示用文件评审卡（不触发任何真实操作）。 */
  previewFileReview(): Promise<{ emitted: boolean }> {
    return call('/gitu/preview-review', {})
  }
  /** 全文件对照：修改前(HEAD)/修改后(工作区)全文 + 增删行号集合。 */
  reviewFile(path: string, file: string): Promise<{
    path: string; binary: boolean
    before: { exists: boolean; text: string }
    after: { exists: boolean; text: string }
    delLines: number[]; addLines: number[]
    truncated: boolean
  }> {
    return call('/gitu/review-file', { path, file })
  }
  /** 传出的更改：@{u}..HEAD 未推送提交（无上游 → 空数组）。 */
  outgoing(path: string): Promise<{ commits: Array<{ sha: string; subject: string }> }> {
    return call('/gitu/outgoing', { path })
  }
  /** 丢弃单文件本地更改（未跟踪 = 删除文件）。 */
  discard(path: string, file: string): Promise<OpResult> {
    return call('/gitu/discard', { path, file })
  }
  /** 图谱下钻：单个提交的变更文件清单（二进制增删为 null）。 */
  commitFiles(path: string, sha: string): Promise<{ files: Array<{ path: string; additions: number | null; deletions: number | null }> }> {
    return call('/gitu/commit-files', { path, sha })
  }
  /** 图谱下钻：单个提交中单文件的补丁。 */
  commitPatch(path: string, sha: string, file: string): Promise<{ patch: string }> {
    return call('/gitu/commit-patch', { path, sha, file })
  }
  /** gh/API 通道推送：github.com 直连不可用时的恢复路径（逐提交在 GitHub 端重建）。 */
  apiPush(path: string): Promise<OpResult> {
    return call('/gitu/api-push', { path })
  }
  /** 拉取（rebase = 变基式拉取，带 autostash）。 */
  /** 贮藏明细操作：apply 保留栈 / drop 丢弃指定条目。 */
  stashAction(path: string, action: 'apply' | 'drop', ref: string): Promise<OpResult> {
    return call('/gitu/stash-apply', { path, action, ref })
  }
  /** 撤销最近一次提交（soft reset，改动保留在暂存区）。 */
  undoCommit(path: string): Promise<OpResult> {
    return call('/gitu/undo-commit', { path })
  }
  /** 修补最近一次提交（amend）：给新信息则改写，否则保留原信息。 */
  amend(path: string, message?: string): Promise<OpResult> {
    return call('/gitu/amend', { path, message: message ?? '' })
  }
  /** 冲突状态：未合并文件 + 合并/变基进行中标记。 */
  conflictState(path: string): Promise<{ merging: boolean; rebasing: boolean; files: Array<{ file: string; code: string }> }> {
    return call('/gitu/conflict-state', { path })
  }
  /** 解决冲突：采用我方/对方版本并暂存。 */
  resolveConflict(path: string, file: string, side: 'ours' | 'theirs'): Promise<OpResult> {
    return call('/gitu/conflict-resolve', { path, file, side })
  }
  /** 中止合并/变基。 */
  abortConflict(path: string, kind: 'merge' | 'rebase'): Promise<OpResult> {
    return call('/gitu/conflict-abort', { path, kind })
  }
  /** 变基继续。 */
  continueRebase(path: string): Promise<OpResult> {
    return call('/gitu/rebase-continue', { path })
  }
  /** 标签列表（名称 + 日期，时间倒序）。 */
  tags(path: string): Promise<Array<{ name: string; date: string }>> {
    return call('/gitu/tags', { path })
  }
  /** 建标签：给信息则注释标签。 */
  tagCreate(path: string, name: string, message?: string): Promise<OpResult> {
    return call('/gitu/tag-create', { path, name, message: message ?? '' })
  }
  tagDelete(path: string, name: string): Promise<OpResult> {
    return call('/gitu/tag-delete', { path, name })
  }
  tagPush(path: string, name: string): Promise<OpResult> {
    return call('/gitu/tag-push', { path, name })
  }
  /** 未跟踪文件一键加入 .gitignore（幂等）。 */
  gitignoreAdd(path: string, file: string): Promise<OpResult> {
    return call('/gitu/gitignore-add', { path, file })
  }
  /** 从 URL 克隆到父目录并登记书架。 */
  clone(parent: string, url: string): Promise<{ path: string }> {
    return call('/gitu/clone', { parent, url })
  }
}
