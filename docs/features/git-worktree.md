# Worktree 车道

> 在一个会话里把改动放进隔离的 git worktree 车道：宿主管状态、管检查、管合并前的一切判断，合并与清理由你点头。

## 概述

多个子代理并行改同一个仓库时，最大的风险是互相踩写、把主工作区（可能带着你没提交的改动）弄乱，以及"改完了能不能合"全凭模型自觉。Worktree 车道把这条工作流做成**由宿主状态机驱动、严格由工具执行的管线**：每条车道是仓库内 `.orrery/worktrees/<lane-id>` 的一个 git worktree，挂在自己的分支 `orrery/<lane-id>` 上；车道的状态只由宿主工具改变，不合法的操作一律返回稳定的错误码；每个结果都带一个 `next` 字段告诉模型下一步，模型照做即可。

模型只提供意图（车道标题、可选的写范围、子代理任务），分支名、路径、base、依赖安装、合并前检查、合并方式全部由规则决定。合并、清理、放弃这些不可逆的决定只能由用户做出——没有任何"自动合并"的配置项。

## 用户可见行为

- **开车道**：主代理调用 `worktree_open({ title, scope? })`。首次使用时宿主向 `.git/info/exclude` 追加 `/.orrery/`（带 Orrery 标记注释，不改 `.gitignore`、不影响远端）。`.orrery/` 是 Orrery 的运行时目录（车道、账本、审计日志、Edit Lock 数据、笔记），从不需要版本控制，因此整体本地忽略；车道根若配置在 `.orrery/` 之外，再追加该根目录一条，然后建分支与 worktree；仓库有 lockfile 时在后台安装依赖（车道处于 `preparing`，完成后通知主代理）。
- **派工**：`delegate({ ..., worktree: <lane> })` 把子代理绑定到车道。子代理提示词末尾自动附上车道契约（车道绝对路径、`workdir` 规则、写范围、"结束前提交"），子代理标签显示为 `<类别> · lane:<id>`。同一车道同时只允许一个写入子代理（`LANE_BUSY`）；只读精选代理可以绑定车道做调查，不改变车道状态。
- **自动检查**：绑定车道的写入子代理结束时（前台、后台 job、受监督成员三条路径都覆盖），宿主自动检查车道：有未提交改动 → `dirty`；HEAD 不在车道分支 → `branch-moved`；相对 base 没有新提交 → `no-commits`；都通过 → `landable`（启用验证时先跑验证）。结论以一条紧凑通知送达主代理，正文就是下一步，例如 `[worktree] lane fix-login-001 landable@3fa2c1 → next: worktree_land({"lane":"fix-login-001"})`。前台与后台委派把这条结论直接附在委派结果里。
- **可选验证**：仓库本地配置 `.orrery/worktrees/.config.json` 声明了 `check` 时，宿主在车道里按顺序执行这些命令（首个失败即停、每条有超时、日志落盘），验证命令改动了已跟踪文件也算失败；未声明 `check` 是正常状态，不提醒、不报警。
- **合并**：`worktree_land({ lane })` 依次做新鲜度校验、`git merge-tree` 无副作用冲突预检、主仓前置检查，然后在输入框位置弹出批准卡片（分支、提交列表、diffstat、预检结论、验证结果）。只有选中 **Merge into \<base\> (--no-ff)** 才合并；"Not now"、自由文本、关闭卡片、取消、无应答方一律不合并（车道变为 `declined`，自由文本作为反馈回传）。卡片打开期间主仓或车道发生变化，批准作废（`STALE_LANDABLE`）。
- **收尾**：合并成功后弹出第二张卡片，由你三选一：保留 worktree / 清理 worktree（保留分支）/ 清理 worktree 和分支。清理前先把车道里的 `.orrery/` scratch 复制到主仓 `.orrery/lanes/<lane-id>/`；删除被阻止时绝不 `--force`，原样报告原因。
- **放弃**：`worktree_abandon({ lane })` 弹出确认卡片，同时选择清理方式；卡片写明"N 个未合并提交将永久丢失"，只有你选中"清理 worktree 和分支"才会强删分支。
- **Worktree 模式**：`/worktree on|off` 切换会话级模式。开启后主代理的写类工具一律被拒、shell 只允许只读命令（与只读子代理同一份白名单），写类委派必须带 `worktree`，否则 `WORKTREE_REQUIRED`。关闭只解除守卫，不影响已有车道。
- **车道看板**：每次请求组装时，运行时上下文里实时列出本仓库每条活跃车道一行 `id · state · next`，模型无需查询工具。
- **用户命令**：`/worktree` 命令族让你不经过模型直接操作（见下表），GUI 按钮也都执行这些命令；你发起的 `/worktree land` 本身就是批准，不再弹卡片。

