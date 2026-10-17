# 会话黑板（Session Blackboard）

> 会话内 Agent 协作的结构化知识交换所：子 Agent 的昂贵发现以可寻址、可仲裁、可计量的条目沉淀在板上，会话内全员复用，用户一键发起策展、把有价值的条目晋升进持久文档。

## 概述

子 Agent 不具备全局视野，无法判断一条信息值不值得缓存——缓存判定式（查找成本 × 查询频率 > 维护成本 × 漂移率）的四个变量里它只看得见"查找成本"。此前的出路是子 Agent 把发现写进结算报告的散文里，由父 Agent 读后人工 triage：父 Agent 上下文是全系统最贵的资源，且"查询频率"对谁都不可见。Retro 实证：单个工作会话 87 次工具调用中 48 次在重复勘探同一运行时布局（21 个包被重新发现）。

黑板把这个判断问题改造成基础设施问题：**发现即写**（子 Agent 只观测代价，不做全局判断）、**按需读取**（list 摘要层 + read 正文层，渐进披露物理化）、**仲裁写入**（申请→一次性令牌→TTL→超时释放→通知等待者，与 Edit Lock 同构）、**用量可计量**（read/subscribe 计数让"查询频率"第一次成为经验证据）、**晋升归用户**（Agent 不知道晋升的存在；用户在 UX 一键发起评估并逐项裁决）。

黑板按**持久根 Session ID** 独立保存；同一个 Session 重启或重装 Weir 后恢复，不同 Session 不共享。它是两层缓存架构中的 L1（会话内 staging + 横向共享），持久文档（`docs/spikes.md`、runtime map、AGENTS.md 指针）是 L2；L1→L2 的门只有一扇，钥匙只在用户手里。

当前实施进度：**三切片全部落地**——核心存储 + 写入权仲裁 + 模型工具面（六个工具）、Agent 写入契约与检索纪律注入、订阅通知端到端投递、插件自有 typert remote 数据通道、右侧侧边栏黑板面板（类型分组/过滤/搜索、申请→写入/删除全流程、令牌倒计时、竞争订阅、晋升评估按钮与「已晋升」徽标）、`blackboardWriteTokenTtlMinutes` 设置键（配置文件面，不在设置页渲染）、晋升评估全链路（按钮 → 注入 → 计数排序评估 → 逐项裁决 → 落盘 → 只读标记）。OpenSpec 变更 `session-blackboard` 交付完毕。

## 用户可见行为

- **同一会话可恢复**：重启 DSH 或卸载重装 Weir 后，重新打开同一个持久 Session，正文、摘要、读/订阅计数与晋升只读标记继续存在。新建另一个 Session 不是恢复旧黑板。

- **Fork 会话带上黑板快照**：Fork 一个新会话时，新会话的黑板以源会话持久根黑板的一次性快照开局（条目、read/subscribe 计数与晋升只读标记一并复制；写入权令牌与订阅属易失状态，不随 fork 转移）。快照之后两块板完全独立——源板后续变化不再传播到 fork，fork 上的修改也不回写源板。

