import { test, expect } from './helpers.js'
import {
  CAPABILITY_MUTATION_METHODS,
  CAPABILITY_MUTATION_NAMESPACE,
  CAPABILITY_MUTATION_SERVICE_KEY,
  CAPABILITY_READ_METHODS,
  CAPABILITY_READ_NAMESPACE,
  apply as remoteApply,
  capabilityMutationContribution,
  createCapabilityMutationService,
  feedCapabilityReadBridge,
} from '../src/capabilities/capability-remote.js'

const secret = 'remote-canary-secret'
function fixture() {
  const state = { presetId: 'weir', cwd: '/ws', selectionSeq: 0, profile: { home: '/home', name: 'it' }, calls: [] }
  const faces = {
    readPresetId: 'weir',
    profileContext: () => state.profile,
    mcpOperations: (_session, { assertOwner }) => ({
      preview: async request => { state.calls.push(['preview', request]); await assertOwner('preview'); return { status: 'preview', plan: [{ redacted: true }], saved: false } },
      execute: async request => { state.calls.push(['execute', request]); return { status: 'mounted', saved: true, registryRevision: 1 } },
      executeBatch: async request => { state.calls.push(['batch', request]); return { status: 'mounted', items: [] } },
    }),
  }
  const unregister = feedCapabilityReadBridge(faces)
  const observeSession = async id => ({
    header: { id, cwd: state.cwd, agentPreset: 'weir' },
    projections: { values: { agentPreset: state.presetId } },
    events: state.selectionSeq ? [{ type: 'agent-preset/selected', seq: state.selectionSeq }] : [],
    session: { append() { throw new Error('mutation appended to the session log') } },
    agent: { resume() { throw new Error('mutation resumed the agent') } },
    [Symbol.dispose]() {},
  })
  const service = createCapabilityMutationService({ observeSession })
  return { state, faces, unregister, observeSession, service }
}

test('mutation preview is log-silent and secret-free; Apply during probe is not an owner change', async () => {
  const f = fixture()
  try {
    const preview = await f.service.mutate('s1', { action: 'preview', config: { command: 'node', env: { TOKEN: secret } } })
    expect(preview.status).toBe('preview')
    expect(JSON.stringify(preview)).not.toContain(secret)
    f.faces.mcpOperations = (_session, { assertOwner }) => ({
      execute: async () => {
        f.state.selectionSeq += 1 // unrelated capability Apply, same preset/feed/profile
        await assertOwner('probe')
        await assertOwner('CAS')
        await assertOwner('mount')
        return { status: 'mounted', saved: true, registryRevision: 1 }
      },
    })
    const result = await f.service.mutate('s1', { action: 'add' })
    expect(result.status).toBe('mounted')
    expect(result.saved).toBe(true)
  } finally { f.unregister() }
})

test('preset switch before CAS prevents writes; after CAS reports actual committed facts', async () => {
  const before = fixture()
  try {
    before.faces.mcpOperations = (_session, { assertOwner }) => ({
      execute: async () => {
        before.state.presetId = 'weir-creative'
        await assertOwner('CAS')
        throw new Error('must not write')
      },
    })
    const result = await before.service.mutate('s1', { action: 'add' })
    expect(result.status).toBe('owner-changed')
    expect(result.saved).toBe(false)
  } finally { before.unregister() }

  const after = fixture()
  try {
    after.faces.mcpOperations = (_session, { assertOwner }) => ({
      execute: async () => {
        const committed = { status: 'committed', registryRevision: 1 }
        after.state.presetId = 'weir-creative'
        try { await assertOwner('mount') } catch {
          return { status: 'owner-changed', saved: true, registryRevision: committed.registryRevision, mount: { state: 'not-started' } }
        }
        throw new Error('must not mount')
      },
    })
    const result = await after.service.mutate('s1', { action: 'add' })
    expect(result.status).toBe('owner-changed')
    expect(result.saved).toBe(true)
    expect(result.registryRevision).toBe(1)
    expect(result.mount.state).toBe('not-started')
  } finally { after.unregister() }
})

