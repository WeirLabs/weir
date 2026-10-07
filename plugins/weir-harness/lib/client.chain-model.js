window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.chain-model.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Zero-dependency view-model chunk: the factory never calls require.
		const CHAIN_CATEGORIES = ["quick", "deep", "deep-plus", "visual", "writing", "general-low", "general-high", "artistry", "architect"];
		/** Parse the stored JSON into a staged chains map (invalid → empty). */
		function jsonToChains(raw) {
			const empty = Object.fromEntries(CHAIN_CATEGORIES.map((name) => [name, []]));
			if (!raw || !raw.trim()) return empty;
			try {
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
				for (const [category, rungs] of Object.entries(parsed)) {
					if (!Array.isArray(rungs)) continue;
					empty[category] = rungs.map((rung) => ({
						provider: typeof rung?.provider === "string" ? rung.provider : "",
						model: typeof rung?.model === "string" ? rung.model : "",
						reasoningEffort: typeof rung?.reasoningEffort === "string" ? rung.reasoningEffort : ""
					}));
				}
			} catch {
				return empty;
			}
			return empty;
		}
		/** Synthesize the stored JSON from the staged chains map. */
		function chainsToJson(chains) {
			const out = {};
			for (const category of CHAIN_CATEGORIES) {
				const rungs = (chains?.[category] ?? []).filter((rung) => rung.provider && rung.model).map((rung) => ({
					provider: rung.provider,
					model: rung.model,
					...(rung.reasoningEffort ? { reasoningEffort: rung.reasoningEffort } : {})
				}));
				if (rungs.length > 0) out[category] = rungs;
			}
			return JSON.stringify(out, null, 2);
		}
		exports.CHAIN_CATEGORIES = CHAIN_CATEGORIES;
		exports.jsonToChains = jsonToChains;
		exports.chainsToJson = chainsToJson;
		return module.exports;
	}
});
