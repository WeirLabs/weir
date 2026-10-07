# 系统通知（notify）

> 会话需要你处理、出错或跑完一件长任务时，以 DeepSeek Harness 自己的名义弹出一条系统通知——不必一直盯着窗口。

## 概述

助手常在后台跑很久，中途又会停下来等你：审批一次危险操作、回答一个问题、评审一份计划。人不在屏幕前，这些停顿就是白白浪费的时间。本特性监听会话状态变化，在**需要你**或**有结果**的时刻发出一条系统通知。通知由 DSH 页面以网页通知弹出，所以来源是 **DeepSeek Harness**（带它的图标，授权在「系统设置 → 通知 → DeepSeek Harness」）；页面不可用时才退回宿主调用各平台自带命令（macOS 通知中心、Linux 桌面通知、Windows toast）。

它挂在 **profile 层**（与设置行 `weir-settings` 同级），因此覆盖该 profile 下的**所有**会话，不限于 Weir 预设。它只是观察者：不写会话日志、不续推、不影响任何回合。

## 用户可见行为

- **需要你处理**（立即通知）：
  - 工具需要审批（`approval/asked`）：「Approval needed — <会话> — wants to use <工具>」。
  - 助手提问（`ask_user_question`）：「Question for you — <会话> — <问题首句>」。
  - Worktree 车道的合并批准与放弃确认卡片（`worktree/question` 事件）：「Question for you — <会话> — <卡片问题>」。收尾三选一卡片**不通知**——它总是紧跟在你刚答复的合并批准、或你亲手输入的 `/worktree land` 之后。
  - 计划待评审（`exit_plan_mode`）：「Plan ready for review」。
  - 一轮任务失败、被 hook 中止、被阻塞或触达输出上限：「Task failed / Task stopped」。
- **有结果**：一轮任务正常结束且耗时不少于最短时长（默认 15 秒）：「Task finished — <会话> — finished in 2m 10s」。
- **不通知**：你自己按下停止；委派出去的子代理（它们的结果经后台任务通知回到父会话，只有顶层会话报告）；低于最短时长的快速回合。
- 子代理触发的审批归到其顶层会话名下通知。
- 通知标题用会话标题，无标题时退回工作区目录名。
- 设置页新增「系统通知」组，改动即刻生效、无需重启。
- **窗口在前台时默认不通知**：你正看着 DSH 窗口时不打扰；设置项「窗口在前台时」可改成「始终通知」。窗口在后台、被遮挡或失去焦点时正常通知。
- **连续通知不再互相吞掉**：同一会话的同类通知合并为一条并重新提醒；不同会话、不同类型互不覆盖（见下文「投递路由」的 tag 策略表）。
- **macOS 通知权限面板**：设置页「系统通知」组末尾在宿主为 macOS 时多出「通知权限」条目（其他平台不显示），点「管理」弹出面板，检测并引导 **DeepSeek Harness 自己**的通知权限，详见下文「权限面板」。

## 配置

设置页「系统通知」组（`weir-settings` 的 `notify` 段；volatile，在线编辑）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `notifyEnabled` | `true` | 总开关；关闭后任何事件都不发通知 |
| `notifyOnComplete` | `true` | 一轮任务正常结束时通知（受最短时长约束） |
| `notifyOnAttention` | `true` | 需要你处理的各类通知：审批、提问、计划评审、失败/中止 |
| `notifyMinTurnSeconds` | `15` | 只有运行至少这么久的回合才通知完成；`0` 表示每轮都通知 |
| `notifySound` | `true` | 在支持的平台播放提示音（macOS `Glass`、Linux `message-new-instant` 提示、Windows 系统默认音） |
| `notifyForeground` | `skip` | DSH 窗口在前台（可见且有焦点）时是否通知：`skip` 不通知（默认）、`always` 始终通知。即时生效 |

代码级调参（模块行 `config`，不进设置页）：`settleMs`（默认 `1500`，见下）、`coalesceMs`（默认 `3000`）。非法设置值回退到默认值，不抛错。

## 设计细节

