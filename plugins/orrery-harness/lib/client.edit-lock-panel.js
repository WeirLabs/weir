window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.edit-lock-panel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Per-session Edit Lock entry (conversation composer bar) ----
		// Visible only while the `edit-lock` command exists (feature enabled).
		// Every refresh/action is an explicit human command, so nothing polls:
		// a command run is a durable flow node in the conversation, which also
		// serves as the audit trail of the action. Viewing grants nothing.
		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: "6px",
			background: "none",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			cursor: "pointer",
			padding: "3px 8px",
			fontSize: "12px",
			lineHeight: "16px",
			color: "var(--dsw-alias-label-secondary)"
		};
		// Popover surface: the theme's documented overlay token (defined for
		// light and dark). Every colour below is a token the host theme defines.
		const panelStyle = {
			position: "absolute",
			bottom: "calc(100% + 6px)",
			right: 0,
			zIndex: 20,
			width: "min(520px, 80vw)",
			maxHeight: "50vh",
			overflow: "auto",
			background: "var(--dsw-alias-bg-overlay)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-md, 8px)",
			boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
			padding: "10px 12px",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "12px"
		};
		const preStyle = { whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)", margin: "8px 0", lineHeight: "18px" };
		const rowStyle = { display: "flex", gap: "6px", flexWrap: "wrap" };
		const errorStyle = { color: "var(--dsw-alias-state-error-primary)" };
		/** Lock state colour from the status text, for the dot only. */
		function stateOf(text) {
			if (typeof text !== "string") return "unknown";
			if (/\[abnormal/.test(text) || /: recovering/.test(text)) return "abnormal";
			if (/: stopped|interrupted|pending-confirmation/.test(text)) return "interrupted";
			return "active";
		}
		const dotColor = {
			active: "var(--dsw-alias-state-business-primary)",
			interrupted: "var(--dsw-alias-state-warn-tertiary)",
			abnormal: "var(--dsw-alias-state-error-primary)",
			unknown: "var(--dsw-alias-label-tertiary)"
		};
		function EditLockPanel(props) {
			const t = props.t;
			const sessionId = props.sessionId;
			const [available, setAvailable] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			const [text, setText] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [pending, setPending] = react.useState(false);
			react.useEffect(() => {
				if (!sessionId) {
					setAvailable(false);
					return undefined;
				}
				let alive = true;
				Promise.resolve(props.commandsList(sessionId)).then(
					(list) => { if (alive) setAvailable(Array.isArray(list) && list.some((entry) => entry?.name === "edit-lock")); },
					() => { if (alive) setAvailable(false); }
				);
				return () => { alive = false; };
			}, [sessionId]);
			if (available !== true) return null;
			const run = (verb) => {
				if (pending) return;
				setPending(true);
				setError(null);
				Promise.resolve(props.runEditLock(verb)).then(
					(outcome) => {
						setPending(false);
						if (outcome.kind === "success") setText(outcome.text ?? "");
						else setError(outcome.text);
					},
					(reason) => {
						setPending(false);
						setError(reason instanceof Error ? reason.message : String(reason));
					}
				);
			};
			const toggle = () => {
				const next = !open;
				setOpen(next);
				if (next) run("status");
			};
			const state = stateOf(text);
			const action = (verb, label) => react_jsx_runtime.jsx("button", {
				type: "button", style: buttonStyle, disabled: pending, onClick: () => run(verb),
				"data-orrery-edit-lock-action": verb, children: label
			}, verb);
			return react_jsx_runtime.jsxs("span", {
				style: { position: "relative", display: "inline-flex" },
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						style: buttonStyle,
						onClick: toggle,
						"aria-expanded": open,
						"data-orrery-edit-lock": "",
						"data-orrery-edit-lock-state": state,
						title: t("editLockTitle"),
						children: [
							react_jsx_runtime.jsx("span", { "aria-hidden": true, style: { width: "7px", height: "7px", borderRadius: "50%", background: dotColor[state] } }),
							react_jsx_runtime.jsx("span", { children: t("editLockLabel") })
						]
					}),
					open ? react_jsx_runtime.jsxs("div", {
						role: "dialog",
						style: panelStyle,
						"data-orrery-edit-lock-panel": "",
						children: [
							react_jsx_runtime.jsx("div", { style: { fontWeight: 600 }, children: t("editLockPanelTitle") }),
							react_jsx_runtime.jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", marginTop: "4px" }, children: t("editLockPanelHint") }),
							error ? react_jsx_runtime.jsx("div", { style: { ...errorStyle, marginTop: "8px" }, children: error }) : null,
							react_jsx_runtime.jsx("pre", { style: preStyle, children: text ?? (pending ? t("editLockLoading") : "") }),
							react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
								action("status", t("editLockRefresh")),
								action("locks", t("editLockAll")),
								action("stop", t("editLockStop")),
								action("resume", t("editLockResume"))
							] })
						]
					}) : null
				]
			});
		}
		exports.EditLockPanel = EditLockPanel;
		exports.stateOf = stateOf;
		return module.exports;
	}
});
