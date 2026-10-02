# Edit Lock 编辑锁仲裁（edit-lock）

> **开发中，默认关闭**：已提供可选组合插件 `orrery-harness/edit-lock`（`enabled: true` 才生效），尚未加入正式预设行；协商工具、受控解锁、UI、跨进程客户端和 GUI 验收未完成，默认用户可见面零变化。

## 概述

锚点校验与文件版本护栏只能证明「内容没有变」，不能证明调用者**仍然持有编辑权**：多个 Harness 进程（或同一进程内多个 agent）共享一个工作目录时，两个写者可以各自校验通过、先后落盘，形成一次静默覆盖。本特性把「谁有权写、这次写还作不作数」的判断收到工作目录级的单一仲裁点上，并让提交与释放、转交、人工解锁共用同一条顺序。

范围与上线硬门槛由本地 OpenSpec 变更材料定义（`openspec/changes/edit-lock-arbitration/`，过程材料不入库）：提案、设计决策 D1–D6、`edit-lock` 能力规格与任务清单均已就绪，**任务清单第 1 组起全部未勾选**。受影响的既有能力为 [hashline-edit.md](hashline-edit.md)、[lsp-integration.md](lsp-integration.md) 与 [todo-continuation.md](todo-continuation.md)；委派与续推调度、共享 runtime 消息、设置与客户端 UI 同在影响面内。

### 当前发布链路（未启用）

**组合插件 `orrery-harness/edit-lock`（默认关闭，未加入预设）**。行配置 `{enabled: true, root, authorityDirectory, domainId?}` 才启用；`root` 是唯一管理域，`authorityDirectory` 必须在域外（空目录新建，含 `snapshot.json` 则恢复，其余内容拒绝）。启用后：

- 挂载时捕获原始 `ctx.fs`，以跨进程预约打开唯一 runtime，并提供 `orreryEditLock` 服务。cordis 的兄弟行服务在其 apply 之后才可见，因此 `hash_edit` 同时接受挂载时与延迟 inject 的服务；一旦受管，服务移除只会拒绝，不回退直写。
- `tools/pre-execute` 守卫：`write`、`edit`、`hash_edit`、`lsp_rename`、`str_replace_editor` 中凡执行函数未经服务 `claim` 的定义一律拒绝。组合顺序错误、晚装服务或未知编辑器因此 fail closed。
- `agent/created`（发布前 await）安装写作用域：隐藏继承 stock write/edit，注册受控 write；随后注册会话。管理器已知的会话（重启恢复、同会话重建 agent）一律以中断态开始，不隐式重臂。
- active 回合内 stock Stop 同步触发 turn signal，立即封闭准入并持久撤权；idle Stop 没有 signal，使用 `/edit-lock stop` 获得可等待的持久撤权确认。`agent/disposed` 同样撤权。
- 可信人类入口 `/edit-lock`：`status`、`stop`、`resume`（以 commandId 作一次性 requestId 签发并消费 receipt，新 epoch，保留锁转 pending-confirmation）、`confirm <path>`（仅激活本会话 pending-confirmation 锁，不获取无主资源）。普通消息、状态查询都不恢复权限；todo 续推在会话非 active 时不触发。
- 普通 owner 工具（模型可调用，身份只来自 `exec.agent`）：`edit_lock_acquire`（获取既有文件；resume 后对 pending-confirmation 文件逐个调用即确认）、`edit_lock_release`（释放本会话的锁，不代表内容验证通过）、`edit_lock_status`（只读列出归属）与 `edit_lock_try_steal`（立即返回 pending requestId，从不等待持有者）。持有者有待答请求时才临时注册 `edit_lock_reply`（`release`／`keep`），通知经 `inject` 投递，**不唤醒** idle 或已中断会话。答复绑定 requestId、资源 generation、持有者 session 与 epoch；过期（默认 60 秒）、重复、旧 generation、非持有者或已停止持有者的答复一律拒绝，沉默保留归属。同意后由 manager 在**一个持久事务**里释放旧 generation 并为请求方获取，任一方已取消即整体失败。协商请求刻意只存在内存：重启推进所有 epoch 与 incarnation，旧请求只可能过期。
- 受控人工解锁：`/edit-lock locks` 列出全部归属与 generation，`/edit-lock unlock <path|resourceId> <generation>` 只在期望 generation 仍为当前值时释放。它排在 manager FIFO 中，等待此前在途提交结算；存在未决发布时被事务围栏拒绝；不存在无条件强制解锁。已准备的旧 owner 写入随后因 generation 失效在派发前结算为 not-published。解锁不改变任何会话的中断闩锁，也不验证内容。D6 的「撤销旧 epoch」由 generation 围栏实现，不额外中断 owner 会话。
- 跨进程（同一 `authorityDirectory` 的合作 Harness）：先抢到预约的进程成为唯一 publisher，并在用户私有临时目录下按 authority 规范路径哈希开一个 Unix socket 端点；预约冲突（`EEXIST`）的进程**不再整体拒绝**，而是成为客户端，从不自己落盘。每个客户端 agent 一条会话通道，首帧 `open {sessionId}` 后身份固定；工具、`/edit-lock` 命令、协商通知与临时答复工具都经该通道转发，发布仍由 publisher 持有的原始 `ctx.fs` 执行。通道 EOF（含客户端崩溃）由 publisher 持久撤权；重连的同会话总以中断态开始，需 `/edit-lock resume`。客户端只重试「建立通道」（等待旧通道 EOF 结算），从不重试调用；中断调用的结果按契约为 UNKNOWN。端点不做认证：可达同一用户临时目录的进程都在合作信任边界内，不防恶意同用户进程。publisher 退出后客户端不自立为写者，受控写入 fail closed，直到人工确认旧 publisher 静止并重启。
- 插件卸载撤销所有会话、排空发布，再释放预约；失败保留预约供人工核对。apply 写成箭头函数：cordis 会以 `new` 构造带 prototype 的回调并丢弃其返回的 disposer。

