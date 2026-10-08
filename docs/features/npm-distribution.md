# npm 公共分发

> 用户不克隆仓库，一条命令从 npm registry 安装 Weir；版本不兼容的 DSH 运行时在安装前就被明确拒绝。

## 概述

Weir 以 `weir-harness` 包发布到公共 npm registry。DSH 的插件管理原生支持从 registry 安装 bundle（profile 内 `pnpm add` + 装后校验 + 失败回滚），因此分发不需要任何自研安装器——发布化工作集中在 manifest 字段、发布产物完整性、版本兼容闸门与打版流程四位一体。

本特性同时修复一个历史事故：bundle manifest 的 `version` 曾在 rename 提交后停在 0.7.0，与 CHANGELOG/tag 脱节。自 1.1.0 起 manifest version、CHANGELOG 版本段、git tag、npm 包版本四者强制一致。

## 用户可见行为

- 安装：`dsh plugin --profile web add weir-harness`，或会话内 `plugin_manager` 的 `install_bundle`（target 填 `weir-harness`，可带 `@版本`）。
- 升级：对 registry 安装的副本执行 `install_bundle` 目标 `weir-harness@latest`；profile 依赖状态收敛到恰好一个新版本，之后创建的会话用新组合，存活会话保持原组合。
- 兼容性：DSH 运行时版本不满足 manifest 声明的 `peerDependencies["@deepseek-ai/dsh"]` 区间时，registry 安装在下载前即被拒绝（incompatible-version），profile 依赖状态不变；用户可通过插件管理的 `set_version_exemption` 自担风险豁免。
- 设置默认预设的行为不变：安装不会把 Weir 设为默认预设。

## 配置

本特性无配置项。

## 设计细节

**Manifest 契约**（`plugins/weir-harness/package.json`）：

- `dsh.bundle.patch` 指向 `cordis.patch.yml`——DSH 认定 bundle 的唯一必需字段。
- `peerDependencies: { "@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0" }`——DSH 的兼容性检查只认 `peerDependencies` 中 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 条目（`dsh-app-boot/lib/index.js:286-313`，`includePrerelease: true`）；不声明等于放弃闸门，`@deepseek-ai/cordis` peer 被检查器无视。区间取显式上下界：精确 pin 会让每次 rc bump 都要求用户豁免。
- `files` 白名单：`src/`、`lib/`、`skills/`、`cordis.patch.yml`、`whitelist-defaults.json`（README/LICENSE 由 npm 自动附带，`src/vendor/THIRD-PARTY.md` 随 `src/` 进包）。白名单可枚举、可测试，优于 `.npmignore` 黑名单（易误带 `test/` 与杂散文件）。
- `prepack` 钩子串联 `check && test && build`，保证任何 `npm/pnpm pack`、`npm publish` 产出的 tarball 都含新鲜构建的 client——即便绕过 CI 手工发布。
- 禁止 `dependencies`/`devDependencies` 引入 `@deepseek-ai/*`（AGENTS.md §3.8）：DSH profile 的 pnpm 配置 `autoInstallPeers: false`，peer 只作闸门不作拉取。

**为什么 npm 安装后运行时代码零改动**：patch 路径相对 installed 包根解析，patch 内相对 `insert[].name` 锚定 patch 所在目录；bundle 的 skills 经 `import.meta.url` 相对定位（`src/capabilities/skill-selection-plugin.js`）；`whitelist-defaults.json` 从包根读取。这些路径语义在 link 安装与 registry 安装（node_modules 内）下完全一致。client 半边满足 DSH 的双重契约：`dsh.client.platform === "web"` 且 `exports["./client"]` 指向包内文件。

