# 分类委派（category-delegation）

> 专业的事交给专业的模型：主 agent 用 `delegate` 把任务派给绑定合适模型链与专属提示词的子代理。

## 概述

`delegate` 是 Orchestrator 的执行手臂。任务类别（category）各自绑定一条按优先级排序的模型链和一份类别心智提示词；另有三个精选只读研究代理（`finder` 代码检索、`scholar` 文档/OSS 调研、`advisor` 架构咨询）。委派可单个、可批量（≤16）、可放后台；子代理不可再委派，保证拓扑可控。

## 用户可见行为

- 主 agent 调用 `delegate({ category, prompt })` 或 `delegate({ agent, prompt })`（两者必须且只能给其一），也可用 `tasks` 批量派发。
- 类别与精选 agent 都可绑定**期望路由**：链上首个可解析档位胜出，整链不可解析时显式报错（**不回退继承**）；精选 agent 未配置链时继承调用方路由。二者均由设置页在线配置、即时生效。
- **停用的目标对模型不可见**：停用类别/agent 不出现在委托目标指引里，也不出现在任何「可选目标」报错文本中；派发它得到显式 disabled 错误。
- 后台委派（`run_in_background: true`）立即返回 job 标识；完成时主 agent 只收到紧凑通知，完整报告用 `job_output` 拉取——报告全文不会自动灌进上下文。
- **受监督分组**（`group` 参数）：同一次调用内的全部任务构成一个组（**组不支持插入**——向已在场的组名再派即报错；批量派发先全量解析后 spawn，中途失败回滚已 spawn 成员并释放组名，未 seal 且全员 terminated 的组名可复用）；成员以 continuable 子代理运行，遵循二元终态契约（只可报 `STATUS: completed` 或 `STATUS: blocked`，无权判定任务存废）；**成员工具面不含 `send_message`**（spawn 时强制 deny，子→父直发通道关闭，唯一上报通道是终态契约；只读成员维持既有 allow 白名单不变且同样挂只读 bash 守卫，主 agent 自己的消息工具与 DSH 结算通知不受影响）；正常结束无终态报告会被催促续推、供应商错误按退避续推（默认 30s 翻倍、上限 5 次）；**每个成员的终态报告经 DSH 内建结算通知即时送达**（通知正文携带成员的 `STATUS/REPORT` 全文，Orrery 不再另发逐成员通知）；**组全员终态后送达恰好一条一行 group-settled 信号**（组名与成员数，不含成员正文；严格排在组内最后一条成员结算通知之后——以父会话日志观察到全员终态结算通知为准，通知缺失时 1s 兜底）；主 agent 可用 `resume_agent`（注入续推上下文恢复 blocked 子代理）、`terminate_agent`（运行中真正打断 / 非运行中仅状态簿记）裁决，以及 `supervised_status` 查看全量监督状态。
- **监督可见性**（`supervised_status` 工具，仅主 agent 可用）：逐子代理报告 id/名称/组/状态（`running`/`blocked`/`completed`/`terminated`）/续推次数/报告摘要，逐组报告成员数与 sealed/settled 状态；并对 DSH catalog 中未被协调器登记的 continuable 子代理做**孤儿检测**（标记 untracked，绝不与空注册表混淆）。
- 模型链逐档解析：首选不可用自动落到下一档；整链不可用时**显式报错**（点名类别与尝试过的档位），绝不悄悄换到别的模型族。
- `deep` 类别子代理若首行返回 `ESCALATE: deep-plus`，自动携带其发现重派到 `deep-plus` 一层，并声明发生了升级。
- 只读代理试图写/改文件会被拒绝（只读是强制的，不是建议）；其 shell 访问受**只读白名单守卫**（bash；Windows 上预设禁用 bash、改挂 pwsh 工具，守卫经独立的 PowerShell 解析路径覆盖 pwsh）：白名单内只读命令（bash 侧 `ls`、`cat`、`grep`、`find`、`jq`、`git status/log/show/diff/blame` 等；pwsh 侧 `Get-Content`、`Get-ChildItem`、`Select-String`、`Test-Path`、`Start-Sleep` 等只读 cmdlet 与共享的 git 子命令门控）正常执行；写命令、解释器、嵌套 shell、写重定向、pwsh 逃逸向量（`iex`/`Invoke-Expression`/`Start-Process`/`` i`ex `` 转义拼接等）、以及守卫无法证明只读的命令一律 **fail-closed 拒绝**。pwsh 解析按 PowerShell 词法自实现：反引号转义先还原再查表（`` i`ex `` → `iex` → 拒绝）、反引号换行续行与孤立 CR 语句终止在解析前归一化、**`&` 按位置分三角色**（`>&` fd 复制重定向透传交段内 tokenizer 校验；`&&` 恒为分隔符；**段首**单独 `&` 是 `& <word>` 调用操作符、剥除后查表，动态 `& (...)` 直拒；**其余位置的单独 `&` 是后台操作符——fail-closed 拒绝**，它把尾部语句隔离到另一个管道，“`Get-Date & Remove-Item x`”这类洗白形态曾一度完整绕过白名单（真实 pwsh 7.6 实测其尾部确实执行）；即便尾部命令本身在白名单内也拒，因为不可证明的是该结构而非尾部命令）、`$(...)`/`(...)` 递归校验、here-string 检测、内建只读别名表展开（含 `sleep` → `Start-Sleep`）、**大小写不敏感**查表（deny 优先、且同时命中别名展开前原始名）、`--%` 直拒。**脚本块与哈希表字面量（裸 `{...}`/`@{...}`）一律拒绝**——PowerShell 会执行传给 allow 表内 cmdlet 的脚本块主体，且表达式模式的可执行形态无法自信枚举（三轮独立评审各自发现新绕过形态后定为一刀切）；惯用 `Where-Object { $_.Name -like '*.ts' }` 由简化参数语法 `Where-Object Name -like '*.ts'` 承接（属性名/比较符/值只是参数）。赋值右值与表达式 `(...)` 组过两规则校验（`::` 静态访问与全形态方法调用直拒，`$x = [IO.File]::WriteAllText(...)` / `$x = (Get-Item a).Delete()` 不可执行）。git 门控另封堵 `-c alias.*`/`core.pager`/`pager.*` 与 `GIT_CONFIG_*` 环境偷渡。**验收边界（显式登记）**：开发与 CI 均无 Windows 环境——pwsh 解析正确性与绕过抵抗由单测语料（对照 PowerShell 官方语法，含三轮评审的 66 拒/29 放对抗矩阵回归钉死）与 mock wiring 单测保证，真实 pwsh 行为与桌面实机验收待用户在 Windows 环境执行。**已知残留（登记为后续加固项）**：git `-c` 的其它可执行键（`diff.external`/`core.fsmonitor`/`gpg.program` 等）依赖具体子命令触发，形态与 `core.pager` 同类，建议下轮改为白名单式 `-c` 键管理。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| 类别注册表 | 内置 9 类别 | 每类别：`description`、`guidance`、`promptAppend`、有序 `chain: [{provider, model, reasoningEffort?}]`、可选 `gateModels`、`disabled` |
| 代理注册表 | `finder`/`scholar`/`advisor` | 精选只读代理定义；每条可选 `chain: [{provider, model, reasoningEffort?}]`、`reasoningEffort`、`disabled` |
| `delegateAgentChains` | 空（继承调用方路由） | 精选 agent 链覆盖（JSON map，整链替换；未知名告警忽略）。设置页键：`delegateAgentChains` |
| `delegateDisabledCategories` | 空 | 停用类别名单（JSON 字符串数组，只能追加停用）；停用者不入模型可见清单、不可派发。设置页键：`delegateDisabledCategories` |
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

