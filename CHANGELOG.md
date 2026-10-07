# Changelog

本项目的所有重要变更都记录在此文件。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **会话黑板（切片二：Agent 契约、订阅投递与黑板面板）**：子 Agent prompt 现在携带黑板写入契约（四触发器、search-before-create、结算报告引用条目 key），主 Agent 派发前会先查板并把相关 key 写进子任务；写入权释放/删除/超时现在会真实投递给订阅的 Agent（不触发新回合、不写会话日志）。右侧栏新增**黑板面板**：条目按类型分组、可过滤搜索、点开看完整信息与读写计数；创建/编辑/删除与助手走同一套写入权仲裁（先申请、持权倒计时、被占用可订阅待释放）；数据走插件自有 typert remote 通道，读操作零会话日志。设置页新增「黑板」组，写入权 TTL（默认 60 分钟）可直接在线调整。详见 [会话黑板](docs/features/blackboard.md)。

- **会话黑板（切片一：核心机制）**：会话级的结构化知识交换所已具备内核——逐会话独立的条目存储（key + 封闭类型枚举 `map`/`contract`/`deadend`/`wiring`/`recipe`/`why` + 结构化摘要 + 完整信息 + 用量计数）、写入权仲裁（一次性令牌、TTL 默认 60 分钟可配 `blackboardWriteTokenTtlMinutes`、竞争自动订阅、超时与终止自动释放），以及五个模型工具（`blackboard_list`/`blackboard_read`/`blackboard_apply`/`blackboard_write`/`blackboard_delete`，挂载进两个预设的隔离 delegation realm）。侧边栏面板、订阅通知投递与晋升评估按钮随后续切片交付。详见 [会话黑板](docs/features/blackboard.md)。

## [0.9.5] - 2026-10-07

### Added

- **车道绑定的可续作工人（continuable + worktree 放开）**：`delegate` 的 `mode: "continuable"` 与 `worktree` 从互斥拒绝变为合法组合——车道绑定的 continuable 工人自动以隐式监督身份运行（隐式组名 `lane:<车道id>`，保留前缀，显式组名占用会被拒绝），自动获得 STATUS 终态契约、`resume_agent`/`terminate_agent`/`supervised_status` 支持与正确的车道结算语义。工人报 `STATUS: blocked` 时车道保持绑定（`working`，他人再绑仍拒 `LANE_BUSY`），主 Agent 补充上下文 resume 后在原车道续作，终态汇报时宿主才检查车道。用户不再需要知道"想要可恢复的车道工人就得手动开 supervised group"。详见 [类别委派文档](docs/features/category-delegation.md) 与 [Worktree 车道文档](docs/features/git-worktree.md)。

- **设置项条件显隐与子设置项**：Orrery 设置页的每个条目获得两个声明能力——可见性条件（可引用其他设置项的生效值或宿主平台等环境事实，支持与/或/非组合；翻动开关即时显隐、无需保存，被隐藏条目的已保存值与草稿原样保留）与父子层级（子项自动归位到父项正下方、支持多级嵌套、父隐则子隐，以缩进与引导线呈现）。落地效果：各功能细调参数只在其总开关打开时出现，模型选择器仅在意图分类器选 LLM 时出现，Jev 选项仅在选 Jev 时出现，pwsh 白名单仅在 Windows 宿主出现。声明非法（指错父级、条件引用未知键）在页面加载时即报错而非渲染错误布局。详见 [设置页文档](docs/features/settings-page.md)。

- **Worktree 车道自动授权（逐会话三档）**：仿 DSH 沙箱授权机制，`/worktree approve <manual|auto-keep|auto-clean>` 逐会话切换：`manual` 保持逐张卡片批准（现状）；`auto-keep` 自动批准合并与放弃、收尾清理 worktree 保留分支；`auto-clean` 自动批准合并与放弃、收尾清理 worktree 与分支。自动模式下动作仍由助手显式发起，全部落地前置检查、冲突预检与失败语义不变（审计载荷带 `auto` 标记），只是不再弹卡；放弃删除未合并分支时结果摘要写明丢弃的提交数；失效绑定的 force-reclaim 永不自动，一律回退手动确认卡。新会话的初始模式由设置项「Worktree 车道 → `worktreeAutoApprove`」决定（默认 `auto-clean`），车道面板工具条可直接切换。详见 [Worktree 车道文档](docs/features/git-worktree.md)。
### Changed

- **设置入口统一为全局设置**：Orrery 设置不再出现在插件面板，唯一入口是全局设置面板的 Orrery 分区（UI 层面 breaking：习惯从插件面板进入的用户改从全局设置进入）。同一张表单两处入口并存造成的「以哪处为准」困惑随之消除。详见 [设置页文档](docs/features/settings-page.md)。
- **设置页视觉重构为卡片分区**：九个分组各成一张卡片（层级背景、边框、组内分隔行），子设置项按层级缩进；重启生效选项行内常驻「需重启」标记（与保存后弹窗同一名单来源），不再只能靠保存后的弹窗识别。全部用色来自主题令牌，深浅主题均正确。
- **自定义 LSP 服务器不再显示原始 JSON 输入框**：该字段与下方 LSP 管理面板编辑的是同一个值，原始输入框完全冗余（与模型链、白名单「不再手写 JSON」同一产品模式）。原始行已折叠进管理面板行：「已覆盖」标记与「恢复默认」按钮移至面板行上，存储值损坏（非法 JSON）时面板行显示报错态且面板仍可以空列表打开、保存即覆盖修复，任何存储态都不会把字段卡死。字段本身与存储语义不变。

### Fixed

- **设置页「车道自动授权默认」改为紧凑下拉菜单**：该枚举项（`worktreeAutoApprove`）此前用分段控件渲染，三个较长选项把行标签挤成竖排。现在以紧凑下拉菜单呈现（未设置时仍显示默认项 `auto-clean` 为选中态），其余短值枚举项保持分段控件不变。详见 [设置页文档](docs/features/settings-page.md)。
- **编辑锁面板：多预设共存时状态视图不再错挂「启动中」**：`orrery` 与 `orrery-creative` 同时挂载编辑锁时，状态视图端点由先挂载的预设服务全部会话，后挂载预设（如创造模式）的会话因查不到本挂载绑定而永久显示「编辑锁启动中」（功能本身不受影响）。端点现在把存活会话的视图请求路由到其所属挂载的观察面，答案与挂载顺序无关；绑定失败返回带原因的不可用而非无原因「启动中」；重复路由注册容错跳过。详见 [编辑锁特性文档](docs/features/edit-lock.md)。

- **编辑锁：会话切换预设后编辑不再永久失效**：创建后、首轮前切换预设（如 orrery → orrery-creative）时宿主不重发 `agent/created`，编辑锁绑定随旧代挂载孤儿化，受管写入被永久拒绝且无任何会话级恢复路径（两起实证）。现在三层自愈：① 预设切换事件驱动对本预设会话自动重绑定（幂等，foreign 预设不绑）；② 写入守卫与锁工具遇到「本预设会话无绑定」先做一次幂等懒绑定重试再判定；③ 绑定失败四联留痕（面板原因 + 维护证据 + 会话内通知 + 审计），拒绝文案点名真实原因与恢复动作。前置修复：受管 write 注册的 disposer 跨挂载代留存、重安装先 retire 旧层，消除了连手工重绑都会失败的 duplicate-register 障碍。详见 [编辑锁特性文档](docs/features/edit-lock.md)。

- **车道绑定不再被 blocked 提前结算**：supervised 车道工人报 `STATUS: blocked` 时，此前车道会被立即释放并触发过早的宿主检查，resume 后续作期间的提交不再受单写入者保护、也永不再被检查。现在车道结算只在终态（completed/terminated/terminate）发生，blocked 全程保绑定。配套对齐：僵尸绑定对账的终态铁证不再认 blocked（审计 settle fact 须为 completed/terminated、子会话日志须为 `STATUS: completed`），监督重建补发跳过 blocked 成员——blocked 是"待命"不是"终态"，双冷 + 仅 blocked 证据时维持拒绝，用户可经 abandon 卡强制回收兜底。

- **失效车道绑定可自动/受控回收**：车道绑定工人的属主会话死亡或失联后，车道此前永久卡在 working——abandon/check/再绑定一律被 LANE_BUSY 拒绝（实证曾停滞近 14 小时）。现在三层防护：① abandon/check/再绑定被拒前对绑定做只读活性对账，仅当子代理存在终态铁证（审计 settle/terminate fact 或子会话日志终态报告）且属主与子代理均无存活证据时，自动结清绑定并放行（审计留痕 `worktree/reconcile-binding`；任一方在线或无铁证一律维持拒绝——不在线不等于死亡）；② 宿主重启重建监督状态时，对被恢复流程提升为终态的绑定子代理补发结算，存量僵尸车道自动解套；③ 对账未放行时，abandon 确认卡展示对账结论并提供强制回收选项（用户显式确认才执行，同样留痕）。详见 [Worktree 车道文档](docs/features/git-worktree.md)。

- **设置页六个布尔开关默认值显示错误**：「编辑锁自动恢复」「编辑锁过期清扫」与系统通知的四个开关（总开关、完成时、需要您时、提示音）此前未被纳入设置页的产品默认值镜像——只要保存过任意设置且未触碰这些键，它们就显示为「关」（新引入的条件显隐还会随之隐藏其子项），而模块实际默认是「开」。现在显示与模块真实默认一致。
- **设置页未设置的输入框不显示默认值**：数字/文本输入框在未设置时渲染为空、枚举分段控件无选中项，用户看不到实际生效的产品默认（此前只有布尔开关会显示生效默认值）。产品默认表现已收口为 `src/settings/sections.js` 的 `FIELD_DEFAULTS` 权威声明（39 键，与模块代码默认 1:1，客户端镜像/模块常量/bundle 行配置三层测试钉住）：未设置的数字/文本输入框直接显示默认值、未设置的枚举分段控件选中默认项；草稿与已保存值始终优先，清空输入回退为显示默认，显示默认的未设置项不产生覆盖也不被保存写入。路由继承类字段（provider/model、模型链、白名单追加表等「空即有意义」的键）保持空白，不伪造默认值。详见 [设置页文档](docs/features/settings-page.md)。

### Removed

- **Orrery 预设排除 DSH goal 功能**：`Orrery` 与「Orrery 创造模式」预设不再挂载 goal 行——`create_goal`/`get_goal`/`update_goal` 工具、`/goal` 斜杠命令与 goal 系统提示词段落从 Orrery 系会话中消失，goal 轮转续推随之不再触发（目标根本无法注册）。goal 的「单 Agent 自续推」语义与 Orrery 以编排者为中心、事件驱动的多 Agent 协作并存时产生两套续推机制、干扰协作流程，故按设计排除；其他预设（standard 等）不受影响。委派子代工具 deny 名单、Worktree 车道契约与 `deep-work` 技能中引用 goal 工具的残留一并清理。详见 [预设打包](docs/features/preset-packaging.md)。

### Fixed

- **客户端构建校验不再误报「chunk 比入口新」**：`test/client.test.js` 的 mtime 顺序断言在 git 合并/checkout/克隆重新落盘 `lib/` 后必然假阳性（落盘顺序任意，实测合并仅差 0.758ms 即颠倒），每次车道合并后都要手动 restamp 才能转绿。断言本意（改了 chunk 必须重跑 build）已由入口 manifest 的 sha256 内容绑定确定性覆盖，mtime 断言移除；构建纪律简化为「改 chunk 后跑 `pnpm build`」。详见 [客户端模块切分文档](docs/features/client-module-chunking.md)。

- **编辑锁：冷会话面板不再卡在「启动中」**：重启后打开的历史会话（GUI 冷读、无存活 agent）此前让状态端点查无 agent，面板永久显示「启动中」。端点现在冷读安全——经会话冷观察与只读权威镜像回答真实状态（已停止／异常／保留／ revoked 终态与域锁列表），冷会话的主动作改为指引「发送任意消息即自动继续编辑」（auto-resume 语义）；无法解析的会话给出带明确原因的「不可用」。写动作不开放冷通道，绑定仍在你发首条消息时的既有路径完成。详见 [编辑锁特性文档](docs/features/edit-lock.md)。

- **Capabilities 工作区默认值对新会话不生效（恒为 0/0）**：`default-save from:'draft'` 把客户端草稿（纯技能名字串）原样落盘，而新会话初始化读侧期望 SkillIdentity 身份对象——provider 对字符串逐项抛 `Invalid skill scope` 后 fail-closed，该工作区每个新会话都从零技能起步。修复后默认值记录以名字为引用：新会话初始化时把名字条目按当前库存**唯一匹配**绑定为身份，已下架或有歧义的条目逐项进入缺失报告（不猜测、不拖垮整个默认值）；`from:'applied'` 保存的身份形态记录逐字通过。存量记录无需手工修复即恢复生效。详见 [会话能力管理器](docs/features/session-capability-manager.md)。

- **能力 Badge 点击后残留外描边高亮**：Badge 切换按钮的 `onFocus` 处理器此前无条件绘制 2px 焦点环，鼠标点击后按钮保持焦点，高亮框选便一直挂着。焦点环改为 `:focus-visible` 语义——pointerdown 标记输入模态、随后的 focus 不再描边，鼠标/触摸点击彻底不再出现框选；键盘 Tab 聚焦仍绘制焦点环，可达性不变。

- **工作区默认值中重名技能永不持久化（如 16 个里恒缺 research）**：默认值记录只存名字串时，库存中同名的技能（如 builtin 与 user scope 各一份 `research`）在新会话唯一名绑定时被 fail-closed 拒授权，且从草稿反复重存也无济于事（歧义在库存不在记录）。`default-save from:'draft'` 现在在服务端把草稿名字**解析为精确 SkillIdentity 再落盘**（落实设计文档的 resolved sets 契约）：唯一库存匹配直接定；重名时以会话当前已应用选择消歧（恰有一个同名已应用身份才采用，绝不猜测）；无法解析（missing）或仍歧义（ambiguous）显式报错、零写入。身份形态条目逐字通过。在 `research` 已生效的会话重存一次默认值即永久修复。详见 [会话能力管理器](docs/features/session-capability-manager.md)。

## [0.9.0] - 2026-10-07

### Added

- **委派：continuable 形态（`mode: 'continuable'`）**：`delegate` 新增 `mode` 选项——`continuable` 子代立即返回稳定 childId、结果经内建结算通知送达，父代理可用 `send_message` 追问或中途纠偏（子代保留全部上下文）、`interrupt_agent` 打断当前回合而不销毁它，应用重启后冷恢复仍可续聊。默认 `one-shot` 不变；`mode` 与 `group` 互斥，continuable 与 `run_in_background`、`worktree` 互斥（均以明确错误拒绝）。continuable 子代占用运行时续聊容量（默认 8），容量满时以点名上限的错误失败，不排队、不降级。详见 [委派特性文档](docs/features/category-delegation.md)。
- **编辑锁：崩溃自愈（全程无人工）**：publisher 预约现在携带活性凭证（pid／启动身份／boot 标识／租约，周期续约）；崩溃残留的预约在「租约超时且 owner 被证明死亡」时经串行化路径自动回收，域自动恢复；上一进程生命周期留下的未决发布（unknown）在重启时自动行政结清——受控创建不再被历史围栏永久阻断，`unknown` 结论与操作历史原样保留，过程只有一条事后汇总通知与完整审计。镜像演进至 v6（incarnation 记录进程身份，旧版本无损升级、旧 build 拒绝读取）。详见 [编辑锁特性文档](docs/features/edit-lock.md)。
- **编辑锁：在线管理员恢复（一键、无重启）**：publisher 进程仍活着时的未决发布，设置页「编辑锁维护」面板直接给出恢复卡片——完整 scope、迟到写者风险原文与确认摘要（面板按离线路径同一算法自行计算并展示），点一次「在线结清」即在运行中的管理器里结清：不再要求「停用功能＋重启＋手打哈希」。离线 ADMIN OVERRIDE 保留用于 runtime 不可用的场景。详见 [编辑锁特性文档](docs/features/edit-lock.md)。
- **Worktree 车道：清理前编辑锁残留警示**：land／abandon 删除 worktree 前，只读检查主管理域编辑锁权威中该 lane 会话的残留（未决操作与锁），有则在清理卡片上警示并给出结算路径（锁由静默清扫自动处理、未决发布由崩溃自愈或面板一键结清），警示不阻断清理。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。

### Fixed

