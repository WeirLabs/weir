// Focused pure-guard tests for the real cross-workspace headless matrix.
//
// The matrix driver (spikes/decision/headless-cross-workspace.mjs) judges the
// recorded wire and the authoritative SQLite dump with the guards exported from
// the scenario module. Those guards must be able to FAIL: every test below pairs
// an accepted input with a rejected variant, so a guard that silently returns
// "no problem" can never let a red matrix pass.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PHASES, PUBLIC_ALIAS, attemptDualPinProblems, entryErrorCode, entryValue, leakFindings,
  publicCandidateProblems, publicRefreshProblems, publicZoneProblems, selectorRowProblems,
  stepsFor, wireAuthorizationProblems, wireLeakProblems, wireRecord,
} from '../src/scenarios/decision-cross-workspace.js'

const WORKSPACE_ONE = '/tmp/xws-fixture/ws/w1'
const WORKSPACE_TWO = '/tmp/xws-fixture/ws/w2'
const ALIAS = 'origin_0123456789ab'
const HASH = 'a'.repeat(64)

function candidate(overrides = {}) {
  return {
    agentId: 'ag_fixture', zone: 'public', learningRunId: 'lr_fixture', outcome: 'candidate', runRevision: 1,
    startedAt: 1,
    candidate: { snapshotId: 'ms_fixture', version: 1, state: 'draft', revision: 1, contentHash: HASH, principleCount: 1, parentSnapshotId: null, createdAt: 1 },
    currentPublished: null,
    changes: [{ op: 'add', principleId: 'pr_fixture', text: 'Prefer the documented option.', scope: {} }],
    principles: [{ principleId: 'pr_fixture', text: 'Prefer the documented option.', scope: {}, state: 'active', sourceCount: 2 }],
    sources: [{ alias: ALIAS, count: 2, kinds: { case: 2, correction: 0 }, preview: 'Answer question: documented option', readableInCurrentWorkspace: true }],
    workspaceCount: 1, sourceCount: 2,
    replay: { passed: true, metrics: {} },
    disclosure: { required: false, version: 1, key: 'public-memory-first-extraction' },
    ...overrides,
  }
}

// The guards consume the probe wire entry shape: { result: { ok, value|error } }.
function ok(value) {
  return { result: { ok: true, value } }
}

function failed(code) {
  return { result: { ok: false, error: { code } } }
}

function attempt(overrides = {}) {
  return {
    pins: { memorySnapshotId: 'ms_private', publicMemorySnapshotId: 'ms_public', publicMemorySnapshotRevision: 2, publicMemorySnapshotHash: HASH },
    packManifest: {
      layerSizes: {}, evidenceIds: ['ev_local'], correctionIds: [], omissions: [],
      memory: {
        L2: { schemaVersion: 1, zone: 'workspace', status: 'populated', snapshotId: 'ms_private', principleIds: ['pr_private'], items: [{ principleId: 'pr_private', evidenceIds: ['ev_local'], sources: ['dc_private'] }] },
        publicL2: { schemaVersion: 1, zone: 'public', status: 'populated', snapshotId: 'ms_public', principleIds: ['pr_public'], items: [{ principleId: 'pr_public', evidenceIds: [], sources: [ALIAS] }] },
      },
    },
    ...overrides,
  }
}

describe('leakFindings', () => {
  it('accepts clean public projections', () => {
    assert.deepEqual(leakFindings({ alias: ALIAS, preview: 'Answer question: documented option', count: 2 }), [])
  })

  it('reports an absolute workspace path, a foreign record id and a raw body', () => {
    const findings = leakFindings({ text: `see ${WORKSPACE_ONE} and dc_0123456789abcdef and Question x: secret body` },
      { paths: [WORKSPACE_ONE], recordIds: ['dc_0123456789abcdef'], texts: [{ label: 'w1', text: 'Question x: secret body' }] })
    const codes = findings.map(finding => finding.code).sort()
    assert.deepEqual(codes, ['ABSOLUTE_PATH', 'FOREIGN_RECORD_ID', 'RAW_BODY', 'WORKSPACE_PATH'])
  })

  it('detects a home-relative path without a configured workspace list', () => {
    assert.equal(leakFindings('cache at ~/.dsh/x').some(finding => finding.code === 'ABSOLUTE_PATH'), true)
  })
})

