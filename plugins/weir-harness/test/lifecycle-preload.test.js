// Task 6.1 preload, effective-set shape (fix-capability-fork-and-preset-
// workspaces group 1): at plugin apply the preload loads the session's
// EFFECTIVE set — the accepted selection when one exists, otherwise the durable
// inherited snapshot a fork was created with. A cold read (Badge/manager
// receipt, MCP gate, Skill catalog) must report the inherited set instead of an
// empty one until the fork's agent is recreated, and it must never hand a
// damaged record the fresh-initialization treatment.
import { test, expect } from './helpers.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLifecycleSnapshots, INHERITED_ORIGIN } from '../src/capabilities/lifecycle-snapshot.js'
import { preloadLifecycleSnapshots } from '../src/capabilities/lifecycle-preload.js'
import { createNodeFs, instrumentFs } from '../src/capabilities/store/fs-adapter.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'

const base = () => mkdtempSync(join(tmpdir(), 'weir-preload-'))
const alpha = createSkillIdentity({ scope: 'user', root: '/user', name: 'alpha', opaqueId: 'user-alpha' })
const beta = createSkillIdentity({ scope: 'project', root: '/project', name: 'beta', opaqueId: 'project-beta' })

const seedInherited = (root, sessionId, payload) =>
  openCapabilityStore({ root, platform: 'darwin' }).commit({ kind: 'inherited', sessionId }, 0, () => ({
    origin: INHERITED_ORIGIN,
    capturedAt: 111,
    ...payload,
  }))

const seedSelection = (root, sessionId, payload) =>
  openCapabilityStore({ root, platform: 'darwin' }).commit({ kind: 'selection', sessionId }, 0, () => payload)

const preload = async (root, lifecycle) => preloadLifecycleSnapshots({
  lifecycle,
  store: openCapabilityStore({ root, platform: 'darwin' }),
})

// ---- final-gate race: preload vs an accepted Apply --------------------------
// Production runs preload and Apply on SEPARATE stores (skill-selection-
// plugin.js): the preload read cannot see Apply's locks, and every publish or
// BLOCKED marker below lands after at least one await. These tests hold a real
// store read open, accept an Apply through an independent store plus the memory
// publish seam while it is in flight, then release it. The freshness recheck
// must keep the accepted snapshot authoritative.
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

/** Hold the first async read of one session unit open until `release`. */
const delayedRead = (root, sessionId, unitName) => {
  const entered = deferred()
  const release = deferred()
  let held = false
  const fs = instrumentFs(createNodeFs(), async (op, args, phase) => {
    if (phase !== 'before' || op !== 'readText' || held) return
    if (args[0] !== join(root, 'sessions', sessionId, `${unitName}.json`)) return
    held = true
    entered.resolve()
    await release.promise
  })
  return { fs, entered, release }
}

test('6.1 preload: an inherited-only session loads its effective set and captured metadata', async () => {
  const root = base()
  await seedInherited(root, 'fork-1', { skills: [alpha, beta], mcpServers: ['docs'], parent: { sessionId: 'parent', revision: 2 } })
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const result = await preload(root, lifecycle)
  expect(result.loaded).toBe(1)
  expect(result.blocked).toBe(0)
  const snapshot = lifecycle.snapshotFor('fork-1')
  expect(snapshot?.state).toBe('ready')
  // The inherited revision is the inheritance unit's own version — never an
  // accepted CAS revision (the receipt keeps reporting 0 for that).
  expect(snapshot?.revision).toBe(1)
  expect(snapshot?.skills.map(identity => identity.name)).toEqual(['alpha', 'beta'])
  expect(snapshot?.mcpServers).toEqual(['docs'])
  expect(snapshot?.captured).toEqual({ parentSessionId: 'parent', parentRevision: 2, capturedAt: 111 })
})

test('6.1 preload: an accepted selection outranks the inherited snapshot and carries no captured lineage', async () => {
  const root = base()
  await seedInherited(root, 'fork-2', { skills: [alpha], mcpServers: [], parent: { sessionId: 'parent', revision: 2 } })
  await seedSelection(root, 'fork-2', { skills: [beta], mcpServers: ['web'] })
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const result = await preload(root, lifecycle)
  expect(result.loaded).toBe(1)
  const snapshot = lifecycle.snapshotFor('fork-2')
  expect(snapshot?.revision).toBe(1)
  expect(snapshot?.skills.map(identity => identity.name)).toEqual(['beta'])
  expect(snapshot?.mcpServers).toEqual(['web'])
  expect(snapshot?.captured).toBeNull()
})

