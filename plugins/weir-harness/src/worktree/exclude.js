// Local-only ignore for Weir's runtime scratch: marked rules in the
// repository's COMMON `info/exclude` (shared by every linked worktree, never
// committed or pushed). `/.weir/` covers the lanes, the ledger, the audit
// log, Edit Lock data and notes; a lane root configured elsewhere gets its own
// rule. Idempotent per rule; never touches .gitignore or any tracked file.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EXCLUDE_MARKER, excludeRulesFor } from './rules.js'

/** @param {string} text */
const linesOf = (text) => new Set(text.split(/\r?\n/).map((line) => line.trim()))

/**
 * @param {string} commonDir - absolute `git rev-parse --git-common-dir`
 * @param {string} root - normalized repository-relative lane root
 * @returns {{ file: string, written: boolean }}
 */
export function ensureExclude(commonDir, root) {
  const file = join(commonDir, 'info', 'exclude')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const present = linesOf(text)
  const missing = excludeRulesFor(root).filter((rule) => !present.has(rule))
  if (missing.length === 0) return { file, written: false }
  mkdirSync(dirname(file), { recursive: true })
  const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  const marker = present.has(EXCLUDE_MARKER) ? '' : `${EXCLUDE_MARKER}\n`
  appendFileSync(file, `${separator}${marker}${missing.join('\n')}\n`)
  return { file, written: true }
}

/**
 * @param {string} commonDir
 * @param {string} root
 */
export function hasExclude(commonDir, root) {
  const file = join(commonDir, 'info', 'exclude')
  if (!existsSync(file)) return false
  const present = linesOf(readFileSync(file, 'utf8'))
  return excludeRulesFor(root).every((rule) => present.has(rule))
}
