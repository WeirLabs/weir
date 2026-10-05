# Skill 分发：来源清单、隔离执行与 pinned 基线

> 第三方 Skill 的来源清单与 provenance 可查询、同名不静默替代、内置 Skill 受 bundle 保护，受管安装/更新只在一个 pinned 版本的隔离执行器里运行。

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

## 边界与失败语义

- 未成立的身份不参与比较（报 `unknown`，不误报「未变化」）。
- 占用名安装未经显式决策时**零写入**（cancel 是默认值）。
- executor 偏离 pin：报告偏差 + 拒绝执行（不静默降级跑别的版本）。
- 超时/超量：终止整个进程树、redact 诊断、记录失败、**无发布动作**；被取消或失败的 staging 一律丢弃。

## 测试

- 单元测试：[distribution.test.js](../../plugins/orrery-harness/test/distribution.test.js)（provenance 规范化、unknown 判定、内置保护、同名三选项、ref 身份满足、pin 常量与偏离、argv/env/诊断）。
- 集成测试：内置目录字节不变由 `plugins/orrery-harness/test/skills.test.js` 持续守护；受管安装的端到端执行（真实 executor 调用）属后续组交付时的配套验证。
