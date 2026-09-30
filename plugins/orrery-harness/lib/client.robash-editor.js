window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.robash-editor.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// Robash whitelist list editor. The robash model trio
		// (client.robash-model.js) and `t` arrive via props. Style constants
		// are verbatim copies of the settings-page constants this editor uses
		// (same-package sync require is impossible in the ModuleLoader).
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 0" };
		const labelGroupStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 };
		const labelStyle = { fontSize: "14px", fontWeight: 500, lineHeight: "20px" };
		const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const controlsStyle = { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 };
		const resetStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", textDecoration: "underline", color: "var(--dsw-alias-label-secondary)" };
		const chainPanelStyle = { display: "flex", flexDirection: "column", gap: "12px", padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)", marginTop: "8px" };
		const chainRungStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" };
		const chainButtonStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline" };
		const chainSaveStyle = { background: "var(--dsw-alias-state-business-primary)", border: "none", cursor: "pointer", color: "#fff", borderRadius: "var(--dsw-radius-sm)", padding: "4px 14px", fontSize: "13px" };
		const robashEntryInputStyle = { flex: 1, minWidth: 0, background: "var(--dsw-alias-interactive-bg-solid)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)", padding: "4px 8px", fontSize: "13px" };
		/** Visual editor for one robash whitelist: rows of command names, JSON synthesized on save. */
		function RobashListEditorField(props) {
			const model = props.model;
			const [open, setOpen] = react.useState(false);
			const [staged, setStaged] = react.useState(null);
			const openState = model.robashEditorOpenState(props.text);
			const parsed = openState.parsed;
			const openEditor = () => {
				// Blank (unset) and malformed stored values both open with an empty
				// staged list: no stored state may strand the field uneditable. The
				// invalid hint (openState.invalid) stays visible in that case.
				setStaged(openState.list);
				setOpen(true);
			};
			const save = () => {
				props.edit(props.field, model.stringListToJson(staged ?? []));
				setOpen(false);
				setStaged(null);
			};
			const cancel = () => {
				setOpen(false);
				setStaged(null);
			};
			const updateEntry = (index, value) => setStaged((current) => (current ?? []).map((entry, at) => at === index ? value : entry));
			const addEntry = () => setStaged((current) => [...(current ?? []), ""]);
			const removeEntry = (index) => setStaged((current) => (current ?? []).filter((entry, at) => at !== index));
			return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
				react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
					react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: props.t(props.field) }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t(`${props.field}Hint`) })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
						react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
							parsed !== null ? react_jsx_runtime.jsx("span", { style: hintStyle, children: `${parsed.length} ${props.t("robashListEntries")}` }) : null,
							react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: openEditor, children: props.t("chainEdit") })
						] }),
						openState.invalid ? react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t("robashListInvalid") }) : null,
						props.overridden ? react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
							react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: props.t("overridden") }),
							react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: props.onReset, children: props.t("reset") })
						] }) : null
					] })
				] }),
				open && staged !== null ? react_jsx_runtime.jsxs("div", { style: chainPanelStyle, children: [
					react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t("robashListPanelHint") }),
					...staged.map((entry, index) => react_jsx_runtime.jsxs("div", { style: chainRungStyle, key: index, children: [
						react_jsx_runtime.jsx("input", {
							style: robashEntryInputStyle,
							value: entry,
							disabled: props.disabled,
							placeholder: props.t("robashListEntryPlaceholder"),
							onChange: (event) => updateEntry(index, event.target.value)
						}),
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => removeEntry(index), children: props.t("chainRemove") })
					] })),
					react_jsx_runtime.jsxs("div", { children: [
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: addEntry, children: `+ ${props.t("robashListAdd")}` })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", justifyContent: "flex-end", gap: "12px" }, children: [
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: cancel, children: props.t("chainCancel") }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainSaveStyle, disabled: props.disabled, onClick: save, children: props.t("chainSave") })
					] })
				] }) : null
			] });
		}
		exports.RobashListEditorField = RobashListEditorField;
		return module.exports;
	}
});
