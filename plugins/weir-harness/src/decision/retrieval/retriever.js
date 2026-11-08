// Broker-internal, synchronous and read-only retrieval for exactly one Attempt.
import { readL2Memory, readL3Memory } from './memory.js'

export class DecisionContextRetriever {
  /** @param {import('../store/db.js').DecisionDatabase} store @param {import('../store/evidence.js').DecisionEvidence} evidence */
  constructor(store, evidence) {
    this.store = store
    this.evidence = evidence
  }

  /**
   * There is deliberately no cross-Agent or cross-workspace query shape. L5
   * conflict and freshness metadata are captured from the full eligible set,
   * before the pure context pack can trim anything.
   * @param {{agentId:string,workspaceKey:string,scope:object,attemptStartedAt:number,excludeCaseId?:string}} input
   */
  retrieve(input) {
    const L5 = this.evidence.candidates(input)
    const conflictPairs = this.evidence.conflictPairs(L5)
    const currentObservationHashes = Object.fromEntries(
      L5.filter(ref => ref.source === 'current_observation').map(ref => [ref.evidenceId, ref.hash]),
    )
    const L2 = readL2Memory(this.store, input, L5)
    const L3 = readL3Memory(this.store, input)
    return deepFreeze({ schemaVersion: 1, L2, L3, L5, conflictPairs, currentObservationHashes })
  }
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}
