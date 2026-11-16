# Decision Agent

> 为重复的产品、品味与领域判断提供有出处、可审计、可纠正的本地决策能力。

## 概述

Decision Agent 面向 Execution Agent 反复提出的同类结构化问题。一个已启用且被会话明确选择的 Agent，只有在证据、范围、当前状态、权限和答案形状都通过结构闸门时，才用原问题的选项直接回答；不能回答时交还原生提问，而不是凭印象补答案。

当前交付覆盖 P0 契约、P1 可用核心、P2 独立受限检索/L2/L3 接口、P3 手动语义整合/MemorySnapshot 生命周期，以及完整的产品化 UIUX：多个本地 Agent、独立证据命名空间、自动 Hook、显式咨询、原生升级、持久历史、轻量反馈、中性情节、候选审阅和四个逻辑管理视图。普通用户默认看到“决策助手 / 待你决定 / 判断记录 / 判断依据 / 原则版本”等任务语言，技术实体与原始 JSON 收进高级诊断。本批新增 Broker 私有 Auto Router、两个版本化 sidecar 契约、保守设置、根会话 Off/Auto/Agent 持久化、fresh-root 默认初始化，以及 Active Auto 的咨询类别字段、Hook/consult 分类与候选编排、原子 RouteDecision/Case 提交、失败关闭待办、single-flight、固定 Agent 修订/重试和取消/flush 生命周期；另交付 pinned-only Auto Shadow、原子 `manual_reassign`、无归属用户裁决、`received + agentId=null` 重启恢复、纯派生路由复盘与只读远端，以及现有 Client 的三态选择器、高级复盘和无归属投影。P4 的真实 headless 与真实隔离 Desktop 端到端验收均已交付（9.2–9.3 run `JJFXjr`，164/164 PASS）。跨工作区共享身份与公共/私有记忆（P5，schema v2）已实现：助手是 profile 级共享身份，Agent 详情分为“公共记忆”与“当前工作区经验”，公共候选只在用户打开/刷新公共记忆时自动提炼、且必须由用户显式采用。数据导出已交付：判断记录高级区可显式导出当前工作区私有记录与已发布公共原则文本的版本化 JSON（含计数与 SHA-256 校验和、原子落盘、无导入）；候选原则的行级编辑与删除也已交付：用户可改待发布候选里本次整理新增/变更原则的文字与适用范围、删除其中一条，来源与工作区归属不可改，界面不展示 AI 原稿对照，每次成功写入一条不含正文的审计。自动发布、自动定时/阈值整合和 `generatedDescription` 学习仍未启用。

## 用户可见行为

### Agent 与选择器

- 管理页可创建、编辑、停用和归档 Agent。默认表单只需名称与可选的普通语言判断偏好，创建继承会话模型；完整 paths/tags 专长范围、授权类与模型路由在「高级设置」里用普通控件维护（路径/标签是可增删的单行清单，授权类别是 A/B/C 芯片，模型路由是有序模型档位），`userDescription` 版本历史在诊断中维护。助手身份对整个 DSH profile 唯一：名称大小写不敏感全 profile 唯一，没有工作区归属设置；在任一工作区创建后，同一 profile 的其它工作区都看到并可选到同一助手。
- `generatedDescription` 在当前 P0–P3 恒为 `{revision: 0, text: ''}`，只读且没有生成或写入入口；它为空不妨碍决策。P3 只把用户裁决、有效纠正和已赞回答整合为可审阅原则，不生成画像。
- 会话输入框右侧使用紧凑触发器与专用选择面板，不再是原生下拉框。默认文案为“不启用助手”“自动选择助手”和该 profile 中全部已启用的具体 Agent（不按工作区过滤），选择即保存并关闭，没有额外确认；底层 `off|auto|agent` 三态仍按根会话持久化，子会话解析到同一根会话。自动选择根据只读 `overview.auto` 用普通语言说明真实允许类别数量、空范围、未知状态与“选择对比”状态，A/B/C、Shadow 和原始值只留在高级诊断。面板分为固定头部、独立滚动内容区和固定底部管理入口；宽度不超过 360 CSS px，并按真实动态/可视视口限制高度和位置，长名称与长状态自然换行。读取中不会伪装成未启用，保存失败保留先前有效选择，重复提交受 pending guard 约束，成功后焦点返回已启用的触发器。
- 总开关 `decisionAgentsEnabled` 默认关闭。全局关闭或会话 `Off` 时，Hook 不拦截、咨询明确失败，不创建 Case、路由样本或数据库文件。
- 钉选 Agent 不可用时，选择面板保留其名称并明确标为不可用，不静默改派或显示为正常可选；显式咨询指定其他 Agent 只影响该次调用。修订会重新校验目标 Agent 并记录新路由。

### 自动 Hook 与显式咨询

- Hook 只处理宿主原生的结构化提问，不拦截正文里的反问。回答保持原 `questionId`、顺序、选项和 `multiSelect` 形状；多题批次全有或全无，部分可答时整批交回用户，逐题结论仅作建议。
- `approval`、`plan-review`、不可逆/高风险操作和执行授权请求在语义评估前完全走原生确认，不创建 Case，也不会把其答案变成可复用证据。Decision 回答永远不是执行、合并、发布、删除或其他权限。
- 根选择器为 Auto 时，`decision_consult` 仍优先使用本次显式 `agent_id`；显式目标不可用会明确失败，不回退到 Auto 或钉选 Agent。Hook 的 approval/plan-review/D/E/F/高风险排除仍在建 Case 前旁路；consult 则保留建 Case 后进入 `authority` 待办的既有不对称语义。
- `decision_consult` 新增可选 `authorization_class`，只复制到该次标准化问题。Active Auto 要求每题最终都有可核验的 A/B/C 授权类；**白名单只约束回答放行，不再阻止分类与路由**：类别未获允许的请求照常分类、路由并固定选中助手，随后 Case 进入**有归属的** `authority` 待办（不消耗领域 Attempt），用户裁决按有归属语义沉淀 `user_decision` 证据。stock Hook 缺类时只调用有界分类器，非法/unknown/D/E/F 类别仍在路由前整批失败关闭；派生字段标为 `authorizationClassSource='auto_classifier'`，原始 Hook request 不变。选择器文案如实区分「仍会自动选择助手并评估」与「自动回答尚未允许」。
- Auto 候选来自当前 profile 内全部 enabled、未归档助手（身份不按工作区过滤），经 paths/tags 与类别过滤；Case、证据与授权检查仍只使用当前工作区；零候选不调用模型，唯一候选确定性选择，多候选才进入受限 Router。RouteDecision、规范化 request、Case 归属与状态经 `transitionWithRoute()` 原子提交，选中目标在事务内重新校验；提交失败或目标失效不会进入领域 Attempt。无匹配、歧义、准入拒绝和分类/Router 失败分别持久化为 `no_route`、`route_ambiguous` 或 `authority` 待办，Hook 只在持久提交后交还原生 `next()`。分类与 Router 调用使用独立的有界输出预算（`decisionAgentMaxOutputTokens` 与 4096 取大），截断时以双倍预算重试一次（上限 16384，超时/取消/模型错误不重试，Shadow 保持单次），因此为控制领域 Attempt 成本而调小的输出预算不会截断路由判决；重试仍失败时保留有界结束原因与输出 token 用量，用户表面显示「自动路由失败」并保留直接回答/明确改派入口。路由提交前同键 Hook/consult 加入同一 `autoFlights` Promise，不提前发布或交还；已结算重放也不增加 RouteDecision 或 Attempt。
- `decision_consult` 支持 `answered`、`returned`、`awaiting_user`：带 `caseId` 的答案与出处、封闭原因码与修复提示，或持久用户待办。`awaiting_revision` 中只有内容实际改变的咨询才产生新 Attempt，未修订重放保持幂等。Auto 使用 `callerRevisionFingerprint`，仅剥离成对的 `auto_classifier` 派生类别与来源标记；题面、选项、context、evidence、scope 或调用方类别变化仍是真修订。未显式传 `agent_id` 的 Auto 修订和 retry 固定当前 Agent，选择器或 Router 结果变化只影响新请求。
- 决策卡的**呈现位置由回合层 Chat 节点独占**（`weir-decision`，`groupTree: 'turn'`）：Hook 原生提问与 `decision_consult` 两条路径构建同一个节点，卡片与轮次摘要同级、位于回合的「过程披露」之外，因此在精简/标准/详细任一工作视图下，回合结束被折叠进「已完成」表头后仍可直接阅读，无需展开过程组。同一 Case 在会话中恰好渲染一次：两个工具名的 keyed `tool.call.toolview` 注册保留（占住 key，避免回落到通用工具行或宿主原生提问行）但渲染 `null`，工具行只留零内容的滚动锚点；展开过程披露不会出现第二张卡。两条路径的差异只在回答面——有原生提问面板时它是唯一主回答面，显式咨询由卡片提供完整回答控件。
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

### 共享身份、公共记忆与当前工作区经验

- 助手是 profile 级共享身份：同一 DSH profile 的两个真实工作区看到同一组助手、同一名称与同一个公共记忆区；工作区私有 Case、Evidence、Feedback、纠正、L3 与私有 Snapshot 仍严格只在该工作区可读。
- Agent 详情把学习治理分成两个普通语言分区，页面主导航仍只有“待你决定 / 判断记录 / 助手管理”三项：
  - **公共记忆**：跨工作区提炼的经审阅原则。用户打开或刷新该分区时，只有存在晚于上次冻结输入的合格来源才会自动生成一个候选；首次自动提炼前必须先确认披露（会把本 profile 各工作区合格经验的有界、脱敏摘要发送给当前模型）。候选保持草稿，必须由用户显式“采用公共原则”，也可“放弃候选”或“恢复前序公共版本”；失败状态显示真实原因并只由用户的“重试整理”再发起一次。公共来源只显示 opaque 工作区别名、数量与脱敏概览，不提供外来原始记录或路径。
  - **当前工作区经验**：既有私有整合、候选审阅、来源记录导航、发布/拒绝/回滚与草稿全部保留，只展示当前工作区的记录与私有 Snapshot，并说明私有经验只在记录它的工作区可读。
