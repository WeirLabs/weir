window.__ModuleLoader__.load({
	id: "orrery-model-picker",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// Reusable composer-style model picker: one trigger showing
		// "model · effort", expanding into a two-level menu (provider-grouped
		// model list / reasoning-effort list). Self-contained catalog loading
		// (lazy + backoff retries + manual retry) over the caller-provided
		// session RPC accessor, and a React error boundary so a picker failure
		// renders the caller's fallback instead of blanking the page.
		const chevron = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")";
		const triggerStyle = {
			borderRadius: "var(--dsw-radius-sm)",
			maxWidth: "280px",
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
			lineHeight: "20px",
			textAlign: "left",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};
		const menuStyle = {
			position: "absolute",
			top: "calc(100% + 4px)",
			right: 0,
			zIndex: 1000,
			minWidth: "260px",
			maxHeight: "320px",
			overflowY: "auto",
			background: "var(--dsw-specific-selector)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: "var(--dsw-radius-md)",
			boxShadow: "var(--dsw-elevation-soft)",
			padding: "4px"
		};
		const menuRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", width: "100%", padding: "8px 10px", borderRadius: "var(--dsw-radius-sm)", background: "none", border: "none", cursor: "pointer", fontSize: "13px", lineHeight: "18px", textAlign: "left", color: "var(--dsw-alias-label-primary)" };
		const menuHeaderStyle = { fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--dsw-alias-label-secondary)", padding: "8px 10px 2px" };
		function ModelPickerField(props) {
			const { value, onChange, getSession, t, disabled = false } = props;
			const [open, setOpen] = react.useState(false);
			const [pane, setPane] = react.useState("root");
			const [catalog, setCatalog] = react.useState({ status: "idle", groups: [] });
			const inflightRef = react.useRef(null);
			const retriesRef = react.useRef(0);
			const timerRef = react.useRef(void 0);
			const rootRef = react.useRef(null);
			const loadCatalog = react.useCallback(() => {
				if (catalog.status === "ready" || inflightRef.current !== null) return;
				setCatalog((current) => ({ ...current, status: "loading" }));
				const session = getSession();
				if (session === undefined || session === null) {
					setCatalog({ status: "error", groups: [] });
					scheduleRetry();
					return;
				}
				inflightRef.current = session.modelCatalog().then((response) => {
					inflightRef.current = null;
					if (response.ok) {
						setCatalog({ status: "ready", groups: response.value.groups ?? [] });
						retriesRef.current = 0;
					} else {
						setCatalog({ status: "error", groups: [] });
						scheduleRetry();
					}
				}).catch(() => {
					inflightRef.current = null;
					setCatalog({ status: "error", groups: [] });
					scheduleRetry();
				});
			}, [catalog.status, getSession]);
			const scheduleRetry = react.useCallback(() => {
				if (timerRef.current !== void 0 || retriesRef.current >= 4) return;
				const delay = 2000 * 2 ** retriesRef.current;
				retriesRef.current += 1;
				timerRef.current = setTimeout(() => {
					timerRef.current = void 0;
					setCatalog((current) => current.status === "error" ? { ...current, status: "idle" } : current);
				}, delay);
			}, []);
			const retry = react.useCallback(() => {
				if (timerRef.current !== void 0) {
					clearTimeout(timerRef.current);
					timerRef.current = void 0;
				}
				retriesRef.current = 0;
				setCatalog({ status: "idle", groups: [] });
			}, []);
			// lazy load on mount and after manual retry
			react.useEffect(() => {
				loadCatalog();
			}, [loadCatalog]);
			react.useEffect(() => () => {
				if (timerRef.current !== void 0) clearTimeout(timerRef.current);
			}, []);
			// open/close handling
			react.useEffect(() => {
				if (!open) return;
				const onDown = (event) => {
					if (rootRef.current?.contains(event.target) === true) return;
					setOpen(false);
					setPane("root");
				};
				const onKey = (event) => {
					if (event.key === "Escape") {
						setOpen(false);
						setPane("root");
					}
				};
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const groups = catalog.status === "ready" ? catalog.groups.filter((group) => group.models?.length > 0) : [];
			const models = groups.flatMap((group) => group.models.map((model) => ({ group, model })));
			const provider = (value?.provider ?? "").trim();
			const model = (value?.model ?? "").trim();
			const effort = (value?.reasoningEffort ?? "").trim();
			const current = models.find((entry) => entry.group.id === provider && entry.model.id === model);
			const reasoning = current?.model.reasoning;
			const effortChoices = reasoning === undefined ? [] : [
				...(reasoning.defaultEffort === undefined ? [{ id: "", label: t("effortProviderDefault") }] : []),
				...(reasoning.efforts ?? []).map((entry) => ({ id: entry.id, label: entry.name }))
			];
			const modelLabel = current?.model.name ?? (provider || model ? `${provider}/${model}` : t("modelEmpty"));
			const effortLabel = reasoning === undefined ? "" : effortChoices.find((choice) => choice.id === effort)?.label ?? (effort || t("effortProviderDefault"));
			const menuRow = (item) => react_jsx_runtime.jsxs("button", { type: "button", style: menuRowStyle, onClick: () => item.onSelect(), children: [
				react_jsx_runtime.jsx("span", { children: item.label }),
				item.checked ? react_jsx_runtime.jsx("span", { style: { opacity: 0.9 }, children: "✓" }) : item.chevron ? react_jsx_runtime.jsx("span", { style: { opacity: 0.6 }, children: "›" }) : null
			] });
			return react_jsx_runtime.jsxs("div", { ref: rootRef, style: { position: "relative" }, children: [
				react_jsx_runtime.jsx("button", {
					type: "button",
					style: triggerStyle,
					disabled,
					onClick: () => {
						if (catalog.status === "error") retry();
						setOpen(!open);
						setPane("root");
					},
					children: catalog.status === "ready" ? `${modelLabel}${effortLabel ? ` · ${effortLabel}` : ""}` : catalog.status === "error" ? (provider || model ? modelLabel : t("catalogFailed")) : t("catalogLoading")
				}),
				open ? react_jsx_runtime.jsxs("div", { role: "menu", style: menuStyle, children: pane === "root" ? [
					menuRow({ label: t("pickerModel"), chevron: true, onSelect: () => setPane("model") }),
					menuRow({ label: t("pickerEffort"), chevron: true, onSelect: () => setPane("effort") })
				] : pane === "model" ? groups.flatMap((group) => [
					react_jsx_runtime.jsx("div", { style: menuHeaderStyle, children: group.id, key: `h-${group.id}` }),
					...group.models.map((entry) => menuRow({
						label: entry.name ?? entry.id,
						checked: provider === group.id && model === entry.id,
						onSelect: () => {
							onChange({
								provider: group.id,
								model: entry.id,
								reasoningEffort: entry.reasoning?.defaultEffort ?? ""
							});
							setOpen(false);
							setPane("root");
						}
					}))
				]) : effortChoices.map((choice) => menuRow({
					label: choice.label,
					checked: choice.id === "" ? !effort : effort === choice.id,
					onSelect: () => {
						onChange({
							provider,
							model,
							reasoningEffort: choice.id
						});
						setOpen(false);
						setPane("root");
					}
				})) }) : null
			] });
		}
		var ModelPickerBoundary = class extends react.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.error("orrery-model-picker contained:", error);
			}
			render() {
				return this.state.failed ? this.props.fallback : this.props.children;
			}
		};
		const inject = [];
		function apply() {}
		exports.inject = inject;
		exports.apply = apply;
		exports.ModelPickerField = ModelPickerField;
		exports.ModelPickerBoundary = ModelPickerBoundary;
		return module.exports;
	}
});