安装版 0.2.0-rc.2 隔离组合实测（真实 Agent factory、真实回合、ToolRuntime、stock fs、observation policy 与本插件 + hashline-edit）25/25：受控 write 创建、owner hash_edit、他人 hash_edit/write 以 `resource owned` 拒绝且字节不变、try_steal 立即 pending、持有者经 inject 看到请求与临时答复工具并转交、新 owner 编辑后释放、释放后可重获、active Stop 闩锁、普通下一条消息不恢复、命令 resume 后 pending-confirmation 拒写、confirm 后可写、受控解锁拒绝旧 generation 且按当前 generation 释放、idle 命令撤权、卸载释放预约。另有双进程实测（publisher 与客户端各运行完整安装版 Agent 栈、共用 authority 目录）客户端 13/13、publisher 8/8：第二进程成为客户端、跨进程拒绝他人文件、客户端 try_steal 抵达本地持有者并转交、客户端编辑经 publisher 发布、客户端 active Stop 在 publisher 持久撤权、重连为中断态、远端 resume/confirm 后可写、远端 idle stop 确认、客户端进程退出后其锁在 publisher 保持 user-interrupted 并继续围栏、关闭后释放预约。当前限制：单文件发布获得的锁保持到 owner 主动 `edit_lock_release` 或同意转交；持有者沉默或已中断时，由人工 `/edit-lock unlock` 按 generation 释放。仍未覆盖：正式 profile/Loader 挂载、GUI、LSP 实际 rename 回合、双 Harness 在真实 GUI 中的部署。
可信宿主桥 `createEditLockHost` 以真实 agent 对象的 WeakMap 绑定已持久注册／恢复的 execution，逐次用宿主 registry 检查对象身份；模型参数不能注册身份。detach 先删除调用授权，再请求 durable cancel。`hash_edit` 已添加可选 `orreryEditLock` 入口：在插件挂载时捕获服务，发布完整合成内容、原始参数、版本 guard、实际有效 policy 与 exec；服务拒绝或关闭不能回退原生直写。没有服务时保持既有行为，因此正式启用须在编辑工具挂载前安装服务，并整体覆盖 write/LSP，不能热插入局部接管。当前未注册服务、未加启用设置。

受控 `write` 定义已提供但未注册：复用现有单次沙箱策略解析，保留 `fs/write-intent` 返回的 createIfAbsent／replaceIfVersion，缺少明确 guard 时拒绝，不用新 stat 覆盖旧观察版本。成功后发送标准 `fs/observed` 并返回内容差异；没有本地写入 fallback。独立工具定义经安装版 FS 创建实接验证，不等于正式工具表的覆盖验收；生命周期挂载仍须在 agent 发布前隐藏原 stock write/edit。

生命周期控制器 `createEditLockLifecycle` 提供显式 start／stop／close，工具只拿到 publish／publishBatch，不暴露注册权。stop 同步关闭 registry 准入并等待 durable cancel；注册尚未结算时停止也不能晚到附着。重复 start 不恢复中断会话，close 先撤权再关闭 runtime。它仍是未挂载控制器：真实 registry、agent 发布前的工具覆盖、idle Stop transport、恢复授权及 IPC shutdown 须由正式宿主接入，不能把 stock Stop accepted 当作持久撤权确认。

跨进程预约层 `openReservedEditLockRuntime` 使用预先配置、所有合作进程共用的 authority 规范目录对应的同级隐藏预约目录，通过原子 mkdir 排他；不污染 store 创建要求的空目录，第二进程被拒绝。每次断言核验原目录 inode，关闭 runtime 并等待发布排空后才非递归释放。启动失败或进程崩溃保留预约，不按 PID／超时删除或自动切主，须外部确认旧发布者静止后恢复。该层仅支持可信合作进程和本地目录，不提供重叠 workspace 的全局发现、网络盘保证、恶意同用户隔离或 IPC 身份认证；正式部署与恢复操作入口尚未接入。

IPC 原语（尚未部署）将 host 已认证的单个 agent 固定绑定到 peer，不接受消息中的身份／生命周期权限；长度前缀 JSON 在解析前限制 8 MiB，限制并发与响应积压，非法帧或断连封闭入口并触发持久撤权。客户端取消关闭整条会话通道，未确认发布一律 UNKNOWN，不等于未落盘或 manager 已确认撤权；禁止换 ID 自动重试。上层必须等待服务端 close 的结果，并只提供已认证的宿主通道。隔离双进程实接已验证子进程客户端→独占 manager→安装版 FS 创建及 EOF 后持久中断；使用可信 spawn 管道与夹具身份，不等于正式 Agent／GUI 身份接线。该层不创建公开监听端点，尚无客户端发现／认证和恢复入口。

远端工具服务封装绑定真实 agent 对象并逐次检查 registry，不持有本地写入能力；拒绝或通道关闭不回退。工具作用域安装原语隐藏继承的 stock write/edit，再注册 managed write 并核对 lookup；卸载只移除 managed write，保持原工具禁用。它不处理同作用域 stock 定义（须原组合持有者先 dispose），不能替代 hash_edit/LSP 的服务预捕获，仍未挂载进正式预设。

`lsp_rename` 同样捕获可选服务，完成原有全文件内容预检后，整组规范资源原子获取，再逐文件按原版本发布。批量入口拒绝缺失节点与重复规范目标，不发创建意图；仅全成功时原子释放本批新增临时锁，已有锁保持。失败保留归属并区分 written / not-written / uncertain，不宣称跨文件回滚。同批 operation 历史存在时拒绝重启整批，需检查历史处理；尚不提供批量历史聚合重试。runtime 控制入口关闭后拒绝新调用，并在发布前再次调用独占断言；断言仍须由真实跨进程宿主提供。
manager 的 `prepare` 持久绑定原请求，返回私有 submission；`commit` 在同一 FIFO 中持久 publishing 后仅调用一次捕获的发布函数。创建成功的规范身份、归属与结果同镜像提交；发布期间取消保留 interrupted 锁，确认落盘期间新到取消追加撤权镜像后才应答。原生调用后的异常保留 unknown/fence，不从异常推断未发布。历史同参返回记录，异参同 ID 拒绝，不自动重放。

publisher 捕获原始 `fs.resolve/writeText`，保留五参数调用（目标、完整内容、原版本策略、signal、effectivePolicy）；adapter 用进程内不可伪造 call 绑定可信 execution/cwd/policy/callId，单次消费，不向工具参数暴露凭据。历史 prepared/unknown/not-published 不作为工具成功返回。生命周期包装提供进程内域去重、关闭入口与排队任务排空，但**仍要求调用方提供真实跨进程排他和旧 publisher 静止证明**，不能以进程内 Set 替代跨进程仲裁。

