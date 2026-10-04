# Edit Lock 编辑锁仲裁（edit-lock）

> **实验特性，默认关闭**：`orrery-harness/edit-lock` 已加入 `orrery` 预设（排在 hashline-edit／lsp 之前），只有在 Orrery 设置页打开「编辑锁（实验）」（`editLockEnabled`）并**重启 DeepSeek Harness** 后才生效；未开启时没有服务、工具或监听器，行为与此前完全相同。
>
> **版本**：特性分支 `dev/edit-lock` 单独维护版本号，已发布 `edit-lock-v0.1.0`（2026-10-02）与 `edit-lock-v0.2.0`（2026-10-03，UX 改版：回合末收尾、有期限保留、面板重做），见 [CHANGELOG.md](../../CHANGELOG.md)。两个版本都已完成人工验收（单会话与跨会话、状态面板与命令入口），并以实验特性形态随主分支 `0.7.0` 合入。
>
> **已知限制**：锁在回合结束时由助手释放或有期限地保留（异常锁除外）；shell 与外部编辑器的写入不在保护范围；不防恶意同用户进程；删除 `.orrery/` 会丢失锁历史与未决发布围栏；跨文件批量失败不做回滚；端点不做认证。

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
- **停止即收回后续编辑权**。你按停止（或面板「收回编辑权」）后，助手不能发起新的编辑，直到你点「继续编辑」；已经调用文件系统的那一次提交会等待完成，仍可能落盘，但不会恢复会话权限。面板的「继续编辑」依次执行 `resume` 与 `confirm --all`，每个文件仍走原有确认检查。
- **状态入口**。输入栏右侧「编辑锁」按钮的圆点表示本会话状态：灰＝未占用文件，蓝（主题强调色）＝正在编辑／文件为本会话保留，琥珀黄＝编辑已停止或等你确认继续，红＝需要你处理。打开面板：
  - 只在需要时给**一个主动作**：已停止→「继续编辑」；等你确认→「继续编辑这些文件」；保留中→「立即释放全部文件」；正常编辑与空闲不给主动作。
  - 文件按短名列出，每行至多一个动作：自己的文件「释放」（待确认的为「继续」）；其他会话停住或出错留下的文件「解锁」（按当前 generation 解锁，需第二次点击确认）；其他会话正在编辑的文件不给动作。
  - 「收回编辑权」是危险动作，需要第二次点击确认。
  - 会话 id、epoch、generation、绝对路径都收在「技术细节」里。
  - 面板读取的是只读的结构化视图，不轮询、不写入对话；每个动作都是一次显式 `/edit-lock` 命令，留在对话中作为记录。
- **模型可调用的工具**：`edit_lock_acquire`（显式占用既有文件；resume 后对 pending-confirmation 文件逐个调用即确认）、`edit_lock_release`、`edit_lock_hold`、`edit_lock_try_steal`（立即返回 pending requestId，从不等待持有者）、`edit_lock_pause`（只在仅清理恢复期间可用，单次 ≤15 分钟、累计 ≤30 分钟）与只读的 `edit_lock_status`。持有者有待答请求时才会临时多出 `edit_lock_reply`（`release`／`keep`），并在回合边界注销。
- 编辑工具的锚点校验、版本护栏、沙箱策略与 diff 输出不变；shell 与外部编辑器的写入不在保护范围内。

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
- active 回合内 stock Stop 同步触发 turn signal，立即封闭准入并持久撤权；idle Stop 没有 signal，使用 `/edit-lock stop` 获得可等待的持久撤权确认。`agent/disposed` 同样撤权。
- 可信人类入口 `/edit-lock`：`status`、`locks`、`hold [minutes]`、`release <path>`、`stop`、`resume`（以 commandId 作一次性 requestId 签发并消费 receipt，新 epoch，保留锁转 pending-confirmation）、`confirm <path>`／`--all`、`unlock <path> <generation>`。普通消息、状态查询都不恢复权限；todo 续推在会话非 active 时不触发。
- 面板数据来自只读端点 `POST /api/orrery-edit-lock/view`（`src/edit-lock/view.js` 构造的结构化视图，按会话解析 agent，找不到时返回 `unavailable`），不从命令文本里推断状态；`connection` 是 host-plane 服务，隔离 realm 不影响它。
- 插件卸载撤销所有会话、排空发布，再释放预约；失败保留预约供人工核对。apply 写成箭头函数：cordis 会以 `new` 构造带 prototype 的回调并丢弃其返回的 disposer。

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
| `view.js` | 面板结构化视图：纯函数（无 IO、无时钟，`now` 由调用方给），面板的颜色与动作只由这个形状决定。 |
| `domains.js`／`domain.js` | 管理域解析，以及发布者与客户端两种组合的统一接口（`service` 是唯一到达工具的通道）。 |

