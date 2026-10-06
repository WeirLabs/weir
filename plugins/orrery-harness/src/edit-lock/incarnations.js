// Manager incarnation process identity (design D2, openspec
// edit-lock-autonomous-recovery). The v6 authority image carries a registry of
// every manager incarnation it references with the process identity of that
// incarnation ({pid, host, osStart, bootNonce} from the shared Liveness
// adapter) or null for incarnations that predate the registry. Null
// identities NEVER participate in automatic settlement.

/**
 * @typedef {{ pid: number, host: string, osStart: string|null, bootNonce: string }} ProcessIdentity
 * @typedef {{ incarnation: string, process: ProcessIdentity|null }} IncarnationEntry
 */

import { canonical } from './snapshot.js'

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function valid(condition, message) {
  if (!condition) throw new Error(`invalid incarnation ${message}`)
}
/** @param {unknown} value @returns {value is string} */
const id = value => typeof value === 'string' && value.length > 0
/** @param {unknown} value @param {string[]} keys @returns {asserts value is Record<string, unknown>} */
function shape(value, keys) {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value), 'object')
  valid(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'object prototype')
  valid(Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'schema keys')
}

/** Every incarnation the image references: the current manager incarnation
 * plus every operation origin. @param {any} state @returns {Set<string>} */
export function referencedIncarnations(state) {
  /** @type {Set<string>} */
  const ids = new Set()
  if (id(state?.managerIncarnation)) ids.add(state.managerIncarnation)
  for (const operation of state?.operations ?? []) ids.add(operation.origin.managerIncarnation)
  return ids
}

/** The lossless seed for an image that predates the registry: one null-identity
 * entry per referenced incarnation. @param {any} state @returns {IncarnationEntry[]} */
export function seedIncarnations(state) {
  return [...referencedIncarnations(state)].map(incarnation => ({ incarnation, process: null }))
}

/**
 * The exact registry a transition to (or within) v6 must carry: every entry of
 * the previous registry (or the lossless null seed for a pre-v6 image)
 * identically, plus at most one new entry — for the CURRENT manager
 * incarnation — which is taken from `after` and so may carry the process
 * identity of the manager that is committing. Any other registry (reordered,
 * rewritten, backfilled identities, extra entries) is rejected.
 * @param {any} before @param {any} after @returns {IncarnationEntry[]}
 */
export function expectedRegistry(before, after) {
  const seeded = before.version === 6 ? before.incarnations : seedIncarnations(before)
  const known = new Set(seeded.map(/** @param {IncarnationEntry} entry */ entry => entry.incarnation))
  /** @type {IncarnationEntry[]} */
  const registry = [...seeded]
  if (id(after.managerIncarnation) && !known.has(after.managerIncarnation)) {
    const entry = (after.incarnations ?? []).find(/** @param {IncarnationEntry} candidate */ candidate => candidate.incarnation === after.managerIncarnation)
    if (entry) registry.push(entry)
  }
  return registry
}

/**
 * The only version transition an ordinary (non-administrative) record may
 * perform: the v6 registry upgrade. The image gains the exact expected
 * registry and an admin ledger (empty when the pre-v6 image had none);
 * everything else is covered by the ordinary transition validators.
 * @param {any} before @param {any} after @returns {boolean}
 */
export function isRegistryUpgrade(before, after) {
  if (!(after?.version === 6 && (before?.version === 4 || before?.version === 5))) return false
  // The committing incarnation must be covered: a registry that drops it is
  // never the upgrade (coverage is also enforced by validateIncarnations).
  if (id(after.managerIncarnation) && !(after.incarnations ?? []).some(entry => entry.incarnation === after.managerIncarnation)) return false
  return canonical(after.incarnations) === canonical(expectedRegistry(before, after)) &&
    canonical(after.adminRecoveries ?? []) === canonical(before.adminRecoveries ?? [])
}

/**
 * Register the committing manager's incarnation in the durable image. No-op
 * when no process identity is supplied (the registry exists only for images
 * written by identity-aware managers) or when the incarnation is already
 * registered (entries are immutable). Otherwise upgrades the image to v6:
 * null seeds for every pre-existing incarnation (including the previous
 * manager incarnation, which the new state no longer references) plus one
 * entry carrying this process identity.
 * @param {any} state @param {string} incarnation @param {ProcessIdentity|null} process
 * @param {string|null} [previousIncarnation] @returns {any}
 */
export function withIncarnation(state, incarnation, process, previousIncarnation = null) {
  if (!process) return state
  if ((state.incarnations ?? []).some(/** @param {IncarnationEntry} entry */ entry => entry.incarnation === incarnation)) return state
  const referenced = referencedIncarnations(state)
  if (id(previousIncarnation)) referenced.add(previousIncarnation)
  referenced.delete(incarnation)
  const base = state.version === 6
    ? state.incarnations
    : [...referenced].map(incarnation => ({ incarnation, process: null }))
  return { ...state, version: 6, adminRecoveries: state.adminRecoveries ?? [], incarnations: [...base, { incarnation, process }] }
}

/** The recorded process identity of one incarnation, or null (no identity or
 * no entry): null is never eligible for automatic settlement.
 * @param {any} state @param {string} incarnation @returns {ProcessIdentity|null} */
export function incarnationProcess(state, incarnation) {
  const entry = (state.incarnations ?? []).find(/** @param {IncarnationEntry} candidate */ candidate => candidate.incarnation === incarnation)
  return entry?.process ?? null
}

/**
 * The durable registry invariant for a v6 image: exact entry shapes, unique
 * incarnations, valid process identities, and coverage of every incarnation
 * the image references. Called from validateImage; throws on any deviation.
 * @param {any} state
 */
export function validateIncarnations(state) {
  valid(Array.isArray(state.incarnations), 'registry')
  const known = new Set()
  for (const entry of state.incarnations) {
    shape(entry, ['incarnation', 'process'])
    valid(id(entry.incarnation) && !known.has(entry.incarnation), 'entry')
    known.add(entry.incarnation)
    if (entry.process === null) continue
    shape(entry.process, ['pid', 'host', 'osStart', 'bootNonce'])
    const process = /** @type {Record<string, any>} */ (entry.process)
    valid(Number.isSafeInteger(process.pid) && process.pid > 0, 'pid')
    valid(id(process.host) && id(process.bootNonce), 'identity')
    valid(process.osStart === null || typeof process.osStart === 'string', 'start time')
  }
  for (const incarnation of referencedIncarnations(state)) valid(known.has(incarnation), 'coverage')
}
