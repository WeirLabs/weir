window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.lsp-toggle.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Per-session LSP toggle (conversation composer bar) ----
		// `settingsBus`, `useProjection`, and the remote.commands-backed verbs
		// (toggleLsp/fetchLspState/commandsList) arrive via props — the
		// composition root (lib/client.js) owns the bus and the ctx closures.
		const LSP_PROJECTION_KEY = "orreryLsp";
		const lspToggleStyle = {
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
		const lspDotStyle = (on) => ({
			width: "7px",
			height: "7px",
			borderRadius: "50%",
			background: on ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-disabled, #999)"
		});
		function LspToggle(props) {
			const settingsBus = props.settingsBus;
			const hasProjectionHook = typeof props.useProjection === "function";
			const projection = hasProjectionHook ? props.useProjection(LSP_PROJECTION_KEY) : undefined;
			const [available, setAvailable] = react.useState(null);
			const [pending, setPending] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [localState, setLocalState] = react.useState(undefined);
			const sessionId = props.sessionId;
			const t = props.t;
			react.useEffect(() => {
				if (!sessionId) {
					setAvailable(false);
					return undefined;
				}
				let alive = true;
				const check = () => {
					Promise.resolve(props.commandsList(sessionId))
						.then((list) => {
							if (alive) setAvailable(Array.isArray(list) && list.some((entry) => entry?.name === "lsp"));
						})
						.catch(() => {
							if (alive) setAvailable(false);
						});
				};
				setAvailable(null);
				check();
				const unsubscribe = settingsBus.subscribe(check);
				return () => {
					alive = false;
					unsubscribe();
				};
			}, [sessionId]);
			// Fallback initial state when the slot does not inject useProjection.
			react.useEffect(() => {
				if (hasProjectionHook || localState !== undefined || !sessionId) return;
				let alive = true;
				Promise.resolve(props.fetchLspState())
					.then((enabled) => {
						if (alive && typeof enabled === "boolean") setLocalState(enabled);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, [sessionId, hasProjectionHook, localState]);
			if (available !== true) return null;
			const on = hasProjectionHook ? projection?.enabled === true : localState === true;
			const toggle = () => {
				if (pending) return;
				setPending(true);
				setError(null);
				Promise.resolve(props.toggleLsp(!on)).then(
					(failure) => {
						setPending(false);
						if (failure) {
							setError(failure);
						} else if (!hasProjectionHook) {
							setLocalState(!on);
						}
					},
					(reason) => {
						setPending(false);
						setError(reason instanceof Error ? reason.message : String(reason));
					}
				);
			};
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				style: lspToggleStyle,
				onClick: toggle,
				disabled: pending,
				"aria-pressed": on,
				"data-orrery-lsp-toggle": "",
				"data-orrery-lsp-state": on ? "on" : "off",
				title: error ?? t("lspToggleTitle"),
				children: [
					react_jsx_runtime.jsx("span", { style: lspDotStyle(on), "aria-hidden": true }),
					react_jsx_runtime.jsx("span", { children: t("lspToggleLabel") })
				]
			});
		}
		exports.LSP_PROJECTION_KEY = LSP_PROJECTION_KEY;
		exports.LspToggle = LspToggle;
		return module.exports;
	}
});