- 公共记忆不能独立授权：它不生成 Evidence Ref、不单独满足 G1/G2、不证明 scope、不消除 G4 冲突、不替代 G5 当前复核。只有公共记忆而没有当前工作区合格 L5 时，结果仍是 return/escalate。
- Attempt 清单分别固定私有与公共 Snapshot pin。记录详情默认用普通语言区分“公共记忆”和“当前工作区经验”，高级诊断分别展示两区的 Snapshot id/revision/hash、实际原则、来源映射（公共来源是 opaque 别名）、层大小、排除项和省略项；只有私有 pin 的旧 Attempt 仍真实渲染，不伪造公共命中。默认视图不出现绝对工作区路径。

### 管理页与恢复

- 左侧栏使用专用图标进入管理页，默认显示“待你决定”；主导航只有待你决定、判断记录、助手管理，指标与路由复盘位于既有高级区域。复盘以普通语言展示 pinned/Shadow 一致或分歧、Shadow/Auto 无选择、歧义、失败、手动改派及不可比较/无基线，附真实 summary、改派方向和时间；窗口可选 `24h|7d|30d|all`，每页 20 条，加载更多追加并按 RouteDecision 去重，记录链接先经既有授权 `record` 读取。复盘没有采纳/忽略或自动晋升操作。待办直接提供单选/多选/文本回答、建议填入和次级恢复动作；记录以题面摘要、助手、状态和时间的可读列表呈现，桌面双栏、窄屏钻进详情，分页追加并去重。
- 「待你决定」是 profile 级用户表面：收件箱聚合本 profile 全部工作区的 `awaiting_user` Case（不再只列当前会话），默认按来源工作区分组——组头显示工作区名与数量，组内按更新时间倒序、组间按组内最新时间倒序，空组不渲染；待决策跨两个及以上工作区时出现「按工作区 / 按助手」切换。每条显示来源工作区（由客户端按来源 `sessionId` 本地映射，Remote/Client payload 不含真实路径或 `workspaceKey`）并提供打开来源会话入口。左侧栏决策入口在存在待决策时显示数字气泡：数量大于 9 显示 `9+`，无待决策不渲染；气泡数字、导航计数与收件箱总数来自同一次权威读取，页面重新可见、窗口聚焦与任一决策动作后立即刷新，其余时间按可见性门控的低频轮询收敛，读取失败保留上次已知值；数量增加时通过视觉隐藏的 `role="status" aria-live="polite"` 区域播报一次。气泡数字使用警告色淡染底加主标签色的高对比配方，不用白字压饱和琥珀。跨工作区动作与同工作区动作同等对待，不增加额外确认；Case 的根会话与工作区由 Host 从 Case 自身推导，调用方无法指定，来源会话当前未运行时会先按宿主既有语义恢复该会话再投递结论（会话因此继续运行）；恢复失败时答案仍作为权威事实保存，动作结果如实显示「已裁决但未送达」，不伪造成功。用户表面的跨工作区读写是隔离规则的显式例外：Decision Agent、Hook、Auto、Attempt、检索、学习、公共提炼与数据导出仍严格按工作区隔离。
- 助手管理使用紧凑摘要与独立详情/编辑区域：桌面保留可见列表并形成主从布局，窄屏使用列表 → 详情/编辑 → 返回的钻取路径。摘要只保留名称、状态、两行偏好摘要与待审标记；`agentDrillIn` 独立于记录页状态。返回后再次进入同一助手或同一创建表单只恢复视图，保留精确草稿、所选学习 Run/Snapshot 且不重复读取；真正切换目标仍执行未保存确认和权威重读。
- 助手详情面板每个助手只有**一个**高级诊断入口：学习治理的诊断内容、判断偏好版本历史与原始档案合并进底部同一条细披露（`AgentLearning` 支持 `hideAdvanced`，诊断经 `AgentLearningDiagnostics` 复用）；操作行不放重型按钮——编辑是默认描边、停用/启用是 ghost、归档靠行尾并与常规动作拉开距离；整理新原则改为常规按钮，公共记忆的“刷新”收进分区标题行的小 ghost 按钮，不再独占一条全宽行。
- 三个视图统一视觉层级：需要用户行动或知情确认的状态（待办的升级原因、公共记忆首次确认门）一律渲染为带左侧重点条的提醒块；判断记录详情各区改用主色小节标题加细分隔线；助手详情的两个记忆分区成为带主色标题与分隔线的独立区域；单题卡片的题干与卡片标题重复时视觉上去重（读屏语义保留，多题表单不受影响）。
- 助手可**永久删除**：详情操作行末尾的「删除助手」先经 `profileDeletePreview` 取得各类关联记录真实数量（判断记录、判断依据、反馈与纠正、学习整理与公共记忆版本），再在确认对话框中列出并说明不可撤销与影响本 profile 全部工作区；确认后 `profileDelete` 在单个事务中级联删除档案、修订、Case/Attempt/证据关联/证据/反馈/纠正/路由决定/学习 Run/全部 Snapshot，失败整体回滚；确认携带预览计数，期间有新写入即拒绝并提示重新确认；成功后写一条含各类删除数量的审计并返回权威重读的助手列表。选择器中被删助手的引用保留并由「不可用选择」投影诚实呈现，聚合指标与已落盘导出文件不回溯。归档（保留历史）与删除（全部移除）是两条明确分离的路径。
- 记录条目是**按内容撑高的块级卡片**（标题多行时整卡变高，不会被裁切或被下一条压住；行内标题/元信息各自成块，不再用网格容器撑行高）。判断记录的工具条只有一行：两个常用筛选、应用、更多筛选与数据导出并排，高级筛选展开在这行下方，不再是两条全宽空条。
- 判断记录与助手管理是**固定的双栏主从布局**：页头与主导航固定，列表栏和详情栏各自独立滚动（列表滚动不影响详情位置，页面本身不再滚动），选中条目后详情从顶部开始呈现；窄屏继续走列表→详情钻取。
- 决策记录仍支持 Agent、Case 状态、Attempt 结局、返回原因、scope、反馈状态六维过滤；详情只读拼装 Case/Attempts/Evidence/Feedback 和 RouteDecision。默认只显示当前 Attempt 的证据，历史 Attempt 各自分组；Snapshot pin、L2/L3/L5、层大小、省略项和原始 JSON 仅在高级诊断展示，旧 P1/P2 manifest 与 pinned-empty 不伪造命中。
- 用户对待决定的判断有完整自主权：选项题在咨询卡与收件箱提供「自定义…」入口，可用自由文本替代选项作为权威裁决（broker 本就接受该形状，G7 对自动回答的选项约束不变）；「需要更多上下文」用该 Case 的现有证据包做一次受限只读澄清（`clarify-contract/1`：纯文本、禁答案/建议/新证据、每 Case 上限 3 次）；「退回给发起者」需填写理由，Case 经唯一新增迁移 `awaiting_user → awaiting_revision` 交回发起者修订，回合结束未修订按既有规则关闭为 `closed(returned)`，不消耗 Attempt。两个回应入口在待决定卡与收件箱保持左对齐单行、以次级按钮呈现（与「提交决定」的主按钮保持明确色阶差），并位于回答区一侧的细分隔线上方；细分隔线落在整组回应工具（含展开后的澄清/退回编辑器）之后，只用于分隔其后的记录工具区。
- 会话卡与收件箱以真实问题、答案、理由和当前依据为中心，每个区域至多一个主操作。会话卡按状态做渐进披露：静态层只保留题面、状态、核心内容与主操作（待决定是升级原因提醒与回答控件，已答是答案摘要、一句话理由与一行安静的认可/不认可）；「判断依据」是唯一的顶层折叠入口；处理历史、路由决定历史与高级诊断收进同一条「更多细节」分组折叠（嵌套 Disclosure 的 Escape 只关最内层，分组一次定位、子层不再跳动）；「打开记录」为 ghost 次级操作（待决定的咨询卡维持 secondary）；反馈后果说明静态压缩为一行，完整两句在「更多细节」内。Hook 原生提问保持唯一主回答面，卡片不复制第二套表单；无原生回答面的显式咨询复用同一回答组件。带暂定建议时，回答表单在题面与提交行之间显示标题为「暂定建议」的块，逐题列出建议与逐题结论；「使用建议」就在该块内，只把建议填进草稿、不提交，提交行只保留「提交决定」；原生提问卡没有卡片表单，同一块只读展示，作答仍在上方的原始提问面板。赞、踩、撤销、备注、纠正、裁决、改派、取消和重试都经既有 Host 远端动作写入权威库并校验根会话/workspace，写后重读，重复点击受 pending guard 约束。`agentId=null` 的 Auto 记录显示真实 Auto 路由状态（无匹配显示“尚未选择助手”，分类/Router 运行层失败显示「自动路由失败」），保留回答、改派、取消及只读 RouteDecision 历史，但不显示 Agent 反馈、纠正或 retry；明确改派并由权威重读确认归属后，才恢复普通 owned recovery。
- 确认类模态（取消、放弃编辑、助手状态、Snapshot 发布/拒绝/回滚）使用原生 `<dialog>.showModal()`：黑色半透明遮罩覆盖真实可视视口、背景 inert、root/body/Decision 页与实际滚动祖先均被锁定；滚动基线取焦点到达触发器后的实际打开前位置，取消/普通关闭精确恢复，删除或缩短内容时恢复到新的合法边界，确认动作在 Promise 结算与下一次布局后才恢复焦点。助手选择器同样复用原生 dialog 的焦点陷阱、滚动锁与点击外部关闭，但它是**锚定到输入框触发器的浮层**：遮罩透明不调暗页面，宽度 320–360px 跟随触发器，优先向上展开、上方空间不足时翻转到下方，每次定位保留 8px 视觉视口边距（含 200% 缩放偏移），内容变化由 ResizeObserver 重排。
- 指定卡片展开使用 `revealOnOpen="end"` 与 `revealReady`：loading 占位不触发定位，首个冷加载成功或错误完成布局后仅经一次 RAF 以 `instant/end` 显示展开区域末尾；同一打开周期的后续刷新不重复跳转，不收走输入焦点或清除草稿。嵌套高级诊断不另建第二套滚动逻辑。
- Agent 详情把学习治理收敛为“整理新原则 → 审阅变化/来源/结构校验 → 采用或放弃”，当前版本可明确恢复前序版本。只有匹配的候选 Run、Snapshot、父版本（存在时）、diff 和最新 revision 全部加载后才允许写入；候选摘要、加载失败或过期详情不能触发生命周期操作。跨根来源以授权的有界摘录就地展示，只有当前根 record reader 确认可读才导航；当前 Snapshot 超出最近 20 条摘要仍保留真实 revision 和恢复入口。
- **候选原则可编辑与删除**：待发布候选中，本次整理**新增或变更**的原则条目带行级「编辑 / 删除」。编辑只改文字（1..600 字符，带实时字数）与适用范围（可增删的路径前缀/标签行 + A/B/C 芯片）；来源与工作区归属不可改——私有原则的工作区固定为候选所属工作区，界面只显示「当前工作区」与「工作区与来源固定」，公共原则不出现工作区行，也不提供新增无来源原则的入口。每次保存以审阅当前的 `expectedRevision` 原子提交；成功后 draft revision 递增、仍是同一 Learning Run，模型的 `operations_json`/`replay_json` 一字不改。revision 已过期、候选已发布/拒绝、条目不属于本候选的 added/changed、scope 越界、文字超限或一次提交超过 32 条都明确拒绝且候选内容零变化；公共候选的文字在保存时就先扫绝对路径与外来记录 id。删除一条 **changed** 项表示本版本不再包含该原则（发布后不含它，父版本历史仍可读），删除 **added** 项表示本次不采用；删除走二次确认并说明「本版本将不再包含它，历史仍保留」。审阅只呈现编辑后的当前内容，不展示「AI 原稿 → 你的修改」对照；保存失败保留草稿，revision 冲突会先重读权威候选再提示重试。发布确认在本次审阅确实改过候选项时追加一行事实「其中 N 条由你编辑、M 条已删除」（不展开原稿），发布本身仍走既有确认、父版本与来源重查。已发布/已拒绝版本不再渲染编辑/删除入口，直接更新请求被拒绝且历史不变。
- 运行层失败在预算内重试，耗尽后进入可恢复待办。显式 retry/reassign 每次只授权一个新 Attempt，并重新校验 Agent；Auto retry 不因选择器变化重新分类或路由，无归属 Case 必须先改派，不能直接 retry。重复传输不新增 Attempt。重启保留等待状态和三态选择器，未完成 Attempt 标为 `interrupted`，不会变成答案；未提交权威路由的 `received + agentId=null` intake 在打开存储时转为 `awaiting_user(interrupted)`，重放只返回该待办，不重新路由或创建 Attempt。旧版无行与恢复根会话保持 `Off`，不会因 `decisionAgentSelectorDefault=auto` 被补写为 Auto；显式 `Off` 会保留持久行，之后的默认值变化也不能覆盖它。

