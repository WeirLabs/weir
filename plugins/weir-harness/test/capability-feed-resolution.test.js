// Per-session feed resolution (mcp-multi-owner-feed-resolution): two retained
// revisions of ONE agent preset legitimately feed the capability bridge at once
// (old sessions keep the old revision after a config change or bundle toggle).
// The owner of a session's read / mutation / AI-install ownership capture is
// the unique feed whose `faces.mcpManager()` IS the manager the session's own
// revision provides (`agents.get(id)` + `agentPresets.serviceFor(agent,
// 'weirMcpManager')`). Anything else fails closed — never newest-wins.
import { test, expect } from './helpers.js'
import {
  CapabilityReadError,
  capabilityReadFeed,
  createCapabilityMutationService,
  createCapabilityReadService,
  feedCapabilityReadBridge,
  sameMutationOwner,
} from '../src/capabilities/capability-remote.js'

const PRESET = 'weir-creative'

/** A manager whose list() names its revision, so a payload proves its owner. */
function manager(revision) {
  return { revision, list: async () => ({ managed: [{ identity: `server-${revision}` }], unmanaged: [] }) }
}

/** Faces of one mounted revision (the skill-selection feed shape). */
function faces(revision, mcpManager) {
  return {
    readPresetId: PRESET,
    provider: { status: () => ({}), list: async () => ({ candidates: [], complete: true }) },
    inventory: async () => ({ candidates: [], complete: true }),
    mcpManager: () => mcpManager,
    profileContext: () => ({ home: '/home', name: 'it' }),
    mcpOperations: () => ({
      preview: async () => ({ status: 'preview', saved: false, revision }),
      execute: async () => ({ status: 'mounted', saved: true, revision }),
      executeBatch: async () => ({ status: 'mounted', items: [], revision }),
    }),
  }
}

/**
 * Runtime doubles modelled on the installed dsh-agent-preset-registry:
 * `serviceFor(agent, name)` reads the mount retained for `agent.ctx` and
 * returns the raw implementation that mount's subtree provided.
 */
function runtime() {
  const agents = new Map()
  const mounts = new Map() // agent ctx -> { weirMcpManager }
  const calls = []
  return {
    agents,
    mounts,
    calls,
    bind(sessionId, services) {
      const ctx = { sessionId }
      agents.set(sessionId, { id: sessionId, ctx })
      mounts.set(ctx, services)
    },
    deps: {
      agents: () => ({ get: id => agents.get(id) }),
      agentPresets: () => ({
        serviceFor(agent, name) {
          calls.push([agent.id, name])
          return mounts.get(agent.ctx)?.[name]
        },
      }),
    },
  }
}

function observeSession(observed = []) {
  return async sessionId => {
    observed.push(sessionId)
    return { header: { id: sessionId, cwd: '/ws', agentPreset: PRESET }, projections: { values: { agentPreset: PRESET } }, events: [], [Symbol.dispose]() {} }
  }
}

/** Two revisions of one preset, mounted together, each with its own manager. */
function twoRevisions() {
  const rt = runtime()
  const oldManager = manager('old')
  const newManager = manager('new')
  const unfeed = [feedCapabilityReadBridge(faces('old', oldManager)), feedCapabilityReadBridge(faces('new', newManager))]
  rt.bind('old-session', { weirMcpManager: oldManager })
  rt.bind('new-session', { weirMcpManager: newManager })
  return { rt, oldManager, newManager, dispose: () => { for (const release of unfeed) release() } }
}

const rejection = promise => promise.then(() => null, cause => cause)

test('two feeds with different managers resolve to each session\'s own revision for reads', async () => {
  const { rt, dispose } = twoRevisions()
  try {
    const service = createCapabilityReadService({ observeSession: observeSession(), ...rt.deps })
    // Feed order is irrelevant: the older revision is fed first and still wins
    // for its own session — no newest-wins.
    expect((await service.list('old-session')).mcpServers.map(server => server.identity)).toEqual(['server-old'])
    expect((await service.list('new-session')).mcpServers.map(server => server.identity)).toEqual(['server-new'])
    // The owner is resolved through the registry for both the first lookup and the recheck.
    expect(rt.calls.filter(([id]) => id === 'old-session').every(([, name]) => name === 'weirMcpManager')).toBe(true)
    expect(rt.calls.filter(([id]) => id === 'old-session')).toHaveLength(2)
  } finally { dispose() }
})

test('mutations and AI install ownership capture resolve the same per-session feed token', async () => {
  const { rt, dispose } = twoRevisions()
  try {
    const service = createCapabilityMutationService({ observeSession: observeSession(), ...rt.deps })
    expect((await service.mutate('old-session', { action: 'add' })).revision).toBe('old')
    expect((await service.mutate('new-session', { action: 'add' })).revision).toBe('new')
    expect((await service.batch('old-session', { items: [] })).revision).toBe('old')

    // captureOwnership (skill-selection-plugin) = capabilityReadFeed(preset, session, runtime)
    const capture = sessionId => ({ owner: { presetId: PRESET, cwd: '/ws' }, feed: capabilityReadFeed(PRESET, sessionId, rt.deps), profile: { home: '/home', name: 'it' } })
    const oldFeed = capture('old-session').feed
    const newFeed = capture('new-session').feed
    expect(oldFeed.faces.mcpManager().revision).toBe('old')
    expect(newFeed.faces.mcpManager().revision).toBe('new')
    // Feed-token comparison stays in sameMutationOwner: same session -> same
    // token; the sibling revision's token is a different owner.
    expect(sameMutationOwner(capture('old-session'), capture('old-session'))).toBe(true)
    expect(sameMutationOwner(capture('old-session'), capture('new-session'))).toBe(false)
  } finally { dispose() }
})

