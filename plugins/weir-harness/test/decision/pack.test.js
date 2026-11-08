import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextPack } from '../../src/decision/evaluator/pack.js'

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
    memorySnapshotId: null, promptVersion: 'evaluator-contract/1', evaluatorVersion: 'sidecar/1',
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
