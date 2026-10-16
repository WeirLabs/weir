window.__ModuleLoader__.load({
	id: "weir-harness",
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
		/** Validity of the stored lspServers JSON: blank is fine (unset), otherwise
		 * it must parse to a non-array object. jsonToLspServers keeps its
		 * invalid→{} degradation; this helper only surfaces the malformed state. */
		function lspServersJsonValid(raw) {
			if (!raw || !raw.trim()) return true;
			try {
				const parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
			} catch {
				return false;
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
				lspManager: "Manage LSP services",
				lspManagerHint: "Check which language servers are installed and install the missing ones from the community catalog.",
				lspManagerLoading: "Loading…",
				lspManagerFailed: "The LSP manager failed; check the runtime log.",
				lspManagerUnavailable: "LSP management endpoints unavailable in this deployment:",
				lspManagerRetry: "Retry",
				lspManagerInstall: "Install",
				lspManagerCancel: "Cancel",
				lspManagerConfirmInstall: "Run install",
				lspManagerInstalling: "Installing…",
				lspManagerInstalled: "Installed",
				lspManagerMissing: "Not installed",
				lspManagerExitCode: "Exit code",
				lspManagerTimedOut: "(timed out)",
				lspManagerCustom: "Custom servers",
				lspManagerCustomHint: "Add your own language servers; saved with the settings and detected on the next status load.",
				lspManagerAddServer: "Add server",
				lspManagerRemove: "Remove",
				lspManagerFamily: "family name",
				lspManagerCommand: "command",
				lspManagerArgs: "args (space separated)",
				lspManagerInstallCmd: "install command (optional)",
				lspManagerPendingStatus: "detected after save",
				lspManagerInstallerMissing: "Installer unavailable: install it first, then retry.",
				lspManagerInvalidJson: "The stored custom-servers JSON is malformed; the panel opened with an empty list — saving replaces the stored value.",
				lspFamily_typescript: "TypeScript",
				lspFamily_python: "Python",
				lspFamily_go: "Go",
				lspFamily_rust: "Rust",
				lspFamily_json: "JSON",
				lspFamily_html: "HTML",
				lspFamily_css: "CSS",
				lspFamily_markdown: "Markdown",
				lspFamily_bash: "Bash",
				lspFamily_dockerfile: "Dockerfile",
				lspFamily_yaml: "YAML",
				lspFamily_lua: "Lua",
				lspFamily_cpp: "C/C++",
			},
			zh: {
				lspManager: "管理 LSP 服务",
				lspManagerHint: "查看各语言服务器安装状态，一键安装缺失的社区服务器。",
				lspManagerLoading: "加载中…",
				lspManagerFailed: "LSP 管理面板异常，请查看运行时日志。",
				lspManagerUnavailable: "此部署不提供 LSP 管理端点：",
				lspManagerRetry: "重试",
				lspManagerInstall: "安装",
				lspManagerCancel: "取消",
				lspManagerConfirmInstall: "确认安装",
				lspManagerInstalling: "安装中…",
				lspManagerInstalled: "已安装",
				lspManagerMissing: "未安装",
				lspManagerExitCode: "退出码",
				lspManagerTimedOut: "（超时）",
				lspManagerCustom: "自定义服务器",
				lspManagerCustomHint: "添加你自己的语言服务器；随设置保存，下次状态加载时检测。",
				lspManagerAddServer: "添加服务器",
				lspManagerRemove: "删除",
				lspManagerFamily: "族名",
				lspManagerCommand: "命令",
				lspManagerArgs: "参数（空格分隔）",
				lspManagerInstallCmd: "安装命令（可空）",
				lspManagerPendingStatus: "保存后检测",
				lspManagerInstallerMissing: "安装器不可用：请先安装安装器，再重试。",
				lspManagerInvalidJson: "已保存的自定义服务器 JSON 格式有误；面板已以空列表打开——保存将覆盖该值。",
				lspFamily_typescript: "TypeScript",
				lspFamily_python: "Python",
				lspFamily_go: "Go",
				lspFamily_rust: "Rust",
				lspFamily_json: "JSON",
				lspFamily_html: "HTML",
				lspFamily_css: "CSS",
				lspFamily_markdown: "Markdown",
				lspFamily_bash: "Bash",
				lspFamily_dockerfile: "Dockerfile",
				lspFamily_yaml: "YAML",
				lspFamily_lua: "Lua",
				lspFamily_cpp: "C/C++",
			},
		};

		exports.dictionaries = dictionaries;
		exports.jsonToLspServers = jsonToLspServers;
		exports.lspServersJsonValid = lspServersJsonValid;
		exports.lspServersToJson = lspServersToJson;
		exports.splitInstallCommand = splitInstallCommand;
		return module.exports;
	}
});