- **黑板面板**：右侧侧边栏新增黑板面板，列出本会话全部条目（key + 类型 + 摘要），支持按类型分组/过滤、搜索，点开查看完整信息。面板有两条入口路径：向导页胶囊（带专属黑板图标，不再是占位 cube）与会话头部快捷按钮。
- **子 Agent 会话页显示父会话黑板**：在子 Agent（委派会话）的会话页打开黑板面板时，面板先把浏览会话 id 交给 `resolve` 解析出**会话根**，再绑定根会话的黑板——子 Agent 回合间或结束后，网关的 agent lookup 会拒绝 subagent 身份的会话（`owned by subagent routing`，此前面板显示「黑板不可用」），resolve 以裸 JSON 参数绕开该 lookup。绑定根黑板时列表顶部显示一条 muted 提示条「正在显示父会话的黑板。」；resolve 失败（桥缺失、通道不可用等）时回退浏览会话自身，保持原有行为。
- **会话头部快捷入口**：会话头部工具区（`conversation.session.header.utilities`，order 20，排在 Worktree 胶囊之后）有一个黑板胶囊按钮（描边徽章样式：图标 + 「黑板」文字，与 Worktree 胶囊视觉重量一致），点击直接打开/聚焦右侧栏黑板面板（`sidebarRight.openTab('weir-blackboard')`）；按钮无实时状态、无轮询，tooltip/aria-label 中英双语；shell 无右侧栏包时点击静默不动作。
- **页签图标**：黑板页签在向导胶囊与标签 chip 两层都显示专属图标（矩形板 + 列表线的 16×16 stroke glyph，`currentColor`），chip 为「图标 + 标题」。
- **用户操作等价于 Agent**：创建、更新、删除条目都必须先申请该键的写入权，无写入权时操作被拒并给出提示；持有写入权时面板显示剩余有效时间。用户没有绕过仲裁的后门。
- **占用订阅**：申请一个正被占用的键时自动订阅其状态，解锁或删除时收到状态更新。
- **晋升评估按钮**：面板上的「Evaluate for promotion」按钮（黑板上有未晋升条目时可用），点击后注入评估上下文推动主 Agent 评估本会话黑板——按 read/subscribe 计数排序、逐项给出建议去向，你逐项裁决后由主 Agent 落盘到持久文档，并把条目**标记为已晋升**（只读、面板显示去向徽标、不可再编辑/删除、计数继续累积）。点击之前，任何 Agent 的上下文里都不存在"晋升"这个概念。
- **Agent 侧（可观察）**：子 Agent 发现昂贵/意外知识时自动写板；后续 Agent 经 list/search/read 复用已有条目，不再重复勘探。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `blackboard.writeTokenTtlMinutes` | `60` | 写入权超时（分钟），超时自动释放并通知订阅者；设置键 `blackboardWriteTokenTtlMinutes` 为**配置文件面键**（`FIELDS` 的 `page: false`，schema/校验不变）：不在任何设置页渲染，只能改配置文件（生效时机不变），见 [settings-page.md](settings-page.md) |
| `blackboard.maxEntriesPerAgent` | （待定） | 单 Agent 写入配额，防黑板变垃圾桶；实施切片中定稿 |

（配置均为 volatile config，在线编辑、无需重挂载。）

## 设计细节

### 定位：两层缓存架构的 L1

```
子 Agent ──发现即写──▶ L1 黑板（根 Session 级持久、会话内全员共享）
                            │
用户点击晋升按钮 → 主 Agent 评估 ──┬── 丢弃（噪音）
                                   ├── 留在板上（会话内还有读者）
                                   └── 晋升 ──▶ L2 持久文档（spikes.md / runtime map / AGENTS.md 指针）
```

信息拓扑不变：子 Agent 是传感器（供证词：查找成本 + 意外度），用户是策展人（供全局判断）。黑板没有改变谁有全局视野，它把需要全局视野的决策压缩到最便宜的形式（摘要列表 + 用量读数），并把决策权完整交给用户。

### 条目结构

每个条目四元组：

- **key**：简短英文 id，纯标识符，不承载分类语义（身份与分类解耦，改类型不改键）。
- **entryType**：封闭枚举，schema 级强制（object-rooted JSON Schema `enum`，严格供应商校验不合规直接拒绝——约定靠祈祷，枚举靠机制）：

| 值 | 判别线（不相交） |
|---|---|
| `map`（索引） | 什么在哪里：模块/包 → 职责映射、布局理由、入口点 |
| `contract`（硬约束） | 什么成立：验证过的硬约束与不变量（带版本戳与证据） |
| `deadend`（已否决方案） | 什么不通：被排除的看似合理方案（重发现成本最高的一类） |
| `wiring`（隐藏耦合） | 改了 A 必须动 B：不存在于任何单文件里的隐藏依赖 |
| `recipe`（操作流程） | 怎么操作：昂贵的多步操作配方 |
| `why`（设计缘由） | 当初为何如此：代码只展示 what，rationale 不重查即永久丢失 |

