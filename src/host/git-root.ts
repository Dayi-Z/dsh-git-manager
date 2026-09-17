/**
 * dsh-git-manager — 从任意路径向上找它所属的 git 仓库根。
 *
 * 会话的 cwd、以及 agent 正在编辑的文件路径，通常都在仓库**里面**（子目录），
 * 直接要求它自己有 .git 会把绝大多数情况挡在门外。宿主的两条收录路径
 * （会话 cwd 的 /gitm/repos-add、文件活动的自动收录）共用这一份实现。
 *
 * 对文件路径同样有效：先试 `<file>/.git`（必然不存在），再逐层向上退到
 * 它所在的目录，所以不需要先判断"这是文件还是目录"。
 * @module dsh-git-manager/host/git-root
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const GIT_MARK = '.git'
/** 向上最多走几层。够深到 monorepo 子目录，又不至于从 C:\ 一路翻到根。 */
const MAX_UP = 12

/**
 * 从某个目录/文件路径向上找包含 .git 的仓库根（最多 12 层）。找不到返回 null。
 *
 * 用 existsSync 而不是 access：这条路径在每次会话切换、每个文件类工具调用
 * 上都会走一遍，同步判断足够快（最多 12 次 stat）。
 */
export function gitRootOf(start: string): string | null {
  let current = start
  for (let i = 0; i < MAX_UP; i++) {
    if (existsSync(join(current, GIT_MARK))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}
