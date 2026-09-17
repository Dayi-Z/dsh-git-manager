/**
 * dsh-git-manager — Event Bus: in-memory pub/sub for agent tool lifecycle events
 * and repository observation. Feeds the client-side activity monitor and
 * approval queue via SSE.
 *
 * Dual-channel capture:
 *   ① Tool wrappers emit start/completion/approval events directly
 *   ② Repo observer polls git log/status/branch to detect bash git commands
 *
 * @module dsh-git-manager/host/event-bus
 */

import type { Context } from '@deepseek-ai/cordis'

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface GitEvent {
  id: string
  type: EventType
  timestamp: number
  data: Record<string, unknown>
}

export type EventType =
  | 'tool:start'
  | 'tool:completed'
  | 'tool:error'
  | 'approval:requested'
  | 'approval:approved'
  | 'approval:rejected'
  | 'repo:commit-new'
  | 'repo:branch-change'
  | 'repo:status-change'
  | 'repo:remote-update'
  /** 文件活动把 agent 正在改的仓库自动收进了货架。 */
  | 'repo:auto-added'

/** Human-readable event summaries for the activity feed. */
function summarize(event: GitEvent): string {
  const d = event.data
  switch (event.type) {
    case 'tool:start':
      return `Agent running ${d.tool}${d.summary ? `: ${d.summary}` : ''}`
    case 'tool:completed':
      return `${d.tool} completed${d.summary ? `: ${d.summary}` : ''}`
    case 'tool:error':
      return `${d.tool} failed: ${d.error}`
    case 'approval:requested':
      return `⏳ Approval needed: ${d.summary ?? d.tool}`
    case 'approval:approved':
      return `✅ Approved: ${d.summary ?? d.tool}`
    case 'approval:rejected':
      return `❌ Rejected: ${d.summary ?? d.tool}`
    case 'repo:commit-new':
      return `New commit detected: ${d.message ?? d.sha}`
    case 'repo:branch-change':
      return `Branch: ${d.from} → ${d.to}`
    case 'repo:status-change':
      return `Working tree changed: ${d.detail ?? ''}`
    case 'repo:auto-added':
      return `Auto-registered ${d.workspace ?? d.path} (${d.via ?? 'file activity'})`
    default:
      return `${event.type}`
  }
}

// ---------------------------------------------------------------------------
// Pre-approval queue
// ---------------------------------------------------------------------------

/**
 * Pre-approval: the user clicks "approve" in the panel before the agent's
 * `requireApproval()` call. When the agent later requests approval for the
 * same tool, the modal dialog is skipped.
 *
 * Keys: `toolName` → set of approved callIds (or `'*'` for all).
 */
const preApprovals = new Map<string, Set<string>>()

/** Pre-approve a tool (optionally for a specific callId). */
export function preApprove(toolName: string, callId?: string): void {
  if (!preApprovals.has(toolName)) preApprovals.set(toolName, new Set())
  preApprovals.get(toolName)!.add(callId ?? '*')
}

/** Check if a tool call is pre-approved. */
export function checkPreApproval(toolName: string, callId?: string): boolean {
  const set = preApprovals.get(toolName)
  if (!set) return false
  return set.has('*') || (callId !== undefined && set.has(callId))
}

/** Revoke all pre-approvals (e.g. on panel reset). */
export function clearPreApprovals(): void {
  preApprovals.clear()
}

/** Current pre-approvals for UI display: `tool` when granted '*', else `tool#callId`. */
export function listPreApprovals(): string[] {
  const out: string[] = []
  for (const [tool, set] of preApprovals) for (const id of set) out.push(id === '*' ? tool : `${tool}#${id}`)
  return out.sort()
}

/** Revoke pre-approvals: one tool (all its callIds), or everything when omitted. */
export function revokePreApproval(tool?: string): void {
  if (tool === undefined || tool === '') preApprovals.clear()
  else preApprovals.delete(tool)
}

// ---------------------------------------------------------------------------
// Live panel approval broker
// ---------------------------------------------------------------------------

type ApprovalDecision = 'approved' | 'rejected'

interface PendingApproval {
  timer: ReturnType<typeof setTimeout>
  resolve: (decision: ApprovalDecision) => void
}

/**
 * Holds one outstanding panel decision for a live tool call. A decision is
 * one-shot; unredeemed requests expire after their timeout. Memory-only by
 * design — approvals are never persisted.
 */
export class PanelApprovalBroker {
  private pending = new Map<string, PendingApproval>()

  /** Register a live request and wait for a decision (null on timeout). */
  wait(callId: string, timeoutMs = 60_000): Promise<ApprovalDecision | null> {
    if (this.pending.has(callId)) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        resolve(null)
      }, timeoutMs)
      this.pending.set(callId, {
        timer,
        resolve: (decision) => {
          clearTimeout(timer)
          this.pending.delete(callId)
          resolve(decision)
        },
      })
    })
  }

  /** Resolve a live request; false when unknown/expired. */
  decide(callId: string, decision: ApprovalDecision): boolean {
    const pending = this.pending.get(callId)
    if (!pending) return false
    pending.resolve(decision)
    return true
  }
}