### 状态内核与授权

内核区分资源 owner、generation、会话 epoch 与 manager incarnation，所有权限判断都基于这四组身份：当前凭据只在**入口**校验，撤权队列执行时使用该会话最新已安装的 epoch，避免前置的 resume 安装导致撤权因 stale epoch 落空。会话闩锁保留在会话层：启用本特性的会话即使在**首次 acquire 之前**就被停止，或**最后一个锁已被释放/受控解锁**，也必须收到可信显式执行请求（Continue）才重新武装编辑续推；状态查询、后台通知、release 与解锁都不清除它。`edit_lock_status` 每行给出 `generation`——只靠 status 判断「锁是否已到手」时，generation 变化是所有权真正易手的可靠信号（通知里也带 generation）。

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

- **封闭历史镜像**（当前 version 4，含 `holds` 保留表）：managerIncarnation、sessions（sessionId/executionEpoch/interrupted）、generations（含 release 墓碑）、locks（resourceId/owner/generation/status，abnormal 必须带 reason）、issuedRequests（去重历史）、recovery（累计 charge）与 operations。除 schema 校验外还强制历史单调：epoch 与 generation 不得倒退、interrupted 翻转必须前进 epoch、issued request 不可删除、recovery 计数只增、同 generation 的 abnormal 结论不得清除。
- **版本迁移与降级**：读取接受 version 2／3／4，校验原始字节后无损迁移到 v4；v2 补空保留行，v3 只改版本。历史 closeout 仍只有 `kind`／`assertionId`，不会被升级成解除围栏的证明；旧版本中夹带 bound record 会被拒绝。单独打开不改磁盘，下次成功写入使用 v4；旧版 reader 必须拒绝 v4，不能忽略字段继续运行。不支持的版本报出实际版本与支持范围。恢复方式是使用较新的 build，或在已建立独占与旧 publisher 静止的前提下恢复升级前备份；不能手改版本号，不能用备份抹掉仍可能发布的操作。
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

本阶段不改历史 outcome/fence、不增加 closeout 或人工结清入口、不自动重放、不引入 TTL；持久化失败仍毒化整个 manager。精确资源比较依赖可信 ingress 提供 native canonical 单链接文件身份，以及既有独占生命周期／外部拓扑变更协调前提；路径形状检查自身不是文件系统证明。

**历史静止性边界的 characterization（不是安全保证或完整修复）**：`edit-lock-historical-quiescence.test.js` 用隔离临时 authority 与 gated promise 构造任意 adapter：`writeText` 拒绝，但保留一个尚未写入的 detached writer。manager 将操作记录为 unknown，`drain()` 与 reserved runtime 的 `close()` 仍可完成并释放预约；随后 recover 可以打开新 authority，旧 writer 才落盘，历史 unknown 不变。该测试故意违反 recovery 要求的旧 publisher quiescence 前提，证明 generic handoff 的返回值／队列排空／预约移除本身不足以建立该前提；不证明安装版宿主 adapter 必然这样执行，也不提供宿主静止性证明。测试只在实际 writer 已 drain 后清理 fixture，不修改真实 snapshot。

当前 v4 迁移基础不增加 attestation-based unlock，不以人工声明、进程退出或 promise rejection 结清 unknown，也未开放 bound closeout 入口。宿主能否提供覆盖所有历史 writer 的可信静止性证明仍需独立验证。

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
- **受控人工解锁**：`/edit-lock unlock <path|resourceId> <generation>` 只在期望 generation 仍为当前值时释放。它排在 manager FIFO 中，等待此前在途提交结算；未决 update 必需的归属被事务围栏保护，无关锁可释放；不存在无条件强制解锁。已准备的旧 owner 写入随后因 generation 失效在派发前结算为 not-published。解锁不改变任何会话的中断闩锁，不验证内容，也不清除 unknown。
- **操作身份**按每次实际执行生成（`callId@uuid`）：部分供应商跨回合复用 tool-call id（如 `call_0`），不能直接作幂等键。

### 信任模型

保证范围是「同一工作目录管理域内、经 Orrery 接线的受控写入」；shell、外部 IDE 与绕过提交路径的写入明确排除。跨进程身份由可信 spawn 连接与真实 Agent/Session 对象绑定，不依赖消息字段；产品建立可靠的连接/session 绑定并保真传递有效 policy，但不声称抵御同用户恶意进程或恶意宿主插件。

## 边界与失败语义

