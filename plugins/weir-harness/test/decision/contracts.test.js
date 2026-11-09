import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTEMPT_FAILURES, ATTEMPT_OUTCOMES, AWAITING_REASONS, CASE_CLOSINGS, CASE_STATES,
  EVIDENCE_SOURCES, EVIDENCE_STATUSES, FEEDBACK_KINDS, OMISSION_CODES, RETURN_CODES, ROUTE_MODES,
  ROUTE_FAILURE_REASONS, ROUTE_REASON_CODES, ROUTER_CLASSIFICATION_CONTRACT, ROUTER_CONTRACT,
  SELECTOR_MODES, DecisionContractError, assertClosedObject, assertEnum, canonicalJson, parseAnswerBatch,
} from '../../src/decision/contracts.js'

describe('decision contract enums', () => {
  const groups = [
    ['return code', RETURN_CODES, 'MISSING_CONTEXT'],
    ['attempt outcome', ATTEMPT_OUTCOMES, 'answer'],
    ['case state', CASE_STATES, 'received'],
    ['case closing', CASE_CLOSINGS, 'answered'],
    ['awaiting reason', AWAITING_REASONS, 'no_route'],
    ['feedback kind', FEEDBACK_KINDS, 'rating_down'],
    ['evidence source', EVIDENCE_SOURCES, 'user_decision'],
    ['evidence status', EVIDENCE_STATUSES, 'active'],
    ['route mode', ROUTE_MODES, 'pinned'],
    ['omission', OMISSION_CODES, 'L4_TRUNCATED'],
    ['attempt failure', ATTEMPT_FAILURES, 'invalid_output'],
  ]
  for (const [label, allowed, valid] of groups) {
    it(`accepts ${label} members and rejects unknown values`, () => {
      assert.equal(assertEnum(valid, allowed, label), valid)
      assert.throws(() => assertEnum('not-in-contract', allowed, label), (error) => {
        assert.ok(error instanceof DecisionContractError)
        assert.equal(error.code, 'INVALID_ENUM')
        return true
      })
    })
  }

  it('extends route and selector modes without changing the original members', () => {
    assert.deepEqual([...ROUTE_MODES], ['pinned', 'explicit', 'manual_reassign', 'none', 'auto_shadow', 'auto'])
    assert.deepEqual([...SELECTOR_MODES], ['off', 'agent', 'auto'])
    for (const mode of ['pinned', 'explicit', 'manual_reassign', 'none', 'auto_shadow', 'auto']) {
      assert.equal(assertEnum(mode, ROUTE_MODES, 'route mode'), mode)
    }
    assert.throws(() => assertEnum('automatic', ROUTE_MODES, 'route mode'), /INVALID_ENUM/)
  })

  it('versions both router sidecars and closes their stable reason vocabulary', () => {
    assert.equal(ROUTER_CLASSIFICATION_CONTRACT, 'router-classification-contract/1')
    assert.equal(ROUTER_CONTRACT, 'router-contract/1')
    assert.deepEqual([...ROUTE_FAILURE_REASONS], [
      'failure:timeout', 'failure:model_error', 'failure:invalid_output', 'failure:truncated',
      'failure:aborted', 'failure:route_unavailable', 'failure:candidate_limit', 'failure:context_budget',
    ])
    assert.deepEqual([...ROUTE_REASON_CODES], [
      'none:no_candidates', 'admission:authority', 'deterministic:single_candidate',
    ])
    for (const vocabulary of [ROUTE_MODES, SELECTOR_MODES, ROUTE_FAILURE_REASONS, ROUTE_REASON_CODES]) {
      assert.equal(Object.isFrozen(vocabulary), true)
    }
  })
})

describe('canonical JSON', () => {
  it('sorts object keys recursively while preserving array order', () => {
    const left = canonicalJson({ z: 1, nested: { b: 2, a: [3, 1] } })
    const right = canonicalJson({ nested: { a: [3, 1], b: 2 }, z: 1 })
    assert.equal(left, right)
    assert.equal(left, '{"nested":{"a":[3,1],"b":2},"z":1}')
  })

  it('changes the digest input when a meaningful byte changes', () => {
    assert.notEqual(canonicalJson({ evidence: ['a'] }), canonicalJson({ evidence: ['b'] }))
  })

  it('rejects non-JSON and non-finite values', () => {
    assert.throws(() => canonicalJson({ bad: 1n }), /NON_JSON_VALUE/)
    assert.throws(() => canonicalJson({ bad: Infinity }), /NON_FINITE_NUMBER/)
  })
})

describe('closed objects and answer batches', () => {
  it('rejects unknown and missing fields', () => {
    assert.throws(() => assertClosedObject({ extra: true }, [], [], 'case'), /UNKNOWN_FIELD/)
    assert.throws(() => assertClosedObject({}, ['id'], ['id'], 'case'), /MISSING_FIELD/)
  })

  it('parses valid answers and rejects malformed selections', () => {
    assert.deepEqual(parseAnswerBatch({ answers: [{ id: 'q', selected: ['A'] }] }), [
      { id: 'q', selected: ['A'] },
    ])
    assert.throws(() => parseAnswerBatch({ answers: [{ id: 'q', selected: 'A' }] }), /INVALID_ANSWER/)
  })
})
