# Decision Agent

> 为重复的产品、品味与领域判断提供有出处、可审计、可纠正的本地决策能力。

## 概述

Decision Agent 面向 Execution Agent 反复提出的同类结构化问题。一个已启用且被会话明确选择的 Agent，只有在证据、范围、当前状态、权限和答案形状都通过结构闸门时，才用原问题的选项直接回答；不能回答时交还原生提问，而不是凭印象补答案。

本批交付 P0 契约、P1 可用核心与 P2 独立受限检索/L2/L3 只读接口：多个本地 Agent、独立证据命名空间、自动 Hook、显式咨询、原生升级、持久历史、轻量反馈、中性情节和四个管理视图。L2 仍是空适配器；P3–P5 的语义整合与画像学习、Auto Router、跨工作区共享及数据导出均未交付。

## 用户可见行为

### Agent 与选择器

- 管理页可创建、编辑、停用和归档 Agent。每个 Agent 有自己的名称、scope、授权类、模型路由和 `userDescription` 版本历史；同一工作区内名称大小写不敏感唯一。
- `generatedDescription` 在当前 P0–P2 恒为 `{revision: 0, text: ''}`，只读且没有生成或写入入口；它为空不妨碍决策，P2 也不读取 Memory Snapshot。
- 会话输入框右侧的选择器只有 `Off` 和当前工作区已启用的具体 Agent，没有 `Auto`。新会话默认 `Off`，选择按根会话持久化，子会话解析到同一根会话。
- 总开关 `decisionAgentsEnabled` 默认关闭。全局关闭或会话 `Off` 时，Hook 不拦截、咨询明确失败，不创建 Case、路由样本或数据库文件。
- 钉选 Agent 不可用时不会静默改派；显式咨询指定其他 Agent 只影响该次调用。修订会重新校验目标 Agent 并记录新路由。

### 自动 Hook 与显式咨询

- Hook 只处理宿主原生的结构化提问，不拦截正文里的反问。回答保持原 `questionId`、顺序、选项和 `multiSelect` 形状；多题批次全有或全无，部分可答时整批交回用户，逐题结论仅作建议。
- `approval`、`plan-review`、不可逆/高风险操作和执行授权请求在语义评估前完全走原生确认，不创建 Case，也不会把其答案变成可复用证据。Decision 回答永远不是执行、合并、发布、删除或其他权限。
- `decision_consult` 支持 `answered`、`returned`、`awaiting_user`：带 `caseId` 的答案与出处、封闭原因码与修复提示，或持久用户待办。`awaiting_revision` 中只有内容实际改变的咨询才产生新 Attempt，未修订重放保持幂等。
- 新判断升级后，用户在原生问题或收件箱作出的选择成为带 scope 的权威 `user_decision`。同一 Agent、同 scope 的后续问题可直接引用该记录，不需要语义整合。裁决后的咨询凭 `caseId` 重读可取得真实用户答案与出处。

### 证据与反馈

- G1–G7 分别检查主张引用、scope/授权类、证据当前有效性、冲突、当前观测、权限和答案形状；模型自评置信度不参与放行。
- 用户裁决和已点赞的 Agent 回答会展开为“答案在前、问题在后”的有界摘录。未评分回答没有独立正向证据资格；窄路径/标签证据不能授权更宽请求。
- 文件 evidence hints 只读刷新为当次 `current_observation`，记录 hash/version/observedAt；越界、过期或无法读取时失败关闭。相同题面在同一 scope 下存在不同裁决时，引用冲突任一侧都会阻止回答。
- 点赞只验证原 scope，并在反馈事务内创建 `agent_record`。点踩无需理由，立即变为 `disputed / needsReview`，失去独立自动回答资格；撤销追加事实但不删除旧事件。不会从点踩反推相反答案。
- 评论不改变状态或后续行为。纠正必须包含 `direction`、`scope`、`supersedes`，立即成为后续 Attempt 的 User Override；目标必须属于同一 Agent/workspace，旧回答不被回写。

### 受限检索与中性记忆

