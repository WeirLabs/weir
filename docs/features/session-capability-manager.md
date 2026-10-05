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

### Apply 事务

选择编辑先进入**草稿**（[selection-draft.js](<../../plugins/orrery-harness/src/capabilities/selection-draft.js>)）：以 `baseSelectionRevision` 为基线维护规范化启用集合、unresolved requested refs 与局部筛选/布局；Apply 仅在规范化 enabled set 有实质变化时可用（还原、排序、搜索、元数据、安装、更新与身份不变的 content refresh 都不算变更）；显式空集不等于缺失；草稿是纯管理器侧状态，模型与工具读不到。

确认后走**六步事务**（[apply-engine.js](<../../plugins/orrery-harness/src/capabilities/apply-engine.js>)）：

1. 服务端从 authenticated session 定位 workspace/preset 并读取最新 accepted revision——不信任客户端传入的 cwd、scope root 或 server config；
2. 校验 requestId 与 payload digest（request digest 覆盖 expectedRevision）、expected revision、完整清单状态、精确身份与冲突（同名单多选直接拒绝，不任意取胜）、一致性条件（未满足显示 unsupported）；
3. 准备纯快照、过滤视图与已验证 content handle——不发布权限、不启动外部安装、不注入通知，准备失败保留旧 authority 与用户草稿；
4. 进入 admission fence，冻结尚未 handed-off 的能力调用与 prompt publication（MCP 排空接口已预留，实现见后续 MCP 组）；
5. 经自管存储在锁内 CAS 原子写入新 selection 与 receipt，随后在**同一个非异步段**内依次切换内存快照 → 调用 provider `control.invalidate()` → 解除 fence——`invalidate()` 先于解除 fence、先于发送响应，客户端收到响应后的第一次重取绝不会命中旧缓存；写入明确失败则解除 fence 并恢复旧快照，写入结果不确定则维持阻断，按原 request ID 查询 receipt 结算（`published`／`not-committed`／`blocked`——不宣称取消成功、不伪造回滚）；
6. 发送响应：accepted revision、effective sets、unresolved warnings 与发送时刻的排空状态快照，**不等待**排空完成。

配套纪律与机制：

- **审计**：`capability-apply` 类型注册于共享 [audit.js](<../../plugins/orrery-harness/src/shared/audit.js>)（cordis emit + `.orrery/audit.jsonl` 双写），发射失败 warn/swallow 且不改变 policy；`command/run`／`command/done`／审计日志都不是提交证据；新增代码静态保证不触碰 `session.append` 与自定义 session 事件（冷读红线）。
- **幂等与丢失响应**：receipts 随会话生命周期保留，清理不允许旧请求重放成第二次变更；已接受请求重放返回原 receipt，异参 ID 复用拒绝；durable acceptance 后响应丢失时按原 request ID 查询取回 accepted revision（「结果待确认」语义）。
- **content refresh 协调**（[content-refresh.js](<../../plugins/orrery-harness/src/capabilities/content-refresh.js>)）：refresh 用独立存储单元与 receipt/revision，但与 selection 共用同一会话级提交协调者，提交前重查 selection revision——被移除的 Skill 在 refresh 期间不会继续发布。
- **Skill 侧会话阻断**（[skill-admission.js](<../../plugins/orrery-harness/src/capabilities/skill-admission.js>)）：未选中 Skill 的 `skill` 调用返回显式 unavailable 且不加载正文；slash 提交由服务端在当前选择上再验证；正文异步读取结束、返回内容之前复核选择快照（已读取 ≠ 已授权）；接受移除后，未 handed-off 的正文加载与子代理 prompt 发布被拒。

### 目录与菜单收敛

冷会话（页面打开历史会话、尚无运行 agent）与实时会话看到同一份选择视图，但收敛路径不同：

