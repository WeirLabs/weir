# Orrery

自建的 Orchestrator 中心 Harness 预设，以 DSH bundle `orrery-harness` 交付。

## 仓库布局

```
plugins/
├── orrery-harness/        # 正式 bundle：预设声明 + 七个特性模块 + 技能
└── orrery-test-harness/   # 开发专用集成测试装置（mock LLM + headless profile），不入正式 profile
```

## 开发回路

```sh
# 单元测试（node:test，无需安装额外工具链）
pnpm --filter orrery-harness test

# 静态检查（tsc checkJs，覆盖强类型核心模块）
pnpm --filter orrery-harness run check

# 集成测试（真实 headless runtime + 脚本化 mock LLM，写入 /tmp/orrery-it）
pnpm --filter orrery-test-harness run test:integration

# 安装/重装到当前 profile（在 Harness 会话内由 plugin_manager 执行：
# install_bundle → target 为 plugins/orrery-harness 的绝对路径）
# 代码或 patch 改动后用 set_bundle 先禁用再启用完成重应用。
```

## 版本控制纪律

- 入库内容仅限插件实际内容（源码、测试、技能、包清单、构建配置）。
- `.gitignore` 排除：`.claude/`、`.agent(s)/`、`openspec/`、`docs/`、AI 生成的工作报告、构建产物、敏感文件。
- 阶段性 feat/fix 即提交（Conventional Commits），不攒超大 commit；提交信息严禁 `Co-authored-by` 与任何 AI 署名。

## 流程

OpenSpec 变更 `add-orrery-preset`（openspec/，本地过程材料，不入库）驱动任务分解与验收；设计细节在 `docs/design.md`（本地）。
