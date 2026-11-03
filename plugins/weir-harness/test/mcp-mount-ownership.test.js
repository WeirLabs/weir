import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createMcpMountOwnership,
  isSuffixedMcpGroupId,
  resolveMcpGroupIdentity,
} from '../src/capabilities/mcp-mount-ownership.js'
import {
  createMcpMount,
  mcpGroupOptions,
  resolveScopedMcpTree,
} from '../src/capabilities/mcp-mount.js'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function scopedFixture() {
  const entries = new Map()
  const calls = []
  const state = { createGate: null, profileWrites: 0 }
  const add = (id, options = {}) => {
    const fiber = {
      uid: 1, state: 2,
      async dispose() { fiber.uid = null; fiber.state = 5 },
      async await() { return fiber },
    }
    const entry = { id, options: { id, ...options }, fiber }
    entries.set(id, entry)
    tree.store[id] = entry
    return entry
  }
  const tree = {
    store: {}, root: null,
    entries: () => [...entries.values()],
    resolve(id) {
      const entry = entries.get(id)
      if (!entry) throw new Error(`missing ${id}`)
      return entry
    },
    async await() {},
    write() { state.profileWrites += 1 },
  }
  tree.root = {
    tree,
    async create(options) {
      calls.push(['create', options.id])
      if (state.createGate) await state.createGate.promise
      add(options.id, options)
      for (const child of options.config ?? []) add(child.id, child)
      return options.id
    },
    async remove(id) {
      calls.push(['remove', id])
      for (const key of [...entries.keys()]) {
        if (key === id || key.startsWith(`${id}:`) || key === `${id}-facade` || key === `${id}-client`) {
          entries.delete(key)
          delete tree.store[key]
        }
      }
    },
  }
  const resolved = resolveScopedMcpTree(tree)
  assert.equal(resolved.kind, 'ok')
  return { tree, entries, calls, state, ephemeralTree: resolved }
}

const input = (fixture, extras = {}) => ({
  identity: 'shared', generation: 1,
  client: { transport: 'stdio', serverName: 'shared', command: 'node', args: [] },
  fiberOf: async groupId => fixture.tree.resolve(`${groupId}-client`).fiber,
  ...extras,
})

test('allocator claims synchronously, retains unresolved residue, and never migrates a survivor', () => {
  const ownership = createMcpMountOwnership()
  const firstHolder = {}, secondHolder = {}
  const first = ownership.claim('shared', { holder: firstHolder })
  const second = ownership.claim('shared', { holder: secondHolder })
  assert.equal(first.groupId, 'weir-mcp-shared')
  assert.notEqual(second.groupId, first.groupId)
  assert.equal(isSuffixedMcpGroupId(second.groupId), true)
  assert.notEqual(first.owner, second.owner)
  assert.equal(ownership.forGroup(first.groupId), first)
  assert.equal(ownership.forGroup(second.groupId), second)

  assert.equal(ownership.release(first), false)
  ownership.transition(first, 'cleanup-unknown')
  first.pending.add(new Promise(() => {}))
  assert.equal(ownership.release(first, { provenAbsent: true }), false)
  const third = ownership.claim('shared', { holder: {} })
  assert.notEqual(third.groupId, first.groupId)
  assert.notEqual(third.groupId, second.groupId)
  first.pending.clear()
  assert.equal(ownership.release(first, { provenAbsent: true, owner: 'wrong-owner' }), false)
  assert.equal(ownership.release(first, { provenAbsent: true }), true)
  assert.equal(ownership.release(first, { provenAbsent: true }), false)
  // The existing second owner keeps its actual ID; only a later attempt may use
  // the now proven-free legacy ID. There is no survivor migration.
  assert.equal(second.groupId, ownership.forGroup(second.groupId).groupId)
  const fourth = ownership.claim('shared', { holder: {} })
  assert.equal(fourth.groupId, 'weir-mcp-shared')
})

test('residue claims are exact-owner and cannot reuse a foreign or unresolved group', () => {
  const ownership = createMcpMountOwnership()
  const holder = {}
  const residue = ownership.claimResidue({ identity: 'orphan', groupId: 'weir-mcp-orphan', holder })
  assert.equal(ownership.claimResidue({ identity: 'orphan', groupId: residue.groupId, holder: {} }), null)
  assert.equal(ownership.claimResidue({ identity: 'orphan', groupId: residue.groupId, holder }), residue)
  ownership.transition(residue, 'cleanup-failed')
  assert.equal(ownership.claim('orphan', { holder: {} }).groupId === residue.groupId, false)
  assert.equal(ownership.release(residue, { provenAbsent: true }), true)
  assert.equal(ownership.claim('orphan', { holder: {} }).groupId, residue.groupId)
})

