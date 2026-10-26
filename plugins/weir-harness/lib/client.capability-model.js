window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.capability-model.js",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Zero-dependency view-model chunk: the factory never calls require.
		// Pure draft/identity model for the capability Badge and manager
		// (tasks 12.1-12.5) — no DOM access anywhere; every surface decision
		// is a function over plain data so the DOM layer stays thin and the
		// node:test suite covers the semantics.

		// Like the SEGMENT-regex mirror below, same-package sync require is
		// impossible in the ModuleLoader. Mirror src/capabilities/skill-identity.js.
		function skillIdentityKeyOf(identity) {
			if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
			const { scope, root, name, provenance, opaqueId } = identity;
			if (typeof scope !== "string" || typeof root !== "string" || typeof name !== "string") return null;
			const sorted = provenance == null ? null : Object.fromEntries(Object.keys(provenance).sort().map(key => [key, provenance[key]]));
			return JSON.stringify([scope, root, name, sorted, sorted === null ? (opaqueId ?? null) : null]);
		}
		function skillEntryKeyOf(entry) {
			if (typeof entry === "string") return "name:" + entry;
			const key = skillIdentityKeyOf(entry);
			return key === null ? null : "id:" + key;
		}
		const sortSkills = (entries) => [...entries].sort((a, b) => {
			const left = skillEntryKeyOf(a), right = skillEntryKeyOf(b);
			return left < right ? -1 : left > right ? 1 : 0;
		});

		/** Only a complete, warning-free effective receipt proves applied counts. */
		function badgeStateOf(receipt, draft) {
			const warnings = Array.isArray(receipt?.warnings) ? [...receipt.warnings] : [];
			const known = receipt?.status === "applied" && warnings.length === 0
				&& Array.isArray(receipt?.effective?.skills) && Array.isArray(receipt?.effective?.mcpServers);
			return {
				applied: known ? { skills: receipt.effective.skills.length, mcpServers: receipt.effective.mcpServers.length } : null,
				warnings,
				unavailable: warnings.filter((warning) => typeof warning === "string" && warning.includes("unavailable")),
				draftDirty: Boolean(draft && draft.dirty),
				known,
				degraded: receipt?.status === "applied" && !known,
			};
		}

		/** The manager's two-view partition with source labels (12.2). */
		const SOURCE_LABELS = { "weir-builtin": "Weir builtin", user: "user", project: "project", custom: "custom" };
		function skillRowOf(candidate) {
			const status = candidate?.status ?? "unknown";
			return {
				name: candidate?.name ?? "unknown",
				description: candidate?.description ?? "",
				// scopeKey feeds the scope-grouped sections (D3); source stays the
				// display label (12.2).
				scopeKey: candidate?.scope ?? "unknown",
				source: SOURCE_LABELS[candidate?.scope] ?? candidate?.scope ?? "unknown",
				status,
				// A candidate the inventory could not parse is the row-level
				// missing/unavailable mark; selected-but-absent names surface via
				// the commit flow's missing phase (12.3), never as hidden rows.
				missing: status !== "parsed" && status !== "unknown",
				selected: Boolean(candidate?.selected),
				conflict: candidate?.conflict === true,
				identity: candidate?.identity ?? null,
			};
		}
		function partitionManagerListing(listing) {
			const skills = (Array.isArray(listing?.skills) ? listing.skills : []).map(skillRowOf);
			const mcp = Array.isArray(listing?.mcpServers) ? listing.mcpServers : [];
			return {
				skills,
				mcpManaged: mcp.filter((server) => server?.state !== "unmanaged"),
				mcpUnmanaged: mcp.filter((server) => server?.state === "unmanaged"),
			};
		}

		/** Unsupported vs loading vs unknown stays distinguishable (12.2). */
		function managerConditionState(conditions) {
			if (!Array.isArray(conditions)) return "unknown";
			if (conditions.length === 0) return "supported";
			return "unsupported";
		}

		/**
		 * Second-window convergence (12.5): an agent-preset/selected frame
		 * refreshes THIS session's Badge only when the frame names the same
		 * session ID; anything else is ignored. A missing subscription
		 * degrades to an explicit refresh hint rather than silent staleness.
		 */
		function frameRefreshesSession(frame, sessionId) {
			return Boolean(frame && sessionId && frame.sessionId === sessionId);
		}
		function convergenceHintOf({ subscribed }) {
			return subscribed ? null : "refresh to sync";
		}

		// ---- Draft editing (12.3 manager Apply surface) ----
		/** The edit draft seeded from the server receipt (CAS revision included). */
		function draftFromReceipt(receipt) {
			const skills = Array.isArray(receipt?.effective?.skillIdentities) ? [...receipt.effective.skillIdentities]
				: Array.isArray(receipt?.effective?.skills) ? [...receipt.effective.skills] : [];
			const mcpServers = Array.isArray(receipt?.effective?.mcpServers) ? [...receipt.effective.mcpServers] : [];
			const warnings = Array.isArray(receipt?.warnings) ? receipt.warnings.filter(Boolean).map(String) : [];
			const digest = receipt?.effective?.digest;
			const provable = receipt?.status === "applied" && warnings.length === 0 && Number.isSafeInteger(receipt.revision) && receipt.revision >= 0
				&& Array.isArray(receipt?.effective?.skillIdentities) && Array.isArray(receipt?.effective?.mcpServers)
				&& typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);
			return {
				skills: sortSkills(skills),
				mcpServers: [...mcpServers].sort(),
				applied: { skills: sortSkills(skills), mcpServers: [...mcpServers].sort(), unresolvedRefs: Array.isArray(receipt?.effective?.unresolvedRefs) ? [...receipt.effective.unresolvedRefs] : [] },
				unresolvedRefs: Array.isArray(receipt?.effective?.unresolvedRefs) ? [...receipt.effective.unresolvedRefs] : [],
				...(provable ? { appliedDigest: digest } : {}),
				appliedSourceIssue: warnings.length ? "unavailable" : provable ? null : "receipt",
				revision: Number.isSafeInteger(receipt?.revision) ? receipt.revision : 0,
				dirty: false,
			};
		}
		/** A degraded read is not permission to overwrite a user's staged selection.
		 * Keep the last CAS base (the server will reject a stale revision) and
		 * revoke applied-source proof until a complete refresh arrives. */
		function draftAfterRefresh(current, receipt) {
			if (!badgeStateOf(receipt, null).known) {
				if (current) return { ...current, unknownBaseline: true, overwriteConfirmed: false, appliedSourceIssue: "unavailable", appliedDigest: undefined };
				return receipt?.status === "applied" && Number.isSafeInteger(receipt.revision) && receipt.revision >= 0
					? { ...draftFromReceipt(receipt), unknownBaseline: true, overwriteConfirmed: false } : null;
			}
			const fresh = draftFromReceipt(receipt);
			if (!current?.dirty) return fresh;
			const sameBase = current.revision === fresh.revision
				&& JSON.stringify(current.applied.skills.map(skillEntryKeyOf)) === JSON.stringify(fresh.applied.skills.map(skillEntryKeyOf))
				&& JSON.stringify(current.applied.mcpServers) === JSON.stringify(fresh.applied.mcpServers);
			return { ...current, unknownBaseline: current.unknownBaseline === true && !sameBase, overwriteConfirmed: false, appliedSourceIssue: sameBase ? fresh.appliedSourceIssue : "receipt", appliedDigest: sameBase ? fresh.appliedDigest : undefined };
		}

		/** Toggle one entry in the draft; skills compare by identity, MCP by name. */
		function draftToggle(draft, kind, name) {
			if (kind === "skills") {
				const key = skillEntryKeyOf(name);
				const list = new Map(draft.skills.map(entry => [skillEntryKeyOf(entry), entry]));
				if (list.has(key)) list.delete(key); else list.set(key, name);
				const next = { ...draft, overwriteConfirmed: false, skills: sortSkills([...list.values()]) };
				next.dirty = draftDiffOf(next).any;
				return next;
			}
			const list = new Set(draft[kind]);
			if (list.has(name)) list.delete(name); else list.add(name);
			const next = { ...draft, overwriteConfirmed: false, [kind]: [...list].sort() };
			const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
			next.dirty = !same(next.skills.map(skillEntryKeyOf), draft.applied.skills.map(skillEntryKeyOf)) || !same(next.mcpServers, draft.applied.mcpServers);
			return next;
		}
		/** Preflight the complete draft against the unfiltered inventory. Strings are not identities.
		 * Only a reference the CURRENT listing resolves to a parsed candidate can
		 * take part in a local same-name conflict: a preset entry rooted in another
		 * workspace (or otherwise unresolved here) has no applicable row, so it is
		 * not a second selection this session could apply and it never disables
		 * Apply. It stays in the draft untouched — the server decides whether it is
		 * inapplicable (skipped, warned) or genuinely unknown (hard failure). */
		function skillDraftConflicts(draft, listing) {
			const byName = new Map(), names = new Set();
			for (const entry of Array.isArray(draft?.skills) ? draft.skills : []) {
				if (typeof entry === "string") { if (entry) names.add(entry); continue; }
				const key = skillIdentityKeyOf(entry);
				if (key === null) continue;
				if (!byName.has(entry.name)) byName.set(entry.name, new Map());
				byName.get(entry.name).set(key, entry);
			}
			const rows = Array.isArray(listing?.skills) ? listing.skills : null;
			const resolvable = new Set();
			for (const row of rows ?? []) {
				if (row?.status !== "parsed") continue;
				const key = skillIdentityKeyOf(row.identity);
				if (key !== null) resolvable.add(key);
			}
			const selected = [...byName]
				.map(([name, group]) => ({ name, identities: [...group].filter(([key]) => resolvable.has(key)).map(([, entry]) => entry) }))
				.filter((item) => item.identities.length > 1);
			const unresolved = [...names].map(name => {
				if (!rows) return { name, state: "unavailable", candidates: [] };
				const candidates = [...new Map(rows.filter(row => row?.status === "parsed" && row.name === name && skillIdentityKeyOf(row.identity) !== null)
					.map(row => [skillIdentityKeyOf(row.identity), row.identity])).values()];
				return { name, state: candidates.length > 1 ? "ambiguous" : candidates.length === 1 ? "unique" : "unknown", candidates };
			});
			return { selected, unresolved };
		}

		/** Explicit legacy-name recovery never consumes any other entry or CAS metadata. */
		function resolveSkillName(draft, name, identity) {
			if (!draft || typeof name !== "string" || !name || !draft.skills?.includes(name) || (identity !== null && (skillIdentityKeyOf(identity) === null || identity.name !== name))) return draft;
			const entries = draft.skills.filter(entry => entry !== name);
			if (identity && !entries.some(entry => skillEntryKeyOf(entry) === skillEntryKeyOf(identity))) entries.push(identity);
			const next = { ...draft, overwriteConfirmed: false, skills: sortSkills(entries) };
			next.dirty = draftDiffOf(next).any;
			return next;
		}

		/** Scoped ordinal distinguishes same-scope roots without displaying paths or IDs. */
		function skillSourceLabels(rows) {
			const labels = new Map(), totals = new Map();
			for (const row of Array.isArray(rows) ? rows : []) {
				const key = skillIdentityKeyOf(row.identity);
				if (key === null || labels.has(key)) continue;
				const scope = SOURCE_LABELS[row.scopeKey ?? row.scope] ?? row.scopeKey ?? row.scope ?? "unknown";
				const group = `${row.name}:${scope}`;
				const number = (totals.get(group) ?? 0) + 1;
				totals.set(group, number);
				labels.set(key, { scope, group, number });
			}
			for (const [key, item] of labels) labels.set(key, totals.get(item.group) > 1 ? `${item.scope} · source ${item.number}` : item.scope);
			return Object.fromEntries(labels);
		}
		/**
		 * Map the engine response onto the commit state machine (12.3): applied
		 * refreshes; revision-conflict shows the current state for re-pick;
		 * indeterminate stays queryable; structured rejections preserve names;
		 * anything else keeps the draft.
		 */
		function commitOutcomeOf(response) {
			if (!response || typeof response !== "object") return { phase: "failed", error: "no response", draftKept: true };
			// preset-skill-applicability: an applied commit may carry per-name
			// skipped entries (known to the profile but not applicable in this
			// preset) — the manager renders them as a warning, never a failure.
			const skipped = Array.isArray(response.skipped)
				? response.skipped.filter(entry => entry && typeof entry.name === "string").map(entry => ({ name: entry.name, reason: typeof entry.reason === "string" ? entry.reason : "not applicable in this agent preset" }))
				: [];
			if (response.status === "applied") return { phase: "applied", revision: response.revision ?? null, skipped };
			if (response.status === "revision-conflict") return { phase: "revision-conflict", current: response.current ?? null, draftKept: true };
			if (response.status === "indeterminate") return { phase: "indeterminate", requestId: response.receipt?.requestId ?? null, queryable: true };
			if (response.status === "missing") return { phase: "missing", names: Array.isArray(response.missing) ? response.missing.filter(name => typeof name === "string") : [], draftKept: true };
			if (response.status === "rejected" && response.reason === "same-name-conflict") return { phase: "same-name-conflict", names: Array.isArray(response.conflicts) ? response.conflicts.map(item => item?.name).filter(name => typeof name === "string") : [], draftKept: true };
			return { phase: "failed", error: String(response.reason ?? response.status ?? "unknown"), draftKept: true };
		}

		// ---- Manager redesign (D3): grouping, search, diff summary, validation ----

		/** Scope-grouped skill sections in a fixed order; empty groups drop out. */
		const SCOPE_GROUP_ORDER = ["weir-builtin", "user", "project", "custom"];
		function groupSkillRows(rows) {
			const byKey = new Map();
			for (const row of Array.isArray(rows) ? rows : []) {
				const key = SCOPE_GROUP_ORDER.includes(row?.scopeKey) ? row.scopeKey : "other";
				if (!byKey.has(key)) byKey.set(key, []);
				byKey.get(key).push(row);
			}
			return [...SCOPE_GROUP_ORDER, "other"]
				.filter((key) => byKey.has(key))
				.map((key) => ({ key, label: key === "other" ? "other" : (SOURCE_LABELS[key] ?? key), rows: byKey.get(key) }));
		}

		/** Search stays a pure filter over name + description (12.2/D3). */
		function filterSkillRows(rows, query) {
			const list = Array.isArray(rows) ? rows : [];
			const needle = String(query ?? "").trim().toLowerCase();
			if (needle === "") return list;
			return list.filter((row) => row.name.toLowerCase().includes(needle) || String(row.description ?? "").toLowerCase().includes(needle));
		}

		/** Net add/remove counts of the dirty draft against the applied sets (D3 footer). */
		function draftDiffOf(draft) {
			const empty = { skillsAdded: 0, skillsRemoved: 0, mcpAdded: 0, mcpRemoved: 0, any: false };
			if (!draft || !Array.isArray(draft.skills) || !Array.isArray(draft.mcpServers) || !draft.applied) return empty;
			const count = (current, base) => {
				const baseSet = new Set(Array.isArray(base) ? base : []);
				const currentSet = new Set(current);
				let added = 0;
				let removed = 0;
				for (const name of currentSet) if (!baseSet.has(name)) added += 1;
				for (const name of baseSet) if (!currentSet.has(name)) removed += 1;
				return { added, removed };
			};
			const skills = count(draft.skills.map(skillEntryKeyOf), (draft.applied.skills ?? []).map(skillEntryKeyOf));
			const mcp = count(draft.mcpServers, draft.applied.mcpServers);
			return {
				skillsAdded: skills.added,
				skillsRemoved: skills.removed,
				mcpAdded: mcp.added,
				mcpRemoved: mcp.removed,
				any: skills.added + skills.removed + mcp.added + mcp.removed > 0,
			};
		}

		// Verbatim copy of the store path segment rule
		// (src/capabilities/store/paths.js SEGMENT): same-package sync require is
		// impossible in the ModuleLoader, so the add-form's identity check
		// mirrors it here.
		const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
		/** Per-field managed-MCP add-form errors; an empty object means valid. */
		function mcpAddErrorsOf(fields) {
			const errors = {};
			const identity = String(fields?.identity ?? "").trim();
			if (identity === "") errors.identity = "required";
			else if (!SEGMENT.test(identity)) errors.identity = "invalid";
			if (String(fields?.command ?? "").trim() === "") errors.command = "required";
			return errors;
		}

		// ---- Presets & workspace default (D3 model half) ----

		/** Stage a loaded preset document into the local draft (stagePreset
		 * semantics): only the resolved sets enter the draft; unresolved refs are
		 * carried for reporting; the CAS base (revision/applied) is kept; preset
		 * metadata never produces an Apply by itself — dirty is recomputed
		 * against the applied sets. */
		function draftFromPreset(document, current, resolveName) {
			const selection = document?.selection ?? {};
			const clean = (value) => (Array.isArray(value) ? value.map(String) : []).sort();
			const skills = sortSkills((Array.isArray(selection.skills) ? selection.skills : []).map(entry =>
				typeof entry === "string" ? (resolveName?.(entry) ?? entry) : entry));
			const mcpServers = clean(selection.mcpServers);
			const unresolvedRefs = Array.isArray(selection.unresolvedRefs) ? [...selection.unresolvedRefs] : [];
			const applied = current?.applied && Array.isArray(current.applied.skills) && Array.isArray(current.applied.mcpServers)
				? current.applied
				: { skills: [], mcpServers: [] };
			const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
			return {
				skills,
				mcpServers,
				applied,
				revision: Number.isSafeInteger(current?.revision) ? current.revision : 0,
				unknownBaseline: current?.unknownBaseline === true,
				overwriteConfirmed: false,
				...(typeof current?.appliedDigest === "string" ? { appliedDigest: current.appliedDigest } : {}),
				appliedSourceIssue: current?.appliedSourceIssue === null ? null : current?.appliedSourceIssue ?? "receipt",
				unresolvedRefs,
				dirty: !same(skills.map(skillEntryKeyOf), sortSkills(applied.skills).map(skillEntryKeyOf)) || !same(mcpServers, [...applied.mcpServers].sort()),
			};
		}

		/** One preset row summary: identity plus entry counts (never the document). */
		function presetRowOf(preset) {
			const counts = preset?.counts ?? {};
			const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
			const presetId = typeof preset?.presetId === "string" ? preset.presetId : "unknown";
			return {
				scope: preset?.scope === "workspace" ? "workspace" : "global",
				presetId,
				name: typeof preset?.name === "string" && preset.name !== "" ? preset.name : presetId,
				revision: Number.isSafeInteger(preset?.revision) ? preset.revision : 0,
				counts: {
					skills: count(counts.skills),
					mcpServers: count(counts.mcpServers),
					unresolvedRefs: count(counts.unresolvedRefs),
				},
			};
		}

		/** A tombstone or incomplete document cannot be staged as an empty draft. */
		function loadablePresetOf(response) {
			const document = response?.document;
			return response?.status === "ok" && document && document.deleted !== true && document.tombstone !== true
				&& Array.isArray(document.selection?.skills) && Array.isArray(document.selection?.mcpServers) && Array.isArray(document.selection?.unresolvedRefs);
		}
		/** Preset listing grouped by namespace, sorted by display name. */
		function groupPresets(payload) {
			const rows = (Array.isArray(payload?.presets) ? payload.presets : []).map(presetRowOf);
			const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.presetId < b.presetId ? -1 : a.presetId > b.presetId ? 1 : 0);
			return {
				workspaceKey: typeof payload?.workspaceKey === "string" ? payload.workspaceKey : null,
				global: rows.filter((row) => row.scope === "global").sort(byName),
				workspace: rows.filter((row) => row.scope === "workspace").sort(byName),
			};
		}

		/** preset-save / preset-delete outcome categorization (explicit statuses,
		 * never silent overwrites). */
		function presetWriteOutcomeOf(response) {
			if (!response || typeof response !== "object" || response.error === true) return { kind: "error" };
			if (response.status === "created" || response.status === "edited") return { kind: response.status, presetId: response.presetId ?? null, revision: response.revision ?? null };
			if (response.status === "deleted") return { kind: "deleted", revision: response.revision ?? null };
			if (response.status === "name-conflict" || response.status === "rename-required") return { kind: "name-conflict", with: response.with ?? null, ...(Number.isSafeInteger(response.withRevision) && response.withRevision > 0 ? { withRevision: response.withRevision } : {}) };
			if (response.status === "source-unavailable") return { kind: "source-unavailable", missing: Array.isArray(response.missing) ? response.missing.filter(name => typeof name === "string") : [] };
			if (["locked", "unreadable", "unsupported", "source-changed", "absent", "deleted", "confirmation-required", "indeterminate"].includes(response.status)) return { kind: response.status };
			if (response.status === "revision-conflict") return { kind: "revision-conflict" };
			if (response.status === "exists") return { kind: "exists", presetId: response.presetId ?? null };
			if (response.status === "no-workspace") return { kind: "no-workspace" };
			return { kind: "error", status: response.status ?? "unknown" };
		}

		/** preset-import feedback: created-with-binding counts, a name collision
		 * needing a decision, a validation rejection with its reason, or a plain
		 * failure. */
		function importFeedbackOf(response) {
			if (!response || typeof response !== "object" || response.error === true) return { kind: "error" };
			if (response.status === "created" || response.status === "edited") {
				return {
					kind: response.status,
					presetId: response.presetId ?? null,
					bound: Number.isSafeInteger(response.bound?.mcpServers) ? response.bound.mcpServers : 0,
					unresolved: Number.isSafeInteger(response.bound?.unresolvedRefs) ? response.bound.unresolvedRefs : 0,
				};
			}
			if (response.status === "name-conflict" || response.status === "rename-required") return { kind: "name-conflict", with: response.with ?? null, ...(Number.isSafeInteger(response.withRevision) && response.withRevision > 0 ? { withRevision: response.withRevision } : {}) };
			if (["locked", "unreadable", "unsupported", "revision-conflict", "confirmation-required", "indeterminate"].includes(response.status)) return { kind: response.status };
			if (response.status === "rejected") return { kind: "rejected", reason: String(response.reason ?? "rejected") };
			if (response.status === "no-workspace") return { kind: "no-workspace" };
			return { kind: "error", status: response.status ?? "unknown" };
		}

		/** preset-export viewer text: pretty-printed document JSON, or an error. */
		function presetExportTextOf(response) {
			if (!response || typeof response !== "object" || response.error === true) return { kind: "error" };
			if (response.status !== "ok" || !response.document || typeof response.document !== "object") return { kind: "error", status: response.status ?? "unknown" };
			try {
				return { kind: "ok", text: JSON.stringify(response.document, null, 2) };
			} catch {
				return { kind: "error", status: "unserializable" };
			}
		}

		/** Workspace-default inspection: none (absent or cleared — clearing is
		 * never an empty set), an explicit empty set, or n entries. */
		function defaultStateOf(response) {
			if (!response || typeof response !== "object" || response.error === true) return { kind: "error" };
			if (response.status === "no-workspace" || response.status === "unsupported") return { kind: "unsupported" };
			if (response.status === "absent") return { kind: "none", cleared: false, workspaceKey: response.workspaceKey ?? null };
			if (response.status !== "ok") return { kind: "error", status: response.status ?? "unknown" };
			const revision = Number.isSafeInteger(response.revision) ? response.revision : 0;
			if (response.cleared === true) return { kind: "none", cleared: true, revision, workspaceKey: response.workspaceKey ?? null };
			const snapshot = response.snapshot && typeof response.snapshot === "object" ? response.snapshot : {};
			const count = (value) => (Array.isArray(value) ? value.length : 0);
			const skills = count(snapshot.skills);
			const mcpServers = count(snapshot.mcpServers);
			const unresolvedRefs = count(snapshot.unresolvedRefs);
			if (skills + mcpServers === 0) return { kind: "empty", revision, unresolvedRefs, workspaceKey: response.workspaceKey ?? null };
			return { kind: "entries", revision, skills, mcpServers, unresolvedRefs, workspaceKey: response.workspaceKey ?? null };
		}

		/** default-save / default-clear outcome categorization. */
		function defaultWriteOutcomeOf(response) {
			if (!response || typeof response !== "object" || response.error === true) return { kind: "error" };
			if (response.status === "saved" || response.status === "cleared") return { kind: response.status, revision: response.revision ?? null };
			if (response.status === "revision-conflict") return { kind: "revision-conflict" };
			if (response.status === "no-workspace") return { kind: "no-workspace" };
			return { kind: "error", status: response.status ?? "unknown" };
		}

		/** Display label for one unresolved ref (portable refs are objects; a
		 * plain string ref renders as itself). */
		function unresolvedLabelOf(ref) {
			if (typeof ref === "string") return ref;
			if (ref && typeof ref === "object") {
				if (typeof ref.name === "string" && ref.name !== "") return ref.name;
				if (typeof ref.ref === "string" && ref.ref !== "") return ref.ref;
				if (typeof ref.hint === "string" && ref.hint !== "") return ref.hint;
				// Wrapped refs ({kind, ref:{...}} — the shape import binding and
				// the v2 dry-run produce): label by the carried name.
				if (ref.ref && typeof ref.ref === "object" && typeof ref.ref.name === "string" && ref.ref.name !== "") return ref.ref.name;
				try {
					return JSON.stringify(ref);
				} catch {
					return "unresolved";
				}
			}
			return "unresolved";
		}

		// ---- Version-2 package export/import (D6 two-phase) ----

		/** Version dispatch, mirroring the server gate exactly: a document whose
		 * version is 2 takes the two-phase import (dry-run summary, then an
		 * explicit confirm); anything else keeps the v1 single-step path whose
		 * own server-side gate rejects unknown versions atomically. */
		function packageVersionOf(document) {
			if (document !== null && typeof document === "object" && !Array.isArray(document) && document.version === 2) return 2;
			return null;
		}

		/** Phase one of the package import: categorize the dry-run response into
		 * the summary surface — one install row per bundled Skill (scope, name,
		 * file count, resolved target root, collision flag), the collision
		 * subset, and the unresolved refs. The dry-run wrote NOTHING; a rejection
		 * here is still the atomic zero-write gate. */
		function importDryRunOf(response) {
			if (!response || typeof response !== "object" || response.error === true) return { kind: "error" };
			if (response.status === "rejected") return { kind: "rejected", reason: String(response.reason ?? "rejected") };
			if (response.status === "no-workspace") return { kind: "no-workspace" };
			if (response.status !== "dry-run") return { kind: "error", status: response.status ?? "unknown" };
			const scopeOf = (value) => (typeof value === "string" && value !== "" ? value : "project");
			const install = (Array.isArray(response.install) ? response.install : []).map((row) => ({
				targetScope: scopeOf(row?.targetScope),
				name: typeof row?.name === "string" && row.name !== "" ? row.name : "unknown",
				fileCount: Number.isSafeInteger(row?.fileCount) && row.fileCount >= 0 ? row.fileCount : 0,
				targetRoot: typeof row?.targetRoot === "string" ? row.targetRoot : null,
				collision: row?.collision === true,
			}));
			const collisions = (Array.isArray(response.collisions) ? response.collisions : []).map((row) => ({
				targetScope: scopeOf(row?.targetScope),
				name: typeof row?.name === "string" && row.name !== "" ? row.name : "unknown",
			}));
			return {
				kind: "summary",
				install,
				collisions,
				unresolved: Array.isArray(response.unresolved) ? [...response.unresolved] : [],
				// The explicit collision list is authoritative; the per-row flags
				// cover the same signal, so either one arms the decision control.
				hasCollisions: collisions.length > 0 || install.some((row) => row.collision),
			};
		}

		/** Confirm gating: a summary must be on screen, and when collisions exist
		 * the decision control must hold an explicit choice — cancel is the
		 * default and is itself a valid explicit decision. */
		function importConfirmReadyOf(summary, decision) {
			if (!summary || summary.kind !== "summary") return false;
			if (!summary.hasCollisions) return true;
			return decision === "cancel" || decision === "replace" || decision === "coexist";
		}

		/** Phase two of the package import: categorize the confirmed response —
		 * the created preset with its installed rows and collision decisions, a
		 * name collision needing its own decision, an install failure with the
		 * rollback count (no preset record was created), or a missing target
		 * root. */
		function importConfirmOutcomeOf(response) {
			if (!response || typeof response !== "object") return { kind: "error" };
			if (response.error === true) return { kind: "error", ...(Array.isArray(response.installed) ? { installed: response.installed } : {}), ...(response.presetStatus === "unconfirmed" ? { presetStatus: "unconfirmed" } : {}) };
			if (response.status === "created" || response.status === "edited") {
				const scopeOf = (value) => (typeof value === "string" && value !== "" ? value : "project");
				return {
					kind: response.status,
					presetId: response.presetId ?? null,
					bound: Number.isSafeInteger(response.bound?.mcpServers) ? response.bound.mcpServers : 0,
					unresolved: Number.isSafeInteger(response.bound?.unresolvedRefs)
						? response.bound.unresolvedRefs
						: (Array.isArray(response.unresolved) ? response.unresolved.length : 0),
					installed: (Array.isArray(response.installed) ? response.installed : []).map((row) => ({
						targetScope: scopeOf(row?.targetScope),
						// The server's final on-disk name (a coexist rename lands here);
						// fall back to the requested name.
						name: typeof row?.target === "string" && row.target !== "" ? row.target : (typeof row?.name === "string" && row.name !== "" ? row.name : "unknown"),
						fileCount: Number.isSafeInteger(row?.fileCount) && row.fileCount >= 0 ? row.fileCount : 0,
						status: typeof row?.status === "string" && row.status !== "" ? row.status : "installed",
					})),
					collisions: (Array.isArray(response.collisions) ? response.collisions : []).map((row) => ({
						targetScope: scopeOf(row?.targetScope),
						name: typeof row?.name === "string" && row.name !== "" ? row.name : "unknown",
						decision: typeof row?.decision === "string" && row.decision !== "" ? row.decision : "cancel",
					})),
				};
			}
			if (response.status === "install-failed") {
				return { kind: "install-failed", reason: String(response.reason ?? "install-failed"), rolledBack: Number.isSafeInteger(response.rolledBack) && response.rolledBack >= 0 ? response.rolledBack : 0 };
			}
			if (response.status === "no-target-root") return { kind: "no-target-root", targetScope: String(response.targetScope ?? "unknown") };
			if (response.status === "name-conflict" || response.status === "rename-required") return { kind: "name-conflict", with: response.with ?? null, ...(Number.isSafeInteger(response.withRevision) && response.withRevision > 0 ? { withRevision: response.withRevision } : {}) };
			if (["locked", "unreadable", "unsupported", "revision-conflict", "confirmation-required", "indeterminate", "commit-failed", "write-failed", "preset-unconfirmed"].includes(response.status)) return { kind: response.status, installed: Array.isArray(response.installed) ? response.installed : [], ...(response.presetStatus === "unconfirmed" ? { presetStatus: "unconfirmed" } : {}) };
			if (response.status === "no-workspace") return { kind: "no-workspace" };
			if (response.status === "rejected") return { kind: "rejected", reason: String(response.reason ?? "rejected") };
			return { kind: "error", status: response.status ?? "unknown", ...(Array.isArray(response.installed) ? { installed: response.installed } : {}), ...(response.presetStatus === "unconfirmed" ? { presetStatus: "unconfirmed" } : {}) };
		}

		/** Download filename for the exported package JSON: derived from the
		 * preset's display name, reduced to a portable slug; a name with no
		 * ASCII content falls back to the preset id, then to "preset". */
		function exportFileNameOf(name, presetId) {
			const slug = (value) => String(value ?? "")
				.trim().toLowerCase()
				.replace(/[^a-z0-9_-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 64);
			const base = slug(name) || slug(presetId) || "preset";
			return `${base}.json`;
		}

		// ---- Managed MCP inventory, editor, preview and batch model ----
		const MCP_STATES = new Set(["unknown", "registered", "mounted", "degraded", "cleanup-failed", "cleanup-unknown", "conflict"]);
		const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
		const MCP_CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
		const MCP_DOCUMENT_LIMIT = 1024 * 1024;

		function mcpStateOf(server) {
			return MCP_STATES.has(server?.state) ? server.state : "unknown";
		}

		function mcpListingAfterRead(current, incoming) {
			if (incoming && incoming.error !== true) return incoming;
			return current ? { ...current, stale: true, refreshError: true } : { error: true };
		}

		function mcpSecretRowsOf(config, kind) {
			const refs = config?.secretRefs?.[kind] ?? {};
			const literals = config?.client?.[kind] ?? {};
			const keys = [...new Set([...Object.keys(refs), ...Object.keys(literals)])].sort();
			return keys.map((key) => ({
				key, action: "keep", source: refs[key] ? "ref" : "value",
				ref: refs[key]?.ref ?? "", prefix: refs[key]?.prefix ?? "", value: "", configured: true,
			}));
		}

		function mcpPublicArgsOf(config) {
			const secret = new Set(Object.keys(config?.secretRefs?.args ?? {}).map(Number));
			return (config?.client?.args ?? []).map((value, index) => secret.has(index) ? "" : value);
		}

		function mcpEditorFromServer(server, registryRevision = 0) {
			const config = server?.config ?? {};
			const client = config.client ?? {};
			const transport = config.transport?.kind ?? client.transport ?? server?.transport ?? "stdio";
			const reconnect = client.reconnect ?? {};
			const legacySensitiveUrl = client.url === "[redacted-url]";
			const secretUrl = config.secretRefs?.url;
			return {
				mode: server ? "edit" : "add",
				identity: server?.identity ?? "", label: server?.label ?? "", serverName: client.serverName ?? server?.serverName ?? server?.identity ?? "",
				originalServerName: client.serverName ?? server?.serverName ?? server?.identity ?? "",
				transport,
				command: client.command ?? "", argsText: JSON.stringify(mcpPublicArgsOf(config)), cwd: client.cwd ?? "",
				url: legacySensitiveUrl ? "" : client.url ?? "", urlRef: secretUrl?.ref ?? "", urlPrefix: secretUrl?.prefix ?? "",
				urlMode: secretUrl ? "ref" : legacySensitiveUrl ? "legacy" : "literal", urlAction: server ? "keep" : "replace",
				envRows: mcpSecretRowsOf(config, "env"), headerRows: mcpSecretRowsOf(config, "headers"),
				secretArgRows: Object.entries(config.secretRefs?.args ?? {}).map(([index, item]) => ({ index, action: "keep", source: "ref", ref: item.ref ?? "", prefix: item.prefix ?? "", value: "", configured: true })),
				toolCallTimeoutMs: client.toolCallTimeoutMs == null ? "" : String(client.toolCallTimeoutMs),
				maxInstructionBytes: client.maxInstructionBytes == null ? "" : String(client.maxInstructionBytes),
				reconnectConfigured: Boolean(client.reconnect), reconnectEnabled: reconnect.enabled === true,
				reconnectInitialDelayMs: reconnect.initialDelayMs == null ? "" : String(reconnect.initialDelayMs),
				reconnectMaxDelayMs: reconnect.maxDelayMs == null ? "" : String(reconnect.maxDelayMs),
				reconnectMaxAttempts: reconnect.maxAttempts == null ? "" : String(reconnect.maxAttempts),
				registryRevision, targetFingerprint: server?.fingerprint ?? null,
			};
		}

		function mcpParseArgs(text) {
			const raw = String(text ?? "").trim();
			if (!raw) return [];
			if (!raw.startsWith("[")) return raw.split(/\s+/).filter(Boolean);
			let parsed;
			try { parsed = JSON.parse(raw); } catch { throw Object.assign(new Error("Arguments must be a JSON array or space-separated text"), { field: "args" }); }
			if (!Array.isArray(parsed) || parsed.length > 128 || parsed.some((value) => typeof value !== "string")) throw Object.assign(new Error("Arguments must be at most 128 strings"), { field: "args" });
			return parsed;
		}

		function mcpSensitiveUrl(value) {
			const text = String(value ?? "");
			return /[?#]/.test(text) || /^https?:\/\/[^/\s]*@/i.test(text);
		}

		function mcpPositiveNumber(value, field, integer = false) {
			if (value === "" || value == null) return undefined;
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isSafeInteger(parsed))) throw Object.assign(new Error(`${field} must be a positive number`), { field });
			return parsed;
		}

		function mcpApplySecretRows(rows, kind, refs, values) {
			for (const row of rows ?? []) {
				const key = String(kind === "args" ? row.index : row.key ?? "").trim();
				if (!key || row.action === "keep") continue;
				if (row.action === "remove") { values[kind][key] = { action: "remove" }; continue; }
				if (row.source === "ref") refs[kind][key] = { ref: String(row.ref ?? "").trim(), ...(row.prefix ? { prefix: row.prefix } : {}) };
				else if (String(row.value ?? "").length > 0) values[kind][key] = { action: "replace", value: row.value, ...(row.prefix ? { prefix: row.prefix } : row.prefixDirty === true ? { prefix: "" } : {}) };
			}
		}

		function mcpConfigFromEditor(editor) {
			const identity = String(editor.identity ?? "").trim();
			const config = {
				identity, label: String(editor.label ?? "").trim() || identity,
				transport: editor.transport,
				serverName: String(editor.serverName ?? "").trim() || identity,
			};
			for (const key of ["toolCallTimeoutMs", "maxInstructionBytes"]) {
				const value = mcpPositiveNumber(editor[key], key, key === "maxInstructionBytes");
				if (value !== undefined) config[key] = value;
			}
			if (editor.reconnectConfigured || editor.reconnectEnabled || editor.reconnectInitialDelayMs || editor.reconnectMaxDelayMs || editor.reconnectMaxAttempts) {
				config.reconnect = { enabled: editor.reconnectEnabled === true };
				for (const [field, target] of [["reconnectInitialDelayMs", "initialDelayMs"], ["reconnectMaxDelayMs", "maxDelayMs"], ["reconnectMaxAttempts", "maxAttempts"]]) {
					const value = mcpPositiveNumber(editor[field], field, target === "maxAttempts");
					if (value !== undefined) config.reconnect[target] = value;
				}
			}
			const secretRefs = {}, secretValues = {};
			if (editor.transport === "stdio") {
				config.command = String(editor.command ?? "").trim();
				config.args = mcpParseArgs(editor.argsText);
				if (String(editor.cwd ?? "").length > 0) config.cwd = editor.cwd;
				secretRefs.env = {}; secretValues.env = {};
				mcpApplySecretRows(editor.envRows, "env", secretRefs, secretValues);
				secretRefs.args = {}; secretValues.args = {};
				mcpApplySecretRows(editor.secretArgRows, "args", secretRefs, secretValues);
			} else {
				secretRefs.headers = {}; secretValues.headers = {};
				mcpApplySecretRows(editor.headerRows, "headers", secretRefs, secretValues);
				if (editor.urlAction === "remove") secretValues.url = { action: "remove" };
				else if (editor.urlAction === "replace" || editor.mode === "add") {
					if (editor.urlMode === "ref") secretRefs.url = { ref: String(editor.urlRef ?? "").trim(), ...(editor.urlPrefix ? { prefix: editor.urlPrefix } : {}) };
					else if (mcpSensitiveUrl(editor.url)) secretValues.url = { action: "replace", value: editor.url };
					else config.url = String(editor.url ?? "").trim();
				}
			}
			for (const kind of ["env", "headers", "args"]) {
				if (secretRefs[kind] && Object.keys(secretRefs[kind]).length === 0) delete secretRefs[kind];
				if (secretValues[kind] && Object.keys(secretValues[kind]).length === 0) delete secretValues[kind];
			}
			if (Object.keys(secretRefs).length > 0) config.secretRefs = secretRefs;
			if (Object.values(secretValues).some((value) => Object.keys(value).length > 0) || secretValues.url) config.secretValues = secretValues;
			return config;
		}

		function mcpEditorHasSecrets(editor) {
			const rows = [...(editor.envRows ?? []), ...(editor.headerRows ?? []), ...(editor.secretArgRows ?? [])];
			if (rows.some((row) => row.configured || row.action === "remove" || (row.action !== "keep" && (row.source === "ref" || String(row.value ?? "").length > 0)))) return true;
			return editor.urlMode === "ref" || editor.urlMode === "legacy" || mcpSensitiveUrl(editor.url);
		}

		function mcpEditorErrorsOf(editor) {
			const errors = {};
			const identity = String(editor.identity ?? "").trim();
			if (!identity) errors.identity = "required";
			else if (!SEGMENT.test(identity)) errors.identity = "invalid";
			const serverName = String(editor.serverName ?? "").trim() || identity;
			if (!MCP_SERVER_NAME.test(serverName)) errors.serverName = "invalid";
			try { mcpPositiveNumber(editor.toolCallTimeoutMs, "toolCallTimeoutMs"); } catch { errors.toolCallTimeoutMs = "invalid"; }
			try { mcpPositiveNumber(editor.maxInstructionBytes, "maxInstructionBytes", true); } catch { errors.maxInstructionBytes = "invalid"; }
			try {
				const initial = mcpPositiveNumber(editor.reconnectInitialDelayMs, "reconnectInitialDelayMs");
				const max = mcpPositiveNumber(editor.reconnectMaxDelayMs, "reconnectMaxDelayMs");
				mcpPositiveNumber(editor.reconnectMaxAttempts, "reconnectMaxAttempts", true);
				if ((initial ?? 500) > (max ?? 30000)) errors.reconnect = "invalid";
			} catch { errors.reconnect = "invalid"; }
			let argumentCount = null;
			if (editor.transport === "stdio") {
				if (!String(editor.command ?? "").trim()) errors.command = "required";
				try { argumentCount = mcpParseArgs(editor.argsText).length; } catch { errors.args = "invalid"; }
			} else if (editor.urlAction === "remove") errors.url = "required";
			else if (editor.urlAction === "replace" || editor.mode === "add") {
				if (editor.urlMode === "ref" && !MCP_CREDENTIAL_REF.test(String(editor.urlRef ?? "").trim())) errors.url = "invalid";
				if (editor.urlMode !== "ref" && !String(editor.url ?? "").trim()) errors.url = "required";
			}
			for (const [field, rows] of [["env", editor.envRows], ["headers", editor.headerRows], ["args", editor.secretArgRows]]) {
				if ((rows ?? []).length > 64 && field !== "args") errors[field] = "too-many";
				const seen = new Set();
				for (const [index, row] of (rows ?? []).entries()) {
					const key = String(field === "args" ? row.index : row.key ?? "").trim();
					if (!key && !row.value && !row.ref) continue;
					if (!key && (row.action !== "keep" || row.value || row.ref)) errors[`${field}.${index}`] = "required";
					if (seen.has(key)) errors[`${field}.${index}`] = "duplicate";
					seen.add(key);
					if (row.action !== "keep" && row.action !== "remove" && row.source === "ref" && !MCP_CREDENTIAL_REF.test(String(row.ref ?? "").trim())) errors[`${field}.${index}`] = "invalid-ref";
					if (field === "args" && (!Number.isInteger(Number(key)) || Number(key) < 0 || Number(key) >= (argumentCount ?? 0))) errors[`${field}.${index}`] = "invalid-index";
				}
			}
			return errors;
		}

		function mcpPreviewSupportOf(preview, secretBearing) {
			if (!secretBearing) return [];
			const unsupported = [];
			if (preview?.capabilities?.credentials === false) unsupported.push("credentials-unavailable");
			if (preview?.capabilities?.ephemeral === false) unsupported.push("ephemeral-loader-unavailable");
			return unsupported;
		}

		function mcpPreviewHasSecrets(preview) {
			return (preview?.plan ?? []).some((item) => {
				const entry = item?.entry ?? {};
				if (Object.keys(entry.secretRefs ?? {}).length > 0 || entry.transport?.ref === "http:credential-ref") return true;
				if (Object.keys(entry.client?.env ?? {}).length > 0 || Object.keys(entry.client?.headers ?? {}).length > 0) return true;
				return entry.client?.url === "[redacted-url]" || mcpSensitiveUrl(entry.client?.url);
			});
		}

		function mcpDocumentHasSecrets(text) {
			const guarded = mcpJsonGuard(text);
			if (!guarded.ok) return false;
			const servers = guarded.value.mcpServers ? Object.values(guarded.value.mcpServers) : [guarded.value];
			return servers.some((server) => {
				if (Object.keys(server?.secretRefs ?? {}).length > 0 || Object.keys(server?.secretValues ?? {}).length > 0) return true;
				const client = server?.client ?? server;
				if (Object.keys(client?.env ?? {}).length > 0 || Object.keys(client?.headers ?? {}).length > 0 || Object.keys(client?.secretArgs ?? {}).length > 0) return true;
				if ((client?.args ?? []).some((value) => value && typeof value === "object" && typeof value.ref === "string")) return true;
				return (client?.url && typeof client.url === "object" && typeof client.url.ref === "string") || mcpSensitiveUrl(client?.url);
			});
		}

		function mcpUtf8Bytes(text) {
			let bytes = 0;
			const value = String(text ?? "");
			for (let index = 0; index < value.length; index += 1) {
				const code = value.charCodeAt(index);
				if (code < 0x80) bytes += 1;
				else if (code < 0x800) bytes += 2;
				else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
				else bytes += 3;
			}
			return bytes;
		}

		function mcpJsonGuard(text) {
			if (mcpUtf8Bytes(text) > MCP_DOCUMENT_LIMIT) return { ok: false, code: "document-too-large" };
			try {
				const value = JSON.parse(text);
				if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "invalid-document" };
				return { ok: true, value };
			} catch { return { ok: false, code: "invalid-json" }; }
		}

		function mcpDocumentEntryOf(text, identity) {
			const guarded = mcpJsonGuard(text);
			if (!guarded.ok) return null;
			if (guarded.value.mcpServers) {
				const entry = guarded.value.mcpServers[identity];
				return entry && typeof entry === "object" && !Array.isArray(entry) ? { ...entry, identity: entry.identity ?? identity } : null;
			}
			const entry = guarded.value;
			return (entry.identity ?? identity) === identity ? { ...entry, identity: entry.identity ?? identity } : null;
		}

		function mcpBatchItemsOf(response) {
			return (response?.items ?? []).map((item) => ({
				...item, succeeded: item.status === "mounted", failed: item.status !== "mounted",
				notAttempted: item.status === "not-attempted", saved: item.saved === true,
			}));
		}

		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under "settings.weir.capability"
		// inside a ctx.effect when this chunk arrives (lib/client.js
		// registerChunkDictionaries). Pinned by test/client.test.js's dictionary
		// union pin.
		const dictionaries = {
			en: {
				"capability.badge": "{skills} skills · {mcp} MCP",
				"capability.unavailable.short": "Capabilities n/a",
				"capability.effectiveUnknown": "Applied count unknown — refresh and check Skill sources",
				"capability.effectiveUnknownShort": "Skills ? · MCP ?",
				"capability.effectiveUnknownDetail": "Accepted revision; effective capabilities cannot be verified. Refresh and check Skill sources. Draft kept; only Apply changes the session.",
				"capability.unknownOverwriteRisk": "Previous selection is unknown. Applying this draft may replace other accepted Skills and MCP servers. Review the full selection before confirming.",
				"capability.confirmUnknownOverwrite": "Confirm replacing unknown selection",
				"capability.error": "Capabilities unavailable for this session.",
				"capability.unavailable": "Capabilities are unavailable in this session.",
				"capability.unsupported": "Unsupported: consistency conditions are not met on this host.",
				"capability.tab.skills": "Skills",
				"capability.tab.mcp": "MCP",
				"capability.tab.presets": "Presets",
				"capability.search": "Search",
				"capability.close": "Close",
				"capability.conflict": "conflict",
				"capability.sourceUnknown": "unknown source",
				"capability.sourceNumber": " · source ",
				"capability.sameNameWarning": "{name}: only one source can be enabled in this session. Uncheck one: {sources}.",
				"capability.unresolvedNameWarning": "{name}: legacy name has no chosen source. Choose an exact source or remove the name: {sources}.",
				"capability.unknownLegacyName": "{name}: no matching Skill in the current listing. Refresh the listing or remove this legacy name.",
				"capability.inventoryUnavailableName": "The listing is unavailable; legacy names remain unresolved in the draft. Retry later; no source was selected.",
				"capability.unresolvedNameTitle": "Choose a source for legacy name {name}",
				"capability.replaceName": "Replace {name} with {source}",
				"capability.removeName": "Remove legacy name {name}",
				"capability.serverSameName": "Server rejected same-name Skill {names}. Uncheck one source, or refresh the listing; draft kept.",
				"capability.serverMissing": "Server could not resolve {names}. Refresh the listing and choose an exact source or remove the name; draft kept.",
				"capability.unknownName": "unknown name",
				"capability.missing": "missing",
				"capability.noSkills": "No skills match.",
				"capability.mcp.groupManaged": "Weir managed",
				"capability.mcp.groupUnmanaged": "Unmanaged",
				"capability.mcp.none": "No MCP servers configured.",
				"capability.mcp.unmanagedHint": "Configured outside Weir; the selection cannot govern it.",
				"capability.mcp.stateMounted": "mounted",
				"capability.mcp.stateRegistered": "registered",
				"capability.unmanaged": "unmanaged",
				"capability.mcp.add": "+ Add managed MCP server",
				"capability.mcp.identity": "identity (e.g. my-docs)",
				"capability.mcp.label": "label (display name, optional)",
				"capability.mcp.command": "command (e.g. npx)",
				"capability.mcp.args": "args, space-separated (optional)",
				"capability.mcp.adding": "Adding…",
				"capability.mcp.addConfirm": "Add",
				"capability.mcp.cancel": "Cancel",
				"capability.mcp.errorRequired": "Required.",
				"capability.mcp.errorIdentityInvalid": "Letters, digits, \"-\" and \"_\" only; start with a letter or digit.",
				"capability.mcp.boundary": "MCP management could not be rendered. Other capability controls remain available.",
				"capability.mcp.unavailableView": "MCP management is unavailable on this client.",
				"capability.mcp.unavailableRegistry": "MCP registry unavailable: {status}. Last-good rows, when present, are stale.",
				"capability.mcp.stale": "stale — last good inventory",
				"capability.mcp.refresh": "Refresh",
				"capability.mcp.pasteJson": "Paste JSON",
				"capability.mcp.secretArgIndex": "argument index",
				"capability.mcp.secretKey": "secret key",
				"capability.mcp.secretAction": "secret action",
				"capability.mcp.keep": "keep",
				"capability.mcp.replace": "replace",
				"capability.mcp.removeSecret": "remove",
				"capability.mcp.secretSource": "secret source",
				"capability.mcp.secretValueSource": "new value",
				"capability.mcp.secretRefSource": "credential ref",
				"capability.mcp.removeRow": "Remove row",
				"capability.mcp.ref": "credential reference",
				"capability.mcp.secretBlankKeep": "blank keeps the configured secret",
				"capability.mcp.secretValue": "secret value",
				"capability.mcp.prefix": "optional non-secret prefix",
				"capability.mcp.addSecret": "+ Add secret/reference",
				"capability.mcp.saved": "saved",
				"capability.mcp.notAttempted": "not attempted",
				"capability.mcp.defaultRemoved": "default removed",
				"capability.mcp.discovery": "Discovery: {count} tool(s)",
				"capability.mcp.nonAtomic": "Batch results are per server; no atomic rollback is claimed.",
				"capability.mcp.planDigest": "Plan digest: {digest}",
				"capability.mcp.editTitle": "Edit MCP server",
				"capability.mcp.transport": "transport",
				"capability.mcp.basic": "Basic",
				"capability.mcp.advanced": "Advanced",
				"capability.mcp.serverName": "public server name",
				"capability.mcp.argsJson": "args (JSON array or space-separated)",
				"capability.mcp.cwd": "working directory (optional)",
				"capability.mcp.sensitiveConfigured": "Sensitive URL configured; its value is hidden.",
				"capability.mcp.urlMode": "URL source",
				"capability.mcp.urlLiteral": "URL",
				"capability.mcp.urlRef": "URL credential reference",
				"capability.mcp.url": "MCP URL",
				"capability.mcp.namespacePending": "The public namespace changes; separate confirmation is required.",
				"capability.mcp.preview": "Preview",
				"capability.mcp.confirm": "Confirm",
				"capability.mcp.test": "Test",
				"capability.mcp.pasteTitle": "Paste MCP JSON (single or mcpServers batch)",
				"capability.mcp.pasteLabel": "MCP JSON document",
				"capability.mcp.tooLarge": "JSON exceeds the 1 MiB limit; no preview or write occurred.",
				"capability.mcp.confirmBatch": "Confirm batch",
				"capability.mcp.retryEdit": "Retry / edit",
				"capability.mcp.selectSession": "Select {identity} for this session",
				"capability.mcp.default": "default",
				"capability.mcp.selected": "selected",
				"capability.mcp.toolsUnknown": "Tools: unknown",
				"capability.mcp.toolsCount": "Tools: {count}",
				"capability.mcp.liveUnknown": "Live reconnect/process/stderr: unknown",
				"capability.mcp.lastMount": "Last mount: {status} / generation {generation}",
				"capability.mcp.lastTest": "Last test: {status}",
				"capability.mcp.edit": "Edit",
				"capability.mcp.restart": "Restart",
				"capability.mcp.defaultOff": "Disable default",
				"capability.mcp.defaultOn": "Enable default",
				"capability.mcp.remove": "Remove",
				"capability.mcp.pending": "Pending…",
				"capability.mcp.removeTitle": "Remove MCP server?",
				"capability.mcp.namespaceTitle": "Change public namespace?",
				"capability.mcp.batchTitle": "Install this MCP batch?",
				"capability.mcp.removeConfirm": "Remove {identity}, close admission, await disposal, and remove its new-session default. Draft and accepted session selections are not rewritten.",
				"capability.mcp.namespaceConfirm": "Change public serverName from {from} to {to}? Existing tool names and calls change after the strict replacement is ready.",
				"capability.mcp.batchConfirm": "Probe and install {count} server(s) independently using digest {digest}. Results may be partial; there is no atomic rollback.",
				"capability.mcp.removeConfirmButton": "Remove server",
				"capability.mcp.credentials-unavailable": "Credentials are unavailable; secret-bearing MCP work is disabled. Use a secret-free configuration or enable DSH credentials.",
				"capability.mcp.ephemeral-loader-unavailable": "Safe ephemeral mounting is unavailable; secret-bearing MCP work is disabled.",
				"capability.diff.addSkills": "+{n} skills",
				"capability.diff.removeSkills": "−{n} skills",
				"capability.diff.addMcp": "+{n} MCP",
				"capability.diff.removeMcp": "−{n} MCP",
				"capability.apply": "Apply",
				"capability.applying": "Applying…",
				"capability.discard": "Discard",
				"capability.applied": "Applied",
				"capability.acceptedUnknown": "Accepted · effective count unknown",
				"capability.appliedSkipped": "skipped {n} (not applicable here)",
				"capability.failed": "Failed — draft kept",
				"capability.conflictState": "Changed elsewhere — review current state",
				"capability.missingAction": "Missing items need install/configure",
				"capability.pending": "Result pending — query the receipt",
				"capability.presets.unavailable": "Presets are unavailable on this host.",
				"capability.presets.errorName": "Enter a name.",
				"capability.presets.saved": "Preset saved.",
				"capability.presets.replaced": "Replaced the confirmed preset under ID {id}; no second preset was created.",
				"capability.presets.renameRow": "Rename preset…",
				"capability.presets.resaveRow": "Re-save…",
				"capability.presets.newName": "New preset name",
				"capability.presets.renameSubmit": "Save new name",
				"capability.presets.resaveSubmit": "Confirm re-save",
				"capability.presets.editTarget": "Target: {name} · {scope} · ID {id} · revision {revision}",
				"capability.presets.resaveConfirm": "Overwrite this preset from {source}: {skills} Skills · {mcp} MCP · {unresolved} unresolved. Current session stays unchanged.",
				"capability.presets.renamed": "Preset renamed; current draft and applied selection unchanged.",
				"capability.presets.resaved": "Preset re-saved; current draft and applied selection unchanged.",
				"capability.presets.renameCollision": "That name belongs to another preset. Choose another name.",
				"capability.presets.editConflict": "The preset changed. Review the refreshed row and confirm again.",
				"capability.presets.sourceChanged": "The applied selection changed. Refresh the session receipt and confirm again.",
				"capability.presets.sourceUnavailable": "Applied source unavailable{missing}. Restore the missing Skills, refresh the receipt, and confirm again.",
				"capability.presets.appliedUnavailable": "The applied source has unavailable entries. Restore them and refresh the session receipt before re-saving.",
				"capability.presets.appliedReceiptMissing": "The applied source cannot be verified from this receipt. Refresh the session receipt before re-saving; the current draft is still available.",
				"capability.presets.locked": "Preset storage is busy. Wait, then refresh and decide again.",
				"capability.presets.unreadable": "Preset storage cannot be read safely. Check the storage before retrying.",
				"capability.presets.unsupported": "This preset version is unsupported. Update the client or host before editing.",
				"capability.presets.gone": "This preset was deleted or is missing. Refresh the list; it was not recreated.",
				"capability.presets.confirmAgain": "The replacement target changed. Refresh and confirm its identity again.",
				"capability.presets.uncertain": "Result unknown. Refresh and inspect the preset before deciding whether to retry.",
				"capability.presets.missingSelection": "The draft selection is incomplete. Refresh before saving.",
				"capability.presets.replaceTarget": "Replace preset ID {id} at revision {revision} in {scope}?",
				"capability.presets.noneKnown": "none reported",
				"capability.presets.importPartial": "Installed Skills: {names}. Preset status is unconfirmed. Inspect the installed files and refresh the preset before deciding how to recover.",
				"capability.presets.currentRevision": " Current stored revision: {revision}.",
				"capability.presets.revisionConflict": "Changed elsewhere — the list was refreshed.",
				"capability.presets.noWorkspace": "This session has no workspace.",
				"capability.presets.saveFailed": "The preset could not be saved.",
				"capability.presets.loaded": "Staged into the draft — Apply to activate.",
				"capability.presets.loadedUnresolved": "Staged into the draft — {n} unresolved ref(s) reported.",
				"capability.presets.loadFailed": "Load failed — the preset may be gone.",
				"capability.presets.deleted": "Preset deleted.",
				"capability.presets.deleteFailed": "Delete failed.",
				"capability.presets.exportFailed": "Export failed.",
				"capability.presets.imported": "Imported: {bound} MCP binding(s), {unresolved} unresolved ref(s).",
				"capability.presets.counts": "{skills} skills · {mcp} MCP",
				"capability.presets.countsUnresolved": " · {n} unresolved",
				"capability.presets.loading": "Loading…",
				"capability.presets.load": "Load",
				"capability.presets.export": "Export",
				"capability.presets.delete": "Delete",
				"capability.presets.deleteConfirm": "Delete preset \"{name}\"? This cannot be undone.",
				"capability.presets.deleteConfirmButton": "Delete preset",
				"capability.presets.deleting": "Deleting…",
				"capability.presets.cancel": "Cancel",
				"capability.presets.exportLabel": "Preset JSON",
				"capability.presets.copy": "Copy to clipboard",
				"capability.presets.copied": "Copied",
				"capability.presets.close": "Close",
				"capability.presets.saveOpen": "Save as preset…",
				"capability.presets.importOpen": "Import…",
				"capability.presets.name": "Preset name",
				"capability.presets.namespace": "Namespace",
				"capability.presets.scopeWorkspace": "workspace",
				"capability.presets.scopeGlobal": "global",
				"capability.presets.source": "From",
				"capability.presets.fromDraft": "current draft",
				"capability.presets.fromApplied": "applied selection",
				"capability.presets.nameConflict": "A preset named \"{name}\" already exists in this namespace.",
				"capability.presets.rename": "Rename…",
				"capability.presets.renameHint": "Edit the name, then save again.",
				"capability.presets.replace": "Replace it",
				"capability.presets.saving": "Saving…",
				"capability.presets.save": "Save preset",
				"capability.presets.importPlaceholder": "Paste a portable preset document (JSON)…",
				"capability.presets.importing": "Importing…",
				"capability.presets.importSubmit": "Import",
				"capability.presets.importInvalidJson": "Not valid JSON — nothing was written.",
				"capability.presets.importRejected": "Rejected: {reason} — nothing was written.",
				"capability.presets.importNameConflict": "A preset with this name already exists here.",
				"capability.presets.importFailed": "Import failed — nothing was written.",
				"capability.presets.groupWorkspace": "Workspace presets",
				"capability.presets.groupWorkspaceNone": "Workspace presets (no workspace)",
				"capability.presets.groupGlobal": "Global presets",
				"capability.presets.emptyWorkspace": "No workspace presets yet.",
				"capability.presets.emptyGlobal": "No global presets yet.",
				"capability.presets.defaultTitle": "Workspace default for new sessions",
				"capability.presets.defaultUnavailable": "The workspace default is unavailable.",
				"capability.presets.defaultNone": "No default is set — new sessions use the builtin baseline.",
				"capability.presets.defaultEmpty": "An explicit empty default is set: new sessions start with 0 skills · 0 MCP.",
				"capability.presets.defaultEntries": "Default: {counts}",
				"capability.presets.defaultUnresolved": "…with {n} unresolved ref(s) reported on resolve.",
				"capability.presets.defaultSaveOpen": "Save as default…",
				"capability.presets.defaultClearOpen": "Clear default…",
				"capability.presets.defaultSaveConfirm": "Save {counts} as this workspace's default? New sessions in this workspace will start from it; the current session does not change.",
				"capability.presets.defaultSaveConfirmButton": "Save default",
				"capability.presets.defaultSaved": "Workspace default saved.",
				"capability.presets.defaultSaveFailed": "The default could not be saved.",
				"capability.presets.defaultClearConfirm": "Clear the workspace default? New sessions return to the builtin baseline; open sessions do not change.",
				"capability.presets.defaultClearConfirmButton": "Clear default",
				"capability.presets.defaultCleared": "Workspace default cleared — new sessions use the builtin baseline.",
				"capability.presets.defaultClearFailed": "The default could not be cleared.",
				"capability.presets.clearing": "Clearing…",
				"capability.presets.needsReceipt": "Unavailable until the session receipt loads.",
				"capability.presets.exportDownload": "Download .json",
				"capability.presets.downloaded": "Downloaded",
				"capability.presets.importedPackage": "Imported: {installed} Skill(s) installed, {bound} MCP binding(s), {unresolved} unresolved ref(s).",
				"capability.presets.importSummaryTitle": "Import summary — review before anything is written",
				"capability.presets.importFiles": "{n} file(s)",
				"capability.presets.importNoInstalls": "This package bundles no Skills to install.",
				"capability.presets.importUnresolvedTitle": "Unresolved refs — not installed:",
				"capability.presets.importCollision": "name collision",
				"capability.presets.importCollisionDecision": "When a bundled Skill name already exists:",
				"capability.presets.collisionCancel": "skip it (default)",
				"capability.presets.collisionReplace": "replace it",
				"capability.presets.collisionCoexist": "keep both, renamed",
				"capability.presets.importConfirm": "Confirm import",
				"capability.presets.importResultTitle": "Import result",
				"capability.presets.importInstalledNote": "Installed Skills stay unselected — pick them in the draft and Apply to activate.",
				"capability.presets.importInstallFailed": "Installation failed: {reason} — rolled back {n} file(s); no preset was created.",
				"capability.presets.importNoTargetRoot": "No {scope} Skill root is available on this host — nothing was installed.",
				"capability.presets.scopeProject": "project",
				"capability.presets.scopeUser": "user",
				"capability.loading": "Loading capabilities…",
				unavailable: "This plugin is not loaded, so it cannot be configured right now.",
				save: "Save",
			},
			zh: {
				"capability.badge": "{skills} 个技能 · {mcp} 个 MCP",
				"capability.unavailable.short": "能力不可用",
				"capability.effectiveUnknown": "已应用数量未知——请刷新并检查技能来源",
				"capability.effectiveUnknownShort": "技能 ? · MCP ?",
				"capability.effectiveUnknownDetail": "修订已接受，但有效能力暂无法核实。请刷新并检查技能来源。草稿已保留；只有手动应用才会更改会话。",
				"capability.unknownOverwriteRisk": "原有选择未知。应用此草稿可能覆盖其他已接受的技能与 MCP server。确认前请核对完整选择。",
				"capability.confirmUnknownOverwrite": "确认替换未知选择",
				"capability.error": "此会话的能力不可用。",
				"capability.unavailable": "能力在此会话中不可用。",
				"capability.unsupported": "不支持：此宿主未满足一致性条件。",
				"capability.tab.skills": "技能",
				"capability.tab.mcp": "MCP",
				"capability.tab.presets": "预设",
				"capability.search": "搜索",
				"capability.close": "关闭",
				"capability.conflict": "冲突",
				"capability.sourceUnknown": "未知来源",
				"capability.sourceNumber": " · 候选 ",
				"capability.sameNameWarning": "{name}：本会话只能启用一个来源。请取消其中一项：{sources}。",
				"capability.unresolvedNameWarning": "{name}：旧名称尚未选定来源。请选择精确来源或移除该名称：{sources}。",
				"capability.unknownLegacyName": "{name}：当前清单中没有匹配的技能。请刷新清单或移除这个旧名称。",
				"capability.inventoryUnavailableName": "清单暂不可读；旧名称在草稿中保持未解析。请稍后重试；未选择任何来源。",
				"capability.unresolvedNameTitle": "为旧名称 {name} 选择来源",
				"capability.replaceName": "将 {name} 替换为 {source}",
				"capability.removeName": "移除旧名称 {name}",
				"capability.serverSameName": "服务端拒绝同名技能 {names}。请取消一个来源或刷新清单；草稿已保留。",
				"capability.serverMissing": "服务端无法解析 {names}。请刷新清单并选择精确来源或移除该名称；草稿已保留。",
				"capability.unknownName": "未知名称",
				"capability.missing": "缺失",
				"capability.noSkills": "没有匹配的技能。",
				"capability.mcp.groupManaged": "Weir 管理",
				"capability.mcp.groupUnmanaged": "未纳入管理",
				"capability.mcp.none": "未配置 MCP server。",
				"capability.mcp.unmanagedHint": "在 Weir 之外配置，会话选择无法管理它。",
				"capability.mcp.stateMounted": "已挂载",
				"capability.mcp.stateRegistered": "已注册",
				"capability.unmanaged": "未管理",
				"capability.mcp.add": "+ 添加受管 MCP server",
				"capability.mcp.identity": "identity（如 my-docs）",
				"capability.mcp.label": "标签（显示名，可选）",
				"capability.mcp.command": "命令（如 npx）",
				"capability.mcp.args": "参数，空格分隔（可选）",
				"capability.mcp.adding": "正在添加…",
				"capability.mcp.addConfirm": "添加",
				"capability.mcp.cancel": "取消",
				"capability.mcp.errorRequired": "必填。",
				"capability.mcp.errorIdentityInvalid": "仅限字母、数字、\"-\"、\"_\"，且以字母或数字开头。",
				"capability.mcp.boundary": "MCP 管理界面渲染失败；其他能力控件仍可使用。",
				"capability.mcp.unavailableView": "此客户端无法使用 MCP 管理。",
				"capability.mcp.unavailableRegistry": "MCP 注册表不可用：{status}。如有上次成功清单，现已标记为过期。",
				"capability.mcp.stale": "已过期——上次成功清单",
				"capability.mcp.refresh": "刷新",
				"capability.mcp.pasteJson": "粘贴 JSON",
				"capability.mcp.secretArgIndex": "参数索引",
				"capability.mcp.secretKey": "秘密键名",
				"capability.mcp.secretAction": "秘密操作",
				"capability.mcp.keep": "保留",
				"capability.mcp.replace": "替换",
				"capability.mcp.removeSecret": "移除",
				"capability.mcp.secretSource": "秘密来源",
				"capability.mcp.secretValueSource": "新值",
				"capability.mcp.secretRefSource": "凭据引用",
				"capability.mcp.removeRow": "移除此行",
				"capability.mcp.ref": "凭据引用",
				"capability.mcp.secretBlankKeep": "留空则保留已配置的秘密",
				"capability.mcp.secretValue": "秘密值",
				"capability.mcp.prefix": "可选非秘密前缀",
				"capability.mcp.addSecret": "+ 添加秘密/引用",
				"capability.mcp.saved": "已保存",
				"capability.mcp.notAttempted": "未尝试",
				"capability.mcp.defaultRemoved": "默认值已移除",
				"capability.mcp.discovery": "发现：{count} 个工具",
				"capability.mcp.nonAtomic": "批量结果按 server 分别报告；不承诺原子回滚。",
				"capability.mcp.planDigest": "计划摘要：{digest}",
				"capability.mcp.editTitle": "编辑 MCP server",
				"capability.mcp.transport": "传输方式",
				"capability.mcp.basic": "基本",
				"capability.mcp.advanced": "高级",
				"capability.mcp.serverName": "公开 server 名称",
				"capability.mcp.argsJson": "参数（JSON 数组或空格分隔）",
				"capability.mcp.cwd": "工作目录（可选）",
				"capability.mcp.sensitiveConfigured": "已配置敏感 URL；其值保持隐藏。",
				"capability.mcp.urlMode": "URL 来源",
				"capability.mcp.urlLiteral": "URL",
				"capability.mcp.urlRef": "URL 凭据引用",
				"capability.mcp.url": "MCP URL",
				"capability.mcp.namespacePending": "公开命名空间将改变；需要单独确认。",
				"capability.mcp.preview": "预览",
				"capability.mcp.confirm": "确认",
				"capability.mcp.test": "测试",
				"capability.mcp.pasteTitle": "粘贴 MCP JSON（单个或 mcpServers 批量）",
				"capability.mcp.pasteLabel": "MCP JSON 文档",
				"capability.mcp.tooLarge": "JSON 超过 1 MiB 上限；未预览或写入。",
				"capability.mcp.confirmBatch": "确认批量安装",
				"capability.mcp.retryEdit": "重试 / 编辑",
				"capability.mcp.selectSession": "为本会话选择 {identity}",
				"capability.mcp.default": "默认",
				"capability.mcp.selected": "已选择",
				"capability.mcp.toolsUnknown": "工具数：未知",
				"capability.mcp.toolsCount": "工具数：{count}",
				"capability.mcp.liveUnknown": "实时重连/进程/stderr：未知",
				"capability.mcp.lastMount": "上次挂载：{status} / generation {generation}",
				"capability.mcp.lastTest": "上次测试：{status}",
				"capability.mcp.edit": "编辑",
				"capability.mcp.restart": "重启",
				"capability.mcp.defaultOff": "取消默认",
				"capability.mcp.defaultOn": "设为默认",
				"capability.mcp.remove": "移除",
				"capability.mcp.pending": "处理中…",
				"capability.mcp.removeTitle": "移除 MCP server？",
				"capability.mcp.namespaceTitle": "更改公开命名空间？",
				"capability.mcp.batchTitle": "安装此 MCP 批次？",
				"capability.mcp.removeConfirm": "移除 {identity}，关闭准入并等待清理，同时移除其新会话默认值。草稿和已接受的会话选择不会被改写。",
				"capability.mcp.namespaceConfirm": "将公开 serverName 从 {from} 改为 {to}？严格替换就绪后，现有工具名与调用将使用新命名空间。",
				"capability.mcp.batchConfirm": "使用摘要 {digest} 逐项探测并安装 {count} 个 server。结果可能部分成功；不进行原子回滚。",
				"capability.mcp.removeConfirmButton": "移除 server",
				"capability.mcp.credentials-unavailable": "凭据服务不可用；已禁用含秘密的 MCP 操作。请使用无秘密配置或启用 DSH credentials。",
				"capability.mcp.ephemeral-loader-unavailable": "安全临时挂载不可用；已禁用含秘密的 MCP 操作。",
				"capability.diff.addSkills": "+{n} 个技能",
				"capability.diff.removeSkills": "−{n} 个技能",
				"capability.diff.addMcp": "+{n} 个 MCP",
				"capability.diff.removeMcp": "−{n} 个 MCP",
				"capability.apply": "应用",
				"capability.applying": "正在应用…",
				"capability.discard": "放弃",
				"capability.applied": "已应用",
				"capability.acceptedUnknown": "已接受 · 有效数量未知",
				"capability.appliedSkipped": "已跳过 {n} 项（当前预设不适用）",
				"capability.failed": "失败——草稿已保留",
				"capability.conflictState": "已在别处变更——请核对当前状态",
				"capability.missingAction": "缺失项需要安装/配置",
				"capability.pending": "结果待确认——请查询回执",
				"capability.presets.unavailable": "预设在此宿主上不可用。",
				"capability.presets.errorName": "请输入名称。",
				"capability.presets.saved": "预设已保存。",
				"capability.presets.replaced": "已替换确认的预设 ID {id}；未新建第二个预设。",
				"capability.presets.renameRow": "重命名预设…",
				"capability.presets.resaveRow": "重新保存…",
				"capability.presets.newName": "新预设名称",
				"capability.presets.renameSubmit": "保存新名称",
				"capability.presets.resaveSubmit": "确认重新保存",
				"capability.presets.editTarget": "目标：{name} · {scope} · ID {id} · 修订 {revision}",
				"capability.presets.resaveConfirm": "从{source}覆盖此预设：{skills} 个技能 · {mcp} 个 MCP · {unresolved} 个未解析引用。当前会话不变。",
				"capability.presets.renamed": "预设已改名；当前草稿和已应用选择不变。",
				"capability.presets.resaved": "预设已重新保存；当前草稿和已应用选择不变。",
				"capability.presets.renameCollision": "此名称已属于另一预设，请另选名称。",
				"capability.presets.editConflict": "预设已更改；请检查刷新后的行并重新确认。",
				"capability.presets.sourceChanged": "已应用选择已改变；请刷新会话回执后重新确认。",
				"capability.presets.sourceUnavailable": "已应用来源不可用{missing}。请恢复缺失技能、刷新回执后重新确认。",
				"capability.presets.appliedUnavailable": "已应用来源有不可用项目。请恢复项目并刷新会话回执后重新保存。",
				"capability.presets.appliedReceiptMissing": "当前回执无法验证已应用来源。请刷新会话回执后重新保存；当前草稿仍可使用。",
				"capability.presets.locked": "预设存储正忙；请稍后刷新并重新决定。",
				"capability.presets.unreadable": "无法安全读取预设存储；重试前请检查存储。",
				"capability.presets.unsupported": "不支持此预设版本；编辑前请更新客户端或宿主。",
				"capability.presets.gone": "预设已删除或不存在；请刷新列表，它未被重建。",
				"capability.presets.confirmAgain": "替换目标已改变；请刷新并重新确认身份。",
				"capability.presets.uncertain": "结果未知；请刷新并检查预设，再决定是否重试。",
				"capability.presets.missingSelection": "草稿选择不完整；请刷新后再保存。",
				"capability.presets.replaceTarget": "确认替换 {scope} 范围内 ID {id}、修订 {revision} 的预设？",
				"capability.presets.noneKnown": "无已报告项",
				"capability.presets.importPartial": "已安装的技能：{names}。预设状态尚未确认。请检查已安装文件并刷新预设，再决定如何恢复。",
				"capability.presets.currentRevision": " 当前存储修订：{revision}。",
				"capability.presets.revisionConflict": "已在别处变更——列表已刷新。",
				"capability.presets.noWorkspace": "此会话没有工作区。",
				"capability.presets.saveFailed": "预设保存失败。",
				"capability.presets.loaded": "已装入草稿——应用后生效。",
				"capability.presets.loadedUnresolved": "已装入草稿——报告 {n} 个未解析引用。",
				"capability.presets.loadFailed": "载入失败——预设可能已不存在。",
				"capability.presets.deleted": "预设已删除。",
				"capability.presets.deleteFailed": "删除失败。",
				"capability.presets.exportFailed": "导出失败。",
				"capability.presets.imported": "已导入：{bound} 个 MCP 绑定，{unresolved} 个未解析引用。",
				"capability.presets.counts": "{skills} 个技能 · {mcp} 个 MCP",
				"capability.presets.countsUnresolved": " · {n} 个未解析",
				"capability.presets.loading": "正在载入…",
				"capability.presets.load": "载入",
				"capability.presets.export": "导出",
				"capability.presets.delete": "删除",
				"capability.presets.deleteConfirm": "删除预设“{name}”？此操作不可撤销。",
				"capability.presets.deleteConfirmButton": "删除预设",
				"capability.presets.deleting": "正在删除…",
				"capability.presets.cancel": "取消",
				"capability.presets.exportLabel": "预设 JSON",
				"capability.presets.copy": "复制到剪贴板",
				"capability.presets.copied": "已复制",
				"capability.presets.close": "关闭",
				"capability.presets.saveOpen": "存为预设…",
				"capability.presets.importOpen": "导入…",
				"capability.presets.name": "预设名称",
				"capability.presets.namespace": "命名空间",
				"capability.presets.scopeWorkspace": "工作区",
				"capability.presets.scopeGlobal": "全局",
				"capability.presets.source": "来源",
				"capability.presets.fromDraft": "当前草稿",
				"capability.presets.fromApplied": "已应用的选择",
				"capability.presets.nameConflict": "此命名空间中已存在名为“{name}”的预设。",
				"capability.presets.rename": "改名…",
				"capability.presets.renameHint": "修改名称后重新保存。",
				"capability.presets.replace": "替换它",
				"capability.presets.saving": "正在保存…",
				"capability.presets.save": "保存预设",
				"capability.presets.importPlaceholder": "粘贴便携式预设文档（JSON）…",
				"capability.presets.importing": "正在导入…",
				"capability.presets.importSubmit": "导入",
				"capability.presets.importInvalidJson": "不是有效的 JSON——未写入任何内容。",
				"capability.presets.importRejected": "已拒绝：{reason}——未写入任何内容。",
				"capability.presets.importNameConflict": "此处已存在同名预设。",
				"capability.presets.importFailed": "导入失败——未写入任何内容。",
				"capability.presets.groupWorkspace": "工作区预设",
				"capability.presets.groupWorkspaceNone": "工作区预设（无工作区）",
				"capability.presets.groupGlobal": "全局预设",
				"capability.presets.emptyWorkspace": "暂无工作区预设。",
				"capability.presets.emptyGlobal": "暂无全局预设。",
				"capability.presets.defaultTitle": "新会话的工作区默认值",
				"capability.presets.defaultUnavailable": "工作区默认值不可用。",
				"capability.presets.defaultNone": "未设置默认值——新会话使用内置基线。",
				"capability.presets.defaultEmpty": "已设置显式空默认：新会话以 0 个技能 · 0 个 MCP 开始。",
				"capability.presets.defaultEntries": "默认值：{counts}",
				"capability.presets.defaultUnresolved": "……解析时报告 {n} 个未解析引用。",
				"capability.presets.defaultSaveOpen": "存为默认值…",
				"capability.presets.defaultClearOpen": "清除默认值…",
				"capability.presets.defaultSaveConfirm": "将 {counts} 存为此工作区的默认值？此工作区的新会话将从它开始；当前会话不变。",
				"capability.presets.defaultSaveConfirmButton": "保存默认值",
				"capability.presets.defaultSaved": "工作区默认值已保存。",
				"capability.presets.defaultSaveFailed": "默认值保存失败。",
				"capability.presets.defaultClearConfirm": "清除工作区默认值？新会话回到内置基线；已打开的会话不变。",
				"capability.presets.defaultClearConfirmButton": "清除默认值",
				"capability.presets.defaultCleared": "工作区默认值已清除——新会话使用内置基线。",
				"capability.presets.defaultClearFailed": "默认值清除失败。",
				"capability.presets.clearing": "正在清除…",
				"capability.presets.needsReceipt": "会话回执载入前不可用。",
				"capability.presets.exportDownload": "下载 .json",
				"capability.presets.downloaded": "已下载",
				"capability.presets.importedPackage": "已导入：安装 {installed} 个技能，{bound} 个 MCP 绑定，{unresolved} 个未解析引用。",
				"capability.presets.importSummaryTitle": "导入摘要——写入前请核对",
				"capability.presets.importFiles": "{n} 个文件",
				"capability.presets.importNoInstalls": "此包不包含需要安装的技能。",
				"capability.presets.importUnresolvedTitle": "未解析引用——不会安装：",
				"capability.presets.importCollision": "名称冲突",
				"capability.presets.importCollisionDecision": "当打包技能名称已存在时：",
				"capability.presets.collisionCancel": "跳过它（默认）",
				"capability.presets.collisionReplace": "替换它",
				"capability.presets.collisionCoexist": "共存（自动改名）",
				"capability.presets.importConfirm": "确认导入",
				"capability.presets.importResultTitle": "导入结果",
				"capability.presets.importInstalledNote": "已安装的技能保持未勾选——在草稿中勾选并应用后生效。",
				"capability.presets.importInstallFailed": "安装失败：{reason}——已回滚 {n} 个文件；未创建预设。",
				"capability.presets.importNoTargetRoot": "此宿主没有可用的 {scope} 技能根目录——未安装任何内容。",
				"capability.presets.scopeProject": "工作区",
				"capability.presets.scopeUser": "用户",
				"capability.loading": "正在加载能力…",
				unavailable: "此插件未加载，当前无法配置。",
				save: "保存",
			},
		};

		exports.dictionaries = dictionaries;
		exports.skillIdentityKeyOf = skillIdentityKeyOf;
		exports.skillEntryKeyOf = skillEntryKeyOf;
		exports.badgeStateOf = badgeStateOf;
		exports.skillRowOf = skillRowOf;
		exports.partitionManagerListing = partitionManagerListing;
		exports.managerConditionState = managerConditionState;
		exports.frameRefreshesSession = frameRefreshesSession;
		exports.draftFromReceipt = draftFromReceipt;
		exports.draftAfterRefresh = draftAfterRefresh;
		exports.draftToggle = draftToggle;
		exports.commitOutcomeOf = commitOutcomeOf;
		exports.skillDraftConflicts = skillDraftConflicts;
		exports.resolveSkillName = resolveSkillName;
		exports.skillSourceLabels = skillSourceLabels;
		exports.convergenceHintOf = convergenceHintOf;
		exports.groupSkillRows = groupSkillRows;
		exports.filterSkillRows = filterSkillRows;
		exports.draftDiffOf = draftDiffOf;
		exports.mcpAddErrorsOf = mcpAddErrorsOf;
		exports.mcpStateOf = mcpStateOf;
		exports.mcpListingAfterRead = mcpListingAfterRead;
		exports.mcpEditorFromServer = mcpEditorFromServer;
		exports.mcpConfigFromEditor = mcpConfigFromEditor;
		exports.mcpEditorHasSecrets = mcpEditorHasSecrets;
		exports.mcpEditorErrorsOf = mcpEditorErrorsOf;
		exports.mcpPreviewSupportOf = mcpPreviewSupportOf;
		exports.mcpPreviewHasSecrets = mcpPreviewHasSecrets;
		exports.mcpDocumentHasSecrets = mcpDocumentHasSecrets;
		exports.mcpSensitiveUrl = mcpSensitiveUrl;
		exports.mcpUtf8Bytes = mcpUtf8Bytes;
		exports.mcpJsonGuard = mcpJsonGuard;
		exports.mcpDocumentEntryOf = mcpDocumentEntryOf;
		exports.mcpBatchItemsOf = mcpBatchItemsOf;
		exports.draftFromPreset = draftFromPreset;
		exports.presetRowOf = presetRowOf;
		exports.groupPresets = groupPresets;
		exports.loadablePresetOf = loadablePresetOf;
		exports.presetWriteOutcomeOf = presetWriteOutcomeOf;
		exports.importFeedbackOf = importFeedbackOf;
		exports.presetExportTextOf = presetExportTextOf;
		exports.defaultStateOf = defaultStateOf;
		exports.defaultWriteOutcomeOf = defaultWriteOutcomeOf;
		exports.unresolvedLabelOf = unresolvedLabelOf;
		exports.packageVersionOf = packageVersionOf;
		exports.importDryRunOf = importDryRunOf;
		exports.importConfirmReadyOf = importConfirmReadyOf;
		exports.importConfirmOutcomeOf = importConfirmOutcomeOf;
		exports.exportFileNameOf = exportFileNameOf;
		return module.exports;
	}
});
