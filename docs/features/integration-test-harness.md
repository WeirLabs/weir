# 集成测试装置（orrery-test-harness）

> 开发专用的进程外验收装置：用脚本化 mock LLM 启动一个真实的 headless DSH profile，把 Orrery 的模块挂在宿主层跑通，并断言行为。

## 概述

`plugins/orrery-test-harness/`（包名 `orrery-test-harness`）是 Orrery 唯一的集成测试层。它与单测的分工是：单测在进程内直接调用模块、用假 ctx 断言纯逻辑；集成装置**真的启动一个 DSH profile**，让预设组合、工具表面、续推/压缩/委派/编辑在真实运行时里跑一遍，然后按 trace、耐久会话日志与磁盘夹具断言结果。

它由四部分组成：

- `run.mjs`：驱动。生成 profile（link 安装两个插件）、跑每个场景、按 trace 断言，最后汇总 `N/M integration checks passed`。
- `src/mock-llm.js`：脚本化 mock LLM 适配器（provider `mock`）。按 `ORRERY_IT_SCENARIO` 用内容规则决定每一轮的输出，并把每次调用作为一行 JSON 写进 trace。
- `src/event-tap.js`：事件探针。把 `compaction/*`、`todo/write`、`turn/end`、`user/message` 与 cordis 的 `orrery/*` 审计频道写进同一条 trace。
- `src/mock-lsp-server.js`：脚本化 LSP 服务器，给 `lsp` 场景提供协议夹具，不依赖任何外部安装。

**它必须留在开发机**：AGENTS.md §3.9 明令不得安装进任何正式 profile（`run.mjs` 生成的 profile 名为 `orrery-it`，只存在于测试根目录下）。

## 用户可见行为

对贡献者（非终端用户）可见的行为：

- `pnpm --filter orrery-test-harness run test:integration` 跑全部 12 个场景，逐条打印 `PASS`/`FAIL`，末尾给出通过计数；有失败则退出码非 0。
- 也可以只跑指定场景：`node run.mjs lsp robash`。
- 场景清单（`run.mjs` 的 `SCENARIOS`）：`deepwork`、`delegate`、`hashline`、`pressure`、`robash`、`semantic`、`grouped`、`escalate`、`background`、`terminate`、`rehydrate`、`lsp`。
- `pnpm --filter orrery-test-harness test` 跑装置自身的单元测试（shell 抽象契约）。
- 每次运行会把测试根目录整体删除重建；不在仓库内留任何产物（写入位置见下）。

## 配置

装置的输入全部是环境变量，由 `run.mjs` 在派生 headless 进程时设置；单独调用时以下变量有平台默认值。

| 键 | 默认值 | 说明 |
|---|---|---|
| `ORRERY_IT_ROOT` | POSIX：`/Users/young/.orrery-it`；win32：`D:\.orrery-it` | 测试写根（profile/home/ws/trace 全在其下） |
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

1. **路径一律「环境变量覆盖 → 平台默认」**。`run.mjs`、`src/mock-llm.js`、`src/event-tap.js`、`cordis.patch.yml` 都遵守这条；POSIX 默认值逐字保留，macOS 开发机行为不变。`cordis.patch.yml` 里 LSP mock 服务器的 `command` 用 `!!js process.execPath`——即启动本 profile 的解释器——因此不需要任何解释器绝对路径。
2. **shell 命令走具名操作，不写字面命令**。受管代理拿到的只读 shell 按平台选择：win32 → `pwsh`，其余 → `bash`（与产品侧 `readOnlyShellName` 同源约定）。因此 mock 不能硬发 `bash` 命令。`src/shell.js` 导出：
   - `shellToolName(platform)`：平台工具名。
   - `shellCommand(operation, platform, args)`：把具名操作渲染成该平台的命令。
   - `SHELL_OPERATIONS`：全部合法操作（`echo-only` / `echo-and-wait` / `wait` / `stay-busy` / `remove-file`）。
   它**刻意不是通用 shell 翻译器**：只覆盖场景真正用到的动词；每个参数都过严格语法校验（标记与文件名只允许 `[A-Za-z0-9_][A-Za-z0-9_.-]*`，秒数必须是非负整数），因此场景字符串无法夹带 shell 语法。新增动词 = 在 `src/shell.js` 加 builder + 在 `test/shell.test.js` 加契约用例。
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
- **`robash` 的拒绝证据是平台平行的**：POSIX 侧断言 `rm` 被拒，win32 侧断言 `Remove-Item` 被拒——两者都命中各自的默认 deny 列表，是平行证据而非同一条。真实 pwsh 行为不在此覆盖。
- **不覆盖**：真实语言服务器行为（`lsp` 用脚本化 mock 服务器）、GUI/桌面链路、真实供应商调用。

## 测试

- 单元测试：`plugins/orrery-test-harness/test/shell.test.js` —— 钉死平台工具名、五个操作的 POSIX/win32 命令字面量、以及输入卫生（未知操作/未知平台/非法秒数/可夹带语法的标记与路径一律抛错）。期望值是独立字面量而非重算，因此断言能与实现真正分歧。
- 集成测试：`pnpm --filter orrery-test-harness run test:integration` —— 装置自身就是那一层；12 个场景即验收门。
