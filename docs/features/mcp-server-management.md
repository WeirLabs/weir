# MCP server 管理

> 在一个管理面里安全地添加、编辑、探测、重启、删除和导入 MCP server，同时保持「安装」「本会话启用」「新会话默认启用」彼此独立。

## 概述

Weir 的 MCP 管理面以注册表为唯一配置权威，覆盖官方 `stdio` 与 `streamable-http` 两种 transport。面板、用户命令和 AI 安装共用同一组 Host operations；只有真实 strict mount 才算成功，fiber ready、进程启动或工具 schema 存在都不能冒充连接健康。

管理操作不静默扩大权限：安装不会自动 Select、Apply 或设置默认值。每个注册还有独立 `incarnation` 与递增 `generation`，用于区分「同一个逻辑 server 的编辑/重启」与「删除后重新创建的另一个注册」。

## 用户可见行为

### 生命周期与真实库存

- MCP 页签提供 Add、Edit、Test、Restart、Remove、Select for this session 和 Default on/off。Unmanaged server 只读展示；本轮不提供 adoption、禁用宿主条目或把 conflict 写成 managed 成功。
- 每行展示 label、逻辑 identity、公开 `serverName`、transport、`incarnation`、`generation`、默认状态、严格 mount 状态、已知 discovery、最近一次 mount/test 结果和脱敏诊断。仅当配置含 `deferLoading:true` 时额外显示 `deferred` 标签；该标签只回显配置，不表示模型已发现工具、路由已支持延迟加载或已节省 token。
- 状态区分 `unknown`、`registered`、`mounted`、`degraded`、`cleanup-failed`、`cleanup-unknown` 与 `conflict`。`mounted` 只表示可核实的严格挂载/readback 结果，不是实时 reconnect 健康证明。
- stock client 没有提供的 reconnect 相位、进程退出码和 stderr 一律显示 `unknown`，不从工具数量猜「当前在线」。打开或刷新清单只读取状态，不自动 probe、不唤醒 Agent、不写会话日志。
- 清单读取失败时保留 last-good 非秘密内容并标为 stale；注册表不可读与健康的空清单不同。初始 `absent` 注册表是合法空库存。

### Add/Edit 与秘密字段

- Basic/Advanced 表单按 transport 校验字段：`stdio` 的 command、args、env、cwd；HTTP 的 URL、headers；两者共用的 `serverName`、`toolCallTimeoutMs`、`maxInstructionBytes` 和 reconnect 设置。
- Add/Edit 的 Advanced 提供可访问的 **Defer tool definitions** 复选框，新添加与 legacy 记录默认不勾选。辅助说明只承诺支持的模型会在需要时加载完整工具定义，权限与工具调用保持不变。草稿经 Preview 到 Confirm 始终在配置顶层携带布尔 `deferLoading`：启用项的无关编辑保持 `true`，显式取消勾选发送 `false` 以关闭；该配置编辑不自动 Select 或 Apply。
- Host mutation 与 JSON 输入接受受管 server 顶层的布尔 `deferLoading`：缺省、legacy 缺失和 `false` 都不启用；仅显式 `true` 写入 registry metadata，关闭时删除字段。该扩展不进入 `entry.client` 或 stock `dsh-mcp-client` Loader config。
- 秘密行支持 **blank-keep / replace / remove**。已有值只显示 configured 状态与 ref，不回显；blank 保持原 ref，replace 写入新值或新 ref，remove 仅删除该配置引用。秘密替换值只保存在组件内存，关闭或成功后清除；失败保留非秘密草稿，替换秘密被清除以便重新输入。
- 新的 env/header/秘密 argv/敏感 URL 值通过 DSH credentials 保存。注册表只保留 `secretRefs`；legacy literal 记录仍可读，但新载荷不返回那些字面值。
- 任意带 userinfo、query 或 fragment 的 URL 都视为敏感，整个 URL 必须来自 credential ref，不能按参数名猜哪些 URL 安全。凭据轮换在下一次显式 probe/restart 生效，不声称实时轮换或实时重连。
- credentials 或经验证的 ephemeral Loader 不可用时，含秘密的新增/编辑/probe/mount 明确 `unsupported`；无秘密且满足 strict 生命周期的管理仍可继续。不会退而把秘密写入 profile。

### JSON 预览与批量结果