test('a stale success response is downgraded with actual saved facts, never a rollback', async () => {
  const f = fixture()
  try {
    f.faces.mcpOperations = () => ({
      execute: async () => {
        const result = { status: 'mounted', saved: true, registryRevision: 7, generation: 2, incarnation: 'inc-x' }
        f.state.presetId = 'weir-creative'
        return result
      },
    })
    const result = await f.service.mutate('s1', { action: 'add' })
    expect(result.status).toBe('owner-changed')
    expect(result.ownerChanged).toBe(true)
    expect(result.actual).toEqual({ status: 'mounted', saved: true, registryRevision: 7, generation: 2, incarnation: 'inc-x' })
  } finally { f.unregister() }
})

test('the exact current preset owns the mutation feed; sibling presets stay isolated', async () => {
  const f = fixture()
  const creative = {
    readPresetId: 'weir-creative', profileContext: () => f.state.profile,
    mcpOperations: () => ({ execute: async () => ({ status: 'preview', owner: 'creative' }) }),
  }
  const unregisterCreative = feedCapabilityReadBridge(creative)
  try {
    f.state.presetId = 'weir-creative'
    const result = await f.service.mutate('s1', { action: 'add' })
    expect(result.owner).toBe('creative')
  } finally { unregisterCreative(); f.unregister() }
})

test('mutation contribution is a separate object-rooted request channel with sessionId and request', () => {
  const contribution = capabilityMutationContribution()
  expect(contribution.face).toBe('host-mutations')
  expect(contribution.invocations.map(entry => entry.method)).toEqual(CAPABILITY_MUTATION_METHODS)
  for (const invocation of contribution.invocations) {
    expect(invocation.service).toBe(CAPABILITY_MUTATION_SERVICE_KEY)
    expect(invocation.namespace).toBe(CAPABILITY_MUTATION_NAMESPACE)
    expect(invocation.parameters.map(parameter => parameter.name)).toEqual(['sessionId', 'request'])
  }
})

test('host self-healing verifies every read and write endpoint independently', async () => {
  const live = new Set()
  const registrations = []
  const provided = []
  const typert = {
    local: { get: key => live.has(key) ? { id: key } : undefined },
    register(contribution) {
      registrations.push(contribution)
      for (const invocation of contribution.invocations) live.add(`${invocation.namespace}/${invocation.method}`)
    },
  }
  const observation = id => ({ header: { id, cwd: '/ws' }, projections: { values: { agentPreset: 'weir' } }, events: [], [Symbol.dispose]() {} })
  const ctx = {
    get: name => name === 'typert' ? typert : name === 'sessionQuery' ? { observeSession: async id => observation(id) } : undefined,
    root: { reflect: { provide: (key, service) => provided.push({ key, service }) } },
    logger: { warn() {} },
    emit() {},
  }
  remoteApply(ctx)
  const f = fixture()
  try {
    for (const method of CAPABILITY_READ_METHODS) expect(live.has(`${CAPABILITY_READ_NAMESPACE}/${method}`)).toBe(true)
    for (const method of CAPABILITY_MUTATION_METHODS) expect(live.has(`${CAPABILITY_MUTATION_NAMESPACE}/${method}`)).toBe(true)
    const initial = registrations.length
    live.delete(`${CAPABILITY_MUTATION_NAMESPACE}/mutate`)
    live.delete(`${CAPABILITY_MUTATION_NAMESPACE}/batch`)
    const mutation = provided.find(entry => entry.key === CAPABILITY_MUTATION_SERVICE_KEY).service
    await mutation.mutate('s1', { action: 'preview' })
    expect(live.has(`${CAPABILITY_MUTATION_NAMESPACE}/mutate`)).toBe(true)
    expect(live.has(`${CAPABILITY_MUTATION_NAMESPACE}/batch`)).toBe(true)
    expect(registrations.length).toBeGreaterThan(initial)
    live.delete(`${CAPABILITY_READ_NAMESPACE}/receipt`)
    await mutation.mutate('s1', { action: 'preview' })
    expect(live.has(`${CAPABILITY_READ_NAMESPACE}/receipt`)).toBe(true)
  } finally { f.unregister() }
})
