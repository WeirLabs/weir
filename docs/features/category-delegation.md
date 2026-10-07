# 分类委派（category-delegation）

> 专业的事交给专业的模型：主 agent 用 `delegate` 把任务派给绑定合适模型链与专属提示词的子代理。

## 概述

`delegate` 是 Orchestrator 的执行手臂。任务类别（category）各自绑定一条按优先级排序的模型链和一份类别心智提示词；另有三个精选只读研究代理（`finder` 代码检索、`scholar` 文档/OSS 调研、`advisor` 架构咨询）。委派可单个、可批量（≤16）、可放后台，也可选 `mode: 'continuable'` 派生可续聊子代理；子代理不可再委派，保证拓扑可控。

## 用户可见行为

- 主 agent 调用 `delegate({ category, prompt })` 或 `delegate({ agent, prompt })`（两者必须且只能给其一），也可用 `tasks` 批量派发。
- 类别与精选 agent 都可绑定**期望路由**：链上首个可解析档位胜出，整链不可解析时显式报错（**不回退继承**）；精选 agent 未配置链时继承调用方路由。二者均由设置页在线配置、即时生效。
- **停用的目标对模型不可见**：停用类别/agent 不出现在委托目标指引里，也不出现在任何「可选目标」报错文本中；派发它得到显式 disabled 错误。
- 后台委派（`run_in_background: true`）立即返回 job 标识；完成时主 agent 只收到紧凑通知，完整报告用 `job_output` 拉取——报告全文不会自动灌进上下文。
- **可续聊委派**（`mode: 'continuable'`，默认 `one-shot` 零行为变化）：立即返回 `{ continuable: true, children: [{ childId, label, name? }] }`，不等待结果——子代理的每个回合结果经 **DSH 内建结算通知**送达父会话（不包 jobs 包装，结算通知本身就是报告通道）；父 agent 可用 `send_message` 追问/纠偏（只有 continuable 子代才能接收 follow-up）、用 `interrupt_agent` 打断当前回合而不销毁子代理，应用重启后子代理从耐久会话 cold-resume 仍可续聊。顶层与批量 item 级都接受 `mode`，item 覆盖顶层、两级不要求一致（混合批量：one-shot item 等待结果、continuable item 立即返回 childId，渲染先列 childId 清单再附 one-shot 结果）。continuable 子代理 persona 追加 `WORKER_CONTRACT + CONTINUABLE_CONTRACT`（不含 `SUPERVISION_CONTRACT`，无二元终态契约），**不注册进监督协调器**——`supervised_status` 的既有孤儿检测会把它们列为 untracked，这是**正常态而非异常**（`list_agents` 是查看它们的正门）。continuable 子代理占用 DSH continuable 容量池（`maxActiveSubagents`，默认 **8**，满池 `ACTIVATION_LIMIT_REACHED` 显式报错、不排队、不静默降级为 one-shot）——注意批量上限 16 与池 8 的数值差：大 fan-out 仍应使用 one-shot。只读精选目标以 continuable 派遣时经 `deps.agents.get(childId)` 挂同一份只读守卫（与受监督道同一 fail-closed 语义）。
- **受监督分组**（`group` 参数）：同一次调用内的全部任务构成一个组（**组不支持插入**——向已在场的组名再派即报错；批量派发先全量解析后 spawn，中途失败回滚已 spawn 成员并释放组名，未 seal 且全员 terminated 的组名可复用）；成员以 continuable 子代理运行，遵循二元终态契约（只可报 `STATUS: completed` 或 `STATUS: blocked`，无权判定任务存废）；**成员工具面不含 `send_message`**（spawn 时强制 deny，子→父直发通道关闭，唯一上报通道是终态契约；只读成员维持既有 allow 白名单不变且同样挂只读 bash 守卫，主 agent 自己的消息工具与 DSH 结算通知不受影响）；正常结束无终态报告会被催促续推、供应商错误按退避续推（默认 30s 翻倍、上限 5 次）；**每个成员的终态报告经 DSH 内建结算通知即时送达**（通知正文携带成员的 `STATUS/REPORT` 全文，Orrery 不再另发逐成员通知）；**组全员终态后送达恰好一条一行 group-settled 信号**（组名与成员数，不含成员正文；严格排在组内最后一条成员结算通知之后——以父会话日志观察到全员终态结算通知为准，通知缺失时 1s 兜底）；主 agent 可用 `resume_agent`（注入续推上下文恢复 blocked 子代理）、`terminate_agent`（运行中真正打断 / 非运行中仅状态簿记）裁决，以及 `supervised_status` 查看全量监督状态。
- **监督可见性**（`supervised_status` 工具，仅主 agent 可用）：逐子代理报告 id/名称/组/状态（`running`/`blocked`/`completed`/`terminated`）/续推次数/报告摘要，逐组报告成员数与 sealed/settled 状态；并对 DSH catalog 中未被协调器登记的 continuable 子代理做**孤儿检测**（标记 untracked，绝不与空注册表混淆）。
- **Worktree 车道绑定**（`worktree` 参数，详见 [git-worktree.md](git-worktree.md)）：给出车道 id 时，本次调用的每个子代理都绑定到该车道——提示词末尾附车道契约、标签显示为 `<目标> · lane:<id>`、spawn 时在只读守卫之后追加车道守卫（`workdir` 必须在车道内、写入路径限于车道与 `scope`、拒绝改变分支的 git 操作），挂载失败按既有语义拆除子代理；同一车道同时只允许一个写入子代理（`LANE_BUSY`），只读目标可绑定车道做调查而不改变车道状态。写入子代理结束时宿主自动检查车道，前台/后台委派把车道结论（含下一步）直接附在结果里，受监督成员的结论以通知送达。会话处于 Worktree 模式时，未带 `worktree` 的写类委派被拒（`WORKTREE_REQUIRED`）。不带该参数且未开 Worktree 模式时行为与以往完全一致。
- **车道绑定 continuable 子代理以受监督运行**（`mode: 'continuable'` × `worktree`）：本次调用的全部 continuable item 构成**隐式受监督组** `lane:<laneId>`（在首个 continuable item 的位置按 item 顺序派发）——成员获得受监督全套语义：`SUPERVISION_CONTRACT` 终态契约、`send_message` deny、协调器登记、`resume_agent`/`terminate_agent`/`supervised_status` 支持，提示词同样附车道契约、spawn 时挂车道守卫。blocked 不是终态：成员报 blocked 期间车道保持 `working`、绑定保留（其他写入者仍被 `LANE_BUSY` 拒绝），`resume_agent` 注入上下文就地续推；成员的终态报告（或 `terminate_agent` 的 terminate fact）经既有 `childSettled` 路径结算车道并触发宿主检查。组全员终态后隐式组名可复用；组在场时向同一车道再派 continuable 报「组不接受插入」。混合批量（one-shot + continuable item 同调用、同车道）保持既有顺序语义：item 顺序执行，写入者遇到车道被占以 `LANE_BUSY` 诚实失败，绝不静默降级。`lane:` 是保留组名前缀——显式 `group` 使用即以"换个名字"报错。
- 模型链逐档解析：首选不可用自动落到下一档；整链不可用时**显式报错**（点名类别与尝试过的档位），绝不悄悄换到别的模型族。
- `deep` 类别子代理若首行返回 `ESCALATE: deep-plus`，自动携带其发现重派到 `deep-plus` 一层，并声明发生了升级。
- 只读代理试图写/改文件会被拒绝（只读是强制的，不是建议）；其 shell 访问受**只读白名单守卫**（bash；Windows 上预设禁用 bash、改挂 pwsh 工具，守卫经独立的 PowerShell 解析路径覆盖 pwsh）：白名单内只读命令（bash 侧 `ls`、`cat`、`grep`、`find`、`jq`、`git status/log/show/diff/blame` 等；pwsh 侧 `Get-Content`、`Get-ChildItem`、`Select-String`、`Test-Path`、`Start-Sleep` 等只读 cmdlet 与共享的 git 子命令门控）正常执行；写命令、解释器、嵌套 shell、写重定向、pwsh 逃逸向量（`iex`/`Invoke-Expression`/`Start-Process`/`` i`ex `` 转义拼接等）、以及守卫无法证明只读的命令一律 **fail-closed 拒绝**。pwsh 解析按 PowerShell 词法自实现：反引号转义先还原再查表（`` i`ex `` → `iex` → 拒绝）、反引号换行续行与孤立 CR 语句终止在解析前归一化、**`&` 按位置分三角色**（`>&` fd 复制重定向透传交段内 tokenizer 校验；`&&` 恒为分隔符；**段首**单独 `&` 是 `& <word>` 调用操作符、剥除后查表，动态 `& (...)` 直拒；**其余位置的单独 `&` 是后台操作符——fail-closed 拒绝**，它把尾部语句隔离到另一个管道，“`Get-Date & Remove-Item x`”这类洗白形态曾一度完整绕过白名单（真实 pwsh 7.6 实测其尾部确实执行）；即便尾部命令本身在白名单内也拒，因为不可证明的是该结构而非尾部命令）、`$(...)`/`(...)` 递归校验、here-string 检测、内建只读别名表展开（含 `sleep` → `Start-Sleep`）、**大小写不敏感**查表（deny 优先、且同时命中别名展开前原始名）、`--%` 直拒。**脚本块与哈希表字面量（裸 `{...}`/`@{...}`）一律拒绝**——PowerShell 会执行传给 allow 表内 cmdlet 的脚本块主体，且表达式模式的可执行形态无法自信枚举（三轮独立评审各自发现新绕过形态后定为一刀切）；惯用 `Where-Object { $_.Name -like '*.ts' }` 由简化参数语法 `Where-Object Name -like '*.ts'` 承接（属性名/比较符/值只是参数）。赋值右值与表达式 `(...)` 组过两规则校验（`::` 静态访问与全形态方法调用直拒，`$x = [IO.File]::WriteAllText(...)` / `$x = (Get-Item a).Delete()` 不可执行）。git 门控另封堵 `-c alias.*`/`core.pager`/`pager.*` 与 `GIT_CONFIG_*` 环境偷渡。**验收边界（显式登记）**：开发与 CI 均无 Windows 环境——pwsh 解析正确性与绕过抵抗由单测语料（对照 PowerShell 官方语法，含三轮评审的 66 拒/29 放对抗矩阵回归钉死）与 mock wiring 单测保证，真实 pwsh 行为与桌面实机验收待用户在 Windows 环境执行。**已知残留（登记为后续加固项）**：git `-c` 的其它可执行键（`diff.external`/`core.fsmonitor`/`gpg.program` 等）依赖具体子命令触发，形态与 `core.pager` 同类，建议下轮改为白名单式 `-c` 键管理。

