// Advisory lock for the default integration-test root (design D3): concurrent
// run.mjs invocations in one checkout must not share mutable runtime state
// (HOME/profile/ws/traces all hang off the root, and startup wipes it).
//
// Semantics:
//   - the lock is `<root>/.run.lock`, created O_EXCL with `pid + ISO time`
//   - EEXIST with a LIVE holder pid  → divert this run to `<root>-p<own pid>`
//     (one loud stdout line); the run then only ever touches its own root
//   - EEXIST with a DEAD holder pid (or unreadable content) → silent takeover
//   - release on process exit (including error paths), own lock only
// An explicit WEIR_IT_ROOT bypasses this module entirely (run.mjs guards).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOCK_NAME = '.run.lock'

/** pid liveness: EPERM means alive-but-not-ours (kill -0 semantics differ on Windows). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** The holder pid recorded in a lock file, or null when unreadable/invalid. */
function readHolderPid(lockPath) {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0])
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Acquire the advisory lock on `root`.
 * @param {string} root - the default IT root
 * @param {{log?: (line: string) => void}} [hooks] - log injection for tests
 * @returns {{root: string, lockPath: string|null, diverted: boolean}} the root
 *   this run must use everywhere, and the lock to release on exit (null when
 *   diverted — a diverted run holds no lock, its pid-suffixed root is private)
 */
function acquireRunLock(root, { log = console.log } = {}) {
  mkdirSync(root, { recursive: true })
  const lockPath = join(root, LOCK_NAME)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
      return { root, lockPath, diverted: false }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const holder = readHolderPid(lockPath)
      if (holder !== null && holder !== process.pid && pidAlive(holder)) {
        const divertedRoot = `${root}-p${process.pid}`
        log(`[setup] default IT root is locked by live pid ${holder}; this run uses the private root ${divertedRoot}`)
        return { root: divertedRoot, lockPath: null, diverted: true }
      }
      // Stale lock (dead holder or unreadable content): silent takeover.
      rmSync(lockPath, { force: true })
    }
  }
  throw new Error(`run-lock: could not acquire ${lockPath} after stale-takeover retries`)
}

/** Delete a held lock (register on 'exit'); never deletes another pid's lock. */
function releaseRunLock(lock) {
  if (!lock?.lockPath) return
  try {
    if (readHolderPid(lock.lockPath) === process.pid) rmSync(lock.lockPath, { force: true })
  } catch {
    // exit-path cleanup must never throw
  }
}

export { LOCK_NAME, acquireRunLock, releaseRunLock, pidAlive }
