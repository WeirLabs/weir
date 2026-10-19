// The process-wide lease client and the wiring the managed editors share
// (design D8, D9, D11).
//
// ONE client per endpoint for the whole process, created lazily on first use and
// NEVER closed: two preset mounts of this bundle share one connection and one
// lease ledger, so unmounting a mount must not rip the connection out from under
// its sibling. There is deliberately no reference counting and no dispose hook —
// the client's lifetime is the process's, and its own idle window plus the
// daemon's disconnect rule are what end leases.
//
// `createEditorLease` is the second half of the same wiring: which client, who
// the caller is, and which opaque scope string it reports. It is here (rather
// than repeated in `hashline-edit` and `lsp`) because design D9 makes owner
// identity a single rule — a delegated child inherits its spawner's lineage, so
// it never conflicts with the session that spawned it. Two copies of that rule
// would drift, and the drift would only show up as a stuck delegation chain.
//
// Nothing here connects, spawns or audits on import: creating a client allocates
// state, and its first request is what dials.

import process from 'node:process'
import { createLeaseClient } from './client.js'
import { createLineageResolver } from './lineage.js'
import { defaultSocketPath } from '../lease-broker/server.js'
import { PROTOCOL } from '../lease-broker/protocol.js'

/**
 * Opaque scope used when neither the session nor the call resolved a root. It is
 * a `status` filter label and never an authority (design D8): reporting `'/'`
 * for a composition with no cwd beats refusing to acquire a lease.
 */
const FALLBACK_SCOPE = '/'

/**
 * Clients this process has created, keyed by endpoint. Never emptied — see the
 * module comment. The map is the whole "singleton": keyed by socket path, so two
 * protocol majors (or a test's private endpoint) never share a client.
 * @type {Map<string, any>}
 */
const clients = new Map()

/** @param {unknown} value @returns {string | undefined} */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The endpoint this bundle's protocol major arbitrates on.
 *
 * `WEIR_EDITLOCKD_SOCKET` wins when set. The daemon entry reads the same
 * variable, so a composer that owns a private root (the integration harness) can
 * move BOTH halves to one private socket with a single knob; leaving it unset
 * keeps the machine-level per-user default. Nothing else consults the variable.
 * @returns {string}
 */
export function defaultLeaseEndpoint() {
  const override = text(process.env.WEIR_EDITLOCKD_SOCKET)
  if (override !== undefined) return override
  return defaultSocketPath({ protocol: PROTOCOL })
}

/**
 * The process-wide client for one endpoint (design D11).
 *
 * The FIRST call creates it; every later call for the same endpoint returns that
 * same instance, whatever overrides it passes — the connection and the lease
 * ledger are process state, not per-mount state. Creation itself touches
 * nothing: the client dials (and spawns) on its first request.
 *
 * @param {any} [overrides] `createLeaseClient` options; `socketPath` selects the endpoint
 * @returns {any} the shared client
 */
export function getSharedLeaseClient(overrides = {}) {
  const socketPath = text(overrides?.socketPath) ?? defaultLeaseEndpoint()
  const existing = clients.get(socketPath)
  if (existing !== undefined) return existing
  const created = createLeaseClient({ ...overrides, socketPath })
  clients.set(socketPath, created)
  return created
}

/**
 * @typedef {object} LeaseOwner
 * @property {string} id the lineage (opaque to the arbiter)
 * @property {string} session the session that last touched the lease
 * @property {string} label presentation only
 */

/**
 * @typedef {object} EditorLease
 * @property {() => any} client the client to speak through (injected, else the process-wide one)
 * @property {(agent: any) => LeaseOwner} ownerOf who the calling agent writes as
 * @property {(agent: any, fallback?: string) => string} scopeOf the opaque project root to report
 */

/**
 * The `sessions` registry, read defensively: a cold or partially mounted host has
 * none, and the resolver degrades to "this session is its own lineage".
 * @param {any} ctx
 * @returns {{ get?: (id: string) => any } | undefined}
 */
function sessionsOf(ctx) {
  try {
    return ctx?.get?.('sessions') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * The session this agent acts for: the durable header id when there is one, else
 * the live session id, else the agent id. `undefined` only for an agent object
 * with no identity at all — the caller then reports the lineage as the session.
 * @param {any} agent
 * @returns {string | undefined}
 */
function sessionIdOf(agent) {
  return text(agent?.session?.header?.id) ?? text(agent?.session?.id) ?? text(agent?.id)
}

/**
 * Create the lease wiring for one managed editor.
 *
 * `leaseClient` is the injection seam tests (and any future embedder) use; when
 * it is absent the process-wide client is resolved lazily on the first managed
 * write, so a composition that never writes never constructs one.
 *
 * @param {{ leaseClient?: any, ctx?: any }} [options]
 * @returns {EditorLease}
 */
export function createEditorLease({ leaseClient, ctx } = {}) {
  /** @type {any} */
  const injected = leaseClient ?? null
  /** @type {any} */
  let shared = null
  const resolver = createLineageResolver({ sessions: sessionsOf(ctx) })
  return Object.freeze({
    client() {
      if (injected !== null) return injected
      if (shared === null) shared = getSharedLeaseClient()
      return shared
    },
    ownerOf(agent) {
      const lineage = resolver.lineageOf(agent)
      return {
        id: lineage,
        session: sessionIdOf(agent) ?? lineage,
        label: resolver.labelOf(agent),
      }
    },
    scopeOf(agent, fallback) {
      return text(agent?.session?.header?.cwd) ?? text(fallback) ?? FALLBACK_SCOPE
    },
  })
}
