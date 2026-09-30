window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.lsp-model.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Zero-dependency view-model chunk: the factory never calls require.
		/** Parse the stored lspServers JSON into a plain map (invalid → empty). */
		function jsonToLspServers(raw) {
			if (!raw || !raw.trim()) return {};
			try {
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
				return parsed;
			} catch {
				return {};
			}
		}
		/** Synthesize the stored lspServers JSON from a plain map. */
		function lspServersToJson(map) {
			return JSON.stringify(map ?? {}, null, 2);
		}
		/** Split a shell-style command string into { command, args }. */
		function splitInstallCommand(text) {
			const parts = String(text ?? "").trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) return undefined;
			return { command: parts[0], args: parts.slice(1) };
		}
		exports.jsonToLspServers = jsonToLspServers;
		exports.lspServersToJson = lspServersToJson;
		exports.splitInstallCommand = splitInstallCommand;
		return module.exports;
	}
});
