# Worktree 车道

> 在一个会话里把改动放进隔离的 git worktree 车道：宿主管状态、管检查、管合并前的一切判断，合并与清理由你点头。

## 概述

多个子代理并行改同一个仓库时，最大的风险是互相踩写、把主工作区（可能带着你没提交的改动）弄乱，以及"改完了能不能合"全凭模型自觉。Worktree 车道把这条工作流做成**由宿主状态机驱动、严格由工具执行的管线**：每条车道是仓库内 `.orrery/worktrees/<lane-id>` 的一个 git worktree，挂在自己的分支 `orrery/<lane-id>` 上；车道的状态只由宿主工具改变，不合法的操作一律返回稳定的错误码；每个结果都带一个 `next` 字段告诉模型下一步，模型照做即可。

模型只提供意图（车道标题、可选的写范围、子代理任务），分支名、路径、base、依赖安装、合并前检查、合并方式全部由规则决定。合并、清理、放弃这些不可逆的决定默认只能由用户做出；信任度高的会话可切换**自动授权模式**（仿 DSH 沙箱授权机制），由宿主按用户选定的档位自动批准与收尾（见下）。

## 用户可见行为

- **开车道**：主代理调用 `worktree_open({ title, scope? })`。首次使用时宿主向 `.git/info/exclude` 追加 `/.orrery/`（带 Orrery 标记注释，不改 `.gitignore`、不影响远端）。`.orrery/` 是 Orrery 的运行时目录（车道、账本、审计日志、Edit Lock 数据、笔记），从不需要版本控制，因此整体本地忽略；车道根若配置在 `.orrery/` 之外，再追加该根目录一条，然后建分支与 worktree；仓库有 lockfile 时在后台安装依赖（车道处于 `preparing`，完成后通知主代理）。
- **派工**：`delegate({ ..., worktree: <lane> })` 把子代理绑定到车道。子代理提示词末尾自动附上车道契约（车道绝对路径、`workdir` 规则、写范围、"结束前提交"），子代理标签显示为 `<类别> · lane:<id>`。同一车道同时只允许一个写入子代理（`LANE_BUSY`）；只读精选代理可以绑定车道做调查，不改变车道状态。绑定车道的 continuable 子代理（`mode: 'continuable'` × `worktree`）以**隐式受监督组** `lane:<laneId>` 运行——终态契约、`resume_agent`/`terminate_agent`/`supervised_status` 全套可用（见 [category-delegation.md](category-delegation.md)）；`lane:` 是保留组名前缀，显式 `group` 使用即报错。
- **自动检查**：绑定车道的写入子代理到达**终态**时（前台、后台 job、受监督成员三条路径都覆盖；受监督成员的终态指 `completed`/`terminated`——`blocked` 不是终态，它是"待命"：车道保持 `working`、绑定保留，其他写入者仍被 `LANE_BUSY` 拒绝，`resume_agent` 就地续推后成员的终态报告才触发检查），宿主自动检查车道：有未提交改动 → `dirty`；HEAD 不在车道分支 → `branch-moved`；相对 base 没有新提交 → `no-commits`；都通过 → `landable`（启用验证时先跑验证）。结论以一条紧凑通知送达主代理，正文就是下一步，例如 `[worktree] lane fix-login-001 landable@3fa2c1 → next: worktree_land({"lane":"fix-login-001"})`。前台与后台委派把这条结论直接附在委派结果里。
- **可选验证**：仓库本地配置 `.orrery/worktrees/.config.json` 声明了 `check` 时，宿主在车道里按顺序执行这些命令（首个失败即停、每条有超时、日志落盘），验证命令改动了已跟踪文件也算失败；未声明 `check` 是正常状态，不提醒、不报警。
- **合并**：`worktree_land({ lane })` 依次做新鲜度校验、`git merge-tree` 无副作用冲突预检、主仓前置检查，然后在输入框位置弹出批准卡片（分支、提交列表、diffstat、预检结论、验证结果）。只有选中 **Merge into \<base\> (--no-ff)** 才合并；"Not now"、自由文本、关闭卡片、取消、无应答方一律不合并（车道变为 `declined`，自由文本作为反馈回传）。卡片打开期间主仓或车道发生变化，批准作废（`STALE_LANDABLE`）。
- **收尾**：合并成功后弹出第二张卡片，由你三选一：保留 worktree / 清理 worktree（保留分支）/ 清理 worktree 和分支。清理前先把车道里的 `.orrery/` scratch 复制到主仓 `.orrery/lanes/<lane-id>/`；删除被阻止时绝不 `--force`，原样报告原因。
- **Edit Lock 残留警示**：删除 worktree 之前（收尾或放弃），宿主对主仓管理域的 Edit Lock 权威做一次**只读**检查（有界读取 `.orrery/edit-lock/snapshot.json`，不打开运行时、不触碰预约）：该车道的属主会话仍有未决操作（prepared/publishing/unknown）或持有锁时，收尾/放弃卡片追加一段警示并给出结算路径（锁由 stale-lock 自动清扫回收；未决发布由崩溃自愈（进程死亡时）或 Edit Lock 维护面板的一键恢复结清），直接命令路径的英文结果摘要同样附上警示。警示**绝不阻断**清理、绝不修改权威；权威缺失、损坏或读取失败一律静默通过（best-effort）。
- **放弃**：`worktree_abandon({ lane })` 弹出确认卡片，同时选择清理方式；卡片写明"N 个未合并提交将永久丢失"，只有你选中"清理 worktree 和分支"才会强删分支。
- **自动授权**：`/worktree approve <manual|auto-keep|auto-clean>` 逐会话切换自动授权模式。`manual` 为现状（合并/收尾/放弃三张决策卡片照常）；`auto-keep` 自动批准合并与放弃，收尾时清理 worktree 但保留分支；`auto-clean` 自动批准合并与放弃，收尾时清理 worktree 并删除分支。自动模式下模型仍显式调用 `worktree_land`/`worktree_abandon`，只是跳过卡片——动作与审计照常留痕；worktree 一律清理，档位只决定是否保留分支。新会话的初始模式由全局设置 `worktreeAutoApprove` 决定（默认 `auto-clean`），会话命令覆盖之（投影折叠，重启回放恢复）。失效绑定的 force-reclaim 永不自动——对账未放行时一律回退手动确认卡。
- **Worktree 模式**：`/worktree on|off` 切换会话级模式。开启后主代理的写类工具一律被拒、shell 只允许只读命令（与只读子代理同一份白名单），写类委派必须带 `worktree`，否则 `WORKTREE_REQUIRED`。关闭只解除守卫，不影响已有车道。模式为可选纪律，车道能力不依赖模式开启。
- **车道看板**：每次请求组装时，运行时上下文里实时列出本仓库每条活跃车道一行 `id · state · next`，模型无需查询工具；有活跃订阅的车道追加 `· N watching` 计数。**看板 context（`orrery:worktree-board`）与 `orchestrator:worktree-lanes` 提示词段落都是仅编排者可见**：委派子代的装配上下文里两者渲染为空（子代判定见 [category-delegation.md](category-delegation.md)「子代提示词构成」）；绑定车道的子代理经其委派提示词末尾的车道契约获得所需的全部车道信息，并无损失。
- **车道订阅**：主代理调用 `worktree_watch({ lane, states })` 订阅同仓库任意车道（包括别的会话开的车道）的一组**结论态**（过渡态 `preparing`/`working`/`checking`/`awaiting-approval` 不可订阅，报 `UNWATCHABLE_STATE`）。车道进入其中任一状态时，订阅者会话收到恰好一条通知并被续推（跨会话投递给订阅者，不是车道属主）；超时未到达也收到恰好一条过期通知——订阅是一次性的，命中或超时即自动解除，同一会话对同一车道重复订阅时旧订阅被替换。建立订阅时车道已在目标状态的立即命中；订阅随账本持久化，重启后未过期的继续有效。
- **用户命令**：`/worktree` 命令族让你不经过模型直接操作（见下表），GUI 按钮也都执行这些命令；你发起的 `/worktree land` 本身就是批准，不再弹卡片。

