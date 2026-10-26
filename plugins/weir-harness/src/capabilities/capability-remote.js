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

function soleFeed(presetId) {
  const feeds = bridgeFeeds.get(presetId)
  if (!feeds?.size) throw new CapabilityReadError('bridge-absent', `capability read: no feed for preset ${presetId}`)
  if (feeds.size !== 1) throw new CapabilityReadError('owner-ambiguous', `capability read: overlapping feeds for preset ${presetId}`)
  return [...feeds][0]
}

/** Exact feed token used by mutation ownership snapshots and their rechecks. */
export function capabilityReadFeed(presetId) { return soleFeed(presetId) }

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
  const bridgeFor = dependencies.bridge ?? soleFeed
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
      const feed = bridgeFor(presetId)
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
        if (second.owner.presetId !== presetId || second.owner.cwd !== cwd || second.owner.selectionSeq !== selectionSeq || bridgeFor(presetId) !== feed) {
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
  const bridgeFor = dependencies.bridge ?? soleFeed
  const ensure = dependencies.ensureRegistered ?? (() => true)
  const observeSession = dependencies.observeSession ?? (sessionId => dependencies.sessionQuery?.()?.observeSession(sessionId))
  const observe = async sessionId => {
    let lease
    try {
      lease = await observeSession(sessionId)
      if (!lease || typeof lease[Symbol.dispose] !== 'function') throw new CapabilityReadError('owner-unavailable', 'capability mutation: session observation unavailable')
      const owner = capabilityOwnership(lease, sessionId)
      const feed = bridgeFor(owner.presetId)
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

export function capabilityMutationContribution() {
  return {
    package: 'weir-harness',
    face: 'host-mutations',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: CAPABILITY_MUTATION_METHODS.map(method => ({
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
  }
}

/**
 * The hand-written typert contribution (S27: empty schemas/model, src-json
 * codecs, no zod, no generated artifacts). Parameters and results are plain
 * JSON; the envelope validates the argument name only.
 */
export function capabilityReadContribution() {
  return {
    // The registry's validatePackage requires both (missing = silently dead registration): it validates the package name and keys the package record by face.
    package: 'weir-harness',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: CAPABILITY_READ_METHODS.map(method => ({
      id: `weir-harness.${CAPABILITY_READ_NAMESPACE}.${method}`,
      service: CAPABILITY_READ_SERVICE_KEY,
      namespace: CAPABILITY_READ_NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'src-json' } }],
      result: { mode: 'src-json' },
    })),
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
  // Idempotent, self-healing registration of EVERY read and mutation endpoint.
  // A live receipt says nothing about write availability.
  const endpointLive = (namespace, method) => {
    try { return Boolean(typert.local?.get?.(`${namespace}/${method}`)) } catch { return false }
  }
  const endpointsLive = (namespace, methods) => methods.every(method => endpointLive(namespace, method))
  const ensureContribution = (namespace, methods, contribution) => {
    if (endpointsLive(namespace, methods)) return true
    try {
      typert.register(contribution())
    } catch (cause) {
      if (!endpointsLive(namespace, methods)) {
        warn(`weir capability remote: registration failed (${cause instanceof Error ? cause.message : String(cause)}); capability endpoints stay unavailable on the client`)
        return false
      }
    }
    return endpointsLive(namespace, methods)
  }
  const ensureRegistered = () => {
    const reads = ensureContribution(CAPABILITY_READ_NAMESPACE, CAPABILITY_READ_METHODS, capabilityReadContribution)
    const mutations = ensureContribution(CAPABILITY_MUTATION_NAMESPACE, CAPABILITY_MUTATION_METHODS, capabilityMutationContribution)
    return reads && mutations
  }
  try {
    const audit = createAudit(ctx)
    const onDegraded = facts => {
      warn(`weir capability read degraded: method=${facts.method} session=${facts.sessionId} preset=${facts.presetId} header=${facts.headerPreset} source=${facts.source} warnings=${facts.warnings.join(';')} provider=${facts.providerReason ?? '-'}: ${facts.providerError ?? '-'}`)
      audit({ id: facts.sessionId, header: { cwd: facts.cwd } }, 'capability-read', facts)
    }
    const service = createCapabilityReadService({ ensureRegistered, sessionQuery: () => ctx.get?.('sessionQuery'), onDegraded })
    service.typertRemote = Object.freeze({ service, serviceKey: CAPABILITY_READ_SERVICE_KEY, namespace: CAPABILITY_READ_NAMESPACE })
    Object.freeze(service)
    ctx.root.reflect.provide(CAPABILITY_READ_SERVICE_KEY, service)
    const mutations = createCapabilityMutationService({ ensureRegistered, sessionQuery: () => ctx.get?.('sessionQuery') })
    mutations.typertRemote = Object.freeze({ service: mutations, serviceKey: CAPABILITY_MUTATION_SERVICE_KEY, namespace: CAPABILITY_MUTATION_NAMESPACE })
    Object.freeze(mutations)
    ctx.root.reflect.provide(CAPABILITY_MUTATION_SERVICE_KEY, mutations)
    ensureRegistered()
  } catch (cause) {
    warn(`weir capability remote: setup failed (${cause instanceof Error ? cause.message : String(cause)}); capability reads stay unavailable on the client`)
  }
}

export const name = 'weir-capability-remote'
export const inject = ['typert', 'sessionQuery']
