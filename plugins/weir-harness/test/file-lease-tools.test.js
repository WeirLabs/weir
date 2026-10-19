import { describe, expect, it } from './helpers.js'
import { createLeaseTools, DEFAULT_HOLD_MINUTES, MAX_HOLD_MINUTES, REPLY_TOOL } from '../src/file-lease/tools.js'

// Unit tests for the model-facing tool surface (design D4/D5, spec: "Explicit
// claim, release and status tools", "Model-to-model transfer negotiation",
// "Refusal is addressed to the model").
//
// The four contracts pinned here, and why each one is worth a test:
//
//  - Every `parameters` schema is object-rooted with the documented `required`
//    set: a strict provider rejects anything else outright (S12), and a schema
//    bug is invisible until a real model call is routed.
//  - Ownership always derives from `ownerOf(exec.agent)`, never from arguments.
//  - A refusal names the holder, states the remaining validity, forbids blind
//    retries and offers negotiation — and mentions no command, setting, panel
//    or operator action, because the feature has no human exit (spec: "No
//    ownership state requires a human").
//  - The status answer is read-only ownership: no epoch, generation or recovery
//    counter may appear, because none of those concepts exist any more.

const CWD = '/work/project'
const OWNER = Object.freeze({ id: 'lineage-a', session: 'sess-a', label: 'orchestrator' })
const OTHER = Object.freeze({ id: 'lineage-b', session: 'sess-b', label: 'reviewer' })

/** One agent fixture: only the fields the tools read. */
function agentFor(session = OWNER.session, { delegationDepth = 0 } = {}) {
  return { id: session, session: { id: session, header: { id: session, cwd: CWD, delegationDepth } } }
}

/** @param {any} agent */
function execFor(agent) {
  return { agent }
}

/**
 * A scripted client: records every call and answers from `answers`. The tool
 * surface owns no state, so a recorded call list is the whole observation.
 * @param {Record<string, any>} [answers]
 */
function createFakeClient(answers = {}) {
  /** @type {any[]} */
  const calls = []
  /** @param {string} op @param {any} payload */
  async function answer(op, payload) {
    calls.push({ op, ...payload })
    const handler = answers[op]
    if (typeof handler === 'function') return await handler(payload)
    if (handler !== undefined) return handler
    return { ok: true }
  }
  return {
    calls,
    acquire: (owner, paths, scope) => answer('acquire', { owner, paths, scope }),
    hold: (paths, minutes, owner) => answer('hold', { paths, minutes, owner }),
    request: (op, payload) => answer('request', { op, ...payload }),
    status: (filter) => answer('status', { filter }),
    requestTransfer: (path, from) => answer('requestTransfer', { path, from }),
    reply: (input) => answer('reply', { ...input }),
  }
}

/**
 * @param {any[]} definitions
 * @param {string} name
 */
function tool(definitions, name) {
  const found = definitions.find((definition) => definition?.name === name)
  if (found === undefined) throw new Error(`tool ${name} is missing from the surface`)
  return found
}

/** @param {any} fake */
function lastCall(fake) {
  const call = fake.calls[fake.calls.length - 1]
  if (call === undefined) throw new Error('the tool made no client call')
  return call
}

/**
 * Run one tool and return the thrown message (or `''` when it resolved).
 * @param {any} definition @param {any} args @param {any} exec
 */
async function rejectionOf(definition, args, exec) {
  try {
    await definition.execute(args, exec)
    return ''
  } catch (error) {
    return String(/** @type {any} */ (error)?.message ?? error)
  }
}

/** A `held` failure shaped exactly like the client's (client.js `leaseError`). */
function heldFailure(conflicts) {
  return Object.assign(new Error('lease broker refused acquire: held'), { code: 'held', conflicts })
}

const tools = () => createLeaseTools({ client: createFakeClient(), ownerOf: () => OWNER })

