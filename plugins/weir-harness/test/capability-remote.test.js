// Capability read remote (silent-capability-reads task 2.2): the host-layer
// read service must build byte-identical payloads to the /capabilities
// command verbs, surface typed errors (bridge-absent / unknown-session /
// payload-failed) instead of guessed payloads, register a hand-written typert
// contribution with the frozen validateBinding shape (S27), and stay inert —
// never break the host composition — when typert is unavailable or throws.
import { test, expect, storePlatformSkip, pinHermeticHostRoots } from './helpers.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { createSkillSelectionPlugin, resolveSessionCwd, persistedSessionCwd } from '../src/capabilities/skill-selection-plugin.js'
import {
  CAPABILITY_READ_METHODS,
  CAPABILITY_MUTATION_METHODS,
  CAPABILITY_MUTATION_NAMESPACE,
  CAPABILITY_MUTATION_SERVICE_KEY,
  CAPABILITY_READ_NAMESPACE,
  CAPABILITY_READ_SERVICE_KEY,
  CapabilityReadError,
  apply as remoteApply,
  CAPABILITY_ENDPOINTS,
  capabilityReadBridge,
  capabilityContribution,
  createCapabilityReadService,
  feedCapabilityReadBridge,
} from '../src/capabilities/capability-remote.js'
import { buildReceiptPayload, buildListPayload, buildConditionsPayload, buildPresetsPayload, buildDefaultGetPayload } from '../src/capabilities/read-payloads.js'

/** Mock ctx mounting the real skill-selection plugin and a read-only sessionQuery observation. */
function makePluginCtx(root) {
  let provider
  const listeners = new Map()
  const registeredCommands = []
  const effects = []
  const sessions = new Map()
  const observations = []
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
      if (name === 'sessionQuery') return { observeSession: async id => {
        const session = sessions.get(id)
        if (!session) throw new Error('session not found')
        return { header: { id, cwd: session.header.cwd, agentPreset: session.header.agentPreset }, projections: { values: { agentPreset: session.presetId } }, events: session.events ?? [], [Symbol.dispose]() { observations.push(id) } }
      } }
      if (name === 'profileContext') return { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  return {
    ctx,
    effects,
    command: () => registeredCommands.find(entry => entry.name === 'capabilities'),
    fireCreated: payload => { sessions.set(payload.agent.id, { header: payload.agent.session.header, presetId: payload.agent.session.header.agentPreset ?? 'weir' }); for (const fn of listeners.get('agent/created') ?? []) fn(payload) },
    observations,
  }
}

test('remote receipt/list/conditions are byte-identical to the /capabilities verbs', { skip: storePlatformSkip }, async () => {
  // Hermetic roots: the mounted plugin resolves agentsHome/dshHome — pin the
  // host-dependent env so a runner with user-global skills never leaks in.
  const host = pinHermeticHostRoots()
  const root = mkdtempSync(join(tmpdir(), 'weir-remote-'))
  const harness = makePluginCtx(root)
  try {
    createSkillSelectionPlugin()(harness.ctx, { readPresetId: 'weir', machineId: 'weir-it-machine', includeDefaultRoots: false, customSkillDirs: [], agentsHome: host.agentsHome, dshHome: root })
    const command = harness.command()
    expect(typeof command?.handler).toBe('function')
    // The bridge is fed by the plugin apply (ctx.effect ran synchronously).
    expect(capabilityReadBridge('weir')).toBeTruthy()
    const agent = { id: 'sess-remote', session: { id: 'sess-remote', header: { cwd: root } } }
    harness.fireCreated({ agent })

    const service = createCapabilityReadService({ sessionQuery: () => harness.ctx.get('sessionQuery') })
    const remoteReceipt = await service.receipt('sess-remote')
    const commandReceipt = await command.handler({ agent, rawInput: 'receipt' })
    expect(commandReceipt.kind).toBe('success')
    expect(JSON.stringify(remoteReceipt)).toBe(commandReceipt.text)
    expect(remoteReceipt.status).toBe('applied')
    expect(remoteReceipt.effective.skillIdentities.map(identity => identity.name)).toEqual(remoteReceipt.effective.skills)
    // The effective selection digest is a required receipt field (backend corrective
    // lane): the applied preset resave flow takes it from the receipt back to the
    // server, so the exact key list and the sha256 hex shape are wire contract.
    expect(Object.keys(remoteReceipt.effective)).toEqual(['skills', 'skillIdentities', 'mcpServers', 'mcpIncarnations', 'digest'])
    expect(remoteReceipt.effective.digest).toMatch(/^[0-9a-f]{64}$/)

    const remoteList = await service.list('sess-remote')
    const commandList = await command.handler({ agent, rawInput: 'list' })
    expect(commandList.kind).toBe('success')
    expect(JSON.stringify(remoteList)).toBe(commandList.text)
    expect(Array.isArray(remoteList.skills)).toBe(true)
    expect(remoteList.skills.every(row => Object.keys(row).at(-1) === 'identity')).toBe(true)
    expect(remoteList.skills.filter(row => row.selected).map(row => row.identity)).toEqual(remoteReceipt.effective.skillIdentities)
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
  } finally {
    for (const dispose of harness.effects.reverse()) dispose()
    host.restore()
  }
})

test('unknown session and missing bridge are explicit typed errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weir-remote-err-'))
  const harness = makePluginCtx(root)
   createSkillSelectionPlugin()(harness.ctx, { readPresetId: 'weir', machineId: 'weir-it-machine', includeDefaultRoots: false, customSkillDirs: [] })
   const service = createCapabilityReadService({ sessionQuery: () => harness.ctx.get('sessionQuery') })

  // The bridge is fed but this session never fired agent/created.
  const unknown = await service.receipt('sess-never-created').then(() => null, cause => cause)
  expect(unknown).toBeInstanceOf(CapabilityReadError)
  expect(unknown.code).toBe('unknown-session')
  expect(unknown.message).toContain('sess-never-created')
  const unknownList = await service.list('sess-never-created').then(() => null, cause => cause)
  expect(unknownList.code).toBe('unknown-session')

   // A valid observation without a matching feed cannot borrow another preset.
   const absent = createCapabilityReadService({ sessionQuery: () => harness.ctx.get('sessionQuery'), bridge: () => null })
   harness.fireCreated({ agent: { id: 'sess-remote', session: { header: { cwd: root } } } })
   for (const method of CAPABILITY_READ_METHODS) {
     const cause = await absent[method]('sess-remote').then(() => null, error => error)
     expect(cause).toBeInstanceOf(CapabilityReadError)
     expect(cause.code).toBe('bridge-absent')
   }

  // A payload failure (here: a throwing provider face) chains its cause.
   const faces = capabilityReadBridge('weir')
  const broken = createCapabilityReadService({
    bridge: () => ({
      ...faces,
      sessionCwd: () => ({ found: true, cwd: '/tmp' }),
       provider: { status: () => { throw new Error('provider down') } },
    }),
     sessionQuery: () => harness.ctx.get('sessionQuery'),
  })
  const failed = await broken.receipt('sess-remote').then(() => null, cause => cause)
  expect(failed).toBeInstanceOf(CapabilityReadError)
  expect(failed.code).toBe('payload-failed')
  expect(failed.cause instanceof Error && failed.cause.message).toBe('provider down')
  for (const dispose of harness.effects.reverse()) dispose()
})

