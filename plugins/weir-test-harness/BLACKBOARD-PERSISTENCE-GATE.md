# 黑板持久化：实施前运行时闸门

首个提交 `6bfe460` 只有隔离测试；此处保存历史闸门证据，不代表 OpenSpec `session-blackboard-persistence` 验收完成。

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

## 原阻塞（已由用户裁决解决）：缺少跨进程存活裁决

原设计 D2 / task 4.2 曾要求日志单删后的对账既最终清理孤儿，又避开仍存活的根 Session。当前可用公共 API 和两次文件核对无法区分：

- 根 Session 已终止、只剩 `_bb` 和空 `session.lock`；
- 另一宿主仍持有 live 根 Session，但日志文件被单独删除。

安装版 JSONL 后端源码核对与实测相符：write-open 先 `findLog`，不存在即抛 NotFound，然后才可能 `acquireLease`；stat/list 同样先查日志。`session.lock` 的权威是内核 flock，不是文件内容；POSIX 锁文件是持久的空文件，Windows 使用命名内核信号量。重复 stat 不能把文件缺席升级为「没有活跃持有者」。

Weir 专属锁可以协调 Weir 自己的事务，却不能覆盖 Weir 未安装/已停用时的 DSH root 持有者；仅检查本进程 registry 同样不足。未经许可直接操作宿主锁、静态导入宿主原生依赖、猜测等待时间或忽略其他宿主均不是合格解决方案。

## 用户裁决（恢复实施）

用户已明确选择 SAFE Weir-only 策略，并修订 OpenSpec 四份材料：整目录删除时 `_bb` 自然消失；仅日志缺失永远不自动 GC，保留原字节，用户确认所有宿主离线后人工清理。不得操作宿主锁。该决策解除原阻塞，持久化实现继续进行。上述跨进程探针成为「不能由日志缺失推断死亡」的回归证据。

以下检查结果只属于首个探针切片；最终实现验收另行记录。

## 本切片检查结果

- `pnpm --filter weir-harness run check`：退出码 0。
- `pnpm --filter weir-harness test`：退出码 0；2514 通过、7 平台/环境 skip、0 失败（2521 总数）。
- `pnpm --filter weir-test-harness test`：退出码 0；261/261。初次运行曾因新场景缺 `observe` 不通过，补齐后完整重跑通过。
- `pnpm --filter weir-test-harness run test:integration blackboard-persistence`：安装版 CLI，退出码 0；8/8，包含上述阻塞复现。
- 未运行无过滤的完整集成套件；本次是按 STOP WHEN 条件停下的兼容性闸门，不满足 task 5.1/5.2。

## 实现后的证据索引

以下为本 lane 的实现/验证入口，不代替主会话对 OpenSpec tasks 的勾选。用户裁决已解除原阻塞。

