// Shared bounds and scope validation for manual learning storage and replay.
//
// Private principles keep exactly one owning workspace. Public principles are
// workspace-agnostic on purpose: the zone is the scope identity, so only the
// optional paths/tags hints may appear.
import { assertClosedObject, DecisionContractError } from '../contracts.js'
import { MEMORY_ZONES, PRIVATE_ZONE, PUBLIC_ZONE } from './namespace.js'

export const LEARNING_LIMITS = Object.freeze({ cases: 128, feedback: 256, principles: 128, operations: 64 })

const PRIVATE_SCOPE_FIELDS = Object.freeze(['workspaces', 'paths', 'tags'])
const PUBLIC_SCOPE_FIELDS = Object.freeze(['paths', 'tags'])

/**
 * @param {unknown} value
 * @param {string} [label]
 * @param {'workspace'|'public'} [zone]
 */
export function validateLearningScope(value, label = 'Principle.scope', zone = PRIVATE_ZONE) {
  if (!MEMORY_ZONES.includes(zone)) throw new DecisionContractError('INVALID_NAMESPACE', String(zone))
  const legacyFree = withoutLegacyClasses(value)
  if (zone === PUBLIC_ZONE) {
    const publicScope = assertClosedObject(legacyFree, PUBLIC_SCOPE_FIELDS, [], label)
    validateHints(publicScope, label)
    return publicScope
  }
  const scope = assertClosedObject(legacyFree, PRIVATE_SCOPE_FIELDS, ['workspaces'], label)
  if (!Array.isArray(scope.workspaces) || scope.workspaces.length !== 1 || typeof scope.workspaces[0] !== 'string' || !scope.workspaces[0]) {
    throw new DecisionContractError('INVALID_PRINCIPLE', `${label} must contain exactly one workspace`)
  }
  validateHints(scope, label)
  return scope
}

/**
 * A/B/C authorization classes are inert legacy data: a stored principle that
 * still carries them must stay readable, so the field is dropped on the way in
 * instead of being rejected (and it is never written back out).
 * @param {unknown} value
 */
function withoutLegacyClasses(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { authorizationClasses: _legacy, ...rest } = /** @type {Record<string, unknown>} */ (value)
  return rest
}

/** @param {Record<string, unknown>} scope @param {string} label */
function validateHints(scope, label) {
  for (const key of ['paths', 'tags']) {
    const entries = scope[key]
    if (entries !== undefined && (!Array.isArray(entries) || entries.length > 64
      || entries.some(entry => typeof entry !== 'string' || !entry || entry.length > 200)
      || new Set(entries).size !== entries.length)) {
      throw new DecisionContractError('INVALID_PRINCIPLE', `${label}.${key} must be a bounded unique string array`)
    }
  }
}

