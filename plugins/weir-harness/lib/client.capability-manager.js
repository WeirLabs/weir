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
			onFocus: (event) => paint(event, { outline: "2px solid var(--dsw-alias-focus-ring, currentColor)", outlineOffset: "1px" }),
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
				summary: { fontSize: "11px", lineHeight: "16px", color: MUTED, whiteSpace: "nowrap", flex: "none", marginLeft: "2px" },
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
			const [commit, setCommit] = react.useState(null);
			// Managed MCP add form (8.1/8.2): per-field errors are derived by the
			// pure model (mcpAddErrorsOf) and shown after the first submit
			// attempt; the hook lives with the others — a hook after an early
			// return crashes with React #310.
			const [addForm, setAddForm] = react.useState({ open: false, identity: "", label: "", command: "", args: "", showErrors: false, error: null, busy: false });

			const refreshAll = () => {
				if (typeof props.fetchListing === "function") {
					props.fetchListing(props.sessionId).then((data) => setListing(data ?? { error: true })).catch(() => setListing({ error: true }));
				}
				if (typeof props.fetchReceipt === "function") {
					props.fetchReceipt(props.sessionId).then((receipt) => setDraft(receipt ? model.draftFromReceipt(receipt) : null)).catch(() => {});
				}
			};
			react.useEffect(() => {
				let alive = true;
				if (typeof props.fetchListing === "function") {
					// A failed or absent verb settles into an explicit error
					// state — never a perpetual loading panel (12.2).
					props.fetchListing(props.sessionId).then((data) => { if (alive) setListing(data ?? { error: true }); }).catch(() => { if (alive) setListing({ error: true }); });
				}
				if (typeof props.fetchConditions === "function") {
					props.fetchConditions(props.sessionId).then((data) => { if (alive) setConditions(data); }).catch(() => {});
				}
				if (typeof props.fetchReceipt === "function") {
					props.fetchReceipt(props.sessionId).then((receipt) => { if (alive) setDraft(receipt ? model.draftFromReceipt(receipt) : null); }).catch(() => {});
				}
				return () => { alive = false; };
			}, [props.sessionId]);
			const toggle = (kind, name) => {
				if (draft && commit?.phase !== "submitting") setDraft(model.draftToggle(draft, kind, name));
			};
			const applyDraft = () => {
				if (!draft || !draft.dirty || typeof props.applySelection !== "function") return;
				const requestId = crypto.randomUUID();
				setCommit({ phase: "submitting", requestId });
				props.applySelection(props.sessionId, {
					requestId,
					expectedRevision: draft.revision,
					skills: draft.skills,
					mcpServers: draft.mcpServers,
				}).then((response) => {
					const outcome = model.commitOutcomeOf(response);
					setCommit(outcome);
					if (outcome.phase === "applied") {
						refreshAll();
						// The Badge holds its own receipt state — tell it to re-pull
						// so the composer counts follow the Apply immediately.
						if (typeof props.onApplied === "function") props.onApplied();
					}
				}).catch(() => setCommit({ phase: "failed", error: "apply request failed", draftKept: true }));
			};
			const discardDraft = () => {
				if (draft) setDraft({ ...draft, skills: [...draft.applied.skills], mcpServers: [...draft.applied.mcpServers], dirty: false });
				setCommit(null);
			};
			// Load-into-draft staging (preset view): only the preset's resolved
			// sets enter the local draft; Apply stays the only path that changes
			// the session's applied set.
			const stagePreset = (document) => {
				if (commit?.phase === "submitting") return;
				setDraft(model.draftFromPreset(document, draft));
				setCommit(null);
			};
			// Managed MCP add form (8.1/8.2): registers a stdio server and mounts
			// it immediately via /capabilities mcp-add. Client-side per-field
			// validation first; the server's own status still surfaces verbatim.
			const addErrors = model.mcpAddErrorsOf(addForm);
			const submitAdd = () => {
				if (typeof props.mcpAdd !== "function" || addForm.busy) return;
				if (Object.keys(addErrors).length > 0) {
					setAddForm({ ...addForm, showErrors: true, error: null });
					return;
				}
				setAddForm({ ...addForm, busy: true, error: null });
				props.mcpAdd(props.sessionId, {
					identity: addForm.identity.trim(),
					label: addForm.label.trim() || addForm.identity.trim(),
					command: addForm.command.trim(),
					args: addForm.args.trim() ? addForm.args.trim().split(/\s+/) : [],
				}).then((result) => {
					if (result && result.status === "registered") {
						setAddForm({ open: false, identity: "", label: "", command: "", args: "", showErrors: false, error: null, busy: false });
						refreshAll();
					} else {
						setAddForm({ ...addForm, busy: false, error: (result && result.status) || "add failed" });
					}
				}).catch((cause) => setAddForm({ ...addForm, busy: false, error: String(cause) }));
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
						description: t("capability.state.errorDesc", "The capability listing could not be loaded.")
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
			const draftHas = (kind, name) => draft !== null && draft[kind].includes(name);
			const selectionDisabled = draft === null || commit?.phase === "submitting";
			const fieldError = (code) => code === "invalid"
				? t("capability.mcp.errorIdentityInvalid", "Letters, digits, \"-\" and \"_\" only; start with a letter or digit.")
				: t("capability.mcp.errorRequired", "Required.");
			const addField = (key, placeholder, errorCode) => react_jsx_runtime.jsxs("div", {
				children: [
					react_jsx_runtime.jsx("input", {
						style: S.form.input,
						placeholder,
						value: addForm[key],
						"aria-invalid": errorCode ? true : undefined,
						...ring,
						onChange: (event) => setAddForm({ ...addForm, [key]: event.target.value })
					}),
					errorCode ? react_jsx_runtime.jsx("div", { style: S.form.error, children: fieldError(errorCode) }) : null
				]
			}, key);
			const addBlock = tab === "mcp" ? react_jsx_runtime.jsxs("div", { style: S.form.wrap, children: [
				!addForm.open
					? react_jsx_runtime.jsx("button", {
						type: "button",
						style: S.form.addButton,
						...ring,
						...hover(HOVER_BG, "none"),
						onClick: () => setAddForm({ ...addForm, open: true, showErrors: false, error: null }),
						children: t("capability.mcp.add", "+ Add managed MCP server")
					})
					: react_jsx_runtime.jsxs("div", { style: S.form.box, children: [
						react_jsx_runtime.jsx("div", { style: S.form.title, children: t("capability.mcp.addTitle", "Add managed MCP server") }),
						addField("identity", t("capability.mcp.identity", "identity (e.g. my-docs)"), addForm.showErrors ? addErrors.identity : undefined),
						addField("label", t("capability.mcp.label", "label (display name, optional)"), undefined),
						addField("command", t("capability.mcp.command", "command (e.g. npx)"), addForm.showErrors ? addErrors.command : undefined),
						addField("args", t("capability.mcp.args", "args, space-separated (optional)"), undefined),
						react_jsx_runtime.jsxs("div", { style: S.form.actions, children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: addForm.busy ? { ...S.form.primary, ...S.footer.disabled } : S.form.primary,
								...ring,
								disabled: addForm.busy,
								onClick: submitAdd,
								children: addForm.busy ? t("capability.mcp.adding", "Adding…") : t("capability.mcp.addConfirm", "Add")
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: S.form.ghost,
								...ring,
								...hover(HOVER_BG, "none"),
								onClick: () => setAddForm({ ...addForm, open: false, showErrors: false, error: null }),
								children: t("capability.mcp.cancel", "Cancel")
							}),
							addForm.error ? react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.warn }, children: String(addForm.error) }) : null
						] })
					] })
			] }) : null;
			const skillRow = (skill) => {
				const selected = draftHas("skills", skill.name);
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
							"aria-label": skill.name,
							onChange: () => toggle("skills", skill.name)
						}),
						react_jsx_runtime.jsxs("span", { style: S.row.text, children: [
							react_jsx_runtime.jsxs("span", { style: S.row.nameLine, children: [
								react_jsx_runtime.jsx("span", { style: S.row.name, title: skill.name, children: skill.name }),
								react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.scope(skill.scopeKey) }, children: skill.source }),
								skill.conflict ? react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.warn }, children: t("capability.conflict", "conflict") }) : null,
								skill.missing ? react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.danger }, title: skill.status, children: t("capability.missing", "missing") }) : null
							] }),
							skill.description ? react_jsx_runtime.jsx("span", { style: S.row.desc, title: skill.description, children: skill.description }) : null
						] })
					]
				}, skill.name);
			};
			const mcpRow = (server) => {
				const name = server.identity ?? server.serverName ?? "unknown";
				const selected = draftHas("mcpServers", name);
				const rest = selected ? tint(ACCENT, 8) : "transparent";
				const mounted = server.state === "mounted";
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
							"aria-label": name,
							onChange: () => toggle("mcpServers", name)
						}),
						react_jsx_runtime.jsxs("span", { style: { ...S.row.nameLine, flex: 1 }, children: [
							react_jsx_runtime.jsx("span", { style: S.row.name, title: name, children: name }),
							react_jsx_runtime.jsx("span", {
								style: { ...S.tag.base, ...(mounted ? S.tag.ok : S.tag.neutral) },
								children: mounted ? t("capability.mcp.stateMounted", "mounted") : t("capability.mcp.stateRegistered", "registered")
							})
						] })
					]
				}, name);
			};
			const unmanagedRow = (server) => {
				const name = server.serverName ?? "unknown";
				return react_jsx_runtime.jsxs("div", {
					style: { ...S.row.base, alignItems: "center", cursor: "default" },
					title: t("capability.mcp.unmanagedHint", "Configured outside Weir; the selection cannot govern it."),
					children: [
						react_jsx_runtime.jsx("span", { style: { ...S.row.name, flex: 1 }, children: name }),
						react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.neutral }, children: t("capability.unmanaged", "unmanaged") })
					]
				}, name);
			};
			const body = tab === "skills"
				? (skillRows.length === 0
					? react_jsx_runtime.jsx(StatePanel, { icon: "search", title: t("capability.noSkills", "No skills match.") })
					: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
						children: skillRows.map((group) => react_jsx_runtime.jsxs("div", {
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
						}, group.key))
					}))
				: tab === "mcp"
					? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
						children: [
							partition.mcpManaged.length > 0
								? react_jsx_runtime.jsxs("div", {
									style: S.list.card,
									children: [
										react_jsx_runtime.jsxs("div", {
											style: S.list.cardHead,
											children: [
												react_jsx_runtime.jsx("span", { children: t("capability.mcp.groupManaged", "Weir managed") }),
												react_jsx_runtime.jsx("span", { style: S.list.count, children: String(partition.mcpManaged.length) })
											]
										}),
										...partition.mcpManaged.map(mcpRow)
									]
								}, "managed")
								: null,
							partition.mcpUnmanaged.length > 0
								? react_jsx_runtime.jsxs("div", {
									style: S.list.card,
									children: [
										react_jsx_runtime.jsxs("div", {
											style: S.list.cardHead,
											children: [
												react_jsx_runtime.jsx("span", { children: t("capability.mcp.groupUnmanaged", "Unmanaged") }),
												react_jsx_runtime.jsx("span", { style: S.list.count, children: String(partition.mcpUnmanaged.length) })
											]
										}),
										...partition.mcpUnmanaged.map(unmanagedRow)
									]
								}, "unmanaged")
								: null,
							partition.mcpManaged.length === 0 && partition.mcpUnmanaged.length === 0
								? react_jsx_runtime.jsx(StatePanel, { icon: "blocks", title: t("capability.mcp.none", "No MCP servers configured.") })
								: null
						]
					})
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
			const diffParts = diff && diff.any
				? [
					diff.skillsAdded > 0 ? { added: true, text: t("capability.diff.addSkills", "+{n} skills").replace("{n}", String(diff.skillsAdded)) } : null,
					diff.skillsRemoved > 0 ? { added: false, text: t("capability.diff.removeSkills", "−{n} skills").replace("{n}", String(diff.skillsRemoved)) } : null,
					diff.mcpAdded > 0 ? { added: true, text: t("capability.diff.addMcp", "+{n} MCP").replace("{n}", String(diff.mcpAdded)) } : null,
					diff.mcpRemoved > 0 ? { added: false, text: t("capability.diff.removeMcp", "−{n} MCP").replace("{n}", String(diff.mcpRemoved)) } : null
				].filter(Boolean)
				: null;
			const applyDisabled = !draft || !draft.dirty || commit?.phase === "submitting";
			// Session state summary (sidebar header only): the APPLIED counts,
			// same template the composer Badge renders.
			const appliedSummary = draft !== null
				? t("capability.badge", "{skills} skills · {mcp} MCP").replace("{skills}", String(draft.applied.skills.length)).replace("{mcp}", String(draft.applied.mcpServers.length))
				: null;
			return react_jsx_runtime.jsxs("div", { style: frameStyle, children: [
				react_jsx_runtime.jsxs("div", { style: S.header.row, children: [
					react_jsx_runtime.jsx("button", { type: "button", style: S.tabs.segment(tab === "skills", "first"), ...ring, onClick: () => setTab("skills"), "aria-pressed": tab === "skills", children: t("capability.tab.skills", "Skills") }),
					react_jsx_runtime.jsx("button", { type: "button", style: S.tabs.segment(tab === "mcp", "middle"), ...ring, onClick: () => setTab("mcp"), "aria-pressed": tab === "mcp", children: t("capability.tab.mcp", "MCP") }),
					react_jsx_runtime.jsx("button", { type: "button", style: S.tabs.segment(tab === "presets", "last"), ...ring, onClick: () => setTab("presets"), "aria-pressed": tab === "presets", children: t("capability.tab.presets", "Presets") }),
					props.shell === "sidebar" && appliedSummary
						? react_jsx_runtime.jsx("span", { style: S.header.summary, children: appliedSummary })
						: null,
					react_jsx_runtime.jsxs("span", {
						style: S.search.wrap,
						children: [
							react_jsx_runtime.jsx("span", { style: S.search.icon, children: react_jsx_runtime.jsx(Icon, { name: "search", size: 12 }) }),
							react_jsx_runtime.jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: t("capability.search", "Search"), style: S.search.input, ...ring })
						]
					}),
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
				draft !== null ? react_jsx_runtime.jsxs("div", { style: S.footer.bar, children: [
					diffParts ? react_jsx_runtime.jsx("span", { style: S.footer.diff, "data-weir-capability-diff": "", children: diffParts.map((part, index) => react_jsx_runtime.jsx("span", { style: S.footer.diffBadge(part.added), children: part.text }, index)) }) : null,
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
					commit?.phase === "applied" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(SUCCESS), children: t("capability.applied", "Applied") }) : null,
					commit?.phase === "applied" && Array.isArray(commit.skipped) && commit.skipped.length > 0
						? react_jsx_runtime.jsx("span", { style: S.footer.chip(WARN), title: commit.skipped.map(entry => `${entry.name} — ${entry.reason}`).join("\n"), children: t("capability.appliedSkipped", "skipped {n} (not applicable here)").replace("{n}", String(commit.skipped.length)) })
						: null,
					commit?.phase === "failed" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(DANGER), title: commit.error, children: t("capability.failed", "Failed — draft kept") }) : null,
					commit?.phase === "revision-conflict" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(WARN), children: t("capability.conflictState", "Changed elsewhere — review current state") }) : null,
					commit?.phase === "install-or-configure" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(ACCENT), title: (commit.missing ?? []).join(", "), children: t("capability.missingAction", "Missing items need install/configure") }) : null,
					commit?.phase === "indeterminate" ? react_jsx_runtime.jsx("span", { style: S.footer.chip(MUTED), children: t("capability.pending", "Result pending — query the receipt") }) : null
				] }) : null
			] });
		}
		exports.CapabilityManagerPanel = CapabilityManagerPanel;
		return module.exports;
	}
});
