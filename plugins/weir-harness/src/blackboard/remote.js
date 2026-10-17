// Session blackboard remote (design D8, slice 2): the plugin-owned typert
// remote service that carries the future side panel's board operations off
// the session log. Same architecture as src/capabilities/capability-remote.js
// (silent-capability-reads):
//
//   - the PRESET-layer blackboard plugin feeds the module-level BRIDGE with
//     the kernel + board resolution + write-token TTL at apply and
//     unregisters at dispose (preset services are invisible to the host-root
//     gateway, S27);
//   - the HOST-layer cordis plugin below creates the service, attaches the
//     hand-built frozen typertRemote binding (validateBinding's exact shape,
//     S27 — no @deepseek-ai/* import, no Remote decorators), publishes it on
//     the host root, and registers a hand-written typert contribution
//     (src-json codecs, zero generated artifacts).
//
// WIRE CONTRACT (pinned — the parallel panel lane builds against this exact
// shape; see docs/features/blackboard.md 面板数据通道):
//
//   namespace `weirBlackboard`. The seven board verbs each take one JSON
//   `args` object, and the acting session rides the `agent` lookup
//   parameter (wire `agentId`, scope context `agent`) — the panel page's
//   current session injects it the same way the stock `fileReferences`
//   remote does, so the domain signatures below need no session field.
//   The eighth method, resolve, is the deliberate exception named below.
//
//   - list({ type?, query? }) → { entries: [{ key, entryType, summary,
//     readCount, subscribeCount, updatedAt, promoted? }] }
//   - read({ keys: [...] })  → { entries: [{ key, entryType, summary,
//     content, readCount, subscribeCount, updatedAt, promoted? }] } (unknown
//     keys are values: only found entries come back)
//   - apply({ key })          → { acquired: true, token, expiresAt }
//                             | { acquired: false, holder, subscribed: true }
//                             | { acquired: false, promoted: true, destination }
//   - write({ key, entryType, summary, content }) → { ok: true, revision }
//                             | { ok: false, error }
//   - remove({ key })         → { ok: true } | { ok: false, error }
//   - requestPromotion({})    → { ok: true } | { ok: false, error } — injects
//                             the promotion-evaluation brief into the
//                             session's MAIN agent (slice 3); zero session-log
//                             events
//   - markPromoted({ key, destination }) → { ok: true, destination }
//                             | { ok: false, error } — makes the entry
//                             read-only with the promoted marker
//   - resolve                  → { sessionId } — the panel's root
//                             resolution (slice 4): NO scope, NO agent
//                             lookup. The gateway's agent lookup refuses
//                             subagent-owned sessions before this service
//                             can run (the subagent-panel 404 root cause),
//                             so the browsing session id crosses as a bare
//                             JSON `agentId` parameter (source 'json' — the
//                             capability-remote precedent) and the answer
//                             is the conversation root whose board the
//                             panel binds before any lookup-gated verb.
//
//   `token` is an opaque per-acquisition identifier (the authority itself is
//   the acting session's live kernel token, re-checked at every mutation);
//   `revision` is the entry's write revision (1 on create, +1 per update).
//   Read operations produce ZERO session-log events; all methods share the
//   agent tools' arbitration kernel, so a panel user never bypasses the
//   write-token protocol.
//
// Every face resolves from the bridge AT CALL TIME: a non-Weir preset or an
// unmounted bridge surfaces as an explicit typed error, never a guessed or
// empty payload.

/** The host-root service key the typert gateway resolves (S27: ctx.get from the host root). */
export const BLACKBOARD_REMOTE_SERVICE_KEY = 'weirBlackboardRemote'
/** The wire namespace: POST /api/weirBlackboard/<method>, client ctx.remote.weirBlackboard.*. */
export const BLACKBOARD_REMOTE_NAMESPACE = 'weirBlackboard'
/** The seven board verbs, each taking one JSON `args` parameter plus the acting-session lookup. The eighth wire method, resolve, is built separately in the contribution (no lookup, no scope). */
export const BLACKBOARD_REMOTE_METHODS = Object.freeze(['list', 'read', 'apply', 'write', 'remove', 'requestPromotion', 'markPromoted'])
/** The wire package identity (distinct from 'weir-harness' — the capability-remote contribution already owns that package face). */
const BLACKBOARD_REMOTE_PACKAGE = 'weir-blackboard'

