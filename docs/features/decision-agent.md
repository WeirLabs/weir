# Decision Agent

> 为重复的产品、品味与领域判断提供有出处、可审计、可纠正的本地决策能力。

## 概述

Decision Agent 面向 Execution Agent 反复提出的同类结构化问题。一个已启用且被会话明确选择的 Agent，只有在证据、范围、当前状态、权限和答案形状都通过结构闸门时，才用原问题的选项直接回答；不能回答时交还原生提问，而不是凭印象补答案。

当前交付覆盖 P0 契约、P1 可用核心、P2 独立受限检索/L2/L3 接口、P3 手动语义整合/MemorySnapshot 生命周期，以及完整的产品化 UIUX：多个本地 Agent、独立证据命名空间、自动 Hook、显式咨询、原生升级、持久历史、轻量反馈、中性情节、候选审阅和四个逻辑管理视图。普通用户默认看到“决策助手 / 待你决定 / 判断记录 / 判断依据 / 原则版本”等任务语言，技术实体与原始 JSON 收进高级诊断。本批新增 Broker 私有 Auto Router、两个版本化 sidecar 契约、保守设置、根会话 Off/Auto/Agent 持久化、fresh-root 默认初始化，以及 Active Auto 的咨询类别字段、Hook/consult 分类与候选编排、原子 RouteDecision/Case 提交、失败关闭待办、single-flight、固定 Agent 修订/重试和取消/flush 生命周期；另交付 pinned-only Auto Shadow、原子 `manual_reassign`、无归属用户裁决、`received + agentId=null` 重启恢复、纯派生路由复盘与只读远端，以及现有 Client 的三态选择器、高级复盘和无归属投影。P4 的 headless 与真实隔离 Desktop 端到端验收仍未交付。P5 跨工作区共享及数据导出也未交付。自动定时/阈值整合、自动发布和 `generatedDescription` 学习同样未启用。

## 用户可见行为

### Agent 与选择器

- 管理页可创建、编辑、停用和归档 Agent。默认表单只需名称与可选的普通语言判断偏好，创建沿用当前 workspace 的默认 scope 并继承会话模型；完整 scope、授权类、模型路由和 `userDescription` 版本历史在高级设置/诊断中维护。同一工作区内名称大小写不敏感唯一。
- `generatedDescription` 在当前 P0–P3 恒为 `{revision: 0, text: ''}`，只读且没有生成或写入入口；它为空不妨碍决策。P3 只把用户裁决、有效纠正和已赞回答整合为可审阅原则，不生成画像。
- 会话输入框右侧使用紧凑触发器与专用选择面板，不再是原生下拉框。面板提供 `Off`、独立的 `Auto` 和当前工作区已启用的具体 Agent，选择即保存并关闭，没有额外确认；三态按根会话持久化，子会话解析到同一根会话。Auto 选项根据只读 `overview.auto` 显示实际清理后的 A/B/C 白名单与 Shadow 开关；白名单为空时明确说明新 Auto 请求不会自动回答，状态缺失时不假定就绪。读取中不会伪装成 `Off`，保存失败保留先前有效选择，重复提交受 pending guard 约束，成功后焦点返回已启用的触发器。
- 总开关 `decisionAgentsEnabled` 默认关闭。全局关闭或会话 `Off` 时，Hook 不拦截、咨询明确失败，不创建 Case、路由样本或数据库文件。
- 钉选 Agent 不可用时，选择面板保留其名称并明确标为不可用，不静默改派或显示为正常可选；显式咨询指定其他 Agent 只影响该次调用。修订会重新校验目标 Agent 并记录新路由。

### 自动 Hook 与显式咨询

