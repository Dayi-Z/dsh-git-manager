/**
 * dsh-git-manager — browser entry: mounts the compass panel as a right-side frame
 * column (same technique as dsh-git-panel: find the shell frame grid, append a
 * track). All wiring failures log instead of throwing — a throw would abort
 * the whole boot.
 * @module dsh-git-manager/client
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitManagerApi } from './api.ts'
import { betterSidebarOf, registerSidebarTab } from './embed.tsx'
import { initI18n } from './i18n.ts'
import { StandaloneCard } from './shell.tsx'

/** 错误边界：渲染失败时把错误写到 DOM 标记，便于诊断（不弹白屏）。 */
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: String(error instanceof Error ? error.message : error) }
  }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    try { document.body.dataset.gitmErr = String(error) + ' | ' + info.componentStack } catch { /* noop */ }
  }
  render(): ReactNode {
    if (this.state.error) return createElement('div', { className: 'gm-panel gm-err' }, `dsh-git-manager render error: ${this.state.error}`)
    return this.props.children
  }
}

interface PanelClientContext {
  effect(fn: () => (() => void) | void, name: string): void
  inject(services: string[], fn: (scope: PanelClientContext) => void): void
  /** cordis 的服务查询（可选服务的运行时探测，见 embed.tsx）。 */
  get?(name: string): unknown
  sessions: {
    list: {
      getSnapshot(): { current?: string; byId: Record<string, { cwd?: string }> }
      subscribe(fn: () => void): () => void
    }
  }
  locale: {
    getLocale(): { active: string }
    subscribe(fn: () => void): () => void
  }
}

export const inject = ['sessions', 'locale']

const PANEL_DEFAULT_WIDTH = 360
const PANEL_MIN_WIDTH = 280
const PANEL_MAX_WIDTH = 460

let frameEl: HTMLElement | null = null

// ---------------------------------------------------------------------------
// 自愈：shell 文档无缓存头 → 浏览器启发式缓存可能让页面停留在旧 rev 的
// client.js 上（Ctrl+F5 对注入式模块无效）。定期以 no-store 取最新 shell，
// 比对 dsh-git-manager client.js 的 rev；不一致 → 整页重载一次。
// sessionStorage 记录"已为该 rev 重载过"，防止循环。
// ---------------------------------------------------------------------------

/** 插件浏览器半的 script URL 有两种形态（dsh-client-modules 的 comboUrl 与
 *  单条 form），而且两种都要认它们在 innerHTML 里的样子——属性值中的 `&` 会
 *  被序列化成 `&amp;`，所以 `rev=` 前面可能是 `&amp;` 而不是 `&`：
 *    a) 单条：`/plugins/??dsh-git-manager/client.js&rev=<rev>`
 *    b) 合并：`/plugins/??<id>,…,dsh-git-manager/client.js,…&rev=<rev>`
 *  历史实现只写了 `client.js?rev=`，上面两种一种都匹配不到，于是这个自愈
 *  从未生效过（改了面板仍要用户手动 Ctrl+F5）。优先取单条 form：合并 form 的
 *  rev 会因为**别的**插件重建而变化，拿它当基准会造成无关重载。 */
const REV_SELF_RE = /\/plugins\/\?\?dsh-git-manager\/client\.js[?&](?:amp;)?rev=([a-f0-9]+)/
const REV_BATCH_RE = /\/plugins\/\?\?[^"']*dsh-git-manager\/client\.js[^"']*[?&](?:amp;)?rev=([a-f0-9]+)/

function revOf(html: string): string {
  return REV_SELF_RE.exec(html)?.[1] ?? REV_BATCH_RE.exec(html)?.[1] ?? ''
}

function currentRev(): string {
  return revOf(document.documentElement.innerHTML)
}

function selfHeal(): void {
  const mine = currentRev()
  if (mine === '') return
  void fetch('/', { cache: 'no-store' })
    .then((r) => r.text())
    .then((html) => {
      const latest = revOf(html)
      if (latest === '' || latest === mine) return
      let reloadedFor = ''
      try { reloadedFor = sessionStorage.getItem('gm.selfheal-rev') ?? '' } catch { /* noop */ }
      if (reloadedFor === latest) return
      try { sessionStorage.setItem('gm.selfheal-rev', latest) } catch { /* noop */ }
      console.info(`dsh-git-manager: client rev ${mine} → ${latest}, reloading`)
      setTimeout(() => location.reload(), 800)
    })
    .catch(() => { /* 网络抖动：下个周期再试 */ })
}
setInterval(selfHeal, 60_000)
setTimeout(selfHeal, 4_000)

function loadPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem('gm.panelWidth'))
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return Math.round(stored)
  } catch { /* storage may be unavailable */ }
  return PANEL_DEFAULT_WIDTH
}

