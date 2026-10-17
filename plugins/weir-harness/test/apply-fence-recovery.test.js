import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { digestOf } from '../src/capabilities/store/record.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { createSkillIdentity, skillIdentityKey } from '../src/capabilities/skill-identity.js'
import { APPLY_AUDIT_TYPE, createAdmissionFence, createApplyEngine, createDrainCoordinator } from '../src/capabilities/apply-engine.js'
import { createSelectionNotifier } from '../src/capabilities/selection-notify.js'
import { AUDIT_TYPES, createAudit } from '../src/shared/audit.js'

const SESSION = 'session-ffffffff-0000-4aaa-8bbb-cccccccccccc'
const auth = { id: SESSION, authenticated: true }
const unit = { kind: 'selection', sessionId: SESSION }

const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const beta = identity('project', 'beta')

const candidateOf = value => ({ status: 'parsed', name: value.name, identity: value,
  path: `/${value.scope}/${value.name}/SKILL.md`, digest: createHash('sha256').update(`${value.scope}:${value.name}`).digest('hex') })

async function fixture(t, { engineOptions = {}, storeOptions = {}, store } = {}) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-apply-recovery-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'weir-apply-recovery-')))
    await rm(root, { recursive: true, force: true })
  })
  const realStore = store ?? openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness(), ...storeOptions })
  const events = []
  const trace = (event, data) => events.push({ event, ...data })
  const fence = engineOptions.fence ?? createAdmissionFence()
  const drain = engineOptions.drain ?? createDrainCoordinator()
  const engine = createApplyEngine({
    store: realStore,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    fence, drain, trace,
    ...engineOptions,
  })
  return { root, store: realStore, engine, fence, drain, events }
}

const request = ({ requestId = 'req-1', expectedRevision = 0, selection, unresolved = [] } = {}) =>
  ({ requestId, expectedRevision, selection: selection ?? { skills: [alpha], mcpServers: [] }, unresolved })

