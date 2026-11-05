window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.capability-manager.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Capability manager view tree (lazy) ----
		// One shared component tree mounted by two shells (D1): the composer
		// popover (Badge fallback, absolute overlay frame) and the right-sidebar
		// capabilities panel (static full-width frame) — the shell name arrives
		// as a prop; the tree below never branches on the mount point beyond the
		// root frame style. Three views (Skills / MCP / Presets): scope-grouped
		// skill rows with real checkboxes, description second lines and
		// source/conflict/missing marks; managed/unmanaged MCP groups with a
		// per-field-validated add form; the preset lifecycle view lives in its
		// own chunk pulled only when the Presets view is selected (the load runs
		// through the composition root's loadPresets verb — no chunk-to-chunk
		// require.async waterfall). Every list decision comes from the pure
		// model; an unsupported condition set renders as an explicit state,
		// never as hidden controls (12.2).
		//
		// Visual layer (capabilities-panel-visual-polish, D1): one consolidated
		// style table S, sectioned frame/header/tabs/list/row/tag/footer/state/
		// form. Inline-style chunks cannot use :hover/:focus-visible selectors,
		// so interactive affordances are painted by the ring/hover handlers on
		// the event target itself — no hooks, no wrapper components, and the
		// pinned structure (manager 7/1 hooks, header children[1] = MCP tab,
		// popover root children[1] = addBlock, footer chip order) is untouched.
		const ACCENT = "var(--dsw-alias-state-business-primary, #4176e6)";
		const ACCENT_HOVER = "var(--dsw-alias-button-info-hover, #3563d1)";
		const SUCCESS = "var(--dsw-alias-state-success-primary, #22c55e)";
		const WARN = "var(--dsw-alias-state-warn-primary, #f59e0b)";
		const WARN_TEXT = "var(--dsw-alias-state-warn-label, #b45309)";
		const DANGER = "var(--dsw-alias-state-error-primary, #ef4444)";
		const LABEL1 = "var(--dsw-alias-label-primary, inherit)";
		const LABEL2 = "var(--dsw-alias-label-secondary, #61666b)";
		const MUTED = "var(--dsw-alias-label-tertiary, #81858c)";
		const BORDER = "var(--dsw-alias-border-l2, rgba(127,127,127,.18))";
		const BORDER_STRONG = "var(--dsw-alias-border-l3, rgba(127,127,127,.26))";
		const HOVER_BG = "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))";
		const SKELETON = "var(--dsw-alias-bg-skeleton, rgba(127,127,127,.12))";
		const CARD_BG = "var(--dsw-alias-bg-base, #fff)";
		const TRANSITION = "background-color 120ms ease, color 120ms ease, border-color 120ms ease";
		/** Soft tinted background (worktree-view recipe); the colored border/text stays as the no-color-mix fallback. */
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
		// Scope → hue families (D1): weir-builtin accent, user green, project
		// blue, custom purple; anything else falls back to the neutral label hue.
		const SCOPE_HUES = {
			"weir-builtin": ACCENT,
			user: SUCCESS,
			project: "var(--dsw-static-blue-500, #3b82f6)",
			custom: "var(--dsw-alias-label-deep-diving, #6d5bd0)",
		};
		// Focus ring and hover paint without stylesheets: the handlers write to
		// the event target's inline style and clear on the way out. The S styles
		// are module constants, so React never clobbers the painted affordance
		// with a style-prop diff (values only change with the visual state).
		const paint = (event, styles) => {
			const el = event?.currentTarget;
			if (el && el.style) Object.assign(el.style, styles);
		};
		const ring = {
			onFocus: (event) => {
				const el = event?.currentTarget;
				const visible = typeof el?.matches !== "function" || el.matches(":focus-visible");
				paint(event, visible
					? { outline: "2px solid var(--dsw-alias-focus-ring, currentColor)", outlineOffset: "1px" }
					: { outline: "none", outlineOffset: "" });
			},
			onPointerDown: (event) => paint(event, { outline: "none", outlineOffset: "" }),
			onBlur: (event) => paint(event, { outline: "none", outlineOffset: "" }),
		};
		const hover = (over, out) => ({
			onMouseEnter: (event) => paint(event, { background: over }),
			onMouseLeave: (event) => paint(event, { background: out }),
		});
		const S = {
			frame: {
				// Popover frame (geometry unchanged): bg-overlay is the popover
				// surface (a hard #fff fallback goes invisible under a dark theme).
				popover: {
					position: "absolute",
					bottom: "calc(100% + 8px)",
					left: 0,
					minWidth: "340px",
					maxWidth: "440px",
					maxHeight: "440px",
					overflow: "auto",
					background: "var(--dsw-alias-bg-overlay, #fff)",
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-lg, 12px)",
					boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.14))",
					padding: "12px",
					fontSize: "12px",
					color: LABEL1
				},
				// Sidebar frame: a full-height flex column — the pane does NOT
				// scroll arbitrary cell content, so the frame pins its own height
				// and the view region between header and footer scrolls.
				sidebar: {
					display: "flex",
					flexDirection: "column",
					gap: "2px",
					height: "100%",
					minHeight: 0,
					boxSizing: "border-box",
					padding: "12px",
					fontSize: "12px",
					color: LABEL1
				}
			},
			header: {
				row: {
					display: "flex",
					gap: "6px",
					alignItems: "center",
					marginBottom: "8px",
					paddingBottom: "8px",
					borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.10))",
					flex: "none"
				},
				summary: { fontSize: "11px", lineHeight: "16px", color: MUTED, whiteSpace: "nowrap", flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", marginLeft: "2px" },
				close: {
					width: "22px",
					height: "22px",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					flex: "none",
					padding: 0,
					cursor: "pointer",
					background: "none",
					border: "none",
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: MUTED,
					transition: TRANSITION
				}
			},
			path: {
				trigger: {
					minWidth: "22px",
					height: "22px",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					gap: "3px",
					flex: "none",
					padding: "0 4px",
					cursor: "pointer",
					background: "none",
					border: "none",
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: MUTED,
					transition: TRANSITION
				},
				count: {
					fontSize: "9px",
					lineHeight: "12px",
					fontWeight: 600,
					color: LABEL2,
					background: HOVER_BG,
					borderRadius: "var(--dsw-radius-xl, 999px)",
					padding: "0 4px",
					minWidth: "12px",
					textAlign: "center",
					flex: "none"
				},
				overlay: (position) => ({
					position: "fixed",
					zIndex: 1000,
					top: position.top,
					left: position.left,
					width: position.width,
					maxHeight: position.maxHeight,
					boxSizing: "border-box",
					overflowY: "auto",
					overflowX: "hidden",
					background: "var(--dsw-alias-bg-overlay, #fff)",
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-lg, 12px)",
					boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.14))",
					padding: "12px",
					fontSize: "12px",
					color: LABEL1
				})
			},
			tabs: {
				// Segmented control (host SegmentedControl recipe, containerless):
				// inactive segments carry the track fill, the active segment is a
				// raised layer-1 pill; 2px gutters between segments.
				base: {
					fontSize: "12px",
					lineHeight: "16px",
					padding: "3px 10px",
					cursor: "pointer",
					border: "none",
					flex: "none",
					transition: TRANSITION
				},
				segment: (active, at) => ({
					...S.tabs.base,
					marginLeft: at === "first" ? "0" : "2px",
					borderRadius: at === "first"
						? "var(--dsw-radius-md, 8px) 0 0 var(--dsw-radius-md, 8px)"
						: at === "last"
							? "0 var(--dsw-radius-md, 8px) var(--dsw-radius-md, 8px) 0"
							: "0",
					background: active ? "var(--dsw-alias-bg-layer-1, #fff)" : HOVER_BG,
					color: active ? LABEL1 : LABEL2,
					fontWeight: active ? 600 : 500,
					boxShadow: active ? "var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.10))" : "none"
				})
			},
			search: {
				wrap: { position: "relative", flex: "1 1 auto", minWidth: "72px", display: "flex", alignItems: "center" },
				icon: { position: "absolute", left: "7px", display: "inline-flex", color: MUTED, pointerEvents: "none" },
				input: {
					width: "100%",
					boxSizing: "border-box",
					fontSize: "12px",
					lineHeight: "16px",
					padding: "3px 8px 3px 24px",
					background: CARD_BG,
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: LABEL1,
					transition: TRANSITION
				}
			},
			list: {
				// The sidebar shell pins the view region between header and the
				// Apply footer as the scroll container (minHeight:0 lets the flex
				// child shrink below its content height).
				scroll: { flex: "1 1 auto", minHeight: 0, overflowY: "auto" },
				group: { marginBottom: "4px" },
				// Sticky group header: opaque per-shell surface so rows scroll
				// beneath it (popover = bg-overlay, sidebar = bg-layer-1).
				groupTitle: (shell) => ({
					position: "sticky",
					top: 0,
					zIndex: 1,
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "6px",
					fontSize: "11px",
					lineHeight: "16px",
					fontWeight: 600,
					color: LABEL2,
					padding: "3px 2px",
					margin: "6px 0 2px",
					background: shell === "sidebar" ? "var(--dsw-alias-bg-layer-1, #fff)" : "var(--dsw-alias-bg-overlay, #fff)"
				}),
				count: {
					fontSize: "10px",
					lineHeight: "14px",
					fontWeight: 600,
					color: MUTED,
					background: HOVER_BG,
					borderRadius: "var(--dsw-radius-xl, 999px)",
					padding: "0 6px",
					minWidth: "16px",
					textAlign: "center",
					flex: "none"
				},
				card: {
					background: CARD_BG,
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-md, 8px)",
					padding: "6px 8px",
					margin: "6px 0"
				},
				cardHead: {
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: "6px",
					fontSize: "11px",
					lineHeight: "16px",
					fontWeight: 600,
					color: LABEL2,
					padding: "0 2px 3px"
				}
			},
			row: {
				base: {
					display: "flex",
					alignItems: "flex-start",
					gap: "8px",
					padding: "4px 6px",
					borderRadius: "var(--dsw-radius-sm, 6px)",
					cursor: "pointer",
					transition: TRANSITION
				},
				checkbox: { marginTop: "1px", flex: "none", accentColor: ACCENT, cursor: "pointer" },
				text: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0, flex: 1 },
				nameLine: { display: "flex", gap: "6px", alignItems: "center", minWidth: 0, flexWrap: "wrap" },
				name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 },
				desc: {
					fontSize: "11px",
					lineHeight: "15px",
					color: MUTED,
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap"
				}
			},
			tag: {
				base: {
					fontSize: "10px",
					lineHeight: "14px",
					fontWeight: 600,
					padding: "0 5px",
					borderRadius: "var(--dsw-radius-sm, 6px)",
					border: "1px solid transparent",
					flex: "none",
					whiteSpace: "nowrap"
				},
				// Source tag color-coded by scope family (D1); unknown scopes keep
				// the neutral label hue.
				scope: (scopeKey) => {
					const hue = SCOPE_HUES[scopeKey] ?? MUTED;
					return { color: hue, border: `1px solid ${hue}`, background: tint(hue, 10) };
				},
				warn: { color: WARN_TEXT, border: `1px solid ${WARN}`, background: tint(WARN, 12) },
				danger: { color: DANGER, border: `1px solid ${DANGER}`, background: tint(DANGER, 10) },
				ok: { color: SUCCESS, border: `1px solid ${SUCCESS}`, background: tint(SUCCESS, 10) },
				neutral: { color: MUTED, border: `1px solid ${BORDER_STRONG}`, background: "none" }
			},
			footer: {
				bar: {
					borderTop: `1px solid ${BORDER}`,
					marginTop: "8px",
					paddingTop: "8px",
					display: "flex",
					flex: "none",
					gap: "6px",
					alignItems: "center",
					flexWrap: "wrap"
				},
				diff: { display: "inline-flex", gap: "4px", alignItems: "center", flexWrap: "wrap", minWidth: 0 },
				diffBadge: (added) => {
					const hue = added ? SUCCESS : DANGER;
					return {
						fontSize: "11px",
						lineHeight: "16px",
						fontWeight: 600,
						padding: "0 6px",
						borderRadius: "var(--dsw-radius-sm, 6px)",
						color: hue,
						background: tint(hue, 10),
						border: `1px solid ${hue}`,
						flex: "none"
					};
				},
				apply: {
					fontSize: "12px",
					lineHeight: "16px",
					fontWeight: 600,
					padding: "4px 12px",
					cursor: "pointer",
					border: "none",
					borderRadius: "var(--dsw-radius-sm, 6px)",
					background: ACCENT,
					color: "var(--dsw-alias-bg-base, #fff)",
					transition: TRANSITION
				},
				discard: {
					fontSize: "12px",
					lineHeight: "16px",
					fontWeight: 500,
					padding: "3px 10px",
					cursor: "pointer",
					background: "none",
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: LABEL2,
					transition: TRANSITION
				},
				// Commit-phase chip: dot-less tonal badge (worktree Badge recipe).
				chip: (hue) => ({
					fontSize: "11px",
					lineHeight: "16px",
					fontWeight: 600,
					padding: "1px 7px",
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: hue,
					background: tint(hue, 12),
					border: `1px solid ${hue}`,
					flex: "none"
				}),
				disabled: { opacity: 0.5, cursor: "not-allowed" }
			},
			state: {
				// Full empty state: icon disc + title + description.
				wrap: {
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					textAlign: "center",
					gap: "6px",
					padding: "26px 16px",
					color: LABEL2,
					flex: "none"
				},
				icon: (hue) => ({
					width: "34px",
					height: "34px",
					borderRadius: "50%",
					display: "grid",
					placeItems: "center",
					color: hue,
					background: tint(hue, 10),
					flex: "none"
				}),
				title: { fontSize: "12px", lineHeight: "16px", fontWeight: 600, color: LABEL1 },
				desc: { fontSize: "11px", lineHeight: "16px", color: MUTED, maxWidth: "280px" },
				skeleton: { display: "flex", flexDirection: "column", gap: "8px" },
				skeletonRow: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 6px" },
				bone: (width, height) => ({ width, height, borderRadius: "var(--dsw-radius-sm, 6px)", background: SKELETON, flex: "none" }),
				srOnly: {
					position: "absolute",
					width: "1px",
					height: "1px",
					padding: 0,
					margin: "-1px",
					overflow: "hidden",
					clip: "rect(0 0 0 0)",
					whiteSpace: "nowrap",
					border: 0
				}
			},
			form: {
				wrap: { marginBottom: "6px" },
				addButton: {
					width: "100%",
					boxSizing: "border-box",
					fontSize: "12px",
					lineHeight: "16px",
					padding: "6px 8px",
					cursor: "pointer",
					color: LABEL2,
					background: "none",
					border: `1px dashed ${BORDER_STRONG}`,
					borderRadius: "var(--dsw-radius-md, 8px)",
					transition: TRANSITION
				},
				box: {
					display: "flex",
					flexDirection: "column",
					gap: "6px",
					background: CARD_BG,
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-md, 8px)",
					padding: "8px"
				},
				title: { fontSize: "11px", lineHeight: "16px", fontWeight: 600, color: LABEL2 },
				input: {
					width: "100%",
					boxSizing: "border-box",
					fontSize: "12px",
					lineHeight: "16px",
					padding: "4px 8px",
					background: CARD_BG,
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: LABEL1,
					transition: TRANSITION
				},
				error: { fontSize: "11px", lineHeight: "15px", color: WARN_TEXT },
				actions: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
				primary: {
					fontSize: "12px",
					lineHeight: "16px",
					fontWeight: 600,
					padding: "3px 10px",
					cursor: "pointer",
					border: "none",
					borderRadius: "var(--dsw-radius-sm, 6px)",
					background: ACCENT,
					color: "var(--dsw-alias-bg-base, #fff)",
					transition: TRANSITION
				},
				ghost: {
					fontSize: "12px",
					lineHeight: "16px",
					fontWeight: 500,
					padding: "3px 10px",
					cursor: "pointer",
					background: "none",
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: LABEL2,
					transition: TRANSITION
				}
			}
		};
		// ---- 16x16 stroke icons (worktree-view style, stroke: currentColor) ----
		const ICON_PATHS = {
			search: [["circle", { cx: 7, cy: 7, r: 4.6 }], ["path", { d: "M10.6 10.6L14 14" }]],
			folder: [
				["path", { d: "M2.2 4.2c0-.6.4-1 1-1h3l1.5 1.8h5.1c.6 0 1 .4 1 1v5.8c0 .6-.4 1-1 1H3.2c-.6 0-1-.4-1-1V4.2z" }],
				["path", { d: "M2.2 6h11.6" }]
			],
			x: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
			warn: [
				["path", { d: "M8 2.6l6 10.4H2l6-10.4z" }],
				["path", { d: "M8 6.6v3.2" }],
				["circle", { cx: 8, cy: 11.4, r: 0.7, fill: "currentColor", stroke: "none" }]
			],
			info: [
				["circle", { cx: 8, cy: 8, r: 5.6 }],
				["path", { d: "M8 7.4v3.4" }],
				["circle", { cx: 8, cy: 5.2, r: 0.7, fill: "currentColor", stroke: "none" }]
			],
			blocks: [
				["rect", { x: 2.2, y: 2.2, width: 4.8, height: 4.8, rx: 1, fill: "currentColor", stroke: "none" }],
				["rect", { x: 9, y: 2.2, width: 4.8, height: 4.8, rx: 1, fill: "currentColor", stroke: "none", opacity: 0.55 }],
				["rect", { x: 2.2, y: 9, width: 4.8, height: 4.8, rx: 1, fill: "currentColor", stroke: "none", opacity: 0.55 }],
				["rect", { x: 9, y: 9, width: 4.8, height: 4.8, rx: 1, fill: "currentColor", stroke: "none" }]
			]
		};
		/** @param {{ name: string, size?: number }} props */
		function Icon(props) {
			const size = props.size ?? 12;
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16",
				width: size,
				height: size,
				"aria-hidden": "true",
				focusable: "false",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				style: { flex: "none", display: "block" },
				children: (ICON_PATHS[props.name] ?? []).map(([tag, attrs], index) => react_jsx_runtime.jsx(tag, attrs, index))
			});
		}
		/** Full empty state (D1): icon disc + title + optional description. Hook-free. */
		function StatePanel(props) {
			const hue = props.color ?? MUTED;
			return react_jsx_runtime.jsxs("div", {
				style: S.state.wrap,
				children: [
					react_jsx_runtime.jsx("span", { style: S.state.icon(hue), children: react_jsx_runtime.jsx(Icon, { name: props.icon ?? "info", size: 17 }) }),
					react_jsx_runtime.jsx("div", { style: S.state.title, children: props.title }),
					props.description ? react_jsx_runtime.jsx("div", { style: S.state.desc, children: props.description }) : null
				]
			});
		}
		// The Presets view chunk arrives only after its tab is selected; the
		// composition root owns the require.async specifier (loadPresets verb) so
		// this chunk keeps its react-only require face.
		function LazyCapabilityPresets(props) {
			const [impl, setImpl] = react.useState(null);
			const [loadFailed, setLoadFailed] = react.useState(false);
			react.useEffect(() => {
				if (typeof props.loadPresets !== "function") return undefined;
				let alive = true;
				Promise.resolve(props.loadPresets()).then(
					(chunk) => { if (alive) setImpl(() => chunk?.CapabilityPresetsView ?? null); },
					() => { if (alive) setLoadFailed(true); }
				);
				return () => { alive = false; };
			}, []);
			const t = props.t;
			if (typeof props.loadPresets !== "function" || loadFailed) {
				return react_jsx_runtime.jsx(StatePanel, { icon: "warn", color: WARN_TEXT, title: t("capability.presets.unavailable", "Presets are unavailable on this host.") });
			}
			if (!impl) {
				return react_jsx_runtime.jsx(StatePanel, { icon: "info", title: t("capability.loading", "Loading capabilities…") });
			}
			return react_jsx_runtime.jsx(impl, { ...props });
		}
		/** Skills-only path management. All hooks live here so CapabilityManagerPanel
		 * keeps its pinned 7/1 hook structure in both shells. */
		function SkillPathManager(props) {
			const model = props.model;
			const t = props.t;
			const [registry, setRegistry] = react.useState(null);
			const [input, setInput] = react.useState("");
			const [reading, setReading] = react.useState(false);
			const [busy, setBusy] = react.useState(null);
			const [feedback, setFeedback] = react.useState(null);
			const [pendingRemove, setPendingRemove] = react.useState(null);
			const [returnFocusTo, setReturnFocusTo] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			const [position, setPosition] = react.useState({ top: 12, left: 12, width: 360, maxHeight: 420 });
			const readRequest = react.useRef(0);
			const operationRequest = react.useRef(0);
			const operationRunning = react.useRef(false);
			const alive = react.useRef(true);
			const triggerRef = react.useRef(null);
			const overlayRef = react.useRef(null);
			const inputRef = react.useRef(null);

			const refreshPaths = async () => {
				const request = ++readRequest.current;
				setReading(true);
				let response;
				try {
					response = typeof props.fetchSkillPaths === "function"
						? await props.fetchSkillPaths(props.sessionId)
						: { status: "unavailable", saved: false, error: { code: "unavailable", message: "Skill scan path reads are unavailable on this client." } };
				} catch (error) {
					response = { status: "call-threw", saved: false, error: { code: "call-threw", message: error instanceof Error ? error.message : String(error) } };
				}
				if (!alive.current || request !== readRequest.current) return null;
				setRegistry(current => model.skillPathsAfterRead(current, response));
				setReading(false);
				return response;
			};

			const closeManager = () => {
				if (busy !== null) return;
				setOpen(false);
				triggerRef.current?.focus();
			};
			const openManager = () => {
				if (open) return;
				const viewportWidth = window.innerWidth;
				const viewportHeight = window.innerHeight;
				const rect = triggerRef.current?.getBoundingClientRect();
				const width = Math.max(0, Math.min(360, viewportWidth - 24));
				const left = Math.max(12, Math.min((rect?.right ?? viewportWidth - 12) - width, viewportWidth - width - 12));
				const top = Math.max(12, Math.min((rect?.bottom ?? 12) + 8, Math.max(12, viewportHeight - 12)));
				setPosition({ top, left, width, maxHeight: Math.max(0, viewportHeight - top - 12) });
				setOpen(true);
				void refreshPaths();
			};

			react.useEffect(() => {
				alive.current = true;
				setRegistry(null);
				setInput("");
				setOpen(false);
				setFeedback(null);
				setPendingRemove(null);
				setReturnFocusTo(null);
				setBusy(null);
				operationRunning.current = false;
				void refreshPaths();
				return () => {
					alive.current = false;
					++readRequest.current;
					++operationRequest.current;
					operationRunning.current = false;
				};
			}, [props.sessionId]);

			react.useEffect(() => {
				if (!open) return undefined;
				const document = window.document;
				const onOutsidePointer = (event) => {
					if (overlayRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
					closeManager();
				};
				const onViewportChange = () => { closeManager(); };
				const onScroll = (event) => {
					if (overlayRef.current?.contains(event.target)) return;
					closeManager();
				};
				document.addEventListener("pointerdown", onOutsidePointer);
				window.addEventListener("resize", onViewportChange);
				window.addEventListener("scroll", onScroll, true);
				return () => {
					document.removeEventListener("pointerdown", onOutsidePointer);
					window.removeEventListener("resize", onViewportChange);
					window.removeEventListener("scroll", onScroll, true);
				};
			}, [open, busy]);

			react.useEffect(() => {
				if (open && busy === null && !reading && registry?.status === "ok") inputRef.current?.focus();
			}, [open, busy, reading, registry?.status]);

			const cancelRemove = (path) => {
				if (busy !== null) return;
				setPendingRemove(null);
				setReturnFocusTo(path);
				setFeedback(null);
			};
			const runMutation = async (kind, path) => {
				if (operationRunning.current || busy !== null || reading || registry?.status !== "ok") return;
				const verb = kind === "add" ? props.skillPathAdd : props.skillPathRemove;
				if (typeof verb !== "function") {
					setFeedback({ kind: "error", operation: kind, outcome: model.skillPathMutationOutcomeOf({ status: "unavailable", saved: false, error: { message: "Skill scan path mutations are unavailable on this client." } }) });
					return;
				}
				const request = ++operationRequest.current;
				operationRunning.current = true;
				setBusy(kind);
				setFeedback(null);
				setReturnFocusTo(null);
				let response;
				try {
					response = await verb(props.sessionId, { path, expectedRevision: registry.revision });
				} catch (error) {
					response = { status: "call-threw", saved: false, error: { code: "call-threw", message: error instanceof Error ? error.message : String(error) } };
				}
				if (!alive.current || request !== operationRequest.current) return;
				const outcome = model.skillPathMutationOutcomeOf(response);
				if (outcome.snapshot !== null) setRegistry(outcome.snapshot);
				if (outcome.saved) {
					if (kind === "add") setInput("");
					else setPendingRemove(null);
				}
				setFeedback({ kind: outcome.saved ? (outcome.phase === "degraded" ? "warning" : "success") : "error", operation: kind, outcome });
				try {
					const refreshes = [];
					if (outcome.refreshPaths) refreshes.push(refreshPaths());
					if (outcome.refreshCapabilities && typeof props.refreshCapabilities === "function") refreshes.push(props.refreshCapabilities());
					await Promise.all(refreshes);
				} catch (error) {
					if (alive.current && request === operationRequest.current) setFeedback(current => ({ ...current, refreshError: error instanceof Error ? error.message : String(error) }));
				} finally {
					if (alive.current && request === operationRequest.current) {
						operationRunning.current = false;
						setBusy(null);
					}
				}
			};
			const detail = (text) => {
				const message = feedback?.outcome?.error?.message;
				return typeof message === "string" && message !== "" && !text.includes(message) ? `${text} ${message}` : text;
			};
			let feedbackText = null;
			if (feedback) {
				const phase = feedback.outcome.phase;
				if (phase === "saved") feedbackText = feedback.operation === "add"
					? t("capability.skills.paths.added", "Directory added. Newly discovered Skills remain unselected until you select and Apply them.")
					: t("capability.skills.paths.removed", "Directory removed. Selection drafts, applied capabilities, and defaults were not rewritten.");
				else if (phase === "degraded") feedbackText = detail(t("capability.skills.paths.degraded", "The path change was saved, but the host reported a post-commit problem. Fresh registry, Skill listing, and receipt reads were requested; no rollback is claimed."));
				else if (phase === "validation-failed") feedbackText = detail(t("capability.skills.paths.validation", "The server rejected this directory. Enter an existing readable absolute directory or ~/directory; your input was kept and nothing was saved."));
				else if (phase === "duplicate") feedbackText = detail(t("capability.skills.paths.duplicate", "This canonical directory is already registered. Current paths were re-read; your input was kept and no duplicate was saved."));
				else if (phase === "not-found") feedbackText = detail(t("capability.skills.paths.notFound", "That canonical directory is no longer registered. Current paths were re-read; nothing was removed."));
				else if (phase === "revision-conflict") feedbackText = detail(t("capability.skills.paths.conflict", "The path registry changed elsewhere. Current paths were re-read; your input was kept and was not merged. Review the registry before retrying."));
				else if (phase === "indeterminate") feedbackText = detail(t("capability.skills.paths.indeterminate", "The operation outcome could not be confirmed. Fresh registry, Skill listing, and receipt reads were requested; your input was kept and no rollback is claimed."));
				else if (phase === "unavailable") feedbackText = detail(t("capability.skills.paths.unavailable", "The Skill scan path registry is unavailable. No path change was saved."));
				else feedbackText = detail(t("capability.skills.paths.failed", "The path operation failed. No saved change is claimed; your input was kept."));
				if (feedback.refreshError) feedbackText += ` ${t("capability.skills.paths.refreshFailed", "A follow-up refresh failed: {message}").replace("{message}", feedback.refreshError)}`;
			}
			const unavailable = registry?.status !== "ok";
			const controlsDisabled = busy !== null || reading || unavailable;
			const liveText = busy === "add" ? t("capability.skills.paths.adding", "Adding…")
				: busy === "remove" ? t("capability.skills.paths.removing", "Removing…")
					: reading && registry === null ? t("capability.skills.paths.loading", "Loading scan paths…") : null;
			const pathRow = (path) => {
				const confirming = pendingRemove === path;
				return react_jsx_runtime.jsx("div", {
					style: { ...S.list.card, margin: "4px 0", padding: "6px 8px" },
					"data-weir-skill-path": path,
					children: confirming ? react_jsx_runtime.jsxs("div", {
						role: "group",
						"aria-label": t("capability.skills.paths.confirmTitle", "Remove this Skill scan path?"),
						onKeyDown: (event) => {
							if (event.key === "Escape" && busy === null) {
								event.preventDefault();
								event.stopPropagation();
								cancelRemove(path);
							}
						},
						children: [
							react_jsx_runtime.jsx("div", { style: S.form.title, children: t("capability.skills.paths.confirmTitle", "Remove this Skill scan path?") }),
							react_jsx_runtime.jsxs("div", { style: { fontSize: "11px", lineHeight: "16px", color: LABEL2, overflowWrap: "anywhere" }, children: [
								t("capability.skills.paths.confirmBody", "Remove this canonical directory from the Profile? Selection drafts, applied capabilities, and defaults are not rewritten: "),
								react_jsx_runtime.jsx("code", { style: { color: LABEL1, fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)" }, children: path })
							] }),
							react_jsx_runtime.jsxs("div", { style: { ...S.form.actions, marginTop: "6px" }, children: [
								react_jsx_runtime.jsx("button", {
									type: "button", autoFocus: true, disabled: busy !== null,
									style: busy !== null ? { ...S.form.primary, ...S.footer.disabled } : S.form.primary,
									...ring,
									onClick: () => { void runMutation("remove", path); },
									children: busy === "remove" ? t("capability.skills.paths.removing", "Removing…") : t("capability.skills.paths.confirmRemove", "Remove path")
								}),
								react_jsx_runtime.jsx("button", {
									type: "button", disabled: busy !== null, style: S.form.ghost, ...ring,
									onClick: () => cancelRemove(path),
									children: t("capability.skills.paths.cancel", "Cancel")
								})
							] })
						]
					}) : react_jsx_runtime.jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
						children: [
							react_jsx_runtime.jsx("code", {
								title: path,
								style: { flex: 1, minWidth: 0, color: LABEL1, fontSize: "11px", lineHeight: "16px", fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)", overflowWrap: "anywhere" },
								children: path
							}),
							react_jsx_runtime.jsx("button", {
								type: "button", autoFocus: returnFocusTo === path, disabled: controlsDisabled,
								style: controlsDisabled ? { ...S.form.ghost, ...S.footer.disabled } : S.form.ghost,
								...ring,
								"aria-label": t("capability.skills.paths.removeAria", "Remove scan path {path}").replace("{path}", path),
								onClick: () => { setFeedback(null); setReturnFocusTo(null); setPendingRemove(path); },
								children: t("capability.skills.paths.remove", "Remove")
							})
						]
					})
				}, path);
			};
			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						ref: triggerRef,
						style: S.path.trigger,
						...ring,
						...hover(HOVER_BG, "none"),
						onClick: openManager,
						"aria-label": t("capability.skills.paths.manage", "Manage Skill scan paths"),
						title: t("capability.skills.paths.manage", "Manage Skill scan paths"),
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						"data-weir-skill-path-trigger": "",
						children: [
							react_jsx_runtime.jsx(Icon, { name: "folder", size: 13 }),
							registry?.status === "ok" ? react_jsx_runtime.jsx("span", {
								style: S.path.count,
								"aria-hidden": "true",
								"data-weir-skill-path-count": "",
								children: String(registry.paths.length)
							}) : null
						]
					}),
					open ? react_jsx_runtime.jsxs("section", {
						ref: overlayRef,
						role: "dialog",
						"aria-modal": false,
						style: S.path.overlay(position),
						"aria-label": t("capability.skills.paths.title", "Custom Skill scan paths"),
						"aria-busy": busy !== null || reading,
						"data-weir-skill-path-manager": "",
						onKeyDown: (event) => {
							if (event.key !== "Escape" || busy !== null) return;
							event.preventDefault();
							event.stopPropagation();
							if (pendingRemove !== null) cancelRemove(pendingRemove);
							else closeManager();
						},
						children: [
							react_jsx_runtime.jsxs("div", { style: S.list.cardHead, children: [
								react_jsx_runtime.jsx("span", { children: t("capability.skills.paths.title", "Custom Skill scan paths") }),
								react_jsx_runtime.jsxs("div", { style: { display: "flex", alignItems: "center", gap: "4px" }, children: [
									react_jsx_runtime.jsx("button", {
										type: "button", onClick: () => { void refreshPaths(); }, disabled: busy !== null || reading,
										style: busy !== null || reading ? { ...S.form.ghost, ...S.footer.disabled } : S.form.ghost,
										...ring,
										children: t("capability.skills.paths.refresh", "Refresh paths")
									}),
									react_jsx_runtime.jsx("button", {
										type: "button", onClick: closeManager, disabled: busy !== null,
										style: busy !== null ? { ...S.header.close, ...S.footer.disabled } : S.header.close,
										...ring,
										"aria-label": t("capability.close", "Close"),
										title: t("capability.close", "Close"),
										children: react_jsx_runtime.jsx(Icon, { name: "x", size: 12 })
									})
								] })
							] }),
							react_jsx_runtime.jsx("div", { style: { fontSize: "11px", lineHeight: "16px", color: MUTED, marginBottom: "6px" }, children: t("capability.skills.paths.description", "Profile-scoped directories shared by Weir sessions. Path changes never select Skills, Apply a draft, or rewrite defaults.") }),
							react_jsx_runtime.jsxs("form", {
								"aria-label": t("capability.skills.paths.addLabel", "Skill scan directory"),
								onSubmit: (event) => { event.preventDefault(); void runMutation("add", input); },
								children: [
									react_jsx_runtime.jsx("label", {
										style: { display: "flex", flexDirection: "column", gap: "3px", ...S.form.title },
										children: [
											t("capability.skills.paths.addLabel", "Skill scan directory"),
											react_jsx_runtime.jsx("input", {
												ref: inputRef,
												value: input, onChange: (event) => setInput(event.target.value), disabled: controlsDisabled,
												placeholder: t("capability.skills.paths.placeholder", "~/skills or /absolute/path"),
												style: S.form.input, ...ring,
												"aria-invalid": feedback?.kind === "error" && feedback.operation === "add" ? true : undefined
											})
										]
									}),
									react_jsx_runtime.jsx("div", { style: { ...S.form.actions, marginTop: "6px" }, children: react_jsx_runtime.jsx("button", {
										type: "submit", disabled: controlsDisabled,
										style: controlsDisabled ? { ...S.form.primary, ...S.footer.disabled } : S.form.primary,
										...ring,
										children: busy === "add" ? t("capability.skills.paths.adding", "Adding…") : t("capability.skills.paths.add", "Add path")
									}) })
								]
							}),
							liveText ? react_jsx_runtime.jsx("div", { role: "status", "aria-live": "polite", style: { ...S.form.title, marginTop: "6px" }, children: liveText }) : null,
							registry?.error ? react_jsx_runtime.jsx("div", { role: "alert", style: { ...S.form.error, marginTop: "6px" }, children: `${t("capability.skills.paths.readFailed", "The path registry could not be read. Existing rows, when present, are stale.")} ${registry.error.message}` }) : null,
							feedbackText ? react_jsx_runtime.jsx("div", {
								role: feedback.kind === "success" ? "status" : "alert",
								"aria-live": feedback.kind === "success" ? "polite" : "assertive",
								"data-weir-skill-path-feedback": feedback.kind,
								style: { ...(feedback.kind === "success" ? S.form.title : S.form.error), marginTop: "6px", color: feedback.kind === "success" ? SUCCESS : feedback.kind === "warning" ? WARN_TEXT : DANGER },
								children: feedbackText
							}) : null,
							registry?.status === "ok" && registry.paths.length === 0
								? react_jsx_runtime.jsx("div", { style: { ...S.form.title, marginTop: "6px" }, children: t("capability.skills.paths.empty", "No custom scan paths are registered.") })
								: null,
							...(registry?.paths ?? []).map(pathRow)
						]
					}) : null
				]
			});
		}
		function CapabilityManagerPanel(props) {
			const model = props.model;
			// Echo-guard like the Badge: an unregistered dictionary entry must
			// surface the in-code fallback, never the raw key.
			const t = (key, fallback) => {
				// The host locale's second parameter is an interpolation VARS object,
				// never a fallback string — passing the fallback there crashes
				// translate whenever the registered template carries {placeholders}
				// (the 2026-10-05 badge slot crash). Dictionary templates keep their
				// placeholders for the call site's own .replace interpolation.
				const value = typeof props.t === "function" ? props.t(key) : undefined;
				return typeof value === "string" && value !== key ? value : fallback;
			};
			const [tab, setTab] = react.useState("skills");
			const [query, setQuery] = react.useState("");
			const [listing, setListing] = react.useState(null);
			const [conditions, setConditions] = react.useState(null);
			// Draft editing (12.3): seeded from the server receipt, toggles
			// recompute dirty, Apply goes through /capabilities apply with the
			// draft's CAS revision and a fresh request ID.
			const [draft, setDraft] = react.useState(null);
			const [receiptState, setReceiptState] = react.useState(null);
			const receiptRequest = react.useRef(0);
			const listingRequest = react.useRef(0);
			const applying = react.useRef(false);
			const [commit, setCommit] = react.useState(null);

			const refreshReceipt = async () => {
				if (typeof props.fetchReceipt !== "function") return null;
				const request = ++receiptRequest.current;
				try {
					const receipt = await props.fetchReceipt(props.sessionId);
					if (request === receiptRequest.current) {
						setReceiptState(model.badgeStateOf(receipt, null));
						setDraft(current => model.draftAfterRefresh(current, receipt));
					}
					return receipt;
				} catch {
					if (request === receiptRequest.current) {
						setReceiptState(null);
						setDraft(current => model.draftAfterRefresh(current, null));
					}
					return null;
				}
			};
			const refreshListing = async () => {
				if (typeof props.fetchListing !== "function") return null;
				const request = ++listingRequest.current;
				try {
					const data = await props.fetchListing(props.sessionId);
					const folded = model.mcpListingAfterRead(listing, data ?? { error: true });
					if (request === listingRequest.current) setListing(folded);
					return folded;
				} catch {
					const folded = model.mcpListingAfterRead(listing, { error: true });
					if (request === listingRequest.current) setListing(folded);
					return folded;
				}
			};
			const refreshAll = async () => {
				const [freshListing] = await Promise.all([refreshListing(), refreshReceipt()]);
				return { listing: freshListing };
			};
			react.useEffect(() => {
				let alive = true;
				setListing(null);
				setConditions(null);
				void refreshAll();
				if (typeof props.fetchConditions === "function") {
					props.fetchConditions(props.sessionId).then((data) => { if (alive) setConditions(data); }).catch(() => {});
				}
				return () => { alive = false; ++receiptRequest.current; ++listingRequest.current; };
			}, [props.sessionId]);
			const toggle = (kind, name) => {
				if (draft && commit?.phase !== "submitting") { setDraft(model.draftToggle(draft, kind, name)); setCommit(null); }
			};
			const applyDraft = () => {
				const check = model.skillDraftConflicts(draft, listing);
				if (applying.current || !draft || !draft.dirty || (draft.unknownBaseline && !draft.overwriteConfirmed) || check.selected.length || check.unresolved.some(item => item.state === "ambiguous") || typeof props.applySelection !== "function") return;
				applying.current = true;
				const requestId = crypto.randomUUID();
				setCommit({ phase: "submitting", requestId });
				props.applySelection(props.sessionId, {
					requestId,
					expectedRevision: draft.revision,
					skills: draft.skills,
					mcpServers: draft.mcpServers,
				}).then((response) => {
					applying.current = false;
					const outcome = model.commitOutcomeOf(response);
					setCommit(outcome);
					if (outcome.phase === "applied") {
						setDraft(current => current ? { ...current, applied: { skills: [...current.skills], mcpServers: [...current.mcpServers], unresolvedRefs: [...current.unresolvedRefs] }, revision: outcome.revision, dirty: false, appliedDigest: undefined, appliedSourceIssue: "receipt" } : null);
						refreshAll();
						if (typeof props.onApplied === "function") props.onApplied();
					}
				}).catch(() => { applying.current = false; setCommit({ phase: "failed", error: "apply request failed", draftKept: true }); });
			};
			const discardDraft = () => {
				if (draft) setDraft({ ...draft, skills: [...draft.applied.skills], mcpServers: [...draft.applied.mcpServers], unresolvedRefs: [], dirty: false });
				setCommit(null);
			};
			// Load-into-draft staging (preset view): only the preset's resolved
			// sets enter the local draft; Apply stays the only path that changes
			// the session's applied set.
			const stagePreset = (document) => {
				if (commit?.phase === "submitting") return;
				const resolveName = (name) => {
					const matches = (listing?.skills ?? []).filter(row => row.status === "parsed" && row.name === name && row.identity);
					return matches.length === 1 ? matches[0].identity : undefined;
				};
				setDraft(model.draftFromPreset(document, draft, resolveName));
				setCommit(null);
			};
			const frameStyle = props.shell === "sidebar" ? S.frame.sidebar : S.frame.popover;
			const conditionState = model.managerConditionState(conditions?.conditions ?? conditions);
			// Loading: row-height skeleton blocks (D1) with the loading text kept
			// for the a11y tree — the state is announced, not just shown.
			if (listing === null) {
				return react_jsx_runtime.jsxs("div", {
					style: frameStyle,
					role: "status",
					children: [
						react_jsx_runtime.jsxs("div", {
							style: S.state.skeleton,
							"aria-hidden": "true",
							children: [
								react_jsx_runtime.jsx("div", { style: S.state.bone("34%", "12px") }),
								react_jsx_runtime.jsx("div", { style: S.state.bone("18%", "10px") }),
								...[0, 1, 2].map((index) => react_jsx_runtime.jsxs("div", {
									style: S.state.skeletonRow,
									children: [
										react_jsx_runtime.jsx("span", { style: S.state.bone("13px", "13px") }),
										react_jsx_runtime.jsxs("span", {
											style: { display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: 0 },
											children: [
												react_jsx_runtime.jsx("span", { style: S.state.bone(`${58 - index * 7}%`, "10px") }),
												react_jsx_runtime.jsx("span", { style: S.state.bone(`${42 - index * 6}%`, "9px") })
											]
										})
									]
								}, index))
							]
						}),
						react_jsx_runtime.jsx("span", { style: S.state.srOnly, children: t("capability.loading", "Loading capabilities…") })
					]
				});
			}
			if (listing.error === true) {
				return react_jsx_runtime.jsx("div", {
					style: frameStyle,
					children: react_jsx_runtime.jsx(StatePanel, {
						icon: "warn",
						color: DANGER,
						title: t("capability.error", "Capabilities unavailable for this session."),
						description: (draft?.skills ?? []).some(entry => typeof entry === "string")
							? t("capability.inventoryUnavailableName", "The listing is unavailable; legacy names remain unresolved in the draft. Retry later; no source was selected.")
							: t("capability.state.errorDesc", "The capability listing could not be loaded.")
					})
				});
			}
			if (listing.error) {
				return react_jsx_runtime.jsx("div", {
					style: frameStyle,
					children: react_jsx_runtime.jsx(StatePanel, {
						icon: "info",
						title: t("capability.unavailable", "Capabilities are unavailable in this session."),
						description: t("capability.state.unavailableDesc", "This session's composition exposes no capability surface.")
					})
				});
			}
			if (conditionState === "unsupported") {
				return react_jsx_runtime.jsx("div", {
					style: frameStyle,
					children: react_jsx_runtime.jsx(StatePanel, {
						icon: "warn",
						color: WARN_TEXT,
						title: t("capability.unsupported", "Unsupported: consistency conditions are not met on this host."),
						description: t("capability.state.unsupportedDesc", "The manager stays read-only here rather than guessing at state.")
					})
				});
			}
			const partition = model.partitionManagerListing(listing);
			const skillRows = model.groupSkillRows(model.filterSkillRows(partition.skills, query));
			const skillKeys = new Set((draft?.skills ?? []).map(model.skillEntryKeyOf));
			const check = model.skillDraftConflicts(draft, listing);
			const sourceLabels = model.skillSourceLabels(partition.skills);
			const sourceOf = identity => (sourceLabels[model.skillIdentityKeyOf(identity)] ?? t("capability.sourceUnknown", "unknown source"))
				.replace(" · source ", t("capability.sourceNumber", " · source "));
			const selectedKeys = new Set(check.selected.flatMap(item => item.identities.map(model.skillEntryKeyOf)));
			const ambiguous = check.unresolved.filter(item => item.state === "ambiguous");
			const unknown = check.unresolved.filter(item => item.state === "unknown");
			const replaceName = (name, identity) => { if (commit?.phase !== "submitting") { setDraft(model.resolveSkillName(draft, name, identity)); setCommit(null); } };
			const warningText = [
				...check.selected.map(item => t("capability.sameNameWarning", "{name}: only one source can be enabled in this session. Uncheck one: {sources}.")
					.replace("{name}", item.name).replace("{sources}", item.identities.map(sourceOf).join(", "))),
				...ambiguous.map(item => t("capability.unresolvedNameWarning", "{name}: legacy name has no chosen source. Choose an exact source or remove the name: {sources}.")
					.replace("{name}", item.name).replace("{sources}", item.candidates.map(sourceOf).join(", "))),
				...unknown.map(item => t("capability.unknownLegacyName", "{name}: no matching Skill in the current listing. Refresh the listing or remove this legacy name.").replace("{name}", item.name))
			];
			const selectionDisabled = draft === null || commit?.phase === "submitting";
			const addBlock = null;
			const pathManager = tab === "skills" ? react_jsx_runtime.jsx(SkillPathManager, {
				sessionId: props.sessionId, model, t,
				fetchSkillPaths: props.fetchSkillPaths, skillPathAdd: props.skillPathAdd, skillPathRemove: props.skillPathRemove,
				refreshCapabilities: refreshAll
			}) : null;
			const skillRow = (skill, index) => {
				const selected = skillKeys.has(model.skillEntryKeyOf(skill.identity ?? skill.name));
				const selectedConflict = selectedKeys.has(model.skillEntryKeyOf(skill.identity));
				const source = skill.identity ? sourceOf(skill.identity) : skill.source;
				const rest = selected ? tint(ACCENT, 8) : "transparent";
				return react_jsx_runtime.jsxs("label", {
					style: { ...S.row.base, background: rest },
					...ring,
					...hover(selected ? tint(ACCENT, 12) : HOVER_BG, rest),
					children: [
						react_jsx_runtime.jsx("input", {
							type: "checkbox",
							style: S.row.checkbox,
							checked: selected,
							disabled: selectionDisabled,
							"aria-label": `${skill.name} — ${source}`,
							"aria-invalid": selectedConflict || undefined,
							onChange: () => toggle("skills", skill.identity ?? skill.name)
						}),
						react_jsx_runtime.jsxs("span", { style: S.row.text, children: [
							react_jsx_runtime.jsxs("span", { style: S.row.nameLine, children: [
								react_jsx_runtime.jsx("span", { style: S.row.name, title: skill.name, children: skill.name }),
								react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.scope(skill.scopeKey) }, children: source }),
								selectedConflict || skill.conflict ? react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.warn }, children: t("capability.conflict", "conflict") }) : null,
								skill.missing ? react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.danger }, title: skill.status, children: t("capability.missing", "missing") }) : null
							] }),
							skill.description ? react_jsx_runtime.jsx("span", { style: S.row.desc, title: skill.description, children: skill.description }) : null
						] })
					]
				}, `${model.skillIdentityKeyOf(skill.identity) ?? `${skill.scopeKey}:${skill.name}`}:${index}`);
			};
			const legacyActions = [...ambiguous, ...unknown].map(item => react_jsx_runtime.jsxs("div", { style: S.list.card, children: [
				react_jsx_runtime.jsx("div", { style: S.form.title, children: t("capability.unresolvedNameTitle", "Choose a source for legacy name {name}").replace("{name}", item.name) }),
				react_jsx_runtime.jsxs("div", { style: S.form.actions, children: [
					...item.candidates.map(identity => react_jsx_runtime.jsx("button", { type: "button", style: S.form.ghost, ...ring, disabled: selectionDisabled, onClick: () => replaceName(item.name, identity), children: t("capability.replaceName", "Replace {name} with {source}").replace("{name}", item.name).replace("{source}", sourceOf(identity)) }, model.skillIdentityKeyOf(identity))),
					react_jsx_runtime.jsx("button", { type: "button", style: S.form.ghost, ...ring, disabled: selectionDisabled, onClick: () => replaceName(item.name, null), children: t("capability.removeName", "Remove legacy name {name}").replace("{name}", item.name) })
				] })
			] }, item.name));
			const body = tab === "skills"
				? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
						children: [...(skillRows.length === 0 ? [react_jsx_runtime.jsx(StatePanel, { icon: "search", title: t("capability.noSkills", "No skills match.") })] : skillRows.map((group) => react_jsx_runtime.jsxs("div", {
							style: S.list.group,
							children: [
								react_jsx_runtime.jsxs("div", {
									style: S.list.groupTitle(props.shell),
									children: [
										react_jsx_runtime.jsx("span", { children: group.label }),
										react_jsx_runtime.jsx("span", { style: S.list.count, children: String(group.rows.length) })
									]
								}),
								...group.rows.map(skillRow)
							]
						}, group.key))), ...legacyActions]
					})
				: tab === "mcp"
					? (() => {
						if (typeof props.McpManagerView !== "function") return react_jsx_runtime.jsx(StatePanel, { icon: "warn", color: WARN_TEXT, title: t("capability.mcp.unavailableView", "MCP management is unavailable on this client.") });
						const content = react_jsx_runtime.jsx(props.McpManagerView, {
							sessionId: props.sessionId, model, t, listing,
							managed: partition.mcpManaged, unmanaged: partition.mcpUnmanaged,
							draft, toggle, selectionDisabled, refreshAll,
							mcpPreview: props.mcpPreview, mcpMutate: props.mcpMutate, mcpBatch: props.mcpBatch,
						});
						return typeof props.McpManagerBoundary === "function"
							? react_jsx_runtime.jsx(props.McpManagerBoundary, { t, children: content })
							: content;
					})()
					: react_jsx_runtime.jsx(LazyCapabilityPresets, {
						sessionId: props.sessionId,
						model,
						t,
						draft,
						stagePreset,
						loadPresets: props.loadPresets,
						fetchPresets: props.fetchPresets,
						presetSave: props.presetSave,
						presetLoad: props.presetLoad,
						presetDelete: props.presetDelete,
						presetExport: props.presetExport,
						presetImport: props.presetImport,
						defaultGet: props.defaultGet,
						defaultSave: props.defaultSave,
						defaultClear: props.defaultClear
					});
			// Footer commit bar (12.3): the dirty diff summary (+n/−m) ahead of
			// the same Apply/Discard/commit-phase semantics as before.
			const diff = draft ? model.draftDiffOf(draft) : null;
			const diffParts = diff && diff.any && !draft?.unknownBaseline
				? [
					diff.skillsAdded > 0 ? { added: true, text: t("capability.diff.addSkills", "+{n} skills").replace("{n}", String(diff.skillsAdded)) } : null,
					diff.skillsRemoved > 0 ? { added: false, text: t("capability.diff.removeSkills", "−{n} skills").replace("{n}", String(diff.skillsRemoved)) } : null,
					diff.mcpAdded > 0 ? { added: true, text: t("capability.diff.addMcp", "+{n} MCP").replace("{n}", String(diff.mcpAdded)) } : null,
					diff.mcpRemoved > 0 ? { added: false, text: t("capability.diff.removeMcp", "−{n} MCP").replace("{n}", String(diff.mcpRemoved)) } : null
				].filter(Boolean)
				: null;
			const applyDisabled = !draft || !draft.dirty || (draft.unknownBaseline && !draft.overwriteConfirmed) || commit?.phase === "submitting" || check.selected.length > 0 || ambiguous.length > 0;
			// Session state summary (sidebar header only): the APPLIED counts,
			// same template the composer Badge renders.
			const appliedSummary = receiptState?.known
				? t("capability.badge", "{skills} skills · {mcp} MCP").replace("{skills}", String(receiptState.applied.skills)).replace("{mcp}", String(receiptState.applied.mcpServers))
				: receiptState?.degraded ? t("capability.effectiveUnknownShort", "Skills ? · MCP ?") : null;
			return react_jsx_runtime.jsxs("div", { style: frameStyle, children: [
				react_jsx_runtime.jsxs("div", { style: S.header.row, children: [
					react_jsx_runtime.jsx("button", { type: "button", style: S.tabs.segment(tab === "skills", "first"), ...ring, onClick: () => setTab("skills"), "aria-pressed": tab === "skills", children: t("capability.tab.skills", "Skills") }),
					react_jsx_runtime.jsx("button", { type: "button", style: S.tabs.segment(tab === "mcp", "middle"), ...ring, onClick: () => setTab("mcp"), "aria-pressed": tab === "mcp", children: t("capability.tab.mcp", "MCP") }),
					react_jsx_runtime.jsx("button", { type: "button", style: S.tabs.segment(tab === "presets", "last"), ...ring, onClick: () => setTab("presets"), "aria-pressed": tab === "presets", children: t("capability.tab.presets", "Presets") }),
					props.shell === "sidebar" && appliedSummary
						? react_jsx_runtime.jsx("span", { style: S.header.summary, title: receiptState?.degraded ? t("capability.effectiveUnknown", "Applied count unknown — refresh and check Skill sources") : undefined, children: appliedSummary })
						: null,
					react_jsx_runtime.jsxs("span", {
						style: S.search.wrap,
						children: [
							react_jsx_runtime.jsx("span", { style: S.search.icon, children: react_jsx_runtime.jsx(Icon, { name: "search", size: 12 }) }),
							react_jsx_runtime.jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: t("capability.search", "Search"), style: S.search.input, ...ring })
						]
					}),
					pathManager,
					typeof props.onClose === "function"
						? react_jsx_runtime.jsx("button", {
							type: "button",
							style: S.header.close,
							...ring,
							...hover(HOVER_BG, "none"),
							onClick: props.onClose,
							"aria-label": t("capability.close", "Close"),
							children: react_jsx_runtime.jsx(Icon, { name: "x", size: 12 })
						})
						: null
				] }),
				// The sidebar shell pins the view region between header and the Apply
				// footer as the scroll container (minHeight:0 lets the flex child
				// shrink below its content height). The popover shell keeps the
				// EXACT historical children shape — the pinned manager test indexes
				// root children[1] as addBlock.
				...(props.shell === "sidebar"
					? [react_jsx_runtime.jsxs("div", { style: S.list.scroll, children: [addBlock, body] })]
					: [addBlock, body]),
				receiptState?.degraded ? react_jsx_runtime.jsx("div", { role: "status", "aria-live": "polite", style: { color: WARN_TEXT, lineHeight: "16px", padding: "6px" }, children: t("capability.effectiveUnknownDetail", "Accepted revision; effective capabilities cannot be verified. Refresh and check Skill sources. Draft kept; only Apply changes the session.") }) : null,
				draft !== null ? react_jsx_runtime.jsxs("div", { style: S.footer.bar, children: [
					diffParts ? react_jsx_runtime.jsx("span", { style: S.footer.diff, "data-weir-capability-diff": "", children: diffParts.map((part, index) => react_jsx_runtime.jsx("span", { style: S.footer.diffBadge(part.added), children: part.text }, index)) }) : null,
					warningText.length ? react_jsx_runtime.jsx("div", { role: "alert", "aria-live": "assertive", style: { width: "100%", color: WARN_TEXT, lineHeight: "16px" }, children: warningText.join(" ") }) : null,
					draft.unknownBaseline ? react_jsx_runtime.jsx("div", { role: "alert", style: { width: "100%", color: WARN_TEXT, lineHeight: "16px" }, children: t("capability.unknownOverwriteRisk", "Previous selection is unknown. Applying this draft may replace other accepted Skills and MCP servers. Review the full selection before confirming.") }) : null,
					draft.unknownBaseline && draft.dirty && !draft.overwriteConfirmed ? react_jsx_runtime.jsx("button", { type: "button", style: S.footer.discard, ...ring, disabled: commit?.phase === "submitting", onClick: () => setDraft(current => current ? { ...current, overwriteConfirmed: true } : null), children: t("capability.confirmUnknownOverwrite", "Confirm replacing unknown selection") }) : null,
					react_jsx_runtime.jsx("button", {
						type: "button",
						style: applyDisabled ? { ...S.footer.apply, ...S.footer.disabled } : S.footer.apply,
						...ring,
						...(applyDisabled ? {} : hover(ACCENT_HOVER, ACCENT)),
						disabled: applyDisabled,
						onClick: applyDraft,
						children: commit?.phase === "submitting" ? t("capability.applying", "Applying…") : t("capability.apply", "Apply")
					}),
					draft.dirty ? react_jsx_runtime.jsx("button", { type: "button", style: S.footer.discard, ...ring, ...hover(HOVER_BG, "none"), onClick: discardDraft, children: t("capability.discard", "Discard") }) : null,
					commit?.phase === "applied" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(receiptState?.degraded ? WARN : SUCCESS), children: receiptState?.degraded ? t("capability.acceptedUnknown", "Accepted · effective count unknown") : t("capability.applied", "Applied") }) : null,
					commit?.phase === "applied" && Array.isArray(commit.skipped) && commit.skipped.length > 0
						? react_jsx_runtime.jsx("span", { style: S.footer.chip(WARN), title: commit.skipped.map(entry => `${entry.name} — ${entry.reason}`).join("\n"), children: t("capability.appliedSkipped", "skipped {n} (not applicable here)").replace("{n}", String(commit.skipped.length)) })
						: null,
					commit?.phase === "failed" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(DANGER), role: "alert", children: t("capability.failed", "Failed — draft kept") }) : null,
					commit?.phase === "same-name-conflict" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(DANGER), role: "alert", children: t("capability.serverSameName", "Server rejected same-name Skill {names}. Uncheck one source, or refresh the listing; draft kept.").replace("{names}", commit.names.join(", ") || t("capability.unknownName", "unknown name")) }) : null,
					commit?.phase === "missing" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(WARN), role: "alert", children: t("capability.serverMissing", "Server could not resolve {names}. Refresh the listing and choose an exact source or remove the name; draft kept.").replace("{names}", commit.names.join(", ") || t("capability.unknownName", "unknown name")) }) : null,
					commit?.phase === "revision-conflict" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(WARN), children: t("capability.conflictState", "Changed elsewhere — review current state") }) : null,
					commit?.phase === "indeterminate" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(MUTED), children: t("capability.pending", "Result pending — query the receipt") }) : null
				] }) : null
			] });
		}
		// View-owned locale data face. The entry merges this with the model's
		// established capability dictionary when either shared shell arrives.
		const dictionaries = {
			en: {
				"capability.skills.paths.title": "Custom Skill scan paths",
				"capability.skills.paths.manage": "Manage Skill scan paths",
				"capability.skills.paths.description": "Profile-scoped directories shared by Weir sessions. Path changes never select Skills, Apply a draft, or rewrite defaults.",
				"capability.skills.paths.addLabel": "Skill scan directory",
				"capability.skills.paths.placeholder": "~/skills or /absolute/path",
				"capability.skills.paths.add": "Add path",
				"capability.skills.paths.adding": "Adding…",
				"capability.skills.paths.removing": "Removing…",
				"capability.skills.paths.loading": "Loading scan paths…",
				"capability.skills.paths.refresh": "Refresh paths",
				"capability.skills.paths.refreshFailed": "A follow-up refresh failed: {message}",
				"capability.skills.paths.readFailed": "The path registry could not be read. Existing rows, when present, are stale.",
				"capability.skills.paths.empty": "No custom scan paths are registered.",
				"capability.skills.paths.added": "Directory added. Newly discovered Skills remain unselected until you select and Apply them.",
				"capability.skills.paths.removed": "Directory removed. Selection drafts, applied capabilities, and defaults were not rewritten.",
				"capability.skills.paths.degraded": "The path change was saved, but the host reported a post-commit problem. Fresh registry, Skill listing, and receipt reads were requested; no rollback is claimed.",
				"capability.skills.paths.validation": "The server rejected this directory. Enter an existing readable absolute directory or ~/directory; your input was kept and nothing was saved.",
				"capability.skills.paths.duplicate": "This canonical directory is already registered. Current paths were re-read; your input was kept and no duplicate was saved.",
				"capability.skills.paths.notFound": "That canonical directory is no longer registered. Current paths were re-read; nothing was removed.",
				"capability.skills.paths.conflict": "The path registry changed elsewhere. Current paths were re-read; your input was kept and was not merged. Review the registry before retrying.",
				"capability.skills.paths.indeterminate": "The operation outcome could not be confirmed. Fresh registry, Skill listing, and receipt reads were requested; your input was kept and no rollback is claimed.",
				"capability.skills.paths.unavailable": "The Skill scan path registry is unavailable. No path change was saved.",
				"capability.skills.paths.failed": "The path operation failed. No saved change is claimed; your input was kept.",
				"capability.skills.paths.remove": "Remove",
				"capability.skills.paths.removeAria": "Remove scan path {path}",
				"capability.skills.paths.confirmTitle": "Remove this Skill scan path?",
				"capability.skills.paths.confirmBody": "Remove this canonical directory from the Profile? Selection drafts, applied capabilities, and defaults are not rewritten: ",
				"capability.skills.paths.confirmRemove": "Remove path",
				"capability.skills.paths.cancel": "Cancel"
			},
			zh: {
				"capability.skills.paths.title": "自定义技能扫描路径",
				"capability.skills.paths.manage": "管理技能扫描路径",
				"capability.skills.paths.description": "由 Weir 会话共享的 Profile 级目录。路径变更不会选择技能、应用草稿或改写默认值。",
				"capability.skills.paths.addLabel": "技能扫描目录",
				"capability.skills.paths.placeholder": "~/skills 或 /absolute/path",
				"capability.skills.paths.add": "添加路径",
				"capability.skills.paths.adding": "正在添加…",
				"capability.skills.paths.removing": "正在移除…",
				"capability.skills.paths.loading": "正在加载扫描路径…",
				"capability.skills.paths.refresh": "刷新路径",
				"capability.skills.paths.refreshFailed": "后续刷新失败：{message}",
				"capability.skills.paths.readFailed": "无法读取路径注册表；如有既有行，现已过期。",
				"capability.skills.paths.empty": "尚未登记自定义扫描路径。",
				"capability.skills.paths.added": "目录已添加。新发现的技能保持未选状态，需手动选择并应用后才会启用。",
				"capability.skills.paths.removed": "目录已移除。选择草稿、已应用能力和默认值均未被改写。",
				"capability.skills.paths.degraded": "路径变更已保存，但宿主报告了提交后检查问题。已请求重新读取注册表、技能清单和回执；不声称已回滚。",
				"capability.skills.paths.validation": "服务端拒绝了此目录。请输入存在且可读的绝对目录或 ~/directory；输入已保留，未保存任何变更。",
				"capability.skills.paths.duplicate": "此规范化目录已登记。已重新读取当前路径；输入已保留，未保存重复项。",
				"capability.skills.paths.notFound": "此规范化目录已不在注册表中。已重新读取当前路径；未移除任何项目。",
				"capability.skills.paths.conflict": "路径注册表已在别处变更。已重新读取当前路径；输入已保留且未合并。重试前请核对注册表。",
				"capability.skills.paths.indeterminate": "无法确认操作结果。已请求重新读取注册表、技能清单和回执；输入已保留，不声称已回滚。",
				"capability.skills.paths.unavailable": "技能扫描路径注册表不可用。未保存路径变更。",
				"capability.skills.paths.failed": "路径操作失败。不声称变更已保存；输入已保留。",
				"capability.skills.paths.remove": "移除",
				"capability.skills.paths.removeAria": "移除扫描路径 {path}",
				"capability.skills.paths.confirmTitle": "移除此技能扫描路径？",
				"capability.skills.paths.confirmBody": "从此 Profile 移除以下规范化目录？选择草稿、已应用能力和默认值均不会被改写：",
				"capability.skills.paths.confirmRemove": "移除路径",
				"capability.skills.paths.cancel": "取消"
			}
		};
		exports.dictionaries = dictionaries;
		exports.CapabilityManagerPanel = CapabilityManagerPanel;
		return module.exports;
	}
});
