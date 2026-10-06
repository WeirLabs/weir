// Read-only Edit Lock authority residue probe for lane cleanup/abandon
// (edit-lock-autonomous-recovery, design D5): a bounded read of the
// management domain's committed snapshot — no runtime open, no reservation,
// no mutation. Residue = the lane's owner session still has unresolved
// operations (prepared/publishing/unknown) or locks in the image. Every
// failure mode (missing/unreadable/corrupt/oversized authority) is a silent
// "no residue": the check feeds a warning, it is never a gate.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { parseSnapshot } from '../edit-lock/snapshot.js'

/** Same ceiling the maintenance inspector enforces (16 MiB). */
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

/**
 * @typedef {{ operations: number, locks: number }} AuthorityResidue
 */

/**
 * Read-only residue check of the Edit Lock authority under `root` for one
 * session. Returns null when there is no residue OR when the authority
 * cannot be read or validated — a failed check never blocks cleanup.
 * @param {string} root - canonical management root (the repo's mainRoot)
 * @param {string | null | undefined} sessionId - the lane's ownerSession
 * @returns {AuthorityResidue | null}
 */
export function authorityResidue(root, sessionId) {
  if (typeof root !== 'string' || !root || typeof sessionId !== 'string' || !sessionId) return null
  try {
    const path = join(root, '.orrery', 'edit-lock', 'snapshot.json')
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    /** @type {Buffer} */
    let bytes
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null
      bytes = Buffer.alloc(stat.size)
      let length = 0
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length)
        if (count === 0) break
        length += count
      }
      if (length !== bytes.length) return null
    } finally {
      closeSync(fd)
    }
    const { state } = parseSnapshot(bytes, root)
    const operations = state.operations.filter((op) => op?.sessionId === sessionId
      && (op?.phase === 'prepared' || op?.phase === 'publishing' || op?.phase === 'unknown')).length
    const locks = state.locks.filter((lock) => lock?.owner === sessionId).length
    return operations === 0 && locks === 0 ? null : { operations, locks }
  } catch {
    return null
  }
}
