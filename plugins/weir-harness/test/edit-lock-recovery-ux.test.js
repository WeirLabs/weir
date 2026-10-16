// Edit Lock recovery UX (openspec edit-lock-recovery-ux, D1–D4; the recovery
// derivation moved to the host in edit-lock-recovery-proposals): the panel
// path is exercised end to end at the domain level — the read-only inspection
// carries the server-computed recovery proposals, a proposal's confirmation
// is accepted unchanged by the adminRecoverOnline transaction, and the
// /edit-lock unlock fence refusal carries the maintenance-panel guidance.
// No arbitration semantics, preconditions, ledger formats or offline paths
// are touched: every assertion below drives the existing surfaces.
import { it } from './helpers.js'
import { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { ONLINE_RECOVERY_ACTOR } from '../src/edit-lock/admin-ledger.js'
import { openEditLockRuntime } from '../src/edit-lock/runtime.js'
import { inspectAuthority } from '../src/edit-lock/maintenance.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { localDomain } from '../src/edit-lock/domain.js'
import { createEditLockPlugin } from '../src/edit-lock/index.js'

const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }
const roots = []
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })
it('panel path: the auto-listed blocked row settles the lock and the fence with one server-computed confirmation', async () => {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-recovery-ux-')))
  roots.push(root)
  // The production authority layout, so the maintenance inspector reads it.
  const directory = join(root, '.weir', 'edit-lock')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'README.md')
  await writeFile(target, 'original')
  const runtime = await openEditLockRuntime({ directory, root, domainId: root, mode: 'create', fs: stubFs, assertExclusive() {} })
  const audits = []
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, { onAdminRecovery: info => audits.push(info) })
  const domain = localDomain(lifecycle, undefined)
  try {
    const victim = { id: 'idle-holder' }
    const operator = { id: 'operator' }
    await domain.start(victim)
    await domain.start(operator)
    // The incident shape: a foreign lock plus an unresolved publication fence
    // on the same file, owner interrupted — manufactured through the running
    // composition (no restart, no offline path).
    const status = runtime.control.status()
    const victimExecution = { managerIncarnation: status.managerIncarnation, sessionId: 'idle-holder', executionEpoch: 1 }
    const operatorExecution = { managerIncarnation: status.managerIncarnation, sessionId: 'operator', executionEpoch: 1 }
    const token = await runtime.control.acquire(victimExecution, target)
    const request = { operationId: 'op-unknown', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
      effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
    const ready = await runtime.control.prepare(victimExecution, request, {
      validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target,
    })
    await assert.rejects(runtime.control.commit(ready.submission), /unknown writer outcome/)
    await assert.rejects(runtime.control.acquire(operatorExecution, target), /unresolved publication fence/)
    await runtime.control.cancel(victimExecution)

    // The bare refusal the incident showed: no next-step guidance at the domain
    // level (the guidance belongs to the command layer, asserted below).
    await assert.rejects(runtime.control.adminUnlock(target, token.generation), /unresolved publication fence: retained-ownership/)

    // Panel open: the read-only inspection carries the server proposals.
    const inspected = inspectAuthority(root)
    assert.equal(inspected.presence, 'valid')
    const proposals = inspected.recoveryProposals
    assert.equal(proposals.schemaVersion, 1)
    assert.equal(proposals.revision, inspected.snapshot.revision)
    assert.equal(proposals.candidates.length, 1)
    assert.equal(proposals.candidates[0].owner, 'idle-holder')
    assert.deepEqual(proposals.candidates[0].scope, { root, owner: 'idle-holder', expectedRevision: inspected.snapshot.revision, operationIds: ['op-unknown'] })
    // The proposal confirmation is byte-equal to the manager's own algorithm
    // (the same function, exercised against this live image).
    assert.equal(proposals.candidates[0].confirmation, recoveryConfirmation(proposals.candidates[0].scope))
    // The blocked zone row: file, holder, holder state, one primary action.
    assert.equal(proposals.blocked.length, 1)
    assert.equal(proposals.blocked[0].resourceId, target)
    assert.equal(proposals.blocked[0].owner, 'idle-holder')
    assert.equal(proposals.blocked[0].lockStatus, 'user-interrupted')
    assert.equal(proposals.blocked[0].fence, true)
    assert.equal(proposals.blocked[0].interrupted, true)
    assert.equal(proposals.unmet.length, 0)

    // The one-click settle: exactly the payload the panel's Force release
    // submits (recover-online body), executed over the domain surface.
    const candidate = proposals.candidates[0]
    const recovery = { owner: candidate.owner, expectedRevision: candidate.scope.expectedRevision,
      operationIds: candidate.scope.operationIds, recoveryId: 'recovery-ux-unit-1',
      reason: 'Confirmed in the Edit Lock maintenance panel: the operator reviewed the displayed scope and accepted the displayed late-writer risk.',
      acceptLateWriterRisk: true, confirmation: candidate.confirmation }
    const result = await domain.adminRecover(operator, recovery, 'operator')
    assert.equal(result.idempotent, false)
    assert.equal(result.record.actor, ONLINE_RECOVERY_ACTOR)
    assert.equal(result.record.releasedLocks.length, 1)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].trigger, 'operator')
    // The file is editable by another session immediately, no restart.
    const admitted = await runtime.control.acquire(operatorExecution, target)
    assert.equal(admitted.generation, 2)
    // The settled owner leaves no blocked row and no unmet entry behind.
    const settled = inspectAuthority(root).recoveryProposals
    assert.equal(settled.blocked.length, 0)
    assert.equal(settled.unmet.length, 0)
  } finally {
    await domain.close()
  }
})

