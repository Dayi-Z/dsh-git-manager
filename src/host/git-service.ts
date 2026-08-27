/**
 * gitcompass — host git service: workspace-bounded git operations through the
 * managed subprocess seam. Adapted from dsh-git-panel's proven implementation,
 * extended with upstream-aware push (`git push -u`) and branch creation.
 * @module gitcompass/host/git-service
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { BranchesView, BranchRow, GitError, GraphCommit, GraphTips, GraphView, OpResult } from '../core/types.ts'

export interface GitRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** git 经过的 spawn 接缝（生产环境中即子进程服务）。 */
export interface GitRunner {
  run(argv: readonly string[], cwd: string): Promise<GitRunResult>
}

const OUTPUT_CAP_BYTES = 1 << 20

export type WorkspaceVerdict = { ok: true; canonical: string } | { ok: false; error: GitError }
export type WorkspaceGate = (path: string) => Promise<WorkspaceVerdict>

/** 基于 `ctx.subprocess` 的生产运行器。 */
export function subprocessRunner(ctx: Context): GitRunner {
  return {
    async run(argv, cwd) {
      const spec: SubprocessSpawnSpec = {
        argv: ['git', ...argv],
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_CAP_BYTES }, stderr: { maxBytes: OUTPUT_CAP_BYTES } },
        graceMs: 30_000,
      }
      const handle = ctx.subprocess.spawn(spec)
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return { exitCode: outcome.exitCode, stdout, stderr }
    },
  }
}

const REC = '\u001e'
const FIELD = '\u001f'

function sanitize(text: string): string {
  return text.replace(/[\u0000-\u001d\u007f]/g, ' ')
}

function splitRecords(text: string): string[] {
  return text
    .split(REC)
    .map((record) => (record.startsWith('\n') ? record.slice(1) : record))
    .filter((record) => record !== '')
}

export class GitService {
  constructor(
    private readonly runner: GitRunner,
    private readonly gate: WorkspaceGate,
  ) {}

  private async requireWorkspace(path: string): Promise<string> {
    const verdict = await this.gate(path)
    if (!verdict.ok) throw Object.assign(new Error(verdict.error.message), { gitError: verdict.error })
    return verdict.canonical
  }

  private async repoName(canonical: string): Promise<string> {
    const run = await this.runner.run(['rev-parse', '--show-toplevel'], canonical)
    if (run.exitCode !== 0) return canonical.split(/[\\/]/).pop() ?? canonical
    return run.stdout.trim().split(/[\\/]/).pop() ?? canonical
  }

  /** 轻量当前仓库+分支探测（用于流程条）。 */
  async current(path: string): Promise<{ repo: string; current: string }> {
    const canonical = await this.requireWorkspace(path)
    const [repo, current] = await Promise.all([this.repoName(canonical), this.currentBranch(canonical)])
    return { repo, current }
  }

