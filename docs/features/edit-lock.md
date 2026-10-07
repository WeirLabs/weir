# Edit Lock 编辑锁仲裁（edit-lock）

> **实验特性，默认关闭**：`orrery-harness/edit-lock` 已加入 `orrery` 预设（排在 hashline-edit／lsp 之前），只有在 Orrery 设置页打开「编辑锁（实验）」（`editLockEnabled`）并**重启 DeepSeek Harness** 后才生效；未开启时不安装编辑保护服务、工具或监听器。设置页只读维护面板独立保留。
>
> **版本**：特性分支 `dev/edit-lock` 单独维护版本号，已发布 `edit-lock-v0.1.0`（2026-10-02）与 `edit-lock-v0.2.0`（2026-10-03，UX 改版：回合末收尾、有期限保留、面板重做），见 [CHANGELOG.md](../../CHANGELOG.md)。两个版本都已完成人工验收（单会话与跨会话、状态面板与命令入口），并以实验特性形态随主分支 `0.7.0` 合入。
>
> **已知限制**：锁在回合结束时由助手释放或有期限地保留（异常锁除外）；shell 与外部编辑器的写入不在保护范围；不防恶意同用户进程；删除 `.orrery/` 会丢失锁历史与未决发布围栏；跨文件批量失败不做回滚；本机 publisher 通道不做认证（区别于经宿主浏览器认证的维护 HTTP 端点）。

## 概述

锚点校验与文件版本护栏只能证明「内容没有变」，不能证明调用者**仍然持有编辑权**：多个 Harness 进程（或同一进程内多个 agent）共享一个工作目录时，两个写者可以各自校验通过、先后落盘，形成一次静默覆盖。本特性把「谁有权写、这次写还作不作数」的判断收到工作目录级的单一仲裁点上，并让提交与释放、转交、人工解锁共用同一条顺序。

受影响的既有能力为 [hashline-edit.md](hashline-edit.md)、[lsp-integration.md](lsp-integration.md) 与 [todo-continuation.md](todo-continuation.md)；委派与续推调度、共享 runtime 消息、设置与客户端 UI 同在影响面内。

### 发布链路

**组合插件 `orrery-harness/edit-lock`**。预设中该行位于 `delegation` 组，组的 `isolate` 声明 `orreryEditLock: true`：预设注册表拒绝把服务发布到根 realm 的预设，因此提供者与全部消费者（todo-driver、hashline-edit、lsp）必须同组同 realm（`test/preset-realms.test.js` 守卫）。启用条件：行配置或设置 `editLock.enabled` 为 true（挂载时读取，改动需重启）。

**管理域**：每个 agent 在创建时按会话工作目录绑定一次管理根——位于 git 仓库内取仓库顶层（`git rev-parse --show-toplevel`），否则取工作目录本身；若某个上级目录已存在 `.orrery/edit-lock`，则并入该外层域，保证嵌套目录的会话共用一把锁。权威状态在 `<根>/.orrery/edit-lock/`（空目录新建，含 `snapshot.json` 则恢复，其余内容拒绝），预约在 `<根>/.orrery/.edit-lock.publisher-reservation`。git 仓库内首次打开时把这两项追加到仓库自身的 `.git/info/exclude`（worktree 感知，幂等），不改动任何受版本控制的文件。受控 write／hash_edit／lsp_rename 一律拒绝写入这两处（`Edit Lock authority files are not editable`）；shell 不在保证内，`git clean -fdx` 或手动删除 `.orrery/` 会丢失锁历史与未决发布围栏，下次启动按全新域处理。同一进程可同时持有多个根的域，按需打开。开发组合仍可用行配置 `{root, authorityDirectory}` 固定单一域。iCloud／Dropbox／网络盘不在支持范围。

## 用户可见行为

启用后（设置页「编辑锁（实验）」并重启），同一项目里的会话轮流编辑文件，而不是相互覆盖：

- **编辑即占用**。助手改一个文件时自动占用它；其他会话改这个文件会被拒绝，可以请求对方转交（`edit_lock_try_steal`）。
- **回合结束要收尾**。回合正常结束（`turn/end` 为 `completed`）而助手仍占着文件时，会被续推一次，要求它对每个文件二选一：改完了就释放（`edit_lock_release`），还要用就申请**有期限的保留**（`edit_lock_hold`）。提醒次数用尽仍未处理的，按设置自动释放（默认）或转为需要你处理。出错（`error`）走仅清理恢复，你按下停止（`aborted`）则不续推，二者都不进入此路径。
- **保留有上限**。单次保留与一批文件的累计保留都有上限（默认 30 分钟／2 小时），用尽后只能释放；延长一个仍在生效的保留只计新增的分钟数，且「从现在起的窗口」不得超过单次上限。没有永久保留——唯一能一直占着的是异常锁（出错或停止留下的锁），由你或助手处理。
- **保留中（holding）的含义**。会话已收尾但仍保留文件：其他会话照常被拒、转交照常协商；本会话自己仍可编辑这些文件，并且**一开始新回合，全部保留立刻解除**，回到普通占用。保留到期时会话空闲则自动释放；到期时恰在回合中，则在该回合结束时释放。
- **停止即收回后续编辑权**。你按停止（或面板「收回编辑权」）后，助手不能发起新的编辑，直到编辑权被恢复；已经调用文件系统的那一次提交会等待完成，仍可能落盘，但不会恢复会话权限。**默认开启「消息驱动的自动恢复」**：停止后你发送的下一条消息即被视作「继续编辑」，自动依次执行 `resume` 与 `confirm --all`（每个文件仍走原有确认检查），新回合可直接编辑；运行时注入的消息（续推、收尾提醒、恢复提示、后台通知）不触发，管理员撤销的会话永远是终态。设置页「编辑」组可关闭该开关，关闭后回到手动「继续编辑」。面板的「继续编辑」按钮与 `/edit-lock resume` 命令依然可用。
- **失效锁静默清扫（默认开启）**。锁的目标文件被 shell／外部编辑器删除或移走后（这些写入不在保护范围内），锁行仍会留在权威镜像里；持有会话已消亡时，以往只能逐把 `/edit-lock unlock <resourceId> <generation>` 人工清理。现在：任意会话收到一条**真实用户消息**时，会为该管理域调度一次静默清扫——在后台执行，不阻塞回合、不写对话、不通知——把「目标路径已不存在」的锁按普通释放移除（保留 generation 墓碑）。只有 `lstat` 返回 `ENOENT` 才算目标缺失（dangling symlink 不算）；释放前在仲裁点逐字段复核归属没有变化，未决发布围栏保护的归属绝不移除。每次成功释放写一条共享审计（`orrery/edit-lock-maintenance` 的 `stale-sweep`，含管理根、触发会话、owner、resourceId、generation），镜像在 `<管理根>/.orrery/audit.jsonl`。运行时注入的消息不触发；同一管理域 60 秒内至多清扫一次，成本不随会话数增长。设置页「编辑」组的 `editLockStaleSweep` 可关闭，即时生效。
- **崩溃自愈（预约回收＋死进程 unknown 自动结清）**。publisher 进程崩溃或被 kill 后，不再需要人工确认与清理：下一个打开该项目的 Harness 发现残留预约时，只要「租约已超时且登记 owner 被证明死亡（同主机、同 boot、pid 消亡或启动身份不符）」，就经串行化恢复锁自动回收预约成为新 publisher——挂起（SIGSTOP）的进程永远产生不了死亡证明，仅超时不会被偷取。恢复打开权威镜像时，凡能证明属于已死进程 incarnation 的 unknown 发布会在**同一次恢复提交**里被自动行政结清：准入阻塞解除、历史中的 unknown 结论与操作记录原样保留、该 owner 的锁释放且 epoch 撤权，你只会收到**一条**汇总通知；审计与 `adminRecoveries` 台账（actor 为 `automatic-dead-process-recovery`）保留完整明细。进程还活着、死活不明、无进程身份的历史存量、以及同一进程内重挂载产生的 unknown 一律不自动结清，仍走既有显式路径（离线 ADMIN OVERRIDE／解锁）。
- **状态入口**。输入栏右侧「编辑锁」按钮的圆点表示本会话状态：灰＝未占用文件，蓝（主题强调色）＝正在编辑／文件为本会话保留，琥珀黄＝编辑已停止或等你确认继续，红＝需要你处理。打开面板：
  - 只在需要时给**一个主动作**：已停止→「继续编辑」；等你确认→「继续编辑这些文件」；保留中→「立即释放全部文件」；正常编辑与空闲不给主动作。
  - 文件按短名列出，每行至多一个动作：自己的文件「释放」（待确认的为「继续」）；其他会话停住或出错留下的文件「解锁」（按当前 generation 解锁，需第二次点击确认）；其他会话正在编辑的文件不给动作。
  - 「收回编辑权」是危险动作，需要第二次点击确认。
  - 会话 id、epoch、generation、绝对路径都收在「技术细节」里。
  - 面板读取的是只读的结构化视图，不轮询、不写入对话；每个动作都是一次显式 `/edit-lock` 命令，留在对话中作为记录。
  - 收起方式：再点一次「编辑锁」按钮、在面板内按 Escape，或点击面板外的任意位置（document 级 `pointerdown`，落在本入口之外即收起，同时重置「收回编辑权」「解锁」的二次确认待击状态）。
  - **冷会话（重启后恢复、尚未激活）首读即真实状态**：面板对没有存活 agent 的会话不再永远显示「启动中」——端点回退到冷观察＋只读权威镜像，按镜像给出真实状态（已停止、已撤权、保留中、占用中）；冷视图不渲染任何动作按钮（写动作需要存活 agent 的命令通道），cold stopped 改为激活指引：自动恢复开启时「发送任意消息即自动继续编辑」，关闭时「发送消息激活后可手动恢复」。
- **模型可调用的工具**：`edit_lock_acquire`（显式占用既有文件；resume 后对 pending-confirmation 文件逐个调用即确认）、`edit_lock_release`、`edit_lock_hold`、`edit_lock_try_steal`（立即返回 pending requestId，从不等待持有者）、`edit_lock_pause`（只在仅清理恢复期间可用，单次 ≤15 分钟、累计 ≤30 分钟）与只读的 `edit_lock_status`。持有者有待答请求时才会临时多出 `edit_lock_reply`（`release`／`keep`），并在回合边界注销。
- 编辑工具的锚点校验、版本护栏、沙箱策略与 diff 输出不变；shell 与外部编辑器的写入不在保护范围内。
- **设置页维护控件（不依赖管理器是否运行）**。设置页「编辑」组在编辑锁设置下方多出「编辑锁维护」面板，任何时候都能打开——即使编辑锁已停用、管理器没挂上或已中毒：
  - **区分「已保存」与「实际挂载」**：面板给出 `强制执行中`（保存开，全部已安装行均启用）、`已请求停用——需要重启`（保存关，运行行仍启用）、`强制执行已停用`（保存关，全部已安装行均停用）、`已请求启用——需要重启`（保存开，运行行仍停用）及 `未知`。无挂载证据、多行决定不一致、安装/卸载未完成或失败一律未知；不把「没有证据」当成停用。开关对整个 profile 生效。
  - **初始化受阻可见**：管理器已挂载但某个域打开失败、或某个会话注册失败时，面板列出「初始化受阻」及原因，而不是只见开关。
  - **只读权威检查**：对每个服务端自己推导出的管理域，面板可只读检查其权威镜像——版本、revision、会话/锁/操作计数、**未决操作及其围栏范围**（单个文件／目录子树／整个工作目录）、保留的异常锁。检查不打开 runtime、不取预约、不写恢复，一个字节都不改。
  - **一键在线结清（publisher 进程活着时）**：只读检查列出未决操作时，若某个已中断 owner 的全部未决操作都是仍在阻塞准入的 `unknown` 且不持有任何 `prepared` 操作，面板给出「在线管理员恢复」卡片——完整 scope（管理根、owner、权威 revision、全部未决操作 ID）、风险原文与确认摘要（面板按离线路径同一算法**自行计算**并展示，与服务端实现对拍锁定）。点一次「在线结清该 owner」即在**运行中的管理器**里结清：不重启、不手打哈希、不停用功能；`unknown` 结论与操作历史原样保留，仅解除准入阻塞、释放该 owner 的锁并撤权。scope 若在加载后发生变化（revision 竞态），管理器拒绝，面板重新加载；恢复进行状态按「域＋owner」区分，一个域的完成不影响其他域同名 owner 的动作。该入口需要编辑锁已启用且该域在本进程打开（本进程是 client 时还需本进程有活会话承载通道）；进程已死走崩溃自愈，runtime 起不来走离线 ADMIN OVERRIDE。
  - **常驻警示**：面板明确「关闭强制执行**不会**清除未决操作、围栏或历史，重新打开后同一批文件可能再次被阻塞」，以及「普通解锁只释放一把锁且不校验内容，不是历史恢复，永远不会结清未知发布」。
  - **损坏可见、绝不自修**：权威镜像未通过完整性校验时，面板原样展示拒绝原因（`snapshot.json` 不是常规文件、目录有内容但无已提交快照、校验和/版本/域不匹配等），文件原样保留——不存在自动修复。
  - **不推断已消失的历史**：权威目录当前不存在或为空，只表示当前磁盘事实，不能证明此前从未初始化。维护内容作为错误边界的后代渲染；成功响应中若包含畸形数据，面板显示失败提示，关闭按钮仍可用。

