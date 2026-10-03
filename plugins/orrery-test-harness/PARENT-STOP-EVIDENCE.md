# Parent stop / child publication 复现证据

## 结论

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
ORRERY_IT_ROOT="$PWD/plugins/orrery-test-harness/.stop-it" \
ORRERY_IT_RECORD="$PWD/plugins/orrery-test-harness/test/fixtures/traces" \
ORRERY_IT_DSH_EXEC='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
node plugins/orrery-test-harness/run.mjs editlock-stop-predispatch editlock-stop-staged editlock-stop-publication
```

最终结果 **27/27 PASS，exit 0**。每个场景的 trace/trace2/run metadata 和 fixture snapshot 已记录于 test/fixtures/traces/editlock-stop-*，由原有 assert-replay 测试重放。三个 authority 目录独立，避免 staged unknown 污染其他对照。

```sh
node --test --test-name-pattern='editlock-stop|scenario registry|trace record key migration' plugins/orrery-test-harness/test/*.test.js
```

结果 **18 pass / 0 fail**（含被筛选测试文件的 runner 计数）。

## 广泛检查与已知未绿项

- `pnpm --filter orrery-harness run check`：通过，零 checkJs 错误。
- `pnpm --filter orrery-harness test`：1493/1494 pass；唯一失败为既有 lib/client.js mtime 入口 guard，提示 client.lsp-model.js 比入口新。未改源码、未削弱断言、未 restamp 越出写入 scope。
- `pnpm --filter orrery-test-harness test`：107/109 pass。两个非新增场景 replay 失败：rehydrate 缺 phase1 audit JSONL；worktree 缺 ledger。git ls-files 确认对应历史 fixtures 未追踪这些文件。新增三个场景及 registry/observation 全绿。未修改旧 fixtures 掩盖失败。
- 早期探针配置尝试有失败：YAML 未引号化 ternary 变成错误配置、snapshot 包装层解析错误、共用 authority 导致后续场景被 fence、误以为无版本覆盖允许。均依据真实输出修正测试配置/预期；最终没有更改产品语义。
- 直接 Node 启动提取的 CLI 不可用；最终全部真实证据来自已安装 app 的自包含 CLI launcher。

本次是原因判别测试提交，不是产品修复或离线恢复功能。未执行全量安装宿主集成场景；独立 reviewer 需由父 orchestrator 执行（此 worker 不能继续委派）。
