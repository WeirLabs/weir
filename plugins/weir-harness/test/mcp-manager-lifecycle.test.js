import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpManager } from '../src/capabilities/mcp-manager.js'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createMcpFacade } from '../src/capabilities/mcp-facade.js'
import { mcpFacadeBridgeFor } from '../src/capabilities/mcp-facade-plugin.js'

const entry = (identity, incarnation = null) => ({ identity, label: identity, owner: { kind: 'global', key: 'installation' }, generation: 0, configuredAt: 0, transport: { kind: 'stdio', ref: 'cmd:node' }, client: { transport: 'stdio', serverName: identity, command: process.execPath, args: [], env: {} }, ...(incarnation ? { incarnation } : {}) })
function mountFixture() {
  const mounted = new Map()
  const calls = []
  const state = { failMount: false, wrongGeneration: false, delay: null }
  const mount = {
    mounted, calls, state,
    async sweepResidue() { return [] },
    async mount(options) {
      calls.push(['mount', options.identity, options.generation])
      if (state.failMount) throw new Error('injected strict startup failure')
      await options.beforeCreate?.({ groupId: options.groupId ?? `weir-mcp-${options.identity}`, identity: options.identity, generation: options.generation })
      const bridge = mcpFacadeBridgeFor(`weir-mcp-${options.identity}`)
      bridge?.onRegister?.(`mcp__${options.identity}__echo`)
      await options.readback?.()
      const generation = state.wrongGeneration ? options.generation + 1 : options.generation
      mounted.set(options.identity, { groupId: `weir-mcp-${options.identity}`, generation, state: 'mounted' })
      return { status: 'mounted', groupId: `weir-mcp-${options.identity}`, generation: options.generation, discovery: options.discovery ? await options.discovery() : { toolCount: 0, toolNamesPreview: [], truncated: false } }
    },
    async unmount(identity) {
      calls.push(['unmount', identity])
      if (state.delay) await state.delay
      mounted.delete(identity)
      return { status: 'cleaned', removed: true }
    },
    async probe(options) {
      calls.push(['probe', options.identity])
      if (state.failProbe) throw new Error('injected probe failure: connection refused')
      const identity = 'probe-1'
      await options.beforeCreate?.({ groupId: 'weir-mcp-probe-1', identity, generation: 0 })
      const discovery = await options.discovery?.({ identity, generation: 0 })
      await options.afterCleanup?.({ groupId: 'weir-mcp-probe-1', identity, generation: 0 })
      return { status: 'mounted', discovery, cleanup: { status: 'cleaned' } }
    },
  }
  return mount
}
async function fixture({ entries = ['docs', 'web'], mount = mountFixture(), agents = null, selectionFor = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weir-mcp-manager-life-'))
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const registry = createMcpRegistry({ store, newIncarnation: () => null })
  let revision = 0
  for (const identity of entries) {
    const result = await registry.register(entry(identity), revision)
    revision = result.revision
  }
  const listeners = new Map()
  const services = new Map()
  const lifecycle = { snapshotFor: sessionId => selectionFor
    ? selectionFor(sessionId)
    : { state: 'ready', mcpServers: ['docs', 'web'], mcpIncarnations: Object.fromEntries(entries.map(identity => [identity, null])) } }
  const manager = createMcpManager({ registry, mount, lifecycle, agents, listRows: () => [], listEntryIds: () => [] })
  const ctx = {
    get: name => name === 'agents' ? agents : undefined,
    on(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]) },
    reflect: { provide: (key, value) => services.set(key, value) },
    logger: { warn() {} },
  }
  const dispose = manager(ctx, {})
  const face = services.get('weirMcpManager')
  await face.start()
  return { root, store, registry, mount, listeners, services, face, lifecycle, dispose }
}

function visibilityAgent(sessionId) {
  const state = { calls: [], disposals: [], failRestrict: false }
  const agent = {
    session: { id: sessionId },
    ctx: { tools: { restrict(input) {
      state.calls.push(input)
      if (state.failRestrict) throw new Error(`injected restrict failure for ${sessionId}`)
      let active = true
      return () => {
        if (!active) return
        active = false
        state.disposals.push(input.deny[0])
      }
    } } },
  }
  return { agent, state }
}