注：`intentGate`/`todoDriver`/`contextGuard`/`hashlineEdit` 四个插件仍在 `apply` 期做同类快照，**热更新语义未覆盖它们**，需重启才生效。

## 设计细节

- 模块布局（`orrery-harness/delegate`）：`index.js` 是约 90 行的组合根，实际职责分住五个命名模块——`settings-overlay.js`（delegate 专属的设置覆盖层工厂：三层 append/去重与整链替换语义，刻意不套用 shared `overlayConfig` 的浅合并模型）、`target-resolver.js`（「item + 父路由 → persona/options/filter/label」唯一脊柱，provider 快照缓存闭包化）、`supervision-mount.js`（协调器工厂与六个效应器）、`supervision-tools.js`（`resume_agent`/`terminate_agent` 定义，object-rooted schema）、`audit-readers.js`（监督重建的三个冷读读取器）；派发走 `ctx.subagents.start`，一次调用携带 `agentOptions`（钉模型与推理档）、`persona`、`toolFilter`（只读白名单）、`maxDepth: 1`（禁止再委派——该拓扑契约全仓只剩一处）。
- spawn 道轴收编在 `spawn-adapter.js`：`spawnGuardedChild` 让「started ⇒ 已挂守卫」成为不变量，三条道（一次性/后台 job 包装/受监督）按 lane policy 参数化共享同一份请求装配与守卫核心；编排层（escalation 重派、两阶段/回滚/seal）留在 `tool.js`。
- 链解析规则：provider 已注册且（其 catalog 为空或包含该 model）即可解析；`reasoningEffort` 支持度经模型信息校验；适配器更新事件触发重解析。
- 精选 agent 与类别**共用同一条解析路径**：`resolveTargetRoute`（原 `resolveCategory`）对任何 `{ chain, gateModels, disabled }` 目标定义生效。agent 分支的基线注册表经 `overlay.agentsNow()` 取得（`CURATED_AGENTS` ∪ 行 config，再叠设置面的整链替换），与 `categoriesNow()` 同形；agent 整链不可解析时抛显式错误并点名 agent 与尝试过的档位，**不回退继承**。
- 兑现两处既有契约：`delegate(agent=…, model=…)` 的 `model` 覆盖生效为「否则会使用的那条路由」的 model id 覆盖（provider 取该路由的 provider；provider catalog 未列出不拒绝——DSH 契约里 catalog 是 advisory）；精选 agent 的 `reasoningEffort` 提示仅在所选路由确实声明该档位时应用，否则静默丢弃。
- 委托目标指引：delegate 插件注册 prompt section `orchestrator:delegate-targets`（order = doctrine + 10），文本是静态英文模板 + 变量 `{{orrery_delegate_targets}}`；provider 在**每次提示词装配**时读 `categoriesNow()`/`agentsNow()` 求值，故设置提交即改变清单。清单渲染是纯模块 `src/delegate/targets.js`（启用过滤、注册表顺序、空集合兜底）。
- 可见性三处收口：指引清单过滤 `disabled`；派发路径复用既有 unavailable 错误；`unknown_target` 的 available 名单只列启用目标。
- 后台道一律走 one-shot job（拉取语义），保证报告全文不自动入上下文。
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

