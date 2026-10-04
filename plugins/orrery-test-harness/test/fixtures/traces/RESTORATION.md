# rehydrate / worktree 回放证据来源

这两个场景来自协调者实际执行的安装版 DSH 集成运行，不是合成事件：

- `ORRERY_IT_ROOT=/Users/young/orrery-qa-ZAaBsO`
- `TMPDIR=/tmp/oq-yrBDrs`
- `ORRERY_IT_RECORD=/tmp/oq-yrBDrs/records`
- `ORRERY_IT_DSH_EXEC=/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`

原始整轮结果为 164/165；唯一失败是 capstore 的 `realm commit saw the host record (one shared store)`，与这两个场景无关。这两个场景各自的全部断言以及 trace key-set 检查通过。

恢复单位是完整场景目录：run metadata、trace（rehydrate 含两个阶段）、工作区文件、audit，以及 worktree 的 ledger / Git exclude。全部文件按录制字节保留，未拼接旧 session 的证据、未改写 UUID / 时间 / commit / 路径；`probe-other.ts` 的 CRLF 也是原始录制内容。审计包含该轮此前场景的累积记录，回放按 session 关联。原有 fixture 约定直接保存实际标识符，并无脱敏占位符协议；固定字节回放不依赖对应路径仍存在。

新增一致性测试关联 rehydrate 的 metadata / 两阶段 trace / audit 中父子 session，以及 worktree 的 ledger owner / base commit / open audit。Git 忽略例外仅允许这两个 fixture 的 audit 与指定 ledger，未开放其他运行时状态或凭据。

这些原始录制本身不证明 capstore 修正后的安装版运行通过。协调者随后使用新建可丢弃隔离根完成全量门禁：165/165，exit 0（本地 `/tmp/oq-fpE0BU/integration.log`，本批次只读核验）；最终装置单测 118/118。16 个场景文件再次逐字节核对上述原始 records，全部一致；没有用新运行的标识符混写旧录制。不要在上述原始 QA 根重跑 driver（setup 会删除根目录）。
