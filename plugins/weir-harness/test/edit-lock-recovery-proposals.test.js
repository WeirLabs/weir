// Server-computed recovery proposals (openspec edit-lock-recovery-proposals,
// D1/D2): the host derives the online-recovery surface from the SAME parsed
// authority image the inspection summarizes — eligibility by the host's own
// disposition rules, the confirmation by the SAME function the manager
// re-verifies at commit time, unmet entries carrying stable reason CODES in
// the manager's refusal order. The proposal is a read-time suggestion, never
// an authorization: these tests also pin that an unchanged submission is
// accepted, a stale one refused, and the computation mutates nothing.
import { it, describe } from './helpers.js'
import { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { recoveryProposals } from '../src/edit-lock/inspect.js'
import { recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { LATE_WRITER_RISK } from '../src/edit-lock/admin-ledger.js'
import { canonical } from '../src/edit-lock/snapshot.js'

const roots = []
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

const REASON_CODES = ['disposition-recorded', 'owner-unknown', 'not-interrupted', 'prepared-outstanding', 'publishing-outstanding', 'no-unresolved']

/** One operation row in the image shape the parser produces. */
function op(sessionId, operationId, phase, fence) {
  return {
    sessionId, operationId,
    origin: { executionEpoch: 1, managerIncarnation: 'm' },
    binding: { tool: 'write', filePath: fence?.resourceId ?? fence?.ancestor ?? '/r/x' },
    phase,
    outcome: phase === 'unknown' ? { kind: 'unknown' } : null,
    fence,
  }
}

describe('recoveryProposals (host-derived, schemaVersion 1)', () => {
  it('classifies candidates, blocked rows and unmet reason codes from the parsed image', () => {
    const state = {
      version: 4,
      managerIncarnation: 'm',
      sessions: [
        { sessionId: 'a', executionEpoch: 1, interrupted: true },
        { sessionId: 'b', executionEpoch: 1, interrupted: false },
        { sessionId: 'c', executionEpoch: 1, interrupted: true },
        { sessionId: 'd', executionEpoch: 1, interrupted: true },
        { sessionId: 'e', executionEpoch: 1, interrupted: true },
        { sessionId: 'f', executionEpoch: 1, interrupted: true },
        { sessionId: 'x', executionEpoch: 1, interrupted: true },
      ],
      generations: [],
      locks: [
        { resourceId: '/r/a.txt', owner: 'a', generation: 3, status: 'user-interrupted' },
        { resourceId: '/r/b.txt', owner: 'a', generation: 1, status: 'user-interrupted' },
        { resourceId: '/r/c.txt', owner: 'b', generation: 1, status: 'user-interrupted' },
        { resourceId: '/r/d.txt', owner: 'c', generation: 1, status: 'user-interrupted' },
        { resourceId: '/r/e.txt', owner: 'd', generation: 1, status: 'user-interrupted' },
        { resourceId: '/r/g.txt', owner: 'e', generation: 1, status: 'user-interrupted' },
        { resourceId: '/r/h.txt', owner: 'ghost', generation: 1, status: 'user-interrupted' },
        { resourceId: '/r/i.txt', owner: 'x', generation: 1, status: 'user-interrupted' },
      ],
      issuedRequests: [],
      recovery: [],
      holds: [],
      operations: [
        // Eligible owner a: lock + file fence on the same resource (the incident shape).
        op('a', 'op-2', 'unknown', { kind: 'resource', resourceId: '/r/b.txt' }),
        op('a', 'op-1', 'unknown', { kind: 'resource', resourceId: '/r/a.txt' }),
        // Ineligible blocking owners, one per precondition.
        op('b', 'op-3', 'unknown', { kind: 'resource', resourceId: '/r/c.txt' }),
        op('c', 'op-4', 'publishing', { kind: 'resource', resourceId: '/r/d.txt' }),
        op('d', 'op-5', 'unknown', { kind: 'resource', resourceId: '/r/e.txt' }),
        // Eligible owner f with a subtree fence and NO file row: the candidate
        // still carries the scope (the domain detail renders its card).
        op('f', 'op-6', 'unknown', { kind: 'subtree', ancestor: '/r/sub' }),
        // e has no unresolved operation; its prepared operation below blocks it.
      ],
      // d's unknown operation is already covered by a recorded disposition.
      adminRecoveries: [{ owner: 'd', operations: [{ operationId: 'op-5' }] }],
    }
    // e blocks on a live prepared operation (never dispatched).
    state.operations.push({ sessionId: 'e', operationId: 'op-7', binding: { tool: 'write', filePath: '/r/g.txt' }, phase: 'prepared' })
    const snapshot = { revision: 7, state }
    const frozen = canonical(state)

    const proposals = recoveryProposals('/work/repo', snapshot)

    // The read changes nothing: the parsed image is byte-identical afterwards.
    assert.equal(canonical(state), frozen)
    assert.equal(proposals.schemaVersion, 1)
    assert.equal(proposals.revision, 7)
    assert.deepEqual(Object.keys(proposals).sort(), ['blocked', 'candidates', 'revision', 'schemaVersion', 'unmet'])

    // Candidates: the eligible owners (a and the row-less f), in image order.
    assert.equal(proposals.candidates.length, 2)
    assert.deepEqual(proposals.candidates.map(candidate => candidate.owner), ['a', 'f'])
    const [a, f] = proposals.candidates
    assert.deepEqual(Object.keys(a).sort(), ['confirmation', 'owner', 'risk', 'rows', 'scope'])
    assert.deepEqual(a.scope, { root: '/work/repo', owner: 'a', expectedRevision: 7, operationIds: ['op-1', 'op-2'] })
    // The confirmation is produced by the SAME function the manager re-verifies.
    assert.equal(a.confirmation, recoveryConfirmation(a.scope))
    assert.match(a.confirmation, /^ADMIN OVERRIDE [a-f0-9]{64}$/)
    assert.equal(a.risk, LATE_WRITER_RISK)
    assert.deepEqual(f.scope, { root: '/work/repo', owner: 'f', expectedRevision: 7, operationIds: ['op-6'] })
    assert.equal(f.confirmation, recoveryConfirmation(f.scope))
    assert.deepEqual(f.rows, [])

    // Blocked rows: only rows whose owner has the force-release action, sorted
    // by resource id, in the panel's merged lock/fence row shape.
    assert.deepEqual(proposals.blocked.map(row => row.resourceId), ['/r/a.txt', '/r/b.txt'])
    assert.deepEqual(Object.keys(proposals.blocked[0]).sort(), ['fence', 'interrupted', 'lockStatus', 'owner', 'resourceId'])
    assert.deepEqual(proposals.blocked[0], { resourceId: '/r/a.txt', owner: 'a', lockStatus: 'user-interrupted', fence: true, interrupted: true })
    assert.deepEqual(proposals.blocked[1], { resourceId: '/r/b.txt', owner: 'a', lockStatus: 'user-interrupted', fence: true, interrupted: true })
    // The candidate carries its own display rows in the same order.
    assert.deepEqual(a.rows, proposals.blocked)

    // Unmet: stable reason CODES in the manager's refusal order, sorted by owner.
    assert.deepEqual(proposals.unmet.map(entry => entry.owner), ['b', 'c', 'd', 'e', 'ghost', 'x'])
    const byOwner = new Map(proposals.unmet.map(entry => [entry.owner, entry]))
    assert.deepEqual(byOwner.get('b').reason, 'not-interrupted')
    assert.deepEqual(byOwner.get('c').reason, 'publishing-outstanding')
    assert.deepEqual(byOwner.get('d').reason, 'disposition-recorded')
    assert.deepEqual(byOwner.get('e').reason, 'prepared-outstanding')
    assert.deepEqual(byOwner.get('ghost').reason, 'owner-unknown')
    assert.deepEqual(byOwner.get('x').reason, 'no-unresolved')
    // Every emitted code belongs to the schema-1 vocabulary; prose is the
    // client's localization job, never the server's.
    for (const entry of proposals.unmet) {
      assert.ok(REASON_CODES.includes(entry.reason), `reason code ${entry.reason}`)
      assert.deepEqual(Object.keys(entry).sort(), ['owner', 'reason', 'rows', 'scopePaths'])
    }
    assert.deepEqual(byOwner.get('e').rows.map(row => row.resourceId), ['/r/g.txt'])
    assert.deepEqual(byOwner.get('e').scopePaths, [])
    assert.deepEqual(byOwner.get('x').rows.map(row => row.resourceId), ['/r/i.txt'])
    assert.deepEqual(byOwner.get('ghost').rows[0].interrupted, false) // no session: honestly not interrupted
  })

  it('marks a cross-owner file fence as a scope path, never a row of the lock owner', () => {
    const state = {
      version: 4,
      managerIncarnation: 'm',
      sessions: [
        { sessionId: 'a', executionEpoch: 1, interrupted: true },
        { sessionId: 'b', executionEpoch: 1, interrupted: false },
      ],
      generations: [],
      locks: [{ resourceId: '/r/a.txt', owner: 'a', generation: 1, status: 'user-interrupted' }],
      issuedRequests: [],
      recovery: [],
      holds: [],
      // b's fence covers the file a locks: a's row stays a's, b gets the scope path.
      operations: [op('b', 'op-1', 'unknown', { kind: 'resource', resourceId: '/r/a.txt' })],
    }
    const proposals = recoveryProposals('/work/repo', { revision: 3, state })
    assert.deepEqual(proposals.candidates, [])
    assert.deepEqual(proposals.blocked, [])
    assert.equal(proposals.unmet.length, 1)
    assert.equal(proposals.unmet[0].owner, 'b')
    assert.equal(proposals.unmet[0].reason, 'not-interrupted')
    assert.deepEqual(proposals.unmet[0].rows, [])
    assert.deepEqual(proposals.unmet[0].scopePaths, ['/r/a.txt'])
  })

  it('offers no candidate while any unresolved operation is publishing, prepared or dispositioned', () => {
    const base = {
      version: 4, managerIncarnation: 'm', generations: [], locks: [], issuedRequests: [], recovery: [], holds: [],
      sessions: [{ sessionId: 's', executionEpoch: 1, interrupted: true }],
    }
    const withOps = (operations, adminRecoveries = []) => recoveryProposals('/r', { revision: 1, state: { ...base, operations, adminRecoveries } })
    // publishing among the unresolved: not stable unknown history.
    assert.equal(withOps([op('s', 'o1', 'unknown', { kind: 'resource', resourceId: '/r/1' }), op('s', 'o2', 'publishing', { kind: 'resource', resourceId: '/r/2' })]).candidates.length, 0)
    // a live prepared operation: the manager refuses, so no action is offered.
    assert.equal(withOps([op('s', 'o1', 'unknown', { kind: 'resource', resourceId: '/r/1' }), { sessionId: 's', operationId: 'o2', phase: 'prepared' }]).candidates.length, 0)
    // a recorded disposition covering one unresolved operation: no longer blocked.
    assert.equal(withOps([op('s', 'o1', 'unknown', { kind: 'resource', resourceId: '/r/1' })], [{ owner: 's', operations: [{ operationId: 'o1' }] }]).candidates.length, 0)
    // not interrupted: never eligible.
    const notInterrupted = recoveryProposals('/r', { revision: 1, state: { ...base, sessions: [{ sessionId: 's', executionEpoch: 1, interrupted: false }], operations: [op('s', 'o1', 'unknown', { kind: 'resource', resourceId: '/r/1' })] } })
    assert.equal(notInterrupted.candidates.length, 0)
    // the fully eligible shape: exactly one candidate with the sorted id set.
    const eligible = withOps([op('s', 'o2', 'unknown', { kind: 'resource', resourceId: '/r/2' }), op('s', 'o1', 'unknown', { kind: 'resource', resourceId: '/r/1' })])
    assert.equal(eligible.candidates.length, 1)
    assert.deepEqual(eligible.candidates[0].scope.operationIds, ['o1', 'o2'])
  })

  it('a candidate submits unchanged into adminRecoverOnline; a stale proposal is refused at commit', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'weir-proposals-')))
    roots.push(root)
    const directory = join(root, '.weir', 'edit-lock')
    await mkdir(directory, { recursive: true })
    const target = join(root, 'a.txt')
    await writeFile(target, 'original')
    const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
    const writeBackup = async (file, bytes) => { await writeFile(join(directory, file), bytes) }
    const manager = createEditLockManager({ store, managerIncarnation: 'm', root, writeBackup })
    try {
      const owner = await manager.openSession('owner')
      const token = await manager.acquire(owner, target)
      const ready = await manager.prepare(owner, {
        operationId: 'op-unknown', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
        effectivePolicy: { mode: 'workspace-write' },
        target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
      }, { validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target })
      await assert.rejects(manager.commit(ready.submission), /unknown writer outcome/)
      await manager.cancel(owner)

      const proposals = recoveryProposals(root, store.snapshot())
      assert.equal(proposals.schemaVersion, 1)
      assert.equal(proposals.revision, store.snapshot().revision)
      assert.equal(proposals.candidates.length, 1)
      const candidate = proposals.candidates[0]
      assert.equal(candidate.owner, 'owner')
      assert.deepEqual(candidate.scope, { root, owner: 'owner', expectedRevision: proposals.revision, operationIds: ['op-unknown'] })
      assert.equal(candidate.confirmation, recoveryConfirmation(candidate.scope))
      assert.equal(candidate.risk, LATE_WRITER_RISK)
      assert.deepEqual(candidate.rows, [{ resourceId: target, owner: 'owner', lockStatus: 'user-interrupted', fence: true, interrupted: true }])
      assert.deepEqual(proposals.blocked, candidate.rows)
      assert.deepEqual(proposals.unmet, [])

      // The revision moves after the proposal was issued: the unchanged
      // submission meets the manager's existing revision conflict — the
      // proposal granted no authority by itself.
      await manager.openSession('third')
      const stale = {
        owner: candidate.owner, expectedRevision: candidate.scope.expectedRevision, operationIds: candidate.scope.operationIds,
        recoveryId: 'proposal-stale', reason: 'stale probe', acceptLateWriterRisk: true, confirmation: candidate.confirmation,
      }
      await assert.rejects(manager.adminRecoverOnline(stale), error => error.code === 'weir-edit-lock/revision-conflict')
      assert.equal(store.snapshot().state.adminRecoveries ?? [].length, 0)

      // A fresh proposal over the moved revision submits unchanged and is accepted.
      const fresh = recoveryProposals(root, store.snapshot())
      assert.equal(fresh.revision, store.snapshot().revision)
      assert.equal(fresh.candidates.length, 1)
      const input = {
        owner: fresh.candidates[0].owner, expectedRevision: fresh.candidates[0].scope.expectedRevision,
        operationIds: fresh.candidates[0].scope.operationIds, recoveryId: 'proposal-accepted',
        reason: 'The operator reviewed the displayed scope and accepted the displayed late-writer risk.',
        acceptLateWriterRisk: true, confirmation: fresh.candidates[0].confirmation,
      }
      const result = await manager.adminRecoverOnline(input)
      assert.equal(result.idempotent, false)
      // Settled: no candidate, no blocked row, no unmet entry for the owner.
      const settled = recoveryProposals(root, store.snapshot())
      assert.deepEqual(settled.candidates, [])
      assert.deepEqual(settled.blocked, [])
      assert.deepEqual(settled.unmet, [])
    } finally {
      await manager.close().catch(() => {})
      await store.close().catch(() => {})
    }
  })
})