## 测试

- 单元测试：`test/` 覆盖参数校验、链解析（含死链报错）、变体选择、ESCALATE 重派、批量默认值；五个布局模块各有直测套件——`settings-overlay.test.js`（三层 append/去重语义与平台注入）、`target-resolver.test.js`（解析脊柱与「每次解析恰好一次覆盖层」）、`supervision-tools.test.js`（schema 形状与 depth 门）、`supervision-mount.test.js`（notifyParent 策略与 feed 路由，真实短定时器）、`audit-readers.test.js`（临时目录 JSONL 夹具），spawn 道轴由 `spawn-adapter.test.js`（装配形状/两种拆除语义/调用次序/禁用边角）钉住；守卫采用「一个深核心 + 两个薄壳适配器」结构——`src/delegate/robash-guard-core.js` 收编全部跨壳共享策略（canonical 白名单 `DEFAULT_TABLES`、git 门控、`GIT_CONFIG_*` 拒绝、递归预算、重定向 sink 策略、`gateExecutable` 判定尾段、按壳键控的 `DANGEROUS_FLAGS` 与共享理由模板 `reasons`），`robash-guard.js`/`robash-guard-pwsh.js` 只保留壳词法（scanner/tokenizer/别名展开）并各导出同一签名 `check(command, lists)`；`test/robash-guard.test.js` 与 `test/robash-guard-pwsh.test.js` 的语料（放行/拒绝/注入绕过/自定义列表）作为行为冻结证据逐字存活；`test/robash-whitelist-parity.test.js` 缩为「`whitelist-defaults.json` ↔ `DEFAULT_TABLES`」单组比对 + 行内不得出现白名单键的既有不变式；`test/group-coordinator.test.js` 覆盖协调器全分支（组登记/禁插入/终态解析/催促/退避/耗尽/打断分类/resume/terminate/group-settled 信号渲染/失败批次释放组名/各投递失败降级）与挂载层（组派发、两阶段解析、回滚与组名复用、只读成员守卫、延迟 followup 投递）；**volatile 热更新**由 `test/delegate.test.js` 的四条 `hot reload:` 用例（提交后新委派的守卫行为与服务面立即改变、提交后新委派 fail-closed、提交不回溯收改已派发代理、dispose 退订）与两条挂载层用例（提交抵达**已建立**协调器、提交改变下一次受监督派发的只读面）覆盖；`test/group-coordinator.test.js` 另有 `setSupervision` 三条用例（收紧上限、重调退避而不动登记状态、忽略三个调参键之外的键）。
- 新增 `test/targets.test.js`：指引渲染（启用过滤 / 注册表顺序 / 空集合与全停用兜底 / 模板只引用已注册变量）；`target-resolver.test.js` 补 agent 链解析、`model` 覆盖、effort 支持度、报错 available 名单过滤；`settings-overlay.test.js` 补 `agentsNow()` 与 `disabledCategories` 合并；`settings.test.js` 补两个新键的解析与坏 JSON 报错。
- 集成测试：`delegate` 场景（父委派、子会话、结果回传）；`robash` 场景——只读子代理的受守卫 bash：放行命令执行、写命令拒绝、目标文件零损伤；`grouped` 场景——受监督分组端到端：批量派发、供应商错误成员退避续推恢复、成员正文经 DSH 内建结算通知（`subagent-settled` 源）送达父会话、一行 group-settled 信号到达、父 agent 观察到信号；`escalate` 场景（ESCALATE 重派与发现传递）；`background` 场景（后台委派：紧凑通知到达、报告全文不入父上下文、父 agent 观察到通知）；`terminate` 场景（运行中成员真打断（turn aborted）、组 settle 信号到达）；`rehydrate` 场景（两阶段重启：blocked 报告经内建结算通知送达、send_message 工具面契约、审计事实链含 resume 与 group-settled、重建后 resume_agent 复工、group-settled 信号重发）。
- `delegate` 场景断言父系统提示词含委托目标指引（含启用类别名与精选 agent 名）；新增停用场景：被停用类别既不在小节里，派发它又得到显式 disabled 错误且不出现于 available 名单。
