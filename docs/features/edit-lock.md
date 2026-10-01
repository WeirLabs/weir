# Edit Lock 编辑锁仲裁（edit-lock）

> **开发中，未挂载**：共享工作目录下的编辑权仲裁；当前已落地两个包内切片（纯内存状态内核 + 只读规范资源身份），均未挂载，用户可见面零变化。

## 概述

锚点校验与文件版本护栏只能证明「内容没有变」，不能证明调用者**仍然持有编辑权**：多个 Harness 进程（或同一进程内多个 agent）共享一个工作目录时，两个写者可以各自校验通过、先后落盘，形成一次静默覆盖。本特性把「谁有权写、这次写还作不作数」的判断收到工作目录级的单一仲裁点上，并让提交与释放、转交、人工解锁共用同一条顺序。

范围与上线硬门槛由本地 OpenSpec 变更材料定义（`openspec/changes/edit-lock-arbitration/`，过程材料不入库）：提案、设计决策 D1–D6、`edit-lock` 能力规格与任务清单均已就绪，**任务清单第 1 组起全部未勾选**。受影响的既有能力为 [hashline-edit.md](hashline-edit.md)、[lsp-integration.md](lsp-integration.md) 与 [todo-continuation.md](todo-continuation.md)；委派与续推调度、共享 runtime 消息、设置与客户端 UI 同在影响面内。

包内已落地两个切片，都不提供插件包导出、不注册工具、没有服务与挂载行，也没有设置键。① **状态内核** `src/edit-lock/state.js`：纯内存、不接触文件系统，只回答「按当前归属与执行授权，这次操作该接受还是拒绝」。② **规范资源身份** `src/edit-lock/resource-identity.js`：同步、只读地观察真实文件系统，回答「这个路径此刻对应哪个规范资源身份，与上次观察是否仍是同一拓扑」。设计中的 manager/gateway、跨进程仲裁、缺失目标的创建协议、可靠存储与 UI 尚未产品化。

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

本特性无配置项：当前既没有设置键，也没有 `cordis.patch.yml` 行。设计材料里出现的参数（协商时限、单次/累计暂停预算、恢复重试预算）都是待实施参数——其中「有限累计暂停预算」尚未获用户确认，未确认前自动暂停保持禁用。

## 设计细节

**状态内核切片**。`src/edit-lock/state.js` 是纯内存模块，不提供 `orrery-harness/edit-lock` 包导出。它分离资源 owner、generation、会话 epoch 与 manager incarnation，通过公开状态操作检查权限。内容版本仍须由后续提交适配器独立校验；协商、实际 commit 与持久化不属于本切片。

**资源身份切片（只读观察，不是权限）**。`src/edit-lock/resource-identity.js` 导出 `createResourceIdentity()`，提供同步 `resolve(filePath, { cwd })` 与 `revalidate(observation)`：

- 既有普通单链接文件 → 冻结的 `{ kind: 'file', resourceId }`，`resourceId` 是 native canonical realpath。
- 缺失目标 → 冻结的 `{ kind: 'missing', ancestor, suffix }`：`ancestor` 是最后存在的规范祖先，`suffix` 是逐字未解析后缀。**缺失观察没有 `resourceId`**，不构成创建键，也不发放任何形式的所有权或发布权。
- `revalidate` 只接受本 factory 自己发出的**原对象**（私有 WeakMap 持有）；副本、其他实例的观察与 `null` 一律按 `unknown observation` 拒绝。
- 观察按构造冻结，不可伪造 `resourceId`，也不携带可序列化的证据。

语义边界：不折叠词法 `..`（`alias/../file` 按 alias 的物理目标解析），不做大小写或 Unicode 归一（本卷把 case 与 NFC/NFD 别名合并为同一 native realpath——测试只记录该卷实测结果，不推广为所有文件系统的等价规则）；忽略内容、时间戳与兄弟文件变化。连续性证据由 entry 与 canonical 祖先链的 dev/ino、逐跳 symlink target 共同构成：文件替换、symlink 替换/改向、祖先替换、新 symlink 祖先与 kind 变化一律 `topology changed`；新增硬链接则使目标不再满足「单链接普通文件」，`resolve` 与 `revalidate` 都直接拒绝（`not editable`）。普通新目录被创建时 `revalidate` **返回一个新的缺失观察**：调用方必须改用并保留这个新观察，原观察只作历史，之后新 symlink 祖先出现时两者都拒绝。