当前证据包含真实 store 创建/取消/重试与批量冲突回归、全链 strict 检查、1095/1095 产品回归，以及隔离 Electron fixture 内产品 runtime/adapter → 安装版 native FS 的实际创建成功（文件内容和持久归属一致）。它不等于双 Harness 或 GUI 验收。批量获取锁不隐式确认 pending-confirmation；未决围栏仅放行减权取消，不放行增权或发布。正式启用仍受原硬门槛约束，尚未实现精确围栏放行与人工结清、工具/LSP/UI 全面接入。下列内容保留此前分阶段实现记录，若与本节冲突，以本节为当前状态。
包内已落地四个内部模块，都不提供插件包导出、不注册工具、没有服务与挂载行，也没有设置键。① **状态内核** `src/edit-lock/state.js`：纯内存、不接触文件系统，只回答「按当前归属与执行授权，这次操作该接受还是拒绝」。② **规范资源身份** `src/edit-lock/resource-identity.js`：同步、只读地观察真实文件系统，回答「这个路径此刻对应哪个规范资源身份，与上次观察是否仍是同一拓扑」。③ **历史快照存储** `src/edit-lock/store.js`：把权威状态按封闭 version-2 schema 落成单文件历史镜像（规范 JSON + SHA-256 校验、写序持久化、串行本地 revision CAS），只保存与读回**历史事实**——不安装授权、不签发或恢复 receipt、不提供 restore。④ **持久 operation history** `src/edit-lock/operation-history.js`：在同一镜像里记录操作身份、绑定、阶段、结果、围栏与 closeout 的封闭历史层，同样是历史而非授权，也没有发布入口（见下节）。设计中的 manager/gateway、跨进程仲裁、受控创建通道的串行发布、kernel restore 与 UI 尚未产品化。

新增第五个未挂载模块 **manager 初始事务层** `src/edit-lock/manager.js`：仅接受 revision 0、无 incarnation 的新 store，串行提供可信 `openSession/acquire/cancel/cancelSession/status`；调用方仍须独占 store 生命周期，且 acquire 输入必须已经是可信规范资源身份。会话与归属增权执行 draft → 完整镜像持久确认 → install → 返回；持久或安装失败毒化整个 manager，排队及后续操作拒绝。取消同步叠加仅减权的 deny overlay，再串行持久撤权；持久等待期间取消的 acquire 不返回令牌，保留 interrupted 归属。凭据入队前复制。可信生命周期 `cancelSession(sessionId)` 独立于 execution，关闭首次 openSession 等待持久确认时的授权返回空窗；取消先于注册时返回 unknown session、保留拒绝闩锁，后续注册不写入 active 会话，其他会话不受影响。这不是持久撤权成功 ack，也没有自动清闩锁入口。status 是有效状态观察，不是磁盘 ack 或可转移写入许可。当前不提供文件发布、resume、恢复、singleton、IPC 或宿主接入，不能用本切片启用功能。

首次注册取消增量：真实 store 屏障与提前取消两条回归红→绿，manager 专项 8/8；全量 1076/1076、0 fail、0 skip，direct strict 检查通过。未接入宿主 Stop，不作为 GUI 撤权验收。

**后续凭据生命周期增量（仍未挂载）**：manager 新增可信 `issueExecutionReceipt` 与 `resume`，取代上段「不提供 resume」的阶段性描述。签发先持久 requestId 墓碑、安装后才返回进程内 receipt；恢复先消费一次性 receipt、持久后安装新 epoch，保留锁仅进入 pending-confirmation，不自动重臂。复制/伪造 receipt 和重复 requestId 拒绝。签发或恢复等待持久确认期间取消，不返回旧 receipt/execution；`cancel(execution)` 仍在入口校验当前凭据，但撤权队列执行时使用此会话最新已安装 epoch，避免前置 resume 安装导致撤权因 stale epoch 落空。receipt 不序列化，不支持进程重启恢复。宿主人类意图认证仍未接入，以上入口不能暴露给模型工具。真实存储专项 11/11 通过，包含签发/恢复两种持久等待取消竞态；常规 check 与 direct strict 通过。

**保守恢复内核增量（仍未挂载）**：私有 `beginRecovery(history)` 仅在未发生变更的新内核上接受不同 incarnation 的历史 core；active 会话 epoch 增一后中断，原 interrupted 会话保留 epoch，所有非 abnormal 锁改为 user-interrupted，异常原因和 generation/request 墓碑保持。旧 receipt 不导入，重复注册不能绕过中断。恢复候选是无 mutation facet 的不透明对象，供 checkpoint、持久确认后 install 或 discard；创建候选即关闭再次导入入口并使先前空 draft 失效。重复/不一致引用和不安全 epoch 拒绝，不安装部分历史。输入应来自已验证 store，不是模型可调用的 JSON hydrate。该内核尚未接入 manager 启动、历史发布转换或恢复围栏，不宣称重启恢复可用。内核专项 21/21、全量 1082/1082（0 fail、0 skip）、check 与 direct strict 通过。

**manager 启动恢复增量（仍未挂载）**：独立可信 `recoverEditLockManager` 接入上述候选，历史 prepared → not-published/rejected-before-dispatch，publishing → unknown，原 fence、terminal/unknown 历史和预算不改写；新 incarnation、保守 core 与转换后 operations 同镜像持久确认，再安装并返回 manager。真实 store close/recover 与目录同步屏障验证无提前交付，IO 失败拒绝启动。调用方必须先保证独占 store 生命周期与旧 publisher 已静止；此入口自身不证明 singleton/quiescence。存在 publishing/unknown 时暂保守拒绝整个 manager 的所有 mutation，仅 status 诊断，不提供清围栏或重放。这是未完成精确范围 admission 前的内部安全状态，不是产品可用性验收。专项 14/14、全量 1085/1085（0 fail、0 skip）、常规 check 与 direct strict 通过。创建发布、宿主生命周期及 GUI 尚未接入。

**请求绑定前置（仍未挂载）**：`canonicalRequestData` 对普通数据先检查 descriptor，不执行 getter，拒绝 undefined、非有限数、-0、symbol、非普通 prototype、隐藏属性、稀疏/附加属性数组及环。对象 key 排序而数组/字符串保序；`bindRequest` 计算原始参数与实际 UTF-8 内容 SHA-256，以版本化 envelope 绑定 literal path、cwd、writeText、原 expected、完整 effectivePolicy 和原 target，返回深冻结 detached binding，不含当前 epoch/incarnation。创建仅接受 write。该 seam 面向可信 adapter 数据，不是恶意 Proxy 沙箱；target 完整 schema、策略授权、物理路径观测与发布许可仍由后续 manager/store 验证，摘要本身不是授权。专项 4/4、全量 1089/1089（0 fail、0 skip）、check/direct strict 通过；尚无 prepare/commit 或宿主编辑接入。

