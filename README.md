![Weir — Orchestrator preset for DeepSeek Harness](docs/assets/readme-hero.svg)

<p>
  <img src="https://img.shields.io/badge/版本-2.0.0-0a0a0b?labelColor=1c1d20&color=ccff00" alt="版本">
  <img src="https://img.shields.io/badge/许可-MIT-0a0a0b?labelColor=1c1d20&color=ccff00" alt="许可 MIT">
  <img src="https://img.shields.io/badge/宿主-DeepSeek%20Harness-0a0a0b?labelColor=1c1d20&color=ecece6" alt="宿主">
</p>

**Weir 是 DeepSeek Harness 的 agent 预设：把助手变成总指挥，拆任务、派子代理、盯进度，直到活干完。**

## 为什么用 Weir

| 常见痛点 | Weir 的做法 |
|---|---|
| 做到一半停下，等你催 | 清单没完成就自动续推；你一喊停，立刻停 |
| 什么活都用同一个模型硬扛 | 按任务类别分配模型，主模型不可用时按备选链降级 |
| 上下文一满就丢三落四 | 提前提醒保存关键进展，在安全时机请求整理历史 |
| 改文件改歪、多处互相覆盖 | 锚点校验编辑、独立 worktree 车道、可选编辑锁 |
| 子代理重复踩同一个坑 | 会话黑板沉淀已验证的发现，不挖第二遍 |

## 工作方式

```mermaid
flowchart LR
    U([你的需求]) --> O{{Orchestrator<br/>总指挥}}
    O -->|简单任务| D[直接完成]
    O -->|复杂任务| S[拆解并并行派发]
    S --> A1[快速问答]
    S --> A2[深度分析]
    S --> A3[架构咨询]
    S --> A4[只读研究]
    A1 & A2 & A3 & A4 --> V{验收}
    V -->|未达标| S
    V -->|通过| R([交付结果])
    D --> R
```

## 亮点

### 指挥调度
- **总指挥统筹**：简单的活直接干，复杂的活拆给子代理，能并行就并行，每个子任务都有交付标准和验收。
- **模型各司其职**：九种任务类别加三个只读研究代理，各自绑定模型链，「Weir 模型路由」设置页可视化配置、可单独停用。
- **后台委派**：耗时任务后台运行，完成只推一条简短通知；支持任务分组、续聊式子任务，重启不丢。
- **会话黑板**：子代理的发现写入共享黑板，同一会话重启或重装后仍保留，经你裁决后可晋升为跨会话文档。→ [会话黑板](docs/features/blackboard.md)

**兼容性变更**：Weir 与创造模式统一用 `delegate` 派任务，不再提供 `subagent`、`subagent_fork`、`list_subagent_models`、`workflow`。批量/分组委派不是 JavaScript workflow 脚本编排的等价替代；续聊追问和子代理控制仍保留。→ [分类委派](docs/features/category-delegation.md)

### 工程执行
- **锚点编辑**：读取自带锚点，逐锚校验，任何一处对不上就整体拒绝；编辑以逐行着色 diff 呈现，更准也更省 token。
- **语义级代码理解**：接入 LSP 后，跳转定义、查找引用、跨文件重命名都由语言服务器给出真实答案；可一键安装缺失的语言服务器（13 种语言）。
- **Worktree 车道**：隔离的改动在独立分支与目录中进行，合并前由你确认。
- **编辑锁（稳定、默认开启）**：更新并重启后，未显式设置过开关的项目会话按文件防止互踩，可请求转交；被拒的会话还能等这个文件的下一次释放——通知只表示「现在可以去抢」，不代表已经拿到锁，几个会话同时等就一起抢、先到先得。明确关闭并重启后，普通编辑不受锁保护，可能覆盖他人工作。shell 与外部编辑器不在保护范围。→ [编辑锁](docs/features/edit-lock.md)

### 持续在线
- **不催不停**：异常自动退避重试，连续失败如实报告。
- **整理记忆有结果可查**：排队不等于完成；压缩成功后从摘要继续，忙碌或被其他消息抢先时安全暂停，等你发消息后再决定重试，不承诺信息无损。→ [上下文压力守卫](docs/features/context-pressure-guard.md)
- **听懂意图**：说「深度工作」「仔细研究一下」即进入对应模式；开启语义分类后无需关键词。
- **离开屏幕也不误事**：需要审批、提问或长任务完成时发系统通知（正在看窗口时不打扰；对整个 profile 生效，可在设置页关闭）。

## 内置技能

意图命中时自动加载，也可手动调用。

