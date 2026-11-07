# Orchestrator 总指挥（orchestrator-persona）

> 助手以"总指挥"身份统筹工作：判断主循环执行还是委派、选择拓扑、按证据验收、汇报结果。

## 概述

Weir 会话的主 agent 不是泛泛的聊天助手，而是用户的单一协作入口——Orchestrator。它的身份与协作纪律写进系统提示词：什么活自己直接干、什么活派出去、派给谁、怎么等、怎么验收。这一特性是所有其他特性的"人格底座"。

## 用户可见行为

- 会话中助手表现为统筹者：先规划（todo 清单），再执行；共享判断、数据或上下文的紧耦合工作默认留在主循环（DIRECT），与任务规模、文件数或工具数无关。
- 只有存在具体收益时才委派：真正独立且上下文可丢弃的并行工作、用全新上下文容纳展开、工具/权限/指令隔离，或独立黑盒验证。FAN-OUT 必须具备真实的独立并行收益；写范围不相交只是并发写入的安全前提，不是委派或 fan-out 的充分理由。
- 等待子任务时会让出回合（不空转），子任务完成通知到来再继续。
- 不会因为"子代理说做完了"就勾掉 todo——它要看到证据或亲自验证。
- 系统提示词自带一份**委托目标指引**：`delegate` 的正确用法（每条目必须且只能给 `category` 或 `agent` 之一；类别道**没有默认值**，必须点名类别）与**当前启用**的类别清单（名称、描述、路由指引）和精选 agent 清单——模型在首次调用前就掌握规则，不必先失败一次再从报错里学。

## 配置

本特性无配置项。

## 设计细节

- 模块：`weir-harness/core` + 预设 persona 行。
- 系统提示词三段：persona 前缀（Orchestrator 身份，英文模板）+ 专属 section `orchestrator:doctrine`（order 600，位于 persona 之后、工具清单之前）+ 委托目标指引 section `orchestrator:delegate-targets`（order = doctrine + 10，紧随 doctrine）。三个都在 `weir` 预设内注册，其它预设不含。
- doctrine 的路由判据：`Start with DIRECT`；DIRECT 覆盖任意规模的紧耦合工作，SINGLE 只承接已有具体委派收益的单一有界任务，FAN-OUT 只承接并行执行本身有收益且子代上下文可丢弃的独立部分，PIPELINE 仍要求读取并验证每个前置结果后再派发后继。`disjoint write scopes` 在委派收益成立之后作为并发写入安全检查，不能反向证明应该委派。
- doctrine 保留的协作纪律：普通前台批量真实并发、按输入有序返回逐项结果、单项失败不取消兄弟项；等待时结束回合并由结算通知唤醒；证据绑定验收（子任务欠证据不勾 todo）；子任务提示词契约（TASK/DELIVERABLE/SCOPE/VERIFY/STOP WHEN）；拉取式后台纪律；continuable 模式选择；todo 与上下文压力纪律；优先使用 `hash_edit`；监督信号意识（成员终态 `STATUS/REPORT`、group-settled 信号，以及 blocked 成员的 `resume_agent`/`terminate_agent` 裁决）。
- 委托目标指引由 **delegate 插件**注册（类别注册表与设置覆盖层都在它手里，core 无需新增跨插件服务）：section 文本是静态英文模板，内嵌变量 `{{weir_delegate_targets}}`，由 DSH 在**每次提示词装配**时调用 provider 求值——因此设置提交在同一进程内即刻改变模型看到的目标集合，无需重启或重建会话。清单渲染下沉到纯模块 `src/delegate/targets.js`（启用过滤、注册表顺序、空集合兜底）。主 agent 渲染原文；delegated child 的 provider 返回空串，目标指引与 doctrine 都不进入子代系统提示词。
- 语言纪律：persona 与 doctrine 一律英文模板；会话实例内容跟随用户语言。

## 边界与失败语义

- doctrine 是英文提示词行为指导，不是运行时“是否允许委派”的硬门；硬保证由对应模块提供（如只读代理的写拒绝由 delegate 模块强制）。mock 集成场景只证明提示词内容、真实装配与子代抑制，不构成真实模型质量或成本改善的 benchmark。
- 非 Weir 预设的会话**保证**不含 doctrine section。
- 指引小节只列**启用**目标；某个集合全停用时输出兜底文案（provider 恒返回字符串——DSH 对未注册变量与未定义引用在装配期是响亮失败）。

## 测试

- 单元测试：`test/core.test.js` 经公共 `DOCTRINE` seam 钉住主循环优先、四类具体收益、FAN-OUT 的独立并行收益、PIPELINE 前置验证和 disjoint-scope 安全定位，同时证明旧的 trivial-only DIRECT 与默认 fan-out 文案消失；section 注册、排序和 delegated-child 空渲染断言保持不变。
- 单元测试补充：`test/targets.test.js` 覆盖启用过滤、注册表顺序、空集合与全停用兜底、模板只引用已注册变量，并经真实 `DEFAULT_CATEGORIES.quick` 验证目标清单不再推销“每个可拆片都 fan out”。
- 集成测试：`child-prompt` 断言父请求仍可见 doctrine 与目标指引，子代首请求仍无 `Orchestration Doctrine`/`Delegation targets`/`Worktree lanes`；`delegate` 断言 quick 只在委派收益成立之后适用。
- 生产预设与并发联合回归：`preset-delegation-surface` 在 `weir`/`weir-creative` 的真实请求中检查新判据及既有并发/部分失败提示；`delegate-parallel` 用两个真实子会话的因果握手证明已选择的普通前台 fan-out 确实并发。
