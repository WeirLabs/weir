// An administrative disposition is authorization to accept risk, never evidence
// of publication outcome or old-writer quiescence. It lives in the atomic image.
import { createHash } from 'node:crypto'
import { canonical } from './snapshot.js'

export const LATE_WRITER_RISK = 'Detached historic writers may still modify files after this override.'
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
export const dispositionFor = (state, op) => state.adminRecoveries?.find(row => row.owner === op.sessionId && row.operations.some(item => item.operationId === op.operationId))
export const revokedOwner = (state, owner) => state.adminRecoveries?.some(row => row.owner === owner) === true

function requireThat(condition, message) { if (!condition) throw new Error(`invalid administrative recovery: ${message}`) }
function keys(value, names) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(k => Object.hasOwn(value, k)), 'schema')
}
function text(value, max = 512) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0') }
const natural = value => Number.isSafeInteger(value) && value >= 0

export function validateAdminLedger(state) {
  if (state.version === 4) return
  requireThat(Array.isArray(state.adminRecoveries) && state.adminRecoveries.length > 0, 'nonempty v5 ledger')
  const ids = new Set(), owners = new Set()
  let revision = -1
  for (const row of state.adminRecoveries) {
    keys(row, ['recoveryId', 'root', 'owner', 'expectedRevision', 'committedRevision', 'at', 'actor', 'reason', 'risk', 'confirmation', 'backup', 'operations', 'releasedLocks', 'revokedEpoch'])
    requireThat(text(row.recoveryId, 128) && !ids.has(row.recoveryId) && text(row.root, 4096) && text(row.owner) && !owners.has(row.owner), 'identity')
    ids.add(row.recoveryId); owners.add(row.owner)
    requireThat(natural(row.expectedRevision) && natural(row.committedRevision) && row.committedRevision === row.expectedRevision + 1 && row.expectedRevision >= revision && natural(row.at) && row.actor === 'authenticated-settings-administrator' && text(row.reason, 2000), 'audit')
    revision = row.committedRevision
    requireThat(row.risk === LATE_WRITER_RISK && /^[a-f0-9]{64}$/.test(row.confirmation), 'risk acknowledgement')
    keys(row.backup, ['file', 'sha256', 'bytes'])
    requireThat(row.backup.file === `admin-backup-${digest([row.root, row.recoveryId])}.json` && /^[a-f0-9]{64}$/.test(row.backup.sha256) && natural(row.backup.bytes) && row.backup.bytes > 0, 'backup')
    const session = state.sessions.find(s => s.sessionId === row.owner)
    requireThat(session?.interrupted && natural(row.revokedEpoch) && session.executionEpoch >= row.revokedEpoch && !state.locks.some(l => l.owner === row.owner), 'revoked owner')
    requireThat(Array.isArray(row.operations) && row.operations.length > 0, 'operations')
    const opIds = new Set()
    for (const item of row.operations) {
      keys(item, ['operationId', 'sha256'])
      requireThat(text(item.operationId, 1024) && !opIds.has(item.operationId), 'operation key')
      opIds.add(item.operationId)
      const op = state.operations.find(o => o.sessionId === row.owner && o.operationId === item.operationId)
      requireThat(op?.phase === 'unknown' && digest(op) === item.sha256, 'immutable operation binding')
    }
    requireThat(state.operations.filter(o => o.sessionId === row.owner && (o.phase === 'unknown' || o.phase === 'publishing' || o.phase === 'prepared')).every(o => opIds.has(o.operationId)), 'complete unresolved owner scope')
    requireThat(row.confirmation === digest({ root: row.root, owner: row.owner, expectedRevision: row.expectedRevision, operationIds: [...opIds].sort(), risk: LATE_WRITER_RISK }), 'scoped confirmation')
    requireThat(Array.isArray(row.releasedLocks), 'released locks')
    const resources = new Set()
    for (const lock of row.releasedLocks) {
      keys(lock, lock.status === 'abnormal' ? ['resourceId', 'owner', 'generation', 'status', 'reason'] : ['resourceId', 'owner', 'generation', 'status'])
      requireThat(['active', 'user-interrupted', 'pending-confirmation', 'abnormal'].includes(lock.status) && (lock.status !== 'abnormal' || text(lock.reason)), 'released lock shape')
      requireThat(text(lock.resourceId, 4096) && lock.owner === row.owner && natural(lock.generation) && lock.generation > 0 && !resources.has(lock.resourceId), 'released ownership')
      resources.add(lock.resourceId)
      requireThat(state.generations.some(g => g.resourceId === lock.resourceId && g.generation >= lock.generation), 'generation tombstone')
    }
  }
}

/** Exact coherent transition: only this owner loses ownership; history is unchanged. */
export function administrativeState(before, record) {
  requireThat(!revokedOwner(before, record.owner), 'owner already revoked')
  const session = before.sessions.find(s => s.sessionId === record.owner)
  requireThat(session && Number.isSafeInteger(session.executionEpoch + 1) && record.revokedEpoch === session.executionEpoch + 1, 'revocation epoch')
  requireThat(session.interrupted, 'interrupted owner required')
  requireThat(canonical(record.releasedLocks) === canonical(before.locks.filter(l => l.owner === record.owner)), 'exact ownership scope')
  return { ...structuredClone(before), version: 5,
    adminRecoveries: [...(before.adminRecoveries ?? []), structuredClone(record)],
    sessions: before.sessions.map(s => s.sessionId === record.owner ? { ...s, interrupted: true, executionEpoch: record.revokedEpoch } : { ...s }),
    locks: before.locks.filter(l => l.owner !== record.owner).map(l => ({ ...l })),
    holds: before.holds.map(h => h.sessionId === record.owner ? { ...h, holding: false, holdUntil: null, holdCumulativeMs: 0 } : { ...h }),
  }
}

export function validateAdminTransition(before, after, administrative = false) {
  const old = before.adminRecoveries ?? [], next = after.adminRecoveries ?? []
  requireThat(next.length >= old.length && old.every((row, i) => canonical(row) === canonical(next[i])), 'append-only ledger')
  if (next.length === old.length) {
    requireThat(before.version === after.version, 'version transition requires explicit override')
    return
  }
  requireThat(administrative && next.length === old.length + 1, 'explicit administrative operation required')
  requireThat(canonical(after) === canonical(administrativeState(before, next.at(-1))), 'coherent authority transition')
}