- Paste JSON 接受单 server object 或标准 `mcpServers` 文档。表单与 JSON 共用 Host preview，先返回规范化、脱敏 plan 和 digest，再由用户确认；preview 不启动进程、不联网、不写凭据/注册表、不改选择。
- 批量执行**不是原子事务**：每项都按 staged credential → probe → CAS 顺序执行，并使用执行时的当前 registry revision 与目标 fingerprint。前一项自己的提交不会误伤后一项；外部修改目标会产生冲突。entry-local 失败之后，安全的后续项继续。
- 只有 `mounted` 是该项成功；`saved-degraded` 是 `failed + saved:true`。`not-attempted` 仅用于 owner 丢失、注册表不可读等 batch-scope abort。结果逐项显示 saved/not-attempted/retry/edit，不宣称整批成功或回滚。
- Portable capability preset 仍只携带逻辑 binding identity/label，不是可执行 MCP 配置格式；JSON 导入不会改写 portable preset 或任何会话选择。

### Default、Select 与 Apply

- **Select for this session** 只修改本地草稿；随后仍需显式 Apply。安装、编辑、测试、重启、删除都不会代替这一步。
- **工具 schema 与 accepted set 同步**：安装或重连发现新工具不会把它们注入未启用的 live 会话；Select 后完成 Apply 才会显示。当前 agent 在启用、禁用或再次启用 Apply 后的下一次模型请求立即反映工具增减，无需重建会话。历史消息与模型记住的旧工具名不会因此被擦除，调用仍由 admission 门禁独立拦截。
- **Default for new sessions** 是独立设置，只影响之后且没有工作区默认的会话；它不改变当前草稿、当前 accepted set 或已有显式选择。Edit/Restart 保留 default；Remove 在同一 registry mutation 中删除 default 并报告 `defaultRemoved`，不改写 accepted/draft 或 saved workspace-default。
- Apply preparation 拒绝当时未注册或 unmanaged 的 identity，保留旧 accepted set 和用户草稿。注册表与选择是独立存储：准备后并发 Remove 可产生 rejected Apply 或 committed-but-missing selection，但门禁始终拒绝已删除 identity。

### AI 安装入口

- 主 Orchestrator 可使用 `mcp_install` 的 `action:'preview'|'install'`；delegated child 看不到该工具，执行时也会被拒绝并被引导回父 Orchestrator。
- Preview 返回有界脱敏 plan、digest、target/namespace conflict 与 capabilities，零副作用。Install 只接受 fresh identity 和 credential refs，不接受 literal secrets，也没有 `confirmed` 参数。
- Host 确认卡展示实际 plan/digest 与进程或网络效果。只有恰好一个批准选项且无 custom answer 才批准；聊天同意、模型标志、额外选择和自定义文本都不授权。
- 批准后先 probe，成功才可 CAS + strict mount；失败 probe 不注册。结果返回实际 identity/incarnation/generation/discovery 和 `select-and-apply` 下一步，仍不设置 default 或任何 session selection。
- 英文 bundled skill `mcp-server-setup` 提供资料检索、refs-only 计划、确认与结果解释指引。窄 `mcp-server-setup` intent 只注入技能指针，不执行安装；真实的中英文安装/配置请求可命中，调用/讨论已有 server、否定句、一般讨论、引用或代码示例不命中。

## 配置

本特性没有新增 volatile config。运行配置保存在 Weir profile 的 MCP registry；每个 server 使用规范化记录，旧 stdio 记录无需自动迁移。

### Server 字段与秘密形状

| 字段 | 含义 |
|---|---|
| `identity` / `label` / `owner` | 稳定逻辑身份、显示名与所有者；新 add/re-add 生成新的 `incarnation` |
| `incarnation` / `generation` | 注册 incarnation 与配置代次；edit/restart 保留 incarnation 并递增 generation |
| `transport` | `{ kind:'stdio'|'streamable-http', ref:<非敏感来源说明> }` |
| `client` | 官方配置白名单；Weir 强制 `failOnStartupError:true`，这不是用户开关 |
| `deferLoading` | 可选的 Weir-owned 布尔元数据；仅 `true` 落盘，默认/旧记录/`false` 均无字段，不改变授权 |
| `secretRefs.env` / `headers` / `args` / `url` | 各字段的 `{ref,prefix?}`；秘密 argv 按参数 index 记录 |
| `enabled` | 去重后的新会话默认 identity 集合；stale identity 读取为 missing warning |

