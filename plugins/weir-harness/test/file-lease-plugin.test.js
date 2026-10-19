import { describe, expect, it } from './helpers.js'
import { createFileLeasePlugin, apply as defaultApply, inject as defaultInject, name as defaultName } from '../src/file-lease/plugin.js'

// Unit tests for the file-lease plugin row (design D4 wake delivery, D10 release
// table, D11 mount lifetime), driven by a fake client and a fake cordis ctx: no
// socket, no daemon, no real host.
//
// The contracts pinned here are the ones a regression would hide until a real
// two-session contention:
//
//  - the static tool surface is exactly the five always-on tools, and the reply
//    tool appears only while a request is pending and never outlives a turn;
//  - `turn/end` releases for ANY reason and `agent/disposed` releases retention
//    too — both best-effort, so a failing client must not throw into the event;
//  - a request wakes an idle holder exactly once (followup) and merely steers a
//    running one; a holder that is not live in this process is dropped silently;
//  - `settled` reaches the requester by its own request id, and applying twice
//    to one ctx (two preset mounts) neither throws nor duplicates a tool.

const CWD = '/work/project'
const OWNER = Object.freeze({ id: 'lineage-a', session: 'sess-a', label: 'orchestrator' })
const OTHER = Object.freeze({ id: 'lineage-b', session: 'sess-b', label: 'reviewer' })

/** @param {number} [ms] */
function delay(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Let queued microtasks and the one detached event chain settle. */
async function flush() {
  await delay(0)
  await delay(0)
}

/**
 * A fake tool registry shared by one ctx scope (mount) or one agent scope.
 */
function createRegistry() {
  /** @type {{ name: string, definition: any, disposed: boolean }[]} */
  const entries = []
  return {
    entries,
    get(/** @type {string} */ name) {
      return entries.find((entry) => entry.name === name && !entry.disposed)?.definition
    },
    register(/** @type {any} */ definition) {
      if (entries.some((entry) => entry.name === definition.name && !entry.disposed)) {
        throw new Error(`tool "${definition.name}" is already registered in this scope`)
      }
      const entry = { name: definition.name, definition, disposed: false }
      entries.push(entry)
      return () => {
        entry.disposed = true
      }
    },
    /** @returns {string[]} the names currently visible in this scope */
    names() {
      return entries.filter((entry) => !entry.disposed).map((entry) => entry.name)
    },
  }
}

/**
 * A fake cordis ctx: handler table, tool registry, logger.
 * @param {Map<string, any>} agents
 */
function createCtx(agents = new Map()) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map()
  const tools = createRegistry()
  /** @type {string[]} */
  const warnings = []
  return {
    tools,
    warnings,
    get(/** @type {string} */ key) {
      if (key === 'agents') return { get: (/** @type {string} */ id) => agents.get(id) }
      return undefined
    },
    on(/** @type {string} */ event, /** @type {Function} */ handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const current = handlers.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    /** @param {string} event @param {...any} payload */
    emit(event, ...payload) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...payload)
    },
    listenerCount(/** @type {string} */ event) {
      return (handlers.get(event) ?? []).length
    },
    logger: {
      warn(/** @type {string} */ message) {
        warnings.push(message)
      },
    },
  }
}

/**
 * One fake agent with its own scope layer, message channels and status.
 * @param {string} id
 * @param {{ status?: string, cwd?: string, throwOnSend?: boolean }} [options]
 */
function createAgent(id, { status = 'idle', cwd = CWD, throwOnSend = false } = {}) {
  /** @type {{ channel: string, message: any }[]} */
  const sent = []
  const tools = createRegistry()
  const agent = {
    id,
    status,
    session: { id, header: { id, cwd, delegationDepth: 0 } },
    sent,
    ctx: { tools },
    /** @param {any} message */
    followup(message) {
      if (throwOnSend) throw new Error('followup refused')
      sent.push({ channel: 'followup', message })
      return Promise.resolve()
    },
    /** @param {any} message */
    steer(message) {
      if (throwOnSend) throw new Error('steer refused')
      sent.push({ channel: 'steer', message })
    },
  }
  return agent
}