- Hook 只处理宿主原生的结构化提问，不拦截正文里的反问。回答保持原 `questionId`、顺序、选项和 `multiSelect` 形状；多题批次全有或全无，部分可答时整批交回用户，逐题结论仅作建议。
- `approval`、`plan-review`、不可逆/高风险操作和执行授权请求在语义评估前完全走原生确认，不创建 Case，也不会把其答案变成可复用证据。Decision 回答永远不是执行、合并、发布、删除或其他权限。
- 根选择器为 Auto 时，`decision_consult` 仍优先使用本次显式 `agent_id`；显式目标不可用会明确失败，不回退到 Auto 或钉选 Agent。Hook 的 approval/plan-review/D/E/F/高风险排除仍在建 Case 前旁路；consult 则保留建 Case 后进入 `authority` 待办的既有不对称语义。
- `decision_consult` 新增可选 `authorization_class`，只复制到该次标准化问题。Active Auto 要求每题最终都有白名单允许的 A/B/C；空白名单直接形成 `authority` 待办，不读取候选、不调用分类器/Router 或领域评估。stock Hook 缺类时只调用有界分类器，非法/unknown/D/E/F/未允许类别整批失败关闭；派生字段标为 `authorizationClassSource='auto_classifier'`，原始 Hook request 不变。
- Auto 候选只来自当前 workspace，经 enabled、scope 和类别过滤；零候选不调用模型，唯一候选确定性选择，多候选才进入受限 Router。RouteDecision、规范化 request、Case 归属与状态经 `transitionWithRoute()` 原子提交，选中目标在事务内重新校验；提交失败或目标失效不会进入领域 Attempt。无匹配、歧义、准入拒绝和分类/Router 失败分别持久化为 `no_route`、`route_ambiguous` 或 `authority` 待办，Hook 只在持久提交后交还原生 `next()`。路由提交前同键 Hook/consult 加入同一 `autoFlights` Promise，不提前发布或交还；已结算重放也不增加 RouteDecision 或 Attempt。
- `decision_consult` 支持 `answered`、`returned`、`awaiting_user`：带 `caseId` 的答案与出处、封闭原因码与修复提示，或持久用户待办。`awaiting_revision` 中只有内容实际改变的咨询才产生新 Attempt，未修订重放保持幂等。Auto 使用 `callerRevisionFingerprint`，仅剥离成对的 `auto_classifier` 派生类别与来源标记；题面、选项、context、evidence、scope 或调用方类别变化仍是真修订。未显式传 `agent_id` 的 Auto 修订和 retry 固定当前 Agent，选择器或 Router 结果变化只影响新请求。
- 新判断升级后，用户在原生问题或收件箱作出的选择成为带 scope 的权威 `user_decision`。有归属 Case 的同一 Agent、同 scope 后续问题可直接引用该记录，不需要语义整合；裁决后的咨询凭 `caseId` 重读可取得真实用户答案与出处。无归属 Auto 待办也可直接回答并如实关闭，但最终 `agentId=null`，不创建 Evidence；同一咨询重读返回真实选择与空 `evidence`，该记录不会进入任何 Agent 的后续 L3/L5 检索。

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

- 左侧栏使用专用图标进入管理页，默认显示“待你决定”；主导航只有待你决定、判断记录、助手管理，指标与路由复盘位于既有高级区域。复盘以普通语言展示 pinned/Shadow 一致或分歧、Shadow/Auto 无选择、歧义、失败、手动改派及不可比较/无基线，附真实 summary、改派方向和时间；窗口可选 `24h|7d|30d|all`，每页 20 条，加载更多追加并按 Case 去重，记录链接先经既有授权 `record` 读取。复盘没有采纳/忽略或自动晋升操作。待办直接提供单选/多选/文本回答、建议填入和次级恢复动作；记录以题面摘要、助手、状态和时间的可读列表呈现，桌面双栏、窄屏钻进详情，分页追加并去重。
- 决策记录仍支持 Agent、Case 状态、Attempt 结局、返回原因、scope、反馈状态六维过滤；详情只读拼装 Case/Attempts/Evidence/Feedback 和 RouteDecision。默认只显示当前 Attempt 的证据，历史 Attempt 各自分组；Snapshot pin、L2/L3/L5、层大小、省略项和原始 JSON 仅在高级诊断展示，旧 P1/P2 manifest 与 pinned-empty 不伪造命中。
- 会话卡与收件箱以真实问题、答案、理由和当前依据为中心，每个区域至多一个主操作。Hook 原生提问保持唯一主回答面，卡片不复制第二套表单；无原生回答面的显式咨询复用同一回答组件。赞、踩、撤销、备注、纠正、裁决、改派、取消和重试都经既有 Host 远端动作写入权威库并校验根会话/workspace，写后重读，重复点击受 pending guard 约束。`agentId=null` 的 Auto 记录显示“尚未选择助手”和真实 Auto 路由状态，保留回答、改派、取消及只读 RouteDecision 历史，但不显示 Agent 反馈、纠正或 retry；明确改派并由权威重读确认归属后，才恢复普通 owned recovery。
- Agent 详情把学习治理收敛为“整理新原则 → 审阅变化/来源/结构校验 → 采用或放弃”，当前版本可明确恢复前序版本。只有匹配的候选 Run、Snapshot、父版本（存在时）、diff 和最新 revision 全部加载后才允许写入；候选摘要、加载失败或过期详情不能触发生命周期操作。跨根来源以授权的有界摘录就地展示，只有当前根 record reader 确认可读才导航；当前 Snapshot 超出最近 20 条摘要仍保留真实 revision 和恢复入口。
- 运行层失败在预算内重试，耗尽后进入可恢复待办。显式 retry/reassign 每次只授权一个新 Attempt，并重新校验 Agent；Auto retry 不因选择器变化重新分类或路由，无归属 Case 必须先改派，不能直接 retry。重复传输不新增 Attempt。重启保留等待状态和三态选择器，未完成 Attempt 标为 `interrupted`，不会变成答案；未提交权威路由的 `received + agentId=null` intake 在打开存储时转为 `awaiting_user(interrupted)`，重放只返回该待办，不重新路由或创建 Attempt。旧版无行与恢复根会话保持 `Off`，不会因 `decisionAgentSelectorDefault=auto` 被补写为 Auto；显式 `Off` 会保留持久行，之后的默认值变化也不能覆盖它。