- **挂载**：`cordis.patch.yml` 的 profile 级行 `weir-notify`（`weir-harness/notify`），紧随 `weir-settings`。只用 host-plane 服务（`weirSettings`、`sessionProjections`、`sessions`），无 realm 隔离要求。`package.json` 新增 `./notify` 导出——**新增导出需要重启应用才能解析（S19）**。
- **事件来源**（均为 cordis 事件，不依赖启发式）：
  - `session/event`：`turn/start`（记录起点）、`turn/end`（按 `reason` 分类：`completed` / `error` / `blocked` / `max-tokens` / 非用户的 hook 中止；`aborted{user|parent|disposed}`、`interrupted`、`forked`、未知 kind 一律静默）、`approval/asked`、`tool/call`（工具名为 `ask_user_question` 或 `exit_plan_mode`）。
  - `agent/status`：转为 `running` 时撤销已暂存的完成通知。
  - `session/disposed`：清理该会话的定时器与计时。
  - `worktree/question`：Worktree 车道的决策卡片不经过工具层（车道服务直接调用 `userQuestions` 服务，见 [git-worktree.md](git-worktree.md)），不会产生白名单内的 `tool/call` 事件；worktree 模块在弹出**合并批准**与**放弃确认**卡片前 side-emit 此 cordis 事件（载荷为会话与卡片问题文本），本模块按 question 类型投递。卡片 id 白名单在 worktree 侧（新 id 默认不通知）；本监听器与 `session/event` 监听器同一纪律：整体 try/catch，异常只记 `warn`。
- **结算窗口（settle）**：回合结束的通知先暂存 `settleMs`；窗口内 agent 重新进入 running 或新回合开始（后台任务唤醒、todo 续推）就撤销——只在真正「停下来」时才打扰你。需要你处理的类型（审批/提问/计划）不等待，立即发出。
- **合并（coalesce）**：同一顶层会话、同一类型在 `coalesceMs` 内只发一条（并行工具调用同时请求审批时不刷屏）。
- **重放保护**：事件时间早于 60 秒的视为历史重放（会话恢复），不通知。
- **投递**：判定在宿主、弹出在页面（见下文「投递路由」）。宿主是 Node 模式子进程，没有 Electron `Notification`，所以**兜底路径**调用各平台自带命令（`src/notify/commands.js`，纯函数构造，`notifier.js` 注入 `execFile` 执行）：
  - macOS：`osascript`，标题/正文以 argv 传入脚本的 `item N of argv`，**从不拼进脚本源码**。
  - Linux：`notify-send`（libnotify），`--` 终止选项解析。
  - Windows：PowerShell WinRT toast，脚本经 `-EncodedCommand` 传入，文本走环境变量。
  - 其他平台：启动时告警一次，之后静默。
- **文本纪律**：模板文字为英文；会话标题、问题、失败信息等实例内容原样透传（跟随会话语言），清洗控制字符与换行并截断（正文至多 160 字符）。
- **模块划分**：`policy.js`（分类/去重，纯）、`messages.js`（文案，纯）、`commands.js`（平台命令，纯）、`notifier.js`（投递）、`index.js`（事件接线；`wire()` 可注入 notifier/时钟/定时器，供测试）。`policy.js`、`messages.js` 在 `jsconfig.json` 的纯模块清单内受 tsc 检查；`commands.js` 用到 `Buffer`，与 `notifier.js` 一样不入清单。

## 投递路由

宿主**判定**该发什么（分类、结算窗口、合并、重放保护都在 `src/notify/index.js` / `policy.js`），页面负责**弹出**，系统命令是兜底。

```
会话事件 → 宿主判定 → web-channel（队列）
                       ├─ 有页面在拉取 → 页面取走 → 弹出网页通知 → ack
                       │                     ├─ shown / pending / suppressed → 结束（不兜底）
                       │                     └─ blocked / error / threw / unsupported / 4 秒无 ack → 系统命令兜底
                       └─ 没有页面在拉取 → 系统命令兜底
```

