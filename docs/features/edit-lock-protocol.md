# Edit Lock 租约协议（edit-lock-protocol）

> 一句话定位：`weir-editlockd` 守护进程与任何客户端之间的本机 socket 协议——谁可以写某个文件、如何协商转交、以及为什么这套状态随时可以整台丢弃。

## 概述

编辑锁的仲裁权在一个**独立的单机进程**里，不在任一 Harness 进程里。这个进程只持有内存租约表，通过本机 socket（win32 命名管道）接受请求；它不认识 DSH、不 import `@deepseek-ai/*`、不使用 cordis，因此协议本身与宿主无关，将来可以被别的客户端复用。

把仲裁者外置换来两项性质：**全局单一时钟**（所有租约按同一台机器上的时间到期，不靠各进程自己的墙钟对齐）与**断开即释放**（进程崩溃立刻清空它名下的租约，不必等 TTL）。代价是它成了一个可以被 kill 的单点——所以它被设计成可丢弃的：见下文「易失性契约」。

本文件是**协议契约**：操作集、事件、错误码闭集、幂等性与易失性。客户端如何降级、如何唤醒持有者、如何维护重放清单属于适配器，不属于本协议（见文末「客户端降级放行」）。实现由 `plugins/weir-harness/src/lease-broker/` 的四个模块承载，本文件列出的操作名与错误码由 `plugins/weir-harness/test/lease-broker-protocol-doc.test.js` 双向对拍：文档多列一个、实现多出一个都算失败。

## 端点地址与协议版本

| 平台 | 地址 |
|---|---|
| POSIX | `<tmpdir>/weir-editlockd-<uid>-v<protocol>.sock` |
| win32 | `\\.\pipe\weir-editlockd-<sha256(homedir) 前 12 位 hex>-v<protocol>` |

- `protocol` 是**主版本**，当前为 `1`。主版本写进地址：不同主版本各有自己的仲裁器，彼此**不互斥**（旧版本靠闲置自退自然消亡，不做跨版本兼容协商）。
- POSIX 上按 uid 分文件，同一台机器的不同用户不共享仲裁器；win32 的管道命名空间是机器级的，因此折算 `homedir` 而不是 uid。
- 空闲退出或被 kill 后残留的 POSIX socket 文件由下一次启动回收：bind 遇 `EADDRINUSE` 先尝试 connect，`ECONNREFUSED` 说明是死文件，unlink 后重试一次；连不上以外的答案（对端存活）一律报错，绝不静默接管一个活着的仲裁器。
- `WEIR_EDITLOCKD_SOCKET` 是**两侧共用**的地址覆盖：守护进程入口与客户端默认端点读同一个变量。集成装置据此把一次运行搬到私有 socket（不碰机器级仲裁器）；只覆盖一侧会静默失去互斥，因此它不是「守护进程专用」参数。客户端显式传 `socketPath`（测试注入）仍然优先。

每条连接在**首帧**声明主版本并完成握手；此后同一连接上的所有帧都属于同一进程（一条连接 = 一个进程，进程的全部租约挂在这条连接上）。

## 帧格式

换行分隔的 JSON：一行一帧，双向。请求帧用 `op` 区分；回包带 `ok`，成功时是结果字段，失败时是 `error: {code, ...明细}`；客户端提供的 `reqId`（非空字符串）在回包中原样回带，未提供则省略。服务端主动推送的帧用 `event` 区分。

```json
{"op":"acquire","reqId":"a1","owner":{"id":"lineage-7","session":"s-42","label":"orchestrator"},"scope":"/work/project","paths":["/work/project/src/a.js"]}
{"reqId":"a1","ok":true,"granted":[{"path":"/work/project/src/a.js","owner":{"id":"lineage-7","session":"s-42","label":"orchestrator"},"scope":"/work/project","acquiredAt":1792435353735,"expiresAt":1792435473735,"holdUntil":null}]}
{"reqId":"a2","ok":false,"error":{"code":"held","conflicts":[{"path":"/work/project/src/a.js","holder":{"id":"lineage-7","session":"s-42","label":"orchestrator"},"expiresAt":1792435473735,"holdUntil":null}]}}
```

