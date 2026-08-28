# gitcompass

[English](README.md) | [中文](README.zh.md)

A GitHub-connected visual git panel for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — guided GitHub-Flow steps, commit graph with PR/CI badges, one-click GitHub login, and structured git tools for the agent.

## Features

- **Guided Flow Strip** (top bar): Visual step indicator through the GitHub-Flow stages: Branch → Commit → Push → PR → Review → Merge.
- **Branch Management**: View local/remote branches, switch, create, delete, rename, merge, fetch, checkout remote.
- **Changes View**: File status (staged/unstaged/untracked), stage/unstage, commit, diff viewer (click any file to see changes), stash/pop, push, pull, fetch.
- **Commit Graph** (GitLens-style lane visualization): 3-column layout (lane / SHA / subject), PR badges, cherry-pick to current, revert commit.
- **PR Management**: List PRs, view detail (checks, reviews, comments), create PR, squash merge, review (Approve / Request Changes / Comment), add comment.
- **Issues**: List issues, view detail, create new issue, add comment.
- **GitHub Integration**: Device-flow OAuth login, PAT input, `gh` CLI reuse, encrypted token storage (DPAPI on Windows).
- **Structured Git Tools** (model-side): `git_status`, `git_diff`, `git_branches`, `git_commit`, `git_push`, `github_pr_list/read/create/merge/comment/review`, `github_issue_list/read/create/comment`.
- **Agent Activity Monitor**: a live SSE feed of every agent tool call (start/completion/failure); a repo observer polls workspace state to surface bash git operations performed outside the plugin's tools (new commits / branch switches / working-tree changes).
- **In-Panel Approvals**: write operations pop an approval card inside the panel where you can **Approve** or **Reject** directly; races the native DSH modal — first decision wins. Panel decisions are one-shot and memory-only; without an open panel the flow falls back to the native approval channel.
- **i18n**: Auto-follows DSH Web locale (Chinese / English).
- **Theme**: Light/dark follows DSH Web GUI.

## Install

```sh
dsh plugin --profile web add dsh-git-panel
```

Or for local development:

```sh
dsh plugin --profile web add link:/path/to/gitcompass
```

Restart `dsh web`, open a session bound to a git repository, and the "Compass" panel appears in the right-side column.

## Architecture

```
src/
  index.ts           # Cordis plugin entry: register routes + tools + system prompt
  tools.ts           # Model-side structured git/GitHub tools (approval race for writes)
  core/types.ts      # Shared TypeScript types
  host/
    git-service.ts   # Workspace-bounded git operations
    routes.ts        # /gitu/* HTTP routes (incl. SSE stream /gitu/events, approval endpoint)
    event-bus.ts     # In-memory event bus + pre-approvals + panel approval broker + repo observer
    github-service.ts # GitHub REST wrapper (token never leaves host)
    github-auth.ts   # Device flow, DPAPI token storage, gh CLI sync
  client/
    index.ts         # Browser entry: mounts the panel column
    Panel.tsx        # Main panel: Branches / Changes / Graph / PRs / Issues / GitHub / Agent
    api.ts           # Typed fetch wrapper over /gitu/* routes
    events.ts        # SSE subscription hook (useGitEvents)
    i18n.ts          # Bilingual dictionary (zh/en)
    graph.ts         # Commit DAG lane layout algorithm
```

## Development

```sh
pnpm install
pnpm run build
```

Build output: `lib/` (host) and `client/` (browser bundle).

## License

MIT