## 子代提示词构成

每个 spawn 出来的子代理看到的提示词与工具面都和主 agent 不同，三块差异统一收口在纯模块 `src/shared/child-scope.js`：

- **persona + 协作契约**：类别/精选 agent 的 persona 之后追加 `WORKER_CONTRACT`（模板层英文）：最终消息就是交付给父代理的报告（自包含：改了什么/发现了什么、证据、假设）、不可再委派、不可向用户提问——从任务与代码库决断，真正受阻时以具体阻塞点收尾。受监督成员在其后再追加 `SUPERVISION_CONTRACT`（保持在最后）；非车道 continuable 子代追加的是 `CONTINUABLE_CONTRACT`（父代理可能在任何回合后追问、每个回合的最终消息都会自动送达父代理、被 `interrupt` 打断不等于任务取消——等下一条消息即可），**绝不**携带 `SUPERVISION_CONTRACT`（无二元终态、无协调器）；车道绑定的 continuable 子代改走受监督道（携带 `SUPERVISION_CONTRACT`，见「车道绑定 continuable 子代理以受监督运行」）。三条 spawn 道（一次性/受监督/continuable）的 `personaFor` 装饰点各只有一处。
- **编排者专属 section 在子代渲染为空**：`orchestrator:doctrine`、`orchestrator:delegate-targets`、`orchestrator:worktree-lanes` 三个 section 注册为**静态裸变量引用**（`{{orrery_doctrine}}` / `{{orrery_delegate_targets}}` / `{{orrery_worktree_lanes}}`），抑制由变量 provider 承担——provider 是 DSH 每次提示词装配都以 `(context)` 调用的既有动态点（delegate-targets 清单本就随设置热更新），`isDelegatedChild(context)`（读 `context.agent.session.header.delegationDepth >= 1`，字段缺失 fail-open 到主 agent 渲染）判定为子代时返回 `''`，主 agent 渲染原文、逐字节不变。live 车道看板 context `orrery:worktree-board` 沿用其既有的函数 text 形态、加同一守卫。车道绑定子代理的车道契约本就直接附在其委派提示词里，看板缺席不丢信息。
- **工具面扣除编排者专属工具**：spawn 的唯一装配点 `spawnGuardedChild` 在 lane 变换（如受监督道的 `send_message` deny）之后，把 `CHILD_DENY_TOOLS`（`delegate`/`subagent`/`subagent_fork`/`workflow`/监督与车道管控工具/`exit_plan_mode`/`ask_user_question`/`present`/`edit_lock_*`）并入 `toolFilter.deny` 并去重；带 `allow` 白名单的目标（精选只读 agent）原样返回、语义不动。DSH 的 `tools.restrict()` 会拒绝组合中**未注册**的 deny 名（如 headless 组合没有 `ask_user_question`/`present`/`edit_lock_*`），故 deny 名单与每次 spawn 现读的组合可 restrict 工具集（`ctx.tools.view(undefined).restrictableNames`）求交——组合里没有的工具本来就不出现在子代目录里。`tool.js` 的深度守卫（`delegationDepth >= 1` 拒派）保留为纵深防御第二道。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| 类别注册表 | 内置 9 类别 | 每类别：`description`、`guidance`、`promptAppend`、有序 `chain: [{provider, model, reasoningEffort?}]`、可选 `gateModels`、`disabled` |
| 代理注册表 | `finder`/`scholar`/`advisor` | 精选只读代理定义；每条可选 `chain: [{provider, model, reasoningEffort?}]`、`reasoningEffort`、`disabled` |
| `delegateAgentChains` | 空（继承调用方路由） | 精选 agent 链覆盖（JSON map，整链替换；未知名告警忽略）。设置页键：`delegateAgentChains` |
| `delegateDisabledCategories` | 空 | 停用类别名单（设置页提供**逐类别勾选列表**，勾选结果合成 JSON 字符串数组；只能追加停用）；停用者不入模型可见清单、不可派发。设置页键：`delegateDisabledCategories` |
| 模型族提示词变体表 | 内置 | 按模型族选择提示词变体（Claude/Kimi 式清单风格、GPT 式原则风格、其余中性），可覆盖 |
| `readOnlyBash.enabled` | `true` | 只读 bash 守卫开关；`false` 时只读代理工具面回落到 v0.1.0（无 bash）。设置页键：`robashEnabled` |
| `readOnlyBash.allow` | 初版白名单 | 命令级只读白名单（basename 匹配），可迭代补全。设置页键：`robashAllow`（JSON 字符串数组） |
| `readOnlyBash.gitAllow` | 10 个子命令 | git 只读子命令白名单（`status log show diff blame grep ls-files ls-tree rev-parse describe shortlog`）。设置页键：`robashGitAllow` |
| `readOnlyBash.deny` | 显式 deny 列表 | 优先于 allow 的整词 deny（`rm`、`sudo`、解释器、包管理器等）。设置页键：`robashDeny` |
| 白名单三表语义 | **产品默认 + 用户追加** | 每个列表键独立解析：产品默认项**无条件在场**；键在场且非空 → 其条目**追加**到默认项之后（去重、保序）；键缺席或为 `[]` → 不追加。**任何配置都无法移除默认项**，因此不再存在"空数组 = 显式清空"（该能力已退役）；坏 JSON 设置服务激活即败。设置页提供结构化行编辑（`RobashListEditorField`），无需手写 JSON，面板只呈现**你要追加的项** |
| `readOnlyPwsh.allow` / `readOnlyPwsh.deny` | 初版 pwsh 白名单 | pwsh 侧只读 cmdlet 白名单与逃逸向量 deny（大小写不敏感、deny 优先、内建别名表展开后查表）。设置页键：`robashPwshAllow` / `robashPwshDeny`（JSON 字符串数组，语义同上表）；git 子命令门控共享 `robashGitAllow` |
| 平台等待原语 | `sleep` / `Start-Sleep` | 两侧都放行：POSIX 侧 `sleep` 在 bash 白名单里，win32 侧 `Start-Sleep` 在 pwsh 白名单里，且 `sleep` 作为 pwsh 内建 ReadOnly 别名（→ `Start-Sleep`）登记在别名表。两侧必须同时在场，否则同一个“等待”操作会 macOS 放行、Windows 拒绝 |
| 名单来源不变式 | 行 config **不得**携带白名单表 | 五张表**不再**出现在 `cordis.patch.yml` 的 `orrery-settings` 行里——patch 层的 `config` 是**整体替换**而非深合并，任何住在行里的默认值都可能被某个 profile 行整块丢弃（这正是"改过列表的用户永远收不到后续默认项"的成因）。该不变式由 `test/robash-whitelist-parity.test.js` 守护：行内出现任一白名单键即失败（已做变异验证）。`robashEnabled` 这类纯开关仍留在行里 |
| 默认值来源文件 | `whitelist-defaults.json`（bundle 根） | 五张表的**产品默认值**由插件在**运行时自己读取**该文件（`new URL('../../whitelist-defaults.json', import.meta.url)`），不经任何配置层，因此 profile 行替换不掉它。五张表的 canonical 常量 `DEFAULT_TABLES` 住在守卫核心模块 `src/delegate/robash-guard-core.js`（单一表示），`src/shared/whitelist-defaults.js` 的 `FALLBACK_TABLES` 从核心**正向派生**并按表兜底：文件缺失/不可读、或某表畸形/非字符串数组 → 该表回退到常量并记一行英文告警，其余表仍取自文件，**绝不因坏文件放宽守卫、也不拒绝启动**。该文件默认不向用户开放、不在设置页出现 |
| 默认值接管与重读 | `robashDefaultsPath` / `robashDefaultsReload` | 高级用户可把路径指向自己的副本以**整体接管**默认值（此时该文件是其默认值的完整来源，缺项即不生效）；改完文件后递增 `robashDefaultsReload` 即**显式重读**（每进程只读一次并缓存，这是唯一重读入口，磁盘 IO 不进入守卫的逐命令判定路径）。两个键均为配置面键，刻意**不**出现在设置页 |
| 旧的基线漂移报告 | 已退役 | `src/shared/whitelist-drift.js` 及其启动期告警随本变更移除：它的唯一职责是报告"行 config 遮蔽基线"，而默认值改由模块自己读文件交付后该类漂移在结构上不可能发生。其"运行时读随包文件"的范式被 `src/shared/whitelist-defaults.js` 继承 |
| `supervision.maxRetries` | `5` | 受监督子代理续推连续上限（催促与供应商错误重试共用） |
| `supervision.initialBackoffMs` | `30000` | 供应商错误续推初始延迟，逐次翻倍 |
| `supervision.maxBackoffMs` | `300000` | 续推延迟封顶（5min） |