function findFrame(): HTMLElement | null {
  const stamped = document.querySelector<HTMLElement>('[data-dsh-frame]')
  if (stamped !== null) return stamped
  return document.querySelector<HTMLElement>('[class*="sidebarCol"]')?.parentElement ?? null
}

function parseTracks(input: string): string[] {
  const tracks: string[] = []
  let depth = 0
  let current = ''
  for (const char of input) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (char === ' ' && depth === 0) {
      if (current !== '') { tracks.push(current); current = '' }
      continue
    }
    current += char
  }
  if (current !== '') tracks.push(current)
  return tracks
}

function waitForFrame(onFrame: (frame: HTMLElement) => void): () => void {
  const found = findFrame()
  if (found !== null) { frameEl = found; onFrame(found); return () => {} }
  let raf = 0
  const started = performance.now()
  const poll = (): void => {
    const f = findFrame()
    if (f !== null) { frameEl = f; onFrame(f); return }
    if (performance.now() - started > 30_000) return
    raf = requestAnimationFrame(poll)
  }
  raf = requestAnimationFrame(poll)
  return () => cancelAnimationFrame(raf)
}

// ── 常驻右侧 Dock：所有右栏面板插件共用一条网格轨道，上下面板一上一下堆叠，
//    不再各自占一整列，也不再需要手动展开/收起 ──
const DOCK_WIDTH_KEY = 'dsh.dockWidth'
const DOCK_MIN_WIDTH = 300
const DOCK_MAX_WIDTH = 520
const DOCK_DEFAULT_WIDTH = 360

function dockWidth(): number {
  try {
    const stored = Number(localStorage.getItem(DOCK_WIDTH_KEY))
    if (Number.isFinite(stored) && stored >= DOCK_MIN_WIDTH && stored <= DOCK_MAX_WIDTH) return Math.round(stored)
  } catch { /* storage may be unavailable */ }
  return DOCK_DEFAULT_WIDTH
}
function setDockWidth(w: number): void {
  try { localStorage.setItem(DOCK_WIDTH_KEY, String(Math.round(Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, w))))) } catch { /* noop */ }
}

/** 网格轨道写入：按"流内子元素"重建整条轨道列表。
 *  frame 的 children 里混有绝对定位的 overlay/拖拽手柄（非网格项），且旧的幽灵轨道可能残留，
 *  因此不能按 children 下标或“补到 childCount”处理——否则 Dock 会被放到 0px 轨道上而不可见。
 *  规则：轨道数 = 流内子元素数；每个流内子元素保留当前轨道宽度，Dock 所在项写为 widthPx。 */
function setTrack(frame: HTMLElement, child: HTMLElement, widthPx: number): void {
  const inline = frame.style.gridTemplateColumns
  if (inline === '') return
  const cur = parseTracks(inline)
  const kids = Array.prototype.filter.call(frame.children, (c: HTMLElement) => {
    const p = getComputedStyle(c).position
    return p !== 'absolute' && p !== 'fixed'
  }) as HTMLElement[]
  const idx = kids.indexOf(child)
  const parts = kids.map((k: HTMLElement, i: number) => {
    if (i === idx) return `${widthPx}px`
    return i < cur.length && cur[i] !== '' ? cur[i] : '0px'
  })
  frame.style.gridTemplateColumns = parts.join(' ')
}

/** 在 frame 中取得（或创建）共享右栏 Dock。首个创建者负责挂左缘拖拽手柄。 */
function dockIn(frame: HTMLElement): { dock: HTMLElement; sync: () => void } {
  const existing = frame.querySelector<HTMLElement>('[data-dsh-dock]')
  if (existing !== null) {
    return {
      dock: existing,
      sync: (): void => setTrack(frame, existing, dockWidth()),
    }
  }
  const dock = document.createElement('div')
  dock.dataset.dshDock = ''
  dock.style.cssText = 'position:relative;height:100%;min-width:0;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));background:transparent;'
  frame.appendChild(dock)
  const grip = document.createElement('div')
  grip.dataset.dshDockGrip = ''
  grip.style.cssText = 'position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:20;'
  let w = dockWidth()
  const apply = (): void => setTrack(frame, dock, w)
  grip.addEventListener('pointerdown', (e: PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = w
    const onMove = (ev: PointerEvent): void => {
      w = Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, startW - (ev.clientX - startX)))
      apply()
    }
    const onUp = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      setDockWidth(w)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  })
  dock.appendChild(grip)
  apply()
  return { dock, sync: apply }
}

