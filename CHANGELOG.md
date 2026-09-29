# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]
### Added
- **只读 bash 白名单三表设置页可编辑**：`robashAllow` / `robashGitAllow` / `robashDeny` 三个 volatile 设置键（JSON 字符串数组）接管守卫的命令白名单 / git 子命令白名单 / deny 列表，设置页提供结构化行编辑面板（`RobashListEditorField`，逐行增删改、保存程序化合成 JSON），不再手写 JSON。每个键独立解析：未设置 → 回退下层（行 config → 模块默认）；已设置（含空数组）→ 权威生效——**显式清空 = 全不放行（fail-closed 更严），绝不回退默认**；坏 JSON 设置服务激活即败。命名约定 `robash<Shell>*` 为后续 pwsh 白名单键预留扩展位。
- **`lsp_rename` 跨文件语义重命名**：第五个 LSP 语义工具（首个改写工具）——语言服务器算出 WorkspaceEdit，插件经 fs 版本护栏安全落盘：两阶段提交（先对全部目标文件预检——解析/stat/读取/行尾采样/合成新全文，任一失败零写入；再逐文件 `replaceIfVersion` 原子写回），写入中途 stale/沙箱拒绝即停且报告精确列出已写与未写文件；原行尾风格（LF/CRLF）写回保留（CRLF 不被静默 LF 化）；服务器未声明 `renameProvider` 或返回 `documentChanges` 显式拒绝且零写入；恒等编辑报空操作。结果逐文件渲染 unified diff 与汇总。refactor 技能与 README 文案同步转为正式表述。
- **只读守卫覆盖 pwsh（Windows 只读 shell 补全）**：守卫新增独立 PowerShell 解析路径——反引号转义先还原再查表（`` i`ex `` → `iex` → 拒绝）、反引号换行续行与孤立 CR 语句终止在解析前归一化、`&` 调用操作符剥除（动态 `& (...)` 直拒）、`$(...)`/`(...)` 递归校验、here-string 检测与插值扫描、内建只读别名表展开、大小写不敏感查表（deny 优先且同时命中别名展开前原始名）、写重定向集拒绝（`$null`/fd 复制放行）、`--%` 直拒；默认表为保守只读 cmdlet 子集 + 逃逸向量 deny（`iex`/`Invoke-Expression`/`Start-Process`/`Set-Content`/`Out-File` 等），git 子命令门控与 bash 侧共享且封堵 `-c alias.*`/`core.pager`/`pager.*` 与 `GIT_CONFIG_*` 环境偷渡。**裸脚本块/哈希表字面量（`{...}`/`@{...}`）一律拒绝**（PowerShell 会执行脚本块主体，表达式模式可执行形态无法枚举；惯用 FilterScript 由简化参数语法承接），赋值右值与表达式组的静态访问（`::`）与全形态方法调用直拒。`readOnlyTools` 按平台并入 shell（win32 → pwsh，其余 → bash）——此前 Windows 只读代理零 shell 能力（双失配）消除；只读代理 persona 提示按平台命名正确 shell。设置面兑现 T4 预留命名：新增 `robashPwshAllow` / `robashPwshDeny` 两键（与 bash 三表同缺席回退/在场权威语义，复用 `RobashListEditorField`）。**验收边界**：无 Windows 验证环境——解析正确性与绕过抵抗由单测语料（含三轮独立评审累积的 66 拒/29 放对抗矩阵回归钉死）与 mock wiring 保证，真实 pwsh 行为与桌面实机验收待用户在 Windows 执行。已知残留：git `-c` 的其它可执行配置键（`diff.external` 等）登记为后续加固项。
- **`hash_edit` 会话 diff 面板**：`hash_edit` 调用在会话中不再走通用输入/输出卡片——成功的编辑持久化结构化 diff 元数据（`meta.diffs`，与模型看到的 unified diff 来自同一趟比较），客户端 bundle 经 keyed slot `tool.call.toolview` 注册专属视图：折叠行显示目标路径（点击打开文件）与 +增/−删统计，展开为逐 hunk 着色的原生 diff 面板（复制/换行/折叠铬件，en/zh 本地化）；调用进行中显示从入参推导的计划编辑预览，失败显示 mismatch 报告，旧日志与畸形数据回退平铺展示。零新依赖。

### Changed
- **`hash_edit` 大段内容改由单个字符串承载**：每个编辑操作的内容字段从 `lines`（字符串数组）改为 `text`（单个字符串，行间为两字符转义 `\n`，空串 = `replace` 纯删除 / `append`、`prepend` 无操作）。动因：宿主适配器在流结束处逐个解析工具参数，任一非法 JSON 即作废整轮——对 105 份会话日志的实测扫描中该类事故 7 起、7/7 落在 `hash_edit`，坏点全部在 `lines` 数组的括号闭合边界（载荷 797–5393 字节的大段中文 append）；单字符串通道消除了「数组闭合 + 对象闭合」的结构混淆点。切分规则 `split('\n')` 至多丢弃一个尾部空元素、内部空行保留，与写盘 `join('\n')` 互逆。schema 恢复完整描述契约（`required: ['op','pos','text']`）；形状错误先于锚点校验拒绝并带「按正确形状重新调用」自纠措辞；工具描述新增 invalid-JSON 整轮警告与空串删除说明（974 字符，旧版 818，上限 120%）。**版本影响：breaking，pre-1.0 按 minor 打版。**

### Removed
- **`hash_edit` 的 `lines` 内容通道**（BREAKING）：字符串数组形态从 schema、运行时、测试与文档整体移除，仓库内不再保留任何 `lines` 示例（不给未来会话留模仿源）。经「无兼容包袱」评估后硬替换——Harness 迭代期无旧调用、无旧会话；偶发的旧形状模仿调用收到带自纠措辞的普通工具错误（JSON 合法、turn 不废、重试一次即过）。

### Fixed
- **LSP 服务器握手失败残留僵尸记录**：懒启动的 initialize 握手失败（如工作区 TypeScript 安装缺 tsserver）后，该 (工作区, 语言族) 键被能力缺失的死记录占住，后续调用持续失败直至会话重开。修复为握手失败即终止进程、丢弃记录、原样抛错——下次调用起全新服务器（实况发现，附变异验证回归测试）。
- **白名单列表编辑器空白/非法值死路**：`RobashListEditorField` 原先对空白或非法存储值拒绝打开编辑器（字段永久不可编辑——旧 profile 的设置行 config 先于新键存在时必现）。改为空白值（各层均未设置）不报错并以空列表打开；非法值显示报错态但仍以空列表打开，保存即覆盖——任何存储态都不会把字段卡死。
- **Windows 上 LSP 服务器不可用（解析与启动双断）**：插件在 Windows 下既解析不到语言服务器也启动不了。四处平台假设——① 绝对路径判定只认 `/`，`C:\...` 被当命令名交给服务解析器；② 扩展扫描目录只有 POSIX 布局，未含 npm 全局前缀 `%APPDATA%\npm`（`~/.npm-global` 的 shim 在根而非 `bin`）；③ 裸名不按 `PATHEXT` 探测扩展名；④ 子进程 PATH 用 `:` 拼接而被撕裂。另有两处启动级缺陷：CreateProcess 不执行批处理（Node 对 `.cmd` 直接 `EINVAL`，npm shim 内部又需 cmd 自身 PATH 才能找到 node），以及 NTFS 无执行位仍以 `X_OK` 作可执行判据。现按平台参数化解析（win32 目录/PATHEXT/分隔符），并以**不经 shell** 的启动形态交付：`.cmd` shim 被读入拆包为 `node <cli>`（因此含空格的路径与 cmd 元字符都不再危险），仅拆包失败时回退 `cmd.exe /d /c`；POSIX 行为不变。实机验收：跨三文件五处 rename 成功（`file:///d:/` URI 形态正确）、CRLF 字节级保留、`FS_STALE_VERSION` 中途截断精确报出已写/未写文件。
- **LSP 管理端点的两个定时器会拖住宿主进程**：`probeVersion` 在超时结算路径不释放定时器，留下已武装的 8 秒定时器；`runInstall` 的安装截止时间（默认 600 秒）未 `unref`——若安装 promise 无人等待（HTTP 处理已应答或调用方放弃），整个进程会被钉住至截止时间。两者现均在**所有**结算路径释放（`try/finally`——真正漏的是抛错路径：启动失败会从 race 中抛出，已武装的 8s 定时器让进程多活到它开火，实测 4ms 工作 / 8007ms 进程寿命 → 修后 7ms），截止时间另加 `unref()`。
## [0.3.0] - 2026-09-29

