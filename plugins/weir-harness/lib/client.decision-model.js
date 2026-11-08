window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-model.js",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const okValue = (payload) => payload && payload.ok === true ? payload.value : payload;
    const array = (value) => Array.isArray(value) ? value : [];
    const text = (value, fallback = "") => typeof value === "string" ? value : fallback;

    function narrowRecords(payload) {
      const value = okValue(payload);
      return { records: array(value?.records), nextCursor: typeof value?.nextCursor === "string" ? value.nextCursor : null };
    }
    function narrowInbox(payload) { return array(okValue(payload)); }

    function selectorOptions(payload) {
      const value = okValue(payload) ?? payload;
      const agents = array(value?.agents).filter(agent => agent && agent.state === "enabled" && typeof agent.agentId === "string");
      return [
        { value: "off", mode: "off", label: "Off" },
        ...agents.map(agent => ({ value: agent.agentId, mode: "agent", label: text(agent.name, agent.agentId), agent })),
      ];
    }

    function cardView(detail, agents = []) {
      if (!detail || typeof detail !== "object" || !detail.case || typeof detail.case.caseId !== "string") return null;
      const current = detail.case;
      const agent = array(agents).find(item => item.agentId === current.agentId);
      const evidence = [];
      for (const attempt of array(detail.attempts)) for (const ref of array(attempt.evidence)) evidence.push(ref);
      const decision = current.decision;
      const latestAttempt = array(detail.attempts).at(-1);
      const rationale = text(array(latestAttempt?.claims)[0]?.text);
      const summary = text(current.escalation?.missing?.[0], text(decision?.hint, text(decision?.code, text(rationale, text(current.awaitingReason, text(current.closing, current.state))))));
      return {
        caseId: current.caseId,
        agentId: text(current.agentId),
        agentName: text(agent?.name, text(current.agentId, "Decision Agent")),
        state: current.state,
        closing: current.closing,
        outcome: current.closing ?? current.state,
        summary,
        evidence,
        revision: Number.isInteger(current.revision) ? current.revision : 0,
        recordLink: `weir-decisions:${current.caseId}`,
        feedbackState: current.feedbackState,
        needsReview: current.needsReview === true,
        escalation: current.escalation ?? null,
        answers: array(decision?.answers),
      };
    }

    function pageView(input = {}) {
      const tab = ["agents", "records", "inbox", "metrics"].includes(input.tab) ? input.tab : "agents";
      return {
        tab,
        tabs: ["agents", "records", "inbox", "metrics"],
        agents: array(input.agents), records: array(input.records), inbox: array(input.inbox),
        metrics: input.metrics && typeof input.metrics === "object" ? input.metrics : null,
      };
    }


    async function decisionRpc(connection, method, args = {}) {
      const transport = await connection.rpc.call("/api", `weirDecision/${method}`, { args: { args } });
      const service = transport?.value;
      const failure = transport?.ok === false ? transport.error : service?.ok === false ? service.error : null;
      if (!transport || transport.ok !== true || failure) {
        const error = new Error(text(failure?.message, `Decision ${method} failed`));
        error.code = text(failure?.code, "DECISION_REMOTE_FAILED");
        throw error;
      }
      return service?.ok === true ? service.value : service;
    }

    const dictionaries = {
      en: {
        decisionSelector: "Decision Agent", decisionOff: "Off", decisionAgents: "Agents", decisionRecords: "Records",
        decisionInbox: "Inbox", decisionMetrics: "Metrics", decisionLoading: "Loading decisions…", decisionFailed: "Decision action failed; retry is available.",
        decisionEvidence: "Evidence", decisionSuggestions: "Suggestions", decisionPerQuestion: "Per-question conclusions", decisionRevision: "Revision", decisionHistory: "Open record", decisionNoRecord: "No decision records.",
        decisionUp: "Upvote", decisionDown: "Downvote", decisionUndo: "Undo rating", decisionComment: "Comment", decisionCorrect: "Correct",
        decisionDecide: "Decide", decisionReassign: "Reassign", decisionCancel: "Cancel", decisionRetry: "Retry", decisionSave: "Save",
        decisionContextPack: "Context Pack", decisionL2Memory: "L2 semantic memory", decisionMemoryEmpty: "empty",
        decisionNeutralEpisodes: "L3 neutral episodes (non-authoritative context, not evidence)", decisionNoMemory: "No L2/L3 memory use is recorded for this Attempt.",
        decisionLayerSizes: "Layer sizes", decisionOmissions: "Omissions",
        decisionLearningGovernance: "Learning and Snapshots", decisionConsolidate: "Consolidate", decisionPublish: "Publish", decisionReject: "Reject", decisionRollback: "Rollback",
        decisionCurrentSnapshot: "Current Snapshot", decisionNoCurrentSnapshot: "No current published Snapshot.",
        decisionLearningRuns: "Learning Runs", decisionNoLearningRuns: "No Learning Runs recorded.", decisionSnapshots: "Snapshots", decisionNoSnapshots: "No Snapshots recorded.",
        decisionLearningDetail: "Learning Run detail (read-only)", decisionNoLearningDetail: "Select a Learning Run or Snapshot to inspect its read-only details.",
        decisionFrozenInput: "Frozen input summary", decisionStructuralReplay: "Structural replay", decisionStructuralReplayHint: "Structural checks only; reviewing and publishing remain manual.",
        decisionReplayPassed: "Structural replay passed", decisionReplayFailed: "Structural replay failed", decisionReplayPending: "No structural replay result is recorded.",
        decisionOperations: "Candidate operations", decisionNoOperations: "No candidate operations recorded.", decisionPrincipleDiff: "Principle diff",
        decisionDiffAdded: "added", decisionDiffChanged: "changed", decisionDiffRemoved: "removed", decisionBefore: "Before", decisionAfter: "After",
        decisionNoPrincipleChanges: "No principle changes.", decisionNoSnapshotForRun: "No Snapshot was created by this Learning Run.",
        decisionSnapshotPin: "Snapshot pinned at Attempt start (historical, read-only)", decisionNoSnapshotPin: "No Snapshot was pinned for this Attempt.",
        decisionReviewedPrinciples: "Reviewed L2 principles (non-authoritative; L5 evidence remains authoritative)", decisionL5Mappings: "Actual L5 source mappings",
        decisionExclusions: "L2 exclusions", decisionNoExclusions: "No L2 exclusions recorded.",
        decisionLearningOutcome_running: "Running", decisionLearningOutcome_candidate: "Candidate", decisionLearningOutcome_published: "Published",
        decisionLearningOutcome_rejected: "Rejected", decisionLearningOutcome_rolled_back: "Rolled back", decisionLearningOutcome_failed: "Failed",
        decisionSnapshotState_draft: "Draft", decisionSnapshotState_published: "Published", decisionSnapshotState_rolled_back: "Rolled back",
      },
      zh: {
        decisionSelector: "决策 Agent", decisionOff: "关闭", decisionAgents: "Agent 档案", decisionRecords: "决策记录",
        decisionInbox: "待办收件箱", decisionMetrics: "指标", decisionLoading: "正在加载决策…", decisionFailed: "决策操作失败，可重试。",
        decisionEvidence: "证据", decisionSuggestions: "暂定建议", decisionPerQuestion: "逐题结论", decisionRevision: "记录版本", decisionHistory: "打开记录", decisionNoRecord: "暂无决策记录。",
        decisionUp: "赞", decisionDown: "踩", decisionUndo: "撤销评分", decisionComment: "评论", decisionCorrect: "纠正",
        decisionDecide: "裁决", decisionReassign: "改派", decisionCancel: "取消", decisionRetry: "重试", decisionSave: "保存",
        decisionContextPack: "上下文包", decisionL2Memory: "L2 语义记忆", decisionMemoryEmpty: "空",
        decisionNeutralEpisodes: "L3 中性情节（非权威上下文，不是证据）", decisionNoMemory: "此 Attempt 未记录 L2/L3 记忆使用。",
        decisionLayerSizes: "层大小", decisionOmissions: "省略项",
        decisionLearningGovernance: "学习与 Snapshot", decisionConsolidate: "手动整合", decisionPublish: "发布", decisionReject: "拒绝", decisionRollback: "回滚",
        decisionCurrentSnapshot: "当前 Snapshot", decisionNoCurrentSnapshot: "当前没有已发布的 Snapshot。",
        decisionLearningRuns: "Learning Run", decisionNoLearningRuns: "暂无 Learning Run。", decisionSnapshots: "Snapshot", decisionNoSnapshots: "暂无 Snapshot。",
        decisionLearningDetail: "Learning Run 详情（只读）", decisionNoLearningDetail: "选择 Learning Run 或 Snapshot 以查看只读详情。",
        decisionFrozenInput: "冻结输入摘要", decisionStructuralReplay: "结构重放", decisionStructuralReplayHint: "仅表示结构校验；审阅与发布仍由用户手动完成。",
        decisionReplayPassed: "结构重放通过", decisionReplayFailed: "结构重放失败", decisionReplayPending: "暂无结构重放结果。",
        decisionOperations: "候选操作", decisionNoOperations: "暂无候选操作。", decisionPrincipleDiff: "原则差异",
        decisionDiffAdded: "新增", decisionDiffChanged: "变更", decisionDiffRemoved: "移除", decisionBefore: "变更前", decisionAfter: "变更后",
        decisionNoPrincipleChanges: "原则没有变化。", decisionNoSnapshotForRun: "此 Learning Run 未创建 Snapshot。",
        decisionSnapshotPin: "Attempt 开始时固定的 Snapshot（历史只读）", decisionNoSnapshotPin: "此 Attempt 未固定 Snapshot。",
        decisionReviewedPrinciples: "经审阅的 L2 原则（非权威；L5 证据仍为权威来源）", decisionL5Mappings: "实际 L5 来源映射",
        decisionExclusions: "L2 排除项", decisionNoExclusions: "暂无 L2 排除项。",
        decisionLearningOutcome_running: "运行中", decisionLearningOutcome_candidate: "待审候选", decisionLearningOutcome_published: "已发布",
        decisionLearningOutcome_rejected: "已拒绝", decisionLearningOutcome_rolled_back: "已回滚", decisionLearningOutcome_failed: "失败",
        decisionSnapshotState_draft: "草稿", decisionSnapshotState_published: "已发布", decisionSnapshotState_rolled_back: "已回滚",
      },
    };

    exports.dictionaries = dictionaries;
    exports.narrowRecords = narrowRecords;
    exports.narrowInbox = narrowInbox;
    exports.selectorOptions = selectorOptions;
    exports.cardView = cardView;
    exports.pageView = pageView;
    exports.decisionRpc = decisionRpc;
    return module.exports;
  },
});
