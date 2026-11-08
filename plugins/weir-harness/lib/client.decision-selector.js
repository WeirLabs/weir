window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-selector.js",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const SELECTOR_ID = "weir-decision-selector";

    function DecisionSelector(props) {
      const t = props.t ?? ((key) => key === "decisionSelector" ? "Decision Agent" : key);
      const [options, setOptions] = react.useState([{ value: "off", mode: "off", label: "Off" }]);
      const [selected, setSelected] = react.useState("off");
      const [pending, setPending] = react.useState(false);
      const [error, setError] = react.useState(null);
      react.useEffect(() => {
        let alive = true;
        if (!props.sessionId) return undefined;
        Promise.resolve(props.decisionRpc(props.connection, "overview", { sessionId: props.sessionId })).then(value => {
          if (!alive) return;
          setOptions(props.selectorOptions(value));
          setSelected(value?.selector?.mode === "agent" ? value.selector.agentId : "off");
          setError(null);
        }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
        return () => { alive = false; };
      }, [props.sessionId]);

      const change = async event => {
        const value = event.target.value;
        const previous = selected;
        setPending(true);
        setError(null);
        try {
          await props.decisionRpc(props.connection, "setSelector", value === "off" ? { sessionId: props.sessionId, mode: "off" } : { sessionId: props.sessionId, mode: "agent", agentId: value });
          setSelected(value);
        } catch (reason) {
          setSelected(previous);
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          setPending(false);
        }
      };
      return jsx.jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" }, children: [
        jsx.jsx("select", {
          value: selected, onChange: change, disabled: pending,
          "aria-label": t("decisionSelector"), "data-weir-decision-selector": SELECTOR_ID,
          style: { color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px", padding: "3px 6px" },
          children: options.map(option => jsx.jsx("option", { value: option.value, children: option.label }, option.value)),
        }, "select"),
        error ? jsx.jsx("span", { role: "alert", style: { color: "var(--dsw-alias-state-error-primary)" }, children: error }, "error") : null,
      ] });
    }


    exports.SELECTOR_ID = SELECTOR_ID;
    exports.DecisionSelector = DecisionSelector;
    return module.exports;
  },
});
