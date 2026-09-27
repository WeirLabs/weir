# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

<!-- 纪律（见 AGENTS.md §5.2）：
     每个 feat/fix 合入时在此添加条目；
     打版时本段固化为版本段并打 tag。 -->

## [0.1.0] - 2026-09-27

首个发布版本。以 DSH bundle `orrery-harness` 交付，声明 agent 预设 `orrery`（GUI 显示名 "Orrery"）。

### Added

- **预设打包**：`orrery` 预设入驻预设选择器，与标准预设完全隔离；bundle 经 link 安装、改动禁用/启用即可重应用；自带技能目录经 `customSkillDirs` 挂载。
- **Orchestrator 总指挥**：主 agent 以 Orchestrator 身份工作，系统提示词内置协作纪律（委派拓扑决策、默认可并行、等待纪律、证据绑定验收、子任务提示词契约、拉取式后台纪律）。
- **意图门**：用户提示词命中可配置意图关键词时自动注入对应工作模式指令；`think` 意图提升当次请求的推理档位；意图表支持在线编辑，每次命中留有可审计事件。
- **分类委派**：`delegate` 工具把任务路由给专长子代理——任务类别绑定模型链与专属提示词（链内逐档解析、死链显式报错）；内置只读研究代理 `explore`/`librarian`/`oracle`；支持批量（≤16）与后台执行；`deep` 类别结果可按 `ESCALATE: deep-plus` 契约自动升级一层。
- **todo 空转续推**：任务清单未完成时自动续推；用户打断即停（直到下一条用户消息）；供应商错误按退避策略延迟重试（默认上限 5 次）；连续续推上限 8 次；`stop_continuation` 工具供模型声明真实阻塞。
- **拉取式后台通知**：后台任务结算仅投递紧凑通知（不含报告全文），完整输出用 `job_output` 拉取；唤醒风暴防护（连续唤醒上限 8）。
- **上下文压力守卫**：实时计算上下文压力；越过软阈值（0.72）提示模型择时调用 `compact_context` 压缩；越过硬阈值（0.88）在回合边界强制压缩；压缩完成自动续推任务。
- **锚点编辑**：`read` 结果每行携带 `N#XX|` 锚点；`hash_edit` 工具逐锚校验、任一锚点失效则整体拒绝（零写入），支持 replace/append/prepend 多操作并返回 unified diff；可与 stock `edit` 共存或配置隐藏。
- **内置技能**：`deep-work`、`research`、`review-work`、`debugging`（英文正文，意图命中自动指向）。
- **集成测试装置**：`orrery-test-harness`（开发专用）——真实 headless runtime + 脚本化 mock LLM，17 项端到端检查覆盖意图门/委派/锚点编辑/上下文压缩。

<!-- 本地私有仓库，无远端；链接定义在引入远端后补充。 -->
