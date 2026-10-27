window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.mcp-manager.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		const ACCENT = "var(--dsw-alias-state-business-primary, #4176e6)";
		const SUCCESS = "var(--dsw-alias-state-success-primary, #22c55e)";
		const WARN = "var(--dsw-alias-state-warn-primary, #f59e0b)";
		const DANGER = "var(--dsw-alias-state-error-primary, #ef4444)";
		const LABEL = "var(--dsw-alias-label-primary, inherit)";
		const MUTED = "var(--dsw-alias-label-tertiary, #81858c)";
		const BORDER = "var(--dsw-alias-border-l2, rgba(127,127,127,.18))";
		const HOVER = "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))";
		const CARD = "var(--dsw-alias-bg-base, #fff)";
		const OVERLAY = "var(--dsw-alias-bg-overlay, #fff)";
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
		const S = {
			view: { position: "relative", display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 },
			toolbar: { display: "flex", gap: "5px", alignItems: "center", flexWrap: "wrap" },
			card: { display: "flex", flexDirection: "column", gap: "5px", padding: "7px", margin: "5px 0", background: CARD, border: `1px solid ${BORDER}`, borderRadius: "var(--dsw-radius-md, 8px)" },
			row: { display: "flex", gap: "6px", alignItems: "flex-start", flexWrap: "wrap" },
			name: { color: LABEL, fontWeight: 600, overflowWrap: "anywhere" },
			meta: { color: MUTED, fontSize: "11px", lineHeight: "15px", overflowWrap: "anywhere" },
			input: { width: "100%", boxSizing: "border-box", padding: "4px 7px", color: LABEL, background: CARD, border: `1px solid ${BORDER}`, borderRadius: "var(--dsw-radius-sm, 6px)", fontSize: "12px", lineHeight: "16px" },
			field: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
			error: { color: DANGER, fontSize: "11px", lineHeight: "15px" },
			warning: { color: WARN, fontSize: "11px", lineHeight: "15px" },
			button: { padding: "3px 8px", color: LABEL, background: "none", border: `1px solid ${BORDER}`, borderRadius: "var(--dsw-radius-sm, 6px)", cursor: "pointer", fontSize: "11px", lineHeight: "15px" },
			primary: { padding: "3px 10px", color: "var(--dsw-alias-bg-base, #fff)", background: ACCENT, border: `1px solid ${ACCENT}`, borderRadius: "var(--dsw-radius-sm, 6px)", cursor: "pointer", fontSize: "11px", lineHeight: "15px", fontWeight: 600 },
			disabled: { opacity: 0.5, cursor: "not-allowed" },
			tag: { display: "inline-flex", alignItems: "center", width: "fit-content", padding: "0 5px", border: `1px solid ${BORDER}`, borderRadius: "var(--dsw-radius-sm, 6px)", color: MUTED, fontSize: "10px", lineHeight: "14px", whiteSpace: "nowrap" },
			pre: { margin: 0, padding: "6px", maxHeight: "180px", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: LABEL, background: HOVER, borderRadius: "var(--dsw-radius-sm, 6px)", fontSize: "10px", lineHeight: "14px" },
			dialogShade: { position: "absolute", inset: 0, zIndex: 4, display: "flex", alignItems: "center", justifyContent: "center", padding: "12px", background: "var(--dsw-alias-bg-scrim, rgba(0,0,0,.28))" },
			dialog: { display: "flex", flexDirection: "column", gap: "8px", width: "100%", padding: "12px", color: LABEL, background: OVERLAY, border: `1px solid ${BORDER}`, borderRadius: "var(--dsw-radius-lg, 12px)", boxShadow: "var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.14))" },
		};
		const ring = {
			onFocus: (event) => { if (event?.currentTarget?.style) { event.currentTarget.style.outline = "2px solid var(--dsw-alias-focus-ring, currentColor)"; event.currentTarget.style.outlineOffset = "1px"; } },
			onBlur: (event) => { if (event?.currentTarget?.style) { event.currentTarget.style.outline = "none"; event.currentTarget.style.outlineOffset = ""; } },
		};
		const button = (label, props = {}) => react_jsx_runtime.jsx("button", {
			type: "button", ...ring, ...props,
			style: { ...(props.primary ? S.primary : S.button), ...(props.disabled ? S.disabled : {}), ...(props.style ?? {}) },
			children: label,
		});
		const tag = (label, hue) => react_jsx_runtime.jsx("span", { style: { ...S.tag, ...(hue ? { color: hue, border: `1px solid ${hue}`, background: tint(hue, 10) } : {}) }, children: label });

		class McpManagerBoundary extends react.Component {
			constructor(props) { super(props); this.state = { failed: false }; }
			static getDerivedStateFromError() { return { failed: true }; }
			render() {
				if (this.state.failed) return react_jsx_runtime.jsx("div", { role: "alert", style: S.error, children: this.props.t("capability.mcp.boundary", "MCP management could not be rendered. Other capability controls remain available.") });
				return this.props.children;
			}
		}

		function McpManagerView(props) {
			const model = props.model;
			const t = props.t;
			const listing = props.listing ?? {};
			const managed = props.managed ?? [];
			const unmanaged = props.unmanaged ?? [];
			const [editor, setEditor] = react.useState(null);
			const [confirmation, setConfirmation] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [pending, setPending] = react.useState(null);
			const origins = react.useRef({});
			const cancelButton = react.useRef(null);
			const confirmButton = react.useRef(null);
			react.useEffect(() => { if (confirmation) cancelButton.current?.focus?.(); }, [confirmation]);

			const originRef = (id) => (element) => { if (element) origins.current[id] = element; };
			const closeConfirmation = (restore = true) => {
				const origin = confirmation?.origin;
				setConfirmation(null);
				if (restore && origin) origins.current[origin]?.focus?.();
			};
			const confirmationKeys = (event) => {
				if (event.key === "Escape") { event.preventDefault(); closeConfirmation(true); return; }
				if (event.key !== "Tab") return;
				const first = cancelButton.current, second = confirmButton.current;
				if (!first || !second) return;
				event.preventDefault();
				if (event.target === first) second.focus?.(); else first.focus?.();
			};

			const refresh = async () => {
				if (typeof props.refreshAll !== "function") return null;
				const result = await props.refreshAll();
				return result?.listing ?? null;
			};
			const resultError = (result, fallback) => result?.error?.message ?? result?.error?.code ?? result?.status ?? fallback;
			const clearSecrets = (draft) => ({
				...draft,
				url: draft.urlAction === "replace" && model.mcpSensitiveUrl(draft.url) ? "" : draft.url,
				envRows: (draft.envRows ?? []).map(row => ({ ...row, value: "", action: row.configured ? "keep" : row.action })),
				headerRows: (draft.headerRows ?? []).map(row => ({ ...row, value: "", action: row.configured ? "keep" : row.action })),
				secretArgRows: (draft.secretArgRows ?? []).map(row => ({ ...row, value: "", action: row.configured ? "keep" : row.action })),
			});
			const openForm = (server, source = listing) => {
				setNotice(null);
				setEditor({ kind: "form", draft: model.mcpEditorFromServer(server, source?.mcpRegistryRevision ?? 0), advanced: false, showErrors: false, busy: false, preview: null, result: null });
			};
			const openJson = (text = "") => {
				setNotice(null);
				setEditor({ kind: "json", text, busy: false, showErrors: false, preview: null, result: null });
			};
			const updateDraft = (key, value) => setEditor(current => ({ ...current, preview: null, result: null, draft: { ...current.draft, [key]: value } }));
			const updateRows = (field, index, patch) => setEditor(current => ({
				...current, preview: null, result: null,
				draft: { ...current.draft, [field]: current.draft[field].map((row, at) => at === index ? { ...row, ...patch } : row) },
			}));
			const addRow = (field) => setEditor(current => ({
				...current,
				draft: { ...current.draft, [field]: [...current.draft[field], field === "secretArgRows" ? { index: "0", action: "replace", source: "value", ref: "", prefix: "", value: "", configured: false } : { key: "", action: "replace", source: "value", ref: "", prefix: "", value: "", configured: false }] },
			}));
			const removeRow = (field, index) => setEditor(current => ({
				...current, preview: null,
				draft: { ...current.draft, [field]: current.draft[field][index].configured
					? current.draft[field].map((row, at) => at === index ? { ...row, action: "remove", value: "" } : row)
					: current.draft[field].filter((_, at) => at !== index) },
			}));

			const previewForm = async () => {
				if (!editor || editor.kind !== "form" || editor.busy || typeof props.mcpPreview !== "function") return;
				const errors = model.mcpEditorErrorsOf(editor.draft);
				if (Object.keys(errors).length > 0) { setEditor({ ...editor, showErrors: true, result: null }); return; }
				let config;
				try { config = model.mcpConfigFromEditor(editor.draft); }
				catch (cause) { setEditor({ ...editor, showErrors: true, result: { status: "validation-failed", error: { message: cause.message } } }); return; }
				setEditor({ ...editor, busy: true, result: null });
				try {
					const response = await props.mcpPreview(props.sessionId, { action: "preview", mode: editor.draft.mode, identity: editor.draft.identity, config, surface: "ui" });
					setEditor(current => current?.kind !== "form" ? current : response?.status === "preview"
						? { ...current, busy: false, preview: { response, config, secretBearing: model.mcpEditorHasSecrets(current.draft) }, result: null }
						: { ...current, busy: false, result: response ?? { status: "validation-failed" }, preview: null });
				} catch (cause) { setEditor(current => ({ ...current, busy: false, result: { status: "call-failed", error: { message: String(cause) } }, preview: null })); }
			};

			const executeForm = async (namespaceConfirmed = false) => {
				if (!editor?.preview || editor.busy || typeof props.mcpMutate !== "function") return;
				const draft = editor.draft;
				const currentName = draft.serverName || draft.identity;
				if (!namespaceConfirmed && draft.mode === "edit" && draft.originalServerName !== currentName) {
					setConfirmation({ kind: "namespace", identity: draft.identity, from: draft.originalServerName, to: currentName, origin: "form-confirm" });
					return;
				}
				const { response, config } = editor.preview;
				setEditor({ ...editor, busy: true, result: null });
				try {
					const result = await props.mcpMutate(props.sessionId, {
						action: draft.mode, identity: draft.identity, config,
						expectedRevision: response.registryRevision,
						targetFingerprint: response.targets?.[0]?.fingerprint ?? null,
						confirmNamespaceChange: namespaceConfirmed,
					});
					if (result?.status === "mounted") { setNotice(result); setEditor(null); await refresh(); return; }
					setEditor(current => ({
						...current, busy: false, result,
						preview: ["revision-conflict", "conflict", "owner-changed", "indeterminate"].includes(result?.status) ? null : current.preview,
						draft: clearSecrets(current.draft),
					}));
					if (result?.saved) await refresh();
				} catch (cause) { setEditor(current => ({ ...current, busy: false, result: { status: "call-failed", error: { message: String(cause) } }, draft: clearSecrets(current.draft) })); }
			};

			const testForm = async () => {
				if (!editor?.preview || editor.busy || typeof props.mcpMutate !== "function") return;
				const { response, config } = editor.preview;
				setEditor({ ...editor, busy: true, result: null });
				try {
					const result = await props.mcpMutate(props.sessionId, {
						action: "test", mode: editor.draft.mode, identity: editor.draft.identity, config,
						expectedRevision: response.registryRevision, targetFingerprint: response.targets?.[0]?.fingerprint ?? null,
					});
					setEditor(current => ({ ...current, busy: false, result, draft: clearSecrets(current.draft) }));
				} catch (cause) { setEditor(current => ({ ...current, busy: false, result: { status: "call-failed", error: { message: String(cause) } }, draft: clearSecrets(current.draft) })); }
			};

			const previewJson = async () => {
				if (!editor || editor.kind !== "json" || editor.busy || typeof props.mcpPreview !== "function") return;
				const guarded = model.mcpJsonGuard(editor.text);
				if (!guarded.ok) { setEditor({ ...editor, showErrors: true, result: { status: "validation-failed", error: { code: guarded.code, message: guarded.code } }, preview: null }); return; }
				setEditor({ ...editor, busy: true, result: null });
				try {
					const response = await props.mcpPreview(props.sessionId, { action: "preview", mode: "add", document: editor.text, surface: "ui" });
					setEditor(current => current?.kind !== "json" ? current : response?.status === "preview"
						? { ...current, busy: false, preview: { response, secretBearing: model.mcpDocumentHasSecrets(current.text) || model.mcpPreviewHasSecrets(response) }, result: null }
						: { ...current, busy: false, preview: null, result: response });
				} catch (cause) { setEditor(current => ({ ...current, busy: false, preview: null, result: { status: "call-failed", error: { message: String(cause) } } })); }
			};
			const executeJson = async () => {
				if (!editor?.preview || editor.busy || typeof props.mcpBatch !== "function") return;
				setConfirmation({ kind: "batch", count: editor.preview.response.plan?.length ?? 0, digest: editor.preview.response.digest, origin: "batch-confirm" });
			};
			const executeBatch = async () => {
				closeConfirmation(false);
				setEditor(current => ({ ...current, busy: true, result: null }));
				try {
					const result = await props.mcpBatch(props.sessionId, { mode: "add", document: editor.text, surface: "ui" });
					setEditor(current => ({ ...current, busy: false, result, preview: null }));
					if (result?.status === "mounted") { setNotice(result); setEditor(null); }
					await refresh();
				} catch (cause) { setEditor(current => ({ ...current, busy: false, result: { status: "call-failed", error: { message: String(cause) } }, preview: null })); }
			};
			const retryItem = async (item) => {
				if (item.saved) {
					const latest = await refresh();
					const source = latest ?? listing;
					const server = (source?.mcpServers ?? []).find(row => row.identity === item.identity);
					if (server) openForm(server, source);
					return;
				}
				const entry = model.mcpDocumentEntryOf(editor.text, item.identity);
				if (entry) openJson(JSON.stringify(entry, null, 2));
			};

			const rowOperation = async (action, server) => {
				if (pending || typeof props.mcpMutate !== "function") return;
				setPending(`${action}:${server.identity}`);
				setNotice(null);
				try {
					const result = await props.mcpMutate(props.sessionId, {
						action, identity: server.identity, expectedRevision: listing.mcpRegistryRevision ?? 0,
						targetFingerprint: server.fingerprint,
						...(action === "setDefault" ? { enabled: !server.defaultEnabled } : {}),
					});
					setNotice(result);
					await refresh();
				} catch (cause) { setNotice({ status: "call-failed", error: { message: String(cause) } }); }
				finally { setPending(null); }
			};
			const confirmAction = async () => {
				if (confirmation?.kind === "remove") {
					const server = managed.find(row => row.identity === confirmation.identity);
					closeConfirmation(false);
					if (server) await rowOperation("remove", server);
				} else if (confirmation?.kind === "namespace") {
					closeConfirmation(false);
					await executeForm(true);
				} else if (confirmation?.kind === "batch") await executeBatch();
			};

			const field = (key, label, options = {}) => {
				const error = editor?.showErrors ? model.mcpEditorErrorsOf(editor.draft)[key] : undefined;
				return react_jsx_runtime.jsxs("label", { style: S.field, children: [
					react_jsx_runtime.jsx("span", { style: S.meta, children: label }),
					react_jsx_runtime.jsx("input", {
						style: S.input, value: editor.draft[key] ?? "", placeholder: label, "aria-label": label,
						type: options.type ?? "text", disabled: editor.busy || (key === "identity" && editor.draft.mode === "edit"),
						"aria-invalid": error ? true : undefined, ...ring,
						onChange: event => updateDraft(key, event.target.value),
					}),
					error ? react_jsx_runtime.jsx("span", { style: S.error, children: `${label}: ${error}` }) : null,
				] }, key);
			};
			const secretRows = (field, title) => {
				const rows = editor.draft[field] ?? [];
				const errors = editor.showErrors ? model.mcpEditorErrorsOf(editor.draft) : {};
				return react_jsx_runtime.jsxs("div", { style: S.field, children: [
					react_jsx_runtime.jsx("span", { style: S.meta, children: title }),
					...rows.map((row, index) => {
						const key = field === "secretArgRows" ? row.index : row.key;
						const rowError = errors[`${field === "secretArgRows" ? "args" : field === "envRows" ? "env" : "headers"}.${index}`];
						return react_jsx_runtime.jsxs("div", { style: { ...S.card, gap: "4px" }, children: [
							react_jsx_runtime.jsxs("div", { style: S.row, children: [
								react_jsx_runtime.jsx("input", {
									style: { ...S.input, flex: 1 }, value: key ?? "", disabled: editor.busy || row.configured,
									"aria-label": field === "secretArgRows" ? t("capability.mcp.secretArgIndex", "argument index") : t("capability.mcp.secretKey", "secret key"),
									onChange: event => updateRows(field, index, field === "secretArgRows" ? { index: event.target.value } : { key: event.target.value }),
								}),
								react_jsx_runtime.jsxs("select", {
									style: { ...S.input, width: "auto" }, value: row.action, disabled: editor.busy,
									"aria-label": t("capability.mcp.secretAction", "secret action"),
									onChange: event => updateRows(field, index, { action: event.target.value }),
									children: [
										react_jsx_runtime.jsx("option", { value: "keep", children: t("capability.mcp.keep", "keep") }),
										react_jsx_runtime.jsx("option", { value: "replace", children: t("capability.mcp.replace", "replace") }),
										react_jsx_runtime.jsx("option", { value: "remove", children: t("capability.mcp.removeSecret", "remove") }),
									],
								}),
								react_jsx_runtime.jsxs("select", {
									style: { ...S.input, width: "auto" }, value: row.source, disabled: editor.busy || row.action === "remove",
									"aria-label": t("capability.mcp.secretSource", "secret source"),
									onChange: event => updateRows(field, index, { source: event.target.value, action: row.configured ? "replace" : row.action }),
									children: [
										react_jsx_runtime.jsx("option", { value: "value", children: t("capability.mcp.secretValueSource", "new value") }),
										react_jsx_runtime.jsx("option", { value: "ref", children: t("capability.mcp.secretRefSource", "credential ref") }),
									],
								}),
								button(t("capability.mcp.removeRow", "Remove row"), { disabled: editor.busy, onClick: () => removeRow(field, index) }),
							] }),
							row.source === "ref"
								? react_jsx_runtime.jsx("input", {
									style: S.input, value: row.ref ?? "", disabled: editor.busy || row.action === "keep" || row.action === "remove",
									placeholder: "CREDENTIAL_REF", "aria-label": t("capability.mcp.ref", "credential reference"), ...ring,
									onChange: event => updateRows(field, index, { ref: event.target.value, action: row.configured ? "replace" : row.action }),
								})
								: react_jsx_runtime.jsx("input", {
									style: S.input, value: row.value ?? "", type: "password", autoComplete: "off",
									disabled: editor.busy || row.action === "keep" || row.action === "remove",
									placeholder: row.configured ? t("capability.mcp.secretBlankKeep", "blank keeps the configured secret") : t("capability.mcp.secretValue", "secret value"),
									"aria-label": t("capability.mcp.secretValue", "secret value"), ...ring,
									onChange: event => updateRows(field, index, { value: event.target.value, action: "replace" }),
								}),
							react_jsx_runtime.jsx("input", {
								style: S.input, value: row.prefix ?? "", disabled: editor.busy || row.action === "remove",
								placeholder: t("capability.mcp.prefix", "optional non-secret prefix"), "aria-label": t("capability.mcp.prefix", "optional non-secret prefix"), ...ring,
								onChange: event => updateRows(field, index, { prefix: event.target.value, prefixDirty: true, action: row.configured && row.action === "keep" ? "replace" : row.action }),
							}),
							rowError ? react_jsx_runtime.jsx("span", { style: S.error, children: rowError }) : null,
						] }, `${field}:${index}`);
					}),
					button(t("capability.mcp.addSecret", "+ Add secret/reference"), { disabled: editor.busy, onClick: () => addRow(field) }),
				] });
			};

			const resultView = (result) => {
				if (!result) return null;
				const failed = result.status !== "mounted" && result.status !== "saved" && result.status !== "removed";
				return react_jsx_runtime.jsxs("div", { role: failed ? "alert" : "status", style: { ...S.card, borderColor: failed ? DANGER : SUCCESS }, children: [
					react_jsx_runtime.jsxs("div", { style: S.row, children: [
						tag(result.status, failed ? DANGER : SUCCESS),
						result.saved === true ? tag(t("capability.mcp.saved", "saved")) : null,
						result.notAttempted === true || result.status === "not-attempted" ? tag(t("capability.mcp.notAttempted", "not attempted"), WARN) : null,
						result.generation != null ? tag(`generation ${result.generation}`) : null,
						result.defaultRemoved === true ? tag(t("capability.mcp.defaultRemoved", "default removed"), WARN) : null,
					] }),
					result.discovery ? react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.discovery", "Discovery: {count} tool(s)").replace("{count}", String(result.discovery.toolCount ?? "?")) }) : null,
					result.error ? react_jsx_runtime.jsxs("div", { style: S.error, children: [
						react_jsx_runtime.jsx("div", { children: result.error.message ?? result.error.code }),
						result.error.hint ? react_jsx_runtime.jsx("div", { children: result.error.hint }) : null,
					] }) : null,
					result.atomic === false ? react_jsx_runtime.jsx("span", { style: S.warning, children: t("capability.mcp.nonAtomic", "Batch results are per server; no atomic rollback is claimed.") }) : null,
				] });
			};
			const previewView = (preview, secretBearing) => {
				if (!preview) return null;
				const response = preview.response ?? preview;
				const unsupported = model.mcpPreviewSupportOf(response, secretBearing ?? preview.secretBearing);
				const targets = response.targets ?? [];
				return react_jsx_runtime.jsxs("div", { style: S.card, children: [
					react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.planDigest", "Plan digest: {digest}").replace("{digest}", response.digest ?? "unknown") }),
					react_jsx_runtime.jsx("pre", { style: S.pre, children: JSON.stringify(response.plan ?? [], null, 2) }),
					...targets.filter(target => target.conflict || target.namespaceConflict).map(target => react_jsx_runtime.jsx("span", { style: S.error, children: `${target.identity}: ${target.conflict ?? target.namespaceConflict}` }, target.identity)),
					...unsupported.map(code => react_jsx_runtime.jsx("span", { style: S.error, children: t(`capability.mcp.${code}`, code) }, code)),
				] });
			};

			const formEditor = () => {
				const draft = editor.draft;
				const errors = editor.showErrors ? model.mcpEditorErrorsOf(draft) : {};
				const namespaceChanged = draft.mode === "edit" && draft.originalServerName !== (draft.serverName || draft.identity);
				const unsupported = editor.preview ? model.mcpPreviewSupportOf(editor.preview.response, editor.preview.secretBearing) : [];
				const conflict = editor.preview?.response?.targets?.[0]?.conflict || editor.preview?.response?.targets?.[0]?.namespaceConflict;
				return react_jsx_runtime.jsxs("div", { style: S.card, children: [
					react_jsx_runtime.jsxs("div", { style: S.toolbar, children: [
						react_jsx_runtime.jsx("strong", { style: S.name, children: draft.mode === "edit" ? t("capability.mcp.editTitle", "Edit MCP server") : t("capability.mcp.addTitle", "Add managed MCP server") }),
						tag(draft.transport),
					] }),
					react_jsx_runtime.jsxs("div", { style: S.row, children: [
						react_jsx_runtime.jsxs("select", {
							style: { ...S.input, width: "auto" }, value: draft.transport, disabled: editor.busy || draft.mode === "edit",
							"aria-label": t("capability.mcp.transport", "transport"),
							onChange: event => updateDraft("transport", event.target.value),
							children: [
								react_jsx_runtime.jsx("option", { value: "stdio", children: "stdio" }),
								react_jsx_runtime.jsx("option", { value: "streamable-http", children: "streamable-http" }),
							],
						}),
						button(editor.advanced ? t("capability.mcp.basic", "Basic") : t("capability.mcp.advanced", "Advanced"), { disabled: editor.busy, "aria-expanded": editor.advanced, onClick: () => setEditor({ ...editor, advanced: !editor.advanced }) }),
					] }),
					field("identity", t("capability.mcp.identity", "identity (e.g. my-docs)")),
					field("label", t("capability.mcp.label", "label (display name, optional)")),
					field("serverName", t("capability.mcp.serverName", "public server name")),
					draft.transport === "stdio" ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
						field("command", t("capability.mcp.command", "command (e.g. npx)")),
						field("argsText", t("capability.mcp.argsJson", "args (JSON array or space-separated)")),
						editor.advanced ? field("cwd", t("capability.mcp.cwd", "working directory (optional)")) : null,
					] }) : react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
						draft.urlMode === "legacy" && draft.urlAction === "keep"
							? react_jsx_runtime.jsxs("div", { style: S.row, children: [
								react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.sensitiveConfigured", "Sensitive URL configured; its value is hidden.") }),
								button(t("capability.mcp.replace", "replace"), { disabled: editor.busy, onClick: () => setEditor({ ...editor, preview: null, draft: { ...draft, urlMode: "literal", urlAction: "replace", url: "" } }) }),
							] })
							: react_jsx_runtime.jsxs("div", { style: S.field, children: [
								react_jsx_runtime.jsxs("div", { style: S.row, children: [
									react_jsx_runtime.jsxs("select", {
										style: { ...S.input, width: "auto" }, value: draft.urlMode, disabled: editor.busy,
										"aria-label": t("capability.mcp.urlMode", "URL source"),
										onChange: event => setEditor({ ...editor, preview: null, draft: { ...draft, urlMode: event.target.value, urlAction: "replace" } }),
										children: [
											react_jsx_runtime.jsx("option", { value: "literal", children: t("capability.mcp.urlLiteral", "URL") }),
											react_jsx_runtime.jsx("option", { value: "ref", children: t("capability.mcp.secretRefSource", "credential ref") }),
										],
									}),
									draft.urlAction === "keep" ? tag(t("capability.mcp.keep", "keep")) : null,
								] }),
								draft.urlMode === "ref"
									? react_jsx_runtime.jsx("input", { style: S.input, value: draft.urlRef, disabled: editor.busy, placeholder: "PRIVATE_MCP_URL", "aria-label": t("capability.mcp.urlRef", "URL credential reference"), ...ring, onChange: event => setEditor({ ...editor, preview: null, draft: { ...draft, urlRef: event.target.value, urlAction: "replace" } }) })
									: react_jsx_runtime.jsx("input", { style: S.input, value: draft.url, disabled: editor.busy, placeholder: "https://example.test/mcp", "aria-label": t("capability.mcp.url", "MCP URL"), ...ring, onChange: event => setEditor({ ...editor, preview: null, draft: { ...draft, url: event.target.value, urlAction: "replace" } }) }),
								errors.url ? react_jsx_runtime.jsx("span", { style: S.error, children: errors.url }) : null,
							] }),
					] }),
					editor.advanced ? react_jsx_runtime.jsxs("div", { style: S.field, children: [
						field("toolCallTimeoutMs", t("capability.mcp.timeout", "per-call timeout (ms)"), { type: "number" }),
						field("maxInstructionBytes", t("capability.mcp.instructionLimit", "instruction limit (bytes)"), { type: "number" }),
						draft.transport === "stdio" ? secretRows("envRows", t("capability.mcp.env", "environment secrets / references")) : secretRows("headerRows", t("capability.mcp.headers", "HTTP header secrets / references")),
						draft.transport === "stdio" ? secretRows("secretArgRows", t("capability.mcp.secretArgs", "secret argument values / references")) : null,
						react_jsx_runtime.jsxs("label", { style: S.row, children: [
							react_jsx_runtime.jsx("input", { type: "checkbox", checked: draft.reconnectEnabled, disabled: editor.busy, onChange: event => setEditor({ ...editor, preview: null, draft: { ...draft, reconnectConfigured: true, reconnectEnabled: event.target.checked } }) }),
							react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.reconnect", "enable reconnect") }),
						] }),
						field("reconnectInitialDelayMs", t("capability.mcp.reconnectInitial", "reconnect initial delay (ms)"), { type: "number" }),
						field("reconnectMaxDelayMs", t("capability.mcp.reconnectMax", "reconnect maximum delay (ms)"), { type: "number" }),
						field("reconnectMaxAttempts", t("capability.mcp.reconnectAttempts", "reconnect maximum attempts"), { type: "number" }),
						errors.reconnect ? react_jsx_runtime.jsx("span", { style: S.error, children: errors.reconnect }) : null,
					] }) : null,
					namespaceChanged ? react_jsx_runtime.jsx("span", { style: S.warning, children: t("capability.mcp.namespacePending", "The public namespace changes; separate confirmation is required.") }) : null,
					previewView(editor.preview),
					resultView(editor.result),
					react_jsx_runtime.jsxs("div", { style: S.toolbar, children: [
						button(t("capability.mcp.preview", "Preview"), { disabled: editor.busy, onClick: previewForm }),
						editor.preview ? button(t("capability.mcp.confirm", "Confirm"), { primary: true, disabled: editor.busy || unsupported.length > 0 || Boolean(conflict), ref: originRef("form-confirm"), onClick: () => executeForm(false) }) : null,
						editor.preview ? button(t("capability.mcp.test", "Test"), { disabled: editor.busy || unsupported.length > 0 || Boolean(conflict), onClick: testForm }) : null,
						button(t("capability.mcp.cancel", "Cancel"), { disabled: editor.busy, onClick: () => setEditor(null) }),
					] }),
				] });
			};

			const jsonEditor = () => {
				const unsupported = editor.preview ? model.mcpPreviewSupportOf(editor.preview.response, editor.preview.secretBearing) : [];
				const items = model.mcpBatchItemsOf(editor.result);
				return react_jsx_runtime.jsxs("div", { style: S.card, children: [
					react_jsx_runtime.jsx("strong", { style: S.name, children: t("capability.mcp.pasteTitle", "Paste MCP JSON (single or mcpServers batch)") }),
					react_jsx_runtime.jsx("textarea", {
						style: { ...S.input, minHeight: "110px", fontFamily: "var(--dsw-font-mono, monospace)" },
						value: editor.text, disabled: editor.busy, "aria-label": t("capability.mcp.pasteLabel", "MCP JSON document"), ...ring,
						onChange: event => setEditor({ ...editor, text: event.target.value, preview: null, result: null }),
					}),
					editor.showErrors && model.mcpJsonGuard(editor.text).code === "document-too-large" ? react_jsx_runtime.jsx("span", { style: S.error, children: t("capability.mcp.tooLarge", "JSON exceeds the 1 MiB limit; no preview or write occurred.") }) : null,
					previewView(editor.preview),
					resultView(editor.result),
					items.length > 0 ? react_jsx_runtime.jsxs("div", { style: S.field, children: items.map(item => react_jsx_runtime.jsxs("div", { style: S.card, children: [
						react_jsx_runtime.jsxs("div", { style: S.row, children: [
							react_jsx_runtime.jsx("strong", { style: S.name, children: item.identity }),
							tag(item.status, item.succeeded ? SUCCESS : DANGER),
							item.saved ? tag(t("capability.mcp.saved", "saved")) : null,
							item.notAttempted ? tag(t("capability.mcp.notAttempted", "not attempted"), WARN) : null,
						] }),
						item.error ? react_jsx_runtime.jsx("span", { style: S.error, children: item.error.message ?? item.error.code }) : null,
						!item.succeeded ? button(t("capability.mcp.retryEdit", "Retry / edit"), { onClick: () => retryItem(item) }) : null,
					] }, item.identity)) }) : null,
					react_jsx_runtime.jsxs("div", { style: S.toolbar, children: [
						button(t("capability.mcp.preview", "Preview"), { disabled: editor.busy, onClick: previewJson }),
						editor.preview ? button(t("capability.mcp.confirmBatch", "Confirm batch"), { primary: true, disabled: editor.busy || unsupported.length > 0, ref: originRef("batch-confirm"), onClick: executeJson }) : null,
						button(t("capability.mcp.cancel", "Cancel"), { disabled: editor.busy, onClick: () => setEditor(null) }),
					] }),
				] });
			};

			const serverRow = (server) => {
				const identity = server.identity;
				const selected = props.draft?.mcpServers?.includes(identity) === true;
				const state = model.mcpStateOf(server);
				const discovery = server.discovery?.toolCount;
				// Row lifecycle actions stay disabled while an editor action (Preview/
				// Confirm/Test) is in flight; the Host serializes same-identity work too.
				const rowBusy = pending !== null || editor?.busy === true;
				return react_jsx_runtime.jsxs("div", { style: S.card, children: [
					react_jsx_runtime.jsxs("div", { style: S.row, children: [
						react_jsx_runtime.jsx("input", {
							type: "checkbox", checked: selected, disabled: props.selectionDisabled || pending !== null,
							"aria-label": t("capability.mcp.selectSession", "Select {identity} for this session").replace("{identity}", identity),
							onChange: () => props.toggle("mcpServers", identity),
						}),
						react_jsx_runtime.jsx("strong", { style: S.name, children: server.label ?? identity }),
						tag(state, state === "mounted" ? SUCCESS : state === "degraded" || state === "conflict" ? DANGER : undefined),
						server.defaultEnabled ? tag(t("capability.mcp.default", "default")) : null,
						selected ? tag(t("capability.mcp.selected", "selected")) : null,
					] }),
					react_jsx_runtime.jsx("span", { style: S.meta, children: `${identity} · ${server.serverName ?? identity} · ${server.transport ?? "unknown"}` }),
					react_jsx_runtime.jsx("span", { style: S.meta, children: `incarnation ${server.incarnation ?? "legacy"} · generation ${server.generation ?? "?"}` }),
					react_jsx_runtime.jsx("span", { style: S.meta, children: discovery == null ? t("capability.mcp.toolsUnknown", "Tools: unknown") : t("capability.mcp.toolsCount", "Tools: {count}").replace("{count}", String(discovery)) }),
					react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.liveUnknown", "Live reconnect/process/stderr: unknown") }),
					server.lastMount ? react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.lastMount", "Last mount: {status} / generation {generation}").replace("{status}", server.lastMount.status ?? "unknown").replace("{generation}", String(server.lastMount.generation ?? "?")) }) : null,
					server.lastTest ? react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.lastTest", "Last test: {status}").replace("{status}", server.lastTest.status ?? "unknown") }) : null,
					server.lastMount?.diagnostic?.message ? react_jsx_runtime.jsx("span", { style: S.error, children: server.lastMount.diagnostic.message }) : null,
					server.lastTest?.diagnostic?.message ? react_jsx_runtime.jsx("span", { style: S.error, children: server.lastTest.diagnostic.message }) : null,
					(server.startErrors ?? []).map((error, index) => react_jsx_runtime.jsx("span", { style: S.error, children: error.reason }, index)),
					react_jsx_runtime.jsxs("div", { style: S.toolbar, children: [
						button(t("capability.mcp.edit", "Edit"), { disabled: rowBusy, onClick: () => openForm(server) }),
						button(t("capability.mcp.restart", "Restart"), { disabled: rowBusy, onClick: () => rowOperation("restart", server) }),
						button(server.defaultEnabled ? t("capability.mcp.defaultOff", "Disable default") : t("capability.mcp.defaultOn", "Enable default"), { disabled: rowBusy, onClick: () => rowOperation("setDefault", server) }),
						button(t("capability.mcp.remove", "Remove"), { disabled: rowBusy, ref: originRef(`remove:${identity}`), onClick: () => setConfirmation({ kind: "remove", identity, origin: `remove:${identity}` }) }),
						pending?.endsWith(`:${identity}`) ? react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.pending", "Pending…") }) : null,
					] }),
				] }, identity);
			};

			const dialog = confirmation ? react_jsx_runtime.jsx("div", { style: S.dialogShade, children: react_jsx_runtime.jsxs("div", {
				role: "dialog", "aria-modal": "true", "aria-labelledby": "weir-mcp-confirm-title", style: S.dialog, onKeyDown: confirmationKeys,
				children: [
					react_jsx_runtime.jsx("strong", { id: "weir-mcp-confirm-title", style: S.name, children: confirmation.kind === "remove" ? t("capability.mcp.removeTitle", "Remove MCP server?") : confirmation.kind === "namespace" ? t("capability.mcp.namespaceTitle", "Change public namespace?") : t("capability.mcp.batchTitle", "Install this MCP batch?") }),
					react_jsx_runtime.jsx("span", { style: S.meta, children: confirmation.kind === "remove"
						? t("capability.mcp.removeConfirm", "Remove {identity}, close admission, await disposal, and remove its new-session default. Draft and accepted session selections are not rewritten.").replace("{identity}", confirmation.identity)
						: confirmation.kind === "namespace"
							? t("capability.mcp.namespaceConfirm", "Change public serverName from {from} to {to}? Existing tool names and calls change after the strict replacement is ready.").replace("{from}", confirmation.from).replace("{to}", confirmation.to)
							: t("capability.mcp.batchConfirm", "Probe and install {count} server(s) independently using digest {digest}. Results may be partial; there is no atomic rollback.").replace("{count}", String(confirmation.count)).replace("{digest}", confirmation.digest ?? "unknown") }),
					react_jsx_runtime.jsxs("div", { style: S.toolbar, children: [
						button(t("capability.mcp.cancel", "Cancel"), { ref: cancelButton, onClick: () => closeConfirmation(true) }),
						button(confirmation.kind === "remove" ? t("capability.mcp.removeConfirmButton", "Remove server") : t("capability.mcp.confirm", "Confirm"), { primary: true, ref: confirmButton, onClick: confirmAction }),
					] }),
				],
			}) }) : null;

			return react_jsx_runtime.jsxs("div", { style: S.view, children: [
				react_jsx_runtime.jsxs("div", { style: S.toolbar, children: [
					button(t("capability.mcp.add", "+ Add managed MCP server"), { disabled: editor !== null, onClick: () => openForm(null) }),
					button(t("capability.mcp.pasteJson", "Paste JSON"), { disabled: editor !== null, onClick: () => openJson() }),
					button(t("capability.mcp.refresh", "Refresh"), { disabled: pending !== null, onClick: refresh }),
					listing.stale ? tag(t("capability.mcp.stale", "stale — last good inventory"), WARN) : null,
				] }),
				listing.mcpUnavailable ? react_jsx_runtime.jsx("div", { role: "alert", style: S.error, children: t("capability.mcp.unavailableRegistry", "MCP registry unavailable: {status}. Last-good rows, when present, are stale.").replace("{status}", listing.mcpUnavailable.status ?? "unknown") }) : null,
				(listing.mcpWarnings ?? []).map((warning, index) => react_jsx_runtime.jsx("span", { style: S.warning, children: String(warning) }, index)),
				notice ? resultView(notice) : null,
				editor?.kind === "form" ? formEditor() : editor?.kind === "json" ? jsonEditor() : null,
				managed.length > 0 ? react_jsx_runtime.jsxs("div", { style: S.card, children: [
					react_jsx_runtime.jsxs("div", { style: S.row, children: [
						react_jsx_runtime.jsx("strong", { style: S.name, children: t("capability.mcp.groupManaged", "Weir managed") }),
						tag(String(managed.length)),
					] }),
					...managed.map(serverRow),
				] }) : null,
				unmanaged.length > 0 ? react_jsx_runtime.jsxs("div", { style: S.card, children: [
					react_jsx_runtime.jsxs("div", { style: S.row, children: [
						react_jsx_runtime.jsx("strong", { style: S.name, children: t("capability.mcp.groupUnmanaged", "Unmanaged") }),
						tag(String(unmanaged.length)),
					] }),
					...unmanaged.map(server => react_jsx_runtime.jsxs("div", { style: S.row, children: [
						react_jsx_runtime.jsx("span", { style: S.name, children: server.serverName ?? "unknown" }),
						tag(t("capability.unmanaged", "unmanaged")),
						react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.unmanagedHint", "Configured outside Weir; read-only in this iteration.") }),
					] }, server.serverName ?? "unknown")),
				] }) : null,
				managed.length === 0 && unmanaged.length === 0 && !listing.mcpUnavailable ? react_jsx_runtime.jsx("span", { style: S.meta, children: t("capability.mcp.none", "No MCP servers configured.") }) : null,
				dialog,
			] });
		}

		exports.McpManagerBoundary = McpManagerBoundary;
		exports.McpManagerView = McpManagerView;
		return module.exports;
	}
});
