// Scenario: editlock-crash-recovery — the P1+P2 crash self-heal story
// (openspec edit-lock-autonomous-recovery, design D1–D3). Phase 1 boots a
// normal session that writes and releases a target, establishing a v6
// authority whose incarnation carries the phase-1 process identity. The
// driver then manufactures a REAL crashed publisher: a plain node child
// reserves the authority with a short lease, recovers it under its own
// identity, starts a managed create and is SIGKILLed inside the publish hook —
// the publishing record, the half-published file and the expired reservation
// are all left behind. Phase 2 is a fresh headless boot: the reservation is
// reclaimed by the death-proof rule (P1), the recovery open administratively
// settles the dead incarnation's unknown in the recovery commit (P2), a
// managed create is admitted again, the unknown outcome stays in history, and
// exactly one audit record and one summary notice are produced.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock-crash-recovery'
const WS = join(IT_ROOT, 'ws')
const AUTHORITY = join(WS, '.weir', 'edit-lock-crash-recovery')
const PHASE1_TARGET = join(WS, 'crash-phase1.txt')
const ORPHAN_TARGET = join(WS, 'crash-orphan.txt')
const ADMITTED_TARGET = join(WS, 'crash-admitted.txt')
const NODE = process.env.WEIR_IT_NODE ?? '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
const HARNESS_SRC = new URL('../../../weir-harness/src/', import.meta.url).pathname

function snapshotState() {
  const path = join(AUTHORITY, 'snapshot.json')
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null
  return state && {
    version: state.version,
    sessions: state.sessions?.map(session => ({ sessionId: session.sessionId, interrupted: session.interrupted, epoch: session.executionEpoch })),
    locks: state.locks,
    operations: state.operations?.map(op => ({ sessionId: op.sessionId, operationId: op.operationId, phase: op.phase, outcome: op.outcome?.kind ?? null, origin: op.origin?.managerIncarnation ?? null })),
    incarnations: state.incarnations?.map(entry => ({ incarnation: entry.incarnation, pid: entry.process?.pid ?? null })),
    adminRecoveries: state.adminRecoveries?.map(row => ({ owner: row.owner, actor: row.actor, operations: row.operations?.map(item => item.operationId), backup: row.backup?.file ?? null })),
  }
}

/** The crashed-publisher child: reserves with a 1s lease, recovers under its
 * own process identity, then dies inside the publish hook of a managed
 * create. Resolves with the child's exit status and pid. */