test('static: Apply code never touches session.append, session.emit or session event type literals', () => {
  const capabilitiesDir = fileURLToPath(new URL('../src/capabilities/', import.meta.url))
  const names = readdirSync(capabilitiesDir, { recursive: true }).filter(name => String(name).endsWith('.js'))
  assert.ok(names.length > 0)
  for (const name of names) {
    const text = readFileSync(join(capabilitiesDir, String(name)), 'utf8')
    assert.ok(!/session\.append\(/.test(text), `${name}: session.append call (cold-read red line)`)
    assert.ok(!/session\.emit\s*\(/.test(text), `${name}: session.emit call`)
    assert.ok(!/['"]session\//.test(text), `${name}: custom session event type literal`)
  }
  // The audit channel itself must not call session.append either (comments
  // documenting the red line are fine; calls are not).
  const auditSource = readFileSync(fileURLToPath(new URL('../src/shared/audit.js', import.meta.url)), 'utf8')
  assert.ok(!/session\.append\(/.test(auditSource), 'shared audit must not call session.append')
  // The Apply audit type is registered in the shared vocabulary, not invented
  // at the emit site.
  assert.ok(auditSource.includes("capabilityApply: 'capability-apply'"), 'audit.js registers the Apply audit type')
  assert.equal(APPLY_AUDIT_TYPE, AUDIT_TYPES.capabilityApply)
  assert.equal(APPLY_AUDIT_TYPE, 'capability-apply')
})

test('audit flows through the shared channel: cordis emit plus .weir/audit.jsonl dual write', async t => {
  const { root } = await fixture(t)
  const emitted = []
  const emitter = createAudit({ emit: (type, record) => emitted.push({ type, record }) })
  const wired = createApplyEngine({
    store: openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() }),
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    audit: (session, type, data) => emitter({ id: session.id, header: { cwd: root } }, type, data),
  })
  const response = await wired.apply(auth, request())
  assert.equal(response.status, 'applied')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'weir/capability-apply')
  assert.equal(emitted[0].record.session, SESSION)
  assert.equal(emitted[0].record.data.revision, 1)
  const lines = readFileSync(join(root, '.weir', 'audit.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.type, 'weir/capability-apply')
  assert.equal(record.data.requestId, 'req-1')
  assert.equal(record.data.revision, 1)
})

test('audit and notify failures warn, are swallowed and never change the accepted policy', async t => {
  const warnings = []
  const { store, engine, fence } = await fixture(t, {
    engineOptions: {
      audit: () => { throw new Error('audit sink down') },
      notify: () => { throw new Error('notification bus down') },
      warn: message => warnings.push(message),
    },
  })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'applied')
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(warnings.some(message => message.startsWith('apply audit failed:')), `warnings: ${warnings}`)
  assert.ok(warnings.some(message => message.startsWith('apply notify failed:')), `warnings: ${warnings}`)
  const record = await store.read(unit)
  assert.equal(record.kind, 'ok')
  assert.equal(record.revision, 1)
  assert.equal(fence.isHeld(SESSION), false)
  assert.equal(engine.authority(SESSION).revision, 1)
})

test('publication re-checks the fence: a lost lease after a durable commit stays blocked and recovers via receipt query', async t => {
  const stubFence = { enter: () => ({ release() {} }), admit: () => false, isHeld: () => false }
  const { store, engine, events } = await fixture(t, { engineOptions: { fence: stubFence } })
  const response = await engine.apply(auth, request())
  assert.equal(response.status, 'indeterminate')
  assert.equal(response.step, 5)
  assert.ok(events.some(entry => entry.event === 'indeterminate' && entry.reason === 'fence-lost-before-publish'))
  // The write landed durably; the in-memory authority was never swapped.
  assert.equal((await store.read(unit)).revision, 1)
  assert.equal(engine.authority(SESSION), null)
  // The receipt query confirms the authority and publishes it.
  const query = await engine.queryReceipt(auth, 'req-1')
  assert.equal(query.status, 'found')
  assert.equal(query.recovery, 'published')
  assert.equal(query.receipt.requestId, 'req-1')
  assert.equal(engine.authority(SESSION).revision, 1)
  assert.deepEqual(engine.authority(SESSION).selection.skills, [alpha])
})

test('indeterminate recovery publishes the landed write: fence released, authority swapped, provider invalidated', async t => {
  const { store } = await fixture(t)
  const fence = createAdmissionFence()
  const drain = createDrainCoordinator()
  const published = []
  let lose = false
  const lossy = { ...store, commit: async (...args) => {
    const result = await store.commit(...args)
    if (lose) throw new Error('response lost after durable acceptance')
    return result
  } }
  const engine = createApplyEngine({
    store: lossy,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: identities => { published.push(identities); return { accepted: true, conflicts: [] } } },
    fence, drain,
  })
  await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(published.length, 1)
  lose = true
  const response = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'indeterminate')
  assert.equal(fence.isHeld(SESSION), true)
  assert.equal(drain.isClosed('mcp-a'), true)
  assert.equal(engine.authority(SESSION).revision, 1)
  // The "result pending confirmation" query retrieves the accepted revision…
  const query = await engine.queryReceipt(auth, 'req-2')
  assert.equal(query.status, 'found')
  assert.equal(query.revision, 2)
  assert.equal(query.receipt.requestId, 'req-2')
  assert.equal(query.recovery, 'published')
  assert.deepEqual(query.applied.skills, [beta])
  // …and runs the publication segment the lost response never ran.
  assert.equal(fence.isHeld(SESSION), false)
  assert.equal(published.length, 2)
  assert.deepEqual(published[1], [beta])
  assert.equal(engine.authority(SESSION).revision, 2)
  assert.deepEqual(engine.authority(SESSION).selection.skills, [beta])
  // The session accepts new Applies again.
  lose = false
  const next = await engine.apply(auth, request({ requestId: 'req-3', expectedRevision: 2, selection: { skills: [alpha], mcpServers: [] } }))
  assert.equal(next.status, 'applied')
  assert.equal(next.revision, 3)
})

test('indeterminate recovery on proven absence reopens gates and releases the fence without touching policy', async t => {
  const { store, fence, drain } = await fixture(t)
  // A commit that fails BEFORE any write while `down`: the outcome is unknown
  // to the engine, but the durable record provably never received the request.
  let down = false
  const flaky = { ...store, commit: async (...args) => {
    if (down) throw new Error('connection reset before write')
    return store.commit(...args)
  } }
  const flakyEngine = createApplyEngine({
    store: flaky,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    fence, drain,
  })
  await flakyEngine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  down = true
  const response = await flakyEngine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'indeterminate')
  assert.equal(fence.isHeld(SESSION), true)
  assert.equal(drain.isClosed('mcp-a'), true)
  const query = await flakyEngine.queryReceipt(auth, 'req-2')
  assert.equal(query.status, 'not-found')
  assert.equal(query.revision, 1)
  assert.equal(query.recovery, 'not-committed')
  // Proven absence unblocks: fence released, gates reopened, old authority kept.
  assert.equal(fence.isHeld(SESSION), false)
  assert.equal(drain.isClosed('mcp-a'), false)
  assert.equal(flakyEngine.authority(SESSION).revision, 1)
  assert.deepEqual(flakyEngine.authority(SESSION).selection.skills, [alpha])
  const record = await store.read(unit)
  assert.equal(record.revision, 1)
  assert.equal(record.receipts.length, 1)
  // The session accepts new Applies again.
  down = false
  const next = await flakyEngine.apply(auth, request({ requestId: 'req-3', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(next.status, 'applied')
  assert.equal(next.revision, 2)
})

test('indeterminate recovery stays blocked while the record cannot vouch, then settles on a later query', async t => {
  const { store, fence, drain } = await fixture(t)
  let lose = false
  let corruptRead = false
  const rigged = { ...store,
    commit: async (...args) => {
      const result = await store.commit(...args)
      if (lose) throw new Error('response lost after durable acceptance')
      return result
    },
    read: async (...args) => corruptRead ? { kind: 'corrupt' } : store.read(...args),
  }
  const riggedEngine = createApplyEngine({
    store: rigged,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    fence, drain,
  })
  await riggedEngine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  lose = true
  const response = await riggedEngine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'indeterminate')
  corruptRead = true
  const unsure = await riggedEngine.queryReceipt(auth, 'req-2')
  assert.equal(unsure.status, 'not-found')
  assert.equal(unsure.revision, null)
  assert.equal(unsure.recovery, 'blocked')
  // Blocking is maintained: no guessed rollback, no unrestricted state.
  assert.equal(fence.isHeld(SESSION), true)
  assert.equal(drain.isClosed('mcp-a'), true)
  assert.equal(riggedEngine.authority(SESSION).revision, 1)
  corruptRead = false
  const settled = await riggedEngine.queryReceipt(auth, 'req-2')
  assert.equal(settled.status, 'found')
  assert.equal(settled.recovery, 'published')
  assert.equal(fence.isHeld(SESSION), false)
  assert.equal(riggedEngine.authority(SESSION).revision, 2)
})

test('a duplicate response re-reads a consistent revision instead of mixing the receipt revision with newer sets', async t => {
  const { store, engine } = await fixture(t)
  const first = await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(first.status, 'applied')
  let advanced = false
  const rigged = { ...store, commit: async (...args) => {
    const result = await store.commit(...args)
    // Another writer lands revision 2 between the duplicate detection and the
    // engine's settle read.
    if (result.status === 'duplicate' && !advanced) {
      advanced = true
      await store.commit(unit, 1, () => ({ skills: [], mcpServers: ['mcp-z'], origin: 'apply' }),
        { requestId: 'req-other', requestDigest: digestOf({ other: true }) })
    }
    return result
  } }
  const riggedEngine = createApplyEngine({
    store: rigged,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
  })
  const replay = await riggedEngine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(replay.status, 'duplicate')
  assert.deepEqual(replay.receipt, first.receipt)
  // Revision and effective sets come from the SAME settled read.
  const settled = await store.read(unit)
  assert.equal(settled.revision, 2)
  assert.equal(replay.revision, settled.revision)
  assert.deepEqual(replay.effective, { skills: [], mcpServers: ['mcp-z'] })
})

test('receipts are retained for the session lifecycle: an old requestId never replays into a second change', async t => {
  const { store, engine } = await fixture(t)
  const first = await engine.apply(auth, request({ requestId: 'req-1', expectedRevision: 0, selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  const second = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: ['mcp-b'] } }))
  const third = await engine.apply(auth, request({ requestId: 'req-3', expectedRevision: 2, selection: { skills: [alpha, beta], mcpServers: [] } }))
  assert.deepEqual([first.status, second.status, third.status], ['applied', 'applied', 'applied'])
  const record = await store.read(unit)
  assert.equal(record.revision, 3)
  assert.equal(record.receipts.length, 3)
  // Replaying the oldest request long after later commits returns the original
  // receipt and changes nothing.
  const replay = await engine.apply(auth, request({ requestId: 'req-1', expectedRevision: 0, selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(replay.status, 'duplicate')
  assert.deepEqual(replay.receipt, first.receipt)
  assert.equal(replay.revision, 3)
  const after = await store.read(unit)
  assert.equal(after.revision, 3)
  assert.equal(after.receipts.length, 3)
  assert.deepEqual(after.payload.skills.map(skillIdentityKey).sort(), [skillIdentityKey(alpha), skillIdentityKey(beta)].sort())
  // Every receipt stays queryable for the session lifecycle.
  for (const [requestId, revision] of [['req-1', 1], ['req-2', 2], ['req-3', 3]]) {
    const query = await engine.queryReceipt(auth, requestId)
    assert.equal(query.status, 'found')
    assert.equal(query.receipt.revision, revision)
    assert.equal(query.revision, 3)
  }
  // Reusing an old id with ANY changed field is a conflict, not a silent accept.
  const altered = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: [] } }))
  assert.equal(altered.status, 'rejected')
  assert.equal(altered.reason, 'request-conflict')
  assert.equal((await store.read(unit)).revision, 3)
})

