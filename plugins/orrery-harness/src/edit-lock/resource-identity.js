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
 * Read-only POSIX observations, not ownership or publication authority.
 * Filesystem calls are not an atomic snapshot: callers must coordinate mutation.
 * dev/ino continuity cannot detect inode reuse or change-and-restore (ABA).
 */
export function createResourceIdentity() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(`unsupported platform: ${process.platform}`)
  }
  /** @type {WeakMap<object, Evidence>} */
  const observations = new WeakMap()
  /** @param {string} filePath @param {{ cwd: string }} options */
  function resolve(filePath, { cwd }) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('expected absolute cwd')
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('expected non-empty path')
    if (filePath.includes('\0') || cwd.includes('\0')) throw new TypeError('NUL in path')
    const result = inspect(isAbsolute(filePath) ? filePath : `${cwd}/${filePath}`)
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

/** Walk original prefixes without lexically collapsing symlink/.. or missing/..
 * @param {string} spelling @returns {Inspection} */
function inspect(spelling) {
  const parts = spelling.split('/')
  let ancestor = '/'
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
    if (entry.isSymbolicLink()) traceLink(physical, witnesses, 0)
    for (let parent = dirname(ancestor); ; parent = dirname(parent)) {
      const directory = statSync(parent, { bigint: true })
      witnesses.push(`${parent}:${directory.dev}:${directory.ino}`)
      if (parent === '/') break
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
 * @param {string} path @param {string[]} witnesses @param {number} depth */
function traceLink(path, witnesses, depth) {
  if (depth >= 40) throw new Error('unsupported symlink depth')
  const target = readlinkSync(path)
  witnesses.push(`link:${path}:${target}`)
  let parent = isAbsolute(target) ? '/' : dirname(path)
  const parts = isAbsolute(target) ? target.split('/').slice(1) : target.split('/')
  for (const part of parts) {
    const prefix = `${parent}/${part}`
    const node = lstatSync(prefix, { bigint: true })
    witnesses.push(`${prefix}:${node.dev}:${node.ino}`)
    if (node.isSymbolicLink()) traceLink(prefix, witnesses, depth + 1)
    parent = realpathSync.native(prefix)
  }
}
