# 分类委派（category-delegation）

> 专业的事交给专业的模型：主 agent 用 `delegate` 把任务派给绑定合适模型链与专属提示词的子代理。

## 概述

`delegate` 是 Orchestrator 的执行手臂。任务类别（category）各自绑定一条按优先级排序的模型链和一份类别心智提示词；另有三个精选只读研究代理（`explore` 代码检索、`librarian` 文档/OSS 调研、`oracle` 架构咨询）。委派可单个、可批量（≤16）、可放后台；子代理不可再委派，保证拓扑可控。

## 用户可见行为

- 主 agent 调用 `delegate({ category, prompt })` 或 `delegate({ agent, prompt })`（两者必须且只能给其一），也可用 `tasks` 批量派发。
- 后台委派（`run_in_background: true`）立即返回 job 标识；完成时主 agent 只收到紧凑通知，完整报告用 `job_output` 拉取——报告全文不会自动灌进上下文。
- **受监督分组**（`group` 参数）：同一次调用内的全部任务构成一个组（**组不支持插入**——向已在场的组名再派即报错；批量派发先全量解析后 spawn，中途失败回滚已 spawn 成员并释放组名，未 seal 且全员 terminated 的组名可复用）；成员以 continuable 子代理运行，遵循二元终态契约（只可报 `STATUS: completed` 或 `STATUS: blocked`，无权判定任务存废）；**成员工具面不含 `send_message`**（spawn 时强制 deny，子→父直发通道关闭，唯一上报通道是终态契约；只读成员维持既有 allow 白名单不变且同样挂只读 bash 守卫，主 agent 自己的消息工具与 DSH 结算通知不受影响）；正常结束无终态报告会被催促续推、供应商错误按退避续推（默认 30s 翻倍、上限 5 次）；**每个成员的终态报告经 DSH 内建结算通知即时送达**（通知正文携带成员的 `STATUS/REPORT` 全文，Orrery 不再另发逐成员通知）；**组全员终态后送达恰好一条一行 group-settled 信号**（组名与成员数，不含成员正文；严格排在组内最后一条成员结算通知之后——以父会话日志观察到全员终态结算通知为准，通知缺失时 1s 兜底）；主 agent 可用 `resume_agent`（注入续推上下文恢复 blocked 子代理）、`terminate_agent`（运行中真正打断 / 非运行中仅状态簿记）裁决，以及 `supervised_status` 查看全量监督状态。
- **监督可见性**（`supervised_status` 工具，仅主 agent 可用）：逐子代理报告 id/名称/组/状态（`running`/`blocked`/`completed`/`terminated`）/续推次数/报告摘要，逐组报告成员数与 sealed/settled 状态；并对 DSH catalog 中未被协调器登记的 continuable 子代理做**孤儿检测**（标记 untracked，绝不与空注册表混淆）。
- 模型链逐档解析：首选不可用自动落到下一档；整链不可用时**显式报错**（点名类别与尝试过的档位），绝不悄悄换到别的模型族。
- `deep` 类别子代理若首行返回 `ESCALATE: deep-plus`，自动携带其发现重派到 `deep-plus` 一层，并声明发生了升级。
- 只读代理试图写/改文件会被拒绝（只读是强制的，不是建议）；其 bash 访问受**只读白名单守卫**：白名单内只读命令（`ls`、`cat`、`grep`、`find`、`jq`、`git status/log/show/diff/blame` 等）正常执行；写命令、解释器、嵌套 shell、写重定向、以及守卫无法证明只读的命令一律 **fail-closed 拒绝**（v1 不覆盖 `pwsh`，一律拒绝）。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| 类别注册表 | 内置 9 类别 | 每类别：`description`、`guidance`、`promptAppend`、有序 `chain: [{provider, model, reasoningEffort?}]`、可选 `gateModels`、`disabled` |
| 代理注册表 | `explore`/`librarian`/`oracle` | 精选只读代理定义 |
| 模型族提示词变体表 | 内置 | 按模型族选择提示词变体（Claude/Kimi 式清单风格、GPT 式原则风格、其余中性），可覆盖 |
| `readOnlyBash.enabled` | `true` | 只读 bash 守卫开关；`false` 时只读代理工具面回落到 v0.1.0（无 bash） |
| `readOnlyBash.allow` | 初版白名单 | 命令级只读白名单（basename 匹配），可迭代补全 |
| `readOnlyBash.gitAllow` | 10 个子命令 | git 只读子命令白名单（`status log show diff blame grep ls-files ls-tree rev-parse describe shortlog`） |
| `readOnlyBash.deny` | 显式 deny 列表 | 优先于 allow 的整词 deny（`rm`、`sudo`、解释器、包管理器等） |
| `supervision.maxRetries` | `5` | 受监督子代理续推连续上限（催促与供应商错误重试共用） |
| `supervision.initialBackoffMs` | `30000` | 供应商错误续推初始延迟，逐次翻倍 |
| `supervision.maxBackoffMs` | `300000` | 续推延迟封顶（5min） |

均为 volatile config，在线编辑即刻生效。

## 设计细节

