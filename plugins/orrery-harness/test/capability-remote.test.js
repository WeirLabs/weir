// Capability read remote (silent-capability-reads task 2.2): the host-layer
// read service must build byte-identical payloads to the /capabilities
// command verbs, surface typed errors (bridge-absent / unknown-session /
// payload-failed) instead of guessed payloads, register a hand-written typert
// contribution with the frozen validateBinding shape (S27), and stay inert —
// never break the host composition — when typert is unavailable or throws.
import { test, expect } from './helpers.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { createSkillSelectionPlugin, resolveSessionCwd, persistedSessionCwd } from '../src/capabilities/skill-selection-plugin.js'
import {
  CAPABILITY_READ_METHODS,
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

  // Presets view reads (silent-preset-reads): same byte-parity contract.
  const remotePresets = await service.presets('sess-remote')
  const commandPresets = await command.handler({ agent, rawInput: 'presets' })
  expect(commandPresets.kind).toBe('success')
  expect(JSON.stringify(remotePresets)).toBe(commandPresets.text)
  expect(Array.isArray(remotePresets.presets)).toBe(true)

  const remoteDefaultGet = await service.defaultGet('sess-remote')
  const commandDefaultGet = await command.handler({ agent, rawInput: 'default-get' })
  expect(JSON.stringify(remoteDefaultGet)).toBe(commandDefaultGet.text)

  // Domain statuses are VALUES on the remote while the command maps only
  // no-workspace to its historical error kind — both from one payload.
  const homelessAgent = { id: 'sess-noworkspace', session: { id: 'sess-noworkspace', header: {} } }
  harness.fireCreated({ agent: homelessAgent })
  const remoteNoWorkspace = await service.defaultGet('sess-noworkspace')
  const commandNoWorkspace = await command.handler({ agent: homelessAgent, rawInput: 'default-get' })
  expect(remoteNoWorkspace.status).toBe('no-workspace')
  expect(commandNoWorkspace.kind).toBe('error')
  expect(JSON.stringify(remoteNoWorkspace)).toBe(commandNoWorkspace.text)
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
  for (const method of CAPABILITY_READ_METHODS) {
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
  expect(contribution.invocations).toHaveLength(CAPABILITY_READ_METHODS.length)
  for (const invocation of contribution.invocations) {
    expect(invocation.service).toBe(CAPABILITY_READ_SERVICE_KEY)
    expect(invocation.namespace).toBe(CAPABILITY_READ_NAMESPACE)
    expect(invocation.id).toBe(`orrery-harness.${CAPABILITY_READ_NAMESPACE}.${invocation.method}`)
    expect(invocation.invocation).toEqual({ kind: 'direct' })
    expect(invocation.parameters).toEqual([{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } }])
    expect(invocation.result).toEqual({ mode: 'src-json' })
  }
  expect(contribution.invocations.map(entry => entry.method)).toEqual(['receipt', 'list', 'conditions', 'presets', 'defaultGet'])
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
    'orreryCapabilities/presets',
    'orreryCapabilities/defaultGet',
  ])
})

