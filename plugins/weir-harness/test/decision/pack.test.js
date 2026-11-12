import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextPack } from '../../src/decision/evaluator/pack.js'
import { OMISSION_CODES } from '../../src/decision/contracts.js'

const profile = {
  revision: 7,
  scope: { workspaces: ['/repo'], paths: ['src'], authorizationClasses: ['A', 'B'] },
  userDescription: { revision: 3, text: 'PROFILE-UNIQUE: prefer concise copy.' },
  generatedDescription: { revision: 0, text: '' },
}
const request = {
  entry: 'hook',
  questions: [{ id: 'q', question: 'Which title?', options: [{ label: 'A' }, { label: 'B' }] }],
  context: 'Current task',
}
const refs = [
  { evidenceId: 'ev_user', source: 'user_decision', locator: { kind: 'case', caseId: 'dc_old' }, excerpt: 'User chose A', scope: { workspaces: ['/repo'] }, status: 'active', createdAt: 20 },
  { evidenceId: 'ev_correction', source: 'user_correction', locator: { kind: 'feedback', feedbackId: 'fb_new' }, excerpt: 'Use B', scope: { workspaces: ['/repo'] }, status: 'active', createdAt: 30 },
  { evidenceId: 'ev_profile', source: 'user_profile', locator: { kind: 'profile', descriptionKind: 'user', revision: 3 }, excerpt: 'PROFILE-UNIQUE must not repeat', scope: { workspaces: ['/repo'] }, status: 'active', createdAt: 10 },
]

function pack(overrides = {}) {
  return buildContextPack({ profile, request, evidence: refs, modelRoute: { kind: 'inherited' }, budgetTokens: 24000, ...overrides })
}

function findPack(predicate, input = {}) {
  for (let budgetTokens = 800; budgetTokens <= 6000; budgetTokens += 5) {
    const value = pack({ budgetTokens, ...input })
    if (predicate(value)) return value
  }
  throw new Error('No bounded pack matched the expected omission stage')
}

test('pins, profile/correction ordering and contextPackHash are deterministic', () => {
  const value = pack()
  assert.equal(value.outcome, 'ready')
  assert.deepEqual(value.pins, {
    agentProfileRevision: 7, userDescriptionRevision: 3, generatedDescriptionRevision: 0,
    memorySnapshotId: null, memorySnapshotRevision: null, memorySnapshotHash: null,
    publicMemorySnapshotId: null, publicMemorySnapshotRevision: null, publicMemorySnapshotHash: null,
    promptVersion: 'evaluator-contract/3', evaluatorVersion: 'sidecar/1',
    modelRoute: { kind: 'inherited' }, budgetTokens: 24000,
  })
  assert.deepEqual(value.packManifest.evidenceIds, ['ev_correction', 'ev_profile', 'ev_user'])
  assert.deepEqual(value.packManifest.correctionIds, ['ev_correction'])
  assert.deepEqual(value.packManifest.layerSizes.L2, 0)
  assert.deepEqual(value.packManifest.layerSizes.L3, 0)
  const wire = `${value.system}\n${value.messages[0].content}`
  assert.equal(wire.match(/PROFILE-UNIQUE/g).length, 1)
  assert.ok(wire.includes('"descriptionKind":"user"'))
  assert.ok(!value.layers.L5.find(ref => ref.evidenceId === 'ev_profile').excerpt)
  assert.equal(value.contextPackHash, pack().contextPackHash)
  assert.notEqual(value.contextPackHash, pack({ evidence: [refs[0], refs[2], refs[1], { ...refs[0], evidenceId: 'ev_other' }] }).contextPackHash)
  assert.notEqual(value.contextPackHash, findPack(item => item.packManifest.omissions.includes('L5_EXCERPT_OMITTED')).contextPackHash)
})

test('L4 context truncates before L5 and every omission code is observable', () => {
  const truncated = pack({ request: { ...request, context: 'x'.repeat(3000) } })
  assert.equal(truncated.layers.L4.request.context.length, 2048)
  assert.ok(truncated.packManifest.omissions.includes('L4_TRUNCATED'))

  const longRefs = refs.map((ref, index) => ({ ...ref, evidenceId: `${ref.evidenceId}_${index}`, excerpt: 'evidence '.repeat(400) }))
  const excerpt = findPack(item => item.packManifest.omissions.includes('L5_EXCERPT_OMITTED') && !item.packManifest.omissions.includes('L5_EVIDENCE_OMITTED'), { evidence: longRefs, criticalEvidenceIds: [] })
  assert.ok(excerpt.layers.L5.every(ref => ref.excerpt === undefined))
  assert.ok(!excerpt.packManifest.omissions.includes('L5_EVIDENCE_OMITTED'))

  const omitted = findPack(item => item.packManifest.omissions.includes('L5_EVIDENCE_OMITTED'), { evidence: longRefs, criticalEvidenceIds: [] })
  assert.ok(omitted.packManifest.omissions.includes('L5_EVIDENCE_TRUNCATED'))
  assert.ok(omitted.layers.L5.length < longRefs.length)
})

test('critical evidence returns MISSING_CONTEXT and fixed overflow escalates without LLM', () => {
  const critical = findPack(item => item.outcome === 'return', { criticalEvidenceIds: ['ev_profile'] })
  assert.equal(critical.reasonCode, 'MISSING_CONTEXT')
  assert.match(critical.hint, /ev_profile/)
  assert.equal(critical.messages.length, 0)

  let llmCalls = 0
  const fakeLlm = { stream: () => { llmCalls++ } }
  const overflow = pack({ budgetTokens: 1 })
  assert.equal(overflow.outcome, 'escalate')
  assert.equal(overflow.messages.length, 0)
  assert.match(overflow.missing[0], /fixed L0\/L1\/L4/)
  assert.equal(llmCalls, 0)
  assert.equal(typeof fakeLlm.stream, 'function')
})