| 命令 | 作用 |
|---|---|
| `/worktree` | 车道看板（文本）；`--json` 输出结构化视图 |
| `/worktree on` / `off` | 会话 Worktree 模式 |
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

- **模块划分**（`plugins/orrery-harness/src/worktree/`）：`state.js` 纯函数状态机（转移表、`nextFor`）；`rules.js` 规则推导（id/分支/根目录校验、lockfile、验证建议、scope glob、git 输出解析）；`reconcile.js` 账本↔git 对账决策；`ledger.js` 账本 IO（`O_EXCL` 锁 + 陈旧锁抢占 + 临时文件 rename；损坏时备份并以 `LEDGER_CORRUPT` 失败关闭，绝不静默重建）；`git.js` 唯一调用 git 的模块（argv 形态、无 shell、从不 `--force`，`branch -D` 只在放弃流程的显式选择下）；`pkgmgr.js` 推导 setup 的可执行方式解析（系统优先、DSH 捆绑运行时回退、Node 目录注入、缺失诊断；所有命令字符串构造的唯一来源）；`runner.js` 三个执行器（git、shell、setup 解析器缝）（git 走 `ctx.subprocess` + S21 扩展解析；setup/验证走 `ctx.shell` 并携带会话 per-call 沙箱策略）；`lanes.js` 车道服务（所有变更的唯一入口）；`guard.js` 车道守卫与 Worktree 模式判定；`tools.js` / `command.js` / `projection.js` / `prompts.js` 表面适配；`index.js` 组合根。
- **状态机**：17 个状态（`preparing`、`setup-failed`、`ready`、`working`、`dirty`、`no-commits`、`branch-moved`、`checking`、`check-failed`、`landable`、`conflicted`、`awaiting-approval`、`declined`、`landed`、`kept`、`cleaned`、`abandoned`）。`landable` 记录 `HEAD^{tree}`；每次工具调用与面板刷新都会比对，车道内容一变即退回 `working`（与是否启用验证无关），保证你批准的就是实际要合并的那份内容。主仓离开 base 分支时，活跃车道叠加 `base-moved` 标记，`worktree_land` 拒绝，切回后自动解除。
- **车道守卫**：`delegate(worktree)` 在 `spawn-adapter.js` 现有只读守卫的挂载点之后追加车道守卫（`tools.guard` 只能拒绝，拒绝文本给出正确的绝对路径）：shell 必须带车道内的 `workdir`；写类工具（`write`/`edit`/`hash_edit`/`str_replace_editor`）的 `file_path` 必须在车道内、且在 `scope` 内；`lsp_rename` 对写入者一律拒绝（会改写引用文件，无法事前界定）；命令位置上的 `git checkout`/`switch`/`worktree`/`push`/`update-ref`/`symbolic-ref`、带重命名/删除标志的 `branch`、指向非 HEAD 相对引用的 `reset`、以及 `-C`/`--git-dir`/`--work-tree` 被拒。允许在车道里合并或变基 base 以解决冲突。挂载失败沿用 `onGuardFailure`：一次性子代理被拆除，受监督成员进入组回滚——绑定车道的子代理绝不会无守卫运行。
- **服务与 realm**：worktree 模块 provide 预设服务 `orreryWorktreeLanes`（`prepareBind`、`childSettled`、`modeOf`、`resolveArgPath`），按 S24 在 `delegation` 组 `isolate` 中列出，消费者 `delegate` 同组；`userQuestions`、`commands`、`connection`、`subprocess`、`shell` 等均为 host 层服务（S26 S-A）。
- **人机交互**：三类卡片都用 `ctx.userQuestions.ask` 的通用卡片 + Markdown `detail`，不声明 intent，也不挂工具调用 id（否则关闭卡片会把等待挂起）。卡片随发起它的工具调用而存在；重启或崩溃后，宿主在下一次对账时把仍处于 `awaiting-approval` 且发起进程已不在的车道转为 `declined`。
- **通知**：宿主自动推进的结论经 `steer`（主代理忙）或 `followup`（空闲）送达，定时器延迟投递、有限重试，失败写审计；从不在会话事件监听器内同步续推（AGENTS.md §3.4）。
- **审计**：每次状态转移经 `src/shared/audit.js` 写 `orrery/worktree/<kind>`（`open`/`setup`/`bind`/`checked`/`check`/`invalidate`/`ask`/`decline`/`conflict`/`land`/`cleanup`/`abandon`/`reconcile`），JSONL 锚定在**主仓根**的 `.orrery/audit.jsonl`，不写进车道；从不 `session.append`。
- **会话投影** `orreryWorktree`：只折叠已有事件——`/worktree on|off` 的 `command/run` 与配对的成功 `command/done`（失败的切换不翻转标记）、`worktree_open` 成功结果的 `tool/result.meta`——冷读安全。
- **面板数据**：只读端点 `POST /api/orrery-worktree/view`、`POST /api/orrery-worktree/diff`（`connection.fetch.register`，与 Edit Lock 面板同款），不进会话日志；所有变更动作走 `/worktree` 命令留痕（S26 S-B）。