it('panel path: an owner with a live prepared operation is listed with the named failing precondition', async () => {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-recovery-ux-')))
  roots.push(root)
  const directory = join(root, '.weir', 'edit-lock')
  await mkdir(directory, { recursive: true })
  const target = join(root, 'prepared.txt')
  await writeFile(target, 'original')
  const runtime = await openEditLockRuntime({ directory, root, domainId: root, mode: 'create', fs: stubFs, assertExclusive() {} })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const domain = localDomain(lifecycle, undefined)
  try {
    const victim = { id: 'prepared-owner' }
    const operator = { id: 'operator' }
    await domain.start(victim)
    await domain.start(operator)
    const status = runtime.control.status()
    const victimExecution = { managerIncarnation: status.managerIncarnation, sessionId: 'prepared-owner', executionEpoch: 1 }
    const token = await runtime.control.acquire(victimExecution, target)
    // A committed prepared operation, never dispatched: the exact precondition
    // the manager refuses ("recover to stable unknown history").
    const ready = await runtime.control.prepare(victimExecution, {
      operationId: 'op-prepared', tool: 'write', filePath: target, cwd: root, args: {}, content: 'never',
      effectivePolicy: { mode: 'workspace-write' },
      target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
    }, { validate() {}, publish: async () => { throw new Error('never dispatched') }, identify: () => target })
    assert.equal(ready.kind, 'ready')
    await runtime.control.cancel(victimExecution)
    const inspected = inspectAuthority(root)
    const proposals = inspected.recoveryProposals
    // No silent missing action: the zone names the failing precondition as a
    // stable reason code (the client localizes it).
    assert.equal(proposals.candidates.length, 0)
    assert.equal(proposals.blocked.length, 0)
    assert.equal(proposals.unmet.length, 1)
    assert.equal(proposals.unmet[0].owner, 'prepared-owner')
    assert.equal(proposals.unmet[0].reason, 'prepared-outstanding')
    assert.equal(proposals.unmet[0].rows.length, 1)
    assert.equal(proposals.unmet[0].rows[0].resourceId, target)
    assert.equal(proposals.unmet[0].rows[0].lockStatus, 'user-interrupted')
    // The manager really would refuse this owner, so the explanation is not a lie.
    const refusal = await (async () => {
      const probe = { owner: 'prepared-owner', expectedRevision: inspected.snapshot.revision,
        operationIds: ['op-prepared'], recoveryId: 'prepared-case', reason: 'probe', acceptLateWriterRisk: true }
      probe.confirmation = recoveryConfirmation({ root, ...probe })
      try {
        await domain.adminRecover(operator, probe, 'operator')
        return null
      } catch (error) { return String(error?.message ?? error) }
    })()
    assert.match(refusal, /stable unknown history/)
  } finally {
    await domain.close()
  }
})

it('/edit-lock unlock fence refusal names the maintenance-panel administrative recovery path', async () => {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-recovery-ux-command-')))
  roots.push(base)
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  const target = join(root, 'a.txt')
  await writeFile(target, 'a')
  const unlockedTarget = join(root, 'b.txt')
  await writeFile(unlockedTarget, 'b')
  // Manufacture the foreign lock + unknown fence BEFORE the plugin mounts, so
  // the plugin's recovery open observes exactly the incident state.
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  const manager = createEditLockManager({ store, managerIncarnation: 'pre-owner' })
  const owner = await manager.openSession('owner')
  const token = await manager.acquire(owner, target)
  const ready = await manager.prepare(owner, {
    operationId: 'op-unknown', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
  }, { validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target })
  await assert.rejects(manager.commit(ready.submission), /unknown writer outcome/)
  await manager.cancel(owner)
  await manager.close()
  await store.close()

  const listeners = new Map()
  const provided = new Map()
  let command
  const ctx = {
    fs: stubFs,
    logger: { warn() {} },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    reflect: { provide(name, value) { provided.set(name, value) } },
    get(name) { return name === 'commands' ? { register(definition) { command = definition; return () => { command = undefined } } } : provided.get(name) },
    tools: { get(name, agent) { return agent.visible.get(name) }, register() { return () => {} } },
  }
  const stock = { write: { name: 'write', execute() {} }, edit: { name: 'edit', execute() {} } }
  const agent = { id: 'helper', visible: new Map(Object.entries(stock)), session: { header: { cwd: root } }, ctx: { tools: {
    restrict({ deny }) { for (const name of deny) if (agent.visible.get(name) === stock[name]) agent.visible.delete(name) },
    register(definition) { agent.visible.set(definition.name, definition); return () => agent.visible.delete(definition.name) },
  } } }
  const emit = async (name, ...args) => {
    let result
    for (const fn of listeners.get(name) ?? []) result = await fn(...args, async () => ({ kind: 'allow' }))
    return result
  }
  const dispose = createEditLockPlugin()(ctx, { enabled: true, root, authorityDirectory: directory })
  try {
    await emit('agent/created', { agent })
    const outcome = await command.handler({ agent, rawInput: `unlock ${target} 1`, commandId: 'c1' })
    assert.equal(outcome.kind, 'error')
    // The bare code stays (diagnosable), but the next step is named: the
    // maintenance panel's administrative recovery (template-layer English).
    assert.match(outcome.text, /unresolved publication fence: retained-ownership/)
    assert.match(outcome.text, /Settings → Edit Lock maintenance/)
    assert.match(outcome.text, /administrative recovery/)
    // Non-fence errors keep their original text (guidance only for fence refusals).
    const notLocked = await command.handler({ agent, rawInput: `unlock ${unlockedTarget} 1`, commandId: 'c2' })
    assert.equal(notLocked.kind, 'error')
    assert.doesNotMatch(notLocked.text, /Settings → Edit Lock maintenance/)
  } finally {
    await dispose()
  }
})
