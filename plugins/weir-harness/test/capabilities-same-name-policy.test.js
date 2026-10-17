import test from 'node:test'
import assert from 'node:assert/strict'
import { installTargetFor, refSatisfiedBy, sameNameListing } from '../src/capabilities/same-name-policy.js'

// Focused unit pin for src/capabilities/same-name-policy.js (change
// test-surface-pinning, task 6.1), previously zero direct test imports.
// installTargetFor's write/replace/cancel statuses are also covered
// indirectly (preset-package.test.js via preset-package-install.js); this
// file pins the whole seam directly — sameNameListing and refSatisfiedBy
// currently have NO src consumer, so no indirect evidence can exist for them.

test('sameNameListing reports precedence informationally, never as authorization', () => {
  const entries = [
    { name: 'tool', scope: 'project', rank: 2, provenance: { kind: 'install' } },
    { name: 'tool', scope: 'user', rank: 1 },
    null,
    { rank: 0 }, // no name: not an entry
    { name: 'tool' }, // no scope, no rank
  ]
  assert.deepEqual(sameNameListing(entries), [
    { name: 'tool', scope: 'user', provenance: null, precedence: 1 },
    { name: 'tool', scope: 'project', provenance: { kind: 'install' }, precedence: 2 },
    { name: 'tool', scope: 'unknown', provenance: null, precedence: null },
  ])
  // Rankless entries sort last; scope breaks precedence ties.
  const tied = sameNameListing([
    { name: 'a', scope: 'user', rank: 5 },
    { name: 'a', scope: 'project', rank: 5 },
  ])
  assert.deepEqual(tied.map((entry) => entry.scope), ['project', 'user'])
})

test('installTargetFor defaults to CANCEL: nothing writes without an explicit decision', () => {
  assert.deepEqual(installTargetFor({ name: 'skill', occupied: false }), { write: true, target: 'skill', status: 'write' })
  assert.deepEqual(installTargetFor({ name: 'skill', occupied: true }), { write: false, target: null, status: 'cancelled' })
  assert.deepEqual(installTargetFor({ name: 'skill', occupied: true, decision: 'cancel' }), { write: false, target: null, status: 'cancelled' })
  assert.deepEqual(installTargetFor({ name: 'skill', occupied: true, decision: 'replace' }), { write: true, target: 'skill', status: 'replace-confirmed' })
})

test('installTargetFor coexist writes only to a genuinely distinct name', () => {
  assert.deepEqual(installTargetFor({ name: 'skill', occupied: true, decision: 'coexist', targetName: 'skill-2' }),
    { write: true, target: 'skill-2', status: 'coexist-distinct' })
  for (const targetName of ['skill', '', undefined]) {
    assert.deepEqual(installTargetFor({ name: 'skill', occupied: true, decision: 'coexist', targetName }),
      { write: false, target: null, status: 'coexist-needs-distinct-name' })
  }
})

test('refSatisfiedBy matches by identity, never by display name', () => {
  const keyOf = (/** @type {any} */ identity) => `${identity.scope}:${identity.id}`
  const wanted = { name: 'tool', identity: { scope: 'project', id: 'x' } }
  assert.equal(refSatisfiedBy(wanted, { name: 'tool', identity: { scope: 'project', id: 'x' } }, keyOf), true)
  // Same display name, different identity: unresolved.
  assert.equal(refSatisfiedBy(wanted, { name: 'tool', identity: { scope: 'user', id: 'x' } }, keyOf), false)
  // An identity-less ref is never satisfied, by a same-named entry or otherwise.
  assert.equal(refSatisfiedBy({ name: 'tool' }, { name: 'tool', identity: { scope: 'project', id: 'x' } }, keyOf), false)
  assert.equal(refSatisfiedBy(wanted, { name: 'tool' }, keyOf), false)
  // A throwing key function fails closed.
  assert.equal(refSatisfiedBy(wanted, wanted, () => { throw new Error('bad identity') }), false)
})