### Added

- **受监督小组的可见性与重启恢复**：新增 `supervised_status` 工具（仅主 agent 可用）——逐子代理展示 id/名称/组/状态（`running`/`blocked`/`completed`/`terminated`）/续推次数/报告摘要，逐组展示成员数与 sealed/settled，并对 DSH catalog 中未被协调器登记的 continuable 子代理做孤儿检测（与空注册表明确区分）。受监督状态机每次迁移写入**结构化审计事实**（`orrery/supervision/spawn|seal|settle|resume|terminate|group-settled` 落 `.orrery/audit.jsonl`）；宿主重启后首次访问协调器时**三层重建**——审计尾部回放（按父会话 id）+ DSH `subagentCatalog` 交叉核验 + `sessionQuery.readSession` 子会话日志终态重解析（孤儿提升为 `recovered` 合成组），重建结果携带 confidence（full/partial）：partial 时工具输出诚实降级诊断，catalog 存在 continuable 子代理时绝不宣称无受监督子代理；重建后已全员终态的组重发一次 group-settled 信号。集成测试新增两阶段重启模拟场景（跨进程 adopt 同一会话）。
- **hash_edit 一次性沙箱升权**：与 stock `write`/`edit` 同契约——沙箱后端在场时 schema 广告 `sandbox_permissions`（`workspace-write`/`danger-full-access`）与 `justification` 两个可选参数；参数配对校验先于任何文件操作，同模式重复免审批，严格更宽档经用户审批一次性生效（仅本次调用），拒绝/取消/无通道/无审批服务一律 fail-closed。沙箱拒绝改报共享 deny 标记（`[sandbox: file access denied under <mode> mode]`）+ 同轮升权提示，与 stock 工具同一套词汇；无沙箱后端的组合不暴露这两个参数（行为不变）。词汇与编排在 `src/hashline-edit/sandbox.js` 自实现（link bundle 红线禁静态 import `@deepseek-ai/*`，宿主包文本逐字锁定于单测），零新 npm 依赖。集成测试新增真实越界编辑断言（共享标记与提示逐字到达模型）。

