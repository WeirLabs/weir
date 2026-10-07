window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.disabled-categories-editor.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// Disabled-categories toggle editor. The delegate category set is a
		// CLOSED registry, so the value is edited as one switch per category —
		// never as hand-typed JSON. The rows (the settings-page chunk's
		// parity-pinned CATEGORY_NAMES) and `t` arrive via props. Row labels
		// reuse the chainCategory_<name> dictionary entries. Style constants
		// are verbatim copies of the settings-page constants this editor uses
		// (same-package sync require is impossible in the ModuleLoader).
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 0" };
		const labelGroupStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 };
		const labelStyle = { fontSize: "14px", fontWeight: 500, lineHeight: "20px" };
		const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const controlsStyle = { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 };
		const resetStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", textDecoration: "underline", color: "var(--dsw-alias-label-secondary)" };
		const chainPanelStyle = { display: "flex", flexDirection: "column", gap: "12px", padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)", marginTop: "8px" };
		const chainCategoryStyle = { fontSize: "13px", fontWeight: 600, lineHeight: "18px" };
		const chainDescStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const chainRungStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" };
		const chainButtonStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline" };
		const chainSaveStyle = { background: "var(--dsw-alias-state-business-primary)", border: "none", cursor: "pointer", color: "#fff", borderRadius: "var(--dsw-radius-sm)", padding: "4px 14px", fontSize: "13px" };
		/** Open-state decision for the toggle editor: blank (unset at every
		 * layer) and malformed stored values both open with EVERY switch off —
		 * no stored state may strand the field uneditable; `invalid`
		 * distinguishes malformed (show the hint) from merely unset (no hint).
		 * Names outside the closed row set are dropped from the selection:
		 * unknown names are no longer reachable through this control. */
		function openState(text, rows) {
			const blank = typeof text !== "string" || text.trim() === "";
			let parsed = null;
			if (!blank) {
				try {
					const value = JSON.parse(text);
					if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) parsed = value;
				} catch {
					parsed = null;
				}
			}
			const known = new Set(rows);
			return {
				selected: [...new Set((parsed ?? []).filter((name) => known.has(name)))],
				invalid: !blank && parsed === null,
				parsed
			};
		}
		/** Synthesize the stored JSON from the staged selection, in row order. */
		function selectionToJson(rows, staged) {
			return JSON.stringify(rows.filter((row) => (staged ?? []).includes(row)));
		}
		/** Visual editor for delegateDisabledCategories: one switch per category, JSON array synthesized on save. */
		function DisabledCategoriesEditorField(props) {
			const rows = props.rows;
			const field = props.field ?? "delegateDisabledCategories";
			const [open, setOpen] = react.useState(false);
			const [staged, setStaged] = react.useState(null);
			const state = openState(props.text, rows);
			const openEditor = () => {
				setStaged(state.selected);
				setOpen(true);
			};
			const save = () => {
				props.edit(field, selectionToJson(rows, staged));
				setOpen(false);
				setStaged(null);
			};
			const cancel = () => {
				setOpen(false);
				setStaged(null);
			};
			const toggle = (row, checked) => setStaged((current) => {
				const next = (current ?? []).filter((name) => name !== row);
				if (checked) next.push(row);
				return next;
			});
			return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
				react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
					react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: props.t(field) }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t(`${field}Hint`) })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
						react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
							state.parsed !== null ? react_jsx_runtime.jsx("span", { style: hintStyle, children: `${state.selected.length} ${props.t("disabledCategoriesCount")}` }) : null,
							react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: openEditor, children: props.t("chainEdit") })
						] }),
						state.invalid ? react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t("disabledCategoriesInvalid") }) : null,
						props.overridden ? react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
							react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: props.t("overridden") }),
							react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: props.onReset, children: props.t("reset") })
						] }) : null
					] })
				] }),
				open && staged !== null ? react_jsx_runtime.jsxs("div", { style: chainPanelStyle, children: [
					react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t("disabledCategoriesPanelHint") }),
					...rows.map((row) => react_jsx_runtime.jsxs("div", { style: chainRungStyle, key: row, children: [
						react_jsx_runtime.jsxs("div", { children: [
							react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: props.t(`chainCategory_${row}`) }),
							" ",
							react_jsx_runtime.jsx("span", { style: chainDescStyle, children: props.t(`chainCategory_${row}_desc`) })
						] }),
						react_jsx_runtime.jsx(primitives.Switch, {
							checked: (staged ?? []).includes(row),
							onChange: (checked) => toggle(row, checked),
							disabled: props.disabled,
							label: props.t(`chainCategory_${row}`)
						})
					] })),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", justifyContent: "flex-end", gap: "12px" }, children: [
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: cancel, children: props.t("chainCancel") }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainSaveStyle, disabled: props.disabled, onClick: save, children: props.t("chainSave") })
					] })
				] }) : null
			] });
		}
		exports.DisabledCategoriesEditorField = DisabledCategoriesEditorField;
		return module.exports;
	}
});