describe('file-lease tool schemas', () => {
  it('offers exactly the six documented tools', () => {
    const definitions = tools()
    expect(definitions.map((definition) => definition.name)).toEqual([
      'edit_lock_acquire',
      'edit_lock_release',
      'edit_lock_hold',
      'edit_lock_try_steal',
      REPLY_TOOL,
      'edit_lock_status',
    ])
  })

  it('declares every parameter schema object-rooted (a strict provider rejects anything else)', () => {
    for (const definition of tools()) {
      const parameters = definition.parameters
      expect(parameters?.type, `${definition.name}: parameters must be an object schema`).toBe('object')
      expect(Array.isArray(parameters?.required), `${definition.name}: required must be an array`).toBe(true)
      expect(typeof parameters?.properties, `${definition.name}: properties must be an object`).toBe('object')
      expect(parameters.required.every((key) => Object.prototype.hasOwnProperty.call(parameters.properties, key))).toBe(true)
    }
  })

  it('requires exactly the documented fields', () => {
    const definitions = tools()
    expect(tool(definitions, 'edit_lock_acquire').parameters.required).toEqual(['paths'])
    expect(tool(definitions, 'edit_lock_release').parameters.required).toEqual(['paths'])
    expect(tool(definitions, 'edit_lock_hold').parameters.required).toEqual(['paths'])
    expect(tool(definitions, 'edit_lock_try_steal').parameters.required).toEqual(['file_path'])
    expect(tool(definitions, REPLY_TOOL).parameters.required).toEqual(['request_id', 'decision'])
    expect(tool(definitions, 'edit_lock_status').parameters.required).toEqual([])
  })

  it('makes paths a non-empty string array and minutes an optional number', () => {
    const definitions = tools()
    for (const name of ['edit_lock_acquire', 'edit_lock_release', 'edit_lock_hold']) {
      const paths = tool(definitions, name).parameters.properties.paths
      expect(paths.type, `${name}: paths must be an array`).toBe('array')
      expect(paths.items.type, `${name}: paths entries must be strings`).toBe('string')
      expect(paths.minItems, `${name}: paths must not be empty`).toBe(1)
    }
    const hold = tool(definitions, 'edit_lock_hold').parameters.properties
    expect(hold.minutes.type).toBe('number')
    expect(tool(definitions, 'edit_lock_hold').parameters.required).toEqual(['paths'])
    const decision = tool(definitions, REPLY_TOOL).parameters.properties.decision
    expect(decision.enum).toEqual(['release', 'keep'])
    expect(tool(definitions, 'edit_lock_try_steal').parameters.properties.file_path.type).toBe('string')
    expect(tool(definitions, 'edit_lock_status').parameters.properties).toEqual({})
  })
})

describe('edit_lock_acquire', () => {
  it('claims the resolved batch under the owner computed from the calling agent', async () => {
    const client = createFakeClient({
      acquire: (payload) => ({ ok: true, granted: payload.paths.map((path) => ({ path, expiresAt: Date.now() + 120_000 })) }),
    })
    /** @type {any[]} */
    const seen = []
    const ownerOf = (agent) => {
      seen.push(agent)
      return { id: 'lineage-x', session: 'sess-x', label: 'label-x' }
    }
    const definition = tool(createLeaseTools({ client, ownerOf }), 'edit_lock_acquire')
    const agent = agentFor()
    const result = await definition.execute({ paths: ['src/a.js', `${CWD}/src/b.js`, 'src/a.js'] }, execFor(agent))

    expect(seen).toEqual([agent])
    expect(lastCall(client).owner).toEqual({ id: 'lineage-x', session: 'sess-x', label: 'label-x' })
    // Relative paths resolve against the session cwd and duplicates collapse.
    expect(lastCall(client).paths).toEqual([`${CWD}/src/a.js`, `${CWD}/src/b.js`])
    expect(lastCall(client).scope).toBe(CWD)
    // The result renders short names, never the absolute forms.
    expect(result.paths).toEqual(['src/a.js', 'src/b.js'])
    expect(result.message).toContain('src/a.js')
    expect(result.message).not.toContain(CWD)
  })

  it('refuses an unowned path by naming the holder, the validity and the negotiation tool', async () => {
    const remainingMs = 87_000
    const client = createFakeClient({
      acquire: () => {
        throw heldFailure([
          { path: `${CWD}/src/a.js`, holder: { ...OTHER }, expiresAt: Date.now() + remainingMs, holdUntil: null },
        ])
      },
    })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_acquire')
    const message = await rejectionOf(definition, { paths: ['src/a.js'] }, execFor(agentFor()))

    expect(message).toContain('reviewer')
    expect(message).toContain('sess-b')
    expect(message).toMatch(/\b8[5-7]s\b/u)
    expect(message).toContain('edit_lock_try_steal')
    expect(message).toContain('do not retry')
    // Spec: "Refusal offers no human step".
    for (const forbidden of ['/edit-lock', 'panel', 'settings', 'admin', 'maintenance']) {
      expect(message).not.toContain(forbidden)
    }
  })

  it('reports an unreachable arbiter as degradation, not as a conflict', async () => {
    const client = createFakeClient({
      acquire: () => {
        throw Object.assign(new Error('lease broker is unreachable'), { code: 'transport' })
      },
    })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_acquire')
    const result = await definition.execute({ paths: ['src/a.js'] }, execFor(agentFor()))
    expect(result.degraded).toBe(true)
    expect(result.message).toContain('not a conflict')
    expect(result.message).not.toContain('edit_lock_try_steal')
    for (const forbidden of ['/edit-lock', 'panel', 'settings', 'admin', 'maintenance']) {
      expect(result.message).not.toContain(forbidden)
    }
  })
})

