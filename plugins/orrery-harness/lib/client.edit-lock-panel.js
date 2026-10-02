window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.edit-lock-panel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		// ---- Per-session Edit Lock entry (conversation composer bar) ----
		// Visible only while the `edit-lock` command exists (feature enabled).
		// Everything the panel SHOWS comes from a structured, read-only view; the
		// panel never parses command text. Everything it DOES is one explicit
		// /edit-lock command, so each action stays on the conversation record.
		// Nothing polls: the view is read when the entry mounts, when the panel
		// opens, and after each action.
		const STATES = ["unavailable", "stopped", "attention", "confirm", "holding", "editing", "idle"];
		/** Status-dot colour per state; only theme-defined tokens. */
		const dotColor = {
			idle: "var(--dsw-alias-label-tertiary)",
			editing: "var(--dsw-alias-state-business-primary)",
			holding: "var(--dsw-alias-state-business-primary)",
			confirm: "var(--dsw-alias-state-warn-primary)",
			stopped: "var(--dsw-alias-state-warn-primary)",
			attention: "var(--dsw-alias-state-error-primary)",
			unavailable: "var(--dsw-alias-label-tertiary)"
		};
		/** Normalise a view from the host; an unknown state renders as unavailable. */
		function stateOf(view) {
			return view && STATES.includes(view.state) ? view.state : "unavailable";
		}
		const buttonStyle = {
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
		const primaryStyle = { ...buttonStyle, color: "var(--dsw-alias-label-primary)", borderColor: "var(--dsw-alias-label-secondary)", fontWeight: 600 };
		const dangerStyle = { ...buttonStyle, color: "var(--dsw-alias-state-error-primary)", borderColor: "var(--dsw-alias-state-error-primary)" };
		const linkStyle = { background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline" };
		// Popover surface: the theme's documented overlay token (light and dark).
		const panelStyle = {
			position: "absolute",
			bottom: "calc(100% + 6px)",
			right: 0,
			zIndex: 20,
			width: "min(440px, 80vw)",
			maxHeight: "50vh",
			overflow: "auto",
			background: "var(--dsw-alias-bg-overlay)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-md, 8px)",
			boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
			padding: "10px 12px",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "12px",
			lineHeight: "18px"
		};
		const mutedStyle = { color: "var(--dsw-alias-label-secondary)" };
		const errorStyle = { color: "var(--dsw-alias-state-error-primary)", marginTop: "6px" };
		const rowStyle = { display: "flex", alignItems: "center", gap: "8px", padding: "4px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" };
		const nameStyle = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)" };
		const dot = (state) => jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: dotColor[state], flex: "none" } });
		/** Clock time for a reservation expiry, in the user's locale. */
		function clock(at) {
			try { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
		}
		/** The command a row action runs. Paths are the canonical ones from the view. */
		function rowCommand(file) {
			if (file.action === "release") return `release ${file.detail.path}`;
			if (file.action === "confirm") return `confirm ${file.detail.path}`;
			if (file.action === "unlock") return `unlock ${file.detail.path} ${file.detail.generation}`;
			return null;
		}
		/** The one primary action of a state, or null when nothing is needed. */
		function primaryOf(state, view) {
			// Continue editing is one human action: restore authority, then confirm the
			// retained files (each through the ordinary per-file check).
			// confirm --all only when something waits, so no empty "Confirmed 0 of 0" is recorded.
			if (state === "stopped") return { verbs: view.files.some((file) => file.mine && file.status === "user-interrupted") ? ["resume", "confirm --all"] : ["resume"], label: "editLockResume" };
			if (state === "confirm") return { verb: "confirm --all", label: "editLockConfirmAll" };
			if (state === "holding" && view.ownCount > 0) return { verbs: view.files.filter((file) => file.mine && file.action === "release").map(rowCommand), label: "editLockReleaseAll" };
			return null;
		}
		function EditLockPanel(props) {
			const t = props.t;
			const sessionId = props.sessionId;
			const [available, setAvailable] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			const [view, setView] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [pending, setPending] = react.useState(false);
			const [armedRevoke, setArmedRevoke] = react.useState(false);
			// Unlocking takes another session's file away, so like revoke it needs a
			// second click; holds the path of the armed row.
			const [armedUnlock, setArmedUnlock] = react.useState(null);
			const [details, setDetails] = react.useState(false);
			const refresh = () => Promise.resolve(props.fetchView?.()).then(
				(next) => { if (next) setView(next); },
				(reason) => setError(reason instanceof Error ? reason.message : String(reason))
			);
			react.useEffect(() => {
				if (!sessionId) {
					setAvailable(false);
					return undefined;
				}
				let alive = true;
				Promise.resolve(props.commandsList(sessionId)).then(
					(list) => {
						if (!alive) return;
						const present = Array.isArray(list) && list.some((entry) => entry?.name === "edit-lock");
						setAvailable(present);
						// One read so the dot is right before the panel is ever opened.
						if (present) refresh();
					},
					() => { if (alive) setAvailable(false); }
				);
				return () => { alive = false; };
			}, [sessionId]);
			if (available !== true) return null;
			const state = stateOf(view);
			/** Run commands in order, stop at the first failure, then re-read the view. */
			const run = (verbs) => {
				if (pending) return;
				setPending(true);
				setError(null);
				setArmedRevoke(false);
				setArmedUnlock(null);
				const list = [].concat(verbs).filter(Boolean);
				(async () => {
					for (const verb of list) {
						const outcome = await Promise.resolve(props.runEditLock(verb));
						if (outcome?.kind !== "success") throw new Error(outcome?.text ?? "edit-lock failed");
					}
				})().then(
					() => refresh().finally(() => setPending(false)),
					(reason) => {
						setError(reason instanceof Error ? reason.message : String(reason));
						refresh().finally(() => setPending(false));
					}
				);
			};
			const toggle = () => {
				const next = !open;
				setOpen(next);
				setArmedRevoke(false);
				if (next) refresh();
			};
			const action = (key, label, onClick, style = buttonStyle) => jsx("button", {
				type: "button", style, disabled: pending, onClick,
				"data-orrery-edit-lock-action": key, children: label
			}, key);
			const summary = (() => {
				if (!view) return t("editLockLoading");
				if (state === "unavailable" && view.reason) return t("editLockState_failed");
				const base = t(`editLockState_${state}`);
				if (state === "holding" && view.hold) return `${base} ${t("editLockHoldUntil").replace("{time}", clock(view.hold.until))}`;
				if (state === "confirm") return `${base} (${view.pendingCount})`;
				return base;
			})();
			const primary = view ? primaryOf(state, view) : null;
			const files = view?.files ?? [];
			const canRevoke = state !== "stopped" && state !== "unavailable";
			const children = [
				jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [
					dot(state),
					jsx("span", { style: { flex: 1, fontWeight: 600 }, "data-orrery-edit-lock-summary": "", children: summary }),
					jsx("button", { type: "button", style: linkStyle, disabled: pending, onClick: () => refresh(), "data-orrery-edit-lock-action": "refresh", title: t("editLockRefresh"), children: "\u21bb" })
				] }, "head"),
				view?.reason ? jsx("div", { style: { ...errorStyle, wordBreak: "break-word" }, "data-orrery-edit-lock-reason": "", children: view.reason }, "reason") : null,
				view?.recovery ? jsx("div", { style: { ...mutedStyle, marginTop: "4px" }, children: t("editLockRecovery").replace("{n}", String(view.recovery.attempts)) }, "recovery") : null,
				primary ? jsx("div", { style: { marginTop: "8px" }, children: action("primary", t(primary.label), () => run(primary.verbs ?? primary.verb), primaryStyle) }, "primary") : null,
				files.length ? jsx("div", { style: { marginTop: "8px" }, "data-orrery-edit-lock-files": "", children: files.map((file) => jsxs("div", {
					style: rowStyle,
					"data-orrery-edit-lock-file": file.detail.path,
					children: [
						jsx("span", { style: nameStyle, title: file.detail.path, children: file.name }),
						jsx("span", { style: mutedStyle, children: file.mine ? t(`editLockStatus_${file.status}`) : t("editLockOwnerOther") }),
						!rowCommand(file) ? null
							: file.action === "unlock" && armedUnlock !== file.detail.path
								? action(`arm-unlock:${file.detail.path}`, t("editLockRow_unlock"), () => setArmedUnlock(file.detail.path))
								: action(`${file.action}:${file.detail.path}`, t(file.action === "unlock" ? "editLockRow_unlockConfirm" : `editLockRow_${file.action}`), () => run(rowCommand(file)), file.action === "unlock" ? dangerStyle : buttonStyle)
					]
				}, file.detail.path)) }, "files") : null,
				error ? jsx("div", { style: errorStyle, "data-orrery-edit-lock-error": "", children: error }, "error") : null,
				jsxs("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "10px" }, children: [
					canRevoke ? (armedRevoke
						? action("stop", t("editLockRevokeConfirm"), () => run("stop"), dangerStyle)
						: jsx("button", { type: "button", style: linkStyle, disabled: pending, onClick: () => setArmedRevoke(true), "data-orrery-edit-lock-action": "arm-stop", children: t("editLockStop") })) : null,
					jsx("span", { style: { flex: 1 } }),
					view?.technical ? jsx("button", { type: "button", style: linkStyle, onClick: () => setDetails(!details), "data-orrery-edit-lock-action": "details", children: t("editLockDetails") }) : null
				] }, "foot"),
				details && view?.technical ? jsx("pre", {
					style: { ...mutedStyle, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "6px 0 0", fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)" },
					"data-orrery-edit-lock-details": "",
					children: [
						`session ${view.technical.sessionId} \u00b7 epoch ${view.technical.executionEpoch ?? "-"}`,
						`root ${view.technical.root ?? "-"} (${view.technical.mode ?? "-"})`,
						...files.map((file) => `${file.detail.path} \u00b7 ${file.detail.owner} \u00b7 generation ${file.detail.generation}${file.reason ? ` \u00b7 ${file.reason}` : ""}`)
					].join("\n")
				}, "details") : null
			];
			return jsxs("span", {
				style: { position: "relative", display: "inline-flex" },
				children: [
					jsxs("button", {
						type: "button",
						style: buttonStyle,
						onClick: toggle,
						"aria-expanded": open,
						"data-orrery-edit-lock": "",
						"data-orrery-edit-lock-state": state,
						title: view ? summary : t("editLockTitle"),
						children: [dot(state), jsx("span", { children: t("editLockLabel") })]
					}),
					open ? jsx("div", {
						role: "dialog",
						"aria-label": t("editLockPanelTitle"),
						style: panelStyle,
						"data-orrery-edit-lock-panel": "",
						onKeyDown: (event) => { if (event?.key === "Escape") setOpen(false); },
						children
					}) : null
				]
			});
		}
		exports.EditLockPanel = EditLockPanel;
		exports.stateOf = stateOf;
		exports.primaryOf = primaryOf;
		exports.rowCommand = rowCommand;
		return module.exports;
	}
});
