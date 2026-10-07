# Orrery 设置页

> 预设的一站式配置面：仅在全局设置面板提供入口，按卡片分区呈现；细调参数收为总开关的子项并按条件显隐；重启生效选项行内常驻「需重启」标记，保存后另有居中弹窗点名本次触达的改动。

## 概述

Orrery 设置页（`lib/client.settings-page.js` + 组合根 `lib/client.js`）把预设的全部扁平设置键组织成九个卡片分区：意图分类、委派与模型链、续推、上下文压力、编辑、Worktree 车道、只读 bash、LSP、系统通知。所有键在 `src/settings/sections.js` 的 `FIELDS` 表里声明一次，Config schema 与服务端 section 映射从那里派生；页面分组、可见性条件（`when`）与父子层级（`parent`）是**纯展示层概念**，在客户端 chunk 的 `GROUPS` 表里声明，不影响任何设置键的生效语义。

设置键分两类生效语义：**即时生效**（每次消费时重读，或经 `settings.onChange` 推送）与**重启生效**（消费插件在 `apply` 期一次性快照，volatile 提交不会重读）。后者由两层反馈覆盖：行内常驻「需重启」标记 + 保存后的重启提醒弹窗。

## 用户可见行为

- **唯一入口**：设置仅从全局设置面板的 Orrery 分区进入；插件面板不再有 Orrery 设置项（UI 层面 breaking，迁移路径就是全局设置）。
- **条件显隐，即时求值**：细调参数只在其前提成立时出现——翻动总开关（尚未保存）立即显示/隐藏其细调子项；`intentGateProvider/Model/ReasoningEffort`（合并为一行模型选择器）仅在分类器为 `llm` 时出现，`jev*` 仅在 `jev` 时出现；`robashPwsh*`（pwsh 黑白名单）仅在 Windows 宿主出现。隐藏是纯视觉行为：被隐藏条目的已保存值与已暂存草稿都原样保留，后续保存仍按既有契约写入。
- **层级缩进**：子设置项紧随父条目渲染，以左侧引导线 + 按深度递增的缩进呈现（如 `notifyMinTurnSeconds` 是 `notifyOnComplete` 的子项、两级嵌套）；父条目隐藏时整个子树随之隐藏。
- **环境门控无闪烁**：依赖宿主环境事实（平台）的条目在事实到达前不渲染任何内容；端点请求失败时这些条目保持隐藏，页面其余部分正常可用（控制台警告一次）。
- **重启标记常驻**：重启生效条目的标签旁常驻「Restart required／需重启」标记，无需先保存。
- **保存与重启提醒**（既有契约，未变）：保存被宿主全部接受即落地、草稿清空；被拒绝则草稿保留并按既有文案提示。落地且触达重启生效选项时弹出居中警告弹窗，按设置声明顺序点名本次触达的选项；弹窗可经主按钮、遮罩、Esc 或右上角关闭消除，消除不改动任何值。只改即时生效选项不出现弹窗，也不清掉已显示的弹窗；保存失败不出现弹窗；改回原值（无净改动）不算触达。
- **覆盖/重置**：被用户层覆盖的字段显示「已覆盖」标记与「恢复默认」入口，行为不变。
- **默认值显示**：未设置的字段直接显示生效的产品默认值——数字/文本输入框显示格式化后的默认值（如 `intentGateTimeoutMs` 显示 1500、`worktreeRoot` 显示 `.orrery/worktrees`），枚举分段控件选中默认项（如 `intentGateClassifier` 选中 `regex`、`notifyForeground` 选中 `skip`），与布尔开关显示默认开/关的既有行为一致。显示默认值不等于写入：字段保持「未覆盖」状态、不产生保存计划，只有用户真正编辑才会落值；暂存草稿与已保存值始终优先于默认显示，清空输入则回到默认显示。unset 有语义的键（路由覆盖、chains、五张 whitelist 表、`robashDefaultsPath/Reload`、`lspServers`）没有默认值，保持空显示。

## 配置

本特性无新增配置项。重启生效的 18 个键（`FIELDS` 中以 `restart: true` 标记）：

| 分组 | 键 |
|---|---|
| 意图分类 | `intentGateClassifier`、`intentGateProvider`、`intentGateModel`、`intentGateReasoningEffort`、`intentGateTimeoutMs`、`jevEndpoint`、`jevModel`、`jevApiKeyEnv` |
| 续推 | `todoEnabled`、`todoMaxConsecutive`、`todoErrorRetryMax`、`todoErrorBackoffBaseMs`、`todoErrorBackoffCapMs` |
| 上下文压力 | `guardEnabled`、`guardSoftThreshold`、`guardHardThreshold` |
| 编辑 | `hashlineHideStockEdit`、`editLockEnabled` |