describe('publicRefreshProblems', () => {
  it('accepts a disclosure-gated first open and a draft candidate summary', () => {
    const gated = ok({ status: 'disclosure-required', agentId: 'ag_fixture', zone: 'public', disclosure: { required: true, key: 'public-memory-first-extraction', version: 1 }, candidate: null, current: null })
    const draft = ok({ status: 'candidate', agentId: 'ag_fixture', zone: 'public', disclosure: { required: false, key: 'public-memory-first-extraction', version: 1 }, current: null, candidate: { learningRunId: 'lr_fixture', snapshotId: 'ms_fixture', version: 1, state: 'draft', revision: 1, contentHash: HASH, principleCount: 1, workspaceCount: 2, sourceCount: 2, createdAt: 1 } })
    assert.deepEqual(publicRefreshProblems(gated), [])
    assert.deepEqual(publicRefreshProblems(draft), [])
  })

  it('rejects a disclosure response that already carries a candidate or a current version', () => {
    const problems = publicRefreshProblems(ok({ status: 'disclosure-required', zone: 'public', disclosure: { required: true, key: 'k' }, candidate: { snapshotId: 'ms_x' }, current: { snapshotId: 'ms_y', version: 1 } }))
    assert.ok(problems.some(problem => problem.includes('candidate')))
    assert.ok(problems.some(problem => problem.includes('current')))
  })

  it('rejects an auto-published candidate and a leaked path', () => {
    const problems = publicRefreshProblems(ok({ status: 'candidate', zone: 'public', disclosure: { required: false, key: 'k' }, current: { snapshotId: 'ms_x', version: 1 }, candidate: { learningRunId: 'lr_x', snapshotId: 'ms_y', version: 1, state: 'published', revision: 1, contentHash: HASH, principleCount: 1, workspaceCount: 1, sourceCount: 1 } }))
    assert.ok(problems.some(problem => problem.includes('draft')))
  })

  it('reports a failed RPC as a problem instead of accepting it', () => {
    assert.deepEqual(publicRefreshProblems(failed('DECISION_OFF')), ['the public refresh call failed: DECISION_OFF'])
  })
})

describe('publicCandidateProblems', () => {
  it('accepts the redacted review projection', () => {
    assert.deepEqual(publicCandidateProblems(ok(candidate()), { paths: [WORKSPACE_ONE, WORKSPACE_TWO], recordIds: ['dc_0123456789abcdef'] }), [])
  })

  it('rejects a non-opaque alias, an over-long preview and a mismatched count', () => {
    const value = candidate({ sources: [
      { alias: 'w1', count: 3, kinds: { case: 2, correction: 0 }, preview: 'x'.repeat(241), readableInCurrentWorkspace: true },
    ] })
    const problems = publicCandidateProblems(ok(value))
    assert.ok(problems.some(problem => problem.startsWith('alias w1')))
    assert.ok(problems.some(problem => problem.startsWith('preview bound')))
    assert.ok(problems.some(problem => problem.startsWith('kinds')))
  })

  it('rejects a public principle that carries Evidence Refs, a path, a foreign id or a raw body', () => {
    const value = candidate()
    value.principles = [{ principleId: 'pr_fixture', text: `Use ${WORKSPACE_ONE} dc_0123456789abcdef`, scope: {}, state: 'active', sourceCount: 1, evidenceIds: ['ev_foreign'] }]
    value.sources = [{ alias: ALIAS, count: 1, kinds: { case: 1, correction: 0 }, preview: 'Question z: raw foreign body', readableInCurrentWorkspace: false }]
    const problems = publicCandidateProblems(ok(value), { paths: [WORKSPACE_ONE], recordIds: ['dc_0123456789abcdef'], texts: [{ label: 'w2', text: 'Question z: raw foreign body' }] })
    assert.ok(problems.includes('a public principle must not carry Evidence Refs'))
    assert.ok(problems.some(problem => problem.startsWith('WORKSPACE_PATH')))
    assert.ok(problems.some(problem => problem.startsWith('FOREIGN_RECORD_ID')))
    assert.ok(problems.some(problem => problem.startsWith('RAW_BODY')))
  })

  it('rejects a review whose structural replay failed', () => {
    assert.ok(publicCandidateProblems(ok(candidate({ replay: { passed: false, metrics: {} } }))).includes('the structural replay must pass before review'))
  })
})

