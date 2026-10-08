/// <reference path="../capabilities/store/checked-contract.d.ts" />
import { mkdirSync, realpathSync, lstatSync, rmdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync, constants } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createLiveness } from '../capabilities/store/liveness.js'
import { parseOwnerDoc } from '../capabilities/store/lock.js'
import { canonical } from './snapshot.js'

/** Deterministic sibling of a canonical authority directory.
 * @param {string} authority */
export function reservationPathFor(authority) {
  return join(dirname(authority), `.${basename(authority)}.publisher-reservation`)
}

// Lease defaults (spike 0.1, openspec edit-lock-autonomous-recovery): the lease
// bounds crash-detection latency, the renewal period bounds its cost. Renewal
// is a temp+rename of one small file and costs single-digit milliseconds even
// under load, so a 30s/10s pair keeps detection latency human-scale at
// negligible IO cost. A timeout ALONE never justifies reclamation: the
// recorded owner must also be proven dead by the shared Liveness adapter.
export const RESERVATION_LEASE_MS = 30_000
export const RESERVATION_RENEW_MS = 10_000

const OWNER_FILE = 'owner.json'

/** @param {unknown} error @param {...string} codes */
const hasCode = (error, ...codes) => codes.includes(/** @type {{ code?: string }} */ (error)?.code ?? '')

/** Read and parse the owner document of a reservation directory.
 * @param {string} path @returns {ReturnType<typeof parseOwnerDoc>} */
