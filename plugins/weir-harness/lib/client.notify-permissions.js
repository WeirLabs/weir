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
		// "api/weir-notify/permissions/*"; this chunk only renders the answer
		// and calls the two whitelisted actions. The entry renders NOTHING until
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
		function post(path, body) {
			return fetch(path, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {})
			}).then((response) => response.json());
		}
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
				return post(STATUS_PATH).then((payload) => {
					setChecking(false);
					if (payload?.ok && payload.value?.supported) {
						setHost(payload.value);
						setError(null);
						return payload.value;
					}
					setError(payload?.error?.message ?? "unknown");
					return null;
				}).catch((failure) => {
					setChecking(false);
					setError(messageOf(failure));
					return null;
				});
			};
			react.useEffect(() => {
				post(STATUS_PATH).then(
					(payload) => setHost(payload?.ok && payload.value?.supported ? payload.value : { supported: false }),
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
				ready.then(() => post(ACTION_PATH, { action })).then((payload) => {
					setBusy(null);
					if (!payload?.ok) {
						setError(payload?.error?.message ?? "unknown");
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
