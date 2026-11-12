// Dual L2 pins, manifest and deterministic budget order (OpenSpec 5.1, 5.3).
//
// The public partition is trimmed before the private partition, both are
// recorded separately, and the final-empty-layer length semantics are
// unchanged: an emptied L2 still measures as the wire string '' (0 chars).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextPack } from '../../src/decision/evaluator/pack.js'
import { runDecisionAttempt } from '../../src/decision/evaluator/attempt-pipeline.js'
import { OMISSION_CODES } from '../../src/decision/contracts.js'

const profile = {
  agentId: 'agent-a', revision: 2, scope: { paths: ['src'], authorizationClasses: ['A'] },
  userDescription: { revision: 1, text: 'Prefer concise copy' }, generatedDescription: { revision: 0, text: '' },
}
const request = { entry: 'hook', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }
const scope = { workspaces: ['/repo'] }
const source = {
  evidenceId: 'ev_source', source: 'user_decision', locator: { kind: 'case', caseId: 'dc_source' },
  excerpt: 'User chose A', scope, status: 'active', createdAt: 20,
}
const privatePrinciple = {
  schemaVersion: 1, kind: 'reviewed_principle', principleId: 'pr_private', text: 'Prefer A',
  scope, sources: ['dc_source'], evidenceIds: ['ev_source'],
}
const privateL2 = {
  schemaVersion: 1, status: 'populated', snapshotId: 'ms_private', snapshotRevision: 3,
  snapshotHash: 'a'.repeat(64), items: [privatePrinciple], exclusions: [],
}
const publicPrinciple = {
  schemaVersion: 1, kind: 'reviewed_principle', zone: 'public', principleId: 'pr_public',
  text: 'Prefer the option both workspaces agreed on', scope: { paths: ['src'] },
  sources: ['origin_0123456789ab'], evidenceIds: [],
}
const publicL2 = {
  schemaVersion: 1, zone: 'public', status: 'populated', snapshotId: 'ms_public', snapshotRevision: 5,
  snapshotHash: 'b'.repeat(64), items: [publicPrinciple],
  exclusions: [{ principleId: 'pr_public_scope', reason: 'OUT_OF_SCOPE' }],
}
const emptyL2 = { schemaVersion: 1, status: 'empty', snapshotId: null, items: [] }
const emptyPublicL2 = { schemaVersion: 1, zone: 'public', status: 'empty', snapshotId: null, items: [] }

function pack(overrides = {}) {
  return buildContextPack({
    profile, request, evidence: [source], memory: { L2: privateL2, publicL2, L3: [] },
    modelRoute: { kind: 'inherited' }, budgetTokens: 24_000, ...overrides,
  })
}

function findPack(predicate, input = {}) {
  for (let budgetTokens = 100; budgetTokens <= 6_000; budgetTokens += 2) {
    const value = pack({ budgetTokens, ...input })
    if (predicate(value)) return value
  }
  throw new Error('No bounded dual-L2 pack matched the expected omission stage')
}

