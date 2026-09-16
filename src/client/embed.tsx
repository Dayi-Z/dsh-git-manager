/**
 * dsh-git-manager — the OPTIONAL dsh-better-sidebar integration.
 *
 * better-sidebar publishes a client service as `ctx.betterSidebar` whose
 * `registerTab(descriptor)` contributes a sidebar page type. When that service
 * is present this plugin contributes its panel as a tab and does NOT mount its
 * own right-column dock — better-sidebar owns that column, so two surfaces
 * would be two panels fighting for one slot. When the service is absent the
 * entry falls back to the standalone collapsible dock (client/shell.tsx).
 *
 * That is the same soft-peer contract better-sidebar's own recommended-plugin
 * catalog documents for its tab plugins ("auto tab when present, standalone
 * surface when not" — see its plugins-tabs.ts entries for ego-browser and
 * dsh-flowglass).
 *
 * The service is described STRUCTURALLY here on purpose. better-sidebar is an
 * optional peer: importing its types would turn a soft integration into a hard
 * build dependency and break the build for everyone who does not have it.
 * @module dsh-git-manager/client/embed
 */

import { createElement, useEffect, type ReactNode } from 'react'
import type { GitManagerApi } from './api.ts'
import { CompassPanel, setPanelActive, type CompassPanelProps } from './Panel.tsx'
import { pendingApprovalCount, snapshotEvents, subscribeEvents } from './events.ts'
import { Icon } from './icons.tsx'
import { t } from './i18n.ts'

/** Tab ids are namespaced `<plugin>:<page>` (better-sidebar's own builtins are
 *  bare words: 'explorer', 'git', 'terminal'). The id is also the tab `type`. */
export const TAB_ID = 'dsh-git-manager:panel'

/** The session scope better-sidebar hands a tab (only the fields we read). */
export interface SidebarScope {
  sessionId?: string
  cwd?: string
}

/** The props better-sidebar passes to a registered tab component (subset). */
export interface SidebarTabProps {
  scope?: SidebarScope
  /** Active tab AND panel open. Hidden views are expected to pause. */
  visible?: boolean
}

/** The subset of better-sidebar's `TabDescriptor` this plugin fills in. */
export interface SidebarTabDescriptor {
  id: string
  title: string | (() => string)
  description?: string | (() => string)
  icon?: ReactNode | ((size: number) => ReactNode)
  order?: number
  /** Single-instance: opening focuses the existing tab instead of duplicating. */
  single?: boolean
  badge?: () => string | number | null | undefined
  component: (props: SidebarTabProps) => ReactNode
}

/** The slice of the better-sidebar client service this plugin uses. */
export interface BetterSidebarLike {
  registerTab(descriptor: SidebarTabDescriptor): () => void
  readonly version?: string
}

interface EmbedDeps {
  api: GitManagerApi
  sessions: CompassPanelProps['sessions']
}

/**
 * Resolve the better-sidebar client service off any cordis context, or null.
 * `ctx.get` is the documented runtime probe (better-sidebar's own client reads
 * its service the same way), and it is what lets this stay an OPTIONAL peer:
 * a missing service is an ordinary null, not a load failure.
 */
export function betterSidebarOf(ctx: unknown): BetterSidebarLike | null {
  try {
    const get = (ctx as { get?: (name: string) => unknown } | null | undefined)?.get
    if (typeof get !== 'function') return null
    const service = get.call(ctx, 'betterSidebar') as BetterSidebarLike | undefined | null
    if (service === undefined || service === null) return null
    return typeof service.registerTab === 'function' ? service : null
  } catch {
    return null
  }
}

/** 页签内容：与 Dock 形态同一份面板，只多告诉它"现在在不在屏幕上"。 */
function TabBody({ api, sessions, scope, visible }: EmbedDeps & SidebarTabProps): JSX.Element {
  useEffect(() => {
    setPanelActive(visible !== false)
    return () => setPanelActive(true)
  }, [visible])
  return <CompassPanel api={api} sessions={sessions} cwd={scope?.cwd} />
}

/** 把面板注册成 better-sidebar 的一个页签，返回注销函数。 */
export function registerSidebarTab(service: BetterSidebarLike, deps: EmbedDeps): () => void {
  // 常驻一条订阅：页签角标要在面板没挂载时也有数，而 SSE 连接是引用计数的
  // 共享连接（events.ts），所以这里只是不让它掉到 0。
  const keepAlive = subscribeEvents(() => {})
  const dispose = service.registerTab({
    id: TAB_ID,
    title: () => t('panel.title'),
    description: () => t('panel.desc'),
    icon: (size: number) => createElement(Icon, { name: 'commit', size }),
    order: 95,
    single: true,
    // 待批的写操作数直接顶到页签上——这是面板最需要被看见的状态。
    badge: () => {
      const pending = pendingApprovalCount(snapshotEvents())
      return pending > 0 ? pending : null
    },
    component: (props: SidebarTabProps) => createElement(TabBody, { ...deps, ...props }),
  })
  return () => { dispose(); keepAlive() }
}