- 形状校验是**精确字段纪律**：某一 op 的帧多带一个未列出的字段即 `bad-request`。这样协议文法可以从协议的表格里读完，不会长出「被容忍的额外字段」。
- 无法解析的 JSON、未知 `op`、hello 之前的非 hello 帧、重复的二次 hello，一律 `bad-request`。

## 操作集

| op | 入参 | 回包 | 错误码 |
|---|---|---|---|
| `hello` | `protocol` | `protocol`、`daemonVersion`、`startedAt` | `protocol-mismatch`、`bad-request` |
| `acquire` | `owner`、`scope`、`paths`、`ttlMs?` | `granted[]`（每项 `path`、`owner`、`scope`、`acquiredAt`、`expiresAt`、`holdUntil`） | `held`、`invalid-path`、`bad-request` |
| `release` | `owner`、`paths` | `released[]`、`notOwned[]` | `invalid-path`、`bad-request` |
| `hold` | `owner`、`paths`、`minutes` | `held[]`（每项 `path`、`expiresAt`、`holdUntil`） | `not-owned`、`limit`、`invalid-path`、`bad-request` |
| `status` | `scope?`、`session?`、`path?` | `leases[]`（每项 `path`、`owner`、`scope`、`acquiredAt`、`expiresAt`、`holdUntil`） | `invalid-path`、`bad-request` |
| `request` | `from`、`path` | `state`、`requestId`、`holder`、`expiresAt` | `free`、`self`、`invalid-path`、`bad-request` |
| `reply` | `owner`、`requestId`、`decision` | `state`（`transferred` / `declined`） | `expired`、`stale`、`not-holder`、`bad-request` |

逐条要点：

- **`hello`**：必须首帧。主版本相符则回 `{ok:true, protocol, daemonVersion, startedAt}`；不符则回 `protocol-mismatch`（带 `supported: [protocol]`）并关闭连接。`startedAt` 是本次进程的启动时刻，客户端据此判断「仲裁器换过一代」。
- **`acquire`**：整批**全有或全无**。路径先去重再排序后求值（确定性顺序，两个重叠请求不会互相等死），任一被他人持有且未过期则一个都不授予，返回 `held` 与全部冲突项（含持有者 `owner`、`expiresAt`、`holdUntil`）。同一 `owner.id` 且同一连接的重复申请是**收养**：刷新 `expiresAt`，不重设 `acquiredAt`，保留 `holdUntil`。`ttlMs` 可覆盖本条申请的 TTL。
- **`release`**：只按「该连接 + 该 `owner.id`」判定归属。`notOwned` **不是错误**（仲裁器重启后所有路径本就自由），因此重复释放是安全空操作。租约一旦被他人取得，释放会落到 `notOwned` 而不是误删别人的租约。
- **`hold`**：把有效期推到 `now + minutes`，`minutes` 必须为正数且不超过固定上限（60）。**只延长不缩短**：`holdUntil = max(旧 holdUntil, 新期限)`，要求该批路径**全部**属于本连接且仍在有效期内，否则整批 `not-owned`。到期就是到期，无人通知。
- **`status`**：只读，过滤器可叠加（`scope`、`session`、`path` 同时给出即同时满足），返回副本。已过有效期的租约**不出现在结果里**——它们在语义上已经自由，只是内存里那一行可能还没被 sweep 回收。
- **`request`**：请求持有者转交。路径无租约或租约已过期 → `free`（直接 acquire 即可，不需要协商）；持有者就是自己 → `self`。成功时创建一个有界窗口（默认 120s）的待答请求，并把 `request` 事件**只**投给持有者连接。同一 `(from.id, path)` 至多一条待答请求：重复请求复用同一 `requestId` 与同一窗口；若期间路径已易主，则丢弃旧条目并新建，让请求落到真正的持有者。
- **`reply`**：由持有者应答。`keep` 保留所有权并把请求标记 `declined`；`release` 就地转移所有权给请求方并把请求标记 `transferred`（见下）。判定顺序固定为 **`expired` → `stale` → `not-holder`**：请求不存在或窗口已过是 `expired`；租约已消失或已易主是 `stale`（所有权不变）；应答不来自持有者连接或 `owner.id` 不符是 `not-holder`，且该请求**保持待答**（外人不能替别人消费掉一条请求）。转移时 `owner` 改为请求方、`connectionId` 改为请求方连接、`acquiredAt = now`、`expiresAt = now + ttl`、`holdUntil` 清空。