请求绑定现已复用 `validateBinding` 校验完整目标 schema，不再把 target 结构校验推迟到 store：create descriptor 必须为绝对 ancestor、无 `..` 的相对 suffix 与 createIfAbsent；update 必须为绝对资源、正安全 generation 与 replaceIfVersion，version 仍是原样 opaque string。策略授权和物理观测仍非摘要职责。专项 5/5、全量 1090/1090、check/direct strict 通过。

`FsVersion` 作为宿主提供的不透明字符串保存：更新 guard 与成功 outcome 均允许空串和含 NUL 的字符串，JSON 恢复后原样保留；不解析版本格式、不强制转换类型，非字符串仍拒绝。该兼容修复的真实快照回归通过；本轮专项 66/66、全量 1054/1054（无跳过）及常规静态检查通过，尚不代表真实 manager 发布验收。

内核私有 authority 的 `checkpoint()` 导出 detached generations 与 issuedRequests 墓碑，补齐 status 不含的持久历史，不导出 receipt 对象。`begin()` 在分离的内核上复用同一 transition；`checkpoint(draft)` 供 manager 持久化候选；`install(draft)` 一次性安装本内核当前 revision 的候选，`discard(draft)` 关闭候选。任意 live mutation 尝试均保守地使旧 draft 过期（包括拒绝）；跨内核、JSON 伪造、重复安装与关闭后的 facet 调用拒绝。安装复制状态且关闭 draft，不提供 raw hydrate。暂存 resume 成功立即烧掉 live receipt，丢弃不复活，并使其他 draft 过期；暂存签发的 receipt 仅 install 后激活，丢弃不激活。receipt 不跨重启恢复。内核自身不执行 IO；初始 manager 已为 openSession/acquire/cancel 接入持久后安装，但不能把 draft 当作可发布权限，receipt 与实际发布仍未接入。

私有 `settleCreated(origin, resourceId)` 仅供可信 manager 在确认原生创建成功与规范身份后结算；拒绝收编任何既有锁，沿用 generation 墓碑。相同当前 epoch 且会话未中断时为 active；取消或旧 epoch 的迟到成功只保留 user-interrupted 归属，即使会话已经 Continue 也不自动重臂该锁。未知会话、其他 incarnation、未来或非法 epoch 一律拒绝。它本身不验证磁盘成功、operation 去重或发布围栏，不得暴露为普通 acquire 或工具入口；这些检查仍属未落地的 manager。异常分类继续由现有 markAbnormal 完成。
### 发布前取消内部入口（开发中）

存储新增 `beginPublication(input, key, mutation)`：仅当前 handle 新登记的 prepared 操作可持久化 publishing 后取得一次性 attempt；恢复时已有的全部操作键拒绝重新领取。attempt 的 `invoke()` 与 `finishWithoutDispatch(reason)` 同步互斥：后者永久关闭调用机会，以 handle 私有 WeakMap 证据执行仅本次 publishing → not-published 转换并移除未使用围栏，结果仍需落盘后确认。证据绑定完整 operation（含 origin/binding/fence）与持久 revision，不序列化、不对外返回；普通 `record` 仍禁止该转换。调用一旦发生，即使同步抛错也不再提供未发布证明。revision 变化、close 或 poison 后拒绝操作；结算 IO 失败毒化 handle，保留恢复围栏。该接口不验证运行权限、不接入真实 `ctx.fs`，调用方仍必须独占原始 mutation、序列化生命周期并证明单 manager；它不是可直接交给工具调用者的权限 API。

## 用户可见行为

**当前：零变化。** 本特性未挂载，因此：

- 没有新增工具（`acquire` / `release` / `try_steal` 与结构化答复工具均未实现、未注册）。
- 没有新增设置键或设置页条目；`plugins/orrery-harness/cordis.patch.yml` 没有对应插件行。
- 编辑行为不变：`hash_edit`、stock `write` / `edit`、`lsp_rename` 的锚点校验、版本护栏、沙箱策略与 diff 输出与未引入本特性时相同。
- 未启用本特性的会话，续推与取消规则完全照旧（[todo-continuation.md](todo-continuation.md) 的现有语义不变）。

**计划中（未实现，验收以 spec 为准）：**

- 受控写入在归属缺失、已转交、执行授权过期或处于待确认状态时**拒绝落盘**，目标文件字节保持不变。
- `lsp_rename` 在写入前原子获取全部目标文件的归属；任一冲突则零写入、零新增锁。
- 会话中断状态落到会话级（见下）。**启用本特性后，零锁会话的续推行为会被改变**——这是设计明确写下的行为变化；未启用时仍沿用原规则。
- UI 提供状态图标与详情面板（文件、owner、状态、异常原因、最后操作、恢复尝试、暂停余额、部分写入状态）。查看与保留不授予写权限；恢复与受控解锁走可信人类入口，且不存在无条件强制解锁。

## 配置

正式预设与设置页都没有本特性的配置项，`cordis.patch.yml` 也没有对应行。开发组合可单独挂载 `orrery-harness/edit-lock` 行，配置 `enabled`（默认 false）、`root`、`authorityDirectory` 与可选 `domainId`；该行须排在 hashline-edit 与 lsp 之前。设计材料里出现的参数（协商时限、单次/累计暂停预算、恢复重试预算）都是待实施参数——其中「有限累计暂停预算」尚未获用户确认，未确认前自动暂停保持禁用。

## 设计细节

**状态内核切片**。`src/edit-lock/state.js` 是纯内存模块，不提供 `orrery-harness/edit-lock` 包导出。它分离资源 owner、generation、会话 epoch 与 manager incarnation，通过公开状态操作检查权限。内容版本仍须由后续提交适配器独立校验；协商、实际 commit 与持久化不属于本切片。

**资源身份切片（只读观察，不是权限）**。`src/edit-lock/resource-identity.js` 导出 `createResourceIdentity()`，提供同步 `resolve(filePath, { cwd })` 与 `revalidate(observation)`：