### Changed

- **受监督组成员的工具面收窄**（BREAKING，仅受监督子代理）：受监督成员 spawn 时强制 deny `send_message`——子→父直发通道关闭，唯一上报通道为二元终态契约（`STATUS: completed/blocked`）；只读成员维持既有 allow 白名单，主 agent 自身的消息工具与 DSH 结算通知不受影响；非受监督委派行为不变。
- **监督通知改走内建结算通道**（BREAKING，主 agent 可见面）：退役 `<supervised_blocked>` 逐成员通知与合并组报告——每个成员的终态报告经 DSH 内建结算通知即时送达（正文含 `STATUS/REPORT` 全文）；组全员终态后送达恰好一条**一行 group-settled 信号**（组名与成员数，不含成员正文），投递**镜像 DSH 内建结算通道（`sendWaking`）语义**——信号严格排在组内最后一条成员结算通知之后（父会话日志观察全员终态通知为准，通知缺失时 1s 兜底）；父忙→`steer` 同轮紧随注入，父闲→`followup` 唤醒（失败记日志、有界重试、最终失败写审计）。原 outbox/busy 台账/turn-stopping 冲刷机制整体退役，与 todo-driver 的边界竞争消除。`supervised_status`、`resume_agent`、`terminate_agent` 语义不变。

### Fixed

