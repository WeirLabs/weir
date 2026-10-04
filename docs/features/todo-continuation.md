# todo 空转续推（todo-continuation）

> 任务清单没做完，助手自己接着干；你喊停它就停，供应商抖动它自己退避重试。

## 概述

agent 回合正常结束但 todo 清单还有未完成项时，续推驱动器会自动注入一条续推消息让 agent 继续工作。它精确区分三种结束原因：正常完成（续推）、用户打断（尊重，不续推）、供应商/网络错误（延迟退避续推并计数）。模型另有 `stop_continuation` 逃生舱，用于声明真实阻塞。

## 用户可见行为

- 回合结束、todo 未完且本会话没有未结算后台 job → 自动续推一条列出剩余项的消息（英文模板；todo 条目文本保持原语言），agent 在新的一步继续。
- 本会话拥有 `running` / `stopping` 后台 job → 不续推，等待 job 结算通知唤醒；等待不增加也不重置连续续推计数。最后一个 job 结算后的唤醒回合若仍有未完成 todo，按原有 armed / cap 规则恢复续推。
- 你中途打断 → 不会续推，直到你再发消息（你的打断永远被当作有意为之）。
- 供应商错误（如 429/5xx/断网）→ 不立即重试，按退避策略延迟续推（默认 30s 起步、翻倍至 5 分钟封顶），连续失败计数到上限（默认 5）即放弃并记录阻塞。
- 任意成功回合或你的新消息 → 失败计数归零。
- 连续自动续推最多 8 次（无用户输入时），防失控空转。
- 模型判断真的推不动时可调用 `stop_continuation` 声明阻塞（原因经冷读安全审计通道持久记录，见 AGENTS.md §3.6），你的下一条消息重新武装续推。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| 退避初始延迟 | 30s | 供应商错误后的首次续推延迟，逐次翻倍 |
| 退避封顶 | 5min | 延迟上限 |
| 连续失败上限 | 5 | 耗尽即停止续推并记录阻塞 |
| 连续续推上限 | 8 | 无用户输入时的自动续推总上限 |

均为 volatile config，在线编辑即刻生效。

## 设计细节

- 模块：`orrery-harness/todo-driver`。
- todo 读取：`sessionProjections` 的 todos 投影（live 引用，只读）。
- 续推挂点：`agent/turn-stopping`——回合收尾且无欠账时触发，监听器内 `agent.steer(...)` 注入续推消息，机器重读 inbox 再跑一步（协议认可的正规续推方式；`session/event` 监听器内禁止同步 followup）。
- 结束原因分类严格依据 `turn/end` 的 `reason`（AGENTS.md §3.5）：`completed` → 续推；`aborted{kind:'user'}` → disarm；`error{LlmFailure}` → 退避延迟续推+计数；其余（max-tokens/interrupted/forked 等）不续推。禁止启发式猜测。分类词汇的唯一实现是纯函数 `classifyTurnOutcome({ signal, reason, error })`（`state-machine.js`，11 行优先级真值表：durable reason 绝对优先于 signal/error 预分类——后者仅在 `turn/end` 尚不存在的 turn-stopping 时刻生效；signal 先于 error），两个决策点（turn-stopping 的 steer 与 turn/end 的计数/复位）消费同一结果，user-interrupt disarm 收敛为单一实现。
- 续推消息为完整 UserMessage 对象（`src/shared/user-message.js`），重新武装只认 `source.kind === 'user'` 的真实用户输入——自身注入、子代理结算通知（`subagent-settled`）、上下文压力提醒等运行时注入消息一律不触发 rearm。
- jobs 查询留在 `index.js`，通过 host-plane 服务 `ctx.get('jobs')?.list(agent.session.id)` 只检查本会话持有的 job，不跨会话聚合。纯状态机接收 `jobsRunning` 布尔输入，在 `consecutive` 递增前抑制。
- provider-error 延迟重试在 timer fire 时与 remaining / armed 一起重查 jobs；若仍未结算，直接放弃这次注入，不重排 timer、不改变 `errorStreak`（既有 `turn/end` 错误计数仍保留）。后续唤醒依赖 job 结算通知，不新增轮询。

## 边界与失败语义

- **Edit Lock 联动（仅当开发组合启用 [edit-lock](edit-lock.md) 时）**：会话被 Stop 持久中断后，steer 续推与 provider 错误重试都不触发，直到可信恢复：`/edit-lock resume`，或 `editLockAutoResume` 开启（默认）时一条真实用户消息——后者等价于 Continue，重新武装编辑续推；开关关闭时普通用户消息不恢复编辑续推。未启用 Edit Lock 时行为不变。
- todo 全完成时不续推（不会无事生非）。
- 长命 job（如 dev server）整个运行期间都会抑制 todo 自动续推，这是预期行为。用户仍可发消息唤醒会话并 rearm / 重置计数，但新消息不会绕过 jobs 抑制；用户打断与 `stop_continuation` 的语义不变。
- jobs 服务缺席时退化为既有续推行为；查询抛错同样 fail-open，并通过 `logger.warn` 记录，不引入熔断状态。
- disarm 状态（用户打断/逃生舱/计数耗尽）下任何路径都不会续推，只有真实的新用户消息（`source.kind === 'user'`）重新武装。
- **保证**：用户打断后零自动续推；连续续推永不超上限。

## 测试

- 单元测试：`test/` 覆盖续推 steer、完成静默、用户打断 disarm、供应商错误退避与计数、逃生舱、用户消息复位、注入豁免（自身注入/结算通知/其他插件注入均不 rearm）；`classifyTurnOutcome` 为表驱动套件（11 行真值全表 + durable-priority 与 signal-before-error 两条顺序不变量）。
- 集成测试：`deepwork` 场景——续推消息进入会话日志并到达模型。
- jobs 单测：`running` / `stopping`、计数不增不重置与结算后恢复、session owner、缺席 / 抛错降级，以及 retry fire 重查、不重排、不改变错误计数。
- 集成场景：`jobs-aware-todo` 留一个未完成 todo 后委派后台子代理；断言父回合在子 job 运行中结束且会话日志全程无 `<todo_continuation>`（headless 在回合结束即 quiescence-exit，不等运行中 job——S10.6，故结算后恢复半段由 jobs 单测覆盖）。该断言对旧驱动必然失败（续推会把回合吊活到结算之后），构成防回归。