| Task | 证据 |
|---|---|
| 1.1 | [安装版场景](src/scenarios/blackboard-persistence.js)：flush 返回 true、物理头 id/cwd、同 ID 冷读/list、首个工具前空板、真实 pending Session 没有旁置文件 |
| 1.2 | [定位与存储](../weir-harness/src/blackboard/storage.js) + [真实文件单测](../weir-harness/test/blackboard/persistence.test.js)：错 id/cwd、穿越、歧义目录/编码、symlink、巨大版本号均拒绝；不碰宿主锁 |
| 1.3 | [迁移单测](../weir-harness/test/blackboard/persistence.test.js)：v4→v5、plain→zstd、冲突副本与未知 schema 保留；新文件确认发布后才移除旧 `_bb` |
| 1.4 | [用户文档](../../docs/features/blackboard.md)「持久文件、冷恢复与版本迁移」及 ZIP 边界 |
| 2.1 | [存储单测](../weir-harness/test/blackboard/persistence.test.js)：空板、schema/损坏/根身份拒绝、非空 summary 字符串往返、仅条目字段持久化 |
| 2.2 | [故障/进程单测](../weir-harness/test/blackboard/persistence.test.js)：创建/file fsync/rename 故障，目录 fsync 不确定结果复核、两个独立进程、SIGKILL、活 PID/旧 nonce 不可抢占 |
| 2.3 | [late-mount 单测](../weir-harness/test/blackboard/persistence.test.js)、[缺 profile 单测](../weir-harness/test/blackboard/index.test.js)、[首次访问前安装版断言](src/blackboard-cold-probe.js) |
| 2.4 | [候选事务与串行仲裁](../weir-harness/src/blackboard/durable.js) + [暂停 fsync/TTL/disposal/首次 admission 单测](../weir-harness/test/blackboard/persistence.test.js)；计数与晋升由两进程安装版恢复 |
| 2.5 | [用户文档](../../docs/features/blackboard.md)明确 durable/volatile 字段、原子发布、失败不回退内存 |
| 3.1 | [工具单测](../weir-harness/test/blackboard/index.test.js)：异步磁盘拒绝必须 await、缺 profile 明确失败；安装版真实模型工具写/read/mark；已运行静态检查 |
| 3.2 | [remote 合约单测](../weir-harness/test/blackboard/remote.test.js) + [冷恢复 remote 探针](src/blackboard-cold-probe.js)：全部 await、原 wire 形状、面板 read 不计数、写删/晋升只读和延迟失败 |
| 3.3 | [冷 parent 链探针](src/blackboard-cold-probe.js)：两层真实持久子 Session 的父句柄已关闭，沿头部恢复同一根；不建 child `_bb`；单测另钉 depth-zero fork 独立 |
| 3.4 | 未新增生产组合/注入行，沿用现有 provider/remote 导出与 realm；测试装置仅补真实 workspace archive provider。服务层安装版 remote 和贡献/挂载单测通过；未另做浏览器/HTTP 端点验收，不把直调探针冒充 GUI 404 验收 |
| 4.1 | [生命周期单测](../weir-harness/test/blackboard/persistence.test.js)：root disposal、晚挂载、重挂、旧宿主仍活但最后参与者离开后的跨进程交接；安装版真实 archive/unarchive 保留字节 |
| 4.2 | [原 live-orphan 探针](src/blackboard-persistence-probe.js)现在同时调用产品 storage，验证日志缺失拒绝且 `_bb` 字节不变；单测验证整目录删除不重建、v5 迁移有效日志保留 |
| 4.3 | [两阶段 runner](src/scenarios/blackboard-persistence.js)：同 ID 第二进程恢复；中间移除隔离 profile 的声明与两个安装 symlink、启动不含 Weir 的 `--dump-config`、恢复安装；旁置字节不变 |
| 4.4 | [特性文档](../../docs/features/blackboard.md)与 [README](../../README.md)已更新。CHANGELOG、主规格 Purpose 和 OpenSpec 勾选由主会话负责，本 lane 未修改这些文件 |
| 5.1 | 必需四条命令均有运行记录；完整 IT 曾达到 629/629、产品单测 2542 通过/7 平台 skip、装置 261/261。最终计数以终态报告为准 |
| 5.2 | 同 ID 重启、模拟重装、真实归档、目录删除/孤儿保留均由上述测试覆盖。离线人工清理另在 `test/offline-cleanup-demo-*` 临时合成目录演示：核对 schema/root ID/无日志/非 symlink，只删 `_bb` 并验证宿主锁 fixture 字节不变；该目录从未对应真实 Session，演示后整目录回收 |

### 重跑完整 IT 的环境

已有 Office control 场景要求显式传入 `WEIR_IT_NODE` 和 `WEIR_IT_OFFICE_CLI`；遗漏会使它缺少 `office-docx`，与黑板无关。本机有效值：

```sh
export WEIR_IT_NODE='/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
export WEIR_IT_OFFICE_CLI='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js'
export WEIR_IT_DSH_EXEC='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
export PATH="$(dirname "$WEIR_IT_NODE"):$PATH"
"$WEIR_IT_NODE" /Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs --filter weir-test-harness run test:integration
```

仅在隔离 fixture/profile 上使用；从未改变真实 desktop profile，也没有静态导入宿主包或新增 npm 依赖。

## 终态验证

- 静态检查：退出码 0。
- 产品单测：2551 总数，2544 通过、7 平台/环境 skip、0 失败，退出码 0。最后一次显式给 package script 的 PATH 前置 managed Node 目录。
- 装置单测：261/261，退出码 0。
- 完整安装版 IT：629/629，退出码 0；黑板持久化场景占 17 项，原黑板及晋升场景全部通过。
- 中途失败均未算通过：缺 Office runtime 路径、遗漏异步测试 await、把 child turn-boundary disposal 当永久终止导致订阅丢失，均定位修复并重跑；一次旧的重复单测运行被取消，一次无关 Edit Lock composition 测试长时间停滞被终止，最终整套单测正常通过。
- 验证边界：本次没有浏览器/HTTP 黑板端点验收（task 3.4 的条件性挂载需求未新增）；没有部署到 desktop；父会话仍需完成 task 4.4 中的 CHANGELOG/主规格更新及任务勾选。
