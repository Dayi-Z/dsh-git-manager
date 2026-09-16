/**
 * dsh-git-manager — host git service: workspace-bounded git operations through the
 * managed subprocess seam. Adapted from dsh-git-panel's proven implementation,
 * extended with upstream-aware push (`git push -u`) and branch creation.
 * @module dsh-git-manager/host/git-service
 */

import { realpath, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ghApi, repoFromUrl } from './github-service.ts'
import type { BranchesView, BranchRow, GitError, GraphCommit, GraphTips, GraphView, OpResult } from '../core/types.ts'

/** 未跟踪文件合成 diff 的上限：行数与字节数各一道，防止一个大文件拖垮面板。 */
const UNTRACKED_MAX_LINES = 2000
const UNTRACKED_MAX_BYTES = 512 * 1024

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

  async pull(path: string, rebase = false): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(rebase ? ['pull', '--rebase', '--autostash'] : ['pull'], canonical)
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
      // 工作区干净时 stash 报 "No local changes"：这是预期状态，不是失败
      if (/no local changes/i.test(run.stderr + run.stdout)) {
        return { ok: true, output: '工作区干净，无需贮藏' }
      }
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

  // ---------------------------------------------------------------------------
  // P0/P1 批量补全：冲突 / 撤销 / 修补 / 贮藏明细 / 标签 / gitignore / 克隆
  // ---------------------------------------------------------------------------

  /** 冲突状态：未合并文件 + 进行中的合并/变基探测（MERGE_HEAD / REBASE_HEAD）。 */
  async conflictState(path: string): Promise<{ merging: boolean; rebasing: boolean; files: Array<{ file: string; code: string }> }> {
    const canonical = await this.requireWorkspace(path)
    const status = await this.runner.run(['status', '--porcelain'], canonical)
    const files: Array<{ file: string; code: string }> = []
    if (status.exitCode === 0) {
      for (const line of status.stdout.split('\n')) {
        if (line.length < 4) continue
        const code = line.slice(0, 2)
        const file = line.slice(3).trim()
        if (code.includes('U') || code === 'AA' || code === 'DD') files.push({ file, code })
      }
    }
    const merging = (await this.runner.run(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], canonical)).exitCode === 0
    const rebasing = (await this.runner.run(['rev-parse', '-q', '--verify', 'REBASE_HEAD'], canonical)).exitCode === 0
    return { merging, rebasing, files }
  }

  /** 解决单个冲突文件：采用我方/对方版本并暂存。 */
  async resolveConflict(path: string, file: string, side: 'ours' | 'theirs'): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const pick = await this.runner.run(['checkout', side === 'ours' ? '--ours' : '--theirs', '--', file], canonical)
    if (pick.exitCode !== 0) {
      return { ok: false, output: pick.stdout, error: { code: 'resolve-failed', message: pick.stderr.trim() || 'git checkout --ours/--theirs failed' } }
    }
    const add = await this.runner.run(['add', '--', file], canonical)
    if (add.exitCode !== 0) {
      return { ok: false, output: add.stdout, error: { code: 'resolve-failed', message: add.stderr.trim() || 'git add failed' } }
    }
    return { ok: true, output: `${file}：已采用${side === 'ours' ? '我方' : '对方'}版本并暂存` }
  }

  /** 中止进行中的合并/变基，恢复到操作前状态。 */
  async abortConflict(path: string, kind: 'merge' | 'rebase'): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(kind === 'merge' ? ['merge', '--abort'] : ['rebase', '--abort'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'abort-failed', message: run.stderr.trim() || `git ${kind} --abort failed` } }
    }
    return { ok: true, output: kind === 'merge' ? '已中止合并' : '已中止变基' }
  }

  /** 变基继续（-c core.editor=true 防止交互编辑器挂起子进程）。 */
  async continueRebase(path: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['-c', 'core.editor=true', 'rebase', '--continue'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'rebase-continue-failed', message: run.stderr.trim() || 'git rebase --continue failed' } }
    }
    return { ok: true, output: run.stdout.trim() || '变基继续完成' }
  }

  /** 撤销最近一次提交（soft reset，改动完整保留在暂存区）。根提交不可撤销。 */
  async undoCommit(path: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const parents = await this.runner.run(['rev-list', '--parents', '-n', '1', 'HEAD'], canonical)
    if (parents.exitCode !== 0 || parents.stdout.trim().split(/\s+/).length < 2) {
      return { ok: false, output: '', error: { code: 'root-commit', message: '根提交无法撤销' } }
    }
    const run = await this.runner.run(['reset', '--soft', 'HEAD~1'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'undo-failed', message: run.stderr.trim() || 'git reset --soft HEAD~1 failed' } }
    }
    return { ok: true, output: '已撤销最近一次提交（改动保留在暂存区）' }
  }

  /** 修补最近一次提交（amend）：给新信息则改写信息，否则保留原信息并入当前暂存。 */
  async amendCommit(path: string, message?: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const msg = message?.trim()
    const run = await this.runner.run(msg ? ['commit', '--amend', '-m', msg] : ['commit', '--amend', '--no-edit'], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'amend-failed', message: run.stderr.trim() || 'git commit --amend failed' } }
    }
    return { ok: true, output: run.stdout.trim() || '已修补最近一次提交' }
  }

  /** 贮藏明细操作：apply（保留栈）/ drop（丢弃指定条目）。 */
  async stashAction(path: string, action: 'apply' | 'drop', ref: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const clean = ref.trim()
    if (!/^stash@\{\d+\}$/.test(clean)) {
      return { ok: false, output: '', error: { code: 'bad-ref', message: `非法贮藏引用：${ref}` } }
    }
    const run = await this.runner.run(['stash', action, clean], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: `stash-${action}-failed`, message: run.stderr.trim() || `git stash ${action} failed` } }
    }
    return { ok: true, output: run.stdout.trim() || `${clean} ${action === 'apply' ? '已应用' : '已丢弃'}` }
  }

  /** 标签列表（名称 + 创建日期，按时间倒序）。 */
  async tags(path: string): Promise<Array<{ name: string; date: string }>> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['tag', '-l', '--sort=-creatordate', '--format=%(refname:short)%1f%(creatordate:short)'], canonical)
    if (run.exitCode !== 0) return []
    return run.stdout.split('\n').filter((l) => l.trim() !== '').map((line) => {
      const i = line.indexOf(FIELD)
      return i < 0 ? { name: line.trim(), date: '' } : { name: line.slice(0, i), date: line.slice(i + 1) }
    })
  }

  /** 建标签：给信息则注释标签（-a -m），否则轻量标签。 */
  async tagCreate(path: string, name: string, message?: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const clean = name.trim()
    if (clean === '') return { ok: false, output: '', error: { code: 'bad-name', message: '标签名不能为空' } }
    const msg = message?.trim()
    const run = await this.runner.run(msg ? ['tag', '-a', clean, '-m', msg] : ['tag', clean], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'tag-create-failed', message: run.stderr.trim() || 'git tag failed' } }
    }
    return { ok: true, output: `标签 ${clean} 已创建` }
  }

  /** 删除本地标签。 */
  async tagDelete(path: string, name: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['tag', '-d', name.trim()], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'tag-delete-failed', message: run.stderr.trim() || 'git tag -d failed' } }
    }
    return { ok: true, output: run.stdout.trim() }
  }

  /** 推送单个标签到 origin。 */
  async tagPush(path: string, name: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const run = await this.runner.run(['push', 'origin', name.trim()], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: run.stdout, error: { code: 'tag-push-failed', message: run.stderr.trim() || 'git push tag failed' } }
    }
    return { ok: true, output: run.stdout.trim() || `标签 ${name} 已推送` }
  }

  /** 未跟踪文件一键加入 .gitignore（幂等：已存在则跳过；随后暂存 .gitignore）。 */
  async gitignoreAdd(path: string, file: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const entry = file.split('\\').join('/')
    const gi = join(canonical, '.gitignore')
    let text = ''
    try { text = await readFile(gi, 'utf8') } catch { /* 新文件 */ }
    if (text.split(/\r?\n/).some((l) => l.trim() === entry)) {
      return { ok: true, output: `${entry} 已在 .gitignore 中` }
    }
    const next = (text === '' || text.endsWith('\n') ? text : text + '\n') + entry + '\n'
    await writeFile(gi, next, 'utf8')
    await this.runner.run(['add', '--', '.gitignore'], canonical)
    return { ok: true, output: `${entry} → .gitignore（已暂存）` }
  }

  /** 克隆远程仓库到父目录下并返回新路径（克隆成功后由路由层登记书架）。 */
  async cloneRepo(parent: string, url: string): Promise<{ path: string }> {
    let canonicalParent: string
    try { canonicalParent = await realpath(parent) } catch {
      throw Object.assign(new Error('父目录不存在'), { gitError: { code: 'bad-request', message: 'parent not found' } })
    }
    const cleanUrl = url.trim()
    if (!/^(https:\/\/|git@|ssh:\/\/)/.test(cleanUrl) || /\s/.test(cleanUrl)) {
      throw Object.assign(new Error('仅支持 https / git@ / ssh 远程地址'), { gitError: { code: 'bad-request', message: 'unsupported url' } })
    }
    const name = (cleanUrl.split(/[\\/]/).pop() ?? 'repo').replace(/\.git$/, '') || 'repo'
    const target = join(canonicalParent, name)
    if (existsSync(join(target, '.git'))) {
      throw Object.assign(new Error(`目标目录已存在仓库：${target}`), { gitError: { code: 'conflict', message: 'target exists' } })
    }
    const run = await this.runner.run(['clone', cleanUrl, target], canonicalParent)
    if (run.exitCode !== 0) {
      throw Object.assign(new Error(run.stderr.trim() || 'git clone failed'), { gitError: { code: 'clone-failed', message: run.stderr.trim() || 'git clone failed' } })
    }
    return { path: target }
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
    // 未跟踪文件：`git diff` 对它本来就没什么可输出（它比的是工作区与索引），
    // 面板于是显示"无变更"——可用户眼前明明是一个新文件。未跟踪 = 整份文件都是
    // 新增，这里直接合成一份 diff。
    const others = await this.runner.run(['ls-files', '--others', '--exclude-standard', '--', name], canonical)
    if (others.exitCode === 0 && others.stdout.split('\n').some((l) => l.trim() !== '')) {
      return await this.syntheticAddDiff(canonical, name)
    }
    // 全新仓库没有 HEAD：`git diff HEAD` 会直接 fatal（面板会把它显示成"二进制
    // 文件或超出大小限制"，而宿主日志里刷的其实是 'ambiguous argument HEAD'）。
    // 没有 HEAD 就降级成"工作区 vs 索引"。
    const head = await this.runner.run(['rev-parse', '--verify', '-q', 'HEAD'], canonical)
    const run = await this.runner.run(head.exitCode === 0 ? ['diff', 'HEAD', '--', name] : ['diff', '--', name], canonical)
    if (run.exitCode !== 0) {
      return { ok: false, output: '', error: { code: 'diff-failed', message: run.stderr.trim() || 'git diff failed' } }
    }
    return { ok: true, output: run.stdout }
  }

  /**
   * 未跟踪文件的合成 diff：整份内容都当作新增行。
   *
   * 目录（git 会把未跟踪目录整体报成一条）与二进制文件给一句**说明**，
   * 而不是把"读不了"伪装成"加载失败"——两者对用户的含义完全不同。
   * 读之前先看 size：预览一个几百 MB 的文件不该把宿主内存吃掉。
   */
  private async syntheticAddDiff(canonical: string, name: string): Promise<{ ok: boolean; output: string }> {
    const header = `diff --git a/${name} b/${name}\nnew file\n--- /dev/null\n+++ b/${name}\n`
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(join(canonical, name))
    } catch {
      return { ok: true, output: `${header}@@ new file (no content readable) @@\n` }
    }
    if (!info.isFile()) return { ok: true, output: `${header}@@ untracked directory @@\n` }
    if (info.size > UNTRACKED_MAX_BYTES) {
      return { ok: true, output: `${header}@@ too large to preview (${info.size} bytes) @@\n` }
    }
    const text = await readFile(join(canonical, name), 'utf8')
    if (text.includes('\u0000')) return { ok: true, output: `${header}@@ binary file @@\n` }
    const lines = text.split('\n')
    const shown = lines.slice(0, UNTRACKED_MAX_LINES)
    const body = shown.map((l) => `+${l}`).join('\n')
    const rest = lines.length - shown.length
    const tail = rest > 0 ? `\n+… (${rest} more lines)` : ''
    return { ok: true, output: `${header}@@ -0,0 +1,${shown.length} @@\n${body}${tail}` }
  }

  /** 上游存在但未推送的提交（@{u}..HEAD）；无上游、上游不可解析（悬空跟踪引用）或无提交时为空数组。 */
  async outgoing(path: string): Promise<{ commits: Array<{ sha: string; subject: string; author: string; date: string }> }> {
    const canonical = await this.requireWorkspace(path)
    const verify = await this.runner.run(['rev-parse', '--verify', '-q', '@{u}'], canonical)
    if (verify.exitCode !== 0) return { commits: [] }
    const run = await this.runner.run(['log', '@{u}..HEAD', '--format=%h%x1f%an%x1f%aI%x1f%s'], canonical)
    if (run.exitCode !== 0) return { commits: [] }
    const commits = run.stdout.split('\n').filter((l) => l.trim() !== '').map((l) => {
      const f = l.split(FIELD)
      return f.length >= 4
        ? { sha: f[0].trim(), author: f[1], date: f[2], subject: f[3] }
        : { sha: l.trim(), author: '', date: '', subject: '' }
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

  /** gh/API 通道推送：github.com:443 直连不可用时的恢复路径。
   * 逐提交在 GitHub 端重建（blob→tree→commit），完整保留作者/提交者与时间戳；
   * 完成后把分支引用快进到重建链顶端。sha 与本地一致时无缝对齐；
   * 因 GitHub 端归一化导致不一致时会在输出中如实说明。 */
  async apiPush(path: string): Promise<OpResult> {
    const canonical = await this.requireWorkspace(path)
    const origin = await this.originUrl(path)
    const parsed = repoFromUrl(origin)
    if (!parsed) return { ok: false, output: '', error: { code: 'not-github', message: 'origin 不是 GitHub 仓库，API 推送仅支持 GitHub 远端' } }
    const branch = (await this.runner.run(['rev-parse', '--abbrev-ref', 'HEAD'], canonical)).stdout.trim()
    if (!branch || branch === 'HEAD') return { ok: false, output: '', error: { code: 'detached-head', message: '当前处于 detached HEAD，无法推送' } }
    // 记录真实上游跟踪引用名，推送成功后同步本地跟踪引用（否则面板会多算"传出的更改"）
    const up = await this.runner.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], canonical)
    const upstreamRef = up.exitCode === 0 ? up.stdout.trim() : ''
    const head = (await this.runner.run(['rev-parse', 'HEAD'], canonical)).stdout.trim()
    const repoPath = `/repos/${parsed.owner}/${parsed.repo}`
    const notes: string[] = []
    try {
      const ref = await ghApi<{ object: { sha: string } }>('GET', `${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`)
      let apiHead = ref.object.sha
      if (apiHead === head) {
        // 短路路径同样校准本地跟踪引用——远端为真，缓存过期只是本地视角问题
        if (upstreamRef !== '') await this.runner.run(['update-ref', `refs/remotes/${upstreamRef}`, apiHead], canonical)
        return { ok: true, output: '远端已与本地一致（up to date）' }
      }
      // 归一化对齐：远端 sha 在本地不存在（GitHub 端 UTC 重建改写了哈希字节）时，
      // 用"树孪生"在本地找回远端顶点的等价提交——归一化不改写 tree 对象。
      let baseLocal = apiHead
      const localHasApiHead = (await this.runner.run(['cat-file', '-e', `${apiHead}^{commit}`], canonical)).exitCode === 0
      if (!localHasApiHead) {
        const remoteTree = (await ghApi<{ tree: { sha: string } }>('GET', `${repoPath}/git/commits/${apiHead}`)).tree.sha
        const cand = await this.runner.run(['log', '--format=%H %T', '-n', '500', 'HEAD'], canonical)
        const twin = cand.stdout.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p.length === 2 && p[1] === remoteTree)
        if (!twin) return { ok: false, output: '', error: { code: 'diverged', message: '远端顶点在本地无对应提交（归一化后历史分叉），快进式 API 推送不适用' } }
        baseLocal = twin[0]
        if (baseLocal === head) {
          // 远端内容 == 本地 HEAD（纯归一化差异）→ 视为已同步；跟踪引用必须指向本地合法 sha
          if (upstreamRef !== '') await this.runner.run(['update-ref', `refs/remotes/${upstreamRef}`, head], canonical)
          return { ok: true, output: `远端已与本地内容一致（GitHub 归一化 sha ${apiHead.slice(0, 7)} ↔ 本地孪生 ${head.slice(0, 7)}）` }
        }
      }
      let apiTree = (await ghApi<{ tree: { sha: string } }>('GET', `${repoPath}/git/commits/${apiHead}`)).tree.sha
      // 待推提交（旧→新），完整元数据逐字段保留。
      // FIELD 紧跟 %H，REC 作整条记录终止符——split(REC) 后每条记录 = sha⒟an⒟ae⒟…⒟message。
      const log = await this.runner.run(['log', '--reverse', `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%cn${FIELD}%ce${FIELD}%cI${FIELD}%B${REC}`, `${baseLocal}..HEAD`], canonical)
      if (log.exitCode !== 0) return { ok: false, output: '', error: { code: 'log-failed', message: log.stderr.trim() || 'git log failed' } }
      // git log 在每条目后补一个换行 → 除首条外每条记录以 \n 开头：只剥前导换行，
      // 保留消息尾部的换行（sha 保真）。之后 REC 分割、FIELD 解析。
      const records = log.stdout.split(REC).map((s) => s.replace(/^\n/, '')).filter((s) => s.trim() !== '')
      if (records.length === 0) return { ok: false, output: '', error: { code: 'diverged', message: '远端包含本地没有的提交（分叉），快进式 API 推送不适用' } }
      for (const rec of records) {
        const f = rec.split(FIELD)
        const sha = f[0]
        const message = f.slice(7).join(FIELD)
        const parents = (await this.runner.run(['rev-list', '--parents', '-n', '1', sha], canonical)).stdout.trim().split(/\s+/)
        if (parents.length > 2) return { ok: false, output: notes.join('\n'), error: { code: 'merge-unsupported', message: `提交 ${sha.slice(0, 7)} 是合并提交，API 通道暂不支持` } }
        const dt = await this.runner.run(['diff-tree', '--no-commit-id', '--name-status', '-r', sha], canonical)
        if (dt.exitCode !== 0) return { ok: false, output: notes.join('\n'), error: { code: 'difftree-failed', message: dt.stderr.trim() || 'git diff-tree failed' } }
        const entries: Array<{ path: string; mode: string; sha: string | null }> = []
        for (const line of dt.stdout.split('\n').filter((l) => l.trim() !== '')) {
          const parts = line.split('\t')
          const st = parts[0]
          if (st === 'D') {
            entries.push({ path: parts[1], mode: '100644', sha: null })
          } else if (st.startsWith('R') || st.startsWith('C')) {
            entries.push({ path: parts[1], mode: '100644', sha: null })
            entries.push(await this.apiBlobEntry(repoPath, canonical, sha, parts[2]))
          } else {
            entries.push(await this.apiBlobEntry(repoPath, canonical, sha, parts[1]))
          }
        }
        const tree = await ghApi<{ sha: string }>('POST', `${repoPath}/git/trees`, { base_tree: apiTree, tree: entries })
        const commit = await ghApi<{ sha: string; tree: { sha: string } }>('POST', `${repoPath}/git/commits`, {
          message,
          tree: tree.sha,
          parents: [apiHead],
          author: { name: f[1], email: f[2], date: f[3] },
          committer: { name: f[4], email: f[5], date: f[6] },
        })
        apiHead = commit.sha
        apiTree = commit.tree.sha
        notes.push(`${sha.slice(0, 7)} → ${apiHead.slice(0, 7)}`)
      }
      await ghApi('PATCH', `${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: apiHead, force: false })
      if (apiHead === head) {
        // sha 与本地一致 → 同步本地跟踪引用，传出计数立即归零
        if (upstreamRef !== '') await this.runner.run(['update-ref', `refs/remotes/${upstreamRef}`, apiHead], canonical)
        return { ok: true, output: `API 推送成功（${notes.length} 个提交，sha 与本地完全一致）\n${notes.join('\n')}` }
      }
      // 归一化分叉：远端内容 == 本地 HEAD，但远端 sha 本地永远不存在。
      // 跟踪引用指向本地 HEAD（合法对象、语义为"远端已含此内容"）；真 fetch 会用
      // 可解析的远端对象覆盖它。指向远端 sha 会制造悬空引用 → 全部 @{u}..HEAD 计算爆雷。
      if (upstreamRef !== '') await this.runner.run(['update-ref', `refs/remotes/${upstreamRef}`, head], canonical)
      return { ok: true, output: `API 推送完成（${notes.length} 个提交）。GitHub 端归一化：远端 ${apiHead.slice(0, 7)} ↔ 本地孪生 ${head.slice(0, 7)}（内容逐字节等价）。\n${notes.join('\n')}` }
    } catch (e) {
      return { ok: false, output: notes.join('\n'), error: { code: 'api-push-failed', message: e instanceof Error ? e.message : String(e) } }
    }
  }

  /** 原始字节级 blob 读取（runner 的 stdout 是文本管道，二进制会被破坏）。
   *  走 child_process 直连 git，Buffer 收集后 base64——文本与二进制同一条路。 */
  private gitBlobBase64(canonical: string, spec: string, file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['cat-file', 'blob', spec], { cwd: canonical, windowsHide: true })
      const chunks: Buffer[] = []
      let size = 0
      child.stdout.on('data', (c: Buffer) => {
        size += (c as Buffer).length
        if (size > 48 * 1024 * 1024) { child.kill(); reject(new Error(`文件超过 48MB，暂不支持 API 通道：${file}`)); return }
        chunks.push(c as Buffer)
      })
      child.on('error', (e) => reject(new Error(`git cat-file 启动失败：${String(e)}`)))
      child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks).toString('base64')) : reject(new Error(`git cat-file 失败：${file}`)))
    })
  }

  /** 单文件 → GitHub blob → tree 条目。buffer 级读取 + base64 上传，文本与二进制同路。 */
  private async apiBlobEntry(repoPath: string, canonical: string, sha: string, file: string): Promise<{ path: string; mode: string; sha: string | null }> {
    const ls = await this.runner.run(['ls-tree', sha, '--', file], canonical)
    const m = /^(\d+) blob [0-9a-f]+\t/.exec(ls.stdout)
    const mode = m ? m[1] : '100644'
    const content = await this.gitBlobBase64(canonical, `${sha}:${file}`, file)
    const blob = await ghApi<{ sha: string }>('POST', `${repoPath}/git/blobs`, { content, encoding: 'base64' })
    return { path: file, mode, sha: blob.sha }
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