async function sameNameFailureFixture({ failHostRollback = false } = {}) {
  const previous = visibilityAgent('session-previous')
  const added = visibilityAgent('session-added')
  const bad = visibilityAgent('session-bad')
  bad.state.failRestrict = true
  const live = [previous.agent]
  const agents = {
    list: () => [...live],
    get: sessionId => live.find(agent => agent.session.id === sessionId),
  }
  const name = 'mcp__docs__echo'
  const hostOwners = new Map([[name, []]])
  const selected = {}
  const mount = mountFixture()
  mount.mount = async options => {
    const groupId = `weir-mcp-${options.identity}`
    await options.beforeCreate?.({ groupId, identity: options.identity, generation: options.generation })
    const bridge = mcpFacadeBridgeFor(groupId)
    const facade = createMcpFacade({
      ...bridge,
      host: { tools: { register(definition) {
        const stack = hostOwners.get(name)
        const record = { identity: options.identity, definition }
        stack.push(record)
        let active = true
        return () => {
          if (!active) return
          if (options.identity === 'web' && failHostRollback) throw new Error('injected same-name Host rollback failure')
          active = false
          const index = stack.indexOf(record)
          if (index >= 0) stack.splice(index, 1)
        }
      } } },
    })
    facade.tools.register({ name, execute: async () => {} })
    await options.readback?.()
    mount.mounted.set(options.identity, { groupId, generation: options.generation, state: 'mounted' })
    return { status: 'mounted', groupId, generation: options.generation, discovery: await options.discovery() }
  }
  const f = await fixture({
    entries: ['docs'], mount, agents,
    selectionFor: sessionId => ({
      state: 'ready',
      mcpServers: [...(selected[sessionId] ?? [])],
      mcpIncarnations: Object.fromEntries((selected[sessionId] ?? []).map(identity => [identity, null])),
    }),
  })

  // The old Host registration and deny already exist. The replacement then
  // reuses the old deny, adds one new deny, and fails on the final agent.
  live.push(added.agent, bad.agent)
  const current = await f.registry.read()
  await f.registry.register(entry('web'), current.revision)
  const registered = (await f.registry.read()).servers.web
  const failed = await f.face.reconcileOne('web', registered)
  return { ...f, previous, added, bad, name, hostOwners, failed, selected }
}

test('startup and targeted reconcile share strict readback; siblings never remount', async () => {
  const f = await fixture()
  expect(f.face.list).toBeTruthy()
  const initial = await f.face.list()
  expect(initial.managed.map(row => row.state)).toEqual(['mounted', 'mounted'])
  const docsBefore = f.mount.mounted.get('docs').generation
  const webBefore = f.mount.mounted.get('web').generation
  const current = await f.registry.read()
  await f.registry.register(current.servers.docs, current.revision)
  const updated = (await f.registry.read()).servers.docs
  const result = await f.face.reconcileOne('docs', updated)
  expect(result.status).toBe('mounted')
  expect(result.mount.observedGeneration).toBe(docsBefore + 1)
  expect(f.mount.mounted.get('web').generation).toBe(webBefore)
  expect(f.mount.calls.filter(call => call[0] === 'mount' && call[1] === 'web')).toHaveLength(1)
  expect(f.mount.mounted.get('docs').generation).toBe(docsBefore + 1)
})

test('a wrong mounted generation is saved-degraded and never opens admission', async () => {
  const mount = mountFixture()
  mount.state.wrongGeneration = true
  const f = await fixture({ entries: ['docs'], mount })
  const row = (await f.face.list()).managed[0]
  expect(row.state).toBe('degraded')
  expect(row.discovery.toolCount).toBeNull()
  expect(row.lastMount.status).toBe('saved-degraded')
  expect(row.startErrors.length).toBeGreaterThan(0)
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(false)
})

