import test from 'node:test'
import assert from 'node:assert/strict'

// Entry-contract pin (change test-surface-pinning, tasks 5.1/5.2): the package
// root entries "." and "./index.js" map to lib/index.js — the deliberate
// no-op host half that exists so the ui-weir-settings Loader row can mount
// the package host-side. Its contract: mountable shape (an `apply` function),
// zero side effects, and both subpaths converging on the same module. Imported
// through the package entries on purpose — a broken exports mapping fails here.
const root = await import('weir-harness')
const indexPath = await import('weir-harness/index.js')

test('the package root host half is a mountable no-op plugin', () => {
  assert.deepEqual(Object.keys(root), ['apply'])
  assert.equal(typeof root.apply, 'function')
  assert.equal(root.apply(), undefined)
  // "." and "./index.js" are the same module instance.
  assert.equal(root.apply, indexPath.apply)
})