- **summary**：自由文本摘要（一到两句话，≤500 字符）。写作指引（工具描述层，非 schema 强制）：说明发现是什么、代价几何、如何复核——没有核验入口的条目是信条不是知识。
- **content**：完整信息（证据、脚本、输出全文），只在 read 时进场。
- **计数**：read/subscribe 次数随条目累积，是晋升评估的排序依据。**只有 Agent 工具的读取计数**；用户在面板查看条目属审计行为，不计数。

### 工具面

模型可见的工具（命名以实施为准；描述模板一律英文，纪律见 AGENTS.md §3.7）：

- `blackboard_list`：聚合全部条目为 key + entryType + summary 形式，带搜索与按类型精确过滤。先 list 锁定范围，再 read 正文——渐进披露由工具形状强制。
- `blackboard_read`：读取指定 key 的完整信息，支持一次传多个 key 批量读取。
- `blackboard_apply`：申请目标键写入权。写入权一次性、带 TTL（默认 60 分钟，可配）；键被占用时申请失败并**自动订阅**该条目，解锁/删除时收到状态更新。
- `blackboard_write` / `blackboard_delete`：创建、更新、删除均须持有目标键的有效写入权，否则显式失败。创建即对新键先取得写入权。

### Agent 契约（注入模板的纪律）

- **写入触发器**（满足其一才写）：代价（发现花了多次调用或一次实验）、意外（与先验/文档相矛盾）、死路（排除了看似合理的方案）、不可逆（丢失后须重做实验而非重跑命令）。豁免：一条便宜命令能重查出来的不写。
- **search-before-create 硬流程**：写入前必须先 list 搜索近似键；仲裁能串行化写入但不能去重，键名漂移靠流程封堵。
- **黑板承载知识，不承载指令**：协调信号、进度汇报、任务派发走 steer/followup，黑板不是消息队列。
- **Agent 不知道晋升**：晋升概念不出现在任何 Agent 的系统提示、工具描述或注入模板里；它只随用户的按钮点击与上下文注入一同到来。

### 晋升流程（用户发起）

面板按钮点击 → 向主 Agent 注入评估上下文（黑板访问方式、评估判据、裁决交互方式）→ 主 Agent list 全板、按 read/subscribe 计数排序 → 逐项给出建议（去向：spikes.md / runtime map / AGENTS.md 指针 / 丢弃，附理由）→ 用户逐项裁决 → 主 Agent 执行落盘。与仓库治理纹理一致：OpenSpec 立项人批、worktree land 默认人批（可按会话 opt-in 自动审批）、黑板晋升用户批——机制提议、人类裁决。

### 面板数据通道

面板的 list/read/apply/write/delete 走**插件自有 typert remote 服务**（`src/capabilities/capability-remote.js` 先例：宿主 typert gateway + 手写 wire schema，客户端 `ctx.remote.<ns>.*` 直调，读操作零会话日志），与 Agent 工具共享同一仲裁内核；不经 commands 通道（`execute()` 无条件落日志且硬编码 user 来源）。

第 8 个 wire 方法 `resolve`：**无 scope、无 agent lookup**——浏览会话 id 以裸 JSON `agentId` 传输（src-json codec，同 capability-remote 先例），返回 `{ sessionId }`（会话根 id）。面板在任何 lookup 门控动词之前先调 resolve 绑定根黑板；网桥的 `rootOf` 面沿 parentSession 链上行（活体 sessions 注册表优先、`sessionQuery.readSession` 持久头兜底），走到 `delegationDepth` 为 0 的根为止（depth 0 的 fork 是自己的根，语义对齐 `resolveDurableRoot`）；断链、无 parent、环路或超过跳数上限（MAX_ANCESTORS=8）一律降级为已知最深祖先，绝不猜测跨会话的根。resolve 只解析 id、不读板内容，七个板动词仍全部走 agent lookup——不新增绕过网关的冷会话身份后门。