test('an Attempt pins both Snapshots and records both partitions separately', () => {
  const value = pack()
  assert.equal(value.outcome, 'ready')
  assert.equal(value.pins.memorySnapshotId, 'ms_private')
  assert.equal(value.pins.memorySnapshotRevision, 3)
  assert.equal(value.pins.memorySnapshotHash, 'a'.repeat(64))
  assert.equal(value.pins.publicMemorySnapshotId, 'ms_public')
  assert.equal(value.pins.publicMemorySnapshotRevision, 5)
  assert.equal(value.pins.publicMemorySnapshotHash, 'b'.repeat(64))

  assert.deepEqual(value.layers.L2, [privatePrinciple, publicPrinciple])
  assert.deepEqual(JSON.parse(value.messages[0].content).L2, [privatePrinciple, publicPrinciple])
  assert.equal(value.packManifest.layerSizes.L2, JSON.stringify([privatePrinciple, publicPrinciple]).length)

  const privateManifest = value.packManifest.memory.L2
  assert.equal(privateManifest.zone, 'workspace')
  assert.equal(privateManifest.snapshotId, 'ms_private')
  assert.deepEqual(privateManifest.principleIds, ['pr_private'])
  assert.deepEqual(privateManifest.items[0].evidenceIds, ['ev_source'])
  const publicManifest = value.packManifest.memory.publicL2
  assert.equal(publicManifest.zone, 'public')
  assert.equal(publicManifest.snapshotId, 'ms_public')
  assert.equal(publicManifest.snapshotRevision, 5)
  assert.deepEqual(publicManifest.principleIds, ['pr_public'])
  assert.deepEqual(publicManifest.items[0].sources, ['origin_0123456789ab'])
  assert.deepEqual(publicManifest.items[0].evidenceIds, [])
  assert.deepEqual(publicManifest.exclusions, publicL2.exclusions)
  assert.equal(privateManifest.layerSize, JSON.stringify([privatePrinciple]).length)
  assert.equal(publicManifest.layerSize, JSON.stringify([publicPrinciple]).length)
  assert.ok(value.packManifest.layerSizes.L2 > privateManifest.layerSize && value.packManifest.layerSizes.L2 > publicManifest.layerSize)
  assert.deepEqual(value.packManifest.evidenceIds, ['ev_source'])

  const changedPublicText = pack({ memory: { L2: privateL2, publicL2: { ...publicL2, items: [{ ...publicPrinciple, text: 'Changed guidance' }] }, L3: [] } })
  assert.notEqual(value.contextPackHash, changedPublicText.contextPackHash)
  const changedPublicSnapshot = pack({ memory: { L2: privateL2, publicL2: { ...publicL2, snapshotHash: 'c'.repeat(64) }, L3: [] } })
  assert.notEqual(value.contextPackHash, changedPublicSnapshot.contextPackHash)
  assert.equal(value.contextPackHash, pack().contextPackHash)

  // Old Attempts and old packs keep a single private pin; the public pin is explicit null.
  const legacy = pack({ memory: { L2: privateL2, L3: [] } })
  assert.equal(legacy.pins.memorySnapshotId, 'ms_private')
  assert.equal(legacy.pins.publicMemorySnapshotId, null)
  assert.equal(legacy.packManifest.memory.publicL2.zone, 'public')
  assert.equal(legacy.packManifest.memory.publicL2.status, 'empty')
  assert.deepEqual(legacy.layers.L2, [privatePrinciple])
})

test('budget trimming drops public L2 before private L2 and only then trims L5', () => {
  for (const code of ['PUBLIC_L2_PRINCIPLE_OMITTED', 'PUBLIC_L2_PRINCIPLE_TRUNCATED']) assert.ok(OMISSION_CODES.includes(code))
  const longSource = { ...source, excerpt: 'User chose A '.repeat(200) }
  const input = { evidence: [longSource], criticalEvidenceIds: [] }

  const publicTrimmed = findPack(item => item.packManifest.omissions.includes('PUBLIC_L2_PRINCIPLE_OMITTED')
    && !item.packManifest.omissions.includes('L2_PRINCIPLE_OMITTED')
    && !item.packManifest.omissions.some(code => code.startsWith('L5_')), input)
  assert.deepEqual(publicTrimmed.layers.L2, [privatePrinciple])
  assert.deepEqual(publicTrimmed.packManifest.memory.publicL2.principleIds, [])
  assert.equal(publicTrimmed.packManifest.memory.publicL2.snapshotId, 'ms_public')
  assert.deepEqual(publicTrimmed.packManifest.memory.L2.principleIds, ['pr_private'])
  assert.ok(publicTrimmed.packManifest.omissions.includes('PUBLIC_L2_PRINCIPLE_TRUNCATED'))

  const bothTrimmed = findPack(item => item.packManifest.omissions.includes('PUBLIC_L2_PRINCIPLE_OMITTED')
    && item.packManifest.omissions.includes('L2_PRINCIPLE_OMITTED')
    && item.packManifest.omissions.includes('L5_EXCERPT_OMITTED'), input)
  assert.equal(bothTrimmed.layers.L2, '')
  assert.equal(bothTrimmed.packManifest.layerSizes.L2, 0)
  assert.deepEqual(bothTrimmed.packManifest.memory.publicL2.principleIds, [])
  assert.deepEqual(bothTrimmed.packManifest.memory.L2.principleIds, [])
  assert.equal(bothTrimmed.packManifest.memory.publicL2.snapshotId, 'ms_public')
})

