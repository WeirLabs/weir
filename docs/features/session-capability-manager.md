# 会话能力管理器（Skill/MCP）

> 会话级的 Skill/MCP 选择与持久化：你能清楚地区分「已安装」「本会话启用」「以后新会话默认启用」，未选中的能力对模型与你都不可用。

## 概述

本特性把 Orrery 会话的 Skill 与 MCP 配置收敛为一份**显式的已选集合**：编辑先进入草稿，确认（Apply）后才生效并持久化；持久化由 Orrery 自管的带锁侧文件承担，不依赖宿主 storage 的跨进程保证。Skill 侧保持官方形状（宿主注册表 + stock `tool-skill`），MCP 侧由 Orrery 作为唯一挂载入口（managed/unmanaged 区分）。

当前实施进度：**持久化存储层（带锁侧文件）与 Skill 侧「库存、身份与选择 provider」已落地**（含组合迁移与内置 Skill 迁移检查）；Apply 事务、管理器界面等随 OpenSpec 变更 `session-capability-manager` 的任务组逐组交付，本文同步补全。

## 用户可见行为

- **可见性变化（自选择 provider 落地起）**：Orrery 会话只看到**已选** Skill；未选中的第三方 Skill 不再自动出现在模型目录、`skill` 加载与 slash 列表中。选择记录尚不存在的会话看到空目录与可见的状态提示（fail closed，绝不回退为全量发现）；工作区默认值、管理器界面与 Apply 流程交付后，选择集合由用户显式编辑产生。

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

### 库存、身份与选择 provider

Skill 侧保持**官方形状**：`skills` 注册表留在宿主层，Orrery 在预设挂载内经 `ctx.skills.registerProvider` 登记**选择 provider** 为预设层唯一 provider，预设继续挂载 stock `tool-skill` 作为 catalog 与 loader。所有 stock 消费者（模型目录、`skill` 加载、`/name` 手势、`skills/list`）与 Orrery 消费者因此自动经过同一份选择视图，无需逐个改造。

- **身份模型**（[skill-identity.js](<../../plugins/orrery-harness/src/capabilities/skill-identity.js>)）：scope（project／user／custom／Orrery 内置）× 根路径 × 名称 × provenance。无 provenance 的本地项用本机 opaque identity 并标记**不可自动移植**；content digest 标识版本、不构成名称授权；发现顺序（rank）不构成授权。
- **自有原始枚举**（[skill-inventory.js](<../../plugins/orrery-harness/src/capabilities/skill-inventory.js>)）：provider 显式重复实现宿主目录解析（已接受的代价），project／user／custom／bundled 各根独立枚举，rank 与 source 标签与宿主 `dsh-skill-filesystem` 语义一致；被遮蔽的同名候选**并列保留**（不丢弃），frontmatter 不可解析的条目保留为 unparsed，根不可读时保留 last-good 并以 `complete: false` 标注为部分结果，绝不伪造完整。frontmatter 解析器是手写严格子集 YAML（[frontmatter.js](<../../plugins/orrery-harness/src/capabilities/frontmatter.js>)，零新增依赖），超子集语法一律报解析错误而不是猜。
- **按身份精确加载**：只在 Orrery 自有清单内按候选身份加载，同名未选项不替代、不按显示名猜测；**软化范围**：宿主 `ctx.skills.get` 仍只按名称解析，精确性只在 Orrery 清单内成立。多个选中身份同名时呈现冲突、须用户显式解冲突，Apply 不任意取胜者。
- **挂载不抛出**：挂载路径只做同步、不会失败的登记（挂载抛错会让整个预设 broken、所有会话无法创建）；读取／解析失败 fail closed 为「空选择 + 可见错误状态」（`skillSelectionFor(ctx)` 可读出状态供管理器与 Badge 显示原因）。Apply 被接受后调用 `control.invalidate()`（带重入闸门：N 次连续失效与同步 raw→selected 回波只进入一次重枚举，在途枚举不得重发已被撤销的选择）。
- **组合要求**：宿主层 `skill-filesystem` 与 `tool-skill` 由 Orrery patch 行显式 `disabled: true`（宿主行不禁用时，宿主 fs 会把工作区 Skill 注入全局层、宿主 tool-skill 会删除预设模型目录）；预设自有的 `skill-filesystem` 行及其 `customSkillDirs` 已移除（其候选会漏进同一预设层）。宿主内置 Skill provider（如 office）不经 `skill-filesystem`，其条目由 [skill-office-adapter.js](<../../plugins/orrery-harness/src/capabilities/skill-office-adapter.js>) 纳入 Orrery 枚举与选择，未选项以同名候选遮蔽为不可模型调用、不可用户调用（`!m!u`），加载返回显式不可用错误。
- **内置 Skill 迁移**：bundle 的 `skills` 目录由 provider 枚举并标注为 **Orrery 内置**（不沿用宿主 `source:"bundled"` 与 bundled 根 rank 600）；首次运行迁移检查核对 10 个内置 Skill 均被发现、名称／来源标签／rank 与原 `customSkillDirs`（custom／rank 300）语义等价，不等价时 fail closed 并显示原因。`skills/` 目录字节不变。

## 边界与失败语义

- 存储单元损坏、版本未知或撕裂（digest 不符）：fail closed，返回 `unreadable`，保留原文件等待人工处置，绝不自动覆盖或删除。
- 锁被存活 owner 持有、owner 身份无法确认（外主机）、锁文件不可读：提交返回 `locked` 及具体原因，不写任何字节。
- 回收被中断（`.recover` 残留）：单元保持锁定并显示手动恢复入口，不自动清除他人残留。
- 不支持的平台或 `profileContext` 缺失：所有单元 unsupported，零写入。

## 测试

- 单元测试：`plugins/orrery-harness/test/capability-store.test.js`（16 例：路径解析与隔离、单元布局、fail-closed 解码、CAS 与幂等回执、锁获取／回收／手动恢复、平台桩零写入、代次指针原子切换）。
- 多进程与故障注入：`plugins/orrery-harness/test/capability-store-race.test.js`（真实子进程：两进程同 revision 恰一胜、两回收者竞争已死锁恰一个新 owner 且活锁零移除、SIGKILL 发布点循环只见完整旧/新记录）。
- 集成测试：`plugins/orrery-test-harness` 的 `capstore` 场景——探针分别在宿主层与 isolated `cordis:group` 内读取 `profileContext` 并经真实 store 往返一条选择记录，证明预设 realm 结构内存储根可解析（任务 2.1）。
- 单元测试（库存与身份）：`skill-identity.test.js`、`skill-inventory.test.js`（含宿主 0.2.0-rc.2 解析器生成的兼容性 fixture 逐文件比对，宿主漂移即红；生成器 `test/helpers/generate-host-reference.js`）、`skill-selection-provider.test.js`（精确加载、冲突呈现、挂载不抛出、invalidate 反例与重入闸门）、`skill-office-adapter.test.js`、`skill-composition.test.js`（patch 静态检查）。
- 集成测试：`plugins/orrery-test-harness` 的 `skill-composition` 场景族（OFF／LEAK／HOST／office 四组合）：只有 OFF 形态下未选 Skill 不出现在模型目录、`skill` 加载、预设内消费者与 slash 列表；未选 office Skill 被同名遮蔽；预设不进入 `broken`。
