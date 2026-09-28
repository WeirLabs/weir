// Pure core of lsp_rename: WorkspaceEdit → per-file synthesized content.
// Server coordinates are UTF-16 code units over the LF-normalized document
// text (what syncDocument sends); JS string indices are UTF-16 code units
// too, so positions map 1:1 and astral characters (surrogate pairs) just
// work. writeText writes content verbatim (no line-ending restore), so the
// original style is detected by byte sampling and restored on write-back —
// all mirrored from dsh-fs-local semantics, self-implemented (link rule).
import { uriToPath } from './manager.js'

/**
 * LF-normalize: collapse every `\r\n` to `\n` (lone `\r` untouched) —
 * dsh-fs-local's normalizeLineEndings. Idempotent; the synthesis basis.
 * @param {string} content
 * @returns {string}
 */
export function normalizeLineEndings(content) {
  return content.replaceAll('\r\n', '\n')
}

/**
 * Absolute UTF-16 index of a 0-based LSP position in LF-normalized content.
 * @param {string} content - LF-normalized full text
 * @param {number} line - 0-based line
 * @param {number} character - 0-based UTF-16 column
 * @returns {number} absolute string index
 */
export function positionToIndex(content, line, character) {
  return positionToIndexInLines(content.split('\n'), line, character)
}

/** @param {string[]} lines @param {number} line @param {number} character */
function positionToIndexInLines(lines, line, character) {
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
    throw new Error(`lsp_rename: malformed edit position (line ${line}, character ${character})`)
  }
  if (line >= lines.length) {
    throw new Error(`lsp_rename: edit range out of bounds (line ${line}, file has ${lines.length} line(s))`)
  }
  if (character > lines[line].length) {
    throw new Error(`lsp_rename: edit range out of bounds (line ${line}, character ${character}, line length ${lines[line].length})`)
  }
  let index = 0
  for (let i = 0; i < line; i++) index += lines[i].length + 1
  return index + character
}

/**
 * Apply LSP TextEdits (`{range, newText}`) to LF-normalized content.
 * Edits are sorted into document order, validated pairwise non-overlapping
 * (adjacent allowed), then applied back-to-front so indices never drift.
 * @param {string} content - LF-normalized full text
 * @param {Array<object>} edits
 * @returns {string} the synthesized new full text (still LF-normalized)
 */
export function applyTextEdits(content, edits) {
  if (!Array.isArray(edits)) throw new Error('lsp_rename: edits must be an array of TextEdit')
  const lines = content.split('\n')
  const spans = edits.map((edit, index) => {
    const range = edit?.range
    if (typeof edit?.newText !== 'string' || !range) {
      throw new Error('lsp_rename: malformed TextEdit (expected {range, newText})')
    }
    const start = positionToIndexInLines(lines, range.start?.line, range.start?.character)
    const end = positionToIndexInLines(lines, range.end?.line, range.end?.character)
    if (end < start) throw new Error('lsp_rename: edit range end before start')
    return { start, end, newText: edit.newText, order: index }
  })
  spans.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) throw new Error('lsp_rename: overlapping edits in one file')
  }
  let result = content
  for (let i = spans.length - 1; i >= 0; i--) {
    result = result.slice(0, spans[i].start) + spans[i].newText + result.slice(spans[i].end)
  }
  return result
}

/** @param {string} text @param {string} needle */
function countOccurrences(text, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const found = text.indexOf(needle, index)
    if (found === -1) return count
    count++
    index = found + needle.length
  }
}

/**
 * Majority-vote line-ending detection over a byte sample (dsh-fs-local
 * semantics): CRLF when crlfCount > lfCount - crlfCount, else LF. A sample
 * without any newline is LF.
 * @param {Buffer|Uint8Array|string} sample - first bytes of the file
 * @returns {'LF'|'CRLF'}
 */
export function detectLineEndings(sample) {
  const text = typeof sample === 'string' ? sample : Buffer.from(sample).toString('utf8')
  const crlfCount = countOccurrences(text, '\r\n')
  const lfCount = countOccurrences(text, '\n')
  return crlfCount > lfCount - crlfCount ? 'CRLF' : 'LF'
}

/**
 * Convert LF-normalized content back to the file's original style for
 * write-back. CRLF re-normalizes first, so an existing `\r\n` is never
 * doubled to `\r\r\n` (dsh-fs-local semantics).
 * @param {string} content - LF-normalized (synthesized) text
 * @param {'LF'|'CRLF'} style
 * @returns {string}
 */
export function restoreLineEndings(content, style) {
  return style === 'CRLF' ? normalizeLineEndings(content).split('\n').join('\r\n') : content
}

/**
 * Reduce a WorkspaceEdit to the v1 application surface: `[{path, edits}]`
 * from the `changes` form only. `documentChanges` is rejected explicitly
 * (no file moves/creations/deletions in this version); absent/empty
 * `changes` yields null (no-op).
 * @param {object|null|undefined} workspaceEdit
 * @returns {Array<{path: string, edits: Array<object>}>|null}
 */
export function extractChanges(workspaceEdit) {
  if (workspaceEdit === null || workspaceEdit === undefined) return null
  if (typeof workspaceEdit !== 'object') throw new Error('lsp_rename: malformed WorkspaceEdit')
  if (workspaceEdit.documentChanges !== undefined && workspaceEdit.documentChanges !== null) {
    throw new Error('lsp_rename: the server returned documentChanges, which this version does not apply')
  }
  const changes = workspaceEdit.changes
  if (changes === null || changes === undefined || typeof changes !== 'object') return null
  const entries = Object.entries(changes)
  if (entries.length === 0) return null
  return entries.map(([uri, edits]) => ({ path: uriToPath(uri), edits }))
}
