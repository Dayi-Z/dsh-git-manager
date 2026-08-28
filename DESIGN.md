# gitcompass 设计系统（DESIGN.md）

从既有实现记录的地面真相。世界：**GitHub Primer 血统 × DSH 宿主共生**——面板不拥有页面，它是 DSH GUI 里的一块 320–760px 仪表，视觉目标是"消失进任务"（Operate 模式）。

## 令牌

- 主题开关：`body[data-ds-dark-theme]` 镜像，所有颜色走 `--gc-*`，双主题自动成立。
- 亮：bg #ffffff / bg-soft #f6f7f8 / fg #1f2328；暗：bg #161b22 / bg-soft #1d232c / fg #e6edf3。
- 语义：accent 绿（GitHub 成功色）只给主操作/选中/成功；red 失败；amber 警告；info 蓝。禁止 accent 满天飞。
- mono：`--gc-mono` 用于哈希、路径、差异、numstat、事件时间。

## 图标

`src/client/icons.tsx` 单一来源：16×16 网格、1.5 笔重、round cap/join、currentColor、`fill:none`（点阵除外）。
**禁止 emoji/Unicode 充当图标**（历史教训：🌳/☰/＋/−/↩/✕/✓ 全部已替换）。

## 组件语法

- 按钮：统一 6px 圆角、11.5px/500、中性 hover（bg-hover）；`.primary` 实心 accent；`.sm` 22px 图标钮；active 下压 0.5px；disabled .4。
- 页签：下划线指示器 + 图标 + 文字，激活态 accent 文字 + 2px 底线（无底色）。
- 行：5px 圆角、hover bg-hover、行内操作 hover 浮出（opacity 0→1）。
- 状态字母徽章 `M/U/A/D/R`：右置、mono 10px/700、色边框。
- 区块头：10px/600 大写 + 0.05em tracking + opacity .55。
- 空态：图标 + 标题 + 教学提示（"工作区干净"不是终点而是状态陈述）。

## 反馈

`feedback.ts` 总线 → 顶部 `OpBanner`：成功 accent-soft 底、8s 自动收起；失败红底常驻；结果卡（pre.mono）带复制按钮——gh 通道推送的 sha 对照就住在这里。错误一律 report，不再 alert。

## 浏览器表面

滚动条（9px 圆头）、::selection（accent-soft）、focus-visible 2px accent 外环——全部主题化，不许默认样式漏网。

## 动效

150–200ms ease-out；横幅滑入；流程条脉冲点。无页面加载编排，动效只表达状态。