### 数据导出

- 判断记录区域内的折叠高级入口提供一次性显式“导出数据”动作；确认框说明范围（当前工作区私有记录 + 已发布公共原则文本）与本地目录，不改变任何记录、筛选或授权，也不新增主导航。
- 导出由 Host 以调用方根会话推导范围：私有 Case/Attempt/Evidence/Feedback/纠正/RouteDecision 与私有 LearningRun/MemorySnapshot，加上当前已发布的公共原则（文本、scope 与不透明 `principleId`）；其他工作区原始记录、绝对工作区路径、真实 `workspaceKey`、可关联到其他 workspace 的 opaque alias（如 `origin_*`）与原始模型请求/提示词（L0）不进入文件；用户自己的题面与 context 属于其 Case 内容，经脱敏后导出；公共区不含来源谱系（包括 `items[].sources`）。
- 文件是版本化 JSON 信封（`kind:weir-decision-export`、`formatVersion:1`、`exportedAt`、`generator`、`scope.workspaceAlias`、`counts`、`integrity:{algorithm:'sha256',value}`）；校验和覆盖除 `integrity` 外的整个信封，可按 canonical JSON 独立重算。文件写入决策存储目录下的 `exports/`（目录 0700、文件 0600、临时文件 + 原子重命名、32 MiB 上限），失败不留半成品。POSIX 上 0700/0600 为真实权限；Windows 上由 ACL 近似，不承诺同等语义（32 MiB 上限约束文件大小，不承诺内存峰值）。
- 成功只返回真实文件路径、字节数与校验和，并在界面展示与“复制路径”；失败只显示普通语言原因与重试，不伪造成功。每次成功导出写一条不含内容正文的审计：计数、校验和、文件名，另含根会话 id、zone 与字节数。
- 本能力不提供导入或恢复；与迁移备份不同，导出文件不回写数据库，也不承诺恢复语义。

## 配置

除存储目录外均调用时读取；`decisionAgentStorePath` 标为需重启。

决策助手的设置位于全局设置面板的独立「决策助手」页面（与「Weir」主页面、「Weir 模型路由」并列），不再混在主页面里：基本设置只有总开关、新根会话的默认选择与允许自动回答的授权类别（A/B/C 三枚可独立切换的控件，保存时合成既有 JSON 数组，不再要求手写 JSON）；`decisionAgentAnswerTimeoutMs` 等运行参数与 Shadow 诊断收在默认折叠的「高级设置」，总开关关闭时整个高级区不渲染。`decisionAgentChains` 与 `decisionAgentStorePath` 是**配置文件面键**（config-face-only，`page: false`）：设置页没有它们的行，也没有替代的 JSON 文本框；每助手路由改由助手编辑器维护，全局链与存储目录仍只从配置文件设置并照常生效。

| 键 | 默认值 | 说明 |
|---|---|---|
| `decisionAgentsEnabled` | `false` | 总开关；关闭等价于所有会话 `Off` |
| `decisionAgentSelectorDefault` | `'off'` | 仅允许 `off\|auto`，默认 Off。只有之后真正新建的根会话在全局启用、`source=startup`、root guard 通过且尚无 selector 行时才持久化 Auto；恢复、旧版无行、startup 子会话及非法存储值均保持 Off |
| `decisionAgentAutoShadow` | `false` | 非权威 Shadow 诊断开关；仅布尔 `true` 启用。只对新建且合格的 pinned Hook/非显式咨询在真实 pinned 路由后追加至多一条 `auto_shadow`，默认关闭 |
| `decisionAgentAutoAnswerClasses` | `'[]'` | Active Auto 的 A/B/C JSON 白名单；保存时校验、有效值去重，非法存储值运行时归为空。默认空：照常分类与路由并固定助手，但结论不自动回答——Case 进入有归属 `authority` 待办由你裁决 |
| `decisionAgentAnswerTimeoutMs` | `60000` | 每次 Auto 分类、Router 或领域评估 sidecar 调用的硬超时 |
| `decisionAgentMaxAttemptsPerCase` | `3` | 自动评估、修订与重试的默认合计上限；用户显式恢复每次只追加一次 |
| `decisionAgentContextBudgetTokens` | `24000` | 当前 Case 与证据包的有界预算 |
| `decisionAgentMaxOutputTokens` | `4096` | 分类、Router 与评估器的单次输出上限 |
| `decisionAgentMaxConcurrentAttempts` | `4` | 并发评估上限；Auto 从 intake 到分类/路由和后续评估持有同一许可，超限 Hook 直接走原生提问 |
| `decisionAgentChains` | `''` | 配置文件面键：按 Agent id 配置有序模型链；空链继承会话路由，显式不可用路由不静默换模型；设置页不提供行或替代文本框 |
| `decisionAgentRetentionDays` | `0` | 仅启动时清理无裁决/反馈的旧关闭记录；0 表示永久保留 |
| `decisionAgentStorePath` | `''` | 配置文件面键：绝对路径覆盖目录；留空使用 profile 私有存储（需重启） |

页面归属：`decisionAgentsEnabled`、`decisionAgentSelectorDefault` 与 `decisionAgentAutoAnswerClasses` 在「基本设置」；`decisionAgentAnswerTimeoutMs`、`decisionAgentMaxAttemptsPerCase`、`decisionAgentContextBudgetTokens`、`decisionAgentMaxOutputTokens`、`decisionAgentMaxConcurrentAttempts`、`decisionAgentRetentionDays`、`decisionAgentAutoShadow` 在默认折叠的「高级设置」；`decisionAgentChains` 与 `decisionAgentStorePath` 不在任何设置页。三页（主页面、模型路由、决策助手）编辑同一个 `weir-settings` 域，各自只暂存与保存本页字段。

`decisionAgentSelectorDefault` 已接入上述 fresh-root 初始化，`decisionAgentAutoAnswerClasses` 已接入 Active Auto 准入；`decisionAgentAutoShadow` 已接入 pinned-only 非权威观察，Shadow 不读取 Active 白名单。只读 `overview.auto` 暴露实际清理后的 `{answerClasses,shadow}`，全局可用性仍由 `overview.status` 单独表达，不虚构 readiness；选择器只把该投影用于真实白名单/Shadow 说明，不把 Auto 伪装成 Agent。不存在整合计划、公共记忆专用或自动画像学习设置键：公共记忆随助手身份共享，没有工作区归属或公共/私有开关。

