# 意图门（intent-gate）

> 一句关键词，助手自动进入对应工作模式——免去每次手工交代背景与规矩。

## 概述

用户提示词里出现配置好的意图关键词时，意图门在该步注入对应的上下文（工作模式指令或技能指针），让助手立刻"进入状态"。`think` 类意图不注入内容，而是直接提升当次请求的推理档位。意图表是在线可编辑的配置，可按团队习惯扩展。

## 用户可见行为

- 提示词含意图关键词（如 "deep work"/"深度工作"）→ 助手自动加载对应工作模式（注入为英文模板指令）。
- **可选语义分类**（`classifier: 'llm'`）：正则未命中时，分类器用一次 sidecar 调用按语义映射到意图表（无关键词的说法也能命中）；分类结果如同关键词命中一样生效。`'jev'` 模式为实验功能、默认关闭。
- 语义分类 **fail-open**：分类器出错/超时/答非所问时按"未命中"处理，提示词原样通过，回落原因记录为审计事件；同一提示词每会话只分类一次（缓存）。
- 同一意图在会话内首次命中注入完整载荷；再次命中只注入简短提醒（不重复刷屏）。
- `writing` 意图：写文档类请求（中文「帮我写一份部署说明」、英文 `write a deployment guide` / `write a design doc` 等）注入「按成品交付」的英文指令——交付物不写实现与思考过程、不加"我将要/这里展示"式说明文案、改动不留痕；**每一次**新的写文档请求都会重新注入完整指令，不是仅会话首次。
- 关键词出现在代码块或引用区内时**不触发**（讨论关键词本身不会误启动模式）。
- `mcp-server-setup` 意图：真实的中英文 MCP 安装/添加/配置请求注入同名英文 Skill 指针；调用或排查已有 server、一般讨论、否定句、引用与未闭合代码示例均不触发。意图本身不执行进程、网络、配置、credential 或选择修改。
- 提示词含 `think` 关键词 → 当次请求以更高推理档位发出，消息内容不变。
- 未命中任何关键词时，提示词原样通过，零干预。
- 运行时系统消息（子代理结算通知、自动续推提示等）即使正文含关键词也**不触发**模式切换——只有真实用户提示词参与分类。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `intents` | 内置意图表 | 意图条目 `{ id, matchers, injection }`，可扩展；可选 `suppressedMatchers` 显式排除否定/讨论语境（同时从 semantic catalog 剔除）；可选 `summary` 覆盖语义目录中该意图的一行描述——llm 模式下这行文本原样进入分类器 system 目录（未配置时按注入类型派生，`message` 类回落为 `custom intent`） |
| `disabled` | `[]` | 按 id 停用某些意图 |
| `classifier` | `'regex'` | 分类器前端：`'regex'`（纯正则，零成本）/ `'llm'`（sidecar 语义分类）/ `'jev'`（实验，默认关闭） |
| `classifierProvider` / `classifierModel` | 会话路由 | llm 模式 sidecar 路由覆盖 |
| `classifierTimeoutMs` | `1500` | 语义分类超时，超时即 fail-open |
| `jev.*` | — | jev 模式连接参数（`endpoint`/`model`/`apiKeyEnv` 环境变量名取密钥，密钥永不入配置） |

均为 volatile config：在线编辑即刻生效，无需重装 bundle。每次触发注入与每次分类决策都经**冷读安全审计通道**记录（`src/shared/audit.js`：cordis 运行时事件 + `<会话cwd>/.weir/audit.jsonl` 磁盘双写）——会话日志不写入自定义事件类型（本运行时冷读拒绝未知类型，详见 AGENTS.md §3.6）。

## 设计细节

