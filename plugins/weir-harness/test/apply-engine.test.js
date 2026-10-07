import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createNodeFs, instrumentFs } from '../src/capabilities/store/fs-adapter.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { createSkillIdentity, skillIdentityKey } from '../src/capabilities/skill-identity.js'
import { createSkillSelectionProvider } from '../src/capabilities/skill-selection-provider.js'
import { createSelectionDraft } from '../src/capabilities/selection-draft.js'
import { APPLY_AUDIT_TYPE, createAdmissionFence, createApplyEngine, createDrainCoordinator, digestApplyRequest } from '../src/capabilities/apply-engine.js'

const SESSION = 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const auth = { id: SESSION, authenticated: true }
const unit = { kind: 'selection', sessionId: SESSION }

const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const beta = identity('project', 'beta')
const alphaProject = identity('project', 'alpha')

const candidateOf = value => ({ status: 'parsed', name: value.name, identity: value,
  path: `/${value.scope}/${value.name}/SKILL.md`, digest: createHash('sha256').update(`${value.scope}:${value.name}`).digest('hex') })

async function fixture(t, { available = [alpha, beta], engineOptions = {}, storeOptions = {} } = {}) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-apply-engine-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'weir-apply-engine-')))
    await rm(root, { recursive: true, force: true })
  })
  const store = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness(), ...storeOptions })
  const events = []
  const trace = (event, data) => events.push({ event, ...data })
  const provider = createSkillSelectionProvider({
    control: { invalidate() { trace('provider-invalidate') } },
    readSelection: async () => {
      const record = await store.read(unit)
      return record.kind === 'ok' ? record.payload.skills : []
    },
    inventory: async () => ({ complete: true, candidates: available.map(candidateOf) }),
    fs: { realpath: async path => path, readFile: async () => 'content' },
  })
  const fence = createAdmissionFence()
  const drain = createDrainCoordinator()
  const engine = createApplyEngine({
    store,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async options => { trace('inventory', { options: structuredClone(options) }); return { complete: true, candidates: available.map(candidateOf) } },
    provider, fence, drain, trace,
    ...engineOptions,
  })
  return { root, store, engine, provider, fence, drain, events }
}

const request = ({ requestId = 'req-1', expectedRevision = 0, selection, unresolved = [], ...rest } = {}) =>
  ({ requestId, expectedRevision, selection: selection ?? { skills: [alpha], mcpServers: [] }, unresolved, ...rest })
const viewOptions = { cwd: '/server-workspace', scope: { session: { id: SESSION } } }

test('a valid request commits at one accepted revision with receipt, effective sets and unresolved warnings', async t => {
  const { store, engine } = await fixture(t)
  const unresolved = [{ kind: 'skill', ref: 'vendor/missing', reason: 'not-installed' }]
  const response = await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] }, unresolved }))
  assert.equal(response.status, 'applied')
  assert.equal(response.revision, 1)
  assert.equal(response.receipt.requestId, 'req-1')
  assert.equal(response.receipt.requestDigest, digestApplyRequest({
    expectedRevision: 0, skills: [skillIdentityKey(alpha)], mcpServers: ['mcp-a'], unresolved,
  }))
  assert.deepEqual(response.effective.skills, [alpha])
  assert.deepEqual(response.effective.mcpServers, ['mcp-a'])
  assert.deepEqual(response.unresolvedWarnings, unresolved)
  assert.equal('draining' in response, false)
  const record = await store.read(unit)
  assert.equal(record.kind, 'ok')
  assert.equal(record.revision, 1)
  assert.deepEqual(record.payload, { skills: [alpha], mcpServers: ['mcp-a'], origin: 'apply' })
})