function readOwner(path) {
  let text
  try {
    text = readFileSync(join(path, OWNER_FILE), 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { kind: /** @type {const} */ ('absent') }
    throw error
  }
  return parseOwnerDoc(text)
}

/** Atomic full-content owner publication inside the reservation directory
 * (temp + rename; a crash leaves an orphan temp, never a torn owner.json).
 * @param {string} path @param {import('../capabilities/store/lock.js').OwnerDoc} doc */
function writeOwner(path, doc) {
  const temporary = join(path, `.owner-${doc.ownerToken}.tmp`)
  writeFileSync(temporary, JSON.stringify(doc), { mode: 0o600 })
  renameSync(temporary, join(path, OWNER_FILE))
}

// fsync on a directory handle is a POSIX crash-durability idiom: on Windows
// the handle opens but fsync fails EPERM (verified on Node v24, NTFS), so the
// win32 row skips it — the owner temp+rename stands on NTFS journaling.
/** @param {string} directory */
function syncParent(directory) {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const handle = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try { fsyncSync(handle) } finally { closeSync(handle) }
}

/** True while the recorded owner document is exactly the one we observed
 * (same token, same lease): any renewal or replacement aborts a reclaim.
 * @param {import('../capabilities/store/lock.js').OwnerDoc} a @param {import('../capabilities/store/lock.js').OwnerDoc} b */
const sameOwner = (a, b) => canonical(a) === canonical(b)

/** Conservative cross-process reservation for one preconfigured authority
 * directory on a local filesystem. All cooperating hosts MUST use the same
 * authority directory; this is not discovery for overlapping workspace roots.
 *
 * Liveness stance (design D1): the reservation carries an owner document
 * (pid/host/startIdentity/lease, schema-aligned with the capability-store
 * OwnerDoc) that the holder renews periodically. A crash leaves the directory
 * in place; a newcomer finding it reclaims it ONLY when the lease has expired
 * AND the recorded owner is proven dead (same host, same boot, pid gone or
 * start-identity mismatch) — through a serialized `<reservation>.recover`
 * lock with a re-read before the rename, so a reservation naming a live owner
 * is never removed. Every other outcome (lease current, owner alive, owner
 * state unknown, owner document absent/corrupt) keeps the historical
 * behavior: the newcomer becomes a client (EEXIST).
 * @param {string} directory
 * @param {{ liveness?: import('../capabilities/store/liveness.js').Liveness,
 *   leaseMs?: number, renewMs?: number, now?: () => number,
 *   token?: () => string,
 *   testing?: { checkpoint?: (point: string) => void|Promise<void> }}} [options] */
export async function reservePublisher(directory, options = {}) {
  const authority = realpathSync.native(directory)
  if (!lstatSync(authority).isDirectory()) throw new Error('authority directory required')
  if (dirname(authority) === authority) throw new Error('filesystem root cannot be authority directory')
  const liveness = options.liveness ?? createLiveness()
  const leaseMs = options.leaseMs ?? RESERVATION_LEASE_MS
  const renewMs = options.renewMs ?? RESERVATION_RENEW_MS
  const now = options.now ?? Date.now
  const token = options.token ?? (() => randomBytes(12).toString('hex'))
  const testing = options.testing ?? {}
  // Keep the store directory empty for initial creation; use a deterministic
  // sibling reservation tied to the canonical authority path.
  const path = reservationPathFor(authority)

  /** @param {string} ownerToken @returns {Promise<import('../capabilities/store/lock.js').OwnerDoc>} */
  async function ownerDoc(ownerToken) {
    const startIdentity = await liveness.identity()
    const at = now()
    return {
      schemaVersion: 1, ownerToken, pid: liveness.pid, host: liveness.host,
      startIdentity, acquiredAt: at, leaseUntil: at + leaseMs,
    }
  }

  /**
   * Serialized reclamation of a reservation whose observed owner is expired
   * and proven dead. The `<reservation>.recover` directory serializes
   * concurrent reclaimers and stays GENUINELY exclusive for the whole
   * takeover → reservation-replacement → cleanup sequence:
   *
   * - An abandoned recovery lock is taken over only after re-verifying, past
   *   the awaited death check, that the directory renamed aside is still the
   *   exact one observed (same dev/ino, same owner document). A live
   *   reclaimer that took over in the window changed both, so a stale
   *   observation can never rename a LIVE recovery lock aside.
   * - The takeover immediately publishes OUR owner document and anchors the
   *   lock to the created directory's dev/ino identity.
   * - Immediately before the reservation rename, the recovery lock must still
   *   carry our identity AND our owner document, and the reservation must
   *   still name the observed dead owner. Any drift loses the reclaim.
   * - Cleanup removes the recovery lock only while it is still the directory
   *   we created, so a loser never deletes the winner's lock.
   *
   * Test-only checkpoints surround the decision points; they never replace
   *   filesystem calls. @param {import('../capabilities/store/lock.js').OwnerDoc} observed */
  async function reclaim(observed) {
    const recoverPath = `${path}.recover`
    const recoverToken = token()
    let held = false
    /** @type {{ dev: bigint, ino: bigint }|null} */
    let ours = null
    /** The dev/ino of the recovery directory right now (null when absent).
     * @returns {{ dev: bigint, ino: bigint }|null} */
    const statRecover = () => {
      try {
        const stat = lstatSync(recoverPath, { bigint: true })
        return stat.isDirectory() ? { dev: stat.dev, ino: stat.ino } : null
      } catch (error) {
        if (hasCode(error, 'ENOENT')) return null
        throw error
      }
    }
    /** @param {string} message */
    const lost = message => Object.assign(new Error(`${message}: EEXIST`), { code: 'EEXIST' })
    try {
      mkdirSync(recoverPath, { mode: 0o700 })
      held = true
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      // A previous reclaimer holds (or abandoned) the serialization lock. It
      // can be retaken only when its own owner is expired and proven dead; a
      // crashed reclaimer that already renamed the reservation aside left NO
      // reservation behind, so an existing reservation naming the dead owner
      // means the interrupted reclaim never moved it. Anything else fails
      // closed: the caller becomes a client, exactly as with a live publisher.
      const observedLock = statRecover()
      const recover = readOwner(recoverPath)
      if (observedLock === null || recover.kind !== 'ok' || recover.value.leaseUntil > now() ||
          (await liveness.state(recover.value)) !== 'dead') throw error
      await testing.checkpoint?.('takeover-observed')
      // The awaited death check makes the observation above STALE: another
      // reclaimer may have completed its own takeover in between. Rename the
      // abandoned lock aside only while it is still the exact directory we
      // observed — same dev/ino and same owner document. Renaming a LIVE
      // reclaimer's lock aside on a stale observation would hand two
      // processes the serialization of one reclaim.
      const current = statRecover()
      const again = readOwner(recoverPath)
      if (current === null || current.dev !== observedLock.dev || current.ino !== observedLock.ino ||
          again.kind !== 'ok' || !sameOwner(again.value, recover.value)) throw error
      try {
        renameSync(recoverPath, `${recoverPath}.stale.${token()}`)
      } catch (renameError) {
        // A racer moved the observed directory aside first: the takeover is
        // lost and the caller becomes a client, never a second reclaimer.
        if (hasCode(renameError, 'ENOENT')) throw error
        throw renameError
      }
      mkdirSync(recoverPath, { mode: 0o700 })
      held = true
    }
    try {
      // Anchor the lock to the directory WE created, then publish our owner
      // document at once: from here on an identity mismatch is a lost
      // takeover — never a reason to proceed, and never something to clean up.
      const created = lstatSync(recoverPath, { bigint: true })
      ours = { dev: created.dev, ino: created.ino }
      const doc = await ownerDoc(recoverToken)
      writeOwner(recoverPath, doc)
      // Immediately before the reservation rename, prove (a) the recovery
      // lock is still exclusively ours — same dev/ino captured at takeover
      // and still carrying OUR owner document — and (b) the reservation
      // still names the observed dead owner. Any drift aborts the reclaim.
      const lock = statRecover()
      const mine = readOwner(recoverPath)
      if (lock === null || lock.dev !== ours.dev || lock.ino !== ours.ino ||
          mine.kind !== 'ok' || !sameOwner(mine.value, doc)) throw lost('recovery lock lost before reclaim')
      const again = readOwner(path)
      if (again.kind !== 'ok' || !sameOwner(again.value, observed)) {
        throw lost('publisher reservation changed before reclaim')
      }
      await testing.checkpoint?.('before-reservation-rename')
      renameSync(path, `${path}.stale.${recoverToken}`)
      mkdirSync(path, { mode: 0o700 })
      syncParent(dirname(path))
      return true
    } finally {
      if (held && ours !== null) {
        // Remove the serialization lock ONLY while it is still the directory
        // we created: after a lost takeover the same path belongs to another
        // reclaimer, and deleting it would break their exclusion.
        const lock = statRecover()
        if (lock !== null && lock.dev === ours.dev && lock.ino === ours.ino) {
          try { unlinkSync(join(recoverPath, OWNER_FILE)) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
          try { rmdirSync(recoverPath) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
        }
      }
    }
  }

  // The owner document is computed BEFORE the election so the mkdir → publish
  // window is as short as the filesystem allows. A crash inside even that
  // window leaves a reservation without an owner document, which every
  // newcomer treats like the historical stale reservation: become a client.
  let doc = await ownerDoc(token())
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
    const observed = readOwner(path)
    // Any deviation from "expired lease AND provably dead owner" keeps the
    // historical client fallback: timeout alone never justifies reclamation.
    if (observed.kind !== 'ok' || observed.value.leaseUntil > now() ||
        (await liveness.state(observed.value)) !== 'dead' || !(await reclaim(observed.value))) {
      throw error
    }
  }
  writeOwner(path, doc)
  syncParent(dirname(path))
  const identity = lstatSync(path, { bigint: true })
  /** The renewal may only ever write into the directory WE created: after a
   * legitimate replacement (reclaim) the same path belongs to another owner,
   * and renaming our document into it would clobber their lease. */
  const ours = () => {
    try {
      const current = lstatSync(path, { bigint: true })
      return current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino
    } catch { return false }
  }
  let released = false
  /** @type {unknown} */
  let renewalFailure
  const renewal = setInterval(() => {
    try {
      if (!ours()) throw new Error('publisher reservation replaced')
      doc = { ...doc, leaseUntil: now() + leaseMs }
      writeOwner(path, doc)
    } catch (error) {
      // A renewal that cannot land must not masquerade as a live lease:
      // exclusivity checks fail closed from here on; a later newcomer still
      // needs the death proof to reclaim, so this only hurts the owner.
      renewalFailure = error
      clearInterval(renewal)
    }
  }, renewMs)
  renewal.unref?.()
  function assertExclusive() {
    if (released) throw new Error('publisher reservation released')
    if (renewalFailure) throw new Error('publisher reservation renewal failed', { cause: renewalFailure })
    const current = lstatSync(path, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
      || realpathSync.native(path) !== path) throw new Error('publisher reservation replaced')
  }
  return Object.freeze({
    assertExclusive,
    /** The owner document as last (re)published; read-only observation. */
    owner: () => ({ ...doc, startIdentity: { ...doc.startIdentity } }),
    /** The owner must close every admission and await every native publisher
     * before release. A failed drain MUST leave this reservation in place. */
    releaseAfterQuiescence() {
      if (released) return
      clearInterval(renewal)
      assertExclusive()
      // The resolved absolute target and original inode were checked above.
      // Never recursive: unexpected contents retain the reservation — intact,
      // owner document included, so a retained reservation stays reclaimable
      // under the same death-proof rule as a crashed one. Only our own
      // document (and its transient temp) are ever removed here.
      const contents = readdirSync(path).filter(entry => entry !== OWNER_FILE && entry !== `.owner-${doc.ownerToken}.tmp`)
      if (contents.length > 0) throw new Error(`publisher reservation has unexpected contents: ${contents[0]}`)
      try { unlinkSync(join(path, `.owner-${doc.ownerToken}.tmp`)) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
      try { unlinkSync(join(path, OWNER_FILE)) } catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
      rmdirSync(path)
      released = true
    },
  })
}