- 每次 Attempt 先通过独立只读检索器固定上下文：Agent、workspace、scope、授权和当前资格先于排序与装配；不调用检索模型，不读取完整会话日志，也不提供跨 Agent/workspace 查询。
- 同命名空间且 scope 覆盖当前请求的未评分 `closed(answered)` 记录可成为 L3 中性情节，使用答案在前、问题在后的最多 600 字符摘录。用户裁决与已赞记录只走 L5；待处理、退回、取消、失败、disputed、已删除或曾被纠正取代的记录不进入 L3。
- L3 只是非权威上下文，不产生 Evidence Ref，不能单独满足 G1、补足 scope/冲突/新鲜度或授予权限。引用 L3 的 Case id 会被严格证据 id 校验拒绝。赞/踩/撤销在下一次检索分别迁移到 L5、排除或恢复中性 L3；评论正文不进入 L3。
- L2 在 P2 是版本化空适配器，`memorySnapshotId` 始终为 `null`，Snapshot/Learning Run 不被读取或写入。
- 预算不足先整条裁减 L3，再执行既有 L5 裁剪。Attempt manifest 记录实际发送的 L3 源 Case、层大小与省略码；上下文 hash 覆盖实际 L2/L3 内容，旧 Attempt 不回写。

### 管理页与恢复

- 左侧栏管理页只有四个可用视图：Agent 档案、决策记录、待办收件箱、指标。没有记忆发布、语义整合或自动路由按钮。
- 决策记录支持 Agent、Case 状态、Attempt 结局、返回原因、scope、反馈状态六维过滤；详情只读拼装 Case、Attempts、Evidence、Feedback 和 RouteDecision。`awaiting_revision` 也能按返回原因找到。每条 Attempt 的 Context Pack 折叠区显示真实 L2 空状态、L3 非权威来源、层大小与省略项；旧 P1 manifest 显示真实空状态。
- 会话卡与收件箱显示 Agent、状态、真实 claim/原因、证据与出处、记录版本、暂定建议和逐题结论。赞、踩、撤销、评论、纠正、裁决、改派、取消和重试都经 Host 远端动作写入权威库，并校验调用方根会话与 workspace。
- 运行层失败在预算内重试，耗尽后进入可恢复待办。显式 retry/reassign 每次只授权一个新 Attempt，并重新校验 Agent；重复传输不新增 Attempt。重启保留等待状态和选择器，未完成 Attempt 标为 `interrupted`，不会变成答案。

## 配置

全部位于「设置 → Weir → 决策 Agent」。除存储目录外均调用时读取；`decisionAgentStorePath` 标为需重启。

| 键 | 默认值 | 说明 |
|---|---|---|
| `decisionAgentsEnabled` | `false` | 总开关；关闭等价于所有会话 `Off` |
| `decisionAgentAnswerTimeoutMs` | `60000` | 单次 Attempt 硬超时 |
| `decisionAgentMaxAttemptsPerCase` | `3` | 自动评估、修订与重试的默认合计上限；用户显式恢复每次只追加一次 |
| `decisionAgentContextBudgetTokens` | `24000` | 当前 Case 与证据包的有界预算 |
| `decisionAgentMaxOutputTokens` | `1600` | 评估器输出上限 |
| `decisionAgentMaxConcurrentAttempts` | `4` | 并发评估上限；超限 Hook 直接走原生提问 |
| `decisionAgentChains` | `''` | 按 Agent id 配置有序模型链；空链继承会话路由，显式不可用路由不静默换模型 |
| `decisionAgentRetentionDays` | `0` | 仅启动时清理无裁决/反馈的旧关闭记录；0 表示永久保留 |
| `decisionAgentStorePath` | `''` | 绝对路径覆盖目录；留空使用 profile 私有存储 |

不存在 Auto/AutoShadow、整合计划、跨工作区共享或自动画像学习设置键。

## 设计细节

`Decision Broker` 是 Case 状态、路由、证据闸门、升级、持久化、审计、用户动作与投递的唯一权威。Decision Agent 是耐久 Profile、独立命名空间、模型路由和无状态 per-Attempt 评估器，不是长驻聊天会话。

