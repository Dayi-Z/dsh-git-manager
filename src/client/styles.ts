/**
 * dsh-git-manager — panel stylesheet.
 *
 * Design contract, absorbed from the presentation of dsh-better-sidebar: this
 * panel is a piece of the DSH shell, not a website embedded in it.
 *
 *  1. Every visual value rides a DSH theme token — --dsw-alias-* for color,
 *     --dsw-font-* for typography roles, --ds-* for motion. No static
 *     palette, and no body[data-ds-dark-theme] selector: light/dark and any
 *     dsh-web-ui skin re-skin the panel for free, because the theme package
 *     owns that decision instead of us.
 *  2. Flat chrome. Hairline borders (--dsw-alias-border-l1/l2) and hover
 *     fills carry structure; nothing in the flow casts a box-shadow.
 *     Elevation exists only for true overlays (menus, popovers) and comes
 *     from --dsw-shadow-lv2.
 *  3. Icon-only controls are round, transparent-filled, and reveal their fill
 *     on hover — the icon alone is the affordance.
 *  4. The row is the atom: a fixed min-height, an 6-8px radius, a hover fill,
 *     a selected fill. Never a border per row.
 *
 * The --gm-* layer is an ALIAS, not a palette: each entry resolves to a host
 * token and falls back to a literal only when the host has not published one
 * (the shape DSH's own chrome uses, e.g. var(--dsw-alias-label-primary,#202124)).
 */

/* ── Surface ───────────────────────────────────────────────────────────── */