/** Singleton shared by tool wrappers and /gitm routes. */
export const panelApprovalBroker = new PanelApprovalBroker()

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export class EventBus {
  private listeners = new Map<string, Set<(event: GitEvent) => void>>()
  private history: GitEvent[] = []
  private counter = 0

  emit(type: EventType, data: Record<string, unknown>): GitEvent {
    const event: GitEvent = {
      id: `evt-${++this.counter}-${Date.now()}`,
      type,
      timestamp: Date.now(),
      data: { ...data, _summary: summarize({ id: '', type, timestamp: 0, data }) },
    }
    this.history.push(event)
    if (this.history.length > 500) this.history = this.history.slice(-300)

    for (const fn of this.listeners.get(type) ?? []) {
      try { fn(event) } catch { /* swallow */ }
    }
    for (const fn of this.listeners.get('*') ?? []) {
      try { fn(event) } catch { /* swallow */ }
    }
    return event
  }

  subscribe(type: string, fn: (event: GitEvent) => void): () => void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
    return () => { this.listeners.get(type)?.delete(fn) }
  }

  /** Recent events for initial SSE connection. */
  getHistory(limit = 100): GitEvent[] {
    return this.history.slice(-limit)
  }

  // Panel SSE connection tracking: `requireApproval` uses this to fail FAST
  // when no panel client is connected — with no panel open nothing can ever
  // decide an approval card, so waiting for the full 5-minute timeout would
  // just hang the agent's write tool with no feedback.
  private panelSse = new Set<symbol>()

  /** Register a live panel SSE connection; returns its unregister function. */
  markPanelConnected(): () => void {
    const token = Symbol('gitm-sse')
    this.panelSse.add(token)
    return () => { this.panelSse.delete(token) }
  }

  /** How many panel SSE clients are currently connected. */
  panelClientCount(): number { return this.panelSse.size }
}

// ---------------------------------------------------------------------------
// Repo observer: polls git log/status/branch to detect bash git commands
// ---------------------------------------------------------------------------

interface RepoState {
  commit: string
  branch: string
  statusHash: string
}

function hashStr(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h.toString(36)
}

function extractSubject(logLine: string): string {
  // first line of `git log --oneline -1` is "sha subject"
  const space = logLine.indexOf(' ')
  return space > 0 ? logLine.slice(space + 1).trim() : ''
}

async function runGitRaw(runner: { run(argv: readonly string[], cwd: string): Promise<{ exitCode: number | null; stdout: string }> }, argv: readonly string[], cwd: string): Promise<string> {
  const r = await runner.run(argv, cwd)
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

/**
 * Start the repo observer: polls registered workspaces every `intervalMs`
 * (default 5s) and emits events when new commits, branch changes, or
 * status changes are detected. This captures bash git commands that go
 * through any path (not just our tools).
 */
export function startRepoObserver(
  ctx: Context,
  eventBus: EventBus,
  intervalMs = 5_000,
): () => void {
  const states = new Map<string, RepoState>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let busy = false

  const poll = async (): Promise<void> => {
    if (stopped || busy) return
    busy = true
    try {
      const workspaces = ctx.workspaceRegistry.list()
    for (const ws of workspaces) {
      try {
        const cwd = ws.path
        // Quick check: is this a git repo?
        const head = await runGitRaw(runner(ctx), ['rev-parse', '--git-dir'], cwd)
        if (!head) continue

        const [commitLine, branch, statusOutput] = await Promise.all([
          runGitRaw(runner(ctx), ['log', '--oneline', '-1', '--format=%H %s'], cwd),
          runGitRaw(runner(ctx), ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd),
          runGitRaw(runner(ctx), ['status', '--porcelain'], cwd),
        ])

        const commit = commitLine.split(' ')[0] ?? ''
        const statusHash = hashStr(statusOutput)
        const prev = states.get(cwd)

        if (prev) {
          if (prev.commit && commit && prev.commit !== commit) {
            const subject = extractSubject(commitLine)
            eventBus.emit('repo:commit-new', {
              path: cwd,
              workspace: ws.title,
              sha: commit,
              message: subject,
              from: prev.commit,
            })
          }
          if (prev.branch && branch && prev.branch !== branch) {
            eventBus.emit('repo:branch-change', {
              path: cwd,
              workspace: ws.title,
              from: prev.branch,
              to: branch,
            })
          }
          if (prev.statusHash !== statusHash) {
            const added = statusOutput.split('\n').filter((l) => l.trim()).length
            eventBus.emit('repo:status-change', {
              path: cwd,
              workspace: ws.title,
              detail: added > 0 ? `${added} changed files` : 'clean',
            })
          }
        }

        states.set(cwd, { commit, branch, statusHash })
      } catch { /* skip workspace on error */ }
    }
    } finally {
      busy = false
      if (!stopped) timer = setTimeout(() => { void poll() }, intervalMs)
    }
  }

  // Initial poll after a short delay (let things settle)
  timer = setTimeout(() => { void poll() }, 2_000)

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/** Minimal git runner that uses the context's subprocess service. */
function runner(ctx: Context) {
  return {
    async run(argv: readonly string[], cwd: string) {
      const spec = {
        argv: ['git', ...argv],
        cwd,
        stdio: { stdin: 'ignore' as const, stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
        graceMs: 10_000,
      }
      const handle = (ctx as unknown as { subprocess: { spawn(s: unknown): { done: Promise<{ exitCode: number | null }>; collected: { stdout?: { readFrom(n: number): { text: string } } } } } }).subprocess.spawn(spec)
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      return { exitCode: outcome.exitCode, stdout }
    },
  }
}
