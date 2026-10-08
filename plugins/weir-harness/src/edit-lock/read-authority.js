// Read-only authority snapshot bytes: the one bounded, symlink-pinned,
// identity-checked read shared by the maintenance inspector and the cold
// status view (design D1). No runtime open, no reservation, no mutation —
// the file, the reservation and every history are left byte-identical.
import { lstatSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs'
import { join, resolve, parse, relative, sep } from 'node:path'

/** Same ceiling the maintenance inspector enforces (16 MiB). */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

// Pin every component, including the trusted root's ancestors. Node exposes no
// portable openat: compare identities before/after opening and before/after read.
// NOFOLLOW protects the leaf; NONBLOCK prevents swapped FIFO/device hangs.
// These checks fail closed on observed races, not an atomic hostile-rename proof.
export function checkedPath(path) {
  const absolute = resolve(path)
  let current = parse(absolute).root
  const pins = []
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('symlink authority component refused')
    pins.push({ path: current, stat })
  }
  return pins
}
/** @param {import('node:fs').Stats} a @param {import('node:fs').Stats} b */
export function sameNode(a, b) { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode }
/** @param {{ path: string, stat: import('node:fs').Stats }[]} pins */
export function verifyPins(pins) {
  for (const pin of pins) if (!sameNode(pin.stat, lstatSync(pin.path))) throw new Error('authority path changed during inspection')
}
/** @param {unknown} error */
export function missing(error) { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }
/** @param {unknown} error */
export function errorMessage(error) { return error instanceof Error ? error.message : String(error) }

/**
 * @typedef {{ presence: 'valid', bytes: Buffer }
 *   | { presence: 'no-authority' }
 *   | { presence: 'no-snapshot' }
 *   | { presence: 'not-a-file' }
 *   | { presence: 'unreadable', message: string }} SnapshotRead
 */

/**
 * Read `<authorityDir>/snapshot.json` with the full read-only discipline:
 * ancestor pins, O_NOFOLLOW leaf, bounded read, before/after identity checks.
 * The bytes are validated nowhere here — the caller runs `parseSnapshot`.
 *
 * Presence facts, never inferred: 'valid' (bytes returned), 'no-authority'
 * (a path component or the directory itself is absent), 'no-snapshot' (the
 * directory stands but no snapshot leaf exists; history indeterminate),
 * 'not-a-file', 'unreadable' (IO failure or an observed race, message kept).
 * @param {string} authorityDir @returns {SnapshotRead}
 */
export function readSnapshotBytes(authorityDir) {
  let parents
  try {
    parents = checkedPath(authorityDir)
  } catch (error) {
    if (missing(error)) return { presence: 'no-authority' }
    return { presence: 'unreadable', message: errorMessage(error) }
  }
  let fd
  try {
    const path = join(authorityDir, 'snapshot.json')
    let leaf
    try { leaf = lstatSync(path) } catch (error) { if (!missing(error)) throw error }
    if (!leaf) {
      verifyPins(parents)
      return { presence: 'no-snapshot' }
    }
    if (!leaf.isFile() || leaf.isSymbolicLink()) return { presence: 'not-a-file' }
    // Windows exposes no O_NOFOLLOW/O_NONBLOCK (constants undefined): the leaf
    // lstat above already refused a symlink and the post-open fstat identity
    // check below bounds the swap window (symlink creation needs privilege on
    // Windows; the residual TOCTOU gap is documented in edit-lock.md).
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || !sameNode(leaf, opened)) throw new Error('opened snapshot identity changed')
    verifyPins(parents)
    if (!sameNode(opened, lstatSync(path))) throw new Error('snapshot replaced before read')
    if (opened.size > MAX_SNAPSHOT_BYTES) throw new Error('snapshot exceeds inspection byte limit')
    const buffer = Buffer.alloc(Math.min(opened.size + 1, MAX_SNAPSHOT_BYTES + 1))
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length)
      if (!count) break
      length += count
    }
    const after = fstatSync(fd)
    verifyPins(parents)
    if (!sameNode(opened, lstatSync(path)) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || length !== opened.size) {
      throw new Error('snapshot changed during bounded read')
    }
    return { presence: 'valid', bytes: buffer.subarray(0, length) }
  } catch (error) {
    return { presence: 'unreadable', message: errorMessage(error) }
  } finally { if (fd !== undefined) closeSync(fd) }
}
