// An administrative disposition is authorization to accept risk, never evidence
// of publication outcome or old-writer quiescence. It lives in the atomic image.
import { createHash } from 'node:crypto'
import { canonical } from './snapshot.js'
import { expectedRegistry, isRegistryUpgrade } from './incarnations.js'

export const LATE_WRITER_RISK = 'Detached historic writers may still modify files after this override.'
export const AUTOMATIC_RECOVERY_ACTOR = 'automatic-dead-process-recovery'
/** Ledger actor vocabulary: the offline settings administrator and the
 * dead-process automatic settlement (design D3) are the only writers. */
const ACTORS = ['authenticated-settings-administrator', AUTOMATIC_RECOVERY_ACTOR]
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
  requireThat(Array.isArray(state.adminRecoveries), 'ledger')
  // The v5 ledger exists only once an override lands; a v6 image may carry an
  // empty one (registry upgrade before any administrative recovery).
  if (state.adminRecoveries.length === 0) { requireThat(state.version === 6, 'nonempty v5 ledger'); return }
  const ids = new Set(), owners = new Set()
  // Rows committed in one transaction share one expected/committed pair;
  // across transactions both revisions are non-decreasing.
  let lastExpected = -1, lastCommitted = -1
  for (const row of state.adminRecoveries) {
    keys(row, ['recoveryId', 'root', 'owner', 'expectedRevision', 'committedRevision', 'at', 'actor', 'reason', 'risk', 'confirmation', 'backup', 'operations', 'releasedLocks', 'revokedEpoch'])
    requireThat(text(row.recoveryId, 128) && !ids.has(row.recoveryId) && text(row.root, 4096) && text(row.owner) && !owners.has(row.owner), 'identity')
    ids.add(row.recoveryId); owners.add(row.owner)
    requireThat(natural(row.expectedRevision) && natural(row.committedRevision) && row.committedRevision === row.expectedRevision + 1 && row.expectedRevision >= lastExpected && row.committedRevision >= lastCommitted && natural(row.at) && ACTORS.includes(row.actor) && text(row.reason, 2000), 'audit')
    lastExpected = row.expectedRevision; lastCommitted = row.committedRevision
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
  return { ...structuredClone(before), version: before.version === 6 ? 6 : 5,
    adminRecoveries: [...(before.adminRecoveries ?? []), structuredClone(record)],
    sessions: before.sessions.map(s => s.sessionId === record.owner ? { ...s, interrupted: true, executionEpoch: record.revokedEpoch } : { ...s }),
    locks: before.locks.filter(l => l.owner !== record.owner).map(l => ({ ...l })),
    holds: before.holds.map(h => h.sessionId === record.owner ? { ...h, holding: false, holdUntil: null, holdCumulativeMs: 0 } : { ...h }),
  }
}

/**
 * Ledger and image-version transition discipline. Without an append the only
 * allowed version change is the v6 registry upgrade; the registry itself may
 * only ever gain the current manager incarnation's entry (expectedRegistry).
 * With appends the transition must be administrative and exactly the fold of
 * the appended records — over `before` itself for the single-record offline
 * path, or over a caller-supplied `base` (the validated ordinary part of a
 * composed commit) for the automatic recovery commit (design D3).
 * @param {any} before @param {any} after @param {boolean} [administrative]
 * @param {any} [base]
 */
export function validateAdminTransition(before, after, administrative = false, base = undefined) {
  const old = before.adminRecoveries ?? [], next = after.adminRecoveries ?? []
  requireThat(next.length >= old.length && old.every((row, i) => canonical(row) === canonical(next[i])), 'append-only ledger')
  if (next.length === old.length) {
    if (before.version === after.version) {
      requireThat(after.version !== 6 || canonical(after.incarnations) === canonical(expectedRegistry(before, after)), 'incarnation registry')
      return
    }
    requireThat(isRegistryUpgrade(before, after), 'version transition requires explicit override')
    return
  }
  requireThat(administrative, 'explicit administrative operation required')
  if (base === undefined) {
    requireThat(next.length === old.length + 1, 'explicit administrative operation required')
    requireThat(canonical(after) === canonical(administrativeState(before, next.at(-1))), 'coherent authority transition')
    return
  }
  requireThat(canonical(base.adminRecoveries ?? []) === canonical(old), 'administrative base ledger')
  let expected = base
  for (const record of next.slice(old.length)) expected = administrativeState(expected, record)
  requireThat(canonical(after) === canonical(expected), 'coherent authority transition')
}
