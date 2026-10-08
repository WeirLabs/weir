// Scenario: editlock-recovery-ux — the stuck-lock recovery UX story
// (openspec edit-lock-recovery-ux, D1–D4). Phase 1 boots an ordinary session
// that creates and releases a target, establishing the authority. A child
// process then manufactures the incident: a foreign session (identity-less
// incarnation — stands in for the idle-but-alive holder whose process can
// never be proven dead) acquires the file and dies inside the publish hook,
// leaving a retained lock plus an unresolved publication fence. The "panel"
// child then opens the authority read-only-inspection-first: the REAL client
// chunk classifies the blocked row (file, holder, holder state, force-release
// scope) without any manual trigger, observes the bare unlock refusal the
// incident showed, settles lock + fence with ONE adminRecoverOnline call
// carrying the chunk-computed confirmation, and proves another session
// acquires the file immediately. A third child manufactures an owner whose
// preconditions fail (a committed prepared operation) and asserts the
// diagnosis names the failing precondition instead of staying silent.
// Phase 2 is a fresh headless boot: another session edits the target file
// right away, and the ledger/authority facts pin the outcomes.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock-recovery-ux'
const WS = join(IT_ROOT, 'ws')
const AUTHORITY = join(WS, '.weir', 'edit-lock-recovery-ux')
const RESERVATION = join(WS, '.weir', '.edit-lock-recovery-ux.publisher-reservation')
const TARGET = join(WS, 'recovery-ux-target.txt')
const TARGET2 = join(WS, 'recovery-ux-unmet.txt')
const NODE = process.env.WEIR_IT_NODE ?? '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
const HARNESS_SRC = new URL('../../../weir-harness/src/', import.meta.url).pathname
const HARNESS_TEST = new URL('../../../weir-harness/test/', import.meta.url).pathname
const REASON_PREPARED = 'The owner still has a prepared operation; recover to stable unknown history before an administrative override.'

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

/** The foreign stuck session: acquires the target and dies inside the publish
 * hook, leaving the retained lock and the unresolved publication fence. */
