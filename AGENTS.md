# AGENTS.md — Weir 开发入口

> 本文件是每次任务都在上下文里的入口：项目导航、按任务读文档的路由、不可违反的红线、完成与提交入口。
> 任何在本仓库工作的 Agent 或开发者，动手前先读完本文件；红线条文写在这里，操作细节由 §2 路由到的文档唯一权威承载。本文件随纪律演进同步修订（修订走正常 feat/docs 提交）。

## 1. 项目与仓库导航

- **产品**：Weir —— 以 Orchestrator（总指挥）为中心的 DeepSeek Harness（DSH）agent 预设，以 bundle 包 `plugins/weir-harness/`（包名 `weir-harness`）交付，声明预设 `weir`（GUI 显示名 "Weir"）。
- **当前版本**：见 [CHANGELOG.md](CHANGELOG.md)（语义化版本，tag 与 CHANGELOG 严格对应）。

```text
plugins/
├── weir-harness/         # 正式 bundle：预设声明 + 特性模块 + 技能（唯一产品代码）
└── weir-test-harness/    # 开发专用集成测试装置（mock LLM + headless profile），严禁入正式 profile
docs/
├── contributing/         # 维护者文档：开发 / 测试 / 文档 / 发布纪律（入库）
├── features/             # 特性细节文档（入库，产品级）
├── compatibility.md      # DSH 宿主版本支持矩阵（入库，打版时强制更新）
└── assets/               # 品牌与 README 图像资产（入库，SVG）
AGENTS.md                 # 本文件：入口、路由、红线（入库）
README.md                 # 客户面向产品门面（入库）
CHANGELOG.md              # 更新日志（入库）
LICENSE                   # MIT 开源协议（入库）
```

- **知识地图**（本地流程材料，**不入库**，需要时按需读取）：`docs/design.md`（设计决策）、`docs/spikes.md`（S 编号运行时硬契约，**改代码前必读**）、`openspec/`（变更流程材料）、仓库根的分析与论文 `*.md`。

## 2. 按任务读什么

| 触发条件 | 必读文档 |
|---|---|
| 改任何代码前（事件、服务、持久化、压缩、续推、委派） | `docs/spikes.md`（本地硬契约，**必读**） |
| 环境与工具链、OpenSpec 流程、纪律细节、提交、DoD | [development.md](docs/contributing/development.md) |
| 跑测试、新增测试、测试矩阵与命令 | [testing.md](docs/contributing/testing.md) |
| 改 README / CHANGELOG / docs、新增或修订特性文档 | [documentation.md](docs/contributing/documentation.md) |
| 打版、README 版本同步、兼容性矩阵、npm / GitHub / tag | [releasing.md](docs/contributing/releasing.md) |
| 行为变更走 worktree 车道 | [git-worktree.md](docs/features/git-worktree.md) |

## 3. 不可违反的红线

> 编号是既有交叉引用的稳定锚点（特性文档与源码注释按 §3.x 引用）；新增纪律追加编号，不重排。

1. **流程**：新需求一律走 OpenSpec（`openspec-propose` 立项 → `openspec-apply-change` 实施 → 验收后 `openspec-archive-change` 归档）；`openspec/` 是本地过程材料，不入库。CLI 用法见 [development.md](docs/contributing/development.md) §3.1。
2. **link bundle**：插件代码**禁止静态 import `@deepseek-ai/*`**——一律走 `ctx`（服务/事件）；工具 `parameters` 必须自带 object-rooted JSON Schema（`{type:'object',properties:{...},required:[...]}`），否则严格供应商路由直接拒绝（S12 事故）。写法见 [development.md](docs/contributing/development.md) §3.2。
3. **realm**：`inject` 的服务在某 `cordis:group` 被 `isolate` 时，本插件行必须与提供者同组（S11 事故）；host-plane 服务（tools/subagents/skills/jobs/llm/tokenMeter/systemPrompt/sessionProjections/fs 等）不受隔离影响。改 `cordis:group` 分组时必须同步测试装置镜像的 patch。
4. **消息**：`steer`/`followup`/`inject` 入参必须是完整 UserMessage 对象（共享助手 `src/shared/user-message.js`）；`session/event` 监听器内禁止同步 followup（session.append 重入拒绝）；续推走 `agent/turn-stopping` 的 steer 或 timer 延迟 followup。
5. **状态分类**：续推/重试的分类只依据 `turn/end` 的 `reason`（`completed` / `aborted{kind:'user'}` / `error{LlmFailure}`），禁止猜测其他启发式（实现：`src/todo-driver/state-machine.js`）。
6. **会话日志（冷读）**：严禁 `session.append` 自定义事件类型——本运行时的持久化在冷读（重启恢复/子代理 cold-resume）时拒绝解释含未知且未标 `ignorable` 类型的日志，而 `append` 无 ignorable 通道，写入即埋雷。审计一律走 `src/shared/audit.js`（cordis emit + `.weir/audit.jsonl` 双写）。
7. **文本**：模板层（提示词/通知/工具描述/技能正文/注入模板）一律英文；实例内容（标签、摘要、todo 文本等）跟随会话语言；文档层（README/docs/CHANGELOG/AGENTS.md）以中文为主、技术标识符保留英文。文档侧纪律见 [documentation.md](docs/contributing/documentation.md) §5。
8. **依赖**：manifest 禁止以 `dependencies`/`devDependencies` 引入 `@deepseek-ai/*`（一律 ctx 解析，防重复实例）；版本闸门双声明 `engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh"]` 必须保持同一区间，DSH ≥ 0.2.1 优先按 `engines.dsh` 判定、旧宿主回退 peer；`pnpm-workspace.yaml` 的 `autoInstallPeers: false` **严禁删除**（否则每次 install 都会把 500+ 包的 DSH 运行时拉进 node_modules）。新增真实 npm 依赖须先 spike 验证 link 解析并在变更提案中声明；已登记例外只有 `src/vendor/` 下 vendored 的 `schemastery`/`cosmokit`（S16，见 `src/vendor/THIRD-PARTY.md`）。完整语义见 [development.md](docs/contributing/development.md) §3.8。
9. **测试装置隔离**：`weir-test-harness` 仅用于开发，严禁安装进任何正式 profile。
10. **多 Agent 协作**：一切多 Agent 能力自研实现，**不依赖** DSH 官方 experimental Agent Team 插件。
11. **车道**：行为变更的实施阶段走 worktree lane 落地；开车道时 `scope` 取最小写面（`AGENTS.md`/`CHANGELOG.md` 由主会话统一同步、不进 lane scope）；新增组合行时 **lane scope 必须包含生产 `cordis.patch.yml`**（测试装置镜像的挂载会掩盖生产缺挂：黑板 remote 404 事故）。活跃 lane 上限默认 4（满槽报 `MAX_ACTIVE`）。细节见 [git-worktree.md](docs/features/git-worktree.md)。

## 4. 完成与提交

feat/fix 合入前必须完成 [development.md](docs/contributing/development.md) §5 的完整 DoD；测试层级与命令见 [testing.md](docs/contributing/testing.md)，文档更新时机见 [documentation.md](docs/contributing/documentation.md)。

提交遵循 Conventional Commits（`feat/fix/docs/chore/refactor/test(scope): ...`），一个逻辑变更一个 commit，**严禁** `Co-authored-by` 与任何 AI 署名。

打版、npm 发布与兼容性矩阵见 [releasing.md](docs/contributing/releasing.md)。
