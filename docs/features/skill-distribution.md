# Skill 分发：来源清单、隔离执行与 pinned 基线

> 第三方 Skill 的来源清单与 provenance 可查询、同名不静默替代、内置 Skill 受 bundle 保护，受管安装/更新只在一个 pinned 版本的隔离执行器里运行；发布走不可变代次与原子切换，检查是只读的，更新必须经显式确认，会话内容以 pin 为准并可显式刷新。

## 概述

会话能力管理器的分发侧回答三个问题：一个已安装 Skill **从哪来**（来源仓库/类型/requested ref/subpath/安装位置/内容身份，成立不了的值一律标 `unknown`、不推断不伪造）；同名条目**怎么共处**（全部列出、同名不满足缺失引用、占用名安装必须显式决策）；以及受管安装/更新**怎么执行**（独立 staging、非交互 argv、隔离 env、超时与输出上限、超界终止进程树并 redact 诊断）。内置 Skill 只经 bundle 工作流交付与更新，第三方流程不得改写其内容，同名第三方 Skill 也不是内置身份的有效定义。

## 用户可见行为

- 分发清单逐条带来源与内容身份；不可用的值显示为 `unknown`，身份缺失的条目不参与「是否变化」判断（不会误报「未变化」）。
- 同名条目全部列出（scope、provenance、discovery precedence 仅作说明）；向已占用名称安装时必须显式选择 replace／可区分并存／cancel，默认 cancel 零写入。
- 受管安装/更新的诊断总是报告所用 executor revision；executor 偏离 pinned 基线时报告偏差并拒绝执行，直到兼容性测试通过并经用户授权。
- 超时或输出超量的受管调用被终止并 redact 记录为失败，不会发布任何内容。

## 配置

本特性无配置项（执行基线 pin 为代码常量，见下）。

## 设计细节

- **来源清单**（[distribution-manifest.js](../../plugins/orrery-harness/src/capabilities/distribution-manifest.js)）：`manifestEntryOf` 把原始记录规范化为 `{repository, sourceKind, requestedRef, subpath, installLocation, contentIdentity, state}`；未成立的值逐字 `unknown`。`changeVerdict` 只在双方身份都成立时比较，否则 `unknown`。unavailable／name-conflict／locally-modified 条目保留在清单中。
- **内置保护**（10.2）：`isBuiltinTarget` 拒绝任何指向 Orrery 内置根的分发写入；`isValidBuiltinDefinition` 只承认 `scope:'orrery-builtin'` 的候选。skills 目录字节不变由既有 [skills 结构测试](../../plugins/orrery-harness/test/skills.test.js) 守护。
- **同名规则**（[same-name-policy.js](../../plugins/orrery-harness/src/capabilities/same-name-policy.js)）：`sameNameListing` 输出 scope/provenance/precedence 的说明性列表；`refSatisfiedBy` 只按身份满足引用；`installTargetFor` 默认 cancel，replace 需确认、coexist 必须给出可区分目标名。
- **pinned 基线**（[isolated-exec.js](../../plugins/orrery-harness/src/capabilities/isolated-exec.js)）：`EXECUTOR_PIN = vercel-labs/skills@1.7.0 (3694740352eeef5cdd689af694c485f1ff62eec3)`，不新增 bundle npm 依赖；`pinVerdict` 对精确匹配放行，否则报告偏差并拒绝受管安装/更新。
- **隔离执行层**：`installArgv` 产出非交互 argv 数组（`--agent universal`、`--skill`、`--no-interactive`，无裸 `-y`，路径/ref 含空格逐字传递）；`isolatedEnv` 提供独立 staging HOME/XDG/cwd、telemetry 关闭、隔离 git config、禁用 hooks/外部 diff/filter；`spawnOptionsFor` 固定 `shell:false`、5 分钟超时、4 MiB 输出上限；`runDiagnostics` 总是报告 revision 并 redact 凭据形态文本。

## 发布、检查与更新（11.1–11.6）

- **目标与引用校验**（[publisher.js](../../plugins/orrery-harness/src/capabilities/publisher.js)）：解析后的目标路径必须留在选定 scope root 内（符号链接逃逸即拒绝并点名）；绝对路径、遍历路径、含凭据的引用一律拒绝；install-lock schema 不识别即停（不迁移、不改写、不降级、不删除）。staging 输出只映射到 DSH 识别的 global（`$DSH_AGENTS_HOME/skills`）／workspace（`.agents/skills`）根，**bundled 路径永不是发布目标**，workspace 根由宿主会话 workspace resolver 决定。
- **不可变代次发布**：staging 先落在目标文件系统；发布按 scope/identity 串行；active manifest 指针 + provenance + 操作回执在同一原子发布中切换（第 2 组的 distribution 指针）；切换前重查 active generation 与本地改动（CAS）——读者只见完整旧代次或完整新代次；平台不支持原子切换时报 **unsupported**，绝不先删后拷。
- **定期检查（只读）**（[update-lifecycle.js](../../plugins/orrery-harness/src/capabilities/update-lifecycle.js)）：24h 节奏、过期启动只补一次、「Check now」即时触发或并入同一 in-flight check（同一时刻最多一个）；失败按 48h／96h backoff 至 7d 上限；offline／unknown／private-source 与 up-to-date 分开报告；**检查绝不对真实安装目录运行 check/update/upgrade**（字节不变）。
- **手动更新**：只在用户显式确认（点名 source 与 ref）后运行；staging 后逐条核验后置条件（requested source/ref 已满足、期望身份在期望位置、content identity 已记录、lock schema 可识别），全部满足才原子替换 last-good；工具报成功但后置条件不满足一律记为失败，取消/失败丢弃 staging。
- **自动更新**：默认 OFF；opt-in 是针对 source/scope 的显式授权，不由预设加载、检查或一次手动更新隐含获得；执行前五门全过（工具基线、目标布局、lock schema、provenance 未变、无本地改动），任一失败即暂停该条目并报告、不循环重试；运行中的会话不因发布自动采用新内容。
- **会话内容 pin 与 GC**（[content-pin.js](../../plugins/orrery-harness/src/capabilities/content-pin.js)）：首次接受内容时 durable 记录正文、相对引用 assets、resourceBase 与 manifest；非 managed 来源先复制并做一致快照验证（中途变化即拒绝）；更新发布后已有会话继续使用已 pin 内容并报 update-available，采用新内容需独立于 Apply 的显式 refresh（content revision CAS）；原安装目录移除后完整 pin 仍可继续用；本地内容与上次 managed digest 不一致时暂停发布，overwrite 报「本地修改被丢弃」、leave unchanged 报「已跳过」；引用计数非零（live/durable 会话、子代理/fork、未结算 receipt）的 generation 不 GC，异常恢复保守保留。

## 边界与失败语义

- 未成立的身份不参与比较（报 `unknown`，不误报「未变化」）。
- 占用名安装未经显式决策时**零写入**（cancel 是默认值）。
- executor 偏离 pin：报告偏差 + 拒绝执行（不静默降级跑别的版本）。
- 超时/超量：终止整个进程树、redact 诊断、记录失败、**无发布动作**；被取消或失败的 staging 一律丢弃。

## 测试

- 单元测试：[distribution.test.js](../../plugins/orrery-harness/test/distribution.test.js)（provenance 规范化、unknown 判定、内置保护、同名三选项、ref 身份满足、pin 常量与偏离、argv/env/诊断）。
- 集成测试：内置目录字节不变由 `plugins/orrery-harness/test/skills.test.js` 持续守护；受管安装的端到端执行（真实 executor 调用）属后续组交付时的配套验证。