test('generation-owned public names are cleaned precisely and schema/prompt checks follow runtime phase', async () => {
  const f = await fixture({ entries: ['docs'] })
  expect(f.face.publicNames.get('mcp__docs__echo').generation).toBe(1)
  // A newer generation's fact exists before the old bridge finishes cleanup.
  f.face.publicNames.set('mcp__docs__echo', { identity: 'docs', generation: 2 })
  const current = await f.registry.read()
  await f.registry.register(current.servers.docs, current.revision)
  const token = f.face.beginOperation('docs')
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(false)
  const restricted = []
  for (const listener of f.listeners.get('agent/created')) listener({ agent: { session: { id: 's1' }, ctx: { tools: { restrict: value => restricted.push(value) } } } })
  expect(restricted).toEqual([{ deny: ['mcp__docs__echo'] }])
  const result = await f.face.reconcileOne('docs', (await f.registry.read()).servers.docs, token)
  expect(result.status).toBe('mounted')
  expect(f.face.publicNames.get('mcp__docs__echo').generation).toBe(2)
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(true)
  await f.face.removeRuntime('docs')
  expect(f.face.publicNames.size).toBe(0)
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(false)
})

test('pre-commit restoration cannot overwrite a later operation; failed mount stays closed and sibling facts survive', async () => {
  const f = await fixture({ entries: ['docs', 'web'] })
  const first = f.face.beginOperation('docs')
  const second = f.face.beginOperation('docs')
  expect(f.face.abortOperation(first)).toBe(false)
  expect(f.face.runtime.snapshot('docs').operationId).toBe(second.operationId)
  f.mount.state.failMount = true
  const result = await f.face.reconcileOne('docs', (await f.registry.read()).servers.docs, second)
  expect(result.status).toBe('saved-degraded')
  expect(f.face.runtime.snapshot('docs').phase).toBe('saved-degraded')
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'docs')).toBe(false)
  expect(f.face.publicNames.has('mcp__web__echo')).toBe(true)
  expect(f.face.gate.enabledFor({ session: { id: 's1' } }, 'web')).toBe(true)
})

test('probe cleans bridge/public facts and changes no registry or selection', async () => {
  const f = await fixture({ entries: ['docs'] })
  const beforeRegistry = JSON.stringify(await f.registry.read())
  await f.store.commit({ kind: 'selection', sessionId: 's1' }, 0, () => ({ skills: [], mcpServers: ['docs'] }))
  const result = await f.face.probe((await f.registry.read()).servers.docs)
  expect(result.status).toBe('mounted')
  expect(result.discovery.toolCount).toBe(0)
  expect(f.face.publicNames.has('mcp__probe-1__echo')).toBe(false)
  expect(JSON.stringify(await f.registry.read())).toBe(beforeRegistry)
  expect((await f.store.read({ kind: 'selection', sessionId: 's1' })).payload.mcpServers).toEqual(['docs'])
})

test('an absent registry is a healthy empty inventory with support facts, not an unavailable warning', async () => {
  const f = await fixture({ entries: [] })
  const listing = await f.face.list()
  expect(listing.managed).toEqual([])
  expect(listing.unavailable).toBeUndefined()
  expect(listing.registryRevision).toBe(0)
  expect(listing.warnings).toEqual([])
  expect(listing.capabilities).toEqual({ credentials: false, ephemeral: false })
})

test('a later successful mount clears that identity\'s stale start errors and keeps siblings\' errors', async () => {
  const mount = mountFixture()
  mount.state.failMount = true
  const f = await fixture({ entries: ['docs', 'web'], mount })
  let rows = (await f.face.list()).managed
  expect(rows.every(row => row.startErrors.length > 0)).toBe(true)
  mount.state.failMount = false
  const current = await f.registry.read()
  await f.registry.register(current.servers.docs, current.revision)
  const result = await f.face.reconcileOne('docs', (await f.registry.read()).servers.docs)
  expect(result.status).toBe('mounted')
  rows = (await f.face.list()).managed
  expect(rows.find(row => row.identity === 'docs').startErrors).toEqual([])
  expect(rows.find(row => row.identity === 'web').startErrors.length).toBeGreaterThan(0)
})

test('a failed Test leaves its sanitized diagnostic on the row where the panel reads it', async () => {
  const mount = mountFixture()
  const f = await fixture({ entries: ['docs'], mount })
  mount.state.failProbe = true
  const result = await f.face.probe((await f.registry.read()).servers.docs)
  expect(result.status).toBe('probe-failed')
  const row = (await f.face.list()).managed[0]
  expect(row.lastTest.status).toBe('probe-failed')
  expect(row.lastTest.diagnostic.message).toContain('injected probe failure')
  expect(row.lastTest.diagnostic.code).toBe(result.error.code)
})

