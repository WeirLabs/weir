window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-learning.js",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const jsx = require("react/jsx-runtime");

    const rows = value => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];

    function learningView({ agent = {}, detail = null, error = null, pending = null, loading = false, candidateReadiness } = {}) {
      const runs = rows(agent.learningRuns);
      const snapshots = rows(agent.snapshots);
      const current = snapshots.find(snapshot => snapshot.snapshotId === agent.currentSnapshotId) ?? null;
      const latestRun = runs[0] ?? null;
      const candidateRun = runs.find(run => run.outcome === "candidate") ?? null;
      const candidate = candidateRun ? snapshots.find(snapshot => snapshot.state === "draft" && snapshot.learningRunId === candidateRun.learningRunId) ?? null : null;
      const candidateDetail = detail?.candidate ? { agentId: detail.agentId, ...detail.candidate } : detail?.run || detail?.snapshot ? detail : null;
      const readiness = candidateRun && candidate && typeof candidateReadiness === "function"
        ? candidateReadiness({ agent, detail: candidateDetail, error })
        : { ready: false, reason: candidateRun && candidate ? "loading" : "candidate" };
      const inspection = detail?.inspection ?? candidateDetail;
      const emptyInspection = latestRun && inspection?.run?.learningRunId === latestRun.learningRunId
        && Array.isArray(inspection.run.operations) && inspection.run.operations.length === 0 && !inspection.snapshot;
      const noChanges = !candidateRun && emptyInspection
        && (latestRun.outcome === "published" || latestRun.outcome === "failed" && inspection.run.replay?.detail === "NO_CANDIDATE_CHANGES");
      const startBlockKey = agent.state !== "enabled" ? "decisionLearningStartUnavailable"
        : typeof pending === "string" ? "decisionLearningWorking"
        : loading ? "decisionCandidateLoading"
        : runs.some(run => run.outcome === "running") ? "decisionLearningStartRunning"
        : candidateRun ? "decisionLearningStartCandidate" : null;
      const currentReview = detail?.current ?? null;
      const currentSnapshot = current && currentReview?.agentId === agent.agentId && currentReview.snapshot?.snapshotId === agent.currentSnapshotId
        && (currentReview.snapshot.agentId === undefined || currentReview.snapshot.agentId === agent.agentId)
        && (!current.learningRunId || currentReview.snapshot.learningRunId === current.learningRunId) ? currentReview.snapshot : null;
      const currentRevision = currentSnapshot?.state === "published" && Number.isInteger(currentSnapshot.revision) ? currentSnapshot.revision : null;
      // Only this review's own added/changed entries can be revised, and only while
      // the draft is still a draft tied to a candidate run: a published, rejected or
      // already removed entry never offers a write entry point. A retirement keeps
      // its entry with state 'retired' and reads as a change here, so the active
      // state is what makes an entry editable.
      const reviewable = candidateDetail?.snapshot?.state === "draft" && candidateDetail?.run?.outcome === "candidate";
      const changes = candidateDetail?.snapshot
        ? principleDiff(candidateDetail.parentSnapshot, candidateDetail.snapshot).map(change => ({
          ...change,
          editable: reviewable && change.after?.state === "active" && (change.change === "added" || change.change === "changed"),
        }))
        : [];
      const sourceRecords = rows(candidateDetail?.snapshot?.sourceRecords ?? candidateDetail?.run?.sourceRecords);
      return {
        runs, snapshots, current, latestRun, candidateRun, candidate, candidateDetail, inspection, readiness, changes, sourceRecords,
        currentReview, currentSnapshot, currentRevision,
        currentVersion: Number.isInteger(current?.version) ? current.version : null,
        pendingReview: Boolean(candidateRun && candidate),
        statusKey: candidateRun ? "decisionLearningOutcome_candidate" : noChanges ? "decisionLearningNoChanges"
          : latestRun ? `decisionLearningOutcome_${latestRun.outcome}` : "decisionLearningIdle",
        startBlockKey, canStart: startBlockKey === null,
        canReview: readiness.ready && typeof pending !== "string" && !loading,
        canRollback: Boolean(current && currentRevision !== null && typeof pending !== "string" && !loading),
        // The list can show what is editable, but a write needs the review itself to
        // be current: a stale or incomplete review never opens a write path.
        canEditCandidate: readiness.ready && typeof pending !== "string" && !loading,
        candidateZone: candidateDetail?.snapshot?.zone === "public" ? "public" : "workspace",
      };
    }
    function principleDiff(parentSnapshot, snapshot) {
      const before = new Map(rows(parentSnapshot?.principles).map(item => [item.principleId, item]));
      const after = new Map(rows(snapshot?.principles).map(item => [item.principleId, item]));
      const result = [];
      for (const principleId of new Set([...before.keys(), ...after.keys()])) {
        const previous = before.get(principleId) ?? null;
        const next = after.get(principleId) ?? null;
        const project = item => item ? { text: item.text, scope: item.scope, sources: item.sources, state: item.state } : null;
        if (previous && next && JSON.stringify(project(previous)) === JSON.stringify(project(next))) continue;
        result.push({ principleId, change: previous ? next ? "changed" : "removed" : "added", before: previous, after: next });
      }
      return result;
    }

    // Scope is shown in ordinary language: workspace membership is the current
    // workspace by contract, so its real path never appears.
    function formatScope(scope, t) {
      if (!scope || typeof scope !== "object") return t("decisionCurrentScope");
      const parts = [];
      if (Array.isArray(scope.workspaces) && scope.workspaces.length) parts.push(t("decisionScopeCurrentWorkspace"));
      for (const key of ["paths", "tags"]) for (const value of Array.isArray(scope[key]) ? scope[key] : []) if (typeof value === "string") parts.push(value);
      return parts.length ? parts.join(" · ") : t("decisionCurrentScope");
    }
    function AgentLearning(props) {
      const t = props.t ?? (key => key);
      const ui = props.ui;
      const view = learningView(props);
      // The publish confirmation states the user's own edits as a fact, and only
      // when this very candidate was edited; it never shows a before/after draft.
      const edits = props.candidateEdits && props.candidateEdits.snapshotId === view.readiness.snapshotId ? props.candidateEdits : null;
      const editCount = edits ? (Number(edits.edited) || 0) + (Number(edits.removed) || 0) : 0;
      const updateTarget = { snapshotId: view.readiness.snapshotId, expectedRevision: view.readiness.expectedRevision, zone: view.candidateZone };
      const confirm = kind => {
        if (!view.canReview) return;
        return props.confirmAction?.({
          kind, snapshotId: view.readiness.snapshotId, expectedRevision: view.readiness.expectedRevision,
          changeCount: view.changes.length, currentVersion: view.currentVersion,
          ...(editCount > 0 ? { edited: Number(edits.edited) || 0, removed: Number(edits.removed) || 0 } : {}),
        });
      };
      return jsx.jsxs("section", { className: "weir-da-learning", "aria-label": t("decisionLearningGovernance"), children: [
        jsx.jsxs("header", { className: "weir-da-section-header", children: [
          jsx.jsx("h3", { children: t("decisionLearningGovernance") }, "title"),
          jsx.jsx(ui.Badge, { variant: view.pendingReview ? "warn" : view.statusKey === "decisionLearningOutcome_failed" ? "error" : "idle", children: t(view.statusKey) }, "status"),
        ] }, "header"),
        jsx.jsx("p", { children: view.current
          ? `${t("decisionCurrentSnapshot")}: ${t("decisionPrincipleVersion")} ${view.currentVersion ?? "—"}`
          : t("decisionNoCurrentSnapshot") }, "current"),
        view.pendingReview ? jsx.jsx(ui.Badge, { variant: "warn", children: t("decisionPendingReview") }, "pending") : null,
        view.current ? jsx.jsx(ui.Button, { variant: "danger", "data-action": "learning-rollback", disabled: !view.canRollback, onClick: () => {
          if (!view.canRollback) return;
          return props.confirmAction?.({ kind: "snapshotRollback", snapshotId: view.currentSnapshot.snapshotId, expectedRevision: view.currentRevision, currentVersion: view.currentVersion });
        }, children: t("decisionRollback") }, "rollback") : null,
        !view.pendingReview ? jsx.jsxs("div", { className: "weir-da-actions", children: [
          // The detail panel keeps a single solid action (edit); starting a
          // consolidation is a routine quiet action.
          jsx.jsx(ui.Button, { "data-action": "learning-start", disabled: !view.canStart, "aria-busy": props.pending === "learningStart", onClick: () => { if (view.canStart) return props.onStart?.(); }, children: t("decisionConsolidate") }, "start"),
        ] }, "actions") : null,
        view.startBlockKey && !view.pendingReview ? jsx.jsx("p", { className: "weir-da-caption", children: t(view.startBlockKey) }, "start-block") : null,
        view.pendingReview ? jsx.jsxs("section", { className: "weir-da-candidate-review", "data-candidate-review": true, children: [
          props.error ? jsx.jsx(ui.ErrorState, { children: jsx.jsxs("div", { className: "weir-da-actions", children: [
            jsx.jsx("span", { children: t("decisionLearningReadFailed") }, "message"),
            props.onRetry ? jsx.jsx(ui.Button, { onClick: props.onRetry, children: t("decisionRetry") }, "retry") : null,
          ] }) }, "error") : null,
          view.candidateDetail ? jsx.jsxs("div", { children: [
            PrincipleChanges({
              changes: view.changes, t, ui,
              writable: view.canEditCandidate && props.pending !== "snapshotUpdate",
              editor: props.candidateEditor ?? null,
              zone: view.candidateZone,
              // Every candidate write carries the revision this very review was
              // rendered from: a stale tab is rejected by the Host, never merged.
              onEdit: item => props.onCandidateEdit?.(item),
              onRemove: item => props.onCandidateRemove?.(item, updateTarget),
              onDraft: patch => props.onCandidateDraft?.(patch),
              onSave: () => props.onCandidateSave?.(updateTarget),
              onCancel: () => props.onCandidateCancel?.(),
              entryRef: props.candidateEntryRef,
              error: props.candidateEditorError ?? null,
            }),
            SourceRecords({ records: view.sourceRecords, t, ui, recordAccess: props.detail?.recordAccess, openRecord: props.openRecord }),
            jsx.jsx("p", { role: "note", className: "weir-da-caption", children: t("decisionStructuralQualityWarning") }, "quality-warning"),
          ] }, "review") : jsx.jsx(ui.LoadingState, { children: t("decisionCandidateLoading") }, "loading"),
          props.loading ? jsx.jsx("p", { role: "status", className: "weir-da-caption", children: t("decisionCandidateLoading") }, "refreshing") : !view.readiness.ready && !props.error ? jsx.jsx("p", { role: "status", className: "weir-da-caption", children: t(view.readiness.reason === "loading" ? "decisionCandidateLoading" : "decisionCandidateNotReady") }, "not-ready") : null,
          jsx.jsxs("div", { className: "weir-da-actions", children: [
            jsx.jsx(ui.Button, { variant: "primary", "data-action": "learning-publish", disabled: !view.canReview, onClick: () => confirm("snapshotPublish"), children: t("decisionPublish") }, "publish"),
            jsx.jsx(ui.Button, { "data-action": "learning-reject", disabled: !view.canReview, onClick: () => confirm("snapshotReject"), children: t("decisionReject") }, "reject"),
          ] }, "actions"),
        ] }, "candidate") : null,
        // The owning detail panel merges every advanced surface into a single
        // bottom disclosure (hideAdvanced); standalone renders keep their own.
        props.hideAdvanced === true ? null : jsx.jsx(ui.Disclosure, { id: `weir-da-learning-advanced-${props.agent?.agentId ?? "unknown"}`, label: t("decisionAdvancedDiagnostics"), revealOnOpen: "end", children: () => LearningDiagnostics({ view, ui, t, pending: props.pending, selectRun: props.selectRun, selectSnapshot: props.selectSnapshot }) }, "advanced"),
      ] });
    }

    // The diagnostics content of AgentLearning without its Disclosure wrapper,
    // so the assistant detail panel can merge every advanced surface into one.
    function AgentLearningDiagnostics(props) {
      const t = props.t ?? (key => key);
      const ui = props.ui;
      return LearningDiagnostics({ view: learningView(props), ui, t, pending: props.pending, selectRun: props.selectRun, selectSnapshot: props.selectSnapshot });
    }

    // One review entry: the candidate diff as it already read, then — for an
    // editable draft entry — a row-level edit/delete pair, or the inline editor
    // while it is open. The editor never adds a second "AI original vs. your
    // wording" view on top of that diff.
    function PrincipleChanges(props) {
      const groups = ["added", "changed", "removed"];
      const labels = { added: "decisionDiffAdded", changed: "decisionDiffChanged", removed: "decisionDiffRemoved" };
      return jsx.jsx("div", { className: "weir-da-principle-changes", children: groups.map(change => {
        const items = props.changes.filter(item => item.change === change);
        if (!items.length) return null;
        return jsx.jsxs("section", { "data-principle-group": change, children: [
          jsx.jsx("h4", { children: props.t(labels[change]) }, "title"),
          jsx.jsx("ul", { children: items.map(item => {
            const previous = item.before;
            const next = item.after;
            const editing = typeof props.editor?.principleId === "string" && props.editor.principleId === item.principleId;
            return jsx.jsxs("li", { "data-principle-change": change, "data-principle-id": item.principleId, children: [
              previous ? jsx.jsxs("div", { children: [
                jsx.jsx("strong", { children: props.t(next ? "decisionBefore" : "decisionDiffRemoved") }, "label"),
                jsx.jsx("p", { children: previous.text ?? "—" }, "text"),
                jsx.jsx("p", { className: "weir-da-caption", children: `${props.t("decisionCorrectionScope")}: ${formatScope(previous.scope, props.t)}` }, "scope"),
              ] }, "before") : null,
              next ? jsx.jsxs("div", { children: [
                jsx.jsx("strong", { children: props.t(previous ? "decisionAfter" : "decisionDiffAdded") }, "label"),
                jsx.jsx("p", { children: next.text ?? "—" }, "text"),
                jsx.jsx("p", { className: "weir-da-caption", children: `${props.t("decisionCorrectionScope")}: ${formatScope(next.scope, props.t)}` }, "scope"),
              ] }, "after") : null,
              item.editable && !editing ? jsx.jsxs("div", { className: "weir-da-actions", children: [
                jsx.jsx(props.ui.Button, {
                  id: `weir-da-candidate-edit-${item.principleId}`,
                  "data-principle-action": "edit", "data-principle-id": item.principleId,
                  ref: props.entryRef ? props.entryRef(item.principleId, "edit") : undefined,
                  disabled: !props.writable,
                  onClick: () => { if (props.writable) return props.onEdit?.(item); },
                  children: props.t("decisionPrincipleEdit"),
                }, "edit"),
                jsx.jsx(props.ui.Button, {
                  id: `weir-da-candidate-remove-${item.principleId}`,
                  variant: "danger", "data-principle-action": "remove", "data-principle-id": item.principleId,
                  ref: props.entryRef ? props.entryRef(item.principleId, "remove") : undefined,
                  disabled: !props.writable,
                  onClick: () => { if (props.writable) return props.onRemove?.(item); },
                  children: props.t("decisionPrincipleRemove"),
                }, "remove"),
              ] }, "entry-actions") : null,
              editing ? CandidatePrincipleEditor({
                editor: props.editor, t: props.t, ui: props.ui, zone: props.zone,
                onDraft: props.onDraft, onSave: props.onSave, onCancel: props.onCancel,
                pending: props.writable === false || props.editor.pending === true,
                error: props.error,
              }) : null,
            ] }, item.principleId);
          }) }, "items"),
        ] }, change);
      }) });
    }

    /**
     * The inline editor of one candidate entry. Wording is a bounded textarea; the
     * apply-to scope is the same ordinary control language the assistant editor
     * uses (path/tag rows only). The workspace is read-only text for a private
     * candidate and absent for a public one: neither can be changed here.
     */
    function CandidatePrincipleEditor(props) {
      const t = props.t ?? (key => key);
      const ui = props.ui;
      const editor = props.editor ?? {};
      const text = typeof editor.text === "string" ? editor.text : "";
      const paths = Array.isArray(editor.paths) ? editor.paths : [];
      const tags = Array.isArray(editor.tags) ? editor.tags : [];
      const id = `weir-da-candidate-${editor.principleId ?? "entry"}`;
      const pending = props.pending === true;
      const tooLong = text.length > 600;
      const invalid = text.trim().length === 0 || tooLong;
      const patch = value => { if (!pending) return props.onDraft?.(value); };
      const scopeRows = (kind, values) => jsx.jsxs("div", { className: "weir-da-scope-list", "data-principle-scope-list": kind, children: [
        jsx.jsx("p", { className: "weir-da-caption", children: t(kind === "path" ? "decisionScopePaths" : "decisionScopeTags") }, "label"),
        ...values.map((value, index) => jsx.jsxs("div", { className: "weir-da-scope-row", children: [
          jsx.jsx("input", {
            type: "text", id: `${id}-${kind}-${index}`, "data-principle-scope": kind, "data-row-index": index,
            "aria-label": t(kind === "path" ? "decisionScopePaths" : "decisionScopeTags"), value, disabled: pending,
            onChange: event => patch({ [kind === "path" ? "paths" : "tags"]: values.map((entry, at) => at === index ? event.target.value : entry) }),
          }, "input"),
          jsx.jsx(ui.Button, {
            variant: "ghost", size: "sm", "data-principle-scope-remove": kind, disabled: pending,
            onClick: () => patch({ [kind === "path" ? "paths" : "tags"]: values.filter((entry, at) => at !== index) }),
            children: t("decisionScopeRemove"),
          }, "remove"),
        ] }, `${kind}-${index}`)),
        jsx.jsx(ui.Button, {
          variant: "ghost", size: "sm", "data-principle-scope-add": kind, disabled: pending,
          onClick: () => patch({ [kind === "path" ? "paths" : "tags"]: [...values, ""] }),
          children: t("decisionScopeAdd"),
        }, "add"),
      ] }, kind);
      return jsx.jsxs("div", { className: "weir-da-candidate-editor", "data-principle-editor": editor.principleId ?? "" , children: [
        jsx.jsxs("div", { className: "weir-da-field", "data-field": `${id}-text`, children: [
          jsx.jsx("label", { htmlFor: `${id}-text`, children: t("decisionPrincipleText") }, "label"),
          jsx.jsx("textarea", {
            id: `${id}-text`, rows: 4, value: text, disabled: pending,
            "data-principle-text": true, "aria-invalid": invalid, "aria-describedby": `${id}-text-hint`,
            onChange: event => patch({ text: event.target.value }),
          }, "input"),
          jsx.jsx("div", { id: `${id}-text-hint`, className: "weir-da-field-hint", children: `${text.length}/600 · ${t("decisionPrincipleLength")}` }, "hint"),
        ] }, "text"),
        scopeRows("path", paths),
        scopeRows("tag", tags),
        props.zone === "public" ? null : jsx.jsx("p", { className: "weir-da-caption", "data-principle-workspace": "fixed", children: `${t("decisionScopeCurrentWorkspace")} · ${t("decisionPrincipleWorkspaceFixed")}` }, "workspace"),
        props.error ? jsx.jsx("p", { role: "alert", className: "weir-da-field-error", "data-principle-editor-error": true, children: t(props.error) }, "error") : null,
        jsx.jsxs("div", { className: "weir-da-actions", children: [
          jsx.jsx(ui.Button, {
            variant: "primary", "data-principle-action": "save", disabled: pending || invalid,
            onClick: () => { if (!pending && !invalid) return props.onSave?.(); },
            children: pending ? t("decisionPrincipleSaving") : t("decisionPrincipleSave"),
          }, "save"),
          jsx.jsx(ui.Button, {
            "data-principle-action": "cancel", disabled: pending,
            onClick: () => { if (!pending) return props.onCancel?.(); },
            children: t("decisionCancel"),
          }, "cancel"),
        ] }, "actions"),
      ] });
    }

    function SourceRecords(props) {
      if (!props.records.length) return null;
      return jsx.jsxs("section", { className: "weir-da-learning-sources", children: [
        jsx.jsx("h4", { children: props.t("decisionSourceRecords") }, "title"),
        jsx.jsx("ul", { children: props.records.map((record, index) => {
          const caseId = record.kind === "case" ? record.caseId ?? record.sourceId : record.caseId;
          const canOpen = typeof caseId === "string" && props.recordAccess?.[caseId] === true && typeof props.openRecord === "function";
          return jsx.jsxs("li", { "data-learning-source-record": record.sourceId, children: [
            jsx.jsx("strong", { children: props.t(record.kind === "correction" ? "decisionSourceCorrection" : "decisionSourceCase") }, "kind"),
            record.excerpt || record.direction ? jsx.jsx("p", { className: "weir-da-source-excerpt", children: record.excerpt ?? record.direction }, "excerpt") : null,
            record.scope ? jsx.jsx("p", { className: "weir-da-caption", children: `${props.t("decisionCorrectionScope")}: ${formatScope(record.scope, props.t)}` }, "scope") : null,
            canOpen ? jsx.jsx(props.ui.Button, { variant: "ghost", "data-action": "open-learning-record", "aria-label": props.t("decisionHistory"), onClick: () => {
              if (props.recordAccess?.[caseId] === true) return props.openRecord(caseId);
            }, children: props.t("decisionHistory") }, "open") : null,
          ] }, record.sourceId ?? index);
        }) }, "records"),
      ] });
    }
    function LearningDiagnostics(props) {
      const { view, ui, t } = props;
      const inspection = view.inspection;
      const busy = typeof props.pending === "string";
      const diff = inspection?.snapshot ? principleDiff(inspection.parentSnapshot, inspection.snapshot) : [];
      return jsx.jsxs("div", { className: "weir-da-learning-diagnostics", children: [
        jsx.jsxs("section", { children: [
          jsx.jsx("h4", { children: t("decisionLearningRuns") }, "title"),
          view.runs.length ? jsx.jsx("ul", { children: view.runs.map(run => jsx.jsx("li", { children: jsx.jsx(ui.Button, {
            disabled: busy, "data-learning-run-id": run.learningRunId,
            onClick: () => { if (!busy) return props.selectRun?.(run.learningRunId); },
            children: `${run.learningRunId} · ${status(t, "decisionLearningOutcome", run.outcome)} · r${run.revision ?? "—"}`,
          }) }, run.learningRunId)) }, "runs") : jsx.jsx("p", { children: t("decisionNoLearningRuns") }, "empty"),
        ] }, "runs"),
        jsx.jsxs("section", { children: [
          jsx.jsx("h4", { children: t("decisionSnapshots") }, "title"),
          view.snapshots.length ? jsx.jsx("ul", { children: view.snapshots.map(snapshot => jsx.jsx("li", { children: jsx.jsx(ui.Button, {
            disabled: busy, "data-snapshot-id": snapshot.snapshotId,
            onClick: () => { if (!busy) return props.selectSnapshot?.(snapshot.snapshotId); },
            children: `${snapshot.snapshotId} · v${snapshot.version ?? "—"} · ${status(t, "decisionSnapshotState", snapshot.state)} · r${snapshot.revision ?? "—"}`,
          }) }, snapshot.snapshotId)) }, "snapshots") : jsx.jsx("p", { children: t("decisionNoSnapshots") }, "empty"),
        ] }, "snapshots"),
        view.currentReview ? jsx.jsxs("section", { "data-current-snapshot-diagnostics": true, children: [
          jsx.jsx("h4", { children: t("decisionCurrentSnapshot") }, "title"),
          jsx.jsx("pre", { children: JSON.stringify(view.currentReview, null, 2) }, "current"),
        ] }, "current") : null,
        inspection ? jsx.jsxs("section", { "data-learning-run-detail": inspection.run?.learningRunId, children: [
          jsx.jsx("h4", { children: t("decisionLearningDetail") }, "title"),
          jsx.jsx("pre", { children: JSON.stringify(inspection.run, null, 2) }, "run"),
          jsx.jsx("h4", { children: t("decisionOperations") }, "operations-title"),
          jsx.jsx("pre", { children: JSON.stringify(inspection.run?.operations ?? [], null, 2) }, "operations"),
          jsx.jsx("h4", { children: t("decisionFrozenInput") }, "frozen-title"),
          jsx.jsx("pre", { children: JSON.stringify(inspection.run?.inputFrozen ?? null, null, 2) }, "frozen"),
          jsx.jsx("h4", { children: t("decisionStructuralReplay") }, "replay-title"),
          jsx.jsx("p", { className: "weir-da-caption", children: t("decisionStructuralReplayHint") }, "replay-hint"),
          jsx.jsx("pre", { children: JSON.stringify(inspection.run?.replay ?? null, null, 2) }, "replay"),
          jsx.jsx("h4", { children: t("decisionSourceRecords") }, "sources-title"),
          jsx.jsx("pre", { children: JSON.stringify(inspection.snapshot?.sourceRecords ?? inspection.run?.sourceRecords ?? [], null, 2) }, "sources"),
          jsx.jsx("h4", { children: t("decisionPrincipleDiff") }, "diff-title"),
          jsx.jsx("pre", { children: JSON.stringify(diff, null, 2) }, "diff"),
          jsx.jsx("pre", { children: JSON.stringify({ snapshot: inspection.snapshot ?? null, parentSnapshot: inspection.parentSnapshot ?? null }, null, 2) }, "snapshots-raw"),
        ] }, "inspection") : jsx.jsx("p", { children: t("decisionNoLearningDetail") }, "empty-detail"),
      ] });
    }
    function status(t, prefix, value) {
      return typeof value === "string" ? t(`${prefix}_${value}`) : "—";
    }

    exports.principleDiff = principleDiff;
    exports.AgentLearning = AgentLearning;
    exports.AgentLearningDiagnostics = AgentLearningDiagnostics;
    exports.learningView = learningView;
    exports.status = status;
    return module.exports;
  },
});