- **hash_edit 在 desktop 实况全量写失败（S23 事故级）**：`ctx.fs.writeText` 未携带 per-call sandboxPolicy，沙箱回退到部署策略（工作区根 ≠ 会话工作区），工作区内任何写入一律 `file access denied under workspace-write mode`（会话切 danger-full-access 亦无效；/tmp 因无条件可写根不受影响）。修复为按会话现算策略并作第 5 参传入（与 stock `write`/`edit` 同契约）；集成测试装置镜像沙箱语义（部署回退根不含测试工作区、工作区移出 /tmp），无策略写入将被同款拒绝（回归已双向验证：预修复 37/38、修复后 38/38）。
- **受监督批量派发注册表污染**：批量任务逐项 spawn+登记，中途校验失败会留下 live 未 seal 的残留组并永久占名。修复为两阶段化（先全量解析、后 spawn）；失败批次回滚已 spawn 成员并释放组名（新增 `orrery/supervision/group-released` 审计事实；未 seal 且全员 terminated 的组名可复用）。
- **续推/重试投递拒绝未处理**：退避重试定时器的 `sendTo` 为 fire-and-forget，拒绝成为未处理 promise rejection。修复为逐条 catch——投递失败审计并降级为 blocked（附投递失败备注）；`resume_agent` 投递失败回退 blocked 并报错。
- **受监督只读成员缺 bash 守卫**：只读守卫只挂载于前台/后台 lane，受监督 lane 的只读成员无守卫。修复为经活跃 agent 句柄（`ctx.agents.get(childId)`，`startContinuable` 不返回 `localAgent`）挂载同款 fail-closed 守卫。
- **意图门把运行时注入消息误判为用户提示词**：`agent/pre-step` 只按 `role === 'user'` 取最新消息、未按 `source.kind` 过滤——DSH 内建监督结算通知（`source.kind: 'subagent-settled'`，正文含子代理完整报告）、意图门自身注入的通知（`orrery-intent-gate`）、todo/压缩续推注入（`orrery-todo-driver`/`orrery-context-guard`）均为 user 角色；其中碰巧含关键词（如报告里出现 "research"/"debugging"/"review-work"/"deep-work"）即触发虚假技能注入（实测：一次 group 测试中结算通知文本触发 research 单发与 deep-work+review+debug 同毫秒四连发；llm 模式下还额外浪费 sidecar 调用）。修复为仅分类 `source.kind === 'user'` 的真实用户提示词（DSH `MessageSourceMap` 契约：真实用户输入含 `user-rpc` 的 kind 恒为 `user`），注入消息一律跳过；新增 4 条回归测试（结算通知豁免/越过注入扫真实提示词/自身通知不重扫/无 source 消息豁免）。
- **todo-driver 同根源问题：注入消息被误判为用户输入**：续推驱动器 rearm 判定为"除自身注入外都算用户输入"（`sourceKind !== 'orrery-todo-driver'`），监督结算通知、意图门通知等运行时注入会虚假重新武装续推（被中断后的会话因一条结算通知又恢复自动续推）。修复为只认 `source.kind === 'user'` 的真实用户输入；新增 2 条回归测试（结算通知/其他插件注入均不 rearm）。

## [0.2.0] - 2026-09-28

### Changed

- **锚点编辑成为默认编辑方式**（行为级 BREAKING，仅 `orrery` 预设）：预设默认开启 `hideStockEdit`，会话中 stock `edit` 工具不再出现，`hash_edit` 为唯一编辑工具；配置 `hideStockEdit: false` 可回归共存模式。其他预设不受影响。
- **LSP 开关语义重构为能力总闸 + 会话面板开关**：设置 `lspEnabled` 由"新会话自动启用"改为能力主开关——关闭时 `lsp` 工具、`/lsp` 命令、面板开关全部不存在，任何通道都无法开启；开启后每个新会话默认关，由会话输入栏新增的 LSP 开关（或 `lsp` 工具）按会话启用/禁用。会话级状态经 `orreryLsp` 会话投影持久化（重启恢复后自动还原）；设置保存实时生效，无需重启。预设行误挂的 `hideStockEdit` 死配置同步归位。

### Added

- **LSP 服务管理面板与社区生态**：设置页 LSP 节新增"管理 LSP 服务"面板——展示全部语言服务器的安装状态与版本，缺失的服务器一键安装（先展示完整命令 → 确认 → 执行 → 输出与退出码回显）。内置注册表从 4 族扩到 **13 族**（typescript/python/go/rust + json/html/css/markdown/bash/dockerfile/yaml/lua/cpp），配方取自社区注册表（nvim-lspconfig / lsp-mode / Helix / vscode-langservers-extracted，纯数据引入、零运行时依赖），安装走各语言包管理器（npm/pipx/go/rustup/brew/apt）。宿主经 `/api/orrery-lsp/status|install` 端点（`ctx.connection.fetch` 注册，认证由 connection 服务供给）支撑面板；面板支持**添加/删除自定义语言服务器**（`lspServers` 设置，可视化表单、程序化合成 JSON，随设置实时生效）。可执行解析加入**扩展目录回退**（GUI 进程 PATH 仅含系统目录，nvm/Homebrew/cargo/go 的 bin 需扫描常见安装目录；status 上报 `installerAvailable`，安装器缺失时面板禁用执行并提示）。LSP 调参（idle/请求超时/诊断等待）进入设置面板并实时生效。VS Code 语言扩展本身不可复用（VS Code API 插件），其捆绑服务器二进制探测列为后续项。