## 配置

全部位于「设置 → Weir → 决策 Agent」。除存储目录外均调用时读取；`decisionAgentStorePath` 标为需重启。

| 键 | 默认值 | 说明 |
|---|---|---|
| `decisionAgentsEnabled` | `false` | 总开关；关闭等价于所有会话 `Off` |
| `decisionAgentSelectorDefault` | `'off'` | 仅允许 `off\|auto`，默认 Off。只有之后真正新建的根会话在全局启用、`source=startup`、root guard 通过且尚无 selector 行时才持久化 Auto；恢复、旧版无行、startup 子会话及非法存储值均保持 Off |
| `decisionAgentAutoShadow` | `false` | 非权威 Shadow 诊断开关；仅布尔 `true` 启用。只对新建且合格的 pinned Hook/非显式咨询在真实 pinned 路由后追加至多一条 `auto_shadow`，默认关闭 |
| `decisionAgentAutoAnswerClasses` | `'[]'` | Active Auto 的 A/B/C JSON 白名单；保存时校验、有效值去重，非法存储值运行时归为空。默认空，Active Auto 对新请求直接形成 `authority` 待办且不调用分类/Router |
| `decisionAgentAnswerTimeoutMs` | `60000` | 每次 Auto 分类、Router 或领域评估 sidecar 调用的硬超时 |
| `decisionAgentMaxAttemptsPerCase` | `3` | 自动评估、修订与重试的默认合计上限；用户显式恢复每次只追加一次 |
| `decisionAgentContextBudgetTokens` | `24000` | 当前 Case 与证据包的有界预算 |
| `decisionAgentMaxOutputTokens` | `1600` | 分类、Router 与评估器的单次输出上限 |
| `decisionAgentMaxConcurrentAttempts` | `4` | 并发评估上限；Auto 从 intake 到分类/路由和后续评估持有同一许可，超限 Hook 直接走原生提问 |
| `decisionAgentChains` | `''` | 按 Agent id 配置有序模型链；空链继承会话路由，显式不可用路由不静默换模型 |
| `decisionAgentRetentionDays` | `0` | 仅启动时清理无裁决/反馈的旧关闭记录；0 表示永久保留 |
| `decisionAgentStorePath` | `''` | 绝对路径覆盖目录；留空使用 profile 私有存储 |

`decisionAgentSelectorDefault` 已接入上述 fresh-root 初始化，`decisionAgentAutoAnswerClasses` 已接入 Active Auto 准入；`decisionAgentAutoShadow` 已接入 pinned-only 非权威观察，Shadow 不读取 Active 白名单。只读 `overview.auto` 暴露实际清理后的 `{answerClasses,shadow}`，全局可用性仍由 `overview.status` 单独表达，不虚构 readiness；选择器只把该投影用于真实白名单/Shadow 说明，不把 Auto 伪装成 Agent。不存在整合计划、跨工作区共享或自动画像学习设置键。

