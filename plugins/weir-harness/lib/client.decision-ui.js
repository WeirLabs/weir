window.__ModuleLoader__.load({
  id: "weir-harness",
  chunk: "client.decision-ui.js",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const jsx = require("react/jsx-runtime");

    const DECISION_UI_CSS = `
.weir-da-button { box-sizing: border-box; min-height: 32px; max-width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 18px; font-weight: 500; cursor: pointer; }
.weir-da-button[data-variant="primary"] { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, var(--dsw-alias-bg-layer-1)); font-weight: 600; }
.weir-da-button[data-variant="ghost"] { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.weir-da-button[data-variant="danger"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.weir-da-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.weir-da-button:disabled { cursor: not-allowed; opacity: .55; }
.weir-da-button:focus-visible, .weir-da-disclosure-trigger:focus-visible, .weir-da-selector-trigger:focus-visible, .weir-da-choice:focus-within { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.weir-da-field { min-width: 0; display: grid; gap: 6px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 18px; }
.weir-da-field-hint, .weir-da-caption { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
.weir-da-field input, .weir-da-field textarea, .weir-da-answer-textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 7px 9px; font: inherit; }
.weir-da-badge { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; }
.weir-da-badge[data-variant="success"] { color: var(--dsw-alias-state-success-primary); }
.weir-da-badge[data-variant="warn"] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }
.weir-da-badge[data-variant="error"] { color: var(--dsw-alias-state-error-primary); }
.weir-da-state { box-sizing: border-box; min-width: 0; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 18px; overflow-wrap: anywhere; }
.weir-da-state[data-variant="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.weir-da-overlay { box-sizing: border-box; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-overlay, 0 8px 28px var(--dsw-alias-border-l2)); }
.weir-da-answers { min-width: 0; display: grid; gap: 14px; margin: 0; padding: 0; }
.weir-da-question { min-width: 0; margin: 0; padding: 0; border: 0; }
.weir-da-question legend { max-width: 100%; padding: 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 19px; font-weight: 600; overflow-wrap: anywhere; }
.weir-da-choices { display: grid; gap: 4px; margin-top: 7px; }
.weir-da-choice { min-width: 0; min-height: 32px; display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-primary); cursor: pointer; }
.weir-da-choice:hover { background: var(--dsw-alias-interactive-bg-hover); }
.weir-da-choice input { flex: none; margin: 3px 0 0; }
.weir-da-choice-copy { min-width: 0; display: grid; gap: 2px; overflow-wrap: anywhere; }
.weir-da-choice-description { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; }
.weir-da-actions { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.weir-da-dialog-shade { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; padding: 16px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 64%, transparent); }
.weir-da-dialog { width: min(420px, 100%); max-height: min(70vh, 560px); overflow: auto; padding: 16px; }
.weir-da-selector { position: relative; display: inline-flex; min-width: 0; max-width: 100%; }
.weir-da-selector-trigger { box-sizing: border-box; min-width: 0; max-width: 280px; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 16px; cursor: pointer; }
.weir-da-selector-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.weir-da-selector-trigger[data-unavailable="true"] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); border-color: var(--dsw-alias-state-warn-primary); }
.weir-da-selector-trigger-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.weir-da-selector-panel { position: absolute; inset-inline-end: 0; bottom: calc(100% + 8px); z-index: 30; width: min(320px, calc(100vw - 24px)); max-height: min(420px, 70vh); overflow: auto; overscroll-behavior: contain; padding: 12px; display: grid; gap: 10px; }
.weir-da-selector-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 20px; }
.weir-da-selector-title + .weir-da-caption { margin: 0; }
.weir-da-selector-options { min-width: 0; display: grid; gap: 4px; }
.weir-da-selector-option { min-width: 0; min-height: 36px; display: flex; align-items: flex-start; gap: 8px; padding: 8px; border: 1px solid transparent; border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-primary); cursor: pointer; overflow-wrap: anywhere; }
.weir-da-selector-option:hover { background: var(--dsw-alias-interactive-bg-hover); }
.weir-da-selector-option[data-selected="true"] { border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-overlay)); }
.weir-da-selector-option input { flex: none; margin: 3px 0 0; }
.weir-da-selector-option > span { min-width: 0; display: grid; gap: 2px; }
.weir-da-selector-option .weir-da-caption { display: block; }
.weir-da-selector-footer { padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
.weir-da-page { position: relative; box-sizing: border-box; height: 100%; min-height: 0; overflow: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.weir-da-page-inner { box-sizing: border-box; width: min(100%, 1200px); min-width: 0; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
.weir-da-page-header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.weir-da-page-header h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 650; }
.weir-da-page-header p { margin: 4px 0 0; max-width: 68ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.weir-da-primary-nav { box-sizing: border-box; min-width: 0; max-width: 100%; display: flex; flex-wrap: wrap; gap: 2px; padding: 3px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); }
.weir-da-primary-nav .weir-da-button { border-color: transparent; background: transparent; }
.weir-da-primary-nav .weir-da-button[aria-pressed="true"] { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.weir-da-count { display: inline-flex; min-width: 20px; min-height: 20px; align-items: center; justify-content: center; margin-inline-start: 6px; padding: 0 5px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); font-size: 12px; }
.weir-da-view, .weir-da-card-list { min-width: 0; display: grid; gap: 12px; align-content: start; }
.weir-da-card { box-sizing: border-box; min-width: 0; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.weir-da-conversation-card { position: relative; }
.weir-da-card-header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.weir-da-card-header h2 { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
.weir-da-card-header p, .weir-da-card p { margin: 4px 0 0; line-height: 20px; }
.weir-da-record-answers { display: grid; gap: 10px; }
.weir-da-answer-summary { min-width: 0; display: grid; gap: 4px; padding: 10px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-base); }
.weir-da-record-detail section { min-width: 0; margin-top: 16px; }
.weir-da-record-detail h3 { margin: 0 0 8px; font-size: 13px; line-height: 18px; }
.weir-da-evidence-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.weir-da-evidence-list li { padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); white-space: pre-wrap; }
.weir-da-records-layout { min-width: 0; display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); gap: 16px; align-items: start; }
.weir-da-record-list, .weir-da-record-detail-pane { min-width: 0; display: grid; gap: 6px; }
.weir-da-record-row.weir-da-button { width: 100%; height: auto; min-height: 64px; display: grid; justify-items: start; gap: 4px; padding: 10px; text-align: start; white-space: normal; overflow-wrap: anywhere; }
.weir-da-record-row span { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.weir-da-select { box-sizing: border-box; min-width: 0; max-width: 100%; min-height: 32px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
.weir-da-page select:focus-visible, .weir-da-page input:focus-visible, .weir-da-page textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.weir-da-record-back { display: none; }
@media (max-width: 760px) {
  .weir-da-page-inner { padding: 16px; gap: 16px; }
  .weir-da-records-layout { grid-template-columns: minmax(0, 1fr); }
  .weir-da-records-layout[data-drill-in="true"] .weir-da-record-list { display: none; }
  .weir-da-records-layout[data-drill-in="false"] .weir-da-record-detail-pane { display: none; }
  .weir-da-record-back { display: inline-flex; }
}
.weir-da-disclosure-trigger { box-sizing: border-box; width: 100%; min-height: 32px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; text-align: start; cursor: pointer; }
.weir-da-disclosure-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.weir-da-disclosure { min-width: 0; }
.weir-da-disclosure [role="region"] { min-width: 0; padding-top: 10px; }
.weir-da-suggestion-review, .weir-da-feedback-editor, .weir-da-agent-editor, .weir-da-agent-advanced, .weir-da-agent-diagnostics, .weir-da-advanced-record { min-width: 0; display: grid; gap: 10px; }
.weir-da-suggestion-review { margin: 12px 0; padding: 10px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-base); }
.weir-da-suggestion-review ul, .weir-da-memory-summary { margin: 6px 0 0; padding-inline-start: 20px; }
.weir-da-filters, .weir-da-records-view, .weir-da-agents-view { min-width: 0; display: grid; gap: 12px; }
.weir-da-filter-row { min-width: 0; display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.weir-da-filter { min-width: 0; flex: 1 1 160px; display: grid; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.weir-da-filter input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 32px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
.weir-da-section-header { min-width: 0; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.weir-da-section-header h2, .weir-da-metrics h2 { margin: 0; font-size: 16px; line-height: 24px; }
.weir-da-agent-editor .weir-da-field textarea, .weir-da-agent-advanced textarea { resize: vertical; max-height: 40vh; overflow: auto; overflow-wrap: normal; }
.weir-da-correction-preview { padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-base); }
.weir-da-evaluation { min-width: 0; display: grid; gap: 8px; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l2); }
.weir-da-learning { min-width: 0; display: grid; gap: 12px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l2); }
.weir-da-learning > p { margin: 0; }
.weir-da-learning .weir-da-section-header h3 { margin: 0; font-size: 14px; line-height: 20px; }
.weir-da-candidate-review { min-width: 0; display: grid; gap: 12px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-base); }
.weir-da-principle-changes, .weir-da-principle-changes > section, .weir-da-learning-sources, .weir-da-learning-diagnostics, .weir-da-learning-diagnostics > section { min-width: 0; display: grid; gap: 8px; }
.weir-da-principle-changes h4, .weir-da-learning-sources h4, .weir-da-learning-diagnostics h4 { margin: 0; font-size: 13px; line-height: 18px; }
.weir-da-principle-changes ul, .weir-da-learning-sources ul, .weir-da-learning-diagnostics ul { min-width: 0; display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.weir-da-principle-changes li, .weir-da-learning-sources li { min-width: 0; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); }
.weir-da-principle-changes li > div + div { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
.weir-da-principle-changes li p { margin: 4px 0 0; white-space: pre-wrap; }
.weir-da-source-excerpt { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.weir-da-learning-diagnostics ul { max-height: 240px; overflow: auto; overscroll-behavior: contain; }
.weir-da-learning-diagnostics .weir-da-button { width: 100%; height: auto; white-space: normal; text-align: start; overflow-wrap: anywhere; }
.weir-da-metrics { display: grid; gap: 16px; }
.weir-da-metrics section { min-width: 0; }
.weir-da-metrics h3 { margin: 0 0 8px; font-size: 13px; }
.weir-da-metrics-grid { min-width: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); gap: 8px; margin: 0; }
.weir-da-metric { min-width: 0; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-base); }
.weir-da-metric dt { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.weir-da-metric dd { margin: 4px 0 0; color: var(--dsw-alias-label-primary); font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
.weir-da-routing-review, .weir-da-routing-content, .weir-da-routing-list { min-width: 0; display: grid; gap: 12px; }
.weir-da-routing-review { padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l2); }
.weir-da-routing-review > p { margin: 0; }
.weir-da-routing-item { min-width: 0; display: grid; justify-items: start; gap: 6px; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-base); }
.weir-da-routing-item p { margin: 0; }
.weir-da-routing-item time { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.weir-da-advanced-record pre, .weir-da-agent-diagnostics pre, .weir-da-metrics pre, .weir-da-learning-diagnostics pre { box-sizing: border-box; max-width: 100%; max-height: 420px; margin: 0; overflow: auto; padding: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-base); font-size: 12px; }
.weir-da-agent-diagnostics button { max-width: 100%; overflow-wrap: anywhere; }
@media (max-width: 400px) { .weir-da-page-inner { padding: 12px; } }
@media (max-width: 600px) {
  .weir-da-button { min-height: 36px; }
  .weir-da-actions { align-items: stretch; }
  .weir-da-actions .weir-da-button { flex: 1 1 auto; }
  .weir-da-dialog-shade { padding: 8px; }
}
`;

    function DecisionStyles() {
      return jsx.jsx("style", { children: DECISION_UI_CSS, "data-weir-decision-styles": "" });
    }

    function DecisionIcon(props = {}) {
      const size = Number.isFinite(props.size) ? props.size : 16;
      const name = props.name ?? "branch-check";
      const children = name === "check"
        ? [jsx.jsx("path", { d: "m3 8.5 3.1 3.1L13 4.8" }, "check")]
        : name === "warning"
          ? [jsx.jsx("path", { d: "M8 2.2 14.2 13H1.8L8 2.2ZM8 6v3.2M8 11.5v.1" }, "warning")]
          : name === "error"
            ? [jsx.jsx("circle", { cx: 8, cy: 8, r: 5.8 }, "circle"), jsx.jsx("path", { d: "m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" }, "cross")]
            : name === "info"
              ? [jsx.jsx("circle", { cx: 8, cy: 8, r: 5.8 }, "circle"), jsx.jsx("path", { d: "M8 7.2v4M8 4.8v.1" }, "info")]
              : [
                  jsx.jsx("circle", { cx: 3.2, cy: 3, r: 1.3 }, "branch-top"),
                  jsx.jsx("circle", { cx: 3.2, cy: 13, r: 1.3 }, "branch-bottom"),
                  jsx.jsx("path", { d: "M3.2 4.3v7.4M3.2 7.8h2.5c1.6 0 2.2-.8 2.2-2.1v-.4" }, "branch"),
                  jsx.jsx("path", { d: "m8.5 10.7 1.8 1.8 3.2-4" }, "check"),
                ];
      return jsx.jsxs("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round",
        className: props.className, style: props.style, "aria-hidden": "true",
        "data-decision-icon": name, children,
      });
    }

    function Button(props) {
      const { variant = "secondary", className = "", children, ...rest } = props;
      return jsx.jsx("button", {
        type: "button", ...rest,
        className: ["weir-da-button", className].filter(Boolean).join(" "),
        "data-variant": variant,
        children,
      });
    }

    function Badge(props) {
      const variant = props.variant ?? "idle";
      const icon = props.icon ?? (variant === "success" ? "check" : variant === "warn" ? "warning" : variant === "error" ? "error" : "info");
      return jsx.jsxs("span", { className: "weir-da-badge", "data-variant": variant, role: props.role ?? "status", children: [
        jsx.jsx(DecisionIcon, { name: icon, size: props.size ?? 13 }, "icon"),
        jsx.jsx("span", { children: props.children }, "label"),
      ] });
    }

    function Field(props) {
      const hintId = props.hint && props.id ? `${props.id}-hint` : undefined;
      const childProps = props.children?.props ?? props.children;
      const control = hintId && props.children && typeof props.children === "object"
        ? react.cloneElement(props.children, { "aria-describedby": [childProps?.["aria-describedby"], hintId].filter(Boolean).join(" ") })
        : props.children;
      return jsx.jsxs("div", { className: "weir-da-field", "data-field": props.id, children: [
        jsx.jsx("label", { htmlFor: props.id, children: props.label }, "label"),
        control,
        props.hint ? jsx.jsx("div", { id: hintId, className: "weir-da-field-hint", children: props.hint }, "hint") : null,
      ] });
    }

    function LoadingState(props) {
      return jsx.jsx("div", { className: "weir-da-state", role: "status", "aria-live": "polite", "aria-busy": true, children: props.children });
    }
    function EmptyState(props) {
      return jsx.jsx("div", { className: "weir-da-state", role: "status", children: props.children });
    }
    function ErrorState(props) {
      return jsx.jsx("div", { className: "weir-da-state", "data-variant": "error", role: "alert", children: props.children });
    }

    function Disclosure(props) {
      const generatedId = react.useId();
      const id = props.id ?? `weir-da-${generatedId}`;
      const triggerRef = react.useRef(null);
      const [open, setOpen] = react.useState(props.defaultOpen === true);
      const close = () => {
        setOpen(false);
        const target = props.returnFocus?.current ?? props.returnFocus ?? triggerRef.current;
        target?.focus?.();
      };
      return jsx.jsxs("div", { className: "weir-da-disclosure", onKeyDown: event => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        close();
      }, children: [
        jsx.jsx("button", {
          ref: triggerRef, type: "button", className: "weir-da-disclosure-trigger",
          "aria-expanded": open, "aria-controls": `${id}-content`,
          onClick: () => { if (open) close(); else { setOpen(true); props.onOpen?.(); } },
          children: props.label,
        }, "trigger"),
        open ? jsx.jsx("div", { id: `${id}-content`, role: "region", "aria-label": props.label, children: typeof props.children === "function" ? props.children() : props.children }, "content") : null,
      ] });
    }

    function ConfirmDialog(props) {
      const internalCancelRef = react.useRef(null);
      const internalConfirmRef = react.useRef(null);
      const cancelRef = props.cancelRef ?? internalCancelRef;
      const confirmRef = props.confirmRef ?? internalConfirmRef;
      react.useEffect(() => {
        const previous = props.returnFocus?.current ?? props.returnFocus ?? globalThis.document?.activeElement;
        cancelRef.current?.focus?.();
        return () => previous?.focus?.();
      }, []);
      const onKeyDown = event => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (!props.pending) props.onCancel?.();
          return;
        }
        if (event.key !== "Tab" || !cancelRef.current || !confirmRef.current) return;
        event.preventDefault();
        (event.target === confirmRef.current ? cancelRef : confirmRef).current?.focus?.();
      };
      return jsx.jsx("div", { className: "weir-da-dialog-shade", children: jsx.jsxs("section", {
        id: props.id, className: "weir-da-overlay weir-da-dialog", role: "dialog", "aria-modal": true,
        "aria-labelledby": `${props.id}-title`, "aria-describedby": `${props.id}-body`,
        "aria-busy": props.pending === true, onKeyDown,
        children: [
          jsx.jsx("h2", { id: `${props.id}-title`, children: props.title }, "title"),
          jsx.jsx("div", { id: `${props.id}-body`, children: props.body }, "body"),
          jsx.jsxs("div", { className: "weir-da-actions", children: [
            jsx.jsx(Button, { ref: cancelRef, variant: "secondary", disabled: props.pending, onClick: props.onCancel, children: props.cancelLabel }, "cancel"),
            jsx.jsx(Button, { ref: confirmRef, variant: props.danger ? "danger" : "primary", disabled: props.pending, onClick: props.onConfirm, children: props.confirmLabel }, "confirm"),
          ] }, "actions"),
        ],
      }) });
    }

    function DecisionAnswers(props) {
      const t = props.t ?? (key => key);
      const instanceId = react.useId();
      const incompleteId = `weir-da-answers-${instanceId}-incomplete`;
      const questions = Array.isArray(props.questions) ? props.questions : [];
      const [localAnswers, setLocalAnswers] = react.useState({});
      const [submitting, setSubmitting] = react.useState(false);
      const pendingRef = react.useRef(false);
      const answers = props.answers ?? localAnswers;
      const pending = props.pending === true || submitting;
      const isAnswered = question => {
        const answer = answers[question.id];
        return Array.isArray(question.options)
          ? Array.isArray(answer?.selected) && answer.selected.length > 0
          : typeof answer?.custom === "string" && answer.custom.length > 0;
      };
      const complete = questions.length > 0 && questions.every(isAnswered);
      const update = next => {
        setLocalAnswers(next);
        props.onChange?.(next);
      };
      const answerFor = (question, value) => Array.isArray(question.options)
        ? { selected: Array.isArray(value?.selected) ? value.selected.filter(item => typeof item === "string") : [] }
        : { selected: [], ...(value?.custom === undefined ? {} : { custom: String(value.custom) }) };
      const batch = () => questions.map(question => ({ id: question.id, ...answerFor(question, answers[question.id]) }));
      const fillSuggestions = () => {
        if (pending) return;
        const next = { ...answers };
        for (const suggestion of Array.isArray(props.suggestions) ? props.suggestions : []) {
          const question = questions.find(item => item.id === suggestion?.id);
          if (question) next[question.id] = answerFor(question, suggestion);
        }
        update(next);
      };
      const submit = async event => {
        event?.preventDefault?.();
        if (!complete || pending || pendingRef.current || typeof props.onSubmit !== "function") return;
        pendingRef.current = true;
        setSubmitting(true);
        try { await props.onSubmit(batch()); }
        catch (error) { props.onError?.(error); }
        finally { pendingRef.current = false; setSubmitting(false); }
      };
      return jsx.jsxs("form", {
        className: "weir-da-answers", "aria-busy": pending, noValidate: true, onSubmit: submit,
        children: [
          ...questions.map(question => {
            const answer = answers[question.id] ?? {};
            if (!Array.isArray(question.options)) return jsx.jsx(Field, {
              id: `weir-da-answer-${instanceId}-${question.id}`, label: question.question,
              children: jsx.jsx("textarea", {
                id: `weir-da-answer-${instanceId}-${question.id}`, className: "weir-da-answer-textarea", rows: 3,
                value: answer.custom ?? "", disabled: pending, "aria-label": question.question, "aria-describedby": !isAnswered(question) ? incompleteId : undefined,
                onChange: event => update({ ...answers, [question.id]: { selected: [], custom: event.target.value } }),
              }),
            }, question.id);
            return jsx.jsxs("fieldset", { className: "weir-da-question", disabled: pending, "data-question-id": question.id, "aria-describedby": !isAnswered(question) ? incompleteId : undefined, children: [
              jsx.jsx("legend", { children: question.question }, "legend"),
              jsx.jsx("div", { className: "weir-da-choices", children: question.options.map((option, index) => {
                const value = typeof option?.label === "string" ? option.label : String(option?.value ?? "");
                const multiple = question.multiSelect === true;
                const selected = Array.isArray(answer.selected) ? answer.selected : [];
                return jsx.jsxs("label", { className: "weir-da-choice", children: [
                  jsx.jsx("input", {
                    type: multiple ? "checkbox" : "radio", name: `weir-da-answer-${question.id}`, value,
                    checked: selected.includes(value), disabled: pending, "data-question-id": question.id,
                    onChange: event => {
                      const nextSelected = multiple
                        ? event.target.checked ? [...selected.filter(item => item !== value), value] : selected.filter(item => item !== value)
                        : [value];
                      update({ ...answers, [question.id]: { selected: nextSelected } });
                    },
                  }, "input"),
                  jsx.jsxs("span", { className: "weir-da-choice-copy", children: [
                    jsx.jsx("span", { children: value }, "label"),
                    option?.description ? jsx.jsx("span", { className: "weir-da-choice-description", children: option.description }, "description") : null,
                  ] }, "copy"),
                ] }, `${value}:${index}`);
              }) }, "choices"),
            ] }, question.id);
          }),
          jsx.jsxs("div", { className: "weir-da-actions", children: [
            Array.isArray(props.suggestions) && props.suggestions.length > 0 ? jsx.jsx(Button, { variant: "secondary", disabled: pending, onClick: fillSuggestions, children: t("decisionUseSuggestions") }, "suggestions") : null,
            jsx.jsx(Button, { type: "submit", variant: "primary", disabled: !complete || pending, "aria-describedby": !complete ? incompleteId : undefined, children: pending ? t("decisionSaving") : t("decisionDecide") }, "submit"),
          ] }, "actions"),
          !complete ? jsx.jsx("div", { id: incompleteId, role: "alert", className: "weir-da-caption", children: t("decisionAnswersIncomplete") }, "incomplete") : null,
        ],
      });
    }

    exports.DECISION_UI_CSS = DECISION_UI_CSS;
    exports.DecisionStyles = DecisionStyles;
    exports.DecisionIcon = DecisionIcon;
    exports.Button = Button;
    exports.Badge = Badge;
    exports.Field = Field;
    exports.LoadingState = LoadingState;
    exports.EmptyState = EmptyState;
    exports.ErrorState = ErrorState;
    exports.Disclosure = Disclosure;
    exports.ConfirmDialog = ConfirmDialog;
    exports.DecisionAnswers = DecisionAnswers;
    return module.exports;
  },
});
