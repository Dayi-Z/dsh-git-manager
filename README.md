# dsh-git-manager

[English](README.md) | [中文](README.zh.md)

A GitHub-connected visual git manager for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — guided GitHub-Flow steps, commit graph with PR/CI badges, one-click GitHub login, and structured git tools for the agent.

Its panel chrome is built the way `dsh-better-sidebar` builds its own: every color, type role and motion value rides a DSH theme token, the chrome is flat (hairlines and hover fills, no shadows in the flow), and icon-only controls are round and transparent until hovered. Light/dark and any `dsh-web-ui` skin re-skin the panel for free — the panel contains no palette of its own and no theme selector. See [DESIGN.md](DESIGN.md).

> Renamed from **gitcompass** in 2.0.0. The package, the plugin row id (`git-manager`), the HTTP routes (`/gitm/*`) and the CSS surface (`--gm-*`) all moved together. The model-facing tool names (`git_status`, `git_commit`, `github_pr_*`, …) are deliberately unchanged — they name the operation, not the product.

## Features

- **Guided Flow Strip** (top bar): visual step indicator through the GitHub-Flow stages: Branch → Commit → Push → PR → Review → Merge.
- **Branch Management**: view local/remote branches, switch, create, delete, rename, merge, fetch, checkout remote.
- **Changes View**: file status (staged/unstaged/untracked), stage/unstage, commit, diff viewer (click any file to see changes), stash/pop, push, pull, fetch.
- **Commit Graph** (GitLens-style lane visualization): 3-column layout (lane / SHA / subject), PR badges, cherry-pick to current, revert commit.
- **PR Management**: list PRs, view detail (checks, reviews, comments), create PR, squash merge, review (Approve / Request Changes / Comment), add comment.
- **Issues**: list issues, view detail, create new issue, add comment.
- **GitHub Integration**: device-flow OAuth login, PAT input, `gh` CLI reuse, encrypted token storage (DPAPI on Windows).
- **Structured Git Tools** (model-side): `git_status`, `git_diff`, `git_branches`, `git_commit`, `git_push`, `github_pr_list/read/create/merge/comment/review`, `github_issue_list/read/create/comment`.
- **Agent Activity Monitor**: a live SSE feed of every agent tool call (start/completion/failure); a repo observer polls workspace state to surface bash git operations performed outside the plugin's tools (new commits / branch switches / working-tree changes).
- **In-Panel Approvals (panel-authoritative)**: write operations pop an approval card inside the panel where you can **Approve** or **Reject** directly; races the native DSH modal — first decision wins. The native channel's automatic rejection (including the ghost deny under approval policy `never`, e.g. the danger-full-access preset) **cannot veto** the panel card — the panel approval path works under any approval policy. Panel decisions are one-shot and memory-only; with no panel connected the call fails fast with a hint to open the panel (or pre-approve the tool there), instead of silently hanging for 5 minutes.
- **i18n**: auto-follows the DSH Web locale (Chinese / English).
- **Theme**: no palette of its own — follows the host theme tokens, so light/dark and third-party skins both apply.
- **Two host modes**: when [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) is installed the panel contributes itself as one of its sidebar tabs and gives up its own column to it; without it the panel keeps its standalone right-column card, now collapsible. See below.

## Install

```sh
dsh plugin --profile web add dsh-git-manager
```

Or for local development:

```sh
dsh plugin --profile web add link:/path/to/dsh-git-manager
```

Restart `dsh web`, open a session bound to a git repository, and the "Git Manager" panel appears in the right-side column.

## Architecture

```
src/
  index.ts           # Cordis plugin entry: register routes + tools + system prompt
  tools.ts           # Model-side structured git/GitHub tools (approval race for writes)
  core/types.ts      # Shared TypeScript types
  host/
    git-service.ts   # Workspace-bounded git operations
    routes.ts        # /gitm/* HTTP routes (incl. SSE stream /gitm/events, approval endpoint)
    event-bus.ts     # In-memory event bus + pre-approvals + panel approval broker + repo observer
    github-service.ts # GitHub REST wrapper (token never leaves host)
    github-auth.ts   # Device flow, DPAPI token storage, gh CLI sync
  client/
    index.ts         # Browser entry: picks the host (better-sidebar tab vs standalone)
    embed.tsx        # better-sidebar tab registration (structural, optional peer)
    shell.tsx        # Standalone host: the collapsible dock card
    Panel.tsx        # Main panel: Branches / Changes / Graph / PRs / Issues / GitHub / Agent
    styles.ts        # The whole stylesheet, on host theme tokens (see DESIGN.md)
    api.ts           # Typed fetch wrapper over /gitm/* routes
    events.ts        # SSE subscription + the shared event store behind the tab badge
    i18n.ts          # Bilingual dictionary (zh/en)
    icons.tsx        # The single inline-SVG icon source (16px grid, 1.5 stroke)
    graph.ts         # Commit DAG lane layout algorithm
```

## Host modes

The plugin never claims a surface the host already owns:

- **`dsh-better-sidebar` present** — the panel registers a sidebar tab (`dsh-git-manager:panel`, titled "Git Manager" / "Git 管理", idempotent) and does **not** mount its own column. You open it from the sidebar's new-tab list; it then persists with the session. The tab carries a live badge with the number of write operations waiting for your approval.
- **`dsh-better-sidebar` absent** — the panel keeps its own right-column card, with a collapse handle in its header. Collapsing leaves just that header strip and **stops all polling** (nothing hits git in the background); the state persists.

The detection is a runtime probe (`ctx.get('betterSidebar')`), so better-sidebar stays an *optional* peer: no hard dependency, no build-time import of its types, and a failed registration degrades to the standalone card instead of losing the panel.

## Development

```sh
pnpm install
pnpm run build
```

Build output: `lib/` (host) and `client/` (browser bundle).

## License

MIT
