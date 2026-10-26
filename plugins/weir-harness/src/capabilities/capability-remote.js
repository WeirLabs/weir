// Capability read remote (silent-capability-reads task 2.2): the plugin-owned
// typert remote service that carries the Badge/manager READ operations
// (receipt / list / conditions) off the /capabilities slash command, so reads
// produce ZERO session-log events.
//
// Two halves sharing one module instance (the mcp-facade realm-bridge
// pattern, docs/features/session-capability-manager.md):
//
//   - the PRESET-layer skill-selection plugin feeds the module-level BRIDGE
//     with the faces the payloads need at apply and unregisters at dispose
//     (preset services are invisible to the host-root gateway, S27);
//   - the HOST-layer cordis plugin below creates the service, attaches the
//     hand-built frozen typertRemote binding (validateBinding's exact shape,
//     S27 — no @deepseek-ai/* import, no Remote decorators), publishes it on
//     the host root, and registers a hand-written typert contribution
//     (src-json codecs, zero generated artifacts).
//
// Each read observes the exact session's current preset and checks the same
// ownership generation again after the payload resolves.
import { openCapabilityStore } from './store/store.js'
import { buildReceiptPayload, buildListPayload, buildConditionsPayload, buildPresetsPayload, buildDefaultGetPayload } from './read-payloads.js'
import { PRESET_SELECTED_EVENT } from './preset-invalidation.js'
import { createAudit } from '../shared/audit.js'
import { mcpDiagnostic, sanitizeMcpPayload } from './mcp-diagnostics.js'

/** The host-root service key the typert gateway resolves (S27: ctx.get from the host root). */
export const CAPABILITY_READ_SERVICE_KEY = 'weirCapabilityRead'
/** The wire namespace: POST /api/weirCapabilities/<method>, client ctx.remote.weirCapabilities.*. */
export const CAPABILITY_READ_NAMESPACE = 'weirCapabilities'
/** The five read methods, each taking exactly one parameter. */
export const CAPABILITY_READ_METHODS = ['receipt', 'list', 'conditions', 'presets', 'defaultGet']

