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
    function narrowRoutingReview(payload) {
      const value = okValue(payload);
      return {
        window: ["24h", "7d", "30d", "all"].includes(value?.window) ? value.window : "all",
        summary: object(value?.summary) ?? {}, items: array(value?.items),
        nextCursor: typeof value?.nextCursor === "string" ? value.nextCursor : null,
      };
    }
    function narrowInbox(payload) { return array(okValue(payload)); }

    function selectorOptions(payload) {
      const value = okValue(payload) ?? payload;
      const agents = array(value?.agents).filter(agent => agent && agent.state === "enabled" && typeof agent.agentId === "string");
      const autoValue = object(value?.auto);
      const known = autoValue !== null && Array.isArray(autoValue.answerClasses) && typeof autoValue.shadow === "boolean";
      const answerClasses = known ? [...new Set(autoValue.answerClasses.filter(item => ["A", "B", "C"].includes(item)))] : [];
      const auto = { known, answerClasses, shadow: known ? autoValue.shadow : false, ready: known && answerClasses.length > 0 };
      return [
        { value: "off", mode: "off", label: "Off" },
        {
          value: "auto", mode: "auto", label: "Auto", auto,
          descriptionKey: !known ? "decisionAutoReadinessUnknown" : auto.ready ? "decisionAutoWhitelist" : "decisionAutoEmptyWhitelist",
          shadowKey: auto.shadow ? "decisionAutoShadowOn" : "decisionAutoShadowOff",
        },
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
      if (["REVISION_CONFLICT", "STALE_LEARNING_RUN", "STALE_SOURCE", "STALE_PARENT_SNAPSHOT", "SNAPSHOT_STATE_CONFLICT"].includes(code)) return "decisionErrorConflict";
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

    function translator(locale) {
      if (typeof locale === "function") return locale;
      const normalized = typeof locale === "string" ? locale.toLowerCase() : "en";
      const dictionary = normalized === "zh" || normalized.startsWith("zh-") ? dictionaries.zh : dictionaries.en;
      return key => dictionary[key] ?? dictionaries.en[key] ?? key;
    }

    function recordSummary(current, agents = [], locale = "en") {
      if (!current || typeof current !== "object" || typeof current.caseId !== "string") return null;
      const agent = array(agents).find(item => item?.agentId === current.agentId);
      const t = translator(locale);
      const status = statusProjection(current);
      return {
        caseId: current.caseId,
        title: questionSummary(current) || t("decisionRecord"),
        answerSummary: answerSummary(current.decision),
        agentId: text(current.agentId),
        agentName: text(agent?.name, t("decisionSelector")),
        variant: status.variant,
        statusKey: status.statusKey,
        reasonKey: reasonKey(current.awaitingReason ?? current.decision?.code),
        time: text(current.createdAt, text(current.updatedAt, text(current.closedAt))),
        feedbackState: current.feedbackState,
      };
    }

    function cardView(detail, agents = [], locale = "en") {
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
        agentName: text(agent?.name, translator(locale)("decisionSelector")),
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

    function memoryView(attempt) {
      const memory = object(attempt?.packManifest)?.memory;
      const l2 = object(memory?.L2);
      const l3 = object(memory?.L3);
      const items = array(l2?.items).filter(item => typeof item?.principleId === "string");
      const principleIds = array(l2?.principleIds).filter(value => typeof value === "string");
      const l2Count = new Set([...principleIds, ...items.map(item => item.principleId)]).size;
      const pins = object(attempt?.pins);
      const pinned = Boolean(l2?.snapshotId ?? l2?.snapshotRevision ?? l2?.snapshotHash ?? pins?.memorySnapshotId ?? pins?.memorySnapshotRevision ?? pins?.memorySnapshotHash);
      const sourceCaseIds = array(l3?.sourceCaseIds).filter(value => typeof value === "string");
      return {
        l2: !l2 ? "legacy" : l2Count ? "used" : pinned ? "pinned-empty" : "empty", l2Count,
        l3: !l3 ? "legacy" : sourceCaseIds.length ? "used" : "empty", l3Count: sourceCaseIds.length,
      };
    }

    const METRIC_LABELS = {
      casesOpened: "decisionMetricCasesOpened", attemptsTotal: "decisionMetricAttemptsTotal", autoAnswered: "decisionMetricAutoAnswered",
      autoAnswerRate: "decisionMetricAutoAnswerRate", escalated: "decisionMetricEscalated", exhausted: "decisionMetricExhausted",
      cancelled: "decisionMetricCancelled", interrupted: "decisionMetricInterrupted", corrections: "decisionMetricCorrections",
      reassignments: "decisionMetricReassignments", feedbackParticipation: "decisionMetricFeedbackParticipation",
      selectorOffBypasses: "decisionMetricSelectorOffBypasses", meanAttemptLatencyMs: "decisionMetricMeanLatency",
    };
    function metricDisplay(key, value) {
      if (key === "autoAnswerRate" && Number.isFinite(value)) return `${Math.round(value * 1000) / 10}%`;
      if (key === "meanAttemptLatencyMs" && Number.isFinite(value)) return value < 1000 ? `${Math.round(value)} ms` : `${Math.round(value / 100) / 10} s`;
      return value === null || value === undefined ? "—" : String(value);
    }
    function metricRow(key, value, labelKey = METRIC_LABELS[key] ?? null) {
      return { key, labelKey, ...(labelKey ? {} : { label: key }), value, display: metricDisplay(key, value) };
    }
    function metricsView(metrics) {
      const value = object(metrics);
      if (!value) return { window: null, since: null, sections: [], raw: null };
      const activity = Object.keys(METRIC_LABELS).filter(key => value[key] !== undefined).map(key => metricRow(key, value[key]));
      const returned = Object.entries(object(value.returnedByCode) ?? {}).map(([code, count]) => metricRow(`returnedByCode.${code}`, count, reasonKey(code)));
      const evidenceLabels = { stale: "decisionMetricEvidenceStale", conflicting: "decisionMetricEvidenceConflicting", deleted: "decisionMetricEvidenceDeleted" };
      const evidence = Object.entries(object(value.evidenceFailures) ?? {}).map(([key, count]) => metricRow(`evidenceFailures.${key}`, count, evidenceLabels[key] ?? null));
      const ratingLabels = { up: "decisionMetricRatingsUp", down: "decisionMetricRatingsDown", undone: "decisionMetricRatingsUndone" };
      const ratings = Object.entries(object(value.ratings) ?? {}).map(([key, count]) => metricRow(`ratings.${key}`, count, ratingLabels[key] ?? null));
      return {
        window: text(value.window) || null, since: value.since ?? null,
        sections: [
          { key: "activity", labelKey: "decisionMetricActivity", rows: activity },
          { key: "returns", labelKey: "decisionMetricReturns", rows: returned },
          { key: "evidence", labelKey: "decisionMetricEvidenceFailures", rows: evidence },
          { key: "feedback", labelKey: "decisionMetricFeedback", rows: ratings },
        ].filter(section => section.rows.length), raw: metrics,
      };
    }

    function selectorView(input = {}) {
      const value = object(input) ?? {};
      const phase = ["loading", "saving", "error", "ready"].includes(value.phase) ? value.phase : "loading";
      const agents = array(value.agents);
      const selector = object(value.selector);
      const selected = phase !== "loading" && selector?.mode === "agent" && typeof selector.agentId === "string"
        ? selector.agentId
        : phase !== "loading" && selector?.mode === "auto" ? "auto"
          : phase !== "loading" && selector?.mode === "off" ? "off" : null;
      const selectedAgent = selected && selected !== "off" && selected !== "auto" ? agents.find(agent => agent?.agentId === selected) ?? null : null;
      const unavailable = selected !== null && selected !== "off" && selected !== "auto" && selectedAgent?.state !== "enabled";
      const options = phase === "loading" || (phase === "error" && !selector) ? [] : selectorOptions({ agents, auto: value.auto });
      const triggerKey = phase === "loading" ? "decisionLoadingShort"
        : phase === "saving" ? "decisionSaving"
        : selected === "off" ? "decisionOff"
        : selected === "auto" ? "decisionAuto"
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
        emptyKey: phase === "ready" && !options.some(option => option.mode === "agent") ? "decisionNoAgents" : null,
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

    const ROUTING_OUTCOME_KEYS = {
      agreement: "decisionRoutingAgreement", disagreement: "decisionRoutingDisagreement",
      shadow_none: "decisionRoutingShadowNone", shadow_ambiguous: "decisionRoutingShadowAmbiguous", shadow_failure: "decisionRoutingShadowFailure",
      auto_none: "decisionRoutingAutoNone", auto_ambiguous: "decisionRoutingAutoAmbiguous", auto_failure: "decisionRoutingAutoFailure",
      manual_reassign: "decisionRoutingManualReassign", uncomparable: "decisionRoutingUncomparable",
      baseline: "decisionRoutingBaseline", auto_selected: "decisionRoutingAutoSelected",
    };
    const ROUTING_SUMMARY_KEYS = {
      agreement: "decisionRoutingAgreement", disagreement: "decisionRoutingDisagreement",
      shadowNone: "decisionRoutingShadowNone", shadowAmbiguous: "decisionRoutingShadowAmbiguous", shadowFailure: "decisionRoutingShadowFailure",
      autoNone: "decisionRoutingAutoNone", autoAmbiguous: "decisionRoutingAutoAmbiguous", autoFailure: "decisionRoutingAutoFailure",
      manualReassign: "decisionRoutingManualReassign", uncomparable: "decisionRoutingUncomparable",
    };

    function routingReviewView(payload, locale = "en") {
      const value = object(payload);
      if (!value) return { window: null, summary: [], items: [], nextCursor: null, raw: null };
      const page = narrowRoutingReview(value);
      const t = translator(locale);
      return {
        window: page.window,
        summary: Object.entries(ROUTING_SUMMARY_KEYS).map(([key, labelKey]) => metricRow(key, Number.isFinite(page.summary[key]) ? page.summary[key] : 0, labelKey)),
        items: page.items.map(item => ({
          ...item, title: text(item?.questionSummary) || t("decisionRecord"),
          outcomeKey: ROUTING_OUTCOME_KEYS[item?.outcome] ?? "decisionRoutingUncomparable",
          recordCaseId: typeof item?.caseId === "string" && item?.record?.caseId === item.caseId ? item.caseId : null,
        })),
        nextCursor: page.nextCursor, raw: payload,
      };
    }

    function appendRoutingPage(existing, page) {
      const next = narrowRoutingReview(page);
      const items = [...array(existing)];
      const seen = new Set(items.map(item => item?.caseId).filter(caseId => typeof caseId === "string"));
      for (const item of next.items) {
        const caseId = item?.caseId;
        if (typeof caseId === "string") {
          if (seen.has(caseId)) continue;
          seen.add(caseId);
        }
        items.push(item);
      }
      return { items, nextCursor: next.nextCursor };
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
        decisionPageDescription: "Let assistants handle repeatable decisions with evidence; important authority remains with you.", decisionPrimaryNavigation: "Decision assistant tasks", decisionInboxEmpty: "Nothing needs your decision right now.", decisionSelectRecord: "Choose a decision record to read its details.", decisionNoAnswer: "No answer is recorded.", decisionReasonSummary: "Why this decision was made", decisionCurrentEvidence: "Evidence for the current evaluation", decisionNoEvidence: "No verifiable evidence is attached to the current evaluation.", decisionEvidenceUnavailable: "The evidence exists, but no readable excerpt is available.", decisionEvidenceDeleted: "This supporting material was deleted.", decisionEvidenceSuperseded: "This supporting material has been superseded.", decisionRecoveryActions: "Recovery actions", decisionChooseAssistant: "Choose an assistant", decisionViewAssistant: "View assistant",
        decisionSuggestionNotSubmitted: "Not submitted", decisionNativeAnswerHint: "Answer in the original question above; this card only explains the decision.", decisionCancelTitle: "Cancel this decision?", decisionCancelConfirmation: "The pending request will be cancelled. Its read-only history remains available.", decisionKeepEditing: "Keep editing",
        decisionRecordFilters: "Record filters", decisionFilterAgent: "Assistant", decisionFilterState: "Status", decisionFilterOutcome: "Evaluation result", decisionFilterReason: "Return reason", decisionFilterScope: "Scope contains", decisionFilterFeedback: "Feedback", decisionAllAssistants: "All assistants", decisionAllStates: "All statuses", decisionAllOutcomes: "All results", decisionAllReasons: "All reasons", decisionAllFeedback: "All feedback", decisionMoreFilters: "More filters", decisionApplyFilters: "Apply filters", decisionLoadMore: "Load more", decisionBackToRecords: "Back to decision records", decisionStatusClosed: "Closed", decisionOutcomeAnswer: "Answered by the assistant", decisionOutcomeReturn: "Returned for more input", decisionOutcomeEscalate: "Escalated to you", decisionOutcomeFailed: "Evaluation failed", decisionFeedbackNone: "No rating", decisionFeedbackValidated: "Confirmed", decisionFeedbackDisputed: "Disputed",
        decisionReviewedPrinciplesUsed: "Reviewed principles were available as non-authoritative guidance", decisionPinnedEmpty: "A principle version was pinned, but no reviewed principles were loaded.", decisionNoReviewedPrinciples: "No reviewed principles were used.", decisionHistoricalContextUsed: "Historical references were included", decisionNoHistoricalContext: "No historical references were used.", decisionLegacyMemory: "No reviewed-principle or historical-reference use was recorded for this evaluation.", decisionEvaluationNumber: "Evaluation", decisionEvaluationHistory: "Evaluation history", decisionNoEarlierEvaluations: "No earlier evaluations.", decisionFeedbackHistory: "Feedback history", decisionNoFeedback: "No feedback has been recorded.", decisionNoteNoEffect: "A note is retained with this record and does not change future decisions.", decisionAddNote: "Add note", decisionCorrectionScope: "Applies to", decisionCorrectionTarget: "Supersedes the answer to", decisionCorrectionFutureOnly: "Only future decisions are affected; the original answer remains unchanged.", decisionSubmitCorrection: "Submit correction", decisionCurrentScope: "The current record scope", decisionAuthorizationClasses: "Authorization classes",
        decisionAgentStateEnabled: "Enabled", decisionAgentStateDisabled: "Disabled", decisionAgentStateArchived: "Archived", decisionNoPreference: "No decision preference recorded.", decisionVersionUnavailable: "Version unavailable in the summary", decisionPrincipleDetailsOnOpen: "Open the assistant to review principle versions.", decisionPendingReview: "Changes await review", decisionEditAgent: "Edit assistant", decisionAgentName: "Name", decisionAgentPreference: "Decision preference (optional)", decisionAgentPreferenceHint: "Plain-language guidance for this assistant.", decisionAdvancedSettings: "Advanced settings", decisionAdvancedSettingsHint: "Scope and model routing use the existing authoritative profile format.", decisionAgentScopeJson: "Full scope (JSON)", decisionAgentModelRouteJson: "Model route (JSON)", decisionModelInheritanceHint: "A new assistant inherits the session route when no route is supplied.", decisionDisableAgent: "Disable assistant", decisionEnableAgent: "Enable assistant", decisionArchiveAgent: "Archive assistant", decisionProfileHistory: "Preference version history", decisionDiscardTitle: "Discard unsaved changes?", decisionDiscardConfirmation: "Your unsaved assistant edits will be lost.", decisionDiscard: "Discard changes", decisionArchiveTitle: "Archive this assistant?", decisionArchiveConfirmation: "The assistant can no longer receive new decisions. Existing records and history are retained.", decisionDisableTitle: "Disable this assistant?", decisionDisableConfirmation: "New decisions will not be routed to this assistant until it is enabled again.", decisionEnableTitle: "Enable this assistant?", decisionEnableConfirmation: "This assistant can receive new decisions again.",
        decisionMetricActivity: "Activity", decisionMetricReturns: "Returns by reason", decisionMetricEvidenceFailures: "Evidence issues", decisionMetricFeedback: "Feedback", decisionMetricCasesOpened: "Decisions opened", decisionMetricAttemptsTotal: "Evaluations", decisionMetricAutoAnswered: "Automatically answered", decisionMetricAutoAnswerRate: "Automatic answer rate", decisionMetricEscalated: "Decided by you", decisionMetricExhausted: "Needs attention", decisionMetricCancelled: "Cancelled", decisionMetricInterrupted: "Interrupted evaluations", decisionMetricCorrections: "Corrections", decisionMetricReassignments: "Reassignments", decisionMetricFeedbackParticipation: "Records with feedback", decisionMetricSelectorOffBypasses: "Off bypasses (not sampled)", decisionMetricMeanLatency: "Mean evaluation latency", decisionMetricEvidenceStale: "Stale evidence", decisionMetricEvidenceConflicting: "Conflicting evidence", decisionMetricEvidenceDeleted: "Deleted evidence", decisionMetricRatingsUp: "Confirmations", decisionMetricRatingsDown: "Disputes", decisionMetricRatingsUndone: "Undone ratings", decisionMetricWindow: "Window", decisionMetricWindowAll: "All time", decisionMetricWindow24h: "Last 24 hours", decisionMetricWindow7d: "Last 7 days", decisionMetricWindow30d: "Last 30 days", decisionRawMetrics: "Raw metric values",
        decisionSelector: "Decision assistant", decisionOff: "Off", decisionAgents: "Assistants", decisionRecords: "Decision records",
        decisionInbox: "Needs your decision", decisionMetrics: "Metrics", decisionLoading: "Loading decisions…", decisionLoadingShort: "Loading…", decisionSaving: "Saving…", decisionFailed: "Decision action failed; retry is available.",
        decisionEvidence: "Rationale", decisionSuggestions: "Suggestions", decisionPerQuestion: "Per-question conclusions", decisionRevision: "Revision", decisionHistory: "Open record", decisionNoRecord: "No decision records.",
        decisionRecord: "Decision record", decisionNoSession: "Open a session to view decision records.", decisionReadFailed: "Decision records could not be loaded. Retry the read.",
        decisionNoPermission: "You do not have permission to read these decision records.", decisionRecordsCleaned: "Decision records were cleaned up.", decisionNoFilteredRecords: "No decision records match these filters.", decisionNoAgents: "No assistants yet. Create an assistant to get started.",
        decisionUp: "Confirm", decisionDown: "Dispute", decisionUndo: "Undo rating", decisionUndoUp: "Undo confirmation", decisionUndoDown: "Undo dispute", decisionComment: "Note", decisionCorrect: "Correction", decisionConfirmConsequence: "Confirmation supports this answer only within its original scope.", decisionDisputeConsequence: "Dispute immediately stops this answer from being used alone for automatic answers; it does not infer the opposite answer.",
        decisionDecide: "Submit decision", decisionReassign: "Reassign", decisionCancel: "Cancel", decisionRetry: "Retry", decisionSave: "Save", decisionUseSuggestions: "Use suggestions", decisionAnswersIncomplete: "Answer every question before submitting.",
        decisionSelectTitle: "Choose a decision assistant", decisionSelectorSafety: "Only this session; approvals and high-risk actions still ask you.", decisionManageAgents: "Manage assistants", decisionCreateAgent: "New assistant",
        decisionAuto: "Auto", decisionAutoWhitelist: "Auto routes only these allowed authorization classes:", decisionAutoEmptyWhitelist: "The Auto authorization-class whitelist is empty. New Auto requests will not be answered automatically.", decisionAutoReadinessUnknown: "Auto readiness could not be verified; no automatic-answer capability is assumed.", decisionAutoShadowOn: "Shadow diagnostics are on; they never change the real route or answer.", decisionAutoShadowOff: "Shadow diagnostics are off.",
        decisionRoutingReview: "Routing review", decisionRoutingDiagnostic: "Route comparisons and counts are diagnostic only, not a quality score or automatic promotion.", decisionRoutingAgreement: "Shadow and pinned selections agree", decisionRoutingDisagreement: "Shadow and pinned selections differ", decisionRoutingShadowNone: "Shadow found no assistant", decisionRoutingShadowAmbiguous: "Shadow was ambiguous", decisionRoutingShadowFailure: "Shadow routing failed", decisionRoutingAutoNone: "Auto found no assistant", decisionRoutingAutoAmbiguous: "Auto was ambiguous", decisionRoutingAutoFailure: "Auto routing failed", decisionRoutingManualReassign: "Manually reassigned", decisionRoutingUncomparable: "Not comparable; no usable pinned baseline is recorded", decisionRoutingBaseline: "Pinned baseline for Shadow comparison", decisionRoutingAutoSelected: "Auto selected an assistant", decisionRoutingNoData: "No routing decisions in this window.", decisionRoutingOpenRecord: "Open the authorized decision record for", decisionRoutingShown: "Routing records shown",
        decisionRoutingDirection: "Reassignment direction (from → to)", decisionNoAssignedAgent: "No assistant selected",
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
        decisionLearningIdle: "No review has been run yet.", decisionLearningNoChanges: "No new principles were found in this review.", decisionLearningStartUnavailable: "This assistant is unavailable for a new principle review.", decisionLearningStartRunning: "A review is already in progress.", decisionLearningStartCandidate: "Review the pending candidate before starting another review.", decisionLearningWorking: "Another decision action is in progress.", decisionPrincipleVersion: "Version",
        decisionLearningReadFailed: "The candidate details could not be loaded. Your review is preserved; retry the read.", decisionCandidateLoading: "Loading the complete candidate…", decisionCandidateNotReady: "The candidate details are incomplete or no longer match. Reload before making changes.", decisionSourceCase: "Decision source", decisionSourceCorrection: "Correction source",
        decisionApplyTitle: "Apply these principle changes?", decisionApplyConfirmation: "The candidate will become the current reviewed principle version.", decisionApplyChangeCount: "Principle changes", decisionApplyReplaceCurrent: "Replaces", decisionApplyFutureOnly: "Only future decisions are affected; existing records and history remain unchanged.", decisionDiscardCandidateTitle: "Discard this candidate?", decisionDiscardCandidateConfirmation: "The candidate will not affect future decisions. Its review and source history remain available.", decisionRollbackTitle: "Restore a previous principle version?", decisionRollbackConfirmation: "The current version remains in read-only history. Future decisions will use the most recent earlier approved version, or no reviewed principles if none exists.",
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
        decisionPageDescription: "让助手依据证据处理重复判断；重要权限仍由你决定。", decisionPrimaryNavigation: "决策助手任务", decisionInboxEmpty: "当前没有待你决定的事项。", decisionSelectRecord: "选择一条判断记录以查看详情。", decisionNoAnswer: "暂无记录的答案。", decisionReasonSummary: "判断理由", decisionCurrentEvidence: "本次处理的判断依据", decisionNoEvidence: "本次处理没有关联的可核验依据。", decisionEvidenceUnavailable: "依据存在，但没有可阅读的摘录。", decisionEvidenceDeleted: "该支持材料已删除。", decisionEvidenceSuperseded: "该支持材料已被取代。", decisionRecoveryActions: "恢复操作", decisionChooseAssistant: "选择助手", decisionViewAssistant: "查看助手",
        decisionSuggestionNotSubmitted: "尚未提交", decisionNativeAnswerHint: "请在上方的原生问题中作答；此卡片仅说明判断情况。", decisionCancelTitle: "取消这次判断？", decisionCancelConfirmation: "待处理请求将被取消，只读历史仍会保留。", decisionKeepEditing: "继续编辑",
        decisionRecordFilters: "记录筛选", decisionFilterAgent: "助手", decisionFilterState: "状态", decisionFilterOutcome: "处理结果", decisionFilterReason: "返回原因", decisionFilterScope: "适用范围包含", decisionFilterFeedback: "反馈", decisionAllAssistants: "全部助手", decisionAllStates: "全部状态", decisionAllOutcomes: "全部结果", decisionAllReasons: "全部原因", decisionAllFeedback: "全部反馈", decisionMoreFilters: "更多筛选", decisionApplyFilters: "应用筛选", decisionLoadMore: "加载更多", decisionBackToRecords: "返回判断记录", decisionStatusClosed: "已结束", decisionOutcomeAnswer: "助手已回答", decisionOutcomeReturn: "返回等待补充", decisionOutcomeEscalate: "交由你决定", decisionOutcomeFailed: "处理失败", decisionFeedbackNone: "未评分", decisionFeedbackValidated: "已认可", decisionFeedbackDisputed: "已不认可",
        decisionReviewedPrinciplesUsed: "本次处理使用了经审阅原则作为非权威指导", decisionPinnedEmpty: "本次处理固定了原则版本，但没有装入经审阅原则。", decisionNoReviewedPrinciples: "本次处理未使用经审阅原则。", decisionHistoricalContextUsed: "本次处理包含历史参考", decisionNoHistoricalContext: "本次处理未使用历史参考。", decisionLegacyMemory: "本次处理没有记录经审阅原则或历史参考的使用情况。", decisionEvaluationNumber: "处理", decisionEvaluationHistory: "处理历史", decisionNoEarlierEvaluations: "没有更早的处理记录。", decisionFeedbackHistory: "反馈历史", decisionNoFeedback: "暂无反馈记录。", decisionNoteNoEffect: "备注会保留在此记录中，不影响之后的判断。", decisionAddNote: "添加备注", decisionCorrectionScope: "适用于", decisionCorrectionTarget: "取代以下问题的答案", decisionCorrectionFutureOnly: "只影响之后的判断，原回答保留不变。", decisionSubmitCorrection: "提交纠正", decisionCurrentScope: "当前记录的适用范围", decisionAuthorizationClasses: "授权类",
        decisionAgentStateEnabled: "已启用", decisionAgentStateDisabled: "已停用", decisionAgentStateArchived: "已归档", decisionNoPreference: "暂无判断偏好。", decisionVersionUnavailable: "摘要中没有版本信息", decisionPrincipleDetailsOnOpen: "打开助手以查看原则版本。", decisionPendingReview: "有待审变化", decisionEditAgent: "编辑助手", decisionAgentName: "名称", decisionAgentPreference: "判断偏好（可选）", decisionAgentPreferenceHint: "用普通语言描述此助手的判断偏好。", decisionAdvancedSettings: "高级设置", decisionAdvancedSettingsHint: "适用范围和模型路由沿用既有权威档案格式。", decisionAgentScopeJson: "完整适用范围（JSON）", decisionAgentModelRouteJson: "模型路由（JSON）", decisionModelInheritanceHint: "新助手未提供路由时继承会话模型。", decisionDisableAgent: "停用助手", decisionEnableAgent: "启用助手", decisionArchiveAgent: "归档助手", decisionProfileHistory: "判断偏好版本历史", decisionDiscardTitle: "放弃未保存的修改？", decisionDiscardConfirmation: "未保存的助手修改将丢失。", decisionDiscard: "放弃修改", decisionArchiveTitle: "归档此助手？", decisionArchiveConfirmation: "助手将不再接收新判断，既有记录和历史会保留。", decisionDisableTitle: "停用此助手？", decisionDisableConfirmation: "重新启用前，新判断不会路由到此助手。", decisionEnableTitle: "启用此助手？", decisionEnableConfirmation: "此助手可再次接收新判断。",
        decisionMetricActivity: "活动", decisionMetricReturns: "按原因返回", decisionMetricEvidenceFailures: "依据问题", decisionMetricFeedback: "反馈", decisionMetricCasesOpened: "已开启判断", decisionMetricAttemptsTotal: "处理次数", decisionMetricAutoAnswered: "自动回答", decisionMetricAutoAnswerRate: "自动回答率", decisionMetricEscalated: "由你决定", decisionMetricExhausted: "需要处理", decisionMetricCancelled: "已取消", decisionMetricInterrupted: "中断的处理", decisionMetricCorrections: "纠正", decisionMetricReassignments: "改派", decisionMetricFeedbackParticipation: "有反馈的记录", decisionMetricSelectorOffBypasses: "关闭旁路（不采样）", decisionMetricMeanLatency: "平均处理耗时", decisionMetricEvidenceStale: "依据过期", decisionMetricEvidenceConflicting: "依据冲突", decisionMetricEvidenceDeleted: "依据已删除", decisionMetricRatingsUp: "认可", decisionMetricRatingsDown: "不认可", decisionMetricRatingsUndone: "撤销评分", decisionMetricWindow: "时间范围", decisionMetricWindowAll: "全部时间", decisionMetricWindow24h: "最近 24 小时", decisionMetricWindow7d: "最近 7 天", decisionMetricWindow30d: "最近 30 天", decisionRawMetrics: "原始指标值",
        decisionSelector: "决策助手", decisionOff: "关闭", decisionAgents: "助手管理", decisionRecords: "判断记录",
        decisionInbox: "待你决定", decisionMetrics: "指标", decisionLoading: "正在加载判断记录…", decisionLoadingShort: "读取中…", decisionSaving: "保存中…", decisionFailed: "决策操作失败，可重试。",
        decisionEvidence: "判断依据", decisionSuggestions: "暂定建议", decisionPerQuestion: "逐题结论", decisionRevision: "记录版本", decisionHistory: "打开记录", decisionNoRecord: "暂无判断记录。",
        decisionRecord: "判断记录", decisionNoSession: "打开会话后可查看判断记录。", decisionReadFailed: "判断记录读取失败，请重试。",
        decisionNoPermission: "你没有读取这些判断记录的权限。", decisionRecordsCleaned: "判断记录已清理。", decisionNoFilteredRecords: "没有符合筛选条件的判断记录。", decisionNoAgents: "暂无助手，请先新建助手。",
        decisionUp: "认可", decisionDown: "不认可", decisionUndo: "撤销评分", decisionUndoUp: "撤销认可", decisionUndoDown: "撤销不认可", decisionComment: "备注", decisionCorrect: "纠正", decisionConfirmConsequence: "认可仅在原适用范围内支持此回答作为依据。", decisionDisputeConsequence: "不认可会立即停止此回答单独用于自动回答，但不会反推相反答案。",
        decisionDecide: "提交决定", decisionReassign: "改派", decisionCancel: "取消", decisionRetry: "重试", decisionSave: "保存", decisionUseSuggestions: "使用建议", decisionAnswersIncomplete: "请回答全部问题后再提交。",
        decisionSelectTitle: "选择决策助手", decisionSelectorSafety: "仅当前会话；审批和高风险操作仍会询问你。", decisionManageAgents: "管理助手", decisionCreateAgent: "新建助手",
        decisionAuto: "Auto", decisionAutoWhitelist: "Auto 只路由以下已允许的授权类：", decisionAutoEmptyWhitelist: "Auto 授权类白名单为空。新的 Auto 请求不会被自动回答。", decisionAutoReadinessUnknown: "无法核实 Auto 的就绪状态；不假定其具备自动回答能力。", decisionAutoShadowOn: "Shadow 诊断已开启；它不会改变真实路由或答案。", decisionAutoShadowOff: "Shadow 诊断已关闭。",
        decisionRoutingReview: "路由复盘", decisionRoutingDiagnostic: "路由比较与计数仅用于诊断，不是质量评分或自动晋升依据。", decisionRoutingAgreement: "Shadow 与钉选选择一致", decisionRoutingDisagreement: "Shadow 与钉选选择不同", decisionRoutingShadowNone: "Shadow 未选择助手", decisionRoutingShadowAmbiguous: "Shadow 路由存在歧义", decisionRoutingShadowFailure: "Shadow 路由失败", decisionRoutingAutoNone: "Auto 未选择助手", decisionRoutingAutoAmbiguous: "Auto 路由存在歧义", decisionRoutingAutoFailure: "Auto 路由失败", decisionRoutingManualReassign: "已手动改派", decisionRoutingUncomparable: "不可比较；没有可用的钉选基线记录", decisionRoutingBaseline: "Shadow 比较的钉选基线", decisionRoutingAutoSelected: "Auto 已选择助手", decisionRoutingNoData: "此时间范围内没有路由决定。", decisionRoutingOpenRecord: "打开以下内容的已授权判断记录", decisionRoutingShown: "已显示的路由记录数",
        decisionRoutingDirection: "改派方向（原助手 → 新助手）", decisionNoAssignedAgent: "尚未选择助手",
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
        decisionLearningIdle: "尚未整理过原则。", decisionLearningNoChanges: "这次没有可整理的新原则。", decisionLearningStartUnavailable: "当前助手不可用，无法开始新的原则整理。", decisionLearningStartRunning: "已有一次整理正在进行。", decisionLearningStartCandidate: "请先审阅待审候选，再开始新的整理。", decisionLearningWorking: "另一项决策操作正在进行。", decisionPrincipleVersion: "版本",
        decisionLearningReadFailed: "候选详情读取失败。审阅现场已保留，请重试读取。", decisionCandidateLoading: "正在加载完整候选…", decisionCandidateNotReady: "候选详情不完整或已不再匹配，请重新读取后再操作。", decisionSourceCase: "判断来源", decisionSourceCorrection: "纠正来源",
        decisionApplyTitle: "采用这些原则变化？", decisionApplyConfirmation: "该候选将成为当前的经审阅原则版本。", decisionApplyChangeCount: "原则变化数量", decisionApplyReplaceCurrent: "将替代", decisionApplyFutureOnly: "只影响之后的新判断；既有记录和历史保持不变。", decisionDiscardCandidateTitle: "放弃这个候选？", decisionDiscardCandidateConfirmation: "该候选不会影响之后的判断，其审阅和来源历史仍会保留。", decisionRollbackTitle: "恢复前序原则版本？", decisionRollbackConfirmation: "当前版本会保留在只读历史中。之后的判断将使用最近的前序已审版本；若没有，则不使用经审阅原则。",
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
    exports.reasonKey = reasonKey;
    exports.errorKey = errorKey;
    exports.selectorOptions = selectorOptions;
    exports.selectorView = selectorView;
    exports.cardView = cardView;
    exports.memoryView = memoryView;
    exports.metricsView = metricsView;
    exports.recordSummary = recordSummary;
    exports.appendRecordPage = appendRecordPage;
    exports.narrowRoutingReview = narrowRoutingReview;
    exports.routingReviewView = routingReviewView;
    exports.appendRoutingPage = appendRoutingPage;
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