新命令和 AI 只接受 refs；UI 的原值只经独立 mutation remote 到达 Host 内存。legacy `/capabilities mcp-add` 仍兼容 literal env，但返回真实 strict outcome 和 `legacy-literal-secrets-in-command-history` 警告；新命令不接受 literal secret。

### 输入边界

| 边界 | 上限 |
|---|---|
| 原始 JSON | 1 MiB，先查 UTF-8 字节再解析 |
| 每批 server | 32 |
| 每台 argv | 128 |
| 每台 env / headers | 各 64 |
| 序列化 plan | 256 KiB |
| discovery 名称预览 | 20 个，附 truncated |
| 单条诊断 | 8 KiB，沿最多 6 层 sanitized cause 提取 |

超限在任何 process/network/credential/registry/selection 副作用之前拒绝。未知 transport、跨 transport 字段、未知 executable option、非布尔 `deferLoading` 和非法 reconnect 区间同样预检拒绝，错误点名具体字段。严格初始发现零工具是成功，不需要额外的 startup-failure-policy 开关。

## 设计细节

### 一条共享 operation 管线

`mcp-operations.js` 统一执行：

1. 完整 parse/normalize/redact preview，核对输入边界；
2. 校验 session preset/cwd/profile/feed ownership、credentials 与 ephemeral 支持；
3. 按 attempt 分配含随机 ID 的 credential refs，并暂存新秘密；
4. 按操作执行 bounded probe（AI、batch 的每个条目与手动 Test 必须先成功）；
5. CAS 前重读 registry，核对当前 revision、target fingerprint、identity 与 `serverName` 保留，并再次校验 ownership，随后才 register/remove/setDefault；
6. 严格 targeted mount、registry/generation/incarnation readback，最后才开放准入。

Add/Edit 可先保存再 mount，因此保存成功但 mount 失败返回 `saved-degraded`。结果同时保留 saved、registryRevision、mount、discovery 和下一步；`owner-changed` 或 `indeterminate` 不宣称回滚或零副作用。批量复用同一管线，UI、命令与 remote 的状态分类一致。

操作顺序由每个 manager 独有的 `mcp-operation-coordinator.js` 统一拥有：per-identity FIFO、runtime fence/token 与 admission drain transition 不再分散在 runtime、manager 与 operations。startup、recovery、adoption、remove、reconcile 与 Add/Edit/Restart/Remove/live-target Test 共用该顺序；fresh add-mode Test 仍是 probe-only 例外。公开 manager face 仍是可变 plain object，`beginOperation`、`abortOperation`、`reconcileOne`、`serialize` 保持可用，管理探针仍可 monkey-patch `reconcileOne`。每个受管操作在首次异步 registry/credential/probe 步骤前同步关闸；stale token 不得报告 mounted 或重新开门，失败不得毒化该 identity 的后续队列，不同 identity 独立调度。

`mcpIncarnations` 随 Apply、revision-0 initial selection、preload、fork/child inheritance 与 cold read 透传。只有 legacy selection 与 legacy registry entry 都没有 incarnation 时才走旧 identity 兼容规则；下一次显式 Apply 记录当前映射。

### MCP Inventory Projection

`mcp-inventory.js` 是唯一的真实只读库存投影：在同一个 Loader join 上合并 registry、runtime、mount、mount/test receipts、discovery 与诊断，供真实 `manager.list()` 使用。公开的 `partitionMcpRows(rows, mounted, registryServers)` 保留为兼容适配器，返回形状仍是 `{ managed, unmanaged }`，包括 managed 分支字段；它不是另一套业务库存实现。

`mounted` 仍要求 runtime phase、registry generation 与 mount generation 的严格匹配；registry 只有记录时不伪造 mounted discovery。`absent` 是健康空库存，损坏/不可读则保留显式 `unavailable`。managed/unmanaged 字段、redaction、fingerprint、bounded diagnostics、unmanaged `readOnly` 与未知 `liveReconnect`/`processExit`/`stderr` 全部保留。打开、刷新或重复读取清单不会 probe、挂载、唤醒/恢复 agent、写 registry/selection/credentials、写会话日志或触发隐藏收敛。

