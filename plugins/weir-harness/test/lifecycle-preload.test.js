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
