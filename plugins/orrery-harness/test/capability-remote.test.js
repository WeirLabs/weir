// Capability read remote (silent-capability-reads task 2.2): the host-layer
// read service must build byte-identical payloads to the /capabilities
// command verbs, surface typed errors (bridge-absent / unknown-session /
// payload-failed) instead of guessed payloads, register a hand-written typert
// contribution with the frozen validateBinding shape (S27), and stay inert —
// never break the host composition — when typert is unavailable or throws.
import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'
import {
  CAPABILITY_READ_NAMESPACE,
  CAPABILITY_READ_SERVICE_KEY,
  CapabilityReadError,
  apply as remoteApply,
  capabilityReadBridge,
  capabilityReadContribution,
  createCapabilityReadService,
  feedCapabilityReadBridge,
} from '../src/capabilities/capability-remote.js'

/** Mock ctx mounting the real skill-selection plugin; listeners are captured so agent/created can be fired. */
function makePluginCtx(root) {
  let provider
  const listeners = new Map()
  const registeredCommands = []
  const effects = []
  const ctx = {
    skills: {
      registerProvider(create) { provider = create({ invalidate() {} }) },
      async list(options) { return (await provider.list(options)).candidates },
      // No dsh-office provider composed: the Office adapter yields nothing.
      layers: { global: { providers: new Map() } },
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    effect(fn) { effects.push(fn()); return () => {} },
    emit() {},
    logger: { warn() {} },
    get(name) {
      if (name === 'profileContext') return { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  return {
    ctx,
    effects,
    command: () => registeredCommands.find(entry => entry.name === 'capabilities'),
    fireCreated: payload => { for (const fn of listeners.get('agent/created') ?? []) fn(payload) },
  }
}

test('remote receipt/list/conditions are byte-identical to the /capabilities verbs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orrery-remote-'))
  const harness = makePluginCtx(root)
  createSkillSelectionPlugin()(harness.ctx, { machineId: 'orrery-it-machine', includeDefaultRoots: false, customSkillDirs: [] })
  const command = harness.command()
  expect(typeof command?.handler).toBe('function')
  // The bridge is fed by the plugin apply (ctx.effect ran synchronously).
  expect(capabilityReadBridge()).toBeTruthy()
  const agent = { id: 'sess-remote', session: { id: 'sess-remote', header: { cwd: root } } }
  harness.fireCreated({ agent })

  const service = createCapabilityReadService()
  const remoteReceipt = await service.receipt('sess-remote')
  const commandReceipt = await command.handler({ agent, rawInput: 'receipt' })
  expect(commandReceipt.kind).toBe('success')
  expect(JSON.stringify(remoteReceipt)).toBe(commandReceipt.text)
  expect(remoteReceipt.status).toBe('applied')

  const remoteList = await service.list('sess-remote')
  const commandList = await command.handler({ agent, rawInput: 'list' })
  expect(commandList.kind).toBe('success')
  expect(JSON.stringify(remoteList)).toBe(commandList.text)
  expect(Array.isArray(remoteList.skills)).toBe(true)
  expect(Array.isArray(remoteList.mcpServers)).toBe(true)

  const remoteConditions = await service.conditions('sess-remote')
  const commandConditions = await command.handler({ agent, rawInput: 'conditions' })
  expect(JSON.stringify(remoteConditions)).toBe(commandConditions.text)
  expect(remoteConditions).toEqual({ conditions: [] })
})

test('unknown session and missing bridge are explicit typed errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orrery-remote-err-'))
  const harness = makePluginCtx(root)
  createSkillSelectionPlugin()(harness.ctx, { machineId: 'orrery-it-machine', includeDefaultRoots: false, customSkillDirs: [] })
  const service = createCapabilityReadService()

  // The bridge is fed but this session never fired agent/created.
  const unknown = await service.receipt('sess-never-created').then(() => null, cause => cause)
  expect(unknown).toBeInstanceOf(CapabilityReadError)
  expect(unknown.code).toBe('unknown-session')
  expect(unknown.message).toContain('sess-never-created')
  const unknownList = await service.list('sess-never-created').then(() => null, cause => cause)
  expect(unknownList.code).toBe('unknown-session')

  // Bridge absent (non-Orrery preset / unmounted): typed, never a guess.
  const absent = createCapabilityReadService({ bridge: () => null })
  for (const method of ['receipt', 'list', 'conditions']) {
    const cause = await absent[method]('sess-remote').then(() => null, error => error)
    expect(cause).toBeInstanceOf(CapabilityReadError)
    expect(cause.code).toBe('bridge-absent')
  }

  // A payload failure (here: a throwing provider face) chains its cause.
  const faces = capabilityReadBridge()
  const broken = createCapabilityReadService({
    bridge: () => ({
      ...faces,
      sessionCwd: () => ({ found: true, cwd: '/tmp' }),
      provider: { status: () => { throw new Error('provider down') } },
    }),
  })
  const failed = await broken.receipt('sess-remote').then(() => null, cause => cause)
  expect(failed).toBeInstanceOf(CapabilityReadError)
  expect(failed.code).toBe('payload-failed')
  expect(failed.cause instanceof Error && failed.cause.message).toBe('provider down')
})

