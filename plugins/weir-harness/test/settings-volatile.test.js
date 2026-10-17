import test from 'node:test'
import assert from 'node:assert/strict'
import { createVolatile, updateVolatile } from '../src/vendor/cosmokit.js'
import { configValue, flattenConfig } from '../src/settings/volatile.js'

// Focused unit pin for src/settings/volatile.js (change test-surface-pinning,
// task 4.1), previously zero direct test imports: the single consumer-edge
// adapter over the vendored volatile-ref protocol (S16). Refs are genuine
// vendored refs (createVolatile/updateVolatile), not lookalikes.

test('configValue dereferences a volatile ref live, not once', () => {
  const ref = createVolatile({ limit: 4 })
  assert.deepEqual(configValue(ref), { limit: 4 })
  // The owning runtime rewrites the ref; the adapter reads the CURRENT value.
  updateVolatile(ref, createVolatile({ limit: 8 }))
  assert.deepEqual(configValue(ref), { limit: 8 })
})

test('configValue passes plain values through by identity', () => {
  const plain = { nested: [1, 2] }
  assert.equal(configValue(plain), plain)
  assert.equal(configValue(42), 42)
  assert.equal(configValue('s'), 's')
  assert.equal(configValue(null), null)
  assert.equal(configValue(undefined), undefined)
  assert.equal(configValue(false), false)
})

test('flattenConfig unwraps refs, keeps falsy-but-set values, and drops the unset', () => {
  const retention = createVolatile(30)
  const config = {
    retention,
    plain: 'value',
    zero: 0,
    off: false,
    empty: '',
    unset: undefined,
    unsetRef: createVolatile(undefined),
    nestedPlain: { a: createVolatile('inner') },
  }
  const flat = flattenConfig(config)
  assert.equal(flat.retention, 30)
  assert.equal(flat.plain, 'value')
  assert.equal(flat.zero, 0)
  assert.equal(flat.off, false)
  assert.equal(flat.empty, '')
  // "Absent means absent" is restored: undefined-valued entries are dropped,
  // whether plain or materialized as a ref.
  assert.equal('unset' in flat, false)
  assert.equal('unsetRef' in flat, false)
  assert.deepEqual(Object.keys(flat).sort(), ['empty', 'nestedPlain', 'off', 'plain', 'retention', 'zero'])
  // Flattening is shallow at the entry edge: a ref nested inside a plain
  // object value stays a ref (the schema layer owns per-field materialization).
  assert.notDeepEqual(flat.nestedPlain, { a: 'inner' })
  assert.equal(flat.nestedPlain.a, config.nestedPlain.a)
  // A later runtime update is visible through the same flattened read path.
  updateVolatile(retention, createVolatile(undefined))
  assert.equal('retention' in flattenConfig(config), false)
})

test('flattenConfig tolerates nullish and empty configs', () => {
  assert.deepEqual(flattenConfig(undefined), {})
  assert.deepEqual(flattenConfig(null), {})
  assert.deepEqual(flattenConfig({}), {})
})
