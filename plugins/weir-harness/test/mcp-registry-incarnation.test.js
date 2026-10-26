import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'

const root = () => mkdtempSync(join(tmpdir(), 'weir-mcp-inc-reg-'))
const storeOf = path => openCapabilityStore({ root: path, platform: 'darwin' })
const entry = (identity, extras = {}) => ({ identity, label: identity, owner: { kind: 'global', key: 'installation' }, generation: 0, configuredAt: 0, transport: { kind: 'stdio', ref: 'cmd:node' }, client: { transport: 'stdio', serverName: identity, command: 'node' }, ...extras })

test('new/edit/restart/rename/re-add incarnation and default semantics are exact', async () => {
  let sequence = 0
  const registry = createMcpRegistry({ store: storeOf(root()), newIncarnation: () => `inc-${++sequence}` })
  await registry.register(entry('docs'), 0)
  let current = await registry.read()
  expect(current.servers.docs.incarnation).toBe('inc-1')
  expect(current.servers.docs.generation).toBe(1)
  await registry.setDefault('docs', true, current.revision)
  current = await registry.read()
  expect(current.enabled).toEqual(['docs'])

  await registry.register(entry('docs'), current.revision)
  current = await registry.read()
  expect(current.servers.docs.incarnation).toBe('inc-1')
  expect(current.servers.docs.generation).toBe(2)
  expect(current.enabled).toEqual(['docs'])

  await registry.rename('docs', 'web', entry('web'), current.revision)
  current = await registry.read()
  expect(current.servers.web.incarnation).toBe('inc-2')
  expect(current.servers.web.generation).toBe(1)
  expect(current.enabled).toEqual(['web'])

  const removed = await registry.remove('web', current.revision)
  expect(removed.defaultRemoved).toBe(true)
  current = await registry.read()
  expect(current.enabled).toEqual([])
  await registry.register(entry('web'), current.revision)
  current = await registry.read()
  expect(current.servers.web.incarnation).toBe('inc-3')
  expect(current.enabled).toEqual([])
})

test('legacy entries stay incarnation-less on edit; stale defaults warn and corrupt reads are unavailable', async () => {
  const store = storeOf(root())
  await store.commit({ kind: 'mcp-registry' }, 0, () => ({ servers: { legacy: { ...entry('legacy'), incarnation: undefined }, ghost: entry('ghost') }, enabled: ['legacy', 'missing', 'missing'] }))
  const registry = createMcpRegistry({ store, newIncarnation: () => 'new-inc' })
  let current = await registry.read()
  expect(current.enabled).toEqual(['legacy', 'missing'])
  expect(current.warnings).toEqual([{ code: 'default-missing', identity: 'missing' }])
  await registry.register(current.servers.legacy, current.revision)
  current = await registry.read()
  expect(current.servers.legacy.incarnation).toBeNull()
  expect(current.servers.legacy.generation).toBe(1)

  const corrupt = createMcpRegistry({ store: { read: async () => ({ kind: 'corrupt' }) } })
  expect((await corrupt.read()).kind).toBe('corrupt')
})

test('setDefaults dedups and rejects unregistered identities atomically; HTTP is a supported transport', async () => {
  const registry = createMcpRegistry({ store: storeOf(root()) })
  await registry.register(entry('http', { transport: { kind: 'streamable-http', ref: 'https://example.test/mcp' }, client: { transport: 'streamable-http', serverName: 'http', url: 'https://example.test/mcp' } }), 0)
  let current = await registry.read()
  const result = await registry.setDefaults(['http', 'http'], current.revision)
  expect(result.enabled).toEqual(['http'])
  current = await registry.read()
  await import('node:assert/strict').then(assert => assert.rejects(registry.setDefaults(['ghost'], current.revision), error => error.code === 'identity-unregistered'))
  expect((await registry.read()).enabled).toEqual(['http'])
  const removed = await registry.remove('http', current.revision)
  expect(removed.defaultRemoved).toBe(true)
})