/** The text of the last message an agent received. @param {any} agent */
function lastText(agent) {
  const last = agent.sent[agent.sent.length - 1]
  return last === undefined ? '' : String(last.message?.content?.[0]?.text ?? '')
}

/**
 * A fake lease client: records releases, holds the event subscription table and
 * answers the handful of protocol calls the tools make.
 * @param {{ status?: (filter: any) => any, releaseSession?: (session: string) => any, requestTransfer?: (path: string, from: any) => any, reply?: (input: any) => any, acquire?: (owner: any, paths: string[], scope: string) => any, hold?: (paths: string[], minutes: number, owner: any) => any, request?: (op: string, payload: any) => any }} [answers]
 */
function createFakeClient(answers = {}) {
  /** @type {{ ok: boolean, released: string[], notOwned: string[] }[]} */
  const releases = []
  /** @type {string[]} */
  const releasedAll = []
  /** @type {Set<(event: any) => void>} */
  const handlers = new Set()
  /** @type {any[]} */
  const calls = []
  const client = {
    releases,
    releasedAll,
    calls,
    /** @returns {number} */
    subscriberCount() {
      return handlers.size
    },
    onEvent(/** @type {(event: any) => void} */ handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    /** @param {any} event */
    push(event) {
      for (const handler of [...handlers]) handler(event)
    },
    async releaseSession(/** @type {string} */ session) {
      releases.push({ ok: true, released: [session], notOwned: [] })
      if (typeof answers.releaseSession === 'function') return await answers.releaseSession(session)
      return { released: [] }
    },
    async releaseAll(/** @type {string} */ session) {
      releasedAll.push(session)
      return { released: [] }
    },
    async acquire(/** @type {any} */ owner, /** @type {any} */ paths, /** @type {any} */ scope) {
      calls.push({ op: 'acquire', owner, paths, scope })
      if (typeof answers.acquire === 'function') return await answers.acquire(owner, paths, scope)
      return { ok: true, granted: paths.map((/** @type {string} */ path) => ({ path })) }
    },
    async hold(/** @type {any} */ paths, /** @type {any} */ minutes, /** @type {any} */ owner) {
      calls.push({ op: 'hold', paths, minutes, owner })
      if (typeof answers.hold === 'function') return await answers.hold(paths, minutes, owner)
      return { ok: true, held: [] }
    },
    async status(/** @type {any} */ filter) {
      calls.push({ op: 'status', filter })
      if (typeof answers.status === 'function') return await answers.status(filter)
      return { ok: true, leases: [] }
    },
    async requestTransfer(/** @type {any} */ path, /** @type {any} */ from) {
      calls.push({ op: 'requestTransfer', path, from })
      if (typeof answers.requestTransfer === 'function') return await answers.requestTransfer(path, from)
      return { ok: true, state: 'pending', requestId: 'r-default', holder: { ...OTHER }, expiresAt: Date.now() + 120_000 }
    },
    async request(/** @type {any} */ op, /** @type {any} */ payload) {
      calls.push({ op: 'request', name: op, payload })
      if (typeof answers.request === 'function') return await answers.request(op, payload)
      return { ok: true, released: [], notOwned: [] }
    },
    async reply(/** @type {any} */ input) {
      calls.push({ op: 'reply', input })
      if (typeof answers.reply === 'function') return await answers.reply(input)
      return { ok: true, state: input?.decision === 'release' ? 'transferred' : 'declined' }
    },
  }
  return client
}

/** The tools this mount registered. @param {any} ctx */
function registeredNames(ctx) {
  return ctx.tools.names()
}

/** @param {any} definition @param {any} args @param {any} exec */
async function execute(definition, args, exec) {
  return await definition.execute(args, exec)
}

/** The `request` event the arbiter pushes to the holder's connection. */
function requestEvent(overrides = {}) {
  return { event: 'request', requestId: 'r-1', path: `${CWD}/src/a.js`, from: { ...OTHER }, expiresAt: Date.now() + 120_000, ...overrides }
}

describe('file-lease plugin row', () => {
  it('exports the default instance in the same shape as every other row', () => {
    expect(defaultName).toBe('weir-file-lease')
    expect(defaultInject).toEqual(['tools', 'agents'])
    expect(typeof defaultApply).toBe('function')
    const instance = createFileLeasePlugin({ client: createFakeClient() })
    expect(instance.name).toBe('weir-file-lease')
    expect(instance.inject).toEqual(['tools', 'agents'])
    expect(typeof instance.apply).toBe('function')
  })

  it('registers the five always-on tools and not the conditional reply tool', () => {
    const ctx = createCtx()
    const plugin = createFileLeasePlugin({ client: createFakeClient(), deliver: () => true })
    const dispose = plugin.apply(ctx)
    expect(registeredNames(ctx).sort()).toEqual([
      'edit_lock_acquire',
      'edit_lock_hold',
      'edit_lock_release',
      'edit_lock_status',
      'edit_lock_try_steal',
    ])
    expect(ctx.listenerCount('turn/end')).toBe(1)
    expect(ctx.listenerCount('agent/disposed')).toBe(1)
    dispose()
  })

  it('apply(ctx, { enabled: false }) is a composition seam that mounts nothing', () => {
    // Seam contract (edit-lock-rebuild 3.8): a test composition can carry the row
    // switched off. "Off" means absent: no tool, no listener, no client
    // subscription, and no disposer to hand back.
    const ctx = createCtx()
    const client = createFakeClient()
    const plugin = createFileLeasePlugin({ client, deliver: () => true })
    const dispose = plugin.apply(ctx, { enabled: false })
    expect(dispose).toBeUndefined()
    expect(registeredNames(ctx)).toEqual([])
    expect(ctx.listenerCount('turn/end')).toBe(0)
    expect(ctx.listenerCount('session/event')).toBe(0)
    expect(ctx.listenerCount('agent/disposed')).toBe(0)
    expect(client.subscriberCount()).toBe(0)

    // The default is enabled: an omitted or empty config changes nothing, so the
    // production presets (which never write the key) keep the full surface.
    plugin.apply(ctx, {})
    expect(registeredNames(ctx)).toHaveLength(5)
  })
})

describe('turn lifecycle release (D10)', () => {
  it('releases on every turn end, whatever the reason', () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient()
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    for (const reason of [{ kind: 'completed' }, { kind: 'aborted', reason: { kind: 'user' } }, { kind: 'error', error: { message: 'boom', code: 'llm' } }]) {
      ctx.emit('turn/end', { agent, reason })
    }
    expect(client.releases).toHaveLength(3)
    dispose()
  })

  it('releases through the durable turn/end session event this runtime publishes', () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient()
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    ctx.emit('session/event', { id: OWNER.session }, { type: 'turn/start', data: { turn: 2 } })
    expect(client.releases).toHaveLength(0)
    ctx.emit('session/event', { id: OWNER.session }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    expect(client.releases).toHaveLength(1)
    // An unknown session cannot name an agent, so nothing is released for it.
    ctx.emit('session/event', { id: 'ghost' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    expect(client.releases).toHaveLength(1)
    dispose()
  })

  it('releases retention too when an agent is disposed', () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient()
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    ctx.emit('agent/disposed', { agent })
    expect(client.releasedAll).toEqual([OWNER.session])
    expect(client.releases).toHaveLength(0)
    dispose()
  })

  it('never throws when the client fails the release', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient({
      releaseSession: () => {
        throw new Error('broker gone')
      },
    })
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    ctx.emit('turn/end', { agent, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await flush()
    expect(ctx.warnings).toEqual([])
    dispose()
  })
})

describe('negotiation delivery (D4)', () => {
  it('wakes an idle holder in one turn and names the requester and the reply tool', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    /** @type {any[]} */
    const delivered = []
    const client = createFakeClient({ status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }) })
    const plugin = createFileLeasePlugin({
      client,
      ownerOf: () => OWNER,
      deliver: (agent, text, wake) => {
        delivered.push({ agent, text, wake })
        return true
      },
    })
    const agent = createAgent(OWNER.session, { status: 'idle' })
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    client.push(requestEvent())
    await flush()

    expect(delivered).toHaveLength(1)
    expect(delivered[0].agent).toBe(agent)
    expect(delivered[0].wake).toBe(true)
    const text = delivered[0].text
    expect(text).toContain('reviewer')
    expect(text).toContain('sess-b')
    expect(text).toContain('src/a.js')
    expect(text).toContain('r-1')
    expect(text).toContain('edit_lock_reply')
    expect(text).toContain('release')
    expect(text).toContain('keep')
    expect(text).toContain('ownership stays yours')
    expect(text).not.toContain(CWD)
    for (const forbidden of ['/edit-lock', 'panel', 'settings', 'admin', 'maintenance']) {
      expect(text).not.toContain(forbidden)
    }
    dispose()
  })

  it('does not wake a holder that is mid-turn, and lands the request in that turn', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    /** @type {any[]} */
    const delivered = []
    const client = createFakeClient({ status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }) })
    const plugin = createFileLeasePlugin({
      client,
      ownerOf: () => OWNER,
      deliver: (agent, text, wake) => {
        delivered.push({ agent, text, wake })
        return true
      },
    })
    const agent = createAgent(OWNER.session, { status: 'running' })
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    client.push(requestEvent())
    await flush()

    expect(delivered).toHaveLength(1)
    expect(delivered[0].wake).toBe(false)
    dispose()
  })

  it('uses followup to wake an idle agent and steer for a running one', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient({ status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }) })
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER })
    const agent = createAgent(OWNER.session, { status: 'idle' })
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    client.push(requestEvent({ requestId: 'r-idle' }))
    await flush()
    expect(agent.sent.map((entry) => entry.channel)).toEqual(['followup'])
    expect(lastText(agent)).toContain('edit_lock_reply')

    agent.status = 'running'
    client.push(requestEvent({ requestId: 'r-running' }))
    await flush()
    expect(agent.sent.map((entry) => entry.channel)).toEqual(['followup', 'steer'])
    dispose()
  })

  it('drops a request addressed to a session that is not live here, without throwing', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    let delivered = 0
    const client = createFakeClient({
      status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OTHER, session: 'sess-elsewhere' } }] }),
    })
    const plugin = createFileLeasePlugin({
      client,
      ownerOf: () => OWNER,
      deliver: () => {
        delivered += 1
        return true
      },
    })
    const dispose = plugin.apply(ctx)

    client.push(requestEvent())
    await flush()
    expect(delivered).toBe(0)
    expect(ctx.warnings).toEqual([])
    dispose()
  })

  it('stays silent when both message channels refuse', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient({ status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }) })
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER })
    const agent = createAgent(OWNER.session, { throwOnSend: true })
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    client.push(requestEvent())
    await flush()
    expect(agent.sent).toEqual([])
    expect(ctx.warnings).toEqual([])
    dispose()
  })

  it('reports the settled outcome to the requester that asked for it', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient()
    /** @type {any[]} */
    const delivered = []
    const plugin = createFileLeasePlugin({
      client,
      ownerOf: () => OWNER,
      deliver: (agent, text, wake) => {
        delivered.push({ agent, text, wake })
        return true
      },
    })
    const agent = createAgent(OWNER.session, { status: 'idle' })
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    const steal = ctx.tools.get('edit_lock_try_steal')
    const result = await execute(steal, { file_path: 'src/a.js' }, { agent })
    expect(result.state).toBe('pending')
    const requestId = result.request_id
    expect(requestId).toBe('r-default')

    client.push({ event: 'settled', requestId, path: `${CWD}/src/a.js`, state: 'transferred' })
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toContain('transferred')
    expect(delivered[0].text).toContain('src/a.js')
    expect(delivered[0].wake).toBe(true)

    // A second event for the same request is nobody's: the outcome was consumed.
    client.push({ event: 'settled', requestId, path: `${CWD}/src/a.js`, state: 'transferred' })
    await flush()
    expect(delivered).toHaveLength(1)
    dispose()
  })

  it('tells the requester when the holder declined or let the request expire', async () => {
    for (const state of ['declined', 'expired']) {
      const agents = new Map()
      const ctx = createCtx(agents)
      const client = createFakeClient()
      /** @type {string[]} */
      const texts = []
      const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: (_agent, text) => texts.push(text) })
      const agent = createAgent(OWNER.session)
      agents.set(OWNER.session, agent)
      const dispose = plugin.apply(ctx)

      const steal = ctx.tools.get('edit_lock_try_steal')
      await execute(steal, { file_path: 'src/a.js' }, { agent })
      client.push({ event: 'settled', requestId: 'r-default', path: `${CWD}/src/a.js`, state })
      await flush()
      expect(texts).toHaveLength(1)
      expect(texts[0]).toContain(state === 'declined' ? 'kept' : 'expired')
      expect(texts[0]).toMatch(/ownership is unchanged/iu)
      dispose()
    }
  })

  it('ignores a settled event for a request this process never issued', async () => {
    const ctx = createCtx()
    const client = createFakeClient()
    let delivered = 0
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => { delivered += 1; return true } })
    const dispose = plugin.apply(ctx)

    client.push({ event: 'settled', requestId: 'not-ours', path: `${CWD}/src/a.js`, state: 'expired' })
    await flush()
    expect(delivered).toBe(0)
    dispose()
  })
})

