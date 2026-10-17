import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { createEditLockLifecycle } from '../src/edit-lock/lifecycle.js'
import { openReservedEditLockRuntime } from '../src/edit-lock/reserved-runtime.js'
import { serveEditLockEndpoint } from '../src/edit-lock/remote.js'
import { createDelegateTool } from '../src/delegate/tool.js'
import { mountSupervision } from '../src/delegate/supervision-mount.js'
import { settleDelegateEditLifecycle } from '../src/shared/delegate-edit-lifecycle.js'
import { fixtureRoot, fixtureEndpoint, fixtureExclude } from './helpers/edit-lock-fixtures.js'

const deferred = () => Promise.withResolvers()
const tick = () => new Promise(resolve => setImmediate(resolve))
const flush = async () => { for (let i = 0; i < 12; i++) await tick() }

test('supervision without Edit Lock ignores duplicate quiescence from an earlier activation', async () => {
  const handlers = new Map(), agents = new Map(), lanes = []
  const parent = { id: 'parent', session: { header: {} } }
  const first = { id: 'child' }, second = { id: 'child' }
  agents.set('child', first)
  const ctx = { on: (name, handler) => handlers.set(name, handler), get: name => name === 'agents' ? agents : undefined,
    subagents: { listChildren: async () => [], sendMessage: async () => {}, interrupt() {} } }
  const mount = mountSupervision({ ctx, audit() {}, supervisionNow: () => ({}), onChildSettled: id => lanes.push(id) })
  const coordinator = await mount.coordinatorFor(parent)
  coordinator.registerMember({ id: 'child', name: 'child', group: 'g' })
  coordinator.noteAssistantText('child', 'STATUS: blocked\nREPORT: wait')
  await coordinator.onTurnEnd('child', { kind: 'completed' })
  handlers.get('subagent/end')({ id: 'child', runId: 'old', stopReason: 'completed' })
  await coordinator.resume('child', 'ready')
  agents.set('child', second)
  handlers.get('agent/created')({ agent: second })
  coordinator.noteAssistantText('child', 'STATUS: completed\nREPORT: done')
  await coordinator.onTurnEnd('child', { kind: 'completed' })
  handlers.get('subagent/end')({ id: 'child', runId: 'old', stopReason: 'completed' })
  handlers.get('agent/disposed')({ agent: first })
  await flush(); assert.deepEqual(lanes, [])
  handlers.get('subagent/end')({ id: 'child', runId: 'new', stopReason: 'completed' })
  await flush(); assert.deepEqual(lanes, ['child'])
})

// Real remote domain/dispatcher; only the publisher's disposition ACK is held.
// emit deliberately never joins listeners, matching Host Event inspection.
async function fixture(t) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'weir-disposition-')))
  const directory = join(root, 'authority')
  await mkdir(directory)
  await writeFile(join(root, 'a.txt'), 'a')
  const fs = { async resolve() { throw Error('unused') }, async writeText() { throw Error('unused') } }
  const runtime = await openReservedEditLockRuntime({ root, directory, domainId: root, mode: 'create', fs })
  const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
  const entered = deferred(), ack = deferred()
  let disposals = 0
  const server = await serveEditLockEndpoint({ ...lifecycle, async dispose(agent) {
    disposals++; entered.resolve(); await ack.promise; return lifecycle.dispose(agent)
  } }, fixtureEndpoint(directory), new WeakMap())
  const listeners = new Map(), agents = new Map(), provided = new Map(), warnings = []
  const ctx = {
    fs, on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    get(name) { return name === 'agents' ? agents : provided.get(name) },
    reflect: { provide(name, value) { provided.set(name, value) } },
    tools: { get(name, agent) { return agent.visible.get(name) }, register() { return () => {} } },
    logger: { warn: message => warnings.push(message) },
    subagents: { listChildren: async () => [], sendMessage: async () => {}, interrupt() {} },
  }
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  const dispatch = async (name, ...args) => { for (const fn of listeners.get(name) ?? []) await fn(...args) }
  const apply = createEditLockPlugin({ resolveRoot: fixtureRoot, endpoint: fixtureEndpoint, exclude: fixtureExclude })
  const dispose = apply(ctx, { enabled: true, root, authorityDirectory: directory })
  t.after(async () => { ack.resolve(); await dispose(); await server.close(); await lifecycle.close() })
  async function agent(id) {
    const stock = { write: { name: 'write', execute() {} }, edit: { name: 'edit', execute() {} } }
    const visible = new Map(Object.entries(stock))
    const followups = [], followed = deferred()
    const result = { id, session: { id, header: { cwd: root, delegationDepth: id === 'parent' ? 0 : 1 } }, visible,
      followup: message => { followups.push(message); followed.resolve(message) }, inject() {}, followups, followed,
      ctx: { tools: { restrict({ deny }) { for (const name of deny) if (visible.get(name) === stock[name]) visible.delete(name) }, register(def) { visible.set(def.name, def); return () => visible.delete(def.name) }, guard() {} } } }
    agents.set(id, result)
    await dispatch('agent/created', { agent: result })
    return result
  }
  const parent = await agent('parent'), child = await agent('child')
  const service = provided.get('weirEditLock')
  await service.acquire({ agent: child }, { filePath: 'a.txt', cwd: root })
  return { ctx, emit, dispatch, agent, parent, child, service, entered, ack, warnings, disposals: () => disposals }
}