| 命令 | 作用 |
|---|---|
| `/worktree` | 车道看板（文本）；`--json` 输出结构化视图 |
| `/worktree on` / `off` | 会话 Worktree 模式 |
| `/worktree approve <manual\|auto-keep\|auto-clean>` | 逐会话自动授权模式 |
| `/worktree init` | 输出当前仓库配置与探测到的 setup/验证命令**建议**（不写入） |
| `/worktree init write <json>` | 写入你确认后的仓库配置 |
| `/worktree setup <lane> [--skip]` | 重试或跳过失败的 setup |
| `/worktree check <lane>` | 重新检查 |
| `/worktree land <lane>` | 你亲自合并（即批准） |
| `/worktree clean <lane> keep\|worktree\|all` | 收尾 |
| `/worktree abandon <lane> [keep\|worktree\|all]` | 放弃；不带模式时弹确认卡片 |
| `/worktree reconcile [--rebuild]` | 与 git 对账；`--rebuild` 从 git 现场重建损坏的账本 |

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `worktreeEnabled` | `true` | 总开关；关闭后不注册任何车道工具、命令、提示词段落与守卫，`delegate` 的 `worktree` 参数报 `WORKTREE_DISABLED` |
| `worktreeRoot` | `.orrery/worktrees` | 仓库内存放车道的相对目录；越出仓库或指向 `.git` 报 `ROOT_OUTSIDE_REPO` |
| `worktreeMaxActive` | `4` | 每个仓库同时活跃的车道上限（`MAX_ACTIVE`） |
| `worktreeAutoSetup` | `true` | 开车道时自动安装依赖 |
| `worktreeWatchTimeoutMinutes` | `360` | 车道订阅的有效期（分钟，最小 1）；建立订阅时固化为该订阅的截止时刻，在线修改只影响之后的新订阅 |
| `worktreeAutoApprove` | `auto-clean` | 新会话的初始自动授权模式（`manual`/`auto-keep`/`auto-clean`）；会话内 `/worktree approve` 覆盖，在线修改对已切换会话无效 |