- **创造模式限定技能导致普通预设会话 Apply 整批失败**：工作区默认值/预设库携带的创造模式技能（如 cordis-plugin-development）在普通 orrery 会话无法解析，此前任何 Apply 都被整批拒绝且只提示笼统失败。现在 Apply 自动**跳过**「已知但当前预设不适用」的条目（回执与面板逐条列明），其余正常提交、记录无损（切回创造模式自动恢复可用）；真正不存在的名称仍然明确报错。设置页同时修复「静默清理失效锁」开关默认显示为关（实际运行为开）的默认值声明。
- **能力 Badge/面板反复显示「能力不可用」**：一组同族缺陷——typert 注册随 fiber 重挂载被静默撤回、cwd 解析错过启动恢复竞态且对无存活 agent 的历史会话无解、客户端订阅收敛帧调用了不存在的 API、Apply 后失效事件从未接线重发。修复：注册改为幂等且每次读取前自愈；cwd 解析依次走 事件缓存→存活 agent 注册表→**持久化会话日志头**（历史会话冷打开不再有竞态）；Badge 收敛订阅改走 `ctx.remote.$on`；Apply 被接受后正确重发失效事件，面板与 Badge 实时刷新。详见 [会话能力管理器](docs/features/session-capability-manager.md)「会话 Badge 与 Capabilities 面板」。

- **Worktree 面板重启后首个会话显示为空**：GUI 查看恢复会话走冷读（`page`/`follow`/`projections`），从不激活 agent，而车道面板的只读端点只认 live agent——重启后首个会话得到 `SESSION_NOT_LIVE` 降级视图，面板挂载时读一次又不重试，直到切换会话重挂载才恢复。端点的会话解析改为冷读安全：live agent → 已 attach 会话 → `sessionQuery` 冷观察（车道账本是仓库级数据，只需 `header.cwd` 与会话 id；Worktree 模式取冷折叠的 `orreryWorktree` 投影），重启后面板立即可读；diff 端点同样打通。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。

- **集成测试装置：修复负载下的确定性场景失败**：`rehydrate`/`escalate`/`delegate-preflight` 三个场景的等待逻辑此前门控在「最后一条消息的角色/内容」上，宿主注入的 runtime-context 快照在负载下插队于 tool result 与下一请求之间时门控错位，mock 落兜底文本导致回合提前结束、headless 在子代理运行中退出（表现为负载下确定性红、空闲独唱全绿）。等待改为 transcript 历史标记驱动的交错容忍原语（mock-kit 单点实现，有界重试），并对全部场景驱动逐一审查转换承重门控；同时 `run.mjs` 默认 IT root 增加咨询锁——同 checkout 并发套件自动改用私有后缀 root（响亮提示一行），不再互相 wiping。详见 [集成测试装置文档](docs/features/integration-test-harness.md)。
- **集成测试装置：回放夹具自包含**：`.gitignore` 对 `.orrery/` 的全局忽略曾吞掉夹具工作区内的回放状态文件（`audit.jsonl`、车道账本），而逐夹具手工例外只覆盖两个老夹具——后录制的 `worktree-watch`/`editlock-stale-sweep` 的状态文件从未入库，全新 checkout 或新 worktree lane 中其回放必红（`editlock-stale-sweep` 连主 checkout 都红）。例外规则已通配化覆盖全部夹具工作区（可入库状态文件种类枚举单点声明），新增 conformance 测试逐夹具校验回放消费的文件全部被 git 跟踪——今后录制出不自包含的夹具当场被抓；主工作区的历史残留未跟踪状态已清算。详见 [集成测试装置文档](docs/features/integration-test-harness.md)。

## [0.8.0] - 2026-10-06

### Added
- **编辑锁：失效锁静默清扫（默认开启）**：你发送任意消息时，系统会为该工作区的编辑锁管理域调度一次静默清扫——凡是锁目标文件已不存在（被外部删除或移动）的锁，经仲裁点逐字段复核（owner／generation／epoch／锁状态与观察时刻一致、且目标在执行点仍缺失）后按普通释放自动清理，不再只能逐个手动 `/edit-lock unlock`。未决发布围栏保护的归属绝不被触碰；清扫不写入对话，每次释放经共享审计留痕；运行时注入消息不触发，每个管理域 60 秒冷却且单飞。设置页「编辑」组新增开关可关闭，即时生效。详见 [编辑锁特性文档](docs/features/edit-lock.md)。

- **Orrery 创造模式（新预设变体）**：预设选择器新增「Orrery 创造模式」——完整的 Orrery 工作方式（意图门、分类委派、todo 续推、自动压缩、锚点编辑等全部保留）融合 DSH 创造模式的能力：只读运行时检查工具（`cordis_inspect_list`/`cordis_inspect_query`）、持久化插件管理工具，以及四项 Cordis 插件/预设开发技能（`agent-experience`、`cordis-plugin-development`、`editing-cordis-compositions`、`cordis-composition-reference`，首次会话即默认启用）。用于开发、调试和实验 DSH 本身；「Orrery」预设与进行中会话完全不受影响。详见 [预设打包](docs/features/preset-packaging.md)。
- **Orrery 创造模式：内置使用指引**：创造模式会话的系统提示词新增 `orchestrator:creative-guide` 段（紧随 Orchestrator 协作规则）——运行时检查的正确调用顺序（先 list 后 query、只读语义）、插件管理纪律（先列表再操作、改动经禁用→启用重应用、版本豁免需明示风险）、四项开发技能的加载时机，以及插件组合纪律（ctx-only、object-rooted schema、isolate realm）。仅创造模式会话携带；「Orrery」预设不变。详见 [预设打包](docs/features/preset-packaging.md)。

- **会话能力管理器：Skill 侧「库存、身份与选择 provider」（破坏性可见性变化）**：Orrery 会话起只看到**已选** Skill——未选中的第三方 Skill 不再自动出现在模型目录、`skill` 加载与 slash 列表。Skill 选择由预设内唯一选择 provider 承载（官方形状：宿主注册表 + stock `tool-skill`；宿主层 `skill-filesystem`/`tool-skill` 由 patch 行显式禁用），自有原始枚举保留同名遮蔽候选与失败现场（unparsed／last-good），按身份精确加载（同名未选不替代、同名单多选须显式解冲突），挂载绝不抛出、读取失败 fail closed 为空选择＋可见错误状态；内置十项 Skill 改标 Orrery 内置并经首次运行迁移检查（等价性不满足即 fail closed）。选择记录尚不存在的会话看到空目录与状态提示；选择编辑（Apply）与管理器界面随后续任务组交付。详见 [会话能力管理器](docs/features/session-capability-manager.md)。
- **会话能力管理器：Apply 事务引擎（服务端机制）**：选择编辑的草稿模型（仅规范化启用集合的实质变化才可 Apply，显式空集 ≠ 缺失）与六步 Apply 事务（会话定位 → 校验 → 准备 → admission fence → 原子写入＋同段快照切换/invalidate/解栏 → 响应）。`invalidate()` 先于响应，客户端重取必见新选择；并发 Apply 恰一胜；写入结果不确定时维持阻断、按原 request ID 查询 receipt 结算，不宣称取消、不伪造回滚；receipts 幂等防重放；content refresh 与选择共用提交协调者且提交前重查 revision；未选中 Skill 的调用/正文加载被会话级阻断（显式 unavailable，已读取 ≠ 已授权）。管理器编辑界面随后续任务组交付。详见 [会话能力管理器](docs/features/session-capability-manager.md)。
- **会话能力管理器：冷会话与菜单收敛**：冷会话（打开历史会话、尚无运行 agent）的技能目录失败关闭为空列表，绝不按目录或预设默认值猜测；页面自动恢复后由预设重发失效事件驱动客户端丢弃缓存重取（先空后收敛，约一次恢复）；Apply 被接受后同样重发。恢复失败（如另一进程占用会话日志）时菜单保持为空并显示稳定原因与可操作提示，不回退为非空列表。浏览器侧即时刷新行为待真实 GUI 验证。详见 [会话能力管理器](docs/features/session-capability-manager.md)。
- **会话能力管理器：生命周期就绪与子代理继承**：每个会话入口在首次 prompt 组装前就位已接受选择快照——插件启动时同步预载、`agent/created` 监听器全程零让出；子代理创建时以阻塞式同步 I/O durable 捕获父已接受集合（只缩不扩），显式 resume／升级按「子原快照 ∩ 当前父快照」重算，被移除的能力不恢复、父新增的不下发；根会话选择记录损坏／不可读时技能视图失败关闭为空并显示原因与恢复提示（人工修复 + 新 Apply 恢复），子代理缺父快照直接拒绝创建；新根会话按「工作区默认 > 内置基线」初始化，历史内容不构成授权。详见 [会话能力管理器](docs/features/session-capability-manager.md)。
- **会话能力管理器：统一 Skill 消费者视图**：模型目录、`skill` 工具、slash、委派 `load_skills` 与意图门指针现在都从同一份会话选择视图取结论。委派的 `load_skills` 在派发前整批预检——只要含一个未选或不可调用的技能就整批拒绝、零 spawn，被监督组名不会被失败的批次占用；意图门在技能未选或不可模型调用时不再注入指针（审计注明原因），该技能可用后首次命中仍会注入完整指针。详见 [会话能力管理器](docs/features/session-capability-manager.md)与 [意图门](docs/features/intent-gate.md)、[委派](docs/features/category-delegation.md)特性文档。
- **会话能力管理器：MCP 会话级关闭（网关）**：经 Orrery 配置的 MCP server 现在由 Orrery 自己在运行时逐个挂载（每个 server 独立隔离组 + 代理 facade），会话可逐个启停。被拒的调用不会到达 server（零 RPC）；三个资源操作与 `mcp:<server>` 指令段按会话过滤；被禁 server 的工具 schema 对新 agent 隐藏（既有 agent 的调用仍会被拦截）；Apply 移除后先关闸、再等待在途调用结束，超时只报告仍在途、不强制取消。宿主直接配置／ACP／其他预设的 server 一律标为 **unmanaged**（不提供关闭开关）；把现有宿主 server「纳入 Orrery 管理」需显式确认，宿主原条目未停用时显示为冲突而非成功。详见 [会话能力管理器](docs/features/session-capability-manager.md)。

- **会话能力管理器：预设库与工作区默认值**：团队能力集合现在可以保存、编辑、导入导出——`global` 与工作区两个命名空间，显示名冲突必须显式处理，两个客户端同时修改会得到显式冲突而不是静默覆盖。导入的便携式文档只接受无凭据引用（MCP 只认逻辑绑定名，连接信息一律拒收），导入项不会自动启用。你还可以把当前选择「保存为工作区新会话默认值」：不影响当前会话、可显式保存空集、清除后新会话回到内置基线。详见 [会话能力管理器](docs/features/session-capability-manager.md)「预设与默认值」。

- **会话能力管理器：Skill 分发基础**：第三方 Skill 的来源清单（仓库/类型/ref/安装位置/内容身份，成立不了的值标为 unknown）、同名条目全量列出且安装到已占用名称必须显式选择（默认零写入）、内置 Skill 禁止第三方流程改写、受管安装/更新只在一个 pinned 版本的隔离执行器里运行（独立 staging 与非交互参数，偏离基线即拒绝执行）。详见 [Skill 分发](docs/features/skill-distribution.md)。- **`scripts/dump-session.mjs`（开发工具）**：DSH 会话日志（append-only 多帧 zstd）一键解码为纯 JSONL，用法 `node scripts/dump-session.mjs <日志路径> <输出.jsonl>`，输出帧数统计；AGENTS.md §2 同步补充日志位置/格式警示与 `/tmp/dsh-src` 的具体重建命令及版本核对方法。

- **会话能力管理器：分发发布器与更新生命周期**：发布走不可变代次（active 指针 + provenance + 回执同一原子切换，读者只见完整旧/新代次；bundled 路径永不是目标）；定期检查只读（24h 节奏 + 手动 Check now + 失败 backoff，绝不改动真实安装目录）；手动更新需显式确认并核验后置条件，自动更新默认关闭且须按来源显式 opt-in；会话首次接受的内容被持久 pin，原目录删除后仍可用，采用新内容必须显式 refresh。详见 [Skill 分发](docs/features/skill-distribution.md)。- **编辑锁：消息驱动的自动恢复（默认开启）**：会话被停止（黄色状态）后，你发送的下一条消息会自动执行「继续编辑」的完整动作——恢复会话并确认全部保留文件，新回合可直接编辑，无需再手动打开面板。运行时注入的消息（续推、收尾提醒、恢复提示、后台通知）不会触发，被管理员撤销的会话仍是终态。**行为语义变更**：原先的「普通用户消息不恢复编辑权限」不变量被推翻；设置页「编辑」组新增开关可关闭，即时生效。详见 [编辑锁特性文档](docs/features/edit-lock.md)。

- **会话能力管理器：会话 Badge、管理器与移除通知**：会话输入栏新增能力 Badge（以服务端回执显示已应用的技能/MCP 计数与不可用警告），点开进入按需加载的管理器（技能与 MCP 两个视图、来源标签、冲突与缺失、搜索；MCP 分「Orrery 管理」与「未托管」两组）。你取消选择某项能力后，模型在下一次请求时会收到一条明确的自动通知（说明已交接的调用仍可能完成、不抹除历史），且该通知不会触发新回合或被误当作用户指令。详见 [会话能力管理器](docs/features/session-capability-manager.md)「管理界面与通知」。- **设置页重启提醒**：保存落地且触达了只在重启后生效的选项（意图分类、续推、上下文压力、锚点编辑与编辑锁开关等 18 个键）时，弹出居中警告弹窗，按声明顺序点名本次受影响的选项（跟随界面语言）；其余改动仍即时生效。只改即时生效选项、保存失败或无净改动时不提醒；把选项改回原值不算触达。重启生效键在 settings schema 的 `FIELDS` 声明处单一标记并派生 `RESTART_KEYS`，设置页客户端清单由测试对拍防漂移。详见 [设置页特性文档](docs/features/settings-page.md)。

