# 客户端 chunk 化（client-module-chunking）

> 浏览器半区按特性拆成 11 个手写 chunk：入口只留组合根，各特性按需异步到达。

## 概述

`lib/client.js` 曾是 bundle 最大文件（1538 行），把六个不相干职责（设置页、模型链编辑器、robash 列表编辑器、LSP 面板、composer LSP 开关、hash_edit diff 视图）装进一个工厂闭包，区域之间没有内部 interface，任何纯 helper 的测试都要重复一份约 60 行的 loader 脚手架（四份）。

本特性把浏览器半区拆成**单一同步入口 + 11 个异步 chunk**：宿主 ModuleLoader 不支持同包文件的同步相对 require（S18 每包唯一 `./client` 出口），唯一受支持的包内拆分是 `require.async("./client.<name>.js")` chunk 协议——宿主按精确 URL 直接读包内文件，**无需构建步骤**，与 lib/ 的零构建纪律相容。

## 用户可见行为

- 功能与拆分前完全一致：设置页、各编辑器、LSP 面板与开关、diff 面板照常工作。
- chunk 到达前的降级形态（新增，仅在首次加载的瞬间可见）：设置页显示字典化的加载态 / 显式错误态（可重试，失败不被记忆化）；composer 的 LSP 开关暂不渲染；hash_edit 工具视图退化为通用扁平 body（到达后自动换成 diff 面板）。
- 设置页首开会并行拉取若干小 chunk（localhost、总计 <100KB），除上述加载态外无可感知差异。

## 配置

本特性无配置项。

## 设计细节

- **入口即组合根**（`lib/client.js`，约 670 行）：en/zh 字典（`apply` 同步 `ctx.locale.register`，chunk 异步到达赶不上同步注册，故字典必须留入口）、`settingsBus`（两个消费者分居不同 chunk，提升为入口并经 props 注入）、三个 slot 包装组件。每个表面对所含 chunk 做**一次 `Promise.all` 并行 fan-out**，不做 chunk 间嵌套 `require.async` 的瀑布。
- **11 个 chunk**（命名匹配宿主 `CLIENT_CHUNK` 正则）：4 个零依赖 model chunk（`client.chain-model.js` / `client.robash-model.js` / `client.lsp-model.js` / `client.hash-edit-model.js`，factory 内零 `require` 调用，纯 view-model 可被 node:test 直接 import）+ 7 个 UI chunk（settings-page / chain-editor / robash-editor / **disabled-categories-editor** / lsp-panel / lsp-toggle / hash-edit-view）。
- **同步 require 面不扩大**：全 lib/ 的同步 require 说明符仍只有 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`、`orrery-model-picker` 四个（S14）；`orrery-model-picker` 经组合图跨模块同步到达（S18 先例）。
- **宿主缓存约束**：宿主按入口缓存 slot `inject()` face，因此设置卡片 face 自带一个稳定的 deferred snapshot store；controller 在 chunk 到达时于入口侧构造（生命周期绑定 serve 代次），不建在 react 树内。
- **样式常量按 chunk 复制**：同包同步 require 不可能，故各 UI chunk 逐字携带自用的样式常量与 `ORRERY_NS` / `LSP_PROJECTION_KEY`（入口为自己的闭包保留副本）——这是该宿主约束下的显式取舍，不是疏漏。
- **派生副本纪律（逻辑级复制）**：当某个纯契约的权威实现住在 `src/`（宿主侧）而 chunk 也需要它时，chunk 携带**逐字派生副本**（`DERIVED FROM <src 路径>` 头注）而不是 import——首例是 `client.hash-edit-model.js` 对 `src/hashline-edit/planned-fragments.js`（见 [hash-edit-diff-view.md](hash-edit-diff-view.md)）。漂移由行为等价钉结构性兜底：同一语料两侧逐案等价，单侧修改即红（改 src/ 忘同步 chunk 或反之）。该模式从「常量复制」（上条）升格到「逻辑复制」的唯一通行证就是这类 parity 钉；没有钉就不允许复制逻辑。
- **rev 重戳（内容绑定自动完成）**：chunk URL 携带**入口**文件的 rev（由 `lib/client.js` 的 mtime/ctime/size 派生）。`scripts/build-client.js` 把每个 chunk 的 sha256 写进入口首行 manifest，因此**任何 chunk 编辑后跑 `pnpm build`，入口内容必然变化**（mtime 随 rev 自动重戳）；改了 chunk 不跑 build 则由 `test/client.test.js` 的 digest 断言确定性判红。纪律只有一条：改 chunk 后跑 build。不依赖文件 mtime 序——git 合并/checkout/克隆会按任意顺序重写 mtime，曾使旧的 mtime 断言在车道合并后必红（假阳性，已移除）。
- **S17 保持**：`remote.session` 惰性访问以 `getSession` 闭包注入，chunk 不做早解引用（有单测钉零解引用）。

## 边界与失败语义

- **chunk 拉取失败**：设置页进入字典化错误态，重试可用（失败结果不被记忆化，下一次 fan-out 会真发请求）；composer 开关保持不渲染；toolview 保持通用 body。**任何单个 chunk 失败都不会波及其他表面**（per-surface fan-out 相互独立）。
- **旧 rev 404**：改了 chunk 漏跑 build 时，浏览器按旧 rev 请求 chunk 得到 404 → 上述错误态（digest 断言会先于合入判红）。恢复 = `pnpm --filter orrery-harness run build` + 重新应用 bundle。
- **零依赖 model chunk 永不 require**：这是结构性保证（factory 体内无 `require(`），由 5.2 审计与单测共同钉住。

## 测试

- 单元测试：`test/helpers/load-client-chunk.js`（约 20 行共享 chunk 加载帮手，取代原 4×60 行脚手架）；11 个 `test/client-*.test.js` 对 model chunk 零桩直测（全部迁移自原 client.test.js 的对应断言，未删除任何行为钉）；`test/client.test.js` 收敛为单脚手架组合测试（同步 apply 契约、各表面 `require.async` 说明符序列、加载/错误/到达三态与重试语义、settingsBus 同一性贯通、S17 零解引用、杂烩导出缺席钉）。
- 集成测试：无 headless 覆盖（浏览器半区不进 headless profile）；桌面冒烟（set_bundle 关/开后设置页与 diff 面板实测）登记为人工验收项。
- **已知边界**：`jsconfig.json` 的 `include` 只覆盖 `src/**`——`run check` 从不类型检查 `lib/**`（拆分前即如此，本次未改变；是否把 lib/ 纳入类型检查登记为后续评估项）。
