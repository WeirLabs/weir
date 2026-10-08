// Group 11 of the session-capability-manager change: publish-target and
// reference validation, scope roots, preconditions, check lifecycle, manual
// and automatic update gates, and content pins with GC.
import { test, expect } from './helpers.js'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveScopeRoots, referenceProblem, validateTargetInsideRoot, lockVerdict, publishPrecondition, generationRecordOf } from '../src/capabilities/publisher.js'
import { createCheckScheduler, checkOutcomeOf, manualUpdatePostconditions, autoUpdateVerdict, CHECK_CADENCE_MS } from '../src/capabilities/update-lifecycle.js'
import { contentPinOf, snapshotVerdict, pinSelfSufficient, refreshVerdict, localChangeOutcome, gcVerdict } from '../src/capabilities/content-pin.js'

test('11.2 the root table maps staging output to DSH-recognized roots and refuses bundled targets', () => {
  const table = resolveScopeRoots({ agentsHome: '/agents', workspaceRoot: '/ws', bundledRoot: '/bundle' })
  expect(table.rootFor('global')).toEqual({ allowed: true, root: join('/agents', 'skills') })
  expect(table.rootFor('workspace')).toEqual({ allowed: true, root: join('/ws', '.agents', 'skills') })
  expect(table.rootFor('bundled').allowed).toBe(false)
  expect(table.rootFor('bundled').reason).toContain('not publish targets')
})

test('11.1 references: absolute, traversal and credential-carrying are refused', () => {
  expect(referenceProblem('skills/deploy')).toBeNull()
  expect(referenceProblem('/abs/path')).toContain('absolute')
  expect(referenceProblem('skills/../escape')).toContain('traversal')
  expect(referenceProblem('git@x:y.git?token=abc')).toContain('credential')
})

test('11.1 a symlink escaping the scope root is refused and named; inside passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'pub-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'pub-out-'))
  mkdirSync(join(root, 'skills'), { recursive: true })
  const link = join(root, 'skills', 'linked')
  symlinkSync(outside, link)
  const verdict = validateTargetInsideRoot(root, link)
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('escapes the scope root')
  mkdirSync(join(root, 'skills', 'real'), { recursive: true })
  expect(validateTargetInsideRoot(root, join(root, 'skills', 'real')).ok).toBe(true)
})

test('11.1 an unrecognized lock schema stops without migrating or deleting', () => {
  expect(lockVerdict({ schemaVersion: 1 }).recognized).toBe(true)
  expect(lockVerdict({ schemaVersion: 99 }).reason).toContain('unrecognized install-lock schema')
  expect(lockVerdict(null).recognized).toBe(false)
})

test('11.2 the precondition re-check catches a moved active generation and local divergence', () => {
  expect(publishPrecondition({ activeGeneration: 'g1', expectedActive: 'g1', localDigest: 'd', managedDigest: 'd' }).ok).toBe(true)
  expect(publishPrecondition({ activeGeneration: 'g2', expectedActive: 'g1', localDigest: 'd', managedDigest: 'd' }).reason).toContain('moved')
  expect(publishPrecondition({ activeGeneration: 'g1', expectedActive: 'g1', localDigest: 'x', managedDigest: 'd' }).reason).toContain('diverged')
})

test('11.2 a generation record is content-addressed with provenance and receipt', () => {
  const record = generationRecordOf({ identity: 'x', files: { 'SKILL.md': 'a' }, provenance: { from: 'test' }, receipt: { requestId: 'r1' } })
  expect(record.identity).toBe('x')
  expect(record.manifest['SKILL.md']).toHaveLength(64)
  expect(record.provenance).toEqual({ from: 'test' })
  expect(record.receipt).toEqual({ requestId: 'r1' })
})

test('11.3 the check scheduler: cadence, manual joins in-flight, backoff, and outcome classification', () => {
  let now = 0
  const scheduler = createCheckScheduler({ now: () => now })
  expect(scheduler.requestCheck('scheduled').start).toBe(true)
  // Manual joins the in-flight check instead of starting a second one.
  expect(scheduler.requestCheck('manual')).toEqual({ start: false, joinedInFlight: true, reason: null })
  scheduler.settle(false)
  now = CHECK_CADENCE_MS - 1
  expect(scheduler.requestCheck('scheduled').reason).toBe('not-due')
  now = CHECK_CADENCE_MS * 2
  expect(scheduler.requestCheck('scheduled').start).toBe(true)
  scheduler.settle(true)
  now = CHECK_CADENCE_MS * 2 + CHECK_CADENCE_MS - 1
  expect(scheduler.requestCheck('scheduled').reason).toBe('not-due')
  expect(checkOutcomeOf('offline')).toBe('offline')
  expect(checkOutcomeOf('private-source')).toBe('private-source')
  expect(checkOutcomeOf('garbage')).toBe('unknown')
})

test('11.4 every manual-update post-condition must hold before the swap', () => {
  expect(manualUpdatePostconditions({ requestedSatisfied: true, identityAtLocation: true, contentIdentityRecorded: true, lockRecognized: true }).ok).toBe(true)
  const verdict = manualUpdatePostconditions({ requestedSatisfied: true, identityAtLocation: false, contentIdentityRecorded: false, lockRecognized: true })
  expect(verdict.ok).toBe(false)
  expect(verdict.failures).toHaveLength(2)
})

test('11.5 automatic updates are off by default and every gate pauses its entry', () => {
  expect(autoUpdateVerdict({ optedIn: false }).reason).toContain('off')
  const allOk = autoUpdateVerdict({ optedIn: true, toolBaselineOk: true, layoutOk: true, lockRecognized: true, provenanceUnchanged: true, noLocalEdits: true })
  expect(allOk.run).toBe(true)
  const gated = autoUpdateVerdict({ optedIn: true, toolBaselineOk: true, layoutOk: true, lockRecognized: true, provenanceUnchanged: false, noLocalEdits: true })
  expect(gated.run).toBe(false)
  expect(gated.reason).toContain('paused')
})

test('11.6 pins: consistent snapshot required, full pin survives origin removal, refresh is CAS-guarded', () => {
  expect(snapshotVerdict('a', 'a').ok).toBe(true)
  expect(snapshotVerdict('a', 'b').ok).toBe(false)
  const pin = contentPinOf({ identity: { name: 'x' }, body: 'body', manifest: { 'SKILL.md': 'd' } })
  expect(pinSelfSufficient(pin)).toBe(true)
  expect(pinSelfSufficient({ body: 'body' })).toBe(false)
  expect(refreshVerdict({ expectedRevision: 2, currentRevision: 2 })).toEqual({ refresh: true })
  expect(refreshVerdict({ expectedRevision: 1, currentRevision: 2 }).refresh).toBe(false)
})

test('11.6 local-change decisions are reported and GC respects reference counts and anomalies', () => {
  expect(localChangeOutcome('overwrite').publish).toBe(true)
  expect(localChangeOutcome('leave-unchanged').publish).toBe(false)
  expect(localChangeOutcome('leave-unchanged').report).toContain('skipped')
  expect(gcVerdict({ liveSessions: 1 }).collect).toBe(false)
  expect(gcVerdict({}).collect).toBe(true)
  expect(gcVerdict({ anomaly: true }).reason).toContain('conservatively')
})
