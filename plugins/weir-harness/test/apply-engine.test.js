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
import { digestOf } from '../src/capabilities/store/record.js'
import { createSelectionNotifier } from '../src/capabilities/selection-notify.js'
import { createMcpDrain, createSessionDrainAdapter } from '../src/capabilities/mcp-drain.js'

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
  // The production-shaped drain wiring (capabilities-deepening D3): the
  // manager's (agent, server)-keyed drain behind the session seam adapter.
  const mcpDrain = createMcpDrain()
  const drain = createSessionDrainAdapter(() => mcpDrain)
  const engine = createApplyEngine({
    store,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async options => { trace('inventory', { options: structuredClone(options) }); return { complete: true, candidates: available.map(candidateOf) } },
    provider, fence, drain, trace,
    ...engineOptions,
  })
  return { root, store, engine, provider, fence, drain: mcpDrain, events }
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
  const { store, engine } = await fixture(t, { storeOptions: { platform: 'freebsd' } })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'rejected')
  assert.ok(response.reason.startsWith('unsupported:platform-unsupported'), response.reason)
  assert.deepEqual(await store.read(unit), { kind: 'unsupported', reason: 'platform-unsupported:freebsd' })
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
  // The production in-flight ledger: the manager drain's enter/exit (what
  // mcp-admission does at handoff) — never a track() on a private engine
  // coordinator.
  const token = drain.enter(SESSION, 'mcp-a', 'slow-call')
  slow.then(() => { settled = true; drain.exit(SESSION, 'mcp-a', token) })
  const response = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: [] } }))
  assert.equal(response.status, 'applied')
  // The response did not wait for the in-flight call to finish.
  assert.equal(settled, false)
  assert.deepEqual(response.draining, [{ server: 'mcp-a', state: 'draining', inFlight: 1 }])
  // The gate stays closed: new calls to the removed server are refused.
  assert.equal(drain.isClosed(SESSION, 'mcp-a'), true)
  assert.equal(drain.enter(SESSION, 'mcp-a', 'late-call'), null)
  settle()
  await slow
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(drain.snapshot(SESSION, 'mcp-a'), { server: 'mcp-a', state: 'settled', inFlight: 0 })
  assert.equal(drain.isClosed(SESSION, 'mcp-a'), true)
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
  assert.equal(drain.isClosed(SESSION, 'mcp-a'), false)
  // 3.4 regression pin: the failed Apply's abort() reopened the SAME
  // (session, server) gate begin() closed — a new call enters (no permanent
  // gating).
  const token = drain.enter(SESSION, 'mcp-a', 'after-failure')
  assert.notEqual(token, null)
  drain.exit(SESSION, 'mcp-a', token)
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

// --- apply-delta-durable-basis group 1: characterization pins ----------------
// These pin the committed-path notice semantics the durable-basis refactor
// (design D1/D2) must preserve unchanged: identity→display-name mapping, MCP
// server name passthrough, sorted combined added/removed lists, empty-delta
// suppression, and notifier net-merge coalescing across Applies.

test('notice semantics: the committed delta maps identities to display names, passes MCP names through and sorts both lists', async t => {
  const deltas = []
  const { engine } = await fixture(t, { engineOptions: { onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }) } })
  const first = await engine.apply(auth, request({ selection: { skills: [beta, alpha], mcpServers: ['mcp-z', 'mcp-a'] } }))
  assert.equal(first.status, 'applied')
  assert.deepEqual(deltas, [{ sessionId: SESSION, delta: { added: ['alpha', 'beta', 'mcp-a', 'mcp-z'], removed: [] } }])
  const second = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: ['mcp-b'] } }))
  assert.equal(second.status, 'applied')
  assert.deepEqual(deltas[1], { sessionId: SESSION, delta: { added: ['mcp-b'], removed: ['alpha', 'mcp-a', 'mcp-z'] } })
})

test('notice semantics: re-committing the same sets queues no notice (empty-delta suppression)', async t => {
  const deltas = []
  const { engine } = await fixture(t, { engineOptions: { onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }) } })
  await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(deltas.length, 1)
  const again = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(again.status, 'applied')
  assert.equal(deltas.length, 1)
})