- 权威存储使用 `node:sqlite`、WAL、`BEGIN IMMEDIATE`、串行写与迁移备份。默认路径为 `<profileContext.home>/weir/profiles/<profileContext.name>/decisions/decision.db`；更高数据库或记录 schema 版本明确拒绝且不改写。
- 用户裁决与 `user_decision` Evidence Ref 同事务写入；点赞与 `agent_record` 同反馈事务写入。并发首次送达在事务内重读幂等键，返回已提交 Case。
- `DecisionContextRetriever` 是 Broker 内部同步只读接缝，返回深冻结的 L2/L3/L5、裁剪前完整冲突对与当前观测 hash。L3 是现有 Case 的可重建投影，不新增权威表或数据库迁移。
- 评估器直接调用 `ctx.llm.stream`，使用严格文本 JSON、有限上下文包和 G1–G7；不使用工具、会话历史或自评置信度。所有路由都省略显式 `temperature`，沿用 DSH 与供应商的兼容默认值，避免固定采样参数模型被拒绝。意外异常持久化为通用失败 Attempt，不泄漏异常正文。
- 浏览器只通过 `/api` 的 `weirDecision/<method>` 读写。所有 Case/Profile 动作都解析调用方根会话/workspace 并检查目标归属；越界拒绝写审计。
- 决策卡是权威记录的只读投影，不写自定义 Session 事件、不使用 `session.append` 或 `commands.execute`，不靠定时轮询刷新。审计镜像尽力而为，不含题面、证据正文或用户画像正文。

## 边界与失败语义

- 前提不成立、缺上下文、超范围、证据冲突、证据过期和选项不支持分别使用 `INVALID_PREMISE`、`MISSING_CONTEXT`、`OUT_OF_SCOPE`、`CONFLICTING_EVIDENCE`、`STALE_EVIDENCE`、`UNSUPPORTED_OPTIONS`，并附可执行修复提示。
- `return` 不冒充用户答案；`escalate` 先落持久待办再交还原生问题。`awaiting_revision` 在回合结束仍未修订时关闭为 `closed(returned)`。
- 修订/重试产生新 Attempt，旧 Attempt 和已关闭答案不可改写。显式恢复每次只增加一次 Attempt，不会借同一幂等键复活取消终局。
- 语义反义不由文本猜测：G4 只把同 scope、同题面但不同选择的源记录视为结构冲突。
- P2 没有 Auto Router、语义整合、Snapshot 读取/发布/回滚、自动 `generatedDescription`、跨 workspace 共享或用户导出能力。L2 为空，L3 中性情节不具有独立授权能力；预留表与版本字段不伪装为已交付功能。

### 已观察但独立后续处理的 UX 输入

- `returned(MISSING_CONTEXT)` 仍按既有 `awaiting_revision → closed(returned)` 语义运行；用户介入与通知路径需要单独设计，本 P2 不变更状态机。
- 曾观察到合法 `options` 的原生问题显示为填空；尚需复现并区分 Host 请求形状与 Client 渲染根因，本 P2 未作猜测性修复。

## 测试

- 单元与契约测试：`plugins/weir-harness/test/decision/`，覆盖状态机、迁移、并发幂等、记录版本、独立检索、L2 空适配器、L3 资格/非授权引用、反馈层级迁移、L3 优先裁剪、manifest/hash、证据展开与隔离、G1–G7、咨询修订/重读、耗尽恢复、异常恢复、远端授权、Client Context Pack，以及 Kimi/DeepSeek 路由均不发送显式 `temperature` 的回归。当前完整 Decision 套件 196/196。
- headless 集成：`decision-hook`、`decision-consult`、`decision-batch`、`decision-route`、`decision-recovery`、`decision-feedback`、`decision-isolation`、`decision-ui-remote` 与 `decision-memory`，合计 53/53；memory 场景以五个真实进程检查 DB/wire 一致性、重启、检索失败恢复和实际预算省略。
- 真实隔离 Desktop GUI：既有 A 16/16、B 28/28、C 28/28；本 P2 新增 memory 21/21，验证真实 L3 引用拒绝、只读 Context Pack、原生用户裁决、重启后来源一致和 exact-PID 清理。测试只启动独立临时 profile/进程，不操作用户当前 App 或其存储。