### Mount Attempt Ownership 与 revision-scoped namespace

每次 managed mount/probe 都有独立的 Mount Attempt Ownership。稳定 logical identity 用于注册、选择和准入；actual groupId 只用于 Loader/facade 对账。首次活跃挂载保留 legacy `weir-mcp-<identity>`，并发 attempt 使用不同的内部 actual groupId；identity、generation、incarnation、公开 `serverName`、模型可见工具名、manager face 与结果形状不变，内部 owner 不进入公开回执、库存、工具结果或持久化选择。

分配在 `tree.create` 前的同一同步 JavaScript turn 内完成 check-and-claim。同组重复 bridge 注册会拒绝而不是覆盖；清理等待既有 Disposal Barrier，随后按捕获记录精确 compare-delete，stale/重复 release 为空操作。create、disposal 或 recovery 未结算时禁止复用 actual groupId；`cleanup-failed` 与 `cleanup-unknown` 保留 ownership，不能用超时本身推断已经消失。

retained revision 的 client 挂到所属 revision 的 scoped、non-writing `PresetTree`，所以相同公开 `serverName` 与工具名可在 old/new scope 中独立存在，profile 配置保持不写入。bare composition 只保留此前支持的 secret-free fallback；显式 scoped tree 不可用或形状不满足时 fail closed，不回退共享 root。create/remove、entries/store、readiness、readback、fiber lookup、listing 与 disposal 全部使用同一个 scoped tree。

库存与 residue 按 own exact mount → live allocation → facade child config → true legacy 的优先级解析 actual group。多个同 identity group 不再互相覆盖；foreign active mount 不会成为调用 revision 的 mounted 事实或被其 sweep，无法解析的后缀残留不会伪造 registry、discovery 或健康事实。独立 mount Disposal Barrier 不与 manager Operation Coordination 合并。

### 秘密 containment 与补偿

- 只有运行时 canary 证明 `loader.root` 或所属 revision 的 scoped `PresetTree` 支持动态 group/facade、scope 隔离且 profile cordis 零写入时，物化秘密才能进入对应 non-writing tree。其他结构返回 `unsupported`，绝不使用 write-through Include tree 兜底。
- Weir-owned ref 形如 `WEIR_MCP_<identityHash>_G<generation>_<attemptRandomHex>_<fieldHash>`，并发编辑不共享补偿目标。
- 仅在 proven-uncommitted 且 registry reread 证明 ref 未使用时清理本 attempt refs。异常或丢失响应无法证明提交结果时返回 `indeterminate`、保留 refs，并按实际 registry 对账。
- 不删除用户提供的 refs，不做旧 generation/orphan credential 自动 GC。本地 credentials 避免配置/transcript 泄露，但不是同 UID Agent 的隔离边界。

### Strict readiness、disposal 与准入

Managed mount 和 probe 都强制 strict。startup timeout、连接失败或 discovery 失败不会被 fiber-ready 假象掩盖。probe 使用唯一临时 identity/serverName、禁用 reconnect，并在 finally 中等待真实清理。

删除、重启、替换、probe 和 residue recovery 捕获 group/client/descendant 的实际 `fiber.dispose()` 结算；`loader.remove()` 返回本身不算 disposal barrier。延迟/拒绝/无法确认 transport close 分别产生 `cleanup-failed` 或 `cleanup-unknown`，并提供 residue recovery，而不是立即启动同名 replacement 或宣称 clean。

每个 identity 都有同步 runtime phase 和 `{identity,generation,incarnation,operationId}` permit。操作在任何 await 前关闭新旧 generation 与 drain entry；准入在 registry read 后及 transport handoff 前再次复核。旧 transport 已接收的调用可按既有 running-operation 边界结束，替换完成前的新调用一律拒绝。启动全量 mount 与运行期 add/edit/restart/remove 共用 `reconcileOne`，不重挂 sibling；公开 owner 仍保持 `{identity,generation}` 形状，内部则按具体 mount attempt 精确清理 public tool facts 与限制。

**mount 的 Disposal Barrier 保持独立。** manager 的 Operation Coordination 决定操作顺序，`createMcpMount` 内部的 per-identity FIFO 仍单独保证：同名 replacement 必须等旧挂载的异步 disposal 真正结束。两层职责不合并，避免 manager→mount 的非重入嵌套死锁，也不削弱直接调用 mount 模块时的清理保障。