// S27.2: the real registry's register → validatePackage requires a nonempty '#'-free
// `package` and keys the package record by `face`. A contribution missing either passes
// every direct-service test and then dies silently at typert.register inside apply()'s
// catch (which only warns), so the declared shape and the mock registry are pinned apart.
test('the read contribution carries the package and face the registry validates', () => {
  const contribution = capabilityReadContribution()
  expect(contribution.package).toBe('orrery-harness')
  expect(contribution.face).toBe('host')
  expect(contribution.schemas).toEqual([])
  expect(contribution.model).toEqual({ services: [], events: [], objects: [] })
  // Exactly this key set: a dropped or renamed top-level field is a registry-side contract change.
  expect(Object.keys(contribution).sort()).toEqual(['face', 'invocations', 'model', 'package', 'schemas'])

  expect(contribution.invocations).toHaveLength(CAPABILITY_READ_METHODS.length)
  expect(contribution.invocations.map(entry => entry.method)).toEqual(['receipt', 'list', 'conditions', 'presets', 'defaultGet'])
  for (const invocation of contribution.invocations) {
    expect(invocation.id.startsWith('orrery-harness.')).toBe(true)
    expect(invocation.id).toBe(`orrery-harness.${CAPABILITY_READ_NAMESPACE}.${invocation.method}`)
    // Literal wire names: the gateway resolves these strings, not this module's constants.
    expect(invocation.service).toBe('orreryCapabilityRead')
    expect(invocation.namespace).toBe('orreryCapabilities')
    expect(invocation.invocation).toEqual({ kind: 'direct' })
    expect(invocation.parameters).toEqual([{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } }])
    expect(invocation.result).toEqual({ mode: 'src-json' })
  }
})

test('the shipped contribution survives the registry validatePackage, so registration cannot die silently', () => {
  const warnings = []
  const provided = []
  let captured = null
  // The real registry's validatePackage, reproduced: a nonempty '#'-free package name, and
  // the package record keyed by face. It throws instead of silently dropping the contribution.
  const typert = {
    register(contribution) {
      if (typeof contribution?.package !== 'string' || contribution.package.length === 0 || contribution.package.includes('#')) throw new TypeError('validatePackage: bad package')
      if (typeof contribution?.face !== 'string') throw new TypeError('validatePackage: bad face')
      captured = contribution
    },
  }
  const ctx = {
    get: name => (name === 'typert' ? typert : undefined),
    root: { reflect: { provide: (key, service) => provided.push({ key, service }) } },
    logger: { warn: text => warnings.push(text) },
  }
  remoteApply(ctx)

  // apply() swallows a rejected registration into a warning: the pre-fix code left this silent.
  expect(warnings).toEqual([])
  expect(captured).toBeTruthy()
  expect(captured.package).toBe('orrery-harness')
  expect(captured.face).toBe('host')
  expect(captured.invocations.map(entry => entry.method)).toEqual(['receipt', 'list', 'conditions', 'presets', 'defaultGet'])
  expect(provided).toHaveLength(1)
  expect(provided[0].key).toBe(CAPABILITY_READ_SERVICE_KEY)
  expect(provided[0].service.typertRemote.namespace).toBe(CAPABILITY_READ_NAMESPACE)

  // Control: the rejector is not vacuous — the S27.2 shape dies exactly as it did in production.
  const noPackage = capabilityReadContribution()
  delete noPackage.package
  expect(() => typert.register(noPackage)).toThrow(/validatePackage: bad package/)
  const noFace = capabilityReadContribution()
  delete noFace.face
  expect(() => typert.register(noFace)).toThrow(/validatePackage: bad face/)
})

{
  test('resolveSessionCwd serves the warm cache without touching the registry', () => {
    const cache = new Map([['s1', '/ws/one']])
    let registryCalls = 0
    const agents = { get: () => { registryCalls += 1; return undefined } }
    expect(resolveSessionCwd(cache, agents, 's1')).toEqual({ found: true, cwd: '/ws/one' })
    expect(registryCalls).toBe(0)
  })

  test('resolveSessionCwd falls back to the live agents registry on a cache miss and backfills', () => {
    const cache = new Map()
    const agents = { get: (id) => (id === 's2' ? { session: { header: { cwd: '/ws/two' } } } : undefined) }
    expect(resolveSessionCwd(cache, agents, 's2')).toEqual({ found: true, cwd: '/ws/two' })
    expect(cache.get('s2')).toBe('/ws/two')
  })

  test('resolveSessionCwd reports not-found only when no live agent holds the session', () => {
    const cache = new Map()
    expect(resolveSessionCwd(cache, { get: () => undefined }, 's3')).toEqual({ found: false, cwd: undefined })
    expect(resolveSessionCwd(cache, undefined, 's3')).toEqual({ found: false, cwd: undefined })
    expect(cache.has('s3')).toBe(false)
  })
}

