// Weir client chunks: {"client.blackboard-model.js":"66fd9fc5438477d6d7ff156631f810a647ce352612a16051e987e8cd449bc4c9","client.blackboard-panel.js":"f961e0242dad7bf311829a25e265bf091925711b2fb9c19d2141997fbdf792b5","client.capability-badge.js":"6ffd703f498e0aa5cc8ac78f244402ec4ceee56d22d2a0e74c246799565776cc","client.capability-manager.js":"d8d1076e1b624c1dfc0834ad393c05fd7d9ee35004cd2fb34e5e5ba83f44c902","client.capability-model.js":"d0ad248c4a6defbc90f79c8c0e7904639779d47927874b8663c15c6cecb9d54a","client.capability-presets.js":"12ac8da3568d013abd76b67cfe473a329f4af2feaac9cd55a82d8881e5bc1017","client.chain-editor.js":"1e9a33bc68cabc43bc27b91ef83eab5028a33256596c147e15722d684687765b","client.chain-model.js":"81cdd04626900a63c38ccb3d9c4d117686c6f8a5da2ce9131b7aaf2f089dea77","client.disabled-categories-editor.js":"d4606a3172b47b25caf76fd64c8420a0079cd5f008bc67a9c71b3f146724e393","client.edit-lock-maintenance.js":"f5dca1a7658e2f536b52d265c49ab37bb5d2df6bcd6cf21826b843c9554311a8","client.edit-lock-panel.js":"54f7a21b79adc2b91803c61d92b0dad72d95d5d320fdf35433719cefd0a6c46d","client.hash-edit-model.js":"99df87cc3cc261abd160b83124b5ce726d0708f3c87eba9d58ad9e5a1f41bae9","client.hash-edit-view.js":"fc0f4dabddab9a48527553ad4232b3715e46e6863aab75e02ae2dcd6687265c2","client.lsp-model.js":"6b5bead2900289427a1ad723b9c7bea85af4c5547029e486c620ff94ece24775","client.lsp-panel.js":"39211da7658e0810abc0984b8bcbbfb4ee6a6299fedfd21649ded1ab39d1f291","client.lsp-toggle.js":"4d960984ccf1045c617be6d282665513a9cf636779563a276973b55036a59fb6","client.model-picker.js":"57f96826e00b37ae6d6474a6750f31b4e128e5fdb37e302875a41cdb2e18f14a","client.notify-permissions.js":"c1c103ce5976a4032b62e12b3b3ecb907a574159bf89512539c68c4886ea37a7","client.notify-web.js":"b2ccf831524be4e94c532324cb5495793d4424e3b78d6014d2a3f3d20e9c5871","client.robash-editor.js":"cd6a283b72cb02598e32ca4ce03a1b8de5f328ecdd1f5f920377524f3bdcbe1c","client.robash-model.js":"356ee7a679223bcd351720b2bc9e7300e390d97a60d1c8d75998706b4644923b","client.settings-page.js":"70db6e443a3c5d1d46d6d163874f5cacd7d0f4498665336127240e51a989412b","client.worktree-model.js":"819f1b00650aa0bb01140690b29b4a1f09b9d26e6bb73adc7efbb3a08e215766","client.worktree-view.js":"356c3f5f683b8509ae8679243a6460ca02957fd15e057a629b2ac4fdd12ed057"}
window.__ModuleLoader__.load({
	id: "weir-harness",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// Weir client, browser half — composition root: synchronously
		// registers the en/zh dictionaries, the inject declarations, and the
		// slot wrappers for every lazily delivered surface (settings page,
		// composer LSP toggle, hash_edit conversation view). Each wrapper fans
		// out one Promise.all over package-local require.async chunks
		// (lib/client.*.js); the feature code lives in those chunks.
		const WEIR_NS = "weir-settings";
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
			title: "Weir",
			description: "One-stop configuration for the Weir preset: intent classification, auto-continuation, context pressure, file editing, worktree lanes, read-only shell, LSP, and notifications; model routing is a separate page.",
			routingTitle: "Weir Model Routing",
			routingDescription: "Which models delegated children run on: per task category or curated agent, with ordered fallbacks.",
			loading: "Loading Weir settings…",
			loadFailed: "Weir settings could not be loaded:",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			readOnly: "This deployment stores settings read-only.",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			save: "Save",
			saving: "Saving…",
			pendingChanges: "{n} unsaved change(s)",
			discardChanges: "Discard",
			overridden: "Overridden",
			reset: "Reset to default",
			restartRequired: "Restart required",
			invalidValue: "Enter a value this field accepts, or leave blank to use the default.",
			restartReminderTitle: "Restart to apply",
			restartReminderBody: "These settings changed and take effect after restarting DeepSeek Harness. Everything else you saved is already live.",
			restartReminderDismiss: "Dismiss",
			restartReminderAcknowledge: "Got it",
			catalogLoading: "Loading providers…",
			pickerModel: "Model",
			pickerEffort: "Reasoning",
			effortProviderDefault: "Provider default",
			catalogFailed: "Provider catalog unavailable; enter provider and model manually.",
			providerEmpty: "Select a provider",
			modelEmpty: "Select a model",
			pickerUnavailable: "Model picker unavailable — reload the settings page to retry.",
			groupIntent: "Intent",
			groupTodo: "Auto-continuation",
			groupGuard: "Context pressure",
			groupEditing: "File editing",
			groupWorktree: "Worktree lanes",
			groupRobash: "Read-only shell",
			groupLsp: "LSP",
			groupNotify: "Notifications",
			groupRoutingCategories: "Task categories",
			groupRoutingAgents: "Curated agents",
			groupRoutingSupervision: "Supervision and retries",
			intentGateClassifierOptionRegex: "regex",
			intentGateClassifierOptionLlm: "llm",
			intentGateClassifierOptionJev: "jev",
			intentGateClassifier: "Intent classifier",
			intentGateClassifierHint: "How each message's intent is detected: regex uses built-in rules at zero cost (default); llm uses a small dedicated model; jev is experimental.",
			intentGateProvider: "Classifier model (llm mode)",
			intentGateProviderHint: "A dedicated model for semantic classification; blank follows the session model.",
			intentGateModel: "Classifier model name (llm mode)",
			intentGateModelHint: "Blank follows the session route's model.",
			intentGateReasoningEffort: "Classifier reasoning effort (llm mode)",
			intentGateReasoningEffortHint: "Blank follows the model default.",
			intentGateTimeoutMs: "Classifier timeout (ms)",
			intentGateTimeoutMsHint: "On timeout the rule-based result is used; the message is never blocked (default 1500).",
			jevEndpoint: "Jev endpoint",
			jevEndpointHint: "Jev decisions service URL (experimental mode).",
			jevModel: "Jev model",
			jevModelHint: "Model name for Jev (default jev).",
			jevApiKeyEnv: "Jev API key env var",
			jevApiKeyEnvHint: "Environment variable name holding the Jev API key; the key itself never enters config.",
			delegateCategoryChains: "Category models",
			delegateCategoryChainsHint: "The model children of each task category run on; add fallbacks tried in order, or leave empty to follow the session model.",
			delegateAgentChains: "Curated agent models",
			delegateAgentChainsHint: "The model each curated agent (finder, scholar, advisor) runs on; empty inherits the caller's route.",
			delegateDisabledCategories: "Disabled categories",
			delegateDisabledCategoriesHint: "Disabled categories leave the delegation list and can no longer be delegated to.",
			disabledCategoriesCount: "disabled",
			disabledCategoriesPanelHint: "One switch per category; saving writes exactly the switched-on names — all off disables nothing.",
			disabledCategoriesInvalid: "The stored value is not a valid category list; the editor opened with every category off — saving replaces it.",
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
			supervisionMaxRetries: "Child retry limit",
			supervisionMaxRetriesHint: "How many times a supervised child is continued when it ends without a report or keeps failing (default 5).",
			supervisionInitialBackoffMs: "Initial retry backoff (ms)",
			supervisionInitialBackoffMsHint: "Wait before the first retry; doubles each round (default 30000).",
			supervisionMaxBackoffMs: "Maximum retry backoff (ms)",
			supervisionMaxBackoffMsHint: "The retry wait never grows past this (default 300000).",
			todoEnabled: "Auto-continuation",
			todoEnabledHint: "With unfinished todos the assistant keeps going without waiting for your message (default on).",
			todoMaxConsecutive: "Continuation limit",
			todoMaxConsecutiveHint: "At most this many consecutive auto-continuations without your input (default 8).",
			todoErrorRetryMax: "Error retry limit",
			todoErrorRetryMaxHint: "How many times a provider error is retried automatically (default 5).",
			guardEnabled: "Context pressure guard",
			guardEnabledHint: "As the context fills up, asks the assistant to wrap up and requests compaction before it overflows; applies immediately.",
			guardSoftThreshold: "Advisory threshold",
			guardSoftThresholdHint: "Above this fill ratio the assistant is asked to wrap up (default 0.72; must stay below the compaction threshold).",
			guardHardThreshold: "Compaction threshold",
			guardHardThresholdHint: "Above this fill ratio compaction is requested (default 0.88; not a completion guarantee).",
			hashlineHideStockEdit: "Anchor editing only",
			hashlineHideStockEditHint: "Hides the built-in edit tool; file edits go through hash_edit anchors only.",
			editLockEnabled: "Edit Lock",
			editLockLabel: "Edit Lock",
			editLockTitle: "Files this session is editing",
			editLockPanelTitle: "Edit Lock",
			editLockLoading: "Loading…",
			editLockRefresh: "Refresh",
			editLockStop: "Revoke editing",
			editLockRevokeConfirm: "Revoke now — the assistant stops editing until you continue",
			editLockResume: "Continue editing",
			editLockRetry: "Retry connection",
			editLockRetryPending: "Retrying connection… Editing remains unavailable.",
			editLockBinding_serving: "This session is being edited in another attachment right now. Retry the connection when that turn finishes; retry does not continue editing.",
			editLockBinding_transferable: "This session's editing authority is held by an inactive attachment of this same session. It attaches here automatically when you send a message; Retry connection also takes it over now (retry does not continue editing).",
			editLockBinding_unknown: "The holder cannot be verified. Wait for its disconnect or confirmed process shutdown, then retry. Never remove a live publisher reservation.",
			"editLockBinding_cross-process": "The holder is in another process. Disconnect it or confirm that process has shut down before retrying.",
			"editLockBinding_revocation-failed": "Durable revocation was not acknowledged. Inspect Edit Lock maintenance; no replacement has been granted.",
			editLockConfirmAll: "Continue with these files",
			editLockReleaseAll: "Release all files now",
			editLockDetails: "Technical details",
			editLockOwnerOther: "Another session",
			editLockHoldUntil: "until {time}",
			editLockRecovery: "The last turn failed; cleaning up (attempt {n}).",
			editLockState_idle: "Not editing any file",
			editLockCleanupOnly: "Cleanup only: business edits and new ownership are blocked. Release files you no longer need; inspect the tool result before retrying edits.",
			editLockRecoveryUsage: "Recorded recovery: {attempts} attempts · {elapsed}s elapsed · {pause} min pause used.",
			editLockPauseUsageHint: "Pause usage is cumulative, not a live timer. Pause expiry re-checks recovery; it does not release locks or restore editing.",
			editLockPausedUntil: "Recovery paused until {time}.",
			editLockOwnershipHint: "Locks show ownership, not write outcomes. For failed edits, inspect the tool result; releasing locks does not undo changes.",
			editLockState_editing: "Editing",
			editLockState_holding: "Files kept for this session",
			editLockState_confirm: "Waiting for you to continue",
			editLockState_stopped: "Editing stopped",
			editLockState_attention: "Needs your attention",
			editLockState_revoked: "Editing revoked by an administrator",
			editLockRevokedHint: "An administrative recovery revoked this session's editing authority and released its locks. Continue editing here, or send any message — editing resumes automatically in a new execution epoch; the revocation record is preserved.",
			editLockColdRevokedAuto: "An administrative recovery revoked this session's editing authority and released its locks. Send any message in this session — the binding and editing resume automatically.",
			editLockColdRevokedManual: "An administrative recovery revoked this session's editing authority and released its locks. Send any message to activate the session, then continue editing from this panel.",
			editLockColdResumeAuto: "This session was restored after a restart and is stopped. Send any message — editing resumes automatically, with the files below confirmed again.",
			editLockColdResumeManual: "This session was restored after a restart and is stopped. Send any message to activate the session, then continue editing from this panel.",
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
			editLockEnabledHint: "Sessions take turns editing the same files instead of overwriting each other.",
			editLockOptOutWarning: "Edit Lock is set to off. After saving, restart DeepSeek Harness to apply the change. Once enforcement is off, ordinary editing is UNPROTECTED and can overwrite another session's work. Old fences and history are retained and may block files when you re-enable Edit Lock.",
			editLockAutoResume: "Message resumes editing",
			editLockAutoResumeHint: "After a session is stopped, sending any message restores its editing right and re-confirms its kept files (default on).",
			editLockStaleSweep: "Sweep stale locks",
			editLockStaleSweepHint: "Locks whose target file was deleted or moved are re-verified and released as you send messages (default on).",
			editLockMaint: "Edit Lock maintenance",
			editLockMaintHint: "Profile-wide enforcement status and read-only diagnostics.",
			editLockMaintFailed: "Edit Lock maintenance failed",
			editLockMaintLoading: "Loading…",
			editLockMaintUnavailable: "Maintenance data unavailable:",
			editLockMaintRetry: "Retry",
			editLockMaintRefresh: "Refresh",
			editLockMaintInspect: "Inspect",
			editLockMaintStateEnforced: "Enforced",
			editLockMaintStateEnforcedHint: "The switch is on and the Edit Lock manager is mounted in this process.",
			editLockMaintStateDisableRequested: "Disable requested — restart required",
			editLockMaintStateDisableRequestedHint: "You turned the switch off, but the manager is still mounted and enforcing. The change applies after restarting DeepSeek Harness.",
			editLockMaintStateEnableRequested: "Enable requested — restart required",
			editLockMaintStateEnableRequestedHint: "You turned the switch on, but no manager is mounted in this process. The change applies after restarting DeepSeek Harness.",
			editLockMaintStateDisabled: "Enforcement disabled",
			editLockMaintStateDisabledHint: "The switch is off and every recorded, fully installed row reports enforcement disabled.",
			editLockMaintStateUnknown: "Unknown",
			editLockMaintStateUnknownHint: "Mount evidence is absent, inconsistent, installing, disposing or failed. The saved value alone never proves enforcement or disablement.",
			editLockMaintRestart: "Applies after restarting DeepSeek Harness.",
			editLockMaintPinned: "This composition pins the Edit Lock row configuration; the settings switch does not govern it here.",
			editLockMaintScopeNote: "The switch is profile-wide: it covers every Weir session in this profile, not one workspace.",
			editLockMaintWarnKeepHistory: "Turning enforcement off does not clear unresolved operations, fences or history — turning it back on can block the same files again.",
			editLockMaintWarnUnlock: "An ordinary unlock frees one lock without validating content; it is not historical recovery and never settles an unknown publication.",
			editLockMaintOffRisk: "Edit Lock is not mounted. Ordinary edits are UNPROTECTED and can overwrite another session's work. Retained locks and fences do not block off-period edits; they may block files again after you re-enable and restart.",
			editLockMaintUnknownRisk: "Edit Lock mount status cannot be verified. If no manager is mounted, ordinary edits are UNPROTECTED and can overwrite another session's work. Do not treat retained fences as proof of current protection.",
			editLockMaintHistory: "Retained history — not current blocks",
			editLockMaintHistoryHint: "These old locks and publication fences remain on disk for inspection. Without a mounted manager they do not block ordinary edits; after re-enabling they may block files again. Online force release is unavailable here; separate offline administrator recovery remains available.",
			editLockMaintUnknownHistory: "Retained authority — current effect unverified",
			editLockMaintUnknownHistoryHint: "The saved value and old fences cannot establish whether a manager is mounted. Inspect this history read-only; online force release is unavailable until enforcement is verified. Separate offline administrator recovery remains available.",
			editLockMaintBlocked: "Initialization blocked",
			editLockMaintDomains: "Domains",
			editLockMaintNoDomains: "No live session reports an Edit Lock domain in this profile.",
			editLockMaintAuthorityYes: "authority present",
			editLockMaintAuthorityNo: "authority currently absent",
			editLockMaintReservation: "A publisher reservation is present: this or another Harness holds (or stranded) the publishing claim for this domain.",
			editLockMaintPresenceNone: "No authority directory is currently present. Prior initialization cannot be determined.",
			editLockMaintPresenceEmpty: "The authority directory is currently empty. Prior initialization cannot be determined.",
			editLockMaintPresenceJunk: "The authority directory has contents but no committed snapshot; the store would refuse to open it. Nothing was changed.",
			editLockMaintPresenceNotAFile: "snapshot.json is not a regular file; the store would refuse it. Nothing was changed.",
			editLockMaintPresenceCorrupt: "The authority image failed integrity validation and was left untouched — no automatic repair exists. Refusal:",
			editLockMaintPresenceUnreadable: "The authority could not be read:",
			editLockMaintCounts: "{sessions} session(s) · {locks} lock(s) · {operations} recorded operation(s)",
			editLockMaintUnresolved: "Unresolved operations",
			editLockMaintUnresolvedNone: "No unresolved operations.",
			editLockMaintRetained: "Retained locks (interrupted / abnormal / pending)",
			editLockMaintScopeFile: "one file",
			editLockMaintScopeSubtree: "a directory subtree",
			editLockMaintScopeDomain: "the whole work directory",
			editLockMaintScopeNone: "no recorded scope",
			editLockMaintRecoveries: "Online administrative recovery",
			editLockMaintRecoverHint: "Settle an interrupted owner's unknown publications in the running manager: one explicit click, no restart, no hash typing. The unknown outcome stays in history. If the scope changed since it was loaded, the manager refuses and the panel reloads it.",
			editLockMaintRecoverRoot: "Root",
			editLockMaintRecoverOwner: "Owner session",
			editLockMaintRecoverRevision: "Authority revision",
			editLockMaintRecoverOperations: "Unresolved operation IDs",
			editLockMaintRecoverRisk: "Risk you accept",
			editLockMaintRecoverDigest: "Confirmation digest",
			editLockMaintRecoverConfirm: "Settle this owner online",
			editLockMaintRecoverBusy: "Settling…",
			editLockMaintRecoverDone: "Settled at revision {revision}; admission is unblocked and the unknown outcome stays in history.",
			editLockMaintRecoverFailed: "Recovery not acknowledged:",
			worktreeEnabled: "Worktree lanes",
			worktreeEnabledHint: "Lets the assistant work in isolated git worktrees: lane tools, the /worktree command, and the lanes panel.",
			worktreeAutoSetup: "Auto-install in new lanes",
			worktreeAutoSetupHint: "Runs the repository's configured install command when a lane opens (default on).",
			worktreeMaxActive: "Active lane limit",
			worktreeMaxActiveHint: "At most this many active lanes per repository (default 4).",
			worktreeRoot: "Lane directory",
			worktreeRootHint: "Repository-relative directory holding lanes (default .weir/worktrees; locally git-ignored).",
			worktreeWatchTimeoutMinutes: "Lane watch timeout (minutes)",
			worktreeWatchTimeoutMinutesHint: "A lane-state watch expires with one notice after this long without a hit (default 360); existing watches keep their deadline.",
			worktreeAutoApprove: "Lane auto-approve",
			worktreeAutoApproveHint: "Default approval mode for new sessions: manual asks every time; auto-keep approves and keeps the branch; auto-clean also deletes it; /worktree approve overrides per session.",
			worktreeAutoApproveOptionManual: "manual",
			"worktreeAutoApproveOptionAuto-keep": "auto-keep",
			"worktreeAutoApproveOptionAuto-clean": "auto-clean",
			robashEnabled: "Read-only shell guard",
			robashEnabledHint: "Curated read-only agents (finder etc.) may only run allow-listed read-only commands (default on).",
			robashAllow: "Extra allowed commands",
			robashAllowHint: "Command names added on top of the built-in allow list; built-ins always apply, empty adds nothing.",
			robashGitAllow: "Extra allowed git subcommands",
			robashGitAllowHint: "Git subcommands added on top of the built-in list (shared with the pwsh gate); empty adds nothing.",
			robashDeny: "Extra denied commands",
			robashDenyHint: "Command names added on top of the built-in deny list; deny wins over allow.",
			robashPwshAllow: "Extra allowed pwsh commands",
			robashPwshAllowHint: "Additions to the Windows read-only pwsh allow list; built-ins always apply.",
			robashPwshDeny: "Extra denied pwsh commands",
			robashPwshDenyHint: "Additions to the Windows read-only pwsh deny list; deny wins over allow.",
			robashListEntries: "entries",
			robashListAdd: "Add entry",
			robashListInvalid: "The stored value is not a valid command list; the editor opened empty — saving replaces it.",
			robashListPanelHint: "One command name per row; entries are added to the built-in list, which always applies — an empty list adds nothing.",
			robashListEntryPlaceholder: "command name",
			lspEnabled: "LSP semantic tools",
			lspEnabledHint: "When on, each session can enable go-to-definition, find-references and friends from its composer switch (sessions start off).",
			lspServers: "Custom language servers",
			lspServersHint: "Add language servers beyond the built-in catalog, edited visually in the manager panel.",
			notifyEnabled: "System notifications",
			notifyEnabledHint: "Sends a system notification when a session needs you or a turn finishes (default on).",
			notifyOnComplete: "Notify on completion",
			notifyOnCompleteHint: "Notifies when a turn finishes and ran longer than the minimum below.",
			notifyOnAttention: "Notify when needed",
			notifyOnAttentionHint: "Notifies on approval requests, questions, plan reviews, and failed or stopped turns.",
			notifyMinTurnSeconds: "Minimum turn length (seconds)",
			notifyMinTurnSecondsHint: "A finished turn is only reported when it ran at least this long; 0 reports every turn (default 15).",
			notifySound: "Notification sound",
			notifySoundHint: "Plays the platform notification sound where supported.",
			notifyForeground: "When the window is in front",
			notifyForegroundHint: "Whether to notify while the window is in the foreground: don't notify (default) or always notify.",
			notifyForegroundOptionSkip: "Don't notify",
			notifyForegroundOptionAlways: "Always notify",
			notifyPermissions: "Notification permission",
			notifyPermissionsHint: "Check whether macOS lets these notifications through, and walk through allowing them.",
			notifyPermissionsOpen: "Manage",
			notifyPermTitle: "Notification permission",
			notifyPermDescription: "Notifications are shown by DeepSeek Harness itself, so macOS has to let DeepSeek Harness notify you.",
			notifyPermClose: "Close",
			notifyPermChecking: "Checking…",
			notifyPermRecheck: "Check again",
			notifyPermBestEffort: "This check reads macOS settings that Apple does not document, so treat it as a hint. Seeing the test notification is the real proof.",
			notifyPermFocusNote: "Focus / Do Not Disturb can still hold notifications back, and it cannot be checked from here.",
			notifyPermSendTest: "Send a test notification",
			notifyPermSending: "Sending…",
			notifyPermOpenSettings: "Open notification settings",
			notifyPermOpening: "Opening…",
			notifyPermOpenHint: "In the list, find “DeepSeek Harness”, turn on “Allow notifications”, and pick the Banners or Alerts style.",
			notifyPermWaiting: "Waiting for you to allow notifications… checking every 2 seconds.",
			notifyPermConfirm: "Did you see the test notification?",
			notifyPermSeenYes: "Yes, I saw it",
			notifyPermSeenNo: "No",
			notifyPermSeen: "All set — notifications will reach you.",
			notifyPermNotSeen: "Check that Focus / Do Not Disturb is off, that DeepSeek Harness's style is Banners or Alerts, and — if the window is in front — that \"When the window is in front\" is set to Always notify. Then try again.",
			notifyPermRetry: "Start over",
			notifyPermSendAgain: "Send another test",
			notifyPermError: "Something went wrong:",
			notifyPermManualPath: "You can do this by hand: System Settings → Notifications → DeepSeek Harness.",
			notifyPermDetails: "Technical details",
			notifyPermFailed: "The permission panel failed; check the runtime log.",
			"notifyPermState_granted": "Allowed",
			"notifyPermState_denied": "Not allowed",
			"notifyPermState_unknown": "Can't tell",
			"notifyPermReason_alerts-allowed": "Alerts are allowed for DeepSeek Harness.",
			"notifyPermReason_not-allowed": "Notifications are turned off for DeepSeek Harness.",
			"notifyPermReason_no-record": "macOS has no record of DeepSeek Harness yet. Send a test notification so it shows up in the list.",
			"notifyPermReason_default": "macOS has no explicit setting for DeepSeek Harness (it uses the system default), so this can't be told from here.",
			"notifyPermReason_unreadable": "The notification settings could not be read.",
			notifyWebUnsupported: "This page has no web Notification support, so DeepSeek Harness cannot notify directly.",
			notifyWebPermission: "Web notification permission",
			notifyWebDeniedHint: "This page was blocked from showing notifications and cannot ask again. Open System Settings → Notifications → DeepSeek Harness and turn notifications on.",
			"notifyWebPerm_granted": "Allowed",
			"notifyWebPerm_denied": "Blocked",
			"notifyWebPerm_default": "Not asked yet",
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
			lspToggleLabel: "LSP",
			lspToggleTitle: "Toggle LSP semantic tools for this session",
			worktreePillMode: "Worktree",
			worktreePillLanes: "Worktree",
			worktreePillCount: "{n} lane(s)",
			worktreePillAwaiting: "{n} awaiting approval",
			worktreePillTitle: "Worktree lanes — open the panel",
			worktreePillBaseMoved: "The main worktree left the lane base branch; check it out to land",
			worktreeModeLabel: "Worktree",
			worktreeModeTitle: "Optional discipline: lanes work without this mode. Turned on, the assistant stops editing files directly and every change goes through isolated lanes.",
			worktreeModeUnavailable: "Worktree mode unavailable:",
			worktreeApproveLabel: "Auto-approve",
			worktreeApproveTitle: "Lane auto-approve mode ({mode}): manual asks on every card; auto-keep merges/abandons without cards and removes the worktree but keeps the branch; auto-clean also deletes the branch. The new-session default lives in Settings › Worktree.",
			worktreeApproveOptionManual: "manual",
			worktreeApproveOptionAutoKeep: "keep",
			worktreeApproveOptionAutoClean: "clean",
			worktreeLoading: "Loading lanes…",
			worktreeLoadFailed: "The lane view could not be read.",
			worktreeUnavailable: "Worktree lanes are unavailable for this session.",
			worktreeDisabled: "Worktree lanes are switched off in Settings.",
			worktreeEmpty: "No active lanes. The assistant opens one with worktree_open.",
			worktreeEmptyTitle: "No active lanes",
			worktreeEmptyBody: "When the assistant needs an isolated workspace it opens one with worktree_open. Track checks, approve merges, and clean up here.",
			worktreeRefresh: "Refresh",
			worktreeConfigure: "Verification…",
			worktreeShowHistory: "History ({n})",
			worktreeHideHistory: "Hide history",
			worktreeVerificationOn: "verification: {n} command(s)",
			worktreeVerificationOff: "verification not enabled",
			worktreeExcludeOk: "locally ignored",
			worktreeExcludeMissing: "lane folder is not ignored yet",
			worktreeUnmanaged: "{n} worktree(s) under the lane folder are not managed by Weir",
			worktreeStaleData: "Showing the last data read; the refresh failed.",
			worktreeAheadBehind: "{ahead} ahead · {behind} behind",
			worktreeBaseMoved: "base moved",
			worktreeNextLabel: "next: {next}",
			worktreeViewDiff: "Changes",
			worktreeHideDiff: "Hide changes",
			worktreeDiffUnavailable: "changes unavailable",
			worktreeFiles: "{n} file(s)",
			worktreeExitCode: "exit {code}",
			worktreeNoChanges: "No changes against the base branch.",
			worktreeRecheck: "Re-check",
			worktreeRetrySetup: "Retry setup",
			worktreeSkipSetup: "Skip setup",
			worktreeLand: "Merge…",
			worktreeLandConfirm: "Confirm merge",
			worktreeAbandon: "Abandon…",
			worktreeAbandonConfirm: "Confirm abandon",
			worktreeCleanupWorktree: "Remove worktree",
			worktreeCleanupAll: "Remove worktree and branch",
			worktreeCleanupAllConfirm: "Confirm remove branch",
			worktreeCopyPath: "Copy path",
			worktreeActionUnavailable: "not available now",
			worktreeActionFailed: "This lane action is unavailable right now; try the /worktree command directly.",
			worktreeConflicts: "conflicts",
			worktreeMergeCommit: "merge commit",
			worktreeCleanup: "cleanup",
			worktreeConfigName: "name",
			worktreeConfigRun: "command",
			worktreeConfigChecks: "Verification commands",
			worktreeConfigSetup: "setup command (optional)",
			worktreeConfigAdd: "Add command",
			worktreeConfigRemove: "Remove",
			worktreeConfigSave: "Save",
			worktreeCancel: "Cancel",
			worktreeConfigHint: "Saved to this repository only (.weir/worktrees/.config.json, never committed). Commands run in a lane when it is checked.",
			worktreeInitParseFailed: "The repository configuration could not be read.",
			worktreeFlatInput: "Input",
			worktreeFlatOutput: "Output",
			worktreeTabLabel: "Worktrees",
			worktreeGuideTitle: "Worktree lanes",
			worktreeGuideDescription: "Lanes for this session: state, checks, merge, cleanup.",
			worktreeState_preparing: "preparing",
			worktreeState_setup_failed: "setup failed",
			worktreeState_ready: "ready",
			worktreeState_working: "working",
			worktreeState_dirty: "uncommitted changes",
			worktreeState_no_commits: "no commits",
			worktreeState_branch_moved: "branch moved",
			worktreeState_checking: "checking",
			worktreeState_check_failed: "check failed",
			worktreeState_landable: "ready to merge",
			worktreeState_conflicted: "conflicts",
			worktreeState_awaiting_approval: "awaiting approval",
			worktreeState_declined: "merge declined",
			worktreeState_landed: "merged",
			worktreeState_kept: "kept",
			worktreeState_cleaned: "cleaned up",
			worktreeState_abandoned: "abandoned",
			worktreeTool_worktree_open: "Open worktree lane",
			worktreeTool_worktree_check: "Check worktree lane",
			worktreeTool_worktree_land: "Merge worktree lane",
			worktreeTool_worktree_cleanup: "Worktree cleanup",
			worktreeTool_worktree_abandon: "Abandon worktree lane",
			worktreeTool_worktree_watch: "Watch worktree lane",
			worktreeWatchStates: "Watching for",
			worktreeWatchExpires: "until {time}",
			worktreeWatchHit: "hit immediately",
			worktreeWatching: "{n} watching",
			worktreeNext_delegate: "assign a worker to this lane",
			worktreeNext_worktree_check: "check the lane",
			worktreeNext_worktree_land: "merge the lane (asks you to approve)",
			worktreeNext_worktree_cleanup: "choose the cleanup",
			worktreeWait_lane_ready: "waiting for dependency setup",
			worktreeWait_child_settle: "waiting for the lane worker",
			worktreeWait_check_complete: "waiting for verification",
			worktreeWait_user: "waiting for your decision",
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
			hashEditExpandAria: "Expand {count} more rows",
			// Session capability Badge + manager (12.x, D3/D4): the chunks carry
			// the same strings as in-code fallbacks; these rows translate them.
			capabilityTabLabel: "Capabilities",
			capabilityGuideTitle: "Capabilities",
			capabilityGuideDescription: "Skills, MCP servers, and presets for this session.",
			"capability.badge": "{skills} skills · {mcp} MCP",
			"capability.unavailable.short": "Capabilities n/a",
			"capability.effectiveUnknown": "Applied count unknown — refresh and check Skill sources",
			"capability.effectiveUnknownShort": "Skills ? · MCP ?",
			"capability.effectiveUnknownDetail": "Accepted revision; effective capabilities cannot be verified. Refresh and check Skill sources. Draft kept; only Apply changes the session.",
			"capability.unknownOverwriteRisk": "Previous selection is unknown. Applying this draft may replace other accepted Skills and MCP servers. Review the full selection before confirming.",
			"capability.confirmUnknownOverwrite": "Confirm replacing unknown selection",
			"capability.loading": "Loading capabilities…",
			"capability.error": "Capabilities unavailable for this session.",
			"capability.unavailable": "Capabilities are unavailable in this session.",
			"capability.unsupported": "Unsupported: consistency conditions are not met on this host.",
			"capability.tab.skills": "Skills",
			"capability.tab.mcp": "MCP",
			"capability.tab.presets": "Presets",
			"capability.search": "Search",
			"capability.close": "Close",
			"capability.conflict": "conflict",
			"capability.sourceUnknown": "unknown source",
			"capability.sourceNumber": " · source ",
			"capability.sameNameWarning": "{name}: only one source can be enabled in this session. Uncheck one: {sources}.",
			"capability.unresolvedNameWarning": "{name}: legacy name has no chosen source. Choose an exact source or remove the name: {sources}.",
			"capability.unknownLegacyName": "{name}: no matching Skill in the current listing. Refresh the listing or remove this legacy name.",
			"capability.inventoryUnavailableName": "The listing is unavailable; legacy names remain unresolved in the draft. Retry later; no source was selected.",
			"capability.unresolvedNameTitle": "Choose a source for legacy name {name}",
			"capability.replaceName": "Replace {name} with {source}",
			"capability.removeName": "Remove legacy name {name}",
			"capability.serverSameName": "Server rejected same-name Skill {names}. Uncheck one source, or refresh the listing; draft kept.",
			"capability.serverMissing": "Server could not resolve {names}. Refresh the listing and choose an exact source or remove the name; draft kept.",
			"capability.unknownName": "unknown name",
			"capability.missing": "missing",
			"capability.noSkills": "No skills match.",
			"capability.mcp.groupManaged": "Weir managed",
			"capability.mcp.groupUnmanaged": "Unmanaged",
			"capability.mcp.none": "No MCP servers configured.",
			"capability.mcp.unmanagedHint": "Configured outside Weir; the selection cannot govern it.",
			"capability.mcp.stateMounted": "mounted",
			"capability.mcp.stateRegistered": "registered",
			"capability.unmanaged": "unmanaged",
			"capability.mcp.add": "+ Add managed MCP server",
			"capability.mcp.identity": "identity (e.g. my-docs)",
			"capability.mcp.label": "label (display name, optional)",
			"capability.mcp.command": "command (e.g. npx)",
			"capability.mcp.args": "args, space-separated (optional)",
			"capability.mcp.adding": "Adding…",
			"capability.mcp.addConfirm": "Add",
			"capability.mcp.cancel": "Cancel",
			"capability.mcp.errorRequired": "Required.",
			"capability.mcp.errorIdentityInvalid": "Letters, digits, \"-\" and \"_\" only; start with a letter or digit.",
			"capability.diff.addSkills": "+{n} skills",
			"capability.diff.removeSkills": "−{n} skills",
			"capability.diff.addMcp": "+{n} MCP",
			"capability.diff.removeMcp": "−{n} MCP",
			"capability.apply": "Apply",
			"capability.applying": "Applying…",
			"capability.discard": "Discard",
			"capability.applied": "Applied",
			"capability.acceptedUnknown": "Accepted · effective count unknown",
			"capability.appliedSkipped": "skipped {n} (not applicable here)",
			"capability.failed": "Failed — draft kept",
			"capability.conflictState": "Changed elsewhere — review current state",
			"capability.missingAction": "Missing items need install/configure",
			"capability.pending": "Result pending — query the receipt",
			"capability.presets.unavailable": "Presets are unavailable on this host.",
			"capability.presets.errorName": "Enter a name.",
			"capability.presets.saved": "Preset saved.",
			"capability.presets.replaced": "Replaced the confirmed preset under ID {id}; no second preset was created.",
			"capability.presets.renameRow": "Rename preset…",
			"capability.presets.resaveRow": "Re-save…",
			"capability.presets.newName": "New preset name",
			"capability.presets.renameSubmit": "Save new name",
			"capability.presets.resaveSubmit": "Confirm re-save",
			"capability.presets.editTarget": "Target: {name} · {scope} · ID {id} · revision {revision}",
			"capability.presets.resaveConfirm": "Overwrite this preset from {source}: {skills} Skills · {mcp} MCP · {unresolved} unresolved. Current session stays unchanged.",
			"capability.presets.renamed": "Preset renamed; current draft and applied selection unchanged.",
			"capability.presets.resaved": "Preset re-saved; current draft and applied selection unchanged.",
			"capability.presets.renameCollision": "That name belongs to another preset. Choose another name.",
			"capability.presets.editConflict": "The preset changed. Review the refreshed row and confirm again.",
			"capability.presets.sourceChanged": "The applied selection changed. Refresh the session receipt and confirm again.",
			"capability.presets.sourceUnavailable": "Applied source unavailable{missing}. Restore the missing Skills, refresh the receipt, and confirm again.",
			"capability.presets.appliedUnavailable": "The applied source has unavailable entries. Restore them and refresh the session receipt before re-saving.",
			"capability.presets.appliedReceiptMissing": "The applied source cannot be verified from this receipt. Refresh the session receipt before re-saving; the current draft is still available.",
			"capability.presets.locked": "Preset storage is busy. Wait, then refresh and decide again.",
			"capability.presets.unreadable": "Preset storage cannot be read safely. Check the storage before retrying.",
			"capability.presets.unsupported": "This preset version is unsupported. Update the client or host before editing.",
			"capability.presets.gone": "This preset was deleted or is missing. Refresh the list; it was not recreated.",
			"capability.presets.confirmAgain": "The replacement target changed. Refresh and confirm its identity again.",
			"capability.presets.uncertain": "Result unknown. Refresh and inspect the preset before deciding whether to retry.",
			"capability.presets.missingSelection": "The draft selection is incomplete. Refresh before saving.",
			"capability.presets.replaceTarget": "Replace preset ID {id} at revision {revision} in {scope}?",
			"capability.presets.noneKnown": "none reported",
			"capability.presets.importPartial": "Installed Skills: {names}. Preset status is unconfirmed. Inspect the installed files and refresh the preset before deciding how to recover.",
			"capability.presets.currentRevision": " Current stored revision: {revision}.",
			"capability.presets.revisionConflict": "Changed elsewhere — the list was refreshed.",
			"capability.presets.noWorkspace": "This session has no workspace.",
			"capability.presets.saveFailed": "The preset could not be saved.",
			"capability.presets.loaded": "Staged into the draft — Apply to activate.",
			"capability.presets.loadedUnresolved": "Staged into the draft — {n} unresolved ref(s) reported.",
			"capability.presets.loadFailed": "Load failed — the preset may be gone.",
			"capability.presets.deleted": "Preset deleted.",
			"capability.presets.deleteFailed": "Delete failed.",
			"capability.presets.exportFailed": "Export failed.",
			"capability.presets.imported": "Imported: {bound} MCP binding(s), {unresolved} unresolved ref(s).",
			"capability.presets.counts": "{skills} skills · {mcp} MCP",
			"capability.presets.countsUnresolved": " · {n} unresolved",
			"capability.presets.loading": "Loading…",
			"capability.presets.load": "Load",
			"capability.presets.export": "Export",
			"capability.presets.delete": "Delete",
			"capability.presets.deleteConfirm": "Delete preset \"{name}\"? This cannot be undone.",
			"capability.presets.deleteConfirmButton": "Delete preset",
			"capability.presets.deleting": "Deleting…",
			"capability.presets.cancel": "Cancel",
			"capability.presets.exportLabel": "Preset JSON",
			"capability.presets.copy": "Copy to clipboard",
			"capability.presets.copied": "Copied",
			"capability.presets.close": "Close",
			"capability.presets.saveOpen": "Save as preset…",
			"capability.presets.importOpen": "Import…",
			"capability.presets.name": "Preset name",
			"capability.presets.namespace": "Namespace",
			"capability.presets.scopeWorkspace": "workspace",
			"capability.presets.scopeGlobal": "global",
			"capability.presets.source": "From",
			"capability.presets.fromDraft": "current draft",
			"capability.presets.fromApplied": "applied selection",
			"capability.presets.nameConflict": "A preset named \"{name}\" already exists in this namespace.",
			"capability.presets.rename": "Rename…",
			"capability.presets.renameHint": "Edit the name, then save again.",
			"capability.presets.replace": "Replace it",
			"capability.presets.saving": "Saving…",
			"capability.presets.save": "Save preset",
			"capability.presets.importPlaceholder": "Paste a portable preset document (JSON)…",
			"capability.presets.importing": "Importing…",
			"capability.presets.importSubmit": "Import",
			"capability.presets.importInvalidJson": "Not valid JSON — nothing was written.",
			"capability.presets.importRejected": "Rejected: {reason} — nothing was written.",
			"capability.presets.importNameConflict": "A preset with this name already exists here.",
			"capability.presets.importFailed": "Import failed — nothing was written.",
			"capability.presets.groupWorkspace": "Workspace presets",
			"capability.presets.groupWorkspaceNone": "Workspace presets (no workspace)",
			"capability.presets.groupGlobal": "Global presets",
			"capability.presets.emptyWorkspace": "No workspace presets yet.",
			"capability.presets.emptyGlobal": "No global presets yet.",
			"capability.presets.defaultTitle": "Workspace default for new sessions",
			"capability.presets.defaultUnavailable": "The workspace default is unavailable.",
			"capability.presets.defaultNone": "No default is set — new sessions use the builtin baseline.",
			"capability.presets.defaultEmpty": "An explicit empty default is set: new sessions start with 0 skills · 0 MCP.",
			"capability.presets.defaultEntries": "Default: {counts}",
			"capability.presets.defaultUnresolved": "…with {n} unresolved ref(s) reported on resolve.",
			"capability.presets.defaultSaveOpen": "Save as default…",
			"capability.presets.defaultClearOpen": "Clear default…",
			"capability.presets.defaultSaveConfirm": "Save {counts} as this workspace's default? New sessions in this workspace will start from it; the current session does not change.",
			"capability.presets.defaultSaveConfirmButton": "Save default",
			"capability.presets.defaultSaved": "Workspace default saved.",
			"capability.presets.defaultSaveFailed": "The default could not be saved.",
			"capability.presets.defaultClearConfirm": "Clear the workspace default? New sessions return to the builtin baseline; open sessions do not change.",
			"capability.presets.defaultClearConfirmButton": "Clear default",
			"capability.presets.defaultCleared": "Workspace default cleared — new sessions use the builtin baseline.",
			"capability.presets.defaultClearFailed": "The default could not be cleared.",
			"capability.presets.clearing": "Clearing…",
			"capability.presets.needsReceipt": "Unavailable until the session receipt loads.",
			"capability.presets.exportDownload": "Download .json",
			"capability.presets.downloaded": "Downloaded",
			"capability.presets.importedPackage": "Imported: {installed} Skill(s) installed, {bound} MCP binding(s), {unresolved} unresolved ref(s).",
			"capability.presets.importSummaryTitle": "Import summary — review before anything is written",
			"capability.presets.importFiles": "{n} file(s)",
			"capability.presets.importNoInstalls": "This package bundles no Skills to install.",
			"capability.presets.importUnresolvedTitle": "Unresolved refs — not installed:",
			"capability.presets.importCollision": "name collision",
			"capability.presets.importCollisionDecision": "When a bundled Skill name already exists:",
			"capability.presets.collisionCancel": "skip it (default)",
			"capability.presets.collisionReplace": "replace it",
			"capability.presets.collisionCoexist": "keep both, renamed",
			"capability.presets.importConfirm": "Confirm import",
			"capability.presets.importResultTitle": "Import result",
			"capability.presets.importInstalledNote": "Installed Skills stay unselected — pick them in the draft and Apply to activate.",
			"capability.presets.importInstallFailed": "Installation failed: {reason} — rolled back {n} file(s); no preset was created.",
			"capability.presets.importNoTargetRoot": "No {scope} Skill root is available on this host — nothing was installed.",
			"capability.presets.scopeProject": "project",
			"capability.presets.scopeUser": "user",
			// Session blackboard (slice 2): the right-sidebar panel's tab, list,
			// detail and editor strings. Type labels are short semantic names,
			// translated per locale.
			blackboardTabLabel: "Blackboard",
			blackboardGuideTitle: "Session blackboard",
			blackboardGuideDescription: "Findings shared across this session: entries, usage counts, arbitrated editing.",
			blackboardPillTitle: "Open the session blackboard",
			"blackboard.title": "Blackboard",
			"blackboard.entries": "{n} entries",
			"blackboard.loading": "Loading the board…",
			"blackboard.unavailable": "Blackboard unavailable for this session.",
			"blackboard.retry": "Retry",
			"blackboard.empty": "The board is empty.",
			"blackboard.emptyDesc": "Findings agents write to this session's board appear here.",
			"blackboard.noMatch": "No entries match.",
			"blackboard.search": "Search",
			"blackboard.new": "New entry",
			"blackboard.refresh": "Refresh",
			"blackboard.back": "Back",
			"blackboard.dismiss": "Dismiss",
			"blackboard.filterAll": "All",
			"blackboard.type.map": "map",
			"blackboard.type.contract": "contract",
			"blackboard.type.deadend": "dead end",
			"blackboard.type.wiring": "wiring",
			"blackboard.type.recipe": "recipe",
			"blackboard.type.why": "why",
			"blackboard.rowMeta": "{read} reads · {watching} watching",
			"blackboard.updated": "updated {time}",
			"blackboard.summary": "Summary",
			"blackboard.content": "Content",
			"blackboard.gone": "This entry is gone.",
			"blackboard.goneDesc": "It was deleted from the board (possibly by another writer).",
			"blackboard.error": "The entry could not be loaded.",
			"blackboard.edit": "Edit",
			"blackboard.delete": "Delete",
			"blackboard.deleting": "Deleting…",
			"blackboard.deleted": "Entry deleted.",
			"blackboard.deleteConfirm": "Delete this entry? The write authority is consumed.",
			"blackboard.contention": "Write authority is held by {holder}.",
			"blackboard.watch": "Notify me when free",
			"blackboard.watching": "watching {key}",
			"blackboard.watchingState": "watching…",
			"blackboard.released": "Key free — you hold the write authority.",
			"blackboard.editorNew": "New entry",
			"blackboard.formKey": "Key",
			"blackboard.formType": "Type",
			"blackboard.formRequired": "Required.",
			"blackboard.formKeyInvalid": "Letters, digits and . _ - / only; start with a letter or digit.",
			"blackboard.formSummaryPlaceholder": "One or two sentences: the finding, what it cost, how to verify it",
			"blackboard.save": "Save",
			"blackboard.saving": "Saving…",
			"blackboard.cancel": "Cancel",
			"blackboard.saved": "Saved (revision {n}).",
			"blackboard.created": "Entry created.",
			"blackboard.applying": "Acquiring write authority…",
			"blackboard.reacquire": "Re-acquire",
			"blackboard.tokenHeld": "write authority {time}",
			"blackboard.tokenExpired": "Write authority expired — re-acquire before saving.",
			"blackboard.tokenExpiredShort": "write authority expired",
			// Session blackboard (slice 3): the promotion-evaluation button and
			// the promoted read-only marker.
			"blackboard.promote": "Evaluate for promotion",
			"blackboard.promoteDisabled": "Every entry is already promoted — nothing to evaluate.",
			"blackboard.promotionRequested": "The main agent received the promotion-evaluation request.",
			"blackboard.promoted": "promoted",
			"blackboard.promotedTo": "promoted → {destination}",
			"blackboard.promotedReadonly": "This entry is promoted and read-only.",
			"blackboard.promotedReadonlyDetail": "Promoted entries are read-only: the durable copy lives in the target document, this board copy preserves the session references."
		};
		const zh = {
			title: "Weir",
			description: "Weir 预设的一站式配置：意图分类、自动续推、上下文压力、文件编辑、Worktree 车道、只读命令行、LSP 与系统通知；模型路由为独立页面。",
			routingTitle: "Weir 模型路由",
			routingDescription: "委派给子代理的模型：按任务类别或精选代理指定，可设备选按序回退。",
			loading: "正在加载 Weir 设置…",
			loadFailed: "Weir 设置加载失败：",
			unavailable: "此插件未加载，当前无法配置。",
			readOnly: "此部署的设置为只读。",
			saveFailed: "部署未接受这些值，已保留供你修正。",
			save: "保存",
			saving: "保存中…",
			pendingChanges: "{n} 项未保存的更改",
			discardChanges: "放弃更改",
			overridden: "已覆盖",
			reset: "恢复默认",
			restartRequired: "需重启",
			invalidValue: "请输入该字段接受的值，或留空以使用默认值。",
			restartReminderTitle: "重启后生效",
			restartReminderBody: "以下设置已更改，重启 DeepSeek Harness 后才会生效；本次保存的其它改动已即时生效。",
			restartReminderDismiss: "知道了",
			restartReminderAcknowledge: "知道了",
			catalogLoading: "正在加载 provider…",
			pickerModel: "模型",
			pickerEffort: "推理",
			effortProviderDefault: "跟随 provider 默认",
			catalogFailed: "Provider 目录不可用；可手动填写 provider 与模型。",
			providerEmpty: "选择 provider",
			modelEmpty: "选择模型",
			pickerUnavailable: "模型选择器不可用——请重新加载设置页后重试。",
			groupIntent: "意图分类",
			groupTodo: "自动续推",
			groupGuard: "上下文压力",
			groupEditing: "文件编辑",
			groupWorktree: "Worktree 车道",
			groupRobash: "只读命令行",
			groupLsp: "LSP 语义工具",
			groupNotify: "系统通知",
			groupRoutingCategories: "任务类别",
			groupRoutingAgents: "精选代理",
			groupRoutingSupervision: "监督与重试",
			intentGateClassifierOptionRegex: "regex（规则）",
			intentGateClassifierOptionLlm: "llm（语义）",
			intentGateClassifierOptionJev: "jev（实验）",
			intentGateClassifier: "意图分类器",
			intentGateClassifierHint: "如何识别每条消息的意图：regex 用内置规则，零成本（默认）；llm 用独立小模型做语义分类；jev 为实验实现。",
			intentGateProvider: "分类器模型（llm 模式）",
			intentGateProviderHint: "为语义分类单独指定的模型；留空跟随会话当前模型。",
			intentGateModel: "分类器模型名（llm 模式）",
			intentGateModelHint: "留空跟随会话路由所用模型。",
			intentGateReasoningEffort: "分类器推理档位（llm 模式）",
			intentGateReasoningEffortHint: "留空跟随模型默认。",
			intentGateTimeoutMs: "分类超时（毫秒）",
			intentGateTimeoutMsHint: "超过该时长按规则分类结果继续，不阻塞消息（默认 1500）。",
			jevEndpoint: "Jev 端点",
			jevEndpointHint: "Jev 决策服务地址（实验模式）。",
			jevModel: "Jev 模型",
			jevModelHint: "Jev 使用的模型名（默认 jev）。",
			jevApiKeyEnv: "Jev 密钥环境变量名",
			jevApiKeyEnvHint: "存放 Jev API 密钥的环境变量名；密钥本身不写入配置。",
			delegateCategoryChains: "任务类别模型",
			delegateCategoryChainsHint: "每类任务委派给子代理时使用的模型；可添加备选按序回退，留空跟随会话模型。",
			delegateAgentChains: "精选代理模型",
			delegateAgentChainsHint: "finder、scholar、advisor 各自运行的模型；留空继承调用方路由。",
			delegateDisabledCategories: "停用任务类别",
			delegateDisabledCategoriesHint: "停用的类别从委派清单中移除，助手无法再委派这类任务。",
			disabledCategoriesCount: "个已停用",
			disabledCategoriesPanelHint: "每个类别一个开关；保存只写入打开的类别，全部关闭即不停用任何类别。",
			disabledCategoriesInvalid: "已保存的值不是有效的类别清单；编辑器已以全部关闭打开，保存将覆盖该值。",
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
			supervisionMaxRetries: "子代理续推上限",
			supervisionMaxRetriesHint: "受监督子代理未交结果或连续出错时，最多自动续推几次（默认 5）。",
			supervisionInitialBackoffMs: "重试初始间隔（毫秒）",
			supervisionInitialBackoffMsHint: "首次重试前的等待时间，之后逐次加倍（默认 30000）。",
			supervisionMaxBackoffMs: "重试间隔上限（毫秒）",
			supervisionMaxBackoffMsHint: "重试间隔最多增长到该值（默认 300000）。",
			todoEnabled: "自动续推",
			todoEnabledHint: "有待办未完成时，助手自动继续推进，无需你发消息（默认开启）。",
			todoMaxConsecutive: "连续续推上限",
			todoMaxConsecutiveHint: "没有你输入时最多连续自动续推几轮（默认 8）。",
			todoErrorRetryMax: "出错重试上限",
			todoErrorRetryMaxHint: "模型供应商报错时最多自动重试几次（默认 5）。",
			guardEnabled: "上下文压力守卫",
			guardEnabledHint: "上下文将满时提醒助手收尾并请求压缩，避免超限报错；即时生效。",
			guardSoftThreshold: "提醒阈值",
			guardSoftThresholdHint: "上下文用量超过该比例时提醒助手收尾（默认 0.72，须小于压缩阈值）。",
			guardHardThreshold: "压缩阈值",
			guardHardThresholdHint: "上下文用量超过该比例时请求立即压缩（默认 0.88，不保证压缩完成）。",
			hashlineHideStockEdit: "仅用锚点编辑",
			hashlineHideStockEditHint: "隐藏内置 edit 工具，文件修改一律走 hash_edit 锚点编辑。",
			editLockEnabled: "编辑锁",
			editLockLabel: "编辑锁",
			editLockTitle: "本会话正在编辑的文件",
			editLockPanelTitle: "编辑锁",
			editLockLoading: "加载中…",
			editLockRefresh: "刷新",
			editLockStop: "收回编辑权",
			editLockRevokeConfirm: "确认收回——助手将停止编辑，直到你点继续",
			editLockResume: "继续编辑",
			editLockRetry: "重试连接",
			editLockRetryPending: "正在重试连接……编辑仍不可用。",
			editLockBinding_serving: "本会话正在另一个附着位置编辑中。请在该回合结束后重试连接；重试不等于继续编辑。",
			editLockBinding_transferable: "本会话的编辑权由同一会话的一个不活跃附着持有。你发送下一条消息时会自动接管；也可以立即点「重试连接」接管（重试不等于继续编辑）。",
			editLockBinding_unknown: "无法核实原持有者。请等待原连接断开或确认其进程已退出，再重试；勿删除存活 publisher 的预约。",
			"editLockBinding_cross-process": "原持有者位于另一进程。请先断开原连接或确认其进程已退出，再重试。",
			"editLockBinding_revocation-failed": "持久撤权尚未确认。请查看编辑锁维护；未授予替代绑定权限。",
			editLockConfirmAll: "继续编辑这些文件",
			editLockReleaseAll: "立即释放全部文件",
			editLockDetails: "技术细节",
			editLockOwnerOther: "其他会话",
			editLockHoldUntil: "保留至 {time}",
			editLockRecovery: "上一回合出错，正在清理（第 {n} 次）。",
			editLockState_idle: "未占用任何文件",
			editLockCleanupOnly: "仅允许清理：业务编辑和新占用都被拒绝。请释放不再需要的文件，重试前查看工具结果。",
			editLockRecoveryUsage: "已记录恢复：{attempts} 次 · 已用 {elapsed} 秒 · 已暂停 {pause} 分钟。",
			editLockPauseUsageHint: "暂停时长是累计用量，不是当前倒计时。暂停到期只会重新检查恢复，不释放锁，也不恢复编辑。",
			editLockPausedUntil: "恢复已暂停，至 {time} 后重新检查。",
			editLockOwnershipHint: "锁只表示归属，不表示写入结果。编辑失败请查看工具结果；释放锁不会撤销已发生的修改。",
			editLockState_editing: "正在编辑",
			editLockState_holding: "文件为本会话保留",
			editLockState_confirm: "等你确认继续",
			editLockState_stopped: "编辑已停止",
			editLockState_attention: "需要你处理",
			editLockState_revoked: "编辑权已被管理员吊销",
			editLockRevokedHint: "管理员恢复已吊销本会话的编辑权并释放其锁。点击「继续编辑」或发送任意消息，即在新执行纪元恢复编辑；吊销记录保留。",
			editLockColdRevokedAuto: "管理员恢复已吊销本会话的编辑权并释放其锁。在本会话发送任意消息——连接与编辑会自动恢复。",
			editLockColdRevokedManual: "管理员恢复已吊销本会话的编辑权并释放其锁。发送任意消息激活会话，然后回到此面板点「继续编辑」。",
			editLockColdResumeAuto: "重启后恢复的会话，编辑已停止。发送任意消息即自动恢复编辑（下列文件会一并确认）。",
			editLockColdResumeManual: "重启后恢复的会话，编辑已停止。发送任意消息激活会话，然后回到此面板点「继续编辑」。",
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
			editLockEnabledHint: "多个会话轮流编辑同一批文件，而不是互相覆盖。",
			editLockOptOutWarning: "编辑锁已设为关闭。保存后须重启 DeepSeek Harness 才会生效。停用强制执行后，普通编辑不受保护，可能覆盖其他会话的工作。旧围栏与历史仍会保留，重新启用编辑锁时可能再次阻塞文件。",
			editLockAutoResume: "发消息即恢复编辑",
			editLockAutoResumeHint: "会话被停止后，发送任意消息即自动恢复其编辑权并确认保留的文件（默认开启）。",
			editLockStaleSweep: "自动清理失效锁",
			editLockStaleSweepHint: "目标文件已被删除或移动的锁，在你发消息时自动复核并释放（默认开启）。",
			editLockMaint: "编辑锁维护",
			editLockMaintHint: "查看全 profile 的强制执行状态与只读诊断。",
			editLockMaintFailed: "编辑锁维护面板加载失败",
			editLockMaintLoading: "加载中……",
			editLockMaintUnavailable: "维护数据不可用：",
			editLockMaintRetry: "重试",
			editLockMaintRefresh: "刷新",
			editLockMaintInspect: "检查",
			editLockMaintStateEnforced: "强制执行中",
			editLockMaintStateEnforcedHint: "开关已打开，且编辑锁管理器已在本进程中挂载。",
			editLockMaintStateDisableRequested: "已请求停用——需要重启",
			editLockMaintStateDisableRequestedHint: "你已关闭开关，但管理器仍处于挂载并强制执行状态。重启 DeepSeek Harness 后生效。",
			editLockMaintStateEnableRequested: "已请求启用——需要重启",
			editLockMaintStateEnableRequestedHint: "你已打开开关，但本进程尚未挂载管理器。重启 DeepSeek Harness 后生效。",
			editLockMaintStateDisabled: "强制执行已停用",
			editLockMaintStateDisabledHint: "开关关闭，所有已记录且完成安装的行均报告强制执行已停用。",
			editLockMaintStateUnknown: "未知",
			editLockMaintStateUnknownHint: "挂载证据缺失、不一致，或仍在安装、卸载、失败状态。仅凭已保存的值不能证明正在强制执行或已经停用。",
			editLockMaintRestart: "重启 DeepSeek Harness 后生效。",
			editLockMaintPinned: "当前组合在编辑锁行上钉死了配置；这里的设置开关对它不生效。",
			editLockMaintScopeNote: "该开关对整个 profile 生效：覆盖此 profile 下的所有 Weir 会话，而非某一个工作区。",
			editLockMaintWarnKeepHistory: "关闭强制执行不会清除未决操作、围栏或历史——重新打开后同一批文件可能再次被阻塞。",
			editLockMaintWarnUnlock: "普通解锁只释放一把锁且不校验内容；它不是历史恢复，永远不会结清未知的发布。",
			editLockMaintOffRisk: "编辑锁管理器未挂载。普通编辑不受保护，可能覆盖其他会话的工作。保留的锁和围栏不会阻止停用期间的编辑；重新启用并重启后可能再次阻塞文件。",
			editLockMaintUnknownRisk: "无法核实编辑锁的挂载状态。如果管理器未挂载，普通编辑不受保护，可能覆盖其他会话的工作。不能把保留的围栏当成当前仍受保护的证据。",
			editLockMaintHistory: "保留的历史——不是当前阻塞",
			editLockMaintHistoryHint: "这些旧锁与发布围栏保留在磁盘供检查。没有挂载管理器时，它们不会阻止普通编辑；重新启用后可能再次阻塞文件。此处不可在线强制释放；独立的离线管理员恢复端点仍可使用。",
			editLockMaintUnknownHistory: "保留的权威记录——当前作用未经核实",
			editLockMaintUnknownHistoryHint: "仅凭已保存的值与旧围栏无法确认管理器是否挂载。可只读检查这些历史；核实强制执行前不可在线强制释放。独立的离线管理员恢复端点仍可使用。",
			editLockMaintBlocked: "初始化受阻",
			editLockMaintDomains: "管理域",
			editLockMaintNoDomains: "此 profile 中没有活动会话报告编辑锁管理域。",
			editLockMaintAuthorityYes: "权威已存在",
			editLockMaintAuthorityNo: "当前无权威",
			editLockMaintReservation: "存在发布者预留：本进程或另一个 Harness 持有（或遗留）了该域的发布权。",
			editLockMaintPresenceNone: "当前没有权威目录。无法据此判断此前是否初始化过。",
			editLockMaintPresenceEmpty: "权威目录当前为空。无法据此判断此前是否初始化过。",
			editLockMaintPresenceJunk: "权威目录有内容但没有已提交的快照；存储层会拒绝打开它。未做任何改动。",
			editLockMaintPresenceNotAFile: "snapshot.json 不是常规文件；存储层会拒绝它。未做任何改动。",
			editLockMaintPresenceCorrupt: "权威镜像未通过完整性校验，已原样保留——不存在自动修复。拒绝原因：",
			editLockMaintPresenceUnreadable: "无法读取权威：",
			editLockMaintCounts: "{sessions} 个会话 · {locks} 把锁 · {operations} 条已记录操作",
			editLockMaintUnresolved: "未决操作",
			editLockMaintUnresolvedNone: "没有未决操作。",
			editLockMaintRetained: "保留的锁（中断 / 异常 / 待确认）",
			editLockMaintScopeFile: "单个文件",
			editLockMaintScopeSubtree: "一个目录子树",
			editLockMaintScopeDomain: "整个工作目录",
			editLockMaintScopeNone: "无记录范围",
			editLockMaintRecoveries: "在线管理员恢复",
			editLockMaintRecoverHint: "在运行中的管理器里结清已中断 owner 的未知发布：一次明确点击，无需重启、无需手打哈希；历史中的未知结论原样保留。若范围自加载后发生变化，管理器会拒绝，面板会重新加载。",
			editLockMaintRecoverRoot: "管理根",
			editLockMaintRecoverOwner: "属主会话",
			editLockMaintRecoverRevision: "权威 revision",
			editLockMaintRecoverOperations: "未决操作 ID",
			editLockMaintRecoverRisk: "你接受的风险",
			editLockMaintRecoverDigest: "确认摘要",
			editLockMaintRecoverConfirm: "在线结清该 owner",
			editLockMaintRecoverBusy: "结清中……",
			editLockMaintRecoverDone: "已在 revision {revision} 结清；准入阻塞解除，历史仍保持未知。",
			editLockMaintRecoverFailed: "恢复未确认：",
			worktreeEnabled: "Worktree 车道",
			worktreeEnabledHint: "让助手在隔离的 git worktree 中工作：车道工具、/worktree 命令与车道面板。",
			worktreeAutoSetup: "新车道自动安装依赖",
			worktreeAutoSetupHint: "开车道时自动执行仓库配置的安装命令（默认开启）。",
			worktreeMaxActive: "活跃车道上限",
			worktreeMaxActiveHint: "每个仓库最多同时活跃几条车道（默认 4）。",
			worktreeRoot: "车道目录",
			worktreeRootHint: "车道存放在仓库内的相对目录（默认 .weir/worktrees，已通过 .git/info/exclude 本地忽略）。",
			worktreeWatchTimeoutMinutes: "车道订阅有效期（分钟）",
			worktreeWatchTimeoutMinutesHint: "订阅车道状态后，超过该时长未命中即过期并通知一次（默认 360）；已建立的订阅不变。",
			worktreeAutoApprove: "车道自动授权",
			worktreeAutoApproveHint: "新会话的默认审批方式：manual 每次都问；auto-keep 自动批准并保留分支；auto-clean 自动批准并删除分支；会话内 /worktree approve 可覆盖。",
			worktreeAutoApproveOptionManual: "manual（手动）",
			"worktreeAutoApproveOptionAuto-keep": "auto-keep（保留分支）",
			"worktreeAutoApproveOptionAuto-clean": "auto-clean（清理分支）",
			robashEnabled: "只读命令行守卫",
			robashEnabledHint: "精选只读代理（finder 等）只能运行允许清单内的只读命令（默认开启）。",
			robashAllow: "额外允许的命令",
			robashAllowHint: "在内置允许清单之上追加的命令名；内置清单始终生效，留空即不追加。",
			robashGitAllow: "额外允许的 git 子命令",
			robashGitAllowHint: "追加的 git 只读子命令（与 pwsh 侧共用）；留空即不追加。",
			robashDeny: "额外禁止的命令",
			robashDenyHint: "在内置禁止清单之上追加的命令名；禁止优先于允许。",
			robashPwshAllow: "额外允许的 pwsh 命令",
			robashPwshAllowHint: "Windows 只读 pwsh 的追加允许项；内置清单始终生效。",
			robashPwshDeny: "额外禁止的 pwsh 命令",
			robashPwshDenyHint: "Windows 只读 pwsh 的追加禁止项；禁止优先于允许。",
			robashListEntries: "条目",
			robashListAdd: "添加条目",
			robashListInvalid: "已保存的值不是有效的命令清单；编辑器已以空列表打开，保存将覆盖该值。",
			robashListPanelHint: "每行一个命令名；条目追加到内置清单，内置清单始终生效——空列表即不追加。",
			robashListEntryPlaceholder: "命令名",
			lspEnabled: "LSP 语义工具",
			lspEnabledHint: "开启后，每个会话可在输入栏单独启用定义跳转、引用查找等语言服务（会话默认关）。",
			lspServers: "自定义语言服务器",
			lspServersHint: "添加内置清单之外的语言服务器，在管理面板中可视化配置。",
			notifyEnabled: "系统通知",
			notifyEnabledHint: "会话需要你处理或一轮任务结束时发送系统通知（默认开启）。",
			notifyOnComplete: "完成时通知",
			notifyOnCompleteHint: "一轮任务结束且耗时超过下方最短时长时通知。",
			notifyOnAttention: "需要处理时通知",
			notifyOnAttentionHint: "审批请求、提问、计划评审、任务失败或中止时通知。",
			notifyMinTurnSeconds: "最短通知时长（秒）",
			notifyMinTurnSecondsHint: "任务至少运行这么久才通知完成；0 表示每轮都通知（默认 15）。",
			notifySound: "通知提示音",
			notifySoundHint: "通知时播放系统提示音（平台支持时）。",
			notifyForeground: "窗口在前台时",
			notifyForegroundHint: "你正看着窗口时是否仍通知：不通知（默认）或始终通知。",
			notifyForegroundOptionSkip: "不通知",
			notifyForegroundOptionAlways: "始终通知",
			notifyPermissions: "通知权限",
			notifyPermissionsHint: "检测 macOS 是否放行这些通知，并引导你完成授权。",
			notifyPermissionsOpen: "管理",
			notifyPermTitle: "通知权限",
			notifyPermDescription: "通知由 DeepSeek Harness 自己弹出，所以需要在 macOS 里允许 DeepSeek Harness 发送通知。",
			notifyPermClose: "关闭",
			notifyPermChecking: "检测中…",
			notifyPermRecheck: "重新检测",
			notifyPermBestEffort: "该检测读取的是苹果未公开文档化的系统设置，仅供参考；亲眼看到测试通知才是最终证明。",
			notifyPermFocusNote: "专注模式 / 勿扰仍可能拦截通知，且无法在这里检测。",
			notifyPermSendTest: "发送测试通知",
			notifyPermSending: "发送中…",
			notifyPermOpenSettings: "打开系统通知设置",
			notifyPermOpening: "打开中…",
			notifyPermOpenHint: "在列表中找到「DeepSeek Harness」，打开「允许通知」，并选择「横幅」或「提醒」样式。",
			notifyPermWaiting: "正在等你允许通知…每 2 秒自动检测一次。",
			notifyPermConfirm: "你看到测试通知了吗？",
			notifyPermSeenYes: "看到了",
			notifyPermSeenNo: "没看到",
			notifyPermSeen: "设置完成，通知会送达你。",
			notifyPermNotSeen: "请确认专注模式 / 勿扰已关闭，「DeepSeek Harness」的样式是「横幅」或「提醒」，并且（若窗口在前台）「窗口在前台时」已设为「始终通知」，然后重试。",
			notifyPermRetry: "重新开始",
			notifyPermSendAgain: "再发一条测试",
			notifyPermError: "出错了：",
			notifyPermManualPath: "也可以手动操作：系统设置 → 通知 → DeepSeek Harness。",
			notifyPermDetails: "技术细节",
			notifyPermFailed: "权限面板出错，请查看运行日志。",
			"notifyPermState_granted": "已允许",
			"notifyPermState_denied": "未允许",
			"notifyPermState_unknown": "无法判定",
			"notifyPermReason_alerts-allowed": "已允许「DeepSeek Harness」弹出提醒。",
			"notifyPermReason_not-allowed": "「DeepSeek Harness」的通知已被关闭。",
			"notifyPermReason_no-record": "macOS 里还没有「DeepSeek Harness」的记录。先发一条测试通知，让它出现在列表里。",
			"notifyPermReason_default": "macOS 里没有「DeepSeek Harness」的明确设置（沿用系统默认），无法在这里判定。",
			"notifyPermReason_unreadable": "无法读取通知设置。",
			notifyWebUnsupported: "当前页面没有网页通知能力，DeepSeek Harness 无法直接通知。",
			notifyWebPermission: "网页通知权限",
			notifyWebDeniedHint: "本页面被禁止显示通知，且无法再次询问。请打开「系统设置 → 通知 → DeepSeek Harness」并开启通知。",
			"notifyWebPerm_granted": "已允许",
			"notifyWebPerm_denied": "已禁止",
			"notifyWebPerm_default": "尚未询问",
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
			lspToggleLabel: "LSP",
			lspToggleTitle: "为本会话启用/禁用 LSP 语义工具",
			worktreePillMode: "Worktree",
			worktreePillLanes: "Worktree",
			worktreePillCount: "{n} 条车道",
			worktreePillAwaiting: "{n} 待批准",
			worktreePillTitle: "Worktree 车道——打开面板",
			worktreePillBaseMoved: "主工作区已离开车道基线分支，切回后才能合并",
			worktreeModeLabel: "Worktree",
			worktreeModeTitle: "可选纪律：车道随时可用，无需开启。开启后助手不再直接改文件，所有改动走隔离车道。",
			worktreeModeUnavailable: "Worktree 模式不可用：",
			worktreeApproveLabel: "自动授权",
			worktreeApproveTitle: "车道自动授权模式（{mode}）：manual 每张卡片都要批准；auto-keep 自动批准合并/放弃并清理 worktree 但保留分支；auto-clean 连分支一起删除。新会话默认在设置 › Worktree 车道。",
			worktreeApproveOptionManual: "手动",
			worktreeApproveOptionAutoKeep: "保留",
			worktreeApproveOptionAutoClean: "清理",
			worktreeLoading: "正在加载车道…",
			worktreeLoadFailed: "车道视图读取失败。",
			worktreeUnavailable: "本会话无法使用 Worktree 车道。",
			worktreeDisabled: "Worktree 车道已在设置中关闭。",
			worktreeEmpty: "没有活跃车道。助手会用 worktree_open 开一条。",
			worktreeEmptyTitle: "没有活跃车道",
			worktreeEmptyBody: "助手需要隔离工作区时会用 worktree_open 开一条车道。在这里跟踪检查、批准合并与收尾。",
			worktreeRefresh: "刷新",
			worktreeConfigure: "验证配置…",
			worktreeShowHistory: "历史（{n}）",
			worktreeHideHistory: "收起历史",
			worktreeVerificationOn: "验证：{n} 条命令",
			worktreeVerificationOff: "未启用验证",
			worktreeExcludeOk: "已本地忽略",
			worktreeExcludeMissing: "车道目录尚未忽略",
			worktreeUnmanaged: "车道目录下有 {n} 个不由 Weir 管理的 worktree",
			worktreeStaleData: "显示的是上次读取的数据；刷新失败。",
			worktreeAheadBehind: "领先 {ahead} · 落后 {behind}",
			worktreeBaseMoved: "基线已移动",
			worktreeNextLabel: "下一步：{next}",
			worktreeViewDiff: "改动",
			worktreeHideDiff: "收起改动",
			worktreeDiffUnavailable: "改动不可用",
			worktreeFiles: "{n} 个文件",
			worktreeExitCode: "退出码 {code}",
			worktreeNoChanges: "相对基线分支没有改动。",
			worktreeRecheck: "重新检查",
			worktreeRetrySetup: "重试安装",
			worktreeSkipSetup: "跳过安装",
			worktreeLand: "合并…",
			worktreeLandConfirm: "确认合并",
			worktreeAbandon: "放弃…",
			worktreeAbandonConfirm: "确认放弃",
			worktreeCleanupWorktree: "清理 worktree",
			worktreeCleanupAll: "清理 worktree 与分支",
			worktreeCleanupAllConfirm: "确认删除分支",
			worktreeCopyPath: "复制路径",
			worktreeActionUnavailable: "当前不可用",
			worktreeActionFailed: "此车道操作当前不可用，请改用 /worktree 命令直接执行。",
			worktreeConflicts: "冲突",
			worktreeMergeCommit: "合并提交",
			worktreeCleanup: "收尾",
			worktreeConfigName: "名称",
			worktreeConfigRun: "命令",
			worktreeConfigChecks: "验证命令",
			worktreeConfigSetup: "setup 命令（可选）",
			worktreeConfigAdd: "添加命令",
			worktreeConfigRemove: "删除",
			worktreeConfigSave: "保存",
			worktreeCancel: "取消",
			worktreeConfigHint: "只写入本仓库（.weir/worktrees/.config.json，不入库）。车道检查时在该车道内执行这些命令。",
			worktreeInitParseFailed: "仓库配置读取失败。",
			worktreeFlatInput: "输入",
			worktreeFlatOutput: "输出",
			worktreeTabLabel: "Worktrees",
			worktreeGuideTitle: "Worktree 车道",
			worktreeGuideDescription: "本会话的车道：状态、检查、合并与收尾。",
			worktreeState_preparing: "准备中",
			worktreeState_setup_failed: "安装失败",
			worktreeState_ready: "就绪",
			worktreeState_working: "工作中",
			worktreeState_dirty: "有未提交改动",
			worktreeState_no_commits: "没有提交",
			worktreeState_branch_moved: "分支被切换",
			worktreeState_checking: "检查中",
			worktreeState_check_failed: "检查失败",
			worktreeState_landable: "可合并",
			worktreeState_conflicted: "有冲突",
			worktreeState_awaiting_approval: "等待批准",
			worktreeState_declined: "已拒绝合并",
			worktreeState_landed: "已合并",
			worktreeState_kept: "已保留",
			worktreeState_cleaned: "已清理",
			worktreeState_abandoned: "已放弃",
			worktreeTool_worktree_open: "开启 worktree 车道",
			worktreeTool_worktree_check: "检查 worktree 车道",
			worktreeTool_worktree_land: "合并 worktree 车道",
			worktreeTool_worktree_cleanup: "worktree 收尾",
			worktreeTool_worktree_abandon: "放弃 worktree 车道",
			worktreeTool_worktree_watch: "订阅 worktree 车道",
			worktreeWatchStates: "订阅状态",
			worktreeWatchExpires: "有效期至 {time}",
			worktreeWatchHit: "已立即命中",
			worktreeWatching: "{n} 个订阅",
			worktreeNext_delegate: "派子代理到该车道工作",
			worktreeNext_worktree_check: "检查车道",
			worktreeNext_worktree_land: "合并车道（需你批准）",
			worktreeNext_worktree_cleanup: "选择收尾方式",
			worktreeWait_lane_ready: "等待依赖安装完成",
			worktreeWait_child_settle: "等待车道子代理完成",
			worktreeWait_check_complete: "等待验证完成",
			worktreeWait_user: "等待你的决定",
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
			hashEditExpandAria: "展开剩余 {count} 行",
			capabilityTabLabel: "能力",
			capabilityGuideTitle: "能力",
			capabilityGuideDescription: "此会话的技能、MCP server 与预设。",
			"capability.badge": "{skills} 个技能 · {mcp} 个 MCP",
			"capability.unavailable.short": "能力不可用",
			"capability.effectiveUnknown": "已应用数量未知——请刷新并检查技能来源",
			"capability.effectiveUnknownShort": "技能 ? · MCP ?",
			"capability.effectiveUnknownDetail": "修订已接受，但有效能力暂无法核实。请刷新并检查技能来源。草稿已保留；只有手动应用才会更改会话。",
			"capability.unknownOverwriteRisk": "原有选择未知。应用此草稿可能覆盖其他已接受的技能与 MCP server。确认前请核对完整选择。",
			"capability.confirmUnknownOverwrite": "确认替换未知选择",
			"capability.loading": "正在加载能力…",
			"capability.error": "此会话的能力不可用。",
			"capability.unavailable": "能力在此会话中不可用。",
			"capability.unsupported": "不支持：此宿主未满足一致性条件。",
			"capability.tab.skills": "技能",
			"capability.tab.mcp": "MCP",
			"capability.tab.presets": "预设",
			"capability.search": "搜索",
			"capability.close": "关闭",
			"capability.conflict": "冲突",
			"capability.sourceUnknown": "未知来源",
			"capability.sourceNumber": " · 候选 ",
			"capability.sameNameWarning": "{name}：本会话只能启用一个来源。请取消其中一项：{sources}。",
			"capability.unresolvedNameWarning": "{name}：旧名称尚未选定来源。请选择精确来源或移除该名称：{sources}。",
			"capability.unknownLegacyName": "{name}：当前清单中没有匹配的技能。请刷新清单或移除这个旧名称。",
			"capability.inventoryUnavailableName": "清单暂不可读；旧名称在草稿中保持未解析。请稍后重试；未选择任何来源。",
			"capability.unresolvedNameTitle": "为旧名称 {name} 选择来源",
			"capability.replaceName": "将 {name} 替换为 {source}",
			"capability.removeName": "移除旧名称 {name}",
			"capability.serverSameName": "服务端拒绝同名技能 {names}。请取消一个来源或刷新清单；草稿已保留。",
			"capability.serverMissing": "服务端无法解析 {names}。请刷新清单并选择精确来源或移除该名称；草稿已保留。",
			"capability.unknownName": "未知名称",
			"capability.missing": "缺失",
			"capability.noSkills": "没有匹配的技能。",
			"capability.mcp.groupManaged": "Weir 管理",
			"capability.mcp.groupUnmanaged": "未纳入管理",
			"capability.mcp.none": "未配置 MCP server。",
			"capability.mcp.unmanagedHint": "在 Weir 之外配置，会话选择无法管理它。",
			"capability.mcp.stateMounted": "已挂载",
			"capability.mcp.stateRegistered": "已注册",
			"capability.unmanaged": "未管理",
			"capability.mcp.add": "+ 添加受管 MCP server",
			"capability.mcp.identity": "identity（如 my-docs）",
			"capability.mcp.label": "标签（显示名，可选）",
			"capability.mcp.command": "命令（如 npx）",
			"capability.mcp.args": "参数，空格分隔（可选）",
			"capability.mcp.adding": "正在添加…",
			"capability.mcp.addConfirm": "添加",
			"capability.mcp.cancel": "取消",
			"capability.mcp.errorRequired": "必填。",
			"capability.mcp.errorIdentityInvalid": "仅限字母、数字、\"-\"、\"_\"，且以字母或数字开头。",
			"capability.diff.addSkills": "+{n} 个技能",
			"capability.diff.removeSkills": "−{n} 个技能",
			"capability.diff.addMcp": "+{n} 个 MCP",
			"capability.diff.removeMcp": "−{n} 个 MCP",
			"capability.apply": "应用",
			"capability.applying": "正在应用…",
			"capability.discard": "放弃",
			"capability.applied": "已应用",
			"capability.acceptedUnknown": "已接受 · 有效数量未知",
			"capability.appliedSkipped": "已跳过 {n} 项（当前预设不适用）",
			"capability.failed": "失败——草稿已保留",
			"capability.conflictState": "已在别处变更——请核对当前状态",
			"capability.missingAction": "缺失项需要安装/配置",
			"capability.pending": "结果待确认——请查询回执",
			"capability.presets.unavailable": "预设在此宿主上不可用。",
			"capability.presets.errorName": "请输入名称。",
			"capability.presets.saved": "预设已保存。",
			"capability.presets.replaced": "已替换确认的预设 ID {id}；未新建第二个预设。",
			"capability.presets.renameRow": "重命名预设…",
			"capability.presets.resaveRow": "重新保存…",
			"capability.presets.newName": "新预设名称",
			"capability.presets.renameSubmit": "保存新名称",
			"capability.presets.resaveSubmit": "确认重新保存",
			"capability.presets.editTarget": "目标：{name} · {scope} · ID {id} · 修订 {revision}",
			"capability.presets.resaveConfirm": "从{source}覆盖此预设：{skills} 个技能 · {mcp} 个 MCP · {unresolved} 个未解析引用。当前会话不变。",
			"capability.presets.renamed": "预设已改名；当前草稿和已应用选择不变。",
			"capability.presets.resaved": "预设已重新保存；当前草稿和已应用选择不变。",
			"capability.presets.renameCollision": "此名称已属于另一预设，请另选名称。",
			"capability.presets.editConflict": "预设已更改；请检查刷新后的行并重新确认。",
			"capability.presets.sourceChanged": "已应用选择已改变；请刷新会话回执后重新确认。",
			"capability.presets.sourceUnavailable": "已应用来源不可用{missing}。请恢复缺失技能、刷新回执后重新确认。",
			"capability.presets.appliedUnavailable": "已应用来源有不可用项目。请恢复项目并刷新会话回执后重新保存。",
			"capability.presets.appliedReceiptMissing": "当前回执无法验证已应用来源。请刷新会话回执后重新保存；当前草稿仍可使用。",
			"capability.presets.locked": "预设存储正忙；请稍后刷新并重新决定。",
			"capability.presets.unreadable": "无法安全读取预设存储；重试前请检查存储。",
			"capability.presets.unsupported": "不支持此预设版本；编辑前请更新客户端或宿主。",
			"capability.presets.gone": "预设已删除或不存在；请刷新列表，它未被重建。",
			"capability.presets.confirmAgain": "替换目标已改变；请刷新并重新确认身份。",
			"capability.presets.uncertain": "结果未知；请刷新并检查预设，再决定是否重试。",
			"capability.presets.missingSelection": "草稿选择不完整；请刷新后再保存。",
			"capability.presets.replaceTarget": "确认替换 {scope} 范围内 ID {id}、修订 {revision} 的预设？",
			"capability.presets.noneKnown": "无已报告项",
			"capability.presets.importPartial": "已安装的技能：{names}。预设状态尚未确认。请检查已安装文件并刷新预设，再决定如何恢复。",
			"capability.presets.currentRevision": " 当前存储修订：{revision}。",
			"capability.presets.revisionConflict": "已在别处变更——列表已刷新。",
			"capability.presets.noWorkspace": "此会话没有工作区。",
			"capability.presets.saveFailed": "预设保存失败。",
			"capability.presets.loaded": "已装入草稿——应用后生效。",
			"capability.presets.loadedUnresolved": "已装入草稿——报告 {n} 个未解析引用。",
			"capability.presets.loadFailed": "载入失败——预设可能已不存在。",
			"capability.presets.deleted": "预设已删除。",
			"capability.presets.deleteFailed": "删除失败。",
			"capability.presets.exportFailed": "导出失败。",
			"capability.presets.imported": "已导入：{bound} 个 MCP 绑定，{unresolved} 个未解析引用。",
			"capability.presets.counts": "{skills} 个技能 · {mcp} 个 MCP",
			"capability.presets.countsUnresolved": " · {n} 个未解析",
			"capability.presets.loading": "正在载入…",
			"capability.presets.load": "载入",
			"capability.presets.export": "导出",
			"capability.presets.delete": "删除",
			"capability.presets.deleteConfirm": "删除预设“{name}”？此操作不可撤销。",
			"capability.presets.deleteConfirmButton": "删除预设",
			"capability.presets.deleting": "正在删除…",
			"capability.presets.cancel": "取消",
			"capability.presets.exportLabel": "预设 JSON",
			"capability.presets.copy": "复制到剪贴板",
			"capability.presets.copied": "已复制",
			"capability.presets.close": "关闭",
			"capability.presets.saveOpen": "存为预设…",
			"capability.presets.importOpen": "导入…",
			"capability.presets.name": "预设名称",
			"capability.presets.namespace": "命名空间",
			"capability.presets.scopeWorkspace": "工作区",
			"capability.presets.scopeGlobal": "全局",
			"capability.presets.source": "来源",
			"capability.presets.fromDraft": "当前草稿",
			"capability.presets.fromApplied": "已应用的选择",
			"capability.presets.nameConflict": "此命名空间中已存在名为“{name}”的预设。",
			"capability.presets.rename": "改名…",
			"capability.presets.renameHint": "修改名称后重新保存。",
			"capability.presets.replace": "替换它",
			"capability.presets.saving": "正在保存…",
			"capability.presets.save": "保存预设",
			"capability.presets.importPlaceholder": "粘贴便携式预设文档（JSON）…",
			"capability.presets.importing": "正在导入…",
			"capability.presets.importSubmit": "导入",
			"capability.presets.importInvalidJson": "不是有效的 JSON——未写入任何内容。",
			"capability.presets.importRejected": "已拒绝：{reason}——未写入任何内容。",
			"capability.presets.importNameConflict": "此处已存在同名预设。",
			"capability.presets.importFailed": "导入失败——未写入任何内容。",
			"capability.presets.groupWorkspace": "工作区预设",
			"capability.presets.groupWorkspaceNone": "工作区预设（无工作区）",
			"capability.presets.groupGlobal": "全局预设",
			"capability.presets.emptyWorkspace": "暂无工作区预设。",
			"capability.presets.emptyGlobal": "暂无全局预设。",
			"capability.presets.defaultTitle": "新会话的工作区默认值",
			"capability.presets.defaultUnavailable": "工作区默认值不可用。",
			"capability.presets.defaultNone": "未设置默认值——新会话使用内置基线。",
			"capability.presets.defaultEmpty": "已设置显式空默认：新会话以 0 个技能 · 0 个 MCP 开始。",
			"capability.presets.defaultEntries": "默认值：{counts}",
			"capability.presets.defaultUnresolved": "……解析时报告 {n} 个未解析引用。",
			"capability.presets.defaultSaveOpen": "存为默认值…",
			"capability.presets.defaultClearOpen": "清除默认值…",
			"capability.presets.defaultSaveConfirm": "将 {counts} 存为此工作区的默认值？此工作区的新会话将从它开始；当前会话不变。",
			"capability.presets.defaultSaveConfirmButton": "保存默认值",
			"capability.presets.defaultSaved": "工作区默认值已保存。",
			"capability.presets.defaultSaveFailed": "默认值保存失败。",
			"capability.presets.defaultClearConfirm": "清除工作区默认值？新会话回到内置基线；已打开的会话不变。",
			"capability.presets.defaultClearConfirmButton": "清除默认值",
			"capability.presets.defaultCleared": "工作区默认值已清除——新会话使用内置基线。",
			"capability.presets.defaultClearFailed": "默认值清除失败。",
			"capability.presets.clearing": "正在清除…",
			"capability.presets.needsReceipt": "会话回执载入前不可用。",
			"capability.presets.exportDownload": "下载 .json",
			"capability.presets.downloaded": "已下载",
			"capability.presets.importedPackage": "已导入：安装 {installed} 个技能，{bound} 个 MCP 绑定，{unresolved} 个未解析引用。",
			"capability.presets.importSummaryTitle": "导入摘要——写入前请核对",
			"capability.presets.importFiles": "{n} 个文件",
			"capability.presets.importNoInstalls": "此包不包含需要安装的技能。",
			"capability.presets.importUnresolvedTitle": "未解析引用——不会安装：",
			"capability.presets.importCollision": "名称冲突",
			"capability.presets.importCollisionDecision": "当打包技能名称已存在时：",
			"capability.presets.collisionCancel": "跳过它（默认）",
			"capability.presets.collisionReplace": "替换它",
			"capability.presets.collisionCoexist": "共存（自动改名）",
			"capability.presets.importConfirm": "确认导入",
			"capability.presets.importResultTitle": "导入结果",
			"capability.presets.importInstalledNote": "已安装的技能保持未勾选——在草稿中勾选并应用后生效。",
			"capability.presets.importInstallFailed": "安装失败：{reason}——已回滚 {n} 个文件；未创建预设。",
			"capability.presets.importNoTargetRoot": "此宿主没有可用的 {scope} 技能根目录——未安装任何内容。",
			"capability.presets.scopeProject": "工作区",
			"capability.presets.scopeUser": "用户",
			// 会话黑板（切片二）：右侧边栏面板的页签、列表、详情与编辑字符串。
			// 类型标签为短语义名，随语言翻译。
			blackboardTabLabel: "黑板",
			blackboardGuideTitle: "会话黑板",
			blackboardGuideDescription: "本会话共享的发现：条目、用量计数与仲裁编辑。",
			blackboardPillTitle: "打开会话黑板",
			"blackboard.title": "黑板",
			"blackboard.entries": "{n} 条",
			"blackboard.loading": "正在加载黑板…",
			"blackboard.unavailable": "此会话的黑板不可用。",
			"blackboard.retry": "重试",
			"blackboard.empty": "黑板为空。",
			"blackboard.emptyDesc": "Agent 写入本会话黑板的发现会出现在这里。",
			"blackboard.noMatch": "没有匹配的条目。",
			"blackboard.search": "搜索",
			"blackboard.new": "新建条目",
			"blackboard.refresh": "刷新",
			"blackboard.back": "返回",
			"blackboard.dismiss": "忽略",
			"blackboard.filterAll": "全部",
			"blackboard.type.map": "索引",
			"blackboard.type.contract": "硬约束",
			"blackboard.type.deadend": "已否决方案",
			"blackboard.type.wiring": "隐藏耦合",
			"blackboard.type.recipe": "操作流程",
			"blackboard.type.why": "设计缘由",
			"blackboard.rowMeta": "{read} 次读取 · {watching} 个等待者",
			"blackboard.updated": "更新于 {time}",
			"blackboard.summary": "摘要",
			"blackboard.content": "正文",
			"blackboard.gone": "此条目已不存在。",
			"blackboard.goneDesc": "它已从黑板删除（可能是其他写入者所为）。",
			"blackboard.error": "条目加载失败。",
			"blackboard.edit": "编辑",
			"blackboard.delete": "删除",
			"blackboard.deleting": "删除中…",
			"blackboard.deleted": "条目已删除。",
			"blackboard.deleteConfirm": "删除此条目？写入权将被消耗。",
			"blackboard.contention": "写入权正被 {holder} 持有。",
			"blackboard.watch": "释放时通知我",
			"blackboard.watching": "正在监视 {key}",
			"blackboard.watchingState": "监视中…",
			"blackboard.released": "键已释放——写入权现由你持有。",
			"blackboard.editorNew": "新建条目",
			"blackboard.formKey": "键",
			"blackboard.formType": "类型",
			"blackboard.formRequired": "必填。",
			"blackboard.formKeyInvalid": "仅限字母、数字与 . _ - /；须以字母或数字开头。",
			"blackboard.formSummaryPlaceholder": "一两句话：发现是什么、代价几何、如何复核",
			"blackboard.save": "保存",
			"blackboard.saving": "保存中…",
			"blackboard.cancel": "取消",
			"blackboard.saved": "已保存（修订 {n}）。",
			"blackboard.created": "条目已创建。",
			"blackboard.applying": "正在申请写入权…",
			"blackboard.reacquire": "重新申请",
			"blackboard.tokenHeld": "写入权 {time}",
			"blackboard.tokenExpired": "写入权已过期——保存前请重新申请。",
			"blackboard.tokenExpiredShort": "写入权已过期",
			"blackboard.promote": "评估晋升",
			"blackboard.promoteDisabled": "所有条目均已晋升——没有可评估的条目。",
			"blackboard.promotionRequested": "主 Agent 已收到晋升评估请求。",
			"blackboard.promoted": "已晋升",
			"blackboard.promotedTo": "已晋升 → {destination}",
			"blackboard.promotedReadonly": "此条目已晋升，只读。",
			"blackboard.promotedReadonlyDetail": "已晋升条目只读：持久副本位于目标文档，黑板副本保留会话内引用。"
		};
		const NS = "settings.weir";
		const SECTION_ID = "weir-settings";
		const ITEM_SLOT = "settings.weir.item";
		// The model-routing settings live on their own page: a second section
		// registration (order 41, right after the main page) with its own item
		// slot, its own controller, and the routing-page groups of the shared
		// settings-page chunk.
		const ROUTING_SECTION_ID = "weir-model-routing";
		const ROUTING_ITEM_SLOT = "settings.weir-routing.item";
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
		const loadNotifyWebChunk = lazyChunks(() => require.async("./client.notify-web.js"));
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
		// ---- Tab glyphs (ui-entries-and-icons) ----
		// Three 16x16 stroke glyphs drawn in currentColor, matching the host
		// CompassGlyph/CubeGlyph style (no strokeWidth, rounded caps/joins).
		// The guide capsule icon and the tab chip title are registered eagerly
		// at apply time, so the glyph components MUST live inline in this
		// entry — a lazy chunk would flash the host's placeholder cube.
		/** @param {object} props @param {Array} children */
		function glyphSvg(props, children) {
			const size = props.size ?? 16;
			return react_jsx_runtime.jsx("svg", {
				width: size, height: size, viewBox: "0 0 16 16", fill: "none",
				"aria-hidden": "true", className: props.className, style: props.style,
				stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round",
				children
			});
		}
		/** Worktree: git-branch fork (same geometry as the panel chunk's branch icon). */
		function WorktreeGlyph(props) {
			return glyphSvg(props, [
				react_jsx_runtime.jsx("circle", { cx: 4.5, cy: 3, r: 1.8 }, "c1"),
				react_jsx_runtime.jsx("circle", { cx: 4.5, cy: 13, r: 1.8 }, "c2"),
				react_jsx_runtime.jsx("circle", { cx: 11.5, cy: 5.5, r: 1.8 }, "c3"),
				react_jsx_runtime.jsx("path", { d: "M4.5 4.8v6.4M4.5 11.2c2.8 0 7-.8 7-3.9" }, "p")
			]);
		}
		/** Capabilities: two horizontal sliders. */
		function CapabilityGlyph(props) {
			return glyphSvg(props, [
				react_jsx_runtime.jsx("path", { d: "M2.4 5.2h11.2M2.4 10.8h11.2" }, "l"),
				react_jsx_runtime.jsx("circle", { cx: 6, cy: 5.2, r: 1.7 }, "c1"),
				react_jsx_runtime.jsx("circle", { cx: 10, cy: 10.8, r: 1.7 }, "c2")
			]);
		}
		/** Blackboard: a board rectangle with list lines. */
		function BlackboardGlyph(props) {
			return glyphSvg(props, [
				react_jsx_runtime.jsx("rect", { x: 2, y: 2.6, width: 12, height: 10.8, rx: 1.6 }, "r"),
				react_jsx_runtime.jsx("path", { d: "M4.6 5.8h4.2M4.6 8h6.8M4.6 10.2h5.4" }, "l")
			]);
		}
		// Tab chip title: icon + the host-provided tab title (the host's own
		// GuideTitle renders glyph + tab.title the same way). Icon styling is
		// inline — the shell's CSS-module classes are unreachable from a bundle.
		const tabChipIconStyle = { marginRight: "5px", color: "var(--dsw-alias-label-tertiary)", flex: "none", display: "inline-block", verticalAlign: "-2px" };
		const tabChipTitle = (Glyph) => {
			function WeirTabChipTitle({ useTabInfo }) {
				return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					react_jsx_runtime.jsx(Glyph, { size: 12, style: tabChipIconStyle }, "icon"),
					useTabInfo().tab.title
				] });
			}
			return WeirTabChipTitle;
		};
		// Blackboard session-header quick entry (D2): a bordered badge pill — glyph
		// plus the localized tab label — so it reads as a control next to the
		// worktree pill. No live lane state to poll, so no chunk and no model; hover
		// paint follows the capability badge's inline-style pattern.
		const blackboardPillStyle = {
			display: "inline-flex", alignItems: "center", gap: "5px",
			padding: "1px 7px", fontSize: "11px", lineHeight: "16px", fontWeight: 600,
			color: "var(--dsw-alias-label-secondary)", cursor: "pointer", background: "none",
			border: "1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))",
			borderRadius: "var(--dsw-radius-sm)"
		};
		function BlackboardPill(props) {
			const title = typeof props.t === "function" ? props.t("blackboardPillTitle") : "Open the session blackboard";
			const label = typeof props.t === "function" ? props.t("blackboardTabLabel") : "Blackboard";
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				style: blackboardPillStyle,
				onClick: () => props.openPanel?.(),
				onMouseEnter: (event) => { event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))"; },
				onMouseLeave: (event) => { event.currentTarget.style.background = "none"; },
				title,
				"aria-label": title,
				"data-weir-blackboard-pill": "",
				children: [
					react_jsx_runtime.jsx(BlackboardGlyph, { size: 11 }, "icon"),
					react_jsx_runtime.jsx("span", { children: label }, "label")
				]
			});
		}
		// ---- Worktree lanes surfaces ----
		// One model chunk plus one view chunk carry every lane surface; the
		// composition root binds them to the ctx closures below. A session needs
		// no sessionId for the row marker and tool views (the slot's own scope
		// supplies the session), so those wrappers pull the chunks with no gate.
		const loadWorktreeChunks = lazyChunks(() => Promise.all([
			require.async("./client.worktree-view.js"),
			require.async("./client.worktree-model.js")
		]));
		/** The views name keys without the namespace prefix ("abandon",
		 * "state_landable"); the dictionaries hold them prefixed
		 * ("worktreeAbandon", "worktreeState_landable"). Hyphens in state names
		 * map to underscores. */
		const worktreeKey = (key) => `worktree${key.charAt(0).toUpperCase()}${key.slice(1)}`.replace(/-/g, "_");
		const worktreeT = (t) => (typeof t === "function" ? (key, ...rest) => t(worktreeKey(String(key)), ...rest) : t);
		const worktreeFace = (props, view, model) => ({
			...props,
			t: worktreeT(props.t),
			view,
			model,
			WORKTREE_PROJECTION_KEY: model.WORKTREE_PROJECTION_KEY,
			narrowView: model.narrowView,
			groupLanes: model.groupLanes,
			summaryOf: model.summaryOf,
			needsPolling: model.needsPolling,
			diffLines: model.diffLines,
			ago: model.ago
		});
		/** Session-list marker (U1). */
		function WorktreeRowWrapper(props) {
			const arrival = useChunkArrival(loadWorktreeChunks);
			if (!arrival?.chunks) return null;
			const [view, model] = arrival.chunks;
			return react_jsx_runtime.jsx(view.WorktreeRowMarker, worktreeFace(props, null, model));
		}
		/** Session-header status pill (U2). */
		function WorktreePillWrapper(props) {
			const arrival = useChunkArrival(loadWorktreeChunks, typeof props.sessionId === "string" && props.sessionId !== "");
			if (!arrival?.chunks) return null;
			const [view, model] = arrival.chunks;
			return react_jsx_runtime.jsx(view.WorktreeStatusPill, worktreeFace(props, null, model));
		}
		/** Right-sidebar lanes panel (U3) and its tab body. */
		function WorktreePanelWrapper(props) {
			const arrival = useChunkArrival(loadWorktreeChunks);
			if (!arrival?.chunks) return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: typeof props.t === "function" ? props.t("worktreeLoading") : "" });
			const [view, model] = arrival.chunks;
			return react_jsx_runtime.jsx(view.LanesPanel, worktreeFace(props, view, model));
		}
		/** Conversation tool cards (U6). */
		function WorktreeToolViewWrapper(props) {
			const arrival = useChunkArrival(loadWorktreeChunks);
			if (!arrival?.chunks) return null;
			const [view, model] = arrival.chunks;
			return react_jsx_runtime.jsx(view.WorktreeToolRow, { ...props, t: worktreeT(props.t), model });
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
		const LSP_PROJECTION_KEY = "weirLsp";
		// sidebarRight / sidebarRightTabs are OPTIONAL (a shell without the
		// right sidebar keeps every other worktree surface): they are reached
		// through ctx.inject([...]) below, not through this list.
		const inject = ["slots", "locale", "configForms", "remote", "remote.session", "remote.commands", "connection"];
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-weir-settings: dictionaries");
			// Web notification delivery: the page half of "notify as DeepSeek Harness".
			// It long-polls the host for notes the host decided to send and shows
			// them as web notifications. Started here (not from the settings page) so
			// notifications work whether or not settings is open; a failed chunk load
			// just means the host falls back to the system command.
			ctx.effect(() => {
				let delivery = null;
				let live = true;
				loadNotifyWebChunk().then((chunk) => {
					if (live) delivery = chunk.startWebDelivery(globalThis);
				}, () => {});
				return () => {
					live = false;
					delivery?.stop();
				};
			}, "ui-weir-settings: web notification delivery");
			// Per-session LSP toggle in the conversation composer bar (next to
			// the model selector; visible in blank and active sessions alike —
			// the session-header utilities slot only renders once the session
			// has content). Renders nothing while the `lsp` command is absent
			// (capability gate off).
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "weir-lsp-toggle",
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
			}, LspToggleWrapper)), "ui-weir-settings: lsp session switch");
			// Keyed conversation view: hash_edit renders as a diff panel. Its own
			// effect scope: a slot-registration failure must not take down the
			// settings page or the LSP toggle. The wrapper registers under the
			// literal key (no chunk pull just to register); it renders the generic
			// flattened input/output body until the view+model chunks arrive.
			ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "hash_edit",
				locale: NS
			}, HashEditToolView)), "ui-weir-settings: hash_edit toolview");
			// Edit Lock entry: renders only while the `edit-lock` command exists
			// (feature enabled). Each action is an explicit human /edit-lock run.
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "weir-edit-lock",
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
							const response = await fetch("api/weir-edit-lock/view", {
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
			}, EditLockWrapper)), "ui-weir-settings: edit lock entry");
			// ---- Worktree lane surfaces ----
			// Each surface registers in its own effect so one failure cannot take
			// down the others (same discipline as the hash_edit view). Reads go to
			// the read-only view endpoint (never into the conversation log);
			// mutations are /worktree commands, so every human action is recorded.
			// The GUI language rides along so the host writes its decision cards
			// (merge / cleanup / abandon) in the language the user reads.
			const activeLocale = () => {
				try {
					return ctx.locale?.getSnapshot?.()?.active;
				} catch {
					return undefined;
				}
			};
			const worktreeView = async (sessionId) => {
				const response = await fetch("api/weir-worktree/view", {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, locale: activeLocale() })
				});
				const payload = await response.json();
				if (!payload?.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
				return payload.value;
			};
			const worktreeDiff = async (sessionId, lane) => {
				const response = await fetch("api/weir-worktree/diff", {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId, lane })
				});
				const payload = await response.json();
				if (!payload?.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
				return payload.value?.diff ?? "";
			};
			const worktreeRun = async (sessionId, line) => {
				if (!ctx.remote.commands?.execute) return { kind: "error", text: "unknown command: /worktree" };
				const result = await ctx.remote.commands.execute(sessionId, `/worktree ${line}`, []);
				if (!result.ok) return { kind: "error", text: `${result.error.message} (${result.error.code})` };
				if (result.value === undefined) return { kind: "error", text: "unknown command: /worktree" };
				return result.value.result;
			};
			const worktreeCommandsList = (sid) => {
				if (!ctx.remote.commands?.list) return Promise.resolve([]);
				return ctx.remote.commands.list(sid).then((result) => (result.ok ? result.value : []));
			};
			// U1: session list row marker. Root-scoped list slot whose entries
			// receive the sessionId through their own props.
			ctx.effect(() => ctx.slots.inject("sidebar.session.row.leading", () => ctx.slots.register({
				name: "sidebar.session.row.leading",
				id: "weir-worktree-marker",
				order: 30,
				locale: NS,
				inject: (sessionId) => (sessionId ? { sessionId } : {})
			}, WorktreeRowWrapper)), "ui-weir-settings: worktree session marker");
			// U2: session header pill (click opens the panel).
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "weir-worktree-pill",
				order: 10,
				locale: NS,
				inject: (sessionId) => (sessionId ? {
					sessionId,
					fetchView: () => worktreeView(sessionId),
					commandsList: () => worktreeCommandsList(sessionId),
					openPanel: () => {
						try { ctx.get("sidebarRight")?.openTab?.("weir-worktrees"); } catch { /* no sidebar in this shell */ }
					}
				} : {})
			}, WorktreePillWrapper)), "ui-weir-settings: worktree header pill");
			// U6: one keyed tool view per lane tool (six), all backed by the same chunk.
			for (const toolName of ["worktree_open", "worktree_check", "worktree_land", "worktree_cleanup", "worktree_abandon", "worktree_watch"]) {
				ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: toolName,
					locale: NS
				}, WorktreeToolViewWrapper)), `ui-weir-settings: ${toolName} toolview`);
			}
			// U3: the lanes panel as a right-sidebar page tab. Registered only
			// where the sidebar right package is mounted (optional inject), so a
			// composition without it keeps every other surface.
			ctx.inject?.(["sidebarRightTabs"], (sidebarScope) => {
				const tabId = "weir-worktrees";
				const kind = "weir-worktrees";
				sidebarScope.effect(() => sidebarScope.sidebarRightTabs.register({
					id: tabId,
					kind,
					priority: "extension",
					title: () => sidebarScope.locale.bind(NS)("worktreeTabLabel"),
					guide: [{
						id: "worktree",
						order: 30,
						title: () => sidebarScope.locale.bind(NS)("worktreeGuideTitle"),
						description: () => sidebarScope.locale.bind(NS)("worktreeGuideDescription"),
						icon: WorktreeGlyph
					}]
				}), "ui-weir-settings: worktree tab type");
				sidebarScope.effect(() => sidebarScope.slots.register({
					name: "sidebar.right.pane.tab",
					key: tabId,
					locale: NS,
					inject: (sessionId) => (sessionId ? {
						sessionId,
						fetchView: () => worktreeView(sessionId),
						fetchDiff: (lane) => worktreeDiff(sessionId, lane),
						runWorktree: (line) => worktreeRun(sessionId, line),
						commandsList: () => worktreeCommandsList(sessionId)
					} : {})
				}, WorktreePanelWrapper), "ui-weir-settings: worktree panel body");
				sidebarScope.effect(() => sidebarScope.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: tabId,
					locale: NS
				}, tabChipTitle(WorktreeGlyph)), "ui-weir-settings: worktree tab title");
			});
			// Session capability Badge in the composer bar (12.1): order 95, next
			// to the LSP toggle (order 100). The wrapper registers synchronously
			// (single ./client apply exit); the view and model chunks load lazily,
			// and the pure draft/identity model stays DOM-free.
			// The commands registry normalizes results to {kind, text} — structured
			// payloads ride as JSON text. Unwrap the remote envelope ({ok, value}
			// with value being either the settled {commandId, result} or the
			// normalized result itself) and parse.
			const capabilityPayload = async (sid, line, parseErrorText = false) => {
				if (!ctx.remote.commands?.execute) return null;
				try {
					const result = await ctx.remote.commands.execute(sid, line, []);
					if (!result.ok) return null;
					let settled = result.value;
					if (settled && typeof settled === "object" && settled.result && typeof settled.result === "object") settled = settled.result;
					if (settled?.kind !== "success" || typeof settled.text !== "string") {
						// Preset/default verbs (D2): a domain failure also travels as a
						// JSON status object in a kind:error text ({status:'no-workspace'},
						// {status:'rejected', reason}) — the preset surface opts into
						// parsing it so it can categorize instead of collapsing to a
						// bare null.
						if (parseErrorText && settled?.kind === "error" && typeof settled.text === "string") {
							try { return JSON.parse(settled.text); } catch { return null; }
						}
						return null;
					}
					return JSON.parse(settled.text);
				} catch {
					return { error: true };
				}
			};
			// Read channel (silent-capability-reads): the Badge/panel READ verbs
			// travel as RAW gateway calls over the shared connection —
			// POST /api/weirCapabilities/<method> with an { args } payload,
			// answered with a RemoteResult envelope ({ ok, value } / { ok: false,
			// error }). Deliberately NO typed namespace mount: $mount registers
			// the namespace service on a root-sibling fiber that cordis hides
			// from this plugin behind the inject gate ("cannot get property
			// without inject" — empirically hit), and declaring the namespace in
			// inject would park this fiber forever (the mount it waits for would
			// have to run inside this very apply). The raw channel needs no
			// client-side registration, and the host gateway claims the endpoint
			// from its own typert registry (curl-verified against the live
			// desktop: a real receipt for a live session). There is deliberately
			// NO command-channel fallback: a fallback would resurrect the
			// command/run + command/done log noise. A missing connection or a
			// failed call maps to the existing degraded semantics (receipt →
			// null → "Capabilities n/a"; listing/conditions → { error: true }).
			//
			// Degradation must be observable: the silent-fallback design made a
			// multi-link failure chain invisible for days. Warn once per
			// distinct failure shape per page generation, never per render.
			const capabilityReadWarns = new Set();
			const capabilityReadWarn = (kind, method, detail) => {
				if (capabilityReadWarns.has(kind)) return;
				capabilityReadWarns.add(kind);
				console.warn(`[weir] capability read degraded (${kind}${method ? `, ${method}` : ""})`, detail ?? "");
			};
			const capabilityRead = async (method, sid, fallback) => {
				let connection = null;
				try { connection = ctx.get?.("connection") ?? null; } catch { connection = null; }
				if (typeof connection?.rpc?.call !== "function") {
					capabilityReadWarn("connection-missing", method, null);
					return fallback;
				}
				let result = null;
				try {
					result = await connection.rpc.call("/api", `weirCapabilities/${method}`, { args: { sessionId: sid } });
				} catch (callError) {
					capabilityReadWarn("call-threw", method, callError && (callError.stack || callError.message || String(callError)));
					return fallback;
				}
				// Remote calls resolve to the RemoteResult ENVELOPE — never the
				// bare payload; a failing call resolves { ok: false, error }
				// rather than rejecting (the gateway folds carrier failures).
				if (result?.ok === true && result.value != null) return result.value;
				// unknown-session at cold open is the DOCUMENTED convergence shape
				// (先空后收敛): the Badge may read before the session's agent is
				// registered; the agent-preset/selected frame refetches and
				// converges. Never warn for it — warns are for failures that
				// would otherwise stay invisible.
				const failure = result?.error ?? result ?? null;
				if (!/unknown session/.test(String(failure?.message ?? failure ?? ""))) {
					capabilityReadWarn("call-failed", method, failure);
				}
				return fallback;
			};
			// The presets & workspace-default view is its own chunk, pulled only
			// when the Presets view is first selected (D3) — the composition root
			// owns every require.async specifier (no chunk-to-chunk waterfall).
			const loadCapabilityPresetsChunk = lazyChunks(() => require.async("./client.capability-presets.js"));
			// One verb face shared by the composer Badge slot and the right-sidebar
			// capabilities panel (D1): both mounts drive the same view tree with
			// the same data sources (reads via the weirCapabilities remote,
			// mutations and preset verbs via the /capabilities command surface).
			const capabilityVerbs = (sessionId) => ({
				sessionId,
				fetchReceipt: (sid) => capabilityRead("receipt", sid, null),
				// Forwarded host events arrive via ctx.remote.$on — NOT a
				// remote.session.subscribe (that API does not exist; the old
				// wiring silently never subscribed, which is why cold sessions
				// never converged and Badge state went stale until a remount).
				// The event's first arg is the session id; the Badge model
				// matches on a { sessionId } frame shape.
				subscribeFrames: (callback) => {
					if (typeof ctx.remote?.$on !== "function") return undefined;
					try {
						return ctx.remote.$on("agent-preset/selected", (sid) => callback({ sessionId: sid }));
					} catch { return undefined; }
				},
				// The panel distinguishes loading (promise pending) from failure
				// (explicit error surface) — a null payload maps to the error state.
				applySelection: (sid, draft) => capabilityPayload(sid, `/capabilities apply ${JSON.stringify(draft)}`, true),
				mcpAdd: (sid, spec) => capabilityPayload(sid, `/capabilities mcp-add ${JSON.stringify(spec)}`),
				fetchListing: (sid) => capabilityRead("list", sid, { error: true }),
				fetchConditions: (sid) => capabilityRead("conditions", sid, { error: true }),
				// The manager forwards only its established props. Adapt the lazy view
				// at this boundary to supply row verbs without changing its chunk.
				loadPresets: () => loadCapabilityPresetsChunk().then((chunk) => ({
					...chunk,
					CapabilityPresetsView: (props) => react_jsx_runtime.jsx(chunk.CapabilityPresetsView, {
						...props,
						presetRename: (sid, spec) => capabilityPayload(sid, `/capabilities preset-rename ${JSON.stringify(spec)}`, true),
						presetResave: (sid, spec) => capabilityPayload(sid, `/capabilities preset-resave ${JSON.stringify(spec)}`, true)
					})
				})),
				fetchPresets: (sid) => capabilityRead("presets", sid, { error: true }),
				presetSave: (sid, spec) => capabilityPayload(sid, `/capabilities preset-save ${JSON.stringify(spec)}`, true),
				presetLoad: (sid, spec) => capabilityPayload(sid, `/capabilities preset-load ${JSON.stringify(spec)}`, true),
				presetDelete: (sid, spec) => capabilityPayload(sid, `/capabilities preset-delete ${JSON.stringify(spec)}`, true),
				presetExport: (sid, spec) => capabilityPayload(sid, `/capabilities preset-export ${JSON.stringify(spec)}`, true),
				presetImport: (sid, spec) => capabilityPayload(sid, `/capabilities preset-import ${JSON.stringify(spec)}`, true),
				defaultGet: (sid) => capabilityRead("defaultGet", sid, { error: true }),
				defaultSave: (sid, spec) => capabilityPayload(sid, `/capabilities default-save ${JSON.stringify(spec)}`, true),
				defaultClear: (sid, spec) => capabilityPayload(sid, `/capabilities default-clear ${JSON.stringify(spec ?? {})}`, true)
			});
			// True once the right-sidebar package mounted the capabilities tab
			// (the optional inject below ran); the Badge's openPanel verb exists
			// only then — without it the Badge falls back to its composer popover.
			let capabilitySidebarTab = false;
			const CapabilityBadgeWrapper = (props) => {
				const [impl, setImpl] = react.useState(null);
				react.useEffect(() => {
					let alive = true;
					Promise.all([require.async("./client.capability-badge.js"), require.async("./client.capability-model.js"), require.async("./client.capability-manager.js")]).then(([badge, model, panel]) => {
						if (alive) setImpl(() => ({ Badge: badge.CapabilityBadge, model, Panel: panel.CapabilityManagerPanel }));
					});
					return () => { alive = false; };
				}, [props.sessionId]);
				if (!impl) return null;
				return react_jsx_runtime.jsx(impl.Badge, { ...props, model: impl.model, ManagerPanel: impl.Panel });
			};
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "weir-capability-badge",
				order: 95,
				locale: NS,
				inject: (sessionId) => {
					if (!sessionId) return {};
					return {
						...capabilityVerbs(sessionId),
						// D4: with a mounted sidebar tab, activation opens the dedicated
						// capabilities panel; the lookup stays call-time like the
						// worktree pill's (the shell service may come and go).
						...(capabilitySidebarTab ? {
							openPanel: () => {
								try { ctx.get("sidebarRight")?.openTab?.("weir-capabilities"); } catch { /* no sidebar in this shell */ }
							}
						} : {})
					};
				}
			}, CapabilityBadgeWrapper)), "ui-weir-settings: capability badge");
			// U-cap: the capabilities panel as a right-sidebar tab (D1). Same
			// optional-inject pattern as the worktree panel: a shell without the
			// sidebar right package skips the whole block, capabilitySidebarTab
			// stays false, and the Badge keeps its popover fallback with the same
			// view tree.
			const loadCapabilityPanelChunks = lazyChunks(() => Promise.all([
				require.async("./client.capability-model.js"),
				require.async("./client.capability-manager.js")
			]));
			function CapabilityPanelWrapper(props) {
				const arrival = useChunkArrival(loadCapabilityPanelChunks, typeof props.sessionId === "string" && props.sessionId !== "");
				if (!arrival?.chunks) return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: typeof props.t === "function" ? props.t("capability.loading") : "" });
				const [model, panel] = arrival.chunks;
				// The same view tree the composer popover renders — the sidebar is
				// just the outer frame (D1). No onClose: the pane chrome owns closing.
				return react_jsx_runtime.jsx(panel.CapabilityManagerPanel, { ...props, model, shell: "sidebar" });
			}
			ctx.inject?.(["sidebarRightTabs"], (sidebarScope) => {
				capabilitySidebarTab = true;
				const tabId = "weir-capabilities";
				sidebarScope.effect(() => sidebarScope.sidebarRightTabs.register({
					id: tabId,
					kind: "weir-capabilities",
					priority: "extension",
					title: () => sidebarScope.locale.bind(NS)("capabilityTabLabel"),
					guide: [{
						id: "capabilities",
						order: 40,
						title: () => sidebarScope.locale.bind(NS)("capabilityGuideTitle"),
						description: () => sidebarScope.locale.bind(NS)("capabilityGuideDescription"),
						icon: CapabilityGlyph
					}]
				}), "ui-weir-settings: capability tab type");
				sidebarScope.effect(() => sidebarScope.slots.register({
					name: "sidebar.right.pane.tab",
					key: tabId,
					locale: NS,
					inject: (sessionId) => (sessionId ? capabilityVerbs(sessionId) : {})
				}, CapabilityPanelWrapper), "ui-weir-settings: capability panel body");
				sidebarScope.effect(() => sidebarScope.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: tabId,
					locale: NS
				}, tabChipTitle(CapabilityGlyph)), "ui-weir-settings: capability tab title");
			});
			// ---- Session blackboard panel (slice 2, tasks 2.3/2.4) ----
			// The board data channel is the plugin-owned typert remote
			// (src/blackboard/remote.js): hand-written src-json contributions
			// cannot ride ctx.remote.$mount (its strict-codec gate rejects
			// src-json codecs), so the panel calls the RAW gateway exactly like
			// the capability reads — POST /api/weirBlackboard/<method>,
			// answered with the RemoteResult envelope, zero session log. The
			// pinned wire shape ({ agentId, args }) and the envelope folding are
			// owned by the model chunk's channel factory; this closure only binds
			// the carrier. Degradation warns once per shape per page generation,
			// never per render (the silent-fallback lesson).
			const blackboardCallWarns = new Set();
			const blackboardCallWarn = (kind, method, detail) => {
				if (blackboardCallWarns.has(kind)) return;
				blackboardCallWarns.add(kind);
				console.warn(`[weir] blackboard call degraded (${kind}${method ? `, ${method}` : ""})`, detail ?? "");
			};
			const blackboardRawCall = (endpoint, payload) => {
				let connection = null;
				try { connection = ctx.get?.("connection") ?? null; } catch { connection = null; }
				if (typeof connection?.rpc?.call !== "function") {
					blackboardCallWarn("connection-missing", endpoint, null);
					return Promise.resolve({ ok: false, error: { code: "channel-unavailable", message: "the blackboard channel has no gateway connection" } });
				}
				return connection.rpc.call("/api", endpoint, payload);
			};
			const loadBlackboardPanelChunks = lazyChunks(() => Promise.all([
				require.async("./client.blackboard-model.js"),
				require.async("./client.blackboard-panel.js")
			]));
			function BlackboardPanelWrapper(props) {
				const arrival = useChunkArrival(loadBlackboardPanelChunks, typeof props.sessionId === "string" && props.sessionId !== "");
				if (!arrival?.chunks) return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: typeof props.t === "function" ? props.t("blackboard.loading") : "" });
				const [model, panel] = arrival.chunks;
				return react_jsx_runtime.jsx(panel.BlackboardPanel, { ...props, model });
			}
			// The blackboard panel as a right-sidebar tab — the same optional-
			// inject pattern as the worktree/capability panels: a shell without
			// the sidebar right package skips the whole block.
			ctx.inject?.(["sidebarRightTabs"], (sidebarScope) => {
				const tabId = "weir-blackboard";
				sidebarScope.effect(() => sidebarScope.sidebarRightTabs.register({
					id: tabId,
					kind: "weir-blackboard",
					priority: "extension",
					title: () => sidebarScope.locale.bind(NS)("blackboardTabLabel"),
					guide: [{
						id: "blackboard",
						order: 50,
						title: () => sidebarScope.locale.bind(NS)("blackboardGuideTitle"),
						description: () => sidebarScope.locale.bind(NS)("blackboardGuideDescription"),
						icon: BlackboardGlyph
					}]
				}), "ui-weir-settings: blackboard tab type");
				sidebarScope.effect(() => sidebarScope.slots.register({
					name: "sidebar.right.pane.tab",
					key: tabId,
					locale: NS,
					inject: (sessionId) => (sessionId ? { sessionId, callBoard: blackboardRawCall } : {})
				}, BlackboardPanelWrapper), "ui-weir-settings: blackboard panel body");
				sidebarScope.effect(() => sidebarScope.slots.register({
					name: "sidebar.right.pane.tab.title",
					key: tabId,
					locale: NS
				}, tabChipTitle(BlackboardGlyph)), "ui-weir-settings: blackboard tab title");
			});
			// Blackboard quick entry in the session header utilities row (D2):
			// order 20, after the worktree pill (order 10). A shell without the
			// sidebar right package keeps the button; openPanel then no-ops.
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "weir-blackboard-pill",
				order: 20,
				locale: NS,
				inject: (sessionId) => (sessionId ? {
					sessionId,
					openPanel: () => {
						try { ctx.get("sidebarRight")?.openTab?.("weir-blackboard"); } catch { /* no sidebar in this shell */ }
					}
				} : {})
			}, BlackboardPill)), "ui-weir-settings: blackboard header pill");
			// Top-level Settings section (same place as dsh-web-kimi and the
			// built-in General/Models sections), with a nested item slot
			// hosting the form — the single Weir settings entry.
			ctx.effect(() => ctx.configForms.whileServed([WEIR_NS], () => {
				const scope = ctx.configForms.get(WEIR_NS);
				// The settings page arrives as 8 package-local chunks in one
				// parallel batch (started lazily on the first surface open). The
				// form controller is constructed here on arrival — never inside the
				// react tree — and disposed with this serve generation; the slot
				// inject faces (cached by the host on first render) carry a
				// stable deferred store plus delegating actions.
				let controller = null;
				let routingController = null;
				let serving = true;
				const deferredStore = createDeferredStore();
				const routingDeferredStore = createDeferredStore();
				const routingCardFace = {
					hooks: { weirSettingsCard: routingDeferredStore },
					edit: (field, text) => routingController?.inject().edit(field, text),
					resetField: (field) => routingController?.inject().resetField(field),
					save: (...args) => routingController?.inject().save(...args),
					discard: () => routingController?.inject().discard(),
					dismissRestartReminder: () => routingController?.inject().dismissRestartReminder(),
					getSession: () => ctx.remote.session
				};
				const cardFace = {
					hooks: { weirSettingsCard: deferredStore },
					edit: (field, text) => controller?.inject().edit(field, text),
					resetField: (field) => controller?.inject().resetField(field),
					save: (...args) => controller?.inject().save(...args),
					discard: () => controller?.inject().discard(),
					dismissRestartReminder: () => controller?.inject().dismissRestartReminder(),
					getSession: () => ctx.remote.session
				};
				let arrival = null;
				// The picker chunk has its own arrival state on purpose: a picker load
				// failure must degrade only the rows that show a picker, never the card
				// around them, so it is deliberately NOT a member of the settings-chunk
				// Promise.all below.
				const loadModelPickerChunk = lazyChunks(() => require.async("./client.model-picker.js"));
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
							require.async("./client.lsp-model.js"),
							require.async("./client.notify-permissions.js"),
							require.async("./client.edit-lock-maintenance.js")
						]).then(([settingsPage, chainEditor, robashEditor, disabledCategoriesEditor, lspPanel, chainModel, robashModel, lspModel, notifyPermissions, editLockMaintenance]) => {
							if (serving) {
								controller = new settingsPage.WeirCardController(scope, { settingsBus, getSession: () => ctx.remote.session }, "main");
								deferredStore.attach(controller.store);
								routingController = new settingsPage.WeirCardController(scope, { settingsBus, getSession: () => ctx.remote.session }, "routing");
								routingDeferredStore.attach(routingController.store);
							}
							// Editor components pre-bound with their model chunks,
							// created once per arrival so their identity is stable
							// across re-renders (no remount of an open editor).
							const editors = {
								ChainEditorField: (editorProps) => react_jsx_runtime.jsx(chainEditor.ChainEditorField, { ...editorProps, model: chainModel }),
								RobashListEditorField: (editorProps) => react_jsx_runtime.jsx(robashEditor.RobashListEditorField, { ...editorProps, model: robashModel }),
								DisabledCategoriesEditorField: (editorProps) => react_jsx_runtime.jsx(disabledCategoriesEditor.DisabledCategoriesEditorField, editorProps),
								LspManagerField: (editorProps) => react_jsx_runtime.jsx(lspPanel.LspManagerField, { ...editorProps, model: lspModel }),
								NotifyPermissionsField: (editorProps) => react_jsx_runtime.jsx(notifyPermissions.NotifyPermissionsField, editorProps),
								EditLockMaintenanceField: (editorProps) => react_jsx_runtime.jsx(editLockMaintenance.EditLockMaintenanceField, editorProps)
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
						return react_jsx_runtime.jsx(sectionArrival.chunks.settingsPage.WeirSection, { renderSlot: props.renderSlot });
					}
					if (sectionArrival?.error) {
						return react_jsx_runtime.jsx("div", { style: settingsLoadFailedStyle, children: `${props.t("loadFailed")} ${describeChunkError(sectionArrival.error)}` });
					}
					return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: props.t("loading") });
				}
				function RoutingSectionWrapper(props) {
					const sectionArrival = useChunkArrival(ensureSettingsChunks);
					if (sectionArrival?.chunks) {
						return react_jsx_runtime.jsx(sectionArrival.chunks.settingsPage.WeirSection, { renderSlot: props.renderSlot, slot: ROUTING_ITEM_SLOT });
					}
					if (sectionArrival?.error) {
						return react_jsx_runtime.jsx("div", { style: settingsLoadFailedStyle, children: `${props.t("loadFailed")} ${describeChunkError(sectionArrival.error)}` });
					}
					return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: props.t("loading") });
				}
				function RoutingCardWrapper(props) {
					const cardArrival = useChunkArrival(ensureSettingsChunks);
					const pickerArrival = useChunkArrival(loadModelPickerChunk);
					if (cardArrival?.chunks) {
						return react_jsx_runtime.jsx(cardArrival.chunks.settingsPage.WeirCard, { ...props, page: "routing", editors: cardArrival.chunks.editors, modelPicker: pickerArrival?.chunks });
					}
					if (cardArrival?.error) {
						return react_jsx_runtime.jsx("div", { style: settingsLoadFailedStyle, children: `${props.t("loadFailed")} ${describeChunkError(cardArrival.error)}` });
					}
					return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: props.t("loading") });
				}
				function SettingsCardWrapper(props) {
					const cardArrival = useChunkArrival(ensureSettingsChunks);
					const pickerArrival = useChunkArrival(loadModelPickerChunk);
					if (cardArrival?.chunks) {
						return react_jsx_runtime.jsx(cardArrival.chunks.settingsPage.WeirCard, { ...props, editors: cardArrival.chunks.editors, modelPicker: pickerArrival?.chunks });
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
					id: "weir-config",
					order: 0,
					locale: NS,
					inject: () => cardFace
				}, SettingsCardWrapper));
				const offRoutingSection = ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: ROUTING_SECTION_ID,
					order: 41,
					label: () => t("routingTitle"),
					locale: NS,
					children: { [ROUTING_ITEM_SLOT]: {
						kind: "list",
						scope: "root"
					} }
				}, RoutingSectionWrapper));
				const offRoutingItem = ctx.slots.inject(ROUTING_ITEM_SLOT, () => ctx.slots.register({
					name: ROUTING_ITEM_SLOT,
					id: "weir-routing-config",
					order: 0,
					locale: NS,
					inject: () => routingCardFace
				}, RoutingCardWrapper));
				return () => {
					serving = false;
					controller?.dispose();
					routingController?.dispose();
					offSection();
					offItem();
					offRoutingSection();
					offRoutingItem();
				};
			}), "ui-weir-settings: page");
		}
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