工具可见性由 live agent 维度的差分控制器维护：每个实际 agent 与 public tool name 只保留一条必要的 deny disposer。初次发现、重连/动态注册与注销、runtime phase 转换、initial selection 以及普通/恢复 Apply 都会按当前 accepted snapshot 收敛；`mounted` 才释放 mount 期间对 selected agent 的临时隐藏。Apply 在 lifecycle 发布后、响应前只同步目标 session，注册与 runtime 变化才逐个同步 live agents。旧 generation 的延迟 disposer 不能清除新 generation 的 facts 或限制，agent disposal 也只清理该 agent 自己持有的限制。

### 延迟工具定义（Host）

受管 server 显式设置 `deferLoading:true` 后，manager 将该值经 strict mount 只传给 facade；facade 在既有 admission wrapper 之后为本次 discovery generation 注册的每个工具定义附加 DSH 原生 `deferLoading:true`。缺省、旧记录或关闭时不添加标记。stock client 配置、公开 `serverName`、identity/incarnation/generation、onRegister/onUnregister 与 execute 内 admission/drain 顺序保持原状。

开关编辑、Restart、重连后的动态注册和 retained revision 都从各自 registry entry 取得配置，并沿用同一严格替换、disposal/readiness 路径；readiness 前准入仍关闭，成功后保留 identity、incarnation 和 accepted selection，无需重新 Select/Apply。该设置只改变支持路由呈现完整定义的时机，不选择未选 server、不扩大子代理继承，也不让模型记住的历史工具名绕过门禁。

定义加载与不支持的路由回退由 DSH/provider 原生机制负责，Weir 不新增搜索协议。仅 Weir 管理的 MCP server 受此配置约束；unmanaged server 与 Weir/DSH 内置工具不变。配置或请求标记不构成模型已成功发现、真实调用或 token 节省的证据；本地计数与结果证据见 [工具使用观测](tool-usage-observability.md)。

### Host/UI/命令线协议

读取继续使用 `weirCapabilities`；MCP mutation 使用独立 service `weirCapabilityMutation` 与 namespace `weirCapabilityMutations`：

| 方法 | HTTP endpoint | 参数 |
|---|---|---|
| `mutate` | `POST /api/weirCapabilityMutations/mutate` | `{ sessionId, request }`；preview 或单条 add/edit/remove/restart/test/setDefault/installFromAgent |
| `batch` | `POST /api/weirCapabilityMutations/batch` | `{ sessionId, request }`；单条或 `mcpServers` 批量 preview/执行 |

Client 原始 gateway envelope 为 `{ args:{ sessionId, request } }`，返回 RemoteResult `{ok:true,value}` 或 `{ok:false,error}`。mutation ownership 比较 preset/cwd/profile/feed，不比较 selectionSeq，因此同 owner 的无关 Apply 可在 probe 期间完成。所有 read/mutation 端点逐一自愈；不能由 receipt 存活推断写端点存活。秘密不进入 session command 或 tool event，审计走 `capability-mcp` 冷安全通道，绝不追加自定义 session event。

`/capabilities` 的 MCP verbs 转调同一 operations：`mcp-preview`、`mcp-add`（legacy）、`mcp-batch`、`mcp-edit`、`mcp-remove`、`mcp-restart`、`mcp-test`、`mcp-default`。命令与 UI 的 conflict/saved-degraded/cleanup/unsupported/indeterminate 分类一致；domain failure 不包装成 `kind:'success'`。

### AI 的 stored-plan 授权

Host 在内存保存规范化执行 entry、显示 plan、entry fingerprint、registry revision 与 digest。`userQuestions.ask` 使用同一个 tool-signal/五分钟合并 AbortSignal；只有首个 settlement 可继续，timer 在 finally 清理。close、cancel、timeout、NO_PROVIDER、CALLER_NOT_LIVE、DELEGATED_CALLER 或拒绝都在 probe 前结束。

回答后执行的是 **stored plan**，不是模型再次提交的内容。Host 复核 display digest、entry fingerprint、精确 live root、preset/profile/feed ownership、registry revision、identity absence 和 namespace reservation；任何变化都要求新 preview/conflict，不 probe、不写。之后的 mutation service 在 credential/probe/CAS/mount 各阶段继续复核 ownership。

