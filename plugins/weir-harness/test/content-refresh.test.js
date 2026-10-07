import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { createSkillIdentity, skillIdentityKey } from '../src/capabilities/skill-identity.js'
import { createAdmissionFence, createApplyEngine, createDrainCoordinator } from '../src/capabilities/apply-engine.js'
import { createContentRefresh, digestRefreshRequest, REFRESH_AUDIT_TYPE } from '../src/capabilities/content-refresh.js'
import { AUDIT_TYPES } from '../src/shared/audit.js'

const SESSION = 'session-11111111-2222-4333-8444-555555555555'
const auth = { id: SESSION, authenticated: true }
const selectionUnit = { kind: 'selection', sessionId: SESSION }
const contentUnit = { kind: 'content', sessionId: SESSION }

const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const beta = identity('project', 'beta')

const candidateOf = value => ({ status: 'parsed', name: value.name, identity: value,
  path: `/${value.scope}/${value.name}/SKILL.md`, digest: createHash('sha256').update(`${value.scope}:${value.name}`).digest('hex') })

const locate = async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null

async function fixture(t, { available = [alpha, beta], engineOptions = {}, refreshOptions = {}, wrapStore } = {}) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-content-refresh-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'weir-content-refresh-')))
    await rm(root, { recursive: true, force: true })
  })
  const real = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  const store = wrapStore ? wrapStore(real) : real
  const events = []
  const trace = (event, data) => events.push({ event, ...data })
  const fence = createAdmissionFence()
  const drain = createDrainCoordinator()
  const engine = createApplyEngine({
    store,
    locateSession: locate,
    inventory: async () => ({ complete: true, candidates: available.map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    fence, drain, trace,
    ...engineOptions,
  })
  const refresh = createContentRefresh({
    store,
    locateSession: locate,
    coordinate: (sessionId, task) => engine.coordinate(sessionId, task),
    collect: async () => ({ complete: true, candidates: available.map(candidateOf) }),
    trace,
    ...refreshOptions,
  })
  return { root, store, engine, refresh, fence, drain, events }
}

const applyRequest = ({ requestId = 'req-1', expectedRevision = 0, selection, unresolved = [] } = {}) =>
  ({ requestId, expectedRevision, selection: selection ?? { skills: [alpha], mcpServers: [] }, unresolved })
const refreshRequest = ({ requestId = 'ref-1', expectedRevision = 0, expectedSelectionRevision = 0, skills } = {}) =>
  ({ requestId, expectedRevision, expectedSelectionRevision, ...(skills ? { skills } : {}) })
const turns = async (count = 3) => { for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve)) }

test('a refresh commits an independent content record with its own revision and receipt', async t => {
  const { store, engine, refresh } = await fixture(t)
  const applied = await engine.apply(auth, applyRequest({ selection: { skills: [alpha], mcpServers: [] } }))
  assert.equal(applied.revision, 1)
  const response = await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(response.status, 'refreshed')
  assert.equal(response.revision, 1)
  assert.equal(response.receipt.requestId, 'ref-1')
  assert.equal(response.receipt.requestDigest, digestRefreshRequest({ expectedRevision: 0, expectedSelectionRevision: 1, skills: [skillIdentityKey(alpha)] }))
  assert.equal(response.selectionRevision, 1)
  const record = await store.read(contentUnit)
  assert.equal(record.kind, 'ok')
  assert.equal(record.revision, 1)
  assert.equal(record.payload.origin, 'refresh')
  assert.equal(record.payload.selectionRevision, 1)
  assert.deepEqual(record.payload.contents.map(entry => entry.identity), [alpha])
  // The selection record is untouched: same revision, still one receipt.
  const selection = await store.read(selectionUnit)
  assert.equal(selection.revision, 1)
  assert.equal(selection.receipts.length, 1)
})

test('a refresh without a skills subset refreshes every currently selected skill, and an explicit empty selection refreshes to empty', async t => {
  const { store, engine, refresh } = await fixture(t)
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha, beta], mcpServers: [] } }))
  const response = await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1 }))
  assert.equal(response.status, 'refreshed')
  const record = await store.read(contentUnit)
  assert.deepEqual(record.payload.contents.map(entry => entry.name).sort(), ['alpha', 'beta'])
  // An explicitly emptied selection is a concrete authority: refreshing it
  // commits an empty contents vector, distinct from an absent record.
  await engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [], mcpServers: [] } }))
  const emptied = await refresh.refresh(auth, refreshRequest({ requestId: 'ref-2', expectedRevision: 1, expectedSelectionRevision: 2 }))
  assert.equal(emptied.status, 'refreshed')
  assert.deepEqual(emptied.contents, [])
  const after = await store.read(contentUnit)
  assert.equal(after.revision, 2)
  assert.deepEqual(after.payload.contents, [])
})