// Deliberately model the host's *current* preset observation, not the session
// creation header. The Creative session started as 'weir' and was subsequently
// selected into 'weir-creative'; both sessions share one cwd. The production
// implementation may adapt this test seam to sessionQuery.observeSession.
function twoPresetFixture() {
  const cwd = '/fixture/shared-workspace'
  const owners = new Map([
    ['normal-session', 'weir'],
    ['creative-session', 'weir-creative'],
  ])
  const identities = new Map([
    ['weir', { scope: 'project', root: '/fixture/normal', name: 'normal-skill', provenance: { kind: 'fixture' } }],
    ['weir-creative', { scope: 'project', root: '/fixture/creative', name: 'creative-skill', provenance: { kind: 'fixture' } }],
  ])
  const store = { read: async ({ sessionId }) => ({
    kind: 'ok', revision: 10,
    payload: { skills: [identities.get(owners.get(sessionId))], mcpServers: [] },
  }) }
  const faces = presetId => ({
    readPresetId: presetId,
    sessionCwd: () => ({ found: true, cwd }), // Old bridge wrongly accepts either same-cwd session.
    provider: {
      status: () => ({}),
      list: async options => {
        const owns = owners.get(options.scope.session.id) === presetId
        return {
          candidates: owns ? [{ name: identities.get(presetId).name, identity: identities.get(presetId), selected: true }] : [],
          complete: owns,
        }
      },
    },
    inventory: async () => ({ candidates: [], complete: true }),
    profileContext: () => undefined,
  })
  // This is the shared builder used by the owning /capabilities receipt verb;
  // the existing parity test above checks the mounted command against remote.
  const owningCommandReceipt = (presetId, sessionId) => buildReceiptPayload(
    { provider: faces(presetId).provider, store },
    { cwd, scope: { session: { id: sessionId } } },
  )
  const observations = []
  const events = new Map([['creative-session', [{ type: 'agent-preset/selected', seq: 2, data: { agentPreset: 'weir-creative' } }]]])
  const observeSession = async sessionId => {
    const presetId = owners.get(sessionId)
    if (!presetId) throw new Error('session not found')
    return { source: sessionId === 'creative-session' ? 'prepared' : 'live', header: { id: sessionId, cwd, agentPreset: 'weir' }, projections: { values: { agentPreset: presetId } }, events: events.get(sessionId) ?? [], [Symbol.dispose]() { observations.push(sessionId) } }
  }
  return { owners, faces, store, observeSession, owningCommandReceipt, observations, events }
}

