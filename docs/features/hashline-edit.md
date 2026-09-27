# 锚点编辑（hashline-edit）

> 文件读取自带行锚点，编辑逐锚校验、有一处对不上就整体拒绝——改得准、不毁文件、还省 token。

## 概述

`read` 工具的输出每行携带 `N#XX|` 锚点（行号 + 两字符内容校验码）。编辑工具 `hash_edit` 引用这些锚点定位改动，写入前逐锚比对文件当前内容：任一锚点失效（文件已被改动），整个调用拒绝、文件一字节不动。编辑成本远低于复述上下文的精确匹配式编辑，且天然免疫"基于过期快照写入"的毁文件事故。

## 用户可见行为

- 读取文件 → 每行前缀 `N#XX|`；同一文件读两次锚点完全相同（确定性）。
- `hash_edit` 支持 `replace`（锚点区间）、`append`（锚点之后）、`prepend`（锚点之前），一次调用可携带多个操作，自底向上应用（同一调用内的行号都基于同一快照）。
- 成功 → 返回 unified diff，改了什么一目了然。
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
- 工具定义为纯对象 + object-rooted JSON Schema（严格供应商兼容）。
- 作用域注册可遮蔽全局同名工具。`hideStockEdit` 统一为**逐 agent 限制**：`agent/created` 时按 agent 视角检查存在性（`ctx.tools.get('edit', agent)`）后 `agent.ctx.tools.restrict({ deny: ['edit'] })`——agent scope 下 stock `edit` 恒为继承（全局层或预设层），可 restrict、目录真隐藏；挂载期 restrict 在 host 层（无作用域）与预设 standing scope（fs 行的 scoped edit 不可 restrict）都不可行，此为统一正确机制（S15 事故修复）。

## 边界与失败语义

- 锚点过期/篡改/拼写错误 → 整体拒绝 + mismatch 报告，**保证**文件字节级不变（零写入）。
- 多操作调用中仅一个锚点失效 → 同样整体拒绝（原子性）。
- **保证**：任何失败路径都不产生部分写入。

## 测试

- 单元测试：`test/` 覆盖锚点确定性、三类操作、多操作原子性、mismatch 报告、diff 输出、`hideStockEdit` 逐 agent 机制（逐 agent 限制 / 存在性检查的 agent 视角 / 无 stock edit 豁免）。
- 集成测试：`hashline` 场景——读取结果带锚点到达模型、`hash_edit` 成功改写目标行、模型工具目录中 stock `edit` 缺席且 `hash_edit` 在场。
