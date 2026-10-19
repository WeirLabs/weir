window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.file-lease-badge.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- File-lease ownership Badge (conversation composer bar) ----
		// The ONLY user-visible ownership surface of the edit-lock rebuild
		// (design D13). It is read-only by construction, not by convention:
		//
		//   - the badge has exactly three states — not holding, holding N,
		//     degraded — and each one resolves by itself (turn end, expiry,
		//     negotiation). None of them asks the user for anything;
		//   - the panel lists claims and holders and the arbiter's health, and
		//     deliberately contains NO button, NO command input, NO confirmation
		//     step and no clickable row. The one interaction in this chunk is
		//     expand/collapse; every ownership change belongs to the model's
		//     tools. A control here would reintroduce the "some state needs a
		//     human" that the rebuild exists to delete;
		//   - it never writes to the conversation and never notifies. The read
		//     goes to the one read-only endpoint through the composition root's
		//     `fetchView` prop; nothing else is called.
		//
		// Everything shown arrives pre-shaped by the server-side view
		// (`src/file-lease/view.js`): short path names, when a hold started, how
		// long a retention has left. This chunk renders that and derives only the
		// presentation state — it never parses prose and never invents a fact.
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
		const sectionStyle = { marginTop: "8px", fontWeight: 600 };
		const rowStyle = { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "8px", padding: "3px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" };
		const nameStyle = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)" };
		const dot = (state) => react_jsx_runtime.jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: dotColor[state], flex: "none" } });
		/** Clock time in the user's locale; a bad instant renders nothing, not "Invalid Date". */
		function clock(at) {
			try {
				return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			} catch {
				return "";
			}
		}
		/**
		 * The badge state of a view. Anything unreadable is `degraded`: an
		 * unreadable ownership surface must never be presented as "not holding",
		 * which reads like a fact the panel cannot actually vouch for.
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
			// Before the first read settles the entry shows the not-holding state:
			// ownership does not survive the process (D10), so "nothing held" is
			// the honest answer for a session that has not been read yet.
			const state = view === null ? STATE_NONE : stateOf(view);
			const mine = rowsOf(view, "mine");
			const others = rowsOf(view, "others");
			const summary = state === STATE_HOLDING
				? t("fileLeaseState_holding").replace("{n}", String(mine.length))
				: state === STATE_DEGRADED ? t("fileLeaseState_degraded") : t("fileLeaseState_none");
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
				if (typeof entry.heldSince === "number") {
					trailing.push(react_jsx_runtime.jsx("span", { style: mutedStyle, "data-weir-file-lease-since": entry.path, children: t("fileLeaseSince").replace("{time}", clock(entry.heldSince)) }, "since"));
				}
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
			const empty = (key) => react_jsx_runtime.jsx("div", { style: mutedStyle, "data-weir-file-lease-empty": key, children: key === "mine" ? t("fileLeaseMineEmpty") : t("fileLeaseOthersEmpty") }, `empty:${key}`);
			const panelChildren = [
				react_jsx_runtime.jsx("div", {
					style: { fontWeight: 600 },
					"data-weir-file-lease-arbiter": arbiter,
					children: t(`fileLeaseArbiter_${arbiter}`)
				}, "arbiter"),
				react_jsx_runtime.jsx("div", { style: sectionStyle, children: t("fileLeaseMine") }, "mine-head"),
				mineRows.length > 0 ? react_jsx_runtime.jsx("div", { "data-weir-file-lease-section": "mine", children: mineRows }, "mine") : empty("mine"),
				react_jsx_runtime.jsx("div", { style: sectionStyle, children: t("fileLeaseOthers") }, "others-head"),
				otherRows.length > 0 ? react_jsx_runtime.jsx("div", { "data-weir-file-lease-section": "others", children: otherRows }, "others") : empty("others"),
				react_jsx_runtime.jsx("div", { style: { ...mutedStyle, marginTop: "10px" }, "data-weir-file-lease-hint": "", children: t("fileLeaseReadOnlyHint") }, "hint")
			];
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
						title: `${t("fileLeaseTitle")}: ${summary}`,
						children: [
							dot(state),
							react_jsx_runtime.jsx("span", { children: t("fileLeaseLabel") }),
							react_jsx_runtime.jsx("span", { "data-weir-file-lease-summary": "", children: summary })
						]
					}),
					open ? react_jsx_runtime.jsx("div", {
						role: "dialog",
						"aria-label": t("fileLeasePanelTitle"),
						style: panelStyle,
						"data-weir-file-lease-panel": "",
						onKeyDown: (event) => { if (event?.key === "Escape") setOpen(false); },
						children: panelChildren
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
		const dictionaries = {
			en: {
				fileLeaseLabel: "Edit Lock",
				fileLeaseTitle: "Files this session holds (read-only)",
				fileLeasePanelTitle: "File ownership (read-only)",
				fileLeaseState_none: "not holding",
				fileLeaseState_holding: "holding {n}",
				fileLeaseState_degraded: "degraded",
				fileLeaseMine: "Held by this session",
				fileLeaseOthers: "Held by other sessions",
				fileLeaseMineEmpty: "This session holds no files.",
				fileLeaseOthersEmpty: "No other session holds a file here.",
				fileLeaseArbiter_ok: "Arbiter: ok",
				fileLeaseArbiter_degraded: "Arbiter: degraded — edits proceed without mutual exclusion",
				fileLeaseArbiter_unavailable: "Arbiter: unavailable — edits proceed without mutual exclusion",
				fileLeaseSince: "since {time}",
				fileLeaseRetainedFor: "retained for {n} more min",
				fileLeaseReadOnlyHint: "Read-only: ownership changes only through the assistant's tools. Nothing here is an action."
			},
			zh: {
				fileLeaseLabel: "编辑锁",
				fileLeaseTitle: "本会话持有的文件（只读）",
				fileLeasePanelTitle: "文件归属（只读）",
				fileLeaseState_none: "未持有",
				fileLeaseState_holding: "持有 {n}",
				fileLeaseState_degraded: "降级",
				fileLeaseMine: "本会话持有",
				fileLeaseOthers: "其他会话持有",
				fileLeaseMineEmpty: "本会话未持有任何文件。",
				fileLeaseOthersEmpty: "此目录下没有其他会话持有文件。",
				fileLeaseArbiter_ok: "仲裁器：正常",
				fileLeaseArbiter_degraded: "仲裁器：降级——编辑仍可进行，但暂时没有互斥",
				fileLeaseArbiter_unavailable: "仲裁器：不可用——编辑仍可进行，没有互斥",
				fileLeaseSince: "自 {time}",
				fileLeaseRetainedFor: "保留剩余 {n} 分钟",
				fileLeaseReadOnlyHint: "只读面板：所有权只经助手的工具变更，这里没有任何动作。"
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