- 模块：`weir-harness/intent-gate`。
- 两个挂载点：`agent/pre-step` 瀑布——对新鲜用户提示词做关键词匹配并追加注入消息；`agent/request` 瀑布——`think` 类意图改写当次请求的 `reasoningEffort`。
- 匹配前剔除代码围栏与引用区域，避免误触发。
- 武装纪律（arming）：每意图每会话全量注入至多一次，重复命中降级为短提醒；新用户消息不影响已武装状态。
- 写作指令（`writing` 意图）用 `message` 注入：模板原文作为一条用户消息原样追加，`oncePerSession: false` 即不武装、不进武装台账。理由是写作纪律必须在每一次落笔时都在场，而且要能穿过压缩——上下文被压成摘要后，下一次写文档请求会把完整指令重新带回；因此审计里每次命中都记 `first: true`，这是非武装意图的预期形状，不是重复计数。
- **指针资格过滤**（会话能力管理器）：Skill 指针与提醒在注入前按统一消费者视图判定「本会话已选 + 可用 + 可模型调用」，且只接受显式 `verdict.invocable === true`；缺失 provider/view、构造失败、未选择或不可调用时被抑制，**不注入任何替代文本**、首次命中保持 unarmed（后续可用时仍注入完整初始指针）、不撤回历史注入；审计只记录「未注入 + 原因」。非 Skill 意图行为不变。
- 分类器三模式（`src/intent-gate/classifier.js`）：regex 模式不建分类器（零成本短路）；llm 模式经 `ctx.llm.stream` sidecar（system 列意图枚举、maxTokens 16、temperature 0、路由默认会话路由可覆盖、收集 text chunk 取首个表中 id）；jev 模式经 HTTPS POST 决策适配器（密钥经环境变量名间接引用）。统一超时（AbortController）+ 会话级缓存（含负结果）+ fail-open。语义前端只在正则完全未命中时介入（短路），`think` 意图语义命中与关键词命中同效提档。路由覆盖**每次分类时惰性解析**（`resolveRouteOverride`）：rc.2 cordis 在 apply 批次结束后才激活 `reflect.provide` 的服务提供方，apply 期 `ctx.get('weirSettings')` 永远缺席，快照必然为空——惰性解析让晚到的覆盖同样生效。
- `mcp-server-setup` 的 `suppressedMatchers` 不只过滤正则结果，也从当次 semantic catalog 删除该意图，避免语义分类把明确的否定或一般讨论重新命中；quoted/code-fenced/unclosed example 在匹配前剔除。该 Skill 的资格与其他指针共用显式 `invocable===true` 规则。

## 边界与失败语义

- 注入失败不会阻断原始提示词——意图门是纯增量，无命中即零成本通过。
- 被资格过滤抑制的指针是**显式静默**（审计含原因），与「无命中」区分：它不推进武装台账，也不算注入失败。
- 配置中的意图表损坏时按防御式读取回落到默认表。
- 语义分类的任何失败（无路由/超时/流错误/未知回答/jev 未配置）**保证**按未命中处理并记录回落原因，绝不阻断提示词。
- 只分类真实用户提示词：预步批次中只有 `source.kind === 'user'` 的消息参与匹配（DSH 消息契约，`user-rpc` 的 kind 同为 `user`）；运行时注入消息——监督结算通知（`subagent-settled`）、本门自身通知（`weir-intent-gate`）、todo/压缩续推（`weir-todo-driver`/`weir-context-guard`）等——一律跳过，与语义分类缓存互不干扰。
- `writing` 意图的已知误判形状：提示词里同时出现写作动词与交付物名词（如「更新这份报告里的数字」）就会命中，即使真实意图是改代码而非写文档；不需要时在 intent-gate 行配置里 `disabled: ['writing']` 停用即可。

## 测试

- 单元测试：`test/` 覆盖匹配（含代码区豁免）、武装/提醒降级、推理提档、配置热更、非用户 source 豁免（监督结算通知/自身通知/无 source 消息）与越过注入扫描真实提示词、`writing` 意图（英文模板无 CJK 且五条纪律齐备、中英文命中与逐次重新注入、审计每次 `first: true`、仅读文档与代码块内关键词两个负例）；`test/intent-classifier.test.js` 覆盖三模式分派、正则短路、语义命中、unknown-answer 拒绝、超时/故障 fail-open、缓存、jev 适配、挂载层注入与审计，以及路由覆盖的惰性解析（覆盖晚到仍生效），另含 `writing` 的 `summary` 原样进入语义目录；`test/intent-gate.test.js` 另有 apply 后服务才可见时覆盖仍到达分类器的插件级用例（rc.2 激活时序回归）。
- MCP setup 专项：`test/intent-gate.test.js` 覆盖中英文安装请求、否定/一般讨论/已有 server 使用、quoted/unclosed example、once/reminder、provider 缺失/异常、非显式 invocable 抑制后恢复，以及冷安全审计；`test/intent-classifier.test.js` 另证 semantic catalog 不会复活被抑制的安装意图。
- 集成测试：`deepwork` 场景——关键词命中注入指令且 `weir/intent-hit` 审计经 cordis 通道入 trace；`semantic` 场景——无关键词提示词经 llm 模式语义命中注入且 `weir/intent-classify` 审计在场。
