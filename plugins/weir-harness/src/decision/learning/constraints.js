// Shared bounds and scope validation for manual learning storage and replay.
//
// Private principles keep exactly one owning workspace. Public principles are
// workspace-agnostic on purpose: the zone is the scope identity, so only the
// optional paths/tags hints and authorization classes may appear.
import { assertClosedObject, DecisionContractError } from '../contracts.js'
import { MEMORY_ZONES, PRIVATE_ZONE, PUBLIC_ZONE } from './namespace.js'

export const LEARNING_LIMITS = Object.freeze({ cases: 128, feedback: 256, principles: 128, operations: 64 })

const PRIVATE_SCOPE_FIELDS = Object.freeze(['workspaces', 'paths', 'tags', 'authorizationClasses'])
const PUBLIC_SCOPE_FIELDS = Object.freeze(['paths', 'tags', 'authorizationClasses'])

/**
 * @param {unknown} value
 * @param {string} [label]
 * @param {'workspace'|'public'} [zone]
 */
export function validateLearningScope(value, label = 'Principle.scope', zone = PRIVATE_ZONE) {
  if (!MEMORY_ZONES.includes(zone)) throw new DecisionContractError('INVALID_NAMESPACE', String(zone))
  if (zone === PUBLIC_ZONE) {
    const publicScope = assertClosedObject(value, PUBLIC_SCOPE_FIELDS, [], label)
    validateHints(publicScope, label)
    validateClasses(publicScope, label)
    return publicScope
  }
  const scope = assertClosedObject(value, PRIVATE_SCOPE_FIELDS, ['workspaces'], label)
  if (!Array.isArray(scope.workspaces) || scope.workspaces.length !== 1 || typeof scope.workspaces[0] !== 'string' || !scope.workspaces[0]) {
    throw new DecisionContractError('INVALID_PRINCIPLE', `${label} must contain exactly one workspace`)
  }
  validateHints(scope, label)
  validateClasses(scope, label)
  return scope
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

/** @param {Record<string, unknown>} scope @param {string} label */
function validateClasses(scope, label) {
  if (scope.authorizationClasses !== undefined && (!Array.isArray(scope.authorizationClasses)
    || scope.authorizationClasses.some(entry => !['A', 'B', 'C'].includes(entry)))) {
    throw new DecisionContractError('INVALID_PRINCIPLE', `${label}.authorizationClasses must contain only A/B/C`)
  }
}
