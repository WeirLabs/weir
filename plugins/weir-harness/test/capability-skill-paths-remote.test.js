import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  createCapabilityMutationService,
  createCapabilityReadService,
  feedCapabilityReadBridge,
} from '../src/capabilities/capability-remote.js'
import { createSkillScanPathRegistry } from '../src/capabilities/skill-scan-path-registry.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { storePlatformSkip } from './helpers.js'

const platform = process.platform === 'win32' ? 'win32' : 'darwin'

function pathRemoteFixture(t) {
  const base = realpathSync(tmpdir())
  const root = mkdtempSync(join(base, 'weir-path-remote-'))
  const profiles = {
    one: { home: root, name: 'one' },
    two: { home: root, name: 'two' },
  }
  const presets = new Map()
  const agents = new Map()
  const mounts = new Map()
  const releases = []
  const invalidations = []
  const appends = []
  const resumes = []

  function mount(label, readPresetId, profile, onSourceChanged = undefined) {
    const manager = { label }
    const faces = {
      readPresetId,
      provider: {
        sourceChanged() { invalidations.push(label); onSourceChanged?.() },
        status: () => ({}),
        list: async () => ({ candidates: [], complete: true }),
      },
      inventory: async () => ({ candidates: [], roots: [], complete: true }),
      profileContext: () => typeof profile === 'function' ? profile() : profile,
      mcpManager: () => manager,
    }
    releases.push(feedCapabilityReadBridge(faces))
    return { label, manager, faces }
  }

  function bind(sessionId, feed) {
    presets.set(sessionId, feed.faces.readPresetId)
    const ctx = { sessionId }
    agents.set(sessionId, { id: sessionId, ctx })
    mounts.set(ctx, { weirMcpManager: feed.manager })
  }

  const observeSession = async sessionId => {
    const presetId = presets.get(sessionId)
    if (!presetId) throw new Error('unknown session')
    return {
      header: { id: sessionId, cwd: root, agentPreset: presetId },
      projections: { values: { agentPreset: presetId } },
      events: [],
      session: { append: (...args) => { appends.push(args) } },
      agent: { resume: (...args) => { resumes.push(args) } },
      [Symbol.dispose]() {},
    }
  }
  const deps = {
    observeSession,
    agents: () => ({ get: id => agents.get(id) }),
    agentPresets: () => ({ serviceFor: (agent, name) => mounts.get(agent.ctx)?.[name] }),
  }
  const openStore = profile => openCapabilityStore({ profileContext: profile, platform, liveness: createStubLiveness() })
  const read = createCapabilityReadService(deps)
  const mutations = createCapabilityMutationService(deps)
  t.after(() => {
    for (const release of releases.reverse()) release()
    assert.equal(dirname(resolve(root)), base)
    rmSync(root, { recursive: true, force: true })
  })
  return { root, profiles, presets, invalidations, appends, resumes, deps, openStore, read, mutations, mount, bind }
}

test('path remotes preserve exact owners, CAS, same-Profile multi-revision invalidation and transcript silence', { skip: storePlatformSkip }, async t => {
  const f = pathRemoteFixture(t)
  const old = f.mount('normal-old', 'weir', f.profiles.one)
  const current = f.mount('normal-new', 'weir', f.profiles.one)
  const creative = f.mount('creative-current', 'weir-creative', f.profiles.one)
  const foreign = f.mount('creative-foreign', 'weir-creative', f.profiles.two)
  f.bind('old-session', old)
  f.bind('new-session', current)
  f.bind('creative-session', creative)
  f.bind('foreign-session', foreign)
  mkdirSync(join(f.root, 'library'))
  mkdirSync(join(f.root, 'other'))
  const canonical = realpathSync(join(f.root, 'library'))

  assert.deepEqual(await f.read.skillPaths('old-session'), { status: 'ok', revision: 0, paths: [] })
  const saved = await f.mutations.skillPathAdd('old-session', { path: join(f.root, 'library'), expectedRevision: 0 })
  assert.deepEqual(saved, { status: 'saved', saved: true, revision: 1, paths: [canonical], error: null })
  assert.deepEqual(f.invalidations, ['normal-old', 'normal-new', 'creative-current'])
  assert.deepEqual(await f.read.skillPaths('new-session'), { status: 'ok', revision: 1, paths: [canonical] })
  assert.deepEqual(await f.read.skillPaths('creative-session'), { status: 'ok', revision: 1, paths: [canonical] })
  assert.deepEqual(await f.read.skillPaths('foreign-session'), { status: 'ok', revision: 0, paths: [] })

  const stale = await f.mutations.skillPathAdd('new-session', { path: join(f.root, 'other'), expectedRevision: 0 })
  assert.equal(stale.status, 'revision-conflict')
  assert.equal(stale.saved, false)
  assert.equal(stale.revision, 1)
  assert.deepEqual(stale.paths, [canonical])
  const duplicate = await f.mutations.skillPathAdd('new-session', { path: canonical, expectedRevision: 1 })
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.saved, false)
  assert.equal(f.invalidations.length, 3, 'failed writes and no-ops do not broaden or invalidate discovery')

  const removed = await f.mutations.skillPathRemove('old-session', { path: canonical, expectedRevision: 1 })
  assert.deepEqual(removed, { status: 'removed', saved: true, revision: 2, paths: [], error: null })
  assert.deepEqual(f.invalidations, [
    'normal-old', 'normal-new', 'creative-current',
    'normal-old', 'normal-new', 'creative-current',
  ])
  assert.deepEqual(await f.read.skillPaths('new-session'), { status: 'ok', revision: 2, paths: [] })
  assert.deepEqual(await f.read.skillPaths('foreign-session'), { status: 'ok', revision: 0, paths: [] })
  assert.deepEqual(f.appends, [])
  assert.deepEqual(f.resumes, [])
})