test('a stale expected selection revision is rejected before any write', async t => {
  const { store, engine, refresh, events } = await fixture(t)
  await engine.apply(auth, applyRequest())
  const response = await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 0 }))
  assert.equal(response.status, 'rejected')
  assert.equal(response.reason, 'selection-revision-changed')
  assert.equal(response.step, 3)
  assert.deepEqual(response.current, { revision: 1 })
  assert.ok(events.some(entry => entry.event === 'selection-revision-changed'))
  assert.deepEqual(await store.read(contentUnit), { kind: 'absent', revision: 0 })
})

test('after a removal, refreshing the removed skill is rejected: removed but still published never happens', async t => {
  const { store, engine, refresh } = await fixture(t)
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha, beta], mcpServers: [] } }))
  await engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: [] } }))
  const denied = await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 2, skills: [beta] }))
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.reason, 'skill-not-selected')
  assert.deepEqual(denied.missing, [skillIdentityKey(beta)])
  assert.deepEqual(await store.read(contentUnit), { kind: 'absent', revision: 0 })
  // The surviving skill refreshes fine against the post-removal revision.
  const ok = await refresh.refresh(auth, refreshRequest({ requestId: 'ref-2', expectedSelectionRevision: 2, skills: [alpha] }))
  assert.equal(ok.status, 'refreshed')
  assert.equal(ok.selectionRevision, 2)
  const record = await store.read(contentUnit)
  assert.deepEqual(record.payload.contents.map(entry => entry.name), ['alpha'])
  assert.ok(!record.payload.contents.some(entry => entry.name === 'beta'), 'removed skill must not appear in the content record')
})

test('concurrent Apply and refresh serialize through the shared coordinator: a refresh crossing a removal never publishes the removed skill', async t => {
  const { store, engine, refresh, fence, events } = await fixture(t, {
    wrapStore: real => {
      let release
      const gate = new Promise(resolve => { release = resolve })
      const wrapper = { ...real, entered: false, release: () => release(),
        commit: async (...args) => {
          // Pause the removal Apply (selection revision 1 -> 2) mid-commit.
          if (args[0].kind === 'selection' && args[1] === 1) { wrapper.entered = true; await gate }
          return real.commit(...args)
        } }
      return wrapper
    },
  })
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha, beta], mcpServers: [] } }))
  const removal = engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: [] } }))
  while (!store.entered) await new Promise(resolve => setImmediate(resolve))
  assert.equal(fence.isHeld(SESSION), true)
  // The refresh captured the pre-removal selection revision; it queues behind
  // the in-flight Apply at the SAME serialization point.
  const refreshing = refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha, beta] }))
  await turns()
  assert.deepEqual(await store.read(contentUnit), { kind: 'absent', revision: 0 })
  assert.ok(!events.some(entry => entry.event === 'selection-read'), 'the refresh must not start before the Apply finishes')
  store.release()
  const [removed, refreshed] = await Promise.all([removal, refreshing])
  assert.equal(removed.status, 'applied')
  assert.equal(removed.revision, 2)
  // The selection re-check observed the NEW revision: no commit happened.
  assert.equal(refreshed.status, 'rejected')
  assert.equal(refreshed.reason, 'selection-revision-changed')
  assert.deepEqual(refreshed.current, { revision: 2 })
  assert.deepEqual(await store.read(contentUnit), { kind: 'absent', revision: 0 })
  // Ordering proof through the shared coordinator: the Apply's durable commit
  // strictly precedes the refresh's first selection read.
  const names = events.map(entry => entry.event)
  assert.ok(names.indexOf('commit') > -1 && names.indexOf('commit') < names.indexOf('selection-read'), `apply commit before refresh read: ${names}`)
  assert.equal(fence.isHeld(SESSION), false)
})