for (const order of [['weir-creative', 'weir'], ['weir', 'weir-creative']]) {
  test(`same-cwd sessions read their exact current preset, not the last feed (${order.join(' then ')})`, async () => {
    const fixture = twoPresetFixture()
    const unregister = order.map(presetId => feedCapabilityReadBridge(fixture.faces(presetId)))
    try {
      const service = createCapabilityReadService({ observeSession: fixture.observeSession, store: () => fixture.store })
      const victim = order[0] === 'weir-creative' ? 'creative-session' : 'normal-session'
      const owner = fixture.owners.get(victim)
      const command = await fixture.owningCommandReceipt(owner, victim)
      expect(command.status).toBe('applied')
      expect(command.revision).toBe(10)
      expect(command.effective.skills).toEqual([`${owner === 'weir' ? 'normal' : 'creative'}-skill`])
      // Pre-fix witness: later wrong feed reports a false applied/0 at the same
      // accepted revision, plus an incomplete-inventory warning.
      const remote = await service.receipt(victim)
      if (remote.effective.skills.length === 0) {
        expect(remote.status).toBe('applied')
        expect(remote.revision).toBe(10)
        expect(remote.warnings).toHaveLength(1)
      }
      // RED on old code; post-fix remote must use the owning feed even when
      // header preset 'weir' differs from the committed Creative selection.
      expect(remote).toEqual(command)
      const other = order[0] === 'weir' ? 'creative-session' : 'normal-session'
      expect(await service.receipt(other)).toEqual(await fixture.owningCommandReceipt(fixture.owners.get(other), other))
    } finally {
      for (const dispose of unregister.reverse()) dispose()
    }
  })
}

test('degraded receipts record the observed owner and provider status for live diagnosis', async () => {
  const fixture = twoPresetFixture()
  const creativeFaces = fixture.faces('weir-creative')
  creativeFaces.provider = {
    status: () => ({ error: 'Selected skill inventory is missing, ambiguous or incomplete', reason: 'selection-unavailable' }),
    list: async () => ({ candidates: [], complete: false }),
  }
  const unregister = feedCapabilityReadBridge(creativeFaces)
  const degraded = []
  const service = createCapabilityReadService({
    observeSession: fixture.observeSession,
    store: () => fixture.store,
    onDegraded: facts => degraded.push(facts),
  })
  try {
    const receipt = await service.receipt('creative-session')
    expect(receipt.status).toBe('applied')
    expect(receipt.warnings).toEqual(['selection-unavailable'])
    expect(degraded).toHaveLength(1)
    const facts = degraded[0]
    expect(facts.method).toBe('receipt')
    expect(facts.sessionId).toBe('creative-session')
    expect(facts.presetId).toBe('weir-creative')
    expect(facts.headerPreset).toBe('weir') // creation header stays visible next to the projection
    expect(facts.source).toBe('prepared')
    expect(facts.selectionSeq).toBe(2)
    expect(facts.cwd).toBe('/fixture/shared-workspace')
    expect(facts.warnings).toEqual(['selection-unavailable'])
    expect(facts.providerReason).toBe('selection-unavailable')
    expect(facts.providerError).toContain('inventory')
    expect(facts.feeds).toEqual({ weir: 0, weirCreative: 1 })

    // Clean payload: no diagnostic record.
    creativeFaces.provider = {
      status: () => ({}),
      list: async options => ({
        candidates: [{ name: 'creative-skill', identity: { scope: 'project', root: '/fixture/creative', name: 'creative-skill', provenance: { kind: 'fixture' } }, selected: true }],
        complete: true,
      }),
    }
    const clean = await service.receipt('creative-session')
    expect(clean.warnings).toEqual([])
    expect(degraded).toHaveLength(1)

    // Owner/transport failures never reach the payload diagnostic.
    await service.receipt('never-observed').then(() => { throw new Error('must reject') }, cause => expect(cause).toBeInstanceOf(CapabilityReadError))
    expect(degraded).toHaveLength(1)
  } finally {
    unregister()
  }
})