test('group identity precedence is own mount, live allocation, facade config, then true legacy only', () => {
  const ownership = createMcpMountOwnership()
  const own = ownership.claim('own', { holder: {} })
  const live = ownership.claim('live', { holder: {} })
  const mounted = new Map([['override', { groupId: own.groupId, generation: 9 }]])
  assert.equal(resolveMcpGroupIdentity({ groupId: own.groupId, mounted, ownership }).source, 'own-mounted')
  assert.equal(resolveMcpGroupIdentity({ groupId: own.groupId, mounted, ownership }).identity, 'override')
  assert.equal(resolveMcpGroupIdentity({ groupId: live.groupId, mounted: new Map(), ownership }).source, 'live-allocation')
  const facadeRow = { id: 'weir-mcp-configured~foreign', config: [{ name: 'weir-harness/mcp-facade-plugin', config: { identity: 'configured', group: 'weir-mcp-configured~foreign' } }] }
  assert.equal(resolveMcpGroupIdentity({ groupId: facadeRow.id, mounted: new Map(), ownership, row: facadeRow }).source, 'facade-config')
  assert.equal(resolveMcpGroupIdentity({ groupId: 'weir-mcp-legacy', mounted: new Map(), ownership }).identity, 'legacy')
  assert.equal(resolveMcpGroupIdentity({ groupId: 'weir-mcp-unknown~suffix', mounted: new Map(), ownership }), null)
})

test('same identity mounts into distinct scoped trees with actual IDs and owner-safe stale unmount', async () => {
  const ownership = createMcpMountOwnership()
  const oldTree = scopedFixture(), newTree = scopedFixture()
  const oldMount = createMcpMount({ ownership, ephemeralTree: oldTree.ephemeralTree })
  const newMount = createMcpMount({ ownership, ephemeralTree: newTree.ephemeralTree })
  const old = await oldMount.mount(input(oldTree))
  const current = await newMount.mount(input(newTree))
  assert.equal(old.groupId, 'weir-mcp-shared')
  assert.notEqual(current.groupId, old.groupId)
  assert.equal(oldTree.calls[0][1], old.groupId)
  assert.equal(newTree.calls[0][1], current.groupId)
  assert.equal(oldTree.entries.get(`${old.groupId}-client`).options.config.serverName, 'shared')
  assert.equal(newTree.entries.get(`${current.groupId}-client`).options.config.serverName, 'shared')
  assert.deepEqual(oldMount.listRows().map(row => row.id), [old.groupId])
  assert.deepEqual(newMount.listRows().map(row => row.id), [current.groupId])
  assert.equal(oldTree.state.profileWrites + newTree.state.profileWrites, 0)
  const publicWire = JSON.stringify({ old, current, mounted: [...oldMount.mounted, ...newMount.mounted], rows: [...oldMount.listRows(), ...newMount.listRows()] })
  for (const record of ownership.records()) assert.equal(publicWire.includes(record.owner), false)

  assert.equal((await oldMount.unmount('shared')).status, 'cleaned')
  assert.equal(newTree.entries.has(current.groupId), true)
  const removes = newTree.calls.filter(([kind]) => kind === 'remove').length
  assert.equal((await oldMount.unmount('shared')).removed, false)
  assert.equal(newTree.calls.filter(([kind]) => kind === 'remove').length, removes)
  assert.equal(ownership.forGroup(current.groupId).identity, 'shared')
  assert.equal((await newMount.unmount('shared')).status, 'cleaned')
  assert.equal(ownership.records().length, 0)
})

test('create timeout retains ownership until create/disposal settle and absence is proven', async () => {
  const ownership = createMcpMountOwnership()
  const oldTree = scopedFixture()
  oldTree.state.createGate = deferred()
  const oldMount = createMcpMount({ ownership, ephemeralTree: oldTree.ephemeralTree, startupTimeoutMs: 5, cleanupTimeoutMs: 5 })
  await assert.rejects(oldMount.mount(input(oldTree)), error => error.status === 'cleanup-unknown')
  const unresolved = ownership.forGroup('weir-mcp-shared')
  assert.equal(unresolved.state, 'cleanup-unknown')
  assert.equal(unresolved.pending.size, 1)

  const newTree = scopedFixture()
  const newMount = createMcpMount({ ownership, ephemeralTree: newTree.ephemeralTree })
  const concurrent = await newMount.mount(input(newTree))
  assert.notEqual(concurrent.groupId, unresolved.groupId)
  await newMount.unmount('shared')

  oldTree.state.createGate.resolve()
  const cleaned = await oldMount.sweepResidueDetailed([unresolved.groupId])
  assert.deepEqual(cleaned.swept, [unresolved.groupId])
  assert.deepEqual(cleaned.blocked, [])
  assert.equal(ownership.forGroup(unresolved.groupId), null)
  assert.equal(oldTree.entries.size, 0)
})

