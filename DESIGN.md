# dsh-git-manager 设计系统（DESIGN.md）

从既有实现记录的地面真相。世界：**DSH 宿主原生面板 × GitHub 血统**——面板不拥有页面，它是 DSH GUI 里的一块 300–520px 工作台，视觉目标是"消失进任务"（Operate 模式）。

> **2.0 的设计来源。** 上一版（gitcompass）自带一套 GitHub Primer 硬编码调色板 + `body[data-ds-dark-theme]` 明暗选择器。它好看，但它是"页面里的一块网页"：换任何 dsh-web-ui 皮肤它都不跟随，宿主改主题它也只在明暗两档里跳。
> 这一版把整套呈现重写为 **dsh-better-sidebar 的语法**：全部值走宿主令牌、纯平面、发丝边框、圆形图标钮。结论很简单——**面板是宿主的一部分，不应该是嵌进去的网站**。

## 令牌（唯一的颜色来源）

面板根部 `--gm-*` 是一层**别名，不是调色板**：每一项都解析到宿主令牌，只有在宿主没发布该令牌时才回落到字面量（与 DSH 自己的 chrome 同形：`var(--dsw-alias-label-primary, #202124)`）。

- 颜色：`--dsw-alias-bg-base / bg-layer-1 / bg-layer-3`、`label-primary / secondary / tertiary`、`border-l1 / l2`、`interactive-bg-hover / -active / -hover-accent`、`brand-primary`、`button-primary-fill / -hover`、`state-success / error / warn / business-primary`、`accent-soft`、`scrollbar-bg-l2`。
- 排版：`--dsw-font-xxxs-11`（元信息）、`--dsw-font-xxs-12`（正文）、`--dsw-font-xxxs-strong-11`（按钮/页签/区块头）、`--ds-font-family-code`（哈希/路径/差异）。
- 动效：`--ds-transition-duration-slow` + `--ds-ease-in-out`。
- **没有一处写死的十六进制色，没有一处主题选择器。** 明暗、皮肤、对比度全部由主题包决定。

派生的语义令牌（`--gm-green-soft` 等）用 `color-mix(in srgb, var(--dsw-alias-state-*) 11%, transparent)` 从状态令牌算出，因此换皮肤时它们跟着走。

## 平面与层级

- 流内的一切**没有阴影**：结构由 1px 发丝边框（`border-l1/l2`）和 hover 底色承担。
- 只有**真正的浮层**（分支切换器、设置面板）才有高度，用的是宿主自己的 `--dsw-shadow-lv2` + `bg-layer-3` 表面。
- 圆角：行/按钮 6px，页签 6px，卡片/浮层 8–10px，chip 999px（胶囊）。

## 图标与控制

- `src/client/icons.tsx` 单一来源：16×16 网格、1.5 笔重、round cap/join、currentColor、`fill:none`（点阵除外）。
  **禁止 emoji/Unicode 充当图标**（历史教训：🌳/☰/＋/−/↩/✕/✓ 全部已替换）。
- **纯图标钮 = 26px 圆形、无边框、透明底**，悬停才浮出底色（`.gm-btn.sm`）——图标本身就是可供性。
- 文字按钮 26px 高、6px 圆角、发丝边框；primary 用主题自己的 `button-primary-fill` + 反色墨，**不自己发明绿色**。

## 组件语法

- **页签**：26px 高的填充式激活态（`interactive-bg-active` + 主文字色 + accent 图标），不是下划线；是真正的 `<button role="tab">`，可聚焦、可键盘操作、带 title。
- **行是原子**：固定最小高度（26–28px）、6px 圆角、hover 底色、选中底色——**每行都不描边**。行内操作悬停才浮出。
- **状态字母徽章** `M/U/A/D/R`：右置、等宽 11px/strong、色取状态令牌。
- **区块头**：`--dsw-font-xxxs-strong-11` + 大写 + 0.05em letter-spacing + `label-tertiary`。
- **空态**：图标 + 标题的 `Empty` 原子（"工作区干净"不是终点而是状态陈述）。

## 反馈

`feedback.ts` 总线 → 顶部 `OpBanner`：成功用成功色 soft 底、8s 自动收起；失败红底常驻；结果卡（pre.mono）带复制按钮——gh 通道推送的 sha 对照就住在这里。错误一律 report，不再 alert。

## 浏览器表面

滚动条走 `scrollbar-bg-l2 / hover-l2`、::selection 用 accent-soft、focus-visible 统一 `2px solid interactive-bg-hover-accent`（offset -1px，与 better-sidebar 同一约定）。`prefers-reduced-motion` 下关闭全部动效与过渡。

## 样式落点

`src/client/styles.ts` 是唯一的表现层来源（2.0 从 Panel.tsx 里抽出，Panel.tsx 随之从 2006 行降到 1740 行）。

## 动效

150–200ms `--ds-ease-in-out`；横幅滑入；流程条脉冲点。无页面加载编排，动效只表达状态。
