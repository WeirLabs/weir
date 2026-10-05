// Group 10 of the session-capability-manager change: distribution manifest
// provenance, builtin protection, same-name rules, the pinned executor
// baseline and the isolated execution layer.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { manifestEntryOf, changeVerdict, isBuiltinTarget, isValidBuiltinDefinition } from '../src/capabilities/distribution-manifest.js'
import { sameNameListing, installTargetFor, refSatisfiedBy } from '../src/capabilities/same-name-policy.js'
import { EXECUTOR_PIN, EXEC_LIMITS, pinVerdict, installArgv, isolatedEnv, spawnOptionsFor, runDiagnostics } from '../src/capabilities/isolated-exec.js'

test('10.1 full provenance travels; unestablished values report unknown, never inferred', () => {
  const full = manifestEntryOf({ repository: 'org/skills', sourceKind: 'git', requestedRef: 'v1', subpath: 'tools/x', installLocation: '/skills/x', contentIdentity: 'sha256:abc', state: 'ok' })
  expect(full).toEqual({ repository: 'org/skills', sourceKind: 'git', requestedRef: 'v1', subpath: 'tools/x', installLocation: '/skills/x', contentIdentity: 'sha256:abc', state: 'ok' })
  const bare = manifestEntryOf({})
  expect(bare.repository).toBe('unknown')
  expect(bare.contentIdentity).toBeNull()
  expect(bare.state).toBe('unknown')
  // Unavailable, conflicting and locally-modified entries stay listed with their state.
  for (const state of ['unavailable', 'name-conflict', 'locally-modified']) {
    expect(manifestEntryOf({ repository: 'org/s', sourceKind: 'git', requestedRef: 'v1', installLocation: '/s', state }).state).toBe(state)
  }
})

test('10.1 a missing identity is never claimed as unchanged', () => {
  expect(changeVerdict(manifestEntryOf({ repository: 'a', sourceKind: 'git', requestedRef: 'v', installLocation: '/a' }), 'sha256:x')).toBe('unknown')
  expect(changeVerdict(manifestEntryOf({ repository: 'a', sourceKind: 'git', requestedRef: 'v', installLocation: '/a', contentIdentity: 'sha256:x' }), null)).toBe('unknown')
  expect(changeVerdict(manifestEntryOf({ repository: 'a', sourceKind: 'git', requestedRef: 'v', installLocation: '/a', contentIdentity: 'sha256:x' }), 'sha256:x')).toBe('unchanged')
  expect(changeVerdict(manifestEntryOf({ repository: 'a', sourceKind: 'git', requestedRef: 'v', installLocation: '/a', contentIdentity: 'sha256:x' }), 'sha256:y')).toBe('changed')
})

test('10.2 the builtin root refuses distribution targets; third-party same-name is never a builtin definition', () => {
  expect(isBuiltinTarget('/bundle/skills/debugging', '/bundle/skills')).toBe(true)
  expect(isBuiltinTarget('/bundle/skills-x/y', '/bundle/skills')).toBe(false)
  expect(isBuiltinTarget('/other/skills/debugging', '/bundle/skills')).toBe(false)
  expect(isValidBuiltinDefinition({ scope: 'orrery-builtin' })).toBe(true)
  expect(isValidBuiltinDefinition({ scope: 'project' })).toBe(false)
  expect(isValidBuiltinDefinition({ scope: 'custom' })).toBe(false)
})

test('10.3 the same-name listing is informational only, precedence reported never authorized', () => {
  const listing = sameNameListing([
    { name: 'x', scope: 'user', rank: 400 },
    { name: 'x', scope: 'project', rank: 100 },
    { name: 'x', scope: 'custom', rank: 300, provenance: { from: 'test' } },
  ])
  expect(listing.map(e => e.scope)).toEqual(['project', 'custom', 'user'])
  expect(listing[1].provenance).toEqual({ from: 'test' })
})

test('10.3 installing into an occupied name writes only after an explicit decision', () => {
  expect(installTargetFor({ name: 'x', occupied: true })).toEqual({ write: false, target: null, status: 'cancelled' })
  expect(installTargetFor({ name: 'x', occupied: true, decision: 'replace' })).toEqual({ write: true, target: 'x', status: 'replace-confirmed' })
  expect(installTargetFor({ name: 'x', occupied: true, decision: 'coexist', targetName: 'x-fork' })).toEqual({ write: true, target: 'x-fork', status: 'coexist-distinct' })
  expect(installTargetFor({ name: 'x', occupied: true, decision: 'coexist' }).write).toBe(false)
  expect(installTargetFor({ name: 'x', occupied: false })).toEqual({ write: true, target: 'x', status: 'write' })
})

test('10.3 a missing ref is never satisfied by a same-named entry', () => {
  const keyOf = identity => identity.key
  expect(refSatisfiedBy({ name: 'x', identity: { key: 'a' } }, { name: 'x', identity: { key: 'a' } }, keyOf)).toBe(true)
  expect(refSatisfiedBy({ name: 'x', identity: { key: 'a' } }, { name: 'x', identity: { key: 'b' } }, keyOf)).toBe(false)
  expect(refSatisfiedBy({ name: 'x' }, { name: 'x', identity: { key: 'a' } }, keyOf)).toBe(false)
})

test('10.4 the executor pin constants and the deviation verdict', () => {
  expect(EXECUTOR_PIN).toEqual({ repository: 'vercel-labs/skills', version: '1.7.0', commit: '3694740352eeef5cdd689af694c485f1ff62eec3' })
  expect(pinVerdict({ version: '1.7.0', commit: EXECUTOR_PIN.commit })).toEqual({ run: true, revision: EXECUTOR_PIN.commit, deviation: null })
  const deviated = pinVerdict({ version: '1.8.0', commit: 'abc' })
  expect(deviated.run).toBe(false)
  expect(deviated.deviation).toContain('refused')
  expect(deviated.deviation).toContain('compatibility test')
})

test('10.5 argv passes paths and refs verbatim; env isolates the invocation', () => {
  const argv = installArgv({ repository: 'https://example.com/team skills.git', skill: 'my skill' })
  expect(argv).toEqual(['skills', 'add', 'https://example.com/team skills.git', '--skill', 'my skill', '--agent', 'universal', '--no-interactive'])
  expect(argv).not.toContain('-y')
  const env = isolatedEnv({ stagingHome: '/stage' })
  expect(env.HOME).toBe('/stage')
  expect(env.SKILLS_TELEMETRY).toBe('0')
  expect(env.GIT_HOOKS_PATH).toBe('/dev/null')
  const options = spawnOptionsFor({ stagingHome: '/stage' })
  expect(options.shell).toBe(false)
  expect(options.cwd).toBe('/stage')
  expect(options.timeout).toBe(EXEC_LIMITS.timeoutMs)
  expect(options.maxBuffer).toBe(EXEC_LIMITS.maxOutputBytes)
})

test('10.5 run diagnostics report the revision and redact secrets', () => {
  const diagnostics = runDiagnostics({ revision: EXECUTOR_PIN.commit, argv: ['skills', 'add', 'x'], code: 1, stdout: 'token=abc123 done', stderr: 'boom' })
  expect(diagnostics.revision).toBe(EXECUTOR_PIN.commit)
  expect(diagnostics.stdout).toContain('token=<redacted>')
  expect(diagnostics.stdout).not.toContain('abc123')
  const timedOut = runDiagnostics({ revision: 'r', argv: [], code: null, stdout: '', stderr: '', timedOut: true, overOutput: true })
  expect(timedOut.timedOut).toBe(true)
  expect(timedOut.overOutput).toBe(true)
})