test('live visibility: a managed tool registered after agent creation is denied on the live non-selected agent', async () => {
  const f = await fixture({ entries: [] })
  f.lifecycle.snapshotFor = () => ({ state: 'ready', mcpServers: [], mcpIncarnations: {} })
  const restricted = []
  const agent = {
    session: { id: 's1' },
    ctx: { tools: { restrict(input) { restricted.push(input); return () => {} } } },
  }
  // The agent is already live before the facade reports any public tool name.
  for (const listener of f.listeners.get('agent/created')) listener({ agent })

  await f.registry.register(entry('docs'), 0)
  const result = await f.face.reconcileOne('docs', (await f.registry.read()).servers.docs)
  expect(result.status).toBe('mounted')
  expect(f.face.publicNames.has('mcp__docs__echo')).toBe(true)
  expect(restricted).toEqual([{ deny: ['mcp__docs__echo'] }])
})

test('live visibility: agents.list bootstraps existing agents, mounted releases only selected agents, and syncSession is A/B scoped', async () => {
  const a = visibilityAgent('session-a')
  const b = visibilityAgent('session-b')
  const live = [a.agent, b.agent]
  const selected = { 'session-a': [], 'session-b': ['docs'] }
  const agents = {
    list: () => [...live],
    get: sessionId => live.find(agent => agent.session.id === sessionId),
  }
  const f = await fixture({
    entries: ['docs'], agents,
    selectionFor: sessionId => ({
      state: 'ready', mcpServers: [...(selected[sessionId] ?? [])],
      mcpIncarnations: Object.fromEntries((selected[sessionId] ?? []).map(identity => [identity, null])),
    }),
  })
  const name = 'mcp__docs__echo'
  // Registration happened during replacing, so both were denied first; only
  // the selected agent's deny is released by the actual mounted transition.
  expect(a.state.calls).toEqual([{ deny: [name] }])
  expect(b.state.calls).toEqual([{ deny: [name] }])
  expect(a.state.disposals).toEqual([])
  expect(b.state.disposals).toEqual([name])
  f.face.syncSession('session-a')
  f.face.syncSession('session-b')
  expect(a.state.calls).toHaveLength(1)
  expect(b.state.calls).toHaveLength(1)
  expect(b.state.disposals).toEqual([name])

  selected['session-a'] = ['docs']
  f.face.syncSession('session-a')
  expect(a.state.disposals).toEqual([name])
  expect(b.state.calls).toHaveLength(1)
  expect(b.state.disposals).toEqual([name])
  selected['session-b'] = []
  f.face.syncSession('session-a') // must not fan out to B
  expect(b.state.calls).toHaveLength(1)
  f.face.syncSession('session-b')
  expect(b.state.calls).toEqual([{ deny: [name] }, { deny: [name] }])
  expect(a.state.calls).toHaveLength(1)
})

test('live visibility: disposal removes only the exact agent object and manager teardown keeps unconfirmed denies', async () => {
  const oldA = visibilityAgent('session-a')
  const newA = visibilityAgent('session-a')
  const b = visibilityAgent('session-b')
  const live = [oldA.agent, b.agent]
  const agents = {
    list: () => [...live],
    get: sessionId => live.find(agent => agent.session.id === sessionId),
  }
  const f = await fixture({
    entries: ['docs'], agents,
    selectionFor: () => ({ state: 'ready', mcpServers: [], mcpIncarnations: {} }),
  })
  const name = 'mcp__docs__echo'
  expect(oldA.state.calls).toEqual([{ deny: [name] }])
  expect(b.state.calls).toEqual([{ deny: [name] }])

  live[0] = newA.agent
  for (const listener of f.listeners.get('agent/created')) listener({ agent: newA.agent })
  expect(newA.state.calls).toEqual([{ deny: [name] }])
  for (const listener of f.listeners.get('agent/disposed')) listener({ agent: oldA.agent })
  expect(oldA.state.disposals).toEqual([name])
  expect(newA.state.disposals).toEqual([])
  expect(b.state.disposals).toEqual([])
  f.face.syncSession('session-a')
  expect(newA.state.calls).toHaveLength(1)

  for (const listener of f.listeners.get('agent/disposed')) listener({ agent: newA.agent })
  expect(newA.state.disposals).toEqual([name])
  expect(b.state.disposals).toEqual([])
  f.dispose()
  // The public tool was never confirmed unregistered, so teardown must not
  // lift B's manager-owned deny merely to release memory.
  expect(b.state.disposals).toEqual([])
})

