# Edit Lock 编辑锁仲裁（edit-lock）

> **开发中，未挂载**：共享工作目录下的编辑权仲裁；当前只有开发中的纯内存状态内核，用户可见面零变化。

## 概述

锚点校验与文件版本护栏只能证明「内容没有变」，不能证明调用者**仍然持有编辑权**：多个 Harness 进程（或同一进程内多个 agent）共享一个工作目录时，两个写者可以各自校验通过、先后落盘，形成一次静默覆盖。本特性把「谁有权写、这次写还作不作数」的判断收到工作目录级的单一仲裁点上，并让提交与释放、转交、人工解锁共用同一条顺序。

范围与上线硬门槛由本地 OpenSpec 变更材料定义（`openspec/changes/edit-lock-arbitration/`，过程材料不入库）：提案、设计决策 D1–D6、`edit-lock` 能力规格与任务清单均已就绪，**任务清单第 1 组起全部未勾选**。受影响的既有能力为 [hashline-edit.md](hashline-edit.md)、[lsp-integration.md](lsp-integration.md) 与 [todo-continuation.md](todo-continuation.md)；委派与续推调度、共享 runtime 消息、设置与客户端 UI 同在影响面内。

第一切片是包内 `src/edit-lock/state.js` 纯内存状态内核，不提供插件包导出、不接触文件系统、不注册工具、没有服务与挂载行。它只回答「按当前归属与执行授权，这次操作该接受还是拒绝」。设计中的 manager/gateway、跨进程仲裁、可靠存储与 UI 尚未产品化。

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

**内核切片**。当前开发的是包内 `src/edit-lock/` 纯内存模块，不提供 `orrery-harness/edit-lock` 包导出。它分离资源 owner、generation、会话 epoch 与 manager incarnation，通过公开状态操作检查权限。内容版本仍须由后续提交适配器独立校验；协商、实际 commit、路径归一与持久化不属于本切片。

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
- **后续接入的 fail-closed 要求**：资源别名无法安全归一、可信执行上下文缺失或 manager 断连时拒绝写入，不做本地无锁后备。本切片仅检查上游提供的规范资源身份，不自行解决路径别名，也不执行任何文件写入；release 不等于验证通过。
- **明确不承诺**：不承诺跨文件回滚（已发布的字节不会因取消自动撤销）、不承诺覆盖任意磁盘写入面（bash、PTC、外部编辑器与任意 filesystem API 都在保证之外）、不承诺分布式多机共识。
- **OpenSpec 任务保持未勾选**：`openspec/changes/edit-lock-arbitration/tasks.md` 第 1 组起全部未完成；本文档不把它们标为完成，也不作为启用依据。

## 测试

- **内核单测**：`plugins/orrery-harness/test/edit-lock-state.test.js` 当前 9 项通过，覆盖独立围栏、零锁中断、一次性 receipt、逐文件确认、子会话独立、异常保留与查询快照隔离。主会话复跑静态检查和产品全量测试：974/974 通过。独立审查另跑 5 项公开接口补充测试（含 100 次取消/恢复循环），未发现本切片范围内缺陷；这些结果不代表运行时接入验收。
- **静态检查与产品单测**：改动 `src/**` 后按 AGENTS.md §6 跑 `pnpm --filter orrery-harness run check` 与 `pnpm --filter orrery-harness test`。内核批次合入前不引用历史基线的通过数字作为本特性的证据。
- **当前安装版组件级核验（已完成，但不是产品验收）**：DSH desktop `0.2.0-rc.2`（asar 内 DSH 模块同版本、Cordis 4.0.4）上的四份有界运行证据，全部只覆盖组件，不覆盖完整 Loader/profile/GUI：
  - `.orrery/edit-lock-verification/current-dispatch/REPORT.md`：15 项检查。真实 `ToolRuntime.execute` 与 staged scheduler 两条派发路径、同作用域替换 stock `write`/`edit`、每次调用携带有效沙箱策略、取消 signal 传递、拒绝后字节不变、卸载 shadow 后为 `UNKNOWN_TOOL`。调用侧 agent 仍是 fixture，网关是探针实现。
  - `.orrery/edit-lock-verification/current-agent/REPORT.md`：14 项检查、2 个 factory 创建的 agent、10 个完整 turn。真实 `AgentRegistry.create → AgentLoop factory → ReactLoopAgent → scripted LLM → stock write/edit → turn/end`；该组合内父取消不级联子代理（结论限于 Agent factory/driver 本身）。
  - `.orrery/edit-lock-verification/current-ipc/REPORT.md`：15 项检查、14 个真实 turn、4 次成功发布。两个独立进程各自运行真实 agent，mutation 经可信父进程 IPC relay 进入第三个进程，由安装版 `ctx.fs.writeText/editText` 实际发布；旧 owner、版本失配、沙箱拒绝、取消、断连与管理器被 SIGKILL 均不产生越权写，且没有本地后备发布。
- `.orrery/edit-lock-verification/adapter/VERDICT.md`：12 项有界组件检查（最早的一轮，基于 `/tmp/dsh-src` 提取模块，版本 `0.1.7-rc.2`，**不等于当前安装版**）；同一装置其后用当前安装版模块重跑过同规模检查（`.orrery/edit-lock-verification/installed-gate-status.md`，`adapter/run-5GyOM6/evidence.json`），结论标签仍是组件级。报告明确记载：不是两个 Harness；身份与 policy 传输是 fixture；singleton 仅是同一目录的独占 mkdir；重启不恢复 authority。
- **未验收的硬门槛**：完整 Loader/profile 挂载（本会话工具目录没有 `plugin_manager` 与 `cordis_inspect`，按创建指引**不得**手写 profile 绕过）、双真实 Harness 的跨进程仲裁与单实例、可靠 intent/outcome 与崩溃恢复、可信执行意图入口（Continue receipt）、真实 GUI/浏览器传输。任一项未过，本特性不得启用。