平台与失败语义：仅 darwin/linux，其他平台 factory 直接抛错（Linux 只经代码路径允许，未实机验证）；目录、dangling symlink、symlink 环、特殊文件、`nlink > 1`、`missing/..`、相对 cwd、空路径与含 NUL 路径全部拒绝，不做本地无锁后备。

**Option C 的创建协议是计划中的写入归属例外**。缺失目标的创建成功路径不沿用「先取得归属再写入」的顺序：它没有既有节点可绑定，因此按已确认的 Option C 契约经 manager 串行发布道发布——幂等绑定优先，其次节点存在性冲突判定（既有节点一律冲突，冲突先于任何目标侧副作用），再经 manager 实际持有的 `ctx.fs` 发布，发布成功后解析规范身份并绑定归属与持久结果才返回成功；**创建意图不是所有权**，不发放所有权令牌，也不构造规范资源键，未知结果由持久 intent/outcome、无过期恢复围栏与墓碑兜住。该例外已写入设计材料（D3/D5 与任务 1.6/2.5/2.6），**尚未实现**；本切片的只读观察不属于该路径，也不能当作它的替代。

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
- **无持久化保证**：内核是内存态，进程结束即丢失；崩溃恢复、幂等记录、单实例选举、重启后旧授权失效均**未实现**。「不确定即保留归属、超时/沉默/投递失败不等于同意、中途崩溃保留 uncertain」是后续阶段的目标语义，当前只能用进程内状态表达。
- **后续接入的 fail-closed 要求**：资源别名无法安全归一、可信执行上下文缺失或 manager 断连时拒绝写入，不做本地无锁后备。资源身份切片自行从真实文件系统解析既有节点的 native 规范身份（不折叠词法 `..`、不做大小写/Unicode 归一），但**仍不判定缺失名称的等价性**——不预创建占位文件、不猜测别名，该问题交由 Option C 的创建协议解决；两个切片都不执行任何文件写入，release 也不等于验证通过。
- **未承诺的时点保证**：观察是一串同步 filesystem 调用，**不是原子快照**；外部 shell/IDE 在调用之间改变盘面不在保证内，dev/ino 连续性无法证明不存在 inode reuse 或「改后复原」（ABA）。调用方必须先自行协调变更顺序（manager 生命周期/发布协调）。
- **明确不承诺**：不承诺跨文件回滚（已发布的字节不会因取消自动撤销）、不承诺覆盖任意磁盘写入面（bash、PTC、外部编辑器与任意 filesystem API 都在保证之外）、不承诺分布式多机共识。
- **OpenSpec 任务保持未勾选**：`openspec/changes/edit-lock-arbitration/tasks.md` 第 1 组起全部未完成；任务 2.1 下只有一条阶段进度注记（不勾选、也不代表 2.1 完成）；本文档不把它们标为完成，也不作为启用依据。

## 测试

