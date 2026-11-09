# Decision Agent

> 为重复的产品、品味与领域判断提供有出处、可审计、可纠正的本地决策能力。

## 概述

Decision Agent 面向 Execution Agent 反复提出的同类结构化问题。一个已启用且被会话明确选择的 Agent，只有在证据、范围、当前状态、权限和答案形状都通过结构闸门时，才用原问题的选项直接回答；不能回答时交还原生提问，而不是凭印象补答案。

当前交付覆盖 P0 契约、P1 可用核心、P2 独立受限检索/L2/L3 接口、P3 手动语义整合/MemorySnapshot 生命周期，以及完整的产品化 UIUX：多个本地 Agent、独立证据命名空间、自动 Hook、显式咨询、原生升级、持久历史、轻量反馈、中性情节、候选审阅和四个逻辑管理视图。普通用户默认看到“决策助手 / 待你决定 / 判断记录 / 判断依据 / 原则版本”等任务语言，技术实体与原始 JSON 收进高级诊断。P4–P5 的 Auto Router、跨工作区共享及数据导出仍未交付；自动定时/阈值整合、自动发布和 `generatedDescription` 学习也未启用。

## 用户可见行为

### Agent 与选择器

- 管理页可创建、编辑、停用和归档 Agent。默认表单只需名称与可选的普通语言判断偏好，创建沿用当前 workspace 的默认 scope 并继承会话模型；完整 scope、授权类、模型路由和 `userDescription` 版本历史在高级设置/诊断中维护。同一工作区内名称大小写不敏感唯一。
- `generatedDescription` 在当前 P0–P3 恒为 `{revision: 0, text: ''}`，只读且没有生成或写入入口；它为空不妨碍决策。P3 只把用户裁决、有效纠正和已赞回答整合为可审阅原则，不生成画像。
- 会话输入框右侧使用紧凑触发器与专用选择面板，不再是原生下拉框。面板只有 `Off` 和当前工作区已启用的具体 Agent，选择即保存并关闭，没有 `Auto` 或额外确认。新会话默认 `Off`，选择按根会话持久化，子会话解析到同一根会话；读取中不会伪装成 `Off`，保存失败保留先前有效选择。
- 总开关 `decisionAgentsEnabled` 默认关闭。全局关闭或会话 `Off` 时，Hook 不拦截、咨询明确失败，不创建 Case、路由样本或数据库文件。
- 钉选 Agent 不可用时，选择面板保留其名称并明确标为不可用，不静默改派或显示为正常可选；显式咨询指定其他 Agent 只影响该次调用。修订会重新校验目标 Agent 并记录新路由。

### 自动 Hook 与显式咨询

- Hook 只处理宿主原生的结构化提问，不拦截正文里的反问。回答保持原 `questionId`、顺序、选项和 `multiSelect` 形状；多题批次全有或全无，部分可答时整批交回用户，逐题结论仅作建议。
- `approval`、`plan-review`、不可逆/高风险操作和执行授权请求在语义评估前完全走原生确认，不创建 Case，也不会把其答案变成可复用证据。Decision 回答永远不是执行、合并、发布、删除或其他权限。
- `decision_consult` 支持 `answered`、`returned`、`awaiting_user`：带 `caseId` 的答案与出处、封闭原因码与修复提示，或持久用户待办。`awaiting_revision` 中只有内容实际改变的咨询才产生新 Attempt，未修订重放保持幂等。
- 新判断升级后，用户在原生问题或收件箱作出的选择成为带 scope 的权威 `user_decision`。同一 Agent、同 scope 的后续问题可直接引用该记录，不需要语义整合。裁决后的咨询凭 `caseId` 重读可取得真实用户答案与出处。

### 证据与反馈

- G1–G7 分别检查主张引用、scope/授权类、证据当前有效性、冲突、当前观测、权限和答案形状；模型自评置信度不参与放行。
- 用户裁决和已点赞的 Agent 回答会展开为“答案在前、问题在后”的有界摘录。未评分回答没有独立正向证据资格；窄路径/标签证据不能授权更宽请求。
- 文件 evidence hints 只读刷新为当次 `current_observation`，记录 hash/version/observedAt；越界、过期或无法读取时失败关闭。相同题面在同一 scope 下存在不同裁决时，引用冲突任一侧都会阻止回答。
- 界面以“认可 / 不认可”表达赞/踩。认可只验证原 scope，并在反馈事务内创建 `agent_record`；不认可无需理由，立即变为 `disputed / needsReview`，失去独立自动回答资格。只有 `validated` 显示“撤销认可”，只有 `disputed` 显示“撤销不认可”，未评分状态不显示撤销；撤销追加事实但不删除旧事件，也不会反推相反答案。
- 备注不改变状态或后续行为，纠正必须包含 `direction`、`scope`、`supersedes` 并立即成为后续 Attempt 的 User Override。两者使用独立入口与按会话/Case 隔离的草稿；纠正提交前显示范围、取代目标和“只影响之后判断”的说明，写失败保留草稿，旧回答不被回写。

