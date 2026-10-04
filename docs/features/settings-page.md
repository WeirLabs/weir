# Orrery 设置页

> 预设的一站式配置面；保存「重启后才生效」的选项后，页面会弹出居中警告弹窗，点名哪些改动需要重启 DeepSeek Harness。

## 概述

Orrery 设置页（`lib/client.settings-page.js` + 组合根 `lib/client.js`）把预设的全部扁平设置键组织成一张分组表单：意图分类、委派与模型链、续推、上下文压力、编辑、Worktree 车道、只读 bash、LSP、系统通知。所有键在 `src/settings/sections.js` 的 `FIELDS` 表里声明一次，Config schema、服务端 section 映射与页面分组都从这里派生。

设置键分两类生效语义：**即时生效**（每次消费时重读，或经 `settings.onChange` 推送，如 `delegate*`/`supervision*`、`robash*`、`lsp*`、`worktree*`、`notify*`、编辑锁保留策略 `editLockHold*`/`editLockNudge*`）与**重启生效**（消费插件在 `apply` 期一次性快照，volatile 提交不会重读）。后者过去保存后毫无反馈，容易误以为「没生效是 bug」；本页面的重启提醒弹窗即为补上这层反馈。

## 用户可见行为

- 修改任意字段后点「保存」：保存被宿主全部接受即落地，草稿清空；被宿主拒绝则草稿保留、按既有失败文案提示修正。
- 保存落地且本次改动**触达了重启生效选项**时，页面遮罩之上弹出居中警告弹窗：标题「Restart to apply／重启后生效」，正文说明这些改动重启 DeepSeek Harness 后才生效（其余改动已即时生效），并以标签逐个**点名**本次触达的选项（用该选项的显示语言标签，按设置声明顺序排列）。
- 弹窗可用底部主按钮「Got it／知道了」消除，点遮罩、按 Esc 或右上角关闭（aria 标签 Dismiss）同样消除；消除只关闭弹窗，不改动任何设置值或草稿。
- 只改即时生效选项的保存不会出现弹窗；已经有弹窗时，这样的保存也不会清掉它。保存失败不会出现弹窗。再次落地且触达重启生效选项的保存会把弹窗名单更新为本次触达的选项。
- 把某重启生效选项改回原值后再保存（无净改动）不算触达，不会出现弹窗。

## 配置

本特性无新增配置项。重启生效的 18 个键（`FIELDS` 中以 `restart: true` 标记）：

| 分组 | 键 |
|---|---|
| 意图分类 | `intentGateClassifier`、`intentGateProvider`、`intentGateModel`、`intentGateReasoningEffort`、`intentGateTimeoutMs`、`jevEndpoint`、`jevModel`、`jevApiKeyEnv` |
| 续推 | `todoEnabled`、`todoMaxConsecutive`、`todoErrorRetryMax`、`todoErrorBackoffBaseMs`、`todoErrorBackoffCapMs` |
| 上下文压力 | `guardEnabled`、`guardSoftThreshold`、`guardHardThreshold` |
| 编辑 | `hashlineHideStockEdit`、`editLockEnabled` |

其余键均为 volatile config，提交即生效（生效时机双路径见 [category-delegation.md](category-delegation.md) 的「读取时解析 / 提交时推送」）。

## 设计细节

- **单一声明**：`src/settings/sections.js` 的 `FIELDS` 条目用 `restart: true` 标记重启生效键，`RESTART_KEYS`（冻结数组）从同一声明派生；模块保持纯（无 ctx、无 node: import，jsconfig curation 规则）。
- **客户端副本由测试钉住**：ModuleLoader 内同包同步 require 不可能，设置页 chunk 持有 `RESTART_FIELDS` 常量（注册表顺序），`test/client-settings-page.test.js` 将其与 `RESTART_KEYS` 逐项对拍——与 `CURATED_AGENT_NAMES`/`CATEGORY_NAMES` 同一钉法，任一侧漂移即红。
- **保存流程**（`OrreryCardController.inject()` 的 save 动作）：先读 `form.plan()` 记下本次触达的字段（保存落地后 staged 草稿即清空，事后无法反推）；直接 `await form.save()`——宿主的 `actions().save` 丢弃 Promise，await 它等于不等待；结算后**总是** `settingsBus.notify()` 恰好一次（composer 的 LSP 开关借此重检）；`form.shell().failed` 为假且触达 ∩ `RESTART_FIELDS` 非空时，把受影响键按 `RESTART_FIELDS` 顺序写入 `restartReminder` 状态；最后 `form.publish()` 让绑定 store 重投影。
- **弹窗渲染**：`OrreryCard` 把弹窗追加到表单 children 末尾，经 `primitives.Modal` 渲染——portal 挂载到 `document.body`、页面遮罩之上居中，长页面上也不会被忽略；标题/正文/关闭 aria 标签走字典键 `restartReminderTitle`/`restartReminderBody`/`restartReminderDismiss`（en 英文模板、zh 中文），底部主按钮（`primitives.Button` variant `primary`）走 `restartReminderAcknowledge`，选项名复用各字段既有标签 `t(field)`，以 `primitives.Tag`（accent）呈现在弹窗正文。无提醒时不渲染，表单行数逐字节不变。
- **组合接线**：消除动作 `dismissRestartReminder` 经 `lib/client.js` 的 `cardFace` 注入（与 `edit`/`save`/`discard` 同一代理范式）。

## 边界与失败语义

- 保存被宿主拒绝（`failed`）：不出现弹窗，草稿保留；`settingsBus.notify()` 仍在结算后触发一次（让消费者重检真实状态）。
- 保存进行中：不发生广播、不出现弹窗——结算（无论成败）是唯一触发点。
- 空保存计划（无净改动）：宿主 `save()` no-op，不广播之外的任何状态变化，弹窗不变。
- 草稿无法解析（invalid）：表单拒绝执行保存（真实 UI 中此时保存按钮禁用），程序化调用下也不出现弹窗——触达名单只来自可执行且落地的保存。
- 只触达即时生效选项的保存：不改变已显示的弹窗；触达重启生效选项的落地保存**替换**弹窗名单为本次触达集合。
- 弹窗只是提醒：不提供重启入口，不阻止继续使用；重启与否由用户决定。

## 测试

- 单元测试 `plugins/orrery-harness/test/settings-fields.test.js`：`RESTART_KEYS` 内容全量对拍（18 键、声明顺序）、由 `FIELDS` 标记派生、冻结性。
- 单元测试 `plugins/orrery-harness/test/client-settings-page.test.js`：`RESTART_FIELDS` ↔ `RESTART_KEYS` 漂移守护；保存流程六例（落地触达重启键按注册表顺序显示、仅即时键不显示、失败保存不显示但仍在结算后广播、已显示弹窗不受仅即时键保存影响且可被后续重启保存替换、消除清空并重投影、广播只在保存 Promise 结算后触发——修复了此前保存开始即广播的时序缺陷）；弹窗渲染用例（open/标题/正文、遮罩与 Esc 消除接线、主按钮消除接线、选项标签翻译）；字典完整性用例覆盖四个新字典键。
