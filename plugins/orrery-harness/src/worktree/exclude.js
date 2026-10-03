// Local-only ignore for the lane root: one marked rule in the repository's
// COMMON `info/exclude` (shared by every linked worktree, never committed or
// pushed). Idempotent; never touches .gitignore or any tracked file.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EXCLUDE_MARKER, excludeRuleFor } from './rules.js'

/**
 * @param {string} commonDir - absolute `git rev-parse --git-common-dir`
 * @param {string} root - normalized repository-relative lane root
 * @returns {{ file: string, written: boolean }}
 */
export function ensureExclude(commonDir, root) {
  const file = join(commonDir, 'info', 'exclude')
  const rule = excludeRuleFor(root)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (text.split(/\r?\n/).some((line) => line.trim() === rule)) return { file, written: false }
  mkdirSync(dirname(file), { recursive: true })
  const separator = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
  appendFileSync(file, `${separator}${EXCLUDE_MARKER}\n${rule}\n`)
  return { file, written: true }
}

/**
 * @param {string} commonDir
 * @param {string} root
 */
export function hasExclude(commonDir, root) {
  const file = join(commonDir, 'info', 'exclude')
  if (!existsSync(file)) return false
  const rule = excludeRuleFor(root)
  return readFileSync(file, 'utf8').split(/\r?\n/).some((line) => line.trim() === rule)
}