- **无会话调用失败关闭**：宿主对无运行 agent 的调用只给 provider `{cwd, scope=预设常驻 key}`，provider 看不到会话 ID——此时**只能返回空列表**，绝不按目录或预设默认值猜测（同目录多会话选择不同时 cwd 键必然给错）。常驻 key 是预期的冷条件而非策略失败，因此不产生错误状态；office denial 阴影条目保留（它们是遮蔽宿主内置项的防线，不是可选择 Skill）。
- **打开即恢复、先空后收敛**：宿主打开历史会话会自动恢复（follow→promote），预设内 `agent/created` 监听器（agent 已 `enter` 之后）对**根会话**重发 `agent-preset/selected`（[preset-invalidation.js](<../../plugins/orrery-harness/src/capabilities/preset-invalidation.js>)：两参数必须是合法 JSON 字符串、取会话**实际**预设 id、全程 try/catch、子代理不发射）；Apply 被接受后同样重发一次。客户端收到帧后丢弃缓存重取，因此**冷会话打开瞬间菜单可能先为空，约一次恢复后收敛**——先空后收敛是允许形态，列出未选 Skill 不是。
- **已接受的语义拉伸**：该宿主事件原义是「会话提交了不同预设」，`dsh-client-ui-commands` 收到后也会重取命令列表（每次发射全客户端广播，故严格限定根会话 + Apply 两处）。若宿主将来提供专用修订事件，应切换过去（记入宿主后续依赖）。
- **恢复失败保持为空**：另一进程占用会话日志（writer-held）等恢复失败时，菜单保持为空且状态面给出稳定 `reason` 与可操作 `hint`（[selection-status.js](<../../plugins/orrery-harness/src/capabilities/selection-status.js>)），绝不回退为非空列表；`acceptSelection` 或显式 `clearFailure` 解除。
- **浏览器侧行为**（缓存丢弃、打开中菜单即时刷新、草稿 chip 短暂空白等）以服务端 + 模拟客户端缓存证据为准，真实 GUI 观察待 1.5 验证。

### 初始化与继承

会话生命周期的每个入口都在首次 prompt assembly 之前就位一份已接受选择的快照：

- **同步内存快照**（[lifecycle-snapshot.js](<../../plugins/orrery-harness/src/capabilities/lifecycle-snapshot.js>)）：插件 apply 时预载已知会话的已接受记录（[lifecycle-preload.js](<../../plugins/orrery-harness/src/capabilities/lifecycle-preload.js>)，内存优先），`agent/created` 监听器只做**同步读取**——内存未命中时恰好一次阻塞式同步磁盘读，绝不使用 Promise 接口的宿主 storage；模块全文零 `await`（静态测试钉死），成功路径恒返 `undefined`（cordis 串行 bail-on-value 教训）。G4b 实证失败形态是**让出**事件循环而非耗时（`sleep100` 失败、`busy100` 通过）。Apply 被接受后经 engine `publishSnapshot` 钩子在同一非异步段更新内存。
- **子代理快照 durable 捕获**：子代理的 `agent/created` 内用阻塞式同步 I/O（`writeFileSync` + `fsyncSync`，经第 2 组单元布局 `sessions/<id>/inherited.json` 与锁约定）捕获父已接受快照。捕获**并非**与宿主会话发布原子——如实陈述：崩溃窗口留下的无快照子代理在显式 resume 时按子代理 fail-closed 规则拒绝。
- **创建时继承**（6.3）：创建取父快照逐字（叠加委派约束 `allowSkills`/`allowMcpServers`，只缩不扩）；显式 resume／escalation 取「子原快照 ∩ 当前父快照」——被移除的能力不恢复、父新增的能力不下发；向仍存活子代理发消息（无 `agent/created`）不重新捕获，存活子代理的快照不被父的后续编辑改动。
- **读取路径**：子代理会话无 accepted 记录时从其 inherited 快照解析（`readSelection` 回退）；无快照的子代理被显式拒绝（`inherited-snapshot-unavailable`），绝不授予根基线。
- **fail closed 双规则**（6.4，每种情形恰好一条规则）：①根会话／已存在会话的选择记录不可读／损坏／未知版本 → 监听器**不抛出**，会话照常创建／恢复，视图为空 + 分类 reason/hint（`policy-unreadable:*`），原文件绝不改写；恢复 = 人工修复记录 + 新 Apply。②子代理的父快照不可读或无法捕获 → 监听器抛出拒创建，父会话继续并经委派结果得知原因。插件 dispose／reload 窗口保守拒绝（denials-only）。
- **初始化优先级**（6.5，[initial-selection.js](<../../plugins/orrery-harness/src/capabilities/initial-selection.js>)）：新根会话无 accepted 记录时——保存的工作区默认（含显式空集）逐字胜出并报告缺失项（默认不可解码则 fail closed `workspace-default-unavailable`）；无默认时内置 Skill 基线 + 组合中已启用的 managed MCP；历史内容不构成授权，本路径零持久化；闸门只对 `orrery` 预设生效（组合保证）。

