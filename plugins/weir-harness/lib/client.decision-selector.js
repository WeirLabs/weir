window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-selector.js",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require("react");
    const jsx = require("react/jsx-runtime");
    const SELECTOR_ID = "weir-decision-selector";
    const PANEL_ID = "weir-da-selector-panel";
    const TITLE_ID = "weir-da-selector-title";

    function DecisionSelector(props) {
      const t = props.t ?? (key => key);
      const ui = props.ui;
      const [snapshot, setSnapshot] = react.useState({ phase: "loading", selector: null, agents: [], status: null, auto: null, error: null });
      const [open, setOpen] = react.useState(false);
      const [pending, setPending] = react.useState(false);
      const [readRevision, setReadRevision] = react.useState(0);
      const [failedTarget, setFailedTarget] = react.useState(null);
      const triggerRef = react.useRef(null);
      const panelRef = react.useRef(null);
      const savingRef = react.useRef(false);
      const restoreFocusRef = react.useRef(false);
      const sessionRef = react.useRef(props.sessionId);
      const loadedSessionRef = react.useRef(null);
      sessionRef.current = props.sessionId;

      react.useEffect(() => {
        let alive = true;
        const sessionChanged = loadedSessionRef.current !== props.sessionId;
        loadedSessionRef.current = props.sessionId;
        if (sessionChanged) {
          savingRef.current = false;
          setOpen(false);
          setPending(false);
          setSnapshot({ phase: "loading", selector: null, agents: [], status: null, auto: null, error: null });
        } else {
          setSnapshot(current => ({ ...current, phase: "loading", error: null }));
        }
        setFailedTarget(null);
        if (!props.sessionId) return () => { alive = false; };
        Promise.resolve().then(() => props.decisionRpc(props.connection, "overview", { sessionId: props.sessionId })).then(value => {
          if (!alive) return;
          setSnapshot({ phase: "ready", selector: value?.selector ?? null, agents: Array.isArray(value?.agents) ? value.agents : [], status: value?.status ?? null, auto: value?.auto ?? null, error: null });
        }).catch(reason => {
          if (!alive) return;
          const error = reason instanceof Error ? reason : new Error(String(reason));
          setSnapshot(current => ({ ...current, phase: "error", error }));
        });
        return () => { alive = false; };
      }, [props.sessionId, readRevision]);

      const close = () => {
        if (savingRef.current) return;
        restoreFocusRef.current = true;
        setOpen(false);
      };
      react.useEffect(() => {
        if (open || pending || !restoreFocusRef.current) return;
        restoreFocusRef.current = false;
        triggerRef.current?.focus?.();
      }, [open, pending]);

      const view = props.selectorView({
        phase: pending ? "saving" : snapshot.phase,
        selector: snapshot.selector, agents: snapshot.agents, status: snapshot.status, auto: snapshot.auto, error: snapshot.error,
      });
      const choose = async option => {
        if (!option || savingRef.current || pending || !props.sessionId) return;
        if (view.selected === option.value) { close(); return; }
        const sessionId = props.sessionId;
        savingRef.current = true;
        setPending(true);
        setFailedTarget(null);
        setSnapshot(current => ({ ...current, error: null }));
        try {
          const args = option.mode === "off" || option.mode === "auto"
            ? { sessionId, mode: option.mode }
            : { sessionId, mode: "agent", agentId: option.value };
          const result = await props.decisionRpc(props.connection, "setSelector", args);
          if (sessionRef.current !== sessionId) return;
          const selector = option.mode === "agent"
            ? result?.mode === "agent" && result.agentId === option.value ? result : null
            : result?.mode === option.mode && (result.agentId === null || result.agentId === undefined) ? result : null;
          if (!selector) throw new Error("Decision selector save returned no matching authoritative selection");
          setSnapshot(current => ({ ...current, phase: "ready", selector, error: null }));
          savingRef.current = false;
          setPending(false);
          close();
        } catch (reason) {
          if (sessionRef.current !== sessionId) return;
          const error = reason instanceof Error ? reason : new Error(String(reason));
          setSnapshot(current => ({ ...current, phase: "error", error }));
          setFailedTarget(option);
          savingRef.current = false;
          setPending(false);
        }
      };
      const bridge = callback => {
        callback?.();
        close();
      };
      const retryRead = () => {
        setSnapshot(current => ({ ...current, phase: "loading", error: null }));
        setFailedTarget(null);
        setReadRevision(value => value + 1);
      };

      if (!props.sessionId || !ui) return null;
      const triggerText = view.selectedName
        ? `${t("decisionSelector")} · ${view.selectedName}`
        : `${t("decisionSelector")} · ${t(view.triggerKey ?? "decisionSelector")}`;
      const triggerLabel = view.unavailable ? `${triggerText} · ${t("decisionSelectionUnavailable")}` : triggerText;
      const optionRow = option => {
        const label = option.labelKey ? t(option.labelKey) : option.label;
        const description = option.descriptionKey ? t(option.descriptionKey) : "";
        return jsx.jsxs("label", {
          className: "weir-da-selector-option", "data-selected": view.selected === option.value,
          children: [
            jsx.jsx("input", {
              type: "radio", name: "weir-da-selector-choice", value: option.value,
              checked: view.selected === option.value, disabled: pending,
              onChange: () => choose(option), "aria-label": label,
            }, "input"),
            jsx.jsxs("span", { children: [
              jsx.jsx("span", { children: label }, "label"),
              option.descriptionKey ? jsx.jsx("span", { className: "weir-da-caption", children: description }, "description") : null,
              option.shadowKey ? jsx.jsx("span", { className: "weir-da-caption", children: t(option.shadowKey) }, "shadow") : null,
            ] }, "copy"),
          ],
        }, option.value);
      };
      const errorText = snapshot.error ? t(view.errorKey ?? "decisionFailed") : "";
      const rawError = snapshot.error ? { code: snapshot.error.code, message: snapshot.error.message ?? String(snapshot.error) } : null;
      const panel = open ? jsx.jsxs(ui.DecisionModalFrame, {
        dialogRef: panelRef, initialFocus: panelRef, id: PANEL_ID, className: "weir-da-overlay weir-da-selector-panel",
        role: "dialog", "aria-modal": true, "aria-labelledby": TITLE_ID,
        "aria-describedby": "weir-da-selector-safety", tabIndex: -1,
        pending, "aria-busy": pending, closeOnBackdrop: true, onRequestClose: close,
        restoreFocus: false, returnFocus: triggerRef, scrollOrigin: triggerRef, anchor: triggerRef,
        openErrorLabel: t("decisionFailed"), dismissLabel: t("decisionCancel"), onDismissError: () => setOpen(false),
        children: [
          jsx.jsxs("div", { className: "weir-da-selector-header", "data-selector-part": "header", children: [
            jsx.jsx("h2", { id: TITLE_ID, className: "weir-da-selector-title", children: t("decisionSelectTitle") }, "title"),
            jsx.jsx("p", { id: "weir-da-selector-safety", className: "weir-da-caption", children: t("decisionSelectorSafety") }, "safety"),
          ] }, "header"),
          jsx.jsxs("div", { className: "weir-da-selector-body", "data-selector-part": "body", children: [
            view.globalOff ? jsx.jsxs(ui.EmptyState, { children: [
              jsx.jsx("strong", { children: t("decisionGlobalOff") }, "title"),
              jsx.jsx("div", { children: t("decisionGlobalOffHint") }, "hint"),
            ] }, "global-off") : null,
            view.unavailable ? jsx.jsx(ui.Badge, { variant: "warn", children: `${view.selectedName ?? t("decisionSelector")} · ${t("decisionSelectionUnavailable")}` }, "unavailable") : null,
            view.phase === "loading" ? jsx.jsx(ui.LoadingState, { children: t("decisionLoading") }, "loading") : null,
            view.phase === "error" && !failedTarget ? jsx.jsxs(ui.ErrorState, { children: [
              jsx.jsx("span", { children: errorText }, "message"),
              jsx.jsx(ui.Button, { variant: "secondary", onClick: retryRead, children: t("decisionRetry") }, "retry"),
            ] }, "read-error") : null,
            failedTarget ? jsx.jsxs(ui.ErrorState, { children: [
              jsx.jsx("span", { children: errorText }, "message"),
              jsx.jsx(ui.Button, { variant: "secondary", disabled: pending, onClick: () => choose(failedTarget), children: t("decisionRetry") }, "retry"),
            ] }, "save-error") : null,
            rawError ? jsx.jsx(ui.Disclosure, { label: t("decisionAdvancedDiagnostics"), children: () => jsx.jsx("pre", { children: JSON.stringify(rawError, null, 2) }) }, "error-diagnostics") : null,
            view.phase !== "loading" && view.options.length > 0 ? jsx.jsx("div", {
              role: "radiogroup", "aria-label": t("decisionSelectTitle"), className: "weir-da-selector-options",
              children: view.options.map(optionRow),
            }, "options") : null,
            pending ? jsx.jsx("div", { role: "status", "aria-live": "polite", className: "weir-da-caption", children: t("decisionSaving") }, "saving") : null,
            view.emptyKey ? jsx.jsx("p", { className: "weir-da-caption", "data-selector-empty": true, children: t(view.emptyKey) }, "empty") : null,
          ] }, "body"),
          jsx.jsxs("div", { className: "weir-da-actions weir-da-selector-footer", "data-selector-part": "footer", children: [
            view.emptyKey ? jsx.jsx(ui.Button, { variant: "primary", disabled: pending, onClick: () => bridge(props.onCreate), children: t("decisionCreateAgent") }, "create") : null,
            jsx.jsx(ui.Button, { variant: "secondary", disabled: pending, onClick: () => bridge(props.onManage), children: t("decisionManageAgents") }, "manage"),
          ] }, "footer"),
        ],
      }) : null;
      return jsx.jsxs("span", {
        className: "weir-da-selector", "data-weir-decision-selector": SELECTOR_ID,
        children: [
          jsx.jsx(ui.DecisionStyles, {}, "styles"),
          jsx.jsxs("button", {
            ref: triggerRef, type: "button", className: "weir-da-selector-trigger",
            "data-weir-decision-trigger": SELECTOR_ID, "data-unavailable": view.unavailable,
            "aria-label": triggerLabel, "aria-haspopup": "dialog", "aria-expanded": open,
            "aria-controls": open ? PANEL_ID : undefined, disabled: pending,
            onClick: () => open ? close() : setOpen(true),
            children: [
              jsx.jsx(ui.DecisionIcon, { name: view.unavailable ? "warning" : "branch-check", size: 14 }, "icon"),
              jsx.jsx("span", { className: "weir-da-selector-trigger-label", children: triggerText }, "label"),
              jsx.jsx("span", { "aria-hidden": "true", children: open ? "⌃" : "⌄" }, "chevron"),
            ],
          }, "trigger"),
          panel,
        ],
      });
    }

    exports.SELECTOR_ID = SELECTOR_ID;
    exports.DecisionSelector = DecisionSelector;
    return module.exports;
  },
});
