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
		const chipStyle = {
			display: "inline-flex", alignItems: "center", gap: "6px", background: "none",
			border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)",
			cursor: "pointer", padding: "3px 8px", fontSize: "12px", lineHeight: "16px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const linkStyle = { background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline" };
		const dangerButton = { ...chipStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" };
		const primaryButton = { ...chipStyle, color: "var(--dsw-alias-label-primary)", borderColor: "var(--dsw-alias-label-secondary)", fontWeight: 600 };
		const muted = { color: "var(--dsw-alias-label-secondary)", overflowWrap: "anywhere", minWidth: 0 };
		const panelStyle = {
			position: "absolute", bottom: "calc(100% + 6px)", right: 0, zIndex: 20, width: "min(460px, 82vw)",
			maxHeight: "56vh", overflow: "auto", background: "var(--dsw-alias-bg-overlay)",
			border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md, 8px)",
			boxShadow: "0 6px 24px rgba(0,0,0,0.18)", padding: "10px 12px",
			color: "var(--dsw-alias-label-primary)", fontSize: "12px", lineHeight: "18px"
		};
		const mono = { fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)", overflowWrap: "anywhere", wordBreak: "break-word" };
		const errorStyle = { color: "var(--dsw-alias-state-error-primary)", marginTop: "6px", wordBreak: "break-word" };
		const dot = (color) => jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: color, flex: "none" } });
		const badge = (label, color) => jsx("span", {
			style: { display: "inline-flex", alignItems: "center", gap: "4px", padding: "1px 6px", borderRadius: "var(--dsw-radius-sm)", border: `1px solid ${color}`, color, flex: "none" },
			children: [dot(color), jsx("span", { children: label })]
		});
		const btn = (key, label, onClick, style, disabled, title) => jsx("button", {
			type: "button", style, disabled: disabled === true, onClick, title, "data-orrery-worktree-action": key, children: label
		}, key);
		/** A lane `next` in the GUI language: the tool or the wait reason. */
		function localNext(next, t) {
			if (!next || typeof next !== "object") return "";
			if (typeof next.tool === "string") return t(`next_${next.tool}`);
			if (typeof next.waitFor === "string") return t(`wait_${next.waitFor.replace(/-/g, "_")}`);
			return "";
		}
		/** One read of the host view; never throws. */
		const read = (fetchView) => Promise.resolve().then(() => fetchView?.()).then(
			(value) => ({ view: value ?? null, error: null }),
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
			const refresh = () => read(props.fetchView).then((next) => setState(next));
			react.useEffect(() => {
				if (!enabled) return undefined;
				let alive = true;
				read(props.fetchView).then((next) => { if (alive) setState(next); });
				return () => { alive = false; };
			}, [enabled, tick]);
			const polling = enabled && props.needsPolling?.(state.view);
			react.useEffect(() => {
				if (!polling) return undefined;
				const timer = setInterval(() => { read(props.fetchView).then((next) => setState(next)); }, intervalMs ?? 5000);
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
			const marker = { active: lanes.length, awaiting: 0 };
			const color = marker.awaiting > 0 ? "var(--dsw-alias-state-warn-primary)" : mode ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-tertiary)";
			return jsx("span", {
				"data-orrery-worktree-marker": "",
				"data-orrery-worktree-count": String(marker.active),
				title: mode ? "Worktree mode · lanes" : "Worktree lanes",
				style: { display: "inline-flex", alignItems: "center", gap: "3px", fontSize: "10px", lineHeight: "12px", color },
				children: [
					jsx("svg", { viewBox: "0 0 16 16", width: 11, height: 11, "aria-hidden": true, children: [
						jsx("circle", { cx: 3.5, cy: 3, r: 1.7, fill: color }),
						jsx("circle", { cx: 3.5, cy: 13, r: 1.7, fill: color }),
						jsx("circle", { cx: 12.5, cy: 8, r: 1.7, fill: color }),
						jsx("path", { d: "M3.5 4.7v6.6M3.5 8h7", stroke: color, strokeWidth: 1.2, fill: "none" })
					] }),
					marker.active > 0 ? jsx("span", { children: String(marker.active) }) : null
				]
			});
		}
		/** U2 — session header status pill: mode + counts, warning on base-moved, click opens the panel. */
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
			const color = summary.baseMoved ? "var(--dsw-alias-state-warn-primary)" : summary.awaiting > 0 ? "var(--dsw-alias-state-warn-primary)" : summary.mode ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-tertiary)";
			return jsx("button", {
				type: "button",
				style: chipStyle,
				onClick: () => props.openPanel?.(),
				title: summary.baseMoved ? t("pillBaseMoved") : t("pillTitle"),
				"data-orrery-worktree-pill": "",
				"data-orrery-worktree-state": summary.baseMoved ? "base-moved" : summary.mode ? "on" : "off",
				children: [dot(color), jsx("span", { children: parts.join(" · ") })]
			});
		}
		/** U4 — composer Worktree mode switch. */
		function WorktreeModeSwitch(props) {
			const available = useCommandPresence(props);
			const projection = useOwnedLanes(props);
			const [pending, setPending] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [localOn, setLocalOn] = react.useState(null);
			const on = projection ? projection.mode === true : localOn === true;
			if (available !== true) return null;
			const toggle = () => {
				if (pending) return;
				setPending(true);
				setError(null);
				Promise.resolve(props.runCommand?.(`${on ? "off" : "on"}`)).then(
					(outcome) => {
						setPending(false);
						if (outcome && outcome.kind !== "success") { setError(outcome.text ?? "worktree mode switch failed"); return; }
						if (!projection) setLocalOn(!on);
					},
					(reason) => { setPending(false); setError(reason instanceof Error ? reason.message : String(reason)); }
				);
			};
			return jsx("button", {
				type: "button", style: chipStyle, onClick: toggle, disabled: pending,
				"aria-pressed": on, title: error ?? props.t("modeTitle"),
				"data-orrery-worktree-mode": on ? "on" : "off",
				children: [dot(on ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-disabled, #999)"), jsx("span", { children: props.t("modeLabel") })]
			});
		}
		/** One lane card in the panel. */
		function LaneCard(props) {
			const lane = props.lane;
			const model = props.model;
			const t = props.t;
			const [open, setOpen] = react.useState(false);
			const [diff, setDiff] = react.useState(null);
			const [armed, setArmed] = react.useState(null);
			const [rows, setRows] = react.useState(null);
			const view = props.diffLines(diff);
			const action = (key) => lane.actions?.[key] ?? { enabled: false, reason: t("actionUnavailable") };
			const run = (key, option) => props.run(lane, key, option).then(() => { setArmed(null); setRows(null); });
			const busy = props.busy;
			const loadDiff = () => {
				if (diff !== null) { setDiff(null); return; }
				Promise.resolve(props.fetchDiff?.(lane.id)).then((text) => setDiff(typeof text === "string" ? text : ""), (reason) => setDiff(`diff unavailable: ${reason instanceof Error ? reason.message : String(reason)}`));
			};
			const stats = lane.stat ? `+${lane.stat.added} −${lane.stat.removed} · ${lane.stat.files} file(s)` : null;
			const counts = lane.ahead !== null ? t("aheadBehind").replace("{ahead}", String(lane.ahead)).replace("{behind}", String(lane.behind ?? 0)) : null;
			const removeOptions = [["worktree", t("cleanupWorktree")], ["all", t("cleanupAll")]];
			const children = [
				jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [
					badge(t(`state_${lane.state}`), model.colorOf(lane.state)),
					jsx("span", { style: { flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: lane.title }),
					lane.baseMoved ? badge(t("baseMoved"), "var(--dsw-alias-state-warn-primary)") : null,
					jsx("span", { style: { ...muted, ...mono }, children: lane.id })
				] }, "head"),
				jsxs("div", { style: { ...muted, ...mono, marginTop: "2px" }, children: [
					`${lane.branch} → ${lane.base ?? "?"}`, counts ? ` · ${counts}` : "", stats ? ` · ${stats}` : "", lane.updatedAt ? ` · ${props.ago(lane.updatedAt)}` : ""
				] }, "meta"),
				lane.reason ? jsx("div", { style: { ...muted, marginTop: "2px" }, "data-orrery-worktree-reason": "", children: lane.reason }, "reason") : null,
				lane.check?.enabled && lane.check.results.length ? jsx("div", { style: { marginTop: "4px" }, "data-orrery-worktree-checks": "", children: lane.check.results.map((entry) => jsxs("div", { style: { ...mono, ...muted }, children: [
					`${entry.exit === 0 ? "ok" : `exit ${entry.exit}`} · ${entry.name}${entry.ms ? ` (${Math.round(entry.ms / 1000)}s)` : ""}`
				] }, entry.name)) }, "checks") : null,
				lane.next ? jsx("div", { style: { marginTop: "4px", ...muted }, "data-orrery-worktree-next": "", children: t("nextLabel").replace("{next}", localNext(lane.next, t)) }, "next") : null,
				jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }, children: [
					btn("diff", diff === null ? t("viewDiff") : t("hideDiff"), loadDiff, linkStyle, false, null),
					action("check").enabled ? btn("check", t("recheck"), () => run("check"), chipStyle, busy, null) : null,
					action("setup").enabled ? btn("setup", t("retrySetup"), () => run("setup"), chipStyle, busy, null) : null,
					action("setup").enabled ? btn("setup-skip", t("skipSetup"), () => run("setup", "skip"), linkStyle, busy, null) : null,
					action("land").enabled ? (armed === "land"
						? btn("land-confirm", t("landConfirm"), () => run("land"), primaryButton, busy, null)
						: btn("land", t("land"), () => setArmed("land"), primaryButton, busy, action("land").reason ?? null)) : null,
					action("clean").enabled ? removeOptions.map(([option, label]) => btn(`clean-${option}`, label, () => run("clean", option), chipStyle, busy, null)) : null,
					action("abandon").enabled ? (armed === "abandon"
						? btn("abandon-confirm", t("abandonConfirm"), () => run("abandon"), dangerButton, busy, null)
						: btn("abandon", t("abandon"), () => setArmed("abandon"), linkStyle, busy, action("abandon").reason ?? null)) : null,
					action("copyPath").enabled ? btn("copy-path", t("copyPath"), () => props.copyPath?.(lane.path), linkStyle, false, null) : null,
					action("diff").enabled ? null : jsx("span", { style: muted, children: t("diffUnavailable") }, "diff-disabled"),
					!action("land").enabled && action("land").reason ? jsx("span", { style: { ...muted, alignSelf: "center" }, children: action("land").reason }, "land-reason") : null
				] }, "actions"),
				diff !== null ? jsx("pre", {
					"data-orrery-worktree-diff": "",
					style: { margin: "6px 0 0", padding: "6px 8px", maxHeight: "240px", overflow: "auto", background: "var(--dsw-alias-interactive-bg-solid)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", ...mono },
					children: view.map((line, index) => jsx("div", {
						style: { color: line.kind === "add" ? "var(--dsw-alias-state-success-primary, #2f855a)" : line.kind === "remove" ? "var(--dsw-alias-state-error-primary)" : line.kind === "meta" || line.kind === "hunk" ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-label-primary)" },
						children: line.text
					}, index))
				}, "diff") : null
			];
			return jsx("div", {
				"data-orrery-worktree-lane": lane.id,
				"data-orrery-worktree-state": lane.state,
				style: { borderTop: "1px solid var(--dsw-alias-border-l2)", padding: "8px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden" },
				children
			}, lane.id);
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
			const [rows, setRows] = react.useState([]);
			const view = state.view;
			const groups = model.groupLanes(view?.lanes ?? []);
			const visible = history ? [...groups.active, ...groups.history] : groups.active;
			const run = (lane, key, option) => {
				if (busy) return Promise.resolve();
				setBusy(true);
				setError(null);
				const line = model.commandFor(key, lane, option);
				return Promise.resolve(props.runWorktree(line)).then(
					(outcome) => {
						setBusy(false);
						if (outcome && outcome.kind !== "success") { setError(outcome.text ?? "action failed"); return; }
						reload();
					},
					(reason) => { setBusy(false); setError(reason instanceof Error ? reason.message : String(reason)); }
				);
			};
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
			const rowEditor = (row, index) => jsxs("div", { style: { display: "flex", gap: "6px", marginTop: "4px" }, children: [
				jsx("input", { "data-orrery-worktree-config-name": "", value: row.name, placeholder: t("configName"), onChange: (event) => setRows((current) => current.map((entry, at) => (at === index ? { ...entry, name: event.target.value } : entry))), style: { width: "30%" } }),
				jsx("input", { "data-orrery-worktree-config-run": "", value: row.run, placeholder: t("configRun"), onChange: (event) => setRows((current) => current.map((entry, at) => (at === index ? { ...entry, run: event.target.value } : entry))), style: { flex: 1 } }),
				jsx("button", { type: "button", style: linkStyle, onClick: () => setRows((current) => current.filter((entry, at) => at !== index)), children: t("configRemove") })
			] }, index);
			const children = [];
			if (!view) children.push(jsx("div", { style: muted, children: state.error ? t("loadFailed") : t("loading") }, "loading"));
			else if (view.available === false) children.push(jsx("div", { "data-orrery-worktree-unavailable": "", style: { ...muted, marginTop: "4px" }, children: view.enabled === false ? t("disabled") : (view.error?.message ?? t("unavailable")) }, "unavailable"));
			else {
				children.push(jsxs("div", { style: { ...muted, ...mono }, "data-orrery-worktree-repo": "", children: [
					`${view.repo?.branch ?? "?"} · ${view.repo?.root ?? "?"}`, view.repo?.gitVersion ? ` · git ${view.repo.gitVersion}` : "",
					` · ${view.repo?.verification?.enabled ? t("verificationOn").replace("{n}", String(view.repo.verification.commands.length || 0)) : t("verificationOff")}`,
					view.repo?.exclude ? ` · ${t("excludeOk")}` : ` · ${t("excludeMissing")}`
				] }, "repo"));
				children.push(jsxs("div", { style: { display: "flex", gap: "8px", marginTop: "6px" }, children: [
					jsx("button", { type: "button", style: linkStyle, onClick: reload, "data-orrery-worktree-action": "refresh", children: t("refresh") }),
					jsx("button", { type: "button", style: linkStyle, onClick: openConfig, "data-orrery-worktree-action": "configure", children: t("configure") }),
					groups.history.length ? jsx("button", { type: "button", style: linkStyle, onClick: () => setHistory(!history), children: history ? t("hideHistory") : t("showHistory").replace("{n}", String(groups.history.length)) }) : null,
					jsx("span", { style: { flex: 1 } }),
					view.mode ? jsx("span", { style: { ...muted }, children: t("modeOn") }) : null
				] }, "toolbar"));
				if (init) {
					children.push(jsxs("div", { "data-orrery-worktree-config": "", style: { marginTop: "8px", borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: "8px" }, children: [
						jsx("div", { style: muted, children: init.file ?? "" }),
						init.error ? jsx("div", { style: errorStyle, children: init.error }) : null,
						jsx("input", { "data-orrery-worktree-config-setup": "", value: setup, placeholder: t("configSetup"), onChange: (event) => setSetup(event.target.value), style: { width: "100%", marginTop: "6px" } }),
						rows.map(rowEditor),
						jsxs("div", { style: { display: "flex", gap: "8px", marginTop: "6px" }, children: [
							jsx("button", { type: "button", style: linkStyle, onClick: () => setRows((current) => [...current, { name: "", run: "" }]), children: t("configAdd") }),
							jsx("span", { style: { flex: 1 } }),
							jsx("button", { type: "button", style: primaryButton, disabled: busy, onClick: saveConfig, children: t("configSave") }),
							jsx("button", { type: "button", style: linkStyle, onClick: () => setInit(null), children: t("cancel") })
						] }, "config-actions"),
						jsx("div", { style: { ...muted, marginTop: "4px" }, children: t("configHint") })
					] }, "config"));
				}
				if (visible.length === 0) children.push(jsx("div", { style: { ...muted, marginTop: "8px" }, "data-orrery-worktree-empty": "", children: t("empty") }, "empty"));
				for (const lane of visible) children.push(jsx(LaneCard, { lane, model, t, busy, run, fetchDiff: props.fetchDiff, diffLines: props.diffLines, ago: props.ago, copyPath }, lane.id));
				if (view.unmanaged.length) children.push(jsx("div", { style: { ...muted, marginTop: "8px" }, "data-orrery-worktree-unmanaged": "", children: t("unmanaged").replace("{n}", String(view.unmanaged.length)) }, "unmanaged"));
			}
			if (error) children.push(jsx("div", { style: errorStyle, "data-orrery-worktree-error": "", children: error }, "error"));
			if (state.error && view) children.push(jsx("div", { style: errorStyle, children: t("staleData") }, "stale"));
			return jsx("div", { "data-orrery-worktree-panel": "", style: { padding: "8px 2px", minWidth: 0, maxWidth: "100%", overflowX: "hidden" }, children }, NS_LABEL);
		}
		/** U6 — conversation tool cards for the five lane tools. */
		function WorktreeToolRow(props) {
			const model = props.model;
			const meta = model.narrowToolMeta(props.block?.meta);
			const t = props.t;
			const [open, setOpen] = react.useState(false);
			if (!meta) return jsx(WorktreeFlatFallback, props);
			const title = t(`tool_${meta.tool}`);
			const state = meta.state;
			// Every visible line is built from structured meta in the GUI
			// language; the host's English summary (written for the model) is
			// only the hover title.
			const lines = [];
			lines.push(meta.from && meta.from !== state ? `${t(`state_${meta.from}`)} → ${t(`state_${state}`)}` : t(`state_${state}`));
			if (meta.conflicts.length) lines.push(`${t("conflicts")}: ${meta.conflicts.join(", ")}`);
			if (meta.check.length) lines.push(meta.check.map((entry) => `${entry.exit === 0 ? "✓" : `✗ ${entry.exit}`} ${entry.name}`).join(" · "));
			if (meta.merge?.commit) lines.push(`${t("mergeCommit")}: ${String(meta.merge.commit).slice(0, 10)}${meta.merge.stat ? ` · +${meta.merge.stat.added} −${meta.merge.stat.removed}` : ""}`);
			if (meta.cleanup?.state) lines.push(`${t("cleanup")}: ${t(`state_${meta.cleanup.state}`)}`);
			if (meta.cleanup?.error) lines.push(`${t("cleanup")}: ${meta.cleanup.error}`);
			if (meta.next) lines.push(t("nextLabel").replace("{next}", localNext(meta.next, t)));
			const diff = open ? model.diffLines(meta.diff) : [];
			return jsxs("div", {
				"data-tool": meta.tool,
				"data-orrery-worktree-tool": meta.tool,
				"data-orrery-worktree-state": state,
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 4px", cursor: meta.diff ? "pointer" : "default", userSelect: "none" },
						role: meta.diff ? "button" : undefined,
						tabIndex: meta.diff ? 0 : undefined,
						"aria-expanded": meta.diff ? open : undefined,
						onClick: meta.diff ? () => setOpen(!open) : undefined,
						children: [
							dot(model.colorOf(state)),
							jsx("span", { style: { fontSize: "13px", fontWeight: 500 }, children: title }),
							meta.lane ? jsx("button", {
								type: "button", style: { ...linkStyle, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: meta.lane,
								onClick: (event) => { event.stopPropagation(); if (typeof props.openFile === "function" && meta.lane) props.openFile(meta.lane); },
								children: meta.lane
							}) : null,
							jsx("span", { style: { flex: 1 } }),
							jsx("span", { style: { ...muted, ...mono }, children: t(`state_${state}`) })
						]
					}),
					jsx("div", { title: meta.summary || undefined, style: { ...muted, padding: "0 4px 6px", whiteSpace: "pre-wrap", wordBreak: "break-word" }, children: lines.filter(Boolean).join("\n") }),
					open && diff.length ? jsx("pre", {
						"data-orrery-worktree-tool-diff": "",
						style: { margin: "0 4px 8px", padding: "8px 10px", maxHeight: "320px", overflow: "auto", background: "var(--dsw-alias-interactive-bg-solid)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", ...mono },
						children: diff.map((line, index) => jsx("div", {
							style: { color: line.kind === "add" ? "var(--dsw-alias-state-success-primary, #2f855a)" : line.kind === "remove" ? "var(--dsw-alias-state-error-primary)" : line.kind === "meta" || line.kind === "hunk" ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-label-primary)" },
							children: line.text
						}, index))
					}, "diff") : null
				]
			});
		}
		/** Fallback body for a lane tool call without persisted metadata. */
		function WorktreeFlatFallback(props) {
			const block = props.block;
			const argsRaw = typeof block?.argsRaw === "string" ? block.argsRaw : typeof block?.call?.argsRaw === "string" ? block.call.argsRaw : null;
			const output = Array.isArray(block?.content) ? block.content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).filter((text) => text !== "").join("\n") : "";
			const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", padding: "4px 4px" };
			const preStyle = { margin: 0, padding: "8px 10px", fontSize: "12px", lineHeight: "16px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "240px", overflow: "auto", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)" };
			return jsxs("div", {
				"data-tool": typeof block?.name === "string" ? block.name : "worktree",
				"data-orrery-worktree-flat": "",
				children: [
					argsRaw !== null ? jsxs("div", { children: [jsx("div", { style: hintStyle, children: props.t("flatInput") }), jsx("pre", { style: preStyle, children: argsRaw })] }) : null,
					output !== "" ? jsxs("div", { children: [jsx("div", { style: hintStyle, children: props.t("flatOutput") }), jsx("pre", { style: preStyle, children: output })] }) : null
				]
			});
		}
		exports.WorktreeRowMarker = WorktreeRowMarker;
		exports.WorktreeStatusPill = WorktreeStatusPill;
		exports.WorktreeModeSwitch = WorktreeModeSwitch;
		exports.LanesPanel = LanesPanel;
		exports.LaneCard = LaneCard;
		exports.WorktreeToolRow = WorktreeToolRow;
		exports.WorktreeFlatFallback = WorktreeFlatFallback;
		return module.exports;
	}
});