### 预设与默认值

**预设库**（[preset-library.js](<../../plugins/orrery-harness/src/capabilities/preset-library.js>)）：`global` 与 `workspace` 两个 namespace（第 2 组存储的既有单元）；稳定 preset ID 与显示名分离——同 namespace 内显示名冲突必须显式 rename／replace／cancel（未确认替换即拒绝），跨 namespace 同名互不遮蔽；workspace 预设只在本工作区可见。所有写入与导入经 expected-revision CAS：stale revision 是显式冲突，绝不静默覆盖（两客户端改同一预设时新状态保持、旧请求收到冲突）。

**可移植文档与导入安全**（[portable-refs.js](<../../plugins/orrery-harness/src/capabilities/portable-refs.js>)）：Skill ref 白名单 = source kind + 无凭据 canonical repository + requested ref + subpath + logical name／target scope + 可选已解析 commit／digest；MCP ref 只含 Orrery 管理的逻辑 binding identity + 显示 label——URL、凭据、命令、参数、headers、环境值一律拒收。导入校验原子化（object-rooted schema：version、文档 ≤ 1 MiB、条目 ≤ 1000、字段 ≤ 4 KiB，未知字段与未知版本整体拒绝、零写入）。导入只**绑定**本机已配置的 identity：不创建、不启动、不接受连接内容。

**unresolved 语义**（9.3）：未解析的 ref 保留在 requested metadata 里，绝不进入 enabled 草稿；安装后仍需用户单独勾选并 Apply；同名项不替代；加载或导入不触发网络、安装或启动。

**工作区默认值**（[defaults-transaction.js](<../../plugins/orrery-harness/src/capabilities/defaults-transaction.js>)）：「保存为工作区新会话默认值」是独立事务——确认面点名记录的精确能力与 scope、逐项警告无法解析项；记录的是 draft resolved sets + unresolved refs 的**拷贝快照**（保存后草稿独立演化）；不需要先 Apply、也绝不改变当前会话；显式空集是可保存的真实选择，而**清除 = 不存在**（新会话回到内置基线）；绑定工作区稳定身份（canonical 根路径摘要，工作区改名不影响绑定）；保存／清除经 CAS，并发保存显式冲突。

### MCP 会话级关闭

Orrery 是自身所管理 MCP server 的唯一挂载入口：用户经 Orrery 配置的 server 由 Orrery 在运行时逐个挂载（每个 server 一个隔离 `cordis:group`：代理 facade + stock `dsh-mcp-client`，经宿主支持的 loader API 创建/销毁，崩溃残留行启动时清理），会话选择决定每个 agent 能用哪些。

**预设行 realm 布局**：manager 行经 reflect 发布 `orreryMcpGate` / `orreryMcpManager` 两个服务，而预设注册审计拒绝任何进入根 realm 的预设服务（`Preset services require isolate realms`），因此 `orrery-mcp-manager`（提供者）与 `orrery-skill-selection`（消费者，`/capabilities list` 读取 manager 列表）同置于预设的 `capabilities` cordis 组、由该组 isolate 这两个服务（S11 同 realm 纪律，`preset-realms` 单测对拍守卫）；facade 侧经模块级 realm bridge 取闸门面，不跨 realm 读服务。

**保证等级（如实措辞）：**

