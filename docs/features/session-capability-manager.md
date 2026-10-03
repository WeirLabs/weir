# 会话能力管理器（Skill/MCP）

> 会话级的 Skill/MCP 选择与持久化：你能清楚地区分「已安装」「本会话启用」「以后新会话默认启用」，未选中的能力对模型与你都不可用。

## 概述

本特性把 Orrery 会话的 Skill 与 MCP 配置收敛为一份**显式的已选集合**：编辑先进入草稿，确认（Apply）后才生效并持久化；持久化由 Orrery 自管的带锁侧文件承担，不依赖宿主 storage 的跨进程保证。Skill 侧保持官方形状（宿主注册表 + stock `tool-skill`），MCP 侧由 Orrery 作为唯一挂载入口（managed/unmanaged 区分）。

当前实施进度：**持久化存储层（带锁侧文件）已落地**；选择 provider、Apply 事务、管理器界面等随 OpenSpec 变更 `session-capability-manager` 的任务组逐组交付，本文同步补全。

## 用户可见行为

- 管理器界面与 Apply 流程尚未交付（实施中）。当前没有新的用户可见表面。

## 配置

本特性尚无配置项（实施中的模块将以 volatile config 暴露，在线编辑、无需重挂载）。

## 设计细节

### 持久化与锁

已接受的会话选择、内容代次指针等状态保存在 Orrery 自有目录：
`join(profileContext.home, 'orrery', 'profiles', profileContext.name, 'capabilities')`，
经受支持的路径解析得到（`ctx.get('profileContext')`，不静态 import `@deepseek-ai/*`）。
`profileContext` 不可得时所有存储单元标为 unsupported 并显式报错，**不回退**到 cwd 或用户工作区；
正式与测试 profile 因此天然隔离（各自 DSH home 下各自 profile 名）。

- **不依赖宿主 storage 的持久性保证，只依赖文件系统 rename／fsync 语义。** 每个存储单元（会话选择、content pins、工作区默认值、预设库、分发记录、MCP 注册表）是独立文件与独立 revision，互不覆盖；记录与锁都带 `schemaVersion`，未知版本 fail closed（拒绝读写、不迁移、不改写、不删除）。
- **原子提交**：选择与其回执在**同一文件的同一次原子提交**中落盘——写临时文件、fsync、rename、目录 fsync；在持锁区间内做 expected-revision CAS。同 requestId 同 payload 重放返回原回执（duplicate），同 ID 异 payload 拒绝（request-conflict）。进程内 mutex 只作本进程串行化，不当跨进程保障。
- **锁协议**：每单元一把独占锁（owner token、进程标识、启动标识、租约时间），获取走「写私有候选 `<file>.<token>.cand` → fsync → `link(cand, file)`（`EEXIST` 即竞争失败）→ 删候选」。刻意**不用**「`wx` 先建后写」：第一轮 G0 spike 实测该写法在崩溃点留下 0 字节锁文件，单元从此永久卡住——这是本设计绕开宿主方案、自管锁文件的直接动因（见证据目录 C-1.10）。`link` 遇 `ENOENT`（候选被持锁者的孤立清理删掉）视为本轮失败并重试。
- **陈旧锁回收**：必须先同时满足「租约过期」且「owner 已不存活」（pid + 启动标识双重核对），不得仅凭超时抢占；过期租约 + 存活 owner 不回收。回收经 `<unit>.lock.recover`（同样以 `link` 发布）串行化，持有后重读锁文件、核对 owner token 仍等于所观察的已死 owner 才 rename，否则中止。持锁期间崩溃留下的本单元孤立 `.tmp`／`.cand` 在下一次持锁时清理；已死回收者遗留的 `.recover` 不自动清除，提供手动恢复入口（`inspect`/`clear`）。
- **内容代次发布**：`distribution/<scope>/active.json` 指针在同一文件系统内以 rename 切换，指针 + provenance + 操作回执在同一次原子发布中提交；任何中断点之后读者只见完整旧代次或完整新代次。
- **平台矩阵**：只在 rename/fsync/link 语义经实测（1.10 矩阵）标为 supported 的平台启用写入（当前 `darwin`）；其余平台写操作标为 unsupported 并显式报错，**绝不**「先删后拷」。

## 边界与失败语义

- 存储单元损坏、版本未知或撕裂（digest 不符）：fail closed，返回 `unreadable`，保留原文件等待人工处置，绝不自动覆盖或删除。
- 锁被存活 owner 持有、owner 身份无法确认（外主机）、锁文件不可读：提交返回 `locked` 及具体原因，不写任何字节。
- 回收被中断（`.recover` 残留）：单元保持锁定并显示手动恢复入口，不自动清除他人残留。
- 不支持的平台或 `profileContext` 缺失：所有单元 unsupported，零写入。

## 测试

- 单元测试：`plugins/orrery-harness/test/capability-store.test.js`（16 例：路径解析与隔离、单元布局、fail-closed 解码、CAS 与幂等回执、锁获取／回收／手动恢复、平台桩零写入、代次指针原子切换）。
- 多进程与故障注入：`plugins/orrery-harness/test/capability-store-race.test.js`（真实子进程：两进程同 revision 恰一胜、两回收者竞争已死锁恰一个新 owner 且活锁零移除、SIGKILL 发布点循环只见完整旧/新记录）。
- 集成测试：`plugins/orrery-test-harness` 的 `capstore` 场景——探针分别在宿主层与 isolated `cordis:group` 内读取 `profileContext` 并经真实 store 往返一条选择记录，证明预设 realm 结构内存储根可解析（任务 2.1）。