test('notice semantics: deltas queue into the notifier and net-merge across applies', async t => {
  const notifier = createSelectionNotifier()
  const { engine } = await fixture(t, { engineOptions: { onAccepted: (sessionId, delta) => notifier.queue(sessionId, delta) } })
  await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  const pending = notifier.consume(SESSION)
  // alpha and mcp-a were added then removed before the next request: net zero.
  assert.deepEqual(pending.net, { added: ['beta'], removed: [] })
  assert.ok(pending.text.includes('Added: beta.'))
  assert.equal(notifier.consume(SESSION), null)
})

/**
 * Restart simulation: seed the durable accepted record, then build a FRESH
 * engine over the same store — a restarted host process has empty in-memory
 * state and only the durable record survives.
 */
async function restartedFixture(t, { seed, engineOptions = {}, available = [alpha, beta] } = {}) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-apply-restart-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'weir-apply-restart-')))
    await rm(root, { recursive: true, force: true })
  })
  const store = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  await store.commit(unit, 0,
    () => ({ skills: seed.skills ?? [], mcpServers: seed.mcpServers ?? [], origin: 'apply' }),
    { requestId: 'seed', requestDigest: digestOf({ seed: true }) })
  const deltas = []
  const engine = createApplyEngine({
    store,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: available.map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }),
    ...engineOptions,
  })
  return { root, store, engine, deltas }
}

// (The group-1 defect pins documenting the pre-fix restart shapes were removed
// in 3.6 — the restart scenarios below pin the fixed behavior.)

// --- apply-delta-durable-basis: restart behavior of the durable delta basis ---

test('restart: the first Apply after a host restart names every removed capability (durable delta basis)', async t => {
  const { engine, deltas } = await restartedFixture(t, { seed: { skills: [alpha, beta], mcpServers: ['mcp-a'] } })
  const response = await engine.apply(auth, request({ requestId: 'restart-removal', expectedRevision: 1, selection: { skills: [alpha], mcpServers: [] } }))
  assert.equal(response.status, 'applied')
  // The delta basis is the durable accepted record, so the removals survive
  // the restart: beta and mcp-a are named, and nothing reads as added.
  assert.deepEqual(deltas, [{ sessionId: SESSION, delta: { added: [], removed: ['beta', 'mcp-a'] } }])
})