**桥接槽的多挂载所有权（stack-restore）**：preset registry 在 profile 加载时急切挂载 `weir` 与 `weir-creative` 两个预设，两个 blackboard 插件实例永久共存并都喂入 `src/blackboard/remote.js` 的模块级桥接——双挂载是稳态而非边缘情况。桥接槽是**存活喂入栈**：面板 remote 调用由最新存活喂入的 faces 服务；任一挂载 dispose 只移除自己的喂入，若移除的恰是服务中喂入则恢复上一个存活喂入；同一喂入的重复 dispose 幂等无操作。仅当不存在任何存活喂入时，remote 方法才以 `bridge-absent` 显式失败、面板才显示黑板不可用——「非 Weir 预设或桥未挂载」的文案语义由此始终为真。服务权切换不触碰内核与持久状态（条目、read/subscribe 计数、晋升标记、未过期写入权令牌跨切换原样可见可用），因为内核与持久层本就不是 per-mount（运行时全局注册表按 profile home 共享、引用计数）。当前两个预设的 faces 等价（同一全局内核、同一 host-plane sessions/agents/sessionQuery、同一设置行），由哪个存活挂载服务对用户不可见；faces 一旦按预设分化，该等价前提失效，须重新评估按预设键控路由（keyed-faces）或 domains.js 式引用计数共享 faces 的终态方案。兄弟桥 `capability-remote.js` 语义不同：capability 读按会话投影预设分发，其喂入按 `readPresetId` 键控、同预设重叠显式 `owner-ambiguous` 拒读（c5dec75），与本栈式所有权是两个域各自的正确语义。

### 持久文件、冷恢复与版本迁移

黑板不在工作区 `.weir/`，也不在 Weir 安装目录。它位于 DSH home 的根 Session 日志目录，文件名是**当前规范日志完整 basename + `_bb`**，例如：

```text
<DSH_HOME>/sessions/<workspace-slug>/<root-session-id>/
  session.v4.jsonl.zstd
  session.v4.jsonl.zstd_bb
  session.lock                 # 仅 DSH 管理；Weir 不修改/占用
  weir-blackboard.writer       # Weir 进程 authority 身份，不含键令牌
  weir-blackboard.lock         # Weir 的短事务锁
```

根 Agent 创建以及晚挂载 catch-up 等待 `ctx.sessions.flush(session)` 的持久化参与，再校验真实日志头的 id/cwd，幂等建立空板。首次工具/面板访问使用同一个 ensure 路径。逻辑 Session 未物化、不存在合法日志、缺少 profile 服务或 flush 失败时不创建孤儿旁板、不回退内存假成功。观察到日志缺失后不会仅凭缓存重建 Session 目录。

安全定位扫描已存在目录，拒绝路径穿越、symlink、外来所有权、错根 ID/cwd、歧义目录或相同日志版本的双物理编码。遵循宿主最高规范版本选择；日志从 v4→v5 或压缩名变化时，在同一根目录固定 Weir 锁下迁移已校验快照，先持久发布相同内容，再清除匹配的旧 `_bb`，之后才允许新变更。多个不一致候选、损坏内容和未知黑板 schema 都明确报错、保留原件，不猜赢家。

旁置 schema 独立于 DSH 日志版本，保存根 ID、全局 revision 和完整条目：key/type/summary/content、readCount/subscribeCount、createdAt/updatedAt、entry revision、promoted destination/at。**不保存/恢复**键令牌、timer 或 subscriber 集合。摘要始终是字符串，不转换成字符索引对象。

### Fork 播种（fork blackboard seeding）

DSH fork 产生的子 Session 是 depth 0 且头部携带 `parentSession` 的新根会话（`delegationDepth` 缺省）。判定规则：**depth 0 + 非空 `header.parentSession` ⇒ fork**。fork 是自己的板根（不继承源板），但它的板不再从空板开局：`resolveDurableRoot` 在 depth-0 分支首次解析某个 fork 时（先于首次 ensure 物化空旁置）调用 `storage.seedFork(id, parentId, cwd)`，从源会话的持久根板播种一次性快照。触发时机即 fork 创建：黑板插件的 `agent/created` → `ensureRoot` → `boardOf` → `lifecycle.run` → `resolveDurableRoot`。

