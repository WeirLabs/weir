// Minimal vitest-style facade over node:test + node:assert/strict so tests read
// in the familiar style without pulling in native-bound tooling.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe as nodeDescribe, it as nodeIt, test as nodeTest } from 'node:test'

export const describe = nodeDescribe
export const it = nodeIt
export const test = nodeTest


// Host-contract guards for tests exercising the Weir capability store's
// SUPPORTED platform row. The store's platform matrix (C-1.10; documented in
// docs/features/session-capability-manager.md) enables writes only on darwin —
// every other platform fails closed with an explicit `unsupported` status by
// design, never a delete-then-copy fallback. Two consequences for tests:
//
// 1. Store factories that accept an explicit `platform` option (the store
//    itself, lifecycle snapshots) pin the supported row: `platform: 'darwin'`
//    — the same convention as capability-store.test.js, so those tests keep
//    their full assertion strength on any host (including the ubuntu runner).
//
// 2. The /capabilities command handler opens the store from the host
//    `profileContext` with NO platform seam. Tests exercising its
//    store-backed verbs (receipt / list / apply / mcp-add / preset-* /
//    default-*) cannot meet their contract on a non-darwin host — the product
//    itself declines the store there. They skip with a documented reason, the
//    same host-contract pattern as the DSH-runtime skip in
//    worktree-pkgmgr.test.js.
export const storePlatformSupported = process.platform === 'darwin'
export const storePlatformSkip = storePlatformSupported
  ? false
  : 'Weir capability store writes are darwin-only by the C-1.10 platform matrix; this test exercises the store-backed path'

const PINNED_HOST_ENV = ['HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'DSH_BUNDLED_SKILL_DIR']

/**
 * Pin the host-dependent roots the skill-selection provider consults to fresh
 * mkdtemp directories for the duration of one test:
 *
 * - DSH_AGENTS_HOME / homedir().agents (the user-global agents root),
 * - HOME / DSH_HOME (user-global dsh roots),
 * - DSH_BUNDLED_SKILL_DIR (host bundled skills — pinned OFF).
 *
 * The plugin config additionally pins agentsHome/dshHome explicitly; this env
 * pinning keeps the test hermetic even against env-reading paths that have no
 * config seam, and against the simulated-CI shape where DSH_AGENTS_HOME is
 * EMPTY (a host state the provider rejects instead of silently re-deriving).
 * @returns {{ home: string, agentsHome: string, restore: () => void }}
 */
export function pinHermeticHostRoots() {
  const home = mkdtempSync(join(tmpdir(), 'weir-test-home-'))
  const agentsHome = mkdtempSync(join(tmpdir(), 'weir-test-agents-'))
  const previous = Object.fromEntries(PINNED_HOST_ENV.map(name => [name, process.env[name]]))
  process.env.HOME = home
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = agentsHome
  delete process.env.DSH_BUNDLED_SKILL_DIR
  return {
    home,
    agentsHome,
    restore: () => {
      for (const name of PINNED_HOST_ENV) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
    },
  }
}
export function expect(actual, message) {
  const api = {
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
  api.not = {
    toBe: (expected) => assert.notStrictEqual(actual, expected, message),
    toEqual: (expected) => assert.notDeepStrictEqual(actual, expected, message),
    toContain: (expected) => assert.ok(!actual.includes(expected), message ?? `expected ${String(actual)} not to contain ${String(expected)}`),
    toHaveLength: (expected) => assert.notStrictEqual(actual.length, expected, message),
    toBeUndefined: () => assert.notStrictEqual(actual, undefined, message),
    toBeNull: () => assert.notStrictEqual(actual, null, message),
  }
  api.rejects = {
    toThrow: async (pattern) => {
      await assert.rejects(
        typeof actual === 'function' ? actual : async () => { throw actual },
        pattern instanceof RegExp ? pattern : pattern === undefined ? undefined : new RegExp(String(pattern)),
      )
    },
  }
  api.resolves = {
    toBe: async (expected) => assert.strictEqual(await actual, expected, message),
    toEqual: async (expected) => assert.deepStrictEqual(await actual, expected, message),
  }
  return api
}