以上 `readOnlyBash.*` / `readOnlyPwsh.*` / `supervision.*` 均为 volatile config，**在同一进程内即提交即生效，无需重启应用、无需重建会话**。生效时机分两条路径，二者都实现，不能只靠一条：

- **读取时解析**——设置服务每次 `get` 都重新计算 section，因此 `delegate` 在**每次消费点**重新解析，而不是在 `apply` 期读一次：委派时解析只读工具面与守卫列表（一次委派内取同一份快照，不会出现「已授予 shell 但守卫已关」），建协调器时解析监督参数。
- **提交时推送**——协调器是按父会话缓存的长生命周期对象，不会再随新委派重建；因此 `apply` 同时订阅设置服务的变更广播，把新的监督参数推入**已存在**的协调器（与 `src/lsp/index.js` 同一范式）。

注：`intentGate`/`todoDriver`/`contextGuard`/`hashlineEdit` 四个插件仍在 `apply` 期做同类快照，**热更新语义未覆盖它们**，需重启才生效。设置页保存触达这些键（以及挂载门 `editLockEnabled`）并落地后，会在顶部横幅点名提醒哪些改动需要重启，见 [settings-page.md](settings-page.md)。

## 设计细节

- 模块布局（`orrery-harness/delegate`）：`index.js` 是约 90 行的组合根，实际职责分住五个命名模块——`settings-overlay.js`（delegate 专属的设置覆盖层工厂：三层 append/去重与整链替换语义，刻意不套用 shared `overlayConfig` 的浅合并模型）、`target-resolver.js`（「item + 父路由 → persona/options/filter/label」唯一脊柱，provider 快照缓存闭包化）、`supervision-mount.js`（协调器工厂与六个效应器）、`supervision-tools.js`（`resume_agent`/`terminate_agent` 定义，object-rooted schema）、`audit-readers.js`（监督重建的三个冷读读取器）；派发走 `ctx.subagents.start`，一次调用携带 `agentOptions`（钉模型与推理档）、`persona`、`toolFilter`（只读白名单）、`maxDepth: 1`（禁止再委派——该拓扑契约全仓只剩一处）。
- spawn 道轴收编在 `spawn-adapter.js`：`spawnGuardedChild` 让「started ⇒ 已挂守卫」成为不变量，四条道（一次性/后台 job 包装/受监督/continuable）按 lane policy 参数化共享同一份请求装配与守卫核心；编排层（escalation 重派、两阶段/回滚/seal、mode 分发与互斥校验）留在 `tool.js`。
- **continuable 派遣道**（`continuableLane()`，非车道 `mode: 'continuable'` 专用——车道绑定的 continuable item 在 execute 分发层改走受监督道，见「车道绑定 continuable 子代理以受监督运行」）：与受监督道同形地走 `subagents.startContinuable({ provider: 'spawn', label, request, signal })`（label/signal 在 request 之外）；`toolFilterFor` 恒等（`send_message` 已在公共 `CHILD_DENY_TOOLS` 里，由装配点统一并入，子→父通道对所有道保持关闭）；只读目标的守卫经 `deps.agents.get(childId)` 挂载（缺 handle 即抛错，与受监督道同机制）；结果送达、追问、打断、cold-resume 全部落在 DSH 内建通道上，Orrery 零新增通知基建。
- 链解析规则：provider 已注册且（其 catalog 为空或包含该 model）即可解析；`reasoningEffort` 支持度经模型信息校验；适配器更新事件触发重解析。
- 精选 agent 与类别**共用同一条解析路径**：`resolveTargetRoute`（原 `resolveCategory`）对任何 `{ chain, gateModels, disabled }` 目标定义生效。agent 分支的基线注册表经 `overlay.agentsNow()` 取得（`CURATED_AGENTS` ∪ 行 config，再叠设置面的整链替换），与 `categoriesNow()` 同形；agent 整链不可解析时抛显式错误并点名 agent 与尝试过的档位，**不回退继承**。
- 兑现两处既有契约：`delegate(agent=…, model=…)` 的 `model` 覆盖生效为「否则会使用的那条路由」的 model id 覆盖（provider 取该路由的 provider；provider catalog 未列出不拒绝——DSH 契约里 catalog 是 advisory）；精选 agent 的 `reasoningEffort` 提示仅在所选路由确实声明该档位时应用，否则静默丢弃。
- 委托目标指引：delegate 插件注册 prompt section `orchestrator:delegate-targets`（order = doctrine + 10），文本是静态英文模板 + 变量 `{{orrery_delegate_targets}}`；provider 在**每次提示词装配**时读 `categoriesNow()`/`agentsNow()` 求值，故设置提交即改变清单。清单渲染是纯模块 `src/delegate/targets.js`（启用过滤、注册表顺序、空集合兜底）。
- 可见性三处收口：指引清单过滤 `disabled`；派发路径复用既有 unavailable 错误；`unknown_target` 的 available 名单只列启用目标。
- 后台道一律走 one-shot job（拉取语义），保证报告全文不自动入上下文。
- **`load_skills` 批量预检**（会话能力管理器）：所有 Skill 消费者（模型目录、`skill` 工具、slash、委派、意图门）共享预设层选择 provider 的同一份「已选 + 可用 + 调用权限」视图；委派在派发前把整批 `load_skills` 对父会话该视图一次性预检（单一快照 revision），任一未选/不可模型调用即**整批零 spawn**——监督组名在预检失败时根本不被注册，可立即重用；`maxDepth: 1` 与精选只读契约不变。
- 类别与 `model` 同时提供会被拒绝（类别已含路由，不允许二义）。
- 多 Agent 协作全部自研，不依赖 DSH 官方 experimental Agent Team 插件。
- 只读 bash 守卫：派生只读子代理（精选代理或 `readOnly` 类别）后同 tick 内将 `tools.guard` 注册到该子代理自身作用域（`localAgent.ctx`），逐命令校验——管道/序列/命令替换逐段解析（含 `$(...)`/反引号递归）、basename 归一、git 子命令门控（`-c alias.*` 注入显式拒绝）、写重定向仅放行 `/dev/null` 与 fd 复制、heredoc/进程替换/子 shell 分组 fail-closed；守卫挂载失败则销毁子代理并报错（只读代理绝不无守卫运行）。**参数维度的危险 flag 表**（`DANGEROUS_FLAGS`）：白名单只决定「哪个二进制可以跑」，而**参数**可能把一个只读命令变成写盘或任意执行原语，故逐命令声明危险参数——`find` 的 `-delete`/`-exec` 家族、`sort` 的 `-o`/`--output`（含 `-ofile` 粘连与 `--output=` 等号形式）、`rg` 的 `--pre`/`--pre-glob`/`--hostname-bin`（在每个文件上执行任意命令）与 `--sort`/`--sort-files`、`date` 的 `-s`/`--set`/`-f`/`--file`；另有 `positionalWrite` 规则用于**第二个位置参数即输出文件**的命令（`uniq in.txt out.txt`；守卫场景下 stdin 不可用，故单个文件参数是读、第二个必然是写）。新增二进制只需在表里加一行。已知残留边界：`--pre <VALUE>` 的“值形式”（仅当值不含引导符时）未被识别，fail-open。
- 受监督分组（`src/delegate/group-coordinator.js`）：组内成员经 `startContinuable` 派发（persona 附终态契约段，工具面强制 deny `send_message`）；协调器经 `session/event` 过滤子会话的 `assistant/message`（终态解析）与 `turn/end`（分类：completed+终态→定案 / completed 无终态→催促 / error→退避计时器 sendMessage / aborted(user)→记 blocked 不自动续推 / 其余 aborted→terminated）；成员终态感知由 DSH 内建结算通知承担（即时、携带终态全文），协调器不再生成逐成员通知；**父面唯一自产通知**是组全员终态后的一行 group-settled 信号，经 `deps.notifyParent` 效应器以 timer 延迟投递、**镜像 DSH 内建结算通道（`sendWaking`）语义**——父忙→`steer` 同轮紧随注入、父闲→`followup` 唤醒；步边界准入不打断流式响应；投递受**严格有序门控**——协调器在父会话日志观察到组内全部成员的终态结算通知（`subagent-settled` 源、且到达于该成员终态之后）才放行信号，保证信号永远排在最后一条 Background 通知之后，通知缺失时 1s 兜底投递；失败记日志、有界重试 3 次、最终失败写审计 note）——此前的 outbox/busy 台账/turn-stopping 冲刷已全部退役（与 todo-driver 的边界竞争随之消除）；`resume_agent` 经 `sendMessage` 注入续推上下文并翻转 running（投递失败回退 blocked 并报错）；`terminate_agent` 运行中经 `interrupt`（ancestor 授权）真打断、非运行中仅簿记；催促/退避投递失败降级为 blocked 并审计；监督审计走冷安全通道（`src/shared/audit.js`）：每次状态迁移发出**结构化事实**——`orrery/supervision/spawn`（成员登记）、`orrery/supervision/seal`（组封口，含 memberIds）、`orrery/supervision/settle`（终态定案，含 status/report）、`orrery/supervision/resume`（续推）、`orrery/supervision/terminate`（终止，含 reason）、`orrery/supervision/group-settled`（组全员终态）、`orrery/supervision/group-released`（失败批次释放组名）。
- **监督注册表接缝**（`src/delegate/group-coordinator.js`）：协调器的注册表存储是实现细节，消费者只经状态机词汇的查询接口——`ownsChild(id)`（归属判定）、`memberOf(ref)`（记录浅拷贝、不含 `lastText`，供测试钉行为）、`snapshot()`（children/groups/meta 全拷贝，未 hydrate 时 meta 为 `null`）、`untrackedAgainstCatalog(entries)`（孤儿检测谓词）；成员/组记录形状由唯一构造函数 `createMemberRecord`/`createGroupRecord` 产生（registerMember/hydrate/rehydrate 三处收敛），终态判定与孤儿检测谓词各只有一份实现（`isTerminalStatus`/`untrackedCatalogEntries`）；一切查询返回拷贝——不存在任何能改写存储的导出通道（hydrate 是唯一 meta 写入点）。

