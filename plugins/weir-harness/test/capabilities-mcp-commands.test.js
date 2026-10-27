import { test, expect, storePlatformSkip, pinHermeticHostRoots } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'
import { createCommandMcpManager } from './helpers/mcp-registry.js'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { createMcpOperations } from '../src/capabilities/mcp-operations.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'

function mount(root, manager = createCommandMcpManager(), credentials) {
  const registered = []
  const emitted = []
  const ctx = {
    skills: { registerProvider: create => create({ invalidate() {} }), layers: { global: { providers: new Map() } } },
    on() {}, effect(fn) { fn(); return () => {} }, emit: (...args) => emitted.push(args),
    logger: { warn() {} },
    get(name) {
      if (name === 'profileContext') return { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registered.push(command); return () => {} } }
      if (name === 'weirMcpManager') return manager
      if (name === 'credentials') return credentials
      return undefined
    },
  }
  createSkillSelectionPlugin()(ctx, { readPresetId: 'weir', machineId: 'weir-it-machine', includeDefaultRoots: false, customSkillDirs: [], dshHome: root })
  const command = registered.find(entry => entry.name === 'capabilities')
  const agent = { id: 's1', session: { id: 's1', header: { cwd: root } } }
  const call = async (verb, spec) => {
    const result = await command.handler({ agent, rawInput: `${verb} ${JSON.stringify(spec)}` })
    return { kind: result.kind, payload: JSON.parse(result.text) }
  }
  return { call, command, agent, manager, emitted }
}

test('MCP verbs share preview/add/edit/restart/test/default/remove operations and honest saved-degraded', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-mcp-verbs-'))
    const h = mount(root)
    const preview = await h.call('mcp-preview', { identity: 'docs', command: 'node', env: { TOKEN: { ref: 'USER_TOKEN' } } })
    expect(preview.payload.status).toBe('preview')
    expect(h.manager.calls.mount).toBe(0)
    const added = await h.call('mcp-add', { identity: 'docs', label: 'Docs', command: 'node', env: { TOKEN: 'legacy-secret' } })
    expect(added.payload.status).toBe('mounted')
    expect(added.payload.warnings).toEqual(['legacy-literal-secrets-in-command-history'])
    expect(JSON.stringify(added.payload)).not.toContain('legacy-secret')
    let current = await createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' } }) }).read()
    const edited = await h.call('mcp-edit', { identity: 'docs', label: 'Edited', expectedRevision: current.revision, secretValues: { env: { TOKEN: '' } } })
    expect(edited.payload.status, JSON.stringify(edited.payload)).toBe('mounted')
    expect(edited.payload.generation).toBe(2)
    current = await createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' } }) }).read()
    const defaulted = await h.call('mcp-default', { identity: 'docs', enabled: true, expectedRevision: current.revision })
    expect(defaulted.payload.status).toBe('saved')
    expect(defaulted.payload.defaultEnabled).toBe(true)
    current = await createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' } }) }).read()
    const restarted = await h.call('mcp-restart', { identity: 'docs', expectedRevision: current.revision })
    expect(restarted.payload.status).toBe('mounted')
    expect(restarted.payload.generation).toBe(3)
    const tested = await h.call('mcp-test', { identity: 'test', command: 'node', env: { TOKEN: { ref: 'USER_TOKEN' } } })
    expect(tested.payload.status).toBe('mounted')
    expect(tested.payload.probe).toBe(true)
    current = await createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' } }) }).read()
    const removed = await h.call('mcp-remove', { identity: 'docs', expectedRevision: current.revision })
    expect(removed.payload.status).toBe('removed')
    expect(removed.payload.defaultRemoved).toBe(true)
    const batch = await h.call('mcp-batch', { mcpServers: { a: { command: 'node' }, b: { command: 'node' } } })
    expect(batch.payload.status).toBe('mounted')
    expect(batch.payload.items).toHaveLength(2)
    expect(JSON.stringify(h.emitted)).not.toContain('legacy-secret')
  } finally { host.restore() }
})

