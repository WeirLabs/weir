window.__ModuleLoader__.load({
	id: "orrery-harness",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let modelPicker = require("orrery-model-picker");
		// Orrery settings page, browser half: one flat form over the
		// `orrery-settings` namespace (the shared SettingsFormModel only
		// addresses flat fields). Registers into the Plugins page's
		// `plugins.item` slot while the Host serves that namespace; also
		// injects the per-session LSP toggle into the conversation composer bar.
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
				{ field: "hashlineHideStockEdit", kind: "boolean" }
			] },
			{ id: "robash", fields: [
				{ field: "robashEnabled", kind: "boolean" }
			] },
			{ id: "lsp", fields: [
				{ field: "lspEnabled", kind: "boolean" }
			] }
		];
		const FIELDS = GROUPS.flatMap((group) => group.fields);
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
			constructor(scope, ctx) {
				// Keep the plugin context; the model picker resolves the
				// remote.session domain lazily at call time (it may not be
				// wired yet during apply).
				this.ctx = ctx;
				this.form = new primitives.SettingsFormModel(scope, FIELDS.map(specFor));
				this.store = this.form.bind(() => this.projection());
			}
			getSession() {
				return this.ctx.remote.session;
			}
			projection() {
				const fields = {};
				for (const descriptor of FIELDS) fields[descriptor.field] = this.form.field(descriptor.field);
				return {
					...this.form.shell(),
					fields
				};
			}
			inject() {
				const actions = this.form.actions();
				return {
					hooks: { orrerySettingsCard: this.store },
					...actions,
					// After a successful settings save the host committed new
					// volatile values: bump the bus so session-surface consumers
					// (the LSP toggle) re-check live.
					save: (...args) => {
						const result = actions.save(...args);
						Promise.resolve(result).then(() => settingsBus.notify(), () => {});
						return result;
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
		const chainPanelStyle = { display: "flex", flexDirection: "column", gap: "12px", padding: "12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)", background: "var(--dsw-alias-interactive-bg-solid)", marginTop: "8px" };
		const chainCategoryStyle = { fontSize: "13px", fontWeight: 600, lineHeight: "18px" };
		const chainDescStyle = { fontSize: "12px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" };
		const chainRungStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" };
		const chainButtonStyle = { background: "none", border: "none", cursor: "pointer", fontSize: "12px", color: "var(--dsw-alias-label-secondary)", textDecoration: "underline" };
		const chainSaveStyle = { background: "var(--dsw-alias-state-business-primary)", border: "none", cursor: "pointer", color: "#fff", borderRadius: "var(--dsw-radius-sm)", padding: "4px 14px", fontSize: "13px" };
		/** Visual editor for the category model chains: pick models per lane, JSON synthesized on save. */
		function ChainEditorField(props) {
			const [open, setOpen] = react.useState(false);
			const [staged, setStaged] = react.useState(null);
			const openEditor = () => {
				setStaged(jsonToChains(props.text));
				setOpen(true);
			};
			const save = () => {
				props.edit("delegateCategoryChains", chainsToJson(staged));
				setOpen(false);
				setStaged(null);
			};
			const cancel = () => {
				setOpen(false);
				setStaged(null);
			};
			const updateRung = (category, index, rung) => setStaged((current) => ({
				...current,
				[category]: (current?.[category] ?? []).map((entry, at) => at === index ? { ...entry, ...rung } : entry)
			}));
			const addRung = (category) => setStaged((current) => ({
				...current,
				[category]: [...(current?.[category] ?? []), { provider: "", model: "", reasoningEffort: "" }]
			}));
			const removeRung = (category, index) => setStaged((current) => ({
				...current,
				[category]: (current?.[category] ?? []).filter((entry, at) => at !== index)
			}));
			const clearCategory = (category) => setStaged((current) => ({ ...current, [category]: [] }));
			return react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }, children: [
				react_jsx_runtime.jsxs("div", { style: rowStyle, children: [
					react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
						react_jsx_runtime.jsx("span", { style: labelStyle, children: props.t("delegateCategoryChains") }),
						react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t("delegateCategoryChainsHint") })
					] }),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: openEditor, children: props.t("chainEdit") }),
						props.overridden ? react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
							react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: props.t("overridden") }),
							react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: props.onReset, children: props.t("reset") })
						] }) : null
					] })
				] }),
				open && staged !== null ? react_jsx_runtime.jsxs("div", { style: chainPanelStyle, children: [
					react_jsx_runtime.jsx("span", { style: hintStyle, children: props.t("chainPanelHint") }),
					...CHAIN_CATEGORIES.map((category) => {
						const rungs = staged[category] ?? [];
						return react_jsx_runtime.jsxs("div", { key: category, children: [
							react_jsx_runtime.jsxs("div", { children: [
								react_jsx_runtime.jsx("span", { style: chainCategoryStyle, children: props.t(`chainCategory_${category}`) }),
								" ",
								react_jsx_runtime.jsx("span", { style: chainDescStyle, children: props.t(`chainCategory_${category}_desc`) })
							] }),
							...rungs.map((rung, index) => react_jsx_runtime.jsxs("div", { style: chainRungStyle, key: index, children: [
								react_jsx_runtime.jsx(modelPicker.ModelPickerField, {
									value: rung,
									onChange: (selection) => updateRung(category, index, selection),
									getSession: () => props.getSession(),
									t: props.t,
									disabled: props.disabled
								}),
								react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => removeRung(category, index), children: props.t("chainRemove") })
							] })),
							react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: "12px" }, children: [
								react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => addRung(category), children: `+ ${props.t("chainAddRung")}` }),
								rungs.length > 0 ? react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, disabled: props.disabled, onClick: () => clearCategory(category), children: props.t("chainClear") }) : null
							] })
						] });
					}),
					react_jsx_runtime.jsxs("div", { style: { display: "flex", justifyContent: "flex-end", gap: "12px" }, children: [
						react_jsx_runtime.jsx("button", { type: "button", style: chainButtonStyle, onClick: cancel, children: props.t("chainCancel") }),
						react_jsx_runtime.jsx("button", { type: "button", style: chainSaveStyle, disabled: props.disabled, onClick: save, children: props.t("chainSave") })
					] })
				] }) : null
			] });
		}

		function ChoiceField(props) {
			const { descriptor, field, t, disabled } = props;
			return react_jsx_runtime.jsx("div", { style: rowStyle, children: [
				react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
					react_jsx_runtime.jsx("span", { style: labelStyle, children: t(descriptor.field) }),
					react_jsx_runtime.jsx("span", { style: hintStyle, children: t(`${descriptor.field}Hint`) })
				] }),
				react_jsx_runtime.jsxs("div", { style: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }, children: [
					descriptor.kind === "boolean" ? react_jsx_runtime.jsx(primitives.Switch, {
						checked: field.text === "true",
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
						return react_jsx_runtime.jsx(ChainEditorField, {
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
					if (descriptor.field === "intentGateModel" || descriptor.field === "intentGateReasoningEffort") {
						// folded into the single ModelPickerField row below
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
				return [
					react_jsx_runtime.jsx("h3", { style: groupIndex === 0 ? firstGroupTitleStyle : groupTitleStyle, children: t(`group${group.id.charAt(0).toUpperCase()}${group.id.slice(1)}`), key: `group-${group.id}` }),
					...rows
				].filter(Boolean);
			});
			return react_jsx_runtime.jsxs(primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children
			});
		}
		const en = {
			title: "Orrery",
			description: "One-stop configuration for the Orrery preset: intent classification, model chains, continuation, context pressure, editing, read-only bash, and LSP.",
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
			robashEnabled: "Read-only bash guard",
			robashEnabledHint: "Guarded read-only bash for curated agents, master switch (true/false).",
			lspEnabled: "LSP semantic tools",
			lspEnabledHint: "Capability master switch: off removes LSP entirely; on adds a per-session switch in the composer bar (sessions start with LSP off).",
			lspToggleLabel: "LSP",
			lspToggleTitle: "Toggle LSP semantic tools for this session"
		};
		const zh = {
			title: "Orrery",
			description: "Orrery 预设的一站式配置：意图分类、模型链、续推、上下文压力、编辑、只读 bash 与 LSP。",
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
			robashEnabled: "只读 bash 守卫",
			robashEnabledHint: "精选只读代理的受守卫 bash 总开关（true/false）。",
			lspEnabled: "LSP 语义工具",
			lspEnabledHint: "能力总开关：关闭则完全移除 LSP；开启后输入栏出现本会话开关（新会话默认关，按会话启用）。",
			lspToggleLabel: "LSP",
			lspToggleTitle: "为本会话启用/禁用 LSP 语义工具"
		};
		const NS = "settings.orrery";
		const SECTION_ID = "orrery-settings";
		const ITEM_SLOT = "settings.orrery.item";
		const columnStyle = {
			display: "flex",
			flexDirection: "column",
			gap: "var(--dsw-spacing-3, 12px)"
		};
		const OrrerySection = ({ renderSlot }) => react_jsx_runtime.jsx("div", {
			style: columnStyle,
			children: renderSlot(ITEM_SLOT)
		});
		// ---- Per-session LSP toggle (conversation composer bar) ----
		const LSP_PROJECTION_KEY = "orreryLsp";
		const lspToggleStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: "6px",
			background: "none",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-sm)",
			cursor: "pointer",
			padding: "3px 8px",
			fontSize: "12px",
			lineHeight: "16px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const lspDotStyle = (on) => ({
			width: "7px",
			height: "7px",
			borderRadius: "50%",
			background: on ? "var(--dsw-alias-state-business-primary)" : "var(--dsw-alias-label-disabled, #999)"
		});
		function LspToggle(props) {
			const hasProjectionHook = typeof props.useProjection === "function";
			const projection = hasProjectionHook ? props.useProjection(LSP_PROJECTION_KEY) : undefined;
			const [available, setAvailable] = react.useState(null);
			const [pending, setPending] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [localState, setLocalState] = react.useState(undefined);
			const sessionId = props.sessionId;
			const t = props.t;
			react.useEffect(() => {
				if (!sessionId) {
					setAvailable(false);
					return undefined;
				}
				let alive = true;
				const check = () => {
					Promise.resolve(props.commandsList(sessionId))
						.then((list) => {
							if (alive) setAvailable(Array.isArray(list) && list.some((entry) => entry?.name === "lsp"));
						})
						.catch(() => {
							if (alive) setAvailable(false);
						});
				};
				setAvailable(null);
				check();
				const unsubscribe = settingsBus.subscribe(check);
				return () => {
					alive = false;
					unsubscribe();
				};
			}, [sessionId]);
			// Fallback initial state when the slot does not inject useProjection.
			react.useEffect(() => {
				if (hasProjectionHook || localState !== undefined || !sessionId) return;
				let alive = true;
				Promise.resolve(props.fetchLspState())
					.then((enabled) => {
						if (alive && typeof enabled === "boolean") setLocalState(enabled);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, [sessionId, hasProjectionHook, localState]);
			if (available !== true) return null;
			const on = hasProjectionHook ? projection?.enabled === true : localState === true;
			const toggle = () => {
				if (pending) return;
				setPending(true);
				setError(null);
				Promise.resolve(props.toggleLsp(!on)).then(
					(failure) => {
						setPending(false);
						if (failure) {
							setError(failure);
						} else if (!hasProjectionHook) {
							setLocalState(!on);
						}
					},
					(reason) => {
						setPending(false);
						setError(reason instanceof Error ? reason.message : String(reason));
					}
				);
			};
			return react_jsx_runtime.jsxs("button", {
				type: "button",
				style: lspToggleStyle,
				onClick: toggle,
				disabled: pending,
				"aria-pressed": on,
				"data-orrery-lsp-toggle": "",
				"data-orrery-lsp-state": on ? "on" : "off",
				title: error ?? t("lspToggleTitle"),
				children: [
					react_jsx_runtime.jsx("span", { style: lspDotStyle(on), "aria-hidden": true }),
					react_jsx_runtime.jsx("span", { children: t("lspToggleLabel") })
				]
			});
		}
		const inject = ["slots", "locale", "configForms", "remote", "remote.session", "remote.commands"];
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-orrery-settings: dictionaries");
			const card = new OrreryCardController(ctx.configForms.get(ORRERY_NS), ctx);
			ctx.effect(() => () => {
				card.dispose();
			}, "ui-orrery-settings: form subscription");
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
			}, LspToggle)), "ui-orrery-settings: lsp session switch");
			// Top-level Settings section (same place as dsh-web-kimi and the
			// built-in General/Models sections), with a nested item slot
			// hosting the form; plus a Plugins-page entry for discoverability.
			ctx.effect(() => ctx.configForms.whileServed([ORRERY_NS], () => {
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
				}, OrrerySection));
				const offItem = ctx.slots.inject(ITEM_SLOT, () => ctx.slots.register({
					name: ITEM_SLOT,
					id: "orrery-config",
					order: 0,
					locale: NS,
					inject: () => card.inject()
				}, OrreryCard));
				const offPluginsItem = ctx.slots.inject("plugins.item", () => ctx.slots.register({
					name: "plugins.item",
					id: "orrery-settings",
					order: 30,
					label: () => t("title"),
					locale: NS,
					inject: () => card.inject()
				}, OrreryCard));
				return () => {
					offSection();
					offItem();
					offPluginsItem();
				};
			}), "ui-orrery-settings: page");
		}
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.chainEditor = { jsonToChains, chainsToJson };
		return module.exports;
	}
});