describe('dynamic edit_lock_reply registration', () => {
  /** @param {any} ctx @param {any} client @param {any} agent */
  async function pendingRequest(ctx, client, agent, requestId = 'r-1') {
    client.push(requestEvent({ requestId }))
    await flush()
    return agent.ctx.tools.get('edit_lock_reply')
  }

  it('appears only while a request is pending', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient({
      status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }),
    })
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    expect(agent.ctx.tools.get('edit_lock_reply')).toBeUndefined()
    const replyTool = await pendingRequest(ctx, client, agent)
    expect(replyTool?.name).toBe('edit_lock_reply')
    // It lives on the agent's own scope, not on the mount's.
    expect(ctx.tools.get('edit_lock_reply')).toBeUndefined()
    dispose()
  })

  it('disappears when the pending set empties and survives while one is left', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient({
      status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }),
    })
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    await pendingRequest(ctx, client, agent, 'r-1')
    await pendingRequest(ctx, client, agent, 'r-2')
    const replyTool = agent.ctx.tools.get('edit_lock_reply')
    expect(replyTool).toBeTruthy()

    const first = await execute(replyTool, { request_id: 'r-1', decision: 'keep' }, { agent })
    expect(first.state).toBe('declined')
    expect(agent.ctx.tools.get('edit_lock_reply')).toBeTruthy()

    await execute(agent.ctx.tools.get('edit_lock_reply'), { request_id: 'r-2', decision: 'release' }, { agent })
    expect(agent.ctx.tools.get('edit_lock_reply')).toBeUndefined()
    dispose()
  })

  it('is retired at the turn boundary whether or not the holder answered', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient({
      status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }),
    })
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    await pendingRequest(ctx, client, agent)
    expect(agent.ctx.tools.get('edit_lock_reply')).toBeTruthy()
    ctx.emit('turn/end', { agent, reason: { kind: 'completed' } })
    expect(agent.ctx.tools.get('edit_lock_reply')).toBeUndefined()
    dispose()
  })

  it('registers idempotently: a second request does not throw', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient({
      status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }),
    })
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)

    await pendingRequest(ctx, client, agent, 'r-1')
    await pendingRequest(ctx, client, agent, 'r-2')
    expect(agent.ctx.tools.names().filter((name) => name === 'edit_lock_reply')).toEqual(['edit_lock_reply'])
    expect(ctx.warnings).toEqual([])
    dispose()
  })
})