以上均为 volatile 配置，在线编辑对下一次操作生效。仓库本地配置（不入库，位于被 exclude 的车道根下）：

```json
{
  "setup": "pnpm install --frozen-lockfile",
  "check": [
    { "name": "typecheck", "run": "pnpm -r run check", "timeoutSec": 600 },
    { "name": "test", "run": "pnpm -r test", "timeoutSec": 1200 }
  ]
}
```

`setup` 与 `check` 都可选。未声明 `setup` 时按 lockfile 推导包管理器（`pnpm-lock.yaml` → pnpm、`bun.lock` → bun、`yarn.lock` → yarn、`package-lock.json` → npm）。命令只来自这个**本地、不入库**的文件，绝不从入库文件读取（避免"克隆陌生仓库即执行命令"）；`/worktree init` 探测到的建议必须经你确认才写入。

**推导命令的可执行方式**（仅针对推导；你显式配置的 `setup` 永远原样执行、绝不改写）：DSH 桌面宿主的 PATH 是最小化的（S21），裸 `pnpm` 很可能不存在，因此宿主在运行前解析调用方式——
1. **系统环境优先**：先在 PATH 与常见安装位置找该包管理器，尊重你自行安装的版本；
2. **DSH 捆绑运行时回退**：在 `<DSH_HOME>/dsh-runtimes/*/dependencies/` 中查找（pnpm 以捆绑 Node 的绝对路径执行 `pnpm.mjs`；npm 仅当捆绑 Node 目录内存在 `npm` 时；yarn/bun 无捆绑提供）；
3. **Node 注入**：执行时把解析到的 Node/bin 目录注入命令内 PATH 前缀，保证安装期生命周期脚本能找到 node；
4. **明确诊断**：两层都找不到时，车道进入 `setup-failed`，原因里直接给出三条出路（自行安装该工具 / 在仓库本地配置 `setup` / `/worktree setup <lane> --skip`），而不是只报 exit 127。

`--frozen-lockfile` 语义与 `--skip` 行为不变。

## 设计细节

