# LSP 语义工具（lsp-integration）

> 需要语言服务器的真实语义答案（定义/引用/符号/诊断）时，在设置中开启能力，然后在会话面板随手点亮——不用时即刻消失，默认完全不打扰。

## 概述

Orrery 的 LSP 集成把五个语义工具带给单个会话：四个只读查询（`lsp_diagnostics`、`lsp_definition`、`lsp_references`、`lsp_symbols`）加一个改写工具 `lsp_rename`（跨文件符号重命名，经 fs 版本护栏安全落盘）。客户端为**零依赖自研**的最小 LSP 协议实现（JSON-RPC 2.0 + Content-Length 帧 over stdio，经 `ctx.subprocess` 起停语言服务器），因为 desktop 宿主无法解析 link bundle 的裸 npm 依赖（S14）。

开关分两层，语义明确：

- **能力总闸**（设置 `lspEnabled`，默认关）：关 → `lsp` 工具、`/lsp` 命令、会话面板开关全部不存在，任何通道都无法开启 LSP；开 → 能力面就位，**每个新会话默认关**。
- **会话级开关**（会话面板 LSP 开关，或模型调用 `lsp` 工具）：只影响当前会话，随时翻转。

## 用户可见行为

- 默认（设置关）：没有任何 LSP 表面，也不运行任何语言服务器。
- 设置开启后：会话输入栏（模型选择器旁）出现 **LSP 开关**（不亮 = 本会话未启用）；点击点亮 → 本会话注册五个工具，首次使用时按 (cwd, 语言族) 懒启动语言服务器；再次点击熄灭 → 工具即刻消失、本会话持有的服务器全部关停。
- 设置页 LSP 节提供 **"管理 LSP 服务"** 面板：列出全部 13 族服务器的安装状态与版本；缺失的服务器**一键安装**（先展示完整命令 → 确认 → 执行 → 输出与退出码回显）。面板底部可**添加/删除自定义语言服务器**（族名/命令/参数/安装命令，随设置保存，保存后检测并同样支持一键安装）。
- 模型也可以自行调用 `lsp {enabled: true/false}` 切换，与面板开关共享同一状态。
- 设置关闭时正在启用的会话被立即清理（工具注销、服务器关停、开关消失）；重新开启后会话回到默认关。
- 会话级状态持久化：会话重启/应用重启后，之前点亮 LSP 的会话自动恢复五个工具。
- 工具都以 1-based 位置入参，回答结构化的 `路径:行:列` 结果；文档在查询前自动全文同步。
- **`lsp_rename` 语义重命名**：以 1-based 位置与 `new_name` 调用，语言服务器算出跨文件的全部改动位置（WorkspaceEdit），插件经 fs 版本护栏落盘——先对**每个**目标文件预检（解析/stat/读取/合成新全文），全部通过才逐文件原子写回；写盘后逐文件渲染 unified diff 与「N edit(s) across M file(s)」汇总。服务器不支持 rename、返回 `documentChanges`（文件移动/删除）、或符号无改动时，分别报错/拒绝/报空操作，均零写入。
- 语言服务器二进制缺失时，工具返回含安装指引的可读错误（如 `npm install -g typescript-language-server typescript`），不崩溃、不毁回合。
- **PATH 扩展解析与用户前缀**：GUI 进程 PATH 仅含系统目录（macOS 上由 LaunchServices 启动），nvm/Homebrew/cargo/go 的 bin 不在其中；服务器与安装器解析在服务失败后自动扫描常见安装目录（nvm 优先），子进程注入扩展 PATH（`env node` 脚本可用），npm 安装统一落用户可写前缀；安装完成后即刻可被识别。**Windows 走独立方言**：扫描 `%APPDATA%\npm`（npm 全局前缀，`.cmd`/`.ps1` shim 所在）与 `~/.npm-global`，裸名按 `PATHEXT` 探测，PATH 用 `;` 拼接，npm 安装前缀为 `%APPDATA%\npm`；`.cmd` 经 `cmd.exe` 启动（CreateProcess 不执行批处理）。
- 服务器空闲 10 分钟自动关停（可配）；下次调用懒重启。
- **握手失败自动恢复**：懒启动的 initialize 握手失败（如工作区 TypeScript 安装缺 tsserver）时，本次调用报握手错误、进程被终止、记录被丢弃——下一次调用起全新服务器重试，不会被「半死」记录卡住。
- **跨文件覆盖面 = 本会话已同步文档集**（tsserver 实测）：rename/references 的跨文件结果只覆盖本会话经任一 lsp 工具同步（打开）过的文件；对目标外文件先跑一次 `lsp_diagnostics`（或任一 lsp 工具）再 rename，覆盖面才完整。编辑器态客户端天然如此（文件随访问打开），本集成按会话懒同步。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `lsp.enabled` | `false` | 能力总闸：关 = LSP 完全不存在；开 = 面板开关 + `lsp` 工具 + `/lsp` 命令可用，新会话默认关 |
| `lsp.servers` | 内置注册表 | 每语言 `{command, args, manifests, installHint}`，可覆盖/扩展：typescript（typescript-language-server）、python（basedpyright-langserver）、go（gopls）、rust（rust-analyzer） |
| `lsp.idleMs` | `600000` | 空闲自动关停阈值 |
| `lsp.requestTimeoutMs` | `15000` | 单请求超时（超时为普通工具错误） |
| `lsp.diagnosticsWaitMs` | `2000` | 诊断未发布时的短暂等待窗口 |
| `lsp.servers` | 内置注册表 | 用户自定义服务器（`lspServers` 设置，面板可视化编辑）：每族 `{command, args?, manifests?, installHint?, install?}`，覆盖/扩展内置目录 |

