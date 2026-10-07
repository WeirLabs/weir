# AGENTS.md — Weir 项目开发宪章

> 本文件是 Weir 仓库的唯一权威纪律来源：开发纪律、环境上下文、版本控制纪律、文档规范、测试流程。
> 任何在本仓库工作的 Agent 或开发者，动手前必须先读完本文件。
> 本文件自身随纪律演进同步修订（修订走正常 feat/docs 提交）。

## 1. 项目速览

- **产品**：Weir —— 以 Orchestrator（总指挥）为中心的 DeepSeek Harness（DSH）agent 预设，以 bundle 包 `plugins/weir-harness/`（包名 `weir-harness`）交付，声明预设 `weir`（GUI 显示名 "Weir"）。
- **当前版本**：见 [CHANGELOG.md](CHANGELOG.md)（语义化版本，tag 与 CHANGELOG 严格对应）。
- **仓库布局**：

```
plugins/
├── weir-harness/         # 正式 bundle：预设声明 + 特性模块 + 技能（唯一产品代码）
└── weir-test-harness/    # 开发专用集成测试装置（mock LLM + headless profile），严禁入正式 profile
docs/
├── features/               # 特性细节文档（入库，产品级）
└── assets/                 # 品牌与 README 图像资产（入库，SVG）
AGENTS.md                   # 本文件（入库）
README.md                   # 客户面向产品门面（入库）
CHANGELOG.md                # 更新日志（入库）
LICENSE                     # MIT 开源协议（入库）
```

- **知识地图**（本地流程材料，**不入库**，但在磁盘上）：`docs/design.md`（设计决策）、`docs/spikes.md`（S1–S12 运行时硬契约，**改代码前必读**）、`openspec/`（变更流程材料）、仓库根三份分析 `*.md`。

## 2. 环境上下文

