# Parent stop / child publication 复现证据

## 修复前结论（历史证据）

以下 27/27 为提交 `332039d` 的修复前复现，不是当前 Stop 契约的验收。原 trace 可从该提交读取；当前 fixtures 已用修复后安装版运行刷新。

真实已安装 Electron CLI 中，仅 parent user stop 就能复现 `unknown`，不需要注入 I/O 错误。限定条件是子代理已进入 `writeText`、临时文件已写入，但尚未执行最终 abort 检查。该检查抛出取消异常，manager 的 `attempt.invoke()` catch 将它持久化为 `unknown`；目标文件实际不存在。

不是所有取消都会 unknown：predispatch 没有子代理 operation；最终 abort 检查之后取消，真实 hard-link 正常完成，operation 为 `created`，文件内容为 `published\n`。

## 方法与边界

- 只使用开发 profile 与本 lane 的 `.stop-it` fixture，不安装或更改正式 profile，不访问真实 authority snapshot。
- mock LLM 触发真实 delegate/write；probe 在已安装 backend 的 `internals.inspectTemp` / `internals.linkFile` 暂停点调用 `parent.cancel({kind:'user'}, {keepInbox:true})`。这是用户 stop 的 agent API，不是 GUI 点击测试。
- 子代理取消由宿主自动传播，没有直接调用 child.cancel，也没有合成 unknown、删 reservation 或修改产品实现。
- 验证双方 stop 前均 running、signal 原本未 abort、同步传播后已 abort；持久 turn/end 分别是 aborted/user、aborted/parent。
- 等待 headless 正常返回后检查文件，再启动全新进程/新 session 尝试 unrelated 和 target 写入。因此这里是 **cold continuation**，不是同一存活 runtime 的新 session。
- staged unknown 在 cold continuation 对两者均拒绝：`unresolved publication fence: scope-continuity-unproved`。这不证明同 runtime unrelated 操作也受阻。
- publication 成功后的 unrelated 写入成功；对已存在目标的无版本 write 被 `existing resource requires original version guard` 拒绝，不是 unknown fence。
- 未注入 publication 后失败：现有 cleanup 错误会被 backend 吞掉；让成功 link 后的 hook 人为抛出会改变被测返回语义，不能当作自然取消证据。

## 运行命令

从本 lane 根目录运行（`run.mjs` 会清理指定 IT_ROOT，必须保持专用 fixture 路径）：

```sh
export PATH=/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH
WEIR_IT_ROOT="$PWD/plugins/weir-test-harness/.stop-it" \
WEIR_IT_RECORD="$PWD/plugins/weir-test-harness/test/fixtures/traces" \
WEIR_IT_DSH_EXEC='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
node plugins/weir-test-harness/run.mjs editlock-stop-predispatch editlock-stop-staged editlock-stop-publication
```

最终结果 **27/27 PASS，exit 0**。每个场景的 trace/trace2/run metadata 和 fixture snapshot 已记录于 test/fixtures/traces/editlock-stop-*，由原有 assert-replay 测试重放。三个 authority 目录独立，避免 staged unknown 污染其他对照。

```sh
node --test --test-name-pattern='editlock-stop|scenario registry|trace record key migration' plugins/weir-test-harness/test/*.test.js
```

结果 **18 pass / 0 fail**（含被筛选测试文件的 runner 计数）。

## 广泛检查与已知未绿项

- `pnpm --filter weir-harness run check`：通过，零 checkJs 错误。
- `pnpm --filter weir-harness test`：1493/1494 pass；唯一失败为既有 lib/client.js mtime 入口 guard，提示 client.lsp-model.js 比入口新。未改源码、未削弱断言、未 restamp 越出写入 scope。
- `pnpm --filter weir-test-harness test`：107/109 pass。两个非新增场景 replay 失败：rehydrate 缺 phase1 audit JSONL；worktree 缺 ledger。git ls-files 确认对应历史 fixtures 未追踪这些文件。新增三个场景及 registry/observation 全绿。未修改旧 fixtures 掩盖失败。
- 早期探针配置尝试有失败：YAML 未引号化 ternary 变成错误配置、snapshot 包装层解析错误、共用 authority 导致后续场景被 fence、误以为无版本覆盖允许。均依据真实输出修正测试配置/预期；最终没有更改产品语义。
- 直接 Node 启动提取的 CLI 不可用；最终全部真实证据来自已安装 app 的自包含 CLI launcher。

本次是原因判别测试提交，不是产品修复或离线恢复功能。未执行全量安装宿主集成场景；独立 reviewer 需由父 orchestrator 执行（此 worker 不能继续委派）。

## 修复后验收

在 lane `settle-accepted-publication-on-p-006` 使用已安装 Electron CLI 和隔离开发 profile 执行四场景：predispatch、staged、publication、update，结果 **51/51 PASS，exit 0**。命令同上，IT_ROOT 改为本 lane 的 `plugins/weir-test-harness/.stop-contract-final`，场景列表增加 `editlock-stop-update`。

- staged CREATE 现在正常 created；UPDATE 先创建目标和无关文件，由 child 真实 read 取得原版本，再 write。精确目录及临时文件名的 inspectTemp gate 调用 parent.cancel；父子均 running，两个原始 signal 从 false 变 true。
- captured backend 恰调用一次，private commit signal 未 abort，实际字节为 published；UPDATE 历史为 updated，child ownership 为 user-interrupted；父子 turn/end 分别 aborted/user 与 aborted/parent。
- 冷启动 continuation 的退出码也断言成功；其无版本覆盖现有文件被 version guard 拒绝。此处不把 cold continuation 当作同 runtime 隔离证明。
- publisher 回归 5/5：另一个在同 runtime 已 active、由 host registry 认证的 session 在真实拒绝留下 unknown 后能更新无关既有文件；还覆盖 intent 持久化期间取消零调用、停止后后续拒绝、历史不重放、close 等待。
- checkJs 通过。全产品单测首次仅既有 client entry mtime guard 失败；按授权对 lib/client.js 作内容不变的 mtime restamp 后重跑。装置单测新增四场景 replay 均通过，既有 rehydrate phase1 audit／worktree ledger 缺失仍失败，未伪造补齐。
- 首次 UPDATE 探针误用 exec.args 导致未触发 Stop，主动终止后按真实边界改为 child 身份加精确 staged 目标匹配；最终四场景均已重新运行，不采用失败运行作验收。