Intent 的 Skill 资格要求显式 `verdict.invocable === true`；未选择、不可用、非模型可调用、provider/view 缺失或构造失败都 suppress 且保持 unarmed。否定/讨论抑制也作用于 semantic catalog，防止语义分类把明确排除的 MCP setup 重新命中。审计仍为冷安全 cordis + JSONL 双写。

### 客户端恢复与可访问性

`client.mcp-manager.js` 是独立 lazy chunk 和 error boundary；MCP-only 加载/渲染失败不会让 composer Badge 或 Skills/Presets 控件消失。表单 preview/result 分离，错误靠近字段，pending 禁止重复提交，响应不打印秘密或原始 Error。

Remove 与 public namespace change 使用键盘可操作的确认交互；Cancel/Escape 恢复来源按钮焦点，Tab 在确认按钮间循环。批量确认说明逐项、非原子结果。新 chunk 由 `scripts/build-client.js` 校验并写入 `lib/client.js` 的 sha256 manifest。

GUI 启动环境 PATH 通过既有 `resolveExecutable`/`spawnArgv`/`childEnvironment` 处理，保留 Node 与 Windows SystemRoot/ComSpec；LSP 旧错误文本默认不变，MCP 使用自己的 subject/setting。

## 边界与失败语义

| 状态 | 确切含义与恢复 |
|---|---|
| `mounted` | 严格 mount/readback 成功；只有它算 operation 成功 |
| `saved-degraded` | 配置已保存（`saved:true`）但 mount 失败，准入保持 closed；Edit/Test/Restart 修复 |
| `revision-conflict` / `conflict` | revision、目标 fingerprint、identity 或 namespace 冲突；重新 preview，不覆盖外部修改 |
| `probe-failed` | 未提交的连接/discovery 失败，不注册；清理后编辑重试 |
| `unsupported` | 缺 credentials、userQuestions 或经验证的 ephemeral Loader；只禁用受影响路径 |
| `cleanup-failed` / `cleanup-unknown` | 清理拒绝或关闭无法确认；先恢复 residue，不立即同名替换 |
| `owner-changed` | 当前 preset/profile/feed 已变；保留实际 saved/generation/incarnation/revision 事实 |
| `indeterminate` | 无法证明写结果；保留 credential refs，重读实际 registry，不伪造回滚 |
| `cancelled` | 未获精确批准、关闭、超时或 tool-signal 中止；未 probe/写入 |

其他硬边界：

- Remove/re-add 创建新 incarnation，旧 accepted/inherited snapshot 必须重新 Apply；Edit/Restart 保留 incarnation，但 readiness 前仍拒绝新调用。
- legacy literal env/header 可读但永不进入新响应；它们的 mount 也必须满足 ephemeral 要求。迁移不后台进行，用户重新录入才转换为 refs。
- Unmanaged 只读；不实现 adoption、OAuth、legacy SSE、marketplace、远程目录、任意 tool trial、自动 orphan credential GC 或实时 reconnect/exit/stderr 承诺。
- **Mount Attempt Ownership 的边界**：same-identity retained old/new 已验证双方真实 RPC 与两种清理顺序，但该 ownership 是 module-realm-local，不是跨进程锁；无法证明归属的 active cross-module 行、未解析后缀残留以及永久未结算的 create/disposal 都保守保留。bare composition 仅获得既有受支持 fallback，不能据此宣称跨模块或未运行时的并发隔离保证。
- 回滚不支持只恢复旧 bundle 而保留新格式记录。唯一支持的完整路径是先备份并在新版本删除 HTTP、secretRef 与 incarnation-bearing 记录，再恢复旧 bundle；旧 reader 的行为不由 schemaVersion 保证。含 `deferLoading:true` 的受管 server 还必须先逐台以 `deferLoading:false` 完成编辑并确认 registry 已无该字段，再恢复不认识此扩展的旧 bundle。

## 测试

