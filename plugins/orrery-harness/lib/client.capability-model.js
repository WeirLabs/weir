window.__ModuleLoader__.load({
	id: "orrery-harness",
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
		const SOURCE_LABELS = { "orrery-builtin": "Orrery builtin", user: "user", project: "project", custom: "custom" };
		function skillRowOf(candidate) {
			return {
				name: candidate?.name ?? "unknown",
				description: candidate?.description ?? "",
				source: SOURCE_LABELS[candidate?.scope] ?? candidate?.scope ?? "unknown",
				status: candidate?.status ?? "unknown",
				selected: Boolean(candidate?.selected),
				conflict: candidate?.conflict === true,
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

		exports.badgeStateOf = badgeStateOf;
		exports.skillRowOf = skillRowOf;
		exports.partitionManagerListing = partitionManagerListing;
		exports.managerConditionState = managerConditionState;
		exports.commitStateOf = commitStateOf;
		exports.closeDirtyDraft = closeDirtyDraft;
		exports.frameRefreshesSession = frameRefreshesSession;
		exports.convergenceHintOf = convergenceHintOf;
		return module.exports;
	}
});