function manufactureCrashedPublisher() {
  const script = `
    import { writeFile } from 'node:fs/promises'
    import { openEditLockStore } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/store.js`)}
    import { recoverEditLockManager } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/manager.js`)}
    import { reservePublisher } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/reservation.js`)}
    import { createLiveness } from ${JSON.stringify(`${HARNESS_SRC}/capabilities/store/liveness.js`)}
    const liveness = createLiveness()
    const startIdentity = await liveness.identity()
    const processIdentity = { pid: process.pid, host: liveness.host, osStart: startIdentity.osStart, bootNonce: startIdentity.bootNonce }
    await reservePublisher(${JSON.stringify(AUTHORITY)}, { liveness, leaseMs: 1000, renewMs: 250 })
    const store = await openEditLockStore({ directory: ${JSON.stringify(AUTHORITY)}, domainId: ${JSON.stringify(WS)}, mode: 'recover' })
    const manager = await recoverEditLockManager({ store, managerIncarnation: 'it-crashed-incarnation', processIdentity })
    const execution = await manager.openSession('it-crashed-session')
    const request = { operationId: 'it-crashed-op', tool: 'write', filePath: ${JSON.stringify(ORPHAN_TARGET)}, cwd: ${JSON.stringify(WS)}, args: {}, content: 'orphan\\n',
      effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'create', ancestor: ${JSON.stringify(WS)}, suffix: 'crash-orphan.txt', policy: { kind: 'createIfAbsent' } } }
    const ready = await manager.prepare(execution, request, {
      validate() {},
      publish: async () => {
        await writeFile(${JSON.stringify(ORPHAN_TARGET)}, 'orphan\\n')
        process.kill(process.pid, 'SIGKILL')
        await new Promise(() => {})
      },
      identify: () => ${JSON.stringify(ORPHAN_TARGET)},
    })
    await manager.commit(ready.submission)
  `
  return new Promise((resolvePromise, reject) => {
    const child = spawn(NODE, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('exit', (code, signal) => resolvePromise({ code, signal, pid: child.pid, stderr }))
  })
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const toolResults = (options.messages ?? []).filter(message => message.role === 'tool').length
  // Phase 2: the settled unknown no longer fences creation; write + release.
  if (history.includes(`${id}-phase2`)) {
    if (toolResults === 0) return toolCallChunks('write', { file_path: ADMITTED_TARGET, content: 'admitted\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_release', { file_path: ADMITTED_TARGET })
    return textChunks('phase-2 finished')
  }
  // Phase 1: an ordinary write + release establishes the v6 authority.
  if (history.includes(`${id}-phase1`)) {
    if (toolResults === 0) return toolCallChunks('write', { file_path: PHASE1_TARGET, content: 'phase1\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_release', { file_path: PHASE1_TARGET })
    return textChunks('phase-1 finished')
  }
  return textChunks('unhandled crash-recovery turn')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_status') }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const phase1 = await spawnHeadless(['weir-it', '--json', `${id}-phase1`], scenarioEnv(id, trace, this.env))
  const crashed = await manufactureCrashedPublisher()
  const { appendFileSync } = await import('node:fs')
  const fact = record => appendFileSync(trace, JSON.stringify(record) + '\n')
  fact({ kind: 'phase1-exit', code: phase1.code })
  fact({ kind: 'crash-facts', signal: crashed.signal, pid: crashed.pid,
    orphanPublished: existsSync(ORPHAN_TARGET) && readFileSync(ORPHAN_TARGET, 'utf8') === 'orphan\n',
    reservationLeaked: existsSync(join(WS, '.weir', '.edit-lock-crash-recovery.publisher-reservation')) })
  // The short reservation lease must genuinely lapse before the reclaim.
  await new Promise(resolve => setTimeout(resolve, 2200))
  const trace2 = join(root, `trace-${id}-phase2.jsonl`)
  const phase2 = await spawnHeadless(['weir-it', '--json', `${id}-phase2`], scenarioEnv(id, trace2, this.env))
  // Every fact the assert consumes is recorded here so the replay fixture is
  // self-contained (asserts never read the live authority or workspace).
  const snapshot = snapshotState()
  fact({ kind: 'phase2-facts', code: phase2.code,
    admitted: existsSync(ADMITTED_TARGET) ? readFileSync(ADMITTED_TARGET, 'utf8') : null,
    backupPresent: typeof snapshot?.adminRecoveries?.[0]?.backup === 'string' && existsSync(join(AUTHORITY, snapshot.adminRecoveries[0].backup)),
    reservationReleased: !existsSync(join(WS, '.weir', '.edit-lock-crash-recovery.publisher-reservation')),
    snapshot })
  return { scenario: id, trace, trace2, code: phase2.code, stdout: phase2.stdout, stderr: `${phase1.stderr}\n${phase2.stderr}\n${crashed.stderr}` }
}

function assertRun(run) {
  const ws = run.ws
  const crashFacts = run.records.find(r => r.kind === 'crash-facts')
  const phase2Facts = run.records.find(r => r.kind === 'phase2-facts')
  const snapshot = phase2Facts?.snapshot ?? null
  run.check('phase 1 boot exited cleanly and the crashed child died by SIGKILL inside the publish hook', run.records.find(r => r.kind === 'phase1-exit')?.code === 0 && crashFacts?.signal === 'SIGKILL' && typeof crashFacts?.pid === 'number', JSON.stringify({ phase1: run.records.find(r => r.kind === 'phase1-exit'), crashFacts }))
  run.check('the crash left the half-published file and the leaked reservation behind', crashFacts?.orphanPublished === true && crashFacts?.reservationLeaked === true, JSON.stringify(crashFacts))
  // The recovery itself: v6 image, the crashed incarnation registered with the
  // child's (dead) pid, one automatic ledger record, the unknown preserved.
  run.check('the authority carries a v6 image with per-incarnation process identities', snapshot?.version === 6 && Array.isArray(snapshot?.incarnations) && snapshot.incarnations.length >= 3 && snapshot.incarnations.some(entry => entry.incarnation === 'it-crashed-incarnation' && entry.pid === crashFacts.pid), JSON.stringify(snapshot?.incarnations))
  run.check('the dead incarnation\'s unknown was administratively settled by the automatic actor', snapshot?.adminRecoveries?.length === 1 && snapshot.adminRecoveries[0].actor === 'automatic-dead-process-recovery' && snapshot.adminRecoveries[0].owner === 'it-crashed-session' && JSON.stringify(snapshot.adminRecoveries[0].operations) === '["it-crashed-op"]', JSON.stringify(snapshot?.adminRecoveries))
  run.check('the unknown outcome and operation history are preserved', snapshot?.operations?.some(op => op.operationId === 'it-crashed-op' && op.phase === 'unknown' && op.outcome === 'unknown' && op.origin === 'it-crashed-incarnation') === true, JSON.stringify(snapshot?.operations))
  run.check('the crashed owner\'s locks are released and its epoch revoked', snapshot?.locks?.some(lock => lock.owner === 'it-crashed-session') === false && snapshot?.sessions?.some(s => s.sessionId === 'it-crashed-session' && s.interrupted === true) === true, JSON.stringify({ locks: snapshot?.locks, sessions: snapshot?.sessions }))
  run.check('the administrative backup artifact landed in the authority', phase2Facts?.backupPresent === true, JSON.stringify(snapshot?.adminRecoveries?.[0]?.backup))
  // Phase 2 outcomes: managed create admitted, exactly one audit, one notice.
  const text2 = run.requests2.map(r => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`).join('\n')
  run.check('a managed create is admitted again after the self-heal', phase2Facts?.admitted === 'admitted\n' && text2.includes('Created file'), text2.slice(-600))
  const audits2 = run.records2.filter(r => r.kind === 'session-event' && r.type === 'weir/edit-lock-maintenance' && r.data?.kind === 'automatic-recovery')
  run.check('exactly one automatic-recovery audit was emitted', audits2.length === 1 && audits2[0].data?.operations === 1 && JSON.stringify(audits2[0].data?.owners) === '["it-crashed-session"]', JSON.stringify(audits2))
  const mirrorPath = join(ws, '.weir', 'audit.jsonl')
  const mirrorRows = existsSync(mirrorPath) ? readFileSync(mirrorPath, 'utf8').trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) : []
  const mirrorRecoveries = mirrorRows.filter(row => row.type === 'weir/edit-lock-maintenance' && row.data?.kind === 'automatic-recovery')
  run.check('the audit JSONL mirror holds the same single record', mirrorRecoveries.length === 1, JSON.stringify(mirrorRecoveries))
  const notices = run.records2.filter(r => r.kind === 'session-event' && r.type === 'user/message' && typeof r.source === 'string' && r.source.startsWith('weir') && r.text?.includes('settled automatically'))
  run.check('exactly one summary notice reached the user', notices.length === 1 && notices[0].text.includes('1 unresolved publication(s)'), JSON.stringify(notices.map(n => ({ source: n.source, text: n.text?.slice(0, 120) }))))
  run.check('the phase-2 reservation was released on clean exit', phase2Facts?.reservationReleased === true, 'reservation retained')
  run.check('phase 2 exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt: `${id}-phase1`, env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_STOP_BOUNDARY: 'crash-recovery' }, decide, observe, run, assert: assertRun }