test('a refresh committed before a removal records the selection revision it was verified against, and a later removal cannot be re-published over', async t => {
  let entered = false
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { store, engine, refresh } = await fixture(t, {
    refreshOptions: { collect: async () => { entered = true; await gate; return { complete: true, candidates: [alpha, beta].map(candidateOf) } } },
  })
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha, beta], mcpServers: [] } }))
  const refreshing = refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha, beta] }))
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  // The removal Apply queues behind the in-flight refresh at the shared
  // coordinator — it cannot interleave with the refresh's commit.
  const removal = engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: [] } }))
  await turns()
  assert.equal((await store.read(selectionUnit)).revision, 1)
  release()
  const [refreshed, removed] = await Promise.all([refreshing, removal])
  assert.equal(refreshed.status, 'refreshed')
  assert.equal(removed.status, 'applied')
  assert.equal(removed.revision, 2)
  // The handles were verified against selection revision 1 — the record says
  // so, and the marker is observably stale once the removal lands.
  const record = await store.read(contentUnit)
  assert.equal(record.revision, 1)
  assert.equal(record.payload.selectionRevision, 1)
  assert.ok(record.payload.selectionRevision < (await store.read(selectionUnit)).revision)
  // A post-removal refresh cannot re-publish the removed skill.
  const denied = await refresh.refresh(auth, refreshRequest({ requestId: 'ref-2', expectedRevision: 1, expectedSelectionRevision: 2, skills: [beta] }))
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.reason, 'skill-not-selected')
  // The surviving skill refreshes against the new selection revision.
  const renewed = await refresh.refresh(auth, refreshRequest({ requestId: 'ref-3', expectedRevision: 1, expectedSelectionRevision: 2, skills: [alpha] }))
  assert.equal(renewed.status, 'refreshed')
  const after = await store.read(contentUnit)
  assert.equal(after.revision, 2)
  assert.equal(after.payload.selectionRevision, 2)
  assert.ok(!after.payload.contents.some(entry => entry.name === 'beta'), 'removed skill must not be re-published')
})