## 设计细节

`Decision Broker` 是 Case 状态、路由、证据闸门、升级、持久化、审计、用户动作与投递的唯一权威。Decision Agent 是耐久 Profile、独立命名空间、模型路由和无状态 per-Attempt 评估器，不是长驻聊天会话。

- 权威存储使用 `node:sqlite`、WAL、`BEGIN IMMEDIATE`、串行写与迁移备份。默认路径为 `<profileContext.home>/weir/profiles/<profileContext.name>/decisions/decision.db`；更高数据库或记录 schema 版本明确拒绝且不改写。
- 有归属用户裁决与 `user_decision` Evidence Ref 同事务写入；最终 Agent 不是非空字符串时只关闭 Case 并保存真实决定，绝不写 Evidence。点赞与 `agent_record` 同反馈事务写入。并发首次送达在事务内重读幂等键，返回已提交 Case。
- `selectors` 仍是根会话状态，不携带工作区。无行与未知模式读取为 Off；显式 Off/Auto/Agent 都保留行，Auto 的 `agent_id` 恒为 null。fresh-root 初始化在事务内重查“无行”再插入 Auto，已有 Off/Auto/Agent 或未知行均不被覆盖。决策库 `PRAGMA user_version` 升到 2（`agent_profiles` 去掉工作区身份列，`learning_runs`/`memory_snapshots` 增加 `zone` 与 `namespace_workspace_key`）；既有记录 envelope 保持 v1。
- 既有 `decision` 预设行监听 `agent/created`，仅在全局 enabled、default=auto、`source=startup` 且 `origin` 不是 subagent、`delegationDepth` 小于 1 时调用 Broker 初始化。监听捕获全部错误且不否决创建，初始化失败保持 Off；resume、clear、compact 与 startup child 均不写默认行。
- `DecisionContextRetriever` 是 Broker 内部同步只读接缝，返回深冻结的 L2/L3/L5、裁剪前完整冲突对与当前观测 hash。L3 是现有 Case 的可重建投影，不新增权威表或数据库迁移。
- `DecisionLearning` 使用 `learning_runs`/`memory_snapshots` 的 `(agent, zone, workspace)` 命名空间：私有区按当前工作区隔离，公共区不隶属任何工作区并用 partial unique index 保证每个 Agent 至多一个 active 公共候选；两区版本序列独立。Learning Run 在模型前持久冻结输入并防止重复/并发运行；候选操作严格限于 add/refine/merge/narrow/retire，结构重放只验证目标、来源、scope、冲突与最终 hash，不冒充回答质量分数。公共提炼经 Host 内部受限端口读取各工作区白名单字段，发布时逐来源在原工作区重验，任一来源失效即失败关闭。
- Snapshot 保存完整不可变原则内容和来源 lineage，状态修订只能经显式发布、拒绝或回滚。发布重查父版本与来源当前资格；回滚恢复最高版本的合格前序 published，无前序则 L2 为空，不回写历史。公共 Snapshot 与私有 Snapshot 各自独立版本化，公共生命周期动作不改写任何私有 Snapshot 或旧 Attempt。
- 候选更新复用既有 `memory_snapshots` 行（无 schema/迁移）：`DecisionLearning.updateCandidate(snapshotId, expectedRevision, edits)` 在单个 `store.write` 事务里写 `principles_json` 与 `revision+1`、刷新 `updated_at`，`learning_runs` 只被读取。`edits` 是封闭对象（`{principleId, text?, scope?, remove?}`，条目 ≤32、id 唯一、`remove` 不得带 text/scope、更新必须带上 text 或 scope），`scope` 只接受 `paths`/`tags`/`authorizationClasses`；`workspaces` 不是合法字段，私有原则重建为「候选工作区 + 提示」，公共原则永不含 workspace 列表。可编辑集合每次由父 Snapshot 与候选的内容 diff 重新计算（`text/scope/sources/state`），未变化的父原则副本与父版本 retire 项返回 `CANDIDATE_ITEM_NOT_EDITABLE`；更新后的整组重新过 `validatePrinciple(zone)`（id 唯一、text 1..600、`state` 不变、scope 封闭形状、≤128 条），公共 zone 先跑 `publicContentIssues`。任何拒绝都在事务内回滚，draft 与 run 字节不变；同一 revision 的第二次提交得到 `REVISION_CONFLICT`，客户端据此重读而不是静默覆盖。审计复用 decision `snapshot` 类型、`action:'candidate-update'`，字段只有 `{snapshotId, learningRunId, agentId, rootSessionId, zone, revisionBefore, revisionAfter, edited, removed}`，不含原则正文或 scope 内容。
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
- 浏览器只通过 `/api` 的 `weirDecision/<method>` 读写；P3 新增 learningStart/learningRun/snapshotPublish/snapshotReject/snapshotRollback/memorySnapshot 六个 bare-args 方法（候选编辑再增 `snapshotUpdate`，与 learning 动作同属 `LEARNING_MUTATIONS`：调用方只拥有编辑载荷，根会话与 workspace 一律由 `sessionContext` 推导、伪造的 workspace 被覆盖，`edits` 由 Broker 的封闭解析器接管），P4 复用同一 bare-args seam 增加只读 `routingReview({sessionId,window,cursor})`，P5 再增加 `publicMemoryRefresh({sessionId,agentId,acknowledgedDisclosure?,retryFailedExtraction?})` 与只读 `publicCandidate({sessionId,agentId,learningRunId?})`；公共记忆调用只接受调用方自己的会话、助手与显式用户手势，根会话与工作区一律由 Broker 从 `sessionContext` 推导，调用方提供的工作区/zone/归属字段在进入 Broker 前被丢弃。Client 不自行构造调用身份。产品化竞态修复另增加只读、可取消的 `waitForToolCall`，仅在最终咨询状态已持久化后按根会话与调用身份唤醒一次，再由 Client 权威重读；不携带题面或证据正文。全局关闭时只允许 `overview` 只读降级以解释状态，其余远程方法仍失败关闭。所有 Case/Profile/学习/Snapshot 动作都解析调用方根会话/workspace 并检查目标归属；越界拒绝写审计。审计镜像不含原则、评论、题面或证据正文。
- `projectRoutingChains()` 是同一 Case 不可变 RouteDecision 链的纯投影，输出及嵌套值深冻结且不冻结或改写调用方输入。只有先于 Shadow 且带 `chosen` 的 pinned 事实可作比较基线；双方都有选择时按 id 得出 `agreement|disagreement`，无选择则按封闭 `ROUTE_FAILURE_REASONS` 和结构化 `ambiguity` 区分 none/ambiguous/failure，绝不解析自然语言理由。`manual_reassign` 的 `reassignment.from` 由前序 `pinned|explicit|auto|manual_reassign` 的最近选择派生，`to` 取当前选择；explicit 可以参与权威 from 链，但不冒充人工标签或 pinned 基线。
- `DecisionQuery.routingReview({sessionId,workspaceKey,window,cursor})` 只读 SQL 内连接要求 RouteDecision 与 Case 的 `case_id` 和根会话同时匹配，并在 Broker 传入时继续限定授权 workspace；孤行、跨根关联和越界 workspace 不进入投影，也不解析 Profile 名称。`summary` 固定含 `agreement`、`disagreement`、`shadowNone`、`shadowAmbiguous`、`shadowFailure`、`autoNone`、`autoAmbiguous`、`autoFailure`、`manualReassign`、`uncomparable`；每项含 `caseId`、`routeDecisionId`、`mode`、`candidates`、`chosen`、`reason`、`ambiguity`、`createdAt`、当前 `agentId`、`outcome`、至多 240 个 Unicode 字符的 `questionSummary` 与 `record:{caseId}`，Shadow 比较另含 `baselineAgentId`，改派另含 `reassignment`。
- 复盘窗口为 `24h|7d|30d|all`，按 `createdAt DESC, routeDecisionId DESC` 稳定排序并固定每页 20 条；opaque cursor 绑定根会话、窗口和最后一条的位置，重复翻页不重复，非法窗口/游标分别抛 `INVALID_ROUTING_WINDOW`/`INVALID_ROUTING_CURSOR`。`summary` 覆盖整个窗口而非当前页。`metrics.routing` 与复盘 summary 来自同一次纯投影规则，`reassignments` 复用 `routing.manualReassign`，`selectorOffBypasses` 仍是诚实常量 0。Broker 与 `/api/weirDecision/routingReview` 都先经 `sessionContext` 解析真实根/workspace，记录导航继续调用既有授权 `record`；全局关闭仍只有 `overview` 获得只读降级，空存储读不会为复盘创建数据库。
- `overview` 的 `auto.answerClasses` 只投影当前经过封闭校验和去重的 A/B/C 白名单，`auto.shadow` 只投影布尔开关；二者不推断 Active Auto 是否就绪，也不取代 `status.enabled/available`。
- Client 由包内共享视觉组件、纯投影模型和选择器/页面/会话卡/学习 chunk 组成，所有 chunk 在组合根并行加载。界面使用宿主主题 token、locale 和响应式/键盘/读屏契约；诊断、指标与路由复盘按需读取。共享模态使用原生 top layer、按 visualViewport 实际宽度/高度/偏移及 scale 约束尺寸和位置，并监听 resize/scroll 后精确清理；普通窄屏为宿主返回控件保留顶部空间，真实缩放时启用紧凑钻取布局。滚动锁按 Document 可重入，覆盖两个滚动条方向、保存打开前位置并精确恢复 inline 样式。复盘追加使用请求 token、会话与窗口/epoch guard，迟到响应不会覆盖新会话、窗口或筛选；追加失败保留已有项目，真实空数据、初始错误和追加错误分别呈现。会话卡、收件箱与记录详情的 RouteDecision 历史均只读，无归属记录不开放 Agent 命名空间反馈或 retry。决策卡不写自定义 Session 事件、不使用 `session.append` 或 `commands.execute`，不靠定时轮询刷新。审计镜像尽力而为，不含题面、证据正文或用户画像正文。
助手编辑器的高级区不再出现原始 JSON：专长范围是路径前缀与标签的可增删行清单加 A/B/C 授权类别芯片（取消最后一个选中类别被拒绝并给出提示；合成 scope 只含非空 paths/tags 与 authorizationClasses，不写 `workspaces`），模型路由是按顺序排列的模型档位（复用 composer 风格选择器，picker chunk 未到达或失败时每档降级为 provider/model/reasoningEffort 三个输入框，仍未选完的档位不写入并以提示告知）；两处控件的变更立即回写 `scopeText`/`routeText`，这两个文本仍是唯一暂存值，脏检查、保存校验与“空链继承会话模型”语义不变。

