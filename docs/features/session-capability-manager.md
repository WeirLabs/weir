# 会话能力管理器（Skill/MCP）

> 会话级的 Skill/MCP 选择与持久化：你能清楚地区分「已安装」「本会话启用」「以后新会话默认启用」，未选中的能力对模型与你都不可用。

## 概述

本特性把 Weir 会话的 Skill 与 MCP 配置收敛为一份**显式的已选集合**：编辑先进入草稿，确认（Apply）后才生效并持久化；持久化由 Weir 自管的带锁侧文件承担，不依赖宿主 storage 的跨进程保证。Skill 侧保持官方形状（宿主注册表 + stock `tool-skill`），MCP 侧由 Weir 作为唯一挂载入口（managed/unmanaged 区分）。

当前实施进度：**全部任务组已交付**。存储层、选择 provider、Apply 事务、生命周期、MCP 会话级关闭、预设库与工作区默认值、管理界面（右侧栏 Capabilities 面板 + Badge 入口）与打包导出/两阶段导入均已落地（最后两者经 OpenSpec 变更 `capability-manager-ux`）。

## 用户可见行为

- **可见性变化（自选择 provider 落地起）**：Weir 会话只看到**已选** Skill；未选中的第三方 Skill 不再自动出现在模型目录、`skill` 加载与 slash 列表中。选择记录尚不存在的会话看到空目录与可见的状态提示（fail closed，绝不回退为全量发现）；工作区默认值、管理器界面与 Apply 流程交付后，选择集合由用户显式编辑产生。
- **管理器入口与页签图标**：Capabilities 面板经右侧栏页签 `weir-capabilities` 打开（点击输入框 Badge 直达，或从向导页胶囊进入）；页签在向导胶囊与标签 chip 两层都显示专属滑块图标（16×16 stroke glyph，`currentColor`），chip 为「图标 + 标题」。

## 配置

本特性尚无配置项（实施中的模块将以 volatile config 暴露，在线编辑、无需重挂载）。

## 设计细节

### 持久化与锁

已接受的会话选择、内容代次指针等状态保存在 Weir 自有目录：
`join(profileContext.home, 'weir', 'profiles', profileContext.name, 'capabilities')`，
经受支持的路径解析得到（`ctx.get('profileContext')`，不静态 import `@deepseek-ai/*`）。
`profileContext` 不可得时所有存储单元标为 unsupported 并显式报错，**不回退**到 cwd 或用户工作区；
正式与测试 profile 因此天然隔离（各自 DSH home 下各自 profile 名）。

- **不依赖宿主 storage 的持久性保证，只依赖文件系统 rename／fsync 语义。** 每个存储单元（会话选择、content pins、工作区默认值、预设库、分发记录、MCP 注册表）是独立文件与独立 revision，互不覆盖；记录与锁都带 `schemaVersion`，未知版本 fail closed（拒绝读写、不迁移、不改写、不删除）。
- **原子提交**：选择与其回执在**同一文件的同一次原子提交**中落盘——写临时文件、fsync、rename、目录 fsync；在持锁区间内做 expected-revision CAS。同 requestId 同 payload 重放返回原回执（duplicate），同 ID 异 payload 拒绝（request-conflict）。进程内 mutex 只作本进程串行化，不当跨进程保障。
- **锁协议**：每单元一把独占锁（owner token、进程标识、启动标识、租约时间），获取走「写私有候选 `<file>.<token>.cand` → fsync → `link(cand, file)`（`EEXIST` 即竞争失败）→ 删候选」。刻意**不用**「`wx` 先建后写」：第一轮 G0 spike 实测该写法在崩溃点留下 0 字节锁文件，单元从此永久卡住——这是本设计绕开宿主方案、自管锁文件的直接动因（见证据目录 C-1.10）。`link` 遇 `ENOENT`（候选被持锁者的孤立清理删掉）视为本轮失败并重试。
- **陈旧锁回收**：必须先同时满足「租约过期」且「owner 已不存活」（pid + 启动标识双重核对），不得仅凭超时抢占；过期租约 + 存活 owner 不回收。回收经 `<unit>.lock.recover`（同样以 `link` 发布）串行化，持有后重读锁文件、核对 owner token 仍等于所观察的已死 owner 才 rename，否则中止。持锁期间崩溃留下的本单元孤立 `.tmp`／`.cand` 在下一次持锁时清理；已死回收者遗留的 `.recover` 不自动清除，提供手动恢复入口（`inspect`/`clear`）。
- **内容代次发布**：`distribution/<scope>/active.json` 指针在同一文件系统内以 rename 切换，指针 + provenance + 操作回执在同一次原子发布中提交；任何中断点之后读者只见完整旧代次或完整新代次。
- **平台矩阵**：只在 rename/fsync/link 语义经实测的平台行启用写入（`darwin` 行：1.10 矩阵；`win32` 行：windows-platform-adaptation——NTFS 上硬链接 EEXIST、rename 原子替换、文件 fsync、`kill(pid,0)` 与 `powershell.exe` 启动时间探测经本机实测，跨进程 SIGKILL 竞赛套件全绿；目录 fsync 在 win32 不可用（EPERM），该行跳过目录 fsync）；其余平台写操作标为 unsupported 并显式报错，**绝不**「先删后拷」。

### 库存、身份与选择 provider

Skill 侧保持**官方形状**：`skills` 注册表留在宿主层，Weir 在预设挂载内经 `ctx.skills.registerProvider` 登记**选择 provider** 为预设层唯一 provider，预设继续挂载 stock `tool-skill` 作为 catalog 与 loader。所有 stock 消费者（模型目录、`skill` 加载、`/name` 手势、`skills/list`）与 Weir 消费者因此自动经过同一份选择视图，无需逐个改造。

