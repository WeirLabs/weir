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

/** Extract the current projected owner and its last committed selection generation. */
function ownership(observation, sessionId) {
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
  return { presetId, cwd: observation.header.cwd, selectionSeq }
}

/** Create the host read service. Observations are caller-owned leases, always disposed. */
export function createCapabilityReadService(dependencies = {}) {
  const bridgeFor = dependencies.bridge ?? soleFeed
  const storeFor = dependencies.store ?? (profileContext => openCapabilityStore({ profileContext }))
  const ensure = dependencies.ensureRegistered ?? (() => true)
  const observeSession = dependencies.observeSession ?? (sessionId => dependencies.sessionQuery?.()?.observeSession(sessionId))
  const observe = async sessionId => {
    let lease
    try {
      lease = await observeSession(sessionId)
      if (!lease || typeof lease.dispose !== 'function') throw new CapabilityReadError('owner-unavailable', 'capability read: session observation is unavailable')
      return { lease, owner: ownership(lease, sessionId) }
    } catch (cause) {
      lease?.dispose?.()
      if (cause instanceof CapabilityReadError) throw cause
      throw new CapabilityReadError('unknown-session', `capability read: cannot observe session ${JSON.stringify(sessionId)}`, { cause })
    }
  }
  const read = async (sessionId, build) => {
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
      const second = await observe(sessionId)
      try {
        if (second.owner.presetId !== presetId || second.owner.cwd !== cwd || second.owner.selectionSeq !== selectionSeq || bridgeFor(presetId) !== feed) {
          throw new CapabilityReadError('owner-changed', 'capability read: owner or feed changed during read')
        }
        return payload
      } finally {
        second.lease.dispose()
      }
    } finally {
      first.lease.dispose()
    }
  }
  return {
    receipt: sessionId => read(sessionId, (faces, options) => buildReceiptPayload({
      provider: faces.provider,
      lifecycle: faces.lifecycle,
      store: storeFor(faces.profileContext?.()),
    }, options)),
    list: sessionId => read(sessionId, (faces, options) => buildListPayload({
      inventory: faces.inventory,
      provider: faces.provider,
      mcpManager: faces.mcpManager?.(),
    }, options)),
    conditions: sessionId => read(sessionId, () => buildConditionsPayload()),
    // Presets view reads (silent-preset-reads): the preset listing and the
    // workspace-default inspection. Domain statuses ({status:'no-workspace'},
    // a store-level listing failure) are VALUES the panel categorizes — only
    // infrastructure failures become CapabilityReadError.
    presets: sessionId => read(sessionId, (faces, options) => buildPresetsPayload({
      store: storeFor(faces.profileContext?.()),
    }, options)),
    defaultGet: sessionId => read(sessionId, (faces, options) => buildDefaultGetPayload({
      store: storeFor(faces.profileContext?.()),
    }, options)),
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
  // Idempotent, self-healing registration. The registry rejects a duplicate
  // package contribution, so a re-mount that races the previous fiber's
  // disposal must not treat "already registered" as fatal when the endpoints
  // are actually live — and a later withdrawal (that previous fiber finally
  // disposing) must be repaired on the next read rather than left dead.
  const endpointLive = () => {
    try { return Boolean(typert.local?.get?.(`${CAPABILITY_READ_NAMESPACE}/receipt`)) } catch { return false }
  }
  const ensureRegistered = () => {
    if (endpointLive()) return true
    try {
      typert.register(capabilityReadContribution())
      return true
    } catch (cause) {
      // Duplicate-package race: a previous generation's registration still
      // serves the endpoints — that is success, not a warning.
      if (endpointLive()) return true
      warn(`weir capability remote: registration failed (${cause instanceof Error ? cause.message : String(cause)}); capability reads stay unavailable on the client`)
      return false
    }
  }
  try {
    const service = createCapabilityReadService({ ensureRegistered, sessionQuery: () => ctx.get?.('sessionQuery') })
    // The exact frozen binding validateBinding requires (S27): { service,
    // serviceKey, namespace } — built by hand, no protocol import.
    service.typertRemote = Object.freeze({
      service,
      serviceKey: CAPABILITY_READ_SERVICE_KEY,
      namespace: CAPABILITY_READ_NAMESPACE,
    })
    Object.freeze(service)
    ctx.root.reflect.provide(CAPABILITY_READ_SERVICE_KEY, service)
    ensureRegistered()
  } catch (cause) {
    warn(`weir capability remote: setup failed (${cause instanceof Error ? cause.message : String(cause)}); capability reads stay unavailable on the client`)
  }
}

export const name = 'weir-capability-remote'
export const inject = ['typert', 'sessionQuery']