内置注册表 13 族：typescript、python（basedpyright）、go（gopls）、rust（rust-analyzer）、json/html/css/markdown（`vscode-langservers-extracted`）、bash、dockerfile、yaml、lua、cpp（clangd）。配方取自社区注册表（nvim-lspconfig / lsp-mode / Helix / vscode-langservers-extracted，来源注明于 `src/lsp/registry.js`）。每族带平台化安装命令（npm/pipx/go/rustup/brew/apt），由管理面板执行。

**VSCode 生态说明**：VS Code 语言扩展是 VS Code API 插件，不可直接复用；其捆绑的服务器二进制探测列为后续项（路径私密、随版本漂移，见文档边界）。社区生态以配方注册表形式引入。

均为 volatile config；`lsp.enabled` 另入设置面板 `lsp` 节，保存后**实时生效**（settings 服务在 volatile 提交时广播，LSP 模块原地注册/注销能力面，无需重启）。

## 设计细节

- 模块：`orrery-harness/lsp`（`client.js` 协议端点、`manager.js` server record 生命周期、`child-process.js` 可执行解析→启动形态→受限运行、`uri.js` URI codec 纯叶子、`registry.js` 服务器注册表、`tools.js` 四工具、`index.js` 门闸与双通道开关）。
- 客户端：Content-Length 帧缓冲拼接（粘包/分包容错、畸形头重同步）；JSON-RPC 请求-响应路由 + 通知分发；server→client 请求一律回 `result: null`（防对方阻塞）；`initialize`/`initialized`/`shutdown`/`exit` 状态机；每请求独立超时。
- 生命周期：`${cwd}:${languageFamily}` 一实例；didOpen 首触/didChange 后续（Full 同步、版本自增）；`publishDiagnostics` 收集到 per-file 快照；会话为服务器 holder，toggle off 或会话销毁时按引用计数关停空服务器。
- **门闸状态机**：`gate = settings.get('lsp').enabled ?? 行配置 enabled ?? false`；开闸 `setupSurface()`（注册投影 + `lsp` 工具 + `/lsp` 命令，持有全部 disposer），关闸 `teardownSurface()`（注销面、清理已启用会话、终止全部服务器）；`settings.onChange` 驱动实时翻转。
- **持久状态**：`orreryLsp` 会话投影（stateVersion 1，声明 `wire` 以推送到客户端）纯折叠会话日志——`tool/call`（name `lsp`，`arguments.enabled`）与 `command/run`（name `lsp`，args `on`/`off`）更新 `{enabled}`；`agent/created` 时按投影恢复（冷 resume 后工具仍在），`agent/disposed` 清理。
- **双通道**：`/lsp on|off`（面板，`ctx.commands.register`，invocation.agent 缺失/坏参返回 error）与 `lsp` 工具（模型，exec.agent）共享同一 per-session 运行时状态；面板开关状态由客户端 `useProjection("orreryLsp")` 读宿主折叠值。
- 客户端面板开关：注入 `conversation.input.right` 槽（composer 栏，空白与有内容会话均常驻；会话头 utilities 槽仅在会话有内容后出现）；命令目录不含 `lsp` 时不渲染（能力关）；点击经 `remote.commands.execute(sessionId, "/lsp on|off", [])`；无 `useProjection` 注入时降级为投影拉取 + 乐观更新。
- 管理端点：`src/lsp/admin.js` 经 `ctx.connection.fetch.register` 注册（由 profile 级 settings 行接线，避免新增包子路径）；注册表为 live provider（内置 + `lspServers`）；status 含 `installerAvailable`（安装器自身可否解析）。
- **可执行解析的平台分支**：`src/lsp/child-process.js` 服务优先、扩展目录扫描回退（S21：GUI 进程 PATH 最小化事故）。解析接口按目标平台参数化（默认宿主，沿用 `installSpecFor(entry, platform)` 先例）：
  - 路径形态（含 `/` 或 `\`，如 `C:\bin\ls.cmd`、`C:/bin/ls`、`./ls`）直接按文件系统判定，**不**交给服务解析器当命令名；
  - 裸名先走服务解析器，再扫扩展目录；win32 扫描按 `PATHEXT` 依次探测 `.com/.exe/.bat/.cmd`（小写化，因 npm 写 `.cmd` 而 PATHEXT 拼 `.CMD`），命中扩展名即视为可执行（NTFS 无执行位）；POSIX 仍以执行位判定；
  - 扩展目录 win32 为 `%APPDATA%\npm`（npm 全局前缀，`.cmd`/`.ps1` shim 坐落于此）、`~/.npm-global` 根与其 `bin`、`~/.local/bin`、`~/.cargo/bin`、`~/go/bin`、`scoop\shims`；POSIX 为 nvm 版本 bin + Homebrew/usr/local/opt/local + `~/.npm-global/bin` 等；
  - `augmentedPath()` 用目标平台分隔符拼接（win32 `;`，POSIX `:`），子进程环境只有 `PATH` 一个键；
  - `npmGlobalPrefix()` win32 返回 `%APPDATA%\npm`，POSIX 返回 `~/.npm-global`。
- **启动形态包装**：`spawnArgv(command, args, platform)` 决定真正交给 `ctx.subprocess.spawn` 的 argv——Windows 的 CreateProcess 既不执行批处理也无 shebang 处理（Node 对 `.cmd` 直接 `EINVAL`）。**不经 shell**：`.cmd`/`.bat` shim 被读入并**拆包**，交付 `node <cli> <args>`。三类真实 shim 均覆盖：npm 自带的 `"%NODE_EXE%" "%NPM_CLI_JS%" %*`（含 npm 的字面 `\"` 转义与 `SET` 变量链）、corepack/pnpm 的 `"%~dp0\node.exe"` 形态、以及 `%APPDATA%\npm` 安装用的 `"%_prog%"` 模板。解析是**结构化**而非按引号形状：取最后一行 `%*` 转发、只剔离引号转义（保留路径分隔符）、变量链迭代到不动点且给候选排序（npm 对 `NPM_CLI_JS` 赋值三次，`%%F` 那个 FOR 循环产物在启动时永不可解）。解释器按 shim 自身规则选（`%dp0%\node.exe` 存在则用它，否则用当前运行的 Node——shim 会用的裸 `node` 并不在声明的子环境 PATH 里）。**只有**当路径与每个参数都可证明不含空格/引号/cmd 元字符时，才回退 `cmd.exe /d /c`（**不用 `/s`**）；否则**明确拒绝**（宁失败也不得静默弄错路径或放行注入）。`.ps1` 经 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`，`.exe`/`.com` 直启，POSIX 维持 `[command, ...args]`。服务器、版本探测、面板安装器三个 spawn 点共用该形态；`childEnvironment()` 在 Windows 额外带上 `SystemRoot`/`ComSpec`（供 cmd 回退使用）。实测（本机，全部无 shell、含含空格路径）：npm 11.17.0、pnpm 11.7.0、typescript-language-server 6.0.1、dsh 0.1.7-rc.2；反例：`cmd /d /c <含空格 shim> --prefix "C:\Users\John Smith\…"` → `'C:\Program' is not recognized`，`--prefix "C:\a&b\npm"` → `&` 被当作命令分隔符。
- 管理端点的两个定时器均不拖住宿主：「带 deadline 跑到完」的唯一实现是 `child-process.js` 的 `runBounded(subprocess, { argv, timeoutMs, unref })`——累积合并 stdout/stderr、竞速完成与 deadline、超时回调内尽力 terminate、退出码归一化，定时器在**所有结算路径**释放（`try/finally`——真正漏的是**抛错路径**：启动失败（spawn EINVAL）会从 race 中抛出，此前已武装的 8s 定时器会让进程多活到它开火；实测 4ms 工作 → 8007ms 进程寿命，修后 7ms）。`unref` 为显式选项：**安装截止时间 `unref: true`**（无人等待也不拖住宿主）；**探测窗口 `unref: false`**——实证（Node v24）unref 定时器开火后仍被活动资源计数短暂滞留，会破坏探测卫生钉，故探测路径保持 ref 形态。`probeVersion`/`runInstall` 只是供给 argv/timeout/结果塑形的薄适配器；输出截断与版本行提取留在适配器。
- `POST /api/orrery-lsp/status`（逐族 PATH 探测 + 版本轻探测）与 `POST /api/orrery-lsp/install`（族名校验、平台化命令、argv 直执行无 shell、输出收集、超时终止、退出码归一化）；connection/subprocess 缺席时优雅降级（不注册端点）。面板 UI 置于错误边界内，端点不可用时面板内联错误。
- 语言识别：按目标文件扩展名映射 LSP languageId（`.ts/.tsx/.js/.py/.go/.rs`…），扩展名未知直接拒绝（不起服务器）。