describe('publicZoneProblems', () => {
  const snapshot = (overrides = {}) => ({ snapshot_id: 'ms_x', version: 1, zone: 'public', namespace_workspace_key: null, ...overrides })

  it('accepts independent per-namespace version sequences', () => {
    assert.deepEqual(publicZoneProblems({
      learning_runs: [
        { learning_run_id: 'lr_p', zone: 'public', namespace_workspace_key: null },
        { learning_run_id: 'lr_w1', zone: 'workspace', namespace_workspace_key: WORKSPACE_ONE },
        { learning_run_id: 'lr_w2', zone: 'workspace', namespace_workspace_key: WORKSPACE_TWO },
      ],
      memory_snapshots: [
        snapshot(),
        snapshot({ snapshot_id: 'ms_w1', zone: 'workspace', namespace_workspace_key: WORKSPACE_ONE }),
        snapshot({ snapshot_id: 'ms_w2', zone: 'workspace', namespace_workspace_key: WORKSPACE_TWO }),
      ],
    }), [])
  })

  it('rejects a public row with a workspace namespace and a private row without one', () => {
    const problems = publicZoneProblems({
      learning_runs: [{ learning_run_id: 'lr_x', zone: 'public', namespace_workspace_key: WORKSPACE_ONE }],
      memory_snapshots: [snapshot({ snapshot_id: 'ms_y', zone: 'workspace', namespace_workspace_key: null })],
    })
    assert.ok(problems.some(problem => problem.includes('public row carries a workspace namespace')))
    assert.ok(problems.some(problem => problem.includes('private row has no workspace namespace')))
  })

  it('rejects a duplicate version inside one namespace but accepts the same version across workspaces', () => {
    assert.ok(publicZoneProblems({ learning_runs: [], memory_snapshots: [snapshot(), snapshot({ snapshot_id: 'ms_z' })] })
      .some(problem => problem.includes('duplicated')))
    assert.deepEqual(publicZoneProblems({
      learning_runs: [],
      memory_snapshots: [
        snapshot({ snapshot_id: 'ms_a', zone: 'workspace', namespace_workspace_key: WORKSPACE_ONE }),
        snapshot({ snapshot_id: 'ms_b', zone: 'workspace', namespace_workspace_key: WORKSPACE_TWO }),
      ],
    }), [])
  })
})

describe('attemptDualPinProblems', () => {
  it('accepts both explicit pins and the two manifest zones', () => {
    assert.deepEqual(attemptDualPinProblems(attempt()), [])
  })

  it('rejects a pinned attempt with no explicit public pin', () => {
    const broken = attempt({ pins: { memorySnapshotId: 'ms_private' } })
    assert.ok(attemptDualPinProblems(broken).includes('publicMemorySnapshotId pin is missing'))
  })

  it('rejects a manifest that loses a zone or maps a public source as evidence', () => {
    const broken = attempt()
    broken.packManifest.memory.publicL2.zone = 'workspace'
    broken.packManifest.memory.publicL2.items[0].evidenceIds = ['ev_from_guidance']
    broken.packManifest.evidenceIds = ['ev_local', ALIAS]
    const problems = attemptDualPinProblems(broken)
    assert.ok(problems.includes('manifest memory.publicL2 must be the public zone'))
    assert.ok(problems.includes('a publicL2 item carries Evidence Refs'))
    assert.ok(problems.includes('a public source alias entered the evidence mapping'))
  })

  it('rejects a public source that is not an opaque alias', () => {
    const broken = attempt()
    broken.packManifest.memory.publicL2.items[0].sources = ['/tmp/xws-fixture/ws/w1']
    assert.ok(attemptDualPinProblems(broken).some(problem => problem.includes('is not an opaque alias')))
  })
})

describe('selectorRowProblems', () => {
  it('accepts auto and agent rows', () => {
    assert.deepEqual(selectorRowProblems({ root_session_id: 'rs_1', mode: 'auto', agent_id: null }), [])
    assert.deepEqual(selectorRowProblems({ root_session_id: 'rs_1', mode: 'agent', agent_id: 'ag_1' }), [])
  })

  it('rejects an auto row that carries an agent and an unknown mode', () => {
    assert.ok(selectorRowProblems({ root_session_id: 'rs_1', mode: 'auto', agent_id: 'ag_1' }).includes('auto/off selectors carry no agent_id'))
    assert.ok(selectorRowProblems({ root_session_id: 'rs_1', mode: 'sometimes', agent_id: null }).some(problem => problem.startsWith('mode')))
    assert.ok(selectorRowProblems(null).length > 0)
  })
})

describe('wireAuthorizationProblems', () => {
  const db = {
    agent_profiles: [{ agent_id: 'ag_1' }],
    cases: [{ case_id: 'dc_1' }],
    attempts: [{ attempt_id: 'da_1' }],
    memory_snapshots: [{ snapshot_id: 'ms_1' }],
    learning_runs: [{ learning_run_id: 'lr_1' }],
    selectors: [{ root_session_id: 'rs_1' }],
    evidence: [{ evidence_id: 'ev_1' }],
    feedback: [{ feedback_id: 'fb_1' }],
  }

  it('accepts a wire that only names database records', () => {
    const wire = { 'p:candidate': { result: { ok: true, value: { candidate: { snapshotId: 'ms_1', learningRunId: 'lr_1' }, agentId: 'ag_1' } } } }
    assert.deepEqual(wireAuthorizationProblems(wire, db), [])
  })

  it('rejects an invented record and respects the per-boot include filter', () => {
    const wire = {
      'p:candidate': { result: { ok: true, value: { candidate: { snapshotId: 'ms_invented', learningRunId: 'lr_1' } } } },
      'q:candidate': { result: { ok: true, value: { candidate: { snapshotId: 'ms_invented' } } } },
    }
    const problems = wireAuthorizationProblems(wire, db, label => label.startsWith('p:'))
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ms_invented is not authorized/)
  })
})

