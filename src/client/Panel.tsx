/**
 * gitcompass — main panel: repo picker, guided flow strip, and the
 * Changes / Graph / PRs / GitHub views. The flow strip is the visual
 * guidance: the six GitHub-Flow steps light up as the workspace advances
 * through them (branch → commit → push → PR → review → merge).
 * @module gitcompass/client/Panel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitcompassApi, type BranchesView, type FlowSnapshot, type GitHubAuthState, type GraphView, type PullRequestSummary, type WorkspaceEntry, type OpResult, type RepoInfo, type PullRequestDetail } from './api.ts'
import { t } from './i18n.ts'

const css = `
.gitcompass-panel{font-size:12px;line-height:1.5;color:var(--dsh-text,inherit);display:flex;flex-direction:column;height:100%;min-width:0}
.gitcompass-panel *{box-sizing:border-box}
.gc-head{padding:8px;border-bottom:1px solid rgba(128,128,128,.2)}
.gc-repo{display:flex;gap:6px;align-items:center}
.gc-repo select{flex:1;min-width:0;background:transparent;border:1px solid rgba(128,128,128,.3);border-radius:4px;padding:3px 6px;color:inherit}
.gc-flow{display:flex;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.2);overflow-x:auto}
.gc-step{display:flex;align-items:center;gap:3px;white-space:nowrap;padding:2px 5px;border-radius:10px;opacity:.45}
.gc-step.done{opacity:1;background:rgba(46,160,67,.14);color:#2ea043}
.gc-step.active{opacity:1;background:rgba(46,160,67,.14);color:#2ea043;outline:1px solid rgba(46,160,67,.4)}
.gc-step .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.gc-step.active .dot{animation:gc-pulse 1.2s infinite}
@keyframes gc-pulse{50%{opacity:.35}}
.gc-arrow{opacity:.3}
.gc-tabs{display:flex;border-bottom:1px solid rgba(128,128,128,.2)}
.gc-tab{flex:1;text-align:center;padding:6px 0;cursor:pointer;opacity:.6;border-bottom:2px solid transparent}
.gc-tab.on{opacity:1;border-bottom-color:#2ea043}
.gc-body{flex:1;overflow:auto;padding:8px}
.gc-row{display:flex;gap:6px;align-items:center;padding:3px 4px;border-radius:4px}
.gc-row:hover{background:rgba(128,128,128,.08)}
.gc-row .gc-file{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-chip{font-size:10px;padding:1px 6px;border-radius:8px;border:1px solid rgba(128,128,128,.35)}
.gc-chip.green{color:#2ea043;border-color:rgba(46,160,67,.5)}
.gc-chip.red{color:#f85149;border-color:rgba(248,81,73,.5)}
.gc-chip.amber{color:#d29922;border-color:rgba(210,153,34,.5)}
.gc-btn{background:transparent;border:1px solid rgba(128,128,128,.35);border-radius:4px;padding:2px 8px;cursor:pointer;color:inherit}
.gc-btn:hover{border-color:#2ea043;color:#2ea043}
.gc-btn.primary{background:#2ea043;border-color:#2ea043;color:#fff}
.gc-input{background:transparent;border:1px solid rgba(128,128,128,.3);border-radius:4px;padding:3px 6px;color:inherit;width:100%}
.gc-commit{display:flex;gap:5px;align-items:center;padding:3px 0;border-bottom:1px solid rgba(128,128,128,.08)}
.gc-commit .sha{font-family:monospace;font-size:10px;opacity:.7}
.gc-commit .sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-pr{border:1px solid rgba(128,128,128,.2);border-radius:6px;padding:6px;margin-bottom:6px;cursor:pointer}
.gc-pr:hover{border-color:#2ea043}
.gc-pr .t{font-weight:600}
.gc-muted{opacity:.6}
.gc-err{color:#f85149;padding:6px;white-space:pre-wrap}
.gc-empty{opacity:.5;padding:10px;text-align:center}
`

interface Props {
  api: GitcompassApi
  sessions: {
    list: {
      getSnapshot(): { current?: string; byId: Record<string, { cwd?: string }> }
      subscribe(fn: () => void): () => void
    }
  }
}

function FlowStrip({ flow }: { flow: FlowSnapshot | null }) {
  const order = ['branch', 'commit', 'push', 'pr', 'review', 'merge']
  const labels: Record<string, string> = { branch: 'flow.branch', commit: 'flow.commit', push: 'flow.push', pr: 'flow.pr', review: 'flow.review', merge: 'flow.merge' }
  if (!flow) return <div className="gc-flow"><span className="gc-muted">{t('common.loading')}</span></div>
  const stepMap = new Map(flow.steps.map((s) => [s.id, s]))
  return (
    <div className="gc-flow" title={`${flow.repo} · ${flow.current}${flow.ahead ? ` · ↑${flow.ahead}` : ''}${flow.behind ? ` · ↓${flow.behind}` : ''}${flow.prNumber ? ` · PR #${flow.prNumber}` : ''}`}>
      {order.map((id, i) => {
        const s = stepMap.get(id)
        const cls = s?.phase === 2 ? 'done' : s?.phase === 1 ? 'active' : ''
        return (
          <span key={id} className="gc-step-wrap" style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 ? <span className="gc-arrow">›</span> : null}
            <span className={`gc-step ${cls}`}><span className="dot" />{t(labels[id])}</span>
          </span>
        )
      })}
    </div>
  )
}

function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs: number): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((x) => x + 1), [])
  useEffect(() => {
    let alive = true
    const run = async (): Promise<void> => {
      try {
        const value = await fn()
        if (alive) { setData(value); setError(null) }
      } catch (e) {
        if (alive) setError(String(e instanceof Error ? e.message : e))
      }
    }
    void run()
    const timer = setInterval(run, intervalMs)
    return () => { alive = false; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, reload }
}

function Changes({ api, path }: { api: GitcompassApi; path: string }) {
  const { data, error, reload } = usePoll(() => api.status(path), [path], 4000)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (kind: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(kind)
    try { await fn(); reload() } catch (e) { alert(String(e instanceof Error ? e.message : e)) } finally { setBusy(null) }
  }

  const lines = useMemo(() => (data?.output ?? '').split('\n').filter(Boolean), [data])
  const grouped = useMemo(() => {
    const g: Record<string, string[]> = { '?? ': [], 'A ': [], 'M ': [], 'D ': [], 'R ': [], other: [] }
    for (const line of lines) {
      const code = line.slice(0, 2)
      const file = line.slice(3)
      if (code.startsWith('??')) g['?? '].push(file)
      else if (code === 'A ') g['A '].push(file)
      else if (code === 'M ' || code === ' M' || code === 'MM') g['M '].push(file)
      else if (code === 'D ') g['D '].push(file)
      else g.other.push(line)
    }
    return g
  }, [lines])

  const groups: Array<[string, string]> = [['A ', t('changes.staged')], ['?? ', t('changes.untracked')], ['M ', t('changes.unstaged')], ['D ', t('changes.unstaged')]]

  return (
    <div>
      <div className="gc-row" style={{ justifyContent: 'space-between' }}>
        <span className="gc-muted">{data?.ok === true && lines.length === 0 ? t('changes.clean') : `${lines.length} files`}</span>
        <span style={{ display: 'flex', gap: 4 }}>
          <button className="gc-btn" onClick={() => act('stage', () => api.stageAll(path))} disabled={busy !== null}>{t('changes.stageAll')}</button>
          <button className="gc-btn" onClick={() => act('fetch', () => api.fetch(path))} disabled={busy !== null}>{t('changes.fetch')}</button>
          <button className="gc-btn" onClick={() => act('pull', () => api.pull(path))} disabled={busy !== null}>{t('changes.pull')}</button>
          <button className="gc-btn" onClick={() => act('push', () => api.push(path))} disabled={busy !== null}>{t('changes.push')}</button>
        </span>
      </div>
      {error ? <div className="gc-err">{error}</div> : null}
      {groups.map(([key, label]) => {
        const files = grouped[key]
        if (!files.length) return null
        return (
          <div key={key}>
            <div className="gc-muted" style={{ marginTop: 6 }}>{label}（{files.length}）</div>
            {files.map((file) => (
              <div className="gc-row" key={file}>
                <span className="gc-file">{file}</span>
                {key === '?? ' ? (
                  <button className="gc-btn" onClick={() => act('stage', () => api.stage(path, file))} disabled={busy !== null}>{t('actions.stage')}</button>
                ) : (
                  <button className="gc-btn" onClick={() => act('unstage', () => api.unstage(path, file))} disabled={busy !== null}>{t('actions.unstage')}</button>
                )}
              </div>
            ))}
          </div>
        )
      })}
      {lines.length > 0 ? (
        <div className="gc-row" style={{ marginTop: 8 }}>
          <input className="gc-input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('changes.commitMessage')} />
          <button className="gc-btn primary" onClick={() => act('commit', () => api.commit(path, message))} disabled={busy !== null || !message.trim()}>{t('changes.commit')}</button>
        </div>
      ) : null}
    </div>
  )
}

function Graph({ api, path }: { api: GitcompassApi; path: string }) {
  const { data } = usePoll<GraphView>(() => api.graph(path), [path], 8000)
  if (!data) return <div className="gc-empty">{t('common.loading')}</div>
  return (
    <div>
      {data.commits.map((c) => (
        <div className="gc-commit" key={c.sha}>
          <span className="sha">{c.sha.slice(0, 7)}</span>
          <span className="sub">{c.subject}</span>
          {c.prNumber ? <span className="gc-chip green">PR #{c.prNumber}</span> : null}
          <span className="gc-muted">{c.author}</span>
        </div>
      ))}
    </div>
  )
}

function GitHubView({ api, path, repoInfo }: { api: GitcompassApi; path: string; repoInfo: RepoInfo | null }) {
  const { data: auth, reload } = usePoll<GitHubAuthState>(() => api.githubAuth(), [], 5000)
  const [device, setDevice] = useState<Awaited<ReturnType<typeof api.deviceStart>> | null>(null)
  const [pat, setPat] = useState('')
  const [busy, setBusy] = useState(false)

  const start = async (): Promise<void> => {
    setBusy(true)
    try { setDevice(await api.deviceStart()) } catch (e) { alert(String(e instanceof Error ? e.message : e)) } finally { setBusy(false) }
  }
  const poll = async (): Promise<void> => {
    if (!device) return
    setBusy(true)
    try {
      const r = await api.devicePoll(device.deviceCode, device.interval)
      if (!r.pending) { setDevice(null); reload() }
    } catch (e) { alert(String(e instanceof Error ? e.message : e)) } finally { setBusy(false) }
  }
  const savePat = async (): Promise<void> => {
    setBusy(true)
    try { await api.tokenInput(pat); setPat(''); reload() } catch (e) { alert(String(e instanceof Error ? e.message : e)) } finally { setBusy(false) }
  }

  return (
    <div>
      {auth?.connected ? (
        <div>
          <div className="gc-row"><span className="gc-chip green">{t('github.connected')}</span><span>{auth.login}</span><span className="gc-muted">({auth.source})</span></div>
          {auth.scopes?.length ? <div className="gc-muted" style={{ marginTop: 4 }}>{t('github.scopes')}: {auth.scopes.join(', ')}</div> : null}
          {repoInfo ? <div className="gc-row" style={{ marginTop: 6 }}><span className="gc-chip">{repoInfo.owner}/{repoInfo.repo}</span>{repoInfo.branch ? <span className="gc-muted">@{repoInfo.branch}</span> : null}{repoInfo.prNumber ? <span className="gc-chip green">PR #{repoInfo.prNumber}</span> : null}</div> : null}
          <button className="gc-btn" style={{ marginTop: 8 }} onClick={async () => { await api.logout(); reload() }}>{t('github.logout')}</button>
        </div>
      ) : (
        <div>
          <div className="gc-empty">{t('github.notConnected')}</div>
          {device ? (
            <div>
              <div className="gc-row"><span className="gc-chip amber">{t('github.code')}: <b>{device.userCode}</b></span></div>
              <div className="gc-row"><a className="gc-btn" href={device.verificationUri} target="_blank" rel="noreferrer">{t('github.openUrl')}</a></div>
              <div className="gc-muted" style={{ padding: 4 }}>{t('github.loginHint')}</div>
              <button className="gc-btn primary" onClick={poll} disabled={busy}>{t('github.polling')}</button>
            </div>
          ) : (
            <button className="gc-btn primary" onClick={start} disabled={busy}>{t('github.login')}</button>
          )}
          <div style={{ marginTop: 12 }}>
            <div className="gc-muted">{t('github.pat')}</div>
            <div className="gc-row">
              <input className="gc-input" type="password" value={pat} onChange={(e) => setPat(e.target.value)} />
              <button className="gc-btn" onClick={savePat} disabled={!pat.trim()}>{t('github.patBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PRs({ api, repoInfo }: { api: GitcompassApi; repoInfo: RepoInfo | null }) {
  const { data: prs, reload } = usePoll<PullRequestSummary[]>(
    () => (repoInfo ? api.listPRs(repoInfo.owner, repoInfo.repo, 'open') : Promise.resolve([])),
    [repoInfo?.owner, repoInfo?.repo],
    10000,
  )
  const [detail, setDetail] = useState<PullRequestDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ title: '', base: 'main', body: '' })
  const [busy, setBusy] = useState(false)

  if (!repoInfo?.connected) return <div className="gc-empty">{t('github.notConnected')}</div>
  if (detail) {
    return (
      <div>
        <button className="gc-btn" onClick={() => setDetail(null)}>←</button>
        <h3 style={{ margin: '6px 0' }}>#{detail.number} {detail.title}</h3>
        <div className="gc-row">
          <span className={`gc-chip ${detail.state === 'merged' ? 'green' : detail.state === 'open' ? 'amber' : 'red'}`}>{detail.state}</span>
          <span className="gc-muted">{detail.head} → {detail.base}</span>
        </div>
        {detail.checks ? <div className="gc-row"><span className="gc-chip green">✓ {detail.checks.passing}</span><span className="gc-chip red">✗ {detail.checks.failing}</span><span className="gc-chip amber">… {detail.checks.pending}</span></div> : null}
        {detail.body ? <div className="gc-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{detail.body}</div> : null}
        <div style={{ marginTop: 8 }}>
          <div className="gc-muted">{t('prs.checks')} ({detail.checkRuns.length})</div>
          {detail.checkRuns.map((c) => (
            <div className="gc-row" key={c.name}>
              <span className="gc-file">{c.name}</span>
              <span className={`gc-chip ${c.conclusion === 'success' ? 'green' : c.conclusion === 'failure' ? 'red' : 'amber'}`}>{c.conclusion ?? c.status}</span>
            </div>
          ))}
        </div>
        <div className="gc-muted" style={{ marginTop: 8 }}>{t('prs.reviews')} ({detail.reviews.length})</div>
        {detail.reviews.map((r, i) => (
          <div className="gc-row" key={i}><span className="gc-chip">{r.state}</span><span>{r.user}</span>{r.body ? <span className="gc-muted">{r.body}</span> : null}</div>
        ))}
        {detail.state === 'open' ? (
          <div className="gc-row" style={{ marginTop: 10 }}>
            <button className="gc-btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await api.mergePR(repoInfo.owner, repoInfo.repo, detail.number, 'squash'); reload(); setDetail(null) } catch (e) { alert(String(e instanceof Error ? e.message : e)) } finally { setBusy(false) } }}>{t('prs.squash')}</button>
          </div>
        ) : null}
      </div>
    )
  }

  if (creating) {
    return (
      <div>
        <button className="gc-btn" onClick={() => setCreating(false)}>←</button>
        <div className="gc-row" style={{ marginTop: 6 }}><input className="gc-input" placeholder={t('prs.title')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
        <div className="gc-row"><span className="gc-muted">{t('prs.head')} {repoInfo.branch} → {t('prs.base')}</span><input className="gc-input" style={{ width: 120 }} value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} /></div>
        <div className="gc-row"><textarea className="gc-input" rows={4} placeholder="Description" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
        <button className="gc-btn primary" disabled={!form.title.trim() || !repoInfo.branch} onClick={async () => {
          setBusy(true)
          try {
            await api.createPR(repoInfo.owner, repoInfo.repo, { title: form.title, body: form.body, head: repoInfo.branch, base: form.base })
            setCreating(false); reload()
          } catch (e) { alert(String(e instanceof Error ? e.message : e)) } finally { setBusy(false) }
        }}>{t('prs.createBtn')}</button>
      </div>
    )
  }

  return (
    <div>
      <div className="gc-row" style={{ justifyContent: 'space-between' }}>
        <span className="gc-muted">{t('prs.open')}</span>
        <button className="gc-btn primary" onClick={() => setCreating(true)} disabled={!repoInfo.branch}>{t('prs.create')}</button>
      </div>
      {prs?.length ? prs.map((pr) => (
        <div className="gc-pr" key={pr.number} onClick={() => { void api.prDetail(repoInfo.owner, repoInfo.repo, pr.number).then(setDetail).catch((e) => alert(String(e instanceof Error ? e.message : e))) }}>
          <div className="t">#{pr.number} {pr.title}</div>
          <div className="gc-muted">{pr.head} → {pr.base} · {pr.user}{pr.draft ? ` · ${t('prs.draft')}` : ''}</div>
          {pr.checks ? <div className="gc-row"><span className="gc-chip green">✓ {pr.checks.passing}</span><span className="gc-chip red">✗ {pr.checks.failing}</span><span className="gc-chip amber">… {pr.checks.pending}</span></div> : null}
        </div>
      )) : <div className="gc-empty">{t('prs.empty')}</div>}
    </div>
  )
}

export function CompassPanel({ api, sessions }: Props): JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([])
  const [path, setPath] = useState<string>('')
  const [tab, setTab] = useState<'changes' | 'graph' | 'prs' | 'github'>('changes')
  const [flow, setFlow] = useState<FlowSnapshot | null>(null)
  const [branches, setBranches] = useState<BranchesView | null>(null)
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    void api.workspaces().then((ws) => {
      setWorkspaces(ws)
      if (ws.length > 0 && !path) {
        // 默认选当前会话的 cwd（若在列表中）。
        const current = sessions.list.getSnapshot().current
        const cwd = current ? sessions.list.getSnapshot().byId[current]?.cwd : undefined
        const match = cwd ? ws.find((w) => cwd.startsWith(w.path)) : undefined
        setPath(match?.path ?? ws[0].path)
      }
    }).catch((e) => console.error('gitcompass: workspaces', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!path) return
    const load = (): void => {
      void api.flow(path).then(setFlow).catch(() => setFlow(null))
      void api.branches(path).then(setBranches).catch(() => setBranches(null))
      void api.repoInfo(path).then(setRepoInfo).catch(() => setRepoInfo(null))
    }
    load()
    const timer = setInterval(load, 6000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick])

  useEffect(() => {
    // dataset 是只读 getter，不能用 Object.assign 赋值——直接写属性。
    if (!document.querySelector('style[data-plugin="gitcompass-css"]')) {
      const style = document.createElement('style')
      style.dataset.plugin = 'gitcompass-css'
      style.textContent = css
      document.head.appendChild(style)
    }
  }, [])

  return (
    <div className="gitcompass-panel">
      <div className="gc-head">
        <div className="gc-repo">
          <select value={path} onChange={(e) => { setPath(e.target.value); setTick((x) => x + 1) }}>
            {workspaces.length === 0 ? <option value="">{t('repo.none')}</option> : null}
            {workspaces.map((w) => <option key={w.path} value={w.path}>{w.title || w.path.split(/[\\/]/).pop()}</option>)}
          </select>
          <button className="gc-btn" onClick={() => setTick((x) => x + 1)} title={t('common.refresh')}>↻</button>
        </div>
      </div>
      <FlowStrip flow={flow} />
      <div className="gc-tabs">
        {(['changes', 'graph', 'prs', 'github'] as const).map((k) => (
          <div key={k} className={`gc-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{t(`tab.${k}`)}</div>
        ))}
      </div>
      <div className="gc-body">
        {!path ? <div className="gc-empty">{t('repo.none')}</div> : (
          <>
            {tab === 'changes' ? <Changes api={api} path={path} /> : null}
            {tab === 'graph' ? <Graph api={api} path={path} /> : null}
            {tab === 'prs' ? <PRs api={api} repoInfo={repoInfo} /> : null}
            {tab === 'github' ? <GitHubView api={api} path={path} repoInfo={repoInfo} /> : null}
          </>
        )}
      </div>
    </div>
  )
}
