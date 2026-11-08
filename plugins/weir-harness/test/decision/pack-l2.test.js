import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextPack } from '../../src/decision/evaluator/pack.js'
import { OMISSION_CODES } from '../../src/decision/contracts.js'

const profile = {
  revision: 2, scope: { workspaces: ['/repo'] },
  userDescription: { revision: 1, text: 'Prefer concise copy' },
  generatedDescription: { revision: 0, text: '' },
}
const request = { entry: 'hook', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
const scope = { workspaces: ['/repo'] }
const source = {
  evidenceId: 'ev_source', source: 'user_decision', locator: { kind: 'case', caseId: 'dc_source' },
  excerpt: 'User chose A', scope, status: 'active', createdAt: 20,
}
const principle = {
  schemaVersion: 1, kind: 'reviewed_principle', principleId: 'pr_one', text: 'Prefer A',
  scope, sources: ['dc_source'], evidenceIds: ['ev_source'],
}
const L2 = {
  schemaVersion: 1, status: 'populated', snapshotId: 'ms_one', snapshotRevision: 3,
  snapshotHash: 'a'.repeat(64), items: [principle],
  exclusions: [{ principleId: 'pr_omitted', reason: 'SOURCE_UNAVAILABLE' }],
}

function pack(overrides = {}) {
  return buildContextPack({
    profile, request, evidence: [source], memory: { L2, L3: [] },
    modelRoute: { kind: 'inherited' }, budgetTokens: 24_000, ...overrides,
  })
}

function findPack(predicate, input) {
  for (let budgetTokens = 100; budgetTokens <= 6_000; budgetTokens += 5) {
    const value = pack({ budgetTokens, ...input })
    if (predicate(value)) return value
  }
  throw new Error('No bounded P3 pack matched the expected omission stage')
}

test('source-bound L2 pins and actual-only manifest/hash preserve the reviewed principle and its L5 mapping', () => {
  const value = pack()
  assert.equal(value.outcome, 'ready')
  assert.equal(value.pins.memorySnapshotId, 'ms_one')
  assert.equal(value.pins.memorySnapshotRevision, 3)
  assert.equal(value.pins.memorySnapshotHash, 'a'.repeat(64))
  assert.deepEqual(value.layers.L2, [principle])
  assert.deepEqual(JSON.parse(value.messages[0].content).L2, [principle])
  const manifest = value.packManifest.memory.L2
  assert.equal(manifest.snapshotId, 'ms_one')
  assert.equal(manifest.snapshotRevision, 3)
  assert.equal(manifest.snapshotHash, 'a'.repeat(64))
  assert.deepEqual(manifest.principleIds, ['pr_one'])
  assert.equal(manifest.items[0].principleId, 'pr_one')
  assert.deepEqual(manifest.items[0].sources, ['dc_source'])
  assert.deepEqual(manifest.items[0].evidenceIds, ['ev_source'])
  assert.deepEqual(manifest.exclusions, L2.exclusions)
  assert.equal(value.packManifest.layerSizes.L2, JSON.stringify([principle]).length)
  assert.deepEqual(value.packManifest.evidenceIds, ['ev_source'])
  assert.equal(value.packManifest.evidenceIds.includes('pr_one'), false)

  assert.equal(value.contextPackHash, pack().contextPackHash)
  assert.notEqual(value.contextPackHash, pack({ memory: { L2: { ...L2, items: [{ ...principle, text: 'Changed' }] }, L3: [] } }).contextPackHash)
  const alternateSource = { ...source, evidenceId: 'ev_other', locator: { kind: 'case', caseId: 'dc_other' } }
  const withBoth = { evidence: [source, alternateSource] }
  const originalMapping = pack(withBoth)
  const changedMapping = pack({ ...withBoth, memory: { L2: { ...L2, items: [{ ...principle, evidenceIds: ['ev_other'] }] }, L3: [] } })
  assert.notEqual(originalMapping.contextPackHash, changedMapping.contextPackHash)
  assert.notEqual(value.contextPackHash, pack({ memory: { L2: { ...L2, snapshotHash: 'b'.repeat(64) }, L3: [] } }).contextPackHash)
})

test('budget trimming is L3 then whole L2 then L5 and never leaves an L2 principle source outside the pack', () => {
  for (const code of ['L2_PRINCIPLE_OMITTED', 'L2_PRINCIPLE_TRUNCATED']) assert.ok(OMISSION_CODES.includes(code))
  const secondSource = { ...source, evidenceId: 'ev_second', locator: { kind: 'case', caseId: 'dc_second' }, excerpt: 'Second '.repeat(300), createdAt: 10 }
  const thirdSource = { ...source, evidenceId: 'ev_third', locator: { kind: 'case', caseId: 'dc_third' }, excerpt: 'Third '.repeat(300), createdAt: 5 }
  const secondPrinciple = { ...principle, principleId: 'pr_two', text: `Second principle ${'p'.repeat(300)}`, sources: ['dc_second'], evidenceIds: ['ev_second'] }
  const episode = {
    schemaVersion: 1, kind: 'neutral_agent_answer', sourceCaseId: 'dc_neutral', sourceRevision: 1,
    scope, excerpt: `Answer q: ${'n'.repeat(600)}`, createdAt: 1, closedAt: 2,
  }
  const input = {
    evidence: [source, secondSource, thirdSource], criticalEvidenceIds: [],
    memory: { L2: { ...L2, items: [principle, secondPrinciple] }, L3: [episode] },
  }
  const l2Trimmed = findPack(item => item.packManifest.omissions.includes('L2_PRINCIPLE_OMITTED')
    && !item.packManifest.omissions.some(code => code.startsWith('L5_')), input)
  assert.equal(l2Trimmed.layers.L3, '')
  assert.ok(l2Trimmed.layers.L2.length < 2)
  assert.ok(l2Trimmed.packManifest.omissions.includes('L2_PRINCIPLE_TRUNCATED'))
  assert.deepEqual(l2Trimmed.packManifest.memory.L2.principleIds, l2Trimmed.layers.L2.map(item => item.principleId))

  const l5Trimmed = findPack(item => item.packManifest.omissions.includes('L5_EVIDENCE_OMITTED'), input)
  assert.deepEqual(l5Trimmed.layers.L2, '')
  assert.deepEqual(l5Trimmed.packManifest.memory.L2.principleIds, [])
  for (const item of Array.isArray(l5Trimmed.layers.L2) ? l5Trimmed.layers.L2 : []) {
    for (const evidenceId of item.evidenceIds) assert.ok(l5Trimmed.packManifest.evidenceIds.includes(evidenceId))
  }
})
