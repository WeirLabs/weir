window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.notify-web.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Web notification delivery, the page half of "send as DeepSeek Harness".
		//
		// The host decides WHAT to notify and queues it; this engine long-polls the
		// host, shows each note as a web Notification (so macOS attributes it to
		// DeepSeek Harness itself), and ACKs what the browser did. It is a pure
		// executor: no classification, no merging, no scheduling beyond the poll
		// loop. Zero-dependency (the factory never calls require) so node:test can
		// drive it with fakes; every environment access goes through `env`.
		const PULL_PATH = "api/orrery-notify/web/pull";
		const ACK_PATH = "api/orrery-notify/web/ack";
		/** Backoff after a failed poll: never a hot loop against a host that is down. */
		const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];
		/**
		 * Result codes the host understands (src/notify/web-channel.js): shown,
		 * pending and suppressed are final; the rest make the host fall back to the
		 * system command.
		 */
		const RESULTS = ["shown", "pending", "suppressed", "blocked", "error", "threw", "unsupported"];
		/** Wait this long for the browser to confirm a show before reporting `pending`. */
		const SHOW_CONFIRM_MS = 2500;
		/**
		 * Is the DSH window in front of the user? Visible AND focused: a visible
		 * window with another app focused is "background" (the user is not looking
		 * at it), which is the situation notifications exist for.
		 */
		function isForeground(env) {
			const doc = env?.document;
			if (!doc) return false;
			return doc.visibilityState === "visible" && (typeof doc.hasFocus === "function" ? doc.hasFocus() : true);
		}
		/**
		 * Show one note. Returns a result code; never throws. `open` maps tag →
		 * the Notification currently showing, so a same-tag note CLOSES the old one
		 * first and is a genuinely new show (a replaced notification may otherwise
		 * not alert again on some systems, even with renotify).
		 */
		async function showNote(env, note, open) {
			const Ctor = env?.Notification;
			if (typeof Ctor !== "function") return "unsupported";
			try {
				if (note.foreground !== "always" && isForeground(env)) return "suppressed";
				let permission = Ctor.permission ?? "default";
				if (permission === "default" && typeof Ctor.requestPermission === "function") permission = await Ctor.requestPermission();
				if (permission !== "granted") return "blocked";
				if (note.tag && open.has(note.tag)) {
					try {
						open.get(note.tag).close();
					} catch {
						// closing a stale notification is best effort
					}
					open.delete(note.tag);
				}
				const options = { body: note.body, silent: note.sound === false };
				if (note.tag) {
					options.tag = note.tag;
					options.renotify = note.renotify === true;
				}
				const shown = new Ctor(note.title, options);
				if (note.tag) {
					open.set(note.tag, shown);
					shown.onclose = () => {
						if (open.get(note.tag) === shown) open.delete(note.tag);
					};
				}
				return await new Promise((resolve) => {
					let settled = false;
					const done = (result) => {
						if (settled) return;
						settled = true;
						resolve(result);
					};
					shown.onshow = () => done("shown");
					shown.onerror = () => done("error");
					// Some shells never fire show/error: do not claim a success we cannot see.
					(env.setTimeout ?? globalThis.setTimeout)(() => done("pending"), SHOW_CONFIRM_MS);
				});
			} catch {
				return "threw";
			}
		}
		/**
		 * Start the long-poll loop. Returns { stop, stats }. `env` is injectable:
		 * { fetch, Notification, document, setTimeout, clearTimeout }.
		 */
		function startWebDelivery(env) {
			const doFetch = env.fetch ?? globalThis.fetch;
			const wait = env.setTimeout ?? globalThis.setTimeout;
			const unwait = env.clearTimeout ?? globalThis.clearTimeout;
			const open = new Map();
			const stats = { pulls: 0, shown: 0, failures: 0 };
			let stopped = false;
			let failures = 0;
			let controller = null;
			let sleeper = null;
			const post = (path, body, signal) => doFetch(path, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {}),
				signal
			}).then((response) => response.json());
			const sleep = (ms) => new Promise((resolve) => {
				sleeper = wait(resolve, ms);
			});
			async function loop() {
				while (!stopped) {
					try {
						controller = typeof AbortController === "function" ? new AbortController() : null;
						const payload = await post(PULL_PATH, {}, controller?.signal);
						stats.pulls++;
						if (!payload?.ok) throw new Error(payload?.error?.message ?? "pull failed");
						failures = 0;
						const pulled = payload.value;
						if (pulled && pulled.note) {
							const result = await showNote(env, pulled.note, open);
							if (result === "shown") stats.shown++;
							// The ACK must not be able to wedge the loop.
							post(ACK_PATH, { id: pulled.id, result: RESULTS.includes(result) ? result : "error" }).catch(() => {
								stats.failures++;
							});
						}
					} catch {
						if (stopped) return;
						stats.failures++;
						await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]);
						failures++;
					}
				}
			}
			loop();
			return {
				stats,
				stop() {
					stopped = true;
					controller?.abort?.();
					if (sleeper !== null) unwait(sleeper);
					for (const shown of open.values()) {
						try {
							shown.close();
						} catch {
							// ignore
						}
					}
					open.clear();
				}
			};
		}
		exports.RESULTS = RESULTS;
		exports.BACKOFF_MS = BACKOFF_MS;
		exports.isForeground = isForeground;
		exports.showNote = showNote;
		exports.startWebDelivery = startWebDelivery;
		return module.exports;
	}
});
