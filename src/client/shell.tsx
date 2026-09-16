/**
 * The STANDALONE host: a collapsible card inside this plugin's own
 * right-column dock. Used only when dsh-better-sidebar is absent — when it is
 * present the panel is contributed as one of its tabs instead
 * (see client/embed.tsx), because then better-sidebar owns that column.
 *
 * The card is created imperatively by client/index.ts (it has to own the shell
 * grid track), so the collapse state writes straight back onto that element:
 * a collapsed card gives its height back to the dock and stops the polling,
 * leaving just the panel's own header strip as the affordance to reopen it.
 * @module dsh-git-manager/client/shell
 */

import { useEffect, useState } from 'react'
import { CompassPanel, setPanelActive, type CompassPanelProps } from './Panel.tsx'

const COLLAPSED_KEY = 'gm.collapsed'

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
}

function writeCollapsed(value: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0') } catch { /* noop */ }
}

/** 独立 Dock 卡片：收起时只留头部条，且不再轮询。 */
export function StandaloneCard({ card, api, sessions }: { card: HTMLElement } & Pick<CompassPanelProps, 'api' | 'sessions'>): JSX.Element {
  const [collapsed, setCollapsed] = useState(readCollapsed)

  useEffect(() => {
    // Dock 是 flex 列：收起 = 让出高度（flex-basis 0 + 不伸展）。
    card.style.flex = collapsed ? '0 0 auto' : '1 1 0'
    card.style.overflow = collapsed ? 'hidden' : 'auto'
    setPanelActive(!collapsed)
    return () => setPanelActive(true)
  }, [card, collapsed])

  const toggle = (): void => {
    setCollapsed((current) => {
      const next = !current
      writeCollapsed(next)
      return next
    })
  }

  return <CompassPanel api={api} sessions={sessions} collapsed={collapsed} onToggleCollapsed={toggle} />
}
