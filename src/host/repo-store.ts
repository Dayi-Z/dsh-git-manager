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
}

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
          .map((r) => ({ path: r.path as string, ...(typeof r.title === 'string' ? { title: r.title } : {}) }))
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

export function shelfRemove(path: string): void {
  const norm = path.replace(/[\\/]+$/, '')
  cache = load().filter((e) => e.path !== path && e.path.replace(/[\\/]+$/, '') !== norm && e.path.toLowerCase() !== norm.toLowerCase())
  persist()
}
