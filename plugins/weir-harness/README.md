# weir-harness

> 文档导航：产品门面见仓库根 [README.md](../../README.md)；各特性的行为/配置/设计/失败语义见 [docs/features/](../../docs/features/README.md)；版本记录见 [CHANGELOG.md](../../CHANGELOG.md)；开发纪律见 [AGENTS.md](../../AGENTS.md)。

Weir — 以 Orchestrator 为中心的 DSH agent 预设 bundle。声明预设 `weir`（GUI 显示名 "Weir"），落地七项设计：

| 模块 | 功能 |
|---|---|
| `weir-harness/core` | Orchestrator 协作纪律提示词 section（`orchestrator:doctrine`） |
| `weir-harness/intent-gate` | 意图门：关键词命中 → 上下文注入 / 推理提档（`agent/pre-step` + `agent/request` 瀑布）；可选语义分类器（regex 默认 / llm sidecar / jev 实验，fail-open + 审计） |
| `weir-harness/delegate` | `delegate` 工具：类别路由（模型链解析）+ 精选只读代理（finder/scholar/advisor，bash 受只读白名单守卫）+ 批量 + 后台 job 道 + ESCALATE 契约 + 受监督分组（`group` 二元终态 + 异常续推 + 合并报告 + `resume_agent`/`terminate_agent`） |
| `weir-harness/todo-driver` | todo 空转续推：`turn/end` reason 区分用户打断/供应商错误，`stop_continuation` 逃生舱 |
| `weir-harness/context-guard` | 上下文压力阈值：软阈值提示 + `compact_context` 择时压缩 + 硬阈值边界强制 + 压缩后续推 |
| `weir-harness/hashline-edit` | read 锚点增强（`N#XX|`）+ fail-closed `hash_edit` 工具（预设默认唯一编辑工具，`hideStockEdit: false` 可回归共存） |
| `weir-harness/lsp` | 自研零依赖 LSP 客户端：四个只读语义工具（diagnostics/definition/references/symbols）；`lsp.enabled` 能力总闸（默认关），会话面板开关 + `/lsp` 命令 + `lsp` 工具按会话启用（`weirLsp` 投影持久化）；13 族社区配方注册表 + `lspServers` 用户自定义服务器 + 扩展目录可执行解析 |
| （内建采用） | 拉取式后台通知由 DSH 内建 job 道承担；本预设配置 `maxConsecutiveWakes: 8` |

技能（`skills/`，经 `customSkillDirs` 挂载）：`deep-work`、`research`、`review-work`、`debugging`、`git-master`、`refactor`、`programming`（含 references/）、`remove-ai-slops`、`work-with-pr`、`remove-deadcode`（英文正文；模板层英文、实例内容跟随会话语言）。

另含 profile 层 `weir-harness/settings` 行：Weir 设置页（Settings 应用自动生成）+ host 层 `weirSettings` 服务（生效配置分层：模块默认 ← 行 config ← 设置值）。schema 依赖 vendored 于 `src/vendor/`（见该目录 THIRD-PARTY.md）。

## 安装

由 Harness 会话内 `plugin_manager install_bundle` 以本目录绝对路径安装；重复安装用 `set_bundle` 禁用/启用循环重应用。

## 开发

纯 ESM JavaScript，无构建步骤（`src/**/*.js` 即运行时输入）。测试：`node --test "test/**/*.test.js"`；静态检查：`pnpm run check`（tsc checkJs 覆盖强类型核心；适配层经单测覆盖）。
