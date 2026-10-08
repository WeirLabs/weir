window.__ModuleLoader__.load({
	id: "weir-harness",
	chunk: "client.settings-page.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// The model picker is a sibling package-local chunk: the composition root
		// loads it on its own arrival state and hands it down as `props.modelPicker`
		// (absent = still in flight or failed; the row degrades to plain fields).
		// Weir settings page: one form over the `weir-settings` namespace
		// (the shared SettingsFormModel only addresses flat fields), organized
		// as card sections with conditional rows (`when`) and nested
		// sub-settings (`parent`). The special field editors (chain/robash
		// list/LSP manager/notify permissions/Edit Lock maintenance) arrive as
		// props from the composition root; `settingsBus` and the lazily
		// evaluated `getSession` closure are prop-injected (S17). WEIR_NS is
		// a verbatim copy of the entry constant (same-package sync require is
		// impossible in the ModuleLoader).
		const WEIR_NS = "weir-settings";
		// Host environment-facts endpoint (src/settings/env-admin.js): read
		// once per page arrival, POST like the other weir-* fetch endpoints.
		const ENV_PATH = "api/weir-settings/env";
		// Environment fact names a `when` condition may reference. Keep in sync
		// with the facts the endpoint answers (platform today); validateLayout
		// fails module load on any other name.
		const ENV_FACTS = ["platform"];
		// Curated read-only agent names, in registry order — the SINGLE
		// client-side source for the agent chain-editor lanes (do not scatter).
		// test/client-settings-page.test.js pins this list to
		// Object.keys(CURATED_AGENTS) from src/delegate/agents.js, so a registry
		// rename cannot drift the two sides.
		const CURATED_AGENT_NAMES = ["finder", "scholar", "advisor"];
		// Delegation category names, in registry order — the SINGLE client-side
		// source for the disabled-categories editor rows (do not scatter).
		// test/client-settings-page.test.js pins this list to
		// Object.keys(DEFAULT_CATEGORIES) from src/delegate/categories.js, so a
		// registry change cannot drift the two sides.
		const CATEGORY_NAMES = ["quick", "deep", "deep-plus", "visual", "writing", "general-low", "general-high", "artistry", "architect"];
		// Restart-required settings keys, in registry order — the SINGLE
		// client-side source for the post-save restart reminder AND the
		// always-on inline restart tag (same list, one source; do not
		// scatter). test/client-settings-page.test.js pins this list to
		// RESTART_KEYS from src/settings/sections.js, so a declaration
		// change on either side cannot drift the two sides.
		const RESTART_FIELDS = ["intentGateClassifier", "intentGateProvider", "intentGateModel", "intentGateReasoningEffort", "intentGateTimeoutMs", "jevEndpoint", "jevModel", "jevApiKeyEnv", "todoEnabled", "todoMaxConsecutive", "todoErrorRetryMax", "todoErrorBackoffBaseMs", "todoErrorBackoffCapMs", "guardEnabled", "guardSoftThreshold", "guardHardThreshold", "hashlineHideStockEdit", "editLockEnabled"];
		// ---- condition declaration shorthands (frozen pure data, D2) ----
		const enabledWhen = (key) => Object.freeze({ key, equals: true });
		const CLASSIFIER_LLM = Object.freeze({ key: "intentGateClassifier", equals: "llm" });
		const CLASSIFIER_JEV = Object.freeze({ key: "intentGateClassifier", equals: "jev" });
		const WINDOWS_ONLY = Object.freeze({ env: "platform", in: Object.freeze(["win32"]) });
		const ROBASH_WINDOWS = Object.freeze({ all: Object.freeze([enabledWhen("robashEnabled"), WINDOWS_ONLY]) });
		// The GROUPS field table. Every node: { field?, kind, values?, display?,
		// when?, parent?, folded?, slot? }. kind: boolean | enum | number | text |
		// custom. An enum node may set `display: "select"` to render a compact
		// native dropdown instead of the segmented control (long option labels
		// squeeze the row label). `custom` nodes carry a render `slot` identifier
		// and share
		// parent/when with plain rows; a custom node with a `field` is
		// text-backed at the form layer. `folded` fields stay in the form but
		// render inside another row (the model picker folds intentGateModel /
		// intentGateReasoningEffort into the intentGateProvider row; their
		// `when` matches the carrier row by declaration). Field-less custom
		// nodes (maintenance/permission panels) hang in the same tree.
		const GROUPS = [
			{ id: "intent", fields: [
				{ field: "intentGateClassifier", kind: "enum", values: ["regex", "llm", "jev"] },
				{ field: "intentGateProvider", kind: "custom", slot: "modelPicker", when: CLASSIFIER_LLM },
				{ field: "intentGateModel", kind: "text", folded: true, when: CLASSIFIER_LLM },
				{ field: "intentGateReasoningEffort", kind: "text", folded: true, when: CLASSIFIER_LLM },
				{ field: "intentGateTimeoutMs", kind: "number" },
				{ field: "jevEndpoint", kind: "text", when: CLASSIFIER_JEV },
				{ field: "jevModel", kind: "text", when: CLASSIFIER_JEV },
				{ field: "jevApiKeyEnv", kind: "text", when: CLASSIFIER_JEV }
			] },
			{ id: "delegate", fields: [
				{ field: "delegateCategoryChains", kind: "custom", slot: "chainEditor" },
				{ field: "delegateAgentChains", kind: "custom", slot: "agentChainEditor" },
				{ field: "delegateDisabledCategories", kind: "custom", slot: "disabledCategoriesEditor" },
				{ field: "supervisionMaxRetries", kind: "number" },
				{ field: "supervisionInitialBackoffMs", kind: "number" },
				{ field: "supervisionMaxBackoffMs", kind: "number" }
			] },
			{ id: "todo", fields: [
				{ field: "todoEnabled", kind: "boolean" },
				{ field: "todoMaxConsecutive", kind: "number", parent: "todoEnabled", when: enabledWhen("todoEnabled") },
				{ field: "todoErrorRetryMax", kind: "number", parent: "todoEnabled", when: enabledWhen("todoEnabled") },
				{ field: "todoErrorBackoffBaseMs", kind: "number", parent: "todoEnabled", when: enabledWhen("todoEnabled") },
				{ field: "todoErrorBackoffCapMs", kind: "number", parent: "todoEnabled", when: enabledWhen("todoEnabled") }
			] },
			{ id: "guard", fields: [
				{ field: "guardEnabled", kind: "boolean" },
				{ field: "guardSoftThreshold", kind: "number", parent: "guardEnabled", when: enabledWhen("guardEnabled") },
				{ field: "guardHardThreshold", kind: "number", parent: "guardEnabled", when: enabledWhen("guardEnabled") }
			] },
			{ id: "editing", fields: [
				{ field: "hashlineHideStockEdit", kind: "boolean" },
				{ field: "editLockEnabled", kind: "boolean" },
				{ field: "editLockAutoResume", kind: "boolean", parent: "editLockEnabled", when: enabledWhen("editLockEnabled") },
				{ field: "editLockStaleSweep", kind: "boolean", parent: "editLockEnabled", when: enabledWhen("editLockEnabled") },
				{ field: "editLockHoldDefaultMinutes", kind: "number", parent: "editLockEnabled", when: enabledWhen("editLockEnabled") },
				{ field: "editLockHoldSingleMaxMinutes", kind: "number", parent: "editLockEnabled", when: enabledWhen("editLockEnabled") },
				{ field: "editLockHoldCumulativeMaxMinutes", kind: "number", parent: "editLockEnabled", when: enabledWhen("editLockEnabled") },
				{ field: "editLockNudgeAttempts", kind: "number", parent: "editLockEnabled", when: enabledWhen("editLockEnabled") },
				{ field: "editLockNudgeFallback", kind: "text", parent: "editLockEnabled", when: enabledWhen("editLockEnabled") },
				{ kind: "custom", slot: "editLockMaintenance", parent: "editLockEnabled", when: enabledWhen("editLockEnabled") }
			] },
			{ id: "worktree", fields: [
				{ field: "worktreeEnabled", kind: "boolean" },
				{ field: "worktreeAutoSetup", kind: "boolean", parent: "worktreeEnabled", when: enabledWhen("worktreeEnabled") },
				{ field: "worktreeMaxActive", kind: "number", parent: "worktreeEnabled", when: enabledWhen("worktreeEnabled") },
				{ field: "worktreeRoot", kind: "text", parent: "worktreeEnabled", when: enabledWhen("worktreeEnabled") },
				{ field: "worktreeWatchTimeoutMinutes", kind: "number", parent: "worktreeEnabled", when: enabledWhen("worktreeEnabled") },
				{ field: "worktreeAutoApprove", kind: "enum", values: ["manual", "auto-keep", "auto-clean"], display: "select", parent: "worktreeEnabled", when: enabledWhen("worktreeEnabled") }
			] },
			{ id: "robash", fields: [
				{ field: "robashEnabled", kind: "boolean" },
				{ field: "robashAllow", kind: "custom", slot: "robashList", parent: "robashEnabled", when: enabledWhen("robashEnabled") },
				{ field: "robashGitAllow", kind: "custom", slot: "robashList", parent: "robashEnabled", when: enabledWhen("robashEnabled") },
				{ field: "robashDeny", kind: "custom", slot: "robashList", parent: "robashEnabled", when: enabledWhen("robashEnabled") },
				{ field: "robashPwshAllow", kind: "custom", slot: "robashList", parent: "robashEnabled", when: ROBASH_WINDOWS },
				{ field: "robashPwshDeny", kind: "custom", slot: "robashList", parent: "robashEnabled", when: ROBASH_WINDOWS }
			] },
			{ id: "lsp", fields: [
				{ field: "lspEnabled", kind: "boolean" },
				{ field: "lspIdleMs", kind: "number", parent: "lspEnabled", when: enabledWhen("lspEnabled") },
				{ field: "lspRequestTimeoutMs", kind: "number", parent: "lspEnabled", when: enabledWhen("lspEnabled") },
				{ field: "lspDiagnosticsWaitMs", kind: "number", parent: "lspEnabled", when: enabledWhen("lspEnabled") },
				// The raw lspServers JSON row is folded into the manager row: one
				// custom node carrying the field (the robashList pattern —
				// text-backed at the form layer via specFor), so the panel owns the
				// overridden/reset affordance and the malformed-JSON hint.
				{ field: "lspServers", kind: "custom", slot: "lspManager", parent: "lspEnabled", when: enabledWhen("lspEnabled") }
			] },
			{ id: "notify", fields: [
				{ field: "notifyEnabled", kind: "boolean" },
				{ field: "notifyOnComplete", kind: "boolean", parent: "notifyEnabled", when: enabledWhen("notifyEnabled") },
				{ field: "notifyOnAttention", kind: "boolean", parent: "notifyEnabled", when: enabledWhen("notifyEnabled") },
				// two-level nesting: the minimum turn length is a sub-setting of
				// the completion switch, itself a child of the master switch
				{ field: "notifyMinTurnSeconds", kind: "number", parent: "notifyOnComplete", when: enabledWhen("notifyOnComplete") },
				{ field: "notifySound", kind: "boolean", parent: "notifyEnabled", when: enabledWhen("notifyEnabled") },
				{ field: "notifyForeground", kind: "enum", values: ["skip", "always"], parent: "notifyEnabled", when: enabledWhen("notifyEnabled") },
				// macOS-only permission entry: it renders nothing until the host
				// confirms its platform (self-gating), so it stays unconditional
				// here even as a custom node in the tree.
				{ kind: "custom", slot: "notifyPermissions" }
			] },
			// Session blackboard (2.4a): the write-token TTL leaves
			// config-face-only and rides its own group. A single live number row
			// (volatile config — no restart marker, no master switch).
			{ id: "blackboard", fields: [
				{ field: "blackboardWriteTokenTtlMinutes", kind: "number" }
			] }
		];
		// Form fields: every node that names a flat settings key (custom
		// panels without a field render only). Order matches the pre-overhaul
		// flat table exactly — test pins this list.
		const FIELDS = GROUPS.flatMap((group) => group.fields).filter((descriptor) => typeof descriptor.field === "string");
		const FIELD_BY_NAME = Object.fromEntries(FIELDS.map((descriptor) => [descriptor.field, descriptor]));
		/** Product defaults of every flat settings key with a concrete
		 * default — hand-maintained mirror of FIELD_DEFAULTS in
		 * src/settings/sections.js (same-package sync require is impossible
		 * in the ModuleLoader, same pattern as RESTART_FIELDS; drift pinned
		 * by test). A profile-level row replaces the bundle's weir-settings
		 * row wholesale, so a key the profile never saved arrives unset; the
		 * page then shows the value the modules actually use. Keys where
		 * unset is meaningful (route overrides, chains, whitelist tables,
		 * lspServers) have no entry. */
		const FIELD_DEFAULTS = Object.freeze({
			intentGateClassifier: "regex",
			intentGateTimeoutMs: 1500,
			jevModel: "jev",
			supervisionMaxRetries: 5,
			supervisionInitialBackoffMs: 30000,
			supervisionMaxBackoffMs: 300000,
			todoEnabled: true,
			todoMaxConsecutive: 8,
			todoErrorRetryMax: 5,
			todoErrorBackoffBaseMs: 30000,
			todoErrorBackoffCapMs: 300000,
			guardEnabled: true,
			guardSoftThreshold: 0.72,
			guardHardThreshold: 0.88,
			hashlineHideStockEdit: true,
			editLockEnabled: false,
			editLockHoldDefaultMinutes: 30,
			editLockHoldSingleMaxMinutes: 30,
			editLockHoldCumulativeMaxMinutes: 120,
			editLockNudgeAttempts: 2,
			editLockNudgeFallback: "release",
			editLockAutoResume: true,
			editLockStaleSweep: true,
			robashEnabled: true,
			lspEnabled: false,
			lspIdleMs: 600000,
			lspRequestTimeoutMs: 15000,
			lspDiagnosticsWaitMs: 2000,
			worktreeEnabled: true,
			worktreeRoot: ".weir/worktrees",
			worktreeMaxActive: 4,
			worktreeAutoSetup: true,
			worktreeWatchTimeoutMinutes: 360,
			worktreeAutoApprove: "auto-clean",
			blackboardWriteTokenTtlMinutes: 60,
			notifyEnabled: true,
			notifyOnComplete: true,
			notifyOnAttention: true,
			notifyMinTurnSeconds: 15,
			notifySound: true,
			notifyForeground: "skip"
		});
		// The boolean subset of FIELD_DEFAULTS, derived (never a second
		// literal): the Switch's `checked` display and the `when` conditions
		// read it through productDefault.
		const BOOLEAN_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(FIELD_DEFAULTS).filter(([, value]) => typeof value === "boolean")));
		// ---- pure: condition DSL evaluation (design D2) ----
		/** Evaluate one condition node against a resolver pair:
		 * resolve.value(key) → the key's effective value, resolve.env(name) →
		 * the environment fact. Strict equality / strict membership; an
		 * unresolved value only matches an explicit `equals: undefined`. */
		function evaluateCondition(node, resolve) {
			if (Array.isArray(node?.all)) return node.all.every((child) => evaluateCondition(child, resolve));
			if (Array.isArray(node?.any)) return node.any.some((child) => evaluateCondition(child, resolve));
			if (node?.not !== void 0) return !evaluateCondition(node.not, resolve);
			if (typeof node?.key === "string") {
				const value = resolve.value(node.key);
				if (Object.hasOwn(node, "equals")) return value === node.equals;
				if (Array.isArray(node.in)) return node.in.includes(value);
				return false;
			}
			if (typeof node?.env === "string") {
				const value = resolve.env(node.env);
				if (Object.hasOwn(node, "equals")) return value === node.equals;
				if (Array.isArray(node.in)) return node.in.includes(value);
				return false;
			}
			return false;
		}
		/** Whether any node in the condition subtree references an environment
		 * fact — such rows render nothing until the facts arrive (and stay
		 * hidden after a failed fetch), even under `not`. */
		function conditionUsesEnv(node) {
			if (Array.isArray(node?.all)) return node.all.some(conditionUsesEnv);
			if (Array.isArray(node?.any)) return node.any.some(conditionUsesEnv);
			if (node?.not !== void 0) return conditionUsesEnv(node.not);
			return typeof node?.env === "string";
		}
		// ---- pure: effective value resolution (design D3) ----
		/** The product default for an unset key: booleans fall to the boolean
		 * subset of FIELD_DEFAULTS (off when unlisted, matching the switch's
		 * display rule); every other kind falls to FIELD_DEFAULTS itself
		 * (undefined when unlisted — never satisfies a condition unless it
		 * explicitly says `equals: undefined`). */
		function productDefault(descriptor) {
			if (descriptor.kind === "boolean") return BOOLEAN_DEFAULTS[descriptor.field] === true;
			return FIELD_DEFAULTS[descriptor.field];
		}
		/** What a resting input shows: the field's own text, or the formatted
		 * product default when that text is empty (the field is unset, or the
		 * user cleared it — the clear gesture falls back to the default).
		 * Display-only: save/staging/overridden semantics never read this, so
		 * an unset field showing its default stays non-overridden and is
		 * never written unless the user actually edits it. */
		function displayText(descriptor, field) {
			const text = field?.text ?? "";
			if (text !== "") return text;
			const fallback = FIELD_DEFAULTS[descriptor.field];
			return fallback === void 0 ? text : String(fallback);
		}
		/** Parse the field's display text the way the field's own spec would:
		 * { kind: "set", value } | { kind: "clear" } | undefined (unparseable). */
		function parseDraft(descriptor, text) {
			const trimmed = typeof text === "string" ? text.trim() : "";
			if (trimmed === "") return { kind: "clear" };
			if (descriptor.kind === "boolean") {
				const lowered = trimmed.toLowerCase();
				if (lowered === "true") return { kind: "set", value: true };
				if (lowered === "false") return { kind: "set", value: false };
				return void 0;
			}
			if (descriptor.kind === "enum") {
				return descriptor.values.includes(trimmed) ? { kind: "set", value: trimmed } : void 0;
			}
			if (descriptor.kind === "number") {
				const parsed = Number(trimmed);
				return Number.isFinite(parsed) ? { kind: "set", value: parsed } : void 0;
			}
			return { kind: "set", value: trimmed };
		}
		/** One effective-value resolver shared by the Switch's `checked`
		 * computation and every `when` evaluation, so display and conditions
		 * can never disagree. Priority (D3): parseable staged draft → saved
		 * value → product default. An empty draft is the clear gesture and
		 * resolves to the product default; an unparseable draft falls back to
		 * the saved value so dependent rows do not flicker while the user is
		 * mid-edit. With nothing staged, the field text IS the formatted
		 * saved value, so the same three branches cover the resting state. */
		function resolveEffectiveValue(descriptor, field, savedValue) {
			const draft = parseDraft(descriptor, field?.text ?? "");
			if (draft === void 0) return savedValue !== void 0 ? savedValue : productDefault(descriptor);
			if (draft.kind === "clear") return productDefault(descriptor);
			return draft.value;
		}
		// ---- pure: declaration validation + layout tree (design D4) ----
		function settingsLayoutError(message) {
			const error = new Error(`weir-settings layout: ${message}`);
			error.name = "SettingsLayoutError";
			return error;
		}
		function validatePredicate(node, owner) {
			const hasEquals = Object.hasOwn(node, "equals");
			const hasIn = Object.hasOwn(node, "in");
			if (hasEquals === hasIn) throw settingsLayoutError(`'${owner}' declares a condition needing exactly one of equals/in`);
			if (hasIn && !Array.isArray(node.in)) throw settingsLayoutError(`'${owner}' declares a non-array 'in' condition`);
		}
		function validateConditionNode(node, owner, knownKeys) {
			if (node === null || typeof node !== "object" || Array.isArray(node)) {
				throw settingsLayoutError(`'${owner}' declares a malformed condition`);
			}
			const branches = ["key", "env", "all", "any", "not"].filter((branch) => node[branch] !== void 0);
			if (branches.length !== 1) {
				throw settingsLayoutError(`'${owner}' declares a malformed condition (exactly one of key/env/all/any/not)`);
			}
			if (node.key !== void 0) {
				if (typeof node.key !== "string" || !knownKeys.has(node.key)) {
					throw settingsLayoutError(`'${owner}' declares a condition on unknown key '${String(node.key)}'`);
				}
				validatePredicate(node, owner);
				return;
			}
			if (node.env !== void 0) {
				if (typeof node.env !== "string" || !ENV_FACTS.includes(node.env)) {
					throw settingsLayoutError(`'${owner}' declares a condition on unknown env fact '${String(node.env)}'`);
				}
				validatePredicate(node, owner);
				return;
			}
			if (node.all !== void 0 || node.any !== void 0) {
				const children = node.all ?? node.any;
				if (!Array.isArray(children) || children.length === 0) {
					throw settingsLayoutError(`'${owner}' declares an empty '${node.all !== void 0 ? "all" : "any"}' condition`);
				}
				for (const child of children) validateConditionNode(child, owner, knownKeys);
				return;
			}
			validateConditionNode(node.not, owner, knownKeys);
		}
		/** Fail-loud declaration validation, run at module load: unknown or
		 * cross-group parents, parent cycles, conditions on unknown keys or
		 * unknown env facts — every error names the offending key. */
		function validateLayout(groups) {
			const keyToGroup = new Map();
			for (const group of groups) {
				for (const node of group.fields) {
					if (typeof node.field !== "string") continue;
					if (keyToGroup.has(node.field)) throw settingsLayoutError(`duplicate field '${node.field}'`);
					keyToGroup.set(node.field, group.id);
				}
			}
			const knownKeys = new Set(keyToGroup.keys());
			for (const group of groups) {
				const byKey = new Map();
				for (const node of group.fields) if (typeof node.field === "string") byKey.set(node.field, node);
				for (const node of group.fields) {
					const owner = typeof node.field === "string" ? node.field : `slot '${String(node.slot)}'`;
					if (node.parent !== void 0) {
						if (typeof node.parent !== "string" || !knownKeys.has(node.parent)) {
							throw settingsLayoutError(`'${owner}' declares unknown parent '${String(node.parent)}'`);
						}
						if (keyToGroup.get(node.parent) !== group.id) {
							throw settingsLayoutError(`'${owner}' declares cross-group parent '${node.parent}'`);
						}
					}
					if (node.when !== void 0) validateConditionNode(node.when, owner, knownKeys);
				}
				for (const node of group.fields) {
					if (typeof node.field !== "string" || node.parent === void 0) continue;
					const seen = new Set([node.field]);
					let current = byKey.get(node.parent);
					while (current !== void 0) {
						if (seen.has(current.field)) throw settingsLayoutError(`'${node.field}' declares a parent cycle through '${current.field}'`);
						seen.add(current.field);
						current = current.parent !== void 0 ? byKey.get(current.parent) : void 0;
					}
				}
			}
		}
		/** Per-group ordered trees: roots keep declaration order; children nest
		 * into their parent's subtree regardless of declaration position and
		 * carry their nesting `depth` (DFS). */
		function buildLayout(groups) {
			return groups.map((group) => {
				const nodes = group.fields.map((descriptor) => ({ ...descriptor, depth: 0, children: [] }));
				const byKey = new Map();
				for (const node of nodes) if (typeof node.field === "string") byKey.set(node.field, node);
				const roots = [];
				for (const node of nodes) {
					const parent = typeof node.parent === "string" ? byKey.get(node.parent) : void 0;
					if (parent !== void 0) parent.children.push(node);
					else roots.push(node);
				}
				const assignDepth = (node, depth) => {
					node.depth = depth;
					for (const child of node.children) assignDepth(child, depth + 1);
				};
				for (const root of roots) assignDepth(root, 0);
				return { id: group.id, roots };
			});
		}
		// Declaration-time validation (D4): a bad GROUPS table fails chunk load
		// with a named error instead of rendering a broken page.
		validateLayout(GROUPS);
		const LAYOUT = buildLayout(GROUPS);
		function booleanSpec(field) {
			return {
				field,
				format: (value) => value === true ? "true" : value === false ? "false" : "",
				parse: (text) => {
					const trimmed = text.trim().toLowerCase();
					if (trimmed === "") return { kind: "clear" };
					if (trimmed === "true") return { kind: "set", value: true };
					if (trimmed === "false") return { kind: "set", value: false };
					return void 0;
				}
			};
		}
		function enumSpec(field, values) {
			return {
				field,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					if (values.includes(trimmed)) return { kind: "set", value: trimmed };
					return void 0;
				}
			};
		}
		function specFor(descriptor) {
			if (descriptor.kind === "number") return primitives.settingsNumberField(descriptor.field);
			if (descriptor.kind === "boolean") return booleanSpec(descriptor.field);
			if (descriptor.kind === "enum") return enumSpec(descriptor.field, descriptor.values);
			// text, and custom rows naming a field (chains, robash lists, the
			// model-picker carrier) are text-backed at the form layer
			return primitives.settingsTextField(descriptor.field);
		}
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		// ---- environment facts (design D6) ----
		let envFailureWarned = false;
		function warnEnvFailureOnce(error) {
			if (envFailureWarned) return;
			envFailureWarned = true;
			console.warn(`weir-settings: environment facts unavailable — env-gated rows stay hidden (${String(error?.message ?? error)})`);
		}
		function fetchEnvFacts() {
			return fetch(ENV_PATH, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: "{}"
			}).then((response) => response.json()).then((payload) => {
				if (payload?.ok !== true || typeof payload.value?.platform !== "string") throw new Error("malformed environment facts response");
				return { platform: payload.value.platform };
			});
		}
		var WeirCardController = class {
			form;
			store;
			constructor(scope, deps) {
				// Prop-injected dependencies: the entry-owned settings bus (save →
				// toggle re-check) and a getSession closure resolving the
				// remote.session domain lazily at call time (it may not be wired
				// yet during apply, S17). fetchEnv is the injectable environment
				// facts read (tests); production uses the fetch above.
				this.deps = deps;
				this.form = new primitives.SettingsFormModel(scope, FIELDS.map(specFor));
				this.store = this.form.bind(() => this.projection());
				// Restart-required keys touched by the last landed save, in
				// registry order; null until such a save lands or after the
				// user dismisses the reminder.
				this.restartReminder = null;
				// Environment facts, fetched once per page arrival (the
				// platform does not change during a process lifetime, so no
				// polling). pending: env-gated rows render nothing; ready:
				// evaluated against facts; failed: same as pending plus one
				// console warning — the rest of the page stays usable.
				this.env = { status: "pending", facts: {} };
				Promise.resolve()
					.then(() => (deps.fetchEnv ?? fetchEnvFacts)())
					.then(
						(facts) => {
							this.env = { status: "ready", facts: facts ?? {} };
						},
						(error) => {
							this.env = { status: "failed", facts: {} };
							warnEnvFailureOnce(error);
						}
					)
					.then(() => {
						this.form.publish();
					});
			}
			getSession() {
				return this.deps.getSession();
			}
			projection() {
				const fields = {};
				for (const descriptor of FIELDS) {
					// `saved` rides along so condition evaluation can fall back
					// to the saved value while an unparseable draft is staged
					// (D3) — the merged field text alone cannot express it.
					fields[descriptor.field] = { ...this.form.field(descriptor.field), saved: this.form.sectionValue(descriptor.field) };
				}
				return {
					...this.form.shell(),
					fields,
					restartReminder: this.restartReminder,
					env: this.env
				};
			}
			inject() {
				const actions = this.form.actions();
				return {
					hooks: { weirSettingsCard: this.store },
					...actions,
					// Save through the form directly: actions().save discards
					// the promise, so awaiting it would run the post-save work
					// at save START. The touched fields are planned first (a
					// landed save clears the staged drafts, so the plan cannot
					// be read back later); after the settle the bus bump —
					// session-surface consumers like the LSP toggle re-check
					// live — fires exactly once, and a landed save that touched
					// restart-required keys raises the reminder (registry
					// order) before the bound stores re-project.
					save: async () => {
						const plan = this.form.plan();
						const touched = plan.map((item) => item.field);
						// The save only runs when the plan is executable (every
						// item carries its write): the form refuses an empty or
						// invalid plan, and a refused save must not raise the
						// reminder.
						const executable = plan.length > 0 && plan.every((item) => item.op !== undefined || item.run !== undefined);
						try {
							await this.form.save();
						} finally {
							this.deps.settingsBus.notify();
							if (executable && !this.form.shell().failed) {
								const restartTouched = RESTART_FIELDS.filter((field) => touched.includes(field));
								if (restartTouched.length > 0) this.restartReminder = restartTouched;
							}
							this.form.publish();
						}
					},
					dismissRestartReminder: () => {
						this.restartReminder = null;
						this.form.publish();
					},
					getSession: () => this.getSession()
				};
			}
			dispose() {
				this.form.dispose();
			}
		};
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", padding: "10px 0" };
		const labelGroupStyle = { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 };
		const labelStyle = { fontSize: "14px", fontWeight: 500, lineHeight: "20px" };
		// child rows step the label size down slightly with depth
		const childLabelStyle = { ...labelStyle, fontSize: "13px" };
		const labelTextStyle = { display: "inline-flex", alignItems: "center", gap: "6px" };
		const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		// Card-based group sections (design D7): layered background, l1 border,
		// radius, the group title inside the card top, hairline l2 separators
		// between rows. Colors only from theme tokens; geometry hardcoded.
		const cardStyle = { background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "12px", padding: "6px 16px 12px" };
		const cardTitleStyle = { fontSize: "13px", fontWeight: 600, lineHeight: "18px", padding: "8px 0 2px", color: "var(--dsw-alias-label-primary)" };
		const cardsColumnStyle = { display: "flex", flexDirection: "column", gap: "12px" };
		const controlsStyle = { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 };
		const resetStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", textDecoration: "underline", color: "var(--dsw-alias-label-secondary)" };
		// Compact native dropdown for enum rows marked `display: "select"`
		// (today only worktreeAutoApprove — its three long option labels squeeze
		// the row label in a segmented control). Geometry matches the small
		// inputs of the worktree-view config editor; colors from theme tokens.
		const selectStyle = { fontSize: "12px", lineHeight: "16px", padding: "3px 6px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-sm)", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-base)", maxWidth: "220px", flex: "none" };
		const reminderTagsStyle = { display: "flex", flexWrap: "wrap", gap: "6px" };
		// Row chrome inside a card: hairline separator (skipped on the first
		// row), and for child rows a left guide line plus padding scaled by
		// depth — both in the l2 border token.
		function rowWrapStyle(depth, first) {
			return {
				borderTop: first ? "none" : "1px solid var(--dsw-alias-border-l2)",
				...(depth > 0 ? { borderLeft: "1px solid var(--dsw-alias-border-l2)", marginLeft: "2px", paddingLeft: `${depth * 16}px` } : {})
			};
		}
		// The always-on restart-required tag for rows in RESTART_FIELDS — the
		// same list copy the post-save modal uses, so the two can never drift.
		function restartTag(node, t) {
			if (typeof node.field !== "string" || !RESTART_FIELDS.includes(node.field)) return null;
			return react_jsx_runtime.jsx(primitives.Tag, { tone: "neutral", children: t("restartRequired") });
		}
		function labelWithTag(node, t, style) {
			return react_jsx_runtime.jsx("span", { style, children: react_jsx_runtime.jsxs("span", { style: labelTextStyle, children: [t(node.field), restartTag(node, t)] }) });
		}
		function ChoiceField(props) {
			const { descriptor, field, t, disabled } = props;
			const depth = props.depth ?? 0;
			return react_jsx_runtime.jsx("div", { style: rowStyle, children: [
				react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
					labelWithTag(descriptor, t, depth > 0 ? childLabelStyle : labelStyle),
					react_jsx_runtime.jsx("span", { style: hintStyle, children: t(`${descriptor.field}Hint`) })
				] }),
				react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
					descriptor.kind === "boolean" ? react_jsx_runtime.jsx(primitives.Switch, {
						// ONE effective-value helper with the condition evaluator:
						// what the switch shows is what `when` sees.
						checked: resolveEffectiveValue(descriptor, field, field?.saved) === true,
						onChange: (checked) => props.onChange(String(checked)),
						disabled,
						label: t(descriptor.field)
					}) : descriptor.display === "select" ? react_jsx_runtime.jsx("select", {
						id: `plugin-config-${WEIR_NS}-${descriptor.field}`,
						// unset enum (resting text empty): the product default is the
						// selected option; a staged/saved text always wins — the same
						// displayText semantics the segmented control below uses
						value: displayText(descriptor, field),
						onChange: (event) => props.onChange(event.target.value),
						disabled,
						"aria-label": t(descriptor.field),
						style: selectStyle,
						children: descriptor.values.map((value) => react_jsx_runtime.jsx("option", {
							value,
							children: t(`${descriptor.field}Option${value.charAt(0).toUpperCase()}${value.slice(1)}`),
							key: value
						}))
					}) : react_jsx_runtime.jsx(primitives.SegmentedControl, {
						id: `plugin-config-${WEIR_NS}-${descriptor.field}`,
						// unset enum (resting text empty): show the product default
						// as the selected segment; a staged/saved text always wins
						value: displayText(descriptor, field),
						options: descriptor.values.map((value) => ({ value, label: t(`${descriptor.field}Option${value.charAt(0).toUpperCase()}${value.slice(1)}`) })),
						onChange: (value) => props.onChange(value),
						disabled,
						label: t(descriptor.field)
					}),
					field.overridden ? react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
						react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: t("overridden") }),
						react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: props.onReset, children: t("reset") })
					] }) : null
				] })
			] });
		}
		// The model-picker merged row (design D5): one row edits
		// intentGateProvider + intentGateModel + intentGateReasoningEffort; the
		// two folded fields never render their own row. The picker runs inside
		// an error boundary: a picker failure degrades to plain text fields
		// instead of blanking the settings page.
		function renderModelPickerNode(node, state, props, disabled, t) {
			const pickerOverridden = state.fields.intentGateProvider.overridden || state.fields.intentGateModel.overridden || state.fields.intentGateReasoningEffort.overridden;
			const pickerRow = (picker) => react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
				react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
					labelWithTag(node, t, labelStyle),
					react_jsx_runtime.jsx("span", { style: hintStyle, children: t(`${node.field}Hint`) })
				] }),
				react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
					react_jsx_runtime.jsx(picker.ModelPickerField, {
						value: {
							provider: state.fields.intentGateProvider.text,
							model: state.fields.intentGateModel.text,
							reasoningEffort: state.fields.intentGateReasoningEffort.text
						},
						onChange: (selection) => {
							props.edit("intentGateProvider", selection.provider ?? "");
							props.edit("intentGateModel", selection.model ?? "");
							props.edit("intentGateReasoningEffort", selection.reasoningEffort ?? "");
						},
						getSession: () => props.getSession(),
						t,
						disabled
					}),
					pickerOverridden ? react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
						react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: t("overridden") }),
						react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: () => {
							props.resetField("intentGateProvider");
							props.resetField("intentGateModel");
							props.resetField("intentGateReasoningEffort");
						}, children: t("reset") })
					] }) : null
				] })
			] });
			// Manual-entry fallback: what the row renders before the picker chunk
			// arrives, when its load failed, and what the picker's own error boundary
			// swaps in when the picker component throws.
			const manualFallback = react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
				react_jsx_runtime.jsx(primitives.SettingsValueField, {
					id: "plugin-config-fallback-intentGateProvider",
					label: t("intentGateProvider"),
					hint: t("intentGateProviderHint"),
					overriddenLabel: t("overridden"),
					resetLabel: t("reset"),
					invalidLabel: t("invalidValue"),
					disabled,
					text: state.fields.intentGateProvider.text,
					invalid: state.fields.intentGateProvider.invalid,
					overridden: state.fields.intentGateProvider.overridden,
					onChange: (text) => props.edit("intentGateProvider", text),
					onReset: () => props.resetField("intentGateProvider")
				}),
				react_jsx_runtime.jsx(primitives.SettingsValueField, {
					id: "plugin-config-fallback-intentGateModel",
					label: t("intentGateModel"),
					hint: t("intentGateModelHint"),
					overriddenLabel: t("overridden"),
					resetLabel: t("reset"),
					invalidLabel: t("invalidValue"),
					disabled,
					text: state.fields.intentGateModel.text,
					invalid: state.fields.intentGateModel.invalid,
					overridden: state.fields.intentGateModel.overridden,
					onChange: (text) => props.edit("intentGateModel", text),
					onReset: () => props.resetField("intentGateModel")
				}),
				react_jsx_runtime.jsx(primitives.SettingsValueField, {
					id: "plugin-config-fallback-intentGateReasoningEffort",
					label: t("intentGateReasoningEffort"),
					hint: t("intentGateReasoningEffortHint"),
					overriddenLabel: t("overridden"),
					resetLabel: t("reset"),
					invalidLabel: t("invalidValue"),
					disabled,
					text: state.fields.intentGateReasoningEffort.text,
					invalid: state.fields.intentGateReasoningEffort.invalid,
					overridden: state.fields.intentGateReasoningEffort.overridden,
					onChange: (text) => props.edit("intentGateReasoningEffort", text),
					onReset: () => props.resetField("intentGateReasoningEffort")
				})
			] });
			const picker = props.modelPicker;
			if (picker === void 0 || picker === null) return manualFallback;
			return react_jsx_runtime.jsx(picker.ModelPickerBoundary, { fallback: manualFallback, children: pickerRow(picker) });
		}
		function WeirCard(props) {
			const state = props.useWeirSettingsCard((snapshot) => snapshot);
			const { t } = props;
			if (props.view === "summary") return t("description");
			const disabled = !state.writable;
			// env three-state (D6): pending/failed hide env-gated rows only.
			const env = state.env ?? { status: "ready", facts: {} };
			const resolve = {
				value: (key) => {
					const descriptor = FIELD_BY_NAME[key];
					const field = state.fields[key];
					return resolveEffectiveValue(descriptor, field, field?.saved);
				},
				env: (name) => env.facts?.[name]
			};
			const visible = (node) => {
				if (node.when === void 0) return true;
				if (conditionUsesEnv(node.when) && env.status !== "ready") return false;
				return evaluateCondition(node.when, resolve);
			};
			const renderNode = (node, first) => {
				const field = typeof node.field === "string" ? state.fields[node.field] : void 0;
				const key = typeof node.field === "string" ? node.field : node.slot;
				const wrap = (content) => react_jsx_runtime.jsx("div", { style: rowWrapStyle(node.depth, first), "data-depth": node.depth > 0 ? node.depth : void 0, children: content, key });
				if (node.kind === "custom") {
					if (node.slot === "chainEditor") {
						return wrap(react_jsx_runtime.jsx(props.editors.ChainEditorField, {
							field: "delegateCategoryChains",
							modelPicker: props.modelPicker,
							text: state.fields.delegateCategoryChains.text,
							overridden: state.fields.delegateCategoryChains.overridden,
							edit: (name, text) => props.edit(name, text),
							onReset: () => props.resetField("delegateCategoryChains"),
							getSession: () => props.getSession(),
							t,
							disabled
						}));
					}
					if (node.slot === "agentChainEditor") {
						// The curated-agent counterpart of the category chains: same
						// visual editor, agent lanes and agent dictionary stems.
						return wrap(react_jsx_runtime.jsx(props.editors.ChainEditorField, {
							field: "delegateAgentChains",
							modelPicker: props.modelPicker,
							rows: CURATED_AGENT_NAMES,
							rowLabelPrefix: "chainAgent_",
							panelHintKey: "chainAgentPanelHint",
							text: state.fields.delegateAgentChains.text,
							overridden: state.fields.delegateAgentChains.overridden,
							edit: (name, text) => props.edit(name, text),
							onReset: () => props.resetField("delegateAgentChains"),
							getSession: () => props.getSession(),
							t,
							disabled
						}));
					}
					if (node.slot === "disabledCategoriesEditor") {
						// The closed-set counterpart of the editors above: one
						// switch per registry category, the JSON array of the
						// switched-on names synthesized on save.
						return wrap(react_jsx_runtime.jsx(props.editors.DisabledCategoriesEditorField, {
							field: "delegateDisabledCategories",
							rows: CATEGORY_NAMES,
							text: state.fields.delegateDisabledCategories.text,
							overridden: state.fields.delegateDisabledCategories.overridden,
							edit: (name, text) => props.edit(name, text),
							onReset: () => props.resetField("delegateDisabledCategories"),
							t,
							disabled
						}));
					}
					if (node.slot === "robashList") {
						return wrap(react_jsx_runtime.jsx(props.editors.RobashListEditorField, {
							field: node.field,
							text: field.text,
							overridden: field.overridden,
							edit: (name, text) => props.edit(name, text),
							onReset: () => props.resetField(node.field),
							t,
							disabled
						}));
					}
					if (node.slot === "modelPicker") return wrap(renderModelPickerNode(node, state, props, disabled, t));
					if (node.slot === "lspManager") {
						// The merged lspServers row: the full robashList wiring plus
						// the panel's own props; the panel renders the override tag,
						// the reset button and the malformed-JSON hint itself.
						return wrap(react_jsx_runtime.jsx(props.editors.LspManagerField, {
							field: "lspServers",
							text: field?.text ?? "",
							serversText: field?.text ?? "",
							overridden: field?.overridden ?? false,
							invalid: field?.invalid ?? false,
							edit: (name, text) => props.edit(name, text),
							onReset: () => props.resetField("lspServers"),
							t,
							disabled
						}));
					}
					if (node.slot === "editLockMaintenance") {
						// Edit Lock maintenance: profile-wide switch status and
						// read-only authority diagnostics (read-only).
						return wrap(react_jsx_runtime.jsx(props.editors.EditLockMaintenanceField, { t }));
					}
					// notifyPermissions: the macOS-only permission entry
					return wrap(react_jsx_runtime.jsx(props.editors.NotifyPermissionsField, { t }));
				}
				if (node.kind === "boolean" || node.kind === "enum") {
					return wrap(react_jsx_runtime.jsx(ChoiceField, {
						descriptor: node,
						field,
						t,
						disabled,
						depth: node.depth,
						onChange: (text) => props.edit(node.field, text),
						onReset: () => props.resetField(node.field)
					}));
				}
				return wrap(react_jsx_runtime.jsx(primitives.SettingsValueField, {
					id: `plugin-config-${WEIR_NS}-${node.field}`,
					label: react_jsx_runtime.jsxs("span", { style: labelTextStyle, children: [t(node.field), restartTag(node, t)] }),
					hint: t(`${node.field}Hint`),
					overriddenLabel: t("overridden"),
					resetLabel: t("reset"),
					invalidLabel: t("invalidValue"),
					disabled,
					// unset number/text (resting text empty): show the formatted
					// product default; a staged draft or saved value always wins
					text: displayText(node, field),
					invalid: field.invalid,
					overridden: field.overridden,
					onChange: (text) => props.edit(node.field, text),
					onReset: () => props.resetField(node.field)
				}));
			};
			// Card sections: the tree walk prunes hidden subtrees wholesale (a
			// hidden parent hides every descendant), and children land directly
			// under their parent's subtree in DFS order.
			const cards = LAYOUT.map((groupLayout) => {
				const rows = [];
				const walk = (node, ancestorsVisible) => {
					const isVisible = ancestorsVisible && visible(node);
					if (!isVisible) return;
					if (node.folded !== true) rows.push(renderNode(node, rows.length === 0));
					for (const child of node.children) walk(child, isVisible);
				};
				for (const root of groupLayout.roots) walk(root, true);
				return react_jsx_runtime.jsxs("div", {
					style: cardStyle,
					"data-group": groupLayout.id,
					children: [
						react_jsx_runtime.jsx("div", { style: cardTitleStyle, children: t(`group${groupLayout.id.charAt(0).toUpperCase()}${groupLayout.id.slice(1)}`) }),
						...rows
					],
					key: `group-${groupLayout.id}`
				});
			});
			const children = [react_jsx_runtime.jsx("div", { style: cardsColumnStyle, children: cards, key: "groups" })];
			// Restart reminder: a landed save that touched restart-required
			// keys raises a centered warning Modal (portal-mounted over a page
			// mask, so it cannot be missed on a long page), naming the affected
			// options by their translated labels. Absent state (or after
			// dismiss) renders nothing, keeping the rows unchanged.
			const reminder = Array.isArray(state.restartReminder) && state.restartReminder.length > 0 ? state.restartReminder : null;
			if (reminder) {
				children.push(react_jsx_runtime.jsx(primitives.Modal, {
					open: true,
					onClose: () => props.dismissRestartReminder(),
					title: t("restartReminderTitle"),
					closeLabel: t("restartReminderDismiss"),
					description: t("restartReminderBody"),
					children: react_jsx_runtime.jsx("div", { style: reminderTagsStyle, children: reminder.map((field) => react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: t(field), key: field })) }),
					footer: react_jsx_runtime.jsx(primitives.Button, { variant: "primary", onClick: () => props.dismissRestartReminder(), children: t("restartReminderAcknowledge") }),
					key: "restart-reminder"
				}));
			}
			return react_jsx_runtime.jsxs(primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children
			});
		}
		const columnStyle = {
			display: "flex",
			flexDirection: "column",
			gap: "var(--dsw-spacing-3, 12px)"
		};
		const ITEM_SLOT = "settings.weir.item";
		const WeirSection = ({ renderSlot }) => react_jsx_runtime.jsx("div", {
			style: columnStyle,
			children: renderSlot(ITEM_SLOT)
		});
		exports.GROUPS = GROUPS;
		exports.BOOLEAN_DEFAULTS = BOOLEAN_DEFAULTS;
		exports.FIELD_DEFAULTS = FIELD_DEFAULTS;
		exports.displayText = displayText;
		exports.CURATED_AGENT_NAMES = CURATED_AGENT_NAMES;
		exports.CATEGORY_NAMES = CATEGORY_NAMES;
		exports.RESTART_FIELDS = RESTART_FIELDS;
		exports.FIELDS = FIELDS;
		exports.ENV_FACTS = ENV_FACTS;
		exports.evaluateCondition = evaluateCondition;
		exports.conditionUsesEnv = conditionUsesEnv;
		exports.resolveEffectiveValue = resolveEffectiveValue;
		exports.validateLayout = validateLayout;
		exports.buildLayout = buildLayout;
		exports.LAYOUT = LAYOUT;
		exports.WeirCardController = WeirCardController;
		exports.WeirCard = WeirCard;
		exports.WeirSection = WeirSection;
		return module.exports;
	}
});
