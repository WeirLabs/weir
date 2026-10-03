# 系统通知（notify）

> 会话需要你处理、出错或跑完一件长任务时，弹出一条系统级通知——不必一直盯着窗口。

## 概述

助手常在后台跑很久，中途又会停下来等你：审批一次危险操作、回答一个问题、评审一份计划。人不在屏幕前，这些停顿就是白白浪费的时间。本特性监听会话状态变化，在**需要你**或**有结果**的时刻发出一条操作系统级通知（macOS 通知中心、Linux 桌面通知、Windows toast）。

它挂在 **profile 层**（与设置行 `orrery-settings` 同级），因此覆盖该 profile 下的**所有**会话，不限于 Orrery 预设。它只是观察者：不写会话日志、不续推、不影响任何回合。

## 用户可见行为

- **需要你处理**（立即通知）：
  - 工具需要审批（`approval/asked`）：「Approval needed — <会话> — wants to use <工具>」。
  - 助手提问（`ask_user_question`）：「Question for you — <会话> — <问题首句>」。
  - 计划待评审（`exit_plan_mode`）：「Plan ready for review」。
  - 一轮任务失败、被 hook 中止、被阻塞或触达输出上限：「Task failed / Task stopped」。
- **有结果**：一轮任务正常结束且耗时不少于最短时长（默认 15 秒）：「Task finished — <会话> — finished in 2m 10s」。
- **不通知**：你自己按下停止；委派出去的子代理（它们的结果经后台任务通知回到父会话，只有顶层会话报告）；低于最短时长的快速回合。
- 子代理触发的审批归到其顶层会话名下通知。
- 通知标题用会话标题，无标题时退回工作区目录名。
- 设置页新增「系统通知」组，改动即刻生效、无需重启。

## 配置

设置页「系统通知」组（`orrery-settings` 的 `notify` 段；volatile，在线编辑）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `notifyEnabled` | `true` | 总开关；关闭后任何事件都不发通知 |
| `notifyOnComplete` | `true` | 一轮任务正常结束时通知（受最短时长约束） |
| `notifyOnAttention` | `true` | 需要你处理的各类通知：审批、提问、计划评审、失败/中止 |
| `notifyMinTurnSeconds` | `15` | 只有运行至少这么久的回合才通知完成；`0` 表示每轮都通知 |
| `notifySound` | `true` | 在支持的平台播放提示音（macOS `Glass`、Linux `message-new-instant` 提示、Windows 系统默认音） |

代码级调参（模块行 `config`，不进设置页）：`settleMs`（默认 `1500`，见下）、`coalesceMs`（默认 `3000`）。非法设置值回退到默认值，不抛错。

## 设计细节

- **挂载**：`cordis.patch.yml` 的 profile 级行 `orrery-notify`（`orrery-harness/notify`），紧随 `orrery-settings`。只用 host-plane 服务（`orrerySettings`、`sessionProjections`、`sessions`），无 realm 隔离要求。`package.json` 新增 `./notify` 导出——**新增导出需要重启应用才能解析（S19）**。
- **事件来源**（均为 cordis 事件，不依赖启发式）：
  - `session/event`：`turn/start`（记录起点）、`turn/end`（按 `reason` 分类：`completed` / `error` / `blocked` / `max-tokens` / 非用户的 hook 中止；`aborted{user|parent|disposed}`、`interrupted`、`forked`、未知 kind 一律静默）、`approval/asked`、`tool/call`（工具名为 `ask_user_question` 或 `exit_plan_mode`）。
  - `agent/status`：转为 `running` 时撤销已暂存的完成通知。
  - `session/disposed`：清理该会话的定时器与计时。