- **状态内核单测**：`plugins/orrery-harness/test/edit-lock-state.test.js` 9 项通过，覆盖独立围栏、零锁中断、一次性 receipt、逐文件确认、子会话独立、异常保留与查询快照隔离；独立审查另跑 5 项公开接口补充测试（含 100 次取消/恢复循环）通过。这是历史内核批次的证据，不代表运行时接入验收。
- **资源身份单测**：`plugins/orrery-harness/test/edit-lock-resource-identity.test.js` 14 项全部通过（真实 `mkdtemp`/`write`/`mkdir`/`symlink`/`link`/`rename`，真实 `/dev/null` 作特殊节点；平台 dispatch 在独立子进程中替换 `process.platform` 检查，不伪造文件系统成功）。独立装置另跑 `.orrery/edit-lock-verification/resource-review/adversarial.test.mjs`（22 项真 FS 语义）与 `scaling.test.mjs`（1 项）共 23 项通过。
- **复杂度缺陷（已修复，含红绿证据）**：独立装置先复现了指数级父路径重放——`self -> .` 重复 4/8/12/16 次时 lstat 159/2559/40959/655359、readlink 15/255/4095/65535；`traceLink` 当时对相对 target 拼接原始 parent spelling，递归重走了已观察的 symlink 父路径。修复改为从已见证的**物理**父路径逐组件推进：先 lstat 记 inode，是 symlink 才递归记录 target/hop，之后再 native realpath 推进游标；不预先归一整个 target，也不省略嵌套 link。修复后同装置读数为 lstat 17/25/33/41、readlink 4/8/12/16。产品侧同时落一条回归测试：在隔离子进程给 Node 内建加 passthrough 计数（每次仍调用真实 fs），要求每多 4 个组件 lstat/readlink 各自至多 3 倍增长，并断言观察仍是同一个真实文件；无 wall-clock 断言，也无 mock 文件系统。该修复消除已观察父拼写的指数重放，**不**声称整个 resolver 对所有路径/内核 I/O 都是线性。
- **静态检查与产品单测**：改动 `src/**` 后按 AGENTS.md §6 跑 `pnpm --filter orrery-harness run check` 与 `pnpm --filter orrery-harness test`。项目 curated 清单只收无 `node:` 内建依赖的纯模块，因此收录纯内核 `src/edit-lock/state.js`，而 `resource-identity.js` **刻意排除**（`types: []` 剥离 Node 全局）——项目 `run check` 通过**不能**替代该模块自己的严格检查。作为本地补充检查，另用 `--allowJs --checkJs --strict --types node` 直接检查该文件，`typeRoots` 指向本机既有的 `@types/node` 22.20.1，exit 0、零诊断；这是**本机不可移植的补充证据**（该 `typeRoots` 不是仓库依赖，也未被写入 `jsconfig.json`），全程未安装依赖、未写类型 stub、未改仓库 TypeScript 配置。本轮产品全量 988/988 通过、0 跳过。内核批次合入前不引用历史基线的通过数字作为本特性的证据。
- **当前安装版组件级核验（已完成，但不是产品验收）**：DSH desktop `0.2.0-rc.2`（asar 内 DSH 模块同版本、Cordis 4.0.4）上的四份有界运行证据，全部只覆盖组件，不覆盖完整 Loader/profile/GUI：
  - `.orrery/edit-lock-verification/current-dispatch/REPORT.md`：15 项检查。真实 `ToolRuntime.execute` 与 staged scheduler 两条派发路径、同作用域替换 stock `write`/`edit`、每次调用携带有效沙箱策略、取消 signal 传递、拒绝后字节不变、卸载 shadow 后为 `UNKNOWN_TOOL`。调用侧 agent 仍是 fixture，网关是探针实现。
  - `.orrery/edit-lock-verification/current-agent/REPORT.md`：14 项检查、2 个 factory 创建的 agent、10 个完整 turn。真实 `AgentRegistry.create → AgentLoop factory → ReactLoopAgent → scripted LLM → stock write/edit → turn/end`；该组合内父取消不级联子代理（结论限于 Agent factory/driver 本身）。
  - `.orrery/edit-lock-verification/current-ipc/REPORT.md`：15 项检查、14 个真实 turn、4 次成功发布。两个独立进程各自运行真实 agent，mutation 经可信父进程 IPC relay 进入第三个进程，由安装版 `ctx.fs.writeText/editText` 实际发布；旧 owner、版本失配、沙箱拒绝、取消、断连与管理器被 SIGKILL 均不产生越权写，且没有本地后备发布。
- `.orrery/edit-lock-verification/adapter/VERDICT.md`：12 项有界组件检查（最早的一轮，基于 `/tmp/dsh-src` 提取模块，版本 `0.1.7-rc.2`，**不等于当前安装版**）；同一装置其后用当前安装版模块重跑过同规模检查（`.orrery/edit-lock-verification/installed-gate-status.md`，`adapter/run-5GyOM6/evidence.json`），结论标签仍是组件级。报告明确记载：不是两个 Harness；身份与 policy 传输是 fixture；singleton 仅是同一目录的独占 mkdir；重启不恢复 authority。
- **未验收的硬门槛**：完整 Loader/profile 挂载（本会话工具目录没有 `plugin_manager` 与 `cordis_inspect`，按创建指引**不得**手写 profile 绕过）、双真实 Harness 的跨进程仲裁与单实例、可靠 intent/outcome 与崩溃恢复、可信执行意图入口（Continue receipt）、真实 GUI/浏览器传输。任一项未过，本特性不得启用。
