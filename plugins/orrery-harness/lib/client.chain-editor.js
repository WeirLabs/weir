window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.chain-editor.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let modelPicker = require("orrery-model-picker");
		// Category model-chains editor. The chain model trio
		// (client.chain-model.js) and `t` arrive via props. Style constants are
		// verbatim copies of the settings-page constants this editor uses
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
		/** Visual editor for the category model chains: pick models per lane, JSON synthesized on save. */
		function ChainEditorField(props) {
			const model = props.model;
			const [open, setOpen] = react.useState(false);
			const [staged, setStaged] = react.useState(null);
			const openEditor = () => {
				setStaged(model.jsonToChains(props.text));
				setOpen(true);
			};
			const save = () => {
				props.edit("delegateCategoryChains", model.chainsToJson(staged));
				setOpen(false);
				setStaged(null);
			};
			const cancel = () => {
				setOpen(false);
				setStaged(null);
			};
			const updateRung = (category, index, rung) => setStaged((current) => ({
				...current,
				[category]: (current?.[category] ?? []).map((entry, at) => at === index ? { ...entry, ...rung } : entry)
			}));
			const addRung = (category) => setStaged((current) => ({
				...current,
				[category]: [...(current?.[category] ?? []), { provider: "", model: "", reasoningEffort: "" }]
			}));
			const removeRung = (category, index) => setStaged((current) => ({
				...current,
				[category]: (current?.[category] ?? []).filter((entry, at) => at !== index)
			}));
			const clearCategory = (category) => setStaged((current) => ({ ...current, [category]: [] }));
			return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
				react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
					react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: props.t("delegateCategoryChains") }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t("delegateCategoryChainsHint") })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: openEditor, children: props.t("chainEdit") }),
						props.overridden ? react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
							react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: props.t("overridden") }),
							react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: props.onReset, children: props.t("reset") })
						] }) : null
					] })
				] }),
				open && staged !== null ? react_jsx_runtime.jsxs("div", { style: chainPanelStyle, children: [
					react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t("chainPanelHint") }),
					...model.CHAIN_CATEGORIES.map((category) => {
						const rungs = staged[category] ?? [];
						return react_jsx_runtime.jsxs("div", { key: category, children: [
							react_jsx_runtime.jsxs("div", { children: [
								react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: props.t(`chainCategory_${category}`) }),
								" ",
								react_jsx_runtime.jsx("span", { style: chainDescStyle, children: props.t(`chainCategory_${category}_desc`) })
							] }),
							...rungs.map((rung, index) => react_jsx_runtime.jsxs("div", { style: chainRungStyle, key: index, children: [
								react_jsx_runtime.jsx(modelPicker.ModelPickerField, {
									value: rung,
									onChange: (selection) => updateRung(category, index, selection),
									getSession: () => props.getSession(),
									t: props.t,
									disabled: props.disabled
								}),
								react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => removeRung(category, index), children: props.t("chainRemove") })
							] })),
							react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "12px" }, children: [
								react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => addRung(category), children: `+ ${props.t("chainAddRung")}` }),
								rungs.length > 0 ? react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => clearCategory(category), children: props.t("chainClear") }) : null
							] })
						] });
					}),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", justifyContent: "flex-end", gap: "12px" }, children: [
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: cancel, children: props.t("chainCancel") }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainSaveStyle, disabled: props.disabled, onClick: save, children: props.t("chainSave") })
					] })
				] }) : null
			] });
		}
		exports.ChainEditorField = ChainEditorField;
		return module.exports;
	}
});