  async currentBranch(canonical: string): Promise<string> {
    const run = await this.runner.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], canonical)
    return run.exitCode === 0 ? run.stdout.trim() : ''
  }

  /** origin 远程 URL，解析 GitHub 仓库时使用。 */
  async originUrl(path: string): Promise<string> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['remote', 'get-url', 'origin'], canonical)
    return run.exitCode === 0 ? run.stdout.trim() : ''
  }

  /** 上游分支（如 origin/main），未设置时为空。 */
  async upstream(path: string): Promise<string> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], canonical)
    return run.exitCode === 0 ? run.stdout.trim() : ''
  }

  /** 当前分支相对上游的 ahead/behind 计数。 */
  async aheadBehind(path: string): Promise<{ ahead: number; behind: number }> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], canonical)
    if (run.exitCode !== 0) return { ahead: 0, behind: 0 }
    const [a, b] = run.stdout.trim().split(/\s+/).map(Number)
    return { ahead: Number.isFinite(a) ? a : 0, behind: Number.isFinite(b) ? b : 0 }
  }

  /** 是否有未提交变更（供流程管线判断当前阶段）。 */
  async isDirty(path: string): Promise<boolean> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['status', '--porcelain'], canonical)
    return run.exitCode === 0 && run.stdout.trim() !== ''
  }

  async branches(path: string): Promise<BranchesView> {
    const canonical = await this.requireWorkspace(path)
    const [repo, current] = await Promise.all([this.repoName(canonical), this.currentBranch(canonical)])

    const run = await this.runner.run(
      ['for-each-ref', '--format=' + `%(refname)${FIELD}%(objectname:short)${FIELD}%(committerdate:iso8601)${FIELD}%(subject)${FIELD}%(upstream:short)${REC}`, 'refs/heads', 'refs/remotes'],
      canonical,
    )
    if (run.exitCode !== 0) {
      throw Object.assign(new Error(run.stderr.trim() || 'not a git repository'), {
        gitError: { code: 'not-a-repo', message: run.stderr.trim() || 'not a git repository' },
      })
    }
    const local: BranchRow[] = []
    const remote: BranchRow[] = []
    const withUpstream: Array<[BranchRow, string]> = []

    for (const record of splitRecords(run.stdout)) {
      const [ref, sha, date, subject, upstream] = record.split(FIELD)
      if (!ref || !sha) continue
      const isRemote = ref.startsWith('refs/remotes/')
      const name = isRemote ? ref.slice('refs/remotes/'.length) : ref.slice('refs/heads/'.length)
      const row: BranchRow = {
        name: sanitize(name),
        sha: sanitize(sha),
        date: sanitize(date),
        subject: sanitize(subject ?? '').slice(0, 80),
        current: !isRemote && name === current,
      }
      if (isRemote) remote.push(row)
      else {
        local.push(row)
        if (upstream) withUpstream.push([row, upstream])
      }
    }

    await Promise.all(withUpstream.map(async ([row, upstream]) => {
      const count = await this.runner.run(['rev-list', '--left-right', '--count', `${row.name}...${upstream}`], canonical)
      if (count.exitCode !== 0) return
      const [a, b] = count.stdout.trim().split(/\s+/).map(Number)
      row.ahead = Number.isFinite(a) ? a : 0
      row.behind = Number.isFinite(b) ? b : 0
    }))

    const sortRows = (rows: BranchRow[]): BranchRow[] => {
      rows.sort((x, y) => (x.name === current ? -1 : y.name === current ? 1 : x.name.localeCompare(y.name)))
      return rows
    }

    return { repo, current, local: sortRows(local), remote: sortRows(remote) }
  }

  async switchBranch(path: string, branch: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const argv: string[] = branch.startsWith('origin/')
      ? ['switch', '-c', branch.slice('origin/'.length), '--track', branch]
      : ['switch', branch]
    const run = await this.runner.run(argv, canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'switch-failed', message: run.stderr.trim() || `git switch ${branch} failed` } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 从当前 HEAD 创建并切换新分支（git switch -c）。 */
  async createBranch(path: string, branch: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['switch', '-c', branch.trim()], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'create-failed', message: run.stderr.trim() || `git switch -c ${branch} failed` } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async pull(path: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['pull'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'pull-failed', message: run.stderr.trim() || 'git pull failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async fetchAll(path: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['fetch', '--all', '--prune'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'fetch-failed', message: run.stderr.trim() || 'git fetch failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async deleteBranch(path: string, branch: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['branch', '-D', branch], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'delete-failed', message: run.stderr.trim() || 'git branch -D failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 推送当前分支；无上游时用 `git push -u origin <branch>` 建立上游。 */
  async push(path: string, remote?: string, branch?: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['push'], canonical)
    if (run.exitCode !== 0) {
      // 无上游：用 push -u 建立跟踪关系（用户显式选择的操作）。
      if (remote && branch) {
        const setUpstream = await this.runner.run(['push', '-u', remote, branch], canonical)
        if (setUpstream.exitCode === 0) return { ok: true, output: setUpstream.stdout.trim() || 'pushed with upstream set' }
      }
      return { ok: false, output: run.stdout, error: { code: 'push-failed', message: run.stderr.trim() || 'git push failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async commit(path: string, message: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const clean = message.trim()
    if (clean === '') return { ok: false, output: '', error: { code: 'empty-message', message: 'commit message 不能为空' } }
    const run = await this.runner.run(['commit', '-m', clean], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'commit-failed', message: run.stderr.trim() || 'git commit failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async stageAll(path: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['add', '-A'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'add-failed', message: run.stderr.trim() || 'git add -A failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async stageFile(path: string, file: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const clean = file.trim()
    if (clean === '' || clean.startsWith('/') || clean === '..' || clean.includes('/../')) {
      return { ok: false, output: '', error: { code: 'invalid-file', message: 'invalid file path' } }
    }
    const run = await this.runner.run(['add', '--', clean], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'add-failed', message: run.stderr.trim() || 'git add failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async unstageFile(path: string, file: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const clean = file.trim()
    if (clean === '' || clean.startsWith('/') || clean === '..' || clean.includes('/../')) {
      return { ok: false, output: '', error: { code: 'invalid-file', message: 'invalid file path' } }
    }
    const run = await this.runner.run(['reset', 'HEAD', '--', clean], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'reset-failed', message: run.stderr.trim() || 'git reset failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async status(path: string): Promise<{ ok: boolean; output: string; error?: GitError }> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['status', '--porcelain'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: '', error: { code: 'status-failed', message: run.stderr.trim() || 'git status failed' } }
    }
    const lines = run.stdout.split('\n').filter((l) => l.trim() !== '')
    return { ok: true, output: lines.map((l) => l.replace(/^(\S+)\s+(.+)$/, '$1  $2')).join('\n') }
  }

  async diffFile(path: string, file: string): Promise<{ ok: boolean; output: string; error?: GitError }> {
    const canonical = await this.requireWorkspace(path)
    const name = file.trim()
    if (name === '' || name.startsWith('/') || name === '..' || name.includes('/../')) {
      return { ok: false, output: '', error: { code: 'invalid-file', message: 'invalid file path' } }
    }
    const run = await this.runner.run(['diff', 'HEAD', '--', name], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: '', error: { code: 'diff-failed', message: run.stderr.trim() || 'git diff failed' } }
    }
    return { ok: true, output: run.stdout }
  }

  async graph(path: string): Promise<GraphView> {
    const canonical = await this.requireWorkspace(path)
    const [repo, current, logRun, tipRun] = await Promise.all([
      this.repoName(canonical),
      this.currentBranch(canonical),
      this.runner.run(
        ['log', '--all', '--date-order', '--max-count=300',
          '--pretty=format:' + `%H${FIELD}%P${FIELD}%an${FIELD}%ai${FIELD}%s${REC}`],
        canonical,
      ),
      this.runner.run(
        ['for-each-ref', '--format=' + `%(refname:short)${FIELD}%(objectname)${REC}`, 'refs/heads', 'refs/remotes'],
        canonical,
      ),
    ])

    const commits: GraphCommit[] = []
    const seen = new Set<string>()
    if (logRun.exitCode !== 0) {
      throw Object.assign(new Error(logRun.stderr.trim() || 'not a git repository'), {
        gitError: { code: 'not-a-repo', message: logRun.stderr.trim() || 'not a git repository' },
      })
    }
    for (const record of splitRecords(logRun.stdout)) {
      const [sha, parents, author, date, subject] = record.split(FIELD)
      if (!sha || seen.has(sha)) continue
      seen.add(sha)
      commits.push({ sha, parents: parents ? parents.split(' ') : [], author: sanitize(author ?? ''), date: sanitize(date ?? ''), subject: sanitize(subject ?? '').slice(0, 100) })
    }

    const tips: GraphTips = {}
    for (const record of splitRecords(tipRun.stdout)) {
      const [name, sha] = record.split(FIELD)
      if (name && sha) tips[name] = sha
    }

    return { repo, current, commits, tips }
  }
}
