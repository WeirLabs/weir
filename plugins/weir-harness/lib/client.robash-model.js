window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.robash-model.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Zero-dependency view-model chunk: the factory never calls require.
		/** Parse a stored robash whitelist JSON into a string list (invalid → null). */
		function jsonToStringList(raw) {
			if (typeof raw !== "string" || !raw.trim()) return null;
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return null;
			}
			if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) return null;
			return parsed;
		}
		/** Open-state decision for the list editor: blank (unset at every layer)
		 * and malformed stored values both open with an EMPTY staged list — no
		 * stored state may strand the field uneditable; `invalid` distinguishes
		 * malformed (show the hint) from merely unset (no hint). */
		function robashEditorOpenState(text) {
			const parsed = jsonToStringList(text);
			const blank = typeof text !== "string" || text.trim() === "";
			return { list: parsed ?? [], invalid: !blank && parsed === null, parsed };
		}
		/** Synthesize the stored JSON from a staged string list (blank entries dropped). */
		function stringListToJson(list) {
			return JSON.stringify((list ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
		}
		exports.jsonToStringList = jsonToStringList;
		exports.robashEditorOpenState = robashEditorOpenState;
		exports.stringListToJson = stringListToJson;
		return module.exports;
	}
});