/**
 * Typed channel failure. `code` is the machine-readable discriminant:
 *   - 'bridge-absent'   — no blackboard plugin fed the bridge (non-Weir
 *                         preset or unmounted); the client settles its
 *                         explicit unavailable state.
 *   - 'unknown-session' — the acting agent resolved from the wire carries no
 *                         usable session identity.
 *   - 'payload-failed'  — an underlying face threw; the cause is chained.
 *   - 'channel-unavailable' — the typert registration is absent and could not be re-established.
 */
export class BlackboardRemoteError extends Error {
  /**
   * @param {'bridge-absent' | 'unknown-session' | 'payload-failed' | 'channel-unavailable'} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = undefined) {
    super(message, options)
    this.name = 'BlackboardRemoteError'
    this.code = code
  }
}

/**
 * The bridge: EVERY mounted blackboard plugin feeds this module-level slot,
 * and every consumer is the same bundle module instance. The preset registry
 * eagerly mounts BOTH declared presets (weir and weir-creative) at profile
 * load, so two blackboard mounts feeding this bridge is the permanent steady
 * state — ownership is a LIVE-FEED STACK: the latest live feed serves, a
 * feed's unregister removes only itself and restores the previous live feed,
 * and only an empty stack surfaces as bridge-absent. (The sibling capability
 * read bridge keys its feeds by preset instead: its reads route by the
 * session's exact projected preset, while blackboard calls carry no routing
 * dimension and the two presets' faces are equivalent today.)
 * Faces:
 *   kernel()  — the shared arbitration kernel (list/read/apply/write/deleteKey)
 *   boardOf(agent) — conversation-root board id for an agent handle
 *   rootOf(sessionId) — conversation-root session id for a BARE session id
 *   ttlMs()   — the settings-driven write-token TTL in milliseconds
 */
/** The faces every live feed provides. `run` is the mount's lifecycle gate (apply/write/delete through one admission), `requestPromotion` the slice-3 promotion requester, and `boardOf` may await that same gate. @typedef {{ kernel: any, boardOf: (agent: any) => string | undefined | Promise<string | undefined>, rootOf?: (sessionId: string) => Promise<string>, ttlMs: () => number, run?: (agent: any, action: (root: string) => any) => Promise<any>, requestPromotion?: (agent: any) => Promise<unknown> }} BridgeFaces */
/** @type {Array<{ faces: BridgeFaces }>} Live feeds in feed order; the stack top serves. */
const bridgeStack = []

/**
 * Feed the bridge (blackboard plugin apply): push a unique token onto the
 * live-feed stack and return the unregister the plugin disposes with its own
 * lifecycle. The unregister removes exactly its own token — removing the
 * serving token restores the previous live feed — and a repeated call is a
 * no-op.
 * @param {BridgeFaces} faces
 */
export function feedBlackboardRemoteBridge(faces) {
  const token = { faces }
  bridgeStack.push(token)
  return () => {
    const at = bridgeStack.indexOf(token)
    if (at >= 0) bridgeStack.splice(at, 1)
  }
}

/** Current bridge faces: the latest live feed's, or null when no live feed remains (the one true bridge-absent). */
export function blackboardRemoteBridge() {
  const top = bridgeStack[bridgeStack.length - 1]
  return top ? top.faces : null
}

/** Strip one kernel row to the pinned wire entry shape (summary is a free-text string, content optional, the promoted marker rides along when present). */
function wireEntry(entry, { content = false } = {}) {
  const row = {
    key: entry.key,
    entryType: entry.entryType,
    summary: entry.summary,
    readCount: entry.readCount,
    subscribeCount: entry.subscribeCount,
    updatedAt: entry.updatedAt,
  }
  if (entry.promoted) row.promoted = { destination: entry.promoted.destination, at: entry.promoted.at }
  if (content) row.content = entry.content
  return row
}

/** One opaque per-acquisition token value (display-only; authority is re-checked per mutation). */
function freshToken() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  return `token-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Create the remote service object. Methods take `(agent, args)`: the acting
 * Agent resolves from the wire's `agentId` lookup parameter (the same
 * 'agent' lookup the stock remotes use), and args is the single JSON
 * parameter the pinned contract names.
 *
 * list/read/apply surface typed BlackboardRemoteError failures; write/remove
 * fold every failure into their pinned { ok: false, error } shape (the panel
 * renders the error next to the field, not an exception screen).
 *
 * @param {object} [dependencies] test seams
 * @param {Function} [dependencies.bridge] bridge faces getter (default: the module bridge)
 * @param {() => boolean} [dependencies.ensureRegistered] channel liveness check before each call (default: always true)
 */
export function createBlackboardRemoteService(dependencies = {}) {
  const bridgeFor = dependencies.bridge ?? blackboardRemoteBridge
  const ensure = dependencies.ensureRegistered ?? (() => true)

  /**
   * Resolve the acting session and its board from the wire agent.
   * @param {any} agent
   * @returns {Promise<{ sessionId: string, boardId: string | undefined, faces: BridgeFaces }>}
   */
  async function resolveActing(agent) {
    if (!ensure()) throw new BlackboardRemoteError('channel-unavailable', 'blackboard remote is not registered with the gateway')
    const faces = bridgeFor()
    if (!faces) throw new BlackboardRemoteError('bridge-absent', 'blackboard remote is not offered (non-Weir preset or unmounted bridge)')
    const sessionId = typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : undefined
    if (sessionId === undefined) throw new BlackboardRemoteError('unknown-session', 'blackboard remote: the acting session identity is unavailable')
    if (faces.run) {
      // Keep admission and the eventual kernel operation in one lifecycle gate;
      // resolving a root alone is not a transferable authority across awaits.
      const kernel = Object.fromEntries(['list', 'read', 'apply', 'write', 'deleteKey', 'markPromoted'].map(method => [method,
        (_boardId, ...args) => faces.run(agent, root => faces.kernel[method](root, ...args)),
      ]))
      return { sessionId, boardId: undefined, faces: { ...faces, kernel } }
    }
    const boardId = await faces.boardOf(agent)
    return { sessionId, boardId, faces }
  }

  /** Wrap a face failure uniformly; typed errors pass through untouched. */
  async function payloadWrap(action, build) {
    try {
      return await build()
    } catch (cause) {
      if (cause instanceof BlackboardRemoteError) throw cause
      throw new BlackboardRemoteError('payload-failed', `blackboard remote ${action} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
  }

  return {
    /** Aggregate rows: key + entryType + summary + counts, never content. */
    async list(agent, args) {
      return payloadWrap('list', async () => {
        const { boardId, faces } = await resolveActing(agent)
        const rows = await faces.kernel.list(boardId, { entryType: args?.type, query: args?.query })
        return { entries: rows.map((/** @type {any} */ entry) => wireEntry(entry)) }
      })
    },

    /** Batch content read; unknown keys are values, not errors. Audit reads
     * through this remote (the panel) never move read counts — counting is
     * the agent-tool path's reuse evidence, not a page-view metric. */
    async read(agent, args) {
      return payloadWrap('read', async () => {
        const { boardId, faces } = await resolveActing(agent)
        const result = await faces.kernel.read(boardId, args?.keys ?? [], { count: false })
        return { entries: result.found.map((/** @type {any} */ entry) => wireEntry(entry, { content: true })) }
      })
    },

    /** Acquire the one-shot write authority for one key (auto-subscribes on contention; a promoted key refuses explicitly). */
    async apply(agent, args) {
      return payloadWrap('apply', async () => {
        const { sessionId, boardId, faces } = await resolveActing(agent)
        const result = await faces.kernel.apply(boardId, { holderId: sessionId, key: args?.key, ttlMs: faces.ttlMs() })
        if (result.status === 'contended') return { acquired: false, holder: result.holder, subscribed: true }
        if (result.status === 'promoted') return { acquired: false, promoted: true, destination: result.destination }
        return { acquired: true, token: freshToken(), expiresAt: result.expiresAt }
      })
    },

    /** Create or update one entry under the acting session's live write authority. */
    async write(agent, args) {
      try {
        const { sessionId, boardId, faces } = await resolveActing(agent)
        const result = await faces.kernel.write(boardId, {
          holderId: sessionId,
          key: args?.key,
          entryType: args?.entryType,
          summary: args?.summary,
          content: args?.content,
          ttlMs: faces.ttlMs(),
        })
        if (result.status === 'contended') {
          return { ok: false, error: `write authority for "${result.key}" is held by another agent; it releases automatically` }
        }
        if (result.status === 'promoted') {
          return { ok: false, error: `entry "${result.key}" is promoted (${result.destination}) and read-only; promoted entries can never be edited` }
        }
        if (result.status === 'no-authority') {
          const held = result.holder ? ` (held by another agent)` : ''
          return { ok: false, error: `write authority for "${result.key}" is not held by this session${held}; acquire it first` }
        }
        return { ok: true, revision: result.revision }
      } catch (cause) {
        const error = cause instanceof BlackboardRemoteError
          ? cause.message
          : `blackboard write failed: ${cause instanceof Error ? cause.message : String(cause)}`
        return { ok: false, error }
      }
    },

    /** Delete one entry under the acting session's live write authority. */
    async remove(agent, args) {
      try {
        const { sessionId, boardId, faces } = await resolveActing(agent)
        const result = await faces.kernel.deleteKey(boardId, { holderId: sessionId, key: args?.key })
        if (result.status === 'missing') return { ok: false, error: `blackboard key "${result.key}" does not exist` }
        if (result.status === 'promoted') {
          return { ok: false, error: `entry "${result.key}" is promoted (${result.destination}) and read-only; promoted entries can never be deleted` }
        }
        if (result.status === 'no-authority') {
          const held = result.holder ? ` (held by another agent)` : ''
          return { ok: false, error: `write authority for "${result.key}" is not held by this session${held}; acquire it first` }
        }
        return { ok: true }
      } catch (cause) {
        const error = cause instanceof BlackboardRemoteError
          ? cause.message
          : `blackboard remove failed: ${cause instanceof Error ? cause.message : String(cause)}`
        return { ok: false, error }
      }
    },

    /** Request the promotion-evaluation brief into the session's main agent (slice 3). Folds failures like the mutations. */
    async requestPromotion(agent, args) {
      try {
        const { faces } = await resolveActing(agent)
        if (typeof faces.requestPromotion !== 'function') {
          return { ok: false, error: 'the blackboard bridge does not offer promotion requests' }
        }
        await faces.requestPromotion(agent)
        return { ok: true }
      } catch (cause) {
        const error = cause instanceof BlackboardRemoteError
          ? cause.message
          : `blackboard promotion request failed: ${cause instanceof Error ? cause.message : String(cause)}`
        return { ok: false, error }
      }
    },

    /** Mark one entry promoted under the user-adjudicated destination (slice 3); marking is an annotation, not a payload mutation. */
    async markPromoted(agent, args) {
      try {
        const { boardId, faces } = await resolveActing(agent)
        const result = await faces.kernel.markPromoted(boardId, { key: args?.key, destination: args?.destination })
        if (result.status === 'missing') return { ok: false, error: `blackboard key "${result.key}" does not exist` }
        if (result.status === 'already-promoted') return { ok: true, destination: result.destination, alreadyPromoted: true }
        return { ok: true, destination: result.destination }
      } catch (cause) {
        const error = cause instanceof BlackboardRemoteError
          ? cause.message
          : `blackboard markPromoted failed: ${cause instanceof Error ? cause.message : String(cause)}`
        return { ok: false, error }
      }
    },

    /**
     * The panel's root resolution (slice 4): the browsing session id
     * crosses as a bare JSON value — NO agent lookup, NO scope — because
     * the gateway's lookup refuses subagent-owned sessions before this
     * service can run. Answers the conversation root whose board the
     * panel binds; a bridge without the rootOf face (an older blackboard
     * plugin) or a face returning an unusable id degrades to the
     * browsing id itself, which is exactly the pre-resolve behavior.
     */
    async resolve(sessionId) {
      return payloadWrap('resolve', async () => {
        if (!ensure()) throw new BlackboardRemoteError('channel-unavailable', 'blackboard remote is not registered with the gateway')
        const faces = bridgeFor()
        if (!faces) throw new BlackboardRemoteError('bridge-absent', 'blackboard remote is not offered (non-Weir preset or unmounted bridge)')
        const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
        if (id === undefined) throw new BlackboardRemoteError('unknown-session', 'blackboard remote resolve: the browsing session identity is unavailable')
        if (typeof faces.rootOf !== 'function') return { sessionId: id }
        const root = await faces.rootOf(id)
        return { sessionId: typeof root === 'string' && root.length > 0 ? root : id }
      })
    },
  }
}