## 设计细节

`Decision Broker` 是 Case 状态、路由、证据闸门、升级、持久化、审计、用户动作与投递的唯一权威。Decision Agent 是耐久 Profile、独立命名空间、模型路由和无状态 per-Attempt 评估器，不是长驻聊天会话。

- 权威存储使用 `node:sqlite`、WAL、`BEGIN IMMEDIATE`、串行写与迁移备份。默认路径为 `<profileContext.home>/weir/profiles/<profileContext.name>/decisions/decision.db`；更高数据库或记录 schema 版本明确拒绝且不改写。
- 有归属用户裁决与 `user_decision` Evidence Ref 同事务写入；最终 Agent 不是非空字符串时只关闭 Case 并保存真实决定，绝不写 Evidence。点赞与 `agent_record` 同反馈事务写入。并发首次送达在事务内重读幂等键，返回已提交 Case。
- `selectors` 沿用 SQLite schema v1，不新增迁移或回填。无行与未知模式读取为 Off；显式 Off/Auto/Agent 都保留行，Auto 的 `agent_id` 恒为 null。fresh-root 初始化在事务内重查“无行”再插入 Auto，已有 Off/Auto/Agent 或未知行均不被覆盖；`CURRENT_SCHEMA_VERSION` 与 `PRAGMA user_version` 均保持 1。
- 既有 `decision` 预设行监听 `agent/created`，仅在全局 enabled、default=auto、`source=startup` 且 `origin` 不是 subagent、`delegationDepth` 小于 1 时调用 Broker 初始化。监听捕获全部错误且不否决创建，初始化失败保持 Off；resume、clear、compact 与 startup child 均不写默认行。
- `DecisionContextRetriever` 是 Broker 内部同步只读接缝，返回深冻结的 L2/L3/L5、裁剪前完整冲突对与当前观测 hash。L3 是现有 Case 的可重建投影，不新增权威表或数据库迁移。
- P3 的 `DecisionLearning` 复用 schema v1 的 `learning_runs`/`memory_snapshots` 表，无迁移或回填。Learning Run 在模型前持久冻结输入并防止重复/并发运行；候选操作严格限于 add/refine/merge/narrow/retire，结构重放只验证目标、来源、scope、冲突与最终 hash，不冒充回答质量分数。
- Snapshot 保存完整不可变原则内容和来源 lineage，状态修订只能经显式发布、拒绝或回滚。发布重查父版本与来源当前资格；回滚恢复最高版本的合格前序 published，无前序则 L2 为空，不回写历史。
- 整合器使用独立英文 `consolidation-contract/1`，评估器使用 `evaluator-contract/3`；二者均为无状态、无工具的受限调用，省略 `temperature`，模型调用不进入 SQLite 写事务。
- 评估器直接调用 `ctx.llm.stream`，使用严格文本 JSON、有限上下文包和 G1–G7；不使用工具、会话历史或自评置信度。所有路由都省略显式 `temperature`，沿用 DSH 与供应商的兼容默认值，避免固定采样参数模型被拒绝。意外异常持久化为通用失败 Attempt，不泄漏异常正文。
- `src/decision/router.js` 是 Broker 私有的普通模块，不是服务、Agent 或新组合行；公开给 Broker 的四个接缝是 `autoAdmission()`、`classifyAutoRequest()`、`planAutoRoute()`、`routeAuto()`。准入逐题要求完整且已授权的 A/B/C，候选先按当前 workspace、enabled/未归档、scope paths/tags 与全部授权类确定性过滤。零候选不调用模型，唯一候选直接选择，2–32 个候选至多判决一次，超过 32 个返回 `failure:candidate_limit`，不得截断候选或创建通用兜底。
- 缺类分类使用英文 `router-classification-contract/1`：输入只有有界的当前缺失题面/选项与 consult context，不含候选 Profile；输出只能含 `contract` 和精确覆盖缺失 id 一次的 `classes[{id,authorizationClass}]`，类别限定 A/B/C/D/E/F/unknown。重复、遗漏、已提供/未知 id、额外字段、confidence、坏 JSON 与截断都失败关闭。派生值只写 Broker 规范化副本并标 `authorizationClassSource:'auto_classifier'`，不是调用方事实，也不改写原始 Hook request；D/E/F/unknown 是 authority，不是可回答分类。
- 多候选判决使用英文 `router-contract/1`：输入只有规范化 questions/context 与 eligible candidate 的 `agentId`、普通名称、当前 `userDescription.text`、scope/授权元数据；模型输出只能是 `selected{agentId,reason}`、`none{reason}` 或 `ambiguous{reason,ambiguity:{candidates,conflict}}`。字段封闭，选择/歧义 id 必须仍属 eligible，歧义候选是非空无重复子集，reason/conflict 均非空且至多 200 字符；答案、扩大 scope、未知字段或数值置信度一律 invalid。
- 两类 pack 都不读取 `generatedDescription`、L2/L3、Memory Snapshot、历史 Case/Attempt/Evidence/Feedback、改派样本或完整会话；Router 不调用领域 retriever/evaluator，也不创建 Attempt。单题文本和 context 至多 4,000 字符，userDescription 至多 2,000、候选名称至多 200，Unicode 安全截断；固定 id、授权元数据和完整 eligible 集不得裁掉，总字符超过 `decisionAgentContextBudgetTokens × 4` 即 `failure:context_budget`。调用只经 `resolveDecisionModelRoute({chain:[],sessionRoute})` 与既有 `streamDecision()`，使用 stock 会话模型路由，不传 tools/purpose/temperature，不新增定时器。失败词汇封闭为 `failure:timeout`、`failure:model_error`、`failure:invalid_output`、`failure:truncated`、`failure:aborted`、`failure:route_unavailable`、`failure:candidate_limit`、`failure:context_budget`；`none:no_candidates`、`admission:authority`、`deterministic:single_candidate` 等稳定 reason 代码供持久化/复盘，后续 UI 必须做普通语言投影，不直接展示代码。
- Active Auto 先以 `agentId=null` 幂等建立 Case，再在事务外完成分类和候选模型调用。`DecisionCases.transitionWithRoute(change,route)` 在一个 `store.write()` 内重读 Case revision/state、追加 RouteDecision 并执行 guarded UPDATE；Auto selected 提交还会重读目标 Profile，复核 enabled、同 workspace、scope 与全部最终题类。目标失效转为无选择 `no_route`，存储失败不进入 `evaluateCase()`；只有成功进入 `evaluating` 的 Case 才复用既有领域评估。改派也复用该事务接缝追加 `manual_reassign` 并更新归属/状态，路由写失败会回滚 Case；既有权威链不改写，from/to 可由最近一次有选择的 `pinned|explicit|auto|manual_reassign` 与新目标派生。
- `observeShadow()` 只在 `opened.created=true`、真实 pinned RouteDecision 已持久化、钉选 Profile 可用且请求未排除时运行；显式 consult、Off/全局关闭、Active Auto、不可用钉选、重放、修订、重试、改派和重启补偿均不调用。缺类时复用同一受限分类器和 Router，但不读取 Active 白名单；unknown/D/E/F 形成无选择的 `admission:authority` 影子事实，模型/解析失败形成有界 `failure:*` 事实。每个新 Case 至多追加一条 `auto_shadow`，派生分类不回写真实 pinned request。
- Shadow 只追加诊断路由，不改变 Case 归属/状态/答案/证据/反馈/投递，不创建另一个 Case、Attempt、Evidence、Feedback、Correction、Snapshot 或画像写，不读取领域 retriever/`generatedDescription`，也不消耗 Attempt 预算。分类、路由和影子写入失败均被隔离，不重试、不进入 `recoverUnexpected()`；进程在 pinned 提交后崩溃时也不补写 Shadow。
- Broker 以 `rootSessionId + 既有 Hook/consult 幂等键` 登记 `autoFlights`，在容量检查和 Case intake 前合并同键调用，flight 覆盖 intake、分类、路由、原子提交和领域评估，settle 后在 `finally` 清理。Auto 从获取许可到评估结束只获取/释放一次 `decisionAgentMaxConcurrentAttempts` 槽位，不在 Router 与评估之间重新竞争。每个 flight 的自有 AbortController 与调用方 signal 串联，并经 `routingControllers`/`routingJobs` 跟踪；Case 取消会中止路由，`flush()` 先 abort 且等待路由与评估任务，再关闭 store，不新增定时器或迟到写入。
- Auto consult 的 `callerRevisionFingerprint` 只归一化 Broker 自己添加且成对出现的 `authorizationClass`/`authorizationClassSource='auto_classifier'`；其他 source、调用方类别和所有请求内容仍参与 canonical JSON。pinned/explicit 继续使用原 `consultFingerprint`。Auto 修订在无显式 `agent_id` 时只重验并沿用 Case 当前 Agent，不运行分类器或 Router；已有 Case 不受之后的 selector 变化影响。
- 浏览器只通过 `/api` 的 `weirDecision/<method>` 读写；P3 新增 learningStart/learningRun/snapshotPublish/snapshotReject/snapshotRollback/memorySnapshot 六个 bare-args 方法，P4 复用同一 bare-args seam 增加只读 `routingReview({sessionId,window,cursor})`，Client 不自行构造调用身份。产品化竞态修复另增加只读、可取消的 `waitForToolCall`，仅在最终咨询状态已持久化后按根会话与调用身份唤醒一次，再由 Client 权威重读；不携带题面或证据正文。全局关闭时只允许 `overview` 只读降级以解释状态，其余远程方法仍失败关闭。所有 Case/Profile/学习/Snapshot 动作都解析调用方根会话/workspace 并检查目标归属；越界拒绝写审计。审计镜像不含原则、评论、题面或证据正文。
- `projectRoutingChains()` 是同一 Case 不可变 RouteDecision 链的纯投影，输出及嵌套值深冻结且不冻结或改写调用方输入。只有先于 Shadow 且带 `chosen` 的 pinned 事实可作比较基线；双方都有选择时按 id 得出 `agreement|disagreement`，无选择则按封闭 `ROUTE_FAILURE_REASONS` 和结构化 `ambiguity` 区分 none/ambiguous/failure，绝不解析自然语言理由。`manual_reassign` 的 `reassignment.from` 由前序 `pinned|explicit|auto|manual_reassign` 的最近选择派生，`to` 取当前选择；explicit 可以参与权威 from 链，但不冒充人工标签或 pinned 基线。
- `DecisionQuery.routingReview({sessionId,workspaceKey,window,cursor})` 只读 SQL 内连接要求 RouteDecision 与 Case 的 `case_id` 和根会话同时匹配，并在 Broker 传入时继续限定授权 workspace；孤行、跨根关联和越界 workspace 不进入投影，也不解析 Profile 名称。`summary` 固定含 `agreement`、`disagreement`、`shadowNone`、`shadowAmbiguous`、`shadowFailure`、`autoNone`、`autoAmbiguous`、`autoFailure`、`manualReassign`、`uncomparable`；每项含 `caseId`、`routeDecisionId`、`mode`、`candidates`、`chosen`、`reason`、`ambiguity`、`createdAt`、当前 `agentId`、`outcome`、至多 240 个 Unicode 字符的 `questionSummary` 与 `record:{caseId}`，Shadow 比较另含 `baselineAgentId`，改派另含 `reassignment`。
- 复盘窗口为 `24h|7d|30d|all`，按 `createdAt DESC, routeDecisionId DESC` 稳定排序并固定每页 20 条；opaque cursor 绑定根会话、窗口和最后一条的位置，重复翻页不重复，非法窗口/游标分别抛 `INVALID_ROUTING_WINDOW`/`INVALID_ROUTING_CURSOR`。`summary` 覆盖整个窗口而非当前页。`metrics.routing` 与复盘 summary 来自同一次纯投影规则，`reassignments` 复用 `routing.manualReassign`，`selectorOffBypasses` 仍是诚实常量 0。Broker 与 `/api/weirDecision/routingReview` 都先经 `sessionContext` 解析真实根/workspace，记录导航继续调用既有授权 `record`；全局关闭仍只有 `overview` 获得只读降级，空存储读不会为复盘创建数据库。
- `overview` 的 `auto.answerClasses` 只投影当前经过封闭校验和去重的 A/B/C 白名单，`auto.shadow` 只投影布尔开关；二者不推断 Active Auto 是否就绪，也不取代 `status.enabled/available`。
- Client 由包内共享视觉组件、纯投影模型和选择器/页面/会话卡/学习 chunk 组成，所有 chunk 在组合根并行加载。界面使用宿主主题 token、locale 和响应式/键盘/读屏契约；诊断、指标与路由复盘按需读取。复盘追加使用请求 token、会话与窗口/epoch guard，迟到响应不会覆盖新会话、窗口或筛选；追加失败保留已有项目，真实空数据、初始错误和追加错误分别呈现。会话卡、收件箱与记录详情的 RouteDecision 历史均只读，无归属记录不开放 Agent 命名空间反馈或 retry。决策卡不写自定义 Session 事件、不使用 `session.append` 或 `commands.execute`，不靠定时轮询刷新。审计镜像尽力而为，不含题面、证据正文或用户画像正文。

