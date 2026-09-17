/**
 * dsh-git-manager — plugin-owned repository shelf.
 *
 * DSH's workspaceRegistry only contains folders users explicitly registered;
 * nested standalone repos (e.g. dsh-git-manager inside the dshmarket monorepo) are
 * invisible to it. This store persists an extra, user-managed repo list so
 * they appear in the panel dropdown and pass the git operations gate.
 *
 * Storage: ~/.dsh/storages/dsh-git-manager/repos.json
 * @module dsh-git-manager/host/repo-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RepoShelfEntry {
  path: string
  title?: string
  /** 由文件活动**自动**收录（而不是用户手动"收录仓库"）：货架自己长的那些。 */
  auto?: boolean
  /** 收录时间，用于自动条目的上限淘汰。 */
  at?: number
}

/** 自动收录条目上限：货架不能因为"今天动过的仓库"无限长。手动条目永不淘汰。 */
export const AUTO_SHELF_MAX = 20

const STORAGE_DIR = join(homedir(), '.dsh', 'storages', 'dsh-git-manager')
const SHELF_FILE = join(STORAGE_DIR, 'repos.json')

let cache: RepoShelfEntry[] | null = null

function load(): RepoShelfEntry[] {
  if (cache !== null) return cache
  try {
    if (!existsSync(SHELF_FILE)) { cache = []; return cache }
    // 兼容 PowerShell 写出的 UTF-8 BOM——裸 JSON.parse 会因 BOM 抛错。
    const rawText = readFileSync(SHELF_FILE, 'utf8').replace(/^\uFEFF/, '')
    const raw = JSON.parse(rawText) as unknown
    cache = Array.isArray(raw)
      ? (raw as Array<Record<string, unknown>>)
          .filter((r) => typeof r.path === 'string' && r.path !== '')
          .map((r) => ({
            path: r.path as string,
            ...(typeof r.title === 'string' ? { title: r.title } : {}),
            ...(r.auto === true ? { auto: true } : {}),
            ...(typeof r.at === 'number' ? { at: r.at } : {}),
          }))
      : []
  } catch {
    cache = []
  }
  return cache!
}

function persist(): void {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true })
    const tmp = SHELF_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8')
    renameSync(tmp, SHELF_FILE)
  } catch { /* best effort */ }
}

export function shelfList(): RepoShelfEntry[] {
  return load().map((e) => ({ ...e }))
}

export function shelfHas(path: string): boolean {
  const norm = path.replace(/[\\/]+$/, '')
  return load().some((e) => e.path === path || e.path.replace(/[\\/]+$/, '') === norm || e.path.toLowerCase() === norm.toLowerCase())
}

export function shelfAdd(entry: RepoShelfEntry): void {
  const list = load()
  const norm = entry.path.replace(/[\\/]+$/, '')
  const next = list.filter((e) => e.path !== entry.path && e.path.replace(/[\\/]+$/, '') !== norm && e.path.toLowerCase() !== norm.toLowerCase())
  next.push({ path: entry.path, ...(entry.title ? { title: entry.title } : {}) })
  cache = next
  persist()
}

/** 同一个条目（忽略尾部分隔符与大小写）在清单里的下标；没有则 -1。 */
function indexOfPath(list: RepoShelfEntry[], path: string): number {
  const norm = path.replace(/[\\/]+$/, '').toLowerCase()
  return list.findIndex((e) => e.path.toLowerCase() === norm)
}

/**
 * 文件活动**自动**收录：agent 正在改的仓库自己进货架。
 *
 * 与手动 shelfAdd 的区别：
 *   - 打上 `auto: true`（面板可以把它们标出来，也便于将来一键清理）
 *   - 自动条目有上限（AUTO_SHELF_MAX），超了淘汰**最旧的自动条目**；
 *     手动加过的一律不动
 *   - 已经存在的路径**不覆盖**：手动加过的不会因为这次自动收录被降级
 *
 * @returns 真的新增了才返回 true（重复路径返回 false）。
 */
export function shelfAddAuto(path: string, title?: string): boolean {
  const list = load()
  if (indexOfPath(list, path) >= 0) return false
  const next = [...list, { path, ...(title ? { title } : {}), auto: true, at: Date.now() }]
  const autos = next.filter((e) => e.auto === true).sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  while (autos.length > AUTO_SHELF_MAX) {
    const victim = autos.shift()
    if (victim === undefined) break
    const i = next.indexOf(victim)
    if (i >= 0) next.splice(i, 1)
  }
  cache = next
  persist()
  return true
}

export function shelfRemove(path: string): void {
  const norm = path.replace(/[\\/]+$/, '')
  cache = load().filter((e) => e.path !== path && e.path.replace(/[\\/]+$/, '') !== norm && e.path.toLowerCase() !== norm.toLowerCase())
  persist()
}