## 边界与失败语义

- 前提不成立、缺上下文、超范围、证据冲突、证据过期和选项不支持分别使用 `INVALID_PREMISE`、`MISSING_CONTEXT`、`OUT_OF_SCOPE`、`CONFLICTING_EVIDENCE`、`STALE_EVIDENCE`、`UNSUPPORTED_OPTIONS`，并附可执行修复提示。
- `return` 不冒充用户答案；`escalate` 先落持久待办再交还原生问题。Auto 的 `no_route`、`route_ambiguous`、`authority` 与分类/Router failure 同样先持久化再交还，不创建通用 Agent、不做部分批次回答、不消耗领域 Attempt 或触发领域重试。权威路由提交失败时不调用 `recoverUnexpected()`/`evaluateCase()`；若只有未提交的 `received` intake，后续 consult 明确失败、Hook 原生旁路，不伪造已持久化的 waiting 结果；重启则先把无归属 received intake 恢复为 `awaiting_user(interrupted)`，之后重放不再路由。`awaiting_revision` 在回合结束仍未修订时关闭为 `closed(returned)`。
- 候选编辑的失败是封闭的：`SNAPSHOT_STATE_CONFLICT`（已非 draft/candidate）、`REVISION_CONFLICT`（revision 过期或并发状态变化）、`CANDIDATE_ITEM_NOT_EDITABLE`（不属于本次 added/changed）、`INVALID_RECORD`/`UNKNOWN_FIELD`（edits 形状、重复 id、伪造 `sources`/`workspaces`/`state`）、`INVALID_PRINCIPLE`（文字或 scope 越界）、`CANDIDATE_EDIT_LIMIT`（一次超过 32 条）、`PUBLIC_CONTENT_REJECTED`（公共文字含绝对路径或外来记录 id）与 `OUT_OF_SCOPE`（跨 workspace 或 agentId 不匹配的 Snapshot 边界，写 `boundary-reject` 审计）。以上任一失败都不改变候选内容，也不自动发布；编辑不要求 Agent enabled，发布仍然要求。
- 修订/重试产生新 Attempt，旧 Attempt 和已关闭答案不可改写。显式恢复每次只增加一次 Attempt，不会借同一幂等键复活取消终局；无显式 `agent_id` 的 Auto 修订/重试不会切换 Agent。无归属待办可直接回答或取消，也可原子改派到当前 workspace 的 enabled Agent；直接回答没有 Evidence 或后续检索资格，retry 在归属前明确拒绝且无副作用。改派样本仅供后续只读复盘，不成为 Evidence、Feedback、原则、Snapshot、画像或训练输入。
- 没有合格 pinned 基线的 Shadow、只有 explicit 的咨询、无 Shadow 的旧 pinned 和未知旧模式均显示 `uncomparable`，不得猜成一致、分歧或人工改派。复盘和一致率只作诊断，不是回答质量、权限或晋升指标；样本数量、比例、时间和模型建议都不会切换选择器、扩大白名单或训练 Router。复盘没有采纳/忽略、历史改写、自动学习或自动晋升入口，需要纠正时仍走既有明确改派。
- 语义反义不由文本猜测：G4 只把同 scope、同题面但不同选择的源记录视为结构冲突。
- 手动语义整合、候选审阅与 Snapshot 发布/拒绝/回滚、受 L5 来源约束的非权威 L2，以及跨工作区共享身份与公共/私有记忆已交付。自动定时/阈值整合、自动发布、`generatedDescription` 学习与导出文件的导入/恢复仍未交付（显式导出本身已交付）；本批已覆盖 Active Auto 原子初始路由、失败关闭、before-commit single-flight、调用方修订指纹、固定 Agent 恢复、Shadow、无归属裁决、原子改派、received-null 恢复、Host 端路由复盘/同源指标/只读远端，以及现有 Client 的三态选择器、高级复盘和无归属安全投影，并已完成下述真实 headless 与 Desktop 端到端验收。Router、Shadow 与三态选择器不读取或学习任何领域记忆，L3 同样不具有独立授权能力。Auto 选择只决定由谁评估，永远不是执行授权，也不绕过 G1–G7 或原生权限。

### 迁移边界（v1 → v2）

- 首次打开旧库时先 checkpoint 再走 SQLite 一致性备份（VACUUM/backup 路径）后迁移：既有 Agent 保持原 `agent_id` 与私有归属，重复显示名按大小写不敏感规则加可见后缀且不合并任何身份；既有 LearningRun/MemorySnapshot 全部迁为私有区并继承原工作区，公共区初始为空（首次刷新最多生成 draft）。迁移或校验失败时事务回滚，原库仍可打开；更高 `user_version` 明确拒绝（`SCHEMA_TOO_NEW`）。
- **恢复备份会丢失迁移之后的所有写入**：不仅是公共数据，迁移成功后新增的私有 Case/Attempt/Evidence/Feedback 以及公共候选都会回到备份时点。界面与迁移说明必须按此数据丢失边界表述，不得暗示只丢公共数据。

### 已观察但独立后续处理的 UX 输入

- `returned(MISSING_CONTEXT)` 仍按既有 `awaiting_revision → closed(returned)` 语义运行；用户介入与通知路径需要单独设计，本 P3 不变更状态机。
- 曾观察到合法 `options` 的原生问题显示为填空；尚需复现并区分 Host 请求形状与 Client 渲染根因，本 P3 未作猜测性修复。

## 测试

- 单元与契约测试：`plugins/weir-harness/test/decision/` 覆盖既有状态机/迁移/检索/反馈/G1–G7/Client、P3 严格 LearningRun/Snapshot reader、冻结输入、并发幂等、结构 replay、来源发布栅栏和真实 pins/manifest/hash，同时覆盖普通语言投影、专用选择面板、共享回答控件、当前证据、按 Case 草稿、筛选/分页竞态、候选 readiness、真实无候选结局和跨根来源。本轮新增版本化 Router 枚举、不可变 `auto`/`auto_shadow` RouteDecision、Broker 保守配置解析与 `router.test.js` 的受限路由契约；`selector-default.test.js` 和 `legacy-v1.test.js` 覆盖三态、fresh-root/legacy 恢复与 v1 不变。`broker-auto.test.js`/`broker-auto-flight.test.js` 覆盖 Active Auto 准入、严格路由、原子提交、single-flight、修订指纹、并发许可和取消/flush；`broker-shadow.test.js` 覆盖 pinned Hook/consult、Shadow-off 对照、none/ambiguous/failure、全部排除入口、幂等/恢复和领域副作用计数；`cases.test.js`、`broker-actions.test.js`、`broker-consult.test.js` 与 `broker-lifecycle.test.js` 覆盖无 Evidence 的无归属回答/重读/检索、取消/拒绝 retry、原子改派回滚与不可变链，以及 received-null 中断恢复。`routing-review.test.js` 与 `remote.test.js` 覆盖纯链分类、历史不回写、完整链窗口化、20 条稳定游标分页、root/workspace 隔离、同源 metrics、Broker 授权和 bare-args remote/endpointsLive。P4 Client 公共契约另覆盖 Auto 白名单/Shadow 说明、保存/失败/焦点与 root/child 恢复、复盘 summary/普通语言 outcome、20 条追加与 RouteDecision 去重、迟到会话/窗口响应、授权记录导航，以及无归属卡/收件箱/记录的反馈和 retry 边界。最终聚焦 Client **109/109**、完整 Decision **503/503**、测试装置 **453/453**、Client/settings **100/100**、preset/composition **97/97** 与 checkJs 全部通过，33 个 Client chunks 已重建 digest；Weir 全包最终 **3614 PASS / 0 FAIL / 1 既有平台跳过**（共 3615 项）。新增真实 headless 与 Desktop 证据见下。

