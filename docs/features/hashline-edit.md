# 锚点编辑（hashline-edit）

> 文件读取自带行锚点，编辑逐锚校验、有一处对不上就整体拒绝——改得准、不毁文件、还省 token。

## 概述

`read` 工具的输出每行携带 `N#XX|` 锚点（行号 + 两字符内容校验码）。编辑工具 `hash_edit` 引用这些锚点定位改动，写入前逐锚比对文件当前内容：任一锚点失效（文件已被改动），整个调用拒绝、文件一字节不动。编辑成本远低于复述上下文的精确匹配式编辑，且天然免疫"基于过期快照写入"的毁文件事故。

## 用户可见行为

- 读取文件 → 每行前缀 `N#XX|`；同一文件读两次锚点完全相同（确定性）。
- `hash_edit` 支持 `replace`（锚点区间）、`append`（锚点之后）、`prepend`（锚点之前），一次调用可携带多个操作，自底向上应用（同一调用内的行号都基于同一快照）。
- 每个操作的内容由 `text` 给出：**单个字符串**，行之间用两字符转义 `\n`（如 `"text": "a\nb"`）。空串有特殊语义：`replace` 下删除锚点区间，`append`/`prepend` 下为无操作。（原 `lines` 字符串数组通道已移除，属 breaking 变更。）
- 成功 → 返回 unified diff，改了什么一目了然；同时持久化结构化 diff 元数据（`meta.diffs`），会话中以 diff 面板呈现（见 [hash-edit-diff-view.md](hash-edit-diff-view.md)）。
- 任一锚点失效 → 整体拒绝并给出 `>>> mismatch` 报告（点名失效锚点），**文件零写入**。
- 与 stock `edit` 的关系：**预设默认隐藏 stock `edit`**，`hash_edit` 是唯一编辑工具；配置 `hideStockEdit: false` 可回归 v0.1.0 的共存模式（此时 doctrine 引导优先用 `hash_edit`）。其他预设不受影响。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `hideStockEdit` | `true`（预设行默认） | 为 `false` 时预设内 agent 重新看到 stock `edit`，与 `hash_edit` 共存 |

volatile config，在线编辑即刻生效。

## 设计细节

- 模块：`orrery-harness/hashline-edit`。
- 锚点生成：`tools/post-execute` 增强 `read` 结果；两字符码取自字符集 `ZPMQVRWSNKTXJBYH`，由行内容哈希（自实现 xxHash32）导出；纯空白行以行号为种子，保证可区分。
- 校验模型：fail-closed——所有锚点先对当前文件内容验明正身，全部通过才应用任一操作；应用按行号自底向上，避免位移污染。
- 内容切分：运行时将 `text` 按 `split('\n')` 切行，**至多丢弃一个尾部空元素**、内部空行保留（`'a\nb\n'` → `['a','b']`，`''` → `[]`），与写盘的 `join('\n')` 互逆，不会静默增删空行。Schema 的 `edits.items.required` 为 `['op','pos','text']`，单通道后 schema 重新完整描述契约。
- 工具定义为纯对象 + object-rooted JSON Schema（严格供应商兼容）。
- 写入走 `ctx.fs` 并**携带 per-call sandboxPolicy**（`sandboxPolicy.resolve({ session })` 现算，作 `writeText` 第 5 参；服务缺席时退化为无策略调用形态）——会话沙箱策略（模式 + 会话工作区根）对写入生效，与 stock `write`/`edit` 工具同契约（S23 事故修复）。
- **一次性沙箱升权**：与 stock `write`/`edit` 同契约。`ctx.fs.sandboxMode` 能力事实在场（沙箱后端挂载）时，schema 广告 `sandbox_permissions`（enum `workspace-write`/`danger-full-access`）与 `justification` 两个可选参数，字段描述与 stock 逐字一致；无沙箱后端的组合不暴露这两个参数。执行顺序：参数配对校验（malformed 在任何文件操作前失败）→ 同模式重复免审批直行 → 严格更宽档（`read-only→workspace-write→danger-full-access`）经宿主 `approval` 服务请求用户审批，`allowed-once` 仅对本次调用生效 → 拒绝/取消/无通道/无审批服务/无 agent 一律 fail-closed。升权只改 mode，不改 workspaceRoot。整次调用的策略决议（能力探测 `probeEscalation`、配对校验、standing 解析、门控、审批、合并、schema 广告字段）都收在 `src/hashline-edit/sandbox.js` 的 `resolveCallPolicy(args, env) → { policy, resolveCwd, advertisedFields }` 单一接口后面——`execute` 读作「先决议、后编辑」，顺序规则（校验先于任何文件操作）有模块级单测直接钉住；词汇自实现（link bundle 红线禁静态 import `@deepseek-ai/*`），文本与宿主包逐字一致并由单测锁定；零新 npm 依赖。
- 作用域注册可遮蔽全局同名工具。`hideStockEdit` 统一为**逐 agent 限制**：`agent/created` 时按 agent 视角检查存在性（`ctx.tools.get('edit', agent)`）后 `agent.ctx.tools.restrict({ deny: ['edit'] })`——agent scope 下 stock `edit` 恒为继承（全局层或预设层），可 restrict、目录真隐藏；挂载期 restrict 在 host 层（无作用域）与预设 standing scope（fs 行的 scoped edit 不可 restrict）都不可行，此为统一正确机制（S15 事故修复）。
- **计划预览契约**：`src/hashline-edit/planned-fragments.js` 是 `hash_edit` 入参窄化与计划片段投影的唯一权威实现（纯 ESM 四导出；op 形预览、`oldText` 按构造为 `null`、纯删除无片段）。它位于操作引擎（`apply-ops.js`）与 diff 引擎（`diff.js`）旁，浏览器侧经 `lib/client.hash-edit-model.js` 的逐字派生副本消费（跨侧 parity 测试钉漂移，详见 [hash-edit-diff-view.md](hash-edit-diff-view.md)）。