### 受限检索、语义记忆与中性情节

- 每次 Attempt 先通过独立只读检索器固定上下文：Agent、workspace、scope、授权和当前资格先于排序与装配；不调用检索模型，不读取完整会话日志，也不提供跨 Agent/workspace 查询。
- 同命名空间且 scope 覆盖当前请求的未评分 `closed(answered)` 记录可成为 L3 中性情节，使用答案在前、问题在后的最多 600 字符摘录。用户裁决与已赞记录只走 L5；待处理、退回、取消、失败、disputed、已删除或曾被纠正取代的记录不进入 L3。
- L3 只是非权威上下文，不产生 Evidence Ref，不能单独满足 G1、补足 scope/冲突/新鲜度或授予权限。引用 L3 的 Case id 会被严格证据 id 校验拒绝。赞/踩/撤销在下一次检索分别迁移到 L5、排除或恢复中性 L3；评论正文不进入 L3。
- P3 的 L2 只读取当前 Agent 已发布且未回滚的 Snapshot；没有当前版本时 `memorySnapshotId` 为 `null`，draft 与 rolled_back 不参与新 Attempt。只有 scope 匹配且全部来源都能展开为本次合格 L5 的 active 原则才进入 L2；来源失效时整条省略并记录原因。
- L2 是经用户审阅的非权威语义记忆，不产生新的 Evidence Ref，也不能独立满足 G1、扩大 scope、消除冲突、替代新鲜复核或授予权限。模型只能引用实际 L5 evidence id。
- 预算不足依次整条裁减 L3、L2，再执行既有 L5 裁剪；保留的 L2 来源不得被 L5 裁剪遗落。Attempt pins/manifest 记录 Snapshot id/revision/hash、实际原则与 L5 映射、层大小和省略项，上下文 hash 覆盖实际 L2/L3 内容，旧 Attempt 不回写。

### 管理页与恢复

- 左侧栏使用专用图标进入管理页，默认显示“待你决定”；主导航只有待你决定、判断记录、助手管理，指标位于高级区域。待办直接提供单选/多选/文本回答、建议填入和次级恢复动作；记录以题面摘要、助手、状态和时间的可读列表呈现，桌面双栏、窄屏钻进详情，分页追加并去重。
- 决策记录仍支持 Agent、Case 状态、Attempt 结局、返回原因、scope、反馈状态六维过滤；详情只读拼装 Case/Attempts/Evidence/Feedback 和 RouteDecision。默认只显示当前 Attempt 的证据，历史 Attempt 各自分组；Snapshot pin、L2/L3/L5、层大小、省略项和原始 JSON 仅在高级诊断展示，旧 P1/P2 manifest 与 pinned-empty 不伪造命中。
- 会话卡与收件箱以真实问题、答案、理由和当前依据为中心，每个区域至多一个主操作。Hook 原生提问保持唯一主回答面，卡片不复制第二套表单；无原生回答面的显式咨询复用同一回答组件。赞、踩、撤销、备注、纠正、裁决、改派、取消和重试都经既有 Host 远端动作写入权威库并校验根会话/workspace，写后重读，重复点击受 pending guard 约束。
- Agent 详情把学习治理收敛为“整理新原则 → 审阅变化/来源/结构校验 → 采用或放弃”，当前版本可明确恢复前序版本。只有匹配的候选 Run、Snapshot、父版本（存在时）、diff 和最新 revision 全部加载后才允许写入；候选摘要、加载失败或过期详情不能触发生命周期操作。跨根来源以授权的有界摘录就地展示，只有当前根 record reader 确认可读才导航；当前 Snapshot 超出最近 20 条摘要仍保留真实 revision 和恢复入口。
- 运行层失败在预算内重试，耗尽后进入可恢复待办。显式 retry/reassign 每次只授权一个新 Attempt，并重新校验 Agent；重复传输不新增 Attempt。重启保留等待状态和选择器，未完成 Attempt 标为 `interrupted`，不会变成答案。

## 配置

全部位于「设置 → Weir → 决策 Agent」。除存储目录外均调用时读取；`decisionAgentStorePath` 标为需重启。