## 边界与失败语义

- 参数二义（`category` 与 `agent` 同给或都不给）→ invalid-arguments 错误。
- 类别整链不可解析 → 显式 "category unavailable" 错误，点名类别与档位。
- 只读代理的写/编辑调用 → 拒绝并注明只读原因；精选代理调 `delegate` → 深度限制错误。
- **保证**：子代理永不可再委派（拓扑深度恒为 1）。
- 设置提交的**原子边界**：一次委派内的工具面与守卫列表来自同一份解析结果；提交只影响**此后**的委派，以及**已建立**协调器的**后续**续推判定。已派发代理已拿到的工具面不被回溯收改（与只读守卫「挂载即生效、逐调用判定」的既有语义一致）。
- 精选 agent 整链不可解析 → 显式错误点名 agent 与尝试过的档位，**不回退**到继承路由；只有空链才继承。
- 停用目标**保证**不出现在任何模型可见面（指引清单、工具描述、报错名单）；注册表级 `disabled` 不可被设置面解除（设置面只能追加停用）。
- `worktree` 参数：能力关闭 → `WORKTREE_DISABLED`；车道不存在 → `UNKNOWN_LANE`；车道不可派工 → `LANE_NOT_DISPATCHABLE`（附下一步）；已有写入者 → `LANE_BUSY`；spawn 失败时车道预留被回滚，不会卡在 `working`。
- **`mode` 互斥表**（均在 execute 入口、任何 preflight/spawn 之前拒绝，invalid-arguments 错误且零子代泄漏；`mode` 未知值同样拒绝）：

  | 组合 | 结果 |
  |---|---|
  | `mode: 'continuable'` × `run_in_background: true` | 拒绝（continuable 本身即异步，jobs 包装冗余） |
  | `mode`（任一值）× `group` | 拒绝（受监督组已隐含 continuable 成员） |
  | `mode: 'continuable'` × `worktree` | **允许**：隐式受监督派发（见「车道绑定 continuable 子代理以受监督运行」；此前因「车道假定恰好结算一次的 worker」而拒绝） |
  | `group` 名带保留前缀 `lane:`（无论是否带 `worktree`） | 拒绝（该前缀属于车道绑定 continuable 派发的隐式组名——换个名字） |