/**
 * The hand-written typert contribution (S27: empty schemas/model, src-json
 * codecs, no zod, no generated artifacts). Parameters and results are plain
 * JSON; the envelope validates the argument names only. The acting session
 * rides the stock 'agent' lookup parameter with the 'agent' context scope
 * projection — the panel page injects its session id exactly like the
 * stock `fileReferences` remote.
 */
export function blackboardRemoteContribution() {
  return {
    // The registry's validatePackage requires both (missing = silently dead
    // registration). The package id must differ from 'weir-harness' — the
    // capability-remote contribution already owns that package face and the
    // registry rejects a duplicate.
    package: BLACKBOARD_REMOTE_PACKAGE,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      ...BLACKBOARD_REMOTE_METHODS.map(method => ({
      id: `${BLACKBOARD_REMOTE_PACKAGE}.${BLACKBOARD_REMOTE_NAMESPACE}.${method}`,
      service: BLACKBOARD_REMOTE_SERVICE_KEY,
      namespace: BLACKBOARD_REMOTE_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: { mode: 'src-json' } },
        { name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } },
      ],
      result: { mode: 'src-json' },
    })),
      // The eighth invocation, resolve, deliberately breaks the shared
      // shape: NO agent-lookup parameter, NO scope projection — the
      // gateway's agent lookup refuses subagent-owned sessions before
      // this service can run (the subagent-panel 404 root cause), so the
      // browsing session id crosses as a bare JSON value on the same
      // `agentId` wire field (the capability-remote precedent, src-json).
      {
        id: `${BLACKBOARD_REMOTE_PACKAGE}.${BLACKBOARD_REMOTE_NAMESPACE}.resolve`,
        service: BLACKBOARD_REMOTE_SERVICE_KEY,
        namespace: BLACKBOARD_REMOTE_NAMESPACE,
        method: 'resolve',
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'sessionId', wire: 'agentId', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      },
    ],
  }
}

