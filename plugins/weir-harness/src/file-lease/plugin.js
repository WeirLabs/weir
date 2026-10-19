// The preset entry point of the file-lease feature (design D4, D5, D10, D11).
//
// This module owns exactly three things the arbiter cannot know:
//
//  1. The tool surface: five ownership tools that always exist, plus the
//     negotiation reply tool that exists only while a request is pending. A
//     tool nobody can answer is noise; a tool that vanishes mid-turn makes a
//     late answer report "unknown tool", so the reply tool is retired when its
//     pending set empties and no later than the turn boundary.
//  2. The turn lifecycle (D10): `turn/end` releases what the turn acquired
//     without releasing retention, `agent/disposed` releases everything,
//     retention included. Both are best-effort — a missed release is covered by
//     the lease validity, which is why neither path may ever throw.
//  3. Wake delivery (D4): a transfer request addressed to a session that is
//     idle in this process opens ONE turn so it can answer; a request addressed
//     to a session that is mid-turn simply lands inside that turn and costs no
//     extra wake. A request for a session that is not here (another process, a
//     disposed agent) is silently dropped: the arbiter will expire it.
//
// The transport is process-wide (D8/D11). Two preset mounts of this bundle
// share ONE client per socket path, and unmounting must never close it — that
// would rip the connection out from under the sibling mount. The default
// client is therefore a module-level lazy singleton, and the injected `client`
// option is the seam tests (and any future embedder) use instead.
//
// Nothing here imports `@deepseek-ai/*`: services arrive through `ctx`.

import { createLineageResolver } from './lineage.js'
import { userTextMessage } from '../shared/user-message.js'
import { createLeaseTools, REPLY_TOOL, shortName } from './tools.js'
import { getSharedLeaseClient } from './singleton.js'
import { buildLeaseView } from './view.js'

/** Plugin name (composition identity only; this row publishes no service). */
const PLUGIN_NAME = 'weir-file-lease'

/**
 * The one read-only HTTP route of the feature (design D13). The path keeps the
 * pre-rebuild name on purpose: the client chunk that reads it, the feature doc
 * and the spec all name `/api/weir-edit-lock/view`, and a rename would buy
 * nothing a reader could see.
 */
const VIEW_PATH = '/api/weir-edit-lock/view'

/**
 * The host's exact-duplicate-route refusal, and nothing else.
 *
 * Several preset mounts of this bundle live in ONE process (D11), while `fetch`
 * routes are process-wide: the first mount owns the route and the host refuses
 * a later mount's identical registration. Only that exact message is tolerated;
 * every other registration error is a real fault and must surface.
 * @param {unknown} error
 * @returns {boolean}
 */
function duplicateRouteRegistration(error) {
  return messageOf(error) === `connection: exact Fetch route ${JSON.stringify(VIEW_PATH)} is already registered`
}

/** Producer tag every injected message carries (AGENTS §3.4). */
const SOURCE_KIND = 'weir-file-lease'

/**
 * Request ids this process has already handed to a holder agent.
 *
 * Two preset mounts share ONE client (D11), so both hear the same `request`
 * event; without this a holder would be woken twice for one request, which
 * D4/spec explicitly forbid ("no second wake is spent for the same request").
 * The arbiter allocates a monotonic request id per request and never reuses
 * one, so a value in this set means exactly "this request was delivered".
 * Cleared when the reply window closes (answer, turn end, disposal).
 * @type {WeakMap<object, Set<string>>}
 */
const noticedByAgent = new WeakMap()

/** @param {unknown} value @returns {string | undefined} */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The delivery memo for one holder agent.
 * @param {object} agent
 * @returns {Set<string>}
 */
function noticedFor(agent) {
  let noticed = noticedByAgent.get(agent)
  if (noticed === undefined) {
    noticed = new Set()
    noticedByAgent.set(agent, noticed)
  }
  return noticed
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return String(/** @type {any} */ (error)?.message ?? error)
}

