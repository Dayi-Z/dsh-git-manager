# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

DeepSeek Harness 的单开发者用户（主要即仓库作者本人）：在 DSH Web GUI 右侧面板内完成日常 git/GitHub 工作流——查看变更、提交、推送、审阅图谱、管理分支与 PR/Issue，并监控 AI 代理的仓库操作。

## Product Purpose

dsh-git-manager 是一个 Cordis 插件面板：把散落的 git 命令与 GitHub 操作收进一个 300–520px 的可视化面板，让 AI 代理与人在同一套审批与仓库视图里协作。成功 = 用户不离开面板就能安全完成仓库全流程。

## Positioning

与 DSH 会话审批系统深度整合的 git 工作台：代理的每次写操作都经过面板审批卡与会话预批准生命周期（芯片/吊销），这是邻近工具（VS Code SCM、Trae）没有的机制。呈现上它选择做**宿主的一部分**——全部视觉值走 DSH 主题令牌，换皮肤即换装；生态上也一样，装了 dsh-better-sidebar 就并入它的页签体系，而不是在旁边再立一块自己的面板。

## Operating Context

- 嵌入 DSH Web GUI 共享右栏 Dock（宽 300–520px 可拖），非独立页面。
- 主题跟随宿主：颜色全部走 `--dsw-alias-*` 令牌，明暗与皮肤由主题包决定——面板内**没有** `body[data-ds-dark-theme]` 选择器。
- 中文为主要界面语言（i18n zh/en 双语均需维护）。
- 网络环境：github.com:443 常不可达；api.github.com 与 gh CLI 是已验证的恢复通道。

## Capabilities and Constraints

- 页签：分支 / 变更 / 图谱 / GitHub(PR·Issue) / Agent 活动监控，外加仓库选择与流程条。
- Trae 式变更页：置顶提交框（Ctrl+Enter）、已暂存/更改分组、状态字母、行内操作、树/平铺切换、传出的更改。
- 图谱三层下钻；gh/API 通道推送（逐提交远端重建，已实测 sha 逐字节一致）。
- 面板操作由用户点击直接触发，不经代理审批流；代理写操作走审批卡。
- 双宿主形态：装了 dsh-better-sidebar 就注册成它的一个页签（不抢它拥有的右栏），没装就保留可折叠的独立右栏卡片；探测是运行时的，better-sidebar 只是可选 peer。
- 约束：无外部图标/字体运行时依赖（离线可用），SVG 全内联；单一 React 客户端包。

## Brand Commitments

- 宿主优先的视觉血统：调色板即 DSH 主题令牌（见 DESIGN.md 的别名层），mono 用于哈希/路径/差异。
- 平面纪律：流内无阴影，结构靠发丝边框与 hover 底色；高度只留给浮层。
- 用户明确反感并绑定：emoji/Unicode 充当图标、廉价树图标、操作无反馈——三者都是必须消灭的反模式。
- 文本按钮优先于 emoji；等宽令牌用于一切机器可读文本；双主题与多皮肤自动成立。

## Evidence on Hand

- 真实仓库：D:\Harness\dshmarket\dsh-git-manager（自托管）、D:\Harness\dshmarket\tint（真实 WIP 数据）。
- gh/API 推送实测记录：4 笔提交远端重建后 sha 与本地逐字节一致。
- 设计对标：dsh-better-sidebar 0.19.1（`~/.dsh/profiles/web/node_modules/dsh-better-sidebar/src/client/`）——令牌用法、平面纪律、圆形图标钮、页签与 diff 渲染的既有实现。

## Product Principles

1. 任务先行：表达永不遮蔽任务与状态（Operate 模式）。
2. 状态必须可见：每个操作都有即时、明确、可追溯的反馈。
3. 一套图标语法：统一笔重的内联 SVG，绝不混用 emoji。
4. 令牌驱动：任何颜色/间距不写死，明暗与皮肤自动成立。
5. 宿主共生：面板的每一个像素都应该是宿主主题能解释的像素。

## Accessibility & Inclusion

- 正文对比由宿主主题保证 ≥4.5:1；键盘焦点环可见；每个图标按钮都有 title 与禁用态。
- 页签是真正的 `<button role="tab">`；`prefers-reduced-motion` 下关闭动效。
