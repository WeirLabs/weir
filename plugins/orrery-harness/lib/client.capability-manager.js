window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.capability-manager.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// ---- Capability manager panel (lazy, opened from the Badge) ----
		// Two views (Skills / MCP), source labels, conflict & missing marks,
		// search, select toggles into the draft, and the managed/unmanaged MCP
		// groups (8.8). Every list decision comes from the pure model; this
		// chunk only renders and forwards verbs supplied by the composition
		// root. An unsupported condition set renders as an explicit state,
		// never as hidden controls (12.2).
		const panelStyle = {
			position: "absolute",
			bottom: "calc(100% + 8px)",
			left: 0,
			minWidth: "320px",
			maxHeight: "380px",
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
		const rowStyle = { display: "flex", alignItems: "center", gap: "6px", padding: "3px 0" };
		const tagStyle = {
			fontSize: "10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			padding: "0 4px",
			color: "var(--dsw-alias-label-secondary, #888)"
		};
		function row(label, tag, extra) {
			return react_jsx_runtime.jsxs("div", { style: rowStyle, children: [react_jsx_runtime.jsx("span", { children: label }), tag ? react_jsx_runtime.jsx("span", { style: tagStyle, children: tag }) : null, extra ?? null] });
		}
		function CapabilityManagerPanel(props) {
			const model = props.model;
			// Echo-guard like the Badge: an unregistered dictionary entry must
			// surface the in-code fallback, never the raw key.
			const t = (key, fallback) => {
				const value = typeof props.t === "function" ? props.t(key, fallback) : undefined;
				return value && value !== key ? value : fallback;
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
			const conditionState = model.managerConditionState(conditions?.conditions ?? conditions);
			if (listing === null) return react_jsx_runtime.jsx("div", { style: panelStyle, children: t("capability.loading", "Loading capabilities…") });
			if (listing.error === true) return react_jsx_runtime.jsx("div", { style: panelStyle, children: t("capability.error", "Capabilities unavailable for this session.") });
			if (listing.error) return react_jsx_runtime.jsx("div", { style: panelStyle, children: t("capability.unavailable", "Capabilities are unavailable in this session.") });
			if (conditionState === "unsupported") {
				return react_jsx_runtime.jsx("div", { style: panelStyle, children: t("capability.unsupported", "Unsupported: consistency conditions are not met on this host.") });
			}
			const partition = model.partitionManagerListing(listing);
			const needle = query.trim().toLowerCase();
			const skills = needle ? partition.skills.filter((skill) => skill.name.toLowerCase().includes(needle)) : partition.skills;
			const draftHas = (kind, name) => draft !== null && draft[kind].includes(name);
			// Managed MCP add form (8.1/8.2): registers a stdio server and mounts
			// it immediately via /capabilities mcp-add.
			const [addForm, setAddForm] = react.useState({ open: false, identity: "", label: "", command: "", args: "", error: null, busy: false });
			const submitAdd = () => {
				if (typeof props.mcpAdd !== "function" || addForm.busy) return;
				setAddForm({ ...addForm, busy: true, error: null });
				props.mcpAdd(props.sessionId, {
					identity: addForm.identity.trim(),
					label: addForm.label.trim() || addForm.identity.trim(),
					command: addForm.command.trim(),
					args: addForm.args.trim() ? addForm.args.trim().split(/\s+/) : [],
				}).then((result) => {
					if (result && result.status === "registered") {
						setAddForm({ open: false, identity: "", label: "", command: "", args: "", error: null, busy: false });
						refreshAll();
					} else {
						setAddForm({ ...addForm, busy: false, error: (result && result.status) || "add failed" });
					}
				}).catch((cause) => setAddForm({ ...addForm, busy: false, error: String(cause) }));
			};
			const inputStyle = { flex: 1, fontSize: "12px" };
			const addBlock = tab === "mcp" ? react_jsx_runtime.jsxs("div", { style: { marginBottom: "6px" }, children: [
				!addForm.open
					? react_jsx_runtime.jsx("button", { type: "button", onClick: () => setAddForm({ ...addForm, open: true }), children: t("capability.mcp.add", "+ Add managed MCP server") })
					: react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)", padding: "6px" }, children: [
						react_jsx_runtime.jsx("input", { style: inputStyle, placeholder: t("capability.mcp.identity", "identity (e.g. my-docs)"), value: addForm.identity, onChange: (event) => setAddForm({ ...addForm, identity: event.target.value }) }),
						react_jsx_runtime.jsx("input", { style: inputStyle, placeholder: t("capability.mcp.label", "label (display name)"), value: addForm.label, onChange: (event) => setAddForm({ ...addForm, label: event.target.value }) }),
						react_jsx_runtime.jsx("input", { style: inputStyle, placeholder: t("capability.mcp.command", "command (e.g. npx)"), value: addForm.command, onChange: (event) => setAddForm({ ...addForm, command: event.target.value }) }),
						react_jsx_runtime.jsx("input", { style: inputStyle, placeholder: t("capability.mcp.args", "args, space-separated (optional)"), value: addForm.args, onChange: (event) => setAddForm({ ...addForm, args: event.target.value }) }),
						react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "6px" }, children: [
							react_jsx_runtime.jsx("button", { type: "button", disabled: addForm.busy || !addForm.identity.trim() || !addForm.command.trim(), onClick: submitAdd, children: addForm.busy ? t("capability.mcp.adding", "Adding…") : t("capability.mcp.addConfirm", "Add") }),
							react_jsx_runtime.jsx("button", { type: "button", onClick: () => setAddForm({ ...addForm, open: false, error: null }), children: t("capability.mcp.cancel", "Cancel") }),
							addForm.error ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-state-warn-primary, #c80)" }, children: String(addForm.error) }) : null
						] })
					] })
			] }) : null;
			const body = tab === "skills"
				? skills.map((skill) => react_jsx_runtime.jsxs("div", {
					style: { ...rowStyle, cursor: draft ? "pointer" : "default" },
					role: draft ? "checkbox" : undefined,
					"aria-checked": draft ? draftHas("skills", skill.name) : undefined,
					tabIndex: draft ? 0 : undefined,
					onClick: () => toggle("skills", skill.name),
					onKeyDown: (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); toggle("skills", skill.name); } },
					children: [
						react_jsx_runtime.jsx("span", { children: (draftHas("skills", skill.name) ? "☑ " : "☐ ") + skill.name }),
						react_jsx_runtime.jsx("span", { style: tagStyle, children: skill.source }),
						skill.conflict ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-state-warn-primary, #c80)" }, children: t("capability.conflict", "conflict") }) : null
					]
				}, skill.name))
				: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					partition.mcpManaged.map((server) => {
						const name = server.identity ?? server.serverName ?? "unknown";
						return react_jsx_runtime.jsxs("div", {
							style: { ...rowStyle, cursor: draft ? "pointer" : "default" },
							role: draft ? "checkbox" : undefined,
							"aria-checked": draft ? draftHas("mcpServers", name) : undefined,
							tabIndex: draft ? 0 : undefined,
							onClick: () => toggle("mcpServers", name),
							onKeyDown: (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); toggle("mcpServers", name); } },
							children: [
								react_jsx_runtime.jsx("span", { children: (draftHas("mcpServers", name) ? "☑ " : "☐ ") + name }),
								react_jsx_runtime.jsx("span", { style: tagStyle, children: t("capability.managed", "managed") })
							]
						}, name);
					}),
					partition.mcpUnmanaged.map((server) => row(server.serverName ?? "unknown", t("capability.unmanaged", "unmanaged")))
				] });
			return react_jsx_runtime.jsxs("div", { style: panelStyle, children: [
				react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "6px", marginBottom: "6px" }, children: [
					react_jsx_runtime.jsx("button", { type: "button", onClick: () => setTab("skills"), "aria-pressed": tab === "skills", children: t("capability.tab.skills", "Skills") }),
					react_jsx_runtime.jsx("button", { type: "button", onClick: () => setTab("mcp"), "aria-pressed": tab === "mcp", children: t("capability.tab.mcp", "MCP") }),
					react_jsx_runtime.jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: t("capability.search", "Search"), style: { flex: 1 } }),
					react_jsx_runtime.jsx("button", { type: "button", onClick: props.onClose, children: "×" })
				] }),
				addBlock,
				body,
				draft !== null ? react_jsx_runtime.jsxs("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: "8px", paddingTop: "6px", display: "flex", gap: "6px", alignItems: "center" }, children: [
					react_jsx_runtime.jsx("button", {
						type: "button",
						disabled: !draft.dirty || commit?.phase === "submitting",
						onClick: applyDraft,
						children: commit?.phase === "submitting" ? t("capability.applying", "Applying…") : t("capability.apply", "Apply")
					}),
					draft.dirty ? react_jsx_runtime.jsx("button", { type: "button", onClick: discardDraft, children: t("capability.discard", "Discard") }) : null,
					commit?.phase === "applied" ? react_jsx_runtime.jsx("span", { children: t("capability.applied", "Applied") }) : null,
					commit?.phase === "failed" ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-state-warn-primary, #c80)" }, title: commit.error, children: t("capability.failed", "Failed — draft kept") }) : null,
					commit?.phase === "revision-conflict" ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-state-warn-primary, #c80)" }, children: t("capability.conflictState", "Changed elsewhere — review current state") }) : null,
					commit?.phase === "install-or-configure" ? react_jsx_runtime.jsx("span", { title: (commit.missing ?? []).join(", "), children: t("capability.missingAction", "Missing items need install/configure") }) : null,
					commit?.phase === "indeterminate" ? react_jsx_runtime.jsx("span", { children: t("capability.pending", "Result pending — query the receipt") }) : null
				] }) : null
			] });
		}
		exports.CapabilityManagerPanel = CapabilityManagerPanel;
		return module.exports;
	}
});