test('live visibility: unregister/re-register converges denies and stale-generation cleanup cannot touch the replacement', async () => {
  const a = visibilityAgent('session-a')
  const agents = { list: () => [a.agent], get: () => a.agent }
  const f = await fixture({
    entries: ['docs'], agents,
    selectionFor: () => ({ state: 'ready', mcpServers: [], mcpIncarnations: {} }),
  })
  const name = 'mcp__docs__echo'
  const oldBridge = mcpFacadeBridgeFor('weir-mcp-docs')
  expect(a.state.calls).toEqual([{ deny: [name] }])

  const current = await f.registry.read()
  await f.registry.register(current.servers.docs, current.revision)
  const remounted = await f.face.reconcileOne('docs', (await f.registry.read()).servers.docs)
  expect(remounted.status).toBe('mounted')
  expect(f.face.publicNames.get(name).generation).toBe(2)
  expect(a.state.calls).toHaveLength(2)
  expect(a.state.disposals).toEqual([name])

  oldBridge.onUnregister(name)
  expect(f.face.publicNames.get(name).generation).toBe(2)
  expect(a.state.disposals).toEqual([name])
  expect((await f.face.removeRuntime('docs')).status).toBe('removed')
  expect(f.face.publicNames.has(name)).toBe(false)
  expect(a.state.disposals).toEqual([name, name])

  const reregistered = await f.face.reconcileOne('docs', (await f.registry.read()).servers.docs)
  expect(reregistered.status).toBe('mounted')
  expect(f.face.publicNames.get(name).generation).toBe(2)
  expect(a.state.calls).toHaveLength(3)
  expect(a.state.disposals).toEqual([name, name])
  f.face.syncSession('session-a')
  expect(a.state.calls).toHaveLength(3)
})

test('live visibility: failed registration rolls back the new fact and every partial deny after confirmed Host cleanup', async () => {
  const good = visibilityAgent('session-good')
  const bad = visibilityAgent('session-bad')
  bad.state.failRestrict = true
  const live = [good.agent, bad.agent]
  const agents = {
    list: () => [...live],
    get: sessionId => live.find(agent => agent.session.id === sessionId),
  }
  const name = 'mcp__docs__echo'
  const mount = mountFixture()
  const strictMount = mount.mount
  mount.mount = async options => {
    try { return await strictMount(options) } catch (cause) {
      // This mock has confirmed Host disposal; owner cleanup may now proceed.
      mcpFacadeBridgeFor(`weir-mcp-${options.identity}`)?.onUnregister?.(name)
      throw cause
    }
  }
  const f = await fixture({
    entries: [], mount, agents,
    selectionFor: () => ({ state: 'ready', mcpServers: [], mcpIncarnations: {} }),
  })
  await f.registry.register(entry('docs'), 0)
  const registered = (await f.registry.read()).servers.docs
  const failed = await f.face.reconcileOne('docs', registered)
  expect(failed.status).toBe('saved-degraded')
  expect(f.face.publicNames.has(name)).toBe(false)
  expect(good.state.calls).toEqual([{ deny: [name] }])
  expect(good.state.disposals).toEqual([name])
  expect(bad.state.calls).toEqual([{ deny: [name] }])
  expect(bad.state.disposals).toEqual([])

  bad.state.failRestrict = false
  const retried = await f.face.reconcileOne('docs', registered)
  expect(retried.status).toBe('mounted')
  expect(f.face.publicNames.has(name)).toBe(true)
  expect(good.state.calls).toHaveLength(2)
  expect(bad.state.calls).toHaveLength(2)
  expect(good.state.disposals).toEqual([name])
})