- **宿主→页面用长轮询**：页面启动后循环 `POST /api/weir-notify/web/pull`，宿主有待发通知就立即返回，否则挂起 20 秒后返回空；页面弹出后 `POST /api/weir-notify/web/ack` 回报结果。选长轮询是因为 `connection.fetch.register` 的响应是缓冲的、流式未经验证，长轮询只用已验证的请求/响应形态。页面端点由 `weir-notify` 行注册，**不新增包子路径**。
- **一条通知只交给一个拉取者**（多标签/多窗口不会重复弹），取走即出队；页面请求被中止时，挂起的拉取被释放。
- **最多弹一次、不丢**：`shown` / `pending` / `suppressed` 是终态，不再兜底；`pending`（发出了但浏览器 2.5 秒内未确认）**不兜底**——宁可极少漏一次也不重复。没有页面在拉取（最近 30 秒无轮询）、页面没权限、浏览器报错、或取走后 4 秒无 ack，都走系统命令兜底。
- **前台抑制由页面判定**：页面弹出前检查 `document.visibilityState === 'visible' && document.hasFocus()`。前台且 `notifyForeground=skip` 时回报 `suppressed`（视为已处理，**不兜底**，否则抑制会被系统通知绕过）；设置值随每条待发通知下发，改设置即时生效。宿主兜底路径（页面不可用）因窗口显然不在前台，不受该开关影响。
- **先关后开**：同 `tag` 的新通知到来时，页面先 `close()` 旧的再新建，保证每次都是一次全新弹出（部分系统对同 tag 替换即使带 `renotify` 也可能不再提醒）。

### tag 策略表

实测发现：网页通知里**相同 `tag` 的新通知会替换仍在显示的旧通知，且默认不重新提醒**，连续发送时后面的会「没生效」。因此 `tag` 由宿主按固定策略生成（`src/notify/tags.js`，纯函数）：

| 场景 | `tag` | `renotify` | 理由 |
|---|---|---|---|
| 同一顶层会话、同一类型反复出现（并行审批、连续提问） | `weir:<顶层会话id>:<类型>` | `true` | 合并为一条，但每次新事件仍重新提醒，不会被吞 |
| 不同顶层会话 | 因会话 id 不同而不同 | — | 互不覆盖，不会漏看别的会话的审批 |
| 同会话不同类型（审批 / 完成 / 失败） | 因类型不同而不同 | — | 互不覆盖 |
| 需要完全不合并 | 不设 `tag` | — | 每条独立堆叠（本版不使用，保留给后续） |

委派子代理的通知按其**顶层会话**取 `tag`，与父会话合并。宿主既有的 `coalesceMs`（3 秒）合并窗口**保留作为节流**：窗口内丢弃重复，窗口外靠 `tag` 替换并重新提醒，两层语义一致。

## 权限面板（仅 macOS）

通知以 **DeepSeek Harness** 自己的名义弹出（`com.deepseek.dsh`），所以需要在 macOS 里允许 DeepSeek Harness 发送通知；面板用来检测并引导。

> 历史：最初的实现经 `osascript` 发出，macOS 把它算到「脚本编辑器」，而它在系统通知偏好里只有一条没有授权值的记录、**不会出现在「系统设置 → 通知」的应用列表里**，无从授权，通知很可能被静默丢弃。改为页面网页通知后，来源与授权都落在 DSH 自己身上；`osascript` 只作兜底，不再需要用户管理它。

