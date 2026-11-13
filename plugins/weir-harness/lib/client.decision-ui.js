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
.weir-da-page, .weir-da-overlay, .weir-da-selector, .weir-ui-scope {
  --weir-font-body-size: var(--dsw-font-s-14-font-size);
  --weir-font-body-line: var(--dsw-font-s-14-line-height);
  --weir-font-caption-size: var(--dsw-font-xs-13-font-size);
  --weir-font-caption-line: var(--dsw-font-xs-13-line-height);
  --weir-font-small-size: var(--dsw-font-xxs-12-font-size);
  --weir-font-small-line: var(--dsw-font-xxs-12-line-height);
  --weir-font-title-size: var(--dsw-font-base-16-font-size);
  --weir-font-title-line: var(--dsw-font-base-16-line-height);
  --weir-font-section-size: var(--dsw-font-m-18-font-size);
  --weir-font-section-line: var(--dsw-font-m-18-line-height);
  --weir-font-page-size: var(--dsw-font-xl-24-font-size);
  --weir-font-page-line: var(--dsw-font-xl-24-line-height);
  --weir-gap-xs: 4px;
  --weir-gap-sm: 8px;
  --weir-gap-md: 12px;
  --weir-gap-lg: 16px;
  --weir-gap-xl: 24px;
}
.weir-da-button, .weir-da-field, .weir-da-card, .weir-da-state, .weir-ui-menu, .weir-da-overlay {
  box-sizing: border-box;
}
.weir-da-button { min-height: 28px; max-width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: var(--weir-gap-xs); padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-button-elevated-fill); color: var(--dsw-alias-label-primary); font: inherit; font-size: var(--weir-font-body-size, 13px); line-height: var(--weir-font-body-line, 18px); font-weight: 500; cursor: pointer; }
.weir-da-button[data-size="md"] { min-height: 36px; padding: 0 14px; border-radius: var(--dsw-radius-md); }
/* The brand fill is near-black in light and near-white in dark, so the label is
   the foreground token (white / near-black), not the always-white on-color. */
.weir-da-button[data-variant="primary"] { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }
.weir-da-button[data-variant="ghost"] { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.weir-da-button[data-variant="danger"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); background: transparent; }
.weir-da-button:disabled { cursor: not-allowed; opacity: .55; }
@media (hover: hover) {
  .weir-da-button:hover:not(:disabled) { background: var(--dsw-alias-button-elevated-fill); }
  .weir-da-button[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
  .weir-da-button[data-variant="ghost"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
  .weir-da-disclosure-trigger:hover, .weir-da-selector-trigger:hover:not(:disabled), .weir-da-selector-option:hover, .weir-da-choice:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.weir-da-button:focus-visible, .weir-da-disclosure-trigger:focus-visible, .weir-da-selector-trigger:focus-visible, .weir-da-page select:focus-visible, .weir-da-page input:focus-visible, .weir-da-page textarea:focus-visible, .weir-ui-menu-item:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.weir-da-field { min-width: 0; display: grid; gap: 6px; color: var(--dsw-alias-label-primary); font-size: var(--weir-font-body-size, 13px); line-height: var(--weir-font-body-line, 18px); }
.weir-da-field-hint, .weir-da-caption { color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); line-height: var(--weir-font-small-line, 16px); overflow-wrap: anywhere; }
.weir-da-field input, .weir-da-field textarea, .weir-da-answer-textarea, .weir-da-select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 32px; padding: 5px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
.weir-da-badge { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 0 6px; min-height: 20px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); line-height: var(--weir-font-small-line, 16px); }
.weir-da-badge[data-variant="success"] { color: var(--dsw-alias-state-success-primary); }
.weir-da-badge[data-variant="warn"] { color: var(--dsw-alias-state-warn-label); }
.weir-da-badge[data-variant="error"] { color: var(--dsw-alias-state-error-primary); }
.weir-da-state { min-width: 0; padding: 12px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-body-size, 13px); line-height: var(--weir-font-body-line, 18px); overflow-wrap: anywhere; }
.weir-da-state[data-variant="error"] { color: var(--dsw-alias-state-error-primary); }
/* Dialog and selector surfaces use the menu material: the overlay fill is a mid
   grey in dark mode, which made the panel read as a light sheet. */
