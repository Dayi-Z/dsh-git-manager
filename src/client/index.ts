/**
 * gitcompass — browser entry: mounts the compass panel as a right-side frame
 * column (same technique as dsh-git-panel: find the shell frame grid, append a
 * track). All wiring failures log instead of throwing — a throw would abort
 * the whole boot.
 * @module gitcompass/client
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GitcompassApi } from './api.ts'
import { initI18n } from './i18n.ts'
import { CompassPanel } from './Panel.tsx'

/** 错误边界：渲染失败时把错误写到 DOM 标记，便于诊断（不弹白屏）。 */
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: String(error instanceof Error ? error.message : error) }
  }
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    try { document.body.dataset.gitcompassErr = String(error) + ' | ' + info.componentStack } catch { /* noop */ }
  }
  render(): ReactNode {
    if (this.state.error) return createElement('div', { className: 'gitcompass-panel gc-err' }, `gitcompass render error: ${this.state.error}`)
    return this.props.children
  }
}

interface PanelClientContext {
  effect(fn: () => (() => void) | void, name: string): void
  inject(services: string[], fn: (scope: PanelClientContext) => void): void
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

const PANEL_WIDTH = 360

let frameEl: HTMLElement | null = null

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

export function apply(ctx: PanelClientContext): void {
  try {
    initI18n(ctx.locale)
  } catch (error) {
    console.error('gitcompass: i18n init failed', error)
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    let root: Root | null = null

    const mount = (frame: HTMLElement): void => {
      const column = document.createElement('div')
      column.dataset.gitcompassCol = ''
      column.style.minWidth = '0'
      column.style.display = 'flex'
      column.style.flexDirection = 'column'
      column.style.borderLeft = '1px solid var(--gitcompass-border, rgba(128,128,128,0.25))'
      column.style.overflow = 'auto'
      frame.appendChild(column)

      const applyGrid = (): void => {
        const inline = frame.style.gridTemplateColumns
        if (inline === '') return
        const tracks = parseTracks(inline)
        if (tracks.length === 3) {
          frame.style.gridTemplateColumns = `${tracks.join(' ')} ${PANEL_WIDTH}px`
        } else if (tracks.length > 3) {
          frame.style.gridTemplateColumns = `${tracks.slice(0, 3).join(' ')} ${PANEL_WIDTH}px`
        }
      }
      applyGrid()
      const observer = new MutationObserver(() => applyGrid())
      observer.observe(frame, { attributes: true, attributeFilter: ['style'] })

      const api = new GitcompassApi()
      const host = ctx as unknown as { sessions: PanelClientContext['sessions'] }
      try {
        root = createRoot(column)
        root.render(createElement(Boundary, null, createElement(CompassPanel, { api, sessions: host.sessions })))
      } catch (error) {
        try { document.body.dataset.gitcompassErr = String(error instanceof Error ? error.message : error) } catch { /* noop */ }
        console.error('gitcompass: mount failed', error)
      }

      disposers.push(() => {
        observer.disconnect()
        root?.unmount()
        column.remove()
        const inline = frame.style.gridTemplateColumns
        if (inline !== '' && parseTracks(inline).length === 4) {
          frame.style.gridTemplateColumns = parseTracks(inline).slice(0, 3).join(' ')
        }
      })
    }

    disposers.push(waitForFrame(mount))
    return () => { for (const d of disposers) d() }
  }, 'gitcompass: panel column')
}
