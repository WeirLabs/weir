window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.file-lease-tool-view.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;
		// Edit-lock conversation cards (openspec edit-lock-tool-cards, design D3).
		// One read-only card per edit_lock_* call: a collapsed row (lock glyph,
		// localized title, primary path, state badge) and an expandable body with
		// the outcome's details. The ONLY control is the row's disclosure button:
		// no verb, no command, no notice, nothing that writes to the conversation.
		// Every visible string comes from the GUI-language dictionaries below;
		// the model's English result text is only the row's hover title (and the
		// raw text of a call that has no structured outcome). A card is the
		// snapshot of its call — it never polls and never claims current
		// ownership. The model helpers arrive through props.model (the entry
		// composes lib/client.file-lease-tool-model.js); errors never throw out.
		const MONO = "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)";
		const TONES = {
			success: "var(--dsw-alias-state-success-primary, #2f855a)",
			wait: "var(--dsw-alias-state-business-primary)",
			danger: "var(--dsw-alias-state-error-primary)",
			warn: "var(--dsw-alias-state-warn-primary)",
			neutral: "var(--dsw-alias-label-tertiary)"
		};
		const toneColor = (tone) => TONES[tone] ?? TONES.neutral;
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
		const mono = { fontFamily: MONO, overflowWrap: "anywhere", wordBreak: "break-word" };
		const text = {
			title: { fontSize: "13px", lineHeight: "18px", fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			body: { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", overflowWrap: "anywhere" },
			foot: { fontSize: "11px", lineHeight: "15px", color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" }
		};
		const cardStyle = {
			background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-md, 8px)", padding: "8px 10px",
			minWidth: 0, maxWidth: "100%", overflow: "hidden"
		};
		const rowButtonStyle = {
			display: "flex", alignItems: "center", gap: "8px", width: "100%", minWidth: 0,
			padding: 0, margin: 0, border: "none", background: "none", cursor: "pointer",
			textAlign: "left", font: "inherit", color: "inherit"
		};
		const calloutStyle = (color) => ({
			padding: "5px 8px", fontSize: "12px", lineHeight: "16px",
			color: "var(--dsw-alias-label-secondary)", background: tint(color, 8),
			borderLeft: `2px solid ${color}`, borderRadius: "var(--dsw-radius-xs, 4px)",
			overflowWrap: "anywhere"
		});
		const preStyle = {
			margin: 0, padding: "6px 8px", fontFamily: MONO, fontSize: "11px", lineHeight: "16px",
			whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere", maxHeight: "240px", overflow: "auto",
			boxSizing: "border-box", maxWidth: "100%", minWidth: 0,
			border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md, 8px)",
			background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-secondary)"
		};
		/** `{name}` placeholders, substituted literally (no host interpolation assumed). */
		const fill = (template, vars) => String(template).replace(/\{(\w+)\}/g, (whole, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
		/** Absolute local time of a call-time instant; ISO on hover. */
		const timeOf = (ms) => {
			try {
				return new Date(ms).toLocaleString();
			} catch {
				return String(ms);
			}
		};
		const isoOf = (ms) => {
			try {
				return new Date(ms).toISOString();
			} catch {
				return "";
			}
		};
		/** 16x16 lock glyph, stroke currentColor. */
		function LockGlyph(props) {
			const size = props.size ?? 13;
			return jsxs("svg", {
				viewBox: "0 0 16 16", width: size, height: size, "aria-hidden": true,
				fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
				style: { flex: "none", display: "inline-block", verticalAlign: "-2px" },
				children: [
					jsx("rect", { x: 3.2, y: 7, width: 9.6, height: 6.6, rx: 1.4 }, "body"),
					jsx("path", { d: "M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" }, "shackle"),
					jsx("path", { d: "M8 9.6v1.6" }, "keyhole")
				]
			});
		}
		function Chevron(props) {
			return jsx("svg", {
				viewBox: "0 0 16 16", width: 12, height: 12, "aria-hidden": true,
				fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
				style: { flex: "none", display: "inline-block", transition: "transform 120ms ease", transform: props.open ? "rotate(90deg)" : "none" },
				children: jsx("path", { d: "M6 3.5L10.5 8L6 12.5" })
			});
		}
		/** State badge: dot + label on a soft tint of the tone colour. */
		function Badge(props) {
			return jsxs("span", {
				"data-weir-lease-badge": props.state,
				style: {
					display: "inline-flex", alignItems: "center", gap: "5px", padding: "1px 7px",
					fontSize: "11px", lineHeight: "16px", fontWeight: 600, color: props.color,
					background: tint(props.color, 12), border: `1px solid ${props.color}`,
					borderRadius: "var(--dsw-radius-sm)", flex: "none", whiteSpace: "nowrap"
				},
				children: [
					jsx("span", { "aria-hidden": true, style: { display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: props.color, flex: "none" } }, "dot"),
					jsx("span", { children: props.label }, "label")
				]
			});
		}
		const line = (key, children, style) => jsx("div", { style: style ?? text.body, children }, key);
		const pathChip = (path) => jsx("span", { style: { ...mono, fontSize: "11px", color: "var(--dsw-alias-label-primary)" }, children: path });
		/** A labelled path list; each row may carry a trailing localized note. */
		function pathList(key, label, rows) {
			return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "2px" }, children: [
				label ? jsx("div", { style: text.foot, children: label }, "label") : null,
				...rows.map((row, index) => jsxs("div", { style: { ...text.body, display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "baseline" }, children: [
					pathChip(row.path),
					row.note ? jsx("span", { title: row.title, children: row.note }, "note") : null
				] }, `${row.path}-${index}`))
			] }, key);
		}
		const holderText = (t, holder) => (holder ? fill(t("leaseToolHolder"), { label: holder.label, session: holder.session }) : t("leaseToolHolderUnknown"));
		/** Body rows for a call WITH a structured outcome. */
		function outcomeRows(meta, t) {
			const rows = [];
			const path = meta.path ?? "";
			const degradedCallout = (key) => {
				rows.push(jsx("div", { style: calloutStyle(TONES.warn), children: t(key) }, "degraded"));
				if (meta.code) rows.push(line("code", fill(t("leaseToolCode"), { code: meta.code }), text.foot));
			};
			if (meta.state === "degraded") {
				degradedCallout("leaseToolDegraded");
				const about = meta.path ? [meta.path] : meta.paths;
				if (about.length) rows.push(pathList("about", t("leaseToolRequestedPaths"), about.map((p) => ({ path: p }))));
				if (meta.requestId) rows.push(line("request", fill(t("leaseToolRequest"), { id: meta.requestId })));
				return rows;
			}
			switch (meta.tool) {
				case "edit_lock_acquire":
					rows.push(meta.paths.length
						? pathList("claimed", t("leaseToolClaimedPaths"), meta.paths.map((p) => ({ path: p })))
						: line("nothing", t("leaseToolNothingClaimed")));
					break;
				case "edit_lock_release":
					if (meta.released.length) rows.push(pathList("released", t("leaseToolReleasedPaths"), meta.released.map((p) => ({ path: p }))));
					if (meta.notOwned.length) rows.push(pathList("not-owned", t("leaseToolNotOwnedPaths"), meta.notOwned.map((p) => ({ path: p }))));
					if (!meta.released.length && !meta.notOwned.length) rows.push(line("nothing", t("leaseToolNothingReleased")));
					break;
				case "edit_lock_hold":
					rows.push(meta.held.length
						? pathList("held", null, meta.held.map((row) => ({ path: row.path, note: row.holdUntil !== null ? fill(t("leaseToolHeldUntil"), { time: timeOf(row.holdUntil) }) : null, title: row.holdUntil !== null ? isoOf(row.holdUntil) : undefined })))
						: line("nothing", t("leaseToolNothingHeld")));
					break;
				case "edit_lock_status":
					rows.push(meta.mine.length
						? pathList("mine", fill(t("leaseToolMine"), { count: meta.mine.length }), meta.mine.map((row) => ({
							path: row.path,
							note: row.until === null ? null : fill(t(row.retained ? "leaseToolHeldUntil" : "leaseToolValidUntil"), { time: timeOf(row.until) }),
							title: row.until === null ? undefined : isoOf(row.until)
						})))
						: line("mine-empty", t("leaseToolMineEmpty")));
					if (meta.others.length) {
						rows.push(pathList("others", fill(t("leaseToolOthers"), { count: meta.others.length }), meta.others.map((row) => ({
							path: row.path,
							note: [
								row.label && row.session ? fill(t("leaseToolHolder"), { label: row.label, session: row.session }) : null,
								row.lapsed ? t("leaseToolLapsed") : row.until !== null ? fill(t("leaseToolUntil"), { time: timeOf(row.until) }) : null
							].filter(Boolean).join(" · "),
							title: row.until !== null ? isoOf(row.until) : undefined
						}))));
					}
					if (meta.at !== null) rows.push(jsx("div", { style: text.foot, title: isoOf(meta.at), children: fill(t("leaseToolReadAt"), { time: timeOf(meta.at) }) }, "read-at"));
					break;
				case "edit_lock_try_steal":
					if (meta.state === "pending") {
						rows.push(line("pending", fill(t("leaseToolPendingDetail"), { id: meta.requestId ?? "", holder: holderText(t, meta.holder), path })));
						if (meta.expiresAt !== null) rows.push(jsx("div", { style: text.foot, title: isoOf(meta.expiresAt), children: fill(t("leaseToolPendingExpires"), { time: timeOf(meta.expiresAt) }) }, "expires"));
					} else if (meta.state === "free") rows.push(line("free", fill(t("leaseToolStealFree"), { path })));
					else rows.push(line("self", fill(t("leaseToolStealSelf"), { path })));
					break;
				case "edit_lock_reply":
					rows.push(line("reply", fill(t(meta.state === "transferred" ? "leaseToolReplyTransferred" : "leaseToolReplyDeclined"), { id: meta.requestId ?? "" })));
					break;
				case "edit_lock_watch":
					if (meta.state === "watching") {
						rows.push(line("waiting", fill(t("leaseToolWatchWaiting"), { holder: holderText(t, meta.holder), path })));
					} else if (meta.state === "free") rows.push(line("free", fill(t("leaseToolWatchFree"), { path })));
					else if (meta.state === "self") rows.push(line("self", fill(t("leaseToolWatchSelf"), { path })));
					else if (meta.state === "released") rows.push(line("released", fill(t("leaseToolWatchReleased"), { path })));
					else if (meta.state === "reset") degradedCallout("leaseToolWatchReset");
					else if (meta.state === "unsupported") degradedCallout("leaseToolWatchUnsupported");
					else if (meta.state === "cancelled") degradedCallout("leaseToolWatchCancelled");
					break;
				default:
					break;
			}
			return rows;
		}
		/** Body rows for a call WITHOUT a structured outcome (never empty). */
		function fallbackRows(state, paths, requestId, block, model, t) {
			const rows = [];
			if (state === "running") rows.push(line("running", t("leaseToolRunning")));
			if (state === "stopped") rows.push(line("stopped", t("leaseToolStoppedDetail")));
			if (state === "failed") rows.push(line("failed", t("leaseToolFailedDetail")));
			if (paths.length) rows.push(pathList("requested", t("leaseToolRequestedPaths"), paths.map((p) => ({ path: p }))));
			if (requestId) rows.push(line("request", fill(t("leaseToolRequest"), { id: requestId })));
			const raw = state === "failed" ? model.errorText(block) : state === "raw" || state === "stopped" ? model.resultText(block) : "";
			if (raw !== "") {
				rows.push(jsxs("div", { children: [
					jsx("div", { style: { ...text.foot, marginBottom: "3px" }, children: t(state === "failed" ? "leaseToolErrorText" : "leaseToolRawOutput") }, "hint"),
					jsx("pre", { style: preStyle, "data-weir-lease-raw": "", children: raw }, "pre")
				] }, "raw"));
			}
			return rows;
		}
		/** The keyed conversation card for one edit_lock_* call. */
		function FileLeaseToolRow(props) {
			const model = props.model;
			const block = props.block;
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const [open, setOpen] = react.useState(false);
			const meta = model.narrowLeaseMeta(block?.meta);
			const tool = meta?.tool ?? (typeof props.toolName === "string" ? props.toolName : typeof block?.name === "string" ? block.name : typeof block?.call?.name === "string" ? block.call.name : "");
			const state = meta ? meta.state : model.fallbackState(props.phase, block);
			const color = toneColor(model.colorOf(tool, state));
			const argsRaw = model.argsRawOf(block);
			const paths = meta ? model.outcomePaths(meta) : model.argsPaths(tool, argsRaw).map((p) => model.shortPath(p, props.cwd));
			const requestId = meta ? meta.requestId : tool === "edit_lock_reply" ? model.argsRequestId(argsRaw) : null;
			const titleKey = model.LEASE_TOOLS.includes(tool) ? `leaseToolTitle_${tool}` : "leaseToolTitle_unknown";
			// The primary subject of the row: a path (+N), the reply's request id,
			// or the status counts. Never the model's text.
			let subject = null;
			if (meta && meta.tool === "edit_lock_status" && meta.state === "status") {
				subject = jsx("span", { style: { ...text.body, flex: "0 1 auto", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }, children: fill(t("leaseToolStatusSummary"), { mine: meta.mine.length, others: meta.others.length }) }, "subject");
			} else if (paths.length) {
				subject = jsxs("span", { style: { display: "inline-flex", alignItems: "baseline", gap: "4px", flex: "0 1 auto", minWidth: 0, overflow: "hidden" }, children: [
					jsx("span", { "data-weir-lease-path": "", style: { ...mono, fontSize: "12px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }, children: paths[0] }, "path"),
					paths.length > 1 ? jsx("span", { "data-weir-lease-more": "", style: { ...text.foot, flex: "none" }, children: `+${paths.length - 1}` }, "more") : null
				] }, "subject");
			} else if (requestId) {
				subject = jsx("span", { style: { fontFamily: MONO, fontSize: "12px", color: "var(--dsw-alias-label-secondary)", flex: "0 1 auto", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }, children: requestId }, "subject");
			}
			const hover = model.resultText(block);
			const body = meta ? outcomeRows(meta, t) : fallbackRows(state, paths, requestId, block, model, t);
			body.push(jsx("div", { style: text.foot, children: t("leaseToolSnapshot") }, "snapshot"));
			const watching = meta?.tool === "edit_lock_watch" && meta.state === "watching";
			return jsxs("div", {
				"data-tool": tool,
				"data-weir-lease-tool": tool,
				"data-weir-lease-state": state,
				style: cardStyle,
				children: [
					jsxs("button", {
						type: "button",
						"aria-expanded": open,
						title: hover !== "" ? hover : undefined,
						onClick: () => setOpen(!open),
						style: rowButtonStyle,
						children: [
							jsx("span", { style: { color, display: "inline-flex", flex: "none" }, children: jsx(LockGlyph, { size: 13 }) }, "icon"),
							jsx("span", { style: { ...text.title, flex: "0 1 auto", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }, children: t(titleKey) }, "title"),
							subject,
							jsx("span", { style: { flex: 1, minWidth: 0 } }, "spacer"),
							jsx(Badge, { state, label: t(model.stateKey(tool, state)), color }, "badge"),
							jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", display: "inline-flex", flex: "none" }, children: jsx(Chevron, { open }) }, "chevron")
						]
					}, "row"),
					// The wait's meaning is visible without expanding: a release
					// produces a notice, and the notice is not an ownership grant.
					watching ? jsx("div", { "data-weir-lease-watch-note": "", style: { ...calloutStyle(TONES.wait), marginTop: "6px" }, children: t("leaseToolWatchNote") }, "watch-note") : null,
					open ? jsx("div", { "data-weir-lease-body": "", style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "8px", minWidth: 0 }, children: body }, "body") : null
				]
			});
		}
		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under
		// "settings.weir.file-lease-tools" when this chunk arrives (lib/client.js
		// registerChunkDictionaries). Pinned by test/client.test.js's dictionary
		// union pin and test/client-file-lease-tool-view.test.js's parity check.
		const dictionaries = {
			en: {
				leaseToolTitle_edit_lock_acquire: "Claim edit lock",
				leaseToolTitle_edit_lock_release: "Release edit lock",
				leaseToolTitle_edit_lock_hold: "Keep edit lock",
				leaseToolTitle_edit_lock_status: "Edit lock status",
				leaseToolTitle_edit_lock_try_steal: "Request edit lock transfer",
				leaseToolTitle_edit_lock_reply: "Answer transfer request",
				leaseToolTitle_edit_lock_watch: "Watch for release",
				leaseToolTitle_unknown: "Edit lock",
				leaseToolState_claimed: "Claimed",
				leaseToolState_released: "Released",
				leaseToolState_held: "Kept",
				leaseToolState_status: "Snapshot",
				leaseToolState_pending: "Awaiting answer",
				leaseToolState_free: "Not held",
				leaseToolState_self: "Already yours",
				leaseToolState_transferred: "Transferred",
				leaseToolState_declined: "Declined",
				leaseToolState_watching: "Waiting for release",
				leaseToolState_watch_released: "Released meanwhile",
				leaseToolState_reset: "Connection reset",
				leaseToolState_unsupported: "Not supported",
				leaseToolState_cancelled: "Cancelled",
				leaseToolState_degraded: "Protection unavailable",
				leaseToolState_running: "Running",
				leaseToolState_failed: "Refused or failed",
				leaseToolState_stopped: "Interrupted",
				leaseToolState_raw: "Result",
				leaseToolClaimedPaths: "Claimed for this turn",
				leaseToolNothingClaimed: "Nothing was claimed.",
				leaseToolReleasedPaths: "Released",
				leaseToolNotOwnedPaths: "Not held by this session, so nothing to release",
				leaseToolNothingReleased: "Nothing was released.",
				leaseToolHeldUntil: "kept until {time}",
				leaseToolValidUntil: "valid until {time}",
				leaseToolUntil: "until {time}",
				leaseToolNothingHeld: "Nothing was kept.",
				leaseToolMine: "Held by this session ({count})",
				leaseToolMineEmpty: "This session held nothing.",
				leaseToolOthers: "Held by other sessions ({count})",
				leaseToolHolder: "{label} (session {session})",
				leaseToolHolderUnknown: "another session",
				leaseToolLapsed: "lapsed, claimable",
				leaseToolStatusSummary: "{mine} here · {others} elsewhere",
				leaseToolReadAt: "Read at {time}",
				leaseToolPendingDetail: "Request {id} for {path} is waiting for {holder} to answer.",
				leaseToolPendingExpires: "If unanswered it expires at {time}, and ownership stays where it is.",
				leaseToolStealFree: "Nobody held {path} at call time, so no transfer was requested.",
				leaseToolStealSelf: "This session already held {path}; no transfer was needed.",
				leaseToolReplyTransferred: "Request {id} was handed over: the requester holds the path now, this session no longer does.",
				leaseToolReplyDeclined: "Request {id} was declined: ownership is unchanged and the path stays with this session.",
				leaseToolWatchWaiting: "Waiting for {holder} to release {path}.",
				leaseToolWatchNote: "A release arrives as a notice. The notice only means the path can be claimed again — it is not an ownership grant.",
				leaseToolWatchFree: "Nobody held {path} at call time, so no subscription was kept.",
				leaseToolWatchSelf: "This session already held {path}; there was nothing to wait for.",
				leaseToolWatchReleased: "{path} was released while the subscription was being set up, so nothing is pending.",
				leaseToolWatchReset: "The arbiter connection was reset while subscribing: nothing is pending and ownership is unknown.",
				leaseToolWatchUnsupported: "The arbiter does not announce releases, so no subscription was created. Other edit-lock protection is unaffected.",
				leaseToolWatchCancelled: "The subscription was cancelled before it was set up, so nothing is pending.",
				leaseToolDegraded: "The ownership arbiter was unreachable, so edit protection was temporarily unavailable. This is not a conflict.",
				leaseToolCode: "code: {code}",
				leaseToolRequest: "Request {id}",
				leaseToolRequestedPaths: "Requested paths",
				leaseToolRunning: "Waiting for the result…",
				leaseToolFailedDetail: "The call was refused or failed.",
				leaseToolStoppedDetail: "The call was interrupted.",
				leaseToolErrorText: "Error text",
				leaseToolRawOutput: "Recorded output",
				leaseToolSnapshot: "Outcome at call time; this card does not follow later changes."
			},
			zh: {
				leaseToolTitle_edit_lock_acquire: "申请编辑锁",
				leaseToolTitle_edit_lock_release: "释放编辑锁",
				leaseToolTitle_edit_lock_hold: "保留编辑锁",
				leaseToolTitle_edit_lock_status: "编辑锁状态",
				leaseToolTitle_edit_lock_try_steal: "请求转交编辑锁",
				leaseToolTitle_edit_lock_reply: "答复转交请求",
				leaseToolTitle_edit_lock_watch: "订阅释放",
				leaseToolTitle_unknown: "编辑锁",
				leaseToolState_claimed: "已申请",
				leaseToolState_released: "已释放",
				leaseToolState_held: "已保留",
				leaseToolState_status: "快照",
				leaseToolState_pending: "等待答复",
				leaseToolState_free: "无人持有",
				leaseToolState_self: "本会话已持有",
				leaseToolState_transferred: "已转交",
				leaseToolState_declined: "已拒绝",
				leaseToolState_watching: "等待释放",
				leaseToolState_watch_released: "期间已释放",
				leaseToolState_reset: "连接已重置",
				leaseToolState_unsupported: "不支持",
				leaseToolState_cancelled: "已取消",
				leaseToolState_degraded: "保护暂不可用",
				leaseToolState_running: "进行中",
				leaseToolState_failed: "已拒绝或失败",
				leaseToolState_stopped: "已中断",
				leaseToolState_raw: "结果",
				leaseToolClaimedPaths: "本轮已申请",
				leaseToolNothingClaimed: "没有申请到任何路径。",
				leaseToolReleasedPaths: "已释放",
				leaseToolNotOwnedPaths: "本会话未持有，无需释放",
				leaseToolNothingReleased: "没有释放任何路径。",
				leaseToolHeldUntil: "保留至 {time}",
				leaseToolValidUntil: "有效至 {time}",
				leaseToolUntil: "至 {time}",
				leaseToolNothingHeld: "没有保留任何路径。",
				leaseToolMine: "本会话持有（{count}）",
				leaseToolMineEmpty: "本会话未持有任何路径。",
				leaseToolOthers: "其他会话持有（{count}）",
				leaseToolHolder: "{label}（会话 {session}）",
				leaseToolHolderUnknown: "另一个会话",
				leaseToolLapsed: "已过期，可申请",
				leaseToolStatusSummary: "本会话 {mine} · 其他 {others}",
				leaseToolReadAt: "读取于 {time}",
				leaseToolPendingDetail: "关于 {path} 的请求 {id} 正等待 {holder}答复。",
				leaseToolPendingExpires: "若无人答复，将于 {time} 过期，所有权保持不变。",
				leaseToolStealFree: "调用时无人持有 {path}，未发起转交请求。",
				leaseToolStealSelf: "本会话已持有 {path}，无需转交。",
				leaseToolReplyTransferred: "请求 {id} 已转交：请求方现在持有该路径，本会话不再持有。",
				leaseToolReplyDeclined: "请求 {id} 已拒绝：所有权不变，路径仍归本会话。",
				leaseToolWatchWaiting: "正在等待 {holder}释放 {path}。",
				leaseToolWatchNote: "释放后会收到一条通知；通知只代表可以重新争取，不代表已获得锁。",
				leaseToolWatchFree: "调用时无人持有 {path}，未保留订阅。",
				leaseToolWatchSelf: "本会话已持有 {path}，无需等待。",
				leaseToolWatchReleased: "订阅建立期间 {path} 已被释放，没有待处理的等待。",
				leaseToolWatchReset: "建立订阅时仲裁连接被重置：没有待处理的等待，所有权未知。",
				leaseToolWatchUnsupported: "当前仲裁器不支持释放通知，未创建订阅；其他编辑锁保护不受影响。",
				leaseToolWatchCancelled: "订阅在建立前已被取消，没有待处理的等待。",
				leaseToolDegraded: "编辑锁仲裁器暂时无法连接，编辑保护暂不可用。这不是冲突。",
				leaseToolCode: "代码：{code}",
				leaseToolRequest: "请求 {id}",
				leaseToolRequestedPaths: "请求的路径",
				leaseToolRunning: "正在等待结果…",
				leaseToolFailedDetail: "调用被拒绝或失败。",
				leaseToolStoppedDetail: "调用已中断。",
				leaseToolErrorText: "错误信息",
				leaseToolRawOutput: "记录的输出",
				leaseToolSnapshot: "以上是调用时的结果，不会随后续变化更新。"
			}
		};
		exports.FileLeaseToolRow = FileLeaseToolRow;
		exports.dictionaries = dictionaries;
		return module.exports;
	}
});
