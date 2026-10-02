import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalRequestData } from '../src/edit-lock/request-data.js'

test('canonical request data preserves exact JSON values and ignores key insertion order', () => {
  assert.equal(canonicalRequestData({ z: ['\r\n', null, true], a: 'é' }), canonicalRequestData({ a: 'é', z: ['\r\n', null, true] }))
  assert.notEqual(canonicalRequestData({}), canonicalRequestData({ a: null }))
  assert.notEqual(canonicalRequestData(['a', 'b']), canonicalRequestData(['b', 'a']))
})

test('rejects lossy data and accessors without invoking getters', () => {
  let calls = 0
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; return 1 } })
  const sparse = []; sparse.length = 1
  const decorated = [1]; decorated.extra = true
  const cyclic = {}; cyclic.self = cyclic
  for (const value of [undefined, NaN, Infinity, -0, 1n, () => {}, Symbol(), new Date(), new Map(), accessor,
    { hidden: undefined }, Object.create({ inherited: true }), { [Symbol()]: 1 }, sparse, decorated, cyclic]) {
    assert.throws(() => canonicalRequestData(value), /request data/)
  }
  assert.equal(calls, 0)
})
