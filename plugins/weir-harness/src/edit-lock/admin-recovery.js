// Trusted offline admin API. Never opens a runtime or invokes a publisher.
import { constants, lstatSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve, parse, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { reservePublisher } from './reservation.js'
import { openEditLockStore } from './store.js'
import { canonical, parseSnapshot, validateImage } from './snapshot.js'
import { administrativeState, digest, LATE_WRITER_RISK } from './admin-ledger.js'

export const MAX_RECOVERY_BYTES = 16 * 1024 * 1024
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function fail(code, message) { throw Object.assign(new Error(message), { code: `weir-edit-lock/${code}` }) }
function check(condition, message) { if (!condition) fail('invalid-recovery', message) }
function scope(input) { return { root: input.root, owner: input.owner, expectedRevision: input.expectedRevision, operationIds: [...input.operationIds].sort(), risk: LATE_WRITER_RISK } }
export function recoveryConfirmation(input) { return `ADMIN OVERRIDE ${digest(scope(input))}` }
function validateInput(input) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'Recovery object required')
  const keys = ['root', 'owner', 'expectedRevision', 'operationIds', 'recoveryId', 'reason', 'acceptLateWriterRisk', 'confirmation']
  check(Object.keys(input).length === keys.length && keys.every(k => Object.hasOwn(input, k)), 'Exact recovery fields required')
  for (const key of ['root', 'owner', 'recoveryId', 'reason']) check(typeof input[key] === 'string' && input[key].trim() && input[key].length <= (key === 'root' ? 4096 : key === 'reason' ? 2000 : key === 'recoveryId' ? 128 : 512) && !input[key].includes('\0'), `Invalid ${key}`)
  check(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'Expected revision required')
  check(Array.isArray(input.operationIds) && input.operationIds.length > 0 && input.operationIds.length <= 10000 && input.operationIds.every(id => typeof id === 'string' && id.trim() && id.length <= 1024), 'Operation IDs required')
  check(new Set(input.operationIds).size === input.operationIds.length, 'Duplicate operation ID')
  check(input.acceptLateWriterRisk === true && input.confirmation === recoveryConfirmation(input), 'Explicit scoped ADMIN OVERRIDE and late-writer risk acceptance required')
}
function pinsFor(directory) {
  let current = parse(directory).root
  const pins = []
  for (const part of relative(current, directory).split(sep).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    check(stat.isDirectory() && !stat.isSymbolicLink(), 'Authority ancestors must be nonsymlink directories')
    pins.push({ path: current, stat })
  }
  return pins
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
function verify(pins) { for (const pin of pins) check(same(pin.stat, lstatSync(pin.path)), 'Authority ancestor changed') }
async function boundedRead(path, pins) {
  verify(pins)
  const before = lstatSync(path)
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= MAX_RECOVERY_BYTES, 'Bounded single-link regular authority file required')
  // win32: O_NOFOLLOW/O_NONBLOCK are undefined; the lstat above refused a symlink
  // leaf and the post-open identity check below bounds the swap (read-authority.js).
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    check(same(before, stat) && stat.isFile() && stat.nlink === 1 && stat.size <= MAX_RECOVERY_BYTES, 'Opened file identity or bound changed')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await file.stat()
    verify(pins)
    check(same(stat, lstatSync(path)) && after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs && length === stat.size, 'Authority changed during read')
    return bytes.subarray(0, length)
  } finally { await file.close() }
}
async function syncDirectory(directory) {
  // Directory fsync is POSIX-only (EPERM on win32, reservation.js SYNC_SUPPORTED).
  if (process.platform !== 'darwin' && process.platform !== 'linux') return
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** Caller must authenticate settings-plane access and exact-match a server-derived
 * root BEFORE calling. Test checkpoints surround real IO, never replace it.
 * @param {any} input
 * @param {{ checkpoint?: (point: string) => void|Promise<void> }} [testing] */
export async function recoverAuthority(input, testing = {}) {
  validateInput(input)
  // Capture before the first await: the operator request cannot change in flight.
  input = structuredClone(input)
  check(resolve(input.root) === input.root && realpathSync.native(input.root) === input.root, 'Canonical root required')
  const directory = join(input.root, '.weir/edit-lock')
  const pins = pinsFor(directory)
  const reservation = await reservePublisher(directory)
  let store
  try {
    await testing.checkpoint?.('reserved')
    const assertExclusive = async () => { verify(pins); await reservation.assertExclusive(); verify(pins) }
    await assertExclusive()
    const path = join(directory, 'snapshot.json')
    const bytes = await boundedRead(path, pins)
    const before = parseSnapshot(bytes, input.root)
    const existing = before.state.adminRecoveries?.find(row => row.recoveryId === input.recoveryId)
    if (existing) {
      check(existing.confirmation === digest(scope(input)) && existing.reason === input.reason, 'Recovery ID reused with different request')
      const backup = await boundedRead(join(directory, existing.backup.file), pins)
      check(sha256(backup) === existing.backup.sha256 && backup.length === existing.backup.bytes, 'Recovery backup no longer validates')
      const original = parseSnapshot(backup, input.root)
      check(original.revision === existing.expectedRevision, 'Backup revision mismatch')
      await syncDirectory(directory)
      await assertExclusive()
      return { revision: before.revision, idempotent: true, record: existing }
    }
    if (before.revision !== input.expectedRevision) fail('revision-conflict', 'Authority revision changed; inspect and confirm again')
    const owner = before.state.sessions.find(s => s.sessionId === input.owner)
    if (!owner || !owner.interrupted) throw new Error('Only an interrupted historical owner can be overridden')
    const unresolved = before.state.operations.filter(op => op.sessionId === input.owner && ['prepared', 'publishing', 'unknown'].includes(op.phase))
    check(unresolved.length > 0 && unresolved.every(op => op.phase === 'unknown'), 'Recover to stable unknown history before administrative override')
    check(canonical(unresolved.map(op => op.operationId).sort()) === canonical([...input.operationIds].sort()), 'Confirm every unresolved operation for this owner')
    const backup = { file: `admin-backup-${digest([input.root, input.recoveryId])}.json`, sha256: sha256(bytes), bytes: bytes.length }
    const record = { recoveryId: input.recoveryId, root: input.root, owner: input.owner,
      expectedRevision: before.revision, committedRevision: before.revision + 1, at: Date.now(), actor: 'authenticated-settings-administrator',
      reason: input.reason, risk: LATE_WRITER_RISK, confirmation: digest(scope(input)), backup,
      operations: unresolved.map(op => ({ operationId: op.operationId, sha256: digest(op) })),
      releasedLocks: before.state.locks.filter(lock => lock.owner === input.owner), revokedEpoch: owner.executionEpoch + 1 }
    const nextState = administrativeState(before.state, record)
    validateImage(nextState)
    check(Buffer.byteLength(canonical(nextState)) + 1024 <= MAX_RECOVERY_BYTES, 'Resulting authority exceeds recovery byte limit')
    await testing.checkpoint?.('before-backup')
    await assertExclusive()
    let file
    try { file = await open(join(directory, backup.file), 'wx', 0o600) }
    catch (error) { if (/** @type {{code?: string}} */ (error).code !== 'EEXIST') throw error }
    if (file) {
      try { await file.writeFile(bytes); await testing.checkpoint?.('backup-written'); await file.sync() }
      finally { await file.close() }
    }
    const savedBackup = await boundedRead(join(directory, backup.file), pins)
    check(savedBackup.equals(bytes), 'Existing backup does not match exact authority bytes')
    parseSnapshot(savedBackup, input.root)
    // Also sync an existing backup when retrying a crash before its first fsync.
    // fsync needs a writable handle on Windows (EPERM on O_RDONLY): open the
    // existing backup read-write there so the re-sync stays a real fsync.
    const backupHandle = await open(join(directory, backup.file), process.platform === 'win32' ? 'r+' : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try { await backupHandle.sync() } finally { await backupHandle.close() }
    await syncDirectory(directory)
    await testing.checkpoint?.('backup-durable')
    await assertExclusive()
    check((await boundedRead(path, pins)).equals(bytes), 'Authority changed after backup')
    store = await openEditLockStore({ directory, domainId: input.root, mode: 'recover', maxSnapshotBytes: MAX_RECOVERY_BYTES }, { checkpoint: async point => { await testing.checkpoint?.(`store:${point}`); await assertExclusive() } })
    check(canonical(store.snapshot()) === canonical(before), 'Authority changed before commit')
    const saved = await store.recordAdministrativeRecovery({ expectedRevision: before.revision, nextState })
    await assertExclusive()
    return { revision: saved.revision, idempotent: false, record }
  } finally {
    await store?.close()
    // This operation dispatched no file publisher; it may release ONLY its own
    // reservation. A pre-existing runtime/stale reservation is never removed.
    await reservation.releaseAfterQuiescence()
  }
}