| 对象 | 保证 |
|---|---|
| Orrery 管理的 server | **网关级强制**：工具调用在**包装后定义的 `execute` 最开头**按「注册表 configured identity + registration generation + 会话已接受集合 + lifecycle 快照」准入（被拒调用零 RPC 到达 server，G3b 语义）；三个资源操作按目标 server 在派发时门控；`mcp:<server>` 指令段每次 prompt 组装时按 agent 过滤；Apply 移除后「关闸 → 等待在途 → 超时只报告仍在途」，不承诺强制取消，外部副作用不可撤销 |
| 工具 schema | **按 agent 在创建时隐藏**（`tools.restrict` 创建时快照）：只对 Apply 之后创建的 agent 成立；live Apply 后既有 agent 的旧 schema 可能仍可见，但每次派发都在任何 server 活动前被拒——不声称 schema 已从该 agent 的请求中消失 |
| 宿主直接配置／ACP／其他预设挂载的 server | **不提供任何保证**：一律显示为 **unmanaged**，管理器不提供关闭开关、不声称已关闭、不计入关闭统计 |

**软化条款（如实记录）**：准入基于 Orrery 注册层派生的 configured identity 与 registration generation（重连以同 identity 的新 generation 续接，同名不同 identity 不继承授权），范围限于 Orrery 管理的 server；宿主发布的权威身份/generation 与 SDK 最终准入是未授权的后续依赖。`tools/pre-execute` 只作额外早拒，唯一防线是包装定义的最后一刻校验。

**组合期歧义**：一个 configured name 是另一个的 `__` 前缀、或同一公开名被两个 server 声明时 fail closed 拒挂其一（不猜测）；facade 遇到未知宿主方法时该 server fail closed 并可见报错。崩溃残留 `orrery-mcp-*` 行启动时识别并清理。

**纳入 Orrery 管理（adopt）**：现有宿主配置不被自动接管；用户确认后才在注册表创建 identity——宿主原条目仍持有先到先得 `serverName` 保留时显示为**冲突**（提示用户自行停用宿主条目，之后由 managed client 接管），绝不显示为成功。便携式 MCP ref 只指向 Orrery 管理的逻辑 binding。

### 管理界面与通知

**会话 Badge 与管理器**（客户端 `lib/client.capability-*.js`，服务器 `/capabilities` 命令）：Badge 挂在 `conversation.input.right`（order 95，紧邻 LSP order 100），显示的已应用 Skills/MCP 计数一律以**服务端回执**为准（draft 绝不乐观显示）；空白会话凭明确 session ID 打开。管理器面板按需 lazy：Skills/MCP 两个视图、来源标签（Orrery 内置/user/project/custom）、冲突与缺失标记、搜索；MCP 视图按 **Orrery 管理** 与 **unmanaged** 分组（8.8）；未满足的一致性条件显示显式 **unsupported** 而非隐藏控件，与 loading/unknown 区分；恢复失败显示原因。草稿交互（12.3）：关闭 dirty draft 提供 discard/keep editing；提交中复用同一 request ID；失败保留草稿；revision conflict 显示当前状态让用户重选（不静默 rebase）；无 diff 但有缺失警告时提供 install/configure 而不虚构 Apply；结果待确认可查询。

**给模型的移除通知**（12.4，[selection-notify.js](<../../plugins/orrery-harness/src/capabilities/selection-notify.js>)）：Apply 被接受后净增减跨多次应用合并，在**下一次安全请求**时以完整 UserMessage（共享 helper）随该请求注入——绝不自行触发回合、不在 `session/event` 内同步 followup；来源标记为 `orrery-selection-notify`（非 `user`），intent gate 与 continuation/intent 分类器按构造排除（共享 `isGenuineUserMessage` 只认 `source.kind === 'user'`）；英文 advisory 模板明确「已 handed off 的调用仍可能完成、历史中任何回合或调用不被撤回或抹除」；注入失败只 audit/warn，绝不影响已接受的提交。

**收敛语义（D-E）**：服务端精确性立即生效（任何调用以服务端校验为准）；宿主 `/` 菜单经 provider `invalidate()` + 5.2 的重发事件收敛（草稿 chip 可能短暂空白，侧栏预览与 transcript 中的 catalog 不刷新）；同会话第二窗口的 Badge 尝试订阅宿主转发的 `agent-preset/selected` 帧按 session ID 过滤刷新，订阅不可用时显示「refresh to sync」提示而非静默过期（浏览器侧实际效果待 13.3 验证，不在此声称已收敛）。

### 消费者

