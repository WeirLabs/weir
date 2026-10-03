window.__ModuleLoader__.load({
	id: "orrery-harness",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// Orrery client, browser half — composition root: synchronously
		// registers the en/zh dictionaries, the inject declarations, and the
		// slot wrappers for every lazily delivered surface (settings page,
		// composer LSP toggle, hash_edit conversation view). Each wrapper fans
		// out one Promise.all over package-local require.async chunks
		// (lib/client.*.js); the feature code lives in those chunks.
		const ORRERY_NS = "orrery-settings";
		// Local bus: settings saves bump a revision so the open session's
		// LSP toggle re-checks command availability (capability gate flipped)
		// without a reload.
		const settingsBus = (() => {
			const listeners = new Set();
			return {
				subscribe(callback) {
					listeners.add(callback);
					return () => listeners.delete(callback);
				},
				notify() {
					for (const callback of listeners) callback();
				}
			};
		})();
		const en = {
			title: "Orrery",
			description: "One-stop configuration for the Orrery preset: intent classification, model chains, continuation, context pressure, editing, read-only bash, and LSP.",
			loading: "Loading Orrery settings…",
			loadFailed: "Orrery settings could not be loaded:",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			save: "Save",
			saving: "Saving…",
			overridden: "Overridden",
			reset: "Reset to default",
			invalidValue: "Enter a value this field accepts, or leave blank to use the default.",
			catalogLoading: "Loading providers…",
			pickerModel: "Model",
			pickerEffort: "Reasoning",
			effortProviderDefault: "Provider default",
			catalogFailed: "Provider catalog unavailable; enter provider and model manually.",
			providerEmpty: "Select a provider",
			modelEmpty: "Select a model",
			groupIntent: "Intent",
			groupDelegate: "Delegation",
			groupTodo: "Continuation",
			groupGuard: "Context pressure",
			groupEditing: "Editing",
			groupWorktree: "Worktree lanes",
			groupRobash: "Read-only bash",
			groupLsp: "LSP",
			intentGateClassifierOptionRegex: "regex",
			intentGateClassifierOptionLlm: "llm",
			intentGateClassifierOptionJev: "jev",
			intentGateClassifier: "Intent classifier",
			intentGateClassifierHint: "regex (default, zero cost), llm (sidecar semantic classification), jev (experimental, off by default).",
			intentGateProvider: "Classifier provider (llm mode)",
			intentGateProviderHint: "Sidecar route override; blank follows the session route.",
			intentGateModel: "Classifier model (llm mode)",
			intentGateModelHint: "Sidecar model override; blank follows the session route.",
			intentGateReasoningEffort: "Classifier reasoning effort (llm mode)",
			intentGateReasoningEffortHint: "Sidecar reasoning-effort override; blank follows the model default.",
			intentGateTimeoutMs: "Classifier timeout (ms)",
			intentGateTimeoutMsHint: "Classification fails open to the regex result on timeout.",
			jevEndpoint: "Jev endpoint",
			jevEndpointHint: "Jev decisions endpoint (experimental mode).",
			jevModel: "Jev model",
			jevModelHint: "Jev model name (experimental mode).",
			jevApiKeyEnv: "Jev API key env var",
			jevApiKeyEnvHint: "Environment variable name holding the Jev API key (the key itself never enters config).",
			delegateCategoryChains: "Category model chains (JSON)",
			delegateCategoryChainsHint: "Which model each category's children run on, edited visually; rungs fall back in order.",
			delegateAgentChains: "Agent model chains (JSON)",
			delegateAgentChainsHint: "Which model each curated agent runs on, edited visually; an empty lane inherits the caller route.",
			delegateDisabledCategories: "Disabled categories",
			delegateDisabledCategoriesHint: "Pick the categories to disable from the registry list: disabled categories leave the delegate target list and cannot be delegated to. Append-only — a registry-level disable always stays in effect and cannot be cleared from here; unknown names are no longer reachable through this control.",
			disabledCategoriesCount: "disabled",
			disabledCategoriesPanelHint: "One switch per category. Saving writes exactly the switched-on names; switching everything off saves an empty list, which the server reads as \"nothing disabled\".",
			disabledCategoriesInvalid: "The stored value is not a JSON string array; the editor opened with every category off — saving replaces the stored value.",
			chainAgent_finder: "Finder",
			chainAgent_finder_desc: "Contextual codebase search: answers \"where is X?\" and \"find the code that does Z\". Read-only, fast, parallel-first.",
			chainAgent_scholar: "Scholar",
			chainAgent_scholar_desc: "Documentation and OSS research: official docs, library APIs, best practices, real-world usage. Read-only.",
			chainAgent_advisor: "Advisor",
			chainAgent_advisor_desc: "Architecture and design advisor: module boundaries, decomposition, trade-offs. Read-only, high reasoning.",
			chainAgentPanelHint: "Pick models per curated-agent lane; an empty lane inherits the caller route. Rungs fall back in order.",
			chainEdit: "Edit",
			chainPanelHint: "Pick models per category lane; an empty lane inherits the session route. Rungs fall back in order.",
			chainSave: "Save",
			chainCancel: "Cancel",
			chainAddRung: "Add rung",
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
			"chainCategory_general-low": "General (low)",
			"chainCategory_general-low_desc": "Small tasks that fit no other category.",
			"chainCategory_general-high": "General (high)",
			"chainCategory_general-high_desc": "Standard features spanning a few files with known patterns.",
			chainCategory_artistry: "Artistry",
			chainCategory_artistry_desc: "Highly creative or artistic tasks, novel ideas, design exploration.",
			chainCategory_architect: "Architect",
			chainCategory_architect_desc: "Advisory architecture consult: boundaries, decomposition, trade-offs (read-only).",
			supervisionMaxRetries: "Supervision retry cap",
			supervisionMaxRetriesHint: "Supervised continuation retry cap.",
			supervisionInitialBackoffMs: "Supervision initial backoff (ms)",
			supervisionInitialBackoffMsHint: "Supervised retry initial backoff.",
			supervisionMaxBackoffMs: "Supervision backoff cap (ms)",
			supervisionMaxBackoffMsHint: "Supervised retry backoff cap.",
			todoEnabled: "Todo continuation",
			todoEnabledHint: "Todo continuation driver switch (true/false).",
			todoMaxConsecutive: "Auto-continuation cap",
			todoMaxConsecutiveHint: "Auto-continuation cap without user input.",
			todoErrorRetryMax: "Provider-error retry cap",
			todoErrorRetryMaxHint: "Provider-error retry cap.",
			todoErrorBackoffBaseMs: "Provider-error initial backoff (ms)",
			todoErrorBackoffBaseMsHint: "Provider-error retry initial backoff.",
			todoErrorBackoffCapMs: "Provider-error backoff cap (ms)",
			todoErrorBackoffCapMsHint: "Provider-error retry backoff cap.",
			guardEnabled: "Context pressure guard",
			guardEnabledHint: "Context pressure guard switch (true/false).",
			guardSoftThreshold: "Soft pressure threshold",
			guardSoftThresholdHint: "Soft pressure threshold (advisory).",
			guardHardThreshold: "Hard pressure threshold",
			guardHardThresholdHint: "Hard pressure threshold (forced compaction).",
			hashlineHideStockEdit: "Anchor editing only",
			hashlineHideStockEditHint: "Hide the stock edit tool, leaving hash_edit as the only editor (true/false).",
			editLockEnabled: "Edit Lock (experimental)",
			editLockLabel: "Edit Lock",
			editLockTitle: "Files this session is editing",
			editLockPanelTitle: "Edit Lock",
			editLockLoading: "Loading…",
			editLockRefresh: "Refresh",
			editLockStop: "Revoke editing",
			editLockRevokeConfirm: "Revoke now — the assistant stops editing until you continue",
			editLockResume: "Continue editing",
			editLockConfirmAll: "Continue with these files",
			editLockReleaseAll: "Release all files now",
			editLockDetails: "Technical details",
			editLockOwnerOther: "Another session",
			editLockHoldUntil: "until {time}",
			editLockRecovery: "The last turn failed; cleaning up (attempt {n}).",
			editLockState_idle: "Not editing any file",
			editLockState_editing: "Editing",
			editLockState_holding: "Files kept for this session",
			editLockState_confirm: "Waiting for you to continue",
			editLockState_stopped: "Editing stopped",
			editLockState_attention: "Needs your attention",
			editLockState_unavailable: "Edit Lock is starting",
			editLockState_failed: "Edit Lock is unavailable; edits are refused",
			editLockStatus_active: "editing",
			"editLockStatus_user-interrupted": "stopped",
			"editLockStatus_pending-confirmation": "waiting",
			editLockStatus_abnormal: "needs attention",
			editLockRow_release: "Release",
			editLockRow_confirm: "Continue",
			editLockRow_unlock: "Unlock",
			editLockRow_unlockConfirm: "Unlock now — the other session loses this file",
			editLockEnabledHint: "Lets sessions take turns editing the same files instead of overwriting each other. Applies after restarting DeepSeek Harness.",
			editLockHoldDefaultMinutes: "Edit Lock: how long files stay reserved after a turn ends when the assistant gives no period",
			editLockHoldSingleMaxMinutes: "Edit Lock: most minutes one reservation may last",
			editLockHoldCumulativeMaxMinutes: "Edit Lock: total minutes one batch of files may stay reserved after a turn ends",
			editLockNudgeAttempts: "Edit Lock: how many times a finished turn is continued to settle left-over files",
			editLockNudgeFallback: "Edit Lock: what happens when those reminders run out (release / abnormal)",
			editLockHoldDefaultMinutesHint: "Minutes a file stays reserved after a turn ends when the assistant gives no period (default 30).",
			editLockHoldSingleMaxMinutesHint: "Upper bound for one reservation request, in minutes (default 30).",
			editLockHoldCumulativeMaxMinutesHint: "Total minutes one batch of files may stay reserved after turns end; once it is used up only releasing remains (default 120).",
			editLockNudgeAttemptsHint: "How many times a finished turn is continued to ask for left-over files to be released or reserved (default 2).",
			editLockNudgeFallbackHint: "release frees those files for other sessions; abnormal keeps them for you to sort out (default release).",
			worktreeEnabled: "Worktree lanes",
			worktreeEnabledHint: "Master switch: lane tools, the /worktree command, Worktree mode, and the Worktrees panel (true/false).",
			worktreeAutoSetup: "Install dependencies in new lanes",
			worktreeAutoSetupHint: "Run the repository's setup (or the lockfile's install command) when a lane opens (true/false).",
			worktreeMaxActive: "Active lane limit",
			worktreeMaxActiveHint: "How many lanes may be active per repository at once (default 4).",
			worktreeRoot: "Lane directory",
			worktreeRootHint: "Repository-relative folder for lanes (default .orrery/worktrees). It is ignored locally through .git/info/exclude; nothing tracked changes.",
			robashEnabled: "Read-only bash guard",
			robashEnabledHint: "Guarded read-only bash for curated agents, master switch (true/false).",
			robashAllow: "Allow list additions",
			robashAllowHint: "Command names to ADD to the read-only bash guard's product defaults. The defaults are always in effect; leaving this empty adds nothing (it cannot clear the defaults).",
			robashGitAllow: "Git subcommand additions",
			robashGitAllowHint: "Git subcommands to ADD to the read-only bash guard's product defaults (shared with the pwsh git gate). Leaving this empty adds nothing.",
			robashDeny: "Deny list additions",
			robashDenyHint: "Command names to ADD to the read-only bash guard's product deny list. The product defaults always stay denied; leaving this empty adds nothing.",
			robashPwshAllow: "Pwsh allow list additions",
			robashPwshAllowHint: "Command names to ADD to the read-only pwsh guard's product defaults (Windows read-only shell). The defaults are always in effect; leaving this empty adds nothing.",
			robashPwshDeny: "Pwsh deny list additions",
			robashPwshDenyHint: "Command names to ADD to the read-only pwsh guard's product deny list (Windows read-only shell). The product defaults always stay denied.",
			robashListEntries: "entries",
			robashListAdd: "Add entry",
			robashListInvalid: "The stored value is not a JSON string array; the editor opened with an empty list — saving replaces the stored value.",
			robashListPanelHint: "One command name per row. These entries are ADDED to the product defaults, which stay in effect — saving an empty list adds nothing and never removes a default.",
			robashListEntryPlaceholder: "command name",
			lspEnabled: "LSP semantic tools",
			lspEnabledHint: "Capability master switch: off removes LSP entirely; on adds a per-session switch in the composer bar (sessions start with LSP off).",
			lspIdleMs: "Server idle shutdown (ms)",
			lspIdleMsHint: "Idle servers shut down after this many milliseconds.",
			lspRequestTimeoutMs: "Request timeout (ms)",
			lspRequestTimeoutMsHint: "Per-request LSP timeout; timeouts are ordinary tool errors.",
			lspDiagnosticsWaitMs: "Diagnostics wait (ms)",
			lspDiagnosticsWaitMsHint: "How long to wait for published diagnostics before answering.",
			lspServers: "Custom LSP servers (JSON)",
			lspServersHint: "Custom language server definitions, managed visually in the LSP manager below.",
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
			lspToggleLabel: "LSP",
			lspToggleTitle: "Toggle LSP semantic tools for this session",
			hashEditTitle: "Edit file",
			hashEditPreparing: "Preparing edit",
			hashEditPlanned: "Planned edit — the applied diff appears when the call settles.",
			hashEditRunning: "Editing…",
			hashEditFailed: "Edit failed",
			hashEditStopped: "Interrupted",
			hashEditInput: "Input",
			hashEditOutput: "Output",
			hashEditCodeLabel: "diff",
			hashEditCopy: "Copy",
			hashEditCopied: "Copied",
			hashEditWrap: "Wrap lines",
			hashEditUnwrap: "Disable line wrap",
			hashEditCollapse: "Collapse",
			hashEditCollapseAria: "Collapse diff",
			hashEditExpand: "Show {count} more",
			hashEditExpandAria: "Expand {count} more rows"
		};
		const zh = {
			title: "Orrery",
			description: "Orrery 预设的一站式配置：意图分类、模型链、续推、上下文压力、编辑、只读 bash 与 LSP。",
			loading: "正在加载 Orrery 设置…",
			loadFailed: "Orrery 设置加载失败：",
			unavailable: "此插件未加载，当前无法配置。",
			readOnly: "此部署的设置为只读。",
			saveFailed: "部署未接受这些值，已保留供你修正。",
			save: "保存",
			saving: "保存中…",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalidValue: "请输入该字段接受的值，或留空以使用默认值。",
			catalogLoading: "正在加载 provider…",
			pickerModel: "模型",
			pickerEffort: "推理",
			effortProviderDefault: "跟随 provider 默认",
			catalogFailed: "Provider 目录不可用；可手动填写 provider 与模型。",
			providerEmpty: "选择 provider",
			modelEmpty: "选择模型",
			groupIntent: "意图分类",
			groupDelegate: "委派与模型链",
			groupTodo: "续推",
			groupGuard: "上下文压力",
			groupEditing: "编辑",
			groupWorktree: "Worktree 车道",
			groupRobash: "只读 bash",
			groupLsp: "LSP 语义工具",
			intentGateClassifierOptionRegex: "regex（正则）",
			intentGateClassifierOptionLlm: "llm（语义）",
			intentGateClassifierOptionJev: "jev（实验）",
			intentGateClassifier: "意图分类器",
			intentGateClassifierHint: "regex（默认，零成本）、llm（sidecar 语义分类）、jev（实验，默认关闭）。",
			intentGateProvider: "分类器 provider（llm 模式）",
			intentGateProviderHint: "sidecar 路由覆盖；留空跟随会话路由。",
			intentGateModel: "分类器 model（llm 模式）",
			intentGateModelHint: "sidecar 模型覆盖；留空跟随会话路由。",
			intentGateReasoningEffort: "分类器推理等级（llm 模式）",
			intentGateReasoningEffortHint: "sidecar 推理等级覆盖；留空跟随模型默认。",
			intentGateTimeoutMs: "分类器超时（毫秒）",
			intentGateTimeoutMsHint: "超时按正则结果 fail-open。",
			jevEndpoint: "Jev 端点",
			jevEndpointHint: "Jev 决策端点（实验模式）。",
			jevModel: "Jev 模型",
			jevModelHint: "Jev 模型名（实验模式）。",
			jevApiKeyEnv: "Jev 密钥环境变量名",
			jevApiKeyEnvHint: "持有 Jev API 密钥的环境变量名（密钥本身永不入配置）。",
			delegateCategoryChains: "类别模型链（JSON）",
			delegateCategoryChainsHint: "每个类别的子代理跑哪个模型，可视化配置；档位按序回退。",
			delegateAgentChains: "精选 agent 模型链（JSON）",
			delegateAgentChainsHint: "每个精选 agent 跑哪个模型，可视化配置；空车道继承调用方路由。",
			delegateDisabledCategories: "停用类别",
			delegateDisabledCategoriesHint: "从注册表清单勾选要停用的类别：停用类别从委派目标清单消失且不可派发。只能追加停用——注册表级 disabled 始终生效，无法在此清除；未知名已无法通过此控件写入。",
			disabledCategoriesCount: "个已停用",
			disabledCategoriesPanelHint: "每个类别一个开关。保存时只写入打开的类别名；全部关闭则保存空数组，服务器视为「未停用任何类别」。",
			disabledCategoriesInvalid: "已保存的值不是 JSON 字符串数组；编辑器已以全部关闭打开——保存将覆盖该值。",
			chainAgent_finder: "finder（检索）",
			chainAgent_finder_desc: "代码库上下文检索：回答「X 在哪里」「做 Z 的代码在哪」。只读、快速、并行优先。",
			chainAgent_scholar: "scholar（调研）",
			chainAgent_scholar_desc: "文档与 OSS 调研：官方文档、库 API、最佳实践、真实用法。只读。",
			chainAgent_advisor: "advisor（架构）",
			chainAgent_advisor_desc: "架构与设计顾问：模块边界、拆分、权衡。只读、高推理。",
			chainAgentPanelHint: "按精选 agent 车道挑选模型；空车道继承调用方路由。档位按序回退，首选不可用时用下一个。",
			chainEdit: "编辑",
			chainPanelHint: "按类别车道挑选模型；空车道继承会话路由。档位按序回退，首选不可用时用下一个。",
			chainSave: "保存",
			chainCancel: "取消",
			chainAddRung: "添加档位",
			chainRemove: "删除",
			chainClear: "清空（恢复继承）",
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
			"chainCategory_general-low": "general-low（通用低）",
			"chainCategory_general-low_desc": "不属于任何专业类别的小任务。",
			"chainCategory_general-high": "general-high（通用高）",
			"chainCategory_general-high_desc": "跨几个文件、有既定模式的标准特性。",
			chainCategory_artistry: "artistry（艺术）",
			chainCategory_artistry_desc: "高度创意或艺术性任务、新颖想法、设计探索。",
			chainCategory_architect: "architect（架构）",
			chainCategory_architect_desc: "咨询式架构评估：模块边界、拆分、权衡（只读）。",
			supervisionMaxRetries: "监督续推上限",
			supervisionMaxRetriesHint: "受监督续推连续上限。",
			supervisionInitialBackoffMs: "监督续推初始退避（毫秒）",
			supervisionInitialBackoffMsHint: "受监督重试初始退避。",
			supervisionMaxBackoffMs: "监督续推退避封顶（毫秒）",
			supervisionMaxBackoffMsHint: "受监督重试退避封顶。",
			todoEnabled: "todo 续推",
			todoEnabledHint: "todo 空转续推开关（true/false）。",
			todoMaxConsecutive: "自动续推上限",
			todoMaxConsecutiveHint: "无用户输入时的自动续推上限。",
			todoErrorRetryMax: "供应商错误重试上限",
			todoErrorRetryMaxHint: "供应商错误连续重试上限。",
			todoErrorBackoffBaseMs: "供应商错误初始退避（毫秒）",
			todoErrorBackoffBaseMsHint: "供应商错误重试初始退避。",
			todoErrorBackoffCapMs: "供应商错误退避封顶（毫秒）",
			todoErrorBackoffCapMsHint: "供应商错误重试退避封顶。",
			guardEnabled: "上下文压力守卫",
			guardEnabledHint: "上下文压力守卫开关（true/false）。",
			guardSoftThreshold: "软阈值",
			guardSoftThresholdHint: "上下文压力软阈值（提示）。",
			guardHardThreshold: "硬阈值",
			guardHardThresholdHint: "上下文压力硬阈值（强制压缩）。",
			hashlineHideStockEdit: "仅锚点编辑",
			hashlineHideStockEditHint: "隐藏 stock edit，hash_edit 成为唯一编辑器（true/false）。",
			editLockEnabled: "编辑锁（实验）",
			editLockLabel: "编辑锁",
			editLockTitle: "本会话正在编辑的文件",
			editLockPanelTitle: "编辑锁",
			editLockLoading: "加载中…",
			editLockRefresh: "刷新",
			editLockStop: "收回编辑权",
			editLockRevokeConfirm: "确认收回——助手将停止编辑，直到你点继续",
			editLockResume: "继续编辑",
			editLockConfirmAll: "继续编辑这些文件",
			editLockReleaseAll: "立即释放全部文件",
			editLockDetails: "技术细节",
			editLockOwnerOther: "其他会话",
			editLockHoldUntil: "保留至 {time}",
			editLockRecovery: "上一回合出错，正在清理（第 {n} 次）。",
			editLockState_idle: "未占用任何文件",
			editLockState_editing: "正在编辑",
			editLockState_holding: "文件为本会话保留",
			editLockState_confirm: "等你确认继续",
			editLockState_stopped: "编辑已停止",
			editLockState_attention: "需要你处理",
			editLockState_unavailable: "编辑锁启动中",
			editLockState_failed: "编辑锁不可用，编辑会被拒绝",
			editLockStatus_active: "编辑中",
			"editLockStatus_user-interrupted": "已停止",
			"editLockStatus_pending-confirmation": "待确认",
			editLockStatus_abnormal: "需处理",
			editLockRow_release: "释放",
			editLockRow_confirm: "继续",
			editLockRow_unlock: "解锁",
			editLockRow_unlockConfirm: "确认解锁——对方会失去这个文件",
			editLockEnabledHint: "让多个会话轮流编辑同一批文件，而不是相互覆盖。重启 DeepSeek Harness 后生效。",
			editLockHoldDefaultMinutes: "编辑锁：回合结束后保留文件多久（助手未指定时）",
			editLockHoldSingleMaxMinutes: "编辑锁：单次申请最多保留多少分钟",
			editLockHoldCumulativeMaxMinutes: "编辑锁：一批文件回合结束后累计最多保留多少分钟",
			editLockNudgeAttempts: "编辑锁：回合结束后最多提醒几次去处理未释放的文件",
			editLockNudgeFallback: "编辑锁：提醒用完后的处置（release 自动释放 / abnormal 转为人工处理）",
			editLockHoldDefaultMinutesHint: "助手未指定时，文件在回合结束后继续保留的分钟数（默认 30）。",
			editLockHoldSingleMaxMinutesHint: "单次保留申请的上限分钟数（默认 30）。",
			editLockHoldCumulativeMaxMinutesHint: "一批文件在回合结束后累计最多保留的分钟数；用尽后只能释放（默认 120）。",
			editLockNudgeAttemptsHint: "回合结束后最多提醒几次，去处理未释放的文件（默认 2）。",
			editLockNudgeFallbackHint: "release 把文件让给其他会话；abnormal 保留下来等你处理（默认 release）。",
			worktreeEnabled: "Worktree 车道",
			worktreeEnabledHint: "总开关：车道工具、/worktree 命令、Worktree 模式与 Worktrees 面板（true/false）。",
			worktreeAutoSetup: "新车道自动安装依赖",
			worktreeAutoSetupHint: "开车道时执行仓库配置的 setup，或按 lockfile 推导的安装命令（true/false）。",
			worktreeMaxActive: "活跃车道上限",
			worktreeMaxActiveHint: "每个仓库同时活跃的车道数上限（默认 4）。",
			worktreeRoot: "车道目录",
			worktreeRootHint: "仓库内存放车道的相对目录（默认 .orrery/worktrees），通过 .git/info/exclude 本地忽略，不改动任何入库文件。",
			robashEnabled: "只读 bash 守卫",
			robashEnabledHint: "精选只读代理的受守卫 bash 总开关（true/false）。",
			robashAllow: "允许列表",
			robashAllowHint: "追加到只读 bash 守卫产品默认项的命令名。默认项始终生效；留空表示不追加（无法清空默认项）。",
			robashGitAllow: "git 子命令允许列表",
			robashGitAllowHint: "追加到只读 bash 守卫产品默认项的 git 子命令（与 pwsh 的 git 门控共用）。留空表示不追加。",
			robashDeny: "拒绝列表",
			robashDenyHint: "追加到只读 bash 守卫产品拒绝列表的命令名。产品默认拒绝项始终生效；留空表示不追加。",
			robashPwshAllow: "pwsh 允许列表",
			robashPwshAllowHint: "追加到只读 pwsh 守卫产品默认项的命令名（Windows 只读 shell）。默认项始终生效；留空表示不追加。",
			robashPwshDeny: "pwsh 拒绝列表",
			robashPwshDenyHint: "追加到只读 pwsh 守卫产品拒绝列表的命令名（Windows 只读 shell）。产品默认拒绝项始终生效。",
			robashListEntries: "条目",
			robashListAdd: "添加条目",
			robashListInvalid: "已保存的值不是 JSON 字符串数组；编辑器已以空列表打开——保存将覆盖该值。",
			robashListPanelHint: "每行一个命令名。这些条目会追加到产品默认项，默认项始终生效——保存空列表只表示不追加，不会移除任何默认项。",
			robashListEntryPlaceholder: "命令名",
			lspEnabled: "LSP 语义工具",
			lspEnabledHint: "能力总开关：关闭则完全移除 LSP；开启后输入栏出现本会话开关（新会话默认关，按会话启用）。",
			lspIdleMs: "服务器空闲关停（毫秒）",
			lspIdleMsHint: "空闲的语言服务器超过该时长自动关停。",
			lspRequestTimeoutMs: "请求超时（毫秒）",
			lspRequestTimeoutMsHint: "单请求 LSP 超时；超时为普通工具错误。",
			lspDiagnosticsWaitMs: "诊断等待（毫秒）",
			lspDiagnosticsWaitMsHint: "回答前等待诊断发布的窗口时长。",
			lspServers: "自定义 LSP 服务器（JSON）",
			lspServersHint: "自定义语言服务器定义，经下方 LSP 管理面板可视化管理。",
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
			lspToggleLabel: "LSP",
			lspToggleTitle: "为本会话启用/禁用 LSP 语义工具",
			hashEditTitle: "编辑文件",
			hashEditPreparing: "准备编辑",
			hashEditPlanned: "计划编辑——调用完成后此处显示实际应用的 diff。",
			hashEditRunning: "编辑中…",
			hashEditFailed: "编辑失败",
			hashEditStopped: "已中断",
			hashEditInput: "输入",
			hashEditOutput: "输出",
			hashEditCodeLabel: "diff",
			hashEditCopy: "复制",
			hashEditCopied: "已复制",
			hashEditWrap: "自动换行",
			hashEditUnwrap: "取消换行",
			hashEditCollapse: "收起",
			hashEditCollapseAria: "收起 diff",
			hashEditExpand: "展开剩余 {count} 行",
			hashEditExpandAria: "展开剩余 {count} 行"
		};
		const NS = "settings.orrery";
		const SECTION_ID = "orrery-settings";
		const ITEM_SLOT = "settings.orrery.item";
		// ---- Package-local chunk wiring (composition root) ----
		// Same-package sync require is impossible in the ModuleLoader, so each
		// lazily delivered surface fans out one Promise.all over
		// require.async("./client.<name>.js") chunks. Success is memoized for the
		// factory's lifetime; a failure clears the memo so re-entering the
		// surface retries (the transport already retries a stale URL once — no
		// retry storm here).
		const lazyChunks = (load) => {
			let pending = null;
			return () => {
				if (pending === null) {
					const promise = load();
					pending = promise;
					promise.then(undefined, () => {
						if (pending === promise) pending = null;
					});
				}
				return pending;
			};
		};
		const loadHashEditChunks = lazyChunks(() => Promise.all([
			require.async("./client.hash-edit-view.js"),
			require.async("./client.hash-edit-model.js")
		]));
		/** Shared arrival state for one async chunk surface: null while in
		 * flight, { chunks } once arrived, { error } after a failed load. */
		const useChunkArrival = (load, enabled = true) => {
			const [arrival, setArrival] = react.useState(null);
			react.useEffect(() => {
				if (!enabled) return undefined;
				let alive = true;
				load().then(
					(chunks) => {
						if (alive) setArrival({ chunks });
					},
					(error) => {
						if (alive) setArrival({ error });
					}
				);
				return () => {
					alive = false;
				};
			}, [enabled]);
			return arrival;
		};
		// Pre-arrival (or failed-load) presentation of a hash_edit call: the
		// generic flattened input/output body — the same presentation the view
		// chunk's own metadata-absent degradation renders (same-package sync
		// require is impossible, so the tiny body is mirrored here, not shared).
		const hashEditFallbackHintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", padding: "4px 4px" };
		const hashEditFallbackPreStyle = { margin: 0, padding: "8px 10px", fontSize: "12px", lineHeight: "16px", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "240px", overflow: "auto", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)" };
		function HashEditFallbackBody(props) {
			const block = props.block;
			const t = props.t;
			const argsRaw = typeof block?.argsRaw === "string" ? block.argsRaw : typeof block?.call?.argsRaw === "string" ? block.call.argsRaw : null;
			const output = Array.isArray(block?.content) ? block.content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").filter((text) => text !== "").join("\n") : "";
			return react_jsx_runtime.jsxs("div", { "data-tool": "hash_edit", children: [
				argsRaw !== null ? react_jsx_runtime.jsxs("div", { children: [
					react_jsx_runtime.jsx("div", { style: hashEditFallbackHintStyle, children: t("hashEditInput") }),
					react_jsx_runtime.jsx("pre", { style: hashEditFallbackPreStyle, children: argsRaw })
				] }) : null,
				output !== "" ? react_jsx_runtime.jsxs("div", { children: [
					react_jsx_runtime.jsx("div", { style: hashEditFallbackHintStyle, children: t("hashEditOutput") }),
					react_jsx_runtime.jsx("pre", { style: hashEditFallbackPreStyle, children: output })
				] }) : null
			] });
		}
		/** Keyed toolview wrapper: renders the flattened fallback until the
		 * view+model chunks arrive, then the structured diff panel. */
		function HashEditToolView(props) {
			const arrival = useChunkArrival(loadHashEditChunks);
			if (arrival?.chunks) {
				const [view, model] = arrival.chunks;
				return react_jsx_runtime.jsx(view.HashEditRow, { ...props, model });
			}
			return react_jsx_runtime.jsx(HashEditFallbackBody, props);
		}
		const loadLspToggleChunk = lazyChunks(() => require.async("./client.lsp-toggle.js"));
		/** Composer-bar wrapper: renders nothing until the toggle chunk arrives
		 * (and nothing at all when the slot injected no session id — the
		 * capability gate's absence case, which must not pull the chunk). */
		function LspToggleWrapper(props) {
			const arrival = useChunkArrival(loadLspToggleChunk, typeof props.sessionId === "string" && props.sessionId !== "");
			if (!arrival?.chunks) return null;
			return react_jsx_runtime.jsx(arrival.chunks.LspToggle, { ...props, settingsBus });
		}
		const loadEditLockChunk = lazyChunks(() => require.async("./client.edit-lock-panel.js"));
		/** Composer-bar Edit Lock entry: nothing until its chunk arrives. */
		function EditLockWrapper(props) {
			const arrival = useChunkArrival(loadEditLockChunk, typeof props.sessionId === "string" && props.sessionId !== "");
			if (!arrival?.chunks) return null;
			return react_jsx_runtime.jsx(arrival.chunks.EditLockPanel, props);
		}
		/** Snapshot-store facade with a stable identity: the host caches slot
		 * inject faces on first render, so the settings card's hooks source must
		 * exist before the settings-page chunk arrives; attach() re-points the
		 * facade at the real controller store and notifies subscribers. */
		const createDeferredStore = () => {
			let inner = null;
			const listeners = new Set();
			const publish = () => {
				for (const listener of listeners) listener();
			};
			return {
				getSnapshot: () => inner?.getSnapshot(),
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				attach: (store) => {
					if (inner !== null || store == null || typeof store.subscribe !== "function") return;
					inner = store;
					inner.subscribe(publish);
					publish();
				}
			};
		};
		/** The failure reason one chunk-arrival error state names. */
		const describeChunkError = (error) => error instanceof Error ? error.message : String(error);
		const settingsLoadingStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", padding: "10px 0" };
		const settingsLoadFailedStyle = { ...settingsLoadingStyle, color: "var(--dsw-alias-state-business-danger, #d64545)" };
		// Verbatim copy of the lsp-toggle chunk's projection key: the composer
		// inject closures below read it, and same-package sync require is
		// impossible (the chunk owns the canonical export).
		const LSP_PROJECTION_KEY = "orreryLsp";
		const inject = ["slots", "locale", "configForms", "remote", "remote.session", "remote.commands"];
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-orrery-settings: dictionaries");
			// Per-session LSP toggle in the conversation composer bar (next to
			// the model selector; visible in blank and active sessions alike —
			// the session-header utilities slot only renders once the session
			// has content). Renders nothing while the `lsp` command is absent
			// (capability gate off).
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "orrery-lsp-toggle",
				order: 100,
				locale: NS,
				inject: (sessionId) => {
					if (!sessionId) return {};
					return {
						sessionId,
						toggleLsp: async (enabled) => {
							if (!ctx.remote.commands?.execute) return "unknown command: /lsp";
							const result = await ctx.remote.commands.execute(sessionId, `/lsp ${enabled ? "on" : "off"}`, []);
							if (!result.ok) return `${result.error.message} (${result.error.code})`;
							if (result.value === undefined) return "unknown command: /lsp";
							return null;
						},
						fetchLspState: async () => {
							if (!ctx.remote.session?.projections) return undefined;
							const result = await ctx.remote.session.projections({ sessionId });
							return result.ok ? result.value?.[LSP_PROJECTION_KEY]?.enabled : undefined;
						},
						commandsList: (sid) => {
							if (!ctx.remote.commands?.list) return Promise.resolve([]);
							return ctx.remote.commands.list(sid).then((result) => (result.ok ? result.value : []));
						}
					};
				}
			}, LspToggleWrapper)), "ui-orrery-settings: lsp session switch");
			// Keyed conversation view: hash_edit renders as a diff panel. Its own
			// effect scope: a slot-registration failure must not take down the
			// settings page or the LSP toggle. The wrapper registers under the
			// literal key (no chunk pull just to register); it renders the generic
			// flattened input/output body until the view+model chunks arrive.
			ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "hash_edit",
				locale: NS
			}, HashEditToolView)), "ui-orrery-settings: hash_edit toolview");
			// Edit Lock entry: renders only while the `edit-lock` command exists
			// (feature enabled). Each action is an explicit human /edit-lock run.
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "orrery-edit-lock",
				order: 101,
				locale: NS,
				inject: (sessionId) => {
					if (!sessionId) return {};
					return {
						sessionId,
						runEditLock: async (verb) => {
							if (!ctx.remote.commands?.execute) return { kind: "error", text: "unknown command: /edit-lock" };
							const result = await ctx.remote.commands.execute(sessionId, `/edit-lock ${verb}`, []);
							if (!result.ok) return { kind: "error", text: `${result.error.message} (${result.error.code})` };
							if (result.value === undefined) return { kind: "error", text: "unknown command: /edit-lock" };
							return result.value.result;
						},
						commandsList: (sid) => {
							if (!ctx.remote.commands?.list) return Promise.resolve([]);
							return ctx.remote.commands.list(sid).then((result) => (result.ok ? result.value : []));
						},
						// Structured view: read-only, never written to the conversation.
						fetchView: async () => {
							const response = await fetch("api/orrery-edit-lock/view", {
								method: "POST",
								credentials: "include",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ sessionId })
							});
							const payload = await response.json();
							if (!payload?.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
							return payload.value;
						}
					};
				}
			}, EditLockWrapper)), "ui-orrery-settings: edit lock entry");
			// Top-level Settings section (same place as dsh-web-kimi and the
			// built-in General/Models sections), with a nested item slot
			// hosting the form; plus a Plugins-page entry for discoverability.
			ctx.effect(() => ctx.configForms.whileServed([ORRERY_NS], () => {
				const scope = ctx.configForms.get(ORRERY_NS);
				// The settings page arrives as 8 package-local chunks in one
				// parallel batch (started lazily on the first surface open). The
				// form controller is constructed here on arrival — never inside the
				// react tree — and disposed with this serve generation; the slot
				// inject faces (cached by the host on first render) carry a
				// stable deferred store plus delegating actions.
				let controller = null;
				let serving = true;
				const deferredStore = createDeferredStore();
				const cardFace = {
					hooks: { orrerySettingsCard: deferredStore },
					edit: (field, text) => controller?.inject().edit(field, text),
					resetField: (field) => controller?.inject().resetField(field),
					save: (...args) => controller?.inject().save(...args),
					discard: () => controller?.inject().discard(),
					getSession: () => ctx.remote.session
				};
				let arrival = null;
				const ensureSettingsChunks = () => {
					if (arrival === null) {
						arrival = Promise.all([
							require.async("./client.settings-page.js"),
							require.async("./client.chain-editor.js"),
							require.async("./client.robash-editor.js"),
							require.async("./client.disabled-categories-editor.js"),
							require.async("./client.lsp-panel.js"),
							require.async("./client.chain-model.js"),
							require.async("./client.robash-model.js"),
							require.async("./client.lsp-model.js")
						]).then(([settingsPage, chainEditor, robashEditor, disabledCategoriesEditor, lspPanel, chainModel, robashModel, lspModel]) => {
							if (serving) {
								controller = new settingsPage.OrreryCardController(scope, { settingsBus, getSession: () => ctx.remote.session });
								deferredStore.attach(controller.store);
							}
							// Editor components pre-bound with their model chunks,
							// created once per arrival so their identity is stable
							// across re-renders (no remount of an open editor).
							const editors = {
								ChainEditorField: (editorProps) => react_jsx_runtime.jsx(chainEditor.ChainEditorField, { ...editorProps, model: chainModel }),
								RobashListEditorField: (editorProps) => react_jsx_runtime.jsx(robashEditor.RobashListEditorField, { ...editorProps, model: robashModel }),
								DisabledCategoriesEditorField: (editorProps) => react_jsx_runtime.jsx(disabledCategoriesEditor.DisabledCategoriesEditorField, editorProps),
								LspManagerField: (editorProps) => react_jsx_runtime.jsx(lspPanel.LspManagerField, { ...editorProps, model: lspModel })
							};
							return { settingsPage, editors };
						}, (error) => {
							// Failure is not memoized: re-entering the surface retries.
							arrival = null;
							throw error;
						});
					}
					return arrival;
				};
				function SettingsSectionWrapper(props) {
					const sectionArrival = useChunkArrival(ensureSettingsChunks);
					if (sectionArrival?.chunks) {
						return react_jsx_runtime.jsx(sectionArrival.chunks.settingsPage.OrrerySection, { renderSlot: props.renderSlot });
					}
					if (sectionArrival?.error) {
						return react_jsx_runtime.jsx("div", { style: settingsLoadFailedStyle, children: `${props.t("loadFailed")} ${describeChunkError(sectionArrival.error)}` });
					}
					return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: props.t("loading") });
				}
				function SettingsCardWrapper(props) {
					const cardArrival = useChunkArrival(ensureSettingsChunks, props.view !== "summary");
					if (props.view === "summary") return props.t("description");
					if (cardArrival?.chunks) {
						return react_jsx_runtime.jsx(cardArrival.chunks.settingsPage.OrreryCard, { ...props, editors: cardArrival.chunks.editors });
					}
					if (cardArrival?.error) {
						return react_jsx_runtime.jsx("div", { style: settingsLoadFailedStyle, children: `${props.t("loadFailed")} ${describeChunkError(cardArrival.error)}` });
					}
					return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: props.t("loading") });
				}
				const offSection = ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: SECTION_ID,
					order: 40,
					label: () => t("title"),
					locale: NS,
					children: { [ITEM_SLOT]: {
						kind: "list",
						scope: "root"
					} }
				}, SettingsSectionWrapper));
				const offItem = ctx.slots.inject(ITEM_SLOT, () => ctx.slots.register({
					name: ITEM_SLOT,
					id: "orrery-config",
					order: 0,
					locale: NS,
					inject: () => cardFace
				}, SettingsCardWrapper));
				const offPluginsItem = ctx.slots.inject("plugins.item", () => ctx.slots.register({
					name: "plugins.item",
					id: "orrery-settings",
					order: 30,
					label: () => t("title"),
					locale: NS,
					inject: () => cardFace
				}, SettingsCardWrapper));
				return () => {
					serving = false;
					controller?.dispose();
					offSection();
					offItem();
					offPluginsItem();
				};
			}), "ui-orrery-settings: page");
		}
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
