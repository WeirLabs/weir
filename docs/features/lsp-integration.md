# LSP 语义工具（lsp-integration）

> 想要语言服务器的真实语义答案（定义/引用/符号/诊断）时随手开启，不需要时完全消失——默认关闭，会话中随时开关。

## 概述

Orrery 的 LSP 集成把四个只读语义工具带给单个会话：`lsp_diagnostics`、`lsp_definition`、`lsp_references`、`lsp_symbols`。客户端为**零依赖自研**的最小 LSP 协议实现（JSON-RPC 2.0 + Content-Length 帧 over stdio，经 `ctx.subprocess` 起停语言服务器），因为 desktop 宿主无法解析 link bundle 的裸 npm 依赖（S14）。考虑到某些编码环境中 LSP 是语义噪音，本特性**默认关闭**且用户可在会话中随时翻转。

## 用户可见行为

- 默认：没有任何 `lsp_*` 工具，也不运行任何语言服务器。
- 会话中调用 `lsp {enabled: true}`（或设置页打开 `lsp.enabled`）→ 本会话注册四个工具；首次使用时按 (cwd, 语言族) 懒启动语言服务器。
- 工具都以 1-based 位置入参，回答结构化的 `路径:行:列` 结果；文档在查询前自动全文同步。
- 语言服务器二进制缺失时，工具返回含安装指引的可读错误（如 `npm install -g typescript-language-server typescript`），不崩溃、不毁回合。
- `lsp {enabled: false}` → 工具即刻消失，本会话持有的服务器全部关停。
- 服务器空闲 10 分钟自动关停（可配）；下次调用懒重启。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `lsp.enabled` | `false` | 为 `true` 时每个新 agent 自动启用（仍 per-session scoped）；会话内随时可用 `lsp` 工具翻转 |
| `lsp.servers` | 内置注册表 | 每语言 `{command, args, manifests, installHint}`，可覆盖/扩展：typescript（typescript-language-server）、python（basedpyright-langserver）、go（gopls）、rust（rust-analyzer） |
| `lsp.idleMs` | `600000` | 空闲自动关停阈值 |
| `lsp.requestTimeoutMs` | `15000` | 单请求超时（超时为普通工具错误） |
| `lsp.diagnosticsWaitMs` | `2000` | 诊断未发布时的短暂等待窗口 |

均为 volatile config；`lsp.enabled` 另入设置面板 `lsp` 节。

## 设计细节

- 模块：`orrery-harness/lsp`（`client.js` 协议端点、`manager.js` 生命周期、`registry.js` 服务器注册表、`tools.js` 四工具）。
- 客户端：Content-Length 帧缓冲拼接（粘包/分包容错、畸形头重同步）；JSON-RPC 请求-响应路由 + 通知分发；server→client 请求一律回 `result: null`（防对方阻塞）；`initialize`/`initialized`/`shutdown`/`exit` 状态机；每请求独立超时。
- 生命周期：`${cwd}:${languageFamily}` 一实例；didOpen 首触/didChange 后续（Full 同步、版本自增）；`publishDiagnostics` 收集到 per-file 快照；会话为服务器 holder，toggle off 或会话销毁时按引用计数关停空服务器。
- 开关：`lsp` 工具向 `exec.agent.ctx` scoped 注册/注销四工具——仅本会话可见，其他会话与预设零影响。
- 语言识别：按目标文件扩展名映射 LSP languageId（`.ts/.tsx/.js/.py/.go/.rs`…），扩展名未知直接拒绝（不起服务器）。

## 边界与失败语义

- 服务器二进制缺失 → 含安装指引的普通工具错误（**保证**不崩溃）。
- 协议错误/超时/握手失败 → 普通工具错误结果，**保证**不中断回合。
- 无注册语言的文件类型 → 拒绝于任何进程启动之前。
- 服务器意外退出 → 记录移除，下次调用懒重启。

## 测试

- 单元测试：`test/lsp-client.test.js`（帧编解码、握手、路由、通知、超时、关停）与 `test/lsp.test.js`（注册表、开关注册/注销/自动启用、四工具链路、安装指引、类型拒绝、用后关停）。
- 集成测试：`lsp` 场景——模拟 LSP 服务器全协议链路：toggle on → 诊断/定义/引用/符号逐一应答 → toggle off → 工具消失（`unknown tool`）。