test('saved-degraded and refs-only command failures match shared operations and leave no new secret/write', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-mcp-verbs-fail-'))
    const degraded = mount(root, createCommandMcpManager({ status: 'saved-degraded' }))
    const added = await degraded.call('mcp-add', { identity: 'docs', label: 'Docs', command: 'node' })
    expect(added.payload.status).toBe('saved-degraded')
    expect(added.payload.saved).toBe(true)
    expect(added.payload.mount.state).toBe('degraded')
    const refused = await degraded.call('mcp-edit', { identity: 'docs', expectedRevision: 1, env: { TOKEN: 'raw-new-secret' } })
    expect(refused.kind, JSON.stringify(refused.payload)).toBe('error')
    expect(refused.payload.status).toBe('validation-failed')
    expect(JSON.stringify(refused.payload)).not.toContain('raw-new-secret')
    const registry = createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' } }) })
    const current = await registry.read()
    expect(current.servers.docs.client.env?.TOKEN).toBeUndefined()
    expect(current.servers.docs.label).toBe('Docs')
  } finally { host.restore() }
})

test('UI and command report the same stale revision conflict; usage names every MCP verb', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-mcp-verbs-stale-'))
    const h = mount(root)
    await h.call('mcp-add', { identity: 'docs', label: 'Docs', command: 'node' })
    const commandConflict = await h.call('mcp-edit', { identity: 'docs', expectedRevision: 0, config: { label: 'stale' } })
    expect(commandConflict.payload.status).toBe('revision-conflict')
    const registry = createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' } }) })
    const operations = createMcpOperations({ registry, manager: h.manager, credentials: undefined })
    const uiConflict = await operations.edit({ identity: 'docs', expectedRevision: 0, config: { label: 'stale' } })
    expect(uiConflict.status).toBe(commandConflict.payload.status)
    expect(uiConflict.error?.code).toBe(commandConflict.payload.error?.code)
    const usage = await h.command.handler({ agent: h.agent, rawInput: 'mcp-test' })
    expect(usage.text).toContain('Usage: /capabilities mcp-test')
    const help = await h.command.handler({ agent: h.agent, rawInput: 'unknown' })
    for (const verb of ['mcp-preview', 'mcp-add', 'mcp-batch', 'mcp-edit', 'mcp-remove', 'mcp-restart', 'mcp-test', 'mcp-default']) expect(help.text).toContain(verb)
  } finally { host.restore() }
})
test('partial MCP batch results use the domain-failure command shape without losing item outcomes', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-mcp-verbs-partial-'))
    const manager = createCommandMcpManager()
    const mounted = manager.reconcileOne
    manager.reconcileOne = async (identity, entry, token) => identity === 'bad'
      ? { status: 'saved-degraded', identity, generation: entry.generation, incarnation: entry.incarnation ?? null, saved: true, mount: { state: 'degraded' } }
      : mounted(identity, entry, token)
    const h = mount(root, manager)
    const result = await h.call('mcp-batch', { mcpServers: { good: { command: 'node' }, bad: { command: 'node' } } })
    expect(result.kind, JSON.stringify(result.payload)).toBe('error')
    expect(result.payload.status).toBe('partial')
    expect(result.payload.succeeded).toBe(false)
    expect(result.payload.items.map(item => item.status)).toEqual(['mounted', 'saved-degraded'])
  } finally { host.restore() }
})
test('command paths ignore a caller-supplied surface: literal secrets stay refused and never reach credentials', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  const known = 'command-s3cr3t-do-not-leak'
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-mcp-verbs-secret-'))
    const sets = []
    const credentials = {
      set: async (ref, value) => { sets.push([ref, value]); throw new Error(`credential backend rejected ${known}`) },
      resolve: async () => undefined,
      unset: async () => {},
    }
    const h = mount(root, createCommandMcpManager(), credentials)
    await h.call('mcp-add', { identity: 'docs', label: 'Docs', command: 'node' })
    for (const [verb, spec] of [
      ['mcp-edit', { identity: 'docs', expectedRevision: 1, surface: 'ui', secretValues: { env: { TOKEN: { action: 'replace', value: known } } } }],
      ['mcp-test', { identity: 'fresh', command: 'node', surface: 'ui', env: { TOKEN: known } }],
      ['mcp-batch', { surface: 'ui', mcpServers: { fresh: { command: 'node', env: { TOKEN: known } } } }],
    ]) {
      const result = await h.call(verb, spec)
      expect(result.kind, verb).toBe('error')
      expect(result.payload.status, `${verb}: ${JSON.stringify(result.payload)}`).toBe('validation-failed')
      expect(JSON.stringify(result.payload), verb).toContain('literal secrets')
    }
    expect(sets).toEqual([])
    expect(JSON.stringify(h.emitted)).not.toContain(known)
    const current = await createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' } }) }).read()
    expect(Object.keys(current.servers)).toEqual(['docs'])
    expect(current.servers.docs.secretRefs).toBeUndefined()
  } finally { host.restore() }
})
