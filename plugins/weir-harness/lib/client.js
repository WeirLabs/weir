// Weir client chunks: {"client.blackboard-model.js":"2e5abdd44edb599d10d9d547fa07133e84250d6007161c2c8704b58151896f93","client.blackboard-panel.js":"c9d6a0f02623075fc884f3519f982574ad33ad871f7bcd7e8c36f12512f0de39","client.capability-badge.js":"6ffd703f498e0aa5cc8ac78f244402ec4ceee56d22d2a0e74c246799565776cc","client.capability-manager.js":"d22e8116922f98e61bbbdf36fc78bd81e8b47b0ee5e75ddb06bea4e204749b89","client.capability-model.js":"73b10d3fecd804f4f8f1cbe307c85db650b5206e7ad6393b34213f77cccc8312","client.capability-presets.js":"12ac8da3568d013abd76b67cfe473a329f4af2feaac9cd55a82d8881e5bc1017","client.chain-editor.js":"1e9a33bc68cabc43bc27b91ef83eab5028a33256596c147e15722d684687765b","client.chain-model.js":"2e885922cf8c2972725c6eef8bf20c7d1202d961edfb8ad41574dac062d74371","client.disabled-categories-editor.js":"f9103fd2e2691eda9afd199e1a5462189097a9f3dee0518be5fa3587d896e033","client.file-lease-badge.js":"cd30546307c91c94fe05484557e46f58c53fe55657f62b0a0415a072dfb3b582","client.hash-edit-model.js":"71727d47a6ef32ebd2abfb063fa93499a5e607d6716e3ec8983ae056c4fb317f","client.hash-edit-view.js":"fc0f4dabddab9a48527553ad4232b3715e46e6863aab75e02ae2dcd6687265c2","client.lsp-model.js":"30943ed1ed11c1f2770a724da855ea2417c11566c2778c79e17cfc2de499cd80","client.lsp-panel.js":"61629a4d317dae9ed01c1cc0355632fb752788dc23f7606257188050734cd030","client.lsp-toggle.js":"d6af81be5e5b854e98563bbb9349a6db89834a9d7dee9cf0e97759ecb32090e8","client.model-picker.js":"57f96826e00b37ae6d6474a6750f31b4e128e5fdb37e302875a41cdb2e18f14a","client.notify-permissions.js":"2be9bdbeffef96baa3cbe4ce430ab30a1d1bf797782453d287d54602ea47db8e","client.notify-web.js":"0943f67d5526ff0fb7cb4f69580e0a9ea54ed06465c513afc51a5a7fb1c55ccf","client.robash-editor.js":"cd6a283b72cb02598e32ca4ce03a1b8de5f328ecdd1f5f920377524f3bdcbe1c","client.robash-model.js":"f4395338a773e8bb48e4f96aeb737cd634edcca0b90af992a7dbbe47be42e451","client.settings-page.js":"f3c04a5b33cdb963357bc653f7050e598f19efc4cc833694379a4ba055e949d3","client.worktree-model.js":"8bfbaaa080f20e90a0128afccb9b4e232514615a8f2fee3a32a42dde78b34a8f","client.worktree-view.js":"356c3f5f683b8509ae8679243a6460ca02957fd15e057a629b2ac4fdd12ed057"}
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
			routingTitle: "Weir Model Routing",
			loading: "Loading Weir settings…",
			loadFailed: "Weir settings could not be loaded:",
			// Worktree lanes: only the strings the entry’s own synchronous surfaces
			// read stay in this namespace — the sidebar tab type’s title/guide thunks
			// and the lanes panel’s pre-arrival loading state. Every lazily rendered
			// string (the header pill included: its wrapper renders nothing until the
			// chunks arrive) lives in lib/client.worktree-model.js’s data face,
			// registered under "settings.weir.worktree" on worktree-batch arrival.
			// worktreeLoading is byte-identical in both homes — a documented
			// cross-namespace duplicate (the panel’s pre-arrival state resolves it
			// here, the chunk’s own loading row from its feature namespace).
			worktreeTabLabel: "Worktrees",
			worktreeGuideTitle: "Worktree lanes",
			worktreeGuideDescription: "Lanes for this session: state, checks, merge, cleanup.",
			worktreeLoading: "Loading lanes…",
			hashEditInput: "Input",
			hashEditOutput: "Output",
			// Session capability Badge + manager (12.x, D3/D4): the chunks carry
			// the same strings as in-code fallbacks; these rows translate them.
			capabilityTabLabel: "Capabilities",
			capabilityGuideTitle: "Capabilities",
			capabilityGuideDescription: "Skills, MCP servers, and presets for this session.",
			"capability.loading": "Loading capabilities…",
			// Session blackboard (slice 2): the right-sidebar panel's tab, list,
			// detail and editor strings. Type labels are short semantic names,
			// translated per locale.
			blackboardTabLabel: "Blackboard",
			blackboardGuideTitle: "Session blackboard",
			blackboardGuideDescription: "Findings shared across this session: entries, usage counts, arbitrated editing.",
			blackboardPillTitle: "Open the session blackboard",
			"blackboard.loading": "Loading the board…",
		};
		const zh = {
			title: "Weir",
			routingTitle: "Weir 模型路由",
			loading: "正在加载 Weir 设置…",
			loadFailed: "Weir 设置加载失败：",
			// Worktree lanes: only the strings the entry’s own synchronous surfaces
			// read stay in this namespace — the sidebar tab type’s title/guide thunks
			// and the lanes panel’s pre-arrival loading state. Every lazily rendered
			// string (the header pill included: its wrapper renders nothing until the
			// chunks arrive) lives in lib/client.worktree-model.js’s data face,
			// registered under "settings.weir.worktree" on worktree-batch arrival.
			// worktreeLoading is byte-identical in both homes — a documented
			// cross-namespace duplicate (the panel’s pre-arrival state resolves it
			// here, the chunk’s own loading row from its feature namespace).
			worktreeTabLabel: "Worktrees",
			worktreeGuideTitle: "Worktree 车道",
			worktreeGuideDescription: "本会话的车道：状态、检查、合并与收尾。",
			worktreeLoading: "正在加载车道…",
			hashEditInput: "输入",
			hashEditOutput: "输出",
			capabilityTabLabel: "能力",
			capabilityGuideTitle: "能力",
			capabilityGuideDescription: "此会话的技能、MCP server 与预设。",
			"capability.loading": "正在加载能力…",
			// 会话黑板（切片二）：右侧边栏面板的页签、列表、详情与编辑字符串。
			// 类型标签为短语义名，随语言翻译。
			blackboardTabLabel: "黑板",
			blackboardGuideTitle: "会话黑板",
			blackboardGuideDescription: "本会话共享的发现：条目、用量计数与仲裁编辑。",
			blackboardPillTitle: "打开会话黑板",
			"blackboard.loading": "正在加载黑板…",
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
		// ---- Chunk-carried dictionaries ----
		// Every lazily delivered feature chunk carries a pure { en, zh } data
		// face (NO ctx calls inside a chunk: the factory re-executes under HMR,
		// so a chunk-local register would throw on the duplicate (namespace,
		// locale) pair). The entry registers one namespace per feature when the
		// chunk arrives, inside a ctx.effect whose disposer owns the
		// registration (released on fiber unload before any re-registration).
		// NS keeps only the strings apply-time-registered synchronous face
		// callbacks read: tab titles and guide copy, pill labels, and the
		// pre-arrival loading states. This bridge is how the module-level
		// loaders and wrappers receive apply-scope values (the registration
		// hook and the feature t seats); apply() fills it before anything can
		// load a chunk, and an HMR restart re-executes this factory and refills.
		const chunkDictionaries = {
			register: null,
			lspToggle: null,
			hashEdit: null,
			fileLease: null,
			worktree: null,
		};
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
		]).then((chunks) => {
			chunkDictionaries.register?.("settings.weir.hash-edit", chunks[1].dictionaries);
			return chunks;
		}));
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
				return react_jsx_runtime.jsx(view.HashEditRow, { ...props, t: chunkDictionaries.hashEdit ?? props.t, model });
			}
			return react_jsx_runtime.jsx(HashEditFallbackBody, props);
		}
		const loadLspToggleChunk = lazyChunks(() => require.async("./client.lsp-toggle.js").then((chunk) => {
			chunkDictionaries.register?.("settings.weir.lsp-toggle", chunk.dictionaries);
			return chunk;
		}));
		const loadNotifyWebChunk = lazyChunks(() => require.async("./client.notify-web.js"));
		/** Composer-bar wrapper: renders nothing until the toggle chunk arrives
		 * (and nothing at all when the slot injected no session id — the
		 * capability gate's absence case, which must not pull the chunk). */
		function LspToggleWrapper(props) {
			const arrival = useChunkArrival(loadLspToggleChunk, typeof props.sessionId === "string" && props.sessionId !== "");
			if (!arrival?.chunks) return null;
			return react_jsx_runtime.jsx(arrival.chunks.LspToggle, { ...props, settingsBus, t: chunkDictionaries.lspToggle ?? props.t });
		}
		const loadFileLeaseChunk = lazyChunks(() => require.async("./client.file-lease-badge.js").then((chunk) => {
			chunkDictionaries.register?.("settings.weir.file-lease", chunk.dictionaries);
			return chunk;
		}));
		/** Composer-bar file-lease entry: nothing until its chunk arrives. */
		function FileLeaseBadgeWrapper(props) {
			const arrival = useChunkArrival(loadFileLeaseChunk, typeof props.sessionId === "string" && props.sessionId !== "");
			if (!arrival?.chunks) return null;
			return react_jsx_runtime.jsx(arrival.chunks.FileLeaseBadge, { ...props, t: chunkDictionaries.fileLease ?? props.t });
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
		]).then((chunks) => {
			chunkDictionaries.register?.("settings.weir.worktree", chunks[1].dictionaries);
			return chunks;
		}));
		/** The views name keys without the namespace prefix ("abandon",
		 * "state_landable"); the dictionaries hold them prefixed
		 * ("worktreeAbandon", "worktreeState_landable"). Hyphens in state names
		 * map to underscores. The seat binds the feature namespace
		 * ("settings.weir.worktree", registered on batch arrival) once apply()
		 * has filled the bridge; props.t is the pre-apply/test fallback. */
		const worktreeKey = (key) => `worktree${key.charAt(0).toUpperCase()}${key.slice(1)}`.replace(/-/g, "_");
		const worktreeT = (t) => (typeof t === "function" ? (key, ...rest) => t(worktreeKey(String(key)), ...rest) : t);
		const worktreeFace = (props, view, model) => ({
			...props,
			t: worktreeT(chunkDictionaries.worktree ?? props.t),
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
			return react_jsx_runtime.jsx(view.WorktreeToolRow, { ...props, t: worktreeT(chunkDictionaries.worktree ?? props.t), model });
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
			// Chunk-carried dictionaries: one registration per feature namespace
			// per apply (a duplicate (namespace, locale) pair throws
			// synchronously), owned by an effect disposer so an HMR unload
			// releases it before any re-registration. The per-apply Set makes a
			// repeated arrival (a second surface of the same feature) a no-op.
			const registeredDictNamespaces = new Set();
			const registerChunkDictionaries = (ns, dictionaries) => {
				const en = dictionaries?.en;
				const zh = dictionaries?.zh;
				// Sentinel chunks in unit tests carry no data face: nothing to register.
				if ((!en || Object.keys(en).length === 0) && (!zh || Object.keys(zh).length === 0)) return;
				if (registeredDictNamespaces.has(ns)) return;
				registeredDictNamespaces.add(ns);
				ctx.effect(() => ctx.locale.register(ns, { zh: zh ?? {}, en: en ?? {} }), `ui-weir-settings: ${ns} dictionaries`);
			};
			chunkDictionaries.register = registerChunkDictionaries;
			chunkDictionaries.lspToggle = ctx.locale.bind("settings.weir.lsp-toggle");
			chunkDictionaries.hashEdit = ctx.locale.bind("settings.weir.hash-edit");
			chunkDictionaries.fileLease = ctx.locale.bind("settings.weir.file-lease");
			chunkDictionaries.worktree = ctx.locale.bind("settings.weir.worktree");
			const pageT = ctx.locale.bind("settings.weir.page");
			const capabilityT = ctx.locale.bind("settings.weir.capability");
			const blackboardT = ctx.locale.bind("settings.weir.blackboard");
			// ---- Channel adapters (composition root) ----
			// Every feature read channel below rides one of two carriers through
			// these adapters instead of re-hand-building "POST → unfold the {ok,
			// value} envelope → warn-once on degradation" per site. A channel call
			// NEVER rejects: a carrier throw folds to { ok:false, error:{ code:
			// "call-threw" } }, a failure envelope to call-failed, a missing gateway
			// connection to channel-unavailable — the folded shape the blackboard
			// model chunk's foldRemoteResult used to own chunk-side. Warn-once keeps
			// degradation observable: once per failure shape per page generation (an
			// apply() run), never per render (the silent-fallback lesson). The kind
			// strings, the per-channel method labeling and the documented cold-open
			// "unknown session" silence are byte-identical to the hand-written sites
			// this replaces.
			const createWarnOnce = (label) => {
				const warned = new Set();
				return (kind, method, detail) => {
					if (warned.has(kind)) return;
					warned.add(kind);
					console.warn(`[weir] ${label} degraded (${kind}${method ? `, ${method}` : ""})`, detail ?? "");
				};
			};
			// Raw-gateway carrier (connection.rpc.call("/api", …)) for the endpoints
			// that cannot mount a typed namespace: ctx.remote.$mount's strict-codec
			// gate rejects src-json codecs, and declaring the namespace in inject
			// would park this fiber forever, so these channels ride the raw gateway
			// (zero session-log events). requireValue marks channels whose callers
			// treat an ok envelope with a null value as a failure (capability reads).
			const createGatewayChannel = ({ label, unavailableMessage, warnOnFailure = false, silentFailure = null, requireValue = false, methodOf = (endpoint) => endpoint }) => {
				const warn = createWarnOnce(label);
				return async (endpoint, payload) => {
					const method = methodOf(endpoint);
					let connection = null;
					try { connection = ctx.get?.("connection") ?? null; } catch { connection = null; }
					if (typeof connection?.rpc?.call !== "function") {
						warn("connection-missing", method, null);
						return { ok: false, error: { code: "channel-unavailable", message: unavailableMessage } };
					}
					let result = null;
					try {
						result = await connection.rpc.call("/api", endpoint, payload);
					} catch (callError) {
						if (warnOnFailure) warn("call-threw", method, callError && (callError.stack || callError.message || String(callError)));
						return { ok: false, error: { code: "call-threw", message: callError instanceof Error ? callError.message : String(callError) } };
					}
					if (result?.ok === true && (!requireValue || result.value != null)) return { ok: true, value: result.value };
					const failure = result?.error ?? result ?? null;
					if (warnOnFailure && !silentFailure?.test(String(failure?.message ?? failure ?? ""))) warn("call-failed", method, failure);
					return {
						ok: false,
						error: {
							code: typeof failure?.code === "string" ? failure.code : "call-failed",
							message: typeof failure?.message === "string" ? failure.message : String(failure ?? "unknown"),
						},
					};
				};
			};
			// Plain HTTP carrier (fetch): the weir-* admin endpoints are ordinary
			// JSON POSTs that need no gateway connection and must work inside chunks
			// (a chunk cannot reach ctx.get("connection")). payload === undefined
			// sends NO body (the status endpoints' wire convention); an object
			// payload crosses as a JSON body. The failure fold keeps every extra
			// error field the server sent (e.g. detail) so consumers lose nothing,
			// and defaults the message to the HTTP status exactly like the
			// hand-written sites did. No warn-once here: every HTTP consumer already
			// surfaces failures inline in its own UI (the settings env read keeps
			// its chunk-side warn-once).
			const createHttpChannel = () => {
				return async (endpoint, payload, options) => {
					let response;
					try {
						response = await fetch(endpoint, {
							method: "POST",
							credentials: "include",
							...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
							...(options?.signal ? { signal: options.signal } : {}),
						});
					} catch (cause) {
						return { ok: false, error: { code: "call-threw", message: cause instanceof Error ? cause.message : String(cause) } };
					}
					let parsed = null;
					try {
						parsed = await response.json();
					} catch (cause) {
						return { ok: false, error: { code: "call-threw", message: cause instanceof Error ? cause.message : String(cause) } };
					}
					if (parsed?.ok === true) return { ok: true, value: parsed.value };
					const failure = parsed?.error;
					return {
						ok: false,
						error: {
							...(failure !== null && typeof failure === "object" ? failure : {}),
							code: typeof failure?.code === "string" ? failure.code : "call-failed",
							message: typeof failure?.message === "string" ? failure.message : `HTTP ${response.status}`,
						},
					};
				};
			};
			const httpChannel = createHttpChannel();
			const capabilityChannel = createGatewayChannel({
				label: "capability read",
				// Never surfaces: capabilityRead maps every failure to its fallback.
				unavailableMessage: "the capability channel has no gateway connection",
				warnOnFailure: true,
				// unknown-session at cold open is the DOCUMENTED convergence shape
				// (先空后收敛): the Badge may read before the session's agent is
				// registered; the agent-preset/selected frame refetches and
				// converges. Never warn for it — warns are for failures that would
				// otherwise stay invisible.
				silentFailure: /unknown session/,
				requireValue: true,
				methodOf: (endpoint) => endpoint.split("/")[1] ?? endpoint,
			});
			const blackboardChannel = createGatewayChannel({
				label: "blackboard call",
				unavailableMessage: "the blackboard channel has no gateway connection",
			});
			// Host environment-facts endpoint (src/settings/env-admin.js): read
			// once per settings-page arrival over the HTTP channel. A carrier
			// failure rethrows with the carrier's message; an envelope-level or
			// shape failure throws the malformed marker — the chunk-side
			// warn-once reports either exactly as before.
			const fetchEnvFacts = () => httpChannel("api/weir-settings/env", {}).then((result) => {
				if (result.ok === true && typeof result.value?.platform === "string") return { platform: result.value.platform };
				throw new Error(result.error?.code === "call-threw" ? result.error.message : "malformed environment facts response");
			});
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
					// The delivery env is the page's global scope plus the HTTP channel
					// adapter (env injection face; the chunk never touches fetch itself).
					if (live) delivery = chunk.startWebDelivery(Object.assign(Object.create(globalThis), { channel: httpChannel }));
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
			// File-lease ownership entry (edit-lock rebuild D13): the read-only
			// badge of the file-lease feature. It carries NO action verb and no
			// command bridge — every ownership state resolves by itself (turn end,
			// expiry, negotiation) — and its single read is the read-only view
			// endpoint, so nothing in this surface can write to the conversation.
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "weir-file-lease",
				order: 101,
				locale: NS,
				inject: (sessionId) => {
					if (!sessionId) return {};
					return {
						sessionId,
						// Structured view: read-only, never written to the conversation.
						fetchView: async () => {
							const result = await httpChannel("api/weir-edit-lock/view", { sessionId });
							if (!result.ok) throw new Error(result.error.message);
							return result.value;
						}
					};
				}
			}, FileLeaseBadgeWrapper)), "ui-weir-settings: file lease badge");
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
				const result = await httpChannel("api/weir-worktree/view", { sessionId, locale: activeLocale() });
				if (!result.ok) throw new Error(result.error.message);
				return result.value;
			};
			const worktreeDiff = async (sessionId, lane) => {
				const result = await httpChannel("api/weir-worktree/diff", { sessionId, lane });
				if (!result.ok) throw new Error(result.error.message);
				return result.value?.diff ?? "";
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
			// The warn-once degradation (kind strings, unknown-session silence) now
			// lives in the capability channel adapter (composition root, above);
			// this read keeps only its endpoint and its fallback semantics.
			const capabilityRead = async (method, sid, fallback) => {
				const result = await capabilityChannel(`weirCapabilities/${method}`, { args: { sessionId: sid } });
				return result.ok === true ? result.value : fallback;
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
						registerChunkDictionaries("settings.weir.capability", model.dictionaries);
						if (alive) setImpl(() => ({ Badge: badge.CapabilityBadge, model, Panel: panel.CapabilityManagerPanel }));
					});
					return () => { alive = false; };
				}, [props.sessionId]);
				if (!impl) return null;
				return react_jsx_runtime.jsx(impl.Badge, { ...props, t: capabilityT, model: impl.model, ManagerPanel: impl.Panel });
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
			]).then((chunks) => {
				registerChunkDictionaries("settings.weir.capability", chunks[0].dictionaries);
				return chunks;
			}));
			function CapabilityPanelWrapper(props) {
				const arrival = useChunkArrival(loadCapabilityPanelChunks, typeof props.sessionId === "string" && props.sessionId !== "");
				if (!arrival?.chunks) return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: typeof props.t === "function" ? props.t("capability.loading") : "" });
				const [model, panel] = arrival.chunks;
				// The same view tree the composer popover renders — the sidebar is
				// just the outer frame (D1). No onClose: the pane chrome owns closing.
				return react_jsx_runtime.jsx(panel.CapabilityManagerPanel, { ...props, t: capabilityT, model, shell: "sidebar" });
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
			// pinned wire shape ({ agentId, args }) stays owned by the model
			// chunk's channel factory; the carrier, the envelope folding and the
			// warn-once degradation live in the blackboard channel adapter
			// (composition root, above).
			const loadBlackboardPanelChunks = lazyChunks(() => Promise.all([
				require.async("./client.blackboard-model.js"),
				require.async("./client.blackboard-panel.js")
			]).then((chunks) => {
				registerChunkDictionaries("settings.weir.blackboard", chunks[0].dictionaries);
				return chunks;
			}));
			function BlackboardPanelWrapper(props) {
				const arrival = useChunkArrival(loadBlackboardPanelChunks, typeof props.sessionId === "string" && props.sessionId !== "");
				if (!arrival?.chunks) return react_jsx_runtime.jsx("div", { style: settingsLoadingStyle, children: typeof props.t === "function" ? props.t("blackboard.loading") : "" });
				const [model, panel] = arrival.chunks;
				return react_jsx_runtime.jsx(panel.BlackboardPanel, { ...props, t: blackboardT, model });
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
					inject: (sessionId) => (sessionId ? { sessionId, callBoard: blackboardChannel } : {})
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
							require.async("./client.notify-permissions.js")
						]).then(([settingsPage, chainEditor, robashEditor, disabledCategoriesEditor, lspPanel, chainModel, robashModel, lspModel, notifyPermissions]) => {
							// The whole settings card tree shares one t (the page
							// namespace): every batch chunk's data face merges into ONE
							// registration — a duplicate (namespace, locale) pair would
							// throw, so per-feature namespaces are not an option here.
							const pageDictionaries = { en: {}, zh: {} };
							for (const chunk of [settingsPage, chainModel, robashModel, lspModel, disabledCategoriesEditor, notifyPermissions]) {
								Object.assign(pageDictionaries.en, chunk.dictionaries?.en);
								Object.assign(pageDictionaries.zh, chunk.dictionaries?.zh);
							}
							registerChunkDictionaries("settings.weir.page", pageDictionaries);
							if (serving) {
								controller = new settingsPage.WeirCardController(scope, { settingsBus, getSession: () => ctx.remote.session, fetchEnv: fetchEnvFacts }, "main");
								deferredStore.attach(controller.store);
								routingController = new settingsPage.WeirCardController(scope, { settingsBus, getSession: () => ctx.remote.session, fetchEnv: fetchEnvFacts }, "routing");
								routingDeferredStore.attach(routingController.store);
							}
							// Editor components pre-bound with their model chunks,
							// created once per arrival so their identity is stable
							// across re-renders (no remount of an open editor).
							const editors = {
								ChainEditorField: (editorProps) => react_jsx_runtime.jsx(chainEditor.ChainEditorField, { ...editorProps, model: chainModel }),
								RobashListEditorField: (editorProps) => react_jsx_runtime.jsx(robashEditor.RobashListEditorField, { ...editorProps, model: robashModel }),
								DisabledCategoriesEditorField: (editorProps) => react_jsx_runtime.jsx(disabledCategoriesEditor.DisabledCategoriesEditorField, editorProps),
								LspManagerField: (editorProps) => react_jsx_runtime.jsx(lspPanel.LspManagerField, { ...editorProps, model: lspModel, channel: httpChannel }),
								// The HTTP channel adapter reaches every fetch-talking editor
								// through the same prop (composition-root injection: a chunk
								// never builds its own carrier).
								NotifyPermissionsField: (editorProps) => react_jsx_runtime.jsx(notifyPermissions.NotifyPermissionsField, { ...editorProps, channel: httpChannel })
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
						return react_jsx_runtime.jsx(cardArrival.chunks.settingsPage.WeirCard, { ...props, t: pageT, page: "routing", editors: cardArrival.chunks.editors, modelPicker: pickerArrival?.chunks });
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
						return react_jsx_runtime.jsx(cardArrival.chunks.settingsPage.WeirCard, { ...props, t: pageT, editors: cardArrival.chunks.editors, modelPicker: pickerArrival?.chunks });
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
