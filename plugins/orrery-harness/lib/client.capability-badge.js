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
		//
		// Visual layer (capabilities-panel-visual-polish): consolidated style
		// table + spacing/alignment micro-tuning only. The pinned structure is
		// untouched: root span children[0] = toggle button (its aria-label keeps
		// the full counts), children[1] = error boundary → panel.
		const WARN = "var(--dsw-alias-state-warn-primary, #f59e0b)";
		const WARN_TEXT = "var(--dsw-alias-state-warn-label, #b45309)";
		const BORDER = "var(--dsw-alias-border-l2, rgba(127,127,127,.18))";
		const HOVER_BG = "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))";
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
		// Focus ring and hover paint without stylesheets (inline-style chunk
		// discipline): the handlers write to the event target's inline style and
		// clear on the way out — no hooks, no structure change.
		const paint = (event, styles) => {
			const el = event?.currentTarget;
			if (el && el.style) Object.assign(el.style, styles);
		};
		const ring = {
			onFocus: (event) => paint(event, { outline: "2px solid var(--dsw-alias-focus-ring, currentColor)", outlineOffset: "1px" }),
			onBlur: (event) => paint(event, { outline: "none", outlineOffset: "" }),
		};
		const S = {
			root: { position: "relative", display: "inline-flex" },
			badge: {
				display: "inline-flex",
				alignItems: "center",
				gap: "5px",
				background: "none",
				border: `1px solid ${BORDER}`,
				borderRadius: "var(--dsw-radius-sm, 6px)",
				cursor: "pointer",
				padding: "2px 8px",
				fontSize: "12px",
				lineHeight: "16px",
				color: "var(--dsw-alias-label-secondary, #61666b)",
				transition: "background-color 120ms ease, color 120ms ease, border-color 120ms ease"
			},
			warnDot: {
				width: "6px",
				height: "6px",
				borderRadius: "50%",
				background: WARN,
				boxShadow: `0 0 0 2px ${tint(WARN, 18)}`,
				flex: "none"
			},
			errorBox: {
				position: "absolute",
				bottom: "calc(100% + 8px)",
				left: 0,
				maxWidth: "280px",
				padding: "8px 10px",
				fontSize: "12px",
				lineHeight: "16px",
				border: `1px solid ${BORDER}`,
				borderLeft: `2px solid ${WARN}`,
				borderRadius: "var(--dsw-radius-md, 8px)",
				background: "var(--dsw-alias-bg-overlay, #fff)",
				boxShadow: "var(--dsw-elevation-soft, 0 4px 16px rgba(0,0,0,.08))",
				color: WARN_TEXT
			}
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
						style: S.errorBox,
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
				// The host locale's second parameter is an interpolation VARS object,
				// never a fallback string — passing the fallback there crashes
				// translate whenever the registered template carries {placeholders}
				// (the 2026-10-05 badge slot crash). Dictionary templates keep their
				// placeholders for the call site's own .replace interpolation.
				const value = typeof props.t === "function" ? props.t(key) : undefined;
				return typeof value === "string" && value !== key ? value : fallback;
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
			// D4: the accessible label keeps the full counts (aria + tooltip);
			// the visible text is the compact "skills · MCP" pair next to an
			// inline blocks icon. The {skills}/{mcp} placeholders interpolate
			// through the same .replace pattern the other chunks use.
			const known = Boolean(state && state.known);
			const label = known
				? t("capability.badge", "{skills} skills · {mcp} MCP").replace("{skills}", String(state.applied.skills)).replace("{mcp}", String(state.applied.mcpServers))
				: settled
					// The receipt fetch settled without a receipt: this session's
					// composition has no capability command (a non-Orrery preset)
					// or it failed — an explicit n/a, never a perpetual spinner.
					? t("capability.unavailable.short", "Capabilities n/a")
					: t("capability.loading", "Capabilities…");
			const compactLabel = known ? `${state.applied.skills} · ${state.applied.mcpServers}` : label;
			const hasWarning = Boolean(state && state.unavailable && state.unavailable.length > 0);
			const title = hasWarning ? state.unavailable.join("; ") : (convergence ?? (known ? label : undefined));
			// D4: with the composition root's openPanel verb (a shell with a right
			// sidebar) activation opens the dedicated panel and closes any open
			// popover; without it the existing popover path runs unchanged.
			const openPanel = typeof props.openPanel === "function" ? props.openPanel : null;
			const onActivate = () => {
				if (openPanel) {
					setPanelOpen(false);
					openPanel(sessionId);
					return;
				}
				setPanelOpen(!panelOpen);
			};
			const blocksIcon = react_jsx_runtime.jsxs("svg", {
				width: "12",
				height: "12",
				viewBox: "0 0 12 12",
				"aria-hidden": "true",
				focusable: "false",
				style: { flex: "none", display: "block" },
				children: [
					react_jsx_runtime.jsx("rect", { x: "0.75", y: "0.75", width: "4.5", height: "4.5", rx: "1", fill: "currentColor" }),
					react_jsx_runtime.jsx("rect", { x: "6.75", y: "0.75", width: "4.5", height: "4.5", rx: "1", fill: "currentColor", opacity: "0.55" }),
					react_jsx_runtime.jsx("rect", { x: "0.75", y: "6.75", width: "4.5", height: "4.5", rx: "1", fill: "currentColor", opacity: "0.55" }),
					react_jsx_runtime.jsx("rect", { x: "6.75", y: "6.75", width: "4.5", height: "4.5", rx: "1", fill: "currentColor" })
				]
			});
			return react_jsx_runtime.jsxs("span", {
				style: S.root,
				"data-orrery-capability-root": "",
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						style: S.badge,
						...ring,
						onMouseEnter: (event) => paint(event, { background: HOVER_BG, color: "var(--dsw-alias-label-primary, inherit)" }),
						onMouseLeave: (event) => paint(event, { background: "none", color: "var(--dsw-alias-label-secondary, #61666b)" }),
						title,
						"aria-label": label,
						// aria-expanded follows the actual destination: only the
						// popover path expands a popup this button owns (D4).
						"aria-expanded": openPanel ? undefined : panelOpen,
						onClick: onActivate,
						children: [
							hasWarning ? react_jsx_runtime.jsx("span", { style: S.warnDot }) : null,
							blocksIcon,
							compactLabel
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
							// The preset/workspace-default verbs and the presets-chunk
							// loader travel the same prop bridge (D3); an old composition
							// root leaves them undefined and the view degrades to its
							// explicit unsupported state.
							loadPresets: props.loadPresets,
							fetchPresets: props.fetchPresets, presetSave: props.presetSave, presetLoad: props.presetLoad,
							presetDelete: props.presetDelete, presetExport: props.presetExport, presetImport: props.presetImport,
							defaultGet: props.defaultGet, defaultSave: props.defaultSave, defaultClear: props.defaultClear,
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
