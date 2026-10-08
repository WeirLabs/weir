// Design D3 composition: mounting the plugin over an authority whose crashed
// incarnation left an unknown publication settles it in the recovery commit —
// one shared audit at domain open, one summary notice at the first turn, and
// admission lifted. Remounting never re-settles or re-notifies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { fixtureRoot as managementRootFor, fixtureEndpoint as endpointFor, fixtureExclude as excludeFromGit } from './helpers/edit-lock-fixtures.js'

const apply = createEditLockPlugin({ resolveRoot: managementRootFor, endpoint: endpointFor, exclude: excludeFromGit })
const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }
// A pid that cannot be alive (well above any real pid): the death proof the
// real Liveness adapter produces through ESRCH.
const DEAD_PID = 40_000_000
const deadIdentity = { pid: DEAD_PID, host: hostname(), osStart: null, bootNonce: 'crashed-boot' }

async function fixture() {
  const base = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-recovery-notice-')))
  const root = join(base, 'work')
  const directory = join(base, 'authority')
  await mkdir(root)
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  return { base, root, directory }
}

/** An authority whose previous incarnation (registered with a dead pid)
 * crashed mid-publication: one unknown operation fencing creates. */
async function crashedAuthority(root, directory) {
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  const manager = createEditLockManager({ store, managerIncarnation: 'crashed-incarnation', processIdentity: deadIdentity })
  const execution = await manager.openSession('crashed-session')
  const target = join(root, 'a.txt')
  const token = await manager.acquire(execution, target)
  const ready = await manager.prepare(execution, {
    operationId: 'crashed-op', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
  }, { validate() {}, publish: async () => { throw new Error('writer outcome lost') }, identify: () => target })
  await assert.rejects(manager.commit(ready.submission), /writer outcome lost/)
  await store.close()
}

function fakeHost(root) {
  const listeners = new Map()
  const provided = new Map()
  const agents = new Map()
  const warns = []
  const notices = []
  const audits = []
  const ctx = {
    fs: stubFs,
    logger: { warn(message) { warns.push(String(message)) } },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    emit(type, record) { audits.push({ type, record }) },
    reflect: { provide(name, value) { provided.set(name, value) } },
    get(name) {
      if (name === 'commands') return { register() { return () => {} } }
      if (name === 'agents') return agents
      if (name === 'weirSettings') return { get: () => undefined }
      return provided.get(name)
    },
    tools: { get(name, agent) { return agent.visible.get(name) }, register() { return () => {} } },
  }
  function agent(id) {
    const visible = new Map()
    const created = { id, visible, session: { header: { cwd: root } },
      inject(message) { notices.push(message) },
      ctx: { tools: {
        restrict() {},
        register(definition) { visible.set(definition.name, definition); return () => visible.delete(definition.name) },
      } } }
    agents.set(id, created)
    return created
  }
  const emit = async (name, ...args) => {
    let result
    for (const fn of listeners.get(name) ?? []) result = await fn(...args, async () => ({ kind: 'allow' }))
    return result
  }
  return { ctx, provided, agent, emit, warns, notices, audits, preStep: (agent, turn, signal) => emit('agent/pre-step', { agent, turn, signal }) }
}

test('recovery over a dead-incarnation unknown settles it: one audit, one notice at the first turn, admission lifted', async (t) => {
  const { root, directory } = await fixture()
  await crashedAuthority(root, directory)
  const host = fakeHost(root)
  const dispose = apply(host.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(() => dispose())
  const service = host.provided.get('weirEditLock')
  const agent = host.agent('s')
  await host.emit('agent/created', { agent })

  // The domain open settled the dead incarnation's unknown in the recovery
  // commit: exactly one shared audit, nothing delivered to any session yet.
  const recoveries = host.audits.filter(row => row.type === 'weir/edit-lock-maintenance' && row.record?.data?.kind === 'automatic-recovery')
  assert.equal(recoveries.length, 1)
  assert.deepEqual(recoveries[0].record.data.owners, ['crashed-session'])
  assert.equal(recoveries[0].record.data.operations, 1)
  assert.equal(host.notices.length, 0)

  // The durable image carries the automatic ledger row; admission is lifted.
  const image = JSON.parse(await readFile(join(directory, 'snapshot.json'), 'utf8')).payload.state
  assert.equal(image.version, 6)
  assert.equal(image.adminRecoveries.length, 1)
  assert.equal(image.adminRecoveries[0].actor, 'automatic-dead-process-recovery')
  assert.equal(image.operations.find(o => o.operationId === 'crashed-op').phase, 'unknown')
  assert.equal(image.locks.some(lock => lock.owner === 'crashed-session'), false)

  // The summary notice reaches exactly one agent at its first turn.
  await host.preStep(agent, {}, new AbortController().signal)
  assert.equal(host.notices.length, 1)
  assert.match(String(host.notices[0]?.content?.[0]?.text ?? host.notices[0]), /settled automatically/)
  // A second agent of the same domain gets no duplicate.
  const other = host.agent('other')
  await host.emit('agent/created', { agent: other })
  await host.preStep(other, {}, new AbortController().signal)
  assert.equal(host.notices.length, 1)

  // Editing proceeds through the ordinary managed path.
  assert.equal((await service.acquire({ agent }, { filePath: 'a.txt', cwd: root })).generation, 2)
  await dispose()

  // Remount: the revoked owner is terminal — no second settlement, no audit,
  // no notice.
  await host.emit('agent/disposed', { agent })
  const again = fakeHost(root)
  const dispose2 = apply(again.ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(() => dispose2())
  const remounted = again.agent('s2')
  await again.emit('agent/created', { agent: remounted })
  await again.preStep(remounted, {}, new AbortController().signal)
  assert.equal(again.audits.filter(row => row.type === 'weir/edit-lock-maintenance' && row.record?.data?.kind === 'automatic-recovery').length, 0)
  assert.equal(again.notices.length, 0)
  await dispose2()
})
