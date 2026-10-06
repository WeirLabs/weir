# 集成测试装置（orrery-test-harness）

> 开发专用的进程外验收装置：用脚本化 mock LLM 启动一个真实的 headless DSH profile，把 Orrery 的模块挂在宿主层跑通，并断言行为。

## 概述

`plugins/orrery-test-harness/`（包名 `orrery-test-harness`）是 Orrery 唯一的集成测试层。它与单测的分工是：单测在进程内直接调用模块、用假 ctx 断言纯逻辑；集成装置**真的启动一个 DSH profile**，让预设组合、工具表面、续推/压缩/委派/编辑在真实运行时里跑一遍，然后按 trace、耐久会话日志与磁盘夹具断言结果。

它由以下部分组成：

- `run.mjs`：驱动。生成 profile（link 安装两个插件）、**按 scenario registry 通用循环**跑每个场景（自身零 per-scenario 分支）、经 `makeRunView` 预解析 trace 供断言回放，最后汇总 `N/M integration checks passed`。
- `src/scenarios/`：**scenario registry**——每场景一个模块，导出 `{ id, prompt, decide, observe?, assert, run?, env? }`；`index.js` 导出有序 `SCENARIOS` 与 `byId` 查找。场景模块只允许 import node 内建模块与包内相对模块（mock 插件进程与驱动共用同一份 registry）。
- `src/mock-llm.js`：脚本化 mock LLM 适配器（provider `mock`）。严格供应商 schema 闸门最先执行（逐字保留），每次请求只做**一次** `extract(options)` 观察提取（取代迁移前每请求约 39 次 transcript 重算），经 `byId` 查场景后产出 chunks；未知场景 id 在插件加载时**抛错**。
- `src/event-tap.js`：事件探针。把 `compaction/*`、`todo/write`、`turn/end`、`user/message` 与 cordis 的 `orrery/*` 审计频道写进同一条 trace；审计类型词汇经**相对跨包 import** 自产品侧 `shared/audit.js` 单源消费（手抄清单已删除）。
- `src/mock-lsp-server.js`：脚本化 LSP 服务器，给 `lsp` 场景提供协议夹具，不依赖任何外部安装。
- 共享 helper：`src/mock-kit.js`（chunks/transcript/shellCall 等纯函数）、`src/message-text.js`（统一 `textOf`）、`src/jsonl.js`（逐行容错 JSONL 解析）、`src/run-view.js`（trace 预解析视图）。

**它必须留在开发机**：AGENTS.md §3.9 明令不得安装进任何正式 profile（`run.mjs` 生成的 profile 名为 `orrery-it`，只存在于测试根目录下）。

## 用户可见行为

对贡献者（非终端用户）可见的行为：

- `pnpm --filter orrery-test-harness run test:integration` 跑全部 12 个场景，逐条打印 `PASS`/`FAIL`，末尾给出通过计数；有失败则退出码非 0。
- 也可以只跑指定场景：`node run.mjs lsp robash`。
- 场景清单的权威来源是 `src/scenarios/index.js` 的有序 `SCENARIOS`：`deepwork`、`delegate`、`hashline`、`pressure`、`robash`、`semantic`、`grouped`、`escalate`、`background`、`terminate`、`rehydrate`、`lsp`。新增场景 = 新增一个场景模块并在索引登记一处（registry conformance 测试钉住齐备性）；**未知场景 id 是响亮失败**：`node run.mjs no-such-scenario` 在 setup 前退出码 1 并点名该 id。
- `pnpm --filter orrery-test-harness test` 跑装置自身的单元测试（shell 契约 / registry / brains / replay / audit-types / trace-extract / jsonl / message-text 各套件）。
- `pnpm --filter orrery-test-harness run record` 重录断言回放夹具（一次绿跑后把 `trace-<scenario>.jsonl` 拷入 `test/fixtures/traces/`，入库）。
- 每次运行会把测试根目录整体删除重建（持有咨询锁时锁文件本身除外，见「并发运行隔离」）；默认产物位于当前仓库或 lane 的 `.orrery/it-root/`（已忽略、不入库）。lane 清理时该 scratch 随 `.orrery/` 归档到主仓库的 `.orrery/lanes/<lane-id>/`。