- **模块划分**（`plugins/orrery-harness/src/worktree/`）：`state.js` 纯函数状态机（转移表、`nextFor`、可订阅集合 `WATCHABLE`）；`rules.js` 规则推导（id/分支/根目录校验、lockfile、验证建议、scope glob、git 输出解析）；`reconcile.js` 账本↔git 对账决策；`ledger.js` 账本 IO（`O_EXCL` 锁 + 陈旧锁抢占 + 临时文件 rename；损坏时备份并以 `LEDGER_CORRUPT` 失败关闭，绝不静默重建）；`watches.js` 订阅注册表纯逻辑（状态集合校验、替换插入、命中扫描、过期摘除、看板计数）；`git.js` 唯一调用 git 的模块（argv 形态、无 shell、从不 `--force`，`branch -D` 只在放弃流程的显式选择下）；`pkgmgr.js` 推导 setup 的可执行方式解析（系统优先、DSH 捆绑运行时回退、Node 目录注入、缺失诊断；所有命令字符串构造的唯一来源）；`runner.js` 三个执行器（git、shell、setup 解析器缝）（git 走 `ctx.subprocess` + S21 扩展解析；setup/验证走 `ctx.shell` 并携带会话 per-call 沙箱策略）；`lanes.js` 车道服务（所有变更的唯一入口）；`guard.js` 车道守卫与 Worktree 模式判定；`tools.js` / `command.js` / `projection.js` / `prompts.js` 表面适配；`index.js` 组合根。
- **状态机**：17 个状态（`preparing`、`setup-failed`、`ready`、`working`、`dirty`、`no-commits`、`branch-moved`、`checking`、`check-failed`、`landable`、`conflicted`、`awaiting-approval`、`declined`、`landed`、`kept`、`cleaned`、`abandoned`）。`landable` 记录 `HEAD^{tree}`；每次工具调用与面板刷新都会比对，车道内容一变即退回 `working`（与是否启用验证无关），保证你批准的就是实际要合并的那份内容。主仓离开 base 分支时，活跃车道叠加 `base-moved` 标记，`worktree_land` 拒绝，切回后自动解除。
- **车道守卫**：`delegate(worktree)` 在 `spawn-adapter.js` 现有只读守卫的挂载点之后追加车道守卫（`tools.guard` 只能拒绝，拒绝文本给出正确的绝对路径）：shell 必须带车道内的 `workdir`；写类工具（`write`/`edit`/`hash_edit`/`str_replace_editor`）的 `file_path` 必须在车道内、且在 `scope` 内；`lsp_rename` 对写入者一律拒绝（会改写引用文件，无法事前界定）；命令位置上的 `git checkout`/`switch`/`worktree`/`push`/`update-ref`/`symbolic-ref`、带重命名/删除标志的 `branch`、指向非 HEAD 相对引用的 `reset`、以及 `-C`/`--git-dir`/`--work-tree` 被拒。允许在车道里合并或变基 base 以解决冲突。挂载失败沿用 `onGuardFailure`：一次性子代理被拆除，受监督成员进入组回滚——绑定车道的子代理绝不会无守卫运行。
- **服务与 realm**：worktree 模块 provide 预设服务 `orreryWorktreeLanes`（`prepareBind`、`childSettled`、`modeOf`、`resolveArgPath`），按 S24 在 `delegation` 组 `isolate` 中列出，消费者 `delegate` 同组；`userQuestions`、`commands`、`connection`、`subprocess`、`shell` 等均为 host 层服务（S26 S-A）。
- **人机交互**：三类卡片都用 `ctx.userQuestions.ask` 的通用卡片 + Markdown `detail`，不声明 intent，也不挂工具调用 id（否则关闭卡片会把等待挂起）。卡片随发起它的工具调用而存在；重启或崩溃后，宿主在下一次对账时把仍处于 `awaiting-approval` 且发起进程已不在的车道转为 `declined`。
- **自动授权路径**：`approveModeOf(session)` 单点解析生效档位（投影 `approve` ?? `worktreeAutoApprove` 设置 ?? 模块默认 `auto-clean`），`land()`/`askCleanup()`/`abandon()` 三个决策点与面板 `view()` 共用。自动模式只旁路卡片、复用既有执行体：`land()` 不进 `awaiting-approval`（与 `/worktree land` 用户直批同路径），全部前置检查与冲突预检不变，合并成功后直接调既有 `cleanup()`（`auto-keep → worktree`、`auto-clean → all`）；`abandon()` 跳过确认卡按同映射执行，删未合并分支时结果摘要写明丢弃提交数；force-reclaim 对账未放行时无条件回退手动卡。审计复用 `land`/`cleanup`/`abandon` kind 加 `{ auto, approveMode }` 载荷；自动路径不经 `createAsk`，`worktree/question` 不发。
- **卡片通知**：ask 漏斗（`index.js` 的 `createAsk`）在调用 `userQuestions.ask` 之前，对白名单内的卡片 id（`merge` 合并批准、`abandon` 放弃确认）side-emit cordis 事件 `worktree/question`，载荷 `(session, { question })`——这是给系统通知特性（见 [notify.md](notify.md)）的**纯通知信号**：不写会话日志（冷读红线），监听器异常只记 `warn` 且绝不打断 ask；缺少 `userQuestions` 服务（`NO_PROVIDER`）时不 emit。白名单就是决策点：新卡片 id 默认**不**通知；`cleanup` 被刻意排除——它总是紧跟在用户刚答复的合并批准、或用户亲手输入的 `/worktree land` 之后。
- **通知**：宿主自动推进的结论经 `steer`（主代理忙）或 `followup`（空闲）送达，定时器延迟投递、有限重试，失败写审计；从不在会话事件监听器内同步续推（AGENTS.md §3.4）。
- **审计**：每次状态转移经 `src/shared/audit.js` 写 `orrery/worktree/<kind>`（`open`/`setup`/`bind`/`checked`/`check`/`invalidate`/`ask`/`decline`/`conflict`/`land`/`cleanup`/`abandon`/`reconcile`/`watch`），JSONL 锚定在**主仓根**的 `.orrery/audit.jsonl`，不写进车道；从不 `session.append`。
- **车道订阅**：订阅记录 `{ id, laneId, sessionId, states, createdAt, expiresAt }` 存于账本顶层 `watches` 数组（可选字段，旧账本读入补空，**不 bump schemaVersion**——旧版插件对同一账本读写时未知字段随深拷贝原样往返，平滑共存）。可订阅集合 `WATCHABLE = STATES \ TRANSIENT` 在 `state.js` 单源导出，工具参数校验与 spec 共用。命中判定挂在账本写回路径（`lanes.js` 的 `apply`）上：状态转移与命中订阅的摘除在**同一次原子写**内完成，写盘后统一投递，天然保证一次性——并发两个服务实例扫描同一账本时，锁后写保证只有一份摘除生效。过期采用“账本懒清理 + 每实例定时器”：建立订阅与每次刷新（`refresh`，即宿主加载路径）时为每条活跃订阅设 `expiresAt` 定时器（`unref`），触发时在账本锁内摘除，**摘除成功的一方投递过期通知**，另一方看到订阅已消失即罢手；重启加载时已过期的订阅直接摘除 + 写审计（`outcome: 'pruned'`），不投递、不触发命中。投递复用 `deliver()`（timer 延迟、steer/followup 分流、有限重试、失败审计），目标是**订阅者会话**（跨会话）；命中通知含车道 id、达成状态与 `nextFor` 建议，过期通知含车道与目标状态集合，均为英文模板。超时由 `worktreeWatchTimeoutMinutes` 统一配置，建立订阅时读一次固化为 `expiresAt`，模型无法经工具参数指定；订阅生命周期写 `orrery/worktree/watch` 审计（`subscribed`/`hit-immediate`/`expired`/`pruned`）。
- **会话投影** `orreryWorktree`：只折叠已有事件——`/worktree on|off` 与 `/worktree approve <档位>` 的 `command/run` 与配对的成功 `command/done`（失败的切换不翻转标记/档位）、`worktree_open` 成功结果的 `tool/result.meta`——冷读安全；投影形态 `{ mode, approve }`，`approve` 为会话自动授权覆盖（无覆盖为 `null`，解析时回退全局设置）。
- **面板数据**：只读端点 `POST /api/orrery-worktree/view`、`POST /api/orrery-worktree/diff`（`connection.fetch.register`，与 Edit Lock 面板同款），不进会话日志；所有变更动作走 `/worktree` 命令留痕（S26 S-B）。会话解析**冷读安全**：依次走 live agent → 已 attach 会话（无 agent 但仍是真 Session）→ `sessionQuery.observeSession` 冷观察。车道账本是仓库级数据，端点只需 `header.cwd` 与会话 id；冷路径以伪 session `{ id, header }` 驱动同一 `service.view`/`diffOf`，Worktree 模式取冷折叠的 `orreryWorktree` 投影视图，经 `view(session, { mode })` 覆盖活体投影读取；观察租约在 `finally` 中释放。GUI 查看恢复会话从不激活 agent（`page`/`follow`/`projections` 全部冷读），因此**重启后面板立即可读**，不再先回 `SESSION_NOT_LIVE` 等会话被激活；只有会话既不活也不持久（从未发言的新会话）才回 `SESSION_NOT_LIVE` 降级形态。