test('6.1 preload: a corrupt inherited record pre-marks the session BLOCKED instead of uninitialized', async () => {
  const root = base()
  mkdirSync(join(root, 'sessions', 'fork-broken'), { recursive: true })
  writeFileSync(join(root, 'sessions', 'fork-broken', 'inherited.json'), '{')
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const result = await preload(root, lifecycle)
  expect(result.blocked).toBe(1)
  expect(result.loaded).toBe(0)
  expect(lifecycle.snapshotFor('fork-broken')?.state).toBe('blocked')
  expect(lifecycle.snapshotFor('fork-broken')?.reason).toBe('corrupt')
})

test('6.1 preload: a corrupt accepted record never falls through to a readable inherited one', async () => {
  const root = base()
  await seedInherited(root, 'fork-torn', { skills: [alpha], mcpServers: [], parent: { sessionId: 'parent', revision: 1 } })
  mkdirSync(join(root, 'sessions', 'fork-torn'), { recursive: true })
  writeFileSync(join(root, 'sessions', 'fork-torn', 'selection.json'), '{')
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const result = await preload(root, lifecycle)
  expect(result.blocked).toBe(1)
  expect(lifecycle.snapshotFor('fork-torn')?.reason).toBe('corrupt')
})

test('6.1 preload: an inherited record without parent metadata restores no captured lineage', async () => {
  const root = base()
  await seedInherited(root, 'fork-3', { skills: [alpha], mcpServers: ['docs'] })
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  await preload(root, lifecycle)
  const snapshot = lifecycle.snapshotFor('fork-3')
  expect(snapshot?.state).toBe('ready')
  expect(snapshot?.captured).toBeNull()
  expect(snapshot?.skills.map(identity => identity.name)).toEqual(['alpha'])
})

test('6.1 preload: a fresher in-memory publication wins over both disk records', async () => {
  const root = base()
  await seedInherited(root, 'fork-4', { skills: [alpha], mcpServers: [], parent: { sessionId: 'parent', revision: 1 } })
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const fresher = lifecycle.publish('fork-4', { revision: 7, skills: [beta], mcpServers: ['web'] })
  const result = await preload(root, lifecycle)
  expect(result.loaded).toBe(0)
  expect(lifecycle.snapshotFor('fork-4')).toBe(fresher)
})

test('6.1 preload: an unsupported store reports without touching memory', async () => {
  const lifecycle = createLifecycleSnapshots({ root: base(), platform: 'freebsd' })
  const result = await preloadLifecycleSnapshots({ lifecycle, platform: 'freebsd' })
  expect(result.loaded).toBe(0)
  expect(result.blocked).toBe(0)
  expect(result.unsupported).toBe('platform-unsupported:freebsd')
})

test('6.1 preload: an accepted Apply during the delayed inherited read survives and the next fork inherits it', async () => {
  const root = base()
  const session = 'fork-race-inherited'
  await seedInherited(root, session, { skills: [alpha], mcpServers: ['docs'], parent: { sessionId: 'parent', revision: 1 } })
  const held = delayedRead(root, session, 'inherited')
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const pending = preloadLifecycleSnapshots({
    lifecycle,
    store: openCapabilityStore({ root, platform: 'darwin', fs: held.fs }),
  })
  await held.entered.promise
  // The accepted-Apply seam: an independent store commits revision 1 and the
  // engine publishes the accepted snapshot into the memory authority.
  const writer = openCapabilityStore({ root, platform: 'darwin' })
  const committed = await writer.commit({ kind: 'selection', sessionId: session }, 0, () => ({ skills: [beta], mcpServers: ['web'] }))
  expect(committed.status).toBe('committed')
  const accepted = lifecycle.publish(session, { revision: committed.revision, skills: [beta], mcpServers: ['web'] })
  held.release.resolve()
  const result = await pending
  expect(result.loaded).toBe(0)
  expect(result.blocked).toBe(0)
  expect(lifecycle.peek(session)).toBe(accepted)
  expect(lifecycle.snapshotFor(session)).toBe(accepted)
  expect(lifecycle.snapshotFor(session)?.skills.map(identity => identity.name)).toEqual(['beta'])
  // The next depth-0 fork inherits the accepted set — never the older
  // inherited record the in-flight preload had already read.
  const child = 'fork-of-fork-race'
  lifecycle.agentCreated({ agent: { session: { id: child, header: { delegationDepth: 0, parentSession: session } } } })
  const childSnapshot = lifecycle.snapshotFor(child)
  expect(childSnapshot?.state).toBe('ready')
  expect(childSnapshot?.skills.map(identity => identity.name)).toEqual(['beta'])
  expect(childSnapshot?.mcpServers).toEqual(['web'])
  const inherited = await writer.read({ kind: 'inherited', sessionId: child })
  expect(inherited.kind).toBe('ok')
  expect(inherited.payload.skills.map(identity => identity.name)).toEqual(['beta'])
  expect(inherited.payload.mcpServers).toEqual(['web'])
  expect(inherited.payload.parent.sessionId).toBe(session)
})