### 管理员恢复（ADMIN OVERRIDE）

**定位与边界**：这是恢复可用性，而不是证明历史发布安全。对已中断 owner 的稳定 `unknown` 发布，管理员可主动承担旧写者稍后仍可能改文件的风险，不以旧写者静止证明作为前提；系统不再永久阻塞新 owner。它不修改目标文件、不重新发布、不改写原始结果、不把 `unknown` 伪装成成功或 `not-published`。离线 HTTP API 与维护面板的在线一键入口（见「在线管理员恢复」一节）均已交付，无新增配置项。

**一次原子变更**：精确备份原镜像并验证 SHA-256、字节数、canonical 格式、版本、域与所有不变量，文件及父目录 fsync 成功后，才提交 v5 镜像。`adminRecoveries` 必填审计行与 owner 的全部锁释放、epoch 递增、永久撤权在同一次 snapshot rename + directory fsync 内落盘。其他 owner、原 operations（包括绑定、outcome、closeout）逐字义保留；旧 operation ID 查历史，不重放，换内容复用 ID 仍拒绝。旧 owner 不能 reopen/resume/acquire，新 owner 仍须正常取得递增 generation 后才能发布。

**HTTP 交接契约**：`POST /api/orrery-edit-lock/maintenance/recover` 只注册到宿主 `connection.fetch`，依赖该 `/api` 通道既有的 Host/Origin 检查与已认证浏览器 cookie；不是模型工具或原始 HTTP server。操作者身份由服务端写为 `authenticated-settings-administrator`，不接受客户端 actor。`root` 必须精确等于 status 列表中服务端推导的 canonical root；检查在对客户端路径进行任何 IO 之前完成。

请求为以下八个字段（拒绝缺失及多余字段）：

```json
{
  "root": "<status 返回的根>",
  "owner": "<待撤销会话 ID>",
  "expectedRevision": 42,
  "operationIds": ["<该 owner 的全部未决 operation ID>"],
  "recoveryId": "<客户端生成并在重试中保留的唯一 ID>",
  "reason": "<管理员填写的原因>",
  "acceptLateWriterRisk": true,
  "confirmation": "ADMIN OVERRIDE <scope 的 SHA-256>"
}
```

确认摘要是递归按对象 key 排序、无额外空白的 canonical JSON 的 UTF-8 SHA-256（小写 hex），对象为 `{root, owner, expectedRevision, operationIds: [...operationIds].sort(), risk: 'Detached historic writers may still modify files after this override.'}`。界面必须让管理员看到并明确确认此 scope 与风险，不应静默代填确认。参考后端 `recoveryConfirmation()`；数组排序只用于 scope，不能重复 ID。reason 非空且 ≤2000 字符，recoveryId ≤128，owner ≤512，root ≤4096，operation ID ≤1024，操作数 ≤10000。

成功返回 `{ok:true,value:{revision,idempotent,record}}`，record 含 scope 摘要、时间、actor、reason、风险原文、原/新 revision、backup 文件名/字节数/SHA-256、每个旧操作的摘要、完整 releasedLocks 和 revokedEpoch。检查 API 的 `unresolved` 仍展示 `phase:unknown`，通过 `admissionBlocked:false` 和 `administrativeRecoveryId` 单独表达行政准入处置，另有完整 `adminRecoveries`。不要仅凭 unresolved 计数断言仍被围栏阻塞。

**失败、重试与运行时接入**：

- 恢复独占既有 publisher reservation，与 runtime 打开及其他恢复互斥。已有预约一律拒绝、不偷取；预约不存在也不声称旧写者静止。应先正常停用/排空当前 runtime；遗留预约必须另行处理，API 不负责删除。当前实现只接受 owner 已 interrupted 且所有未决操作均为 unknown；prepared/publishing 先经既有恢复规范化，不能用此入口推断结果。
- authority 与备份仅接受 ≤16 MiB 的单链接常规文件；拒绝符号链接及祖先路径变动，有限读取并核对 inode/size/mtime/ctime。此机制不防同用户恶意进程，支持 POSIX 本地文件系统，目录须由调用者控制；目录 fsync 不支持时不降级确认。
- 备份文件采用 `admin-backup-<SHA256([root,recoveryId])>.json`（0600，wx 创建），已有备份必须逐字节匹配。备份失败、冲突、输入/审计校验失败、rename 前失败均不修改旧 authority 或目标文件。备份是证据，**不是存在迟到写者时可以安全回滚的承诺**。
- rename 后失败可能已提交：HTTP 409 `{ok:false,error:{code,message,commitStatus}}` 只表示未确认，不保证回滚。`commitStatus:uncertain` 时先 inspect，再以完全相同 recoveryId/scope/reason 重试；重试验证已提交 ledger 和原备份，返回 `idempotent:true`，不重复释放或追加。revision 冲突则重新 inspect/明确确认；错误不会返回原始文件系统路径或堆栈。
- 权威 ledger 是原子强制审计；成功后另经共享审计发送 `orrery/edit-lock-maintenance` 的 `admin-override` 并 best-effort 写入根下 audit JSONL。不调用 `session.append`，镜像审计失败不否定已完成的权威提交。
- 普通镜像继续使用 v4，首次 override 才升级 v5；v2/v3 仍无损升级。旧构建拒绝 v5；禁止简单删 ledger 或恢复旧备份冒充安全降级。scope/checksum 是完整性绑定，不是防有权限编辑 authority 的恶意管理员签名。

**测试证据**：新增 `edit-lock-admin-recovery.test.js` 使用真实 store/manager/publisher 异常制造 22 把保留锁，验证备份、原历史不变、旧 token/owner/ID 非重放、新 owner 再获取并发布，以及备份/文件 fsync/rename/目录 fsync 故障、丢失确认幂等、预约竞争、ledger 防篡改和服务端 root allowlist。安装版宿主认证来源已核对；不把 mock connection 单测当作 GUI/HTTP 认证端到端测试，真实运行时和 GUI 验收由集成阶段完成。

### 在线管理员恢复（设计 D4）

进程活着时的 `unknown` 不再要求停用＋重启：同一套 scoped 确认作为**运行中管理器的一条 FIFO 可信事务**执行。

- **manager 事务 `adminRecoverOnline`**：在 FIFO 执行点对当前已确认状态复核——owner 已 interrupted、其全部未决操作都是 `unknown`、operationIds 精确匹配（排序比较）、expectedRevision 未动、确认摘要匹配（与离线路径**同一算法**：`{root, owner, expectedRevision, operationIds 排序, risk}` canonical JSON 的 SHA-256，`ADMIN OVERRIDE <hex>`）。随后在**同一次持久事务**里落盘：`adminRecoveries` 台账行（actor 为 `online-administrator`，与离线 `authenticated-settings-administrator`、自动 `automatic-dead-process-recovery` 区分）、该 owner 的锁全部释放、epoch 撤权、准入阻塞解除；`unknown` 结论与操作历史逐字不动。备份沿用 `admin-backup-<SHA256([root,recoveryId])>.json`，内容是**当前**已提交镜像的精确字节（store 在每次持久化后留存 `currentBytes()`），先于提交落盘。相同 recoveryId 的幂等重试返回既有台账行，不重复释放、不追加。确认摘要不符、revision 竞态、owner 未 interrupted、未决非全 unknown、operationIds 不符一律拒绝且不产生 revision、不写备份；备份写失败发生在提交前，管理器不中毒；只有提交本身失败才按既有纪律中毒。
- **不重启的一致性**：内核折叠（cancel＋逐锁 release）与 `administrativeState(base, record)` 的普通部分逐字节一致，持久化确认后同一事务安装内存内核——面板点击后立刻可编辑，权威镜像与内存从不分叉。
- **peer 通道**：`PEER_KINDS` 新增 `adminRecover`；publisher 侧执行**同一事务**，触发身份取自通道绑定的 agent（`agent.id`），**永不取自载荷**（载荷根本没有身份字段，多一个字段即被 manager 的精确字段纪律拒绝）。client 进程经自己某个活会话的通道转发；publisher 侧审计 `orrery/edit-lock-maintenance` 的 `admin-override-online`（含 root、trigger、owner、recoveryId、revision、idempotent、操作数），镜像在 `<管理根>/.orrery/audit.jsonl`。
- **HTTP 交接**：`POST /api/orrery-edit-lock/maintenance/recover-online` 由 edit-lock 插件注册在宿主 `connection.fetch`（同一认证通道）；`root` 必须精确等于**本进程实际服务**的域根（membership only，绝不因请求打开新域）；本进程是 client 时还需有活会话承载通道，否则 409 指引改用离线路径。拒绝只返回 `orrery-edit-lock/*` 错误码与通用文案（已知拒绝附安全 detail），409 `commitStatus:'not-acknowledged'` 与离线路径同语义。特性未启用或该域未在本进程打开时端点不存在，面板按不可用展示并指向离线路径。
- **面板一键确认**：只读 inspect 响应已含全部 scope 事实（revision、未决操作的 owner/operationId/phase/admissionBlocked、会话 interrupted，以及 `prepared` 操作清单——有 `prepared` 的 owner 在线恢复必被 manager 拒绝，面板依此不提供动作）；chunk 内重新实现 canonical JSON 与纯 JS SHA-256（浏览器无 node:crypto），**客户端计算**并展示摘要，点击即提交——确认动作仍在，消灭的是路径成本。chunk 对拍测试把客户端实现与服务端 `recoveryConfirmation`/`canonical` 逐字节钉死（含中文与 SHA-256 填充边界向量）；资格判定（owner interrupted ∧ 全部未决 unknown ∧ 仍阻塞 ∧ 无 prepared）与 manager 准入条件镜像；恢复进行状态以 `root＋owner` 为键（会话 id 跨域不唯一，一个域的成功不抑制另一域同名 owner 的恢复）。
- **测试证据**：`edit-lock-online-recovery.test.js`（manager 事务：确认不符/未 interrupted/非全 unknown/ID 不符/revision 竞态/幂等重试/无 root·备份器拒绝/台账 actor/备份先落盘/内核折叠等式＋单进程组合探针：活 publisher 不重启在线结清、围栏解除、审计 trigger）；`edit-lock-online-recovery-peer.test.js`（双进程探针：client 主机经 peer 通道结清活 publisher 的 unknown，trigger 取自通道、幂等重试、创建恢复准入）；`edit-lock-peer.test.js`（通道身份单测）；chunk 测试（资格分组含 prepared 排除、摘要展示、点击提交体、跨根恢复状态隔离、双语键）；`edit-lock-maintenance.test.js`（inspect 暴露 prepared 操作）；资格与跨根两条面板回归均经变异校验（变异即红）。
### 撤权后的会话呈现

被 ADMIN OVERRIDE 撤权的会话是**终态**：结构化状态视图为其报告独立的 `revoked` 状态（优先级高于 stopped/attention），面板显示「编辑权已被永久撤销」与一句原因说明，不提供「继续编辑」、确认、收回等任何动作——这些动作对终态会话不可能成功。普通 stopped 会话的「继续编辑」不受影响。

撤权判定只读 `adminRecoveries` 持久账本，重启后仍然成立，无迁移。`resume`、执行 receipt 签发、注册、获取等一切可信入口在**任何持久化之前**拒绝被撤权 owner：一次被拒绝的「继续编辑」不会给 authority 增加 revision 或残留 receipt。在同一工作区恢复编辑的唯一方式是开新会话——新 owner 走正常 acquire/publish，与被撤权会话的历史互不相干。

### 命令

| 命令 | 作用 |
|---|---|
| `/edit-lock status` | 本会话状态 |
| `/edit-lock locks` | 本项目所有被占用的文件 |
| `/edit-lock hold [minutes]` | 保留本会话的文件（默认取设置值） |
| `/edit-lock release <path>` | 释放本会话的一个文件 |
| `/edit-lock stop` | 收回本会话编辑权 |
| `/edit-lock resume` | 恢复编辑权；保留下来的文件转为待确认 |
| `/edit-lock confirm <path>` \| `--all` | 确认待确认的文件（`--all` 只对符合条件的文件逐个执行原有确认，不放宽任何检查） |
| `/edit-lock unlock <path> <generation>` | 按当前 generation 解锁他人留下的文件 |

## 配置

| 设置键 | 默认 | 说明 |
|---|---|---|
| `editLockEnabled`（设置页「编辑」组「编辑锁（实验）」） | `false` | 打开后重启 DeepSeek Harness 生效 |
| `editLockHoldDefaultMinutes` | `30` | 助手申请保留而未给时长时使用 |
| `editLockHoldSingleMaxMinutes` | `30` | 单次保留上限（从现在起的窗口） |
| `editLockHoldCumulativeMaxMinutes` | `120` | 一批文件的累计保留上限，须不小于单次上限 |
| `editLockNudgeAttempts` | `2` | 回合结束后最多提醒几次；`0` 直接按兜底处置 |
| `editLockNudgeFallback` | `release` | 提醒用尽后的处置：`release` 释放给其他会话，`abnormal` 转为需要你处理 |
| `editLockStaleSweep` | `true` | 真实用户消息触发管理域失效锁（目标文件已不存在）静默清扫；按消息即时读取，关闭后失效锁仍走 `/edit-lock unlock` 人工路径（设置页行随后续批次补齐） |
| `editLockAutoResume` | `true` | 停止后下一条真实用户消息自动恢复编辑并确认保留文件；即时生效，关闭后只能手动「继续编辑」 |

