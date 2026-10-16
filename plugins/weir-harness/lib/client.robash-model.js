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
		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under "settings.weir.page"
		// inside a ctx.effect when this chunk arrives (lib/client.js
		// registerChunkDictionaries). Pinned by test/client.test.js's dictionary
		// union pin.
		// (The entry merges every settings-batch slice into the single "settings.weir.page"
		// registration — the whole settings card tree shares one t.)
		const dictionaries = {
			en: {
				robashListEntries: "entries",
				robashListAdd: "Add entry",
				robashListInvalid: "The stored value is not a valid command list; the editor opened empty — saving replaces it.",
				robashListPanelHint: "One command name per row; entries are added to the built-in list, which always applies — an empty list adds nothing.",
				robashListEntryPlaceholder: "command name",
			},
			zh: {
				robashListEntries: "条目",
				robashListAdd: "添加条目",
				robashListInvalid: "已保存的值不是有效的命令清单；编辑器已以空列表打开，保存将覆盖该值。",
				robashListPanelHint: "每行一个命令名；条目追加到内置清单，内置清单始终生效——空列表即不追加。",
				robashListEntryPlaceholder: "命令名",
			},
		};

		exports.dictionaries = dictionaries;
		exports.jsonToStringList = jsonToStringList;
		exports.robashEditorOpenState = robashEditorOpenState;
		exports.stringListToJson = stringListToJson;
		return module.exports;
	}
});
