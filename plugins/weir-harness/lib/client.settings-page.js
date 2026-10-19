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
		// Host environment facts (src/settings/env-admin.js) arrive through
		// deps.fetchEnv — the composition root's HTTP-channel-backed read; this
		// chunk keeps the failure policy (warn-once) but no longer builds the
		// carrier.
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
		const RESTART_FIELDS = ["intentGateClassifier", "intentGateProvider", "intentGateModel", "intentGateReasoningEffort", "intentGateTimeoutMs", "jevEndpoint", "jevModel", "jevApiKeyEnv", "todoEnabled", "todoMaxConsecutive", "todoErrorRetryMax", "todoErrorBackoffBaseMs", "todoErrorBackoffCapMs", "hashlineHideStockEdit"];
		// ---- condition declaration shorthands (frozen pure data, D2) ----
		const enabledWhen = (key) => Object.freeze({ key, equals: true });
		const CLASSIFIER_LLM = Object.freeze({ key: "intentGateClassifier", equals: "llm" });
		const CLASSIFIER_JEV = Object.freeze({ key: "intentGateClassifier", equals: "jev" });
		const WINDOWS_ONLY = Object.freeze({ env: "platform", in: Object.freeze(["win32"]) });
		const ROBASH_WINDOWS = Object.freeze({ all: Object.freeze([enabledWhen("robashEnabled"), WINDOWS_ONLY]) });
		const CLASSIFIER_LLM_OR_JEV = Object.freeze({ any: Object.freeze([CLASSIFIER_LLM, CLASSIFIER_JEV]) });
		// The GROUPS field table. Every group: { id, page?, fields }. page is
		// "main" (default when absent) or "routing" — the model-routing groups
		// form the separate routing settings page (WeirCard/WeirCardController
		// filter by it; validateLayout rejects any other value). Every node:
		// { field?, kind, values?, display?, when?, parent?, folded?, slot? }.
		// kind: boolean | enum | number | text | custom. An enum node may set
		// `display: "select"` to render a compact native dropdown instead of the
		// segmented control (long option labels squeeze the row label). `custom`
		// nodes carry a render `slot` identifier and share parent/when with
		// plain rows; a custom node with a `field` is text-backed at the form
		// layer. `folded` fields stay in the form but render inside another row
		// (the model picker folds intentGateModel / intentGateReasoningEffort
		// into the intentGateProvider row; their `when` matches the carrier row
		// by declaration). Field-less custom nodes (maintenance/permission
		// panels) hang in the same tree. Keys marked page:false in
		// src/settings/sections.js (CONFIG_FACE_ONLY_KEYS) never appear here —
		// config-face-only by declaration, pinned by test.
		const GROUPS = [
			{ id: "intent", fields: [
				{ field: "intentGateClassifier", kind: "enum", values: ["regex", "llm", "jev"] },
				{ field: "intentGateProvider", kind: "custom", slot: "modelPicker", when: CLASSIFIER_LLM },
				{ field: "intentGateModel", kind: "text", folded: true, when: CLASSIFIER_LLM },
				{ field: "intentGateReasoningEffort", kind: "text", folded: true, when: CLASSIFIER_LLM },
				{ field: "intentGateTimeoutMs", kind: "number", when: CLASSIFIER_LLM_OR_JEV },
				{ field: "jevEndpoint", kind: "text", when: CLASSIFIER_JEV },
				{ field: "jevModel", kind: "text", when: CLASSIFIER_JEV },
				{ field: "jevApiKeyEnv", kind: "text", when: CLASSIFIER_JEV }
			] },
			{ id: "routingCategories", page: "routing", fields: [
				{ field: "delegateCategoryChains", kind: "custom", slot: "chainEditor" },
				{ field: "delegateDisabledCategories", kind: "custom", slot: "disabledCategoriesEditor" }
			] },
			{ id: "routingAgents", page: "routing", fields: [
				{ field: "delegateAgentChains", kind: "custom", slot: "agentChainEditor" }
			] },
			{ id: "routingSupervision", page: "routing", fields: [
				{ field: "supervisionMaxRetries", kind: "number" },
				{ field: "supervisionInitialBackoffMs", kind: "number" },
				{ field: "supervisionMaxBackoffMs", kind: "number" }
			] },
			{ id: "todo", fields: [
				{ field: "todoEnabled", kind: "boolean" },
				{ field: "todoMaxConsecutive", kind: "number", parent: "todoEnabled", when: enabledWhen("todoEnabled") },
				{ field: "todoErrorRetryMax", kind: "number", parent: "todoEnabled", when: enabledWhen("todoEnabled") }
			] },
			{ id: "guard", fields: [
				{ field: "guardEnabled", kind: "boolean" },
				{ field: "guardSoftThreshold", kind: "number", parent: "guardEnabled", when: enabledWhen("guardEnabled") },
				{ field: "guardHardThreshold", kind: "number", parent: "guardEnabled", when: enabledWhen("guardEnabled") }
			] },
			{ id: "editing", fields: [
				{ field: "hashlineHideStockEdit", kind: "boolean" },
				// Edit Lock diagnostics seat: the composition root binds no editor
				// for it (edit-lock rebuild), so the row renders nothing.
				{ kind: "custom", slot: "editLockMaintenance" }
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
			] }
		];
		// Form fields: every node that names a flat settings key (custom
		// panels without a field render only), in GROUPS declaration order
		// across both pages — test pins this list.
		const FIELDS = GROUPS.flatMap((group) => group.fields).filter((descriptor) => typeof descriptor.field === "string");
		const FIELD_BY_NAME = Object.fromEntries(FIELDS.map((descriptor) => [descriptor.field, descriptor]));
		// The page one field's group belongs to ("main" when the group declares
		// no page): the controller's form specs and projection cover exactly the
		// page's fields, and WeirCard renders only the page's groups.
		const FIELD_PAGE = new Map();
		for (const group of GROUPS) {
			for (const node of group.fields) {
				if (typeof node.field === "string") FIELD_PAGE.set(node.field, group.page ?? "main");
			}
		}
		function fieldsForPage(page) {
			return FIELDS.filter((descriptor) => FIELD_PAGE.get(descriptor.field) === page);
		}
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
		 * unknown env facts, an invalid group page — every error names the
		 * offending key or group. */
		function validateLayout(groups) {
			for (const group of groups) {
				if (group.page !== void 0 && group.page !== "main" && group.page !== "routing") {
					throw settingsLayoutError(`group '${String(group.id)}' declares an invalid page '${String(group.page)}'`);
				}
			}
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
				return { id: group.id, page: group.page ?? "main", roots };
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
				saving: t("saving"),
				discard: t("discardChanges"),
				// The save bar's pending count interpolates per render, so a
				// function label: the host locale's second argument is the
				// interpolation VARS object (never a fallback string).
				pendingChanges: (n) => t("pendingChanges", { n })
			};
		}
		// ---- environment facts (design D6) ----
		let envFailureWarned = false;
		function warnEnvFailureOnce(error) {
			if (envFailureWarned) return;
			envFailureWarned = true;
			console.warn(`weir-settings: environment facts unavailable — env-gated rows stay hidden (${String(error?.message ?? error)})`);
		}
		var WeirCardController = class {
			form;
			store;
			constructor(scope, deps, page) {
				// page: "main" (default) or "routing" — the form model tracks only
				// that page's fields, so one scope hosts two independent forms (the
				// routing page edits the same namespace, disjoint key set).
				this.page = page === "routing" ? "routing" : "main";
				this.fields = fieldsForPage(this.page);
				// Prop-injected dependencies: the entry-owned settings bus (save →
				// toggle re-check) and a getSession closure resolving the
				// remote.session domain lazily at call time (it may not be wired
				// yet during apply, S17). fetchEnv is the composition root's
				// channel-backed environment-facts read.
				this.deps = deps;
				this.form = new primitives.SettingsFormModel(scope, this.fields.map(specFor));
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
					.then(() => deps.fetchEnv())
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
				for (const descriptor of this.fields) {
					// `saved` rides along so condition evaluation can fall back
					// to the saved value while an unparseable draft is staged
					// (D3) — the merged field text alone cannot express it.
					fields[descriptor.field] = { ...this.form.field(descriptor.field), saved: this.form.sectionValue(descriptor.field) };
				}
				return {
					...this.form.shell(),
					fields,
					// Staged-write count for the save bar's pending label —
					// plan() is a pure read (the same read save() plans from).
					pendingCount: this.form.plan().length,
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
					react_jsx_runtime.jsx("span", { style: hintStyle, children: t(`${descriptor.field}Hint`) }),
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
					onEdit: (text) => props.edit("intentGateProvider", text),
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
					onEdit: (text) => props.edit("intentGateModel", text),
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
					onEdit: (text) => props.edit("intentGateReasoningEffort", text),
					onReset: () => props.resetField("intentGateReasoningEffort")
				})
			] });
			const picker = props.modelPicker;
			if (picker === void 0 || picker === null) return manualFallback;
			return react_jsx_runtime.jsx(picker.ModelPickerBoundary, { fallback: manualFallback, children: pickerRow(picker) });
		}
		// ---- floating save bar + local form shell ----
		// The bar renders ONLY while the form is dirty — a clean page gets no
		// new visual noise. It sits in the normal flow as the form's last
		// element with position: sticky, so once the page scrolls it pins to
		// the bottom edge of the settings scroll container. Chrome mirrors the
		// host's Toast surface (dark in BOTH themes) instead of the group cards:
		// a floating action bar must read as a surface ABOVE the rows, not as
		// one more row. Colors only from theme tokens, geometry hardcoded.
		const saveBarStyle = { position: "sticky", bottom: "12px", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginTop: "12px", padding: "10px 14px", background: "var(--dsw-alias-toast-bg)", border: "none", borderRadius: "var(--dsw-radius-lg, 12px)", boxShadow: "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.18))" };
		const saveBarTextStyle = { display: "flex", alignItems: "center", gap: "8px", minWidth: 0, fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-toast-label)" };
		// warn-label (not warn-primary) is the token designed for dark surfaces.
		const saveBarFailedStyle = { color: "var(--dsw-alias-state-warn-label)" };
		// Discard as a plain text action (the host toast's action pattern): the
		// outline Button variant is tuned for regular surfaces and reads poorly
		// on the always-dark toast surface.
		const saveBarDiscardStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", lineHeight: "16px", padding: "4px 2px", color: "var(--dsw-static-deepseek-400, var(--dsw-alias-brand-primary))" };
		const saveBarActionsStyle = { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 };
		// The form-shell notice lines (unavailable / readOnly) keep the host
		// contract's role="status" lines in the page's hint styling.
		const formNoticeStyle = { fontSize: "13px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)", margin: "0 0 12px" };
		/** Local form shell replacing the host primitives.SettingsForm (whose
		 * footer sits at the bottom of a long page and cannot be restyled from
		 * outside). The host contract is preserved verbatim: staged edits are
		 * discarded on unmount (the ref follows the latest onDiscard; hooks run
		 * before the early return so the cleanup registers in every state), an
		 * unavailable namespace renders the notice line INSTEAD of the form,
		 * and a read-only deployment shows the readOnly notice above the
		 * controls. The save affordance is the sticky bar: pending count +
		 * failure text left, discard/save right; invalid or saving disables
		 * save (the bar existing already implies dirty). */
		function WeirSettingsForm(props) {
			const { state, labels } = props;
			const discardRef = react.useRef(props.onDiscard);
			discardRef.current = props.onDiscard;
			react.useEffect(() => () => discardRef.current(), []);
			if (!state.available) return react_jsx_runtime.jsx("p", { style: formNoticeStyle, role: "status", children: labels.unavailable });
			return react_jsx_runtime.jsxs("div", { children: [
				!state.writable ? react_jsx_runtime.jsx("p", { style: formNoticeStyle, role: "status", children: labels.readOnly, key: "read-only" }) : null,
				props.children,
				state.dirty ? react_jsx_runtime.jsxs("div", { style: saveBarStyle, "data-save-bar": "", children: [
					react_jsx_runtime.jsxs("div", { style: saveBarTextStyle, children: [
						react_jsx_runtime.jsx("span", { children: labels.pendingChanges(state.pendingCount ?? 0), key: "pending" }),
						state.failed ? react_jsx_runtime.jsx("span", { style: saveBarFailedStyle, role: "status", children: labels.saveFailed, key: "failed" }) : null
					] }),
					react_jsx_runtime.jsxs("div", { style: saveBarActionsStyle, children: [
						react_jsx_runtime.jsx("button", { type: "button", style: saveBarDiscardStyle, onClick: props.onDiscard, children: labels.discard }),
						react_jsx_runtime.jsx(primitives.Button, { variant: "primary", size: "sm", disabled: state.invalid || state.saving, onClick: props.onSave, children: state.saving ? labels.saving : labels.save })
					] })
				] }, "save-bar") : null
			] });
		}
		function WeirCard(props) {
			const state = props.useWeirSettingsCard((snapshot) => snapshot);
			const { t } = props;
			// Dual-page card: props.page ("main" default, "routing") selects the
			// summary text and the rendered group subset; conditions/restartTag/
			// displayText are page-independent.
			const page = props.page === "routing" ? "routing" : "main";
			if (props.view === "summary") return t(page === "routing" ? "routingDescription" : "description");
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
						// The Edit Lock maintenance seat is GONE (edit-lock rebuild):
						// the composition root no longer binds an editor for it, and
						// the row disappears with the settings keys. An unbound seat
						// must leave the card intact instead of rendering an undefined
						// element type, so the row simply renders nothing here.
						const MaintenanceField = props.editors?.EditLockMaintenanceField;
						return typeof MaintenanceField === "function" ? wrap(react_jsx_runtime.jsx(MaintenanceField, { t })) : null;
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
					onEdit: (text) => props.edit(node.field, text),
					onReset: () => props.resetField(node.field)
				}));
			};
			// Card sections: the tree walk prunes hidden subtrees wholesale (a
			// hidden parent hides every descendant), and children land directly
			// under their parent's subtree in DFS order.
			const cards = LAYOUT.filter((groupLayout) => groupLayout.page === page).map((groupLayout) => {
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
			// The local form shell (NOT the host primitives.SettingsForm): same
			// contract, with the save affordance as the sticky bar above.
			return react_jsx_runtime.jsxs(WeirSettingsForm, {
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
		// The section shell is page-agnostic: the composition root passes the
		// child item slot of the page being hosted (main by default, the
		// routing page's "settings.weir-routing.item" for the routing section).
		const WeirSection = ({ renderSlot, slot }) => react_jsx_runtime.jsx("div", {
			style: columnStyle,
			children: renderSlot(slot ?? ITEM_SLOT)
		});
		// Locale data face (pure data, NO ctx calls — a chunk factory re-executes
		// under HMR, so a chunk-local register would throw on the duplicate
		// (namespace, locale) pair): the entry registers these under "settings.weir.page"
		// inside a ctx.effect when this chunk arrives (lib/client.js
		// registerChunkDictionaries). Pinned by test/client.test.js's dictionary
		// union pin.
		const dictionaries = {
			en: {
				description: "One-stop configuration for the Weir preset: intent classification, auto-continuation, context pressure, file editing, worktree lanes, read-only shell, LSP, and notifications; model routing is a separate page.",
				routingDescription: "Which models delegated children run on: per task category or curated agent, with ordered fallbacks.",
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
			},
			zh: {
				description: "Weir 预设的一站式配置：意图分类、自动续推、上下文压力、文件编辑、Worktree 车道、只读命令行、LSP 与系统通知；模型路由为独立页面。",
				routingDescription: "委派给子代理的模型：按任务类别或精选代理指定，可设备选按序回退。",
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
			},
		};

		exports.dictionaries = dictionaries;
		exports.GROUPS = GROUPS;
		exports.BOOLEAN_DEFAULTS = BOOLEAN_DEFAULTS;
		exports.FIELD_DEFAULTS = FIELD_DEFAULTS;
		exports.displayText = displayText;
		exports.CURATED_AGENT_NAMES = CURATED_AGENT_NAMES;
		exports.CATEGORY_NAMES = CATEGORY_NAMES;
		exports.RESTART_FIELDS = RESTART_FIELDS;
		exports.FIELDS = FIELDS;
		exports.fieldsForPage = fieldsForPage;
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