describe('wireLeakProblems and wireRecord', () => {
  it('accepts clean wire entries and rejects a path, a foreign id or a raw body', () => {
    const clean = { 'p:state': { result: { ok: true, value: { publicMemory: { current: { snapshotId: 'ms_1' } } } } } }
    assert.deepEqual(wireLeakProblems(clean, { paths: [WORKSPACE_ONE] }), [])
    const dirty = { 'p:state': { result: { ok: true, value: { workspace: WORKSPACE_ONE, caseId: 'dc_foreign' } } } }
    const problems = wireLeakProblems(dirty, { paths: [WORKSPACE_ONE], texts: [{ label: 'w1', text: 'Question x: body' }] })
    assert.ok(problems.some(problem => problem.includes('WORKSPACE_PATH')))
    const withBody = { 'p:ask': { result: { ok: true, value: { echo: 'Question x: body' } } } }
    assert.ok(wireLeakProblems(withBody, { texts: [{ label: 'w1', text: 'Question x: body' }] }).some(problem => problem.includes('RAW_BODY')))
  })

  it('returns the recorded model wire of one kind', () => {
    const records = [{ xwsWire: { kind: 'router-route' } }, { xwsWire: { kind: 'evaluator', pack: {} } }]
    assert.deepEqual(wireRecord(records, 'evaluator'), { kind: 'evaluator', pack: {} })
    assert.equal(wireRecord(records, 'public-consolidation'), null)
  })

  it('unwraps remote results and their error codes', () => {
    assert.deepEqual(entryValue({ result: { ok: true, value: { a: 1 } } }), { a: 1 })
    assert.equal(entryValue({ result: { ok: false, error: { code: 'OUT_OF_SCOPE' } } }), undefined)
    assert.equal(entryErrorCode({ result: { ok: false, error: { code: 'STALE_SOURCE' } } }), 'STALE_SOURCE')
    assert.equal(entryErrorCode({ result: { ok: true, value: 1 } }), null)
  })
})

describe('phase and gesture script invariants', () => {
  it('boots every workspace, starts W1/W2 with fresh root sessions and resumes only earlier phases', () => {
    const fresh = new Set()
    for (const spec of PHASES) {
      assert.ok(['W1', 'W2', 'W3'].includes(spec.workspace), spec.phase)
      if (spec.session === 'new') fresh.add(spec.phase)
      else assert.ok(fresh.has(spec.session), `${spec.phase} resumes a phase that was never booted fresh`)
    }
    assert.deepEqual([...fresh].sort(), ['w1-seed', 'w1-auto', 'w2-auto', 'w2-identity', 'w3-guidance'].sort())
    assert.equal(new Set(PHASES.map(spec => spec.phase)).size, PHASES.length)
    assert.ok(PHASES.some(spec => spec.phase === 'w1-restart' && spec.session === 'w1-seed'))
  })

  it('gives every phase a phase-prefixed, unique gesture script', () => {
    assert.equal(stepsFor('nope').length, 0)
    for (const spec of PHASES) {
      const steps = stepsFor(spec.phase)
      assert.ok(steps.length > 0, spec.phase)
      const labels = steps.map(step => step.label)
      assert.equal(new Set(labels).size, labels.length, `${spec.phase} has duplicate labels`)
      for (const label of labels) assert.ok(label.startsWith(`${spec.phase}:`), label)
      for (const step of steps) {
        if (step.kind === 'learning') assert.equal(step.args.action === undefined, false, `${step.label} needs an action`)
        if (step.kind === 'ask') assert.match(step.question.id, /^decision-xws-/)
        if (step.kind === 'consult') assert.match(step.args.request_id, /^xws-/)
      }
    }
  })

  it('keeps the public alias grammar private to opaque origin aliases', () => {
    assert.equal(PUBLIC_ALIAS.test(ALIAS), true)
    assert.equal(PUBLIC_ALIAS.test('origin_0123456789ABCD'), false)
    assert.equal(PUBLIC_ALIAS.test(WORKSPACE_ONE), false)
  })
})