function manufactureForeignStuck() {
  return runChild(`
    import { writeFile } from 'node:fs/promises'
    import { openEditLockStore } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/store.js`)}
    import { recoverEditLockManager } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/manager.js`)}
    import { reservePublisher } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/reservation.js`)}
    import { createLiveness } from ${JSON.stringify(`${HARNESS_SRC}/capabilities/store/liveness.js`)}
    const liveness = createLiveness()
    await reservePublisher(${JSON.stringify(AUTHORITY)}, { liveness, leaseMs: 1000, renewMs: 250 })
    const store = await openEditLockStore({ directory: ${JSON.stringify(AUTHORITY)}, domainId: ${JSON.stringify(WS)}, mode: 'recover' })
    // Identity-less incarnation: stands in for the incident's idle-but-alive
    // holder — never auto-settled, only the explicit administrative recovery.
    const manager = await recoverEditLockManager({ store, managerIncarnation: 'it-ux-foreign' })
    const execution = await manager.openSession('it-ux-foreign')
    const token = await manager.acquire(execution, ${JSON.stringify(TARGET)})
    const ready = await manager.prepare(execution, {
      operationId: 'it-ux-foreign-op', tool: 'write', filePath: ${JSON.stringify(TARGET)}, cwd: ${JSON.stringify(WS)},
      args: {}, content: 'foreign\\n', effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'update', resourceId: ${JSON.stringify(TARGET)}, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'observed' } },
    }, {
      validate() {},
      publish: async () => { await writeFile(${JSON.stringify(TARGET)}, 'foreign\\n'); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}) },
      identify: () => ${JSON.stringify(TARGET)},
    })
    await manager.commit(ready.submission)
  `)
}

/** The panel: read-only inspection → REAL chunk diagnosis → the bare unlock
 * refusal → one adminRecoverOnline with the chunk-computed confirmation →
 * another session acquires the file immediately. */
function runPanelSettle() {
  return runChild(`
    import { writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    import { openEditLockStore } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/store.js`)}
    import { recoverEditLockManager } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/manager.js`)}
    import { reservePublisher } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/reservation.js`)}
    import { createLiveness } from ${JSON.stringify(`${HARNESS_SRC}/capabilities/store/liveness.js`)}
    import { summarizeAuthorityImage } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/inspect.js`)}
    import { recoveryConfirmation } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/admin-recovery.js`)}
    import { loadClientChunk } from ${JSON.stringify(`${HARNESS_TEST}/helpers/load-client-chunk.js`)}
    const liveness = createLiveness()
    await reservePublisher(${JSON.stringify(AUTHORITY)}, { liveness, leaseMs: 1000, renewMs: 250 })
    const store = await openEditLockStore({ directory: ${JSON.stringify(AUTHORITY)}, domainId: ${JSON.stringify(WS)}, mode: 'recover' })
    const writeBackup = async (file, bytes) => { await writeFile(join(${JSON.stringify(AUTHORITY)}, file), bytes) }
    // No liveness: the recovery open must NOT auto-settle (the panel path is
    // the only settlement), and it maps publishing → unknown, interrupts all
    // sessions and retains the lock — exactly the incident state.
    const manager = await recoverEditLockManager({ store, managerIncarnation: 'it-ux-panel', root: ${JSON.stringify(WS)}, writeBackup })
    const requireStub = (name) => {
      if (name === 'react') return { Component: class {} }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      throw new Error('unexpected require ' + name)
    }
    const { editLockRecovery } = (await loadClientChunk('lib/client.edit-lock-maintenance.js', requireStub)).exports
    const diagnosis = editLockRecovery.recoveryDiagnosis(${JSON.stringify(WS)}, summarizeAuthorityImage(store.snapshot()))
    const row = diagnosis.blocked.find((entry) => entry.resourceId === ${JSON.stringify(TARGET)})
    const candidate = diagnosis.candidates.find((entry) => entry.owner === 'it-ux-foreign')
    const lock = store.snapshot().state.locks.find((entry) => entry.resourceId === ${JSON.stringify(TARGET)})
    // The bare refusal the incident showed, observed BEFORE the settle.
    const unlockRefusal = await manager.adminUnlock(${JSON.stringify(TARGET)}, lock.generation).then(() => null, (error) => String(error?.message ?? error))
    const input = { owner: candidate.owner, expectedRevision: candidate.scope.expectedRevision,
      operationIds: candidate.scope.operationIds, recoveryId: 'it-ux-panel-1',
      reason: 'Integration scenario: the operator reviewed the displayed scope and accepted the displayed late-writer risk.',
      acceptLateWriterRisk: true, confirmation: candidate.confirmation }
    const settle = await manager.adminRecoverOnline(input)
    const verifyExecution = await manager.openSession('it-ux-verify')
    const admitted = await manager.acquire(verifyExecution, ${JSON.stringify(TARGET)})
    // Proving editability must not leave the file locked: release it so the
    // phase-2 session acquires it through the ordinary path.
    await manager.release(admitted)
    const afterDiagnosis = editLockRecovery.recoveryDiagnosis(${JSON.stringify(WS)}, summarizeAuthorityImage(store.snapshot()))
    await manager.close()
    console.log(JSON.stringify({
      blockedRow: row ?? null,
      candidateScope: candidate?.scope ?? null,
      confirmationMatches: candidate?.confirmation === recoveryConfirmation(candidate.scope),
      unlockRefusal,
      settle: { revision: settle.revision, idempotent: settle.idempotent, actor: settle.record.actor, releasedLocks: settle.record.releasedLocks.map((entry) => entry.resourceId) },
      verifyAcquiredGeneration: admitted.generation,
      afterBlocked: afterDiagnosis.blocked.length,
      afterUnmet: afterDiagnosis.unmet.length,
    }))
  `)
}

