window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.file-lease-tool-model.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Zero-dependency view-model chunk for the edit-lock conversation cards
		// (openspec edit-lock-tool-cards, design D2): the factory never calls
		// require. Every helper is pure and defensive — persisted metadata is
		// replayed from session logs that may predate this card (no meta at all)
		// or carry a shape this build does not know, and either case must narrow
		// to null so the view renders its argument/raw-output fallback instead of
		// throwing.
		const LEASE_META_VERSION = 1;
		// The closed state set per tool. Mirrors LEASE_META_STATES in
		// src/file-lease/tools.js (the producer); a state outside it is malformed.
		const LEASE_TOOL_STATES = {
			edit_lock_acquire: ["claimed", "degraded"],
			edit_lock_release: ["released", "degraded"],
			edit_lock_hold: ["held", "degraded"],
			edit_lock_status: ["status", "degraded"],
			edit_lock_try_steal: ["pending", "free", "self", "degraded"],
			edit_lock_reply: ["transferred", "declined", "degraded"],
			edit_lock_watch: ["watching", "free", "self", "released", "reset", "unsupported", "cancelled", "degraded"]
		};
		const LEASE_TOOLS = Object.keys(LEASE_TOOL_STATES);
		const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
		const isText = (value) => typeof value === "string" && value !== "";
		const isInstant = (value) => typeof value === "number" && Number.isFinite(value);
		const textList = (value) => (Array.isArray(value) ? value.filter(isText) : []);
		const holderOf = (value) => (isRecord(value) && isText(value.label) && isText(value.session) ? { label: value.label, session: value.session } : null);
		/**
		 * Narrow a persisted `block.meta` to the card's view of one outcome, or
		 * null when it is absent, of another version, names another tool, or
		 * carries a state outside that tool's closed set.
		 */
		function narrowLeaseMeta(meta) {
			const raw = isRecord(meta) ? meta.editLock : undefined;
			if (!isRecord(raw) || raw.v !== LEASE_META_VERSION) return null;
			const tool = raw.tool;
			if (typeof tool !== "string" || !Object.prototype.hasOwnProperty.call(LEASE_TOOL_STATES, tool)) return null;
			const state = raw.state;
			if (typeof state !== "string" || !LEASE_TOOL_STATES[tool].includes(state)) return null;
			const rows = (value) => (Array.isArray(value) ? value.filter((row) => isRecord(row) && isText(row.path)) : []);
			return {
				tool,
				state,
				code: isText(raw.code) ? raw.code : null,
				path: isText(raw.path) ? raw.path : null,
				paths: textList(raw.paths),
				released: textList(raw.released),
				notOwned: textList(raw.notOwned),
				held: rows(raw.held).map((row) => ({ path: row.path, holdUntil: isInstant(row.holdUntil) ? row.holdUntil : null })),
				mine: rows(raw.mine).map((row) => ({ path: row.path, until: isInstant(row.until) ? row.until : null, retained: row.retained === true })),
				others: rows(raw.others).map((row) => ({
					path: row.path,
					label: isText(row.label) ? row.label : null,
					session: isText(row.session) ? row.session : null,
					until: isInstant(row.until) ? row.until : null,
					lapsed: row.lapsed === true
				})),
				requestId: isText(raw.requestId) ? raw.requestId : null,
				decision: raw.decision === "release" || raw.decision === "keep" ? raw.decision : null,
				holder: holderOf(raw.holder),
				expiresAt: isInstant(raw.expiresAt) ? raw.expiresAt : null,
				at: isInstant(raw.at) ? raw.at : null
			};
		}
		/**
		 * The tone of one outcome (design D3): success, wait, danger, warn or
		 * neutral. The view maps a tone to a theme colour. The fallback states
		 * `running`, `failed`, `stopped` and `raw` share the same scale.
		 */
		function colorOf(tool, state) {
			if (state === "claimed" || state === "held" || state === "transferred") return "success";
			if (state === "released") return tool === "edit_lock_release" ? "success" : "neutral";
			if (state === "watching" || state === "pending" || state === "running") return "wait";
			if (state === "failed") return "danger";
			if (state === "degraded" || state === "unsupported" || state === "reset" || state === "cancelled") return "warn";
			return "neutral";
		}
		/**
		 * The dictionary key (without namespace) of one state's badge label.
		 * `released` reads differently on the watch card (a release that landed
		 * while the subscription was set up) than on the release card.
		 */
		function stateKey(tool, state) {
			if (tool === "edit_lock_watch" && state === "released") return "leaseToolState_watch_released";
			return `leaseToolState_${state}`;
		}
		/** The raw argument JSON of a start or result block, when present. */
		function argsRawOf(block) {
			if (typeof block?.argsRaw === "string") return block.argsRaw;
			if (typeof block?.call?.argsRaw === "string") return block.call.argsRaw;
			if (isRecord(block?.args)) return block.args;
			if (isRecord(block?.call?.args)) return block.call.args;
			return null;
		}
		/**
		 * The paths a call asked about, from its arguments: `paths` for the batch
		 * tools, `file_path` for the single-path ones. Unparseable or partial
		 * arguments (a call still streaming) yield an empty list, never a throw.
		 */
		function argsPaths(tool, argsRaw) {
			let args = argsRaw;
			if (typeof argsRaw === "string") {
				try {
					args = JSON.parse(argsRaw);
				} catch {
					return [];
				}
			}
			if (!isRecord(args)) return [];
			if (Array.isArray(args.paths)) return textList(args.paths);
			if (isText(args.file_path)) return [args.file_path];
			return [];
		}
		/** The request id a reply call answered, from its arguments. */
		function argsRequestId(argsRaw) {
			let args = argsRaw;
			if (typeof argsRaw === "string") {
				try {
					args = JSON.parse(argsRaw);
				} catch {
					return null;
				}
			}
			return isRecord(args) && isText(args.request_id) ? args.request_id : null;
		}
		/** Joined text of a result block's content parts (the model-facing text). */
		function resultText(block) {
			if (!Array.isArray(block?.content)) return "";
			return block.content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).filter((value) => value !== "").join("\n");
		}
		/** The failure text of an errored block: its content, else its error message. */
		function errorText(block) {
			const text = resultText(block);
			if (text !== "") return text;
			if (isText(block?.error?.message)) return block.error.message;
			return "";
		}
		/**
		 * The card state when no structured outcome exists: a call still
		 * preparing or running, one that threw (a refusal or failure), one the
		 * user interrupted, or a completed result recorded before the cards
		 * existed (`raw`).
		 */
		function fallbackState(phase, block) {
			if (phase === "preparing" || phase === "start") return "running";
			if (block?.isError) return block?.error?.code === "interrupted" ? "stopped" : "failed";
			if (phase === "result" || Array.isArray(block?.content)) return "raw";
			return "running";
		}
		/** A path as the session sees it: relative to the session cwd when inside it. */
		function shortPath(path, cwd) {
			if (typeof path !== "string") return "";
			if (typeof cwd === "string" && cwd !== "") {
				const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
				if (path.startsWith(prefix)) return path.slice(prefix.length);
			}
			return path;
		}
		/** The paths one outcome is about, in display order (first = primary). */
		function outcomePaths(meta) {
			if (meta === null) return [];
			if (meta.path !== null) return [meta.path];
			if (meta.tool === "edit_lock_release" && meta.state === "released") return [...meta.released, ...meta.notOwned];
			if (meta.tool === "edit_lock_hold" && meta.state === "held") return meta.held.map((row) => row.path);
			if (meta.tool === "edit_lock_status" && meta.state === "status") return [...meta.mine.map((row) => row.path), ...meta.others.map((row) => row.path)];
			return meta.paths;
		}
		exports.LEASE_META_VERSION = LEASE_META_VERSION;
		exports.LEASE_TOOL_STATES = LEASE_TOOL_STATES;
		exports.LEASE_TOOLS = LEASE_TOOLS;
		exports.narrowLeaseMeta = narrowLeaseMeta;
		exports.colorOf = colorOf;
		exports.stateKey = stateKey;
		exports.argsRawOf = argsRawOf;
		exports.argsPaths = argsPaths;
		exports.argsRequestId = argsRequestId;
		exports.resultText = resultText;
		exports.errorText = errorText;
		exports.fallbackState = fallbackState;
		exports.shortPath = shortPath;
		exports.outcomePaths = outcomePaths;
		return module.exports;
	}
});
