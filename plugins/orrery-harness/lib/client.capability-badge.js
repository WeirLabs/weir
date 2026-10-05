window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.capability-badge.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Session capability Badge (conversation composer bar, order 95) ----
		// Applied counts come from the SERVER RECEIPT only (12.2) — the fetch
		// verb arrives via props from the composition root; the pure model
		// (client.capability-model.js) decides every presentation state.
		const badgeStyle = {
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
		const warnDotStyle = {
			width: "7px",
			height: "7px",
			borderRadius: "50%",
			background: "var(--dsw-alias-state-warning, #c80)"
		};
		function CapabilityBadge(props) {
			const model = props.model;
			const sessionId = props.sessionId;
			// The slot-bound t echoes the raw key for unregistered entries
			// (the capability.* keys carry in-code fallbacks instead of
			// dictionary rows); never render an echoed key.
			const t = (key, fallback) => {
				const value = typeof props.t === "function" ? props.t(key, fallback) : undefined;
				return value && value !== key ? value : fallback;
			};
			const [state, setState] = react.useState(null);
			const [panelOpen, setPanelOpen] = react.useState(false);
			const [convergence, setConvergence] = react.useState(null);
			react.useEffect(() => {
				if (!sessionId || typeof props.fetchReceipt !== "function") {
					setState(null);
					return undefined;
				}
				let alive = true;
				const refresh = () => props.fetchReceipt(sessionId).then((receipt) => {
					if (alive) setState(model.badgeStateOf(receipt, null));
				}).catch(() => {});
				refresh();
				// 12.5: a same-session frame refreshes this window's Badge; a
				// missing subscription degrades to an explicit refresh hint.
				if (typeof props.subscribeFrames === "function") {
					setConvergence(model.convergenceHintOf({ subscribed: true }));
					const stop = props.subscribeFrames((frame) => {
						if (model.frameRefreshesSession(frame, sessionId)) refresh();
					});
					return () => { alive = false; if (typeof stop === "function") stop(); };
				}
				setConvergence(model.convergenceHintOf({ subscribed: false }));
				return () => { alive = false; };
			}, [sessionId]);
			if (!sessionId) return null;
			const label = state && state.known
				? t("capability.badge", `${state.applied.skills} skills · ${state.applied.mcpServers} MCP`)
				: t("capability.loading", "Capabilities…");
			const hasWarning = Boolean(state && state.unavailable && state.unavailable.length > 0);
			const title = hasWarning ? state.unavailable.join("; ") : (convergence ?? undefined);
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				style: badgeStyle,
				title,
				"aria-label": label,
				onClick: () => setPanelOpen(!panelOpen),
				children: [
					hasWarning ? react_jsx_runtime.jsx("span", { style: warnDotStyle }) : null,
					label,
					panelOpen && typeof props.ManagerPanel === "function"
						? react_jsx_runtime.jsx(props.ManagerPanel, { sessionId, model, onClose: () => setPanelOpen(false) })
						: null
				]
			});
		}
		exports.CapabilityBadge = CapabilityBadge;
		return module.exports;
	}
});
