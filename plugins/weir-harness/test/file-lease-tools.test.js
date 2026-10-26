import { describe, expect, it } from './helpers.js'
import { createLeaseTools, DEFAULT_HOLD_MINUTES, MAX_HOLD_MINUTES, REPLY_TOOL, WATCH_TOOL } from '../src/file-lease/tools.js'
import { createWatchCoordinator } from '../src/file-lease/watch.js'
import { createBroker } from '../src/lease-broker/state.js'

// Unit tests for the model-facing tool surface (design D4/D5, spec: "Explicit
// claim, release and status tools", "Model-to-model transfer negotiation",
// "Refusal is addressed to the model").
//
// The six contracts pinned here, and why each one is worth a test:
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
//  - Every model-supplied path is normalized lexically before it reaches the
//    arbiter or the subscription table, so one file has one claim and one
//    subscription however the model spelled it (`..`, `.`, doubled separators).
//  - A retention expiry is announced only to a session that explicitly
//    subscribed to that path's release: with no subscriber nothing is
//    announced, and unconditional silence is the obsolete contract.
//
// Two sections drive the SAME assertions through the real arbitration kernel,
// because a scripted client answer cannot show what a live broker does with two
// spellings of one file: it keeps two separate lease rows.

/** One macrotask, so a deferred subscription notice can fire. @param {number} [ms] */
function delay(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

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
    // A capable broker by default: the release-event advertisement is a
    // property of the handshake, and an absent query reads as unsupported.
    supportsEvent: (name) => (typeof answers.supportsEvent === 'function' ? answers.supportsEvent(name) : true),
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
  it('offers exactly the seven documented tools', () => {
    const definitions = tools()
    expect(definitions.map((definition) => definition.name)).toEqual([
      'edit_lock_acquire',
      'edit_lock_release',
      'edit_lock_hold',
      'edit_lock_try_steal',
      REPLY_TOOL,
      'edit_lock_status',
      WATCH_TOOL,
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
    expect(tool(definitions, WATCH_TOOL).parameters.required).toEqual(['file_path'])
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
    const watchPath = tool(definitions, WATCH_TOOL).parameters.properties.file_path
    expect(watchPath.type).toBe('string')
    // One path per subscription: the batch shape belongs to acquire/release.
    expect(tool(definitions, WATCH_TOOL).parameters.properties.paths).toBeUndefined()
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
    // `..`, `.` and doubled separators are spellings of the same file: the batch
    // reaches the arbiter canonical and de-duplicated, so an alias cannot open a
    // second claim on a path this session (or another one) already holds.
    const result = await definition.execute(
      { paths: ['src/a.js', `${CWD}/src/b.js`, 'src/a.js', `${CWD}/src/../src/a.js`, `${CWD}//src/./b.js`] },
      execFor(agent),
    )

    expect(seen).toEqual([agent])
    expect(lastCall(client).owner).toEqual({ id: 'lineage-x', session: 'sess-x', label: 'label-x' })
    // Relative paths resolve against the session cwd and every alias collapses.
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
    const result = await definition.execute({ paths: ['src/a.js', `${CWD}/src/../src/a.js`, `${CWD}//src/./b.js`] }, execFor(agentFor()))

    const call = lastCall(client)
    expect(call.op).toBe('release')
    expect(call.owner).toEqual(OWNER)
    // One canonical entry per file: the aliased spellings never reach the broker.
    expect(call.paths).toEqual([`${CWD}/src/a.js`, `${CWD}/src/b.js`])
    expect(result.released).toEqual(['src/a.js'])
    expect(result.notOwned).toEqual(['src/b.js'])
    expect(result.message).toContain('Released 1 path(s): src/a.js')
    expect(result.message).toContain('nothing to release')
  })
})

describe('edit_lock_hold', () => {
  it('describes expiry as reaching only an explicit release subscriber', () => {
    const description = tool(tools(), 'edit_lock_hold').description
    expect(description).toContain('only to a session that explicitly subscribed')
    expect(description).toContain('edit_lock_watch')
    // The old unconditional claim must not come back.
    expect(description).not.toContain('become available and nothing is announced')
  })

  it('extends by the requested minutes and reports the deadline', async () => {
    const until = Date.now() + 30 * 60_000
    const client = createFakeClient({ hold: () => ({ ok: true, held: [{ path: `${CWD}/src/a.js`, expiresAt: until, holdUntil: until }] }) })
    const definition = tool(createLeaseTools({ client, ownerOf: () => OWNER }), 'edit_lock_hold')
    const result = await definition.execute({ paths: ['src/a.js', `${CWD}/src/../src/a.js`], minutes: 30 }, execFor(agentFor()))

    // Retention names the same canonical paths as the claim did.
    expect(lastCall(client).paths).toEqual([`${CWD}/src/a.js`])
    expect(lastCall(client).minutes).toBe(30)
    expect(lastCall(client).owner).toEqual(OWNER)
    expect(result.held).toEqual([{ path: 'src/a.js', holdUntil: until }])
    expect(result.message).toContain('src/a.js until')
    expect(result.message).toContain('about 30m from now')
    // Superseded wording: a deadline is not unconditionally silent. The expiry is
    // announced only to a session that explicitly subscribed to the release.
    expect(result.message).toContain('only to a session that explicitly subscribed')
    expect(result.message).toContain('edit_lock_watch')
    expect(result.message).toContain('with no subscriber nothing is announced')
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
    const result = await definition.execute({ file_path: `${CWD}/src/../src/a.js` }, execFor(agentFor()))

    // The negotiation names the canonical path, so the holder's own spelling of
    // the same file cannot make the request miss (or duplicate) its mailbox.
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

describe('edit_lock_watch', () => {
  /** A lease row held by the other session on this path. */
  function heldByOther(path = `${CWD}/src/a.js`) {
    return { ok: true, leases: [{ path, owner: { ...OTHER }, scope: CWD, acquiredAt: 1, expiresAt: Date.now() + 90_000, holdUntil: null }] }
  }

  /**
   * @param {Record<string, any>} [answers]
   * @param {ReturnType<typeof createWatchCoordinator>} [registry]
   */
  function watchTool(answers = {}, registry = createWatchCoordinator()) {
    const client = createFakeClient({ status: () => heldByOther(), ...answers })
    return { definition: tool(createLeaseTools({ client, ownerOf: () => OWNER, watchCoordinator: registry }), WATCH_TOOL), registry, client }
  }

  it('subscribes once for a path another session holds and names the holder and the next step', async () => {
    const { definition, registry, client } = watchTool()
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))

    // The authority was asked, never the ledger, and with the resolved path.
    expect(lastCall(client).filter).toEqual({ path: `${CWD}/src/a.js` })
    expect(result.state).toBe('watching')
    expect(result.file_path).toBe('src/a.js')
    expect(result.holder).toEqual({ label: OTHER.label, session: OTHER.session })
    expect(result.message).toContain('src/a.js')
    expect(result.message).toContain('edit_lock_acquire')
    expect(result.message).toContain('not an ownership grant')
    // It is a subscription, not a claim: nothing was acquired.
    expect(client.calls.some((call) => call.op === 'acquire')).toBe(false)
    // One active entry keyed by session and path.
    expect(registry.size()).toBe(1)
    expect(registry.entries()).toEqual([{ sessionId: OWNER.session, path: `${CWD}/src/a.js`, state: 'watching', settledByTool: false }])
    // No absolute path in the model-facing answer.
    expect(result.message).not.toContain(CWD)
  })

  it('is idempotent: a repeated call reuses one entry, so one release can only consume it once', async () => {
    const { definition, registry } = watchTool()
    await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    // The second spelling is an alias of the same file, not a second wait.
    await definition.execute({ file_path: `${CWD}/src/../src/a.js` }, execFor(agentFor()))
    expect(registry.size()).toBe(1)

    const consumed = registry.consumePath(`${CWD}/src/a.js`)
    expect(consumed).toHaveLength(1)
    expect(registry.consumePath(`${CWD}/src/a.js`)).toHaveLength(0)
  })

  // Spec: "Equivalent path spellings share one subscription" — A holds the
  // canonical path, B subscribes with `/p/src/../src/a.js` and still gets one
  // `watching` subscription on the canonical path, so one release notifies once.
  it('treats an aliased spelling as the held canonical path (one subscription)', async () => {
    const { definition, registry, client } = watchTool()
    const alias = `${CWD}/src/../src/a.js`
    const result = await definition.execute({ file_path: alias }, execFor(agentFor()))

    // The authority is asked for the canonical path, never for the spelling.
    expect(lastCall(client).filter).toEqual({ path: `${CWD}/src/a.js` })
    expect(result.state).toBe('watching')
    expect(result.file_path).toBe('src/a.js')
    // One entry under the canonical key: the alias cannot create a second
    // subscription that a single release would then have to notify separately.
    expect(registry.size()).toBe(1)
    expect(registry.entries()).toEqual([{ sessionId: OWNER.session, path: `${CWD}/src/a.js`, state: 'watching', settledByTool: false }])
    expect(registry.consumePath(alias)).toHaveLength(0)
    expect(registry.consumePath(`${CWD}/src/a.js`)).toHaveLength(1)
  })

  it('returns free and keeps no subscription when nobody holds the path', async () => {
    const { definition, registry } = watchTool({ status: () => ({ ok: true, leases: [] }) })
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.state).toBe('free')
    expect(result.message).toContain('edit_lock_acquire')
    expect(result.message).toContain('no release subscription was kept')
    expect(registry.size()).toBe(0)
  })

  it('returns self and keeps no subscription when this session already owns the path', async () => {
    const { definition, registry } = watchTool({
      status: () => ({ ok: true, leases: [{ path: `${CWD}/src/a.js`, owner: { ...OWNER }, scope: CWD, acquiredAt: 1, expiresAt: Date.now() + 1000, holdUntil: null }] }),
    })
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.state).toBe('self')
    expect(registry.size()).toBe(0)
  })

  it('reports the absence of release events explicitly and keeps no silent entry', async () => {
    const { definition, registry } = watchTool({ supportsEvent: () => false })
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.degraded).toBe(true)
    expect(result.code).toBe('release-events-unsupported')
    expect(result.message).toContain('release-events-unsupported')
    expect(result.message).toContain('no release subscription was created')
    expect(registry.size()).toBe(0)
  })

  it('reports an unreadable arbiter as degradation and keeps no entry', async () => {
    const { definition, registry } = watchTool({
      status: () => {
        throw Object.assign(new Error('lease broker is unreachable'), { code: 'transport' })
      },
    })
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.degraded).toBe(true)
    expect(result.code).toBe('transport')
    expect(result.message).toContain('no release subscription was created')
    expect(registry.size()).toBe(0)
  })

  it('sees a release that raced the registration and reports it once instead of a stale watching', async () => {
    const registry = createWatchCoordinator()
    const { definition } = watchTool(
      {
        // The release lands while the authoritative read is in flight: the
        // plugin's event callback consumes the entry first.
        status: () => {
          const consumed = registry.consumePath(`${CWD}/src/a.js`)
          expect(consumed).toHaveLength(1)
          return heldByOther()
        },
      },
      registry,
    )
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.state).toBe('released')
    expect(result.message).toContain('happened while this subscription was being established')
    expect(result.message).toContain('opportunity, not an ownership grant')
    // The running tool already told the model: the deferred notice must not
    // repeat it, and nothing stale is left behind.
    expect(registry.size()).toBe(0)
    expect(registry.peek(OWNER.session, `${CWD}/src/a.js`)).toBeUndefined()
  })

  it('reports a connection reset during registration as a re-check, never as a release', async () => {
    const registry = createWatchCoordinator()
    const { definition } = watchTool(
      {
        status: () => {
          registry.resetAll()
          return heldByOther()
        },
      },
      registry,
    )
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.state).toBe('reset')
    expect(result.message).toContain('Re-check with edit_lock_status')
    expect(result.message).toContain('still held by another session')
    expect(result.message).not.toContain('no longer held')
    expect(registry.size()).toBe(0)
  })

  it('reports a subscription cancelled underneath it instead of pretending to wait', async () => {
    const registry = createWatchCoordinator()
    const { definition } = watchTool(
      {
        status: () => {
          registry.cancelSession(OWNER.session)
          return heldByOther()
        },
      },
      registry,
    )
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.degraded).toBe(true)
    expect(result.code).toBe('watch-cancelled')
    expect(registry.size()).toBe(0)
  })

  it('keeps a release that lands during a failing read and never cancels its notice', async () => {
    const registry = createWatchCoordinator()
    const { definition } = watchTool(
      {
        // The release is consumed while the read is in flight, then the read
        // itself fails: the terminal state must win over the late rejection,
        // and the pending notice must not be cancelled by the cleanup.
        status: () => {
          expect(registry.consumePath(`${CWD}/src/a.js`)).toHaveLength(1)
          throw Object.assign(new Error('lease broker connection closed'), { code: 'transport' })
        },
      },
      registry,
    )
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.state).toBe('released')
    expect(result.message).toContain('happened while this subscription was being established')
    // Consumed and reported by the tool: the notice stays consumed-and-muted
    // rather than being cancelled back to nothing.
    expect(registry.size()).toBe(0)
    expect(registry.pendingSize()).toBe(1)
    expect(registry.pendingEntries()[0].settledByTool).toBe(true)
  })

  it('keeps a reset that lands during a failing read and reports a re-check', async () => {
    const registry = createWatchCoordinator()
    const { definition } = watchTool(
      {
        status: () => {
          registry.resetAll()
          throw Object.assign(new Error('lease broker connection closed'), { code: 'transport' })
        },
      },
      registry,
    )
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.state).toBe('reset')
    expect(result.message).toContain('Re-check with edit_lock_status')
    expect(result.message).not.toContain('no longer held')
    expect(registry.size()).toBe(0)
    expect(registry.pendingSize()).toBe(1)
  })

  it('cancels only a plain wait when the read fails with no terminal state', async () => {
    const registry = createWatchCoordinator()
    const { definition } = watchTool(
      {
        status: () => {
          throw Object.assign(new Error('lease broker is unreachable'), { code: 'transport' })
        },
      },
      registry,
    )
    const result = await definition.execute({ file_path: 'src/a.js' }, execFor(agentFor()))
    expect(result.degraded).toBe(true)
    expect(result.code).toBe('transport')
    expect(registry.size()).toBe(0)
    expect(registry.pendingSize()).toBe(0)
  })

  it('shares one authoritative read between overlapping calls and never resurrects a settled wait', async () => {
    const registry = createWatchCoordinator()
    let reads = 0
    let transfer = true
    const { definition } = watchTool(
      {
        status: () => {
          reads += 1
          if (transfer) {
            transfer = false
            // The transfer settles while the read is in flight: both callers
            // see the same terminal `self`, and neither may claim to be waiting.
            registry.settleSelf(OWNER.session, `${CWD}/src/a.js`)
          }
          return heldByOther()
        },
      },
      registry,
    )
    const [first, second] = await Promise.all([
      definition.execute({ file_path: 'src/a.js' }, execFor(agentFor())),
      definition.execute({ file_path: 'src/a.js' }, execFor(agentFor())),
    ])
    expect(reads).toBe(1)
    expect(first.state).toBe('self')
    expect(second.state).toBe('self')
    expect(registry.size()).toBe(0)
  })

  it('is idempotent across overlapping calls: one flight, one entry, two watching answers', async () => {
    const registry = createWatchCoordinator()
    let reads = 0
    const { definition } = watchTool(
      {
        status: async () => {
          reads += 1
          return heldByOther()
        },
      },
      registry,
    )
    // Two spellings, one file: the second call joins the FIRST entry and its
    // in-flight authoritative read instead of starting a second episode.
    const [first, second] = await Promise.all([
      definition.execute({ file_path: 'src/a.js' }, execFor(agentFor())),
      definition.execute({ file_path: `${CWD}/src/../src/a.js` }, execFor(agentFor())),
    ])
    expect(reads).toBe(1)
    expect(first.state).toBe('watching')
    expect(second.state).toBe('watching')
    expect(registry.size()).toBe(1)
    expect(registry.entries()).toEqual([{ sessionId: OWNER.session, path: `${CWD}/src/a.js`, state: 'watching', settledByTool: false }])
  })
})

