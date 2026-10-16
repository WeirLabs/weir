window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.notify-permissions.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// macOS notification permission panel: an entry row plus a modal that
		// detects the permission and walks the user through allowing it. The
		// host decides everything (platform, state, actions) over
		// "api/weir-notify/permissions/*" via the composition root's HTTP
		// channel adapter (props.channel: (endpoint, payload?) => Promise<
		// { ok: true, value } | { ok: false, error }>, never rejecting); this
		// chunk only renders the answer and calls the two whitelisted actions. The entry renders NOTHING until
		// the host confirms it is macOS, so other platforms never see it. Style
		// constants are verbatim copies of the settings-page ones (same-package
		// sync require is impossible in the ModuleLoader).
		const STATUS_PATH = "api/weir-notify/permissions/status";
		const ACTION_PATH = "api/weir-notify/permissions/action";
		const POLL_MS = 2000;
		const POLL_MAX_MS = 180000;
		/** Every dictionary key this chunk reads; test/client-notify-permissions.test.js pins both dictionaries and this source to it. */
		const LABEL_KEYS = [
			"notifyPermissions", "notifyPermissionsHint", "notifyPermissionsOpen",
			"notifyPermTitle", "notifyPermDescription", "notifyPermClose", "notifyPermChecking", "notifyPermRecheck",
			"notifyPermBestEffort", "notifyPermFocusNote",
			"notifyPermSendTest", "notifyPermSending", "notifyPermOpenSettings", "notifyPermOpening", "notifyPermOpenHint",
			"notifyPermWaiting", "notifyPermConfirm", "notifyPermSeenYes", "notifyPermSeenNo", "notifyPermSeen", "notifyPermNotSeen",
			"notifyPermRetry", "notifyPermSendAgain", "notifyPermError", "notifyPermManualPath", "notifyPermDetails", "notifyPermFailed",
			"notifyWebUnsupported", "notifyWebPermission", "notifyWebDeniedHint",
			"notifyWebPerm_granted", "notifyWebPerm_denied", "notifyWebPerm_default",
			"notifyPermState_granted", "notifyPermState_denied", "notifyPermState_unknown",
			"notifyPermReason_alerts-allowed", "notifyPermReason_not-allowed", "notifyPermReason_no-record", "notifyPermReason_default", "notifyPermReason_unreadable"
		];
		const labelStyle = { fontSize: "14px", fontWeight: 500, lineHeight: "20px" };
		const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 0" };
		const labelGroupStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 };
		const sectionStyle = { display: "flex", flexDirection: "column", gap: "10px" };
		const buttonRowStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
		const stateRowStyle = { display: "flex", alignItems: "center", gap: "8px" };
		const errorStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-state-danger-primary, #d33)" };
		const stateDot = (state) => ({ width: "8px", height: "8px", borderRadius: "50%", display: "inline-block", flexShrink: 0, background: state === "granted" ? "var(--dsw-alias-state-business-primary)" : state === "denied" ? "var(--dsw-alias-state-danger-primary, #d33)" : "var(--dsw-alias-label-disabled, #999)" });
		/**
		 * Which single step the panel highlights. granted → test, then confirm;
		 * otherwise test → open settings → wait for the user. The user's own
		 * sighting of the test notification (`seen`) is the final word.
		 */
		function primaryStep(state, flow) {
			if (flow.seen === true) return "seen";
			if (flow.seen === false) return "not-seen";
			if (state === "granted") return flow.testSent ? "confirm" : "test";
			if (!flow.testSent) return "test";
			if (!flow.settingsOpened) return "open";
			return "wait";
		}
		const INITIAL_FLOW = { testSent: false, settingsOpened: false, seen: null };
		const messageOf = (error) => String(error?.message ?? error);
		/**
		 * The page's own web-notification permission, read-only. Delivery itself
		 * lives in client.notify-web.js; the panel only reports this value and
		 * asks for it from inside the user's click (a browser only shows the
		 * prompt during a user gesture, which the host-driven delivery cannot
		 * provide outside the desktop shell). `env` is injectable for tests.
		 */
		function webNotificationSupport(env) {
			const Ctor = env?.Notification;
			return typeof Ctor === "function" ? { supported: true, permission: Ctor.permission ?? "default" } : { supported: false, permission: null };
		}
		/** Ask for the permission now (call from a click handler). Never throws; resolves the resulting permission or null. */
		async function requestWebPermission(env) {
			const Ctor = env?.Notification;
			if (typeof Ctor !== "function") return null;
			try {
				if ((Ctor.permission ?? "default") === "default" && typeof Ctor.requestPermission === "function") return await Ctor.requestPermission();
				return Ctor.permission ?? null;
			} catch {
				return null;
			}
		}
		/** Error boundary isolating the permission panel from the settings page. */
		class NotifyPermissionsBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			render() {
				if (this.state.failed) {
					return react_jsx_runtime.jsx("div", { style: hintStyle, children: this.props.t?.("notifyPermFailed") ?? "Permission panel failed" });
				}
				return this.props.children;
			}
		}
		function NotifyPermissionsPanel(props) {
			const t = props.t;
			// null while probing; { supported: false } hides the entry; otherwise the host status.
			const [host, setHost] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			const [checking, setChecking] = react.useState(false);
			const [busy, setBusy] = react.useState(null);
			const [flow, setFlow] = react.useState(INITIAL_FLOW);
			const [error, setError] = react.useState(null);
			// bumps to re-read the page permission after we asked for it
			const [, setPermTick] = react.useState(0);
			const poll = react.useRef({ timer: null, deadline: 0, active: false });
			const stopPolling = () => {
				poll.current.active = false;
				if (poll.current.timer !== null) globalThis.clearTimeout(poll.current.timer);
				poll.current.timer = null;
			};
			// Resolves the fresh host status, or null when it could not be read.
			const load = () => {
				setChecking(true);
				return props.channel(STATUS_PATH, {}).then((result) => {
					setChecking(false);
					if (result.ok === true && result.value?.supported) {
						setHost(result.value);
						setError(null);
						return result.value;
					}
					setError(result.error?.message ?? "unknown");
					return null;
				}).catch((failure) => {
					setChecking(false);
					setError(messageOf(failure));
					return null;
				});
			};
			react.useEffect(() => {
				props.channel(STATUS_PATH, {}).then(
					(result) => setHost(result.ok === true && result.value?.supported ? result.value : { supported: false }),
					() => setHost({ supported: false })
				);
				return stopPolling;
			}, []);
			const startPolling = () => {
				stopPolling();
				poll.current.active = true;
				poll.current.deadline = Date.now() + POLL_MAX_MS;
				const tick = () => {
					if (!poll.current.active) return;
					load().then((value) => {
						if (!poll.current.active) return;
						if (value?.state === "granted") {
							// Allowed: stop waiting and ask for a fresh test notification as proof.
							stopPolling();
							setFlow((current) => ({ ...current, testSent: false, seen: null }));
							return;
						}
						if (Date.now() >= poll.current.deadline) {
							stopPolling();
							return;
						}
						poll.current.timer = globalThis.setTimeout(tick, POLL_MS);
					});
				};
				poll.current.timer = globalThis.setTimeout(tick, POLL_MS);
			};
			const openPanel = () => {
				setOpen(true);
				setError(null);
				setFlow(INITIAL_FLOW);
				load();
			};
			const closePanel = () => {
				stopPolling();
				setOpen(false);
			};
			const runAction = (action) => {
				setBusy(action);
				setError(null);
				// Ask for the page permission inside this click (the only place a browser shows the prompt).
				const ready = action === "test" ? requestWebPermission(globalThis).then(() => setPermTick((tick) => tick + 1)) : Promise.resolve();
				ready.then(() => props.channel(ACTION_PATH, { action })).then((result) => {
					setBusy(null);
					if (result.ok !== true) {
						setError(result.error?.message ?? "unknown");
						return;
					}
					setFlow((current) => action === "test"
						? { ...current, testSent: true, seen: null }
						: { ...current, settingsOpened: true });
					if (action === "open-settings") startPolling();
					load();
				}).catch((failure) => {
					setBusy(null);
					setError(messageOf(failure));
				});
			};
			if (host === null || host.supported !== true) return null;
			const state = host.state ?? "unknown";
			const step = primaryStep(state, flow);
			const sender = host.sender?.name ?? "DeepSeek Harness";
			const button = (key, variant, onClick, label, disabled) => react_jsx_runtime.jsx(primitives.Button, { key, variant, size: "sm", disabled: disabled === true, onClick, children: label });
			const stepBody = () => {
				switch (step) {
					case "test":
						return [
							button("test", "primary", () => runAction("test"), busy === "test" ? t("notifyPermSending") : t("notifyPermSendTest"), busy !== null)
						];
					case "open":
						return [
							react_jsx_runtime.jsx("div", { style: hintStyle, children: t("notifyPermOpenHint"), key: "open-hint" }),
							react_jsx_runtime.jsxs("div", { style: buttonRowStyle, key: "open-actions", children: [
								button("open", "primary", () => runAction("open-settings"), busy === "open-settings" ? t("notifyPermOpening") : t("notifyPermOpenSettings"), busy !== null),
								button("test-again", "outline", () => runAction("test"), t("notifyPermSendAgain"), busy !== null)
							] })
						];
					case "wait":
						return [
							react_jsx_runtime.jsx("div", { style: hintStyle, children: t("notifyPermWaiting"), key: "waiting" }),
							react_jsx_runtime.jsx("div", { style: hintStyle, children: t("notifyPermOpenHint"), key: "wait-hint" }),
							react_jsx_runtime.jsxs("div", { style: buttonRowStyle, key: "wait-actions", children: [
								button("open-again", "outline", () => runAction("open-settings"), t("notifyPermOpenSettings"), busy !== null),
								button("test-again", "outline", () => runAction("test"), t("notifyPermSendAgain"), busy !== null)
							] })
						];
					case "confirm":
						return [
							react_jsx_runtime.jsx("div", { style: labelStyle, children: t("notifyPermConfirm"), key: "confirm" }),
							react_jsx_runtime.jsxs("div", { style: buttonRowStyle, key: "confirm-actions", children: [
								button("seen-yes", "primary", () => setFlow((current) => ({ ...current, seen: true })), t("notifyPermSeenYes")),
								button("seen-no", "outline", () => setFlow((current) => ({ ...current, seen: false })), t("notifyPermSeenNo")),
								button("test-again", "ghost", () => runAction("test"), t("notifyPermSendAgain"), busy !== null)
							] })
						];
					case "seen":
						return [react_jsx_runtime.jsx("div", { style: labelStyle, children: t("notifyPermSeen"), key: "seen" })];
					default:
						return [
							react_jsx_runtime.jsx("div", { style: hintStyle, children: t("notifyPermNotSeen"), key: "not-seen" }),
							react_jsx_runtime.jsxs("div", { style: buttonRowStyle, key: "not-seen-actions", children: [
								button("open-again", "outline", () => runAction("open-settings"), t("notifyPermOpenSettings"), busy !== null),
								button("retry", "primary", () => setFlow(INITIAL_FLOW), t("notifyPermRetry"))
							] })
						];
				}
			};
			// The page's own permission, read-only (what the browser will let this page show).
			const webStatus = () => {
				const support = webNotificationSupport(globalThis);
				if (!support.supported) return [react_jsx_runtime.jsx("div", { style: errorStyle, children: t("notifyWebUnsupported"), key: "web-unsupported" })];
				return [
					react_jsx_runtime.jsx("div", { style: hintStyle, children: `${t("notifyWebPermission")}: ${t(`notifyWebPerm_${support.permission}`)}`, key: "web-permission" }),
					support.permission === "denied" ? react_jsx_runtime.jsx("div", { style: errorStyle, children: t("notifyWebDeniedHint"), key: "web-denied" }) : null
				].filter(Boolean);
			};
			const body = () => react_jsx_runtime.jsxs("div", { style: sectionStyle, children: [
				react_jsx_runtime.jsxs("div", { style: stateRowStyle, children: [
					react_jsx_runtime.jsx("span", { style: stateDot(state), "aria-hidden": true }),
					react_jsx_runtime.jsx("span", { style: labelStyle, children: `${sender} · ${checking ? t("notifyPermChecking") : t(`notifyPermState_${state}`)}` })
				] }),
				react_jsx_runtime.jsx("div", { style: hintStyle, children: t(`notifyPermReason_${host.reason ?? "unreadable"}`) }),
				react_jsx_runtime.jsx("div", { style: hintStyle, children: t("notifyPermBestEffort") }),
				react_jsx_runtime.jsx("div", { style: hintStyle, children: t("notifyPermFocusNote") }),
				...webStatus(),
				...stepBody(),
				error ? react_jsx_runtime.jsx("div", { style: errorStyle, children: `${t("notifyPermError")} ${error} ${t("notifyPermManualPath")}`, key: "error" }) : null,
				react_jsx_runtime.jsx("div", { style: hintStyle, children: `${t("notifyPermDetails")}: auth=${host.auth ?? "-"}, flags=${host.flags ?? "-"}` })
			].filter(Boolean) });
			return react_jsx_runtime.jsxs("div", { children: [
				react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
					react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: t("notifyPermissions") }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: t("notifyPermissionsHint") })
					] }),
					react_jsx_runtime.jsx(primitives.Button, { variant: "outline", size: "sm", onClick: openPanel, children: t("notifyPermissionsOpen") })
				] }),
				react_jsx_runtime.jsx(primitives.Modal, {
					open,
					onClose: closePanel,
					title: t("notifyPermTitle"),
					closeLabel: t("notifyPermClose"),
					description: t("notifyPermDescription"),
					children: open ? body() : null,
					footer: react_jsx_runtime.jsxs("div", { style: buttonRowStyle, children: [
						react_jsx_runtime.jsx(primitives.Button, { variant: "outline", disabled: checking, onClick: () => load(), children: t("notifyPermRecheck") }),
						react_jsx_runtime.jsx(primitives.Button, { variant: "primary", onClick: closePanel, children: t("notifyPermClose") })
					] })
				})
			] });
		}
		function NotifyPermissionsField(props) {
			return react_jsx_runtime.jsx(NotifyPermissionsBoundary, { t: props.t, children: react_jsx_runtime.jsx(NotifyPermissionsPanel, props) });
		}
		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under "settings.weir.page"
		// inside a ctx.effect when this chunk arrives (lib/client.js
		// registerChunkDictionaries). Pinned by test/client.test.js's dictionary
		// union pin.
		// (The entry merges every settings-batch slice into the single "settings.weir.page"
		// registration — the whole settings card tree shares one t.)
		const dictionaries = {
			en: {
				notifyPermissions: "Notification permission",
				notifyPermissionsHint: "Check whether macOS lets these notifications through, and walk through allowing them.",
				notifyPermissionsOpen: "Manage",
				notifyPermTitle: "Notification permission",
				notifyPermDescription: "Notifications are shown by DeepSeek Harness itself, so macOS has to let DeepSeek Harness notify you.",
				notifyPermClose: "Close",
				notifyPermChecking: "Checking…",
				notifyPermRecheck: "Check again",
				notifyPermBestEffort: "This check reads macOS settings that Apple does not document, so treat it as a hint. Seeing the test notification is the real proof.",
				notifyPermFocusNote: "Focus / Do Not Disturb can still hold notifications back, and it cannot be checked from here.",
				notifyPermSendTest: "Send a test notification",
				notifyPermSending: "Sending…",
				notifyPermOpenSettings: "Open notification settings",
				notifyPermOpening: "Opening…",
				notifyPermOpenHint: "In the list, find “DeepSeek Harness”, turn on “Allow notifications”, and pick the Banners or Alerts style.",
				notifyPermWaiting: "Waiting for you to allow notifications… checking every 2 seconds.",
				notifyPermConfirm: "Did you see the test notification?",
				notifyPermSeenYes: "Yes, I saw it",
				notifyPermSeenNo: "No",
				notifyPermSeen: "All set — notifications will reach you.",
				notifyPermNotSeen: "Check that Focus / Do Not Disturb is off, that DeepSeek Harness's style is Banners or Alerts, and — if the window is in front — that \"When the window is in front\" is set to Always notify. Then try again.",
				notifyPermRetry: "Start over",
				notifyPermSendAgain: "Send another test",
				notifyPermError: "Something went wrong:",
				notifyPermManualPath: "You can do this by hand: System Settings → Notifications → DeepSeek Harness.",
				notifyPermDetails: "Technical details",
				notifyPermFailed: "The permission panel failed; check the runtime log.",
				"notifyPermState_granted": "Allowed",
				"notifyPermState_denied": "Not allowed",
				"notifyPermState_unknown": "Can't tell",
				"notifyPermReason_alerts-allowed": "Alerts are allowed for DeepSeek Harness.",
				"notifyPermReason_not-allowed": "Notifications are turned off for DeepSeek Harness.",
				"notifyPermReason_no-record": "macOS has no record of DeepSeek Harness yet. Send a test notification so it shows up in the list.",
				"notifyPermReason_default": "macOS has no explicit setting for DeepSeek Harness (it uses the system default), so this can't be told from here.",
				"notifyPermReason_unreadable": "The notification settings could not be read.",
				notifyWebUnsupported: "This page has no web Notification support, so DeepSeek Harness cannot notify directly.",
				notifyWebPermission: "Web notification permission",
				notifyWebDeniedHint: "This page was blocked from showing notifications and cannot ask again. Open System Settings → Notifications → DeepSeek Harness and turn notifications on.",
				"notifyWebPerm_granted": "Allowed",
				"notifyWebPerm_denied": "Blocked",
				"notifyWebPerm_default": "Not asked yet",
			},
			zh: {
				notifyPermissions: "通知权限",
				notifyPermissionsHint: "检测 macOS 是否放行这些通知，并引导你完成授权。",
				notifyPermissionsOpen: "管理",
				notifyPermTitle: "通知权限",
				notifyPermDescription: "通知由 DeepSeek Harness 自己弹出，所以需要在 macOS 里允许 DeepSeek Harness 发送通知。",
				notifyPermClose: "关闭",
				notifyPermChecking: "检测中…",
				notifyPermRecheck: "重新检测",
				notifyPermBestEffort: "该检测读取的是苹果未公开文档化的系统设置，仅供参考；亲眼看到测试通知才是最终证明。",
				notifyPermFocusNote: "专注模式 / 勿扰仍可能拦截通知，且无法在这里检测。",
				notifyPermSendTest: "发送测试通知",
				notifyPermSending: "发送中…",
				notifyPermOpenSettings: "打开系统通知设置",
				notifyPermOpening: "打开中…",
				notifyPermOpenHint: "在列表中找到「DeepSeek Harness」，打开「允许通知」，并选择「横幅」或「提醒」样式。",
				notifyPermWaiting: "正在等你允许通知…每 2 秒自动检测一次。",
				notifyPermConfirm: "你看到测试通知了吗？",
				notifyPermSeenYes: "看到了",
				notifyPermSeenNo: "没看到",
				notifyPermSeen: "设置完成，通知会送达你。",
				notifyPermNotSeen: "请确认专注模式 / 勿扰已关闭，「DeepSeek Harness」的样式是「横幅」或「提醒」，并且（若窗口在前台）「窗口在前台时」已设为「始终通知」，然后重试。",
				notifyPermRetry: "重新开始",
				notifyPermSendAgain: "再发一条测试",
				notifyPermError: "出错了：",
				notifyPermManualPath: "也可以手动操作：系统设置 → 通知 → DeepSeek Harness。",
				notifyPermDetails: "技术细节",
				notifyPermFailed: "权限面板出错，请查看运行日志。",
				"notifyPermState_granted": "已允许",
				"notifyPermState_denied": "未允许",
				"notifyPermState_unknown": "无法判定",
				"notifyPermReason_alerts-allowed": "已允许「DeepSeek Harness」弹出提醒。",
				"notifyPermReason_not-allowed": "「DeepSeek Harness」的通知已被关闭。",
				"notifyPermReason_no-record": "macOS 里还没有「DeepSeek Harness」的记录。先发一条测试通知，让它出现在列表里。",
				"notifyPermReason_default": "macOS 里没有「DeepSeek Harness」的明确设置（沿用系统默认），无法在这里判定。",
				"notifyPermReason_unreadable": "无法读取通知设置。",
				notifyWebUnsupported: "当前页面没有网页通知能力，DeepSeek Harness 无法直接通知。",
				notifyWebPermission: "网页通知权限",
				notifyWebDeniedHint: "本页面被禁止显示通知，且无法再次询问。请打开「系统设置 → 通知 → DeepSeek Harness」并开启通知。",
				"notifyWebPerm_granted": "已允许",
				"notifyWebPerm_denied": "已禁止",
				"notifyWebPerm_default": "尚未询问",
			},
		};

		exports.dictionaries = dictionaries;
		exports.LABEL_KEYS = LABEL_KEYS;
		exports.webNotificationSupport = webNotificationSupport;
		exports.requestWebPermission = requestWebPermission;
		exports.primaryStep = primaryStep;
		exports.NotifyPermissionsBoundary = NotifyPermissionsBoundary;
		exports.NotifyPermissionsPanel = NotifyPermissionsPanel;
		exports.NotifyPermissionsField = NotifyPermissionsField;
		return module.exports;
	}
});