for (const endEvent of ['subagent/end', 'agent/disposed']) test(`late join after ${endEvent} waits for disposition; duplicate events are idempotent`, async t => {
  const f = await fixture(t)
  const end = () => f.emit(endEvent, endEvent === 'subagent/end' ? { id: f.child.id, runId: 'run', stopReason: 'completed' } : { agent: f.child })
  end()
  await f.entered.promise
  let joined = false
  const pending = settleDelegateEditLifecycle(f.parent, f.child.id, f.child).then(() => { joined = true })
  end(); f.emit('agent/disposed', { agent: f.child })
  await flush()
  assert.equal(joined, false, 'map deletion must not erase the pending ACK')
  assert.equal(f.disposals(), 1)
  assert.equal(f.child.visible.has('write'), false, 'disposed cleanup remains synchronous')
  f.ack.resolve(); await pending
  assert.equal((await f.service.locks({ agent: f.parent })).length, 0)
})

for (const escalation of [false, true]) test(`one-shot ${escalation ? 'escalation' : 'result'} waits for emitted end disposition`, async t => {
  const f = await fixture(t)
  const result = deferred()
  let starts = 0, returned = false
  const tool = createDelegateTool({ resolveTarget: async () => ({ label: 'worker', persona: '' }), loadSkill: async () => '',
    subagents: { async startActivation(spec) {
      starts++
      if (starts === 1) return { childId: spec.childId, agent: f.child, result: result.promise }
      const second = await f.agent('escalated')
      f.emit('subagent/end', { id: second.id, runId: 'second-run', stopReason: 'completed' })
      return { childId: second.id, agent: second, result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }) }
    } },
  })
  const pending = tool.execute({ category: 'deep', prompt: 'task' }, { agent: f.parent, signal: new AbortController().signal }).then(value => { returned = true; return value })
  await flush()
  f.emit('subagent/end', { id: f.child.id, stopReason: 'completed' })
  result.resolve({ output: [{ type: 'text', text: escalation ? 'ESCALATE: deep-plus\nfindings' : 'done' }], stopReason: 'completed' })
  await f.entered.promise; await flush()
  assert.equal(returned, false)
  assert.equal(starts, 1, 'escalation must not start before first child ACK')
  f.ack.resolve(); await pending
  assert.equal(starts, escalation ? 2 : 1)
})