- 既有普通单链接文件 → 冻结的 `{ kind: 'file', resourceId }`，`resourceId` 是 native canonical realpath。
- 缺失目标 → 冻结的 `{ kind: 'missing', ancestor, suffix }`：`ancestor` 是最后存在的规范祖先，`suffix` 是逐字未解析后缀。**缺失观察没有 `resourceId`**，不构成创建键，也不发放任何形式的所有权或发布权。
- `revalidate` 只接受本 factory 自己发出的**原对象**（私有 WeakMap 持有）；副本、其他实例的观察与 `null` 一律按 `unknown observation` 拒绝。
- 观察按构造冻结，不可伪造 `resourceId`，也不携带可序列化的证据。

语义边界：不折叠词法 `..`（`alias/../file` 按 alias 的物理目标解析），不做大小写或 Unicode 归一（本卷把 case 与 NFC/NFD 别名合并为同一 native realpath——测试只记录该卷实测结果，不推广为所有文件系统的等价规则）；忽略内容、时间戳与兄弟文件变化。连续性证据由 entry 与 canonical 祖先链的 dev/ino、逐跳 symlink target 共同构成：文件替换、symlink 替换/改向、祖先替换、新 symlink 祖先与 kind 变化一律 `topology changed`；新增硬链接则使目标不再满足「单链接普通文件」，`resolve` 与 `revalidate` 都直接拒绝（`not editable`）。普通新目录被创建时 `revalidate` **返回一个新的缺失观察**：调用方必须改用并保留这个新观察，原观察只作历史，之后新 symlink 祖先出现时两者都拒绝。

平台与失败语义：仅 darwin/linux，其他平台 factory 直接抛错（Linux 只经代码路径允许，未实机验证）；目录、dangling symlink、symlink 环、特殊文件、`nlink > 1`、`missing/..`、相对 cwd、空路径与含 NUL 路径全部拒绝，不做本地无锁后备。

**历史快照存储切片（持久化历史，不是授权来源）**。`src/edit-lock/store.js` 提供 `openEditLockStore({ directory, domainId, mode: 'create' | 'recover' })` → `snapshot()` / `record({ expectedRevision, nextState })` / `close()`：

- **封闭 version-2 历史镜像**：managerIncarnation、sessions（sessionId/executionEpoch/interrupted）、generations（含 release 墓碑）、locks（resourceId/owner/generation/status，abnormal 必须带 reason）、issuedRequests（去重历史）、recovery（累计 charge）与 operations（持久 operation history，见下节）。除 schema 校验外还强制历史单调：epoch 与 generation 不得倒退、interrupted 翻转必须前进 epoch、issued request 不可删除、recovery 计数只增、同 generation 的 abnormal 结论不得清除。
- **规范编码与完整性**：object key 按 UTF-16 排序、无空白、数组保序的 canonical JSON；`{version,domainId,revision,state}` payload 加 `{payload,checksum}` envelope，checksum 为 SHA-256。读取要求严格 UTF-8、**逐字节**等于重新规范化的结果（每一层的重复键、非规范数字/转义写法、空白与乱序因而全部被拒绝）、精确 schema 与 version/domain/revision/checksum 一致。checksum 只检测意外损坏，**不是**认证，也不防回滚。
- **写序与确认**：独占 sibling temp（`wx`、0600）→ 全量写入 → file sync → file close → rename → 目录 open（`O_DIRECTORY|O_NOFOLLOW`）→ 目录 sync → 目录 close，之后才确认并更新内存。失败不回滚、不删 temp、不提升遗留 temp；rename 之后的不确定性保守记为 `uncertain`。
- **串行本地 revision CAS**：每 handle 一条串行队列，`expectedRevision` 与当前 revision 不符即 conflict，溢出拒绝且不写入、不毒化。这是 **handle 内**的 CAS，不是跨进程/跨 handle CAS，也不是单实例选举。
- **持久化 IO 失败毒化整个 handle**：任何持久化失败（含真实 syscall 错误）都毒化 handle，排队中与后续的 `record` **连同 `snapshot()`** 一律拒绝——过期内存不得冒充回滚后的状态；参数、CAS、transition 与溢出错误不毒化。错误 code 为 `EDIT_LOCK_STORE_PERSISTENCE`，`commitStatus` 区分 `not-renamed` 与 `uncertain`。
- **外部前提由调用方证明**：模块要求调用方在**模块之外**证明该目录的独占生命周期与旧 publisher 静默，并持续到 `close()`；目录需预先 provision，`create` 只接受空目录，目录与其祖先不得被并发替换。模块不提供 singleton election、PID 超时接管、租约或 handover。
- **恢复语义**：`recover` 只读 `snapshot.json`，拒绝 symlink/特殊文件/目录，并在打开前后两次确认 regular file；committed snapshot 缺失或非法即失败，**不初始化、不修复、不重试 create**，合法 committed snapshot 可与遗留 temp 共存。面向支持文件与目录 sync 的 POSIX 本地文件系统；不承诺网络文件系统、Windows 或掉电硬件语义。
- **仍然没有的**：不保存也不签发 receipt（receipt 是进程内能力，禁止持久化）；没有目标文件发布、没有运行时发布或授权入口、没有 manager/kernel restore、没有 manager incarnation 安装、没有 live fence enforcement、没有幂等重放通道、没有重启围栏与任何挂载。持久 operation history（下节）只提供**历史事实**，不是授权来源。

**持久 operation history 切片（历史层：不授权、不发布、不恢复）**。`src/edit-lock/operation-history.js` 提供 `operations[]` 的封闭 schema 与转换校验：历史与既有权威状态同处**同一份原子 snapshot 镜像**（envelope、canonical 编码、写序与串行 revision CAS 全部不变，镜像 version 由 1 升为 2），**没有**独立的第二本内存账本；`recover` 拒绝 version 1 与未知版本镜像，不自动迁移、不写回。

