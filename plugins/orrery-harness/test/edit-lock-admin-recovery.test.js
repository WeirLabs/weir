import { it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager, recoverEditLockManager } from '../src/edit-lock/manager.js'
import { recoverAuthority, recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { reservePublisher } from '../src/edit-lock/reservation.js'
import { parseSnapshot, validateImage } from '../src/edit-lock/snapshot.js'
import { administrativeState, digest } from '../src/edit-lock/admin-ledger.js'
import { registerEditLockMaintenanceEndpoints as registerEditLockMaintenance, createEditLockEvidence, inspectAuthority } from '../src/edit-lock/maintenance.js'

const lane = new URL('../../../', import.meta.url).pathname
const roots = []
after(async () => {
  for (const root of roots) {
    assert.equal(await realpath(root), root)
    assert.ok(root.startsWith(`${lane}.admin-test-`))
    await rm(root, { recursive: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(lane, '.admin-test-')))
  roots.push(root)
  const directory = join(root, '.orrery/edit-lock')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'capstore-probe.js')
  await writeFile(target, 'original')
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  const manager = createEditLockManager({ store, managerIncarnation: 'historic' })
  const execution = await manager.openSession('blocked-owner')
  const other = await manager.openSession('unrelated-owner')
  await manager.acquire(other, join(root, 'unrelated'))
  const token = await manager.acquire(execution, target)
  for (let i = 1; i < 22; i++) await manager.acquire(execution, join(root, `held-${i}`))
  const request = { operationId: 'unknown-op', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
  const ready = await manager.prepare(execution, request, { validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target })
  await assert.rejects(manager.commit(ready.submission), /unknown writer outcome/)
  await assert.rejects(manager.acquire(execution, target), /unresolved publication fence/)
  await manager.cancel(execution)
  const before = store.snapshot()
  await manager.close(); await store.close()
  const input = { root, recoveryId: 'admin-case-1', expectedRevision: before.revision, owner: execution.sessionId,
    operationIds: ['unknown-op'], reason: 'Operator accepts residual late writer risk', acceptLateWriterRisk: true }
  input.confirmation = recoveryConfirmation(input)
  return { root, directory, target, before, input, execution, request }
}

it('audited override releases the real 22-lock blocked owner without resolving or replaying unknown history', async () => {
  const f = await fixture()
  const bytes = await readFile(join(f.directory, 'snapshot.json'))
  const result = await recoverAuthority(f.input)
  assert.equal(result.revision, f.before.revision + 1)
  assert.deepEqual(await readFile(join(f.directory, result.record.backup.file)), bytes)
  assert.equal(await readFile(f.target, 'utf8'), 'original')
  const store = await openEditLockStore({ directory: f.directory, domainId: f.root, mode: 'recover' })
  const recovered = store.snapshot()
  assert.equal(recovered.state.version, 5)
  assert.deepEqual(recovered.state.operations, f.before.state.operations)
  assert.deepEqual(recovered.state.locks, f.before.state.locks.filter(l => l.owner !== 'blocked-owner'))
  assert.deepEqual(recovered.state.sessions.find(s => s.sessionId === 'unrelated-owner'), f.before.state.sessions.find(s => s.sessionId === 'unrelated-owner'))
  const inspected = inspectAuthority(f.root)
  assert.equal(inspected.presence, 'valid')
  assert.equal(inspected.snapshot.unresolved[0].admissionBlocked, false)
  assert.equal(inspected.snapshot.unresolved[0].phase, 'unknown')
  const manager = await recoverEditLockManager({ store, managerIncarnation: 'fresh' })
  const statusAfter = manager.status()
  assert.equal(statusAfter.sessions.find(s => s.sessionId === 'blocked-owner').revoked, true)
  assert.equal(statusAfter.sessions.find(s => s.sessionId === 'unrelated-owner').revoked, false)
  const revisionBeforeReceipt = store.snapshot().revision
  await assert.rejects(manager.issueExecutionReceipt(f.execution, 'late-resume-request'), /revoked/)
  assert.equal(store.snapshot().revision, revisionBeforeReceipt)
  const fresh = await manager.openSession('fresh-owner')
  const token = await manager.acquire(fresh, f.target)
  assert.equal(token.generation, 2)
  let calls = 0
  const replay = await manager.prepare(f.execution, f.request, { validate() {}, publish: async () => { calls++; return { version: 'bad' } }, identify: () => f.target })
  assert.equal(replay.kind, 'history'); assert.equal(replay.operation.phase, 'unknown'); assert.equal(calls, 0)
  await assert.rejects(manager.acquire(f.execution, f.target))
  await assert.rejects(manager.openSession(f.execution.sessionId), /revoked/)
  await assert.rejects(manager.resume(f.execution, 'old-request', {}), /revoked/)
  await assert.rejects(manager.prepare(f.execution, { ...f.request, content: 'different' }, { validate() {}, publish: async () => { calls++ } }), /ID_REUSE/)
  assert.equal(calls, 0)
  const next = await manager.prepare(fresh, { ...f.request, operationId: 'new-op', target: { ...f.request.target, generation: token.generation } }, {
    validate() {}, publish: async () => { await writeFile(f.target, 'fresh write'); return { version: 'new' } }, identify: () => f.target,
  })
  await manager.commit(next.submission)
  assert.equal(await readFile(f.target, 'utf8'), 'fresh write')
  await manager.close(); await store.close()
  const retry = await recoverAuthority(f.input)
  assert.equal(retry.idempotent, true)
})

for (const point of ['before-backup', 'backup-written', 'backup-durable', 'store:before:write', 'store:before:file-sync', 'store:before:rename']) {
  it(`failure at ${point} preserves exact old authority and target`, async () => {
    const f = await fixture(), path = join(f.directory, 'snapshot.json')
    const before = await readFile(path)
    await assert.rejects(recoverAuthority(f.input, { checkpoint(step) { if (step === point) throw new Error('injected failure') } }))
    assert.deepEqual(await readFile(path), before)
    assert.equal(await readFile(f.target, 'utf8'), 'original')
    assert.equal(parseSnapshot(before, f.root).state.locks.filter(l => l.owner === f.input.owner).length, 22)
    assert.equal((await recoverAuthority(f.input)).idempotent, false)
  })
}
for (const point of ['store:after:rename', 'store:before:directory-sync', 'store:after:directory-sync']) {
  it(`uncertain ${point} leaves one coherent audited state and idempotent retry`, async () => {
    const f = await fixture(), bytes = await readFile(join(f.directory, 'snapshot.json'))
    await assert.rejects(recoverAuthority(f.input, { checkpoint(step) { if (step === point) throw new Error('lost acknowledgement') } }), e => e.commitStatus === 'uncertain')
    const state = parseSnapshot(await readFile(join(f.directory, 'snapshot.json')), f.root).state
    assert.equal(state.adminRecoveries.length, 1)
    assert.equal(state.locks.filter(l => l.owner === f.input.owner).length, 0)
    assert.deepEqual(state.operations, f.before.state.operations)
    assert.deepEqual(await readFile(join(f.directory, state.adminRecoveries[0].backup.file)), bytes)
    assert.equal((await recoverAuthority(f.input)).idempotent, true)
  })
}
it('requires exact revision, scoped confirmation, explicit risk, complete operations and valid backup', async () => {
  const f = await fixture(), path = join(f.directory, 'snapshot.json'), bytes = await readFile(path)
  for (const patch of [{ expectedRevision: 0 }, { owner: 'unrelated-owner' }, { operationIds: ['wrong'] }, { operationIds: ['unknown-op', 'unknown-op'] }, { acceptLateWriterRisk: false }, { reason: '' }, { confirmation: 'ADMIN OVERRIDE' }, { actor: 'forged' }]) {
    const input = { ...f.input, ...patch }
    if (!Object.hasOwn(patch, 'confirmation')) input.confirmation = recoveryConfirmation(input)
    await assert.rejects(recoverAuthority(input))
    assert.deepEqual(await readFile(path), bytes)
  }
  const backup = join(f.directory, `admin-backup-${digest([f.root, f.input.recoveryId])}.json`)
  await writeFile(backup, 'wrong backup')
  await assert.rejects(recoverAuthority(f.input), /backup does not match/)
  assert.deepEqual(await readFile(path), bytes)
})
it('refuses symlink backup and corrupt authority without mutating targets', async () => {
  const f = await fixture(), path = join(f.directory, 'snapshot.json'), bytes = await readFile(path)
  const backup = join(f.directory, `admin-backup-${digest([f.root, f.input.recoveryId])}.json`)
  await symlink(f.target, backup)
  await assert.rejects(recoverAuthority(f.input), /regular authority/)
  assert.deepEqual(await readFile(path), bytes)
  await writeFile(path, 'corrupt')
  await assert.rejects(recoverAuthority(f.input))
  assert.equal(await readFile(path, 'utf8'), 'corrupt')
  assert.equal(await readFile(f.target, 'utf8'), 'original')
})
it('refuses a symlink snapshot without reading or changing its target', async () => {
  const f = await fixture(), path = join(f.directory, 'snapshot.json')
  assert.equal(await realpath(path), path)
  assert.ok(path.startsWith(`${lane}.admin-test-`))
  await rm(path)
  await symlink(f.target, path)
  await assert.rejects(recoverAuthority(f.input), /regular authority/)
  assert.equal(await readFile(f.target, 'utf8'), 'original')
})
it('never steals an existing publisher reservation and serializes concurrent recoveries', async () => {
  const f = await fixture(), bytes = await readFile(join(f.directory, 'snapshot.json'))
  const live = await reservePublisher(f.directory)
  await assert.rejects(recoverAuthority(f.input), /reserv/)
  await live.assertExclusive()
  assert.deepEqual(await readFile(join(f.directory, 'snapshot.json')), bytes)
  await live.releaseAfterQuiescence()
  let unblock, reached
  const blocked = new Promise(resolve => { unblock = resolve }), entered = new Promise(resolve => { reached = resolve })
  const first = recoverAuthority(f.input, { async checkpoint(point) { if (point === 'reserved') { reached(); await blocked } } })
  await entered
  try {
    await assert.rejects(recoverAuthority(f.input), /reserv/)
    await assert.rejects(reservePublisher(f.directory), /reserv/)
    assert.deepEqual(await readFile(join(f.directory, 'snapshot.json')), bytes)
  } finally { unblock() }
  assert.equal((await first).idempotent, false)
  assert.equal((await recoverAuthority(f.input)).idempotent, true)
})
it('ordinary writes cannot append override, alter its ledger, rewrite old history or resurrect owner', async () => {
  const f = await fixture(), result = await recoverAuthority(f.input)
  const raw = await readFile(join(f.directory, result.record.backup.file))
  const copyRoot = await realpath(await mkdtemp(join(lane, '.admin-test-'))); roots.push(copyRoot)
  await mkdir(join(copyRoot, 'store'))
  await writeFile(join(copyRoot, 'store/snapshot.json'), raw)
  const old = await openEditLockStore({ directory: join(copyRoot, 'store'), domainId: f.root, mode: 'recover' })
  await assert.rejects(old.record({ expectedRevision: f.before.revision, nextState: administrativeState(f.before.state, result.record) }), /explicit administrative/)
  await old.close()
  const store = await openEditLockStore({ directory: f.directory, domainId: f.root, mode: 'recover' })
  const snapshot = store.snapshot()
  for (const mutate of [state => { state.adminRecoveries[0].reason = 'rewritten' }, state => { state.operations[0].closeouts.push({ fake: true }) }, state => { state.sessions.find(s => s.sessionId === f.input.owner).interrupted = false }, state => { state.locks.push(f.before.state.locks.find(l => l.owner === f.input.owner)) }]) {
    const state = structuredClone(snapshot.state); mutate(state)
    await assert.rejects(store.record({ expectedRevision: snapshot.revision, nextState: state }))
  }
  await store.close()
  const state = structuredClone(snapshot.state); state.adminRecoveries[0].releasedLocks[0].unexpected = true
  assert.throws(() => validateImage(state), /schema/)
  const badBackup = structuredClone(snapshot.state); badBackup.adminRecoveries[0].backup.file = `admin-backup-${'0'.repeat(64)}.json`
  assert.throws(() => validateImage(badBackup), /backup/)
})
it('settings-plane endpoint enforces server root allowlist, exposes audited result and cold-safe mirror', async () => {
  const f = await fixture(), routes = new Map(), events = []
  const evidence = createEditLockEvidence(), mount = evidence.recordMount({ enabled: false })
  mount.recordDomain(f.root, {})
  const dispose = registerEditLockMaintenance({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } }, emit: (...event) => events.push(event) }, { evidence, candidateRoots: () => [], savedEnabled: () => false })
  const route = routes.get('/api/orrery-edit-lock/maintenance/recover')
  assert.deepEqual(route.methods, ['POST'])
  const invoke = body => route.fetch({ json: async () => body })
  assert.equal((await invoke({ ...f.input, root: '/not-a-server-derived-root' })).status, 403)
  const refused = await invoke({ ...f.input, confirmation: 'ADMIN OVERRIDE' })
  assert.equal(refused.status, 409)
  const failure = await refused.json()
  assert.equal(failure.ok, false)
  assert.equal(failure.error.commitStatus, 'not-acknowledged')
  assert.ok(!JSON.stringify(failure).includes(f.root))
  const response = await invoke(f.input), payload = await response.json()
  assert.equal(response.status, 200); assert.equal(payload.ok, true)
  assert.equal(payload.value.record.releasedLocks.length, 22)
  assert.equal(payload.value.record.actor, 'authenticated-settings-administrator')
  assert.equal(events[0][0], 'orrery/edit-lock-maintenance')
  assert.match(await readFile(join(f.root, '.orrery/audit.jsonl'), 'utf8'), /admin-override/)
  dispose(); assert.equal(routes.size, 0)
})
