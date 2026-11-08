window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-learning.js",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // Pure legacy learning projections shared by the composition root. The
    // productized review surface intentionally remains a later OpenSpec slice.
    function revision(summary, detail) {
      const revisions = [summary?.revision, ...(summary && detail?.snapshotId === summary.snapshotId ? [detail.revision] : [])].filter(Number.isInteger);
      return revisions.length ? Math.max(...revisions) : undefined;
    }
    function status(t, prefix, value) {
      return typeof value === "string" ? t(`${prefix}_${value}`) : "—";
    }

    exports.revision = revision;
    exports.status = status;
    return module.exports;
  },
});
