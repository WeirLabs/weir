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
			background: "var(--dsw-alias-background-elevated, #fff)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-md)",
			boxShadow: "var(--dsw-shadow-l2, 0 4px 16px rgba(0,0,0,.12))",
			padding: "10px",
			fontSize: "12px",
			color: "var(--dsw-alias-label-primary)"
		};
		const rowStyle = { display: "flex", alignItems: "center", gap: "6px", padding: "3px 0" };
		const tagStyle = {
			fontSize: "10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			padding: "0 4px",
			color: "var(--dsw-alias-label-tertiary, #888)"
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
				return () => { alive = false; };
			}, [props.sessionId]);
			const conditionState = model.managerConditionState(conditions?.conditions ?? conditions);
			if (listing === null) return react_jsx_runtime.jsx("div", { style: panelStyle, children: t("capability.loading", "Loading capabilities…") });
			if (listing.error) return react_jsx_runtime.jsx("div", { style: panelStyle, children: t("capability.unavailable", "Capabilities are unavailable in this session.") });
			if (conditionState === "unsupported") {
				return react_jsx_runtime.jsx("div", { style: panelStyle, children: t("capability.unsupported", "Unsupported: consistency conditions are not met on this host.") });
			}
			const partition = model.partitionManagerListing(listing);
			const needle = query.trim().toLowerCase();
			const skills = needle ? partition.skills.filter((skill) => skill.name.toLowerCase().includes(needle)) : partition.skills;
			const body = tab === "skills"
				? skills.map((skill) => row(
					(skill.selected ? "☑ " : "☐ ") + skill.name,
					skill.source,
					skill.conflict ? react_jsx_runtime.jsx("span", { style: { color: "var(--dsw-alias-state-warning, #c80)" }, children: t("capability.conflict", "conflict") }) : null))
				: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					partition.mcpManaged.map((server) => row(server.identity ?? server.serverName ?? "unknown", t("capability.managed", "managed"))),
					partition.mcpUnmanaged.map((server) => row(server.serverName ?? "unknown", t("capability.unmanaged", "unmanaged")))
				] });
			return react_jsx_runtime.jsxs("div", { style: panelStyle, children: [
				react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "6px", marginBottom: "6px" }, children: [
					react_jsx_runtime.jsx("button", { type: "button", onClick: () => setTab("skills"), "aria-pressed": tab === "skills", children: t("capability.tab.skills", "Skills") }),
					react_jsx_runtime.jsx("button", { type: "button", onClick: () => setTab("mcp"), "aria-pressed": tab === "mcp", children: t("capability.tab.mcp", "MCP") }),
					react_jsx_runtime.jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: t("capability.search", "Search"), style: { flex: 1 } }),
					react_jsx_runtime.jsx("button", { type: "button", onClick: props.onClose, children: "×" })
				] }),
				body
			] });
		}
		exports.CapabilityManagerPanel = CapabilityManagerPanel;
		return module.exports;
	}
});