- 可视化编辑（设置页拆分与助手编辑器）的覆盖：`test/decision/client-decision-page.test.js` 覆盖路径/标签增删与删除、空行不写入 JSON 也不丢行、合成 scope 不含 `workspaces`、拒绝取消最后一个授权类、模型档位增删与有序合成、未选完的档位不写入且给出提示、空链仍写 `{"chain":[]}` / 未动时为继承会话模型、picker 到达时每档渲染选择器、未到达时降级为 provider/model/reasoningEffort 三个输入框，以及编辑器内不再存在 scope/modelRoute 文本域；`test/client-settings-page.test.js` 与 `test/client-decision-class-editor.test.js` 覆盖设置页侧的 A/B/C 白名单控件（切换即合成、空选写 `[]`、非法存储值全关 + 提示、覆盖/重置）；`test/client.test.js` 钉住决策页拿到 picker chunk 与惰性 getSession时三个设置页控制器/分区的注册与词典并集。
- 跨工作区共享身份与公共/私有记忆（P5，schema v2）的实施证据：`test/decision/remote-public-memory.test.js` 覆盖 bare-args 公共刷新/候选读取、调用方工作区/归属字段被丢弃、只返回 opaque 别名、披露门、公共生命周期与越权审计；`public-retry.test.js` 覆盖失败后仅由显式用户动作重试一次、助手读模型按工作区隔离私有区；`client-decision-public-memory.test.js` 覆盖两个分区、精确“公共记忆/当前工作区经验”标签、每次打开恰好一次自动读取、披露确认、显式采用/放弃/回滚、候选正文与已发布原则只读可读、pending/失败重试、焦点返回与 200% 视口；`client-decision-memory-partitions.test.js` 覆盖记录详情默认普通语言、高级诊断双分区 pin/原则/来源映射/层大小/省略项、旧 Attempt 仅私有 pin 的兼容，以及公共区无外来记录导航。门禁结果（最终候选）：完整 Decision **614/614**、驱动单测 **77/77**、Client digest 契约 **28/28**、Client/settings **377/377**、测试装置单测 **548/548**、checkJs PASS、Weir 全包 **3725 PASS / 0 FAIL / 1 既有平台跳过**（共 3726 项）；最终候选重跑真实 headless 矩阵 **47/47** 与迁移验收 **8/8**。公共记忆契约的 5 个变异点（remote 白名单、失败重试门、公共 L2 分区、两分区标签、驱动分区守卫）均取得 RED→字节恢复→GREEN 证据。
- 真实 Desktop 验收：同一隔离 profile 的 W1/W2/W3 共享身份与两区、披露→候选→显式采用、发布后在无本地合格 L5 的 W4 产生真实 Attempt（固定已发布公共 Snapshot、公共原则非空、证据映射为空、`escalate` 且零引用）、第二候选显式放弃后公共版本不变、回滚为空；候选审阅渲染拟定原则正文与适用范围，采用后公共区只读展示已发布原则；私有记录双向拒绝与 `learningRun`/`memorySnapshot` 的 ids-only 审计；迁移旧 profile 的 boot/restart 身份与历史不变；覆盖 360/768/1440、真实 200%、明暗、中英、键盘/AX。最终接受 run `zNOCf5` **265/265** 检查通过，172 张截图记录/168 个文件、2776 条 RPC、6 组 owned PID/端口精确清理，运行时异常/console/slot/log 全 0；更早的失败与被取代 PASS run 仅作诊断保留，不并入最终证据。
- 数据导出的实施与复审证据：`export-assembly.test.js` 覆盖真实 Attempt/Evidence/Feedback/RouteDecision 分区、file locator 路径脱敏与其他工作区别名移除；`export-writer.test.js` 覆盖 0700/0600、重命名前 chmod 的失败零残留；`broker-export.test.js`/`remote-export.test.js` 覆盖授权、封闭错误码与只提交 `sessionId`；`client-decision-export.test.js` 覆盖确认、pending、成功、失败、重试与焦点返回。独立复审曾以真实导出文件为证判定 B1：公共 L2 的 `items[].sources` 携带两个其他工作区别名；修复后真实 headless 验收 **36/36**，真实导出文件只剩一个 `origin_` token（即 `scope.workspaceAlias`），`publicL2` 不再有 `sources`。合并后门禁：完整 Decision **643/643**、Weir 全包 **3754 pass / 0 fail / 1 既有平台跳过**（共 3755）、client digest **28/28**（33 chunks）、测试装置 **557/557**、checkJs exit 0；变异控制覆盖 workspace 过滤、私有 zone 过滤、审计、校验和、原子重命名、空分区、locator 脱敏与别名规则（均 RED→字节恢复→GREEN）。真实隔离 Desktop UI 验收仍以 `P0rv46` **274/274**（8 项 export 检查）为证，但这 8 项覆盖可见性、确认、零写入、成功字节/校验和、失败与重试，未检查来源谱系，因此不替修复后的载荷背书；B1 修复后的 Desktop 重跑在本机受远程桌面/屏幕捕获进程导致 CDP 截图/输入超时阻塞（共 8 次，均未到 export leg 且无 export 断言失败），已提交 `exportFileCarriesNoForeignWorkspaceAlias` 驱动守卫，待下次空载真实运行证明。
- headless 集成：本轮最终从仓库根运行完整 integration 矩阵 **958/958 PASS**，共 77 个场景，日志为 `.weir/decision-auto-router-final-integration.log`；其中 `decision-auto-route` **31/31**，并包含既有 `decision-hook`、`decision-consult`、`decision-batch`、`decision-route`、`decision-recovery`、`decision-feedback`、`decision-isolation`、`decision-ui-remote`、`decision-memory` 与 `decision-learning`，无回归。learning 场景的真实进程阶段（含一次 exact-PID SIGKILL）继续检查生命周期、DB/wire、对抗输入、恢复、预算、历史不可变和 P1/P2/schema-v1 兼容。
- 真实隔离 Desktop GUI：保留既有 A/B/C 与 P2 memory 验收；P3 主生命周期 run `8wkaN8` **18/18**，整改 run `Tc4Mks` **10/10**，覆盖手动整合、候选 diff/来源/结构重放、发布、只读 Attempt L2、回滚/拒绝、重启、>20 历史、correction/cross-root 来源及 exact-PID/端口清理。测试只启动独立临时 profile/进程，不操作用户当前 App 或其存储。
- 产品化 UIUX 整改的真实隔离 Desktop 验收 run `ykeSTg` **230/230 PASS**：147 张真实截图、2195 条原始网络 RPC、26 项视觉审计、29 组模态量测、20 个确认动作、17 类可见焦点转场、9 组 session 滚动量测、2 个冷加载展开与 3 组主从/钻取证据。覆盖中英文长状态/错误、light/dark、360/768/1440 CSS px、真实 `Emulation.setPageScaleFactor(2)`、键盘-only、AX/状态播报、全部确认类型、学习现场恢复、重启、设置/选择器/语言恢复与临时 Agent 归档。普通窄屏另以主区几何和命中测试验证宿主返回入口可用；运行时异常、console/Slot/Log/import 错误均为零，关闭期 socket stderr 单独保留分类。三次 owned main/Host 启动均精确停止并释放端口 9468。详见下节；早期 `TtHwww`、`SpbYkp` 与其他失败 run 仅作历史/非最终诊断。
- 候选编辑/删除的实施与门禁证据：`learning-store.test.js` 覆盖候选更新的 happy path（文字 + 范围）、增删语义、touched-only（未变化的父原则副本、父版本 retire 项与 draft 中 `state=retired` 的条目都被拒）、重复 id / 超限 / `remove` 与改写互斥 / 伪造 `sources`·`workspaces`·`state`、文字与 scope 越界、revision 与状态冲突、公共 zone 扫描，并断言每次失败后 `memory_snapshots` 行字节不变；`learning-review.test.js` 走真实 `learningStart → updateCandidate → snapshotPublish` 链路，断言发布版本携带用户措辞、被删条目不出现、`operations_json`/`replay_json` 与 run revision 不变，公共候选先拒绝对路径/外来记录 id 再接受提示且保持 workspace-agnostic；`broker-learning.test.js` 覆盖同构授权（跨 workspace 与 agentId 边界 + `boundary-reject` 审计）、`candidate-update` 审计字段且不含正文、编辑不调用模型、不自动发布，以及「编辑不要求 enabled、发布仍要求」；`remote-learning.test.js` 覆盖 bare-args 透传、根会话与 workspace 由 Host 派生（伪造 workspace 被覆盖）与封闭错误码；`audit.test.js` 覆盖审计投影只保留 zone/revision/计数并丢弃正文；`client-decision-learning.test.js` 覆盖可编辑投影（只有 draft + candidate 的 added/changed）、行级操作可见性（已发布版本无入口）、就地编辑器（当前内容、字数、路径/标签行、A/B/C 芯片、pending、`role="alert"`、超限禁用），以及发布确认的编辑计数只对同一候选生效；`client-decision-page.test.js` 覆盖保存载荷（只有 paths/tags/authorizationClasses，无 workspaces）→ 权威重读 → 编辑后内容回显、取消零写入、删除二次确认（取消零写入、确认后写入 `remove`）、冲突时先重读并保留草稿。最终门禁：Decision **727/727**、Weir 全包 **3868 pass / 0 fail / 1 既有平台跳过**（共 3869）、测试装置 **570/570**、`client.test.js` digest 与词典并集 **29/29**、checkJs `tsc --noEmit` exit 0、`build-client.js` 双跑后 34 个 chunk 摘要无 diff。
- 候选编辑/删除的真实隔离 Desktop 验收（task 6.1）run `gag9sK`：**305/305 check PASS**（175 张真实截图、1706 条原始网络 RPC、314 条只读权威直读、17 组历史不可变对比无改写、运行时异常/console/Slot/Log/import 全 0，六次 owned main/Host 启动均按精确 PID 停止且 9468 无监听）。链路是在既有 P3 学习现场上扩展的同一条真实流程（候选 v4 → 行级编辑 → 删除确认 → 发布 → 读回 → L2 → 已发布审阅）。8 项新增断言与其权威证据：`candidateEditShowsOnlyTheReviewedWording`（审阅只剩编辑后的措辞，未渲染模型原稿，2 条 added/changed 条目仍在）；`candidateEditPersistsWordingAndScopeOnlyInTheDraft`（draft revision 1→2，权威 `memorySnapshot` 读回 `authorizationClasses=[A]` 且工作区列表不变，未被编辑的条目字节不变）；`candidateEditLeavesTheLearningRunUntouched`（`learningRun` 的 `operations`/`replay`/revision 与编辑前完全一致，run revision 2→2）；`candidateRemovalDropsTheEntryFromAuthorityAndReview`（revision 2→3，权威候选只剩被编辑的那条，审阅不再列出被删 id）；`publishStatesTheReviewedEditsAsAFact`（发布确认出现 `[data-apply-user-edits]` 事实行「你编辑的: 1 · 你删除的: 1」）；`acceptedVersionCarriesTheReviewedWordingOnly`（发布版本 revision 4 只含编辑后文字，被删条目不在其中，成为 current）；`publishedVersionOffersNoEditOrRemoveEntry`（已发布审阅 0 个 edit/remove 入口且无就地编辑器）；`acceptedCandidateEditBecomesTheCurrentL2Guidance`（随后的真实判断 pin 到该 Snapshot rev 4，私有 L2 命中被编辑原则并把来源映射为真实 L5 evidence，Case `answered`）。审计文件证据：`.weir/audit.jsonl` 两条 `weir/decision/snapshot` `action:'candidate-update'`，字段只有 zone/`revisionBefore`/`revisionAfter`/edited/removed（1→2 edited=1、2→3 removed=1），不含原则正文、scope 或路径。该轮先暴露并修复了一个既有缺陷：发布/拒绝/回滚后的详情栏滚动从 739 被改成 705（reload 的第二次提交在 anchoring 规则已交还后才重排），见下一条。早期 `ZiFsuB`/`WWDPYV` 两次在既有 `uiuxModal:snapshotPublish-v1` 上失败（该检查在未修改的 lane base 上同样复现，属既有缺陷）与 `cGczdr`/`cEslB1`/`T2lSs`/`mtWEK5` 等定位过程中的失败 run 仅作非最终诊断保留。
- 学习/Snapshot 动作期间详情栏的滚动保持：偏移只在动作开始时捕获一次，`overflow-anchor: none` 与逐帧回钉持续覆盖整个动作，直到 pending 状态清除后的稳定帧才交还 inline anchoring 规则；新动作开始时接管现有 hold 而不是叠加第二个（否则会把 `none` 当作原值写回）。`client-decision-page.test.js` 钉住「提交帧回钉 → 同一动作的第二次提交不能拽走偏移 → 动作结束后按原值交还」，`uiuxModal:snapshotPublish-v1` 从 739→705 恢复为 739→739。
- 既有五项关键安全逻辑均有真实 mutation-red、字节恢复和 GREEN 证据。产品化 UX 的独立审查另行发现并修复了重复可写咨询卡、已有当前版本时的无变化误报、筛选/分页状态混用、文案降级和冲突重读问题；代码/组合独立审查已通过，真实 Desktop 证据与当前 App 部署验收分别记录，不以组件测试或 Slot 接线状态替代。

