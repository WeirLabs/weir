# hash_edit 会话 diff 面板

> `hash_edit` 工具调用在会话中以结构化 diff 面板呈现，改了哪些行一目了然。

## 概述

`hash_edit` 是预设的唯一编辑工具，但此前在会话里只走通用工具卡片（原始 JSON 入参 + 平铺文本结果）。本特性让它获得与 stock `write`/`edit` 同级的呈现：服务端在成功调用上持久化结构化 diff 元数据（`meta.diffs`，与返回给模型的 unified diff 文本来自同一趟比较），客户端 bundle 通过 DSH Web GUI 的 keyed slot `tool.call.toolview` 注册 `hash_edit` 专属视图，渲染为带复制/换行/折叠铬件的原生 diff 面板。

## 用户可见行为

- 会话中的 `hash_edit` 调用显示为一行卡片：编辑图标、目标路径（点击经宿主的 `openFile` 打开文件）、`+增 −删` 统计；展开后是逐 hunk 的 diff 面板（路径头 + 删除/新增/上下文行着色，超长折叠）。
- 调用进行中（start 阶段）：展示从入参推导的「计划编辑」预览（逐操作的内容片段）并明确标注尚未应用；流式准备阶段（preparing）只显示一行占位。
- 调用失败（如锚点不匹配）：显示失败状态与 mismatch 报告文本，不显示 diff。
- 旧会话日志（无持久化元数据）与任何畸形数据：回退到平铺的输入/输出展示，行为与此前一致。

## 配置

本特性无配置项。

## 设计细节

- **元数据通道**：`hashline-edit` 工具定义新增 `output.presentationMeta(args, value)`，返回 `{ diffs }`——每 hunk 一个 `{ path, oldText, newText }` 片段（两侧各带 3 行上下文；`oldText` 仅在该 hunk 完全没有旧侧行时为 `null`）。`src/hashline-edit/diff.js` 的 `diffResult` 一趟比较同时产出渲染文本与结构化片段，两个通道不会互相矛盾。宿主运行时仅在成功且为根调用时持久化 meta（PTC 子调用无 meta，客户端自动回退）。
- **客户端注册**：`lib/client.js`（入口组合根，见 [client-module-chunking.md](client-module-chunking.md)）的 `apply` 在独立 `ctx.effect` 中 `ctx.slots.inject('tool.call.toolview', … key: 'hash_edit', locale: NS)`——与 `dsh-client-ui-skill` 注册 `skill` 视图同一模式；视图本体住在 `lib/client.hash-edit-view.js` chunk（`require.async` 到达，到达前复用既有通用扁平 body 降级，到达后无缝换成 diff 面板）；注册失败不影响设置页与 LSP 开关。
- **视图组件**：`HashEditRow` 按 `phase` 分派——`preparing` 占位行；`start` 从 `argsRaw` 防御性解析出入参并合成计划片段（空 `text` 的纯删除无预览片段）；`result` 窄化 `block.meta.diffs` 后交给 `primitives.DiffBlock`，行内样式沿用 bundle 既有约定，文案全部走 bundle 自有 en/zh 词典。所有 wire 数据（重放日志、缺失 meta、畸形 args）都做防御性窄化，失败即回退平铺展示，绝不抛异常。

## 边界与失败语义

- 无 meta（旧日志、子调用、畸形）→ 平铺输入/输出，不渲染空面板、不抛错。
- 锚点拒绝、沙箱拒绝等失败调用不持久化任何 diff 元数据。
- 面板是纯展示层：不持有状态、不写会话、不影响模型上下文（模型看到的仍是 unified diff 文本）。

## 测试

- 单元测试：`test/hashline-edit.test.js` 覆盖 `diffFragments`（分 hunk、上下文、纯插入的 context-only oldText、相同内容为空）与 `presentationMeta`（成功持久化片段、拒绝调用无元数据、渲染文本不变）；`test/client.test.js` 覆盖视图模型助手（meta 窄化、args 解析、状态推导、路径相对化）与 `HashEditRow` 各阶段渲染决策（含注册形状断言 `{ name: 'tool.call.toolview', key: 'hash_edit' }`）。
- 集成测试：`orrery-test-harness` 的 hashline 场景新增两条断言——成功 `hash_edit` 的 `tool/result` 事件持久化 `meta.diffs` 片段；失败调用无 diff 元数据。
