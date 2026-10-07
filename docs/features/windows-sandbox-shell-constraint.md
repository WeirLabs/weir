# Windows 沙箱下的 shell 可用性约束

> 平台级约束记录：桌面版宿主在 `workspace-write` 下无法启动任何子进程，直接决定 Weir 只读 Agent 的 shell 能力与全部测试命令的可用性。

## 概述

Weir 的只读委派车道与文档化的测试流程都建立在"能启动子进程"这个前提上：curated 只读 Agent（`finder` / `scholar` / `advisor`）在 Windows 上被授予 `pwsh` 工具，`AGENTS.md` §6/§8 的 `pnpm run check`、`pnpm test`、`test:integration`、OpenSpec CLI 与 `git` 也都要派生进程。

DSH 桌面版在 Windows 上以 Electron 为宿主，宿主是 GUI 进程、**不持有控制台**；而 Windows ACL 沙箱派生的受限子进程必须在控制台上完成 DLL 初始化。两件事相遇的结果是：`workspace-write`（默认文件策略）下**任何**子进程都以 `STATUS_DLL_INIT_FAILED` 死亡。

这是 DSH 侧缺陷，不是 Weir 的行为选择，也不是本机环境配置问题。本文件记录它，是因为它决定了本预设在一整类环境下的可用面——上游修复后应回来复核本文件并删改相应条目。

## 用户可见行为

- 受影响的会话里，任何 shell 命令返回 `(no output)` 加退出码 `3221225794`（`0xC0000142` = `STATUS_DLL_INIT_FAILED`），**没有任何 enforcement / denial 元数据**——看起来只是一个普通的非零退出码。
- 同一会话的 `read` / `write` / `glob` / `grep` 等文件类工具完全正常（不经进程沙箱）。
- 只读委派车道在 Windows 上因此**实际没有可用的 shell**：工具面里有 `pwsh`，调用必失败。这抵消了 CHANGELOG 中登记的那项改进（此前 Windows 只读 Agent 是零 shell 能力，之后是"有一个永远崩溃的 shell"）。
- 文档化的测试流程在默认策略下整体不可执行：`pnpm --filter weir-harness run check`、`pnpm --filter weir-harness test`、`pnpm --filter weir-test-harness run test:integration` 以及 `git` 全部受影响。
- Claude Code 钩子同源失败：`hooks.json` 的 `curl.exe` 调用带 `2>$null | Out-String` 式的静默处理，失败不可见（会话日志中 `hook/result` 记录同样携带 `3221225794`）。

**可用组合**（实测）：

| 执行方式 | `workspace-write`（默认） | `danger-full-access`（提权） | `read-only` |
|---|---|---|---|
| 桌面版宿主 | ❌ `0xC0000142` | ✅ 正常 | ✅ 正常 |
| web/CLI 版（宿主为 `node.exe`） | ✅ 正常 | ✅ 正常 | ✅ 正常 |

## 配置

本约束不是配置项——它没有开关，Weir 侧也没有可调键。相关但无关的配置键是只读白名单三/五张表（`robashAllow` / `robashGitAllow` / `robashDeny` / `robashPwshAllow` / `robashPwshDeny`）：它们决定**哪些命令被放行**，与本约束（命令根本起不来）是两层不同的事，调它们无效。

会话的文件策略由 DSH 侧决定，Weir 不参与也不应参与。

## 设计细节

机制链条（上游源码坐标与文档原文见文末引用）：

1. 桌面版宿主是可执行文件 `DeepSeek Harness.exe`（Electron），桌面启动器的 `node.cmd` 垫片以 `ELECTRON_RUN_AS_NODE=1` 调它，因此"harness 需要的每个 node"实际都是 Electron 二进制。
2. 沙箱链是两层 runner：`dsh-subprocess-local` 先派生自己的 runner，再由 `dsh-sandbox-windows-acl` 的 runner 派生受限目标。实测第一层在 Electron 宿主下**能**正常创建子进程（如 `git.exe` / `rg.exe`），失败的是第二层。
3. 第二层用 `CreateRestrictedToken`（`WRITE_RESTRICTED` + Low 完整性）派生目标，**故意不使用** `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`，改为保留控制台继承——这正是"子进程需要控制台"的设计印证。
4. 缺口在宿主侧：Electron GUI 进程没有控制台可供继承。上游对照实验显示，在同一宿主内 spawn 前调用一次 `AllocConsole()` 即可让沙箱恢复正常（`exit=0`）。