describe('mount lifetime (D11)', () => {
  it('applies twice on the same ctx without throwing or duplicating a tool', () => {
    const ctx = createCtx()
    const client = createFakeClient()
    const first = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const second = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => true })
    const disposeFirst = first.apply(ctx)
    const disposeSecond = second.apply(ctx)

    expect(registeredNames(ctx).sort()).toEqual([
      'edit_lock_acquire',
      'edit_lock_hold',
      'edit_lock_release',
      'edit_lock_status',
      'edit_lock_try_steal',
    ])
    disposeSecond()
    expect(registeredNames(ctx)).toHaveLength(5)
    disposeFirst()
    expect(registeredNames(ctx)).toHaveLength(0)
  })

  it('unregisters its tools, listeners and event subscription, and never closes the client', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient({
      status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }),
    })
    let delivered = 0
    const plugin = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => { delivered += 1; return true } })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const dispose = plugin.apply(ctx)
    expect(client.subscriberCount()).toBe(1)

    dispose()
    expect(registeredNames(ctx)).toEqual([])
    expect(ctx.listenerCount('turn/end')).toBe(0)
    expect(ctx.listenerCount('session/event')).toBe(0)
    expect(ctx.listenerCount('agent/disposed')).toBe(0)
    expect(client.subscriberCount()).toBe(0)

    // A late request must not resume any registration after unmount.
    client.push(requestEvent())
    await flush()
    expect(delivered).toBe(0)
    expect(agent.ctx.tools.names()).toEqual([])
    expect(registeredNames(ctx)).toEqual([])
  })

  it('is idempotent: a second dispose call does nothing', () => {
    const ctx = createCtx()
    const plugin = createFileLeasePlugin({ client: createFakeClient(), ownerOf: () => OWNER, deliver: () => true })
    const dispose = plugin.apply(ctx)
    dispose()
    dispose()
    expect(registeredNames(ctx)).toEqual([])
  })
})