/** The unmet owner: a committed prepared operation (never dispatched) plus a
 * retained lock — the panel must NAME the failing precondition. */
function runUnmetManufacture() {
  return runChild(`
    import { openEditLockStore } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/store.js`)}
    import { recoverEditLockManager } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/manager.js`)}
    import { reservePublisher } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/reservation.js`)}
    import { createLiveness } from ${JSON.stringify(`${HARNESS_SRC}/capabilities/store/liveness.js`)}
    import { summarizeAuthorityImage } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/inspect.js`)}
    import { loadClientChunk } from ${JSON.stringify(`${HARNESS_TEST}/helpers/load-client-chunk.js`)}
    const liveness = createLiveness()
    await reservePublisher(${JSON.stringify(AUTHORITY)}, { liveness, leaseMs: 1000, renewMs: 250 })
    const store = await openEditLockStore({ directory: ${JSON.stringify(AUTHORITY)}, domainId: ${JSON.stringify(WS)}, mode: 'recover' })
    const manager = await recoverEditLockManager({ store, managerIncarnation: 'it-ux-c' })
    const execution = await manager.openSession('it-ux-c')
    const token = await manager.acquire(execution, ${JSON.stringify(TARGET2)})
    const ready = await manager.prepare(execution, {
      operationId: 'it-ux-c-op', tool: 'write', filePath: ${JSON.stringify(TARGET2)}, cwd: ${JSON.stringify(WS)},
      args: {}, content: 'never\\n', effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'update', resourceId: ${JSON.stringify(TARGET2)}, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'observed' } },
    }, { validate() {}, publish: async () => { throw new Error('never dispatched') }, identify: () => ${JSON.stringify(TARGET2)} })
    if (ready.kind !== 'ready') throw new Error('prepare did not return ready')
    await manager.cancel(execution)
    const requireStub = (name) => {
      if (name === 'react') return { Component: class {} }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      throw new Error('unexpected require ' + name)
    }
    const { editLockRecovery } = (await loadClientChunk('lib/client.edit-lock-maintenance.js', requireStub)).exports
    const diagnosis = editLockRecovery.recoveryDiagnosis(${JSON.stringify(WS)}, summarizeAuthorityImage(store.snapshot()))
    const preparedPhase = manager.history('it-ux-c', 'it-ux-c-op')?.phase ?? null
    await manager.close()
    console.log(JSON.stringify({ preparedPhase, unmet: diagnosis.unmet }))
  `)
}

