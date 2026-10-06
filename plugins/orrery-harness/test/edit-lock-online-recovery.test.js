import { it } from './helpers.js'
import { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { administrativeState, LATE_WRITER_RISK, ONLINE_RECOVERY_ACTOR } from '../src/edit-lock/admin-ledger.js'
import { canonical } from '../src/edit-lock/snapshot.js'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { inspectAuthority } from '../src/edit-lock/maintenance.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { localDomain } from '../src/edit-lock/domain.js'

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }
const roots = []
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

async function fixture({ interrupt = true, extraPrepared = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orrery-online-recovery-')))
  roots.push(root)
  const directory = join(root, 'authority')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'a.txt')
  await writeFile(target, 'original')
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  /** @type {{file: string, bytes: Buffer}[]} */
  const backups = []
  const writeBackup = async (/** @type {string} */ file, /** @type {Buffer} */ bytes) => {
    backups.push({ file, bytes: Buffer.from(bytes) })
    await writeFile(join(directory, file), bytes)
  }
  const manager = createEditLockManager({ store, managerIncarnation: 'm', root, writeBackup })
  const owner = await manager.openSession('owner')
  const other = await manager.openSession('other')
  const token = await manager.acquire(owner, target)
  await manager.acquire(owner, join(root, 'held-1'))
  await manager.acquire(owner, join(root, 'held-2'))
  const request = { operationId: 'op-unknown', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
  const hooks = { validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target }
  const ready = await manager.prepare(owner, request, hooks)
  await assert.rejects(manager.commit(ready.submission), /unknown writer outcome/)
  assert.equal(manager.history('owner', 'op-unknown').phase, 'unknown')
  await assert.rejects(manager.acquire(other, target), /unresolved publication fence/)
  if (extraPrepared) {
    const second = { ...request, operationId: 'op-prepared', filePath: join(root, 'held-1'),
      target: { kind: 'update', resourceId: join(root, 'held-1'), generation: 1, policy: { kind: 'replaceIfVersion', version: 'old' } } }
    const prepared = await manager.prepare(owner, second, hooks)
    assert.equal(prepared.kind, 'ready')
    assert.equal(manager.history('owner', 'op-prepared').phase, 'prepared')
  }
  if (interrupt) await manager.cancel(owner)
  const input = { owner: 'owner', expectedRevision: store.snapshot().revision, operationIds: ['op-unknown'],
    recoveryId: 'online-case-1', reason: 'Operator accepts residual late writer risk', acceptLateWriterRisk: true }
  input.confirmation = recoveryConfirmation({ root, ...input })
  return { root, directory, target, store, manager, input, backups, request, other }
}

async function close(f) {
  await f.manager.close().catch(() => {})
  await f.store.close().catch(() => {})
}

it('settles an interrupted owner\'s unknown online in one durable commit and lifts the fence', async () => {
  const f = await fixture()
  const before = f.store.snapshot()
  const bytes = f.store.currentBytes()
  const result = await f.manager.adminRecoverOnline(f.input)
  assert.equal(result.idempotent, false)
  assert.equal(result.revision, before.revision + 1)
  assert.equal(result.record.actor, ONLINE_RECOVERY_ACTOR)
  assert.equal(result.record.risk, LATE_WRITER_RISK)
  assert.equal(result.record.releasedLocks.length, 3)
  // The owner was cancelled in the fixture: its live epoch was already 2.
  assert.equal(result.record.revokedEpoch, 3)
  assert.equal(result.record.expectedRevision, before.revision)
  assert.equal(result.record.committedRevision, before.revision + 1)
  // The backup landed durably BEFORE the commit, with the exact pre-image bytes.
  assert.deepEqual(await readFile(join(f.directory, result.record.backup.file)), bytes)
  assert.equal(f.backups.length, 1)
  assert.deepEqual(f.backups[0].bytes, bytes)
  const saved = f.store.snapshot()
  assert.equal(saved.state.adminRecoveries.length, 1)
  assert.equal(saved.state.locks.some(l => l.owner === 'owner'), false)
  assert.equal(saved.state.sessions.find(s => s.sessionId === 'owner').executionEpoch, 3)
  assert.equal(saved.state.sessions.find(s => s.sessionId === 'owner').interrupted, true)
  // Unknown outcomes and operation history are byte-identical.
  assert.deepEqual(saved.state.operations, before.state.operations)
  // The committed state is exactly the administrative fold of the record.
  assert.equal(canonical(saved.state), canonical(administrativeState(before.state, result.record)))
  // The in-memory kernel matches the durable image (no restart).
  const status = f.manager.status()
  assert.equal(status.locks.some(l => l.owner === 'owner'), false)
  assert.equal(status.sessions.find(s => s.sessionId === 'owner').revoked, true)
  assert.equal(f.manager.history('owner', 'op-unknown').phase, 'unknown')
  // Fence admission is unblocked: another session acquires and publishes.
  const token = await f.manager.acquire(f.other, f.target)
  assert.equal(token.generation, 2)
  let writes = 0
  const next = await f.manager.prepare(f.other, { ...f.request, operationId: 'op-fresh', target: { ...f.request.target, generation: token.generation } }, {
    validate() {}, publish: async () => { writes++; await writeFile(f.target, 'fresh'); return { version: 'new' } }, identify: () => f.target,
  })
  await f.manager.commit(next.submission)
  assert.equal(writes, 1)
  assert.equal(await readFile(f.target, 'utf8'), 'fresh')
  // The revoked owner stays terminal.
  await assert.rejects(f.manager.openSession('owner'), /revoked/)
  await close(f)
})

it('refuses a wrong confirmation digest without touching authority', async () => {
  const f = await fixture()
  const before = f.store.snapshot()
  assert.throws(() => f.manager.adminRecoverOnline({ ...f.input, confirmation: `ADMIN OVERRIDE ${'0'.repeat(64)}` }),
    error => error.code === 'orrery-edit-lock/confirmation-mismatch')
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(f.backups.length, 0)
  assert.equal(f.manager.status().locks.filter(l => l.owner === 'owner').length, 3)
  await close(f)
})

it('refuses an owner that is not interrupted', async () => {
  const f = await fixture({ interrupt: false })
  const before = f.store.snapshot()
  await assert.rejects(f.manager.adminRecoverOnline(f.input), /interrupted historical owner/)
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(f.backups.length, 0)
  await close(f)
})

it('refuses while any unresolved operation of the owner is not unknown', async () => {
  const f = await fixture({ extraPrepared: true })
  const before = f.store.snapshot()
  await assert.rejects(f.manager.adminRecoverOnline(f.input), /stable unknown history/)
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(f.backups.length, 0)
  assert.equal(f.manager.history('owner', 'op-prepared').phase, 'prepared')
  await close(f)
})

it('refuses an operation id set that does not match the owner\'s unresolved operations exactly', async () => {
  const f = await fixture()
  const before = f.store.snapshot()
  const wrong = { ...f.input, operationIds: ['op-unknown', 'op-other'] }
  wrong.confirmation = recoveryConfirmation({ root: f.root, ...wrong })
  await assert.rejects(f.manager.adminRecoverOnline(wrong), /every unresolved operation/)
  const missing = { ...f.input, operationIds: ['op-missing'] }
  missing.confirmation = recoveryConfirmation({ root: f.root, ...missing })
  await assert.rejects(f.manager.adminRecoverOnline(missing), /every unresolved operation/)
  assert.deepEqual(f.store.snapshot(), before)
  assert.equal(f.backups.length, 0)
  await close(f)
})

it('refuses after the authority revision moved since the confirmation', async () => {
  const f = await fixture()
  const before = f.store.snapshot()
  // An unrelated commit lands between the operator's confirmation and execution.
  await f.manager.openSession('third')
  await assert.rejects(f.manager.adminRecoverOnline(f.input), error =>
    error.code === 'orrery-edit-lock/revision-conflict' && /revision changed/.test(error.message))
  assert.deepEqual(f.store.snapshot().state.adminRecoveries ?? [], [])
  assert.equal(f.store.snapshot().state.locks.filter(l => l.owner === 'owner').length, 3)
  assert.equal(f.backups.length, 0)
  // A fresh confirmation over the new revision is admitted.
  const retry = { ...f.input, expectedRevision: f.store.snapshot().revision }
  retry.confirmation = recoveryConfirmation({ root: f.root, ...retry })
  assert.equal((await f.manager.adminRecoverOnline(retry)).idempotent, false)
  assert.notDeepEqual(f.store.snapshot(), before)
  await close(f)
})

it('idempotent retry returns the committed record without re-releasing or appending', async () => {
  const f = await fixture()
  const result = await f.manager.adminRecoverOnline(f.input)
  const after = f.store.snapshot()
  const retry = await f.manager.adminRecoverOnline(f.input)
  assert.equal(retry.idempotent, true)
  assert.equal(retry.revision, after.revision)
  assert.deepEqual(retry.record, result.record)
  assert.equal(f.backups.length, 1)
  assert.deepEqual(f.store.snapshot(), after)
  // The same recovery ID with a different request is a refusal, never a second recovery.
  const conflict = { ...f.input, reason: 'a different reason' }
  conflict.confirmation = recoveryConfirmation({ root: f.root, ...conflict })
  await assert.rejects(f.manager.adminRecoverOnline(conflict), /reused with different request/)
  assert.deepEqual(f.store.snapshot(), after)
  await close(f)
})

it('refuses in a composition without a domain root or backup writer', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orrery-online-recovery-')))
  roots.push(root)
  const directory = join(root, 'authority')
  await mkdir(directory, { recursive: true })
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  const manager = createEditLockManager({ store, managerIncarnation: 'm' })
  assert.throws(() => manager.adminRecoverOnline({ owner: 'x', expectedRevision: 0, operationIds: ['o'], recoveryId: 'r', reason: 'r', acceptLateWriterRisk: true, confirmation: 'ADMIN OVERRIDE' }),
    error => error.code === 'orrery-edit-lock/unavailable')
  await manager.close(); await store.close()
})

