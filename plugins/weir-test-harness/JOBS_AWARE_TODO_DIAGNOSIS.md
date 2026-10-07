# jobs-aware-todo：安装版 headless 生命周期阻塞

## 结论

安装版 CLI `0.2.0-rc.2` 的一次性 headless runner 在父 agent 首次 idle 后退出，不等待后台 job 结算与唤醒。本场景要求父回合先结束、随后由结算通知唤醒，因此当前 launcher 不能完成这个端到端场景。不能通过让父代理等待 `job_output` 或保持回合忙碌来制造 8/8：那会改变场景要验证的语义。

## 实测

在车道根的 `plugins/weir-test-harness` 内运行（额外指定车道内 root，避免清理共享测试目录）：

```sh
export PATH="/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH"
WEIR_IT_ROOT="/Users/young/Documents/Orrery/.weir/worktrees/jobs-aware-todo-continuation-016/plugins/weir-test-harness/.it-jobs-aware" \
WEIR_IT_DSH_EXEC="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
node run.mjs jobs-aware-todo
```

结果：`2/8 integration checks passed`，driver exit 1；通过项为 pending todo 已登记、headless 正常退出。`node --test plugins/weir-harness/test/todo-driver.test.js`：56 passed / 0 failed。

## 排除 schema 假说的证据

父会话 `session-942e947d-c4bf-4ebf-9fb5-0cc5dda98f75` 的 mock trace 最后一个请求的 `lastTool` 为：

```text
Delegated in the background. Completion arrives as a compact notice; pull the report with job_output(job_id).
- subagent-1: finder: TASK: Wait briefly then finish JOBS_AWARE_CHILD
```

因此 `delegate` 已被调用并成功登记 job，不是 tool-call schema 被拒绝。紧随其后是父 `turn/end`，`reason: completed`，没有 child model request 或结算通知。场景的“parent delegated a background child”断言同时要求 child request，所以失败不代表未调用 delegate。

实际创建了 child `2cd77b18-00d0-49ef-a80c-cac64180af31`。用多帧 zstd 解码脚本读取其日志得到 `frames=2 decoded=2 skipped=0`，全部内容只有：

```json
{"type":"session","version":4,"id":"2cd77b18-00d0-49ef-a80c-cac64180af31","createdAt":1791133024569,"cwd":"/Users/young/Documents/Orrery/.weir/worktrees/jobs-aware-todo-continuation-016/plugins/weir-test-harness/.it-jobs-aware/ws","parentSession":"session-942e947d-c4bf-4ebf-9fb5-0cc5dda98f75","isSeeded":false,"origin":"subagent","delegationDepth":1}
{"type":"sandbox/mode","seq":0,"time":1791133024571,"data":{"mode":"workspace-write","source":"delegation"}}
{"type":"approval/policy","seq":1,"time":1791133024571,"data":{"policy":"never","source":"delegation"}}
```

## 安装版源码证据

直接从安装应用的 `app.asar/dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js` 读取（不是失效的 `/tmp/dsh-src`）。`run()` 第 329–345 行的实际控制流：

```js
agent.followup(createUserMessage({ /* task */ }));
await agent.whenIdle();
// finally: stopReasoning?.();
await sessions.flush(agent.session);
const outcome = summarize(agent.session, firstSeq);
if (projection === void 0) io.stdout.write(outcome.text + "\n");
else projection.finish(outcome.text);
if (outcome.reason?.kind === "error") io.stderr.write(/* error */);
io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
```

这里没有 jobs drain、settlement barrier 或全局 quiescence 等待。生产 delegate 的 `spawnBackground()` 通过 `jobs.start()` 立即返回 job id；child spawn 在 job 的异步 `done` 内继续。两者组合解释了“已返回后台 job，child 仅建好 session，父 idle 即进程退出”。

另观察到场景以最后一条消息的 role 推进，runtime-context 注入导致 pending todo 写了两次；这需要后续修正，但不是当前退出阻塞的原因。`error:no classifier route` 是旁路 fallback，父模型仍正常调用 todo/delegate，未中止回合。

## 后续需要

使用能在父 idle 后仍保持宿主存活并投递后台结算的运行方式，或为测试装置设计独立的持久宿主 driver，再跑原有八项断言。保持断言不放宽，不把父等待 job 的路径冒充 idle 后唤醒。此次仅解决主分支合并冲突并记录环境限制；不声称该集成场景已通过。
