# 分类委派（category-delegation）

> 专业的事交给专业的模型：主 agent 用 `delegate` 把任务派给绑定合适模型链与专属提示词的子代理。

## 概述

`delegate` 是 Orchestrator 的执行手臂。任务类别（category）各自绑定一条按优先级排序的模型链和一份类别心智提示词；另有三个精选只读研究代理（`explore` 代码检索、`librarian` 文档/OSS 调研、`oracle` 架构咨询）。委派可单个、可批量（≤16）、可放后台；子代理不可再委派，保证拓扑可控。

## 用户可见行为

- 主 agent 调用 `delegate({ category, prompt })` 或 `delegate({ agent, prompt })`（两者必须且只能给其一），也可用 `tasks` 批量派发。
- 后台委派（`run_in_background: true`）立即返回 job 标识；完成时主 agent 只收到紧凑通知，完整报告用 `job_output` 拉取——报告全文不会自动灌进上下文。
- 模型链逐档解析：首选不可用自动落到下一档；整链不可用时**显式报错**（点名类别与尝试过的档位），绝不悄悄换到别的模型族。
- `deep` 类别子代理若首行返回 `ESCALATE: deep-plus`，自动携带其发现重派到 `deep-plus` 一层，并声明发生了升级。
- 只读代理试图写/改文件会被拒绝（只读是强制的，不是建议）。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| 类别注册表 | 内置 9 类别 | 每类别：`description`、`guidance`、`promptAppend`、有序 `chain: [{provider, model, reasoningEffort?}]`、可选 `gateModels`、`disabled` |
| 代理注册表 | `explore`/`librarian`/`oracle` | 精选只读代理定义 |
| 模型族提示词变体表 | 内置 | 按模型族选择提示词变体（Claude/Kimi 式清单风格、GPT 式原则风格、其余中性），可覆盖 |

均为 volatile config，在线编辑即刻生效。

## 设计细节

- 模块：`orrery-harness/delegate`；派发走 `ctx.subagents.start`，一次调用携带 `agentOptions`（钉模型与推理档）、`persona`、`toolFilter`（只读白名单）、`maxDepth: 1`（禁止再委派）。
- 链解析规则：provider 已注册且（其 catalog 为空或包含该 model）即可解析；`reasoningEffort` 支持度经模型信息校验；适配器更新事件触发重解析。
- 后台道一律走 one-shot job（拉取语义），保证报告全文不自动入上下文。
- 类别与 `model` 同时提供会被拒绝（类别已含路由，不允许二义）。
- 多 Agent 协作全部自研，不依赖 DSH 官方 experimental Agent Team 插件。

## 边界与失败语义

- 参数二义（`category` 与 `agent` 同给或都不给）→ invalid-arguments 错误。
- 类别整链不可解析 → 显式 "category unavailable" 错误，点名类别与档位。
- 只读代理的写/编辑调用 → 拒绝并注明只读原因；精选代理调 `delegate` → 深度限制错误。
- **保证**：子代理永不可再委派（拓扑深度恒为 1）。

## 测试

- 单元测试：`test/` 覆盖参数校验、链解析（含死链报错）、变体选择、ESCALATE 重派、批量默认值。
- 集成测试：`delegate` 场景——父 agent 发起委派、子会话以子代理身份在委派提示词上运行、结果回到父 agent。
