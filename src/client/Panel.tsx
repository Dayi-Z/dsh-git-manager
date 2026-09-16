/**
 * dsh-git-manager — main panel: repo picker, guided flow strip, and the
 * Branches / Changes / Graph / PRs / Issues / GitHub / Agent views.
 * The Agent view hosts the live activity monitor plus the file-level
 * approval cards (per-file tabs, full-file side-by-side compare).
 * @module dsh-git-manager/client/Panel
 */

import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  GitManagerApi,
  type BranchesView,
  type FlowSnapshot,
  type GitHubAuthState,
  type GraphView,
  type PullRequestSummary,
  type WorkspaceEntry,
  type OpResult,
  type RepoInfo,
  type PullRequestDetail,
  type IssueSummary,
  type IssueDetail,
} from './api.ts'
import { t, setLocaleOverride, getLocaleOverride } from './i18n.ts'
import { layoutGraph } from './graph.ts'
import { useGitEvents, pendingApprovalCount, type GitEvent } from './events.ts'
import { onOpFeedback, report, reportError, type OpFeedback } from './feedback.ts'
import { Icon, FileIcon, type IconName } from './icons.tsx'
import { css } from './styles.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 设置：轮询速度（localStorage 持久化；usePoll 读取缩放系数）
// ---------------------------------------------------------------------------

/** 构建标识：设置菜单页脚显示，一眼诊断浏览器端缓存滞后（与 package.json version 同步）。 */
const GM_VERSION = '2.0.0'

type PollSpeed = 'fast' | 'std' | 'slow'
const POLL_SCALE: Record<PollSpeed, number> = { fast: 0.5, std: 1, slow: 2 }
let pollSpeed: PollSpeed = (() => {
  try {
    const v = localStorage.getItem('gm.poll')
    if (v === 'fast' || v === 'std' || v === 'slow') return v
  } catch { /* no storage */ }
  return 'std'
})()
function getPollScale(): number { return POLL_SCALE[pollSpeed] }
function setPollSpeed(v: PollSpeed): void {
  pollSpeed = v
  try { localStorage.setItem('gm.poll', v) } catch { /* no storage */ }
}
function getPullRebase(): boolean {
  try { return localStorage.getItem('gm.pullRebase') === '1' } catch { return false }
}
function setPullRebaseFlag(v: boolean): void {
  try { localStorage.setItem('gm.pullRebase', v ? '1' : '0') } catch { /* no storage */ }
}

// ---------------------------------------------------------------------------
// 面板活跃态：宿主（独立 Dock 的收起态 / better-sidebar 页签的 visible）告诉
// 面板"现在没人在看"，usePoll 就停止发请求——收起的面板不该在后台一直打 git。
// 恢复活跃时广播事件，所有 usePoll 立刻补一次，而不是干等一个轮询周期。
// ---------------------------------------------------------------------------

const ACTIVE_EVENT = 'gm:active'
let panelActive = true

/** 由宿主调用（独立 Dock 的收起/展开、better-sidebar 页签的 visible）。 */
export function setPanelActive(active: boolean): void {
  if (panelActive === active) return
  panelActive = active
  if (active) {
    try { window.dispatchEvent(new Event(ACTIVE_EVENT)) } catch { /* noop */ }
  }
}