test('lost-response semantics: nothing ever claims a cancellation succeeded or a rollback happened', async t => {
  const { store, fence, engine } = await fixture(t)
  await engine.apply(auth, request())
  const lossy = { ...store, commit: async (...args) => {
    await store.commit(...args)
    throw new Error('response lost after durable acceptance')
  } }
  const lossyEngine = createApplyEngine({
    store: lossy,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    fence,
  })
  const response = await lossyEngine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'indeterminate')
  for (const key of ['cancelled', 'canceled', 'rolledBack', 'reverted', 'rollback']) {
    assert.equal(key in response, false, `indeterminate response must not carry '${key}'`)
  }
  const query = await lossyEngine.queryReceipt(auth, 'req-2')
  assert.equal(query.status, 'found')
  assert.equal(query.recovery, 'published')
  for (const key of ['cancelled', 'canceled', 'rolledBack', 'reverted', 'rollback']) {
    assert.equal(key in query, false, `receipt query must not carry '${key}'`)
  }
  // A plain not-found query carries no such claims either.
  const missing = await lossyEngine.queryReceipt(auth, 'req-unknown')
  assert.equal(missing.status, 'not-found')
  for (const key of ['cancelled', 'canceled', 'rolledBack', 'reverted', 'rollback']) {
    assert.equal(key in missing, false, `not-found query must not carry '${key}'`)
  }
})

