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
				chainAgent_finder: "Finder",
				chainAgent_finder_desc: "Contextual codebase search: answers \"where is X?\" and \"find the code that does Z\". Read-only, fast, parallel-first.",
				chainAgent_scholar: "Scholar",
				chainAgent_scholar_desc: "Documentation and OSS research: official docs, library APIs, best practices, real-world usage. Read-only.",
				chainAgent_advisor: "Advisor",
				chainAgent_advisor_desc: "Architecture and design advisor: module boundaries, decomposition, trade-offs. Read-only, high reasoning.",
				chainAgentPanelHint: "One row per curated agent; empty inherits the caller's route, fallbacks are tried in order.",
				chainEdit: "Edit",
				chainPanelHint: "One row per category: Edit picks the models, fallbacks are tried in order; an empty row follows the session model.",
				chainSave: "Save",
				chainCancel: "Cancel",
				chainAddRung: "Add fallback",
				chainRemove: "Remove",
				chainClear: "Clear (inherit)",
				chainCategory_quick: "Quick",
				chainCategory_quick_desc: "Trivial mechanical work: single-file changes, typo fixes, boilerplate.",
				chainCategory_deep: "Deep",
				chainCategory_deep_desc: "One goal, one deliverable: debugging, cross-module work, subtle logic.",
				"chainCategory_deep-plus": "Deep plus",
				"chainCategory_deep-plus_desc": "Escalation lane: trade-offs, contracts, invariants evidence cannot settle.",
				chainCategory_visual: "Visual",
				chainCategory_visual_desc: "Frontend, UI/UX, styling, animation, layout.",
				chainCategory_writing: "Writing",
				chainCategory_writing_desc: "Documentation, prose, technical writing, README and guides.",
				"chainCategory_general-low": "General (light)",
				"chainCategory_general-low_desc": "Small tasks that fit no other category.",
				"chainCategory_general-high": "General (standard)",
				"chainCategory_general-high_desc": "Standard features spanning a few files with known patterns.",
				chainCategory_artistry: "Artistry",
				chainCategory_artistry_desc: "Highly creative or artistic tasks, novel ideas, design exploration.",
				chainCategory_architect: "Architect",
				chainCategory_architect_desc: "Advisory architecture consult: boundaries, decomposition, trade-offs (read-only).",
			},
			zh: {
				chainAgent_finder: "finder（检索）",
				chainAgent_finder_desc: "代码库上下文检索：回答「X 在哪里」「做 Z 的代码在哪」。只读、快速、并行优先。",
				chainAgent_scholar: "scholar（调研）",
				chainAgent_scholar_desc: "文档与 OSS 调研：官方文档、库 API、最佳实践、真实用法。只读。",
				chainAgent_advisor: "advisor（架构）",
				chainAgent_advisor_desc: "架构与设计顾问：模块边界、拆分、权衡。只读、高推理。",
				chainAgentPanelHint: "每个精选代理一行；留空继承调用方路由，备选按序回退。",
				chainEdit: "编辑",
				chainPanelHint: "每个类别一行：点「编辑」挑选模型，可添加备选按序回退；留空的类别跟随会话模型。",
				chainSave: "保存",
				chainCancel: "取消",
				chainAddRung: "添加备选",
				chainRemove: "删除",
				chainClear: "清空（跟随会话）",
				chainCategory_quick: "quick（快活）",
				chainCategory_quick_desc: "机械性小活：单文件修改、错别字、样板代码。",
				chainCategory_deep: "deep（攻坚）",
				chainCategory_deep_desc: "一个目标一个交付物：调试、跨模块、微妙逻辑。",
				"chainCategory_deep-plus": "deep-plus（升级）",
				"chainCategory_deep-plus_desc": "升级车道：证据无法定夺的权衡、契约、不变量。",
				chainCategory_visual: "visual（视觉）",
				chainCategory_visual_desc: "前端、UI/UX、样式、动画、布局。",
				chainCategory_writing: "writing（写作）",
				chainCategory_writing_desc: "文档、散文、技术写作、README 与指南。",
				"chainCategory_general-low": "general-low（通用·轻量）",
				"chainCategory_general-low_desc": "不属于任何专业类别的小任务。",
				"chainCategory_general-high": "general-high（通用·标准）",
				"chainCategory_general-high_desc": "跨几个文件、有既定模式的标准特性。",
				chainCategory_artistry: "artistry（艺术）",
				chainCategory_artistry_desc: "高度创意或艺术性任务、新颖想法、设计探索。",
				chainCategory_architect: "architect（架构）",
				chainCategory_architect_desc: "咨询式架构评估：模块边界、拆分、权衡（只读）。",
			},
		};

		exports.dictionaries = dictionaries;
		exports.CHAIN_CATEGORIES = CHAIN_CATEGORIES;
		exports.jsonToChains = jsonToChains;
		exports.chainsToJson = chainsToJson;
		return module.exports;
	}
});
