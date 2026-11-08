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
        setSelector: (mode, agentId) => call("setSelector", { mode, agentId }),
        decide: (caseId, answers) => call("decide", { caseId, answers }),
        reassign: (caseId, agentId) => call("reassign", { caseId, agentId }),
        cancel: caseId => call("cancel", { caseId }), retry: caseId => call("retry", { caseId }),
        feedback: (caseId, verb, text) => call("feedback", { caseId, verb, ...(text === undefined ? {} : { payload: { text } }) }),
        correction: (caseId, direction, scope, supersedes) => call("correction", { caseId, direction, scope, supersedes }),
        profileUpsert: value => call("profileUpsert", value), profileSetState: (agentId, state) => call("profileSetState", { agentId, state }),
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