保留相关设置由 `editLockLimits` 统一解析：未设置取默认；设置了但不可用（非正数、默认大于单次、累计小于单次、非整数提醒次数、未知处置）时，保留申请按设置键名明确报错、不做静默钳制；回合末收尾、状态、释放、停止、解锁则对保留字段改用内置默认值继续工作（`editLockNudgeAttempts` 与 `editLockNudgeFallback` 仍按保存值生效，收尾提醒改为只要求释放）并记录警告，避免一个设置错误让文件无法释放。恢复与暂停参数为固定产品值：3 次／5 分钟、退避 15/30/60 秒、单次暂停 15 分钟、累计暂停 30 分钟、协商时限 120 秒。开发组合可在行配置写 `root` 与 `authorityDirectory` 固定单一域；该行须排在 hashline-edit 与 lsp 之前。

### 保留与回合末处理（设计）

- 保留是**会话级预算**，不是锁状态：镜像（version 3）新增 `holds` 表，每个已知会话一行 `{holding, holdUntil, holdCumulativeMs}`；被保留的锁仍是普通 `active`。version 2 镜像恢复时无损升级（每个会话补一行空保留）。runtime 打开失败时立即释放本进程刚建立的发布预约（未发布过任何内容，可证静默），避免同进程重试撞上自己的预约而降级为客户端；只有打开之后的崩溃或排空失败才保留预约交人工。注册失败的原因随 `unavailable` 视图返回，面板显示「编辑锁不可用」而非一直「启动中」。
- 内核先用 `holdCandidate` 计算新行，manager 在一次持久事务里安装，存储失败不会让内存领先于镜像。累计额度在一批内只增不减；最后一个锁释放即批次结束，该行归零（存储只在会话不再持有任何锁时接受归零）。
- 「新回合」按 `agent/pre-step` 携带的 turn 身份判定一次，而不是每一步都判定——否则保留会在申请后的下一步就被清掉。
- 到期以**读时结算**为准，定时器只负责及时：定时器丢失（休眠、挂起）只会推迟释放，不会改变判断；到期释放走普通释放路径（当前 generation），与在途发布共用 manager 顺序。跨进程客户端的到期由运行该会话的主机传入空闲状态并结算。
- 停止或异常的会话：保留立即失效，其锁按异常锁处理。重启恢复归属但不恢复正在运行的保留，已用额度不退还。
- 回合末提醒计数只存在内存：重启后会话以中断态开始、走另一条路径，计数丢失不会造成循环；由提醒自身触发的回合不重置计数，否则次数永远用不完、兜底处置永不执行。

## 设计细节

### 运行时接线（`src/edit-lock/index.js`）

- 挂载时捕获原始 `ctx.fs`，以跨进程预约打开唯一 runtime，并提供 `orreryEditLock` 服务。cordis 的兄弟行服务在其 apply 之后才可见，因此 `hash_edit` 同时接受挂载时与延迟 inject 的服务；一旦受管，服务移除只会拒绝，不回退直写。
- `tools/pre-execute` 守卫：`write`、`edit`、`hash_edit`、`lsp_rename`、`str_replace_editor` 中凡执行函数未经服务 `claim` 的定义一律拒绝。组合顺序错误、晚装服务或未知编辑器因此 fail closed。
- `agent/created`（发布前 await）安装写作用域：隐藏继承 stock write/edit，注册受控 write；随后注册会话。管理器已知的会话（重启恢复、同会话重建 agent）一律以中断态开始，不隐式重臂。
- **迟挂载补课绑定**：重启后首个会话的 preset 是为该会话自身挂载的，其主 agent 的 `agent/created` 事件已经过去（与 worktree-mode 守卫相同的挂载顺序隐患）。挂载时经 `ctx.get?.('agents')?.roots?.()` 枚举现存主 agent（无 agents 注册表的组合容忍缺席），对每个尚未绑定管理根的根 agent 运行与创建路径完全相同的 `setupAgent`——幂等，`registry.rootOf` 已绑定即跳过，绝不重复安装写作用域、重复绑定或重复 `domain.start`；子代理总在挂载之后创建，无需补课。**跨预设围栏**：`agents.roots()` 是进程级注册表，而创建监听器只会听到经本挂载冒泡的事件——补课必须显式判定归属，否则会把其他预设的存活 agent 绑进编辑锁（2026-10-05 宿主崩溃事故：绑定失败后的兜底 `restrict` 点名对方目录不认识的工具名，在 reload 期间升级为宿主致命错误）。组合内有 `agentPresets` 注册表时，以 `serviceFor(agent, 'orreryEditLock')` 解析到的服务实例与本服务同一性判定——只有本挂载保留的 agent 会解析到这个确切对象；无注册表的宿主级组合（如集成测试装置）维持全量补课。兜底拒绝自身绝不抛出：只点名该 agent 工具目录里实际存在的受控工具。
- active 回合内 stock Stop 同步触发 turn signal，立即封闭准入并持久撤权；idle Stop 没有 signal，使用 `/edit-lock stop` 获得可等待的持久撤权确认。`agent/disposed` 同样撤权。
- **消息驱动的自动恢复**（两阶段）：`agent/inbox/inserted`（回合前进站口，载荷携带 `{ agent, message }`）对真实用户消息（`isGenuineUserMessage`）置一次性旗标，开关按消息实时读取（`autoResume !== false`）；下一回合首个 `agent/pre-step` 在新回合检测处消费旗标，若会话非 active 则**在 `next()` 之前 await** 可信 resume（服务端铸造 `auto:user-message:<uuid>` 一次性 requestId）加 `confirmAll` 重放，保证该回合的编辑请求不再被拒。失败（revoked、与手动 Continue 竞争落败）仅告警放行。置旗点刻意不是持久的 `user/message` 会话事件：该事件在本运行时要到回合中途才落盘，晚于必须先行恢复的 pre-step（集成证据 `editlock-auto-resume`）。
- 可信人类入口 `/edit-lock`：`status`、`locks`、`hold [minutes]`、`release <path>`、`stop`、`resume`（以 commandId 作一次性 requestId 签发并消费 receipt，新 epoch，保留锁转 pending-confirmation）、`confirm <path>`／`--all`、`unlock <path> <generation>`。状态查询、后台通知与运行时注入消息都不恢复权限；`editLockAutoResume` 开启（默认）时，一条真实用户消息（`source.kind === 'user'`）等价于一次可信 Continue；todo 续推在会话非 active 时不触发。
- 面板数据来自只读端点 `POST /api/orrery-edit-lock/view`（`src/edit-lock/view.js` 构造的结构化视图），不从命令文本里推断状态；`connection` 是 host-plane 服务，隔离 realm 不影响它。解析链是冷读安全的：存活 agent（现状）→ `sessionQuery.observeSession` 冷观察（取 `header.cwd`，绝不激活会话）→ `managementRootFor` 推导管理根 → **只读**权威镜像（`read-authority.js`，与维护 inspector 同一纪律：有界 ≤16MiB、`O_NOFOLLOW`、读前读后身份核对、`parseSnapshot` 校验；不打开 runtime、不取预约、一个字节都不改）。冷会话视图由 `buildColdView` 把镜像映射成与存活读取相同的输入：interrupted→stopped、`adminRecoveries` 撤权→revoked 终态、自身锁与全域锁、保留按读时结算对 `now` 计算；顶层带 `cold: true` 与 auto-resume 开关值。publisher 与 client 两种模式都从本地镜像读取回答（权威是共享文件系统上的本地文件），不新增 peer kind。会话无法冷观察、工作区无权威或镜像损坏时返回带**明确 reason** 的 unavailable（面板显示「不可用＋原因」），不再退化为无 reason 的「启动中」——无 reason 的「启动中」只剩一种情形：agent 存活但其 domain 仍在启动（或启动失败的原因未知）。写动作（resume/release/unlock/清扫）不新增冷通道。
- **多挂载路由（fix-edit-lock-view-multi-mount）**：`orrery` 与 `orrery-creative` 等多预设同进程共存时各自挂载 edit-lock，而视图/在线恢复端点是进程级全局路由（宿主 `connection.fetch.register` 同路径重复注册抛错，先挂者胜出、后者容错跳过）。视图 handler 对存活 agent 经 `agentPresets.serviceFor(agent, 'orreryEditLock')` 路由到**所属挂载**的 `describe()` 构造视图——答案与挂载顺序无关；无预设注册表的组合回退挂载本地路径。`describe` 失败（绑定失败/懒绑定已拒）返回带原因的 unavailable，无原因「启动中」只剩真实启动窗口。
- 插件卸载撤销所有会话、排空发布，再释放预约；失败保留预约供人工核对。apply 写成箭头函数：cordis 会以 `new` 构造带 prototype 的回调并丢弃其返回的 disposer。

### 预设切换重绑定与绑定自愈（设计 D1–D4，变更 edit-lock-binding-self-heal）

- **问题形态**：会话创建后的 blank 窗口内切换预设（如 `orrery` → `orrery-creative`）时，宿主走 `select → recompose → bind`，只 emit `tools/change`、**不重发 `agent/created`**——新代挂载的 `setupAgent` 对该 agent 永不运行，编辑锁绑定随旧代挂载孤儿化，一切受管写入被永久拒绝（两起实证事故）。受管 write 注册在 agent **自有作用域层**，rebind 不 dispose 自有层，因此重安装必须先 retire 旧层，否则撞 duplicate-register——这正是早期连手工重绑也会失败的原因。
- **D3 可重入前置**：写作用域的 disposer 存入按宿主键控、按 agent 键控的宿主生命期容器（`write-scopes.js`），不随 mount 销毁；任何重安装（切预设/重应用/懒绑定）先 `disposeWriteScope` 同 agent 旧层再注册；`agent/disposed` 时随 agent 释放。卸载刻意不拆除受管 write——gap 期拆除会暴露 stock 直写。
- **D1 预设切换重绑定（消窗）**：订阅宿主转播的 `agent-preset/selected`（rebind 落地后 emit，载荷为 sessionId），对本预设 root agent 重跑幂等 `setupAgent`；切到 foreign 预设过 `ownAgent` 栅栏不绑。监听器按 serial-bail 纪律返回 undefined。
- **D2 守卫懒绑定（兜底）**：pre-execute 守卫与锁工具路由（`domainFor`）遇到「本预设 root ∧ 无绑定 ∧ 本代无失败记录」时先做一次幂等重绑定再判定；成功后写入正常走锁。失败则拒绝文案点名真实原因（无 Edit Lock 域、setup 失败原因）与恢复动作（重启或新会话），且**本代不再重试**（startFailures 抑制）；子代理（delegationDepth>0）与 foreign 预设永不尝试。
- **并发幂等**：所有入口（创建/切预设/补课/懒绑定）共享按 agent 的 in-flight setup（`setupAgentOnce` + `setupInFlight`），并发调用绝不重复注册。
- **D4 失败四联**：写作用域安装/registry 绑定失败从仅 `logger.warn`（运行时无读者的 ring buffer）升级为四面留痕——startFailures（状态面板可读原因）+ `evidence.recordSessionFailure`（维护面板）+ 会话内 `deliverLocal` 通知（点名编辑已禁用与恢复动作）+ 冷读安全审计（`setup-failed`）；warn 保留为第四份。绑定失败从此不再静默。

### 消息触发的失效锁清扫（设计）