## 配置

装置的输入全部是环境变量，由 `run.mjs` 在派生 headless 进程时设置；单独调用时以下变量有平台默认值。

| 键 | 默认值 | 说明 |
|---|---|---|
| `ORRERY_IT_ROOT` | `<仓库或 lane 根>/.orrery/it-root` | 从装置自身安装位置推导，与 cwd 无关；显式环境变量原样覆盖。profile/home/ws/trace 全在其下 |
| `ORRERY_IT_NODE` | 捆绑运行时绝对路径（按平台推导） | 启动 profile 的解释器 |
| `ORRERY_IT_PNPM` | 捆绑 pnpm 绝对路径（按平台推导） | 生成 profile 后做 `link:` 安装 |
| `ORRERY_IT_DSH` | POSIX：`/tmp/dsh-src/...`；win32：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` | 被启动的 `dsh` CLI 入口 |
| `ORRERY_IT_SCENARIO` | `deepwork` | 场景 id（驱动注入，mock 读取） |
| `ORRERY_IT_TRACE` | `<IT_ROOT>/trace.jsonl` | 该场景的 trace 输出 |
| `ORRERY_IT_FIXTURE` | `<IT_ROOT>/ws/fixture.txt` | `hashline`/`robash` 的磁盘夹具 |
| `ORRERY_IT_TSFIXTURE` | `<IT_ROOT>/ws/probe.ts` | `lsp` 场景的 TS 夹具 |
| `ORRERY_IT_WINDOW` | `128000` | mock 模型上报的上下文窗口（`pressure` 用它把阈值压小） |

## 设计细节

### 平台可移植性契约

装置必须在 macOS 与 Windows 上给出**同一套断言语义**。为此三条纪律：

1. **路径一律「环境变量覆盖 → 默认值」**。测试写根由 `src/it-root.js` 的 `defaultItRoot()` 从 `import.meta.url` 推导（包目录上两级 + `.orrery/it-root`），`run.mjs`、`src/mock-kit.js`、`src/event-tap.js` 共用；主仓库与 lane 各自解析到自己的根，不依赖调用目录。依赖旧位置的本地脚本须显式设置 `ORRERY_IT_ROOT`。工具链路径仍按平台提供默认值。`cordis.patch.yml` 的 `workspaceRoot` 与 LSP mock 路径由 `ORRERY_IT_ROOT` 注入、解释器用 `!!js process.execPath`，不另复制默认值。
2. **shell 命令走具名操作，不写字面命令**。受管代理拿到的只读 shell 按平台选择：win32 → `pwsh`，其余 → `bash`（与产品侧 `readOnlyShellName` 同源约定）。因此 mock 不能硬发 `bash` 命令。`src/shell.js` 导出：
   - `shellToolName(platform)`：平台工具名。
   - `shellCommand(operation, platform, args)`：把具名操作渲染成该平台的命令。
   - `SHELL_OPERATIONS`：全部合法操作（`echo-only` / `echo-and-wait` / `wait` / `stay-busy` / `remove-file`）。
   它**刻意不是通用 shell 翻译器**：只覆盖场景真正用到的动词；每个参数都过严格语法校验（标记与文件名只允许 `[A-Za-z0-9_][A-Za-z0-9_.-]*`，秒数必须是非负整数），因此场景字符串无法夹带 shell 语法。动词与校验器分居 `POSIX_BUILDERS` / `WIN32_BUILDERS` / `ARG_VALIDATORS` 三张同名表，契约测试钉死三表键集一致——因此“新增动词却忘了写校验”在结构上不可能。新增动词 = 三张表各加一项 + 在 `test/shell.test.js` 加命令字面量用例。
3. **断言里的工具名按平台取**。例如 `rehydrate` 场景断言"受监督成员的工具面不含 `send_message`、但含只读 shell"，这个 shell 名必须平台化（`run.mjs` 的 `READONLY_SHELL`）。

### 沙箱语义镜像（S23）

profile 的 patch 层把部署级 `workspaceRoot` 钉到 `<IT_ROOT>/outside`，即**会话工作区之外**。原因是 `writableRoots(workspace-write)` 永远包含 `/tmp` 与 `tmpdir()`，只有当测试工作区落在所有无条件可写根之外时，"某个写入点漏传 per-call policy"这类回归才会真的复现成一次拒绝。`hashline` 场景靠这条观察沙箱拒绝标记与提权提示。

因此**不要**把 `ORRERY_IT_ROOT` 指到系统临时目录——那会让该场景静默失去检出能力。

### 与预设 realm 结构的镜像

patch 层把 compaction provider 与 context-guard 消费者放进同一个 `isolate` 组，复现正式预设的分组形态。AGENTS.md §6.4 要求：改 cordis 分组时必须同步镜像到本 patch 层，否则集成测试会对"preset-load 失败类"缺陷失明。

## 边界与失败语义

- **mock 的严格供应商校验**：`mock-llm.js` 在每次请求前检查每个工具的 `parameters.type === 'object'`（`deferLoading` 的除外），不合规即抛 `Invalid schema for function '...'`。这是 S12 事故的防线——新工具 schema 不合规会让 headless 测试直接失败，而不是留到真实供应商那里才炸。
- **trace 永不阻断测试**：mock 与 event-tap 的写盘都在 `try/catch` 里，失败即忽略。缺 trace 的后果是断言失败（信息更少），而不是测试崩溃。
- **`rehydrate` 是两阶段**：phase 1 让一个成员停在 `blocked` 后进程退出；phase 2 用**同一个 session id** 在新进程里接管（协调器注册表为空），断言注册表能从 audit JSONL 重建并恢复被阻塞的子成员。
- **`robash` 的拒绝证据是平台平行的**：POSIX 侧断言 `rm` 被拒，win32 侧断言 `Remove-Item` 被拒——两者都命中各自的默认 deny 列表，是平行证据而非同一条。**覆盖边界要说准**：win32 上被拒绝的是*写命令本身*（守卫在派生前就否决），而*放行*那一跳执行的是真实 pwsh（标记经真实工具结果回传）；因此未被覆盖的是 pwsh 侧的写入行为，不是 pwsh 本身。
- **不覆盖**：真实语言服务器行为（`lsp` 用脚本化 mock 服务器）、GUI/桌面链路、真实供应商调用。
- **平台等待原语的端到端覆盖（已修复）**：`wait` / `stay-busy` 在 win32 渲染为 `Start-Sleep`。该 cmdlet 一度只在 bash 侧有对应物（`sleep`）、pwsh 侧两张表都没有，因此“同一个等待操作 macOS 放行、Windows 拒绝”。现在两侧都放行（`Start-Sleep` 入 pwsh 白名单 + `sleep` 登记为内建只读别名），且 `robash` 子成员的命令体改为一发 `echo-and-wait`，使它成为该修复的端到端钉。**覆盖边界要说准**：本装置**不加载产品 bundle 与预设 patch**（bundle 仅作 `link:` 依赖供模块解析，profile 自己的 patch 写为 `[]`，其 settings 行也不含 robash 键），因此实际生效的是**模块默认值** `DEFAULT_ROBASH_PWSH`。后果：该钉只覆盖“模块默认 allow 项”这一层；**预设 patch 行的缺失它看不见**（把 patch 行改回去，集成套件仍会全绿）。镜像行由 `test/robash-whitelist-parity.test.js` 守护，别名行由 `robash-guard-pwsh.test.js` 的别名语料守护——两者都是单元层。
- **审计词汇单源与 `supervision/<kind>` 子事件**：审计类型词汇的唯一权威来源是产品侧 `orrery-harness/src/shared/audit.js` 导出的 `AUDIT_TYPES` 冻结注册表；event-tap 经相对跨包 import 消费它（link 安装下可解析，每次 IT run 即实证），手抄清单已删除。关于动态子事件：`delegate` 的协调器在 `orrery/supervision` 之外还发射 `orrery/supervision/<kind>` 子事件。经查证，cordis 的事件分发按**精确事件名**解析监听器（`dispatch` 以 `this._hooks[name]` 对象键查找），**不支持前缀/通配订阅**，因此 tap 无法用一个订阅覆盖 `supervision/*`。结论：已知子类在 `audit.js` 登记为 `AUDIT_SUBTYPES` 导出（当前 7 种：spawn/seal/settle/group-settled/resume/terminate/group-released），event-tap 逐项展开订阅；`test/audit-types.test.js` 把协调器 `onFact` 的 kind 集合钉成与注册表一致，新增子类不登记即红。
- **等待一律走交错容忍原语**：场景驱动等待异步子代理/后台结算事件时，禁止用最后一条消息的 role 或内容（`lastRole`/`lastOfRole` 门控）决定「继续等还是结束回合」——DSH 注入的 runtime-context 快照以 user 消息入场，可能插队在 tool result 与下一请求之间使门控错位， mock 落 `unhandled` 兜底、父回合提前结束，headless 随 quiescence 退出时子代理仍在跑（S10.6；判例修复 `19adab0`/`3959f40`）。等待决策由 `mock-kit.js` 的 `waitForMarker(history, markers, budget)` 单点产出三态：标记齐 → `advance`；未齐且预算未耗尽 → `wait`（一发 1s `echo-and-wait`，盖 `ORRERY_WAIT_<n>` 递增标记）；预算耗尽 → `exhausted`——只有此时才允许 `unhandled` 兜底。重试计数从历史中的等待标记重建（mock 的 `decide` 保持纯函数，无进程内状态）；标记文本由 kit 常量单点生成/解析，驱动不得手写。**门控标记必须是结果签名而非裸词，且必须真的会进入 transcript**：系统提示（doctrine 等）以 system 消息渲染进历史，其中的散文措辞（如 'continuable child'）会让裸词门控提前命中；而 `message-text.js` 只渲染 text 块——工具调用的**参数**（提示词、写入内容）从不出现在 transcript 里，只有 user 消息、助手文本与 tool result 文本可见（`continuable` 的发送守卫因此钉在 send_message 的结果文本 'message delivered to agent'，`editlock` 的权威文件探测钉在拒绝文本 'not editable'）。已转换的承重等待/回合存续门控：`rehydrate`（phase-1 blocked 通知 + phase-2 group-settled 两段）、`escalate`、`delegate-preflight`（组结算等待 + 末段观察）、`continuable`、`robash`、`delegate`、`child-prompt`（三者原门控错位会导致无守卫的重复委派）、`editlock`（回合结束通知应答 + write 派发）、`lifecycle-inheritance`（组结算等待）。逐文件审查后**保留**的用法（非承重：纯同步序列、或 `lastOfRole` 按 role 回扫本就免疫 user 插队、或急停分支）：`hashline`、`lsp`、`deepwork`、`skill-composition`、`capstore`、`apply-transaction`、`worktree`、`notify-worktree`、`worktree-watch`、`preset-defaults`、`capability-presets-surface`、`mcp-gateway`、`cold-session`、`resume-incarnation`，以及各探测场景的 `*_PROBE error` 急停。
- **并发运行隔离**：同一 checkout 内并发执行多个 `run.mjs` 不得共享可变运行期状态。默认 IT root 由咨询锁 `<root>/.run.lock`（O_EXCL 创建，内容为 pid + ISO 时间）声明占用：锁被**存活**进程持有时，本次运行改用私有后缀根 `<root>-p<pid>` 并向 stdout 响亮提示一行，启动清空只作用于本次实际使用的根；锁持有者已消亡（pid 不存活或内容不可读）时静默接管；进程退出（含异常路径）删除自己持有的锁。显式 `ORRERY_IT_ROOT` 完全绕过锁逻辑（调用方自负隔离责任）。**后缀根不自动清理**（留痕可查），堆积目录由人工删除或 `git clean` 处理；该锁是同 checkout 进程级咨询锁，不防跨 checkout/跨机器并发。
- **回放夹具自包含契约**：每个入库的回放夹具必须自包含——其 replay 断言消费的全部文件（夹具根 `run.json`/`trace*.jsonl`、ws 顶层、`ws/.orrery/` 递归）必须受 git 跟踪，回放结论不得依赖录制者磁盘上的未跟踪文件。`.gitignore` 对 `.orrery/` 的全局忽略由一组覆盖**全部**夹具 ws 的通配规则放行（逐级：`!**/ws/.orrery/` 放行目录本身 → `**/ws/.orrery/*` 重忽略内容 → 放行枚举内种类 `audit.jsonl`、`worktrees/` → `worktrees/*` → `worktrees/lanes.json`），**禁止再写逐夹具手工例外**。可入库状态文件种类枚举单点声明在 `test/fixture-selfcontainment.test.js` 的 `TRACKABLE_ORRERY_STATE_KINDS`，与通配规则一一对应；**新增种类 = 改枚举 + 加规则**，二者背离即红。判定通道：规则侧用 `git check-ignore --no-index` 探针断言每个夹具 ws 下枚举种类可入库、枚举外种类保持忽略；文件侧枚举每个夹具目录的全部文件，默认 `git check-ignore`（索引感知）抓「未跟踪且被忽略」的静默丢失类，`git ls-files` 抓「未跟踪」的漏提交类，均点名场景与相对路径；另断言 `ws/.orrery/` 下不存在枚举外却未被忽略的文件（防 recordRun 把垃圾塞进暂存候选）。**record 义务**：重录夹具后必须连同产出的 `ws/.orrery/` 状态一起 `git add` 提交——漏交时 conformance 测试当场红（历史事故：`worktree-watch`/`editlock-stale-sweep` 的 `ws/.orrery/` 从未入库，全新 checkout 回放必红；另有少量历史夹具经 force-add 入库且保持枚举外忽略，回放不受影响）。

## 测试

- 单元测试（`plugins/orrery-test-harness/test/`）：`shell.test.js` —— 钉死平台工具名、五个操作的 POSIX/win32 命令字面量、输入卫生（未知操作/未知平台/非法秒数/可夹带语法的标记与路径一律抛错），以及**三张表键集一致**（每个动词在两侧都有 builder、且都有校验器）；期望值是独立字面量而非重算。`scenario-registry.test.js` —— registry 条目齐备性（id/prompt/decide/assert、id === 文件名、id 集与顺序钉死）。`decide-brains.test.js` —— 进程内直调各场景 `decide`，断言 chunk 序列关键点（不启动 headless profile；mock 的 decide 逻辑首次有单测）。`assert-replay.test.js` —— 录制 trace（`test/fixtures/traces/`，入库）经 `makeRunView` 回放各场景 `assert`，结论与原始运行一致，且 fixture 的 trace key 集与当前 writer 一致性校验（形状漂移即红）。`audit-types.test.js` —— 三路 conformance：tap 订阅集 === `Object.values(AUDIT_TYPES)` + `AUDIT_SUBTYPES` 展开、产品 emit 文件不得携带注册表外字面量、协调器 `onFact` kind 集 === `AUDIT_SUBTYPES.supervision`。`trace-extract.test.js` —— 每请求恰好一次 extract、trace record key 集与迁移前一致。`jsonl.test.js` 与 `message-text.test.js` —— 共享 helper 的容错与双形态语义。
`fixture-selfcontainment.test.js` —— 回放夹具自包含 conformance（契约见「边界与失败语义」）：通配忽略规则对每个已注册场景的夹具 ws 恰好放行枚举内状态文件种类、夹具消费文件全部受 git 跟踪、`ws/.orrery/` 下无枚举外未忽略文件。
`wait-primitive.test.js` —— 交错容忍等待原语直测：标记出现即 advance、未现即 wait（盖递增 `ORRERY_WAIT_<n>` 标记）、预算耗尽才 exhausted、重试计数从历史重建、尾随快照不错位。`run-lock.test.js` —— 咨询锁行为：占用分流（含响亮提示行）、残锁/垃圾锁静默接管、退出只删自己的锁、显式 `ORRERY_IT_ROOT` 绕过（源码钉住 run.mjs 接线）。
- 默认根契约：`it-root.test.js` 断言根为包目录上两级下的 `.orrery/it-root`，三处消费者引用同一 helper、默认值一致且显式覆盖不变。产品 capability-store 的单进程测试注入可编程 liveness 替身；独立 process 套件先探测 Node/ps 派生能力，不可用时逐用例显式 skip（附原因），可用时执行真实跨进程竞争、SIGKILL 恢复和 ps 探测。
- 集成测试：`pnpm --filter orrery-test-harness run test:integration` —— 装置自身就是那一层；12 个场景即验收门。
