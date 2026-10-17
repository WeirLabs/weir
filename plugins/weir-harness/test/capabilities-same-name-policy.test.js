import test from 'node:test'
import assert from 'node:assert/strict'
import { installTargetFor } from '../src/capabilities/same-name-policy.js'

// Focused unit pin for src/capabilities/same-name-policy.js (change
// test-surface-pinning, task 6.1), previously zero direct test imports.
// installTargetFor's write/replace/cancel statuses are also covered
// indirectly (preset-package.test.js via preset-package-install.js); this
// file pins that decision surface directly.

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