for (const termination of [false, true]) test(`supervision ${termination ? 'running termination' : 'STATUS terminal fact'} waits for quiescence then ACK`, async t => {
  const f = await fixture(t), lanes = []
  const mount = mountSupervision({ ctx: f.ctx, audit() {}, supervisionNow: () => ({}), onChildSettled: id => lanes.push(id) })
  const coordinator = await mount.coordinatorFor(f.parent)
  coordinator.registerMember({ id: f.child.id, name: 'child', group: 'g' })
  if (termination) coordinator.terminate(f.child.id, 'stop')
  else {
    coordinator.noteAssistantText(f.child.id, 'STATUS: completed\nREPORT: done')
    await coordinator.onTurnEnd(f.child.id, { kind: 'completed' })
    f.emit('session/event', f.child.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await f.child.followed.promise
    assert.equal(f.child.followups.length, 1, 'pending cleanup followup must survive the terminal fact')
  }
  await flush()
  assert.equal(f.disposals(), 0, 'terminal fact is not runtime quiescence')
  assert.deepEqual(lanes, [])
  // A followup queued by Edit Lock can still execute before runtime end.
  assert.equal(f.child.visible.has('write'), true)
  f.emit('subagent/end', { id: f.child.id, stopReason: termination ? 'aborted' : 'completed' })
  await f.entered.promise; await flush()
  assert.deepEqual(lanes, [], 'lane waits for authority ACK')
  f.ack.resolve(); await flush()
  // Socket response processing is an explicit completion barrier, not a sleep.
  await settleDelegateEditLifecycle(f.parent, f.child.id, f.child); await flush()
  assert.deepEqual(lanes, [f.child.id])
  f.emit('agent/disposed', { agent: f.child }); await flush()
  assert.deepEqual(lanes, [f.child.id])
})

test('failed disposition keeps the supervised lane bound and reports the failure', async t => {
  const f = await fixture(t), lanes = []
  const mount = mountSupervision({ ctx: f.ctx, audit() {}, supervisionNow: () => ({}), onChildSettled: id => lanes.push(id) })
  const coordinator = await mount.coordinatorFor(f.parent)
  coordinator.registerMember({ id: f.child.id, name: 'child', group: 'g' })
  coordinator.terminate(f.child.id)
  f.emit('subagent/end', { id: f.child.id, stopReason: 'aborted' })
  await f.entered.promise
  f.ack.reject(Error('disposition unavailable'))
  await assert.rejects(settleDelegateEditLifecycle(f.parent, f.child.id, f.child), /disposition unavailable/)
  await flush()
  assert.deepEqual(lanes, [])
  assert.ok(f.warnings.some(message => /disposition unavailable/.test(message)))
})

for (const background of [false, true]) test(`one-shot lane ${background ? 'job' : 'foreground'} retains binding when disposition fails`, async t => {
  const f = await fixture(t), lanes = []
  const result = deferred()
  let job
  const binding = { spec: { readOnly: false }, lane: { id: 'lane' }, contract: 'lane', commit: async () => {}, rollback: async () => {} }
  const tool = createDelegateTool({ resolveTarget: async () => ({ label: 'worker', persona: '' }), loadSkill: async () => '',
    subagents: { startActivation: async (spec) => ({ childId: spec.childId, agent: f.child, result: result.promise }) },
    lanes: () => ({ enabled: () => true, prepareBind: async () => binding, childSettled: async id => lanes.push(id) }),
    jobs: { start(spec) { job = spec.run({ updateProgress() {} }).done; return 'job' } },
  })
  const pending = tool.execute({ category: 'deep', prompt: 'task', worktree: 'lane', run_in_background: background }, { agent: f.parent, signal: new AbortController().signal })
  // Attach rejection observation before releasing the child result.
  const outcome = background ? (await pending, job) : pending
  const checked = background ? outcome : assert.rejects(outcome, /disposition unavailable/)
  await flush()
  f.emit('subagent/end', { id: f.child.id, stopReason: 'completed' })
  result.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
  await f.entered.promise; await flush()
  assert.deepEqual(lanes, [])
  f.ack.reject(Error('disposition unavailable'))
  const value = await checked
  if (background) { assert.equal(value.status, 'failed'); assert.match(value.detail, /disposition unavailable/) }
  assert.deepEqual(lanes, [])
})

test('old incarnation remains joinable and duplicate end cannot dispose its replacement', async t => {
  const f = await fixture(t)
  f.emit('subagent/end', { id: f.child.id, runId: 'old-run', stopReason: 'completed' })
  await f.entered.promise
  f.ack.resolve()
  await settleDelegateEditLifecycle(f.parent, f.child.id, f.child)
  const replacement = await f.agent(f.child.id)
  f.emit('subagent/end', { id: f.child.id, runId: 'old-run', stopReason: 'completed' })
  f.emit('agent/disposed', { agent: f.child })
  await settleDelegateEditLifecycle(f.parent, f.child.id, f.child)
  await flush()
  assert.equal(replacement.visible.has('write'), true)
  assert.equal(f.disposals(), 1)
  let completed = false
  const current = settleDelegateEditLifecycle(f.parent, replacement.id, replacement).then(() => { completed = true })
  await flush(); assert.equal(completed, false)
  f.emit('subagent/end', { id: replacement.id, runId: 'new-run', stopReason: 'completed' })
  await current
  assert.equal(f.disposals(), 2)
})
