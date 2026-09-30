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

export { narrowHashEditArgs, parseHashEditArgsRaw, plannedDiffFragments, narrowDiffFragment }