### Fixed

- **LSP 版本探测误报**：`vscode-*` 提取服务器不支持 `--version`（无连接即抛错），探测把堆栈路径当版本展示；现按族配置探测参数（该四族跳过探测）+ 版本行过滤器（拒绝路径/堆栈/无数字行），gopls 改用 `version` 子命令。实机：markdown 版本显示恢复为"已安装"（无乱码），bash 5.8.1 / clangd 17.0.0 正常。
- **LSP 安装器 "not found on PATH" 与安装权限（实况事故，两连）**：desktop GUI 进程经 LaunchServices 启动，PATH 仅为系统四目录，用户 shell 里可用的 npm（nvm/Homebrew）在宿主内解析失败；修复解析后又暴露子进程环境问题——npm 是 `#!/usr/bin/env node` 脚本，scrubbed 子环境 PATH 仍是最小集（`env: node: No such file or directory`，退出码 127），且解析命中的 `/usr/local` npm 全局前缀 root 属主（EACCES，退出码 243）。统一修复：① 可执行解析加扩展目录回退（nvm 目录优先，避开 root 属主前缀）；② 所有 LSP 子进程 spawn 注入扩展 PATH；③ npm 安装钉住用户可写前缀 `~/.npm-global`（已在扫描目录内）。实机验证：真实安装 bash-language-server 成功（exit 0、22s），随后状态读取即报 installed + 版本 5.8.1。
- **预设内锚点编辑缺席（变更 C 实况事故）**：`hideStockEdit` 的挂载期 `tools.restrict` 在真实预设组合中失败——preset standing scope 上 restrict 只能遮蔽继承层工具，而 stock `edit` 来自同一预设内 dsh-tool-fs 的 own scope 注册（"known global tools: (none)"）。统一为逐 agent 限制（`agent/created` 时按 agent 视角检查存在性再 restrict）：agent scope 下 stock `edit` 恒为继承、可遮蔽、目录真隐藏；行为契约不变。
- **会话日志冷读崩溃（事故级）**：orrery 的自定义审计事件（`orrery/intent-hit` 等 5 类）此前直接写入会话日志；本运行时的持久化在冷读（重启恢复 / 子代理 cold-resume）时拒绝解释含未知且未标 ignorable 事件类型的日志，而 `session.append` 无 ignorable 通道——任何写入过这些事件的会话冷读即崩。审计通道整体迁移为冷读安全双写：cordis 运行时事件（`ctx.emit`）+ 磁盘 JSONL 审计文件（`<会话cwd>/.orrery/audit.jsonl`），事件负载形状不变。

### Added