## 界面（Web GUI）

| 位置 | 内容 |
|---|---|
| 会话列表行 `sidebar.session.row.leading` | 分支图形标记 + 活跃车道数；有待批准车道时转为警示色。会话繁忙时该位置由状态点占用，此时由会话头胶囊补足标识 |
| 会话头 `conversation.session.header.utilities` | 状态胶囊徽标（圆点 + 状态色淡底）：「Worktree · N 条车道 · M 待批准」；基线移动或存在待批准时转为警示色并说明原因；点击打开车道面板 |
| 右侧栏页签 `orrery-worktrees` | 车道看板，自上而下：仓库信息卡（基线分支 chip、git 版本、验证状态——启用时为 ✓ + 命令数，未启用或读取失败时附「验证配置…」入口——本地忽略状态 ✓/⚠）、工具条（刷新、验证配置、历史折叠、Worktree 模式开关）、逐车道卡片、历史分组（分隔线 + 可折叠「历史（n）」，卡片略降不透明度）、未托管 worktree 脚注 |
| 车道面板工具条 | Worktree 模式开关：常驻；关闭为描边 chip，开启为实心主题色徽标，点击执行 `/worktree on|off`；车道不可用时不隐藏、置灰，悬停提示说明原因。自动授权三档切换（`manual`/`auto-keep`/`auto-clean`）与之并列：显示会话生效档位（会话覆盖或全局默认），点击执行 `/worktree approve <档位>`，车道不可用时同样置灰并说明原因 |
| 决策卡片 | 合并批准、收尾三选一、放弃确认（见上）；卡片 detail 以 GFM 列表排版——每条事实一个列表项、提交列表为两空格缩进的子列表、完整 diff 指引为斜体行（修复早期单行 `\n` 被 GFM 软换行合并为一段的排版问题） |
| 工具卡片 `tool.call.toolview` | 五个车道工具各有专属视图：头部为工具图标 + 本地化名称 + 车道链接 + 状态徽标 + 展开 chevron；正文为结构化行——状态迁移 from→to 徽标对、验证逐条 ✓/✗（失败附退出码 chip）、合并提交 mono chip + diffstat、冲突错误 callout、下一步 callout；diff 可展开。无持久化 meta 的旧调用回退为平铺输入/输出（同款卡片容器） |
| 设置页「Worktree 车道」组 | `worktree*` 六个设置键（含 `worktreeAutoApprove` 全局默认档位）；仓库本地 setup/验证配置的编辑入口在车道看板（「验证配置…」，读自 `/worktree init`，写回 `/worktree init write <json>`） |

