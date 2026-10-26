# 发布

> 本文件是打版与发布的唯一权威：版本号怎么走、`release.mjs` 做什么、npm 发布走哪条管线、打版后必须核对什么。

## 1. 打版是什么

版本号语义化。一次打版 = 三处同步落地：

1. `CHANGELOG.md` 的 `[Unreleased]` 段落固化为 `[X.Y.Z] - YYYY-MM-DD` 版本段；
2. `plugins/weir-harness/package.json` 的 `version` bump 到 `X.Y.Z`；
3. `git tag vX.Y.Z` 打在该提交上。

版本号、CHANGELOG 版本段、git tag、npm 包版本四者不一致即事故（0.7.0 与 tag 脱节的教训）。打版由 `scripts/release.mjs` 编排，手工打版等于跳过门禁。

## 2. `scripts/release.mjs`

```sh
node scripts/release.mjs <X.Y.Z> [--dry-run] [--skip-it] [--no-publish]
```

- **前置**：工作树干净、`vX.Y.Z` tag 尚不存在；版本号必须是精确 `X.Y.Z`（不接受区间与 prerelease 版本号）。
- **动作顺序**：固化 CHANGELOG → bump manifest → 门禁（静态检查 → 单元测试 → 集成测试）→ 提交（`chore: release vX.Y.Z`，只暂存 CHANGELOG 与 manifest）→ 轻量 tag → 发布。
- **`--dry-run`**：全部计算与门禁照跑，但不写文件、不提交、不打 tag、不发布。
- **`--skip-it`**：跳过集成测试门禁；打版前仍必须确保全量集成测试已实际运行并通过（见 [testing.md](testing.md)）。
- **`--no-publish`**：跳过本地 `npm publish`——日常打版都用它，发布交给 GitHub 管线（见 §3）。

## 3. npm 发布管线

发布一律走 GitHub 发版管线，**本地不登录 npm**：

1. 以 `--no-publish` 跑 `release.mjs`，得到 release 提交与 `vX.Y.Z` tag；
2. `git push origin main` + `git push origin vX.Y.Z`；
3. `.github/workflows/release.yml` 由 tag 推送触发：先校验 tag 与 manifest 版本一致（防手工乱打 tag），再经 npm OIDC Trusted Publishing 以 `--provenance --access public` 发布 `weir-harness`，最后用 CHANGELOG 对应版本段自动创建 GitHub Release。

本地裸跑 `release.mjs`（无凭证且不带 `--no-publish`）会在 publish 步报 404/401，但当时的提交与 tag 已经落盘——直接推送即可，**不要重复打 tag**。

发布后必须验证两件事均已就位：registry 的 `dist-tags.latest`，以及 GitHub Release（notes 取自 CHANGELOG 对应版本段）。

manifest 契约（`files` 白名单、`prepack` 门禁、patch 行说明符）与安装侧兼容性校验见 [npm-distribution](../features/npm-distribution.md)。

## 4. 打版必须同步的两处

- **README**：安装说明中的包名版本号（`weir-harness@X.Y.Z`）与顶部版本徽标随打版一并 bump，与 manifest 版本保持一致。
- **兼容性矩阵**：[docs/compatibility.md](../compatibility.md) 必须登记新版本行（Weir 版本 / 支持的 DSH 版本 / 状态 / 备注）。涉及 DSH 支持边界变化时标注「最后支持版本」/「起需要 …」，并在 CHANGELOG 版本段开头同步提示。

## 5. 打版前门禁

- 静态检查、单元测试、集成测试全绿（矩阵见 [testing.md](testing.md)）；集成测试的运行环境与运行时覆盖见该文档 §4。
- CHANGELOG 的 `[Unreleased]` 段落已写全（新增 / 修复 / 破坏性变更），格式见 [documentation.md](documentation.md)。
- README 版本信息与 `docs/compatibility.md` 矩阵按 §4 更新完毕。
