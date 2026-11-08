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

    function InboxItem(props) {
      const current = props.item;
      const [answers, setAnswers] = react.useState({});
      const [target, setTarget] = react.useState("");
      const t = props.t;
      const questions = Array.isArray(current.request?.questions) ? current.request.questions : [];
      const complete = questions.length > 0 && questions.every(question => question.options ? answers[question.id]?.selected?.length > 0 : answers[question.id]?.custom);
      return jsx.jsxs("article", { style: cardStyle, "data-case-id": current.caseId, children: [
        jsx.jsx("strong", { children: current.caseId }, "id"),
        jsx.jsx("div", { children: `${current.awaitingReason ?? "awaiting_user"} · ${current.escalation?.missing?.[0] ?? ""}` }, "reason"),
        current.escalation?.suggestion?.length ? jsx.jsxs("details", { children: [jsx.jsx("summary", { children: t("decisionSuggestions") }), jsx.jsx("pre", { children: JSON.stringify(current.escalation.suggestion, null, 2) })] }, "suggestion") : null,
        current.escalation?.perQuestion?.length ? jsx.jsxs("details", { children: [jsx.jsx("summary", { children: t("decisionPerQuestion") }), jsx.jsx("pre", { children: JSON.stringify(current.escalation.perQuestion, null, 2) })] }, "per-question") : null,
        ...questions.map(question => jsx.jsxs("label", { children: [question.question, question.options ? jsx.jsxs("select", {
          value: question.multiSelect ? answers[question.id]?.selected ?? [] : answers[question.id]?.selected?.[0] ?? "", multiple: question.multiSelect === true, style: inputStyle,
          "aria-label": `${t("decisionDecide")}: ${question.id}`,
          onChange: event => setAnswers({ ...answers, [question.id]: { selected: question.multiSelect ? Array.from(event.target.selectedOptions ?? []).map(option => option.value) : event.target.value ? [event.target.value] : [] } }),
          children: [jsx.jsx("option", { value: "", children: "—" }, "empty"), ...question.options.map(option => jsx.jsx("option", { value: option.label, children: option.label }, option.label))],
        }) : jsx.jsx("input", { style: inputStyle, "aria-label": `${t("decisionDecide")}: ${question.id}`, onChange: event => setAnswers({ ...answers, [question.id]: { custom: event.target.value } }) })] }, question.id)),
        jsx.jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" }, children: [
          jsx.jsx("button", { type: "button", disabled: !complete, style: buttonStyle, onClick: () => props.run("decide", current.caseId, questions.map(question => ({ id: question.id, selected: answers[question.id]?.selected ?? [], ...(answers[question.id]?.custom === undefined ? {} : { custom: answers[question.id].custom }) }))), children: t("decisionDecide") }, "decide"),
          jsx.jsxs("select", { value: target, onChange: event => setTarget(event.target.value), "aria-label": t("decisionReassign"), style: inputStyle, children: [jsx.jsx("option", { value: "", children: "—" }, "empty"), ...props.agents.filter(agent => agent.state === "enabled").map(agent => jsx.jsx("option", { value: agent.agentId, children: agent.name }, agent.agentId))] }, "target"),
          jsx.jsx("button", { type: "button", disabled: !target, style: buttonStyle, onClick: () => props.run("reassign", current.caseId, target), children: t("decisionReassign") }, "reassign"),
          jsx.jsx("button", { type: "button", style: buttonStyle, onClick: () => props.run("retry", current.caseId), children: t("decisionRetry") }, "retry"),
          jsx.jsx("button", { type: "button", style: buttonStyle, onClick: () => props.run("cancel", current.caseId), children: t("decisionCancel") }, "cancel"),
        ] }, "actions"),
      ] });
    }

    function AttemptContextPack(props) {
      const t = props.t ?? (key => key);
      const attempt = props.attempt && typeof props.attempt === "object" ? props.attempt : {};
      const manifest = attempt.packManifest;
      const memory = manifest?.memory;
      const attemptId = typeof attempt.attemptId === "string" ? attempt.attemptId : "—";
      const sourceCaseIds = Array.isArray(memory?.L3?.sourceCaseIds) ? memory.L3.sourceCaseIds.filter(caseId => typeof caseId === "string") : [];
      const omissions = Array.isArray(manifest?.omissions) ? manifest.omissions.filter(code => typeof code === "string") : [];
      const layerSizes = manifest?.layerSizes && typeof manifest.layerSizes === "object" && !Array.isArray(manifest.layerSizes) ? Object.entries(manifest.layerSizes) : [];
      const l2Status = memory?.L2 === undefined
        ? t("decisionMemoryEmpty")
        : memory.L2?.status === "empty" ? t("decisionMemoryEmpty") : typeof memory.L2?.status === "string" ? memory.L2.status : "—";
      return jsx.jsxs("details", {
        "data-attempt-context-pack": attemptId,
        "aria-label": `${t("decisionContextPack")}: ${attemptId}`,
        style: contextPackStyle,
        children: [
          jsx.jsx("summary", { style: { cursor: "pointer" }, children: `${t("decisionContextPack")} · ${attemptId}` }, "summary"),
          jsx.jsxs("div", { style: contextPackBodyStyle, children: [
            jsx.jsx("div", { children: `${t("decisionL2Memory")}: ${l2Status}` }, "l2"),
            jsx.jsxs("div", { children: [
              jsx.jsx("strong", { style: contextPackLabelStyle, children: t("decisionNeutralEpisodes") }, "label"),
              sourceCaseIds.length
                ? jsx.jsx("ol", { style: contextPackListStyle, children: sourceCaseIds.map((caseId, index) => jsx.jsx("li", { children: jsx.jsx("code", { children: caseId }) }, `${caseId}:${index}`)) }, "sources")
                : jsx.jsx("div", { children: t("decisionNoMemory") }, "empty")
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

    function DecisionPage(props) {
      const t = props.t ?? (key => key);
      const [tab, setTab] = react.useState("agents");
      const [agents, setAgents] = react.useState([]);
      const [records, setRecords] = react.useState([]);
      const [inbox, setInbox] = react.useState([]);
      const [metrics, setMetrics] = react.useState(null);
      const [nextCursor, setNextCursor] = react.useState(null);
      const [detail, setDetail] = react.useState(null);
      const [agentDetail, setAgentDetail] = react.useState(null);
      const [filter, setFilter] = react.useState({});
      const [error, setError] = react.useState(null);
      const [name, setName] = react.useState("");
      const [description, setDescription] = react.useState("");
      const [comment, setComment] = react.useState("");
      const actions = props.createDecisionActions(props.connection, props.getSessionId(), props.decisionRpc);
      const banner = props.errorBanner ?? (reason => ({ message: reason instanceof Error ? reason.message : String(reason) }));
      const view = props.pageView?.({ tab, agents, records, inbox, metrics }) ?? { tab, tabs: ["agents", "records", "inbox", "metrics"], agents, records, inbox, metrics };
      const load = async () => {
        if (!props.getSessionId()) return;
        try {
          const [agentRows, recordPage, waiting, counts] = await Promise.all([actions.agents(), actions.records(filter), actions.inbox(), actions.metrics("all")]);
          const narrowedRecords = props.narrowRecords?.(recordPage) ?? recordPage;
          const narrowedInbox = props.narrowInbox?.(waiting) ?? waiting;
          setAgents(Array.isArray(agentRows) ? agentRows : []);
          setRecords(Array.isArray(narrowedRecords?.records) ? narrowedRecords.records : []);
          setNextCursor(narrowedRecords?.nextCursor ?? null);
          setInbox(Array.isArray(narrowedInbox) ? narrowedInbox : []);
          setMetrics(counts ?? null);
          const openCaseId = props.consumeOpenCase?.();
          if (openCaseId) { setTab("records"); setDetail(await actions.record(openCaseId)); }
          setError(null);
        } catch (reason) { setError(banner(reason).message); }
      };
      react.useEffect(() => {
        setDetail(null); setAgentDetail(null); load();
        const subscription = props.panelInfo?.subscribe?.(value => { if ((value?.activePanelId ?? value) === PAGE_ID) load(); });
        return () => subscription?.();
      }, [props.getSessionId()]);
      const run = async (method, ...args) => {
        try { await actions[method](...args); await load(); }
        catch (reason) { setError(banner(reason).message); }
      };
      const selectRecord = async caseId => { try { setDetail(await actions.record(caseId)); setError(null); } catch (reason) { setError(banner(reason).message); } };
      const selectAgent = async agentId => {
        try {
          const value = await actions.agent(agentId);
          setAgentDetail(value); setName(value?.name ?? ""); setDescription(value?.userDescription?.text ?? ""); setError(null);
        } catch (reason) { setError(banner(reason).message); }
      };
      const filterField = (key, value) => setFilter({ ...filter, [key]: value || undefined });
      return jsx.jsxs("main", { style: { display: "grid", gap: "12px", padding: "20px", overflow: "auto", color: "var(--dsw-alias-label-primary)" }, children: [
        jsx.jsx("h1", { children: t("decisionSelector") }, "title"),
        error ? jsx.jsx("div", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)" }, children: error }, "error") : null,
        jsx.jsx("nav", { "aria-label": t("decisionSelector"), children: view.tabs.map(id => jsx.jsx("button", { type: "button", key: id, onClick: () => setTab(id), "aria-pressed": view.tab === id, style: buttonStyle, children: t(`decision${id[0].toUpperCase()}${id.slice(1)}`) }, id)) }, "nav"),
        view.tab === "agents" ? jsx.jsxs("section", { style: { display: "grid", gap: "10px" }, children: [
          jsx.jsxs("div", { children: [jsx.jsx("input", { placeholder: "Agent name", value: name, onChange: event => setName(event.target.value), style: inputStyle, "aria-label": "Agent name" }), jsx.jsx("textarea", { placeholder: "User description", value: description, onChange: event => setDescription(event.target.value), style: inputStyle, "aria-label": "User description" })] }, "editor"),
          jsx.jsx("button", { type: "button", style: buttonStyle, onClick: () => run("profileUpsert", { agentId: agentDetail?.agentId, name, userDescription: description }), children: t("decisionSave") }, "save"),
          jsx.jsx("div", { children: view.agents.map(agent => jsx.jsxs("article", { style: cardStyle, children: [
            jsx.jsx("button", { type: "button", onClick: () => selectAgent(agent.agentId), children: `${agent.name} · ${agent.state} · v${agent.userDescription?.revision ?? 0}` }, "select"),
            jsx.jsx("code", { children: JSON.stringify(agent.modelRoute ?? { chain: [] }) }, "route"),
            jsx.jsx("button", { type: "button", onClick: () => run("profileSetState", agent.agentId, agent.state === "enabled" ? "disabled" : "enabled"), disabled: agent.state === "archived", children: agent.state === "enabled" ? "Disable" : "Enable" }, "toggle"),
            jsx.jsx("button", { type: "button", onClick: () => run("profileSetState", agent.agentId, "archived"), disabled: agent.state === "archived", children: "Archive" }, "archive"),
          ] }, agent.agentId)) }, "list"),
          agentDetail ? jsx.jsxs("article", { style: cardStyle, children: [jsx.jsx("strong", { children: `${agentDetail.name} · ${agentDetail.agentId}` }), jsx.jsx("pre", { children: JSON.stringify(agentDetail.scope, null, 2) }), jsx.jsx("div", { children: `generatedDescription: ${JSON.stringify(agentDetail.generatedDescription ?? { revision: 0, text: "" })}` }), jsx.jsx("ul", { children: (agentDetail.descriptionHistory ?? []).map(item => jsx.jsx("li", { children: `v${item.revision}: ${item.text}` }, item.revision)) })] }, "history") : null,
        ] }, "agents") : null,
        view.tab === "records" ? jsx.jsxs("section", { style: { display: "grid", gap: "10px" }, children: [
          jsx.jsx("div", { children: ["agentId", "state", "outcome", "reasonCode", "scope", "feedbackState"].map(key => jsx.jsx("input", { value: filter[key] ?? "", onChange: event => filterField(key, event.target.value), placeholder: key, "aria-label": `Filter ${key}`, style: inputStyle }, key)) }, "filters"),
          jsx.jsx("button", { type: "button", onClick: load, style: buttonStyle, children: t("decisionRecords") }, "apply"),
          jsx.jsx("div", { children: view.records.map(record => jsx.jsx("button", { type: "button", onClick: () => selectRecord(record.caseId), style: buttonStyle, children: `${record.caseId} · ${record.state}${record.closing ? `/${record.closing}` : ""}` }, record.caseId)) }, "records"),
          nextCursor ? jsx.jsx("button", { type: "button", onClick: async () => { const page = await actions.records(filter, { after: nextCursor }); setRecords(page.records); setNextCursor(page.nextCursor); }, style: buttonStyle, children: "Next" }, "next") : null,
          detail ? jsx.jsxs("article", { style: cardStyle, "data-readonly-record": detail.case.caseId, children: [
            ...(Array.isArray(detail.attempts) ? detail.attempts : []).map((attempt, index) => jsx.jsx(AttemptContextPack, { attempt, t }, attempt?.attemptId ?? index)),
            jsx.jsx("pre", { children: JSON.stringify(detail, null, 2) }, "detail"),
            jsx.jsx("input", { value: comment, onChange: event => setComment(event.target.value), "aria-label": t("decisionComment"), style: inputStyle }, "comment-input"),
            jsx.jsx("button", { type: "button", onClick: () => run("feedback", detail.case.caseId, "rating_up"), children: t("decisionUp") }, "up"),
            jsx.jsx("button", { type: "button", onClick: () => run("feedback", detail.case.caseId, "rating_down"), children: t("decisionDown") }, "down"),
            jsx.jsx("button", { type: "button", onClick: () => run("feedback", detail.case.caseId, detail.case.feedbackState === "validated" ? "undo_rating_up" : "undo_rating_down"), children: t("decisionUndo") }, "undo"),
            jsx.jsx("button", { type: "button", disabled: !comment, onClick: () => run("feedback", detail.case.caseId, "comment", comment), children: t("decisionComment") }, "comment"),
            jsx.jsx("button", { type: "button", disabled: !comment, onClick: () => run("correction", detail.case.caseId, comment, detail.case.scope, [detail.case.caseId]), children: t("decisionCorrect") }, "correct"),
          ] }, "detail") : null,
        ] }, "records") : null,
        view.tab === "inbox" ? jsx.jsx("section", { children: view.inbox.length ? view.inbox.map(item => jsx.jsx(InboxItem, { item, agents: view.agents, run, t }, item.caseId)) : t("decisionNoRecord") }, "inbox") : null,
        view.tab === "metrics" ? jsx.jsxs("section", { style: cardStyle, children: [jsx.jsx("pre", { children: JSON.stringify(view.metrics, null, 2) }, "metrics"), jsx.jsx("small", { children: "Auto answer rate is diagnostic, not a quality metric." }, "note")] }, "metrics") : null,
      ] });
    }

    exports.PAGE_ID = PAGE_ID;
    exports.DecisionPage = DecisionPage;
    exports.InboxItem = InboxItem;
    exports.AttemptContextPack = AttemptContextPack;
    return module.exports;
  },
});
