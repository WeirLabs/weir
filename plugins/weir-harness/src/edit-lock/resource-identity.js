import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

/**
 * @typedef {Readonly<{ kind: 'file', resourceId: string }> |
 *   Readonly<{ kind: 'missing', ancestor: string, suffix: string }>} Observation
 * @typedef {{ value: Observation, witnesses: string[], links: number }} Inspection
 * @typedef {{ filePath: string, cwd: string, kind: Observation['kind'],
 *   witnesses: string[], links: number }} Evidence
 */

/**
 * Read-only filesystem observations, not ownership or publication authority.
 * Filesystem calls are not an atomic snapshot: callers must coordinate mutation.
 * dev/ino continuity cannot detect inode reuse or change-and-restore (ABA).
 *
 * Verified platform rows: darwin/linux (POSIX spellings) and win32
 * (openspec windows-platform-adaptation: drive-letter absolute spellings with
 * both separators normalized to '/'; NTFS dev/ino/nlink verified real on Node
 * v24; junctions are reparse points and surface as symbolic links). UNC and
 * device paths are rejected on win32 — network shares are outside the
 * supported envelope (edit-lock.md).
 * @param {{ platform?: string }} [options]
 */
export function createResourceIdentity({ platform = process.platform } = {}) {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`unsupported platform: ${platform}`)
  }
  const win = platform === 'win32'
  /** @type {WeakMap<object, Evidence>} */
  const observations = new WeakMap()
  /** @param {string} filePath @param {{ cwd: string }} options */
  function resolve(filePath, { cwd }) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('expected absolute cwd')
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('expected non-empty path')
    if (filePath.includes('\0') || cwd.includes('\0')) throw new TypeError('NUL in path')
    const joined = isAbsolute(filePath) ? filePath : `${cwd}/${filePath}`
    const result = inspect(win ? normalizeWin(joined) : joined, win)
    const observation = Object.freeze(result.value)
    observations.set(observation, { filePath, cwd, kind: observation.kind, witnesses: result.witnesses, links: result.links })
    return observation
  }
  return {
    resolve,
    /** @param {unknown} observation @returns {Observation} */
    revalidate(observation) {
      if (observation === null || typeof observation !== 'object') throw new Error('unknown observation')
      const original = observations.get(observation)
      if (!original) throw new Error('unknown observation')
      const fresh = resolve(original.filePath, { cwd: original.cwd })
      const current = observations.get(fresh)
      if (!current || fresh.kind !== original.kind || current.links !== original.links ||
          original.witnesses.some((witness, index) => witness !== current.witnesses[index])) {
        throw new Error('topology changed')
      }
      return fresh
    },
  }
}

/** Canonical spelling for the win32 walk: single forward slashes under a
 * drive-letter root. UNC/device roots are rejected, never reinterpreted.
 * @param {string} spelling */
function normalizeWin(spelling) {
  const normalized = spelling.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!/^[A-Za-z]:\//.test(normalized)) throw new Error(`unsupported path root (drive-letter absolute paths only): ${spelling.slice(0, 64)}`)
  return normalized
}

/** Walk original prefixes without lexically collapsing symlink/.. or missing/..
 * The ancestor chain terminates at the filesystem root of the spelling —
 * '/' on POSIX, '<drive>:/' on win32 — detected as dirname's fixed point.
 * @param {string} spelling @param {boolean} win @returns {Inspection} */
function inspect(spelling, win) {
  const parts = spelling.split('/')
  let ancestor = win ? /** @type {string} */ (parts[0]) : '/'
  const witnesses = []
  let links = 0
  for (let index = 1; index < parts.length; index++) {
    const prefix = parts.slice(0, index + 1).join('/') || '/'
    let entry
    try {
      entry = lstatSync(prefix, { bigint: true })
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      const suffix = parts.slice(index).join('/')
      if (parts.slice(index).includes('..')) throw new Error('missing path contains ..')
      return { value: { kind: 'missing', ancestor, suffix }, witnesses, links }
    }
    if (entry.isSymbolicLink()) links++
    const physical = `${ancestor}/${parts[index]}`
    ancestor = realpathSync.native(prefix)
    const node = statSync(ancestor, { bigint: true })
    witnesses.push(`${ancestor}:${node.dev}:${node.ino}:${entry.dev}:${entry.ino}`)
    if (entry.isSymbolicLink()) traceLink(physical, witnesses, 0, win)
    for (let parent = dirname(ancestor); ; parent = dirname(parent)) {
      const directory = statSync(parent, { bigint: true })
      witnesses.push(`${parent}:${directory.dev}:${directory.ino}`)
      if (parent === dirname(parent)) break
    }
    if (index < parts.length - 1) {
      if (!node.isDirectory()) throw new Error('non-directory ancestor')
    } else if (!node.isFile() || node.nlink !== 1n) {
      throw new Error('not editable: expected a single-link regular file')
    }
  }
  return { value: { kind: 'file', resourceId: ancestor }, witnesses, links }
}

/** Witness every target hop from an already-witnessed physical parent. Advancing
 * the physical cursor avoids recursively replaying the original parent spelling.
 * Resolve each component only AFTER tracing it: lexical .. collapse or resolving
 * the whole target up front would hide nested links and their topology changes.
 * On win32 readlink returns backslash spellings; they are normalized before the
 * walk so component splitting matches the POSIX row.
 * @param {string} path @param {string[]} witnesses @param {number} depth @param {boolean} win */
function traceLink(path, witnesses, depth, win) {
  if (depth >= 40) throw new Error('unsupported symlink depth')
  const target = win ? readlinkSync(path).replace(/\\/g, '/') : readlinkSync(path)
  witnesses.push(`link:${path}:${target}`)
  let parent = isAbsolute(target) ? (win ? /** @type {string} */ (target.split('/')[0]) : '/') : dirname(path)
  const parts = isAbsolute(target) ? target.split('/').slice(1) : target.split('/')
  for (const part of parts) {
    const prefix = `${parent}/${part}`
    const node = lstatSync(prefix, { bigint: true })
    witnesses.push(`${prefix}:${node.dev}:${node.ino}`)
    if (node.isSymbolicLink()) traceLink(prefix, witnesses, depth + 1, win)
    parent = realpathSync.native(prefix)
  }
}