| 技能 | 作用 |
|---|---|
| `deep-work` | 证据驱动的端到端完成，不以「看起来对了」为完成 |
| `research` | 并行检索代码、文档与网络，产出带引用的综述 |
| `review-work` | 完工把关：实际验证，再审目标覆盖、代码质量与安全 |
| `debugging` | 先复现、排序假设、用最低成本实验定位根因 |
| `git-master` | 原子提交、rebase、squash、bisect、历史考古 |
| `refactor` | 重构、清理与重组 |
| `programming` | Python / Rust / TypeScript / Go 的现代写法规范 |
| `remove-ai-slops` | 在回归测试保护下清除 AI 代码异味 |
| `work-with-pr` | PR 全流程：独立 worktree、证据化验证、可读的 PR 描述 |
| `remove-deadcode` | 验证后原子提交式删除死代码 |

Weir 会话只显示**已启用**的技能与 MCP server，由右侧栏 **Capabilities 面板**统一管理；能力集合可存为预设、日后改名或重新保存，也可导入导出。→ [会话能力管理器](docs/features/session-capability-manager.md)

## 安装

**前置要求**：DeepSeek Harness 桌面版 `>=0.2.1-rc.1 <0.3.0`（安装时自动校验，不匹配会被拒绝并提示）。仍在 DSH 0.2.0 线的用户请安装 **1.2.1**（该线的最后一个支持版本：`npm i weir-harness@1.2.1`）——逐版本支持范围见 [版本兼容性矩阵](docs/compatibility.md)。

打开 DeepSeek Harness 桌面应用，进入**插件管理面板**：

1. 点击**添加插件**按钮；
2. 输入包名 `weir-harness@2.0.0`，点击**安装**。

安装器会从 npm registry 拉取，无需克隆仓库。习惯终端的话也可以直接执行 `dsh plugin --profile <profile> add weir-harness@2.0.0`；开发者克隆本仓库后对 `plugins/weir-harness` 做 link 安装（随源码更新，改动经「禁用 → 启用」重应用）。

安装成功后：

1. 打开 Web GUI 预设选择器，应能看到 **Weir**；用它新建会话即完成启用。
2. 开发或调试 DeepSeek Harness 本身时选 **Weir 创造模式**，额外带上运行时检查工具与开发技能。→ [预设打包](docs/features/preset-packaging.md)
3. 其他预设不受影响。Weir 只在自己的会话内生效，唯一例外是系统通知（作用于 profile 层）。

## 快速配置

装好后默认值即可直接使用，无需任何配置。想按自己的工作习惯细调时，建议按以下顺序过一遍（全部在 **全局设置** 完成：通用项在「Weir」页面，委派模型在「Weir 模型路由」独立页面）：

1. **模型路由**：为九种任务类别分别绑定模型与推理等级，可视化编辑，不用手写配置；主模型不可用时自动按备选降级。在「Weir 模型路由」页面。
2. **意图分类**：默认关键词档位开箱即用；希望「说人话」也被识别（不依赖固定关键词）时，切换为语义分类并选一个轻量模型。
3. **自动续推与上下文压力**：默认开启；可调整连续续推上限、出错重试上限，以及上下文整理提醒的触发阈值。
4. **系统通知**：长任务完成、需要审批时发系统通知；不想被打扰可整体关闭（对整个 profile 生效）。
5. **编辑与只读 shell**：锚点编辑、编辑锁默认开启；只读 shell 的命令白名单可按需增删。

多数改动即时生效；标有「需重启」的选项保存后重启生效，保存时弹窗会点名本次涉及的选项。→ [设置页](docs/features/settings-page.md)

## 技术概览

- **形态**：bundle 包 `plugins/weir-harness/`（发布到公共 npm registry，运行时零 npm 依赖），声明预设 `weir`。
- **运行时**：DeepSeek Harness（Electron 宿主），插件仅通过 `ctx` 使用宿主服务，不静态引用宿主包。
- **审计**：关键事件写入 `.weir/audit.jsonl`，不污染会话日志。
- **测试**：单元测试（node:test）、静态检查（tsc checkJs）、基于 mock LLM 的集成测试（`plugins/weir-test-harness/`，仅限开发）。

```
plugins/
├── weir-harness/        # 正式 bundle：预设、特性模块、技能
└── weir-test-harness/   # 开发专用集成测试装置
docs/
├── features/            # 特性细节文档
└── assets/              # 品牌与图像资产
```

## 了解更多

- 特性细节（行为、配置、设计、失败语义）：[docs/features/](docs/features/README.md)
- 版本更新记录：[CHANGELOG.md](CHANGELOG.md)
- 参与开发（纪律、环境、测试流程）：[AGENTS.md](AGENTS.md)
- 品牌资产：[docs/assets/brand/](docs/assets/brand/)

## 许可

[MIT](LICENSE)
