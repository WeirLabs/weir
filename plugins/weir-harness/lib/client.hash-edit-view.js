window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.hash-edit-view.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// hash_edit conversation diff view. The view-model helpers
		// (client.hash-edit-model.js, ten exports) and `t` arrive via props —
		// the composition root (lib/client.js) pulls both chunks in parallel.
		const hashEditHeaderStyle = { display: "flex", alignItems: "center", gap: "8px", padding: "6px 4px", cursor: "pointer", userSelect: "none", borderRadius: "var(--dsw-radius-sm)" };
		const hashEditTitleStyle = { fontSize: "13px", fontWeight: 500, lineHeight: "18px", flexShrink: 0 };
		const hashEditPathStyle = { background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 };
		const hashEditMetaStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", flexShrink: 0 };
		const hashEditHintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", padding: "4px 4px" };
		const hashEditPreStyle = { margin: 0, padding: "8px 10px", fontSize: "12px", lineHeight: "16px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "240px", overflow: "auto", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)" };
		/** Status tone: errors and interruptions stay explicit in the header. */
		function hashEditStateColor(state) {
			if (state === "error") return "var(--dsw-alias-state-business-danger, #d64545)";
			if (state === "stopped") return "var(--dsw-alias-state-business-warning, #b07707)";
			return "var(--dsw-alias-label-secondary)";
		}
		/** Keyed conversation view for hash_edit: one row, expandable diff panel. */
		function HashEditRow(props) {
			const model = props.model;
			const state = model.hashEditState(props.phase, props.block);
			if (state === "preparing") {
				return react_jsx_runtime.jsx("div", {
					"data-tool": model.HASH_EDIT_TOOL,
					"data-state": "preparing",
					children: react_jsx_runtime.jsxs("div", { style: { ...hashEditHeaderStyle, cursor: "default" }, children: [
						react_jsx_runtime.jsx(primitives.IconEditOutlineRegular, { size: 14 }),
						react_jsx_runtime.jsx("span", { style: hashEditTitleStyle, children: props.t("hashEditTitle") }),
						react_jsx_runtime.jsx("span", { style: hashEditMetaStyle, children: props.t("hashEditPreparing") })
					] })
				});
			}
			return react_jsx_runtime.jsx(StartedHashEditRow, { ...props, state });
		}
		function StartedHashEditRow(props) {
			const { block, cwd, home, openFile, t, state, model } = props;
			const [expanded, setExpanded] = react.useState(false);
			const argsRaw = model.hashEditArgsRaw(block);
			const parsed = model.parseHashEditArgs(argsRaw);
			const applied = state === "ok" ? model.appliedDiffFragments(block?.meta) : null;
			const planned = state === "running" ? model.plannedDiffFragments(parsed) : null;
			const diffs = applied ?? planned;
			const output = model.hashEditResultText(block);
			const path = parsed?.path ?? applied?.[0]?.path;
			const totals = diffs ? primitives.diffTotals(diffs) : null;
			const statusText = state === "running" ? t("hashEditRunning") : state === "error" ? t("hashEditFailed") : state === "stopped" ? t("hashEditStopped") : null;
			const toggle = () => setExpanded((value) => !value);
			const onKey = (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				toggle();
			};
			let body = null;
			if (expanded) {
				if (diffs) {
					body = react_jsx_runtime.jsxs("div", { children: [
						planned ? react_jsx_runtime.jsx("div", { style: hashEditHintStyle, children: t("hashEditPlanned") }) : null,
						react_jsx_runtime.jsx(primitives.DiffBlock, { diffs, labels: model.hashEditDiffLabels(t) })
					] });
				} else {
					body = react_jsx_runtime.jsxs("div", { children: [
						argsRaw !== null ? react_jsx_runtime.jsxs("div", { children: [
							react_jsx_runtime.jsx("div", { style: hashEditHintStyle, children: t("hashEditInput") }),
							react_jsx_runtime.jsx("pre", { style: hashEditPreStyle, children: argsRaw })
						] }) : null,
						output !== "" ? react_jsx_runtime.jsxs("div", { children: [
							react_jsx_runtime.jsx("div", { style: hashEditHintStyle, children: t("hashEditOutput") }),
							react_jsx_runtime.jsx("pre", { style: hashEditPreStyle, children: output })
						] }) : null
					] });
				}
			}
			return react_jsx_runtime.jsxs("div", {
				"data-tool": model.HASH_EDIT_TOOL,
				"data-state": state,
				children: [
					react_jsx_runtime.jsxs("div", {
						style: hashEditHeaderStyle,
						role: "button",
						tabIndex: 0,
						"aria-expanded": expanded,
						onClick: toggle,
						onKeyDown: onKey,
						children: [
							react_jsx_runtime.jsx(primitives.IconEditOutlineRegular, { size: 14 }),
							react_jsx_runtime.jsx("span", { style: hashEditTitleStyle, children: t("hashEditTitle") }),
							path ? react_jsx_runtime.jsx("button", {
								type: "button",
								style: hashEditPathStyle,
								title: path,
								onClick: (event) => {
									event.stopPropagation();
									if (typeof openFile === "function") openFile(path);
								},
								children: model.hashEditDisplayPath(path, cwd, home)
							}) : null,
							totals ? react_jsx_runtime.jsx("span", { style: hashEditMetaStyle, children: `+${totals.added} \u2212${totals.removed}` }) : null,
							statusText ? react_jsx_runtime.jsx("span", { style: { ...hashEditMetaStyle, color: hashEditStateColor(state) }, children: statusText }) : null,
							react_jsx_runtime.jsx("span", { style: { flex: 1 } }),
							react_jsx_runtime.jsx(primitives.IconChevronDownOutlineRegular, { size: 14, style: { transform: expanded ? "rotate(180deg)" : "none", transition: "transform 120ms" } })
						]
					}),
					body
				]
			});
		}
		exports.hashEditStateColor = hashEditStateColor;
		exports.HashEditRow = HashEditRow;
		exports.StartedHashEditRow = StartedHashEditRow;
		return module.exports;
	}
});
