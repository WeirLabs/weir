# 锚点编辑（hashline-edit）

> 文件读取自带行锚点，编辑逐锚校验、有一处对不上就整体拒绝——改得准、不毁文件、还省 token。

## 概述

`read` 工具的输出每行携带 `N#XX|` 锚点（行号 + 两字符内容校验码）。编辑工具 `hash_edit` 引用这些锚点定位改动，写入前逐锚比对文件当前内容：任一锚点失效（文件已被改动），整个调用拒绝、文件一字节不动。编辑成本远低于复述上下文的精确匹配式编辑，且天然免疫"基于过期快照写入"的毁文件事故。

## 用户可见行为

- 读取文件 → 每行前缀 `N#XX|`；同一文件读两次锚点完全相同（确定性）。
- `hash_edit` 支持 `replace`（锚点区间）、`append`（锚点之后）、`prepend`（锚点之前），一次调用可携带多个操作，自底向上应用（同一调用内的行号都基于同一快照）。
- 成功 → 返回 unified diff，改了什么一目了然。
- 任一锚点失效 → 整体拒绝并给出 `>>> mismatch` 报告（点名失效锚点），**文件零写入**。
- 与 stock `edit` 共存，doctrine 引导优先用 `hash_edit`；可配置把 stock `edit` 完全隐藏。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `hideStockEdit` | `false` | 为 `true` 时预设内 agent 不再看到 stock `edit`（`hash_edit` 保留） |

volatile config，在线编辑即刻生效。下一迭代计划默认开启（见 CHANGELOG Unreleased）。

## 设计细节

- 模块：`orrery-harness/hashline-edit`。
- 锚点生成：`tools/post-execute` 增强 `read` 结果；两字符码取自字符集 `ZPMQVRWSNKTXJBYH`，由行内容哈希（自实现 xxHash32）导出；纯空白行以行号为种子，保证可区分。
- 校验模型：fail-closed——所有锚点先对当前文件内容验明正身，全部通过才应用任一操作；应用按行号自底向上，避免位移污染。
- 工具定义为纯对象 + object-rooted JSON Schema（严格供应商兼容）。
- 作用域注册可遮蔽全局同名工具，`hideStockEdit` 经 `ctx.tools.restrict` 实现，不影响其他预设。

## 边界与失败语义

- 锚点过期/篡改/拼写错误 → 整体拒绝 + mismatch 报告，**保证**文件字节级不变（零写入）。
- 多操作调用中仅一个锚点失效 → 同样整体拒绝（原子性）。
- **保证**：任何失败路径都不产生部分写入。

## 测试

- 单元测试：`test/` 覆盖锚点确定性、三类操作、多操作原子性、mismatch 报告、diff 输出。
- 集成测试：`hashline` 场景——读取结果带锚点到达模型、`hash_edit` 成功改写目标行。