- **键与查询**：域内键是 `(sessionId, operationId)`；`lookupOperation` 优先查历史、**不检查当前 authority**、返回 detached 数据，同一键换 binding 即 `ID_REUSE`（绑定按结构比较，与键序无关）。origin（executionEpoch/managerIncarnation）是不可变历史、**不是重试键**；调用方认证与授权仍属未来的 manager。
- **冻结的 binding**：tool（`write`/`hash_edit`/`edit`）、原始 filePath、绝对 cwd、request/args/payload 三个 SHA-256 摘要，以及目标与冻结策略（create → `createIfAbsent`；update → `replaceIfVersion` + version）。**存入的字符串不等于认证**：摘要必须由未来的可信 publisher 按规范请求、原始参数与实际 payload 字节自行计算。
- **通道划分**：create 仅允许受控 `write`，`hash_edit`/`edit` 只更新既有资源。prepared create **不含 resourceId**、不发放任何所有权，同一目标的多个 prepared 意图可以共存。
- **持久阶段与合法转换**（raw `store.record` 同样强制，不只是恢复时）：prepared → publishing → created/updated/unknown；prepared → not-published **仅**表示 dispatch 前的取消或拒绝；不能跳过 publishing；普通 raw record 的 publishing/unknown 不得改写为 not-published，唯一例外为上述 live attempt 的私有未调用证明（unknown 无例外）；历史条目不可删除、不可重绑、origin 不可重写。
- **成功归属是 transition-local**：同一次 before/after 里，成功 outcome 必须有匹配 owner/generation 的锁，且 created 不能收编既有锁（要求该资源此前无锁）。完成历史在后来 release 之后保留，不因当前无锁失效；但 owner 转手或 epoch/incarnation 前进时保留的锁必须记为 interrupted/abnormal，不得是 active。
- **未结算 update 保留原归属**：publishing/unknown 的 update 必须保留原 owner/generation，不能经 release/transfer/re-generation 绕过；晚到成功保留 interrupted/abnormal 分类、不重臂被取消的 epoch；取消与 unknown settlement 本身也不能重臂。
- **围栏与 closeout 都是历史断言**：update 用 resource fence，create 用观察到的祖先子树（`observed-ancestor`）、保守祖先（`conservative-ancestor`）或 containment-unproved 的 domain 断言；closeout 是 append-only 的 `{kind, assertionId}`（`abandoned-unknown` / `not-published-evidence`），只允许出现在 unknown 阶段。本层只验证结构与词法包含，**不认证**文件系统/别名证明，也不实现 unrelated-work admission；**没有 TTL**、不按名字猜等价、不自动升级为全域围栏；围栏一旦持久化即不可变，closeout **不清围栏**、不改原 unknown outcome、不允许重放，也没有 `publisherDead`/`humanApproved` 伪认证或运行时 clearFence 接口。
- **独立复核修复的两项完整性缺陷**：① 事务级重复创建归因被拒绝——同一次转换里同一份新增 ownership 不得归给两个 operation（既有终局历史不计入，不同资源的批量成功与 release 后新 generation 重建仍合法）；② 成功终局要求保留的 lifetime generation ≥ 结果 generation（恢复与记录路径同时生效），且**不要求当前 owner/锁**——合法 release、他人重获与更高 generation 都可恢复。

**Option C 的创建协议是计划中的写入归属例外**。缺失目标的创建成功路径不沿用「先取得归属再写入」的顺序：它没有既有节点可绑定，因此按已确认的 Option C 契约经 manager 串行发布道发布——幂等绑定优先，其次节点存在性冲突判定（既有节点一律冲突，冲突先于任何目标侧副作用），再经 manager 实际持有的 `ctx.fs` 发布，发布成功后解析规范身份并绑定归属与持久结果才返回成功；**创建意图不是所有权**，不发放所有权令牌，也不构造规范资源键，未知结果由持久 intent/outcome、无过期恢复围栏与墓碑兜住。该例外已写入设计材料（D3/D5 与任务 1.6/2.5/2.6），**尚未实现**；本切片的只读观察不属于该路径，也不能当作它的替代。

**创建通道只归受控 `write`，`hash_edit` 只编辑**（用户本轮确认，已写入规格与设计 D2b）：目标没有既有文件节点时，`hash_edit`（以及可选共存的受控 stock `edit`）**零副作用拒绝**——不发 CreateIntent、不取得所有权、不构造规范资源键、不创建也不收养节点；规划之后出现的节点一律不收养、不取得、不覆盖；dangling 符号链接、特殊文件与目录按不可编辑拒绝且不跟随重定向。这与宿主既有语义一致（`write` 走受保护创建、`edit` 对缺失目标报 `FS_NOT_FOUND`、本仓 `hash_edit` 对非普通文件在提交前拒绝），但宿主证据源在 `/tmp/dsh-src`，仍须按上线硬门槛在当前 runtime 复核。

**取消是独立 ingress，不是回合结束的副产品**。当前安装版实测（`.orrery/edit-lock-verification/current-ingress/REPORT.md`，本地过程材料不入库）确定了三件事：

1. active 回合内，`agent.cancel` 会在调用栈内**同步**执行 abort listener（`agent/pre-step.signal` 与真实 tool `exec.signal` 相同），此后回合才结算为 `aborted{kind:'user'}`；
2. idle 时取消**不产生新的 active-turn abort**——只挂 pre-step signal 覆盖不到「没有回合在跑、但仍有未消费授权」的状态；
3. 还存在「请求已发出但 abort signal 尚未产生」的窗口（实测：request abort 会拒绝 `execute`，但不合作的异步 handler 之后仍能产生副作用，`withAbort` 是 race 而非强制停止）。

因此撤销必须覆盖 **active / idle / pre-signal 三类窗口**，且作废后到达的旧 epoch 请求一律拒绝；不得从文件内容相同反推成功。

**异步 ack ≠ GUI 接受**。安装源码检查表明，GUI Stop 路径（`SessionCommandController.cancel`）调用 `agent.cancel({kind:'user'},{keepInbox:true})` 后返回 `{accepted:true}`，没有等待 Edit Lock manager 撤权。该控制器、RPC 与浏览器路径尚未执行验证。因此「Stop 被接受」不能作为仲裁点已确认撤权的证据。后续适配器必须本地封门，并把撤销与实际提交在管理器排序；确认完成前不得恢复写入。跨进程没有共享 AbortSignal，已经在线性化撤权前完成的发布也不能声称被回滚。

**会话闩锁与剩余锁数量无关**。中断状态保留在会话层：启用本特性的会话即使在**首次 acquire 之前**就被停止，或**最后一个锁已被释放/受控解锁**，也必须收到可信显式执行请求（Continue）才重新武装编辑续推。状态查询、后台通知、release 与解锁都不清除它，也不授予执行授权。这是设计评审发现「按剩余锁数量推导中断状态会让零锁会话被静默重新武装」之后写进 spec 的修正。