- **运行时**：DSH（宿主为 Electron 应用）。当前开发 profile：`desktop`（`$DSH_PROFILE_DIR` 下），bundle 以 link 方式安装并启用。
- **捆绑 Node/pnpm 不在 PATH**：用 Harness 会话的 `load_workspace_dependencies` 工具取绝对路径；兜底路径 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/{node/bin/node,pnpm/bin/pnpm.mjs}`。调用 pnpm 的方式：`node <pnpm.mjs 绝对路径> <args>`。
- **OpenSpec CLI**：`node_modules/.bin/openspec`（需先把捆绑 node 的 bin 目录加进 PATH）。
- **bundle 改动重应用**：`plugin_manager` 的 `set_bundle` 先禁用再启用（重复 `install_bundle` 会被 `ambiguous-install` 幂等拒绝）。
- **易失参考**：`/tmp/dsh-src`（DSH 编译产物提取）、`/tmp/oh-my-openagent`（OmO 参考仓库）随时可能丢失，不得依赖其长期存在；dsh-src 重建见下条。
- **dsh-src 重建**（上条易失参考的具体方法）：`npm_config_cache=/tmp/npm-cache npx --yes @electron/asar extract "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" /tmp/dsh-src`；重建后必须核对版本——提取物 `/tmp/dsh-src/dsh/package.json` 的 version 与安装版 `defaults read "/Applications/DeepSeek Harness.app/Contents/Info.plist" CFBundleShortVersionString` 一致方可作为当前运行时参考，否则只是历史快照。
- **会话日志解码**：日志位于 `~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`，是 append-only **多帧** zstd（Node `zlib.zstdDecompressSync` 只解首帧）。解码用入库脚本：`node scripts/dump-session.mjs <日志路径> <输出.jsonl>`（输出帧数统计，`decoded=0` 意味着 DSH 改了日志格式）。

## 3. 开发纪律

1. **流程**：新需求一律走 OpenSpec（`openspec-propose` 立项 → `openspec-apply-change` 实施 → 验收后 `openspec-archive-change` 归档）。openspec/ 是本地过程材料，不入库。
2. **link bundle 红线**：插件代码**禁止静态 import `@deepseek-ai/*`**——一律走 `ctx`（服务/事件）；工具定义用纯对象，`parameters` 必须自带 object-rooted JSON Schema（`{type:'object',properties:{...},required:[...]}`），否则严格供应商路由直接拒绝（S12 事故）。
3. **realm 纪律**：凡 `inject` 的服务在某 `cordis:group` 被 `isolate`，本插件行必须与提供者同组（S11 事故）；host-plane 服务（tools/subagents/skills/jobs/llm/tokenMeter/systemPrompt/sessionProjections/fs 等）不受隔离影响。
4. **消息纪律**：`steer`/`followup`/`inject` 入参必须是完整 UserMessage 对象（共享助手 `src/shared/user-message.js`）；`session/event` 监听器内禁止同步 followup（session.append 重入拒绝）；续推走 `agent/turn-stopping` 的 steer 或 timer 延迟 followup。
5. **状态分类**：续推/重试的分类只依据 `turn/end` 的 `reason`（`completed` / `aborted{kind:'user'}` / `error{LlmFailure}`），禁止猜测其他启发式。
6. **会话日志纪律（冷读红线）**：严禁 `session.append` 自定义事件类型——本运行时的持久化在冷读（重启恢复/子代理 cold-resume）时拒绝解释含未知且未标 `ignorable` 类型的日志，而 `append` 无 ignorable 通道，写入即埋雷。审计一律走 `src/shared/audit.js`（cordis emit + `.weir/audit.jsonl` 双写）。
7. **文本纪律**：模板层（提示词/通知/工具描述/技能正文/注入模板）一律英文；实例内容（标签、摘要、todo 文本等）跟随会话语言。文档层（README/docs/CHANGELOG/AGENTS.md）以中文为主、技术标识符保留英文。
8. **依赖纪律**：bundle 发布到公共 npm registry（包名 `weir-harness`）；manifest 禁止以 `dependencies`/`devDependencies` 引入 `@deepseek-ai/*`（一律走 ctx 解析，防重复实例）；`peerDependencies` 仅声明 `@deepseek-ai/dsh` 兼容区间作为 DSH 版本闸门（DSH 兼容性检查只认该字段的 `@deepseek-ai/dsh(-*)` 条目，profile 的 pnpm `autoInstallPeers: false` 不会触发拉取）。**注意**：`@deepseek-ai/dsh` 自 0.2.0-rc.2 起已实际存在于公共 registry，仓库在 `pnpm-workspace.yaml` 固定 `autoInstallPeers: false`——严禁删除该设置，否则每次 install 都会把整个 DSH 运行时（500+ 包）拉进 node_modules。确需引入真实 npm 依赖时须先 spike 验证 link 安装下的解析，并在变更提案中声明。**已登记例外**：settings schema 依赖 `schemastery`/`cosmokit` 以 DSH fork 形式 vendored 于 `src/vendor/`（上游无 volatile 机制，S16；见 THIRD-PARTY.md），不新增 npm 依赖。
9. **测试装置隔离**：`weir-test-harness` 仅用于开发，严禁安装进任何正式 profile。
10. **多 Agent 协作**：一切多 Agent 能力自研实现，**不依赖** DSH 官方 experimental Agent Team 插件。
11. **车道纪律**：行为变更的实施阶段走 worktree lane 落地；开车道时 `scope` 取最小写面（只含本变更要改的路径，`AGENTS.md`/`CHANGELOG.md` 由主会话统一同步、不进 lane scope）；注意活跃 lane 上限（默认 4，满槽报 `MAX_ACTIVE`）。细节见 [Worktree 车道特性文档](docs/features/git-worktree.md)。**lane scope 必须包含本变更新增组合行时的生产 `cordis.patch.yml`**——测试装置镜像的挂载会掩盖生产缺挂（黑板 remote 404 事故：镜像有行、生产无行，集成测试全绿但面板 404）。

## 4. 版本控制纪律

1. **入库范围**：仅限产品实际内容——`plugins/`（源码/测试/技能/清单/构建配置）、`AGENTS.md`、`README.md`、`CHANGELOG.md`、`LICENSE`、`docs/features/`、`docs/assets/`、workspace 配置。其余一律 `.gitignore`（详见文件内注释）。
2. **提交节奏**：阶段性 feat/fix 即提交，不攒超大 commit；一个逻辑变更一个 commit。
3. **提交信息**：Conventional Commits（`feat/fix/docs/chore/refactor/test(scope): ...`）；**严禁** `Co-authored-by` 与任何 AI 署名；不含敏感信息。
4. **打版纪律**：版本号语义化；打版 = CHANGELOG 的 Unreleased 段落固化为版本段 + `plugins/weir-harness/package.json` version 同步 bump + `git tag vX.Y.Z` + `npm publish`，四者版本一一对应，由 `scripts/release.mjs` 编排强制执行；脱节即事故（0.7.0 与 tag 脱节教训）。
5. **lockfile**：`pnpm-lock.yaml` 随 workspace 结构变化同步提交，不留悬空 diff。

## 5. 文档规范（产品级文档体系）

文档是产品的一部分，与代码同等级对待。**任何 feat/fix 的完成定义（DoD）都包含文档更新**。

### 5.1 文档分层与职责

| 文档 | 受众 | 职责 | 口吻 |
|---|---|---|---|
| `README.md` | **客户/潜在用户** | 产品门面：是什么、价值、怎么用、去哪里看细节 | 白话、克制术语，不出现 cordis/钩子/事件名等实现词汇 |
| `CHANGELOG.md` | 客户 + 开发者 | 每个版本的增删改、修复、破坏性变更 | 简洁事实，Keep a Changelog 1.1.0 格式 |
| `docs/features/*.md` | 高级用户 + 维护者 | 每个特性的细节：行为、配置、设计、失败语义、测试 | 精确技术语言，可引用机制与契约 |
| `AGENTS.md` | 开发者/Agent | 本宪章 | 命令式、无歧义 |

### 5.2 更新时机（强制）

- **新增/变更特性**：同一批次内完成 ① `docs/features/<feature>.md` 新建或修订 ② `CHANGELOG.md` Unreleased 段落条目 ③ 若影响用户可见表面，`README.md` 同步。三者缺一不算完成。
- **修复**：`CHANGELOG.md` Unreleased 的 `Fixed` 段加条目；若修复改变了文档化的行为，同步修订对应 feat 文档。
- **打版**：CHANGELOG Unreleased 固化 + README 版本相关信息核对 + tag。
- **README 克制原则**：实现细节只放 `docs/features/`，README 只做链接；README 中每个特性一句话说清"用户得到什么"，不说"内部怎么实现"。

### 5.3 feat 细节文档格式

一律从 [docs/features/_template.md](docs/features/_template.md) 复制骨架：概述 / 用户可见行为 / 配置 / 设计细节 / 边界与失败语义 / 测试。索引维护在 [docs/features/README.md](docs/features/README.md)。

### 5.4 语言纪律（文档层）

中文为主；技术标识符、工具名、配置键、模板原文保留英文；引用的提示词/通知模板按其实际语言（英文）原样引用。

## 6. 测试流程

| 层 | 命令 | 期望 | 何时跑 |
|---|---|---|---|
| 静态检查 | `pnpm --filter weir-harness run check` | tsc checkJs 零错误 | 改 `src/**` 后 |
| 单元测试 | `pnpm --filter weir-harness test` | 全部通过（node:test + 自研 expect 门面） | 改 `src/**`、`test/**` 后；每次提交前 |
| 集成测试 | `pnpm --filter weir-test-harness run test:integration` | 全部通过（写入 `WEIR_IT_ROOT`，默认 `<仓库根>/.weir/it-root`，lane 内自动解析为 lane 内路径；headless launcher 失效时用 `WEIR_IT_DSH_EXEC` 走安装版 CLI） | 改预设组合、工具表面、续推/压缩/委派行为后；打版前必跑 |
| 装置单测 | `pnpm --filter weir-test-harness test` | 全部通过（`src/shell.js` 的平台 shell 契约） | 改 `plugins/weir-test-harness/**` 后 |

纪律：
1. **不要安装 vitest**——捆绑 Node 因 TeamID 签名无法 dlopen 原生插件；单测只用 node:test。
2. 新特性必须有对应层级的测试：纯逻辑 → 单测；涉及运行时行为（注入/续推/压缩/委派/编辑）→ 集成测试场景。
3. mock adapter 即严格供应商：会校验工具 schema 为 object-rooted；新工具 schema 不合规时 headless 测试直接失败，这是防线不是麻烦。
4. 测试装置镜像了预设的 realm 隔离结构，改动 cordis 分组时必须同步镜像到测试 patch。

## 7. 完成定义（DoD）

一个 feat/fix 批次合入前必须全部满足：

- [ ] 代码 + 对应层级测试，且 §6 相关测试全绿
- [ ] OpenSpec tasks 勾选（走了流程的变更）
- [ ] `docs/features/` 新建/修订（特性级变更）
- [ ] `CHANGELOG.md` Unreleased 条目
- [ ] 用户可见表面变化已同步 `README.md`
- [ ] Conventional Commits 小步提交，无 AI 署名

## 8. 命令速查

```sh
# 环境（Harness 会话内）
#   load_workspace_dependencies → 取 node/pnpm 绝对路径

# 日常
pnpm --filter weir-harness run check     # 静态检查
pnpm --filter weir-harness test          # 单元测试
pnpm --filter weir-test-harness run test:integration   # 集成测试

# 长跑测试：逐套件分开跑，输出落盘再 tail（勿把串行测试链塞进单个后台 job）
#   node --test --test-reporter=spec "test/**/*.test.js" > /tmp/unit.log 2>&1 && tail -5 /tmp/unit.log

# bundle 重应用（Harness 会话内）
#   plugin_manager: set_bundle(weir-harness, off) → set_bundle(weir-harness, on)
```
