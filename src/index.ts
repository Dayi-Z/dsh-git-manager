/**
 * gitcompass — DSH web git + GitHub workbench.
 *
 * Host side: workspace-bounded git service (/gitu/* routes), GitHub auth
 * (device flow + DPAPI token + gh sync), GitHub PR/issue REST endpoints, and
 * model-side structured git/github tools (write ops gated by approval).
 * Client side ("./client") mounts the panel with the guided flow strip,
 * commit graph (PR/CI badges), PR list/detail and GitHub connect views.
 *
 * Security: git ops are workspace-gated; the GitHub token never leaves the
 * host and is DPAPI-encrypted at rest; write tools always request approval.
 * @module gitcompass
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { GitService, subprocessRunner, type WorkspaceGate } from './host/git-service.ts'
import { registerGitcompassRoutes } from './host/routes.ts'
import { registerTools } from './tools.ts'

/** 所需服务：webserver 路由、托管子进程、workspace 注册表、工具注册表。 */
export const inject = ['webServer', 'subprocess', 'workspaceRegistry', 'tools']

/** 工作区归属门禁：规范化路径并要求它是已注册的 workspace。 */
function createWorkspaceGate(ctx: Context): WorkspaceGate {
  return async (path) => {
    let canonical: string
    try {
      canonical = await realpath(path)
    } catch {
      return { ok: false, error: { code: 'workspace-unknown', message: 'path does not resolve on disk' } }
    }
    if (ctx.workspaceRegistry.list().some((workspace) => workspace.path === canonical)) {
      return { ok: true, canonical }
    }
    return { ok: false, error: { code: 'workspace-unknown', message: 'path is not a registered workspace' } }
  }
}

export function apply(ctx: Context): void {
  const service = new GitService(subprocessRunner(ctx), createWorkspaceGate(ctx))

  ctx.effect(() => registerGitcompassRoutes(ctx, service), 'gitcompass: /gitu routes')
  ctx.effect(() => registerTools(ctx, service), 'gitcompass: model tools')

  // 引导 agent 优先使用结构化 git/github 工具，而不是裸 bash git。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'app:gitcompass',
      order: -97,
      text: () => 'The gitcompass plugin provides structured git and GitHub tools (git_status, git_diff, git_branches, git_commit, git_push, github_pr_*, github_issue_*). For repository operations, prefer these over ad-hoc `git` shell commands: they are workspace-scoped, show clear output, and every write operation prompts the user for approval.',
    })
  })
}

/** Cordis 插件入口——命名导出与默认导出并存。 */
export default { apply, inject }