test('restart: re-applying the exact accepted set after a host restart stays silent', async t => {
  const { engine, deltas } = await restartedFixture(t, { seed: { skills: [alpha], mcpServers: ['mcp-a'] } })
  const response = await engine.apply(auth, request({ requestId: 'restart-reapply', expectedRevision: 1, selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(response.status, 'applied')
  // The durable record shows no net change: no notice, in particular no
  // spurious full-set Added delta.
  assert.deepEqual(deltas, [])
})

// --- apply-basis-lock-hardening group 1: characterization pins -----------------
// Interleaving-free basis pin (tasks 1.2): with no foreign writer, the record read
// at transaction start and the record the CAS replaced are the same revision, so
// the reported net change and the drain set must name exactly that record's
// removals — the shapes the committed-over refactor (3.3/3.4) must keep identical.

test('basis pin: an interleaving-free removal Apply names the durable record\'s removals and drains exactly those servers once', async t => {
  const deltas = []
  const { store, engine, drain } = await fixture(t, { engineOptions: { onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }) } })
  // A durable accepted record with two skills and two managed servers.
  assert.equal((await store.commit(unit, 0, () => ({ skills: [alpha, beta], mcpServers: ['mcp-a', 'mcp-b'], origin: 'apply' }),
    { requestId: 'seed', requestDigest: digestOf({ seed: true }) })).status, 'committed')

  const response = await engine.apply(auth, request({ requestId: 'req-remove', expectedRevision: 1, selection: { skills: [alpha], mcpServers: ['mcp-b'] } }))
  assert.equal(response.status, 'applied')
  assert.equal(response.revision, 2)

  // Consumer 1 — the model-facing notice: both dropped capabilities are named.
  assert.deepEqual(deltas, [{ sessionId: SESSION, delta: { added: [], removed: ['beta', 'mcp-a'] } }])

  // Consumer 2 — the gate/drain set: exactly the removed managed server, once.
  assert.deepEqual(response.draining, [{ server: 'mcp-a', state: 'settled', inFlight: 0 }])
  assert.deepEqual(response.draining.map(row => row.server), [...new Set(response.draining.map(row => row.server))])
  assert.equal(drain.isClosed(SESSION, 'mcp-a'), true)
  assert.equal(drain.isClosed(SESSION, 'mcp-b'), false)

  // No removal, no drain report: the response stays free of a `draining` key.
  const quiet = await engine.apply(auth, request({ requestId: 'req-quiet', expectedRevision: 2, selection: { skills: [alpha], mcpServers: ['mcp-b'] } }))
  assert.equal(quiet.status, 'applied')
  assert.equal('draining' in quiet, false)
  assert.deepEqual(deltas.length, 1)
})

// --- apply-basis-lock-hardening 1.3/2.4: deterministic interleaving rig --------
/**
 * A SECOND store over the same root — a writer outside this engine's in-process
 * serialization, using the real file lock and the real CAS — lands revision 2
 * inside the awaited `verifyContent` hook, i.e. AFTER the engine's transaction
 * start read saw revision 1 and BEFORE its commit. The Apply then CASes at
 * expectedRevision 2, so the CAS passes on a revision this engine never read: the
 * window apply-basis-lock-hardening closes by making the store hand back the
 * payload the CAS replaced. `verifyContent` is the only awaited engine hook
 * between the read and the commit, so the interleaving is deterministic.
 */
async function interleavedApply(t, { selection = { skills: [alpha], mcpServers: [] } } = {}) {
  const deltas = []
  let foreign = null
  let recordAtInterleave = null
  const { root, store, engine, drain } = await fixture(t, {
    engineOptions: {
      onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }),
      verifyContent: async () => {
        if (!foreign) return
        const writer = foreign
        foreign = null
        const landed = await writer.commit(unit, 1,
          () => ({ skills: [alpha, beta], mcpServers: ['mcp-a', 'mcp-w'], origin: 'foreign' }),
          { requestId: 'foreign-write', requestDigest: digestOf({ foreign: true }) })
        const observed = await writer.read(unit)
        recordAtInterleave = { status: landed.status, revision: observed.revision, payload: observed.kind === 'ok' ? observed.payload : null }
      },
    },
  })
  // Revision 1 is what the engine's transaction start read sees.
  assert.equal((await store.commit(unit, 0, () => ({ skills: [alpha], mcpServers: ['mcp-a'], origin: 'apply' }),
    { requestId: 'seed', requestDigest: digestOf({ seed: true }) })).status, 'committed')
  assert.equal((await store.read(unit)).revision, 1)
  foreign = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  const response = await engine.apply(auth, request({ requestId: 'req-interleaved', expectedRevision: 2, selection }))
  return { response, deltas, drain, store, recordAtInterleave }
}

test('DEFECT pin: a foreign write between the transaction read and the commit leaves the notice and the gate set one revision stale', async t => {
  const { response, deltas, drain, recordAtInterleave } = await interleavedApply(t)
  assert.equal(recordAtInterleave.status, 'committed')
  // The interleaving advanced the record by exactly one revision before the commit.
  assert.equal(recordAtInterleave.revision, 2)
  assert.deepEqual(recordAtInterleave.payload, { skills: [alpha, beta], mcpServers: ['mcp-a', 'mcp-w'], origin: 'foreign' })
  // The CAS passed on the newer revision, so the Apply landed at revision 3.
  assert.equal(response.status, 'applied')
  assert.equal(response.revision, 3)
  // DEFECT (3.3/3.4 flip this): the basis is the transaction-start read, so both
  // consumers miss everything the foreign write added — beta is not named as
  // removed, and the managed server mcp-w stays ungated and undrained.
  assert.deepEqual(deltas, [{ sessionId: SESSION, delta: { added: [], removed: ['mcp-a'] } }])
  assert.equal(drain.isClosed(SESSION, 'mcp-w'), false)
  assert.deepEqual(response.draining, [{ server: 'mcp-a', state: 'settled', inFlight: 0 }])
})
