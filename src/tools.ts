/**
 * gitcompass — model-side tools: structured git / GitHub operations so the
 * agent stops reaching for ad-hoc `git` shell commands. Every write tool
 * (commit / push / PR create+merge / issue create) goes through the DSH
 * approval channel; read-only tools do not.
 *
 * The user's rule: any operation that modifies files must prompt first —
 * `git_commit` and `git_push` therefore always request approval, and their
 * descriptions say so explicitly.
 * @module gitcompass/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GitService } from './host/git-service.ts'
import * as gh from './host/github-service.ts'
import type { EventBus } from './host/event-bus.ts'
import { checkPreApproval, panelApprovalBroker } from './host/event-bus.ts'

interface ToolExec {
  name: string
  agent?: unknown
  callId?: string
  signal?: AbortSignal
}

/**
 * Loose registration wrapper: the runtime validates arguments against the
 * `parameters` schema exactly as typed; only the compile-time generic
 * inference of `defineTool` is relaxed here.
 */
type LooseTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => Array<{ type: 'text'; text: string }> }
  execute(args: Record<string, unknown>, exec: unknown): Promise<unknown>
}
function looseTool(opts: LooseTool, eventBus?: EventBus): any {
  const originalExecute = opts.execute
  const wrappedExecute = eventBus
    ? async (args: Record<string, unknown>, exec: unknown): Promise<unknown> => {
        const toolExec = exec as ToolExec
        const callId = toolExec.callId ?? `call-${Date.now()}`
        const argsSummary = summarizeArgs(opts.name, args)

        eventBus.emit('tool:start', { tool: opts.name, args, summary: argsSummary, callId })
        try {
          const result = await originalExecute(args, exec)
          eventBus.emit('tool:completed', { tool: opts.name, args, summary: argsSummary, callId, result: summarizeResult(opts.name, result) })
          return result
        } catch (error) {
          eventBus.emit('tool:error', { tool: opts.name, args, summary: argsSummary, callId, error: String(error instanceof Error ? error.message : error) })
          throw error
        }
      }
    : originalExecute

  return (defineTool as (o: unknown) => unknown)({ ...opts, execute: wrappedExecute })
}

/** 写操作审批：pre-approval → 面板实时决策与 DSH 弹窗并行竞速，先到者生效。
 *  `extras` 由调用方附加到 approval:requested（如 git_commit 的文件级评审载荷）。 */