test('ordering: snapshot swap, invalidate and fence release run in one non-async segment before the response', async t => {
  const { store, engine, events } = await fixture(t)
  // Give the event loop a turn right before the commit so any leaked await in
  // the publication segment would let an io-turn probe interleave.
  const gated = {
    ...store,
    commit: async (...args) => {
      await new Promise(resolve => setImmediate(resolve))
      return store.commit(...args)
    },
  }
  const gatedEngine = createApplyEngine({
    store: gated,
    locateSession: async () => ({ sessionId: SESSION, cwd: '/server-workspace' }),
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: createSkillSelectionProvider({
      control: { invalidate() { events.push({ event: 'provider-invalidate' }) } },
      readSelection: async () => [],
      inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    }),
    fence: createAdmissionFence(),
    drain: createDrainCoordinator(),
    trace: (event, data) => events.push({ event, ...data }),
  })
  let stopped = false
  const probe = () => { if (!stopped) { events.push({ event: 'io-turn' }); setImmediate(probe) } }
  setImmediate(probe)
  const response = await gatedEngine.apply(auth, request())
  stopped = true
  assert.equal(response.status, 'applied')
  const names = events.map(entry => entry.event)
  const at = name => names.indexOf(name)
  assert.ok(at('commit') < at('snapshot-swap'), `commit before swap: ${names}`)
  assert.ok(at('snapshot-swap') < at('invalidate'), `swap before invalidate: ${names}`)
  assert.ok(at('invalidate') < at('provider-invalidate'), `invalidate call before provider invalidation: ${names}`)
  assert.ok(at('provider-invalidate') < at('fence-release'), `invalidate before fence release: ${names}`)
  assert.ok(at('fence-release') < at('response'), `fence release before response: ${names}`)
  const segment = names.slice(at('commit'), at('response') + 1)
  assert.ok(!segment.includes('io-turn'), `no event-loop turn inside the publication segment: ${segment}`)
})

