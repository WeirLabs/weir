# 共享 runtime 消息助手（runtime-message-helpers）

> 消息纪律硬契约由模块承载：UserMessage 构造、genuine-user 分类、settings overlay、注入失败 warn 语义各只有一份实现。

## 概述

Weir 的事件驱动插件（intent-gate / todo-driver / context-guard）曾各自重复实现同一组 runtime 适配惯用法，且漂移已经落地：intent-gate 私有重写了共享 UserMessage 构造器（与 `src/shared/user-message.js` 逐字节等价），genuine-user 判定以两种形态散落两处，settings overlay 合并重复三次，warn-吞掉注入包装重复五处。AGENTS.md §3.4 这类硬契约靠各插件自觉维持。

本特性把四类惯用法收进单一深模块 `src/shared/runtime-messages.js`——`src/shared/` 的接缝位置已被 `audit.js`（§3.6）与 `user-message.js`（§3.4）两次成功抽取证明。**无任何用户可见行为变化**：三个插件的外部可观察行为逐字节保持，五个 warn 日志措辞原样。

## 用户可见行为

- 无（纯内部重构）。唯一可指认的差异是日志行数：重复实现删除后行为不变、代码变少。

## 配置

本特性无配置项（模块被三个插件的配置复用，自身不新增键）。

## 设计细节

- `isGenuineUserMessage(messageOrEvent)`：genuine-user 分类唯一实现。消息对象读 `source?.kind === 'user'`；会话事件严格以 `type === 'user/message'` 门控后读 `data?.source?.kind === 'user'`；其他事件类型一律 false（即使 data 长得像用户消息）。**只判 source.kind**：role 过滤是各插件批内扫描语义的一部分，留在调用方。注入源豁免矩阵（settlement notice、三个插件自己的注入等）的完整用例收敛到模块单测唯一一份，插件级测试各保留至少一条行为断言。
- `overlayConfig(ctx, section, config, options)`：settings overlay 合并唯一实现。`options.defaults` 垫底（todo-driver 的 `DEFAULTS`、context-guard 的 `PRESSURE_DEFAULTS`）；`weirSettings` 服务对应 section 覆盖行内 config；服务缺席或 section 非对象为 no-op。intent-gate 的 `jevEndpoint`/`jevModel`/`jevApiKeyEnv` 平铺键经声明式 `options.nestKeys` 映射进嵌套 `config.jev`（undefined 不覆盖、与既有 `config.jev` 合并、命中键从平铺合并剔除）——共享模块不知晓 intent-gate 的 schema，映射由调用方声明，该特例不会泄漏到其他插件。
- `injectOrWarn(ctx, message, fn)`：注入失败语义唯一实现。`fn()` 抛错时以 `ctx.logger.warn` 记录并吞掉（返回 undefined），绝不打断当前 turn；**warn 前缀由调用方逐字传入**（五处既有措辞被插件测试锚定），模块只追加 `: ${error?.message ?? error}`。
- intent-gate 的私有 `injectionMessage` 已删除，一律 `userTextMessage(body, 'weir-intent-gate')`（§3.4 从纪律变为结构）；intent-gate 补齐了与兄弟插件对称的 disposer（清 `armed`/`effortTurns` 两个内存 Map，无外部副作用）。
- 硬契约边界：模块纯 ESM、ctx-only、无静态 `@deepseek-ai/*` import（§3.2），**绝无 `session.append` 路径**（§3.6 冷读红线；审计仍仅走 `src/shared/audit.js`）。三个插件的纯核心（`matcher.js`/`pressure.js`/`state-machine.js`）不在本特性范围、未触碰。

## 边界与失败语义

- `isGenuineUserMessage` 对非对象输入、非 `user/message` 事件一律 false——宁漏勿错，注入消息永不会被误判为真实用户输入。
- `overlayConfig` 不突变入参（返回新对象）；`weirSettings` 缺席时行内 config 原样生效。
- `injectOrWarn` 在 `ctx.logger` 缺席时也不抛（可选链），注入失败静默度永远不超过原逐插件实现。

## 测试

- 单元测试：`test/runtime-messages.test.js`（26 用例：双形态 × 注入源豁免矩阵全集、jev `nestKeys` 全分支——单键/多键/与既有 `config.jev` 合并/无 jev 键/undefined 不覆盖、`injectOrWarn` 抛错吞掉并 warn / 成功无 warn / 透传返回值）。`test/intent-gate.test.js` 与 `test/todo-driver.test.js` 各删去两行重复矩阵行、保留插件级行为断言。
- 集成测试：全量 12 场景验收（75/75）覆盖 bundle 重启用路径，验证新 disposer 无副作用。