**信任模型是可信协作插件**。保证范围是「同一工作目录管理域内、经 Orrery 接线的受控写入」；shell、外部 IDE 与绕过提交路径的写入明确排除。早期 adapter 使用 fixture 身份，后续 current-ipc 已以真实 Agent/Session 对象及可信 spawn 连接绑定验证身份传输。产品仍须建立可靠的连接/session 绑定并保真传递有效 policy，但不声称抵御同用户恶意进程或恶意宿主插件。

## 边界与失败语义

- **未挂载即无行为**：没有插件行、没有服务、没有工具、没有 UI 元素，装载与否不改变任何现有会话。
- **权威状态：初始 manager 已持久后安装，但不可重启恢复（未挂载）**：`openSession/acquire/cancel` 通过真实 store 确认后才安装候选，取消 overlay 可先行减权；进程退出后不能重新装载授权。没有 manager/kernel restore、实际发布、live fence enforcement、幂等重放、单实例选举或重启围栏。磁盘历史 active 状态不构成当前授权；非新 store 明确拒绝初始化 manager。
- **后续接入的 fail-closed 要求**：资源别名无法安全归一、可信执行上下文缺失或 manager 断连时拒绝写入，不做本地无锁后备。资源身份切片自行从真实文件系统解析既有节点的 native 规范身份（不折叠词法 `..`、不做大小写/Unicode 归一），但**仍不判定缺失名称的等价性**——不预创建占位文件、不猜测别名，该问题交由 Option C 的创建协议解决；状态内核与资源身份切片不执行任何目标文件写入，store 只写自己的 `snapshot.json`、operation history 只写同一镜像，release 也不等于验证通过。
- **未承诺的时点保证**：观察是一串同步 filesystem 调用，**不是原子快照**；外部 shell/IDE 在调用之间改变盘面不在保证内，dev/ino 连续性无法证明不存在 inode reuse 或「改后复原」（ABA）。调用方必须先自行协调变更顺序（manager 生命周期/发布协调）。
- **明确不承诺**：不承诺跨文件回滚（已发布的字节不会因取消自动撤销）、不承诺覆盖任意磁盘写入面（bash、PTC、外部编辑器与任意 filesystem API 都在保证之外）、不承诺分布式多机共识。
- **OpenSpec 任务保持未勾选**：`openspec/changes/edit-lock-arbitration/tasks.md` 第 1 组起全部未完成；任务 2.1 下有两条、任务 2.2 下有两条，任务 2.5 与 2.6 各有一条阶段进度注记（均不勾选、也不代表对应任务完成——存储与 operation history 只是 2.2/2.5/2.6 的 partial foundation：没有受控创建通道的串行发布、没有 manager/kernel restore、没有运行时围栏执行与授权，ID_REUSE 只是历史绑定比对而非重放通道）；本文档不把它们标为完成，也不作为启用依据。

## 测试

- **初始 manager 事务**：6 项真实 store 测试通过，覆盖目录 sync 前授权不可见、取消同步减权与持久 ack、取消期间 acquire 保留 interrupted 归属但拒绝返回令牌、入队前凭据快照、竞争冲突不毒化、取消不影响另一会话、历史 store 拒绝初始化，以及 uncertain IO 失败后的排队/后续操作全拒绝。全量 1074/1074、0 fail、0 skip；常规 check 与包含 manager/store/state 的本机 direct strict 检查通过。本切片未做独立子代理评审（遵守本轮亲自实施约束），不代表创建发布或宿主验收通过。