- 单元测试：`mcp-lifecycle`、`mcp-mount-ownership`、`mcp-config`、`mcp-credentials`、`mcp-registry-incarnation`、`mcp-incarnation`、`mcp-runtime`、`mcp-manager-lifecycle`、`mcp-operations`、`mcp-process`、`capability-mutation-remote`、`capabilities-mcp-commands` 覆盖 Loader/disposal/strict/readback、同步 ownership 分配、scoped mount、stale release、foreign/unresolved residue、秘密补偿、replacement permit、批量、remote ownership 与命令一致性；manager/facade/Apply wiring 另覆盖 live agent 差分限制、注册失败回滚、generation/attempt 精确清理、runtime readiness 与普通/恢复 Apply 的同步顺序。
- `deferLoading` 的 Host 单元回归覆盖 flat/batch JSON、非法值零副作用、旧记录、显式开关与无关编辑、Restart、strict replacement、retained 同身份挂载、重连后再注册，以及 facade register/execute 的 admission/drain 不变量；stock client row 始终无该扩展。真实供应商的发现→加载→调用与不支持路由回退仍需独立运行时验收，不能由这些单元测试代替。
- AI/intent：`mcp-install-tool` 覆盖 preview、exact approval、stored-plan digest、取消/超时/liveness/plan/ownership/revision/namespace、probe/CAS/mount 与 delegated child；`intent-gate`/`intent-classifier`/`skills` 覆盖中英文命中、否定/讨论/已有 server、quoted/unclosed、显式资格与冷安全审计。
- Client：`client-mcp-model`、`client-mcp-manager`、`client-capability-*`、`client.test` 覆盖库存/stale、Basic/Advanced、blank-keep/replace/remove、batch/retry、Select/default/Remove、focus、字典、错误边界、mutation wire 与 chunk digest；`deferLoading` 用例经 `mcpEditorFromServer`/`mcpConfigFromEditor` 与 `McpManagerView` 覆盖 add/legacy 默认关闭、启用编辑、显式关闭、无关编辑、Preview/Confirm 顶层布尔载荷、配置标签及不自动 Select/Apply。
- 集成场景 `mcp-management` 使用真实 stdio 与 loopback Streamable HTTP fixtures，覆盖 mount/probe/disposal、零工具、401、bounded timeout、replacement fence、incarnation/re-Apply、AI preview/cancel/approve、remote ownership 和 add/edit/probe/restart/remove/crash recovery 的秘密 canary。
- 回归场景 `mcp-gateway` 直接断言同一 live root 后续真实请求的 `toolNames`：late install 不向未选中会话注入工具，enable → disable → re-enable 精确增删 schema，并保留 admission、zero-RPC 与新 agent 检查；A/B 会话隔离由 manager 单元测试和下方 Desktop 验收覆盖，**不由 `mcp-gateway` 断言**。`lifecycle-inheritance`、`preset-defaults`、`capability-presets-surface` 继续验证继承与 portable preset 语义不扩大权限。
- 深化回归新增 `capability-lifecycle-feed`、`mcp-operation-coordinator`、`mcp-mount-ownership` 与 `mcp-inventory-projection` 单元/组合链路。真实 `capability-lifecycle-revision-zero-{weir-first,creative-first}` 在 `WEIR_IT_CAPABILITY_LIFECYCLE_DUAL=1` 下分别覆盖 revision-0 与 Apply enable/disable/re-enable，合计 84/84；`WEIR_IT_CAPABILITY_LIFECYCLE_RETAINED=1` 的 `capability-lifecycle-retained-revision` 覆盖 same-preset retained old/new、revision-local Apply/RPC、same-identity 双方真实 RPC、old-first/new-first 清理与重复释放，完整双顺序为 53/53（每种单独顺序均为 43/43）；`WEIR_IT_MCP_SCOPED_CANARY=1` 的 scoped non-writing tree/相同公开命名空间验证为 9/9。运行时证据来自安装版 DSH 0.2.1-rc.3；不外推到未实跑的其他受支持版本。
- Desktop 验收（`fix-mcp-live-tool-visibility`）：在真实 Weir 会话安装本地 stdio fixture，经 Host `Tool.listTools` 逐阶段确认未 Select/Apply 不注入、Apply 后出现、禁用后移除、再次启用恢复；实际 `echo` 调用成功，禁用后旧名称不再可调用。持续子会话在父会话启用前后保持相同 32 项工具目录，证明 A/B 隔离。最后取消选择并 Remove，preview 复核 `fingerprint:null / conflict:null`，无测试注册残留。Desktop 证据独立于此前的单元与 headless 结果。