function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((x) => x + 1), [])
  // 面板重新可见 → 立刻补一次（bump tick 会重跑下面的 effect）。
  useEffect(() => {
    const onActive = (): void => setTick((x) => x + 1)
    window.addEventListener(ACTIVE_EVENT, onActive)
    return () => window.removeEventListener(ACTIVE_EVENT, onActive)
  }, [])
  useEffect(() => {
    let alive = true
    const run = async (): Promise<void> => {
      if (!panelActive) return
      try {
        const value = await fn()
        if (alive) { setData(value); setError(null) }
      } catch (e) {
        if (alive) setError(String(e instanceof Error ? e.message : e))
      }
    }
    void run()
    const timer = setInterval(run, Math.max(800, intervalMs * getPollScale()))
    return () => { alive = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, reload }
}

function actHelper(busy: string | null, setBusy: (v: string | null) => void, fn: () => Promise<unknown>, reload: () => void): Promise<void> {
  setBusy(busy)
  return fn().then(reload).catch((e) => reportError(t('op.failed'), e)).finally(() => setBusy(null))
}

// ---------------------------------------------------------------------------
// 操作反馈横幅：成功 8s 自动收起，失败常驻直到关闭；带结果卡可复制
// ---------------------------------------------------------------------------

function OpBanner(): JSX.Element | null {
  const [fb, setFb] = useState<OpFeedback | null>(null)
  useEffect(() => onOpFeedback(setFb), [])
  useEffect(() => {
    if (!fb || fb.kind !== 'ok') return
    const timer = setTimeout(() => setFb((cur) => (cur?.ts === fb.ts ? null : cur)), 8000)
    return () => clearTimeout(timer)
  }, [fb])
  if (!fb) return null
  return (
    <div className={`gm-banner ${fb.kind}`} role="status">
      <span className="gm-bic" style={{ display: 'inline-flex', marginTop: 1 }}><Icon name={fb.kind === 'ok' ? 'success' : 'alert'} size={15} /></span>
      <div className="gm-banner-body">
        <div className="t">{fb.title}</div>
        {fb.detail ? <pre className="d">{fb.detail}</pre> : null}
      </div>
      {fb.detail ? (
        <button className="gm-btn sm" title={t('common.copy')} onClick={() => { void navigator.clipboard?.writeText(fb.detail ?? '').catch(() => {}) }}><Icon name="copy" size={12} /></button>
      ) : null}
      <button className="gm-banner-x" title={t('common.close')} onClick={() => setFb(null)}><Icon name="x" size={11} /></button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flow strip
// ---------------------------------------------------------------------------

function FlowStrip({ flow }: { flow: FlowSnapshot | null }) {
  const order = ['branch', 'commit', 'push', 'pr', 'review', 'merge']
  const labels: Record<string, string> = { branch: 'flow.branch', commit: 'flow.commit', push: 'flow.push', pr: 'flow.pr', review: 'flow.review', merge: 'flow.merge' }
  if (!flow) return <div className="gm-flow"><span className="gm-muted">{t('common.loading')}</span></div>
  const stepMap = new Map(flow.steps.map((s) => [s.id, s]))
  return (
    <div className="gm-flow" title={`${flow.repo} · ${flow.current}${flow.ahead ? ` +${flow.ahead}` : ''}${flow.behind ? ` -${flow.behind}` : ''}${flow.prNumber ? ` PR #${flow.prNumber}` : ''}`}>
      {order.map((id, i) => {
        const s = stepMap.get(id)
        const cls = s?.phase === 2 ? 'done' : s?.phase === 1 ? 'active' : ''
        return (
          <Fragment key={id}>
            {i > 0 ? <span className="gm-arrow"><Icon name="chevron-right" size={10} /></span> : null}
            <span className={`gm-step ${cls}`}><span className="dot" />{t(labels[id])}</span>
          </Fragment>
        )
      })}
    </div>
  )
}

/** 空态：图标 + 标题。空态是状态陈述，不是终点。 */
function Empty({ icon, title }: { icon: IconName; title: string }): JSX.Element {
  return (
    <div className="gm-empty">
      <Icon className="gm-ic" name={icon} size={20} />
      <div className="t">{title}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Branches tab
// ---------------------------------------------------------------------------

/** ahead/behind 分叉条：红=落后，绿=领先。 */
function DivergeBar({ ahead, behind }: { ahead: number; behind: number }): JSX.Element {
  const total = Math.max(1, ahead + behind)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span className="gm-divbar" title={`+${ahead} -${behind}`}>
        <span className="behind" style={{ width: `${(behind / total) * 64}px` }} />
        <span className="ahead" style={{ width: `${(ahead / total) * 64}px` }} />
      </span>
      <span style={{ fontFamily: 'var(--gm-mono)', fontSize: 10 }}>
        {ahead > 0 ? `↑${ahead}` : ''}{behind > 0 ? ` ↓${behind}` : ''}
      </span>
    </span>
  )
}

/** GitHub 式分支行（切换器菜单内使用）。 */
interface BsRowProps { name: string; subject?: string; date?: string; current: boolean; onPick: () => void }

function BsRow({ name, subject, date, current, onPick }: BsRowProps): JSX.Element {
  return (
    <div className={`gm-bsrow${current ? ' on' : ''}`} onClick={onPick} title={`${name}\n${subject ?? ''}`}>
      <div className="n">
        {current ? <span className="cur"><Icon name="check" size={11} /></span> : null}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      </div>
      {subject ? (
        <div className="m">
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{subject}</span>
          {date ? <span>{date.slice(0, 10)}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function Branches({ api, path }: { api: GitManagerApi; path: string }): JSX.Element {
  const { data: branches, error, reload } = usePoll(() => api.branches(path), [path], 6000)
  const [busy, setBusy] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [filter, setFilter] = useState('')
  // 切换器与教学卡
  const [menuOpen, setMenuOpen] = useState(false)
  const [pickQuery, setPickQuery] = useState('')
  // 行点击展开操作区（无悬停依赖）
  const [expandedLocal, setExpandedLocal] = useState<string | null>(null)
  const [expandedRemote, setExpandedRemote] = useState<string | null>(null)
  // 标签：列表 + 创建（可注释）
  const { data: tags, reload: reloadTags } = usePoll(() => api.tags(path), [path], 15000)
  const [tagName, setTagName] = useState('')
  const [tagMsg, setTagMsg] = useState('')

  const doBranch = async (kind: string, fn: () => Promise<unknown>): Promise<void> => { setBusy(kind); try { await fn(); reload() } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(null) } }

  const matchFilter = useCallback((name: string): boolean =>
    filter.trim() === '' || name.toLowerCase().includes(filter.trim().toLowerCase()), [filter])

  const localList = branches?.local ?? []
  const remoteList = branches?.remote ?? []

  const defaultName = useMemo(() => {
    const names = localList.map((b) => b.name)
    for (const cand of ['main', 'master', 'trunk']) if (names.includes(cand)) return cand
    return names[0] ?? ''
  }, [localList])
  const pickMatch = useCallback((name: string): boolean =>
    pickQuery.trim() === '' || name.toLowerCase().includes(pickQuery.trim().toLowerCase()), [pickQuery])

  /** 切换器菜单。 */
  const switcherMenu = menuOpen && branches != null ? (
    <>
      {/* 背景遮罩：点击菜单外任意处关闭 */}
      <div className="gm-bsbackdrop" onClick={() => setMenuOpen(false)} />
      <div className="gm-bsmenu">
        <input className="gm-input" placeholder={t('branches.pickPlaceholder')} value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} autoFocus />
        {localList.filter((b) => pickMatch(b.name)).length === 0 && remoteList.filter((b) => pickMatch(b.name)).length === 0
          ? <Empty icon="git-branch" title={t('branches.noBranches')} />
          : null}
        {defaultName !== '' && pickMatch(defaultName) && localList.some((b) => b.name === defaultName) ? (
          <>
            <div className="gm-bssec">{t('branches.default')}</div>
            {localList.filter((b) => b.name === defaultName).map((b) => (
              <BsRow key={b.name} name={b.name} subject={b.subject} date={b.date} current={b.current} onPick={() => { setMenuOpen(false); setPickQuery('') }} />
            ))}
          </>
        ) : null}
        {localList.filter((b) => b.name !== defaultName && pickMatch(b.name)).length > 0 ? (
          <>
            <div className="gm-bssec">{t('branches.localAll')} ({localList.filter((b) => b.name !== defaultName).length})</div>
            {localList.filter((b) => b.name !== defaultName && pickMatch(b.name)).map((b) => (
              <BsRow key={b.name} name={b.name} subject={b.subject} date={b.date} current={b.current} onPick={() => {
                setMenuOpen(false); setPickQuery('')
                if (!b.current) void doBranch('switch', () => api.switchBranch(path, b.name))
              }} />
            ))}
          </>
        ) : null}
        {remoteList.filter((b) => pickMatch(b.name)).length > 0 ? (
          <>
            <div className="gm-bssec">{t('branches.remote')} ({remoteList.length})</div>
            {remoteList.filter((b) => pickMatch(b.name)).map((b) => (
              <BsRow key={b.name} name={b.name} subject={b.subject} date={b.date} current={false} onPick={() => {
                setMenuOpen(false); setPickQuery('')
                void doBranch('checkout', () => api.switchBranch(path, b.name))
              }} />
            ))}
          </>
        ) : null}
      </div>
    </>
  ) : null

  return (
    <div>
      {error && !branches ? <div className="gm-err">{error}</div> : null}

      {/* 当前分支胶囊：菜单锚定到整行宽度，不再被胶囊宽度挤成窄条 */}
      <div className="gm-bhead">
        <div className="gm-bswitch">
          <button className="gm-bpill" onClick={() => setMenuOpen(!menuOpen)}>
            <span className="dot" /><span className="nm">{branches ? branches.current : '…'}</span><span className="cv"><Icon name="chevron-down" size={11} /></span>
          </button>
          {switcherMenu}
        </div>
      </div>

      {/* 新建分支 */}
      <div className="gm-row" style={{ marginTop: 6 }}>
        <input className="gm-input" placeholder={t('branches.newPlaceholder')} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) doBranch('create', () => api.createBranch(path, newName.trim()).then(() => setNewName(''))) }} />
        <button className="gm-btn primary" disabled={!newName.trim() || busy !== null} onClick={() => doBranch('create', () => api.createBranch(path, newName.trim()).then(() => setNewName('')))}>{t('branches.create')}</button>
      </div>

      {branches ? (
        <>
          <div className="gm-section"><div className="head">{t('branches.local')} ({localList.length})</div></div>
          {localList.filter((b) => matchFilter(b.name)).map((b) => (
            <div className="gm-branch" key={b.name}>
              <div className="name-row" style={{ cursor: 'pointer' }} onClick={() => setExpandedLocal(expandedLocal === b.name ? null : b.name)}>
                <span className="name" title={`${b.name}\n${b.subject}\n${b.sha}`}>
                  {b.current ? <span className="gm-cur-mark" style={{ marginRight: 4 }}><Icon name="check" size={11} /></span> : null}{b.name}{b.current ? ` (${t('branches.current')})` : ''}
                  {b.upstream ? <span className="gm-muted" style={{ marginLeft: 4 }}>→ {b.upstream}</span> : null}
                </span>
                <span className="actions" style={{ pointerEvents: expandedLocal === b.name ? 'auto' : 'none', opacity: expandedLocal === b.name ? 1 : 0 }}>
                  {!b.current && <button className="gm-btn" disabled={busy !== null} onClick={() => doBranch('switch', () => api.switchBranch(path, b.name))}>{t('branches.switch')}</button>}
                  {!b.current && <button className="gm-btn" disabled={busy !== null} onClick={() => doBranch('merge', () => api.mergeBranch(path, b.name))}>{t('branches.merge')}</button>}
                  {renameTarget === b.name ? (
                    <span style={{ display: 'flex', gap: 2 }}>
                      <input className="gm-input" style={{ width: 100 }} value={renameVal} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && renameVal.trim()) doBranch('rename', () => api.renameBranch(path, b.name, renameVal.trim()).then(() => setRenameTarget(null))) }} autoFocus />
                      <button className="gm-btn" onClick={() => { setRenameTarget(null) }}>{t('actions.cancel')}</button>
                    </span>
                  ) : (
                    <button className="gm-btn" disabled={busy !== null || b.current} onClick={() => { setRenameTarget(b.name); setRenameVal(b.name) }}>{t('branches.rename')}</button>
                  )}
                  {!b.current && <button className="gm-btn danger" disabled={busy !== null} onClick={() => { if (confirm(`Delete branch ${b.name}?`)) doBranch('delete', () => api.deleteBranch(path, b.name)) }}>{t('branches.delete')}</button>}
                </span>
              </div>
              <div className="meta">
                {(b.ahead !== undefined || b.behind !== undefined) && <DivergeBar ahead={b.ahead ?? 0} behind={b.behind ?? 0} />}
                <span className="gm-muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.subject}</span>
                <span className="gm-muted" style={{ flex: 'none' }}>{b.date?.slice(0, 10)}</span>
              </div>
            </div>
          ))}
          {remoteList.length > 0 && (
            <>
              <div className="gm-section"><div className="head">{t('branches.remote')} ({remoteList.length})</div></div>
              {remoteList.filter((b) => matchFilter(b.name)).map((b) => (
                <div className="gm-branch" key={b.name}>
                  <div className="name-row" style={{ cursor: 'pointer' }} onClick={() => setExpandedRemote(expandedRemote === b.name ? null : b.name)}>
                    <span className="name" title={`${b.name}\n${b.subject}\n${b.sha}`}>{b.name}</span>
                    <span className="actions" style={{ pointerEvents: expandedRemote === b.name ? 'auto' : 'none', opacity: expandedRemote === b.name ? 1 : 0 }}>
                      <button className="gm-btn" disabled={busy !== null} onClick={() => doBranch('checkout', () => api.switchBranch(path, b.name))}>{t('branches.checkout')}</button>
                      <button className="gm-btn danger" disabled={busy !== null} onClick={() => { if (confirm(`Delete remote branch ${b.name}?`)) doBranch('deleteRemote', () => api.deleteRemoteBranch(path, b.name)) }}>{t('branches.delete')}</button>
                    </span>
                  </div>
                  <div className="meta">
                    <span className="gm-muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.subject}</span>
                    <span className="gm-muted" style={{ flex: 'none' }}>{b.date?.slice(0, 10)}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <div className="gm-empty">{t('common.loading')}</div>
      )}

      {/* 标签：教学向最小闭环（建/删/推） */}
      <div className="gm-section" style={{ marginTop: 10 }}><div className="head"><Icon name="tag" size={12} /> {t('tags.title')}（{tags?.length ?? 0}）</div></div>
      <div className="gm-row">
        <input className="gm-input" placeholder={t('tags.placeholder')} value={tagName} onChange={(e) => setTagName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tagName.trim()) void doBranch('tagCreate', () => api.tagCreate(path, tagName.trim(), tagMsg.trim() || undefined).then(() => { setTagName(''); setTagMsg('') })).then(reloadTags) }} />
        <input className="gm-input" style={{ width: 110, flex: 'none' }} placeholder={t('tags.msgPlaceholder')} value={tagMsg} onChange={(e) => setTagMsg(e.target.value)} />
        <button className="gm-btn" disabled={!tagName.trim() || busy !== null} onClick={() => void doBranch('tagCreate', () => api.tagCreate(path, tagName.trim(), tagMsg.trim() || undefined).then(() => { setTagName(''); setTagMsg('') })).then(reloadTags)}><Icon name="tag" size={12} />{t('tags.create')}</button>
      </div>
      {(tags ?? []).length === 0 ? <div className="gm-muted" style={{ padding: '2px 4px' }}>{t('tags.none')}</div> : null}
      {(tags ?? []).map((tag) => (
        <div key={tag.name} className="gm-row" style={{ padding: '1px 2px' }}>
          <span style={{ color: 'var(--gm-amber)', display: 'inline-flex', flex: 'none' }}><Icon name="tag" size={11} /></span>
          <span className="sub" title={tag.name}>{tag.name}</span>
          <span style={{ flex: 1 }} />
          {tag.date ? <span className="gm-muted" style={{ fontSize: 10 }}>{tag.date}</span> : null}
          <button className="gm-btn sm" disabled={busy !== null} title={t('changes.push')} onClick={() => doBranch('tagPush', () => api.tagPush(path, tag.name))}><Icon name="arrow-up" size={12} /></button>
          <button className="gm-btn sm" disabled={busy !== null} title={t('branches.delete')} onClick={() => doBranch('tagDelete', () => api.tagDelete(path, tag.name))}><Icon name="trash" size={12} /></button>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Changes tab
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 统一 diff 渲染：+/− 行红绿底、@@ hunk 头、文件元信息弱化
// ---------------------------------------------------------------------------

function DiffView({ patch, loading }: { patch: string; loading?: boolean }): JSX.Element {
  const lines = useMemo(() => patch.split('\n'), [patch])
  if (loading) return <div className="gm-diff">{t('common.loading')}</div>
  if (!patch) return <div className="gm-diff gm-muted">{t('diff.empty')}</div>
  return (
    <div className="gm-diff">
      {lines.map((l, i) => {
        let cls = ''
        if (l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ ')) cls = 'meta'
        else if (l.startsWith('@@')) cls = 'hunk'
        else if (l.startsWith('+')) cls = 'add'
        else if (l.startsWith('-')) cls = 'del'
        return <span key={i} className={`gm-dl ${cls}`}>{l === '' ? '\u00a0' : l}</span>
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 冲突横幅条：合并/变基进行中 → 逐文件 我方/对方 + 中止/继续变基
// ---------------------------------------------------------------------------

function ConflictStrip({ api, path }: { api: GitManagerApi; path: string }): JSX.Element | null {
  const { data, reload } = usePoll(() => api.conflictState(path), [path], 4000)
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try { await fn() } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false); reload() }
  }
  if (!data || (!data.merging && !data.rebasing && data.files.length === 0)) return null
  const kind: 'merge' | 'rebase' = data.rebasing ? 'rebase' : 'merge'
  return (
    <div className="gm-conflict">
      <div className="gm-conflict-head">
        <Icon name="alert" size={13} />
        <span className="t">{data.rebasing ? t('conflict.rebasing') : t('conflict.merging')}</span>
        <span className="gm-muted">{data.files.length > 0 ? `${data.files.length} ${t('conflict.files')}` : t('conflict.none')}</span>
        <span style={{ flex: 1 }} />
        {data.rebasing && data.files.length === 0 && (
          <button className="gm-btn primary" disabled={busy} onClick={() => void act(() => api.continueRebase(path))}>{t('conflict.continue')}</button>
        )}
        <button className="gm-btn danger" disabled={busy} onClick={() => void act(() => api.abortConflict(path, kind).then((r) => report('ok', t('op.aborted'), (r as { output?: string }).output)))}>{t('conflict.abort')}</button>
      </div>
      {data.files.map((f) => (
        <div key={f.file} className="gm-row" style={{ padding: '1px 2px' }}>
          <span className="gm-file" title={f.file}>{f.file.split('/').pop()}</span>
          <span className="gm-path">{f.file.split('/').slice(0, -1).join('/')}</span>
          <span className="gm-st mod" style={{ opacity: 0.9 }}>{f.code}</span>
          <span style={{ flex: 1 }} />
          <button className="gm-btn" disabled={busy} onClick={() => void act(() => api.resolveConflict(path, f.file, 'ours').then((r) => report('ok', t('op.resolved'), (r as { output?: string }).output)))}>{t('conflict.ours')}</button>
          <button className="gm-btn" disabled={busy} onClick={() => void act(() => api.resolveConflict(path, f.file, 'theirs').then((r) => report('ok', t('op.resolved'), (r as { output?: string }).output)))}>{t('conflict.theirs')}</button>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Changes tab — Trae 式源代码管理：提交框置顶 / 状态字母 / 树视图 / 传出的更改
// ---------------------------------------------------------------------------

type StatusRow = { file: string; x: string; y: string; untracked: boolean; newPath: string }

type DirNode = { name: string; path: string; dirs: Map<string, DirNode>; files: Array<{ name: string; row: StatusRow }> }

function buildFileTree(rows: StatusRow[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const row of rows) {
    const parts = row.newPath.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      let child = node.dirs.get(seg)
      if (!child) {
        child = { name: seg, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] }
        node.dirs.set(seg, child)
      }
      node = child
    }
    node.files.push({ name: parts[parts.length - 1], row })
  }
  return root
}

function stLetter(row: StatusRow, group: 'staged' | 'changes'): string {
  if (row.untracked) return 'U'
  const code = group === 'staged' ? row.x : row.y
  return code === ' ' ? 'M' : code === '?' ? 'U' : code
}

function stClass(letter: string): string {
  switch (letter) {
    case 'A': case 'C': return 'gm-st add'
    case 'M': case 'T': return 'gm-st mod'
    case 'D': return 'gm-st del'
    case 'R': return 'gm-st ren'
    default: return 'gm-st'
  }
}

function ChangeRowTree(props: {
  node: DirNode; depth: number; expanded: Set<string>; toggle: (p: string) => void
  renderFile: (row: StatusRow) => JSX.Element
}): JSX.Element {
  const { node, depth, expanded, toggle, renderFile } = props
  return (
    <>
      {[...node.dirs.values()].map((d) => {
        const open = expanded.has(d.path)
        const count = (() => { let n = d.files.length; for (const v of d.dirs.values()) n += 1; return n })()
        return (
          <div key={d.path}>
            <div className="gm-folder" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => toggle(d.path)}>
              <span className="gm-caret">{open ? <Icon name="chevron-down" size={10} /> : <Icon name="chevron-right" size={10} />}</span>
              <Icon name="folder" size={13} className="gm-fic" />
              <span>{d.name}</span>
              <span className="gm-muted" style={{ fontSize: 10 }}>{count}</span>
            </div>
            {open ? <ChangeRowTree node={d} depth={depth + 1} expanded={expanded} toggle={toggle} renderFile={renderFile} /> : null}
          </div>
        )
      })}
      {node.files.map((f) => <div key={f.row.file} style={{ paddingLeft: 4 + depth * 14 }}>{renderFile(f.row)}</div>)}
    </>
  )
}

function Changes({ api, path, flow }: { api: GitManagerApi; path: string; flow: { ahead?: number } | null }): JSX.Element {
  const { data, error, reload } = usePoll(() => api.status(path), [path], 4000)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [diffFile, setDiffFile] = useState<string | null>(null)
  const [diffData, setDiffData] = useState<string>('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffFailed, setDiffFailed] = useState(false)
  const [treeView, setTreeView] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const { data: outgoing } = usePoll(() => api.outgoing(path), [path], 10000)
  // P0/P1：变基拉取开关（持久化）+ 贮藏库展开
  const [stashOpen, setStashOpen] = useState(false)
  const { data: stashData, reload: reloadStash } = usePoll(() => api.stashList(path), [path, stashOpen], stashOpen ? 8000 : 60000)
  const stashRows = useMemo(() => {
    if (!stashData || !stashData.ok) return []
    return (stashData.output ?? '').split('\n').filter((l) => l.trim() !== '').map((l) => {
      const i = l.indexOf(': ')
      return { ref: i === -1 ? l.trim() : l.slice(0, i), subject: i === -1 ? '' : l.slice(i + 2) }
    })
  }, [stashData])
  // 传出的更改：行内下钻（提交 → 变更文件 → 补丁），教学向"字符可打开"
  const [outOpenSha, setOutOpenSha] = useState<string | null>(null)
  const [outFiles, setOutFiles] = useState<Array<{ path: string; additions: number | null; deletions: number | null }>>([])
  const [outFile, setOutFile] = useState<string | null>(null)
  const [outPatch, setOutPatch] = useState('')
  const [outPatchLoading, setOutPatchLoading] = useState(false)
  const [outDrillLoading, setOutDrillLoading] = useState(false)
  const toggleOut = async (sha: string): Promise<void> => {
    if (outOpenSha === sha) { setOutOpenSha(null); setOutFile(null); setOutPatch(''); return }
    setOutOpenSha(sha); setOutFile(null); setOutPatch(''); setOutDrillLoading(true)
    try { const r = await api.commitFiles(path, sha); setOutFiles(r.files) } catch { setOutFiles([]) } finally { setOutDrillLoading(false) }
  }
  const openOutPatch = async (sha: string, file: string): Promise<void> => {
    if (outFile === file) { setOutFile(null); setOutPatch(''); return }
    setOutFile(file); setOutPatch(''); setOutPatchLoading(true)
    try { const r = await api.commitPatch(path, sha, file); setOutPatch(r.patch) } catch { setOutPatch('') } finally { setOutPatchLoading(false) }
  }

  const act = async (kind: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(kind)
    try {
      const r = await fn() as { output?: unknown } | undefined
      reload()
      const okKey = OK_TITLES[kind]
      if (okKey) {
        const detail = r && typeof r === 'object' && 'output' in r && typeof r.output === 'string' && r.output.trim() !== '' ? r.output : undefined
        report('ok', t(okKey), detail)
      }
    } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(null) }
  }

  const showDiff = async (file: string): Promise<void> => {
    if (diffFile === file) { setDiffFile(null); return }
    setDiffFile(file); setDiffLoading(true); setDiffFailed(false)
    try {
      const r = await api.diff(path, file)
      setDiffData(r.ok ? r.output : '')
      if (!r.ok) setDiffFailed(true)
    } catch { setDiffData(''); setDiffFailed(true) } finally { setDiffLoading(false) }
  }

  const toggleDir = (p: string): void => setExpanded((prev) => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n })

  const lines = useMemo(() => (data?.output ?? '').split('\n').filter((l) => l.trim() !== ''), [data])
  const rows = useMemo<StatusRow[]>(() => lines.map((l) => {
    const code = l.slice(0, 2)
    const file = l.slice(3)
    const i = file.indexOf(' -> ')
    return { file, x: code[0] ?? ' ', y: code[1] ?? ' ', untracked: code === '??', newPath: i === -1 ? file : file.slice(i + 4) }
  }), [lines])
  // 分组遵循 Trae：已暂存 / 更改（未暂存 + 未跟踪合并；未跟踪状态字母显示 U）
  const staged = useMemo(() => rows.filter((r) => !r.untracked && r.x !== ' ' && r.x !== '?'), [rows])
  const changes = useMemo(() => rows.filter((r) => r.untracked || (r.y !== ' ' && r.y !== '?')), [rows])
  const groups: Array<{ key: string; label: string; rows: StatusRow[]; kind: 'staged' | 'changes' }> = [
    { key: 'staged', label: t('changes.staged'), rows: staged, kind: 'staged' },
    { key: 'changes', label: t('changes.changesGroup'), rows: changes, kind: 'changes' },
  ]
  // 树构建必须在顶层（hooks 不能出现在条件渲染/循环里）
  const stagedTree = useMemo(() => buildFileTree(staged), [staged])
  const changesTree = useMemo(() => buildFileTree(changes), [changes])
  const treeOf = (kind: 'staged' | 'changes'): DirNode => (kind === 'staged' ? stagedTree : changesTree)

  const renderRow = (kind: 'staged' | 'changes') => (row: StatusRow): JSX.Element => {
    const letter = stLetter(row, kind)
    const dir = row.newPath.lastIndexOf('/') === -1 ? '' : row.newPath.slice(0, row.newPath.lastIndexOf('/'))
    return (
      <div>
        <div className="gm-filerow" onClick={() => { void showDiff(row.file) }}>
          <FileIcon name={row.newPath.split('/').pop() ?? row.newPath} />
          <span className="gm-file" style={{ cursor: 'pointer', fontWeight: 500 }} title={row.file}>{row.newPath.split('/').pop()}</span>
          {dir !== '' ? <span className="gm-path">{dir}</span> : null}
          <span style={{ flex: 1 }} />
          <span className="actions" style={{ display: 'flex', gap: 2, opacity: 0, transition: 'opacity .15s' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0' }}>
            {kind === 'staged' ? (
              <button className="gm-btn sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); act('unstage', () => api.unstage(path, row.file)) }} title={t('actions.unstage')}><Icon name="minus" size={13} /></button>
            ) : (
              <>
                <button className="gm-btn sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); act('stage', () => api.stage(path, row.file)) }} title={t('actions.stage')}><Icon name="plus" size={13} /></button>
                <button className="gm-btn sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); if (confirm(t('changes.confirmDiscard'))) void act('discard', () => api.discard(path, row.file)) }} title={t('actions.discard')}><Icon name="undo" size={13} /></button>
                {row.untracked && <button className="gm-btn sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); void act('ignore', () => api.gitignoreAdd(path, row.file)) }} title={t('gitignore.add')}><Icon name="ban" size={13} /></button>}
              </>
            )}
          </span>
          <span className={stClass(letter)}>{letter}</span>
        </div>
        {diffFile === row.file && (
          diffFailed
            ? <div className="gm-trunc-note">{t('diff.failed')}</div>
            : <DiffView patch={diffLoading ? '' : diffData} loading={diffLoading} />
        )}
      </div>
    )
  }

  const doCommit = (): void => { if (message.trim()) void act('commit', () => api.commit(path, message)).then(() => setMessage('')) }

  const outCommits = outgoing?.commits ?? []

  return (
    <div>
      <div className="gm-commitbox">
        <input className="gm-input" value={message} onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit() }}
          placeholder={t('changes.commitPlaceholder')} />
        <button className="gm-btn primary" onClick={doCommit} disabled={busy !== null || !message.trim()}>{t('changes.commit')}</button>
        <button className="gm-btn sm" disabled={busy !== null} title={`${t('undo.commit')} — ${t('op.undone')}`} onClick={() => void act('undo', () => api.undoCommit(path))}><Icon name="clock-reverse" size={13} /></button>
        <button className="gm-btn sm" disabled={busy !== null} title={t('amend.last')} onClick={() => void act('amend', () => api.amend(path))}><Icon name="commit" size={13} /></button>
      </div>
      <div className="gm-changes-bar">
        <button className="gm-btn sm" onClick={() => setTreeView(!treeView)} title={treeView ? t('changes.flat') : t('changes.tree')}>
          <Icon name={treeView ? 'list' : 'folder-tree'} size={13} />
        </button>
        <button className="gm-btn" onClick={() => act('stage', () => api.stageAll(path))} disabled={busy !== null}><Icon name="plus" size={11} />{t('changes.stageAll')}</button>
        <span className="sep" />
        <button className="gm-btn sm" onClick={() => act('fetch', () => api.fetch(path))} disabled={busy !== null} title={t('changes.fetch')}><Icon name="sync" size={14} /></button>
        <button className="gm-btn sm" onClick={() => act('pull', () => api.pull(path, getPullRebase()))} disabled={busy !== null} title={getPullRebase() ? t('pull.rebase') : t('changes.pull')}>
          <Icon name="arrow-down" size={14} />
        </button>
        <button className="gm-btn" onClick={() => act('push', () => api.push(path))} disabled={busy !== null}><Icon name="arrow-up" size={11} />{t('changes.push')}{(flow?.ahead ?? 0) > 0 ? ` ${flow?.ahead}` : ''}</button>
        <span className="sep" />
        <button className="gm-btn sm" disabled={busy !== null} onClick={() => act('stash', () => api.stashPush(path))} title={t('stash.push')}><Icon name="archive" size={14} /></button>
        <button className="gm-btn sm" disabled={busy !== null || stashRows.length === 0} title={t('stash.pop')} onClick={() => void act('stash', () => api.stashPop(path)).then(reloadStash)}><Icon name="undo" size={13} /></button>
        <button className={`gm-btn sm${stashOpen ? ' primary' : ''}`} onClick={() => setStashOpen(!stashOpen)} title={t('stash.list')}>
          <Icon name="archive" size={13} />{stashRows.length > 0 ? <span style={{ fontSize: 10 }}>{stashRows.length}</span> : null}
        </button>
      </div>
      {stashOpen && stashRows.length > 0 ? (
        <div className="gm-stashlist">
          {stashRows.map((s) => (
            <div key={s.ref} className="gm-row" style={{ padding: '1px 2px' }}>
              <span className="sha">{s.ref}</span>
              <span className="sub" title={s.subject}>{s.subject}</span>
              <span style={{ flex: 1 }} />
              <button className="gm-btn sm" disabled={busy !== null} title={t('stash.apply')} onClick={() => void act('stashApply', () => api.stashAction(path, 'apply', s.ref)).then(reloadStash)}><Icon name="check" size={12} /></button>
              <button className="gm-btn sm" disabled={busy !== null} title={t('stash.drop')} onClick={() => { if (confirm(t('stash.dropConfirm'))) void act('stashDrop', () => api.stashAction(path, 'drop', s.ref)).then(reloadStash) }}><Icon name="trash" size={12} /></button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <div className="gm-err">{error}</div> : null}
      {groups.map(({ key, label, rows: groupRows, kind }) => {
        if (!groupRows.length) return null
        return (
          <div key={key}>
            <div className="gm-muted" style={{ marginTop: 6 }}>{label}（{groupRows.length}）</div>
            {treeView
              ? <ChangeRowTree node={treeOf(kind)} depth={0} expanded={expanded} toggle={toggleDir} renderFile={renderRow(kind)} />
              : groupRows.map(renderRow(kind))}
          </div>
        )
      })}
      {lines.length === 0 && outCommits.length === 0 ? <Empty icon="check" title={t('changes.clean')} /> : null}
      {outCommits.length > 0 ? (
        <div className="gm-outsec">
          <div className="gm-outsec-head">
            <Icon name="arrow-up" size={12} />
            <span className="t">{t('changes.outgoing')}</span>
            <span className="gm-chip green">{outCommits.length}</span>
            <span style={{ flex: 1 }} />
            <button className="gm-btn primary" disabled={busy !== null} onClick={() => act('push', () => api.push(path))}>
              <Icon name="arrow-up" size={11} />{t('changes.push')} ↑{outCommits.length}
            </button>
            <button className="gm-btn" disabled={busy !== null} title={t('changes.pushApiHint')} onClick={() => act('apipush', () => api.apiPush(path))}>
              <Icon name="globe" size={11} />{t('changes.pushApi')}
            </button>
          </div>
          <div className="gm-outsec-explain">{t('outgoing.explain')}</div>
          {outCommits.map((c) => (
            <div key={c.sha}>
              <div
                className={`gm-outrow${outOpenSha === c.sha ? ' on' : ''}`}
                title={`${c.author ?? ''}${c.author ? ' · ' : ''}${c.date ? c.date.slice(0, 10) : ''}\n${c.subject}\n${t('outgoing.rowHint')}`}
                onClick={() => { void toggleOut(c.sha) }}
              >
                <span className="caret"><Icon name={outOpenSha === c.sha ? 'chevron-down' : 'chevron-right'} size={10} /></span>
                <span className="sha">{c.sha}</span>
                <span className="sub">{c.subject}</span>
                <span className="gm-muted who">{c.author}</span>
              </div>
              {outOpenSha === c.sha ? (
                <div className="gm-outdrill">
                  {outDrillLoading ? <div className="gm-muted" style={{ fontSize: 11 }}>{t('common.loading')}</div> : null}
                  {!outDrillLoading && outFiles.length === 0 ? <div className="gm-muted" style={{ fontSize: 11 }}>{t('outgoing.noFiles')}</div> : null}
                  {outFiles.map((f) => (
                    <div key={f.path}>
                      <div className="gm-row" style={{ padding: '1px 0' }}>
                        <span className="gm-file" style={{ cursor: 'pointer', fontSize: 11 }} title={f.path} onClick={() => { void openOutPatch(c.sha, f.path) }}>{f.path.split('/').pop()}</span>
                        <span className="gm-path">{f.path.split('/').slice(0, -1).join('/')}</span>
                        <span style={{ flex: 1 }} />
                        {f.additions !== null ? <span className="gm-numstat">+{f.additions}</span> : null}
                        {f.deletions !== null ? <span className="gm-numstat del">−{f.deletions}</span> : null}
                      </div>
                      {outFile === f.path ? <DiffView patch={outPatch} loading={outPatchLoading} /> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Graph tab
// ---------------------------------------------------------------------------

function Graph({ api, path }: { api: GitManagerApi; path: string }): JSX.Element {
  const { data } = usePoll<GraphView>(() => api.graph(path), [path], 8000)
  const [busySha, setBusySha] = useState<string | null>(null)
  // P1：历史过滤（作者 / 提交信息，大小写不敏感子串；纯客户端）
  const [query, setQuery] = useState('')
  const ql = query.trim().toLowerCase()

  const layoutAll = useMemo(() => data ? layoutGraph(data.commits) : [], [data])
  const layout = useMemo(() => ql === '' ? layoutAll : layoutAll.filter((c) => c.subject.toLowerCase().includes(ql) || c.author.toLowerCase().includes(ql)), [layoutAll, ql])

  const doOp = async (sha: string, fn: () => Promise<unknown>, okKey?: string): Promise<void> => {
    setBusySha(sha)
    try {
      const r = await fn() as { output?: unknown } | undefined
      if (okKey) {
        const detail = r && typeof r === 'object' && 'output' in r && typeof r.output === 'string' && r.output.trim() !== '' ? r.output : undefined
        report('ok', t(okKey), detail)
      }
    } catch (e) { reportError(t('op.failed'), e) } finally { setBusySha(null) }
  }

  // 三层下钻：提交 → 该提交变更文件 → 单文件补丁
  const [openSha, setOpenSha] = useState<string | null>(null)
  const [openFiles, setOpenFiles] = useState<Array<{ path: string; additions: number | null; deletions: number | null }>>([])
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [patch, setPatch] = useState<string>('')
  const [patchLoading, setPatchLoading] = useState(false)
  const [drillLoading, setDrillLoading] = useState(false)

  const toggleSha = async (sha: string): Promise<void> => {
    if (openSha === sha) { setOpenSha(null); setOpenFile(null); setPatch(''); return }
    setOpenSha(sha); setOpenFile(null); setPatch(''); setDrillLoading(true)
    try { const r = await api.commitFiles(path, sha); setOpenFiles(r.files) } catch { setOpenFiles([]) } finally { setDrillLoading(false) }
  }
  const openPatch = async (sha: string, file: string): Promise<void> => {
    if (openFile === file) { setOpenFile(null); setPatch(''); return }
    setOpenFile(file); setPatch(''); setPatchLoading(true)
    try { const r = await api.commitPatch(path, sha, file); setPatch(r.patch) } catch { setPatch('') } finally { setPatchLoading(false) }
  }

  if (!data) return <div className="gm-empty">{t('common.loading')}</div>

  // 图谱泳道色不是自有调色板：它是从宿主状态令牌算出来的色轮（styles.ts）。
  const laneColors = Array.from({ length: 8 }, (_, i) => `var(--gm-lane-${i + 1})`)
  const maxLane = layout.reduce((m, c) => Math.max(m, c.lane), 0)

  return (
    <div>
      <div className="gm-row">
        <input className="gm-input" placeholder={t('graph.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query !== '' ? <span className="gm-muted" style={{ flex: 'none' }}>{layout.length}</span> : null}
      </div>
      {layout.map((c) => (
        <div key={c.sha}>
          <div className="gm-commit">
            <span className="gm-lane" title={`lane ${c.lane}`}>
              {Array.from({ length: maxLane + 1 }, (_, i) => (
                <span key={i} className="gm-lane-line" style={{ backgroundColor: i === c.lane ? laneColors[c.lane % laneColors.length] : 'transparent', marginRight: i < maxLane ? 2 : 0 }} />
              ))}
            </span>
            <span className="sha" style={{ cursor: 'pointer' }} title={`${c.sha}\n${c.author} ${c.date}`} onClick={() => { void toggleSha(c.sha) }}>{c.sha.slice(0, 7)}</span>
            <span className="sub" style={{ cursor: 'pointer' }} onClick={() => { void toggleSha(c.sha) }}>{c.subject}</span>
            {openSha === c.sha ? <span className="gm-caret"><Icon name="chevron-down" size={10} /></span> : null}
            {c.prNumber ? <span className="gm-chip green">PR #{c.prNumber}</span> : null}
            <span className="gm-muted" style={{ fontSize: 10 }}>{c.author}</span>
            <span className="actions" style={{ display: 'flex', gap: 2, opacity: 0, transition: 'opacity .15s' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0' }}>
              <button className="gm-btn sm" disabled={busySha !== null} onClick={() => doOp(c.sha, () => api.cherryPick(path, c.sha), 'op.cherryPicked')} title={t('graph.cherryPick')}><Icon name="commit" size={12} /></button>
              <button className="gm-btn sm" disabled={busySha !== null} onClick={() => doOp(c.sha, () => api.revertCommit(path, c.sha), 'op.reverted')} title={t('graph.revert')}><Icon name="clock-reverse" size={12} /></button>
            </span>
          </div>
          {openSha === c.sha ? (
            <div className="gm-drill" style={{ margin: '2px 0 6px 18px', borderLeft: '2px solid var(--gm-border)', paddingLeft: 8 }}>
              {drillLoading ? <div className="gm-muted" style={{ fontSize: 11 }}>{t('common.loading')}</div> : null}
              {!drillLoading && openFiles.length === 0 ? <div className="gm-muted" style={{ fontSize: 11 }}>{t('graph.noFiles')}</div> : null}
              {openFiles.map((f) => (
                <div key={f.path}>
                  <div className="gm-row" style={{ padding: '1px 0' }}>
                    <span className="gm-file" style={{ cursor: 'pointer', fontSize: 11 }} title={f.path} onClick={() => { void openPatch(c.sha, f.path) }}>{f.path.split('/').pop()}</span>
                    <span style={{ flex: 1 }} />
                    {f.additions !== null ? <span className="gm-numstat">+{f.additions}</span> : null}
                    {f.deletions !== null ? <span className="gm-numstat del">−{f.deletions}</span> : null}
                  </div>
                  {openFile === f.path ? <DiffView patch={patch} loading={patchLoading} /> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Issues tab
// ---------------------------------------------------------------------------

function Issues({ api, repoInfo, auth }: { api: GitManagerApi; repoInfo: RepoInfo | null; auth: GitHubAuthState | null }): JSX.Element {
  const { data: issues, reload } = usePoll<IssueSummary[]>(
    () => (repoInfo ? api.listIssues(repoInfo.owner, repoInfo.repo, 'open') : Promise.resolve([])),
    [repoInfo?.owner, repoInfo?.repo],
    10000,
  )
  // 未连接的两种原因：账号已连但 origin 不是 GitHub / 账号本身未连接。
  if (!repoInfo) return <Empty icon="globe" title={auth?.connected ? t('github.originIssue') : t('github.notConnected')} />
  const [detail, setDetail] = useState<IssueDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ title: '', body: '' })
  const [commentBody, setCommentBody] = useState('')
  const [busy, setBusy] = useState(false)

  if (!repoInfo.connected) return <Empty icon="globe" title={auth?.connected ? t('github.originIssue') : t('github.notConnected')} />

  if (detail) {
    return (
      <div>
        <button className="gm-btn" onClick={() => { setDetail(null); setCommentBody('') }}>{t('common.back')}</button>
        <h3 style={{ margin: '6px 0' }}>#{detail.number} {detail.title}</h3>
        <div className="gm-row">
          <span className={`gm-chip ${detail.state === 'open' ? 'amber' : 'red'}`}>{detail.state}</span>
          <span className="gm-muted">{detail.user} · {detail.createdAt?.slice(0, 10)}</span>
        </div>
        {detail.labels.length > 0 && <div className="gm-row" style={{ marginTop: 4 }}>{detail.labels.map((l) => <span key={l} className="gm-chip">{l}</span>)}</div>}
        {detail.body ? <div className="gm-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 6, padding: 8, background: 'var(--gm-bg-soft)', borderRadius: 6 }}>{detail.body}</div> : null}
        <div className="gm-section"><div className="head">{t('issues.comments')} ({detail.comments.length})</div></div>
        {detail.comments.map((c) => (
          <div key={c.id} style={{ padding: 6, borderBottom: '1px solid var(--gm-hairline)' }}>
            <div className="gm-row"><span className="gm-chip">{c.user}</span><span className="gm-muted">{c.createdAt?.slice(0, 10)}</span></div>
            <div className="gm-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{c.body}</div>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <textarea className="gm-textarea" rows={3} placeholder={t('issues.writeComment')} value={commentBody} onChange={(e) => setCommentBody(e.target.value)} />
          <button className="gm-btn primary" style={{ marginTop: 4 }} disabled={!commentBody.trim() || busy} onClick={async () => { setBusy(true); try { await api.commentIssue(repoInfo.owner, repoInfo.repo, detail.number, commentBody); setCommentBody(''); const d = await api.issueDetail(repoInfo.owner, repoInfo.repo, detail.number); setDetail(d) } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('issues.send')}</button>
        </div>
      </div>
    )
  }

  if (creating) {
    return (
      <div>
        <button className="gm-btn" onClick={() => setCreating(false)}>{t('common.back')}</button>
        <div className="gm-row" style={{ marginTop: 6 }}><input className="gm-input" placeholder={t('issues.titleLabel')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
        <div className="gm-row"><textarea className="gm-textarea" rows={4} placeholder={t('issues.body')} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
        <button className="gm-btn primary" disabled={!form.title.trim() || busy} onClick={async () => { setBusy(true); try { await api.createIssue(repoInfo.owner, repoInfo.repo, form.title, form.body); setCreating(false); reload() } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('issues.createBtn')}</button>
      </div>
    )
  }

  return (
    <div>
      <div className="gm-row" style={{ justifyContent: 'space-between' }}>
        <span className="gm-muted">{issues?.length ?? 0} issues</span>
        <button className="gm-btn primary" onClick={() => setCreating(true)}>{t('issues.create')}</button>
      </div>
      {issues?.length ? issues.map((issue) => (
        <div className="gm-issue" key={issue.number} onClick={() => { void api.issueDetail(repoInfo.owner, repoInfo.repo, issue.number).then(setDetail).catch((e) => reportError(t('op.failed'), e)) }}>
          <div style={{ fontWeight: 600 }}>#{issue.number} {issue.title}</div>
          <div className="gm-muted">{issue.state} · {issue.user} · {issue.createdAt?.slice(0, 10)}{issue.commentCount > 0 ? ` · ${issue.commentCount} comments` : ''}</div>
        </div>
      )) : <Empty icon="issue" title={t('issues.empty')} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PRs tab
// ---------------------------------------------------------------------------

function ChecksChips({ checks }: { checks: NonNullable<PullRequestSummary['checks']> }): JSX.Element {
  return (
    <div className="gm-row">
      <span className="gm-chip green">{checks.passing} {t('prs.pass')}</span>
      <span className="gm-chip red">{checks.failing} {t('prs.fail')}</span>
      <span className="gm-chip amber">{checks.pending} {t('prs.wait')}</span>
    </div>
  )
}

function PRs({ api, repoInfo, auth }: { api: GitManagerApi; repoInfo: RepoInfo | null; auth: GitHubAuthState | null }): JSX.Element {
  const { data: prs, reload } = usePoll<PullRequestSummary[]>(
    () => (repoInfo ? api.listPRs(repoInfo.owner, repoInfo.repo, 'open') : Promise.resolve([])),
    [repoInfo?.owner, repoInfo?.repo],
    10000,
  )
  const [detail, setDetail] = useState<PullRequestDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ title: '', base: 'main', body: '' })
  const [busy, setBusy] = useState(false)
  const [prComment, setPrComment] = useState('')
  const [reviewBody, setReviewBody] = useState('')
  const [reviewState, setReviewState] = useState<'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | null>(null)

  // 未连接的两种原因：账号已连但 origin 不是 GitHub / 账号本身未连接。
  if (!repoInfo) return <Empty icon="globe" title={auth?.connected ? t('github.originIssue') : t('github.notConnected')} />
  if (!repoInfo.connected) return <Empty icon="globe" title={auth?.connected ? t('github.originIssue') : t('github.notConnected')} />

  if (detail) {
    return (
      <div>
        <button className="gm-btn" onClick={() => { setDetail(null); setPrComment(''); setReviewState(null) }}>{t('common.back')}</button>
        <h3 style={{ margin: '6px 0' }}>#{detail.number} {detail.title}</h3>
        <div className="gm-row">
          <span className={`gm-chip ${detail.state === 'merged' ? 'green' : detail.state === 'open' ? 'amber' : 'red'}`}>{detail.state}</span>
          <span className="gm-muted">{detail.head} → {detail.base}</span>
        </div>
        {detail.checks ? <ChecksChips checks={detail.checks} /> : null}
        {detail.body ? <div className="gm-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{detail.body}</div> : null}

        <div className="gm-section"><div className="head">{t('prs.checks')} ({detail.checkRuns.length})</div></div>
        {detail.checkRuns.map((c) => (
          <div className="gm-row" key={c.name}>
            <span className="gm-file">{c.name}</span>
            <span className={`gm-chip ${c.conclusion === 'success' ? 'green' : c.conclusion === 'failure' ? 'red' : 'amber'}`}>{c.conclusion ?? c.status}</span>
          </div>
        ))}

        <div className="gm-section"><div className="head">{t('prs.reviews')} ({detail.reviews.length})</div></div>
        {detail.reviews.map((r, i) => (
          <div className="gm-row" key={i}><span className="gm-chip">{r.state}</span><span>{r.user}</span>{r.body ? <span className="gm-muted">{r.body.slice(0, 80)}</span> : null}</div>
        ))}

        {detail.state === 'open' && (
          <div className="gm-section">
            <div className="head">{t('pr.review.submit')}</div>
            <div className="gm-review-btns">
              <button className="gm-btn primary" onClick={() => setReviewState(reviewState === 'APPROVE' ? null : 'APPROVE')} style={reviewState === 'APPROVE' ? {} : { opacity: 0.6 }}>{t('pr.review.approve')}</button>
              <button className="gm-btn danger" onClick={() => setReviewState(reviewState === 'REQUEST_CHANGES' ? null : 'REQUEST_CHANGES')} style={reviewState === 'REQUEST_CHANGES' ? {} : { opacity: 0.6 }}>{t('pr.review.requestChanges')}</button>
              <button className="gm-btn" onClick={() => setReviewState(reviewState === 'COMMENT' ? null : 'COMMENT')} style={reviewState === 'COMMENT' ? {} : { opacity: 0.6 }}>{t('pr.review.comment')}</button>
            </div>
            {reviewState && (
              <div style={{ marginTop: 4 }}>
                <textarea className="gm-textarea" rows={3} placeholder={t('pr.review.placeholder')} value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} />
                <button className="gm-btn primary" style={{ marginTop: 4 }} disabled={busy} onClick={async () => { setBusy(true); try { await api.reviewPR(repoInfo.owner, repoInfo.repo, detail.number, reviewState, reviewBody); reload(); setDetail(null); setReviewState(null); setReviewBody('') } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('pr.review.submit')}</button>
              </div>
            )}
          </div>
        )}

        <div className="gm-section">
          <div className="head">{t('prs.comments')}</div>
          {detail.comments.map((c) => (
            <div key={c.id} style={{ padding: 4, borderBottom: '1px solid var(--gm-hairline)' }}>
              <span className="gm-chip">{c.user}</span> <span className="gm-muted">{c.path}{c.line ? `:${c.line}` : ''}</span>
              <div className="gm-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.body}</div>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            <textarea className="gm-textarea" rows={2} placeholder={t('pr.comment.placeholder')} value={prComment} onChange={(e) => setPrComment(e.target.value)} />
            <button className="gm-btn primary" style={{ marginTop: 4 }} disabled={!prComment.trim() || busy} onClick={async () => { setBusy(true); try { await api.commentPR(repoInfo.owner, repoInfo.repo, detail.number, prComment); setPrComment(''); reload() } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('pr.comment.send')}</button>
          </div>
        </div>

        {detail.state === 'open' && (
          <div className="gm-row" style={{ marginTop: 10 }}>
            <button className="gm-btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await api.mergePR(repoInfo.owner, repoInfo.repo, detail.number, 'squash'); reload(); setDetail(null) } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('prs.squash')}</button>
          </div>
        )}
      </div>
    )
  }

  if (creating) {
    return (
      <div>
        <button className="gm-btn" onClick={() => setCreating(false)}>{t('common.back')}</button>
        <div className="gm-row" style={{ marginTop: 6 }}><input className="gm-input" placeholder={t('prs.title')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
        <div className="gm-row"><span className="gm-muted">{t('prs.head')} {repoInfo.branch} → {t('prs.base')}</span><input className="gm-input" style={{ width: 120 }} value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} /></div>
        <div className="gm-row"><textarea className="gm-textarea" rows={4} placeholder="Description" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
        <button className="gm-btn primary" disabled={!form.title.trim() || !repoInfo.branch} onClick={async () => {
          setBusy(true)
          try {
            await api.createPR(repoInfo.owner, repoInfo.repo, { title: form.title, body: form.body, head: repoInfo.branch, base: form.base })
            setCreating(false); reload()
          } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) }
        }}>{t('prs.createBtn')}</button>
      </div>
    )
  }

  return (
    <div>
      <div className="gm-row" style={{ justifyContent: 'space-between' }}>
        <span className="gm-muted">{t('prs.open')}</span>
        <button className="gm-btn primary" onClick={() => setCreating(true)} disabled={!repoInfo.branch}>{t('prs.create')}</button>
      </div>
      {prs?.length ? prs.map((pr) => (
        <div className="gm-pr" key={pr.number} onClick={() => { void api.prDetail(repoInfo.owner, repoInfo.repo, pr.number).then(setDetail).catch((e) => reportError(t('op.failed'), e)) }}>
          <div className="t">#{pr.number} {pr.title}</div>
          <div className="gm-muted">{pr.head} → {pr.base} · {pr.user}{pr.draft ? ` · ${t('prs.draft')}` : ''}</div>
          {pr.checks ? <ChecksChips checks={pr.checks} /> : null}
        </div>
      )) : <Empty icon="git-pr" title={t('prs.empty')} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GitHub tab — repo overview + quick PR list + auth
// ---------------------------------------------------------------------------

function GitHubView({ api, path, repoInfo, auth, reloadAuth, onGotoPrs, device, deviceBusy, onStartDevice, onCheckDevice, onCancelDevice, onCloned }: {
  api: GitManagerApi
  path: string
  repoInfo: RepoInfo | null
  auth: GitHubAuthState | null
  reloadAuth: () => void
  onGotoPrs: () => void
  /** 设备流状态由父级持有：切标签页不丢失，回到本页继续显示输入码。 */
  device: Awaited<ReturnType<typeof api.deviceStart>> | null
  deviceBusy: boolean
  onStartDevice: () => void
  onCheckDevice: () => void
  onCancelDevice: () => void
  /** 克隆成功后：父级更新书架清单并切换到新仓库。 */
  onCloned: (newPath: string) => void
}): JSX.Element {
  // P1：从 URL 克隆入架（父目录默认取当前仓库的上一级）
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneParent, setCloneParent] = useState('')
  const [cloneBusy, setCloneBusy] = useState(false)
  const defaultParent = useMemo(() => {
    const norm = path.split('\\').join('/')
    const i = norm.lastIndexOf('/')
    return i > 0 ? norm.slice(0, i) : ''
  }, [path])
  // origin 检查：区分「未登录」与「origin 不是 GitHub」两种未连接原因。
  const [originHint, setOriginHint] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void api.repoInfo(path).then(() => { if (alive) setOriginHint(null) }).catch((e) => {
      if (alive) setOriginHint(String(e instanceof Error ? e.message : e))
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // 已连接时展示打开中的 PR 快速列表。
  const connected = auth?.connected === true && repoInfo != null
  const { data: quickPrs } = usePoll<PullRequestSummary[]>(
    () => (connected ? api.listPRs(repoInfo!.owner, repoInfo!.repo, 'open') : Promise.resolve([])),
    [connected, repoInfo?.owner, repoInfo?.repo],
    15000,
  )

  const [pat, setPat] = useState('')
  const savePat = async (): Promise<void> => {
    try { await api.tokenInput(pat); setPat(''); reloadAuth() } catch (e) { reportError(t('op.failed'), e) }
  }

  return (
    <div>
      {auth?.connected ? (
        <div>
          <div className="gm-row"><span className="gm-chip green">{t('github.connected')}</span><span>{auth.login}</span><span className="gm-muted">({auth.source})</span></div>
          {auth.scopes?.length ? <div className="gm-muted" style={{ marginTop: 4 }}>{t('github.scopes')}: {auth.scopes.join(', ')}</div> : null}
          {repoInfo ? <div className="gm-row" style={{ marginTop: 6 }}><span className="gm-chip">{repoInfo.owner}/{repoInfo.repo}</span>{repoInfo.branch ? <span className="gm-muted">@{repoInfo.branch}</span> : null}{repoInfo.prNumber ? <span className="gm-chip green">PR #{repoInfo.prNumber}</span> : null}</div> : null}
          <button className="gm-btn" style={{ marginTop: 8 }} onClick={onGotoPrs}>{t('github.gotoPrs')}</button>
          <button className="gm-btn danger" style={{ marginTop: 8, marginLeft: 6 }} onClick={async () => { await api.logout(); reloadAuth() }}>{t('github.logout')}</button>

          {connected && (
            <div className="gm-section">
              <div className="head">{t('github.quickPrs')} ({quickPrs?.length ?? 0})</div>
              {quickPrs?.length ? quickPrs.slice(0, 5).map((p) => (
                <div className="gm-row" key={p.number}>
                  <span style={{ fontFamily: 'var(--gm-mono)', fontSize: 10 }}>#{p.number}</span>
                  <span className="gm-file">{p.title}</span>
                  <span className="gm-muted">{p.user}</span>
                </div>
              )) : <div className="gm-muted" style={{ padding: '2px 4px' }}>{t('prs.empty')}</div>}
            </div>
          )}
        </div>
      ) : (
        <div>
          <Empty icon="globe" title={t('github.notConnected')} />
          {originHint !== null && (
            <div className="gm-muted" style={{ padding: '2px 6px', marginBottom: 4 }}>
              {originHint.includes('GitHub') ? t('github.originIssue') : t('github.loginFirst')}
            </div>
          )}
          {/* 令牌在握但 API 不可达/无效：给降级提示 + 重试，不再打回登录死循环。 */}
          {auth?.hasToken ? (
            <div style={{ margin: '4px 0 8px', padding: 6, border: '1px solid color-mix(in srgb, var(--gm-amber) 50%, transparent)', borderRadius: 8, background: 'var(--gm-amber-soft)' }}>
              <div>{auth.invalidToken ? t('github.invalidToken') : t('github.savedToken')}</div>
              {!auth.invalidToken && auth.reachabilityError ? <div className="gm-muted" style={{ fontSize: 10, marginTop: 2 }}>{auth.reachabilityError}</div> : null}
              <button className="gm-btn" style={{ marginTop: 4 }} onClick={reloadAuth}>{t('common.retry')}</button>
            </div>
          ) : null}
          {device ? (
            <div>
              <div className="gm-row"><span className="gm-chip amber">{t('github.code')}: <b>{device.userCode}</b></span></div>
              <div className="gm-row"><a className="gm-btn" href={device.verificationUri} target="_blank" rel="noreferrer">{t('github.openUrl')}</a></div>
              <div className="gm-muted" style={{ padding: 4 }}>{t('github.loginHint')}</div>
              <button className="gm-btn primary" onClick={onCheckDevice} disabled={deviceBusy}>{t('github.checkNow')}</button>
              <button className="gm-btn" style={{ marginLeft: 6 }} onClick={onCancelDevice} disabled={deviceBusy}>{t('actions.cancel')}</button>
            </div>
          ) : (
            <button className="gm-btn primary" onClick={onStartDevice} disabled={deviceBusy}>{t('github.login')}</button>
          )}
          <div style={{ marginTop: 12 }}>
            <div className="gm-muted">{t('github.pat')}</div>
            <div className="gm-row">
              <input className="gm-input" type="password" value={pat} onChange={(e) => setPat(e.target.value)} />
              <button className="gm-btn" onClick={savePat} disabled={!pat.trim()}>{t('github.patBtn')}</button>
            </div>
          </div>
        </div>
      )}

      {/* P1：克隆仓库入架 */}
      <div className="gm-section" style={{ marginTop: 14 }}><div className="head"><Icon name="globe" size={12} /> {t('clone.title')}</div></div>
      <div className="gm-row">
        <input className="gm-input" placeholder={t('clone.url')} value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} />
      </div>
      <div className="gm-row">
        <input className="gm-input" placeholder={cloneParent === '' && defaultParent !== '' ? `${t('clone.parent')}: ${defaultParent}` : t('clone.parent')} value={cloneParent} onChange={(e) => setCloneParent(e.target.value)} />
        <button
          className="gm-btn"
          disabled={cloneBusy || cloneUrl.trim() === ''}
          onClick={() => {
            const parent = (cloneParent.trim() || defaultParent).trim()
            if (parent === '') { reportError(t('op.failed'), new Error(t('clone.parent'))); return }
            setCloneBusy(true)
            void api.clone(parent, cloneUrl.trim())
              .then((r) => { report('ok', t('op.cloned'), r.path); setCloneUrl(''); setCloneParent(''); onCloned(r.path) })
              .catch((e) => reportError(t('op.failed'), e))
              .finally(() => setCloneBusy(false))
          }}
        ><Icon name="plus" size={12} />{t('clone.btn')}</button>
      </div>
      <div className="gm-muted" style={{ fontSize: 10 }}>{t('clone.hint')}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent: event feed text tags (icon-light design)
// ---------------------------------------------------------------------------

interface EventTag { cls: 'run' | 'ok' | 'wait' | 'err' | ''; label: string }

function eventTag(type: string): EventTag {
  switch (type) {
    case 'tool:start': return { cls: 'run', label: t('feed.run') }
    case 'tool:completed': return { cls: 'ok', label: t('feed.done') }
    case 'tool:error': return { cls: 'err', label: t('feed.err') }
    case 'approval:requested': return { cls: 'wait', label: t('feed.req') }
    case 'approval:approved': return { cls: 'ok', label: t('feed.ok') }
    case 'approval:rejected': return { cls: 'err', label: t('feed.rej') }
    case 'repo:commit-new': return { cls: '', label: t('feed.commit') }
    case 'repo:branch-change': return { cls: 'run', label: t('feed.branch') }
    case 'repo:status-change': return { cls: '', label: t('feed.status') }
    case 'repo:remote-update': return { cls: 'run', label: t('feed.remote') }
    default: return { cls: '', label: t('feed.other') }
  }
}

// ---------------------------------------------------------------------------
// File-level review: per-file tabs + full-file "before | after" panes
// ---------------------------------------------------------------------------

interface FileReviewRow {
  path: string
  additions: number | null
  deletions: number | null
  binary?: boolean
  truncated?: boolean
  diff?: string
  /** demo 载荷内嵌全文（省去 fetch） */
  beforeFull?: { exists: boolean; text: string }
  afterFull?: { text: string }
  delLines?: number[]
  addLines?: number[]
}

function buildLines(text: string, hiLines: number[]): Array<{ n: number; text: string; hi: boolean }> {
  const hiSet = new Set(hiLines)
  const arr = text.split('\n')
  if (arr[arr.length - 1] === '') arr.pop()
  return arr.map((line, idx) => ({ n: idx + 1, text: line, hi: hiSet.has(idx + 1) }))
}

function FilePane({ title, cls, lines, missingNote }: { title: string; cls: string; lines: Array<{ n: number; text: string; hi: boolean }> | null; missingNote?: string }): JSX.Element {
  return (
    <>
      <div className={`gm-pane-head ${cls}`}>{title}</div>
      <div className="gm-pane">
        {missingNote != null && <div className="gm-trunc-note">{missingNote}</div>}
        {lines == null && missingNote == null && <div className="gm-trunc-note">…</div>}
        {lines?.map((l) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={`${l.n}`} className={`gm-ln${l.hi ? ` ${cls === 'before' ? 'del' : 'add'}` : ''}`}>
            <span className="gm-lno">{l.n}</span>
            <span className="gm-ltxt">{l.text === '' ? ' ' : l.text}</span>
          </div>
        ))}
      </div>
    </>
  )
}

type ComparePayload = {
  binary: boolean
  before: { exists: boolean; text: string }
  after: { text: string }
  delLines: number[]
  addLines: number[]
  truncated: boolean
}

function FileComparePane({ payload }: { payload: ComparePayload }): JSX.Element {
  if (!payload || payload.binary) return <div className="gm-trunc-note">{t('agent.binary')}</div>
  const beforeText = payload.before?.text ?? ''
  const afterText = payload.after?.text ?? ''
  const beforeExists = payload.before?.exists === true
  const beforeLines = beforeExists ? buildLines(beforeText, payload.delLines ?? []) : null
  const afterLines = buildLines(afterText, payload.addLines ?? [])
  return (
    <div className="gm-filediff">
      <FilePane title="修改前 · HEAD" cls="before" lines={beforeLines} missingNote={beforeExists ? undefined : t('agent.newFile')} />
      <FilePane title="修改后 · 工作区" cls="after" lines={afterLines} />
      {payload.truncated && <div className="gm-trunc-note">{t('agent.diffTruncated')}</div>}
    </div>
  )
}

/** 降级渲染：仅有 unified diff（无全文载荷）时的紧凑双栏 hunk 视图。 */
function DiffHunks({ diff }: { diff: string }): JSX.Element | null {
  const rows = useMemo(() => {
    const out: Array<{ kind: 'hunk'; text: string } | { kind: 'pair'; l: { cls: string; text: string } | null; r: { cls: string; text: string } | null }> = []
    let pairs: Array<{ kind: 'pair'; l: { cls: string; text: string } | null; r: { cls: string; text: string } | null }> = []
    const flush = (): void => { if (pairs.length) { out.push(...pairs); pairs = [] } }
    for (const raw of diff.split('\n')) {
      if (raw.startsWith('@@')) { flush(); out.push({ kind: 'hunk', text: raw }); continue }
      if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('\\')) continue
      if (raw.startsWith('-')) pairs.push({ kind: 'pair', l: { cls: 'del', text: raw.slice(1) }, r: null })
      else if (raw.startsWith('+')) pairs.push({ kind: 'pair', l: null, r: { cls: 'add', text: raw.slice(1) } })
      else pairs.push({ kind: 'pair', l: { cls: '', text: raw.replace(/^ /, '') }, r: { cls: '', text: raw.replace(/^ /, '') } })
    }
    flush()
    return out
  }, [diff])
  if (rows.length === 0) return null
  return (
    <div className="gm-filediff">
      <div className="gm-pane-head">diff</div>
      <div className="gm-pane" style={{ gridColumn: '1 / -1' }}>
        {rows.map((row, i) => row.kind === 'hunk'
          ? <div key={i} className="gm-trunc-note">{row.text}</div>
          : (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="gm-ln">
              <span className="gm-lno" />
              <span className={`gm-ltxt ${row.l?.cls ?? ''}`}>{row.l?.text ?? ''}{row.r ? `  →  ${row.r.text}` : ''}</span>
            </div>
          ))}
      </div>
    </div>
  )
}

function FileReviewSection({ files, workspace, api }: { files: FileReviewRow[]; workspace: string; api: GitManagerApi }): JSX.Element {
  const shown = files.slice(0, 20)
  const [activePath, setActivePath] = useState<string | null>(shown[0]?.path ?? null)
  const active = shown.find((f) => f.path === activePath) ?? shown[0]
  const totals = shown.reduce(
    (acc, f) => ({ a: acc.a + (f.additions ?? 0), d: acc.d + (f.deletions ?? 0) }),
    { a: 0, d: 0 },
  )

  type LoadedState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'payload'; payload: ComparePayload }

  const demoReady = active != null && active.beforeFull != null && active.afterFull != null

  const [remote, setRemote] = useState<LoadedState>({ kind: 'loading' })
  useEffect(() => {
    if (demoReady || active == null) return
    if (workspace === '') {
      // 旧格式卡片（无 workspace / 无全文载荷）：直接进入降级渲染。
      setRemote({ kind: 'error', message: '' })
      return
    }
    let alive = true
    setRemote({ kind: 'loading' })
    void api.reviewFile(workspace, active.path)
      .then((p) => { if (alive) setRemote({ kind: 'payload', payload: p }) })
      .catch((e) => { if (alive) setRemote({ kind: 'error', message: String(e instanceof Error ? e.message : e) }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, workspace, demoReady])

  const state: LoadedState = demoReady
    ? {
        kind: 'payload',
        payload: {
          binary: active!.binary === true,
          before: active!.beforeFull!,
          after: active!.afterFull!,
          delLines: active!.delLines ?? [],
          addLines: active!.addLines ?? [],
          truncated: active!.truncated === true,
        },
      }
    : remote

  return (
    <div className="gm-frev">
      <div className="gm-ftabs">
        {shown.map((f) => (
          <button key={f.path} className={`gm-ftab ${f.path === active?.path ? 'on' : ''}`} onClick={() => setActivePath(f.path)} title={f.path}>
            <span className="p">{f.path}</span>
            <span className="gm-fstats add">+{f.additions ?? 0}</span>
            <span className="gm-fstats del">−{f.deletions ?? 0}</span>
          </button>
        ))}
      </div>
      {active == null ? null
        : active.binary === true
          ? <div className="gm-trunc-note">{t('agent.binary')}</div>
          : state.kind === 'loading'
            ? <div className="gm-trunc-note">…</div>
            : state.kind === 'error'
              ? (active.diff && active.diff.trim() !== ''
                  ? (
                    <>
                      <div className="gm-trunc-note">{state.message || t('agent.noFullText')}</div>
                      <DiffHunks diff={active.diff} />
                    </>
                  )
                  : <div className="gm-err" style={{ padding: 4 }}>{t('agent.fileLoadErr')}: {state.message}</div>)
              : <FileComparePane payload={state.payload} />}
      {active.truncated === true && <div className="gm-trunc-note">{t('agent.diffTruncated')}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent view
// ---------------------------------------------------------------------------

function AgentView({ api, events }: { api: GitManagerApi; events: GitEvent[] }): JSX.Element {
  const [cleared, setCleared] = useState<boolean>(false)
  const [decided, setDecided] = useState<Record<string, 'approved' | 'rejected'>>({})
  const [preAllowed, setPreAllowed] = useState<string[]>([])
  const feed = useMemo(() => cleared ? [] : [...events].reverse(), [events, cleared])

  const approvalRequests = useMemo<GitEvent[]>(() => {
    if (cleared) return []
    const resolved = new Set<string>()
    for (const e of events) {
      const cid = e.data.callId as string | undefined
      if (!cid) continue
      if (e.type === 'approval:approved' || e.type === 'approval:rejected') resolved.add(cid)
    }
    const reqs: GitEvent[] = []
    for (const e of events) {
      const cid = e.data.callId as string | undefined
      if (e.type === 'approval:requested' && cid && !resolved.has(cid)) reqs.push(e)
    }
    return reqs
  }, [events, cleared])

  // 会话预批准（始终允许）的服务端真实状态：常驻芯片展示，可随时 ✕ 撤销。
  // call() 运行时拆信封：preApproveList 直接给出 {tools}（此前类型谎报信封，
  // 导致 r.value 取空静默崩坏——芯片从未渲染过的真正根因）。+15s 轮询保持真值。
  const refreshPre = useCallback(() => {
    void api.preApproveList().then((r) => setPreAllowed(Array.isArray(r?.tools) ? r.tools : [])).catch(() => {})
  }, [api])
  useEffect(() => { refreshPre() }, [refreshPre])
  useEffect(() => {
    const timer = setInterval(refreshPre, 15000)
    return () => clearInterval(timer)
  }, [refreshPre])

  const revokePre = useCallback((entry: string) => {
    void api.clearPreApprove(entry.split('#')[0]).catch(() => {})
    setPreAllowed((prev) => prev.filter((x) => x !== entry))
  }, [api])

  // 对“正在等待”的调用：/gitm/approval 实时解除阻塞；
  // 无 callId 的场景退回预批准（下一次同名调用跳过弹窗）。
  const decide = useCallback((event: GitEvent, decision: 'approved' | 'rejected') => {
    const callId = event.data.callId as string | undefined
    const tool = String(event.data.tool ?? '')
    setDecided((prev) => ({ ...prev, [callId ?? tool]: decision }))
    if (callId) void api.decideApproval(callId, decision).catch(() => {})
    else if (decision === 'approved') { void api.preApprove(tool).catch(() => {}); refreshPre() }
  }, [api, refreshPre])

  return (
    <div className="gm-agent">
      <div className="gm-agent-bar">
        <span className="gm-live"><span className="dot" />{t('agent.live')}</span>
        <span className="gm-agent-count">{feed.length}</span>
        {approvalRequests.length > 0 && <span className="gm-chip amber">{approvalRequests.length} {t('agent.pendingApproval')}</span>}
        {preAllowed.map((entry) => (
          <span key={entry} className="gm-chip green">
            {entry} · {t('agent.sessionAllowed')}
            <button className="gm-chip-x" title={t('agent.clearSessionAllow')} onClick={() => revokePre(entry)}><Icon name="x" size={10} /></button>
          </span>
        ))}
        <button className="gm-btn" onClick={() => setCleared(!cleared)}>{cleared ? t('agent.restoreFeed') : t('agent.clear')}</button>
        <button className="gm-btn" title={t('agent.previewCard')} onClick={() => void api.previewFileReview().catch(() => {})}>{t('agent.previewCard')}</button>
      </div>

      {approvalRequests.length > 0 && (
        <div className="gm-approvals">
          {approvalRequests.map((e) => {
            const key = String(e.data.callId ?? e.data.tool ?? e.id)
            const state = decided[key]
            const sessionAllowed = decided[`${key}::session`] !== undefined
            const files = Array.isArray(e.data.files) ? (e.data.files as FileReviewRow[]) : []
            const workspace = String(e.data.workspace ?? '')
            return (
              <div key={e.id} className={`gm-approve-card${state || sessionAllowed ? ' done' : ''}`}>
                <div className="gm-approve-msg">{String(e.data.summary ?? e.data.tool ?? '')}</div>
                <div className="gm-approve-tool">{String(e.data.tool ?? '')}{e.data.callId ? ` · #${String(e.data.callId)}` : ''}</div>
                {files.length > 0 && <FileReviewSection files={files} workspace={workspace} api={api} />}
                <div className="gm-approve-actions">
                  <button className="gm-btn primary" disabled={state !== undefined} onClick={() => decide(e, 'approved')}>{t('agent.approveAll')}</button>
                  <button className="gm-btn danger" disabled={state !== undefined} onClick={() => decide(e, 'rejected')}>{t('agent.rejectAll')}</button>
                  <button
                    className="gm-btn"
                    disabled={state !== undefined || sessionAllowed}
                    title={t('agent.allowSession')}
                    onClick={() => {
                      void api.preApprove(String(e.data.tool ?? ''), '*').catch(() => {})
                      setDecided((prev) => ({ ...prev, [`${key}::session`]: 'approved' }))
                      refreshPre()
                    }}
                  >{t('agent.allowSession')}</button>
                  <span className="gm-hint">
                    {state === 'approved' ? t('agent.approved')
                      : state === 'rejected' ? t('agent.rejected')
                        : sessionAllowed ? t('agent.allowedSessionHint') : ''}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="gm-feed">
        {feed.length === 0 && <Empty icon="bot" title={t('agent.empty')} />}
        {feed.map((e) => {
          const tag = eventTag(e.type)
          return (
            <div key={e.id} className={`gm-evt ${tag.cls}`}>
              <span className="gm-dot" />
              <span className="gm-tag">{tag.label}</span>
              <span className="gm-evt-txt">{String(e.data._summary ?? e.data.summary ?? e.type)}</span>
              <span className="gm-evt-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

type TabId = 'branches' | 'changes' | 'graph' | 'prs' | 'issues' | 'github' | 'agent'

/** Changes 页各操作的成功横幅标题（kind → i18n key）。 */
const OK_TITLES: Record<string, string> = {
  stage: 'op.staged', unstage: 'op.unstaged', discard: 'op.discarded',
  commit: 'op.committed', push: 'op.pushed', pull: 'op.pulled', fetch: 'op.fetched',
  stash: 'op.stashed', apipush: 'op.apiPushed',
  ignore: 'op.ignored', undo: 'op.undone', amend: 'op.amended',
  stashApply: 'op.stashApplied', stashDrop: 'op.stashDropped',
  tagCreate: 'op.tagCreated', tagDelete: 'op.tagDeleted', tagPush: 'op.tagPushed',
}

/** 渲染错误只损失面板内容，不再炸掉整个宿主 UI；可原地重置。 */
class PanelErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="gm-panel" style={{ padding: 14 }}>
        <div style={{ color: 'var(--gm-red)', fontWeight: 600, marginBottom: 4 }}>dsh-git-manager 渲染错误 / render error</div>
        <div style={{ opacity: .75, whiteSpace: 'pre-wrap', fontFamily: 'var(--gm-mono)', fontSize: 11, marginBottom: 10 }}>
          {String(this.state.error.message || this.state.error)}
        </div>
        <button className="gm-btn" onClick={() => { this.setState({ error: null }) }}>重置面板 / reset</button>
      </div>
    )
  }
}

/** 面板的宿主契约：独立右栏 Dock 与 better-sidebar 页签共用同一份 props
 *  （见 client/index.ts 与 client/embed.tsx），所以宿主差异只能通过这里的
 *  可选字段表达，面板本身不认识任何一个宿主。 */
export interface CompassPanelProps {
  api: GitManagerApi
  sessions: { list: { getSnapshot(): { current?: string; byId: Record<string, { cwd?: string }> }; subscribe(fn: () => void): () => void } }
  /** 宿主所在会话的 cwd（better-sidebar 页签由 `scope.cwd` 给出）。
   *  有它时按它选仓库，比"去猜当前活跃会话"准确。 */
  cwd?: string
  /** 宿主所在会话的 id（better-sidebar 页签的 `scope.sessionId`）。
   *  没有 cwd 时用它去 sessions store 里查，仍然是"本页签自己的会话"。 */
  sessionId?: string
  /** 收起态：只有独立 Dock 形态会传（页签的生命周期归 better-sidebar）。
   *  收起时靠 CSS 只留头部，宿主负责停轮询。 */
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

/** 把工作区路径与 cwd 都归一化后比较：Windows 上大小写与反斜杠都不该影响命中。 */
function normPath(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

/** 从会话 cwd 里挑出最具体的那个工作区。
 *  必须比对**路径边界**：否则 `D:/a/b` 会被 `D:/a/b2` 命中（旧实现就有这个 bug）。
 *  取最长命中，嵌套仓库/子目录工作区才不会被父目录抢走。 */
function matchWorkspace(workspaces: WorkspaceEntry[], cwd: string): WorkspaceEntry | undefined {
  const target = normPath(cwd)
  let best: WorkspaceEntry | undefined
  for (const w of workspaces) {
    const base = normPath(w.path)
    if (base === '' || target !== base && !target.startsWith(base + '/')) continue
    if (best === undefined || base.length > normPath(best.path).length) best = w
  }
  return best
}

/**
 * 本面板所属会话的 cwd —— "自动检测当前会话工作区"的唯一来源。
 * 优先级：宿主直接给的 `cwd`（better-sidebar 的 scope.cwd）→ 宿主给的
 * `sessionId` 查 sessions store → 全局"当前活跃会话"（独立 Dock 形态没有
 * sessionId，只能这样）。
 *
 * 订阅 store 而不是读一次快照：换工作区、切会话、页面重开都会自己跟上，
 * 面板不需要用户手动去下拉框里挑。
 */
function useOwnCwd(sessions: CompassPanelProps['sessions'], sessionId: string | undefined, cwd: string | undefined): string | undefined {
  const resolve = useCallback((): string | undefined => {
    if (cwd !== undefined && cwd !== '') return cwd
    const snapshot = sessions.list.getSnapshot()
    if (sessionId !== undefined) {
      const own = snapshot.byId[sessionId]?.cwd
      if (own !== undefined && own !== '') return own
    }
    const current = snapshot.current
    return current ? snapshot.byId[current]?.cwd : undefined
  }, [sessions, sessionId, cwd])

  // 存字符串而不是 store 快照：不依赖 getSnapshot 的引用稳定性
  // （useSyncExternalStore 要求它缓存，而那是宿主 store 的实现细节，
  //  拿它当契约会在宿主换实现时变成无限渲染）。字符串相等时 React 自己
  // 就不再重渲染。
  const [own, setOwn] = useState<string | undefined>(resolve)
  useEffect(() => {
    const read = (): void => setOwn(resolve())
    read()
    return sessions.list.subscribe(read)
  }, [resolve, sessions])
  return own
}

function CompassPanelInner({ api, sessions, cwd, sessionId, collapsed = false, onToggleCollapsed }: CompassPanelProps): JSX.Element {
  // SSE 订阅常驻顶层：即使切到其他标签页，其他会话的提交/审批事件仍在积累，
  // 回到 Agent 标签即可看到全部历史（不因 unmount 断流）。
  const agentEvents = useGitEvents(200)
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([])
  const [path, setPath] = useState<string>('')
  // "本面板属于哪个会话的工作区"——换会话/换工作区会自动跟上（见 useOwnCwd）。
  const ownCwd = useOwnCwd(sessions, sessionId, cwd)
  /** 上一次自动选中的会话 cwd：用来区分"会话变了"和"用户自己选了别的"。 */
  const appliedCwd = useRef<string | undefined>(undefined)
  const [tab, setTab] = useState<TabId>('changes')
  const [flow, setFlow] = useState<FlowSnapshot | null>(null)
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null)
  const [tick, setTick] = useState(0)
  // GitHub 认证状态提升到父级：设备码流程跨标签页存活，且授权完成后立即刷新。
  const [authTick, setAuthTick] = useState(0)
  const { data: authState, reload: reloadAuth } = usePoll<GitHubAuthState>(() => api.githubAuth(), [authTick], 5000)
  const [device, setDevice] = useState<Awaited<ReturnType<typeof api.deviceStart>> | null>(null)
  const [deviceBusy, setDeviceBusy] = useState(false)
  // P0/P1：设置菜单 + Agent 待批徽标 + 冲突状态
  const [settingsOpen, setSettingsOpen] = useState(false)
  const pendingApprovals = useMemo(() => pendingApprovalCount(agentEvents), [agentEvents])
  const [, forceRender] = useState(0)
  // 收录仓库的内联输入行状态。
  const [addOpen, setAddOpen] = useState(false)
  const [addValue, setAddValue] = useState('')

  const startDevice = (): void => {
    setDeviceBusy(true)
    void api.deviceStart().then(setDevice).catch((e) => reportError(t('op.failed'), e)).finally(() => setDeviceBusy(false))
  }
  const checkDevice = (): void => {
    if (!device) return
    setDeviceBusy(true)
    void api.devicePoll(device.deviceCode, device.interval)
      .then((r) => { if (!r.pending) { setDevice(null); setAuthTick((x) => x + 1) } })
      .catch((e) => reportError(t('op.failed'), e))
      .finally(() => setDeviceBusy(false))
  }
  // 设备码后台轮询：不依赖当前所在标签页；用户在浏览器完成授权即自动接入。
  useEffect(() => {
    if (!device) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const step = async (): Promise<void> => {
      if (!alive) return
      try {
        const r = await api.devicePoll(device.deviceCode, device.interval)
        if (!r.pending) { if (alive) { setDevice(null); setAuthTick((x) => x + 1) } ; return }
      } catch { /* 网络抖动：继续重试 */ }
      if (alive) timer = setTimeout(step, Math.max(3, device.interval || 5) * 1000)
    }
    timer = setTimeout(step, 3000)
    return () => { alive = false; if (timer !== null) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device])
  // 登录成功后自动收起设备码卡（例如经由 CLI/PAT 路径先行连接）。
  useEffect(() => {
    if (authState?.connected && device !== null) setDevice(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState?.connected])

  useEffect(() => {
    void api.workspaces().then(setWorkspaces).catch((e) => console.error('dsh-git-manager: workspaces', e))
  }, [api])

  /**
   * 自动检测当前会话的工作区：会话 cwd 一变（换工作区 / 切会话 / 重开会话），
   * 面板就切到对应的仓库。
   *
   * 关键在于**记住"上次自动切到哪个 cwd"**，而不是每次依赖变化都重算：
   * 否则用户手动选了别的仓库、或刚收录一个仓库（workspaces 变了），都会被
   * 硬拽回会话仓库。规则是——自动检测跟随会话，但绝不对抗手动选择。
   */
  useEffect(() => {
    if (ownCwd === undefined || ownCwd === '' || workspaces.length === 0) return
    if (appliedCwd.current === ownCwd && path !== '') return
    const match = matchWorkspace(workspaces, ownCwd)
    if (match === undefined) return
    appliedCwd.current = ownCwd
    if (match.path !== path) setPath(match.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownCwd, workspaces, path])

  /** 手动收录本地仓库（嵌套仓库/未注册目录），返回值即最新合并清单。
   *  注意：Electron 不支持 window.prompt（同步抛 "prompt() is and will not
   *  be supported."，点击按钮会毫无反馈），因此这里用面板内联输入行。 */
  const submitAddRepo = (): void => {
    const input = addValue.trim()
    if (input === '') { setAddOpen(false); return }
    void api.addRepo(input).then((ws) => {
      setWorkspaces(ws)
      const added = ws.find((w) => w.path.toLowerCase() === input.replace(/[\\/]+$/, '').toLowerCase())
      if (added) { setPath(added.path); setTick((x) => x + 1) }
      setAddOpen(false); setAddValue('')
    }).catch((e) => reportError(t('op.failed'), e))
  }
  const removeCurrentRepo = (): void => {
    if (!path) return
    void api.removeRepo(path).then(setWorkspaces).catch(() => {})
  }

  useEffect(() => {
    if (!path) return
    const load = (): void => {
      void api.flow(path).then(setFlow).catch(() => setFlow(null))
      void api.repoInfo(path).then(setRepoInfo).catch(() => setRepoInfo(null))
    }
    load()
    const timer = setInterval(load, 6000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick])

  useEffect(() => {
    if (!document.querySelector('style[data-plugin="dsh-git-manager-css"]')) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-git-manager-css'
      style.textContent = css
      document.head.appendChild(style)
    }
  }, [])

  const tabs: Array<[TabId, string]> = [
    ['branches', 'tab.branches'],
    ['changes', 'tab.changes'],
    ['graph', 'tab.graph'],
    ['prs', 'tab.prs'],
    ['issues', 'tab.issues'],
    ['github', 'tab.github'],
    ['agent', 'tab.agent'],
  ]
  const TAB_ICONS: Record<TabId, IconName> = { branches: 'git-branch', changes: 'diff', graph: 'commit', prs: 'git-pr', issues: 'issue', github: 'globe', agent: 'bot' }

  return (
    <div className={`gm-panel${collapsed ? ' gm-collapsed' : ''}`}>
      <div className="gm-head">
        <div className="gm-headrow">
          {/* 收起把手只由独立 Dock 形态传入；better-sidebar 页签的收起在宿主手里。 */}
          {onToggleCollapsed ? (
            <button
              type="button"
              className="gm-btn sm"
              aria-expanded={!collapsed}
              title={collapsed ? t('panel.expand') : t('panel.collapse')}
              onClick={onToggleCollapsed}
            >
              <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
            </button>
          ) : null}
          <div className="gm-repo">
          <select value={path} title={path} onChange={(e) => { setPath(e.target.value); setTick((x) => x + 1) }}>
            {workspaces.length === 0 ? <option value="">{t('repo.none')}</option> : null}
            {workspaces.map((w) => <option key={w.path} value={w.path}>{w.title || w.path.split(/[\\/]/).pop()}</option>)}
          </select>
          <button className="gm-btn sm" onClick={() => { setAddOpen(!addOpen); setAddValue('') }} title={t('repo.add')}><Icon name="plus" size={14} /></button>
          <button className="gm-btn sm" onClick={removeCurrentRepo} title={t('repo.removeCurrent')}><Icon name="trash" size={14} /></button>
          <button className="gm-btn sm" onClick={() => setTick((x) => x + 1)} title={t('common.refresh')}><Icon name="sync" size={14} /></button>
          <button className="gm-btn sm" onClick={() => setSettingsOpen(!settingsOpen)} title={t('settings.title')}><Icon name="gear" size={13} /></button>
          </div>
        </div>
        {addOpen ? (
          <div className="gm-addrow">
            <input
              autoFocus
              value={addValue}
              placeholder={t('repo.addTitle').replace(/[:：]\s*$/, '')}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitAddRepo(); else if (e.key === 'Escape') { setAddOpen(false); setAddValue('') } }}
            />
            <button className="gm-btn" onClick={submitAddRepo}>{t('actions.confirm')}</button>
            <button className="gm-btn sm" onClick={() => { setAddOpen(false); setAddValue('') }}>{t('actions.cancel')}</button>
          </div>
        ) : null}
          {settingsOpen ? (
            <div className="gm-settings">
              <div className="gm-settings-row">
                <span className="gm-muted">{t('settings.language')}</span>
                {([null, 'zh', 'en'] as const).map((loc) => (
                  <button
                    key={loc ?? 'auto'}
                    className={`gm-btn${getLocaleOverride() === loc ? ' primary' : ''}`}
                    onClick={() => { setLocaleOverride(loc); forceRender((x) => x + 1) }}
                  >{loc === null ? t('settings.langAuto') : loc === 'zh' ? t('settings.langZh') : t('settings.langEn')}</button>
                ))}
              </div>
              <div className="gm-settings-row">
                <span className="gm-muted">{t('settings.poll')}</span>
                {(['fast', 'std', 'slow'] as const).map((spd) => (
                  <button
                    key={spd}
                    className={`gm-btn${pollSpeed === spd ? ' primary' : ''}`}
                    onClick={() => { setPollSpeed(spd); forceRender((x) => x + 1) }}
                  >{spd === 'fast' ? t('settings.pollFast') : spd === 'std' ? t('settings.pollStd') : t('settings.pollSlow')}</button>
                ))}
              </div>
              {/* 拉取方式原本是动作行里的一个文字切换钮，夹在"抓取"和"拉取"之间——
                  它其实是偏好，不是动作。挪进来，动作行就只剩动作。 */}
              <div className="gm-settings-row">
                <span className="gm-muted">{t('settings.pull')}</span>
                {([false, true] as const).map((rebase) => (
                  <button
                    key={String(rebase)}
                    className={`gm-btn${getPullRebase() === rebase ? ' primary' : ''}`}
                    onClick={() => { setPullRebaseFlag(rebase); forceRender((x) => x + 1) }}
                  >{rebase ? t('pull.rebase') : t('changes.pull')}</button>
                ))}
              </div>
              <div className="gm-muted" style={{ fontSize: 9, opacity: 0.6 }}>dsh-git-manager v{GM_VERSION}</div>
            </div>
          ) : null}
      </div>
      <FlowStrip flow={flow} />
      <div className="gm-tabs" role="tablist">
        {tabs.map(([id, key]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            title={t(key)}
            className={`gm-tab${tab === id ? ' on' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon className="gm-ic" name={TAB_ICONS[id]} size={13} />
            {t(key)}
            {id === 'agent' && pendingApprovals > 0 ? <span className="gm-badge">{pendingApprovals}</span> : null}
          </button>
        ))}
      </div>
      <OpBanner />
      <div className="gm-body">
        {!path ? <Empty icon="folder" title={t('repo.none')} /> : (
          <>
            <ConflictStrip api={api} path={path} />
            {tab === 'branches' && <Branches api={api} path={path} />}
            {tab === 'changes' && <Changes api={api} path={path} flow={flow} />}
            {tab === 'graph' && <Graph api={api} path={path} />}
            {tab === 'prs' && <PRs api={api} repoInfo={repoInfo} auth={authState} />}
            {tab === 'issues' && <Issues api={api} repoInfo={repoInfo} auth={authState} />}
            {tab === 'github' && <GitHubView api={api} path={path} repoInfo={repoInfo} auth={authState} reloadAuth={reloadAuth} onGotoPrs={() => setTab('prs')} device={device} deviceBusy={deviceBusy} onStartDevice={startDevice} onCheckDevice={checkDevice} onCancelDevice={() => setDevice(null)} onCloned={(newPath) => { void api.workspaces().then((ws) => { setWorkspaces(ws); setPath(newPath); setTick((x) => x + 1) }).catch(() => {}) }} />}
            {tab === 'agent' && <AgentView api={api} events={agentEvents} />}
          </>
        )}
      </div>
    </div>
  )
}

export function CompassPanel(props: CompassPanelProps): JSX.Element {
  return (
    <PanelErrorBoundary>
      <CompassPanelInner {...props} />
    </PanelErrorBoundary>
  )
}
