// Hashline anchor codec: `LINE#ID` anchors derived from xxHash32 of line
// content. Whitespace-only lines are seeded by line number so identical
// blank lines at different positions still anchor distinctly.
import { xxh32 } from './xxhash32.js'

export const ANCHOR_ALPHABET = 'ZPMQVRWSNKTXJBYH'
export const ANCHOR_PATTERN = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/

/**
 * @param {number} lineNumber - 1-based
 * @param {string} lineText
 * @returns {string} the anchor id (two alphabet characters)
 */
export function anchorIdFor(lineNumber, lineText) {
  const whitespaceOnly = lineText.trim().length === 0
  const hash = xxh32(whitespaceOnly ? String(lineNumber) : lineText, whitespaceOnly ? lineNumber : 0)
  return ANCHOR_ALPHABET[(hash >>> 28) & 0xf] + ANCHOR_ALPHABET[(hash >>> 24) & 0xf]
}

/**
 * @param {number} lineNumber - 1-based
 * @param {string} lineText
 * @returns {string} `N#XX`
 */
export function anchorFor(lineNumber, lineText) {
  return `${lineNumber}#${anchorIdFor(lineNumber, lineText)}`
}

/**
 * Parse an anchor string.
 * @param {string | undefined} anchor
 * @returns {{ line: number, id: string } | null}
 */
export function parseAnchor(anchor) {
  if (typeof anchor !== 'string') return null
  const match = ANCHOR_PATTERN.exec(anchor)
  if (!match) return null
  return { line: Number(match[1]), id: match[2] }
}

/**
 * Validate an anchor against current file lines.
 * @param {{ line: number, id: string }} anchor
 * @param {string[]} lines - current file lines (0-based array)
 * @returns {{ ok: true } | { ok: false, reason: string, found?: string }}
 */
export function validateAnchor(anchor, lines) {
  if (anchor.line < 1 || anchor.line > lines.length) {
    return { ok: false, reason: `line ${anchor.line} is out of range (file has ${lines.length} lines)` }
  }
  const actual = anchorFor(anchor.line, lines[anchor.line - 1])
  if (actual !== `${anchor.line}#${anchor.id}`) {
    return {
      ok: false,
      reason: `anchor ${anchor.line}#${anchor.id} is stale; current line ${anchor.line} anchors as ${actual}`,
      found: actual,
    }
  }
  return { ok: true }
}