- **源为委派子会话时沿链上行**：被 fork 的源若是 delegated child（`delegationDepth > 0`，自身没有 `_bb`），seedFork 沿磁盘上的 `parentSession` 链上行到 depth-0 根，从根板播种——即源会话实际使用的那块板。环路、非法 depth、超过 64 跳上限分别报 `cyclic Session parent chain` / `invalid Session delegation depth` / `Session ancestry exceeds safety limit`。
- **双目录定序锁**：源目录与 fork 目录同时持有 `weir-blackboard.lock`，按路径字符串字典序固定加锁顺序；单锁使用者（transact）与定序双锁使用者不会构成死锁。
- **幂等**：仅当 fork 目录不存在任何 `_bb` 旁置时才播种并返回 true；已有旁置（已初始化）直接返回 false，永不覆盖或合并。每个 runtime 对同一 fork 只尝试一次（`runtime.forkSeeded`），重启后由磁盘上的「无旁置」检查保证跨进程幂等。
- **快照内容**：`{ schemaVersion: 1, rootSessionId: <fork-id>, revision: 0, entries }`——条目字段（key/entryType/summary/content/readCount/subscribeCount/createdAt/updatedAt/revision/promoted）经 `decodeRecord` 投影校验后逐字复制；令牌/订阅/timer 属易失状态，从不落盘也从不播种。发布走与 transact 相同的私有临时文件（0600）→ 文件 fsync → 原子 rename → 目录 fsync 路径，发布前经 `decodeRecord` 回读校验。
- **源侧只读**：播种不修改源旁置字节、`weir-blackboard.writer`、`weir-blackboard.lock` 或 `session.lock`；fork 目录也不会因播种本身留下 writer/lock/临时文件残留。
- 源根无旁置（从未建板）时不创建任何东西，返回 false——fork 按普通空板开局。

### 原子提交与并发边界

Agent 工具和面板 remote 共用同一可等待事务。Agent 批量 read 的计数、竞争申请的 subscribeCount、write/delete/markPromoted 都纳入持久提交；面板 `count:false` 审计 read 和 list 不增加计数。remote 保留原参数、返回信封及 Agent lookup 权限，不增加绕过网关的冷会话身份后门；旧会话重新打开、宿主重新附着 Agent 后即可显示恢复条目。

事务锁下读取最新快照、校验修订，在无副作用的候选 kernel 上执行，然后用同目录私有临时文件（0600）→文件 fsync→原子 rename→目录 fsync 发布。rename 后目录 fsync 结果不确定时，必须复核权威完整字节；无法确认则明确失败。只有已确认提交才更新内存 authority、消费令牌、发送通知和返回成功。提交前故障不修改原快照、不消费令牌或发释放通知。TTL 到期和 Agent disposal 也进入同一进程串行队列，不能在慢 fsync 期间让另一个持有者的令牌被迟到提交消费。

跨进程通过独立 Weir writer 身份和事务锁拒绝同时存在的第二个 authority；它不是 DSH 的锁，也不保存任何键授权。已证明原 PID 死亡（同机 `ESRCH`）才可回收；超时、不同模块 nonce、PID 仍存在或外来主机均不构成死亡证明。暂停/卡住的活进程不会被抢占。最后一个使用该板的 live Agent 销毁后，串行释放 Weir 自有 writer 身份，其他宿主可接管；仍有参与者的宿主保持独占，必要时先关闭原宿主。PID 复用或中断的锁恢复须离线人工核验，不能删除锁强抢。

子 Agent 经持久 parentSession 链解析到根，即使中间父 Agent 不 live，也不降级写进中间 child 目录；循环、断链或无法核验身份时拒绝。子会话不创建 `_bb`。

### 删除、保留与离线人工清理