test('ambiguous, absent and unobservable preset owners fail closed rather than borrowing another feed', async () => {
  const fixture = twoPresetFixture()
  const unregisterNormal = feedCapabilityReadBridge(fixture.faces('weir'))
  const unregisterCreative = feedCapabilityReadBridge(fixture.faces('weir-creative'))
  const unregisterDuplicate = feedCapabilityReadBridge(fixture.faces('weir'))
  const service = createCapabilityReadService({ observeSession: fixture.observeSession, store: () => fixture.store })
  const unavailable = async (sessionId) => {
    for (const method of CAPABILITY_READ_METHODS) {
      const error = await service[method](sessionId).then(() => null, cause => cause)
      expect(error).toBeInstanceOf(CapabilityReadError)
      expect(typeof error.code).toBe('string')
      expect(error.code).not.toBe('payload-failed')
    }
  }
  try {
    await unavailable('normal-session') // Two active generations claim 'weir'.
    expect(fixture.observations).toHaveLength(CAPABILITY_READ_METHODS.length) // one first lease per ambiguous read
    unregisterDuplicate()
    unregisterNormal()
    await unavailable('normal-session') // Creative feed must not replace a missing normal feed.
    fixture.owners.set('foreign-session', 'other-preset')
    await unavailable('foreign-session') // No supported owner.
    await unavailable('never-observed') // No observation: never trust a cached/header-only fallback.
  } finally {
    unregisterDuplicate()
    unregisterNormal()
    unregisterCreative()
  }
})

test('disposing one preset feed leaves the sibling preset reading untouched', async () => {
  const fixture = twoPresetFixture()
  const unregisterNormal = feedCapabilityReadBridge(fixture.faces('weir'))
  const unregisterCreative = feedCapabilityReadBridge(fixture.faces('weir-creative'))
  const service = createCapabilityReadService({ observeSession: fixture.observeSession, store: () => fixture.store })
  try {
    expect(await service.receipt('normal-session')).toEqual(await fixture.owningCommandReceipt('weir', 'normal-session'))
    expect(await service.receipt('creative-session')).toEqual(await fixture.owningCommandReceipt('weir-creative', 'creative-session'))
    unregisterNormal() // the 'weir' mount disposes while 'weir-creative' stays live
    const absent = await service.receipt('normal-session').then(() => null, cause => cause)
    expect(absent).toBeInstanceOf(CapabilityReadError)
    expect(absent.code).toBe('bridge-absent')
    // The keyed feeds are independent: the sibling preset still serves its
    // exact byte-identical receipt, never a bridge-absent bystander.
    expect(await service.receipt('creative-session')).toEqual(await fixture.owningCommandReceipt('weir-creative', 'creative-session'))
  } finally {
    unregisterNormal()
    unregisterCreative()
  }
})

test('all five reads observe the cold current owner and dispose both leases', async () => {
  const fixture = twoPresetFixture()
  const calls = []
  const creative = fixture.faces('weir-creative')
  creative.profileContext = () => 'creative-context'
  creative.inventory = async options => {
    calls.push(['inventory', options.scope.session.id, options.cwd])
    return { candidates: [{ name: 'creative-skill', identity: { scope: 'project', root: '/fixture/creative', name: 'creative-skill', provenance: { kind: 'fixture' } } }], complete: true }
  }
  const disposeNormal = feedCapabilityReadBridge(fixture.faces('weir'))
  const disposeCreative = feedCapabilityReadBridge(creative)
  const store = context => {
    calls.push(['store', context])
    return { ...fixture.store, support: { supported: false, reason: 'fixture-unavailable' } }
  }
  const service = createCapabilityReadService({ observeSession: fixture.observeSession, store })
  try {
    const options = { cwd: '/fixture/shared-workspace', scope: { session: { id: 'creative-session' } } }
    const expected = {
      receipt: () => buildReceiptPayload({ provider: creative.provider, store: store('creative-context') }, options),
      list: () => buildListPayload({ inventory: creative.inventory, provider: creative.provider }, options),
      conditions: () => buildConditionsPayload(),
      presets: () => buildPresetsPayload({ store: store('creative-context') }, options),
      defaultGet: () => buildDefaultGetPayload({ store: store('creative-context') }, options),
    }
    for (const method of CAPABILITY_READ_METHODS) {
      const value = await service[method]('creative-session')
      expect(value).toEqual(await expected[method]())
      expect(fixture.observations.filter(id => id === 'creative-session')).toHaveLength(2 * (CAPABILITY_READ_METHODS.indexOf(method) + 1))
    }
    expect(calls.some(call => JSON.stringify(call) === JSON.stringify(['inventory', 'creative-session', '/fixture/shared-workspace']))).toBe(true)
    expect(calls.filter(call => call[0] === 'store').every(call => call[1] === 'creative-context')).toBe(true)
    // The header still claims normal Weir, whereas the committed projection is Creative.
    expect(fixture.events.get('creative-session')[0].seq).toBe(2)
  } finally { disposeNormal(); disposeCreative() }
})

