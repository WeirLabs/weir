window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.capability-manager.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Capability manager view tree (lazy) ----
		// One shared component tree mounted by two shells (D1): the composer
		// popover (Badge fallback, absolute overlay frame) and the right-sidebar
		// capabilities panel (static full-width frame) — the shell name arrives
		// as a prop; the tree below never branches on the mount point beyond the
		// root frame style. Three views (Skills / MCP / Presets): scope-grouped
		// skill rows with real checkboxes, description second lines and
		// source/conflict/missing marks; managed/unmanaged MCP groups with a
		// per-field-validated add form; the preset lifecycle view lives in its
		// own chunk pulled only when the Presets view is selected (the load runs
		// through the composition root's loadPresets verb — no chunk-to-chunk
		// require.async waterfall). Every list decision comes from the pure
		// model; an unsupported condition set renders as an explicit state,
		// never as hidden controls (12.2).
		const popoverFrameStyle = {
			position: "absolute",
			bottom: "calc(100% + 8px)",
			left: 0,
			minWidth: "320px",
			maxWidth: "420px",
			maxHeight: "420px",
			overflow: "auto",
			// Only tokens the shell actually defines: bg-overlay is the popover
			// surface (a hard #fff fallback goes invisible under a dark theme).
			background: "var(--dsw-alias-bg-overlay, #fff)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-md)",
			boxShadow: "var(--dsw-shadow-l2, 0 4px 16px rgba(0,0,0,.12))",
			padding: "10px",
			fontSize: "12px",
			color: "var(--dsw-alias-label-primary, inherit)"
		};
		// Sidebar frame: a full-height flex column — the pane does NOT scroll
		// arbitrary cell content, so the frame pins its own height and the view
		// region between header and footer scrolls (see the render shell branch).
		const sidebarFrameStyle = {
			display: "flex",
			flexDirection: "column",
			gap: "2px",
			height: "100%",
			minHeight: 0,
			boxSizing: "border-box",
			padding: "10px",
			fontSize: "12px",
			color: "var(--dsw-alias-label-primary, inherit)"
		};
		const headerRowStyle = { display: "flex", gap: "6px", alignItems: "center", marginBottom: "6px" };
		const tabButtonStyle = (active) => ({
			fontSize: "12px",
			lineHeight: "16px",
			padding: "2px 8px",
			cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			background: active ? "var(--dsw-alias-interactive-bg-solid, rgba(127,127,127,.14))" : "none",
			color: "var(--dsw-alias-label-primary, inherit)"
		});
		const searchInputStyle = { flex: 1, minWidth: "72px", fontSize: "12px" };
		const groupTitleStyle = {
			fontSize: "11px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-secondary, #888)",
			margin: "8px 0 2px"
		};
		const rowStyle = { display: "flex", alignItems: "flex-start", gap: "6px", padding: "3px 0" };
		const checkboxStyle = { marginTop: "1px", flex: "none" };
		const rowTextStyle = { display: "flex", flexDirection: "column", minWidth: 0, flex: 1 };
		const nameLineStyle = { display: "flex", gap: "6px", alignItems: "center", minWidth: 0, flexWrap: "wrap" };
		const nameTextStyle = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
		const descLineStyle = {
			fontSize: "11px",
			color: "var(--dsw-alias-label-secondary, #888)",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const tagStyle = {
			fontSize: "10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			padding: "0 4px",
			flex: "none",
			color: "var(--dsw-alias-label-secondary, #888)"
		};
		const warnTextStyle = { color: "var(--dsw-alias-state-warn-primary, #c80)", flex: "none" };
		const hintStyle = { color: "var(--dsw-alias-label-secondary, #888)", padding: "4px 0" };
		const footerStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			marginTop: "8px",
			paddingTop: "6px",
			display: "flex",
			flex: "none",
			gap: "6px",
			alignItems: "center",
			flexWrap: "wrap"
		};
		const diffSummaryStyle = { fontSize: "11px", color: "var(--dsw-alias-label-secondary, #888)" };
		const formBoxStyle = {
			display: "flex",
			flexDirection: "column",
			gap: "4px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			padding: "6px"
		};
		const inputStyle = { width: "100%", boxSizing: "border-box", fontSize: "12px" };
		const fieldErrorStyle = { fontSize: "11px", color: "var(--dsw-alias-state-warn-primary, #c80)" };
		// The Presets view chunk arrives only after its tab is selected; the
		// composition root owns the require.async specifier (loadPresets verb) so
		// this chunk keeps its react-only require face.
		function LazyCapabilityPresets(props) {
			const [impl, setImpl] = react.useState(null);
			const [loadFailed, setLoadFailed] = react.useState(false);
			react.useEffect(() => {
				if (typeof props.loadPresets !== "function") return undefined;
				let alive = true;
				Promise.resolve(props.loadPresets()).then(
					(chunk) => { if (alive) setImpl(() => chunk?.CapabilityPresetsView ?? null); },
					() => { if (alive) setLoadFailed(true); }
				);
				return () => { alive = false; };
			}, []);
			const t = props.t;
			if (typeof props.loadPresets !== "function" || loadFailed) {
				return react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.presets.unavailable", "Presets are unavailable on this host.") });
			}
			if (!impl) {
				return react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.loading", "Loading capabilities…") });
			}
			return react_jsx_runtime.jsx(impl, { ...props });
		}
		function CapabilityManagerPanel(props) {
			const model = props.model;
			// Echo-guard like the Badge: an unregistered dictionary entry must
			// surface the in-code fallback, never the raw key.
			const t = (key, fallback) => {
				// The host locale's second parameter is an interpolation VARS object,
				// never a fallback string — passing the fallback there crashes
				// translate whenever the registered template carries {placeholders}
				// (the 2026-10-05 badge slot crash). Dictionary templates keep their
				// placeholders for the call site's own .replace interpolation.
				const value = typeof props.t === "function" ? props.t(key) : undefined;
				return typeof value === "string" && value !== key ? value : fallback;
			};
			const [tab, setTab] = react.useState("skills");
			const [query, setQuery] = react.useState("");
			const [listing, setListing] = react.useState(null);
			const [conditions, setConditions] = react.useState(null);
			// Draft editing (12.3): seeded from the server receipt, toggles
			// recompute dirty, Apply goes through /capabilities apply with the
			// draft's CAS revision and a fresh request ID.
			const [draft, setDraft] = react.useState(null);
			const [commit, setCommit] = react.useState(null);
			// Managed MCP add form (8.1/8.2): per-field errors are derived by the
			// pure model (mcpAddErrorsOf) and shown after the first submit
			// attempt; the hook lives with the others — a hook after an early
			// return crashes with React #310.
			const [addForm, setAddForm] = react.useState({ open: false, identity: "", label: "", command: "", args: "", showErrors: false, error: null, busy: false });

			const refreshAll = () => {
				if (typeof props.fetchListing === "function") {
					props.fetchListing(props.sessionId).then((data) => setListing(data ?? { error: true })).catch(() => setListing({ error: true }));
				}
				if (typeof props.fetchReceipt === "function") {
					props.fetchReceipt(props.sessionId).then((receipt) => setDraft(receipt ? model.draftFromReceipt(receipt) : null)).catch(() => {});
				}
			};
			react.useEffect(() => {
				let alive = true;
				if (typeof props.fetchListing === "function") {
					// A failed or absent verb settles into an explicit error
					// state — never a perpetual loading panel (12.2).
					props.fetchListing(props.sessionId).then((data) => { if (alive) setListing(data ?? { error: true }); }).catch(() => { if (alive) setListing({ error: true }); });
				}
				if (typeof props.fetchConditions === "function") {
					props.fetchConditions(props.sessionId).then((data) => { if (alive) setConditions(data); }).catch(() => {});
				}
				if (typeof props.fetchReceipt === "function") {
					props.fetchReceipt(props.sessionId).then((receipt) => { if (alive) setDraft(receipt ? model.draftFromReceipt(receipt) : null); }).catch(() => {});
				}
				return () => { alive = false; };
			}, [props.sessionId]);
			const toggle = (kind, name) => {
				if (draft && commit?.phase !== "submitting") setDraft(model.draftToggle(draft, kind, name));
			};
			const applyDraft = () => {
				if (!draft || !draft.dirty || typeof props.applySelection !== "function") return;
				const requestId = crypto.randomUUID();
				setCommit({ phase: "submitting", requestId });
				props.applySelection(props.sessionId, {
					requestId,
					expectedRevision: draft.revision,
					skills: draft.skills,
					mcpServers: draft.mcpServers,
				}).then((response) => {
					const outcome = model.commitOutcomeOf(response);
					setCommit(outcome);
					if (outcome.phase === "applied") {
						refreshAll();
						// The Badge holds its own receipt state — tell it to re-pull
						// so the composer counts follow the Apply immediately.
						if (typeof props.onApplied === "function") props.onApplied();
					}
				}).catch(() => setCommit({ phase: "failed", error: "apply request failed", draftKept: true }));
			};
			const discardDraft = () => {
				if (draft) setDraft({ ...draft, skills: [...draft.applied.skills], mcpServers: [...draft.applied.mcpServers], dirty: false });
				setCommit(null);
			};
			// Load-into-draft staging (preset view): only the preset's resolved
			// sets enter the local draft; Apply stays the only path that changes
			// the session's applied set.
			const stagePreset = (document) => {
				if (commit?.phase === "submitting") return;
				setDraft(model.draftFromPreset(document, draft));
				setCommit(null);
			};
			// Managed MCP add form (8.1/8.2): registers a stdio server and mounts
			// it immediately via /capabilities mcp-add. Client-side per-field
			// validation first; the server's own status still surfaces verbatim.
			const addErrors = model.mcpAddErrorsOf(addForm);
			const submitAdd = () => {
				if (typeof props.mcpAdd !== "function" || addForm.busy) return;
				if (Object.keys(addErrors).length > 0) {
					setAddForm({ ...addForm, showErrors: true, error: null });
					return;
				}
				setAddForm({ ...addForm, busy: true, error: null });
				props.mcpAdd(props.sessionId, {
					identity: addForm.identity.trim(),
					label: addForm.label.trim() || addForm.identity.trim(),
					command: addForm.command.trim(),
					args: addForm.args.trim() ? addForm.args.trim().split(/\s+/) : [],
				}).then((result) => {
					if (result && result.status === "registered") {
						setAddForm({ open: false, identity: "", label: "", command: "", args: "", showErrors: false, error: null, busy: false });
						refreshAll();
					} else {
						setAddForm({ ...addForm, busy: false, error: (result && result.status) || "add failed" });
					}
				}).catch((cause) => setAddForm({ ...addForm, busy: false, error: String(cause) }));
			};
			const frameStyle = props.shell === "sidebar" ? sidebarFrameStyle : popoverFrameStyle;
			const conditionState = model.managerConditionState(conditions?.conditions ?? conditions);
			if (listing === null) return react_jsx_runtime.jsx("div", { style: frameStyle, children: t("capability.loading", "Loading capabilities…") });
			if (listing.error === true) return react_jsx_runtime.jsx("div", { style: frameStyle, children: t("capability.error", "Capabilities unavailable for this session.") });
			if (listing.error) return react_jsx_runtime.jsx("div", { style: frameStyle, children: t("capability.unavailable", "Capabilities are unavailable in this session.") });
			if (conditionState === "unsupported") {
				return react_jsx_runtime.jsx("div", { style: frameStyle, children: t("capability.unsupported", "Unsupported: consistency conditions are not met on this host.") });
			}
			const partition = model.partitionManagerListing(listing);
			const skillRows = model.groupSkillRows(model.filterSkillRows(partition.skills, query));
			const draftHas = (kind, name) => draft !== null && draft[kind].includes(name);
			const selectionDisabled = draft === null || commit?.phase === "submitting";
			const fieldError = (code) => code === "invalid"
				? t("capability.mcp.errorIdentityInvalid", "Letters, digits, \"-\" and \"_\" only; start with a letter or digit.")
				: t("capability.mcp.errorRequired", "Required.");
			const addField = (key, placeholder, errorCode) => react_jsx_runtime.jsxs("div", {
				children: [
					react_jsx_runtime.jsx("input", {
						style: inputStyle,
						placeholder,
						value: addForm[key],
						"aria-invalid": errorCode ? true : undefined,
						onChange: (event) => setAddForm({ ...addForm, [key]: event.target.value })
					}),
					errorCode ? react_jsx_runtime.jsx("div", { style: fieldErrorStyle, children: fieldError(errorCode) }) : null
				]
			}, key);
			const addBlock = tab === "mcp" ? react_jsx_runtime.jsxs("div", { style: { marginBottom: "6px" }, children: [
				!addForm.open
					? react_jsx_runtime.jsx("button", { type: "button", onClick: () => setAddForm({ ...addForm, open: true, showErrors: false, error: null }), children: t("capability.mcp.add", "+ Add managed MCP server") })
					: react_jsx_runtime.jsxs("div", { style: formBoxStyle, children: [
						addField("identity", t("capability.mcp.identity", "identity (e.g. my-docs)"), addForm.showErrors ? addErrors.identity : undefined),
						addField("label", t("capability.mcp.label", "label (display name, optional)"), undefined),
						addField("command", t("capability.mcp.command", "command (e.g. npx)"), addForm.showErrors ? addErrors.command : undefined),
						addField("args", t("capability.mcp.args", "args, space-separated (optional)"), undefined),
						react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }, children: [
							react_jsx_runtime.jsx("button", { type: "button", disabled: addForm.busy, onClick: submitAdd, children: addForm.busy ? t("capability.mcp.adding", "Adding…") : t("capability.mcp.addConfirm", "Add") }),
							react_jsx_runtime.jsx("button", { type: "button", onClick: () => setAddForm({ ...addForm, open: false, showErrors: false, error: null }), children: t("capability.mcp.cancel", "Cancel") }),
							addForm.error ? react_jsx_runtime.jsx("span", { style: warnTextStyle, children: String(addForm.error) }) : null
						] })
					] })
			] }) : null;
			const skillRow = (skill) => react_jsx_runtime.jsxs("label", {
				style: rowStyle,
				children: [
					react_jsx_runtime.jsx("input", {
						type: "checkbox",
						style: checkboxStyle,
						checked: draftHas("skills", skill.name),
						disabled: selectionDisabled,
						"aria-label": skill.name,
						onChange: () => toggle("skills", skill.name)
					}),
					react_jsx_runtime.jsxs("span", { style: rowTextStyle, children: [
						react_jsx_runtime.jsxs("span", { style: nameLineStyle, children: [
							react_jsx_runtime.jsx("span", { style: nameTextStyle, title: skill.name, children: skill.name }),
							react_jsx_runtime.jsx("span", { style: tagStyle, children: skill.source }),
							skill.conflict ? react_jsx_runtime.jsx("span", { style: warnTextStyle, children: t("capability.conflict", "conflict") }) : null,
							skill.missing ? react_jsx_runtime.jsx("span", { style: warnTextStyle, title: skill.status, children: t("capability.missing", "missing") }) : null
						] }),
						skill.description ? react_jsx_runtime.jsx("span", { style: descLineStyle, title: skill.description, children: skill.description }) : null
					] })
				]
			}, skill.name);
			const mcpRow = (server) => {
				const name = server.identity ?? server.serverName ?? "unknown";
				return react_jsx_runtime.jsxs("label", {
					style: rowStyle,
					children: [
						react_jsx_runtime.jsx("input", {
							type: "checkbox",
							style: checkboxStyle,
							checked: draftHas("mcpServers", name),
							disabled: selectionDisabled,
							"aria-label": name,
							onChange: () => toggle("mcpServers", name)
						}),
						react_jsx_runtime.jsxs("span", { style: { ...nameLineStyle, flex: 1 }, children: [
							react_jsx_runtime.jsx("span", { style: nameTextStyle, title: name, children: name }),
							react_jsx_runtime.jsx("span", { style: tagStyle, children: server.state === "mounted" ? t("capability.mcp.stateMounted", "mounted") : t("capability.mcp.stateRegistered", "registered") })
						] })
					]
				}, name);
			};
			const unmanagedRow = (server) => {
				const name = server.serverName ?? "unknown";
				return react_jsx_runtime.jsxs("div", {
					style: { ...rowStyle, alignItems: "center" },
					title: t("capability.mcp.unmanagedHint", "Configured outside Orrery; the selection cannot govern it."),
					children: [
						react_jsx_runtime.jsx("span", { style: { ...nameTextStyle, flex: 1 }, children: name }),
						react_jsx_runtime.jsx("span", { style: tagStyle, children: t("capability.unmanaged", "unmanaged") })
					]
				}, name);
			};
			const body = tab === "skills"
				? (skillRows.length === 0
					? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.noSkills", "No skills match.") })
					: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
						children: skillRows.map((group) => react_jsx_runtime.jsxs("div", {
							children: [
								react_jsx_runtime.jsx("div", { style: groupTitleStyle, children: group.label }),
								...group.rows.map(skillRow)
							]
						}, group.key))
					}))
				: tab === "mcp"
					? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
						children: [
							partition.mcpManaged.length > 0
								? react_jsx_runtime.jsxs("div", {
									children: [
										react_jsx_runtime.jsx("div", { style: groupTitleStyle, children: t("capability.mcp.groupManaged", "Orrery managed") }),
										...partition.mcpManaged.map(mcpRow)
									]
								}, "managed")
								: null,
							partition.mcpUnmanaged.length > 0
								? react_jsx_runtime.jsxs("div", {
									children: [
										react_jsx_runtime.jsx("div", { style: groupTitleStyle, children: t("capability.mcp.groupUnmanaged", "Unmanaged") }),
										...partition.mcpUnmanaged.map(unmanagedRow)
									]
								}, "unmanaged")
								: null,
							partition.mcpManaged.length === 0 && partition.mcpUnmanaged.length === 0
								? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("capability.mcp.none", "No MCP servers configured.") })
								: null
						]
					})
					: react_jsx_runtime.jsx(LazyCapabilityPresets, {
						sessionId: props.sessionId,
						model,
						t,
						draft,
						stagePreset,
						loadPresets: props.loadPresets,
						fetchPresets: props.fetchPresets,
						presetSave: props.presetSave,
						presetLoad: props.presetLoad,
						presetDelete: props.presetDelete,
						presetExport: props.presetExport,
						presetImport: props.presetImport,
						defaultGet: props.defaultGet,
						defaultSave: props.defaultSave,
						defaultClear: props.defaultClear
					});
			// Footer commit bar (12.3): the dirty diff summary (+n/−m) ahead of
			// the same Apply/Discard/commit-phase semantics as before.
			const diff = draft ? model.draftDiffOf(draft) : null;
			const diffText = diff && diff.any
				? [
					diff.skillsAdded > 0 ? t("capability.diff.addSkills", "+{n} skills").replace("{n}", String(diff.skillsAdded)) : null,
					diff.skillsRemoved > 0 ? t("capability.diff.removeSkills", "−{n} skills").replace("{n}", String(diff.skillsRemoved)) : null,
					diff.mcpAdded > 0 ? t("capability.diff.addMcp", "+{n} MCP").replace("{n}", String(diff.mcpAdded)) : null,
					diff.mcpRemoved > 0 ? t("capability.diff.removeMcp", "−{n} MCP").replace("{n}", String(diff.mcpRemoved)) : null
				].filter(Boolean).join(" · ")
				: null;
			return react_jsx_runtime.jsxs("div", { style: frameStyle, children: [
				react_jsx_runtime.jsxs("div", { style: headerRowStyle, children: [
					react_jsx_runtime.jsx("button", { type: "button", style: tabButtonStyle(tab === "skills"), onClick: () => setTab("skills"), "aria-pressed": tab === "skills", children: t("capability.tab.skills", "Skills") }),
					react_jsx_runtime.jsx("button", { type: "button", style: tabButtonStyle(tab === "mcp"), onClick: () => setTab("mcp"), "aria-pressed": tab === "mcp", children: t("capability.tab.mcp", "MCP") }),
					react_jsx_runtime.jsx("button", { type: "button", style: tabButtonStyle(tab === "presets"), onClick: () => setTab("presets"), "aria-pressed": tab === "presets", children: t("capability.tab.presets", "Presets") }),
					react_jsx_runtime.jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: t("capability.search", "Search"), style: searchInputStyle }),
					typeof props.onClose === "function"
						? react_jsx_runtime.jsx("button", { type: "button", onClick: props.onClose, "aria-label": t("capability.close", "Close"), children: "×" })
						: null
				] }),
				// The sidebar shell pins the view region between header and the Apply
				// footer as the scroll container (minHeight:0 lets the flex child
				// shrink below its content height). The popover shell keeps the
				// EXACT historical children shape — the pinned manager test indexes
				// root children[1] as addBlock.
				...(props.shell === "sidebar"
					? [react_jsx_runtime.jsxs("div", { style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto" }, children: [addBlock, body] })]
					: [addBlock, body]),
				draft !== null ? react_jsx_runtime.jsxs("div", { style: footerStyle, children: [
					diffText ? react_jsx_runtime.jsx("span", { style: diffSummaryStyle, "data-orrery-capability-diff": "", children: diffText }) : null,
					react_jsx_runtime.jsx("button", {
						type: "button",
						disabled: !draft.dirty || commit?.phase === "submitting",
						onClick: applyDraft,
						children: commit?.phase === "submitting" ? t("capability.applying", "Applying…") : t("capability.apply", "Apply")
					}),
					draft.dirty ? react_jsx_runtime.jsx("button", { type: "button", onClick: discardDraft, children: t("capability.discard", "Discard") }) : null,
					commit?.phase === "applied" ? react_jsx_runtime.jsx("span", { children: t("capability.applied", "Applied") }) : null,
					commit?.phase === "applied" && Array.isArray(commit.skipped) && commit.skipped.length > 0
						? react_jsx_runtime.jsx("span", { style: warnTextStyle, title: commit.skipped.map(entry => `${entry.name} — ${entry.reason}`).join("\n"), children: t("capability.appliedSkipped", "skipped {n} (not applicable here)").replace("{n}", String(commit.skipped.length)) })
						: null,
					commit?.phase === "failed" ? react_jsx_runtime.jsx("span", { style: warnTextStyle, title: commit.error, children: t("capability.failed", "Failed — draft kept") }) : null,
					commit?.phase === "revision-conflict" ? react_jsx_runtime.jsx("span", { style: warnTextStyle, children: t("capability.conflictState", "Changed elsewhere — review current state") }) : null,
					commit?.phase === "install-or-configure" ? react_jsx_runtime.jsx("span", { title: (commit.missing ?? []).join(", "), children: t("capability.missingAction", "Missing items need install/configure") }) : null,
					commit?.phase === "indeterminate" ? react_jsx_runtime.jsx("span", { children: t("capability.pending", "Result pending — query the receipt") }) : null
				] }) : null
			] });
		}
		exports.CapabilityManagerPanel = CapabilityManagerPanel;
		return module.exports;
	}
});
