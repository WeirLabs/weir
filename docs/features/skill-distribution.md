# Skill 分发（已撤回）

> **撤回声明（2026-10-16）**：本页此前描述的「第三方 Skill 受管分发」能力——来源 provenance、受管安装/更新、内容 pin、隔离执行器——**从未接线交付**：策略层模块曾以「仅测试覆盖、零生产 importer」的形态存在，文档与发布说明却以已交付口吻陈述，属过度承诺。全部相关代码（六个策略模块、三条测试套件、`apply-engine` 的 `coordinate` 钩子）已删除，`skill-distribution` spec 的 14 条未交付要求已撤回。本页保留作为决策记录。

## 实际交付的等价路径

第三方/团队 Skill 的分享与更新，当前由以下已交付能力承担：

- **v2 预设包导入**：能力集合（含随包本地 Skill 文件）可导出为便携包，另一台机器导入时带 dry-run 与碰撞检查、经显式确认后安装到解析出的 project/user 根；安装条目保持未启用，直到显式 Apply。见 `preset-package.js` / `preset-package-install.js` 与[会话能力管理器](session-capability-manager.md)。
- **Weir 捆绑 Skill 随 bundle 更新**：Weir 自带的十项技能随 npm 包 `weir-harness` 版本分发与升级。见 [npm 公共分发](npm-distribution.md)。
- **本地技能发现根**：放在 `.dsh/skills`、`.agents/skills` 或用户根目录下的 Skill 会被库存枚举发现，经会话选择 + Apply 启用。纯仓库引用（repository/ref）不会自动取回——未解析的引用在清单中如实显示为缺失，不提供安装动作。

## 撤回的能力清单

以下能力**不存在**于任何已交付版本，相关声明已撤回：

- 点击缺失 repository/ref 引用进行可信安装
- 清单中的逐条来源 provenance（仓库/ref/内容身份）
- 受管的更新检查（定期或「Check now」）与一键确认更新
- 自动更新 opt-in
- 原安装目录移除后仍可用的会话内容 pin 与显式 refresh
- pinned 基线的隔离执行器

## 决策依据（2026-10-16 需求评估）

归档提案（openspec/changes/archive/2026-10-06-session-capability-manager/）的原始动机——区分「已安装/本会话启用/默认启用」、把第三方 Skill 的来源与安装纳入可审阅流程——经逐条映射后确认：最清晰的工作流已由上述三条交付路径承担；剩余未服务部分（repo/ref 安装、provenance、受管更新、pin）构成一条新的供应链产品线，而非既有代码的接线收尾。所有者裁决不建，删除并撤回。若未来出现具名的、经常性的纯仓库引用交换工作流或合规性 provenance 需求，可重新立项。