test('unlabeled and foreign preset feeds are rejected before registration', () => {
  expect(() => feedCapabilityReadBridge({})).toThrow(/readPresetId/)
  expect(() => feedCapabilityReadBridge({ readPresetId: 'standard' })).toThrow(/readPresetId/)
  expect(capabilityReadBridge('standard')).toBe(null)
})

test('read-only observation never appends to or resumes its target session', async () => {
  const fixture = twoPresetFixture()
  const original = fixture.observeSession
  let observed = 0
  const observeSession = async id => {
    observed++
    return { ...(await original(id)), session: { append() { throw new Error('read appended') } }, agent: { resume() { throw new Error('read resumed agent') } } }
  }
  const dispose = feedCapabilityReadBridge(fixture.faces('weir'))
  try {
    const service = createCapabilityReadService({ observeSession, store: () => fixture.store })
    for (const method of CAPABILITY_READ_METHODS) await service[method]('normal-session')
    expect(observed).toBe(2 * CAPABILITY_READ_METHODS.length)
  } finally { dispose() }
})
test('stale feed tokens cannot unregister replacements and overlap refuses every read', async () => {
  const fixture = twoPresetFixture()
  const old = feedCapabilityReadBridge(fixture.faces('weir'))
  const next = feedCapabilityReadBridge(fixture.faces('weir'))
  const service = createCapabilityReadService({ observeSession: fixture.observeSession, store: () => fixture.store })
  try {
    for (const method of CAPABILITY_READ_METHODS) {
      const error = await service[method]('normal-session').then(() => null, cause => cause)
      expect(error.code).toBe('owner-ambiguous')
    }
    old()
    expect((await service.receipt('normal-session')).effective.skills).toEqual(['normal-skill'])
    old() // exact token disposal is idempotent and cannot erase the new generation
    expect((await service.receipt('normal-session')).effective.skills).toEqual(['normal-skill'])
    next()
    const absent = await service.receipt('normal-session').then(() => null, cause => cause)
    expect(absent.code).toBe('bridge-absent')
  } finally { old(); next() }
})

test('in-flight preset switch, ABA selection and feed replacement reject stale results, not chat events', async () => {
  for (const mutation of ['switch', 'aba', 'dispose', 'replacement', 'overlap', 'chat']) {
    const fixture = twoPresetFixture()
    let unblock
    const waiting = new Promise(resolve => { unblock = resolve })
    let entered
    const begun = new Promise(resolve => { entered = resolve })
    const faces = fixture.faces('weir')
    const list = faces.provider.list
    faces.provider.list = async options => { entered(); await waiting; return list(options) }
    const dispose = feedCapabilityReadBridge(faces)
    let replacement
    const service = createCapabilityReadService({ observeSession: fixture.observeSession, store: () => fixture.store })
    try {
      const result = service.receipt('normal-session').then(value => value, cause => cause)
      await begun
      if (mutation === 'switch') { fixture.owners.set('normal-session', 'weir-creative'); fixture.events.set('normal-session', [{ type: 'agent-preset/selected', seq: 8 }]) }
      if (mutation === 'aba') fixture.events.set('normal-session', [{ type: 'agent-preset/selected', seq: 8 }, { type: 'agent-preset/selected', seq: 9 }])
      if (mutation === 'dispose') dispose()
      if (mutation === 'replacement') { dispose(); replacement = feedCapabilityReadBridge(fixture.faces('weir')) }
      if (mutation === 'overlap') replacement = feedCapabilityReadBridge(fixture.faces('weir'))
      if (mutation === 'chat') fixture.events.set('normal-session', [{ type: 'user/message', seq: 8 }])
      unblock()
      const value = await result
      if (mutation === 'chat') expect(value.status).toBe('applied')
      else { expect(value).toBeInstanceOf(CapabilityReadError); expect(value.code).not.toBe('payload-failed') }
      expect(fixture.observations).toHaveLength(2)
    } finally { dispose(); replacement?.(); unblock() }
  }
})

