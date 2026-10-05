window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.worktree-view.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		// Worktree lanes surfaces. Every component receives its model helpers and
		// its data access through props (the composition root in lib/client.js
		// owns the ctx closures and pulls this chunk lazily). Errors are rendered
		// inside the surfaces, never thrown: a broken lane view must not take
		// down the composer or the session list.
		const NS_LABEL = "worktree";
		const MONO = "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)";
		const SUCCESS = "var(--dsw-alias-state-success-primary, #2f855a)";
		const ERROR = "var(--dsw-alias-state-error-primary)";
		const WARN = "var(--dsw-alias-state-warn-primary)";
		const BUSINESS = "var(--dsw-alias-state-business-primary)";
		// ---- shared design atoms ----
		/** Soft tinted background; callers keep a plain border as the fallback for engines without color-mix. */
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
		const mono = { fontFamily: MONO, overflowWrap: "anywhere", wordBreak: "break-word" };
		const text = {
			title: { fontSize: "13px", lineHeight: "18px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			meta: { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
			foot: { fontSize: "11px", lineHeight: "15px", color: "var(--dsw-alias-label-tertiary)" },
		};
		const cardStyle = {
			background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-md, 8px)", padding: "10px 12px",
			minWidth: 0, maxWidth: "100%", overflow: "hidden",
		};
		const buttonBase = {
			display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 9px",
			fontSize: "12px", lineHeight: "16px", borderRadius: "var(--dsw-radius-sm)",
			border: "1px solid transparent", background: "none", cursor: "pointer",
			color: "var(--dsw-alias-label-secondary)", fontWeight: 400, flex: "none",
		};
		// Button hierarchy: at most one PRIMARY per lane card, SECONDARY outline
		// chips, DANGER error outline (armed = solid), GHOST borderless links.
		const primaryStyle = { ...buttonBase, background: BUSINESS, border: "none", color: "var(--dsw-alias-bg-base)", fontWeight: 600 };
		const secondaryStyle = { ...buttonBase, borderColor: "var(--dsw-alias-border-l2)" };
		const dangerStyle = { ...buttonBase, borderColor: ERROR, color: ERROR };
		const dangerSolidStyle = { ...buttonBase, background: ERROR, border: "none", color: "var(--dsw-alias-bg-base)", fontWeight: 600 };
		const ghostStyle = { ...buttonBase, border: "none", padding: "3px 4px" };
		const disabledStyle = { opacity: 0.5, cursor: "not-allowed" };
		/** 2px left bar + soft tint: reason (attention) and next (business) callouts. */
		const calloutStyle = (color) => ({
			padding: "5px 8px", fontSize: "12px", lineHeight: "16px",
			color: "var(--dsw-alias-label-secondary)", background: tint(color, 8),
			borderLeft: `2px solid ${color}`, borderRadius: "var(--dsw-radius-xs, 4px)",
			overflowWrap: "anywhere",
		});
		const inputStyle = {
			width: "100%", boxSizing: "border-box", background: "var(--dsw-alias-bg-base)",
			border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)",
			padding: "6px 8px", fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-primary)",
		};
		// ---- 16x16 stroke icons (stroke: currentColor) ----
		const PATHS = {
			branch: [
				["circle", { cx: 4.5, cy: 3, r: 1.8 }],
				["circle", { cx: 4.5, cy: 13, r: 1.8 }],
				["circle", { cx: 11.5, cy: 5.5, r: 1.8 }],
				["path", { d: "M4.5 4.8v6.4M4.5 11.2c2.8 0 7-.8 7-3.9" }],
			],
			check: [["path", { d: "M3 8.6l3.4 3.4L13 4.6" }]],
			x: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
			warn: [
				["path", { d: "M8 2.6l6 10.4H2l6-10.4z" }],
				["path", { d: "M8 6.6v3.2" }],
				["circle", { cx: 8, cy: 11.4, r: 0.7, fill: "currentColor", stroke: "none" }],
			],
			clock: [["circle", { cx: 8, cy: 8, r: 5.6 }], ["path", { d: "M8 5.2V8l2 1.4" }]],
			refresh: [["path", { d: "M13.4 8a5.4 5.4 0 1 1-1.6-3.8" }], ["path", { d: "M13.6 1.8v2.6h-2.6" }]],
			copy: [
				["rect", { x: 5.6, y: 5.6, width: 7.4, height: 7.4, rx: 1.4 }],
				["path", { d: "M10.4 5.6V4.2a1.6 1.6 0 0 0-1.6-1.6H4.2a1.6 1.6 0 0 0-1.6 1.6v4.6a1.6 1.6 0 0 0 1.6 1.6h1.4" }],
			],
			sliders: [
				["path", { d: "M2.4 5.2h11.2M2.4 10.8h11.2" }],
				["circle", { cx: 6, cy: 5.2, r: 1.7 }],
				["circle", { cx: 10, cy: 10.8, r: 1.7 }],
			],
			history: [["path", { d: "M2.8 8a5.2 5.2 0 1 1 1.5 3.7" }], ["path", { d: "M2.8 5.4V8h2.6" }], ["path", { d: "M8 5.6V8l1.8 1.2" }]],
			arrowRight: [["path", { d: "M3 8h9.6M9.2 4.2L13 8l-3.8 3.8" }]],
			eye: [
				["ellipse", { cx: 8, cy: 8, rx: 6.2, ry: 4.4 }],
				["circle", { cx: 8, cy: 8, r: 1.9 }],
			],
		};
		/** @param {{ name: string, size?: number }} props */
		function Icon(props) {
			const size = props.size ?? 13;
			return jsx("svg", {
				viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": true,
				fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
				style: { flex: "none", display: "inline-block", verticalAlign: "-2px" },
				children: (PATHS[props.name] ?? []).map(([tag, attrs], index) => jsx(tag, attrs, index)),
			});
		}
		/** @param {{ open: boolean, size?: number }} props */
		function Chevron(props) {
			const size = props.size ?? 12;
			return jsx("svg", {
				viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": true,
				fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
				style: { flex: "none", display: "inline-block", transition: "transform 120ms ease", transform: props.open ? "rotate(90deg)" : "none" },
				children: jsx("path", { d: "M6 3.5L10.5 8L6 12.5" }),
			});
		}
		/** @param {{ color: string }} props */
		function Dot(props) {
			return jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: props.color, flex: "none" } });
		}
		/** State badge v2: dot + label on a soft tint of the tone colour; the plain border is the no-color-mix fallback. @param {{ label: string, color: string }} props */
		function Badge(props) {
			return jsxs("span", {
				style: {
					display: "inline-flex", alignItems: "center", gap: "5px", padding: "1px 7px",
					fontSize: "11px", lineHeight: "16px", fontWeight: 600, color: props.color,
					background: tint(props.color, 12), border: `1px solid ${props.color}`,
					borderRadius: "var(--dsw-radius-sm)", flex: "none", whiteSpace: "nowrap",
				},
				children: [jsx(Dot, { color: props.color }, "dot"), jsx("span", { children: props.label }, "label")],
			});
		}
		/** One action button; disabled gets the shared 50% + not-allowed treatment. */
		const btn = (key, label, onClick, style, disabled, title, iconName) => jsxs("button", {
			type: "button", onClick, title, disabled: disabled === true,
			style: disabled === true ? { ...style, ...disabledStyle } : style,
			"data-orrery-worktree-action": key,
			children: [
				iconName ? jsx(Icon, { name: iconName, size: 12 }, "icon") : null,
				jsx("span", { children: label }, "label"),
			],
		}, key);
		// ---- diff rendering ----
		const diffLineStyle = (kind) => {
			const base = { padding: "0 8px", whiteSpace: "pre" };
			if (kind === "add") return { ...base, color: SUCCESS, background: tint(SUCCESS, 10) };
			if (kind === "remove") return { ...base, color: ERROR, background: tint(ERROR, 10) };
			if (kind === "hunk" || kind === "meta") return { ...base, color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-interactive-bg-solid)" };
			return { ...base, color: "var(--dsw-alias-label-primary)" };
		};
		/** Unified diff with full-bleed line stripes inside a radius-md frame. @param {{ lines: Array<{ text: string, kind: string }>, tool?: boolean }} props */
		function DiffLines(props) {
			return jsx("pre", {
				...(props.tool ? { "data-orrery-worktree-tool-diff": "" } : { "data-orrery-worktree-diff": "" }),
				style: {
					margin: "8px 0 0", padding: "6px 0", maxHeight: "280px", overflow: "auto",
					background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: "var(--dsw-radius-md, 8px)", fontFamily: MONO, fontSize: "11px", lineHeight: "16px",
				},
				children: jsx("div", {
					style: { display: "inline-block", minWidth: "100%" },
					children: props.lines.map((line, index) => jsx("div", { style: diffLineStyle(line.kind), children: line.text === "" ? " " : line.text }, index)),
				}),
			});
		}
		/** One verification row: ✓/✗ + name + seconds + exit-code chip on failure. @param {{ entry: { name: string, exit: number | null, ms: number | null }, t: (key: string) => string }} props */
		function CheckRow(props) {
			const entry = props.entry;
			const ok = entry.exit === 0;
			return jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "6px", ...text.meta },
				children: [
					jsx("span", { style: { color: ok ? SUCCESS : ERROR, display: "inline-flex" }, children: jsx(Icon, { name: ok ? "check" : "x", size: 11 }) }, "icon"),
					jsx("span", { style: { ...mono, fontSize: "12px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: entry.name }, "name"),
					typeof entry.ms === "number" ? jsx("span", { style: { ...text.foot, flex: "none" }, children: `${Math.round(entry.ms / 1000)}s` }, "ms") : null,
					!ok && entry.exit !== null ? jsx("span", {
						style: { ...text.foot, flex: "none", color: ERROR, border: `1px solid ${ERROR}`, borderRadius: "var(--dsw-radius-sm)", padding: "0 5px" },
						children: props.t("exitCode").replace("{code}", String(entry.exit)),
					}, "exit") : null,
				],
			});
		}
		/** A lane `next` in the GUI language: the tool or the wait reason. */
		function localNext(next, t) {
			if (!next || typeof next !== "object") return "";
			if (typeof next.tool === "string") return t(`next_${next.tool}`);
			if (typeof next.waitFor === "string") return t(`wait_${next.waitFor.replace(/-/g, "_")}`);
			return "";
		}
		/** One read of the host view; never throws. */
		const read = (fetchView, narrow) => Promise.resolve().then(() => fetchView?.()).then(
			(value) => {
				if (value === null || value === undefined) return { view: null, error: null };
				// Narrow at the boundary: degraded endpoint shapes and malformed
				// payloads never reach the components as a truthy non-view.
				if (typeof narrow === "function") {
					const narrowed = narrow(value);
					if (narrowed === null) return { view: null, error: "malformed view payload" };
					return { view: narrowed, error: null };
				}
				return { view: value, error: null };
			},
			(reason) => ({ view: null, error: reason instanceof Error ? reason.message : String(reason) })
		);
		const useOwnedLanes = (props) => {
			const hook = typeof props.useProjection === "function" ? props.useProjection : null;
			const state = hook ? hook(props.WORKTREE_PROJECTION_KEY) : undefined;
			return state && typeof state === "object" ? state : undefined;
		};
		/** Shared read+refresh loop: reads on mount, on demand, and while a lane is in transition. */
		function useLaneView(props, enabled, intervalMs) {
			const [state, setState] = react.useState({ view: null, error: null });
			const [tick, setTick] = react.useState(0);
			const refresh = () => read(props.fetchView, props.narrowView).then((next) => setState(next));
			react.useEffect(() => {
				if (!enabled) return undefined;
				let alive = true;
				read(props.fetchView, props.narrowView).then((next) => { if (alive) setState(next); });
				return () => { alive = false; };
			}, [enabled, tick]);
			const polling = enabled && props.needsPolling?.(state.view);
			react.useEffect(() => {
				if (!polling) return undefined;
				const timer = setInterval(() => { read(props.fetchView, props.narrowView).then((next) => setState(next)); }, intervalMs ?? 5000);
				return () => clearInterval(timer);
			}, [polling, intervalMs]);
			return { state, refresh, reload: () => setTick((value) => value + 1) };
		}
		/** True when the session offers the /worktree command (capability gate). */
		function useCommandPresence(props) {
			const [available, setAvailable] = react.useState(null);
			react.useEffect(() => {
				if (!props.sessionId) { setAvailable(false); return undefined; }
				let alive = true;
				Promise.resolve(props.commandsList?.(props.sessionId)).then(
					(list) => { if (alive) setAvailable(Array.isArray(list) && list.some((entry) => entry?.name === "worktree")); },
					() => { if (alive) setAvailable(false); }
				);
				return () => { alive = false; };
			}, [props.sessionId]);
			return available;
		}
		/** U1 — session list row marker: branch glyph + active count, amber when approval waits. */
		function WorktreeRowMarker(props) {
			const projection = useOwnedLanes(props);
			const lanes = Array.isArray(projection?.lanes) ? projection.lanes : [];
			const mode = projection?.mode === true;
			if (!(mode || lanes.length > 0)) return null;
			// Count lanes awaiting approval. The projection records lane ids today;
			// object entries carrying a state are counted the moment it ships them.
			const awaiting = lanes.filter((lane) => lane !== null && typeof lane === "object" && lane.state === "awaiting-approval").length;
			const color = awaiting > 0 ? WARN : mode ? BUSINESS : "var(--dsw-alias-label-tertiary)";
			return jsxs("span", {
				"data-orrery-worktree-marker": "",
				"data-orrery-worktree-count": String(lanes.length),
				title: mode ? "Worktree mode · lanes" : "Worktree lanes",
				style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "10px", lineHeight: "12px", color },
				children: [
					jsx(Icon, { name: "branch", size: 11 }, "icon"),
					lanes.length > 0 ? jsx("span", { children: String(lanes.length) }, "count") : null,
				],
			});
		}
		/** U2 — session header status pill: badge look, warning tint on awaiting/base-moved, click opens the panel. */
		function WorktreeStatusPill(props) {
			const available = useCommandPresence(props);
			const enabled = available === true;
			const { state } = useLaneView(props, enabled);
			if (!enabled) return null;
			const view = state.view;
			const summary = props.summaryOf(view, true);
			const t = props.t;
			const label = summary.mode ? t("pillMode") : t("pillLanes");
			const parts = [label];
			if (summary.active > 0) parts.push(t("pillCount").replace("{n}", String(summary.active)));
			if (summary.awaiting > 0) parts.push(t("pillAwaiting").replace("{n}", String(summary.awaiting)));
			const attention = summary.baseMoved || summary.awaiting > 0;
			const color = attention ? WARN : summary.mode ? BUSINESS : "var(--dsw-alias-label-tertiary)";
			return jsxs("button", {
				type: "button",
				style: {
					display: "inline-flex", alignItems: "center", gap: "5px", padding: "1px 7px",
					fontSize: "11px", lineHeight: "16px", fontWeight: 600, color, cursor: "pointer",
					background: tint(color, 12), border: `1px solid ${color}`, borderRadius: "var(--dsw-radius-sm)",
				},
				onClick: () => props.openPanel?.(),
				title: summary.baseMoved ? t("pillBaseMoved") : t("pillTitle"),
				"data-orrery-worktree-pill": "",
				"data-orrery-worktree-state": summary.baseMoved ? "base-moved" : summary.mode ? "on" : "off",
				children: [jsx(Dot, { color }, "dot"), jsx("span", { children: parts.join(" · ") }, "label")],
			});
		}
		/** One lane card in the panel. */
		function LaneCard(props) {
			const lane = props.lane;
			const model = props.model;
			const t = props.t;
			const [diff, setDiff] = react.useState(null);
			const [armed, setArmed] = react.useState(null);
			const lines = diff !== null ? props.diffLines(diff) : [];
			const action = (key) => lane.actions?.[key] ?? { enabled: false, reason: t("actionUnavailable") };
			const run = (key, option) => props.run(lane, key, option).then(() => setArmed(null));
			const busy = props.busy;
			const loadDiff = () => {
				if (diff !== null) { setDiff(null); return; }
				Promise.resolve(props.fetchDiff?.(lane.id)).then(
					(value) => setDiff(typeof value === "string" ? value : ""),
					(reason) => setDiff(`diff unavailable: ${reason instanceof Error ? reason.message : String(reason)}`)
				);
			};
			const landable = action("land").enabled;
			const setupFailed = action("setup").enabled;
			const removeOptions = [["worktree", t("cleanupWorktree")], ["all", t("cleanupAll")]];
			const ahead = lane.ahead ?? 0;
			const behind = lane.behind ?? 0;
			const children = [
				// 1. header: state badge | title | base-moved warning | relative time
				jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }, children: [
					jsx(Badge, { label: t(`state_${lane.state}`), color: model.colorOf(lane.state) }, "badge"),
					jsx("span", { style: { ...text.title, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: lane.title, children: lane.title }, "title"),
					lane.baseMoved ? jsx(Badge, { label: t("baseMoved"), color: WARN }, "moved") : null,
					lane.watchCount > 0 ? jsxs("span", {
						style: { ...text.foot, flex: "none", display: "inline-flex", alignItems: "center", gap: "3px" },
						title: lane.watchStates.map((s) => t(`state_${s}`)).join(", "),
						children: [
							jsx(Icon, { name: "eye", size: 11 }, "icon"),
							jsx("span", { children: t("watching").replace("{n}", String(lane.watchCount)) }, "count"),
						],
					}, "watching") : null,
					lane.updatedAt ? jsxs("span", { style: { ...text.foot, flex: "none", display: "inline-flex", alignItems: "center", gap: "3px" }, children: [
						jsx(Icon, { name: "clock", size: 11 }, "icon"),
						jsx("span", { children: props.ago(lane.updatedAt) }, "ago"),
					] }, "time") : null,
				] }, "head"),
				// 2. branch row: branch → base | ↑↓ chips | diffstat | lane id
				jsxs("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "5px", minWidth: 0, color: "var(--dsw-alias-label-tertiary)" }, children: [
					jsx(Icon, { name: "branch", size: 12 }, "icon"),
					jsx("span", { style: { ...mono, fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: `${lane.branch} → ${lane.base ?? "?"}` }, "branches"),
					lane.ahead !== null && (ahead > 0 || behind > 0) ? jsx("span", {
						style: { ...text.foot, flex: "none", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)", padding: "0 5px", color: "var(--dsw-alias-label-secondary)" },
						children: `↑${ahead} ↓${behind}`,
					}, "counts") : null,
					lane.stat ? jsxs("span", { style: { ...mono, fontSize: "11px", lineHeight: "15px", flex: "none", display: "inline-flex", gap: "4px", alignItems: "baseline" }, children: [
						jsx("span", { style: { color: SUCCESS }, children: `+${lane.stat.added}` }, "add"),
						jsx("span", { style: { color: ERROR }, children: `−${lane.stat.removed}` }, "remove"),
						jsx("span", { style: text.foot, children: t("files").replace("{n}", String(lane.stat.files)) }, "files"),
					] }, "stat") : null,
					jsx("span", { style: { ...text.foot, ...mono, marginLeft: "auto", flex: "none", maxWidth: "38%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: lane.id, children: lane.id }, "id"),
				] }, "meta"),
				// 3. callouts: reason (attention) and next step (business)
				lane.reason ? jsx("div", { style: { ...calloutStyle(ERROR), marginTop: "6px" }, "data-orrery-worktree-reason": "", children: lane.reason }, "reason") : null,
				lane.next ? jsx("div", { style: { ...calloutStyle(BUSINESS), marginTop: "6px" }, "data-orrery-worktree-next": "", children: t("nextLabel").replace("{next}", localNext(lane.next, t)) }, "next") : null,
				// 4. verification rows
				lane.check?.enabled && lane.check.results.length ? jsx("div", {
					style: { marginTop: "6px", display: "flex", flexDirection: "column", gap: "3px" },
					"data-orrery-worktree-checks": "",
					children: lane.check.results.map((entry) => jsx(CheckRow, { entry, t }, entry.name)),
				}, "checks") : null,
				// 5. action row: one primary at most, then secondary / danger / ghost
				jsxs("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", marginTop: "8px" }, children: [
					landable ? (armed === "land"
						? btn("land-confirm", t("landConfirm"), () => run("land"), primaryStyle, busy)
						: btn("land", t("land"), () => setArmed("land"), primaryStyle, busy, action("land").reason ?? null)) : null,
					setupFailed ? btn("setup", t("retrySetup"), () => run("setup"), landable ? secondaryStyle : primaryStyle, busy) : null,
					setupFailed ? btn("setup-skip", t("skipSetup"), () => run("setup", "skip"), ghostStyle, busy) : null,
					action("check").enabled ? btn("check", t("recheck"), () => run("check"), secondaryStyle, busy) : null,
					action("clean").enabled ? removeOptions.map(([option, optionLabel]) => option === "all"
						? (armed === "clean-all"
							? btn("clean-all-confirm", t("cleanupAllConfirm"), () => run("clean", "all"), dangerSolidStyle, busy)
							: btn("clean-all", optionLabel, () => setArmed("clean-all"), dangerStyle, busy))
						: btn(`clean-${option}`, optionLabel, () => run("clean", option), secondaryStyle, busy)) : null,
					action("abandon").enabled ? (armed === "abandon"
						? btn("abandon-confirm", t("abandonConfirm"), () => run("abandon"), dangerSolidStyle, busy)
						: btn("abandon", t("abandon"), () => setArmed("abandon"), dangerStyle, busy, action("abandon").reason ?? null)) : null,
					jsx("span", { style: { flex: 1 } }, "spacer"),
					btn("diff", diff === null ? t("viewDiff") : t("hideDiff"), loadDiff, ghostStyle, !action("diff").enabled, action("diff").reason ?? null),
					action("copyPath").enabled ? btn("copy-path", t("copyPath"), () => props.copyPath?.(lane.path), ghostStyle, false, null, "copy") : null,
					!action("diff").enabled ? jsx("span", { style: text.foot, children: t("diffUnavailable") }, "diff-disabled") : null,
					!landable && action("land").reason ? jsx("span", { style: { ...text.foot, flexBasis: "100%" }, children: action("land").reason }, "land-reason") : null,
				] }, "actions"),
				// 6. expandable diff
				diff !== null ? (lines.length
					? jsx(DiffLines, { lines }, "diff")
					: jsx("div", { style: { ...text.foot, marginTop: "8px" }, "data-orrery-worktree-diff": "", children: t("noChanges") }, "diff")) : null,
			];
			return jsx("div", {
				"data-orrery-worktree-lane": lane.id,
				"data-orrery-worktree-state": lane.state,
				style: cardStyle,
				children,
			}, lane.id);
		}
		/** Panel toolbar mode toggle (persistent): solid business badge when on,
		 * outlined chip when off — the retired composer switch's semantics. The
		 * panel owns the click channel, the busy state, and the disabled reason. */
		function WorktreeModeToggle(props) {
			const on = props.mode === true;
			const disabled = props.disabled === true;
			const style = on
				? { ...buttonBase, background: BUSINESS, border: "none", color: "var(--dsw-alias-bg-base)", fontWeight: 600 }
				: { ...buttonBase, borderColor: "var(--dsw-alias-border-l2)" };
			return jsxs("button", {
				type: "button",
				style: disabled ? { ...style, ...disabledStyle } : style,
				onClick: props.onToggle, disabled,
				"aria-pressed": on, title: props.title,
				"data-orrery-worktree-mode": on ? "on" : "off",
				children: [
					jsx(Dot, { color: on ? "var(--dsw-alias-bg-base)" : "var(--dsw-alias-label-tertiary)" }, "dot"),
					jsx("span", { children: props.t("modeLabel") }, "label"),
				],
			});
		}
		/** U3 — lanes panel (right sidebar tab body). */
		function LanesPanel(props) {
			const t = props.t;
			const model = props.model;
			const enabled = props.available !== false;
			const { state, reload } = useLaneView(props, enabled, props.intervalMs);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [history, setHistory] = react.useState(false);
			const [init, setInit] = react.useState(null);
			const [setup, setSetup] = react.useState("");
			const [setupWarning, setSetupWarning] = react.useState(null);
			const [rows, setRows] = react.useState([]);
			const view = state.view;
			const groups = model.groupLanes(view?.lanes ?? []);
			const runLine = (line) => {
				if (busy) return Promise.resolve();
				setBusy(true);
				setError(null);
				return Promise.resolve(props.runWorktree(line)).then(
					(outcome) => {
						setBusy(false);
						if (outcome && outcome.kind !== "success") { setError(outcome.text ?? "action failed"); return; }
						reload();
					},
					(reason) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); }
				);
			};
			const run = (lane, key, option) => runLine(model.commandFor(key, lane, option));
			// The toolbar mode toggle runs /worktree on|off through the same
			// command channel (busy guard, error surface, reload) as every
			// other panel action.
			const toggleMode = () => runLine(view?.mode === true ? "off" : "on");
			const copyPath = (path) => {
				try {
					const clipboard = globalThis.navigator?.clipboard;
					if (clipboard?.writeText) clipboard.writeText(path);
				} catch {
					// clipboard unavailable: nothing to report
				}
			};
			const openConfig = () => {
				setError(null);
				Promise.resolve(props.runWorktree("init")).then(
					(outcome) => {
						if (!outcome || outcome.kind !== "success") { setError(outcome?.text ?? "init unavailable"); return; }
						const parsed = model.parseInit(outcome.text);
						if (!parsed) { setError(t("initParseFailed")); return; }
						setInit(parsed);
						setSetup(parsed.current?.setup ?? parsed.suggested.setup ?? "");
						setSetupWarning(parsed.suggested.setupWarning ?? null);
						setRows((parsed.current?.check?.length ? parsed.current.check : parsed.suggested.check ?? []).map((entry) => ({ name: String(entry.name ?? ""), run: String(entry.run ?? "") })));
					},
					(reason) => setError(reason instanceof Error ? reason.message : String(reason))
				);
			};
			const saveConfig = () => {
				const payload = model.configPayload(setup, rows);
				setBusy(true);
				Promise.resolve(props.runWorktree(`init write ${payload}`)).then(
					(outcome) => { setBusy(false); if (!outcome || outcome.kind !== "success") setError(outcome?.text ?? "save failed"); else { setInit(null); reload(); } },
					(reason) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); }
				);
			};
			const labelStyle = { ...text.foot, display: "block", margin: "8px 0 3px" };
			const rowEditor = (row, index) => jsxs("div", { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "4px" }, children: [
				jsx("input", { "data-orrery-worktree-config-name": "", value: row.name, placeholder: t("configName"), "aria-label": t("configName"), onChange: (event) => setRows((current) => current.map((entry, at) => (at === index ? { ...entry, name: event.target.value } : entry))), style: { ...inputStyle, width: "30%" } }, "name"),
				jsx("input", { "data-orrery-worktree-config-run": "", value: row.run, placeholder: t("configRun"), "aria-label": t("configRun"), onChange: (event) => setRows((current) => current.map((entry, at) => (at === index ? { ...entry, run: event.target.value } : entry))), style: { ...inputStyle, flex: 1 } }, "run"),
				jsx("button", { type: "button", style: { ...ghostStyle, color: ERROR }, title: t("configRemove"), "aria-label": t("configRemove"), onClick: () => setRows((current) => current.filter((entry, at) => at !== index)), children: jsx(Icon, { name: "x", size: 12 }) }, "remove"),
			] }, index);
			const laneCards = (lanes) => lanes.map((lane) => jsx(LaneCard, { lane, model, t, busy, run, fetchDiff: props.fetchDiff, diffLines: props.diffLines, ago: props.ago, copyPath }, lane.id));
			// Persistent toolbar mode toggle: rendered whenever a view exists;
			// disabled with the reason when lanes are unavailable.
			const unavailableReason = view?.available === false ? (view.enabled === false ? t("disabled") : (view.error?.message ?? t("unavailable"))) : null;
			const modeToggle = view ? jsx(WorktreeModeToggle, {
				mode: view.mode === true,
				disabled: view.available === false || busy,
				title: view.available === false ? `${t("modeUnavailable")} ${unavailableReason}` : t("modeTitle"),
				onToggle: toggleMode,
				t,
			}, "mode") : null;
			const children = [];
			if (!view) {
				children.push(jsx("div", {
					style: { ...text.meta, textAlign: "center", padding: "18px 12px", color: "var(--dsw-alias-label-tertiary)" },
					children: state.error ? t("loadFailed") : t("loading"),
				}, "loading"));
			} else if (view.available === false) {
				children.push(jsx("div", {
					"data-orrery-worktree-unavailable": "",
					style: calloutStyle(view.enabled === false ? "var(--dsw-alias-label-tertiary)" : ERROR),
					children: view.enabled === false ? t("disabled") : (view.error?.message ?? t("unavailable")),
				}, "unavailable"));
				children.push(jsxs("div", { style: { display: "flex", alignItems: "center", gap: "2px", marginTop: "8px" }, children: [
					jsx("span", { style: { flex: 1 } }, "spacer"),
					modeToggle,
				] }, "toolbar"));
			} else {
				const verification = view.repo?.verification;
				// Repo info card: base branch chip, git version, verification and exclude status.
				const verifyRow = [];
				if (verification?.error) {
					verifyRow.push(jsx("span", { style: { color: WARN, display: "inline-flex" }, children: jsx(Icon, { name: "warn", size: 11 }) }, "icon"));
					verifyRow.push(jsx("span", { style: { ...text.meta, minWidth: 0, overflowWrap: "anywhere" }, children: verification.error }, "error"));
				} else if (verification?.enabled) {
					verifyRow.push(jsx("span", { style: { color: SUCCESS, display: "inline-flex" }, children: jsx(Icon, { name: "check", size: 11 }) }, "icon"));
					verifyRow.push(jsx("span", { style: text.meta, children: t("verificationOn").replace("{n}", String(verification.commands.length || 0)) }, "label"));
				} else {
					verifyRow.push(jsx("span", { style: text.meta, children: t("verificationOff") }, "label"));
				}
				if (!verification?.enabled || verification?.error) {
					verifyRow.push(jsx("button", { type: "button", style: ghostStyle, onClick: openConfig, "data-orrery-worktree-action": "configure", children: t("configure") }, "configure"));
				}
				children.push(jsxs("div", { "data-orrery-worktree-repo": "", style: { ...cardStyle, padding: "8px 10px", display: "flex", flexDirection: "column", gap: "4px" }, children: [
					jsxs("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }, children: [
						jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", display: "inline-flex" }, children: jsx(Icon, { name: "branch", size: 12 }) }, "icon"),
						jsx("span", {
							style: { ...mono, fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-interactive-bg-solid)", borderRadius: "var(--dsw-radius-sm)", padding: "1px 6px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
							title: view.repo?.branch ?? undefined,
							children: view.repo?.branch ?? "?",
						}, "branch"),
						view.repo?.gitVersion ? jsx("span", { style: { ...text.foot, flex: "none" }, children: `git ${view.repo.gitVersion}` }, "git") : null,
						jsx("span", { style: { flex: 1 } }, "spacer"),
						view.repo?.exclude
							? jsxs("span", { style: { ...text.foot, flex: "none", display: "inline-flex", alignItems: "center", gap: "3px", color: SUCCESS }, children: [jsx(Icon, { name: "check", size: 11 }, "icon"), jsx("span", { children: t("excludeOk") }, "label")] }, "exclude")
							: jsxs("span", { style: { ...text.foot, flex: "none", display: "inline-flex", alignItems: "center", gap: "3px", color: WARN }, children: [jsx(Icon, { name: "warn", size: 11 }, "icon"), jsx("span", { children: t("excludeMissing") }, "label")] }, "exclude"),
					] }, "repo-head"),
					jsx("div", { style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }, children: verifyRow }, "repo-verify"),
					view.repo?.root ? jsx("div", { style: { ...text.foot, ...mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: view.repo.root, children: view.repo.root }, "repo-root") : null,
				] }, "repo"));
				// Toolbar: refresh, verification configure, history toggle, spacer, mode toggle.
				children.push(jsxs("div", { style: { display: "flex", alignItems: "center", gap: "2px", marginTop: "8px" }, children: [
					jsx("button", { type: "button", style: { ...ghostStyle, padding: "3px 5px" }, onClick: reload, title: t("refresh"), "aria-label": t("refresh"), "data-orrery-worktree-action": "refresh", children: jsx(Icon, { name: "refresh", size: 13 }) }, "refresh"),
					btn("configure", t("configure"), openConfig, ghostStyle, false, t("configure"), "sliders"),
					groups.history.length ? btn("history", history ? t("hideHistory") : t("showHistory").replace("{n}", String(groups.history.length)), () => setHistory(!history), ghostStyle, false, null, "history") : null,
					jsx("span", { style: { flex: 1 } }, "spacer"),
					modeToggle,
				] }, "toolbar"));
				if (init) {
					children.push(jsxs("div", { "data-orrery-worktree-config": "", style: { ...cardStyle, marginTop: "8px" }, children: [
						jsx("div", { style: { ...text.foot, ...mono }, children: init.file ?? "" }, "file"),
						setupWarning ? jsx("div", { "data-orrery-worktree-setup-warning": "", style: { ...calloutStyle(WARN), marginTop: "6px" }, children: setupWarning }, "warn") : null,
						init.error ? jsx("div", { style: { ...calloutStyle(ERROR), marginTop: "6px" }, children: init.error }, "error") : null,
						jsx("label", { style: labelStyle, children: t("configSetup") }, "setup-label"),
						jsx("input", { "data-orrery-worktree-config-setup": "", value: setup, placeholder: t("configSetup"), onChange: (event) => setSetup(event.target.value), style: inputStyle }, "setup"),
						rows.length ? jsx("label", { style: labelStyle, children: t("configChecks") }, "rows-label") : null,
						...rows.map(rowEditor),
						jsxs("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px" }, children: [
							jsx("button", { type: "button", style: ghostStyle, onClick: () => setRows((current) => [...current, { name: "", run: "" }]), children: t("configAdd") }, "add"),
							jsx("span", { style: { flex: 1 } }, "spacer"),
							jsx("button", { type: "button", style: busy ? { ...primaryStyle, ...disabledStyle } : primaryStyle, disabled: busy, onClick: saveConfig, children: t("configSave") }, "save"),
							jsx("button", { type: "button", style: ghostStyle, onClick: () => setInit(null), children: t("cancel") }, "cancel"),
						] }, "config-actions"),
						jsx("div", { style: { ...text.foot, marginTop: "6px" }, children: t("configHint") }, "hint"),
					] }, "config"));
				}
				if (groups.active.length === 0) {
					children.push(jsxs("div", { "data-orrery-worktree-empty": "", style: { textAlign: "center", padding: "20px 12px" }, children: [
						jsx("div", { style: { display: "flex", justifyContent: "center", color: "var(--dsw-alias-label-tertiary)" }, children: jsx(Icon, { name: "branch", size: 44 }) }, "icon"),
						jsx("div", { style: { ...text.title, marginTop: "8px" }, children: t("emptyTitle") }, "title"),
						jsx("div", { style: { ...text.meta, marginTop: "4px", maxWidth: "300px", marginLeft: "auto", marginRight: "auto" }, children: t("emptyBody") }, "body"),
					] }, "empty"));
				}
				if (groups.active.length > 0) {
					children.push(jsx("div", { style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }, children: laneCards(groups.active) }, "lanes"));
				}
				if (groups.history.length > 0) {
					children.push(jsxs("div", { style: { marginTop: "10px" }, children: [
						jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-separator-primary, var(--dsw-alias-border-l2))" } }, "sep"),
						jsxs("button", {
							type: "button", onClick: () => setHistory(!history), "aria-expanded": history,
							style: { ...ghostStyle, marginTop: "6px", color: "var(--dsw-alias-label-tertiary)" },
							children: [
								jsx(Chevron, { open: history, size: 11 }, "chevron"),
								jsx(Icon, { name: "history", size: 12 }, "icon"),
								jsx("span", { children: t("showHistory").replace("{n}", String(groups.history.length)) }, "label"),
							],
						}, "toggle"),
						history ? jsx("div", {
							style: { display: "flex", flexDirection: "column", gap: "8px", marginTop: "6px", opacity: 0.85 },
							children: laneCards(groups.history),
						}, "cards") : null,
					] }, "history"));
				}
				if (view.unmanaged.length) {
					children.push(jsx("div", { style: { ...text.foot, marginTop: "10px" }, "data-orrery-worktree-unmanaged": "", children: t("unmanaged").replace("{n}", String(view.unmanaged.length)) }, "unmanaged"));
				}
			}
			if (error) children.push(jsx("div", { style: { ...calloutStyle(ERROR), marginTop: "8px" }, "data-orrery-worktree-error": "", children: error }, "error"));
			if (state.error && view) children.push(jsxs("div", { style: { ...text.foot, marginTop: "8px", display: "flex", alignItems: "center", gap: "4px", color: WARN }, children: [jsx(Icon, { name: "warn", size: 11 }, "icon"), jsx("span", { children: t("staleData") }, "label")] }, "stale"));
			return jsx("div", { "data-orrery-worktree-panel": "", style: { padding: "8px 2px", minWidth: 0, maxWidth: "100%", overflowX: "hidden" }, children }, NS_LABEL);
		}
		/** U6 — conversation tool cards for the six lane tools. */
		const TOOL_ICON = { worktree_open: "branch", worktree_check: "check", worktree_land: "arrowRight", worktree_cleanup: "x", worktree_abandon: "warn", worktree_watch: "eye" };
		function WorktreeToolRow(props) {
			const model = props.model;
			const meta = model.narrowToolMeta(props.block?.meta);
			const t = props.t;
			const [open, setOpen] = react.useState(false);
			if (!meta) return jsx(WorktreeFlatFallback, props);
			const title = t(`tool_${meta.tool}`);
			const state = meta.state;
			// Every visible row is built from structured meta in the GUI language;
			// the host's English summary (written for the model) is only the hover.
			const bodyRows = [];
			if (meta.from && meta.from !== state) {
				bodyRows.push(jsxs("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }, children: [
					jsx(Badge, { label: t(`state_${meta.from}`), color: model.colorOf(meta.from) }, "from"),
					jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", display: "inline-flex" }, children: jsx(Icon, { name: "arrowRight", size: 11 }) }, "arrow"),
					jsx(Badge, { label: t(`state_${state}`), color: model.colorOf(state) }, "to"),
				] }, "states"));
			}
			if (meta.watch) {
				bodyRows.push(jsxs("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }, children: [
					jsx("span", { style: text.foot, children: t("watchStates") }, "label"),
					...meta.watch.states.map((s) => jsx(Badge, { label: t(`state_${s}`), color: model.colorOf(s) }, s)),
				] }, "watch"));
				if (Number.isFinite(meta.watch.expiresAt)) {
					const at = new Date(meta.watch.expiresAt);
					bodyRows.push(jsx("div", { style: text.foot, title: at.toISOString(), children: t("watchExpires").replace("{time}", at.toLocaleString()) }, "watch-expires"));
				}
			}
			if (meta.hit) {
				bodyRows.push(jsxs("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }, children: [
					jsx("span", { style: text.foot, children: t("watchHit") }, "label"),
					jsx(Badge, { label: t(`state_${meta.hit}`), color: model.colorOf(meta.hit) }, "state"),
				] }, "watch-hit"));
			}
			if (meta.conflicts.length) {
				bodyRows.push(jsxs("div", { style: calloutStyle(ERROR), children: [
					jsx("div", { style: { fontWeight: 600, marginBottom: "2px" }, children: t("conflicts") }, "label"),
					...meta.conflicts.map((path) => jsx("div", { style: { ...mono, fontSize: "11px" }, children: path }, path)),
				] }, "conflicts"));
			}
			if (meta.check.length) {
				bodyRows.push(jsx("div", { style: { display: "flex", flexDirection: "column", gap: "3px" }, children: meta.check.map((entry) => jsx(CheckRow, { entry, t }, entry.name)) }, "checks"));
			}
			if (meta.merge?.commit) {
				bodyRows.push(jsxs("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }, children: [
					jsx("span", { style: text.foot, children: t("mergeCommit") }, "label"),
					jsx("span", { style: { ...mono, fontSize: "11px", background: "var(--dsw-alias-interactive-bg-solid)", borderRadius: "var(--dsw-radius-sm)", padding: "1px 6px", color: "var(--dsw-alias-label-primary)" }, children: String(meta.merge.commit).slice(0, 10) }, "sha"),
					meta.merge.stat ? jsxs("span", { style: { ...mono, fontSize: "11px", display: "inline-flex", gap: "4px" }, children: [
						jsx("span", { style: { color: SUCCESS }, children: `+${meta.merge.stat.added}` }, "add"),
						jsx("span", { style: { color: ERROR }, children: `−${meta.merge.stat.removed}` }, "remove"),
					] }, "stat") : null,
				] }, "merge"));
			}
			if (meta.cleanup?.state) {
				bodyRows.push(jsxs("div", { style: { display: "flex", alignItems: "center", gap: "6px" }, children: [
					jsx("span", { style: text.foot, children: t("cleanup") }, "label"),
					jsx(Badge, { label: t(`state_${meta.cleanup.state}`), color: model.colorOf(meta.cleanup.state) }, "state"),
				] }, "cleanup"));
			}
			if (meta.cleanup?.error) {
				bodyRows.push(jsx("div", { style: calloutStyle(ERROR), children: `${t("cleanup")}: ${meta.cleanup.error}` }, "cleanup-error"));
			}
			if (meta.next) {
				bodyRows.push(jsx("div", { style: calloutStyle(BUSINESS), children: t("nextLabel").replace("{next}", localNext(meta.next, t)) }, "next"));
			}
			const diff = open ? model.diffLines(meta.diff) : [];
			return jsxs("div", {
				"data-tool": meta.tool,
				"data-orrery-worktree-tool": meta.tool,
				"data-orrery-worktree-state": state,
				style: { ...cardStyle, padding: "8px 10px" },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0, cursor: meta.diff ? "pointer" : "default", userSelect: "none" },
						role: meta.diff ? "button" : undefined,
						tabIndex: meta.diff ? 0 : undefined,
						"aria-expanded": meta.diff ? open : undefined,
						onClick: meta.diff ? () => setOpen(!open) : undefined,
						onKeyDown: meta.diff ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(!open); } } : undefined,
						children: [
							jsx("span", { style: { color: model.colorOf(state), display: "inline-flex" }, children: jsx(Icon, { name: TOOL_ICON[meta.tool] ?? "branch", size: 13 }) }, "icon"),
							jsx("span", { style: { ...text.title, flex: "none" }, children: title }, "title"),
							meta.lane ? jsx("button", {
								type: "button",
								style: { ...ghostStyle, ...mono, fontSize: "11px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%" },
								title: meta.lane,
								onClick: (event) => { event.stopPropagation(); if (typeof props.openFile === "function" && meta.lane) props.openFile(meta.lane); },
								children: meta.lane,
							}, "lane") : null,
							jsx("span", { style: { flex: 1 } }, "spacer"),
							jsx(Badge, { label: t(`state_${state}`), color: model.colorOf(state) }, "state"),
							meta.diff ? jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", display: "inline-flex" }, children: jsx(Chevron, { open, size: 11 }) }, "chevron") : null,
						],
					}, "head"),
					bodyRows.length ? jsx("div", { title: meta.summary || undefined, style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px" }, children: bodyRows }, "body") : null,
					open && diff.length ? jsx(DiffLines, { lines: diff, tool: true }, "diff") : null,
				],
			});
		}
		/** Fallback body for a lane tool call without persisted metadata. */
		function WorktreeFlatFallback(props) {
			const block = props.block;
			const argsRaw = typeof block?.argsRaw === "string" ? block.argsRaw : typeof block?.call?.argsRaw === "string" ? block.call.argsRaw : null;
			const output = Array.isArray(block?.content) ? block.content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).filter((value) => value !== "").join("\n") : "";
			const hintStyle = { ...text.foot, marginBottom: "3px" };
			const preStyle = {
				margin: 0, padding: "6px 8px", fontFamily: MONO, fontSize: "11px", lineHeight: "16px",
				whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "240px", overflow: "auto",
				border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md, 8px)",
				background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-secondary)",
			};
			return jsxs("div", {
				"data-tool": typeof block?.name === "string" ? block.name : "worktree",
				"data-orrery-worktree-flat": "",
				style: { ...cardStyle, padding: "8px 10px", display: "flex", flexDirection: "column", gap: "8px" },
				children: [
					argsRaw !== null ? jsxs("div", { children: [jsx("div", { style: hintStyle, children: props.t("flatInput") }, "hint"), jsx("pre", { style: preStyle, children: argsRaw }, "pre")] }, "input") : null,
					output !== "" ? jsxs("div", { children: [jsx("div", { style: hintStyle, children: props.t("flatOutput") }, "hint"), jsx("pre", { style: preStyle, children: output }, "pre")] }, "output") : null,
				],
			});
		}
		exports.WorktreeRowMarker = WorktreeRowMarker;
		exports.WorktreeStatusPill = WorktreeStatusPill;
		exports.LanesPanel = LanesPanel;
		exports.LaneCard = LaneCard;
		exports.WorktreeToolRow = WorktreeToolRow;
		exports.WorktreeFlatFallback = WorktreeFlatFallback;
		return module.exports;
	}
});