- **未开启即无行为**：设置关闭时没有插件服务、没有锁工具、没有 UI 元素，装载与否不改变任何现有会话；开启后受控 editor 的定义必须由本特性接管，否则 fail closed。
- **权威状态持久且可重启恢复，但恢复出的 active 状态不构成当前授权**：恢复重新装载历史并把所有已知会话置为中断态；publishing/unknown 按上述准入规则隔离，resource 围栏外的已证明无关工作可继续，subtree 连续性未证明及 domain 围栏仍保守拒绝。没有清围栏、重放或自动结清入口。
- **后续接入的 fail-closed 要求**：资源别名无法安全归一、可信执行上下文缺失或 manager 断连时拒绝写入，不做本地无锁后备。资源身份从真实文件系统解析既有节点的 native 规范身份（不折叠词法 `..`、不做大小写/Unicode 归一），但**不判定缺失名称的等价性**——不预创建占位文件、不猜测别名；store 只写自己的 `snapshot.json`，release 也不等于验证通过。
- **宿主父子 Stop 与编辑锁命令不同**：每个会话有各自的锁状态；宿主对 active 父会话的用户 Stop 会传播取消给子代理（父 turn 为 aborted/user、子 turn 为 aborted/parent），双方已调用的文件提交仍按上述边界等待结算。`/edit-lock stop` 只撤销所选会话的编辑权限，不宣称取消整个委派树。
- **shell 与外部写入不在保护范围**：`printf > file`、`echo x >> file` 这类 shell 命令与任何外部编辑器的写入完全绕过锁，不受占用判断影响；不承诺覆盖任意磁盘写入面（bash、PTC、外部编辑器与任意 filesystem API 都在保证之外），也不承诺分布式多机共识。
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

- **保留与收尾**：`test/edit-lock-retention.test.js`（17 项：保留语义、他人照常被拒、本会话可继续编辑、新回合解除、读时结算幂等、延长只计新增分钟、批次结束归零、停止使保留失效、重启不恢复运行中的保留）、`test/edit-lock-settle.test.js`（13 项：仅 `completed` 进入、提醒上限、两种兜底、提醒自身回合不重置计数、保留期内不打扰）、`test/edit-lock-view.test.js`（8 项：状态优先级、行动作、技术标识不进主视图）、`test/client-edit-lock-panel.test.js`（13 项：不解析命令文本、按状态的主动作、行内动作、收回二次确认、解锁二次确认、技术细节折叠）、`test/settings-fields.test.js`（`editLockLimits` 默认与报错）。
- **内核与身份**：`test/edit-lock-state.test.js`、`test/edit-lock-resource-identity.test.js`（真实 `mkdtemp`/`write`/`mkdir`/`symlink`/`link`/`rename`，真实 `/dev/null` 作特殊节点；平台 dispatch 在独立子进程中替换 `process.platform` 检查，不伪造文件系统成功）。后者含一条复杂度回归：在隔离子进程给 Node 内建加 passthrough 计数（每次仍调用真实 fs），要求每多 4 个组件 lstat/readlink 各自至多 3 倍增长，并断言观察仍是同一个真实文件——它钉死的是「指数级父路径重放」这一已修复缺陷，**不**声称整个 resolver 对所有路径/内核 I/O 都是线性。
- **存储与历史**：`test/edit-lock-store.test.js`（真实 syscall 层的故障注入与 SIGKILL 子进程恢复，覆盖 create/record/recover 的 detached 语义、封闭 schema 与历史单调性、canonical/checksum/domain/version 拒绝、每个持久化边界的毒化与 `commitStatus`、每 handle 队列 CAS 与 close drain）、`test/edit-lock-operation-history.test.js`（阶段图、`ID_REUSE`、transition-local 归属、围栏与 closeout）；两者都用真实 fs 与真实 file/dir sync。SIGKILL 是真实子进程在 barrier 处被杀后重新 recover，**不是**掉电、内核崩溃、扇区撕裂或硬件缓存持久性证明。
- **管理与组合**：`test/edit-lock-manager.test.js`（持久后安装、取消 overlay 与持久 ack、pending 注册的取消、竞争冲突不毒化、未决围栏）、`test/edit-lock-composition.test.js`（服务与工具面、受控 write 与 hash_edit 链路、view 端点、人工 `release` 命令）、`test/edit-lock-lifecycle.test.js`、`test/edit-lock-host.test.js`、`test/edit-lock-write.test.js`、`test/edit-lock-tool-scope.test.js`、`test/edit-lock-publication.test.js`、`test/edit-lock-reservation.test.js`、`test/edit-lock-peer*.test.js`、`test/edit-lock-remote-service.test.js`、`test/edit-lock-request-*.test.js`、`test/edit-lock-call-context.test.js`。

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
