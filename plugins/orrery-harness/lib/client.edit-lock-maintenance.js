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
		// ---- Online administrative recovery (design D4) --------------------
		// The SAME scoped confirmation algorithm as the offline ADMIN
		// OVERRIDE, implemented client-side so the panel COMPUTES and
		// DISPLAYS the digest: canonical JSON (object keys sorted, arrays in
		// order, JSON scalar spelling, no whitespace) of
		// {root, owner, expectedRevision, operationIds sorted, risk}, SHA-256
		// lowercase hex, prefixed "ADMIN OVERRIDE ". The operator never types
		// a hash: the click submits the computed confirmation.
		const LATE_WRITER_RISK = "Detached historic writers may still modify files after this override.";
		/** @param {unknown} value @returns {string} */
		function canonicalJson(value) {
			if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
			if (value !== null && typeof value === "object") {
				const object = /** @type {Record<string, unknown>} */ (value);
				return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
			}
			return JSON.stringify(value);
		}
		/** @param {string} text @returns {number[]} */
		function utf8Bytes(text) {
			/** @type {number[]} */
			const bytes = [];
			for (let i = 0; i < text.length; i++) {
				let code = text.charCodeAt(i);
				if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
					const next = text.charCodeAt(i + 1);
					if (next >= 0xdc00 && next <= 0xdfff) {
						code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
						i++;
					}
				}
				if (code < 0x80) bytes.push(code);
				else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
				else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
				else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
			}
			return bytes;
		}
		/** @param {number} x @param {number} n */
		function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
		const SHA256_K = [
			0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
			0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
			0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
			0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
			0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
			0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
			0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
			0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
		];
		/** Pure-JS SHA-256 of the UTF-8 encoding, lowercase hex (the client has
		 * no node:crypto; the chunk test pins this against the server digest).
		 * @param {string} text @returns {string} */
		function sha256Hex(text) {
			const bytes = utf8Bytes(text);
			const bitLength = bytes.length * 8;
			bytes.push(0x80);
			while (bytes.length % 64 !== 56) bytes.push(0);
			for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLength / 2 ** (8 * i)) % 256);
			let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
			let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
			const w = new Array(64).fill(0);
			for (let block = 0; block < bytes.length; block += 64) {
				for (let i = 0; i < 16; i++) w[i] = ((bytes[block + 4 * i] << 24) | (bytes[block + 4 * i + 1] << 16) | (bytes[block + 4 * i + 2] << 8) | bytes[block + 4 * i + 3]) >>> 0;
				for (let i = 16; i < 64; i++) {
					const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
					const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
					w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
				}
				let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
				for (let i = 0; i < 64; i++) {
					const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
					const ch = ((e & f) ^ (~e & g)) >>> 0;
					const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
					const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
					const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
					const t2 = (S0 + maj) >>> 0;
					h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
				}
				h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
				h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
			}
			return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, "0")).join("");
		}
		/** The exact offline confirmation string for one recovery scope.
		 * @param {{root: string, owner: string, expectedRevision: number, operationIds: string[]}} scope */
		function recoveryConfirmation(scope) {
			return `ADMIN OVERRIDE ${sha256Hex(canonicalJson({ root: scope.root, owner: scope.owner, expectedRevision: scope.expectedRevision, operationIds: [...scope.operationIds].sort(), risk: LATE_WRITER_RISK }))}`;
		}
		/** Recovery state is scoped exactly like the authority: per domain root
		 * AND owner. Session ids are not unique across independent domains, so
		 * one root's completed recovery must never disable another root's. */
		const recoveryKey = (root, owner) => `${root}\n${owner}`;
		/** Eligible one-click recoveries from one inspection: each interrupted
		 * owner whose every unresolved operation is a still-blocking unknown.
		 * @param {string} root @param {any} snapshot */
		function recoveryCandidates(root, snapshot) {
			const interrupted = new Set((Array.isArray(snapshot?.sessions) ? snapshot.sessions : [])
				.filter((/** @type {any} */ session) => session?.interrupted === true)
				.map((/** @type {any} */ session) => session.sessionId));
			/** @type {Map<string, any[]>} */
			const byOwner = new Map();
			for (const op of Array.isArray(snapshot?.unresolved) ? snapshot.unresolved : []) {
				const owner = op?.key?.sessionId;
				if (typeof owner !== "string") continue;
				const list = byOwner.get(owner) ?? [];
				list.push(op);
				byOwner.set(owner, list);
			}
			/** @type {{owner: string, scope: {root: string, owner: string, expectedRevision: number, operationIds: string[]}, confirmation: string}[]} */
			const candidates = [];
			// An owner with a prepared operation can never be recovered online
			// (the manager requires every unresolved operation to be unknown), so
			// offering the action would present a click that always refuses.
			const preparedOwners = new Set((Array.isArray(snapshot?.prepared) ? snapshot.prepared : [])
				.map((op) => op?.key?.sessionId)
				.filter((owner) => typeof owner === "string"));
			for (const [owner, ops] of byOwner) {
				if (!interrupted.has(owner)) continue;
				if (preparedOwners.has(owner)) continue;
				if (!(ops.length > 0 && ops.every((op) => op?.phase === "unknown" && op?.admissionBlocked === true))) continue;
				const scope = { root, owner, expectedRevision: snapshot.revision, operationIds: ops.map((op) => op.key.operationId).sort() };
				candidates.push({ owner, scope, confirmation: recoveryConfirmation(scope) });
			}
			return candidates;
		}
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
			const [recoveries, setRecoveries] = react.useState(/** @type {Record<string, {status: 'busy'} | {status: 'done', revision: number, idempotent: boolean} | {status: 'error', message: string}>} */ ({}));
			/** The one explicit action: submit the displayed, client-computed
			 * confirmation for one displayed scope. No hash typing, no restart.
			 * A refusal is shown next to a freshly reloaded scope.
			 * @param {string} root @param {ReturnType<typeof recoveryCandidates>[number]} candidate */
			const recover = (root, candidate) => {
				setRecoveries((previous) => ({ ...previous, [recoveryKey(root, candidate.owner)]: { status: "busy" } }));
				post("api/orrery-edit-lock/maintenance/recover-online", {
					root,
					owner: candidate.owner,
					expectedRevision: candidate.scope.expectedRevision,
					operationIds: candidate.scope.operationIds,
					recoveryId: globalThis.crypto?.randomUUID?.() ?? `panel-${Date.now()}-${Math.random().toString(16).slice(2)}`,
					reason: "Confirmed in the Edit Lock maintenance panel: the operator reviewed the displayed scope and accepted the displayed late-writer risk.",
					acceptLateWriterRisk: true,
					confirmation: candidate.confirmation,
				}).then((payload) => {
					setRecoveries((previous) => ({ ...previous, [recoveryKey(root, candidate.owner)]: payload?.ok
						? { status: "done", revision: payload.value.revision, idempotent: payload.value.idempotent === true }
						: { status: "error", message: payload?.error?.detail ?? payload?.error?.message ?? "unknown" } }));
					inspect(root);
				}).catch((error) => {
					setRecoveries((previous) => ({ ...previous, [recoveryKey(root, candidate.owner)]: { status: "error", message: String(error?.message ?? error) } }));
					inspect(root);
				});
			};
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
			/** Recovery card for one eligible owner: the FULL scope, the risk text
			 * verbatim and the computed digest, then the one explicit button.
			 * @param {string} root @param {ReturnType<typeof recoveryCandidates>[number]} candidate */
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
					react_jsx_runtime.jsx("div", { style: dangerStyle, children: `${t("editLockMaintRecoverRisk")}: ${LATE_WRITER_RISK}` }),
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
			const snapshotSection = (/** @type {string} */ root, /** @type {any} */ snapshot) => react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px" }, children: [
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
				recoveryCandidates(root, snapshot).length === 0
					? null
					: react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "6px" }, children: [
						react_jsx_runtime.jsx("div", { style: chainCategoryStyle, children: t("editLockMaintRecoveries") }),
						react_jsx_runtime.jsx("div", { style: chainDescStyle, children: t("editLockMaintRecoverHint") }),
						...recoveryCandidates(root, snapshot).map((candidate) => recoveryCard(root, candidate))
					] })
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
					value.presence === "valid" ? snapshotSection(root, value.snapshot) : null
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
		// Exported for the chunk test's 对拍 against the server-side digest.
		exports.editLockRecovery = Object.freeze({ canonicalJson, sha256Hex, recoveryConfirmation, recoveryCandidates, recoveryKey, LATE_WRITER_RISK });
		return module.exports;
	}
});