/**
 * The session this agent acts for: the durable header id when there is one,
 * else the live session id, else the agent id. Non-empty by construction, and
 * `undefined` only for an agent object with no identity at all — a caller that
 * cannot name a session cannot release one either.
 * @param {any} agent
 * @returns {string | undefined}
 */
function sessionIdOf(agent) {
  return text(agent?.session?.header?.id) ?? text(agent?.session?.id) ?? text(agent?.id)
}

/** @param {any} agent @returns {string | undefined} */
function cwdOf(agent) {
  return text(agent?.session?.header?.cwd)
}

/**
 * Resolve `ownerOf(agent)` from the live lineage rule (D9): the lineage id plus
 * the session and label the arbiter only ever formats.
 * @param {() => any} agents lazy accessor for the `agents` service
 * @returns {(agent: any) => { id: string, session: string, label: string }}
 */
function createOwnerResolver(agents) {
  const resolver = createLineageResolver({
    // The ancestor walk reads one header per hop; a missing registry (a cold or
    // partially mounted host) degrades to "this session is its own lineage".
    sessions: {
      get: (/** @type {string} */ id) => {
        try {
          return agents()?.get?.(id)
        } catch {
          return undefined
        }
      },
    },
  })
  return (agent) => {
    const lineage = resolver.lineageOf(agent)
    return {
      id: lineage,
      session: sessionIdOf(agent) ?? lineage,
      label: resolver.labelOf(agent),
    }
  }
}

/**
 * Deliver one model-facing notice (AGENTS §3.4): `followup` when the wake flag
 * is set and the agent is idle — that single call is what opens the turn the
 * holder needs in order to answer — and `steer` otherwise, which lands inside a
 * running turn instead of spending an extra one. Both channels failing is
 * silence: the negotiation simply expires and audit belongs to the client (D7).
 *
 * @param {any} agent
 * @param {string} text
 * @param {boolean} [wake]
 * @returns {Promise<boolean>} whether a channel accepted the message
 */
async function defaultDeliver(agent, text, wake = false) {
  const message = userTextMessage(text, SOURCE_KIND)
  // `followup` only when asked to wake an idle agent: a followup to a running
  // agent would queue a second turn, which is exactly the cost D4 forbids.
  const channels = wake && agent?.status === 'idle' ? ['followup', 'steer'] : ['steer', 'followup']
  for (const channel of channels) {
    try {
      const send = agent?.[channel]
      if (typeof send !== 'function') continue
      await send.call(agent, message)
      return true
    } catch {
      // Fall through to the other channel; a total failure stays silent.
    }
  }
  return false
}

/**
 * The request notice addressed to the holder. Model-facing only: it names the
 * requester, names the tool and the request id, and states that inaction keeps
 * ownership. It must never read like something for a human to act on.
 * @param {{ requestId: string, short: string, label: string, fromSession: string, seconds: number }} detail
 * @returns {string}
 */
function requestText({ requestId, short, label, fromSession, seconds }) {
  return [
    `Session "${label}" (session ${fromSession}) is asking to take over ${short}.`,
    `Answer with edit_lock_reply: request_id "${requestId}", decision "release" to hand it over, or "keep" to hold on to it.`,
    `Nothing moves until you answer — if you do not answer, ownership stays yours and the request expires by itself (about ${seconds}s left).`,
  ].join(' ')
}

/**
 * The result notice addressed to the requester once its request settled.
 * @param {string} state `transferred` | `declined` | `expired`
 * @param {string} requestId
 * @param {string} short
 * @returns {string}
 */
function settledText(state, requestId, short) {
  if (state === 'transferred') {
    return `Request ${requestId}: ownership of ${short} was transferred to this session. It is yours now — edit it, and claim it again only if it lapses.`
  }
  if (state === 'declined') {
    return `Request ${requestId}: the holder kept ${short}. Ownership is unchanged, and it becomes available when its validity ends — do not retry the same edit blindly.`
  }
  return `Request ${requestId}: no answer arrived for ${short}, so the request expired and ownership is unchanged. It becomes available when its validity ends; ask again later if you still need it.`
}

