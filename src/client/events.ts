/**
 * gitcompass — client-side SSE subscription to the host event bus.
 * Used by the Agent activity monitor to show live tool execution,
 * approval requests, and repository changes (including bash git).
 * @module gitcompass/client/events
 */

import { useEffect, useRef, useState } from 'react'

export interface GitEvent {
  id: string
  type: string
  timestamp: number
  data: Record<string, unknown>
}

/** Subscribe to the host event stream. Returns a capped, newest-last array. */
export function useGitEvents(limit = 100): GitEvent[] {
  const [events, setEvents] = useState<GitEvent[]>([])
  const sourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const source = new EventSource('/gitu/events')
    sourceRef.current = source

    source.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as GitEvent
        setEvents((prev) => {
          const next = [...prev, event]
          return next.length > limit ? next.slice(-limit) : next
        })
      } catch { /* ignore malformed */ }
    }
    source.onerror = () => { /* EventSource auto-reconnects */ }

    return () => { source.close(); sourceRef.current = null }
  }, [limit])

  return events
}