function snapshotState() {
  const path = join(AUTHORITY, 'snapshot.json')
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null
  return state && {
    sessions: state.sessions?.map((session) => ({ sessionId: session.sessionId, interrupted: session.interrupted, epoch: session.executionEpoch })),
    locks: state.locks?.map((lock) => ({ resourceId: lock.resourceId, owner: lock.owner, generation: lock.generation, status: lock.status })),
    operations: state.operations?.map((op) => ({ sessionId: op.sessionId, operationId: op.operationId, phase: op.phase, outcome: op.outcome?.kind ?? null })),
    adminRecoveries: state.adminRecoveries?.map((row) => ({ owner: row.owner, actor: row.actor, operations: row.operations?.map((item) => item.operationId) })),
  }
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const toolResults = (options.messages ?? []).filter((message) => message.role === 'tool').length
  // Phase 2: the settled target is editable by ANOTHER session immediately.
  // An existing file needs the original-version guard, which hash_edit carries
  // (a plain write would refuse); the read provides the anchor.
  if (history.includes(`${id}-phase2`)) {
    if (toolResults === 0) return toolCallChunks('edit_lock_acquire', { file_path: TARGET })
    if (toolResults === 1) return toolCallChunks('read', { file_path: TARGET })
    if (toolResults === 2) {
      const anchor = /1#([ZPMQVRWSNKTXJBYH]{2})\| foreign/.exec(history)
      if (anchor) return toolCallChunks('hash_edit', { file_path: TARGET, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'recovered' }] })
      return textChunks('unhandled recovery-ux anchor')
    }
    if (toolResults === 3) return toolCallChunks('edit_lock_release', { file_path: TARGET })
    return textChunks('recovery-ux phase-2 done')
  }
  // Phase 1: an ordinary write + release establishes the authority.
  if (history.includes(`${id}-phase1`)) {
    if (toolResults === 0) return toolCallChunks('write', { file_path: TARGET, content: 'phase1\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_release', { file_path: TARGET })
    return textChunks('recovery-ux phase-1 done')
  }
  return textChunks('unhandled recovery-ux turn')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const phase1 = await spawnHeadless(['weir-it', '--json', `${id}-phase1`], scenarioEnv(id, trace, this.env))
  const fact1 = (record) => appendFileSync(trace, JSON.stringify(record) + '\n')
  fact1({ kind: 'phase1-exit', code: phase1.code })
  const foreign = await manufactureForeignStuck()
  fact1({ kind: 'foreign-facts', signal: foreign.signal,
    orphanPublished: existsSync(TARGET) && readFileSync(TARGET, 'utf8') === 'foreign\n',
    reservationLeaked: existsSync(RESERVATION) })
  // Each child reserves with a 1s lease; the next child must let the expired
  // lease lapse so the death-proof takeover (never a second publisher) reclaims it.
  const lapse = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  await lapse(1500)
  const panel = await runPanelSettle()
  writeFileSync(TARGET2, 'unmet\n')
  await lapse(1500)
  const unmetChild = await runUnmetManufacture()
  // The short publisher leases must genuinely lapse before the fresh boot.
  await lapse(2500)
  const trace2 = join(root, `trace-${id}-phase2.jsonl`)
  const phase2 = await spawnHeadless(['weir-it', '--json', `${id}-phase2`], scenarioEnv(id, trace2, this.env))
  const snapshot = snapshotState()
  const parse = (text) => { try { return JSON.parse(String(text).trim().split('\n').filter(Boolean).at(-1)) } catch { return null } }
  const fact2 = (record) => appendFileSync(trace2, JSON.stringify(record) + '\n')
  fact2({ kind: 'panel-facts', value: parse(panel.stdout), childCode: panel.code, childStderr: panel.stderr.slice(-400) })
  fact2({ kind: 'unmet-facts', value: parse(unmetChild.stdout), childCode: unmetChild.code, childStderr: unmetChild.stderr.slice(-400) })
  fact2({ kind: 'phase2-facts', code: phase2.code,
    targetContent: existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null,
    reservationReleased: !existsSync(RESERVATION),
    snapshot })
  return { scenario: id, trace, trace2, code: phase2.code, stdout: phase2.stdout, stderr: `${phase1.stderr}\n${foreign.stderr}\n${panel.stderr}\n${unmetChild.stderr}\n${phase2.stderr}` }
}

