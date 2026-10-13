// Scenario: editlock-revoked-repair — epoch-scoped revocation repair
// (openspec edit-lock-revoked-session-repair, D1–D4, task 6.2). Phase 1 boots a
// session whose managed write loses its ack after the backend completes
// (repair fault probe), so the session ends with a durable UNKNOWN operation —
// the unresolved history an administrative recovery must bind. A child process
// then plays the operator: recovery open (no liveness — no automatic
// settlement) + one online adminRecoverOnline, which revokes the session
// (ledger row, epoch := revokedEpoch, locks released). Phase 2 adopts the same
// session and sends ONE genuine user message: the message-driven auto-resume
// repairs the revocation silently (zero-lock confirm of the empty set, epoch
// advanced past revokedEpoch, audit kind 'revocation-repaired' trigger 'auto')
// and the scripted read → write → release succeeds; the same boot manufactures
// a second unknown operation. A second administrative recovery revokes the
// session again (second ledger row, strictly greater revokedEpoch), and phase 3
// repairs it again with one more genuine user message. The authority image
// validates at every open; the first ledger row stays byte-identical
// (append-only; repair never rewrites the disposition).
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines, readJsonl } from '../jsonl.js'
import { textOf } from '../message-text.js'

const id = 'editlock-revoked-repair'
const WS = join(IT_ROOT, 'ws')
const AUTHORITY = join(WS, '.weir', 'edit-lock-revoked-repair')
const SEED = join(WS, 'revoked-repair-seed.txt')
const TARGET = join(WS, 'revoked-repair-target.txt')
const ORPHAN = join(WS, 'revoked-repair-orphan.txt')
const FINAL = join(WS, 'revoked-repair-final.txt')
const NODE = process.env.WEIR_IT_NODE ?? '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
const HARNESS_SRC = new URL('../../../weir-harness/src/', import.meta.url).pathname

function snapshotState() {
  const path = join(AUTHORITY, 'snapshot.json')
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null
  return state && {
    version: state.version,
    sessions: state.sessions?.map(session => ({ sessionId: session.sessionId, interrupted: session.interrupted, epoch: session.executionEpoch })),
    locks: state.locks?.map(lock => ({ resourceId: lock.resourceId, owner: lock.owner, status: lock.status })),
    operations: state.operations?.map(op => ({ sessionId: op.sessionId, operationId: op.operationId, phase: op.phase, outcome: op.outcome?.kind ?? null, originEpoch: op.origin?.executionEpoch ?? null })),
    adminRecoveries: state.adminRecoveries?.map(row => ({ recoveryId: row.recoveryId, owner: row.owner, actor: row.actor, revokedEpoch: row.revokedEpoch, operations: row.operations?.map(item => item.operationId) })),
    adminRecoveriesRaw: state.adminRecoveries ?? null,
    issuedRequests: state.issuedRequests,
  }
}

