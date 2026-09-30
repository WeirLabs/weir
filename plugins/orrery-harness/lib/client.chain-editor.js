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
		// Model-chains editor with the lane list as a PROP: the category lanes
		// are the default (no row props → the pre-generalization category
		// behaviour, byte-identical); the curated-agent lanes pass their own
		// rows, settings field, and dictionary-key stems. The chain model trio
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
		// DERIVED FROM lib/client.chain-model.js (chainsToJson): the same JSON
		// synthesis generalized over a lane (row) parameter so non-category
		// lanes (curated agents) serialize too — the model chunk is a frozen
		// zero-dependency chunk, so the row-parameterized form lives here.
		// Category-lane parity with the model original is pinned behaviourally
		// in test/client-chain-editor.test.js.
		function chainsToJson(rows, chains) {
			const out = {};
			for (const row of rows) {
				const rungs = (chains?.[row] ?? []).filter((rung) => rung.provider && rung.model).map((rung) => ({
					provider: rung.provider,
					model: rung.model,
					...(rung.reasoningEffort ? { reasoningEffort: rung.reasoningEffort } : {})
				}));
				if (rungs.length > 0) out[row] = rungs;
			}
			return JSON.stringify(out, null, 2);
		}
		/** Visual editor for one model-chains map: pick models per lane, JSON synthesized on save. */
		function ChainEditorField(props) {
			const model = props.model;
			// Lane parameterization: which lanes render, which settings field
			// the synthesized JSON is written to, and which dictionary stems
			// label the rows — the defaults are exactly the category treatment.
			const rows = props.rows ?? model.CHAIN_CATEGORIES;
			const field = props.field ?? "delegateCategoryChains";
			const rowLabelPrefix = props.rowLabelPrefix ?? "chainCategory_";
			const panelHintKey = props.panelHintKey ?? "chainPanelHint";
			const [open, setOpen] = react.useState(false);
			const [staged, setStaged] = react.useState(null);
			const openEditor = () => {
				// The model chunk's parser normalizes rungs and carries every
				// stored lane verbatim (unknown keys included); keep only this
				// editor's lanes.
				const parsed = model.jsonToChains(props.text);
				setStaged(Object.fromEntries(rows.map((row) => [row, parsed[row] ?? []])));
				setOpen(true);
			};
			const save = () => {
				props.edit(field, chainsToJson(rows, staged));
				setOpen(false);
				setStaged(null);
			};
			const cancel = () => {
				setOpen(false);
				setStaged(null);
			};
			const updateRung = (row, index, rung) => setStaged((current) => ({
				...current,
				[row]: (current?.[row] ?? []).map((entry, at) => at === index ? { ...entry, ...rung } : entry)
			}));
			const addRung = (row) => setStaged((current) => ({
				...current,
				[row]: [...(current?.[row] ?? []), { provider: "", model: "", reasoningEffort: "" }]
			}));
			const removeRung = (row, index) => setStaged((current) => ({
				...current,
				[row]: (current?.[row] ?? []).filter((entry, at) => at !== index)
			}));
			const clearRow = (row) => setStaged((current) => ({ ...current, [row]: [] }));
			return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
				react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
					react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: props.t(field) }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t(`${field}Hint`) })
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
					react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t(panelHintKey) }),
					...rows.map((row) => {
						const rungs = staged[row] ?? [];
						return react_jsx_runtime.jsxs("div", { key: row, children: [
							react_jsx_runtime.jsxs("div", { children: [
								react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: props.t(`${rowLabelPrefix}${row}`) }),
								" ",
								react_jsx_runtime.jsx("span", { style: chainDescStyle, children: props.t(`${rowLabelPrefix}${row}_desc`) })
							] }),
							...rungs.map((rung, index) => react_jsx_runtime.jsxs("div", { style: chainRungStyle, key: index, children: [
								react_jsx_runtime.jsx(modelPicker.ModelPickerField, {
									value: rung,
									onChange: (selection) => updateRung(row, index, selection),
									getSession: () => props.getSession(),
									t: props.t,
									disabled: props.disabled
								}),
								react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => removeRung(row, index), children: props.t("chainRemove") })
							] })),
							react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "12px" }, children: [
								react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => addRung(row), children: `+ ${props.t("chainAddRung")}` }),
								rungs.length > 0 ? react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => clearRow(row), children: props.t("chainClear") }) : null
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