- **触发与调度**：`agent/inbox/inserted` + `isGenuineUserMessage`（与消息驱动自动恢复同一挂点，运行时注入消息天然排除）为**该会话的管理域根**调度一次清扫。调度按域根聚合在 `src/edit-lock/stale-sweep.js` 的 `createStaleSweepScheduler`：单飞 + 60 秒冷却（自完成时刻起），零延时定时器 **detached 派发——回合绝不等待**（不同于必须先于首 step 的 auto-resume）；冷却已过期的空闲条目在每次调度与任务完成时回收、`close()` 清空注册表，键数不随历史域数无界增长。`editLock.staleSweep` 按消息即时读取（`!== false` 即开）。插件卸载 `sweeps.close()` 取消全部未派发工作；agent dispose（`disposedAgents` WeakSet 标记）取消其 arming 的未派发工作——派发前与 `registry.forRoot` 兑现回调内各检一次，域打开 pending 期间的 dispose 同样取消，不为已 dispose 的 agent 提交维护事务；已提交的权威事务永不打断、永不 reinterpret。
- **失效判定**（`isMissingTarget`，publisher 侧执行——它与权威共享文件系统，客户端进程只负责触发）：对域内每一锁行 `lstatSync(resourceId)`，**仅 `ENOENT`** 计为候选；lstat 成功（含 dangling symlink）与 `EACCES`/`ENOTDIR`/symlink 环等其他错误一律跳过。不追踪被移动的文件、不把别名解析成替代身份、不为缺失路径构造资源键。
- **仲裁点条件释放**：manager 新增可信维护入口 `releaseStale(observed, isMissing)`。每行各走一条 FIFO 事务，在**执行点**逐字段复核观察行——owner、generation、owner executionEpoch、锁状态——并**再次 lstat** 确认目标仍缺失；全部满足才走普通 `operations.release`。任一不满足、行已消失、或既有未决发布围栏准入拒绝（与 `adminUnlock` 同一条 release-mode 准入，未决 update 必需的归属永不移除）都是**跳过而非错误**：丢弃 draft、不产生 revision、不影响其余行。范围是域内全部锁行，不限 owner 状态（active、holding、pending-confirmation、user-interrupted、abnormal 一视同仁）——谓词钉死「观察时刻的行状态」，观察之后归属发生任何变化即自动跳过。`isMissing` 探针注入，manager 层不做文件系统 IO。
- **静默但可审计**：不写对话、不通知、不 `session.append`（§3.6 红线）。每次持久化成功的释放由 **publisher 侧**经 `createEditLockLifecycle` 的 `onStaleRelease` 钩子发共享审计 `orrery/edit-lock-maintenance`，`data.kind: 'stale-sweep'`，携带 `root`（管理根）、`trigger`（触发会话）、`owner`、`resourceId`、`generation`；JSONL 镜像经 `createAudit` 的显式 `root` 锚定 `<管理根>/.orrery/audit.jsonl`。跳过（行已消失/谓词不符/围栏拒放）静默只计数；失败（持久化/poison/意外）由 `releaseStale` 计入 `failed` 列表，lifecycle 对每个失败发恰好一条有界 `ctx.logger` 警告（跳过不产生日志）。权威镜像中体现为普通 release（generation 墓碑保留；owner 最后一把锁消失时 holds 行按既有内核语义归零），不新增历史表，不改围栏、操作历史或恢复计数。
- **跨进程接线**：`lifecycle.sweepStale(triggerSessionId)` 同时暴露到 peer 通道（`PEER_KINDS` 新增 `staleSweep`）；客户端域 `sweepStale` 转发通道调用，publisher 侧 peer 以**通道自身会话**（`agent.id`）为触发会话执行扫描——扫描永远发生在 publisher，客户端只是触发。聚合的权威也在 publisher：`sweepStale` 内置单飞 + 60 秒冷却（in-flight promise + 完成时刻时间戳），运行中的触发 **join** 同一扫描（共享结果、不重复审计），冷却窗内的触发返回 `coalesced: 'cooldown'` 结果不再扫描——两个协作进程各自带客户端冷却也不会并发清扫同一 authority。IPC 应答丢失不会重复释放：重放的同一观察行在执行点已不复存在，按「行已消失」跳过（幂等）。

### 预约租约与死证回收（设计 D1）

- **owner doc 与续约**：预约目录内发布 `owner.json`（schema 对齐 capabilities OwnerDoc：`pid`/`host`/`startIdentity{osStart, bootNonce}`/`acquiredAt`/`leaseUntil`），持有者每 10s 续约（temp+rename 原子替换，崩溃只留孤儿 temp 不留撕裂 owner doc）。租约默认 30s、续约 10s（spike 0.1 实测：空闲与 8× IO 加压下续约 p99 < 0.3ms，10s 周期内 3 次续约机会使单次 <30s 的事件循环 stall 不会误过期；SIGKILL 后完整回收实测约 18ms）。
- **回收判定（立场反转，替代「Never steal by timeout or PID probe」）**：后来者遇 `EEXIST` 读 owner doc——租约未超时或 owner 存活（Liveness 双因素：bootNonce＋osStart）→ 照旧成为客户端；**租约超时且 owner 被证明死亡** → 经 `<reservation>.recover` 串行化锁回收。恢复锁在整个「接管 → 预约替换 → 清理」序列中保持**真正独占**：①接管被遗留的恢复锁时，在等待死证之后、改名让位之前复核「目录仍是当初观察到的那个」（dev/ino 一致＋owner doc 逐字一致），陈旧观察绝不可能把**活跃**回收者的锁改名让位；②接管后立即发布自己的 owner doc 并把锁锚定到自建目录的 dev/ino 身份；③主预约改名让位前再次复核（a）恢复锁仍携带自己的身份与 owner doc、（b）主预约仍指向同一死 owner，任何漂移即放弃回收；④清理只在恢复锁仍是自建目录时删除，落败者绝不删除胜者的锁。其余一切（owner doc 缺失/损坏/状态不明、锁身份漂移）一律 fail closed 成为客户端。
- **续约只会写进自己创建的目录**：续约前按 dev/ino 复核预约未被替换，写失败即 fail closed（独占断言此后必败），不会把租约写进别人的预约。`releaseAfterQuiescence` 语义不变：排空失败保留预约（含 owner doc，仍可被同一死亡证明规则回收），绝不递归删除。
- **残留窗口**（design Risks 已登记）：SIGSTOP 挂起的 publisher 不产生死亡证明，不会被误收；真正的理论窗口是 pid 被 OS 复用且启动身份比对同时失效的极端组合，由 bootNonce＋osStart 双因素＋串行化复读对冲。

### incarnation 进程身份与死进程 unknown 自动结清（设计 D2/D3）

- **v6 镜像注册表**：镜像为每个 manager incarnation 记录 `{incarnation, process: {pid, host, osStart, bootNonce} | null}`（取自与预约同一个 Liveness 适配器）。v4/v5 镜像在**首次身份感知的写入**时无损升级：既有 incarnation（含全部 operation origin 与上一 manager incarnation）补 `process: null`——种子顺序与校验器从**未改动的前像**推导的顺序逐字节一致（前像当前 manager incarnation 在前，operation origin 按出现顺序随后），新 incarnation 追加在末尾；旧 build 按既有版本纪律拒绝 v6，v6 缺注册表/注册表被改写（重排、回填、增删条目）同样 fail closed。注册表条目不可变，普通转换只允许追加「当前 manager incarnation」一条。
- **自动结清判定**（恢复打开时逐 owner）：该 owner 未被撤权、恢复后处于 interrupted，且其**每一个**未决 unknown 操作的 origin incarnation 都登记了进程身份、该身份与当前进程不同（pid＋bootNonce 判定，同进程重挂载永不结清）、且 Liveness 证明该进程已死——三者缺一即保持人工路径。安全论证与人工 ADMIN OVERRIDE 的人脑担保相同：全部写只发生于 publisher 进程内，进程死亡 ⇒ 其生命周期全部 detached writer 死亡 ⇒ 迟到写者风险结构性归零。
- **一次持久提交**：结清与恢复合并为同一次 snapshot 提交——台账行复用 v5 `adminRecoveries` 结构（actor 记 `automatic-dead-process-recovery`，scope 确认摘要由服务端自算自记，同一提交的多个 owner 共享 expected/committed revision），unknown outcome 与操作历史逐字保留，仅准入阻塞解除，owner 的锁释放、epoch 撤权。备份沿用 `admin-backup-<SHA256([root,recoveryId])>.json`：内容即恢复时读到的前像字节，在提交前落盘（temp+rename＋目录 fsync）。提交后安装的内核按**结清后**的最终镜像重建，内存权威与磁盘一致。
- **审计与通知**：每次恢复至多一条共享审计（`orrery/edit-lock-maintenance` 的 `automatic-recovery`，含 root、revision、owners、recoveryIds、操作数）与至多一条汇总用户通知（排队给该域第一个完成注册的 agent；已撤权 owner 永远跳过，第二次恢复不会重复结清也不会重复通知）。
- **不自动结清的情形**：null 身份（含 v4/v5 时代的历史存量与身份缺失恢复的 incarnation）、同进程重挂载、Liveness 判活或判不明、owner 已被撤权。这些仍走显式路径：进程活着时的维护面板一键在线结清（见「在线管理员恢复」），或 runtime 起不来时的离线 ADMIN OVERRIDE。

### 独立维护边界

- profile 设置行提供维护端点与证据入口，不依赖 `orreryEditLock` 或恢复器。每次 preset 挂载持有独立代次；旧 disposer 只删除自己的证据，排空失败保留失败状态。证据按宿主根 context 存在 WeakMap 中，同一模块的设置行重挂载不遗忘仍活跃的行；模块整体替换/进程重启不继承内存证据。
- `POST /api/orrery-edit-lock/maintenance/{status,inspect}` 通过 `connection.fetch.register` 注册；安装版宿主先执行 Host/Origin fence 与浏览器会话认证。根只由存活 agent 的 cwd 经 `managementRootFor` 及挂载记录推导；客户端必须原样选择返回的根，成员检查先于对客户端路径的任何文件操作。
- inspector 拒绝根以下及祖先中的符号链接，快照使用 `O_NOFOLLOW | O_NONBLOCK`、文件描述符身份与读前后路径/metadata 核对，最多读取 16 MiB；平台不提供 `O_NOFOLLOW` 则拒绝。只复用 store 的镜像验证器，不打开 runtime/预约、不恢复、不修复，检查前后权威字节不变。
- **不是恶意并发目录改名的原子隔离证明**：Node 无便携 `openat`，上述身份核对能拒绝观察到的路径替换，但不能排除恶意同用户进程的 ABA 命名空间竞态。不要把此维护入口暴露为不可信文件系统的读取代理。
- 开关提交仅记录 enable/disable 意图，走共享 `createAudit`（事件及有服务端工作目录时的 JSONL 镜像），不写自定义 session 事件。只读检查不写审计；无工作目录时只 emit，不退回开发进程 cwd。共享审计镜像沿用既有 best-effort 文件系统语义，不宣称具有 inspector 的路径保护。

### 模块与职责

| 模块 | 职责 |
|---|---|
| `state.js` | 状态内核：纯内存、不接触文件系统，分离资源 owner、generation、会话 epoch 与 manager incarnation，回答「按当前归属与执行授权，这次操作该接受还是拒绝」；保留额度由 `holdCandidate` 在同一内核里计算。 |
| `resource-identity.js` | 规范资源身份：同步、只读地观察真实文件系统，回答「这个路径此刻对应哪个规范资源身份，与上次观察是否仍是同一拓扑」。 |
| `store.js` | 历史快照镜像（version 4，含 `holds` 保留表）：规范 JSON + SHA-256 校验、写序持久化、串行本地 revision CAS；只保存与读回**历史事实**。 |
| `manager.js` | 唯一仲裁队列：`openSession`／`acquire`／`cancel`／`cancelSession`／`status`／`hold` 等 mutation 在一条 FIFO 上串行，持久确认后才安装；`prepare`／`commit` 让实际发布在队列里至多发生一次。 |
| `operation-history.js` | 与快照同一镜像的持久 operation history：操作身份、绑定、阶段、结果、围栏与 closeout 的封闭历史层。 |
| `runtime.js`／`reservation.js`／`reserved-runtime.js` | 域打开：先以原子 mkdir 抢占 authority 同级预约目录，再打开 runtime；打开失败即释放预约。 |
| `lifecycle.js` | 宿主生命周期控制器：显式 start／stop／close，撤权与实际提交在管理器里排序；resume／confirm 只作可信人类入口，绝不注册为工具。 |
| `publisher.js`／`host.js`／`adapter.js`／`call-context.js`／`write-tool.js`／`tool-scope.js` | 发布与宿主适配：捕获原始 `ctx.fs`、把真实 agent 对象绑定到已注册 execution、以单次消费的进程内 call context 发布受控 write。 |
| `remote.js`／`peer.js`／`peer-transport.js`／`peer-client.js`／`remote-service.js` | 跨进程：同一 authority 目录的第二个 Harness 成为唯一 publisher 的客户端，工具、命令与协商经本机通道转发。 |
| `negotiation.js` | 转交协商（`try_steal` → 持有者答复）：请求只存在内存，120 秒答复窗口。 |
| `recovery.js` | 仅清理的自动恢复：3 次／5 分钟、退避 15/30/60 秒、暂停单次 15 分钟／累计 30 分钟。 |
| `settle.js` | 回合末收尾：仅 `completed` 回合进入，提醒次数与兜底处置由调用方作为策略传入。 |
| `view.js` | 面板结构化视图：纯函数（无 IO、无时钟，`now` 由调用方给），面板的颜色与动作只由这个形状决定；`buildColdView` 把只读权威镜像映射成同一形状并附 `cold` 标记。 |
| `read-authority.js` | 只读权威镜像读取的共用纪律（维护 inspector 与冷视图共用）：祖先固定、`O_NOFOLLOW` 有界读取（≤16MiB）、读前读后身份核对；不存在/无快照/非常规文件/不可读按事实分类，绝不修复。 |
| `domains.js`／`domain.js` | 管理域解析，以及发布者与客户端两种组合的统一接口（`service` 是唯一到达工具的通道）。 |
| `stale-sweep.js` | 失效锁清扫：ENOENT-only 缺失目标判定 + 按管理域根聚合的 detached 调度器（单飞 + 60 秒冷却，时钟/定时器/任务注入；冷却过期空闲条目回收，`close()` 清空注册表）。 |
| `incarnations.js` | incarnation 进程身份注册表（v6）：引用收集、无损 null 种子、注册表转换纪律（`expectedRegistry`/`isRegistryUpgrade`/`withIncarnation`）与镜像校验（`validateIncarnations`）；纯函数，无 IO。 |

### 状态内核与授权

