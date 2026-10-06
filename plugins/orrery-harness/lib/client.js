// Orrery client chunks: {"client.capability-badge.js":"447f4851bd140a3a2d958d3abc87bdcf6dc996de1e37cabae9e4db7f875ac11e","client.capability-manager.js":"af649d09da036ba3e3784ae0e50cbb86b7ffa5afe1be65ec24861b16c4135539","client.capability-model.js":"b6f4c15d8b22a840514031195872aa9607f87b4e9ea9232c8a60717120f0c365","client.capability-presets.js":"4e0681827575f0cef8633ee69996442175897364296dc5126fcf0471d38bb277","client.chain-editor.js":"7474bd068644f6e0eacc34cbcb17263667cf2b385c05f57cc1d07bf91091d4ca","client.chain-model.js":"17db00da66fa2d3ba968fc87db4612606fa6c3f854ae96e2fb66aa39989073c9","client.disabled-categories-editor.js":"8a4cfecdfda020c4ec111391e79327f90c2ae027329363586ca09ca23a67bc8a","client.edit-lock-maintenance.js":"f20b1e5b8fe89473fb48802285520d703e522dbbf521642066ec5f33b0ac7d8a","client.edit-lock-panel.js":"8032445ad8fe1644bac54c79fce9ebb34fba248c91fd4327aafbabda7847eac8","client.hash-edit-model.js":"ed9b350b90e4e2e2d14c4584bbf6982e487efe7f20737d69c0da9d14910d4fb9","client.hash-edit-view.js":"b342643ed56d9c3a75fc2addb0aae35dd13eb7a050fbe31518be0d3738287f38","client.lsp-model.js":"d0e9d4684af02d5f0910c16fa124a6a9b223659be31d9e24d431a16f2bd9394d","client.lsp-panel.js":"5c8eaad37a74eaa326d08c1afa9eef5d0f582aa212bab9068f94b16500b886a0","client.lsp-toggle.js":"0c2976163bfd99b8030341703a2120359051afc6dc7eee68e5ee70e7dbaf98a4","client.notify-permissions.js":"383f13758706106da782c0ec2e8996cd4ff33605ac5399c1743baeedc7bb0798","client.notify-web.js":"db8579df79733a3a415c214c6ecc82ea7698af0d34270bebcfda028875af2f0d","client.robash-editor.js":"969c42990fe4ec82e75b3d6e9eb68d4838733d5e631bb05bc5784a28102ea8cc","client.robash-model.js":"b3c010adbca19dc47fcaf1a4c4ef4c394165853432704c51f010fd1820370136","client.settings-page.js":"d9468512d02458973adaf57cfec1439279478436ab4ece5923109d38c7868fc8","client.worktree-model.js":"7182c054488867055d4b697ee4206eaba642f92ecdb3f1a15ad1bdedee300e42","client.worktree-view.js":"18c16470b3dd024755f7c7a36a4316297a079693e987e1144838f7824f8b4076"}
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
			groupIntent: "Intent",
			groupDelegate: "Delegation",
			groupTodo: "Continuation",
			groupGuard: "Context pressure",
			groupEditing: "Editing",
			groupWorktree: "Worktree lanes",
			groupRobash: "Read-only bash",
			groupLsp: "LSP",
			groupNotify: "Notifications",
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
			editLockState_revoked: "Editing permanently revoked",
			editLockRevokedHint: "An administrative recovery permanently revoked this session's editing authority. It cannot be continued; open a new conversation to edit this workspace.",
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
			editLockEnabledHint: "Lets sessions take turns editing the same files instead of overwriting each other. Applies after restarting DeepSeek Harness.",
			editLockHoldDefaultMinutes: "Edit Lock: how long files stay reserved after a turn ends when the assistant gives no period",
			editLockHoldSingleMaxMinutes: "Edit Lock: most minutes one reservation may last",
			editLockHoldCumulativeMaxMinutes: "Edit Lock: total minutes one batch of files may stay reserved after a turn ends",
			editLockNudgeAttempts: "Edit Lock: how many times a finished turn is continued to settle left-over files",
			editLockNudgeFallback: "Edit Lock: what happens when those reminders run out (release / abnormal)",
			editLockAutoResume: "Edit Lock: your next message resumes a stopped session automatically",
			editLockAutoResumeHint: "After you stop a session, sending any message restores its editing right and re-confirms its files — no manual Continue needed (default on). Turn off to always confirm by hand.",
			editLockStaleSweep: "Edit Lock: silently sweep locks whose file is gone",
			editLockStaleSweepHint: "On any message you send, locks whose target file was deleted or moved are quietly released after re-verification at the arbitration point (default on). Turn off to keep manual unlock only.",
			editLockHoldDefaultMinutesHint: "Minutes a file stays reserved after a turn ends when the assistant gives no period (default 30).",
			editLockHoldSingleMaxMinutesHint: "Upper bound for one reservation request, in minutes (default 30).",
			editLockHoldCumulativeMaxMinutesHint: "Total minutes one batch of files may stay reserved after turns end; once it is used up only releasing remains (default 120).",
			editLockNudgeAttemptsHint: "How many times a finished turn is continued to ask for left-over files to be released or reserved (default 2).",
			editLockNudgeFallbackHint: "release frees those files for other sessions; abnormal keeps them for you to sort out (default release).",
			editLockMaint: "Edit Lock maintenance",
			editLockMaintHint: "Profile-wide enforcement status and read-only authority diagnostics.",
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
			editLockMaintScopeNote: "The switch is profile-wide: it covers every Orrery session in this profile, not one workspace.",
			editLockMaintWarnKeepHistory: "Turning enforcement off does not clear unresolved operations, fences or history — turning it back on can block the same files again.",
			editLockMaintWarnUnlock: "An ordinary unlock frees one lock without validating content; it is not historical recovery and never settles an unknown publication.",
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
			worktreeEnabledHint: "Master switch: lane tools, the /worktree command, Worktree mode, and the Worktrees panel (true/false).",
			worktreeAutoSetup: "Install dependencies in new lanes",
			worktreeAutoSetupHint: "Run the repository's setup (or the lockfile's install command) when a lane opens (true/false).",
			worktreeMaxActive: "Active lane limit",
			worktreeMaxActiveHint: "How many lanes may be active per repository at once (default 4).",
			worktreeRoot: "Lane directory",
			worktreeRootHint: "Repository-relative folder for lanes (default .orrery/worktrees). It is ignored locally through .git/info/exclude; nothing tracked changes.",
			worktreeWatchTimeoutMinutes: "Lane watch timeout",
			worktreeWatchTimeoutMinutesHint: "Minutes a worktree_watch subscription waits for its target states before expiring with one notice (default 360 = 6 hours, minimum 1). Existing watches keep their original deadline.",
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
			notifyEnabled: "System notifications",
			notifyEnabledHint: "Master switch: send a system notification when a session needs you or a turn finishes (true/false).",
			notifyOnComplete: "Notify on completion",
			notifyOnCompleteHint: "Notify when a turn finishes, once it has run longer than the minimum below (true/false).",
			notifyOnAttention: "Notify when you are needed",
			notifyOnAttentionHint: "Notify on approval requests, questions, plan reviews, and failed or stopped turns (true/false).",
			notifyMinTurnSeconds: "Minimum turn length (seconds)",
			notifyMinTurnSecondsHint: "A finished turn is only reported when it ran at least this long; 0 reports every turn.",
			notifySound: "Notification sound",
			notifySoundHint: "Play the platform notification sound where supported (true/false).",
			notifyForeground: "When the window is in front",
			notifyForegroundHint: "Whether to notify while the DeepSeek Harness window is in the foreground. Skip stays quiet (you are already looking at it); Always notifies anyway.",
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
			worktreeUnmanaged: "{n} worktree(s) under the lane folder are not managed by Orrery",
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
			worktreeConfigHint: "Saved to this repository only (.orrery/worktrees/.config.json, never committed). Commands run in a lane when it is checked.",
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
			"capability.missing": "missing",
			"capability.noSkills": "No skills match.",
			"capability.mcp.groupManaged": "Orrery managed",
			"capability.mcp.groupUnmanaged": "Unmanaged",
			"capability.mcp.none": "No MCP servers configured.",
			"capability.mcp.unmanagedHint": "Configured outside Orrery; the selection cannot govern it.",
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
			"capability.appliedSkipped": "skipped {n} (not applicable here)",
			"capability.failed": "Failed — draft kept",
			"capability.conflictState": "Changed elsewhere — review current state",
			"capability.missingAction": "Missing items need install/configure",
			"capability.pending": "Result pending — query the receipt",
			"capability.presets.unavailable": "Presets are unavailable on this host.",
			"capability.presets.errorName": "Enter a name.",
			"capability.presets.saved": "Preset saved.",
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
			"capability.presets.scopeUser": "user"
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
			groupIntent: "意图分类",
			groupDelegate: "委派与模型链",
			groupTodo: "续推",
			groupGuard: "上下文压力",
			groupEditing: "编辑",
			groupWorktree: "Worktree 车道",
			groupRobash: "只读 bash",
			groupLsp: "LSP 语义工具",
			groupNotify: "系统通知",
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
			editLockState_revoked: "编辑权已被永久撤销",
			editLockRevokedHint: "管理员恢复已永久撤销本会话的编辑权，无法继续编辑；请开新会话编辑本工作区。",
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
			editLockEnabledHint: "让多个会话轮流编辑同一批文件，而不是相互覆盖。重启 DeepSeek Harness 后生效。",
			editLockHoldDefaultMinutes: "编辑锁：回合结束后保留文件多久（助手未指定时）",
			editLockHoldSingleMaxMinutes: "编辑锁：单次申请最多保留多少分钟",
			editLockHoldCumulativeMaxMinutes: "编辑锁：一批文件回合结束后累计最多保留多少分钟",
			editLockNudgeAttempts: "编辑锁：回合结束后最多提醒几次去处理未释放的文件",
			editLockNudgeFallback: "编辑锁：提醒用完后的处置（release 自动释放 / abnormal 转为人工处理）",
			editLockAutoResume: "编辑锁：停止后发送消息即自动恢复编辑",
			editLockAutoResumeHint: "停止会话后，发送任意消息即恢复其编辑权限并确认保留的文件，无需手动点「继续编辑」（默认开启）。关闭则仍走手动确认。",
			editLockStaleSweep: "编辑锁：静默清理目标已消失的失效锁",
			editLockStaleSweepHint: "你发送任意消息时，目标文件已被删除或移动的锁会在仲裁点复核后被静默释放（默认开启）。关闭则只能手动解锁。",
			editLockHoldDefaultMinutesHint: "助手未指定时，文件在回合结束后继续保留的分钟数（默认 30）。",
			editLockHoldSingleMaxMinutesHint: "单次保留申请的上限分钟数（默认 30）。",
			editLockHoldCumulativeMaxMinutesHint: "一批文件在回合结束后累计最多保留的分钟数；用尽后只能释放（默认 120）。",
			editLockNudgeAttemptsHint: "回合结束后最多提醒几次，去处理未释放的文件（默认 2）。",
			editLockNudgeFallbackHint: "release 把文件让给其他会话；abnormal 保留下来等你处理（默认 release）。",
			editLockMaint: "编辑锁维护",
			editLockMaintHint: "整个 profile 的强制执行状态与只读权威诊断。",
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
			editLockMaintScopeNote: "该开关对整个 profile 生效：覆盖此 profile 下的所有 Orrery 会话，而非某一个工作区。",
			editLockMaintWarnKeepHistory: "关闭强制执行不会清除未决操作、围栏或历史——重新打开后同一批文件可能再次被阻塞。",
			editLockMaintWarnUnlock: "普通解锁只释放一把锁且不校验内容；它不是历史恢复，永远不会结清未知的发布。",
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
			worktreeEnabledHint: "总开关：车道工具、/worktree 命令、Worktree 模式与 Worktrees 面板（true/false）。",
			worktreeAutoSetup: "新车道自动安装依赖",
			worktreeAutoSetupHint: "开车道时执行仓库配置的 setup，或按 lockfile 推导的安装命令（true/false）。",
			worktreeMaxActive: "活跃车道上限",
			worktreeMaxActiveHint: "每个仓库同时活跃的车道数上限（默认 4）。",
			worktreeRoot: "车道目录",
			worktreeRootHint: "仓库内存放车道的相对目录（默认 .orrery/worktrees），通过 .git/info/exclude 本地忽略，不改动任何入库文件。",
			worktreeWatchTimeoutMinutes: "车道订阅超时",
			worktreeWatchTimeoutMinutesHint: "worktree_watch 订阅等待目标状态的分钟数，到期投递一条过期通知（默认 360 = 6 小时，最小 1）；已建立的订阅按建立时的期限不变。",
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
			notifyEnabled: "系统通知",
			notifyEnabledHint: "总开关：会话需要你处理、或一轮任务结束时发送系统通知（true/false）。",
			notifyOnComplete: "完成时通知",
			notifyOnCompleteHint: "一轮任务结束且耗时超过下方最短时长时通知（true/false）。",
			notifyOnAttention: "需要处理时通知",
			notifyOnAttentionHint: "审批请求、提问、计划评审、任务失败或中止时通知（true/false）。",
			notifyMinTurnSeconds: "最短任务时长（秒）",
			notifyMinTurnSecondsHint: "一轮任务至少运行这么久才会通知完成；0 表示每轮都通知。",
			notifySound: "通知提示音",
			notifySoundHint: "在支持的平台上播放系统通知提示音（true/false）。",
			notifyForeground: "窗口在前台时",
			notifyForegroundHint: "DeepSeek Harness 窗口在前台时是否通知。「不通知」表示你正看着窗口、不打扰；「始终通知」则前台也通知。",
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
			worktreeUnmanaged: "车道目录下有 {n} 个不由 Orrery 管理的 worktree",
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
			worktreeConfigHint: "只写入本仓库（.orrery/worktrees/.config.json，不入库）。车道检查时在该车道内执行这些命令。",
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
			"capability.missing": "缺失",
			"capability.noSkills": "没有匹配的技能。",
			"capability.mcp.groupManaged": "Orrery 管理",
			"capability.mcp.groupUnmanaged": "未纳入管理",
			"capability.mcp.none": "未配置 MCP server。",
			"capability.mcp.unmanagedHint": "在 Orrery 之外配置，会话选择无法管理它。",
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
			"capability.appliedSkipped": "已跳过 {n} 项（当前预设不适用）",
			"capability.failed": "失败——草稿已保留",
			"capability.conflictState": "已在别处变更——请核对当前状态",
			"capability.missingAction": "缺失项需要安装/配置",
			"capability.pending": "结果待确认——请查询回执",
			"capability.presets.unavailable": "预设在此宿主上不可用。",
			"capability.presets.errorName": "请输入名称。",
			"capability.presets.saved": "预设已保存。",
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
			"capability.presets.scopeUser": "用户"
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
		const LSP_PROJECTION_KEY = "orreryLsp";
		// sidebarRight / sidebarRightTabs are OPTIONAL (a shell without the
		// right sidebar keeps every other worktree surface): they are reached
		// through ctx.inject([...]) below, not through this list.
		const inject = ["slots", "locale", "configForms", "remote", "remote.session", "remote.commands", "connection"];
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-orrery-settings: dictionaries");
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
			}, "ui-orrery-settings: web notification delivery");
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
				const response = await fetch("api/orrery-worktree/view", {
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
				const response = await fetch("api/orrery-worktree/diff", {
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
				id: "orrery-worktree-marker",
				order: 30,
				locale: NS,
				inject: (sessionId) => (sessionId ? { sessionId } : {})
			}, WorktreeRowWrapper)), "ui-orrery-settings: worktree session marker");
			// U2: session header pill (click opens the panel).
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "orrery-worktree-pill",
				order: 10,
				locale: NS,
				inject: (sessionId) => (sessionId ? {
					sessionId,
					fetchView: () => worktreeView(sessionId),
					commandsList: () => worktreeCommandsList(sessionId),
					openPanel: () => {
						try { ctx.get("sidebarRight")?.openTab?.("orrery-worktrees"); } catch { /* no sidebar in this shell */ }
					}
				} : {})
			}, WorktreePillWrapper)), "ui-orrery-settings: worktree header pill");
			// U6: one keyed tool view per lane tool (six), all backed by the same chunk.
			for (const toolName of ["worktree_open", "worktree_check", "worktree_land", "worktree_cleanup", "worktree_abandon", "worktree_watch"]) {
				ctx.effect(() => ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: toolName,
					locale: NS
				}, WorktreeToolViewWrapper)), `ui-orrery-settings: ${toolName} toolview`);
			}
			// U3: the lanes panel as a right-sidebar page tab. Registered only
			// where the sidebar right package is mounted (optional inject), so a
			// composition without it keeps every other surface.
			ctx.inject?.(["sidebarRightTabs"], (sidebarScope) => {
				const tabId = "orrery-worktrees";
				const kind = "orrery-worktrees";
				sidebarScope.effect(() => sidebarScope.sidebarRightTabs.register({
					id: tabId,
					kind,
					priority: "extension",
					title: () => sidebarScope.locale.bind(NS)("worktreeTabLabel"),
					guide: [{
						id: "worktree",
						order: 30,
						title: () => sidebarScope.locale.bind(NS)("worktreeGuideTitle"),
						description: () => sidebarScope.locale.bind(NS)("worktreeGuideDescription")
					}]
				}), "ui-orrery-settings: worktree tab type");
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
				}, WorktreePanelWrapper), "ui-orrery-settings: worktree panel body");
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
			// POST /api/orreryCapabilities/<method> with an { args } payload,
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
				console.warn(`[orrery] capability read degraded (${kind}${method ? `, ${method}` : ""})`, detail ?? "");
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
					result = await connection.rpc.call("/api", `orreryCapabilities/${method}`, { args: { sessionId: sid } });
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
			// the same data sources (reads via the orreryCapabilities remote,
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
				applySelection: (sid, draft) => capabilityPayload(sid, `/capabilities apply ${JSON.stringify(draft)}`),
				mcpAdd: (sid, spec) => capabilityPayload(sid, `/capabilities mcp-add ${JSON.stringify(spec)}`),
				fetchListing: (sid) => capabilityRead("list", sid, { error: true }),
				fetchConditions: (sid) => capabilityRead("conditions", sid, { error: true }),
				loadPresets: () => loadCapabilityPresetsChunk(),
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
				id: "orrery-capability-badge",
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
								try { ctx.get("sidebarRight")?.openTab?.("orrery-capabilities"); } catch { /* no sidebar in this shell */ }
							}
						} : {})
					};
				}
			}, CapabilityBadgeWrapper)), "ui-orrery-settings: capability badge");
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
				const tabId = "orrery-capabilities";
				sidebarScope.effect(() => sidebarScope.sidebarRightTabs.register({
					id: tabId,
					kind: "orrery-capabilities",
					priority: "extension",
					title: () => sidebarScope.locale.bind(NS)("capabilityTabLabel"),
					guide: [{
						id: "capabilities",
						order: 40,
						title: () => sidebarScope.locale.bind(NS)("capabilityGuideTitle"),
						description: () => sidebarScope.locale.bind(NS)("capabilityGuideDescription")
					}]
				}), "ui-orrery-settings: capability tab type");
				sidebarScope.effect(() => sidebarScope.slots.register({
					name: "sidebar.right.pane.tab",
					key: tabId,
					locale: NS,
					inject: (sessionId) => (sessionId ? capabilityVerbs(sessionId) : {})
				}, CapabilityPanelWrapper), "ui-orrery-settings: capability panel body");
			});
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
					dismissRestartReminder: () => controller?.inject().dismissRestartReminder(),
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
							require.async("./client.lsp-model.js"),
							require.async("./client.notify-permissions.js"),
							require.async("./client.edit-lock-maintenance.js")
						]).then(([settingsPage, chainEditor, robashEditor, disabledCategoriesEditor, lspPanel, chainModel, robashModel, lspModel, notifyPermissions, editLockMaintenance]) => {
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
