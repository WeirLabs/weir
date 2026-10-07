# Orchestrator 总指挥（orchestrator-persona）

> 助手以"总指挥"身份统筹工作：拆任务、派子代理、决定并行还是等待、按证据验收、汇报结果。

## 概述

Weir 会话的主 agent 不是泛泛的聊天助手，而是用户的单一协作入口——Orchestrator。它的身份与协作纪律写进系统提示词：什么活自己直接干、什么活派出去、派给谁、怎么等、怎么验收。这一特性是所有其他特性的"人格底座"。

## 用户可见行为

- 会话中助手表现为统筹者：先规划（todo 清单），再执行，复杂任务主动委派并跟进到底。
- 面对多件事时默认并行派发（写范围不重叠时），而不是一件件排队。
- 等待子任务时会让出回合（不空转），子任务完成通知到来再继续。
- 不会因为"子代理说做完了"就勾掉 todo——它要看到证据或亲自验证。
- 系统提示词自带一份**委托目标指引**：`delegate` 的正确用法（每条目必须且只能给 `category` 或 `agent` 之一；类别道**没有默认值**，必须点名类别）与**当前启用**的类别清单（名称、描述、路由指引）和精选 agent 清单——模型在首次调用前就掌握规则，不必先失败一次再从报错里学。

## 配置

本特性无配置项。

## 设计细节

- 模块：`weir-harness/core` + 预设 persona 行。
- 系统提示词三段：persona 前缀（Orchestrator 身份，英文模板）+ 专属 section `orchestrator:doctrine`（order 600，位于 persona 之后、工具清单之前）+ 委托目标指引 section `orchestrator:delegate-targets`（order = doctrine + 10，紧随 doctrine）。三个都在 `weir` 预设内注册，其它预设不含。
- doctrine 要点：委派拓扑决策（直接做 / 单子代理 / 并行 fan-out / 串行流水线）、默认并行且写范围不相交、等待纪律（等待时结束回合，结算通知唤醒）、证据绑定验收（子任务欠证据不勾 todo）、子任务提示词契约（TASK/DELIVERABLE/SCOPE/VERIFY/STOP WHEN）、拉取式后台纪律、todo 纪律、上下文压力纪律、优先使用 `hash_edit`、监督信号意识（每个受监督成员的结算通知携带其终态 `STATUS/REPORT`；一行 group-settled 信号标记组完成；blocked 成员用 `resume_agent`/`terminate_agent` 裁决，监督全貌查 `supervised_status`）。
- 委托目标指引由 **delegate 插件**注册（类别注册表与设置覆盖层都在它手里，core 无需新增跨插件服务）：section 文本是静态英文模板，内嵌变量 `{{weir_delegate_targets}}`，由 DSH 在**每次提示词装配**时调用 provider 求值——因此设置提交在同一进程内即刻改变模型看到的目标集合，无需重启或重建会话。清单渲染下沉到纯模块 `src/delegate/targets.js`（启用过滤、注册表顺序、空集合兜底）。作用域是 preset，因此子 agent 同样可见（与 doctrine 现状一致）。
- 语言纪律：persona 与 doctrine 一律英文模板；会话实例内容跟随用户语言。

## 边界与失败语义

- doctrine 是行为指导而非硬约束；硬保证由对应模块提供（如只读代理的写拒绝由 delegate 模块强制）。
- 非 Weir 预设的会话**保证**不含 doctrine section。
- 指引小节只列**启用**目标；某个集合全停用时输出兜底文案（provider 恒返回字符串——DSH 对未注册变量与未定义引用在装配期是响亮失败）。

## 测试

- 单元测试：`test/` 覆盖 section 注册与排序、persona 渲染。
- 集成测试：各场景的系统提示词均含 persona 与 doctrine（deepwork/delegate 等场景断言间接受益）。
- 单元测试补充：`test/targets.test.js` 覆盖启用过滤、注册表顺序、空集合与全停用兜底、模板只引用已注册变量。
- 集成测试补充：`delegate` 场景断言父系统提示词含指引小节与启用目标名；停用场景断言被停用类别既不在小节里、也无法派发。