## 边界与失败语义

- 前提不成立、缺上下文、超范围、证据冲突、证据过期和选项不支持分别使用 `INVALID_PREMISE`、`MISSING_CONTEXT`、`OUT_OF_SCOPE`、`CONFLICTING_EVIDENCE`、`STALE_EVIDENCE`、`UNSUPPORTED_OPTIONS`，并附可执行修复提示。
- `return` 不冒充用户答案；`escalate` 先落持久待办再交还原生问题。Auto 的 `no_route`、`route_ambiguous`、`authority` 与分类/Router failure 同样先持久化再交还，不创建通用 Agent、不做部分批次回答、不消耗领域 Attempt 或触发领域重试。权威路由提交失败时不调用 `recoverUnexpected()`/`evaluateCase()`；若只有未提交的 `received` intake，后续 consult 明确失败、Hook 原生旁路，不伪造已持久化的 waiting 结果；重启则先把无归属 received intake 恢复为 `awaiting_user(interrupted)`，之后重放不再路由。`awaiting_revision` 在回合结束仍未修订时关闭为 `closed(returned)`。
- 修订/重试产生新 Attempt，旧 Attempt 和已关闭答案不可改写。显式恢复每次只增加一次 Attempt，不会借同一幂等键复活取消终局；无显式 `agent_id` 的 Auto 修订/重试不会切换 Agent。无归属待办可直接回答或取消，也可原子改派到当前 workspace 的 enabled Agent；直接回答没有 Evidence 或后续检索资格，retry 在归属前明确拒绝且无副作用。改派样本仅供后续只读复盘，不成为 Evidence、Feedback、原则、Snapshot、画像或训练输入。
- 没有合格 pinned 基线的 Shadow、只有 explicit 的咨询、无 Shadow 的旧 pinned 和未知旧模式均显示 `uncomparable`，不得猜成一致、分歧或人工改派。复盘和一致率只作诊断，不是回答质量、权限或晋升指标；样本数量、比例、时间和模型建议都不会切换选择器、扩大白名单或训练 Router。复盘没有采纳/忽略、历史改写、自动学习或自动晋升入口，需要纠正时仍走既有明确改派。
- 语义反义不由文本猜测：G4 只把同 scope、同题面但不同选择的源记录视为结构冲突。
- P3 只交付手动语义整合、候选审阅与 Snapshot 发布/拒绝/回滚，以及受 L5 来源约束的非权威 L2。自动定时/阈值整合、自动发布、`generatedDescription` 学习、跨 workspace 共享和用户导出仍未交付；本批已覆盖 Active Auto 原子初始路由、失败关闭、before-commit single-flight、调用方修订指纹、固定 Agent 恢复、Shadow、无归属裁决、原子改派、received-null 恢复、Host 端路由复盘/同源指标/只读远端，以及现有 Client 的三态选择器、高级复盘和无归属安全投影，但不宣称 headless/Desktop 端到端验收。Router、Shadow 与三态选择器不读取或学习任何领域记忆，L3 同样不具有独立授权能力。Auto 选择只决定由谁评估，永远不是执行授权，也不绕过 G1–G7 或原生权限。