/** 往 Dock 里追加一张"面板卡"：多卡时 flex 上下平分高度，自动一上一下堆叠。 */
function dockCard(dock: HTMLElement): HTMLElement {
  const card = document.createElement('div')
  card.dataset.dshCard = ''
  const hasCards = dock.querySelectorAll<HTMLElement>('[data-dsh-card]').length > 0
  card.style.cssText = hasCards
    ? 'flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));'
    : 'flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:auto;'
  dock.appendChild(card)
  return card
}

export function apply(ctx: PanelClientContext): void {
  try {
    initI18n(ctx.locale)
  } catch (error) {
    console.error('dsh-git-manager: i18n init failed', error)
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    let root: Root | null = null

    const api = new GitManagerApi()
    const host = ctx as unknown as { sessions: PanelClientContext['sessions'] }
    let teardownDock: (() => void) | null = null

    const mount = (frame: HTMLElement): void => {
      if (teardownDock !== null) return
      // 加入共享右栏 Dock（无则创建），作为一张等高卡片一上一下堆叠。
      const { dock, sync } = dockIn(frame)
      const card = dockCard(dock)
      card.dataset.gitmCol = ''

      try {
        root = createRoot(card)
        root.render(createElement(Boundary, null, createElement(StandaloneCard, { card, api, sessions: host.sessions })))
      } catch (error) {
        try { document.body.dataset.gitmErr = String(error instanceof Error ? error.message : error) } catch { /* noop */ }
        console.error('dsh-git-manager: mount failed', error)
      }

      // 外壳重排 / 其他面板增删 → 保证 Dock 轨道存在且宽度正确（幂等）。
      const observer = new MutationObserver(() => sync())
      observer.observe(frame, { attributes: true, attributeFilter: ['style'], childList: true })
      sync()

      teardownDock = (): void => {
        observer.disconnect()
        root?.unmount()
        root = null
        card.remove()
        // Dock 已空：归零轨道后移除，并修剪尾部 0px 残留。
        if (dock.querySelector<HTMLElement>('[data-dsh-card]') === null) {
          setTrack(frame, dock, 0)
          dock.remove()
          const cur = parseTracks(frame.style.gridTemplateColumns)
          const over = cur.length - frame.children.length
          if (over > 0 && cur.slice(-over).every((t) => t === '0px')) {
            frame.style.gridTemplateColumns = cur.slice(0, cur.length - over).join(' ')
          }
        }
      }
      // 光有 rAF 取消是不够的：fiber 销毁（HMR 重载/卸载）必须连卡片和
      // React 根一起拆掉，否则页面上会留下孤儿面板。
      disposers.push(() => { teardownDock?.(); teardownDock = null })
    }

    // ── 宿主选择：better-sidebar 在场 ⇒ 做它的一个页签；不在场 ⇒ 自己撑右栏。
    //    better-sidebar 自己拥有右栏，两种形态同时存在就是两个面板抢一个位置。──
    let disposeTab: (() => void) | null = null
    const adoptSidebar = (service: ReturnType<typeof betterSidebarOf>): boolean => {
      if (service === null || disposeTab !== null) return false
      try {
        disposeTab = registerSidebarTab(service, { api, sessions: host.sessions })
        return true
      } catch (error) {
        disposeTab = null
        console.error('dsh-git-manager: better-sidebar tab registration failed; keeping the standalone dock', error)
        return false
      }
    }

    if (!adoptSidebar(betterSidebarOf(ctx))) {
      disposers.push(waitForFrame(mount))
      // better-sidebar 可能比本插件晚挂载：它一出现就换成页签形态并撤掉 Dock。
      try {
        ctx.inject(['betterSidebar'], (scope) => {
          if (!adoptSidebar(betterSidebarOf(scope))) return
          teardownDock?.()
          teardownDock = null
        })
      } catch { /* 无 inject 能力：只用启动时的探测结果 */ }
    }

    return () => {
      disposeTab?.()
      for (const d of disposers) d()
    }
  }, 'dsh-git-manager: panel host')
}
