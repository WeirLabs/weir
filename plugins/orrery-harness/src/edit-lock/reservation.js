import { mkdirSync, realpathSync, lstatSync, rmdirSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'

/** Conservative cross-process reservation for one preconfigured authority
 * directory on a local filesystem. All cooperating hosts MUST use the same
 * authority directory; this is not discovery for overlapping workspace roots.
 * A crash leaves the directory in place. Never steal by timeout or PID probe.
 * @param {string} directory */
export function reservePublisher(directory) {
  const authority = realpathSync.native(directory)
  if (!lstatSync(authority).isDirectory()) throw new Error('authority directory required')
  if (dirname(authority) === authority) throw new Error('filesystem root cannot be authority directory')
  // Keep the store directory empty for initial creation; use a deterministic
  // sibling reservation tied to the canonical authority path.
  const path = join(dirname(authority), `.${basename(authority)}.publisher-reservation`)
  // Atomic exclusive mkdir is the only election operation. EEXIST includes
  // stale reservations and requires external quiescence recovery, not retry.
  mkdirSync(path, {mode:0o700})
  const identity = lstatSync(path, {bigint:true})
  let released = false
  function assertExclusive() {
    if (released) throw new Error('publisher reservation released')
    const current = lstatSync(path, {bigint:true})
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
      || realpathSync.native(path) !== path) throw new Error('publisher reservation replaced')
  }
  return Object.freeze({
    assertExclusive,
    /** The owner must close every admission and await every native publisher
     * before release. A failed drain MUST leave this reservation in place. */
    releaseAfterQuiescence() {
      if (released) return
      assertExclusive()
      // The resolved absolute target and original inode were checked above.
      // Never recursive: unexpected contents retain the reservation.
      rmdirSync(path)
      released = true
    },
  })
}
