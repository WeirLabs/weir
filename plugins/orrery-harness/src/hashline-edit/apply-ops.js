// hash_edit op validation and application — pure core, fail-closed.
// Ops reference the ORIGINAL file state through `LINE#ID` anchors; every
// anchor is validated against current content before anything is computed.
// Any mismatch rejects the whole call with a mismatch report and zero writes.
import { anchorFor, parseAnchor, validateAnchor } from './anchors.js'

/**
 * @typedef {object} HashEditOp
 * @property {'replace' | 'append' | 'prepend'} op
 * @property {string} [pos] - anchor `N#XX` (replace: first line; append: after; prepend: before)
 * @property {string} [end] - inclusive end anchor for replace ranges
 * @property {string} text - content as ONE string, lines joined by '\n'
 *    ('' = empty content: pure deletion for replace, no-op for append/prepend)
 */

/**
 * Split an edit's `text` into lines: split at '\n', drop at most one trailing
 * empty element, preserve interior empty lines. `''` yields `[]`, so a
 * split-join round-trip can never add or drop a blank line.
 * @param {string} text
 * @returns {string[]}
 */
export function splitText(text) {
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}
/**
 * Validate every anchor in the op list against current lines.
 * @param {HashEditOp[]} ops
 * @param {string[]} lines
 * @returns {{ ok: true } | { ok: false, mismatches: string[] }}
 */
export function validateOps(ops, lines) {
  const mismatches = []
  for (const [index, op] of ops.entries()) {
    const where = `edit ${index + 1} (${op.op})`
    if (!['replace', 'append', 'prepend'].includes(op.op)) {
      mismatches.push(`${where}: unknown op ${JSON.stringify(op.op)}`)
      continue
    }
    if (typeof op.text !== 'string') {
      mismatches.push(`${where}: text must be a string (one string, \\n between lines) — call again with the corrected shape`)
      continue
    }
    const pos = parseAnchor(op.pos)
    if (!pos) {
      mismatches.push(`${where}: pos anchor ${JSON.stringify(op.pos)} is malformed (expected N#XX)`)
      continue
    }
    const posCheck = validateAnchor(pos, lines)
    if (!posCheck.ok) mismatches.push(`${where}: ${posCheck.reason}`)
    if (op.op === 'replace' && op.end !== undefined) {
      const end = parseAnchor(op.end)
      if (!end) {
        mismatches.push(`${where}: end anchor ${JSON.stringify(op.end)} is malformed (expected N#XX)`)
      } else {
        const endCheck = validateAnchor(end, lines)
        if (!endCheck.ok) mismatches.push(`${where}: ${endCheck.reason}`)
        else if (end.line < pos.line) mismatches.push(`${where}: end anchor ${op.end} precedes pos anchor ${op.pos}`)
      }
    }
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches }
}

/**
 * Apply validated ops bottom-up against the original line array.
 * Positions always reference the original file, so ops never disturb each
 * other's coordinates.
 * @param {string[]} lines - original file lines
 * @param {HashEditOp[]} ops - already validated ops
 * @returns {string[]} the new file lines
 */
export function applyOps(lines, ops) {
  const result = [...lines]
  // Indexed positions computed against the ORIGINAL array, applied bottom-up.
  const planned = []
  for (const op of ops) {
    // validateOps has already run: anchors parse and are in range. The guard
    // below is unreachable in practice and keeps the fail-closed invariant.
    const pos = parseAnchor(op.pos)
    if (!pos) continue
    if (op.op === 'replace') {
      const endAnchor = op.end === undefined ? null : parseAnchor(op.end)
      const endLine = endAnchor === null ? pos.line : endAnchor.line
      planned.push({ at: pos.line, deleteCount: endLine - pos.line + 1, insert: splitText(op.text) })
    } else if (op.op === 'append') {
      planned.push({ at: pos.line + 1, deleteCount: 0, insert: splitText(op.text) })
    } else {
      // prepend
      planned.push({ at: pos.line, deleteCount: 0, insert: splitText(op.text) })
    }
  }
  planned.sort((a, b) => b.at - a.at)
  for (const plan of planned) {
    // `at` is a 1-based line coordinate of the original file; splice is 0-based.
    const index = plan.deleteCount > 0 ? plan.at - 1 : plan.at - 1
    result.splice(Math.max(0, index), plan.deleteCount, ...plan.insert)
  }
  return result
}

/** Render the fail-closed mismatch report (English template). */
export function renderMismatch(mismatches) {
  return [
    '>>> mismatch — hash_edit refused the call; the file was NOT modified.',
    '',
    ...mismatches.map((mismatch) => `>>> ${mismatch}`),
    '',
    'Re-read the file and copy the current anchors verbatim before retrying.',
  ].join('\n')
}

export { anchorFor }