test('live visibility: compound registration and Host rollback failure retains owner facts and every deny until confirmed cleanup', async () => {
  const first = visibilityAgent('session-first')
  const bad = visibilityAgent('session-bad')
  const last = visibilityAgent('session-last')
  bad.state.failRestrict = true
  const live = [first.agent, bad.agent, last.agent]
  const agents = {
    list: () => [...live],
    get: sessionId => live.find(agent => agent.session.id === sessionId),
  }
  const name = 'mcp__docs__echo'
  const hostTools = new Set()
  let failHostRemoval = true
  let hostDisposer
  const mount = mountFixture()
  mount.mount = async options => {
    const groupId = `weir-mcp-${options.identity}`
    await options.beforeCreate?.({ groupId, identity: options.identity, generation: options.generation })
    const bridge = mcpFacadeBridgeFor(groupId)
    const facade = createMcpFacade({
      ...bridge,
      host: { tools: { register(definition) {
        hostTools.add(definition.name)
        hostDisposer = () => {
          if (failHostRemoval) throw new Error('injected Host rollback failure')
          hostTools.delete(definition.name)
        }
        return hostDisposer
      } } },
    })
    facade.tools.register({ name, execute: async () => {} })
  }
  const f = await fixture({
    entries: [], mount, agents,
    selectionFor: () => ({ state: 'ready', mcpServers: [], mcpIncarnations: {} }),
  })
  await f.registry.register(entry('docs'), 0)
  const registered = (await f.registry.read()).servers.docs
  const failed = await f.face.reconcileOne('docs', registered)
  expect(failed.status).toBe('saved-degraded')
  expect({
    hostTools: [...hostTools],
    owner: f.face.publicNames.get(name),
    firstDenies: first.state.calls,
    firstDisposals: first.state.disposals,
    lastDenies: last.state.calls,
    lastDisposals: last.state.disposals,
  }).toEqual({
    hostTools: [name],
    owner: { identity: 'docs', generation: 1 },
    firstDenies: [{ deny: [name] }],
    firstDisposals: [],
    lastDenies: [{ deny: [name] }],
    lastDisposals: [],
  })

  // Residue recovery may release the retained facts only after Host removal is
  // actually confirmed; it must not expose an unowned still-registered tool.
  failHostRemoval = false
  hostDisposer()
  expect([...hostTools]).toEqual([])
  expect((await f.face.removeRuntime('docs')).status).toBe('removed')
  expect(f.face.publicNames.has(name)).toBe(false)
  expect(first.state.disposals).toEqual([name])
  expect(last.state.disposals).toEqual([name])
})

test('live visibility: confirmed same-name rollback restores the previous Host owner and its deny', async () => {
  const f = await sameNameFailureFixture()
  expect(f.failed.status).toBe('saved-degraded')
  expect(f.hostOwners.get(f.name).map(record => record.identity)).toEqual(['docs'])
  expect({
    owner: f.face.publicNames.get(f.name),
    previousCalls: f.previous.state.calls,
    previousDisposals: f.previous.state.disposals,
  }).toEqual({
    owner: { identity: 'docs', generation: 1 },
    previousCalls: [{ deny: [f.name] }],
    previousDisposals: [],
  })
  expect(f.added.state.calls).toEqual([{ deny: [f.name] }])
  expect(f.added.state.disposals).toEqual([f.name])
  expect(f.bad.state.disposals).toEqual([])

  // Restored per-agent metadata belongs to docs too: an unrelated web runtime
  // sync cannot touch it, while the explicit docs visibility sync still can.
  f.selected['session-previous'] = ['docs']
  f.face.beginOperation('web')
  expect(f.previous.state.disposals).toEqual([])
  f.face.syncSession('session-previous')
  expect(f.previous.state.disposals).toEqual([f.name])
})