test('missing projection, missing query, and wrong observation identity fail closed and release leases', async () => {
  let released = 0
  for (const observation of [
    { header: { id: 's', agentPreset: 'weir' }, events: [] },
    { header: { id: 'foreign' }, projections: { values: { agentPreset: 'weir' } }, events: [] },
    { header: { id: 's' }, projections: { values: { agentPreset: 'weir' } } },
  ]) {
    const service = createCapabilityReadService({ observeSession: async () => ({ ...observation, [Symbol.dispose]() { released++ } }) })
    for (const method of CAPABILITY_READ_METHODS) {
      const error = await service[method]('s').then(() => null, cause => cause)
      expect(error).toBeInstanceOf(CapabilityReadError)
      expect(error.code).not.toBe('payload-failed')
    }
  }
  expect(released).toBe(3 * CAPABILITY_READ_METHODS.length)
  const missing = createCapabilityReadService({ sessionQuery: () => undefined })
  expect((await missing.receipt('s').then(() => null, cause => cause)).code).toBe('owner-unavailable')
})
test('a lease without Symbol.dispose fails closed, even when it offers a legacy dispose method', async () => {
  let legacyCalls = 0
  const service = createCapabilityReadService({ observeSession: async id => ({
    header: { id, cwd: '/fixture' }, projections: { values: { agentPreset: 'weir' } }, events: [],
    dispose() { legacyCalls++ },
  }) })
  const error = await service.conditions('s').then(() => null, cause => cause)
  expect(error).toBeInstanceOf(CapabilityReadError)
  expect(error.code).toBe('owner-unavailable')
  expect(legacyCalls).toBe(0)
})
test('first observation lease closes on payload and second-observation failures', async () => {
  const fixture = twoPresetFixture()
  const dispose = feedCapabilityReadBridge(fixture.faces('weir'))
  let observed = 0
  const broken = createCapabilityReadService({
    observeSession: async id => { if (++observed === 2) throw new Error('second observation unavailable'); return fixture.observeSession(id) },
    store: () => fixture.store,
  })
  try {
    const error = await broken.receipt('normal-session').then(() => null, cause => cause)
    expect(error).toBeInstanceOf(CapabilityReadError)
    expect(fixture.observations).toEqual(['normal-session'])
    const throwing = createCapabilityReadService({
      observeSession: fixture.observeSession,
      store: () => ({ read() { throw new Error('store failed') } }),
    })
    expect((await throwing.receipt('normal-session').then(() => null, cause => cause)).code).toBe('payload-failed')
    expect(fixture.observations).toEqual(['normal-session', 'normal-session'])
  } finally { dispose() }
})
test('second observation with invalid owner disposes both leases exactly once', async () => {
  const fixture = twoPresetFixture()
  const release = feedCapabilityReadBridge(fixture.faces('weir'))
  let observed = 0
  const service = createCapabilityReadService({
    observeSession: async id => {
      const lease = await fixture.observeSession(id)
      return ++observed === 2 ? { ...lease, projections: { values: {} } } : lease
    },
    store: () => fixture.store,
  })
  try {
    const error = await service.conditions('normal-session').then(() => null, cause => cause)
    expect(error).toBeInstanceOf(CapabilityReadError)
    expect(error.code).toBe('owner-unavailable')
    expect(fixture.observations).toEqual(['normal-session', 'normal-session'])
  } finally { release() }
})
test('host apply publishes the frozen bindings and registers the one host-face contribution', () => {
  const provided = []
  const registered = []
  const ctx = {
    get: name => (name === 'typert' ? { register: contribution => { registered.push(contribution) } } : undefined),
    root: { reflect: { provide: (key, service) => provided.push({ key, service }) } },
    logger: { warn() {} },
  }
  remoteApply(ctx)

  expect(provided).toHaveLength(2)
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
  expect(provided[1].key).toBe(CAPABILITY_MUTATION_SERVICE_KEY)
  expect(Object.isFrozen(provided[1].service)).toBe(true)
  expect(typeof provided[1].service.mutate).toBe('function')
  expect(typeof provided[1].service.batch).toBe('function')
  expect(provided[1].service.typertRemote.serviceKey).toBe(CAPABILITY_MUTATION_SERVICE_KEY)
  expect(provided[1].service.typertRemote.namespace).toBe(CAPABILITY_MUTATION_NAMESPACE)

  // ONE registration carrying every read AND mutation endpoint: the registry
  // accepts exactly one package record per face, and a dropped endpoint could
  // otherwise only be restored by a second, rejected registration.
  expect(registered).toHaveLength(1)
  const contribution = registered[0]
  expect(contribution.package).toBe('weir-harness')
  expect(contribution.face).toBe('host')
  expect(contribution.schemas).toEqual([])
  expect(contribution.model).toEqual({ services: [], events: [], objects: [] })
  expect(contribution.invocations).toHaveLength(CAPABILITY_READ_METHODS.length + CAPABILITY_MUTATION_METHODS.length)
  for (const invocation of contribution.invocations) {
    expect(invocation.invocation).toEqual({ kind: 'direct' })
    expect(invocation.result).toEqual({ mode: 'src-json' })
    expect(invocation.parameters.every(parameter => parameter.source === 'json' && parameter.codec.mode === 'src-json')).toBe(true)
  }
  expect(contribution.invocations.map(entry => `${entry.namespace}/${entry.method}`)).toEqual(CAPABILITY_ENDPOINTS)
  expect(contribution.invocations.slice(0, CAPABILITY_READ_METHODS.length).every(entry => entry.service === CAPABILITY_READ_SERVICE_KEY)).toBe(true)
  expect(contribution.invocations.slice(CAPABILITY_READ_METHODS.length).map(entry => [entry.service, entry.method, entry.parameters.map(parameter => parameter.name)])).toEqual([
    [CAPABILITY_MUTATION_SERVICE_KEY, 'mutate', ['sessionId', 'request']],
    [CAPABILITY_MUTATION_SERVICE_KEY, 'batch', ['sessionId', 'request']],
  ])
})