/**
 * The real arbitration kernel behind the client surface the tools consume.
 *
 * Every verdict here comes from the string-keyed lease table a live broker
 * keeps, so a spelling that is not normalized becomes a SECOND lease row —
 * something a scripted client answer can never show. The adapter only unwraps
 * the kernel's `{ok, ...}` verdicts into the client's `resolve`/`throw` shape.
 * @param {string} connectionId
 * @param {ReturnType<typeof createBroker>} broker
 * @returns {any}
 */
function createKernelClient(connectionId, broker) {
  broker.connect(connectionId)
  /** @param {any} result */
  const refuse = (result) => {
    throw Object.assign(new Error(`lease broker refused: ${String(result?.code)}`), result)
  }
  return {
    acquire: (owner, paths, scope) => {
      const result = broker.acquire({ connectionId, owner, paths, scope })
      return result.ok === true ? result : refuse(result)
    },
    hold: (paths, minutes, owner) => {
      const result = broker.hold({ connectionId, owner, paths, minutes })
      return result.ok === true ? result : refuse(result)
    },
    request: (op, payload) => {
      if (op !== 'release') throw new Error(`the kernel client does not serve ${String(op)}`)
      const result = broker.release({ connectionId, owner: payload?.owner, paths: payload?.paths })
      return result.ok === true ? result : refuse(result)
    },
    status: (filter) => broker.status(filter ?? {}),
    requestTransfer: (path, from) => {
      const result = broker.request({ connectionId, from, path })
      return result.ok === true ? result : refuse(result)
    },
    reply: (input) => {
      const result = broker.reply({ connectionId, owner: input?.owner, requestId: input?.requestId, decision: input?.decision })
      return result.ok === true ? result : refuse(result)
    },
    supportsEvent: () => true,
  }
}

