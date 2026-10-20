window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.file-lease-badge.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Edit-lock Badge (conversation composer bar) ----
		// The ONLY user-visible surface of the edit-lock mechanism (design D13).
		// It is read-only by construction, not by convention:
		//
		//   - the badge has exactly three states — idle, holding N, unprotected
		//     — and each one resolves by itself (turn end, expiry, negotiation).
		//     None of them asks the user for anything. The badge names the
		//     surface, and appends a fact only when there is one: how many files
		//     this session holds, or that protection is off. An idle badge is
		//     just its name — never a status word standing in for "nothing";
		//   - the panel speaks only when there is something to say. With no
		//     claim and no degraded protection it is ONE line; each group's
		//     heading appears only above a non-empty list, and the protection
		//     notice only when protection is degraded. There are no headings over
		//     empty lists and no disclaimer about what cannot be clicked: a
		//     surface with no controls needs no sentence saying so;
		//   - it contains NO button besides its own toggle, NO command input, NO
		//     confirmation step and no clickable row. Expand/collapse is the one
		//     interaction in this chunk; every ownership change belongs to the
		//     model's tools. A control here would reintroduce the "some state
		//     needs a human" that the rebuild exists to delete;
		//   - it never writes to the conversation and never notifies. The read
		//     goes to the one read-only endpoint through the composition root's
		//     `fetchView` prop; nothing else is called.
		//
		// Everything shown arrives pre-shaped by the server-side view
		// (`src/file-lease/view.js`): short path names, holder labels, and how
		// long a retention has left. This chunk renders that and derives only
		// the presentation state — it never parses prose and never invents a
		// fact.
		const STATE_NONE = "none";
		const STATE_HOLDING = "holding";
		const STATE_DEGRADED = "degraded";
		/** Status-dot colour per state; only theme-defined tokens. */
		const dotColor = {
			none: "var(--dsw-alias-label-tertiary)",
			holding: "var(--dsw-alias-state-business-primary)",
			degraded: "var(--dsw-alias-state-warn-primary)"
		};
		const rootStyle = { position: "relative", display: "inline-flex" };
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
		// Popover surface: the theme's documented overlay token (light and dark).
		const panelStyle = {
			position: "absolute",
			bottom: "calc(100% + 6px)",
			right: 0,
			zIndex: 20,
			width: "min(420px, 80vw)",
			maxHeight: "50vh",
			overflow: "auto",
			background: "var(--dsw-alias-bg-overlay)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-md, 8px)",
			boxShadow: "0 6px 24px var(--dsw-alias-border-l2)",
			padding: "10px 12px",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "12px",
			lineHeight: "18px"
		};
		const mutedStyle = { color: "var(--dsw-alias-label-secondary)" };
		/** A group heading: bold, and spaced only when something precedes it. */
		const headStyle = { fontWeight: 600 };
		// The degraded notice: amber (the same token the dot uses) at the panel's
		// own weight — a status line, not an alarm.
		const noticeStyle = { color: "var(--dsw-alias-state-warn-primary)" };
		const rowStyle = { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "8px", padding: "3px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" };
		const nameStyle = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)" };
		const dot = (state) => react_jsx_runtime.jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: dotColor[state], flex: "none" } });
		/**
		 * The badge state of a view. Anything unreadable is `degraded`: an
		 * unreadable surface must never be presented as "nothing held", which
		 * reads like a fact the panel cannot actually vouch for.
		 * @param {any} view the server-shaped view
		 * @returns {"none" | "holding" | "degraded"}
		 */
		function stateOf(view) {
			if (!view || typeof view !== "object") return STATE_DEGRADED;
			if (view.arbiter !== "ok") return STATE_DEGRADED;
			const mine = Array.isArray(view.mine) ? view.mine : [];
			return mine.length > 0 ? STATE_HOLDING : STATE_NONE;
		}
		/** The claims of one section, tolerating a partial/degraded payload. */
		function rowsOf(view, key) {
			const rows = view && Array.isArray(view[key]) ? view[key] : [];
			return rows.filter((row) => row && typeof row === "object" && typeof row.path === "string" && row.path !== "");
		}
		/** Remaining retention in whole minutes, or null when there is none. */
		function retainedMinutes(holdUntil, at) {
			if (typeof holdUntil !== "number" || !Number.isFinite(holdUntil)) return null;
			const minutes = Math.max(0, Math.ceil((holdUntil - at) / 60000));
			return minutes > 0 ? minutes : null;
		}
		function FileLeaseBadge(props) {
			const t = props.t;
			const sessionId = props.sessionId;
			const [open, setOpen] = react.useState(false);
			// `any`: the payload is the server-shaped view, narrowed on read.
			const [view, setView] = react.useState(/** @type {any} */ (null));
			// The one read: on mount so the badge is right before it is ever
			// expanded, and again each time the panel opens (a snapshot, never a
			// poll — ownership has no state to keep in sync).
			const read = () => {
				if (typeof props.fetchView !== "function") {
					setView({ schemaVersion: 1, arbiter: "unavailable", mine: [], others: [] });
					return Promise.resolve();
				}
				return Promise.resolve(props.fetchView()).then(
					(next) => { if (next && typeof next === "object") setView(next); },
					// A failed read is the degraded state: the panel cannot vouch
					// for anything, so it says so instead of showing an empty list.
					() => { setView({ schemaVersion: 1, arbiter: "unavailable", mine: [], others: [] }); }
				);
			};
			react.useEffect(() => {
				if (!sessionId) {
					setView(null);
					setOpen(false);
					return undefined;
				}
				read();
				return undefined;
			}, [sessionId]);
			// Close on Escape and on any pointerdown outside this entry's wrapper:
			// the same dismissal the other composer surfaces use, and the only way
			// out of the panel that needs no action model behind it.
			react.useEffect(() => {
				if (!open || typeof document === "undefined") return undefined;
				const onPointerDown = (event) => {
					if (event && typeof event.target?.closest === "function" && event.target.closest("[data-weir-file-lease-root]")) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event?.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			if (!sessionId) return null;
			// Before the first read settles the entry shows the idle state:
			// ownership does not survive the process (D10), so "nothing held" is
			// the honest answer for a session that has not been read yet.
			const state = view === null ? STATE_NONE : stateOf(view);
			const mine = rowsOf(view, "mine");
			const others = rowsOf(view, "others");
			// The badge suffix: a fact when there is one, nothing when there is
			// not. An idle badge never says "not holding" — it simply is idle.
			const suffix = state === STATE_HOLDING
				? t("fileLeaseState_holding").replace("{n}", String(mine.length))
				: state === STATE_DEGRADED ? t("fileLeaseState_degraded") : "";
			const arbiter = view && typeof view.arbiter === "string" ? view.arbiter : "unavailable";
			const at = Date.now();
			const toggle = () => {
				const next = !open;
				setOpen(next);
				if (next) read();
			};
			const row = (entry, key, trailing) => react_jsx_runtime.jsxs("div", {
				style: rowStyle,
				"data-weir-file-lease-row": key,
				children: [
					react_jsx_runtime.jsx("span", { style: nameStyle, title: entry.path, children: entry.path }),
					...trailing
				]
			}, `${key}:${entry.path}`);
			const mineRows = mine.map((entry) => {
				const trailing = [];
				const minutes = retainedMinutes(entry.holdUntil, at);
				if (minutes !== null) {
					trailing.push(react_jsx_runtime.jsx("span", { style: mutedStyle, "data-weir-file-lease-retained": entry.path, children: t("fileLeaseRetainedFor").replace("{n}", String(minutes)) }, "retained"));
				}
				return row(entry, "mine", trailing);
			});
			const otherRows = others.map((entry) => {
				const label = entry.holder && typeof entry.holder.label === "string" ? entry.holder.label : "";
				return row(entry, "others", [react_jsx_runtime.jsx("span", { style: mutedStyle, "data-weir-file-lease-holder": entry.path, children: label }, "holder")]);
			});
			// The panel is assembled as blocks so that spacing, and the existence
			// of a heading, both follow from what is actually there.
			const blocks = [];
			if (state === STATE_DEGRADED) {
				blocks.push(react_jsx_runtime.jsx("div", {
					style: noticeStyle,
					"data-weir-file-lease-arbiter": arbiter,
					children: t("fileLeaseDegradedHint")
				}, "notice"));
			}
			const head = (key, text) => react_jsx_runtime.jsx("div", {
				style: blocks.length === 0 ? headStyle : { ...headStyle, marginTop: "10px" },
				children: text
			}, `${key}-head`);
			if (mineRows.length > 0) {
				blocks.push(head("mine", t("fileLeaseMine")));
				blocks.push(react_jsx_runtime.jsx("div", { "data-weir-file-lease-section": "mine", children: mineRows }, "mine"));
			}
			if (otherRows.length > 0) {
				blocks.push(head("others", t("fileLeaseOthers")));
				blocks.push(react_jsx_runtime.jsx("div", { "data-weir-file-lease-section": "others", children: otherRows }, "others"));
			}
			// Nothing held anywhere: one plain line, and (when protection is
			// degraded) one notice above it — never a section skeleton.
			if (mineRows.length === 0 && otherRows.length === 0) {
				blocks.push(react_jsx_runtime.jsx("div", {
					style: blocks.length === 0 ? mutedStyle : { ...mutedStyle, marginTop: "6px" },
					"data-weir-file-lease-empty": "",
					children: t("fileLeaseEmpty")
				}, "empty"));
			}
			return react_jsx_runtime.jsxs("span", {
				style: rootStyle,
				"data-weir-file-lease-root": "",
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						style: badgeStyle,
						onClick: toggle,
						"aria-expanded": open,
						"data-weir-file-lease": "",
						"data-weir-file-lease-state": state,
						title: t("fileLeaseTitle"),
						children: [
							dot(state),
							react_jsx_runtime.jsx("span", { children: t("fileLeaseLabel") }),
							suffix === "" ? null : react_jsx_runtime.jsx("span", { "data-weir-file-lease-summary": "", children: suffix })
						]
					}),
					open ? react_jsx_runtime.jsx("div", {
						role: "dialog",
						"aria-label": t("fileLeasePanelTitle"),
						style: panelStyle,
						"data-weir-file-lease-panel": "",
						onKeyDown: (event) => { if (event?.key === "Escape") setOpen(false); },
						children: blocks
					}) : null
				]
			});
		}
		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under
		// "settings.weir.file-lease" inside a ctx.effect when this chunk arrives
		// (lib/client.js registerChunkDictionaries). Pinned by test/client.test.js's
		// dictionary union pin.
		//
		// Copy rules: plain user-facing words only — no internal vocabulary, no
		// "read-only" disclaimers, no status word for the idle state. Badge
		// suffixes carry their own leading separator so the badge reads as one
		// string in both locales.
		const dictionaries = {
			en: {
				fileLeaseLabel: "Edit Lock",
				fileLeaseTitle: "Files in use",
				fileLeasePanelTitle: "Files in use",
				fileLeaseState_holding: " · {n}",
				fileLeaseState_degraded: " · unprotected",
				fileLeaseMine: "You are editing",
				fileLeaseOthers: "Another session is editing",
				fileLeaseEmpty: "No files in use.",
				fileLeaseDegradedHint: "Protection is temporarily unavailable; editing continues.",
				fileLeaseRetainedFor: "{n} min left"
			},
			zh: {
				fileLeaseLabel: "编辑锁",
				fileLeaseTitle: "文件占用",
				fileLeasePanelTitle: "文件占用",
				fileLeaseState_holding: " · {n}",
				fileLeaseState_degraded: " · 未加锁",
				fileLeaseMine: "你正在编辑",
				fileLeaseOthers: "其他会话正在编辑",
				fileLeaseEmpty: "暂无文件占用。",
				fileLeaseDegradedHint: "保护暂不可用，编辑不受影响。",
				fileLeaseRetainedFor: "保留 {n} 分钟"
			}
		};

		exports.dictionaries = dictionaries;
		exports.FileLeaseBadge = FileLeaseBadge;
		exports.stateOf = stateOf;
		exports.rowsOf = rowsOf;
		exports.retainedMinutes = retainedMinutes;
		return module.exports;
	}
});
