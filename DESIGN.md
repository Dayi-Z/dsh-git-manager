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

## 简洁的判据（每一条都是量出来的）

"不简洁"通常是**同一屏里描边控件太多、色块太多、横向分隔线太多**。可执行的规则：

- **动词留文字，其余一律圆形图标钮。** 头部四个动作从"两个带框文字钮 + 两个带框图标钮"变成四个 26px 无边框圆形——下拉框宽度从 111px 回到 209px。动作行同理：8 个控件里只留"暂存全部 / 推送"两个动词，其余是图标（行从两行收成一行）。
- **状态靠颜色，不靠底片。** 流程条原来是六个带底色药丸（全屏最吵的一条），现在只有文字 + 小圆点：绿=已完成、蓝=进行中、灰=待办。
- **偏好不占动作行。** "拉取方式（合并/变基）"原本夹在"抓取"和"拉取"之间当切换钮，其实它是偏好——挪进设置。
- **横向分隔线要数。** 顶部曾经三条发丝线（头部/流程/页签）；流程条只是注释性质的一行，去掉它下面那条，只剩两条。
- **不要重复计数。** 动作行尾部写着 "N files"，而区块头已经写了"更改 (N)"——删掉前者，空工作区改用一个正经空态。

## 反馈

`feedback.ts` 总线 → 顶部 `OpBanner`：成功用成功色 soft 底、8s 自动收起；失败红底常驻；结果卡（pre.mono）带复制按钮——gh 通道推送的 sha 对照就住在这里。错误一律 report，不再 alert。

## 浏览器表面

滚动条走 `scrollbar-bg-l2 / hover-l2`、::selection 用 accent-soft、focus-visible 统一 `2px solid interactive-bg-hover-accent`（offset -1px，与 better-sidebar 同一约定）。`prefers-reduced-motion` 下关闭全部动效与过渡。

## 宿主形态（面板不抢别人已有的表面）

面板有两种挂载形态，由**运行时探测**决定，而不是编译期依赖：

- **`dsh-better-sidebar` 在场** → 注册成它的一个页签（`registerTab`），把右栏让给它。页签角标直接顶"待批准写操作数"——面板最需要被看见的状态。
- **不在场** → 保留自己的右栏卡片，头部带收起把手；收起后只剩头部条并停止轮询。

两种形态**共用同一份 `CompassPanel`**，差异只通过可选 props 表达（`cwd` / `collapsed` / `onToggleCollapsed`），面板本身不认识任何一个宿主。宿主差异全部关在 `client/embed.tsx`（better-sidebar）与 `client/shell.tsx`（独立卡片）里。

推论（设计纪律）：**探测必须是软的**——`ctx.get('betterSidebar')` 返回 null 是正常路径；注册抛错要降级成独立卡片而不是丢面板；better-sidebar 的类型只以结构化子集声明，不进构建依赖。

还有一个推论：**强调色不是品牌色**。DSH 暗色主题里 --dsw-alias-brand-primary = #f9fafb（白），而 --dsw-alias-accent-soft 根本不存在——把它当强调色，.gm-step.active 就是白字叠白底（"分支绿色、其它白色"那个 bug）。可用的是状态令牌：进行中用 business 蓝（#679efe）、已完成用 success 绿（#22c55e）、待办用 label-tertiary 灰，三态各自可读。**别猜主题，去页面里把令牌值读出来。**

另一个推论：**隐藏 ≠ 继续跑**。面板被收起或被切走时，宿主调 `setPanelActive(false)`，`usePoll` 停发请求；重新可见时广播 `gm:active`，所有轮询立刻补一次而不是干等一个周期。

## 样式落点

`src/client/styles.ts` 是唯一的表现层来源（2.0 从 Panel.tsx 里抽出，Panel.tsx 随之从 2006 行降到 1740 行）。

## 动效

150–200ms `--ds-ease-in-out`；横幅滑入；流程条脉冲点。无页面加载编排，动效只表达状态。