describe('edit_lock_release', () => {
  it('reports notOwned without treating it as an error', async () => {
    const client = createFakeClient({
      request: () => ({ ok: true, released: [`${CWD}/src/a.js`], notOwned: [`${CWD}/src/b.js`] }),
    })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_release')
    const result = await definition.execute({ paths: ['src/a.js', 'src/b.js'] }, execFor(agentFor()))

    const call = lastCall(client)
    expect(call.op).toBe('release')
    expect(call.owner).toEqual(OWNER)
    expect(call.paths).toEqual([`${CWD}/src/a.js`, `${CWD}/src/b.js`])
    expect(result.released).toEqual(['src/a.js'])
    expect(result.notOwned).toEqual(['src/b.js'])
    expect(result.message).toContain('Released 1 path(s): src/a.js')
    expect(result.message).toContain('nothing to release')
  })
})

describe('edit_lock_hold', () => {
  it('extends by the requested minutes and reports the deadline', async () => {
    const until = Date.now() + 30 * 60_000
    const client = createFakeClient({ hold: () => ({ ok: true, held: [{ path: `${CWD}/src/a.js`, expiresAt: until, holdUntil: until }] }) })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_hold')
    const result = await definition.execute({ paths: ['src/a.js'], minutes: 30 }, execFor(agentFor()))

    expect(lastCall(client).minutes).toBe(30)
    expect(lastCall(client).owner).toEqual(OWNER)
    expect(result.held).toEqual([{ path: 'src/a.js', holdUntil: until }])
    expect(result.message).toContain('src/a.js until')
    expect(result.message).toContain('about 30m from now')
    expect(result.message).toContain('nothing')
  })

  it('clamps an over-long request to the fixed maximum instead of ignoring it', async () => {
    const client = createFakeClient({ hold: (payload) => ({ ok: true, held: [{ path: payload.paths[0], expiresAt: Date.now(), holdUntil: Date.now() + MAX_HOLD_MINUTES * 60_000 }] }) })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_hold')
    await definition.execute({ paths: ['src/a.js'], minutes: 600 }, execFor(agentFor()))
    expect(lastCall(client).minutes).toBe(MAX_HOLD_MINUTES)
  })

  it('defaults to the full maximum when no minutes are asked for', async () => {
    const client = createFakeClient({ hold: () => ({ ok: true, held: [] }) })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_hold')
    await definition.execute({ paths: ['src/a.js'] }, execFor(agentFor()))
    expect(lastCall(client).minutes).toBe(DEFAULT_HOLD_MINUTES)
  })

  it('refuses retention of a path the session does not own', async () => {
    const client = createFakeClient({
      hold: () => {
        throw Object.assign(new Error('lease broker refused hold: not-owned'), { code: 'not-owned', paths: [`${CWD}/src/a.js`] })
      },
    })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_hold')
    const message = await rejectionOf(definition, { paths: ['src/a.js'] }, execFor(agentFor()))
    expect(message).toContain('does not own src/a.js')
    expect(message).toContain('edit_lock_acquire')
    for (const forbidden of ['/edit-lock', 'panel', 'settings', 'admin', 'maintenance']) {
      expect(message).not.toContain(forbidden)
    }
  })
})

describe('edit_lock_try_steal', () => {
  it('returns a pending request immediately and tells the model not to edit yet', async () => {
    const expiresAt = Date.now() + 120_000
    const client = createFakeClient({ requestTransfer: () => ({ ok: true, state: 'pending', requestId: 'r-1', holder: { ...OTHER }, expiresAt }) })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_try_steal')
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))

    expect(lastCall(client).path).toBe(`${CWD}/src/a.js`)
    expect(lastCall(client).from).toEqual(OWNER)
    expect(result.state).toBe('pending')
    expect(result.request_id).toBe('r-1')
    expect(result.holder).toEqual({ label: OTHER.label, session: OTHER.session })
    expect(result.message).toContain('Do not modify src/a.js until ownership is granted')
    expect(result.message).toContain('edit_lock_reply')
    expect(result.message).toContain('expires')
    for (const forbidden of ['/edit-lock', 'panel', 'settings', 'admin', 'maintenance']) {
      expect(result.message).not.toContain(forbidden)
    }
  })

  it('tells the model to edit directly when nobody holds the path', async () => {
    const client = createFakeClient({
      requestTransfer: () => {
        throw Object.assign(new Error('lease broker refused request: free'), { code: 'free' })
      },
    })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_try_steal')
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.state).toBe('free')
    expect(result.message).toContain('Nobody holds src/a.js')
  })

  it('does not negotiate with itself', async () => {
    const client = createFakeClient({
      requestTransfer: () => {
        throw Object.assign(new Error('lease broker refused request: self'), { code: 'self' })
      },
    })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_try_steal')
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.state).toBe('self')
    expect(result.message).toContain('already owns src/a.js')
  })
})