test('6.1 preload: an accepted Apply during the delayed accepted-selection read is not overwritten by the stale record', async () => {
  const root = base()
  const session = 'apply-race-selection'
  await seedSelection(root, session, { skills: [alpha], mcpServers: ['docs'] })
  const held = delayedRead(root, session, 'selection')
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const pending = preloadLifecycleSnapshots({
    lifecycle,
    store: openCapabilityStore({ root, platform: 'darwin', fs: held.fs }),
  })
  await held.entered.promise
  const writer = openCapabilityStore({ root, platform: 'darwin' })
  const committed = await writer.commit({ kind: 'selection', sessionId: session }, 1, () => ({ skills: [beta], mcpServers: ['web'] }))
  expect(committed.status).toBe('committed')
  const accepted = lifecycle.publish(session, { revision: committed.revision, skills: [beta], mcpServers: ['web'] })
  held.release.resolve()
  const result = await pending
  expect(result.loaded).toBe(0)
  expect(result.blocked).toBe(0)
  expect(lifecycle.peek(session)).toBe(accepted)
  expect(lifecycle.snapshotFor(session)?.skills.map(identity => identity.name)).toEqual(['beta'])
  expect(lifecycle.snapshotFor(session)?.mcpServers).toEqual(['web'])
})

test('6.1 preload: a delayed corrupt accepted record never marks a fresher ready snapshot BLOCKED', async () => {
  const root = base()
  const session = 'torn-race-selection'
  mkdirSync(join(root, 'sessions', session), { recursive: true })
  writeFileSync(join(root, 'sessions', session, 'selection.json'), '{')
  const held = delayedRead(root, session, 'selection')
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const pending = preloadLifecycleSnapshots({
    lifecycle,
    store: openCapabilityStore({ root, platform: 'darwin', fs: held.fs }),
  })
  await held.entered.promise
  const accepted = lifecycle.publish(session, { revision: 4, skills: [beta], mcpServers: ['web'] })
  held.release.resolve()
  const result = await pending
  expect(result.loaded).toBe(0)
  expect(result.blocked).toBe(0)
  expect(lifecycle.peek(session)).toBe(accepted)
  expect(lifecycle.snapshotFor(session)?.state).toBe('ready')
})

test('6.1 preload: a delayed corrupt inherited record never marks a fresher ready snapshot BLOCKED', async () => {
  const root = base()
  const session = 'torn-race-inherited'
  mkdirSync(join(root, 'sessions', session), { recursive: true })
  writeFileSync(join(root, 'sessions', session, 'inherited.json'), '{')
  const held = delayedRead(root, session, 'inherited')
  const lifecycle = createLifecycleSnapshots({ root, platform: 'darwin' })
  const pending = preloadLifecycleSnapshots({
    lifecycle,
    store: openCapabilityStore({ root, platform: 'darwin', fs: held.fs }),
  })
  await held.entered.promise
  const accepted = lifecycle.publish(session, { revision: 2, skills: [beta], mcpServers: ['web'] })
  held.release.resolve()
  const result = await pending
  expect(result.loaded).toBe(0)
  expect(result.blocked).toBe(0)
  expect(lifecycle.peek(session)).toBe(accepted)
  expect(lifecycle.snapshotFor(session)?.state).toBe('ready')
})
