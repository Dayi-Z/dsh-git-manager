/**
 * gitcompass — main panel: repo picker, guided flow strip, and the
 * Branches / Changes / Graph / PRs / Issues / GitHub / Agent views.
 * The Agent view hosts the live activity monitor plus the file-level
 * approval cards (per-file tabs, full-file side-by-side compare).
 * @module gitcompass/client/Panel
 */

import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  GitcompassApi,
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

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const css = `
/* Theme tokens — mirror DSH's light/dark switch (body[data-ds-dark-theme]).
   GitHub light/dark accent palettes for correct contrast in both themes. */
.gitcompass-panel{
  --gc-mono:ui-monospace,SFMono-Regular,'Cascadia Code',Menlo,Consolas,'Courier New',monospace;
  --gc-bg:#ffffff; --gc-bg-soft:#f6f7f8; --gc-fg:#1f2328;
  --gc-hover:rgba(0,0,0,.05); --gc-border:rgba(0,0,0,.13); --gc-border-strong:rgba(0,0,0,.24);
  --gc-shadow:0 8px 24px rgba(0,0,0,.10);
  --gc-accent:#1a7f37; --gc-accent-soft:rgba(26,127,55,.11);
  --gc-red:#cf222e; --gc-amber:#9a6700; --gc-info:#0969da;
  --gc-del-bg:rgba(207,34,46,.16); --gc-add-bg:rgba(26,127,55,.18);
  font-size:12px;line-height:1.5;color:var(--gc-fg);display:flex;flex-direction:column;height:100%;min-width:0
}
/* 浏览器表面也属于设计：滚动条 / 选区 / 焦点全部主题化 */
.gitcompass-panel ::selection{background:var(--gc-accent-soft)}
.gitcompass-panel *::-webkit-scrollbar{width:9px;height:9px}
.gitcompass-panel *::-webkit-scrollbar-thumb{background:var(--gc-border-strong);border-radius:5px;border:2px solid transparent;background-clip:content-box}
.gitcompass-panel *::-webkit-scrollbar-thumb:hover{background-color:var(--gc-fg);background-clip:content-box;opacity:.5}
.gitcompass-panel *::-webkit-scrollbar-track{background:transparent}
body[data-ds-dark-theme] .gitcompass-panel{
  --gc-bg:#161b22; --gc-bg-soft:#1d232c; --gc-fg:#e6edf3;
  --gc-hover:rgba(255,255,255,.06); --gc-border:rgba(255,255,255,.13); --gc-border-strong:rgba(255,255,255,.24);
  --gc-shadow:0 8px 24px rgba(0,0,0,.35);
  --gc-accent:#3fb950; --gc-accent-soft:rgba(63,185,80,.13);
  --gc-red:#f85149; --gc-amber:#d29922; --gc-info:#58a6ff;
  --gc-del-bg:rgba(248,81,73,.22); --gc-add-bg:rgba(46,160,67,.22);
}
.gitcompass-panel *{box-sizing:border-box;font-family:inherit}
.gc-head{padding:8px;border-bottom:1px solid var(--gc-border)}
.gc-repo{display:flex;gap:6px;align-items:center}
.gc-repo select{flex:1;min-width:0;background:transparent;border:1px solid var(--gc-border);border-radius:6px;padding:3px 6px;color:var(--gc-fg);transition:border-color .12s}
.gc-repo select option{background:var(--gc-bg);color:var(--gc-fg)}
.gc-repo select option:checked{font-weight:600}
.gc-repo select:focus{outline:none;border-color:var(--gc-accent)}
.gc-flow{display:flex;align-items:center;gap:2px;padding:6px 8px;border-bottom:1px solid var(--gc-border);overflow-x:auto}
.gc-step{display:flex;align-items:center;gap:3px;white-space:nowrap;padding:2px 6px;border-radius:10px;opacity:.55}
.gc-step.done{opacity:1;background:var(--gc-accent-soft);color:var(--gc-accent)}
.gc-step.active{opacity:1;background:var(--gc-accent-soft);color:var(--gc-accent);outline:1px solid var(--gc-accent)}
.gc-step .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.gc-step.active .dot{animation:gc-pulse 1.2s infinite}
@keyframes gc-pulse{50%{opacity:.35}}
.gc-arrow{opacity:.3}
.gc-tabs{display:flex;border-bottom:1px solid var(--gc-border);overflow-x:auto;padding:0 4px;gap:2px}
.gc-tab{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:7px 2px;cursor:pointer;opacity:.6;border-bottom:2px solid transparent;white-space:nowrap;font-size:11.5px;font-weight:500;transition:opacity .15s,color .15s,border-color .15s;border-radius:0}
.gc-tab .gc-ic{opacity:.85}
.gc-tab:hover{opacity:1;background:var(--gc-hover)}
.gc-tab.on{opacity:1;border-bottom-color:var(--gc-accent);color:var(--gc-accent);font-weight:600}
.gc-body{flex:1;overflow:auto;padding:8px}
.gc-row{display:flex;gap:6px;align-items:center;padding:3px 5px;border-radius:5px}
/* 文件行：类型图标 + 加权文件名 + 弱化目录 + 状态字母；悬停显操作并给底色 */
.gc-filerow{display:flex;gap:6px;align-items:center;padding:3px 5px;border-radius:5px;cursor:pointer;transition:background .12s}
.gc-filerow:hover{background:var(--gc-hover)}
.gc-filerow .gc-file{font-weight:500}
.gc-filerow .gc-path{opacity:.55;font-size:10.5px}
.gc-filerow .actions{margin-left:auto}
.gc-row:hover{background:var(--gc-hover)}
.gc-row .gc-file{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;font-size:12px}
.gc-chip{font-size:10px;padding:2px 7px;border-radius:6px;border:1px solid var(--gc-border-strong);background:var(--gc-bg-soft);opacity:.95}
.gc-chip.green{color:var(--gc-accent);border-color:var(--gc-accent);background:var(--gc-accent-soft)}
.gc-chip.red{color:var(--gc-red);border-color:var(--gc-red);background:var(--gc-del-bg)}
.gc-chip.amber{color:var(--gc-amber);border-color:var(--gc-amber);background:var(--gc-add-bg)}
.gc-chip-x{background:none;border:none;color:inherit;cursor:pointer;opacity:.6;margin-left:5px;padding:0;font-size:10px;line-height:1}
.gc-chip-x:hover{opacity:1}
/* 按钮：统一高度/圆角/状态；accent 只给主操作与选中态（Operate 纪律） */
.gc-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;background:transparent;border:1px solid var(--gc-border-strong);border-radius:6px;padding:3px 10px;cursor:pointer;color:inherit;font-size:11.5px;font-weight:500;line-height:1.5;white-space:nowrap;transition:background .15s,border-color .15s,color .15s,transform .06s}
.gc-btn:hover{border-color:var(--gc-border-strong);background:var(--gc-hover)}
.gc-btn:active{transform:translateY(.5px)}
.gc-btn.sm{padding:2px 5px;min-width:22px;height:22px}
.gc-btn.primary{background:var(--gc-accent);border-color:var(--gc-accent);color:#fff}
.gc-btn.primary:hover{background:var(--gc-accent);filter:brightness(1.08)}
.gc-btn.danger{border-color:var(--gc-red);color:var(--gc-red)}
.gc-btn.danger:hover{background:var(--gc-red);border-color:var(--gc-red);color:#fff}
.gc-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.gc-btn:disabled:hover{background:transparent;border-color:var(--gc-border-strong);color:inherit}
.gc-btn.primary:disabled:hover{background:var(--gc-accent)}
.gc-btn.danger:disabled:hover{color:var(--gc-red);border-color:var(--gc-red)}
.gitcompass-panel :focus-visible{outline:2px solid var(--gc-accent);outline-offset:1px}
.gc-input{background:transparent;border:1px solid var(--gc-border-strong);border-radius:6px;padding:4px 8px;color:inherit;width:100%;transition:border-color .12s,box-shadow .12s}
.gc-input:focus,.gc-textarea:focus{outline:none;border-color:var(--gc-accent);box-shadow:0 0 0 2px var(--gc-accent-soft)}
.gc-input::placeholder,.gc-textarea::placeholder{opacity:.45}
.gc-textarea{background:transparent;border:1px solid var(--gc-border-strong);border-radius:6px;padding:5px 8px;color:inherit;width:100%;resize:vertical;font-size:12px;transition:border-color .12s,box-shadow .12s}
.gc-commit{display:flex;gap:5px;align-items:center;padding:3px 0;border-bottom:1px solid var(--gc-border)}
.gc-commit .sha{cursor:pointer;font-family:var(--gc-mono);font-size:10px;opacity:.7}
.gc-commit .sha:hover{opacity:1;color:var(--gc-accent)}
.gc-commit .sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-pr{border:1px solid var(--gc-border);border-radius:8px;padding:7px 8px;margin-bottom:6px;cursor:pointer;transition:border-color .12s,box-shadow .12s}
.gc-pr:hover{border-color:var(--gc-accent);box-shadow:var(--gc-shadow)}
.gc-pr .t{font-weight:600}
.gc-muted{opacity:.6}
.gc-err{color:var(--gc-red);padding:6px;white-space:pre-wrap}
.gc-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:22px 12px;text-align:center;color:var(--gc-fg)}
.gc-empty .gc-ic{opacity:.35}
.gc-empty .t{font-weight:600;font-size:12px}
.gc-empty .h{opacity:.55;font-size:11px;max-width:240px}
.gc-branch{display:flex;flex-direction:column;padding:5px 6px;border-radius:4px}
.gc-branch:hover{background:var(--gc-hover)}
.gc-branch .name-row{display:flex;align-items:center;gap:6px;min-width:0}
.gc-branch .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--gc-mono);font-size:11px}
.gc-branch .actions{display:flex;gap:3px;margin-left:auto;flex:none}
.gc-branch .meta{display:flex;gap:8px;align-items:center;font-size:10.5px;opacity:.85;margin-top:2px;min-width:0}
.gc-divbar{display:inline-flex;height:6px;border-radius:3px;overflow:hidden;background:var(--gc-hover);flex:none}
.gc-divbar .behind{background:var(--gc-red);height:100%}
.gc-divbar .ahead{background:var(--gc-accent);height:100%}
.gc-issue{border:1px solid var(--gc-border);border-radius:8px;padding:7px 8px;margin-bottom:6px;cursor:pointer;transition:border-color .12s,box-shadow .12s}
.gc-issue:hover{border-color:var(--gc-accent);box-shadow:var(--gc-shadow)}
.gc-diff{font-family:var(--gc-mono);font-size:11px;line-height:1.6;padding:4px 0;background:var(--gc-bg-soft);border-radius:6px;margin:4px 0;overflow:auto;max-height:320px;white-space:pre}
/* 统一 diff 行级着色：删除红底 / 新增绿底（加深），hunk 与文件元信息弱化 */
.gc-dl{display:block;padding:0 10px}
.gc-dl.add{background:var(--gc-add-bg)}
.gc-dl.del{background:var(--gc-del-bg)}
.gc-dl.hunk{color:var(--gc-info);opacity:.8}
.gc-dl.meta{opacity:.42;font-size:10px}
/* Trae 式变更页 */
.gc-commitbox{display:flex;gap:6px;margin-bottom:8px}
/* 提交框内联的次要提交动作（撤销/修补）：紧凑图标钮，视觉上属于"提交"动词组 */
.gc-commitbox .gc-btn{flex:none}
.gc-commitbox .gc-input{flex:1;min-width:0}
/* 变更页工具栏：统一 26px 高、图标钮等宽、允许优雅换行不粘连 */
.gc-changes-bar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:3px 5px}
.gc-changes-bar .gc-btn{padding:3px 9px}
.gc-changes-bar .sep{width:1px;height:16px;background:var(--gc-border);flex:none;margin:0 2px}
/* 传出的更改行：sha 与标题之间留呼吸，标题单行省略 */
.gc-outrow{display:flex;gap:8px;align-items:center;padding:2px 5px;min-width:0}
.gc-outrow .sha{flex:none}
.gc-outrow .sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
/* 贮藏库：紧凑行内列表 */
.gc-stashlist{border:1px solid var(--gc-border);border-radius:6px;padding:4px 6px;margin:0 0 6px;background:var(--gc-bg-soft);display:flex;flex-direction:column;gap:1px}
.gc-stashlist .sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-commitbox .gc-input{flex:1;min-width:0}
.gc-path{opacity:.45;font-size:10px;font-family:var(--gc-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}
.gc-st{flex:none;font-family:var(--gc-mono);font-size:10px;font-weight:700;line-height:1;padding:3px 5px;border-radius:4px;border:1px solid var(--gc-border);opacity:.75;min-width:18px;text-align:center}
.gc-st.add{color:var(--gc-accent);border-color:var(--gc-accent)}
.gc-st.mod{color:var(--gc-amber);border-color:var(--gc-amber)}
.gc-st.del{color:var(--gc-red);border-color:var(--gc-red)}
.gc-st.ren{color:var(--gc-info);border-color:var(--gc-info)}
.gc-folder{display:flex;gap:5px;align-items:center;padding:2px 4px;border-radius:5px;cursor:pointer;font-family:var(--gc-mono);font-size:11px}
.gc-folder:hover{background:var(--gc-bg-soft)}
.gc-caret{opacity:.5;font-size:9px;width:10px;flex:none}
.gc-numstat{font-family:var(--gc-mono);font-size:10px;color:var(--gc-accent);opacity:.85}
.gc-numstat.del{color:var(--gc-red)}
.gc-drill .gc-file{font-size:11px;font-weight:400}

/* 操作反馈横幅 + 结果卡：状态必须可见，且可追溯可复制 */
.gc-banner{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-bottom:1px solid var(--gc-border);animation:gc-banner-in .18s ease-out}
.gc-banner.ok{background:var(--gc-accent-soft)}
.gc-banner.err{background:var(--gc-del-bg)}
.gc-banner.ok>.gc-bic{color:var(--gc-accent)}
.gc-banner.err>.gc-bic{color:var(--gc-red)}
.gc-banner-body{flex:1;min-width:0}
.gc-banner-body .t{font-weight:600;font-size:12px}
.gc-banner.ok .t{color:var(--gc-accent)}
.gc-banner.err .t{color:var(--gc-red)}
.gc-banner-body .d{font-family:var(--gc-mono);font-size:10.5px;white-space:pre-wrap;word-break:break-word;margin:5px 0 0;padding:6px 8px;background:var(--gc-bg);border:1px solid var(--gc-border);border-radius:6px;max-height:190px;overflow:auto}
.gc-banner-x{background:none;border:none;color:inherit;cursor:pointer;opacity:.55;padding:2px;border-radius:4px}
.gc-banner-x:hover{opacity:1;background:var(--gc-hover)}
@keyframes gc-banner-in{from{opacity:0;transform:translateY(-5px)}}
.gc-review-btns{display:flex;gap:4px;margin-top:6px}
.gc-section{margin-top:14px}
.gc-section .head{font-weight:600;margin-bottom:6px;opacity:.55;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.gc-lane{display:inline-block;width:12px}
.gc-lane-line{display:inline-block;width:2px;height:16px;vertical-align:middle;border-radius:1px}

/* Agent activity monitor */
.gc-agent{display:flex;flex-direction:column;height:100%}
.gc-agent-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--gc-border);position:sticky;top:0;background:var(--gc-bg)}
.gc-live{color:var(--gc-accent);font-size:11px}
.gc-live .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--gc-accent);margin-right:3px;animation:gc-pulse 1.6s infinite}
.gc-agent-count{opacity:.5;font-size:11px;font-family:var(--gc-mono)}
.gc-approvals{display:flex;flex-direction:column;gap:6px;padding:6px 0}
.gc-approve-card{border:1px solid var(--gc-amber);border-radius:8px;padding:7px;background:var(--gc-add-bg)}
.gc-approve-msg{font-weight:600}
.gc-approve-tool{opacity:.6;font-size:11px;font-family:var(--gc-mono);margin:2px 0 5px}
.gc-approve-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.gc-hint{opacity:0;font-size:11px;color:var(--gc-accent);transition:opacity .2s}
.gc-approve-card.done .gc-hint{opacity:1}
.gc-feed{display:flex;flex-direction:column-reverse;gap:2px;overflow:auto;flex:1;font-size:11px}
.gc-evt{display:flex;gap:5px;align-items:baseline;padding:2px 4px;border-radius:4px}
.gc-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--gc-border-strong);transform:translateY(-1px)}
.gc-evt.run .gc-dot{background:var(--gc-info)}
.gc-evt.ok .gc-dot{background:var(--gc-accent)}
.gc-evt.wait .gc-dot{background:var(--gc-amber)}
.gc-evt.err .gc-dot{background:var(--gc-red)}
.gc-tag{flex:none;font-size:9.5px;padding:0 5px;border-radius:7px;border:1px solid var(--gc-border-strong);opacity:.8}
.gc-evt.run .gc-tag{color:var(--gc-info);border-color:var(--gc-info)}
.gc-evt.ok .gc-tag{color:var(--gc-accent);border-color:var(--gc-accent)}
.gc-evt.wait .gc-tag{color:var(--gc-amber);border-color:var(--gc-amber);opacity:1}
.gc-evt.err .gc-tag{color:var(--gc-red);border-color:var(--gc-red)}
.gc-evt-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-evt.err .gc-evt-txt{white-space:pre-wrap}
.gc-evt-time{opacity:.4;font-size:10px;font-family:var(--gc-mono)}

/* File-level review: tabs + full-file side-by-side panes */
.gc-frev{margin-top:6px;border-top:1px dashed var(--gc-border-strong);padding-top:5px}
.gc-ftabs{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:5px}
.gc-ftab{border:1px solid var(--gc-border);background:transparent;color:inherit;border-radius:6px;padding:2px 7px;font-size:11px;cursor:pointer;display:inline-flex;gap:5px;align-items:center;max-width:100%;transition:border-color .12s,background .12s}
.gc-ftab:hover{border-color:var(--gc-accent)}
.gc-ftab.on{border-color:var(--gc-accent);background:var(--gc-accent-soft)}
.gc-ftab .p{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--gc-mono);font-size:10.5px}
.gc-fstats{font-family:var(--gc-mono);font-size:10px}
.gc-fstats.add{color:var(--gc-accent)}
.gc-fstats.del{color:var(--gc-red)}
.gc-cur-mark{color:var(--gc-accent)}
.gc-filediff{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--gc-border);border-radius:8px;margin:2px 0 4px;background:var(--gc-bg);overflow:hidden}
.gc-pane-head{grid-column:auto;padding:3px 8px;font-size:11px;font-weight:600;border-bottom:1px solid var(--gc-border);background:var(--gc-bg-soft)}
.gc-pane-head.before{color:var(--gc-red)}
.gc-pane-head.after{color:var(--gc-accent)}
.gc-pane{overflow:auto;max-height:360px;padding:4px 0;font-family:var(--gc-mono);font-size:11px;line-height:1.55}
.gc-ln{display:grid;grid-template-columns:38px 1fr;align-items:start}
.gc-lno{text-align:right;padding-right:7px;opacity:.45;user-select:none;font-size:10px}
.gc-ltxt{white-space:pre-wrap;word-break:break-word;padding-right:8px}
.gc-line.del{background:var(--gc-del-bg)}
.gc-line.add{background:var(--gc-add-bg)}
.gc-trunc-note{opacity:.55;font-size:10px;padding:3px 6px}

/* GitHub 式分支切换器 */
.gc-bhead{position:relative;display:flex;align-items:center;gap:8px}
.gc-bswitch{min-width:0}
.gc-bpill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--gc-border-strong);border-radius:7px;padding:5px 11px;cursor:pointer;font-family:var(--gc-mono);font-size:12.5px;font-weight:600;background:transparent;color:inherit;max-width:220px;transition:border-color .15s,background .15s}
.gc-bpill:hover{border-color:var(--gc-accent);background:var(--gc-accent-soft)}
.gc-bpill .dot{width:8px;height:8px;border-radius:50%;background:var(--gc-accent);box-shadow:0 0 0 3px var(--gc-accent-soft)}
.gc-bpill .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-bpill .cv{opacity:.45;font-size:9px;margin-left:-1px}
.gc-bsmenu{position:absolute;left:0;top:calc(100% + 6px);z-index:30;background:var(--gc-bg);border:1px solid var(--gc-border-strong);border-radius:10px;box-shadow:var(--gc-shadow);width:min(100%,420px);max-height:340px;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:2px}
.gc-bsmenu .gc-input{position:sticky;top:-6px;z-index:1;background:var(--gc-bg);padding:7px 9px;margin-bottom:4px;border-radius:7px}
.gc-bsbackdrop{position:fixed;inset:0;z-index:25}
.gc-bsrow{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:7px;cursor:pointer;transition:background .1s}
.gc-bsrow:hover{background:var(--gc-accent-soft)}
.gc-bsrow.on{background:var(--gc-accent-soft)}
.gc-bsrow .n{display:flex;gap:7px;align-items:center;font-family:var(--gc-mono);font-size:11.5px;min-width:0}
.gc-bsrow .n .cur{color:var(--gc-accent);font-size:10px}
.gc-bsrow .n > span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-bsrow .m{display:flex;gap:10px;font-size:10px;opacity:.62;padding-left:17px;min-width:0}
.gc-bssec{padding:6px 9px 2px;font-weight:600;opacity:.55;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
/* P0/P1：冲突横幅条 / 页签徽标 / 设置菜单 / 贮藏列表 */
.gc-conflict{border:1px solid var(--gc-amber);background:rgba(210,153,34,.10);border-radius:8px;padding:6px 8px;margin-bottom:8px}
.gc-conflict-head{display:flex;align-items:center;gap:6px;color:var(--gc-amber)}
.gc-conflict-head .t{font-weight:600;font-size:12px}
.gc-conflict .gc-row{color:var(--gc-fg)}
.gc-conflict-head .gc-btn{padding:1px 8px;font-size:11px}
.gc-badge{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;margin-left:4px;border-radius:8px;background:var(--gc-amber);color:#fff;font-size:9px;font-weight:700;line-height:1}
.gc-settings{position:absolute;top:34px;right:10px;z-index:60;display:flex;flex-direction:column;gap:6px;background:var(--gc-bg);border:1px solid var(--gc-border);border-radius:8px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);min-width:220px}
.gc-settings-row{display:flex;align-items:center;gap:4px}
.gc-settings-row .gc-muted{min-width:52px}
.gc-settings-row .gc-btn{padding:2px 8px;font-size:11px}
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 设置：轮询速度（localStorage 持久化；usePoll 读取缩放系数）
// ---------------------------------------------------------------------------

/** 构建标识：设置菜单页脚显示，一眼诊断浏览器端缓存滞后（与 package.json version 同步）。 */
const GC_VERSION = '1.6.3'

type PollSpeed = 'fast' | 'std' | 'slow'
const POLL_SCALE: Record<PollSpeed, number> = { fast: 0.5, std: 1, slow: 2 }
let pollSpeed: PollSpeed = (() => {
  try {
    const v = localStorage.getItem('gc.poll')
    if (v === 'fast' || v === 'std' || v === 'slow') return v
  } catch { /* no storage */ }
  return 'std'
})()
function getPollScale(): number { return POLL_SCALE[pollSpeed] }
function setPollSpeed(v: PollSpeed): void {
  pollSpeed = v
  try { localStorage.setItem('gc.poll', v) } catch { /* no storage */ }
}
function getPullRebase(): boolean {
  try { return localStorage.getItem('gc.pullRebase') === '1' } catch { return false }
}
function setPullRebaseFlag(v: boolean): void {
  try { localStorage.setItem('gc.pullRebase', v ? '1' : '0') } catch { /* no storage */ }
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
    <div className={`gc-banner ${fb.kind}`} role="status">
      <span className="gc-bic" style={{ display: 'inline-flex', marginTop: 1 }}><Icon name={fb.kind === 'ok' ? 'success' : 'alert'} size={15} /></span>
      <div className="gc-banner-body">
        <div className="t">{fb.title}</div>
        {fb.detail ? <pre className="d">{fb.detail}</pre> : null}
      </div>
      {fb.detail ? (
        <button className="gc-btn sm" title={t('common.copy')} onClick={() => { void navigator.clipboard?.writeText(fb.detail ?? '').catch(() => {}) }}><Icon name="copy" size={12} /></button>
      ) : null}
      <button className="gc-banner-x" title={t('common.close')} onClick={() => setFb(null)}><Icon name="x" size={11} /></button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Flow strip
// ---------------------------------------------------------------------------

function FlowStrip({ flow }: { flow: FlowSnapshot | null }) {
  const order = ['branch', 'commit', 'push', 'pr', 'review', 'merge']
  const labels: Record<string, string> = { branch: 'flow.branch', commit: 'flow.commit', push: 'flow.push', pr: 'flow.pr', review: 'flow.review', merge: 'flow.merge' }
  if (!flow) return <div className="gc-flow"><span className="gc-muted">{t('common.loading')}</span></div>
  const stepMap = new Map(flow.steps.map((s) => [s.id, s]))
  return (
    <div className="gc-flow" title={`${flow.repo} · ${flow.current}${flow.ahead ? ` +${flow.ahead}` : ''}${flow.behind ? ` -${flow.behind}` : ''}${flow.prNumber ? ` PR #${flow.prNumber}` : ''}`}>
      {order.map((id, i) => {
        const s = stepMap.get(id)
        const cls = s?.phase === 2 ? 'done' : s?.phase === 1 ? 'active' : ''
        return (
          <Fragment key={id}>
            {i > 0 ? <span className="gc-arrow"><Icon name="chevron-right" size={10} /></span> : null}
            <span className={`gc-step ${cls}`}><span className="dot" />{t(labels[id])}</span>
          </Fragment>
        )
      })}
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
      <span className="gc-divbar" title={`+${ahead} -${behind}`}>
        <span className="behind" style={{ width: `${(behind / total) * 64}px` }} />
        <span className="ahead" style={{ width: `${(ahead / total) * 64}px` }} />
      </span>
      <span style={{ fontFamily: 'var(--gc-mono)', fontSize: 10 }}>
        {ahead > 0 ? `↑${ahead}` : ''}{behind > 0 ? ` ↓${behind}` : ''}
      </span>
    </span>
  )
}

/** GitHub 式分支行（切换器菜单内使用）。 */
interface BsRowProps { name: string; subject?: string; date?: string; current: boolean; onPick: () => void }

function BsRow({ name, subject, date, current, onPick }: BsRowProps): JSX.Element {
  return (
    <div className={`gc-bsrow${current ? ' on' : ''}`} onClick={onPick} title={`${name}\n${subject ?? ''}`}>
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

function Branches({ api, path }: { api: GitcompassApi; path: string }): JSX.Element {
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
      <div className="gc-bsbackdrop" onClick={() => setMenuOpen(false)} />
      <div className="gc-bsmenu">
        <input className="gc-input" placeholder={t('branches.pickPlaceholder')} value={pickQuery} onChange={(e) => setPickQuery(e.target.value)} autoFocus />
        {localList.filter((b) => pickMatch(b.name)).length === 0 && remoteList.filter((b) => pickMatch(b.name)).length === 0
          ? <div className="gc-empty">{t('branches.noBranches')}</div>
          : null}
        {defaultName !== '' && pickMatch(defaultName) && localList.some((b) => b.name === defaultName) ? (
          <>
            <div className="gc-bssec">{t('branches.default')}</div>
            {localList.filter((b) => b.name === defaultName).map((b) => (
              <BsRow key={b.name} name={b.name} subject={b.subject} date={b.date} current={b.current} onPick={() => { setMenuOpen(false); setPickQuery('') }} />
            ))}
          </>
        ) : null}
        {localList.filter((b) => b.name !== defaultName && pickMatch(b.name)).length > 0 ? (
          <>
            <div className="gc-bssec">{t('branches.localAll')} ({localList.filter((b) => b.name !== defaultName).length})</div>
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
            <div className="gc-bssec">{t('branches.remote')} ({remoteList.length})</div>
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
      {error && !branches ? <div className="gc-err">{error}</div> : null}

      {/* 当前分支胶囊：菜单锚定到整行宽度，不再被胶囊宽度挤成窄条 */}
      <div className="gc-bhead">
        <div className="gc-bswitch">
          <button className="gc-bpill" onClick={() => setMenuOpen(!menuOpen)}>
            <span className="dot" /><span className="nm">{branches ? branches.current : '…'}</span><span className="cv"><Icon name="chevron-down" size={11} /></span>
          </button>
          {switcherMenu}
        </div>
      </div>

      {/* 新建分支 */}
      <div className="gc-row" style={{ marginTop: 6 }}>
        <input className="gc-input" placeholder={t('branches.newPlaceholder')} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) doBranch('create', () => api.createBranch(path, newName.trim()).then(() => setNewName(''))) }} />
        <button className="gc-btn primary" disabled={!newName.trim() || busy !== null} onClick={() => doBranch('create', () => api.createBranch(path, newName.trim()).then(() => setNewName('')))}>{t('branches.create')}</button>
      </div>

      {branches ? (
        <>
          <div className="gc-section"><div className="head">{t('branches.local')} ({localList.length})</div></div>
          {localList.filter((b) => matchFilter(b.name)).map((b) => (
            <div className="gc-branch" key={b.name}>
              <div className="name-row" style={{ cursor: 'pointer' }} onClick={() => setExpandedLocal(expandedLocal === b.name ? null : b.name)}>
                <span className="name" title={`${b.name}\n${b.subject}\n${b.sha}`}>
                  {b.current ? <span className="gc-cur-mark" style={{ marginRight: 4 }}><Icon name="check" size={11} /></span> : null}{b.name}{b.current ? ` (${t('branches.current')})` : ''}
                  {b.upstream ? <span className="gc-muted" style={{ marginLeft: 4 }}>→ {b.upstream}</span> : null}
                </span>
                <span className="actions" style={{ pointerEvents: expandedLocal === b.name ? 'auto' : 'none', opacity: expandedLocal === b.name ? 1 : 0 }}>
                  {!b.current && <button className="gc-btn" disabled={busy !== null} onClick={() => doBranch('switch', () => api.switchBranch(path, b.name))}>{t('branches.switch')}</button>}
                  {!b.current && <button className="gc-btn" disabled={busy !== null} onClick={() => doBranch('merge', () => api.mergeBranch(path, b.name))}>{t('branches.merge')}</button>}
                  {renameTarget === b.name ? (
                    <span style={{ display: 'flex', gap: 2 }}>
                      <input className="gc-input" style={{ width: 100 }} value={renameVal} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && renameVal.trim()) doBranch('rename', () => api.renameBranch(path, b.name, renameVal.trim()).then(() => setRenameTarget(null))) }} autoFocus />
                      <button className="gc-btn" onClick={() => { setRenameTarget(null) }}>{t('actions.cancel')}</button>
                    </span>
                  ) : (
                    <button className="gc-btn" disabled={busy !== null || b.current} onClick={() => { setRenameTarget(b.name); setRenameVal(b.name) }}>{t('branches.rename')}</button>
                  )}
                  {!b.current && <button className="gc-btn danger" disabled={busy !== null} onClick={() => { if (confirm(`Delete branch ${b.name}?`)) doBranch('delete', () => api.deleteBranch(path, b.name)) }}>{t('branches.delete')}</button>}
                </span>
              </div>
              <div className="meta">
                {(b.ahead !== undefined || b.behind !== undefined) && <DivergeBar ahead={b.ahead ?? 0} behind={b.behind ?? 0} />}
                <span className="gc-muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.subject}</span>
                <span className="gc-muted" style={{ flex: 'none' }}>{b.date?.slice(0, 10)}</span>
              </div>
            </div>
          ))}
          {remoteList.length > 0 && (
            <>
              <div className="gc-section"><div className="head">{t('branches.remote')} ({remoteList.length})</div></div>
              {remoteList.filter((b) => matchFilter(b.name)).map((b) => (
                <div className="gc-branch" key={b.name}>
                  <div className="name-row" style={{ cursor: 'pointer' }} onClick={() => setExpandedRemote(expandedRemote === b.name ? null : b.name)}>
                    <span className="name" title={`${b.name}\n${b.subject}\n${b.sha}`}>{b.name}</span>
                    <span className="actions" style={{ pointerEvents: expandedRemote === b.name ? 'auto' : 'none', opacity: expandedRemote === b.name ? 1 : 0 }}>
                      <button className="gc-btn" disabled={busy !== null} onClick={() => doBranch('checkout', () => api.switchBranch(path, b.name))}>{t('branches.checkout')}</button>
                      <button className="gc-btn danger" disabled={busy !== null} onClick={() => { if (confirm(`Delete remote branch ${b.name}?`)) doBranch('deleteRemote', () => api.deleteRemoteBranch(path, b.name)) }}>{t('branches.delete')}</button>
                    </span>
                  </div>
                  <div className="meta">
                    <span className="gc-muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.subject}</span>
                    <span className="gc-muted" style={{ flex: 'none' }}>{b.date?.slice(0, 10)}</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <div className="gc-empty">{t('common.loading')}</div>
      )}

      {/* 标签：教学向最小闭环（建/删/推） */}
      <div className="gc-section" style={{ marginTop: 10 }}><div className="head"><Icon name="tag" size={12} /> {t('tags.title')}（{tags?.length ?? 0}）</div></div>
      <div className="gc-row">
        <input className="gc-input" placeholder={t('tags.placeholder')} value={tagName} onChange={(e) => setTagName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tagName.trim()) void doBranch('tagCreate', () => api.tagCreate(path, tagName.trim(), tagMsg.trim() || undefined).then(() => { setTagName(''); setTagMsg('') })).then(reloadTags) }} />
        <input className="gc-input" style={{ width: 110, flex: 'none' }} placeholder={t('tags.msgPlaceholder')} value={tagMsg} onChange={(e) => setTagMsg(e.target.value)} />
        <button className="gc-btn" disabled={!tagName.trim() || busy !== null} onClick={() => void doBranch('tagCreate', () => api.tagCreate(path, tagName.trim(), tagMsg.trim() || undefined).then(() => { setTagName(''); setTagMsg('') })).then(reloadTags)}><Icon name="tag" size={12} />{t('tags.create')}</button>
      </div>
      {(tags ?? []).length === 0 ? <div className="gc-muted" style={{ padding: '2px 4px' }}>{t('tags.none')}</div> : null}
      {(tags ?? []).map((tag) => (
        <div key={tag.name} className="gc-row" style={{ padding: '1px 2px' }}>
          <span style={{ color: 'var(--gc-amber)', display: 'inline-flex', flex: 'none' }}><Icon name="tag" size={11} /></span>
          <span className="sub" title={tag.name}>{tag.name}</span>
          <span style={{ flex: 1 }} />
          {tag.date ? <span className="gc-muted" style={{ fontSize: 10 }}>{tag.date}</span> : null}
          <button className="gc-btn sm" disabled={busy !== null} title={t('changes.push')} onClick={() => doBranch('tagPush', () => api.tagPush(path, tag.name))}><Icon name="arrow-up" size={12} /></button>
          <button className="gc-btn sm" disabled={busy !== null} title={t('branches.delete')} onClick={() => doBranch('tagDelete', () => api.tagDelete(path, tag.name))}><Icon name="trash" size={12} /></button>
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
  if (loading) return <div className="gc-diff">{t('common.loading')}</div>
  if (!patch) return <div className="gc-diff gc-muted">{t('diff.empty')}</div>
  return (
    <div className="gc-diff">
      {lines.map((l, i) => {
        let cls = ''
        if (l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ ')) cls = 'meta'
        else if (l.startsWith('@@')) cls = 'hunk'
        else if (l.startsWith('+')) cls = 'add'
        else if (l.startsWith('-')) cls = 'del'
        return <span key={i} className={`gc-dl ${cls}`}>{l === '' ? '\u00a0' : l}</span>
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 冲突横幅条：合并/变基进行中 → 逐文件 我方/对方 + 中止/继续变基
// ---------------------------------------------------------------------------

function ConflictStrip({ api, path }: { api: GitcompassApi; path: string }): JSX.Element | null {
  const { data, reload } = usePoll(() => api.conflictState(path), [path], 4000)
  const [busy, setBusy] = useState(false)
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try { await fn() } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false); reload() }
  }
  if (!data || (!data.merging && !data.rebasing && data.files.length === 0)) return null
  const kind: 'merge' | 'rebase' = data.rebasing ? 'rebase' : 'merge'
  return (
    <div className="gc-conflict">
      <div className="gc-conflict-head">
        <Icon name="alert" size={13} />
        <span className="t">{data.rebasing ? t('conflict.rebasing') : t('conflict.merging')}</span>
        <span className="gc-muted">{data.files.length > 0 ? `${data.files.length} ${t('conflict.files')}` : t('conflict.none')}</span>
        <span style={{ flex: 1 }} />
        {data.rebasing && data.files.length === 0 && (
          <button className="gc-btn primary" disabled={busy} onClick={() => void act(() => api.continueRebase(path))}>{t('conflict.continue')}</button>
        )}
        <button className="gc-btn danger" disabled={busy} onClick={() => void act(() => api.abortConflict(path, kind).then((r) => report('ok', t('op.aborted'), (r as { output?: string }).output)))}>{t('conflict.abort')}</button>
      </div>
      {data.files.map((f) => (
        <div key={f.file} className="gc-row" style={{ padding: '1px 2px' }}>
          <span className="gc-file" title={f.file}>{f.file.split('/').pop()}</span>
          <span className="gc-path">{f.file.split('/').slice(0, -1).join('/')}</span>
          <span className="gc-st mod" style={{ opacity: 0.9 }}>{f.code}</span>
          <span style={{ flex: 1 }} />
          <button className="gc-btn" disabled={busy} onClick={() => void act(() => api.resolveConflict(path, f.file, 'ours').then((r) => report('ok', t('op.resolved'), (r as { output?: string }).output)))}>{t('conflict.ours')}</button>
          <button className="gc-btn" disabled={busy} onClick={() => void act(() => api.resolveConflict(path, f.file, 'theirs').then((r) => report('ok', t('op.resolved'), (r as { output?: string }).output)))}>{t('conflict.theirs')}</button>
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
    case 'A': case 'C': return 'gc-st add'
    case 'M': case 'T': return 'gc-st mod'
    case 'D': return 'gc-st del'
    case 'R': return 'gc-st ren'
    default: return 'gc-st'
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
            <div className="gc-folder" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => toggle(d.path)}>
              <span className="gc-caret">{open ? <Icon name="chevron-down" size={10} /> : <Icon name="chevron-right" size={10} />}</span>
              <Icon name="folder" size={13} className="gc-fic" />
              <span>{d.name}</span>
              <span className="gc-muted" style={{ fontSize: 10 }}>{count}</span>
            </div>
            {open ? <ChangeRowTree node={d} depth={depth + 1} expanded={expanded} toggle={toggle} renderFile={renderFile} /> : null}
          </div>
        )
      })}
      {node.files.map((f) => <div key={f.row.file} style={{ paddingLeft: 4 + depth * 14 }}>{renderFile(f.row)}</div>)}
    </>
  )
}

function Changes({ api, path, flow }: { api: GitcompassApi; path: string; flow: { ahead?: number } | null }): JSX.Element {
  const { data, error, reload } = usePoll(() => api.status(path), [path], 4000)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [diffFile, setDiffFile] = useState<string | null>(null)
  const [diffData, setDiffData] = useState<string>('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [treeView, setTreeView] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const { data: outgoing } = usePoll(() => api.outgoing(path), [path], 10000)
  // P0/P1：变基拉取开关（持久化）+ 贮藏库展开
  const [pullRebase, setPullRebaseState] = useState(getPullRebase)
  const [stashOpen, setStashOpen] = useState(false)
  const { data: stashData, reload: reloadStash } = usePoll(() => api.stashList(path), [path, stashOpen], stashOpen ? 8000 : 60000)
  const stashRows = useMemo(() => {
    if (!stashData || !stashData.ok) return []
    return (stashData.output ?? '').split('\n').filter((l) => l.trim() !== '').map((l) => {
      const i = l.indexOf(': ')
      return { ref: i === -1 ? l.trim() : l.slice(0, i), subject: i === -1 ? '' : l.slice(i + 2) }
    })
  }, [stashData])

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
    setDiffFile(file); setDiffLoading(true)
    try {
      const r = await api.diff(path, file)
      setDiffData(r.ok ? r.output : '(diff failed)')
    } catch { setDiffData('(diff error)') } finally { setDiffLoading(false) }
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
        <div className="gc-filerow" onClick={() => { void showDiff(row.file) }}>
          <FileIcon name={row.newPath.split('/').pop() ?? row.newPath} />
          <span className="gc-file" style={{ cursor: 'pointer', fontWeight: 500 }} title={row.file}>{row.newPath.split('/').pop()}</span>
          {dir !== '' ? <span className="gc-path">{dir}</span> : null}
          <span style={{ flex: 1 }} />
          <span className="actions" style={{ display: 'flex', gap: 2, opacity: 0, transition: 'opacity .15s' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0' }}>
            {kind === 'staged' ? (
              <button className="gc-btn sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); act('unstage', () => api.unstage(path, row.file)) }} title={t('actions.unstage')}><Icon name="minus" size={13} /></button>
            ) : (
              <>
                <button className="gc-btn sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); act('stage', () => api.stage(path, row.file)) }} title={t('actions.stage')}><Icon name="plus" size={13} /></button>
                <button className="gc-btn sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); if (confirm(t('changes.confirmDiscard'))) void act('discard', () => api.discard(path, row.file)) }} title={t('actions.discard')}><Icon name="undo" size={13} /></button>
                {row.untracked && <button className="gc-btn sm" disabled={busy !== null} onClick={(e) => { e.stopPropagation(); void act('ignore', () => api.gitignoreAdd(path, row.file)) }} title={t('gitignore.add')}><Icon name="ban" size={13} /></button>}
              </>
            )}
          </span>
          <span className={stClass(letter)}>{letter}</span>
        </div>
        {diffFile === row.file && (
          <DiffView patch={diffLoading ? '' : diffData} loading={diffLoading} />
        )}
      </div>
    )
  }

  const doCommit = (): void => { if (message.trim()) void act('commit', () => api.commit(path, message)).then(() => setMessage('')) }

  const outCommits = outgoing?.commits ?? []

  return (
    <div>
      <div className="gc-commitbox">
        <input className="gc-input" value={message} onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit() }}
          placeholder={t('changes.commitPlaceholder')} />
        <button className="gc-btn primary" onClick={doCommit} disabled={busy !== null || !message.trim()}>{t('changes.commit')}</button>
        <button className="gc-btn sm" disabled={busy !== null} title={`${t('undo.commit')} — ${t('op.undone')}`} onClick={() => void act('undo', () => api.undoCommit(path))}><Icon name="clock-reverse" size={13} /></button>
        <button className="gc-btn sm" disabled={busy !== null} title={t('amend.last')} onClick={() => void act('amend', () => api.amend(path))}><Icon name="commit" size={13} /></button>
      </div>
      <div className="gc-changes-bar">
        <button className="gc-btn sm" onClick={() => setTreeView(!treeView)} title={treeView ? t('changes.flat') : t('changes.tree')}>
          <Icon name={treeView ? 'list' : 'folder-tree'} size={13} />
        </button>
        <button className="gc-btn" onClick={() => act('stage', () => api.stageAll(path))} disabled={busy !== null}>{t('changes.stageAll')}</button>
        <span className="sep" />
        <button className="gc-btn" onClick={() => act('fetch', () => api.fetch(path))} disabled={busy !== null}>{t('changes.fetch')}</button>
        <button
          className={`gc-btn${pullRebase ? ' primary' : ''}`}
          title={t('pull.rebase')}
          onClick={() => { const next = !pullRebase; setPullRebaseState(next); setPullRebaseFlag(next) }}
        >{pullRebase ? t('pull.rebase') : t('changes.pull')}</button>
        <button className="gc-btn sm" onClick={() => act('pull', () => api.pull(path, pullRebase))} disabled={busy !== null} title={pullRebase ? t('pull.rebase') : t('changes.pull')}>
          <Icon name="arrow-down" size={13} />
        </button>
        <button className="gc-btn" onClick={() => act('push', () => api.push(path))} disabled={busy !== null}>{t('changes.push')}{(flow?.ahead ?? 0) > 0 ? ` ↑${flow?.ahead}` : ''}</button>
        <span className="sep" />
        <button className="gc-btn" disabled={busy !== null} onClick={() => act('stash', () => api.stashPush(path))}>{t('stash.push')}</button>
        <button className="gc-btn sm" disabled={busy !== null || stashRows.length === 0} title={t('stash.pop')} onClick={() => void act('stash', () => api.stashPop(path)).then(reloadStash)}><Icon name="undo" size={13} /></button>
        <button className={`gc-btn sm${stashOpen ? ' primary' : ''}`} onClick={() => setStashOpen(!stashOpen)} title={t('stash.list')}>
          <Icon name="archive" size={13} />{stashRows.length > 0 ? <span style={{ fontSize: 10 }}>{stashRows.length}</span> : null}
        </button>
        <span className="gc-muted" style={{ marginLeft: 'auto', fontSize: 10, flex: 'none' }}>{data?.ok === true && lines.length === 0 ? t('changes.clean') : `${lines.length} files`}</span>
      </div>
      {stashOpen && stashRows.length > 0 ? (
        <div className="gc-stashlist">
          {stashRows.map((s) => (
            <div key={s.ref} className="gc-row" style={{ padding: '1px 2px' }}>
              <span className="sha">{s.ref}</span>
              <span className="sub" title={s.subject}>{s.subject}</span>
              <span style={{ flex: 1 }} />
              <button className="gc-btn sm" disabled={busy !== null} title={t('stash.apply')} onClick={() => void act('stashApply', () => api.stashAction(path, 'apply', s.ref)).then(reloadStash)}><Icon name="check" size={12} /></button>
              <button className="gc-btn sm" disabled={busy !== null} title={t('stash.drop')} onClick={() => { if (confirm(t('stash.dropConfirm'))) void act('stashDrop', () => api.stashAction(path, 'drop', s.ref)).then(reloadStash) }}><Icon name="trash" size={12} /></button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <div className="gc-err">{error}</div> : null}
      {groups.map(({ key, label, rows: groupRows, kind }) => {
        if (!groupRows.length) return null
        return (
          <div key={key}>
            <div className="gc-muted" style={{ marginTop: 6 }}>{label}（{groupRows.length}）</div>
            {treeView
              ? <ChangeRowTree node={treeOf(kind)} depth={0} expanded={expanded} toggle={toggleDir} renderFile={renderRow(kind)} />
              : groupRows.map(renderRow(kind))}
          </div>
        )
      })}
      {outCommits.length > 0 ? (
        <div className="gc-section" style={{ marginTop: 10 }}>
          <div className="head">{t('changes.outgoing')}（{outCommits.length}）</div>
          {outCommits.map((c) => (
            <div className="gc-outrow" key={c.sha}>
              <span className="sha">{c.sha}</span>
              <span className="sub" title={c.subject}>{c.subject}</span>
            </div>
          ))}
          <div className="gc-row" style={{ marginTop: 4 }}>
            <button className="gc-btn primary" disabled={busy !== null} onClick={() => act('push', () => api.push(path))}>
              <Icon name="arrow-up" size={12} />{t('changes.push')} ↑{outCommits.length}
            </button>
            <button className="gc-btn" disabled={busy !== null} title={t('changes.pushApiHint')} onClick={() => act('apipush', () => api.apiPush(path))}>
              <Icon name="globe" size={12} />{t('changes.pushApi')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Graph tab
// ---------------------------------------------------------------------------

function Graph({ api, path }: { api: GitcompassApi; path: string }): JSX.Element {
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

  if (!data) return <div className="gc-empty">{t('common.loading')}</div>

  const laneColors = ['#58a6ff', '#2ea043', '#d29922', '#f85149', '#bc8cff', '#39d353', '#f0883e', '#db61a2']
  const maxLane = layout.reduce((m, c) => Math.max(m, c.lane), 0)

  return (
    <div>
      <div className="gc-row">
        <input className="gc-input" placeholder={t('graph.filter')} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query !== '' ? <span className="gc-muted" style={{ flex: 'none' }}>{layout.length}</span> : null}
      </div>
      {layout.map((c) => (
        <div key={c.sha}>
          <div className="gc-commit">
            <span className="gc-lane" title={`lane ${c.lane}`}>
              {Array.from({ length: maxLane + 1 }, (_, i) => (
                <span key={i} className="gc-lane-line" style={{ backgroundColor: i === c.lane ? laneColors[c.lane % laneColors.length] : 'transparent', marginRight: i < maxLane ? 2 : 0 }} />
              ))}
            </span>
            <span className="sha" style={{ cursor: 'pointer' }} title={`${c.sha}\n${c.author} ${c.date}`} onClick={() => { void toggleSha(c.sha) }}>{c.sha.slice(0, 7)}</span>
            <span className="sub" style={{ cursor: 'pointer' }} onClick={() => { void toggleSha(c.sha) }}>{c.subject}</span>
            {openSha === c.sha ? <span className="gc-caret"><Icon name="chevron-down" size={10} /></span> : null}
            {c.prNumber ? <span className="gc-chip green">PR #{c.prNumber}</span> : null}
            <span className="gc-muted" style={{ fontSize: 10 }}>{c.author}</span>
            <span className="actions" style={{ display: 'flex', gap: 2, opacity: 0, transition: 'opacity .15s' }} onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }} onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0' }}>
              <button className="gc-btn sm" disabled={busySha !== null} onClick={() => doOp(c.sha, () => api.cherryPick(path, c.sha), 'op.cherryPicked')} title={t('graph.cherryPick')}><Icon name="commit" size={12} /></button>
              <button className="gc-btn sm" disabled={busySha !== null} onClick={() => doOp(c.sha, () => api.revertCommit(path, c.sha), 'op.reverted')} title={t('graph.revert')}><Icon name="clock-reverse" size={12} /></button>
            </span>
          </div>
          {openSha === c.sha ? (
            <div className="gc-drill" style={{ margin: '2px 0 6px 18px', borderLeft: '2px solid var(--gc-border)', paddingLeft: 8 }}>
              {drillLoading ? <div className="gc-muted" style={{ fontSize: 11 }}>{t('common.loading')}</div> : null}
              {!drillLoading && openFiles.length === 0 ? <div className="gc-muted" style={{ fontSize: 11 }}>{t('graph.noFiles')}</div> : null}
              {openFiles.map((f) => (
                <div key={f.path}>
                  <div className="gc-row" style={{ padding: '1px 0' }}>
                    <span className="gc-file" style={{ cursor: 'pointer', fontSize: 11 }} title={f.path} onClick={() => { void openPatch(c.sha, f.path) }}>{f.path.split('/').pop()}</span>
                    <span style={{ flex: 1 }} />
                    {f.additions !== null ? <span className="gc-numstat">+{f.additions}</span> : null}
                    {f.deletions !== null ? <span className="gc-numstat del">−{f.deletions}</span> : null}
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

function Issues({ api, repoInfo, auth }: { api: GitcompassApi; repoInfo: RepoInfo | null; auth: GitHubAuthState | null }): JSX.Element {
  const { data: issues, reload } = usePoll<IssueSummary[]>(
    () => (repoInfo ? api.listIssues(repoInfo.owner, repoInfo.repo, 'open') : Promise.resolve([])),
    [repoInfo?.owner, repoInfo?.repo],
    10000,
  )
  // 未连接的两种原因：账号已连但 origin 不是 GitHub / 账号本身未连接。
  if (!repoInfo) return <div className="gc-empty">{auth?.connected ? t('github.originIssue') : t('github.notConnected')}</div>
  const [detail, setDetail] = useState<IssueDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ title: '', body: '' })
  const [commentBody, setCommentBody] = useState('')
  const [busy, setBusy] = useState(false)

  if (!repoInfo.connected) return <div className="gc-empty">{auth?.connected ? t('github.originIssue') : t('github.notConnected')}</div>

  if (detail) {
    return (
      <div>
        <button className="gc-btn" onClick={() => { setDetail(null); setCommentBody('') }}>{t('common.back')}</button>
        <h3 style={{ margin: '6px 0' }}>#{detail.number} {detail.title}</h3>
        <div className="gc-row">
          <span className={`gc-chip ${detail.state === 'open' ? 'amber' : 'red'}`}>{detail.state}</span>
          <span className="gc-muted">{detail.user} · {detail.createdAt?.slice(0, 10)}</span>
        </div>
        {detail.labels.length > 0 && <div className="gc-row" style={{ marginTop: 4 }}>{detail.labels.map((l) => <span key={l} className="gc-chip">{l}</span>)}</div>}
        {detail.body ? <div className="gc-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 6, padding: 8, background: 'rgba(128,128,128,.04)', borderRadius: 4 }}>{detail.body}</div> : null}
        <div className="gc-section"><div className="head">{t('issues.comments')} ({detail.comments.length})</div></div>
        {detail.comments.map((c) => (
          <div key={c.id} style={{ padding: 6, borderBottom: '1px solid rgba(128,128,128,.1)' }}>
            <div className="gc-row"><span className="gc-chip">{c.user}</span><span className="gc-muted">{c.createdAt?.slice(0, 10)}</span></div>
            <div className="gc-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{c.body}</div>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <textarea className="gc-textarea" rows={3} placeholder={t('issues.writeComment')} value={commentBody} onChange={(e) => setCommentBody(e.target.value)} />
          <button className="gc-btn primary" style={{ marginTop: 4 }} disabled={!commentBody.trim() || busy} onClick={async () => { setBusy(true); try { await api.commentIssue(repoInfo.owner, repoInfo.repo, detail.number, commentBody); setCommentBody(''); const d = await api.issueDetail(repoInfo.owner, repoInfo.repo, detail.number); setDetail(d) } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('issues.send')}</button>
        </div>
      </div>
    )
  }

  if (creating) {
    return (
      <div>
        <button className="gc-btn" onClick={() => setCreating(false)}>{t('common.back')}</button>
        <div className="gc-row" style={{ marginTop: 6 }}><input className="gc-input" placeholder={t('issues.titleLabel')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
        <div className="gc-row"><textarea className="gc-textarea" rows={4} placeholder={t('issues.body')} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
        <button className="gc-btn primary" disabled={!form.title.trim() || busy} onClick={async () => { setBusy(true); try { await api.createIssue(repoInfo.owner, repoInfo.repo, form.title, form.body); setCreating(false); reload() } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('issues.createBtn')}</button>
      </div>
    )
  }

  return (
    <div>
      <div className="gc-row" style={{ justifyContent: 'space-between' }}>
        <span className="gc-muted">{issues?.length ?? 0} issues</span>
        <button className="gc-btn primary" onClick={() => setCreating(true)}>{t('issues.create')}</button>
      </div>
      {issues?.length ? issues.map((issue) => (
        <div className="gc-issue" key={issue.number} onClick={() => { void api.issueDetail(repoInfo.owner, repoInfo.repo, issue.number).then(setDetail).catch((e) => reportError(t('op.failed'), e)) }}>
          <div style={{ fontWeight: 600 }}>#{issue.number} {issue.title}</div>
          <div className="gc-muted">{issue.state} · {issue.user} · {issue.createdAt?.slice(0, 10)}{issue.commentCount > 0 ? ` · ${issue.commentCount} comments` : ''}</div>
        </div>
      )) : <div className="gc-empty">{t('issues.empty')}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// PRs tab
// ---------------------------------------------------------------------------

function ChecksChips({ checks }: { checks: NonNullable<PullRequestSummary['checks']> }): JSX.Element {
  return (
    <div className="gc-row">
      <span className="gc-chip green">{checks.passing} {t('prs.pass')}</span>
      <span className="gc-chip red">{checks.failing} {t('prs.fail')}</span>
      <span className="gc-chip amber">{checks.pending} {t('prs.wait')}</span>
    </div>
  )
}

function PRs({ api, repoInfo, auth }: { api: GitcompassApi; repoInfo: RepoInfo | null; auth: GitHubAuthState | null }): JSX.Element {
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
  if (!repoInfo) return <div className="gc-empty">{auth?.connected ? t('github.originIssue') : t('github.notConnected')}</div>
  if (!repoInfo.connected) return <div className="gc-empty">{auth?.connected ? t('github.originIssue') : t('github.notConnected')}</div>

  if (detail) {
    return (
      <div>
        <button className="gc-btn" onClick={() => { setDetail(null); setPrComment(''); setReviewState(null) }}>{t('common.back')}</button>
        <h3 style={{ margin: '6px 0' }}>#{detail.number} {detail.title}</h3>
        <div className="gc-row">
          <span className={`gc-chip ${detail.state === 'merged' ? 'green' : detail.state === 'open' ? 'amber' : 'red'}`}>{detail.state}</span>
          <span className="gc-muted">{detail.head} → {detail.base}</span>
        </div>
        {detail.checks ? <ChecksChips checks={detail.checks} /> : null}
        {detail.body ? <div className="gc-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{detail.body}</div> : null}

        <div className="gc-section"><div className="head">{t('prs.checks')} ({detail.checkRuns.length})</div></div>
        {detail.checkRuns.map((c) => (
          <div className="gc-row" key={c.name}>
            <span className="gc-file">{c.name}</span>
            <span className={`gc-chip ${c.conclusion === 'success' ? 'green' : c.conclusion === 'failure' ? 'red' : 'amber'}`}>{c.conclusion ?? c.status}</span>
          </div>
        ))}

        <div className="gc-section"><div className="head">{t('prs.reviews')} ({detail.reviews.length})</div></div>
        {detail.reviews.map((r, i) => (
          <div className="gc-row" key={i}><span className="gc-chip">{r.state}</span><span>{r.user}</span>{r.body ? <span className="gc-muted">{r.body.slice(0, 80)}</span> : null}</div>
        ))}

        {detail.state === 'open' && (
          <div className="gc-section">
            <div className="head">{t('pr.review.submit')}</div>
            <div className="gc-review-btns">
              <button className="gc-btn primary" onClick={() => setReviewState(reviewState === 'APPROVE' ? null : 'APPROVE')} style={reviewState === 'APPROVE' ? {} : { opacity: 0.6 }}>{t('pr.review.approve')}</button>
              <button className="gc-btn danger" onClick={() => setReviewState(reviewState === 'REQUEST_CHANGES' ? null : 'REQUEST_CHANGES')} style={reviewState === 'REQUEST_CHANGES' ? {} : { opacity: 0.6 }}>{t('pr.review.requestChanges')}</button>
              <button className="gc-btn" onClick={() => setReviewState(reviewState === 'COMMENT' ? null : 'COMMENT')} style={reviewState === 'COMMENT' ? {} : { opacity: 0.6 }}>{t('pr.review.comment')}</button>
            </div>
            {reviewState && (
              <div style={{ marginTop: 4 }}>
                <textarea className="gc-textarea" rows={3} placeholder={t('pr.review.placeholder')} value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} />
                <button className="gc-btn primary" style={{ marginTop: 4 }} disabled={busy} onClick={async () => { setBusy(true); try { await api.reviewPR(repoInfo.owner, repoInfo.repo, detail.number, reviewState, reviewBody); reload(); setDetail(null); setReviewState(null); setReviewBody('') } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('pr.review.submit')}</button>
              </div>
            )}
          </div>
        )}

        <div className="gc-section">
          <div className="head">{t('prs.comments')}</div>
          {detail.comments.map((c) => (
            <div key={c.id} style={{ padding: 4, borderBottom: '1px solid rgba(128,128,128,.1)' }}>
              <span className="gc-chip">{c.user}</span> <span className="gc-muted">{c.path}{c.line ? `:${c.line}` : ''}</span>
              <div className="gc-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{c.body}</div>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            <textarea className="gc-textarea" rows={2} placeholder={t('pr.comment.placeholder')} value={prComment} onChange={(e) => setPrComment(e.target.value)} />
            <button className="gc-btn primary" style={{ marginTop: 4 }} disabled={!prComment.trim() || busy} onClick={async () => { setBusy(true); try { await api.commentPR(repoInfo.owner, repoInfo.repo, detail.number, prComment); setPrComment(''); reload() } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('pr.comment.send')}</button>
          </div>
        </div>

        {detail.state === 'open' && (
          <div className="gc-row" style={{ marginTop: 10 }}>
            <button className="gc-btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await api.mergePR(repoInfo.owner, repoInfo.repo, detail.number, 'squash'); reload(); setDetail(null) } catch (e) { reportError(t('op.failed'), e) } finally { setBusy(false) } }}>{t('prs.squash')}</button>
          </div>
        )}
      </div>
    )
  }

  if (creating) {
    return (
      <div>
        <button className="gc-btn" onClick={() => setCreating(false)}>{t('common.back')}</button>
        <div className="gc-row" style={{ marginTop: 6 }}><input className="gc-input" placeholder={t('prs.title')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
        <div className="gc-row"><span className="gc-muted">{t('prs.head')} {repoInfo.branch} → {t('prs.base')}</span><input className="gc-input" style={{ width: 120 }} value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} /></div>
        <div className="gc-row"><textarea className="gc-textarea" rows={4} placeholder="Description" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
        <button className="gc-btn primary" disabled={!form.title.trim() || !repoInfo.branch} onClick={async () => {
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
      <div className="gc-row" style={{ justifyContent: 'space-between' }}>
        <span className="gc-muted">{t('prs.open')}</span>
        <button className="gc-btn primary" onClick={() => setCreating(true)} disabled={!repoInfo.branch}>{t('prs.create')}</button>
      </div>
      {prs?.length ? prs.map((pr) => (
        <div className="gc-pr" key={pr.number} onClick={() => { void api.prDetail(repoInfo.owner, repoInfo.repo, pr.number).then(setDetail).catch((e) => reportError(t('op.failed'), e)) }}>
          <div className="t">#{pr.number} {pr.title}</div>
          <div className="gc-muted">{pr.head} → {pr.base} · {pr.user}{pr.draft ? ` · ${t('prs.draft')}` : ''}</div>
          {pr.checks ? <ChecksChips checks={pr.checks} /> : null}
        </div>
      )) : <div className="gc-empty">{t('prs.empty')}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GitHub tab — repo overview + quick PR list + auth
// ---------------------------------------------------------------------------

function GitHubView({ api, path, repoInfo, auth, reloadAuth, onGotoPrs, device, deviceBusy, onStartDevice, onCheckDevice, onCancelDevice, onCloned }: {
  api: GitcompassApi
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
          <div className="gc-row"><span className="gc-chip green">{t('github.connected')}</span><span>{auth.login}</span><span className="gc-muted">({auth.source})</span></div>
          {auth.scopes?.length ? <div className="gc-muted" style={{ marginTop: 4 }}>{t('github.scopes')}: {auth.scopes.join(', ')}</div> : null}
          {repoInfo ? <div className="gc-row" style={{ marginTop: 6 }}><span className="gc-chip">{repoInfo.owner}/{repoInfo.repo}</span>{repoInfo.branch ? <span className="gc-muted">@{repoInfo.branch}</span> : null}{repoInfo.prNumber ? <span className="gc-chip green">PR #{repoInfo.prNumber}</span> : null}</div> : null}
          <button className="gc-btn" style={{ marginTop: 8 }} onClick={onGotoPrs}>{t('github.gotoPrs')}</button>
          <button className="gc-btn danger" style={{ marginTop: 8, marginLeft: 6 }} onClick={async () => { await api.logout(); reloadAuth() }}>{t('github.logout')}</button>

          {connected && (
            <div className="gc-section">
              <div className="head">{t('github.quickPrs')} ({quickPrs?.length ?? 0})</div>
              {quickPrs?.length ? quickPrs.slice(0, 5).map((p) => (
                <div className="gc-row" key={p.number}>
                  <span style={{ fontFamily: 'var(--gc-mono)', fontSize: 10 }}>#{p.number}</span>
                  <span className="gc-file">{p.title}</span>
                  <span className="gc-muted">{p.user}</span>
                </div>
              )) : <div className="gc-muted" style={{ padding: '2px 4px' }}>{t('prs.empty')}</div>}
            </div>
          )}
        </div>
      ) : (
        <div>
          <div className="gc-empty">{t('github.notConnected')}</div>
          {originHint !== null && (
            <div className="gc-muted" style={{ padding: '2px 6px', marginBottom: 4 }}>
              {originHint.includes('GitHub') ? t('github.originIssue') : t('github.loginFirst')}
            </div>
          )}
          {/* 令牌在握但 API 不可达/无效：给降级提示 + 重试，不再打回登录死循环。 */}
          {auth?.hasToken ? (
            <div style={{ margin: '4px 0 8px', padding: 6, border: '1px solid rgba(210,153,34,.5)', borderRadius: 6, background: 'rgba(210,153,34,.08)' }}>
              <div>{auth.invalidToken ? t('github.invalidToken') : t('github.savedToken')}</div>
              {!auth.invalidToken && auth.reachabilityError ? <div className="gc-muted" style={{ fontSize: 10, marginTop: 2 }}>{auth.reachabilityError}</div> : null}
              <button className="gc-btn" style={{ marginTop: 4 }} onClick={reloadAuth}>{t('common.retry')}</button>
            </div>
          ) : null}
          {device ? (
            <div>
              <div className="gc-row"><span className="gc-chip amber">{t('github.code')}: <b>{device.userCode}</b></span></div>
              <div className="gc-row"><a className="gc-btn" href={device.verificationUri} target="_blank" rel="noreferrer">{t('github.openUrl')}</a></div>
              <div className="gc-muted" style={{ padding: 4 }}>{t('github.loginHint')}</div>
              <button className="gc-btn primary" onClick={onCheckDevice} disabled={deviceBusy}>{t('github.checkNow')}</button>
              <button className="gc-btn" style={{ marginLeft: 6 }} onClick={onCancelDevice} disabled={deviceBusy}>{t('actions.cancel')}</button>
            </div>
          ) : (
            <button className="gc-btn primary" onClick={onStartDevice} disabled={deviceBusy}>{t('github.login')}</button>
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

      {/* P1：克隆仓库入架 */}
      <div className="gc-section" style={{ marginTop: 14 }}><div className="head"><Icon name="globe" size={12} /> {t('clone.title')}</div></div>
      <div className="gc-row">
        <input className="gc-input" placeholder={t('clone.url')} value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} />
      </div>
      <div className="gc-row">
        <input className="gc-input" placeholder={cloneParent === '' && defaultParent !== '' ? `${t('clone.parent')}: ${defaultParent}` : t('clone.parent')} value={cloneParent} onChange={(e) => setCloneParent(e.target.value)} />
        <button
          className="gc-btn"
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
      <div className="gc-muted" style={{ fontSize: 10 }}>{t('clone.hint')}</div>
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
      <div className={`gc-pane-head ${cls}`}>{title}</div>
      <div className="gc-pane">
        {missingNote != null && <div className="gc-trunc-note">{missingNote}</div>}
        {lines == null && missingNote == null && <div className="gc-trunc-note">…</div>}
        {lines?.map((l) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={`${l.n}`} className={`gc-ln${l.hi ? ` ${cls === 'before' ? 'del' : 'add'}` : ''}`}>
            <span className="gc-lno">{l.n}</span>
            <span className="gc-ltxt">{l.text === '' ? ' ' : l.text}</span>
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
  if (!payload || payload.binary) return <div className="gc-trunc-note">{t('agent.binary')}</div>
  const beforeText = payload.before?.text ?? ''
  const afterText = payload.after?.text ?? ''
  const beforeExists = payload.before?.exists === true
  const beforeLines = beforeExists ? buildLines(beforeText, payload.delLines ?? []) : null
  const afterLines = buildLines(afterText, payload.addLines ?? [])
  return (
    <div className="gc-filediff">
      <FilePane title="修改前 · HEAD" cls="before" lines={beforeLines} missingNote={beforeExists ? undefined : t('agent.newFile')} />
      <FilePane title="修改后 · 工作区" cls="after" lines={afterLines} />
      {payload.truncated && <div className="gc-trunc-note">{t('agent.diffTruncated')}</div>}
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
    <div className="gc-filediff">
      <div className="gc-pane-head">diff</div>
      <div className="gc-pane" style={{ gridColumn: '1 / -1' }}>
        {rows.map((row, i) => row.kind === 'hunk'
          ? <div key={i} className="gc-trunc-note">{row.text}</div>
          : (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="gc-ln">
              <span className="gc-lno" />
              <span className={`gc-ltxt ${row.l?.cls ?? ''}`}>{row.l?.text ?? ''}{row.r ? `  →  ${row.r.text}` : ''}</span>
            </div>
          ))}
      </div>
    </div>
  )
}

function FileReviewSection({ files, workspace, api }: { files: FileReviewRow[]; workspace: string; api: GitcompassApi }): JSX.Element {
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
    <div className="gc-frev">
      <div className="gc-ftabs">
        {shown.map((f) => (
          <button key={f.path} className={`gc-ftab ${f.path === active?.path ? 'on' : ''}`} onClick={() => setActivePath(f.path)} title={f.path}>
            <span className="p">{f.path}</span>
            <span className="gc-fstats add">+{f.additions ?? 0}</span>
            <span className="gc-fstats del">−{f.deletions ?? 0}</span>
          </button>
        ))}
      </div>
      {active == null ? null
        : active.binary === true
          ? <div className="gc-trunc-note">{t('agent.binary')}</div>
          : state.kind === 'loading'
            ? <div className="gc-trunc-note">…</div>
            : state.kind === 'error'
              ? (active.diff && active.diff.trim() !== ''
                  ? (
                    <>
                      <div className="gc-trunc-note">{state.message || t('agent.noFullText')}</div>
                      <DiffHunks diff={active.diff} />
                    </>
                  )
                  : <div className="gc-err" style={{ padding: 4 }}>{t('agent.fileLoadErr')}: {state.message}</div>)
              : <FileComparePane payload={state.payload} />}
      {active.truncated === true && <div className="gc-trunc-note">{t('agent.diffTruncated')}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Agent view
// ---------------------------------------------------------------------------

function AgentView({ api, events }: { api: GitcompassApi; events: GitEvent[] }): JSX.Element {
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

  // 对“正在等待”的调用：/gitu/approval 实时解除阻塞；
  // 无 callId 的场景退回预批准（下一次同名调用跳过弹窗）。
  const decide = useCallback((event: GitEvent, decision: 'approved' | 'rejected') => {
    const callId = event.data.callId as string | undefined
    const tool = String(event.data.tool ?? '')
    setDecided((prev) => ({ ...prev, [callId ?? tool]: decision }))
    if (callId) void api.decideApproval(callId, decision).catch(() => {})
    else if (decision === 'approved') { void api.preApprove(tool).catch(() => {}); refreshPre() }
  }, [api, refreshPre])

  return (
    <div className="gc-agent">
      <div className="gc-agent-bar">
        <span className="gc-live"><span className="dot" />{t('agent.live')}</span>
        <span className="gc-agent-count">{feed.length}</span>
        {approvalRequests.length > 0 && <span className="gc-chip amber">{approvalRequests.length} {t('agent.pendingApproval')}</span>}
        {preAllowed.map((entry) => (
          <span key={entry} className="gc-chip green">
            {entry} · {t('agent.sessionAllowed')}
            <button className="gc-chip-x" title={t('agent.clearSessionAllow')} onClick={() => revokePre(entry)}><Icon name="x" size={10} /></button>
          </span>
        ))}
        <button className="gc-btn" onClick={() => setCleared(!cleared)}>{cleared ? t('agent.restoreFeed') : t('agent.clear')}</button>
        <button className="gc-btn" title={t('agent.previewCard')} onClick={() => void api.previewFileReview().catch(() => {})}>{t('agent.previewCard')}</button>
      </div>

      {approvalRequests.length > 0 && (
        <div className="gc-approvals">
          {approvalRequests.map((e) => {
            const key = String(e.data.callId ?? e.data.tool ?? e.id)
            const state = decided[key]
            const sessionAllowed = decided[`${key}::session`] !== undefined
            const files = Array.isArray(e.data.files) ? (e.data.files as FileReviewRow[]) : []
            const workspace = String(e.data.workspace ?? '')
            return (
              <div key={e.id} className={`gc-approve-card${state || sessionAllowed ? ' done' : ''}`}>
                <div className="gc-approve-msg">{String(e.data.summary ?? e.data.tool ?? '')}</div>
                <div className="gc-approve-tool">{String(e.data.tool ?? '')}{e.data.callId ? ` · #${String(e.data.callId)}` : ''}</div>
                {files.length > 0 && <FileReviewSection files={files} workspace={workspace} api={api} />}
                <div className="gc-approve-actions">
                  <button className="gc-btn primary" disabled={state !== undefined} onClick={() => decide(e, 'approved')}>{t('agent.approveAll')}</button>
                  <button className="gc-btn danger" disabled={state !== undefined} onClick={() => decide(e, 'rejected')}>{t('agent.rejectAll')}</button>
                  <button
                    className="gc-btn"
                    disabled={state !== undefined || sessionAllowed}
                    title={t('agent.allowSession')}
                    onClick={() => {
                      void api.preApprove(String(e.data.tool ?? ''), '*').catch(() => {})
                      setDecided((prev) => ({ ...prev, [`${key}::session`]: 'approved' }))
                      refreshPre()
                    }}
                  >{t('agent.allowSession')}</button>
                  <span className="gc-hint">
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

      <div className="gc-feed">
        {feed.length === 0 && <div className="gc-empty">{t('agent.empty')}</div>}
        {feed.map((e) => {
          const tag = eventTag(e.type)
          return (
            <div key={e.id} className={`gc-evt ${tag.cls}`}>
              <span className="gc-dot" />
              <span className="gc-tag">{tag.label}</span>
              <span className="gc-evt-txt">{String(e.data._summary ?? e.data.summary ?? e.type)}</span>
              <span className="gc-evt-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
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
      <div className="gitcompass-panel" style={{ padding: 14 }}>
        <div style={{ color: 'var(--gc-red)', fontWeight: 600, marginBottom: 4 }}>gitcompass 渲染错误 / render error</div>
        <div style={{ opacity: .75, whiteSpace: 'pre-wrap', fontFamily: 'var(--gc-mono)', fontSize: 11, marginBottom: 10 }}>
          {String(this.state.error.message || this.state.error)}
        </div>
        <button className="gc-btn" onClick={() => { this.setState({ error: null }) }}>重置面板 / reset</button>
      </div>
    )
  }
}

function CompassPanelInner({ api, sessions }: { api: GitcompassApi; sessions: { list: { getSnapshot(): { current?: string; byId: Record<string, { cwd?: string }> }; subscribe(fn: () => void): () => void } } }): JSX.Element {
  // SSE 订阅常驻顶层：即使切到其他标签页，其他会话的提交/审批事件仍在积累，
  // 回到 Agent 标签即可看到全部历史（不因 unmount 断流）。
  const agentEvents = useGitEvents(200)
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([])
  const [path, setPath] = useState<string>('')
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
    void api.workspaces().then((ws) => {
      setWorkspaces(ws)
      if (ws.length > 0 && !path) {
        const current = sessions.list.getSnapshot().current
        const cwd = current ? sessions.list.getSnapshot().byId[current]?.cwd : undefined
        const match = cwd ? ws.find((w) => cwd.startsWith(w.path)) : undefined
        setPath(match?.path ?? ws[0].path)
      }
    }).catch((e) => console.error('gitcompass: workspaces', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 手动收录本地仓库（嵌套仓库/未注册目录），返回值即最新合并清单。 */
  const addRepoPrompt = (): void => {
    const input = window.prompt(t('repo.addTitle'), '')
    if (!input || input.trim() === '') return
    void api.addRepo(input.trim()).then((ws) => {
      setWorkspaces(ws)
      const added = ws.find((w) => w.path.toLowerCase() === input.trim().replace(/[\\/]+$/, '').toLowerCase())
      if (added) { setPath(added.path); setTick((x) => x + 1) }
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
    if (!document.querySelector('style[data-plugin="gitcompass-css"]')) {
      const style = document.createElement('style')
      style.dataset.plugin = 'gitcompass-css'
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
    <div className="gitcompass-panel">
      <div className="gc-head">
        <div className="gc-repo">
          <select value={path} onChange={(e) => { setPath(e.target.value); setTick((x) => x + 1) }}>
            {workspaces.length === 0 ? <option value="">{t('repo.none')}</option> : null}
            {workspaces.map((w) => <option key={w.path} value={w.path}>{w.title || w.path.split(/[\\/]/).pop()}</option>)}
          </select>
          <button className="gc-btn" onClick={addRepoPrompt} title={t('repo.add')}><Icon name="plus" size={12} />{t('repo.add')}</button>
          <button className="gc-btn sm" onClick={removeCurrentRepo} title={t('repo.removeCurrent')}><Icon name="trash" size={13} /></button>
          <button className="gc-btn" onClick={() => setTick((x) => x + 1)} title={t('common.refresh')}><Icon name="sync" size={12} />{t('common.refresh')}</button>
          <button className="gc-btn sm" onClick={() => setSettingsOpen(!settingsOpen)} title={t('settings.title')}><Icon name="gear" size={13} /></button>
          {settingsOpen ? (
            <div className="gc-settings">
              <div className="gc-settings-row">
                <span className="gc-muted">{t('settings.language')}</span>
                {([null, 'zh', 'en'] as const).map((loc) => (
                  <button
                    key={loc ?? 'auto'}
                    className={`gc-btn${getLocaleOverride() === loc ? ' primary' : ''}`}
                    onClick={() => { setLocaleOverride(loc); forceRender((x) => x + 1) }}
                  >{loc === null ? t('settings.langAuto') : loc === 'zh' ? t('settings.langZh') : t('settings.langEn')}</button>
                ))}
              </div>
              <div className="gc-settings-row">
                <span className="gc-muted">{t('settings.poll')}</span>
                {(['fast', 'std', 'slow'] as const).map((spd) => (
                  <button
                    key={spd}
                    className={`gc-btn${pollSpeed === spd ? ' primary' : ''}`}
                    onClick={() => { setPollSpeed(spd); forceRender((x) => x + 1) }}
                  >{spd === 'fast' ? t('settings.pollFast') : spd === 'std' ? t('settings.pollStd') : t('settings.pollSlow')}</button>
                ))}
              </div>
              <div className="gc-muted" style={{ fontSize: 9, opacity: 0.6 }}>gitcompass v{GC_VERSION}</div>
            </div>
          ) : null}
        </div>
      </div>
      <FlowStrip flow={flow} />
      <div className="gc-tabs">
        {tabs.map(([id, key]) => (
          <div key={id} className={`gc-tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            <Icon className="gc-ic" name={TAB_ICONS[id]} size={13} />
            {t(key)}
            {id === 'agent' && pendingApprovals > 0 ? <span className="gc-badge">{pendingApprovals}</span> : null}
          </div>
        ))}
      </div>
      <OpBanner />
      <div className="gc-body">
        {!path ? <div className="gc-empty">{t('repo.none')}</div> : (
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

export function CompassPanel(props: Parameters<typeof CompassPanelInner>[0]): JSX.Element {
  return (
    <PanelErrorBoundary>
      <CompassPanelInner {...props} />
    </PanelErrorBoundary>
  )
}
