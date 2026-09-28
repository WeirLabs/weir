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

bundle 另在 profile 层插入 `orrery-harness/settings` 行：以 schemastery 的 DSH fork（`src/vendor/` 内置，含 volatile 机制）声明整树**扁平** schema，全部字段标记 volatile（设置页前置条件，S16）；**Orrery 设置页**由本包 client 半包（`lib/client.js`，手写 `__ModuleLoader__` 格式、零构建）注册为 Settings 应用的**顶层 "Orrery" 分区**（`settings.section` 槽，dsh-web-kimi/内置 General 同款落点；另注册 `plugins.item` 条目），表单经共享 SettingsFormModel（仅支持扁平寻址，故 schema 拍平）读写该命名空间；`remote.session` 域须在 inject 同时声明且**调用时惰性访问**（S17，否则槽崩溃、设置页空白）；同行提供 host 层 `orrerySettings` 服务，预设模块按 **模块默认值 ← 行 config ← 设置服务值** 读取生效配置（服务缺席=现状不变；设置作用于之后创建的 agent，进行中的会话保持原组合）。schema 不带默认值——产品默认以 settings 行 `config:` 承载（与模块代码默认 1:1 镜像，页面据此显示 effective 值），用户编辑成为覆盖层。页面按 7 组呈现（组间分割线、字号/字重分层）：布尔→开关、分类器枚举→分段选择、provider/model→**独立模型 picker 插件** `orrery-model-picker`（专用 client 模块，单行 trigger 显示"模型 · 推理等级"，展开两级菜单：模型列表按 provider 分组 + 推理等级列表；`remote.session.modelCatalog()` 数据源，选模型自动带默认推理等级；`intentGateReasoningEffort` 单独存储）；设置页经 **错误边界**消费该插件，picker 故障降级为三个普通文本字段（S17），绝不空白整页；菜单**视口感知对齐**（触发器靠右向左生长、靠左向右生长，面板内 rung 选择器不再越界）；覆盖徽标与恢复默认位于控件下方（避免横向布局跳动）。**类别模型链不再让用户手写 JSON**：字段旁"编辑"按钮展开可视化面板——9 个类别车道逐条展示，每档位复用模型 picker 插件选择模型/推理等级，增删档位与"恢复继承"一键完成，保存时程序化合成 JSON（`chainsToJson`/`jsonToChains` 纯函数，有单测）。其余→文本/数字输入。

面板覆盖：意图分类器（classifier/sidecar 路由/超时/jev 连接）、委派（9 类别模型链 JSON 编辑 + 受监督退避三键）、todo 续推（开关/上限/退避）、上下文压力（开关/软硬阈值）、锚点编辑（hideStockEdit 开关）、只读 shell（总开关 + bash 白名单三表 + pwsh 白名单两表明细编辑）。**白名单也不再让用户手写 JSON**：`robashAllow` / `robashGitAllow` / `robashDeny` / `robashPwshAllow` / `robashPwshDeny` 五个字段各有「编辑」按钮展开 `RobashListEditorField` 面板——逐行增删改命令名，保存时程序化合成 JSON（`stringListToJson`/`jsonToStringList` 纯函数，有单测）；折叠行显示条目计数，已保存值非法（非 JSON 字符串数组）时显式报错并拒绝打开（fail-closed UX）。五键语义（安全敏感）：键缺席 → 回退下层（行 config → 模块默认表）；键在场（含空数组）→ 权威生效——**显式清空 = 全不放行（fail-closed 更严），绝不回退默认**；坏 JSON 在服务层激活即败（`parseRobashLists`，lspServers 同款先例）。pwsh 两表兑现 `robash<Shell>*` 命名约定，git 子命令门控两侧共享 `robashGitAllow`。

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
