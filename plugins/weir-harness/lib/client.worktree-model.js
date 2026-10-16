window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.worktree-model.js",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Worktree lanes view model: pure helpers shared by every worktree
		// surface (session row marker, header pill, lanes panel, composer mode
		// switch, tool views). Zero dependencies; every wire value is narrowed
		// defensively so a malformed view or replayed tool meta never throws.
		const WORKTREE_PROJECTION_KEY = "weirWorktree";
		const TOOLS = ["worktree_open", "worktree_check", "worktree_land", "worktree_cleanup", "worktree_abandon", "worktree_watch"];
		const FINISHED = ["landed", "kept", "cleaned", "abandoned"];
		const TRANSIENT = ["preparing", "working", "checking", "awaiting-approval"];
		/** State → tone group (badge colour family). */
		const TONE = {
			preparing: "progress", working: "progress", checking: "progress",
			ready: "neutral", declined: "neutral",
			"setup-failed": "attention", dirty: "attention", "no-commits": "attention", "branch-moved": "attention", "check-failed": "attention", conflicted: "attention",
			"awaiting-approval": "approval",
			landable: "ready",
			landed: "done", kept: "done", cleaned: "done", abandoned: "done"
		};
		/** Tone → theme token (light and dark both define these aliases). */
		const TONE_COLOR = {
			progress: "var(--dsw-alias-state-business-primary)",
			neutral: "var(--dsw-alias-label-tertiary)",
			attention: "var(--dsw-alias-state-error-primary)",
			approval: "var(--dsw-alias-state-warn-primary)",
			ready: "var(--dsw-alias-state-success-primary, var(--dsw-alias-state-business-primary))",
			done: "var(--dsw-alias-label-tertiary)"
		};
		const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
		const str = (value) => (typeof value === "string" ? value : null);
		const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
		function toneOf(state) {
			return TONE[state] ?? "neutral";
		}
		function colorOf(state) {
			return TONE_COLOR[toneOf(state)];
		}
		/** Narrow one lane record from the view endpoint. */
		function narrowLane(raw) {
			if (!isObject(raw) || !str(raw.id) || !str(raw.state)) return null;
			const actions = {};
			for (const [key, value] of Object.entries(isObject(raw.actions) ? raw.actions : {})) {
				if (isObject(value)) actions[key] = { enabled: value.enabled === true, reason: str(value.reason) };
			}
			const stat = isObject(raw.stat) ? { files: num(raw.stat.files) ?? 0, added: num(raw.stat.added) ?? 0, removed: num(raw.stat.removed) ?? 0 } : null;
			const check = isObject(raw.check) ? {
				enabled: raw.check.enabled === true,
				tree: str(raw.check.tree),
				results: Array.isArray(raw.check.results) ? raw.check.results.filter(isObject).map((entry) => ({ name: str(entry.name) ?? "?", exit: num(entry.exit), ms: num(entry.ms), log: str(entry.log) })) : []
			} : null;
			const history = Array.isArray(raw.history) ? raw.history.filter(isObject) : [];
			return {
				id: raw.id,
				title: str(raw.title) ?? raw.id,
				state: raw.state,
				reason: str(raw.reason),
				path: str(raw.path),
				branch: str(raw.branch),
				base: isObject(raw.base) ? str(raw.base.branch) : null,
				scope: Array.isArray(raw.scope) ? raw.scope.filter((entry) => typeof entry === "string") : [],
				ahead: num(raw.ahead),
				behind: num(raw.behind),
				stat,
				check,
				landableTree: str(raw.landableTree),
				baseMoved: raw.baseMoved === true,
				watchCount: num(raw.watchCount) ?? 0,
				watchStates: Array.isArray(raw.watchStates) ? raw.watchStates.filter((entry) => typeof entry === "string") : [],
				boundChild: str(raw.boundChild),
				ownerSession: str(raw.ownerSession),
				exists: raw.exists !== false,
				next: isObject(raw.next) ? raw.next : null,
				transient: TRANSIENT.includes(raw.state),
				conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter((entry) => typeof entry === "string") : [],
				merge: isObject(raw.land) ? { commit: str(raw.land.commit), at: num(raw.land.at), by: str(raw.land.by) } : null,
				cleanup: isObject(raw.cleanup) ? { mode: str(raw.cleanup.mode) } : null,
				updatedAt: num(raw.updatedAt) ?? num(history.at(-1)?.at),
				actions
			};
		}
		/** Narrow the whole view; null for anything that is not a view. */
		function narrowView(raw) {
			if (!isObject(raw)) return null;
			const lanes = Array.isArray(raw.lanes) ? raw.lanes.map(narrowLane).filter(Boolean) : [];
			const repo = isObject(raw.repo) ? {
				mainRoot: str(raw.repo.mainRoot),
				root: str(raw.repo.root),
				branch: str(raw.repo.branch),
				gitVersion: str(raw.repo.gitVersion),
				exclude: raw.repo.exclude === true,
				verification: isObject(raw.repo.verification) ? {
					enabled: raw.repo.verification.enabled === true,
					commands: Array.isArray(raw.repo.verification.commands) ? raw.repo.verification.commands.filter((entry) => typeof entry === "string") : [],
					error: str(raw.repo.verification.error)
				} : { enabled: false, commands: [], error: null }
			} : null;
			return {
				available: raw.available === true,
				enabled: raw.enabled !== false,
				mode: raw.mode === true,
				approveMode: str(raw.approveMode),
				approveModeSource: str(raw.approveModeSource),
				error: isObject(raw.error) ? { code: str(raw.error.code) ?? "ERROR", message: str(raw.error.message) ?? "" } : null,
				repo,
				lanes,
				owned: Array.isArray(raw.ownedBySession) ? raw.ownedBySession.filter((entry) => typeof entry === "string") : [],
				unmanaged: Array.isArray(raw.unmanaged) ? raw.unmanaged.filter((entry) => typeof entry === "string") : []
			};
		}
		/** Active / history split, newest first within each group. */
		function groupLanes(lanes) {
			const byRecent = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
			return {
				active: lanes.filter((lane) => !FINISHED.includes(lane.state)).sort(byRecent),
				history: lanes.filter((lane) => FINISHED.includes(lane.state)).sort(byRecent)
			};
		}
		/** Counts for the session marker and header pill (owned lanes only when known). */
		function summaryOf(view, ownedOnly = true) {
			if (!isObject(view)) return { active: 0, awaiting: 0, attention: 0, baseMoved: false, mode: false };
			// Degraded endpoint shapes (WORKTREE_DISABLED / SESSION_NOT_LIVE) and
			// malformed payloads may lack these arrays — never read .length/.some
			// on an unchecked field.
			const all = Array.isArray(view.lanes) ? view.lanes.filter(isObject) : [];
			const owned = Array.isArray(view.owned) ? view.owned : [];
			const lanes = ownedOnly && owned.length ? all.filter((lane) => owned.includes(lane.id)) : all;
			const active = lanes.filter((lane) => !FINISHED.includes(lane.state));
			return {
				active: active.length,
				awaiting: active.filter((lane) => lane.state === "awaiting-approval").length,
				attention: active.filter((lane) => toneOf(lane.state) === "attention").length,
				baseMoved: active.some((lane) => lane.baseMoved),
				mode: view.mode === true
			};
		}
		/** Whether the panel should keep polling (a host-side transition is due). */
		function needsPolling(view) {
			return Boolean(isObject(view) && Array.isArray(view.lanes) && view.lanes.some((lane) => isObject(lane) && lane.transient === true));
		}
		/** The /worktree command line one panel action runs (null = not a command). */
		function commandFor(action, lane, option) {
			const id = lane.id;
			switch (action) {
				case "check": return `check ${id}`;
				case "land": return `land ${id}`;
				case "setup": return option === "skip" ? `setup ${id} --skip` : `setup ${id}`;
				case "clean": return ["keep", "worktree", "all"].includes(option) ? `clean ${id} ${option}` : null;
				// Bare abandon (no cleanup mode) is a valid command: the host
				// answers with the abandon decision card and the mode is chosen
				// there. Only an invalid non-empty mode is not a command.
				case "abandon":
					if (option === undefined || option === null || option === "") return `abandon ${id}`;
					return ["keep", "worktree", "all"].includes(option) ? `abandon ${id} ${option}` : null;
				default: return null;
			}
		}
		/** A panel command line that must never be dispatched: null, non-string,
		 * or blank (template-string coercion would turn those into a literal
		 * "null"/"undefined" verb). */
		function lineProblem(line) {
			return typeof line !== "string" || line.trim() === "";
		}
		/** The command layer answers an unknown verb with its full usage dump —
		 * correct feedback for hand-typed input, but the panel maps it to one
		 * concise localized error instead of showing the raw English dump. */
		function isUsageDump(text) {
			return typeof text === "string" && text.startsWith("Usage: /worktree");
		}
		/** Actions that change something irreversibly need a second click. */
		function needsConfirm(action, option) {
			return action === "land" || (action === "abandon" && option !== "keep") || (action === "clean" && option === "all");
		}
		/** Render a `next` hint for people. */
		function nextText(next) {
			if (!isObject(next)) return null;
			if (str(next.waitFor)) return `${next.waitFor}${str(next.hint) ? ` — ${next.hint}` : ""}`;
			if (str(next.tool)) return `${next.tool}${str(next.hint) ? ` — ${next.hint}` : ""}`;
			return null;
		}
		/** Narrow a persisted worktree_watch subscription; wrong field types void it. */
		function narrowWatch(value) {
			if (!isObject(value) || !Array.isArray(value.states)) return null;
			if (value.expiresAt !== undefined && value.expiresAt !== null && num(value.expiresAt) === null) return null;
			return { states: value.states.filter((entry) => typeof entry === "string"), expiresAt: num(value.expiresAt) };
		}
		/** Narrow persisted tool meta (tool/result.meta.worktree). */
		function narrowToolMeta(meta) {
			const raw = isObject(meta) ? meta.worktree : null;
			if (!isObject(raw) || !TOOLS.includes(raw.tool) || !str(raw.state)) return null;
			return {
				tool: raw.tool,
				lane: str(raw.lane),
				state: raw.state,
				from: str(raw.from),
				summary: str(raw.summary) ?? "",
				next: isObject(raw.next) ? raw.next : null,
				merge: isObject(raw.merge) ? { commit: str(raw.merge.commit), stat: isObject(raw.merge.stat) ? { files: num(raw.merge.stat.files) ?? 0, added: num(raw.merge.stat.added) ?? 0, removed: num(raw.merge.stat.removed) ?? 0 } : null } : null,
				conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.filter((entry) => typeof entry === "string") : [],
				check: (Array.isArray(raw.check) ? raw.check : isObject(raw.check) && Array.isArray(raw.check.results) ? raw.check.results : []).filter(isObject).map((entry) => ({ name: str(entry.name) ?? "?", exit: num(entry.exit), ms: num(entry.ms) })),
				diff: str(raw.diff),
				cleanup: isObject(raw.cleanup) ? { state: str(raw.cleanup.state), summary: str(raw.cleanup.summary), error: str(raw.cleanup.error) } : null,
				watch: narrowWatch(raw.watch),
				hit: str(raw.hit)
			};
		}
		/** Classify unified-diff lines for colouring. */
		function diffLines(text, limit = 2000) {
			if (typeof text !== "string" || text === "") return [];
			const lines = text.split("\n");
			const out = lines.slice(0, limit).map((line) => ({
				text: line,
				kind: line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : "context"
			}));
			if (lines.length > limit) out.push({ text: `… ${lines.length - limit} more line(s)`, kind: "meta" });
			return out;
		}
		/** Relative "x min ago" without Intl dependencies on old engines. */
		function ago(at, now = Date.now()) {
			if (typeof at !== "number") return "";
			const seconds = Math.max(0, Math.round((now - at) / 1000));
			if (seconds < 60) return `${seconds}s`;
			if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
			if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
			return `${Math.round(seconds / 86400)}d`;
		}
		/** Parse `/worktree init` output (JSON text) into suggestions. */
		function parseInit(text) {
			try {
				const value = JSON.parse(text);
				if (!isObject(value)) return null;
				const current = isObject(value.current) ? value.current : null;
				const suggested = isObject(value.suggested) ? value.suggested : {};
				return {
					file: str(value.file),
					error: str(value.error),
					current: current ? { setup: str(current.setup), check: Array.isArray(current.check) ? current.check.filter(isObject) : [] } : null,
					suggested: { setup: str(suggested.setup), setupWarning: str(suggested.setupWarning), check: Array.isArray(suggested.check) ? suggested.check.filter(isObject) : [] }
				};
			} catch {
				return null;
			}
		}
		/** Serialize the config editor rows into the /worktree init write payload. */
		function configPayload(setup, rows) {
			const check = rows
				.map((row) => ({ name: String(row.name ?? "").trim(), run: String(row.run ?? "").trim() }))
				.filter((row) => row.name !== "" && row.run !== "");
			const payload = { check };
			if (typeof setup === "string" && setup.trim() !== "") payload.setup = setup.trim();
			return JSON.stringify(payload);
		}
		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under
		// "settings.weir.worktree" inside a ctx.effect when this chunk arrives
		// (lib/client.js registerChunkDictionaries). Keys stay "worktree"-prefixed:
		// the views name them unprefixed and the entry’s worktreeT seat re-prefixes.
		// Only the apply-time strings the entry’s synchronous surfaces read stay
		// entry-side (tab title/guide thunks and the panel’s pre-arrival
		// worktreeLoading — byte-identical in both homes, a documented
		// cross-namespace duplicate). Pinned by test/client-worktree-labels.test.js
		// and test/client.test.js’s dictionary union pin.
		const dictionaries = {
			en: {
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
			},
			zh: {
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
			},
		};

		exports.dictionaries = dictionaries;
		exports.WORKTREE_PROJECTION_KEY = WORKTREE_PROJECTION_KEY;
		exports.WORKTREE_TOOLS = TOOLS;
		exports.FINISHED = FINISHED;
		exports.toneOf = toneOf;
		exports.colorOf = colorOf;
		exports.narrowLane = narrowLane;
		exports.narrowView = narrowView;
		exports.groupLanes = groupLanes;
		exports.summaryOf = summaryOf;
		exports.needsPolling = needsPolling;
		exports.commandFor = commandFor;
		exports.lineProblem = lineProblem;
		exports.isUsageDump = isUsageDump;
		exports.needsConfirm = needsConfirm;
		exports.nextText = nextText;
		exports.narrowToolMeta = narrowToolMeta;
		exports.diffLines = diffLines;
		exports.ago = ago;
		exports.parseInit = parseInit;
		exports.configPayload = configPayload;
		return module.exports;
	}
});
