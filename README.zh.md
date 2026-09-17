# dsh-git-manager

[English](README.md) | [中文](README.zh.md)

[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 GitHub 可视化 Git 管理插件——引导式 GitHub Flow 流程、GitLens 风格提交图谱（带 PR/CI 徽章）、一键 GitHub 登录，以及为 Agent 提供的结构化 Git 操作工具。

面板的呈现方式与 `dsh-better-sidebar` 同源：每一个颜色、字号角色与动效值都走 DSH 主题令牌；界面是**平面**的（发丝边框 + 悬停底色，流内没有阴影）；纯图标按钮是圆形、透明底、悬停才浮出。明暗主题与任何 `dsh-web-ui` 皮肤都能直接重绘这个面板——面板内部**没有自己的调色板，也没有主题选择器**。详见 [DESIGN.md](DESIGN.md)。

> 2.0.0 起由 **gitcompass** 改名而来：包名、插件行 id（`git-manager`）、HTTP 路由（`/gitm/*`）与 CSS 前缀（`--gm-*`）一并迁移。**模型侧的工具名**（`git_status`、`git_commit`、`github_pr_*` 等）刻意保持不变——它们命名的是操作，不是产品。

## 功能特性

- **引导流程条**（顶部）：可视化展示 GitHub-Flow 六个阶段：分支 → 提交 → 推送 → PR → 评审 → 合并。
- **分支管理**：查看本地/远程分支、切换、新建、删除、重命名、合并、拉取、检出远程分支。
- **变更视图**：文件状态（已暂存/未暂存/未跟踪）、暂存/取消暂存、提交、Diff 查看（点击文件查看变更）、贮藏/弹出、推送、拉取、抓取。
- **提交图谱**（GitLens 风格 Lane 布局）：三栏（列 / SHA / 主题），PR 徽章，cherry-pick 到当前分支，撤销提交。
- **PR 管理**：列出 PR、查看详情（检查、评审、评论）、创建 PR、Squash 合并、评审（通过 / 请求修改 / 评论）、添加评论。
- **议题（Issues）**：列出议题、查看详情、创建新议题、添加评论。
- **GitHub 集成**：设备流 OAuth 登录、PAT 输入、复用 `gh` CLI、加密 Token 存储（Windows DPAPI）。
- **结构化 Git 工具**（Agent 侧）：`git_status`、`git_diff`、`git_branches`、`git_commit`、`git_push`、`github_pr_list/read/create/merge/comment/review`、`github_issue_list/read/create/comment`。
- **Agent 活动监视器**：实时 SSE 事件流展示 Agent 正在执行的每次工具调用（开始/完成/失败），仓库观察器轮询捕获面板外的 bash git 操作（新提交 / 切换分支 / 工作区变更）。
- **面板内审批（面板权威）**：Agent 的写操作在面板中弹出审批卡片，可直接**批准**或**拒绝**；与 DSH 原生弹窗并行竞速，先到者生效。原生通道的自动拒绝（包括 approval policy 为 `never` 时的 ghost deny，例如 danger-full-access 预设自带 `never`）**不能否决**面板卡——任何审批策略下写操作都能走面板审批。面板决定一次性有效且不落盘；无面板在线时快速失败并提示打开面板（或先在面板中预批准），不再静默挂死。
- **多语言**：自动跟随 DSH Web 界面语言（中文 / 英文）。
- **主题**：面板不带自研调色板，颜色全部来自宿主主题令牌，因此明暗与第三方皮肤都能生效。
- **两种宿主形态**：装了 [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) 时，面板把自己注册成它的一个页签并把右栏让给它；没装时保留自己的右栏卡片，且**可折叠**。详见下文。

## 安装

```sh
dsh plugin --profile web add dsh-git-manager
```

本地开发：

```sh
dsh plugin --profile web add link:/path/to/dsh-git-manager
```

重启 `dsh web`，打开一个绑定 git 仓库的会话，右侧面板即显示「Git 管理」。

## 架构

```
src/
  index.ts           # Cordis 插件入口：注册路由 + 工具 + 系统提示词
  tools.ts           # Agent 侧结构化 git/GitHub 工具（写操作审批竞速）
  core/types.ts      # 共享类型定义
  host/
    git-service.ts   # 以工作区为边界的 git 操作服务
    routes.ts        # /gitm/* HTTP 路由（含 SSE 事件流 /gitm/events、审批端点）
    event-bus.ts     # 内存事件总线 + 预批准表 + 面板审批 Broker + 仓库观察器
    github-service.ts # GitHub REST 封装（Token 不离开宿主进程）
    github-auth.ts   # 设备流、DPAPI Token 加密存储、gh CLI 同步
  client/
    index.ts         # 浏览器端入口：选择宿主（better-sidebar 页签 / 独立卡片）
    embed.tsx        # better-sidebar 页签注册（结构化类型，可选 peer）
    shell.tsx        # 独立宿主：可折叠的右栏卡片
    Panel.tsx        # 主面板：分支 / 变更 / 图谱 / PR / 议题 / GitHub / Agent
    styles.ts        # 全部样式，建立在宿主主题令牌之上（见 DESIGN.md）
    api.ts           # /gitm/* 路由的类型化 Fetch 封装
    events.ts        # SSE 订阅 + 页签角标共用的共享事件存储
    i18n.ts          # 中英文双语词典
    icons.tsx        # 图标唯一来源（16px 网格、1.5 笔重内联 SVG）
    graph.ts         # 提交 DAG Lane 布局算法
```

## 宿主形态

面板**不抢占宿主已经拥有的表面**：

- **装了 `dsh-better-sidebar`** —— 面板注册成它的一个侧栏页签（`dsh-git-manager:panel`，标题「Git 管理」，单实例幂等），**不再**自己挂右栏。从侧栏的「新建页签」列表里打开，之后随会话持久化。页签上带**实时角标**：当前有多少个写操作在等你批准。
- **没装 `dsh-better-sidebar`** —— 面板保留自己的右栏卡片，头部多一个收起把手。收起后只剩头部条，并**停止全部轮询**（不会在后台继续打 git），状态落 localStorage。

探测是运行时的（`ctx.get('betterSidebar')`），所以 better-sidebar 始终只是**可选 peer**：没有硬依赖、构建期不 import 它的类型；注册失败也只降级成独立卡片，不会把面板弄丢。也可以用 `localStorage['gm.host'] = 'dock' | 'tab'` 手动覆盖（默认自动）。

面板还会**跟随所属会话的工作区**：先取宿主给的 `scope.cwd`，没有就用"当前选中的会话"；你切换会话时它自动切到对应仓库——**没见过的仓库会先自动收录**（宿主会向上找到最内层的仓库根，所以会话停在一个嵌套仓库里时，选的是那个仓库而不是包着它的工作区）。**绝不覆盖你手动选的仓库。**

### 什么算"我正在改的文件夹"

会话的工作区往往只是个**容器**——`D:\Harness` 里套着十几个独立仓库——只看会话 cwd 永远不知道你此刻在动哪一个。所以宿主还盯着 `tools/execute`：取文件类工具（`read` / `write` / `edit` / `grep` / `glob` 等）的路径参数，向上找到所属仓库根，**把它自动收进下拉框**。**还不存在的文件也算**——观测发生在工具执行之前，`write` 新建文件恰恰是最该被看见的那一类活动。

- 自动收进来的条目标了 `auto`，下拉框里显示成 `名字 · 自动`：货架自己长了要看得见，才不会变成一件玄学。
- 自动条目上限 **20** 条，超了淘汰**最旧的自动条目**；手动收录的一条都不会动。
- 每收一条就往活动流里发一条 `repo:auto-added`。
- 想关掉：在插件那一行加 `config.autoRegisterRepos: false`——下面的悬挂条仍会显示正在动什么。

下拉框下面常驻一条**两行悬挂提示**，两个问题一眼可答：

```
会话文件夹   D:\Harness
正在修改     D:\Harness\dsh-learn-wiki
```

第一行是面板跟随的会话文件夹，第二行是 agent **此刻**在动的文件夹（写类工具显示「正在修改」，只读类显示「正在读取」）。当第二行是个已收录、但不是当前选中的仓库时，旁边会出现一个**切过去**按钮。

## 开发

```sh
pnpm install
pnpm run build
```

构建产物：`lib/`（宿主端）和 `client/`（浏览器端 bundle）。

```sh
node scripts/test-activity.mjs   # 文件活动自动收录（在临时 home 下跑，不碰真实货架）
```

## 许可证

MIT
