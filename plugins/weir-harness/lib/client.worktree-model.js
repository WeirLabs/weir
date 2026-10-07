window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.worktree-model.js",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Worktree lanes view model: pure helpers shared by every worktree
		// surface (session row marker, header pill, lanes panel, composer mode
		// switch, tool views). Zero dependencies; every wire value is narrowed
		// defensively so a malformed view or replayed tool meta never throws.
		const WORKTREE_PROJECTION_KEY = "weirWorktree";
		const TOOLS = ["worktree_open", "worktree_check", "worktree_land", "worktree_cleanup", "worktree_abandon", "worktree_watch"];
		const FINISHED = ["landed", "kept", "cleaned", "abandoned"];
		const TRANSIENT = ["preparing", "working", "checking", "awaiting-approval"];
		/** State → tone group (badge colour family). */
		const TONE = {
			preparing: "progress", working: "progress", checking: "progress",
			ready: "neutral", declined: "neutral",
			"setup-failed": "attention", dirty: "attention", "no-commits": "attention", "branch-moved": "attention", "check-failed": "attention", conflicted: "attention",
			"awaiting-approval": "approval",
			landable: "ready",
			landed: "done", kept: "done", cleaned: "done", abandoned: "done"
		};
		/** Tone → theme token (light and dark both define these aliases). */
		const TONE_COLOR = {
			progress: "var(--dsw-alias-state-business-primary)",
			neutral: "var(--dsw-alias-label-tertiary)",
			attention: "var(--dsw-alias-state-error-primary)",
			approval: "var(--dsw-alias-state-warn-primary)",
			ready: "var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary))",
			done: "var(--dsw-alias-label-tertiary)"
		};
		const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
		const str = (value) => (typeof value === "string" ? value : null);
		const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
		function toneOf(state) {
			return TONE[state] ?? "neutral";
		}
		function colorOf(state) {
			return TONE_COLOR[toneOf(state)];
		}
		/** Narrow one lane record from the view endpoint. */
		function narrowLane(raw) {
			if (!isObject(raw) || !str(raw.id) || !str(raw.state)) return null;
			const actions = {};
			for (const [key, value] of Object.entries(isObject(raw.actions) ? raw.actions : {})) {
				if (isObject(value)) actions[key] = { enabled: value.enabled === true, reason: str(value.reason) };
			}
			const stat = isObject(raw.stat) ? { files: num(raw.stat.files) ?? 0, added: num(raw.stat.added) ?? 0, removed: num(raw.stat.removed) ?? 0 } : null;
			const check = isObject(raw.check) ? {
				enabled: raw.check.enabled === true,
				tree: str(raw.check.tree),
				results: Array.isArray(raw.check.results) ? raw.check.results.filter(isObject).map((entry) => ({ name: str(entry.name) ?? "?", exit: num(entry.exit), ms: num(entry.ms), log: str(entry.log) })) : []
			} : null;
			const history = Array.isArray(raw.history) ? raw.history.filter(isObject) : [];
			return {
				id: raw.id,
				title: str(raw.title) ?? raw.id,
				state: raw.state,
				reason: str(raw.reason),
				path: str(raw.path),
				branch: str(raw.branch),
				base: isObject(raw.base) ? str(raw.base.branch) : null,
				scope: Array.isArray(raw.scope) ? raw.scope.filter((entry) => typeof entry === "string") : [],
				ahead: num(raw.ahead),
				behind: num(raw.behind),
				stat,
				check,
				landableTree: str(raw.landableTree),
				baseMoved: raw.baseMoved === true,
				watchCount: num(raw.watchCount) ?? 0,
				watchStates: Array.isArray(raw.watchStates) ? raw.watchStates.filter((entry) => typeof entry === "string") : [],
				boundChild: str(raw.boundChild),
				ownerSession: str(raw.ownerSession),
				exists: raw.exists !== false,
				next: isObject(raw.next) ? raw.next : null,
				transient: TRANSIENT.includes(raw.state),
				conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter((entry) => typeof entry === "string") : [],
				merge: isObject(raw.land) ? { commit: str(raw.land.commit), at: num(raw.land.at), by: str(raw.land.by) } : null,
				cleanup: isObject(raw.cleanup) ? { mode: str(raw.cleanup.mode) } : null,
				updatedAt: num(raw.updatedAt) ?? num(history.at(-1)?.at),
				actions
			};
		}
		/** Narrow the whole view; null for anything that is not a view. */
		function narrowView(raw) {
			if (!isObject(raw)) return null;
			const lanes = Array.isArray(raw.lanes) ? raw.lanes.map(narrowLane).filter(Boolean) : [];
			const repo = isObject(raw.repo) ? {
				mainRoot: str(raw.repo.mainRoot),
				root: str(raw.repo.root),
				branch: str(raw.repo.branch),
				gitVersion: str(raw.repo.gitVersion),
				exclude: raw.repo.exclude === true,
				verification: isObject(raw.repo.verification) ? {
					enabled: raw.repo.verification.enabled === true,
					commands: Array.isArray(raw.repo.verification.commands) ? raw.repo.verification.commands.filter((entry) => typeof entry === "string") : [],
					error: str(raw.repo.verification.error)
				} : { enabled: false, commands: [], error: null }
			} : null;
			return {
				available: raw.available === true,
				enabled: raw.enabled !== false,
				mode: raw.mode === true,
				approveMode: str(raw.approveMode),
				approveModeSource: str(raw.approveModeSource),
				error: isObject(raw.error) ? { code: str(raw.error.code) ?? "ERROR", message: str(raw.error.message) ?? "" } : null,
				repo,
				lanes,
				owned: Array.isArray(raw.ownedBySession) ? raw.ownedBySession.filter((entry) => typeof entry === "string") : [],
				unmanaged: Array.isArray(raw.unmanaged) ? raw.unmanaged.filter((entry) => typeof entry === "string") : []
			};
		}
		/** Active / history split, newest first within each group. */
		function groupLanes(lanes) {
			const byRecent = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
			return {
				active: lanes.filter((lane) => !FINISHED.includes(lane.state)).sort(byRecent),
				history: lanes.filter((lane) => FINISHED.includes(lane.state)).sort(byRecent)
			};
		}
		/** Counts for the session marker and header pill (owned lanes only when known). */
		function summaryOf(view, ownedOnly = true) {
			if (!isObject(view)) return { active: 0, awaiting: 0, attention: 0, baseMoved: false, mode: false };
			// Degraded endpoint shapes (WORKTREE_DISABLED / SESSION_NOT_LIVE) and
			// malformed payloads may lack these arrays — never read .length/.some
			// on an unchecked field.
			const all = Array.isArray(view.lanes) ? view.lanes.filter(isObject) : [];
			const owned = Array.isArray(view.owned) ? view.owned : [];
			const lanes = ownedOnly && owned.length ? all.filter((lane) => owned.includes(lane.id)) : all;
			const active = lanes.filter((lane) => !FINISHED.includes(lane.state));
			return {
				active: active.length,
				awaiting: active.filter((lane) => lane.state === "awaiting-approval").length,
				attention: active.filter((lane) => toneOf(lane.state) === "attention").length,
				baseMoved: active.some((lane) => lane.baseMoved),
				mode: view.mode === true
			};
		}
		/** Whether the panel should keep polling (a host-side transition is due). */
		function needsPolling(view) {
			return Boolean(isObject(view) && Array.isArray(view.lanes) && view.lanes.some((lane) => isObject(lane) && lane.transient === true));
		}
		/** The /worktree command line one panel action runs (null = not a command). */
		function commandFor(action, lane, option) {
			const id = lane.id;
			switch (action) {
				case "check": return `check ${id}`;
				case "land": return `land ${id}`;
				case "setup": return option === "skip" ? `setup ${id} --skip` : `setup ${id}`;
				case "clean": return ["keep", "worktree", "all"].includes(option) ? `clean ${id} ${option}` : null;
				case "abandon": return ["keep", "worktree", "all"].includes(option) ? `abandon ${id} ${option}` : null;
				default: return null;
			}
		}
		/** Actions that change something irreversibly need a second click. */
		function needsConfirm(action, option) {
			return action === "land" || (action === "abandon" && option !== "keep") || (action === "clean" && option === "all");
		}
		/** Render a `next` hint for people. */
		function nextText(next) {
			if (!isObject(next)) return null;
			if (str(next.waitFor)) return `${next.waitFor}${str(next.hint) ? ` — ${next.hint}` : ""}`;
			if (str(next.tool)) return `${next.tool}${str(next.hint) ? ` — ${next.hint}` : ""}`;
			return null;
		}
		/** Narrow a persisted worktree_watch subscription; wrong field types void it. */
		function narrowWatch(value) {
			if (!isObject(value) || !Array.isArray(value.states)) return null;
			if (value.expiresAt !== undefined && value.expiresAt !== null && num(value.expiresAt) === null) return null;
			return { states: value.states.filter((entry) => typeof entry === "string"), expiresAt: num(value.expiresAt) };
		}
		/** Narrow persisted tool meta (tool/result.meta.worktree). */
		function narrowToolMeta(meta) {
			const raw = isObject(meta) ? meta.worktree : null;
			if (!isObject(raw) || !TOOLS.includes(raw.tool) || !str(raw.state)) return null;
			return {
				tool: raw.tool,
				lane: str(raw.lane),
				state: raw.state,
				from: str(raw.from),
				summary: str(raw.summary) ?? "",
				next: isObject(raw.next) ? raw.next : null,
				merge: isObject(raw.merge) ? { commit: str(raw.merge.commit), stat: isObject(raw.merge.stat) ? { files: num(raw.merge.stat.files) ?? 0, added: num(raw.merge.stat.added) ?? 0, removed: num(raw.merge.stat.removed) ?? 0 } : null } : null,
				conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter((entry) => typeof entry === "string") : [],
				check: (Array.isArray(raw.check) ? raw.check : isObject(raw.check) && Array.isArray(raw.check.results) ? raw.check.results : []).filter(isObject).map((entry) => ({ name: str(entry.name) ?? "?", exit: num(entry.exit), ms: num(entry.ms) })),
				diff: str(raw.diff),
				cleanup: isObject(raw.cleanup) ? { state: str(raw.cleanup.state), summary: str(raw.cleanup.summary), error: str(raw.cleanup.error) } : null,
				watch: narrowWatch(raw.watch),
				hit: str(raw.hit)
			};
		}
		/** Classify unified-diff lines for colouring. */
		function diffLines(text, limit = 2000) {
			if (typeof text !== "string" || text === "") return [];
			const lines = text.split("\n");
			const out = lines.slice(0, limit).map((line) => ({
				text: line,
				kind: line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context"
			}));
			if (lines.length > limit) out.push({ text: `… ${lines.length - limit} more line(s)`, kind: "meta" });
			return out;
		}
		/** Relative "x min ago" without Intl dependencies on old engines. */
		function ago(at, now = Date.now()) {
			if (typeof at !== "number") return "";
			const seconds = Math.max(0, Math.round((now - at) / 1000));
			if (seconds < 60) return `${seconds}s`;
			if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
			if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
			return `${Math.round(seconds / 86400)}d`;
		}
		/** Parse `/worktree init` output (JSON text) into suggestions. */
		function parseInit(text) {
			try {
				const value = JSON.parse(text);
				if (!isObject(value)) return null;
				const current = isObject(value.current) ? value.current : null;
				const suggested = isObject(value.suggested) ? value.suggested : {};
				return {
					file: str(value.file),
					error: str(value.error),
					current: current ? { setup: str(current.setup), check: Array.isArray(current.check) ? current.check.filter(isObject) : [] } : null,
					suggested: { setup: str(suggested.setup), setupWarning: str(suggested.setupWarning), check: Array.isArray(suggested.check) ? suggested.check.filter(isObject) : [] }
				};
			} catch {
				return null;
			}
		}
		/** Serialize the config editor rows into the /worktree init write payload. */
		function configPayload(setup, rows) {
			const check = rows
				.map((row) => ({ name: String(row.name ?? "").trim(), run: String(row.run ?? "").trim() }))
				.filter((row) => row.name !== "" && row.run !== "");
			const payload = { check };
			if (typeof setup === "string" && setup.trim() !== "") payload.setup = setup.trim();
			return JSON.stringify(payload);
		}
		exports.WORKTREE_PROJECTION_KEY = WORKTREE_PROJECTION_KEY;
		exports.WORKTREE_TOOLS = TOOLS;
		exports.FINISHED = FINISHED;
		exports.toneOf = toneOf;
		exports.colorOf = colorOf;
		exports.narrowLane = narrowLane;
		exports.narrowView = narrowView;
		exports.groupLanes = groupLanes;
		exports.summaryOf = summaryOf;
		exports.needsPolling = needsPolling;
		exports.commandFor = commandFor;
		exports.needsConfirm = needsConfirm;
		exports.nextText = nextText;
		exports.narrowToolMeta = narrowToolMeta;
		exports.diffLines = diffLines;
		exports.ago = ago;
		exports.parseInit = parseInit;
		exports.configPayload = configPayload;
		return module.exports;
	}
});
