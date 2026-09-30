# 上下文压力守卫（context-pressure-guard）

> 上下文将满时助手自行择时整理记忆；逼近极限时自动压缩——重要信息永不被生硬截断。

## 概述

守卫实时计算会话的**上下文压力**（已用 token 数 ÷ 当前路由的上下文窗口），用两级阈值驱动安全的压缩时机：软阈值提醒模型"收尾当前子任务后自行压缩"，硬阈值在回合边界强制执行。压缩完成后自动续推任务，从摘要处继续工作。

## 用户可见行为

- 压力越过软阈值（0.72）→ 注入一条提示（每次越线仅一条，回落至阈值下再越线才重新提示），模型自己决定何时调用 `compact_context`。
- 模型调用 `compact_context`：空闲时立即压缩；忙碌或已有压缩进行时**不报错**，报告"已排队到下一边界"。
- 压缩完成 → 自动注入续推指令，任务从压缩摘要处继续，不丢线索。
- 压力越过硬阈值（0.88）→ 下一回合边界强制压缩一次，抢在供应商硬截断之前；无可安全压缩区间时记录该结果而不是反复尝试。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| 软阈值 | `0.72` | 越线提示一次（带滞回，不重复轰炸） |
| 硬阈值 | `0.88` | 回合边界强制压缩 |
| 启用开关 | 开 | 可整体停用守卫 |

均为 volatile config，在线编辑即刻生效。

## 设计细节

- 模块：`orrery-harness/context-guard`。
- 压力来源：`tokenMeter.measure(session)` 的 `totalTokens`（确定性测量，无模型调用）÷ 上下文窗口（`session.requestContext()`，缺省时经模型信息解析兜底，带缓存）。
- 压缩走 `ctx.compaction.compactNow`（绑定 agent 的维护例程，idle-only）；忙碌/进行中/span 变更等抛出结构化错误 → 工具返回"排队到下一边界重试"语义而非失败。结果分类的唯一实现是纯函数 `classifyCompactionOutcome(error) → 'busy' | 'failed'`（`src/context-guard/compaction-outcome.js`）：宿主 `ManualCompactionError` 的稳定 `code` 字段优先——`code === 'busy'` 判 busy、其他任何 string code 判 failed 且**消息文本永不参与**（防止非 busy 错误的措辞碰巧含 "active" 而被无限重排）；无 string code 时遗留消息正则兼底。此前版本只对消息文本做正则匹配，实测把宿主两个真实 busy 变体（"already has an open turn" / "requires an idle agent"）误牲为 failed → **排队压缩被静默丢弃**，该缺陷已随结构化分类修复（红绿证据见测试）。
- 完成后续推经 `agent.followup` 注入英文模板指令。
- 术语纪律：全模板与文档统一称 "context pressure"。
- realm 纪律：本模块与压缩服务提供者同组部署（隔离服务的消费者必须同 realm，历史事故已固化进集成测试结构）。

## 边界与失败语义

- 压缩中的会话**不会**被第二次压缩请求打断（排队语义）。
- 硬阈值触发但无安全可压缩区间 → 记录一次 no-op 结果，不循环重试。
- **保证**：压缩后必有续推指令，任务不会停在摘要处无人继续。

## 测试

- 单元测试：`test/` 覆盖压力计算、软阈值一次性提示与滞回、排队语义、硬阈值边界触发、失败记录；`classifyCompactionOutcome` 为表驱动套件（全部级联行 + 非 busy code 含 busy 词的反例 + 宿主真实措辞），另有插件级 busy → 下一边界重排队的闭环用例（首次 turn/end 无 warn、第二次边界再次触发 compactNow）。
- 集成测试：`pressure` 场景——压力提示或强制压缩触发、压缩事件入持久日志、摘要模型调用被服务、压缩后续推恢复任务。
