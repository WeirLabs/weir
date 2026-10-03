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
    link: (from, to) => link(from, to),
    rename: (from, to) => rename(from, to),
    unlink: path => unlink(path),
    readdir: path => readdir(path),
    async mkdirp(path) {
      await mkdir(path, { recursive: true, mode: 0o700 })
    },
    async fsyncDir(path) {
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