- **身份模型**（[skill-identity.js](<../../plugins/weir-harness/src/capabilities/skill-identity.js>)）：scope（project／user／custom／Weir 内置）× 根路径 × 名称 × provenance。无 provenance 的本地项用本机 opaque identity 并标记**不可自动移植**；content digest 标识版本、不构成名称授权；发现顺序（rank）不构成授权。
- **自有原始枚举**（[skill-inventory.js](<../../plugins/weir-harness/src/capabilities/skill-inventory.js>)）：provider 显式重复实现宿主目录解析（已接受的代价），project／user／custom／bundled 各根独立枚举，rank 与 source 标签与宿主 `dsh-skill-filesystem` 语义一致；被遮蔽的同名候选**并列保留**（不丢弃），frontmatter 不可解析的条目保留为 unparsed，根不可读时保留 last-good 并以 `complete: false` 标注为部分结果，绝不伪造完整。frontmatter 解析器是手写严格子集 YAML（[frontmatter.js](<../../plugins/weir-harness/src/capabilities/frontmatter.js>)，零新增依赖），超子集语法一律报解析错误而不是猜。
- **按身份精确加载**：只在 Weir 自有清单内按候选身份加载，同名未选项不替代、不按显示名猜测；**软化范围**：宿主 `ctx.skills.get` 仍只按名称解析，精确性只在 Weir 清单内成立。多个选中身份同名时呈现冲突、须用户显式解冲突，Apply 不任意取胜者。
- **挂载不抛出**：挂载路径只做同步、不会失败的登记（挂载抛错会让整个预设 broken、所有会话无法创建）；读取／解析失败 fail closed 为「空选择 + 可见错误状态」（`skillSelectionFor(ctx)` 可读出状态供管理器与 Badge 显示原因）。Apply 被接受后调用 `control.invalidate()`（带重入闸门：N 次连续失效与同步 raw→selected 回波只进入一次重枚举，在途枚举不得重发已被撤销的选择）。
- **组合要求**：宿主层 `skill-filesystem` 与 `tool-skill` 由 Weir patch 行显式 `disabled: true`（宿主行不禁用时，宿主 fs 会把工作区 Skill 注入全局层、宿主 tool-skill 会删除预设模型目录）；预设自有的 `skill-filesystem` 行及其 `customSkillDirs` 已移除（其候选会漏进同一预设层）。宿主内置 Skill provider（如 office）不经 `skill-filesystem`，其条目由 [skill-office-adapter.js](<../../plugins/weir-harness/src/capabilities/skill-office-adapter.js>) 纳入 Weir 枚举与选择，未选项以同名候选遮蔽为不可模型调用、不可用户调用（`!m!u`），加载返回显式不可用错误。
- **内置 Skill 迁移**：bundle 的 `skills` 目录由 provider 枚举并标注为 **Weir 内置**（不沿用宿主 `source:"bundled"` 与 bundled 根 rank 600）；首次运行迁移检查核对 10 个内置 Skill 均被发现、名称／来源标签／rank 与原 `customSkillDirs`（custom／rank 300）语义等价，不等价时 fail closed 并显示原因。`skills/` 目录字节不变。

### Apply 事务