转移是**就地改写**：没有 generation、没有 epoch、没有持久事务。转移成功、请求过期、持有者断开这三种结局都会向请求方连接发一条 `settled` 事件。

## 事件

| event | 方向 | 载荷 |
|---|---|---|
| `request` | 仲裁器 → 持有者连接 | `requestId`、`path`、`from`、`expiresAt` |
| `settled` | 仲裁器 → 请求方连接 | `requestId`、`path`、`state`（`transferred` / `declined` / `expired`） |

投递是尽力而为：连接不存在时事件被静默丢弃，事件只影响「谁被通知」，**从不影响裁决结果**。`settled` 只在这四种时刻发出：转移成功、持有者 `keep`、窗口过期（含 sweep 回收时）、持有者连接断开。

## `owner` 与 `scope` 的不透明约定

- **`owner` = `{id, session, label}`**，三个非空字符串。仲裁器把 `id` 当作**不透明键**，从不解析、从不构造：它就是客户端侧的 lineage（同一委派链共享一个 id）。`session` 是最后触达的会话，用于投递与展示；`label` 仅用于呈现。仲裁器从不比较 `session` 或 `label` 来判断所有权。
- 归属判定用 `id` **加连接**：同 `id` 同连接是同一所有者（收养 + 刷新）；同 `id` 换了连接按普通冲突处理（`held`），因为「同一 lineage 的另一个进程」在文件系统面前依然是另一个写者。客户端若要避免这种自撞，靠的是同进程共享单例连接，而不是协议。
- **`scope` = 不透明字符串**，客户端传自己的项目根。仲裁器只把它原样存储、原样回带，并且**只**用于 `status` 过滤：不解释、不派生「管理域」、不做路径包含关系推理。协议里没有「域」这个概念，也没有任何需要按域执行的维护操作。
- `paths` 必须是**绝对路径**（POSIX `/...`，win32 盘符或 UNC），无空串、无 NUL 字节；不合法即 `invalid-path`。仲裁器不做规范化（不解析符号链接、不折叠 `..`），字符串相等就是同一路径——规范化是客户端的责任。

## 错误码闭集

| 错误码 | 含义 |
|---|---|
| `protocol-mismatch` | 握手主版本与本实例不符；连接随即关闭 |
| `bad-request` | 帧形状不合法：未知 op、多余字段、类型错误、缺必需字段、重复 hello |
| `invalid-path` | 路径非绝对、为空或含 NUL |
| `held` | 至少一个路径被他人持有且未过期；整批未授予 |
| `not-owned` | `hold` 的整批中至少一个路径不属于本连接/本所有者 |
| `free` | 请求转交的路径当前无有效租约，无需协商 |
| `self` | 请求转交的路径已归请求方自己 |
| `limit` | 保留时长超过固定上限（带 `maxMinutes`） |
| `expired` | 请求不存在、已过期，或应答晚于窗口 |
| `stale` | 请求仍在窗口内，但租约已消失或已易主 |
| `not-holder` | 应答者不是该路径的持有者；请求保持待答 |
| `internal` | 仲裁器内部意外故障（传输层的兜底，正常路径不应出现） |

闭集纪律：**任何错误码都不得指向「人类动作」**。闭集里没有 `blocked`、`needs-attention`、`recovery-required` 之类的码，因为没有任何拒绝需要操作者清理状态——每条租约要么经协商转移，要么等有效期到期后对所有人开放。`docs/features/edit-lock-protocol.md`（本文件）与 `protocol.js` 的 `ERROR_CODES` 一一对应，两侧都有对拍测试。

## 幂等性论证

协议没有去重表、没有墓碑、也没有 request 序号窗口，因为**超时重试的每一次重复执行都与第一次同结果**：

- **`acquire`**：重复申请同一批路径，第一次之后每一路径都已被本所有者持有，于是全部走「收养」分支：结果是同一批 `granted`，`acquiredAt` 不变，只有 `expiresAt` 前移。冲突判定也是纯函数式的——同一时刻重放得到同一答案。
- **`release`**：第一次释放后路径已自由，第二次落到 `notOwned`，且 `notOwned` 不是错误。释放的语义是「让这些路径不再属于我」，这一目标已达到即为幂等。
- **`hold`**：`holdUntil = max(旧值, now + minutes)`，重复执行只会得到同一个或更晚的期限，绝不缩短（下界由调用者给定的 `minutes` 决定，重复调用者给的分钟数相同）。超限与非所有者两种拒绝也与执行次数无关。
- **`reply`**：绑定 `requestId`，而待答请求在第一次应答时就被消费掉。第二次应答必然找不到 pending 记录（`expired`），或者窗口已过（`expired`），或者所有权已在第一次转移（`stale`）。**因此重试 `reply` 不可能转移两次**——不需要任何去重机制，去重能力由「请求是一次性资源」这一点免费提供。
- **`status`**：只读。