test('retrying the same accepted refresh returns the original receipt without a second commit', async t => {
  const { store, engine, refresh } = await fixture(t)
  await engine.apply(auth, applyRequest())
  const first = await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(first.status, 'refreshed')
  const replay = await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(replay.status, 'duplicate')
  assert.deepEqual(replay.receipt, first.receipt)
  assert.equal(replay.revision, 1)
  assert.equal(replay.selectionRevision, 1)
  // Reusing the id with ANY changed field — even only the expected content
  // revision — is a different request and is rejected, not silently accepted.
  const altered = await refresh.refresh(auth, refreshRequest({ expectedRevision: 99, expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(altered.status, 'rejected')
  assert.equal(altered.reason, 'request-conflict')
  const record = await store.read(contentUnit)
  assert.equal(record.revision, 1)
  assert.equal(record.receipts.length, 1)
})

test('a stale expected content revision conflicts with the current record', async t => {
  const { store, engine, refresh } = await fixture(t)
  await engine.apply(auth, applyRequest())
  await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  const conflicted = await refresh.refresh(auth, refreshRequest({ requestId: 'ref-2', expectedRevision: 0, expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(conflicted.status, 'rejected')
  assert.equal(conflicted.reason, 'revision-conflict')
  assert.equal(conflicted.step, 4)
  assert.deepEqual(conflicted.current, { revision: 1 })
  const record = await store.read(contentUnit)
  assert.equal(record.revision, 1)
  assert.equal(record.receipts.length, 1)
})

test('an uncertain refresh write reports indeterminate and a receipt query settles it from durable evidence', async t => {
  let lose = false
  const { store, engine, refresh } = await fixture(t, {
    wrapStore: real => ({ ...real, commit: async (...args) => {
      const result = await real.commit(...args)
      if (lose && args[0].kind === 'content') throw new Error('response lost after durable acceptance')
      return result
    } }),
  })
  await engine.apply(auth, applyRequest())
  lose = true
  const response = await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(response.status, 'indeterminate')
  assert.equal(response.step, 4)
  for (const key of ['cancelled', 'canceled', 'rolledBack', 'reverted', 'rollback']) {
    assert.equal(key in response, false, `indeterminate response must not carry '${key}'`)
  }
  // The write had landed; the receipt query confirms it without a second commit.
  const query = await refresh.queryReceipt(auth, 'ref-1')
  assert.equal(query.status, 'found')
  assert.equal(query.revision, 1)
  assert.equal(query.receipt.requestId, 'ref-1')
  assert.equal(query.selectionRevision, 1)
  assert.equal(query.contents.length, 1)
  const missing = await refresh.queryReceipt(auth, 'ref-unknown')
  assert.equal(missing.status, 'not-found')
  assert.equal(missing.revision, 1)
  assert.deepEqual(await store.read(contentUnit).then(record => record.receipts.length), 1)
})

test('collection failures reject the refresh without writes', async t => {
  const incomplete = await fixture(t, { refreshOptions: { collect: async () => ({ complete: false, candidates: [candidateOf(alpha)] }) } })
  await incomplete.engine.apply(auth, applyRequest())
  const rejected = await incomplete.refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.reason, 'inventory-incomplete')
  assert.deepEqual(await incomplete.store.read(contentUnit), { kind: 'absent', revision: 0 })

  const missing = await fixture(t, { refreshOptions: { collect: async () => ({ complete: true, candidates: [candidateOf(beta)] }) } })
  await missing.engine.apply(auth, applyRequest())
  const ghost = await missing.refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(ghost.status, 'rejected')
  assert.equal(ghost.reason, 'selected-identity-missing')
  assert.deepEqual(ghost.missing, [skillIdentityKey(alpha)])

  const drifting = await fixture(t, { refreshOptions: { verifyContent: () => { throw new Error('content drifted') } } })
  await drifting.engine.apply(auth, applyRequest())
  const failed = await drifting.refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(failed.status, 'rejected')
  assert.equal(failed.reason, 'preparation-failed:content drifted')
  assert.equal(failed.step, 3)
  assert.deepEqual(await drifting.store.read(contentUnit), { kind: 'absent', revision: 0 })
})

test('malformed requests and unauthenticated sessions are rejected with zero writes', async t => {
  const { store, refresh } = await fixture(t)
  for (const bad of [
    refreshRequest({ requestId: '' }),
    refreshRequest({ expectedRevision: -1 }),
    refreshRequest({ expectedSelectionRevision: -1 }),
    { requestId: 'ref-x', expectedRevision: 0, expectedSelectionRevision: 0, skills: 'alpha' },
  ]) {
    const response = await refresh.refresh(auth, bad)
    assert.equal(response.status, 'rejected')
    assert.ok(response.reason.startsWith('invalid-request:'), response.reason)
    assert.equal(response.step, 2)
  }
  const unauthenticated = await refresh.refresh(null, refreshRequest())
  assert.equal(unauthenticated.status, 'rejected')
  assert.equal(unauthenticated.reason, 'unauthenticated:session-unavailable')
  assert.equal(unauthenticated.step, 1)
  const queryRejected = await refresh.queryReceipt(null, 'ref-1')
  assert.equal(queryRejected.status, 'rejected')
  assert.equal(queryRejected.reason, 'unauthenticated:session-unavailable')
  assert.deepEqual(await store.read(contentUnit), { kind: 'absent', revision: 0 })
})

test('refresh acceptance is audited under the registered capability-apply type with an operation marker; audit failure never rolls back policy', async t => {
  assert.equal(REFRESH_AUDIT_TYPE, AUDIT_TYPES.capabilityApply)
  const audited = []
  const warnings = []
  let failAudit = false
  const { store, engine, refresh } = await fixture(t, {
    refreshOptions: {
      audit: (session, type, data) => { audited.push({ session, type, data }); if (failAudit) throw new Error('audit sink down') },
      warn: text => warnings.push(text),
    },
  })
  await engine.apply(auth, applyRequest())
  const response = await refresh.refresh(auth, refreshRequest({ expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(response.status, 'refreshed')
  await turns(2)
  assert.equal(audited.length, 1)
  assert.equal(audited[0].type, 'capability-apply')
  assert.deepEqual(audited[0].data, { operation: 'refresh', requestId: 'ref-1', revision: 1, selectionRevision: 1 })
  // A throwing audit sink warns, is swallowed and changes nothing durable.
  failAudit = true
  const second = await refresh.refresh(auth, refreshRequest({ requestId: 'ref-2', expectedRevision: 1, expectedSelectionRevision: 1, skills: [alpha] }))
  assert.equal(second.status, 'refreshed')
  await turns(2)
  assert.ok(warnings.some(text => text.startsWith('refresh audit failed:')), `warnings: ${warnings}`)
  assert.equal((await store.read(contentUnit)).revision, 2)
})
