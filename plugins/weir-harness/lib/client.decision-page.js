window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-page.js",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const PAGE_ID = "weir-decisions";
    const contextPackStyle = { background: "var(--dsw-alias-bg-base)", border: "0.5px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)", padding: "6px 8px" };
    const contextPackBodyStyle = { display: "grid", gap: "8px", paddingTop: "8px", fontSize: "var(--dsw-font-xxs-12-font-size)", lineHeight: "var(--dsw-font-xxs-12-line-height)" };
    const contextPackLabelStyle = { color: "var(--dsw-alias-label-secondary)", fontWeight: 600 };
    const contextPackListStyle = { margin: "4px 0 0", paddingLeft: "22px", overflowWrap: "anywhere" };

    function decisionPageVisualViewport(view) {
      const viewport = view?.visualViewport;
      const scale = Number(viewport?.scale ?? 1);
      if (!viewport || !Number.isFinite(scale) || scale <= 1) return null;
      const width = Number(viewport.width);
      const height = Number(viewport.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
      const offsetLeft = Number(viewport.offsetLeft ?? 0);
      const offsetTop = Number(viewport.offsetTop ?? 0);
      const left = Number.isFinite(offsetLeft) ? offsetLeft : 0;
      const top = Number.isFinite(offsetTop) ? offsetTop : 0;
      return {
        compact: width <= 760,
        style: {
          position: "fixed", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
          margin: "0px", maxWidth: "none", maxHeight: "none", zIndex: 1000,
        },
      };
    }

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
      if (memory.l2 === "used") rows.push(`${props.t("decisionWorkspaceExperience")}: ${props.t("decisionReviewedPrinciplesUsed")} (${memory.l2Count})`);
      else if (memory.l2 === "pinned-empty") rows.push(`${props.t("decisionWorkspaceExperience")}: ${props.t("decisionPinnedEmpty")}`);
      else if (memory.l2 === "empty") rows.push(`${props.t("decisionWorkspaceExperience")}: ${props.t("decisionNoReviewedPrinciples")}`);
      if (memory.public === "used") rows.push(`${props.t("decisionPublicMemory")}: ${props.t("decisionPublicGuidanceUsed")} (${memory.publicCount})`);
      else if (memory.public === "pinned-empty") rows.push(`${props.t("decisionPublicMemory")}: ${props.t("decisionPublicPinnedEmpty")}`);
      else if (memory.public === "empty") rows.push(`${props.t("decisionPublicMemory")}: ${props.t("decisionNoPublicGuidance")}`);
      else rows.push(`${props.t("decisionPublicMemory")}: ${props.t("decisionPublicLegacy")}`);
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
      const parts = [];
      if (Array.isArray(scope.workspaces) && scope.workspaces.length) parts.push(t("decisionScopeCurrentWorkspace"));
      for (const key of ["paths", "tags"]) for (const value of Array.isArray(scope[key]) ? scope[key] : []) if (typeof value === "string") parts.push(value);
      if (Array.isArray(scope.authorizationClasses)) parts.push(`${t("decisionAuthorizationClasses")}: ${scope.authorizationClasses.join(", ")}`);
      return parts.length ? parts.join(" · ") : t("decisionCurrentScope");
    }

    // A public surface is ordinary language, never provenance: a hint that would
    // carry an absolute path or a record id is dropped instead of rendered.
    const UNSAFE_PUBLIC_HINT = /^(?:[A-Za-z]:[\\/]|~[\\/]|\\\\|\/|file:)|\b(?:dc|ev|fb|lr|ms)_[A-Za-z0-9][A-Za-z0-9_-]{5,}/;
    const PUBLIC_CHANGE_OP_KEYS = {
      add: "decisionPublicOpAdd", refine: "decisionPublicOpRefine", merge: "decisionPublicOpMerge",
      narrow: "decisionPublicOpNarrow", retire: "decisionPublicOpRetire",
    };

    function publicOpLabel(op, t) {
      const key = PUBLIC_CHANGE_OP_KEYS[op];
      return key ? t(key) : String(op ?? "");
    }

    /** Workspace-agnostic scope hints, formatted for reading. */
    function publicScopeText(scope, t) {
      const value = scope && typeof scope === "object" ? scope : {};
      const parts = [];
      for (const key of ["paths", "tags"]) {
        for (const entry of Array.isArray(value[key]) ? value[key] : []) {
          if (typeof entry === "string" && entry && !UNSAFE_PUBLIC_HINT.test(entry)) parts.push(entry);
        }
      }
      for (const entry of Array.isArray(value.authorizationClasses) ? value.authorizationClasses : []) {
        if (typeof entry === "string" && entry) parts.push(`${t("decisionAuthorizationClasses")}: ${entry}`);
      }
      return parts.join(" · ");
    }

    /**
     * The wording a reviewer must be able to read before adopting or discarding:
     * the operation's own text, else the candidate principle's text (narrow),
     * else the published principle text the change retires.
     */
    function publicChangeWording(change, view) {
      const candidate = (Array.isArray(view.principles) ? view.principles : []).find(item => item.principleId === change.principleId);
      const published = (Array.isArray(view.current?.principles) ? view.current.principles : []).find(item => item.principleId === change.principleId);
      const found = [change.text, candidate?.text, published?.text]
        .find(value => typeof value === "string" && value.trim());
      return found ?? "";
    }

    function RecordDetail(props) {
      const { detail, model, ui, t, draft } = props;
      const agents = Array.isArray(props.agents) ? props.agents : [];
      const view = model.cardView(detail, agents, t);
      const current = detail.case;
      const questions = Array.isArray(current.request?.questions) ? current.request.questions : [];
      const answers = Array.isArray(current.decision?.answers) ? current.decision.answers : [];
      const previous = (view?.history ?? []).filter(group => group.attempt?.attemptId !== view.currentAttempt?.attemptId);
      const pending = typeof props.pending === "string";
      const feedback = Array.isArray(detail.feedback) ? detail.feedback : [];
      const feedbackKeys = { rating_up: "decisionUp", rating_down: "decisionDown", undo_rating_up: "decisionUndoUp", undo_rating_down: "decisionUndoDown", comment: "decisionComment", correction: "decisionCorrect", clarify: "decisionClarifyRecord" };
      return jsx.jsxs("article", { className: "weir-da-card weir-da-record-detail", "data-record-detail": current.caseId, children: [
        jsx.jsxs("header", { className: "weir-da-card-header", children: [
          jsx.jsxs("div", { children: [
            jsx.jsx("h2", { children: view?.questionSummary || t("decisionRecord") }, "title"),
            jsx.jsx("p", { className: "weir-da-caption", children: view?.agentName ?? t("decisionSelector") }, "agent"),
            view?.routeStatusKey ? jsx.jsx("p", { className: "weir-da-caption", "data-route-status": true, children: t(view.routeStatusKey) }, "route-status") : null,
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
        jsx.jsx(ui.Disclosure, { id: `weir-da-record-routes-${current.caseId}`, label: t("decisionRouteHistory"), revealOnOpen: "end", children: () => jsx.jsx(ui.DecisionRouteHistory, { history: view?.routeHistory, t }) }, "route-history"),
        jsx.jsxs("section", { children: [
          jsx.jsx("h3", { children: t("decisionFeedbackHistory") }, "title"),
          feedback.length ? jsx.jsx("ul", { children: feedback.map((entry, index) => jsx.jsx("li", { children: `${t(feedbackKeys[entry?.kind] ?? "decisionComment")}: ${entry?.payload?.text ?? entry?.payload?.direction ?? t("decisionNoAnswer")}` }, entry?.feedbackId ?? index)) }) : jsx.jsx("p", { className: "weir-da-caption", children: t("decisionNoFeedback") }),
        ] }, "feedback-history"),
        view?.assigned ? jsx.jsxs("section", { className: "weir-da-feedback-editor", children: [
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
        ] }, "feedback-actions") : null,
        jsx.jsx(ui.Disclosure, { id: `weir-da-record-advanced-${current.caseId}`, label: t("decisionAdvancedDiagnostics"), revealOnOpen: "end", children: () => jsx.jsxs("div", { className: "weir-da-advanced-record", children: [
          ...(view?.history ?? []).map((group, index) => AttemptContextPack({ attempt: group.attempt, t })),
          jsx.jsx("pre", { children: JSON.stringify(detail, null, 2) }, "raw"),
        ] }) }, "advanced"),
      ] });
    }

    // User autonomy on a pending inbox item: clarify with the owning assistant
    // (read-only, from the current evidence) or bounce the question back to its
    // initiator with a required note.
    function inboxUserTools(props, current, summary) {
      const { t, ui, draft } = props;
      const pending = typeof props.pending === "string";
      const clarifications = (Array.isArray(props.evidence?.value?.feedback) ? props.evidence.value.feedback : []).filter(entry => entry?.kind === "clarify");
      const clarifyCount = clarifications.length;
      const latestClarify = clarifications.at(-1);
      // The inbox card reuses the transcript card's grouping: the clarification
      // block, the response entries and their editors sit in ONE wrapper so the
      // hairline closes the whole response group instead of separating an open
      // editor from the entry that owns it.
      return jsx.jsxs("section", { className: "weir-da-user-tools", "data-user-tools": true, children: [
        latestClarify ? jsx.jsxs("div", { className: "weir-da-clarification", "data-clarification": true, children: [
          jsx.jsxs("div", { children: [jsx.jsx("strong", { children: t("decisionClarifyYouAsked") }, "q-label"), jsx.jsx("span", { children: latestClarify.payload?.question ?? "" }, "q")] }, "question"),
          jsx.jsxs("div", { children: [jsx.jsx("strong", { children: t("decisionClarifyAnswer") }, "a-label"), jsx.jsx("span", { children: latestClarify.payload?.answer ?? "" }, "a")] }, "answer"),
        ] }, "latest-clarify") : null,
        jsx.jsxs("div", { className: "weir-da-actions weir-da-user-actions", children: [
          summary?.assigned !== false && current.agentId ? jsx.jsx(ui.Button, { variant: "secondary", "data-action": "open-clarify", disabled: pending || clarifyCount >= 3, onClick: () => props.updateDraft("clarifyQuestion", draft.clarifyQuestion ?? ""), title: clarifyCount >= 3 ? t("decisionClarifyLimit") : undefined, children: t("decisionClarify") }, "open-clarify") : null,
          jsx.jsx(ui.Button, { variant: "secondary", "data-action": "open-bounce", disabled: pending, onClick: () => props.updateDraft("bounceNote", draft.bounceNote ?? ""), children: t("decisionBounce") }, "open-bounce"),
        ] }, "entries"),
        draft.clarifyQuestion !== undefined ? jsx.jsxs("div", { className: "weir-da-feedback-editor weir-da-user-editor", children: [
          jsx.jsx(ui.Field, { id: `weir-da-inbox-clarify-${current.caseId}`, label: t("decisionClarify"), hint: t("decisionClarifyHint"), children: jsx.jsx("textarea", {
            id: `weir-da-inbox-clarify-${current.caseId}`, "data-draft": "clarifyQuestion", "aria-label": t("decisionClarify"), value: draft.clarifyQuestion ?? "", disabled: pending,
            placeholder: t("decisionClarifyPlaceholder"),
            onChange: event => props.updateDraft("clarifyQuestion", event.target.value),
          }) }, "clarify-field"),
          jsx.jsx(ui.Button, { "data-action": "clarify", disabled: pending || !(draft.clarifyQuestion ?? "").trim(), onClick: () => props.run("clarify", current.caseId, (draft.clarifyQuestion ?? "").trim()), children: t("decisionClarifySubmit") }, "clarify"),
        ] }, "clarify-editor") : null,
        draft.bounceNote !== undefined ? jsx.jsxs("div", { className: "weir-da-feedback-editor weir-da-user-editor", children: [
          jsx.jsx(ui.Field, { id: `weir-da-inbox-bounce-${current.caseId}`, label: t("decisionBounce"), hint: t("decisionBounceHint"), children: jsx.jsx("textarea", {
            id: `weir-da-inbox-bounce-${current.caseId}`, "data-draft": "bounceNote", "aria-label": t("decisionBounce"), value: draft.bounceNote ?? "", disabled: pending,
            placeholder: t("decisionBouncePlaceholder"),
            onChange: event => props.updateDraft("bounceNote", event.target.value),
          }) }, "bounce-field"),
          jsx.jsx(ui.Button, { variant: "secondary", "data-action": "bounce", disabled: pending || !(draft.bounceNote ?? "").trim(), onClick: () => props.run("returnToCaller", current.caseId, (draft.bounceNote ?? "").trim()), children: t("decisionBounceSubmit") }, "bounce"),
        ] }, "bounce-editor") : null,
      ] }, "user-tools");
    }

    function InboxItem(props) {
      const current = props.item;
      const { t, ui, model, draft } = props;
      // The loaded record is the authoritative route history when it is already
      // here; before that the inbox projection's bounded routeStatus keeps a
      // routing failure from reading as "no assistant matched".
      const detail = props.evidence?.value;
      const summary = model.recordSummary(current, props.agents, t, detail?.routeDecisions ?? []);
      const questions = Array.isArray(current.request?.questions) ? current.request.questions : [];
      const pending = typeof props.pending === "string";
      const suggestions = Array.isArray(current.escalation?.suggestion) ? current.escalation.suggestion : [];
      const perQuestion = Array.isArray(current.escalation?.perQuestion) ? current.escalation.perQuestion : [];
      // The shared answer form owns the tentative-suggestion block now, so its
      // per-question reasons arrive already translated from the decision model.
      const suggestionReasons = perQuestion.map(entry => ({ id: entry?.id, reason: t(model.reasonKey(entry?.detail) ?? "decisionReasonUnknown") }));
      const evidenceView = detail ? model.cardView(detail, props.agents, t) : null;
      const evidenceRevealReady = props.evidence?.status === "ready" || props.evidence?.status === "error";
      return jsx.jsxs("article", { className: "weir-da-card weir-da-inbox-card", "data-case-id": current.caseId, children: [
        jsx.jsxs("header", { className: "weir-da-card-header", children: [
          jsx.jsxs("div", { children: [
            jsx.jsx("h2", { children: summary?.title ?? t("decisionRecord") }, "title"),
            jsx.jsx("p", { className: "weir-da-caption", children: summary?.agentName ?? t("decisionSelector") }, "agent"),
            jsx.jsxs("p", { className: "weir-da-caption", "data-inbox-workspace": true, children: [`${t("decisionInboxSourceWorkspace")}: `, jsx.jsx("strong", { children: props.workspaceLabel ?? t("decisionInboxOtherWorkspace") }, "label")] }, "workspace"),
            // An inactive source only labels "not running": delivery resumes a
            // stopped session, so no action is disabled by this flag.
            current.sourceActive === false ? jsx.jsx("p", { className: "weir-da-caption", "data-inbox-source-inactive": true, children: t("decisionInboxSourceInactive") }, "source-inactive") : null,
            props.openSourceSession && props.onOpenSourceSession ? jsx.jsx(ui.Button, { variant: "ghost", "data-action": "open-source-session", onClick: props.onOpenSourceSession, children: t("decisionInboxOpenSourceSession") }, "source-session") : null,
            evidenceView?.routeStatusKey ? jsx.jsx("p", { className: "weir-da-caption", "data-route-status": true, children: t(evidenceView.routeStatusKey) }, "route-status") : null,
          ] }, "copy"),
          jsx.jsx(ui.Badge, { variant: "warn", children: t(summary?.statusKey ?? "decisionStatusAwaitingUser") }, "status"),
        ] }, "header"),
        // The escalation reason is the one thing the user must not miss: it is
        // an accent-barred notice, not another flat paragraph.
        jsx.jsx(ui.Notice, { tone: "warn", children: current.escalation?.missing?.[0] ?? t(evidenceView?.reasonKey ?? summary?.reasonKey ?? "decisionReasonUnknown") }, "reason"),
        // The tentative suggestions are rendered once, inside the shared answer
        // form, so the inbox card hosts no second copy above it.
        jsx.jsx(ui.DecisionAnswers, {
          questions, answers: draft.answers, suggestions, perQuestion: suggestionReasons, pending, collapseTitle: summary?.title,
          onChange: value => props.updateDraft("answers", value), onSubmit: value => props.run("decide", current.caseId, value), t,
        }, "answers"),
        inboxUserTools(props, current, summary),
        jsx.jsx(ui.Disclosure, {
          id: `weir-da-evidence-${current.caseId}`, label: t("decisionEvidence"), onOpen: () => props.loadEvidence(false),
          revealOnOpen: "end", revealReady: evidenceRevealReady,
          children: () => props.evidence?.status === "loading" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
            : props.evidence?.status === "error" ? jsx.jsx(ui.ErrorState, { children: jsx.jsx(ui.Button, { onClick: () => props.loadEvidence(true), children: t("decisionRetry") }) })
            : evidenceView ? EvidenceList({ evidence: evidenceView.evidence, ui, t }) : jsx.jsx(ui.EmptyState, { children: t("decisionNoEvidence") }),
        }, "evidence"),
        jsx.jsx(ui.Disclosure, {
          id: `weir-da-inbox-routes-${current.caseId}`, label: t("decisionRouteHistory"), onOpen: () => props.loadEvidence(false),
          revealOnOpen: "end", revealReady: evidenceRevealReady,
          children: () => props.evidence?.status === "loading" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
            : props.evidence?.status === "error" ? jsx.jsx(ui.ErrorState, { children: jsx.jsx(ui.Button, { onClick: () => props.loadEvidence(true), children: t("decisionRetry") }) })
              : jsx.jsx(ui.DecisionRouteHistory, { history: evidenceView?.routeHistory ?? [], t }),
        }, "route-history"),
        jsx.jsx(ui.Disclosure, { id: `weir-da-recovery-${current.caseId}`, label: t("decisionRecoveryActions"), revealOnOpen: "end", children: jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsxs("select", { value: draft.reassignTarget, onChange: event => props.updateDraft("reassignTarget", event.target.value), "aria-label": t("decisionReassign"), className: "weir-da-select", disabled: pending, children: [
            jsx.jsx("option", { value: "", children: t("decisionChooseAssistant") }, "empty"),
            ...props.agents.filter(agent => agent.state === "enabled").map(agent => jsx.jsx("option", { value: agent.agentId, children: agent.name }, agent.agentId)),
          ] }, "target"),
          jsx.jsx(ui.Button, { disabled: !draft.reassignTarget || pending, onClick: () => props.run("reassign", current.caseId, draft.reassignTarget), children: t("decisionReassign") }, "reassign"),
          summary?.canRetry ? jsx.jsx(ui.Button, { disabled: pending, onClick: () => props.run("retry", current.caseId), children: t("decisionRetry") }, "retry") : null,
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
      // One toolbar row: the two common filters, the apply action and both
      // disclosure entries. Advanced filters expand underneath the row instead
      // of adding a second full-width bar.
      return jsx.jsxs("section", { className: "weir-da-filters", "aria-label": t("decisionRecordFilters"), children: [
        FilterSelect({ name: "agentId", label: t("decisionFilterAgent"), allLabel: t("decisionAllAssistants"), value: filter.agentId, onChange: change("agentId"), options: props.agents.map(agent => ({ value: agent.agentId, label: agent.name })) }),
        FilterSelect({ name: "state", label: t("decisionFilterState"), allLabel: t("decisionAllStates"), value: filter.state, onChange: change("state"), options: options(Object.keys(stateKeys), stateKeys) }),
        jsx.jsx(ui.Button, { variant: "primary", onClick: props.onApply, children: t("decisionApplyFilters") }, "apply"),
        jsx.jsx(ui.Disclosure, { id: "weir-da-more-record-filters", label: t("decisionMoreFilters"), children: () => jsx.jsxs("div", { className: "weir-da-filter-row weir-da-filter-advanced", children: [
          FilterSelect({ name: "outcome", label: t("decisionFilterOutcome"), allLabel: t("decisionAllOutcomes"), value: filter.outcome, onChange: change("outcome"), options: options(Object.keys(outcomeKeys), outcomeKeys) }),
          FilterSelect({ name: "reasonCode", label: t("decisionFilterReason"), allLabel: t("decisionAllReasons"), value: filter.reasonCode, onChange: change("reasonCode"), options: ["INVALID_PREMISE", "MISSING_CONTEXT", "OUT_OF_SCOPE", "CONFLICTING_EVIDENCE", "STALE_EVIDENCE", "UNSUPPORTED_OPTIONS"].map(value => ({ value, label: t(model.reasonKey(value)) })) }),
          jsx.jsxs("label", { className: "weir-da-filter", children: [
            jsx.jsx("span", { children: t("decisionFilterScope") }, "label"),
            jsx.jsx("input", { "data-filter": "scope", "aria-label": t("decisionFilterScope"), value: filter.scope ?? "", onChange: change("scope") }, "input"),
          ] }, "scope"),
          FilterSelect({ name: "feedbackState", label: t("decisionFilterFeedback"), allLabel: t("decisionAllFeedback"), value: filter.feedbackState, onChange: change("feedbackState"), options: options(Object.keys(feedbackKeys), feedbackKeys) }),
        ] }) }, "advanced"),
        props.advanced ?? null,
      ] });
    }

    /**
     * The explicit data export lives in the records advanced area: one button, a
     * disclosure explaining the scope and the destination, and nothing that
     * changes a list, a filter or a detail.
     */
    function RecordsAdvancedActions(props) {
      const { view, ui, t } = props;
      return jsx.jsx(ui.Disclosure, { id: "weir-da-records-advanced", label: t("decisionExportAdvanced"), revealOnOpen: "end", children: () => jsx.jsxs("div", { className: "weir-da-export", "data-record-export": true, children: [
        jsx.jsx("p", { className: "weir-da-caption", children: t("decisionExportHint") }, "hint"),
        jsx.jsx(ui.Button, { ref: props.buttonRef, "data-action": "export", disabled: view.busy, "aria-busy": view.busy, onClick: () => { if (!view.busy) return props.onRequest(); }, children: t(view.busy ? "decisionExporting" : "decisionExport") }, "start"),
      ] }) }, "advanced");
    }

    /**
     * A real result or an actionable failure — never a fabricated success. The
     * success surface shows the real path, size and checksum plus a copy action.
     */
    function ExportResult(props) {
      const { view, ui, t } = props;
      if (view.errorKey) {
        return jsx.jsx("section", { className: "weir-da-export-result", "data-export-result": "error", role: "alert", children: jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx("span", { "data-export-error": view.errorKey, children: t(view.errorKey) }, "message"),
          jsx.jsx(ui.Button, { "data-action": "export-retry", disabled: view.busy, onClick: () => { if (!view.busy) return props.onRetry(); }, children: t("decisionExportRetry") }, "retry"),
        ] }) });
      }
      if (!view.result) return null;
      return jsx.jsxs("section", { className: "weir-da-export-result", "data-export-result": "success", role: "status", children: [
        jsx.jsx("h3", { children: t("decisionExportSucceeded") }, "title"),
        jsx.jsx("p", { "data-export-file": true, children: `${t("decisionExportFile")}: ${view.result.file}` }, "file"),
        jsx.jsx("p", { "data-export-bytes": true, children: `${t("decisionExportBytes")}: ${view.result.bytesText}` }, "bytes"),
        jsx.jsx("p", { "data-export-sha256": true, children: `${t("decisionExportChecksum")}: ${view.result.sha256}` }, "checksum"),
        jsx.jsx(ui.Button, { "data-action": "export-copy", onClick: () => props.onCopy(), children: t(view.copied ? "decisionExportCopied" : "decisionExportCopyPath") }, "copy"),
      ] });
    }

    function agentStateKey(state) {
      return state === "enabled" ? "decisionAgentStateEnabled" : state === "disabled" ? "decisionAgentStateDisabled" : state === "archived" ? "decisionAgentStateArchived" : "decisionStatusUnknown";
    }
    // ---- assistant expertise scope and model route (visual editing) ----
    // The closed authorization class set, in canonical order: the same three
    // values the settings whitelist accepts. The generated scope arrays follow
    // this order, never the click order.
    const AGENT_SCOPE_CLASSES = ["A", "B", "C"];

    /** Trimmed, de-duplicated, non-empty entries — empty rows stay in the local
     * row list (so the user keeps their unfinished line) but never enter JSON. */
    function nonEmptyRows(rows) {
      return [...new Set((Array.isArray(rows) ? rows : []).map(row => row.trim()).filter(row => row.length > 0))];
    }

    /** The staged scope JSON as local editor state: paths/tags as typed rows and
     * the selected authorization classes. A missing `authorizationClasses` key
     * (the create form's empty text, or a legacy text without the key) opens
     * with every class selected — the server's own default; an EXPLICIT empty
     * array stays empty, because that stored profile answers nothing and the
     * editor must not silently grant classes on an unrelated row edit. */
    function parseScopeText(text) {
      let value = null;
      try { value = JSON.parse(text); } catch { value = null; }
      const readList = key => Array.isArray(value?.[key]) ? value[key].filter(entry => typeof entry === "string") : [];
      const classes = Array.isArray(value?.authorizationClasses)
        ? [...new Set(value.authorizationClasses.filter(entry => AGENT_SCOPE_CLASSES.includes(entry)))]
        : [...AGENT_SCOPE_CLASSES];
      return { paths: readList("paths"), tags: readList("tags"), classes };
    }

    /** The visual scope state as the staged JSON text — paths/tags only when
     * actually filled, authorization classes always, and NEVER `workspaces`
     * (an assistant is profile-global; workspace membership is not its setting). */
    function composeScopeText(visual) {
      const scope = {};
      const paths = nonEmptyRows(visual.paths);
      if (paths.length > 0) scope.paths = paths;
      const tags = nonEmptyRows(visual.tags);
      if (tags.length > 0) scope.tags = tags;
      scope.authorizationClasses = AGENT_SCOPE_CLASSES.filter(entry => (visual.classes ?? []).includes(entry));
      return JSON.stringify(scope);
    }

    /** The staged route JSON as an ordered rung list; malformed text and a
     * missing chain both open as an empty list (the session route). */
    function parseRouteText(text) {
      let value = null;
      try { value = JSON.parse(text); } catch { value = null; }
      const chain = Array.isArray(value?.chain) ? value.chain : [];
      return chain.filter(rung => rung && typeof rung === "object").map(rung => ({
        provider: typeof rung.provider === "string" ? rung.provider : "",
        model: typeof rung.model === "string" ? rung.model : "",
        reasoningEffort: typeof rung.reasoningEffort === "string" ? rung.reasoningEffort : "",
      }));
    }

    /** A rung is saveable only when both provider and model are filled. */
    function rungComplete(rung) {
      return typeof rung?.provider === "string" && rung.provider.trim() !== "" && typeof rung?.model === "string" && rung.model.trim() !== "";
    }

    /** The visual route state as the staged JSON text, rungs in order; an empty
     * chain still means "inherit the session model". */
    function composeRouteText(visual) {
      const chain = (visual.rungs ?? []).filter(rungComplete).map(rung => ({
        provider: rung.provider.trim(),
        model: rung.model.trim(),
        ...(rung.reasoningEffort.trim() ? { reasoningEffort: rung.reasoningEffort.trim() } : {}),
      }));
      return JSON.stringify({ chain });
    }

    /** Local visual state for one editor target: re-initialized from the staged
     * text whenever the target changes (or the text no longer matches the value
     * this state produced) — the local row list is never authoritative. */
    function agentVisualState(editor, current) {
      if (!editor) return null;
      const key = editor.agentId ?? "create";
      if (current && current.key === key && current.scopeText === editor.scopeText && current.routeText === editor.routeText) return current;
      return { key, scopeText: editor.scopeText, routeText: editor.routeText, ...parseScopeText(editor.scopeText), rungs: parseRouteText(editor.routeText) };
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
      const pendingReview = typeof agent.pendingReview === "boolean" ? agent.pendingReview : learningRows(agent.learningRuns).some(run => run.outcome === "candidate");
      return jsx.jsxs("article", { key: props.agent.agentId, className: "weir-da-card weir-da-agent-summary", "data-agent-summary": props.agent.agentId, "data-selected": props.selected === true, children: [
        jsx.jsxs("header", { className: "weir-da-card-header", children: [
          jsx.jsx("h2", { children: agent.name }, "name"),
          jsx.jsx(props.ui.Badge, { variant: agent.state === "enabled" ? "success" : agent.state === "disabled" ? "warn" : "idle", children: props.t(agentStateKey(agent.state)) }, "state"),
        ] }, "header"),
        jsx.jsx("p", { className: "weir-da-agent-summary-preference", children: agent.userDescription?.text || props.t("decisionNoPreference") }, "preference"),
        pendingReview ? jsx.jsx(props.ui.Badge, { variant: "warn", children: props.t("decisionPendingReview") }, "pending") : null,
        jsx.jsx(props.ui.Button, { ref: props.openRef, "data-action": "open-agent", "data-agent-id": props.agent.agentId, onClick: () => props.onOpen(props.agent.agentId), children: props.t("decisionViewAssistant") }, "open"),
      ] });
    }
    /** Path/tag rows: one single-line input per entry plus its remove action,
     * and one add action per list. Empty rows stay visible (an unfinished line
     * is not silently dropped) but never reach the staged JSON. */
    function AgentScopeRowList(props) {
      const { kind, labelKey, values, ui, t, pending, onChange } = props;
      const dataKey = kind === "path" ? "data-scope-path" : "data-scope-tag";
      const removeKey = kind === "path" ? "data-scope-remove-path" : "data-scope-remove-tag";
      const addKey = kind === "path" ? "data-scope-add-path" : "data-scope-add-tag";
      return jsx.jsxs("div", { className: "weir-da-scope-list", "data-scope-list": kind, children: [
        jsx.jsx("p", { className: "weir-da-caption", children: t(labelKey) }, "label"),
        ...values.map((value, index) => jsx.jsxs("div", { className: "weir-da-scope-row", children: [
          jsx.jsx("input", {
            type: "text", id: `weir-da-agent-scope-${kind}-${index}`, [dataKey]: true, "data-row-index": index,
            "aria-label": t(labelKey), value, disabled: pending,
            onChange: event => onChange(values.map((entry, at) => at === index ? event.target.value : entry)),
          }, "input"),
          jsx.jsx(ui.Button, { variant: "ghost", size: "sm", [removeKey]: true, disabled: pending, onClick: () => onChange(values.filter((entry, at) => at !== index)), children: t("decisionScopeRemove") }, "remove"),
        ] }, `${kind}-${index}`)),
        jsx.jsx(ui.Button, { variant: "ghost", size: "sm", [addKey]: true, disabled: pending, onClick: () => onChange([...values, ""]), children: t("decisionScopeAdd") }, "add"),
      ] });
    }

    /** The assistant's expertise scope: path prefixes, tags and the A/B/C
     * authorization classes. Every change re-synthesizes scopeText; at least
     * one class always stays selected (the profile has no "no class" state). */
    function AgentScopeEditor(props) {
      const { visual, ui, t, pending } = props;
      const classes = visual.classes ?? [];
      const toggleClass = entry => {
        if (classes.includes(entry)) {
          if (classes.length === 1) return;
          props.onPatch({ classes: classes.filter(value => value !== entry) });
          return;
        }
        props.onPatch({ classes: AGENT_SCOPE_CLASSES.filter(value => value === entry || classes.includes(value)) });
      };
      return jsx.jsxs("div", { className: "weir-da-scope-editor", "data-scope-editor": true, children: [
        AgentScopeRowList({ kind: "path", labelKey: "decisionScopePaths", values: visual.paths ?? [], ui, t, pending, onChange: paths => props.onPatch({ paths }) }),
        AgentScopeRowList({ kind: "tag", labelKey: "decisionScopeTags", values: visual.tags ?? [], ui, t, pending, onChange: tags => props.onPatch({ tags }) }),
        jsx.jsxs("div", { className: "weir-da-scope-classes", children: [
          jsx.jsx("p", { className: "weir-da-caption", children: t("decisionScopeClasses") }, "label"),
          jsx.jsx("div", { className: "weir-da-scope-class-row", role: "group", "aria-label": t("decisionScopeClasses"), "data-scope-class-set": true, children: AGENT_SCOPE_CLASSES.map(entry => {
            const selected = classes.includes(entry);
            return jsx.jsx("button", {
              type: "button", id: `weir-da-agent-scope-class-${entry}`, "data-scope-class": entry, "aria-pressed": selected,
              "aria-disabled": selected && classes.length === 1, disabled: pending, onClick: () => toggleClass(entry), children: entry,
            }, entry);
          }) }),
          jsx.jsx("p", { className: "weir-da-caption", "data-scope-class-minimum": true, children: t("decisionScopeClassMinimum") }, "minimum"),
        ] }, "classes"),
      ] });
    }

    /** Ordered model rungs: the composer-style picker when its chunk arrived,
     * otherwise the three plain inputs (still never a JSON box). A rung without
     * both provider and model is not saved and says so. */
    function AgentRouteEditor(props) {
      const { visual, ui, t, pending, modelPicker } = props;
      const rungs = visual.rungs ?? [];
      const patchRung = (index, patch) => props.onPatch({ rungs: rungs.map((rung, at) => at === index ? { ...rung, ...patch } : rung) });
      const pickerField = modelPicker && typeof modelPicker.ModelPickerField === "function" ? modelPicker.ModelPickerField : null;
      return jsx.jsxs("div", { className: "weir-da-route-editor", "data-route-editor": true, children: [
        jsx.jsx("p", { className: "weir-da-caption", children: t("decisionRouteHint") }, "hint"),
        ...rungs.map((rung, index) => jsx.jsxs("div", { className: "weir-da-route-row", "data-route-index": index, children: [
          jsx.jsx("span", { className: "weir-da-caption", children: String(index + 1) }, "index"),
          pickerField
            ? jsx.jsx(pickerField, {
                value: { provider: rung.provider, model: rung.model, reasoningEffort: rung.reasoningEffort },
                onChange: selection => patchRung(index, { provider: selection?.provider ?? "", model: selection?.model ?? "", reasoningEffort: selection?.reasoningEffort ?? "" }),
                getSession: () => props.getSession(), t, disabled: pending,
              }, "picker")
            : jsx.jsxs("div", { className: "weir-da-route-fallback", children: [
                jsx.jsx("input", { type: "text", id: `weir-da-agent-route-provider-${index}`, "data-route-provider": true, "data-row-index": index, "aria-label": t("decisionRouteProvider"), placeholder: t("decisionRouteProvider"), value: rung.provider, disabled: pending, onChange: event => patchRung(index, { provider: event.target.value }) }, "provider"),
                jsx.jsx("input", { type: "text", id: `weir-da-agent-route-model-${index}`, "data-route-model": true, "data-row-index": index, "aria-label": t("decisionRouteModel"), placeholder: t("decisionRouteModel"), value: rung.model, disabled: pending, onChange: event => patchRung(index, { model: event.target.value }) }, "model"),
                jsx.jsx("input", { type: "text", id: `weir-da-agent-route-effort-${index}`, "data-route-effort": true, "data-row-index": index, "aria-label": t("decisionRouteEffort"), placeholder: t("decisionRouteEffort"), value: rung.reasoningEffort, disabled: pending, onChange: event => patchRung(index, { reasoningEffort: event.target.value }) }, "effort"),
              ] }, "fallback"),
          jsx.jsx(ui.Button, { variant: "ghost", size: "sm", "data-route-remove": true, "data-row-index": index, disabled: pending, onClick: () => props.onPatch({ rungs: rungs.filter((entry, at) => at !== index) }), children: t("decisionRouteRemove") }, "remove"),
        ] }, `rung-${index}`)),
        jsx.jsx(ui.Button, { variant: "ghost", size: "sm", "data-route-add": true, disabled: pending, onClick: () => props.onPatch({ rungs: [...rungs, { provider: "", model: "", reasoningEffort: "" }] }), children: t("decisionRouteAdd") }, "add"),
        rungs.some(rung => !rungComplete(rung)) ? jsx.jsx("p", { className: "weir-da-caption", "data-route-incomplete": true, children: t("decisionRouteIncomplete") }, "incomplete") : null,
        rungs.length === 0 ? jsx.jsx("p", { className: "weir-da-caption", "data-route-empty": true, children: t("decisionRouteEmpty") }, "empty") : null,
      ] });
    }

    function AgentEditor(props) {
      const { editor, ui, t } = props;
      const suffix = editor.agentId ?? "create";
      return jsx.jsxs("form", { className: "weir-da-card weir-da-agent-editor", "data-agent-editor": editor.mode, onSubmit: event => { event.preventDefault(); return props.onSave(); }, children: [
        jsx.jsx("h2", { children: t(editor.mode === "create" ? "decisionCreateAgent" : "decisionEditAgent") }, "title"),
        jsx.jsx(ui.Field, { id: `weir-da-agent-name-${suffix}`, label: t("decisionAgentName"), children: jsx.jsx("input", {
          ref: props.nameRef, id: `weir-da-agent-name-${suffix}`, "data-agent-field": "name", "aria-label": t("decisionAgentName"), value: editor.name, disabled: props.pending,
          onChange: event => props.onField("name", event.target.value), required: true,
        }) }, "name"),
        jsx.jsx(ui.Field, { id: `weir-da-agent-preference-${suffix}`, label: t("decisionAgentPreference"), hint: t("decisionAgentPreferenceHint"), children: jsx.jsx("textarea", {
          id: `weir-da-agent-preference-${suffix}`, "data-agent-field": "preference", "aria-label": t("decisionAgentPreference"), value: editor.preference, rows: 3, disabled: props.pending,
          onChange: event => props.onField("preference", event.target.value),
        }) }, "preference"),
        jsx.jsx(ui.Disclosure, { id: `weir-da-agent-settings-${suffix}`, label: t("decisionAdvancedSettings"), revealOnOpen: "end", children: () => jsx.jsxs("div", { className: "weir-da-agent-advanced", children: [
          jsx.jsx("p", { className: "weir-da-caption", children: t("decisionAdvancedSettingsHint") }, "hint"),
          jsx.jsx(ui.Field, { id: `weir-da-agent-scope-${suffix}`, label: t("decisionScopeTitle"), hint: t("decisionScopeHint"), children: AgentScopeEditor({ visual: props.visual, ui, t, pending: props.pending, onPatch: props.onVisual }) }, "scope"),
          jsx.jsx(ui.Field, { id: `weir-da-agent-route-${suffix}`, label: t("decisionRouteTitle"), hint: t("decisionRouteHint"), children: AgentRouteEditor({ visual: props.visual, ui, t, pending: props.pending, modelPicker: props.modelPicker, getSession: props.getSession, onPatch: props.onVisual }) }, "route"),
        ] }) }, "advanced"),
        jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx(ui.Button, { disabled: props.pending, onClick: props.onCancel, children: t("decisionCancel") }, "cancel"),
          jsx.jsx(ui.Button, { type: "submit", variant: "primary", disabled: props.pending || !editor.name.trim(), children: props.pending ? t("decisionSaving") : t("decisionSave") }, "save"),
        ] }, "actions"),
      ] });
    }

    function PublicMemory(props) {
      const { view, ui, t, pending } = props;
      const busy = typeof pending === "string";
      // Refresh lives in the section header as a small quiet button instead of
      // a full-width row of its own.
      const header = jsx.jsxs("header", { className: "weir-da-section-header", children: [
        jsx.jsx("h4", { children: t("decisionPublicCandidate") }, "label"),
        jsx.jsx(ui.Badge, { variant: view.statusVariant, "data-public-status": view.status, role: "status", "aria-live": "polite", children: t(view.statusKey) }, "status"),
        jsx.jsx(ui.Button, { variant: "ghost", size: "sm", "data-action": "public-refresh", disabled: !view.canRefresh || busy, "aria-busy": view.phase === "loading", onClick: () => { if (view.canRefresh && !busy) return props.onRefresh(); }, children: t(view.phase === "loading" ? "decisionPublicRefreshing" : "decisionPublicRefresh") }, "refresh"),
      ] }, "header");
      if (view.phase === "idle" || (view.phase === "loading" && !view.hasValue)) {
        return jsx.jsxs("div", { className: "weir-da-public-memory", "data-public-memory": true, children: [header, jsx.jsx(ui.LoadingState, { children: t("decisionPublicStatusLoading") }, "loading")] });
      }
      if (view.phase === "error") {
        return jsx.jsxs("div", { className: "weir-da-public-memory", "data-public-memory": true, children: [header, jsx.jsx(ui.ErrorState, { children: jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx("span", { children: view.errorKey ? t(view.errorKey) : t("decisionPublicReadFailed") }, "message"),
          jsx.jsx(ui.Button, { "data-action": "public-retry", disabled: busy, onClick: () => { if (!busy) return props.onRetry(); }, children: t("decisionRetry") }, "retry"),
        ] }) }, "error")] });
      }
      const current = view.current
        ? jsx.jsx("p", { "data-public-current": String(view.current.version ?? ""), children: `${t("decisionPublicCurrentVersion")}: ${view.current.version ?? "—"} · ${view.current.principleCount ?? 0}` }, "current")
        : jsx.jsx("p", { children: t("decisionPublicNoCurrent") }, "no-current");
      const publishedPrinciples = Array.isArray(view.current?.principles) ? view.current.principles : [];
      const published = publishedPrinciples.length ? jsx.jsxs("section", { className: "weir-da-public-published", "data-public-published-principles": true, children: [
        jsx.jsx("strong", { children: t("decisionPublicCurrentPrinciples") }, "title"),
        jsx.jsx("ul", { children: publishedPrinciples.map((principle, index) => {
          const scope = publicScopeText(principle.scope, t);
          return jsx.jsxs("li", { "data-public-published-principle": principle.principleId, children: [
            jsx.jsx("p", { "data-public-published-text": true, children: principle.text || "—" }, "text"),
            scope ? jsx.jsx("p", { className: "weir-da-caption", children: `${t("decisionPublicScope")}: ${scope}` }, "scope") : null,
          ] }, `${principle.principleId}:${index}`);
        }) }, "list"),
      ] }, "published") : null;
      // The first-run consent is the zone's key alert: an accent-barred warn
      // notice with the acknowledge action inside, not more flat paragraphs.
      const disclosure = view.disclosureRequired ? jsx.jsx(ui.Notice, { tone: "warn", children: jsx.jsxs("section", { className: "weir-da-public-disclosure", "data-public-disclosure": true, role: "note", children: [
        jsx.jsx("strong", { children: t("decisionPublicDisclosureTitle") }, "title"),
        jsx.jsx("p", { children: t("decisionPublicDisclosureBody") }, "body"),
        jsx.jsx(ui.Button, { variant: "primary", "data-action": "public-acknowledge", disabled: busy, onClick: () => { if (!busy) return props.onAcknowledge(); }, children: t("decisionPublicDisclosureAcknowledge") }, "acknowledge"),
      ] }) }, "disclosure") : null;
      const candidate = view.candidate ? jsx.jsxs("section", { className: "weir-da-public-candidate", "data-public-candidate": String(view.candidate.snapshotId ?? ""), children: [
        jsx.jsxs("p", { children: `${t("decisionPublicCandidate")} · ${t("decisionApplyChangeCount")}: ${view.readiness.changeCount ?? view.changes.length}` }, "summary"),
        jsx.jsx("p", { className: "weir-da-caption", "data-public-frozen-input": true, children: `${t("decisionPublicFrozenInput")}: ${t("decisionPublicWorkspaces")} ${view.candidate.workspaceCount} · ${t("decisionPublicSourceCount")} ${view.candidate.sourceCount}` }, "counts"),
        view.changes.length
          ? jsx.jsxs("section", { "data-public-changes": true, children: [
            jsx.jsx("strong", { children: t("decisionPublicChanges") }, "title"),
            jsx.jsx("ul", { children: view.changes.map((change, index) => {
            const wording = publicChangeWording(change, view);
            const principle = (Array.isArray(view.principles) ? view.principles : []).find(item => item.principleId === change.principleId);
            const scope = publicScopeText(change.scope ?? principle?.scope, t);
            return jsx.jsxs("li", { "data-public-change": change.op, children: [
              jsx.jsx("strong", { children: `${publicOpLabel(change.op, t)} · ${change.principleId ?? "—"}` }, "op"),
              jsx.jsxs("p", { children: [
                jsx.jsx("span", { className: "weir-da-caption", children: `${t(change.op === "retire" ? "decisionPublicCurrentText" : "decisionPublicProposedText")}: ` }, "label"),
                jsx.jsx("span", { "data-public-change-text": true, children: wording || "—" }, "text"),
              ] }, "wording"),
              scope ? jsx.jsx("p", { className: "weir-da-caption", "data-public-change-scope": true, children: `${t("decisionPublicScope")}: ${scope}` }, "scope") : null,
            ] }, `${change.principleId ?? change.op}:${index}`);
            }) }, "list"),
          ] }, "changes")
          : jsx.jsx("p", { className: "weir-da-caption", children: t("decisionPublicNoChanges") }, "no-changes"),
        view.sources.length ? jsx.jsxs("section", { "data-public-sources": true, children: [
          jsx.jsx("strong", { children: t("decisionPublicSources") }, "title"),
          jsx.jsx("ul", { children: view.sources.map((source, index) => jsx.jsxs("li", { "data-public-source": source.alias, children: [
            jsx.jsx("code", { children: source.alias }, "alias"),
            jsx.jsx("span", { children: ` · ${source.count} · ${source.current ? t("decisionPublicFromThisWorkspace") : t("decisionPublicFromOtherWorkspace")}` }, "origin"),
            source.preview ? jsx.jsx("p", { className: "weir-da-source-excerpt", children: source.preview }, "preview") : null,
          ] }, `${source.alias}:${index}`)) }, "list"),
        ] }, "sources") : null,
        jsx.jsx("p", { className: "weir-da-caption", "data-public-replay": view.replay?.passed === true ? "passed" : view.replay?.passed === false ? "failed" : "pending", children: view.replay?.passed === true ? t("decisionReplayPassed") : view.replay?.passed === false ? t("decisionReplayFailed") : t("decisionReplayPending") }, "replay"),
        !view.canReview ? jsx.jsx("p", { role: "status", className: "weir-da-caption", children: t(view.candidateError || view.readiness.reason === "replay" || view.readiness.reason === "mismatch" ? "decisionPublicReviewMismatch" : "decisionPublicNeedReview") }, "not-ready") : null,
        jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx(ui.Button, { variant: "primary", "data-action": "public-publish", disabled: !view.canReview, onClick: () => {
            if (!view.canReview) return;
            return props.onPublish({ snapshotId: view.readiness.snapshotId, expectedRevision: view.readiness.expectedRevision, changeCount: view.readiness.changeCount ?? 0, currentVersion: view.current?.version ?? null });
          }, children: t("decisionPublicPublish") }, "publish"),
          jsx.jsx(ui.Button, { "data-action": "public-reject", disabled: !view.canReview, onClick: () => {
            if (!view.canReview) return;
            return props.onReject({ snapshotId: view.readiness.snapshotId, expectedRevision: view.readiness.expectedRevision });
          }, children: t("decisionReject") }, "reject"),
        ] }, "actions"),
      ] }, "candidate") : null;
      const rollback = view.current ? jsx.jsx(ui.Button, { variant: "danger", "data-action": "public-rollback", disabled: !view.canRollback, onClick: () => {
        if (!view.canRollback) return;
        return props.onRollback({ snapshotId: view.current.snapshotId, expectedRevision: view.current.revision, currentVersion: view.current.version });
      }, children: t("decisionPublicRollback") }, "rollback") : null;
      const failed = view.retryable ? jsx.jsx(ui.ErrorState, { children: jsx.jsxs("div", { className: "weir-da-actions", children: [
        jsx.jsx("span", { children: t("decisionPublicStatusFailed") }, "message"),
        jsx.jsx(ui.Button, { "data-action": "public-retry", disabled: busy, onClick: () => { if (!busy) return props.onRetry(); }, children: t("decisionPublicRetry") }, "retry"),
      ] }) }, "failed") : null;
      return jsx.jsxs("div", { className: "weir-da-public-memory", "data-public-memory": true, children: [
        header,
        view.phase === "loading" ? jsx.jsx("p", { role: "status", className: "weir-da-caption", children: t("decisionPublicRefreshing") }, "refreshing") : null,
        current,
        published,
        disclosure,
        failed,
        candidate,
        rollback,
      ] });
    }

    function AgentDetail(props) {
      const { agent, ui, t } = props;
      const pending = typeof props.pending === "string";
      return jsx.jsxs("article", { ref: props.detailRef, tabIndex: -1, className: "weir-da-card weir-da-agent-detail", "data-agent-detail": agent.agentId, children: [
        jsx.jsxs("header", { className: "weir-da-card-header", children: [
          jsx.jsxs("div", { children: [jsx.jsx("h2", { children: agent.name }, "name"), jsx.jsx("p", { children: agent.userDescription?.text || t("decisionNoPreference") }, "preference")] }, "copy"),
          jsx.jsx(ui.Badge, { variant: agent.state === "enabled" ? "success" : agent.state === "disabled" ? "warn" : "idle", children: t(agentStateKey(agent.state)) }, "state"),
        ] }, "header"),
        // One calm action row: no heavy fills, the state toggle stays ghost,
        // and the destructive archive sits at the far end.
        jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx(ui.Button, { variant: "secondary", "data-action": "edit-agent", onClick: props.onEdit, children: t("decisionEditAgent") }, "edit"),
          jsx.jsx(ui.Button, { variant: "ghost", "data-agent-state": agent.state === "enabled" ? "disabled" : "enabled", disabled: agent.state === "archived", onClick: () => props.requestState(agent.state === "enabled" ? "disabled" : "enabled"), children: t(agent.state === "enabled" ? "decisionDisableAgent" : "decisionEnableAgent") }, "toggle"),
          jsx.jsx(ui.Button, { variant: "danger", "data-agent-state": "archived", disabled: agent.state === "archived", onClick: () => props.requestState("archived"), children: t("decisionArchiveAgent") }, "archive"),
          jsx.jsx(ui.Button, { variant: "danger", "data-action": "delete-agent", onClick: () => props.requestDelete(), children: t("decisionDeleteAgent") }, "delete"),
        ] }, "actions"),
        jsx.jsxs("section", { className: "weir-da-memory-zone weir-da-public-zone", "data-memory-zone": "public", "aria-labelledby": `weir-da-public-zone-${agent.agentId}`, children: [
          jsx.jsx("h3", { id: `weir-da-public-zone-${agent.agentId}`, ref: props.publicZoneRef, tabIndex: -1, children: t("decisionPublicMemory") }, "title"),
          jsx.jsx("p", { className: "weir-da-caption", role: "note", "data-public-guidance-only": true, children: t("decisionPublicGuidanceOnly") }, "guidance"),
          PublicMemory({
            view: props.publicMemory, ui, t, pending,
            onRefresh: props.onPublicRefresh, onAcknowledge: props.onPublicAcknowledge, onRetry: props.onPublicRetry,
            onPublish: action => props.requestPublicAction({ kind: "snapshotPublish", ...action }),
            onReject: action => props.requestPublicAction({ kind: "snapshotReject", ...action }),
            onRollback: action => props.requestPublicAction({ kind: "snapshotRollback", ...action }),
          }),
        ] }, "public-zone"),
        jsx.jsxs("section", { className: "weir-da-memory-zone weir-da-private-zone", "data-memory-zone": "workspace", "aria-labelledby": `weir-da-private-zone-${agent.agentId}`, children: [
          jsx.jsx("h3", { id: `weir-da-private-zone-${agent.agentId}`, children: t("decisionWorkspaceExperience") }, "title"),
          jsx.jsx("p", { className: "weir-da-caption", role: "note", "data-private-isolation": true, children: t("decisionPrivateIsolation") }, "isolation"),
          jsx.jsx(props.learningProps.learning.AgentLearning, { ...props.learningProps, agent, ui, hideAdvanced: true }, "learning"),
        ] }, "private-zone"),
        // Exactly one advanced surface per assistant: profile history, the
        // learning diagnostics and the raw profile share this slim disclosure.
        jsx.jsx(ui.Disclosure, { id: `weir-da-agent-advanced-${agent.agentId}`, label: t("decisionAdvancedDiagnostics"), revealOnOpen: "end", children: () => jsx.jsxs("div", { className: "weir-da-agent-diagnostics", children: [
          jsx.jsx("h3", { children: t("decisionProfileHistory") }, "history-title"),
          jsx.jsx("ul", { children: (agent.descriptionHistory ?? []).map(item => jsx.jsx("li", { children: `v${item.revision}: ${item.text}` }, item.revision)) }, "history"),
          jsx.jsx(props.learningProps.learning.AgentLearningDiagnostics, { ...props.learningProps, agent, ui }, "learning-diagnostics"),
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
        RoutingReviewDetails({ ...props, resource: props.routingReview }),
        jsx.jsx(props.ui.Disclosure, { id: "weir-da-raw-metrics", label: props.t("decisionRawMetrics"), children: () => jsx.jsx("pre", { children: JSON.stringify(view.raw, null, 2) }) }, "raw"),
      ] });
    }

    function RoutingReviewDetails(props) {
      const { resource, model, ui, t } = props;
      const view = model.routingReviewView({ window: resource.window, summary: resource.summary, items: resource.value, nextCursor: resource.nextCursor }, t);
      const windowKeys = { all: "decisionMetricWindowAll", "24h": "decisionMetricWindow24h", "7d": "decisionMetricWindow7d", "30d": "decisionMetricWindow30d" };
      const agentName = agentId => agentId === null || agentId === undefined
        ? t("decisionNoAssignedAgent")
        : props.agents.find(agent => agent?.agentId === agentId)?.name ?? agentId;
      return jsx.jsxs("section", { className: "weir-da-routing-review", "data-routing-review": true, "aria-labelledby": "weir-da-routing-review-title", children: [
        jsx.jsx("h3", { id: "weir-da-routing-review-title", children: t("decisionRoutingReview") }, "title"),
        jsx.jsx("p", { role: "note", className: "weir-da-caption", children: t("decisionRoutingDiagnostic") }, "diagnostic"),
        jsx.jsx("label", { className: "weir-da-filter", children: [
          jsx.jsx("span", { children: t("decisionMetricWindow") }, "label"),
          jsx.jsx("select", { className: "weir-da-select", "data-routing-window": true, "aria-label": t("decisionMetricWindow"), value: resource.window, disabled: resource.status === "loading" || resource.loadingMore, onChange: event => props.onWindow(event.target.value), children: Object.entries(windowKeys).map(([value, key]) => jsx.jsx("option", { value, children: t(key) }, value)) }, "select"),
        ] }, "window"),
        resource.status === "loading" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") }, "loading") : null,
        resource.status === "error" ? jsx.jsx(ui.ErrorState, { children: jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx("span", { children: props.readFailure(resource.error) }, "message"),
          jsx.jsx(ui.Button, { onClick: props.onRetry, children: t("decisionRetry") }, "retry"),
        ] }) }, "error") : null,
        resource.status === "ready" ? jsx.jsxs("div", { className: "weir-da-routing-content", children: [
          MetricRows({ rows: view.summary, t }),
          jsx.jsx("p", { className: "weir-da-caption", role: "status", "aria-live": "polite", "data-routing-status": true, children: `${t("decisionRoutingShown")}: ${view.items.length}` }, "status"),
          view.items.length ? jsx.jsx("div", { className: "weir-da-routing-list", "aria-label": t("decisionRoutingReview"), children: view.items.map(item => jsx.jsxs("article", { className: "weir-da-routing-item", "data-routing-case": item.caseId, children: [
            jsx.jsx("strong", { children: item.title }, "question"),
            jsx.jsx("p", { children: t(item.outcomeKey) }, "outcome"),
            item.outcome === "manual_reassign" && item.reassignment ? jsx.jsx("p", { className: "weir-da-caption", children: `${t("decisionRoutingDirection")}: ${agentName(item.reassignment.from)} → ${agentName(item.reassignment.to)}` }, "direction") : null,
            item.createdAt ? jsx.jsx("time", { dateTime: item.createdAt, children: readableTime(item.createdAt) }, "time") : null,
            item.recordCaseId ? jsx.jsx(ui.Button, { variant: "ghost", "data-routing-record": item.recordCaseId, "aria-label": `${t("decisionRoutingOpenRecord")}: ${item.title}`, onClick: () => props.onOpenRecord(item.recordCaseId), children: t("decisionHistory") }, "record") : null,
          ] }, item.routeDecisionId ?? item.caseId)) }, "items") : jsx.jsx(ui.EmptyState, { children: t("decisionRoutingNoData") }, "empty"),
          resource.loadMoreError ? jsx.jsx(ui.ErrorState, { children: jsx.jsxs("div", { className: "weir-da-actions", children: [
            jsx.jsx("span", { children: props.readFailure(resource.loadMoreError) }, "message"),
            jsx.jsx(ui.Button, { onClick: props.onMore, children: t("decisionRetry") }, "retry-more"),
          ] }) }, "more-error") : null,
          resource.nextCursor ? jsx.jsx(ui.Button, { "data-routing-load-more": true, disabled: resource.loadingMore, "aria-busy": resource.loadingMore === true, onClick: props.onMore, children: resource.loadingMore ? t("decisionLoadingShort") : t("decisionLoadMore") }, "more") : null,
        ] }, "ready") : null,
      ] });
    }
    const emptyResource = () => ({ status: "idle", value: null, error: null });
    const emptyResources = () => ({
      agents: { ...emptyResource(), value: [] }, inbox: { ...emptyResource(), value: [] },
      records: { ...emptyResource(), value: [], nextCursor: null, loadingMore: false },
      routingReview: { ...emptyResource(), value: [], summary: {}, window: "all", nextCursor: null, loadingMore: false, loadMoreError: null },
      details: {}, agent: emptyResource(), metrics: emptyResource(),
    });
    const emptyPublicMemory = () => ({ phase: "idle", value: null, error: null, agentId: null, candidate: null, candidatePhase: "idle", candidateError: null });
    const asError = (reason, code = "DECISION_READ_FAILED") => reason instanceof Error ? reason : Object.assign(new Error(String(reason ?? code)), { code });

    function AttemptContextPack(props) {
      const t = props.t ?? (key => key);
      const attempt = props.attempt && typeof props.attempt === "object" ? props.attempt : {};
      const manifest = attempt.packManifest;
      const memory = manifest?.memory;
      const pins = attempt.pins && typeof attempt.pins === "object" ? attempt.pins : {};
      const attemptId = typeof attempt.attemptId === "string" ? attempt.attemptId : "—";
      const omissions = Array.isArray(manifest?.omissions) ? manifest.omissions.filter(code => typeof code === "string") : [];
      const layerSizes = manifest?.layerSizes && typeof manifest.layerSizes === "object" && !Array.isArray(manifest.layerSizes) ? Object.entries(manifest.layerSizes) : [];
      const sourceCaseIds = Array.isArray(memory?.L3?.sourceCaseIds) ? memory.L3.sourceCaseIds.filter(caseId => typeof caseId === "string") : [];
      // Each L2 partition is projected from its own manifest record. An Attempt
      // written before a partition existed renders that partition honestly as
      // legacy, and an old Attempt keeps its single legacy private pin.
      const partition = (layer, legacyPin) => {
        const value = layer && typeof layer === "object" ? layer : null;
        const ids = Array.isArray(value?.principleIds) ? value.principleIds.filter(id => typeof id === "string") : [];
        const items = Array.isArray(value?.items) ? value.items.filter(item => item && typeof item === "object" && typeof item.principleId === "string") : [];
        const principleIds = ids.length ? ids : items.map(item => item.principleId);
        const snapshotId = value?.snapshotId ?? legacyPin?.snapshotId ?? null;
        const snapshotRevision = value?.snapshotRevision ?? legacyPin?.snapshotRevision ?? null;
        const snapshotHash = value?.snapshotHash ?? legacyPin?.snapshotHash ?? null;
        const pinned = snapshotId !== null || snapshotRevision !== null || snapshotHash !== null;
        return {
          legacy: !value, pinned,
          pin: { snapshotId, snapshotRevision, snapshotHash },
          statusKey: principleIds.length ? "decisionPartitionUsed" : pinned ? "decisionPartitionPinnedNotUsed" : "decisionPartitionEmpty",
          principleIds, items,
          exclusions: Array.isArray(value?.exclusions) ? value.exclusions.filter(item => item && typeof item === "object" && typeof item.principleId === "string") : [],
          layerSize: Number.isFinite(value?.layerSize) ? value.layerSize : null,
        };
      };
      const privatePartition = partition(memory?.L2, { snapshotId: pins.memorySnapshotId ?? null, snapshotRevision: pins.memorySnapshotRevision ?? null, snapshotHash: pins.memorySnapshotHash ?? null });
      const publicPartition = partition(memory?.publicL2, { snapshotId: pins.publicMemorySnapshotId ?? null, snapshotRevision: pins.publicMemorySnapshotRevision ?? null, snapshotHash: pins.publicMemorySnapshotHash ?? null });
      const partitionBody = (value, zone) => jsx.jsxs("div", { "data-partition": zone, children: [
        jsx.jsx("div", { children: `${t("decisionPartitionState")}: ${value.legacy ? t("decisionPartitionLegacy") : t(value.statusKey)}` }, "status"),
        value.pinned ? jsx.jsx("pre", { children: JSON.stringify(value.pin, null, 2) }, "pin") : jsx.jsx("div", { children: t("decisionNoSnapshotPin") }, "empty-pin"),
        value.principleIds.length ? jsx.jsx("ul", { style: contextPackListStyle, children: value.principleIds.map((principleId, index) => {
          const item = value.items.find(candidate => candidate.principleId === principleId);
          return jsx.jsxs("li", { children: [
            jsx.jsx("code", { children: principleId }, "principle"),
            item ? jsx.jsxs("div", { children: [
              jsx.jsx("div", { children: t("decisionPartitionSources") }, "mapping-label"),
              jsx.jsx("pre", { children: JSON.stringify({ sources: Array.isArray(item.sources) ? item.sources : [], evidenceIds: Array.isArray(item.evidenceIds) ? item.evidenceIds : [] }, null, 2) }, "mapping"),
            ] }, "mapping") : null,
          ] }, `${principleId}:${index}`);
        }) }, "principles") : jsx.jsx("div", { children: t("decisionPartitionNoPrinciples") }, "no-principles"),
        value.exclusions.length ? jsx.jsx("ul", { style: contextPackListStyle, children: value.exclusions.map((item, index) => jsx.jsx("li", { children: jsx.jsx("code", { children: `${item.principleId} · ${item.reason ?? "—"}` }) }, `${item.principleId}:${index}`)) }, "exclusions") : jsx.jsx("div", { children: t("decisionNoExclusions") }, "no-exclusions"),
        jsx.jsx("div", { children: `${t("decisionLayerSize")}: ${value.layerSize ?? "—"}` }, "layer-size"),
      ] });
      return jsx.jsxs("details", {
        "data-attempt-context-pack": attemptId,
        "aria-label": `${t("decisionContextPack")}: ${attemptId}`,
        style: contextPackStyle,
        children: [
          jsx.jsx("summary", { style: { cursor: "pointer" }, children: `${t("decisionContextPack")} · ${attemptId}` }, "summary"),
          jsx.jsxs("div", { style: contextPackBodyStyle, children: [
            jsx.jsxs("section", { "data-partition-section": "workspace", children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionWorkspaceExperience") }, "title"),
              partitionBody(privatePartition, "workspace"),
            ] }, "private"),
            jsx.jsxs("section", { "data-partition-section": "public", children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionPublicMemory") }, "title"),
              partitionBody(publicPartition, "public"),
            ] }, "public"),
            jsx.jsxs("section", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionNeutralEpisodes") }, "label"),
              sourceCaseIds.length
                ? jsx.jsx("ol", { style: contextPackListStyle, children: sourceCaseIds.map((caseId, index) => jsx.jsx("li", { children: jsx.jsx("code", { children: caseId }) }, `${caseId}:${index}`)) }, "sources")
                : jsx.jsx("div", { children: t("decisionNoHistoricalContext") }, "empty"),
            ] }, "l3"),
            jsx.jsxs("section", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionLayerSizes") }, "label"),
              layerSizes.length
                ? jsx.jsx("dl", { style: contextPackListStyle, children: layerSizes.map(([layer, size]) => jsx.jsxs("div", { children: [jsx.jsx("dt", { children: layer }, "layer"), jsx.jsx("dd", { style: { margin: 0 }, children: String(size) }, "size")] }, layer)) }, "sizes")
                : jsx.jsx("div", { children: "—" }, "empty"),
            ] }, "sizes"),
            jsx.jsxs("section", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionOmissions") }, "label"),
              omissions.length
                ? jsx.jsx("ul", { style: contextPackListStyle, children: omissions.map((code, index) => jsx.jsx("li", { children: jsx.jsx("code", { children: code }) }, `${code}:${index}`)) }, "codes")
                : jsx.jsx("div", { children: Array.isArray(manifest?.omissions) ? "[]" : "—" }, "empty"),
            ] }, "omissions"),
          ] }, "body"),
        ],
      });
    }

    const learningRows = value => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];


    function DecisionPage(props) {
      const t = props.t ?? (key => key);
      const model = props.decisionModel;
      const ui = props.ui;
      const sessionId = props.getSessionId?.() ?? null;
      const actions = props.createDecisionActions(props.connection, sessionId, props.decisionRpc);
      // The inbox is profile-wide, so it needs no open session; its action drafts
      // still stay isolated per session. A page opened without a session keeps
      // one profile bucket instead of throwing on a missing draft scope.
      const draftScope = sessionId ?? "profile";
      // Standard panel props: the page maps a source session to a workspace
      // locally, so the Remote projection never carries a path or workspace key.
      // The host exposes these as selector hooks (an identity selector returns the
      // snapshot): calling them with no selector throws and blanks the whole page.
      const hostSessions = typeof props.useSessions === "function" ? props.useSessions(s => s) : null;
      const hostWorkspaces = typeof props.useWorkspaces === "function" ? props.useWorkspaces(s => s) : null;
      const [tab, setTab] = react.useState("inbox");
      const [resources, setResources] = react.useState(emptyResources);
      const [groupBy, setGroupBy] = react.useState("workspace");
      const [deliveryNotice, setDeliveryNotice] = react.useState(null);
      const [filter, setFilter] = react.useState({});
      const [appliedFilter, setAppliedFilter] = react.useState({});
      const [selectedCaseId, setSelectedCaseId] = react.useState(null);
      const [drillIn, setDrillIn] = react.useState(false);
      const [agentDrillIn, setAgentDrillIn] = react.useState(false);
      const [visualPage, setVisualPage] = react.useState(() => decisionPageVisualViewport(globalThis.window));
      const [pending, setPending] = react.useState(null);
      const [actionError, setActionError] = react.useState(null);
      const [learningDetail, setLearningDetail] = react.useState(null);
      const [learningError, setLearningError] = react.useState(null);
      const [learningLoading, setLearningLoading] = react.useState(false);
      const [drafts, setDrafts] = react.useState({});
      const [confirm, setConfirm] = react.useState(null);
      const [exportState, setExportState] = react.useState({ phase: "idle", value: null, error: null, copied: false });
      const exportPendingRef = react.useRef(false);
      // A retry replaces the failure surface with the success surface, which
      // unmounts the retry button: focus must land on the new result instead of
      // falling to the page body. A committed-state effect is the only place the
      // new ref really exists.
      const exportFocusRef = react.useRef(false);
      const [editor, setEditor] = react.useState(null);
      // Candidate review: at most one inline principle editor at a time, the running
      // count of this review's user edits (for the publish confirmation) and the
      // entry refs used to hand focus back after a write.
      const [candidateEditor, setCandidateEditor] = react.useState(null);
      const [candidateEditorError, setCandidateEditorError] = react.useState(null);
      const [candidateEdits, setCandidateEdits] = react.useState(null);
      const candidateEntryRefs = react.useRef({});
      const candidateTextRef = react.useRef(null);
      const lastActionErrorRef = react.useRef(null);
      // Local row state for the visual scope/route editors (paths, tags, classes,
      // rungs). It is derived from the staged texts and never authoritative:
      // agentVisualState re-initializes it whenever the editor target or the
      // staged text changes, so switching assistants cannot leak rows.
      const [agentVisual, setAgentVisual] = react.useState(null);
      const [selectedAgentId, setSelectedAgentId] = react.useState(null);
      const [agentFocusRequest, setAgentFocusRequest] = react.useState(null);
      const pendingRef = react.useRef(false);
      const publicActionRef = react.useRef(false);
      const learningIntentRef = react.useRef(null);
      const epochRef = react.useRef(0);
      const routingAppendRef = react.useRef(false);
      const routingWindowRef = react.useRef("all");
      const requestsRef = react.useRef({ agents: 0, inbox: 0, records: 0, metrics: 0, routingReview: 0, agent: 0, learning: 0, publicMemory: 0, details: {} });
      const tabRef = react.useRef(tab);
      const filterRef = react.useRef(appliedFilter);
      const selectedCaseRef = react.useRef(selectedCaseId);
      react.useEffect(() => {
        if (!exportFocusRef.current || exportState.phase !== "success" || !exportState.value) return;
        exportFocusRef.current = false;
        // The result section is the only place the copy control exists; a DOM read
        // avoids depending on ref forwarding through the shared Button.
        const target = globalThis.document?.querySelector?.('[data-export-result="success"] [data-action="export-copy"]');
        if (target && typeof target.focus === "function" && target.isConnected !== false) target.focus();
      }, [exportState.phase, exportState.value]);
      const primaryNavRef = react.useRef(null);
      const exportButtonRef = react.useRef(null);
      const agentCreateRef = react.useRef(null);
      const agentSummaryRef = react.useRef(null);
      const agentBackRef = react.useRef(null);
      const agentDetailRef = react.useRef(null);
      const agentNameRef = react.useRef(null);
      const agentHeaderRef = react.useRef(null);
      const agentListRef = react.useRef(null);
      const agentDetailPaneRef = react.useRef(null);
      const publicZoneRef = react.useRef(null);
      const publicLoadRef = react.useRef(null);
      const publicCandidateRef = react.useRef(0);
      const [publicMemory, setPublicMemory] = react.useState(emptyPublicMemory);
      const requestAgentFocus = target => setAgentFocusRequest(typeof target === "string" ? { target } : target);
      react.useEffect(() => {
        if (!agentFocusRequest || tab !== "agents") return;
        const summaryControl = [...agentListRef.current?.querySelectorAll?.('[data-action="open-agent"]') ?? []].find(element => element.getAttribute("data-agent-id") === selectedAgentId);
        const createControl = agentHeaderRef.current?.querySelector?.('[data-action="create-agent"]');
        const backControl = agentDetailPaneRef.current?.querySelector?.('.weir-da-agent-back');
        const targets = agentFocusRequest.target === "editor" ? [agentNameRef.current]
          : agentFocusRequest.target === "detail" ? [backControl, agentBackRef.current, agentDetailRef.current]
          : agentFocusRequest.target === "create-list" ? [createControl, agentCreateRef.current]
          : agentFocusRequest.target === "public" ? [publicZoneRef.current, agentDetailRef.current]
          // A candidate write hands focus back to the entry it edited, or — after a
          // deletion — to the neighbour that took its place, then the detail itself.
          : agentFocusRequest.target === "candidate" ? [
            ...[...(agentFocusRequest.principleIds ?? [])].map(principleId => candidateEntryRefs.current[`edit:${principleId}`]?.current),
            agentDetailRef.current,
          ]
          : agentFocusRequest.target === "candidate-editor" ? [candidateTextRef.current, agentDetailRef.current]
          : [summaryControl, agentSummaryRef.current];
        for (const element of targets) {
          const style = element?.ownerDocument?.defaultView?.getComputedStyle?.(element);
          if (!element?.isConnected || element.disabled || typeof element.focus !== "function" || !(element.getClientRects?.().length > 0) || style?.display === "none" || style?.visibility === "hidden") continue;
          element.focus();
          setAgentFocusRequest(current => current === agentFocusRequest ? null : current);
          return;
        }
      }, [agentFocusRequest, agentDrillIn, resources.agent.status, resources.agents.status, selectedAgentId, pending, tab]);
      react.useEffect(() => {
        const viewport = globalThis.window?.visualViewport;
        if (!viewport?.addEventListener) return undefined;
        const update = () => setVisualPage(decisionPageVisualViewport(globalThis.window));
        viewport.addEventListener("resize", update);
        viewport.addEventListener("scroll", update);
        update();
        return () => {
          viewport.removeEventListener("resize", update);
          viewport.removeEventListener("scroll", update);
        };
      }, []);
      tabRef.current = tab;
      filterRef.current = appliedFilter;
      selectedCaseRef.current = selectedCaseId;
      routingWindowRef.current = resources.routingReview.window;
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
        // The inbox aggregates every workspace of this profile: an open session
        // is not a precondition, only the authorization of the read itself.
        const token = ++requestsRef.current.inbox;
        patchResource("inbox", { status: "loading", error: null });
        try {
          const value = model.narrowInbox(await actions.inbox());
          if (valid("inbox", token, epoch, requestSession)) {
            patchResource("inbox", { status: "ready", value, error: null });
            // One authoritative read feeds the navigation count, the list total
            // and the sidebar bubble: publish it instead of reading twice.
            props.publishPendingCount?.(value.length);
          }
        } catch (reason) { if (valid("inbox", token, epoch, requestSession)) patchResource("inbox", { status: "error", error: asError(reason) }); }
      };
      const loadRecords = async (nextFilter = appliedFilter, requestSession = sessionId, epoch = epochRef.current) => {
        if (!requestSession) return;
        const token = ++requestsRef.current.records;
        patchResource("records", { status: "loading", error: null, value: [], nextCursor: null, loadingMore: false, loadMoreError: null });
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
          const page = model.narrowRecords(await actions.records(appliedFilter, { after: cursor }));
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
      const loadRoutingReview = async (nextWindow = routingWindowRef.current, requestSession = sessionId, epoch = epochRef.current) => {
        if (!requestSession) return;
        const token = ++requestsRef.current.routingReview;
        routingAppendRef.current = false;
        patchResource("routingReview", { status: "loading", error: null, value: [], summary: {}, window: nextWindow, nextCursor: null, loadingMore: false, loadMoreError: null });
        try {
          const page = model.narrowRoutingReview(await actions.routingReview(nextWindow));
          if (valid("routingReview", token, epoch, requestSession)) patchResource("routingReview", { status: "ready", value: page.items, summary: page.summary, window: nextWindow, nextCursor: page.nextCursor, error: null });
        } catch (reason) {
          if (valid("routingReview", token, epoch, requestSession)) patchResource("routingReview", { status: "error", error: asError(reason) });
        }
      };
      const loadMoreRouting = async () => {
        const current = resources.routingReview;
        const cursor = current.nextCursor;
        if (!sessionId || !cursor || current.status !== "ready" || current.loadingMore || routingAppendRef.current) return;
        const requestSession = sessionId;
        const requestWindow = current.window;
        const epoch = epochRef.current;
        const token = ++requestsRef.current.routingReview;
        routingAppendRef.current = true;
        patchResource("routingReview", { loadingMore: true, loadMoreError: null });
        try {
          const page = model.narrowRoutingReview(await actions.routingReview(requestWindow, cursor));
          if (valid("routingReview", token, epoch, requestSession)) {
            routingAppendRef.current = false;
            setResources(state => {
              const latest = state.routingReview;
              if (latest.window !== requestWindow || latest.nextCursor !== cursor) return state;
              const appended = model.appendRoutingPage(latest.value, page);
              return { ...state, routingReview: { ...latest, value: appended.items, nextCursor: appended.nextCursor, loadingMore: false, loadMoreError: null } };
            });
          }
        } catch (reason) {
          if (valid("routingReview", token, epoch, requestSession)) {
            routingAppendRef.current = false;
            patchResource("routingReview", { loadingMore: false, loadMoreError: asError(reason) });
          }
        }
      };
      // ---- public memory zone -------------------------------------------------
      // One automatic read per assistant per open. A re-render never triggers
      // another model-carrying refresh; only an explicit user action does.
      const readPublicCandidate = async (agentId, requestSession, epoch) => {
        const token = ++publicCandidateRef.current;
        setPublicMemory(current => ({ ...current, candidatePhase: "loading", candidateError: null }));
        try {
          const detail = await actions.publicCandidate(agentId);
          if (publicCandidateRef.current !== token || epochRef.current !== epoch || sessionId !== requestSession) return null;
          setPublicMemory(current => ({ ...current, candidate: detail ?? null, candidatePhase: detail ? "ready" : "idle" }));
          return detail;
        } catch (reason) {
          if (publicCandidateRef.current === token && epochRef.current === epoch && sessionId === requestSession) {
            setPublicMemory(current => ({ ...current, candidate: null, candidatePhase: "error", candidateError: asError(reason) }));
          }
          return null;
        }
      };
      const loadPublicMemory = async (agentId, options = {}) => {
        const requestSession = options.sessionId ?? sessionId;
        const epoch = options.epoch ?? epochRef.current;
        if (!requestSession || typeof agentId !== "string" || !agentId) return null;
        const loadKey = `${epoch}:${agentId}`;
        if (!options.force && publicLoadRef.current === loadKey) return null;
        publicLoadRef.current = loadKey;
        const token = ++requestsRef.current.publicMemory;
        setPublicMemory(current => ({ ...current, phase: "loading", error: null, agentId }));
        try {
          const value = await actions.publicMemoryRefresh(agentId, {
            ...(options.acknowledgedDisclosure === true ? { acknowledgedDisclosure: true } : {}),
            ...(options.retryFailedExtraction === true ? { retryFailedExtraction: true } : {}),
          });
          if (!valid("publicMemory", token, epoch, requestSession)) return null;
          setPublicMemory(current => ({ ...current, phase: "ready", value: value ?? null, error: null }));
          if (value?.candidate?.snapshotId) await readPublicCandidate(agentId, requestSession, epoch);
          return value;
        } catch (reason) {
          if (valid("publicMemory", token, epoch, requestSession)) setPublicMemory(current => ({ ...current, phase: "error", value: null, error: asError(reason), candidate: null, candidatePhase: "idle" }));
          return null;
        }
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
      const openLearningRecord = async caseId => {
        const requestSession = sessionId;
        const epoch = epochRef.current;
        const value = await readRecord(caseId, { force: true, sessionId: requestSession, epoch });
        if (!value || value.case?.caseId !== caseId || epochRef.current !== epoch || sessionId !== requestSession) return null;
        setTab("records"); setSelectedCaseId(caseId); setDrillIn(true);
        if (resources.records.status === "idle" || resources.records.status === "error") loadRecords(appliedFilter, requestSession, epoch);
        return value;
      };
      const readLearning = async (agentValue, learningRunId) => {
        const requestSession = sessionId;
        const epoch = epochRef.current;
        const token = ++requestsRef.current.learning;
        const runs = learningRows(agentValue?.learningRuns);
        const snapshots = learningRows(agentValue?.snapshots);
        const candidateRun = runs.find(run => run.outcome === "candidate") ?? null;
        const currentSummary = snapshots.find(snapshot => snapshot.snapshotId === agentValue?.currentSnapshotId) ?? null;
        const selectedRunId = learningRunId ?? candidateRun?.learningRunId ?? runs[0]?.learningRunId ?? currentSummary?.learningRunId ?? null;
        if (valid("learning", token, epoch, requestSession)) setLearningError(null);
        if (!selectedRunId && !currentSummary) { if (valid("learning", token, epoch, requestSession)) setLearningDetail(null); return; }
        if (valid("learning", token, epoch, requestSession)) setLearningLoading(true);
        const runReads = new Map();
        const snapshotReads = new Map();
        const readRun = id => {
          if (!runReads.has(id)) runReads.set(id, Promise.resolve().then(() => actions.learningRun(id)));
          return runReads.get(id);
        };
        const readSnapshot = id => {
          if (!snapshotReads.has(id)) snapshotReads.set(id, Promise.resolve().then(() => actions.memorySnapshot(id)));
          return snapshotReads.get(id);
        };
        const readReview = async runId => {
          const run = await readRun(runId);
          const snapshotSummary = snapshots.find(snapshot => snapshot.learningRunId === runId);
          const parentSnapshotId = snapshotSummary?.parentSnapshotId ?? run?.inputFrozen?.parentSnapshotId ?? null;
          const [snapshot, parentSnapshot] = await Promise.all([
            snapshotSummary ? readSnapshot(snapshotSummary.snapshotId) : Promise.resolve(null),
            parentSnapshotId ? readSnapshot(parentSnapshotId) : Promise.resolve(null),
          ]);
          return { agentId: agentValue.agentId, run, snapshot, parentSnapshot };
        };
        try {
          const candidatePromise = candidateRun ? readReview(candidateRun.learningRunId) : Promise.resolve(null);
          const inspectionPromise = selectedRunId ? readReview(selectedRunId) : Promise.resolve(null);
          const currentPromise = currentSummary ? Promise.all([
            readSnapshot(currentSummary.snapshotId),
            currentSummary.learningRunId ? readRun(currentSummary.learningRunId) : Promise.resolve(null),
          ]).then(([snapshot, run]) => ({ agentId: agentValue.agentId, snapshot, run })) : Promise.resolve(null);
          const [candidate, inspection, current] = await Promise.all([candidatePromise, inspectionPromise, currentPromise]);
          const sourceRecords = learningRows(candidate?.snapshot?.sourceRecords ?? candidate?.run?.sourceRecords);
          const caseIds = [...new Set(sourceRecords.map(record => record.kind === "case" ? record.caseId ?? record.sourceId : record.caseId).filter(value => typeof value === "string"))];
          const recordAccess = Object.fromEntries(await Promise.all(caseIds.map(async caseId => {
            try {
              const value = await actions.record(caseId);
              return [caseId, value?.case?.caseId === caseId];
            } catch { return [caseId, false]; }
          })));
          if (valid("learning", token, epoch, requestSession)) setLearningDetail({ agentId: agentValue.agentId, candidate, inspection, current, recordAccess });
        } catch (reason) {
          if (valid("learning", token, epoch, requestSession)) setLearningError(asError(reason));
        } finally { if (valid("learning", token, epoch, requestSession)) setLearningLoading(false); }
      };
      const selectAgent = async agentId => {
        const requestSession = sessionId;
        const epoch = epochRef.current;
        const token = ++requestsRef.current.agent;
        requestsRef.current.learning += 1;
        const previous = resources.agent.value;
        const sameAgent = previous?.agentId === agentId;
        setSelectedAgentId(agentId);
        // Switching assistants abandons the review in place: no draft wording and no
        // edit counters may leak into another assistant's candidate. A re-read of the
        // same assistant keeps both, so a save round-trip preserves the counts.
        if (!sameAgent) { setCandidateEditor(null); setCandidateEditorError(null); setCandidateEdits(null); }
        // A learning/snapshot action reloads the assistant it just changed. Keep that
        // previous detail mounted while the authoritative read is in flight: resetting
        // to the loading state unmounts the whole detail for one frame, the page
        // collapses to the viewport height, and the browser clamps its scrollTop to 0
        // before the fresh content can shrink to the new maximum.
        patchResource("agent", sameAgent ? { status: "ready", value: previous, error: null } : { status: "loading", value: null, error: null });
        setLearningDetail(null); setLearningError(null); setLearningLoading(false);
        publicLoadRef.current = null;
        publicCandidateRef.current += 1;
        setPublicMemory(emptyPublicMemory());
        try {
          const value = await actions.agent(agentId);
          if (!valid("agent", token, epoch, requestSession)) return;
          patchResource("agent", { status: "ready", value, error: null });
          if (value?.publicMemory) {
            setPublicMemory(current => ({ ...current, phase: "ready", value: { ...value.publicMemory, agentId: value.agentId }, error: null }));
          }
          await readLearning(value);
          await loadPublicMemory(agentId, { sessionId: requestSession, epoch });
        } catch (reason) { if (valid("agent", token, epoch, requestSession)) patchResource("agent", { status: "error", value: null, error: asError(reason) }); }
      };
      // A learning/snapshot action reloads the assistant the user is reading, and
      // Chromium's scroll anchoring then rewrites the pane's scrollTop in the same
      // frame the reloaded card commits (measured: 690 -> 446 while the scroll
      // range grew). The pane holds its own offset across the whole action instead:
      // capture the offset once, disable anchoring, pin the captured offset back
      // against every committed range, and hand the inline rule back exactly when
      // the action has settled. The pending state clears after the reload and
      // clearing it is itself a commit that reflows the card (measured 739 -> 705
      // about 50ms after the first commit), so the hold outlives the reload.
      const detailScrollHold = react.useRef(null);
      const detailScrollEpoch = react.useRef(0);
      const pinDetailScroll = hold => {
        if (!hold?.pane) return;
        hold.pane.scrollTop = Math.min(hold.captured, Math.max(0, (Number(hold.pane.scrollHeight) || 0) - (Number(hold.pane.clientHeight) || 0)));
      };
      const holdDetailScroll = () => {
        // A new action can start while the previous one is still settling: it
        // takes the existing hold over (same original inline rule, new offset)
        // instead of stacking a second one that would hand back "none" later.
        const existing = detailScrollHold.current;
        if (existing) {
          existing.captured = Math.max(0, Number(existing.pane?.scrollTop) || 0);
          existing.epoch = detailScrollEpoch.current += 1;
          if (existing.style) existing.style.overflowAnchor = "none";
          return existing;
        }
        const pane = agentDetailPaneRef.current;
        const style = pane?.style;
        const hold = { pane, style, captured: Math.max(0, Number(pane?.scrollTop) || 0), previousAnchor: style?.overflowAnchor ?? "", epoch: detailScrollEpoch.current += 1 };
        detailScrollHold.current = hold;
        if (style) style.overflowAnchor = "none";
        return hold;
      };
      const restoreDetailScrollAnchor = hold => {
        if (!hold?.style) return;
        // A modal owns these inline rules while it is open (its scroll lock hands
        // them back itself); never write over an open dialog from here.
        if (typeof hold.pane?.ownerDocument?.querySelector === "function" && hold.pane.ownerDocument.querySelector("dialog[open]")) return;
        if (hold.previousAnchor) hold.style.overflowAnchor = hold.previousAnchor;
        else if (typeof hold.style.removeProperty === "function") hold.style.removeProperty("overflow-anchor");
        else hold.style.overflowAnchor = "";
      };
      const preserveDetailScroll = async reload => {
        const hold = holdDetailScroll();
        try { return await reload(); } finally {
          // The authoritative read resolves before React commits the fresh card,
          // and a nested scroll lock (the publish dialog) hands its own anchoring
          // rule back while it closes: hold until the commit frame and pin there.
          if (hold.style) hold.style.overflowAnchor = "none";
          const view = hold.pane?.ownerDocument?.defaultView;
          if (typeof view?.requestAnimationFrame === "function") {
            await new Promise(resolve => view.requestAnimationFrame(() => resolve()));
          }
          pinDetailScroll(hold);
        }
      };
      // Bounded settle: the frames right after the action's pending state clears,
      // while a late commit can still reflow the card.
      const settleDetailScroll = async () => {
        const hold = detailScrollHold.current;
        if (!hold) return;
        const view = hold.pane?.ownerDocument?.defaultView;
        if (typeof view?.requestAnimationFrame === "function") {
          for (let frame = 0; frame < 10; frame += 1) {
            await new Promise(resolve => view.requestAnimationFrame(() => resolve()));
            if (hold.epoch !== detailScrollEpoch.current) return;
            pinDetailScroll(hold);
          }
        }
        if (hold.epoch !== detailScrollEpoch.current) return;
        if (detailScrollHold.current === hold) detailScrollHold.current = null;
        restoreDetailScrollAnchor(hold);
      };
      const run = async (method, ...args) => {
        if (pendingRef.current) return;
        pendingRef.current = true; setPending(method); setActionError(null);
        const requestSession = sessionId;
        const epoch = epochRef.current;
        try {
          const result = await actions[method](...args);
          // A ruling that could not reach its source session is reported once,
          // in plain language: the answer stays authoritative either way.
          if (result?.delivery?.state === "unavailable") setDeliveryNotice({ method, caseId: args[0] ?? null });
          if (["decide", "reassign", "retry", "cancel", "feedback", "correction", "clarify", "returnToCaller"].includes(method)) {
            const caseId = args[0];
            const authoritative = await actions.record(caseId);
            if (!authoritative?.case) throw new Error("Decision record reread returned no record");
            if (epochRef.current !== epoch || sessionId !== requestSession) return;
            setResources(current => ({ ...current, details: { ...current.details, [caseId]: { status: "ready", value: authoritative, error: null } } }));
            await loadInbox(requestSession, epoch);
            // The sidebar bubble and every other decision surface converge on
            // this action without waiting for the poll.
            props.refreshPending?.();
            if (method === "decide") clearDraft(caseId, ["answers"]);
            if (method === "reassign") clearDraft(caseId, ["reassignTarget"]);
            if (method === "feedback" && args[1] === "comment") clearDraft(caseId, ["comment"]);
            if (method === "correction") clearDraft(caseId, ["correction"]);
            if (method === "clarify") clearDraft(caseId, ["clarifyQuestion"]);
            if (method === "returnToCaller") clearDraft(caseId, ["bounceNote"]);
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
            if (method === "profileUpsert") { setEditor(null); requestAgentFocus("detail"); }
          } else if (method === "profileDelete") {
            // The deleted assistant is gone for good: drop the selection, go
            // back to the list and reread it authoritatively.
            const agentRows = await actions.agents();
            if (epochRef.current !== epoch || sessionId !== requestSession) return;
            setResources(current => ({ ...current,
              agents: { ...current.agents, status: "ready", value: Array.isArray(agentRows) ? agentRows : [], error: null },
              agent: { status: "idle", value: null, error: null },
            }));
            setSelectedAgentId(null);
            backToAgents();
          } else if (method.startsWith("learning") || method.startsWith("snapshot")) {
            const selected = resources.agent.value;
            if (selected) await preserveDetailScroll(() => selectAgent(selected.agentId));
          }
          if (publicActionRef.current) {
            publicActionRef.current = false;
            requestAgentFocus("public");
          }
          lastActionErrorRef.current = null;
          setActionError(null);
          return result;
        } catch (reason) {
          if (epochRef.current === epoch && sessionId === requestSession) {
            const failure = asError(reason, "DECISION_ACTION_FAILED");
            lastActionErrorRef.current = failure;
            setActionError(failure);
            if (["snapshotPublish", "snapshotReject", "snapshotRollback"].includes(method)) {
              const selected = resources.agent.value;
              if (selected) await preserveDetailScroll(() => selectAgent(selected.agentId));
            }
          }
          return undefined;
        } finally {
          if (epochRef.current === epoch && sessionId === requestSession) {
            pendingRef.current = false;
            setPending(null);
            // Clearing the pending state is the action's last commit, and it can
            // reflow the card the user is reading: release the pane hold only
            // after that commit and its settle frames have landed.
            await settleDetailScroll();
          }
        }
      };
      /**
       * The entries a deletion can hand focus to: the next editable one, else the
       * previous one. Read from the same review projection the list renders, before
       * the entry disappears.
       */
      const candidateNeighborIds = principleId => {
        const detail = learningDetail?.candidate ? { agentId: learningDetail.agentId, ...learningDetail.candidate } : learningDetail;
        const view = typeof props.learning?.learningView === "function"
          ? props.learning.learningView({ agent: resources.agent.value, detail, candidateReadiness: model.candidateReadiness })
          : null;
        const order = (view?.changes ?? []).filter(change => change.editable).map(change => change.principleId);
        const at = order.indexOf(principleId);
        if (at < 0) return [];
        return [order[at + 1], order[at - 1]].filter(value => typeof value === "string");
      };
      /** One stable ref object per candidate entry action, so focus can return to a
       * row after the authoritative re-read replaced every node. */
      const candidateEntryRef = (principleId, action = "edit") => {
        const key = `${action}:${principleId}`;
        const refs = candidateEntryRefs.current;
        if (!refs[key]) refs[key] = { current: null };
        return refs[key];
      };
      /** Seed the inline editor from the entry's current content. Only wording and
       * the workspace-agnostic hints are editable; the scope's workspace list stays
       * on the Host. */
      const openCandidateEditor = item => {
        const content = item?.after;
        if (!content || typeof item.principleId !== "string" || pendingRef.current) return;
        const scope = content.scope && typeof content.scope === "object" ? content.scope : {};
        const classes = Array.isArray(scope.authorizationClasses) ? scope.authorizationClasses.filter(entry => ["A", "B", "C"].includes(entry)) : [];
        setCandidateEditorError(null);
        setCandidateEditor({
          principleId: item.principleId,
          text: typeof content.text === "string" ? content.text : "",
          paths: Array.isArray(scope.paths) ? [...scope.paths] : [],
          tags: Array.isArray(scope.tags) ? [...scope.tags] : [],
          classes,
        });
        requestAgentFocus("candidate-editor");
      };
      const draftCandidateEditor = patch => setCandidateEditor(current => current && patch ? { ...current, ...patch } : current);
      const closeCandidateEditor = () => {
        const principleId = candidateEditor?.principleId;
        setCandidateEditor(null); setCandidateEditorError(null);
        if (principleId) requestAgentFocus({ target: "candidate", principleIds: [principleId] });
      };
      /** Count this review's own successful writes per candidate, so the publish
       * confirmation can state them as a fact (and only for the same candidate). */
      const recordCandidateEdit = (snapshotId, field) => {
        setCandidateEdits(current => current && current.snapshotId === snapshotId
          ? { ...current, [field]: (Number(current[field]) || 0) + 1 }
          : { snapshotId, edited: 0, removed: 0, [field]: 1 });
      };
      /**
       * One candidate update through the shared pending/epoch guard. A failure keeps
       * the inline editor and its wording; a revision conflict additionally rereads
       * the authoritative candidate, so the next save uses the current revision
       * instead of silently overwriting what changed underneath.
       */
      const submitCandidateUpdate = async (target, edits) => {
        const result = await run("snapshotUpdate", target.snapshotId, target.expectedRevision, edits);
        if (result) { lastActionErrorRef.current = null; return result; }
        const failure = lastActionErrorRef.current;
        const conflict = failure?.code === "REVISION_CONFLICT" || failure?.code === "SNAPSHOT_STATE_CONFLICT";
        setCandidateEditorError(conflict ? "decisionPrincipleConflict" : "decisionPrincipleSaveFailed");
        if (conflict) {
          const selected = resources.agent.value;
          if (selected) await preserveDetailScroll(() => selectAgent(selected.agentId));
        }
        return undefined;
      };
      const saveCandidateEditor = async target => {
        const editor = candidateEditor;
        if (!editor || pendingRef.current) return;
        const text = typeof editor.text === "string" ? editor.text : "";
        if (text.trim().length === 0 || text.length > 600) return;
        const scope = {};
        const paths = [...new Set(editor.paths.map(row => row.trim()).filter(Boolean))];
        if (paths.length) scope.paths = paths;
        const tags = [...new Set(editor.tags.map(row => row.trim()).filter(Boolean))];
        if (tags.length) scope.tags = tags;
        const classes = ["A", "B", "C"].filter(entry => editor.classes.includes(entry));
        if (classes.length) scope.authorizationClasses = classes;
        const result = await submitCandidateUpdate(target, [{ principleId: editor.principleId, text, scope }]);
        if (!result) return;
        recordCandidateEdit(target.snapshotId, "edited");
        setCandidateEditor(null); setCandidateEditorError(null);
        requestAgentFocus({ target: "candidate", principleIds: [editor.principleId] });
      };
      const removeCandidatePrinciple = async action => {
        if (!action || pendingRef.current) return;
        const result = await submitCandidateUpdate(action, [{ principleId: action.principleId, remove: true }]);
        if (!result) return;
        recordCandidateEdit(action.snapshotId, "removed");
        setCandidateEditor(null); setCandidateEditorError(null);
        requestAgentFocus({ target: "candidate", principleIds: [...(action.neighborIds ?? [])] });
      };
      const startLearning = async agentId => {
        const selected = resources.agent.value;
        const runs = learningRows(selected?.learningRuns);
        if (pendingRef.current || selected?.agentId !== agentId || selected.state !== "enabled"
          || runs.some(item => item.outcome === "running" || item.outcome === "candidate")) return;
        let intent = learningIntentRef.current;
        if (!intent || intent.sessionId !== sessionId || intent.agentId !== agentId) {
          intent = { sessionId, agentId, requestId: window.crypto.randomUUID() };
          learningIntentRef.current = intent;
        }
        const result = await run("learningStart", agentId, intent.requestId);
        if (result !== undefined && learningIntentRef.current === intent) learningIntentRef.current = null;
        return result;
      };
      const editorDirty = () => editor && ["name", "preference", "scopeText", "routeText"].some(field => editor[field] !== editor.baseline[field]);
      const closeEditor = after => {
        const closingMode = editor?.mode;
        if (editorDirty()) { setConfirm({ kind: "discard-editor", after }); return; }
        setEditor(null); if (!after) requestAgentFocus(closingMode === "create" ? "create-list" : "detail"); after?.();
      };
      const openCreate = () => {
        if (!agentDrillIn && editor?.mode === "create") { setAgentDrillIn(true); requestAgentFocus("editor"); return; }
        closeEditor(() => { setAgentDrillIn(true); setSelectedAgentId(null); patchResource("agent", emptyResource()); setEditor(newAgentEditor()); requestAgentFocus("editor"); });
      };
      const openAgent = agentId => {
        if (!agentDrillIn && selectedAgentId === agentId) { setAgentDrillIn(true); requestAgentFocus(editor?.mode === "edit" && editor.agentId === agentId ? "editor" : "detail"); return; }
        closeEditor(() => { setAgentDrillIn(true); requestAgentFocus("detail"); return selectAgent(agentId); });
      };
      const backToAgents = () => { setAgentDrillIn(false); requestAgentFocus(editor?.mode === "create" ? "create-list" : "summary"); };
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
      /**
       * One export gesture: the Host derives the scope, the file is written by
       * the old session's authority, and the page only records the real result.
       * A thrown or incomplete result becomes an actionable failure state.
       */
      const startExport = async options => {
        const focusResult = options?.focusResult === true;
        if (exportPendingRef.current) return;
        exportPendingRef.current = true;
        setExportState({ phase: "pending", value: null, error: null, copied: false });
        const requestSession = sessionId;
        const epoch = epochRef.current;
        try {
          const value = await actions.exportData();
          if (epochRef.current !== epoch || sessionId !== requestSession) return;
          const checked = model.exportResult(value);
          setExportState(checked.valid
            ? { phase: "success", value: checked.result, error: null, copied: false }
            : { phase: "error", value: null, error: { code: "EXPORT_INVALID_RESULT" }, copied: false });
          if (checked.valid && focusResult) exportFocusRef.current = true;
        } catch (reason) {
          if (epochRef.current !== epoch || sessionId !== requestSession) return;
          setExportState({ phase: "error", value: null, error: asError(reason, "EXPORT_FAILED"), copied: false });
        } finally {
          exportPendingRef.current = false;
        }
      };
      const copyExportPath = async () => {
        const file = exportState.value?.file;
        if (typeof file !== "string" || !file) return;
        try {
          await globalThis.navigator?.clipboard?.writeText?.(file);
          setExportState(current => ({ ...current, copied: true }));
        } catch {
          // The path stays on screen; copying is a convenience, not the result.
        }
      };
      const filterField = (key, value) => setFilter(current => ({ ...current, [key]: value || undefined }));
      const applyFilters = () => { setSelectedCaseId(null); setDrillIn(false); setAppliedFilter(filter); loadRecords(filter); };
      const navigate = (next, force = false) => {
        if (!force && tab === "agents" && next !== "agents" && editorDirty()) { setConfirm({ kind: "discard-editor", after: () => navigate(next, true) }); return; }
        setTab(next);
        if (next === "records") {
          setDrillIn(false);
          if (resources.records.status === "idle" || resources.records.status === "error") loadRecords();
        } else if (next === "agents" && (resources.agents.status === "idle" || resources.agents.status === "error")) loadAgents();
        else if (next === "inbox" && (resources.inbox.status === "idle" || resources.inbox.status === "error")) loadInbox();
        else if (next === "metrics") {
          if (resources.metrics.status !== "loading" && resources.metrics.status !== "ready") loadMetrics();
          if (resources.routingReview.status === "idle" || resources.routingReview.status === "error") loadRoutingReview();
        }
      };
      react.useEffect(() => {
        const openCaseId = props.consumeOpenCase?.();
        const agentDestination = props.consumeAgentDestination?.();
        const epoch = ++epochRef.current;
        requestsRef.current = { agents: 0, inbox: 0, records: 0, metrics: 0, routingReview: 0, agent: 0, learning: 0, publicMemory: 0, details: {} };
        pendingRef.current = false;
        routingAppendRef.current = false;
        routingWindowRef.current = "all";
        learningIntentRef.current = null;
        setPending(null); setActionError(null); setResources(emptyResources());
        setSelectedCaseId(null); setDrillIn(false); setFilter({}); setAppliedFilter({}); setLearningDetail(null); setLearningError(null); setLearningLoading(false); setConfirm(null); setSelectedAgentId(null);
        setPublicMemory(emptyPublicMemory()); publicLoadRef.current = null; publicCandidateRef.current += 1; publicActionRef.current = false;
        setExportState({ phase: "idle", value: null, error: null, copied: false }); exportPendingRef.current = false;
        setAgentDrillIn(agentDestination === "create" && !openCaseId);
        setEditor(agentDestination === "create" && !openCaseId ? newAgentEditor() : null);
        setAgentFocusRequest(agentDestination === "create" && !openCaseId ? { target: "editor" } : null);
        setTab(openCaseId ? "records" : agentDestination ? "agents" : "inbox");
        loadInbox(sessionId, epoch);
        setDeliveryNotice(null);
        if (sessionId) {
          loadAgents(sessionId, epoch);
          if (openCaseId) { loadRecords({}, sessionId, epoch); readRecord(openCaseId, { select: true, sessionId, epoch, force: true }); }
        }
        const subscription = props.panelInfo?.subscribe?.(value => {
          if ((value?.activePanelId ?? value) !== PAGE_ID) return;
          loadInbox(sessionId, epoch);
          if (!sessionId) return;
          loadAgents(sessionId, epoch);
          if (tabRef.current === "records") {
            loadRecords(filterRef.current, sessionId, epoch);
            if (selectedCaseRef.current) readRecord(selectedCaseRef.current, { sessionId, epoch, force: true });
          } else if (tabRef.current === "metrics") { loadMetrics(sessionId, epoch); loadRoutingReview(routingWindowRef.current, sessionId, epoch); }
        });
        return () => { subscription?.(); if (epochRef.current === epoch) epochRef.current += 1; };
      }, [sessionId]);
      const retryState = (resource, retry) => jsx.jsx(ui.ErrorState, { children: jsx.jsxs("div", { className: "weir-da-actions", children: [
        jsx.jsx("span", { children: readFailure(resource.error) }, "message"),
        jsx.jsx(ui.Button, { onClick: retry, children: t("decisionRetry") }, "retry"),
      ] }) });
      const noSession = jsx.jsx(ui.EmptyState, { children: t("decisionNoSession") });
      // Every pending Case of this profile, grouped for reading. The switch only
      // appears when the pending items actually span two or more workspaces.
      const inboxRows = resources.inbox.value;
      const grouping = model.groupInbox(inboxRows, {
        by: groupBy, workspaces: hostWorkspaces, sessions: hostSessions,
        agents: resources.agents.value, t, currentSessionId: sessionId,
      });
      const inboxGrouping = grouping.switchable ? jsx.jsx("div", {
        className: "weir-da-inbox-grouping", role: "group", "aria-label": t("decisionInboxGrouping"),
        "data-inbox-grouping": groupBy,
        children: [
          jsx.jsx(ui.Button, { variant: "ghost", "data-group-by": "workspace", "aria-pressed": groupBy === "workspace", onClick: () => setGroupBy("workspace"), children: t("decisionInboxGroupByWorkspace") }, "workspace"),
          jsx.jsx(ui.Button, { variant: "ghost", "data-group-by": "agent", "aria-pressed": groupBy === "agent", onClick: () => setGroupBy("agent"), children: t("decisionInboxGroupByAgent") }, "agent"),
        ],
      }) : null;
      const inboxContent = resources.inbox.status === "error" ? retryState(resources.inbox, () => loadInbox())
        : resources.inbox.status !== "ready" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : inboxRows.length ? jsx.jsxs("div", { className: "weir-da-inbox-groups", "data-inbox-workspace-count": grouping.workspaceCount, "data-inbox-switchable": grouping.switchable ? "true" : "false", children: [
            inboxGrouping,
            grouping.groups.map(group => jsx.jsxs("section", { className: "weir-da-inbox-group", "data-inbox-group": group.key, children: [
              jsx.jsxs("h2", { className: "weir-da-inbox-group-header", children: [
                jsx.jsx("span", { className: "weir-da-inbox-group-label", children: group.label }, "label"),
                jsx.jsx("span", { className: "weir-da-count", "data-inbox-group-count": group.count, children: String(group.count) }, "count"),
              ] }, "header"),
              jsx.jsx("div", { className: "weir-da-card-list", children: group.items.map(item => jsx.jsx(InboxItem, {
                item, agents: resources.agents.value, run, pending, model, ui, t,
                workspaceLabel: item.workspaceLabel,
                openSourceSession: item.openSourceSession === true,
                onOpenSourceSession: () => props.openSession?.(item.sessionId),
                draft: model.readDraft(drafts, draftScope, item.caseId), updateDraft: (field, value) => updateDraft(item.caseId, field, value),
                evidence: resources.details[item.caseId], loadEvidence: force => readRecord(item.caseId, { force }),
                requestCancel: () => setConfirm({ kind: "cancel", caseId: item.caseId }),
              }, item.caseId)) }, "list"),
            ] }, group.key)),
          ] })
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
      const listBody = resources.records.status === "error" ? retryState(resources.records, () => loadRecords())
        : resources.records.status !== "ready" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : resources.records.value.length ? resources.records.value.map(record => {
          const summary = model.recordSummary(record, resources.agents.value, t);
          // The row stays a content-sized block inside the scrolling stack:
          // the list's children are flex: 0 0 auto (a single-column grid
          // collapsed its auto tracks to min-height under overflow, and
          // default flex children shrink — both painted rows over each
          // other). The inline display/width are belt-and-suspenders on top
          // of the stylesheet so no chunk-cache mix can reintroduce it.
          const openRecordRow = () => readRecord(record.caseId, { select: true });
          return jsx.jsxs("div", { className: "weir-da-record-row", style: { display: "block", width: "100%", boxSizing: "border-box" }, "data-case-id": record.caseId, role: "button", tabIndex: 0, "aria-pressed": selectedCaseId === record.caseId, onClick: openRecordRow, onKeyDown: event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openRecordRow() } }, children: [
            jsx.jsx("strong", { children: summary?.title ?? t("decisionRecord") }, "title"),
            jsx.jsx("span", { children: `${summary?.agentName ?? t("decisionSelector")} · ${t(summary?.statusKey ?? "decisionStatusUnknown")}` }, "meta"),
            summary?.time ? jsx.jsx("time", { children: readableTime(summary.time) }, "time") : null,
          ] }, record.caseId);
        }) : jsx.jsx(ui.EmptyState, { children: t(model.recordEmptyState({ sessionId, filtered: Object.values(appliedFilter).some(Boolean) })) });
      const exportView = model.exportView(exportState);
      const recordsContent = !sessionId ? noSession : jsx.jsxs("div", { className: "weir-da-records-view", children: [
        RecordFilters({ filter, agents: resources.agents.value, model, ui, t, onChange: filterField, onApply: applyFilters, advanced: RecordsAdvancedActions({ view: exportView, ui, t, buttonRef: exportButtonRef, onRequest: () => setConfirm({ kind: "export" }) }) }),
        ExportResult({ view: exportView, ui, t, onRetry: () => startExport({ focusResult: true }), onCopy: copyExportPath }),
        jsx.jsxs("div", { className: "weir-da-records-layout", "data-drill-in": drillIn, children: [
          jsx.jsxs("div", { className: "weir-da-record-list", "aria-label": t("decisionRecords"), children: [
            listBody,
            resources.records.loadMoreError ? retryState({ error: resources.records.loadMoreError }, loadMore) : null,
            resources.records.nextCursor ? jsx.jsx(ui.Button, { "data-load-more": true, disabled: resources.records.loadingMore, "aria-busy": resources.records.loadingMore === true, onClick: loadMore, children: resources.records.loadingMore ? t("decisionLoadingShort") : t("decisionLoadMore") }, "more") : null,
          ] }, "list"),
          jsx.jsxs("div", { className: "weir-da-record-detail-pane", children: [
            jsx.jsx(ui.Button, { variant: "ghost", className: "weir-da-record-back", onClick: () => setDrillIn(false), children: t("decisionBackToRecords") }, "back"),
            recordContent,
          ] }, selectedCaseId ?? "detail"),
        ] }, "layout"),
      ] });
      const selectedAgent = resources.agent.status === "ready" ? resources.agent.value : null;
      const agentList = resources.agents.status === "error" ? retryState(resources.agents, () => loadAgents())
        : resources.agents.status !== "ready" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : resources.agents.value.length ? resources.agents.value.map(agent => AgentSummary({
          agent, detail: selectedAgent, selected: selectedAgentId === agent.agentId, ui, t, onOpen: openAgent, openRef: selectedAgentId === agent.agentId ? agentSummaryRef : null,
        })) : jsx.jsx(ui.EmptyState, { children: t("decisionNoAgents") });
      const editorVisual = agentVisualState(editor, agentVisual);
      const patchEditorVisual = patch => {
        if (!editor || !editorVisual) return;
        const next = { ...editorVisual, ...patch };
        if ("paths" in patch || "tags" in patch || "classes" in patch) next.scopeText = composeScopeText(next);
        if ("rungs" in patch) next.routeText = composeRouteText(next);
        setAgentVisual(next);
        setEditor(current => {
          if (!current || (current.agentId ?? "create") !== next.key) return current;
          return {
            ...current,
            ...(next.scopeText !== current.scopeText ? { scopeText: next.scopeText } : {}),
            ...(next.routeText !== current.routeText ? { routeText: next.routeText } : {}),
          };
        });
      };
      const agentPane = editor ? AgentEditor({
        editor, ui, t, pending: pending !== null, onSave: saveEditor, onCancel: () => closeEditor(), nameRef: agentNameRef,
        onField: (field, value) => setEditor(current => ({ ...current, [field]: value })),
        visual: editorVisual, onVisual: patchEditorVisual, modelPicker: props.modelPicker, getSession: () => props.getSession?.(),
      }) : resources.agent.status === "loading" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : resources.agent.status === "error" ? retryState(resources.agent, () => selectAgent(selectedAgentId))
        : selectedAgent ? AgentDetail({
          agent: selectedAgent, ui, t, detailRef: agentDetailRef, pending, publicZoneRef,
          publicMemory: model.publicMemoryView({
            phase: publicMemory.phase, value: publicMemory.value, error: publicMemory.error,
            candidate: publicMemory.candidate, candidatePhase: publicMemory.candidatePhase, candidateError: publicMemory.candidateError,
            pending,
          }, t),
          onPublicRefresh: () => loadPublicMemory(selectedAgent.agentId, { force: true, retryFailedExtraction: model.publicMemoryView({ phase: publicMemory.phase, value: publicMemory.value, error: publicMemory.error, candidate: publicMemory.candidate, candidatePhase: publicMemory.candidatePhase, candidateError: publicMemory.candidateError, pending }, t).failed }),
          onPublicAcknowledge: () => loadPublicMemory(selectedAgent.agentId, { force: true, acknowledgedDisclosure: true }),
          onPublicRetry: () => loadPublicMemory(selectedAgent.agentId, { force: true, retryFailedExtraction: true }),
          requestPublicAction: action => { publicActionRef.current = true; setConfirm({ ...action, public: true }); },
          onEdit: () => { setEditor(newAgentEditor(selectedAgent)); requestAgentFocus("editor"); },
          requestState: state => setConfirm({ kind: "agent-state", agentId: selectedAgent.agentId, state }),
          // The delete confirmation always shows fresh authoritative counts;
          // a vanishing assistant falls back to a plain list refresh.
          requestDelete: async () => {
            try {
              const preview = await actions.profileDeletePreview(selectedAgent.agentId);
              if (!preview) { await loadAgents(); backToAgents(); return; }
              setConfirm({ kind: "agent-delete", agentId: selectedAgent.agentId, name: selectedAgent.name, preview });
            } catch (reason) { setActionError(asError(reason)); }
          },
          learningProps: {
            detail: learningDetail, run, pending, t, learning: props.learning, candidateReadiness: model.candidateReadiness,
            candidateEditor, candidateEditorError, candidateEdits, candidateEntryRef: candidateEntryRef,
            onCandidateEdit: openCandidateEditor,
            onCandidateDraft: draftCandidateEditor,
            onCandidateSave: target => saveCandidateEditor(target),
            onCandidateCancel: closeCandidateEditor,
            onCandidateRemove: (item, target) => {
              const neighborIds = candidateNeighborIds(item.principleId);
              return setConfirm({ kind: "candidate-remove", principleId: item.principleId, neighborIds, ...target });
            },
            scopeSummary: model.scopeSummary,
            loading: learningLoading,
            onStart: () => startLearning(selectedAgent.agentId),
            confirmAction: action => setConfirm(action), error: learningError, onRetry: () => readLearning(selectedAgent),
            selectRun: learningRunId => readLearning(selectedAgent, learningRunId),
            selectSnapshot: snapshotId => {
              const snapshot = learningRows(selectedAgent.snapshots).find(item => item.snapshotId === snapshotId);
              return snapshot?.learningRunId ? readLearning(selectedAgent, snapshot.learningRunId) : Promise.resolve();
            },
            openRecord: openLearningRecord,
          },
        }) : jsx.jsx(ui.EmptyState, { children: t("decisionChooseAssistant") });
      const agentsContent = !sessionId ? noSession : jsx.jsxs("div", { className: "weir-da-agents-view", children: [
        jsx.jsxs("div", { ref: agentHeaderRef, className: "weir-da-section-header", children: [
          jsx.jsx("h2", { children: t("decisionAgents") }, "title"),
          jsx.jsx(ui.Button, { ref: agentCreateRef, variant: "primary", "data-action": "create-agent", onClick: openCreate, disabled: pending !== null, children: t("decisionCreateAgent") }, "create"),
        ] }, "header"),
        jsx.jsx("p", { className: "weir-da-caption", "data-agents-shared": true, children: t("decisionAgentsShared") }, "shared"),
        jsx.jsxs("div", { className: "weir-da-agents-layout", "data-agent-drill-in": agentDrillIn, children: [
          jsx.jsx("div", { ref: agentListRef, className: "weir-da-agent-list", "aria-label": t("decisionAgents"), children: agentList }, "list"),
          jsx.jsxs("div", { ref: agentDetailPaneRef, className: "weir-da-agent-detail-pane", children: [
            jsx.jsx(ui.Button, { ref: agentBackRef, variant: "ghost", className: "weir-da-agent-back", onClick: backToAgents, children: `← ${t("decisionAgents")}` }, "back"),
            agentPane,
          ] }, "detail"),
        ] }, "layout"),
      ] });
      const confirmationFocus = { returnFocusFallback: primaryNavRef, openErrorLabel: t("decisionFailed"), dismissLabel: t("decisionCancel") };
      const confirmation = confirm?.kind === "cancel" ? jsx.jsx(ui.ConfirmDialog, { ...confirmationFocus,
        id: "weir-da-cancel-decision", title: t("decisionCancelTitle"), body: t("decisionCancelConfirmation"),
        confirmLabel: t("decisionCancel"), cancelLabel: t("decisionKeepEditing"), danger: true, pending: pending !== null,
        onCancel: () => setConfirm(null), onConfirm: () => { const caseId = confirm.caseId; setConfirm(null); return run("cancel", caseId); },
      }) : confirm?.kind === "discard-editor" ? jsx.jsx(ui.ConfirmDialog, { ...confirmationFocus,
        id: "weir-da-discard-editor", title: t("decisionDiscardTitle"), body: t("decisionDiscardConfirmation"),
        confirmLabel: t("decisionDiscard"), cancelLabel: t("decisionKeepEditing"), danger: true,
        onCancel: () => setConfirm(null), onConfirm: () => { const after = confirm.after; setConfirm(null); setEditor(null); return after?.(); },
      }) : confirm?.kind === "agent-state" ? jsx.jsx(ui.ConfirmDialog, { ...confirmationFocus,
        id: "weir-da-agent-state", title: t(confirm.state === "archived" ? "decisionArchiveTitle" : confirm.state === "disabled" ? "decisionDisableTitle" : "decisionEnableTitle"),
        body: t(confirm.state === "archived" ? "decisionArchiveConfirmation" : confirm.state === "disabled" ? "decisionDisableConfirmation" : "decisionEnableConfirmation"),
        confirmLabel: t(confirm.state === "archived" ? "decisionArchiveAgent" : confirm.state === "disabled" ? "decisionDisableAgent" : "decisionEnableAgent"),
        cancelLabel: t("decisionCancel"), danger: confirm.state === "archived", pending: pending !== null,
        onCancel: () => setConfirm(null), onConfirm: () => { const { agentId, state } = confirm; setConfirm(null); return run("profileSetState", agentId, state); },
      }) : confirm?.kind === "agent-delete" ? jsx.jsx(ui.ConfirmDialog, { ...confirmationFocus,
        id: "weir-da-agent-delete", title: t("decisionDeleteAgentTitle"),
        body: jsx.jsxs("div", { children: [
          jsx.jsx("p", { children: t("decisionDeleteAgentLead") }, "lead"),
          jsx.jsx("p", { children: jsx.jsx("strong", { children: confirm.name }) }, "name"),
          jsx.jsxs("ul", { children: [
            jsx.jsx("li", { "data-delete-count": "cases", children: `${t("decisionDeleteCountCases")}: ${confirm.preview.counts.cases}` }, "cases"),
            jsx.jsx("li", { "data-delete-count": "evidence", children: `${t("decisionDeleteCountEvidence")}: ${confirm.preview.counts.evidence}` }, "evidence"),
            jsx.jsx("li", { "data-delete-count": "feedback", children: `${t("decisionDeleteCountFeedback")}: ${confirm.preview.counts.feedback + confirm.preview.counts.corrections}` }, "feedback"),
            jsx.jsx("li", { "data-delete-count": "learning", children: `${t("decisionDeleteCountLearning")}: ${confirm.preview.counts.learningRuns + confirm.preview.counts.snapshots}` }, "learning"),
          ] }, "counts"),
        ] }),
        confirmLabel: t("decisionDeleteAgentConfirm"), cancelLabel: t("decisionCancel"), danger: true, pending: pending !== null,
        onCancel: () => setConfirm(null),
        onConfirm: () => { const { agentId, preview } = confirm; setConfirm(null); return run("profileDelete", agentId, preview.counts.cases); },
      }) : confirm?.kind === "candidate-remove" ? jsx.jsx(ui.ConfirmDialog, { ...confirmationFocus,
        id: "weir-da-candidate-remove",
        title: t("decisionPrincipleRemoveTitle"), body: jsx.jsx("p", { children: t("decisionPrincipleRemoveBody") }),
        confirmLabel: t("decisionPrincipleRemoveConfirm"), cancelLabel: t("decisionCancel"), danger: true, pending: pending !== null,
        onCancel: () => setConfirm(null),
        onConfirm: () => { const action = confirm; setConfirm(null); return removeCandidatePrinciple(action); },
      }) : confirm?.kind === "export" ? jsx.jsx(ui.ConfirmDialog, { ...confirmationFocus,
        id: "weir-da-export", returnFocus: exportButtonRef,
        title: t("decisionExportTitle"), body: jsx.jsx("p", { children: t("decisionExportConfirmation") }),
        confirmLabel: t("decisionExportConfirm"), cancelLabel: t("decisionCancel"), pending: pending !== null || exportView.busy,
        onCancel: () => setConfirm(null), onConfirm: () => { setConfirm(null); return startExport(); },
      }) : ["snapshotPublish", "snapshotReject", "snapshotRollback"].includes(confirm?.kind) ? jsx.jsx(ui.ConfirmDialog, { ...confirmationFocus,
        id: `weir-da-learning-${confirm.public ? "public-" : ""}${confirm.kind === "snapshotPublish" ? "publish" : confirm.kind === "snapshotReject" ? "reject" : "rollback"}`,
        title: t(confirm.kind === "snapshotPublish"
          ? confirm.public ? "decisionPublicApplyTitle" : "decisionApplyTitle"
          : confirm.kind === "snapshotReject" ? "decisionDiscardCandidateTitle"
            : confirm.public ? "decisionPublicRollbackTitle" : "decisionRollbackTitle"),
        body: jsx.jsxs("div", { children: [
          jsx.jsx("p", { children: t(confirm.kind === "snapshotPublish"
            ? confirm.public ? "decisionPublicApplyConfirmation" : "decisionApplyConfirmation"
            : confirm.kind === "snapshotReject" ? confirm.public ? "decisionPublicDiscardConfirmation" : "decisionDiscardCandidateConfirmation"
              : confirm.public ? "decisionPublicRollbackConfirmation" : "decisionRollbackConfirmation") }, "consequence"),
          confirm.kind === "snapshotPublish" ? jsx.jsx("p", { children: `${t("decisionApplyChangeCount")}: ${confirm.changeCount}` }, "count") : null,
          confirm.kind === "snapshotPublish" ? jsx.jsx("p", { children: `${t(confirm.public ? "decisionPublicParents" : "decisionApplyReplaceCurrent")}: ${confirm.currentVersion === null ? t(confirm.public ? "decisionPublicNoCurrentParent" : "decisionNoCurrentSnapshot") : `${t("decisionPrincipleVersion")} ${confirm.currentVersion}`}` }, "current") : null,
          confirm.kind === "snapshotPublish" ? jsx.jsx("p", { children: t("decisionApplyFutureOnly") }, "future") : null,
          // Only when this review actually edited the candidate: a fact about the
          // user's own work, never a before/after draft.
          confirm.kind === "snapshotPublish" && (Number(confirm.edited) || 0) + (Number(confirm.removed) || 0) > 0
            ? jsx.jsx("p", { "data-apply-user-edits": true, children: `${t("decisionApplyEditedCount")}: ${Number(confirm.edited) || 0} · ${t("decisionApplyRemovedCount")}: ${Number(confirm.removed) || 0}` }, "user-edits")
            : null,
        ] }),
        confirmLabel: t(confirm.kind === "snapshotPublish" ? confirm.public ? "decisionPublicPublish" : "decisionPublish" : confirm.kind === "snapshotReject" ? "decisionReject" : confirm.public ? "decisionPublicRollback" : "decisionRollback"),
        cancelLabel: t("decisionCancel"), danger: confirm.kind !== "snapshotPublish", pending: pending !== null,
        onCancel: () => setConfirm(null),
        onConfirm: () => { const { kind, snapshotId, expectedRevision } = confirm; setConfirm(null); return run(kind, snapshotId, expectedRevision); },
      }) : null;
      const metricsContent = !sessionId ? noSession : resources.metrics.status === "error" ? retryState(resources.metrics, () => loadMetrics())
        : resources.metrics.status !== "ready" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") })
        : MetricsDetails({
          metrics: resources.metrics.value, model, ui, t, agents: resources.agents.value,
          routingReview: resources.routingReview, readFailure,
          onWindow: value => loadRoutingReview(value), onRetry: () => loadRoutingReview(), onMore: loadMoreRouting, onOpenRecord: openLearningRecord,
        });
      return jsx.jsxs("main", { className: "weir-da-page", style: visualPage?.style, "data-visual-viewport": visualPage ? (visualPage.compact ? "compact" : "wide") : undefined, children: [
        jsx.jsx(ui.DecisionStyles, {}, "styles"),
        jsx.jsxs("div", { className: "weir-da-page-inner", children: [
          jsx.jsxs("header", { className: "weir-da-page-header", children: [
            jsx.jsxs("div", { children: [jsx.jsx("h1", { children: t("decisionSelector") }, "title"), jsx.jsx("p", { children: t("decisionPageDescription") }, "description")] }, "copy"),
            jsx.jsx(ui.Button, { variant: "ghost", "data-view": "metrics", onClick: () => navigate("metrics"), "aria-pressed": view.tab === "metrics", children: t("decisionAdvancedDiagnostics") }, "advanced"),
          ] }, "header"),
          // One dismissible inline notice per undelivered ruling: never a standing
          // badge, and never a cross-workspace confirmation step.
          deliveryNotice ? jsx.jsxs("div", { className: "weir-da-delivery-notice", "data-delivery-notice": "unavailable", children: [
            jsx.jsx(ui.Notice, { tone: "warn", children: jsx.jsxs("div", { children: [
              jsx.jsx("strong", { children: t("decisionDeliveryUnavailableTitle") }, "title"),
              jsx.jsx("p", { children: t("decisionDeliveryUnavailable") }, "body"),
            ] }) }, "notice"),
            jsx.jsx(ui.Button, { variant: "ghost", "data-action": "dismiss-delivery-notice", onClick: () => setDeliveryNotice(null), children: t("decisionDeliveryDismiss") }, "dismiss"),
          ] }, "delivery-notice") : null,
          jsx.jsx("nav", { ref: primaryNavRef, tabIndex: -1, className: "weir-da-primary-nav", "aria-label": t("decisionPrimaryNavigation"), "data-decision-primary-nav": true, children: view.tabs.map(id => jsx.jsx(ui.Button, {
            "data-view": id, onClick: () => navigate(id), "aria-pressed": view.tab === id,
            children: jsx.jsxs("span", { children: [t(`decision${id[0].toUpperCase()}${id.slice(1)}`), id === "inbox" && resources.inbox.status === "ready" && resources.inbox.value.length > 0 ? jsx.jsx("span", { className: "weir-da-count", "data-inbox-count": resources.inbox.value.length, children: String(resources.inbox.value.length) }, "count") : null] }),
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
    return module.exports;
  },
});
