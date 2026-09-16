# gitcompass

[English](README.md) | [中文](README.zh.md)

[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 GitHub 可视化 Git 工作面板插件——引导式 GitHub Flow 流程、GitLens 风格提交图谱（带 PR/CI 徽章）、一键 GitHub 登录，以及为 Agent 提供的结构化 Git 操作工具。

## 功能特性

- **引导流程条**（顶部）：可视化展示 GitHub-Flow 六个阶段：分支 → 提交 → 推送 → PR → 评审 → 合并。
- **分支管理**：查看本地/远程分支、切换、新建、删除、重命名、合并、拉取、检出远程分支。
- **变更视图**：文件状态（已暂存/未暂存/未跟踪）、暂存/取消暂存、提交、Diff 查看（点击文件查看变更）、暂存/弹出工作区、推送、拉取、抓取。
- **提交图谱**（GitLens 风格 Lane 布局）：三栏（列 / SHA / 主题），PR 徽章，cherry-pick 到当前分支，撤销提交。
- **PR 管理**：列出 PR、查看详情（检查、评审、评论）、创建 PR、Squash 合并、评审（通过 / 请求修改 / 评论）、添加评论。
- **议题（Issues）**：列出议题、查看详情、创建新议题、添加评论。
- **GitHub 集成**：设备流 OAuth 登录、PAT 输入、复用 `gh` CLI、加密 Token 存储（Windows DPAPI）。
- **结构化 Git 工具**（Agent 侧）：`git_status`、`git_diff`、`git_branches`、`git_commit`、`git_push`、`github_pr_list/read/create/merge/comment/review`、`github_issue_list/read/create/comment`。
- **Agent 活动监视器**：实时 SSE 事件流展示 Agent 正在执行的每次工具调用（开始/完成/失败），仓库观察器轮询捕获面板外的 bash git 操作（新提交 / 切换分支 / 工作区变更）。
- **面板内审批（面板权威）**：Agent 的写操作在面板中弹出审批卡片，可直接**批准**或**拒绝**；与 DSH 原生弹窗并行竞速，先到者生效。原生通道的自动拒绝（包括 approval policy 为 `never` 时的 ghost deny，例如 danger-full-access 预设自带 `never`）**不能否决**面板卡——任何审批策略下写操作都能走面板审批。面板决定一次性有效且不落盘；无面板在线时快速失败并提示打开面板（或先在面板中预批准），不再静默挂 5 分钟。
- **多语言**：自动跟随 DSH Web 界面语言（中文 / 英文）。
- **主题**：自动跟随 DSH Web GUI 明暗主题。

## 安装

```sh
dsh plugin --profile web add dsh-git-panel
```

本地开发：

```sh
dsh plugin --profile web add link:/path/to/gitcompass
```

重启 `dsh web`，打开一个绑定 git 仓库的会话，右侧面板即显示「罗盘」。

## 架构

```
src/
  index.ts           # Cordis 插件入口：注册路由 + 工具 + 系统提示词
  tools.ts           # Agent 侧结构化 git/GitHub 工具（写操作审批竞速）
  core/types.ts      # 共享类型定义
  host/
    git-service.ts   # 以工作区为边界的 git 操作服务
    routes.ts        # /gitu/* HTTP 路由（含 SSE 事件流 /gitu/events、审批端点）
    event-bus.ts     # 内存事件总线 + 预批准表 + 面板审批 Broker + 仓库观察器
    github-service.ts # GitHub REST 封装（Token 不离开宿主进程）
    github-auth.ts   # 设备流、DPAPI Token 加密存储、gh CLI 同步
  client/
    index.ts         # 浏览器端入口：挂载右侧面板列
    Panel.tsx        # 主面板：分支 / 变更 / 图谱 / PR / 议题 / GitHub / Agent
    api.ts           # /gitu/* 路由的类型化 Fetch 封装
    events.ts        # SSE 订阅 Hook（useGitEvents）
    i18n.ts          # 中英文双语词典
    graph.ts         # 提交 DAG Lane 布局算法
```

## 开发

```sh
pnpm install
pnpm run build
```

构建产物：`lib/`（宿主端）和 `client/`（浏览器端 bundle）。

## 许可证

MIT