- **continuable 容量耗尽**（`ACTIVATION_LIMIT_REACHED`，池默认 8）→ 显式工具错误：点名容量上限、建议改用 one-shot 或等待在位子代结算；**不排队、不静默降级**，失败启动不留任何已发布子代理。
- **continuable 守卫失败残留边界**：continuable 句柄无 `dispose`，只读守卫挂载失败（start 已成功）时原始错误原样上抛（道上为错误附 `childId`），`tool.js` catch 侧对已知 childId 尽力 `interrupt` 后传播——子代理可能残留但未被使用，父代理拿到响亮错误并可凭 childId 显式处置；发生概率低（attach 是同步监听器注册）。

## 与编辑锁的关系

[Edit Lock 编辑锁仲裁](edit-lock.md) 开启时（实验特性、默认关闭），每个子代理就是**它自己的会话**，持有自己的一份锁状态：

- 子代理占用的文件对父会话与兄弟子代理一样按普通占用拒绝——父会话要改同一个文件，只能等它释放或请求转交（`edit_lock_try_steal`）。
- 子代理正常结束时释放自己的锁；被停止或出错的会话保留锁，留给人工处理。
- 停止父会话不会停止已经在跑的子代理，也不撤销子代理的编辑权：父会话收回的只是它自己的那部分。