it('single-process composition probe: a live publisher settles its own unknown online, no restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orrery-online-composition-')))
  roots.push(root)
  // The production authority layout, so the maintenance inspector reads it.
  const directory = join(root, '.orrery', 'edit-lock')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'a.txt')
  await writeFile(target, 'original')
  const runtime = await openEditLockRuntime({ directory, root, domainId: root, mode: 'create', fs: stubFs, assertExclusive() {} })
  /** @type {any[]} */
  const audits = []
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, {
    onAdminRecovery: info => audits.push(info),
  })
  const domain = localDomain(lifecycle, undefined)
  try {
    assert.equal(domain.mode, 'publisher')
    const victim = { id: 'victim' }
    const operator = { id: 'operator' }
    await domain.start(victim)
    await domain.start(operator)
    // Manufacture the unknown through the running composition (no restart anywhere).
    const status = runtime.control.status()
    const execution = { managerIncarnation: status.managerIncarnation, sessionId: 'victim', executionEpoch: 1 }
    const token = await runtime.control.acquire(execution, target)
    const request = { operationId: 'op-composition', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
      effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
    const ready = await runtime.control.prepare(execution, request, {
      validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target,
    })
    await assert.rejects(runtime.control.commit(ready.submission), /unknown writer outcome/)
    const otherExecution = { managerIncarnation: status.managerIncarnation, sessionId: 'operator', executionEpoch: 1 }
    await assert.rejects(runtime.control.acquire(otherExecution, target), /unresolved publication fence/)
    await runtime.control.cancel(execution)
    // The maintenance panel's one click, over the domain surface.
    const revision = inspectAuthority(root).snapshot.revision
    const recovery = { owner: 'victim', expectedRevision: revision, operationIds: ['op-composition'],
      recoveryId: 'composition-case-1', reason: 'Operator accepts residual late writer risk', acceptLateWriterRisk: true }
    recovery.confirmation = recoveryConfirmation({ root, ...recovery })
    const result = await domain.adminRecover(operator, recovery, 'operator')
    assert.equal(result.idempotent, false)
    assert.equal(result.record.actor, ONLINE_RECOVERY_ACTOR)
    // The publisher-side audit hook saw the trigger session, never a payload field.
    assert.equal(audits.length, 1)
    assert.equal(audits[0].trigger, 'operator')
    assert.equal(audits[0].record.owner, 'victim')
    // No restart: the same runtime admits the fenced target immediately.
    const admitted = await runtime.control.acquire(otherExecution, target)
    assert.equal(admitted.generation, 2)
    assert.equal(runtime.control.history('victim', 'op-composition').phase, 'unknown')
    // The backup artifact is in the authority directory.
    const backup = await readFile(join(directory, result.record.backup.file))
    assert.equal(backup.length, result.record.backup.bytes)
    // The maintenance inspector reports the disposition exactly like the offline path.
    const inspected = inspectAuthority(root)
    assert.equal(inspected.snapshot.unresolved[0].admissionBlocked, false)
    assert.equal(inspected.snapshot.unresolved[0].administrativeRecoveryId, 'composition-case-1')
  } finally {
    await domain.close()
  }
})
