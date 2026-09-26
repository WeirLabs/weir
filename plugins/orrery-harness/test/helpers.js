// Minimal vitest-style facade over node:test + node:assert/strict so tests read
// in the familiar style without pulling in native-bound tooling.
import assert from 'node:assert/strict'
import { describe as nodeDescribe, it as nodeIt, test as nodeTest } from 'node:test'

export const describe = nodeDescribe
export const it = nodeIt
export const test = nodeTest

export function expect(actual, message) {
  return {
    toBe: (expected) => assert.strictEqual(actual, expected, message),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected, message),
    toContain: (expected) => assert.ok(actual.includes(expected), message ?? `expected ${String(actual)} to contain ${String(expected)}`),
    toHaveLength: (expected) => assert.strictEqual(actual.length, expected, message),
    toBeTruthy: () => assert.ok(actual, message),
    toBeFalsy: () => assert.ok(!actual, message),
    toBeUndefined: () => assert.strictEqual(actual, undefined, message),
    toBeNull: () => assert.strictEqual(actual, null, message),
    toBeGreaterThan: (expected) => assert.ok(actual > expected, message ?? `expected ${actual} > ${expected}`),
    toBeGreaterThanOrEqual: (expected) => assert.ok(actual >= expected, message ?? `expected ${actual} >= ${expected}`),
    toMatch: (pattern) => assert.match(actual, pattern, message),
    toThrow: (pattern) => assert.throws(typeof actual === 'function' ? actual : () => { throw actual }, pattern),
    toBeInstanceOf: (expected) => assert.ok(actual instanceof expected, message),
  }
}