## 界面（Web GUI）

| 位置 | 内容 |
|---|---|
| 会话列表行 `sidebar.session.row.leading` | 分支图形标记 + 活跃车道数；有待批准车道时转为警示色。会话繁忙时该位置由状态点占用，此时由会话头胶囊补足标识 |
| 会话头 `conversation.session.header.utilities` | 状态胶囊徽标（圆点 + 状态色淡底）：「Worktree · N 条车道 · M 待批准」；基线移动或存在待批准时转为警示色并说明原因；点击打开车道面板 |
| 右侧栏页签 `orrery-worktrees` | 车道看板，自上而下：仓库信息卡（基线分支 chip、git 版本、验证状态——启用时为 ✓ + 命令数，未启用或读取失败时附「验证配置…」入口——本地忽略状态 ✓/⚠）、工具条（刷新、验证配置、历史折叠、Worktree 模式徽标）、逐车道卡片、历史分组（分隔线 + 可折叠「历史（n）」，卡片略降不透明度）、未托管 worktree 脚注 |
| 输入框 `conversation.input.right` | Worktree 模式开关：开启为实心主题色徽标，关闭为描边 chip（`/worktree on|off`），不可用时置灰 |
| 决策卡片 | 合并批准、收尾三选一、放弃确认（见上）；卡片 detail 以 GFM 列表排版——每条事实一个列表项、提交列表为两空格缩进的子列表、完整 diff 指引为斜体行（修复早期单行 `\n` 被 GFM 软换行合并为一段的排版问题） |
| 工具卡片 `tool.call.toolview` | 五个车道工具各有专属视图：头部为工具图标 + 本地化名称 + 车道链接 + 状态徽标 + 展开 chevron；正文为结构化行——状态迁移 from→to 徽标对、验证逐条 ✓/✗（失败附退出码 chip）、合并提交 mono chip + diffstat、冲突错误 callout、下一步 callout；diff 可展开。无持久化 meta 的旧调用回退为平铺输入/输出（同款卡片容器） |
| 设置页「Worktree 车道」组 | `worktree*` 四个设置键；仓库本地 setup/验证配置的编辑入口在车道看板（「验证配置…」，读自 `/worktree init`，写回 `/worktree init write <json>`） |