test('a client list read issued immediately after the response already sees the new list', async t => {
  const { engine, provider } = await fixture(t)
  assert.deepEqual((await provider.list(viewOptions)).candidates, [])
  const response = await engine.apply(auth, request({ selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'applied')
  const listed = await provider.list(viewOptions)
  assert.deepEqual(listed.candidates.map(item => item.identity), [beta])
})

test('the new authorization is unusable before durable acceptance', async t => {
  const { store, engine, fence, provider } = await fixture(t)
  let entered = false
  let release
  const gate = new Promise(resolve => { release = resolve })
  const gated = { ...store, commit: async (...args) => { entered = true; await gate; return store.commit(...args) } }
  const gatedEngine = createApplyEngine({
    ...{ store: gated },
    locateSession: async () => ({ sessionId: SESSION, cwd: '/server-workspace' }),
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider, fence, drain: createDrainCoordinator(),
  })
  const pending = gatedEngine.apply(auth, request({ selection: { skills: [beta], mcpServers: [] } }))
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  assert.equal(gatedEngine.authority(SESSION), null)
  assert.deepEqual((await provider.list(viewOptions)).candidates, [])
  assert.equal(fence.isHeld(SESSION), true)
  assert.equal(fence.admit(SESSION), false)
  release()
  const response = await pending
  assert.equal(response.status, 'applied')
  assert.equal(fence.isHeld(SESSION), false)
  assert.equal(fence.admit(SESSION), true)
  assert.equal(gatedEngine.authority(SESSION).revision, 1)
  assert.deepEqual(gatedEngine.authority(SESSION).selection.skills, [beta])
})

test('retrying the same accepted request returns the original receipt without a second commit', async t => {
  const { store, engine } = await fixture(t)
  const first = await engine.apply(auth, request())
  assert.equal(first.status, 'applied')
  const retry = await engine.apply(auth, request())
  assert.equal(retry.status, 'duplicate')
  assert.deepEqual(retry.receipt, first.receipt)
  assert.equal(retry.revision, 1)
  // Reusing the id with ANY changed field — even only the expected revision —
  // is a different request and is rejected, not silently accepted.
  const altered = await engine.apply(auth, request({ expectedRevision: 99 }))
  assert.equal(altered.status, 'rejected')
  assert.equal(altered.reason, 'request-conflict')
  assert.deepEqual(altered.receipt, first.receipt)
  const record = await store.read(unit)
  assert.equal(record.revision, 1)
  assert.equal(record.receipts.length, 1)
})

test('reusing a request id with a changed payload is rejected as a request conflict', async t => {
  const { store, engine } = await fixture(t)
  const first = await engine.apply(auth, request())
  const replay = await engine.apply(auth, request({ selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(replay.status, 'rejected')
  assert.equal(replay.reason, 'request-conflict')
  assert.deepEqual(replay.receipt, first.receipt)
  assert.equal((await store.read(unit)).revision, 1)
})

test('a stale expected revision conflicts with current state and preserves the user draft', async t => {
  const { store, engine } = await fixture(t)
  await engine.apply(auth, request())
  const draft = createSelectionDraft({ baseRevision: 0, applied: { skills: [], mcpServers: [] } })
  draft.toggle(beta, true)
  const conflicted = await engine.apply(auth, request({ requestId: 'req-2', ...draft.toApplyPayload() }))
  assert.equal(conflicted.status, 'rejected')
  assert.equal(conflicted.reason, 'revision-conflict')
  assert.equal(conflicted.current.revision, 1)
  assert.deepEqual(conflicted.current.skills, [alpha])
  // The draft is manager-side state: the engine never consumed or cleared it.
  assert.equal(draft.isDirty(), true)
  assert.deepEqual(draft.toApplyPayload().selection.skills, [beta])
  const record = await store.read(unit)
  assert.equal(record.revision, 1)
  assert.deepEqual(record.payload.skills, [alpha])
})

test('two same-name identities in one request are rejected without an arbitrary winner', async t => {
  const { store, engine } = await fixture(t, { available: [alpha, alphaProject] })
  const response = await engine.apply(auth, request({ selection: { skills: [alpha, alphaProject], mcpServers: [] } }))
  assert.equal(response.status, 'rejected')
  assert.equal(response.reason, 'same-name-conflict')
  assert.equal(response.step, 2)
  assert.equal(response.conflicts.length, 1)
  assert.equal(response.conflicts[0].name, 'alpha')
  assert.deepEqual(await store.read(unit), { kind: 'absent', revision: 0 })
})

test('malformed requests are rejected at validation with zero writes', async t => {
  const { store, engine } = await fixture(t)
  for (const bad of [
    request({ requestId: '' }),
    request({ expectedRevision: -1 }),
    { requestId: 'req-x', expectedRevision: 0 },
    request({ unresolved: [{ kind: 'skill' }] }),
  ]) {
    const response = await engine.apply(auth, bad)
    assert.equal(response.status, 'rejected')
    assert.ok(response.reason.startsWith('invalid-request:'), response.reason)
    assert.equal(response.step, 2)
  }
  assert.deepEqual(await store.read(unit), { kind: 'absent', revision: 0 })
})

test('an incomplete inventory rejects the apply without writes', async t => {
  const { store, engine } = await fixture(t, {
    engineOptions: { inventory: async () => ({ complete: false, candidates: [candidateOf(alpha)] }) },
  })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'rejected')
  assert.equal(response.reason, 'inventory-incomplete')
  assert.equal(response.step, 2)
  assert.deepEqual(await store.read(unit), { kind: 'absent', revision: 0 })
})

test('a selected identity missing from the inventory is rejected, never substituted by name', async t => {
  const ghost = identity('user', 'ghost')
  const { store, engine } = await fixture(t, { available: [alpha, identity('project', 'ghost')] })
  const response = await engine.apply(auth, request({ selection: { skills: [alpha, ghost], mcpServers: [] } }))
  assert.equal(response.status, 'rejected')
  assert.equal(response.reason, 'selected-identity-missing')
  assert.deepEqual(response.missing, [skillIdentityKey(ghost)])
  assert.deepEqual(await store.read(unit), { kind: 'absent', revision: 0 })
})

test('unsatisfied conformance conditions show unsupported and write nothing', async t => {
  const { store, engine } = await fixture(t, { engineOptions: { conditions: () => ['C1-composition-unverified'] } })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'rejected')
  assert.equal(response.reason, 'unsupported:C1-composition-unverified')
  assert.equal(response.step, 2)
  assert.deepEqual(await store.read(unit), { kind: 'absent', revision: 0 })
})

test('the server locates the session and never trusts client cwd, scope roots or server config', async t => {
  const { engine, events } = await fixture(t)
  const response = await engine.apply(auth, request({ cwd: '/evil', scopeRoot: '/evil', serverConfig: { evil: true } }))
  assert.equal(response.status, 'applied')
  const seen = events.find(entry => entry.event === 'inventory').options
  assert.equal(seen.cwd, '/server-workspace')
  assert.equal(seen.scope.session.id, SESSION)
  const unauthenticated = await engine.apply(null, request({ requestId: 'req-2' }))
  assert.equal(unauthenticated.status, 'rejected')
  assert.equal(unauthenticated.reason, 'unauthenticated:session-unavailable')
  assert.equal(unauthenticated.step, 1)
})

test('an unreadable policy record fails closed and is never overwritten', async t => {
  const { root, engine } = await fixture(t)
  const recordPath = join(root, 'sessions', SESSION, 'selection.json')
  await mkdir(dirname(recordPath), { recursive: true })
  await writeFile(recordPath, '{corrupt', 'utf8')
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'rejected')
  assert.equal(response.reason, 'policy-unreadable:corrupt')
  assert.equal(response.step, 1)
  assert.equal(await readFile(recordPath, 'utf8'), '{corrupt')
})

test('an unsupported store reports unsupported and writes nothing', async t => {
  const { store, engine } = await fixture(t, { storeOptions: { platform: 'win32' } })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'rejected')
  assert.ok(response.reason.startsWith('unsupported:platform-unsupported'), response.reason)
  assert.deepEqual(await store.read(unit), { kind: 'unsupported', reason: 'platform-unsupported:win32' })
})

test('preparation failure keeps the old authority, the user draft and sends no notification', async t => {
  const notifications = []
  const { store, engine, fence } = await fixture(t, {
    engineOptions: {
      verifyContent: candidate => { if (candidate.name === 'beta') throw new Error('content drifted') },
      notify: response => notifications.push(response),
    },
  })
  await engine.apply(auth, request())
  assert.equal(engine.authority(SESSION).revision, 1)
  assert.equal(notifications.length, 1)
  notifications.length = 0
  const draft = createSelectionDraft({ baseRevision: 1, applied: { skills: [alpha], mcpServers: [] } })
  draft.toggle(beta, true)
  const response = await engine.apply(auth, request({ requestId: 'req-2', ...draft.toApplyPayload() }))
  assert.equal(response.status, 'rejected')
  assert.equal(response.reason, 'preparation-failed:content drifted')
  assert.equal(response.step, 3)
  // Old authority intact, draft retained, nothing notified, no fence left held.
  assert.equal((await store.read(unit)).revision, 1)
  assert.deepEqual(engine.authority(SESSION).selection.skills, [alpha])
  assert.equal(draft.isDirty(), true)
  assert.deepEqual(notifications, [])
  assert.equal(fence.isHeld(SESSION), false)
})

test('the response returns while a slow in-flight call is still draining and reports the drain snapshot', async t => {
  const { engine, drain } = await fixture(t)
  await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  let settle
  const slow = new Promise(resolve => { settle = resolve })
  let settled = false
  slow.then(() => { settled = true })
  assert.equal(drain.track('mcp-a', slow), true)
  const response = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: [] } }))
  assert.equal(response.status, 'applied')
  // The response did not wait for the in-flight call to finish.
  assert.equal(settled, false)
  assert.deepEqual(response.draining, [{ server: 'mcp-a', state: 'draining', inFlight: 1 }])
  // The gate stays closed: new calls to the removed server are refused.
  assert.equal(drain.isClosed('mcp-a'), true)
  assert.equal(drain.track('mcp-a', Promise.resolve()), false)
  settle()
  await slow
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(drain.status('mcp-a'), { server: 'mcp-a', state: 'settled', inFlight: 0 })
  assert.equal(drain.isClosed('mcp-a'), true)
})

