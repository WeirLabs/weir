window.__ModuleLoader__.load({
	id: "orrery-harness",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// The Orrery settings page, browser half: one flat form over the
		// `orrery-settings` namespace (the shared SettingsFormModel only
		// addresses flat fields). Registers into the Plugins page's
		// `plugins.item` slot while the Host serves that namespace.
		const ORRERY_NS = "orrery-settings";
		const GROUPS = [
			{ id: "intent", fields: [
				{ field: "intentGateClassifier", kind: "enum", values: ["regex", "llm", "jev"] },
				{ field: "intentGateProvider", kind: "text" },
				{ field: "intentGateModel", kind: "text" },
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
			catalogStatus = "idle";
			catalogGroups = [];
			constructor(scope, remote) {
				this.remote = remote;
				this.form = new primitives.SettingsFormModel(scope, FIELDS.map(specFor));
				this.store = this.form.bind(() => this.projection());
				this.loadCatalog();
			}
			async loadCatalog() {
				if (this.catalogStatus === "loading" || this.catalogStatus === "ready") return;
				this.catalogStatus = "loading";
				this.republish();
				try {
					const response = await this.remote.session.modelCatalog();
					if (!response.ok) throw new Error(`${response.error?.code ?? ""}: ${response.error?.message ?? "catalog failed"}`);
					this.catalogGroups = response.value.groups ?? [];
					this.catalogStatus = "ready";
				} catch {
					this.catalogStatus = "error";
				}
				this.republish();
			}
			republish() {
				this.store?.set(this.projection());
			}
			projection() {
				const fields = {};
				for (const descriptor of FIELDS) fields[descriptor.field] = this.form.field(descriptor.field);
				return {
					...this.form.shell(),
					fields,
					catalog: {
						status: this.catalogStatus,
						groups: this.catalogGroups
					}
				};
			}
			inject() {
				return {
					hooks: { orrerySettingsCard: this.store },
					...this.form.actions()
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
		const chevron = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
		const selectStyle = {
			borderRadius: "var(--dsw-radius-sm)",
			maxWidth: "220px",
			height: "28px",
			color: "var(--dsw-alias-label-secondary)",
			whiteSpace: "nowrap",
			cursor: "pointer",
			appearance: "none",
			backgroundColor: "transparent",
			backgroundImage: chevron,
			backgroundPosition: "right 4px center",
			backgroundRepeat: "no-repeat",
			backgroundSize: "12px 12px",
			border: "none",
			outline: "none",
			padding: "0 20px 0 8px",
			fontSize: "13px",
			fontWeight: 500,
			lineHeight: "20px"
		};
		function ChoiceField(props) {
			const { descriptor, field, t, disabled } = props;
			return react_jsx_runtime.jsx("div", { style: rowStyle, children: [
				react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
					react_jsx_runtime.jsx("span", { style: labelStyle, children: t(descriptor.field) }),
					react_jsx_runtime.jsx("span", { style: hintStyle, children: t(`${descriptor.field}Hint`) })
				] }),
				react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
					field.overridden ? react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: t("overridden") }) : null,
					field.overridden ? react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: props.onReset, children: t("reset") }) : null,
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
					})
				] })
			] });
		}
		function ModelPickerField(props) {
			const { descriptor, providerText, modelText, catalog, t, disabled } = props;
			const groups = catalog.status === "ready" ? catalog.groups : [];
			const providerGroups = groups.filter((group) => group.models?.length > 0);
			const provider = providerText.trim();
			const currentGroup = providerGroups.find((group) => group.id === provider);
			const modelOptions = currentGroup?.models ?? [];
			const selectProps = (field, options, value) => ({
				style: selectStyle,
				value,
				disabled,
				onChange: (event) => props.onChange(field, event.target.value)
			});
			return react_jsx_runtime.jsx("div", { style: rowStyle, children: [
				react_jsx_runtime.jsxs("div", { style: labelGroupStyle, children: [
					react_jsx_runtime.jsx("span", { style: labelStyle, children: t(descriptor.field) }),
					react_jsx_runtime.jsx("span", { style: hintStyle, children: catalog.status === "error" ? t("catalogFailed") : t(`${descriptor.field}Hint`) })
				] }),
				react_jsx_runtime.jsxs("div", { style: controlsStyle, children: [
					props.providerOverridden ? react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: t("overridden") }) : null,
					props.providerOverridden ? react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: () => props.onReset("intentGateProvider"), children: t("reset") }) : null,
					react_jsx_runtime.jsxs("select", { ...selectProps("intentGateProvider", providerGroups.map((group) => group.id), provider), children: [
						react_jsx_runtime.jsx("option", { value: "", children: catalog.status === "ready" ? t("providerEmpty") : t("catalogLoading") }),
						...providerGroups.map((group) => react_jsx_runtime.jsx("option", { value: group.id, children: group.id, key: group.id }))
					] }),
					props.modelOverridden ? react_jsx_runtime.jsx(primitives.Tag, { tone: "accent", children: t("overridden") }) : null,
					props.modelOverridden ? react_jsx_runtime.jsx("button", { type: "button", style: resetStyle, onClick: () => props.onReset("intentGateModel"), children: t("reset") }) : null,
					react_jsx_runtime.jsxs("select", { ...selectProps("intentGateModel", modelOptions.map((model) => model.id), modelText.trim()), children: [
						react_jsx_runtime.jsx("option", { value: "", children: t("modelEmpty") }),
						...modelOptions.map((model) => react_jsx_runtime.jsx("option", { value: model.id, children: model.id, key: model.id }))
					] })
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
					if (descriptor.field === "intentGateProvider" || descriptor.field === "intentGateModel") {
						const providerText = state.fields.intentGateProvider.text;
						const modelText = state.fields.intentGateModel.text;
						return react_jsx_runtime.jsx(ModelPickerField, {
							descriptor,
							providerText,
							modelText,
							catalog: state.catalog,
							providerOverridden: state.fields.intentGateProvider.overridden,
							modelOverridden: state.fields.intentGateModel.overridden,
							t,
							disabled,
							onChange: (fieldName, text) => props.edit(fieldName, text),
							onReset: (fieldName) => props.resetField(fieldName),
							key: descriptor.field
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
				];
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
			intentGateTimeoutMs: "Classifier timeout (ms)",
			intentGateTimeoutMsHint: "Classification fails open to the regex result on timeout.",
			jevEndpoint: "Jev endpoint",
			jevEndpointHint: "Jev decisions endpoint (experimental mode).",
			jevModel: "Jev model",
			jevModelHint: "Jev model name (experimental mode).",
			jevApiKeyEnv: "Jev API key env var",
			jevApiKeyEnvHint: "Environment variable name holding the Jev API key (the key itself never enters config).",
			delegateCategoryChains: "Category model chains (JSON)",
			delegateCategoryChainsHint: "JSON map of category → ordered [{provider, model, reasoningEffort?}] rungs; replaces the category chain wholesale.",
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
			lspEnabledHint: "LSP semantic tools for new sessions; off by default, per-session toggle available via the lsp tool (true/false)."
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
			intentGateTimeoutMs: "分类器超时（毫秒）",
			intentGateTimeoutMsHint: "超时按正则结果 fail-open。",
			jevEndpoint: "Jev 端点",
			jevEndpointHint: "Jev 决策端点（实验模式）。",
			jevModel: "Jev 模型",
			jevModelHint: "Jev 模型名（实验模式）。",
			jevApiKeyEnv: "Jev 密钥环境变量名",
			jevApiKeyEnvHint: "持有 Jev API 密钥的环境变量名（密钥本身永不入配置）。",
			delegateCategoryChains: "类别模型链（JSON）",
			delegateCategoryChainsHint: "类别 → 有序 [{provider, model, reasoningEffort?}] 档位的 JSON 映射；整链替换该类别的 chain。",
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
			lspEnabledHint: "新会话的 LSP 语义工具；默认关，会话内可用 lsp 工具随时开关（true/false）。"
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
		const inject = ["slots", "locale", "configForms", "remote"];
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-orrery-settings: dictionaries");
			const card = new OrreryCardController(ctx.configForms.get(ORRERY_NS), ctx.remote);
			ctx.effect(() => () => {
				card.dispose();
			}, "ui-orrery-settings: form subscription");
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
		return module.exports;
	}
});
