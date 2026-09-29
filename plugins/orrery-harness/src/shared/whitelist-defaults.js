// Defaults source for the read-only guard whitelists.
//
// WHY THIS EXISTS — the shipped defaults must not be composable configuration.
// DSH composes patch layers by WHOLE-VALUE replacement (`applyEntryPatches` does
// `target[key] = value`; the host README states "does not deep-merge"), so any
// default that rides a row's `config:` can be discarded outright the moment a
// user or profile layer declares that row. When the whitelist tables lived in
// the settings row, a profile that had ever edited a list froze a snapshot of
// it, and every later default addition became unreachable for that profile —
// silently. `Start-Sleep` missing from a live session while the repo carried it
// is exactly that failure.
//
// So the defaults live in a data file the PLUGIN reads itself, at runtime, from
// its own location. No configuration layer can replace it. The built-in
// constants in the guard modules remain, demoted to a per-table fallback.
//
// The read is fail-CLOSED in the sense that matters: a defective data file can
// never relax the guard. A table that is absent, malformed, or not an array of
// strings falls back to that table's built-in constant and is reported through
// the logger; the other tables are still taken from the file.
//
// This module is deliberately free of `ctx`: it is pure file I/O plus parsing,
// so tests can drive it without a runtime.

import { readFileSync } from 'node:fs'
import { DEFAULT_ROBASH_PWSH } from '../delegate/robash-guard-pwsh.js'
import { DEFAULT_ROBASH } from '../delegate/robash-guard.js'

/** The five table names, in the order they are published. */
export const WHITELIST_KEYS = Object.freeze([
  'robashAllow',
  'robashGitAllow',
  'robashDeny',
  'robashPwshAllow',
  'robashPwshDeny',
])

/**
 * Built-in fallback per table (the guard modules' own constants). These are
 * consulted one table at a time, never as a set: a single bad table must not
 * drag the well-formed ones down with it.
 */
export const FALLBACK_TABLES = Object.freeze({
  robashAllow: [...DEFAULT_ROBASH.allow],
  robashGitAllow: [...DEFAULT_ROBASH.gitAllow],
  robashDeny: [...DEFAULT_ROBASH.deny],
  robashPwshAllow: [...DEFAULT_ROBASH_PWSH.allow],
  robashPwshDeny: [...DEFAULT_ROBASH_PWSH.deny],
})

/**
 * The shipped defaults file, resolved against THIS module's location so it
 * travels with the bundle rather than with whatever working directory the host
 * happens to have. `src/shared/` → bundle root.
 */
export const DEFAULT_WHITELIST_PATH = new URL('../../whitelist-defaults.json', import.meta.url)

/** True only for an array whose every element is a string. */
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Read the whitelist defaults.
 *
 * Every failure is per-table and non-fatal: the caller always receives five
 * well-formed string arrays, so the guard can never be relaxed by a missing or
 * corrupt data file, and plugin activation never fails because of one.
 *
 * @param options - `{ readFile?, logger? }` reader seam and fallback reporter
 * @returns `{ tables, path, source }` where `source[table]` is `'file'` or
 *   `'fallback'` per table, and `path` is the file that was attempted
 */
export function readWhitelistDefaults({ readFile = defaultReadFile, logger } = {}) {
  return readWhitelistDefaultsAt(DEFAULT_WHITELIST_PATH, { readFile, logger })
}

/**
 * Read the whitelist defaults from a specific path, so an administrator can
 * point the defaults at their own copy (a takeover: whatever that file leaves
 * out is not in effect for them).
 *
 * @param filePath - file path or `URL` to read
 * @param options - `{ readFile?, logger? }`
 */
export function readWhitelistDefaultsAt(filePath, { readFile = defaultReadFile, logger } = {}) {
  let parsed
  try {
    parsed = JSON.parse(readFile(filePath))
  } catch (error) {
    reportFallback(logger, filePath, `could not be read or parsed (${error?.message ?? error})`)
    return { tables: allFallback(), path: filePath, source: allSource('fallback') }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reportFallback(logger, filePath, 'does not hold a JSON object of whitelist tables')
    return { tables: allFallback(), path: filePath, source: allSource('fallback') }
  }

  const tables = {}
  const source = {}
  const defective = []
  for (const key of WHITELIST_KEYS) {
    const value = parsed[key]
    if (isStringArray(value)) {
      tables[key] = [...value]
      source[key] = 'file'
    } else {
      tables[key] = [...FALLBACK_TABLES[key]]
      source[key] = 'fallback'
      defective.push(key)
    }
  }
  if (defective.length > 0) {
    reportFallback(logger, filePath, `has a missing or malformed table for ${defective.join(', ')}`)
  }
  return { tables, path: filePath, source }
}

/** Default reader: a synchronous read, since the settings service computes synchronously. */
function defaultReadFile(filePath) {
  return readFileSync(filePath, 'utf8')
}

function allFallback() {
  return Object.fromEntries(WHITELIST_KEYS.map((key) => [key, [...FALLBACK_TABLES[key]]]))
}

function allSource(value) {
  return Object.fromEntries(WHITELIST_KEYS.map((key) => [key, value]))
}

function reportFallback(logger, filePath, detail) {
  logger?.warn?.(
    `orrery: the read-only guard whitelist defaults file ${String(filePath)} ${detail}; ` +
      'the affected tables fall back to the built-in lists. Fix the file, or run the reload entry, to pick it up.',
  )
}

/**
 * A cache around the reader. The settings service owns one instance, so the
 * file is read once per process; an explicit reload re-reads it. Nothing here
 * runs on the guard's per-command path.
 */
export function createWhitelistDefaultsCache({ readFile = defaultReadFile, logger } = {}) {
  let cached = null
  let cachedPath = null

  return {
    /**
     * The tables for `filePath` (the shipped defaults when omitted), re-reading
     * only when the path changed or the cache was cleared.
     */
    tables(filePath = DEFAULT_WHITELIST_PATH) {
      const key = String(filePath)
      if (cached && cachedPath === key) return cached
      cached = readWhitelistDefaultsAt(filePath, { readFile, logger })
      cachedPath = key
      return cached
    },
    /** Drop the cache so the next read hits the file again (the reload entry). */
    reload() {
      cached = null
      cachedPath = null
    },
  }
}
