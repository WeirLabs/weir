# 工具使用观测

> 用本地、脱敏的请求工具面与调用结果事实，评估 MCP 渐进披露，而不复制模型载荷或上报外部遥测。

## 概述

Weir 在既有 capability/skill-selection Host 组合根挂载薄观察模块，消费已提交 Session 的原生 `request/header` 事件与最终 `tools/result`。观察结果通过共享 audit 通道同时发出进程内 Cordis 事件，并以 best-effort 方式追加到 `<会话 cwd>/.weir/audit.jsonl`；不写自定义 Session 事件，因此不影响会话冷读。

观测覆盖请求中的全部工具 schema 与最终工具调用，不限于受管 MCP。它提供 count/byte 与结果证据，不证明模型实际发现了某个 deferred 工具，也不把配置标记解释为 token 节省。

## 用户可见行为

- 每个含 `header.tools` 数组的已提交请求头产生一条 `weir/tool-usage/request` 审计事实；显式空数组记录真实的零计数/零字节，缺省或非数组 `tools` 不产生记录。
- 每个具备工具名的最终结果产生一条 `weir/tool-usage/result`，区分成功与错误，并在运行时提供时保留稳定错误码和 `callId`。
- 可在会话工作区的 `.weir/audit.jsonl` 按 `session`、`type`、`data.seq` 或 `data.callId` 查询和关联；没有新增面板、消息、工具或通知。

例如，在安装 `jq` 的本机环境中：

```sh
jq -c 'select(.type == "weir/tool-usage/request")' .weir/audit.jsonl
jq -c 'select(.type == "weir/tool-usage/result" and .data.isError == true)' .weir/audit.jsonl
jq -c 'select(.session == "<session-id>" and .data.callId == "<call-id>")' .weir/audit.jsonl
```

`request` 的 `data.seq` 对应原生 `request/header` 的事件序号；`result` 的 `data.callId` 对应原生工具调用/结果中的调用 ID。模块不虚构两类记录之间不存在的直接关联字段。

## 配置

本特性无配置项，随既有 capability/skill-selection 组合根挂载。

## 设计细节

共享 [audit.js](<../../plugins/weir-harness/src/shared/audit.js>) 的 `AUDIT_TYPES.toolUsage` 与 `AUDIT_SUBTYPES.toolUsage` 统一登记 `request`/`result`。[tool-usage-observability.js](<../../plugins/weir-harness/src/capabilities/tool-usage-observability.js>) 只构造下列白名单字段；共享记录外层另有 `time`、`session` 与 `type`。

### `tool-usage/request`

| 字段 | 含义 |
|---|---|
| `seq` | 已提交 `request/header` 的事件序号（可得时） |
| `provider` / `model` | 请求头 `config` 中的路由身份（可得时） |
| `schemaCount` | `header.tools` 中的 schema 总数 |
| `deferredCount` | 其中 `deferLoading === true` 的数量 |
| `schemaBytes` | 每个完整 schema 分别经 JSON 序列化后的 UTF-8 字节总和 |
| `deferredSchemaBytes` | 同一序列化口径下 deferred 子集的字节数 |

立即呈现子集的字节数可由 `schemaBytes - deferredSchemaBytes` 求得。字节是本地成本代理，不是供应商 tokenizer 的精确 token 数，也不是实际节省量；真实 input/output usage 仍由原生 Session assistant message 承载。

### `tool-usage/result`

| 字段 | 含义 |
|---|---|
| `name` | 最终执行的工具名 |
| `isError` | 最终结果的布尔错误分类 |
| `code` | `result.error.info.code` 中的稳定错误码（可得时） |
| `callId` | 执行关联 ID（可得时） |

请求记录不保存 schema、description、parameters、prompt 文本或工具名称清单；结果记录不保存 arguments、value、content、canonical values、raw error/message/reason 或秘密。模块不发起网络请求，不接入外部 telemetry，也不新增 Cordis service 或预设 realm。

## 边界与失败语义

- 审计 emit、JSONL 镜像或观察回调失败均被隔离，不改变模型回合、工具结果、admission 决策或已提交 Session 事件。
- 无法序列化的异常 schema 不产生伪造测量；观测异常不会向模型或用户载荷追加诊断正文。
- JSONL 是本地 best-effort append-only 镜像；无 cwd 时仍可有进程内事件，但没有文件镜像。共享 audit 不提供自动轮转、保留期限或跨会话聚合，日志保留与清理由本地工作区政策负责。
- 单元测试证明字段白名单、计数/字节与失败隔离，不替代真实 MCP fixture、支持路由的模型发现/加载/调用或不支持路由回退验收。

## 测试

- `tool-usage-observability.test.js` 覆盖混合/空/缺省工具请求、UTF-8 字节、provider/model 与事件序号、success/error/code/callId、秘密和载荷排除、审计失败隔离、disposer，以及既有组合根的实际挂载。
- `audit.test.js` 继续覆盖 Cordis emit + JSONL 双写、无 cwd 行为和 emit/file 故障不抛出。
