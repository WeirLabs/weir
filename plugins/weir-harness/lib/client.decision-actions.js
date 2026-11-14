window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-actions.js",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    function createDecisionActions(connection, sessionId, rpc) {
      const call = (method, args = {}) => rpc(connection, method, { sessionId, ...args });
      return {
        overview: () => call("overview"), agents: () => call("agents"), agent: agentId => call("agent", { agentId }), records: (filter, cursor) => call("records", { filter, cursor }),
        record: caseId => call("record", { caseId }), inbox: () => call("inbox"), metrics: window => call("metrics", { window }),
        routingReview: (window, cursor) => call("routingReview", { window, ...(cursor === undefined ? {} : { cursor }) }),
        setSelector: (mode, agentId) => call("setSelector", { mode, agentId }),
        decide: (caseId, answers) => call("decide", { caseId, answers }),
        reassign: (caseId, agentId) => call("reassign", { caseId, agentId }),
        cancel: caseId => call("cancel", { caseId }), retry: caseId => call("retry", { caseId }),
        clarify: (caseId, question) => call("clarify", { caseId, question }),
        returnToCaller: (caseId, note) => call("returnToCaller", { caseId, note }),
        feedback: (caseId, verb, text) => call("feedback", { caseId, verb, ...(text === undefined ? {} : { payload: { text } }) }),
        correction: (caseId, direction, scope, supersedes) => call("correction", { caseId, direction, scope, supersedes }),
        profileUpsert: value => call("profileUpsert", value), profileSetState: (agentId, state) => call("profileSetState", { agentId, state }),
        profileDeletePreview: agentId => call("profileDeletePreview", { agentId }),
        profileDelete: (agentId, expectedCases) => call("profileDelete", { agentId, expectedCases }),
        learningStart: (agentId, requestId) => call("learningStart", { agentId, requestId }),
        learningRun: learningRunId => call("learningRun", { learningRunId }),
        snapshotPublish: (snapshotId, expectedRevision) => call("snapshotPublish", { snapshotId, expectedRevision }),
        snapshotReject: (snapshotId, expectedRevision) => call("snapshotReject", { snapshotId, expectedRevision }),
        snapshotRollback: (snapshotId, expectedRevision) => call("snapshotRollback", { snapshotId, expectedRevision }),
        memorySnapshot: snapshotId => call("memorySnapshot", { snapshotId }),
        // Public memory crosses workspaces, so the caller names no workspace:
        // only the assistant, and the user's explicit disclosure/retry gesture.
        publicMemoryRefresh: (agentId, options = {}) => call("publicMemoryRefresh", {
          agentId,
          ...(options.acknowledgedDisclosure === true ? { acknowledgedDisclosure: true } : {}),
          ...(options.retryFailedExtraction === true ? { retryFailedExtraction: true } : {}),
        }),
        publicCandidate: agentId => call("publicCandidate", { agentId }),
        // A data export names no workspace, path or content: the Host derives the
        // scope and the destination from this session alone.
        exportData: () => call("exportData"),
      };
    }
    function errorBanner(reason, fallback = "Decision action failed; retry is available.") {
      return { role: "alert", message: reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback };
    }
    exports.createDecisionActions = createDecisionActions;
    exports.errorBanner = errorBanner;
    return module.exports;
  },
});
