/**
 * dsh-git-manager — 文件活动追踪：agent 现在在改哪个文件夹、哪个仓库。
 *
 * 会话的 cwd 常常只是个**容器**（例如 D:\Harness 里套着十几二十个独立仓库）。
 * 面板只跟会话 cwd 的话，永远不知道你此刻在动的是其中哪一个。这里从
 * `tools/execute` 的参数里取文件路径，向上找它所属的仓库根，做两件事：
 *
 *   ① 没收录过的仓库**自动进货架**（去重、限量、只认真 git 仓库、可关）
 *   ② 记住"最近在动的文件夹/仓库"，供面板的悬挂提示显示
 *
 * 观测永不打断工具调用：任何异常都被吞掉，`next()` 一定照常继续。
 * @module dsh-git-manager/host/activity
 */

import { existsSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { gitRootOf } from './git-root.ts'
import { shelfAddAuto, shelfHas } from './repo-store.ts'
import type { EventBus } from './event-bus.ts'

/** 工具参数里可能装路径的键。按**键名**取而不是按工具名列表：新工具自动覆盖。 */
const PATH_KEYS = ['file_path', 'path', 'workdir', 'cwd', 'dir', 'root', 'files'] as const

/** 一次活动快照：面板的「正在修改」提示就显示这个。 */
export interface ActivitySnapshot {
  /** 最近一次文件类调用的工具名（read / edit / grep …）。 */
  tool: string
  /** 它碰的路径（绝对、已归一化）。 */
  path: string
  /** 它碰的**目录**（文件取其所在目录）。悬挂提示显示这个。 */
  dir: string
  /** 所属仓库根（向上找到 .git）。不在任何仓库里时为 null。 */
  repo: string | null
  /** 时间戳。 */
  at: number
}

export interface ActivityTracker {
  /** 最近一次活动；从没观测到文件类调用时为 null。 */
  snapshot(): ActivitySnapshot | null
  /** 由本追踪器自动收进货架的仓库（累计，用于诊断与测试）。 */
  autoAdded(): string[]
  dispose(): void
}

/** 从工具参数里掏出所有像路径的字符串。 */
function pathsFrom(args: unknown): string[] {
  const out: string[] = []
  if (typeof args !== 'object' || args === null) return out
  const rec = args as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const value = rec[key]
    if (typeof value === 'string' && value !== '') out.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item !== '') out.push(item)
    }
  }
  return out
}

/** 该路径是目录吗（不存在 → false）。 */
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/**
 * 绝对化，并求出这条路径**所在**的目录。
 *
 * 路径可能**还不存在**：观测发生在 `next()` 之前，`write` 新建文件时就是这种
 * 情况。这时退到最近的已存在祖先目录——否则"新建的文件属于哪个仓库"会整条
 * 漏掉（新建文件恰恰是最该被看见的活动）。`abs` 保持原样，gitRootOf 对
 * 不存在的路径照样能向上找到仓库根。
 */
function normalize(raw: string): { abs: string; dir: string } | null {
  let abs: string
  try {
    abs = isAbsolute(raw) ? raw : resolve(raw)
  } catch { return null }
  if (existsSync(abs)) return { abs, dir: isDir(abs) ? abs : dirname(abs) }
  let cur = abs
  for (let i = 0; i < 12; i++) {
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
    if (existsSync(cur)) return { abs, dir: isDir(cur) ? cur : dirname(cur) }
  }
  return null
}

/** 宿主上下文里我们真正用到的那一点点（与文件里其它地方同风格：窄接口 + 收窄）。 */
interface ExecuteCarrier {
  on(event: string, handler: (exec: ToolExecLike, next: () => unknown) => unknown): unknown
  workspaceRegistry?: { list(): Array<{ path: string }> }
}

interface ToolExecLike {
  name?: unknown
  arguments?: unknown
  args?: unknown
}

/**
 * 开始追踪文件活动。返回快照读取器与 dispose。
 *
 * @param ctx 宿主上下文（需要 tools 服务，插件已 inject）
 * @param eventBus 收录成功时往活动流里发一条 `repo:auto-added`
 * @param log 可选日志
 */
export function startActivityTracker(
  ctx: Context,
  eventBus: EventBus,
  log: (msg: string) => void = () => {},
  config?: { autoRegisterRepos?: boolean },
): ActivityTracker {
  const carrier = ctx as unknown as ExecuteCarrier
  // 关掉自动收录：cordis.patch.yml 里给这一行加 config.autoRegisterRepos: false。
  // config 由 Cordis 作为 apply(ctx, config) 的第二个参数传入，不能通过 ctx.config
  // 读取（ctx 是服务代理，未声明 config inject 时访问会抛错）。
  const enabled = config?.autoRegisterRepos !== false

  let last: ActivitySnapshot | null = null
  const autoAdded = new Set<string>()

  const known = (root: string): boolean => {
    try {
      if (shelfHas(root)) return true
      return (carrier.workspaceRegistry?.list() ?? []).some((w) => w.path === root)
    } catch { return true }   // 查询失败时当成"已知"，宁可不收录
  }

  const observe = (exec: ToolExecLike): void => {
    const tool = typeof exec.name === 'string' ? exec.name : ''
    if (tool === '') return
    const args = exec.arguments ?? exec.args ?? {}
    const candidates = pathsFrom(args)
    if (candidates.length === 0) return

    for (const raw of candidates) {
      const hit = normalize(raw)
      if (hit === null) continue
      const repo = gitRootOf(hit.abs)
      last = { tool, path: hit.abs, dir: hit.dir, repo, at: Date.now() }
      if (repo === null || known(repo)) return
      if (!enabled) return
      const title = basename(repo)
      if (shelfAddAuto(repo, title)) {
        autoAdded.add(repo)
        log(`auto-registered ${repo} (${tool} touched ${hit.abs})`)
        eventBus.emit('repo:auto-added', { path: repo, workspace: title, via: tool, file: hit.abs })
      }
      return
    }
  }

  carrier.on('tools/execute', async (exec: ToolExecLike, next: () => unknown) => {
    try { observe(exec) } catch { /* 观测永不打断工具调用 */ }
    return await next()
  })

  return {
    snapshot: () => (last === null ? null : { ...last }),
    autoAdded: () => [...autoAdded],
    dispose: () => { /* 观测是只读旁路，没有需要拆的东西 */ },
  }
}
