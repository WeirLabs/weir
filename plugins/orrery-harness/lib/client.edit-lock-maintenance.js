window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.edit-lock-maintenance.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// Edit Lock maintenance panel (settings "Editing" group): the
		// profile-wide switch status (SAVED vs actually mounted, restart
		// semantics) plus read-only authority inspection per server-derived
		// domain root, over raw fetch ("/api/orrery-edit-lock/maintenance/*").
		// The panel never sends a path the server did not list first, and it
		// offers no mutation: the switch itself stays an ordinary settings
		// field. Style constants are verbatim copies of the settings-page
		// constants this panel uses (same-package sync require is impossible
		// in the ModuleLoader).
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 0" };
		const labelGroupStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 };
		const labelStyle = { fontSize: "14px", fontWeight: 500, lineHeight: "20px" };
		const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const warnStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-state-business-warning, #b25f00)" };
		const dangerStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-state-business-danger, #d64545)" };
		const chainPanelStyle = { display: "flex", flexDirection: "column", gap: "12px", padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)", marginTop: "8px" };
		const chainCategoryStyle = { fontSize: "13px", fontWeight: 600, lineHeight: "18px" };
		const chainDescStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const chainButtonStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline" };
		const domainRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "6px 0" };
		const monoStyle = { fontSize: "12px", lineHeight: "16px", fontFamily: "monospace", wordBreak: "break-all" };
		/** Error boundary isolating the maintenance panel from the settings page. */
		class EditLockMaintenanceBoundary extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			render() {
				if (this.state.failed) {
					return react_jsx_runtime.jsx("div", { style: hintStyle, children: this.props.t?.("editLockMaintFailed") ?? "Edit Lock maintenance failed" });
				}
				return this.props.children;
			}
		}
		/** Switch-state banner keys (state names contain hyphens). */
		const STATE_KEYS = { enforced: "Enforced", "disable-requested": "DisableRequested", "enable-requested": "EnableRequested", disabled: "Disabled", unknown: "Unknown" };
		const post = (url, body) => fetch(url, {
			method: "POST",
			credentials: "include",
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
		}).then((response) => response.json());
		// Invoke the render callback only during descendant traversal, never while
		// the parent constructs the boundary element.
		function MaintenanceBody({ render }) {
			return react_jsx_runtime.jsx("div", { style: chainPanelStyle, children: render() });
		}
		/** @typedef {{ status: 'loading' } | { status: 'error', message: string } | { status: 'ready', value: ReturnType<typeof import('../src/edit-lock/maintenance.js').maintenanceStatus> }} StatusView */
		function EditLockMaintenanceField(props) {
			const t = props.t;
			const [open, setOpen] = react.useState(false);
			const [view, setView] = react.useState(/** @type {StatusView | null} */ (null));
			const [expanded, setExpanded] = react.useState(/** @type {string | null} */ (null));
			const [inspections, setInspections] = react.useState({});
			const load = () => {
				setView({ status: "loading" });
				post("api/orrery-edit-lock/maintenance/status")
					.then((payload) => {
						setView(payload?.ok ? { status: "ready", value: payload.value } : { status: "error", message: payload?.error?.message ?? "unknown" });
					})
					.catch((error) => setView({ status: "error", message: String(error?.message ?? error) }));
			};
			const toggle = () => {
				const next = !open;
				setOpen(next);
				setExpanded(null);
				if (next) load();
			};
			const inspect = (root) => {
				setExpanded(root);
				setInspections((previous) => ({ ...previous, [root]: { status: "loading" } }));
				post("api/orrery-edit-lock/maintenance/inspect", { root })
					.then((payload) => {
						setInspections((previous) => ({ ...previous, [root]: payload?.ok ? { status: "ready", value: payload.value } : { status: "error", message: payload?.error?.message ?? "unknown" } }));
					})
					.catch((error) => setInspections((previous) => ({ ...previous, [root]: { status: "error", message: String(error?.message ?? error) } })));
			};
			const scopeText = (scope) => {
				if (scope?.kind === "file") return t("editLockMaintScopeFile");
				if (scope?.kind === "subtree") return t("editLockMaintScopeSubtree");
				if (scope?.kind === "domain") return t("editLockMaintScopeDomain");
				return t("editLockMaintScopeNone");
			};
			const presenceRow = (value) => {
				if (value.presence === "valid") return null;
				const key = { none: "editLockMaintPresenceNone", empty: "editLockMaintPresenceEmpty", "no-committed-snapshot": "editLockMaintPresenceJunk", "not-a-file": "editLockMaintPresenceNotAFile", corrupt: "editLockMaintPresenceCorrupt", unreadable: "editLockMaintPresenceUnreadable" }[value.presence];
				return react_jsx_runtime.jsx("div", { style: value.presence === "corrupt" || value.presence === "not-a-file" || value.presence === "no-committed-snapshot" ? dangerStyle : hintStyle, children: `${t(key) ?? value.presence}${value.message ? ` ${value.message}` : ""}` });
			};
			const snapshotSection = (snapshot) => react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px" }, children: [
				react_jsx_runtime.jsx("div", { style: chainDescStyle, children: t("editLockMaintCounts")
					.replace("{sessions}", String(snapshot.counts.sessions))
					.replace("{locks}", String(snapshot.counts.locks))
					.replace("{operations}", String(snapshot.counts.operations)) }),
				react_jsx_runtime.jsx("div", { style: chainCategoryStyle, children: t("editLockMaintUnresolved") }),
				snapshot.unresolved.length === 0
					? react_jsx_runtime.jsx("div", { style: chainDescStyle, children: t("editLockMaintUnresolvedNone") })
					: react_jsx_runtime.jsx("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: snapshot.unresolved.map((op, index) => react_jsx_runtime.jsxs("div", { style: chainDescStyle, children: [
						react_jsx_runtime.jsx("div", { children: `${scopeText(op.scope)}${op.scope.path ? ` — ${op.scope.path}` : ""}` }),
						react_jsx_runtime.jsx("div", { style: monoStyle, children: `${op.target.tool ?? "?"} ${op.target.filePath ?? "?"} · ${op.phase}${op.outcome ? `/${op.outcome}` : ""}${op.closeouts > 0 ? ` · closeouts ${op.closeouts}` : ""}` }),
						react_jsx_runtime.jsx("div", { style: monoStyle, children: `${op.key.sessionId} · ${op.key.operationId} · epoch ${op.origin.executionEpoch ?? "-"}` })
					], key: index })) }),
				snapshot.retainedLocks.length > 0
					? react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
						react_jsx_runtime.jsx("div", { style: chainCategoryStyle, children: t("editLockMaintRetained") }),
						...snapshot.retainedLocks.map((lock, index) => react_jsx_runtime.jsx("div", { style: chainDescStyle, children: `${lock.resourceId} · ${lock.owner} · ${lock.status}${lock.reason ? `: ${lock.reason}` : ""} · gen ${lock.generation}` }, index))
					] })
					: null
			] });
			const inspectionBody = (root) => {
				const inspection = inspections[root];
				if (!inspection) return null;
				if (inspection.status === "loading") return react_jsx_runtime.jsx("div", { style: hintStyle, children: t("editLockMaintLoading") });
				if (inspection.status === "error") {
					return react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "12px", alignItems: "center" }, children: [
						react_jsx_runtime.jsx("span", { style: hintStyle, children: `${t("editLockMaintUnavailable")} ${inspection.message}` }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: () => inspect(root), children: t("editLockMaintRetry") })
					] });
				}
				const value = inspection.value;
				return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "4px" }, children: [
					value.reservation === true ? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("editLockMaintReservation") }) : null,
					presenceRow(value),
					value.presence === "valid" ? snapshotSection(value.snapshot) : null
				] });
			};
			const domainRow = (domain) => react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column" }, children: [
				react_jsx_runtime.jsxs("div", { style: domainRowStyle, children: [
					react_jsx_runtime.jsxs("span", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: monoStyle, children: domain.root }),
						react_jsx_runtime.jsx("span", { style: chainDescStyle, children: [
							domain.hasAuthority === true ? t("editLockMaintAuthorityYes") : t("editLockMaintAuthorityNo"),
							domain.mode ? ` · ${domain.mode}` : "",
							domain.error ? ` · ${domain.error}` : ""
						] })
					] }),
					react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: () => inspect(domain.root), children: expanded === domain.root ? t("chainCancel") : t("editLockMaintInspect") })
				] }),
				expanded === domain.root ? inspectionBody(domain.root) : null
			], key: domain.root });
			const panelBody = () => {
				if (view === null) return null;
				if (view.status === "loading") return react_jsx_runtime.jsx("div", { style: hintStyle, children: t("editLockMaintLoading") });
				if (view.status === "error") {
					return react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "12px", alignItems: "center" }, children: [
						react_jsx_runtime.jsx("span", { style: hintStyle, children: `${t("editLockMaintUnavailable")} ${view.message}` }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: load, children: t("editLockMaintRetry") })
					] });
				}
				const value = view.value;
				const stateKey = STATE_KEYS[value.state] ?? "Unknown";
				return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "10px" }, children: [
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "2px" }, children: [
						react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: t(`editLockMaintState${stateKey}`) }),
						react_jsx_runtime.jsx("span", { style: chainDescStyle, children: t(`editLockMaintState${stateKey}Hint`) }),
						value.restartRequired ? react_jsx_runtime.jsx("span", { style: warnStyle, children: t("editLockMaintRestart") }) : null,
						value.pinned ? react_jsx_runtime.jsx("span", { style: warnStyle, children: t("editLockMaintPinned") }) : null,
						react_jsx_runtime.jsx("span", { style: chainDescStyle, children: t("editLockMaintScopeNote") })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "2px" }, children: [
						react_jsx_runtime.jsx("span", { style: warnStyle, children: t("editLockMaintWarnKeepHistory") }),
						react_jsx_runtime.jsx("span", { style: warnStyle, children: t("editLockMaintWarnUnlock") })
					] }),
					value.blocked.length > 0
						? react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
							react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: t("editLockMaintBlocked") }),
							...value.blocked.map((row, index) => react_jsx_runtime.jsx("span", { style: dangerStyle, children: `${"root" in row ? row.root : "sessionId" in row ? row.sessionId : row.mountId} — ${row.reason}` }, index))
						] })
						: null,
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "2px" }, children: [
						react_jsx_runtime.jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" }, children: [
							react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: t("editLockMaintDomains") }),
							react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: load, children: t("editLockMaintRefresh") })
						] }),
						value.domains.length === 0
							? react_jsx_runtime.jsx("span", { style: chainDescStyle, children: t("editLockMaintNoDomains") })
							: value.domains.map(domainRow)
					] })
				] });
			};
			return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
				react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
					react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: t("editLockMaint") }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: t("editLockMaintHint") })
					] }),
					react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: toggle, children: open ? t("chainCancel") : t("chainEdit") })
				] }),
				open ? react_jsx_runtime.jsx(EditLockMaintenanceBoundary, { t, children: react_jsx_runtime.jsx(MaintenanceBody, { render: panelBody }) }) : null
			] });
		}
		exports.EditLockMaintenanceBoundary = EditLockMaintenanceBoundary;
		exports.EditLockMaintenanceField = EditLockMaintenanceField;
		return module.exports;
	}
});