test('a single feed keeps the fast path without any agent lookup', async () => {
  const rt = runtime()
  const release = feedCapabilityReadBridge(faces('only', manager('only')))
  try {
    // Deliberately no agent bound: a cold session still reads its sole feed.
    const service = createCapabilityReadService({ observeSession: observeSession(), ...rt.deps })
    expect((await service.list('cold-session')).mcpServers.map(server => server.identity)).toEqual(['server-only'])
    expect(capabilityReadFeed(PRESET, 'cold-session', rt.deps).faces.mcpManager().revision).toBe('only')
    expect(rt.calls).toHaveLength(0)
  } finally { release() }
})

test('overlapping feeds fail closed for cold/unknown agents, missing seams, no match and duplicate matches', async () => {
  const cases = {
    'cold or unknown agent': ({ rt }) => { rt.agents.delete('old-session') },
    'agent without a ctx': ({ rt }) => { rt.agents.set('old-session', { id: 'old-session' }) },
    'agent registry returns a foreign agent': ({ rt }) => { rt.agents.set('old-session', rt.agents.get('new-session')) },
    'no runtime seam at all': ({ deps }) => { delete deps.agents; delete deps.agentPresets },
    'preset registry without serviceFor': ({ deps }) => { deps.agentPresets = () => ({}) },
    'serviceFor throws': ({ deps }) => { deps.agentPresets = () => ({ serviceFor() { throw new Error('registry torn down') } }) },
    'revision provides no manager': ({ rt }) => { rt.bind('old-session', {}) },
    'no feed belongs to the revision': ({ rt }) => { rt.bind('old-session', { weirMcpManager: manager('third') }) },
    'same manager, overlapping generations': ({ oldManager, extra }) => { extra.push(feedCapabilityReadBridge(faces('old-reload', oldManager))) },
  }
  for (const [name, arrange] of Object.entries(cases)) {
    const fixture = twoRevisions()
    const extra = []
    const deps = { ...fixture.rt.deps }
    try {
      arrange({ ...fixture, deps, extra })
      const observed = []
      const read = createCapabilityReadService({ observeSession: observeSession(observed), ...deps })
      const mutation = createCapabilityMutationService({ observeSession: observeSession(), ...deps })
      for (const outcome of [
        await rejection(read.list('old-session')),
        await rejection(read.receipt('old-session')),
        await rejection(mutation.mutate('old-session', { action: 'add' })),
        await rejection((async () => capabilityReadFeed(PRESET, 'old-session', deps))()),
      ]) {
        expect(outcome, name).toBeInstanceOf(CapabilityReadError)
        expect(outcome.code, name).toBe('owner-ambiguous')
        expect(outcome.message, name).toContain(`overlapping feeds for preset ${PRESET}`)
      }
      // The sibling session with an intact, unique owner is unaffected, except
      // where the arrangement removed the shared runtime seam itself.
      if (!['no runtime seam at all', 'preset registry without serviceFor', 'serviceFor throws'].includes(name)) {
        expect((await read.list('new-session')).mcpServers.map(server => server.identity), name).toEqual(['server-new'])
      }
    } finally {
      for (const release of extra) release()
      fixture.dispose()
    }
  }
})

test('an owner whose revision is replaced during a read is owner-changed, not served by the newcomer', async () => {
  const { rt, dispose } = twoRevisions()
  let unblock
  let entered
  const waiting = new Promise(resolve => { unblock = resolve })
  const begun = new Promise(resolve => { entered = resolve })
  const slow = manager('slow')
  slow.list = async () => { entered(); await waiting; return { managed: [{ identity: 'server-slow' }], unmanaged: [] } }
  const releaseSlow = feedCapabilityReadBridge(faces('slow', slow))
  rt.bind('slow-session', { weirMcpManager: slow })
  try {
    const service = createCapabilityReadService({ observeSession: observeSession(), ...rt.deps })
    const pending = rejection(service.list('slow-session'))
    // Never hang: a read that fails before reaching the manager settles first.
    await Promise.race([begun, pending])
    // The session's agent is now composed from the new revision mid-read.
    rt.bind('slow-session', { weirMcpManager: rt.mounts.get(rt.agents.get('new-session').ctx).weirMcpManager })
    unblock()
    const outcome = await pending
    expect(outcome).toBeInstanceOf(CapabilityReadError)
    expect(outcome.code).toBe('owner-changed')
  } finally { releaseSlow(); dispose() }
})