内核区分资源 owner、generation、会话 epoch 与 manager incarnation，所有权限判断都基于这四组身份：当前凭据只在**入口**校验，撤权队列执行时使用该会话最新已安装的 epoch，避免前置的 resume 安装导致撤权因 stale epoch 落空。会话闩锁保留在会话层：启用本特性的会话即使在**首次 acquire 之前**就被停止，或**最后一个锁已被释放/受控解锁**，也必须收到可信执行请求才重新武装编辑续推——显式的 Continue（面板／`/edit-lock resume`），或在 `editLockAutoResume` 开启（默认）时一条真实用户消息（自动 resume + confirm-all 等价序列）；状态查询、后台通知、运行时注入消息、release 与解锁都不清除它。`edit_lock_status` 每行给出 `generation`——只靠 status 判断「锁是否已到手」时，generation 变化是所有权真正易手的可靠信号（通知里也带 generation）。

内核的持久化经候选草稿完成：`checkpoint()` 导出 detached generations 与 issuedRequests 墓碑，`begin()` 在分离的内核上复用同一 transition，`install(draft)` 一次性安装本内核当前 revision 的候选、`discard(draft)` 关闭候选；任何 live mutation（包括被拒绝的）都保守地使旧 draft 过期。issuance 先持久 requestId 墓碑、安装后才返回进程内 receipt；resume 先消费一次性 receipt、持久后安装新 epoch，保留锁仅进入 pending-confirmation，不自动重臂。复制/伪造 receipt 与重复 requestId 拒绝，receipt 不序列化、不跨重启恢复，未知会话与其他 incarnation 的引用一律拒绝。

### 规范资源身份

`src/edit-lock/resource-identity.js` 导出 `createResourceIdentity()`，提供同步 `resolve(filePath, { cwd })` 与 `revalidate(observation)`：

- 既有普通单链接文件 → 冻结的 `{ kind: 'file', resourceId }`，`resourceId` 是 native canonical realpath。
- 缺失目标 → 冻结的 `{ kind: 'missing', ancestor, suffix }`：`ancestor` 是最后存在的规范祖先，`suffix` 是逐字未解析后缀。**缺失观察没有 `resourceId`**，不构成创建键，也不发放任何形式的所有权或发布权；缺失名称的创建走「创建协议」一节。
- `revalidate` 只接受本 factory 自己发出的**原对象**（私有 WeakMap 持有）；副本、其他实例的观察与 `null` 一律按 `unknown observation` 拒绝。
- 观察按构造冻结，不可伪造 `resourceId`，也不携带可序列化的证据。

语义边界：不折叠词法 `..`（`alias/../file` 按 alias 的物理目标解析），不做大小写或 Unicode 归一（本卷把 case 与 NFC/NFD 别名合并为同一 native realpath——测试只记录该卷实测结果，不推广为所有文件系统的等价规则）；忽略内容、时间戳与兄弟文件变化。连续性证据由 entry 与 canonical 祖先链的 dev/ino、逐跳 symlink target 共同构成：文件替换、symlink 替换/改向、祖先替换、新 symlink 祖先与 kind 变化一律 `topology changed`；新增硬链接则使目标不再满足「单链接普通文件」，`resolve` 与 `revalidate` 都直接拒绝（`not editable`）。普通新目录被创建时 `revalidate` **返回一个新的缺失观察**：调用方必须改用并保留这个新观察，原观察只作历史，之后新 symlink 祖先出现时两者都拒绝。

平台与失败语义：仅 darwin/linux，其他平台 factory 直接抛错（Linux 只经代码路径允许，未实机验证）；目录、dangling symlink、symlink 环、特殊文件、`nlink > 1`、`missing/..`、相对 cwd、空路径与含 NUL 路径全部拒绝，不做本地无锁后备。

### 历史镜像与 operation history

`src/edit-lock/store.js` 提供 `openEditLockStore({ directory, domainId, mode: 'create' | 'recover' })` → `snapshot()` / `record({ expectedRevision, nextState })` / `close()`，是**持久化历史，不是授权来源**：

- **封闭历史镜像**（普通 version 4；管理员恢复后 version 5 增加 `adminRecoveries`；身份感知 manager 首次写入升级 version 6，增加 `incarnations` 进程身份注册表与可能为空的 `adminRecoveries`）：managerIncarnation、sessions（sessionId/executionEpoch/interrupted）、generations（含 release 墓碑）、locks（resourceId/owner/generation/status，abnormal 必须带 reason）、issuedRequests（去重历史）、recovery（累计 charge）、holds 与 operations。除 schema 校验外还强制历史单调：epoch 与 generation 不得倒退、interrupted 翻转必须前进 epoch、issued request 不可删除、recovery 计数只增、同 generation 的 abnormal 结论不得清除。
- **版本迁移与降级**：读取接受 version 2／3／4／5／6，校验原始字节后将 v2/v3 无损迁移到 v4；v4/v5 在身份感知 manager 的首次写入时无损升级 v6（既有 incarnation 补 null 身份，null 永不参与自动结清）；v2 补空保留行，v3 只改版本。历史 closeout 仍只有 `kind`／`assertionId`，不会被升级成解除围栏的证明；旧版本中夹带 bound record 会被拒绝。单独打开不改磁盘；没有 override 时下次成功写入 v4，已有 ledger 则继续 v5，已升级 v6 则继续 v6，不能降级丢弃。旧 reader 必须拒绝不支持的版本，不能忽略字段继续运行。不支持的版本报出实际版本与支持范围。恢复方式是使用较新的 build；不能手改版本号，不能用备份抹掉仍可能发布的操作。
- **规范编码与完整性**：object key 按 UTF-16 排序、无空白、数组保序的 canonical JSON；`{version,domainId,revision,state}` payload 加 `{payload,checksum}` envelope，checksum 为 SHA-256。读取要求严格 UTF-8、**逐字节**等于重新规范化的结果（每一层的重复键、非规范数字/转义写法、空白与乱序因而全部被拒绝）、精确 schema 与 version/domain/revision/checksum 一致。checksum 只检测意外损坏，**不是**认证，也不防回滚。
- **写序与确认**：独占 sibling temp（`wx`、0600）→ 全量写入 → file sync → file close → rename → 目录 open（`O_DIRECTORY|O_NOFOLLOW`）→ 目录 sync → 目录 close，之后才确认并更新内存。失败不回滚、不删 temp、不提升遗留 temp；rename 之后的不确定性保守记为 `uncertain`。
- **串行本地 revision CAS**：每 handle 一条串行队列，`expectedRevision` 与当前 revision 不符即 conflict，溢出拒绝且不写入、不毒化。这是 **handle 内**的 CAS，不是跨进程/跨 handle CAS，也不是单实例选举。
- **持久化 IO 失败毒化整个 handle**：任何持久化失败（含真实 syscall 错误）都毒化 handle，排队中与后续的 `record` **连同 `snapshot()`** 一律拒绝——过期内存不得冒充回滚后的状态；参数、CAS、transition 与溢出错误不毒化。错误 code 为 `EDIT_LOCK_STORE_PERSISTENCE`，`commitStatus` 区分 `not-renamed` 与 `uncertain`。
- **外部前提由调用方证明**：模块要求调用方在**模块之外**证明该目录的独占生命周期与旧 publisher 静默，并持续到 `close()`；目录需预先 provision，`create` 只接受空目录，目录与其祖先不得被并发替换。模块不提供 singleton election、PID 超时接管、租约或 handover。
- **恢复语义**：`recover` 只读 `snapshot.json`，拒绝 symlink/特殊文件/目录，并在打开前后两次确认 regular file；committed snapshot 缺失或非法即失败，**不初始化、不修复、不重试 create**，合法 committed snapshot 可与遗留 temp 共存。面向支持文件与目录 sync 的 POSIX 本地文件系统；不承诺网络文件系统、Windows 或掉电硬件语义。store 只写自己的 `snapshot.json`，不签发也不保存 receipt（receipt 是进程内能力，禁止持久化）。

**持久 operation history**（`src/edit-lock/operation-history.js`）与既有权威状态同处**同一份原子 snapshot 镜像**（envelope、canonical 编码、写序与串行 revision CAS 全部不变），**没有**独立的第二本内存账本：

- **键与查询**：域内键是 `(sessionId, operationId)`；`lookupOperation` 优先查历史、**不检查当前 authority**、返回 detached 数据，同一键换 binding 即 `ID_REUSE`（绑定按结构比较，与键序无关）。origin（executionEpoch/managerIncarnation）是不可变历史、**不是重试键**；调用方认证与授权属于 manager。
- **冻结的 binding**：tool（`write`/`hash_edit`/`edit`/`lsp_rename`）、原始 filePath、绝对 cwd、request/args/payload 三个 SHA-256 摘要，以及目标与冻结策略（create → `createIfAbsent`；update → `replaceIfVersion` + version）。**存入的字符串不等于认证**：摘要由可信 publisher 按规范请求、原始参数与实际 payload 字节自行计算。`FsVersion` 作为宿主提供的不透明字符串保存：允许空串与含 NUL 的字符串，JSON 恢复后原样保留，不解析格式、不强制转换类型。
- **通道划分**：create 仅允许受控 `write`，`hash_edit`/`edit` 只更新既有资源。prepared create **不含 resourceId**、不发放任何所有权，同一目标的多个 prepared 意图可以共存。
- **持久阶段与合法转换**（raw `store.record` 同样强制，不只是恢复时）：prepared → publishing → created/updated/unknown；prepared → not-published **仅**表示 dispatch 前的取消或拒绝；不能跳过 publishing；普通 raw record 的 publishing/unknown 不得改写为 not-published，唯一例外是「发布前取消」入口的私有未调用证明（unknown 无例外）；历史条目不可删除、不可重绑、origin 不可重写。
- **成功归属是 transition-local**：同一次 before/after 里，成功 outcome 必须有匹配 owner/generation 的锁，且 created 不能收编既有锁（要求该资源此前无锁）；同一次转换里同一份新增 ownership 不得归给两个 operation。完成历史在后来 release 之后保留，不因当前无锁失效；但 owner 转手或 epoch/incarnation 前进时保留的锁必须记为 interrupted/abnormal，不得是 active。未结算 update 保留原归属，不能经 release/transfer/re-generation 绕过。
- **围栏与 closeout 都是历史断言**：update 用 resource fence，create 用观察到的祖先子树（`observed-ancestor`）、保守祖先（`conservative-ancestor`）或 containment-unproved 的 domain 断言；closeout 是 append-only 的 `{kind, assertionId}`（`abandoned-unknown` / `not-published-evidence`），只允许出现在 unknown 阶段。本层只验证结构与词法包含，**不认证**文件系统/别名证明，也不实现 unrelated-work admission；**没有 TTL**、不按名字猜等价、不自动升级为全域围栏；围栏一旦持久化即不可变，closeout **不清围栏**、不改原 unknown outcome、不允许重放。

**发布前取消内部入口**：存储的 `beginPublication(input, key, mutation)` 仅允许当前 handle 新登记的 prepared 操作持久化 publishing 后取得一次性 attempt；attempt 的 `invoke()` 与 `finishWithoutDispatch(reason)` 同步互斥，后者永久关闭调用机会，以 handle 私有 WeakMap 证据执行仅本次 publishing → not-published 转换并移除未使用围栏。证据绑定完整 operation（含 origin/binding/fence）与持久 revision，不序列化、不对外返回；调用一旦发生，即使同步抛错也不再提供未发布证明。

### 原生拒绝认证的已验证阻塞（尚未实现）

`FS_STALE_VERSION` 不能直接授权 publishing → not-published。针对安装版 fs/local/sandbox `0.2.0-rc.2`、Cordis `4.0.4`、Node `24.21.0` 的隔离探针验证了以下区别：

- stock local 的版本 guard 在 staging 前运行；sandbox 先校验有效策略再委托 local。真正旧版本拒绝没有调用 staging hook，文件字节不变。
- 同一个 stock `writeText` 在提交后仍动态读取 `this.versionAfterWrite`。调用开始后临时覆盖该方法，让它恢复原属性后抛出此前捕获的真实 stale error，仍可得到“字节已改变、原错误对象被抛出”。实例与原型的前后属性描述符、空 `internals` hooks、模块磁盘 hash 都保持相同；local 与 sandbox 均复现。
- 已提交后抛 stale／EIO 的 wrapper 经现有 publisher 仍保留 unknown、fence 与归属，原样抛出错误；历史请求不重放，五参数、版本 guard、私有 signal 与有效策略保持原契约。这里 EIO 是提交后的注入错误，不声称模拟了操作系统 stat 故障。

因此，提供者身份／版本／源码 pin 是必要的归因材料，但前后快照不是**调用期间依赖不变**的证明；这个反例无需改变模块源码。不接受错误码、错误类、真实错误对象或“调用前后看起来相同”作为认证。冻结共享宿主对象会改变其他消费者可观察到的行为；改 receiver／复制实现会改变原服务调用语义，均未作为静默修复采用。Inspector 的函数位置与已求值源码可帮助归因，但仅这些观测也不消除此时间窗口。

下一步必须先建立提供者内部、绑定本次调用且不可伪造的 pre-staging 分支回执，或经明确契约允许的完整稳定执行依赖约束，再接 store 私有结算。当前没有新增默认启用认证 adapter，也没有开放 version-conflict 结算；stock stale 仍保守 unknown。此证据不证明所有 adapter 技术路线不可能，只明确否定边界快照路线。历史 unknown 不能借本次新审计改判，现有围栏未解除。面向人的“导出 → 独占／静止证明 → 精确批准 → 结清 → 重启核验”维护入口与可见阻塞原因仍是未交付的 UX／控制面缺口。

