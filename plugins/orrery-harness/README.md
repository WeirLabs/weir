# orrery-harness

Orrery — 以 Orchestrator 为中心的 DSH agent 预设 bundle。声明预设 `orrery`（GUI 显示名 "Orrery"），落地七项设计：

| 模块 | 功能 |
|---|---|
| `orrery-harness/core` | Orchestrator 协作纪律提示词 section（`orchestrator:doctrine`） |
| `orrery-harness/intent-gate` | 意图门：关键词命中 → 上下文注入 / 推理提档（`agent/pre-step` + `agent/request` 瀑布） |
| `orrery-harness/delegate` | `delegate` 工具：类别路由（模型链解析）+ 精选只读代理（explore/librarian/oracle）+ 批量 + 后台 job 道 + ESCALATE 契约 |
| `orrery-harness/todo-driver` | todo 空转续推：`turn/end` reason 区分用户打断/供应商错误，`stop_continuation` 逃生舱 |
| `orrery-harness/context-guard` | 上下文压力阈值：软阈值提示 + `compact_context` 择时压缩 + 硬阈值边界强制 + 压缩后续推 |
| `orrery-harness/hashline-edit` | read 锚点增强（`N#XX|`）+ fail-closed `hash_edit` 工具 |
| （内建采用） | 拉取式后台通知由 DSH 内建 job 道承担；本预设配置 `maxConsecutiveWakes: 8` |

技能（`skills/`，经 `customSkillDirs` 挂载）：`deep-work`、`research`、`review-work`、`debugging`（英文正文；模板层英文、实例内容跟随会话语言）。

## 安装

由 Harness 会话内 `plugin_manager install_bundle` 以本目录绝对路径安装；重复安装用 `set_bundle` 禁用/启用循环重应用。

## 开发

纯 ESM JavaScript，无构建步骤（`src/**/*.js` 即运行时输入）。测试：`node --test "test/**/*.test.js"`；静态检查：`pnpm run check`（tsc checkJs 覆盖强类型核心；适配层经单测覆盖）。
