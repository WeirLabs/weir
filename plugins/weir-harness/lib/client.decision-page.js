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
      const [pending, setPending] = react.useState(null);
      const [learningDetail, setLearningDetail] = react.useState(null);
      const actions = props.createDecisionActions(props.connection, props.getSessionId(), props.decisionRpc);
      const banner = props.errorBanner ?? (reason => ({ message: reason instanceof Error ? reason.message : String(reason) }));
      const view = props.pageView?.({ tab, agents, records, inbox, metrics }) ?? { tab, tabs: ["agents", "records", "inbox", "metrics"], agents, records, inbox, metrics };
      const readLearning = async (agentValue, learningRunId) => {
        const selectedRunId = learningRunId ?? learningRows(agentValue?.learningRuns).find(run => run.outcome === "candidate")?.learningRunId ?? learningRows(agentValue?.learningRuns)[0]?.learningRunId;
        if (!selectedRunId) { setLearningDetail(null); return; }
        const selectedRun = await actions.learningRun(selectedRunId);
        const snapshotSummary = learningRows(agentValue?.snapshots).find(snapshot => snapshot.learningRunId === selectedRunId);
        const parentSnapshotId = snapshotSummary?.parentSnapshotId ?? selectedRun?.inputFrozen?.parentSnapshotId ?? null;
        const [selectedSnapshot, parentSnapshot] = await Promise.all([
          snapshotSummary ? actions.memorySnapshot(snapshotSummary.snapshotId) : Promise.resolve(null),
          parentSnapshotId ? actions.memorySnapshot(parentSnapshotId) : Promise.resolve(null),
        ]);
        setLearningDetail({ agentId: agentValue.agentId, run: selectedRun, snapshot: selectedSnapshot, parentSnapshot });
      };
      const load = async (preserveError = false) => {
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
          if (agentDetail?.agentId) {
            const refreshedAgent = await actions.agent(agentDetail.agentId);
            setAgentDetail(refreshedAgent);
            await readLearning(refreshedAgent);
          }
          if (detail?.case?.caseId) setDetail(await actions.record(detail.case.caseId));
          const openCaseId = props.consumeOpenCase?.();
          if (openCaseId) { setTab("records"); setDetail(await actions.record(openCaseId)); }
          const agentDestination = props.consumeAgentDestination?.();
          if (agentDestination) {
            setTab("agents");
            if (agentDestination === "create") { setAgentDetail(null); setName(""); setDescription(""); }
          }
          if (!preserveError) setError(null);
        } catch (reason) { setError(banner(reason).message); }
      };
      react.useEffect(() => {
        setDetail(null); setAgentDetail(null); setLearningDetail(null); load();
        const subscription = props.panelInfo?.subscribe?.(value => { if ((value?.activePanelId ?? value) === PAGE_ID) load(); });
        return () => subscription?.();
      }, [props.getSessionId()]);
      const run = async (method, ...args) => {
        if (pending) return;
        setPending(method);
        try { await actions[method](...args); await load(); }
        catch (reason) { const message = banner(reason).message; await load(true); setError(message); }
        finally { setPending(null); }
      };
      const selectRecord = async caseId => { try { setDetail(await actions.record(caseId)); setError(null); } catch (reason) { setError(banner(reason).message); } };
      const selectAgent = async agentId => {
        try {
          setLearningDetail(null);
          const value = await actions.agent(agentId);
          setAgentDetail(value); setName(value?.name ?? ""); setDescription(value?.userDescription?.text ?? ""); setError(null);
          await readLearning(value);
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
          agentDetail ? jsx.jsxs("article", { style: cardStyle, children: [
            jsx.jsx("strong", { children: `${agentDetail.name} · ${agentDetail.agentId}` }, "identity"),
            jsx.jsx("pre", { children: JSON.stringify(agentDetail.scope, null, 2) }, "scope"),
            jsx.jsx("div", { children: `generatedDescription: ${JSON.stringify(agentDetail.generatedDescription ?? { revision: 0, text: "" })}` }, "generated-description"),
            jsx.jsx("ul", { children: (agentDetail.descriptionHistory ?? []).map(item => jsx.jsx("li", { children: `v${item.revision}: ${item.text}` }, item.revision)) }, "description-history"),
            AgentLearning({
              agent: agentDetail, detail: learningDetail, run, pending, t, learning: props.learning,
              selectRun: learningRunId => readLearning(agentDetail, learningRunId),
              selectSnapshot: snapshotId => {
                const snapshot = learningRows(agentDetail.snapshots).find(item => item.snapshotId === snapshotId);
                return snapshot?.learningRunId ? readLearning(agentDetail, snapshot.learningRunId) : Promise.resolve();
              },
              openRecord: async caseId => { setTab("records"); await selectRecord(caseId); },
            }),
          ] }, "history") : null,
        ] }, "agents") : null,
        view.tab === "records" ? jsx.jsxs("section", { style: { display: "grid", gap: "10px" }, children: [
          jsx.jsx("div", { children: ["agentId", "state", "outcome", "reasonCode", "scope", "feedbackState"].map(key => jsx.jsx("input", { value: filter[key] ?? "", onChange: event => filterField(key, event.target.value), placeholder: key, "aria-label": `Filter ${key}`, style: inputStyle }, key)) }, "filters"),
          jsx.jsx("button", { type: "button", onClick: () => load(), style: buttonStyle, children: t("decisionRecords") }, "apply"),
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
    exports.AgentLearning = AgentLearning;
    exports.principleDiff = principleDiff;
    return module.exports;
  },
});
