// Shared bounds and scope validation for manual learning storage and replay.
import { assertClosedObject, DecisionContractError } from '../contracts.js'

export const LEARNING_LIMITS = Object.freeze({ cases: 128, feedback: 256, principles: 128, operations: 64 })

/** @param {unknown} value @param {string} label */
export function validateLearningScope(value, label = 'Principle.scope') {
  const scope = assertClosedObject(value, ['workspaces', 'paths', 'tags', 'authorizationClasses'], ['workspaces'], label)
  if (!Array.isArray(scope.workspaces) || scope.workspaces.length !== 1 || typeof scope.workspaces[0] !== 'string' || !scope.workspaces[0]) {
    throw new DecisionContractError('INVALID_PRINCIPLE', `${label} must contain exactly one workspace`)
  }
  for (const key of ['paths', 'tags']) {
    const entries = scope[key]
    if (entries !== undefined && (!Array.isArray(entries) || entries.length > 64
      || entries.some(entry => typeof entry !== 'string' || !entry || entry.length > 200)
      || new Set(entries).size !== entries.length)) {
      throw new DecisionContractError('INVALID_PRINCIPLE', `${label}.${key} must be a bounded unique string array`)
    }
  }
  if (scope.authorizationClasses !== undefined && (!Array.isArray(scope.authorizationClasses)
    || scope.authorizationClasses.some(entry => !['A', 'B', 'C'].includes(entry)))) {
    throw new DecisionContractError('INVALID_PRINCIPLE', `${label}.authorizationClasses must contain only A/B/C`)
  }
  return scope
}