- 删除**整个根 Session 目录**时，黑板与目录一起消失。Weir 不重新创建已经消失的目录。
- 归档、窗口关闭、Agent/session disposal、普通回合结束和预设切换都不是删除信号。
- **只删日志时永久保留原 `_bb`，没有自动 GC。** 另一宿主可能还持有 live root；重复 stat/list/本地 registry 缺席都不能证明会话死亡。此时新的持久访问明确失败，旧旁置字节不变。
- 如要清理疑似孤儿：① 用户确认所有可能使用该 DSH home 的宿主和后台进程均已停止；② 逐项确认绝对根 Session 目录、根 ID 及待清理文件不是 symlink，备份 `_bb`；③ 核实没有任何版本的有效规范日志，检查旁置 schema/rootSessionId；④ 只人工删除已确认属于该根的 `_bb`。不要删除 `session.lock`、会话日志或不认识的文件，不提供自动清理命令。
- DSH 内置 **Session ZIP 不包含本特性黑板导出/导入支持**。搬运 ZIP 不等于迁移黑板。旧版已经丢失的内存条目也不会自动从工具日志猜测重放。

### 仲裁与 Edit Lock 的关系

写入权机制是 Edit Lock 仲裁模式在知识条目粒度上的同构实例（申请→一次性令牌→TTL→超时释放→通知等待者）。概念词汇对齐、实现独立；子 Agent 被 terminate 时终止路径主动释放其持有令牌，TTL 兜底，订阅者收到释放通知。

## 边界与失败语义

- 无写入权的写入/删除：显式失败，提示当前持有者状态。
- 申请被占用键：申请失败 + 自动订阅；解锁、删除、TTL 超时释放都会通知订阅者。
- 持有令牌期间 Agent 终止：终止路径主动释放；异常死亡由 TTL 兜底，订阅者不会被无限期阻塞。
- 写入权一次性：写完即失效，迭代补充须重新申请（申请自己刚释放的键无竞争成本）。
- 宿主重启、根 Agent 销毁、预设重挂、归档/取消归档均保留条目；重启后旧写入权和订阅不恢复。不同根 Session 之间复用仍只经用户裁决的文档晋升。
- **Fork 播种失败退化为空板**：源 Session 目录/日志消失、源旁置冲突或损坏、锁超时等失败只产生一条 `blackboard fork seeding failed` 告警，fork 仍以空板正常可用；每个 runtime 只尝试一次，不对持久失败反复扫描告警。fork 之后两块板完全独立。
- **永不发生**：Agent 自主发起晋升；无写入权的写入生效；用户绕过仲裁修改条目；用黑板传递任务指令。

## 测试

- 单元测试：`plugins/weir-harness/test/`——KV 存储与计数、仲裁状态机（申请/写入/释放/超时/一次性失效/订阅通知）、entryType 枚举 schema 校验（object-rooted 合规，严格供应商不拒绝）、summary 自由文本校验。
- 集成测试：`plugins/weir-test-harness`——mock LLM 下「子 Agent 写板 → 父/兄弟 Agent list+read 复用」链路、双 Agent 竞争同键的仲裁与订阅通知、terminate 释放与 TTL 超时、晋升按钮注入 → 评估 → 裁决落盘全链路（随对应切片交付）。

持久化回归位于 [persistence.test.js](../../plugins/weir-harness/test/blackboard/persistence.test.js)：真实文件、故障注入、暂停提交/TTL/销毁竞争、跨进程写者与 SIGKILL、迁移/冲突/损坏/身份路径、计数与晋升恢复、孤儿保留。安装版 [blackboard-persistence 场景](../../plugins/weir-test-harness/src/scenarios/blackboard-persistence.js) 验证首次访问前空板、未物化 Session、同 ID 两进程工具/remote 恢复、隔离卸载重装、两层冷 parent 链与 live-orphan 不可判死。

fork 播种覆盖同样位于 [persistence.test.js](../../plugins/weir-harness/test/blackboard/persistence.test.js)：条目/计数/晋升标记复制与 fork 根身份、源无旁置 no-op、已初始化 fork 不被覆盖合并、委派源沿链上行到根板、冲突/损坏源旁置拒绝、源日志缺失与非法 id 拒绝、源字节与 writer/锁卫生，以及 `resolveDurableRoot` 层的失败告警退化与播种后两板独立。[blackboard-fork 场景](../../plugins/weir-test-harness/src/scenarios/blackboard-fork.js) 经真实 `agents.create` fork 路径（depth 0 + `parentSession` + `isSeeded`）验证端到端播种、计数/晋升标记随快照转移、易失令牌/订阅不转移、源板不受损。
