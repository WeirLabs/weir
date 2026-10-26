# 文档

> 本文件是 Weir 文档体系的唯一权威：文档分层与职责、什么时候必须更新、特性文档怎么写、语言纪律。

文档是产品的一部分，与代码同等级对待。**任何 feat/fix 的完成定义（DoD）都包含文档更新**（清单见 [development.md](development.md) §5）。

## 1. 分层与职责

| 文档 | 受众 | 职责 | 口吻 |
|---|---|---|---|
| `README.md` | **客户/潜在用户** | 产品门面：是什么、价值、怎么用、去哪里看细节 | 白话、克制术语，不出现 cordis/钩子/事件名等实现词汇 |
| `CHANGELOG.md` | 客户 + 开发者 | 每个版本的增删改、修复、破坏性变更 | 简洁事实，Keep a Changelog 1.1.0 格式 |
| `docs/features/*.md` | 高级用户 + 维护者 | 每个特性的细节：行为、配置、设计、失败语义、测试 | 精确技术语言，可引用机制与契约 |
| `docs/contributing/*.md` | 维护者 / Agent | 开发、测试、文档、发布纪律的操作细节 | 精确、可执行；命令、路径、模板原样给出 |
| `AGENTS.md` | 开发者 / Agent | 入口：项目导航、按任务读什么、红线、完成与提交入口 | 命令式、无歧义 |

**入口与细节分层**：每次任务都进上下文的文件只放目的、导航、红线与触发条件；操作步骤、命令与模板细节落在 `docs/contributing/`，按触发条件按需读取。节省上下文的代价不能是反复搜索或遗漏红线——红线一律留在入口文件，一份延迟文档必须从入口文件可检索到。

## 2. 更新时机（强制）

- **新增/变更特性**：同一批次内完成 ① `docs/features/<feature>.md` 新建或修订 ② `CHANGELOG.md` Unreleased 段落条目 ③ 若影响用户可见表面，`README.md` 同步。三者缺一不算完成。
- **修复**：`CHANGELOG.md` Unreleased 的 `Fixed` 段加条目；若修复改变了文档化的行为，同步修订对应 feat 文档。
- **打版**：CHANGELOG Unreleased 固化 + README 版本相关信息核对 + tag（完整要求见 [releasing.md](releasing.md)）。
- **README 克制原则**：实现细节只放 `docs/features/`，README 只做链接；README 中每个特性一句话说清「用户得到什么」，不说「内部怎么实现」。

## 3. 特性文档格式

一律从 [_template.md](../features/_template.md) 复制骨架：概述 / 用户可见行为 / 配置 / 设计细节 / 边界与失败语义 / 测试。索引维护在 [docs/features/README.md](../features/README.md)。

## 4. 维护者文档（`docs/contributing/`）

本目录一份文件一个权威领域，互不重复正文：[development.md](development.md)（环境、OpenSpec、纪律细节、提交与 DoD）、[testing.md](testing.md)（测试矩阵与命令）、本文件（文档体系）、[releasing.md](releasing.md)（打版与发布）。新增主题文档时必须同时登记到 [AGENTS.md](../../AGENTS.md) §2 的路由表，否则它在入口不可检索。

## 5. 语言纪律（文档层）

中文为主；技术标识符、工具名、配置键、模板原文保留英文；引用的提示词/通知模板按其实际语言（英文）原样引用。模板层与实例内容的语言分工见 [AGENTS.md](../../AGENTS.md) §3.7。
