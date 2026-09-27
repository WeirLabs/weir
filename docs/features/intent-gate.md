# 意图门（intent-gate）

> 一句关键词，助手自动进入对应工作模式——免去每次手工交代背景与规矩。

## 概述

用户提示词里出现配置好的意图关键词时，意图门在该步注入对应的上下文（工作模式指令或技能指针），让助手立刻"进入状态"。`think` 类意图不注入内容，而是直接提升当次请求的推理档位。意图表是在线可编辑的配置，可按团队习惯扩展。

## 用户可见行为

- 提示词含意图关键词（如 "deep work"/"深度工作"）→ 助手自动加载对应工作模式（注入为英文模板指令）。
- **可选语义分类**（`classifier: 'llm'`）：正则未命中时，分类器用一次 sidecar 调用按语义映射到意图表（无关键词的说法也能命中）；分类结果如同关键词命中一样生效。`'jev'` 模式为实验功能、默认关闭。
- 语义分类 **fail-open**：分类器出错/超时/答非所问时按"未命中"处理，提示词原样通过，回落原因记录为审计事件；同一提示词每会话只分类一次（缓存）。
- 同一意图在会话内首次命中注入完整载荷；再次命中只注入简短提醒（不重复刷屏）。
- 关键词出现在代码块或引用区内时**不触发**（讨论关键词本身不会误启动模式）。
- 提示词含 `think` 关键词 → 当次请求以更高推理档位发出，消息内容不变。
- 未命中任何关键词时，提示词原样通过，零干预。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `intents` | 内置意图表 | 意图条目 `{ id, matchers, injection }`，可扩展；可选 `summary` 覆盖语义目录描述 |
| `disabled` | `[]` | 按 id 停用某些意图 |
| `classifier` | `'regex'` | 分类器前端：`'regex'`（纯正则，零成本）/ `'llm'`（sidecar 语义分类）/ `'jev'`（实验，默认关闭） |
| `classifierProvider` / `classifierModel` | 会话路由 | llm 模式 sidecar 路由覆盖 |
| `classifierTimeoutMs` | `1500` | 语义分类超时，超时即 fail-open |
| `jev.*` | — | jev 模式连接参数（`endpoint`/`model`/`apiKeyEnv` 环境变量名取密钥，密钥永不入配置） |

均为 volatile config：在线编辑即刻生效，无需重装 bundle。每次触发注入与每次分类决策都经**冷读安全审计通道**记录（`src/shared/audit.js`：cordis 运行时事件 + `<会话cwd>/.orrery/audit.jsonl` 磁盘双写）——会话日志不写入自定义事件类型（本运行时冷读拒绝未知类型，详见 AGENTS.md §3.6）。

## 设计细节

- 模块：`orrery-harness/intent-gate`。
- 两个挂载点：`agent/pre-step` 瀑布——对新鲜用户提示词做关键词匹配并追加注入消息；`agent/request` 瀑布——`think` 类意图改写当次请求的 `reasoningEffort`。
- 匹配前剔除代码围栏与引用区域，避免误触发。
- 武装纪律（arming）：每意图每会话全量注入至多一次，重复命中降级为短提醒；新用户消息不影响已武装状态。
- 分类器三模式（`src/intent-gate/classifier.js`）：regex 模式不建分类器（零成本短路）；llm 模式经 `ctx.llm.stream` sidecar（system 列意图枚举、maxTokens 16、temperature 0、路由默认会话路由可覆盖、收集 text chunk 取首个表中 id）；jev 模式经 HTTPS POST 决策适配器（密钥经环境变量名间接引用）。统一超时（AbortController）+ 会话级缓存（含负结果）+ fail-open。语义前端只在正则完全未命中时介入（短路），`think` 意图语义命中与关键词命中同效提档。

## 边界与失败语义

- 注入失败不会阻断原始提示词——意图门是纯增量，无命中即零成本通过。
- 配置中的意图表损坏时按防御式读取回落到默认表。
- 语义分类的任何失败（无路由/超时/流错误/未知回答/jev 未配置）**保证**按未命中处理并记录回落原因，绝不阻断提示词。

## 测试

- 单元测试：`test/` 覆盖匹配（含代码区豁免）、武装/提醒降级、推理提档、配置热更；`test/intent-classifier.test.js` 覆盖三模式分派、正则短路、语义命中、unknown-answer 拒绝、超时/故障 fail-open、缓存、jev 适配、挂载层注入与审计。
- 集成测试：`deepwork` 场景——关键词命中注入指令且 `orrery/intent-hit` 审计经 cordis 通道入 trace；`semantic` 场景——无关键词提示词经 llm 模式语义命中注入且 `orrery/intent-classify` 审计在场。
