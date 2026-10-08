// Filesystem Adapter of the capability store: the seam between the lock and
// commit protocol and the real filesystem. Every protocol step is one call
// here, so a test Adapter can wrap these calls to inject faults, block at an
// exact step, or force an interleaving between two contenders.
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'

/**
 * @typedef {{
 *   readText(path: string): Promise<string>,
 *   createExclusive(path: string, text: string): Promise<void>,
 *   fsyncFile(path: string): Promise<void>,
 *   link(from: string, to: string): Promise<void>,
 *   rename(from: string, to: string): Promise<void>,
 *   unlink(path: string): Promise<void>,
 *   readdir(path: string): Promise<string[]>,
 *   mkdirp(path: string): Promise<void>,
 *   fsyncDir(path: string): Promise<void>,
 * }} StoreFs
 */

// Directory fsync is a POSIX crash-durability idiom: on Windows the directory
// handle opens but sync fails EPERM (verified on Node v24, NTFS). The win32
// store row (SUPPORTED_PLATFORMS in store.js) therefore commits with
// file-level fsync + atomic rename only — the same platform stance the
// edit-lock reservation already takes (reservation.js SYNC_SUPPORTED). The
// durability tradeoff is documented in docs/features/session-capability-manager.md.
const DIR_SYNC_SUPPORTED = process.platform === 'darwin' || process.platform === 'linux'

// Windows file-locking etiquette: antivirus and the search indexer briefly
// hold brand-new files, so unlink/rename/link can fail transiently with
// EPERM/EACCES/EBUSY (observed in the cross-process suite). POSIX rows never
// see those codes from these operations; the win32 row retries a few times
// before surfacing the error.
const WINDOWS = process.platform === 'win32'
const TRANSIENT_LOCK = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** @param {() => Promise<unknown>} op @returns {Promise<void>} */
async function retryTransientLock(op) {
  for (let attempt = 0; ; attempt++) {
    try {
      await op()
      return
    } catch (error) {
      if (!WINDOWS || !TRANSIENT_LOCK.has(/** @type {{ code?: string }} */ (error)?.code ?? '') || attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

/** @returns {StoreFs} */
export function createNodeFs() {
  return {
    readText: path => readFile(path, 'utf8'),
    async createExclusive(path, text) {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(text, 'utf8')
      } finally {
        await handle.close()
      }
    },
    async fsyncFile(path) {
      const handle = await open(path, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
    link: (from, to) => retryTransientLock(() => link(from, to)),
    rename: (from, to) => retryTransientLock(() => rename(from, to)),
    unlink: path => retryTransientLock(() => unlink(path)),
    readdir: path => readdir(path),
    async mkdirp(path) {
      await mkdir(path, { recursive: true, mode: 0o700 })
    },
    async fsyncDir(path) {
      if (!DIR_SYNC_SUPPORTED) return
      const handle = await open(path, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    },
  }
}

/**
 * Wrap an Adapter so `hook(op, args, phase)` runs before and after every call.
 * A hook may await (to block or interleave) or throw (to inject a fault).
 * @param {StoreFs} inner
 * @param {(op: string, args: string[], phase: 'before'|'after') => void|Promise<void>} hook
 * @returns {StoreFs}
 */
export function instrumentFs(inner, hook) {
  /** @type {Record<string, unknown>} */
  const wrapped = {}
  for (const [op, fn] of Object.entries(inner)) {
    wrapped[op] = async (/** @type {string[]} */ ...args) => {
      await hook(op, args, 'before')
      const result = await /** @type {Function} */ (fn)(...args)
      await hook(op, args, 'after')
      return result
    }
  }
  return /** @type {StoreFs} */ (wrapped)
}