test('both partitions empty keeps the exact final-empty-layer L5 boundary', () => {
  for (let padding = 0; padding < 16; padding++) {
    const paddedSource = { ...source, excerpt: `${source.excerpt}${'p'.repeat(padding)}` }
    const empty = { L2: emptyL2, publicL2: emptyPublicL2, L3: [] }
    const input = { evidence: [paddedSource], memory: empty, criticalEvidenceIds: [] }
    const reference = pack(input)
    assert.equal(reference.outcome, 'ready')
    assert.equal(reference.layers.L2, '')
    const finalCharacters = ['L0', 'L1', 'L4', 'L5'].reduce((sum, layer) => sum + reference.packManifest.layerSizes[layer], 0)
    if (finalCharacters % 4 !== 3) continue
    const budgetTokens = Math.ceil(finalCharacters / 4)
    const value = pack({ ...input, budgetTokens })
    assert.equal(value.outcome, 'ready')
    assert.equal(value.layers.L2, '')
    assert.equal(value.packManifest.layerSizes.L2, 0)
    assert.deepEqual(value.layers.L5, reference.layers.L5)
    assert.equal(value.packManifest.omissions.some(code => code.startsWith('L5_') || code.includes('L2_PRINCIPLE')), false)
    assert.equal(Object.values(value.packManifest.layerSizes).reduce((sum, size) => sum + size, 0), finalCharacters)
    return
  }
  throw new Error('No bounded padding produced a final Pack length congruent to 3 modulo 4')
})

test('the public partition rejects private-zone leakage and raw identifiers', () => {
  const cases = [
    { ...publicL2, items: [{ ...publicPrinciple, evidenceIds: ['ev_source'] }] },
    { ...publicL2, items: [{ ...publicPrinciple, scope }] },
    { ...publicL2, items: [{ ...publicPrinciple, sources: ['/repo/w1'] }] },
    { ...publicL2, zone: 'workspace' },
    { ...publicL2, items: [] },
    { ...publicL2, items: [{ ...publicPrinciple, zone: 'workspace' }] },
  ]
  for (const publicValue of cases) {
    assert.throws(
      () => pack({ memory: { L2: emptyL2, publicL2: publicValue, L3: [] } }),
      error => error.code === 'INVALID_MEMORY_INPUT',
      JSON.stringify(publicValue).slice(0, 120),
    )
  }
  const workspaceKeyLeak = { ...publicL2, items: [{ ...publicPrinciple, text: 'x', scope: { workspaces: ['/repo'] } }] }
  assert.throws(() => pack({ memory: { L2: emptyL2, publicL2: workspaceKeyLeak, L3: [] } }), error => error.code === 'INVALID_MEMORY_INPUT')
})

test('a public principle can enter L2 but is never a citable Evidence Ref', async () => {
  const requests = []
  const ctx = {
    llm: {
      stream: options => {
        requests.push(options)
        return (async function * () {
          yield { type: 'text-delta', text: JSON.stringify({
            outcome: 'answer',
            claims: [{ text: 'Trust the public guidance', evidenceIds: ['pr_public'] }],
            answers: [{ id: 'q', selected: ['A'] }],
          }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const result = await runDecisionAttempt({
    ctx, profile, request, evidence: [], memory: { L2: emptyL2, publicL2, L3: [] },
    modelRoute: { kind: 'resolved', provider: 'p', model: 'm' },
    budgetTokens: 24_000, maxOutputTokens: 1_600, timeoutMs: 20,
    workspaceKey: '/repo', scope, attemptStartedAt: 100, conflictPairs: [], currentObservationHashes: {},
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.error.kind, 'invalid_output')
  assert.equal(result.packManifest.evidenceIds.includes('pr_public'), false)
  assert.deepEqual(result.packManifest.memory.publicL2.principleIds, ['pr_public'])
  assert.equal(JSON.stringify(requests[0].messages).includes('origin_0123456789ab'), true)
})