| 键 | 默认值 | 说明 |
|---|---|---|
| `decisionAgentsEnabled` | `false` | 总开关；关闭等价于所有会话 `Off` |
| `decisionAgentSelectorDefault` | `'off'` | 仅允许 `off\|auto`；默认 Off。`auto` 的 fresh-root 初始化由后续选择器任务接入，非法存储值按 Off；当前不改变既有/恢复会话的 Off 行为 |
| `decisionAgentAutoShadow` | `false` | Shadow 诊断的保守开关；仅布尔 `true` 启用。执行接入属于后续 P4 任务，当前默认且不采样 |
| `decisionAgentAutoAnswerClasses` | `'[]'` | Active Auto 的 A/B/C JSON 白名单；保存时校验、有效值去重，非法存储值运行时归为空。默认空且 Active Auto 尚未接入 |
| `decisionAgentAnswerTimeoutMs` | `60000` | 单次 Attempt 硬超时 |
| `decisionAgentMaxAttemptsPerCase` | `3` | 自动评估、修订与重试的默认合计上限；用户显式恢复每次只追加一次 |
| `decisionAgentContextBudgetTokens` | `24000` | 当前 Case 与证据包的有界预算 |
| `decisionAgentMaxOutputTokens` | `1600` | 评估器输出上限 |
| `decisionAgentMaxConcurrentAttempts` | `4` | 并发评估上限；超限 Hook 直接走原生提问 |
| `decisionAgentChains` | `''` | 按 Agent id 配置有序模型链；空链继承会话路由，显式不可用路由不静默换模型 |
| `decisionAgentRetentionDays` | `0` | 仅启动时清理无裁决/反馈的旧关闭记录；0 表示永久保留 |
| `decisionAgentStorePath` | `''` | 绝对路径覆盖目录；留空使用 profile 私有存储 |

上述三个 Auto 键只是本轮交付的保守配置、页面镜像与失败关闭解析，不宣称选择器 Auto、Shadow 或 Active Auto 已可用。不存在整合计划、跨工作区共享或自动画像学习设置键。

## 设计细节

`Decision Broker` 是 Case 状态、路由、证据闸门、升级、持久化、审计、用户动作与投递的唯一权威。Decision Agent 是耐久 Profile、独立命名空间、模型路由和无状态 per-Attempt 评估器，不是长驻聊天会话。

- 权威存储使用 `node:sqlite`、WAL、`BEGIN IMMEDIATE`、串行写与迁移备份。默认路径为 `<profileContext.home>/weir/profiles/<profileContext.name>/decisions/decision.db`；更高数据库或记录 schema 版本明确拒绝且不改写。
- 用户裁决与 `user_decision` Evidence Ref 同事务写入；点赞与 `agent_record` 同反馈事务写入。并发首次送达在事务内重读幂等键，返回已提交 Case。
- `DecisionContextRetriever` 是 Broker 内部同步只读接缝，返回深冻结的 L2/L3/L5、裁剪前完整冲突对与当前观测 hash。L3 是现有 Case 的可重建投影，不新增权威表或数据库迁移。
- P3 的 `DecisionLearning` 复用 schema v1 的 `learning_runs`/`memory_snapshots` 表，无迁移或回填。Learning Run 在模型前持久冻结输入并防止重复/并发运行；候选操作严格限于 add/refine/merge/narrow/retire，结构重放只验证目标、来源、scope、冲突与最终 hash，不冒充回答质量分数。
- Snapshot 保存完整不可变原则内容和来源 lineage，状态修订只能经显式发布、拒绝或回滚。发布重查父版本与来源当前资格；回滚恢复最高版本的合格前序 published，无前序则 L2 为空，不回写历史。
- 整合器使用独立英文 `consolidation-contract/1`，评估器使用 `evaluator-contract/3`；二者均为无状态、无工具的受限调用，省略 `temperature`，模型调用不进入 SQLite 写事务。
- 评估器直接调用 `ctx.llm.stream`，使用严格文本 JSON、有限上下文包和 G1–G7；不使用工具、会话历史或自评置信度。所有路由都省略显式 `temperature`，沿用 DSH 与供应商的兼容默认值，避免固定采样参数模型被拒绝。意外异常持久化为通用失败 Attempt，不泄漏异常正文。
- 浏览器只通过 `/api` 的 `weirDecision/<method>` 读写；P3 新增 learningStart/learningRun/snapshotPublish/snapshotReject/snapshotRollback/memorySnapshot 六个 bare-args 方法。产品化竞态修复另增加只读、可取消的 `waitForToolCall`，仅在最终咨询状态已持久化后按根会话与调用身份唤醒一次，再由 Client 权威重读；不携带题面或证据正文。全局关闭时只允许 `overview` 只读降级以解释状态，其余远程方法仍失败关闭。所有 Case/Profile/学习/Snapshot 动作都解析调用方根会话/workspace 并检查目标归属；越界拒绝写审计。审计镜像不含原则、评论、题面或证据正文。
- Client 由包内共享视觉组件、纯投影模型和选择器/页面/会话卡/学习 chunk 组成，所有 chunk 在组合根并行加载。界面使用宿主主题 token、locale 和响应式/键盘/读屏契约；诊断与指标按需读取，迟到响应不会覆盖新会话或筛选。决策卡仍是权威记录的只读投影，不写自定义 Session 事件、不使用 `session.append` 或 `commands.execute`，不靠定时轮询刷新。审计镜像尽力而为，不含题面、证据正文或用户画像正文。