async function requireApproval(ctx: Context, exec: ToolExec, reason: string, eventBus?: EventBus, extras?: Record<string, unknown>): Promise<void> {
  const callId = exec.callId ?? `call-${Date.now()}`

  // ① Check pre-approval from panel
  if (checkPreApproval(exec.name, callId)) {
    if (eventBus) eventBus.emit('approval:approved', { tool: exec.name, callId, summary: reason, source: 'pre-approval' })
    return
  }

  // ② Emit approval requested event (panel shows the live approval card)
  if (eventBus) eventBus.emit('approval:requested', { tool: exec.name, callId, summary: reason, ...extras })

  // ③ DSH modal channel (may be unavailable in some contexts)
  const approval = ctx.get('approval') as
    | { request(opts: { agent?: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<string> }
    | undefined

  // ④ Race: panel decision vs. modal dialog — PANEL-AUTHORITATIVE semantics:
  //   - panel settles first → its decision rules;
  //   - modal 'allowed-once' (human approved the native dialog) → allow instantly;
  //   - modal ANY other outcome — 'rejected' (which DSH also returns when the
  //     session approval policy is 'never'/prompts disabled, so a ghost deny is
  //     indistinguishable from a human deny), 'cancelled', 'unavailable', or
  //     channel error — CANNOT veto: the panel card is this plugin's purpose-
  //     built gate. Wait for the panel decision or its 5-min timeout (null →
  //     reject, fail closed). The native dialog can only accelerate approval.
  type Winner = { src: 'panel'; decision: 'approved' | 'rejected' | null } | { src: 'modal'; outcome: string | null }
  const panelPromise = panelApprovalBroker.wait(callId, 300_000).then(
    (d): Winner => ({ src: 'panel', decision: d }),
  )
  const modalPromise: Promise<Winner> = approval
    ? approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId,
        reason,
        signal: exec.signal,
      }).then((o): Winner => ({ src: 'modal', outcome: o })).catch((): Winner => ({ src: 'modal', outcome: null }))
    : new Promise<Winner>(() => { /* no modal channel — panel only */ })

  const first = await Promise.race([panelPromise, modalPromise])
  let winner: Winner
  if (first.src === 'panel') {
    winner = first
  } else if (first.outcome === 'allowed-once') {
    winner = first
  } else {
    winner = await panelPromise
  }

  let allowed = false
  let source = 'modal'
  if (winner.src === 'panel') {
    allowed = winner.decision === 'approved'
    source = winner.decision === null ? 'timeout' : 'panel'
  } else {
    allowed = winner.outcome === 'allowed-once'
    source = 'modal'
  }

  // ⑤ Emit approval result
  if (eventBus) {
    eventBus.emit(allowed ? 'approval:approved' : 'approval:rejected', {
      tool: exec.name, callId, summary: reason, source,
    })
  }

  if (!allowed) {
    throw new Error(`the user rejected tool "${exec.name}"`)
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

type PropSpec = { type: 'string' | 'boolean' | 'number'; description: string; required?: true }

function prop(type: 'string' | 'boolean' | 'number', required: boolean, description: string): PropSpec {
  return { type, description, ...(required ? { required: true } : {}) }
}

/** Human-readable summary of tool arguments for the activity feed. */
function summarizeArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'git_commit': return `commit "${args.message}" in ${args.workspace}`
    case 'git_push': return `push ${args.workspace}${args.remote ? ` to ${args.remote}` : ''}`
    case 'git_status': return `status of ${args.workspace}`
    case 'git_diff': return `diff ${args.file} in ${args.workspace}`
    case 'git_branches': return `branches of ${args.workspace}`
    case 'github_pr_create': return `create PR "${args.title}" (${args.head} → ${args.base})`
    case 'github_pr_merge': return `merge PR #${args.number}`
    case 'github_pr_comment': return `comment on PR #${args.number}`
    case 'github_pr_review': return `review PR #${args.number} (${args.state})`
    case 'github_issue_create': return `create issue "${args.title}"`
    case 'github_issue_comment': return `comment on issue #${args.number}`
    case 'github_issue_read': return `read issue #${args.number}`
    default: return ''
  }
}

/** Summarize tool result for the activity feed. */
function summarizeResult(tool: string, result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const r = result as Record<string, unknown>
  if (r.ok === false) return r.error ? String((r.error as Record<string, unknown>).message ?? 'failed') : 'failed'
  switch (tool) {
    case 'git_commit': return 'committed'
    case 'git_push': return 'pushed'
    case 'github_pr_create': return `PR #${(r as Record<string, unknown>).number ?? '?'} created`
    case 'github_pr_merge': return 'PR merged'
    case 'github_pr_comment': return 'commented'
    case 'github_pr_review': return 'reviewed'
    case 'github_issue_create': return `issue #${(r as Record<string, unknown>).number ?? '?'} created`
    case 'github_issue_comment': return 'commented'
    default: return ''
  }
}

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

