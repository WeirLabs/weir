# Orrery 特性细节文档

本目录是 Orrery 各特性的权威细节文档：行为、配置、设计、失败语义、测试。
写作规范与更新时机见 [AGENTS.md §5](../../AGENTS.md)；新文档一律从
[_template.md](_template.md) 复制骨架并在此索引登记。

> README 只讲"用户得到什么"，本目录讲"具体怎么行为、怎么配置、为什么这么设计"。

## 索引

| 特性 | 文档 | 对应模块 |
|---|---|---|
| 预设打包 | [preset-packaging.md](preset-packaging.md) | `cordis.patch.yml`（bundle 清单） |
| Orrery 设置页 | [settings-page.md](settings-page.md) | `orrery-harness/settings` + 浏览器半区 `lib/client.settings-page.js` |
| Orchestrator 总指挥 | [orchestrator-persona.md](orchestrator-persona.md) | `orrery-harness/core` |
| 意图门 | [intent-gate.md](intent-gate.md) | `orrery-harness/intent-gate` |
| 分类委派 | [category-delegation.md](category-delegation.md) | `orrery-harness/delegate` |
| todo 空转续推 | [todo-continuation.md](todo-continuation.md) | `orrery-harness/todo-driver` |
| 拉取式后台通知 | [background-notification.md](background-notification.md) | DSH 内建 job 道 + 预设配置 |
| 上下文压力守卫 | [context-pressure-guard.md](context-pressure-guard.md) | `orrery-harness/context-guard` |
| 锚点编辑 | [hashline-edit.md](hashline-edit.md) | `orrery-harness/hashline-edit` |
| hash_edit diff 面板 | [hash-edit-diff-view.md](hash-edit-diff-view.md) | `orrery-harness/hashline-edit` + `lib/client.js` |
| 客户端 chunk 化 | [client-module-chunking.md](client-module-chunking.md) | `orrery-harness` 浏览器半区 `lib/` |
| LSP 语义工具 | [lsp-integration.md](lsp-integration.md) | `orrery-harness/lsp` |
| 共享 runtime 消息助手 | [runtime-message-helpers.md](runtime-message-helpers.md) | `orrery-harness/shared`（被 intent-gate / todo-driver / context-guard 复用） |
| Windows 沙箱 shell 约束 | [windows-sandbox-shell-constraint.md](windows-sandbox-shell-constraint.md) | 平台约束（DSH 桌面宿主） |
| 集成测试装置 | [integration-test-harness.md](integration-test-harness.md) | `plugins/orrery-test-harness`（开发专用） |
| Edit Lock 编辑锁仲裁 | [edit-lock.md](edit-lock.md) | `orrery-harness/edit-lock`（实验，默认关闭，设置 `editLockEnabled`） |
| Worktree 车道 | [git-worktree.md](git-worktree.md) | `orrery-harness/worktree` + `delegate` 的 `worktree` 参数（设置 `worktree*`） |
| Worktree 车道 | [git-worktree.md](git-worktree.md) | `orrery-harness/worktree` + `delegate` 的 `worktree` 参数（设置 `worktree*`） |
| 系统通知 | [notify.md](notify.md) | `orrery-harness/notify`（profile 级，设置 `notify*`） |
| 会话能力管理器 | [session-capability-manager.md](session-capability-manager.md) | `orrery-harness/capabilities`（实施中，已落地持久化存储层） |