test('host apply stays inert with a single warning when typert is unavailable or registration throws', () => {
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

  // A throwing typert.register: warn ONCE and stay inert, never break the host.
  // The pre-fix split attempted two registrations and warned twice.
  const warnings2 = []
  let registrations = 0
  const throwing = {
    get: name => (name === 'typert' ? { register: () => { registrations += 1; throw new Error('duplicate contribution') } } : undefined),
    root: { reflect: { provide: () => {} } },
    logger: { warn: text => warnings2.push(text) },
  }
  remoteApply(throwing)
  expect(registrations).toBe(1)
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
  const contribution = capabilityContribution()
  expect(contribution.invocations.map(entry => `${entry.namespace}/${entry.method}`)).toEqual([
    'weirCapabilities/receipt',
    'weirCapabilities/list',
    'weirCapabilities/conditions',
    'weirCapabilities/presets',
    'weirCapabilities/defaultGet',
    'weirCapabilityMutations/mutate',
    'weirCapabilityMutations/batch',
  ])
  // The gateway claims an endpoint from get() OR hasSeen(): every endpoint this
  // package can ever withdraw must belong to the same committed batch.
  expect(CAPABILITY_ENDPOINTS).toEqual(contribution.invocations.map(entry => `${entry.namespace}/${entry.method}`))
})

// S27.2: the real registry's register → validatePackage requires a nonempty '#'-free
// `package` and keys the package record by `face`. A contribution missing either passes
// every direct-service test and then dies silently at typert.register inside apply()'s
// catch (which only warns), so the declared shape and the mock registry are pinned apart.
test('the shipped contribution carries the package, face and both channels the registry validates', () => {
  const contribution = capabilityContribution()
  expect(contribution.package).toBe('weir-harness')
  expect(contribution.face).toBe('host')
  expect(contribution.schemas).toEqual([])
  expect(contribution.model).toEqual({ services: [], events: [], objects: [] })
  // Exactly this key set: a dropped or renamed top-level field is a registry-side contract change.
  expect(Object.keys(contribution).sort()).toEqual(['face', 'invocations', 'model', 'package', 'schemas'])

  expect(contribution.invocations).toHaveLength(CAPABILITY_READ_METHODS.length + CAPABILITY_MUTATION_METHODS.length)
  expect(contribution.invocations.map(entry => `${entry.namespace}/${entry.method}`)).toEqual([
    'weirCapabilities/receipt', 'weirCapabilities/list', 'weirCapabilities/conditions', 'weirCapabilities/presets', 'weirCapabilities/defaultGet',
    'weirCapabilityMutations/mutate', 'weirCapabilityMutations/batch',
  ])
  for (const invocation of contribution.invocations) {
    expect(invocation.id.startsWith('weir-harness.')).toBe(true)
    expect(invocation.id).toBe(`weir-harness.${invocation.namespace}.${invocation.method}`)
    // Literal wire names: the gateway resolves these strings, not this module's constants.
    expect(['weirCapabilityRead', 'weirCapabilityMutation']).toContain(invocation.service)
    expect(invocation.invocation).toEqual({ kind: 'direct' })
    expect(invocation.result).toEqual({ mode: 'src-json' })
  }
  const read = contribution.invocations.filter(entry => entry.namespace === 'weirCapabilities')
  expect(read.every(entry => entry.service === 'weirCapabilityRead')).toBe(true)
  expect(read.every(entry => entry.parameters.length === 1 && entry.parameters[0].name === 'sessionId')).toBe(true)
  const mutation = contribution.invocations.filter(entry => entry.namespace === 'weirCapabilityMutations')
  expect(mutation.every(entry => entry.service === 'weirCapabilityMutation')).toBe(true)
  expect(mutation.map(entry => entry.parameters.map(parameter => parameter.name))).toEqual([['sessionId', 'request'], ['sessionId', 'request']])
})