所有 Skill 可用性消费者共享同一份预设层视图（[consumer-view.js](<../../plugins/orrery-harness/src/capabilities/consumer-view.js>)）：选择 provider 的每会话候选（已选 + 可用 + 调用权限旗标）就是唯一事实来源，消费者只按用途（`model`／`user`）与旗标取交集，不各自保留授权副本、不叠加过滤层。

- **模型目录、`skill` 工具、slash 候选与提交**：stock 消费者已经选择 provider（第 3、4 组）。
- **委派 `load_skills`**（7.2）：派发前整批一次性预检（单一快照 revision），任一未选或不可模型调用即**整批零 spawn**——监督组名在预检失败时不被注册，可立即重用；`maxDepth: 1` 与精选只读契约不变。选择面经 realm 可见服务 `orrerySkillSelection`（reflect）暴露，兄弟预设行从各自子 ctx 解析同一挂载面。
- **意图门指针**（7.3）：Skill 指针与提醒在注入前过同一资格判定；被抑制时不注入替代文本、首次命中保持 unarmed（后续可用时仍注入完整初始指针）、不撤回历史注入，审计只记录「未注入 + 原因」；非 Skill 意图行为不变。

## 边界与失败语义

- 存储单元损坏、版本未知或撕裂（digest 不符）：fail closed，返回 `unreadable`，保留原文件等待人工处置，绝不自动覆盖或删除。
- 锁被存活 owner 持有、owner 身份无法确认（外主机）、锁文件不可读：提交返回 `locked` 及具体原因，不写任何字节。
- 回收被中断（`.recover` 残留）：单元保持锁定并显示手动恢复入口，不自动清除他人残留。
- 不支持的平台或 `profileContext` 缺失：所有单元 unsupported，零写入。
- Apply 冲突与并发：同 expected revision 的并发 Apply 恰一胜，败者得到 `revision-conflict`、receipt 不被确认，旧 authority 与草稿保留。

## 测试

- 单元测试：`plugins/orrery-harness/test/capability-store.test.js`（16 例：路径解析与隔离、单元布局、fail-closed 解码、CAS 与幂等回执、锁获取／回收／手动恢复、平台桩零写入、代次指针原子切换）。
- 多进程与故障注入：`plugins/orrery-harness/test/capability-store-race.test.js`（真实子进程：两进程同 revision 恰一胜、两回收者竞争已死锁恰一个新 owner 且活锁零移除、SIGKILL 发布点循环只见完整旧/新记录）。
- 单元测试（Apply 事务）：`selection-draft.test.js`（dirty 语义）、`apply-engine.test.js`（六步 + 顺序断言 + 故障注入）、`apply-fence-recovery.test.js`（fence 恢复 / 幂等 / 静态红线）、`content-refresh.test.js`（refresh×Apply 并发、移除后 refresh）、`skill-admission.test.js`（三条阻断路径 + 发布前拒绝）。
- 集成测试：`plugins/orrery-test-harness` 的 `apply-transaction` 场景——Apply 后收敛、并发冲突恰一胜、响应丢失按原 request ID 取回、移除后旧引用显式 unavailable。
- 集成测试：`plugins/orrery-test-harness` 的 `capstore` 场景——探针分别在宿主层与 isolated `cordis:group` 内读取 `profileContext` 并经真实 store 往返一条选择记录，证明预设 realm 结构内存储根可解析（任务 2.1）。
- 单元测试（库存与身份）：`skill-identity.test.js`、`skill-inventory.test.js`（含宿主 0.2.0-rc.2 解析器生成的兼容性 fixture 逐文件比对，宿主漂移即红；生成器 `test/helpers/generate-host-reference.js`）、`skill-selection-provider.test.js`（精确加载、冲突呈现、挂载不抛出、invalidate 反例与重入闸门）、`skill-office-adapter.test.js`、`skill-composition.test.js`（patch 静态检查）。
- 集成测试：`plugins/orrery-test-harness` 的 `skill-composition` 场景族（OFF／LEAK／HOST／office 四组合）：只有 OFF 形态下未选 Skill 不出现在模型目录、`skill` 加载、预设内消费者与 slash 列表；未选 office Skill 被同名遮蔽；预设不进入 `broken`。