describe('edit_lock against the real arbitration kernel', () => {
  const ALIAS = `${CWD}/src/../src/a.js`

  /** Acquire one canonical path as one lineage on one connection. @param {any} broker @param {any} owner @param {string} [path] */
  async function claim(broker, owner, path = `${CWD}/src/a.js`) {
    const definition = tool(createLeaseTools({ client: createKernelClient(`conn-${owner.id}`, broker), ownerOf: () => owner }), 'edit_lock_acquire')
    return await definition.execute({ paths: [path] }, execFor(agentFor(owner.session)))
  }

  it('refuses an aliased spelling while another lineage holds the canonical path', async () => {
    const broker = createBroker()
    await claim(broker, OTHER)

    const contender = createKernelClient('conn-contender', broker)
    const message = await rejectionOf(
      tool(createLeaseTools({ client: contender, ownerOf: () => OWNER }), 'edit_lock_acquire'),
      { paths: [ALIAS] },
      execFor(agentFor()),
    )

    expect(message).toContain('reviewer')
    expect(message).toContain('src/a.js')
    // One row, under the canonical spelling: the alias never became a second lock.
    expect(broker.status({}).leases.map((lease) => lease.path)).toEqual([`${CWD}/src/a.js`])
  })

  it('releases a canonical claim through an aliased spelling and reports the normalized path', async () => {
    const broker = createBroker()
    const client = createKernelClient('conn-a', broker)
    const definitions = createLeaseTools({ client, ownerOf: () => OWNER })
    await tool(definitions, 'edit_lock_acquire').execute({ paths: [`${CWD}/src/a.js`] }, execFor(agentFor()))

    const released = await tool(definitions, 'edit_lock_release').execute(
      { paths: [ALIAS, `${CWD}//src/./a.js`] },
      execFor(agentFor()),
    )
    expect(released.released).toEqual(['src/a.js'])
    expect(released.notOwned).toEqual([])
    expect(broker.status({}).leases).toEqual([])
  })

  it('retains a canonical claim through an aliased spelling', async () => {
    const broker = createBroker()
    const client = createKernelClient('conn-a', broker)
    const definitions = createLeaseTools({ client, ownerOf: () => OWNER })
    await tool(definitions, 'edit_lock_acquire').execute({ paths: [`${CWD}/src/a.js`] }, execFor(agentFor()))

    const result = await tool(definitions, 'edit_lock_hold').execute({ paths: [ALIAS], minutes: 30 }, execFor(agentFor()))
    expect(result.held.map((row) => row.path)).toEqual(['src/a.js'])
    const [lease] = broker.status({}).leases
    expect(lease.holdUntil).toBeGreaterThan(Date.now())
  })

  it('watches a canonical claim through an aliased spelling and hears the real release broadcast once', async () => {
    const registry = createWatchCoordinator()
    /** @type {string[]} */
    const notices = []
    const agent = agentFor()
    const broker = createBroker({
      onEvent: (connectionId, event) => {
        // The plugin routes one connection's events into the shared coordinator;
        // this test does the same for the watching connection only.
        if (connectionId === 'conn-b' && event?.event === 'released') registry.consumePath(event.path)
      },
    })
    const mount = {
      disposed: false,
      agentFor: () => agent,
      notify: (/** @type {any} */ entry) => notices.push(entry.path),
    }
    const watcherClient = createKernelClient('conn-b', broker)
    await claim(broker, OTHER)

    const definition = tool(
      createLeaseTools({ client: watcherClient, ownerOf: () => OWNER, watchCoordinator: registry, mount }),
      WATCH_TOOL,
    )
    const result = await definition.execute({ file_path: ALIAS }, execFor(agent))
    expect(result.state).toBe('watching')
    expect(result.file_path).toBe('src/a.js')
    expect(registry.entries()).toEqual([{ sessionId: OWNER.session, path: `${CWD}/src/a.js`, state: 'watching', settledByTool: false }])

    // The owner releases with the same aliased spelling; the kernel removes the
    // canonical row and broadcasts the fact, which consumes the subscription.
    const released = await tool(
      createLeaseTools({ client: createKernelClient(`conn-${OTHER.id}`, broker), ownerOf: () => OTHER }),
      'edit_lock_release',
    ).execute({ paths: [ALIAS] }, execFor(agentFor(OTHER.session)))
    expect(released.released).toEqual(['src/a.js'])

    await delay(5)
    expect(notices).toEqual([`${CWD}/src/a.js`])
    expect(registry.size()).toBe(0)

    // A repeated observation of the same release delivers nothing more.
    registry.consumePath(`${CWD}/src/a.js`)
    await delay(5)
    expect(notices).toHaveLength(1)
  })
})