/** Run one node child; resolves with { code, signal, stdout, stderr }. */
function runChild(script) {
  return new Promise((resolve) => {
    const child = spawn(NODE, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', (error) => resolve({ code: 1, signal: null, stdout, stderr: String(error) }))
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

/** The operator: recovery open WITHOUT liveness (no automatic settlement — the
 * explicit online recovery is the only settlement), then one
 * adminRecoverOnline revoking the session, exactly the maintenance panel's
 * transaction. Prints the committed facts as one JSON line. */
function revokeChild(sessionId, recoveryId) {
  return runChild(`
    import { writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { openEditLockStore } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/store.js`)}
    import { recoverEditLockManager } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/manager.js`)}
    import { reservePublisher } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/reservation.js`)}
    import { createLiveness } from ${JSON.stringify(`${HARNESS_SRC}/capabilities/store/liveness.js`)}
    import { LATE_WRITER_RISK, dispositionFor } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/admin-ledger.js`)}
    import { recoveryConfirmation } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/admin-recovery.js`)}
    const liveness = createLiveness()
    await reservePublisher(${JSON.stringify(AUTHORITY)}, { liveness, leaseMs: 1000, renewMs: 250 })
    const store = await openEditLockStore({ directory: ${JSON.stringify(AUTHORITY)}, domainId: ${JSON.stringify(WS)}, mode: 'recover' })
    const manager = await recoverEditLockManager({ store, managerIncarnation: 'it-revoked-repair-admin',
      root: ${JSON.stringify(WS)}, writeBackup: async (file, bytes) => { await writeFile(join(${JSON.stringify(AUTHORITY)}, file), bytes) } })
    const snap = store.snapshot()
    // The manager's unresolved scope excludes operations an earlier ledger row
    // already disposed; the operator's confirmation must match it exactly.
    const unresolved = snap.state.operations.filter(op => op.sessionId === ${JSON.stringify(sessionId)} && op.phase === 'unknown' && !dispositionFor(snap.state, op))
    const operationIds = unresolved.map(op => op.operationId).sort()
    const scope = { root: ${JSON.stringify(WS)}, owner: ${JSON.stringify(sessionId)}, expectedRevision: snap.revision, operationIds, risk: LATE_WRITER_RISK }
    const settle = await manager.adminRecoverOnline({
      owner: ${JSON.stringify(sessionId)}, expectedRevision: snap.revision, operationIds,
      recoveryId: ${JSON.stringify(recoveryId)},
      reason: 'Integration scenario: the operator reviewed the displayed scope and accepted the displayed late-writer risk.',
      acceptLateWriterRisk: true, confirmation: recoveryConfirmation(scope) })
    const after = store.snapshot()
    const ledgerRow = after.state.adminRecoveries.find(row => row.recoveryId === ${JSON.stringify(recoveryId)})
    await manager.close()
    console.log(JSON.stringify({ recoveryId: ${JSON.stringify(recoveryId)}, revision: settle.revision, idempotent: settle.idempotent,
      actor: settle.record.actor, revokedEpoch: settle.record.revokedEpoch, operations: settle.record.operations.map(item => item.operationId),
      releasedLocks: settle.record.releasedLocks.map(item => item.resourceId), unresolvedBefore: operationIds,
      ledgerRow, session: ((row) => row && { sessionId: row.sessionId, epoch: row.executionEpoch, interrupted: row.interrupted })(after.state.sessions.find(row => row.sessionId === ${JSON.stringify(sessionId)})) }))
  `)
}

const parse = (text) => { try { return JSON.parse(String(text).trim().split('\n').filter(Boolean).at(-1)) } catch { return null } }
const lapse = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Key-order-insensitive structural comparison (the durable image
 * canonicalizes object keys on load; the child's stdout preserves insertion
 * order — the CONTENT is what must stay identical). */
const canon = (value) => Array.isArray(value) ? value.map(canon)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]))
  : value

/** Tool results of the CURRENT phase only (an adopted session carries the
 * earlier phases' messages too): slice after the phase's prompt marker. */
function phaseToolResults(options, marker) {
  const messages = options.messages ?? []
  const markerAt = messages.findLastIndex((message) => message.role === 'user' && textOf(message).includes(marker))
  return (markerAt === -1 ? [] : messages.slice(markerAt + 1)).filter((message) => message.role === 'tool').length
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Phase 3 (second repair): read the settled orphan, write + release a fresh
  // target — editing works again after the second revocation.
  if (history.includes(`${id}-phase3`)) {
    const toolResults = phaseToolResults(options, `${id}-phase3`)
    if (toolResults === 0) return toolCallChunks('read', { file_path: ORPHAN })
    if (toolResults === 1) return toolCallChunks('write', { file_path: FINAL, content: 'phase3\n' })
    if (toolResults === 2) return toolCallChunks('edit_lock_release', { file_path: FINAL })
    return textChunks('revoked-repair phase-3 done')
  }
  // Phase 2 (first repair): read the seed, write + release a fresh target
  // (the repair admits editing), then manufacture the second unknown op.
  if (history.includes(`${id}-phase2`)) {
    const toolResults = phaseToolResults(options, `${id}-phase2`)
    if (toolResults === 0) return toolCallChunks('read', { file_path: SEED })
    if (toolResults === 1) return toolCallChunks('write', { file_path: TARGET, content: 'phase2\n' })
    if (toolResults === 2) return toolCallChunks('edit_lock_release', { file_path: TARGET })
    if (toolResults === 3) return toolCallChunks('write', { file_path: ORPHAN, content: 'orphan\n' })
    return textChunks('revoked-repair phase-2 done')
  }
  // Phase 1: one managed write whose ack is lost after the backend completes.
  if (history.includes(`${id}-phase1`)) {
    const toolResults = phaseToolResults(options, `${id}-phase1`)
    if (toolResults === 0) return toolCallChunks('write', { file_path: SEED, content: 'seed\n' })
    return textChunks('revoked-repair phase-1 trailing')
  }
  return textChunks('unhandled revoked-repair turn')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_release') }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const fact = (record) => appendFileSync(trace, JSON.stringify(record) + '\n')
  const phase1 = await spawnHeadless(['weir-it', '--json', `${id}-phase1`], scenarioEnv(id, trace, { ...this.env, WEIR_IT_REVOKED_REPAIR_KILL: 'revoked-repair-seed.txt' }))
  const sessionId = parseJsonlLines(phase1.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
  fact({ kind: 'phase1-exit', code: phase1.code, sessionId, seedPublished: existsSync(SEED) && readFileSync(SEED, 'utf8') === 'seed\n', snapshot: snapshotState() })
  if (!sessionId) return { scenario: id, trace, code: phase1.code, stdout: phase1.stdout, stderr: phase1.stderr, sessionId }
  const revoke1 = await revokeChild(sessionId, 'it-revoked-repair-1')
  fact({ kind: 'revoke-1', value: parse(revoke1.stdout), childCode: revoke1.code, childStderr: revoke1.stderr.slice(-400) })
  // The child's short publisher lease must genuinely lapse before the next boot.
  await lapse(1500)
  const trace2 = join(root, `trace-${id}-phase2.jsonl`)
  const phase2 = await spawnHeadless(['weir-it', '--session-id', sessionId, `${id}-phase2`], scenarioEnv(id, trace2, { ...this.env, WEIR_IT_REVOKED_REPAIR_KILL: 'revoked-repair-orphan.txt' }))
  fact({ kind: 'phase2-exit', code: phase2.code, targetContent: existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null, orphanPublished: existsSync(ORPHAN) && readFileSync(ORPHAN, 'utf8') === 'orphan\n' })
  const revoke2 = await revokeChild(sessionId, 'it-revoked-repair-2')
  fact({ kind: 'revoke-2', value: parse(revoke2.stdout), childCode: revoke2.code, childStderr: revoke2.stderr.slice(-400) })
  await lapse(1500)
  const trace3 = join(root, `trace-${id}-phase3.jsonl`)
  const phase3 = await spawnHeadless(['weir-it', '--session-id', sessionId, `${id}-phase3`], scenarioEnv(id, trace3, this.env))
  // Replay self-containment: every phase-3 fact the assert consumes is copied
  // into the primary trace (the run view parses only trace + trace2).
  for (const record of readJsonl(trace3)) {
    if (record?.kind === 'session-event' && record.type === 'weir/edit-lock-maintenance' && record.data?.kind === 'revocation-repaired') fact({ kind: 'phase3-repair-audit', data: record.data })
    if (record?.kind === 'session-event' && record.type === 'user/message' && record.source === 'user') fact({ kind: 'phase3-user-message', session: record.session })
  }
  fact({ kind: 'phase3-exit', code: phase3.code, finalContent: existsSync(FINAL) ? readFileSync(FINAL, 'utf8') : null, snapshot: snapshotState() })
  return { scenario: id, trace, trace2, sessionId, code: phase3.code, stdout: phase3.stdout, stderr: `${phase1.stderr}\n${phase2.stderr}\n${phase3.stderr}\n${revoke1.stderr}\n${revoke2.stderr}` }
}

function assertRun(run) {
  const phase1 = run.records.find((r) => r.kind === 'phase1-exit')
  const revoke1 = run.records.find((r) => r.kind === 'revoke-1')
  const phase2 = run.records.find((r) => r.kind === 'phase2-exit')
  const revoke2 = run.records.find((r) => r.kind === 'revoke-2')
  const phase3 = run.records.find((r) => r.kind === 'phase3-exit')
  const snapshot = phase3?.snapshot ?? null
  run.check('phase 1 boot established the session and the lost ack left the seed published', phase1?.code === 0 && typeof run.sessionId === 'string' && phase1.sessionId === run.sessionId && phase1.seedPublished === true, JSON.stringify({ code: phase1?.code, sessionId: run.sessionId, seed: phase1?.seedPublished }))
  run.check('the lost ack durably recorded an unknown operation for the session', phase1?.snapshot?.operations?.some((op) => op.sessionId === run.sessionId && op.phase === 'unknown' && op.outcome === 'unknown') === true, JSON.stringify(phase1?.snapshot?.operations))
  // The two administrative recoveries: exact scope, online actor, growing epochs.
  const row1 = revoke1?.value ?? null
  run.check('the first online administrative recovery revoked the session over its exact unresolved scope', revoke1?.childCode === 0 && row1?.actor === 'online-administrator' && row1.idempotent === false && row1.unresolvedBefore?.length === 1 && JSON.stringify(row1.operations) === JSON.stringify(row1.unresolvedBefore) && row1.session?.interrupted === true && row1.session?.epoch === row1.revokedEpoch, JSON.stringify(row1 ?? revoke1))
  const row2 = revoke2?.value ?? null
  run.check('the second online administrative recovery re-revoked the repaired owner with a strictly greater epoch', revoke2?.childCode === 0 && row2?.revokedEpoch > row1?.revokedEpoch && row2.unresolvedBefore?.length === 1 && row2.session?.epoch === row2.revokedEpoch, JSON.stringify({ row1: row1?.revokedEpoch, row2: row2?.revokedEpoch }))
  // Phase 2: one genuine user message silently repaired the revocation.
  run.check('a genuine user message arrived in the revoked session', run.records2.some((r) => r.kind === 'session-event' && r.type === 'user/message' && r.source === 'user' && r.session === run.sessionId), JSON.stringify(run.records2.filter((r) => r.type === 'user/message')))
  const repairs2 = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'weir/edit-lock-maintenance' && r.data?.kind === 'revocation-repaired')
  run.check('the first repair was audited with trigger auto and an epoch advance past the revokedEpoch', repairs2.length === 1 && repairs2[0].data?.owner === run.sessionId && repairs2[0].data?.trigger === 'auto' && repairs2[0].data?.fromEpoch === row1?.revokedEpoch && repairs2[0].data?.toEpoch > row1?.revokedEpoch, JSON.stringify(repairs2))
  run.check('no automatic dead-process settlement fired beside the explicit recovery', run.records2.some((r) => r.kind === 'session-event' && r.type === 'weir/edit-lock-maintenance' && r.data?.kind === 'automatic-recovery') === false, JSON.stringify(run.records2.filter((r) => r.type === 'weir/edit-lock-maintenance')))
  const text2 = run.requests2.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`).join('\n')
  run.check('phase 2 read → write → release succeeded without any manual Continue', phase2?.code === 0 && phase2.targetContent === 'phase2\n' && text2.includes('seed') && text2.includes('Released'), `code=${phase2?.code} target=${JSON.stringify(phase2?.targetContent)} :: ${text2.slice(-600)}`)
  run.check('phase 2 manufactured the second unknown operation', phase2?.orphanPublished === true, JSON.stringify(phase2))
  // Phase 3: the second revocation was repaired the same way.
  run.check('a genuine user message arrived for the second repair', run.records.some((r) => r.kind === 'phase3-user-message' && r.session === run.sessionId), 'no phase-3 user message fact')
  const repairs3 = run.records.filter((r) => r.kind === 'phase3-repair-audit')
  run.check('the second repair was audited with trigger auto and an epoch advance past the second revokedEpoch', repairs3.length === 1 && repairs3[0].data?.owner === run.sessionId && repairs3[0].data?.trigger === 'auto' && repairs3[0].data?.fromEpoch === row2?.revokedEpoch && repairs3[0].data?.toEpoch > row2?.revokedEpoch, JSON.stringify(repairs3))
  run.check('phase 3 edited again after the second repair', phase3?.code === 0 && phase3.finalContent === 'phase3\n', JSON.stringify({ code: phase3?.code, final: phase3?.finalContent }))
  // The durable image: append-only ledger, strictly growing revokedEpochs, the
  // session's epoch past both, two server-minted auto requestIds, image valid
  // (both post-repair boots opened and validated it).
  run.check('the ledger holds exactly the two online recoveries with strictly increasing revokedEpochs', snapshot?.adminRecoveries?.length === 2
    && snapshot.adminRecoveries[0].recoveryId === 'it-revoked-repair-1' && snapshot.adminRecoveries[1].recoveryId === 'it-revoked-repair-2'
    && snapshot.adminRecoveries.every((row) => row.actor === 'online-administrator' && row.owner === run.sessionId)
    && snapshot.adminRecoveries[1].revokedEpoch > snapshot.adminRecoveries[0].revokedEpoch, JSON.stringify(snapshot?.adminRecoveries))
  run.check('the repair never rewrote the first disposition (append-only ledger row byte-identical)', JSON.stringify(canon(snapshot?.adminRecoveriesRaw?.[0])) === JSON.stringify(canon(row1?.ledgerRow)), JSON.stringify({ final: snapshot?.adminRecoveriesRaw?.[0], recorded: row1?.ledgerRow }))
  run.check('the session epoch advanced past every revokedEpoch and no lock survived', snapshot?.sessions?.some((s) => s.sessionId === run.sessionId && s.interrupted === true && s.epoch > snapshot.adminRecoveries[1].revokedEpoch) === true && snapshot?.locks?.some((lock) => lock.owner === run.sessionId) === false, JSON.stringify({ sessions: snapshot?.sessions, locks: snapshot?.locks }))
  run.check('both repairs used fresh server-minted auto requestIds, never a command id', snapshot?.issuedRequests?.filter((r) => r.sessionId === run.sessionId && typeof r.requestId === 'string' && r.requestId.startsWith('auto:user-message:')).length === 2 && snapshot?.issuedRequests?.some((r) => typeof r.requestId === 'string' && r.requestId.startsWith('command:')) !== true, JSON.stringify(snapshot?.issuedRequests))
  run.check('both unknown outcomes stay in history', snapshot?.operations?.filter((op) => op.sessionId === run.sessionId && op.phase === 'unknown' && op.outcome === 'unknown').length === 2, JSON.stringify(snapshot?.operations))
  run.check('the audit JSONL mirror carries both repair records for this owner', (() => {
    const mirrorPath = join(run.ws, '.weir', 'audit.jsonl')
    if (!existsSync(mirrorPath)) return false
    const rows = readFileSync(mirrorPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    return rows.filter((row) => row.type === 'weir/edit-lock-maintenance' && row.data?.kind === 'revocation-repaired' && row.data?.owner === run.sessionId && row.data?.trigger === 'auto').length === 2
  })(), 'mirror rows missing')
  run.check('phase 3 exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt: `${id}-phase1`, env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_REVOKED_REPAIR: '1' }, decide, observe, run, assert: assertRun }