- **车道卡片**：状态徽标 v2（圆点 + 状态色 12% 淡底、纯色描边兜底）、标题、基线移动警告徽标、相对时间；分支行（分支 → 基线、`↑n ↓n` 领先/落后 chip、`+x −y` diffstat 与文件数、车道 id 等宽缩写）；`reason` 与 `next` 分别是警示色 / 主题色的 2px 左边条 callout；验证逐条 ✓/✗ + 耗时秒数，失败附退出码 chip。操作按层级排布：主按钮至多一个（可合并时「合并…」、安装失败时「重试安装」）、次要描边按钮（重新检查、收尾选项）、危险按钮（放弃，二次点击转为实心确认）、幽灵按钮（改动、复制路径、跳过安装）；不可用操作置灰并附原因。合并与放弃保留二次点击确认。
- **订阅呈现**：`worktree_watch` 调用与其余五个车道工具一样渲染为结构化工具卡片：订阅成功时正文列出所订阅状态的徽标与绝对到期时间（悬停显示 ISO 时间戳），立即命中时只显示「已立即命中」与命中状态徽标；车道存在活跃订阅时，车道卡片头部在相对时间前显示一个弱化的「眼睛 + {n} 个订阅」标记，悬停列出本地化后的订阅状态。
- **diff 展示**：行级底色（新增 10% 成功色淡底、删除 10% 错误色淡底、hunk/文件头 interactive-bg-solid）、等宽字体、radius-md 边框容器、最高约 280px 滚动。
- **数据通道**：会话标记读 `orreryWorktree` 投影；车道详情读只读端点 `POST /api/orrery-worktree/view`（diff 读 `/api/orrery-worktree/diff`），不进会话日志；所有变更动作走 `/worktree` 命令。刷新时机：挂载、投影变化、手动刷新、以及存在过渡态车道时每 5 秒一次。
- **状态覆盖**：加载中（居中弱化）、能力关闭、不可用（callout 附原因）、空车道（居中大图标 + 标题 + 引导文案）、历史折叠、托管之外的 worktree 提示、读取失败保留上次数据并标注、配置读取失败、配置编辑内联错误（标签在上、输入框主题化）。
- **降级形态不崩溃**：端点的降级返回（`WORKTREE_DISABLED`、`SESSION_NOT_LIVE`）与完整视图同构（同样携带 `lanes`/`ownedBySession`/`unmanaged`/`repo` 字段）；端点数据在进入组件前经 `narrowView` 收窄（收窄失败按读取失败呈现），`summaryOf`/`needsPolling` 对缺失或非数组字段容错返回中性结果——任何畸形/降级负载都不会在渲染期抛错（曾因渲染期 TypeError 被壳层错误边界吞掉表现为面板空白）。
- **隔离**：每个界面注册在各自的 `ctx.effect` 中；视图代码经 `require.async` 到达（到达前渲染占位/平铺体）；右侧栏页签通过可选 `ctx.inject(["sidebarRightTabs"])` 注册，没有该包的组合其余界面照常工作。文案中英双语，仅使用主题 token（淡色底用 `color-mix` 并保留描边兜底）。

## 失效绑定回收

车道的 `boundChild` 正常由绑定工人的结算清零（宿主检查随之触发）。当属主会话死亡/失联、或宿主重启导致结算 fact 无人送达时，绑定可能残留为「僵尸」——车道卡 `working`，abandon/check/再绑定均被 `LANE_BUSY` 拒绝。三层防护：

1. **对账放行（自动，保守）**：`worktree_abandon`、`worktree_check`、再绑定三处因 `LANE_BUSY` 拒绝之前，宿主对绑定做只读活性对账（`bindingLiveness`）：终态铁证（审计尾窗内的 terminate fact、或 status 为 `completed`/`terminated` 的 settle fact，或子会话日志末尾的 `STATUS: completed` 报告）**且**属主会话与 boundChild 均无存活证据（agents 注册表查询，不命中只证明不在线、不证明死亡）时才结清绑定、放行原操作，并写审计 `worktree/reconcile-binding`（车道、被清子代理、所用证据）。**blocked 不是终态铁证**——blocked 成员随时可能被 `resume_agent` 续推，只有 blocked 证据且双方无存活证据时拒绝原样维持，逃生门是第 3 层的 force-reclaim 卡。任一方在线或缺铁证同样维持拒绝——064 教训：不在线不等于死亡，可冷恢复的 continuable 子代理绝不会被误清。审计尾窗有界（256KB），铁证滚出窗口时退化为「无铁证维持拒绝」，不会错放。
2. **重启补发（自愈）**：监督状态重建（rehydrate / 崩溃恢复把子代理提升为终态）时，对每个**已终态**成员补发结算；blocked 成员**跳过补发**——重建后的 blocked 成员保持可续推，重启不得为它制造新的（看似终态的）审计证据。`childSettled` 对无绑定车道幂等返回，天然去重。恢复提升同时补记审计 fact（此前零痕迹）。
3. **强制回收（用户兜底）**：对账未放行时，abandon 确认卡展示对账结论（哪方被判存活、缺什么证据）并提供 force-reclaim 选项；用户显式确认后才结清绑定，审计记录 `forced: true`。check/再绑定不提供强制面——放弃车道是唯一逃生门。

## 边界与失败语义

- 前置条件不满足时 `worktree_open` 不创建任何东西：`NOT_A_REPO`、`GIT_TOO_OLD`（需要 git ≥ 2.38，`merge-tree --write-tree` 的门槛；低于它整个能力不可用而不是降级跳过预检）、`DETACHED_HEAD`、`MAX_ACTIVE`、`SCOPE_OVERLAP`、`BRANCH_EXISTS`、`ROOT_OUTSIDE_REPO`、`WORKTREE_DISABLED`。
- `worktree_open` 的两类容量/范围拒绝保持原错误码与判定条件，结构化错误仍为 `{ code, message, lane?, next?, data? }`：
  - `MAX_ACTIVE`：`message` 逐条列出活跃车道的 `id · state · 建议`；`data.lanes` 为 `{ id, state, hint }[]`。`next` 为 `{ waitFor: 'user', hint }`，优先点名一条 `landable` 车道并建议 `worktree_land`；没有可合并车道时点名一条活跃车道，建议等待或 `worktree_abandon`。每条非 `landable` 车道的 `hint` 也提供等待/放弃方向。
  - `SCOPE_OVERLAP`：`lane` 为冲突车道 id，`data.overlapping` 为 `{ scope: string[], laneScope: string[] }`，分别只列新范围与已有车道范围中参与重叠的 glob（沿用保守重叠判定，不列不相关 glob）。`message` 与 `next.hint` 建议收窄新范围以避开冲突 glob，或等待该车道落地再开；`next.waitFor` 为 `user`。