条件与层级的落地方案（`GROUPS` 声明）：各功能细调参数收为其总开关的子项并以其开启为显示条件（`todo*` → `todoEnabled`、`guard*` → `guardEnabled`、`editLock*`（含维护面板）→ `editLockEnabled`、`worktree*` → `worktreeEnabled`、`robash*` → `robashEnabled`、`lsp*`（含 LSP 管理器）→ `lspEnabled`、`notify*` → `notifyEnabled`，`notifyMinTurnSeconds` 再收为 `notifyOnComplete` 的子项）；`robashPwshAllow/Deny` 追加 `{ env: 'platform', in: ['win32'] }`；`intentGateProvider`（模型选择器行，含 folded 的 `intentGateModel`/`intentGateReasoningEffort`）条件 `classifier == 'llm'`，`jev*` 条件 `== 'jev'`。委派分组字段与总开关本身无条件。

## 设计细节

- **条件 DSL（纯数据 AST，客户端求值）**：`when` 节点为 `{ key, equals|in }` / `{ env, equals|in }` / `{ all: [...] }` / `{ any: [...] }` / `{ not: ... }`（冻结纯数据）。`evaluateCondition(node, resolve)` 是纯函数：严格相等/严格成员判定，未解析的值只匹配显式 `equals: undefined`。
- **生效值解析（草稿优先）**：`resolveEffectiveValue` 按「可解析草稿 → 已保存值 → 产品默认」求值——草稿为空（clear 语义）取产品默认（布尔走 `BOOLEAN_DEFAULTS` 派生子集，其余各 kind 走 `FIELD_DEFAULTS`，无条目时 `undefined` 即默认不满足条件）；草稿不可解析回退已保存值，避免无效输入期间显隐抖动。布尔开关的 `checked` 显示与条件求值共用这一个 helper，显示与条件不可能不一致。
- **产品默认值的唯一声明与三层镜像**：`src/settings/sections.js` 导出冻结的 `FIELD_DEFAULTS`（39 个有具体默认值的扁平设置键，纯模块、无新增 import），是唯一权威声明；`cordis.patch.yml` 的 `orrery-settings` 行携带同样值让已保存 profile 解析到默认；客户端 chunk 手维护一份逐字镜像（ModuleLoader 同包同步 require 不可能的既定代价，与 `RESTART_FIELDS` 同款），`BOOLEAN_DEFAULTS` 改为从镜像派生（布尔子集），不再手写第二份字面量。显示层走 `displayText`：字段静止文本为空且有默认条目时把格式化默认值作为 `SettingsValueField` 的 `text` / `SegmentedControl` 的 `value`——纯显示，保存/暂存/覆盖语义不读它。三层漂移由测试对拍钉死：sections.js ↔ 各模块常量（源头）、sections.js ↔ chunk 字面量（raw 文本提取）、sections.js ↔ patch 行（raw 文本提取，不引入 yaml 依赖）。
- **层级组织与声明校验**：`parent` 必须引用同组字段；`buildLayout(GROUPS)` 产出每组有序树（根保持声明顺序，子节点 DFS 归位到父节点正下方并携带 `depth`），渲染与声明顺序无关。`validateLayout(GROUPS)` 在 chunk 加载时执行：未知父键、跨组父键、父子环、`when` 引用未知设置键、未知环境事实名均以 `SettingsLayoutError`（指明问题键）fail-loud。父隐则子隐由树裁剪天然获得。
- **特殊编辑器归一**：链式编辑器 ×2、停用类别编辑器、robash 列表 ×5、模型选择器行、LSP 管理器、Edit Lock 维护面板、notify 权限入口统一为 `kind: 'custom'` 节点（携带渲染槽标识），与普通行同享 `parent`/`when`。LSP 管理器行已并入原 `lspServers` 原始 JSON 行：单一 custom 节点携带 `lspServers` 字段（robash 列表同款形态，表单层 text-backed），覆盖标记/恢复默认与坏 JSON 报错提示（`lspManagerInvalidJson`，danger token 文案）都收在管理器行的折叠控制区；坏 JSON 时面板仍以空自定义列表打开，增删服务器后保存即覆盖坏值——任何存储态都不会把字段卡死（robash 同款语义）。模型选择器行保持合并语义：节点挂在 `intentGateProvider` 上，两个 folded 字段不独立渲染、`when` 与承载行一致声明；错误边界降级为三个纯文本字段的契约不变。
- **环境事实端点**：宿主新增 `POST /api/orrery-settings/env`（`src/settings/env-admin.js`，注入 platform 便于测试），返回 `{ ok: true, value: { platform } }`；只读、无秘密、不轮询。接线在 `src/settings/index.js` 经 `ctx.inject(['connection'])`（与 `wireLspAdmin` 同款，S19 不新增 package subpath）；模块本体按 `src/lsp/admin.d.ts` 同款 `.d.ts` 影子声明留在 checkJs 检查图之外。客户端在页面到达时取一次，三态 pending/ready/failed：依赖 env 的条目 pending/failed 均不渲染（`conditionUsesEnv` 判定，`not` 也不例外），failed 控制台警告一次。
- **分区视觉**：每组一张卡片——`background: var(--dsw-alias-bg-layer-1)`、`border: 1px solid var(--dsw-alias-border-l1)`、圆角（几何硬编码），组标题在卡片内顶部，组内条目间 `border-top: 1px solid var(--dsw-alias-border-l2)` 细分隔；子项 `padding-left` 按 `depth` 递增 + `--dsw-alias-border-l2` 引导线，标签字号随层级略降。全部用色仅主题 token，深浅主题由宿主 token 双值保证。
- **重启标记同源**：行内常驻 `primitives.Tag`（字典键 `restartRequired`，en 英文/zh 中文）与保存后弹窗共用客户端 `RESTART_FIELDS` 常量；该常量由测试与宿主 `RESTART_KEYS` 逐项对拍，任一侧漂移即红。
- **保存流程**（既有契约，`OrreryCardController.inject()`）：先读 `form.plan()` 记下触达字段；`await form.save()` 结算后 `settingsBus.notify()` 恰好一次；落地且触达 ∩ `RESTART_FIELDS` 非空时按注册表顺序写入 `restartReminder`；最后 `form.publish()` 重投影。投影为每个字段附带 `saved`（`form.sectionValue`），供不可解析草稿回退。
- **入口唯一**：组合根只注册 `settings.section` 与 `settings.orrery.item` 两个槽位；`plugins.item` 注册及其 disposer 已删除，`SettingsCardWrapper` 的 `view === 'summary'` 死分支（唯一调用方是插件面板）同步清理。