- **只读研究代理的受守卫 bash**：精选只读代理（`explore`/`librarian`/`oracle`）与 `readOnly` 类别新增 bash 能力，由逐命令校验的只读白名单守卫看管——白名单内只读命令（含 git 只读子命令门控）放行；写命令、解释器、嵌套 shell、写重定向、无法证明只读的命令一律 fail-closed 拒绝（v1 不含 `pwsh`）。白名单经 `readOnlyBash.{enabled, allow, gitAllow, deny}` 配置化，可在线迭代；`enabled: false` 时工具面回落到 v0.1.0。
- **六项新内置技能**：`git-master`（git 全流程）、`refactor`（重构分解向导）、`programming`（Python/Rust/TS/Go 严格现代实践，含分语言参考树）、`remove-ai-slops`（回归保护下清除 AI 代码异味）、`work-with-pr`（worktree 中的 PR 全生命周期，gh 缺失可降级）、`remove-deadcode`（安全验证的死代码清理）。自带技能目录扩为 10 项；技能结构（frontmatter/英文正文）由单测机器强制。
- **意图门语义分类器**：`classifier: 'regex' | 'llm' | 'jev'` 三模式可选（默认 `'regex'`，行为不变零成本）。`'llm'` 模式在正则未命中时经 sidecar 调用做语义分类（缓存 + 超时 + fail-open 回落纯正则结果）；`'jev'` 模式为实验功能、默认关闭，经 Jev 决策模型分类。分类决策全量审计（`orrery/intent-classify` 事件，含回落原因）。
- **LSP 语义工具（默认关、随时开）**：自研零依赖最小 LSP 客户端（JSON-RPC over stdio），四个只读语义工具 `lsp_diagnostics` / `lsp_definition` / `lsp_references` / `lsp_symbols`；`lsp` 工具或设置页随时 per-session 开关（默认关）；语言服务器按 (cwd, 语言族) 懒启动、空闲自停、二进制缺失给安装指引；注册表覆盖 typescript/python/go/rust 且可配置扩展。`rename` 列后续项。
- **Orrery 一站式设置面板**：Settings 应用新增 Orrery 专属设置页（schema 自动生成），覆盖意图分类器档位、9 类别模型链、续推/退避上限、上下文压力阈值、锚点编辑开关、只读 bash 总开关；设置经 profile 层 `orrerySettings` 服务按"模块默认 ← 行 config ← 设置值"分层生效，作用于之后创建的会话。schema 依赖以 vendored 形式内置（`src/vendor/`，不新增 npm 依赖）。
- **受监督分组委派**：`delegate` 新增 `group` 参数——同一次调用的全部任务构成一个组（组不支持插入）；成员以 continuable 子代理运行并遵循二元终态契约（只可报 completed / blocked）；正常结束缺终态报告自动催促续推、供应商错误按退避策略续推（30s 翻倍至 5min、上限 5 次）；blocked 报告即时送达；组全员终态后合并为一条组报告送达。新增 `resume_agent`（注入续推上下文恢复 blocked 子代理）与 `terminate_agent`（运行中真打断 / 非运行中仅簿记）两个主 Agent 裁决工具；blocked 疏通后方向大变时支持"终止 + 新派"重置流程。多 Agent 协作全部自研，不依赖官方 Agent Team 插件。

## [0.1.0] - 2026-09-27

首个发布版本。以 DSH bundle `orrery-harness` 交付，声明 agent 预设 `orrery`（GUI 显示名 "Orrery"）。

### Added

- **预设打包**：`orrery` 预设入驻预设选择器，与标准预设完全隔离；bundle 经 link 安装、改动禁用/启用即可重应用；自带技能目录经 `customSkillDirs` 挂载。
- **Orchestrator 总指挥**：主 agent 以 Orchestrator 身份工作，系统提示词内置协作纪律（委派拓扑决策、默认可并行、等待纪律、证据绑定验收、子任务提示词契约、拉取式后台纪律）。
- **意图门**：用户提示词命中可配置意图关键词时自动注入对应工作模式指令；`think` 意图提升当次请求的推理档位；意图表支持在线编辑，每次命中留有可审计事件。
- **分类委派**：`delegate` 工具把任务路由给专长子代理——任务类别绑定模型链与专属提示词（链内逐档解析、死链显式报错）；内置只读研究代理 `explore`/`librarian`/`oracle`；支持批量（≤16）与后台执行；`deep` 类别结果可按 `ESCALATE: deep-plus` 契约自动升级一层。
- **todo 空转续推**：任务清单未完成时自动续推；用户打断即停（直到下一条用户消息）；供应商错误按退避策略延迟重试（默认上限 5 次）；连续续推上限 8 次；`stop_continuation` 工具供模型声明真实阻塞。
- **拉取式后台通知**：后台任务结算仅投递紧凑通知（不含报告全文），完整输出用 `job_output` 拉取；唤醒风暴防护（连续唤醒上限 8）。
- **上下文压力守卫**：实时计算上下文压力；越过软阈值（0.72）提示模型择时调用 `compact_context` 压缩；越过硬阈值（0.88）在回合边界强制压缩；压缩完成自动续推任务。
- **锚点编辑**：`read` 结果每行携带 `N#XX|` 锚点；`hash_edit` 工具逐锚校验、任一锚点失效则整体拒绝（零写入），支持 replace/append/prepend 多操作并返回 unified diff；可与 stock `edit` 共存或配置隐藏。
- **内置技能**：`deep-work`、`research`、`review-work`、`debugging`（英文正文，意图命中自动指向）。
- **集成测试装置**：`orrery-test-harness`（开发专用）——真实 headless runtime + 脚本化 mock LLM，17 项端到端检查覆盖意图门/委派/锚点编辑/上下文压缩。

<!-- 本地私有仓库，无远端；链接定义在引入远端后补充。 -->