- **状态内核单测**：`plugins/orrery-harness/test/edit-lock-state.test.js` 9 项通过，覆盖独立围栏、零锁中断、一次性 receipt、逐文件确认、子会话独立、异常保留与查询快照隔离；独立审查另跑 5 项公开接口补充测试（含 100 次取消/恢复循环）通过。这是历史内核批次的证据，不代表运行时接入验收。
- **资源身份单测**：`plugins/orrery-harness/test/edit-lock-resource-identity.test.js` 14 项全部通过（真实 `mkdtemp`/`write`/`mkdir`/`symlink`/`link`/`rename`，真实 `/dev/null` 作特殊节点；平台 dispatch 在独立子进程中替换 `process.platform` 检查，不伪造文件系统成功）。独立装置另跑 `.orrery/edit-lock-verification/resource-review/adversarial.test.mjs`（22 项真 FS 语义）与 `scaling.test.mjs`（1 项）共 23 项通过。
- **复杂度缺陷（已修复，含红绿证据）**：独立装置先复现了指数级父路径重放——`self -> .` 重复 4/8/12/16 次时 lstat 159/2559/40959/655359、readlink 15/255/4095/65535；`traceLink` 当时对相对 target 拼接原始 parent spelling，递归重走了已观察的 symlink 父路径。修复改为从已见证的**物理**父路径逐组件推进：先 lstat 记 inode，是 symlink 才递归记录 target/hop，之后再 native realpath 推进游标；不预先归一整个 target，也不省略嵌套 link。修复后同装置读数为 lstat 17/25/33/41、readlink 4/8/12/16。产品侧同时落一条回归测试：在隔离子进程给 Node 内建加 passthrough 计数（每次仍调用真实 fs），要求每多 4 个组件 lstat/readlink 各自至多 3 倍增长，并断言观察仍是同一个真实文件；无 wall-clock 断言，也无 mock 文件系统。该修复消除已观察父拼写的指数重放，**不**声称整个 resolver 对所有路径/内核 I/O 都是线性。
- **静态检查与产品单测**：改动 `src/**` 后按 AGENTS.md §6 跑 `pnpm --filter orrery-harness run check` 与 `pnpm --filter orrery-harness test`。项目 curated 清单只收无 `node:` 内建依赖的纯模块，因此收录纯内核 `src/edit-lock/state.js`，而 `resource-identity.js` **刻意排除**（`types: []` 剥离 Node 全局）——项目 `run check` 通过**不能**替代该模块自己的严格检查。作为本地补充检查，另用 `--allowJs --checkJs --strict --types node` 直接检查该文件，`typeRoots` 指向本机既有的 `@types/node` 22.20.1，exit 0、零诊断；这是**本机不可移植的补充证据**（该 `typeRoots` 不是仓库依赖，也未被写入 `jsconfig.json`），全程未安装依赖、未写类型 stub、未改仓库 TypeScript 配置。本轮产品全量 988/988 通过、0 跳过。内核批次合入前不引用历史基线的通过数字作为本特性的证据。
- **历史快照存储单测**：`plugins/orrery-harness/test/edit-lock-store.test.js` 33 项通过、0 失败（含 16 项持久化故障注入子测试与 6 项 SIGKILL 子测试），覆盖 create/record/recover 的 detached 语义、封闭 schema 与引用完整性、历史单调性与墓碑、create 前提（缺失/非空/别名目录）、canonical/checksum/domain/version 与 symlink/目录/FIFO committed entry 拒绝、每个持久化 syscall 边界的 before/after 故障毒化与 `commitStatus`、每 handle 队列 CAS 与 close drain、lossy JS 输入拒绝、revision 耗尽、release 后重获拒绝。故障注入围绕真实 syscall；SIGKILL 是真实子进程在 barrier 处被杀后重新 recover，**不是**掉电、内核崩溃、扇区撕裂或硬件缓存持久性证明。独立复核另跑 `.orrery/edit-lock-verification/store-review/independent.test.mjs`（30 项真实文件系统测试：真实部分写加注入 ENOSPC、passthrough rename 错误分类、既有目录生命周期与失败 create 恢复、canonical/重复键/UTF-8/checksum/缺失/symlink 拒绝、内核 cancel/resume 历史不被过度拒绝）全部通过，并复跑同一产品 suite 33/33。本批次产品全量 1021/1021 通过、147 suites。`store.js` 与 `resource-identity.js` 一样被 curated 清单排除（`types: []`），故另做本机直接 strict 检查（`--allowJs --checkJs --strict --types node`，`typeRoots` 指向本机既有 `@types/node` 22.20.1），exit 0、零诊断——同属**本机不可移植的补充证据**。
- **持久 operation history 单测**：`plugins/orrery-harness/test/edit-lock-operation-history.test.js` 32 项通过、0 失败（含 11 项 test-only publisher 子进程 SIGKILL 场景：create 的 prepared/publishing/directories/published/outcome-renamed/outcome 与 update 的 prepared/publishing/published/outcome-renamed/outcome），与 store 的 33 项合计 focused **65/65**；store suite 随镜像升 v2 只同步了 version 断言与非法 version 语料。覆盖 v2 同镜像与空 prepared、binding 冻结与 `ID_REUSE`、阶段图（不可跳过 publishing、不可删除/重绑历史）、transition-local 成功归属与 created 不收编、retained unresolved ownership 与晚到成功分类、无 TTL/不可清除/不可重绑的围栏、closeout append-only、真实 `wx`/`EEXIST` 与 checksum-valid 损坏拒绝且磁盘字节不变。子进程用真实 fs（create `wx`、update version guard + `r+`、真实 file/dir sync）。**测试 driver 不是生产 publisher**：只在专属无并发真实目录里演示顺序与重启结果，不是 host `ctx.fs` 集成、沙箱授权、别名等价、跨进程 CAS、runtime 取消竞态、旧令牌拒绝、manager fence admission 或创建功能启用的证据。独立复核另跑 `.orrery/edit-lock-verification/operation-history-review/independent.test.mjs`（18 项，修复前 16 pass / 2 fail、exit 1）全绿；产品全量 **1053/1053**（147 suites）。`operation-history.js` 与 `store.js` 一样被 curated 清单排除（`jsconfig.json` 只收无 `node:` 内建依赖的纯模块），故另做本机直接 strict 检查（`--allowJs --checkJs --strict --types node`，`typeRoots` 指向本机既有 `@types/node` 22.20.1），exit 0、零诊断——同属**本机不可移植的补充证据**，全程未安装依赖、未写类型 stub、未改仓库 TypeScript 配置。
- **独立复核发现并接受的边界（不是缺陷，也不是授权判定）**：独立装置确认「interrupted 由 true 翻成 false、epoch 2→3、且全程没有任何 receipt」的历史镜像会被存储接受（`.orrery/edit-lock-verification/store-review/independent.test.mjs`）。这是历史存储的既定性质：store 从不校验 receipt，也不构成 auth boundary。后续 manager **绝不得**把恢复出的 active 状态当作当前授权——显式恢复路径（Continue receipt）仍待实施。
- **当前安装版组件级核验（已完成，但不是产品验收）**：DSH desktop `0.2.0-rc.2`（asar 内 DSH 模块同版本、Cordis 4.0.4）上的四份有界运行证据，全部只覆盖组件，不覆盖完整 Loader/profile/GUI：
  - `.orrery/edit-lock-verification/current-dispatch/REPORT.md`：15 项检查。真实 `ToolRuntime.execute` 与 staged scheduler 两条派发路径、同作用域替换 stock `write`/`edit`、每次调用携带有效沙箱策略、取消 signal 传递、拒绝后字节不变、卸载 shadow 后为 `UNKNOWN_TOOL`。调用侧 agent 仍是 fixture，网关是探针实现。
  - `.orrery/edit-lock-verification/current-agent/REPORT.md`：14 项检查、2 个 factory 创建的 agent、10 个完整 turn。真实 `AgentRegistry.create → AgentLoop factory → ReactLoopAgent → scripted LLM → stock write/edit → turn/end`；该组合内父取消不级联子代理（结论限于 Agent factory/driver 本身）。
  - `.orrery/edit-lock-verification/current-ipc/REPORT.md`：15 项检查、14 个真实 turn、4 次成功发布。两个独立进程各自运行真实 agent，mutation 经可信父进程 IPC relay 进入第三个进程，由安装版 `ctx.fs.writeText/editText` 实际发布；旧 owner、版本失配、沙箱拒绝、取消、断连与管理器被 SIGKILL 均不产生越权写，且没有本地后备发布。
- `.orrery/edit-lock-verification/adapter/VERDICT.md`：12 项有界组件检查（最早的一轮，基于 `/tmp/dsh-src` 提取模块，版本 `0.1.7-rc.2`，**不等于当前安装版**）；同一装置其后用当前安装版模块重跑过同规模检查（`.orrery/edit-lock-verification/installed-gate-status.md`，`adapter/run-5GyOM6/evidence.json`），结论标签仍是组件级。报告明确记载：不是两个 Harness；身份与 policy 传输是 fixture；singleton 仅是同一目录的独占 mkdir；重启不恢复 authority。
- **未验收的硬门槛**：完整 Loader/profile 挂载（本会话工具目录没有 `plugin_manager` 与 `cordis_inspect`，按创建指引**不得**手写 profile 绕过）、双真实 Harness 的跨进程仲裁与单实例、可靠 intent/outcome 与崩溃恢复、可信执行意图入口（Continue receipt）、真实 GUI/浏览器传输。任一项未过，本特性不得启用。
