window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-card.js",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");

    function answerText(answer) {
      if (!answer) return "";
      return [...(Array.isArray(answer.selected) ? answer.selected : []), ...(typeof answer.custom === "string" && answer.custom ? [answer.custom] : [])].join(", ");
    }

    // Ordinary-language scope: the workspace is the current one by contract, so
    // its absolute path is never rendered.
    function readableScope(scope, t) {
      if (!scope || typeof scope !== "object") return t("decisionCurrentScope");
      const parts = [];
      if (Array.isArray(scope.workspaces) && scope.workspaces.length) parts.push(t("decisionScopeCurrentWorkspace"));
      for (const key of ["paths", "tags"]) for (const value of Array.isArray(scope[key]) ? scope[key] : []) if (typeof value === "string") parts.push(value);
      return parts.length ? parts.join(" · ") : t("decisionCurrentScope");
    }

    function EvidenceList(props) {
      const evidence = Array.isArray(props.evidence) ? props.evidence : [];
      if (!evidence.length) return jsx.jsx(props.ui.EmptyState, { children: props.t("decisionNoEvidence") });
      return jsx.jsx("ul", { className: "weir-da-evidence-list", children: evidence.map((item, index) => jsx.jsxs("li", { children: [
        jsx.jsx("div", { children: item?.excerpt || props.t("decisionEvidenceUnavailable") }, "excerpt"),
        item?.status && item.status !== "active" ? jsx.jsx("div", { className: "weir-da-caption", children: props.t(item.status === "deleted" ? "decisionEvidenceDeleted" : "decisionEvidenceSuperseded") }, "status") : null,
      ] }, item?.evidenceId ?? index)) });
    }

    function EvaluationGroup(props) {
      const attempt = props.group?.attempt ?? {};
      const outcomeKeys = { answer: "decisionOutcomeAnswer", return: "decisionOutcomeReturn", escalate: "decisionOutcomeEscalate", failed: "decisionOutcomeFailed" };
      const claims = Array.isArray(attempt.claims) ? attempt.claims : [];
      return jsx.jsxs("article", { className: "weir-da-evaluation", "data-evaluation-group": true, children: [
        jsx.jsx("strong", { children: `${props.t("decisionEvaluationNumber")} ${attempt.attemptNo ?? props.index + 1} · ${props.t(outcomeKeys[attempt.outcome] ?? "decisionStatusUnknown")}` }, "title"),
        attempt.hint || attempt.reasonCode ? jsx.jsx("p", { children: attempt.hint ?? props.t(props.model.reasonKey(attempt.reasonCode) ?? "decisionReasonUnknown") }, "reason") : null,
        claims.length ? jsx.jsx("ul", { children: claims.map((claim, index) => jsx.jsx("li", { children: claim?.text ?? "" }, index)) }, "claims") : null,
        EvidenceList({ evidence: props.group?.evidence, ui: props.ui, t: props.t }),
      ] });
    }

    function DecisionCard(props) {
      const t = props.t ?? (key => key);
      const ui = props.ui;
      const model = props.decisionModel;
      const [detail, setDetail] = react.useState(null);
      const [evidenceReveal, setEvidenceReveal] = react.useState({ key: null, status: "idle" });
      const [agents, setAgents] = react.useState([]);
      const [error, setError] = react.useState(null);
      const [drafts, setDrafts] = react.useState({});
      const [editor, setEditor] = react.useState(null);
      const [confirm, setConfirm] = react.useState(null);
      const [pending, setPending] = react.useState(null);
      const pendingRef = react.useRef(false);
      const evidenceReadRef = react.useRef(null);
      const generationRef = react.useRef(0);
      const caseId = detail?.case?.caseId;
      // A native pending question appears only after Broker persisted its waiting Case.
      // Refresh on that existing projection boundary instead of racing Case creation or polling.
      const pendingInteraction = props.useSessionStatus?.(snapshot => props.sessionId ? snapshot.get(props.sessionId)?.pendingInteraction : undefined);
      const actions = props.createDecisionActions(props.connection, props.sessionId, props.decisionRpc);
      const view = props.cardView(detail, agents, t);

      const load = async (authoritative, targetCaseId = caseId, rethrow = false) => {
        const generation = generationRef.current;
        const current = () => generation === generationRef.current;
        if (!props.sessionId) { if (current()) setDetail(null); return null; }
        try {
          const isConsult = props.toolName === "decision_consult";
          const value = authoritative && targetCaseId ? await actions.record(targetCaseId) : await props.decisionRpc(props.connection, isConsult ? "caseForToolCall" : "caseForCall", isConsult ? { sessionId: props.sessionId, toolCallId: props.callId } : { sessionId: props.sessionId, questions: props.questions ?? props.block?.args?.questions ?? props.block?.input?.questions ?? [] });
          if (!current()) return null;
          setDetail(value);
          if (value?.case) setError(null);
          const overview = await actions.overview();
          if (!current()) return null;
          setAgents(Array.isArray(overview?.agents) ? overview.agents : []);
          return value;
        } catch (reason) {
          if (current()) setError({ reason, kind: "read" });
          if (rethrow) throw reason;
          return null;
        }
      };
      const clearDraft = (sessionId, targetCaseId, fields) => setDrafts(current => model.draftsReducer(current, { type: "clear", sessionId, caseId: targetCaseId, fields }));
      const run = async (method, ...args) => {
        if (pendingRef.current) return;
        const generation = generationRef.current;
        const requestSession = props.sessionId;
        const targetCaseId = args[0];
        pendingRef.current = true; setPending(method); setError(null);
        try {
          await actions[method](...args);
          if (generation !== generationRef.current) return;
          // A completed card action converges the sidebar count immediately.
          props.refreshPending?.();
          const authoritative = await load(true, targetCaseId, true);
          if (!authoritative?.case || authoritative.case.caseId !== targetCaseId) throw Object.assign(new Error("Decision record reread returned no matching record"), { code: "DECISION_REREAD_FAILED" });
          if (method === "decide") clearDraft(requestSession, targetCaseId, ["answers"]);
          if (method === "reassign") clearDraft(requestSession, targetCaseId, ["reassignTarget"]);
          if (method === "feedback" && args[1] === "comment") { clearDraft(requestSession, targetCaseId, ["comment"]); setEditor(null); }
          if (method === "correction") { clearDraft(requestSession, targetCaseId, ["correction"]); setEditor(null); }
          if (method === "clarify") { clearDraft(requestSession, targetCaseId, ["clarifyQuestion"]); setEditor(null); }
          if (method === "returnToCaller") { clearDraft(requestSession, targetCaseId, ["bounceNote"]); setEditor(null); }
        } catch (reason) {
          if (generation === generationRef.current) setError({ reason, kind: "action" });
        } finally { pendingRef.current = false; setPending(null); }
      };
      const openEvidence = async () => {
        if (!caseId || !props.sessionId) return;
        const key = `${props.sessionId}:${caseId}`;
        if (evidenceReadRef.current === key) return;
        const generation = generationRef.current;
        evidenceReadRef.current = key;
        setEvidenceReveal({ key, status: "loading" });
        const value = await load(true, caseId);
        if (generation !== generationRef.current || evidenceReadRef.current !== key) return;
        if (value?.case) setEvidenceReveal({ key, status: "ready" });
        else {
          evidenceReadRef.current = null;
          setEvidenceReveal({ key, status: "error" });
        }
      };
      react.useEffect(() => {
        const generation = ++generationRef.current;
        evidenceReadRef.current = null; setDetail(null); setError(null); setEditor(null); setConfirm(null);
        setEvidenceReveal({ key: null, status: "idle" });
        let waitController = null;
        const loadAndWait = async () => {
          const value = await load(false);
          const state = value?.case?.state;
          if (generationRef.current !== generation || !props.sessionId || !props.callId || props.toolName !== "decision_consult" || typeof props.waitForDecisionCase !== "function") return;
          if (value?.case && state !== "received" && state !== "evaluating") return;
          // The one-shot Host wait checks authority and registers atomically.
          // Wake on that boundary, then reread once; no timer or polling loop.
          const controller = new AbortController();
          waitController = controller;
          try {
            await props.waitForDecisionCase(props.sessionId, props.callId, controller.signal);
            if (generationRef.current === generation) await load(false);
          } catch (reason) {
            if (generationRef.current === generation && !controller.signal.aborted) setError({ reason, kind: "read" });
          }
        };
        void loadAndWait();
        return () => {
          if (generationRef.current === generation) generationRef.current += 1;
          waitController?.abort();
        };
      }, [props.sessionId, props.callId, props.refreshKey, pendingInteraction]);

      const errorMessage = error ? t(error.kind === "read" ? "decisionReadFailed" : model?.errorKey?.(error.reason) ?? "decisionFailed") : null;
      const evidenceKey = props.sessionId && caseId ? `${props.sessionId}:${caseId}` : null;
      const evidenceReady = evidenceReveal.key === evidenceKey && ["ready", "error"].includes(evidenceReveal.status);
      const evidenceFailed = evidenceReveal.key === evidenceKey && evidenceReveal.status === "error";
      if (!view) return error && props.sessionId ? jsx.jsxs(ui.ErrorState, { children: [
        jsx.jsx("span", { children: errorMessage }, "message"),
        jsx.jsx(ui.Button, { onClick: () => load(false), children: t("decisionRetry") }, "retry"),
      ] }) : null;
      const questions = Array.isArray(detail.case.request?.questions) ? detail.case.request.questions : [];
      const answers = Array.isArray(view.answers) ? view.answers : [];
      const badgeVariant = view.variant === "answered" ? "success" : view.variant === "failed" ? "error" : view.variant === "cancelled" ? "idle" : "warn";
      const summary = view.summary;
      const reason = view.reasonKey ? t(view.reasonKey) : null;
      const reasonDetail = view.reasonDetailKey ? t(view.reasonDetailKey) : null;
      const waiting = view.state === "awaiting_user";
      const nativeAnswer = waiting && props.toolName === "ask_user_question";
      const directConsultAnswer = waiting && props.toolName === "decision_consult";
      const suggestions = Array.isArray(view.escalation?.suggestion) ? view.escalation.suggestion : [];
      const perQuestion = Array.isArray(view.escalation?.perQuestion) ? view.escalation.perQuestion : [];
      // The answer form has no decision model, so its per-question reasons are
      // translated here and handed over as already-readable text.
      const suggestionReasons = perQuestion.map(entry => ({ id: entry?.id, reason: t(model.reasonKey(entry?.detail) ?? "decisionReasonUnknown") }));
      const previous = view.history.filter(group => group.attempt?.attemptId !== view.currentAttempt?.attemptId);
      // Dynamic summary for the More-details entry: preview only substantive
      // diagnostic signals (routing disagreement/failure, failed evaluations);
      // otherwise the trigger stays a plain label.
      const moreDetailsHintKey = view.routeHistory.some(route => ["decisionRouteStatusAmbiguous", "decisionRouteStatusFailure"].includes(route?.statusKey))
        ? "decisionMoreDetailsRouteIssue"
        : view.history.some(group => group.attempt?.outcome === "failed") ? "decisionMoreDetailsFailedAttempt" : null;
      const clarifications = (Array.isArray(detail.feedback) ? detail.feedback : []).filter(entry => entry?.kind === "clarify");
      const latestClarify = clarifications.at(-1);
      const isPending = pending !== null;
      // Ratings answer "was this answer right", so they appear only once a
      // decision exists (or feedback was already recorded); notes/corrections
      // stay available on waiting cards.
      const ratingsVisible = view.assigned && (Boolean(detail.case.decision) || view.feedbackState !== "none");
      const ratings = ratingsVisible ? model.feedbackActions(view.feedbackState) : [];
      const draft = model.readDraft(drafts, props.sessionId, view.caseId);
      const updateDraft = (field, value) => setDrafts(current => model.draftsReducer(current, { type: "update", sessionId: props.sessionId, caseId: view.caseId, field, value }));
      const toggleEditor = name => {
        if (pendingRef.current) return;
        setEditor(editor === name ? null : name);
      };
      const requestCancel = () => {
        if (!waiting || pendingRef.current) return;
        setConfirm({ caseId: view.caseId });
      };
      const rawError = error ? { code: error.reason?.code, message: error.reason instanceof Error ? error.reason.message : String(error.reason) } : null;
      return jsx.jsxs("section", {
        className: "weir-da-card weir-da-conversation-card",
        "data-weir-decision-card": view.caseId,
        "data-decision-variant": view.variant,
        "aria-busy": isPending,
        children: [
          jsx.jsx(ui.DecisionStyles, {}, "styles"),
          jsx.jsxs("header", { className: "weir-da-card-header", children: [
            jsx.jsxs("div", { children: [
              jsx.jsx("h2", { children: view.questionSummary || t("decisionRecord") }, "title"),
              jsx.jsx("p", { className: "weir-da-caption", children: view.agentName }, "agent"),
              view.routeStatusKey ? jsx.jsx("p", { className: "weir-da-caption", "data-route-status": true, children: t(view.routeStatusKey) }, "route-status") : null,
            ] }, "copy"),
            jsx.jsx(ui.Badge, { variant: badgeVariant, children: t(view.statusKey) }, "status"),
          ] }, "header"),
          directConsultAnswer ? jsx.jsx(ui.DecisionAnswers, {
            questions, answers: draft.answers, suggestions, perQuestion: suggestionReasons, pending: isPending,
            onChange: value => updateDraft("answers", value), onSubmit: value => run("decide", view.caseId, value), t,
          }, "answer-form") : null,
          !directConsultAnswer ? jsx.jsx("section", { className: "weir-da-record-answers", "aria-label": t("decisionRecord"), children: questions.map((question, index) => {
            const answer = answers.find(item => item?.id === question.id);
            return jsx.jsxs("div", { className: "weir-da-answer-summary", children: [
              jsx.jsx("strong", { children: question.question }, "question"),
              jsx.jsx("div", { children: answerText(answer) || t("decisionNoAnswer") }, "answer"),
            ] }, question.id ?? index);
          }) }, "answers") : null,
          summary || reason ? jsx.jsxs("section", { children: [
            jsx.jsx("h3", { children: t("decisionReasonSummary") }, "title"),
            summary ? jsx.jsx("p", { children: summary }, "summary") : null,
            reason && reason !== summary ? jsx.jsx("p", { className: "weir-da-caption", children: reason }, "recorded-reason") : null,
            reasonDetail ? jsx.jsx("p", { className: "weir-da-caption", "data-reason-detail": true, children: reasonDetail }, "reason-detail") : null,
          ] }, "reason") : null,
          nativeAnswer ? jsx.jsx("p", { className: "weir-da-state", "data-native-answer": true, children: t("decisionNativeAnswerHint") }, "native-answer") : null,
          waiting && !directConsultAnswer && (suggestions.length || perQuestion.length) ? jsx.jsxs("section", { className: "weir-da-suggestion-review", children: [
            // The native card has no card form to host the block, so it keeps the
            // tentative suggestions read-only under the same short title.
            jsx.jsx("strong", { children: t("decisionSuggestions") }, "title"),
            suggestions.length ? jsx.jsx("ul", { children: suggestions.map((answer, index) => {
              const question = questions.find(item => item.id === answer?.id);
              return jsx.jsx("li", { children: `${question?.question ?? t("decisionRecord")}: ${answerText(answer)}` }, answer?.id ?? index);
            }) }, "suggestions") : null,
            perQuestion.length ? jsx.jsx("ul", { children: suggestionReasons.map((entry, index) => {
              return jsx.jsx("li", { children: `${questions.find(item => item.id === entry?.id)?.question ?? t("decisionRecord")}: ${entry?.reason ?? t("decisionReasonUnknown")}` }, entry?.id ?? index);
            }) }, "per-question") : null,
          ] }, "guidance") : null,
          // User autonomy on a pending decision: ask the owning assistant for
          // more context (read-only clarification), or bounce the question back
          // to its initiator with a required note.
          waiting ? jsx.jsxs("section", { className: "weir-da-user-tools", "data-user-tools": true, children: [
            latestClarify ? jsx.jsxs("div", { className: "weir-da-clarification", "data-clarification": true, children: [
              jsx.jsxs("div", { children: [jsx.jsx("strong", { children: t("decisionClarifyYouAsked") }, "q-label"), jsx.jsx("span", { children: latestClarify.payload?.question ?? "" }, "q")] }, "question"),
              jsx.jsxs("div", { children: [jsx.jsx("strong", { children: t("decisionClarifyAnswer") }, "a-label"), jsx.jsx("span", { children: latestClarify.payload?.answer ?? "" }, "a")] }, "answer"),
            ] }, "latest-clarify") : null,
            jsx.jsxs("div", { className: "weir-da-actions weir-da-user-actions", children: [
              view.assigned ? jsx.jsx(ui.Button, { variant: "secondary", "data-action": "open-clarify", disabled: isPending || clarifications.length >= 3, title: clarifications.length >= 3 ? t("decisionClarifyLimit") : undefined, onClick: () => toggleEditor("clarify"), children: t("decisionClarify") }, "open-clarify") : null,
              jsx.jsx(ui.Button, { variant: "secondary", "data-action": "open-bounce", disabled: isPending, onClick: () => toggleEditor("bounce"), children: t("decisionBounce") }, "open-bounce"),
            ] }, "entries"),
            editor === "clarify" ? jsx.jsxs("div", { className: "weir-da-feedback-editor weir-da-user-editor", children: [
              jsx.jsx(ui.Field, { id: `weir-da-card-clarify-${view.caseId}`, label: t("decisionClarify"), hint: t("decisionClarifyHint"), children: jsx.jsx("textarea", {
                id: `weir-da-card-clarify-${view.caseId}`, "data-draft": "clarifyQuestion", "aria-label": t("decisionClarify"), value: draft.clarifyQuestion ?? "", disabled: isPending,
                placeholder: t("decisionClarifyPlaceholder"),
                onChange: event => updateDraft("clarifyQuestion", event.target.value),
              }) }, "clarify-field"),
              jsx.jsx(ui.Button, { "data-action": "clarify", disabled: isPending || !(draft.clarifyQuestion ?? "").trim(), onClick: () => run("clarify", view.caseId, draft.clarifyQuestion.trim()), children: t("decisionClarifySubmit") }, "clarify-action"),
            ] }, "clarify-editor") : null,
            editor === "bounce" ? jsx.jsxs("div", { className: "weir-da-feedback-editor weir-da-user-editor", children: [
              jsx.jsx(ui.Field, { id: `weir-da-card-bounce-${view.caseId}`, label: t("decisionBounce"), hint: t("decisionBounceHint"), children: jsx.jsx("textarea", {
                id: `weir-da-card-bounce-${view.caseId}`, "data-draft": "bounceNote", "aria-label": t("decisionBounce"), value: draft.bounceNote ?? "", disabled: isPending,
                placeholder: t("decisionBouncePlaceholder"),
                onChange: event => updateDraft("bounceNote", event.target.value),
              }) }, "bounce-field"),
              jsx.jsx(ui.Button, { variant: "secondary", "data-action": "bounce", disabled: isPending || !(draft.bounceNote ?? "").trim(), onClick: () => run("returnToCaller", view.caseId, draft.bounceNote.trim()), children: t("decisionBounceSubmit") }, "bounce-action"),
            ] }, "bounce-editor") : null,
          ] }, "user-tools") : null,
          view.assigned ? jsx.jsxs("section", { className: "weir-da-feedback-editor", children: [
            view.feedbackState === "validated" || view.feedbackState === "disputed" ? jsx.jsx(ui.Badge, { variant: "idle", children: t(view.feedbackState === "validated" ? "decisionFeedbackValidated" : "decisionFeedbackDisputed") }, "feedback-state") : null,
            ratingsVisible ? jsx.jsx("div", { className: "weir-da-actions", children: ratings.map(action => jsx.jsx(ui.Button, {
              variant: "ghost", "data-feedback": action.verb, disabled: isPending,
              onClick: () => run("feedback", view.caseId, action.verb), children: t(action.labelKey),
            }, action.verb)) }, "ratings") : null,
            ratingsVisible && view.feedbackState === "none" ? jsx.jsx("p", { className: "weir-da-caption", children: t("decisionFeedbackHintShort") }, "rating-hint") : null,
            jsx.jsxs("div", { className: "weir-da-actions", children: [
              jsx.jsx(ui.Button, { variant: "ghost", "data-action": "open-comment", disabled: isPending, onClick: () => toggleEditor("comment"), children: t("decisionComment") }, "open-comment"),
              jsx.jsx(ui.Button, { variant: "ghost", "data-action": "open-correction", disabled: isPending, onClick: () => toggleEditor("correction"), children: t("decisionCorrect") }, "open-correction"),
            ] }, "editor-entries"),
            editor === "comment" ? jsx.jsxs("div", { className: "weir-da-feedback-editor", children: [
              jsx.jsx(ui.Field, { id: `weir-da-card-note-${view.caseId}`, label: t("decisionComment"), hint: t("decisionNoteNoEffect"), children: jsx.jsx("textarea", {
                id: `weir-da-card-note-${view.caseId}`, "data-draft": "comment", "aria-label": t("decisionComment"), value: draft.comment, disabled: isPending,
                onChange: event => updateDraft("comment", event.target.value),
              }) }, "note-field"),
              jsx.jsx(ui.Button, { "data-action": "comment", disabled: isPending || !draft.comment, onClick: () => run("feedback", view.caseId, "comment", draft.comment), children: t("decisionAddNote") }, "note-action"),
            ] }, "note-editor") : null,
            editor === "correction" ? jsx.jsxs("div", { className: "weir-da-feedback-editor", children: [
              jsx.jsx(ui.Field, { id: `weir-da-card-correction-${view.caseId}`, label: t("decisionCorrect"), children: jsx.jsx("textarea", {
                id: `weir-da-card-correction-${view.caseId}`, "data-draft": "correction", "aria-label": t("decisionCorrect"), value: draft.correction, disabled: isPending,
                onChange: event => updateDraft("correction", event.target.value),
              }) }, "correction-field"),
              draft.correction ? jsx.jsxs("div", { className: "weir-da-correction-preview", children: [
                jsx.jsx("div", { children: `${t("decisionCorrectionScope")}: ${readableScope(detail.case.scope, t)}` }, "scope"),
                jsx.jsx("div", { children: `${t("decisionCorrectionTarget")}: ${view.questionSummary || t("decisionRecord")}` }, "target"),
                jsx.jsx("div", { children: t("decisionCorrectionFutureOnly") }, "future"),
              ] }, "preview") : null,
              jsx.jsx(ui.Button, { "data-action": "correction", disabled: isPending || !draft.correction, onClick: () => run("correction", view.caseId, draft.correction, detail.case.scope, [view.caseId]), children: t("decisionSubmitCorrection") }, "correction-action"),
            ] }, "correction-editor") : null,
          ] }, "feedback") : null,
          error ? jsx.jsx(ui.ErrorState, { children: errorMessage }, "error") : null,
          jsx.jsx(ui.Disclosure, {
            id: `weir-da-card-evidence-${view.caseId}`, label: t("decisionEvidence"), onOpen: openEvidence,
            revealOnOpen: "end", revealReady: evidenceReady,
            children: () => evidenceFailed ? jsx.jsx(ui.ErrorState, { children: errorMessage }) : EvidenceList({ evidence: view.evidence, ui, t }),
          }, "evidence"),
          // Diagnostic tier: history, route history and raw diagnostics live
          // inside ONE grouped disclosure so the static card stays lean (the
          // group reveals once to its end; nested disclosures do not re-jump).
          jsx.jsx(ui.Disclosure, {
            id: `weir-da-card-more-${view.caseId}`, label: moreDetailsHintKey ? `${t("decisionMoreDetails")} · ${t(moreDetailsHintKey)}` : t("decisionMoreDetails"), revealOnOpen: "end",
            children: () => jsx.jsxs("div", { className: "weir-da-more-details", children: [
              ratingsVisible && view.feedbackState === "none" ? jsx.jsxs("div", { className: "weir-da-caption", children: [
                jsx.jsx("div", { children: t("decisionConfirmConsequence") }, "confirm-consequence"),
                jsx.jsx("div", { children: t("decisionDisputeConsequence") }, "dispute-consequence"),
              ] }, "rating-consequences") : null,
              jsx.jsx(ui.Disclosure, {
                id: `weir-da-card-history-${view.caseId}`, label: t("decisionEvaluationHistory"),
                children: () => previous.length ? previous.map((group, index) => EvaluationGroup({ group, index, model, ui, t })) : jsx.jsx(ui.EmptyState, { children: t("decisionNoEarlierEvaluations") }),
              }, "evaluation-history"),
              jsx.jsx(ui.Disclosure, {
                id: `weir-da-card-routes-${view.caseId}`, label: t("decisionRouteHistory"), onOpen: openEvidence,
                children: () => evidenceFailed ? jsx.jsx(ui.ErrorState, { children: errorMessage }) : jsx.jsx(ui.DecisionRouteHistory, { history: view.routeHistory, t }),
              }, "route-history"),
              jsx.jsx(ui.Disclosure, {
                id: `weir-da-card-advanced-${view.caseId}`, label: t("decisionAdvancedDiagnostics"),
                children: () => jsx.jsx("div", { className: "weir-da-advanced-record", children: jsx.jsx("pre", { children: JSON.stringify({ detail, error: rawError }, null, 2) }) }),
              }, "advanced"),
            ] }),
          }, "more-details"),
          jsx.jsx(ui.Button, { variant: waiting && props.toolName === "decision_consult" ? "secondary" : "ghost", onClick: () => props.openRecord?.(view.caseId), children: t("decisionHistory") }, "history"),
          waiting ? jsx.jsx(ui.Disclosure, {
            id: `weir-da-card-recovery-${view.caseId}`, label: t("decisionRecoveryActions"), revealOnOpen: "end",
            children: () => jsx.jsxs("div", { className: "weir-da-actions", children: [
              jsx.jsxs("select", { value: draft.reassignTarget, onChange: event => updateDraft("reassignTarget", event.target.value), "data-draft": "reassignTarget", "aria-label": t("decisionReassign"), className: "weir-da-select", disabled: isPending, children: [
                jsx.jsx("option", { value: "", children: t("decisionChooseAssistant") }, "empty"),
                ...agents.filter(agent => agent.state === "enabled").map(agent => jsx.jsx("option", { value: agent.agentId, children: agent.name }, agent.agentId)),
              ] }, "target"),
              jsx.jsx(ui.Button, { "data-action": "reassign", disabled: !draft.reassignTarget || isPending, onClick: () => run("reassign", view.caseId, draft.reassignTarget), children: t("decisionReassign") }, "reassign"),
              view.canRetry ? jsx.jsx(ui.Button, { "data-action": "retry", disabled: isPending, onClick: () => run("retry", view.caseId), children: t("decisionRetry") }, "retry") : null,
              jsx.jsx(ui.Button, { variant: "danger", "data-action": "cancel", disabled: isPending, onClick: requestCancel, children: t("decisionCancel") }, "cancel"),
            ] }),
          }, "recovery") : null,
          confirm ? jsx.jsx(ui.ConfirmDialog, {
            id: `weir-da-card-cancel-${view.caseId}`, title: t("decisionCancelTitle"), body: t("decisionCancelConfirmation"),
            confirmLabel: t("decisionCancel"), cancelLabel: t("decisionKeepEditing"), danger: true, pending: isPending,
            openErrorLabel: t("decisionFailed"), dismissLabel: t("decisionCancel"),
            onCancel: () => setConfirm(null),
            onConfirm: () => { const targetCaseId = confirm.caseId; setConfirm(null); return run("cancel", targetCaseId); },
          }, "confirm-cancel") : null,
        ],
      });
    }

    exports.DecisionCard = DecisionCard;
    return module.exports;
  },
});