- **结算窗口（settle）**：回合结束的通知先暂存 `settleMs`；窗口内 agent 重新进入 running 或新回合开始（后台任务唤醒、todo 续推、goal 轮转）就撤销——只在真正「停下来」时才打扰你。需要你处理的类型（审批/提问/计划）不等待，立即发出。
- **合并（coalesce）**：同一顶层会话、同一类型在 `coalesceMs` 内只发一条（并行工具调用同时请求审批时不刷屏）。
- **重放保护**：事件时间早于 60 秒的视为历史重放（会话恢复），不通知。
- **投递**：本机宿主是 Node 模式子进程，没有 Electron `Notification`，因此调用各平台自带命令（`src/notify/commands.js`，纯函数构造，`notifier.js` 注入 `execFile` 执行）：
  - macOS：`osascript`，标题/正文以 argv 传入脚本的 `item N of argv`，**从不拼进脚本源码**。
  - Linux：`notify-send`（libnotify），`--` 终止选项解析。
  - Windows：PowerShell WinRT toast，脚本经 `-EncodedCommand` 传入，文本走环境变量。
  - 其他平台：启动时告警一次，之后静默。
- **文本纪律**：模板文字为英文；会话标题、问题、失败信息等实例内容原样透传（跟随会话语言），清洗控制字符与换行并截断（正文至多 160 字符）。
- **模块划分**：`policy.js`（分类/去重，纯）、`messages.js`（文案，纯）、`commands.js`（平台命令，纯）、`notifier.js`（投递）、`index.js`（事件接线；`wire()` 可注入 notifier/时钟/定时器，供测试）。`policy.js`、`messages.js` 在 `jsconfig.json` 的纯模块清单内受 tsc 检查；`commands.js` 用到 `Buffer`，与 `notifier.js` 一样不入清单。

## 边界与失败语义

- **永不影响回合**：监听器内的任何异常（包括投递失败）都被捕获并只记 `warn`；通知命令 10 秒超时即放弃；暂存的定时器 `unref`，不会拖住进程退出。
- 投递失败按原因**每种只告警一次**（命令缺失 `ENOENT`、命令报错、无法启动）。Linux 无 `notify-send` 时即为「未安装，系统通知不可用」。
- **不点击跳转**：宿主侧命令式通知无法回调——点击通知不会把窗口带到前台或定位到该会话。
- **无焦点感知**：宿主不知道你是否正盯着该窗口，所以用最短时长与结算窗口压低噪声；需要处理类通知总会发出。
- **macOS 归属**：`osascript` 发出的通知在通知中心显示为「脚本编辑器」，首次可能需要在「系统设置 → 通知」中允许；专注模式/勿扰会照常拦截。
- 提问通知在 `ask_user_question` 的 `tool/call` 落盘时发出——即使该提问是限时的、之后被超时放行，通知也已发出（它在提问时刻本就该打扰你）。
- goal 轮转没有独立通知：goal 完成或受阻最终都落在回合结束，由上述 `turn/end` 路径覆盖。
- Windows 与 Linux 路径目前仅有单元测试（命令构造与注入的 `execFile`），**未在真实 Windows/Linux 桌面实机验证**；macOS 路径已在本机实际调用 `osascript` 成功退出。

## 测试

- 单元测试：`plugins/orrery-harness/test/notify.test.js`
  - `classifyTurnEnd` 全 reason 表、`isChildSession`、`attentionOfToolCall`、合并窗口。
  - 文案：清洗/截断（含 code point 边界）、时长格式、各类型模板、无标签与超长正文。
  - 平台命令：文本只走 argv/环境、不入脚本源码、`--` 终止选项、静音与紧急度。
  - 投递：超时与 env 合并、缺命令只告警一次、同步抛错不外溢、不支持平台。
  - 接线：结算窗口与撤销（`agent/status`、新回合）、最短时长、子会话/用户中止静默、审批合并与归属顶层、提问/计划即时、重放保护、设置覆盖层实时生效与非法值回退、dispose、监听器内异常不外溢。
- 设置：`test/client-settings-page.test.js` 与 `test/settings-fields.test.js` 钉住 `FIELDS` ↔ patch 行 ↔ 设置页字段集对拍。
- 集成测试：无（本特性是被动观察者，不改变注入/续推/压缩/委派/编辑行为；投递依赖真实桌面通知中心，headless 装置无法断言）。桌面冒烟（重启后触发一次审批/提问/长任务）登记为人工验收项。