const arrayOutput = {
  schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

export function registerTools(ctx: Context, service: GitService, eventBus?: EventBus): () => void {
  const gate = (service as unknown as { gate: (p: string) => Promise<{ ok: boolean }> }).gate
  const runGit = async <T>(workspace: string, fn: (cwd: string) => Promise<T>): Promise<T> => {
    const verdict = await gate(workspace)
    if (!verdict.ok) throw new Error(`workspace not registered: ${workspace}`)
    return fn(workspace)
  }

  const tools = [
    looseTool({
      name: 'git_status',
      description: 'Show the working-tree status of a git workspace (changed/staged/untracked files). Read-only.',
      parameters: { workspace: prop('string', true, 'Absolute path of the git workspace.') },
      output: objectOutput,
      async execute(args: { workspace: string }, _exec) {
        return runGit(args.workspace, async (cwd) => await service.status(cwd))
      },
    }, eventBus),
    looseTool({
      name: 'git_diff',
      description: 'Show the diff of one file in a git workspace (working tree vs HEAD). Read-only.',
      parameters: {
        workspace: prop('string', true, 'Absolute path of the git workspace.'),
        file: prop('string', true, 'File path relative to the workspace root.'),
      },
      output: objectOutput,
      async execute(args: { workspace: string; file: string }, _exec) {
        return runGit(args.workspace, async (cwd) => await service.diffFile(cwd, args.file))
      },
    }, eventBus),
    looseTool({
      name: 'git_branches',
      description: 'List local and remote branches of a git workspace with ahead/behind counts. Read-only.',
      parameters: { workspace: prop('string', true, 'Absolute path of the git workspace.') },
      output: objectOutput,
      async execute(args: { workspace: string }, _exec) {
        return runGit(args.workspace, async (cwd) => await service.branches(cwd))
      },
    }, eventBus),
    looseTool({
      name: 'git_commit',
      description: 'COMMIT staged changes in a git workspace (git commit -m). THIS MODIFIES FILES — it always requires your approval.',
      parameters: {
        workspace: prop('string', true, 'Absolute path of the git workspace.'),
        message: prop('string', true, 'Commit message.'),
      },
      output: objectOutput,
      async execute(args: { workspace: string; message: string }, exec: ToolExec) {
        // 文件级评审载荷：面板按文件标签页渲染全文对照审批卡。best-effort。
        let extras: Record<string, unknown> | undefined
        try {
          const snap = await service.reviewSnapshot(args.workspace)
          if (snap.ok && snap.files) extras = { files: snap.files, workspace: args.workspace }
        } catch { /* review payload is best-effort */ }
        await requireApproval(ctx, exec, `git commit -m "${args.message}" in ${args.workspace}`, eventBus, extras)
        return runGit(args.workspace, async (cwd) => await service.commit(cwd, args.message))
      },
    }, eventBus),
    looseTool({
      name: 'git_push',
      description: 'PUSH the current branch of a git workspace to its remote (git push). THIS MODIFIES THE REMOTE — it always requires your approval.',
      parameters: {
        workspace: prop('string', true, 'Absolute path of the git workspace.'),
        remote: prop('string', false, 'Remote name (default: origin).'),
        branch: prop('string', false, 'Branch name to push when no upstream exists.'),
      },
      output: objectOutput,
      async execute(args: { workspace: string; remote?: string; branch?: string }, exec: ToolExec) {
        await requireApproval(ctx, exec, `git push in ${args.workspace}`, eventBus)
        return runGit(args.workspace, async (cwd) => await service.push(cwd, args.remote || undefined, args.branch || undefined))
      },
    }, eventBus),
    looseTool({
      name: 'github_pr_list',
      description: 'List pull requests of a GitHub repository. Read-only.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        state: prop('string', false, 'open | closed | all (default open).'),
      },
      output: arrayOutput,
      async execute(args: { owner: string; repo: string; state?: string }) {
        return await gh.listPRs(args.owner, args.repo, (args.state || 'open') as 'open' | 'closed' | 'all')
      },
    }, eventBus),
    looseTool({
      name: 'github_pr_read',
      description: 'Read a pull request detail (files, checks, reviews, comments). Read-only.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        number: prop('number', true, 'Pull request number.'),
      },
      output: objectOutput,
      async execute(args: { owner: string; repo: string; number: number }) {
        return await gh.getPRDetail(args.owner, args.repo, args.number)
      },
    }, eventBus),
    looseTool({
      name: 'github_pr_create',
      description: 'CREATE a pull request on GitHub. THIS MODIFIES THE REMOTE — it always requires your approval.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        title: prop('string', true, 'PR title.'),
        head: prop('string', true, 'Head branch (the branch with your changes).'),
        base: prop('string', true, 'Base branch (usually the default branch, e.g. main).'),
        body: prop('string', false, 'PR description.'),
        draft: prop('boolean', false, 'Create as draft PR.'),
      },
      output: objectOutput,
      async execute(args: { owner: string; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean }, exec: ToolExec) {
        await requireApproval(ctx, exec, `create PR "${args.title}" (${args.head} -> ${args.base}) in ${args.owner}/${args.repo}`, eventBus)
        return await gh.createPR(args.owner, args.repo, {
          title: args.title,
          head: args.head,
          base: args.base,
          body: args.body || undefined,
          draft: args.draft === true,
        })
      },
    }, eventBus),
    looseTool({
      name: 'github_pr_merge',
      description: 'MERGE a pull request on GitHub. THIS MODIFIES THE REMOTE — it always requires your approval.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        number: prop('number', true, 'Pull request number.'),
        method: prop('string', false, 'merge | squash | rebase (default squash).'),
      },
      output: objectOutput,
      async execute(args: { owner: string; repo: string; number: number; method?: string }, exec: ToolExec) {
        await requireApproval(ctx, exec, `merge PR #${args.number} in ${args.owner}/${args.repo} (${args.method || 'squash'})`, eventBus)
        await gh.mergePR(args.owner, args.repo, args.number, (args.method || 'squash') as 'merge' | 'squash' | 'rebase')
        return { merged: true }
      },
    }, eventBus),
    looseTool({
      name: 'github_issue_list',
      description: 'List issues of a GitHub repository. Read-only.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        state: prop('string', false, 'open | closed | all (default open).'),
      },
      output: arrayOutput,
      async execute(args: { owner: string; repo: string; state?: string }) {
        return await gh.listIssues(args.owner, args.repo, (args.state || 'open') as 'open' | 'closed' | 'all')
      },
    }, eventBus),
    looseTool({
      name: 'github_issue_create',
      description: 'CREATE an issue on GitHub. THIS MODIFIES THE REMOTE — it always requires your approval.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        title: prop('string', true, 'Issue title.'),
        body: prop('string', false, 'Issue body.'),
      },
      output: objectOutput,
      async execute(args: { owner: string; repo: string; title: string; body?: string }, exec: ToolExec) {
        await requireApproval(ctx, exec, `create issue "${args.title}" in ${args.owner}/${args.repo}`, eventBus)
        return await gh.createIssue(args.owner, args.repo, args.title, args.body || undefined)
      },
    }, eventBus),
    looseTool({
      name: 'github_issue_read',
      description: 'Read an issue detail (body, labels, comments) on GitHub. Read-only.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        number: prop('number', true, 'Issue number.'),
      },
      output: objectOutput,
      async execute(args: { owner: string; repo: string; number: number }) {
        return await gh.getIssueDetail(args.owner, args.repo, args.number)
      },
    }, eventBus),
    looseTool({
      name: 'github_issue_comment',
      description: 'COMMENT on a GitHub issue. THIS MODIFIES THE REMOTE — it always requires your approval.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        number: prop('number', true, 'Issue number.'),
        body: prop('string', true, 'Comment body.'),
      },
      output: objectOutput,
      async execute(args: { owner: string; repo: string; number: number; body: string }, exec: ToolExec) {
        await requireApproval(ctx, exec, `comment on issue #${args.number} in ${args.owner}/${args.repo}`, eventBus)
        await gh.commentIssue(args.owner, args.repo, args.number, args.body)
        return { commented: true }
      },
    }, eventBus),
    looseTool({
      name: 'github_pr_comment',
      description: 'COMMENT on a GitHub pull request. THIS MODIFIES THE REMOTE — it always requires your approval.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        number: prop('number', true, 'Pull request number.'),
        body: prop('string', true, 'Comment body.'),
      },
      output: objectOutput,
      async execute(args: { owner: string; repo: string; number: number; body: string }, exec: ToolExec) {
        await requireApproval(ctx, exec, `comment on PR #${args.number} in ${args.owner}/${args.repo}`, eventBus)
        await gh.commentPR(args.owner, args.repo, args.number, args.body)
        return { commented: true }
      },
    }, eventBus),
    looseTool({
      name: 'github_pr_review',
      description: 'SUBMIT A REVIEW on a GitHub pull request. THIS MODIFIES THE REMOTE — it always requires your approval.',
      parameters: {
        owner: prop('string', true, 'Repository owner.'),
        repo: prop('string', true, 'Repository name.'),
        number: prop('number', true, 'Pull request number.'),
        state: prop('string', true, 'APPROVE | REQUEST_CHANGES | COMMENT'),
        body: prop('string', false, 'Review body (required for REQUEST_CHANGES).'),
      },
      output: objectOutput,
      async execute(args: { owner: string; repo: string; number: number; state: string; body?: string }, exec: ToolExec) {
        await requireApproval(ctx, exec, `submit PR review (${args.state}) on #${args.number} in ${args.owner}/${args.repo}`, eventBus)
        await gh.reviewPR(args.owner, args.repo, args.number, args.state as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', args.body || undefined)
        return { reviewed: true }
      },
    }, eventBus),
  ]

  for (const tool of tools) ctx.tools.register(tool)
  // 工具随插件 fiber 自动释放（cordis effect 作用域），无需手动注销。
  return () => {}
}