const emptyL2 = { schemaVersion: 1, status: 'empty', snapshotId: null, items: [] }
const episodes = [
  {
    schemaVersion: 1, kind: 'neutral_agent_answer', sourceCaseId: 'dc_new', sourceRevision: 4,
    scope: { workspaces: ['/repo'] }, excerpt: `Answer q: New ${'n'.repeat(500)}`, createdAt: 40, closedAt: 41,
    comment: 'COMMENT-MUST-NOT-LEAK', taskSummary: 'TASK-MUST-NOT-LEAK', sessionLog: 'SESSION-MUST-NOT-LEAK',
  },
  {
    schemaVersion: 1, kind: 'neutral_agent_answer', sourceCaseId: 'dc_old', sourceRevision: 2,
    scope: { workspaces: ['/repo'] }, excerpt: `Answer q: Old ${'o'.repeat(500)}`, createdAt: 20, closedAt: 21,
  },
]
const memory = { L2: emptyL2, L3: episodes }

test('optional memory is safely projected and default input remains the P1 empty layers', () => {
  const legacy = pack()
  const explicitEmpty = pack({ memory: { L2: emptyL2, L3: [] } })
  assert.equal(legacy.layers.L2, '')
  assert.equal(legacy.layers.L3, '')
  assert.equal(legacy.contextPackHash, explicitEmpty.contextPackHash)
  assert.deepEqual(legacy.packManifest.memory, {
    L2: {
      schemaVersion: 1, zone: 'workspace', status: 'empty', snapshotId: null, snapshotRevision: null, snapshotHash: null,
      principleIds: [], items: [], exclusions: [], layerSize: 0,
    },
    publicL2: {
      schemaVersion: 1, zone: 'public', status: 'empty', snapshotId: null, snapshotRevision: null, snapshotHash: null,
      principleIds: [], items: [], exclusions: [], layerSize: 0,
    },
    L3: { schemaVersion: 1, sourceCaseIds: [] },
  })

  const value = pack({ memory })
  const wire = `${value.system}\n${value.messages[0].content}`
  const body = JSON.parse(value.messages[0].content)
  assert.deepEqual(body.L3, value.layers.L3)
  assert.deepEqual(value.packManifest.memory.L3.sourceCaseIds, ['dc_new', 'dc_old'])
  assert.equal(value.packManifest.layerSizes.L3, JSON.stringify(value.layers.L3).length)
  assert.ok(wire.includes('neutral_agent_answer'))
  for (const secret of ['COMMENT-MUST-NOT-LEAK', 'TASK-MUST-NOT-LEAK', 'SESSION-MUST-NOT-LEAK']) assert.equal(wire.includes(secret), false)
  assert.equal(wire.includes('FULL-CASE-LIBRARY'), false)
  assert.throws(() => pack({ memory: { L2: { ...emptyL2, status: 'ready', items: [{ text: 'not supported' }] }, L3: [] } }), error => error.code === 'INVALID_MEMORY_INPUT')
  for (const code of ['L3_EPISODE_OMITTED', 'L3_EPISODE_TRUNCATED']) assert.ok(OMISSION_CODES.includes(code))
})

test('whole L3 episodes are omitted in reverse retrieval order before any L5 trimming', () => {
  const oneOmitted = findPack(item => item.packManifest.omissions.includes('L3_EPISODE_OMITTED') && Array.isArray(item.layers.L3) && item.layers.L3.length === 1 && !item.packManifest.omissions.some(code => code.startsWith('L5_')), { memory })
  assert.equal(oneOmitted.outcome, 'ready')
  assert.deepEqual(oneOmitted.layers.L3.map(item => item.sourceCaseId), ['dc_new'])
  assert.deepEqual(oneOmitted.packManifest.memory.L3.sourceCaseIds, ['dc_new'])
  assert.deepEqual(oneOmitted.layers.L5.map(item => item.evidenceId), pack().layers.L5.map(item => item.evidenceId))
  assert.ok(oneOmitted.packManifest.omissions.includes('L3_EPISODE_TRUNCATED'))
  assert.equal(oneOmitted.packManifest.omissions.filter(code => code === 'L3_EPISODE_OMITTED').length, 1)

  const l5Excerpt = findPack(item => item.packManifest.omissions.includes('L5_EXCERPT_OMITTED'), { memory, criticalEvidenceIds: [] })
  assert.equal(l5Excerpt.layers.L3, '')
  assert.deepEqual(l5Excerpt.packManifest.memory.L3.sourceCaseIds, [])
  assert.ok(l5Excerpt.packManifest.omissions.includes('L3_EPISODE_OMITTED'))
})

test('manifest and hash cover only actual L3 content with deterministic stability', () => {
  const single = { L2: emptyL2, L3: [episodes[0]] }
  const first = pack({ memory: single })
  assert.equal(first.contextPackHash, pack({ memory: single }).contextPackHash)
  const changedExcerpt = pack({ memory: { L2: emptyL2, L3: [{ ...episodes[0], excerpt: 'Answer q: changed' }] } })
  const changedSource = pack({ memory: { L2: emptyL2, L3: [{ ...episodes[0], sourceCaseId: 'dc_other' }] } })
  assert.notEqual(first.contextPackHash, changedExcerpt.contextPackHash)
  assert.notEqual(first.contextPackHash, changedSource.contextPackHash)
  assert.deepEqual(changedExcerpt.packManifest.memory.L3.sourceCaseIds, ['dc_new'])
  assert.deepEqual(changedSource.packManifest.memory.L3.sourceCaseIds, ['dc_other'])
})