## 边界与失败语义

- 环境事实未到达（pending）或端点失败（failed）：依赖 env 的条目保持不渲染，其余条目不受影响；失败控制台警告一次（chunk 生命周期内）。
- 草稿不可解析：条件按已保存值求值（无抖动）；表单自身契约不变（保存按钮禁用、程序化保存被拒绝）。
- 已保存的 `lspServers` 是坏 JSON：管理器行显示错误提示，面板以空自定义列表打开；增删后保存覆盖坏值，字段永不被卡死。
- 隐藏条目：保存值与暂存草稿均保留；隐藏本身不产生任何写入。
- 非法声明（指错父、跨组父、环、未知条件键/环境名）：chunk 加载即抛 `SettingsLayoutError`，页面宁可不渲染也不渲染错误布局。
- 保存被宿主拒绝 / 保存进行中 / 空保存计划 / 仅即时键保存：均不出现弹窗、不清既有弹窗；`settingsBus.notify()` 仍在结算后触发一次。触达重启键的落地保存替换弹窗名单。
- 弹窗只是提醒：不提供重启入口，不阻止继续使用。

## 测试

- 单元测试 `plugins/orrery-harness/test/client-settings-page.test.js`：`evaluateCondition`（key/env 谓词、all/any/not、严格成员、未知键）、`resolveEffectiveValue`（D3 全部分支，含各 kind 的具体产品默认）、`validateLayout`（未知父/跨组父/环/未知条件键/未知 env 名/重复字段/畸形条件，错误命名与键名钉住）、`buildLayout`（声明顺序无关的归位与 depth、DFS 序）、真实 `LAYOUT` 结构（两级嵌套用例）；渲染用例——逐组默认可见集合快照、开关草稿即时显隐、枚举条件、env 三态门控、父隐则子隐、隐藏不产生写入、缩进引导线与分隔线结构、特殊编辑器归一（含模型选择器合并行与 folded 语义）、常驻重启标记恰好出现在可见 RESTART 行、Switch 显示与条件共用 helper；默认值显示（unset 数字/文本/枚举显示默认值、草稿与已保存值优先、清空回到默认、不覆盖不写值、unset 分类器的条件按 `regex` 求值）；chunk `FIELD_DEFAULTS` ↔ 服务端声明、`BOOLEAN_DEFAULTS` 派生恰为 14 个开关默认；`RESTART_FIELDS` ↔ `RESTART_KEYS`、`CURATED_AGENT_NAMES`、`CATEGORY_NAMES` 漂移守护；字典完整性（含 `restartRequired`）；保存流程七例（时序、提醒、消除、失败语义）不回归；控制器 env 获取（ready 重投影、failed 警告一次）。
- 单元测试 `plugins/orrery-harness/test/client.test.js`：组合断言——不再注册 `plugins.item`，`settings.section`/`settings.orrery.item` 保留，inject 面不变。
- 单元测试 `plugins/orrery-harness/test/settings-env-admin.test.js`：env 端点契约（注入 platform 的应答形状、无 connection 时警告且不注册、`wireEnvAdmin` 接线与幂等 dispose）。
- 单元测试 `plugins/orrery-harness/test/settings-fields.test.js`：`RESTART_KEYS` 内容全量对拍（18 键、声明顺序、冻结性）；`FIELD_DEFAULTS` 四层对拍——声明本体（39 键、冻结、unset 有语义的键无条目）、↔ 可导入的模块常量（intent-gate/supervision/todo/guard/edit-lock/lsp/worktree/notify 源头）、↔ 客户端 chunk 逐字镜像（键集+值+冻结字面量）、↔ patch 行（30 个行键为其子集且值相等，布尔子集恰 14 键）。
