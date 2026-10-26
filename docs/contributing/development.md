# 开发环境与开发纪律

> 本文件是环境上下文与日常开发流程的唯一权威：工具链怎么调、OpenSpec 怎么走、红线背后的操作细节、提交与完成定义怎么核。
> 入口、红线摘要与「按任务读什么」的路由在 [AGENTS.md](../../AGENTS.md)；测试矩阵与命令在 [testing.md](testing.md)。

## 1. 环境上下文

- **运行时**：DSH（宿主为 Electron 应用）。当前开发 profile：`desktop`（`$DSH_PROFILE_DIR` 下），bundle 以 link 方式安装并启用。
- **捆绑 Node/pnpm 不在 PATH**：用 Harness 会话的 `load_workspace_dependencies` 工具取绝对路径；兜底路径 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/{node/bin/node,pnpm/bin/pnpm.mjs}`。调用 pnpm 的方式：`node <pnpm.mjs 绝对路径> <args>`。
- **OpenSpec CLI**：`node_modules/.bin/openspec`（需先把捆绑 node 的 bin 目录加进 PATH）。
- **bundle 改动重应用**：`plugin_manager` 的 `set_bundle` 先禁用再启用（DSH ≥ 0.2.1 起，对已就位包的重复 `install_bundle` 在安装前即以 `already-installed` 拒绝；旧码 `ambiguous-install` 仍存在于安装后路径）。**0.2.1 实况注意**：对带宿主层行的 link bundle（如 weir-harness），off→on 循环现在可能回 `restart-required`（`unmanaged-plugin`——行运行在插件列表之外，热重载覆盖不到）——此时 profile 状态已翻转，代码改动在**下一次 App 重启**生效。
- **易失参考**：`/tmp/dsh-src`（DSH 编译产物提取）、`/tmp/oh-my-openagent`（OmO 参考仓库）随时可能丢失，不得依赖其长期存在；dsh-src 重建见下条。
- **dsh-src 重建**（上条易失参考的具体方法）：`npm_config_cache=/tmp/npm-cache npx --yes @electron/asar extract "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" /tmp/dsh-src`；重建后必须核对版本——提取物 `/tmp/dsh-src/dsh/package.json` 的 version 与安装版 `defaults read "/Applications/DeepSeek Harness.app/Contents/Info.plist" CFBundleShortVersionString` 一致方可作为当前运行时参考，否则只是历史快照。
- **会话日志解码**：日志位于 `~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`，是 append-only **多帧** zstd（Node `zlib.zstdDecompressSync` 只解首帧）。解码用入库脚本：`node scripts/dump-session.mjs <日志路径> <输出.jsonl>`（输出帧数统计，`decoded=0` 意味着 DSH 改了日志格式）。

## 2. 仓库布局（维护者视角）

顶层树见 [AGENTS.md](../../AGENTS.md) §1；哪些材料入库见 §4；本节只展开模块级布局与本地材料。

- **`plugins/weir-harness/`**（唯一产品代码）：
  - `cordis.patch.yml`：bundle 清单与组合根，预设的行、分组、隔离都写在这里。
  - `src/`：特性模块，一个特性一个目录（`core`、`delegate`、`intent-gate`、`todo-driver`、`worktree`、`settings`、`blackboard`、`capabilities`、`file-lease`、`lsp`、`notify`、`hashline-edit`、`context-guard`、`shared`、`vendor` 等），`index.js` 为组合根、`tools.js`/`prompts.js` 为表面适配。
  - `src/shared/`：跨插件共享助手（`user-message.js`、`runtime-messages.js`、`audit.js`、`child-scope.js`、`terminal-evidence.js` 等）——跨模块契约只在这里定义一次。
  - `lib/`：浏览器半区，手写 ModuleLoader chunk（`client.js` 为入口，`client.*.js` 为懒加载 chunk）；`scripts/build-client.js` 只校验产物并把 chunk 清单写回入口，不生成模块内容。
  - `skills/`：随包分发的技能正文（英文）。
  - `test/`：`node:test` 单元测试，按模块分目录。
  - `scripts/`、`types/`、`jsconfig.json`、`whitelist-defaults.json`、`icon.svg`：构建、类型声明与清单资产。
- **`plugins/weir-test-harness/`**（开发专用）：`run.mjs` 驱动、`src/scenarios/` 场景 registry、mock LLM/LSP、`test/fixtures/` 回放夹具。它镜像生产预设的组合与 realm 结构，改分组必须同步镜像（见 [testing.md](testing.md)）。
- **`scripts/`**：`release.mjs`（打版编排，见 [releasing.md](releasing.md)）、`dump-session.mjs`（会话日志解码）、`release.test.mjs`。
- **`docs/contributing/`**：本目录，维护者纪律文档（入库）。
- **本地流程材料（`.gitignore` 忽略，需要时读）**：`docs/design.md`（设计决策）、`docs/spikes.md`（S 编号运行时硬契约）、`openspec/`（变更流程材料）、仓库根的分析与论文 `*.md`、`handoff-*.md`/`install-guide-*.md`、`.weir/`（运行时 scratch）。

## 3. 流程与纪律细节

本节小节编号与 [AGENTS.md](../../AGENTS.md) §3 的红线一一对应：红线原文在入口文件，这里放「怎么做」。

### 3.1 OpenSpec 流程

新需求一律走 OpenSpec：`openspec-propose` 立项 → `openspec-apply-change` 实施 → 验收后 `openspec-archive-change` 归档。`openspec/` 是本地过程材料，不入库。

CLI 调用：`node_modules/.bin/openspec`，运行时需要捆绑 node 的 bin 目录在 PATH 里（见 §1）。

### 3.2 link bundle：一切经 ctx

- 插件代码**禁止静态 import `@deepseek-ai/*`**——服务与事件一律经 `ctx` 解析；需要 DSH 侧类型时在 `types/` 与模块内 `.d.ts` 本地声明（`types: []`，不靠包导入）。link 安装下裸包名解析不到，静态 import 立即炸掉整行。
- 工具定义用纯对象；`parameters` 必须自带 object-rooted JSON Schema，最外层是 `type: 'object'`：

```js
parameters: {
  type: 'object',
  properties: { lane: { type: 'string' } },
  required: ['lane'],
}
```

- 不合规的 schema 会被严格供应商路由直接拒绝（S12 事故）；测试装置的 mock adapter 同样按此校验，新工具 schema 不合规时 headless 测试直接失败——这是防线，不是麻烦。

### 3.3 realm：隔离与同组

- 凡 `inject` 的服务在某 `cordis:group` 被 `isolate`，本插件行必须与提供者同组（S11 事故）。
- host-plane 服务（`tools`/`subagents`/`skills`/`jobs`/`llm`/`tokenMeter`/`systemPrompt`/`sessionProjections`/`fs` 等）不受隔离影响。
- 测试装置镜像了预设的 realm 隔离结构，改动 `cordis:group` 分组时必须同步镜像到测试 patch（见 [testing.md](testing.md)）；真实预设另需新会话验证，不能只信装置内镜像。

### 3.4 消息：完整 UserMessage 与禁同步 followup

- `steer`/`followup`/`inject` 的入参必须是完整 UserMessage 对象，用共享助手 `src/shared/user-message.js` 构造，不手搓形状。
- `session/event` 监听器内**禁止同步 followup**——`session.append` 会以重入拒绝。
- 续推只有两条正路：`agent/turn-stopping` 时刻的 `steer`，或 timer 延迟的 `followup`。注入调用抛错时经 `injectOrWarn` 吞掉并写 `ctx.logger.warn`，绝不打断当前回合。
- 事件驱动插件（`intent-gate`/`todo-driver`/`context-guard`）共用同一组助手，不再各自重写（见 [runtime-message-helpers](../features/runtime-message-helpers.md)）。

### 3.5 turn/end 分类

- 续推/重试的分类只依据 `turn/end` 的 `reason`：`completed` → 续推；`aborted{kind:'user'}` → disarm；`error{LlmFailure}` → 退避延迟续推并计数；其余（max-tokens/interrupted/forked 等）不续推。
- 分类词汇的唯一实现是 `src/todo-driver/state-machine.js` 的 `classifyTurnOutcome({ signal, reason, error })`：durable reason 绝对优先于 signal/error 预分类，后者只在 `turn/end` 尚不存在的 turn-stopping 时刻生效；signal 先于 error。
- 禁止用消息条数、文本匹配之类的启发式猜结局（见 [todo-continuation](../features/todo-continuation.md)）。

### 3.6 会话日志与审计（冷读红线）

- **严禁 `session.append` 自定义事件类型**：持久化在冷读（重启恢复/子代理 cold-resume）时拒绝解释含未知类型且未标 `ignorable` 的日志，而 `append` 没有 ignorable 通道——写入即埋雷，错误要到恢复时才爆。
- 审计一律走 `src/shared/audit.js`：cordis emit（`weir/*` 频道）+ `<会话cwd>/.weir/audit.jsonl` 磁盘双写。新增审计类型登记在 `AUDIT_TYPES`，测试装置的事件探针经相对 import 消费同一份词汇表。

### 3.7 文本层

- 模板层（提示词/通知/工具描述/技能正文/注入模板）一律英文。
- 实例内容（标签、摘要、todo 文本等）跟随会话语言。
- 文档层（README/docs/CHANGELOG/AGENTS.md）以中文为主、技术标识符保留英文；文档侧纪律见 [documentation.md](documentation.md)。

### 3.8 依赖与版本闸门

- 发布到公共 npm registry，包名 `weir-harness`；分发契约（manifest 字段、`files` 白名单、prepack 门禁、patch 行只能引用发布产物内说明符）见 [npm-distribution](../features/npm-distribution.md)，打版流程见 [releasing.md](releasing.md)。
- manifest 禁止以 `dependencies`/`devDependencies` 引入 `@deepseek-ai/*`——一律走 ctx 解析，防重复实例。
- 版本闸门双声明：`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh"]` 必须保持同一区间（当前范围以 manifest 为准）。DSH ≥ 0.2.1 的兼容性检查**优先按 `engines.dsh` 判定**（存在时忽略 peer 条目；空串/非法区间视为未满足，非对象/非字符串直接抛错），旧宿主回退到 peer 的 `@deepseek-ai/dsh(-*)` 条目。prerelease 参与区间求值：下限要写 `-rc.N` 形式才会接纳 rc 运行时，`>=0.2.1` 会排斥 `0.2.1-rc.*`。
- `pnpm-workspace.yaml` 固定 `autoInstallPeers: false`，**严禁删除**：`@deepseek-ai/dsh` 自 0.2.0-rc.2 起已实际存在于公共 registry，删掉该设置后每次 install 都会把整个 DSH 运行时（500+ 包）拉进 `node_modules`。profile 的 pnpm 配置同为 `autoInstallPeers: false`，peer 只作闸门不作拉取。
- 确需引入真实 npm 依赖时须先 spike 验证 link 安装下的解析，并在变更提案中声明。
- **已登记例外**：settings schema 依赖 `schemastery`/`cosmokit` 以 DSH fork 形式 vendored 于 `src/vendor/`（上游无 volatile 机制，S16；逐个文件的来源与刷新步骤见 `src/vendor/THIRD-PARTY.md`），不新增 npm 依赖。

### 3.9 测试装置隔离

`weir-test-harness` 仅用于开发，严禁安装进任何正式 profile：`run.mjs` 生成的 profile 名为 `weir-it`，只存在于测试根目录下。装置的存在理由与边界见 [integration-test-harness](../features/integration-test-harness.md)。

### 3.10 多 Agent 协作

一切多 Agent 能力自研实现，**不依赖** DSH 官方 experimental Agent Team 插件。

### 3.11 车道纪律

- 行为变更的实施阶段走 worktree lane 落地；能力细节见 [git-worktree](../features/git-worktree.md)。
- 开车道时 `scope` 取最小写面：只含本变更要改的路径；`AGENTS.md`/`CHANGELOG.md` 由主会话统一同步，不进 lane scope。
- 活跃 lane 上限默认 4（设置键 `worktreeMaxActive`），满槽报 `MAX_ACTIVE`。
- **lane scope 必须包含本变更新增组合行时的生产 `cordis.patch.yml`**——测试装置镜像的挂载会掩盖生产缺挂（黑板 remote 404 事故：镜像有行、生产无行，集成测试全绿但面板 404）。

## 4. 提交纪律

1. **入库范围**：仅限产品实际内容——`plugins/`（源码/测试/技能/清单/构建配置）、`AGENTS.md`、`README.md`、`CHANGELOG.md`、`LICENSE`、`docs/features/`、`docs/contributing/`、`docs/assets/`、`docs/compatibility.md`、workspace 配置。其余一律 `.gitignore`（逐条注释在文件内）。
2. **提交节奏**：阶段性 feat/fix 即提交，不攒超大 commit；一个逻辑变更一个 commit。
3. **提交信息**：Conventional Commits（`feat/fix/docs/chore/refactor/test(scope): ...`）；**严禁** `Co-authored-by` 与任何 AI 署名；不含敏感信息。
4. **lockfile**：`pnpm-lock.yaml` 随 workspace 结构变化同步提交，不留悬空 diff。

## 5. 完成定义（DoD）

一个 feat/fix 批次合入前必须全部满足：

- [ ] 代码 + 对应层级测试，且相关测试全绿（矩阵见 [testing.md](testing.md)）
- [ ] OpenSpec tasks 勾选（走了流程的变更）
- [ ] `docs/features/` 新建/修订（特性级变更）
- [ ] `CHANGELOG.md` Unreleased 条目
- [ ] 用户可见表面变化已同步 `README.md`
- [ ] Conventional Commits 小步提交，无 AI 署名

打版批次另有 README 版本信息、兼容性矩阵与 tag/npm 要求，见 [releasing.md](releasing.md)；文档更新时机见 [documentation.md](documentation.md)。

## 6. 命令速查（环境与非测试）

```sh
# 工具链（Harness 会话内）
#   load_workspace_dependencies → 取 node / pnpm 绝对路径
node <pnpm.mjs 绝对路径> --filter weir-harness run check

# bundle 重应用（Harness 会话内）
#   plugin_manager: set_bundle(weir-harness, off) → set_bundle(weir-harness, on)

# OpenSpec CLI（PATH 先加捆绑 node 的 bin 目录）
node_modules/.bin/openspec --help

# 会话日志解码
node scripts/dump-session.mjs ~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd /tmp/session.jsonl

# 打版编排（细节见 releasing.md）
node scripts/release.mjs <X.Y.Z> --dry-run
```

测试命令与长跑测试的输出落盘技巧见 [testing.md](testing.md)。
