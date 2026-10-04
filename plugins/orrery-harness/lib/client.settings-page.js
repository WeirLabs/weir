window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.settings-page.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let modelPicker = require("orrery-model-picker");
		// Orrery settings page: one flat form over the `orrery-settings`
		// namespace (the shared SettingsFormModel only addresses flat fields).
		// The three field editors (chain/robash list/LSP manager) arrive as
		// props from the composition root; `settingsBus` and the lazily
		// evaluated `getSession` closure are prop-injected (S17). ORRERY_NS is
		// a verbatim copy of the entry constant (same-package sync require is
		// impossible in the ModuleLoader).
		const ORRERY_NS = "orrery-settings";
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
		// client-side source for the post-save restart reminder (do not
		// scatter). test/client-settings-page.test.js pins this list to
		// RESTART_KEYS from src/settings/sections.js, so a declaration
		// change on either side cannot drift the two sides.
		const RESTART_FIELDS = ["intentGateClassifier", "intentGateProvider", "intentGateModel", "intentGateReasoningEffort", "intentGateTimeoutMs", "jevEndpoint", "jevModel", "jevApiKeyEnv", "todoEnabled", "todoMaxConsecutive", "todoErrorRetryMax", "todoErrorBackoffBaseMs", "todoErrorBackoffCapMs", "guardEnabled", "guardSoftThreshold", "guardHardThreshold", "hashlineHideStockEdit", "editLockEnabled"];
		const GROUPS = [
			{ id: "intent", fields: [
				{ field: "intentGateClassifier", kind: "enum", values: ["regex", "llm", "jev"] },
				{ field: "intentGateProvider", kind: "text" },
				{ field: "intentGateModel", kind: "text" },
				{ field: "intentGateReasoningEffort", kind: "text" },
				{ field: "intentGateTimeoutMs", kind: "number" },
				{ field: "jevEndpoint", kind: "text" },
				{ field: "jevModel", kind: "text" },
				{ field: "jevApiKeyEnv", kind: "text" }
			] },
			{ id: "delegate", fields: [
				{ field: "delegateCategoryChains", kind: "text" },
				{ field: "delegateAgentChains", kind: "text" },
				{ field: "delegateDisabledCategories", kind: "text" },
				{ field: "supervisionMaxRetries", kind: "number" },
				{ field: "supervisionInitialBackoffMs", kind: "number" },
				{ field: "supervisionMaxBackoffMs", kind: "number" }
			] },
			{ id: "todo", fields: [
				{ field: "todoEnabled", kind: "boolean" },
				{ field: "todoMaxConsecutive", kind: "number" },
				{ field: "todoErrorRetryMax", kind: "number" },
				{ field: "todoErrorBackoffBaseMs", kind: "number" },
				{ field: "todoErrorBackoffCapMs", kind: "number" }
			] },
			{ id: "guard", fields: [
				{ field: "guardEnabled", kind: "boolean" },
				{ field: "guardSoftThreshold", kind: "number" },
				{ field: "guardHardThreshold", kind: "number" }
			] },
			{ id: "editing", fields: [
				{ field: "hashlineHideStockEdit", kind: "boolean" },
				{ field: "editLockEnabled", kind: "boolean" },
				{ field: "editLockHoldDefaultMinutes", kind: "number" },
				{ field: "editLockHoldSingleMaxMinutes", kind: "number" },
				{ field: "editLockHoldCumulativeMaxMinutes", kind: "number" },
				{ field: "editLockNudgeAttempts", kind: "number" },
				{ field: "editLockNudgeFallback", kind: "text" }
			] },
			{ id: "worktree", fields: [
				{ field: "worktreeEnabled", kind: "boolean" },
				{ field: "worktreeAutoSetup", kind: "boolean" },
				{ field: "worktreeMaxActive", kind: "number" },
				{ field: "worktreeRoot", kind: "text" }
			] },
			{ id: "robash", fields: [
				{ field: "robashEnabled", kind: "boolean" },
				{ field: "robashAllow", kind: "text" },
				{ field: "robashGitAllow", kind: "text" },
				{ field: "robashDeny", kind: "text" },
				{ field: "robashPwshAllow", kind: "text" },
				{ field: "robashPwshDeny", kind: "text" }
			] },
			{ id: "lsp", fields: [
				{ field: "lspEnabled", kind: "boolean" },
				{ field: "lspIdleMs", kind: "number" },
				{ field: "lspRequestTimeoutMs", kind: "number" },
				{ field: "lspDiagnosticsWaitMs", kind: "number" },
				{ field: "lspServers", kind: "text" }
			] },
			{ id: "notify", fields: [
				{ field: "notifyEnabled", kind: "boolean" },
				{ field: "notifyOnComplete", kind: "boolean" },
				{ field: "notifyOnAttention", kind: "boolean" },
				{ field: "notifyMinTurnSeconds", kind: "number" },
				{ field: "notifySound", kind: "boolean" },
				{ field: "notifyForeground", kind: "enum", values: ["skip", "always"] }
			] }
		];
		const FIELDS = GROUPS.flatMap((group) => group.fields);
		/** Product defaults of the boolean switches (mirrors the bundle's
		 * orrery-settings row). A profile-level row replaces that row's config
		 * wholesale, so a key the profile never saved arrives unset; the switch
		 * then shows the value the modules actually use, not "off". */
		const BOOLEAN_DEFAULTS = {
			todoEnabled: true,
			guardEnabled: true,
			hashlineHideStockEdit: true,
			editLockEnabled: false,
			worktreeEnabled: true,
			worktreeAutoSetup: true,
			robashEnabled: true,
			lspEnabled: false
		};
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
			if (descriptor.kind === "text") return primitives.settingsTextField(descriptor.field);
			if (descriptor.kind === "boolean") return booleanSpec(descriptor.field);
			return enumSpec(descriptor.field, descriptor.values);
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
		var OrreryCardController = class {
			form;
			store;
			constructor(scope, deps) {
				// Prop-injected dependencies: the entry-owned settings bus (save →
				// toggle re-check) and a getSession closure resolving the
				// remote.session domain lazily at call time (it may not be wired
				// yet during apply, S17).
				this.deps = deps;
				this.form = new primitives.SettingsFormModel(scope, FIELDS.map(specFor));
				this.store = this.form.bind(() => this.projection());
				// Restart-required keys touched by the last landed save, in
				// registry order; null until such a save lands or after the
				// user dismisses the reminder.
				this.restartReminder = null;
			}
			getSession() {
				return this.deps.getSession();
			}
			projection() {
				const fields = {};
				for (const descriptor of FIELDS) fields[descriptor.field] = this.form.field(descriptor.field);
				return {
					...this.form.shell(),
					fields,
					restartReminder: this.restartReminder
				};
			}
			inject() {
				const actions = this.form.actions();
				return {
					hooks: { orrerySettingsCard: this.store },
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
		const hintStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const groupTitleStyle = { fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--dsw-alias-label-secondary)", padding: "18px 0 6px", borderTop: "1px solid var(--dsw-alias-border-l2)" };
		const firstGroupTitleStyle = { ...groupTitleStyle, borderTop: "none", paddingTop: "0" };
		const controlsStyle = { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 };
		const resetStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", textDecoration: "underline", color: "var(--dsw-alias-label-secondary)" };
		const reminderStyle = { display: "flex", flexDirection: "column", gap: "8px", padding: "10px 12px", margin: "0 0 6px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)" };
		const reminderHeaderStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" };
		const reminderTagsStyle = { display: "flex", flexWrap: "wrap", gap: "6px" };
		const reminderDismissStyle = { ...resetStyle, flexShrink: 0 };
		function ChoiceField(props) {
			const { descriptor, field, t, disabled } = props;
			return react_jsx_runtime.jsx("div", { style: rowStyle, children: [
				react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
					react_jsx_runtime.jsx("span", { style: labelStyle, children: t(descriptor.field) }),
					react_jsx_runtime.jsx("span", { style: hintStyle, children: t(`${descriptor.field}Hint`) })
				] }),
				react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
					descriptor.kind === "boolean" ? react_jsx_runtime.jsx(primitives.Switch, {
						checked: field.text === "true" || (field.text === "" && BOOLEAN_DEFAULTS[descriptor.field] === true),
						onChange: (checked) => props.onChange(String(checked)),
						disabled,
						label: t(descriptor.field)
					}) : react_jsx_runtime.jsx(primitives.SegmentedControl, {
						id: `plugin-config-${ORRERY_NS}-${descriptor.field}`,
						value: field.text,
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
		function OrreryCard(props) {
			const state = props.useOrrerySettingsCard((snapshot) => snapshot);
			const { t } = props;
			if (props.view === "summary") return t("description");
			const disabled = !state.writable;
			const children = GROUPS.flatMap((group, groupIndex) => {
				const rows = group.fields.map((descriptor) => {
					const field = state.fields[descriptor.field];
					if (descriptor.field === "delegateCategoryChains") {
						return react_jsx_runtime.jsx(props.editors.ChainEditorField, {
							field: "delegateCategoryChains",
							text: state.fields.delegateCategoryChains.text,
							overridden: state.fields.delegateCategoryChains.overridden,
							edit: (field, text) => props.edit(field, text),
							onReset: () => props.resetField("delegateCategoryChains"),
							getSession: () => props.getSession(),
							t,
							disabled,
							key: descriptor.field
						});
					}
					if (descriptor.field === "delegateAgentChains") {
						// The curated-agent counterpart of the category chains above:
						// same visual editor, agent lanes and agent dictionary stems.
						return react_jsx_runtime.jsx(props.editors.ChainEditorField, {
							field: "delegateAgentChains",
							rows: CURATED_AGENT_NAMES,
							rowLabelPrefix: "chainAgent_",
							panelHintKey: "chainAgentPanelHint",
							text: state.fields.delegateAgentChains.text,
							overridden: state.fields.delegateAgentChains.overridden,
							edit: (field, text) => props.edit(field, text),
							onReset: () => props.resetField("delegateAgentChains"),
							getSession: () => props.getSession(),
							t,
							disabled,
							key: descriptor.field
						});
					}
					if (descriptor.field === "delegateDisabledCategories") {
						// The closed-set counterpart of the editors above: one switch
						// per registry category, the JSON array of the switched-on
						// names synthesized on save.
						return react_jsx_runtime.jsx(props.editors.DisabledCategoriesEditorField, {
							field: "delegateDisabledCategories",
							rows: CATEGORY_NAMES,
							text: state.fields.delegateDisabledCategories.text,
							overridden: state.fields.delegateDisabledCategories.overridden,
							edit: (field, text) => props.edit(field, text),
							onReset: () => props.resetField("delegateDisabledCategories"),
							t,
							disabled,
							key: descriptor.field
						});
					}
					if (descriptor.field === "robashAllow" || descriptor.field === "robashGitAllow" || descriptor.field === "robashDeny" || descriptor.field === "robashPwshAllow" || descriptor.field === "robashPwshDeny") {
						return react_jsx_runtime.jsx(props.editors.RobashListEditorField, {
							field: descriptor.field,
							text: field.text,
							overridden: field.overridden,
							edit: (name, text) => props.edit(name, text),
							onReset: () => props.resetField(descriptor.field),
							t,
							disabled,
							key: descriptor.field
						});
					}
					if (descriptor.field === "intentGateModel" || descriptor.field === "intentGateReasoningEffort" || descriptor.field === "lspServers") {
						// folded into the model-picker row / the LSP manager panel
						return null;
					}
					if (descriptor.field === "intentGateProvider") {
						const pickerOverridden = state.fields.intentGateProvider.overridden || state.fields.intentGateModel.overridden || state.fields.intentGateReasoningEffort.overridden;
						const pickerRow = react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
							react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
								react_jsx_runtime.jsx("span", { style: labelStyle, children: t(descriptor.field) }),
								react_jsx_runtime.jsx("span", { style: hintStyle, children: t(`${descriptor.field}Hint`) })
							] }),
							react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
								react_jsx_runtime.jsx(modelPicker.ModelPickerField, {
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
						// The picker runs inside an error boundary: a picker
						// failure degrades to plain text fields instead of
						// blanking the settings page.
						return react_jsx_runtime.jsx(modelPicker.ModelPickerBoundary, {
							key: descriptor.field,
							fallback: react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
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
							] }),
							children: pickerRow
						});
					}
					if (descriptor.kind === "boolean" || descriptor.kind === "enum") {
						return react_jsx_runtime.jsx(ChoiceField, {
							descriptor,
							field,
							t,
							disabled,
							onChange: (text) => props.edit(descriptor.field, text),
							onReset: () => props.resetField(descriptor.field),
							key: descriptor.field
						});
					}
					return react_jsx_runtime.jsx(primitives.SettingsValueField, {
						id: `plugin-config-${ORRERY_NS}-${descriptor.field}`,
						label: t(descriptor.field),
						hint: t(`${descriptor.field}Hint`),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidValue"),
						disabled,
						text: field.text,
						invalid: field.invalid,
						overridden: field.overridden,
						onChange: (text) => props.edit(descriptor.field, text),
						onReset: () => props.resetField(descriptor.field),
						key: descriptor.field
					});
				});
				// Edit Lock maintenance: profile-wide switch status and read-only
				// authority diagnostics (read-only; the switch stays a plain field).
				if (group.id === "editing") {
					rows.push(react_jsx_runtime.jsx(props.editors.EditLockMaintenanceField, {
						t,
						key: "edit-lock-maintenance"
					}));
				}
				if (group.id === "lsp") {
					rows.push(react_jsx_runtime.jsx(props.editors.LspManagerField, {
						t,
						key: "lsp-manager",
						serversText: state.fields.lspServers?.text ?? "",
						edit: (field, text) => props.edit(field, text)
					}));
				}
				// macOS-only permission entry: it renders nothing until the host confirms its platform.
				if (group.id === "notify") {
					rows.push(react_jsx_runtime.jsx(props.editors.NotifyPermissionsField, { t, key: "notify-permissions" }));
				}
				return [
					react_jsx_runtime.jsx("h3", { style: groupIndex === 0 ? firstGroupTitleStyle : groupTitleStyle, children: t(`group${group.id.charAt(0).toUpperCase()}${group.id.slice(1)}`), key: `group-${group.id}` }),
					...rows
				].filter(Boolean);
			});
			// Restart reminder: a landed save that touched restart-required
			// keys raises a dismissible banner above the groups, naming the
			// affected options by their translated labels. Absent state (or
			// after dismiss) renders nothing, keeping the rows unchanged.
			const reminder = Array.isArray(state.restartReminder) && state.restartReminder.length > 0 ? state.restartReminder : null;
			if (reminder) {
				children.unshift(react_jsx_runtime.jsxs("div", { style: reminderStyle, children: [
					react_jsx_runtime.jsxs("div", { style: reminderHeaderStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: t("restartReminderTitle") }),
						react_jsx_runtime.jsx("button", { type: "button", style: reminderDismissStyle, onClick: () => props.dismissRestartReminder(), children: t("restartReminderDismiss") })
					] }),
					react_jsx_runtime.jsx("span", { style: hintStyle, children: t("restartReminderBody") }),
					react_jsx_runtime.jsx("div", { style: reminderTagsStyle, children: reminder.map((field) => react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: t(field), key: field })) })
				], key: "restart-reminder" }));
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
		const ITEM_SLOT = "settings.orrery.item";
		const OrrerySection = ({ renderSlot }) => react_jsx_runtime.jsx("div", {
			style: columnStyle,
			children: renderSlot(ITEM_SLOT)
		});
		exports.GROUPS = GROUPS;
		exports.BOOLEAN_DEFAULTS = BOOLEAN_DEFAULTS;
		exports.CURATED_AGENT_NAMES = CURATED_AGENT_NAMES;
		exports.CATEGORY_NAMES = CATEGORY_NAMES;
		exports.RESTART_FIELDS = RESTART_FIELDS;
		exports.FIELDS = FIELDS;
		exports.OrreryCardController = OrreryCardController;
		exports.OrreryCard = OrreryCard;
		exports.OrrerySection = OrrerySection;
		return module.exports;
	}
});