test('live visibility: same-name rollback recreates a previous deny removed during failed sync', async () => {
  const previous = visibilityAgent('session-previous')
  const added = visibilityAgent('session-added')
  const bad = visibilityAgent('session-bad')
  bad.state.failRestrict = true
  const live = [previous.agent]
  const agents = { list: () => [...live], get: () => null }
  const selected = { 'session-previous': [] }
  const f = await fixture({
    entries: ['docs'], agents,
    selectionFor: sessionId => ({
      state: 'ready', mcpServers: [...(selected[sessionId] ?? [])], mcpIncarnations: { docs: null },
    }),
  })
  const name = 'mcp__docs__echo'
  selected['session-previous'] = ['docs']
  live.push(added.agent, bad.agent)
  const facade = createMcpFacade({
    ...mcpFacadeBridgeFor('weir-mcp-docs'),
    host: { tools: { register() { return () => {} } } },
  })

  // The selected agent's old deny is removed first, then a later agent fails.
  // Confirmed Host rollback must restore that removed deny as well as the fact.
  expect(() => facade.tools.register({ name, execute: async () => {} })).toThrow(/injected restrict failure/)
  expect(f.face.publicNames.get(name)).toEqual({ identity: 'docs', generation: 1 })
  expect(previous.state.calls).toEqual([{ deny: [name] }, { deny: [name] }])
  expect(previous.state.disposals).toEqual([name])
  expect(added.state.disposals).toEqual([name])
})

test('live visibility: unconfirmed same-name Host rollback retains replacement owner and all current denies', async () => {
  const f = await sameNameFailureFixture({ failHostRollback: true })
  expect(f.failed.status).toBe('saved-degraded')
  expect(f.hostOwners.get(f.name).map(record => record.identity)).toEqual(['docs', 'web'])
  expect(f.face.publicNames.get(f.name)).toEqual({ identity: 'web', generation: 1 })
  expect(f.previous.state.calls).toEqual([{ deny: [f.name] }])
  expect(f.previous.state.disposals).toEqual([])
  expect(f.added.state.calls).toEqual([{ deny: [f.name] }])
  expect(f.added.state.disposals).toEqual([])
  expect(f.bad.state.disposals).toEqual([])
})

test('live visibility: selected mount stays denied while degraded, recovers on mounted, and stale abort cannot reopen it', async () => {
  const mount = mountFixture()
  mount.state.wrongGeneration = true
  const a = visibilityAgent('session-a')
  const agents = { list: () => [a.agent], get: () => a.agent }
  const f = await fixture({
    entries: ['docs'], mount, agents,
    selectionFor: () => ({ state: 'ready', mcpServers: ['docs'], mcpIncarnations: { docs: null } }),
  })
  const name = 'mcp__docs__echo'
  expect(f.face.runtime.snapshot('docs').phase).toBe('saved-degraded')
  expect(f.face.gate.enabledFor(a.agent, 'docs')).toBe(false)
  expect(a.state.calls).toEqual([{ deny: [name] }])
  expect(a.state.disposals).toEqual([])

  mount.state.wrongGeneration = false
  const current = await f.registry.read()
  await f.registry.register(current.servers.docs, current.revision)
  const recovery = await f.face.recoverResidue({ identity: 'docs' })
  expect(recovery.status).toBe('recovered')
  expect(recovery.results.map(result => result.status)).toEqual(['mounted'])
  expect(f.face.gate.enabledFor(a.agent, 'docs')).toBe(true)
  expect(a.state.calls).toHaveLength(2)
  expect(a.state.disposals).toEqual([name, name])

  const restoring = f.face.beginOperation('docs')
  expect(a.state.calls).toHaveLength(3)
  expect(f.face.abortOperation(restoring)).toBe(true)
  expect(f.face.gate.enabledFor(a.agent, 'docs')).toBe(true)
  expect(a.state.disposals).toHaveLength(3)

  const stale = f.face.beginOperation('docs')
  const currentOwner = f.face.beginOperation('docs')
  expect(a.state.calls).toHaveLength(4)
  expect(f.face.abortOperation(stale)).toBe(false)
  expect(f.face.gate.enabledFor(a.agent, 'docs')).toBe(false)
  expect(a.state.disposals).toHaveLength(3)
  expect(f.face.abortOperation(currentOwner)).toBe(true)
  expect(f.face.gate.enabledFor(a.agent, 'docs')).toBe(false)
  expect(a.state.disposals).toHaveLength(3)
})