describe('edit_lock_reply', () => {
  it('answers with the owner computed from the calling agent and reports the transfer', async () => {
    const client = createFakeClient({ reply: () => ({ ok: true, state: 'transferred' }) })
    /** @type {any[]} */
    const notices = []
    const definition = tool(
      createLeaseTools({ client, ownerOf: () => OWNER, deliverNotice: (agent, text) => notices.push({ agent, text }) }),
      REPLY_TOOL,
    )
    const agent = agentFor()
    const result = await definition.execute({ request_id: 'r-1', decision: 'release' }, execFor(agent))

    expect(lastCall(client).requestId).toBe('r-1')
    expect(lastCall(client).decision).toBe('release')
    expect(lastCall(client).owner).toEqual(OWNER)
    expect(result.state).toBe('transferred')
    expect(result.message).toContain('transferred')
    // The holder may still have writes queued for that path: the loss of
    // ownership also arrives as a message, not only as a tool result.
    expect(notices).toHaveLength(1)
    expect(notices[0].agent).toBe(agent)
    expect(notices[0].text).toContain('no longer holds that path')
  })

  it('explains an expired or stale request instead of a bare error code', async () => {
    const expired = tool(
      createLeaseTools({
        client: createFakeClient({
          reply: () => {
            throw Object.assign(new Error('lease broker refused reply: expired'), { code: 'expired' })
          },
        }),
        ownerOf: () => OWNER,
      }),
      REPLY_TOOL,
    )
    const message = await rejectionOf(expired, { request_id: 'r-1', decision: 'keep' }, execFor(agentFor()))
    expect(message).toContain('expired')
    expect(message).toContain('ownership is unchanged')
  })
})

describe('edit_lock_status', () => {
  it('lists this session\'s holdings and other holders without lifecycle counters', async () => {
    const at = Date.now()
    const client = createFakeClient({
      status: () => ({
        ok: true,
        leases: [
          { path: `${CWD}/src/a.js`, owner: { ...OWNER }, scope: CWD, acquiredAt: at, expiresAt: at + 87_000, holdUntil: null },
          { path: `${CWD}/src/b.js`, owner: { ...OWNER }, scope: CWD, acquiredAt: at, expiresAt: at, holdUntil: at + 20 * 60_000 },
          { path: `${CWD}/src/c.js`, owner: { ...OTHER }, scope: CWD, acquiredAt: at, expiresAt: at + 42_000, holdUntil: null },
        ],
      }),
    })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_status')
    const result = await definition.execute({}, execFor(agentFor()))

    expect(lastCall(client).filter).toEqual({ scope: CWD })
    expect(result.mine).toEqual(['src/a.js', 'src/b.js'])
    expect(result.message).toContain('Held by this session (2)')
    expect(result.message).toContain('src/a.js')
    expect(result.message).toContain('retained until')
    expect(result.message).toContain('Held by other sessions here (1)')
    expect(result.message).toContain('reviewer')
    expect(result.message).toContain('sess-b')
    // Read-only ownership: the deleted lifecycle vocabulary must not come back.
    for (const forbidden of ['epoch', 'generation', 'recover', 'panel', 'settings', 'admin', 'maintenance']) {
      expect(result.message).not.toContain(forbidden)
    }
    expect(result.message).not.toContain(CWD)
  })

  it('says nothing is held instead of an empty list', async () => {
    const client = createFakeClient({ status: () => ({ ok: true, leases: [] }) })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_status')
    const result = await definition.execute({}, execFor(agentFor()))
    expect(result.message).toContain('This session holds nothing')
    expect(result.mine).toEqual([])
  })
})

describe('session working directory', () => {
  it('refuses to guess when the session cwd is unavailable', async () => {
    const definition = tool(createLeaseTools({ client: createFakeClient(), ownerOf: () => OWNER }), 'edit_lock_acquire')
    const message = await rejectionOf(definition, { paths: ['src/a.js'] }, execFor({ id: 'sess-a', session: { id: 'sess-a', header: {} } }))
    expect(message).toContain('working directory')
  })
})