**patch 行只能用发布产物内的说明符**：`cordis.patch.yml` 里每个 `insert[].name` 都必须在任意用户 profile 里解析得到——要么是本包自己的 `exports` 子路径（且落在 `files` 白名单内），要么是 DSH 运行时供给的 `@deepseek-ai/*`。指向第二个私有包的裸包名是**分发必坏**的形状：registry 安装的用户永远拿不到它，entry 的 fiber 为空，启动只留一行 `ui-weir-model-picker (weir-model-picker): failed to import`，而 CI 全程绿灯（1.1.0–1.1.1 的真实事故：模型选择器曾是独立私有包）。修法是把它并回本包——1.1.2 起是包内 chunk `lib/client.model-picker.js`；`test/patch-rows.test.js` 对 patch 逐行钉死该规则（含这条事故形状的反例钉）。

**Registry 安装的两道校验**：装前 preflight（`pnpm view` 读 peer，仅 registry spec 触发）与装后校验（恰好新增一个依赖、patch 可加载、peer 复查；失败回滚 profile 的 `package.json` + `pnpm-lock.yaml`）。路径/tarball 安装只有装后校验。

**打版四位一体**：`scripts/release.mjs` 编排——工作树干净检查 → CHANGELOG Unreleased 固化为版本段 → manifest version bump → check + 单测 + 集成测试门禁 → `git tag vX.Y.Z` → `npm publish`。tag 推送后由 `.github/workflows/release.yml` 接管：先校验 tag 与 manifest 版本一致（防手工乱打 tag），再经 npm Trusted Publishing（OIDC）带 `--provenance` 发布，最后从 CHANGELOG 对应版本段自动生成 GitHub Release notes。日常门禁由 `.github/workflows/ci.yml` 承担：push/PR 触发静态检查、单元测试、release 脚本测试与 pack 冒烟（prepack 门禁 + tarball 形状断言）。集成测试因依赖桌面运行时留在本地 release 门禁，不进 CI。

## 边界与失败语义

- 重复 `install_bundle` 同一包被 `ambiguous-install` 幂等拒绝——bundle 改动重应用走 `set_bundle` 先禁后启（开发者）或 `weir-harness@新版本`（用户）。
- 兼容性豁免（`compatibility.json`）以精确 `name@version` → 精确 DSH 版本数组登记，需 `acceptRisk: true`；不可读/不可解析的豁免文件不授权任何豁免。
- tarball/路径安装绕过装前 preflight，兼容性问题只在装后暴露（仍回滚）——文档统一引导 registry 安装，tarball 仅用于发布前验证。
- peer 区间上限随 DSH 升级维护：DSH 0.3 发布后由一次兼容性验证 + 区间放宽的小版本跟进。
- `prepack` 任一门禁失败则 pack/publish 中止，不产生 tarball。
- 启动诊断里的 `did not activate … failed to import` 只有一个含义：该行的模块说明符在 profile 里解析不到（预置行缺失不会产生这条诊断，patch 未命中只是被跳过并告警）。修法只有两种：补齐依赖，或把被指向的代码并回本包。
- 永不发生：发布产物包含 `test/`、`scripts/` 或运行时不需要的开发文件（`files` 白名单 + packaging 单测双重保证）。

## 测试

- 单元测试：`plugins/weir-harness/test/packaging.test.js`——manifest 无 `private`、`files` 覆盖五个运行时必需路径且路径存在于磁盘、peer 区间是合法 semver、`prepack` 钩子存在。
- 分发自包含：`plugins/weir-harness/test/patch-rows.test.js`——patch 中每个模块说明符都可解析（本包 `exports` + `files` 白名单，或运行时 `@deepseek-ai/*`），且每个 `exports` 目标都在 `files` 内；另有两组反例钉（`weir-model-picker` 事故形状、未导出/未随包的子路径）。
- `scripts/release.mjs` 的纯逻辑（版本解析、CHANGELOG 固化文本变换）有配套单测（`scripts/release.test.mjs`）。
- 发布前手工验证路径：`pnpm pack` → 开发 profile 卸 link 换 tarball 绝对路径 `install_bundle` → preset/设置页/技能/client UI 验证 → 恢复 link。发布后：registry spec 真机安装验证（触发 preflight 路径）。