// --- apply-delta-durable-basis: recovery-path notice behavior ----------------
// (The group-1 defect pin documenting the pre-fix recovery silence was removed
// in 3.6 — the pins below cover the fixed behavior.)

/** Engine over a commit-lossy store with an onAccepted collector. */
function lossyEngine(store, deltas, extra = {}) {
  const state = { lose: false }
  const lossy = { ...store, commit: async (...args) => {
    const result = await store.commit(...args)
    if (state.lose) throw new Error('response lost after durable acceptance')
    return result
  } }
  const engine = createApplyEngine({
    store: lossy,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }),
    ...extra,
  })
  return { state, engine }
}

test('recovery-published queues exactly one notice computed against the captured pre-write sets', async t => {
  const deltas = []
  const { store } = await fixture(t)
  const { state, engine } = lossyEngine(store, deltas)
  await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(deltas.length, 1)
  deltas.length = 0
  state.lose = true
  const response = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'indeterminate')
  const query = await engine.queryReceipt(auth, 'req-2')
  assert.equal(query.recovery, 'published')
  // The lost response never queued a notice, so the recovery publication owes
  // exactly one: the net delta of the landed write against the pre-write
  // accepted record ({alpha, mcp-a} → {beta}).
  assert.deepEqual(deltas, [{ sessionId: SESSION, delta: { added: ['beta'], removed: ['alpha', 'mcp-a'] } }])
})

test('recovery-not-committed queues nothing (proven absence stays silent)', async t => {
  const deltas = []
  const { store } = await fixture(t)
  let down = false
  const flaky = { ...store, commit: async (...args) => {
    if (down) throw new Error('connection reset before write')
    return store.commit(...args)
  } }
  const engine = createApplyEngine({
    store: flaky,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }),
  })
  await engine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(deltas.length, 1)
  deltas.length = 0
  down = true
  const response = await engine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'indeterminate')
  const query = await engine.queryReceipt(auth, 'req-2')
  assert.equal(query.recovery, 'not-committed')
  // Boundary pin (green before and after the fix): the write provably never
  // landed, so no notice may appear for it.
  assert.deepEqual(deltas, [])
})