### P4 headless 与 mutation 实测（8.3–8.4）

以下结果来自 lane `decision-auto-headless-safety-315`，只使用 lane 内新建的 `WEIR_IT_ROOT`，不读取当前 App 的 Case。捆绑工具链固定为 `/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；headless 工作目录为 `plugins/weir-test-harness`，启动器固定为 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。每个独立运行使用 `.weir/it-roots/` 下的新目录；日志、`.exit-code` 与 `.counts.json` 均在 lane 的 `.weir/decision-auto-headless-safety/`，完整命令与文件索引见该目录的 `COMMANDS.md` 和 `INDEX.md`。

从 lane 仓库根实际执行的公共回归命令为：

```sh
NODE=/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
"$NODE" --test 'plugins/weir-test-harness/test/**/*.test.js'
"$NODE" --test 'plugins/weir-harness/test/decision/**/*.test.js'
```

8.3 最终实测为装置单测 **441/441**、Decision **415/415**；真实 headless `decision-auto-route` **27/27**、`decision-recovery` **8/8**、`decision-route` **5/5**、`decision-hook` **5/5**、`decision-consult` **5/5**、`decision-isolation` **4/4**，合计 **54/54**。每个场景的原始命令形如 `WEIR_IT_DSH_EXEC='<上述启动器>' WEIR_IT_ROOT='<lane>/.weir/it-roots/final-8.3-<run>' "$NODE" run.mjs <scenario>`；实际场景名、逐次根目录和退出码均由 `COMMANDS.md` 与 sidecar 固定。Auto 场景对照 SQLite、完整 Router pack、原生提问事件和审计；恢复场景另有 exact-PID SIGKILL、崩溃前后快照与重启 replay。Shadow 开关/三类失败、排除入口、混合批次、跨 Agent/workspace、无归属动作、fresh-root/显式 Off、flush/迟到写入均在这些真实运行中断言，未以 Desktop 结果替代。

8.4 对五个语义点分别执行一次最小 mutation，且在每次 RED 后从已保存 HEAD blob 字节恢复，再运行同一断言。公共 oracle 的实际命令分别是 `"$NODE" --test plugins/weir-harness/test/decision/{broker-auto,broker-shadow,broker-actions,router}.test.js` 中对应的单文件形式；恢复后的四项联合回归为 **49/49**。每项目录均含 `baseline.sha256`、`mutant.sha256`、`red.log/.exit-code/.counts.json`、`restored.sha256`、`byte-restore.exit-code` 与 `green.log/.exit-code/.counts.json`；`mutation/index.json` 逐项验证 baseline=restored、mutant 不同、RED 非零、恢复/GREEN 为零。

| # | 临时语义 mutant | 公共 oracle | RED → 恢复后 GREEN |
|---|---|---|---|
| 1 | Auto 绕过空白名单短路 | `broker-auto.test.js` | 9 PASS / 1 FAIL，exit 1 → 10/10，exit 0 |
| 2 | Router no-route/失败结果被改成候选并进入领域 Attempt | `broker-auto.test.js` | 9 PASS / 1 FAIL，exit 1 → 10/10，exit 0 |
| 3 | Shadow 写入真实 Case 归属/状态 | `broker-shadow.test.js` | 3 PASS / 5 FAIL，exit 1 → 8/8，exit 0 |
| 4 | 无归属回答写入合成 Agent Evidence | `broker-actions.test.js` | 11 PASS / 1 FAIL，exit 1 → 12/12，exit 0 |
| 5 | 跨 workspace 候选进入 Router pack | `router.test.js` | 16 PASS / 3 FAIL，exit 1 → 19/19，exit 0 |

五项控制恢复后的生产源码 sha256 均与各自 HEAD 基线一致，`cmp` 字节比较均为 0；没有修改测试断言来迁就 mutant，也没有合并 mutation。无归属 Evidence 的第一次脚本锚点因两个相同调用点而在写入前拒绝，该次未变更运行不计数，原日志保留在 `04-unowned-evidence/uncounted-*`；随后仅修改 `transition()` 的第一次调用点并完成上述计数控制。

### P4 真实隔离 Desktop 实测（9.2–9.3）

以下结果来自 lane `decision-auto-desktop-acceptance-317` 的同一次真实 Electron/Desktop 运行，不是 headless、组件测试或多次部分 PASS 的拼接。候选提交为 `731f7d39069bffb9f8e5b426baaaaebce76f5566`；实际命令为：

```sh
WEIR_DECISION_PRODUCT_PORT=9468 /Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node plugins/weir-test-harness/spikes/decision/gui-product.mjs
```

运行 `JJFXjr` 的最终 `result.json` 为 **164/164 PASS**，保存 **82** 张真实 PNG、**2140** 条原始网络 RPC、**268** 条只读权威 RPC、**18** 项视觉审计、**11** 组完整目标子树 Accessibility 证据和 **283** 组原生键盘交互。证据根为 `.weir/decision-product-ux/run-JJFXjr/`，报告为 `evidence-zh.md`；独立复核 `independent-audit-v2.json` 与人工截图复核 `visual-review.md` 均通过。

最终合并候选 `6bab649ac949f6d6b497d9c8b7d5b1e27d0b8df5` 又以同一真实隔离 Desktop 命令完成复验 `QVAaW8`：**164/164 PASS**，82 张 PNG、2133 条网络 RPC、266 条权威直读、18 项视觉审计、11 组 AX 与 283 组键盘交互；运行时错误为零，历史/SQLite/读模型/路由计数不变量与已审查 `JJFXjr` 一致，三组 owned PID 均停止且端口 9468 已释放。证据位于 `.weir/decision-product-ux/run-QVAaW8/`，`final-candidate-comparison.json` 保存新 run 的 SHA-256、已审查证据 hash 重算和逐项对照，全部通过。

- 功能矩阵覆盖 Off/Auto/指定 Agent、fresh-root 默认 Auto、resume/legacy 无行 Off、Shadow 开关对照、空白名单与允许 A、真实 stock Hook 缺类分类、显式咨询优先、零/一/多候选、歧义/非法输出/超时、审批/plan-review/高风险/执行授权原生旁路、无归属回答/改派/取消、路由复盘与 20 条追加分页，以及 owned SIGKILL 后的中断恢复。`stock-classification-proof.json` 同时保留 pre-Hook stock 调用、持久 Session tool/call 和分类/Router wire；原始 stock 参数没有 `authorizationClass` 或 `authorizationClassSource`，分类器派生 A 而非测试注入，跨 workspace 私有 Profile 未进入 Router pack。
- `sqlite-read-model-comparison.json` 的原始 RPC 参数、响应、SQLite 与读模型对照无差异；`immutable-history.json` 从学习生命周期到 `final-stopped` 没有 Attempt、Snapshot 内容或 RouteDecision 改写/消失。最终停止后的 SQLite 独立复核为 `integrity_check=ok`、`user_version=1`，含 31 条 Auto、1 条 Shadow、1 条 manual_reassign、9 条 pinned 与 1 条 explicit 路由；无归属 Case 的 Attempt/Evidence 均为零。
- 视觉覆盖 360/768/1440 CSS px、light/dark 和真实 mobile-emulated 200%（例如 CSS width 360、visual width 180、scale 2）；原生 Tab/Shift+Tab/Arrow/Enter/Space/char/Input.insertText 记录包含实际 activeElement、accessible name 与焦点返回。选择面板含 checked Auto radio，真实 multi-select stock 提问含命名 region、未命名 group 和两个有名称的 checkbox，路由状态为 `aria-live=polite`。异常、console error、Slot crash、Log error 与 import failure 均为零。
- 三个临时 Agent 均经真实 `profileSetState` 归档；设置恢复为 timeout 150 ms、Shadow=false、白名单 `[]`，测试自有选择器恢复且 legacy 会话仍无 selector 行。三个 owned main/Host PID 对 `75553/75592`、`92392/92433`、`92905/92943` 均已停止，端口 9468 无监听；三次启动的 HOME/DSH_HOME/profile/Electron 根均位于本 run 新建隔离目录，未访问当前 App 的记录。

本 Desktop 批次的公共门禁为 driver **41/41**、GUI-enabled decision brain **71/71**、完整测试装置 **453/453**。RED/GREEN 与完整门禁日志位于 `.weir/decision-auto-desktop-acceptance/ax-full-subtree/` 和 `ax-native-multi-select/`。早期失败运行均保留为非最终诊断，未改写为 PASS；独立审计初版 `independent-audit.json` 也因视觉谓词错误保留，后续单独生成的 v2 只修正该审计谓词并重算未更改的原始视觉证据。

### 产品化 UIUX 整改实测

最终候选使用与既有 Desktop 驱动相同的隔离方式，从 lane 根目录执行：

```sh
WEIR_DECISION_PRODUCT_PORT=9468 \
WEIR_DECISION_PRODUCT_EVIDENCE_ROOT="$PWD/.weir/decision-uiux-save-focus" \
/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node \
  plugins/weir-test-harness/spikes/decision/gui-product.mjs
