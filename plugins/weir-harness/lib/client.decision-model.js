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
    const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;

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

    const REASON_KEYS = {
      no_route: "decisionReasonNoRoute",
      route_ambiguous: "decisionReasonRouteAmbiguous",
      exhausted: "decisionReasonExhausted",
      evidence: "decisionReasonEvidence",
      authority: "decisionReasonAuthority",
      partial_batch: "decisionReasonPartialBatch",
      interrupted: "decisionReasonInterrupted",
      consult_escalate: "decisionReasonConsultEscalate",
      INVALID_PREMISE: "decisionReasonInvalidPremise",
      MISSING_CONTEXT: "decisionReasonMissingContext",
      OUT_OF_SCOPE: "decisionReasonOutOfScope",
      CONFLICTING_EVIDENCE: "decisionReasonConflictingEvidence",
      STALE_EVIDENCE: "decisionReasonStaleEvidence",
      UNSUPPORTED_OPTIONS: "decisionReasonUnsupportedOptions",
    };

    function reasonKey(value) {
      if (typeof value !== "string" || !value) return null;
      return REASON_KEYS[value] ?? "decisionReasonUnknown";
    }

    function errorKey(error) {
      const code = text(error?.code);
      if (["FORBIDDEN", "PERMISSION_DENIED", "UNAUTHORIZED", "WORKSPACE_MISMATCH", "ROOT_SESSION_MISMATCH"].includes(code)) return "decisionNoPermission";
      if (["REVISION_CONFLICT", "STALE_LEARNING_RUN", "STALE_SOURCE", "SNAPSHOT_STATE_CONFLICT"].includes(code)) return "decisionErrorConflict";
      if (["OFF", "DECISION_OFF", "AGENT_UNAVAILABLE", "LEARNING_RUN_ACTIVE"].includes(code)) return "decisionErrorUnavailable";
      return "decisionFailed";
    }

    function statusProjection(current) {
      if (current.state === "closed") {
        if (current.closing === "answered" || current.closing === "escalated") return { variant: "answered", statusKey: "decisionStatusAnswered" };
        if (current.closing === "returned") return { variant: "needs_more", statusKey: "decisionStatusReturned" };
        if (current.closing === "cancelled") return { variant: "cancelled", statusKey: "decisionStatusCancelled" };
      }
      if (current.state === "awaiting_user") {
        return current.awaitingReason === "exhausted"
          ? { variant: "failed", statusKey: "decisionStatusFailed" }
          : { variant: "pending", statusKey: "decisionStatusAwaitingUser" };
      }
      if (current.state === "awaiting_revision") return { variant: "needs_more", statusKey: "decisionStatusAwaitingRevision" };
      if (current.state === "evaluating") return { variant: "pending", statusKey: "decisionStatusEvaluating" };
      if (current.state === "received") return { variant: "pending", statusKey: "decisionStatusReceived" };
      return { variant: "unknown", statusKey: "decisionStatusUnknown" };
    }

    function questionSummary(current) {
      return array(current?.request?.questions).map(question => text(question?.question)).filter(Boolean).join(" / ");
    }

    function answerSummary(decision) {
      return array(decision?.answers).map(answer => {
        const selected = array(answer?.selected).filter(value => typeof value === "string");
        const custom = text(answer?.custom);
        return [...selected, ...(custom ? [custom] : [])].join(", ");
      }).filter(Boolean).join("; ");
    }

    function recordSummary(current, agents = [], locale = "en") {
      if (!current || typeof current !== "object" || typeof current.caseId !== "string") return null;
      const agent = array(agents).find(item => item?.agentId === current.agentId);
      const dictionary = locale === "zh" ? dictionaries.zh : dictionaries.en;
      const status = statusProjection(current);
      return {
        caseId: current.caseId,
        title: questionSummary(current) || dictionary.decisionRecord,
        answerSummary: answerSummary(current.decision),
        agentId: text(current.agentId),
        agentName: text(agent?.name, dictionary.decisionSelector),
        variant: status.variant,
        statusKey: status.statusKey,
        reasonKey: reasonKey(current.awaitingReason ?? current.decision?.code),
        time: text(current.createdAt, text(current.updatedAt, text(current.closedAt))),
        feedbackState: current.feedbackState,
      };
    }

    function cardView(detail, agents = []) {
      if (!detail || typeof detail !== "object" || !detail.case || typeof detail.case.caseId !== "string") return null;
      const current = detail.case;
      const agent = array(agents).find(item => item.agentId === current.agentId);
      const attempts = array(detail.attempts);
      const currentAttempt = (typeof current.decision?.attemptId === "string"
        ? attempts.find(attempt => attempt?.attemptId === current.decision.attemptId)
        : null) ?? attempts.at(-1) ?? null;
      const evidence = array(currentAttempt?.evidence);
      const history = attempts.map(attempt => ({ attempt, claims: array(attempt?.claims), evidence: array(attempt?.evidence) }));
      const decision = current.decision;
      const rationale = text(array(currentAttempt?.claims)[0]?.text);
      const summary = text(current.escalation?.missing?.[0], text(decision?.hint, rationale));
      const status = statusProjection(current);
      return {
        caseId: current.caseId,
        agentId: text(current.agentId),
        agentName: text(agent?.name, "Decision assistant"),
        state: current.state,
        closing: current.closing,
        outcome: current.closing ?? current.state,
        variant: status.variant,
        statusKey: status.statusKey,
        reasonKey: reasonKey(current.awaitingReason ?? decision?.code ?? currentAttempt?.reasonCode),
        questionSummary: questionSummary(current),
        answerSummary: answerSummary(decision),
        summary,
        evidence,
        currentAttempt,
        history,
        revision: Number.isInteger(current.revision) ? current.revision : 0,
        recordLink: `weir-decisions:${current.caseId}`,
        feedbackState: current.feedbackState,
        needsReview: current.needsReview === true,
        escalation: current.escalation ?? null,
        answers: array(decision?.answers),
      };
    }

    function selectorView(input = {}) {
      const value = object(input) ?? {};
      const phase = ["loading", "saving", "error", "ready"].includes(value.phase) ? value.phase : "loading";
      const agents = array(value.agents);
      const selector = object(value.selector);
      const selected = phase !== "loading" && selector?.mode === "agent" && typeof selector.agentId === "string"
        ? selector.agentId
        : phase !== "loading" && selector?.mode === "off" ? "off" : null;
      const selectedAgent = selected && selected !== "off" ? agents.find(agent => agent?.agentId === selected) ?? null : null;
      const unavailable = selected !== null && selected !== "off" && selectedAgent?.state !== "enabled";
      const options = phase === "loading" || (phase === "error" && !selector) ? [] : selectorOptions({ agents });
      const triggerKey = phase === "loading" ? "decisionLoadingShort"
        : phase === "saving" ? "decisionSaving"
        : selected === "off" ? "decisionOff"
        : selected === null ? "decisionSelector" : null;
      return {
        phase,
        globalOff: value.status?.enabled === false,
        selected,
        selectedName: text(selectedAgent?.name) || null,
        unavailable,
        unavailableKey: unavailable ? "decisionSelectionUnavailable" : null,
        options,
        triggerKey,
        emptyKey: phase === "ready" && options.length === 1 ? "decisionNoAgents" : null,
        error: value.error ?? null,
        errorKey: value.error ? errorKey(value.error) : null,
      };
    }

    function pageView(input = {}) {
      const tab = ["agents", "records", "inbox", "metrics"].includes(input.tab) ? input.tab : "inbox";
      return {
        tab,
        tabs: ["inbox", "records", "agents"],
        advancedViews: ["metrics"],
        agents: array(input.agents), records: array(input.records), inbox: array(input.inbox),
        metrics: input.metrics && typeof input.metrics === "object" ? input.metrics : null,
      };
    }

    function appendRecordPage(existing, page) {
      const next = narrowRecords(page);
      const records = [...array(existing)];
      const seen = new Set(records.map(record => record?.caseId).filter(caseId => typeof caseId === "string"));
      for (const record of next.records) {
        const caseId = record?.caseId;
        if (typeof caseId === "string") {
          if (seen.has(caseId)) continue;
          seen.add(caseId);
        }
        records.push(record);
      }
      return { records, nextCursor: next.nextCursor };
    }

    function recordEmptyState(input = {}) {
      if (!input.sessionId) return "decisionNoSession";
      if (input.loading) return "decisionLoading";
      if (input.permissionDenied || (input.error && errorKey(input.error) === "decisionNoPermission")) return "decisionNoPermission";
      if (input.error) return "decisionReadFailed";
      if (input.cleaned) return "decisionRecordsCleaned";
      if (input.filtered) return "decisionNoFilteredRecords";
      return "decisionNoRecord";
    }

    function feedbackActions(state) {
      if (state === "none") return [
        { verb: "rating_up", labelKey: "decisionUp" },
        { verb: "rating_down", labelKey: "decisionDown" },
      ];
      if (state === "validated") return [{ verb: "undo_rating_up", labelKey: "decisionUndoUp" }];
      if (state === "disputed") return [{ verb: "undo_rating_down", labelKey: "decisionUndoDown" }];
      return [];
    }

    const DRAFT_FIELDS = ["answers", "comment", "correction", "reassignTarget"];
    const emptyDraft = () => ({ answers: {}, comment: "", correction: "", reassignTarget: "" });

    function readDraft(drafts, sessionId, caseId) {
      const stored = object(drafts)?.[sessionId]?.[caseId];
      return { ...emptyDraft(), ...(object(stored) ?? {}) };
    }

    function draftsReducer(drafts, action = {}) {
      const state = object(drafts) ?? {};
      if (action.type !== "update" && action.type !== "clear") return state;
      const sessionId = text(action.sessionId);
      const caseId = text(action.caseId);
      if (!sessionId || !caseId) throw new Error("draft sessionId and caseId are required");
      const fields = action.type === "update" ? [action.field] : action.fields === undefined ? DRAFT_FIELDS : array(action.fields);
      for (const field of fields) if (!DRAFT_FIELDS.includes(field)) throw new Error(`Unknown draft field: ${field}`);
      const current = readDraft(state, sessionId, caseId);
      const next = action.type === "update" ? { ...current, [action.field]: action.value } : { ...current };
      if (action.type === "clear") {
        const empty = emptyDraft();
        for (const field of fields) next[field] = empty[field];
      }
      return { ...state, [sessionId]: { ...state[sessionId], [caseId]: next } };
    }

    function candidateReadiness({ agent, detail, error } = {}) {
      const failure = reason => ({ ready: false, reason });
      if (error) return failure("error");
      const candidateRun = array(agent?.learningRuns).find(run => run?.outcome === "candidate" && typeof run.learningRunId === "string");
      const candidate = candidateRun ? array(agent?.snapshots).find(snapshot => snapshot?.state === "draft" && snapshot.learningRunId === candidateRun.learningRunId) : null;
      if (!candidateRun || !candidate) return failure("candidate");
      if (!detail) return failure("loading");
      const run = object(detail.run);
      const snapshot = object(detail.snapshot);
      if (detail.agentId !== agent.agentId || !run || !snapshot) return failure("mismatch");
      if (run.learningRunId !== candidateRun.learningRunId || run.agentId !== agent.agentId || run.outcome !== "candidate") return failure("mismatch");
      if (snapshot.snapshotId !== candidate.snapshotId || snapshot.agentId !== agent.agentId || snapshot.learningRunId !== candidateRun.learningRunId || snapshot.state !== "draft") return failure("mismatch");
      if (!Number.isInteger(snapshot.revision)) return failure("revision");
      if (!Array.isArray(run.operations) || !Array.isArray(snapshot.principles)) return failure("diff");
      const frozen = object(run.inputFrozen);
      if (!frozen || (frozen.parentSnapshotId !== null && typeof frozen.parentSnapshotId !== "string")) return failure("input");
      const summaryParentId = candidate.parentSnapshotId ?? null;
      const parentId = snapshot.parentSnapshotId === undefined ? summaryParentId : snapshot.parentSnapshotId;
      if (frozen.parentSnapshotId !== parentId || summaryParentId !== parentId || (agent.currentSnapshotId ?? null) !== parentId) return failure("mismatch");
      if (parentId !== null) {
        const parent = object(detail.parentSnapshot);
        if (!parent) return failure("parent");
        if (parent.snapshotId !== parentId || parent.state !== "published" || !Number.isInteger(parent.revision) || !Array.isArray(parent.principles)) return failure("parent");
        if (frozen.parentSnapshotRevision !== undefined && frozen.parentSnapshotRevision !== parent.revision) return failure("parent");
      } else if (detail.parentSnapshot) return failure("mismatch");
      return { ready: true, reason: null, snapshotId: snapshot.snapshotId, expectedRevision: snapshot.revision, changeCount: run.operations.length };
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
        decisionSelector: "Decision assistant", decisionOff: "Off", decisionAgents: "Assistants", decisionRecords: "Decision records",
        decisionInbox: "Needs your decision", decisionMetrics: "Metrics", decisionLoading: "Loading decisions…", decisionLoadingShort: "Loading…", decisionSaving: "Saving…", decisionFailed: "Decision action failed; retry is available.",
        decisionEvidence: "Rationale", decisionSuggestions: "Suggestions", decisionPerQuestion: "Per-question conclusions", decisionRevision: "Revision", decisionHistory: "Open record", decisionNoRecord: "No decision records.",
        decisionRecord: "Decision record", decisionNoSession: "Open a session to view decision records.", decisionReadFailed: "Decision records could not be loaded. Retry the read.",
        decisionNoPermission: "You do not have permission to read these decision records.", decisionRecordsCleaned: "Decision records were cleaned up.", decisionNoFilteredRecords: "No decision records match these filters.", decisionNoAgents: "No assistants yet. Create an assistant to get started.",
        decisionUp: "Confirm", decisionDown: "Dispute", decisionUndo: "Undo rating", decisionUndoUp: "Undo confirmation", decisionUndoDown: "Undo dispute", decisionComment: "Note", decisionCorrect: "Correction",
        decisionDecide: "Submit decision", decisionReassign: "Reassign", decisionCancel: "Cancel", decisionRetry: "Retry", decisionSave: "Save", decisionUseSuggestions: "Use suggestions", decisionAnswersIncomplete: "Answer every question before submitting.",
        decisionSelectTitle: "Choose a decision assistant", decisionSelectorSafety: "Only this session; approvals and high-risk actions still ask you.", decisionManageAgents: "Manage assistants", decisionCreateAgent: "New assistant",
        decisionGlobalOff: "Decision assistants are off globally.", decisionGlobalOffHint: "No automatic decisions are made. Enable them in Settings → Weir → Decision assistants.",
        decisionAdvancedDiagnostics: "Advanced diagnostics", decisionStructuralQualityWarning: "Structural validation does not guarantee content quality.", decisionRateNotQuality: "Automatic answer rate is not a quality metric.", decisionHistoricalNotEvidence: "Historical context is not evidence for a decision.",
        decisionSelectionUnavailable: "The current selection is unavailable.", decisionErrorConflict: "The record changed. Reload the latest version before retrying.", decisionErrorUnavailable: "The selected assistant is unavailable. Choose another assistant or Off.",
        decisionStatusAnswered: "Answered", decisionStatusAwaitingUser: "Needs your decision", decisionStatusAwaitingRevision: "Needs revised input", decisionStatusEvaluating: "Evaluating", decisionStatusReceived: "Received",
        decisionStatusReturned: "Needs more information", decisionStatusCancelled: "Cancelled", decisionStatusFailed: "Needs attention", decisionStatusUnknown: "Status unavailable",
        decisionReasonNoRoute: "The selected assistant is unavailable.", decisionReasonRouteAmbiguous: "Choose an assistant for this decision.", decisionReasonExhausted: "The assistant could not complete this decision.", decisionReasonEvidence: "More verifiable evidence is needed.",
        decisionReasonAuthority: "This decision requires your input.", decisionReasonPartialBatch: "At least one question still needs your decision.", decisionReasonInterrupted: "The previous evaluation was interrupted.", decisionReasonConsultEscalate: "The assistant returned this decision to you.",
        decisionReasonInvalidPremise: "The question premise needs correction.", decisionReasonMissingContext: "More context is needed.", decisionReasonOutOfScope: "This question is outside the assistant’s scope.", decisionReasonConflictingEvidence: "The available evidence conflicts.",
        decisionReasonStaleEvidence: "The supporting evidence is stale.", decisionReasonUnsupportedOptions: "The available options need revision.", decisionReasonUnknown: "Review the advanced diagnostics for the recorded reason.",
        decisionContextPack: "Context Pack", decisionL2Memory: "L2 semantic memory", decisionMemoryEmpty: "empty",
        decisionNeutralEpisodes: "L3 neutral episodes (non-authoritative context, not evidence)", decisionNoMemory: "No L2/L3 memory use is recorded for this Attempt.",
        decisionLayerSizes: "Layer sizes", decisionOmissions: "Omissions",
        decisionLearningGovernance: "Principle review", decisionConsolidate: "Review new principles", decisionPublish: "Apply changes", decisionReject: "Discard candidate", decisionRollback: "Restore previous version",
        decisionCurrentSnapshot: "Current principle version", decisionNoCurrentSnapshot: "No current published principle version.",
        decisionLearningRuns: "Learning Runs", decisionNoLearningRuns: "No Learning Runs recorded.", decisionSnapshots: "Snapshots", decisionNoSnapshots: "No Snapshots recorded.",
        decisionLearningDetail: "Learning Run detail (read-only)", decisionNoLearningDetail: "Select a Learning Run or Snapshot to inspect its read-only details.",
        decisionFrozenInput: "Frozen input summary", decisionStructuralReplay: "Structural replay", decisionStructuralReplayHint: "Structural checks only; reviewing and publishing remain manual.",
        decisionReplayPassed: "Structural replay passed", decisionReplayFailed: "Structural replay failed", decisionReplayPending: "No structural replay result is recorded.",
        decisionOperations: "Candidate operations", decisionNoOperations: "No candidate operations recorded.", decisionPrincipleDiff: "Principle diff",
        decisionSourceRecords: "Source records (read-only)", decisionCorrectionDirection: "Correction direction",
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
        decisionSelector: "决策助手", decisionOff: "关闭", decisionAgents: "助手管理", decisionRecords: "判断记录",
        decisionInbox: "待你决定", decisionMetrics: "指标", decisionLoading: "正在加载判断记录…", decisionLoadingShort: "读取中…", decisionSaving: "保存中…", decisionFailed: "决策操作失败，可重试。",
        decisionEvidence: "判断依据", decisionSuggestions: "暂定建议", decisionPerQuestion: "逐题结论", decisionRevision: "记录版本", decisionHistory: "打开记录", decisionNoRecord: "暂无判断记录。",
        decisionRecord: "判断记录", decisionNoSession: "打开会话后可查看判断记录。", decisionReadFailed: "判断记录读取失败，请重试。",
        decisionNoPermission: "你没有读取这些判断记录的权限。", decisionRecordsCleaned: "判断记录已清理。", decisionNoFilteredRecords: "没有符合筛选条件的判断记录。", decisionNoAgents: "暂无助手，请先新建助手。",
        decisionUp: "认可", decisionDown: "不认可", decisionUndo: "撤销评分", decisionUndoUp: "撤销认可", decisionUndoDown: "撤销不认可", decisionComment: "备注", decisionCorrect: "纠正",
        decisionDecide: "提交决定", decisionReassign: "改派", decisionCancel: "取消", decisionRetry: "重试", decisionSave: "保存", decisionUseSuggestions: "使用建议", decisionAnswersIncomplete: "请回答全部问题后再提交。",
        decisionSelectTitle: "选择决策助手", decisionSelectorSafety: "仅当前会话；审批和高风险操作仍会询问你。", decisionManageAgents: "管理助手", decisionCreateAgent: "新建助手",
        decisionGlobalOff: "决策助手已在全局关闭。", decisionGlobalOffHint: "当前不会自动决策。可在“设置 → Weir → 决策助手”中开启。",
        decisionAdvancedDiagnostics: "高级诊断", decisionStructuralQualityWarning: "结构校验通过不代表内容质量。", decisionRateNotQuality: "自动回答率不是质量指标。", decisionHistoricalNotEvidence: "历史参考不是判断依据。",
        decisionSelectionUnavailable: "当前选择的助手不可用。", decisionErrorConflict: "记录已变化，请先读取最新版本再重试。", decisionErrorUnavailable: "当前助手不可用，请选择其他助手或关闭。",
        decisionStatusAnswered: "已回答", decisionStatusAwaitingUser: "待你决定", decisionStatusAwaitingRevision: "等待补充", decisionStatusEvaluating: "正在判断", decisionStatusReceived: "已收到",
        decisionStatusReturned: "需补充", decisionStatusCancelled: "已取消", decisionStatusFailed: "需要处理", decisionStatusUnknown: "状态未知",
        decisionReasonNoRoute: "当前选择的助手不可用。", decisionReasonRouteAmbiguous: "请为此判断选择助手。", decisionReasonExhausted: "助手未能完成这次判断。", decisionReasonEvidence: "需要更多可核验依据。",
        decisionReasonAuthority: "这次判断需要由你决定。", decisionReasonPartialBatch: "至少有一道题仍待你决定。", decisionReasonInterrupted: "上一次处理已中断。", decisionReasonConsultEscalate: "助手已将这次判断交给你。",
        decisionReasonInvalidPremise: "问题前提需要纠正。", decisionReasonMissingContext: "需要更多上下文。", decisionReasonOutOfScope: "此问题超出助手的适用范围。", decisionReasonConflictingEvidence: "现有依据相互冲突。",
        decisionReasonStaleEvidence: "支持结论的依据已过期。", decisionReasonUnsupportedOptions: "现有选项需要修订。", decisionReasonUnknown: "请在高级诊断中查看记录的原因。",
        decisionContextPack: "上下文包", decisionL2Memory: "L2 语义记忆", decisionMemoryEmpty: "空",
        decisionNeutralEpisodes: "L3 中性情节（非权威上下文，不是证据）", decisionNoMemory: "此 Attempt 未记录 L2/L3 记忆使用。",
        decisionLayerSizes: "层大小", decisionOmissions: "省略项",
        decisionLearningGovernance: "原则审阅", decisionConsolidate: "整理新原则", decisionPublish: "采用变化", decisionReject: "放弃候选", decisionRollback: "恢复前序版本",
        decisionCurrentSnapshot: "当前原则版本", decisionNoCurrentSnapshot: "当前没有已发布的原则版本。",
        decisionLearningRuns: "Learning Run", decisionNoLearningRuns: "暂无 Learning Run。", decisionSnapshots: "Snapshot", decisionNoSnapshots: "暂无 Snapshot。",
        decisionLearningDetail: "Learning Run 详情（只读）", decisionNoLearningDetail: "选择 Learning Run 或 Snapshot 以查看只读详情。",
        decisionFrozenInput: "冻结输入摘要", decisionStructuralReplay: "结构重放", decisionStructuralReplayHint: "仅表示结构校验；审阅与发布仍由用户手动完成。",
        decisionReplayPassed: "结构重放通过", decisionReplayFailed: "结构重放失败", decisionReplayPending: "暂无结构重放结果。",
        decisionOperations: "候选操作", decisionNoOperations: "暂无候选操作。", decisionPrincipleDiff: "原则差异",
        decisionSourceRecords: "源记录（只读）", decisionCorrectionDirection: "纠正方向",
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
    exports.selectorView = selectorView;
    exports.cardView = cardView;
    exports.recordSummary = recordSummary;
    exports.appendRecordPage = appendRecordPage;
    exports.recordEmptyState = recordEmptyState;
    exports.feedbackActions = feedbackActions;
    exports.draftsReducer = draftsReducer;
    exports.readDraft = readDraft;
    exports.candidateReadiness = candidateReadiness;
    exports.pageView = pageView;
    exports.decisionRpc = decisionRpc;
    return module.exports;
  },
});