## 边界与失败语义

- 服务器二进制缺失 → 含安装指引的普通工具错误（**保证**不崩溃）。
- 协议错误/超时/握手失败 → 普通工具错误结果，**保证**不中断回合。
- 无注册语言的文件类型 → 拒绝于任何进程启动之前。
- 服务器意外退出 → 记录移除，下次调用懒重启。
- **rename 预检失败（任一目标文件解析/读取/合成失败、编辑范围越界或重叠）→ 整个调用报错，零文件被写**。
- **rename 写入中途失败（`FS_STALE_VERSION`/沙箱拒绝/IO）→ 即停，错误报告精确列出已写与未写文件清单**；文件原行尾风格（LF/CRLF）在写回时保留。
- 服务器未声明 `renameProvider` → 普通工具错误；服务器返回 `documentChanges` → 显式拒绝且零写入（本版本不做文件移动/删除/创建）。
- 命令目录拉取失败 → 面板开关不渲染（宁缺勿假）。
- 能力闸关闭瞬间 → 已启用会话的工具注销、服务器终止；进行中的工具调用不受影响（对象已注销，仅不可见新调用）。

## 测试

- 单元测试：`test/lsp-client.test.js`（帧编解码、握手、路由、通知、超时、关停；注册表语言映射、平台安装命令解析）与 `test/lsp.test.js`（门闸开/关、settings 覆盖优先、命令 on/off/坏参/无 agent、投影折叠、agent/created 恢复、实时翻转、实时调参、五工具链路、安装指引、类型拒绝、用后关停）；`test/lsp-admin.test.js`（status/install/版本探测/退出码归一化/超时终止/HTTP 接线/缺席降级）与 `test/lsp-admin-probe.test.js`（探测超时结算后不留下已武装的定时器）。
- 平台可移植语料：`test/lsp-executable-win32.test.js`（win32 绝对路径形态、`%APPDATA%\npm` 与 `~/.npm-global` 扫描、PATHEXT 探测、无扩展名同名文件不算可执行、PATH 分号拼接、npm 前缀、子环境变量）与 `test/lsp-spawn-argv.test.js`（三类真实 shim 拆包（含 npm 自带的 `%NODE_EXE%`/`%NPM_CLI_JS%` 链与**无扩展名目标**）、含空格路径、拆包失败时 `cmd /d /c` 回退且**不含 `/s`**、不安全形状明确拒绝、`.ps1` → powershell、`.exe` 直启、POSIX 不变）。既有 POSIX 语料改为显式传平台（`{ platform: 'darwin' }`）并用跨平台可执行夹具（拷贝当前解释器），使其在 Windows 上同样可跑。已知语言限制：语料中的 corepack fixture 只建模 `IF EXIST "%~dp0\node.exe"` 那一支（真实 `pnpm.CMD` 最后一行 `%*` 属该支；`ELSE` 的裸 `node` 支未被覆盖，因测试的 `existsFile` 接缝使其不可达）。
- 真实 GUI 验收：设置开 → 会话头开关出现 → 点亮 → 四工具可见 → 熄灭 → 消失 → 设置关 → 开关消失（用户桌面验收）。
