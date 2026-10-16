window.__ModuleLoader__.load({
	id: "weir-harness",
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
		const STATES = ["revoked", "unavailable", "stopped", "attention", "confirm", "holding", "editing", "idle"];
		/** Status-dot colour per state; only theme-defined tokens. */
		const dotColor = {
			idle: "var(--dsw-alias-label-tertiary)",
			editing: "var(--dsw-alias-state-business-primary)",
			holding: "var(--dsw-alias-state-business-primary)",
			confirm: "var(--dsw-alias-state-warn-primary)",
			stopped: "var(--dsw-alias-state-warn-primary)",
			attention: "var(--dsw-alias-state-error-primary)",
			revoked: "var(--dsw-alias-label-tertiary)",
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
			boxShadow: "0 6px 24px var(--dsw-alias-border-l2)",
			padding: "10px 12px",
			color: "var(--dsw-alias-label-primary)",
			fontSize: "12px",
			lineHeight: "18px"
		};
		const mutedStyle = { color: "var(--dsw-alias-label-secondary)" };
		const errorStyle = { color: "var(--dsw-alias-state-error-primary)", marginTop: "6px" };
		const rowStyle = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" };
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
			if (state === "unavailable" && view.bindingFailure?.code === "binding-duplicate" && view.bindingFailure.retryable === true && view.bindingFailure.inFlight !== true) return { verb: "retry", label: "editLockRetry" };
			// Continue editing is one human action: restore authority, then confirm the
			// retained files (each through the ordinary per-file check).
			// confirm --all only when something waits, so no empty "Confirmed 0 of 0" is recorded.
			if (state === "stopped" || state === "revoked") return { verbs: view.files.some((file) => file.mine && file.status === "user-interrupted") ? ["resume", "confirm --all"] : ["resume"], label: "editLockResume" };
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
				(reason) => {
					const message = reason instanceof Error ? reason.message : String(reason);
					setError(message);
					setView({ state: "unavailable", reason: message, files: [] });
				}
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
			// Close on outside click: any pointerdown outside this entry's wrapper
			// dismisses the panel (Escape on the panel still works as well).
			react.useEffect(() => {
				if (!open || typeof document === "undefined") return undefined;
				const onPointerDown = (event) => {
					if (event?.target?.closest?.("[data-weir-edit-lock-root]")) return;
					setOpen(false);
					setArmedRevoke(false);
					setArmedUnlock(null);
				};
				document.addEventListener("pointerdown", onPointerDown);
				return () => { document.removeEventListener("pointerdown", onPointerDown); };
			}, [open]);
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
				"data-weir-edit-lock-action": key, children: label
			}, key);
			const summary = (() => {
				if (!view) return t("editLockLoading");
				if (state === "unavailable" && view.bindingFailure?.inFlight === true) return t("editLockRetryPending");
				if (state === "unavailable" && view.reason) return t("editLockState_failed");
				const base = t(`editLockState_${state}`);
				if (state === "holding" && view.hold) return `${base} ${t("editLockHoldUntil").replace("{time}", clock(view.hold.until))}`;
				if (state === "confirm") return `${base} (${view.pendingCount})`;
				return base;
			})();
			// A cold view (restored session, no live agent) is read-only: every write
			// action needs the live agent's command channel, so no button renders.
			const cold = view?.cold === true;
			const primary = view && !cold ? primaryOf(state, view) : null;
			const files = view?.files ?? [];
			const canRevoke = !cold && state !== "stopped" && state !== "unavailable" && state !== "revoked";
			// Structured binding refusals have localized guidance; retain the complete
			// diagnostic on demand, even when no session technical view exists yet.
			const bindingRefusal = state === "unavailable" && view?.bindingFailure?.code === "binding-duplicate";
			const detailReason = bindingRefusal ? view.reason : null;
			const hasDetails = Boolean(view?.technical || detailReason);
			// Only the exact reason (or the command's fixed wrapper) is redundant.
			// Never infer failure identity or retry eligibility from prose.
			const duplicateError = detailReason && (error === detailReason || error === `edit-lock: ${detailReason}`);
			const children = [
				jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [
					dot(state),
					jsx("span", { style: { flex: 1, fontWeight: 600 }, "data-weir-edit-lock-summary": "", children: summary }),
					jsx("button", { type: "button", style: linkStyle, disabled: pending, onClick: () => refresh(), "data-weir-edit-lock-action": "refresh", title: t("editLockRefresh"), children: "\u21bb" })
				] }, "head"),
				view?.reason && !bindingRefusal ? jsx("div", { style: { ...errorStyle, wordBreak: "break-word" }, "data-weir-edit-lock-reason": "", children: view.reason }, "reason") : null,
				view?.bindingFailure ? jsx("div", { style: mutedStyle, "data-weir-edit-lock-binding": "", children: t(`editLockBinding_${view.bindingFailure.holderKind ?? "unknown"}`) }, "binding") : null,
				state === "revoked" && !cold ? jsx("div", { style: { ...mutedStyle, marginTop: "4px" }, "data-weir-edit-lock-revoked": "", children: t("editLockRevokedHint") }, "revoked") : null,
				cold && state === "revoked" ? jsx("div", { style: { ...mutedStyle, marginTop: "4px" }, "data-weir-edit-lock-cold": "", children: t(view.autoResume === false ? "editLockColdRevokedManual" : "editLockColdRevokedAuto") }, "cold") : null,
				cold && state === "stopped" ? jsx("div", { style: { ...mutedStyle, marginTop: "4px" }, "data-weir-edit-lock-cold": "", children: t(view.autoResume === false ? "editLockColdResumeManual" : "editLockColdResumeAuto") }, "cold") : null,
				// Usage is historical; only the live driver's explicit deadline signals a pause.
				// Follow-up locale keys: editLockCleanupOnly, editLockRecoveryUsage,
				// editLockPauseUsageHint. Template-layer fallback stays English.
				view?.cleanupOnly ? jsx("div", { style: { ...mutedStyle, marginTop: "4px" }, "data-weir-edit-lock-cleanup": "", children: t("editLockCleanupOnly") }, "cleanup") : null,
				// Follow-up locale key: editLockPausedUntil, with {time}. Absolute clock,
				// not a countdown or a promise to release locks/restore editing at expiry.
				!cold && state === "attention" && view?.cleanupOnly && Number.isFinite(view.pausedUntil) && view.pausedUntil > Date.now() ? jsx("div", { style: { ...mutedStyle, marginTop: "4px" }, "data-weir-edit-lock-paused-until": "", children: t("editLockPausedUntil").replace("{time}", clock(view.pausedUntil)) }, "paused-until") : null,
				view?.recovery ? jsx("div", { style: { ...mutedStyle, marginTop: "4px" }, "data-weir-edit-lock-recovery": "", children: t("editLockRecoveryUsage").replace("{attempts}", String(view.recovery.attempts)).replace("{elapsed}", String(view.recovery.elapsedSeconds)).replace("{pause}", String(view.recovery.pauseMinutes)) }, "recovery") : null,
				view?.recovery?.pauseMinutes > 0 ? jsx("div", { style: { ...mutedStyle, marginTop: "4px" }, "data-weir-edit-lock-pause": "", children: t("editLockPauseUsageHint") }, "pause") : null,
				primary ? jsx("div", { style: { marginTop: "8px" }, children: action("primary", t(primary.label), () => run(primary.verbs ?? primary.verb), primaryStyle) }, "primary") : null,
				files.length ? jsx("div", { style: { marginTop: "8px" }, "data-weir-edit-lock-files": "", children: files.map((file) => jsxs("div", {
					style: { padding: "4px 0", borderTop: "1px solid var(--dsw-alias-border-l2)" },
					"data-weir-edit-lock-file": file.detail.path,
					children: [
						jsxs("div", { style: rowStyle, children: [
							jsx("span", { style: nameStyle, title: file.detail.path, children: file.name }),
							jsx("span", { style: mutedStyle, children: file.mine ? t(`editLockStatus_${file.status}`) : `${t("editLockOwnerOther")} · ${t(`editLockStatus_${file.status}`)}` }),
							cold || !rowCommand(file) ? null
								: file.action === "unlock" && armedUnlock !== file.detail.path
									? action(`arm-unlock:${file.detail.path}`, t("editLockRow_unlock"), () => setArmedUnlock(file.detail.path))
									: action(`${file.action}:${file.detail.path}`, t(file.action === "unlock" ? "editLockRow_unlockConfirm" : `editLockRow_${file.action}`), () => run(rowCommand(file)), file.action === "unlock" ? dangerStyle : buttonStyle)
						] }),
						file.reason ? jsx("div", { style: { ...mutedStyle, overflowWrap: "anywhere" }, "data-weir-edit-lock-file-reason": file.detail.path, children: file.reason }) : null
					]
				}, file.detail.path)) }, "files") : null,
				// Follow-up locale key: editLockOwnershipHint. Outcomes remain in the
				// adjacent tool result; lock rows do not establish a publication result.
				files.length ? jsx("div", { style: { ...mutedStyle, marginTop: "6px" }, "data-weir-edit-lock-ownership-hint": "", children: t("editLockOwnershipHint") }, "ownership-hint") : null,
				error && !duplicateError ? jsx("div", { style: errorStyle, "data-weir-edit-lock-error": "", children: error }, "error") : null,
				jsxs("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "10px" }, children: [
					canRevoke ? (armedRevoke
						? action("stop", t("editLockRevokeConfirm"), () => run("stop"), dangerStyle)
						: jsx("button", { type: "button", style: linkStyle, disabled: pending, onClick: () => setArmedRevoke(true), "data-weir-edit-lock-action": "arm-stop", children: t("editLockStop") })) : null,
					jsx("span", { style: { flex: 1 } }),
					hasDetails ? jsx("button", { type: "button", style: linkStyle, onClick: () => setDetails(!details), "aria-expanded": details, "data-weir-edit-lock-action": "details", children: t("editLockDetails") }) : null
				] }, "foot"),
				details && hasDetails ? jsx("pre", {
					style: { ...mutedStyle, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "6px 0 0", fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)" },
					"data-weir-edit-lock-details": "",
					children: [
						...(detailReason ? [detailReason] : []),
						...(view?.technical ? [
							`session ${view.technical.sessionId} \u00b7 epoch ${view.technical.executionEpoch ?? "-"}`,
							`root ${view.technical.root ?? "-"} (${view.technical.mode ?? "-"})`
						] : []),
						...files.map((file) => `${file.detail.path} \u00b7 ${file.detail.owner} \u00b7 generation ${file.detail.generation}${file.reason ? ` \u00b7 ${file.reason}` : ""}`)
					].join("\n")
				}, "details") : null
			];
			return jsxs("span", {
				style: { position: "relative", display: "inline-flex" },
				"data-weir-edit-lock-root": "",
				children: [
					jsxs("button", {
						type: "button",
						style: buttonStyle,
						onClick: toggle,
						"aria-expanded": open,
						"data-weir-edit-lock": "",
						"data-weir-edit-lock-state": state,
						title: view ? summary : t("editLockTitle"),
						children: [dot(state), jsx("span", { children: t("editLockLabel") })]
					}),
					open ? jsx("div", {
						role: "dialog",
						"aria-label": t("editLockPanelTitle"),
						style: panelStyle,
						"data-weir-edit-lock-panel": "",
						onKeyDown: (event) => { if (event?.key === "Escape") setOpen(false); },
						children
					}) : null
				]
			});
		}
		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under "settings.weir.edit-lock"
		// inside a ctx.effect when this chunk arrives (lib/client.js
		// registerChunkDictionaries). Pinned by test/client.test.js's dictionary
		// union pin.
		const dictionaries = {
			en: {
				editLockLabel: "Edit Lock",
				editLockTitle: "Files this session is editing",
				editLockPanelTitle: "Edit Lock",
				editLockLoading: "Loading…",
				editLockRefresh: "Refresh",
				editLockStop: "Revoke editing",
				editLockRevokeConfirm: "Revoke now — the assistant stops editing until you continue",
				editLockResume: "Continue editing",
				editLockRetry: "Retry connection",
				editLockRetryPending: "Retrying connection… Editing remains unavailable.",
				editLockBinding_serving: "This session is being edited in another attachment right now. Retry the connection when that turn finishes; retry does not continue editing.",
				editLockBinding_transferable: "This session's editing authority is held by an inactive attachment of this same session. It attaches here automatically when you send a message; Retry connection also takes it over now (retry does not continue editing).",
				editLockBinding_unknown: "The holder cannot be verified. Wait for its disconnect or confirmed process shutdown, then retry. Never remove a live publisher reservation.",
				"editLockBinding_cross-process": "The holder is in another process. Disconnect it or confirm that process has shut down before retrying.",
				"editLockBinding_revocation-failed": "Durable revocation was not acknowledged. Inspect Edit Lock maintenance; no replacement has been granted.",
				editLockConfirmAll: "Continue with these files",
				editLockReleaseAll: "Release all files now",
				editLockDetails: "Technical details",
				editLockOwnerOther: "Another session",
				editLockHoldUntil: "until {time}",
				editLockRecovery: "The last turn failed; cleaning up (attempt {n}).",
				editLockState_idle: "Not editing any file",
				editLockCleanupOnly: "Cleanup only: business edits and new ownership are blocked. Release files you no longer need; inspect the tool result before retrying edits.",
				editLockRecoveryUsage: "Recorded recovery: {attempts} attempts · {elapsed}s elapsed · {pause} min pause used.",
				editLockPauseUsageHint: "Pause usage is cumulative, not a live timer. Pause expiry re-checks recovery; it does not release locks or restore editing.",
				editLockPausedUntil: "Recovery paused until {time}.",
				editLockOwnershipHint: "Locks show ownership, not write outcomes. For failed edits, inspect the tool result; releasing locks does not undo changes.",
				editLockState_editing: "Editing",
				editLockState_holding: "Files kept for this session",
				editLockState_confirm: "Waiting for you to continue",
				editLockState_stopped: "Editing stopped",
				editLockState_attention: "Needs your attention",
				editLockState_revoked: "Editing revoked by an administrator",
				editLockRevokedHint: "An administrative recovery revoked this session's editing authority and released its locks. Continue editing here, or send any message — editing resumes automatically in a new execution epoch; the revocation record is preserved.",
				editLockColdRevokedAuto: "An administrative recovery revoked this session's editing authority and released its locks. Send any message in this session — the binding and editing resume automatically.",
				editLockColdRevokedManual: "An administrative recovery revoked this session's editing authority and released its locks. Send any message to activate the session, then continue editing from this panel.",
				editLockColdResumeAuto: "This session was restored after a restart and is stopped. Send any message — editing resumes automatically, with the files below confirmed again.",
				editLockColdResumeManual: "This session was restored after a restart and is stopped. Send any message to activate the session, then continue editing from this panel.",
				editLockState_unavailable: "Edit Lock is starting",
				editLockState_failed: "Edit Lock is unavailable; edits are refused",
				editLockStatus_active: "editing",
				"editLockStatus_user-interrupted": "stopped",
				"editLockStatus_pending-confirmation": "waiting",
				editLockStatus_abnormal: "needs attention",
				editLockRow_release: "Release",
				editLockRow_confirm: "Continue",
				editLockRow_unlock: "Unlock",
				editLockRow_unlockConfirm: "Unlock now — the other session loses this file",
			},
			zh: {
				editLockLabel: "编辑锁",
				editLockTitle: "本会话正在编辑的文件",
				editLockPanelTitle: "编辑锁",
				editLockLoading: "加载中…",
				editLockRefresh: "刷新",
				editLockStop: "收回编辑权",
				editLockRevokeConfirm: "确认收回——助手将停止编辑，直到你点继续",
				editLockResume: "继续编辑",
				editLockRetry: "重试连接",
				editLockRetryPending: "正在重试连接……编辑仍不可用。",
				editLockBinding_serving: "本会话正在另一个附着位置编辑中。请在该回合结束后重试连接；重试不等于继续编辑。",
				editLockBinding_transferable: "本会话的编辑权由同一会话的一个不活跃附着持有。你发送下一条消息时会自动接管；也可以立即点「重试连接」接管（重试不等于继续编辑）。",
				editLockBinding_unknown: "无法核实原持有者。请等待原连接断开或确认其进程已退出，再重试；勿删除存活 publisher 的预约。",
				"editLockBinding_cross-process": "原持有者位于另一进程。请先断开原连接或确认其进程已退出，再重试。",
				"editLockBinding_revocation-failed": "持久撤权尚未确认。请查看编辑锁维护；未授予替代绑定权限。",
				editLockConfirmAll: "继续编辑这些文件",
				editLockReleaseAll: "立即释放全部文件",
				editLockDetails: "技术细节",
				editLockOwnerOther: "其他会话",
				editLockHoldUntil: "保留至 {time}",
				editLockRecovery: "上一回合出错，正在清理（第 {n} 次）。",
				editLockState_idle: "未占用任何文件",
				editLockCleanupOnly: "仅允许清理：业务编辑和新占用都被拒绝。请释放不再需要的文件，重试前查看工具结果。",
				editLockRecoveryUsage: "已记录恢复：{attempts} 次 · 已用 {elapsed} 秒 · 已暂停 {pause} 分钟。",
				editLockPauseUsageHint: "暂停时长是累计用量，不是当前倒计时。暂停到期只会重新检查恢复，不释放锁，也不恢复编辑。",
				editLockPausedUntil: "恢复已暂停，至 {time} 后重新检查。",
				editLockOwnershipHint: "锁只表示归属，不表示写入结果。编辑失败请查看工具结果；释放锁不会撤销已发生的修改。",
				editLockState_editing: "正在编辑",
				editLockState_holding: "文件为本会话保留",
				editLockState_confirm: "等你确认继续",
				editLockState_stopped: "编辑已停止",
				editLockState_attention: "需要你处理",
				editLockState_revoked: "编辑权已被管理员吊销",
				editLockRevokedHint: "管理员恢复已吊销本会话的编辑权并释放其锁。点击「继续编辑」或发送任意消息，即在新执行纪元恢复编辑；吊销记录保留。",
				editLockColdRevokedAuto: "管理员恢复已吊销本会话的编辑权并释放其锁。在本会话发送任意消息——连接与编辑会自动恢复。",
				editLockColdRevokedManual: "管理员恢复已吊销本会话的编辑权并释放其锁。发送任意消息激活会话，然后回到此面板点「继续编辑」。",
				editLockColdResumeAuto: "重启后恢复的会话，编辑已停止。发送任意消息即自动恢复编辑（下列文件会一并确认）。",
				editLockColdResumeManual: "重启后恢复的会话，编辑已停止。发送任意消息激活会话，然后回到此面板点「继续编辑」。",
				editLockState_unavailable: "编辑锁启动中",
				editLockState_failed: "编辑锁不可用，编辑会被拒绝",
				editLockStatus_active: "编辑中",
				"editLockStatus_user-interrupted": "已停止",
				"editLockStatus_pending-confirmation": "待确认",
				editLockStatus_abnormal: "需处理",
				editLockRow_release: "释放",
				editLockRow_confirm: "继续",
				editLockRow_unlock: "解锁",
				editLockRow_unlockConfirm: "确认解锁——对方会失去这个文件",
			},
		};

		exports.dictionaries = dictionaries;
		exports.EditLockPanel = EditLockPanel;
		exports.stateOf = stateOf;
		exports.primaryOf = primaryOf;
		exports.rowCommand = rowCommand;
		return module.exports;
	}
});