test('a definite write failure releases the fence, keeps the old snapshot and reopens drain gates', async t => {
  let failRename = false
  const fs = instrumentFs(createNodeFs(), async (op, args, phase) => {
    if (failRename && op === 'rename' && phase === 'before' && args[1].endsWith('selection.json')) {
      throw new Error('injected rename failure')
    }
  })
  const { store, engine, fence, drain } = await fixture(t, { storeOptions: { fs } })
  await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  failRename = true
  const response = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'write-failed')
  assert.equal(response.step, 5)
  assert.equal(fence.isHeld(SESSION), false)
  assert.equal(drain.isClosed('mcp-a'), false)
  assert.deepEqual(engine.authority(SESSION).selection.skills, [alpha])
  const record = await store.read(unit)
  assert.equal(record.revision, 1)
  assert.deepEqual(record.payload.skills, [alpha])
})

test('an uncertain write outcome stays blocked and is confirmed by a receipt query, never rolled back', async t => {
  const { store } = await fixture(t)
  const fence = createAdmissionFence()
  const drain = createDrainCoordinator()
  let lose = false
  const lossy = {
    ...store,
    commit: async (...args) => {
      const result = await store.commit(...args)
      if (lose) throw new Error('response lost after durable acceptance')
      return result
    },
  }
  const engine = createApplyEngine({
    store: lossy,
    locateSession: async () => ({ sessionId: SESSION, cwd: '/server-workspace' }),
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    fence, drain,
  })
  await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  lose = true
  const response = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'indeterminate')
  assert.equal(response.step, 5)
  // Blocking is maintained: the fence stays held and the removed-server gate closed.
  assert.equal(fence.isHeld(SESSION), true)
  assert.equal(drain.isClosed('mcp-a'), true)
  // The old state is not rolled back and the new one not assumed on a guess.
  assert.equal(engine.authority(SESSION).revision, 1)
  assert.equal((await store.read(unit)).revision, 2)
  // The receipt query confirms the durable authority without a second commit.
  const query = await engine.queryReceipt(auth, 'req-2')
  assert.equal(query.status, 'found')
  assert.equal(query.revision, 2)
  assert.equal(query.receipt.requestId, 'req-2')
  assert.deepEqual(query.applied.skills, [beta])
})

