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
function looseTool(opts: LooseTool): any {
  // 运行时完全一致；仅绕开 defineTool 的深度泛型推断（InferObject 递归）。
  return (defineTool as (o: unknown) => unknown)(opts)
}

/** 写操作审批：拒绝则抛错，批准继续。 */
async function requireApproval(ctx: Context, exec: ToolExec, reason: string): Promise<void> {
  const approval = ctx.get('approval') as
    | { request(opts: { agent?: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }): Promise<string> }
    | undefined
  if (!approval) {
    throw new Error(`tool "${exec.name}" requires approval, but no approval channel is available`)
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
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

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

const arrayOutput = {
  schema: { type: 'array', items: { type: 'object', additionalProperties: true } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

export function registerTools(ctx: Context, service: GitService): () => void {
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
    }),
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
    }),
    looseTool({
      name: 'git_branches',
      description: 'List local and remote branches of a git workspace with ahead/behind counts. Read-only.',
      parameters: { workspace: prop('string', true, 'Absolute path of the git workspace.') },
      output: objectOutput,
      async execute(args: { workspace: string }, _exec) {
        return runGit(args.workspace, async (cwd) => await service.branches(cwd))
      },
    }),
    looseTool({
      name: 'git_commit',
      description: 'COMMIT staged changes in a git workspace (git commit -m). THIS MODIFIES FILES — it always requires your approval.',
      parameters: {
        workspace: prop('string', true, 'Absolute path of the git workspace.'),
        message: prop('string', true, 'Commit message.'),
      },
      output: objectOutput,
      async execute(args: { workspace: string; message: string }, exec: ToolExec) {
        await requireApproval(ctx, exec, `git commit -m "${args.message}" in ${args.workspace}`)
        return runGit(args.workspace, async (cwd) => await service.commit(cwd, args.message))
      },
    }),
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
        await requireApproval(ctx, exec, `git push in ${args.workspace}`)
        return runGit(args.workspace, async (cwd) => await service.push(cwd, args.remote || undefined, args.branch || undefined))
      },
    }),
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
    }),
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
    }),
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
        await requireApproval(ctx, exec, `create PR "${args.title}" (${args.head} -> ${args.base}) in ${args.owner}/${args.repo}`)
        return await gh.createPR(args.owner, args.repo, {
          title: args.title,
          head: args.head,
          base: args.base,
          body: args.body || undefined,
          draft: args.draft === true,
        })
      },
    }),
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
        await requireApproval(ctx, exec, `merge PR #${args.number} in ${args.owner}/${args.repo} (${args.method || 'squash'})`)
        await gh.mergePR(args.owner, args.repo, args.number, (args.method || 'squash') as 'merge' | 'squash' | 'rebase')
        return { merged: true }
      },
    }),
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
    }),
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
        await requireApproval(ctx, exec, `create issue "${args.title}" in ${args.owner}/${args.repo}`)
        return await gh.createIssue(args.owner, args.repo, args.title, args.body || undefined)
      },
    }),
  ]

  for (const tool of tools) ctx.tools.register(tool)
  // 工具随插件 fiber 自动释放（cordis effect 作用域），无需手动注销。
  return () => {}
}

