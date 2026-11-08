window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-page.js",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const PAGE_ID = "weir-decisions";
    const cardStyle = { color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "12px", padding: "12px" };
    const inputStyle = { color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", padding: "5px 7px" };
    const buttonStyle = { color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", padding: "4px 8px", cursor: "pointer" };
    const contextPackStyle = { background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", padding: "6px 8px" };
    const contextPackBodyStyle = { display: "grid", gap: "8px", paddingTop: "8px", fontSize: "12px", lineHeight: "16px" };
    const contextPackLabelStyle = { color: "var(--dsw-alias-label-secondary)", fontWeight: 600 };
    const contextPackListStyle = { margin: "4px 0 0", paddingLeft: "22px", overflowWrap: "anywhere" };

    function answerText(answer) {
      if (!answer) return "";
      return [...(Array.isArray(answer.selected) ? answer.selected : []), ...(typeof answer.custom === "string" && answer.custom ? [answer.custom] : [])].join(", ");
    }

    function EvidenceList(props) {
      const evidence = Array.isArray(props.evidence) ? props.evidence : [];
      if (!evidence.length) return jsx.jsx(props.ui.EmptyState, { children: props.t("decisionNoEvidence") });
      return jsx.jsx("ul", { className: "weir-da-evidence-list", children: evidence.map((item, index) => jsx.jsxs("li", { children: [
        jsx.jsx("div", { children: item?.excerpt || props.t("decisionEvidenceUnavailable") }, "excerpt"),
        item?.status && item.status !== "active" ? jsx.jsx("div", { className: "weir-da-caption", children: props.t(item.status === "deleted" ? "decisionEvidenceDeleted" : "decisionEvidenceSuperseded") }, "status") : null,
      ] }, item?.evidenceId ?? index)) });
    }

    function MemorySummary(props) {
      const memory = props.model.memoryView(props.attempt);
      const rows = [];
      if (memory.l2 === "used") rows.push(`${props.t("decisionReviewedPrinciplesUsed")} (${memory.l2Count})`);
      else if (memory.l2 === "pinned-empty") rows.push(props.t("decisionPinnedEmpty"));
      else if (memory.l2 === "empty") rows.push(props.t("decisionNoReviewedPrinciples"));
      if (memory.l3 === "used") rows.push(`${props.t("decisionHistoricalContextUsed")} (${memory.l3Count}). ${props.t("decisionHistoricalNotEvidence")}`);
      else if (memory.l3 === "empty") rows.push(props.t("decisionNoHistoricalContext"));
      if (!rows.length) rows.push(props.t("decisionLegacyMemory"));
      return jsx.jsx("ul", { className: "weir-da-memory-summary", children: rows.map((row, index) => jsx.jsx("li", { children: row }, index)) });
    }

    function EvaluationGroup(props) {
      const attempt = props.attempt ?? {};
      const claims = Array.isArray(attempt.claims) ? attempt.claims : [];
      const outcomeKeys = { answer: "decisionOutcomeAnswer", return: "decisionOutcomeReturn", escalate: "decisionOutcomeEscalate", failed: "decisionOutcomeFailed" };
      return jsx.jsxs("article", { key: attempt.attemptId ?? props.index, className: "weir-da-evaluation", "data-evaluation-group": true, children: [
        jsx.jsx("strong", { children: `${props.t("decisionEvaluationNumber")} ${attempt.attemptNo ?? props.index + 1} · ${props.t(outcomeKeys[attempt.outcome] ?? "decisionStatusUnknown")}` }, "title"),
        attempt.hint || attempt.reasonCode ? jsx.jsx("p", { children: attempt.hint ?? props.t(props.model.reasonKey(attempt.reasonCode) ?? "decisionReasonUnknown") }, "reason") : null,
        claims.length ? jsx.jsx("ul", { children: claims.map((claim, index) => jsx.jsx("li", { children: claim?.text ?? "" }, index)) }, "claims") : null,
        EvidenceList({ evidence: attempt.evidence, ui: props.ui, t: props.t }),
      ] });
    }

    function readableScope(scope, t) {
      if (!scope || typeof scope !== "object") return t("decisionCurrentScope");
      const parts = [...(Array.isArray(scope.workspaces) ? scope.workspaces : []), ...(Array.isArray(scope.paths) ? scope.paths : []), ...(Array.isArray(scope.tags) ? scope.tags : [])];
      if (Array.isArray(scope.authorizationClasses)) parts.push(`${t("decisionAuthorizationClasses")}: ${scope.authorizationClasses.join(", ")}`);
      return parts.length ? parts.join(" · ") : t("decisionCurrentScope");
    }

    function RecordDetail(props) {
      const { detail, model, ui, t, draft } = props;
      const agents = Array.isArray(props.agents) ? props.agents : [];
      const view = model.cardView(detail, agents);
      const current = detail.case;
      const questions = Array.isArray(current.request?.questions) ? current.request.questions : [];
      const answers = Array.isArray(current.decision?.answers) ? current.decision.answers : [];
      const previous = (view?.history ?? []).filter(group => group.attempt?.attemptId !== view.currentAttempt?.attemptId);
      const pending = typeof props.pending === "string";
      const feedback = Array.isArray(detail.feedback) ? detail.feedback : [];
      const feedbackKeys = { rating_up: "decisionUp", rating_down: "decisionDown", undo_rating_up: "decisionUndoUp", undo_rating_down: "decisionUndoDown", comment: "decisionComment", correction: "decisionCorrect" };
      return jsx.jsxs("article", { className: "weir-da-card weir-da-record-detail", "data-record-detail": current.caseId, children: [
        jsx.jsxs("header", { className: "weir-da-card-header", children: [
          jsx.jsxs("div", { children: [
            jsx.jsx("h2", { children: view?.questionSummary || t("decisionRecord") }, "title"),
            jsx.jsx("p", { className: "weir-da-caption", children: view?.agentName ?? t("decisionSelector") }, "agent"),
          ] }, "copy"),
          jsx.jsx(ui.Badge, { variant: view?.variant === "answered" ? "success" : view?.variant === "failed" ? "error" : "warn", children: t(view?.statusKey ?? "decisionStatusUnknown") }, "status"),
        ] }, "header"),
        jsx.jsx("section", { className: "weir-da-record-answers", children: questions.map((question, index) => {
          const answer = answers.find(item => item?.id === question.id);
          return jsx.jsxs("div", { className: "weir-da-answer-summary", children: [
            jsx.jsx("strong", { children: question.question }, "question"),
            jsx.jsx("div", { children: answerText(answer) || t("decisionNoAnswer") }, "answer"),
          ] }, question.id ?? index);
        }) }, "answers"),
        view?.summary ? jsx.jsxs("section", { children: [jsx.jsx("h3", { children: t("decisionReasonSummary") }, "title"), jsx.jsx("p", { children: view.summary }, "summary")] }, "reason") : null,
        jsx.jsxs("section", { "data-current-evidence": true, children: [
          jsx.jsx("h3", { children: t("decisionCurrentEvidence") }, "title"),
          EvidenceList({ evidence: view?.evidence, ui, t }),
          MemorySummary({ attempt: view?.currentAttempt, model, t }),
        ] }, "evidence"),
        jsx.jsxs("section", { "data-evaluation-history": true, children: [
          jsx.jsx("h3", { children: t("decisionEvaluationHistory") }, "title"),
          previous.length ? previous.map((group, index) => EvaluationGroup({ ...group, index, model, ui, t })) : jsx.jsx("p", { className: "weir-da-caption", children: t("decisionNoEarlierEvaluations") }),
        ] }, "history"),
        jsx.jsxs("section", { children: [
          jsx.jsx("h3", { children: t("decisionFeedbackHistory") }, "title"),
          feedback.length ? jsx.jsx("ul", { children: feedback.map((entry, index) => jsx.jsx("li", { children: `${t(feedbackKeys[entry?.kind] ?? "decisionComment")}: ${entry?.payload?.text ?? entry?.payload?.direction ?? t("decisionNoAnswer")}` }, entry?.feedbackId ?? index)) }) : jsx.jsx("p", { className: "weir-da-caption", children: t("decisionNoFeedback") }),
        ] }, "feedback-history"),
        jsx.jsxs("section", { className: "weir-da-feedback-editor", children: [
          jsx.jsx("div", { className: "weir-da-actions", children: model.feedbackActions(current.feedbackState).map(action => jsx.jsx(ui.Button, {
            "data-feedback": action.verb, disabled: pending, onClick: () => props.run("feedback", current.caseId, action.verb), children: t(action.labelKey),
          }, action.verb)) }, "ratings"),
          jsx.jsx(ui.Field, { id: `weir-da-note-${current.caseId}`, label: t("decisionComment"), hint: t("decisionNoteNoEffect"), children: jsx.jsx("textarea", {
            id: `weir-da-note-${current.caseId}`, "data-draft": "comment", "aria-label": t("decisionComment"), value: draft.comment, disabled: pending,
            onChange: event => props.updateDraft("comment", event.target.value),
          }) }, "note-field"),
          jsx.jsx(ui.Button, { "data-action": "comment", disabled: pending || !draft.comment, onClick: () => props.run("feedback", current.caseId, "comment", draft.comment), children: t("decisionAddNote") }, "note-action"),
          jsx.jsx(ui.Field, { id: `weir-da-correction-${current.caseId}`, label: t("decisionCorrect"), children: jsx.jsx("textarea", {
            id: `weir-da-correction-${current.caseId}`, "data-draft": "correction", "aria-label": t("decisionCorrect"), value: draft.correction, disabled: pending,
            onChange: event => props.updateDraft("correction", event.target.value),
          }) }, "correction-field"),
          draft.correction ? jsx.jsxs("div", { className: "weir-da-correction-preview", children: [
            jsx.jsx("div", { children: `${t("decisionCorrectionScope")}: ${readableScope(current.scope, t)}` }, "scope"),
            jsx.jsx("div", { children: `${t("decisionCorrectionTarget")}: ${view?.questionSummary || t("decisionRecord")}` }, "target"),
            jsx.jsx("div", { children: t("decisionCorrectionFutureOnly") }, "future"),
          ] }, "preview") : null,
          jsx.jsx(ui.Button, { "data-action": "correction", disabled: pending || !draft.correction, onClick: () => props.run("correction", current.caseId, draft.correction, current.scope, [current.caseId]), children: t("decisionSubmitCorrection") }, "correction-action"),
        ] }, "feedback-actions"),
        jsx.jsx(ui.Disclosure, { id: `weir-da-record-advanced-${current.caseId}`, label: t("decisionAdvancedDiagnostics"), children: () => jsx.jsxs("div", { className: "weir-da-advanced-record", children: [
          ...(view?.history ?? []).map((group, index) => AttemptContextPack({ attempt: group.attempt, t })),
          jsx.jsx("pre", { children: JSON.stringify(detail, null, 2) }, "raw"),
        ] }) }, "advanced"),
      ] });
    }

    function InboxItem(props) {
      const current = props.item;
      const { t, ui, model, draft } = props;
      const summary = model.recordSummary(current, props.agents);
      const questions = Array.isArray(current.request?.questions) ? current.request.questions : [];
      const pending = typeof props.pending === "string";
      const suggestions = Array.isArray(current.escalation?.suggestion) ? current.escalation.suggestion : [];
      const perQuestion = Array.isArray(current.escalation?.perQuestion) ? current.escalation.perQuestion : [];
      const detail = props.evidence?.value;
      const evidenceView = detail ? model.cardView(detail, props.agents) : null;
      return jsx.jsxs("article", { className: "weir-da-card weir-da-inbox-card", "data-case-id": current.caseId, children: [
        jsx.jsxs("header", { className: "weir-da-card-header", children: [
          jsx.jsxs("div", { children: [
            jsx.jsx("h2", { children: summary?.title ?? t("decisionRecord") }, "title"),
            jsx.jsx("p", { className: "weir-da-caption", children: summary?.agentName ?? t("decisionSelector") }, "agent"),
          ] }, "copy"),
          jsx.jsx(ui.Badge, { variant: "warn", children: t(summary?.statusKey ?? "decisionStatusAwaitingUser") }, "status"),
        ] }, "header"),
        jsx.jsx("p", { children: current.escalation?.missing?.[0] ?? t(summary?.reasonKey ?? "decisionReasonUnknown") }, "reason"),
        suggestions.length || perQuestion.length ? jsx.jsxs("section", { className: "weir-da-suggestion-review", children: [
          jsx.jsxs("strong", { children: [t("decisionSuggestions"), " · ", t("decisionSuggestionNotSubmitted")] }, "title"),
          suggestions.length ? jsx.jsx("ul", { children: suggestions.map((answer, index) => {
            const question = questions.find(item => item.id === answer?.id);
            return jsx.jsx("li", { children: `${question?.question ?? t("decisionRecord")}: ${answerText(answer)}` }, answer?.id ?? index);
          }) }, "suggestions") : null,
          perQuestion.length ? jsx.jsx("ul", { children: perQuestion.map((entry, index) => {
            const question = questions.find(item => item.id === entry?.id);
            return jsx.jsx("li", { children: `${question?.question ?? t("decisionRecord")}: ${t(model.reasonKey(entry?.detail) ?? "decisionReasonUnknown")}` }, entry?.id ?? index);
          }) }, "per-question") : null,
        ] }, "guidance") : null,
        jsx.jsx(ui.DecisionAnswers, {
          questions, answers: draft.answers, suggestions, pending,
          onChange: value => props.updateDraft("answers", value), onSubmit: value => props.run("decide", current.caseId, value), t,
        }, "answers"),
        jsx.jsx(ui.Disclosure, {
          id: `weir-da-evidence-${current.caseId}`, label: t("decisionEvidence"), onOpen: () => props.loadEvidence(false),
          children: () => props.evidence?.status === "loading" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
            : props.evidence?.status === "error" ? jsx.jsx(ui.ErrorState, { children: jsx.jsx(ui.Button, { onClick: () => props.loadEvidence(true), children: t("decisionRetry") }) })
            : evidenceView ? EvidenceList({ evidence: evidenceView.evidence, ui, t }) : jsx.jsx(ui.EmptyState, { children: t("decisionNoEvidence") }),
        }, "evidence"),
        jsx.jsx(ui.Disclosure, { id: `weir-da-recovery-${current.caseId}`, label: t("decisionRecoveryActions"), children: jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsxs("select", { value: draft.reassignTarget, onChange: event => props.updateDraft("reassignTarget", event.target.value), "aria-label": t("decisionReassign"), className: "weir-da-select", disabled: pending, children: [
            jsx.jsx("option", { value: "", children: t("decisionChooseAssistant") }, "empty"),
            ...props.agents.filter(agent => agent.state === "enabled").map(agent => jsx.jsx("option", { value: agent.agentId, children: agent.name }, agent.agentId)),
          ] }, "target"),
          jsx.jsx(ui.Button, { disabled: !draft.reassignTarget || pending, onClick: () => props.run("reassign", current.caseId, draft.reassignTarget), children: t("decisionReassign") }, "reassign"),
          jsx.jsx(ui.Button, { disabled: pending, onClick: () => props.run("retry", current.caseId), children: t("decisionRetry") }, "retry"),
          jsx.jsx(ui.Button, { variant: "danger", disabled: pending, onClick: () => props.requestCancel(), children: t("decisionCancel") }, "cancel"),
        ] }) }, "recovery"),
      ] });
    }

    function readableTime(value) {
      if (value === null || value === undefined || value === "") return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function FilterSelect(props) {
      return jsx.jsxs("label", { className: "weir-da-filter", children: [
        jsx.jsx("span", { children: props.label }, "label"),
        jsx.jsxs("select", { className: "weir-da-select", "data-filter": props.name, "aria-label": props.label, value: props.value ?? "", onChange: props.onChange, children: [
          jsx.jsx("option", { value: "", children: props.allLabel }, "empty"),
          ...props.options.map(option => jsx.jsx("option", { value: option.value, children: option.label }, option.value)),
        ] }, "select"),
      ] });
    }

    function RecordFilters(props) {
      const { filter, model, ui, t } = props;
      const change = key => event => props.onChange(key, event.target.value);
      const stateKeys = { received: "decisionStatusReceived", evaluating: "decisionStatusEvaluating", awaiting_revision: "decisionStatusAwaitingRevision", awaiting_user: "decisionStatusAwaitingUser", closed: "decisionStatusClosed" };
      const outcomeKeys = { answer: "decisionOutcomeAnswer", return: "decisionOutcomeReturn", escalate: "decisionOutcomeEscalate", failed: "decisionOutcomeFailed" };
      const feedbackKeys = { none: "decisionFeedbackNone", validated: "decisionFeedbackValidated", disputed: "decisionFeedbackDisputed" };
      const options = (values, keys) => values.map(value => ({ value, label: t(keys[value]) }));
      return jsx.jsxs("section", { className: "weir-da-filters", "aria-label": t("decisionRecordFilters"), children: [
        jsx.jsxs("div", { className: "weir-da-filter-row", children: [
          FilterSelect({ name: "agentId", label: t("decisionFilterAgent"), allLabel: t("decisionAllAssistants"), value: filter.agentId, onChange: change("agentId"), options: props.agents.map(agent => ({ value: agent.agentId, label: agent.name })) }),
          FilterSelect({ name: "state", label: t("decisionFilterState"), allLabel: t("decisionAllStates"), value: filter.state, onChange: change("state"), options: options(Object.keys(stateKeys), stateKeys) }),
          jsx.jsx(ui.Button, { variant: "primary", onClick: props.onApply, children: t("decisionApplyFilters") }, "apply"),
        ] }, "common"),
        jsx.jsx(ui.Disclosure, { id: "weir-da-more-record-filters", label: t("decisionMoreFilters"), children: () => jsx.jsxs("div", { className: "weir-da-filter-row weir-da-filter-advanced", children: [
          FilterSelect({ name: "outcome", label: t("decisionFilterOutcome"), allLabel: t("decisionAllOutcomes"), value: filter.outcome, onChange: change("outcome"), options: options(Object.keys(outcomeKeys), outcomeKeys) }),
          FilterSelect({ name: "reasonCode", label: t("decisionFilterReason"), allLabel: t("decisionAllReasons"), value: filter.reasonCode, onChange: change("reasonCode"), options: ["INVALID_PREMISE", "MISSING_CONTEXT", "OUT_OF_SCOPE", "CONFLICTING_EVIDENCE", "STALE_EVIDENCE", "UNSUPPORTED_OPTIONS"].map(value => ({ value, label: t(model.reasonKey(value)) })) }),
          jsx.jsxs("label", { className: "weir-da-filter", children: [
            jsx.jsx("span", { children: t("decisionFilterScope") }, "label"),
            jsx.jsx("input", { "data-filter": "scope", "aria-label": t("decisionFilterScope"), value: filter.scope ?? "", onChange: change("scope") }, "input"),
          ] }, "scope"),
          FilterSelect({ name: "feedbackState", label: t("decisionFilterFeedback"), allLabel: t("decisionAllFeedback"), value: filter.feedbackState, onChange: change("feedbackState"), options: options(Object.keys(feedbackKeys), feedbackKeys) }),
        ] }) }, "advanced"),
      ] });
    }
    function agentStateKey(state) {
      return state === "enabled" ? "decisionAgentStateEnabled" : state === "disabled" ? "decisionAgentStateDisabled" : state === "archived" ? "decisionAgentStateArchived" : "decisionStatusUnknown";
    }

    function newAgentEditor(agent) {
      const value = agent ? {
        mode: "edit", agentId: agent.agentId, name: agent.name ?? "", preference: agent.userDescription?.text ?? "",
        scopeText: JSON.stringify(agent.scope ?? {}, null, 2), routeText: JSON.stringify(agent.modelRoute ?? { chain: [] }, null, 2),
      } : { mode: "create", agentId: null, name: "", preference: "", scopeText: "", routeText: "" };
      return { ...value, baseline: { name: value.name, preference: value.preference, scopeText: value.scopeText, routeText: value.routeText } };
    }

    function AgentSummary(props) {
      const agent = props.detail?.agentId === props.agent.agentId ? props.detail : props.agent;
      const current = learningRows(agent.snapshots).find(snapshot => snapshot.snapshotId === agent.currentSnapshotId);
      const pendingReview = learningRows(agent.learningRuns).some(run => run.outcome === "candidate");
      return jsx.jsxs("article", { key: props.agent.agentId, className: "weir-da-card weir-da-agent-summary", "data-agent-summary": props.agent.agentId, children: [
        jsx.jsxs("header", { className: "weir-da-card-header", children: [
          jsx.jsx("h2", { children: agent.name }, "name"),
          jsx.jsx(props.ui.Badge, { variant: agent.state === "enabled" ? "success" : agent.state === "disabled" ? "warn" : "idle", children: props.t(agentStateKey(agent.state)) }, "state"),
        ] }, "header"),
        jsx.jsx("p", { children: agent.userDescription?.text || props.t("decisionNoPreference") }, "preference"),
        jsx.jsx("p", { className: "weir-da-caption", children: agent.currentSnapshotId
          ? `${props.t("decisionCurrentSnapshot")}: ${current ? `v${current.version ?? "—"}` : props.t("decisionVersionUnavailable")}`
          : Array.isArray(agent.learningRuns) ? props.t("decisionNoCurrentSnapshot") : props.t("decisionPrincipleDetailsOnOpen") }, "principles"),
        pendingReview ? jsx.jsx(props.ui.Badge, { variant: "warn", children: props.t("decisionPendingReview") }, "pending") : null,
        jsx.jsx(props.ui.Button, { "data-action": "open-agent", onClick: () => props.onOpen(props.agent.agentId), children: props.t("decisionViewAssistant") }, "open"),
      ] });
    }

    function AgentEditor(props) {
      const { editor, ui, t } = props;
      const suffix = editor.agentId ?? "create";
      return jsx.jsxs("form", { className: "weir-da-card weir-da-agent-editor", "data-agent-editor": editor.mode, onSubmit: event => { event.preventDefault(); return props.onSave(); }, children: [
        jsx.jsx("h2", { children: t(editor.mode === "create" ? "decisionCreateAgent" : "decisionEditAgent") }, "title"),
        jsx.jsx(ui.Field, { id: `weir-da-agent-name-${suffix}`, label: t("decisionAgentName"), children: jsx.jsx("input", {
          id: `weir-da-agent-name-${suffix}`, "data-agent-field": "name", "aria-label": t("decisionAgentName"), value: editor.name, disabled: props.pending,
          onChange: event => props.onField("name", event.target.value), required: true,
        }) }, "name"),
        jsx.jsx(ui.Field, { id: `weir-da-agent-preference-${suffix}`, label: t("decisionAgentPreference"), hint: t("decisionAgentPreferenceHint"), children: jsx.jsx("textarea", {
          id: `weir-da-agent-preference-${suffix}`, "data-agent-field": "preference", "aria-label": t("decisionAgentPreference"), value: editor.preference, rows: 3, disabled: props.pending,
          onChange: event => props.onField("preference", event.target.value),
        }) }, "preference"),
        jsx.jsx(ui.Disclosure, { id: `weir-da-agent-settings-${suffix}`, label: t("decisionAdvancedSettings"), children: () => jsx.jsxs("div", { className: "weir-da-agent-advanced", children: [
          jsx.jsx("p", { className: "weir-da-caption", children: t("decisionAdvancedSettingsHint") }, "hint"),
          jsx.jsx(ui.Field, { id: `weir-da-agent-scope-${suffix}`, label: t("decisionAgentScopeJson"), children: jsx.jsx("textarea", {
            id: `weir-da-agent-scope-${suffix}`, "data-agent-field": "scope", "aria-label": t("decisionAgentScopeJson"), value: editor.scopeText, rows: 6, disabled: props.pending,
            onChange: event => props.onField("scopeText", event.target.value),
          }) }, "scope"),
          jsx.jsx(ui.Field, { id: `weir-da-agent-route-${suffix}`, label: t("decisionAgentModelRouteJson"), hint: t("decisionModelInheritanceHint"), children: jsx.jsx("textarea", {
            id: `weir-da-agent-route-${suffix}`, "data-agent-field": "modelRoute", "aria-label": t("decisionAgentModelRouteJson"), value: editor.routeText, rows: 6, disabled: props.pending,
            onChange: event => props.onField("routeText", event.target.value),
          }) }, "route"),
        ] }) }, "advanced"),
        jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx(ui.Button, { disabled: props.pending, onClick: props.onCancel, children: t("decisionCancel") }, "cancel"),
          jsx.jsx(ui.Button, { type: "submit", variant: "primary", disabled: props.pending || !editor.name.trim(), children: props.pending ? t("decisionSaving") : t("decisionSave") }, "save"),
        ] }, "actions"),
      ] });
    }

    function AgentDetail(props) {
      const { agent, ui, t } = props;
      const current = learningRows(agent.snapshots).find(snapshot => snapshot.snapshotId === agent.currentSnapshotId);
      const pendingReview = learningRows(agent.learningRuns).some(run => run.outcome === "candidate");
      return jsx.jsxs("article", { className: "weir-da-card weir-da-agent-detail", "data-agent-detail": agent.agentId, children: [
        jsx.jsxs("header", { className: "weir-da-card-header", children: [
          jsx.jsxs("div", { children: [jsx.jsx("h2", { children: agent.name }, "name"), jsx.jsx("p", { children: agent.userDescription?.text || t("decisionNoPreference") }, "preference")] }, "copy"),
          jsx.jsx(ui.Badge, { variant: agent.state === "enabled" ? "success" : agent.state === "disabled" ? "warn" : "idle", children: t(agentStateKey(agent.state)) }, "state"),
        ] }, "header"),
        jsx.jsx("p", { children: `${t("decisionCurrentSnapshot")}: ${current ? `v${current.version ?? "—"}` : t("decisionNoCurrentSnapshot")}` }, "current"),
        pendingReview ? jsx.jsx(ui.Badge, { variant: "warn", children: t("decisionPendingReview") }, "pending") : null,
        jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx(ui.Button, { variant: "primary", "data-action": "edit-agent", onClick: props.onEdit, children: t("decisionEditAgent") }, "edit"),
          jsx.jsx(ui.Button, { "data-agent-state": agent.state === "enabled" ? "disabled" : "enabled", disabled: agent.state === "archived", onClick: () => props.requestState(agent.state === "enabled" ? "disabled" : "enabled"), children: t(agent.state === "enabled" ? "decisionDisableAgent" : "decisionEnableAgent") }, "toggle"),
          jsx.jsx(ui.Button, { variant: "danger", "data-agent-state": "archived", disabled: agent.state === "archived", onClick: () => props.requestState("archived"), children: t("decisionArchiveAgent") }, "archive"),
        ] }, "actions"),
        jsx.jsx(ui.Disclosure, { id: `weir-da-agent-advanced-${agent.agentId}`, label: t("decisionAdvancedDiagnostics"), children: () => jsx.jsxs("div", { className: "weir-da-agent-diagnostics", children: [
          jsx.jsx("h3", { children: t("decisionProfileHistory") }, "history-title"),
          jsx.jsx("ul", { children: (agent.descriptionHistory ?? []).map(item => jsx.jsx("li", { children: `v${item.revision}: ${item.text}` }, item.revision)) }, "history"),
          jsx.jsx(AgentLearning, { ...props.learningProps, agent }, "learning"),
          jsx.jsx("pre", { children: JSON.stringify(agent, null, 2) }, "raw"),
        ] }) }, "advanced"),
      ] });
    }
    function MetricRows(props) {
      return jsx.jsx("dl", { className: "weir-da-metrics-grid", children: props.rows.map(row => jsx.jsxs("div", { className: "weir-da-metric", "data-metric-key": row.key, children: [
        jsx.jsx("dt", { children: row.labelKey ? props.t(row.labelKey) : row.label }, "label"),
        jsx.jsx("dd", { children: row.display }, "value"),
      ] }, row.key)) });
    }

    function MetricsDetails(props) {
      const view = props.model.metricsView(props.metrics);
      const windowKeys = { all: "decisionMetricWindowAll", "24h": "decisionMetricWindow24h", "7d": "decisionMetricWindow7d", "30d": "decisionMetricWindow30d" };
      return jsx.jsxs("section", { className: "weir-da-card weir-da-metrics", "data-metrics-view": true, children: [
        jsx.jsx("h2", { children: props.t("decisionMetrics") }, "title"),
        jsx.jsx("p", { className: "weir-da-caption", children: `${props.t("decisionMetricWindow")}: ${props.t(windowKeys[view.window] ?? "decisionMetricWindowAll")}${view.since !== null ? ` · ${readableTime(view.since)}` : ""}` }, "window"),
        jsx.jsx("p", { role: "note", children: props.t("decisionRateNotQuality") }, "warning"),
        view.sections.map(section => jsx.jsxs("section", { "data-metric-section": section.key, children: [
          jsx.jsx("h3", { children: props.t(section.labelKey) }, "title"),
          MetricRows({ rows: section.rows, t: props.t }),
        ] }, section.key)),
        jsx.jsx(props.ui.Disclosure, { id: "weir-da-raw-metrics", label: props.t("decisionRawMetrics"), children: () => jsx.jsx("pre", { children: JSON.stringify(view.raw, null, 2) }) }, "raw"),
      ] });
    }
    const emptyResource = () => ({ status: "idle", value: null, error: null });
    const emptyResources = () => ({
      agents: { ...emptyResource(), value: [] }, inbox: { ...emptyResource(), value: [] },
      records: { ...emptyResource(), value: [], nextCursor: null, loadingMore: false },
      details: {}, agent: emptyResource(), metrics: emptyResource(),
    });
    const asError = (reason, code = "DECISION_READ_FAILED") => reason instanceof Error ? reason : Object.assign(new Error(String(reason ?? code)), { code });

    function AttemptContextPack(props) {
      const t = props.t ?? (key => key);
      const attempt = props.attempt && typeof props.attempt === "object" ? props.attempt : {};
      const manifest = attempt.packManifest;
      const memory = manifest?.memory;
      const l2 = memory?.L2;
      const pins = attempt.pins && typeof attempt.pins === "object" ? attempt.pins : {};
      const attemptId = typeof attempt.attemptId === "string" ? attempt.attemptId : "—";
      const sourceCaseIds = Array.isArray(memory?.L3?.sourceCaseIds) ? memory.L3.sourceCaseIds.filter(caseId => typeof caseId === "string") : [];
      const omissions = Array.isArray(manifest?.omissions) ? manifest.omissions.filter(code => typeof code === "string") : [];
      const layerSizes = manifest?.layerSizes && typeof manifest.layerSizes === "object" && !Array.isArray(manifest.layerSizes) ? Object.entries(manifest.layerSizes) : [];
      const l2Status = l2 === undefined
        ? t("decisionMemoryEmpty")
        : l2?.status === "empty" ? t("decisionMemoryEmpty") : typeof l2?.status === "string" ? l2.status : "—";
      const snapshotPin = {
        snapshotId: l2?.snapshotId ?? pins.memorySnapshotId ?? null,
        snapshotRevision: l2?.snapshotRevision ?? pins.memorySnapshotRevision ?? null,
        snapshotHash: l2?.snapshotHash ?? pins.memorySnapshotHash ?? null,
      };
      const hasSnapshotPin = snapshotPin.snapshotId !== null || snapshotPin.snapshotRevision !== null || snapshotPin.snapshotHash !== null;
      const items = Array.isArray(l2?.items) ? l2.items.filter(item => item && typeof item === "object" && typeof item.principleId === "string") : [];
      const manifestPrincipleIds = Array.isArray(l2?.principleIds) ? l2.principleIds.filter(principleId => typeof principleId === "string") : [];
      const principleIds = manifestPrincipleIds.length ? manifestPrincipleIds : items.map(item => item.principleId);
      const exclusions = Array.isArray(l2?.exclusions) ? l2.exclusions.filter(item => item && typeof item === "object" && typeof item.principleId === "string") : [];
      return jsx.jsxs("details", {
        "data-attempt-context-pack": attemptId,
        "aria-label": `${t("decisionContextPack")}: ${attemptId}`,
        style: contextPackStyle,
        children: [
          jsx.jsx("summary", { style: { cursor: "pointer" }, children: `${t("decisionContextPack")} · ${attemptId}` }, "summary"),
          jsx.jsxs("div", { style: contextPackBodyStyle, children: [
            jsx.jsx("div", { children: `${t("decisionL2Memory")}: ${l2Status}` }, "l2"),
            jsx.jsxs("div", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionSnapshotPin") }, "label"),
              hasSnapshotPin
                ? jsx.jsx("pre", { children: JSON.stringify(snapshotPin, null, 2) }, "pin")
                : jsx.jsx("div", { children: t("decisionNoSnapshotPin") }, "empty"),
            ] }, "pin"),
            jsx.jsxs("div", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionReviewedPrinciples") }, "label"),
              principleIds.length
                ? jsx.jsx("ul", { style: contextPackListStyle, children: principleIds.map((principleId, index) => {
                  const item = items.find(candidate => candidate.principleId === principleId);
                  return jsx.jsxs("li", { children: [
                    jsx.jsx("code", { children: principleId }, "principle"),
                    item ? jsx.jsxs("div", { children: [
                      jsx.jsx("div", { children: t("decisionL5Mappings") }, "mapping-label"),
                      jsx.jsx("pre", { children: JSON.stringify({ sources: Array.isArray(item.sources) ? item.sources : [], evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds : [] }, null, 2) }, "mapping"),
                    ] }, "mapping") : null,
                  ] }, `${principleId}:${index}`);
                }) }, "principles")
                : jsx.jsx("div", { children: t("decisionMemoryEmpty") }, "empty"),
            ] }, "l2-principles"),
            jsx.jsxs("div", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionExclusions") }, "label"),
              exclusions.length
                ? jsx.jsx("ul", { style: contextPackListStyle, children: exclusions.map((item, index) => jsx.jsx("li", { children: jsx.jsx("code", { children: `${item.principleId} · ${item.reason ?? "—"}` }) }, `${item.principleId}:${index}`)) }, "exclusions")
                : jsx.jsx("div", { children: t("decisionNoExclusions") }, "empty"),
            ] }, "l2-exclusions"),
            jsx.jsxs("div", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionNeutralEpisodes") }, "label"),
              sourceCaseIds.length
                ? jsx.jsx("ol", { style: contextPackListStyle, children: sourceCaseIds.map((caseId, index) => jsx.jsx("li", { children: jsx.jsx("code", { children: caseId }) }, `${caseId}:${index}`)) }, "sources")
                : jsx.jsx("div", { children: principleIds.length ? t("decisionMemoryEmpty") : t("decisionNoMemory") }, "empty")
            ] }, "l3"),
            jsx.jsxs("div", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionLayerSizes") }, "label"),
              layerSizes.length
                ? jsx.jsx("dl", { style: contextPackListStyle, children: layerSizes.map(([layer, size]) => jsx.jsxs("div", { children: [jsx.jsx("dt", { children: layer }, "layer"), jsx.jsx("dd", { style: { margin: 0 }, children: String(size) }, "size")] }, layer)) }, "sizes")
                : jsx.jsx("div", { children: "—" }, "empty")
            ] }, "sizes"),
            jsx.jsxs("div", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionOmissions") }, "label"),
              omissions.length
                ? jsx.jsx("ul", { style: contextPackListStyle, children: omissions.map((code, index) => jsx.jsx("li", { children: jsx.jsx("code", { children: code }) }, `${code}:${index}`)) }, "codes")
                : jsx.jsx("div", { children: Array.isArray(manifest?.omissions) ? "[]" : "—" }, "empty")
            ] }, "omissions")
          ] }, "body")
        ]
      });
    }

    const learningRows = value => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];

    function principleDiff(parentSnapshot, snapshot) {
      const before = new Map(learningRows(parentSnapshot?.principles).map(item => [item.principleId, item]));
      const after = new Map(learningRows(snapshot?.principles).map(item => [item.principleId, item]));
      const rows = [];
      for (const principleId of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(principleId) ?? null;
        const next = after.get(principleId) ?? null;
        if (previous && next && JSON.stringify({ text: previous.text, scope: previous.scope, sources: previous.sources, state: previous.state }) === JSON.stringify({ text: next.text, scope: next.scope, sources: next.sources, state: next.state })) continue;
        rows.push({ principleId, change: previous ? next ? "changed" : "removed" : "added", before: previous, after: next });
      }
      return rows;
    }

    function learningSource(sourceId, index, props) {
      if (typeof sourceId !== "string") return null;
      return sourceId.startsWith("dc_")
        ? jsx.jsx("button", { type: "button", style: buttonStyle, onClick: () => props.openRecord(sourceId), "aria-label": `${props.t("decisionHistory")}: ${sourceId}`, children: sourceId }, `${sourceId}:${index}`)
        : jsx.jsx("code", { children: sourceId }, `${sourceId}:${index}`);
    }

    function learningSourceList(sourceIds, props) {
      const sources = Array.isArray(sourceIds) ? sourceIds.filter(sourceId => typeof sourceId === "string") : [];
      return sources.length ? jsx.jsx("ul", { style: contextPackListStyle, children: sources.map((sourceId, index) => jsx.jsx("li", { children: learningSource(sourceId, index, props) }, `${sourceId}:${index}`)) }) : jsx.jsx("span", { children: "—" });
    }

    function AgentLearning(props) {
      const t = props.t;
      const learningRevision = props.learning.revision;
      const learningStatus = props.learning.status;
      const agent = props.agent ?? {};
      const runs = learningRows(agent.learningRuns);
      const snapshots = learningRows(agent.snapshots);
      const current = snapshots.find(snapshot => snapshot.snapshotId === agent.currentSnapshotId) ?? (typeof agent.currentSnapshotId === "string" ? { snapshotId: agent.currentSnapshotId, state: "published" } : null);
      const candidateRun = runs.find(run => run.outcome === "candidate") ?? null;
      const candidate = candidateRun ? snapshots.find(snapshot => snapshot.state === "draft" && snapshot.learningRunId === candidateRun.learningRunId) ?? null : null;
      const detail = props.detail?.agentId === agent.agentId ? props.detail : null;
      const candidateRevision = learningRevision(candidate, detail?.snapshot);
      const currentRevision = learningRevision(current, detail?.snapshot);
      const busy = typeof props.pending === "string";
      const canConsolidate = agent.state === "enabled" && !busy && !runs.some(run => run.outcome === "running" || run.outcome === "candidate");
      const canReview = !busy && candidateRun && candidate && Number.isInteger(candidateRevision);
      const canRollback = !busy && current?.state === "published" && Number.isInteger(currentRevision);
      const run = detail?.run ?? null;
      const snapshot = detail?.snapshot ?? null;
      const sourceRecords = learningRows(snapshot?.sourceRecords ?? run?.sourceRecords);
      const diff = snapshot ? principleDiff(detail?.parentSnapshot, snapshot) : [];
      const operations = Array.isArray(run?.operations) ? run.operations.filter(operation => operation && typeof operation === "object") : [];
      const frozen = run?.inputFrozen ? {
        caseCount: Array.isArray(run.inputFrozen.caseIds) ? run.inputFrozen.caseIds.length : 0,
        feedbackCount: Array.isArray(run.inputFrozen.feedbackIds) ? run.inputFrozen.feedbackIds.length : 0,
        parentSnapshotId: run.inputFrozen.parentSnapshotId ?? null,
        parentSnapshotRevision: run.inputFrozen.parentSnapshotRevision ?? null,
        promptVersion: run.inputFrozen.promptVersion ?? null,
        inputHash: run.inputFrozen.inputHash ?? null,
        feedbackDigest: run.inputFrozen.feedbackDigest ?? null,
      } : null;
      return jsx.jsxs("section", { "aria-label": t("decisionLearningGovernance"), style: { display: "grid", gap: "10px", borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: "10px" }, children: [
        jsx.jsxs("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }, children: [
          jsx.jsx("strong", { children: t("decisionLearningGovernance") }, "title"),
          jsx.jsx("button", { type: "button", disabled: !canConsolidate, "aria-busy": props.pending === "learningStart", style: buttonStyle, onClick: () => { if (canConsolidate) return props.run("learningStart", agent.agentId, window.crypto.randomUUID()); }, children: t("decisionConsolidate") }, "consolidate"),
          jsx.jsx("button", { type: "button", disabled: !canReview, style: buttonStyle, onClick: () => { if (canReview) return props.run("snapshotPublish", candidate.snapshotId, candidateRevision); }, children: t("decisionPublish") }, "publish"),
          jsx.jsx("button", { type: "button", disabled: !canReview, style: buttonStyle, onClick: () => { if (canReview) return props.run("snapshotReject", candidate.snapshotId, candidateRevision); }, children: t("decisionReject") }, "reject"),
          jsx.jsx("button", { type: "button", disabled: !canRollback, style: buttonStyle, onClick: () => { if (canRollback) return props.run("snapshotRollback", current.snapshotId, currentRevision); }, children: t("decisionRollback") }, "rollback"),
        ] }, "actions"),
        jsx.jsxs("div", { children: [
          jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionCurrentSnapshot") }, "label"),
          current
            ? jsx.jsx("button", { type: "button", disabled: busy, style: buttonStyle, onClick: () => props.selectSnapshot(current.snapshotId), children: `${current.snapshotId} · v${current.version ?? "—"} · ${learningStatus(t, "decisionSnapshotState", current.state)} · r${currentRevision ?? "—"}` }, "current")
            : jsx.jsx("div", { children: t("decisionNoCurrentSnapshot") }, "empty"),
        ] }, "current"),
        jsx.jsxs("div", { children: [
          jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionLearningRuns") }, "label"),
          runs.length
            ? jsx.jsx("ul", { style: contextPackListStyle, children: runs.map(item => jsx.jsx("li", { children: jsx.jsx("button", { type: "button", disabled: busy, style: buttonStyle, onClick: () => props.selectRun(item.learningRunId), "data-learning-run-id": item.learningRunId, children: `${item.learningRunId} · ${learningStatus(t, "decisionLearningOutcome", item.outcome)} · r${item.revision ?? "—"}` }) }, item.learningRunId)) }, "runs")
            : jsx.jsx("div", { children: t("decisionNoLearningRuns") }, "empty"),
        ] }, "runs"),
        jsx.jsxs("div", { children: [
          jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionSnapshots") }, "label"),
          snapshots.length
            ? jsx.jsx("ul", { style: contextPackListStyle, children: snapshots.map(item => jsx.jsx("li", { children: jsx.jsx("button", { type: "button", disabled: busy, style: buttonStyle, onClick: () => props.selectSnapshot(item.snapshotId), "data-snapshot-id": item.snapshotId, children: `${item.snapshotId} · v${item.version ?? "—"} · ${learningStatus(t, "decisionSnapshotState", item.state)} · r${item.revision ?? "—"}` }) }, item.snapshotId)) }, "snapshots")
            : jsx.jsx("div", { children: t("decisionNoSnapshots") }, "empty"),
        ] }, "snapshots"),
        run ? jsx.jsxs("div", { "data-learning-run-detail": run.learningRunId, style: { display: "grid", gap: "8px", overflowWrap: "anywhere" }, children: [
          jsx.jsx("strong", { children: t("decisionLearningDetail") }, "title"),
          jsx.jsxs("div", { children: [jsx.jsx("code", { children: run.learningRunId }, "id"), ` · ${learningStatus(t, "decisionLearningOutcome", run.outcome)} · `, jsx.jsx("code", { children: run.outcome }, "outcome"), ` · r${run.revision ?? "—"}`] }, "status"),
          frozen ? jsx.jsxs("div", { children: [jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionFrozenInput") }, "label"), jsx.jsx("pre", { children: JSON.stringify(frozen, null, 2) }, "frozen")] }, "frozen") : null,
          jsx.jsxs("div", { children: [
            jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionStructuralReplay") }, "label"),
            jsx.jsx("div", { children: t("decisionStructuralReplayHint") }, "hint"),
            run.replay
              ? jsx.jsxs("div", { children: [jsx.jsx("div", { children: run.replay.passed === true ? t("decisionReplayPassed") : t("decisionReplayFailed") }, "result"), jsx.jsx("pre", { children: JSON.stringify({ detail: run.replay.detail ?? null, metrics: run.replay.metrics ?? {}, finalHash: run.replay.finalHash ?? null }, null, 2) }, "replay")] }, "result")
              : jsx.jsx("div", { children: t("decisionReplayPending") }, "pending"),
          ] }, "replay"),
          sourceRecords.length ? jsx.jsxs("div", { children: [
            jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionSourceRecords") }, "label"),
            jsx.jsx("ul", { style: { listStyle: "none", margin: "4px 0 0", padding: 0, display: "grid", gap: "6px" }, children: sourceRecords.map((record, index) => jsx.jsxs("li", {
              "data-learning-source-record": record.sourceId,
              style: contextPackStyle,
              children: [
                jsx.jsx("code", { children: `${record.kind ?? "source"} · ${record.sourceId} · r${record.revision ?? "—"}` }, "id"),
                record.kind === "case" ? jsx.jsx("pre", { style: { whiteSpace: "pre-wrap", margin: "6px 0 0" }, children: record.excerpt ?? "—" }, "excerpt") : null,
                record.kind === "correction" ? jsx.jsxs("div", { children: [
                  jsx.jsx("div", { style: { marginTop: "6px" }, children: `${t("decisionCorrectionDirection")}: ${record.direction ?? "—"}` }, "direction"),
                  jsx.jsx("pre", { style: { whiteSpace: "pre-wrap", margin: "6px 0 0" }, children: JSON.stringify({ scope: record.scope ?? null, supersedes: record.supersedes ?? [] }, null, 2) }, "scope"),
                ] }, "correction") : null,
              ],
            }, `${record.sourceId}:${index}`)) }, "sources"),
          ] }, "source-records") : null,
          jsx.jsxs("div", { children: [
            jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionOperations") }, "label"),
            operations.length
              ? jsx.jsx("ol", { style: contextPackListStyle, children: operations.map((operation, index) => jsx.jsxs("li", { children: [
                jsx.jsx("div", { children: jsx.jsx("strong", { children: operation.op ?? "—" }) }, "op"),
                jsx.jsx("code", { children: operation.principleId ?? (Array.isArray(operation.targetPrincipleIds) ? operation.targetPrincipleIds.join(", ") : "—") }, "target"),
                typeof operation.text === "string" ? jsx.jsx("div", { children: operation.text }, "text") : null,
                operation.scope === undefined ? null : jsx.jsx("pre", { children: JSON.stringify(operation.scope, null, 2) }, "scope"),
                learningSourceList(operation.sources, { ...props, t }),
              ] }, `${operation.op ?? "operation"}:${index}`)) }, "operations")
              : jsx.jsx("div", { children: t("decisionNoOperations") }, "empty"),
          ] }, "operations"),
          snapshot ? jsx.jsxs("div", { children: [
            jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionPrincipleDiff") }, "label"),
            jsx.jsx("div", { children: `${snapshot.snapshotId} · v${snapshot.version ?? "—"} · ${learningStatus(t, "decisionSnapshotState", snapshot.state)}` }, "snapshot"),
            diff.length
              ? jsx.jsx("ul", { style: contextPackListStyle, children: diff.map(item => jsx.jsxs("li", { children: [
                jsx.jsx("strong", { children: `${item.principleId} · ${t(`decisionDiff${item.change[0].toUpperCase()}${item.change.slice(1)}`)}` }, "change"),
                jsx.jsx("div", { children: `${t("decisionBefore")}: ${item.before?.text ?? "—"}` }, "before"),
                jsx.jsx("div", { children: `${t("decisionAfter")}: ${item.after?.text ?? "—"}` }, "after"),
                jsx.jsx("pre", { children: JSON.stringify({ before: item.before ? { scope: item.before.scope, state: item.before.state, sources: item.before.sources ?? [] } : null, after: item.after ? { scope: item.after.scope, state: item.after.state, sources: item.after.sources ?? [] } : null }, null, 2) }, "states"),
                item.after ? learningSourceList(item.after.sources, { ...props, t }) : null,
              ] }, item.principleId)) }, "diff")
              : jsx.jsx("div", { children: t("decisionNoPrincipleChanges") }, "empty"),
          ] }, "diff") : jsx.jsx("div", { children: t("decisionNoSnapshotForRun") }, "no-snapshot"),
        ] }, "detail") : jsx.jsx("div", { children: t("decisionNoLearningDetail") }, "detail-empty"),
      ] });
    }

    function DecisionPage(props) {
      const t = props.t ?? (key => key);
      const model = props.decisionModel;
      const ui = props.ui;
      const sessionId = props.getSessionId?.() ?? null;
      const actions = props.createDecisionActions(props.connection, sessionId, props.decisionRpc);
      const [tab, setTab] = react.useState("inbox");
      const [resources, setResources] = react.useState(emptyResources);
      const [filter, setFilter] = react.useState({});
      const [selectedCaseId, setSelectedCaseId] = react.useState(null);
      const [drillIn, setDrillIn] = react.useState(false);
      const [pending, setPending] = react.useState(null);
      const [actionError, setActionError] = react.useState(null);
      const [learningDetail, setLearningDetail] = react.useState(null);
      const [drafts, setDrafts] = react.useState({});
      const [confirm, setConfirm] = react.useState(null);
      const [editor, setEditor] = react.useState(null);
      const [selectedAgentId, setSelectedAgentId] = react.useState(null);
      const pendingRef = react.useRef(false);
      const epochRef = react.useRef(0);
      const requestsRef = react.useRef({ agents: 0, inbox: 0, records: 0, metrics: 0, agent: 0, learning: 0, details: {} });
      const tabRef = react.useRef(tab);
      const filterRef = react.useRef(filter);
      const selectedCaseRef = react.useRef(selectedCaseId);
      tabRef.current = tab;
      filterRef.current = filter;
      selectedCaseRef.current = selectedCaseId;
      const view = model.pageView({ tab, agents: resources.agents.value, records: resources.records.value, inbox: resources.inbox.value, metrics: resources.metrics.value });
      const updateDraft = (caseId, field, value) => setDrafts(current => model.draftsReducer(current, { type: "update", sessionId, caseId, field, value }));
      const clearDraft = (caseId, fields) => setDrafts(current => model.draftsReducer(current, { type: "clear", sessionId, caseId, fields }));
      const patchResource = (name, patch) => setResources(current => ({ ...current, [name]: { ...current[name], ...patch } }));
      const readFailure = reason => ["FORBIDDEN", "PERMISSION_DENIED", "UNAUTHORIZED", "WORKSPACE_MISMATCH", "ROOT_SESSION_MISMATCH"].includes(reason?.code) ? t("decisionNoPermission") : t("decisionReadFailed");
      const valid = (kind, token, epoch, requestSession, caseId) => epochRef.current === epoch && sessionId === requestSession
        && (caseId ? requestsRef.current.details[caseId] === token : requestsRef.current[kind] === token);
      const loadAgents = async (requestSession = sessionId, epoch = epochRef.current) => {
        if (!requestSession) return;
        const token = ++requestsRef.current.agents;
        patchResource("agents", { status: "loading", error: null });
        try {
          const value = await actions.agents();
          if (valid("agents", token, epoch, requestSession)) patchResource("agents", { status: "ready", value: Array.isArray(value) ? value : [], error: null });
        } catch (reason) { if (valid("agents", token, epoch, requestSession)) patchResource("agents", { status: "error", error: asError(reason) }); }
      };
      const loadInbox = async (requestSession = sessionId, epoch = epochRef.current) => {
        if (!requestSession) return;
        const token = ++requestsRef.current.inbox;
        patchResource("inbox", { status: "loading", error: null });
        try {
          const value = model.narrowInbox(await actions.inbox());
          if (valid("inbox", token, epoch, requestSession)) patchResource("inbox", { status: "ready", value, error: null });
        } catch (reason) { if (valid("inbox", token, epoch, requestSession)) patchResource("inbox", { status: "error", error: asError(reason) }); }
      };
      const loadRecords = async (nextFilter = filter, requestSession = sessionId, epoch = epochRef.current) => {
        if (!requestSession) return;
        const token = ++requestsRef.current.records;
        patchResource("records", { status: "loading", error: null, value: [], nextCursor: null });
        try {
          const page = model.narrowRecords(await actions.records(nextFilter));
          if (valid("records", token, epoch, requestSession)) patchResource("records", { status: "ready", value: page.records, nextCursor: page.nextCursor, error: null });
        } catch (reason) { if (valid("records", token, epoch, requestSession)) patchResource("records", { status: "error", error: asError(reason) }); }
      };
      const loadMore = async () => {
        const cursor = resources.records.nextCursor;
        if (!sessionId || !cursor || resources.records.status !== "ready" || resources.records.loadingMore) return;
        const requestSession = sessionId;
        const epoch = epochRef.current;
        const token = ++requestsRef.current.records;
        patchResource("records", { loadingMore: true, loadMoreError: null });
        try {
          const page = model.narrowRecords(await actions.records(filter, { after: cursor }));
          if (valid("records", token, epoch, requestSession)) {
            setResources(current => {
              const appended = model.appendRecordPage(current.records.value, page);
              return { ...current, records: { ...current.records, status: "ready", value: appended.records, nextCursor: appended.nextCursor, loadingMore: false, loadMoreError: null } };
            });
          }
        } catch (reason) {
          if (valid("records", token, epoch, requestSession)) patchResource("records", { loadingMore: false, loadMoreError: asError(reason) });
        }
      };
      const loadMetrics = async (requestSession = sessionId, epoch = epochRef.current) => {
        if (!requestSession) return;
        const token = ++requestsRef.current.metrics;
        patchResource("metrics", { status: "loading", error: null });
        try {
          const value = await actions.metrics("all");
          if (valid("metrics", token, epoch, requestSession)) patchResource("metrics", { status: "ready", value: value ?? null, error: null });
        } catch (reason) { if (valid("metrics", token, epoch, requestSession)) patchResource("metrics", { status: "error", error: asError(reason) }); }
      };
      const readRecord = async (caseId, options = {}) => {
        const requestSession = options.sessionId ?? sessionId;
        const epoch = options.epoch ?? epochRef.current;
        if (!requestSession || !caseId) return null;
        if (options.select) { setTab("records"); setSelectedCaseId(caseId); setDrillIn(true); }
        const cached = resources.details[caseId];
        if (!options.force && cached?.status === "ready") return cached.value;
        const token = (requestsRef.current.details[caseId] ?? 0) + 1;
        requestsRef.current.details[caseId] = token;
        setResources(current => ({ ...current, details: { ...current.details, [caseId]: { ...current.details[caseId], status: "loading", error: null } } }));
        try {
          const value = await actions.record(caseId);
          if (!value?.case) throw Object.assign(new Error("Decision record is unavailable"), { code: "CASE_NOT_FOUND" });
          if (valid("details", token, epoch, requestSession, caseId)) setResources(current => ({ ...current, details: { ...current.details, [caseId]: { status: "ready", value, error: null } } }));
          return value;
        } catch (reason) {
          if (valid("details", token, epoch, requestSession, caseId)) {
            const error = asError(reason);
            setResources(current => ({ ...current, details: { ...current.details, [caseId]: { ...current.details[caseId], status: "error", error } } }));
          }
          return null;
        }
      };
      const readLearning = async (agentValue, learningRunId) => {
        const requestSession = sessionId;
        const epoch = epochRef.current;
        const token = ++requestsRef.current.learning;
        const selectedRunId = learningRunId ?? learningRows(agentValue?.learningRuns).find(run => run.outcome === "candidate")?.learningRunId ?? learningRows(agentValue?.learningRuns)[0]?.learningRunId;
        if (!selectedRunId) { if (valid("learning", token, epoch, requestSession)) setLearningDetail(null); return; }
        const selectedRun = await actions.learningRun(selectedRunId);
        const snapshotSummary = learningRows(agentValue?.snapshots).find(snapshot => snapshot.learningRunId === selectedRunId);
        const parentSnapshotId = snapshotSummary?.parentSnapshotId ?? selectedRun?.inputFrozen?.parentSnapshotId ?? null;
        const [selectedSnapshot, parentSnapshot] = await Promise.all([
          snapshotSummary ? actions.memorySnapshot(snapshotSummary.snapshotId) : Promise.resolve(null),
          parentSnapshotId ? actions.memorySnapshot(parentSnapshotId) : Promise.resolve(null),
        ]);
        if (valid("learning", token, epoch, requestSession)) setLearningDetail({ agentId: agentValue.agentId, run: selectedRun, snapshot: selectedSnapshot, parentSnapshot });
      };
      const selectAgent = async agentId => {
        const requestSession = sessionId;
        const epoch = epochRef.current;
        const token = ++requestsRef.current.agent;
        requestsRef.current.learning += 1;
        setSelectedAgentId(agentId); patchResource("agent", { status: "loading", value: null, error: null }); setLearningDetail(null);
        try {
          const value = await actions.agent(agentId);
          if (!valid("agent", token, epoch, requestSession)) return;
          patchResource("agent", { status: "ready", value, error: null });
          await readLearning(value);
        } catch (reason) { if (valid("agent", token, epoch, requestSession)) patchResource("agent", { status: "error", error: asError(reason) }); }
      };
      const run = async (method, ...args) => {
        if (pendingRef.current) return;
        pendingRef.current = true; setPending(method); setActionError(null);
        const requestSession = sessionId;
        const epoch = epochRef.current;
        try {
          const result = await actions[method](...args);
          if (["decide", "reassign", "retry", "cancel", "feedback", "correction"].includes(method)) {
            const caseId = args[0];
            const authoritative = await actions.record(caseId);
            if (!authoritative?.case) throw new Error("Decision record reread returned no record");
            if (epochRef.current !== epoch || sessionId !== requestSession) return;
            setResources(current => ({ ...current, details: { ...current.details, [caseId]: { status: "ready", value: authoritative, error: null } } }));
            await loadInbox(requestSession, epoch);
            if (method === "decide") clearDraft(caseId, ["answers"]);
            if (method === "reassign") clearDraft(caseId, ["reassignTarget"]);
            if (method === "feedback" && args[1] === "comment") clearDraft(caseId, ["comment"]);
            if (method === "correction") clearDraft(caseId, ["correction"]);
          } else if (method === "profileUpsert" || method === "profileSetState") {
            const agentId = method === "profileUpsert" ? result?.agentId : args[0];
            if (typeof agentId !== "string" || !agentId) throw new Error("Assistant reread requires the saved assistant id");
            const [refreshed, agentRows] = await Promise.all([actions.agent(agentId), actions.agents()]);
            if (!refreshed?.agentId) throw new Error("Assistant reread returned no assistant");
            if (epochRef.current !== epoch || sessionId !== requestSession) return;
            setSelectedAgentId(agentId);
            setResources(current => ({ ...current,
              agent: { status: "ready", value: refreshed, error: null },
              agents: { ...current.agents, status: "ready", value: Array.isArray(agentRows) ? agentRows : [], error: null },
            }));
            await readLearning(refreshed);
            if (method === "profileUpsert") setEditor(null);
          } else if (method.startsWith("learning") || method.startsWith("snapshot")) {
            const selected = resources.agent.value;
            if (selected) await selectAgent(selected.agentId);
          }
          setActionError(null);
          return result;
        } catch (reason) {
          if (epochRef.current === epoch && sessionId === requestSession) setActionError(asError(reason, "DECISION_ACTION_FAILED"));
          return undefined;
        } finally { if (epochRef.current === epoch && sessionId === requestSession) { pendingRef.current = false; setPending(null); } }
      };
      const editorDirty = () => editor && ["name", "preference", "scopeText", "routeText"].some(field => editor[field] !== editor.baseline[field]);
      const closeEditor = after => {
        if (editorDirty()) { setConfirm({ kind: "discard-editor", after }); return; }
        setEditor(null); after?.();
      };
      const openCreate = () => closeEditor(() => { setSelectedAgentId(null); patchResource("agent", emptyResource()); setEditor(newAgentEditor()); });
      const openAgent = agentId => closeEditor(() => selectAgent(agentId));
      const saveEditor = async () => {
        if (!editor || pendingRef.current) return;
        let payload;
        try {
          payload = {
            ...(editor.agentId ? { agentId: editor.agentId } : {}), name: editor.name.trim(), userDescription: editor.preference,
            ...(editor.scopeText.trim() ? { scope: JSON.parse(editor.scopeText) } : {}),
            ...(editor.routeText.trim() ? { modelRoute: JSON.parse(editor.routeText) } : {}),
          };
        } catch (reason) { setActionError(asError(reason, "INVALID_ADVANCED_SETTINGS")); return; }
        return run("profileUpsert", payload);
      };
      const filterField = (key, value) => setFilter(current => ({ ...current, [key]: value || undefined }));
      const applyFilters = () => { setSelectedCaseId(null); setDrillIn(false); loadRecords(filter); };
      const navigate = (next, force = false) => {
        if (!force && tab === "agents" && next !== "agents" && editorDirty()) { setConfirm({ kind: "discard-editor", after: () => navigate(next, true) }); return; }
        setTab(next);
        if (next === "records") {
          setDrillIn(false);
          if (resources.records.status === "idle" || resources.records.status === "error") loadRecords(filter);
        } else if (next === "agents" && (resources.agents.status === "idle" || resources.agents.status === "error")) loadAgents();
        else if (next === "inbox" && (resources.inbox.status === "idle" || resources.inbox.status === "error")) loadInbox();
        else if (next === "metrics" && resources.metrics.status !== "loading" && resources.metrics.status !== "ready") loadMetrics();
      };
      react.useEffect(() => {
        const openCaseId = props.consumeOpenCase?.();
        const agentDestination = props.consumeAgentDestination?.();
        const epoch = ++epochRef.current;
        requestsRef.current = { agents: 0, inbox: 0, records: 0, metrics: 0, agent: 0, learning: 0, details: {} };
        pendingRef.current = false;
        setPending(null); setActionError(null); setResources(emptyResources());
        setSelectedCaseId(null); setDrillIn(false); setFilter({}); setLearningDetail(null); setConfirm(null); setSelectedAgentId(null);
        setEditor(agentDestination === "create" && !openCaseId ? newAgentEditor() : null);
        setTab(openCaseId ? "records" : agentDestination ? "agents" : "inbox");
        if (sessionId) {
          loadAgents(sessionId, epoch); loadInbox(sessionId, epoch);
          if (openCaseId) { loadRecords({}, sessionId, epoch); readRecord(openCaseId, { select: true, sessionId, epoch, force: true }); }
        }
        const subscription = props.panelInfo?.subscribe?.(value => {
          if ((value?.activePanelId ?? value) !== PAGE_ID || !sessionId) return;
          loadAgents(sessionId, epoch); loadInbox(sessionId, epoch);
          if (tabRef.current === "records") {
            loadRecords(filterRef.current, sessionId, epoch);
            if (selectedCaseRef.current) readRecord(selectedCaseRef.current, { sessionId, epoch, force: true });
          } else if (tabRef.current === "metrics") loadMetrics(sessionId, epoch);
        });
        return () => { subscription?.(); if (epochRef.current === epoch) epochRef.current += 1; };
      }, [sessionId]);
      const retryState = (resource, retry) => jsx.jsx(ui.ErrorState, { children: jsx.jsxs("div", { className: "weir-da-actions", children: [
        jsx.jsx("span", { children: readFailure(resource.error) }, "message"),
        jsx.jsx(ui.Button, { onClick: retry, children: t("decisionRetry") }, "retry"),
      ] }) });
      const noSession = jsx.jsx(ui.EmptyState, { children: t("decisionNoSession") });
      const inboxContent = !sessionId ? noSession
        : resources.inbox.status === "error" ? retryState(resources.inbox, () => loadInbox())
        : resources.inbox.status !== "ready" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : resources.inbox.value.length ? jsx.jsx("div", { className: "weir-da-card-list", children: resources.inbox.value.map(item => jsx.jsx(InboxItem, {
            item, agents: resources.agents.value, run, pending, model, ui, t,
            draft: model.readDraft(drafts, sessionId, item.caseId), updateDraft: (field, value) => updateDraft(item.caseId, field, value),
            evidence: resources.details[item.caseId], loadEvidence: force => readRecord(item.caseId, { force }),
            requestCancel: () => setConfirm({ kind: "cancel", caseId: item.caseId }),
          }, item.caseId)) })
        : jsx.jsx(ui.EmptyState, { children: t("decisionInboxEmpty") });
      const selectedDetail = selectedCaseId ? resources.details[selectedCaseId] : null;
      const recordContent = !sessionId ? noSession
        : selectedDetail?.status === "loading" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : selectedDetail?.status === "error" ? retryState(selectedDetail, () => readRecord(selectedCaseId, { force: true }))
        : selectedDetail?.value ? RecordDetail({
            detail: selectedDetail.value, agents: resources.agents.value, model, ui, t, run, pending,
            draft: model.readDraft(drafts, sessionId, selectedCaseId), updateDraft: (field, value) => updateDraft(selectedCaseId, field, value),
          })
        : jsx.jsx(ui.EmptyState, { children: t("decisionSelectRecord") });
      const listBody = resources.records.status === "error" ? retryState(resources.records, () => loadRecords(filter))
        : resources.records.status !== "ready" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : resources.records.value.length ? resources.records.value.map(record => {
          const summary = model.recordSummary(record, resources.agents.value);
          return jsx.jsxs(ui.Button, { className: "weir-da-record-row", "data-case-id": record.caseId, "aria-pressed": selectedCaseId === record.caseId, onClick: () => readRecord(record.caseId, { select: true }), children: [
            jsx.jsx("strong", { children: summary?.title ?? t("decisionRecord") }, "title"),
            jsx.jsx("span", { children: `${summary?.agentName ?? t("decisionSelector")} · ${t(summary?.statusKey ?? "decisionStatusUnknown")}` }, "meta"),
            summary?.time ? jsx.jsx("time", { children: readableTime(summary.time) }, "time") : null,
          ] }, record.caseId);
        }) : jsx.jsx(ui.EmptyState, { children: t(model.recordEmptyState({ sessionId, filtered: Object.values(filter).some(Boolean) })) });
      const recordsContent = !sessionId ? noSession : jsx.jsxs("div", { className: "weir-da-records-view", children: [
        RecordFilters({ filter, agents: resources.agents.value, model, ui, t, onChange: filterField, onApply: applyFilters }),
        jsx.jsxs("div", { className: "weir-da-records-layout", "data-drill-in": drillIn, children: [
          jsx.jsxs("div", { className: "weir-da-record-list", "aria-label": t("decisionRecords"), children: [
            listBody,
            resources.records.loadMoreError ? retryState({ error: resources.records.loadMoreError }, loadMore) : null,
            resources.records.nextCursor ? jsx.jsx(ui.Button, { "data-load-more": true, disabled: resources.records.loadingMore, "aria-busy": resources.records.loadingMore === true, onClick: loadMore, children: resources.records.loadingMore ? t("decisionLoadingShort") : t("decisionLoadMore") }, "more") : null,
          ] }, "list"),
          jsx.jsxs("div", { className: "weir-da-record-detail-pane", children: [
            jsx.jsx(ui.Button, { variant: "ghost", className: "weir-da-record-back", onClick: () => setDrillIn(false), children: t("decisionBackToRecords") }, "back"),
            recordContent,
          ] }, "detail"),
        ] }, "layout"),
      ] });
      const selectedAgent = resources.agent.status === "ready" ? resources.agent.value : null;
      const agentsContent = !sessionId ? noSession : jsx.jsxs("div", { className: "weir-da-agents-view", children: [
        jsx.jsxs("div", { className: "weir-da-section-header", children: [
          jsx.jsx("h2", { children: t("decisionAgents") }, "title"),
          jsx.jsx(ui.Button, { variant: "primary", "data-action": "create-agent", onClick: openCreate, disabled: pending !== null, children: t("decisionCreateAgent") }, "create"),
        ] }, "header"),
        editor ? AgentEditor({
          editor, ui, t, pending: pending !== null, onSave: saveEditor, onCancel: () => closeEditor(),
          onField: (field, value) => setEditor(current => ({ ...current, [field]: value })),
        }) : jsx.jsxs("div", { className: "weir-da-card-list", children: [
          resources.agents.status === "error" ? retryState(resources.agents, () => loadAgents())
            : resources.agents.status !== "ready" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
            : resources.agents.value.length ? resources.agents.value.map(agent => AgentSummary({ agent, detail: selectedAgent, ui, t, onOpen: openAgent }))
            : jsx.jsx(ui.EmptyState, { children: t("decisionNoAgents") }),
          resources.agent.status === "loading" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") }, "agent-loading") : null,
          resources.agent.status === "error" ? retryState(resources.agent, () => selectAgent(selectedAgentId)) : null,
          selectedAgent ? AgentDetail({
            agent: selectedAgent, ui, t, onEdit: () => setEditor(newAgentEditor(selectedAgent)),
            requestState: state => setConfirm({ kind: "agent-state", agentId: selectedAgent.agentId, state }),
            learningProps: {
              detail: learningDetail, run, pending, t, learning: props.learning,
              selectRun: learningRunId => readLearning(selectedAgent, learningRunId),
              selectSnapshot: snapshotId => {
                const snapshot = learningRows(selectedAgent.snapshots).find(item => item.snapshotId === snapshotId);
                return snapshot?.learningRunId ? readLearning(selectedAgent, snapshot.learningRunId) : Promise.resolve();
              },
              openRecord: caseId => readRecord(caseId, { select: true, force: true }),
            },
          }) : null,
        ] }, "content"),
      ] });
      const confirmation = confirm?.kind === "cancel" ? jsx.jsx(ui.ConfirmDialog, {
        id: "weir-da-cancel-decision", title: t("decisionCancelTitle"), body: t("decisionCancelConfirmation"),
        confirmLabel: t("decisionCancel"), cancelLabel: t("decisionKeepEditing"), danger: true, pending: pending !== null,
        onCancel: () => setConfirm(null), onConfirm: () => { const caseId = confirm.caseId; setConfirm(null); return run("cancel", caseId); },
      }) : confirm?.kind === "discard-editor" ? jsx.jsx(ui.ConfirmDialog, {
        id: "weir-da-discard-editor", title: t("decisionDiscardTitle"), body: t("decisionDiscardConfirmation"),
        confirmLabel: t("decisionDiscard"), cancelLabel: t("decisionKeepEditing"), danger: true,
        onCancel: () => setConfirm(null), onConfirm: () => { const after = confirm.after; setConfirm(null); setEditor(null); return after?.(); },
      }) : confirm?.kind === "agent-state" ? jsx.jsx(ui.ConfirmDialog, {
        id: "weir-da-agent-state", title: t(confirm.state === "archived" ? "decisionArchiveTitle" : confirm.state === "disabled" ? "decisionDisableTitle" : "decisionEnableTitle"),
        body: t(confirm.state === "archived" ? "decisionArchiveConfirmation" : confirm.state === "disabled" ? "decisionDisableConfirmation" : "decisionEnableConfirmation"),
        confirmLabel: t(confirm.state === "archived" ? "decisionArchiveAgent" : confirm.state === "disabled" ? "decisionDisableAgent" : "decisionEnableAgent"),
        cancelLabel: t("decisionCancel"), danger: confirm.state === "archived", pending: pending !== null,
        onCancel: () => setConfirm(null), onConfirm: () => { const { agentId, state } = confirm; setConfirm(null); return run("profileSetState", agentId, state); },
      }) : null;
      const metricsContent = !sessionId ? noSession : resources.metrics.status === "error" ? retryState(resources.metrics, () => loadMetrics())
        : resources.metrics.status !== "ready" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : MetricsDetails({ metrics: resources.metrics.value, model, ui, t });
      return jsx.jsxs("main", { className: "weir-da-page", children: [
        jsx.jsx(ui.DecisionStyles, {}, "styles"),
        jsx.jsxs("div", { className: "weir-da-page-inner", children: [
          jsx.jsxs("header", { className: "weir-da-page-header", children: [
            jsx.jsxs("div", { children: [jsx.jsx("h1", { children: t("decisionSelector") }, "title"), jsx.jsx("p", { children: t("decisionPageDescription") }, "description")] }, "copy"),
            jsx.jsx(ui.Button, { variant: "ghost", "data-view": "metrics", onClick: () => navigate("metrics"), "aria-pressed": view.tab === "metrics", children: t("decisionAdvancedDiagnostics") }, "advanced"),
          ] }, "header"),
          jsx.jsx("nav", { className: "weir-da-primary-nav", "aria-label": t("decisionPrimaryNavigation"), "data-decision-primary-nav": true, children: view.tabs.map(id => jsx.jsx(ui.Button, {
            "data-view": id, onClick: () => navigate(id), "aria-pressed": view.tab === id,
            children: jsx.jsxs("span", { children: [t(`decision${id[0].toUpperCase()}${id.slice(1)}`), id === "inbox" && resources.inbox.status === "ready" ? jsx.jsx("span", { className: "weir-da-count", "data-inbox-count": resources.inbox.value.length, "aria-label": `${resources.inbox.value.length}` }, "count") : null] }),
          }, id)) }, "nav"),
          actionError ? jsx.jsx(ui.ErrorState, { children: t(model.errorKey(actionError)) }, "action-error") : null,
          view.tab === "inbox" ? jsx.jsx("section", { "data-view": "inbox", className: "weir-da-view", children: inboxContent }, "inbox") : null,
          view.tab === "records" ? jsx.jsx("section", { "data-view": "records", className: "weir-da-view", children: recordsContent }, "records") : null,
          view.tab === "agents" ? jsx.jsx("section", { "data-view": "agents", className: "weir-da-view", children: agentsContent }, "agents") : null,
          view.tab === "metrics" ? jsx.jsx("section", { "data-view": "metrics", className: "weir-da-view", children: metricsContent }, "metrics") : null,
        ] }, "content"),
        confirmation,
      ] });
    }

    exports.PAGE_ID = PAGE_ID;
    exports.DecisionPage = DecisionPage;
    exports.InboxItem = InboxItem;
    exports.AttemptContextPack = AttemptContextPack;
    exports.AgentLearning = AgentLearning;
    exports.principleDiff = principleDiff;
    return module.exports;
  },
});
