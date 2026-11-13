# Weir 客户端设计系统

Weir 的浏览器半区（`plugins/weir-harness/lib/client.*.js`）不是一堆各自为政的样式，而是共用一套设计系统。本文说明这套系统遵守的规则、可复用的原语，以及验证方式。

依据是 DSH 官方规范：`docs/web-styling`（样式职责与组件规则）、`docs/ui-radius`（圆角分级）、`docs/ui-design-review-cases`（设计判断与审查案例）。Weir 作为插件不能引用宿主的 `ui-primitives`（插件侧只暴露 `ctx`、`React`、`host.call`、`styles.insert`、`console`），因此原语自研，但材质、尺度与取舍必须与官方一致。

## 1. 单一呈现来源

- 样式表与 UI 原语只在 `lib/client.decision-ui.js` 定义一次，通过 `styles.insert` 在客户端启动时注入（组合根 `client.js`），任何面都可直接使用其类名与变量。
- 其他 chunk 不得自行定义颜色、圆角、阴影、遮罩或菜单材质。
- 呈现规则写在 CSS；React 只传语义属性（`data-variant`、`data-size`、`data-selected`）。内联 style 仅用于几何量（按测量计算的定位/尺寸）。

## 2. 令牌纪律

- 只使用宿主真实存在的 `--dsw-*` 令牌；禁止 hex / `rgb()` / `hsl()` / `white` / `black` 字面量与 `--dsw-static-*` 静态色板。
- **禁止 `var(--dsw-x, fallback)`**：fallback 会掩盖拼错的令牌名。历史上正是靠 fallback 藏着 9 个不存在的令牌（`--dsw-alias-focus-ring`、`--dsw-alias-interactive-bg-solid` 等）。
- 唯一允许的字面色是与主题无关的模态黑色蒙层 `rgba(0, 0, 0, .32)`。
- 插件不通过 `ctx.theme.overrideTokens` 改写全局主题。

## 3. 圆角与材质

| 用途 | 圆角 |
|---|---|
| 小细节（标签、键帽） | `--dsw-radius-xs`（R4） |
| 紧凑控件（H20–28 按钮、菜单项） | `--dsw-radius-sm`（R8） |
| 标准控件/单行 cell（H32–40） | `--dsw-radius-md`（R12） |
| 多行 cell、分组内容 | `--dsw-radius-lg`（R16） |
| 独立内容卡片 | `--dsw-radius-xl`（R20） |
| 面板与对话框/菜单外层 | `--dsw-radius-panel`（R28；菜单外层用 R16） |

- 中性边框与分隔线一律 **0.5px**；浮层使用 `border: 0` + `--dsw-elevation-panel|prominent|soft`，不得在 elevation 上再叠中性边框。
- 状态色（warn/error）边框保留真实 1px 边框。
- 设置表单本身是**扁平分区**（标题 + 发丝线行），不在宿主任内再套卡片；卡片材质留给真正独立的卡片（决策记录、插件/预设列表卡）。

## 4. 遮罩与浮层

- 确认类模态使用原生 `<dialog>.showModal()`：黑色半透明遮罩、背景 inert、滚动锁（root/body/页面/实际滚动祖先）、焦点进入与归还、Esc 与点击遮罩关闭。
- 输入框旁的选择器同样是原生 dialog（保留焦点陷阱与滚动锁），但**锚定到触发器上方**：遮罩透明、宽度 320–360px、上方空间不足翻转到下方、每次定位保留 8px 视觉视口边距、由 ResizeObserver 在内容变化后重排。
- 菜单/下拉统一材质：R16 外层 + 4px 内边距 + R12/H32 菜单项 + `--dsw-specific-menu` + `--dsw-elevation-panel`，视口内夹取（先纵向翻转，再清横向锚定）。

## 5. 排版

- 字号与行高成对使用 `--dsw-font-*` 角色（`xxxs-11`…`xl-24`，含 strong 变体），不再写裸 px。这样用户的“内容字号”设置能真正传导到插件界面。
- 每页只有一个 H1，标题层级 H1→H2→H3 不跳级。
- 正文最小 12px；历史遗留的 9/10px 文本已并入最小角色。

## 6. 原语

`PageHeader`、`Section`、`Row`、`Button`（`sm`/`md`，`primary|secondary|ghost|danger`）、`Field`、`Badge`、`Notice`、`Skeleton`、`Tabs`、`Menu`/`MenuItem`/`MenuSeparator`、`Disclosure`、`ConfirmDialog`、`DecisionModalFrame`、`LoadingState`/`EmptyState`/`ErrorState`。

## 7. 契约测试

`test/client-ui-design-system.test.js` 扫描全部客户端 chunk，出现以下任一情况即失败：未登记令牌、颜色字面量、`var()` fallback、中性 1px 边框、档位外圆角。令牌白名单是显式清单，新增令牌必须同时证明它在宿主令牌集合中真实存在。

## 8. 验证与已知边界

- 单元与契约测试覆盖原语行为、焦点/滚动锁/几何夹取。
- 真实渲染证据用隔离 profile 的 Desktop 截图（`.weir/uiux-visual/`），覆盖明暗主题与锚定浮层定位。
- 已知边界：状态圆点（6–8px）仍使用 `border-radius: 50%`，未配对 `corner-shape: round`（该尺寸下视觉差异不可辨，记为有意例外）；完整视觉矩阵（中英、360/768/1440、200% 缩放、键盘-only）在变更验收阶段补齐。

## 9. chunk 缓存与内联关键布局

宿主以入口 `lib/client.js` 的 fs 元数据生成 rev 作为全部 lazy chunk URL 的唯一缓存键，且响应为 `cache-control: immutable`（硬契约见 `docs/spikes.md` S49）：入口 rev 不变时，浏览器永久命中旧 chunk，Cmd+R 与重启 App 都不能自愈。因此凡「被旧 CSS 覆盖就会造成重叠/裁切事故」的关键布局（如判断记录条目的 `display`/`width`/`box-sizing`）一律内联在元素上，组件不因样式表 chunk 新旧而错位；chunk 修复合入后必须重建 digest 顶起 rev，并要求用户完全退出重开 App。