test('residue sweep preserves foreign active and unresolved groups but claims inactive legacy residue', async () => {
  const ownership = createMcpMountOwnership()
  const foreignTree = scopedFixture()
  const foreignMount = createMcpMount({ ownership, ephemeralTree: foreignTree.ephemeralTree })
  const foreign = await foreignMount.mount(input(foreignTree))

  const localTree = scopedFixture()
  const local = createMcpMount({ ownership, ephemeralTree: localTree.ephemeralTree })
  const skipped = await local.sweepResidueDetailed([foreign.groupId])
  assert.deepEqual(skipped.foreign, [foreign.groupId])
  assert.equal(foreignTree.entries.has(foreign.groupId), true)

  const unresolvedId = 'weir-mcp-unknown~suffix'
  await localTree.tree.root.create({ id: unresolvedId, name: 'cordis:group', group: true, config: [] })
  const unresolved = await local.sweepResidueDetailed([unresolvedId])
  assert.deepEqual(unresolved.unresolved, [unresolvedId])
  assert.equal(localTree.entries.has(unresolvedId), true)

  const standaloneId = 'weir-mcp-manager'
  await localTree.tree.root.create({ id: standaloneId, name: 'weir-harness/mcp-manager', config: [] })
  const standalone = await local.sweepResidueDetailed([standaloneId])
  assert.deepEqual(standalone.unresolved, [standaloneId])
  assert.equal(localTree.entries.has(standaloneId), true)
  await localTree.tree.root.remove(standaloneId)

  const legacyId = 'weir-mcp-legacy'
  await localTree.tree.root.create({ id: legacyId, name: 'cordis:group', group: true, config: [] })
  for (const entry of localTree.entries.values()) {
    if (entry.options.id === legacyId) { entry.fiber.uid = null; entry.fiber.state = 5 }
  }
  const cleaned = await local.sweepResidueDetailed([legacyId])
  assert.deepEqual(cleaned.swept, [legacyId])
  assert.equal(localTree.entries.has(legacyId), false)
  assert.equal(ownership.forGroup(legacyId), null)

  await foreignMount.unmount('shared')
  // Clean the deliberately unresolved fixture without turning it into a mount
  // fact; the test only required conservative preservation above.
  await localTree.tree.root.remove(unresolvedId)
})
test('an unprovable cross-module create collision fails without disposing the foreign group', async () => {
  const ownership = createMcpMountOwnership()
  const fixture = scopedFixture()
  const mount = createMcpMount({ ownership, ephemeralTree: fixture.ephemeralTree })
  const foreignOptions = mcpGroupOptions({ identity: 'shared', generation: 1, client: { serverName: 'shared' } })
  await assert.rejects(mount.mount(input(fixture, {
    beforeCreate: async () => {
      await Promise.resolve()
      await fixture.tree.root.create(foreignOptions)
    },
  })), error => error.cause?.code === 'duplicate-mcp-group-owner' || error.code === 'duplicate-mcp-group-owner')
  assert.equal(fixture.entries.has(foreignOptions.id), true)
  assert.equal(fixture.calls.filter(([kind]) => kind === 'remove').length, 0)
  assert.equal(ownership.records().length, 0)
  await fixture.tree.root.remove(foreignOptions.id)
})
test('a global Host legacy group remains authoritative during scoped allocation', async () => {
  const ownership = createMcpMountOwnership()
  const host = scopedFixture()
  const localTree = scopedFixture()
  const hostOptions = mcpGroupOptions({ identity: 'shared', generation: 1, client: { serverName: 'shared' } })
  await host.tree.root.create(hostOptions)
  const mount = createMcpMount({
    loader: { root: host.tree.root }, ownership, ephemeralTree: localTree.ephemeralTree,
  })
  const result = await mount.mount(input(localTree))
  assert.notEqual(result.groupId, hostOptions.id)
  assert.equal(host.entries.has(hostOptions.id), true)
  await mount.unmount('shared')
  assert.equal(host.entries.has(hostOptions.id), true)
  await host.tree.root.remove(hostOptions.id)
})
