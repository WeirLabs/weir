window.__ModuleLoader__.load({
	id: "weir-harness",
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
		// domain root, over the composition root's HTTP channel adapter
		// (props.channel: (endpoint, payload?) => Promise<{ ok: true, value } |
		// { ok: false, error }>, never rejecting; "/api/weir-edit-lock/maintenance/*").
		// The panel never sends a path the server did not list first, and it
		// offers recovery only while the manager is mounted. The switch itself
		// field. Style constants are verbatim copies of the settings-page
		// constants this panel uses (same-package sync require is impossible
		// in the ModuleLoader).
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 0" };
		const labelGroupStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 };
		const labelStyle = { fontSize: "14px", fontWeight: 500, lineHeight: "20px" };
		const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const warnStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-state-warn-primary)" };
		const dangerStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-state-business-danger, #d64545)" };
		const chainPanelStyle = { display: "flex", flexDirection: "column", gap: "12px", padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)", marginTop: "8px" };
		const chainCategoryStyle = { fontSize: "13px", fontWeight: 600, lineHeight: "18px" };
		const chainDescStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const chainButtonStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline" };
		const domainRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "6px 0" };
		const monoStyle = { fontSize: "12px", lineHeight: "16px", fontFamily: "monospace", wordBreak: "break-all" };
		// ---- Online administrative recovery (proposals from the host) ------
		// The recovery derivation — eligibility, the scoped confirmation
		// digest, the failing-precondition diagnosis — lives HOST-side
		// (src/edit-lock/inspect.js recoveryProposals), computed from the same
		// parsed authority image the inspection summarizes. The panel renders
		// the server proposals and submits their scope and confirmation
		// VERBATIM; it never re-derives a safety-sensitive rule. The manager
		// re-verifies every precondition at commit time either way.
		/** The unmet reason CODES (schemaVersion 1) mapped to dictionary keys;
		 * an unknown code falls back to a generic message naming the code. */
		const RECOVERY_REASON_KEYS = {
			"disposition-recorded": "editLockMaintRecoverReasonDispositionRecorded",
			"owner-unknown": "editLockMaintRecoverReasonOwnerUnknown",
			"not-interrupted": "editLockMaintRecoverReasonNotInterrupted",
			"prepared-outstanding": "editLockMaintRecoverReasonPreparedOutstanding",
			"publishing-outstanding": "editLockMaintRecoverReasonPublishingOutstanding",
			"no-unresolved": "editLockMaintRecoverReasonNoUnresolved",
		};
		/** The fail-closed gate (a new client meeting an old or evolved host):
		 * only a schemaVersion-1 proposals payload is rendered at all; anything
		 * else disables the online recovery action with refresh guidance.
		 * @param {any} value the inspect response value */
		const supportedProposals = (value) => value?.recoveryProposals?.schemaVersion === 1 ? value.recoveryProposals : null;
		/** Recovery state is scoped exactly like the authority: per domain root
		 * AND owner. Session ids are not unique across independent domains, so
		 * one root's completed recovery must never disable another root's. */
		const recoveryKey = (root, owner) => `${root}\n${owner}`;
		/** Recovery-UX zone copy (D1/D2). The entry dictionaries (client.js) are
		 * owned by the entry chunk, so the zone copy lives HERE as
		 * template-layer English per the text discipline; the unmet reason prose
		 * lives in the dictionaries below (server reason CODES are localized),
		 * while file paths, session ids and statuses stay dynamic instance
		 * content. */
		const RECOVERY_UX = Object.freeze({
			blockedHeader: "Blocked files — one-click force release",
			blockedHint: "Opening the panel ran the read-only inspection automatically. Each row settles the holder's unresolved publication fence (when present) and releases the lock in one operator-confirmed step.",
			unmetHeader: "Blocked files — recovery preconditions not met",
			forceRelease: "Force release",
			holder: "holder",
			stateFence: "publication fence",
			stateInterrupted: "interrupted",
			stateActive: "active",
		});
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
		const onlineRecoveryAvailable = (state) => state === "enforced" || state === "disable-requested";
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
			const [recoveries, setRecoveries] = react.useState(/** @type {Record<string, {status: 'busy'} | {status: 'done', revision: number, idempotent: boolean} | {status: 'error', message: string}>} */ ({}));
			/** The one explicit action: submit the SERVER-computed confirmation
			 * for one displayed scope, unchanged. No hash typing, no restart.
			 * A refusal is shown next to a freshly reloaded scope.
			 * @param {string} root @param {ReturnType<typeof import('../src/edit-lock/inspect.js').recoveryProposals>['candidates'][number]} candidate */
			const recover = (root, candidate) => {
				if (view?.status !== "ready" || !onlineRecoveryAvailable(view.value.state)) return;
				setRecoveries((previous) => ({ ...previous, [recoveryKey(root, candidate.owner)]: { status: "busy" } }));
				props.channel("api/weir-edit-lock/maintenance/recover-online", {
					root,
					owner: candidate.owner,
					expectedRevision: candidate.scope.expectedRevision,
					operationIds: candidate.scope.operationIds,
					recoveryId: globalThis.crypto?.randomUUID?.() ?? `panel-${Date.now()}-${Math.random().toString(16).slice(2)}`,
					reason: "Confirmed in the Edit Lock maintenance panel: the operator reviewed the displayed scope and accepted the displayed late-writer risk.",
					acceptLateWriterRisk: true,
					confirmation: candidate.confirmation,
				}).then((result) => {
					setRecoveries((previous) => ({ ...previous, [recoveryKey(root, candidate.owner)]: result.ok === true
						? { status: "done", revision: result.value.revision, idempotent: result.value.idempotent === true }
						: { status: "error", message: result.error?.detail ?? result.error?.message ?? "unknown" } }));
					inspect(root);
				}).catch((error) => {
					setRecoveries((previous) => ({ ...previous, [recoveryKey(root, candidate.owner)]: { status: "error", message: String(error?.message ?? error) } }));
					inspect(root);
				});
			};
			const load = () => {
				setView({ status: "loading" });
				props.channel("api/weir-edit-lock/maintenance/status")
					.then((result) => {
						setView(result.ok === true ? { status: "ready", value: result.value } : { status: "error", message: result.error.message });
						// Recovery UX D1: opening the panel auto-runs the read-only
						// inspection for every server-derived domain root, so the
						// blocked/unmet zones render without any manual step. The
						// inspection itself stays read-only (the same endpoint).
						if (result.ok === true && Array.isArray(result.value?.domains)) result.value.domains.forEach((domain) => inspect(domain.root, false));
					})
					.catch((error) => setView({ status: "error", message: String(error?.message ?? error) }));
			};
			const toggle = () => {
				const next = !open;
				setOpen(next);
				setExpanded(null);
				if (next) load();
			};
			/** @param {string} root @param {boolean} [expand] manual clicks expand the per-domain detail; the automatic pass does not */
			const inspect = (root, expand = true) => {
				if (expand) setExpanded(root);
				setInspections((previous) => ({ ...previous, [root]: { status: "loading" } }));
				props.channel("api/weir-edit-lock/maintenance/inspect", { root })
					.then((result) => {
						setInspections((previous) => ({ ...previous, [root]: result.ok === true ? { status: "ready", value: result.value } : { status: "error", message: result.error.message } }));
					})
					.catch((error) => setInspections((previous) => ({ ...previous, [root]: { status: "error", message: String(error?.message ?? error) } })));
			};
			const scopeText = (scope) => {
				if (scope?.kind === "file") return t("editLockMaintScopeFile");
				if (scope?.kind === "subtree") return t("editLockMaintScopeSubtree");
				if (scope?.kind === "domain") return t("editLockMaintScopeDomain");
				return t("editLockMaintScopeNone");
			};
			/** The localized explanation for one server reason CODE; an unknown
			 * code falls back to a generic message naming the code itself. */
			const reasonText = (reason) => {
				const key = RECOVERY_REASON_KEYS[reason];
				return key ? t(key) : t("editLockMaintRecoverReasonUnknown").replace("{code}", String(reason ?? ""));
			};
			const presenceRow = (value) => {
				if (value.presence === "valid") return null;
				const key = { none: "editLockMaintPresenceNone", empty: "editLockMaintPresenceEmpty", "no-committed-snapshot": "editLockMaintPresenceJunk", "not-a-file": "editLockMaintPresenceNotAFile", corrupt: "editLockMaintPresenceCorrupt", unreadable: "editLockMaintPresenceUnreadable" }[value.presence];
				return react_jsx_runtime.jsx("div", { style: value.presence === "corrupt" || value.presence === "not-a-file" || value.presence === "no-committed-snapshot" ? dangerStyle : hintStyle, children: `${t(key) ?? value.presence}${value.message ? ` ${value.message}` : ""}` });
			};
			/** Recovery card for one eligible owner: the FULL server scope, the
			 * risk text and the server digest, then the one explicit button.
			 * @param {string} root @param {ReturnType<typeof import('../src/edit-lock/inspect.js').recoveryProposals>['candidates'][number]} candidate */
			const recoveryCard = (root, candidate) => {
				const state = recoveries[recoveryKey(root, candidate.owner)];
				return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "8px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)" }, children: [
					react_jsx_runtime.jsx("div", { style: chainDescStyle, children: `${t("editLockMaintRecoverRoot")}: ${candidate.scope.root}` }),
					react_jsx_runtime.jsx("div", { style: chainDescStyle, children: `${t("editLockMaintRecoverOwner")}: ${candidate.owner}` }),
					react_jsx_runtime.jsx("div", { style: chainDescStyle, children: `${t("editLockMaintRecoverRevision")}: ${candidate.scope.expectedRevision}` }),
					react_jsx_runtime.jsxs("div", { style: chainDescStyle, children: [
						react_jsx_runtime.jsx("div", { children: `${t("editLockMaintRecoverOperations")}:` }),
						...candidate.scope.operationIds.map((id, index) => react_jsx_runtime.jsx("div", { style: monoStyle, children: id }, index))
					] }),
					react_jsx_runtime.jsx("div", { style: dangerStyle, children: `${t("editLockMaintRecoverRisk")}: ${candidate.risk}` }),
					react_jsx_runtime.jsx("div", { style: monoStyle, children: `${t("editLockMaintRecoverDigest")}: ${candidate.confirmation}` }),
					state?.status === "done"
						? react_jsx_runtime.jsx("div", { style: hintStyle, children: t("editLockMaintRecoverDone").replace("{revision}", String(state.revision)) })
						: null,
					state?.status === "error"
						? react_jsx_runtime.jsx("div", { style: dangerStyle, children: `${t("editLockMaintRecoverFailed")} ${state.message}` })
						: null,
					react_jsx_runtime.jsx("div", { children: react_jsx_runtime.jsx("button", {
						type: "button",
						style: chainButtonStyle,
						disabled: state?.status === "busy" || state?.status === "done",
						onClick: () => recover(root, candidate),
						children: state?.status === "busy" ? t("editLockMaintRecoverBusy") : t("editLockMaintRecoverConfirm")
					}) })
				], key: recoveryKey(root, candidate.owner) });
			};
			/** Row state fragment: lock status / publication fence + session liveness. */
			const holderStateText = (row) => {
				const parts = [];
				if (row.lockStatus) parts.push(row.lockStatus);
				if (row.fence) parts.push(RECOVERY_UX.stateFence);
				parts.push(row.interrupted ? RECOVERY_UX.stateInterrupted : RECOVERY_UX.stateActive);
				return parts.join(" · ");
			};
			/** Blocked-zone group for one eligible owner: one row per blocked file
			 * (file, holder, holder state, one primary force-release action per
			 * row) plus the FULL scope, risk and computed digest the operator
			 * accepts with the click — the same confirmation algorithm as the
			 * offline path, unchanged. */
			const blockedZoneCard = (root, candidate, rows) => {
				const state = recoveries[recoveryKey(root, candidate.owner)];
				return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "8px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)" }, children: [
					...rows.map((row) => react_jsx_runtime.jsxs("div", { style: { display: "flex", alignItems: "center", gap: "8px" }, children: [
						react_jsx_runtime.jsxs("span", { style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }, children: [
							react_jsx_runtime.jsx("span", { style: monoStyle, children: row.resourceId }),
							react_jsx_runtime.jsx("span", { style: chainDescStyle, children: `${RECOVERY_UX.holder} ${row.owner} · ${holderStateText(row)}` })
						] }),
						react_jsx_runtime.jsx("span", { style: { flex: 1 } }),
						react_jsx_runtime.jsx("button", {
							type: "button",
							style: chainButtonStyle,
							disabled: state?.status === "busy",
							onClick: () => recover(root, candidate),
							children: state?.status === "busy" ? t("editLockMaintRecoverBusy") : RECOVERY_UX.forceRelease
						})
					], key: row.resourceId })),
					react_jsx_runtime.jsx("div", { style: chainDescStyle, children: `${t("editLockMaintRecoverRoot")}: ${candidate.scope.root}` }),
					react_jsx_runtime.jsx("div", { style: chainDescStyle, children: `${t("editLockMaintRecoverOwner")}: ${candidate.owner}` }),
					react_jsx_runtime.jsx("div", { style: chainDescStyle, children: `${t("editLockMaintRecoverRevision")}: ${candidate.scope.expectedRevision}` }),
					react_jsx_runtime.jsxs("div", { style: chainDescStyle, children: [
						react_jsx_runtime.jsx("div", { children: `${t("editLockMaintRecoverOperations")}:` }),
						...candidate.scope.operationIds.map((id, index) => react_jsx_runtime.jsx("div", { style: monoStyle, children: id }, index))
					] }),
					react_jsx_runtime.jsx("div", { style: dangerStyle, children: `${t("editLockMaintRecoverRisk")}: ${candidate.risk}` }),
					react_jsx_runtime.jsx("div", { style: monoStyle, children: `${t("editLockMaintRecoverDigest")}: ${candidate.confirmation}` }),
					state?.status === "error"
						? react_jsx_runtime.jsx("div", { style: dangerStyle, children: `${t("editLockMaintRecoverFailed")} ${state.message}` })
						: null,
				], key: recoveryKey(root, candidate.owner) });
			};
			/** Unmet-zone row for one ineligible blocking owner: the blocked files
			 * and the NAMED failing precondition, never a silent missing action. */
			const unmetZoneRow = (root, entry) => react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px", padding: "8px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)" }, children: [
				react_jsx_runtime.jsx("div", { style: chainDescStyle, children: `${t("editLockMaintRecoverOwner")}: ${entry.owner}` }),
				...entry.rows.map((row, index) => react_jsx_runtime.jsx("div", { style: monoStyle, children: `${row.resourceId} · ${RECOVERY_UX.holder} ${row.owner} · ${holderStateText(row)}` }, index)),
				...entry.scopePaths.map((path, index) => react_jsx_runtime.jsx("div", { style: monoStyle, children: path }, index)),
				react_jsx_runtime.jsx("div", { style: dangerStyle, children: reasonText(entry.reason) })
			], key: `${root}\n${entry.owner}\nunmet` });
			const snapshotSection = (/** @type {string} */ root, /** @type {any} */ value) => {
				const snapshot = value.snapshot;
				const proposals = supportedProposals(value);
				return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px" }, children: [
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
					: null,
					proposals !== null && onlineRecoveryAvailable(view?.status === "ready" ? view.value.state : null) && Array.isArray(proposals.candidates) && proposals.candidates.length > 0
					? react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px" }, children: [
						react_jsx_runtime.jsx("div", { style: chainCategoryStyle, children: t("editLockMaintRecoveries") }),
						react_jsx_runtime.jsx("div", { style: chainDescStyle, children: t("editLockMaintRecoverHint") }),
						...proposals.candidates.map((candidate) => recoveryCard(root, candidate))
					] }) : null
				] });
			};
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
					value.presence === "valid" ? snapshotSection(root, value) : null
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
				// Retained authority is history, not a current block, without a mounted manager.
				const online = onlineRecoveryAvailable(value.state);
				const zoneGroups = new Map();
				const zoneUnmet = [];
				// Fail closed: a missing or unsupported proposals payload disables
				// every zone derived from it — the panel never re-derives the
				// recovery surface by itself.
				let proposalsUnsupported = false;
				for (const root of Object.keys(inspections)) {
					const inspection = inspections[root];
					if (inspection?.status !== "ready" || inspection.value?.presence !== "valid") continue;
					const proposals = supportedProposals(inspection.value);
					if (!proposals) { proposalsUnsupported = true; continue; }
					for (const candidate of Array.isArray(proposals.candidates) ? proposals.candidates : []) {
						if (!candidate || typeof candidate.owner !== "string" || !Array.isArray(candidate.rows) || candidate.rows.length === 0) continue;
						const key = recoveryKey(root, candidate.owner);
						const group = zoneGroups.get(key) ?? { root, candidate, rows: [] };
						for (const row of candidate.rows) group.rows.push(row);
						zoneGroups.set(key, group);
					}
					for (const entry of Array.isArray(proposals.unmet) ? proposals.unmet : []) zoneUnmet.push({ root, entry });
				}
				const blockedGroups = [...zoneGroups.values()];
				zoneUnmet.sort((a, b) => a.entry.owner.localeCompare(b.entry.owner));
				const historyRows = [...blockedGroups.flatMap((group) => group.rows), ...zoneUnmet.flatMap(({ entry }) => entry.rows)];
				const historyScopes = zoneUnmet.flatMap(({ entry }) => entry.scopePaths);
				for (const root of Object.keys(inspections)) {
					const inspection = inspections[root];
					if (inspection?.status !== "ready" || inspection.value?.presence !== "valid") continue;
					for (const op of inspection.value.snapshot.unresolved) {
						if (op.scope?.kind !== "file" && typeof op.scope?.path === "string" && !historyScopes.includes(op.scope.path)) historyScopes.push(op.scope.path);
					}
				}
				return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "10px" }, children: [
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "2px" }, children: [
						react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: t(`editLockMaintState${stateKey}`) }),
						react_jsx_runtime.jsx("span", { style: chainDescStyle, children: t(`editLockMaintState${stateKey}Hint`) }),
						value.restartRequired ? react_jsx_runtime.jsx("span", { style: warnStyle, children: t("editLockMaintRestart") }) : null,
						value.pinned ? react_jsx_runtime.jsx("span", { style: warnStyle, children: t("editLockMaintPinned") }) : null,
						react_jsx_runtime.jsx("span", { style: chainDescStyle, children: t("editLockMaintScopeNote") })
					] }),
					!online ? react_jsx_runtime.jsx("div", { role: "alert", style: warnStyle, children: t(value.state === "unknown" ? "editLockMaintUnknownRisk" : "editLockMaintOffRisk") }) : null,
					!online ? react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
						react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: t(value.state === "unknown" ? "editLockMaintUnknownHistory" : "editLockMaintHistory") }),
						react_jsx_runtime.jsx("span", { style: chainDescStyle, children: t(value.state === "unknown" ? "editLockMaintUnknownHistoryHint" : "editLockMaintHistoryHint") }),
						...historyRows.map((row, index) => react_jsx_runtime.jsx("span", { style: monoStyle, children: `${row.resourceId} · ${row.owner}${row.lockStatus ? ` · ${row.lockStatus}` : ""}${row.fence ? ` · ${RECOVERY_UX.stateFence}` : ""}` }, index)),
						...historyScopes.map((path, index) => react_jsx_runtime.jsx("span", { style: monoStyle, children: path }, `scope-${index}`))
					] }) : null,
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "2px" }, children: [
						react_jsx_runtime.jsx("span", { style: warnStyle, children: t("editLockMaintWarnKeepHistory") }),
						react_jsx_runtime.jsx("span", { style: warnStyle, children: t("editLockMaintWarnUnlock") })
					] }),
				proposalsUnsupported
					? react_jsx_runtime.jsx("div", { style: warnStyle, children: t("editLockMaintRecoverUpgrade") })
					: null,
					online && blockedGroups.length > 0
						? react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
							react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: RECOVERY_UX.blockedHeader }),
							react_jsx_runtime.jsx("span", { style: chainDescStyle, children: RECOVERY_UX.blockedHint }),
							...blockedGroups.map((group) => blockedZoneCard(group.root, group.candidate, group.rows))
						] })
						: null,
					online && zoneUnmet.length > 0
						? react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
							react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: RECOVERY_UX.unmetHeader }),
							...zoneUnmet.map(({ root, entry }) => unmetZoneRow(root, entry))
						] })
						: null,
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
				editLockMaint: "Edit Lock maintenance",
				editLockMaintHint: "Profile-wide enforcement status and read-only diagnostics.",
				editLockMaintFailed: "Edit Lock maintenance failed",
				editLockMaintLoading: "Loading…",
				editLockMaintUnavailable: "Maintenance data unavailable:",
				editLockMaintRetry: "Retry",
				editLockMaintRefresh: "Refresh",
				editLockMaintInspect: "Inspect",
				editLockMaintStateEnforced: "Enforced",
				editLockMaintStateEnforcedHint: "The switch is on and the Edit Lock manager is mounted in this process.",
				editLockMaintStateDisableRequested: "Disable requested — restart required",
				editLockMaintStateDisableRequestedHint: "You turned the switch off, but the manager is still mounted and enforcing. The change applies after restarting DeepSeek Harness.",
				editLockMaintStateEnableRequested: "Enable requested — restart required",
				editLockMaintStateEnableRequestedHint: "You turned the switch on, but no manager is mounted in this process. The change applies after restarting DeepSeek Harness.",
				editLockMaintStateDisabled: "Enforcement disabled",
				editLockMaintStateDisabledHint: "The switch is off and every recorded, fully installed row reports enforcement disabled.",
				editLockMaintStateUnknown: "Unknown",
				editLockMaintStateUnknownHint: "Mount evidence is absent, inconsistent, installing, disposing or failed. The saved value alone never proves enforcement or disablement.",
				editLockMaintRestart: "Applies after restarting DeepSeek Harness.",
				editLockMaintPinned: "This composition pins the Edit Lock row configuration; the settings switch does not govern it here.",
				editLockMaintScopeNote: "The switch is profile-wide: it covers every Weir session in this profile, not one workspace.",
				editLockMaintWarnKeepHistory: "Turning enforcement off does not clear unresolved operations, fences or history — turning it back on can block the same files again.",
				editLockMaintWarnUnlock: "An ordinary unlock frees one lock without validating content; it is not historical recovery and never settles an unknown publication.",
				editLockMaintOffRisk: "Edit Lock is not mounted. Ordinary edits are UNPROTECTED and can overwrite another session's work. Retained locks and fences do not block off-period edits; they may block files again after you re-enable and restart.",
				editLockMaintUnknownRisk: "Edit Lock mount status cannot be verified. If no manager is mounted, ordinary edits are UNPROTECTED and can overwrite another session's work. Do not treat retained fences as proof of current protection.",
				editLockMaintHistory: "Retained history — not current blocks",
				editLockMaintHistoryHint: "These old locks and publication fences remain on disk for inspection. Without a mounted manager they do not block ordinary edits; after re-enabling they may block files again. Online force release is unavailable here; separate offline administrator recovery remains available.",
				editLockMaintUnknownHistory: "Retained authority — current effect unverified",
				editLockMaintUnknownHistoryHint: "The saved value and old fences cannot establish whether a manager is mounted. Inspect this history read-only; online force release is unavailable until enforcement is verified. Separate offline administrator recovery remains available.",
				editLockMaintBlocked: "Initialization blocked",
				editLockMaintDomains: "Domains",
				editLockMaintNoDomains: "No live session reports an Edit Lock domain in this profile.",
				editLockMaintAuthorityYes: "authority present",
				editLockMaintAuthorityNo: "authority currently absent",
				editLockMaintReservation: "A publisher reservation is present: this or another Harness holds (or stranded) the publishing claim for this domain.",
				editLockMaintPresenceNone: "No authority directory is currently present. Prior initialization cannot be determined.",
				editLockMaintPresenceEmpty: "The authority directory is currently empty. Prior initialization cannot be determined.",
				editLockMaintPresenceJunk: "The authority directory has contents but no committed snapshot; the store would refuse to open it. Nothing was changed.",
				editLockMaintPresenceNotAFile: "snapshot.json is not a regular file; the store would refuse it. Nothing was changed.",
				editLockMaintPresenceCorrupt: "The authority image failed integrity validation and was left untouched — no automatic repair exists. Refusal:",
				editLockMaintPresenceUnreadable: "The authority could not be read:",
				editLockMaintCounts: "{sessions} session(s) · {locks} lock(s) · {operations} recorded operation(s)",
				editLockMaintUnresolved: "Unresolved operations",
				editLockMaintUnresolvedNone: "No unresolved operations.",
				editLockMaintRetained: "Retained locks (interrupted / abnormal / pending)",
				editLockMaintScopeFile: "one file",
				editLockMaintScopeSubtree: "a directory subtree",
				editLockMaintScopeDomain: "the whole work directory",
				editLockMaintScopeNone: "no recorded scope",
				editLockMaintRecoveries: "Online administrative recovery",
				editLockMaintRecoverHint: "Settle an interrupted owner's unknown publications in the running manager: one explicit click, no restart, no hash typing. The unknown outcome stays in history. If the scope changed since it was loaded, the manager refuses and the panel reloads it.",
				editLockMaintRecoverRoot: "Root",
				editLockMaintRecoverOwner: "Owner session",
				editLockMaintRecoverRevision: "Authority revision",
				editLockMaintRecoverOperations: "Unresolved operation IDs",
				editLockMaintRecoverRisk: "Risk you accept",
				editLockMaintRecoverDigest: "Confirmation digest",
				editLockMaintRecoverConfirm: "Settle this owner online",
				editLockMaintRecoverBusy: "Settling…",
				editLockMaintRecoverDone: "Settled at revision {revision}; admission is unblocked and the unknown outcome stays in history.",
				editLockMaintRecoverFailed: "Recovery not acknowledged:",
				editLockMaintRecoverUpgrade: "Online administrative recovery is unavailable: the server did not return recovery proposals this panel understands (missing or unsupported version). Refresh this panel or upgrade DeepSeek Harness, then inspect again.",
				editLockMaintRecoverReasonDispositionRecorded: "An administrative recovery is already recorded for this owner; admission for its operations is no longer blocked.",
				editLockMaintRecoverReasonOwnerUnknown: "The owner session is not recorded in this authority image.",
				editLockMaintRecoverReasonNotInterrupted: "The holding session is not durably interrupted; the online administrative recovery can only override an interrupted historical owner. Stop the session first, or ask it to release the file.",
				editLockMaintRecoverReasonPreparedOutstanding: "The owner still has a prepared operation; recover to stable unknown history before an administrative override.",
				editLockMaintRecoverReasonPublishingOutstanding: "The owner still has an operation in the publishing phase; only unknown outcomes can be overridden online.",
				editLockMaintRecoverReasonNoUnresolved: "The owner has no unresolved operations; an ordinary unlock may be enough.",
				editLockMaintRecoverReasonUnknown: "The server reported an unrecognized recovery precondition (code: {code}). Refresh or upgrade DeepSeek Harness for the localized explanation.",
			},
			zh: {
				editLockMaint: "编辑锁维护",
				editLockMaintHint: "查看全 profile 的强制执行状态与只读诊断。",
				editLockMaintFailed: "编辑锁维护面板加载失败",
				editLockMaintLoading: "加载中……",
				editLockMaintUnavailable: "维护数据不可用：",
				editLockMaintRetry: "重试",
				editLockMaintRefresh: "刷新",
				editLockMaintInspect: "检查",
				editLockMaintStateEnforced: "强制执行中",
				editLockMaintStateEnforcedHint: "开关已打开，且编辑锁管理器已在本进程中挂载。",
				editLockMaintStateDisableRequested: "已请求停用——需要重启",
				editLockMaintStateDisableRequestedHint: "你已关闭开关，但管理器仍处于挂载并强制执行状态。重启 DeepSeek Harness 后生效。",
				editLockMaintStateEnableRequested: "已请求启用——需要重启",
				editLockMaintStateEnableRequestedHint: "你已打开开关，但本进程尚未挂载管理器。重启 DeepSeek Harness 后生效。",
				editLockMaintStateDisabled: "强制执行已停用",
				editLockMaintStateDisabledHint: "开关关闭，所有已记录且完成安装的行均报告强制执行已停用。",
				editLockMaintStateUnknown: "未知",
				editLockMaintStateUnknownHint: "挂载证据缺失、不一致，或仍在安装、卸载、失败状态。仅凭已保存的值不能证明正在强制执行或已经停用。",
				editLockMaintRestart: "重启 DeepSeek Harness 后生效。",
				editLockMaintPinned: "当前组合在编辑锁行上钉死了配置；这里的设置开关对它不生效。",
				editLockMaintScopeNote: "该开关对整个 profile 生效：覆盖此 profile 下的所有 Weir 会话，而非某一个工作区。",
				editLockMaintWarnKeepHistory: "关闭强制执行不会清除未决操作、围栏或历史——重新打开后同一批文件可能再次被阻塞。",
				editLockMaintWarnUnlock: "普通解锁只释放一把锁且不校验内容；它不是历史恢复，永远不会结清未知的发布。",
				editLockMaintOffRisk: "编辑锁管理器未挂载。普通编辑不受保护，可能覆盖其他会话的工作。保留的锁和围栏不会阻止停用期间的编辑；重新启用并重启后可能再次阻塞文件。",
				editLockMaintUnknownRisk: "无法核实编辑锁的挂载状态。如果管理器未挂载，普通编辑不受保护，可能覆盖其他会话的工作。不能把保留的围栏当成当前仍受保护的证据。",
				editLockMaintHistory: "保留的历史——不是当前阻塞",
				editLockMaintHistoryHint: "这些旧锁与发布围栏保留在磁盘供检查。没有挂载管理器时，它们不会阻止普通编辑；重新启用后可能再次阻塞文件。此处不可在线强制释放；独立的离线管理员恢复端点仍可使用。",
				editLockMaintUnknownHistory: "保留的权威记录——当前作用未经核实",
				editLockMaintUnknownHistoryHint: "仅凭已保存的值与旧围栏无法确认管理器是否挂载。可只读检查这些历史；核实强制执行前不可在线强制释放。独立的离线管理员恢复端点仍可使用。",
				editLockMaintBlocked: "初始化受阻",
				editLockMaintDomains: "管理域",
				editLockMaintNoDomains: "此 profile 中没有活动会话报告编辑锁管理域。",
				editLockMaintAuthorityYes: "权威已存在",
				editLockMaintAuthorityNo: "当前无权威",
				editLockMaintReservation: "存在发布者预留：本进程或另一个 Harness 持有（或遗留）了该域的发布权。",
				editLockMaintPresenceNone: "当前没有权威目录。无法据此判断此前是否初始化过。",
				editLockMaintPresenceEmpty: "权威目录当前为空。无法据此判断此前是否初始化过。",
				editLockMaintPresenceJunk: "权威目录有内容但没有已提交的快照；存储层会拒绝打开它。未做任何改动。",
				editLockMaintPresenceNotAFile: "snapshot.json 不是常规文件；存储层会拒绝它。未做任何改动。",
				editLockMaintPresenceCorrupt: "权威镜像未通过完整性校验，已原样保留——不存在自动修复。拒绝原因：",
				editLockMaintPresenceUnreadable: "无法读取权威：",
				editLockMaintCounts: "{sessions} 个会话 · {locks} 把锁 · {operations} 条已记录操作",
				editLockMaintUnresolved: "未决操作",
				editLockMaintUnresolvedNone: "没有未决操作。",
				editLockMaintRetained: "保留的锁（中断 / 异常 / 待确认）",
				editLockMaintScopeFile: "单个文件",
				editLockMaintScopeSubtree: "一个目录子树",
				editLockMaintScopeDomain: "整个工作目录",
				editLockMaintScopeNone: "无记录范围",
				editLockMaintRecoveries: "在线管理员恢复",
				editLockMaintRecoverHint: "在运行中的管理器里结清已中断 owner 的未知发布：一次明确点击，无需重启、无需手打哈希；历史中的未知结论原样保留。若范围自加载后发生变化，管理器会拒绝，面板会重新加载。",
				editLockMaintRecoverRoot: "管理根",
				editLockMaintRecoverOwner: "属主会话",
				editLockMaintRecoverRevision: "权威 revision",
				editLockMaintRecoverOperations: "未决操作 ID",
				editLockMaintRecoverRisk: "你接受的风险",
				editLockMaintRecoverDigest: "确认摘要",
				editLockMaintRecoverConfirm: "在线结清该 owner",
				editLockMaintRecoverBusy: "结清中……",
				editLockMaintRecoverDone: "已在 revision {revision} 结清；准入阻塞解除，历史仍保持未知。",
				editLockMaintRecoverFailed: "恢复未确认：",
				editLockMaintRecoverUpgrade: "在线管理员恢复不可用：服务端未返回本面板可理解的恢复提案（缺失或版本不受支持）。请刷新本面板或升级 DeepSeek Harness，然后重新检查。",
				editLockMaintRecoverReasonDispositionRecorded: "该 owner 已有记录在案的管理员恢复；其操作的准入已不再阻塞。",
				editLockMaintRecoverReasonOwnerUnknown: "该 owner 会话未记录在此权威镜像中。",
				editLockMaintRecoverReasonNotInterrupted: "持有会话尚未持久中断；在线管理员恢复只能撤权已中断的历史 owner。请先停止该会话，或请它释放文件。",
				editLockMaintRecoverReasonPreparedOutstanding: "该 owner 仍持有 prepared 操作；请先恢复到稳定的 unknown 历史，再进行管理员撤权。",
				editLockMaintRecoverReasonPublishingOutstanding: "该 owner 仍有处于 publishing 阶段的操作；只有 unknown 结论可以在线撤权。",
				editLockMaintRecoverReasonNoUnresolved: "该 owner 没有未决操作；普通解锁或许就已足够。",
				editLockMaintRecoverReasonUnknown: "服务端报告了本面板不认识的恢复前置条件（代码：{code}）。请刷新或升级 DeepSeek Harness 以获取对应说明。",
			},
		};

		exports.dictionaries = dictionaries;
		exports.EditLockMaintenanceBoundary = EditLockMaintenanceBoundary;
		exports.EditLockMaintenanceField = EditLockMaintenanceField;
		// Exported for the chunk tests: the recovery progress key and the zone
		// copy. The recovery derivation lives host-side (inspect.js); the chunk
		// renders and forwards, never computes.
		exports.editLockRecovery = Object.freeze({ recoveryKey, RECOVERY_UX });
		return module.exports;
	}
});
