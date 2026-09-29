# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-09-30
### Added
- **只读 bash 白名单三表设置页可编辑**：`robashAllow` / `robashGitAllow` / `robashDeny` 三个 volatile 设置键（JSON 字符串数组）接管守卫的命令白名单 / git 子命令白名单 / deny 列表，设置页提供结构化行编辑面板（`RobashListEditorField`，逐行增删改、保存程序化合成 JSON），不再手写 JSON。每个键独立解析：未设置 → 回退下层（行 config → 模块默认）；已设置（含空数组）→ 权威生效——**显式清空 = 全不放行（fail-closed 更严），绝不回退默认**；坏 JSON 设置服务激活即败。命名约定 `robash<Shell>*` 为后续 pwsh 白名单键预留扩展位。
- **`lsp_rename` 跨文件语义重命名**：第五个 LSP 语义工具（首个改写工具）——语言服务器算出 WorkspaceEdit，插件经 fs 版本护栏安全落盘：两阶段提交（先对全部目标文件预检——解析/stat/读取/行尾采样/合成新全文，任一失败零写入；再逐文件 `replaceIfVersion` 原子写回），写入中途 stale/沙箱拒绝即停且报告精确列出已写与未写文件；原行尾风格（LF/CRLF）写回保留（CRLF 不被静默 LF 化）；服务器未声明 `renameProvider` 或返回 `documentChanges` 显式拒绝且零写入；恒等编辑报空操作。结果逐文件渲染 unified diff 与汇总。refactor 技能与 README 文案同步转为正式表述。
- **只读守卫覆盖 pwsh（Windows 只读 shell 补全）**：守卫新增独立 PowerShell 解析路径——反引号转义先还原再查表（`` i`ex `` → `iex` → 拒绝）、反引号换行续行与孤立 CR 语句终止在解析前归一化、`&` 调用操作符剥除（动态 `& (...)` 直拒）、`$(...)`/`(...)` 递归校验、here-string 检测与插值扫描、内建只读别名表展开、大小写不敏感查表（deny 优先且同时命中别名展开前原始名）、写重定向集拒绝（`$null`/fd 复制放行）、`--%` 直拒；默认表为保守只读 cmdlet 子集 + 逃逸向量 deny（`iex`/`Invoke-Expression`/`Start-Process`/`Set-Content`/`Out-File` 等），git 子命令门控与 bash 侧共享且封堵 `-c alias.*`/`core.pager`/`pager.*` 与 `GIT_CONFIG_*` 环境偷渡。**裸脚本块/哈希表字面量（`{...}`/`@{...}`）一律拒绝**（PowerShell 会执行脚本块主体，表达式模式可执行形态无法枚举；惯用 FilterScript 由简化参数语法承接），赋值右值与表达式组的静态访问（`::`）与全形态方法调用直拒。`readOnlyTools` 按平台并入 shell（win32 → pwsh，其余 → bash）——此前 Windows 只读代理零 shell 能力（双失配）消除；只读代理 persona 提示按平台命名正确 shell。设置面兑现 T4 预留命名：新增 `robashPwshAllow` / `robashPwshDeny` 两键（与 bash 三表同缺席回退/在场权威语义，复用 `RobashListEditorField`）。**验收边界**：无 Windows 验证环境——解析正确性与绕过抵抗由单测语料（含三轮独立评审累积的 66 拒/29 放对抗矩阵回归钉死）与 mock wiring 保证，真实 pwsh 行为与桌面实机验收待用户在 Windows 执行。已知残留：git `-c` 的其它可执行配置键（`diff.external` 等）登记为后续加固项。
- **启动时报告只读白名单漂移**：预设的白名单基线在**运行期不可见**——DSH 组合 patch 层用**整体替换**而非深合并（`applyEntryPatches` 执行 `target[key] = value`，host README 原话 “does not deep-merge”），所以 profile 一旦声明自己的 `orrery-settings` 行，bundle 的 `config` 就被整个丢弃。后果是一份停在旧版本的 profile 行会**静默压过后续所有基线加固**：仓库基线给 pwsh 白名单补了 `Start-Sleep`，而 Windows 上的只读代理依旧不能等待，只有一条看起来像“这东西本来就不被允许”的拒绝文案。现新增 `src/shared/whitelist-drift.js`，在 `settings` 的 `compute()` 里**每进程一次**从 bundle 自己的 `cordis.patch.yml` 重读基线并逐表比对，有缺项则经 `ctx.logger.warn` 报一行英文警告（点名缺哪些项、为何失效、两个补救动作）。**只报告不修改**：绝不重写 profile、绝不放宽守卫、绝不阻断激活；patch 文件不可读即静默降级。判定刻意保守：只算**缺失**（用户**增加**项是放宽自己的守卫，不算漂移）、组合**没有**声明白名单时静默（分层回退的正常形态，也是 headless 集成 profile 的形态）、某表被声明为**空数组**时静默（文档化的“在场即权威、fail-closed 更严”刻意清空）、pwsh 两表大小写不敏感比对。新增 16 条单测（含静默条件与降级路径）；产品单测 704 条 / 703 通过 / 1 跳过；集成测试 73/73 且**无新增输出**（证实不漂移的组合不受影响）。
- **集成测试装置跨平台可移植（Windows 可跑）**：`orrery-test-harness` 此前按 macOS 开发机写死，Windows 上 `test:integration` **51/73 通过、22 条失败**（失败全在装置自身：`robash` 2 / `grouped` 5 / `terminate` 3 / `rehydrate` 6 / `lsp` 5）。四处平台假设逐项消除：① 驱动 `run.mjs` 的 node/pnpm/dsh CLI/测试根四路径改为「环境变量覆盖 → 平台默认」（POSIX 默认值逐字保留，macOS 开发机行为不变；Windows 默认指向捆绑运行时、npm 全局 `dsh 0.1.7-rc.2`、盘符绝对路径）；② mock LLM 此前硬发 `bash` 工具调用与 `echo`/`sleep`/`rm -rf` 语料（共 11 处），而 Windows 只读 Agent 拿到的是 `pwsh`，子成员第一步就调不存在的工具、永不结算——新增 `src/shell.js` 抽象（`shellToolName` + `shellCommand` + `SHELL_OPERATIONS`，**刻意不是通用 shell 翻译器**：只覆盖场景真正用到的五个动词，且动词与校验器分居 `POSIX_BUILDERS` / `WIN32_BUILDERS` / `ARG_VALIDATORS` 三张同名表、由契约测试钉死三表键集一致，因此「新增动词却忘了写校验」在结构上不可能；每个参数过严格语法校验，场景字符串无法夹带 shell 语法），mock 改发具名操作；③ `rehydrate` 断言的工具名按平台取（该断言因此反而更强：现在对得上产品真实输出）；④ profile patch 层的 LSP mock 服务器命令由 macOS node 绝对路径改为 `!!js process.execPath`（不再需要任何解释器绝对路径），该文件因此不含任何平台默认值。另有 mock 内 4 处 + event-tap 内 1 处（共 5 处）POSIX 默认路径统一由 `IT_ROOT` 推导，消除跨文件口径分歧。**测试**：新增 `test/shell.test.js` 契约语料 20 条（期望值为独立字面量，能与实现真正分歧；含未知操作/未知平台/非法秒数/可夹带语法的标记与路径四类拒绝，加两条三表键集一致性断言）；集成测试 **73/73 全绿**（退出码 0），且跨平台移植**未放宽任何断言**——12 个场景移植前后均为 73 条检查，diff 只动了一条断言（把 macOS 专属字面量 `'bash'` 换成平台取值）。**产品代码零改动**：`orrery-harness` 静态检查零错误、单元测试 655 条 / 654 通过 / 1 跳过（POSIX-only，Windows 预期跳过）。新增 `docs/features/integration-test-harness.md`（含两条已登记覆盖边界）。

### Changed
- **`hash_edit` 大段内容改由单个字符串承载**：每个编辑操作的内容字段从 `lines`（字符串数组）改为 `text`（单个字符串，行间为两字符转义 `\n`，空串 = `replace` 纯删除 / `append`、`prepend` 无操作）。动因：宿主适配器在流结束处逐个解析工具参数，任一非法 JSON 即作废整轮——对 105 份会话日志的实测扫描中该类事故 7 起、7/7 落在 `hash_edit`，坏点全部在 `lines` 数组的括号闭合边界（载荷 797–5393 字节的大段中文 append）；单字符串通道消除了「数组闭合 + 对象闭合」的结构混淆点。切分规则 `split('\n')` 至多丢弃一个尾部空元素、内部空行保留，与写盘 `join('\n')` 互逆。schema 恢复完整描述契约（`required: ['op','pos','text']`）；形状错误先于锚点校验拒绝并带「按正确形状重新调用」自纠措辞；工具描述新增 invalid-JSON 整轮警告与空串删除说明（974 字符，旧版 818，上限 120%）。**版本影响：breaking，pre-1.0 按 minor 打版。**

### Removed
- **`hash_edit` 的 `lines` 内容通道**（BREAKING）：字符串数组形态从 schema、运行时、测试与文档整体移除，仓库内不再保留任何 `lines` 示例（不给未来会话留模仿源）。经「无兼容包袱」评估后硬替换——Harness 迭代期无旧调用、无旧会话；偶发的旧形状模仿调用收到带自纠措辞的普通工具错误（JSON 合法、turn 不废、重试一次即过）。

### Fixed
- **LSP 服务器握手失败残留僵尸记录**：懒启动的 initialize 握手失败（如工作区 TypeScript 安装缺 tsserver）后，该 (工作区, 语言族) 键被能力缺失的死记录占住，后续调用持续失败直至会话重开。修复为握手失败即终止进程、丢弃记录、原样抛错——下次调用起全新服务器（实况发现，附变异验证回归测试）。
- **Windows 只读代理无法执行等待（平台能力不对称）**：同一个“等待”操作在 macOS 上放行、Windows 上被拒——POSIX 侧 `sleep` 在 bash 白名单里，而 win32 侧 `Start-Sleep` **两张表都没有**（当时 allow 与 deny 两张表逐项核实均无此名），并且 `sleep`（pwsh 内建 ReadOnly 别名 → `Start-Sleep`，已对真实 pwsh 7.6 实测核实）未被别名表登记，于是以原名撞 allow 表被拒（`'sleep' is not on the read-only allow list`）。修复为双管齐下：`Start-Sleep` 入 pwsh allow 表，`sleep` 登记入别名表（与 bash 侧的 `sleep` 对齐）；**两处必须同时在场**——预设 `cordis.patch.yml` 的 `robashPwshAllow` 是组合基线、且设置层最后合并在场即权威，所以只改模块默认值在预设里是**空操作**。由此新增一份**名单镜像不变式测试**（`test/robash-whitelist-parity.test.js` 直接读 patch 文件校验五张白名单逐项同序一致；已用**变异验证**确认：把 patch 行改回去，恰好该断言失败、退出码 1）——该不变式此前仅靠注释维护、已真实漂移过一次。装置侧把 `robash` 子成员的命令体改为一发 `echo-and-wait`，使其成为该修复的端到端钉；**覆盖边界要说准**：该装置不加载产品 bundle 与预设 patch（走模块默认值），因此这一钉只覆盖“模块默认 allow 项”，**预设 patch 行与别名行的缺失它看不见**，那两层分别由镜像不变式测试与别名语料守护。产品单测 671 条 / 670 通过 / 1 跳过，集成测试 73/73。
- **白名单列表编辑器空白/非法值死路**：`RobashListEditorField` 原先对空白或非法存储值拒绝打开编辑器（字段永久不可编辑——旧 profile 的设置行 config 先于新键存在时必现）。改为空白值（各层均未设置）不报错并以空列表打开；非法值显示报错态但仍以空列表打开，保存即覆盖——任何存储态都不会把字段卡死。
- **Windows 上 LSP 服务器不可用（解析与启动双断）**：插件在 Windows 下既解析不到语言服务器也启动不了。四处平台假设——① 绝对路径判定只认 `/`，`C:\...` 被当命令名交给服务解析器；② 扩展扫描目录只有 POSIX 布局，未含 npm 全局前缀 `%APPDATA%\npm`（`~/.npm-global` 的 shim 在根而非 `bin`）；③ 裸名不按 `PATHEXT` 探测扩展名；④ 子进程 PATH 用 `:` 拼接而被撕裂。另有两处启动级缺陷：CreateProcess 不执行批处理（Node 对 `.cmd` 直接 `EINVAL`），以及 NTFS 无执行位仍以 `X_OK` 作可执行判据。现按平台参数化解析（win32 目录/PATHEXT/分隔符），并以**不经 shell** 的启动形态交付：三类真实 `.cmd` shim（npm 自带的 `%NODE_EXE%`/`%NPM_CLI_JS%` 链、corepack/pnpm 的 `%~dp0` 形态、`%_prog%` 模板）都被读入拆包为 `node <cli>`，因此含空格的路径与 cmd 元字符都不再危险；仅当路径与参数可证明 cmd 安全时才回退 `cmd.exe /d /c`，否则明确拒绝；POSIX 行为不变。实机验收：本机四个真实 shim（npm 11.17.0 / pnpm 11.7.0 / ts-ls 6.0.1 / dsh 0.1.7-rc.2）均无 shell 启动成功；跨三文件五处 rename 成功（`file:///d:/` URI 形态正确）、CRLF 字节级保留、`FS_STALE_VERSION` 中途截断精确报出已写/未写文件。
- **LSP 管理端点的两个定时器会拖住宿主进程**：`probeVersion` 在超时结算路径不释放定时器，留下已武装的 8 秒定时器；`runInstall` 的安装截止时间（默认 600 秒）未 `unref`——若安装 promise 无人等待（HTTP 处理已应答或调用方放弃），整个进程会被钉住至截止时间。两者现均在**所有**结算路径释放（`try/finally`——真正漏的是抛错路径：启动失败会从 race 中抛出，已武装的 8s 定时器让进程多活到它开火，实测 4ms 工作 / 8007ms 进程寿命 → 修后 7ms），截止时间另加 `unref()`。
- **委派设置在同一进程内不生效（与文档承诺相矛盾）**：`docs/features/category-delegation.md` 与 README 均承诺 settings 页的 volatile 改动「在线编辑即刻生效」，但 `delegate` 插件在 `apply` 期只读一次 `robash` / `delegate` 两个 section，此后把结果冻结进只读工具面与监督参数；设置服务确实广播变更（`loader/volatile-update`），但全插件只有 LSP 订阅了——**广播有、没人听**。后果是用户在设置页改 `robashEnabled`、五张白名单任意一张、或三个 `supervision*` 值，在本进程内（含此后新建的会话）**全部无效**，必须重启应用；失败是静默的（设置页显示新值、行为不变）。修复为两条路径同时到位：①**读取时解析**——两个 section 改为在每次消费点重新解析（派发时解析只读工具面与守卫列表，建协调器时解析监督参数），不再在 `apply` 期快照；②**提交时推送**——`apply` 订阅 `orrerySettings.onChange` 并把新监督参数推入**已建立**的协调器（协调器按父会话缓存、不随新委派重建），`apply` 返回清理函数退订，与 `src/lsp/index.js` 同一范式。一次性委派内的工具面与守卫列表取同一份快照，不会出现「已授予 shell 但守卫已关」。既有分层语义逐字保留（缺席回退行 config → 模块默认；在场权威，含空数组 = 显式清空 fail-closed）。新增 9 条回归测试（4 条 `hot reload:` 插件级 + 2 条挂载层 + 3 条 `setSupervision` 协调器级），其中「提交抵达已建立协调器」与「提交前旧行为必败」两向均验证。**未覆盖**：`intentGate`/`todoDriver`/`contextGuard`/`hashlineEdit` 四个插件仍有同类启动期快照，本次未改，已在特性文档登记。
- **只读守卫的「参数」维度缺失：`rg --pre` 等可绕过白名单执行任意命令**：守卫对**命令名**用白名单判定，但对**参数**只做逐命令特判（`find` 有 `FIND_DENY_FLAGS`，`sort` 有 `-o` 特判），其余一律放行。后果是几个**已在白名单里**的只读命令各自带一个能改行为、写文件或执行任意命令的参数，形成逃逸面：`rg --pre "cmd"` / `rg --pre=cmd` / `rg --pre-glob` 会在每个文件上运行**任意命令**（`--hostname-bin`、`--sort`/`--sort-files` 同类）；`uniq in.txt out.txt` 的第二个位置参数就是输出文件（stdin 在守卫场景不可用，故两个文件参数必然意味着写出）；`date -s` / `--set` 改系统时钟，`-f` / `--file` 从文件读时间戳。修复为把逐命令特判升级为**声明式危险参数表**（`DANGEROUS_FLAGS`，每行：精确 flag / 前缀 flag / 粘连短选项 / `positionalWrite`），新增二进制只需加一行而不是再写一个 `if`；`find`/`sort` 的既有特判并入该表，语义逐字保留。规避误伤：`rg -o` 是 `--only-matching`（读）故只对 `sort` 用 `-o` 粘连规则；`--pre` 按整 flag 匹配，`rg --replace` / `rg --pre-glob` 分别正确放行/拒绝；`--` 后若作为纯位置参数则不会误报（残留边界：`--pre` 的值形式未被识别，fail-open）。新增 35 条语料（20 拒 / 15 放），现有语料零改动。
- **两条单测断言把宿主平台写死，macOS 上必败**：`windows` 分支的 LSP 语料只在 Windows 上跑过，POSIX 侧从未执行，暴露出两处硬编码。① `test/lsp-spawn-argv.test.js` 的 9 条 win32 shim 用例把 `C:\...` 形态的 shim 路径交给 `spawnArgv`，而实现用宿主 `node:path.dirname` 取 shim 目录——在 POSIX 上 `dirname('C:\a\b.cmd')` 返回 `.`，于是 shim **从未被拆包**、全部落到 `cmd.exe` 回退，与期望 `[node, script, …]` 全面不符（该文件自引入起（`9fe876b`）在 POSIX 上就从未绿过，只是没有任何 POSIX 主机跑过它）。修复为把 `dirname` 补成与既有 `join` 并列的接缝（`options.dirname`，默认仍是 `node:path.dirname`），语料同时驱动两者为 win32 路径算术，真机断言因此在两个平台上逐字相同；唯一需要真实文件系统的用例改为用宿主分隔符拼目标路径（`%~dp0` 本就展开为目录加其后分隔符，与真实生成器同形），从而保留「目录不算目标、真文件才算」这条谓词断言不变。② `test/lsp-client.test.js` 的装机提示断言调用 `displayInstallCommand(lua)` 而不传平台，而该参数默认取**宿主**平台：lua 只有 darwin 规格，于是 Windows 上落到多平台兜底提示（断言过）、macOS 上返回 brew 命令（断言败）——按评审原意即“该平台无规格时回落到兜底提示”改传显式平台。**测试**：产品单测在 macOS 上 706 条 / **706 通过 / 0 失败 / 0 跳过**（修复前同一提交为 697 通过 / 9 失败，且被顺手修正的第三条断言失败早已被测试计数掩盖）；POSIX 专属的 root 执行位用例在 macOS 上真实执行而非跳过。

