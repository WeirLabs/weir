# LSP 语义工具（lsp-integration）

> 需要语言服务器的真实语义答案（定义/引用/符号/诊断）时，在设置中开启能力，然后在会话面板随手点亮——不用时即刻消失，默认完全不打扰。

## 概述

Orrery 的 LSP 集成把四个只读语义工具带给单个会话：`lsp_diagnostics`、`lsp_definition`、`lsp_references`、`lsp_symbols`。客户端为**零依赖自研**的最小 LSP 协议实现（JSON-RPC 2.0 + Content-Length 帧 over stdio，经 `ctx.subprocess` 起停语言服务器），因为 desktop 宿主无法解析 link bundle 的裸 npm 依赖（S14）。

开关分两层，语义明确：

- **能力总闸**（设置 `lspEnabled`，默认关）：关 → `lsp` 工具、`/lsp` 命令、会话面板开关全部不存在，任何通道都无法开启 LSP；开 → 能力面就位，**每个新会话默认关**。
- **会话级开关**（会话面板 LSP 开关，或模型调用 `lsp` 工具）：只影响当前会话，随时翻转。

## 用户可见行为

- 默认（设置关）：没有任何 LSP 表面，也不运行任何语言服务器。
- 设置开启后：会话头工具区出现 **LSP 开关**（不亮 = 本会话未启用）；点击点亮 → 本会话注册四个工具，首次使用时按 (cwd, 语言族) 懒启动语言服务器；再次点击熄灭 → 工具即刻消失、本会话持有的服务器全部关停。
- 模型也可以自行调用 `lsp {enabled: true/false}` 切换，与面板开关共享同一状态。
- 设置关闭时正在启用的会话被立即清理（工具注销、服务器关停、开关消失）；重新开启后会话回到默认关。
- 会话级状态持久化：会话重启/应用重启后，之前点亮 LSP 的会话自动恢复四个工具。
- 工具都以 1-based 位置入参，回答结构化的 `路径:行:列` 结果；文档在查询前自动全文同步。
- 语言服务器二进制缺失时，工具返回含安装指引的可读错误（如 `npm install -g typescript-language-server typescript`），不崩溃、不毁回合。
- 服务器空闲 10 分钟自动关停（可配）；下次调用懒重启。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `lsp.enabled` | `false` | 能力总闸：关 = LSP 完全不存在；开 = 面板开关 + `lsp` 工具 + `/lsp` 命令可用，新会话默认关 |
| `lsp.servers` | 内置注册表 | 每语言 `{command, args, manifests, installHint}`，可覆盖/扩展：typescript（typescript-language-server）、python（basedpyright-langserver）、go（gopls）、rust（rust-analyzer） |
| `lsp.idleMs` | `600000` | 空闲自动关停阈值 |
| `lsp.requestTimeoutMs` | `15000` | 单请求超时（超时为普通工具错误） |
| `lsp.diagnosticsWaitMs` | `2000` | 诊断未发布时的短暂等待窗口 |

均为 volatile config；`lsp.enabled` 另入设置面板 `lsp` 节，保存后**实时生效**（settings 服务在 volatile 提交时广播，LSP 模块原地注册/注销能力面，无需重启）。

## 设计细节

- 模块：`orrery-harness/lsp`（`client.js` 协议端点、`manager.js` 生命周期、`registry.js` 服务器注册表、`tools.js` 四工具、`index.js` 门闸与双通道开关）。
- 客户端：Content-Length 帧缓冲拼接（粘包/分包容错、畸形头重同步）；JSON-RPC 请求-响应路由 + 通知分发；server→client 请求一律回 `result: null`（防对方阻塞）；`initialize`/`initialized`/`shutdown`/`exit` 状态机；每请求独立超时。
- 生命周期：`${cwd}:${languageFamily}` 一实例；didOpen 首触/didChange 后续（Full 同步、版本自增）；`publishDiagnostics` 收集到 per-file 快照；会话为服务器 holder，toggle off 或会话销毁时按引用计数关停空服务器。
- **门闸状态机**：`gate = settings.get('lsp').enabled ?? 行配置 enabled ?? false`；开闸 `setupSurface()`（注册投影 + `lsp` 工具 + `/lsp` 命令，持有全部 disposer），关闸 `teardownSurface()`（注销面、清理已启用会话、终止全部服务器）；`settings.onChange` 驱动实时翻转。
- **持久状态**：`orreryLsp` 会话投影（stateVersion 1）纯折叠会话日志——`tool/call`（name `lsp`，`arguments.enabled`）与 `command/run`（name `lsp`，args `on`/`off`）更新 `{enabled}`；`agent/created` 时按投影恢复（冷 resume 后工具仍在），`agent/disposed` 清理。
- **双通道**：`/lsp on|off`（面板，`ctx.commands.register`，invocation.agent 缺失/坏参返回 error）与 `lsp` 工具（模型，exec.agent）共享同一 per-session 运行时状态；面板开关状态由客户端 `useProjection("orreryLsp")` 读宿主折叠值。
- 客户端面板开关：注入 `conversation.session.header.utilities` 槽（open-in-app 同族）；命令目录不含 `lsp` 时不渲染（能力关）；点击经 `remote.commands.execute(sessionId, "/lsp on|off", [])`；无 `useProjection` 注入时降级为投影拉取 + 乐观更新。
- 语言识别：按目标文件扩展名映射 LSP languageId（`.ts/.tsx/.js/.py/.go/.rs`…），扩展名未知直接拒绝（不起服务器）。

## 边界与失败语义

- 服务器二进制缺失 → 含安装指引的普通工具错误（**保证**不崩溃）。
- 协议错误/超时/握手失败 → 普通工具错误结果，**保证**不中断回合。
- 无注册语言的文件类型 → 拒绝于任何进程启动之前。
- 服务器意外退出 → 记录移除，下次调用懒重启。
- 命令目录拉取失败 → 面板开关不渲染（宁缺勿假）。
- 能力闸关闭瞬间 → 已启用会话的工具注销、服务器终止；进行中的工具调用不受影响（对象已注销，仅不可见新调用）。

## 测试

- 单元测试：`test/lsp-client.test.js`（帧编解码、握手、路由、通知、超时、关停）与 `test/lsp.test.js`（门闸开/关、settings 覆盖优先、命令 on/off/坏参/无 agent、投影折叠、agent/created 恢复、实时翻转、四工具链路、安装指引、类型拒绝、用后关停）。
- 集成测试：`lsp` 场景——模拟 LSP 服务器全协议链路：toggle on → 诊断/定义/引用/符号逐一应答 → toggle off → 工具消失（`unknown tool`）；IT 行 `enabled: true` 镜像能力闸开启。
- 真实 GUI 验收：设置开 → 会话头开关出现 → 点亮 → 四工具可见 → 熄灭 → 消失 → 设置关 → 开关消失（用户桌面验收）。
