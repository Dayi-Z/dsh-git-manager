/**
 * gitcompass — client-side shared SSE subscription to the host event bus.
 * One EventSource per panel (module-level store) regardless of how many
 * components subscribe; used by the Agent activity monitor and the tab-bar
 * pending-approval badge.
 * @module gitcompass/client/events
 */

import { useSyncExternalStore } from 'react'

export interface GitEvent {
  id: string
  type: string
  timestamp: number
  data: Record<string, unknown>
}

type Listener = () => void

const MAX_EVENTS = 200

let store: GitEvent[] = []
const listeners = new Set<Listener>()
let source: EventSource | null = null
let refCount = 0

function ensureSource(): void {
  if (source !== null) return
  source = new EventSource('/gitu/events')
  source.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as GitEvent
      store = [...store, event].slice(-MAX_EVENTS)
      for (const l of listeners) l()
    } catch { /* ignore malformed */ }
  }
  source.onerror = () => { /* EventSource auto-reconnects */ }
}

function releaseSource(): void {
  if (refCount === 0 && source !== null) {
    source.close()
    source = null
    store = []
  }
}

function subscribe(listener: Listener): () => void {
  ensureSource()
  refCount++
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    refCount--
    releaseSource()
  }
}

function getSnapshot(): GitEvent[] {
  return store
}

/** Subscribe to the host event stream. Returns a capped, newest-last array. */
export function useGitEvents(limit = 100): GitEvent[] {
  const events = useSyncExternalStore(subscribe, getSnapshot)
  return events.length > limit ? events.slice(-limit) : events
}

/** 当前等待面板裁决的审批调用数（排除演示卡 preview-*；已 approved/rejected 的不计）。 */
export function pendingApprovalCount(events: GitEvent[]): number {
  const resolved = new Set<string>()
  for (const e of events) {
    const cid = e.data.callId as string | undefined
    if (!cid) continue
    if (e.type === 'approval:approved' || e.type === 'approval:rejected') resolved.add(cid)
  }
  const waiting = new Set<string>()
  for (const e of events) {
    const cid = e.data.callId as string | undefined
    if (e.type === 'approval:requested' && cid !== undefined && !cid.startsWith('preview-') && !resolved.has(cid)) waiting.add(cid)
  }
  return waiting.size
}