### Security
- **pwsh 守卫可被单独 `&` 完整绕过（只读白名单形同虚设）**：PowerShell 7 中单独 `&` 与 `&&` 同为**管道链操作符**（已对真实 pwsh 7.6 实测：`ParseInput('Get-Date & Remove-Item x')` 零解析错误、token 流含独立 `Ampersand` token、且尾部语句**真的执行**——探针里目标文件确实被删除）。而守卫扫描器只按 `&&` 切分语句，于是裸 `&` 之后的一切被吸进前一段、**从未送查白名单**，由前导的放行命令决定了裁决结果。后果是任何白名单内命令都能洗白任意尾部：`Get-Date & Remove-Item x`、`Get-Date & Start-Process calc`、`Get-Date & iex "rm x"`、`Get-Location & git push` 全部放行（bash 侧同类输入一直正确拒绝，受影响面仅 pwsh 侧）。修复为按位置区分 `&` 的三种角色：`>&` 是 fd 复制重定向（`2>&1`）透传、交由段内 tokenizer 校验；`&&` 无论在何处都是分隔符；**段首**的单独 `&` 才是 `& <word>` 调用操作符（留在原位由段检查器剥除，动态调用 `& $(Get-Date)` 仍拒）；**其余位置的单独 `&` 按后台操作符 fail-closed 拒绝**——包括尾部命令也在白名单里的情形（`Get-Date & Get-Location` 亦拒），因为不可证明的是该结构本身而非尾部命令。新增 11 条对抗语料（10 条洗白尾部 + 1 条“放行尾部也拒”）与 6 条回归语料（`&&`/`||`/`;`/管道/`& git status`/`& "git" …` 行为逐字不变），并修正 `docs/features/category-delegation.md` 中“`&` 调用操作符剥除”这句会令人误以为 `&` 已被完整建模的表述。**验证**：先红（11 条全败）后绿（守卫语料 154/154），产品单测 688 条 / 687 通过 / 1 跳过，集成测试 73/73。**发现路径**：本缺陷由上一项变更（Windows 等待原语）的独立门审报出为“范围外旁注”，经主 agent 在真实 pwsh 上独立复现确证后另立本案修复——门审的价值在此直接体现。
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