test('audit and notification failures after acceptance never roll back policy', async t => {
  const audited = []
  const { store, engine } = await fixture(t, {
    engineOptions: {
      audit: (session, type, data) => { audited.push({ session, type, data }); throw new Error('audit sink down') },
      notify: () => { throw new Error('notification bus down') },
    },
  })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'applied')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(audited.length, 1)
  assert.equal(audited[0].type, APPLY_AUDIT_TYPE)
  assert.equal(audited[0].session.id, SESSION)
  assert.equal(audited[0].data.revision, 1)
  const record = await store.read(unit)
  assert.equal(record.revision, 1)
  assert.deepEqual(record.payload.skills, [alpha])
})

test('a provider invalidation failure after acceptance degrades convergence, never the policy', async t => {
  const { store, engine, fence } = await fixture(t, {
    engineOptions: { provider: { acceptSelection: () => { throw new Error('registry wedged') } } },
  })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'applied')
  assert.deepEqual(response.warnings, ['invalidate-failed'])
  assert.equal(fence.isHeld(SESSION), false)
  assert.equal((await store.read(unit)).revision, 1)
})

test('a fence that cannot be entered rejects the apply before any write', async t => {
  const { store, engine } = await fixture(t, {
    engineOptions: { fence: { enter() { throw new Error('admission fence already held') }, admit: () => false, isHeld: () => true } },
  })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'rejected')
  assert.ok(response.reason.startsWith('fence-unavailable:'), response.reason)
  assert.equal(response.step, 4)
  assert.deepEqual(await store.read(unit), { kind: 'absent', revision: 0 })
})

test('concurrent applies on one session accept exactly one revision', async t => {
  const { store, engine } = await fixture(t)
  const [first, second] = await Promise.all([
    engine.apply(auth, request({ requestId: 'req-1', selection: { skills: [alpha], mcpServers: [] } })),
    engine.apply(auth, request({ requestId: 'req-2', selection: { skills: [beta], mcpServers: [] } })),
  ])
  const outcomes = [first.status === 'applied' ? 'applied' : first.reason, second.status === 'applied' ? 'applied' : second.reason].sort()
  assert.deepEqual(outcomes, ['applied', 'revision-conflict'])
  const record = await store.read(unit)
  assert.equal(record.revision, 1)
  assert.equal(record.receipts.length, 1)
})

test('receipt queries report not-found and reject unauthenticated sessions', async t => {
  const { engine } = await fixture(t)
  await engine.apply(auth, request())
  const missing = await engine.queryReceipt(auth, 'req-unknown')
  assert.equal(missing.status, 'not-found')
  assert.equal(missing.revision, 1)
  const unauthenticated = await engine.queryReceipt(null, 'req-1')
  assert.equal(unauthenticated.status, 'rejected')
  assert.equal(unauthenticated.reason, 'unauthenticated:session-unavailable')
  const invalid = await engine.queryReceipt(auth, '')
  assert.equal(invalid.status, 'rejected')
  assert.equal(invalid.reason, 'invalid-request:requestId')
})

test('an explicitly emptied selection is a durable state distinct from an absent record', async t => {
  const { store, engine } = await fixture(t)
  const response = await engine.apply(auth, request({ selection: { skills: [], mcpServers: [] } }))
  assert.equal(response.status, 'applied')
  assert.deepEqual(response.effective, { skills: [], mcpServers: [] })
  const record = await store.read(unit)
  assert.equal(record.kind, 'ok')
  assert.equal(record.revision, 1)
  assert.deepEqual(record.payload.skills, [])
  assert.deepEqual(record.payload.mcpServers, [])
})

test('the shared commit coordinator serializes tasks per session and isolates failures', async t => {
  const { engine } = await fixture(t)
  const order = []
  const first = engine.coordinate(SESSION, async () => {
    await new Promise(resolve => setImmediate(resolve))
    order.push('first')
    throw new Error('boom')
  })
  const second = engine.coordinate(SESSION, async () => {
    order.push('second')
    return 'ok'
  })
  await assert.rejects(first, /boom/)
  assert.equal(await second, 'ok')
  assert.deepEqual(order, ['first', 'second'])
  // A failed task never poisons the queue: the session coordinates further work.
  const third = await engine.coordinate(SESSION, async () => 'resumed')
  assert.equal(third, 'resumed')
})