结论：客户端在超时后**可以无条件重发**任何请求；协议的正确性不依赖「恰好一次」投递。

## 易失性契约

仲裁器**零持久化**：不写任何文件，不记录历史，不在重启后恢复任何状态。

- 任何时刻被 kill（含 `SIGKILL`）等价于**全部租约同时过期**：所有路径立刻自由，没有任何错误需要上报，磁盘上也没有任何需要清理、修复或确认的权威、备份、账本或记录。
- 保留（`holdUntil`）同样只在内存里。守护进程死了，保留就没了——这是一条**已知且接受**的限制：从守护进程死亡到客户端重连之间，原持有方的保留可能被别人抢走；后果是下一次写入被正常拒绝（可走协商），不会产生需要处置的状态。
- 客户端因此只保留一份**内存租约清单**（`path → 租约`），且它**只用于重放、从不用于裁决**：连接重置或 `startedAt` 变化时，客户端对 `holdUntil > now` 的条目重放 `acquire + hold`，失败的条目直接剔除。裁决永远只在仲裁器一处。
- 本进程的生命周期由空闲窗口决定：最后一个连接断开后开始计时，到点自行退出，进程结束后不会留下任何需要清理的东西（POSIX 残留的 socket 文件由下一次启动的 `EADDRINUSE` 恢复路径回收）。有连接在线时**绝不退出**——连接就是「还有人在用仲裁器」的唯一证据。测试可用 `WEIR_EDITLOCKD_IDLE_MS` 与 `WEIR_EDITLOCKD_SWEEP_MS` 覆盖两个间隔。

## 客户端降级放行（不在本协议内实现）

仲裁器永远**不是**受管写入的前置条件：协议本身不含任何阻塞要求，一个连不上或答不上来的仲裁器不能阻止写入。客户端在自身超时（2s）后杀进程重启、重试一次，仍失败则放行本次写入并记一条审计（同进程内限流）。关键区分是**基础设施失败**（连不上、超时、协议不匹配）才降级放行，**真实冲突**（`held`）永远拒绝。

这条策略、它的唤醒机制与重放清单都实现在适配器里，本协议只负责把「失败」与「冲突」用结构化的错误码分开（`held` 与其余一切）。策略与用户可见行为见 [edit-lock.md](edit-lock.md)。

## 边界与已知限制

- **本机 socket 无认证**：同一用户在机器上的任何进程都能申请租约，与旧实现的本机 peer 通道同级；只读维护端点走宿主认证，不受影响。
- **不保证跨主版本互斥**：不同主版本的客户端连各自的端点，不共享仲裁器。
- **不保护未经本协议写入的行为**：shell、外部编辑器与任何绕过受管工具的写入一律不在保证范围内。
- **不做路径规范化**：同一文件的不同写法（符号链接、大小写、`..` 折叠）在协议里是不同路径；规范化由客户端在调用前完成。
- **不跨机器**：守护进程是单机本机进程；网络文件系统上的互斥不在保证范围内。

## 测试

- `plugins/weir-harness/test/lease-broker-state.test.js`：内核单测——全有或全无、收养与滑动有效期、过期夺权、保留的延长/上限/非所有者、协商四结局、`requestId` 复用、断连释放、跨连接同 id 冲突、过滤器叠加、sweep 回收。
- `plugins/weir-harness/test/lease-broker-server.test.js`：真实 IPC 往返——握手、acquire/status/release、协议主版本不符、断连释放、空闲自退与「有连接不退出」、残留 socket 回收、事件投递与 `reqId` 回带。
- `plugins/weir-harness/test/lease-broker-protocol-doc.test.js`：本文件与 `protocol.js` 的双向对拍（操作名、事件名、错误码闭集），并断言实现源码里出现的错误码不超出闭集。