可复现测试：[audit-publication-rejection.mjs](../../plugins/orrery-test-harness/test/audit-publication-rejection.mjs)。它显式加载所指定安装目录的真实 provider，经独立 Cordis context 注册，不安装到正式 profile；所有目标与权威镜像写入隔离根，保留产物供检查。不在 portable 单测 glob 内，以免缺少宿主时静默跳过：

```sh
ORRERY_AUDIT_HOST_ROOT=/absolute/path/to/dsh \
ORRERY_AUDIT_ROOT=/absolute/path/to/isolated-output \
node --test plugins/orrery-test-harness/test/audit-publication-rejection.mjs
```

实测 8/8 通过；local 模块磁盘 SHA256 为 `63fbb41d2c33e07111884b798be507e68c2752acab8249c821c20ade436e894f`。这只是回归证据提交，不是 prospective settlement 功能交付，也不是历史会话修复。

本次证据提交的门禁状态：checkJs 通过，既有 publication／publisher-stop 定向测试 8/8 通过；完整产品单测为 1516/1521（5 项失败：client chunk mtime、lane 内 TMPDIR 导致 socket 路径过长及 3 项仓库发现假设），装置单测为 109/111（rehydrate／worktree 的 recorded-trace replay 失败）。未改这些既有测试／源码来制造全绿。运行产生的隔离文件均留在 lane 内；未运行完整 headless profile 集成，不能将 provider 探针等同于该验收门禁。本提交未达到功能合入 DoD。

### 管理器事务与发布

`prepare` 持久绑定原请求并返回私有 submission；`commit` 在同一 FIFO 中持久 publishing 后仅调用一次捕获的发布函数。创建成功的规范身份、归属与结果同镜像提交；发布期间取消保留 interrupted 锁，确认落盘期间新到的取消追加撤权镜像后才应答。原生调用后的异常保留 unknown/fence，不从异常推断未发布。历史同参返回记录，异参同 ID 拒绝，不自动重放。全新 store 的初始 manager 只接受 revision 0、无 incarnation 的镜像；启动恢复（`recoverEditLockManager`）把历史 prepared → not-published、publishing → unknown，原 fence、terminal/unknown 历史与预算不改写，以新 incarnation 保守重装，并让所有已知会话以中断态开始（旧 receipt 不导入，重复注册不能绕过中断）。创建成功的结算（`settleCreated`）只收编本次经原生创建并解析出规范身份的节点，拒绝收编任何既有锁。

**Stop 的提交边界**：原始 turn signal 持续用于准入、撤权监听与 dispatch 前检查，包括 publishing intent 持久化后的第二次检查；此时取消保证零 backend 调用。只有真正执行捕获的 `writeText` 时才创建私有 `AbortController().signal`，不传播 turn abort。目标、完整内容、原始版本 guard 与 effectivePolicy 保持不变。已经 invoked 的提交由 manager/runtime 完整 await，不使用超时或 `Promise.race`；成功记 created/updated，但 ownership 与会话仍为 interrupted，后续写入仍拒绝。真实 backend 拒绝仍为 unknown 并保留围栏，历史回放永不重新调用 backend。这不保证任意第三方 adapter 没有 detached writer，也不结清旧 unknown。

**未决发布隔离**：`src/edit-lock/admission.js` 在 manager FIFO 的实际准入点统一检查全部 publishing/unknown 围栏；一般事务在创建 draft、消费 receipt 或持久化之前拒绝，拒绝本身不会毒化 manager。`prepare` 与 `commit` 各检查一次：准备后出现的冲突会在 dispatch 前结算为 not-published，不调用 publisher。

- **resource 围栏**：在既有可信规范资源身份契约下，精确相同资源拒绝；不同的规范既有资源可继续获取、确认、更新、转交。因此子会话一个既有文件发布结果未知，不再自动阻断父会话对另一个既有文件的工作。缺失、非规范或不透明身份不能作为不重叠证明。
- **subtree 围栏仍保守关闭资源操作**：v3 只保存祖先路径，没有可持久验证的历史拓扑连续性证据。即使路径看似在另一子树、只是前缀相近或重新解析后不同，也不能证明不相交；本阶段拒绝这些资源操作，不用 `startsWith`／词法包含冒充证明。同理，存在未决围栏时，新的 create 意图不能仅凭祖先路径获得准入。这是本阶段的可用性限制，尚未实现完整 subtree 非重叠放行。
- **domain 围栏**：正常 mutation 全部拒绝，包括没有显式文件参数的新会话注册、receipt 签发及空批次；不能用新 sessionId 绕过。
- **无显式目标不等于无资源影响**：resume、hold 与会话级释放在执行点枚举受影响 ownership；批量获取/释放检查全部成员，不能先处理无冲突项再失败。resume 遇到被围栏保护的锁时整体拒绝，不消费 receipt、不把锁改为 pending-confirmation。transfer 按实际转交资源检查。
- **仅减权入口仍可运行**：取消、标记异常、结束保留与增加恢复预算不解除围栏。release／releaseMany／releaseActive／人工 unlock 可移除无关 ownership，但未决 update 必需的原 owner/generation 必须保留；混合批次整体拒绝。release 不代表确认发布结果，也不结清 unknown。

普通隔离路径不改历史 outcome/fence、不增加 closeout、不自动重放、不引入 TTL；持久化失败仍毒化整个 manager。显式管理员恢复是独立的风险接受入口（见上节），不是普通 unlock 或历史结清。精确资源比较依赖可信 ingress 提供 native canonical 单链接文件身份，以及既有独占生命周期／外部拓扑变更协调前提；路径形状检查自身不是文件系统证明。

**历史静止性边界的 characterization（不是安全保证或完整修复）**：`edit-lock-historical-quiescence.test.js` 用隔离临时 authority 与 gated promise 构造任意 adapter：`writeText` 拒绝，但保留一个尚未写入的 detached writer。manager 将操作记录为 unknown，`drain()` 与 reserved runtime 的 `close()` 仍可完成并释放预约；随后 recover 可以打开新 authority，旧 writer 才落盘，历史 unknown 不变。该测试故意违反 recovery 要求的旧 publisher quiescence 前提，证明 generic handoff 的返回值／队列排空／预约移除本身不足以建立该前提；不证明安装版宿主 adapter 必然这样执行，也不提供宿主静止性证明。测试只在实际 writer 已 drain 后清理 fixture，不修改真实 snapshot。

v4 迁移基础仍不以人工声明、进程退出或 promise rejection 结清 unknown，未开放 bound closeout 入口。v5 的 ADMIN OVERRIDE 在保留 unknown 的同时显式接受迟到写者风险、改变后续准入，不声称建立历史静止性；宿主静止性证明不是该自愿恢复的前提。

队列回归在不等待前驱的情况下提交 acquisition／unknown commit，再提交 hold 或 resume，验证 ownership candidate 在 FIFO 执行点枚举；releaseActive 另验证 queued abnormal transition 后不沿用调用时的 active 集合。将 `transact` 的 candidate 求值移到调用时的内存 mutation 会使三项测试失败。endHold 的 live resource-unknown 用例断言 revision 真正递增且 ownership／history 不变；历史 domain 用例因 recovery 已重置 holding，只断言 no-op，不声称覆盖 domain-fenced endHold 的实际持久化分支。

publisher 捕获原始 `fs.resolve/writeText`，保留五参数调用（目标、完整内容、原版本策略、signal、effectivePolicy）；adapter 用进程内不可伪造 call 绑定可信 execution/cwd/policy/callId，单次消费，不向工具参数暴露凭据。历史 prepared/unknown/not-published 不作为工具成功返回。受控 `write` 复用现有单次沙箱策略解析，保留 `fs/write-intent` 返回的 createIfAbsent／replaceIfVersion，缺少明确 guard 时拒绝，不用新 stat 覆盖旧观察版本；成功后发送标准 `fs/observed` 并返回内容差异；没有本地写入 fallback。宿主桥 `createEditLockHost` 以真实 agent 对象的 WeakMap 绑定已持久注册／恢复的 execution，逐次用宿主 registry 检查对象身份（模型参数不能注册身份）；detach 先删除调用授权，再请求 durable cancel。`hash_edit` 与 `lsp_rename` 同样捕获挂载时的服务：发布完整合成内容、原始参数、版本 guard、实际有效 policy 与 exec，服务拒绝或关闭不能回退原生直写；没有服务时保持既有行为，因此正式启用必须在编辑工具挂载前安装服务并整体覆盖 write/LSP，不能热插入局部接管。

生命周期控制器 `createEditLockLifecycle` 提供显式 start／stop／close，工具只拿到 publish／publishBatch，不暴露注册权。stop 同步关闭 registry 准入并等待 durable cancel；重复 start 不恢复中断会话，close 先撤权再关闭 runtime。远端工具服务封装绑定真实 agent 对象并逐次检查 registry，不持有本地写入能力；工具作用域安装原语隐藏继承的 stock write/edit，再注册 managed write 并核对 lookup，卸载只移除 managed write、保持原工具禁用。

### 创建协议（缺失目标）

缺失目标的创建成功路径不沿用「先取得归属再写入」的顺序：它没有既有节点可绑定，因此经 manager 串行发布道发布——幂等绑定优先，其次节点存在性冲突判定（既有节点一律冲突，冲突先于任何目标侧副作用），再经 manager 实际持有的 `ctx.fs` 发布，发布成功后解析规范身份并绑定归属与持久结果才返回成功；**创建意图不是所有权**，不发放所有权令牌，也不构造规范资源键，未知结果由持久 intent/outcome、无过期恢复围栏与墓碑兜住（设计 D3/D5，Option C）。

创建通道只归受控 `write`，`hash_edit` 只编辑（设计 D2b）：目标没有既有文件节点时，`hash_edit`（以及可选共存的受控 stock `edit`）**零副作用拒绝**——不发 CreateIntent、不取得所有权、不构造规范资源键、不创建也不收养节点；规划之后出现的节点一律不收养、不取得、不覆盖；dangling 符号链接、特殊文件与目录按不可编辑拒绝且不跟随重定向。这与宿主既有语义一致（`write` 走受保护创建、`edit` 对缺失目标报 `FS_NOT_FOUND`、本仓 `hash_edit` 对非普通文件在提交前拒绝），已在安装版运行时的组合探针里核对。

### 跨进程

同一 authority 目录的合作 Harness：先抢到预约的进程成为唯一 publisher，并在用户私有临时目录下按 authority 规范路径哈希开一个 Unix socket 端点；预约冲突（`EEXIST`）的进程**不整体拒绝**，而是成为客户端，从不自己落盘。每个客户端 agent 一条会话通道，首帧 `open {sessionId}` 后身份固定；工具、`/edit-lock` 命令、协商通知与临时答复工具都经该通道转发，发布仍由 publisher 持有的原始 `ctx.fs` 执行。通道 EOF（含客户端崩溃）由 publisher 持久撤权；重连的同会话总以中断态开始，需 `/edit-lock resume`。客户端只重试「建立通道」（等待旧通道 EOF 结算），从不重试调用；中断调用的结果按契约为 UNKNOWN。IPC 原语把 host 已认证的单个 agent 固定绑定到 peer，不接受消息中的身份／生命周期权限；长度前缀 JSON 在解析前限制 8 MiB，限制并发与响应积压，非法帧或断连封闭入口并触发持久撤权。端点不做认证：可达同一用户临时目录的进程都在合作信任边界内，不防恶意同用户进程。publisher 退出后客户端不自立为写者，受控写入 fail closed，直到人工确认旧 publisher 静止并重启。

### 停止、协商与恢复

