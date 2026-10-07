window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.blackboard-model.js",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Zero-dependency view-model chunk for the session-blackboard panel
		// (slice 2, tasks 2.3/2.4): the factory never calls require. Every wire
		// and list decision is a pure function over plain data — the view layer
		// stays thin and the node:test suite covers the semantics against a
		// mocked carrier, including the exact POST
		// /api/orreryBlackboard/<method> payload shape.
		//
		// WIRE CONTRACT (pinned by src/blackboard/remote.js): namespace
		// orreryBlackboard, five methods, each taking the acting session as the
		// `agentId` lookup parameter plus one JSON `args` object. The channel
		// rides the RAW gateway carrier exactly like the capability reads (the
		// hand-written src-json contribution cannot mount through
		// ctx.remote.$mount — its strict-codec gate rejects src-json codecs),
		// so read verbs produce zero session-log events and every mutation
		// shares the agent tools' arbitration kernel.

		/** The closed entryType enum, mirroring src/blackboard/kernel.js (same-package sync require is impossible in the ModuleLoader). */
		const ENTRY_TYPES = Object.freeze(["map", "contract", "deadend", "wiring", "recipe", "why"]);

		/** Verbatim copy of the kernel's key rule (src/blackboard/kernel.js KEY_PATTERN): a letter/digit first, then letters, digits and . _ - / */
		const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;

		/** Free-text summary cap (mirrors the kernel's validateSummary). */
		const SUMMARY_MAX_LENGTH = 500;

		/** Watch polling gives up after this many consecutive carrier failures. */
		const WATCH_GIVE_UP_AFTER = 3;

		// ---- wire channel ----

		/**
		 * Fold one gateway envelope (or a carrier throw) into the panel's
		 * uniform result shape: { ok: true, value } | { ok: false, error:
		 * { code, message } }. The gateway already folds host-side failures
		 * into { ok: false, error } — including the remote's typed
		 * BlackboardRemoteError, which crosses as gateway/internal with its
		 * message intact — so the panel never sees an exception from a call.
		 */
		function foldRemoteResult(result) {
			if (result?.ok === true) return { ok: true, value: result.value };
			const failure = result?.error ?? result ?? null;
			return {
				ok: false,
				error: {
					code: typeof failure?.code === "string" ? failure.code : "call-failed",
					message: typeof failure?.message === "string" ? failure.message : String(failure ?? "unknown"),
				},
			};
		}

		/** Drop undefined fields so the wire payload carries exactly the arguments the caller meant (undefined is not JSON-safe). */
		const cleanArgs = (obj) => Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
		/**
		 * The panel's board channel over the raw gateway carrier. rawCall is
		 * (endpoint, payload) => Promise<RemoteResult> — the composition root
		 * binds it to connection.rpc.call("/api", …) with its degradation
		 * warnings; this factory owns the pinned wire shape:
		 *   POST /api/orreryBlackboard/<method>
		 *   payload { args: { agentId: <session>, args: <one JSON object> } }
		 * Every verb resolves the folded result, never rejects.
		 */
		function createBlackboardChannel(rawCall, sessionId) {
			const call = (method, args) => {
				let pending;
				try {
					pending = Promise.resolve(rawCall(`orreryBlackboard/${method}`, { args: { agentId: sessionId, args: args ?? {} } }));
				} catch (cause) {
					return Promise.resolve({ ok: false, error: { code: "call-threw", message: cause instanceof Error ? cause.message : String(cause) } });
				}
				return pending.then(foldRemoteResult, (cause) => ({ ok: false, error: { code: "call-threw", message: cause instanceof Error ? cause.message : String(cause) } }));
			};
			return {
				/** list({ type?, query? }) — the panel polls the unfiltered board and shapes groups client-side. */
				list: (args) => call("list", cleanArgs({ type: args?.type, query: args?.query })),
				/** read({ keys }) — unknown keys come back by absence, never thrown. */
				read: (keys) => call("read", { keys: Array.isArray(keys) ? keys : [] }),
				/** apply({ key }) — acquires the one-shot write authority or reports the holder (auto-subscribed) or the promoted refusal. */
				apply: (key) => call("apply", { key }),
				/** write({ key, entryType, summary, content }) — consumes the held authority (create acquires inside). */
				write: (entry) => call("write", cleanArgs({
					key: entry?.key,
					entryType: entry?.entryType,
					summary: entry?.summary,
					content: entry?.content,
				})),
				/** remove({ key }) — delete under the held authority. */
				remove: (key) => call("remove", { key }),
				/** requestPromotion() — the panel button: injects the promotion-evaluation brief into the main agent. */
				requestPromotion: () => call("requestPromotion", {}),
				/** markPromoted({ key, destination }) — the panel's 1:1 mirror of the agent tool (the agent marks; the panel only reads the marker). */
				markPromoted: (key, destination) => call("markPromoted", { key, destination }),
			};
		}

		// ---- entries ----

		/** Defensive normalization of one wire row (list or read shape; content only present on reads). */
		function entryRowOf(raw) {
			const row = {
				key: typeof raw?.key === "string" ? raw.key : "unknown",
				entryType: typeof raw?.entryType === "string" ? raw.entryType : "unknown",
				summary: typeof raw?.summary === "string" ? raw.summary : "",
				readCount: Number.isSafeInteger(raw?.readCount) ? raw.readCount : 0,
				subscribeCount: Number.isSafeInteger(raw?.subscribeCount) ? raw.subscribeCount : 0,
				updatedAt: typeof raw?.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
			};
			if (typeof raw?.content === "string") row.content = raw.content;
			if (raw?.promoted && typeof raw.promoted === "object") {
				row.promoted = {
					destination: typeof raw.promoted.destination === "string" ? raw.promoted.destination : "",
					at: typeof raw.promoted.at === "number" && Number.isFinite(raw.promoted.at) ? raw.promoted.at : 0,
				};
			}
			return row;
		}

		/** The board listing: rows on success, else the explicit failure the panel renders. */
		function listOutcomeOf(result) {
			if (result?.ok === true) {
				const entries = Array.isArray(result.value?.entries) ? result.value.entries : [];
				return { kind: "ok", rows: entries.map(entryRowOf) };
			}
			return { kind: "failed", message: result?.error?.message ?? "unknown" };
		}

		/** The content read: found entries plus the requested keys that came back by absence (unknown keys are values, not errors). */
		function readOutcomeOf(result, requestedKeys) {
			if (result?.ok !== true) return { kind: "failed", message: result?.error?.message ?? "unknown" };
			const entries = (Array.isArray(result.value?.entries) ? result.value.entries : []).map(entryRowOf);
			const found = new Set(entries.map((entry) => entry.key));
			const missing = (Array.isArray(requestedKeys) ? requestedKeys : []).filter((key) => typeof key === "string" && !found.has(key));
			return { kind: "ok", entries, missing };
		}

		/** apply: the authority with its expiry, the contention report, or a channel failure. */
		function applyOutcomeOf(result) {
			if (result?.ok !== true) return { kind: "failed", message: result?.error?.message ?? "unknown" };
			const value = result.value;
			if (value?.acquired === true) {
				return {
					kind: "acquired",
					token: typeof value.token === "string" ? value.token : "",
					expiresAt: typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0,
				};
			}
			if (value?.promoted === true) {
				return { kind: "promoted", destination: typeof value?.destination === "string" ? value.destination : "" };
			}
			return {
				kind: "contended",
				holder: typeof value?.holder === "string" && value.holder !== "" ? value.holder : "another session",
				subscribed: value?.subscribed === true,
			};
		}

		/** write: the consumed-authority receipt (revision 1 on create), or the folded { ok:false, error } the remote returns for domain failures. */
		function writeOutcomeOf(result) {
			if (result?.ok !== true) return { kind: "failed", message: result?.error?.message ?? "unknown" };
			const value = result.value;
			if (value?.ok === true) return { kind: "saved", revision: Number.isSafeInteger(value.revision) ? value.revision : 0 };
			return { kind: "failed", message: typeof value?.error === "string" ? value.error : "unknown" };
		}

		/** remove: deleted, or the folded failure (missing key, no authority). */
		function removeOutcomeOf(result) {
			if (result?.ok !== true) return { kind: "failed", message: result?.error?.message ?? "unknown" };
			const value = result.value;
			if (value?.ok === true) return { kind: "removed" };
			return { kind: "failed", message: typeof value?.error === "string" ? value.error : "unknown" };
		}

		// ---- promotion (slice 3: panel button + promoted marker) ----

		/** The promotion button state over the live listing: enabled exactly when at least one entry is NOT promoted. */
		function promotionButtonState(rows) {
			const list = Array.isArray(rows) ? rows : [];
			return { enabled: list.some((row) => !row?.promoted), candidateCount: list.filter((row) => !row?.promoted).length };
		}

		/** requestPromotion: the brief was accepted by the main agent's delivery, or the folded failure. */
		function promotionOutcomeOf(result) {
			if (result?.ok !== true) return { kind: "failed", message: result?.error?.message ?? "unknown" };
			return { kind: "requested" };
		}

		/** markPromoted: marked with the destination, an already-promoted report, or the folded failure. */
		function markPromotedOutcomeOf(result) {
			if (result?.ok !== true) return { kind: "failed", message: result?.error?.message ?? "unknown" };
			const value = result.value;
			if (value?.ok === true) return { kind: "marked", destination: typeof value.destination === "string" ? value.destination : "", already: value?.alreadyPromoted === true };
			return { kind: "failed", message: typeof value?.error === "string" ? value.error : "unknown" };
		}

		// ---- list shaping (mirrors the kernel's list filter semantics) ----

		/** Filter rows by exact entryType and a case-insensitive substring over key + summary — the kernel list haystack. */
		function filterEntries(rows, { type, query } = {}) {
			let list = Array.isArray(rows) ? rows : [];
			if (typeof type === "string" && type !== "" && ENTRY_TYPES.includes(type)) {
				list = list.filter((row) => row?.entryType === type);
			}
			const needle = typeof query === "string" && query.trim() !== "" ? query.trim().toLowerCase() : null;
			if (needle !== null) {
				list = list.filter((row) => `${row?.key ?? ""} ${row?.summary ?? ""}`.toLowerCase().includes(needle));
			}
			return list;
		}

		/** Group rows by entryType in the enum's fixed order; rows sort by key inside a group (the kernel's list order); unknown types trail alphabetically. */
		function groupEntries(rows) {
			const byType = new Map();
			for (const row of Array.isArray(rows) ? rows : []) {
				const type = typeof row?.entryType === "string" ? row.entryType : "unknown";
				if (!byType.has(type)) byType.set(type, []);
				byType.get(type).push(row);
			}
			const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
			const known = ENTRY_TYPES.filter((type) => byType.has(type)).map((type) => ({ type, rows: byType.get(type).slice().sort(byKey) }));
			const unknown = [...byType.keys()].filter((type) => !ENTRY_TYPES.includes(type)).sort();
			return [...known, ...unknown.map((type) => ({ type, rows: byType.get(type).slice().sort(byKey) }))];
		}

		// ---- write-token countdown ----

		/** The held authority against the clock: held with a remaining budget, or expired at zero (the kernel's TTL release then applies). */
		function tokenCountdownOf(expiresAt, now) {
			const remaining = (typeof expiresAt === "number" ? expiresAt : 0) - (typeof now === "number" ? now : 0);
			if (remaining > 0) return { phase: "held", remainingMs: remaining };
			return { phase: "expired", remainingMs: 0 };
		}

		/** Compact countdown label: "42m 05s" under an hour, "1h 03m" beyond. */
		function formatRemainingMs(remainingMs) {
			const total = Math.max(0, Math.ceil((typeof remainingMs === "number" ? remainingMs : 0) / 1000));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
			if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
			return `${seconds}s`;
		}

		// ---- contention watch (subscribe-and-notify-on-release, client-side) ----

		/** Enter the watching state after a contended apply: the server already auto-subscribed this session; the panel polls apply until the key frees. */
		function watchStart(key, holder) {
			return { phase: "watching", key, holder: typeof holder === "string" && holder !== "" ? holder : "another session", pollErrors: 0 };
		}

		/**
		 * Fold one watch-poll apply outcome into the next watch state. While
		 * contended the watch holds (the holder label refreshes); an acquired
		 * flip means the poll's apply itself granted the authority — the key
		 * freed and THIS session now holds it (released carries the expiry the
		 * countdown runs from); carrier failures count toward the give-up cap.
		 */
		function watchAfterPoll(watch, outcome) {
			if (watch?.phase !== "watching") return watch ?? null;
			if (outcome?.kind === "acquired") {
				return { phase: "released", key: watch.key, expiresAt: outcome.expiresAt };
			}
			if (outcome?.kind === "contended") {
				return { phase: "watching", key: watch.key, holder: outcome.holder ?? watch.holder, pollErrors: 0 };
			}
			const pollErrors = (Number.isSafeInteger(watch.pollErrors) ? watch.pollErrors : 0) + 1;
			if (pollErrors >= WATCH_GIVE_UP_AFTER) {
				return { phase: "failed", key: watch.key, message: outcome?.message ?? "unknown" };
			}
			return { phase: "watching", key: watch.key, holder: watch.holder, pollErrors };
		}

		// ---- poll refresh staleness (no server push: updatedAt is the evidence) ----

		/** Diff two listings by per-key updatedAt: rows whose content moved (re-read candidates) and keys that disappeared (deleted elsewhere). */
		function staleKeysOf(prevRows, nextRows) {
			const prevStamp = new Map((Array.isArray(prevRows) ? prevRows : []).map((row) => [row?.key, row?.updatedAt]));
			const nextKeys = new Set((Array.isArray(nextRows) ? nextRows : []).map((row) => row?.key));
			const changed = (Array.isArray(nextRows) ? nextRows : [])
				.filter((row) => prevStamp.has(row?.key) && prevStamp.get(row.key) !== row.updatedAt)
				.map((row) => row.key);
			const removed = [...prevStamp.keys()].filter((key) => !nextKeys.has(key));
			return { changed, removed };
		}

		/** The open detail must re-read when its row's updatedAt moved on the latest listing (absence is the gone branch, handled by the view). */
		function detailNeedsReread(detail, nextRows) {
			if (!detail || typeof detail.key !== "string") return false;
			const row = (Array.isArray(nextRows) ? nextRows : []).find((candidate) => candidate?.key === detail.key);
			return row !== undefined && row.updatedAt !== detail.updatedAt;
		}

		/** Compact timestamp for the listing: same-day HH:MM:SS, else MM-DD. */
		function formatTimeOf(timestamp, now) {
			if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return "";
			const date = new Date(timestamp);
			const reference = typeof now === "number" ? new Date(now) : new Date();
			const pad = (value) => String(value).padStart(2, "0");
			const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
			const sameDay = date.getFullYear() === reference.getFullYear() && reference.getMonth() === date.getMonth() && reference.getDate() === date.getDate();
			return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock.slice(0, 5)}`;
		}

		// ---- editor draft ----

		/** The blank create draft (entryType defaults to the first enum value so the segmented control always has a selection). */
		function emptyEditorDraft() {
			return { key: "", entryType: ENTRY_TYPES[0], summary: "", content: "" };
		}

		/** The update draft seeded from a full read entry. */
		function editorDraftFromEntry(entry) {
			return {
				key: typeof entry?.key === "string" ? entry.key : "",
				entryType: ENTRY_TYPES.includes(entry?.entryType) ? entry.entryType : ENTRY_TYPES[0],
				summary: typeof entry?.summary === "string" ? entry.summary : "",
				content: typeof entry?.content === "string" ? entry.content : "",
			};
		}

		/**
		 * Per-field draft errors mirroring the kernel's write gate (validateKey,
		 * the closed entryType enum, non-empty free-text summary within the
		 * cap, non-empty content); an
		 * empty object means the draft may be submitted. The server stays
		 * authoritative — this only keeps obviously bad writes off the wire.
		 */
		function editorErrorsOf(draft) {
			const errors = {};
			const key = typeof draft?.key === "string" ? draft.key.trim() : "";
			if (key === "") errors.key = "required";
			else if (!KEY_PATTERN.test(key)) errors.key = "invalid";
			if (!ENTRY_TYPES.includes(draft?.entryType)) errors.entryType = "invalid";
			if (typeof draft?.summary !== "string" || draft.summary.trim() === "") errors.summary = "required";
			else if (draft.summary.trim().length > SUMMARY_MAX_LENGTH) errors.summary = "invalid";
			if (typeof draft?.content !== "string" || draft.content.trim() === "") errors.content = "required";
			return errors;
		}

		/** The write payload for a valid draft (free-text summary). */
		function editorWritePayload(draft) {
			return {
				key: typeof draft?.key === "string" ? draft.key.trim() : "",
				entryType: draft?.entryType,
				summary: draft?.summary?.trim() ?? "",
				content: draft?.content ?? "",
			};
		}

		exports.ENTRY_TYPES = ENTRY_TYPES;
		exports.SUMMARY_MAX_LENGTH = SUMMARY_MAX_LENGTH;
		exports.WATCH_GIVE_UP_AFTER = WATCH_GIVE_UP_AFTER;
		exports.foldRemoteResult = foldRemoteResult;
		exports.createBlackboardChannel = createBlackboardChannel;
		exports.entryRowOf = entryRowOf;
		exports.listOutcomeOf = listOutcomeOf;
		exports.readOutcomeOf = readOutcomeOf;
		exports.applyOutcomeOf = applyOutcomeOf;
		exports.writeOutcomeOf = writeOutcomeOf;
		exports.removeOutcomeOf = removeOutcomeOf;
		exports.promotionButtonState = promotionButtonState;
		exports.promotionOutcomeOf = promotionOutcomeOf;
		exports.markPromotedOutcomeOf = markPromotedOutcomeOf;
		exports.filterEntries = filterEntries;
		exports.groupEntries = groupEntries;
		exports.tokenCountdownOf = tokenCountdownOf;
		exports.formatRemainingMs = formatRemainingMs;
		exports.watchStart = watchStart;
		exports.watchAfterPoll = watchAfterPoll;
		exports.staleKeysOf = staleKeysOf;
		exports.detailNeedsReread = detailNeedsReread;
		exports.formatTimeOf = formatTimeOf;
		exports.emptyEditorDraft = emptyEditorDraft;
		exports.editorDraftFromEntry = editorDraftFromEntry;
		exports.editorErrorsOf = editorErrorsOf;
		exports.editorWritePayload = editorWritePayload;
		return module.exports;
	}
});