Weir 侧的相关实现（未改动，仅受约束影响）：

- `plugins/weir-harness/src/delegate/index.js:24-25` — `readOnlyShellName(platform)` 在 `win32` 返回 `'pwsh'`。
- `plugins/weir-harness/src/delegate/index.js:100` — 该 shell 名并入 curated 只读 Agent 的 `toolFilter.allow`。
- `plugins/weir-harness/src/delegate/index.js:352` — 只读 Agent 的 persona 按平台命名 shell，`readOnlyShellNote` 于 `src/delegate/agents.js:10`。

## 边界与失败语义

- **不是策略拒绝**：DSH 表达沙箱拒绝只有三条通道——子进程 stderr 匹配后端方言签名、runner 自身失败的 `windows-acl-run: <detail>` 加 exit 127、以及 `SandboxUnavailableError(mode)`。本约束三条全不触发（stderr 为空），DSH 因此认为自己成功授予了限制。**因此不要把它当作"命令被拦下"来诊断。**
- **与沙箱是否真的生效无关**：受影响的会话里工作区写入仍然被正确限制、私有 temp 仍然生效；坏的只有进程创建这一步。
- **永不发生**：Weir 不会因为本约束自动放宽沙箱、不会自动提权、不会静默改用未受限路径。提权一律走 DSH 的审批通道，由用户决定。
- **诊断陷阱**：`workspace-write` 下无法用"跑一条命令"来区分假设（能跑就说明没问题），任何依赖现场取证的排查都必须换到 `read-only` 或提权会话进行。
- **附带残留风险（独立问题）**：`workspace-write` 的工作区 grant 会写入**可继承且永不撤销**的 Low 完整性标签（设计如此，作为跨会话复用缓存）。它经 NTFS 硬链接传播到 pnpm store 的共享文件对象，此后从该 store 硬链出来的可执行文件会以 Low 完整性运行，导致 `vite build` / `pnpm install` 这类与 DSH 无关的流程失败；官方诊断技能按设计不负责移除完整性标签。遇到与本项目配置无关的构建或删除权限异常时，先怀疑这一条。

## 测试

本约束不需要也不应有自动化测试（它是平台缺陷，断言"命令失败"没有价值）。相关的既有覆盖是**解释器侧**的：

- 单元测试：`plugins/weir-harness/test/delegate.test.js` — `readOnlyShellName follows the platform (pwsh on win32, bash elsewhere)` 与 `curated spawns get the platform shell in the allowlist` 锁住平台映射；`test/robash-guard-pwsh.test.js` 锁住只读守卫的放行/拒绝语料。
- 集成测试：`plugins/weir-test-harness` 的 mock 组合跑在 headless profile 下，**不经桌面版 Electron 宿主**，因此不受本约束影响。
- 复核方式（上游发新版后，在默认 `workspace-write` 会话里执行）：`Write-Output "pwsh-alive"`——仍返回 `[exit code: 3221225794]` 即修复未落地。

## 引用

- DSH 官方 Windows 沙箱后端文档：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md>（记录 `0xC0000142` 的两个已知成因：`CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 的控制台隔离边界，以及 keep-alive SID 组缺失）。
- 上游 bug 报告（同症状、跨多个版本，报告时点均未被修复）：
  - <https://github.com/deepseek-ai/deepseek-harness/discussions/8142> — 给出 `AllocConsole()` 对照实验，定位为桌面宿主无控制台。
  - <https://github.com/deepseek-ai/deepseek-harness/discussions/8062> — 同症状，并排除 PowerShell 版本、能力 SID 授权、`CREATE_NO_WINDOW`、通用受限令牌。
  - <https://github.com/deepseek-ai/deepseek-harness/discussions/7292>、<https://github.com/deepseek-ai/deepseek-harness/discussions/7836>、<https://github.com/deepseek-ai/deepseek-harness/discussions/4777>、<https://github.com/deepseek-ai/deepseek-harness/discussions/8130> — 同一族报告。
  - <https://github.com/deepseek-ai/deepseek-harness/discussions/8312> — Low 完整性标签残留（上文"附带残留风险"）。
- 本机实测记录与前序排查（本地过程材料，不入库）：`.weir/windows-sandbox-rootcause-20260929.md`、`.weir/research-sandbox-design-20260930.md`。
