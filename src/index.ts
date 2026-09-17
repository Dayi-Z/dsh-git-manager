/**
 * dsh-git-manager — DSH web git + GitHub workbench.
 *
 * Host side: workspace-bounded git service (/gitm/* routes), GitHub auth
 * (device flow + DPAPI token + gh sync), GitHub PR/issue REST endpoints, and
 * model-side structured git/github tools (write ops gated by approval).
 * Client side ("./client") mounts the panel with the guided flow strip,
 * commit graph (PR/CI badges), PR list/detail and GitHub connect views.
 *
 * Security: git ops are workspace-gated; the GitHub token never leaves the
 * host and is DPAPI-encrypted at rest; write tools always request approval.
 * @module dsh-git-manager
 */

import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { GitService, subprocessRunner, type WorkspaceGate } from './host/git-service.ts'
import { shelfHas } from './host/repo-store.ts'
import { registerGitManagerRoutes } from './host/routes.ts'
import { registerTools } from './tools.ts'
import { EventBus, startRepoObserver } from './host/event-bus.ts'
import { startActivityTracker } from './host/activity.ts'

/** 所需服务：webserver 路由、托管子进程、workspace 注册表、工具注册表。 */
export const inject = ['webServer', 'subprocess', 'workspaceRegistry', 'tools']

/** Event bus singleton — shared between host routes (SSE) and tool wrappers. */
export const eventBus = new EventBus()

/** 工作区归属门禁：规范化路径并要求它是已注册的 workspace 或插件收录仓库。 */
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
    if (shelfHas(canonical)) return { ok: true, canonical }
    return { ok: false, error: { code: 'workspace-unknown', message: 'path is not a registered workspace' } }
  }
}

export function apply(ctx: Context): void {
  const service = new GitService(subprocessRunner(ctx), createWorkspaceGate(ctx))

  // 文件活动追踪：会话 cwd 常常只是**容器**（D:\Harness 里套着十几个独立仓库），
  // 面板只跟 cwd 就永远不知道你在动哪个仓库。这里从 tools/execute 的参数取文件
  // 路径、向上找仓库根，没收录过的自动进货架，并记住"正在修改"的文件夹。
  // 关掉：cordis.patch.yml 里给这一行加 config.autoRegisterRepos: false。
  const logActivity = (msg: string): void => {
    try {
      const logger = (ctx as unknown as { logger?: (name: string) => { info?: (m: string) => void } })
        .logger?.('dsh-git-manager')
      logger?.info?.(msg)
    } catch { /* 没有 logger 服务就算了 */ }
  }
  const activity = startActivityTracker(ctx, eventBus, logActivity)
  ctx.effect(() => () => activity.dispose(), 'dsh-git-manager: activity tracker')

  ctx.effect(() => registerGitManagerRoutes(ctx, service, eventBus, activity), 'dsh-git-manager: /gitm routes')
  ctx.effect(() => registerTools(ctx, service, eventBus), 'dsh-git-manager: model tools')
  ctx.effect(() => startRepoObserver(ctx, eventBus), 'dsh-git-manager: repo observer')

  // 引导 agent 优先使用结构化 git/github 工具，而不是裸 bash git。
  // 关键澄清：写操作的审批门在 dsh-git-manager 面板（面板权威），任何 approval
  // policy 下都可用——包括 danger-full-access 预设自带的 'never'（原生通道
  // 的自动拒绝只是 ghost deny，不能否决面板卡）。没有面板在线时快速失败并
  // 提示用户打开面板，而不是静默挂死。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'app:dsh-git-manager',
      order: -97,
      text: () => 'The dsh-git-manager plugin provides structured git and GitHub tools (git_status, git_diff, git_branches, git_commit, git_push, github_pr_*, github_issue_*). For repository operations, prefer these over ad-hoc `git` shell commands: they are workspace-scoped and show clear output. Write operations (commit / push / PR / issue writes) are gated by an approval card in the dsh-git-manager panel — this works under ANY approval policy, including when DSH approval prompts are disabled ("never", e.g. the danger-full-access preset): the automatic rejection from the native approval channel is a ghost deny that cannot veto; the panel card decides. So when the user asks for a git/GitHub write, CALL the tool — do not skip it on the ground that approval prompts are disabled. If no panel is connected the call fails fast with a hint: tell the user to open the Git panel (or pre-approve the tool there) and then retry.',
    })
  })
}

/** Cordis 插件入口——命名导出与默认导出并存。 */
export default { apply, inject }
