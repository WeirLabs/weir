// Attempt record detail: the public and private L2 partitions are auditable
// (OpenSpec 5.4).
//
// The default record detail stays in ordinary language and never prints an id,
// a workspace path or a foreign record link. The advanced diagnostics keep the
// real per-partition facts: both Snapshot pins, the actual principles and their
// source mapping, per-partition layer sizes, exclusions and omissions. An old
// Attempt that only carries the legacy private pin still renders it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageHarness, findAll, textOf } from './page-test-helpers.js'

const privateHash = 'a'.repeat(64)
const publicHash = 'b'.repeat(64)
const alias = 'origin_aaaaaaaaaaaa'

function modernDetail() {
  return {
    case: {
      caseId: 'dc-partitions', agentId: 'a', state: 'closed', closing: 'answered', feedbackState: 'none',
      request: { questions: [{ id: 'q', question: 'Which option?' }] },
      decision: { attemptId: 'da-new', answers: [{ id: 'q', selected: ['Option A'] }] },
      scope: { workspaces: ['/repo'], paths: ['src'] },
    },
    attempts: [{
      attemptId: 'da-new', attemptNo: 2, outcome: 'answer', claims: [], evidence: [{ evidenceId: 'ev-1', excerpt: 'Current evidence' }],
      pins: {
        memorySnapshotId: 'ms-private', memorySnapshotRevision: 2, memorySnapshotHash: privateHash,
        publicMemorySnapshotId: 'ms-public', publicMemorySnapshotRevision: 1, publicMemorySnapshotHash: publicHash,
      },
      packManifest: {
        layerSizes: { L2: 200, L3: 0, L5: 100 },
        memory: {
          L2: {
            status: 'populated', zone: 'workspace', snapshotId: 'ms-private', snapshotRevision: 2, snapshotHash: privateHash,
            principleIds: ['pr-private'], items: [{ principleId: 'pr-private', sources: ['dc-source'], evidenceIds: ['ev-1'] }],
            exclusions: [{ principleId: 'pr-excluded', reason: 'SOURCE_UNAVAILABLE' }], layerSize: 120,
          },
          publicL2: {
            status: 'populated', zone: 'public', snapshotId: 'ms-public', snapshotRevision: 1, snapshotHash: publicHash,
            principleIds: ['pr-public'], items: [{ principleId: 'pr-public', sources: [alias], evidenceIds: [] }],
            exclusions: [], layerSize: 80,
          },
          L3: { sourceCaseIds: [] },
        },
        omissions: ['PUBLIC_L2_PRINCIPLE_OMITTED'],
      },
    }],
    feedback: [], routeDecisions: [],
  }
}

function legacyDetail() {
  return {
    case: {
      caseId: 'dc-legacy', agentId: 'a', state: 'closed', closing: 'answered', feedbackState: 'none',
      request: { questions: [{ id: 'q', question: 'Legacy option?' }] },
      decision: { attemptId: 'da-old', answers: [{ id: 'q', selected: ['Option A'] }] },
    },
    attempts: [{
      attemptId: 'da-old', attemptNo: 1, outcome: 'answer', claims: [], evidence: [],
      pins: { memorySnapshotId: 'ms-legacy' },
      packManifest: {
        layerSizes: { L2: 0, L3: 0 },
        memory: { L2: { status: 'empty', principleIds: [], items: [] }, L3: { sourceCaseIds: [] } },
        omissions: [],
      },
    }],
    feedback: [], routeDecisions: [],
  }
}

async function openRecord(detail) {
  let openCase = detail.case.caseId
  const harness = await createPageHarness({
    consumeOpenCase: () => { const value = openCase; openCase = null; return value },
    actions: {
      agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }], inbox: async () => [],
      record: async () => detail, records: async () => ({ records: [], nextCursor: null }), metrics: async () => ({}),
    },
  })
  const { tree } = await harness.settle()
  return { harness, record: findAll(tree, node => node['data-record-detail'] === detail.case.caseId)[0] }
}

test('record detail shows both L2 partitions in ordinary language and hides ids until advanced diagnostics', async () => {
  const { harness, record } = await openRecord(modernDetail())
  assert.ok(record)
  const current = findAll(record, node => node['data-current-evidence'] === true)[0]
  const defaultText = textOf(current)
  assert.equal(defaultText.includes('decisionWorkspaceExperience'), true)
  assert.equal(defaultText.includes('decisionPublicMemory'), true)
  assert.equal(defaultText.includes('decisionPublicGuidanceUsed'), true)
  assert.equal(defaultText.includes('decisionReviewedPrinciplesUsed'), true)
  for (const technical of ['pr-private', 'pr-public', 'ms-private', 'ms-public', alias, 'dc-source', 'ev-1', '/repo']) {
    assert.equal(textOf(record).includes(technical), false, technical)
  }

  const advanced = findAll(record, node => node.type === harness.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  const diagnostics = advanced.children()
  assert.deepEqual(findAll(diagnostics, node => node['data-partition-section']).map(node => node['data-partition-section']), ['workspace', 'public'])
  const serialized = JSON.stringify(diagnostics)
  for (const value of ['ms-private', 'ms-public', privateHash, publicHash, 'pr-private', 'pr-public', alias, 'dc-source', 'ev-1', 'SOURCE_UNAVAILABLE', 'PUBLIC_L2_PRINCIPLE_OMITTED']) {
    assert.equal(serialized.includes(value), true, value)
  }
  // Per-partition layer sizes are reported, not only one merged L2 size.
  assert.equal(serialized.includes('120'), true)
  assert.equal(serialized.includes('80'), true)
  // Public sources stay opaque aliases: no raw record and no navigation control.
  const publicSection = findAll(diagnostics, node => node['data-partition-section'] === 'public')[0]
  assert.equal(JSON.stringify(publicSection).includes('dc-source'), false)
  assert.deepEqual(findAll(publicSection, node => ['button', 'a', 'input', 'select', 'textarea'].includes(node.type)), [])
  harness.unmount()
})

test('an old Attempt with only the legacy private pin still renders and never fakes public memory', async () => {
  const { harness, record } = await openRecord(legacyDetail())
  assert.ok(record)
  const current = findAll(record, node => node['data-current-evidence'] === true)[0]
  const defaultText = textOf(current)
  assert.equal(defaultText.includes('decisionPinnedEmpty'), true, 'the legacy private pin is reported as pinned-empty')
  assert.equal(defaultText.includes('decisionPublicLegacy'), true)
  assert.equal(defaultText.includes('decisionPublicGuidanceUsed'), false)

  const advanced = findAll(record, node => node.type === harness.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  const diagnostics = advanced.children()
  const serialized = JSON.stringify(diagnostics)
  assert.equal(serialized.includes('ms-legacy'), true, 'the legacy pin stays visible in advanced diagnostics')
  const publicSection = findAll(diagnostics, node => node['data-partition-section'] === 'public')[0]
  assert.equal(JSON.stringify(publicSection).includes('decisionPartitionLegacy'), true)
  const privateSection = findAll(diagnostics, node => node['data-partition-section'] === 'workspace')[0]
  assert.equal(JSON.stringify(privateSection).includes('ms-legacy'), true)
  harness.unmount()
})
