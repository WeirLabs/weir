window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.capability-presets.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Presets & workspace-default view (laziest chunk) ----
		// Pulled only when the manager's Presets view is selected (D3): preset
		// list grouped global/workspace, save form with the rename/replace/
		// cancel name-conflict decision, load-into-draft staging (Apply stays
		// the only path that changes the applied set), delete with an inline
		// confirm row, a read-only export JSON viewer with clipboard copy, an
		// import box with categorized feedback (bound / unresolved / rejected
		// reason), and the workspace-default section with count-naming
		// confirmations. Every categorization comes from the pure model; this
		// chunk renders and forwards the composition root's verbs.
		const sectionStyle = { marginTop: "10px" };
		const sectionTitleStyle = {
			fontSize: "11px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-secondary, #888)",
			margin: "0 0 4px"
		};
		const rowStyle = { display: "flex", alignItems: "center", gap: "6px", padding: "3px 0", flexWrap: "wrap" };
		const nameTextStyle = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "none", maxWidth: "55%" };
		const summaryStyle = { fontSize: "11px", color: "var(--dsw-alias-label-secondary, #888)", flex: 1, minWidth: "80px" };
		const hintStyle = { fontSize: "11px", color: "var(--dsw-alias-label-secondary, #888)", padding: "2px 0" };
		const warnTextStyle = { fontSize: "11px", color: "var(--dsw-alias-state-warn-primary, #c80)" };
		const noticeStyle = { fontSize: "11px", color: "var(--dsw-alias-state-success-primary, #2a7d2a)", padding: "2px 0" };
		const boxStyle = {
			display: "flex",
			flexDirection: "column",
			gap: "4px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			padding: "6px",
			margin: "4px 0"
		};
		const inputStyle = { width: "100%", boxSizing: "border-box", fontSize: "12px" };
		const textareaStyle = {
			...inputStyle,
			fontFamily: "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)",
			minHeight: "96px",
			resize: "vertical",
			whiteSpace: "pre"
		};
		const buttonRowStyle = { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" };
		const linkButtonStyle = {
			fontSize: "11px",
			padding: "1px 6px",
			cursor: "pointer",
			background: "none",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			color: "var(--dsw-alias-label-secondary, #888)"
		};
		function CapabilityPresetsView(props) {
			const model = props.model;
			// Echo-guard: an unregistered dictionary entry surfaces the in-code
			// fallback, never the raw key.
			const t = (key, fallback) => {
				const value = typeof props.t === "function" ? props.t(key, fallback) : undefined;
				return value && value !== key ? value : fallback;
			};
			const [list, setList] = react.useState(null);
			const [defaultRes, setDefaultRes] = react.useState(null);
			const [saveForm, setSaveForm] = react.useState({ open: false, name: "", scope: "workspace", from: "draft", busy: false, error: null, conflict: null });
			const [importBox, setImportBox] = react.useState({ open: false, text: "", scope: "workspace", busy: false, feedback: null, document: null });
			const [rowAction, setRowAction] = react.useState(null);
			const [defaultBox, setDefaultBox] = react.useState({ confirm: null, from: "draft", busy: false, error: null });
			const [notice, setNotice] = react.useState(null);
			const presetListOf = (payload) => (payload && !payload.error && Array.isArray(payload.presets) ? model.groupPresets(payload) : { error: true });
			const refreshPresets = () => {
				if (typeof props.fetchPresets !== "function") { setList({ error: true }); return; }
				props.fetchPresets(props.sessionId).then((payload) => {
					// Fail closed: a non-listing payload (unsupported store,
					// unreadable unit) is an explicit error surface, never a
					// fake empty list.
					setList(presetListOf(payload));
				}).catch(() => setList({ error: true }));
			};
			const refreshDefault = () => {
				if (typeof props.defaultGet !== "function") { setDefaultRes({ error: true }); return; }
				props.defaultGet(props.sessionId).then((payload) => setDefaultRes(payload ?? { error: true })).catch(() => setDefaultRes({ error: true }));
			};
			react.useEffect(() => {
				let alive = true;
				if (typeof props.fetchPresets === "function") {
					props.fetchPresets(props.sessionId).then((payload) => {
						if (alive) setList(presetListOf(payload));
					}).catch(() => { if (alive) setList({ error: true }); });
				} else {
					setList({ error: true });
				}
				if (typeof props.defaultGet === "function") {
					props.defaultGet(props.sessionId).then((payload) => { if (alive) setDefaultRes(payload ?? { error: true }); }).catch(() => { if (alive) setDefaultRes({ error: true }); });
				} else {
					setDefaultRes({ error: true });
				}
				return () => { alive = false; };
			}, [props.sessionId]);
			// ---- Save (create) with the name-conflict decision row ----
			const submitSave = (onNameConflict) => {
				if (typeof props.presetSave !== "function" || saveForm.busy) return;
				const name = saveForm.name.trim();
				if (name === "") {
					setSaveForm({ ...saveForm, error: t("capability.presets.errorName", "Enter a name."), conflict: null });
					return;
				}
				const spec = { scope: saveForm.scope, name, from: saveForm.from };
				if (saveForm.from === "draft") {
					spec.skills = Array.isArray(props.draft?.skills) ? props.draft.skills : [];
					spec.mcpServers = Array.isArray(props.draft?.mcpServers) ? props.draft.mcpServers : [];
					spec.unresolvedRefs = Array.isArray(props.draft?.unresolvedRefs) ? props.draft.unresolvedRefs : [];
				}
				if (onNameConflict) spec.onNameConflict = onNameConflict;
				setSaveForm({ ...saveForm, busy: true, error: null });
				props.presetSave(props.sessionId, spec).then((response) => {
					const outcome = model.presetWriteOutcomeOf(response);
					if (outcome.kind === "created" || outcome.kind === "edited") {
						setSaveForm({ open: false, name: "", scope: saveForm.scope, from: saveForm.from, busy: false, error: null, conflict: null });
						setNotice(t("capability.presets.saved", "Preset saved."));
						refreshPresets();
					} else if (outcome.kind === "name-conflict") {
						setSaveForm({ ...saveForm, busy: false, error: null, conflict: { with: outcome.with } });
					} else if (outcome.kind === "revision-conflict") {
						setSaveForm({ ...saveForm, busy: false, error: t("capability.presets.revisionConflict", "Changed elsewhere — the list was refreshed."), conflict: null });
						refreshPresets();
					} else if (outcome.kind === "no-workspace") {
						setSaveForm({ ...saveForm, busy: false, error: t("capability.presets.noWorkspace", "This session has no workspace."), conflict: null });
					} else {
						setSaveForm({ ...saveForm, busy: false, error: t("capability.presets.saveFailed", "The preset could not be saved."), conflict: null });
					}
				}).catch(() => setSaveForm({ ...saveForm, busy: false, error: t("capability.presets.saveFailed", "The preset could not be saved.") }));
			};
			// ---- Load into the local draft (never the applied set) ----
			const loadPreset = (row) => {
				if (typeof props.presetLoad !== "function" || rowAction?.busy) return;
				setRowAction({ presetId: row.presetId, scope: row.scope, kind: "load", busy: true, error: null });
				props.presetLoad(props.sessionId, { scope: row.scope, presetId: row.presetId }).then((response) => {
					if (response && !response.error && response.status === "ok" && response.document && typeof response.document === "object") {
						if (typeof props.stagePreset === "function") props.stagePreset(response.document);
						const unresolved = Array.isArray(response.document.selection?.unresolvedRefs) ? response.document.selection.unresolvedRefs : [];
						setNotice(unresolved.length > 0
							? t("capability.presets.loadedUnresolved", "Staged into the draft — {n} unresolved ref(s) reported.").replace("{n}", String(unresolved.length))
							: t("capability.presets.loaded", "Staged into the draft — Apply to activate."));
						setRowAction(null);
					} else {
						setRowAction({ presetId: row.presetId, scope: row.scope, kind: "load", busy: false, error: t("capability.presets.loadFailed", "Load failed — the preset may be gone.") });
						refreshPresets();
					}
				}).catch(() => setRowAction({ presetId: row.presetId, scope: row.scope, kind: "load", busy: false, error: t("capability.presets.loadFailed", "Load failed — the preset may be gone.") }));
			};
			// ---- Delete with the inline confirm row (expectedRevision CAS) ----
			const confirmDelete = (row) => {
				if (typeof props.presetDelete !== "function" || rowAction?.busy) return;
				setRowAction({ presetId: row.presetId, scope: row.scope, kind: "delete", busy: true, error: null });
				props.presetDelete(props.sessionId, { scope: row.scope, presetId: row.presetId, expectedRevision: row.revision }).then((response) => {
					const outcome = model.presetWriteOutcomeOf(response);
					if (outcome.kind === "deleted") {
						setNotice(t("capability.presets.deleted", "Preset deleted."));
						setRowAction(null);
					} else {
						setRowAction({
							presetId: row.presetId,
							scope: row.scope,
							kind: "delete",
							busy: false,
							error: outcome.kind === "revision-conflict"
								? t("capability.presets.revisionConflict", "Changed elsewhere — the list was refreshed.")
								: t("capability.presets.deleteFailed", "Delete failed.")
						});
					}
					refreshPresets();
				}).catch(() => {
					setRowAction({ presetId: row.presetId, scope: row.scope, kind: "delete", busy: false, error: t("capability.presets.deleteFailed", "Delete failed.") });
				});
			};
			// ---- Export: read-only JSON viewer + clipboard copy ----
			const openExport = (row) => {
				if (typeof props.presetExport !== "function" || rowAction?.busy) return;
				setRowAction({ presetId: row.presetId, scope: row.scope, kind: "export", busy: true, error: null, text: null, copied: false });
				props.presetExport(props.sessionId, { scope: row.scope, presetId: row.presetId }).then((response) => {
					const view = model.presetExportTextOf(response);
					if (view.kind === "ok") {
						setRowAction({ presetId: row.presetId, scope: row.scope, kind: "export", busy: false, error: null, text: view.text, copied: false });
					} else {
						setRowAction({ presetId: row.presetId, scope: row.scope, kind: "export", busy: false, error: t("capability.presets.exportFailed", "Export failed."), text: null, copied: false });
					}
				}).catch(() => setRowAction({ presetId: row.presetId, scope: row.scope, kind: "export", busy: false, error: t("capability.presets.exportFailed", "Export failed."), text: null, copied: false }));
			};
			const copyExport = () => {
				if (!rowAction?.text) return;
				try {
					const clipboard = globalThis.navigator?.clipboard;
					if (clipboard?.writeText) clipboard.writeText(rowAction.text);
				} catch {
					// clipboard unavailable: nothing to report
				}
				setRowAction({ ...rowAction, copied: true });
			};
			// ---- Import: categorized feedback (bound / unresolved / rejected) ----
			const submitImport = (onNameConflict) => {
				if (typeof props.presetImport !== "function" || importBox.busy) return;
				let document = importBox.document;
				if (!onNameConflict) {
					try {
						document = JSON.parse(importBox.text);
					} catch {
						setImportBox({ ...importBox, feedback: { kind: "invalid-json" }, document: null });
						return;
					}
				}
				const spec = { document, scope: importBox.scope };
				if (onNameConflict) spec.onNameConflict = onNameConflict;
				setImportBox({ ...importBox, busy: true, feedback: null, document });
				props.presetImport(props.sessionId, spec).then((response) => {
					const feedback = model.importFeedbackOf(response);
					if (feedback.kind === "created") {
						setImportBox({ open: false, text: "", scope: importBox.scope, busy: false, feedback: null, document: null });
						setNotice(t("capability.presets.imported", "Imported: {bound} MCP binding(s), {unresolved} unresolved ref(s).")
							.replace("{bound}", String(feedback.bound))
							.replace("{unresolved}", String(feedback.unresolved)));
						refreshPresets();
					} else {
						setImportBox({ ...importBox, busy: false, feedback });
						if (feedback.kind === "error") refreshPresets();
					}
				}).catch(() => setImportBox({ ...importBox, busy: false, feedback: { kind: "error" } }));
			};
			// ---- Workspace default ----
			const submitDefaultSave = () => {
				if (typeof props.defaultSave !== "function" || defaultBox.busy) return;
				const spec = { from: defaultBox.from };
				if (defaultBox.from === "draft") {
					spec.skills = Array.isArray(props.draft?.skills) ? props.draft.skills : [];
					spec.mcpServers = Array.isArray(props.draft?.mcpServers) ? props.draft.mcpServers : [];
					spec.unresolvedRefs = Array.isArray(props.draft?.unresolvedRefs) ? props.draft.unresolvedRefs : [];
				}
				setDefaultBox({ ...defaultBox, busy: true, error: null });
				props.defaultSave(props.sessionId, spec).then((response) => {
					const outcome = model.defaultWriteOutcomeOf(response);
					if (outcome.kind === "saved") {
						setDefaultBox({ confirm: null, from: defaultBox.from, busy: false, error: null });
						setNotice(t("capability.presets.defaultSaved", "Workspace default saved."));
					} else {
						setDefaultBox({
							...defaultBox,
							busy: false,
							error: outcome.kind === "revision-conflict"
								? t("capability.presets.revisionConflict", "Changed elsewhere — the list was refreshed.")
								: outcome.kind === "no-workspace"
									? t("capability.presets.noWorkspace", "This session has no workspace.")
									: t("capability.presets.defaultSaveFailed", "The default could not be saved.")
						});
					}
					refreshDefault();
				}).catch(() => setDefaultBox({ ...defaultBox, busy: false, error: t("capability.presets.defaultSaveFailed", "The default could not be saved.") }));
			};
			const submitDefaultClear = () => {
				if (typeof props.defaultClear !== "function" || defaultBox.busy) return;
				setDefaultBox({ ...defaultBox, busy: true, error: null });
				props.defaultClear(props.sessionId, {}).then((response) => {
					const outcome = model.defaultWriteOutcomeOf(response);
					if (outcome.kind === "cleared") {
						setDefaultBox({ confirm: null, from: defaultBox.from, busy: false, error: null });
						setNotice(t("capability.presets.defaultCleared", "Workspace default cleared — new sessions use the builtin baseline."));
					} else {
						setDefaultBox({
							...defaultBox,
							busy: false,
							error: outcome.kind === "revision-conflict"
								? t("capability.presets.revisionConflict", "Changed elsewhere — the list was refreshed.")
								: t("capability.presets.defaultClearFailed", "The default could not be cleared.")
						});
					}
					refreshDefault();
				}).catch(() => setDefaultBox({ ...defaultBox, busy: false, error: t("capability.presets.defaultClearFailed", "The default could not be cleared.") }));
			};
			const countText = (skills, mcpServers) => t("capability.presets.counts", "{skills} skills · {mcp} MCP")
				.replace("{skills}", String(skills))
				.replace("{mcp}", String(mcpServers));
			const presetRow = (row) => {
				const active = rowAction && rowAction.presetId === row.presetId && rowAction.scope === row.scope;
				const unresolvedSuffix = row.counts.unresolvedRefs > 0
					? t("capability.presets.countsUnresolved", " · {n} unresolved").replace("{n}", String(row.counts.unresolvedRefs))
					: "";
				return react_jsx_runtime.jsxs("div", {
					children: [
						react_jsx_runtime.jsxs("div", {
							style: rowStyle,
							children: [
								react_jsx_runtime.jsx("span", { style: nameTextStyle, title: row.name, children: row.name }),
								react_jsx_runtime.jsx("span", { style: summaryStyle, children: countText(row.counts.skills, row.counts.mcpServers) + unresolvedSuffix }),
								react_jsx_runtime.jsx("button", {
									type: "button",
									style: linkButtonStyle,
									disabled: active && rowAction.busy,
									onClick: () => loadPreset(row),
									children: active && rowAction.kind === "load" && rowAction.busy ? t("capability.presets.loading", "Loading…") : t("capability.presets.load", "Load")
								}),
								react_jsx_runtime.jsx("button", {
									type: "button",
									style: linkButtonStyle,
									disabled: active && rowAction.busy,
									onClick: () => (active && rowAction.kind === "export" ? setRowAction(null) : openExport(row)),
									children: t("capability.presets.export", "Export")
								}),
								react_jsx_runtime.jsx("button", {
									type: "button",
									style: linkButtonStyle,
									disabled: active && rowAction.busy,
									onClick: () => (active && rowAction.kind === "delete" ? setRowAction(null) : setRowAction({ presetId: row.presetId, scope: row.scope, kind: "delete", busy: false, error: null })),
									children: t("capability.presets.delete", "Delete")
								})
							]
						}),
						active && rowAction.kind === "load" && rowAction.error
							? react_jsx_runtime.jsx("div", { style: warnTextStyle, children: rowAction.error })
							: null,
						active && rowAction.kind === "delete"
							? react_jsx_runtime.jsxs("div", {
								style: boxStyle,
								children: [
									react_jsx_runtime.jsx("span", { style: { fontSize: "11px" }, children: t("capability.presets.deleteConfirm", "Delete preset \"{name}\"? This cannot be undone.").replace("{name}", row.name) }),
									react_jsx_runtime.jsxs("div", {
										style: buttonRowStyle,
										children: [
											react_jsx_runtime.jsx("button", { type: "button", disabled: rowAction.busy, onClick: () => confirmDelete(row), children: rowAction.busy ? t("capability.presets.deleting", "Deleting…") : t("capability.presets.deleteConfirmButton", "Delete preset") }),
											react_jsx_runtime.jsx("button", { type: "button", disabled: rowAction.busy, onClick: () => setRowAction(null), children: t("capability.presets.cancel", "Cancel") }),
											rowAction.error ? react_jsx_runtime.jsx("span", { style: warnTextStyle, children: rowAction.error }) : null
										]
									})
								]
							})
							: null,
						active && rowAction.kind === "export"
							? react_jsx_runtime.jsxs("div", {
								style: boxStyle,
								children: [
									rowAction.busy
										? react_jsx_runtime.jsx("span", { style: hintStyle, children: t("capability.loading", "Loading capabilities…") })
										: rowAction.text
											? react_jsx_runtime.jsx("textarea", { style: textareaStyle, readOnly: true, value: rowAction.text, "aria-label": t("capability.presets.exportLabel", "Preset JSON") })
											: null,
									react_jsx_runtime.jsxs("div", {
										style: buttonRowStyle,
										children: [
											rowAction.text
												? react_jsx_runtime.jsx("button", { type: "button", onClick: copyExport, children: rowAction.copied ? t("capability.presets.copied", "Copied") : t("capability.presets.copy", "Copy to clipboard") })
												: null,
											react_jsx_runtime.jsx("button", { type: "button", onClick: () => setRowAction(null), children: t("capability.presets.close", "Close") }),
											rowAction.error ? react_jsx_runtime.jsx("span", { style: warnTextStyle, children: rowAction.error }) : null
										]
									})
								]
							})
							: null
					]
				}, `${row.scope}:${row.presetId}`);
			};
			const presetGroup = (title, rows, emptyText) => react_jsx_runtime.jsxs("div", {
				style: sectionStyle,
				children: [
					react_jsx_runtime.jsx("div", { style: sectionTitleStyle, children: title }),
					rows.length === 0
						? react_jsx_runtime.jsx("div", { style: hintStyle, children: emptyText })
						: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: rows.map(presetRow) })
				]
			}, title);
			// Workspace default presentation (model-categorized): none (absent or
			// cleared), an explicit empty set, or n entries.
			const defaultState = defaultRes && !defaultRes.error ? model.defaultStateOf(defaultRes) : (defaultRes ? { kind: "error" } : null);
			const draftCounts = props.draft ? { skills: props.draft.skills.length, mcpServers: props.draft.mcpServers.length } : null;
			const appliedCounts = props.draft ? { skills: props.draft.applied.skills.length, mcpServers: props.draft.applied.mcpServers.length } : null;
			const defaultFromCounts = defaultBox.from === "draft" ? draftCounts : appliedCounts;
			const importFeedback = importBox.feedback;
			return react_jsx_runtime.jsxs("div", {
				children: [
					react_jsx_runtime.jsxs("div", {
						style: buttonRowStyle,
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: linkButtonStyle,
								disabled: typeof props.presetSave !== "function",
								onClick: () => setSaveForm({ ...saveForm, open: !saveForm.open, error: null, conflict: null }),
								children: saveForm.open ? t("capability.presets.cancel", "Cancel") : t("capability.presets.saveOpen", "Save as preset…")
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: linkButtonStyle,
								disabled: typeof props.presetImport !== "function",
								onClick: () => setImportBox({ ...importBox, open: !importBox.open, feedback: null }),
								children: importBox.open ? t("capability.presets.cancel", "Cancel") : t("capability.presets.importOpen", "Import…")
							})
						]
					}),
					notice ? react_jsx_runtime.jsx("div", { style: noticeStyle, children: notice }) : null,
					saveForm.open
						? react_jsx_runtime.jsxs("div", {
							style: boxStyle,
							children: [
								react_jsx_runtime.jsx("input", {
									style: inputStyle,
									placeholder: t("capability.presets.name", "Preset name"),
									value: saveForm.name,
									onChange: (event) => setSaveForm({ ...saveForm, name: event.target.value, error: null })
								}),
								react_jsx_runtime.jsxs("div", {
									style: buttonRowStyle,
									children: [
										react_jsx_runtime.jsxs("label", {
											style: { fontSize: "11px", display: "flex", gap: "4px", alignItems: "center" },
											children: [
												t("capability.presets.namespace", "Namespace"),
												react_jsx_runtime.jsxs("select", {
													value: saveForm.scope,
													onChange: (event) => setSaveForm({ ...saveForm, scope: event.target.value }),
													children: [
														react_jsx_runtime.jsx("option", { value: "workspace", children: t("capability.presets.scopeWorkspace", "workspace") }),
														react_jsx_runtime.jsx("option", { value: "global", children: t("capability.presets.scopeGlobal", "global") })
													]
												})
											]
										}),
										react_jsx_runtime.jsxs("label", {
											style: { fontSize: "11px", display: "flex", gap: "4px", alignItems: "center" },
											children: [
												t("capability.presets.source", "From"),
												react_jsx_runtime.jsxs("select", {
													value: saveForm.from,
													onChange: (event) => setSaveForm({ ...saveForm, from: event.target.value }),
													children: [
														react_jsx_runtime.jsx("option", { value: "draft", children: t("capability.presets.fromDraft", "current draft") }),
														react_jsx_runtime.jsx("option", { value: "applied", children: t("capability.presets.fromApplied", "applied selection") })
													]
												})
											]
										})
									]
								}),
								saveForm.conflict
									? react_jsx_runtime.jsxs("div", {
										style: boxStyle,
										children: [
											react_jsx_runtime.jsx("span", { style: { fontSize: "11px" }, children: t("capability.presets.nameConflict", "A preset named \"{name}\" already exists in this namespace.").replace("{name}", saveForm.name.trim()) }),
											react_jsx_runtime.jsxs("div", {
												style: buttonRowStyle,
												children: [
													react_jsx_runtime.jsx("button", {
														type: "button",
														disabled: saveForm.busy,
														onClick: () => setSaveForm({ ...saveForm, conflict: null, error: t("capability.presets.renameHint", "Edit the name, then save again.") }),
														children: t("capability.presets.rename", "Rename…")
													}),
													react_jsx_runtime.jsx("button", { type: "button", disabled: saveForm.busy, onClick: () => submitSave("replace"), children: t("capability.presets.replace", "Replace it") }),
													react_jsx_runtime.jsx("button", { type: "button", disabled: saveForm.busy, onClick: () => setSaveForm({ ...saveForm, open: false, conflict: null }), children: t("capability.presets.cancel", "Cancel") })
												]
											})
										]
									})
									: null,
								react_jsx_runtime.jsxs("div", {
									style: buttonRowStyle,
									children: [
										react_jsx_runtime.jsx("button", { type: "button", disabled: saveForm.busy, onClick: () => submitSave(undefined), children: saveForm.busy ? t("capability.presets.saving", "Saving…") : t("capability.presets.save", "Save preset") }),
										saveForm.error ? react_jsx_runtime.jsx("span", { style: warnTextStyle, children: saveForm.error }) : null
									]
								})
							]
						})
						: null,
					importBox.open
						? react_jsx_runtime.jsxs("div", {
							style: boxStyle,
							children: [
								react_jsx_runtime.jsx("textarea", {
									style: textareaStyle,
									placeholder: t("capability.presets.importPlaceholder", "Paste a portable preset document (JSON)…"),
									value: importBox.text,
									onChange: (event) => setImportBox({ ...importBox, text: event.target.value, feedback: null, document: null })
								}),
								react_jsx_runtime.jsxs("div", {
									style: buttonRowStyle,
									children: [
										react_jsx_runtime.jsxs("label", {
											style: { fontSize: "11px", display: "flex", gap: "4px", alignItems: "center" },
											children: [
												t("capability.presets.namespace", "Namespace"),
												react_jsx_runtime.jsxs("select", {
													value: importBox.scope,
													onChange: (event) => setImportBox({ ...importBox, scope: event.target.value }),
													children: [
														react_jsx_runtime.jsx("option", { value: "workspace", children: t("capability.presets.scopeWorkspace", "workspace") }),
														react_jsx_runtime.jsx("option", { value: "global", children: t("capability.presets.scopeGlobal", "global") })
													]
												})
											]
										}),
										react_jsx_runtime.jsx("button", { type: "button", disabled: importBox.busy || importBox.text.trim() === "", onClick: () => submitImport(undefined), children: importBox.busy ? t("capability.presets.importing", "Importing…") : t("capability.presets.importSubmit", "Import") })
									]
								}),
								importFeedback && importFeedback.kind === "invalid-json"
									? react_jsx_runtime.jsx("div", { style: warnTextStyle, children: t("capability.presets.importInvalidJson", "Not valid JSON — nothing was written.") })
									: null,
								importFeedback && importFeedback.kind === "rejected"
									? react_jsx_runtime.jsx("div", { style: warnTextStyle, children: t("capability.presets.importRejected", "Rejected: {reason} — nothing was written.").replace("{reason}", importFeedback.reason) })
									: null,
								importFeedback && importFeedback.kind === "name-conflict"
									? react_jsx_runtime.jsxs("div", {
										style: buttonRowStyle,
										children: [
											react_jsx_runtime.jsx("span", { style: { fontSize: "11px" }, children: t("capability.presets.importNameConflict", "A preset with this name already exists here.") }),
											react_jsx_runtime.jsx("button", { type: "button", disabled: importBox.busy, onClick: () => submitImport("replace"), children: t("capability.presets.replace", "Replace it") }),
											react_jsx_runtime.jsx("button", { type: "button", disabled: importBox.busy, onClick: () => setImportBox({ ...importBox, feedback: null, document: null }), children: t("capability.presets.cancel", "Cancel") })
										]
									})
									: null,
								importFeedback && importFeedback.kind === "no-workspace"
									? react_jsx_runtime.jsx("div", { style: warnTextStyle, children: t("capability.presets.noWorkspace", "This session has no workspace.") })
									: null,
								importFeedback && importFeedback.kind === "error"
									? react_jsx_runtime.jsx("div", { style: warnTextStyle, children: t("capability.presets.importFailed", "Import failed — nothing was written.") })
									: null
							]
						})
						: null,
					list === null
						? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.loading", "Loading capabilities…") })
						: list.error
							? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.presets.unavailable", "Presets are unavailable on this host.") })
							: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
								children: [
									presetGroup(
										list.workspaceKey
											? t("capability.presets.groupWorkspace", "Workspace presets")
											: t("capability.presets.groupWorkspaceNone", "Workspace presets (no workspace)"),
										list.workspace,
										t("capability.presets.emptyWorkspace", "No workspace presets yet.")
									),
									presetGroup(
										t("capability.presets.groupGlobal", "Global presets"),
										list.global,
										t("capability.presets.emptyGlobal", "No global presets yet.")
									)
								]
							}),
					react_jsx_runtime.jsxs("div", {
						style: sectionStyle,
						children: [
							react_jsx_runtime.jsx("div", { style: sectionTitleStyle, children: t("capability.presets.defaultTitle", "Workspace default for new sessions") }),
							defaultState === null
								? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.loading", "Loading capabilities…") })
								: defaultState.kind === "error"
									? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.presets.defaultUnavailable", "The workspace default is unavailable.") })
									: defaultState.kind === "unsupported"
										? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.presets.noWorkspace", "This session has no workspace.") })
										: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
											children: [
												react_jsx_runtime.jsx("div", {
													style: hintStyle,
													children: defaultState.kind === "none"
														? t("capability.presets.defaultNone", "No default is set — new sessions use the builtin baseline.")
														: defaultState.kind === "empty"
															? t("capability.presets.defaultEmpty", "An explicit empty default is set: new sessions start with 0 skills · 0 MCP.")
															: t("capability.presets.defaultEntries", "Default: {counts}").replace("{counts}", countText(defaultState.skills, defaultState.mcpServers))
												}),
												defaultState.kind === "entries" && defaultState.unresolvedRefs > 0
													? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.presets.defaultUnresolved", "…with {n} unresolved ref(s) reported on resolve.").replace("{n}", String(defaultState.unresolvedRefs)) })
													: null,
												react_jsx_runtime.jsxs("div", {
													style: buttonRowStyle,
													children: [
														react_jsx_runtime.jsx("button", {
															type: "button",
															style: linkButtonStyle,
															disabled: props.draft === null || typeof props.defaultSave !== "function",
															title: props.draft === null ? t("capability.presets.needsReceipt", "Unavailable until the session receipt loads.") : undefined,
															onClick: () => setDefaultBox({ ...defaultBox, confirm: defaultBox.confirm === "save" ? null : "save", error: null }),
															children: t("capability.presets.defaultSaveOpen", "Save as default…")
														}),
														defaultState.kind !== "none"
															? react_jsx_runtime.jsx("button", {
																type: "button",
																style: linkButtonStyle,
																disabled: typeof props.defaultClear !== "function",
																onClick: () => setDefaultBox({ ...defaultBox, confirm: defaultBox.confirm === "clear" ? null : "clear", error: null }),
																children: t("capability.presets.defaultClearOpen", "Clear default…")
															})
															: null
													]
												}),
												defaultBox.confirm === "save"
													? react_jsx_runtime.jsxs("div", {
														style: boxStyle,
														children: [
															react_jsx_runtime.jsxs("div", {
																style: { fontSize: "11px", display: "flex", gap: "4px", alignItems: "center" },
																children: [
																	t("capability.presets.source", "From"),
																	react_jsx_runtime.jsxs("select", {
																		value: defaultBox.from,
																		onChange: (event) => setDefaultBox({ ...defaultBox, from: event.target.value }),
																		children: [
																			react_jsx_runtime.jsx("option", { value: "draft", children: t("capability.presets.fromDraft", "current draft") }),
																			react_jsx_runtime.jsx("option", { value: "applied", children: t("capability.presets.fromApplied", "applied selection") })
																		]
																	})
																]
															}),
															react_jsx_runtime.jsx("span", {
																style: { fontSize: "11px" },
																children: defaultFromCounts
																	? t("capability.presets.defaultSaveConfirm", "Save {counts} as this workspace's default? New sessions in this workspace will start from it; the current session does not change.").replace("{counts}", countText(defaultFromCounts.skills, defaultFromCounts.mcpServers))
																	: t("capability.presets.needsReceipt", "Unavailable until the session receipt loads.")
															}),
															react_jsx_runtime.jsxs("div", {
																style: buttonRowStyle,
																children: [
																	react_jsx_runtime.jsx("button", { type: "button", disabled: defaultBox.busy || !defaultFromCounts, onClick: submitDefaultSave, children: defaultBox.busy ? t("capability.presets.saving", "Saving…") : t("capability.presets.defaultSaveConfirmButton", "Save default") }),
																	react_jsx_runtime.jsx("button", { type: "button", disabled: defaultBox.busy, onClick: () => setDefaultBox({ ...defaultBox, confirm: null, error: null }), children: t("capability.presets.cancel", "Cancel") }),
																	defaultBox.error ? react_jsx_runtime.jsx("span", { style: warnTextStyle, children: defaultBox.error }) : null
																]
															})
														]
													})
													: null,
												defaultBox.confirm === "clear"
													? react_jsx_runtime.jsxs("div", {
														style: boxStyle,
														children: [
															react_jsx_runtime.jsx("span", { style: { fontSize: "11px" }, children: t("capability.presets.defaultClearConfirm", "Clear the workspace default? New sessions return to the builtin baseline; open sessions do not change.") }),
															react_jsx_runtime.jsxs("div", {
																style: buttonRowStyle,
																children: [
																	react_jsx_runtime.jsx("button", { type: "button", disabled: defaultBox.busy, onClick: submitDefaultClear, children: defaultBox.busy ? t("capability.presets.clearing", "Clearing…") : t("capability.presets.defaultClearConfirmButton", "Clear default") }),
																	react_jsx_runtime.jsx("button", { type: "button", disabled: defaultBox.busy, onClick: () => setDefaultBox({ ...defaultBox, confirm: null, error: null }), children: t("capability.presets.cancel", "Cancel") }),
																	defaultBox.error ? react_jsx_runtime.jsx("span", { style: warnTextStyle, children: defaultBox.error }) : null
																]
															})
														]
													})
													: null
											]
										})
						]
					})
				]
			});
		}
		exports.CapabilityPresetsView = CapabilityPresetsView;
		return module.exports;
	}
});