- **显示条件**：以**宿主**平台为准（不看浏览器所在平台）。设置页挂载时向宿主探测一次，宿主为 macOS 才渲染入口；探测失败或非 macOS 一律不显示。
- **检测**：宿主经 `osascript -l JavaScript` 的 `CFPreferencesCopyAppValue` 只读读取 `com.apple.ncprefs`，取 `com.deepseek.dsh` 的 `auth`/`flags`（约 0.1 秒，无需额外权限）。三态判定：`auth` 含弹出提醒位（4）→ **已允许**；`auth` 明确为 0 或不含该位 → **未允许**；没有该发送方记录、`auth` 缺失（沿用系统默认）、读取失败 → **无法判定**，并给出具体原因。不依据 `flags` 样式位提升为已允许——实测它与 `auth` 不同步。该偏好格式未公开，面板明示「仅供参考」。同时显示页面自己的 `Notification.permission`（已允许 / 已禁止 / 尚未询问）；已禁止时说明页面无法再次询问，引导去系统设置手动开启。
- **引导流程**：一次只突出一个主动作。未允许/无法判定时：「发送测试通知」（在这次点击里先请求页面权限——浏览器只在用户手势里弹授权提示——再经**真实投递路径**发出，所见即所得；首次可触发授权）→「打开系统通知设置」（打开 `x-apple.systempreferences:com.apple.Notifications-Settings.extension`，提示在列表中找到「DeepSeek Harness」、打开「允许通知」并选「横幅」或「提醒」）→ 等待。打开设置后每 2 秒自动重新检测，最长 3 分钟；检测到已允许即停止轮询并请你再发一条测试通知，最后由你确认「看到了/没看到」。选「没看到」会提示检查专注模式/勿扰、提醒样式、以及窗口在前台时的设置，并可重来。系统设置里的开关始终由你亲手打开，**不会尝试代点**。测试通知用 `foreground: 'always'`，因为你此刻正看着设置页。
- **端点**：`POST /api/weir-notify/permissions/status`（任意平台可调，返回 `supported`）与 `POST /api/weir-notify/permissions/action`（仅 macOS；白名单 `test` / `open-settings`，无参数，未知动作与非 macOS 一律拒绝且不执行命令）。`test` 走 `sendTest`（即真实通道），不自带命令；`open-settings` 用绝对路径 `/usr/bin/open`，读取用 `/usr/bin/osascript`（GUI 进程 PATH 最小化，S21）。端点由 `weir-notify` 行经 `ctx.inject(['connection'])` 接线（S19/S20），不新增包子路径，所以**无需重启**，重新应用 bundle 即可。
- **模块**：宿主 `src/notify/permissions.js`（判定、读取、动作）与 `permissions-admin.js`（端点接线）；浏览器 `lib/client.notify-permissions.js`（面板，带错误边界）与 `lib/client.notify-web.js`（投递引擎）。面板用官方 `Modal` 与 `Button`，Escape、遮罩点击与焦点还原由其内建。投递引擎由入口 `apply` 启动、**不依赖设置页是否打开**。
- **探针的结论已并入主流程**：早先面板里有个独立的「以 DeepSeek Harness 名义发送（测试）」实验区块，用来验证网页通知能否以 DSH 名义弹出；实测通过后已删除，其发送能力成为真实投递路径，面板的「发送测试通知」直接走它。

## 边界与失败语义

- **永不影响回合**：监听器内的任何异常（包括投递失败）都被捕获并只记 `warn`；通知命令 10 秒超时即放弃；暂存的定时器 `unref`，不会拖住进程退出。
- 投递失败按原因**每种只告警一次**（命令缺失 `ENOENT`、命令报错、无法启动）。Linux 无 `notify-send` 时即为「未安装，系统通知不可用」。
- **不点击跳转**：网页通知的点击回调理论上可行，但本版未做——点击通知不会把窗口带到前台或定位到该会话。
- **窗口关闭后收不到网页通知**：网页通知只在 DSH 窗口运行时有效。没有页面在拉取时自动走系统命令兜底；但兜底在 macOS 上仍归属「脚本编辑器」，**可能因无授权被系统丢弃**，且不受「窗口在前台时」开关影响。这是已知取舍。
- **专注模式/勿扰会照常拦截**，且无法检测。窗口在前台时系统通常不弹横幅，所以默认前台不通知并不会损失什么；需要前台也提醒就切到「始终通知」。
- 提问通知在 `ask_user_question` 的 `tool/call` 落盘时发出——即使该提问是限时的、之后被超时放行，通知也已发出（它在提问时刻本就该打扰你）。
- Worktree 卡片通知在卡片弹出前现场发出——即使卡片之后被取消、超时被关闭或用户不作答，通知也已发出（它在提问时刻本就该打扰你）。该事件是纯 cordis 信号、不经 `session/event` 源，因此不受 60 秒重放保护约束，也永远不会在会话恢复时被重放。
- DSH 的 goal 特性已从 Weir 预设排除（见 [preset-packaging.md](preset-packaging.md)），不存在 goal 轮转唤醒源；所有完成/受阻通知只走上述 `turn/end` 路径。
- Windows 与 Linux 路径目前仅有单元测试（命令构造与注入的 `execFile`），**未在真实 Windows/Linux 桌面实机验证**；macOS 路径已在本机实际调用 `osascript` 成功退出。
- 权限面板的边界：专注模式/勿扰数据在受保护目录（`~/Library/DoNotDisturb/DB/` 读取被系统拒绝），无法检测，面板只做提示；端点或命令失败时面板显示错误并给出手动路径（系统设置 → 通知 → DeepSeek Harness），不影响设置页其余内容与通知本身；面板渲染异常被错误边界限制在面板内。
- 页面通道失败的边界：长轮询请求失败时页面按 1/2/5/10/20 秒退避重试、不会热循环；ack 失败不会卡住轮询（宿主 4 秒后兜底）；通道的任何故障只记警告、不影响会话回合、日志或续推，宿主不向会话日志追加事件。
- **实机状态**：「以 DSH 名义弹出」已由探针在真实 DSH 里实测通过（弹出且来源为 DeepSeek Harness；系统偏好里 `com.deepseek.dsh` 的 `auth=7`）。**投递通道（长轮询、前台抑制、tag 先关后开）与权限面板的新版视觉呈现尚未在真实页面上验证**——本会话没有浏览器控制，仅有单测。