```

- 最终焦点修复 HEAD `ec937ec91fe63a67fd947bc196c4525470011176` 的 run `ykeSTg` 为完整 **230/230 PASS**，不是预检、组件测试或多次部分运行的拼接。原始结果/截图/AX/键盘/运行时记录位于 `.weir/decision-uiux-save-focus/run-ykeSTg/`，逐项焦点索引为 `14-final-evidence-index.json`，独立清理凭证为 `15-independent-cleanup.json`。
- 选择器覆盖少量/多个助手、长名称、空白与允许两类、未知状态、读取/保存失败及 pending；中英文长错误内容在真实产品中自然换行，固定头尾、重试和管理操作保持可达，并有 AX/键盘证据。取消、放弃编辑、助手停用/启用/归档和 Snapshot 发布/拒绝/回滚均逐一验证 `:modal`、全视口 backdrop、背景 inert、wheel/touch/PageDown 滚动尝试及结算后焦点。
- 普通关闭保持精确滚动位置。Snapshot 发布用实际打开前 `372`、锁定期间 `372` 证明无背景位移；权威发布删除候选后页面缩至 900px，恢复到合法边界 `0` 并聚焦主导航，不保留伪造空白。该边界契约已经用户明确确认。
- 发布/回滚/忽略之后的**详情面板偏移**另有一条契约：该动作重读助手时会替换候选审阅卡，浏览器滚动锚定会把面板重定位（真机测得 `scrollTop 690 → 446`，而内容高度还在变高，52 个存活节点中 0 个保持原位）。现在**成功与失败**两条重读路径都走 `preserveDetailScroll`（失败时仍会重读一次并以错误提醒呈现，因此同样需要保持）；面板缺席时该保持是空操作：先捕获面板偏移并对该面板禁用滚动锚定，重读期间重断言一次（回复层叠弹窗会回写自己的锚定规则），权威内容提交后的下一帧按新范围 clamp 回写，再逐位恢复内联样式；实测 `690 → 690`、卡片/分区屏幕位置 0 位移、无样式残留，隔离桌面探针对比组（去掉那一帧）会回到 `690 → 758`，证明该帧是必需的。Desktop 全量矩阵 `run-kwkUFV` 为 **242/242 PASS**。
- 冷错误和冷成功都在首个 settled 内容布局后各定位一次到实际末尾，保留输入焦点和草稿，后续刷新不重复。桌面主从、窄屏返回及同目标学习 Run/Snapshot 恢复均无额外权威重读；17 类创建/编辑/学习/保存/非脏关闭转场均落在 connected、可见且逻辑明确的目标，不再丢到 body。
- 中英文与明暗主题覆盖 360/768/1440；真实 200% 时 visual width 分别为 180/384/720 CSS px。普通 360 的主区/标题/导航/卡片/操作有几何与命中测试，宿主返回入口保持可用。9 组 session 证据明确记录与 composer 同一真实滚动元素的 alias、锁定/恢复及 wheel/touch/PageDown 尝试，不再静默省略；截图经人工复核。
- 本轮焦点修复候选的公共门禁为完整 Decision **536/536**、Desktop driver **77/77**、Client digest contract **28/28** 与 checkJs PASS；Client 保持 **33** 个 chunks。
lane 内全 Weir 为 **3647 PASS / 0 FAIL / 1 既有平台跳过**，测试装置 **489/489**。早期失败/探索 run 均保留为非最终证据，未用来拼凑完成结论；最终 main 门禁与候选复跑由后续交付门禁另行记录。


#### 卡片不随回合折叠消失（真实隔离 Desktop 实测）

同一驱动新增的验收在真实隔离 profile 内把「工作视图」经真实「设置 → 通用设置 → 工作步骤展示」改成精简（读回 `标准 → 简洁`，用例结束时恢复为 `标准`），再对两条路径各跑一遍折叠/展开往返。最终 run `7qwm4P` 为 **262/262 PASS**（基线 242 项全部保留），**153** 张真实截图、1526 条原始网络 RPC。

- 折叠可见性：回合结束后整轮过程披露处于关闭态（`button[data-turn-process]` `aria-expanded=false` 且可折叠、`[data-step-process]` 根节点 `hidden="until-found"`），决策卡仍然 `count=1`、`inProcess=false`（不在任何 `[data-step-process]` 内，座位上的 `data-chat-turn` 与整轮控件编号一致）、真实可见可读；`consultCardVisibleWithProcessFolded` 与 `nativeCardVisibleWithProcessFolded` 同时覆盖显式咨询与原生提问。
- 唯一性：展开整轮披露与组内 `button[data-process-activity]` 表头后，同一 Case 的全文档 `[data-weir-decision-card]` 计数仍为 1（`consultCardUniqueWithProcessExpanded` / `nativeCardUniqueWithProcessExpanded`），再折叠回去后计数与卡片文本都与展开前一致（`*CardSurvivesFoldRoundTrip`），即不重复、不重挂、不丢失。
- 工具槽位让位：让位后的调用行保留 `call:` 滚动锚点但 `rowHeight=0`、无文本，槽位锚点是 `display: contents` 的空容器（`consultDecisionToolRowRendersNothing` / `consultYieldedToolRowKeepsAnchorOnly`）。真机测得该行自身盒高 0、`margin-top: 0px`，本条变更接受这点零高度占位，不做补偿。
- 原生路径同时修掉既有重复：展开过程披露后不再出现第二张同一 Case 的卡（这正是本次变更顺带消除的缺陷）。

### 决策助手设置页与助手编辑器的真实验收（settings-page 4.3 / 5.3）

同一驱动（`plugins/weir-test-harness/spikes/decision/gui-product.mjs`）不再从 Weir 主页面的文本与旧输入框取证，而是走真机的第三分区：

- 导航账本先证明三个 Weir 分区都注册且顺序为 `Weir` → `Weir 模型路由` → `决策助手`，导航后以 `[data-group="decisionBasics"]` 为就绪信号（不再依赖任何页面正文）。
- 页面结构断言：基本组恰好三行（总开关 → 新根会话默认选择的两段控件 → A/B/C 芯片），高级组默认 `aria-expanded=false` 且 `[data-advanced-body]` 不挂载；展开后七行可编辑（Attempt 超时输入在前、`Auto Shadow 诊断` 开关在后，值对权威配置）；键入超时只进草稿（保存条出现），放弃后回到权威值；总开关关闭时高级组连同折叠标题消失、基本组只剩总开关一行，恢复后两组回归且表单回到未脏状态；关闭后以分组/芯片/折叠/编辑器均不存在为断言。
- 白名单芯片切换后权威 `decisionAgentAutoAnswerClasses` 等于所选且按 A/B/C 行序；助手编辑器的专长范围与模型路由以可视化控件保存并读回（路径/标签/芯片顺序、路由档位 provider 与目录模型名往返一致），且高级区不存在 `data-agent-field="scope"|"modelRoute"` 文本域。
- 共享模型选择器（`lib/client.model-picker.js`）的六条字符串（`modelEmpty`/`pickerModel`/`pickerEffort`/`catalogLoading`/`catalogFailed`/`effortProviderDefault`）原先只存在于设置页命名空间，助手编辑器绑定 `settings.weir.decision`，真机因此渲染原始键名；本批把这六条按字节相同的跨命名空间副本登记进决策词典（`client.test.js` 词典并集表登记），由 `assistantRoutePickerRendersLocalizedStrings` 守住。
- 最终接受 run `B4RljA`：**295/295 check PASS**（166 张真实截图、1640 条原始网络 RPC，端口 9468），运行时异常/console/Slot/Log/import 错误均为 0，六次 owned main/Host 启动（`process-1..3` 与 `cross-legacy-boot/restart`、`cross-workspace-final`）均按精确 PID 停止且 9468 无监听。结构、芯片、选择器与助手字段的证据分别为 `settings-structure.json`、`settings-classes-*.json`、`assistant-visual-picker.json`、`assistant-visual-readback.json`（权威读回 `scope.paths=[plugins/weir-harness/lib]`、`tags=[decision-settings]`、`authorizationClasses=[A,B]`、`modelRoute.chain=[{mock, mock-1}]`）。更早的 `run-S0E51i`（调试中主动终止）与 `run-XkA1hI`（既有 `uiuxModal:selector-zoom200-360` 滚动锁审计偶发失败，非本批断言语义）仅作非最终诊断保留。