## 测试

- 单元测试：`test/` 覆盖参数校验、链解析（含死链报错）、变体选择、ESCALATE 重派、批量默认值；五个布局模块各有直测套件——`settings-overlay.test.js`（三层 append/去重语义与平台注入）、`target-resolver.test.js`（解析脊柱与「每次解析恰好一次覆盖层」）、`supervision-tools.test.js`（schema 形状与 depth 门）、`supervision-mount.test.js`（notifyParent 策略与 feed 路由，真实短定时器）、`audit-readers.test.js`（临时目录 JSONL 夹具），spawn 道轴由 `spawn-adapter.test.js`（装配形状/两种拆除语义/调用次序/禁用边角/CHILD_DENY_TOOLS 合并与 allow 不动/persona 契约装饰）钉住；子代提示词构成由 `test/child-scope.test.js`（`isDelegatedChild` 真值表、`childToolFilter` 合并与 restrictable 求交、`WORKER_CONTRACT` 逐字钉死）与各处「静态裸变量引用 + provider 抑制」的渲染断言（`core.test.js`/`delegate.test.js`/`worktree-surfaces.test.js`）及 `targets.test.js` 的 `renderDelegateTargetsSection` 组合一致性钉住；守卫采用「一个深核心 + 两个薄壳适配器」结构——`src/delegate/robash-guard-core.js` 收编全部跨壳共享策略（canonical 白名单 `DEFAULT_TABLES`、git 门控、`GIT_CONFIG_*` 拒绝、递归预算、重定向 sink 策略、`gateExecutable` 判定尾段、按壳键控的 `DANGEROUS_FLAGS` 与共享理由模板 `reasons`），`robash-guard.js`/`robash-guard-pwsh.js` 只保留壳词法（scanner/tokenizer/别名展开）并各导出同一签名 `check(command, lists)`；`test/robash-guard.test.js` 与 `test/robash-guard-pwsh.test.js` 的语料（放行/拒绝/注入绕过/自定义列表）作为行为冻结证据逐字存活；`test/robash-whitelist-parity.test.js` 缩为「`whitelist-defaults.json` ↔ `DEFAULT_TABLES`」单组比对 + 行内不得出现白名单键的既有不变式；`test/group-coordinator.test.js` 覆盖协调器全分支（组登记/禁插入/终态解析/催促/退避/耗尽/打断分类/resume/terminate/group-settled 信号渲染/失败批次释放组名/各投递失败降级）与挂载层（组派发、两阶段解析、回滚与组名复用、只读成员守卫、延迟 followup 投递）；**volatile 热更新**由 `test/delegate.test.js` 的四条 `hot reload:` 用例（提交后新委派的守卫行为与服务面立即改变、提交后新委派 fail-closed、提交不回溯收改已派发代理、dispose 退订）与两条挂载层用例（提交抵达**已建立**协调器、提交改变下一次受监督派发的只读面）覆盖；`test/group-coordinator.test.js` 另有 `setSupervision` 三条用例（收紧上限、重调退避而不动登记状态、忽略三个调参键之外的键）。
- 新增 `test/targets.test.js`：指引渲染（启用过滤 / 注册表顺序 / 空集合与全停用兜底 / 模板只引用已注册变量）；`target-resolver.test.js` 补 agent 链解析、`model` 覆盖、effort 支持度、报错 available 名单过滤；`settings-overlay.test.js` 补 `agentsNow()` 与 `disabledCategories` 合并；`settings.test.js` 补两个新键的解析与坏 JSON 报错。
- `test/worktree-surfaces.test.js`：`worktree` 参数的绑定、标签、契约、结算附带、spawn 失败回滚、`WORKTREE_REQUIRED`/`WORKTREE_DISABLED`/`LANE_BUSY` 透传，以及 spawn 道车道守卫在一次性与受监督两条通道上的挂载与 fail-closed 拆除。
- continuable 形态由三层钉住：`test/delegate.test.js` 的 `delegate continuable mode` 套件（保留互斥零泄漏（continuable×background、mode×group、保留 `lane:` 前缀组名拒绝）、未知 mode 值、立即返回 childId、混合批量、item 级双向覆盖、`ACTIVATION_LIMIT_REACHED` 显式文案、守卫失败后 catch 侧尽力 interrupt、工具面 object-rooted enum 与描述段）、`test/spawn-adapter.test.js` 的 continuable 道套件（start 形状/persona 双契约且无 SUPERVISION_CONTRACT/toolFilter 恒等与公共 deny 合并/守卫经 `agents.get(childId)`/缺 handle 逐字报错/守卫失败原样上抛附 childId/禁用快照边角）、`test/child-scope.test.js` 的 `CONTINUABLE_CONTRACT` 逐字钉死与三要点断言、`test/core.test.js` 的 doctrine 形态选择指引渲染断言；车道绑定 continuable 的隐式受监督派发由 `test/worktree-surfaces.test.js` 钉住（隐式组 `lane:<laneId>` 派发与成员登记、SUPERVISION_CONTRACT persona 与 `send_message` deny、车道契约与绑定提交、结果渲染点名隐式组与车道、显式 `lane:` 组名/mode×group 拒绝零车道动作、group×worktree 合法、混合批量顺序语义、活组再派拒绝、组终态后隐式名复用），端到端由集成场景 `lane-resumable` 钉住（见 [git-worktree.md](git-worktree.md)）。
- 集成测试：`delegate` 场景（父委派、子会话、结果回传）；`robash` 场景——只读子代理的受守卫 bash：放行命令执行、写命令拒绝、目标文件零损伤；`grouped` 场景——受监督分组端到端：批量派发、供应商错误成员退避续推恢复、成员正文经 DSH 内建结算通知（`subagent-settled` 源）送达父会话、一行 group-settled 信号到达、父 agent 观察到信号；`continuable` 场景——`mode: 'continuable'` 端到端：立即返回 childId、首轮结果经内建结算通知送达父会话、父 agent `send_message` 追问、子代带着既有上下文作答、第二次结算通知到达、父 agent 观察到两轮结果；`escalate` 场景（ESCALATE 重派与发现传递）；`background` 场景（后台委派：紧凑通知到达、报告全文不入父上下文、父 agent 观察到通知）；`terminate` 场景（运行中成员真打断（turn aborted）、组 settle 信号到达）；`rehydrate` 场景（两阶段重启：blocked 报告经内建结算通知送达、send_message 工具面契约、审计事实链含 resume 与 group-settled、重建后 resume_agent 复工、group-settled 信号重发）；`child-prompt` 场景——子代首请求系统提示词无 `Orchestration Doctrine`/`Delegation targets`/`Worktree lanes` 段落、tools 载荷不含任何 `CHILD_DENY_TOOLS` 成员、persona 携带 `WORKER_CONTRACT` 关键句，且父面三者俱在（抑制只作用于子代）。
- `delegate` 场景断言父系统提示词含委托目标指引（含启用类别名与精选 agent 名）；新增停用场景：被停用类别既不在小节里，派发它又得到显式 disabled 错误且不出现于 available 名单。
