# 测试

> 本文件是 Weir 测试矩阵与测试纪律的唯一权威：跑哪一层、什么时候跑、命令怎么写、装置为什么这样设计。

## 1. 测试矩阵

| 层 | 命令 | 期望 | 何时跑 |
|---|---|---|---|
| 静态检查 | `pnpm --filter weir-harness run check` | tsc checkJs 零错误 | 改 `src/**` 后 |
| 单元测试 | `pnpm --filter weir-harness test` | 全部通过（node:test + 自研 expect 门面） | 改 `src/**`、`test/**` 后；每次提交前 |
| 集成测试 | `pnpm --filter weir-test-harness run test:integration` | 全部通过（写入 `WEIR_IT_ROOT`，默认 `<仓库根>/.weir/it-root`，lane 内自动解析为 lane 内路径；headless launcher 失效时用 `WEIR_IT_DSH_EXEC` 走安装版 CLI） | 改预设组合、工具表面、续推/压缩/委派行为后；打版前必跑 |
| 装置单测 | `pnpm --filter weir-test-harness test` | 全部通过（`src/shell.js` 的平台 shell 契约） | 改 `plugins/weir-test-harness/**` 后 |
| 脚本单测 | `node --test scripts/*.test.mjs` | 全部通过（根目录 `scripts/release.mjs` 的纯逻辑契约） | 改 `scripts/` 后（CI 已跑） |

## 2. 测试纪律

1. **不要安装 vitest**——捆绑 Node 因 TeamID 签名无法 dlopen 原生插件；单测只用 `node:test`。
2. 新特性必须有对应层级的测试：纯逻辑 → 单测；涉及运行时行为（注入/续推/压缩/委派/编辑）→ 集成测试场景。
3. mock adapter 即严格供应商：会校验工具 schema 为 object-rooted；新工具 schema 不合规时 headless 测试直接失败，这是防线不是麻烦。
4. 测试装置镜像了预设的 realm 隔离结构，改动 cordis 分组时必须同步镜像到测试 patch。

## 3. 命令速查

```sh
# 日常
pnpm --filter weir-harness run check     # 静态检查
pnpm --filter weir-harness test          # 单元测试
pnpm --filter weir-test-harness run test:integration   # 集成测试
pnpm --filter weir-test-harness test     # 装置单测
node --test scripts/*.test.mjs           # 根目录脚本单测
```

`pnpm` 与 Node 的执行方式见 [development.md](development.md) §1（捆绑工具链不在 PATH）。

长跑测试：逐套件分开跑，输出落盘再 tail（勿把串行测试链塞进单个后台 job）。在 `plugins/weir-harness/` 下：

```sh
node --test --test-reporter=spec "test/**/*.test.js" > /tmp/unit.log 2>&1 && tail -5 /tmp/unit.log
```

## 4. 集成装置要点

- **运行根**：默认 `<仓库根>/.weir/it-root`，从包位置解析而非 cwd，因此 lane 内运行自动落在 lane 内；产物不入库。显式设置 `WEIR_IT_ROOT` 会绕过并发咨询锁——调用方自负隔离。
- **运行时覆盖**：`WEIR_IT_DSH_EXEC` 指定自包含 CLI launcher（如安装版桌面 CLI）；另有 `WEIR_IT_NODE`/`WEIR_IT_DSH`/`WEIR_IT_PNPM` 用于验证非安装版的 DSH 树。都不设时由 `src/launcher.js` 自动发现。
- **场景**：权威来源是 `src/scenarios/index.js` 的有序 `SCENARIOS`；新增场景 = 新增场景模块 + 索引登记一处。未知场景 id 是响亮失败，不是静默跳过。
- **镜像**：装置生成的 profile 名为 `weir-it`，只存在于测试根目录；它镜像生产预设的组合与 realm 结构，生产 `cordis.patch.yml` 与测试 patch 必须同步演进。
- 完整机制、场景清单与断言口径见 [integration-test-harness](../features/integration-test-harness.md)。