test('a corrupt registry is a read value and a failed remote write, never an empty fallback', { skip: storePlatformSkip }, async t => {
  const f = pathRemoteFixture(t)
  const owner = f.mount('owner', 'weir', f.profiles.one)
  f.bind('s', owner)
  const dir = join(f.root, 'weir', 'profiles', 'one', 'capabilities', 'skills')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'scan-paths.json'), 'not json')
  mkdirSync(join(f.root, 'library'))

  const read = await f.read.skillPaths('s')
  assert.equal(read.status, 'unavailable')
  assert.equal(read.error.code, 'corrupt')
  const result = await f.mutations.skillPathAdd('s', { path: join(f.root, 'library'), expectedRevision: 0 })
  assert.equal(result.status, 'unreadable')
  assert.equal(result.saved, false)
  assert.deepEqual(f.invalidations, [])
  assert.equal(readFileSync(join(dir, 'scan-paths.json'), 'utf8'), 'not json')
  assert.deepEqual(f.appends, [])
})


test('landed invalidation failure reports saved facts, attempts every same-Profile provider, and never rolls back', { skip: storePlatformSkip }, async t => {
  const f = pathRemoteFixture(t)
  const owner = f.mount('broken-owner', 'weir', f.profiles.one, () => { throw new Error('invalidate broke') })
  const siblingRevision = f.mount('healthy-revision', 'weir', f.profiles.one)
  const creative = f.mount('healthy-creative', 'weir-creative', f.profiles.one)
  const foreign = f.mount('foreign', 'weir', f.profiles.two)
  f.bind('s', owner)
  f.bind('sibling', siblingRevision)
  mkdirSync(join(f.root, 'library'))

  const result = await f.mutations.skillPathAdd('s', { path: join(f.root, 'library'), expectedRevision: 0 })
  assert.equal(result.status, 'invalidation-failed')
  assert.equal(result.saved, true)
  assert.equal(result.revision, 1)
  assert.deepEqual(result.paths, [realpathSync(join(f.root, 'library'))])
  assert.equal(result.error.code, 'invalidation-failed')
  assert.match(result.error.message, /invalidate broke/)
  assert.deepEqual(f.invalidations, ['broken-owner', 'healthy-revision', 'healthy-creative'])
  const durable = await createSkillScanPathRegistry({ store: f.openStore(f.profiles.one), platform }).read()
  assert.equal(durable.revision, 1)
  assert.deepEqual(durable.paths, result.paths)
  const foreignState = await createSkillScanPathRegistry({ store: f.openStore(f.profiles.two), platform }).read()
  assert.deepEqual(foreignState, { status: 'ok', revision: 0, paths: [] })
  assert.deepEqual(f.appends, [])
})

test('an owner change before the CAS prevents the write and causes no invalidation', { skip: storePlatformSkip }, async t => {
  const f = pathRemoteFixture(t)
  const owner = f.mount('old-owner', 'weir', f.profiles.one)
  f.mount('new-owner', 'weir-creative', f.profiles.one)
  f.bind('s', owner)
  mkdirSync(join(f.root, 'library'))
  const mutations = createCapabilityMutationService({
    ...f.deps,
    skillPathRegistry: profile => createSkillScanPathRegistry({
      store: f.openStore(profile), platform,
      fs: {
        realpath: async path => { f.presets.set('s', 'weir-creative'); return realpath(path) },
        stat, access,
      },
    }),
  })
  const result = await mutations.skillPathAdd('s', { path: join(f.root, 'library'), expectedRevision: 0 })
  assert.equal(result.status, 'owner-changed')
  assert.equal(result.saved, false)
  assert.equal(result.error.code, 'owner-changed')
  assert.deepEqual(f.invalidations, [])
  assert.deepEqual(await createSkillScanPathRegistry({ store: f.openStore(f.profiles.one), platform }).read(), { status: 'ok', revision: 0, paths: [] })
})

test('an owner change after a durable commit preserves actual revision and paths', { skip: storePlatformSkip }, async t => {
  const f = pathRemoteFixture(t)
  const owner = f.mount('old-owner', 'weir', f.profiles.one, () => { f.presets.set('s', 'weir-creative') })
  f.mount('new-owner', 'weir-creative', f.profiles.one)
  f.bind('s', owner)
  mkdirSync(join(f.root, 'library'))

  const result = await f.mutations.skillPathAdd('s', { path: join(f.root, 'library'), expectedRevision: 0 })
  assert.equal(result.status, 'owner-changed')
  assert.equal(result.ownerChanged, true)
  assert.equal(result.saved, true)
  assert.equal(result.revision, 1)
  assert.deepEqual(result.paths, [realpathSync(join(f.root, 'library'))])
  assert.equal(result.error.code, 'owner-changed')
  assert.deepEqual(f.invalidations, ['old-owner', 'new-owner'])
  const durable = await createSkillScanPathRegistry({ store: f.openStore(f.profiles.one), platform }).read()
  assert.equal(durable.revision, 1)
  assert.deepEqual(durable.paths, result.paths)
  assert.deepEqual(f.appends, [])
})
