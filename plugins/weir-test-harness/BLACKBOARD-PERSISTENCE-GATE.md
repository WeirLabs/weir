# 黑板持久化：实施前运行时闸门

本提交只有隔离测试，不实现黑板持久化，也不代表 OpenSpec `session-blackboard-persistence` 验收完成。

## 已实测

安装版 CLI 和 App 版本均为 `0.2.0-rc.2`。运行：

```sh
WEIR_IT_DSH_EXEC='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  node /absolute/path/to/pnpm.mjs --filter weir-test-harness run test:integration blackboard-persistence
```

使用仓库既有 driver 的 lane-local `DSH_HOME`；不读取或变更 desktop profile。四次 headless 启动：

1. 根 Agent 的 `agent/created` 中等待 `ctx.sessions.flush(agent.session)`，返回 `true`；规范 `session.v4.jsonl.zstd` 已存在，解压首帧的头部 id/cwd 与 live Session 一致。
2. 创建 `_bb` 邻居后退出，再以同一个 Session ID 冷启动；冷读成功、`sessionPersistence.list()` 仍列举该 Session。
3. 新进程创建根 Session 并 flush；核实绝对日志路径、隔离 home 和头部身份后保存日志字节，暂时仅 unlink 日志，不触碰 `session.lock` 或 `_bb`。根 Session 继续存活，持有者停在异步创建监听器等待观察者。
4. 第二进程观察该根 Session：连续两次 `sessionPersistence.stat(id)` 均返回 `undefined`，`list()` 不列举，自己的 `sessions.get(id)` 不存在；`sessionPersistence.open(id, 'write')` 抛 `SessionPersistenceNotFoundError`，而不是 `SessionAlreadyOwnedError`。观察者确认持有进程 PID 存活；持有者确认观察结束后根 Session 仍 live、锁文件字节不变，并在 finally 恢复原日志。

场景 8/8 断言通过。这里最后四条是**设计阻塞的复现**，不是孤儿清理安全性的通过。记录器保留两个证据 JSON，断言可在装置单测里离线重放。该 fixture 不包含真实用户数据。

## 阻塞：安全孤儿清理缺少跨进程存活裁决

批准设计 D2 / task 4.2 要求日志单删后的对账既最终清理孤儿，又避开仍存活的根 Session。当前可用公共 API 和两次文件核对无法区分：

- 根 Session 已终止、只剩 `_bb` 和空 `session.lock`；
- 另一宿主仍持有 live 根 Session，但日志文件被单独删除。

安装版 JSONL 后端源码核对与实测相符：write-open 先 `findLog`，不存在即抛 NotFound，然后才可能 `acquireLease`；stat/list 同样先查日志。`session.lock` 的权威是内核 flock，不是文件内容；POSIX 锁文件是持久的空文件，Windows 使用命名内核信号量。重复 stat 不能把文件缺席升级为「没有活跃持有者」。

Weir 专属锁可以协调 Weir 自己的事务，却不能覆盖 Weir 未安装/已停用时的 DSH root 持有者；仅检查本进程 registry 同样不足。未经许可直接操作宿主锁、静态导入宿主原生依赖、猜测等待时间或忽略其他宿主均不是合格解决方案。

## 需要上层裁决

首选：宿主提供可用于孤儿 Session 的权威 lease/lifecycle 查询或删除/迁移围栏，插件只经公开 ctx 服务消费，并增加竞争测试。

若本次不能改宿主，需要明确修订清理契约，例如保留日志单删的 `_bb`，由用户确认离线清理；或限制自动对账为已证明其他宿主不能存活/迁移的独占维护时段。两者都与当前自动最终清理要求不同，不能由实现者默默采用。

在裁决前停止产品开发，避免提交一个可删掉 live Session 黑板的清理器。当前产品仍是原内存黑板；未更新用户文档、未勾选 OpenSpec tasks、未宣称持久化可用。

## 尚未验收

任务 1.1 只有 flush/header、邻居共存冷读/list 实证；「未物化逻辑 Session 不建旁板」尚无产品实现及测试，所以不能整项勾选。1.2–5.2 均未完成：定位/迁移、原子存储、工具/remote、字段与计数恢复、nested root、卸载重装、归档/删除、文档与完整回归留待阻塞解除后继续。

## 本切片检查结果

- `pnpm --filter weir-harness run check`：退出码 0。
- `pnpm --filter weir-harness test`：退出码 0；2514 通过、7 平台/环境 skip、0 失败（2521 总数）。
- `pnpm --filter weir-test-harness test`：退出码 0；261/261。初次运行曾因新场景缺 `observe` 不通过，补齐后完整重跑通过。
- `pnpm --filter weir-test-harness run test:integration blackboard-persistence`：安装版 CLI，退出码 0；8/8，包含上述阻塞复现。
- 未运行无过滤的完整集成套件；本次是按 STOP WHEN 条件停下的兼容性闸门，不满足 task 5.1/5.2。
