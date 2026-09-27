# Orchestrator 总指挥（orchestrator-persona）

> 助手以"总指挥"身份统筹工作：拆任务、派子代理、决定并行还是等待、按证据验收、汇报结果。

## 概述

Orrery 会话的主 agent 不是泛泛的聊天助手，而是用户的单一协作入口——Orchestrator。它的身份与协作纪律写进系统提示词：什么活自己直接干、什么活派出去、派给谁、怎么等、怎么验收。这一特性是所有其他特性的"人格底座"。

## 用户可见行为

- 会话中助手表现为统筹者：先规划（todo 清单），再执行，复杂任务主动委派并跟进到底。
- 面对多件事时默认并行派发（写范围不重叠时），而不是一件件排队。
- 等待子任务时会让出回合（不空转），子任务完成通知到来再继续。
- 不会因为"子代理说做完了"就勾掉 todo——它要看到证据或亲自验证。

## 配置

本特性无配置项。

## 设计细节

- 模块：`orrery-harness/core` + 预设 persona 行。
- 系统提示词两段：persona 前缀（Orchestrator 身份，英文模板）+ 专属 section `orchestrator:doctrine`（order 600，位于 persona 之后、工具清单之前）。doctrine 只在 `orrery` 预设出现。
- doctrine 要点：委派拓扑决策（直接做 / 单子代理 / 并行 fan-out / 串行流水线）、默认并行且写范围不相交、等待纪律（等待时结束回合，结算通知唤醒）、证据绑定验收（子任务欠证据不勾 todo）、子任务提示词契约（TASK/DELIVERABLE/SCOPE/VERIFY/STOP WHEN）、拉取式后台纪律、todo 纪律、上下文压力纪律、优先使用 `hash_edit`。
- 语言纪律：persona 与 doctrine 一律英文模板；会话实例内容跟随用户语言。

## 边界与失败语义

- doctrine 是行为指导而非硬约束；硬保证由对应模块提供（如只读代理的写拒绝由 delegate 模块强制）。
- 非 Orrery 预设的会话**保证**不含 doctrine section。

## 测试

- 单元测试：`test/` 覆盖 section 注册与排序、persona 渲染。
- 集成测试：各场景的系统提示词均含 persona 与 doctrine（deepwork/delegate 等场景断言间接受益）。
