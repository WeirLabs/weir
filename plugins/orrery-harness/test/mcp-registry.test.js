// Task 8.1 of the session-capability-manager change: the Orrery-managed MCP
// server registry — configured identity, scope owner and registration
// generation through the group-2 store, with admission reading registry
// fields only (never public tool names).
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpRegistry, createMcpAdmission } from '../src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'

const base = () => mkdtempSync(join(tmpdir(), 'orrery-mcp-reg-'))
const storeOf = root => openCapabilityStore({ root, platform: 'darwin' })
const entry = (identity, extras = {}) => ({
  identity, label: `Server ${identity}`, owner: { kind: 'workspace', key: 'ws-1' },
  generation: 0, configuredAt: 0, transport: { kind: 'stdio', ref: `mock://${identity}` }, ...extras,
})

test('register, re-read, and generation bump on re-register (reconnect)', async () => {
  const root = base()
  const registry = createMcpRegistry({ store: storeOf(root), now: () => 1000 })
  expect((await registry.read()).kind).toBe('absent')
  const first = await registry.register(entry('alpha'), 0)
  expect(first.status).toBe('committed')
  let current = await registry.read()
  expect(current.servers.alpha.generation).toBe(1)
  expect(current.servers.alpha.configuredAt).toBe(1000)
  // Re-registering the same identity (reconnect) bumps the generation, keeps configuredAt.
  await registry.register(entry('alpha'), current.revision)
  current = await registry.read()
  expect(current.servers.alpha.generation).toBe(2)
  expect(current.servers.alpha.configuredAt).toBe(1000)
})

test('rename moves to a new identity at generation 1 in one atomic commit; remove deletes', async () => {
  const root = base()
  const registry = createMcpRegistry({ store: storeOf(root) })
  await registry.register(entry('alpha'), 0)
  let current = await registry.read()
  const renamed = await registry.rename('alpha', 'beta', entry('beta'), current.revision)
  expect(renamed.status).toBe('committed')
  current = await registry.read()
  expect(current.servers.alpha).toBeUndefined()
  expect(current.servers.beta.generation).toBe(1)
  await registry.remove('beta', current.revision)
  expect((await registry.read()).servers.beta).toBeUndefined()
})

test('stale expectedRevision is a conflict and writes nothing', async () => {
  const root = base()
  const registry = createMcpRegistry({ store: storeOf(root) })
  await registry.register(entry('alpha'), 0)
  const conflict = await registry.register(entry('beta'), 0)
  expect(conflict.status).toBe('revision-conflict')
  expect((await registry.read()).servers.beta).toBeUndefined()
})

test('admission derives from identity + generation only, never from a display label', async () => {
  const root = base()
  const registry = createMcpRegistry({ store: storeOf(root) })
  await registry.register(entry('alpha'), 0)
  const admission = createMcpAdmission(registry)
  expect(await admission.admit('alpha', 1)).toEqual({ admitted: true, reason: null })
  // Stale generation (an old facade instance after a reconnect): rejected.
  expect((await admission.admit('alpha', 99)).reason).toBe('generation-stale')
  // Unregistered identity — even with a familiar display label: rejected.
  expect((await admission.admit('alpha-clone', 1)).reason).toBe('identity-unregistered')
  // Absent registry: fail closed.
  expect((await createMcpAdmission(createMcpRegistry({ store: storeOf(base()) })).admit('alpha', 1)).reason).toBe('registry-absent')
})

test('identity validation rejects traversal and non-stdio transports', async () => {
  const registry = createMcpRegistry({ store: storeOf(base()) })
  await assert.rejects(registry.register(entry('../x'), 0), TypeError)
  await assert.rejects(registry.register(entry('gamma', { transport: { kind: 'sse', ref: 'https://x' } }), 0), TypeError)
})

test('static: the admission module never references public tool names', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/capabilities/mcp-registry.js', import.meta.url)), 'utf8')
  expect(/mcp__/.test(source.replace(/`mcp__\.\.\.`/g, ''))).toBe(false)
})