- **车道卡片**：状态徽标 v2（圆点 + 状态色 12% 淡底、纯色描边兜底）、标题、基线移动警告徽标、相对时间；分支行（分支 → 基线、`↑n ↓n` 领先/落后 chip、`+x −y` diffstat 与文件数、车道 id 等宽缩写）；`reason` 与 `next` 分别是警示色 / 主题色的 2px 左边条 callout；验证逐条 ✓/✗ + 耗时秒数，失败附退出码 chip。操作按层级排布：主按钮至多一个（可合并时「合并…」、安装失败时「重试安装」）、次要描边按钮（重新检查、收尾选项）、危险按钮（放弃，二次点击转为实心确认）、幽灵按钮（改动、复制路径、跳过安装）；不可用操作置灰并附原因。合并与放弃保留二次点击确认。
- **diff 展示**：行级底色（新增 10% 成功色淡底、删除 10% 错误色淡底、hunk/文件头 interactive-bg-solid）、等宽字体、radius-md 边框容器、最高约 280px 滚动。
- **数据通道**：会话标记读 `orreryWorktree` 投影；车道详情读只读端点 `POST /api/orrery-worktree/view`（diff 读 `/api/orrery-worktree/diff`），不进会话日志；所有变更动作走 `/worktree` 命令。刷新时机：挂载、投影变化、手动刷新、以及存在过渡态车道时每 5 秒一次。
- **状态覆盖**：加载中（居中弱化）、能力关闭、不可用（callout 附原因）、空车道（居中大图标 + 标题 + 引导文案）、历史折叠、托管之外的 worktree 提示、读取失败保留上次数据并标注、配置读取失败、配置编辑内联错误（标签在上、输入框主题化）。
- **隔离**：每个界面注册在各自的 `ctx.effect` 中；视图代码经 `require.async` 到达（到达前渲染占位/平铺体）；右侧栏页签通过可选 `ctx.inject(["sidebarRightTabs"])` 注册，没有该包的组合其余界面照常工作。文案中英双语，仅使用主题 token（淡色底用 `color-mix` 并保留描边兜底）。

## 边界与失败语义

- 前置条件不满足时 `worktree_open` 不创建任何东西：`NOT_A_REPO`、`GIT_TOO_OLD`（需要 git ≥ 2.38，`merge-tree --write-tree` 的门槛；低于它整个能力不可用而不是降级跳过预检）、`DETACHED_HEAD`、`MAX_ACTIVE`、`SCOPE_OVERLAP`、`BRANCH_EXISTS`、`ROOT_OUTSIDE_REPO`、`WORKTREE_DISABLED`。
- `worktree_open` 的两类容量/范围拒绝保持原错误码与判定条件，结构化错误仍为 `{ code, message, lane?, next?, data? }`：
  - `MAX_ACTIVE`：`message` 逐条列出活跃车道的 `id · state · 建议`；`data.lanes` 为 `{ id, state, hint }[]`。`next` 为 `{ waitFor: 'user', hint }`，优先点名一条 `landable` 车道并建议 `worktree_land`；没有可合并车道时点名一条活跃车道，建议等待或 `worktree_abandon`。每条非 `landable` 车道的 `hint` 也提供等待/放弃方向。
  - `SCOPE_OVERLAP`：`lane` 为冲突车道 id，`data.overlapping` 为 `{ scope: string[], laneScope: string[] }`，分别只列新范围与已有车道范围中参与重叠的 glob（沿用保守重叠判定，不列不相关 glob）。`message` 与 `next.hint` 建议收窄新范围以避开冲突 glob，或等待该车道落地再开；`next.waitFor` 为 `user`。