describe('owner identity defaults to the lineage rule (D9)', () => {
  it('derives the owner from the calling agent: lineage, session and label', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient()
    const plugin = createFileLeasePlugin({ client, deliver: () => true })
    const agent = createAgent('sess-root')
    agent.session.header.title = 'Orchestrator'
    agents.set('sess-root', agent)
    const dispose = plugin.apply(ctx)

    await execute(ctx.tools.get('edit_lock_acquire'), { paths: ['src/a.js'] }, { agent })
    const call = client.calls.find((entry) => entry.op === 'acquire')
    expect(call.owner).toEqual({ id: 'sess-root', session: 'sess-root', label: 'Orchestrator' })
    dispose()
  })

  it('gives a delegated child its spawner lineage, so a child never conflicts with its parent', async () => {
    const agents = new Map()
    const ctx = createCtx(agents)
    const client = createFakeClient()
    const plugin = createFileLeasePlugin({ client, deliver: () => true })
    const parent = createAgent('sess-parent')
    const child = createAgent('sess-child')
    child.session.header.delegationDepth = 1
    child.session.header.parentSession = 'sess-parent'
    agents.set('sess-parent', parent)
    agents.set('sess-child', child)
    const dispose = plugin.apply(ctx)

    await execute(ctx.tools.get('edit_lock_acquire'), { paths: ['src/a.js'] }, { agent: child })
    const call = client.calls.find((entry) => entry.op === 'acquire')
    // Sibling/parent claims are the same owner id, so no conflict is possible; the
    // session stays the child's own so its turn end releases what IT acquired.
    expect(call.owner.id).toBe('sess-parent')
    expect(call.owner.session).toBe('sess-child')
    dispose()
  })
})

describe('two preset mounts share one client (D11)', () => {
  it('wakes a holder once per request, not once per mount', async () => {
    const agents = new Map()
    const ctxA = createCtx(agents)
    const ctxB = createCtx(agents)
    const client = createFakeClient({ status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER } }] }) })
    let delivered = 0
    const mountA = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => { delivered += 1; return true } })
    const mountB = createFileLeasePlugin({ client, ownerOf: () => OWNER, deliver: () => { delivered += 1; return true } })
    const agent = createAgent(OWNER.session)
    agents.set(OWNER.session, agent)
    const disposeA = mountA.apply(ctxA)
    const disposeB = mountB.apply(ctxB)

    // Each mount scopes its own tool surface...
    expect(registeredNames(ctxA)).toHaveLength(5)
    expect(registeredNames(ctxB)).toHaveLength(5)

    // ...but the request event reaches both through the shared client, and the
    // holder must be woken exactly once (spec: "Idle holder is woken once").
    client.push(requestEvent())
    await flush()
    expect(delivered).toBe(1)
    expect(agent.ctx.tools.names()).toEqual(['edit_lock_reply'])

    disposeA()
    disposeB()
  })
})