- **取消是独立 ingress，不是回合结束的副产品**。安装版实测确定三件事：active 回合内 `agent.cancel` 会在调用栈内**同步**执行 abort listener（`agent/pre-step.signal` 与真实 tool `exec.signal` 相同），此后回合才结算为 `aborted{kind:'user'}`；idle 时取消**不产生新的 active-turn abort**，只挂 pre-step signal 覆盖不到「没有回合在跑、但仍有未消费授权」的状态；还存在「请求已发出但 abort signal 尚未产生」的窗口（request abort 会拒绝 `execute`，但不合作的异步 handler 之后仍能产生副作用，`withAbort` 是 race 而非强制停止）。因此撤销必须覆盖 **active / idle / pre-signal 三类窗口**，且作废后到达的旧 epoch 请求一律拒绝；不得从文件内容相同反推成功。
- **异步 ack ≠ GUI 接受**。GUI Stop 路径（`SessionCommandController.cancel`）调用 `agent.cancel({kind:'user'},{keepInbox:true})` 后返回 `{accepted:true}`，不等待 manager 撤权，因此「Stop 被接受」不能作为仲裁点已确认撤权的证据。适配器在本地封门，并把撤销与实际提交在管理器里排序；确认完成前不得恢复写入。跨进程没有共享 AbortSignal，已经在线性化撤权前完成的发布也不能声称被回滚。
- **协商**（`negotiation.js`）：答复绑定 requestId、资源 generation、持有者 session 与 epoch；过期（默认 120 秒）、重复、旧 generation、非持有者或已停止持有者的答复一律拒绝，沉默保留归属。请求送达持有者时，若持有者空闲（`idle`）则用 followup 唤醒它，使它在一个回合内就能答复——只 inject 的话通知会一直躺着，等持有者下次收到用户消息时请求早已过期；已中断的持有者永不唤醒。同意后由 manager 在**一个持久事务**里释放旧 generation 并为请求方获取，任一方已取消即整体失败。协商请求刻意只存在内存：重启推进所有 epoch 与 incarnation，旧请求只可能过期。结果通知（转交成功、过期、被拒）只 inject，不唤醒请求方。
- **答复工具的生命周期**：`edit_lock_reply` 在首次收到请求时注册，且只在**回合边界**（`agent/turn-stopping`）于无待答请求时注销；回合中途注销会让「已过期但仍被调用」的答复报成 `unknown tool` 而不是真实原因。
- **仅清理恢复**（`recovery.js`）：回合以 `turn/end` reason `error` 结束且会话持有锁时，这些锁标为 abnormal（不释放），会话进入 `recovering`：业务写入、新获取与 try_steal 全部拒绝，只能 `edit_lock_release`、`edit_lock_reply` 或 `edit_lock_pause`。驱动按 15／30／60 秒退避注入仅清理回合，至多 3 次或累计 5 分钟（以先到者为准）；暂停单次 ≤15 分钟、累计 ≤30 分钟，到期只重新检查，不释放、不自续。次数、恢复耗时与暂停时长都持久计入 authority 镜像的 `recovery`，重启不退还。预算耗尽或无剩余异常锁时停止并提示人工；恢复正常编辑只能经 `/edit-lock resume`，abnormal 锁保持 abnormal，须释放或人工解锁。用户 Stop（`aborted`）立即结束自动恢复且不唤醒会话。
- **停止后的提示与清理**：会话被 Stop 或 `/edit-lock stop` 停止后，写入、获取、转交与答复统一返回「editing in this session was stopped … until a human runs /edit-lock resume」；`edit_lock_status` 与 `edit_lock_release` 在停止、恢复中状态仍可用（只读或只减权）。agent 结束（`agent/disposed`）时，仍处于 active 的 agent（例如正常完成的子代理）永远不会再写，先在一个事务里释放它的 active 锁，再撤权遗忘；已停止、异常或存在未决发布时保留，留给人工。跨进程连接断开可能是崩溃，只撤权不释放；客户端正常结束会先发送 `dispose` 再断开。
- **停止后的自动恢复边界**：`editLockAutoResume` 开启时，停止后的下一条真实用户消息在新回合首 step 前完成 resume + confirm-all（见「运行时接线」）；零锁的停止会话同样恢复（闩锁在会话层）。自动恢复不改变 abnormal 锁、不改变他人归属，revoked 会话直接跳过。
- **受控人工解锁**：`/edit-lock unlock <path|resourceId> <generation>` 只在期望 generation 仍为当前值时释放。它排在 manager FIFO 中，等待此前在途提交结算；未决 update 必需的归属被事务围栏保护，无关锁可释放；不存在无条件强制解锁。已准备的旧 owner 写入随后因 generation 失效在派发前结算为 not-published。解锁不改变任何会话的中断闩锁，不验证内容，也不清除 unknown。
- **操作身份**按每次实际执行生成（`callId@uuid`）：部分供应商跨回合复用 tool-call id（如 `call_0`），不能直接作幂等键。

### 信任模型

保证范围是「同一工作目录管理域内、经 Orrery 接线的受控写入」；shell、外部 IDE 与绕过提交路径的写入明确排除。跨进程身份由可信 spawn 连接与真实 Agent/Session 对象绑定，不依赖消息字段；产品建立可靠的连接/session 绑定并保真传递有效 policy，但不声称抵御同用户恶意进程或恶意宿主插件。

## 边界与失败语义

- **未开启即无行为**：设置关闭时没有插件服务、没有锁工具、没有 UI 元素，装载与否不改变任何现有会话；开启后受控 editor 的定义必须由本特性接管，否则 fail closed。
- **迟挂载的补课绑定与创建路径同一失败语义**：挂载时补课中的作用域安装失败同样经 `restrict` 拒绝受控工具并告警；domain start 失败同样记入 `startFailures` 与挂载证据，面板呈现与创建时失败一致的原因，而不是永远显示「starting」。
- **冷读只视图不改变授权**：冷会话的状态视图只是把权威镜像翻译成面板形状——不打开 runtime、不取预约、不结算任何未决操作、不释放任何锁；镜像里是什么就显示什么（包括残留的异常锁与未到期的保留）。冷视图上的激活指引是语义说明（auto-resume 的既有行为），不是新的恢复通道；绑定与写动作仍只发生在首条真实消息触发 `agent/created` 的既有路径上。
- **权威状态持久且可重启恢复，但恢复出的 active 状态不构成当前授权**：恢复重新装载历史并把所有已知会话置为中断态；publishing/unknown 按上述准入规则隔离，resource 围栏外的已证明无关工作可继续，subtree 连续性未证明及 domain 围栏仍保守拒绝。没有清围栏、重放或自动结清入口。
- **后续接入的 fail-closed 要求**：资源别名无法安全归一、可信执行上下文缺失或 manager 断连时拒绝写入，不做本地无锁后备。资源身份从真实文件系统解析既有节点的 native 规范身份（不折叠词法 `..`、不做大小写/Unicode 归一），但**不判定缺失名称的等价性**——不预创建占位文件、不猜测别名；store 只写自己的 `snapshot.json`，release 也不等于验证通过。
- **宿主父子 Stop 与编辑锁命令不同**：每个会话有各自的锁状态；宿主对 active 父会话的用户 Stop 会传播取消给子代理（父 turn 为 aborted/user、子 turn 为 aborted/parent），双方已调用的文件提交仍按上述边界等待结算。`/edit-lock stop` 只撤销所选会话的编辑权限，不宣称取消整个委派树。
- **shell 与外部写入不在保护范围**：`printf > file`、`echo x >> file` 这类 shell 命令与任何外部编辑器的写入完全绕过锁，不受占用判断影响；不承诺覆盖任意磁盘写入面（bash、PTC、外部编辑器与任意 filesystem API 都在保证之外），也不承诺分布式多机共识。
- **失效锁清扫的保守边界**：清扫只认 `lstat` 的 `ENOENT`——目标被移动不会被追踪（新位置的文件与原锁无关，原锁留在原地等保留到期、转交或人工解锁）；dangling symlink、`EACCES`/`ENOTDIR` 等错误一律跳过而非当作缺失。清扫是**尽力而为的维护**，不是释放保证：观察与执行之间归属发生任何变化（resume、confirm、generation 前进、撤权）、目标在执行点重新出现、或未决发布围栏保护，该行一律跳过且不报错；持久化/poison/意外失败计入 `failed` 并逐条留有界日志（fail-closed：未持久化任何东西，poison 后 manager 拒绝后续一切操作），残留锁永远可以 `/edit-lock unlock <resourceId> <generation>` 人工清理。清扫不结清 unknown 发布围栏（仍需 ADMIN OVERRIDE），不改恢复、保留与回合末收尾语义，也不清理 `.orrery/` 之外的任何文件。
- **崩溃自愈的保守边界**：预约回收只信「租约超时＋死亡证明」双条件，仅超时或 owner 死活不明一律照旧成为客户端；死进程 unknown 的自动结清只发生在 publisher 进程恢复打开时、且要求该 owner 全部未决 unknown 的 origin incarnation 都有死亡证明——混合身份（部分 null/部分死亡）的 owner 不部分结清。自动结清不修改目标文件、不重放发布、不改写 unknown 结论；备份是证据，不是存在迟到写者时可安全回滚的承诺。pid 复用＋启动身份同时失效的理论窗口由双因素身份与串行化复读对冲，无法结构性消除（见「预约租约与死证回收」）。`git clean -fdx` 或手动删除 `.orrery/` 同样会丢失 v6 注册表与台账。
- **保留设置冲突只影响保留**：保留了互相矛盾的保留设置（例如单次上限低于默认时长）时，只有保留申请按设置键名报错；回合末收尾、状态、释放、停止和解锁继续工作，保留相关字段改用内置默认值，提醒次数与兜底处置仍按保存值生效。一个设置错误不会让文件无法释放。
- **未承诺的时点保证**：观察是一串同步 filesystem 调用，**不是原子快照**；外部 shell/IDE 在调用之间改变盘面不在保证内，dev/ino 连续性无法证明不存在 inode reuse 或「改后复原」（ABA）。调用方必须先自行协调变更顺序（manager 生命周期/发布协调）。
- **明确不承诺**：不承诺跨文件回滚（已发布的字节不会因取消自动撤销）；跨文件批量失败只区分 written / not-written / uncertain，不宣称回滚。

## 测试

### Stop 提交回归

`test/edit-lock-publisher-stop.test.js` 覆盖 preabort、publishing intent 持久化期间取消的零 dispatch、invoked 后正常更新及中断归属、旧版本拒绝与 unknown 围栏、历史不重放、runtime close 等待，以及同一存活 runtime 中另一个经 host registry 认证的 active session 更新无关既有文件。安装版 `editlock-stop-update` 使用真实 read 获得版本，在精确目标的 `inspectTemp` 暂停点执行 parent.cancel；断言原始父子 signal 都 abort、backend 仅调用一次、字节更新、updated 历史及 interrupted 归属。cold continuation 另作观测，不冒充同 runtime 隔离证明。

### 未决发布隔离的有界回归

`test/edit-lock-quarantine.test.js` 使用临时 store 和可控 publisher，覆盖：已调用后抛错留下 unknown，父会话无关既有文件仍可获取并发布；相同资源、未证明的 subtree／缺失目标及 domain 拒绝；批量与会话级操作不部分改写归属；历史同参不重放；恢复后围栏不变；撤权与持久化失败仍封闭权限。实现前新增用例中 9 个失败于旧全局围栏，另 1 个保守拒绝用例已通过。本轮证据限后端单测与 checkJs，不代表本机 GUI、跨进程运行时或人工结清验收；下表是此前发布记录。

### 发布门槛（最终树）

| 层 | 命令 | 结果 |
|---|---|---|
| 静态检查 | `pnpm --filter orrery-harness run check` | 0 错误 |
| 产品单测 | `pnpm --filter orrery-harness test` | 1189/1189，0 fail、0 skip（151 suites） |
| 装置单测 | `pnpm --filter orrery-test-harness test` | 99/99 |
| headless 集成 | `pnpm --filter orrery-test-harness run test:integration`（`ORRERY_IT_DSH_EXEC` = 安装版 CLI） | 95/95，其中 `editlock` 场景 11/11 |
| 安装版单进程探针 | `.orrery/edit-lock-verification/composition-native.mjs` | 28/28 |
| 安装版双进程探针 | `.orrery/edit-lock-verification/cross-native.mjs` | publisher 8/8，client 15/15 |

集成与探针都跑在安装版 DSH `0.2.0-rc.2` 上（Electron 44 / Node 24.21.0）。两个探针从 `app.asar` 解析 DSH 模块，必须在安装版运行时下执行（裸 Node 解析不了 asar）；表里的数字取自当轮记录在 `.orrery/edit-lock-verification/composition-G6CVQB/`（checks.json 28/28）与 `cross-AfjOl6/`（publisher-checks.json 8/8、client-checks.json 15/15）的产物。探针脚本与产物都是本地过程材料，不入库。

### 单元测试要点