## 边界与失败语义

- **Edit Lock 接入（仅当开发组合启用 [edit-lock](edit-lock.md) 时）**：`hash_edit` 把合成内容交给锁服务发布；服务可在挂载时或稍后经 inject 出现（cordis 兄弟行服务延迟可见），一旦受管即向服务 `claim` 定义，服务移除后拒绝而不回退直写。未启用时行为不变。
- 锚点过期/篡改/拼写错误 → 整体拒绝 + mismatch 报告，**保证**文件字节级不变（零写入）。
- 多操作调用中仅一个锚点失效 → 同样整体拒绝（原子性）。
- 内容形状错误（`text` 缺失或非字符串、`edits` 不是非空数组）→ **先于任何锚点校验**整体拒绝，错误点名违规字段、说明要求形状并指示按正确形状重新调用（与锚点错配的「重读文件」建议相区分），文件零写入。
- 参数不是合法 JSON（模型生成的括号/转义错误）→ **宿主适配器在工具运行前作废整轮**（无写入、无 mismatch 报告）——任何工具侧校验都拦不住这类失败；`text` 单字符串通道正是为消除实测命中点而设：7/7 起 invalid-JSON 事故的坏点全部在旧 `lines` 数组的括号闭合边界上。
- **保证**：任何失败路径都不产生部分写入。
- 沙箱拒绝（目标不在可写根内）→ 工具错误携带**共享 deny 标记**（`[sandbox: file access denied under <mode> mode]`）与**同轮升权提示**（`[sandbox: escalation available — …]`），文件零写入；被拒后可按提示以 `sandbox_permissions` + `justification` 一次性重试（升权经用户审批），也可改用其他方式。
- 升权参数配对不合法（有 `sandbox_permissions` 无 `justification`、或相反、或空 justification）→ 在任何文件操作前失败。
- 升权结局：用户拒绝 → 报错并明示「停止并解释，不要绕过」；取消/无审批通道/无审批服务 → fail-closed 报错；升权目标不比当前模式严格更宽 → 写盘前拒绝。

## 测试

- 单元测试：`test/` 覆盖锚点确定性、三类操作、多操作原子性、mismatch 报告、diff 输出（含 `diffFragments` 结构化 hunk 与 `presentationMeta` 持久化/拒绝无元数据）、`text` 切分规则（尾部空元素/内部空行/空串）、空串删除的字节断言、缺失/错类型 `text` 先于锚点校验的拒绝顺序与自纠措辞、schema 单通道形状（`required: ['op','pos','text']`、无 `lines`、无 `oneOf`）、工具描述内容锁定（`\n` 示例 / invalid-JSON 整轮警告 / 空串删除说明 / mismatch 段不变 / 无数组通道 / 长度上限）、`hideStockEdit` 逐 agent 机制（逐 agent 限制 / 存在性检查的 agent 视角 / 无 stock edit 豁免）。`test/hashline-planned-fragments.test.js` 覆盖计划预览契约三节（src 单测 / chunk↔src 等价钉 / planned↔applied 对账）。`test/sandbox.test.js` 锁定升权词汇文本、严格更宽表、参数配对、审批四结局、缺服务/缺 agent，并新增 `probeEscalation` 能力两态与 `resolveCallPolicy` 全链路钉（无参时 policy 与 standing 引用相等、`resolve({session})` 入参形状、门控先于审批的顺序、合并形状、`advertisedFields` 同源）；`test/hashline-edit.test.js` 覆盖 schema 门控两态、升权成功路径的 writeText 策略断言（S23 五参形态）、malformed 前置失败、拒绝标记与提示、非拒绝错误透传。
- 集成测试：`hashline` 场景——读取结果带锚点到达模型、`hash_edit` 成功改写目标行、经 `text` 通道的大段 append 字节级落盘、模型工具目录中 stock `edit` 缺席且 `hash_edit` 在场、schema 广告升权字段、成功调用持久化 `meta.diffs` 片段而失败调用无 diff 元数据、真实编辑工作区外文件被拒且错误携带共享标记与升权提示。测试装置镜像了沙箱语义（部署回退根故意不含测试工作区、工作区置于 /tmp 之外），无 per-call policy 的写入会像 desktop 实况一样被拒（S23 回归）。
