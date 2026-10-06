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
// Every read resolves its faces from the bridge AT CALL TIME: a non-Orrery
// preset or an unmounted bridge surfaces as an explicit typed error, never a
// guessed or empty payload.
import { openCapabilityStore } from './store/store.js'
import { buildReceiptPayload, buildListPayload, buildConditionsPayload, buildPresetsPayload, buildDefaultGetPayload } from './read-payloads.js'

/** The host-root service key the typert gateway resolves (S27: ctx.get from the host root). */
export const CAPABILITY_READ_SERVICE_KEY = 'orreryCapabilityRead'
/** The wire namespace: POST /api/orreryCapabilities/<method>, client ctx.remote.orreryCapabilities.*. */
export const CAPABILITY_READ_NAMESPACE = 'orreryCapabilities'
/** The three read methods, each taking exactly one parameter. */
export const CAPABILITY_READ_METHODS = ['receipt', 'list', 'conditions', 'presets', 'defaultGet']

/**
 * Typed read-channel failure. `code` is the machine-readable discriminant:
 *   - 'bridge-absent'   — no skill-selection plugin fed the bridge (non-Orrery
 *                         preset or unmounted); the client settles its
 *                         explicit unavailable state.
 *   - 'unknown-session' — the session id never reached the cwd cache (not an
 *                         agent this runtime created).
 *   - 'payload-failed'  — an underlying face threw; the cause is chained.
 */
export class CapabilityReadError extends Error {
  /**
   * @param {'bridge-absent' | 'unknown-session' | 'payload-failed'} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options = undefined) {
    super(message, options)
    this.name = 'CapabilityReadError'
    this.code = code
  }
}

/**
 * The bridge: exactly one skill-selection plugin mounts per composition (per
 * process), and every consumer is the same bundle module instance — the same
 * module-level slot pattern as the selection face and the MCP facade realm
 * bridge. Faces:
 *   provider, inventory(options, previous?), lifecycle,
 *   mcpManager()      — orreryMcpManager accessor, read at call time
 *   profileContext()  — host profile identity for the capability store
 *   sessionCwd(id)    — { found: boolean, cwd: string | undefined }
 */
let bridgeFaces = null

/**
 * Feed the bridge (skill-selection apply). Returns the unregister the plugin
 * disposes with its own lifecycle.
 */
export function feedCapabilityReadBridge(faces) {
  bridgeFaces = faces
  return () => { if (bridgeFaces === faces) bridgeFaces = null }
}

/** Current bridge faces, or null when unmounted. */
export function capabilityReadBridge() {
  return bridgeFaces
}

/**
 * Create the read service object. Methods resolve options as
 * { cwd, scope: { session: { id: sessionId } } } and reuse the shared payload
 * builders (byte-parity with the /capabilities verbs). All failures are typed
 * CapabilityReadError instances.
 *
 * @param {object} [dependencies] test seams
 * @param {Function} [dependencies.bridge] bridge faces getter (default: the module bridge)
 * @param {Function} [dependencies.store] profileContext → opened capability store
 */
export function createCapabilityReadService(dependencies = {}) {
  const bridgeFor = dependencies.bridge ?? capabilityReadBridge
  const storeFor = dependencies.store ?? (profileContext => openCapabilityStore({ profileContext }))
  const read = async (sessionId, build) => {
    const faces = bridgeFor()
    if (!faces) throw new CapabilityReadError('bridge-absent', 'capability read channel is not offered (non-Orrery preset or unmounted bridge)')
    const location = typeof faces.sessionCwd === 'function' ? faces.sessionCwd(sessionId) : null
    if (!location?.found) throw new CapabilityReadError('unknown-session', `capability read: unknown session ${JSON.stringify(typeof sessionId === 'string' ? sessionId : String(sessionId))}`)
    const options = { cwd: location.cwd, scope: { session: { id: sessionId } } }
    try {
      return await build(faces, options)
    } catch (cause) {
      if (cause instanceof CapabilityReadError) throw cause
      throw new CapabilityReadError('payload-failed', `capability read failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
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
    package: 'orrery-harness',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: CAPABILITY_READ_METHODS.map(method => ({
      id: `orrery-harness.${CAPABILITY_READ_NAMESPACE}.${method}`,
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
 * Host-layer cordis plugin (cordis.patch.yml row orrery-capability-remote,
 * sibling of orrery-settings/orrery-notify — the gateway resolves the service
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
    warn(`orrery capability remote: typert service lookup failed (${cause instanceof Error ? cause.message : String(cause)}); capability reads stay unavailable on the client`)
    return
  }
  if (!typert?.register) {
    warn('orrery capability remote: typert service is unavailable in this composition; capability reads stay unavailable on the client')
    return
  }
  try {
    const service = createCapabilityReadService()
    // The exact frozen binding validateBinding requires (S27): { service,
    // serviceKey, namespace } — built by hand, no protocol import.
    service.typertRemote = Object.freeze({
      service,
      serviceKey: CAPABILITY_READ_SERVICE_KEY,
      namespace: CAPABILITY_READ_NAMESPACE,
    })
    Object.freeze(service)
    ctx.root.reflect.provide(CAPABILITY_READ_SERVICE_KEY, service)
    typert.register(capabilityReadContribution())
  } catch (cause) {
    warn(`orrery capability remote: registration failed (${cause instanceof Error ? cause.message : String(cause)}); capability reads stay unavailable on the client`)
  }
}

export const name = 'orrery-capability-remote'
export const inject = ['typert']