test('bridge feed registers, unregisters, and a stale handle keeps the newer feed', () => {
  const facesA = { marker: 'A' }
  const facesB = { marker: 'B' }
  const unregisterA = feedCapabilityReadBridge(facesA)
  expect(capabilityReadBridge()).toBe(facesA)
  const unregisterB = feedCapabilityReadBridge(facesB)
  expect(capabilityReadBridge()).toBe(facesB)
  // Disposing the OLDER feed must not strip the newer one.
  unregisterA()
  expect(capabilityReadBridge()).toBe(facesB)
  unregisterB()
  expect(capabilityReadBridge()).toBe(null)
})

test('host apply publishes the frozen binding and registers the hand-written contribution', () => {
  const provided = []
  const registered = []
  const ctx = {
    get: name => (name === 'typert' ? { register: contribution => { registered.push(contribution) } } : undefined),
    root: { reflect: { provide: (key, service) => provided.push({ key, service }) } },
    logger: { warn() {} },
  }
  remoteApply(ctx)

  expect(provided).toHaveLength(1)
  expect(provided[0].key).toBe(CAPABILITY_READ_SERVICE_KEY)
  const service = provided[0].service
  // validateBinding's exact shape (S27): a frozen { service, serviceKey, namespace }.
  expect(Object.isFrozen(service.typertRemote)).toBe(true)
  expect(service.typertRemote.service).toBe(service)
  expect(service.typertRemote.serviceKey).toBe(CAPABILITY_READ_SERVICE_KEY)
  expect(service.typertRemote.namespace).toBe(CAPABILITY_READ_NAMESPACE)
  expect(Object.isFrozen(service)).toBe(true)
  expect(typeof service.receipt).toBe('function')
  expect(typeof service.list).toBe('function')
  expect(typeof service.conditions).toBe('function')

  expect(registered).toHaveLength(1)
  const contribution = registered[0]
  expect(contribution.schemas).toEqual([])
  expect(contribution.model).toEqual({ services: [], events: [], objects: [] })
  expect(contribution.invocations).toHaveLength(3)
  for (const invocation of contribution.invocations) {
    expect(invocation.service).toBe(CAPABILITY_READ_SERVICE_KEY)
    expect(invocation.namespace).toBe(CAPABILITY_READ_NAMESPACE)
    expect(invocation.id).toBe(`orrery-harness.${CAPABILITY_READ_NAMESPACE}.${invocation.method}`)
    expect(invocation.invocation).toEqual({ kind: 'direct' })
    expect(invocation.parameters).toEqual([{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } }])
    expect(invocation.result).toEqual({ mode: 'src-json' })
  }
  expect(contribution.invocations.map(entry => entry.method)).toEqual(['receipt', 'list', 'conditions'])
})

test('host apply stays inert with a warning when typert is unavailable or registration throws', () => {
  // No typert service: warn, no provide, no throw.
  const warnings = []
  const silent = {
    get: () => undefined,
    root: { reflect: { provide: () => { throw new Error('must not be reached') } } },
    logger: { warn: text => warnings.push(text) },
  }
  remoteApply(silent)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('typert service is unavailable')

  // A throwing typert.register: warn and stay inert, never break the host.
  const warnings2 = []
  const throwing = {
    get: name => (name === 'typert' ? { register: () => { throw new Error('duplicate contribution') } } : undefined),
    root: { reflect: { provide: () => {} } },
    logger: { warn: text => warnings2.push(text) },
  }
  remoteApply(throwing)
  expect(warnings2).toHaveLength(1)
  expect(warnings2[0]).toContain('registration failed')
  expect(warnings2[0]).toContain('duplicate contribution')

  // A throwing typert lookup: warn and stay inert.
  const warnings3 = []
  remoteApply({
    get: () => { throw new Error('context inactive') },
    root: { reflect: { provide: () => {} } },
    logger: { warn: text => warnings3.push(text) },
  })
  expect(warnings3).toHaveLength(1)
  expect(warnings3[0]).toContain('lookup failed')
})

test('the contribution factory is standalone-stable for the gateway claim check', () => {
  const contribution = capabilityReadContribution()
  expect(contribution.invocations.map(entry => `${entry.namespace}/${entry.method}`)).toEqual([
    'orreryCapabilities/receipt',
    'orreryCapabilities/list',
    'orreryCapabilities/conditions',
  ])
})