- `worktree_land` 的拒绝：`NOT_LANDABLE`、`STALE_LANDABLE`、`BASE_MOVED`、`MAIN_STAGED`、`MAIN_DIRTY_OVERLAP`；冲突不弹卡片，车道转 `conflicted` 并列出冲突路径；`git merge` 意外失败时执行 `merge --abort`，主仓保持原状。
- 自动授权模式下失败语义不变：合并前置检查/冲突预检照原错误码拒绝；自动收尾删除受阻时车道停留 `landed` 并报告受阻路径，可随后手动收尾；`auto-clean` 放弃删除未合并分支时结果摘要写明丢弃的提交数；force-reclaim 永不自动批准。
- setup 被沙箱拒绝（如包管理器要写全局缓存）时车道进入 `setup-failed`，原因写明 "sandbox denied" 与 `/worktree setup <lane>` / `--skip`；不在插件里另造提权流程。无 shell 执行器的组合（win32 无 bash 行）报 `SHELL_UNAVAILABLE`。
- 对账：账本里有、git 里没有的车道转 `abandoned`（原因 `missing`）；车道根下 git 里有、账本里没有的 worktree 只报告，绝不删除。
- 账本损坏：所有操作 `LEDGER_CORRUPT`，原文件保留并另存 `lanes.json.corrupt-<ts>`；只有 `/worktree reconcile --rebuild` 会重建。
- 订阅的目标状态集合为空或含过渡态/未知态时报 `UNWATCHABLE_STATE`，不创建订阅（`data.watchable` 给出可订阅集合）；车道不存在报 `UNKNOWN_LANE`。
- **订阅命中时订阅者会话不在线**（未打开/未加载）：维持一次性语义——命中即摘除，投递失败走既有有限重试后写审计，不会重投；会话下次组装时运行时上下文看板会显示车道已达目标态，编排者不会真正丢失信息。
- `/worktree reconcile --rebuild` 从 git 现场重建账本时**订阅随之丢失**——这是你显式发起的灾难恢复路径，在此声明；普通对账（不带 `--rebuild`）保留订阅。
- **已知限制**：守卫解析的是命令文本，不是进程级隔离——子代理仍可能用非 git 手段（如 `cd` 后用相对路径、或任意程序）写到车道外的仓库内路径；沙箱保证不写出仓库。车道必须位于仓库内（沙箱约束），跨盘隔离不在范围内。Edit Lock 采用"路径即身份"，不同车道是不同文件，跨车道冲突由合并预检和 `scope` 重叠拦截覆盖。

## 测试