- `worktree_land` 的拒绝：`NOT_LANDABLE`、`STALE_LANDABLE`、`BASE_MOVED`、`MAIN_STAGED`、`MAIN_DIRTY_OVERLAP`；冲突不弹卡片，车道转 `conflicted` 并列出冲突路径；`git merge` 意外失败时执行 `merge --abort`，主仓保持原状。
- setup 被沙箱拒绝（如包管理器要写全局缓存）时车道进入 `setup-failed`，原因写明 "sandbox denied" 与 `/worktree setup <lane>` / `--skip`；不在插件里另造提权流程。无 shell 执行器的组合（win32 无 bash 行）报 `SHELL_UNAVAILABLE`。
- 对账：账本里有、git 里没有的车道转 `abandoned`（原因 `missing`）；车道根下 git 里有、账本里没有的 worktree 只报告，绝不删除。
- 账本损坏：所有操作 `LEDGER_CORRUPT`，原文件保留并另存 `lanes.json.corrupt-<ts>`；只有 `/worktree reconcile --rebuild` 会重建。
- **已知限制**：守卫解析的是命令文本，不是进程级隔离——子代理仍可能用非 git 手段（如 `cd` 后用相对路径、或任意程序）写到车道外的仓库内路径；沙箱保证不写出仓库。车道必须位于仓库内（沙箱约束），跨盘隔离不在范围内。Edit Lock 采用"路径即身份"，不同车道是不同文件，跨车道冲突由合并预检和 `scope` 重叠拦截覆盖。

## 测试

- 单元测试：`test/worktree-core.test.js`（状态机全转移与非法转移、规则推导、对账、账本原子写/并发/陈旧锁/损坏、exclude 幂等、git 封装从不 force、真仓库 add/precheck/merge/remove 与冲突不动主仓）；`test/worktree-pkgmgr.test.js`（推导 setup 解析：系统命中与 Node 目录注入、系统有管理器但无 Node 时落到捆绑、捆绑 pnpm 经捆绑 node 执行 pnpm.mjs、npm 仅在捆绑 bin 含 npm 时、yarn/bun 无捆绑、双缺诊断、含空格路径引号、frozen-lockfile 语义，以及对本机捆绑运行时的真实执行校验）；`test/worktree-lanes.test.js`（真 git 仓库上的服务：开车道与各前置拒绝、后台 setup 成功/失败/沙箱拒绝/关闭、单写入者绑定与回滚、结算到 `dirty`/`no-commits`/`landable`、新提交使结论失效、验证顺序执行/首败即停/改写即败/`VERIFICATION_DISABLED`、批准合并与模板消息、四种不合并路径、冲突不询问、`BASE_MOVED`/`MAIN_STAGED`/`MAIN_DIRTY_OVERLAP`、卡片期间主仓变化不合并、孤儿卡片转 `declined`、用户命令合并免卡片、收尾三模式与 scratch 同步、删除受阻不强删、放弃的未合并提交提示与取消、手删车道转 missing、未托管 worktree 不动、视图与合法操作、损坏账本显式重建、验证建议只建议不写入）；`test/worktree-surfaces.test.js`（车道守卫判定表含命令位置与包装命令、Worktree 模式判定、投影折叠与引用稳定、工具 schema/meta/主代理限定/错误渲染、命令映射、spawn-adapter 车道守卫挂载与两条通道的失败拆除、delegate 绑定/标签/契约/结算/回滚/`WORKTREE_REQUIRED`/`WORKTREE_DISABLED`、主代理模式守卫只作用于主代理自身调用）；`test/audit.test.js`（审计根目录锚定）；`test/settings-fields.test.js` 与 `test/client-settings-page.test.js`（四个设置键的 FIELDS ↔ patch 行 ↔ 设置页对齐）。
- 契约指引回归：`src/worktree/contract-guidance.test.js`（受 lane 写范围约束就近放置；显式运行 `node --test plugins/orrery-harness/src/worktree/contract-guidance.test.js`）：两类开启拒绝的结构化载荷、全部活跃车道及无 `landable` 回退、拒绝不改变账本或创建 worktree、写入契约三句指引与只读契约逐字不变。
- 集成测试：见 `plugins/orrery-test-harness` 的 `worktree` 场景（端到端：开车道 → 委派 → 自动检查 → 批准合并 → 收尾，以及 Worktree 模式写入被拒）。