- 模块：`orrery-harness/delegate`；派发走 `ctx.subagents.start`，一次调用携带 `agentOptions`（钉模型与推理档）、`persona`、`toolFilter`（只读白名单）、`maxDepth: 1`（禁止再委派）。
- 链解析规则：provider 已注册且（其 catalog 为空或包含该 model）即可解析；`reasoningEffort` 支持度经模型信息校验；适配器更新事件触发重解析。
- 后台道一律走 one-shot job（拉取语义），保证报告全文不自动入上下文。
- 类别与 `model` 同时提供会被拒绝（类别已含路由，不允许二义）。
- 多 Agent 协作全部自研，不依赖 DSH 官方 experimental Agent Team 插件。
- 只读 bash 守卫：派生只读子代理（精选代理或 `readOnly` 类别）后同 tick 内将 `tools.guard` 注册到该子代理自身作用域（`localAgent.ctx`），逐命令校验——管道/序列/命令替换逐段解析（含 `$(...)`/反引号递归）、basename 归一、git 子命令门控（`-c alias.*` 注入显式拒绝）、写重定向仅放行 `/dev/null` 与 fd 复制、heredoc/进程替换/子 shell 分组 fail-closed；守卫挂载失败则销毁子代理并报错（只读代理绝不无守卫运行）。
- 受监督分组（`src/delegate/group-coordinator.js`）：组内成员经 `startContinuable` 派发（persona 附终态契约段，工具面强制 deny `send_message`）；协调器经 `session/event` 过滤子会话的 `assistant/message`（终态解析）与 `turn/end`（分类：completed+终态→定案 / completed 无终态→催促 / error→退避计时器 sendMessage / aborted(user)→记 blocked 不自动续推 / 其余 aborted→terminated）；成员终态感知由 DSH 内建结算通知承担（即时、携带终态全文），协调器不再生成逐成员通知；**父面唯一自产通知**是组全员终态后的一行 group-settled 信号，经 `deps.notifyParent` 效应器以 timer 延迟投递、**镜像 DSH 内建结算通道（`sendWaking`）语义**——父忙→`steer` 同轮紧随注入、父闲→`followup` 唤醒；步边界准入不打断流式响应；投递受**严格有序门控**——协调器在父会话日志观察到组内全部成员的终态结算通知（`subagent-settled` 源、且到达于该成员终态之后）才放行信号，保证信号永远排在最后一条 Background 通知之后，通知缺失时 1s 兜底投递；失败记日志、有界重试 3 次、最终失败写审计 note）——此前的 outbox/busy 台账/turn-stopping 冲刷已全部退役（与 todo-driver 的边界竞争随之消除）；`resume_agent` 经 `sendMessage` 注入续推上下文并翻转 running（投递失败回退 blocked 并报错）；`terminate_agent` 运行中经 `interrupt`（ancestor 授权）真打断、非运行中仅簿记；催促/退避投递失败降级为 blocked 并审计；监督审计走冷安全通道（`src/shared/audit.js`）：每次状态迁移发出**结构化事实**——`orrery/supervision/spawn`（成员登记）、`orrery/supervision/seal`（组封口，含 memberIds）、`orrery/supervision/settle`（终态定案，含 status/report）、`orrery/supervision/resume`（续推）、`orrery/supervision/terminate`（终止，含 reason）、`orrery/supervision/group-settled`（组全员终态）、`orrery/supervision/group-released`（失败批次释放组名）。

## 边界与失败语义

- 参数二义（`category` 与 `agent` 同给或都不给）→ invalid-arguments 错误。
- 类别整链不可解析 → 显式 "category unavailable" 错误，点名类别与档位。
- 只读代理的写/编辑调用 → 拒绝并注明只读原因；精选代理调 `delegate` → 深度限制错误。
- **保证**：子代理永不可再委派（拓扑深度恒为 1）。

## 测试

- 单元测试：`test/` 覆盖参数校验、链解析（含死链报错）、变体选择、ESCALATE 重派、批量默认值；`test/robash-guard.test.js` 覆盖守卫语料（放行/拒绝/注入绕过/自定义列表）与挂载层（白名单附加、守卫注册、禁用回落、挂载失败销毁）；`test/group-coordinator.test.js` 覆盖协调器全分支（组登记/禁插入/终态解析/催促/退避/耗尽/打断分类/resume/terminate/group-settled 信号渲染/失败批次释放组名/各投递失败降级）与挂载层（组派发、两阶段解析、回滚与组名复用、只读成员守卫、延迟 followup 投递）。
- 集成测试：`delegate` 场景（父委派、子会话、结果回传）；`robash` 场景——只读子代理的受守卫 bash：放行命令执行、写命令拒绝、目标文件零损伤；`grouped` 场景——受监督分组端到端：批量派发、供应商错误成员退避续推恢复、成员正文经 DSH 内建结算通知（`subagent-settled` 源）送达父会话、一行 group-settled 信号到达、父 agent 观察到信号；`escalate` 场景（ESCALATE 重派与发现传递）；`background` 场景（后台委派：紧凑通知到达、报告全文不入父上下文、父 agent 观察到通知）；`terminate` 场景（运行中成员真打断（turn aborted）、组 settle 信号到达）；`rehydrate` 场景（两阶段重启：blocked 报告经内建结算通知送达、send_message 工具面契约、审计事实链含 resume 与 group-settled、重建后 resume_agent 复工、group-settled 信号重发）。
