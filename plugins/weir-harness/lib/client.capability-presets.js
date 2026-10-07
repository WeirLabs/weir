window.__ModuleLoader__.load({
	id: "weir-harness",
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
		// confirm row, a package export with a .json download plus the read-only
		// JSON viewer and clipboard copy, a two-phase package import (D6: every
		// version-2 document dry-runs first; the summary names install targets,
		// file counts, unresolved refs and collisions; the explicit confirm sends
		// the collision decision; v1 documents keep the single-step path with
		// categorized feedback), and the workspace-default section with
		// count-naming confirmations. Every categorization comes from the pure
		// model; this chunk renders and forwards the composition root's verbs.
		//
		// Visual layer (capabilities-panel-visual-polish, D1): one consolidated
		// style table S. Preset rows are cards (name + counts + namespace badge
		// + inline actions), destructive confirms are warning strips, the
		// workspace default is its own card, and the import/export blocks sit in
		// labeled cards. Interactive affordances (focus ring, hover fill) are
		// painted by the ring/hover handlers — no hooks, no wrapper components,
		// and every button keeps its exact label-only children (the chunk tests
		// locate buttons by label).
		const ACCENT = "var(--dsw-alias-state-business-primary, #4176e6)";
		const ACCENT_HOVER = "var(--dsw-alias-button-info-hover, #3563d1)";
		const SUCCESS = "var(--dsw-alias-state-success-primary, #22c55e)";
		const WARN = "var(--dsw-alias-state-warn-primary, #f59e0b)";
		const WARN_TEXT = "var(--dsw-alias-state-warn-label, #b45309)";
		const DANGER = "var(--dsw-alias-state-error-primary, #ef4444)";
		const LABEL1 = "var(--dsw-alias-label-primary, inherit)";
		const LABEL2 = "var(--dsw-alias-label-secondary, #61666b)";
		const MUTED = "var(--dsw-alias-label-tertiary, #81858c)";
		const BORDER = "var(--dsw-alias-border-l2, rgba(127,127,127,.18))";
		const BORDER_STRONG = "var(--dsw-alias-border-l3, rgba(127,127,127,.26))";
		const HOVER_BG = "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))";
		const CARD_BG = "var(--dsw-alias-bg-base, #fff)";
		const MONO = "var(--dsw-font-markdown-code-block-font-family, ui-monospace, monospace)";
		const TRANSITION = "background-color 120ms ease, color 120ms ease, border-color 120ms ease";
		/** Soft tinted background (worktree-view recipe); the colored border/text stays as the no-color-mix fallback. */
		const tint = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
		// Scope → hue (D1): user green, project blue; preset namespaces rhyme
		// with them (global = this machine's user library, workspace = this
		// project), so the badge color reads the same way everywhere.
		const SCOPE_HUES = {
			user: SUCCESS,
			global: SUCCESS,
			project: "var(--dsw-static-blue-500, #3b82f6)",
			workspace: "var(--dsw-static-blue-500, #3b82f6)",
		};
		// Focus ring and hover paint without stylesheets (inline-style chunk
		// discipline): the handlers write to the event target's inline style and
		// clear on the way out; no hooks and no DOM structure change.
		const paint = (event, styles) => {
			const el = event?.currentTarget;
			if (el && el.style) Object.assign(el.style, styles);
		};
		const ring = {
			onFocus: (event) => paint(event, { outline: "2px solid var(--dsw-alias-focus-ring, currentColor)", outlineOffset: "1px" }),
			onBlur: (event) => paint(event, { outline: "none", outlineOffset: "" }),
		};
		const hover = (over, out) => ({
			onMouseEnter: (event) => paint(event, { background: over }),
			onMouseLeave: (event) => paint(event, { background: out }),
		});
		const S = {
			section: { marginTop: "12px" },
			title: {
				fontSize: "11px",
				lineHeight: "16px",
				fontWeight: 600,
				color: LABEL2,
				margin: "0 0 4px"
			},
			// Labeled card (save form, import box, export viewer, workspace
			// default): one surface per task block.
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				background: CARD_BG,
				border: `1px solid ${BORDER}`,
				borderRadius: "var(--dsw-radius-md, 8px)",
				padding: "8px 10px",
				margin: "6px 0"
			},
			cardTitle: { fontSize: "11px", lineHeight: "16px", fontWeight: 600, color: LABEL2 },
			// Warning strip (destructive confirms, name conflicts): 2px left bar
			// on a warn tint — the worktree callout recipe.
			strip: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "6px 8px",
				fontSize: "11px",
				lineHeight: "16px",
				color: LABEL2,
				background: tint(WARN, 10),
				borderLeft: `2px solid ${WARN}`,
				borderRadius: "var(--dsw-radius-xs, 4px)",
				margin: "4px 0"
			},
			notice: {
				padding: "5px 8px",
				fontSize: "11px",
				lineHeight: "16px",
				color: "var(--dsw-alias-state-success-primary, #2a7d2a)",
				background: tint(SUCCESS, 10),
				borderLeft: `2px solid ${SUCCESS}`,
				borderRadius: "var(--dsw-radius-xs, 4px)",
				margin: "4px 0"
			},
			// Preset row card: header line (name + namespace badge + counts) with
			// the inline actions trailing.
			preset: {
				background: CARD_BG,
				border: `1px solid ${BORDER}`,
				borderRadius: "var(--dsw-radius-md, 8px)",
				padding: "7px 10px",
				margin: "0 0 6px"
			},
			row: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
			name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "none", maxWidth: "46%", fontWeight: 600 },
			summary: { fontSize: "11px", lineHeight: "16px", color: MUTED, flex: 1, minWidth: "80px" },
			hint: { fontSize: "11px", lineHeight: "16px", color: MUTED, padding: "2px 0" },
			warn: { fontSize: "11px", lineHeight: "16px", color: WARN_TEXT },
			input: {
				width: "100%",
				boxSizing: "border-box",
				fontSize: "12px",
				lineHeight: "16px",
				padding: "4px 8px",
				background: CARD_BG,
				border: `1px solid ${BORDER}`,
				borderRadius: "var(--dsw-radius-sm, 6px)",
				color: LABEL1,
				transition: TRANSITION
			},
			textarea: {
				width: "100%",
				boxSizing: "border-box",
				fontSize: "12px",
				lineHeight: "16px",
				padding: "6px 8px",
				background: CARD_BG,
				border: `1px solid ${BORDER}`,
				borderRadius: "var(--dsw-radius-sm, 6px)",
				color: LABEL1,
				fontFamily: MONO,
				minHeight: "96px",
				resize: "vertical",
				whiteSpace: "pre",
				transition: TRANSITION
			},
			select: { fontSize: "11px", lineHeight: "16px", color: LABEL1, background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: "var(--dsw-radius-sm, 6px)", padding: "1px 4px" },
			buttonRow: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
			label: { fontSize: "11px", lineHeight: "16px", display: "flex", gap: "4px", alignItems: "center", color: LABEL2 },
			button: {
				fontSize: "11px",
				lineHeight: "16px",
				fontWeight: 500,
				padding: "2px 8px",
				cursor: "pointer",
				background: "none",
				border: `1px solid ${BORDER}`,
				borderRadius: "var(--dsw-radius-sm, 6px)",
				color: LABEL2,
				flex: "none",
				transition: TRANSITION
			},
			primary: {
				fontSize: "11px",
				lineHeight: "16px",
				fontWeight: 600,
				padding: "2px 10px",
				cursor: "pointer",
				border: "none",
				borderRadius: "var(--dsw-radius-sm, 6px)",
				background: ACCENT,
				color: "var(--dsw-alias-bg-base, #fff)",
				flex: "none",
				transition: TRANSITION
			},
			danger: {
				fontSize: "11px",
				lineHeight: "16px",
				fontWeight: 600,
				padding: "2px 10px",
				cursor: "pointer",
				border: "none",
				borderRadius: "var(--dsw-radius-sm, 6px)",
				background: DANGER,
				color: "var(--dsw-alias-bg-base, #fff)",
				flex: "none",
				transition: TRANSITION
			},
			dangerOutline: {
				fontSize: "11px",
				lineHeight: "16px",
				fontWeight: 500,
				padding: "2px 8px",
				cursor: "pointer",
				background: "none",
				border: `1px solid ${DANGER}`,
				borderRadius: "var(--dsw-radius-sm, 6px)",
				color: DANGER,
				flex: "none",
				transition: TRANSITION
			},
			disabled: { opacity: 0.5, cursor: "not-allowed" },
			// Namespace / install-target badge (preset scope chip, import scope
			// badge): tiny tonal tag.
			badge: (scope) => {
				const hue = SCOPE_HUES[scope] ?? MUTED;
				return {
					fontSize: "10px",
					lineHeight: "14px",
					fontWeight: 600,
					padding: "0 5px",
					border: `1px solid ${hue}`,
					borderRadius: "var(--dsw-radius-sm, 6px)",
					background: tint(hue, 10),
					color: hue,
					flex: "none",
					whiteSpace: "nowrap"
				};
			}
		};
		function CapabilityPresetsView(props) {
			const model = props.model;
			// Echo-guard: an unregistered dictionary entry surfaces the in-code
			// fallback, never the raw key.
			const t = (key, fallback) => {
				// The host locale's second parameter is an interpolation VARS object,
				// never a fallback string — passing the fallback there crashes
				// translate whenever the registered template carries {placeholders}
				// (the 2026-10-05 badge slot crash). Dictionary templates keep their
				// placeholders for the call site's own .replace interpolation.
				const value = typeof props.t === "function" ? props.t(key) : undefined;
				return typeof value === "string" && value !== key ? value : fallback;
			};
			const [list, setList] = react.useState(null);
			const [defaultRes, setDefaultRes] = react.useState(null);
			const [saveForm, setSaveForm] = react.useState({ open: false, name: "", scope: "workspace", from: "draft", busy: false, error: null, conflict: null });
			const [importBox, setImportBox] = react.useState({ open: false, text: "", scope: "workspace", busy: false, feedback: null, document: null, summary: null, decision: "cancel", result: null });
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
			// ---- Export: .json download (primary) + read-only viewer/copy ----
			const openExport = (row) => {
				if (typeof props.presetExport !== "function" || rowAction?.busy) return;
				setRowAction({ presetId: row.presetId, scope: row.scope, kind: "export", busy: true, error: null, text: null, copied: false, downloaded: false, fileName: null });
				// The default export format is the version-2 package (D6): the file
				// the user downloads and shares.
				props.presetExport(props.sessionId, { scope: row.scope, presetId: row.presetId }).then((response) => {
					const view = model.presetExportTextOf(response);
					if (view.kind === "ok") {
						setRowAction({ presetId: row.presetId, scope: row.scope, kind: "export", busy: false, error: null, text: view.text, copied: false, downloaded: false, fileName: model.exportFileNameOf(row.name, row.presetId) });
					} else {
						setRowAction({ presetId: row.presetId, scope: row.scope, kind: "export", busy: false, error: t("capability.presets.exportFailed", "Export failed."), text: null, copied: false, downloaded: false, fileName: null });
					}
				}).catch(() => setRowAction({ presetId: row.presetId, scope: row.scope, kind: "export", busy: false, error: t("capability.presets.exportFailed", "Export failed."), text: null, copied: false, downloaded: false, fileName: null }));
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
			// Blob + anchor download; every host capability is looked up lazily so
			// a shell without URL.createObjectURL simply no-ops.
			const downloadExport = () => {
				if (!rowAction?.text || rowAction.busy) return;
				try {
					const BlobCtor = globalThis.Blob;
					const urlApi = globalThis.URL;
					const doc = globalThis.document;
					if (typeof BlobCtor !== "function" || typeof urlApi?.createObjectURL !== "function" || typeof doc?.createElement !== "function") return;
					const blob = new BlobCtor([rowAction.text], { type: "application/json" });
					const href = urlApi.createObjectURL(blob);
					const anchor = doc.createElement("a");
					anchor.href = href;
					anchor.download = rowAction.fileName ?? "preset.json";
					anchor.click();
					if (typeof urlApi.revokeObjectURL === "function") urlApi.revokeObjectURL(href);
					setRowAction({ ...rowAction, downloaded: true });
				} catch {
					// download unavailable in this shell: the viewer/copy path remains
				}
			};
			// ---- Import: v2 packages take the D6 two-phase flow (dry-run summary
			// first, ALWAYS, then an explicit confirm with the collision decision);
			// v1 documents keep the single-step categorized feedback. ----
			const submitImport = (onNameConflict) => {
				if (typeof props.presetImport !== "function" || importBox.busy) return;
				let document = importBox.document;
				if (!onNameConflict) {
					try {
						document = JSON.parse(importBox.text);
					} catch {
						setImportBox({ ...importBox, feedback: { kind: "invalid-json" }, document: null, summary: null, result: null });
						return;
					}
				}
				const spec = { document, scope: importBox.scope };
				if (onNameConflict) spec.onNameConflict = onNameConflict;
				// D6 phase one: a version-2 package NEVER installs on the first call —
				// the dry-run summarizes targets/counts/collisions with zero writes.
				if (model.packageVersionOf(document) === 2) spec.dryRun = true;
				setImportBox({ ...importBox, busy: true, feedback: null, document, summary: null, result: null });
				props.presetImport(props.sessionId, spec).then((response) => {
					if (spec.dryRun === true) {
						const phase = model.importDryRunOf(response);
						if (phase.kind === "summary") {
							setImportBox({ ...importBox, busy: false, feedback: null, document, summary: phase, decision: "cancel", result: null });
						} else {
							// A rejected/unsupported dry-run still wrote nothing.
							setImportBox({ ...importBox, busy: false, feedback: phase, document, summary: null, result: null });
						}
						return;
					}
					const feedback = model.importFeedbackOf(response);
					if (feedback.kind === "created") {
						setImportBox({ open: false, text: "", scope: importBox.scope, busy: false, feedback: null, document: null, summary: null, decision: "cancel", result: null });
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
			// D6 phase two: the explicit confirm — installation is this call's
			// main effect, carrying the collision decision from the summary.
			const confirmImport = (onNameConflict) => {
				if (typeof props.presetImport !== "function" || importBox.busy || !importBox.summary) return;
				if (!model.importConfirmReadyOf(importBox.summary, importBox.decision)) return;
				const spec = { document: importBox.document, scope: importBox.scope, onCollision: importBox.decision };
				if (onNameConflict) spec.onNameConflict = onNameConflict;
				setImportBox({ ...importBox, busy: true, feedback: null });
				props.presetImport(props.sessionId, spec).then((response) => {
					const outcome = model.importConfirmOutcomeOf(response);
					if (outcome.kind === "created") {
						setImportBox({ ...importBox, busy: false, feedback: null, summary: null, result: outcome });
						setNotice(t("capability.presets.importedPackage", "Imported: {installed} Skill(s) installed, {bound} MCP binding(s), {unresolved} unresolved ref(s).")
							.replace("{installed}", String(outcome.installed.length))
							.replace("{bound}", String(outcome.bound))
							.replace("{unresolved}", String(outcome.unresolved)));
						refreshPresets();
					} else if (outcome.kind === "name-conflict") {
						// The summary stays up; the decision row offers replace/cancel.
						setImportBox({ ...importBox, busy: false, feedback: { kind: "name-conflict", with: outcome.with } });
					} else if (outcome.kind === "error") {
						setImportBox({ ...importBox, busy: false, feedback: { kind: "error" } });
					} else {
						// install-failed (with the rollback count), no-target-root,
						// rejected, no-workspace: the result surface names them.
						setImportBox({ ...importBox, busy: false, feedback: null, summary: null, result: outcome });
					}
				}).catch(() => setImportBox({ ...importBox, busy: false, feedback: { kind: "error" } }));
			};
			// Cancel after the summary: only the dry-run ran, so nothing was
			// written; the pasted text stays for editing.
			const cancelImportSummary = () => setImportBox({ ...importBox, busy: false, feedback: null, document: null, summary: null, decision: "cancel", result: null });
			const closeImportResult = () => setImportBox({ open: false, text: "", scope: importBox.scope, busy: false, feedback: null, document: null, summary: null, decision: "cancel", result: null });
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
					style: S.preset,
					children: [
						react_jsx_runtime.jsxs("div", {
							style: S.row,
							children: [
								react_jsx_runtime.jsx("span", { style: S.name, title: row.name, children: row.name }),
								react_jsx_runtime.jsx("span", {
									style: S.badge(row.scope),
									children: row.scope === "global" ? t("capability.presets.scopeGlobal", "global") : t("capability.presets.scopeWorkspace", "workspace")
								}),
								react_jsx_runtime.jsx("span", { style: S.summary, children: countText(row.counts.skills, row.counts.mcpServers) + unresolvedSuffix }),
								react_jsx_runtime.jsx("button", {
									type: "button",
									style: active && rowAction.busy ? { ...S.primary, ...S.disabled } : S.primary,
									...ring,
									disabled: active && rowAction.busy,
									onClick: () => loadPreset(row),
									children: active && rowAction.kind === "load" && rowAction.busy ? t("capability.presets.loading", "Loading…") : t("capability.presets.load", "Load")
								}),
								react_jsx_runtime.jsx("button", {
									type: "button",
									style: active && rowAction.busy ? { ...S.button, ...S.disabled } : S.button,
									...ring,
									...hover(HOVER_BG, "none"),
									disabled: active && rowAction.busy,
									onClick: () => (active && rowAction.kind === "export" ? setRowAction(null) : openExport(row)),
									children: t("capability.presets.export", "Export")
								}),
								react_jsx_runtime.jsx("button", {
									type: "button",
									style: active && rowAction.busy ? { ...S.dangerOutline, ...S.disabled } : S.dangerOutline,
									...ring,
									...hover(tint(DANGER, 10), "none"),
									disabled: active && rowAction.busy,
									onClick: () => (active && rowAction.kind === "delete" ? setRowAction(null) : setRowAction({ presetId: row.presetId, scope: row.scope, kind: "delete", busy: false, error: null })),
									children: t("capability.presets.delete", "Delete")
								})
							]
						}),
						active && rowAction.kind === "load" && rowAction.error
							? react_jsx_runtime.jsx("div", { style: S.warn, children: rowAction.error })
							: null,
						active && rowAction.kind === "delete"
							? react_jsx_runtime.jsxs("div", {
								style: S.strip,
								children: [
									react_jsx_runtime.jsx("span", { children: t("capability.presets.deleteConfirm", "Delete preset \"{name}\"? This cannot be undone.").replace("{name}", row.name) }),
									react_jsx_runtime.jsxs("div", {
										style: S.buttonRow,
										children: [
											react_jsx_runtime.jsx("button", {
												type: "button",
												style: rowAction.busy ? { ...S.danger, ...S.disabled } : S.danger,
												...ring,
												disabled: rowAction.busy,
												onClick: () => confirmDelete(row),
												children: rowAction.busy ? t("capability.presets.deleting", "Deleting…") : t("capability.presets.deleteConfirmButton", "Delete preset")
											}),
											react_jsx_runtime.jsx("button", {
												type: "button",
												style: rowAction.busy ? { ...S.button, ...S.disabled } : S.button,
												...ring,
												...hover(HOVER_BG, "none"),
												disabled: rowAction.busy,
												onClick: () => setRowAction(null),
												children: t("capability.presets.cancel", "Cancel")
											}),
											rowAction.error ? react_jsx_runtime.jsx("span", { style: S.warn, children: rowAction.error }) : null
										]
									})
								]
							})
							: null,
						active && rowAction.kind === "export"
							? react_jsx_runtime.jsxs("div", {
								style: { ...S.card, margin: "6px 0 0" },
								children: [
									rowAction.busy
										? react_jsx_runtime.jsx("span", { style: S.hint, children: t("capability.loading", "Loading capabilities…") })
										: rowAction.text
											? react_jsx_runtime.jsx("textarea", { style: S.textarea, ...ring, readOnly: true, value: rowAction.text, "aria-label": t("capability.presets.exportLabel", "Preset JSON") })
											: null,
									react_jsx_runtime.jsxs("div", {
										style: S.buttonRow,
										children: [
											rowAction.text
												? react_jsx_runtime.jsx("button", {
													type: "button",
													style: S.primary,
													...ring,
													...hover(ACCENT_HOVER, ACCENT),
													onClick: downloadExport,
													children: rowAction.downloaded ? t("capability.presets.downloaded", "Downloaded") : t("capability.presets.exportDownload", "Download .json")
												})
												: null,
											rowAction.text
												? react_jsx_runtime.jsx("button", {
													type: "button",
													style: S.button,
													...ring,
													...hover(HOVER_BG, "none"),
													onClick: copyExport,
													children: rowAction.copied ? t("capability.presets.copied", "Copied") : t("capability.presets.copy", "Copy to clipboard")
												})
												: null,
											react_jsx_runtime.jsx("button", {
												type: "button",
												style: S.button,
												...ring,
												...hover(HOVER_BG, "none"),
												onClick: () => setRowAction(null),
												children: t("capability.presets.close", "Close")
											}),
											rowAction.error ? react_jsx_runtime.jsx("span", { style: S.warn, children: rowAction.error }) : null
										]
									})
								]
							})
							: null
					]
				}, `${row.scope}:${row.presetId}`);
			};
			const presetGroup = (title, rows, emptyText) => react_jsx_runtime.jsxs("div", {
				style: S.section,
				children: [
					react_jsx_runtime.jsx("div", { style: S.title, children: title }),
					rows.length === 0
						? react_jsx_runtime.jsx("div", { style: S.hint, children: emptyText })
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
			// Small tonal badge naming a Skill's install target scope
			// (project = this workspace, user = this machine's user root).
			const scopeBadge = (scope) => react_jsx_runtime.jsx("span", {
				style: S.badge(scope),
				children: scope === "user" ? t("capability.presets.scopeUser", "user") : t("capability.presets.scopeProject", "project")
			});
			const fileCountText = (n) => t("capability.presets.importFiles", "{n} file(s)").replace("{n}", String(n));
			// D6 phase-one surface: the dry-run summary. Every install target,
			// file count, collision and unresolved ref is named BEFORE any write;
			// the confirm carries the collision decision.
			const importSummaryChildren = (summary) => {
				const installRow = (row) => react_jsx_runtime.jsxs("div", {
					style: S.row,
					children: [
						scopeBadge(row.targetScope),
						react_jsx_runtime.jsx("span", { style: S.name, title: row.name, children: row.name }),
						react_jsx_runtime.jsx("span", { style: { ...S.summary, flex: "none" }, children: fileCountText(row.fileCount) }),
						row.collision
							? react_jsx_runtime.jsx("span", { style: S.warn, children: t("capability.presets.importCollision", "name collision") })
							: (row.targetRoot ? react_jsx_runtime.jsx("span", { style: { ...S.hint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: row.targetRoot, children: row.targetRoot }) : null)
					]
				}, `install:${row.targetScope}:${row.name}`);
				return [
					react_jsx_runtime.jsx("div", { style: S.cardTitle, children: t("capability.presets.importSummaryTitle", "Import summary — review before anything is written") }),
					summary.install.length === 0
						? react_jsx_runtime.jsx("div", { style: S.hint, children: t("capability.presets.importNoInstalls", "This package bundles no Skills to install.") })
						: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: summary.install.map(installRow) }),
					summary.unresolved.length > 0
						? react_jsx_runtime.jsxs("div", {
							children: [
								react_jsx_runtime.jsx("div", { style: S.title, children: t("capability.presets.importUnresolvedTitle", "Unresolved refs — not installed:") }),
								...summary.unresolved.map((ref, index) => react_jsx_runtime.jsx("div", { style: S.hint, children: model.unresolvedLabelOf(ref) }, `unresolved:${index}`))
							]
						})
						: null,
					summary.hasCollisions
						? react_jsx_runtime.jsxs("label", {
							style: S.label,
							children: [
								t("capability.presets.importCollisionDecision", "When a bundled Skill name already exists:"),
								react_jsx_runtime.jsxs("select", {
									style: S.select,
									value: importBox.decision,
									"data-weir-import-decision": "",
									...ring,
									onChange: (event) => setImportBox({ ...importBox, decision: event.target.value }),
									children: [
										react_jsx_runtime.jsx("option", { value: "cancel", children: t("capability.presets.collisionCancel", "skip it (default)") }),
										react_jsx_runtime.jsx("option", { value: "replace", children: t("capability.presets.collisionReplace", "replace it") }),
										react_jsx_runtime.jsx("option", { value: "coexist", children: t("capability.presets.collisionCoexist", "keep both, renamed") })
									]
								})
							]
						})
						: null,
					importFeedback && importFeedback.kind === "name-conflict"
						? react_jsx_runtime.jsxs("div", {
							style: S.strip,
							children: [
								react_jsx_runtime.jsx("span", { children: t("capability.presets.importNameConflict", "A preset with this name already exists here.") }),
								react_jsx_runtime.jsxs("div", {
									style: S.buttonRow,
									children: [
										react_jsx_runtime.jsx("button", {
											type: "button",
											style: importBox.busy ? { ...S.dangerOutline, ...S.disabled } : S.dangerOutline,
											...ring,
											disabled: importBox.busy,
											onClick: () => confirmImport("replace"),
											children: t("capability.presets.replace", "Replace it")
										}),
										react_jsx_runtime.jsx("button", {
											type: "button",
											style: importBox.busy ? { ...S.button, ...S.disabled } : S.button,
											...ring,
											...hover(HOVER_BG, "none"),
											disabled: importBox.busy,
											onClick: cancelImportSummary,
											children: t("capability.presets.cancel", "Cancel")
										})
									]
								})
							]
						})
						: null,
					react_jsx_runtime.jsxs("div", {
						style: S.buttonRow,
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: (importBox.busy || !model.importConfirmReadyOf(summary, importBox.decision)) ? { ...S.primary, ...S.disabled } : S.primary,
								...ring,
								disabled: importBox.busy || !model.importConfirmReadyOf(summary, importBox.decision),
								onClick: () => confirmImport(undefined),
								children: importBox.busy ? t("capability.presets.importing", "Importing…") : t("capability.presets.importConfirm", "Confirm import")
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: importBox.busy ? { ...S.button, ...S.disabled } : S.button,
								...ring,
								...hover(HOVER_BG, "none"),
								disabled: importBox.busy,
								onClick: cancelImportSummary,
								children: t("capability.presets.cancel", "Cancel")
							})
						]
					})
				];
			};
			// D6 phase-two surface: the confirmed outcome — installed rows (which
			// stay UNSELECTED until a draft pick + Apply), collision decisions,
			// or the failure with its rollback note.
			const importResultChildren = (result) => {
				if (result.kind !== "created") {
					const text = result.kind === "install-failed"
						? t("capability.presets.importInstallFailed", "Installation failed: {reason} — rolled back {n} file(s); no preset was created.").replace("{reason}", result.reason).replace("{n}", String(result.rolledBack))
						: result.kind === "no-target-root"
							? t("capability.presets.importNoTargetRoot", "No {scope} Skill root is available on this host — nothing was installed.").replace("{scope}", result.targetScope)
							: result.kind === "rejected"
								? t("capability.presets.importRejected", "Rejected: {reason} — nothing was written.").replace("{reason}", result.reason)
								: t("capability.presets.noWorkspace", "This session has no workspace.");
					return [
						react_jsx_runtime.jsx("div", { style: S.warn, children: text }),
						react_jsx_runtime.jsx("div", {
							style: S.buttonRow,
							children: react_jsx_runtime.jsx("button", {
								type: "button",
								style: S.button,
								...ring,
								...hover(HOVER_BG, "none"),
								onClick: closeImportResult,
								children: t("capability.presets.close", "Close")
							})
						})
					];
				}
				const installedRow = (row) => react_jsx_runtime.jsxs("div", {
					style: S.row,
					children: [
						scopeBadge(row.targetScope),
						react_jsx_runtime.jsx("span", { style: S.name, title: row.name, children: row.name }),
						react_jsx_runtime.jsx("span", { style: S.summary, children: `${fileCountText(row.fileCount)} · ${row.status}` })
					]
				}, `installed:${row.targetScope}:${row.name}`);
				const collisionRow = (row) => react_jsx_runtime.jsxs("div", {
					style: S.row,
					children: [
						scopeBadge(row.targetScope),
						react_jsx_runtime.jsx("span", { style: S.name, title: row.name, children: row.name }),
						react_jsx_runtime.jsx("span", { style: S.warn, children: row.decision })
					]
				}, `collision:${row.targetScope}:${row.name}`);
				return [
					react_jsx_runtime.jsx("div", { style: S.cardTitle, children: t("capability.presets.importResultTitle", "Import result") }),
					result.installed.length > 0 ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: result.installed.map(installedRow) }) : null,
					result.collisions.length > 0 ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: result.collisions.map(collisionRow) }) : null,
					react_jsx_runtime.jsx("div", { style: S.hint, children: t("capability.presets.importInstalledNote", "Installed Skills stay unselected — pick them in the draft and Apply to activate.") }),
					react_jsx_runtime.jsx("div", {
						style: S.buttonRow,
						children: react_jsx_runtime.jsx("button", {
							type: "button",
							style: S.button,
							...ring,
							...hover(HOVER_BG, "none"),
							onClick: closeImportResult,
							children: t("capability.presets.close", "Close")
						})
					})
				];
			};
			return react_jsx_runtime.jsxs("div", {
				children: [
					react_jsx_runtime.jsxs("div", {
						style: S.buttonRow,
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: typeof props.presetSave !== "function" ? { ...S.button, ...S.disabled } : S.button,
								...ring,
								...hover(HOVER_BG, "none"),
								disabled: typeof props.presetSave !== "function",
								onClick: () => setSaveForm({ ...saveForm, open: !saveForm.open, error: null, conflict: null }),
								children: saveForm.open ? t("capability.presets.cancel", "Cancel") : t("capability.presets.saveOpen", "Save as preset…")
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: typeof props.presetImport !== "function" ? { ...S.button, ...S.disabled } : S.button,
								...ring,
								...hover(HOVER_BG, "none"),
								disabled: typeof props.presetImport !== "function",
								onClick: () => setImportBox({ ...importBox, open: !importBox.open, feedback: null, document: null, summary: null, decision: "cancel", result: null }),
								children: importBox.open ? t("capability.presets.cancel", "Cancel") : t("capability.presets.importOpen", "Import…")
							})
						]
					}),
					notice ? react_jsx_runtime.jsx("div", { style: S.notice, children: notice }) : null,
					saveForm.open
						? react_jsx_runtime.jsxs("div", {
							style: S.card,
							children: [
								react_jsx_runtime.jsx("div", { style: S.cardTitle, children: t("capability.presets.saveTitle", "Save as preset") }),
								react_jsx_runtime.jsx("input", {
									style: S.input,
									...ring,
									placeholder: t("capability.presets.name", "Preset name"),
									value: saveForm.name,
									onChange: (event) => setSaveForm({ ...saveForm, name: event.target.value, error: null })
								}),
								react_jsx_runtime.jsxs("div", {
									style: S.buttonRow,
									children: [
										react_jsx_runtime.jsxs("label", {
											style: S.label,
											children: [
												t("capability.presets.namespace", "Namespace"),
												react_jsx_runtime.jsxs("select", {
													style: S.select,
													value: saveForm.scope,
													...ring,
													onChange: (event) => setSaveForm({ ...saveForm, scope: event.target.value }),
													children: [
														react_jsx_runtime.jsx("option", { value: "workspace", children: t("capability.presets.scopeWorkspace", "workspace") }),
														react_jsx_runtime.jsx("option", { value: "global", children: t("capability.presets.scopeGlobal", "global") })
													]
												})
											]
										}),
										react_jsx_runtime.jsxs("label", {
											style: S.label,
											children: [
												t("capability.presets.source", "From"),
												react_jsx_runtime.jsxs("select", {
													style: S.select,
													value: saveForm.from,
													...ring,
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
										style: S.strip,
										children: [
											react_jsx_runtime.jsx("span", { children: t("capability.presets.nameConflict", "A preset named \"{name}\" already exists in this namespace.").replace("{name}", saveForm.name.trim()) }),
											react_jsx_runtime.jsxs("div", {
												style: S.buttonRow,
												children: [
													react_jsx_runtime.jsx("button", {
														type: "button",
														style: saveForm.busy ? { ...S.button, ...S.disabled } : S.button,
														...ring,
														...hover(HOVER_BG, "none"),
														disabled: saveForm.busy,
														onClick: () => setSaveForm({ ...saveForm, conflict: null, error: t("capability.presets.renameHint", "Edit the name, then save again.") }),
														children: t("capability.presets.rename", "Rename…")
													}),
													react_jsx_runtime.jsx("button", {
														type: "button",
														style: saveForm.busy ? { ...S.dangerOutline, ...S.disabled } : S.dangerOutline,
														...ring,
														disabled: saveForm.busy,
														onClick: () => submitSave("replace"),
														children: t("capability.presets.replace", "Replace it")
													}),
													react_jsx_runtime.jsx("button", {
														type: "button",
														style: saveForm.busy ? { ...S.button, ...S.disabled } : S.button,
														...ring,
														...hover(HOVER_BG, "none"),
														disabled: saveForm.busy,
														onClick: () => setSaveForm({ ...saveForm, open: false, conflict: null }),
														children: t("capability.presets.cancel", "Cancel")
													})
												]
											})
										]
									})
									: null,
								react_jsx_runtime.jsxs("div", {
									style: S.buttonRow,
									children: [
										react_jsx_runtime.jsx("button", {
											type: "button",
											style: saveForm.busy ? { ...S.primary, ...S.disabled } : S.primary,
											...ring,
											...(saveForm.busy ? {} : hover(ACCENT_HOVER, ACCENT)),
											disabled: saveForm.busy,
											onClick: () => submitSave(undefined),
											children: saveForm.busy ? t("capability.presets.saving", "Saving…") : t("capability.presets.save", "Save preset")
										}),
										saveForm.error ? react_jsx_runtime.jsx("span", { style: S.warn, children: saveForm.error }) : null
									]
								})
							]
						})
						: null,
					importBox.open
						? react_jsx_runtime.jsxs("div", {
							style: S.card,
							...(importBox.result
								? { "data-weir-import-result": "" }
								: importBox.summary
									? { "data-weir-import-summary": "" }
									: {}),
							children: importBox.result
								? importResultChildren(importBox.result)
								: importBox.summary
									? importSummaryChildren(importBox.summary)
									: [
										react_jsx_runtime.jsx("div", { style: S.cardTitle, children: t("capability.presets.importTitle", "Import preset") }),
										react_jsx_runtime.jsx("textarea", {
											style: S.textarea,
											...ring,
											placeholder: t("capability.presets.importPlaceholder", "Paste a portable preset document (JSON)…"),
											value: importBox.text,
											onChange: (event) => setImportBox({ ...importBox, text: event.target.value, feedback: null, document: null, summary: null, result: null })
										}),
										react_jsx_runtime.jsxs("div", {
											style: S.buttonRow,
											children: [
												react_jsx_runtime.jsxs("label", {
													style: S.label,
													children: [
														t("capability.presets.namespace", "Namespace"),
														react_jsx_runtime.jsxs("select", {
															style: S.select,
															value: importBox.scope,
															...ring,
															onChange: (event) => setImportBox({ ...importBox, scope: event.target.value }),
															children: [
																react_jsx_runtime.jsx("option", { value: "workspace", children: t("capability.presets.scopeWorkspace", "workspace") }),
																react_jsx_runtime.jsx("option", { value: "global", children: t("capability.presets.scopeGlobal", "global") })
															]
														})
													]
												}),
												react_jsx_runtime.jsx("button", {
													type: "button",
													style: (importBox.busy || importBox.text.trim() === "") ? { ...S.primary, ...S.disabled } : S.primary,
													...ring,
													disabled: importBox.busy || importBox.text.trim() === "",
													onClick: () => submitImport(undefined),
													children: importBox.busy ? t("capability.presets.importing", "Importing…") : t("capability.presets.importSubmit", "Import")
												})
											]
										}),
										importFeedback && importFeedback.kind === "invalid-json"
											? react_jsx_runtime.jsx("div", { style: S.warn, children: t("capability.presets.importInvalidJson", "Not valid JSON — nothing was written.") })
											: null,
										importFeedback && importFeedback.kind === "rejected"
											? react_jsx_runtime.jsx("div", { style: S.warn, children: t("capability.presets.importRejected", "Rejected: {reason} — nothing was written.").replace("{reason}", importFeedback.reason) })
											: null,
										importFeedback && importFeedback.kind === "name-conflict"
											? react_jsx_runtime.jsxs("div", {
												style: S.strip,
												children: [
													react_jsx_runtime.jsx("span", { children: t("capability.presets.importNameConflict", "A preset with this name already exists here.") }),
													react_jsx_runtime.jsxs("div", {
														style: S.buttonRow,
														children: [
															react_jsx_runtime.jsx("button", {
																type: "button",
																style: importBox.busy ? { ...S.dangerOutline, ...S.disabled } : S.dangerOutline,
																...ring,
																disabled: importBox.busy,
																onClick: () => submitImport("replace"),
																children: t("capability.presets.replace", "Replace it")
															}),
															react_jsx_runtime.jsx("button", {
																type: "button",
																style: importBox.busy ? { ...S.button, ...S.disabled } : S.button,
																...ring,
																...hover(HOVER_BG, "none"),
																disabled: importBox.busy,
																onClick: () => setImportBox({ ...importBox, feedback: null, document: null }),
																children: t("capability.presets.cancel", "Cancel")
															})
														]
													})
												]
											})
											: null,
										importFeedback && importFeedback.kind === "no-workspace"
											? react_jsx_runtime.jsx("div", { style: S.warn, children: t("capability.presets.noWorkspace", "This session has no workspace.") })
											: null,
										importFeedback && importFeedback.kind === "error"
											? react_jsx_runtime.jsx("div", { style: S.warn, children: t("capability.presets.importFailed", "Import failed — nothing was written.") })
											: null
									]
						})
						: null,
					list === null
						? react_jsx_runtime.jsx("div", { style: S.hint, children: t("capability.loading", "Loading capabilities…") })
						: list.error
							? react_jsx_runtime.jsx("div", { style: S.hint, children: t("capability.presets.unavailable", "Presets are unavailable on this host.") })
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
						style: { ...S.card, ...S.section },
						children: [
							react_jsx_runtime.jsx("div", { style: S.cardTitle, children: t("capability.presets.defaultTitle", "Workspace default for new sessions") }),
							defaultState === null
								? react_jsx_runtime.jsx("div", { style: S.hint, children: t("capability.loading", "Loading capabilities…") })
								: defaultState.kind === "error"
									? react_jsx_runtime.jsx("div", { style: S.hint, children: t("capability.presets.defaultUnavailable", "The workspace default is unavailable.") })
									: defaultState.kind === "unsupported"
										? react_jsx_runtime.jsx("div", { style: S.hint, children: t("capability.presets.noWorkspace", "This session has no workspace.") })
										: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
											children: [
												react_jsx_runtime.jsx("div", {
													style: S.hint,
													children: defaultState.kind === "none"
														? t("capability.presets.defaultNone", "No default is set — new sessions use the builtin baseline.")
														: defaultState.kind === "empty"
															? t("capability.presets.defaultEmpty", "An explicit empty default is set: new sessions start with 0 skills · 0 MCP.")
															: t("capability.presets.defaultEntries", "Default: {counts}").replace("{counts}", countText(defaultState.skills, defaultState.mcpServers))
												}),
												defaultState.kind === "entries" && defaultState.unresolvedRefs > 0
													? react_jsx_runtime.jsx("div", { style: S.hint, children: t("capability.presets.defaultUnresolved", "…with {n} unresolved ref(s) reported on resolve.").replace("{n}", String(defaultState.unresolvedRefs)) })
													: null,
												react_jsx_runtime.jsxs("div", {
													style: S.buttonRow,
													children: [
														react_jsx_runtime.jsx("button", {
															type: "button",
															style: (props.draft === null || typeof props.defaultSave !== "function") ? { ...S.button, ...S.disabled } : S.button,
															...ring,
															...hover(HOVER_BG, "none"),
															disabled: props.draft === null || typeof props.defaultSave !== "function",
															title: props.draft === null ? t("capability.presets.needsReceipt", "Unavailable until the session receipt loads.") : undefined,
															onClick: () => setDefaultBox({ ...defaultBox, confirm: defaultBox.confirm === "save" ? null : "save", error: null }),
															children: t("capability.presets.defaultSaveOpen", "Save as default…")
														}),
														defaultState.kind !== "none"
															? react_jsx_runtime.jsx("button", {
																type: "button",
																style: typeof props.defaultClear !== "function" ? { ...S.dangerOutline, ...S.disabled } : S.dangerOutline,
																...ring,
																...hover(tint(DANGER, 10), "none"),
																disabled: typeof props.defaultClear !== "function",
																onClick: () => setDefaultBox({ ...defaultBox, confirm: defaultBox.confirm === "clear" ? null : "clear", error: null }),
																children: t("capability.presets.defaultClearOpen", "Clear default…")
															})
															: null
													]
												}),
												defaultBox.confirm === "save"
													? react_jsx_runtime.jsxs("div", {
														style: S.strip,
														children: [
															react_jsx_runtime.jsxs("div", {
																style: S.label,
																children: [
																	t("capability.presets.source", "From"),
																	react_jsx_runtime.jsxs("select", {
																		style: S.select,
																		value: defaultBox.from,
																		...ring,
																		onChange: (event) => setDefaultBox({ ...defaultBox, from: event.target.value }),
																		children: [
																			react_jsx_runtime.jsx("option", { value: "draft", children: t("capability.presets.fromDraft", "current draft") }),
																			react_jsx_runtime.jsx("option", { value: "applied", children: t("capability.presets.fromApplied", "applied selection") })
																		]
																	})
																]
															}),
															react_jsx_runtime.jsx("span", {
																children: defaultFromCounts
																	? t("capability.presets.defaultSaveConfirm", "Save {counts} as this workspace's default? New sessions in this workspace will start from it; the current session does not change.").replace("{counts}", countText(defaultFromCounts.skills, defaultFromCounts.mcpServers))
																	: t("capability.presets.needsReceipt", "Unavailable until the session receipt loads.")
															}),
															react_jsx_runtime.jsxs("div", {
																style: S.buttonRow,
																children: [
																	react_jsx_runtime.jsx("button", {
																		type: "button",
																		style: (defaultBox.busy || !defaultFromCounts) ? { ...S.primary, ...S.disabled } : S.primary,
																		...ring,
																		disabled: defaultBox.busy || !defaultFromCounts,
																		onClick: submitDefaultSave,
																		children: defaultBox.busy ? t("capability.presets.saving", "Saving…") : t("capability.presets.defaultSaveConfirmButton", "Save default")
																	}),
																	react_jsx_runtime.jsx("button", {
																		type: "button",
																		style: defaultBox.busy ? { ...S.button, ...S.disabled } : S.button,
																		...ring,
																		...hover(HOVER_BG, "none"),
																		disabled: defaultBox.busy,
																		onClick: () => setDefaultBox({ ...defaultBox, confirm: null, error: null }),
																		children: t("capability.presets.cancel", "Cancel")
																	}),
																	defaultBox.error ? react_jsx_runtime.jsx("span", { style: S.warn, children: defaultBox.error }) : null
																]
															})
														]
													})
													: null,
												defaultBox.confirm === "clear"
													? react_jsx_runtime.jsxs("div", {
														style: S.strip,
														children: [
															react_jsx_runtime.jsx("span", { children: t("capability.presets.defaultClearConfirm", "Clear the workspace default? New sessions return to the builtin baseline; open sessions do not change.") }),
															react_jsx_runtime.jsxs("div", {
																style: S.buttonRow,
																children: [
																	react_jsx_runtime.jsx("button", {
																		type: "button",
																		style: defaultBox.busy ? { ...S.danger, ...S.disabled } : S.danger,
																		...ring,
																		disabled: defaultBox.busy,
																		onClick: submitDefaultClear,
																		children: defaultBox.busy ? t("capability.presets.clearing", "Clearing…") : t("capability.presets.defaultClearConfirmButton", "Clear default")
																	}),
																	react_jsx_runtime.jsx("button", {
																		type: "button",
																		style: defaultBox.busy ? { ...S.button, ...S.disabled } : S.button,
																		...ring,
																		...hover(HOVER_BG, "none"),
																		disabled: defaultBox.busy,
																		onClick: () => setDefaultBox({ ...defaultBox, confirm: null, error: null }),
																		children: t("capability.presets.cancel", "Cancel")
																	}),
																	defaultBox.error ? react_jsx_runtime.jsx("span", { style: S.warn, children: defaultBox.error }) : null
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