/** Typed infrastructure/ownership failure, distinct from domain status values. */
export class CapabilityReadError extends Error {
  /**
   * @param {'bridge-absent' | 'owner-ambiguous' | 'owner-unavailable' | 'owner-changed' | 'unknown-session' | 'payload-failed' | 'channel-unavailable'} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = undefined) {
    super(message, options)
    this.name = 'CapabilityReadError'
    this.code = code
  }
}

/** Explicit per-preset feeds. Overlapping generations are ambiguous, never last-writer-wins. */
const bridgeFeeds = new Map()
const READ_PRESETS = new Set(['weir', 'weir-creative'])

export function feedCapabilityReadBridge(faces) {
  const presetId = faces?.readPresetId
  if (!READ_PRESETS.has(presetId)) throw new TypeError('capability read feed requires an explicit supported readPresetId')
  const token = { faces }
  const feeds = bridgeFeeds.get(presetId) ?? new Set()
  feeds.add(token)
  bridgeFeeds.set(presetId, feeds)
  return () => {
    feeds.delete(token)
    if (feeds.size === 0) bridgeFeeds.delete(presetId)
  }
}

/** Feed counts per supported preset, for degraded-read diagnostics (no faces content). */
function feedCensus() {
  return { weir: bridgeFeeds.get('weir')?.size ?? 0, weirCreative: bridgeFeeds.get('weir-creative')?.size ?? 0 }
}

/** Return the sole generation for an exact preset; no implicit/default owner. */
export function capabilityReadBridge(presetId) {
  const feeds = bridgeFeeds.get(presetId)
  return feeds?.size === 1 ? [...feeds][0].faces : null
}

/**
 * The isolated `weirMcpManager` owned by the exact preset revision a live
 * session's Agent retains, or undefined when that cannot be proven. The
 * registry's `serviceFor(agent, name)` reads `agent.ctx`'s retained mount, so
 * an old session keeps resolving its old revision after a config change or a
 * bundle toggle remounted the preset next to it. Everything is read through
 * caller-supplied ctx getters (never a static runtime import).
 * @param {string} sessionId
 * @param {{ agents?: () => any, agentPresets?: () => any }} [runtime]
 */
function sessionManager(sessionId, runtime) {
  try {
    const agent = runtime?.agents?.()?.get?.(sessionId)
    // A cold or unknown session has no live Agent and hence no retained mount.
    if (!agent?.ctx || agent.id !== sessionId) return undefined
    const registry = runtime?.agentPresets?.()
    if (typeof registry?.serviceFor !== 'function') return undefined
    return registry.serviceFor(agent, 'weirMcpManager') ?? undefined
  } catch { return undefined }
}

/**
 * Resolve the feed owning ONE session's read/mutation.
 *
 * A single feed is the fast path (no agent lookup). Several feeds for one
 * preset are legitimate — two retained revisions of the same preset stay
 * mounted while old sessions still use the old one — so the owner is the
 * unique feed whose `faces.mcpManager()` IS the manager the session's own
 * revision provides. Every other outcome fails closed with `owner-ambiguous`:
 * no runtime seam, a cold/unknown agent, a revision without a manager, no
 * matching feed, or several feeds sharing that manager (overlapping
 * generations of one revision). Never newest-wins.
 * @param {string} presetId
 * @param {string} sessionId
 * @param {{ agents?: () => any, agentPresets?: () => any }} [runtime]
 */
function sessionFeed(presetId, sessionId, runtime) {
  const feeds = bridgeFeeds.get(presetId)
  if (!feeds?.size) throw new CapabilityReadError('bridge-absent', `capability read: no feed for preset ${presetId}`)
  if (feeds.size === 1) return [...feeds][0]
  const ambiguous = reason => new CapabilityReadError('owner-ambiguous', `capability read: overlapping feeds for preset ${presetId}: ${reason}`)
  const manager = sessionManager(sessionId, runtime)
  if (manager === undefined) throw ambiguous(`session ${JSON.stringify(sessionId)} has no live agent with a preset-owned MCP manager`)
  const matches = [...feeds].filter(feed => {
    try { return feed.faces?.mcpManager?.() === manager } catch { return false }
  })
  if (matches.length === 0) throw ambiguous(`no feed belongs to the revision of session ${JSON.stringify(sessionId)}`)
  if (matches.length > 1) throw ambiguous(`${matches.length} feeds share the manager of session ${JSON.stringify(sessionId)}`)
  return matches[0]
}

/**
 * Exact feed token used by mutation ownership snapshots and their rechecks.
 * @param {string} presetId
 * @param {string} sessionId
 * @param {{ agents?: () => any, agentPresets?: () => any }} [runtime] ctx getters for the host `agents` and `agentPresets` services
 */
export function capabilityReadFeed(presetId, sessionId, runtime = undefined) { return sessionFeed(presetId, sessionId, runtime) }

/** @param {{ bridge?: Function, agents?: () => any, agentPresets?: () => any }} dependencies */
function feedResolver(dependencies) {
  if (dependencies.bridge) return dependencies.bridge
  const runtime = { agents: dependencies.agents, agentPresets: dependencies.agentPresets }
  return (presetId, sessionId) => sessionFeed(presetId, sessionId, runtime)
}

/** Extract the current projected owner and its last committed selection generation. */
export function capabilityOwnership(observation, sessionId) {
  if (!observation || observation.header?.id !== sessionId) {
    throw new CapabilityReadError('unknown-session', `capability read: unknown session ${JSON.stringify(sessionId)}`)
  }
  const presetId = observation.projections?.values?.agentPreset
  if (typeof presetId !== 'string' || !READ_PRESETS.has(presetId)) {
    throw new CapabilityReadError('owner-unavailable', 'capability read: current preset projection is missing or unsupported')
  }
  const events = observation.events
  if (!Array.isArray(events)) throw new CapabilityReadError('owner-unavailable', 'capability read: session selection history is unavailable')
  const selectionSeq = events.reduce((seq, event) => event?.type === PRESET_SELECTED_EVENT && typeof event.seq === 'number' ? Math.max(seq, event.seq) : seq, -1)
  return { presetId, headerPreset: observation.header.agentPreset ?? null, cwd: observation.header.cwd, selectionSeq }
}

/** Create the host read service. Observations are caller-owned leases, always disposed. */
export function createCapabilityReadService(dependencies = {}) {
  const bridgeFor = feedResolver(dependencies)
  const storeFor = dependencies.store ?? (profileContext => openCapabilityStore({ profileContext }))
  const ensure = dependencies.ensureRegistered ?? (() => true)
  const onDegraded = dependencies.onDegraded ?? (() => {})
  const observeSession = dependencies.observeSession ?? (sessionId => dependencies.sessionQuery?.()?.observeSession(sessionId))
  const observe = async sessionId => {
    let lease
    try {
      lease = await observeSession(sessionId)
      if (!lease || typeof lease[Symbol.dispose] !== 'function') throw new CapabilityReadError('owner-unavailable', 'capability read: session observation is unavailable')
      return { lease, owner: capabilityOwnership(lease, sessionId) }
    } catch (cause) {
      lease?.[Symbol.dispose]?.()
      if (cause instanceof CapabilityReadError) throw cause
      throw new CapabilityReadError('unknown-session', `capability read: cannot observe session ${JSON.stringify(sessionId)}`, { cause })
    }
  }
  const read = async (sessionId, method, build) => {
    if (!ensure()) throw new CapabilityReadError('channel-unavailable', 'capability read channel is not registered with the gateway')
    const first = await observe(sessionId)
    try {
      const { presetId, cwd, selectionSeq } = first.owner
      const feed = bridgeFor(presetId, sessionId)
      if (!feed) throw new CapabilityReadError('bridge-absent', `capability read: no feed for preset ${presetId}`)
      const faces = feed.faces ?? feed
      const options = { cwd, scope: { session: { id: sessionId } } }
      let payload
      try {
        payload = await build(faces, options)
      } catch (cause) {
        if (cause instanceof CapabilityReadError) throw cause
        throw new CapabilityReadError('payload-failed', `capability read failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
      }
      // Degraded-receipt diagnostic: a delivered payload with warnings proves
      // the read reached ONE unambiguous owner, but the wire shape cannot say
      // WHICH owner or why the provider degraded. Record the observed identity,
      // header vs projected preset, feed census and the provider's own status so
      // a live "accepted but unverifiable" report is diagnosable without
      // cookies, session-log writes, or skill names.
      if (Array.isArray(payload?.warnings) && payload.warnings.length > 0) {
        try {
          const status = faces.provider?.status?.(options)
          onDegraded({
            method, sessionId, presetId, headerPreset: first.owner.headerPreset,
            source: first.lease?.source ?? null, selectionSeq, cwd,
            warnings: [...payload.warnings],
            providerError: typeof status?.error === 'string' ? status.error : null,
            providerReason: typeof status?.reason === 'string' ? status.reason : null,
            feeds: feedCensus(),
          })
        } catch { /* diagnostics never break a read */ }
      }
      const second = await observe(sessionId)
      try {
        if (second.owner.presetId !== presetId || second.owner.cwd !== cwd || second.owner.selectionSeq !== selectionSeq || bridgeFor(presetId, sessionId) !== feed) {
          throw new CapabilityReadError('owner-changed', 'capability read: owner or feed changed during read')
        }
        return payload
      } finally {
        second.lease[Symbol.dispose]()
      }
    } finally {
      first.lease[Symbol.dispose]()
    }
  }
  return {
    receipt: sessionId => read(sessionId, 'receipt', (faces, options) => buildReceiptPayload({
      provider: faces.provider,
      lifecycle: faces.lifecycle,
      store: storeFor(faces.profileContext?.()),
    }, options)),
    list: sessionId => read(sessionId, 'list', (faces, options) => buildListPayload({
      inventory: faces.inventory,
      provider: faces.provider,
      mcpManager: faces.mcpManager?.(),
    }, options)),
    conditions: sessionId => read(sessionId, 'conditions', () => buildConditionsPayload()),
    // Presets view reads (silent-preset-reads): the preset listing and the
    // workspace-default inspection. Domain statuses ({status:'no-workspace'},
    // a store-level listing failure) are VALUES the panel categorizes — only
    // infrastructure failures become CapabilityReadError.
    presets: sessionId => read(sessionId, 'presets', (faces, options) => buildPresetsPayload({
      store: storeFor(faces.profileContext?.()),
    }, options)),
    defaultGet: sessionId => read(sessionId, 'defaultGet', (faces, options) => buildDefaultGetPayload({
      store: storeFor(faces.profileContext?.()),
    }, options)),
  }
}

export const CAPABILITY_MUTATION_SERVICE_KEY = 'weirCapabilityMutation'
export const CAPABILITY_MUTATION_NAMESPACE = 'weirCapabilityMutations'
export const CAPABILITY_MUTATION_METHODS = ['mutate', 'batch']

export function sameMutationOwner(first, second) {
  const profile = value => value ? `${value.home ?? ''}\0${value.name ?? ''}` : ''
  return first.owner.presetId === second.owner.presetId
    && first.owner.cwd === second.owner.cwd
    && first.feed === second.feed
    && profile(first.profile) === profile(second.profile)
}

/** Session-preset/profile/feed ownership for mutations; selectionSeq is not compared. */
export function createCapabilityMutationService(dependencies = {}) {
  const bridgeFor = feedResolver(dependencies)
  const ensure = dependencies.ensureRegistered ?? (() => true)
  const observeSession = dependencies.observeSession ?? (sessionId => dependencies.sessionQuery?.()?.observeSession(sessionId))
  const observe = async sessionId => {
    let lease
    try {
      lease = await observeSession(sessionId)
      if (!lease || typeof lease[Symbol.dispose] !== 'function') throw new CapabilityReadError('owner-unavailable', 'capability mutation: session observation unavailable')
      const owner = capabilityOwnership(lease, sessionId)
      const feed = bridgeFor(owner.presetId, sessionId)
      if (!feed) throw new CapabilityReadError('bridge-absent', `capability mutation: no feed for preset ${owner.presetId}`)
      const faces = feed.faces ?? feed
      return { lease, owner, feed, faces, profile: faces.profileContext?.() }
    } catch (cause) {
      lease?.[Symbol.dispose]?.()
      if (cause instanceof CapabilityReadError) throw cause
      throw new CapabilityReadError('unknown-session', `capability mutation: cannot observe session ${JSON.stringify(sessionId)}`, { cause })
    }
  }
  async function mutate(sessionId, request, batch = false) {
    if (!ensure()) throw new CapabilityReadError('channel-unavailable', 'capability mutation channel is not registered')
    const first = await observe(sessionId)
    try {
      const assertOwner = async () => {
        const current = await observe(sessionId)
        try {
          if (!sameMutationOwner(first, current)) throw new CapabilityReadError('owner-changed', 'capability mutation: session preset/profile/feed owner changed')
        } finally { current.lease[Symbol.dispose]() }
      }
      if (typeof first.faces.mcpOperations !== 'function') throw new CapabilityReadError('bridge-absent', 'capability mutation: owning preset has no MCP operations')
      const operations = first.faces.mcpOperations({ id: sessionId, header: { cwd: first.owner.cwd } }, { assertOwner })
      let result
      try {
        result = batch ? await operations.executeBatch(request) : request?.action === 'preview' ? await operations.preview(request) : await operations.execute(request)
      } catch (cause) {
        result = { status: cause?.code === 'owner-changed' ? 'owner-changed' : 'validation-failed', saved: false, error: mcpDiagnostic(cause, { code: cause?.code ?? 'validation-failed' }) }
      }
      // A response may be stale by the time it is serialized. Never claim a
      // rollback; return the operation's actual saved facts with owner-changed.
      try {
        await assertOwner()
      } catch (cause) {
        if (result.status !== 'owner-changed') {
          return sanitizeMcpPayload({
            ...result,
            status: 'owner-changed',
            ownerChanged: true,
            actual: {
              status: result.status,
              saved: result.saved === true,
              registryRevision: result.registryRevision ?? null,
              generation: result.generation ?? null,
              incarnation: result.incarnation ?? null,
            },
            error: mcpDiagnostic(cause, { code: 'owner-changed' }),
          })
        }
      }
      return sanitizeMcpPayload(result)
    } finally {
      first.lease[Symbol.dispose]()
    }
  }
  return {
    mutate: (sessionId, request) => mutate(sessionId, request, false),
    batch: (sessionId, request) => mutate(sessionId, request, true),
  }
}

/**
 * Every endpoint the gateway resolves through this package's ONE host-face
 * contribution, in contribution order. A live read says nothing about write
 * availability, so liveness is always checked across this whole set.
 */
export const CAPABILITY_ENDPOINTS = [
  ...CAPABILITY_READ_METHODS.map(method => `${CAPABILITY_READ_NAMESPACE}/${method}`),
  ...CAPABILITY_MUTATION_METHODS.map(method => `${CAPABILITY_MUTATION_NAMESPACE}/${method}`),
]

/**
 * The hand-written typert contribution (S27: empty schemas/model, src-json
 * codecs, no zod, no generated artifacts). Parameters and results are plain
 * JSON; the envelope validates the argument name only.
 *
 * ALL five read and two mutation invocations live in ONE contribution, because
 * the registry keys exactly one record per package+face and rejects any second
 * registration while that record is live: two separate `weir-harness` host-face
 * contributions could never overlap generations, and the face the mutation half
 * used to declare (`host-mutations`) is not a face the registry accepts at all —
 * register() threw and apply() swallowed it into a warning, so the write channel
 * was silently dead. One atomic batch also means recovery restores every
 * endpoint or none.
 */
export function capabilityContribution() {
  return {
    // The registry's validatePackage requires both (missing = silently dead registration): it validates the package name, rejects any face except host/client, and keys the package record by face.
    package: 'weir-harness',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      ...CAPABILITY_READ_METHODS.map(method => ({
        id: `weir-harness.${CAPABILITY_READ_NAMESPACE}.${method}`,
        service: CAPABILITY_READ_SERVICE_KEY,
        namespace: CAPABILITY_READ_NAMESPACE,
        method,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } }],
        result: { mode: 'src-json' },
      })),
      ...CAPABILITY_MUTATION_METHODS.map(method => ({
        id: `weir-harness.${CAPABILITY_MUTATION_NAMESPACE}.${method}`,
        service: CAPABILITY_MUTATION_SERVICE_KEY,
        namespace: CAPABILITY_MUTATION_NAMESPACE,
        method,
        invocation: { kind: 'direct' },
        parameters: [
          { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } },
          { name: 'request', wire: 'request', source: 'json', codec: { mode: 'src-json' } },
        ],
        result: { mode: 'src-json' },
      })),
    ],
  }
}

/**
 * Host-layer cordis plugin (cordis.patch.yml row weir-capability-remote,
 * sibling of weir-settings/weir-notify — the gateway resolves the service
 * from the host root, so a preset-realm row could never be dispatched, S27).
 * Any setup failure (no typert service, a throwing registration) logs a
 * warning and stays inert: the client degrades to its explicit unavailable
 * state and the host composition is never broken.
 *
 * The declared `typert` dependency is what keeps this row from mounting too
 * early in any composition: apply() reads the service through ctx.get and the
 * gateway dispatch resolves through it as well, so the loader must order this
 * row after the typert provider — including a composition where a user-layer
 * patch injects typert after the bundle rows (S27).
 *
 * Registration lifecycle (S27.5, gateway/definition-unavailable): a fiber
 * reload runs apply() again while the previous incarnation's effects are still
 * unwinding, so BOTH the service provision and the contribution registration can
 * lose that race, and the old incarnation then withdraws what the new one
 * skipped. Because the gateway refuses a withdrawn strict definition before it
 * ever reaches a service method (hasSeen + no live definition), the recovery
 * must live in this plugin's own fiber: it subscribes to `typert.local` changes
 * and re-attempts provision+registration on a coalesced microtask while the
 * endpoints are incomplete. Every one of those facts is per-fiber state: a
 * pending retry, the disposal latch and the warning latch belong to THIS
 * generation, so an old generation can never consume the survivor's retry, and
 * a disposed fiber cannot resurrect the endpoints (Cordis rejects its effect
 * creation with INACTIVE_EFFECT — the final barrier, never a retry loop).
 */
export function apply(ctx) {
  const warn = text => ctx.logger?.warn?.(text)
  let typert
  try {
    typert = ctx.get?.('typert')
  } catch (cause) {
    warn(`weir capability remote: typert service lookup failed (${cause instanceof Error ? cause.message : String(cause)}); capability reads stay unavailable on the client`)
    return
  }
  if (!typert?.register) {
    warn('weir capability remote: typert service is unavailable in this composition; capability reads stay unavailable on the client')
    return
  }
  // Per-fiber lifecycle state. NEVER module-global: the previous incarnation's
  // listener and this one can both observe the same withdrawal.
  let disposed = false
  let retryQueued = false
  let registrationWarned = false
  const endpointLive = endpoint => {
    try { return Boolean(typert.local?.get?.(endpoint)) } catch { return false }
  }
  const endpointsComplete = () => CAPABILITY_ENDPOINTS.every(endpointLive)
  let readService
  let mutationService
  // Provide one service unless another incarnation still holds the host-root
  // key. A host-root provide lives on the ROOT fiber (S27: the gateway resolves
  // ctx.get from the host root), so the first incarnation's receiver survives
  // every reload; replacing it is neither possible nor needed. A lost race is
  // not fatal — the retry below keeps every endpoint self-healing.
  const ensureService = (key, service) => {
    try {
      const current = typeof ctx.get === 'function' ? ctx.get(key) : undefined
      if (current === service) return true
      if (current !== undefined) return false
      ctx.root.reflect.provide(key, service)
      return true
    } catch { return false }
  }
  const ensureServices = () => {
    const read = ensureService(CAPABILITY_READ_SERVICE_KEY, readService)
    const mutation = ensureService(CAPABILITY_MUTATION_SERVICE_KEY, mutationService)
    return read && mutation
  }
  // Exactly ONE register attempt per call: the registry rejects the whole batch
  // or commits all of it, so looping could only repeat the same rejection.
  const ensureContribution = () => {
    if (endpointsComplete()) return true
    try {
      typert.register(capabilityContribution())
    } catch (cause) {
      if (!endpointsComplete()) {
        // A disposed fiber's rejection is terminal (the survivor owns the retry).
        if (cause?.code === 'INACTIVE_EFFECT') {
          disposed = true
          return false
        }
        if (!registrationWarned) {
          registrationWarned = true
          warn(`weir capability remote: registration failed (${cause instanceof Error ? cause.message : String(cause)}); capability endpoints stay unavailable on the client`)
        }
        return false
      }
    }
    return endpointsComplete()
  }
  const ensureRegistered = () => ensureContribution()
  // Coalesce a burst of registry changes into one microtask. Waiting a turn also
  // lets the disposing incarnation finish synchronously releasing its service
  // keys, which a synchronous retry inside the change callback would still see.
  const queueRetry = () => {
    if (disposed || retryQueued) return
    retryQueued = true
    queueMicrotask(() => {
      retryQueued = false
      if (disposed || endpointsComplete()) return
      ensureServices()
      ensureContribution()
    })
  }
  // Latch disposal as early as the fiber allows, before a queued retry can run
  // against a fiber Cordis has already detached. A fiber that is already gone
  // needs no latch: its next register() is rejected with INACTIVE_EFFECT.
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => () => { disposed = true })
  } catch { /* detached fiber: the effect rejection is the barrier */ }
  try {
    const audit = createAudit(ctx)
    const onDegraded = facts => {
      warn(`weir capability read degraded: method=${facts.method} session=${facts.sessionId} preset=${facts.presetId} header=${facts.headerPreset} source=${facts.source} warnings=${facts.warnings.join(';')} provider=${facts.providerReason ?? '-'}: ${facts.providerError ?? '-'}`)
      audit({ id: facts.sessionId, header: { cwd: facts.cwd } }, 'capability-read', facts)
    }
    // Per-session owner resolution reads the host agents registry and the
    // preset registry lazily (both host-root services; no mount-time inject).
    const runtime = { agents: () => ctx.get?.('agents'), agentPresets: () => ctx.get?.('agentPresets') }
    readService = createCapabilityReadService({ ensureRegistered, sessionQuery: () => ctx.get?.('sessionQuery'), onDegraded, ...runtime })
    readService.typertRemote = Object.freeze({ service: readService, serviceKey: CAPABILITY_READ_SERVICE_KEY, namespace: CAPABILITY_READ_NAMESPACE })
    Object.freeze(readService)
    mutationService = createCapabilityMutationService({ ensureRegistered, sessionQuery: () => ctx.get?.('sessionQuery'), ...runtime })
    mutationService.typertRemote = Object.freeze({ service: mutationService, serviceKey: CAPABILITY_MUTATION_SERVICE_KEY, namespace: CAPABILITY_MUTATION_NAMESPACE })
    Object.freeze(mutationService)
  } catch (cause) {
    warn(`weir capability remote: setup failed (${cause instanceof Error ? cause.message : String(cause)}); capability reads stay unavailable on the client`)
    return
  }
  // Provision BEFORE registering: the gateway resolves the service key of a
  // live definition, so an endpoint must never outlive its receiver.
  ensureServices()
  ensureContribution()
  // Independent per-fiber subscription: hosts without it keep the older
  // self-heal-on-call behaviour (each service call still checks the endpoints).
  try {
    typert.local?.subscribe?.(() => { if (!endpointsComplete()) queueRetry() })
  } catch (cause) {
    warn(`weir capability remote: registration watch failed (${cause instanceof Error ? cause.message : String(cause)}); the capability channel only self-heals on the next call`)
  }
}

export const name = 'weir-capability-remote'
export const inject = ['typert', 'sessionQuery']