test('the shipped contribution survives the registry validatePackage, so registration cannot die silently', () => {
  const warnings = []
  const provided = []
  const captured = []
  // The real registry's validatePackage, reproduced: a nonempty '#'-free package name,
  // a face restricted to host/client, and the package record keyed by face. It throws
  // instead of silently dropping the contribution.
  const typert = {
    register(contribution) {
      if (typeof contribution?.package !== 'string' || contribution.package.length === 0 || contribution.package.includes('#')) throw new TypeError('validatePackage: bad package')
      if (contribution?.face !== 'host' && contribution?.face !== 'client') throw new TypeError('validatePackage: bad face')
      captured.push(contribution)
    },
  }
  const ctx = {
    get: name => (name === 'typert' ? typert : undefined),
    root: { reflect: { provide: (key, service) => provided.push({ key, service }) } },
    logger: { warn: text => warnings.push(text) },
  }
  remoteApply(ctx)

  // apply() swallows a rejected registration into one warning: the pre-fix code left the write channel silently dead.
  expect(warnings).toEqual([])
  expect(captured).toHaveLength(1)
  expect(captured[0].package).toBe('weir-harness')
  expect(captured[0].face).toBe('host')
  expect(captured[0].invocations.map(entry => `${entry.namespace}/${entry.method}`)).toEqual(CAPABILITY_ENDPOINTS)
  expect(provided).toHaveLength(2)
  expect(provided[0].key).toBe(CAPABILITY_READ_SERVICE_KEY)
  expect(provided[0].service.typertRemote.namespace).toBe(CAPABILITY_READ_NAMESPACE)
  expect(provided[1].service.typertRemote.namespace).toBe(CAPABILITY_MUTATION_NAMESPACE)

  // Control: the rejector is not vacuous — the S27.2 shapes die exactly as they did in production.
  const noPackage = capabilityContribution()
  delete noPackage.package
  expect(() => typert.register(noPackage)).toThrow(/validatePackage: bad package/)
  const noFace = capabilityContribution()
  delete noFace.face
  expect(() => typert.register(noFace)).toThrow(/validatePackage: bad face/)
  // The retired fake face: the real registry rejects it before any invocation is committed.
  const legacyMutationFace = capabilityContribution()
  legacyMutationFace.face = 'host-mutations'
  expect(() => typert.register(legacyMutationFace)).toThrow(/validatePackage: bad face/)
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
    try { typert.register(capabilityContribution()); return true } catch { return live }
  }
   const faces = {
     provider: { status: () => ({}), list: async () => ({ candidates: [], complete: true }) },
     lifecycle: null,
     profileContext: () => undefined,
   }
   const service = createCapabilityReadService({ bridge: () => faces, ensureRegistered, observeSession: async id => ({ header: { id, cwd: '/tmp' }, projections: { values: { agentPreset: 'weir' } }, events: [], [Symbol.dispose]() {} }) })
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

test('a duplicate registration race with every endpoint live is success, never a warning', () => {
  // Reproduces the ordinary reload overlap at the apply seam: another
  // incarnation already owns all seven endpoints, so the new generation must
  // neither re-register nor warn — its own listener owns the later recovery.
  const endpoints = new Set(CAPABILITY_ENDPOINTS)
  const warnings = []
  let registerCalls = 0
  const typert = {
    local: { get: endpoint => (endpoints.has(endpoint) ? { id: endpoint } : undefined), hasSeen: endpoint => endpoints.has(endpoint), subscribe() {} },
    register: () => { registerCalls += 1; throw new Error('typert: package face "weir-harness#host" is already registered') },
  }
  const ctx = {
    get: name => (name === 'typert' ? typert : undefined),
    root: { reflect: { provide: () => {} } },
    logger: { warn: text => warnings.push(text) },
    effect: fn => fn(),
  }
  remoteApply(ctx)
  expect(registerCalls).toBe(0)
  expect(warnings).toEqual([])
})

{
  test('persistedSessionCwd reads the cwd from the durable log header without any agent', () => {
    const home = mkdtempSync(join(tmpdir(), 'weir-persisted-cwd-'))
    const sessionId = 'session-abc-123'
    const dir = join(home, 'sessions', '--ws-slug--', sessionId)
    mkdirSync(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 4, id: sessionId, createdAt: 1, cwd: '/ws/persisted', isSeeded: false, delegationDepth: 0 })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(header + '\n')))
    expect(persistedSessionCwd(home, sessionId)).toEqual({ found: true, cwd: '/ws/persisted' })
  })

  test('resolveSessionCwd falls through agents-registry misses to the persisted header and caches it', () => {
    const home = mkdtempSync(join(tmpdir(), 'weir-persisted-fallthrough-'))
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
    const home = mkdtempSync(join(tmpdir(), 'weir-persisted-miss-'))
    expect(persistedSessionCwd(home, 'sess-absent')).toEqual({ found: false, cwd: undefined })
    const dir = join(home, 'sessions', '--ws--', 'sess-bad')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl'), '{"type":"command/run"}\n')
    expect(persistedSessionCwd(home, 'sess-bad')).toEqual({ found: false, cwd: undefined })
    expect(persistedSessionCwd(undefined, 'sess-bad')).toEqual({ found: false, cwd: undefined })
  })
}