管理器草稿按 **Skill identity** 寻址而非显示名称：同名候选的勾选独立，净增减按 identity key 比较（[client.capability-model.js](<../../plugins/weir-harness/lib/client.capability-model.js#L14>)）。`list` 每行末尾携带 `identity`（不可解析项为 `null`）；`receipt.effective.skillIdentities` 紧随 `skills`，按已选候选顺序携带 identity；`skills` 名称数组仍供 Badge 计数与旧客户端使用（[read-payloads.js](<../../plugins/weir-harness/src/capabilities/read-payloads.js#L24>)）。草稿优先读 `skillIdentities`，旧回执回退名称；预设载入保留 identity 对象，名称仅在当前 listing 中唯一 parsed 匹配时解析，未解析名称留待 Apply 报告。

`/capabilities apply` 的 `skills` 接受混合条目：identity 对象按完整 key 精确匹配当前库存并采用库存 identity；名称字符串仅在 parsed 候选唯一匹配时绑定。未知或歧义名称进入 `missing` 分区，**绝不按枚举顺序静默选胜者**；既有 supplemental-known → `skipped` 分区不变（[skill-selection-plugin.js](<../../plugins/weir-harness/src/capabilities/skill-selection-plugin.js#L549>)）。

**同名 Skill 的管理器反馈**：完整库存中若两个不同 identity 共享调用名称（例如 `user/research` 与 `weir-builtin/research`），两行仍独立可勾选；草稿允许暂存双选，但行内标记与底栏即时点明名称和两个来源，Apply 可见但禁用，取消任一项后恢复（其余草稿与 Discard 保留）。判断使用完整 listing 与草稿，搜索隐藏一行也不解除阻塞。同行来源相同的不同根用界面内候选序号区分；可访问复选框名称包含技能名与来源，不向提示输出 opaqueId、绝对根路径或凭据。Badge 和面板头的已应用计数只看旧服务端回执，不将冲突草稿视为生效。当前宿主按 Skill 名称寻址（包括模型 `skill({name})` 和 slash），无法同时启用两个同名内容；若需要并用，必须将一份合法改为不同名称，而不是按目录排序选择胜者。

**旧预设纯名称**：载入时仅在完整 listing 恰有一个 parsed 候选时绑定 identity。多个候选时保留旧字符串为“尚未选定来源”，与双 identity 冲突分开提示，Skills 视图提供每个候选的“替换为指定来源”和“移除旧名称”按钮；单独勾选候选不会消费旧字符串。移除/替换仅改变该字符串对应的草稿条目，不更改其余 Skill、MCP、unresolved refs、已应用集合与 CAS revision；歧义未解时 Apply 禁用。当前清单没有匹配则说明“没有匹配”并提供移除；清单读取失败说明“暂不可读”，保留草稿且不猜来源。服务端对过期客户端仍会在写入前拒绝双选；结构化 `same-name-conflict` 和 `missing` 回执在底栏点名并指导取消/刷新/选择/移除，非 JSON 或未知错误仍诚实报告失败、保留草稿，不把已知歧义说成仅仅未安装。两种外壳（右栏与 Badge 弹层）共用该组件树及可读的动态告警。

选择编辑先进入**草稿**（[selection-draft.js](<../../plugins/weir-harness/src/capabilities/selection-draft.js>)）：以 `baseSelectionRevision` 为基线维护规范化启用集合、unresolved requested refs 与局部筛选/布局；Apply 仅在规范化 enabled set 有实质变化时可用（还原、排序、搜索、元数据、安装、更新与身份不变的 content refresh 都不算变更）；显式空集不等于缺失；草稿是纯管理器侧状态，模型与工具读不到。

确认后走**六步事务**（[apply-engine.js](<../../plugins/weir-harness/src/capabilities/apply-engine.js>)）：

1. 服务端从 authenticated session 定位 workspace/preset 并读取最新 accepted revision——不信任客户端传入的 cwd、scope root 或 server config；
2. 校验 requestId 与 payload digest（request digest 覆盖 expectedRevision）、expected revision、完整清单状态、精确身份与冲突（同名单多选直接拒绝，不任意取胜）、一致性条件（未满足显示 unsupported）；
3. 准备纯快照、过滤视图与已验证 content handle——不发布权限、不启动外部安装、不注入通知，准备失败保留旧 authority 与用户草稿；
4. 进入 admission fence，冻结尚未 handed-off 的能力调用与 prompt publication（MCP 排空接口已预留，实现见后续 MCP 组）；
5. 经自管存储在锁内 CAS 原子写入新 selection 与 receipt，随后在**同一个非异步段**（`publishAccepted`，apply-delta-durable-basis D4）内依次 对持久记录计算净 delta 并入队模型通知 → 切换内存快照 → 更新 lifecycle 快照 → 调用 provider `control.invalidate()` → 解除 fence——`invalidate()` 先于解除 fence、先于发送响应，客户端收到响应后的第一次重取绝不会命中旧缓存；写入明确失败则解除 fence 并恢复旧快照，写入结果不确定则维持阻断，按原 request ID 查询 receipt 结算（`published`／`not-committed`／`blocked`——不宣称取消成功、不伪造回滚；`published` 恢复运行**同一个** `publishAccepted` 发布段，通知恰好入队一次）；
6. 发送响应：accepted revision、effective sets、unresolved warnings 与发送时刻的排空状态快照，**不等待**排空完成。

配套纪律与机制：

- **审计**：`capability-apply` 类型注册于共享 [audit.js](<../../plugins/weir-harness/src/shared/audit.js>)（cordis emit + `.weir/audit.jsonl` 双写），发射失败 warn/swallow 且不改变 policy；生产引擎经 `engineFor()` 接入该冷安全通道与 logger 诊断 `trace`（apply-delta-durable-basis D5——此前审计只在测试中接线），`apply-wiring.test.js` 钉住提交 Apply 与 recovery-`published` 结算两处发射；`command/run`／`command/done`／审计日志都不是提交证据；新增代码静态保证不触碰 `session.append` 与自定义 session 事件（冷读红线）。
- **幂等与丢失响应**：receipts 随会话生命周期保留，清理不允许旧请求重放成第二次变更；已接受请求重放返回原 receipt，异参 ID 复用拒绝；durable acceptance 后响应丢失时按原 request ID 查询取回 accepted revision（「结果待确认」语义）。
- **content refresh 协调**（**当前未交付**：策略模块存在但从未接线生产路径，随分发能力一并待撤回变更处理；设计意图为 refresh 用独立存储单元与 receipt/revision，与 selection 共用同一会话级提交协调者，提交前重查 selection revision）。
- **Skill 侧会话阻断**（[skill-selection-provider.js](<../../plugins/weir-harness/src/capabilities/skill-selection-provider.js>) 生产路径）：未选中 Skill 的 `skill` 调用返回显式 unavailable 且不加载正文；slash 提交由服务端在当前选择上再验证；正文异步读取结束、返回内容之前复核选择快照（已读取 ≠ 已授权）；接受移除后，未 handed-off 的正文加载与子代理 prompt 发布被拒。（变更 capabilities-deepening：重复且从未接线的 `skill-admission.js` 已删除，其测试断言改靶到此生产路径。）

### 目录与菜单收敛

冷会话（页面打开历史会话、尚无运行 agent）与实时会话看到同一份选择视图，但收敛路径不同：

- **无会话调用失败关闭**：宿主对无运行 agent 的调用只给 provider `{cwd, scope=预设常驻 key}`，provider 看不到会话 ID——此时**只能返回空列表**，绝不按目录或预设默认值猜测（同目录多会话选择不同时 cwd 键必然给错）。常驻 key 是预期的冷条件而非策略失败，因此不产生错误状态；office denial 阴影条目保留（它们是遮蔽宿主内置项的防线，不是可选择 Skill）。
- **打开即恢复、先空后收敛**：宿主打开历史会话会自动恢复（follow→promote），预设内 `agent/created` 监听器（agent 已 `enter` 之后）对**根会话**重发 `agent-preset/selected`（[preset-invalidation.js](<../../plugins/weir-harness/src/capabilities/preset-invalidation.js>)：两参数必须是合法 JSON 字符串、取会话**实际**预设 id、全程 try/catch、子代理不发射）；Apply 被接受后同样重发一次。客户端收到帧后丢弃缓存重取，因此**冷会话打开瞬间菜单可能先为空，约一次恢复后收敛**——先空后收敛是允许形态，列出未选 Skill 不是。
- **已接受的语义拉伸**：该宿主事件原义是「会话提交了不同预设」，`dsh-client-ui-commands` 收到后也会重取命令列表（每次发射全客户端广播，故严格限定根会话 + Apply 两处）。若宿主将来提供专用修订事件，应切换过去（记入宿主后续依赖）。
- **恢复失败保持为空**：另一进程占用会话日志（writer-held）等恢复失败时，菜单保持为空且状态面给出稳定 `reason` 与可操作 `hint`（[selection-status.js](<../../plugins/weir-harness/src/capabilities/selection-status.js>)），绝不回退为非空列表；`acceptSelection` 或显式 `clearFailure` 解除。
- **浏览器侧行为**（缓存丢弃、打开中菜单即时刷新、草稿 chip 短暂空白等）以服务端 + 模拟客户端缓存证据为准，真实 GUI 观察待 1.5 验证。

### 初始化与继承

会话生命周期的每个入口都在首次 prompt assembly 之前就位一份已接受选择的快照：

- **同步内存快照**（[lifecycle-snapshot.js](<../../plugins/weir-harness/src/capabilities/lifecycle-snapshot.js>)）：插件 apply 时预载已知会话的已接受记录（[lifecycle-preload.js](<../../plugins/weir-harness/src/capabilities/lifecycle-preload.js>)，内存优先），`agent/created` 监听器只做**同步读取**——内存未命中时恰好一次阻塞式同步磁盘读，绝不使用 Promise 接口的宿主 storage；模块全文零 `await`（静态测试钉死），成功路径恒返 `undefined`（cordis 串行 bail-on-value 教训）。G4b 实证失败形态是**让出**事件循环而非耗时（`sleep100` 失败、`busy100` 通过）。Apply 被接受后经 engine `publishSnapshot` 钩子在同一非异步段更新内存。
- **子代理快照 durable 捕获**：子代理的 `agent/created` 内用阻塞式同步 I/O（`writeFileSync` + `fsyncSync`，经第 2 组单元布局 `sessions/<id>/inherited.json` 与锁约定）捕获父已接受快照。捕获**并非**与宿主会话发布原子——如实陈述：崩溃窗口留下的无快照子代理在显式 resume 时按子代理 fail-closed 规则拒绝。
- **创建时继承**（6.3）：创建取父快照逐字（叠加委派约束 `allowSkills`/`allowMcpServers`，只缩不扩）；显式 resume／escalation 取「子原快照 ∩ 当前父快照」——被移除的能力不恢复、父新增的能力不下发；向仍存活子代理发消息（无 `agent/created`）不重新捕获，存活子代理的快照不被父的后续编辑改动。
- **读取路径**：子代理会话无 accepted 记录时从其 inherited 快照解析（`readSelection` 回退）；无快照的子代理被显式拒绝（`inherited-snapshot-unavailable`），绝不授予根基线。
- **崩溃恢复/fork 化身（resume incarnation，2026-10-06 `capability-resume-incarnation-recovery`）**：宿主恢复或 fork 产生的「`delegationDepth: 0` 但带 `parentSession` 头」的会话，捕获门与读取门已对齐——`agent/created` 按 resume 语义 best-effort 捕获父已接受快照（只缩不扩；自身引用按无父处理；**已持自己 accepted 记录的化身逐字保留**，一次显式 Apply 永不被父系收窄）。捕获失败走**根失败语义**：监听器不抛出、会话照常创建、blocked 空视图 + 分类 reason，hint 点名恢复动作（Capabilities 面板显式 Apply）；绝不回退全量目录、绝不拒创建用户主会话。父记录缺失（非 blocked）时捕获写入空 inherited（origin inherited），与既有子代理行为一致。
- **fail closed 双规则**（6.4，每种情形恰好一条规则）：①根会话／已存在会话的选择记录不可读／损坏／未知版本 → 监听器**不抛出**，会话照常创建／恢复，视图为空 + 分类 reason/hint（`policy-unreadable:*`），原文件绝不改写；恢复 = 人工修复记录 + 新 Apply。②子代理的父快照不可读或无法捕获 → 监听器抛出拒创建，父会话继续并经委派结果得知原因。插件 dispose／reload 窗口保守拒绝（denials-only）。
- **降级列表保真**：选择视图错误态下 `/capabilities list` 回退到全量原始库存——选择标记全 false、scope/provenance/conflict 标签保留（不降级为 unknown/other），错误状态随行；Apply 以全量库存映射名称不受影响，因此 blocked 会话在面板勾选 + Apply 即可自愈（`resume-incarnation` 集成场景 10/10 钉住全链）。
- **初始化优先级**（6.5，[initial-selection.js](<../../plugins/weir-harness/src/capabilities/initial-selection.js>)）：新根会话无 accepted 记录时——保存的工作区默认（含显式空集）逐字胜出并报告缺失项（默认不可解码则 fail closed `workspace-default-unavailable`）；无默认时内置 Skill 基线 + 组合中已启用的 managed MCP；历史内容不构成授权，本路径零持久化；闸门只对 `weir` 预设生效（组合保证）。默认记录中的**纯名称字符串条目**（旧客户端草稿的 wire 形态，即 `default-save from:'draft'` 写入的记录）按实时库存**唯一名称**绑定为完整 identity（`bindDefaultSkillNames`）；无法绑定的条目（库存中已不存在或同名歧义）逐项报告为 missing，绝不猜测、绝不让整个默认 fail closed；identity 形态的条目（`from:'applied'` 写入）逐字保留且不触发库存读取。

### 预设与默认值

**预设库**（[preset-library.js](<../../plugins/weir-harness/src/capabilities/preset-library.js>)）：`global` 与每个 `workspace` 是独立命名空间，稳定 preset ID 与显示名分离；每个预设文件有自己的 revision，所有写者另按**命名空间 → 预设单元**获取跨进程锁，并在锁内严格检查名称，避免不同 ID 并发写入重名。只读列表可容忍坏记录，写入时坏记录／未知 schema 则拒绝而不猜测名称空缺。同 namespace 内改名撞名直接拒绝；新建／导入确认替换必须点名已有预设的 ID 和 revision，真正更新该 ID，旧版只传 `onNameConflict:'replace'` 的命令现报 `confirmation-required`（内部行为 BREAKING），绝不再新增第二份同名项。旧版本已经生成的同名记录仍按各自 ID 列出，用户须通过精确改名／删除逐项化解，系统绝不代删；跨 namespace 同名合法，workspace 预设只在本工作区可见。stale revision 是显式冲突，已删除的 ID 不可由编辑复活；新建可在另一空闲 ID 上复用其旧显示名。

**预设原位编辑（safe-preset-rename-resave）**：预设列表每行分别提供「重命名」与「重新保存」。重命名仅改显示名称，不重建预设 ID、不读取当前会话草稿覆盖原内容；重新保存明确选择当前草稿（默认）或已应用集合，在确认页点名目标 namespace／名称及 Skill、MCP、未解析引用数量，覆盖该预设的选择内容但保留名称和 ID。**所有**从已应用来源保存的路径（重新保存、另存为新预设、旧编辑与精确确认替换）均须与用户确认时所见的有效身份集合一致：回执携带有效集合摘要，提交时与来源 revision 一并在来源锁下复核；若有失效 Skill、来源不完整或确认后变化（包括无持久选择记录的 revision 0 会话），先拒绝并提示修复／重新确认，既不保存隐藏的旧身份，也不悄悄按 0 项清空。旧客户端缺摘要的已应用保存会被拒绝，须刷新页面重新确认；草稿来源仍可独立保存。重命名、重新保存和另存为均不触发当前会话的 Apply；删除、修订冲突、锁忙或结果无法确认时保留现状并要求重新核对，绝不把失败显示为已保存。

**可移植文档与导入安全**（[portable-refs.js](<../../plugins/weir-harness/src/capabilities/portable-refs.js>)）：Skill ref 白名单 = source kind + 无凭据 canonical repository + requested ref + subpath + logical name／target scope + 可选已解析 commit／digest；MCP ref 只含 Weir 管理的逻辑 binding identity + 显示 label——URL、凭据、命令、参数、headers、环境值一律拒收。导入校验原子化（object-rooted schema：version、文档 ≤ 1 MiB、条目 ≤ 1000、字段 ≤ 4 KiB，未知字段与未知版本整体拒绝、零写入）。导入只**绑定**本机已配置的 identity：不创建、不启动、不接受连接内容。

**unresolved 语义**（9.3）：未解析的 ref 保留在 requested metadata 里，绝不进入 enabled 草稿；安装后仍需用户单独勾选并 Apply；同名项不替代；加载或导入不触发网络、安装或启动。
修订（`capability-manager-ux` 用户裁决）：**version-2 打包文档的导入动作本身**是显式安装行为（见下段）；v1 文档与预设**载入**仍零网络、零安装、零启动。

**工作区默认值**（[defaults-transaction.js](<../../plugins/weir-harness/src/capabilities/defaults-transaction.js>)）：「保存为工作区新会话默认值」是独立事务——确认面点名记录的精确能力与 scope、逐项警告无法解析项；记录的是 resolved sets + unresolved refs 的**拷贝快照**（保存后草稿独立演化）：`from:'draft'` 保存时 identity 对象逐字保留、遗留草稿名字在服务端解析为精确 SkillIdentity 再落盘（唯一库存匹配直接定；重名时以会话已应用选择消歧；无法解析/仍歧义则显式 `missing`/`ambiguous` 报错、零写入），`from:'applied'` 行为不变；读侧对存量名字串记录的唯一名绑定（`bindDefaultSkillNames`）为遗留容忍。不需要先 Apply、也绝不改变当前会话；显式空集是可保存的真实选择，而**清除 = 不存在**（新会话回到内置基线）；绑定工作区稳定身份（canonical 根路径摘要，工作区改名不影响绑定）；保存／清除经 CAS，并发保存显式冲突。
**打包导出与两阶段导入**（[preset-package.js](<../../plugins/weir-harness/src/capabilities/preset-package.js>) + [preset-package-install.js](<../../plugins/weir-harness/src/capabilities/preset-package-install.js>)）：`preset-export` 默认产出 **version-2 打包文档**（`format:'document'` 为 v1 检视/备份格式）。导出按 Skill 来源三分：**远程来源**（有 portable provenance）只写合规 portable ref（链接，不带内容）；**工作区安装**（project scope）与**本地全局**（user/custom 且 `portable:false`）打包 UTF-8 文件集随文档旅行（entry path 相对、逐段 segment、禁 `..`/绝对路径；包 ≤ 8 MiB、单文件 ≤ 512 KiB、每 Skill ≤ 256 文件，未知字段/版本原子拒收零写入）；**Weir 内置**按名称引用（任何装了 bundle 的机器可解析，缺失列入 warnings）。导入两阶段：`dryRun:true` 只回摘要（每个 Skill 的目标根/文件数/冲突、unresolved refs）零写入；确认调用携带 `onCollision`（默认 cancel——同名未决策零写入，replace/coexist 需显式，coexist 派生 `<name>-2` 并改写 frontmatter 名称）执行安装：project 包装入**当前工作区** project Skill 根、user 包装入目标机 user Skill 根，逐文件临时名→rename，任一失败回滚已写文件且不建档，安装与冲突决策经 `capability-preset-import` 审计类型落审计。安装是**导入动作本身的显式主效应**：零网络、零 server 启动；远程 ref 保持 unresolved（安装仍走 skill-distribution 的独立动作）；装入的 Skill 不自动勾选（仍须草稿选择 + Apply）。

**导入与预设名称冲突的边界**：version-2 导入的 dry-run 仍零写；确认导入时先在命名空间写锁内校验预设名称和精确替换目标，再安装包携带的 Skill，因此名称撞车／旧版裸 `replace` 在安装之前拒绝。Skill 安装和预设落库**不是**一个跨文件系统的崩溃原子事务：若安装已经完成而后续预设提交失败或结果不确定，回执与导入确认界面必须保留已安装项清单、标明预设结果尚待核查并提示检查预设列表与已安装 Skill；不能宣称文件已全部回滚，也不能用通用失败消息吞掉安装结果。只有安装过程自身失败的清理才按安装器证据报告。

### MCP 会话级关闭

Weir 是自身所管理 MCP server 的唯一挂载入口：用户经 Weir 配置的 server 由 Weir 在运行时逐个挂载（每个 server 一个隔离 `cordis:group`：代理 facade + stock `dsh-mcp-client`，经宿主支持的 loader API 创建/销毁，崩溃残留行启动时清理），会话选择决定每个 agent 能用哪些。

**预设行 realm 布局**：manager 行经 reflect 发布 `weirMcpGate` / `weirMcpManager` 两个服务，而预设注册审计拒绝任何进入根 realm 的预设服务（`Preset services require isolate realms`），因此 `weir-mcp-manager`（提供者）与 `weir-skill-selection`（消费者，`/capabilities list` 读取 manager 列表）同置于预设的 `capabilities` cordis 组、由该组 isolate 这两个服务（S11 同 realm 纪律，`preset-realms` 单测对拍守卫）；facade 侧经模块级 realm bridge 取闸门面，不跨 realm 读服务。

**保证等级（如实措辞）：**

| 对象 | 保证 |
|---|---|
| Weir 管理的 server | **网关级强制**：工具调用在**包装后定义的 `execute` 最开头**按「注册表 configured identity + registration generation + 会话已接受集合 + lifecycle 快照」准入（被拒调用零 RPC 到达 server，G3b 语义）；三个资源操作按目标 server 在派发时门控；`mcp:<server>` 指令段每次 prompt 组装时按 agent 过滤；Apply 移除后「关闸 → 等待在途 → 超时只报告仍在途」，不承诺强制取消，外部副作用不可撤销 |
| 工具 schema | **按 agent 在创建时隐藏**（`tools.restrict` 创建时快照）：只对 Apply 之后创建的 agent 成立；live Apply 后既有 agent 的旧 schema 可能仍可见，但每次派发都在任何 server 活动前被拒——不声称 schema 已从该 agent 的请求中消失 |
| 宿主直接配置／ACP／其他预设挂载的 server | **不提供任何保证**：一律显示为 **unmanaged**，管理器不提供关闭开关、不声称已关闭、不计入关闭统计 |

**软化条款（如实记录）**：准入基于 Weir 注册层派生的 configured identity 与 registration generation（重连以同 identity 的新 generation 续接，同名不同 identity 不继承授权），范围限于 Weir 管理的 server；宿主发布的权威身份/generation 与 SDK 最终准入是未授权的后续依赖。`tools/pre-execute` 只作额外早拒，唯一防线是包装定义的最后一刻校验。

**组合期歧义**：一个 configured name 是另一个的 `__` 前缀、或同一公开名被两个 server 声明时 fail closed 拒挂其一（不猜测）；facade 遇到未知宿主方法时该 server fail closed 并可见报错。崩溃残留 `weir-mcp-*` 行启动时识别并清理。

**新增受管 server**：面板 MCP 页签的「+ Add managed MCP server」表单或 `/capabilities mcp-add <json {identity,label,command,args?,env?,serverName?}>`——写入注册表（owner 为 global/installation、generation 1）后立即经 manager 挂载；注册只使它**可管理**，各会话仍需在选择里勾选才启用。

**纳入 Weir 管理（adopt）**：现有宿主配置不被自动接管；用户确认后才在注册表创建 identity——宿主原条目仍持有先到先得 `serverName` 保留时显示为**冲突**（提示用户自行停用宿主条目，之后由 managed client 接管），绝不显示为成功。便携式 MCP ref 只指向 Weir 管理的逻辑 binding。

### 管理界面与通知

**会话 Badge 与 Capabilities 面板**（客户端 `lib/client.capability-*.js`，服务器 `/capabilities` 命令）：Badge 挂在 `conversation.input.right`（order 95，紧邻 LSP order 100），显示的已应用 Skills/MCP 计数一律以**服务端回执**为准（draft 绝不乐观显示），带内联图标与不可用警告点；空白会话凭明确 session ID 打开。**管理器落点是右侧栏 Capabilities 面板**（`sidebarRightTabs` tab `weir-capabilities` + `sidebar.right.pane.tab`，priority `extension`，与 Worktree 面板同模式）：点击 Badge 经 `sidebarRight.openTab` 打开对应会话的面板；shell 无右侧栏时 Badge 回退为输入框弹层——**面板与弹层共享同一视图组件树**（`shell` prop 只换外壳），降级路径零分叉。面板三个视图：Skills（按 scope 分组 Weir 内置/user/project/custom、真实复选框、名称+描述次行、冲突/缺失标记、搜索）、MCP（managed/unmanaged 分组、逐字段校验的添加表单）、**预设与默认值**（global/workspace 分节列表、保存草稿/已应用为预设、载入预设进草稿并报告 unresolved、重命名/替换/删除显式确认、导出 v2 包下载 `.json`、导入永远先 dry-run 出摘要（目标根/文件数/冲突列表）经显式确认与冲突决策后执行、工作区默认值保存/查看/清除）。底栏 Apply/Discard 带 dirty 净增减摘要（+n/−m），commit 相位语义不变。**Apply 不适用分区（preset-skill-applicability）**：草稿含当前库存无法解析的名称时，经 profile 补充目录（`supplementalSkillDirs`，两预设行同根注入）判定为「已知但当前预设不适用」的条目**跳过**（回执 `skipped:[{name,reason}]` 逐条列出，面板以警告 chip 呈现「已跳过 n 项」），可解析部分照常提交、记录不改写（预设往返无损）；真正未知名维持 `{status:'missing'}` 整批硬失败（草稿保留）。服务器面：读取三件套（receipt/list/conditions）走插件自有 typert remote `weirCapabilities`（宿主层行 `weir-capability-remote`，[capability-remote.js](<../../plugins/weir-harness/src/capabilities/capability-remote.js>)）——**读操作零会话日志写入**（宿主 `commands.execute` 无条件落 `command/run`/`command/done` 且硬编码 `source:{kind:'user'}`，Badge 每次挂载拉取曾在每次进会话时永久留对话卡片；S27 实证后迁出）；变更操作与预设/默认值写动词仍走 `/capabilities apply|mcp-add|preset-save|preset-load|preset-delete|preset-export|preset-import|default-save|default-clear` 命令（用户显式触发，留卡片是审计特性）；预设页签的两个自动读取（`presets`/`default-get`）随后亦迁入同一 remote（silent-preset-reads，方法 `presets`/`defaultGet`，域状态如 `no-workspace` 作为值返回）；命令与 remote 共享同一套载荷构造（[read-payloads.js](<../../plugins/weir-harness/src/capabilities/read-payloads.js>)，字节一致），UI 不直连 store；未满足的一致性条件显示显式 **unsupported** 而非隐藏控件，与 loading/unknown 区分；恢复失败显示原因。草稿交互（12.3）：行即复选框（键盘 Space/Enter 可操作），Apply 提交走 `/capabilities apply <json>`——identity 在服务器侧按**全量库存**精确匹配、旧名称条目按唯一 parsed 匹配映射为身份（不在有效选择里的候选同样可勾选），未知名显式报错；关闭 dirty draft 提供 discard/keep editing；提交中复用同一 request ID；失败保留草稿；revision conflict 显示当前状态让用户重选（不静默 rebase）；无 diff 但有缺失警告时提供 install/configure 而不虚构 Apply；结果待确认可查询。命令结果契约注意：`dsh-commands` 的 normalizeResult 只保留 `{kind, text, sourceEventSeq}`，结构化载荷一律以 JSON 文本传输。remote 通道契约：`weirCapabilities.receipt|list|conditions(sessionId)` 经 `ctx.typert.register()` 手写 contribution（src-json codec）注册，服务由预设层 skill-selection 经模块级 bridge 喂面、宿主层行 `ctx.root.reflect.provide` 发布（预设 realm 对网关不可见，S27）；失败为 typed error（`bridge-absent`/`unknown-session`/`payload-failed`），客户端映射为既有不可用态，**不回退命令通道**。

**双预设读取归属与降级（fix-capability-read-preset-routing）**：普通 Weir 与 Weir Creative 的选择提供者可以在同一 Host 同时挂载；Badge/管理器/预设页的静默读取不能借用「最后挂载」的提供者。Host 对每个目标会话按已提交的当前预设投影选确切提供者（即使创建 header 仍写旧预设、或会话是冷读）；缺失、重复或在读取途中切换的归属返回明确不可用，不重启 Agent、不写会话日志、不改持久选择。若已接受选择记录有内容而库存读取不完整或回执带警告，已应用有效数量显示「未知／暂不可核实」和恢复提示，**不**把 0 个候选误称已应用空集，也不清空用户草稿；首次打开时基线未知，不以虚假的空集计算 +n/−m，用户明确核对并单独确认覆盖风险后才能再次 Apply。异步旧回执不能在新回执后覆盖页面。只有完整且无警告的真实空集才显示 0；已应用来源的预设保存继续要求回执摘要与修订证明，降级时禁用。

**并发读取与降级诊断（2026-10-12 实况修复）**：Badge 与面板会并发请求同一会话的回执；provider 的 `fresh()` 曾先作废 epoch 再重新枚举，并发调用互相触发 stale-epoch 守卫，双双得到无错误详情的 `complete:false`（Badge 永久「?」）。修复后并发 `fresh()` 共享在途枚举（在途枚举本就是最新答案），stale-epoch 守卫仍拦截真正的中途失效（`sourceChanged`/Apply 作废旧结果）。Host 读服务在回执带 warning 时写一条 `weir/capability-read` 审计（方法、观察到的预设归属与 header 对照、live/prepared 来源、feed 数量、provider 状态原因，**不含技能名**），镜像到 `<cwd>/.weir/audit.jsonl`，供「已接受但不可核实」的现场定位。

**视觉语言**（2026-10-06 `capabilities-panel-visual-polish`，skip_specs 纯视觉）：面板与弹层共用一套按 frame/header/tabs/list/row/tag/footer/state 分区的样式表——分段控件标签栏、带图标搜索框（焦点环）、sticky 分组标题（含计数徽标）、按 scope 着色的来源标签（Weir 内置/user/project/custom 四个色系）、行项 hover/选中/键盘焦点三态、MCP 与预设的卡片分组、loading 骨架行、error/unsupported/degraded 完整空态（图标+标题+说明+动作）、底栏 diff 徽标与主按钮层级、破坏操作用警示条；全部 `--dsw-*` token + hex fallback，深浅主题安全，过渡仅 hover/选中 120-160ms，可交互元素统一 focus-visible 环。行为零变化：hook 数、钉死的子节点路径、动词契约、t() 单参 echo-guard 契约全部保持，单测只加不缩。

**给模型的移除通知**（12.4，[selection-notify.js](<../../plugins/weir-harness/src/capabilities/selection-notify.js>)）：Apply 被接受后净增减跨多次应用合并，在**下一次安全请求**时以完整 UserMessage（共享 helper）随该请求注入——绝不自行触发回合、不在 `session/event` 内同步 followup；来源标记为 `weir-selection-notify`（非 `user`），intent gate 与 continuation/intent 分类器按构造排除（共享 `isGenuineUserMessage` 只认 `source.kind === 'user'`）；英文 advisory 模板明确「已 handed off 的调用仍可能完成、历史中任何回合或调用不被撤回或抹除」；注入失败只 audit/warn，绝不影响已接受的提交。

**delta 基准是持久记录而非进程内存**（apply-delta-durable-basis，2026-10-16 C4 修复）：净增减由纯函数 `selectionDelta(previousSets, acceptedSets)` 计算——`previousSets` 是事务起始读到的 accepted 选择记录（提交路径上 CAS 已证明它是被覆写权威；恢复路径上由 blocked 条目在事务起始捕获，因为结算时记录已含落地写入），不再是每进程为空的内存快照图。因此宿主重启后首次 Apply 的移除通知仍点名**每一个**被移除能力，重放已接受集合则保持静默（无伪 `Added:` 通知）。receipt 恢复同责：recovery `published` 结算运行与提交路径**同一个**同步发布段，恰好排队一次通知（被阻断事务从未到达提交段、结算只发生一次、notifier 净合并跨 Apply 收敛）；`not-committed` 与 `blocked` 结算不排队任何通知。已知边界（明确非目标）：已入队但尚未注入的通知仍随进程退出丢失（durable pending-notice 队列列为后续跟进）；`store.commit` 返回被覆写 payload 的强化同理不在本变更。

**收敛语义（D-E）**：服务端精确性立即生效（任何调用以服务端校验为准）；宿主 `/` 菜单经 provider `invalidate()` + 5.2 的重发事件收敛（草稿 chip 可能短暂空白，侧栏预览与 transcript 中的 catalog 不刷新）；Badge/面板经 `ctx.remote.$on('agent-preset/selected')` 订阅收敛帧按 session ID 过滤刷新（订阅不可用时显示「refresh to sync」提示），Apply 被接受后经 apply 引擎的 `invalidate` 钩子重发该事件（曾长期未接线，2026-10-06 修复）；typert 注册为幂等且每次读取前自愈（fiber 重挂载竞态不再致命）。旧实现的 cwd 三级回退（`agent/created` 缓存 → 存活 agents → 持久化 header）只能定位路径，不能确定预设归属；新的静默读从同一宿主会话观察同时取当前预设投影与 cwd，冷会话也不靠创建 header 猜预设，读中切换则拒绝旧结果。

### 消费者

所有 Skill 可用性消费者共享同一份预设层视图（[consumer-view.js](<../../plugins/weir-harness/src/capabilities/consumer-view.js>)）：选择 provider 的每会话候选（已选 + 可用 + 调用权限旗标）就是唯一事实来源，消费者只按用途（`model`／`user`）与旗标取交集，不各自保留授权副本、不叠加过滤层。

- **模型目录、`skill` 工具、slash 候选与提交**：stock 消费者已经选择 provider（第 3、4 组）。
- **委派 `load_skills`**（7.2）：派发前整批一次性预检（单一快照 revision），任一未选或不可模型调用即**整批零 spawn**——监督组名在预检失败时不被注册，可立即重用；`maxDepth: 1` 与精选只读契约不变。选择面经 realm 可见服务 `weirSkillSelection`（reflect）暴露，兄弟预设行从各自子 ctx 解析同一挂载面。
- **意图门指针**（7.3）：Skill 指针与提醒在注入前过同一资格判定；被抑制时不注入替代文本、首次命中保持 unarmed（后续可用时仍注入完整初始指针）、不撤回历史注入，审计只记录「未注入 + 原因」；非 Skill 意图行为不变。

## 边界与失败语义

- 存储单元损坏、版本未知或撕裂（digest 不符）：fail closed，返回 `unreadable`，保留原文件等待人工处置，绝不自动覆盖或删除。
- 锁被存活 owner 持有、owner 身份无法确认（外主机）、锁文件不可读：提交返回 `locked` 及具体原因，不写任何字节。
- 回收被中断（`.recover` 残留）：单元保持锁定并显示手动恢复入口，不自动清除他人残留。
- 平台矩阵以外的平台（darwin/win32 之外）或 `profileContext` 缺失：所有单元 unsupported，零写入。
- Apply 冲突与并发：同 expected revision 的并发 Apply 恰一胜，败者得到 `revision-conflict`、receipt 不被确认，旧 authority 与草稿保留。

## 测试

- 客户端回归：`client-capability-model.test.js` 覆盖同名草稿完整预检、字符串歧义/未知、精确替换与移除、身份/dirty/安全标签；`client-capability-manager.test.js` 覆盖双外壳、搜索隐藏、可访问告警、旧名称恢复按钮与 stale 回执；`client.test.js` 覆盖真实 Apply 命令包装的 `kind:'error'` JSON 解包与 chunk 内容绑定。自动测试不等于现有 desktop GUI 验收；须经合入、按用户允许重应用 bundle 后刷新页面观察。

- 单元测试：`plugins/weir-harness/test/capability-store.test.js`（17 例：路径解析与隔离、单元布局、fail-closed 解码、CAS 与幂等回执、锁获取／回收／手动恢复、平台桩零写入、win32 行真实提交、代次指针原子切换）。
- 多进程与故障注入：`plugins/weir-harness/test/capability-store-race.test.js`（真实子进程：两进程同 revision 恰一胜、两回收者竞争已死锁恰一个新 owner 且活锁零移除、SIGKILL 发布点循环只见完整旧/新记录）。
- 单元测试（Apply 事务）：`selection-draft.test.js`（dirty 语义）、`apply-engine.test.js`（六步 + 顺序断言 + 故障注入 + 通知语义/重启 delta 基准钉）、`apply-fence-recovery.test.js`（fence 恢复 / 幂等 / 静态红线 / 恢复路径通知恰好一次与静默边界）、`apply-wiring.test.js`（生产引擎接线的审计发射钉：挂载面提交 Apply + 钩子装配 recovery-`published` 结算）、`content-refresh.test.js`（refresh×Apply 并发、移除后 refresh）、`skill-admission.test.js`（三条阻断路径 + 发布前拒绝）。
- 集成测试：`plugins/weir-test-harness` 的 `apply-transaction` 场景——Apply 后收敛、并发冲突恰一胜、响应丢失按原 request ID 取回、移除后旧引用显式 unavailable。
- 集成测试：`plugins/weir-test-harness` 的 `capstore` 场景——探针分别在宿主层与 isolated `cordis:group` 内读取 `profileContext` 并经真实 store 往返一条选择记录，证明预设 realm 结构内存储根可解析（任务 2.1）。
- 单元测试（库存与身份）：`skill-identity.test.js`、`skill-inventory.test.js`（含宿主 0.2.0-rc.2 解析器生成的兼容性 fixture 逐文件比对，宿主漂移即红；生成器 `test/helpers/generate-host-reference.js`）、`skill-selection-provider.test.js`（精确加载、冲突呈现、挂载不抛出、invalidate 反例与重入闸门）、`skill-office-adapter.test.js`、`skill-composition.test.js`（patch 静态检查）。
- 集成测试：`plugins/weir-test-harness` 的 `skill-composition` 场景族（OFF／LEAK／HOST／office 四组合）：只有 OFF 形态下未选 Skill 不出现在模型目录、`skill` 加载、预设内消费者与 slash 列表；未选 office Skill 被同名遮蔽；预设不进入 `broken`。
