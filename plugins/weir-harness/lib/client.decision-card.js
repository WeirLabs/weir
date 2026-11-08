window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-card.js",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const buttonStyle = { color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", padding: "3px 8px", cursor: "pointer" };
    const inputStyle = { color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "6px", padding: "4px 6px" };

    function DecisionCard(props) {
      const t = props.t ?? (key => key);
      const [detail, setDetail] = react.useState(null);
      const [agents, setAgents] = react.useState([]);
      const [error, setError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [draft, setDraft] = react.useState("");
      const [answers, setAnswers] = react.useState({});
      const [target, setTarget] = react.useState("");
      const caseId = detail?.case?.caseId;
      // A native pending question appears only after Broker persisted its waiting Case.
      // Refresh on that existing projection boundary instead of racing Case creation or polling.
      const pendingInteraction = props.useSessionStatus?.(snapshot => props.sessionId ? snapshot.get(props.sessionId)?.pendingInteraction : undefined);
      const actions = props.createDecisionActions(props.connection, props.sessionId, props.decisionRpc);
      const banner = props.errorBanner ?? (reason => ({ message: reason instanceof Error ? reason.message : String(reason) }));
      const view = props.cardView(detail, agents);

      const load = async authoritative => {
        if (!props.sessionId) { setDetail(null); return; }
        try {
          const isConsult = props.toolName === "decision_consult";
          const value = authoritative && caseId ? await actions.record(caseId) : await props.decisionRpc(props.connection, isConsult ? "caseForToolCall" : "caseForCall", isConsult ? { sessionId: props.sessionId, toolCallId: props.callId } : { sessionId: props.sessionId, questions: props.questions ?? props.block?.args?.questions ?? props.block?.input?.questions ?? [] });
          setDetail(value);
          if (value?.case) setError(null);
          const overview = await actions.overview();
          setAgents(Array.isArray(overview?.agents) ? overview.agents : []);
        } catch (reason) { setError(banner(reason).message); }
      };
      react.useEffect(() => { setDetail(null); setError(null); load(false); }, [props.sessionId, props.callId, props.refreshKey, pendingInteraction]);
      const run = async (method, ...args) => {
        setBusy(true); setError(null);
        try { await actions[method](...args); await load(true); }
        catch (reason) { setError(banner(reason).message); }
        finally { setBusy(false); }
      };
      if (!view) return error && props.sessionId ? jsx.jsx("div", { role: "alert", children: error }) : null;
      const questions = Array.isArray(detail.case.request?.questions) ? detail.case.request.questions : [];
      const complete = questions.length > 0 && questions.every(question => {
        const answer = answers[question.id];
        return question.options ? answer?.selected?.length > 0 : typeof answer?.custom === "string" && answer.custom.length > 0;
      });
      return jsx.jsxs("section", {
        "data-weir-decision-card": view.caseId,
        style: { display: "grid", gap: "8px", padding: "10px", color: "var(--dsw-alias-label-primary)", background: "color-mix(in srgb, var(--dsw-alias-bg-layer-1) 94%, transparent)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "10px" },
        children: [
          jsx.jsxs("div", { children: [jsx.jsx("strong", { children: view.agentName }), ` · ${view.outcome} · ${t("decisionRevision")} ${view.revision}`] }, "title"),
          jsx.jsx("div", { children: view.summary }, "summary"),
          view.escalation?.suggestion?.length ? jsx.jsxs("details", { children: [jsx.jsx("summary", { children: t("decisionSuggestions") }), jsx.jsx("pre", { children: JSON.stringify(view.escalation.suggestion, null, 2) })] }, "suggestion") : null,
          view.escalation?.perQuestion?.length ? jsx.jsxs("details", { children: [jsx.jsx("summary", { children: t("decisionPerQuestion") }), jsx.jsx("pre", { children: JSON.stringify(view.escalation.perQuestion, null, 2) })] }, "per-question") : null,
          error ? jsx.jsx("div", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)" }, children: error }, "error") : null,
          jsx.jsxs("details", { onToggle: () => load(true), children: [
            jsx.jsx("summary", { children: `${t("decisionEvidence")} (${view.evidence.length})` }),
            jsx.jsx("ul", { children: view.evidence.map(ref => jsx.jsx("li", { children: `${ref.evidenceId} · ${ref.source} · ${JSON.stringify(ref.locator)}${ref.excerpt ? ` · ${ref.excerpt}` : ""}` }, ref.evidenceId)) }),
          ] }, "evidence"),
          jsx.jsx("button", { type: "button", style: buttonStyle, onClick: () => props.openRecord?.(view.caseId), "aria-label": t("decisionHistory"), children: t("decisionHistory") }, "history"),
          jsx.jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" }, children: [
            jsx.jsx("button", { type: "button", disabled: busy, style: buttonStyle, onClick: () => run("feedback", view.caseId, "rating_up"), "aria-label": t("decisionUp"), children: t("decisionUp") }, "up"),
            jsx.jsx("button", { type: "button", disabled: busy, style: buttonStyle, onClick: () => run("feedback", view.caseId, "rating_down"), "aria-label": t("decisionDown"), children: t("decisionDown") }, "down"),
            jsx.jsx("button", { type: "button", disabled: busy, style: buttonStyle, onClick: () => run("feedback", view.caseId, view.feedbackState === "validated" ? "undo_rating_up" : "undo_rating_down"), children: t("decisionUndo") }, "undo"),
          ] }, "ratings"),
          jsx.jsxs("div", { style: { display: "flex", gap: "6px" }, children: [
            jsx.jsx("input", { value: draft, onChange: event => setDraft(event.target.value), style: inputStyle, "aria-label": t("decisionComment") }, "draft"),
            jsx.jsx("button", { type: "button", disabled: busy || !draft, style: buttonStyle, onClick: () => run("feedback", view.caseId, "comment", draft), children: t("decisionComment") }, "comment"),
            jsx.jsx("button", { type: "button", disabled: busy || !draft, style: buttonStyle, onClick: () => run("correction", view.caseId, draft, detail.case.scope, [view.caseId]), children: t("decisionCorrect") }, "correct"),
          ] }, "feedback"),
          view.state === "awaiting_user" ? jsx.jsxs("div", { style: { display: "grid", gap: "6px" }, children: [
            ...questions.map(question => jsx.jsxs("label", { children: [question.question, question.options ? jsx.jsxs("select", {
              value: question.multiSelect ? (answers[question.id]?.selected ?? []) : (answers[question.id]?.selected?.[0] ?? ""), style: inputStyle,
              multiple: question.multiSelect === true,
              "aria-label": `${t("decisionDecide")}: ${question.id}`,
              onChange: event => setAnswers({ ...answers, [question.id]: { selected: question.multiSelect ? Array.from(event.target.selectedOptions ?? []).map(option => option.value) : event.target.value ? [event.target.value] : [] } }),
              children: [jsx.jsx("option", { value: "", children: "—" }, "empty"), ...question.options.map(option => jsx.jsx("option", { value: option.label, children: option.label }, option.label))],
            }) : jsx.jsx("input", { style: inputStyle, "aria-label": `${t("decisionDecide")}: ${question.id}`, onChange: event => setAnswers({ ...answers, [question.id]: { custom: event.target.value } }) })] }, question.id)),
            jsx.jsx("button", { type: "button", disabled: busy || !complete, style: buttonStyle, onClick: () => run("decide", view.caseId, questions.map(question => ({ id: question.id, selected: answers[question.id]?.selected ?? [], ...(answers[question.id]?.custom === undefined ? {} : { custom: answers[question.id].custom }) }))), children: t("decisionDecide") }, "decide"),
            jsx.jsxs("select", { value: target, onChange: event => setTarget(event.target.value), style: inputStyle, "aria-label": t("decisionReassign"), children: [jsx.jsx("option", { value: "", children: "—" }, "empty"), ...agents.filter(agent => agent.state === "enabled").map(agent => jsx.jsx("option", { value: agent.agentId, children: agent.name }, agent.agentId))] }, "target"),
            jsx.jsx("button", { type: "button", disabled: busy || !target, style: buttonStyle, onClick: () => run("reassign", view.caseId, target), children: t("decisionReassign") }, "reassign"),
            jsx.jsx("button", { type: "button", disabled: busy, style: buttonStyle, onClick: () => run("retry", view.caseId), children: t("decisionRetry") }, "retry"),
            jsx.jsx("button", { type: "button", disabled: busy, style: buttonStyle, onClick: () => run("cancel", view.caseId), children: t("decisionCancel") }, "cancel"),
          ] }, "awaiting") : null,
        ],
      });
    }

    exports.DecisionCard = DecisionCard;
    return module.exports;
  },
});
