window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.blackboard-panel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Session blackboard panel (slice 2, tasks 2.3/2.4) ----
		// The right-sidebar board surface: the entry list grouped by entryType
		// with search + type filter, on-demand detail reads, and the full
		// arbitrated edit flow (apply → write/remove — never a bypass). The
		// write-token countdown runs while the authority is held; a contended
		// apply shows the holder and offers the client-side watch (poll apply
		// until the key frees, then notify in-panel). There is no server push
		// in this slice: the listing polls on an interval (paused while the
		// page is hidden) and updatedAt drives detail staleness. Every list and
		// flow decision comes from the pure model chunk; this tree only paints
		// state. All hooks run before any derived work — no early returns.
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
		/** Soft tinted background (worktree-view recipe). */
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
		// entryType → hue family: knowledge kinds read at a glance; unknown
		// types fall back to the neutral label hue.
		const TYPE_HUES = {
			map: "var(--dsw-static-blue-500, #3b82f6)",
			contract: SUCCESS,
			deadend: DANGER,
			wiring: WARN_TEXT,
			recipe: "var(--dsw-alias-label-deep-diving, #6d5bd0)",
			why: ACCENT,
		};
		const paint = (event, styles) => {
			const el = event?.currentTarget;
			if (el && el.style) Object.assign(el.style, styles);
		};
		// Focus ring follows focus-visible semantics: keyboard navigation paints
		// the outline, pointer interaction never does (a clicked button must not
		// keep a persistent highlight). Modality is tracked once per window.
		let keyboardModality = false;
		if (typeof window !== "undefined" && typeof window.addEventListener === "function" && !window.__weirBlackboardModality) {
			window.__weirBlackboardModality = true;
			window.addEventListener("keydown", (event) => { if (event.key === "Tab") keyboardModality = true; }, true);
			window.addEventListener("pointerdown", () => { keyboardModality = false; }, true);
		}
		const ring = {
			onFocus: (event) => { if (keyboardModality) paint(event, { outline: "2px solid var(--dsw-alias-focus-ring, currentColor)", outlineOffset: "1px" }); },
			onBlur: (event) => paint(event, { outline: "none", outlineOffset: "" }),
		};
		const hover = (over, out) => ({
			onMouseEnter: (event) => paint(event, { background: over }),
			onMouseLeave: (event) => paint(event, { background: out }),
		});
		const S = {
			frame: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				height: "100%",
				minHeight: 0,
				boxSizing: "border-box",
				padding: "12px",
				fontSize: "12px",
				color: LABEL1
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
				title: { fontSize: "12px", lineHeight: "16px", fontWeight: 600, flex: "none" },
				summary: { fontSize: "11px", lineHeight: "16px", color: MUTED, whiteSpace: "nowrap", flex: "none", marginLeft: "2px" },
				spacer: { flex: "1 1 auto" },
				iconButton: {
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
			search: {
				wrap: { position: "relative", flex: "none", display: "flex", alignItems: "center", margin: "2px 0" },
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
			chips: {
				row: { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap", margin: "2px 0 4px", flex: "none" },
				chip: (active, hue) => ({
					fontSize: "11px",
					lineHeight: "14px",
					fontWeight: active ? 600 : 500,
					padding: "2px 8px",
					cursor: "pointer",
					border: `1px solid ${active ? (hue ?? ACCENT) : BORDER}`,
					borderRadius: "var(--dsw-radius-xl, 999px)",
					background: active ? tint(hue ?? ACCENT, 12) : "none",
					color: active ? (hue ?? ACCENT) : LABEL2,
					transition: TRANSITION
				})
			},
			list: {
				scroll: { flex: "1 1 auto", minHeight: 0, overflowY: "auto" },
				group: { marginBottom: "4px" },
				groupTitle: {
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
					background: "var(--dsw-alias-bg-layer-1, #fff)"
				},
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
				},
				meta: { fontSize: "10px", lineHeight: "14px", color: MUTED, flex: "none", marginTop: "1px" }
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
				type: (entryType) => {
					const hue = TYPE_HUES[entryType] ?? MUTED;
					return { color: hue, border: `1px solid ${hue}`, background: tint(hue, 10) };
				},
				warn: { color: WARN_TEXT, border: `1px solid ${WARN}`, background: tint(WARN, 12) },
				neutral: { color: MUTED, border: `1px solid ${BORDER_STRONG}`, background: "none" },
				promoted: { color: SUCCESS, border: `1px solid ${SUCCESS}`, background: tint(SUCCESS, 10) }
			},
			detail: {
				block: { margin: "4px 0" },
				label: { fontSize: "11px", lineHeight: "16px", fontWeight: 600, color: LABEL2, padding: "0 2px 2px" },
				text: { fontSize: "12px", lineHeight: "17px", color: LABEL1, padding: "0 2px", whiteSpace: "pre-wrap", wordBreak: "break-word" },
				content: {
					margin: 0,
					padding: "8px 10px",
					fontSize: "12px",
					lineHeight: "16px",
					whiteSpace: "pre-wrap",
					wordBreak: "break-word",
					maxHeight: "320px",
					overflow: "auto",
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-md, 8px)",
					background: "var(--dsw-alias-interactive-bg-solid, rgba(127,127,127,.06))"
				},
				actions: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "8px" },
				banner: {
					display: "flex",
					gap: "6px",
					alignItems: "center",
					flexWrap: "wrap",
					fontSize: "11px",
					lineHeight: "16px",
					padding: "6px 8px",
					margin: "6px 0",
					borderRadius: "var(--dsw-radius-md, 8px)",
					border: `1px solid ${WARN}`,
					background: tint(WARN, 10),
					color: WARN_TEXT
				}
			},
			form: {
				box: { display: "flex", flexDirection: "column", gap: "6px", flex: "1 1 auto", minHeight: 0, overflowY: "auto" },
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
				area: {
					width: "100%",
					boxSizing: "border-box",
					fontSize: "12px",
					lineHeight: "16px",
					padding: "4px 8px",
					background: CARD_BG,
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: LABEL1,
					minHeight: "96px",
					resize: "vertical",
					fontFamily: "inherit",
					transition: TRANSITION
				},
				select: {
					fontSize: "12px",
					lineHeight: "16px",
					padding: "3px 6px",
					background: CARD_BG,
					border: `1px solid ${BORDER}`,
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: LABEL1,
					transition: TRANSITION
				},
				error: { fontSize: "11px", lineHeight: "15px", color: WARN_TEXT },
				actions: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", flex: "none", marginTop: "2px" }
			},
			button: {
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
				},
				dangerGhost: {
					fontSize: "12px",
					lineHeight: "16px",
					fontWeight: 500,
					padding: "3px 10px",
					cursor: "pointer",
					background: "none",
					border: `1px solid ${DANGER}`,
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: DANGER,
					transition: TRANSITION
				},
				disabled: { opacity: 0.5, cursor: "not-allowed" }
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
				chip: (hue) => ({
					fontSize: "11px",
					lineHeight: "16px",
					fontWeight: 600,
					padding: "1px 7px",
					borderRadius: "var(--dsw-radius-sm, 6px)",
					color: hue,
					background: tint(hue, 12),
					border: `1px solid ${hue}`,
					flex: "none",
					display: "inline-flex",
					gap: "4px",
					alignItems: "center"
				}),
				text: { fontSize: "11px", lineHeight: "16px", color: LABEL2, minWidth: 0 }
			},
			state: {
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
			}
		};
		const ICON_PATHS = {
			search: [["circle", { cx: 7, cy: 7, r: 4.6 }], ["path", { d: "M10.6 10.6L14 14" }]],
			x: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
			back: [["path", { d: "M9.5 3.5L5 8l4.5 4.5" }], ["path", { d: "M5 8h9" }]],
			plus: [["path", { d: "M8 3v10M3 8h10" }]],
			refresh: [["path", { d: "M13.5 8a5.5 5.5 0 1 1-1.61-3.89" }], ["path", { d: "M13.7 2.2v2.4h-2.4" }]],
			clock: [["circle", { cx: 8, cy: 8, r: 5.6 }], ["path", { d: "M8 4.8V8l2.2 1.4" }]],
			bell: [["path", { d: "M8 2.4a3.6 3.6 0 0 0-3.6 3.6v2.4L3 10.4h10l-1.4-2V6A3.6 3.6 0 0 0 8 2.4z" }], ["path", { d: "M6.8 12.4a1.2 1.2 0 0 0 2.4 0" }]],
			trash: [["path", { d: "M3 4.4h10" }], ["path", { d: "M6.4 4.4V2.8h3.2v1.6" }], ["path", { d: "M4.4 4.4l.6 8.4h6l.6-8.4" }]],
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
			board: [
				["rect", { x: 2.2, y: 2.2, width: 4.8, height: 4.8, rx: 1, fill: "currentColor", stroke: "none" }],
				["rect", { x: 9, y: 2.2, width: 4.8, height: 4.8, rx: 1, fill: "currentColor", stroke: "none", opacity: 0.55 }],
				["rect", { x: 2.2, y: 9, width: 4.8, height: 4.8, rx: 1, fill: "currentColor", stroke: "none", opacity: 0.55 }],
				["rect", { x: 9, y: 9, width: 4.8, height: 4.8, rx: 1, fill: "currentColor", stroke: "none" }]
			],
			promote: [
				["path", { d: "M8 10.4V3.6" }],
				["path", { d: "M4.6 6.4L8 3l3.4 3.4" }],
				["path", { d: "M3 13.2h10" }]
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
		/** Full empty/error state: icon disc + title + optional description. Hook-free. */
		function StatePanel(props) {
			const hue = props.color ?? MUTED;
			return react_jsx_runtime.jsxs("div", {
				style: S.state.wrap,
				children: [
					react_jsx_runtime.jsx("span", { style: S.state.icon(hue), children: react_jsx_runtime.jsx(Icon, { name: props.icon ?? "info", size: 17 }) }),
					react_jsx_runtime.jsx("div", { style: S.state.title, children: props.title }),
					props.description ? react_jsx_runtime.jsx("div", { style: S.state.desc, children: props.description }) : null,
					props.action ?? null
				]
			});
		}
		function BlackboardPanel(props) {
			const model = props.model;
			// Echo-guard like the Badge: an unregistered dictionary entry surfaces
			// the in-code fallback, never the raw key. The host locale's second
			// parameter is an interpolation VARS object, never a fallback string —
			// templates interpolate at the call site with .replace.
			const t = (key, fallback) => {
				const value = typeof props.t === "function" ? props.t(key) : undefined;
				return typeof value === "string" && value !== key ? value : fallback;
			};
			const typeLabel = (entryType) => t(`blackboard.type.${entryType}`, entryType);
			const pollMs = Number.isFinite(props.pollMs) ? props.pollMs : 10000;
			const watchMs = Number.isFinite(props.watchMs) ? props.watchMs : 5000;
			const [board, setBoard] = react.useState(null);
			const [route, setRoute] = react.useState({ name: "list" });
			const [detail, setDetail] = react.useState(null);
			const [editor, setEditor] = react.useState(null);
			const [held, setHeld] = react.useState(null);
			const [watch, setWatch] = react.useState(null);
			const [contention, setContention] = react.useState(null);
			const [confirmDelete, setConfirmDelete] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [nowMs, setNowMs] = react.useState(() => Date.now());
			const [visible, setVisible] = react.useState(() => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"));
			const [typeFilter, setTypeFilter] = react.useState("");
			const [query, setQuery] = react.useState("");
			const [promoting, setPromoting] = react.useState(false);
			// Mirrors for async continuations (polls and call settles read the
			// freshest state without stale-closure races).
			const detailRef = react.useRef(null);
			detailRef.current = detail;
			const watchRef = react.useRef(null);
			watchRef.current = watch;
			const channel = react.useMemo(() => model.createBlackboardChannel(props.callBoard, props.sessionId), [props.callBoard, props.sessionId]);
			const refreshList = () => channel.list().then((result) => {
				setBoard(model.listOutcomeOf(result));
			});
			const setDetailFor = (key, next) => {
				if (detailRef.current?.key === key) setDetail(next);
			};
			const loadDetail = (key) => {
				// Record the request synchronously: a fast-settling read must not
				// be dropped by the setDetailFor guard before the next render
				// re-mirrors the ref.
				detailRef.current = { key, phase: "loading" };
				setDetail(detailRef.current);
				channel.read([key]).then((result) => {
					const outcome = model.readOutcomeOf(result, [key]);
					if (outcome.kind !== "ok") {
						setDetailFor(key, { key, phase: "failed", message: outcome.message });
						return;
					}
					const entry = outcome.entries.find((candidate) => candidate.key === key);
					setDetailFor(key, entry ? { key, phase: "ok", entry } : { key, phase: "gone" });
				});
			};
			const openDetail = (key) => {
				setRoute({ name: "detail", key });
				loadDetail(key);
			};
			// Initial listing + session switch.
			react.useEffect(() => {
				let alive = true;
				channel.list().then((result) => {
					if (alive) setBoard(model.listOutcomeOf(result));
				});
				return () => { alive = false; };
			}, [props.sessionId]);
			// Page visibility: polls pause while hidden (no server push in this
			// slice — the interval is the only refresh channel).
			react.useEffect(() => {
				if (typeof document === "undefined") return undefined;
				const onVisibility = () => setVisible(document.visibilityState !== "hidden");
				document.addEventListener("visibilitychange", onVisibility);
				return () => document.removeEventListener("visibilitychange", onVisibility);
			}, []);
			react.useEffect(() => {
				if (!visible || !(pollMs > 0)) return undefined;
				const timer = setInterval(refreshList, pollMs);
				return () => clearInterval(timer);
			}, [visible, pollMs, props.sessionId]);
			// The contention watch: poll apply until the key frees (an acquired
			// flip means THIS session now holds the authority — the one-shot
			// subscription's client-side half).
			react.useEffect(() => {
				if (!visible || watch?.phase !== "watching" || !(watchMs > 0)) return undefined;
				const timer = setInterval(() => {
					channel.apply(watch.key).then((result) => {
						const next = model.watchAfterPoll(watchRef.current, model.applyOutcomeOf(result));
						if (next === watchRef.current) return;
						setWatch(next);
						if (next?.phase === "released") {
							setHeld({ key: next.key, expiresAt: next.expiresAt });
							setNotice({ tone: "ok", text: t("blackboard.released", "Key free — you hold the write authority.") });
						} else if (next?.phase === "failed") {
							setNotice({ tone: "danger", text: next.message });
						}
					});
				}, watchMs);
				return () => clearInterval(timer);
			}, [visible, watch?.phase, watch?.key, watchMs]);
			// The countdown clock ticks only while an authority is held or a
			// release notice shows its expiry.
			react.useEffect(() => {
				if (held === null && watch?.phase !== "released") return undefined;
				const timer = setInterval(() => setNowMs(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [held !== null, watch?.phase]);
			// A countdown that reaches zero drops the held authority (the kernel
			// already released it) and says so — the next save would be refused.
			react.useEffect(() => {
				if (held !== null && model.tokenCountdownOf(held.expiresAt, nowMs).phase === "expired") {
					setHeld(null);
					setNotice({ tone: "warn", text: t("blackboard.tokenExpired", "Write authority expired — re-acquire before saving.") });
				}
			}, [nowMs, held]);
			// Poll staleness: the open detail re-reads when its updatedAt moved
			// and degrades to gone when its key disappeared from the listing.
			react.useEffect(() => {
				if (board?.kind !== "ok" || detail?.phase !== "ok") return;
				if (!board.rows.some((row) => row.key === detail.key)) {
					setDetail({ key: detail.key, phase: "gone" });
					return;
				}
				if (model.detailNeedsReread({ key: detail.key, updatedAt: detail.entry.updatedAt }, board.rows)) loadDetail(detail.key);
			}, [board]);
			// ---- edit flow (2.4): apply → write/remove, never a bypass ----
			const startCreate = () => {
				setNotice(null);
				setEditor({ mode: "create", draft: model.emptyEditorDraft(), phase: "editing", error: null, contended: null, showErrors: false });
				setRoute({ name: "editor", mode: "create" });
			};
			const startEdit = (entry) => {
				if (entry.promoted) {
					setNotice({ tone: "warn", text: t("blackboard.promotedReadonly", "This entry is promoted and read-only.") });
					return;
				}
				setNotice(null);
				setEditor({ mode: "update", key: entry.key, draft: null, phase: "applying", error: null, contended: null, showErrors: false });
				setRoute({ name: "editor", mode: "update" });
				channel.apply(entry.key).then((result) => {
					const outcome = model.applyOutcomeOf(result);
					if (outcome.kind === "acquired") {
						setHeld({ key: entry.key, expiresAt: outcome.expiresAt });
						setWatch((current) => (current?.key === entry.key ? null : current));
						setEditor({ mode: "update", key: entry.key, draft: model.editorDraftFromEntry(entry), phase: "editing", error: null, contended: null, showErrors: false });
						return;
					}
					setEditor(null);
					setRoute({ name: "detail", key: entry.key });
					if (outcome.kind === "promoted") setNotice({ tone: "warn", text: t("blackboard.promotedReadonly", "This entry is promoted and read-only.") });
					else if (outcome.kind === "contended") setContention({ key: entry.key, holder: outcome.holder });
					else setNotice({ tone: "danger", text: outcome.message });
				});
			};
			// ---- promotion request (3.1): the button pushes the evaluation brief into the main agent ----
			const requestPromotionNow = () => {
				if (promoting) return;
				setNotice(null);
				setPromoting(true);
				channel.requestPromotion().then((result) => {
					setPromoting(false);
					const outcome = model.promotionOutcomeOf(result);
					if (outcome.kind === "requested") {
						setNotice({ tone: "ok", text: t("blackboard.promotionRequested", "The main agent received the promotion-evaluation request.") });
					} else {
						setNotice({ tone: "danger", text: outcome.message });
					}
					refreshList();
				});
			};
			const reacquire = () => {
				if (editor?.mode !== "update") return;
				const key = editor.key;
				setEditor({ ...editor, phase: "applying", error: null, contended: null });
				channel.apply(key).then((result) => {
					const outcome = model.applyOutcomeOf(result);
					if (outcome.kind === "acquired") {
						setHeld({ key, expiresAt: outcome.expiresAt });
						setWatch((current) => (current?.key === key ? null : current));
						setEditor((current) => (current ? { ...current, phase: "editing", error: null, contended: null } : current));
						return;
					}
					setEditor((current) => (current
						? { ...current, phase: "editing", error: outcome.kind === "contended" ? null : outcome.message, contended: outcome.kind === "contended" ? outcome.holder : null }
						: current));
				});
			};
			const saveEditor = () => {
				if (editor === null || editor.draft === null || editor.phase === "saving" || editor.phase === "applying") return;
				const errors = model.editorErrorsOf(editor.draft);
				if (Object.keys(errors).length > 0) {
					setEditor({ ...editor, showErrors: true, error: null });
					return;
				}
				const mode = editor.mode;
				const payload = model.editorWritePayload(editor.draft);
				const writeNow = () => {
					setEditor((current) => (current ? { ...current, phase: "saving", error: null, contended: null } : current));
					channel.write(payload).then((result) => {
						const outcome = model.writeOutcomeOf(result);
						if (outcome.kind === "saved") {
							// The one-shot authority is consumed by the write.
							setHeld(null);
							setWatch((current) => (current?.key === payload.key ? null : current));
							setEditor(null);
							setNotice({
								tone: "ok",
								text: mode === "create"
									? t("blackboard.created", "Entry created.")
									: t("blackboard.saved", "Saved (revision {n}).").replace("{n}", String(outcome.revision))
							});
							if (mode === "update") openDetail(payload.key);
							else setRoute({ name: "list" });
							refreshList();
							return;
						}
						setEditor((current) => (current ? { ...current, phase: "editing", error: outcome.message, contended: null } : current));
					});
				};
				if (mode === "create") {
					// Create goes through the same arbitration: acquire first;
					// contention surfaces inline with the watch offer.
					setEditor({ ...editor, phase: "applying", error: null, contended: null });
					channel.apply(payload.key).then((result) => {
						const outcome = model.applyOutcomeOf(result);
						if (outcome.kind === "acquired") {
							setHeld({ key: payload.key, expiresAt: outcome.expiresAt });
							writeNow();
							return;
						}
						setEditor((current) => (current
							? { ...current, phase: "editing", error: outcome.kind === "contended" ? null : outcome.message, contended: outcome.kind === "contended" ? outcome.holder : null }
							: current));
					});
					return;
				}
				writeNow();
			};
			const startDelete = (key) => {
				setNotice(null);
				setConfirmDelete({ key, phase: "applying", error: null });
				channel.apply(key).then((result) => {
					const outcome = model.applyOutcomeOf(result);
					if (outcome.kind === "acquired") {
						setHeld({ key, expiresAt: outcome.expiresAt });
						setWatch((current) => (current?.key === key ? null : current));
						setConfirmDelete({ key, phase: "confirm", error: null });
						return;
					}
					setConfirmDelete(null);
					if (outcome.kind === "promoted") setNotice({ tone: "warn", text: t("blackboard.promotedReadonly", "This entry is promoted and read-only.") });
					else if (outcome.kind === "contended") setContention({ key, holder: outcome.holder });
					else setNotice({ tone: "danger", text: outcome.message });
				});
			};
			const confirmDeleteNow = () => {
				if (confirmDelete?.phase !== "confirm") return;
				const key = confirmDelete.key;
				setConfirmDelete({ key, phase: "removing", error: null });
				channel.remove(key).then((result) => {
					const outcome = model.removeOutcomeOf(result);
					if (outcome.kind === "removed") {
						setHeld(null);
						setWatch((current) => (current?.key === key ? null : current));
						setConfirmDelete(null);
						setDetail(null);
						setRoute({ name: "list" });
						setNotice({ tone: "ok", text: t("blackboard.deleted", "Entry deleted.") });
						refreshList();
						return;
					}
					setConfirmDelete((current) => (current ? { ...current, phase: "confirm", error: outcome.message } : current));
				});
			};
			const startWatch = (key, holder) => {
				// One watch at a time keeps the footer chip unambiguous; starting a
				// new watch replaces the old one.
				setWatch(model.watchStart(key, holder));
			};
			// ---- derived presentation ----
			const rows = board?.kind === "ok" ? board.rows : [];
			const groups = model.groupEntries(model.filterEntries(rows, { type: typeFilter, query }));
			const countdown = held !== null ? model.tokenCountdownOf(held.expiresAt, nowMs) : null;
			const detailPhase = detail?.phase ?? null;
			const promotionButton = model.promotionButtonState(rows);
			const entryChip = (entryType) => react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.type(entryType) }, children: typeLabel(entryType) });
			const promotedBadge = (promoted) => react_jsx_runtime.jsx("span", {
				style: { ...S.tag.base, ...S.tag.promoted },
				title: t("blackboard.promotedTo", "promoted → {destination}").replace("{destination}", promoted.destination) + (promoted.at > 0 ? ` · ${model.formatTimeOf(promoted.at, nowMs)}` : ""),
				children: t("blackboard.promoted", "promoted")
			}, "promoted");
			const promoteTitle = !promotionButton.enabled
				? t("blackboard.promoteDisabled", "Every entry is already promoted — nothing to evaluate.")
				: t("blackboard.promote", "Evaluate for promotion");
			const iconButton = (icon, label, onClick, disabled = false) => react_jsx_runtime.jsx("button", {
				type: "button",
				style: disabled ? { ...S.header.iconButton, ...S.button.disabled } : S.header.iconButton,
				...ring,
				...(disabled ? {} : hover(HOVER_BG, "none")),
				onClick,
				disabled,
				"aria-label": label,
				title: label,
				children: react_jsx_runtime.jsx(Icon, { name: icon, size: 13 })
			}, icon);
			const header = react_jsx_runtime.jsxs("div", { style: S.header.row, children: [
				route.name !== "list"
					? iconButton("back", t("blackboard.back", "Back"), () => {
						if (route.name === "editor" && editor?.mode === "update") setRoute({ name: "detail", key: editor.key });
						else setRoute({ name: "list" });
					})
					: react_jsx_runtime.jsx("span", { style: S.header.title, children: t("blackboard.title", "Blackboard") }),
				route.name === "detail" && detail !== null
					? react_jsx_runtime.jsx("span", { style: { ...S.header.title, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }, title: detail.key, children: detail.key })
					: null,
				route.name === "editor"
					? react_jsx_runtime.jsx("span", { style: { ...S.header.title, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }, children: editor?.mode === "update" ? editor.key : t("blackboard.editorNew", "New entry") })
					: null,
				route.name === "list" && board?.kind === "ok"
					? react_jsx_runtime.jsx("span", { style: S.header.summary, children: t("blackboard.entries", "{n} entries").replace("{n}", String(rows.length)) })
					: null,
				react_jsx_runtime.jsx("span", { style: S.header.spacer }),
				iconButton("plus", t("blackboard.new", "New entry"), startCreate),
				iconButton("promote", promoteTitle, requestPromotionNow, !promotionButton.enabled || promoting),
				iconButton("refresh", t("blackboard.refresh", "Refresh"), refreshList, board === null)
			] });
			const footerChips = [];
			if (held !== null && countdown !== null) {
				footerChips.push(react_jsx_runtime.jsxs("span", {
					style: S.footer.chip(countdown.phase === "held" ? ACCENT : WARN_TEXT),
					title: held.key,
					children: [
						react_jsx_runtime.jsx(Icon, { name: "clock", size: 11 }),
						countdown.phase === "held"
							? t("blackboard.tokenHeld", "write authority {time}").replace("{time}", model.formatRemainingMs(countdown.remainingMs))
							: t("blackboard.tokenExpiredShort", "write authority expired")
					]
				}, "held"));
			}
			if (watch?.phase === "watching") {
				footerChips.push(react_jsx_runtime.jsxs("span", {
					style: S.footer.chip(WARN_TEXT),
					children: [
						react_jsx_runtime.jsx(Icon, { name: "bell", size: 11 }),
						t("blackboard.watching", "watching {key}").replace("{key}", watch.key)
					]
				}, "watch"));
			}
			if (notice !== null) {
				footerChips.push(react_jsx_runtime.jsx("span", { style: S.footer.text, children: notice.text }, "notice"));
				footerChips.push(react_jsx_runtime.jsx("button", {
					type: "button",
					style: S.header.iconButton,
					...ring,
					...hover(HOVER_BG, "none"),
					onClick: () => setNotice(null),
					"aria-label": t("blackboard.dismiss", "Dismiss"),
					children: react_jsx_runtime.jsx(Icon, { name: "x", size: 11 })
				}, "notice-dismiss"));
			}
			// ---- list view ----
			const listRow = (row) => react_jsx_runtime.jsxs("div", {
				style: S.row.base,
				...ring,
				...hover(HOVER_BG, "transparent"),
				role: "button",
				tabIndex: 0,
				onClick: () => openDetail(row.key),
				onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") openDetail(row.key); },
				children: [
					react_jsx_runtime.jsxs("span", { style: S.row.text, children: [
						react_jsx_runtime.jsxs("span", { style: S.row.nameLine, children: [
							react_jsx_runtime.jsx("span", { style: S.row.name, title: row.key, children: row.key }),
							entryChip(row.entryType),
							row.promoted ? promotedBadge(row.promoted) : null
						] }),
						row.summary !== "" ? react_jsx_runtime.jsx("span", { style: S.row.desc, title: row.summary, children: row.summary }) : null
					] }),
					react_jsx_runtime.jsx("span", {
						style: S.row.meta,
						title: model.formatTimeOf(row.updatedAt, nowMs),
						children: t("blackboard.rowMeta", "{read} reads · {watching} watching").replace("{read}", String(row.readCount)).replace("{watching}", String(row.subscribeCount))
					})
				]
			}, row.key);
			const filterChip = (value, label) => react_jsx_runtime.jsx("button", {
				type: "button",
				style: S.chips.chip(typeFilter === value, value === "" ? undefined : TYPE_HUES[value]),
				...ring,
				onClick: () => setTypeFilter(value),
				"aria-pressed": typeFilter === value,
				children: label
			}, value === "" ? "all" : value);
			const listBody = board === null
				? react_jsx_runtime.jsxs("div", {
					role: "status",
					children: [
						react_jsx_runtime.jsxs("div", {
							style: S.state.skeleton,
							"aria-hidden": "true",
							children: [
								react_jsx_runtime.jsx("div", { style: S.state.bone("34%", "12px") }),
								...[0, 1, 2].map((index) => react_jsx_runtime.jsxs("div", {
									style: S.state.skeletonRow,
									children: [
										react_jsx_runtime.jsx("span", { style: S.state.bone("42px", "13px") }),
										react_jsx_runtime.jsx("span", { style: S.state.bone(`${62 - index * 9}%`, "10px") })
									]
								}, index))
							]
						}),
						react_jsx_runtime.jsx("span", { style: S.state.srOnly, children: t("blackboard.loading", "Loading the board…") })
					]
				})
				: board.kind !== "ok"
					? react_jsx_runtime.jsx(StatePanel, {
						icon: "warn",
						color: DANGER,
						title: t("blackboard.unavailable", "Blackboard unavailable for this session."),
						description: board.message,
						action: react_jsx_runtime.jsx("button", { type: "button", style: S.button.ghost, ...ring, ...hover(HOVER_BG, "none"), onClick: refreshList, children: t("blackboard.retry", "Retry") })
					})
					: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
						children: [
							react_jsx_runtime.jsxs("div", { style: S.chips.row, children: [
								filterChip("", t("blackboard.filterAll", "All")),
								...model.ENTRY_TYPES.map((entryType) => filterChip(entryType, typeLabel(entryType)))
							] }),
							groups.length === 0
								? rows.length === 0
									? react_jsx_runtime.jsx(StatePanel, { icon: "board", title: t("blackboard.empty", "The board is empty."), description: t("blackboard.emptyDesc", "Findings agents write to this session's board appear here.") })
									: react_jsx_runtime.jsx(StatePanel, { icon: "search", title: t("blackboard.noMatch", "No entries match.") })
								: groups.map((group) => react_jsx_runtime.jsxs("div", {
									style: S.list.group,
									children: [
										react_jsx_runtime.jsxs("div", {
											style: S.list.groupTitle,
											children: [
												react_jsx_runtime.jsx("span", { children: typeLabel(group.type) }),
												react_jsx_runtime.jsx("span", { style: S.list.count, children: String(group.rows.length) })
											]
										}),
										...group.rows.map(listRow)
									]
								}, group.type))
						]
					});
			// ---- detail view ----
			const contentionBanner = contention !== null && detail !== null && contention.key === detail.key && (detailPhase === "ok" || detailPhase === "failed")
				? (() => {
					const watching = watch?.phase === "watching" && watch.key === contention.key;
					const released = watch?.phase === "released" && watch.key === contention.key;
					return react_jsx_runtime.jsxs("div", { style: S.detail.banner, children: [
						react_jsx_runtime.jsx(Icon, { name: "warn", size: 12 }),
						react_jsx_runtime.jsx("span", {
							style: { flex: "1 1 auto", minWidth: 0 },
							title: contention.holder,
							children: released
								? t("blackboard.released", "Key free — you hold the write authority.")
								: t("blackboard.contention", "Write authority is held by {holder}.").replace("{holder}", watching ? watch.holder : contention.holder)
						}),
						!watching && !released
							? react_jsx_runtime.jsx("button", {
								type: "button",
								style: S.button.ghost,
								...ring,
								...hover(HOVER_BG, "none"),
								onClick: () => startWatch(contention.key, contention.holder),
								children: t("blackboard.watch", "Notify me when free")
							})
							: null,
						watching
							? react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.warn }, children: t("blackboard.watchingState", "watching…") })
							: null,
						react_jsx_runtime.jsx("button", {
							type: "button",
							style: S.header.iconButton,
							...ring,
							...hover(HOVER_BG, "none"),
							onClick: () => setContention(null),
							"aria-label": t("blackboard.dismiss", "Dismiss"),
							children: react_jsx_runtime.jsx(Icon, { name: "x", size: 11 })
						})
					] });
				})()
				: null;
			const detailBody = detail === null
				? null
				: detailPhase === "loading"
					? react_jsx_runtime.jsxs("div", {
						role: "status",
						children: [
							react_jsx_runtime.jsxs("div", {
								style: S.state.skeleton,
								"aria-hidden": "true",
								children: [
									react_jsx_runtime.jsx("div", { style: S.state.bone("42%", "12px") }),
									react_jsx_runtime.jsx("div", { style: S.state.bone("86%", "10px") }),
									react_jsx_runtime.jsx("div", { style: S.state.bone("64%", "10px") }),
									react_jsx_runtime.jsx("div", { style: S.state.bone("92%", "40px") })
								]
							}),
							react_jsx_runtime.jsx("span", { style: S.state.srOnly, children: t("blackboard.loading", "Loading the board…") })
						]
					})
					: detailPhase === "failed"
						? react_jsx_runtime.jsx(StatePanel, {
							icon: "warn",
							color: DANGER,
							title: t("blackboard.error", "The entry could not be loaded."),
							description: detail.message,
							action: react_jsx_runtime.jsx("button", { type: "button", style: S.button.ghost, ...ring, ...hover(HOVER_BG, "none"), onClick: () => loadDetail(detail.key), children: t("blackboard.retry", "Retry") })
						})
						: detailPhase === "gone"
							? react_jsx_runtime.jsx(StatePanel, {
								icon: "info",
								title: t("blackboard.gone", "This entry is gone."),
								description: t("blackboard.goneDesc", "It was deleted from the board (possibly by another writer).")
							})
							: (() => {
								const entry = detail.entry;
								const summaryBlock = (labelKey, label, text) => react_jsx_runtime.jsxs("div", { style: S.detail.block, children: [
									react_jsx_runtime.jsx("div", { style: S.detail.label, children: t(labelKey, label) }),
									react_jsx_runtime.jsx("div", { style: S.detail.text, children: text !== "" ? text : "—" })
								] }, labelKey);
								const deleteBlock = confirmDelete !== null && confirmDelete.key === entry.key
									? react_jsx_runtime.jsxs("div", { style: S.detail.banner, children: [
										react_jsx_runtime.jsx(Icon, { name: "trash", size: 12 }),
										react_jsx_runtime.jsx("span", { style: { flex: "1 1 auto", minWidth: 0 }, children: t("blackboard.deleteConfirm", "Delete this entry? The write authority is consumed.") }),
										react_jsx_runtime.jsx("button", {
											type: "button",
											style: confirmDelete.phase !== "confirm" ? { ...S.button.dangerGhost, ...S.button.disabled } : S.button.dangerGhost,
											...ring,
											disabled: confirmDelete.phase !== "confirm",
											onClick: confirmDeleteNow,
											children: confirmDelete.phase === "removing" ? t("blackboard.deleting", "Deleting…") : confirmDelete.phase === "applying" ? t("blackboard.applying", "Acquiring…") : t("blackboard.delete", "Delete")
										}),
										react_jsx_runtime.jsx("button", {
											type: "button",
											style: S.button.ghost,
											...ring,
											...hover(HOVER_BG, "none"),
											onClick: () => setConfirmDelete(null),
											children: t("blackboard.cancel", "Cancel")
										}),
										confirmDelete.error !== null && confirmDelete.error !== undefined
											? react_jsx_runtime.jsx("div", { style: { ...S.form.error, flexBasis: "100%" }, children: confirmDelete.error })
											: null
									] })
									: null;
								return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
									children: [
											react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }, children: [
												entryChip(entry.entryType),
												entry.promoted ? promotedBadge(entry.promoted) : null,
												react_jsx_runtime.jsx("span", { style: S.row.meta, children: t("blackboard.rowMeta", "{read} reads · {watching} watching").replace("{read}", String(entry.readCount)).replace("{watching}", String(entry.subscribeCount)) }),
												react_jsx_runtime.jsx("span", { style: S.row.meta, children: t("blackboard.updated", "updated {time}").replace("{time}", model.formatTimeOf(entry.updatedAt, nowMs)) })
											] }),
										summaryBlock("blackboard.summary", "Summary", entry.summary),
										react_jsx_runtime.jsxs("div", { style: S.detail.block, children: [
											react_jsx_runtime.jsx("div", { style: S.detail.label, children: t("blackboard.content", "Content") }),
											react_jsx_runtime.jsx("pre", { style: S.detail.content, children: entry.content ?? "" })
										] }),
											react_jsx_runtime.jsxs("div", { style: S.detail.actions, children: entry.promoted ? [
												react_jsx_runtime.jsx("span", {
													style: { fontSize: "11px", lineHeight: "16px", color: MUTED },
													children: t("blackboard.promotedReadonlyDetail", "Promoted entries are read-only: the durable copy lives in the target document, this board copy preserves the session references.")
												})
											] : [
												react_jsx_runtime.jsx("button", {
													type: "button",
													style: S.button.primary,
													...ring,
													...hover(ACCENT_HOVER, ACCENT),
													onClick: () => startEdit(entry),
													children: t("blackboard.edit", "Edit")
												}),
												react_jsx_runtime.jsx("button", {
													type: "button",
													style: S.button.ghost,
													...ring,
													...hover(HOVER_BG, "none"),
													onClick: () => startDelete(entry.key),
													children: t("blackboard.delete", "Delete")
												})
											] }),
										deleteBlock
									]
								});
							})();
			// ---- editor view ----
			const editorBody = editor === null
				? null
				: editor.phase === "applying" && editor.draft === null
					? react_jsx_runtime.jsx(StatePanel, { icon: "clock", title: t("blackboard.applying", "Acquiring write authority…") })
					: (() => {
						const draft = editor.draft;
						const errors = editor.showErrors ? model.editorErrorsOf(draft) : {};
						const busy = editor.phase === "saving" || editor.phase === "applying";
						const heldHere = held !== null && held.key === (editor.mode === "update" ? editor.key : draft.key.trim()) && countdown?.phase === "held";
						const fieldError = (code) => code === "invalid"
							? t("blackboard.formKeyInvalid", "Letters, digits and . _ - / only; start with a letter or digit.")
							: t("blackboard.formRequired", "Required.");
						const draftField = (field, labelKey, label, placeholder, options = {}) => react_jsx_runtime.jsxs("div", {
							children: [
								react_jsx_runtime.jsx("div", { style: S.detail.label, children: t(labelKey, label) }),
								react_jsx_runtime.jsx("input", {
									style: S.form.input,
									value: draft[field],
									placeholder,
									disabled: busy || options.disabled === true,
									"aria-invalid": errors[field] ? true : undefined,
									...ring,
									onChange: (event) => setEditor((current) => (current ? { ...current, draft: { ...current.draft, [field]: event.target.value } } : current))
								}),
								errors[field] ? react_jsx_runtime.jsx("div", { style: S.form.error, children: fieldError(errors[field]) }) : null
							]
						}, field);
						return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
							children: [
								draftField("key", "blackboard.formKey", "Key", "runtime-layout", { disabled: editor.mode === "update" }),
								react_jsx_runtime.jsxs("div", {
									children: [
										react_jsx_runtime.jsx("div", { style: S.detail.label, children: t("blackboard.formType", "Type") }),
										react_jsx_runtime.jsx("select", {
											style: S.form.select,
											value: draft.entryType,
											disabled: busy,
											"aria-label": t("blackboard.formType", "Type"),
											...ring,
											onChange: (event) => setEditor((current) => (current ? { ...current, draft: { ...current.draft, entryType: event.target.value } } : current)),
											children: model.ENTRY_TYPES.map((entryType) => react_jsx_runtime.jsx("option", { value: entryType, children: typeLabel(entryType) }, entryType))
										}),
										errors.entryType ? react_jsx_runtime.jsx("div", { style: S.form.error, children: fieldError(errors.entryType) }) : null
									]
								}, "type"),
								draftField("summary", "blackboard.summary", "Summary", t("blackboard.formSummaryPlaceholder", "One or two sentences: the finding, what it cost, how to verify it")),
								react_jsx_runtime.jsxs("div", {
									children: [
										react_jsx_runtime.jsx("div", { style: S.detail.label, children: t("blackboard.content", "Content") }),
										react_jsx_runtime.jsx("textarea", {
											style: S.form.area,
											value: draft.content,
											disabled: busy,
											"aria-invalid": errors.content ? true : undefined,
											...ring,
											onChange: (event) => setEditor((current) => (current ? { ...current, draft: { ...current.draft, content: event.target.value } } : current))
										}),
										errors.content ? react_jsx_runtime.jsx("div", { style: S.form.error, children: fieldError(errors.content) }) : null
									]
								}, "content"),
								editor.contended !== null && editor.contended !== undefined
									? react_jsx_runtime.jsxs("div", { style: S.detail.banner, children: [
										react_jsx_runtime.jsx(Icon, { name: "warn", size: 12 }),
										react_jsx_runtime.jsx("span", { style: { flex: "1 1 auto", minWidth: 0 }, title: editor.contended, children: t("blackboard.contention", "Write authority is held by {holder}.").replace("{holder}", editor.contended) }),
										watch?.phase === "watching" && watch.key === draft.key.trim()
											? react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.warn }, children: t("blackboard.watchingState", "watching…") })
											: react_jsx_runtime.jsx("button", {
												type: "button",
												style: S.button.ghost,
												...ring,
												...hover(HOVER_BG, "none"),
												onClick: () => startWatch(draft.key.trim(), editor.contended),
												children: t("blackboard.watch", "Notify me when free")
											})
									] })
									: null,
								editor.error !== null && editor.error !== undefined
									? react_jsx_runtime.jsx("div", { style: S.form.error, children: editor.error })
									: null,
								react_jsx_runtime.jsxs("div", { style: S.form.actions, children: [
									react_jsx_runtime.jsx("button", {
										type: "button",
										style: busy || (editor.mode === "update" && !heldHere) ? { ...S.button.primary, ...S.button.disabled } : S.button.primary,
										...ring,
										disabled: busy || (editor.mode === "update" && !heldHere),
										onClick: saveEditor,
										children: editor.phase === "saving" ? t("blackboard.saving", "Saving…") : editor.phase === "applying" ? t("blackboard.applying", "Acquiring…") : t("blackboard.save", "Save")
									}),
									editor.mode === "update" && !heldHere
										? react_jsx_runtime.jsx("button", {
											type: "button",
											style: busy ? { ...S.button.ghost, ...S.button.disabled } : S.button.ghost,
											...ring,
											...(busy ? {} : hover(HOVER_BG, "none")),
											disabled: busy,
											onClick: reacquire,
											children: t("blackboard.reacquire", "Re-acquire")
										})
										: null,
									react_jsx_runtime.jsx("button", {
										type: "button",
										style: S.button.ghost,
										...ring,
										...hover(HOVER_BG, "none"),
										onClick: () => {
											const mode = editor.mode;
											const key = editor.key;
											setEditor(null);
											if (mode === "update") setRoute({ name: "detail", key });
											else setRoute({ name: "list" });
										},
										children: t("blackboard.cancel", "Cancel")
									}),
									heldHere && countdown !== null
										? react_jsx_runtime.jsxs("span", { style: S.footer.chip(ACCENT), children: [
											react_jsx_runtime.jsx(Icon, { name: "clock", size: 11 }),
											t("blackboard.tokenHeld", "write authority {time}").replace("{time}", model.formatRemainingMs(countdown.remainingMs))
										] })
										: null,
									editor.mode === "update" && !heldHere
										? react_jsx_runtime.jsx("span", { style: { ...S.tag.base, ...S.tag.warn }, children: t("blackboard.tokenExpiredShort", "write authority expired") })
										: null
								] })
							]
						});
					})();
			const searchRow = route.name === "list"
				? react_jsx_runtime.jsxs("span", {
					style: S.search.wrap,
					children: [
						react_jsx_runtime.jsx("span", { style: S.search.icon, children: react_jsx_runtime.jsx(Icon, { name: "search", size: 12 }) }),
						react_jsx_runtime.jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: t("blackboard.search", "Search"), style: S.search.input, ...ring })
					]
				})
				: null;
			const scrollBody = route.name === "editor"
				? react_jsx_runtime.jsx("div", { style: S.form.box, children: editorBody })
				: route.name === "detail"
					? react_jsx_runtime.jsxs("div", { style: S.list.scroll, children: [contentionBanner, detailBody] })
					: react_jsx_runtime.jsx("div", { style: S.list.scroll, children: listBody });
			return react_jsx_runtime.jsxs("div", { style: S.frame, children: [
				header,
				searchRow,
				scrollBody,
				footerChips.length > 0 ? react_jsx_runtime.jsx("div", { style: S.footer.bar, children: footerChips }) : null
			] });
		}
		exports.BlackboardPanel = BlackboardPanel;
		return module.exports;
	}
});
