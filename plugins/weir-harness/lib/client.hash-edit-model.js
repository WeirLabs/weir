window.__ModuleLoader__.load({
	id: "weir-harness",
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
		// DERIVED FROM src/hashline-edit/planned-fragments.js — keep byte-identical; pinned by test/hashline-planned-fragments.test.js
		// BEGIN derived region (flush-left on purpose: every byte matches the src module above its export line).
// hash_edit planned-preview contract — the single authoritative producer-side
// implementation of args→ops narrowing and ops→planned-fragments projection
// (计划预览契约), located beside the op engine (apply-ops.js) and the diff
// engine (diff.js). The zero-dependency browser chunk
// lib/client.hash-edit-model.js carries a byte-verbatim derived copy of this
// module's function region (everything above the export statement), pinned
// behaviorally by test/hashline-planned-fragments.test.js: change here =
// change there, and any one-sided drift turns that test red.
//
// Planned fragment semantics (op-shaped preview — codified, no user-visible
// change):
// 1. Planned fragments are OP-shaped: one fragment per content-bearing op.
//    Applied fragments (diff.js) are HUNK-shaped with context lines on both
//    sides — the granularity difference is part of the contract, not a defect.
// 2. `oldText` is null BY CONSTRUCTION: the call arguments carry no old-side
//    content. On applied fragments the same field is null only when a hunk
//    has no old-side lines at all; narrowDiffFragment guards both channels
//    uniformly — that uniformity is the fulcrum of the cross-channel
//    reconciliation.
// 3. A pure deletion (text: '') produces NO preview fragment: a preview
//    cannot show content that will be deleted, and an empty fragment would
//    render +0 −0.
// 4. plannedDiffFragments(null) → null; all-empty ops → null — the caller
//    falls back to the flattened body, the same null discipline as
//    appliedDiffFragments.
//
// Narrowing mirrors the tool schema (src/hashline-edit/index.js parameters):
// file_path a non-blank string, edits an array, each edit's op/pos/text
// strings. The optional `end` anchor string is preserved (the one
// augmentation over the legacy browser parser — narrowed ops now match the
// HashEditOp typedef of apply-ops.js, so no future consumer narrows again).
// Unknown fields are dropped; a non-string `end` is dropped with them (the
// provider-side schema would have rejected such a call before it ever
// reached a preview).

/**
 * @typedef {object} NarrowedHashEditOp
 * @property {string} op
 * @property {string} pos
 * @property {string} text
 * @property {string} [end]
 */

/**
 * @typedef {object} NarrowedHashEditArgs
 * @property {string} path
 * @property {NarrowedHashEditOp[]} ops
 */

/**
 * Object-level narrowing of decoded hash_edit arguments:
 * {file_path, edits[]} → {path, ops[]} or null.
 * @param {unknown} value
 * @returns {NarrowedHashEditArgs | null}
 */
function narrowHashEditArgs(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = /** @type {Record<string, unknown>} */ (value)
  const path = record.file_path
  if (typeof path !== 'string' || path.trim() === '') return null
  if (!Array.isArray(record.edits)) return null
  const ops = /** @type {NarrowedHashEditOp[]} */ ([])
  for (const edit of record.edits) {
    if (typeof edit !== 'object' || edit === null) return null
    if (typeof edit.op !== 'string' || typeof edit.pos !== 'string' || typeof edit.text !== 'string') return null
    const op = /** @type {NarrowedHashEditOp} */ ({ op: edit.op, pos: edit.pos, text: edit.text })
    if (typeof edit.end === 'string') op.end = edit.end
    ops.push(op)
  }
  return { path, ops }
}

/**
 * Parse the raw JSON arguments of a hash_edit call; null when unusable.
 * @param {unknown} argsRaw
 * @returns {NarrowedHashEditArgs | null}
 */
function parseHashEditArgsRaw(argsRaw) {
  if (typeof argsRaw !== 'string' || argsRaw.trim() === '') return null
  let parsed
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    return null
  }
  return narrowHashEditArgs(parsed)
}

/**
 * Planned fragments from parsed args: one op-shaped preview fragment per
 * content-bearing op (`oldText` null by construction; pure deletions emit
 * nothing). Null input or all-empty ops → null.
 * @param {NarrowedHashEditArgs | null} parsed
 * @returns {Array<{ path: string, oldText: null, newText: string }> | null}
 */
function plannedDiffFragments(parsed) {
  if (parsed === null) return null
  const fragments = parsed.ops.filter((op) => op.text !== '').map((op) => ({ path: parsed.path, oldText: null, newText: op.text }))
  return fragments.length > 0 ? fragments : null
}

/**
 * Narrow one opaque diff fragment to the shared shape
 * {path: string, oldText: string | null, newText: string}; null when
 * unusable. Guards planned (oldText null by construction) and applied
 * channels alike.
 * @param {unknown} value
 * @returns {{ path: string, oldText: string | null, newText: string } | null}
 */
function narrowDiffFragment(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { path, oldText, newText } = /** @type {Record<string, unknown>} */ (value)
  if (typeof path !== 'string') return null
  if (oldText !== null && typeof oldText !== 'string') return null
  if (typeof newText !== 'string') return null
  return { path, oldText, newText }
}
		// END derived region. Chunk-local wiring below keeps the pre-existing public export name.
		const parseHashEditArgs = parseHashEditArgsRaw;
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