- **保留与收尾**：`test/edit-lock-retention.test.js`（17 项：保留语义、他人照常被拒、本会话可继续编辑、新回合解除、读时结算幂等、延长只计新增分钟、批次结束归零、停止使保留失效、重启不恢复运行中的保留）、`test/edit-lock-settle.test.js`（13 项：仅 `completed` 进入、提醒上限、两种兜底、提醒自身回合不重置计数、保留期内不打扰）、`test/edit-lock-view.test.js`（8 项：状态优先级、行动作、技术标识不进主视图）、`test/client-edit-lock-panel.test.js`（15 项：不解析命令文本、按状态的主动作、行内动作、收回二次确认、解锁二次确认、技术细节折叠、外部点击收起与重开）、`test/settings-fields.test.js`（`editLockLimits` 默认与报错）。
- **内核与身份**：`test/edit-lock-state.test.js`、`test/edit-lock-resource-identity.test.js`（真实 `mkdtemp`/`write`/`mkdir`/`symlink`/`link`/`rename`，真实 `/dev/null` 作特殊节点；平台 dispatch 在独立子进程中替换 `process.platform` 检查，不伪造文件系统成功）。后者含一条复杂度回归：在隔离子进程给 Node 内建加 passthrough 计数（每次仍调用真实 fs），要求每多 4 个组件 lstat/readlink 各自至多 3 倍增长，并断言观察仍是同一个真实文件——它钉死的是「指数级父路径重放」这一已修复缺陷，**不**声称整个 resolver 对所有路径/内核 I/O 都是线性。
- **存储与历史**：`test/edit-lock-store.test.js`（真实 syscall 层的故障注入与 SIGKILL 子进程恢复，覆盖 create/record/recover 的 detached 语义、封闭 schema 与历史单调性、canonical/checksum/domain/version 拒绝、每个持久化边界的毒化与 `commitStatus`、每 handle 队列 CAS 与 close drain）、`test/edit-lock-operation-history.test.js`（阶段图、`ID_REUSE`、transition-local 归属、围栏与 closeout）；两者都用真实 fs 与真实 file/dir sync。SIGKILL 是真实子进程在 barrier 处被杀后重新 recover，**不是**掉电、内核崩溃、扇区撕裂或硬件缓存持久性证明。
- **管理与组合**：`test/edit-lock-manager.test.js`（持久后安装、取消 overlay 与持久 ack、pending 注册的取消、竞争冲突不毒化、未决围栏）、`test/edit-lock-composition.test.js`（服务与工具面、受控 write 与 hash_edit 链路、view 端点、人工 `release` 命令）、`test/edit-lock-lifecycle.test.js`、`test/edit-lock-host.test.js`、`test/edit-lock-write.test.js`、`test/edit-lock-tool-scope.test.js`、`test/edit-lock-publication.test.js`、`test/edit-lock-reservation.test.js`、`test/edit-lock-peer*.test.js`、`test/edit-lock-remote-service.test.js`、`test/edit-lock-request-*.test.js`、`test/edit-lock-call-context.test.js`。
- **消息驱动的自动恢复**：`test/edit-lock-auto-resume.test.js`（真实用户消息置旗并在下一回合 resume + confirm-all、注入消息不置旗、开关关闭不恢复、revoked 终态跳过、零锁会话恢复、与手动 Continue 竞争幂等）；集成场景 `editlock-auto-resume`（停止后仅发消息即恢复 read → write → release，快照携带 `auto:user-message:<uuid>` requestId）与 `editlock-auto-resume-off`（开关关闭时同一写入被拒、会话保持 stopped），两者各用私有 authority 目录与目标文件。
- **冷会话状态视图**：`test/edit-lock-view.test.js`（`buildColdView`：interrupted→stopped＋cold 标记、撤权→revoked 终态优先、全域锁列出、保留按读时结算（holding/过期/无锁行不算）、镜像不认识的会话→idle、auto-resume 开关随视图）；`test/edit-lock-composition.test.js`（端点冷读：冷会话→真实 stopped 视图且镜像字节前后一致＋观察租约逐次释放、冷撤权会话→revoked 终态、无法冷观察/无权威/镜像损坏→带明确 reason 的 unavailable、存活 agent 路径不受回退链影响）；`test/client-edit-lock-panel.test.js`（cold stopped 无主动作/无行动作/无收回按钮＋按 auto-resume 开关的激活指引、cold 其它状态同样零按钮零指引）。headless 集成场景 `editlock-cold-view`（18 项：seed boot 留 interrupted＋保留锁；cold-read boot（该会话在进程内无存活 agent，经捕获连接的探针直接调端点）首读即真实 stopped 视图（cold 标记、retained 锁、autoResume）、非「启动中」，冷读前后该会话镜像行逐字节不变；resume boot 一条真实用户消息即自动恢复，read → write → release 成功、`auto:user-message:` requestId 与新 epoch 落镜像），replay fixture 已入库。
- **失效锁静默清扫**：`test/edit-lock-stale-sweep.test.js`（23 项，五镜：`isMissingTarget` 真实 fs 判定——既有文件/dangling symlink/ENOTDIR 一律跳过、仅 ENOENT 为候选；`createStaleSweepScheduler` 注入时钟/定时器的单飞+60s 冷却+dispose 取消+失败告警仍冷却+冷却过期条目回收与 close() 清空；`manager.releaseStale` 真实 store——resume/confirm 后同 generation 按 epoch/status 谓词跳过且 revision 不变、release 后重获取 generation 递增跳过、执行点目标重建跳过、retention holding 锁缺失目标释放且 owner 最后一把锁消失后 holds 行归零、未决 update 围栏内归属按既有 release-mode 准入拒放（静默跳过且 `failed` 为空）而无关失效锁照放、同一观察行重放幂等跳过、持久化失败计入 `failed` 而非 skip 且 poison 后 fail-closed；组合层——真实用户消息触发 dead session 缺失目标锁的静默释放+publisher 审计 cordis/JSONL 双写+对话零注入、注入消息不触发、开关关闭不调度、冷却窗内第二条消息不调度、agent dispose 与插件卸载取消未派发、域打开兑现回调内 dispose 重检（手动定时器确定性复现竞态）；跨进程——客户端域转发 `staleSweep` 通道调用、publisher peer 以通道会话为触发转发 lifecycle；lifecycle 聚合——本地与彷 peer 并发触发共享单次扫描、冷却窗内返回 `coalesced: 'cooldown'` 不再扫描、每个失败恰好一条有界警告且跳过静默）。headless 集成场景 `editlock-stale-sweep`（消亡会话残留缺失目标锁，另一会话的真实用户消息后锁被静默释放、generation 墓碑保留、对话无注入、`stale-sweep` 审计 cordis 与 `<根>/.orrery/audit.jsonl` 双落盘）与 `editlock-stale-sweep-off`（开关关闭时同一消息不清扫、无审计、锁保留），各用私有 authority 目录与目标文件，replay fixture 已入库。
- **预约回收与崩溃自愈**：`test/edit-lock-reservation.test.js`（P1：owner doc 写/读/损坏/未知版本、死证成立与不成立、pid 复用 ABA、回收竞态与串行化复读、`releaseAfterQuiescence` 回归）；`test/edit-lock-incarnations.test.js`（14 项：引用收集与 null 种子、注册表不可变、v4/v5→v6 首次写入无损升级、注册表校验（形状/唯一/身份字段/覆盖）、v6 镜像拒绝篡改与缺注册表、v7 拒绝）；`test/edit-lock-auto-recovery.test.js`（8 项：死进程 unknown 在恢复提交内结清（台账/放锁/撤权/准入各断言）、多 owner 一次提交、二次恢复不重复、判活/判不明/同进程重挂载/null 身份/混合身份均不结清、备份即前像字节）；`test/edit-lock-recovery-notice.test.js`（组合级：真实插件挂载覆盖崩溃 authority——域打开一条 `automatic-recovery` 审计、首个回合恰好一条汇总通知且同域第二个 agent 不重复、准入恢复、重挂载终态不复发）。headless 集成场景 `editlock-crash-recovery`（13 项：真实 SIGKILL 子进程在 publish 钩子内死亡留下 publishing 记录、半成品文件与短租约泄漏预约；整体重启后预约经死证规则回收、恢复提交内自动结清、受控 create 重新准入、unknown 结论与历史保留、v6 注册表携带各 incarnation 的 pid、备份落盘、审计与汇总通知各一、退出后预约释放），replay fixture 已入库。
- **独立维护**：`test/edit-lock-maintenance.test.js` 覆盖四态/未知、损坏拒绝、字节不变、服务端根、设置审计与生命周期；`test/edit-lock-maintenance-safety.test.js` 覆盖父目录/authority/快照符号链接、多挂载顺序、旧回调、安装失败、设置重挂载及超限快照；客户端维护/设置用例验证警示与后代错误隔离（包括成功但畸形的响应）。fixture 注入受 ceiling 限制的根发现/Git 排除适配器及 lane 内短 socket 地址，不改变生产默认路径。Git ceiling 与文件系统祖先扫描分别约束，不能互相替代。
- **静态与客户端构建**：checkJs 包含 maintenance、snapshot、settings adapter 及维护客户端；宿主边界使用本地声明。`pnpm --filter orrery-harness run build` 校验全部手写 ModuleLoader chunk 的语法，以精确字节 SHA-256 生成入口 manifest 并最后写入口；测试校验清单与 chunk 集合/摘要一致，不接受仅 touch 时间戳作为构建。

### 独立维护批次验收（2026-10-04）

本节仅对应独立维护面板与相关测试隔离批次，不替代上文历史发布记录，也不表示父级 OpenSpec 全部完成：**本批次没有交付历史恢复、provider receipt 或默认发布 adapter**，未修改父级 OpenSpec tasks。

- **最终静态与单测**：`pnpm --filter orrery-harness run build` 验证 17 个客户端 chunk 并生成精确字节 manifest；checkJs 0 错误；产品单测 **1556/1556**，装置单测 **118/118**，均 0 fail、0 skip、exit 0。运行前清除继承的 `GIT_*`，以 lane 内 `.orrery/maintenance-qa/final-tmp` 为 `TMPDIR` 和 Git ceiling，禁用全局/系统 Git 配置；根发现与 socket 使用上述 fixture 适配器。日志为本地 `.orrery/maintenance-qa/final-{build,check,product,harness}.log`，不入库。
- **安装版全量集成**：协调者在新建可丢弃隔离根执行，**165/165，exit 0**（只读核验 `/tmp/oq-fpE0BU/integration.log`）；未使用 driver 默认根。此后仅更正证据文档，未改变 runtime 代码，既有集成证据继续适用于本批次。
- **真实 GUI**：隔离安装版 GUI 共 **16/16 PASS**，19 张截图；覆盖停用、保存启用后等待重启、刷新/重开、检查、loading、注入 unknown、网络失败/重试，以及畸形成功响应的后代错误隔离。QA 无产品代码改动。报告与截图保存在本地 `.orrery/maintenance-qa/qa-report.md` 与 `shots/`，不入库。
- **明确未覆盖**：blocked 行及自然安装失败/缺失挂载证据的服务端状态仅有单测；unknown 的浏览器呈现使用注入载荷，不冒充自然失败。恶意同用户进程的路径 ABA 不在威胁模型内；本轮不声称默认发布 adapter 或历史恢复验收。
- **独立评审**：协调者报告最终 advisor 无阻塞发现；这不是父级更大恢复计划的完成声明。

### 真实回合与人工验收

- **headless 集成场景 `editlock`（11/11）**：回合带锁结束 → 收到收尾续推 → 申请保留 → 状态显示保留 → 释放 → 受控 write 与 hash_edit 经锁发布 → authority 文件拒绝为编辑目标 → 退出后释放预约。该场景实际抓出并修复过三个缺陷：保留在下一步被清除（`pre-step` 按步触发）、批次结束归零被存储当作退款拒绝、读取未注入的 `ctx.setTimeout` 抛错中断保留。
- **双进程探针**：publisher 8/8（本地创建与归属、客户端请求抵达并转交、客户端退出后其锁在 publisher 保持 user-interrupted 并继续围栏、关机释放预约）、client 15/15（第二进程成为客户端而非写者、跨进程拒绝他人文件且字节不变、远端 try_steal 抵达本地持有者并转交、客户端编辑由 publisher 发布、客户端 active Stop 在 publisher 持久撤权、重连为中断态、远端 resume/confirm 后可写、客户端在回合末取保留并由 publisher 记到状态、远端 idle stop 确认）。
- **人工 GUI 验收（用户桌面，单会话与跨会话）**：开关与预设加载、新建会话与会话恢复；受控占用与拒绝（拒绝信息点名当前持有者）；`try_steal` 的 keep／release 两条结局；Stop 后拒写与 `/edit-lock resume` + 逐文件确认；按 generation 解锁（错误 generation 被拒，面板解锁需第二次点击）；`hold` 与 `hold N`；空闲到期自动释放；提醒次数用尽后按兜底释放（默认 2 次提醒）；面板颜色与主动作；关闭开关并重启后完全复原（工具清单里不再有任何 `edit_lock_*`，`hash_edit` 直接成功）。
- **独立评审**：一轮独立复核发现并由修复收口四个缺陷——回合末提醒无限循环（提醒自身回合不再重置计数）、`/edit-lock hold <minutes>` 忽略输入分钟数、跨进程客户端会话的保留永不到期、保存了互相矛盾的保留设置导致整个编辑锁失灵。

### 更早的组件级证据

开发期还留下了若干**组件级**证据（`.orrery/edit-lock-verification/`：`store-review/`、`operation-history-review/`、`resource-review/` 的独立装置测试，`current-dispatch/`、`current-agent/`、`current-ipc/` 的安装版报告，`adapter/VERDICT.md` 与 `installed-gate-status.md` 的早期结论）。它们覆盖的是单个模块或有界组件，**不等于**产品验收：其中身份与 policy 传输使用 fixture、singleton 只是同目录独占 mkdir、版本标签有的是旧提取物 `0.1.7-rc.2`。本轮门槛以上表为准。

### 未覆盖的验证

本特性以**实验特性、默认关闭**的形态发布，下列场景没有证据，不构成任何保证：

- **两个完整 GUI Harness 应用并发**：跨进程只验证过两个安装版 runtime 进程（共用 authority 目录、经可信 spawn 连接），不是两个真实 GUI 应用并排运行；单实例仲裁在 GUI 下的表现未验证。
- **真实回合里的 `lsp_rename`**：批量原子获取与逐文件发布有单测与组合探针覆盖，但没有在真实会话里跑完整一回合的跨文件改名。
- **Linux**：仅经代码路径允许（`resource-identity.js` 只在 darwin/linux 下构造），未在 Linux 实机验证。
- **Windows**：不支持——资源身份依赖 dev/ino，跨进程依赖 Unix socket，两项在 Windows 上都不成立。
- **面板的异常、恢复中、暂停与部分写入状态**：常态、已停止、待确认与保留中已经人工 GUI 验收，异常／恢复中／暂停的画面与跨文件部分写入的呈现没有 GUI 验证。
