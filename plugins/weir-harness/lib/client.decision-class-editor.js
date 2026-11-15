window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.decision-class-editor.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// Auto-answer whitelist editor. The authorization class set is CLOSED
		// (A/B/C), so the stored JSON array is edited as one chip per class —
		// never as hand-typed JSON. Toggling a chip edits the field immediately
		// (no second save inside the editor); the label and hint come from the
		// settings-page dictionary entries of the same field. Style constants
		// are verbatim copies of the settings-page constants this editor uses
		// (same-package sync require is impossible in the ModuleLoader).
		const DEFAULT_ROWS = ["A", "B", "C"];
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "24px", padding: "12px 0" };
		const labelGroupStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 };
		const labelStyle = { fontSize: "var(--dsw-font-s-14-font-size)", fontWeight: 500, lineHeight: "var(--dsw-font-s-14-line-height)" };
		const hintStyle = { fontSize: "var(--dsw-font-xxs-12-font-size)", lineHeight: "var(--dsw-font-xxs-12-line-height)", color: "var(--dsw-alias-label-secondary)" };
		const controlsStyle = { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 };
		const chipRowStyle = { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" };
		const chipStyle = { minWidth: "34px", height: "26px", padding: "0 10px", cursor: "pointer", borderRadius: "var(--dsw-radius-sm)", background: "transparent", border: "0.5px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", fontSize: "var(--dsw-font-xs-13-font-size)", lineHeight: "var(--dsw-font-xs-13-line-height)", fontWeight: 500 };
		// Selected chips take the layered fill + primary label. The selected state
		// never borrows the primary-action color: saving stays the only primary.
		const chipSelectedStyle = { ...chipStyle, background: "var(--dsw-alias-bg-layer-3)", border: "0.5px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)" };
		const resetStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "var(--dsw-font-xxs-12-font-size)", textDecoration: "underline", color: "var(--dsw-alias-label-secondary)" };
		/** The stored text as a selection: blank (unset at every layer) is the
		 * empty selection, never an error; malformed JSON, a non-array, or any
		 * value outside the closed row set opens with EVERY chip off and the
		 * invalid marker — no stored state may strand the field uneditable. */
		function openState(text, rows) {
			const blank = typeof text !== "string" || text.trim() === "";
			if (blank) return { selected: [], invalid: false };
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				return { selected: [], invalid: true };
			}
			const known = new Set(rows);
			if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string" && known.has(entry))) {
				return { selected: [], invalid: true };
			}
			return { selected: [...new Set(parsed)], invalid: false };
		}
		/** Synthesize the stored JSON from the staged selection, in row order:
		 * one canonical serialization, deduplicated, nothing selected → []. */
		function selectionToJson(rows, selected) {
			return JSON.stringify(rows.filter((row) => (selected ?? []).includes(row)));
		}
		/** Visual editor for the Auto answer classes: three chips, JSON synthesized on every toggle. */
		function ClassSetEditorField(props) {
			const rows = Array.isArray(props.rows) && props.rows.length > 0 ? props.rows : DEFAULT_ROWS;
			const field = props.field ?? "decisionAgentAutoAnswerClasses";
			const state = openState(props.text, rows);
			const ordered = rows.filter((row) => state.selected.includes(row));
			const toggle = (row) => {
				const next = state.selected.includes(row) ? state.selected.filter((entry) => entry !== row) : [...state.selected, row];
				props.edit(field, selectionToJson(rows, next));
			};
			return react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
				react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
					react_jsx_runtime.jsx("span", { style: labelStyle, children: props.t(field) }),
					react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t(`${field}Hint`) })
				] }),
				react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
					react_jsx_runtime.jsx("div", { style: chipRowStyle, "data-decision-class-set": field, role: "group", "aria-label": props.t(field), children: rows.map((row) => react_jsx_runtime.jsx("button", {
						type: "button",
						style: state.selected.includes(row) ? chipSelectedStyle : chipStyle,
						"data-decision-class": row,
						"aria-pressed": state.selected.includes(row),
						disabled: props.disabled,
						onClick: () => toggle(row),
						children: row
					}, row)) }),
					react_jsx_runtime.jsx("span", { style: hintStyle, "data-decision-class-count": state.selected.length, children: ordered.length === 0 ? props.t("decisionClassNone") : props.t("decisionClassCount", { classes: ordered.join(", ") }) }),
					state.invalid ? react_jsx_runtime.jsx("span", { style: hintStyle, "data-decision-class-invalid": true, children: props.t("decisionClassInvalid") }) : null,
					props.overridden ? react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
						react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: props.t("overridden") }),
						react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: props.onReset, children: props.t("reset") })
					] }) : null
				] })
			] });
		}
		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under "settings.weir.page"
		// inside a ctx.effect when this chunk arrives (lib/client.js
		// registerChunkDictionaries). Pinned by test/client.test.js's dictionary
		// union pin.
		const dictionaries = {
			en: {
				decisionClassNone: "No class is allowed — Auto will classify and route, but the conclusion waits for you.",
				decisionClassCount: "{classes}",
				decisionClassInvalid: "The stored value is not a valid A/B/C list; every class opened off — the next save replaces it."
			},
			zh: {
				decisionClassNone: "未允许任何类别——Auto 仍会分类与路由，但结论交给你。",
				decisionClassCount: "{classes}",
				decisionClassInvalid: "已保存的值不是有效的 A/B/C 清单；编辑器已以全部关闭打开，下次保存将覆盖该值。"
			},
		};

		exports.dictionaries = dictionaries;
		exports.ClassSetEditorField = ClassSetEditorField;
		return module.exports;
	}
});
