# 预设打包（preset-packaging）

> Orrery 作为一个可选预设出现在 DeepSeek Harness 中：安装即见、与其他预设完全隔离、随源码更新。

## 概述

Orrery 的全部能力以一个 bundle 包（`plugins/orrery-harness/`，包名 `orrery-harness`）交付。bundle 声明一个 id 为 `orrery`、显示名为 "Orrery" 的 agent 预设，排在内置预设之后。用户安装后在 GUI 预设选择器中即可选用；不选用的会话不受任何影响。

## 用户可见行为

- 安装 bundle 后，Web GUI 预设选择器出现 "Orrery"，可用它创建新会话。
- 使用其他预设（如 standard）的会话完全感知不到 Orrery：没有它的工具，也没有它的提示词段落。
- Orrery 会话自带技能目录（10 项），经 `skill` 工具加载。
- bundle 代码或组合更新后，新创建的 agent 使用新版本；进行中的 agent 保持原组合直到结束。
- Orrery 不会抢占默认预设，除非用户显式把它设为默认。

## 配置

bundle 无运行时配置项。预设组合由 `plugins/orrery-harness/cordis.patch.yml` 声明（入库）。

### Orrery 设置面板（一站式配置）

bundle 另在 profile 层插入 `orrery-harness/settings` 行：以 schemastery 的 DSH fork（`src/vendor/` 内置，含 volatile 机制）声明整树**扁平** schema，全部字段标记 volatile（设置页前置条件，S16）；**Orrery 设置页**由本包 client 半包（`lib/client.js`，手写 `__ModuleLoader__` 格式、零构建）注册为 Settings 应用的**顶层 "Orrery" 分区**（`settings.section` 槽，dsh-web-kimi/内置 General 同款落点；另注册 `plugins.item` 条目），表单经共享 SettingsFormModel（仅支持扁平寻址，故 schema 拍平）读写该命名空间；同行提供 host 层 `orrerySettings` 服务，预设模块按 **模块默认值 ← 行 config ← 设置服务值** 读取生效配置（服务缺席=现状不变；设置作用于之后创建的 agent，进行中的会话保持原组合）。schema 不带默认值——设置页仅承载用户显式设置项，不会压过预设行的产品默认。

面板覆盖：意图分类器（classifier/sidecar 路由/超时/jev 连接）、委派（9 类别模型链 JSON 编辑 + 受监督退避三键）、todo 续推（开关/上限/退避）、上下文压力（开关/软硬阈值）、锚点编辑（hideStockEdit 开关）、只读 bash 总开关（robash.enabled）。白名单明细编辑与富 UI 面板为后续项。

## 设计细节

- bundle 为 `private: true` 的 npm 风格包，清单经 `dsh.bundle.patch` 指向 Cordis patch 文件；**不声明任何 `@deepseek-ai/*` 运行时依赖**——这些在运行时由安装环境解析（link 安装下静态 import 不可解析，插件代码一律走 `ctx`）。
- 预设组合包含：标准工具面（fs/搜索/bash 或 pwsh/jobs/todo/web/ask-user/present/skills）、goal 组、计划模式组、压缩组、委派组（原生 subagent/workflow + 七个自有模块行：`core`、`intent-gate`、`delegate`、`todo-driver`、`bg-notify`、`context-guard`、`hashline-edit`）。
- 技能经 `skill-filesystem` 的 `customSkillDirs` 从 bundle 自身安装位置解析挂载。自带目录：`deep-work`、`research`、`review-work`、`debugging`、`git-master`、`refactor`、`programming`（含分语言 references/）、`remove-ai-slops`、`work-with-pr`、`remove-deadcode`。结构纪律：frontmatter `name`==目录名、`description` 一行、正文英文（`test/skills.test.js` 机器强制）。
- 服务隔离纪律：被 `isolate` 的服务（如压缩组），其消费者插件行必须与提供者同组，否则预设加载永久等待（历史事故，已修复并镜像进集成测试）。
- 重复安装同一路径被幂等拒绝；改动经"禁用→启用"循环重应用。

## 边界与失败语义

- 预设行激活失败（如服务依赖未满足）会在激活审计中具名报告，不会静默半残。
- bundle 未安装/未启用时，任何会话都不会出现 Orrery 痕迹。
- **保证**：预设隔离——Orrery 的工具与提示词段落在非 Orrery 会话中永不出现（有回归测试证据）。

## 测试

- 单元测试：无直接对应（组合层）。
- 集成测试：`plugins/orrery-test-harness` 以镜像的预设组合（含隔离结构）跑全部场景，隔离回归在开发会话工具目录核查中佐证。
