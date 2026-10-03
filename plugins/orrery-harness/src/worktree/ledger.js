// Lane ledger: the single source of truth for lane state, one JSON file per
// repository under the lane root. Written only here, atomically (temp file +
// rename) under an O_EXCL lock file, so several sessions on one repository
// never lose each other's updates. A ledger that does not parse is never
// rebuilt silently: it is copied aside and every operation fails with
// LEDGER_CORRUPT until the user runs /worktree reconcile --rebuild.
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKTREE_CODES, WorktreeError } from './errors.js'
import { STATES } from './state.js'

export const LEDGER_FILE = 'lanes.json'
export const LOCK_FILE = '.lock'
export const SCHEMA_VERSION = 1
const STALE_LOCK_MS = 30_000
const LOCK_WAIT_MS = 10_000

/** @returns {{ schemaVersion: number, seq: number, lanes: any[] }} */
export function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, seq: 0, lanes: [] }
}

/**
 * Schema check: shape errors are corruption, not something to repair.
 * @param {any} value
 */
export function validateLedger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'ledger is not an object'
  if (value.schemaVersion !== SCHEMA_VERSION) return `unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}`
  if (!Number.isSafeInteger(value.seq) || value.seq < 0) return 'seq must be a non-negative integer'
  if (!Array.isArray(value.lanes)) return 'lanes must be an array'
  const ids = new Set()
  for (const [index, lane] of value.lanes.entries()) {
    if (!lane || typeof lane.id !== 'string' || !lane.id) return `lanes[${index}] has no id`
    if (ids.has(lane.id)) return `duplicate lane id ${lane.id}`
    ids.add(lane.id)
    if (!STATES.includes(lane.state)) return `lane ${lane.id} has unknown state ${JSON.stringify(lane.state)}`
    if (typeof lane.path !== 'string' || typeof lane.branch !== 'string') return `lane ${lane.id} lacks path/branch`
  }
  return null
}

/**
 * @param {string} directory - absolute lane root (`<repo>/<worktreeRoot>`)
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<void>, pid?: number }} [options]
 */
export function createLedger(directory, options = {}) {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const pid = options.pid ?? process.pid
  const file = join(directory, LEDGER_FILE)
  const lockFile = join(directory, LOCK_FILE)

  /** @returns {{ schemaVersion: number, seq: number, lanes: any[] }} */
  function read() {
    if (!existsSync(file)) return emptyLedger()
    const text = readFileSync(file, 'utf8')
    let parsed
    let problem = null
    try {
      parsed = JSON.parse(text)
      problem = validateLedger(parsed)
    } catch (error) {
      problem = `invalid JSON (${/** @type {any} */ (error)?.message ?? error})`
    }
    if (problem) {
      const backup = backupCorrupt()
      throw new WorktreeError(WORKTREE_CODES.LEDGER_CORRUPT, `${file}: ${problem}. A copy is kept at ${backup}; the ledger is not rebuilt automatically`, {
        next: { waitFor: 'user', hint: 'the user rebuilds the ledger from git with /worktree reconcile --rebuild' },
      })
    }
    return parsed
  }

  /** One backup per corrupt file version (keyed by mtime), never a stream of copies. */
  function backupCorrupt() {
    const stamp = Math.trunc(statSync(file).mtimeMs)
    const backup = `${file}.corrupt-${stamp}`
    if (!existsSync(backup)) copyFileSync(file, backup)
    return backup
  }

  async function acquire() {
    mkdirSync(directory, { recursive: true })
    const deadline = now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const fd = openSync(lockFile, 'wx')
        writeFileSync(fd, JSON.stringify({ pid, at: now() }))
        closeSync(fd)
        return
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error
      }
      // A lock older than the stale window belongs to a crashed writer.
      try {
        if (now() - statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lockFile)
          continue
        }
      } catch {
        continue
      }
      if (now() > deadline) throw new WorktreeError(WORKTREE_CODES.LOCK_TIMEOUT, `ledger lock ${lockFile} is held by another writer`)
      await sleep(25)
    }
  }

  function release() {
    try {
      unlinkSync(lockFile)
    } catch {
      // already gone (stolen as stale): nothing to release
    }
  }

  /** @param {{ schemaVersion: number, seq: number, lanes: any[] }} value */
  function write(value) {
    const problem = validateLedger(value)
    if (problem) throw new Error(`refusing to write an invalid ledger: ${problem}`)
    const temp = `${file}.${pid}.${now()}.tmp`
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(temp, file)
  }

  return {
    file,
    directory,
    read,
    /**
     * Read–modify–write under the lock. `mutate` receives a deep copy and
     * returns the new ledger (or undefined to keep it); a throw aborts the
     * update and leaves the file byte-identical.
     * @template T
     * @param {(ledger: { schemaVersion: number, seq: number, lanes: any[] }) => ({ ledger?: any, result?: T } | void)} mutate
     * @returns {Promise<T | undefined>}
     */
    async update(mutate) {
      await acquire()
      try {
        const current = structuredClone(read())
        const outcome = mutate(current) ?? {}
        if (outcome.ledger) write(outcome.ledger)
        return outcome.result
      } finally {
        release()
      }
    },
    /** Replace the ledger wholesale (explicit user rebuild only). */
    async replace(/** @type {any} */ value) {
      await acquire()
      try {
        write(value)
      } finally {
        release()
      }
    },
  }
}