/**
 * Create one plugin instance. Every collaborator is injectable so a unit test
 * can drive the whole surface with a fake client and a fake ctx: the default
 * client is the process-wide singleton and the default cortex is a live cordis
 * context, neither of which a unit test should touch.
 *
 * @param {object} [options]
 * @param {any} [options.client] lease client (default: the process-wide singleton)
 * @param {(agent: any) => { id: string, session: string, label: string }} [options.ownerOf] owner identity (default: the lineage rule)
 * @param {(agent: any, text: string, wake?: boolean) => any} [options.deliver] model-facing message channel
 * @param {() => number} [options.now] injected clock (epoch ms)
 * @returns {{ name: string, inject: string[], apply: (ctx: any, config?: { enabled?: boolean }) => (() => void) | undefined }}
 */
export function createFileLeasePlugin(options = {}) {
  const injectedClient = options?.client ?? null
  const injectedOwnerOf = options?.ownerOf ?? null
  const injectedDeliver = options?.deliver ?? null
  const now = typeof options?.now === 'function' ? options.now : Date.now

  /**
   * Mount this row.
   *
   * `config.enabled === false` is a COMPOSITION-LAYER SEAM, not a user setting
   * and not a feature flag: it exists so a test composition (or an embedder) can
   * mount this row switched off for one boot without deleting it from the patch.
   * The production presets never write that key — the feature is always on there
   * — so no settings schema, no command and no documentation promises it. With
   * the seam off the mount does nothing at all: no tool is registered and no
   * event is subscribed, which is exactly what "this row is not here" means.
   * Every other value (including omitted) is enabled.
   *
   * @param {any} ctx the row's cordis context
   * @param {{ enabled?: boolean }} [config] composition config (`enabled` seam only)
   * @returns {(() => void) | undefined} the unmount disposer
   */
  function apply(ctx, config) {
    // The seam is checked before anything touches the ctx: a disabled mount must
    // leave no tool, no listener and no subscription behind (design D11 mount
    // lifetime), so there is nothing to return a disposer for.
    if (config?.enabled === false) return undefined
    /** @type {(() => void)[]} */
    const disposers = []
    /** @type {WeakMap<object, Map<string, { path: string, from: any }>>} */
    const pendingByAgent = new WeakMap()
    /** @type {WeakMap<object, { dispose: () => void }>} */
    const replyTools = new WeakMap()
    /** @type {Set<any>} agents whose reply tool this mount registered */
    const replyAgents = new Set()
    /**
     * `requestId -> the session that asked for it`. A `settled` event carries no
     * session (it is pushed to the requesting connection, which every session of
     * this process shares), so this map is the only way to address the outcome.
     * It is routing state, never authority: the arbiter decides (D6).
     * @type {Map<string, { session: string, path: string }>}
     */
    const issued = new Map()
    let disposed = false
    /** @type {() => void} this mount's read-only view route disposer (D13) */
    let disposeView = () => {}

    /** @returns {any} the `agents` service, or undefined when it is not mounted */
    function agents() {
      try {
        return ctx.get?.('agents')
      } catch {
        return undefined
      }
    }

    // The process-wide client (D11): shared with every other mount of this row
    // and never closed by an unmount. An injected client wins and creates nothing.
    const client = injectedClient ?? getSharedLeaseClient()
    const ownerOf = injectedOwnerOf ?? createOwnerResolver(agents)
    const deliver = injectedDeliver ?? defaultDeliver

    /**
     * Deliver a notice without letting delivery break the caller: both channels
     * failing is silence, by contract.
     * @param {any} agent @param {string} text @param {boolean} [wake]
     */
    function notify(agent, text, wake = false) {
      if (disposed) return
      try {
        const outcome = deliver(agent, text, wake)
        const promise = /** @type {any} */ (outcome)
        if (promise !== null && typeof promise === 'object' && typeof promise.then === 'function') {
          promise.then(undefined, () => {})
        }
      } catch {
        // Silent: the negotiation expires on its own.
      }
    }

    /**
     * Run a best-effort release. Never throws and never keeps state to retry:
     * the lease validity is the guarantee, this is the optimisation (D10).
     * @param {() => any} run
     */
    function quiet(run) {
      try {
        const outcome = run()
        const promise = /** @type {any} */ (outcome)
        if (promise !== null && typeof promise === 'object' && typeof promise.then === 'function') {
          promise.then(undefined, () => {})
        }
      } catch {
        // Same rule as notify().
      }
    }

    /** @param {string | undefined} session @returns {any} */
    function agentFor(session) {
      if (session === undefined) return undefined
      try {
        return agents()?.get?.(session)
      } catch {
        return undefined
      }
    }

    /** @param {any} agent @returns {Map<string, { path: string, from: any }>} */
    function pendingOf(agent) {
      let pending = pendingByAgent.get(agent)
      if (pending === undefined) {
        pending = new Map()
        pendingByAgent.set(agent, pending)
      }
      return pending
    }

    /**
     * Register the reply tool on THIS AGENT's scope (not the mount's): the tool
     * answers a request addressed to one holder, and a tool visible to every
     * agent in the preset would offer an answer nobody can give.
     *
     * Idempotent by construction — a second mount on the same agent scope must
     * not throw, and a registration of the same name that this mount does not
     * own is left alone.
     * @param {any} agent
     */
    function registerReplyTool(agent) {
      if (disposed || replyTools.has(agent)) return
      const scope = agent?.ctx
      if (!scope?.tools?.register) return
      try {
        if (typeof scope.tools.get === 'function' && scope.tools.get(REPLY_TOOL) !== undefined) return
      } catch {
        // A registry probe must never break delivery.
      }
      try {
        const dispose = scope.tools.register(replyToolFor(agent))
        replyTools.set(agent, { dispose: typeof dispose === 'function' ? dispose : () => {} })
        replyAgents.add(agent)
      } catch (error) {
        ctx.logger?.warn?.(`file-lease: the reply tool could not be registered: ${messageOf(error)}`)
      }
    }

    /**
     * The reply definition, wrapped so this mount learns that a pending request
     * was answered (the broker reports it to the requester, not to the holder).
     * @param {any} agent
     * @returns {any}
     */
    function replyToolFor(agent) {
      const definition = /** @type {any} */ (replyDefinition)
      return {
        ...definition,
        async execute(/** @type {any} */ args, /** @type {any} */ exec) {
          try {
            return await definition.execute(args, exec)
          } finally {
            answered(agent, args?.request_id)
          }
        },
      }
    }

    /**
     * One pending request is gone; the reply tool follows when none is left.
     * @param {any} agent @param {unknown} requestId
     */
    function answered(agent, requestId) {
      const pending = pendingByAgent.get(agent)
      if (pending === undefined) return
      const id = text(requestId)
      if (id !== undefined) pending.delete(id)
      if (pending.size === 0) retireReplyTool(agent)
    }

    /**
     * The reply window for this agent is over: the tool goes, and the delivery
     * memo goes with it so a later request is never mistaken for a repeat.
     * @param {any} agent
     */
    function retireReplyTool(agent) {
      if (agent === null || typeof agent !== 'object') return
      const registered = replyTools.get(agent)
      replyTools.delete(agent)
      replyAgents.delete(agent)
      pendingByAgent.delete(agent)
      noticedByAgent.delete(agent)
      if (registered === undefined) return
      try {
        registered.dispose()
      } catch {
        // Already unregistered by the scope's own teardown.
      }
    }

    /** @param {string | undefined} session */
    function forgetIssued(session) {
      if (session === undefined) return
      for (const [requestId, entry] of [...issued]) if (entry.session === session) issued.delete(requestId)
    }

    /**
     * The turn boundary (D10). ANY reason releases — completed, aborted by the
     * user, or an error: the turn is over, so the session is no longer editing,
     * and the next message must be able to edit immediately. Retention is what
     * survives a boundary, which `releaseSession` already encodes.
     * @param {any} agent
     */
    function releaseOnTurnEnd(agent) {
      const session = sessionIdOf(agent)
      // The reply tool exists for one turn's pending answers; the boundary ends
      // that window whether or not the holder replied.
      retireReplyTool(agent)
      forgetIssued(session)
      if (session === undefined) return
      quiet(() => client.releaseSession(session))
    }

    /**
     * A disposed agent never comes back, so its retention ends with it (D10).
     * @param {any} agent
     */
    function releaseOnDisposed(agent) {
      const session = sessionIdOf(agent)
      retireReplyTool(agent)
      forgetIssued(session)
      if (session === undefined) return
      quiet(() => client.releaseAll(session))
    }

    /**
     * The holder a `request` event is addressed to. The wire event names the
     * requester (`from`) but not the holder — it is pushed to the holder's
     * connection, which this process shares across every session — so the
     * holder is whoever the arbiter reports holding that path (D8). A future
     * transport that names the holder is honoured first.
     * @param {any} event @param {string} path
     * @returns {Promise<string | undefined>}
     */
    async function holderSession(event, path) {
      const named = text(event?.session) ?? text(event?.holder?.session) ?? text(event?.to?.session)
      if (named !== undefined) return named
      try {
        const reply = await client.status({ path })
        const leases = Array.isArray(reply?.leases) ? reply.leases : []
        return text(leases[0]?.owner?.session)
      } catch {
        return undefined
      }
    }

    /** @param {any} event */
    async function onRequest(event) {
      const requestId = text(event?.requestId)
      const path = text(event?.path)
      if (requestId === undefined || path === undefined) return
      const session = await holderSession(event, path)
      if (session === undefined) return
      const agent = agentFor(session)
      // Cross-process or already gone: drop silently. The arbiter expires the
      // request and the requester is told; nothing here is asked to fix it.
      if (!agent) return
      // One delivery per request per process, however many mounts are alive.
      const noticed = noticedFor(agent)
      if (noticed.has(requestId)) return
      noticed.add(requestId)
      pendingOf(agent).set(requestId, { path, from: event?.from })
      registerReplyTool(agent)
      const from = event?.from ?? {}
      const label = text(from.label) ?? 'another session'
      const fromSession = text(from.session) ?? 'unknown'
      const expiresAt = typeof event?.expiresAt === 'number' ? event.expiresAt : now()
      const seconds = Math.max(0, Math.ceil((expiresAt - now()) / 1000))
      notify(agent, requestText({ requestId, short: shortName(path, cwdOf(agent)), label, fromSession, seconds }), agent?.status === 'idle')
    }

    /** @param {any} event */
    function onSettled(event) {
      const requestId = text(event?.requestId)
      if (requestId === undefined) return
      const entry = issued.get(requestId)
      issued.delete(requestId)
      // A request issued by another process settles in that process.
      if (entry === undefined) return
      const agent = agentFor(entry.session)
      if (!agent) return
      const state = text(event?.state) ?? 'expired'
      notify(agent, settledText(state, requestId, shortName(entry.path, cwdOf(agent))), agent?.status === 'idle')
    }

    /** @param {any} event */
    async function onClientEvent(event) {
      if (disposed || event === null || typeof event !== 'object') return
      try {
        if (event.event === 'request') await onRequest(event)
        else if (event.event === 'settled') onSettled(event)
      } catch {
        // A listener is a consumer; it must never break the transport.
      }
    }

    /**
     * The tools see the client through this narrow facade for one reason: a
     * `settled` event carries no session, so the plugin has to remember which
     * session issued which requestId at the moment the request is made. The
     * facade adds that bookkeeping and nothing else — every call still ends in
     * the arbiter.
     */
    const routedClient = Object.freeze({
      acquire: (/** @type {any} */ owner, /** @type {any} */ paths, /** @type {any} */ scope) => client.acquire(owner, paths, scope),
      hold: (/** @type {any} */ paths, /** @type {any} */ minutes, /** @type {any} */ owner) => client.hold(paths, minutes, owner),
      status: (/** @type {any} */ filter) => client.status(filter),
      request: (/** @type {any} */ op, /** @type {any} */ payload) => client.request(op, payload),
      reply: (/** @type {any} */ input) => client.reply(input),
      requestTransfer: async (/** @type {any} */ path, /** @type {any} */ from) => {
        const reply = await client.requestTransfer(path, from)
        const requestId = text(reply?.requestId)
        if (requestId !== undefined) issued.set(requestId, { session: text(from?.session) ?? '', path })
        return reply
      },
    })

    const definitions = createLeaseTools({
      client: routedClient,
      ownerOf,
      deliverNotice: (agent, text) => notify(agent, text, false),
    })
    const replyDefinition = definitions.find((definition) => definition?.name === REPLY_TOOL)
    const staticDefinitions = definitions.filter((definition) => definition?.name !== REPLY_TOOL)

    for (const definition of staticDefinitions) {
      // A second mount on the same scope must not throw: the tool is already
      // there, provided by the sibling mount (D11 allows exactly that shape).
      try {
        if (typeof ctx.tools?.get === 'function' && ctx.tools.get(definition.name) !== undefined) continue
      } catch {
        // A registry probe must never abort the mount.
      }
      try {
        const dispose = ctx.tools?.register?.(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        ctx.logger?.warn?.(`file-lease: tool ${String(definition?.name)} was not registered: ${messageOf(error)}`)
      }
    }

    // The turn boundary. `turn/end` is the host-level event this surface is
    // defined against; this runtime publishes the same boundary as the durable
    // `turn/end` session event, so both feed the ONE handler (release is
    // idempotent per protocol, so a host that emits both is harmless).
    const offTurnEnd = ctx.on?.('turn/end', (/** @type {any} */ payload) => {
      releaseOnTurnEnd(payload?.agent)
    })
    if (typeof offTurnEnd === 'function') disposers.push(offTurnEnd)

    const offSession = ctx.on?.('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
      if (event?.type !== 'turn/end') return
      const agent = agentFor(text(session?.id))
      if (agent === undefined) return
      releaseOnTurnEnd(agent)
    })
    if (typeof offSession === 'function') disposers.push(offSession)

    const offDisposed = ctx.on?.('agent/disposed', (/** @type {any} */ payload) => {
      releaseOnDisposed(payload?.agent)
    })
    if (typeof offDisposed === 'function') disposers.push(offDisposed)

    /** @type {() => void} */
    let offEvents = () => {}
    try {
      const off = client.onEvent((/** @type {any} */ event) => {
        void onClientEvent(event)
      })
      if (typeof off === 'function') offEvents = off
    } catch (error) {
      ctx.logger?.warn?.(`file-lease: negotiation events are unavailable: ${messageOf(error)}`)
    }

    /**
     * The arbiter's health as the read-only surface reports it (D13): the client's
     * own connection state, never a fresh probe, so looking cannot change a
     * verdict. A client that cannot answer is `unavailable` — an unknown
     * connection must never be presented as healthy.
     * @returns {'ok' | 'degraded' | 'unavailable'}
     */
    function arbiterState() {
      try {
        const state = typeof client.connectionState === 'function' ? client.connectionState() : 'unavailable'
        return state === 'ok' || state === 'degraded' || state === 'unavailable' ? state : 'unavailable'
      } catch {
        return 'unavailable'
      }
    }

    // ---- The read-only ownership view (design D13) --------------------------
    //
    // The ONLY user-facing ownership read in the rebuild, and it reads. Nothing
    // in this handler acquires, releases, retains, negotiates or records
    // anything: no lease changes, no conversation entry, no audit row. Every
    // ownership state resolves by itself (turn end, expiry, negotiation; D10),
    // so a surface that could act would reintroduce exactly the "some state
    // needs a human" the redesign deletes.
    //
    // `connection` is a host-plane service, so the preset realm cannot hide it.
    // Its fetch routes are process-wide (D11), which is why a second mount's
    // identical registration is tolerated below and nothing else is.
    ctx.inject?.(['connection'], (/** @type {any} */ scope) => {
      const fetchRegistry = scope?.connection?.fetch
      if (!fetchRegistry?.register) return
      const reply = (/** @type {any} */ payload, /** @type {number} */ status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
      /** @type {(() => void) | undefined} */
      let dispose
      try {
        dispose = fetchRegistry.register({
          path: VIEW_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (/** @type {any} */ request) => {
            let body
            try {
              body = await request.json()
            } catch {
              body = null
            }
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
            if (sessionId === '') {
              return reply({ ok: false, error: { code: 'weir-edit-lock/invalid', message: 'body needs { sessionId }' } }, 400)
            }
            const agent = agentFor(sessionId)
            const cwd = cwdOf(agent)
            // A session with no live agent is its own lineage (D9), and its
            // leases died with the process that held them (D10): the honest
            // answer is "nothing held", never an error to act on.
            const mineLineage = agent === undefined ? sessionId : ownerOf(agent).id
            /** @type {any[]} */
            let leases = []
            try {
              const snapshot = await client.status(cwd === undefined ? {} : { scope: cwd })
              leases = Array.isArray(snapshot?.leases) ? snapshot.leases : []
            } catch {
              // An unreadable arbiter IS the degraded state (D7): answer with the
              // same envelope so the panel reports it, and never claim "nothing
              // held" on the strength of a failed read.
              leases = []
            }
            return reply({ ok: true, value: buildLeaseView({ leases, mineLineage, cwd, arbiter: arbiterState(), now: now() }) })
          },
        })
      } catch (error) {
        // Duplicate-route tolerance (D11): the first mount in this process owns
        // this process-wide route, and the host refuses a later mount's
        // identical registration. Skipping ONLY that exact refusal keeps this
        // mount's inject callback intact instead of aborting it mid-mount, and
        // correctness never depends on mount order because the client and the
        // owner rule are process-wide too.
        if (!duplicateRouteRegistration(error)) throw error
        return
      }
      disposeView = () => {
        try {
          dispose?.()
        } catch {
          // Already released by the injection scope's own teardown.
        }
      }
      return disposeView
    })

    // Unmount: drop this mount's tools, its listeners, its event subscription and
    // its view route. The client and the daemon keep running (D11) — a sibling
    // mount, or the next mount of this row, owns the connection.
    return () => {
      if (disposed) return
      disposed = true
      try {
        offEvents()
      } catch {
        // Already gone.
      }
      try {
        disposeView()
      } catch {
        // Already released by the injection scope's own teardown.
      }
      disposeView = () => {}
      for (const agent of [...replyAgents]) retireReplyTool(agent)
      replyAgents.clear()
      issued.clear()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // Already disposed by the scope's own teardown.
        }
      }
    }
  }

  return { name: PLUGIN_NAME, inject: ['tools', 'agents'], apply }
}

/**
 * The default instance: same export shape as every other row in this bundle, so
 * `cordis.patch.yml` can mount the module directly.
 */
const { name, inject, apply } = createFileLeasePlugin()

export { name, inject, apply }
