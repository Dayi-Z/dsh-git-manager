/**
 * gitcompass — host git service: workspace-bounded git operations through the
 * managed subprocess seam. Adapted from dsh-git-panel's proven implementation,
 * extended with upstream-aware push (`git push -u`) and branch creation.
 * @module gitcompass/host/git-service
 */

import { realpath, readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
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

/** 文件级审批行的载荷（additions/deletions 为 null 表示二进制或未跟踪）。 */
export interface FileReviewRow {
  path: string
  additions: number | null
  deletions: number | null
  binary?: boolean
  truncated?: boolean
  diff: string
}

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
      row.upstream = upstream
      if (count.exitCode !== 0) return
      const [a, b] = count.stdout.trim().split(/\s+/).map(Number)
      row.ahead = Number.isFinite(a) ? a : 0
      row.behind = Number.isFinite(b) ? b : 0
    }))

    const sortRows = (rows: BranchRow[]): BranchRow[] => {
      const rank = (r: BranchRow): number => (r.name === current ? 0 : /^(main|master|trunk)$/.test(r.name) ? 1 : 2)
      rows.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name))
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

  /** 重命名本地分支（git branch -m <from> <to>）。 */
  async renameBranch(path: string, from: string, to: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const cleanFrom = from.trim()
    const cleanTo = to.trim()
    if (cleanFrom === '' || cleanTo === '') {
      return { ok: false, output: '', error: { code: 'bad-name', message: '分支名不能为空' } }
    }
    const run = await this.runner.run(['branch', '-m', cleanFrom, cleanTo], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'rename-failed', message: run.stderr.trim() || 'git branch -m failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 删除远程分支（git push <remote> --delete <branch>）。 */
  async deleteRemoteBranch(path: string, branch: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const slash = branch.indexOf('/')
    if (slash <= 0 || slash === branch.length - 1) {
      return { ok: false, output: '', error: { code: 'bad-branch', message: `invalid remote branch: ${branch}` } }
    }
    const remote = branch.slice(0, slash)
    const name = branch.slice(slash + 1)
    const run = await this.runner.run(['push', remote, '--delete', name], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'delete-remote-failed', message: run.stderr.trim() || 'git push --delete failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 将某分支合并到当前分支（git merge --no-edit <branch>）。 */
  async mergeBranch(path: string, branch: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['merge', '--no-edit', branch], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'merge-failed', message: run.stderr.trim() || 'git merge failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** stash 列表（git stash list）。 */
  async stashList(path: string): Promise<{ ok: boolean; output: string; error?: GitError }> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['stash', 'list'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: '', error: { code: 'stash-list-failed', message: run.stderr.trim() || 'git stash list failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 暂存当前变更（git stash push -m [message]）。 */
  async stashPush(path: string, message?: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const argv = message !== undefined && message.trim() !== ''
      ? ['stash', 'push', '-m', message.trim()]
      : ['stash', 'push']
    const run = await this.runner.run(argv, canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'stash-failed', message: run.stderr.trim() || 'git stash push failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 弹出最新 stash（git stash pop）。 */
  async stashPop(path: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['stash', 'pop'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'stash-pop-failed', message: run.stderr.trim() || 'git stash pop failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** cherry-pick 一个提交到当前分支（git cherry-pick <sha>）。 */
  async cherryPick(path: string, sha: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const clean = sha.trim()
    if (clean === '') return { ok: false, output: '', error: { code: 'empty-sha', message: 'sha 不能为空' } }
    const run = await this.runner.run(['cherry-pick', clean], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'cherry-pick-failed', message: run.stderr.trim() || 'git cherry-pick failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 撤销一个提交（git revert --no-edit <sha>）。 */
  async revertCommit(path: string, sha: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const clean = sha.trim()
    if (clean === '') return { ok: false, output: '', error: { code: 'empty-sha', message: 'sha 不能为空' } }
    const run = await this.runner.run(['revert', '--no-edit', clean], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'revert-failed', message: run.stderr.trim() || 'git revert failed' } }
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
    // 重命名条目形如 "old -> new"：展开为多个 pathspec。
    const parts = file.trim().includes(' -> ') ? file.trim().split(' -> ').map((s) => s.trim()) : [file.trim()]
    if (parts.some((p) => p === '' || p.startsWith('/') || p === '..' || p.includes('/../'))) {
      return { ok: false, output: '', error: { code: 'invalid-file', message: 'invalid file path' } }
    }
    const run = await this.runner.run(['add', '--', ...parts], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'add-failed', message: run.stderr.trim() || 'git add failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  async unstageFile(path: string, file: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const parts = file.trim().includes(' -> ') ? file.trim().split(' -> ').map((s) => s.trim()) : [file.trim()]
    if (parts.some((p) => p === '' || p.startsWith('/') || p === '..' || p.includes('/../'))) {
      return { ok: false, output: '', error: { code: 'invalid-file', message: 'invalid file path' } }
    }
    const run = await this.runner.run(['reset', 'HEAD', '--', ...parts], canonical)
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

  /** 上游存在但未推送的提交（@{u}..HEAD）；无上游或无提交时为空数组。 */
  async outgoing(path: string): Promise<{ commits: Array<{ sha: string; subject: string }> }> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['log', '@{u}..HEAD', '--format=%h%x1f%s'], canonical)
    if (run.exitCode !== 0) return { commits: [] }
    const commits = run.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => {
      const i = l.indexOf(REC)
      return i === -1 ? { sha: l.trim(), subject: '' } : { sha: l.slice(0, i).trim(), subject: l.slice(i + 1).trim() }
    })
    return { commits }
  }

  /** 丢弃一个文件的本地更改：已跟踪 → checkout --；未跟踪 → clean -f --。 */
  async discardFile(path: string, file: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const parts = file.trim().includes(' -> ') ? file.trim().split(' -> ').map((s) => s.trim()) : [file.trim()]
    if (parts.some((p) => p === '' || p.startsWith('/') || p === '..' || p.includes('/../'))) {
      return { ok: false, output: '', error: { code: 'invalid-file', message: 'invalid file path' } }
    }
    const st = await this.runner.run(['status', '--porcelain', '--', ...parts], canonical)
    const untracked = st.stdout.startsWith('??')
    const argv = untracked ? ['clean', '-f', '--', ...parts] : ['checkout', '--', ...parts]
    const run = await this.runner.run(argv, canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'discard-failed', message: run.stderr.trim() || 'git discard failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 某个提交的变更文件清单（numstat；二进制文件增删为 null）。 */
  async commitFiles(path: string, sha: string): Promise<{ files: Array<{ path: string; additions: number | null; deletions: number | null }> }> {
    const canonical = await this.requireWorkspace(path)
    const ref = sha.trim()
    if (!/^[0-9a-fA-F]{4,40}$/.test(ref)) throw { code: 'invalid-sha', message: 'invalid commit sha' } as GitError
    const run = await this.runner.run(['diff-tree', '--no-commit-id', '--numstat', '-r', '--root', ref], canonical)
    if (run.exitCode !== 0) throw { code: 'commit-files-failed', message: run.stderr.trim() || 'git diff-tree failed' } as GitError
    const files = run.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => {
      const [a, d, ...rest] = l.split('\t')
      return { path: rest.join('\t'), additions: a === '-' ? null : Number(a), deletions: d === '-' ? null : Number(d) }
    }).filter((f) => f.path !== '')
    return { files }
  }

  /** 某个提交中单个文件的补丁文本。 */
  async commitPatch(path: string, sha: string, file: string): Promise<{ patch: string }> {
    const canonical = await this.requireWorkspace(path)
    const ref = sha.trim()
    const name = file.trim()
    if (!/^[0-9a-fA-F]{4,40}$/.test(ref) || name === '' || name.startsWith('/') || name === '..' || name.includes('/../')) {
      throw { code: 'invalid-args', message: 'invalid commit patch args' } as GitError
    }
    const run = await this.runner.run(['diff-tree', '--no-commit-id', '-r', '--root', '-p', ref, '--', name], canonical)
    if (run.exitCode !== 0) throw { code: 'commit-patch-failed', message: run.stderr.trim() || 'git diff-tree failed' } as GitError
    return { patch: run.stdout }
  }

  /**
   * 待提交变更的评审快照：每个文件的 +增/-删行数、二进制标记与
   * 截断封顶的 unified diff，供面板文件级审批卡渲染。
   */
  async reviewSnapshot(path: string, opts?: { diffCapBytes?: number }): Promise<{ ok: boolean; files?: FileReviewRow[]; error?: GitError }> {
    const canonical = await this.requireWorkspace(path)
    const cap = opts?.diffCapBytes ?? 12_000 // per-file unified diff cap

    const numstat = await this.runner.run(['diff', 'HEAD', '--numstat'], canonical)
    if (numstat.exitCode !== 0) {
      return { ok: false, error: { code: 'diff-failed', message: numstat.stderr.trim() || 'git diff failed' } }
    }

    type Entry = { path: string; additions: number | null; deletions: number | null }
    const entries = new Map<string, Entry>()
    for (const line of numstat.stdout.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      const [, a, d, p] = m
      const file = p.replace(/^"|"$/g, '')
      entries.set(file, {
        path: file,
        additions: a === '-' ? null : Number(a),
        deletions: d === '-' ? null : Number(d),
      })
    }

    // Untracked files: staged-only view would miss them; list with null counts.
    const untrackedRun = await this.runner.run(['ls-files', '--others', '--exclude-standard'], canonical)
    if (untrackedRun.exitCode === 0) {
      for (const line of untrackedRun.stdout.split('\n')) {
        const file = line.trim()
        if (file !== '' && !entries.has(file)) entries.set(file, { path: file, additions: null, deletions: null })
      }
    }

    const rows: FileReviewRow[] = []
    let totalBytes = 0
    const TOTAL_CAP = 128_000

    for (const entry of entries.values()) {
      const row: FileReviewRow = { ...entry, truncated: false, diff: '' }
      if (totalBytes < TOTAL_CAP) {
        const binary = entry.additions === null || entry.deletions === null
        if (binary) {
          row.binary = true
          row.diff = ''
        } else {
          const run = await this.runner.run(['diff', 'HEAD', '--', entry.path], canonical)
          let text = run.exitCode === 0 ? run.stdout : ''
          const budget = Math.min(cap, TOTAL_CAP - totalBytes)
          if (text.length > budget) {
            text = text.slice(0, budget)
            row.truncated = true
          }
          totalBytes += text.length
          row.diff = text
        }
      } else {
        row.truncated = true
        row.diff = ''
      }
      rows.push(row)
    }

    // Deterministic order: modified first, then additions, alphabetical.
    rows.sort((a, b) => a.path.localeCompare(b.path))
    return { ok: true, files: rows }
  }

  /**
   * 全文件对照载荷：左 = HEAD 版本全文，右 = 工作区版本全文，
   * 并按 -U0 diff 的 hunk 头推算出两侧需要高亮的行号集合。
   */
  async reviewFile(path: string, file: string): Promise<{ ok: boolean; value?: {
    path: string; binary: boolean
    before: { exists: boolean; text: string }
    after: { exists: boolean; text: string }
    delLines: number[]; addLines: number[]
    truncated: boolean
  }; error?: GitError }> {
    const canonical = await this.requireWorkspace(path)
    const name = file.trim()
    if (name === '' || name.startsWith('/') || name === '..' || name.includes('/../')) {
      return { ok: false, error: { code: 'invalid-file', message: 'invalid file path' } }
    }
    const CAP = 200_000

    const [showRun] = await Promise.all([
      this.runner.run(['show', `HEAD:${name}`], canonical),
      Promise.resolve(null),
    ])
    let afterText = ''
    try {
      afterText = await readFile(join(canonical, name), 'utf8')
    } catch { /* new file — empty */ }

    const binaryReplacer = (s: string): boolean => s.includes('\u0000')
    if (binaryReplacer(showRun.stdout) || binaryReplacer(afterText)) {
      return { ok: true, value: { path: name, binary: true, before: { exists: showRun.exitCode === 0, text: '' }, after: { exists: true, text: '' }, delLines: [], addLines: [], truncated: false } }
    }

    const beforeRaw = showRun.exitCode === 0 ? showRun.stdout : ''
    const truncated = beforeRaw.length > CAP || afterText.length > CAP

    // 行号映射：解析 -U0 unified diff。
    const delLines: number[] = []
    const addLines: number[] = []
    const numstatRun = await this.runner.run(['diff', 'HEAD', '-U0', '--', name], canonical)
    if (numstatRun.exitCode === 0) {
      let o = 0; let n = 0
      for (const raw of numstatRun.stdout.split('\n')) {
        const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
        if (m) { o = Number(m[1]); n = Number(m[3]); continue }
        if (raw.startsWith('-')) { delLines.push(o); o += 1 }
        else if (raw.startsWith('+')) { addLines.push(n); n += 1 }
        else if (raw.startsWith(' ') || raw === '') { o += 1; n += 1 }
      }
    }

    return {
      ok: true,
      value: {
        path: name,
        binary: false,
        before: { exists: showRun.exitCode === 0, text: beforeRaw.slice(0, CAP) },
        after: { exists: true, text: afterText.slice(0, CAP) },
        delLines, addLines,
        truncated,
      },
    }
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

// ---------------------------------------------------------------------------
// Monorepo 子目录的 origin 回溯：
// 工作区自身是独立 .git（常无 remote）但父目录是 GitHub monorepo 时，
// 沿父链读最近的仓库配置拿 origin。纯文件读取，不经过 runner 门禁。
// ---------------------------------------------------------------------------

function originFromConfigText(cfg: string): string | null {
  const sec = /\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/i.exec(cfg)
  if (!sec) return null
  const u = /^\s*url\s*=\s*(.+)$/mi.exec(sec[1])
  return u ? u[1].trim() : null
}

async function readRepoOrigin(dir: string): Promise<string | null> {
  const dotGit = join(dir, '.git')
  let configPath: string | null = null
  try {
    const st = statSync(dotGit)
    configPath = st.isDirectory() ? join(dotGit, 'config') : null
    // worktree：.git 是文件，内容为 `gitdir: <path>`。
    if (st.isFile()) {
      const gitfile = await readFile(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(gitfile)
      if (m) configPath = join(m[1].trim(), 'config')
    }
  } catch { return null }
  if (!configPath || !existsSync(configPath)) return null
  try {
    return originFromConfigText(await readFile(configPath, 'utf8'))
  } catch { return null }
}

/** 沿目录向上找最近一个配置了 origin 的 git 仓库；找不到返回 null。 */
export async function ancestorOriginUrl(canonical: string): Promise<{ url: string; dir: string } | null> {
  let dir = canonical
  for (;;) {
    const found = await readRepoOrigin(dir)
    if (found) return { url: found, dir }
    const parent = dirname(dir)
    if (parent === dir || parent.length <= 3) break // 到达盘符根
    dir = parent
  }
  return null
}