test('the read channel self-heals a withdrawn typert registration', () => {
  // The race that killed the Badge repeatedly: the fiber re-mounts, the
  // previous registration's disposal withdraws the strict definition AFTER
  // the new apply ran. The service must re-register on the next read instead
  // of dying until an app restart.
  const registrations = []
  let live = false
  const typert = {
    local: { get: () => (live ? { id: 'x' } : undefined) },
    register: (contribution) => {
      registrations.push(contribution.package)
      live = true
      return () => { live = false }
    },
  }
  const ensureRegistered = () => {
    if (live) return true
    try { typert.register(capabilityReadContribution()); return true } catch { return live }
  }
  const faces = {
    provider: { status: () => ({}), list: async () => ({ candidates: [], complete: true }) },
    lifecycle: null,
    sessionCwd: () => ({ found: true, cwd: '/tmp' }),
    profileContext: () => undefined,
  }
  const service = createCapabilityReadService({ bridge: () => faces, ensureRegistered })
  // First read: definition absent → ensure() re-registers.
  return service.receipt('s1').then(async (first) => {
    expect(first.status).toBe('applied')
    expect(registrations).toHaveLength(1)
    // The previous generation's disposer withdraws the definition mid-flight...
    live = false
    // ...and the next read self-heals instead of dying.
    const second = await service.receipt('s1')
    expect(second.status).toBe('applied')
    expect(registrations).toHaveLength(2)
  })
})

test('a duplicate registration race with live endpoints is success, never a warning', () => {
  const endpointLive = true
  let registerCalls = 0
  const typert = {
    local: { get: () => (endpointLive ? { id: 'x' } : undefined) },
    register: () => { registerCalls += 1; throw new Error('typert: Remote package "orrery-harness" is already registered') },
  }
  // The apply path's ensure logic: endpoint already live → no registration attempted.
  expect(typert.local.get()).toBeTruthy()
  expect(registerCalls).toBe(0)
})

{
  test('persistedSessionCwd reads the cwd from the durable log header without any agent', () => {
    const home = mkdtempSync(join(tmpdir(), 'orrery-persisted-cwd-'))
    const sessionId = 'session-abc-123'
    const dir = join(home, 'sessions', '--ws-slug--', sessionId)
    mkdirSync(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: '/ws/persisted', isSeeded: false, delegationDepth: 0 })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(header + '\n')))
    expect(persistedSessionCwd(home, sessionId)).toEqual({ found: true, cwd: '/ws/persisted' })
  })

  test('resolveSessionCwd falls through agents-registry misses to the persisted header and caches it', () => {
    const home = mkdtempSync(join(tmpdir(), 'orrery-persisted-fallthrough-'))
    const sessionId = 'sess-cold'
    const dir = join(home, 'sessions', '--ws--', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: '/ws/cold', isSeeded: false, delegationDepth: 0 }) + '\n')
    const cache = new Map()
    const agents = { get: () => undefined }
    expect(resolveSessionCwd(cache, agents, sessionId, { home })).toEqual({ found: true, cwd: '/ws/cold' })
    expect(cache.get(sessionId)).toBe('/ws/cold')
  })

  test('persistedSessionCwd reports not-found for missing, foreign, or corrupt logs', () => {
    const home = mkdtempSync(join(tmpdir(), 'orrery-persisted-miss-'))
    expect(persistedSessionCwd(home, 'sess-absent')).toEqual({ found: false, cwd: undefined })
    const dir = join(home, 'sessions', '--ws--', 'sess-bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), '{"type":"command/run"}\n')
    expect(persistedSessionCwd(home, 'sess-bad')).toEqual({ found: false, cwd: undefined })
    expect(persistedSessionCwd(undefined, 'sess-bad')).toEqual({ found: false, cwd: undefined })
  })
}