## 测试

- 单元测试：`plugins/weir-harness/test/notify.test.js`
  - `classifyTurnEnd` 全 reason 表、`isChildSession`、`attentionOfToolCall`、合并窗口。
  - 文案：清洗/截断（含 code point 边界）、时长格式、各类型模板、无标签与超长正文。
  - 平台命令：文本只走 argv/环境、不入脚本源码、`--` 终止选项、静音与紧急度。
  - 投递：超时与 env 合并、缺命令只告警一次、同步抛错不外溢、不支持平台。
  - 接线：结算窗口与撤销（`agent/status`、新回合）、最短时长、子会话/用户中止静默、审批合并与归属顶层、提问/计划即时、`worktree/question` 即时投递与裁剪、无效载荷降级、`onAttention` 关闭即静默、重放保护、设置覆盖层实时生效与非法值回退、dispose（四个监听器全部注销）、监听器内异常不外溢。
- Worktree 侧：`test/worktree-ask-notify.test.js`（ask 漏斗的 side-emit：`merge`/`abandon` 白名单 emit 携带会话与问题、`cleanup` 与未知 id 及空问题列表静默、缺 `userQuestions` 服务拒 `NO_PROVIDER` 且不 emit、emit 抛错只告警不打断 ask）。
- 设置：`test/client-settings-page.test.js` 与 `test/settings-fields.test.js` 钉住 `FIELDS` ↔ patch 行 ↔ 设置页字段集对拍。
- 权限面板：`test/notify-permissions.test.js`（判定矩阵、探测输出解析、固定白名单命令、端点形状/拒绝/幂等 disposer、非 macOS 不执行命令）；`test/client-notify-permissions.test.js`（非 macOS 与探测失败不渲染、打开即检测、三态下的单一主动作、动作负载、轮询间隔/授权后停止/关闭停止/3 分钟上限、错误态含手动路径、错误边界、两份字典与 chunk 源码的键对拍）；`test/client.test.js`、`test/client-settings-page.test.js` 同步 chunk 清单与行数。
- 投递路由：`test/notify-web-channel.test.js`（同文件含 `tagFor` 用例：同会话同类型相同、不同会话/类型不同、特殊字符安全；通道用例：无页面直接兜底、多拉取者互斥、终态与兜底结果矩阵、确认超时、迟到 ack、取走后断开、dispose）、`test/notify.test.js` 的路由用例（经通道发出带 tag/renotify/foreground、子会话归属顶层、前台设置即时生效与非法值回退）、`test/client-notify-web.test.js`（前台抑制与始终通知、tag 先关后开、权限请求、六种结果码、退避与上限、ack 失败不卡轮询、stop 关闭并中止）、`test/client.test.js`（入口 apply 启动与 dispose 停止、chunk 加载失败无害）。
- 集成测试：`plugins/weir-test-harness` 的 `notify-worktree` 场景（真实 `worktree_land` 在真实 landable 车道上弹出合并批准卡片（`user-questions` 存根自动批准）→ ask 漏斗 side-emit `worktree/question` → 真实挂载的 notify 模块沿投递路径落到平台命令——PATH 上的 stub `osascript`/`notify-send` 落盘供断言；收尾卡片不 emit；win32 的 `powershell.exe` 无法被 PATH-stub，仅断言 emit 缝）。桌面冒烟（重启后触发一次审批/提问/长任务）登记为人工验收项。
