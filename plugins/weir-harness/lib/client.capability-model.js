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

		/** Applied counts come from the SERVER receipt, never the optimistic draft (12.2). */
		function badgeStateOf(receipt, draft) {
			const applied = receipt && receipt.status === "applied"
				? { skills: Array.isArray(receipt.effective?.skills) ? receipt.effective.skills.length : 0, mcpServers: Array.isArray(receipt.effective?.mcpServers) ? receipt.effective.mcpServers.length : 0 }
				: { skills: 0, mcpServers: 0 };
			const warnings = Array.isArray(receipt?.warnings) ? [...receipt.warnings] : [];
			const draftDirty = Boolean(draft && draft.dirty);
			return {
				applied,
				warnings,
				unavailable: warnings.filter((warning) => typeof warning === "string" && warning.includes("unavailable")),
				draftDirty,
				// Distinct from a fresh/loading state (12.2): receipt absent ≠ applied zero.
				known: Boolean(receipt && receipt.status === "applied"),
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
				mcpManaged: mcp.filter((server) => server?.state === "mounted" || server?.state === "registered"),
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
		 * The commit flow state machine (12.3): submission reuses the same
		 * request ID for retries; a failure keeps the draft; a revision
		 * conflict shows the current state for the user to re-pick (never a
		 * silent rebase); a no-diff draft with missing warnings offers
		 * install/configure instead of a fictional Apply; an indeterminate
		 * result stays queryable.
		 */
		function commitStateOf(draft) {
			if (!draft) return { phase: "idle" };
			if (draft.phase === "submitting") return { phase: "submitting", requestId: draft.requestId };
			if (draft.phase === "failed") return { phase: "failed", requestId: draft.requestId, error: draft.error ?? "unknown", draftKept: true };
			if (draft.phase === "revision-conflict") return { phase: "revision-conflict", current: draft.current ?? null, draftKept: true };
			if (draft.phase === "indeterminate") return { phase: "indeterminate", requestId: draft.requestId, queryable: true };
			if (draft.phase === "applied") return { phase: "applied", revision: draft.revision ?? null };
			if (draft.dirty === true) {
				if (Array.isArray(draft.missing) && draft.missing.length > 0 && draft.hasDiff !== true) {
					return { phase: "install-or-configure", missing: [...draft.missing] };
				}
				return { phase: "ready" };
			}
			return { phase: "idle" };
		}

		/** Discard vs keep-editing on a dirty draft close (12.3). */
		function closeDirtyDraft(decision) {
			return decision === "discard" ? { phase: "idle", draft: null } : { phase: "ready", keepEditing: true };
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
			return {
				skills: sortSkills(skills),
				mcpServers: [...mcpServers].sort(),
				applied: { skills: sortSkills(skills), mcpServers: [...mcpServers].sort(), unresolvedRefs: Array.isArray(receipt?.effective?.unresolvedRefs) ? [...receipt.effective.unresolvedRefs] : [] },
				unresolvedRefs: Array.isArray(receipt?.effective?.unresolvedRefs) ? [...receipt.effective.unresolvedRefs] : [],
				...(typeof receipt?.effective?.digest === "string" ? { appliedDigest: receipt.effective.digest } : {}),
				revision: Number.isSafeInteger(receipt?.revision) ? receipt.revision : 0,
				dirty: false,
			};
		}

		/** Toggle one entry in the draft; skills compare by identity, MCP by name. */
		function draftToggle(draft, kind, name) {
			if (kind === "skills") {
				const key = skillEntryKeyOf(name);
				const list = new Map(draft.skills.map(entry => [skillEntryKeyOf(entry), entry]));
				if (list.has(key)) list.delete(key); else list.set(key, name);
				const next = { ...draft, skills: sortSkills([...list.values()]) };
				next.dirty = draftDiffOf(next).any;
				return next;
			}
			const list = new Set(draft[kind]);
			if (list.has(name)) list.delete(name); else list.add(name);
			const next = { ...draft, [kind]: [...list].sort() };
			const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
			next.dirty = !same(next.skills.map(skillEntryKeyOf), draft.applied.skills.map(skillEntryKeyOf)) || !same(next.mcpServers, draft.applied.mcpServers);
			return next;
		}
		/** Preflight the complete draft against the unfiltered inventory. Strings are not identities. */
		function skillDraftConflicts(draft, listing) {
			const byName = new Map(), names = new Set();
			for (const entry of Array.isArray(draft?.skills) ? draft.skills : []) {
				if (typeof entry === "string") { if (entry) names.add(entry); continue; }
				const key = skillIdentityKeyOf(entry);
				if (key === null) continue;
				if (!byName.has(entry.name)) byName.set(entry.name, new Map());
				byName.get(entry.name).set(key, entry);
			}
			const selected = [...byName].filter(([, group]) => group.size > 1).map(([name, group]) => ({ name, identities: [...group.values()] }));
			const rows = Array.isArray(listing?.skills) ? listing.skills : null;
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
			const next = { ...draft, skills: sortSkills(entries) };
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
			if (!response || typeof response !== "object" || response.error === true) return { kind: "error" };
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
			if (["locked", "unreadable", "unsupported", "revision-conflict", "confirmation-required", "indeterminate", "commit-failed"].includes(response.status)) return { kind: response.status, installed: Array.isArray(response.installed) ? response.installed : [] };
			if (response.status === "no-workspace") return { kind: "no-workspace" };
			if (response.status === "rejected") return { kind: "rejected", reason: String(response.reason ?? "rejected") };
			return { kind: "error", status: response.status ?? "unknown" };
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

		exports.skillIdentityKeyOf = skillIdentityKeyOf;
		exports.skillEntryKeyOf = skillEntryKeyOf;
		exports.badgeStateOf = badgeStateOf;
		exports.skillRowOf = skillRowOf;
		exports.partitionManagerListing = partitionManagerListing;
		exports.managerConditionState = managerConditionState;
		exports.commitStateOf = commitStateOf;
		exports.closeDirtyDraft = closeDirtyDraft;
		exports.frameRefreshesSession = frameRefreshesSession;
		exports.draftFromReceipt = draftFromReceipt;
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