- 单元测试：`test/worktree-core.test.js`（状态机全转移与非法转移、规则推导、对账、账本原子写/并发/陈旧锁/损坏、账本 `watches` 字段——无 watches 旧账本读入补空、条目形态非法判损坏、exclude 幂等、git 封装从不 force、真仓库 add/precheck/merge/remove 与冲突不动主仓）；`test/worktree-watches.test.js`（订阅注册表纯逻辑：`WATCHABLE` 集合、非法/空状态集合拒绝、超时解析与 `expiresAt` 固化、替换插入、命中扫描、过期摘除、看板计数，及命中/过期英文模板文本）；`test/worktree-pkgmgr.test.js`（推导 setup 解析：系统命中与 Node 目录注入、系统有管理器但无 Node 时落到捆绑、捆绑 pnpm 经捆绑 node 执行 pnpm.mjs、npm 仅在捆绑 bin 含 npm 时、yarn/bun 无捆绑、双缺诊断、含空格路径引号、frozen-lockfile 语义，以及对本机捆绑运行时的真实执行校验）；`test/worktree-lanes.test.js`（真 git 仓库上的服务：开车道与各前置拒绝、后台 setup 成功/失败/沙箱拒绝/关闭、单写入者绑定与回滚、结算到 `dirty`/`no-commits`/`landable`、新提交使结论失效、验证顺序执行/首败即停/改写即败/`VERIFICATION_DISABLED`、批准合并与模板消息、四种不合并路径、冲突不询问、`BASE_MOVED`/`MAIN_STAGED`/`MAIN_DIRTY_OVERLAP`、卡片期间主仓变化不合并、孤儿卡片转 `declined`、用户命令合并免卡片、收尾三模式与 scratch 同步、删除受阻不强删、放弃的未合并提交提示与取消、手删车道转 missing、未托管 worktree 不动、视图与合法操作、损坏账本显式重建、验证建议只建议不写入；订阅——命中一次后不再通知、跨会话投递给订阅者、已在目标态立即命中、过渡态/空集合/未知车道拒绝、重复订阅替换、超时摘除并投递过期通知、双实例过期竞态只投递一次、重启后已过期订阅静默清理 + 审计、看板 `· N watching` 与 view `watchCount`/`watchStates`）；`test/worktree-surfaces.test.js`（车道守卫判定表含命令位置与包装命令、Worktree 模式判定、投影折叠与引用稳定、工具 schema/meta/主代理限定/错误渲染（含 `worktree_watch` 无超时字段的 schema、`meta.worktree.watch`、`UNWATCHABLE_STATE` 渲染）、命令映射、spawn-adapter 车道守卫挂载与两条通道的失败拆除、delegate 绑定/标签/契约/结算/回滚/`WORKTREE_REQUIRED`/`WORKTREE_DISABLED`、主代理模式守卫只作用于主代理自身调用）；`test/worktree-endpoints.test.js`（面板端点会话解析：冷观察路径以冷 cwd 与冷折叠 mode 驱动视图并恰好释放一次租约、live 路径不触碰 sessionQuery、会话彻底缺失回 `SESSION_NOT_LIVE`、diff 冷路径与 400 形态）；`test/worktree-ask-notify.test.js`（ask 漏斗的通知 side-emit：`merge`/`abandon` 白名单 emit 携带会话与问题、`cleanup` 与未知 id 静默、缺服务拒 `NO_PROVIDER` 且不 emit、监听器异常只告警）；`test/audit.test.js`（审计根目录锚定）；`test/settings-fields.test.js` 与 `test/client-settings-page.test.js`（五个设置键的 FIELDS ↔ patch 行 ↔ 设置页对齐）。
- 失效绑定回收：`plugins/orrery-test-harness/test/worktree-binding-reconcile.test.js`（对账四象限——铁证+双亡放行 / 属主在线拒 / 子代理在线拒 / 无铁证拒，审计事件字段、childSettled 幂等；blocked 证据规则——blocked-only 铁证 + 双亡维持拒绝、blocked→completed 放行；终态结算语义——blocked 成员车道保持 `working`/绑定保留/再绑定 `LANE_BUSY`、resume→completed 走正常 childSettled 结算并触发宿主检查、blocked 成员 terminate 放行车道、重启重建 blocked 成员零补发且可续推）与集成场景 `zombie-lane`（属主死亡 + 铁证 → abandon 放行全链路）。
- 残留警示：`test/worktree-authority.test.js`（只读探针：真实权威上的 unknown 发布 + 留存锁、prepared 操作 + 活跃锁均报残留且读后字节不变；干净/缺失/损坏权威与坏参数一律静默）；`test/worktree-cards.test.js`（警示段双语对拍：收尾/放弃 detail 有残留时追加独立警示段并点名结算路径、无残留不渲染、按存在的种类组合计数）；`test/worktree-lanes.test.js` 的 `authority-residue warning` 组（收尾卡警示与静默、放弃卡 + 摘要警示且不阻断迁移、直接 cleanup 摘要警示、探针抛错绝不阻断、无注入时默认探针读取主仓真实权威且不改动字节）。
- 自动授权：`test/worktree-lanes.test.js`（auto-clean 一键合并+清理、auto-keep 保留分支、自动模式冲突预检/删除受阻、两档自动放弃与丢弃提交计数、force-reclaim 回退弹卡、手动模式回归、审计 `auto`/`approveMode` 载荷）；`test/worktree-surfaces.test.js`（`/worktree approve` 命令映射、投影折叠 `{ mode, approve }` 含失败不翻转与重启回放）；`test/worktree-ask-notify.test.js`（自动模式不发 `worktree/question`）；`test/settings-fields.test.js` 与 `test/client-settings-page.test.js`（`worktreeAutoApprove` 三向对齐）。
- 契约指引回归：`src/worktree/contract-guidance.test.js`（受 lane 写范围约束就近放置；显式运行 `node --test plugins/orrery-harness/src/worktree/contract-guidance.test.js`）：两类开启拒绝的结构化载荷、全部活跃车道及无 `landable` 回退、拒绝不改变账本或创建 worktree、写入契约三句指引与只读契约逐字不变。
- 集成测试：见 `plugins/orrery-test-harness` 的 `worktree` 场景（端到端：开车道 → 委派 → 自动检查 → 批准合并 → 收尾，以及 Worktree 模式写入被拒）、`lane-resumable` 场景（车道绑定 continuable 子代理全链路：隐式受监督组派发 → blocked 待命期间无宿主检查（审计序证明）→ resume_agent 就地续推 → 车道内提交 → 终态结算至 `landable`）、`worktree-watch` 场景（订阅 → 车道到达目标态 → 订阅者被续推一次 → 手动再检查进入同一目标态不重复通知，账本订阅清空）与 `notify-worktree` 场景（合并批准卡片的系统通知全链路：真实 `worktree_land` → ask 漏斗 `worktree/question` 事件 → 真实挂载的 notify 模块投递到 PATH-stub 的平台命令；收尾卡片不通知）。