- **会话能力管理器：管理器 Apply 编辑面**：能力管理面板现在可以直接勾选/取消技能与受管 MCP server，点 Apply 提交（带 CAS 版本与请求 ID）；提交中显示进度、失败保留草稿、版本冲突提示查看当前状态、无法解析的名称明确列出。详见 [会话能力管理器](docs/features/session-capability-manager.md)「管理界面与通知」。- **编辑锁显式管理员恢复 API**：认证设置通道新增 `ADMIN OVERRIDE`；精确备份验证并持久化后，在同一次权威提交中记入强制审计、撤销旧 owner/epoch、释放其全部锁。原始 unknown 发布与 operation ID 不改、不重放；管理员明确接受迟到旧写者风险，无需把旧写者静止证明当作恢复前提。首次恢复升级为 v5，旧版本拒绝读取；API 与回归测试已交付，GUI 动作及运行时集成另行验收。详见 [恢复契约](docs/features/edit-lock.md#管理员恢复admin-override)。

- **会话能力管理器：MCP 新增入口**：能力管理面板的 MCP 页签现在有「+ Add managed MCP server」表单（identity、显示名、command、args），提交即写入 Orrery 注册表并立即挂载；命令行同样支持 `/capabilities mcp-add <json>`。已接受的会话要在面板里勾选该 server 才会对本会话启用。详见 [会话能力管理器](docs/features/session-capability-manager.md)「MCP 会话级关闭」。- **编辑锁独立维护面板**：设置页展示已保存开关与本进程挂载证据，区分等待重启、已停用与未知；关闭管理器后仍能只读检查服务端发现的权威镜像及未决围栏。开关意图走共享审计，不新增历史结清、修复或热绕过入口。

- **编辑锁历史镜像 v4 基础**：v2／v3 记录无损迁移，历史 closeout 仍不解除围栏；拒绝旧格式夹带新绑定与未知版本。下一次持久化写入 v4，旧版不能继续读取，回退需使用升级前备份并先建立独占与旧发布者静止。这一步不开放人工结清、不修改历史发布结果。
- **编辑锁拒绝认证回归证据**：新增真实 local／sandbox 隔离探针，验证临时方法替换并恢复仍可在提交后抛出真实 stale 错误，否定仅靠调用前后快照认证未发布。补充技术阻塞与维护入口缺口；本项不新增结算能力、不解除历史围栏。

- **系统通知（以 DeepSeek Harness 的名义）**：会话需要你处理、出错或跑完一件长任务时，弹出系统通知，来源是 DeepSeek Harness 本身（带它的图标，授权在「系统设置 → 通知 → DeepSeek Harness」）。工具审批、助手提问、计划评审与任务失败/中止立即通知；一轮任务正常结束且耗时不少于最短时长（默认 15 秒）时通知完成，其间助手被后台任务或续推重新唤醒则撤销。你自己的停止与委派子代理的结果不通知。通知由 DSH 页面弹出；页面不可用（窗口已关闭等）时退回系统命令（macOS 通知中心、Linux `notify-send`、Windows toast）兜底，不丢通知也不重复。
- **窗口在前台时默认不通知**：你正看着 DSH 窗口时不打扰；设置页新增「窗口在前台时」（不通知／始终通知，默认不通知），即时生效。
- **连续通知不再互相吞掉**：同一会话的同类通知合并为一条并重新提醒；不同会话、不同类型的通知互不覆盖，不会漏看别的会话的审批。
- **macOS 通知权限面板**：设置页「系统通知」组在 macOS 上多出「通知权限」条目（其他平台不显示），点开弹出面板，检测并引导 DeepSeek Harness 自己的通知权限：发送测试通知（走真实投递路径）、打开系统通知设置、自动等待你允许（每 2 秒检测，最长 3 分钟）、最后由你确认是否看到了测试通知。开关始终由你亲手打开，不会代点；专注模式/勿扰无法检测。
- 设置页新增「系统通知」组：总开关、完成通知、需要处理通知、最短时长、提示音、窗口在前台时，改动即刻生效。该特性挂在 profile 层，覆盖所有预设的会话；新增模块导出，**需重启应用后生效**。已知限制：网页通知只在 DSH 窗口运行时有效，窗口关闭后走系统命令兜底（macOS 上兜底归属「脚本编辑器」，可能因无授权被系统丢弃）；点击通知不会跳转到会话；Linux/Windows 路径未经实机验证。详见 [系统通知特性文档](docs/features/notify.md)。

- **Worktree 车道**：主代理用 `worktree_open` 在仓库内开出隔离的 git worktree 车道（分支 `orrery/<id>`，目录 `.orrery/worktrees/<id>`，经 `.git/info/exclude` 本地忽略、不改任何入库文件），`delegate` 新增 `worktree` 参数把子代理绑定到车道（宿主守卫子代理的工作目录、写入路径与分支）。子代理结束后宿主自动检查车道（未提交改动、分支被切换、没有新提交；仓库在本地配置了验证命令时再跑验证），并把下一步直接告诉主代理。合并只能由你在卡片上批准（先做无副作用的冲突预检与主仓检查，`--no-ff` 合并），合并后由你选择保留 worktree、清理 worktree 或连分支一起清理；放弃车道同样由你确认。新增会话级 Worktree 模式（`/worktree on`）：开启后主代理不再直接改文件、写类委派必须走车道。`/worktree` 命令族让你不经模型直接查看与操作车道。设置页新增「Worktree 车道」组（总开关、车道目录、活跃上限、自动安装依赖）。需要 git ≥ 2.38；新增模块导出，**需重启应用后生效**。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。

- **Worktree 车道**：主代理用 `worktree_open` 在仓库内开出隔离的 git worktree 车道（分支 `orrery/<id>`，目录 `.orrery/worktrees/<id>`，经 `.git/info/exclude` 本地忽略、不改任何入库文件），`delegate` 新增 `worktree` 参数把子代理绑定到车道（宿主守卫子代理的工作目录、写入路径与分支）。子代理结束后宿主自动检查车道（未提交改动、分支被切换、没有新提交；仓库在本地配置了验证命令时再跑验证），并把下一步直接告诉主代理。合并只能由你在卡片上批准（先做无副作用的冲突预检与主仓检查，`--no-ff` 合并），合并后由你选择保留 worktree、清理 worktree 或连分支一起清理；放弃车道同样由你确认。新增会话级 Worktree 模式（`/worktree on`）：开启后主代理不再直接改文件、写类委派必须走车道。`/worktree` 命令族让你不经模型直接查看与操作车道。设置页新增「Worktree 车道」组（总开关、车道目录、活跃上限、自动安装依赖）。需要 git ≥ 2.38；新增模块导出，**需重启应用后生效**。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。

- **Worktree 车道（安装说明）**：本版新增模块导出 `orrery-harness/worktree`、预设中的 `worktree` 行与设置页「Worktree 车道」组，**需重启 DeepSeek Harness 后生效**；本机 git 需为 2.38 或更新（冲突预检依赖 `git merge-tree --write-tree`），更低版本下车道功能整体报 `GIT_TOO_OLD`，不降级运行。

- **Worktree 车道状态订阅（`worktree_watch`）**：主代理可订阅同一仓库内任意车道的结论态（如 `landable`、`landed`、`abandoned`；过渡态不可订阅），车道到达目标状态时自动通知并续推**订阅者会话**——跨会话可用，不再只能干等属主通知或反复 `worktree_check`。订阅一次性：命中一次即自动解除；超时（默认 6 小时，设置页「Worktree 车道」组统一配置，模型不可指定）到期解除并收到一条过期通知，不会无声消失。订阅随车道账本持久化，重启后未过期继续有效；重复订阅同一车道自动替换旧订阅。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。

- **Worktree 车道：`worktree_watch` 的 GUI 呈现对齐**：车道状态订阅的调用现在在会话里渲染为与其余五个车道工具一致的结构化卡片（眼睛图标 + 本地化工具名 + 车道链接 + 状态徽章）——订阅成功时列出每个被订阅结论态的徽章与过期时刻（悬停看 ISO 原文），立即命中时显示命中态徽章，不再退化为裸 JSON 视图；车道面板的车道卡头部新增弱化的「N watching」标记（悬停列出被订阅状态）。此前缺元数据的旧日志仍走通用扁平回退，不受影响。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。

- **会话能力管理器（基础设施，暂无用户可见变化）**：新增 Orrery 自管的带锁持久化侧文件存储（位于 DSH home 下的 `orrery/profiles/<profile>/capabilities`），承载后续会话 Skill/MCP 选择与其回执：每单元独立文件与修订号、原子提交（temp + fsync + rename）、跨进程锁文件（崩溃安全获取、陈旧锁须证明 owner 已不存活才回收）、幂等回执与内容代次指针原子切换；不支持的平台显式报 unsupported 且零写入。本步不改动任何现有行为。详见 [会话能力管理器特性文档](docs/features/session-capability-manager.md)。

- **会话能力管理器：Capabilities 面板与预设入口（UX 重做）**：能力管理器从输入框上方的 320px 弹层升级为**右侧栏 Capabilities 面板**（与 Worktree 面板同模式）——Skills 视图按来源分组（Orrery 内置/user/project/custom）、真实复选框、技能描述次行、冲突/缺失标记与搜索；MCP 视图保留「Orrery 管理/未托管」分组并重做添加表单（逐字段校验）；底栏 Apply/Discard 带净增减摘要（+n/−m）。输入框 Badge 保留为会话级状态与入口（回执计数、警告点、帧订阅收敛不变），点击打开面板；无右侧栏的 shell 自动回退为原弹层（同一视图组件树，零分叉）。**预设功能补交付**：新增「预设与默认值」视图——预设列表（全局/工作区分节）、保存当前草稿或已应用选择为预设、载入预设进草稿（未解析项明确报告）、重命名/替换/删除（显式确认）、工作区默认值的保存/查看/清除；对应 `/capabilities` 命令新增 `presets|preset-save|preset-load|preset-delete|preset-export|preset-import|default-get|default-save|default-clear` 九个动词，命令行路径同样可用。详见 [会话能力管理器](docs/features/session-capability-manager.md)「管理界面与通知」。
- **会话能力管理器：预设打包导出与两阶段导入**：预设导出升级为 **version-2 打包文档**——按 Skill 来源分别处理：远程仓库来源只记录链接（portable ref）；安装在工作区与本地全局的 Skill 直接把文件打包随文档旅行；Orrery 内置按名称引用。导入永远先出摘要（每个 Skill 装进哪个根目录、几个文件、有没有同名冲突），你确认并选择冲突处理方式（默认取消，替换/共存需显式选择）后才落盘：工作区 Skill 装进当前工作区、本地 Skill 装进本机用户技能目录；任一文件写失败自动回滚，装入的技能不会自动启用（仍需勾选 + Apply）。全程零网络、零 server 启动，导入审计记录安装结果与冲突决策。详见 [会话能力管理器](docs/features/session-capability-manager.md)「预设与默认值」。
- **Capabilities 面板视觉升级（纯视觉，零行为变化）**：分段控件标签栏、sticky 分组标题（计数徽标）、按来源着色的技能标签、行项悬停/选中/键盘焦点三态、MCP 与预设卡片分组、加载骨架行、错误/不支持/降级完整空态、底栏 diff 徽标与主按钮层级、危险操作警示条；Badge 同源微调。深浅主题安全（全 dsw token + hex fallback），hook 数与既有交互契约不变。详见 [会话能力管理器](docs/features/session-capability-manager.md)「管理界面与通知」。

### Changed

- **Worktree 模式开关从输入框迁入车道面板**：输入框下方的「Worktree」按钮让人误以为必须打开它才能使用车道——实际上车道能力始终可用，该按钮只是一个可选纪律模式。按钮已从输入框移除；模式切换改为车道面板工具条的常驻控件（关闭时描边 chip、开启时实心徽标，不可用时置灰并附原因），tooltip 与 `/worktree on` 回执现在都明确"车道无需开启本模式；开启后助手不再直接改文件，所有改动走隔离车道"。`/worktree on|off` 命令与模式守卫行为不变。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。
- **Worktree 车道 UI 全面重设计**：右侧栏车道看板、车道卡片、会话内工具卡片、会话头状态胶囊、列表行标记与输入框模式开关升级为产品化呈现——卡片化布局与清晰的视觉层级（状态徽标 v2 淡底、分支行 ↑↓ 领先/落后 chip、彩色 diffstat、reason/next 色条 callout、逐条 ✓/✗ 验证结果与退出码 chip）；操作分级（至多一个实心主按钮、描边次要、危险二次确认、幽灵链接），「清理 worktree 和分支」与放弃一样需要二次点击；diff 改为行级增绿删红底色；仓库概况改为图标化信息卡，空态居中引导、历史车道分组折叠、配置表单主题化。数据流、命令映射与工具契约不变。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。
- **委派子代理提示词与工具面收敛（干净上下文）**：此前类别 worker 与精选只读 agent 会完整继承主编排 Agent 的系统提示词（Orchestration Doctrine 全文、Delegation targets、Worktree 车道编排规则，约 12K 字符）与 48 个工具的完整目录（含其无权也无意义使用的 `delegate`/`workflow`/`subagent`/车道管控/编辑锁/goal/plan 工具）——子代理并不承担编排职责，这些信息既是上下文浪费又自相矛盾。现在：编排者专属的三个提示词段落（`orchestrator:doctrine`、`orchestrator:delegate-targets`、`orchestrator:worktree-lanes` 及 live 车道看板）在子代理装配时渲染为空（主 Agent 逐字节不变）；每个子代理的工具目录统一扣除 27 个编排者专属工具（只读精选 agent 的 allow 名单语义不变）；每个子代理的 persona 统一追加一段协作契约（最终消息即交付给主 Agent 的自包含报告、不可再委派、不可向用户提问、受阻即报）。新增 `child-prompt` 集成场景钉死子代理首请求表面。详见 [委派特性文档](docs/features/category-delegation.md)「子代提示词构成」。

### Fixed

- **崩溃恢复/fork 产生的会话化身能力视图永久 fail-closed**：宿主恢复或 fork 生成的「delegationDepth 为 0 但带 parentSession」的会话，因快照捕获门（只看 depth）与读取门（还看 parentSession）不对称，永远捕获不到继承快照却被当子代理要求快照——技能视图空、slash 菜单空、Badge 显示 `inherited-snapshot-unavailable`，只能手动 Apply 自愈。现在创建时按 resume 语义 best-effort 捕获父已接受快照（只缩不扩；已有自己选择的化身逐字保留）；父快照不可读时走根会话失败语义（会话照常创建、空视图 + 分类原因、提示点名面板 Apply 恢复），绝不拒创建主会话、绝不回退全量目录。同时选择视图错误态下的能力列表保持全量库存与真实来源标签（不再退化为 unknown/other），降级态下勾选 + Apply 即可自愈。详见 [会话能力管理器](docs/features/session-capability-manager.md)「初始化与继承」。

- **能力面板「预设」页签每次打开都打印 `/capabilities presets` 与 `/capabilities default-get` 命令卡片**：预设列表与工作区默认值两个自动读取迁入同一 `orreryCapabilities` 静默通道（方法 `presets`/`defaultGet`），打开页签不再产生会话日志事件；`no-workspace` 等域状态返回值语义与面板分类不变，手打命令行为保留。详见 [会话能力管理器](docs/features/session-capability-manager.md)「会话 Badge 与 Capabilities 面板」。
- **每次进入会话都打印 `/capabilities receipt` 命令卡片**：能力 Badge 与管理器面板的读取（receipt/list/conditions）此前借用 `/capabilities` 命令通道拉数，而宿主对每次命令执行无条件写入会话日志并硬编码归因为用户发起——每打开一次会话就永久多出至少一张命令卡片。读取现已迁到插件自有的 `orreryCapabilities` remote 通道（宿主层服务、预设层经 bridge 供数），读操作零会话日志写入；手打 `/capabilities` 与 Apply 等变更操作行为不变。详见 [会话能力管理器](docs/features/session-capability-manager.md)「会话 Badge 与 Capabilities 面板」。
- **Worktree merge 审批与 abandon 确认卡片不触发系统通知**：Worktree 车道的提问卡片绕过工具层、由车道服务直接调用 `userQuestions` 服务弹出，会话事件流中从不出现通知模块监听的提问工具调用，车道等待用户审批时毫无通知。现在发问漏斗在卡片弹出前对 merge / abandon 两类卡片发出 `worktree/question` 事件，通知模块监听后按既有「提问」路径投递；cleanup 卡片永远紧随用户刚答完的 merge 审批或亲手执行的 land 命令弹出，刻意不通知。详见 [系统通知](docs/features/notify.md)与 [Worktree 车道](docs/features/git-worktree.md)特性文档。
- **Orrery 预设重启后加载失败（`Preset services require isolate realms: orreryMcpGate,orreryMcpManager`）**：MCP manager 预设行通过 reflect 发布 `orreryMcpGate`/`orreryMcpManager` 两个服务，但该行直接挂在预设根 realm，预设注册审计拒绝任何泄漏到根 realm 的预设服务，导致重启后所有新建 Orrery 会话失败；会话能力 Badge 随之停留在加载态并显示原始文案键 `capability.loading`，管理器面板空转。现将 `orrery-skill-selection`（消费者）与 `orrery-mcp-manager`（提供者）收进同一个 isolate 这两个服务的 `capabilities` cordis 组（S11 同 realm 纪律），`preset-realms` 单测新增该组的结构守卫，集成测试装置的 MCP 行同步镜像为该隔离结构（realm 错误从此在 headless 场景即失败）；manager 对选择面 lifecycle 的解析改为每次裁决时惰性进行——同批挂载顺序不是契约，挂载期快照可能永久落空为拒绝一切托管调用（与意图门 rc.2 教训同类）；Badge/管理器面板对未注册文案键回退到内置英文文案、列表拉取失败落定显式不可用态而非永久加载，Badge 首次拉取落定仍无回执时显示 "Capabilities n/a" 而非永久加载（非 Orrery 预设会话即此形态）；面板配色改用壳层真实存在的主题 token（`--dsw-alias-bg-overlay`/`--dsw-alias-state-warn-primary` 等），修复深色主题下白底白字的空白面板。详见 [会话能力管理器](docs/features/session-capability-manager.md)。
- **bundle 重载时宿主崩溃（编辑锁迟挂载越预设绑定 + restrict 致命抛出）**：编辑锁开启状态下重载 bundle（或任何触发预设树 reload 的操作）时，迟挂载 catch-up 经进程级 `agents.roots()` 枚举到**其他预设**的存活主代理并尝试绑定——绑定失败后的兜底 `tools.restrict({ deny: [...] })` 包含对方工具目录不认识的名称（`hash_edit`/`lsp_rename`/`str_replace_editor`），restrict 抛出并在 reload 期间升级为宿主致命错误（`dsh desktop host exited with 1`）。现 catch-up 以 `agentPresets.serviceFor` 的服务实例同一性判定只绑定属于本挂载的代理（无预设注册表的组合维持原行为），兜底拒绝只点名该代理实际拥有的工具且自身绝不再抛出。附两条回归测试。详见 [编辑锁特性文档](docs/features/edit-lock.md)。
- **重启后首个会话的主代理永久失去编辑能力（编辑锁迟挂载缺口）**：Edit Lock 域绑定此前只发生在 `agent/created`，而重启后首个 Orrery 会话的主代理先于预设插件创建（事件已错过），该会话主代理因此永远没有 Edit Lock 域、一切文件写入被守卫拒绝，只能靠子代理绕行。现在插件挂载时会枚举存量主代理并执行与创建时完全相同的绑定路径（幂等，重复挂载不双重绑定；挂载时启动失败与创建时同等记录）；子代理本就晚于挂载创建，不受影响。详见 [编辑锁特性文档](docs/features/edit-lock.md)。
- **编辑锁状态面板点击外部不收起**：输入栏「编辑锁」弹出的细节面板此前只能靠再次点击按钮或在面板内按 Escape 关闭，点击面板外区域没有反应。现在面板打开时监听 document 级 `pointerdown`，落在本入口（按钮＋面板）之外的点击即收起面板，同时重置「收回编辑权」「解锁」的二次确认待击状态；收起时注销监听器，不产生泄漏。详见 [编辑锁特性文档](docs/features/edit-lock.md)。

- **Orrery 预设新建会话失败（`agent-preset/invalid: row 9 names no plugin`）**：预设组合中 `orrery-skill-selection` 行的 `name` 用了 `!!js` 表达式定位私有入口，而运行时对 `name` 字段从不对表达式求值（只有 `disabled` 与 config 值求值），预设注册校验直接拒绝，导致所有新建 Orrery 会话失败。改为正式导出 `./skill-selection`（`orrery-harness/skill-selection`）并以字符串引用；新增回归测试拒绝任何 `name: !!js` 写法。集成测试装置本就走字符串导出行，故此缺陷此前未被任何测试触达。

- **集成测试装置 worktree 场景的 git 容器化（2026-10-05 "fixture" 污染事故）**：装置的 worktree 集成场景用裸 `git rev-parse --git-dir` 探测工作区仓库，而默认 IT 根已迁入会话仓库内（`<repo>/.orrery/it-root`），探测经父目录穿透命中外层仓库——场景的 `git add -A && git commit -m fixture` 于是直接把主工作区里其他会话的未暂存改动卷进 main 上的混合提交（4f1a90e/d2949bc/6ab3f26/7a357b4），并曾短暂回退他人修复。新增 `src/git-repo.js` 容器化护栏：工作区一律获得自己的 `.git`（嵌套安全，IT 根本地 exclude），任何仓库变更前 `assertContained()` 要求工作区自身即 toplevel 否则拒绝；附回归测试。端到端验证：默认根下 worktree 场景 8/8 通过且主仓库逐字节不变。

- **意图语义分类器路由覆盖失效（rc.2 回归）**：rc.2 的 cordis 在 apply 批次结束后才激活 `reflect.provide` 的服务提供方，意图门在 apply 期对 `orrerySettings` 的快照必然为空，llm 模式的分类器路由覆盖静默失效（报 `no classifier route` 并按未命中降级）。改为每次分类时惰性解析覆盖（`resolveRouteOverride`），晚到的设置覆盖同样生效；模式/超时/jev 键仍是重启生效的 apply 期快照，不变。详见 [意图门特性文档](docs/features/intent-gate.md)。

- **Worktree 决策卡排版塌缩**：合并/收尾/放弃卡片的 detail 此前用单个换行连接事实行，被 GFM 软换行折叠成一段（车道/分支/改动/预检/验证全部挤在一行）；现改为列表结构，每条事实独立成行，提交列表为缩进子列表，完整 diff 指引为斜体行。信息项与选项集合不变。
- **Worktree 合并卡文案收紧**：合并选项的描述不再重复完整分支名（长描述会撑出选项行，分支已在卡片 detail 中），detail 的车道项不再重复车道标题（标题已在卡片问题行）。
- **Worktrees 面板与会话头胶囊空白/崩溃**：`/api/orrery-worktree/view` 的降级返回（功能停用、会话未激活——重启后未打开的会话即命中）不带 `lanes` 等数组字段，视图层渲染期对其调用汇总/轮询 helper 时抛 TypeError，被壳层错误边界吞掉后表现为面板空白。现端点降级形态与完整视图同构、数据进入组件前统一收窄、helper 自身容错，任何降级/畸形负载都不再崩溃，而是呈现已定义的不可用提示。
- **todo 续推感知后台任务**：会话持有 `running` / `stopping` 后台 job 时不再反复注入续推消息或消耗连续续推额度，改由结算通知唤醒；供应商错误延迟重试在触发时同样重查并跳过，不重排、不改变失败计数。jobs 服务缺席或查询失败时维持原有行为。详见 [todo 续推](docs/features/todo-continuation.md)。
- **编辑锁被撤权会话不再提供“继续编辑”**：管理员恢复（ADMIN OVERRIDE）永久撤权的会话此前在面板上仍渲染为普通“已停止”并给出“继续编辑”按钮，点击必然以原始内核错误 `owner revoked by administrative recovery` 失败，且每次失败前还会持久签发一张无用 receipt。现在权威状态标注每会话 `revoked` 标志，面板以独立的终态「编辑权已被永久撤销」呈现（无任何恢复动作，附原因说明），`resume` 与 receipt 签发在任何持久化之前拒绝。详见 [撤权后的会话呈现](docs/features/edit-lock.md#撤权后的会话呈现)。

- **设置页保存结算后才广播设置变更**：此前保存动作一触发就立即向会话面消费者（如 composer 的 LSP 开关）广播变更——包装层等待的是宿主丢弃了 Promise 的动作句柄，广播实际发生在保存开始之时；现在改为直接等待保存结算，结算（无论成败）后恰好广播一次。
- **集成测试回放完整性**：capstore 脚本按最近工具结果推进，不再被运行时上下文注入触发重复 host 提交；以同一次真实安装版运行的完整 rehydrate／worktree 场景恢复审计与 ledger，加入跨文件会话一致性检查，并仅放行这些 fixture 证据的 Git 忽略例外。

- **维护面板错误边界与诚实状态**：内容在真正的后代边界内渲染，成功但畸形的状态响应不会带走关闭按钮；权威目录缺失/为空只陈述当前事实，不再暗示从未初始化。客户端构建生成经过语法校验的 chunk 字节摘要清单，不再靠入口时间戳证明产物新鲜。
- **Edit Lock 测试隔离**：组合层提供保持生产默认的根发现、Git 排除与 endpoint 适配器；测试同时限制文件系统祖先扫描与 Git 发现，使用 lane 内短 socket。维护后端、共享快照、设置集成与维护客户端加入 checkJs。

- **Worktree 测试隔离**：测试 Git runner 仅接受已登记的临时 fixture 路径，清除继承的 Git 环境覆盖并设置发现上界；临时目录位于 checkout 内时，「非仓库」场景不再误操作外层仓库。该修复不代表编辑锁 authority 扫描或 socket 测试已经隔离。

- **编辑锁维护检查与挂载证据**：拒绝符号链接 authority 路径、非常规或超过 16 MiB 的快照；读前后核对路径和文件身份。每个挂载独立持有证据，后挂载的停用行不再覆盖仍在运行的启用行；安装、卸载未完成及失败状态显示未知。

- **编辑锁：Stop 不再取消已经调用的文件提交**：停止仍立即阻止新发布；已调用的提交独立等待完成，成功保留 created/updated 历史及中断归属，不恢复编辑权。原版本与沙箱策略不变，真实失败仍为 unknown；不结清历史 unknown、不重放。补充真实安装版父 Stop／子 UPDATE 回归，并更正文档中父 Stop 不传播给子代理的旧描述。

- **编辑锁：单个未决发布不再一律阻塞整个项目**：既有文件发布结果为 unknown 后，精确资源围栏外的可信规范既有文件仍可获取、确认与更新；批量和会话级操作在落盘前检查全部受影响归属，不能释放或重臂未决 update 必需的锁。domain 围栏仍拒绝正常操作；v3 无历史祖先连续性证据，subtree 围栏与新的创建意图仍保守拒绝。历史不改写、不重放，未新增人工结清入口。详见 [Edit Lock 特性文档](docs/features/edit-lock.md)。

- **能力 Badge 恒显「0 skills · 0 MCP」、管理器面板永久「Loading capabilities…」**：Badge 回执把选择 provider 返回的候选按 `candidate.selected` 过滤，但该 provider 的契约是「返回的候选即生效选择」，从不携带 `selected` 字段——过滤后恒为空，真实选择（如内置基线 10 项）被完全隐藏；现由 provider 在选中匹配上显式盖章 `selected: true`（Office 占位 denial 不盖章），回执与列表行直接读取。面板则因 Badge 渲染管理器时只传了 `{ sessionId, model, onClose }`、`fetchListing`/`fetchConditions`/`t` 未下传，拉取守卫恒为假、`/capabilities list` 从未发出（不是服务端挂起），现已随面板一并下传。附 provider／命令回执／Badge chunk 三层回归测试。详见 [会话能力管理器](docs/features/session-capability-manager.md)。

- **能力管理器面板点击行为反转**：此前面板渲染为 Badge 切换按钮的**子节点**——点击面板内任意位置都会冒泡到按钮的 onClick 把面板关掉（且交互内容嵌套在 button 内本就不合法），而点击面板外部没有任何收起监听。现面板与按钮同为带 `data-orrery-capability-root` 标记的相对定位包裹层的子节点（编辑锁面板同款结构），内部点击不再触达切换；面板打开期间注册 document 级 pointerdown 监听，落点在该包裹层之外即收起。附 chunk 级回归测试（结构与关闭语义）。详见 [会话能力管理器](docs/features/session-capability-manager.md)。
- **Worktree 自动依赖安装在桌面宿主上不再因 `pnpm: command not found` 失败**：lockfile 推导的 setup 命令运行前会先解析调用方式——系统环境优先，其次回退到 DSH 捆绑运行时（pnpm 以捆绑 Node 的绝对路径执行 `pnpm.mjs`），并把解析到的 Node 目录注入 PATH 供安装脚本使用；两层都找不到时给出含三条出路的明确诊断，而不是裸 exit 127。你显式配置的 setup 命令行为不变（始终原样执行）。
## [0.7.0] - 2026-10-03

### Added

- **编辑锁（实验，默认关闭）**：同一项目里的多个会话轮流编辑文件、不再互相覆盖。助手改文件时自动占用；其他会话会被拒绝并可请求转交；回合结束时助手必须释放或有期限地保留文件；你按停止后助手真正停手，直到你在输入栏的「编辑锁」面板点「继续编辑」。在设置页「编辑」组打开「编辑锁（实验）」并重启生效。本版合入特性分支的两个版本 `edit-lock-v0.1.0` 与 `edit-lock-v0.2.0`，逐项变更见下方对应段落，细节见 [Edit Lock 特性文档](docs/features/edit-lock.md)。

## [edit-lock-v0.2.0] - 2026-10-03

### Added

- **编辑锁：回合结束时收尾**：回合正常结束而助手仍占着文件时，会被续推一次，要求它对每个文件释放或申请有期限的保留；提醒次数用尽后按设置自动释放（默认）或转为需要你处理。出错与你按下停止都不进入此路径。详见 [Edit Lock 特性文档](docs/features/edit-lock.md)。
- **编辑锁：有期限的保留**：新增 `edit_lock_hold` 工具与 `/edit-lock hold [minutes]`。单次与累计上限可在设置页调整（默认 30 分钟／2 小时），没有永久保留。保留中的文件对其他会话照常拒绝；本会话一开始新回合，全部保留立即解除；到期且空闲时自动释放。
- **编辑锁设置**：设置页「编辑」组新增保留默认时长、单次上限、累计上限、提醒次数与兜底处置五项；非法组合在启动时明确报错。
- **`/edit-lock release <path>`** 与 **`/edit-lock confirm --all`**：从面板或命令释放本会话的单个文件；一次确认全部待确认文件（逐个执行原有确认，不放宽检查）。

### Changed

- **集成测试默认根工作区相对化**：未设 `ORRERY_IT_ROOT` 时写入根从机器绝对路径（旧：POSIX `/Users/young/.orrery-it`、win32 `D:\.orrery-it`）改为 `<仓库根>/.orrery/it-root`（从装置自身路径推导，worktree lane 内自动解析为 lane 内路径，lane worker 可在沙箱内直接跑集成测试）；显式 `ORRERY_IT_ROOT` 语义不变。本地脚本如依赖旧默认路径请改为显式设置。单元测试同步拆分：单进程 liveness 用例改注入替身，进程必需用例（跨进程竞态、SIGKILL 恢复、真实 `ps` 探测）移入能力门控文件，spawn 受限环境显式 skip。
- **车道开启拒绝可行动化**：`worktree_open` 被 `MAX_ACTIVE` 拒绝时逐条列出活跃车道及状态并点名可 `worktree_land` 的车道；被 `SCOPE_OVERLAP` 拒绝时给出双方重叠 glob 明细与收窄/等待建议。错误码与拒绝条件不变。绑定 worker 的车道契约新增三条英文声明：不调用 goal 类工具（委派子代理无权）、阻塞与结论写入最终 report（不 `send_message` 父代理）、一切命令含测试以车道根为 `workdir` 运行。详见 [Worktree 车道特性文档](docs/features/git-worktree.md)。
- **编辑锁面板重做**：状态来自只读的结构化视图，不再从命令文本推断；圆点颜色按状态区分（未占用／编辑中或保留中／已停止或待确认／需要处理）。只在需要时给一个主动作，文件按短名列出且每行至多一个动作，「收回编辑权」需二次确认，会话 id、epoch、generation 与绝对路径收进「技术细节」。读取视图不写入对话，每个动作仍是一次显式命令。
- **继续编辑一并确认**：面板的「继续编辑」依次执行 `/edit-lock resume` 与 `/edit-lock confirm --all`，一次点击恢复编辑并确认全部保留文件；命令行仍可逐个确认。
- **文案**：停止、清理与收尾通知改为指向面板中的动作，不再要求手敲命令；`edit_lock_status` 会报告保留剩余时间。
- **权威镜像升至 version 3**（新增保留表）。version 2 镜像在恢复时无损升级（为每个会话补一行空保留），下次写入即落为 version 3。

### Fixed

- **编辑锁：保存了互相矛盾的保留设置会让整个编辑锁失灵**：例如单次上限调到默认时长以下。现在只有保留申请会按名报错，收尾提醒、状态、释放、停止、解锁继续工作（保留相关字段按默认值，提醒次数与兜底处置仍用你保存的值），提醒里说明保留暂不可用，并记一条警告。
- **编辑锁：回合末提醒可能无限循环**：提醒本身触发的回合会把提醒计数清零，次数永远用不完、兜底处置永不执行。现在提醒引起的回合不再重置计数。
- **编辑锁：跨进程客户端会话的保留永不到期**：到期定时器在客户端同步读取异步状态而从未挂上，发布端又无法判断客户端会话是否空闲。现在由运行该会话的主机传递空闲状态，并在回合结束时结算。
- **`/edit-lock hold <minutes>` 忽略输入的分钟数**：总是按默认 30 分钟处理，现已修正。
- **编辑锁：到期释放与续期并发**：释放前在事务内重新确认已到期，避免把刚续期的保留释放掉；保留申请不再越过未决发布围栏。
- **编辑锁面板：「解锁」他人文件改为需二次点击确认**。
- **编辑锁：被占用时的拒绝信息不说明下一步**：原来只有 `resource owned`，现在写明占用的会话，并提示可用 `edit_lock_try_steal` 请求转交或先改别的文件、不要重试同一编辑；拒绝本身不变。
- **编辑锁面板：没有保留文件时「继续编辑」多记一条 `Confirmed 0 of 0`**：现在只在有待确认文件时才追加 `confirm --all`。
- **编辑锁面板：停止／待确认状态没有黄色指示灯**：指示灯误用了浅底色块变量（浅色主题下近乎白色、深色主题下近乎黑色），改为主题的琥珀主色。
- **编辑锁：旧镜像或启动失败让项目永久锁死**：恢复失败（例如 v2 镜像）时，进程保留了自己刚建立的发布预约，同进程下一次尝试便把自己当成「另一个发布者」的客户端，连不上不存在的端点，所有编辑被拒，面板永远显示「启动中」。现在打开失败会释放自己的预约（此时什么都没发布过）；v2 镜像无损升级；面板显示「编辑锁不可用」及原因；连不上发布者时报错会说明残留预约的位置与清理方法。

## [edit-lock-v0.1.0] - 2026-10-02

编辑锁特性分支（`dev/edit-lock`）的特性版本。这一版把此前逐层实现、彼此不可启用的内部切片收口成一个可实际使用的编辑锁：功能默认关闭，打开设置并重启后生效。特性尚未合并回主分支，主分支的版本线不受影响。

### Added

- **编辑锁（实验，默认关闭）**：设置页「编辑」组新增「编辑锁（实验）」开关，打开并重启后生效。锁按会话所在 git 仓库根（不在仓库内则取工作目录本身）自动分域，权威状态保存在 `.orrery/edit-lock/` 并经 `.git/info/exclude` 排除，不改动任何受版本控制的文件。启用后同一工作目录内所有会话的写入都要先持有目标文件：隐藏原生 write/edit，`hash_edit`、`lsp_rename` 与受控 write 一律经锁发布，未经服务接管的写工具直接拒绝。人工入口为 `/edit-lock`（`status`／`locks`／`stop`／`resume`／`confirm <path>`／`unlock <path> <generation>`）。详见 [Edit Lock 特性文档](docs/features/edit-lock.md)。
- **编辑锁状态入口**：功能开启后，会话输入栏出现「编辑锁」按钮，用颜色显示本会话可否编辑、已中断或在异常恢复中；面板列出持有的文件与恢复额度，可刷新、查看全部锁、停止编辑或恢复。
- **归属工具与转交协商**：提供 `edit_lock_acquire`／`edit_lock_release`／`edit_lock_status` 与不等待的 `edit_lock_try_steal`；持有者仅在有待答请求时获得 `edit_lock_reply`，只有当前持有者的及时答复才会在一个持久事务里转交，沉默、过期、旧 generation 与已中断持有者一律保留归属。请求送达空闲持有者时会唤醒它在一个回合内答复（协商时限 120 秒），而不是等它下次收到用户消息时请求早已过期。答复工具只在回合边界注销。
- **停止即持久收回编辑权**：Stop 会撤权并封门，此后写入、获取与转交统一提示「editing in this session was stopped … until a human runs /edit-lock resume」，不再显示含糊的认证错误；`edit_lock_status` 与 `edit_lock_release` 在停止状态下仍可用。恢复编辑只能经 `/edit-lock resume`，普通消息与 todo 续推都不会隐式恢复。
- **受控人工解锁**：`/edit-lock locks` 查看全部归属，`/edit-lock unlock <path> <generation>` 仅在 generation 仍为当前值时释放，并在 manager 顺序中等待在途提交，存在未决发布时拒绝。无强制解锁；旧 owner 的晚到写入因 generation 失效在派发前结算为未发布。
- **跨进程客户端**：共用同一 authority 目录的第二个 Harness 不再被整体拒绝，而是经本机 socket 成为唯一 publisher 的客户端——工具、`/edit-lock` 命令与协商都由 publisher 仲裁并发布，断连即持久撤权，重连的同会话以中断态开始并需显式 resume。端点仅面向可信合作进程，不做认证。
- **仅清理的自动恢复**：回合以供应商错误结束时，会话持有的锁转为异常且不释放，会话进入仅清理状态——业务写入、新获取与转交请求全部拒绝，只能释放、答复或暂停。驱动按 15／30／60 秒退避重试至多 3 次或 5 分钟；暂停单次 ≤15 分钟、累计 ≤30 分钟，额度持久保留、重启不退还，到期只重新检查。用户 Stop 立即结束自动恢复且不唤醒会话。

### Fixed

- **开启编辑锁后 Orrery 会话无法新建或继续**：编辑锁服务未放入隔离 realm，预设注册表以「Preset services require isolate realms: orreryEditLock」拒绝挂载整个预设。现在该服务与其全部使用方同组隔离，测试装置镜像同一结构，并新增预设组合静态检查防止复发。
- **编辑锁面板背景透明**：面板引用了主题中不存在的背景变量，弹出层没有底色。现改用主题的弹出层背景，其余几处不存在的颜色变量一并换成主题实际定义的变量，深浅色都适用。
- **编辑锁：停止后的报错难以理解**：见上「停止即持久收回编辑权」。
- **编辑锁：空闲会话收不到转交请求**：见上「归属工具与转交协商」。
- **编辑锁：子代理结束后锁永久残留**：正常完成的子代理所持有的锁现在随其结束自动释放，不再一直挡住其他会话；被停止或异常的会话仍保留锁，留给人工处理。
- **编辑锁状态缺少 generation**：`edit_lock_status` 现在每行都报告 generation，便于在只轮询状态时判断所有权是否真正易手。

## [0.6.0] - 2026-10-01

### Added

- **精选 agent 支持期望路由（`delegateAgentChains`）**：三个精选 agent（`finder`/`scholar`/`advisor`）此前在路由上**不可配置**——注册表条目没有 `chain`、设置页也没有对应键，于是只能静默继承父路由。现在精选 agent 与类别**共用同一条解析路径**（`resolveCategory` 更名 `resolveTargetRoute`）：链上首个「provider 已注册且列出该 model」的档位胜出；整链不可解析时显式报错并点名 agent 与尝试过的档位，**绝不回退继承**（否则「配错了」会变成「静默跑在别的模型上」）；空链保持继承父路由（向后兼容）。设置页新增 `delegateAgentChains`（JSON map，整链替换；未知 agent 名告警忽略，与 `delegateCategoryChains` 同语义），并复用**与类别链同一个可视化编辑器**（按 agent 逐行加档位）。
- **委托目标指引小节（`orchestrator:delegate-targets`）**：会话系统提示词新增一段常驻小节，说明 `delegate` 的正确用法（每条目必须且只能给 `category` 或 `agent` 之一；类别道**没有默认值**，必须点名类别），并列出**当前启用**的类别（名称 + 描述 + 路由指引）与精选 agent（名称 + 描述）。小节文本是静态模板，其中内嵌的变量由 DSH 在**每次提示词装配**时求值（不是注册期快照），因此设置提交在同一进程内即刻改变模型看到的目标集合，无需重启、无需重建会话。
- **类别可在设置页停用（`delegateDisabledCategories`）**：设置页提供**逐类别勾选列表**（类别是封闭集合，不允许手写 JSON 漂出非法名），勾选结果由客户端合成 JSON 字符串数组；命中的类别被标为停用，注册表自带的 `disabled` 继续有效。停用语义贯通**三处**——指引小节不再列出它、派发它得到显式 disabled 错误、**未知目标报错里的 available 名单也不再把它列为可选**（与 robash 五表同一哲学：设置面只能追加停用，无法解除注册表级停用）。

### Changed

- **三个精选 agent 改名（BREAKING）**：`explore` → `finder`、`librarian` → `scholar`、`oracle` → `advisor`。服务端注册表键与各条目 `name`、工具描述、doctrine 正文、设置页 agent 行列表全部随动；只读强制、只读 bash 守卫、不可再委派、路由解析与 persona 正文语义不变（唯一文本例外：原 librarian 的 persona 首句随名改为 "research scholar"，避免名称与自述分裂）。**不留别名**：旧名不再可寻址——`delegate(agent="explore"|"librarian"|"oracle")` 直接报 `unknown_target`，错误文本只列三个新名；`delegateAgentChains` 的 JSON key 即 agent 名，已写旧名的配置解析为未知 agent（告警忽略），需手工同步改名为 `finder`/`scholar`/`advisor`。
- **三条客户端防呆护栏（开发门禁）**：本次交付暴露出三个同源盲区，现全部测试化——① **字典标签护栏**：设置页每个字段（含链编辑器的每条行）必须在英文与中文两套字典里解析出标签与说明，**不得退化成原始键名**（此前 locale 的 `lookup(...) ?? key` 兜底会把 `delegateAgentChains` 直接当标签显示，用户于是“看不到”已发布的功能；该护栏还揪出了两个历史上就缺标签的老字段）；② **客户端↔服务端名单对拍**：设置页的类别名单与精选 agent 名单分别钉在 `Object.keys(DEFAULT_CATEGORIES)` / `Object.keys(CURATED_AGENTS)` 上，任一侧漂移即红；③ **chunk mtime 护栏**：任何 `lib/client.*.js` 的 mtime 不得晚于入口 `lib/client.js`（把“chunk 编辑后必须重戳入口 rev”这条运维红线从纪律变成测试）。

### Fixed

- **委托目标靠「先失败一次」才学会（模型可见面缺陷，实测确证）**：`delegate` 工具描述声称类别清单与路由指引 "listed in the orchestration doctrine and this tool's runtime diagnostics"，但实测**两处都没有**——实测取证：本会话系统提示词的 `system/message` 与工具 schema 的 `request/header` 中，9 个类别名一个都不出现。Orchestrator 只能从一次**失败的调用**里学到「派发必须点名类别」以及类别名（唯一能学到清单的路径是 `unknown_target` 报错文本本身）。现由注入小节在**首次调用之前**交付用法与启用目标清单，工具描述同步删除该错误声明并改为指向小节。
- **`model` 对 agent 派发完全无效（未兑现契约）**：工具描述承诺 "model is honored for agent spawns only"，但 `target-resolver.js` 的 agent 分支从不读 `item.model`——参数被 `normalizeItems` 校验通过后被静默丢弃。现生效为「否则会使用的那条路由」的 model id 覆盖（provider 取该路由的 provider；不因 provider catalog 未列出而拒绝——DSH 契约里 catalog 是 advisory）。
- **精选 agent 的 `reasoningEffort` 是死数据**：`CURATED_AGENTS` 里的 `finder: low` / `advisor: high` 从未被应用（agent 分支此前不产生 `agentOptions`）。现在仅在所选路由确实声明该档位时应用，否则静默丢弃（与类别继承路径同一规则）。

## [0.5.0] - 2026-10-01

### Changed

- **只读白名单改为"产品默认 + 用户追加"（BREAKING）**：此前五张白名单表既由模块常量承载、又在 `cordis.patch.yml` 的 `orrery-settings` 行 `config:` 里逐字镜像，而 DSH 组合 patch 层是**整体替换 config 而非深合并**（`applyEntryPatches` 执行 `target[key] = value`）——于是**用户只要在设置页改过任一张表**，其完整列表就被写进 profile 行并冻结成快照，此后 bundle 更新追加的默认项**永远到不了那个用户**（`Start-Sleep` 缺失事故正是这条：仓库基线有、活会话没有、无任何信号）。现在默认值改由**独立的 `whitelist-defaults.json`** 交付：该文件由插件在**运行时按自身位置读取**，不经任何配置层，因此任何 profile 行都替换不掉它——**只改这一个文件，产品更新就能抵达全部安装**。合并语义随之由"在场即权威"改为**追加**：设置键在场且非空 → 条目**追加**到产品默认项之后（去重、保序）；键缺席或为 `[]` → 不追加。**任何配置都无法移除默认项**，因此"显式清空 = 全不放行"不再可用（该能力退役：同一个"清空"动作在 allow 侧是收紧、在 deny 侧却是全放行，语义本不自洽）；deny 侧的收紧能力完整保留。内置常量降级为**按表兜底**：默认值文件缺失/不可读或某表畸形时，该表回退到常量并记一行英文告警，其余表仍取自文件，**绝不因坏文件放宽守卫、也不拒绝启动**。高级用户可经 `robashDefaultsPath` 指向自己的副本以**整体接管**默认值，改完递增 `robashDefaultsReload` 即**显式重读**（每进程只读一次并缓存；两个键均为配置面键，刻意不出现在设置页）。`cordis.patch.yml` 中的五个白名单键已移除，该不变式（行内不得出现白名单键）由反转后的镜像测试守护并做过变异验证；旧的启动期基线漂移报告（`src/shared/whitelist-drift.js`）随之退役——它要报告的那类遮蔽已不可能发生。
- **只读守卫拆为「一个深核心 + 两个薄壳适配器」（内部重构，零行为变化）**：`robash-guard.js`（560 行）与 `robash-guard-pwsh.js`（721 行）本是同一个守卫模块按壳复制的两份三层架构，漂移已经落地（`DANGEROUS_FLAGS` 只存在于 bash 侧；pwsh 侧反向 import bash 模块的 `checkGitArgs`；白名单表三处表示靠专门的 parity 测试互相钉死）。现收编为新深模块 `src/delegate/robash-guard-core.js`：canonical 白名单 `DEFAULT_TABLES`（五键单一表示，条目逐字迁移并程序化比对一致）、git 门控与两张 flag 表、`GIT_CONFIG_*` 拒绝（两侧大小写差异以显式参数保留）、递归预算（五处字面量收敛为 `MAX_SUBSTITUTION_DEPTH`）、重定向 sink 策略、`gateExecutable` 判定尾段、`DANGEROUS_FLAGS` 按壳键控（bash 行逐字迁移；pwsh 显式空表——把隐式漂移转为显式声明的不对称）、共享理由模板 `reasons`（两适配器同一策略产出逐字相同的英文理由）。两个适配器只保留壳词法并各导出同一签名 `check(command, lists)`；pwsh 侧对 bash 模块的 import 已删除；`whitelist-defaults.js` 的 `FALLBACK_TABLES` 改为从核心**正向派生**（`shared/` 反向依赖 `delegate/` 消除）；parity 测试缩为「JSON ↔ `DEFAULT_TABLES`」单组比对并做变异验证。两份守卫语料测试（214+363 行）与 `whitelist-defaults` 测试**逐字节未动**作为行为冻结证据；挂载面 `attachReadOnlyBashGuard`/`BASH_TOOL_NAMES` 签名不变（S8）。收益：已登记的「whitelist-style `-c` key hardening」后续只需落地一次。
- **沙箱升权策略决议收入单一接口（内部重构，零行为变化）**：`hash_edit` 的一次性沙箱升权此前由调用方在 `execute` 体内手工编排（能力探测、standing 解析、配对校验、门控、审批、合并、cwd），顺序规则即 fail-closed 契约却只能端到端间接断言，`ESCALATION_TARGETS` 字面量重复三处。现 `src/hashline-edit/sandbox.js` 抬升接缝为整次调用的策略决议接口：`probeEscalation(fs)`（能力事实两态，广告字段与门控同源）与 `async resolveCallPolicy(args, env) → { policy, resolveCwd, advertisedFields }`（内部顺序与原编排逐行镜像，错误消息逐字搬移，无升权参数时 policy 与 standing **引用相等**）；`execute` 读作「先决议、后编辑」。S23 五参 `writeText` 形态原样保留；两个既有测试文件零改动（`sandbox.test.js` 仅追加 10 条模块级钉）。附带清理：`apply-ops.js` 删除零 importer 的 `anchorFor` 死导出、坍缩空三元。
- **三插件共享 runtime 消息助手（内部重构，零行为变化）**：intent-gate / todo-driver / context-guard 曾各自重复实现四类 runtime 适配惯用法并漂移（intent-gate 私有重写了共享 UserMessage 构造器；genuine-user 判定两种形态；settings overlay 三份；warn-吞掉注入包装五处）。新深模块 `src/shared/runtime-messages.js` 统一承载：`isGenuineUserMessage`（双形态、事件严格以 `type === 'user/message'` 门控、只判 source.kind、role 留调用方）、`overlayConfig`（defaults 垫底 / section 覆盖 / 声明式 `nestKeys` 承接 intent-gate 的 jev 嵌套映射且特例不外泄）、`injectOrWarn`（调用方逐字传入 warn 前缀，五处既有日志措辞不变）。intent-gate 已切回共享 `userTextMessage`（§3.4 从纪律变为结构）并补齐对称 disposer；注入源豁免矩阵收敛到模块单测唯一一份。模块无任何 `session.append` 路径（§3.6）。三个插件的纯核心未触碰。
- **浏览器半区按特性 chunk 化（内部重构，功能不变）**：`lib/client.js`（1538 行，bundle 最大文件）把六个不相干职责装进一个工厂闭包。现拆为**单一同步入口（671 行组合根）+ 10 个手写 `require.async` chunk**（4 个零依赖 model chunk + 6 个 UI chunk），宿主按精确 URL 直出、零构建步骤（S18 单 `./client` 出口不变；同步 require 面不扩大——S14）。i18n 字典留入口（同步注册契约）、`settingsBus` 提升为 props 注入；chunk 到达前有字典化加载/错误态（可重试）与既有通用 body 降级。新增 **rev 重戳纪律**（chunk 编辑后必须 touch 入口，见其特性文档）。测试改为约 20 行共享 chunk 帮手 + 4 个零桩 model 直测，原 4×60 行 loader 脚手架与杂烩导出退役；全部迁移自原断言、未删除任何行为钉。
- **集成测试装置 scenario 层收编为 registry（开发装置重构）**：一个逻辑场景此前散落在 2 个文件约 7 处（brain/switch/trace 字段/场景表/prompt/assert/派发行），漏配静默哑火，两文件占全仓 churn 约 18%。现每场景一个模块（`src/scenarios/<id>.js`，导出 `{ id, prompt, decide, observe?, assert, run?, env? }`）+ 有序索引；mock 每请求只做一次 `extract` 观察提取（取代约 39 次 transcript 重算），严格供应商 schema 闸门逐字最先；未知场景 id 在驱动与 mock 两端均为响亮失败。驱动零 per-scenario 分支。新单测面：registry 齐备性、brains 进程内直调（mock decide 逻辑首次有单测）、录制 trace 断言回放（fixture 入库 + `pnpm run record`）、三路 audit conformance。**审计类型词汇单源化**：`AUDIT_TYPES`（+ `AUDIT_SUBTYPES`，登记协调器实际发射的全部 7 种 supervision 子事件 kind）冻结注册表导出在产品侧 `shared/audit.js`，七个 emit 站点字面量换常量；装置 event-tap 经相对跨包 import 消费（每次 IT run 即解析实证），手抄清单删除——此前它已漏掉 `supervision/<kind>` 动态子事件。产品行为不变；12 场景 75/75 检查全绿。
- **LSP「子进程怎么跑」收成一个深模块（内部重构，零行为变化）**：「服务器进程在各平台如何拼写」此前劈在两个模块——`executable.js` 管「找」而启动形态（`.cmd` shim 拆包、变量链不动点、`spawnArgv`）却住在「生命周期」模块 `manager.js` 里（占其 58%），管理端点还得 import 生命周期模块拿纯函数；`admin.js` 里「带 deadline 跑到完」的骨架抄了两份且定时器 bug 修了两遍、修法不同。现由 `executable.js` 改名扩载为 `src/lsp/child-process.js`（blame 连续）：可执行解析 → 启动形态 → 受限运行三段一处，`manager.js` 收编为纯 server record 模块（451→169 行），`admin.js` 删去两份骨架改经唯一的 `runBounded(subprocess, { argv, timeoutMs, unref })`（定时器全结算路径释放 + 显式 `unref` 选项——**安装路径 unref / 探测路径 ref**：实证 Node v24 下 unref 定时器开火后仍被活动资源计数短暂滞留，一律 unref 会破坏探测卫生钉，故按调用方显式选择）；URI codec 迁往零依赖纯叶子 `src/lsp/uri.js`（`rename.js` 的 import 链不再传递加载 `node:fs` 面）。spawn-argv 语料与探测卫生钉**逐字节未动**；S19 无新增包子路径。
- **监督注册表收入查询接口之内（内部重构，零行为变化）**：协调器的 `_children`/`_groups`/`meta` 曾直接导出，三个消费者（status-tool、index.js、测试）穿过接缝直摸存储，成员/组记录形状实现四份、终态谓词三份、孤儿检测谓词两份。现注册表存储成为实现细节：查询只经状态机词汇的方法（`ownsChild` / `memberOf`（拷贝）/ `snapshot()`（全拷贝）/ `untrackedAgainstCatalog`），记录形状由唯一构造函数 `createMemberRecord`/`createGroupRecord` 产生，谓词各一份（`isTerminalStatus`/`untrackedCatalogEntries`），一切查询返回拷贝——`_children`/`_groups`/`meta` 导出与测试赋值后门一并删除（不 deprecate）。S24 持久化加固的落点随之就位；`test/delegate.test.js` 零改动存活。
- **计划 diff 预览契约收归生产者侧（内部重构，功能不变）**：`hash_edit` 的 diff 片段契约此前在 result 期干净过缝、start 期却由浏览器手写第二份入参 parser 并捏造 `oldText:null` 形状。现唯一权威实现是 `src/hashline-edit/planned-fragments.js`（op 形预览、`oldText` 按构造为 `null` 成文、纯删除无片段），浏览器 model chunk 携带逐字派生副本（派生副本纪律首入特性文档：没有 parity 钉就不允许逻辑复制）；新增跨侧测试三节——src 单测、chunk↔src 等价钉、以及**首次** planned↔applied 对账（经真实 `applyOps`+`diffResult` 结果路径）。篡改验证：派生副本一处漂移即红。
- **todo 续推与压缩结果的分类词汇命名成纯函数（内部重构）**：`classifyTurnOutcome({ signal, reason, error })` 住进 `state-machine.js`——11 行优先级真值表把 AGENTS.md §3.5 的两条顺序不变量成文（durable reason 绝对优先；signal 先于 error），两个决策点消费同一结果，重复两遍的 user-interrupt disarm 收敛为单一实现（删重复不删行为，signal 路径仍承重）；adapter 侧 `abortCauseKind` 助手删除、cause-kind 提取内化。既有行为钉（含用户打断不续推承重用例）全绿。
- **`jsconfig` 静态检查覆盖新纯模块**：`run check` 的 include 清单补录近期新增的纯模块（`runtime-messages`/`user-message`/`robash-guard-core`/`compaction-outcome`/`planned-fragments`/`sandbox`/`uri`），并把筛选规则写进文件注释——清单只收无 ctx、无 node 内建依赖的纯模块（`types: []` 剥离 Node 全局，插件 adapter 从来不在其列）；两处 JSDoc 类型标注随之修正（零运行时影响）。
- **settings 行的六个 concern 拆成命名接缝（内部重构，零行为变化）**：`settings/index.js` 曾把 schema 声明、section 重分组、JSON 字符串解析（三个解析器、三份裸缓存、两个「为测试而导出」）、volatile ref 解包（两处开码）、白名单发布与 LSP 端点接线平铺在一个闭包里。现 schema 与 `SECTIONS` 由 `src/settings/sections.js` 的**单一 FIELDS 表**生成（五张 robash 表名在文件内只声明一次），纯函数 `computeSections(config, { readDefaults })` 承载全部分层/追加/接管语义，`parseJsonField` 以 WeakMap 键控取代三份裸缓存（只缓存成功），三个 validator 私有化（错误文案逐字保留），`src/settings/volatile.js` 成为产品代码唯一点名 `isVolatile` 的适配点（S16 义务）；LSP 端点接线体迁入 `src/lsp/admin.js` 的 `wireLspAdmin(ctx, getServers)`，调用点按 S19 留在 settings 行。新增键集对拍测试（FIELDS ↔ patch 行 ↔ 设置页 GROUPS，已变异验证）防三处表示漂移；`settings.test.js` 大部分用例改经 `computeSections` 直断，不再重复伪造整个 ctx。`orrerySettings` 服务接口与一切可观察行为不变。
- **delegate 三条 spawn 道共用一个 spawn adapter（内部重构，零行为变化）**：`tool.js` 的前台/后台/受监督三条道曾各自复制同一份 `subagents.start` 请求装配（四份近乎相同的字面量，`maxDepth: 1` 拓扑契约散在四处），受监督道的守卫挂接还在句柄路径与失败语义上分了叉。新模块 `src/delegate/spawn-adapter.js` 收编 spawn 道轴：`spawnGuardedChild` 让「started ⇒ 已挂守卫」成为不变量，装配单点化（`maxDepth: 1` 只剩一处），守卫核心按统一次序运行（句柄解析先于 disabled 检查——「缺失+禁用仍抛」已钉测；禁用快照跳过与两种拆除机制的**刻意**差异均逐字保留并注明理由）；编排层（escalation、jobs 包装、两阶段/回滚/seal）留在 `tool.js`（406→316 行）。文本提取收敛进 `src/shared/content-text.js`（`readChildFinalText` 的 continue 守卫保留）。`delegate.test.js`（1022 行）**逐字节未动**。
- **LSP manager 接口从 record 回调换成命名操作（内部重构，零行为变化）**：`manager.call` 曾把内部 server record 直接交给每个调用方（`tools.js` 直读 `record.client`/`diagnostics`/`capabilities`，record 的 languageId 原地改写成事实公开面，`_servers` 死导出无人消费）。接口现为 manager 自己的词汇——`requestOn`（同步 + `paramsOf(uri)`）、`diagnosticsFor`（wait-once 策略与调参值收进内部）、`capabilitiesOf`（握手能力集，不做文档同步）——背后是私有 `prepare()`（family 解析/serverFor/languageId 赋值/holder 登记/touch）；`call` 与 `_servers` 删除。rename 的能力门移到文档同步前（无 `renameProvider` 的错误路径少一次无谓 didOpen；正常路径通知序列逐字节不变）。`createLspManager` 获得首个直接单测套件（13 例：握手拆卸、holder 引用计数、idle 关停、同步顺序），三个必须存活测试文件**逐字节未动**。
- **delegate 接线 god-file 拆成五个命名模块（内部重构，零行为变化）**：`delegate/index.js`（581 行）曾把设置覆盖策略、监督挂载与六个效应器、两个内联工具定义、三个冷读读取器与 `resolveTarget` 解析脊柱全部锁在一个 `apply` 闭包里，目标解析概念还散在六个文件。现 `index.js` 是 90 行纯组合根（零 `node:` import），职责分住五个命名模块：`settings-overlay.js`（delegate 专属覆盖层工厂——三层 append/去重与整链替换语义，刻意不套用 shared `overlayConfig` 的浅合并模型；`fallbackTables`/`platform` 注入保持纯度）、`target-resolver.js`（「item + 父路由 → persona/options/filter/label」唯一脊柱；provider 快照缓存闭包化；`robashNow()` 双重解析收敛为单次调用——可证明行为零变化；浅模块 `families.js` 折叠进来并具名导出，文件删除零残留）、`supervision-mount.js`（协调器工厂与六个效应器，`notifyParent` 策略常数逐字，S10.1 timer 延迟投递结构性保持）、`supervision-tools.js`（`resume_agent`/`terminate_agent` 定义与 `withUntrackedHint`，schema 逐字）、`audit-readers.js`（三个冷读读取器，此前零直接测试——迁入后补了临时目录夹具套件）。五个新模块各获鸭式注入的模块级单测（不再伪造整个 cordis ctx）；`delegate.test.js`（1022 行）只改一行 import。

### Fixed

- **排队压缩被静默丢弃（现行 bug，实测确证）**：上下文压力守卫在压缩服务忙碌时应返回「排队到下一边界重试」，但结果分类只对错误消息文本做正则（`/busy|active|not idle|running/i`）——宿主两个真实 busy 变体（"manual compaction: the session already has an open turn" 与 "manual compaction requires an idle agent with no waking queued work"）一个词都不含，于是被判为 failed → **待执行压缩被静默丢弃且不再重排**（宿主 `ManualCompactionError` 其实早就带文档声明稳定的结构化 `code` 字段）。修复为结果分类唯一实现 `classifyCompactionOutcome(error)`（新纯模块 `src/context-guard/compaction-outcome.js`）：`code === 'busy'` 判 busy；其他任何 string code 判 failed 且**消息文本永不参与**（防止非 busy 错误措辞碰巧含 "active" 而被无限重排）；无 string code 时遗留消息正则兼底。红绿证据：新 busy→重排队用例在旧代码上失败、新代码通过；插件级闭环断言首次 turn/end 无 warn、第二次边界再次触发 compactNow。

## [0.4.0] - 2026-09-30
### Added
- **只读 bash 白名单三表设置页可编辑**：`robashAllow` / `robashGitAllow` / `robashDeny` 三个 volatile 设置键（JSON 字符串数组）接管守卫的命令白名单 / git 子命令白名单 / deny 列表，设置页提供结构化行编辑面板（`RobashListEditorField`，逐行增删改、保存程序化合成 JSON），不再手写 JSON。每个键独立解析：未设置 → 回退下层（行 config → 模块默认）；已设置（含空数组）→ 权威生效——**显式清空 = 全不放行（fail-closed 更严），绝不回退默认**；坏 JSON 设置服务激活即败。命名约定 `robash<Shell>*` 为后续 pwsh 白名单键预留扩展位。
- **`lsp_rename` 跨文件语义重命名**：第五个 LSP 语义工具（首个改写工具）——语言服务器算出 WorkspaceEdit，插件经 fs 版本护栏安全落盘：两阶段提交（先对全部目标文件预检——解析/stat/读取/行尾采样/合成新全文，任一失败零写入；再逐文件 `replaceIfVersion` 原子写回），写入中途 stale/沙箱拒绝即停且报告精确列出已写与未写文件；原行尾风格（LF/CRLF）写回保留（CRLF 不被静默 LF 化）；服务器未声明 `renameProvider` 或返回 `documentChanges` 显式拒绝且零写入；恒等编辑报空操作。结果逐文件渲染 unified diff 与汇总。refactor 技能与 README 文案同步转为正式表述。
- **只读守卫覆盖 pwsh（Windows 只读 shell 补全）**：守卫新增独立 PowerShell 解析路径——反引号转义先还原再查表（`` i`ex `` → `iex` → 拒绝）、反引号换行续行与孤立 CR 语句终止在解析前归一化、`&` 调用操作符剥除（动态 `& (...)` 直拒）、`$(...)`/`(...)` 递归校验、here-string 检测与插值扫描、内建只读别名表展开、大小写不敏感查表（deny 优先且同时命中别名展开前原始名）、写重定向集拒绝（`$null`/fd 复制放行）、`--%` 直拒；默认表为保守只读 cmdlet 子集 + 逃逸向量 deny（`iex`/`Invoke-Expression`/`Start-Process`/`Set-Content`/`Out-File` 等），git 子命令门控与 bash 侧共享且封堵 `-c alias.*`/`core.pager`/`pager.*` 与 `GIT_CONFIG_*` 环境偷渡。**裸脚本块/哈希表字面量（`{...}`/`@{...}`）一律拒绝**（PowerShell 会执行脚本块主体，表达式模式可执行形态无法枚举；惯用 FilterScript 由简化参数语法承接），赋值右值与表达式组的静态访问（`::`）与全形态方法调用直拒。`readOnlyTools` 按平台并入 shell（win32 → pwsh，其余 → bash）——此前 Windows 只读代理零 shell 能力（双失配）消除；只读代理 persona 提示按平台命名正确 shell。设置面兑现 T4 预留命名：新增 `robashPwshAllow` / `robashPwshDeny` 两键（与 bash 三表同缺席回退/在场权威语义，复用 `RobashListEditorField`）。**验收边界**：无 Windows 验证环境——解析正确性与绕过抵抗由单测语料（含三轮独立评审累积的 66 拒/29 放对抗矩阵回归钉死）与 mock wiring 保证，真实 pwsh 行为与桌面实机验收待用户在 Windows 执行。已知残留：git `-c` 的其它可执行配置键（`diff.external` 等）登记为后续加固项。
- **启动时报告只读白名单漂移**：预设的白名单基线在**运行期不可见**——DSH 组合 patch 层用**整体替换**而非深合并（`applyEntryPatches` 执行 `target[key] = value`，host README 原话 “does not deep-merge”），所以 profile 一旦声明自己的 `orrery-settings` 行，bundle 的 `config` 就被整个丢弃。后果是一份停在旧版本的 profile 行会**静默压过后续所有基线加固**：仓库基线给 pwsh 白名单补了 `Start-Sleep`，而 Windows 上的只读代理依旧不能等待，只有一条看起来像“这东西本来就不被允许”的拒绝文案。现新增 `src/shared/whitelist-drift.js`，在 `settings` 的 `compute()` 里**每进程一次**从 bundle 自己的 `cordis.patch.yml` 重读基线并逐表比对，有缺项则经 `ctx.logger.warn` 报一行英文警告（点名缺哪些项、为何失效、两个补救动作）。**只报告不修改**：绝不重写 profile、绝不放宽守卫、绝不阻断激活；patch 文件不可读即静默降级。判定刻意保守：只算**缺失**（用户**增加**项是放宽自己的守卫，不算漂移）、组合**没有**声明白名单时静默（分层回退的正常形态，也是 headless 集成 profile 的形态）、某表被声明为**空数组**时静默（文档化的“在场即权威、fail-closed 更严”刻意清空）、pwsh 两表大小写不敏感比对。新增 16 条单测（含静默条件与降级路径）；产品单测 704 条 / 703 通过 / 1 跳过；集成测试 73/73 且**无新增输出**（证实不漂移的组合不受影响）。
- **集成测试装置跨平台可移植（Windows 可跑）**：`orrery-test-harness` 此前按 macOS 开发机写死，Windows 上 `test:integration` **51/73 通过、22 条失败**（失败全在装置自身：`robash` 2 / `grouped` 5 / `terminate` 3 / `rehydrate` 6 / `lsp` 5）。四处平台假设逐项消除：① 驱动 `run.mjs` 的 node/pnpm/dsh CLI/测试根四路径改为「环境变量覆盖 → 平台默认」（POSIX 默认值逐字保留，macOS 开发机行为不变；Windows 默认指向捆绑运行时、npm 全局 `dsh 0.1.7-rc.2`、盘符绝对路径）；② mock LLM 此前硬发 `bash` 工具调用与 `echo`/`sleep`/`rm -rf` 语料（共 11 处），而 Windows 只读 Agent 拿到的是 `pwsh`，子成员第一步就调不存在的工具、永不结算——新增 `src/shell.js` 抽象（`shellToolName` + `shellCommand` + `SHELL_OPERATIONS`，**刻意不是通用 shell 翻译器**：只覆盖场景真正用到的五个动词，且动词与校验器分居 `POSIX_BUILDERS` / `WIN32_BUILDERS` / `ARG_VALIDATORS` 三张同名表、由契约测试钉死三表键集一致，因此「新增动词却忘了写校验」在结构上不可能；每个参数过严格语法校验，场景字符串无法夹带 shell 语法），mock 改发具名操作；③ `rehydrate` 断言的工具名按平台取（该断言因此反而更强：现在对得上产品真实输出）；④ profile patch 层的 LSP mock 服务器命令由 macOS node 绝对路径改为 `!!js process.execPath`（不再需要任何解释器绝对路径），该文件因此不含任何平台默认值。另有 mock 内 4 处 + event-tap 内 1 处（共 5 处）POSIX 默认路径统一由 `IT_ROOT` 推导，消除跨文件口径分歧。**测试**：新增 `test/shell.test.js` 契约语料 20 条（期望值为独立字面量，能与实现真正分歧；含未知操作/未知平台/非法秒数/可夹带语法的标记与路径四类拒绝，加两条三表键集一致性断言）；集成测试 **73/73 全绿**（退出码 0），且跨平台移植**未放宽任何断言**——12 个场景移植前后均为 73 条检查，diff 只动了一条断言（把 macOS 专属字面量 `'bash'` 换成平台取值）。**产品代码零改动**：`orrery-harness` 静态检查零错误、单元测试 655 条 / 654 通过 / 1 跳过（POSIX-only，Windows 预期跳过）。新增 `docs/features/integration-test-harness.md`（含两条已登记覆盖边界）。

### Changed
- **`hash_edit` 大段内容改由单个字符串承载**：每个编辑操作的内容字段从 `lines`（字符串数组）改为 `text`（单个字符串，行间为两字符转义 `\n`，空串 = `replace` 纯删除 / `append`、`prepend` 无操作）。动因：宿主适配器在流结束处逐个解析工具参数，任一非法 JSON 即作废整轮——对 105 份会话日志的实测扫描中该类事故 7 起、7/7 落在 `hash_edit`，坏点全部在 `lines` 数组的括号闭合边界（载荷 797–5393 字节的大段中文 append）；单字符串通道消除了「数组闭合 + 对象闭合」的结构混淆点。切分规则 `split('\n')` 至多丢弃一个尾部空元素、内部空行保留，与写盘 `join('\n')` 互逆。schema 恢复完整描述契约（`required: ['op','pos','text']`）；形状错误先于锚点校验拒绝并带「按正确形状重新调用」自纠措辞；工具描述新增 invalid-JSON 整轮警告与空串删除说明（974 字符，旧版 818，上限 120%）。**版本影响：breaking，pre-1.0 按 minor 打版。**

### Removed
- **`hash_edit` 的 `lines` 内容通道**（BREAKING）：字符串数组形态从 schema、运行时、测试与文档整体移除，仓库内不再保留任何 `lines` 示例（不给未来会话留模仿源）。经「无兼容包袱」评估后硬替换——Harness 迭代期无旧调用、无旧会话；偶发的旧形状模仿调用收到带自纠措辞的普通工具错误（JSON 合法、turn 不废、重试一次即过）。

### Fixed
- **LSP 服务器握手失败残留僵尸记录**：懒启动的 initialize 握手失败（如工作区 TypeScript 安装缺 tsserver）后，该 (工作区, 语言族) 键被能力缺失的死记录占住，后续调用持续失败直至会话重开。修复为握手失败即终止进程、丢弃记录、原样抛错——下次调用起全新服务器（实况发现，附变异验证回归测试）。
- **Windows 只读代理无法执行等待（平台能力不对称）**：同一个“等待”操作在 macOS 上放行、Windows 上被拒——POSIX 侧 `sleep` 在 bash 白名单里，而 win32 侧 `Start-Sleep` **两张表都没有**（当时 allow 与 deny 两张表逐项核实均无此名），并且 `sleep`（pwsh 内建 ReadOnly 别名 → `Start-Sleep`，已对真实 pwsh 7.6 实测核实）未被别名表登记，于是以原名撞 allow 表被拒（`'sleep' is not on the read-only allow list`）。修复为双管齐下：`Start-Sleep` 入 pwsh allow 表，`sleep` 登记入别名表（与 bash 侧的 `sleep` 对齐）；**两处必须同时在场**——预设 `cordis.patch.yml` 的 `robashPwshAllow` 是组合基线、且设置层最后合并在场即权威，所以只改模块默认值在预设里是**空操作**。由此新增一份**名单镜像不变式测试**（`test/robash-whitelist-parity.test.js` 直接读 patch 文件校验五张白名单逐项同序一致；已用**变异验证**确认：把 patch 行改回去，恰好该断言失败、退出码 1）——该不变式此前仅靠注释维护、已真实漂移过一次。装置侧把 `robash` 子成员的命令体改为一发 `echo-and-wait`，使其成为该修复的端到端钉；**覆盖边界要说准**：该装置不加载产品 bundle 与预设 patch（走模块默认值），因此这一钉只覆盖“模块默认 allow 项”，**预设 patch 行与别名行的缺失它看不见**，那两层分别由镜像不变式测试与别名语料守护。产品单测 671 条 / 670 通过 / 1 跳过，集成测试 73/73。
- **白名单列表编辑器空白/非法值死路**：`RobashListEditorField` 原先对空白或非法存储值拒绝打开编辑器（字段永久不可编辑——旧 profile 的设置行 config 先于新键存在时必现）。改为空白值（各层均未设置）不报错并以空列表打开；非法值显示报错态但仍以空列表打开，保存即覆盖——任何存储态都不会把字段卡死。
- **Windows 上 LSP 服务器不可用（解析与启动双断）**：插件在 Windows 下既解析不到语言服务器也启动不了。四处平台假设——① 绝对路径判定只认 `/`，`C:\...` 被当命令名交给服务解析器；② 扩展扫描目录只有 POSIX 布局，未含 npm 全局前缀 `%APPDATA%\npm`（`~/.npm-global` 的 shim 在根而非 `bin`）；③ 裸名不按 `PATHEXT` 探测扩展名；④ 子进程 PATH 用 `:` 拼接而被撕裂。另有两处启动级缺陷：CreateProcess 不执行批处理（Node 对 `.cmd` 直接 `EINVAL`），以及 NTFS 无执行位仍以 `X_OK` 作可执行判据。现按平台参数化解析（win32 目录/PATHEXT/分隔符），并以**不经 shell** 的启动形态交付：三类真实 `.cmd` shim（npm 自带的 `%NODE_EXE%`/`%NPM_CLI_JS%` 链、corepack/pnpm 的 `%~dp0` 形态、`%_prog%` 模板）都被读入拆包为 `node <cli>`，因此含空格的路径与 cmd 元字符都不再危险；仅当路径与参数可证明 cmd 安全时才回退 `cmd.exe /d /c`，否则明确拒绝；POSIX 行为不变。实机验收：本机四个真实 shim（npm 11.17.0 / pnpm 11.7.0 / ts-ls 6.0.1 / dsh 0.1.7-rc.2）均无 shell 启动成功；跨三文件五处 rename 成功（`file:///d:/` URI 形态正确）、CRLF 字节级保留、`FS_STALE_VERSION` 中途截断精确报出已写/未写文件。
- **LSP 管理端点的两个定时器会拖住宿主进程**：`probeVersion` 在超时结算路径不释放定时器，留下已武装的 8 秒定时器；`runInstall` 的安装截止时间（默认 600 秒）未 `unref`——若安装 promise 无人等待（HTTP 处理已应答或调用方放弃），整个进程会被钉住至截止时间。两者现均在**所有**结算路径释放（`try/finally`——真正漏的是抛错路径：启动失败会从 race 中抛出，已武装的 8s 定时器让进程多活到它开火，实测 4ms 工作 / 8007ms 进程寿命 → 修后 7ms），截止时间另加 `unref()`。
- **委派设置在同一进程内不生效（与文档承诺相矛盾）**：`docs/features/category-delegation.md` 与 README 均承诺 settings 页的 volatile 改动「在线编辑即刻生效」，但 `delegate` 插件在 `apply` 期只读一次 `robash` / `delegate` 两个 section，此后把结果冻结进只读工具面与监督参数；设置服务确实广播变更（`loader/volatile-update`），但全插件只有 LSP 订阅了——**广播有、没人听**。后果是用户在设置页改 `robashEnabled`、五张白名单任意一张、或三个 `supervision*` 值，在本进程内（含此后新建的会话）**全部无效**，必须重启应用；失败是静默的（设置页显示新值、行为不变）。修复为两条路径同时到位：①**读取时解析**——两个 section 改为在每次消费点重新解析（派发时解析只读工具面与守卫列表，建协调器时解析监督参数），不再在 `apply` 期快照；②**提交时推送**——`apply` 订阅 `orrerySettings.onChange` 并把新监督参数推入**已建立**的协调器（协调器按父会话缓存、不随新委派重建），`apply` 返回清理函数退订，与 `src/lsp/index.js` 同一范式。一次性委派内的工具面与守卫列表取同一份快照，不会出现「已授予 shell 但守卫已关」。既有分层语义逐字保留（缺席回退行 config → 模块默认；在场权威，含空数组 = 显式清空 fail-closed）。新增 9 条回归测试（4 条 `hot reload:` 插件级 + 2 条挂载层 + 3 条 `setSupervision` 协调器级），其中「提交抵达已建立协调器」与「提交前旧行为必败」两向均验证。**未覆盖**：`intentGate`/`todoDriver`/`contextGuard`/`hashlineEdit` 四个插件仍有同类启动期快照，本次未改，已在特性文档登记。
- **只读守卫的「参数」维度缺失：`rg --pre` 等可绕过白名单执行任意命令**：守卫对**命令名**用白名单判定，但对**参数**只做逐命令特判（`find` 有 `FIND_DENY_FLAGS`，`sort` 有 `-o` 特判），其余一律放行。后果是几个**已在白名单里**的只读命令各自带一个能改行为、写文件或执行任意命令的参数，形成逃逸面：`rg --pre "cmd"` / `rg --pre=cmd` / `rg --pre-glob` 会在每个文件上运行**任意命令**（`--hostname-bin`、`--sort`/`--sort-files` 同类）；`uniq in.txt out.txt` 的第二个位置参数就是输出文件（stdin 在守卫场景不可用，故两个文件参数必然意味着写出）；`date -s` / `--set` 改系统时钟，`-f` / `--file` 从文件读时间戳。修复为把逐命令特判升级为**声明式危险参数表**（`DANGEROUS_FLAGS`，每行：精确 flag / 前缀 flag / 粘连短选项 / `positionalWrite`），新增二进制只需加一行而不是再写一个 `if`；`find`/`sort` 的既有特判并入该表，语义逐字保留。规避误伤：`rg -o` 是 `--only-matching`（读）故只对 `sort` 用 `-o` 粘连规则；`--pre` 按整 flag 匹配，`rg --replace` / `rg --pre-glob` 分别正确放行/拒绝；`--` 后若作为纯位置参数则不会误报（残留边界：`--pre` 的值形式未被识别，fail-open）。新增 35 条语料（20 拒 / 15 放），现有语料零改动。
- **两条单测断言把宿主平台写死，macOS 上必败**：`windows` 分支的 LSP 语料只在 Windows 上跑过，POSIX 侧从未执行，暴露出两处硬编码。① `test/lsp-spawn-argv.test.js` 的 9 条 win32 shim 用例把 `C:\...` 形态的 shim 路径交给 `spawnArgv`，而实现用宿主 `node:path.dirname` 取 shim 目录——在 POSIX 上 `dirname('C:\a\b.cmd')` 返回 `.`，于是 shim **从未被拆包**、全部落到 `cmd.exe` 回退，与期望 `[node, script, …]` 全面不符（该文件自引入起（`9fe876b`）在 POSIX 上就从未绿过，只是没有任何 POSIX 主机跑过它）。修复为把 `dirname` 补成与既有 `join` 并列的接缝（`options.dirname`，默认仍是 `node:path.dirname`），语料同时驱动两者为 win32 路径算术，真机断言因此在两个平台上逐字相同；唯一需要真实文件系统的用例改为用宿主分隔符拼目标路径（`%~dp0` 本就展开为目录加其后分隔符，与真实生成器同形），从而保留「目录不算目标、真文件才算」这条谓词断言不变。② `test/lsp-client.test.js` 的装机提示断言调用 `displayInstallCommand(lua)` 而不传平台，而该参数默认取**宿主**平台：lua 只有 darwin 规格，于是 Windows 上落到多平台兜底提示（断言过）、macOS 上返回 brew 命令（断言败）——按评审原意即“该平台无规格时回落到兜底提示”改传显式平台。**测试**：产品单测在 macOS 上 706 条 / **706 通过 / 0 失败 / 0 跳过**（修复前同一提交为 697 通过 / 9 失败，且被顺手修正的第三条断言失败早已被测试计数掩盖）；POSIX 专属的 root 执行位用例在 macOS 上真实执行而非跳过。

### Security
- **pwsh 守卫可被单独 `&` 完整绕过（只读白名单形同虚设）**：PowerShell 7 中单独 `&` 与 `&&` 同为**管道链操作符**（已对真实 pwsh 7.6 实测：`ParseInput('Get-Date & Remove-Item x')` 零解析错误、token 流含独立 `Ampersand` token、且尾部语句**真的执行**——探针里目标文件确实被删除）。而守卫扫描器只按 `&&` 切分语句，于是裸 `&` 之后的一切被吸进前一段、**从未送查白名单**，由前导的放行命令决定了裁决结果。后果是任何白名单内命令都能洗白任意尾部：`Get-Date & Remove-Item x`、`Get-Date & Start-Process calc`、`Get-Date & iex "rm x"`、`Get-Location & git push` 全部放行（bash 侧同类输入一直正确拒绝，受影响面仅 pwsh 侧）。修复为按位置区分 `&` 的三种角色：`>&` 是 fd 复制重定向（`2>&1`）透传、交由段内 tokenizer 校验；`&&` 无论在何处都是分隔符；**段首**的单独 `&` 才是 `& <word>` 调用操作符（留在原位由段检查器剥除，动态调用 `& $(Get-Date)` 仍拒）；**其余位置的单独 `&` 按后台操作符 fail-closed 拒绝**——包括尾部命令也在白名单里的情形（`Get-Date & Get-Location` 亦拒），因为不可证明的是该结构本身而非尾部命令。新增 11 条对抗语料（10 条洗白尾部 + 1 条“放行尾部也拒”）与 6 条回归语料（`&&`/`||`/`;`/管道/`& git status`/`& "git" …` 行为逐字不变），并修正 `docs/features/category-delegation.md` 中“`&` 调用操作符剥除”这句会令人误以为 `&` 已被完整建模的表述。**验证**：先红（11 条全败）后绿（守卫语料 154/154），产品单测 688 条 / 687 通过 / 1 跳过，集成测试 73/73。**发现路径**：本缺陷由上一项变更（Windows 等待原语）的独立门审报出为“范围外旁注”，经主 agent 在真实 pwsh 上独立复现确证后另立本案修复——门审的价值在此直接体现。
## [0.3.0] - 2026-09-29

### Added

- **受监督小组的可见性与重启恢复**：新增 `supervised_status` 工具（仅主 agent 可用）——逐子代理展示 id/名称/组/状态（`running`/`blocked`/`completed`/`terminated`）/续推次数/报告摘要，逐组展示成员数与 sealed/settled，并对 DSH catalog 中未被协调器登记的 continuable 子代理做孤儿检测（与空注册表明确区分）。受监督状态机每次迁移写入**结构化审计事实**（`orrery/supervision/spawn|seal|settle|resume|terminate|group-settled` 落 `.orrery/audit.jsonl`）；宿主重启后首次访问协调器时**三层重建**——审计尾部回放（按父会话 id）+ DSH `subagentCatalog` 交叉核验 + `sessionQuery.readSession` 子会话日志终态重解析（孤儿提升为 `recovered` 合成组），重建结果携带 confidence（full/partial）：partial 时工具输出诚实降级诊断，catalog 存在 continuable 子代理时绝不宣称无受监督子代理；重建后已全员终态的组重发一次 group-settled 信号。集成测试新增两阶段重启模拟场景（跨进程 adopt 同一会话）。
- **hash_edit 一次性沙箱升权**：与 stock `write`/`edit` 同契约——沙箱后端在场时 schema 广告 `sandbox_permissions`（`workspace-write`/`danger-full-access`）与 `justification` 两个可选参数；参数配对校验先于任何文件操作，同模式重复免审批，严格更宽档经用户审批一次性生效（仅本次调用），拒绝/取消/无通道/无审批服务一律 fail-closed。沙箱拒绝改报共享 deny 标记（`[sandbox: file access denied under <mode> mode]`）+ 同轮升权提示，与 stock 工具同一套词汇；无沙箱后端的组合不暴露这两个参数（行为不变）。词汇与编排在 `src/hashline-edit/sandbox.js` 自实现（link bundle 红线禁静态 import `@deepseek-ai/*`，宿主包文本逐字锁定于单测），零新 npm 依赖。集成测试新增真实越界编辑断言（共享标记与提示逐字到达模型）。

### Changed

- **受监督组成员的工具面收窄**（BREAKING，仅受监督子代理）：受监督成员 spawn 时强制 deny `send_message`——子→父直发通道关闭，唯一上报通道为二元终态契约（`STATUS: completed/blocked`）；只读成员维持既有 allow 白名单，主 agent 自身的消息工具与 DSH 结算通知不受影响；非受监督委派行为不变。
- **监督通知改走内建结算通道**（BREAKING，主 agent 可见面）：退役 `<supervised_blocked>` 逐成员通知与合并组报告——每个成员的终态报告经 DSH 内建结算通知即时送达（正文含 `STATUS/REPORT` 全文）；组全员终态后送达恰好一条**一行 group-settled 信号**（组名与成员数，不含成员正文），投递**镜像 DSH 内建结算通道（`sendWaking`）语义**——信号严格排在组内最后一条成员结算通知之后（父会话日志观察全员终态通知为准，通知缺失时 1s 兜底）；父忙→`steer` 同轮紧随注入，父闲→`followup` 唤醒（失败记日志、有界重试、最终失败写审计）。原 outbox/busy 台账/turn-stopping 冲刷机制整体退役，与 todo-driver 的边界竞争消除。`supervised_status`、`resume_agent`、`terminate_agent` 语义不变。

### Fixed

- **hash_edit 在 desktop 实况全量写失败（S23 事故级）**：`ctx.fs.writeText` 未携带 per-call sandboxPolicy，沙箱回退到部署策略（工作区根 ≠ 会话工作区），工作区内任何写入一律 `file access denied under workspace-write mode`（会话切 danger-full-access 亦无效；/tmp 因无条件可写根不受影响）。修复为按会话现算策略并作第 5 参传入（与 stock `write`/`edit` 同契约）；集成测试装置镜像沙箱语义（部署回退根不含测试工作区、工作区移出 /tmp），无策略写入将被同款拒绝（回归已双向验证：预修复 37/38、修复后 38/38）。
- **受监督批量派发注册表污染**：批量任务逐项 spawn+登记，中途校验失败会留下 live 未 seal 的残留组并永久占名。修复为两阶段化（先全量解析、后 spawn）；失败批次回滚已 spawn 成员并释放组名（新增 `orrery/supervision/group-released` 审计事实；未 seal 且全员 terminated 的组名可复用）。
- **续推/重试投递拒绝未处理**：退避重试定时器的 `sendTo` 为 fire-and-forget，拒绝成为未处理 promise rejection。修复为逐条 catch——投递失败审计并降级为 blocked（附投递失败备注）；`resume_agent` 投递失败回退 blocked 并报错。
- **受监督只读成员缺 bash 守卫**：只读守卫只挂载于前台/后台 lane，受监督 lane 的只读成员无守卫。修复为经活跃 agent 句柄（`ctx.agents.get(childId)`，`startContinuable` 不返回 `localAgent`）挂载同款 fail-closed 守卫。
- **意图门把运行时注入消息误判为用户提示词**：`agent/pre-step` 只按 `role === 'user'` 取最新消息、未按 `source.kind` 过滤——DSH 内建监督结算通知（`source.kind: 'subagent-settled'`，正文含子代理完整报告）、意图门自身注入的通知（`orrery-intent-gate`）、todo/压缩续推注入（`orrery-todo-driver`/`orrery-context-guard`）均为 user 角色；其中碰巧含关键词（如报告里出现 "research"/"debugging"/"review-work"/"deep-work"）即触发虚假技能注入（实测：一次 group 测试中结算通知文本触发 research 单发与 deep-work+review+debug 同毫秒四连发；llm 模式下还额外浪费 sidecar 调用）。修复为仅分类 `source.kind === 'user'` 的真实用户提示词（DSH `MessageSourceMap` 契约：真实用户输入含 `user-rpc` 的 kind 恒为 `user`），注入消息一律跳过；新增 4 条回归测试（结算通知豁免/越过注入扫真实提示词/自身通知不重扫/无 source 消息豁免）。
- **todo-driver 同根源问题：注入消息被误判为用户输入**：续推驱动器 rearm 判定为"除自身注入外都算用户输入"（`sourceKind !== 'orrery-todo-driver'`），监督结算通知、意图门通知等运行时注入会虚假重新武装续推（被中断后的会话因一条结算通知又恢复自动续推）。修复为只认 `source.kind === 'user'` 的真实用户输入；新增 2 条回归测试（结算通知/其他插件注入均不 rearm）。

## [0.2.0] - 2026-09-28

### Changed

- **锚点编辑成为默认编辑方式**（行为级 BREAKING，仅 `orrery` 预设）：预设默认开启 `hideStockEdit`，会话中 stock `edit` 工具不再出现，`hash_edit` 为唯一编辑工具；配置 `hideStockEdit: false` 可回归共存模式。其他预设不受影响。
- **LSP 开关语义重构为能力总闸 + 会话面板开关**：设置 `lspEnabled` 由"新会话自动启用"改为能力主开关——关闭时 `lsp` 工具、`/lsp` 命令、面板开关全部不存在，任何通道都无法开启；开启后每个新会话默认关，由会话输入栏新增的 LSP 开关（或 `lsp` 工具）按会话启用/禁用。会话级状态经 `orreryLsp` 会话投影持久化（重启恢复后自动还原）；设置保存实时生效，无需重启。预设行误挂的 `hideStockEdit` 死配置同步归位。

### Added

- **LSP 服务管理面板与社区生态**：设置页 LSP 节新增"管理 LSP 服务"面板——展示全部语言服务器的安装状态与版本，缺失的服务器一键安装（先展示完整命令 → 确认 → 执行 → 输出与退出码回显）。内置注册表从 4 族扩到 **13 族**（typescript/python/go/rust + json/html/css/markdown/bash/dockerfile/yaml/lua/cpp），配方取自社区注册表（nvim-lspconfig / lsp-mode / Helix / vscode-langservers-extracted，纯数据引入、零运行时依赖），安装走各语言包管理器（npm/pipx/go/rustup/brew/apt）。宿主经 `/api/orrery-lsp/status|install` 端点（`ctx.connection.fetch` 注册，认证由 connection 服务供给）支撑面板；面板支持**添加/删除自定义语言服务器**（`lspServers` 设置，可视化表单、程序化合成 JSON，随设置实时生效）。可执行解析加入**扩展目录回退**（GUI 进程 PATH 仅含系统目录，nvm/Homebrew/cargo/go 的 bin 需扫描常见安装目录；status 上报 `installerAvailable`，安装器缺失时面板禁用执行并提示）。LSP 调参（idle/请求超时/诊断等待）进入设置面板并实时生效。VS Code 语言扩展本身不可复用（VS Code API 插件），其捆绑服务器二进制探测列为后续项。

### Fixed

- **LSP 版本探测误报**：`vscode-*` 提取服务器不支持 `--version`（无连接即抛错），探测把堆栈路径当版本展示；现按族配置探测参数（该四族跳过探测）+ 版本行过滤器（拒绝路径/堆栈/无数字行），gopls 改用 `version` 子命令。实机：markdown 版本显示恢复为"已安装"（无乱码），bash 5.8.1 / clangd 17.0.0 正常。
- **LSP 安装器 "not found on PATH" 与安装权限（实况事故，两连）**：desktop GUI 进程经 LaunchServices 启动，PATH 仅为系统四目录，用户 shell 里可用的 npm（nvm/Homebrew）在宿主内解析失败；修复解析后又暴露子进程环境问题——npm 是 `#!/usr/bin/env node` 脚本，scrubbed 子环境 PATH 仍是最小集（`env: node: No such file or directory`，退出码 127），且解析命中的 `/usr/local` npm 全局前缀 root 属主（EACCES，退出码 243）。统一修复：① 可执行解析加扩展目录回退（nvm 目录优先，避开 root 属主前缀）；② 所有 LSP 子进程 spawn 注入扩展 PATH；③ npm 安装钉住用户可写前缀 `~/.npm-global`（已在扫描目录内）。实机验证：真实安装 bash-language-server 成功（exit 0、22s），随后状态读取即报 installed + 版本 5.8.1。
- **预设内锚点编辑缺席（变更 C 实况事故）**：`hideStockEdit` 的挂载期 `tools.restrict` 在真实预设组合中失败——preset standing scope 上 restrict 只能遮蔽继承层工具，而 stock `edit` 来自同一预设内 dsh-tool-fs 的 own scope 注册（"known global tools: (none)"）。统一为逐 agent 限制（`agent/created` 时按 agent 视角检查存在性再 restrict）：agent scope 下 stock `edit` 恒为继承、可遮蔽、目录真隐藏；行为契约不变。
- **会话日志冷读崩溃（事故级）**：orrery 的自定义审计事件（`orrery/intent-hit` 等 5 类）此前直接写入会话日志；本运行时的持久化在冷读（重启恢复 / 子代理 cold-resume）时拒绝解释含未知且未标 ignorable 事件类型的日志，而 `session.append` 无 ignorable 通道——任何写入过这些事件的会话冷读即崩。审计通道整体迁移为冷读安全双写：cordis 运行时事件（`ctx.emit`）+ 磁盘 JSONL 审计文件（`<会话cwd>/.orrery/audit.jsonl`），事件负载形状不变。

### Added

- **只读研究代理的受守卫 bash**：精选只读代理（`explore`/`librarian`/`oracle`）与 `readOnly` 类别新增 bash 能力，由逐命令校验的只读白名单守卫看管——白名单内只读命令（含 git 只读子命令门控）放行；写命令、解释器、嵌套 shell、写重定向、无法证明只读的命令一律 fail-closed 拒绝（v1 不含 `pwsh`）。白名单经 `readOnlyBash.{enabled, allow, gitAllow, deny}` 配置化，可在线迭代；`enabled: false` 时工具面回落到 v0.1.0。
- **六项新内置技能**：`git-master`（git 全流程）、`refactor`（重构分解向导）、`programming`（Python/Rust/TS/Go 严格现代实践，含分语言参考树）、`remove-ai-slops`（回归保护下清除 AI 代码异味）、`work-with-pr`（worktree 中的 PR 全生命周期，gh 缺失可降级）、`remove-deadcode`（安全验证的死代码清理）。自带技能目录扩为 10 项；技能结构（frontmatter/英文正文）由单测机器强制。
- **意图门语义分类器**：`classifier: 'regex' | 'llm' | 'jev'` 三模式可选（默认 `'regex'`，行为不变零成本）。`'llm'` 模式在正则未命中时经 sidecar 调用做语义分类（缓存 + 超时 + fail-open 回落纯正则结果）；`'jev'` 模式为实验功能、默认关闭，经 Jev 决策模型分类。分类决策全量审计（`orrery/intent-classify` 事件，含回落原因）。
- **LSP 语义工具（默认关、随时开）**：自研零依赖最小 LSP 客户端（JSON-RPC over stdio），四个只读语义工具 `lsp_diagnostics` / `lsp_definition` / `lsp_references` / `lsp_symbols`；`lsp` 工具或设置页随时 per-session 开关（默认关）；语言服务器按 (cwd, 语言族) 懒启动、空闲自停、二进制缺失给安装指引；注册表覆盖 typescript/python/go/rust 且可配置扩展。`rename` 列后续项。
- **Orrery 一站式设置面板**：Settings 应用新增 Orrery 专属设置页（schema 自动生成），覆盖意图分类器档位、9 类别模型链、续推/退避上限、上下文压力阈值、锚点编辑开关、只读 bash 总开关；设置经 profile 层 `orrerySettings` 服务按"模块默认 ← 行 config ← 设置值"分层生效，作用于之后创建的会话。schema 依赖以 vendored 形式内置（`src/vendor/`，不新增 npm 依赖）。
- **受监督分组委派**：`delegate` 新增 `group` 参数——同一次调用的全部任务构成一个组（组不支持插入）；成员以 continuable 子代理运行并遵循二元终态契约（只可报 completed / blocked）；正常结束缺终态报告自动催促续推、供应商错误按退避策略续推（30s 翻倍至 5min、上限 5 次）；blocked 报告即时送达；组全员终态后合并为一条组报告送达。新增 `resume_agent`（注入续推上下文恢复 blocked 子代理）与 `terminate_agent`（运行中真打断 / 非运行中仅簿记）两个主 Agent 裁决工具；blocked 疏通后方向大变时支持"终止 + 新派"重置流程。多 Agent 协作全部自研，不依赖官方 Agent Team 插件。

## [0.1.0] - 2026-09-27

首个发布版本。以 DSH bundle `orrery-harness` 交付，声明 agent 预设 `orrery`（GUI 显示名 "Orrery"）。

### Added

- **预设打包**：`orrery` 预设入驻预设选择器，与标准预设完全隔离；bundle 经 link 安装、改动禁用/启用即可重应用；自带技能目录经 `customSkillDirs` 挂载。
- **Orchestrator 总指挥**：主 agent 以 Orchestrator 身份工作，系统提示词内置协作纪律（委派拓扑决策、默认可并行、等待纪律、证据绑定验收、子任务提示词契约、拉取式后台纪律）。
- **意图门**：用户提示词命中可配置意图关键词时自动注入对应工作模式指令；`think` 意图提升当次请求的推理档位；意图表支持在线编辑，每次命中留有可审计事件。
- **分类委派**：`delegate` 工具把任务路由给专长子代理——任务类别绑定模型链与专属提示词（链内逐档解析、死链显式报错）；内置只读研究代理 `explore`/`librarian`/`oracle`；支持批量（≤16）与后台执行；`deep` 类别结果可按 `ESCALATE: deep-plus` 契约自动升级一层。
- **todo 空转续推**：任务清单未完成时自动续推；用户打断即停（直到下一条用户消息）；供应商错误按退避策略延迟重试（默认上限 5 次）；连续续推上限 8 次；`stop_continuation` 工具供模型声明真实阻塞。
- **拉取式后台通知**：后台任务结算仅投递紧凑通知（不含报告全文），完整输出用 `job_output` 拉取；唤醒风暴防护（连续唤醒上限 8）。
- **上下文压力守卫**：实时计算上下文压力；越过软阈值（0.72）提示模型择时调用 `compact_context` 压缩；越过硬阈值（0.88）在回合边界强制压缩；压缩完成自动续推任务。
- **锚点编辑**：`read` 结果每行携带 `N#XX|` 锚点；`hash_edit` 工具逐锚校验、任一锚点失效则整体拒绝（零写入），支持 replace/append/prepend 多操作并返回 unified diff；可与 stock `edit` 共存或配置隐藏。
- **内置技能**：`deep-work`、`research`、`review-work`、`debugging`（英文正文，意图命中自动指向）。
- **集成测试装置**：`orrery-test-harness`（开发专用）——真实 headless runtime + 脚本化 mock LLM，17 项端到端检查覆盖意图门/委派/锚点编辑/上下文压缩。

<!-- 本地私有仓库，无远端；链接定义在引入远端后补充。 -->
