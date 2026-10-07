window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.lsp-panel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// LSP service manager panel: status over the catalog + one-click
		// install + custom servers, talking to the host over raw fetch
		// ("/api/orrery-lsp/*"). The lsp model trio (client.lsp-model.js) and
		// `t` arrive via props. Style constants are verbatim copies of the
		// settings-page constants this panel uses (same-package sync require
		// is impossible in the ModuleLoader).
		const labelStyle = { fontSize: "14px", fontWeight: 500, lineHeight: "20px" };
		const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const controlsStyle = { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 };
		const chainPanelStyle = { display: "flex", flexDirection: "column", gap: "12px", padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)", marginTop: "8px" };
		const chainCategoryStyle = { fontSize: "13px", fontWeight: 600, lineHeight: "18px" };
		const chainDescStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const chainButtonStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline" };
		const chainSaveStyle = { background: "var(--dsw-alias-state-business-primary)", border: "none", cursor: "pointer", color: "#fff", borderRadius: "var(--dsw-radius-sm)", padding: "4px 14px", fontSize: "13px" };
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 0" };
		const labelGroupStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 };
		const resetStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", textDecoration: "underline", color: "var(--dsw-alias-label-secondary)" };
		const errorStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-state-danger-primary, #d33)" };
		/** Error boundary isolating the LSP manager panel from the settings page. */
		class LspManagerBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			render() {
				if (this.state.failed) {
					return react_jsx_runtime.jsx("div", { style: hintStyle, children: this.props.t?.("lspManagerFailed") ?? "LSP manager failed" });
				}
				return this.props.children;
			}
		}
		const lspServerRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "6px 0" };
		const lspDot = (on) => ({ width: "7px", height: "7px", borderRadius: "50%", display: "inline-block", background: on ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-disabled, #999)" });
		const lspInputStyle = { background: "var(--dsw-alias-interactive-bg-solid)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)", padding: "4px 8px", fontSize: "13px", minWidth: 0 };
		/** LSP service manager: status over the catalog + one-click install + custom servers. */
		function LspManagerField(props) {
			const model = props.model;
			const [open, setOpen] = react.useState(false);
			const [view, setView] = react.useState(null);
			const [confirming, setConfirming] = react.useState(null);
			const [busy, setBusy] = react.useState(null);
			const [result, setResult] = react.useState(null);
			const [customDraft, setCustomDraft] = react.useState({ family: "", command: "", args: "", installCommand: "" });
			const t = props.t;
			const canEdit = typeof props.edit === "function";
			const customEntries = model.jsonToLspServers(props.serversText);
			// Malformed stored JSON (robash precedent): the hint is visible but
			// the panel still opens with an empty custom map and saving
			// overwrites the malformed value — the field is never trapped.
			const serversInvalid = model.lspServersJsonValid(props.serversText) === false;
			const load = () => {
				setView({ status: "loading" });
				fetch("api/orrery-lsp/status", { method: "POST", credentials: "include" })
					.then((response) => response.json())
					.then((payload) => {
						setView(payload?.ok ? { status: "ready", servers: payload.value.servers } : { status: "error", message: payload?.error?.message ?? "unknown" });
					})
					.catch((error) => setView({ status: "error", message: String(error?.message ?? error) }));
			};
			const toggle = () => {
				const next = !open;
				setOpen(next);
				setConfirming(null);
				setResult(null);
				if (next) load();
			};
			const runInstall = (family) => {
				setConfirming(null);
				setBusy(family);
				setResult(null);
				fetch("api/orrery-lsp/install", {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ family })
				})
					.then((response) => response.json())
					.then((payload) => {
						setBusy(null);
						setResult(payload?.ok ? { family, output: payload.value.output, exitCode: payload.value.exitCode, timedOut: payload.value.timedOut } : { family, error: payload?.error?.message ?? "unknown" });
						if (payload?.ok) load();
					})
					.catch((error) => {
						setBusy(null);
						setResult({ family, error: String(error?.message ?? error) });
					});
			};
			const addCustomServer = () => {
				const family = customDraft.family.trim();
				const command = customDraft.command.trim();
				if (!family || !command) return;
				const install = model.splitInstallCommand(customDraft.installCommand);
				const next = {
					...customEntries,
					[family]: {
						command,
						...(customDraft.args.trim() ? { args: customDraft.args.trim().split(/\s+/).filter(Boolean) } : {}),
						...(install ? { install } : {}),
						...(install ? { installHint: customDraft.installCommand.trim() } : {}),
					},
				};
				props.edit("lspServers", model.lspServersToJson(next));
				setCustomDraft({ family: "", command: "", args: "", installCommand: "" });
			};
			const removeCustomServer = (family) => {
				const next = { ...customEntries };
				delete next[family];
				props.edit("lspServers", model.lspServersToJson(next));
				load();
			};
			const statusOf = (family) => (view?.status === "ready" ? view.servers.find((server) => server.family === family) : undefined);
			const serverRow = (server) => {
				const label = t(`lspFamily_${server.family}`);
				if (confirming === server.family) {
					return react_jsx_runtime.jsxs("div", { style: lspServerRowStyle, key: server.family, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: label }),
						react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
							react_jsx_runtime.jsx("code", { style: hintStyle, children: server.installCommand || server.installHint }),
							server.installerAvailable === false ? react_jsx_runtime.jsx("span", { style: hintStyle, children: t("lspManagerInstallerMissing") }) : null,
							react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
								react_jsx_runtime.jsx("button", { type: "button", style: chainSaveStyle, disabled: server.installerAvailable === false, onClick: () => runInstall(server.family), children: t("lspManagerConfirmInstall") }),
								react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: () => setConfirming(null), children: t("lspManagerCancel") })
							] })
						] })
					] });
				}
				const isBusy = busy === server.family;
				return react_jsx_runtime.jsxs("div", { style: lspServerRowStyle, key: server.family, children: [
					react_jsx_runtime.jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" }, children: [
						react_jsx_runtime.jsx("span", { style: lspDot(server.installed), "aria-hidden": true }),
						react_jsx_runtime.jsx("span", { style: labelStyle, children: label })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px" }, children: [
						react_jsx_runtime.jsx("span", { style: hintStyle, children: server.installed ? (server.version ?? t("lspManagerInstalled")) : t("lspManagerMissing") }),
						!server.installed && server.installCommand ? react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: isBusy, onClick: () => setConfirming(server.family), children: isBusy ? t("lspManagerInstalling") : t("lspManagerInstall") }) : null
					] })
				] });
			};
			const customRow = (family, entry) => {
				const host = statusOf(family);
				return react_jsx_runtime.jsxs("div", { style: lspServerRowStyle, key: family, children: [
					react_jsx_runtime.jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" }, children: [
						react_jsx_runtime.jsx("span", { style: lspDot(host ? host.installed : false), "aria-hidden": true }),
						react_jsx_runtime.jsx("span", { style: labelStyle, children: family }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: entry.command })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px" }, children: [
						react_jsx_runtime.jsx("span", { style: hintStyle, children: host ? (host.installed ? t("lspManagerInstalled") : t("lspManagerMissing")) : t("lspManagerPendingStatus") }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: () => removeCustomServer(family), children: t("lspManagerRemove") })
					] })
				] });
			};
			const customSection = () => {
				if (!canEdit) return null;
				return react_jsx_runtime.jsxs("div", { style: { ...chainPanelStyle, gap: "8px" }, children: [
					react_jsx_runtime.jsxs("div", { children: [
						react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: t("lspManagerCustom") }),
						" ",
						react_jsx_runtime.jsx("span", { style: chainDescStyle, children: t("lspManagerCustomHint") })
					] }),
					...Object.entries(customEntries).map(([family, entry]) => customRow(family, entry)),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }, children: [
						react_jsx_runtime.jsx("input", { type: "text", style: lspInputStyle, placeholder: t("lspManagerFamily"), value: customDraft.family, onChange: (event) => setCustomDraft({ ...customDraft, family: event.target.value }) }),
						react_jsx_runtime.jsx("input", { type: "text", style: lspInputStyle, placeholder: t("lspManagerCommand"), value: customDraft.command, onChange: (event) => setCustomDraft({ ...customDraft, command: event.target.value }) }),
						react_jsx_runtime.jsx("input", { type: "text", style: lspInputStyle, placeholder: t("lspManagerArgs"), value: customDraft.args, onChange: (event) => setCustomDraft({ ...customDraft, args: event.target.value }) }),
						react_jsx_runtime.jsx("input", { type: "text", style: lspInputStyle, placeholder: t("lspManagerInstallCmd"), value: customDraft.installCommand, onChange: (event) => setCustomDraft({ ...customDraft, installCommand: event.target.value }) }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainSaveStyle, disabled: !customDraft.family.trim() || !customDraft.command.trim(), onClick: addCustomServer, children: t("lspManagerAddServer") })
					] })
				] });
			};
			const panelBody = () => {
				if (view === null) return null;
				if (view.status === "loading") return react_jsx_runtime.jsx("div", { style: hintStyle, children: t("lspManagerLoading") });
				if (view.status === "error") {
					return react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "12px", alignItems: "center" }, children: [
						react_jsx_runtime.jsx("span", { style: hintStyle, children: `${t("lspManagerUnavailable")} ${view.message}` }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: load, children: t("lspManagerRetry") })
					] });
				}
				return react_jsx_runtime.jsxs("div", { children: [
					...(view.servers ?? []).map(serverRow),
					result ? react_jsx_runtime.jsxs("div", { style: { ...chainPanelStyle, gap: "6px" }, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: `${t(`lspFamily_${result.family}`)} — ${result.error ?? `${t("lspManagerExitCode")} ${result.exitCode ?? "?"}${result.timedOut ? ` ${t("lspManagerTimedOut")}` : ""}`}` }),
						result.output ? react_jsx_runtime.jsx("pre", { style: { ...hintStyle, whiteSpace: "pre-wrap", maxHeight: "160px", overflow: "auto" }, children: result.output }) : null
					] }) : null,
					customSection()
				] });
			};
			return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
				react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
					react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: t("lspManager") }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: t("lspManagerHint") })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: toggle, children: open ? t("chainCancel") : t("chainEdit") }),
						serversInvalid ? react_jsx_runtime.jsx("span", { style: errorStyle, children: t("lspManagerInvalidJson") }) : null,
						props.overridden ? react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
							react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: t("overridden") }),
							react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, disabled: props.disabled, onClick: props.onReset, children: t("reset") })
						] }) : null
					] })
				] }),
				open ? react_jsx_runtime.jsx(LspManagerBoundary, { t, children: panelBody() }) : null
			] });
		}
		exports.LspManagerBoundary = LspManagerBoundary;
		exports.LspManagerField = LspManagerField;
		return module.exports;
	}
});