.weir-da-overlay { min-width: 0; border: 0; border-radius: var(--dsw-radius-panel); background: var(--dsw-specific-menu); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-panel); }
.weir-da-answers { min-width: 0; display: grid; gap: 14px; margin: 0; padding: 0; }
.weir-da-question { min-width: 0; margin: 0; padding: 0; border: 0; }
.weir-da-question legend { max-width: 100%; padding: 0; color: var(--dsw-alias-label-primary); font-size: var(--weir-font-body-size, 13px); line-height: 19px; font-weight: 600; overflow-wrap: anywhere; }
.weir-da-choices { display: grid; gap: 4px; margin-top: 7px; }
.weir-da-choice { min-width: 0; min-height: 32px; display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: var(--dsw-radius-md); color: var(--dsw-alias-label-primary); cursor: pointer; }
.weir-da-choice input { flex: none; margin: 3px 0 0; }
.weir-da-choice-copy { min-width: 0; display: grid; gap: 2px; overflow-wrap: anywhere; }
.weir-da-choice-description { color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); line-height: var(--weir-font-small-line, 16px); }
.weir-da-actions { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.weir-da-dialog { width: min(440px, calc(100vw - 32px)); max-height: min(600px, calc(100dvh - 32px)); overflow: auto; overscroll-behavior: contain; margin: auto; padding: 20px; }
/* The dialog is a focus container, not an interactive control: its own ring
   would draw a blue frame around the whole panel. */
.weir-da-overlay:focus, .weir-da-overlay:focus-visible { outline: none; }
/* The anchored selector is a popover: it covers the visual viewport for
   outside-click dismissal but must not dim the page. */
.weir-da-dialog::backdrop { background: rgba(0, 0, 0, .32); }
.weir-da-selector-panel::backdrop { background: transparent; }
.weir-da-selector { position: relative; display: inline-flex; min-width: 0; max-width: 100%; }
.weir-da-selector-trigger { box-sizing: border-box; min-width: 0; max-width: 280px; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--weir-font-small-size, 12px); line-height: var(--weir-font-small-line, 16px); cursor: pointer; }
.weir-da-selector-trigger[data-unavailable="true"] { color: var(--dsw-alias-state-warn-label); border-color: var(--dsw-alias-state-warn-primary); }
.weir-da-selector-trigger-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.weir-da-selector-panel { margin: auto; position: fixed; width: min(360px, calc(100vw - 32px)); max-height: min(560px, calc(100dvh - 32px)); overflow: hidden; overscroll-behavior: contain; padding: 0; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
.weir-da-selector-header { min-width: 0; display: grid; gap: 4px; padding: 14px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.weir-da-selector-body { min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px 8px; display: grid; gap: 2px; align-content: start; }
.weir-da-selector-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: var(--weir-font-title-size, 14px); line-height: var(--weir-font-title-line, 20px); font-weight: 600; }
.weir-da-selector-title + .weir-da-caption { margin: 0; }
.weir-da-selector-options { min-width: 0; display: grid; gap: 2px; }
.weir-da-selector-option { min-width: 0; min-height: 36px; display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border: 0; border-radius: var(--dsw-radius-md); color: var(--dsw-alias-label-primary); cursor: pointer; overflow-wrap: anywhere; }
.weir-da-selector-option[data-selected="true"] { background: var(--dsw-alias-bg-layer-3); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-selected); color: var(--dsw-alias-label-primary); }
.weir-da-selector-option[data-selected="true"] > span > span:first-child { font-weight: 600; }
.weir-da-selector-option input { flex: none; margin: 3px 0 0; }
.weir-da-selector-option:has(input:focus-visible) { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.weir-da-selector-option > span { min-width: 0; display: grid; gap: 2px; }
.weir-da-selector-option .weir-da-caption { display: block; }
.weir-da-selector-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px 14px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.weir-da-page { position: relative; box-sizing: border-box; height: 100%; min-height: 0; overflow: auto; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: var(--weir-font-body-size, 13px); line-height: var(--weir-font-body-line, 18px); }
/* The page is a fixed shell: header and navigation keep their place and each
   view owns its scrolling. Sharing one scroller with the master-detail layout
   let the list push the detail pane out of view. */
.weir-da-page-inner { box-sizing: border-box; width: min(100%, 1200px); min-width: 0; margin: 0 auto; padding: 24px; display: flex; flex-direction: column; gap: 24px; height: 100%; }
.weir-da-page-header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.weir-da-page-header h1 { margin: 0; font-size: var(--weir-font-page-size, 24px); line-height: var(--weir-font-page-line, 32px); font-weight: 650; }
.weir-da-page-header p { margin: 4px 0 0; max-width: 68ch; color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-body-size, 13px); line-height: var(--weir-font-body-line, 18px); }
.weir-da-primary-nav { box-sizing: border-box; min-width: 0; max-width: 100%; display: flex; flex-wrap: wrap; gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.weir-da-primary-nav .weir-da-button { min-height: 32px; border-color: transparent; background: transparent; border-radius: var(--dsw-radius-sm); }
.weir-da-primary-nav .weir-da-button[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); }
.weir-da-count { display: inline-flex; min-width: 12px; align-items: center; justify-content: center; margin-inline-start: 6px; color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); line-height: var(--weir-font-small-line, 16px); font-variant-numeric: tabular-nums; }
.weir-da-view { min-width: 0; flex: 1 1 auto; min-height: 0; }
.weir-da-view[data-view="inbox"], .weir-da-view[data-view="metrics"] { display: grid; gap: 12px; align-content: start; overflow-y: auto; overscroll-behavior: contain; }
.weir-da-view[data-view="records"], .weir-da-view[data-view="agents"] { display: flex; flex-direction: column; overflow: hidden; }
.weir-da-card-list { min-width: 0; display: grid; gap: 12px; align-content: start; }
.weir-da-card { min-width: 0; padding: 16px; border-radius: var(--dsw-radius-xl); background: var(--dsw-alias-settings-card-fill); color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.weir-da-card[data-flat="true"] { background: var(--dsw-alias-bg-layer-1); border-radius: var(--dsw-radius-lg); }
.weir-da-conversation-card { position: relative; }
.weir-da-card-header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.weir-da-card-header h2 { margin: 0; font-size: var(--weir-font-title-size, 16px); line-height: var(--weir-font-title-line, 24px); font-weight: 600; }
.weir-da-card-header p, .weir-da-card p { margin: 4px 0 0; line-height: var(--weir-font-body-line, 20px); }
.weir-da-record-answers { display: grid; gap: 10px; }
.weir-da-answer-summary { min-width: 0; display: grid; gap: 4px; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); }
.weir-da-record-detail section { min-width: 0; margin-top: 16px; }
.weir-da-record-detail h3 { margin: 0 0 8px; font-size: var(--weir-font-caption-size, 13px); line-height: var(--weir-font-caption-line, 18px); font-weight: 600; color: var(--dsw-alias-label-secondary); }
.weir-da-evidence-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.weir-da-evidence-list li { padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); white-space: pre-wrap; }
.weir-da-records-layout { min-width: 0; display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); gap: 16px; align-items: stretch; flex: 1 1 auto; min-height: 0; }
/* The two panes scroll independently; the page itself must not scroll. */
.weir-da-record-list, .weir-da-record-detail-pane { min-width: 0; display: grid; gap: 4px; align-content: start; overflow-y: auto; overscroll-behavior: contain; }
.weir-da-record-detail-pane { padding-right: 4px; }
.weir-da-record-row.weir-da-button { width: 100%; height: auto; min-height: 64px; display: grid; justify-items: start; gap: 4px; padding: 12px; border-color: transparent; text-align: start; white-space: normal; overflow-wrap: anywhere; }
.weir-da-record-row[aria-pressed="true"] { background: var(--dsw-alias-bg-layer-2); }
.weir-da-record-row span { color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); }
.weir-da-record-back { display: none; }
@media (max-width: 760px) {
  .weir-da-page-inner { padding: 16px; gap: 16px; }
  .weir-da-records-layout { grid-template-columns: minmax(0, 1fr); }
  .weir-da-records-layout[data-drill-in="true"] .weir-da-record-list { display: none; }
  .weir-da-records-layout[data-drill-in="false"] .weir-da-record-detail-pane { display: none; }
  .weir-da-record-back { display: inline-flex; }
}
.weir-da-disclosure-trigger { box-sizing: border-box; width: 100%; min-height: 32px; padding: 6px 8px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: var(--weir-font-body-size, 13px); text-align: start; cursor: pointer; }
.weir-da-disclosure { min-width: 0; }
.weir-da-disclosure [role="region"] { min-width: 0; padding-top: 10px; }
.weir-da-suggestion-review, .weir-da-feedback-editor, .weir-da-agent-editor, .weir-da-agent-advanced, .weir-da-agent-diagnostics, .weir-da-advanced-record { min-width: 0; display: grid; gap: 10px; }
.weir-da-suggestion-review { margin: 12px 0; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); }
.weir-da-suggestion-review ul, .weir-da-memory-summary { margin: 6px 0 0; padding-inline-start: 20px; }
.weir-da-filters { min-width: 0; display: grid; gap: 12px; }
.weir-da-records-view, .weir-da-agents-view { min-width: 0; display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; min-height: 0; }
.weir-da-filter-row { min-width: 0; display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.weir-da-filter { min-width: 0; flex: 1 1 160px; display: grid; gap: 5px; color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); }
.weir-da-filter input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 32px; padding: 5px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
.weir-da-section-header { min-width: 0; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.weir-da-section-header h2, .weir-da-metrics h2 { margin: 0; font-size: var(--weir-font-section-size, 16px); line-height: var(--weir-font-section-line, 24px); font-weight: 600; }
.weir-da-agents-layout { min-width: 0; display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 16px; align-items: stretch; flex: 1 1 auto; min-height: 0; }
.weir-da-agent-list, .weir-da-agent-detail-pane { min-width: 0; display: grid; gap: 4px; align-content: start; overflow-y: auto; overscroll-behavior: contain; }
.weir-da-agent-detail-pane { padding-right: 4px; }
.weir-da-agent-summary { display: grid; gap: 8px; padding: 12px; }
.weir-da-agent-summary .weir-da-card-header { margin-bottom: 0; }
.weir-da-agent-summary-preference { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.weir-da-agent-summary[data-selected="true"] { background: var(--dsw-alias-bg-layer-3); }
.weir-da-agent-summary .weir-da-button { justify-self: start; }
.weir-da-agent-back { display: none; }
@media (max-width: 760px) {
  .weir-da-agents-layout { grid-template-columns: minmax(0, 1fr); }
  .weir-da-agents-layout[data-agent-drill-in="true"] .weir-da-agent-list { display: none; }
  .weir-da-agents-layout[data-agent-drill-in="false"] .weir-da-agent-detail-pane { display: none; }
  .weir-da-agent-back { display: inline-flex; }
}
.weir-da-agent-editor .weir-da-field textarea, .weir-da-agent-advanced textarea { resize: vertical; max-height: 40vh; overflow: auto; overflow-wrap: normal; }
.weir-da-correction-preview { padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); }
.weir-da-evaluation { min-width: 0; display: grid; gap: 8px; padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.weir-da-learning { min-width: 0; display: grid; gap: 12px; padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.weir-da-learning > p { margin: 0; }
.weir-da-learning .weir-da-section-header h3 { margin: 0; font-size: var(--weir-font-caption-size, 14px); line-height: var(--weir-font-caption-line, 20px); }
.weir-da-candidate-review { min-width: 0; display: grid; gap: 12px; padding: 14px; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); }
.weir-da-principle-changes, .weir-da-principle-changes > section, .weir-da-learning-sources, .weir-da-learning-diagnostics, .weir-da-learning-diagnostics > section { min-width: 0; display: grid; gap: 8px; }
.weir-da-principle-changes h4, .weir-da-learning-sources h4, .weir-da-learning-diagnostics h4 { margin: 0; font-size: var(--weir-font-caption-size, 13px); line-height: var(--weir-font-caption-line, 18px); font-weight: 600; color: var(--dsw-alias-label-secondary); }
.weir-da-principle-changes ul, .weir-da-learning-sources ul, .weir-da-learning-diagnostics ul { min-width: 0; display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.weir-da-principle-changes li, .weir-da-learning-sources li { min-width: 0; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.weir-da-principle-changes li > div + div { margin-top: 8px; padding-top: 8px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.weir-da-principle-changes li p { margin: 4px 0 0; white-space: pre-wrap; }
.weir-da-source-excerpt { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.weir-da-learning-diagnostics ul { max-height: 240px; overflow: auto; overscroll-behavior: contain; }
.weir-da-learning-diagnostics .weir-da-button { width: 100%; height: auto; white-space: normal; text-align: start; overflow-wrap: anywhere; }
.weir-da-metrics { display: grid; gap: 16px; }
.weir-da-metrics section { min-width: 0; }
.weir-da-metrics h3 { margin: 0 0 8px; font-size: var(--weir-font-caption-size, 13px); }
.weir-da-metrics-grid { min-width: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); gap: 8px; margin: 0; }
.weir-da-metric { min-width: 0; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); }
.weir-da-metric dt { color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); }
.weir-da-metric dd { margin: 4px 0 0; color: var(--dsw-alias-label-primary); font-size: var(--weir-font-section-size, 18px); font-weight: 600; overflow-wrap: anywhere; }
.weir-da-routing-review, .weir-da-routing-content, .weir-da-routing-list { min-width: 0; display: grid; gap: 12px; }
.weir-da-routing-review { padding-top: 16px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.weir-da-routing-review > p { margin: 0; }
.weir-da-routing-item { min-width: 0; display: grid; justify-items: start; gap: 6px; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.weir-da-routing-item p { margin: 0; }
.weir-da-routing-item time { color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); }
.weir-da-route-history { min-width: 0; display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.weir-da-route-history li { min-width: 0; display: grid; gap: 4px; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); overflow-wrap: anywhere; }
.weir-da-route-history time { color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-small-size, 12px); }
.weir-da-advanced-record pre, .weir-da-agent-diagnostics pre, .weir-da-metrics pre, .weir-da-learning-diagnostics pre { box-sizing: border-box; max-width: 100%; max-height: 420px; margin: 0; overflow: auto; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-base); font-family: var(--dsw-font-mono); font-size: var(--weir-font-small-size, 12px); line-height: var(--weir-font-small-line, 16px); }
.weir-da-agent-diagnostics button { max-width: 100%; overflow-wrap: anywhere; }
@media (max-width: 400px) { .weir-da-page-inner { padding: 52px 12px 12px; } }
@media (max-width: 600px) {
  .weir-da-button { min-height: 36px; }
  .weir-da-actions { align-items: stretch; }
  .weir-da-actions .weir-da-button { flex: 1 1 auto; }
}
.weir-da-page[data-visual-viewport="compact"] .weir-da-page-inner { padding: 12px; gap: 16px; }
.weir-da-page[data-visual-viewport="compact"] .weir-da-records-layout, .weir-da-page[data-visual-viewport="compact"] .weir-da-agents-layout { grid-template-columns: minmax(0, 1fr); }
.weir-da-page[data-visual-viewport="compact"] .weir-da-records-layout[data-drill-in="true"] .weir-da-record-list, .weir-da-page[data-visual-viewport="compact"] .weir-da-agents-layout[data-agent-drill-in="true"] .weir-da-agent-list { display: none; }
.weir-da-page[data-visual-viewport="compact"] .weir-da-records-layout[data-drill-in="false"] .weir-da-record-detail-pane, .weir-da-page[data-visual-viewport="compact"] .weir-da-agents-layout[data-agent-drill-in="false"] .weir-da-agent-detail-pane { display: none; }
.weir-da-page[data-visual-viewport="compact"] .weir-da-record-back, .weir-da-page[data-visual-viewport="compact"] .weir-da-agent-back { display: inline-flex; }
.weir-da-page[data-visual-viewport="compact"] .weir-da-button { min-height: 36px; }
.weir-da-page[data-visual-viewport="compact"] .weir-da-actions { align-items: stretch; }
.weir-da-page[data-visual-viewport="compact"] .weir-da-actions .weir-da-button { flex: 1 1 auto; }
.weir-ui-menu { min-width: 200px; max-width: min(360px, calc(100vw - 16px)); display: grid; gap: 0; padding: 4px; border: 0; border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu); box-shadow: var(--dsw-elevation-panel); color: var(--dsw-alias-label-primary); font-size: var(--weir-font-body-size, 13px); line-height: var(--weir-font-body-line, 18px); }
.weir-ui-menu-item { min-width: 0; min-height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; text-align: start; cursor: pointer; overflow-wrap: anywhere; }
.weir-ui-menu-item[data-selected="true"] { background: var(--dsw-alias-bg-layer-3); }
.weir-ui-menu-item[aria-disabled="true"] { color: var(--dsw-alias-label-tertiary); cursor: not-allowed; }
@media (hover: hover) { .weir-ui-menu-item:hover:not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-hover); } }
.weir-ui-menu-separator { height: 0; margin: 4px 0; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.weir-ui-section { min-width: 0; display: grid; gap: 12px; }
.weir-ui-section-header { min-width: 0; display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.weir-ui-section-header h2 { margin: 0; font-size: var(--weir-font-section-size, 18px); line-height: var(--weir-font-section-line, 26px); font-weight: 600; }
.weir-ui-section-header p { margin: 2px 0 0; max-width: 68ch; color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-caption-size, 13px); line-height: var(--weir-font-caption-line, 18px); }
.weir-ui-row { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.weir-ui-row-main { min-width: 0; display: grid; gap: 2px; }
.weir-ui-row-main strong { font-size: var(--weir-font-body-size, 13px); line-height: var(--weir-font-body-line, 18px); font-weight: 600; }
.weir-ui-row-actions { flex: none; display: flex; align-items: center; gap: 8px; }
.weir-ui-truncate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.weir-ui-clamp-2 { min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.weir-ui-notice { min-width: 0; display: flex; align-items: flex-start; gap: 8px; padding: 12px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: var(--weir-font-caption-size, 13px); line-height: var(--weir-font-caption-line, 18px); overflow-wrap: anywhere; }
.weir-ui-notice[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); }
.weir-ui-notice[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.weir-ui-skeleton { min-height: 12px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-skeleton); }
.weir-ui-tabs { display: inline-flex; gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); }
.weir-ui-tabs button { min-height: 28px; padding: 0 10px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; }
.weir-ui-tabs button[aria-selected="true"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); }
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
        "data-size": props.size ?? "sm",
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
      const contentRef = react.useRef(null);
      const revealTokenRef = react.useRef(0);
      const revealedRef = react.useRef(false);
      const revealFrameRef = react.useRef(null);
      const cancelReveal = () => {
        const frame = revealFrameRef.current;
        revealFrameRef.current = null;
        if (frame !== null) globalThis.cancelAnimationFrame?.(frame);
      };
      react.useEffect(() => {
        const token = ++revealTokenRef.current;
        revealedRef.current = false;
        cancelReveal();
        return () => {
          if (revealTokenRef.current === token) revealTokenRef.current += 1;
          cancelReveal();
        };
      }, [open]);
      react.useEffect(() => {
        if (!open || props.revealOnOpen !== "end" || props.revealReady === false || revealedRef.current || revealFrameRef.current !== null) return undefined;
        if (typeof globalThis.requestAnimationFrame !== "function") return undefined;
        const token = revealTokenRef.current;
        revealFrameRef.current = globalThis.requestAnimationFrame(() => {
          revealFrameRef.current = null;
          if (token !== revealTokenRef.current || !open || revealedRef.current) return;
          const target = contentRef.current;
          if (typeof target?.scrollIntoView !== "function") return;
          revealedRef.current = true;
          target.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" });
        });
        return cancelReveal;
      }, [open, props.revealOnOpen, props.revealReady]);
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
        open ? jsx.jsx("div", { ref: contentRef, id: `${id}-content`, role: "region", "aria-label": props.label, children: typeof props.children === "function" ? props.children() : props.children }, "content") : null,
      ] });
    }

    const decisionScrollLocks = new WeakMap();
    const DECISION_SCROLL_STYLES = ["overflow", "overflowX", "overflowY", "overscrollBehavior", "overscrollBehaviorX", "overscrollBehaviorY", "paddingRight", "paddingBottom", "overflowAnchor"];

    function acquireDecisionScrollLock(hostDocument, originElement, openModal) {
      if (!hostDocument || typeof hostDocument !== "object") { openModal(); return () => {}; }
      const view = hostDocument.defaultView ?? null;
      const root = hostDocument.documentElement ?? null;
      const body = hostDocument.body ?? null;
      const targets = [];
      const add = target => { if (target && !targets.includes(target)) targets.push(target); };
      add(view); add(root); add(body);
      for (const page of hostDocument.querySelectorAll?.(".weir-da-page") ?? []) add(page);
      let current = focusTarget(originElement);
      while (current && current !== hostDocument) {
        const computed = view?.getComputedStyle?.(current) ?? current.computed;
        const overflowY = computed?.overflowY ?? current.style?.overflowY ?? current.style?.overflow;
        if (["auto", "scroll", "overlay"].includes(overflowY)) add(current);
        current = current.parentElement ?? null;
      }
      const preOpen = new Map(targets.map(target => [target, target === view
        ? { window: true, scrollX: target.scrollX, scrollY: target.scrollY }
        : { scrollTop: target.scrollTop, scrollLeft: target.scrollLeft }]));
      // Native showModal() can clamp fractional offsets; only mutate after it succeeds.
      openModal();
      let state = decisionScrollLocks.get(hostDocument);
      if (!state) {
        state = { count: 0, snapshots: new Map() };
        decisionScrollLocks.set(hostDocument, state);
      }
      for (const target of targets) {
        if (state.snapshots.has(target)) continue;
        if (target === view) {
          state.snapshots.set(target, { target, ...preOpen.get(target) });
          continue;
        }
        const style = target.style;
        if (!style) continue;
        const inline = Object.fromEntries(DECISION_SCROLL_STYLES.map(name => [name, style[name] ?? ""]));
        state.snapshots.set(target, { target, inline, ...preOpen.get(target) });
        const computed = view?.getComputedStyle?.(target) ?? target.computed;
        const scrollbarWidth = target === root
          ? Math.max(0, (view?.innerWidth ?? 0) - (root.clientWidth ?? 0))
          : Math.max(0, (target.offsetWidth ?? 0) - (target.clientWidth ?? 0));
        const scrollbarHeight = target === root
          ? Math.max(0, (view?.innerHeight ?? 0) - (root.clientHeight ?? 0))
          : Math.max(0, (target.offsetHeight ?? 0) - (target.clientHeight ?? 0));
        if (scrollbarWidth > 0) {
          const padding = Number.parseFloat(computed?.paddingRight ?? "0") || 0;
          style.paddingRight = `${padding + scrollbarWidth}px`;
        }
        if (scrollbarHeight > 0) {
          const padding = Number.parseFloat(computed?.paddingBottom ?? "0") || 0;
          style.paddingBottom = `${padding + scrollbarHeight}px`;
        }
        style.overflow = "hidden";
        style.overflowX = "hidden";
        style.overflowY = "hidden";
        style.overscrollBehavior = "none";
        style.overscrollBehaviorX = "none";
        style.overscrollBehaviorY = "none";
        style.overflowAnchor = "none";
      }
      for (const [target, position] of preOpen) {
        if (position.window) {
          if (target.scrollX === position.scrollX && target.scrollY === position.scrollY) continue;
          if (typeof target.scrollTo === "function") target.scrollTo(position.scrollX, position.scrollY);
          else { target.scrollX = position.scrollX; target.scrollY = position.scrollY; }
        } else {
          target.scrollTop = position.scrollTop;
          target.scrollLeft = position.scrollLeft;
        }
      }
      for (const snapshot of state.snapshots.values()) {
        if (snapshot.onScroll) continue;
        const target = snapshot.target;
        const onScroll = () => {
          if (snapshot.window) {
            if (target.scrollX === snapshot.scrollX && target.scrollY === snapshot.scrollY) return;
            if (typeof target.scrollTo === "function") target.scrollTo(snapshot.scrollX, snapshot.scrollY);
            else { target.scrollX = snapshot.scrollX; target.scrollY = snapshot.scrollY; }
          } else {
            if (target.scrollTop !== snapshot.scrollTop) target.scrollTop = snapshot.scrollTop;
            if (target.scrollLeft !== snapshot.scrollLeft) target.scrollLeft = snapshot.scrollLeft;
          }
        };
        snapshot.onScroll = onScroll;
        target.addEventListener?.("scroll", onScroll);
      }
      state.count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (decisionScrollLocks.get(hostDocument) !== state) return;
        state.count -= 1;
        if (state.count > 0) return;
        for (const snapshot of [...state.snapshots.values()].reverse()) {
          const target = snapshot.target;
          if (snapshot.onScroll) { target.removeEventListener?.("scroll", snapshot.onScroll); snapshot.onScroll = null; }
          if (snapshot.window) {
            if (typeof target.scrollTo === "function") target.scrollTo(snapshot.scrollX, snapshot.scrollY);
            else { target.scrollX = snapshot.scrollX; target.scrollY = snapshot.scrollY; }
            continue;
          }
          for (const name of DECISION_SCROLL_STYLES) target.style[name] = snapshot.inline[name];
          target.scrollTop = snapshot.scrollTop;
          target.scrollLeft = snapshot.scrollLeft;
        }
        decisionScrollLocks.delete(hostDocument);
      };
    }

    function focusTarget(value) {
      const resolved = typeof value === "function" ? value() : value;
      return resolved && typeof resolved === "object" && "current" in resolved ? resolved.current : resolved;
    }

    function canRestoreFocus(target) {
      if (!target || target.isConnected === false || target.disabled === true || target.hidden === true) return false;
      if (target.getAttribute?.("aria-hidden") === "true") return false;
      if (typeof target.getClientRects === "function" && target.getClientRects().length === 0) return false;
      return typeof target.focus === "function";
    }

    // Returning focus must never move the page: `focus()` scrolls the nearest
    // scrollable ancestor into view, and after a confirmed action the origin may
    // be gone (fallback = the page navigation at the top). Preserve every
    // Decision scroller the focus return could touch — the `.weir-da-page`
    // document scroller, the destination's overflow ancestors and the window —
    // across the focus call so a shrunk content region keeps its clamped
    // position instead of jumping to 0.
    function decisionFocusScrollers(hostDocument, destination) {
      const view = hostDocument?.defaultView ?? null;
      const scrollers = [];
      const add = target => { if (target && !scrollers.includes(target)) scrollers.push(target); };
      for (const page of hostDocument?.querySelectorAll?.(".weir-da-page") ?? []) add(page);
      let current = destination?.parentElement ?? null;
      while (current && current !== hostDocument) {
        const computed = view?.getComputedStyle?.(current) ?? current.computed;
        const overflowY = computed?.overflowY ?? current.style?.overflowY ?? current.style?.overflow;
        if (["auto", "scroll", "overlay"].includes(overflowY)) add(current);
        current = current.parentElement ?? null;
      }
      return { view, scrollers };
    }

    function focusWithoutScroll(destination) {
      const hostDocument = destination?.ownerDocument ?? globalThis.document ?? null;
      const { view, scrollers } = decisionFocusScrollers(hostDocument, destination);
      const positions = scrollers.map(target => ({ target, scrollTop: target.scrollTop, scrollLeft: target.scrollLeft }));
      const windowPosition = view && Number.isFinite(view.scrollX) && Number.isFinite(view.scrollY)
        ? { scrollX: view.scrollX, scrollY: view.scrollY }
        : null;
      try { destination.focus({ preventScroll: true }); }
      catch { destination.focus(); }
      for (const position of positions) {
        if (position.target.scrollTop !== position.scrollTop) position.target.scrollTop = position.scrollTop;
        if (position.target.scrollLeft !== position.scrollLeft) position.target.scrollLeft = position.scrollLeft;
      }
      if (windowPosition && (view.scrollX !== windowPosition.scrollX || view.scrollY !== windowPosition.scrollY)) {
        if (typeof view.scrollTo === "function") view.scrollTo(windowPosition.scrollX, windowPosition.scrollY);
        else { view.scrollX = windowPosition.scrollX; view.scrollY = windowPosition.scrollY; }
      }
    }

    function restoreDecisionFocus(target, fallback) {
      const preferred = focusTarget(target);
      const alternate = focusTarget(fallback);
      const destination = canRestoreFocus(preferred) ? preferred : canRestoreFocus(alternate) ? alternate : null;
      if (destination) focusWithoutScroll(destination);
    }

    const DECISION_MODAL_VIEWPORT_STYLES = ["left", "top", "right", "bottom", "margin", "maxWidth", "maxHeight"];

    function containDecisionModalInVisualViewport(dialog, view) {
      const viewport = view?.visualViewport;
      if (!viewport || !dialog?.style) return () => {};
      const inline = Object.fromEntries(DECISION_MODAL_VIEWPORT_STYLES.map(name => [name, dialog.style[name] ?? ""]));
      const restore = () => {
        for (const name of DECISION_MODAL_VIEWPORT_STYLES) dialog.style[name] = inline[name];
      };
      const contain = () => {
        const scale = Number(viewport.scale ?? 1);
        const offsetLeft = Number(viewport.offsetLeft ?? 0);
        const offsetTop = Number(viewport.offsetTop ?? 0);
        const width = Number(viewport.width);
        const height = Number(viewport.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || (scale === 1 && offsetLeft === 0 && offsetTop === 0)) {
          restore();
          return;
        }
        const availableWidth = Math.max(0, width - 16);
        const availableHeight = Math.max(0, Math.min(560, height - 16));
        dialog.style.maxWidth = `${availableWidth}px`;
        dialog.style.maxHeight = `${availableHeight}px`;
        const bounds = dialog.getBoundingClientRect?.();
        if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
        dialog.style.margin = "0px";
        dialog.style.right = "auto";
        dialog.style.bottom = "auto";
        dialog.style.left = `${offsetLeft + Math.max(8, (width - bounds.width) / 2)}px`;
        dialog.style.top = `${offsetTop + Math.max(8, (height - bounds.height) / 2)}px`;
      };
      viewport.addEventListener?.("resize", contain);
      viewport.addEventListener?.("scroll", contain);
      contain();
      return () => {
        viewport.removeEventListener?.("resize", contain);
        viewport.removeEventListener?.("scroll", contain);
        restore();
      };
    }


    // Anchor a modal dialog to its trigger (composer selector): still a native
    // dialog with modal semantics, focus trap and scroll lock, but placed above
    // the trigger like the host's own selectors instead of centred.
    function anchorDecisionDialog(dialog, anchor, options = {}) {
      if (!dialog || !anchor || typeof anchor.getBoundingClientRect !== "function") return () => {};
      const hostDocument = dialog.ownerDocument ?? null;
      const view = hostDocument?.defaultView ?? null;
      const gap = options.gap ?? 8;
      const margin = options.margin ?? 8;
      const viewport = view?.visualViewport ?? null;
      const place = () => {
        const rect = anchor.getBoundingClientRect?.();
        if (!rect) return;
        const left = viewport?.offsetLeft ?? 0;
        const top = viewport?.offsetTop ?? 0;
        const width = viewport?.width ?? view?.innerWidth ?? 0;
        const height = viewport?.height ?? view?.innerHeight ?? 0;
        if (!width || !height) return;
        const panelWidth = Math.min(Math.max(rect.width, 320), Math.max(240, width - margin * 2), 360);
        dialog.style.position = "fixed";
        dialog.style.margin = "0";
        dialog.style.width = `${panelWidth}px`;
        const measured = dialog.getBoundingClientRect();
        const spaceAbove = rect.top - top - gap - margin;
        const spaceBelow = top + height - rect.bottom - gap - margin;
        const placeAbove = spaceAbove >= Math.min(measured.height || 0, 240) || spaceAbove >= spaceBelow;
        const available = Math.max(160, placeAbove ? spaceAbove : spaceBelow);
        dialog.style.maxHeight = `${Math.min(560, available)}px`;
        const clampedLeft = Math.max(left + margin, Math.min(rect.left, left + width - margin - panelWidth));
        const panelHeight = Math.min(dialog.getBoundingClientRect().height || 0, Math.min(560, available));
        const positionedTop = placeAbove ? Math.max(top + margin, rect.top - gap - panelHeight) : rect.bottom + gap;
        dialog.style.left = `${clampedLeft}px`;
        dialog.style.top = `${positionedTop}px`;
        dialog.dataset.placement = placeAbove ? "above" : "below";
      };
      place();
      view?.addEventListener?.("resize", place);
      viewport?.addEventListener?.("resize", place);
      viewport?.addEventListener?.("scroll", place);
      const observer = typeof view?.ResizeObserver === "function" ? new view.ResizeObserver(place) : null;
      observer?.observe(dialog);
      return () => {
        view?.removeEventListener?.("resize", place);
        viewport?.removeEventListener?.("resize", place);
        viewport?.removeEventListener?.("scroll", place);
        observer?.disconnect();
      };
    }

    function DecisionModalFrame(props) {
      const internalDialogRef = react.useRef(null);
      const dialogRef = props.dialogRef ?? internalDialogRef;
      const [openError, setOpenError] = react.useState(null);
      const requestClose = reason => {
        if (props.pending !== true) props.onRequestClose?.(reason);
      };
      react.useEffect(() => {
        const hostDocument = globalThis.document;
        const dialog = dialogRef.current;
        const previous = focusTarget(props.returnFocus) ?? hostDocument?.activeElement ?? null;
        if (!dialog || typeof dialog.showModal !== "function") {
          const error = new Error("Native Decision dialog is unavailable");
          setOpenError(error);
          restoreDecisionFocus(previous, props.returnFocusFallback);
          props.onOpenError?.(error);
          return undefined;
        }
        let releaseScrollLock;
        try {
          releaseScrollLock = acquireDecisionScrollLock(
            hostDocument,
            focusTarget(props.scrollOrigin) ?? previous,
            () => dialog.showModal(),
          );
        } catch (reason) {
          const error = reason instanceof Error ? reason : new Error(String(reason));
          setOpenError(error);
          restoreDecisionFocus(previous, props.returnFocusFallback);
          props.onOpenError?.(error);
          return undefined;
        }
        // An anchored dialog clamps itself; the centred containment pass would
        // fight its explicit top/left.
        const releaseViewportContainment = props.anchor ? anchorDecisionDialog(dialog, focusTarget(props.anchor)) : containDecisionModalInVisualViewport(dialog, hostDocument?.defaultView);
        const initial = focusTarget(props.initialFocus) ?? dialog;
        initial?.focus?.();
        return () => {
          dialog.close?.();
          releaseViewportContainment();
          releaseScrollLock();
          const restore = props.shouldRestoreFocus ? props.shouldRestoreFocus() : props.restoreFocus !== false;
          if (restore) restoreDecisionFocus(previous, props.returnFocusFallback);
        };
      }, []);
      if (openError) return jsx.jsxs(ErrorState, { children: [
        jsx.jsx("span", { children: props.openErrorLabel ?? "The dialog could not be opened." }, "message"),
        jsx.jsx(Button, { variant: "secondary", onClick: () => {
          if (props.onDismissError) props.onDismissError(openError);
          else requestClose("open-error");
        }, children: props.dismissLabel ?? "Close" }, "dismiss"),
      ] });
      return jsx.jsx("dialog", {
        ref: dialogRef, id: props.id, className: props.className,
        role: "dialog", "aria-modal": true,
        "aria-labelledby": props["aria-labelledby"], "aria-describedby": props["aria-describedby"],
        "aria-busy": props.pending === true, tabIndex: props.tabIndex,
        onCancel: event => { event.preventDefault?.(); requestClose("escape"); },
        onClick: event => {
          if (!props.closeOnBackdrop || event.target !== dialogRef.current) return;
          const bounds = dialogRef.current?.getBoundingClientRect?.();
          const outside = !bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
          if (outside) requestClose("backdrop");
        },
        onKeyDown: props.onKeyDown,
        children: props.children,
      });
    }

    function ConfirmDialog(props) {
      const internalCancelRef = react.useRef(null);
      const internalConfirmRef = react.useRef(null);
      const cancelRef = props.cancelRef ?? internalCancelRef;
      const confirmRef = props.confirmRef ?? internalConfirmRef;
      const confirmStartedRef = react.useRef(false);
      const focusOriginRef = react.useRef(null);
      if (!focusOriginRef.current) {
        focusOriginRef.current = { target: focusTarget(props.returnFocus) ?? globalThis.document?.activeElement ?? null };
      }
      const returnFocusFallback = props.returnFocusFallback ?? (() => globalThis.document?.querySelector?.('[data-weir-decision-trigger="weir-decision-selector"]'));
      const onCancel = () => { if (!props.pending) props.onCancel?.(); };
      const onConfirm = () => {
        if (props.pending || confirmStartedRef.current) return undefined;
        confirmStartedRef.current = true;
        let result;
        try { result = props.onConfirm?.(); }
        catch (error) {
          restoreDecisionFocus(focusOriginRef.current.target, returnFocusFallback);
          throw error;
        }
        return Promise.resolve(result).finally(() => {
          const restore = () => restoreDecisionFocus(focusOriginRef.current.target, returnFocusFallback);
          if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(restore);
          else restore();
        });
      };
      const onKeyDown = event => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
          return;
        }
        if (event.key !== "Tab" || !cancelRef.current || !confirmRef.current) return;
        event.preventDefault();
        (event.target === confirmRef.current ? cancelRef : confirmRef).current?.focus?.();
      };
      return jsx.jsx(DecisionModalFrame, {
        id: props.id, className: "weir-da-overlay weir-da-dialog",
        "aria-labelledby": `${props.id}-title`, "aria-describedby": `${props.id}-body`,
        pending: props.pending === true, onKeyDown, onRequestClose: onCancel,
        initialFocus: cancelRef, returnFocus: props.returnFocus, returnFocusFallback,
        shouldRestoreFocus: () => !confirmStartedRef.current,
        scrollOrigin: props.scrollOrigin ?? props.returnFocus,
        openErrorLabel: props.openErrorLabel, dismissLabel: props.dismissLabel, onOpenError: props.onOpenError,
        onDismissError: props.onDismissError,
        children: [
          jsx.jsx("h2", { id: `${props.id}-title`, children: props.title }, "title"),
          jsx.jsx("div", { id: `${props.id}-body`, children: props.body }, "body"),
          jsx.jsxs("div", { className: "weir-da-actions", children: [
            jsx.jsx(Button, { ref: cancelRef, variant: "secondary", disabled: props.pending, onClick: onCancel, children: props.cancelLabel }, "cancel"),
            jsx.jsx(Button, { ref: confirmRef, variant: props.danger ? "danger" : "primary", disabled: props.pending, onClick: onConfirm, children: props.confirmLabel }, "confirm"),
          ] }, "actions"),
        ],
      });
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

    function DecisionRouteHistory(props) {
      const t = props.t ?? (key => key);
      const history = Array.isArray(props.history) ? props.history : [];
      if (!history.length) return EmptyState({ children: t("decisionNoRouteHistory") });
      return jsx.jsx("ol", { className: "weir-da-route-history", "aria-label": t("decisionRouteHistory"), children: history.map((item, index) => {
        const date = item?.createdAt ? new Date(item.createdAt) : null;
        const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : item?.createdAt;
        return jsx.jsxs("li", { children: [
          jsx.jsx("strong", { children: `${t(item?.modeKey ?? "decisionRouteModeUnknown")} · ${t(item?.statusKey ?? "decisionStatusUnknown")}` }, "status"),
          item?.choiceName ? jsx.jsx("span", { children: item.choiceName }, "choice") : null,
          item?.mode === "manual_reassign" ? jsx.jsx("span", { className: "weir-da-caption", children: `${t("decisionRoutingDirection")}: ${item.fromName ?? t("decisionNoAssignedAgent")} → ${item.toName ?? t("decisionNoAssignedAgent")}` }, "direction") : null,
          time ? jsx.jsx("time", { dateTime: item.createdAt, children: time }, "time") : null,
        ] }, item?.routeDecisionId ?? index);
      }) });
    }


    // ---- Shared surfaces -----------------------------------------------------
    // Every page renders through these primitives so spacing, radius, elevation
    // and typography stay identical across features (see ui-design-system).

    function PageHeader(props) {
      return jsx.jsxs("header", { className: "weir-da-page-header", children: [
        jsx.jsxs("div", { children: [
          jsx.jsx("h1", { children: props.title }, "title"),
          props.description ? jsx.jsx("p", { children: props.description }, "description") : null,
        ] }, "titles"),
        props.actions ? jsx.jsx("div", { className: "weir-da-actions", "data-page-actions": true, children: props.actions }, "actions") : null,
      ] });
    }

    function Section(props) {
      const headingId = props.id ? `${props.id}-heading` : undefined;
      return jsx.jsxs("section", { className: "weir-ui-section", "data-section": props.id, "aria-labelledby": headingId, children: [
        props.title ? jsx.jsxs("div", { className: "weir-ui-section-header", children: [
          jsx.jsxs("div", { children: [
            jsx.jsx("h2", { id: headingId, children: props.title }, "title"),
            props.description ? jsx.jsx("p", { children: props.description }, "description") : null,
          ] }, "heading"),
          props.actions ? jsx.jsx("div", { className: "weir-da-actions", children: props.actions }, "actions") : null,
        ] }, "header") : null,
        props.children,
      ] });
    }

    function Row(props) {
      return jsx.jsxs("div", { className: "weir-ui-row", "data-row": props.id, children: [
        jsx.jsxs("div", { className: "weir-ui-row-main", children: [
          props.title ? jsx.jsx("strong", { className: "weir-ui-truncate", children: props.title }, "title") : null,
          props.description ? jsx.jsx("span", { className: "weir-da-caption weir-ui-clamp-2", children: props.description }, "description") : null,
        ] }, "main"),
        props.actions ? jsx.jsx("div", { className: "weir-ui-row-actions", children: props.actions }, "actions") : null,
      ] });
    }

    function Notice(props) {
      const tone = props.tone ?? "neutral";
      return jsx.jsx("div", { className: "weir-ui-notice", "data-tone": tone, role: tone === "error" ? "alert" : "status", children: props.children });
    }

    function Skeleton(props) {
      return jsx.jsx("div", { className: "weir-ui-skeleton", "aria-hidden": "true", style: { height: `${props.height ?? 12}px`, width: props.width ?? "100%" } });
    }

    function Tabs(props) {
      const tabs = Array.isArray(props.tabs) ? props.tabs : [];
      return jsx.jsx("div", { className: "weir-ui-tabs", role: "tablist", children: tabs.map(tab => jsx.jsx("button", {
        type: "button", role: "tab", id: tab.id, "aria-selected": tab.id === props.value, "aria-controls": tab.controls,
        onClick: () => props.onChange?.(tab.id), children: tab.label,
      }, tab.id)) });
    }

    // ---- Anchored menu -------------------------------------------------------
    // Shared menu material: R16 outer + 4px padding + R12/H32 items. Placement
    // clamps to the viewport; a vertical flip wins over losing horizontal
    // alignment, matching the official overlay rule.

    function useAnchoredMenuPosition(open, anchorRef, menuRef) {
      const [position, setPosition] = react.useState(null);
      react.useEffect(() => {
        if (!open) { setPosition(null); return undefined; }
        const hostWindow = anchorRef?.current?.ownerDocument?.defaultView ?? globalThis;
        const place = () => {
          const anchor = anchorRef?.current;
          const menu = menuRef?.current;
          if (!anchor || !menu || typeof anchor.getBoundingClientRect !== "function") return;
          const rect = anchor.getBoundingClientRect();
          const viewportWidth = Number(hostWindow?.innerWidth) || 0;
          const viewportHeight = Number(hostWindow?.innerHeight) || 0;
          const margin = 8;
          const gap = 4;
          const menuWidth = menu.offsetWidth || Math.min(280, viewportWidth - margin * 2);
          const menuHeight = menu.offsetHeight || 0;
          let left = rect.left;
          if (left + menuWidth > viewportWidth - margin) left = rect.right - menuWidth;
          left = Math.max(margin, Math.min(left, Math.max(margin, viewportWidth - margin - menuWidth)));
          let top = rect.bottom + gap;
          let maxHeight = Math.max(120, viewportHeight - top - margin);
          if (top + menuHeight > viewportHeight - margin) {
            const above = rect.top - gap - margin;
            if (above >= Math.min(menuHeight, 120)) {
              maxHeight = Math.max(120, above);
              top = Math.max(margin, rect.top - gap - Math.min(menuHeight, maxHeight));
            }
          }
          setPosition({ left, top, maxHeight });
        };
        place();
        hostWindow?.addEventListener?.("resize", place);
        hostWindow?.addEventListener?.("scroll", place, true);
        return () => {
          hostWindow?.removeEventListener?.("resize", place);
          hostWindow?.removeEventListener?.("scroll", place, true);
        };
      }, [open]);
      return position;
    }

    function MenuItem(props) {
      const disabled = props.disabled === true;
      return jsx.jsx("button", {
        type: "button", role: "menuitem", className: "weir-ui-menu-item",
        "data-selected": props.selected === true || undefined,
        "aria-disabled": disabled || undefined, disabled,
        "data-menu-value": props.value,
        onClick: event => { if (disabled) return; props.onSelect?.(event); },
        children: props.children,
      });
    }

    function MenuSeparator() {
      return jsx.jsx("div", { className: "weir-ui-menu-separator", role: "separator" });
    }

    function Menu(props) {
      const menuRef = react.useRef(null);
      const open = props.open === true;
      const position = useAnchoredMenuPosition(open, props.anchorRef, menuRef);
      react.useEffect(() => {
        if (!open) return undefined;
        const menu = menuRef.current;
        if (!menu) return undefined;
        const items = () => Array.from(menu.querySelectorAll?.('[role="menuitem"]:not([disabled])') ?? []);
        items()[0]?.focus?.();
        const onKeyDown = event => {
          const list = items();
          if (!list.length) return;
          const index = list.indexOf(event.target);
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose?.("escape"); }
          else if (event.key === "ArrowDown") { event.preventDefault(); list[(index + 1) % list.length]?.focus?.(); }
          else if (event.key === "ArrowUp") { event.preventDefault(); list[(index - 1 + list.length) % list.length]?.focus?.(); }
          else if (event.key === "Home") { event.preventDefault(); list[0]?.focus?.(); }
          else if (event.key === "End") { event.preventDefault(); list[list.length - 1]?.focus?.(); }
          else if (event.key === "Tab") props.onClose?.("blur");
        };
        const onPointerDown = event => {
          if (menu.contains?.(event.target)) return;
          if (props.anchorRef?.current?.contains?.(event.target)) return;
          props.onClose?.("outside");
        };
        menu.addEventListener("keydown", onKeyDown);
        const hostDocument = menu.ownerDocument ?? globalThis.document;
        hostDocument?.addEventListener?.("pointerdown", onPointerDown, true);
        return () => {
          menu.removeEventListener("keydown", onKeyDown);
          hostDocument?.removeEventListener?.("pointerdown", onPointerDown, true);
        };
      }, [open]);
      if (!open) return null;
      return jsx.jsx("div", {
        ref: menuRef, className: "weir-ui-menu", role: "menu", "aria-label": props.label, tabIndex: -1,
        style: {
          position: "fixed",
          left: `${position?.left ?? 0}px`,
          top: `${position?.top ?? 0}px`,
          maxHeight: `${position?.maxHeight ?? 320}px`,
          overflowY: "auto",
          zIndex: 1200,
          visibility: position ? "visible" : "hidden",
        },
        children: props.children,
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
    exports.DecisionModalFrame = DecisionModalFrame;
    exports.ConfirmDialog = ConfirmDialog;
    exports.DecisionAnswers = DecisionAnswers;
    exports.DecisionRouteHistory = DecisionRouteHistory;
    exports.PageHeader = PageHeader;
    exports.Section = Section;
    exports.Row = Row;
    exports.Notice = Notice;
    exports.Skeleton = Skeleton;
    exports.Tabs = Tabs;
    exports.Menu = Menu;
    exports.MenuItem = MenuItem;
    exports.MenuSeparator = MenuSeparator;
    return module.exports;
  },
});