### 已观察但独立后续处理的 UX 输入

- `returned(MISSING_CONTEXT)` 仍按既有 `awaiting_revision → closed(returned)` 语义运行；用户介入与通知路径需要单独设计，本 P3 不变更状态机。
- 曾观察到合法 `options` 的原生问题显示为填空；尚需复现并区分 Host 请求形状与 Client 渲染根因，本 P3 未作猜测性修复。

## 测试

- 单元与契约测试：`plugins/weir-harness/test/decision/` 覆盖既有状态机/迁移/检索/反馈/G1–G7/Client、P3 严格 LearningRun/Snapshot reader、冻结输入、并发幂等、结构 replay、来源发布栅栏和真实 pins/manifest/hash，同时覆盖普通语言投影、专用选择面板、共享回答控件、当前证据、按 Case 草稿、筛选/分页竞态、候选 readiness、真实无候选结局和跨根来源。本轮新增版本化 Router 枚举、不可变 `auto`/`auto_shadow` RouteDecision、Broker 保守配置解析与 `router.test.js` 的受限路由契约；`selector-default.test.js` 和 `legacy-v1.test.js` 覆盖三态、fresh-root/legacy 恢复与 v1 不变。`broker-auto.test.js`/`broker-auto-flight.test.js` 覆盖 Active Auto 准入、严格路由、原子提交、single-flight、修订指纹、并发许可和取消/flush；`broker-shadow.test.js` 覆盖 pinned Hook/consult、Shadow-off 对照、none/ambiguous/failure、全部排除入口、幂等/恢复和领域副作用计数；`cases.test.js`、`broker-actions.test.js`、`broker-consult.test.js` 与 `broker-lifecycle.test.js` 覆盖无 Evidence 的无归属回答/重读/检索、取消/拒绝 retry、原子改派回滚与不可变链，以及 received-null 中断恢复。`routing-review.test.js` 与 `remote.test.js` 覆盖纯链分类、历史不回写、20 条稳定游标分页、root/workspace 隔离、同源 metrics、Broker 授权和 bare-args remote/endpointsLive。P4 Client 公共契约另覆盖 Auto 白名单/Shadow 说明、保存/失败/焦点与 root/child 恢复、复盘 summary/普通语言 outcome、20 条追加与 Case 去重、迟到会话/窗口响应、授权记录导航，以及无归属卡/收件箱/记录的反馈和 retry 边界。当前聚焦 Client **109/109**、完整 Decision **415/415**、Client/settings **100/100**、preset/composition **97/97** 与 checkJs 全部通过，33 个 Client chunks 已重建 digest。既有 Weir 全包基线为 **3458 PASS / 0 FAIL / 1 既有平台跳过**（共 3459 项）；本批未宣称重跑全包、headless 或 Desktop 验收。
- headless 集成：本轮最终 `decision-route`、`decision-consult`、`decision-isolation` 聚焦复验 **14/14**；既有 `decision-hook`、`decision-consult`、`decision-batch`、`decision-route`、`decision-recovery`、`decision-feedback`、`decision-isolation`、`decision-ui-remote`、`decision-memory` 与 `decision-learning` 完整矩阵历史基线为 **923/923**，本批未宣称重跑该完整矩阵。learning 场景既有 31 个真实进程阶段（含一次 exact-PID SIGKILL）检查生命周期、DB/wire、对抗输入、恢复、预算、历史不可变和 P1/P2/schema-v1 兼容。
- 真实隔离 Desktop GUI：保留既有 A/B/C 与 P2 memory 验收；P3 主生命周期 run `8wkaN8` **18/18**，整改 run `Tc4Mks` **10/10**，覆盖手动整合、候选 diff/来源/结构重放、发布、只读 Attempt L2、回滚/拒绝、重启、>20 历史、correction/cross-root 来源及 exact-PID/端口清理。测试只启动独立临时 profile/进程，不操作用户当前 App 或其存储。
- 产品化 UX 的真实隔离 Desktop 最新验收 run `bPxzdF` **72/72 PASS**：54 张真实截图、526 条原始网络 RPC、94 条权威直读，覆盖完整生命周期、360/768/1440 CSS px、明暗主题、真实 200% 缩放、96 组键盘交互与六组持久化 Accessibility 证据；held `decision_consult` 卡已验证只有一个紧随卡头的回答表单，没有重复 `.weir-da-record-answers` 或 `.weir-da-suggestion-review` 内容，次级证据/历史/恢复/反馈/诊断均位于表单下方。三个隔离实例均完成 exact-PID/端口清理，运行异常、console error、Slot crash 与加载失败均为零，Attempt/Snapshot 历史内容对照无改写。
- 既有五项关键安全逻辑均有真实 mutation-red、字节恢复和 GREEN 证据。产品化 UX 的独立审查另行发现并修复了重复可写咨询卡、已有当前版本时的无变化误报、筛选/分页状态混用、文案降级和冲突重读问题；代码/组合独立审查已通过，真实 Desktop 证据与当前 App 部署验收分别记录，不以组件测试或 Slot 接线状态替代。