## 边界与失败语义

- 前提不成立、缺上下文、超范围、证据冲突、证据过期和选项不支持分别使用 `INVALID_PREMISE`、`MISSING_CONTEXT`、`OUT_OF_SCOPE`、`CONFLICTING_EVIDENCE`、`STALE_EVIDENCE`、`UNSUPPORTED_OPTIONS`，并附可执行修复提示。
- `return` 不冒充用户答案；`escalate` 先落持久待办再交还原生问题。`awaiting_revision` 在回合结束仍未修订时关闭为 `closed(returned)`。
- 修订/重试产生新 Attempt，旧 Attempt 和已关闭答案不可改写。显式恢复每次只增加一次 Attempt，不会借同一幂等键复活取消终局。
- 语义反义不由文本猜测：G4 只把同 scope、同题面但不同选择的源记录视为结构冲突。
- P3 只交付手动语义整合、候选审阅与 Snapshot 发布/拒绝/回滚，以及受 L5 来源约束的非权威 L2。自动定时/阈值整合、自动发布、`generatedDescription` 学习、Auto Router、跨 workspace 共享和用户导出仍未交付；L3 同样不具有独立授权能力。

### 已观察但独立后续处理的 UX 输入

- `returned(MISSING_CONTEXT)` 仍按既有 `awaiting_revision → closed(returned)` 语义运行；用户介入与通知路径需要单独设计，本 P3 不变更状态机。
- 曾观察到合法 `options` 的原生问题显示为填空；尚需复现并区分 Host 请求形状与 Client 渲染根因，本 P3 未作猜测性修复。

## 测试

- 单元与契约测试：`plugins/weir-harness/test/decision/` 覆盖既有状态机/迁移/检索/反馈/G1–G7/Client、P3 严格 LearningRun/Snapshot reader、冻结输入、并发幂等、结构 replay、来源发布栅栏和真实 pins/manifest/hash，同时覆盖普通语言投影、专用选择面板、共享回答控件、当前证据、按 Case 草稿、筛选/分页竞态、候选 readiness、真实无候选结局和跨根来源。本轮新增版本化 Router 枚举、不可变 `auto`/`auto_shadow` RouteDecision 与 Broker 保守配置解析契约；当前完整 Decision 套件 **327/327**；Weir 全包 **3431 PASS / 0 FAIL / 1 既有平台跳过**（共 3432 项）的历史基线保留，最终全包计数待本批结束后重算；checkJs 与 33 个 Client chunks 构建通过。
- headless 集成：`decision-hook`、`decision-consult`、`decision-batch`、`decision-route`、`decision-recovery`、`decision-feedback`、`decision-isolation`、`decision-ui-remote`、`decision-memory` 与 `decision-learning`，最终完整矩阵 **923/923**。learning 场景以 31 个真实进程阶段（含一次 exact-PID SIGKILL）检查生命周期、DB/wire、对抗输入、恢复、预算、历史不可变和 P1/P2/schema-v1 兼容。
- 真实隔离 Desktop GUI：保留既有 A/B/C 与 P2 memory 验收；P3 主生命周期 run `8wkaN8` **18/18**，整改 run `Tc4Mks` **10/10**，覆盖手动整合、候选 diff/来源/结构重放、发布、只读 Attempt L2、回滚/拒绝、重启、>20 历史、correction/cross-root 来源及 exact-PID/端口清理。测试只启动独立临时 profile/进程，不操作用户当前 App 或其存储。
- 产品化 UX 的真实隔离 Desktop 最新验收 run `bPxzdF` **72/72 PASS**：54 张真实截图、526 条原始网络 RPC、94 条权威直读，覆盖完整生命周期、360/768/1440 CSS px、明暗主题、真实 200% 缩放、96 组键盘交互与六组持久化 Accessibility 证据；held `decision_consult` 卡已验证只有一个紧随卡头的回答表单，没有重复 `.weir-da-record-answers` 或 `.weir-da-suggestion-review` 内容，次级证据/历史/恢复/反馈/诊断均位于表单下方。三个隔离实例均完成 exact-PID/端口清理，运行异常、console error、Slot crash 与加载失败均为零，Attempt/Snapshot 历史内容对照无改写。
- 既有五项关键安全逻辑均有真实 mutation-red、字节恢复和 GREEN 证据。产品化 UX 的独立审查另行发现并修复了重复可写咨询卡、已有当前版本时的无变化误报、筛选/分页状态混用、文案降级和冲突重读问题；代码/组合独立审查已通过，真实 Desktop 证据与当前 App 部署验收分别记录，不以组件测试或 Slot 接线状态替代。
