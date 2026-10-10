# 上下文压力守卫（context-pressure-guard）

> 在合适的收尾时机请求整理历史；以原生摘要结果为准，不把排队当成功。

## 概述

压力 = 已用 token ÷ 当前路由上下文窗口。默认 0.72 提醒模型持久化关键状态后请求压缩，0.88 在可等待的停止边界申请一次维护机会。摘要与历史替换全部由 DSH 原生服务执行，Weir 不复制摘要算法，也不伪造供应商溢出。

## 用户可见行为

- `compact_context` 只接受或合并请求，返回 `queued` 和 request id，并结束工具回合；这不是摘要完成的证明。
- 工具结果与回合提交后，首次 idle 机会调用原生 `compactNow`。只有确认 summarySeq 后，才发送至多一条完整续推消息。
- busy 或其他唤醒先进入下一回合：立即结算 blocked/未完成。**没有后台重试、定时压缩或自动唤醒**。todo 普通续推与延迟重试继续让路，后台通知不能解禁。
- 下一条真实用户消息唤醒后，在该步上下文说明未完成原因；模型可提出新请求，旧请求不会自行复活。
- `null` 是 no-op，没有虚构摘要；失败独立记录。两者可显式阻塞等待用户决定，不承诺一定自动继续。

## 配置

| 设置键 | 默认 | 作用 |
|---|---|---|
| `guardEnabled` | `true` | Weir 压力守卫开关 |
| `guardSoftThreshold` | `0.72` | 每次越线提醒一次 |
| `guardHardThreshold` | `0.88` | 停止边界申请维护 |

后续决策读取最新设置；阈值须满足有限数值及 `0 < soft < hard < 1`。配置或路由变化使旧测量和待执行请求失效。Weir 设置不重新配置 DSH 原生自动策略。

## 设计细节

协调器按 Agent 对象身份隔离，记录 request id、来源、接受位置、配置版本与摘要结果；同一 incarnation 的模型/硬阈值请求合并。`turn/end` 只记事实，绝不在同步 append 发布中压缩或 followup。维护权由 `runMaintenance` 决定，公开 idle 状态并不是锁。

生产两种预设保留 `delegation`/`compaction` 行 id，将 compaction 嵌入 delegation，共享 `compaction`、`toolResultPruner`、`weirCompactionCoordinator` 与编辑锁隔离域；测试镜像同一结构。todo 在决定及消费预算前检查协调器，在 provider retry 定时器执行时重新检查。

`classifyCompactionOutcome` 保持结构化 code 优先：`busy` 才判 busy，其他 string code 一律 failed；仅缺少 string code 才使用遗留消息匹配。busy 的分类不意味着重试。审计走 cordis + `.weir/audit.jsonl`，不写自定义 Session 事件。

## 边界与失败语义

- DSH 原生 auto 与真实供应商溢出恢复独立开启，可能早于 Weir 软阈值。不能把它们说成模型主动请求的压缩。
- 外部唤醒可能先到；不保证下一模型请求之前压缩，不保证每次溢出都可修复，也不保证摘要无损。重要状态应先持久化。
- 活动 turn/maintenance 的 abort、禁用、disposal 与编辑锁禁令压过成功续推。真正 idle 的 Stop 没有 DSH 取消事件；安全性来自 blocked 后没有后台唤醒义务，**不是观察到了该 Stop**。
- `commit`/`persistence` 失败可能已改变历史，需检查；不能断言回滚或完全未变。
- 成功也不直接重置高压滞回；实测降至软阈值以下后才开始新 episode。
- 续推投递不确定时显式阻塞，不重新压缩。跨进程不承诺 exactly-once；缺少可确认原生结算的旧请求必须人工核对，不能凭审计或 queued 结果宣布成功。

## 测试

聚焦 `context-guard.test.js`：工具排队、发布期间禁止压缩、真实 idle admission 替身、模型/硬压力合并、busy→blocked、真实用户输入披露、no-op、结构化失败、活动取消、live 设置及高压滞回。`todo-driver.test.js` 验证停止边界与 delayed retry 让路；`preset-realms.test.js` 与 creative parity 固定生产组合。

集成成功证据必须包含原生摘要/检查点及后续模型请求实际消费摘要；仅 inbox 插入不算通过。GUI 验证须使用包含该实现的新预设修订，主树旧会话不能替代 lane 验收。
