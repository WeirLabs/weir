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
			background: "var(--dsw-alias-state-warn-primary, #c80)"
		};
		// 12.2's "an error must not take down neighboring composer controls":
		// a crashing panel surfaces an inline error and leaves the Badge alive.
		class CapabilityPanelBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			render() {
				if (this.state.error !== null) {
					return react_jsx_runtime.jsx("div", {
						style: { position: "absolute", bottom: "calc(100% + 8px)", left: 0, padding: "8px", fontSize: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)", background: "var(--dsw-alias-background-elevated, #fff)", color: "var(--dsw-alias-state-warn-primary, #c80)" },
						children: `Capabilities panel error: ${String(this.state.error?.message ?? this.state.error)}`
					});
				}
				return this.props.children;
			}
		}
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
			const [settled, setSettled] = react.useState(false);
			const [panelOpen, setPanelOpen] = react.useState(false);
			const [convergence, setConvergence] = react.useState(null);
			const aliveRef = react.useRef(false);
			const refresh = react.useCallback(() => {
				if (!sessionId || typeof props.fetchReceipt !== "function") return Promise.resolve();
				return props.fetchReceipt(sessionId).then((receipt) => {
					if (aliveRef.current) { setState(model.badgeStateOf(receipt, null)); setSettled(true); }
				}).catch(() => { if (aliveRef.current) setSettled(true); });
			}, [sessionId]);
			react.useEffect(() => {
				if (!sessionId || typeof props.fetchReceipt !== "function") {
					setState(null);
					setSettled(false);
					return undefined;
				}
				aliveRef.current = true;
				setSettled(false);
				refresh();
				// 12.5: a same-session frame refreshes this window's Badge; a
				// missing subscription degrades to an explicit refresh hint.
				if (typeof props.subscribeFrames === "function") {
					setConvergence(model.convergenceHintOf({ subscribed: true }));
					const stop = props.subscribeFrames((frame) => {
						if (model.frameRefreshesSession(frame, sessionId)) refresh();
					});
					return () => { aliveRef.current = false; if (typeof stop === "function") stop(); };
				}
				setConvergence(model.convergenceHintOf({ subscribed: false }));
				return () => { aliveRef.current = false; };
			}, [sessionId, refresh]);
			// Close on outside click (edit-lock panel pattern): any pointerdown
			// outside this entry's wrapper dismisses the panel. Clicks INSIDE
			// never reach the toggle because the panel is the button's sibling,
			// not its child (nested they bubbled to onClick and closed it).
			react.useEffect(() => {
				if (!panelOpen || typeof document === "undefined") return undefined;
				const onPointerDown = (event) => {
					if (event?.target?.closest?.("[data-orrery-capability-root]")) return;
					setPanelOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				return () => { document.removeEventListener("pointerdown", onPointerDown); };
			}, [panelOpen]);
			if (!sessionId) return null;
			const label = state && state.known
				? t("capability.badge", `${state.applied.skills} skills · ${state.applied.mcpServers} MCP`)
				: settled
					// The receipt fetch settled without a receipt: this session's
					// composition has no capability command (a non-Orrery preset)
					// or it failed — an explicit n/a, never a perpetual spinner.
					? t("capability.unavailable.short", "Capabilities n/a")
					: t("capability.loading", "Capabilities…");
			const hasWarning = Boolean(state && state.unavailable && state.unavailable.length > 0);
			const title = hasWarning ? state.unavailable.join("; ") : (convergence ?? undefined);
			return react_jsx_runtime.jsxs("span", {
				style: { position: "relative", display: "inline-flex" },
				"data-orrery-capability-root": "",
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						style: badgeStyle,
						title,
						"aria-label": label,
						"aria-expanded": panelOpen,
						onClick: () => setPanelOpen(!panelOpen),
						children: [
							hasWarning ? react_jsx_runtime.jsx("span", { style: warnDotStyle }) : null,
							label
						]
					}),
					panelOpen && typeof props.ManagerPanel === "function"
						? react_jsx_runtime.jsx(CapabilityPanelBoundary, { children: react_jsx_runtime.jsx(props.ManagerPanel, {
							sessionId, model, onClose: () => setPanelOpen(false),
							// The composition-root verbs and translator travel with the
							// panel — without them fetchListing is absent and the panel
							// would sit on the perpetual loading surface (12.2).
							fetchListing: props.fetchListing, fetchConditions: props.fetchConditions,
							fetchReceipt: props.fetchReceipt, applySelection: props.applySelection, mcpAdd: props.mcpAdd,
							// After a successful Apply the Badge's own receipt is stale —
							// the panel pings this callback so the counts re-pull (12.2).
							onApplied: refresh, t: props.t
						}) })
						: null
				]
			});
		}
		exports.CapabilityBadge = CapabilityBadge;
		return module.exports;
	}
});