function assertRun(run) {
  const ws = run.ws
  const foreignFacts = run.records.find((r) => r.kind === 'foreign-facts')
  const panelFacts = run.records2.find((r) => r.kind === 'panel-facts')
  const unmetFacts = run.records2.find((r) => r.kind === 'unmet-facts')
  const phase2Facts = run.records2.find((r) => r.kind === 'phase2-facts')
  const snapshot = phase2Facts?.snapshot ?? null
  run.check('phase 1 established the authority and exited cleanly', run.records.find((r) => r.kind === 'phase1-exit')?.code === 0, JSON.stringify(run.records.find((r) => r.kind === 'phase1-exit')))
  run.check('the foreign child died inside the publish hook, leaving the half-published file and the leaked reservation', foreignFacts?.signal === 'SIGKILL' && foreignFacts?.orphanPublished === true && foreignFacts?.reservationLeaked === true, JSON.stringify(foreignFacts))
  // The panel auto-lists the blocked row without any manual step: the
  // inspection + the REAL chunk classification ran in the child.
  const panel = panelFacts?.value ?? null
  run.check('the panel classified the blocked row: file, holder, holder state, force-release scope', panelFacts?.childCode === 0 && panel?.blockedRow?.resourceId === TARGET
    && panel.blockedRow.owner === 'it-ux-foreign' && panel.blockedRow.lockStatus === 'user-interrupted'
    && panel.blockedRow.fence === true && panel.blockedRow.interrupted === true, JSON.stringify(panel))
  run.check('the force-release scope matches the chunk-computed confirmation byte-for-byte', panel?.confirmationMatches === true
    && panel.candidateScope?.owner === 'it-ux-foreign' && JSON.stringify(panel.candidateScope?.operationIds) === '["it-ux-foreign-op"]', JSON.stringify(panel?.candidateScope))
  run.check('the incident bare refusal was observed before the settle', typeof panel?.unlockRefusal === 'string' && panel.unlockRefusal.includes('unresolved publication fence: retained-ownership'), JSON.stringify(panel?.unlockRefusal))
  run.check('one online administrative transaction settled the fence, released the lock and revoked the owner', panel?.settle?.actor === 'online-administrator'
    && panel.settle.releasedLocks?.includes(TARGET) === true && panel.settle.idempotent === false, JSON.stringify(panel?.settle))
  run.check('another session acquires the file immediately after the one-click settle', panel?.verifyAcquiredGeneration === 3, JSON.stringify(panel?.verifyAcquiredGeneration))
  run.check('the settled owner leaves no blocked row and no unmet entry', panel?.afterBlocked === 0 && panel?.afterUnmet === 0, JSON.stringify({ afterBlocked: panel?.afterBlocked, afterUnmet: panel?.afterUnmet }))
  // The unmet zone names the failing precondition instead of staying silent.
  const unmet = unmetFacts?.value ?? null
  run.check('the prepared-owner diagnosis names the failing precondition', unmetFacts?.childCode === 0 && unmet?.preparedPhase === 'prepared'
    && unmet.unmet?.some((entry) => entry.owner === 'it-ux-c' && entry.reason === REASON_PREPARED && entry.rows.some((row) => row.resourceId === TARGET2)) === true, JSON.stringify(unmet))
  // Phase 2: the file is editable by another session and the ledger is exact.
  run.check('phase 2 edited the settled file immediately', phase2Facts?.targetContent === 'recovered\n', JSON.stringify(phase2Facts?.targetContent))
  run.check('the ledger holds exactly one online administrative recovery for the foreign owner', snapshot?.adminRecoveries?.length === 1
    && snapshot.adminRecoveries[0].actor === 'online-administrator' && snapshot.adminRecoveries[0].owner === 'it-ux-foreign'
    && JSON.stringify(snapshot.adminRecoveries[0].operations) === '["it-ux-foreign-op"]', JSON.stringify(snapshot?.adminRecoveries))
  run.check('the foreign owner holds no lock and stays interrupted; the unmet owner keeps its retained lock', snapshot?.locks?.some((lock) => lock.owner === 'it-ux-foreign') === false
    && snapshot?.locks?.some((lock) => lock.owner === 'it-ux-c' && lock.resourceId === TARGET2 && lock.status === 'user-interrupted') === true, JSON.stringify(snapshot?.locks))
  run.check('the unknown outcome stays in history', snapshot?.operations?.some((op) => op.operationId === 'it-ux-foreign-op' && op.phase === 'unknown' && op.outcome === 'unknown') === true, JSON.stringify(snapshot?.operations))
  run.check('the publisher reservation was reclaimed on the fresh boot', phase2Facts?.reservationReleased === true, 'reservation retained')
  run.check('phase 2 exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-600)}`)
}

export default { id, prompt: `${id}-phase1`, env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_STOP_BOUNDARY: 'recovery-ux' }, decide, observe, run, assert: assertRun }
