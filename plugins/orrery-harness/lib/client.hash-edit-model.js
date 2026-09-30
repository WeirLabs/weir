window.__ModuleLoader__.load({
	id: "orrery-harness",
	chunk: "client.hash-edit-model.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Zero-dependency view-model chunk: the factory never calls require.
		// hash_edit calls render as a diff panel: applied hunks come from the
		// persisted result metadata (`meta.diffs`), the running preview from the
		// call arguments. Absent or malformed data degrades to the generic
		// flattened input/output body rather than throwing.
		const HASH_EDIT_TOOL = "hash_edit";
		/** Narrow one opaque persisted diff fragment; null when unusable. */
		function narrowDiffFragment(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
			const { path, oldText, newText } = value;
			if (typeof path !== "string") return null;
			if (oldText !== null && typeof oldText !== "string") return null;
			if (typeof newText !== "string") return null;
			return { path, oldText, newText };
		}
		/** Narrow persisted result metadata to a non-empty fragment list, else null. */
		function appliedDiffFragments(meta) {
			if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
			const diffs = meta.diffs;
			if (!Array.isArray(diffs) || diffs.length === 0) return null;
			const out = [];
			for (const entry of diffs) {
				const fragment = narrowDiffFragment(entry);
				if (fragment === null) return null;
				out.push(fragment);
			}
			return out;
		}
		/** Parse the raw JSON arguments of a hash_edit call; null when unusable. */
		function parseHashEditArgs(argsRaw) {
			if (typeof argsRaw !== "string" || argsRaw.trim() === "") return null;
			let parsed;
			try {
				parsed = JSON.parse(argsRaw);
			} catch {
				return null;
			}
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
			const path = parsed.file_path;
			if (typeof path !== "string" || path.trim() === "") return null;
			if (!Array.isArray(parsed.edits)) return null;
			const ops = [];
			for (const edit of parsed.edits) {
				if (typeof edit !== "object" || edit === null) return null;
				if (typeof edit.op !== "string" || typeof edit.pos !== "string" || typeof edit.text !== "string") return null;
				ops.push({ op: edit.op, pos: edit.pos, text: edit.text });
			}
			return { path, ops };
		}
		/** Planned fragments from parsed args: one addition fragment per content-bearing op. */
		function plannedDiffFragments(parsed) {
			if (parsed === null) return null;
			const fragments = parsed.ops.filter((op) => op.text !== "").map((op) => ({ path: parsed.path, oldText: null, newText: op.text }));
			return fragments.length > 0 ? fragments : null;
		}
		/** The raw argument string of a start or result block, when present. */
		function hashEditArgsRaw(block) {
			if (typeof block?.argsRaw === "string") return block.argsRaw;
			if (typeof block?.call?.argsRaw === "string") return block.call.argsRaw;
			return null;
		}
		/** Joined text of a result block's content parts. */
		function hashEditResultText(block) {
			if (!Array.isArray(block?.content)) return "";
			return block.content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : "").filter((text) => text !== "").join("\n");
		}
		/** Lifecycle state of the call, driving tone and status text. */
		function hashEditState(phase, block) {
			if (phase === "preparing") return "preparing";
			if (phase === "start") return "running";
			if (block?.isError) return block?.error?.code === "interrupted" ? "stopped" : "error";
			return "ok";
		}
		/** Relativize a path to the session cwd first, then the host home. */
		function hashEditDisplayPath(path, cwd, home) {
			if (typeof path !== "string") return "";
			if (typeof cwd === "string" && cwd !== "") {
				const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
				if (path.startsWith(prefix)) return path.slice(prefix.length);
			}
			if (typeof home === "string" && home !== "") {
				const prefix = home.endsWith("/") ? home : `${home}/`;
				if (path.startsWith(prefix)) return `~/${path.slice(prefix.length)}`;
			}
			return path;
		}
		/** Localized chrome labels for the DiffBlock primitive. */
		function hashEditDiffLabels(t) {
			return {
				codeLabel: t("hashEditCodeLabel"),
				wrapLabel: t("hashEditWrap"),
				unwrapLabel: t("hashEditUnwrap"),
				copy: t("hashEditCopy"),
				copied: t("hashEditCopied"),
				collapseAria: t("hashEditCollapseAria"),
				expandAria: (count) => t("hashEditExpandAria", { count }),
				collapse: t("hashEditCollapse"),
				expand: (count) => t("hashEditExpand", { count })
			};
		}
		exports.HASH_EDIT_TOOL = HASH_EDIT_TOOL;
		exports.narrowDiffFragment = narrowDiffFragment;
		exports.appliedDiffFragments = appliedDiffFragments;
		exports.parseHashEditArgs = parseHashEditArgs;
		exports.plannedDiffFragments = plannedDiffFragments;
		exports.hashEditArgsRaw = hashEditArgsRaw;
		exports.hashEditResultText = hashEditResultText;
		exports.hashEditState = hashEditState;
		exports.hashEditDisplayPath = hashEditDisplayPath;
		exports.hashEditDiffLabels = hashEditDiffLabels;
		return module.exports;
	}
});