/**
 * Host-layer cordis plugin (the production cordis.patch.yml row
 * weir-blackboard-remote sits beside weir-capability-remote — the gateway
 * resolves the service from the host root, so a preset-realm row could never
 * be dispatched, S27). Any setup failure (no typert service, a throwing
 * registration) logs a warning and stays inert: the panel degrades to its
 * explicit unavailable state and the host composition is never broken.
 *
 * The declared `typert` dependency keeps this row from mounting too early in
 * any composition (same contract as the capability-remote row, S27).
 */
export function apply(ctx) {
  const warn = text => ctx.logger?.warn?.(text)
  let typert
  try {
    typert = ctx.get?.('typert')
  } catch (cause) {
    warn(`weir blackboard remote: typert service lookup failed (${cause instanceof Error ? cause.message : String(cause)}); the board panel stays unavailable`)
    return
  }
  if (!typert?.register) {
    warn('weir blackboard remote: typert service is unavailable in this composition; the board panel stays unavailable')
    return
  }
  // Idempotent, self-healing registration (the registration-race lesson from
  // the capability remote): verify on demand and re-register on withdrawal.
  const endpointLive = () => {
    try { return Boolean(typert.local?.get?.(`${BLACKBOARD_REMOTE_NAMESPACE}/list`)) } catch { return false }
  }
  const ensureRegistered = () => {
    if (endpointLive()) return true
    try {
      typert.register(blackboardRemoteContribution())
      return true
    } catch (cause) {
      // Duplicate-package race: a previous generation's registration still
      // serves the endpoints — that is success, not a warning.
      if (endpointLive()) return true
      warn(`weir blackboard remote: registration failed (${cause instanceof Error ? cause.message : String(cause)}); the board panel stays unavailable`)
      return false
    }
  }
  try {
    const service = createBlackboardRemoteService({ ensureRegistered })
    // The exact frozen binding validateBinding requires (S27): { service,
    // serviceKey, namespace } — built by hand, no protocol import.
    service.typertRemote = Object.freeze({
      service,
      serviceKey: BLACKBOARD_REMOTE_SERVICE_KEY,
      namespace: BLACKBOARD_REMOTE_NAMESPACE,
    })
    Object.freeze(service)
    ctx.root.reflect.provide(BLACKBOARD_REMOTE_SERVICE_KEY, service)
    ensureRegistered()
  } catch (cause) {
    warn(`weir blackboard remote: setup failed (${cause instanceof Error ? cause.message : String(cause)}); the board panel stays unavailable`)
  }
}

export const name = 'weir-blackboard-remote'
export const inject = ['typert']