export const css = `
.gm-panel{
  --gm-mono:var(--ds-font-family-code,ui-monospace,SFMono-Regular,'Cascadia Code',Menlo,Consolas,monospace);
  --gm-bg:var(--dsw-alias-bg-base,#ffffff);
  --gm-bg-soft:var(--dsw-alias-bg-layer-1,#f6f7f8);
  --gm-bg-raise:var(--dsw-alias-bg-layer-3,#ffffff);
  --gm-fg:var(--dsw-alias-label-primary,#1f2328);
  --gm-fg-2:var(--dsw-alias-label-secondary,#59636e);
  --gm-fg-3:var(--dsw-alias-label-tertiary,#818b98);
  --gm-ink:var(--dsw-alias-label-primary-inverted,#ffffff);
  --gm-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));
  --gm-selected:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08));
  --gm-ring:var(--dsw-alias-interactive-bg-hover-accent,#0969da);
  --gm-hairline:var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  --gm-border:var(--dsw-alias-border-l2,rgba(0,0,0,.14));
  --gm-scroll:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.2));
  --gm-scroll-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(0,0,0,.35));
  /* 注意：--dsw-alias-brand-primary 在 DSH 的暗色主题里是 #f9fafb（白），
     不是"强调色"——旧映射让 .gm-step.active 变成白字白底（"分支绿色、其它白色"
     那个 bug 的根因）。Dark 主题里真正能当强调色用的是业务蓝（进行中），
     与成功的绿（已完成）天然区分：三个状态各自可读。 */
  --gm-accent:var(--dsw-alias-state-business-primary,#0969da);
  --gm-accent-soft:var(--dsw-alias-accent-soft,color-mix(in srgb,var(--dsw-alias-state-business-primary,#0969da) 16%,transparent));
  --gm-primary-fill:var(--dsw-alias-button-primary-fill,#1a7f37);
  --gm-primary-hover:var(--dsw-alias-button-primary-hover,#15702f);
  --gm-green:var(--dsw-alias-state-success-primary,#1a7f37);
  --gm-red:var(--dsw-alias-state-error-primary,#cf222e);
  --gm-amber:var(--dsw-alias-state-warn-primary,#9a6700);
  --gm-info:var(--dsw-alias-state-business-primary,#0969da);
  --gm-green-soft:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a7f37) 11%,transparent);
  --gm-red-soft:color-mix(in srgb,var(--dsw-alias-state-error-primary,#cf222e) 11%,transparent);
  --gm-amber-soft:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#9a6700) 12%,transparent);
  --gm-info-soft:color-mix(in srgb,var(--dsw-alias-state-business-primary,#0969da) 10%,transparent);
  --gm-add-bg:var(--gm-green-soft);
  --gm-del-bg:var(--gm-red-soft);
  /* Commit-graph lanes: a hue wheel built FROM the state tokens, so the graph
     re-skins with the theme instead of pinning GitHub's own eight colors. */
  --gm-lane-1:var(--dsw-alias-state-business-primary,#0969da);
  --gm-lane-2:var(--dsw-alias-state-success-primary,#1a7f37);
  --gm-lane-3:var(--dsw-alias-state-warn-primary,#9a6700);
  --gm-lane-4:var(--dsw-alias-state-error-primary,#cf222e);
  --gm-lane-5:color-mix(in oklab,var(--dsw-alias-state-business-primary,#0969da) 55%,var(--dsw-alias-state-error-primary,#cf222e));
  --gm-lane-6:color-mix(in oklab,var(--dsw-alias-state-success-primary,#1a7f37) 45%,var(--dsw-alias-state-business-primary,#0969da));
  --gm-lane-7:color-mix(in oklab,var(--dsw-alias-state-warn-primary,#9a6700) 60%,var(--dsw-alias-state-error-primary,#cf222e));
  --gm-lane-8:color-mix(in oklab,var(--dsw-alias-state-error-primary,#cf222e) 45%,var(--dsw-alias-state-business-primary,#0969da));
  --gm-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.18));
  --gm-t:var(--ds-transition-duration-slow,150ms);
  --gm-ease:var(--ds-ease-in-out,ease);
  font:var(--dsw-font-xxs-12,400 12px/18px system-ui,-apple-system,'Segoe UI',sans-serif);
  color:var(--gm-fg);
  background:var(--gm-bg);
  display:flex;flex-direction:column;height:100%;min-width:0
}

/* Browser surfaces are part of the design: selection, scrollbars and focus
   are themed too — no default style leaks through. */
.gm-panel ::selection{background:var(--gm-accent-soft)}
.gm-panel *::-webkit-scrollbar{width:9px;height:9px}
.gm-panel *::-webkit-scrollbar-thumb{background:var(--gm-scroll);border-radius:5px;border:2px solid transparent;background-clip:content-box}
.gm-panel *::-webkit-scrollbar-thumb:hover{background-color:var(--gm-scroll-hover);background-clip:content-box}
.gm-panel *::-webkit-scrollbar-track{background:transparent}
.gm-panel *,.gm-panel *::before,.gm-panel *::after{box-sizing:border-box}
.gm-panel button,.gm-panel input,.gm-panel textarea,.gm-panel select{font:inherit;color:inherit}
.gm-panel :focus-visible{outline:2px solid var(--gm-ring);outline-offset:-1px}

/* ── Header: repo picker + the panel's own chrome ──────────────────────── */

.gm-head{position:relative;display:flex;flex-direction:column;gap:6px;padding:8px 8px 8px 12px;border-bottom:1px solid var(--gm-hairline)}
/* 头部第一行：收起把手（可选）+ 仓库选择器。把手只在独立 Dock 形态出现。 */
.gm-headrow{display:flex;align-items:center;gap:4px;min-width:0}
.gm-repo{flex:1;display:flex;gap:4px;align-items:center;min-width:0}
/* 收起态（独立 Dock）：只剩头部条，高度交还给 Dock。宿主同时会停掉轮询
   （setPanelActive），所以被隐藏的视图不会在后台继续打 git。 */
.gm-panel.gm-collapsed{height:auto;min-height:0}
.gm-panel.gm-collapsed > :not(.gm-head){display:none}
.gm-repo select{flex:1;min-width:0;height:26px;padding:0 6px;border:1px solid var(--gm-border);border-radius:6px;background:var(--gm-bg);font:var(--dsw-font-xxs-12);transition:border-color var(--gm-t) var(--gm-ease)}
.gm-repo select option{background:var(--gm-bg);color:var(--gm-fg)}
.gm-repo select:focus{outline:none;border-color:var(--gm-ring)}
.gm-addrow{display:flex;gap:4px;align-items:center}
.gm-addrow input{flex:1;min-width:0}

/* ── Buttons ───────────────────────────────────────────────────────────── */

/* Text button: 26px tall, 6px radius, hairline border, no fill at rest. */
.gm-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:26px;padding:0 10px;border:1px solid var(--gm-border);border-radius:6px;background:transparent;color:var(--gm-fg-2);font:var(--dsw-font-xxxs-strong-11);white-space:nowrap;text-decoration:none;cursor:pointer;transition:background var(--gm-t) var(--gm-ease),color var(--gm-t) var(--gm-ease),border-color var(--gm-t) var(--gm-ease)}
.gm-btn:hover:not(:disabled){background:var(--gm-hover);color:var(--gm-fg)}
.gm-btn:active:not(:disabled){transform:translateY(.5px)}
.gm-btn:disabled{opacity:.4;cursor:default}
/* Icon-only variant: a transparent circle; hover supplies the fill. */
.gm-btn.sm{width:26px;height:26px;min-width:26px;padding:0;gap:0;border-color:transparent;border-radius:50%;color:var(--gm-fg-2)}
.gm-btn.sm:hover:not(:disabled){background:var(--gm-hover);border-color:transparent;color:var(--gm-fg)}
/* Primary: the theme's own button fill and inverted ink — never a hue we own. */
.gm-btn.primary{background:var(--gm-primary-fill);border-color:transparent;color:var(--gm-ink)}
.gm-btn.primary:hover:not(:disabled){background:var(--gm-primary-hover);border-color:transparent;color:var(--gm-ink)}
.gm-btn.danger{border-color:color-mix(in srgb,var(--gm-red) 45%,transparent);color:var(--gm-red)}
.gm-btn.danger:hover:not(:disabled){background:var(--gm-red);border-color:transparent;color:var(--gm-ink)}

/* ── Guided flow strip ─────────────────────────────────────────────────── */

.gm-flow{display:flex;align-items:center;gap:3px;padding:6px 12px;border-bottom:1px solid var(--gm-hairline);overflow-x:auto;scrollbar-width:none}
.gm-flow::-webkit-scrollbar{display:none}
.gm-step{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;padding:2px 8px;border-radius:999px;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-strong-11);transition:background var(--gm-t) var(--gm-ease),color var(--gm-t) var(--gm-ease)}
.gm-step.done{color:var(--gm-green);background:var(--gm-green-soft)}
.gm-step.active{color:var(--gm-accent);background:var(--gm-accent-soft);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gm-accent) 45%,transparent)}
.gm-step .dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.gm-step.active .dot{animation:gm-pulse 1.4s var(--gm-ease) infinite}
@keyframes gm-pulse{50%{opacity:.3}}
.gm-arrow{flex:none;color:var(--gm-fg-3);opacity:.55}

/* ── View tabs ─────────────────────────────────────────────────────────── */

.gm-tabs,.gm-tab,.gm-tab .gm-ic{user-select:none;-webkit-user-select:none}
.gm-tabs{display:flex;gap:2px;padding:4px 6px;border-bottom:1px solid var(--gm-hairline);overflow-x:auto;scrollbar-width:none}
.gm-tabs::-webkit-scrollbar{display:none}
.gm-tab{flex:1 1 auto;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:26px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--gm-fg-3);text-align:center;font:var(--dsw-font-xxxs-strong-11);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;transition:background var(--gm-t) var(--gm-ease),color var(--gm-t) var(--gm-ease)}
.gm-tab .gm-ic{flex:none;opacity:.9}
.gm-tab:hover{background:var(--gm-hover);color:var(--gm-fg)}
.gm-tab.on{background:var(--gm-selected);color:var(--gm-fg)}
.gm-tab.on .gm-ic{color:var(--gm-accent);opacity:1}
.gm-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--gm-amber);color:var(--gm-ink);font:var(--dsw-font-xxxs-strong-11);font-size:10px;line-height:1}

/* ── Body + the row atom ───────────────────────────────────────────────── */

.gm-body{flex:1;overflow:auto;padding:6px 6px 14px}
.gm-row{display:flex;gap:6px;align-items:center;min-height:26px;padding:3px 8px;border-radius:6px}
.gm-row:hover{background:var(--gm-hover)}
.gm-file{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gm-fg)}
.gm-path{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-11);font-family:var(--gm-mono)}
.gm-muted{color:var(--gm-fg-3)}
.gm-err{color:var(--gm-red);padding:8px 10px;white-space:pre-wrap;word-break:break-word}
.gm-caret{flex:none;color:var(--gm-fg-3)}
.gm-fic{flex:none;color:var(--gm-fg-3)}
.gm-drill .gm-file{font-family:var(--gm-mono);font-size:11px}
.gm-numstat{font-family:var(--gm-mono);font-size:11px;color:var(--gm-green)}
.gm-numstat.del{color:var(--gm-red)}
.gm-lane{display:inline-block;width:12px}
.gm-lane-line{display:inline-block;width:2px;height:16px;vertical-align:middle;border-radius:1px}

/* File rows: type icon + weighted name + dimmed directory + status letter;
   the inline actions fade in on hover so the row stays quiet at rest. */
.gm-filerow{display:flex;gap:6px;align-items:center;min-height:28px;padding:3px 8px;border-radius:6px;cursor:pointer;transition:background var(--gm-t) var(--gm-ease)}
.gm-filerow:hover{background:var(--gm-hover)}
.gm-filerow .gm-file{font:var(--dsw-font-xxs-strong-12)}
.gm-filerow .gm-path{max-width:none}
.gm-filerow .actions,.gm-row .actions{margin-left:auto;display:inline-flex;gap:2px;flex:none}

/* ── Status letters ────────────────────────────────────────────────────── */

.gm-st{flex:none;min-width:18px;padding:1px 5px;border-radius:4px;background:var(--gm-hover);color:var(--gm-fg-2);font:var(--dsw-font-xxxs-strong-11);font-family:var(--gm-mono);text-align:center;line-height:14px}
.gm-st.add{color:var(--gm-green)}
.gm-st.mod{color:var(--gm-amber)}
.gm-st.del{color:var(--gm-red)}
.gm-st.ren{color:var(--gm-info)}

/* ── Chips / tags ──────────────────────────────────────────────────────── */

.gm-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border:1px solid var(--gm-border);border-radius:999px;color:var(--gm-fg-2);font:var(--dsw-font-xxxs-strong-11);white-space:nowrap}
.gm-chip.green{color:var(--gm-green);border-color:color-mix(in srgb,var(--gm-green) 45%,transparent);background:var(--gm-green-soft)}
.gm-chip.red{color:var(--gm-red);border-color:color-mix(in srgb,var(--gm-red) 45%,transparent);background:var(--gm-red-soft)}
.gm-chip.amber{color:var(--gm-amber);border-color:color-mix(in srgb,var(--gm-amber) 45%,transparent);background:var(--gm-amber-soft)}
.gm-chip-x{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;border-radius:50%;background:transparent;color:inherit;cursor:pointer}
.gm-chip-x:hover{background:var(--gm-hover)}
.gm-cur-mark{color:var(--gm-accent)}

/* ── Form controls ─────────────────────────────────────────────────────── */

.gm-input,.gm-textarea{width:100%;padding:4px 8px;border:1px solid var(--gm-border);border-radius:6px;background:var(--gm-bg);color:var(--gm-fg);transition:border-color var(--gm-t) var(--gm-ease)}
.gm-input{height:26px;padding:0 8px}
.gm-textarea{resize:vertical;font:var(--dsw-font-xxs-12)}
.gm-input:focus,.gm-textarea:focus{outline:none;border-color:var(--gm-ring)}
.gm-input::placeholder,.gm-textarea::placeholder{color:var(--gm-fg-3)}

/* ── Branches ──────────────────────────────────────────────────────────── */

.gm-branch{display:flex;flex-direction:column;gap:2px;padding:5px 8px;border-radius:6px}
.gm-branch:hover{background:var(--gm-hover)}
.gm-branch .name-row{display:flex;align-items:center;gap:6px;min-width:0}
.gm-branch .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--gm-mono);font-size:11px}
.gm-branch .actions{display:inline-flex;gap:2px;margin-left:auto;flex:none}
.gm-branch .meta{display:flex;gap:8px;align-items:center;min-width:0;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-11)}
.gm-divbar{display:inline-flex;height:6px;border-radius:3px;overflow:hidden;background:var(--gm-hover);flex:none}
.gm-divbar .behind{height:100%;background:var(--gm-red)}
.gm-divbar .ahead{height:100%;background:var(--gm-green)}

/* GitHub-style branch switcher (a real overlay: hairline + token elevation) */
.gm-bhead{position:relative;display:flex;align-items:center;gap:8px}
.gm-bswitch{min-width:0}
.gm-bpill{display:inline-flex;align-items:center;gap:7px;max-width:220px;padding:5px 11px;border:1px solid var(--gm-border);border-radius:7px;background:transparent;color:var(--gm-fg);font:var(--dsw-font-xxs-strong-12);font-family:var(--gm-mono);cursor:pointer;transition:border-color var(--gm-t) var(--gm-ease),background var(--gm-t) var(--gm-ease)}
.gm-bpill:hover{border-color:var(--gm-accent);background:var(--gm-hover)}
.gm-bpill .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--gm-accent);box-shadow:0 0 0 3px var(--gm-accent-soft)}
.gm-bpill .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-bpill .cv{color:var(--gm-fg-3);font-size:9px}
.gm-bsbackdrop{position:fixed;inset:0;z-index:25}
.gm-bsmenu{position:absolute;left:0;top:calc(100% + 6px);z-index:30;width:min(100%,420px);max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:6px;border:1px solid var(--gm-border);border-radius:10px;background:var(--gm-bg-raise);box-shadow:var(--gm-shadow)}
.gm-bsmenu .gm-input{position:sticky;top:-6px;z-index:1;margin-bottom:4px;background:var(--gm-bg-raise)}
.gm-bsrow{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:7px;cursor:pointer;transition:background var(--gm-t) var(--gm-ease)}
.gm-bsrow:hover,.gm-bsrow.on{background:var(--gm-hover)}
.gm-bsrow .n{display:flex;gap:7px;align-items:center;min-width:0;font-family:var(--gm-mono);font-size:11.5px}
.gm-bsrow .n .cur{flex:none;color:var(--gm-accent);font-size:10px}
.gm-bsrow .n > span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-bsrow .m{display:flex;gap:10px;min-width:0;padding-left:17px;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-11)}
.gm-bssec{padding:6px 9px 2px;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-strong-11);text-transform:uppercase;letter-spacing:.05em}

/* ── Changes ───────────────────────────────────────────────────────────── */

.gm-commitbox{display:flex;gap:6px;margin-bottom:8px}
.gm-commitbox .gm-input{flex:1;min-width:0}
.gm-commitbox .gm-btn{flex:none}
.gm-changes-bar{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:2px 2px 6px}
.gm-changes-bar .sep{flex:none;width:1px;height:16px;margin:0 2px;background:var(--gm-hairline)}

.gm-commit{display:flex;gap:6px;align-items:center;min-height:26px;padding:3px 8px;border-radius:6px}
.gm-commit:hover{background:var(--gm-hover)}
.gm-commit .sha{flex:none;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-11);font-family:var(--gm-mono);cursor:pointer}
.gm-commit .sha:hover{color:var(--gm-accent)}
.gm-commit .sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Incoming / outgoing: a quiet card with a section heading. */
.gm-outsec{margin-top:10px;padding:6px 8px;border:1px solid var(--gm-hairline);border-radius:8px;background:var(--gm-bg-soft)}
.gm-outsec-head{display:flex;align-items:center;gap:6px;margin-bottom:2px;color:var(--gm-accent)}
.gm-outsec-head .t{font:var(--dsw-font-xxs-strong-12)}
.gm-outsec-explain{margin-bottom:3px;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-11)}
.gm-outrow{display:flex;gap:8px;align-items:center;min-width:0;padding:2px 6px;border-radius:6px;cursor:pointer;transition:background var(--gm-t) var(--gm-ease)}
.gm-outsec .gm-outrow:hover,.gm-outrow.on{background:var(--gm-hover)}
.gm-outrow .caret{display:inline-flex;flex:none;color:var(--gm-fg-3)}
.gm-outrow .who{flex:none;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-11)}
.gm-outrow .sha{flex:none;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-11);font-family:var(--gm-mono)}
.gm-outrow .sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-outdrill{margin:2px 0 4px 22px;padding-left:8px;border-left:2px solid var(--gm-hairline)}
.gm-stashlist{display:flex;flex-direction:column;gap:1px;margin:0 0 6px;padding:4px 6px;border:1px solid var(--gm-hairline);border-radius:8px;background:var(--gm-bg-soft)}
.gm-stashlist .sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Folder rows in the tree view */
.gm-folder{display:flex;gap:5px;align-items:center;min-height:24px;padding:2px 6px;border-radius:6px;font-family:var(--gm-mono);font-size:11px;cursor:pointer}
.gm-folder:hover{background:var(--gm-hover)}

/* ── Diffs ─────────────────────────────────────────────────────────────── */

.gm-diff{max-height:320px;margin:4px 0;padding:4px 0;border:1px solid var(--gm-hairline);border-radius:8px;background:var(--gm-bg-soft);overflow:auto;white-space:pre;font-family:var(--gm-mono);font-size:11px;line-height:18px}
.gm-dl{display:block;padding:0 10px}
.gm-dl.add{background:var(--gm-add-bg)}
.gm-dl.del{background:var(--gm-del-bg)}
.gm-dl.hunk{color:var(--gm-info)}
.gm-dl.meta{color:var(--gm-fg-3);font-size:10px}

.gm-filediff{display:grid;grid-template-columns:1fr 1fr;margin:2px 0 4px;border:1px solid var(--gm-hairline);border-radius:8px;background:var(--gm-bg);overflow:hidden}
.gm-pane-head{padding:4px 8px;border-bottom:1px solid var(--gm-hairline);background:var(--gm-bg-soft);font:var(--dsw-font-xxxs-strong-11)}
.gm-pane-head.before{color:var(--gm-red)}
.gm-pane-head.after{color:var(--gm-green)}
.gm-pane{max-height:360px;overflow:auto;padding:4px 0;font-family:var(--gm-mono);font-size:11px;line-height:17px}
.gm-ln{display:grid;grid-template-columns:38px 1fr;align-items:start}
.gm-ln.del{background:var(--gm-del-bg)}
.gm-ln.add{background:var(--gm-add-bg)}
.gm-lno{padding-right:7px;color:var(--gm-fg-3);text-align:right;user-select:none;font-size:10px}
.gm-ltxt{padding-right:8px;white-space:pre-wrap;word-break:break-word}
.gm-trunc-note{padding:3px 8px;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-11)}

/* ── PRs / Issues ──────────────────────────────────────────────────────── */

.gm-pr,.gm-issue{margin-bottom:6px;padding:8px 10px;border:1px solid var(--gm-hairline);border-radius:8px;cursor:pointer;transition:background var(--gm-t) var(--gm-ease),border-color var(--gm-t) var(--gm-ease)}
.gm-pr:hover,.gm-issue:hover{background:var(--gm-hover);border-color:var(--gm-border)}
.gm-pr .t,.gm-issue .t{font:var(--dsw-font-xxs-strong-12)}
.gm-section{margin-top:14px}
.gm-section .head{margin-bottom:6px;color:var(--gm-fg-3);font:var(--dsw-font-xxxs-strong-11);text-transform:uppercase;letter-spacing:.05em}
.gm-review-btns{display:flex;gap:4px;margin-top:6px}

/* ── Empty states ──────────────────────────────────────────────────────── */

.gm-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 12px;text-align:center;color:var(--gm-fg-3)}
.gm-empty .gm-ic{opacity:.45}
.gm-empty .t{color:var(--gm-fg);font:var(--dsw-font-xxs-strong-12)}
.gm-empty .h{max-width:240px;font:var(--dsw-font-xxxs-11)}

/* ── Operation feedback banner ─────────────────────────────────────────── */

.gm-banner{display:flex;gap:8px;align-items:flex-start;padding:8px 10px 8px 12px;border-bottom:1px solid var(--gm-hairline);animation:gm-banner-in var(--gm-t) var(--gm-ease)}
.gm-banner.ok{background:var(--gm-green-soft)}
.gm-banner.err{background:var(--gm-red-soft)}
.gm-banner.ok>.gm-bic{color:var(--gm-green)}
.gm-banner.err>.gm-bic{color:var(--gm-red)}
.gm-banner-body{flex:1;min-width:0}
.gm-banner-body .t{font:var(--dsw-font-xxs-strong-12)}
.gm-banner.ok .t{color:var(--gm-green)}
.gm-banner.err .t{color:var(--gm-red)}
.gm-banner-body .d{margin:5px 0 0;padding:6px 8px;border:1px solid var(--gm-hairline);border-radius:6px;background:var(--gm-bg);max-height:190px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--gm-mono);font-size:11px}
.gm-banner-x{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--gm-fg-3);cursor:pointer}
.gm-banner-x:hover{background:var(--gm-hover);color:var(--gm-fg)}
@keyframes gm-banner-in{from{opacity:0;transform:translateY(-4px)}}

/* ── Conflict strip ────────────────────────────────────────────────────── */

.gm-conflict{margin-bottom:8px;padding:6px 10px;border:1px solid color-mix(in srgb,var(--gm-amber) 45%,transparent);border-radius:8px;background:var(--gm-amber-soft)}
.gm-conflict-head{display:flex;align-items:center;gap:6px;color:var(--gm-amber)}
.gm-conflict-head .t{font:var(--dsw-font-xxs-strong-12)}

/* ── Agent activity monitor ────────────────────────────────────────────── */

.gm-agent{display:flex;flex-direction:column;height:100%}
.gm-agent-bar{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--gm-hairline);background:var(--gm-bg)}
.gm-live{display:inline-flex;align-items:center;gap:4px;color:var(--gm-accent);font:var(--dsw-font-xxxs-strong-11)}
.gm-live .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--gm-accent);animation:gm-pulse 1.6s var(--gm-ease) infinite}
.gm-agent-count{color:var(--gm-fg-3);font-family:var(--gm-mono);font-size:11px}

/* Approval cards: the write gate lives here, so it reads as an alert, not a row. */
.gm-approvals{display:flex;flex-direction:column;gap:6px;padding:6px 0}
.gm-approve-card{padding:8px 10px;border:1px solid color-mix(in srgb,var(--gm-amber) 50%,transparent);border-radius:8px;background:var(--gm-amber-soft)}
.gm-approve-msg{font:var(--dsw-font-xxs-strong-12)}
.gm-approve-tool{margin:2px 0 6px;color:var(--gm-fg-3);font-family:var(--gm-mono);font-size:11px}
.gm-approve-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.gm-hint{opacity:0;color:var(--gm-green);font:var(--dsw-font-xxxs-11);transition:opacity var(--gm-t) var(--gm-ease)}
.gm-approve-card.done .gm-hint{opacity:1}

.gm-feed{display:flex;flex-direction:column-reverse;gap:1px;flex:1;overflow:auto;font-size:11px}
.gm-evt{display:flex;gap:6px;align-items:baseline;min-height:22px;padding:2px 6px;border-radius:6px}
.gm-evt:hover{background:var(--gm-hover)}
.gm-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--gm-fg-3);transform:translateY(-1px)}
.gm-evt.run .gm-dot{background:var(--gm-info)}
.gm-evt.ok .gm-dot{background:var(--gm-green)}
.gm-evt.wait .gm-dot{background:var(--gm-amber)}
.gm-evt.err .gm-dot{background:var(--gm-red)}
.gm-tag{flex:none;padding:0 6px;border:1px solid var(--gm-border);border-radius:999px;color:var(--gm-fg-2);font:var(--dsw-font-xxxs-strong-11)}
.gm-evt.run .gm-tag{color:var(--gm-info);border-color:color-mix(in srgb,var(--gm-info) 45%,transparent)}
.gm-evt.ok .gm-tag{color:var(--gm-green);border-color:color-mix(in srgb,var(--gm-green) 45%,transparent)}
.gm-evt.wait .gm-tag{color:var(--gm-amber);border-color:color-mix(in srgb,var(--gm-amber) 45%,transparent)}
.gm-evt.err .gm-tag{color:var(--gm-red);border-color:color-mix(in srgb,var(--gm-red) 45%,transparent)}
.gm-evt-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gm-evt.err .gm-evt-txt{white-space:pre-wrap;word-break:break-word}
.gm-evt-time{flex:none;color:var(--gm-fg-3);font-family:var(--gm-mono);font-size:10px}

/* File-level review: per-file tabs above the side-by-side panes. */
.gm-frev{margin-top:6px;padding-top:6px;border-top:1px solid var(--gm-hairline)}
.gm-ftabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px}
.gm-ftab{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:2px 8px;border:1px solid var(--gm-border);border-radius:999px;background:transparent;color:var(--gm-fg-2);font:var(--dsw-font-xxxs-11);cursor:pointer;transition:background var(--gm-t) var(--gm-ease),color var(--gm-t) var(--gm-ease)}
.gm-ftab:hover{background:var(--gm-hover);color:var(--gm-fg)}
.gm-ftab.on{background:var(--gm-selected);color:var(--gm-fg);border-color:transparent}
.gm-ftab .p{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--gm-mono);font-size:11px}
.gm-fstats{font-family:var(--gm-mono);font-size:10px}
.gm-fstats.add{color:var(--gm-green)}
.gm-fstats.del{color:var(--gm-red)}

/* ── Settings popover (overlay: hairline + token elevation) ────────────── */

.gm-settings{position:absolute;top:calc(100% - 6px);right:8px;z-index:60;display:flex;flex-direction:column;gap:8px;min-width:230px;padding:10px;border:1px solid var(--gm-border);border-radius:10px;background:var(--gm-bg-raise);box-shadow:var(--gm-shadow)}
.gm-settings-row{display:flex;align-items:center;gap:4px}
.gm-settings-row .gm-muted{min-width:52px;font:var(--dsw-font-xxxs-11)}

/* ── Motion ────────────────────────────────────────────────────────────── */

@media (prefers-reduced-motion:reduce){
  .gm-panel *,.gm-panel *::before,.gm-panel *::after{animation:none!important;transition:none!important}
}
`