test('recovery-blocked queues nothing while the record cannot vouch', async t => {
  const deltas = []
  const { store } = await fixture(t)
  let lose = false
  let corruptRead = false
  // Rigged store: the commit lands then the response is "lost"; reads then
  // turn corrupt so the record can vouch neither way.
  const rigged = { ...store,
    commit: async (...args) => {
      const result = await store.commit(...args)
      if (lose) throw new Error('response lost after durable acceptance')
      return result
    },
    read: async (...args) => corruptRead ? { kind: 'corrupt' } : store.read(...args),
  }
  const riggedEngine = createApplyEngine({
    store: rigged,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }),
  })
  await riggedEngine.apply(auth, request({ selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(deltas.length, 1)
  deltas.length = 0
  lose = true
  const response = await riggedEngine.apply(auth, request({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [beta], mcpServers: [] } }))
  assert.equal(response.status, 'indeterminate')
  corruptRead = true
  const query = await riggedEngine.queryReceipt(auth, 'req-2')
  assert.equal(query.recovery, 'blocked')
  // Boundary pin (green before and after the fix): blocking vouches neither
  // way, so no notice may be queued.
  assert.deepEqual(deltas, [])
})

// --- apply-basis-lock-hardening 2.5: the recovery basis is the committed-over record ---
test('recovery-published from a fence lost after the commit computes the notice against the committed-over record', async t => {
  const deltas = []
  // The fence is lost AFTER the durable commit (the rig at :123): the blocked
  // entry is the only carrier of the publication basis, so it must hold the
  // committed-over record rather than the transaction-start read.
  const stubFence = { enter: () => ({ release() {} }), admit: () => false, isHeld: () => false }
  let foreign = null
  let interleavedRevision = null
  const { root, store, engine } = await fixture(t, {
    engineOptions: {
      fence: stubFence,
      onAccepted: (sessionId, delta) => deltas.push({ sessionId, delta }),
      verifyContent: async () => {
        if (!foreign) return
        const writer = foreign
        foreign = null
        assert.equal((await writer.commit(unit, 1,
          () => ({ skills: [alpha, beta], mcpServers: ['mcp-a', 'mcp-w'], origin: 'foreign' }),
          { requestId: 'foreign-write', requestDigest: digestOf({ foreign: true }) })).status, 'committed')
        interleavedRevision = (await writer.read(unit)).revision
      },
    },
  })
  assert.equal((await store.commit(unit, 0, () => ({ skills: [alpha], mcpServers: ['mcp-a'], origin: 'apply' }),
    { requestId: 'seed', requestDigest: digestOf({ seed: true }) })).status, 'committed')
  foreign = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })

  const response = await engine.apply(auth, request({ requestId: 'req-interleaved', expectedRevision: 2, selection: { skills: [alpha], mcpServers: [] } }))
  // The interleaving landed one revision; the write itself landed (revision 3)
  // but publication could not be claimed.
  assert.equal(interleavedRevision, 2)
  assert.equal(response.status, 'indeterminate')
  assert.equal((await store.read(unit)).revision, 3)
  assert.deepEqual(deltas, [])

  const query = await engine.queryReceipt(auth, 'req-interleaved')
  assert.equal(query.recovery, 'published')
  // Exactly one notice, computed against the record the CAS replaced: beta and
  // mcp-w are named, and only the revision-2 record holds them.
  assert.deepEqual(deltas, [{ sessionId: SESSION, delta: { added: [], removed: ['beta', 'mcp-a', 'mcp-w'] } }])
})

// --- durable-pending-notice group 1: defect pin B (flipped in 5.3) -----------
// The reported replay loss: an Apply is durably accepted, the client loses the
// response and retries the SAME requestId after a host restart. The store
// replays the receipt (`status: 'duplicate'`), and the duplicate branch queues
// nothing — so on unmodified code nothing anywhere owes the model a notice.

test('notice pin B pins a DEFECT: a duplicate replay after a restart owes no notice', async t => {
  const notifier = createSelectionNotifier()
  const { store, engine } = await fixture(t, { engineOptions: { onAccepted: (sessionId, delta) => notifier.queue(sessionId, delta) } })
  const first = await engine.apply(auth, request())
  assert.equal(first.status, 'applied')
  assert.deepEqual(notifier.consume(SESSION)?.net, { added: ['alpha'], removed: [] })

  // A restart: a fresh engine and a fresh notifier over the same store root.
  const restarted = createSelectionNotifier()
  const replayed = createApplyEngine({
    store,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    onAccepted: (sessionId, delta) => restarted.queue(sessionId, delta),
  })
  const replay = await replayed.apply(auth, request())
  assert.equal(replay.status, 'duplicate')
  assert.equal(replay.revision, 1)
  assert.equal(replay.receipt.requestId, 'req-1')
  // The replay recomputes and queues nothing, so no notice is owed anywhere.
  assert.equal(restarted.has(SESSION), false)
  assert.equal(restarted.consume(SESSION), null)
})
