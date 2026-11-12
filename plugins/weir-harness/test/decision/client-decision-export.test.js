// Decision data export: the client action, confirmation, real result and failure
// (OpenSpec decision-data-export tasks 3.1/3.2).
//
// The export lives in the records advanced area, reuses the existing confirmation
// dialog, shows only a real path/size/checksum on success, offers an actionable
// retry on failure, and never changes the list, the filters or the detail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageHarness, deferred, findAll, textOf } from './page-test-helpers.js'

const RESULT = {
  file: '/home/user/weir/profiles/test/decisions/exports/decision-export-origin_abcdef123456-1000-deadbeef.json',
  bytes: 2048,
  sha256: 'a'.repeat(64),
  counts: { cases: 2, attempts: 1, evidence: 1, feedback: 0, routeDecisions: 1, learningRuns: 0, memorySnapshots: 0, publishedPrinciples: 0, agents: 1 },
  exportedAt: 1000,
}

const RECORD = { caseId: 'dc_one', agentId: 'a', state: 'closed', closing: 'escalated', request: { questions: [{ id: 'q', question: 'Choose a title' }] } }

function recordsActions(overrides = {}) {
  return {
    agents: async () => [{ agentId: 'a', name: 'Tone', state: 'enabled' }],
    inbox: async () => [],
    records: async () => ({ records: [RECORD], nextCursor: null }),
    metrics: async () => ({ casesOpened: 0 }),
    exportData: async () => RESULT,
    ...overrides,
  }
}

async function openRecordsTree(actions = {}) {
  const harness = await createPageHarness({ actions: recordsActions(actions) })
  const { tree } = await harness.settle()
  findAll(tree, node => node.type === harness.ui.Button && node['data-view'] === 'records')[0].onClick()
  await harness.flush()
  return { harness, tree: harness.render() }
}

/** The action sits behind the records advanced disclosure: descend its content. */
function exportGate(harness, tree) {
  const disclosure = findAll(tree, node => node.type === harness.ui.Disclosure && node.label === 'decisionExportAdvanced')[0]
  assert.ok(disclosure, 'the export action lives in the records advanced disclosure')
  return { disclosure, content: disclosure.children() }
}

function exportStart(harness, tree) {
  return findAll(exportGate(harness, tree).content, node => node.type === harness.ui.Button && node['data-action'] === 'export')[0]
}

function exportDialog(harness) {
  return findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog && node.id === 'weir-da-export')[0]
}

function byAction(tree, harness, action) {
  return findAll(tree, node => node.type === harness.ui.Button && node['data-action'] === action)
}

test('the export action lives in the records advanced area and needs an explicit confirmation', async t => {
  const { harness, tree } = await openRecordsTree()
  exportGate(harness, tree)
  const start = exportStart(harness, tree)
  assert.ok(start, 'the export action is rendered')
  assert.equal(textOf(start), 'decisionExport')
  assert.equal(findAll(tree, node => node['data-export-result']).length, 0, 'no result before the first export')

  start.onClick()
  const dialog = exportDialog(harness)
  assert.ok(dialog, 'the existing confirmation dialog is reused')
  assert.equal(dialog.title, 'decisionExportTitle')
  assert.equal(textOf(dialog.body), 'decisionExportConfirmation')
  assert.equal(dialog.confirmLabel, 'decisionExportConfirm')
  assert.equal(dialog.cancelLabel, 'decisionCancel')
  assert.equal(dialog.returnFocus, start.ref, 'focus returns to the export action')

  // Cancelling closes the dialog and writes nothing.
  dialog.onCancel()
  assert.equal(findAll(harness.render(), node => node.type === harness.ui.ConfirmDialog).length, 0)
  assert.equal(findAll(harness.render(), node => node['data-export-result']).length, 0)
})

test('confirming shows the real file, size and checksum plus a copy action', async t => {
  const calls = []
  const { harness, tree } = await openRecordsTree({ exportData: async () => { calls.push('export'); return RESULT } })
  exportStart(harness, tree).onClick()
  await exportDialog(harness).onConfirm()
  await harness.flush()
  const settled = harness.render()

  assert.deepEqual(calls, ['export'], 'one explicit gesture writes one export')
  const success = findAll(settled, node => node['data-export-result'] === 'success')[0]
  assert.ok(success, 'the real result is shown')
  assert.equal(textOf(findAll(success, node => node['data-export-file'])[0]), `decisionExportFile: ${RESULT.file}`)
  assert.equal(textOf(findAll(success, node => node['data-export-bytes'])[0]), 'decisionExportBytes: 2.0 KB')
  assert.equal(textOf(findAll(success, node => node['data-export-sha256'])[0]), `decisionExportChecksum: ${RESULT.sha256}`)
  assert.ok(byAction(success, harness, 'export-copy')[0], 'the path can be copied')
  assert.equal(findAll(settled, node => node.type === harness.ui.ConfirmDialog).length, 0, 'the dialog closed after confirmation')
  // The list, its filters and the record rows are untouched by the export.
  assert.ok(findAll(settled, node => node['data-filter'] === 'state')[0], 'the filters still render')
  assert.ok(findAll(settled, node => node['data-case-id'] === RECORD.caseId)[0], 'the record list still renders')
})

test('a pending export disables the action and shows no result until it finishes', async t => {
  const pending = deferred()
  const { harness, tree } = await openRecordsTree({ exportData: () => pending.promise })
  exportStart(harness, tree).onClick()
  const running = exportDialog(harness).onConfirm()
  await harness.flush()
  const busy = exportStart(harness, harness.render())
  assert.equal(busy.disabled, true, 'the action cannot be started twice')
  assert.equal(findAll(harness.render(), node => node['data-export-result']).length, 0, 'no result while pending')
  pending.resolve(RESULT)
  await running
  await harness.flush()
  assert.ok(findAll(harness.render(), node => node['data-export-result'] === 'success')[0])
})

test('a failed export shows an actionable reason and a retry that can succeed', async t => {
  let attempt = 0
  const { harness, tree } = await openRecordsTree({
    exportData: async () => {
      attempt += 1
      if (attempt === 1) {
        const error = new Error('EXPORT_WRITE_FAILED: exports')
        // @ts-ignore - transport error shape
        error.code = 'EXPORT_WRITE_FAILED'
        throw error
      }
      return RESULT
    },
  })
  exportStart(harness, tree).onClick()
  await exportDialog(harness).onConfirm()
  await harness.flush()
  let settled = harness.render()

  const failure = findAll(settled, node => node['data-export-result'] === 'error')[0]
  assert.ok(failure, 'a failure never renders a success surface')
  assert.equal(findAll(settled, node => node['data-export-result'] === 'success').length, 0)
  assert.equal(textOf(findAll(failure, node => node['data-export-error'])[0]), 'decisionExportWriteFailed')
  const retry = byAction(settled, harness, 'export-retry')[0]
  assert.ok(retry, 'the failure offers a retry')

  await retry.onClick()
  await harness.flush()
  settled = harness.render()
  assert.ok(findAll(settled, node => node['data-export-result'] === 'success')[0], 'the retry shows the real result')
  assert.equal(findAll(settled, node => node['data-export-result'] === 'error').length, 0)
})

test('a disabled or oversized export maps to its own ordinary-language reason', async t => {
  for (const [code, key] of [['EXPORT_UNAVAILABLE', 'decisionExportUnavailable'], ['EXPORT_TOO_LARGE', 'decisionExportTooLarge']]) {
    const { harness, tree } = await openRecordsTree({
      exportData: async () => {
        const error = new Error(`${code}: detail`)
        // @ts-ignore - transport error shape
        error.code = code
        throw error
      },
    })
    exportStart(harness, tree).onClick()
    await exportDialog(harness).onConfirm()
    await harness.flush()
    const settled = harness.render()
    assert.equal(textOf(findAll(settled, node => node['data-export-error'])[0]), key)
  }
})

test('an incomplete result is never shown as success', async t => {
  for (const value of [
    { file: RESULT.file, bytes: 0, sha256: RESULT.sha256 },
    { file: '', bytes: 12, sha256: RESULT.sha256 },
    { file: RESULT.file, bytes: 12, sha256: 'not-a-checksum' },
    { file: RESULT.file, bytes: 12 },
    null,
  ]) {
    const { harness, tree } = await openRecordsTree({ exportData: async () => value })
    exportStart(harness, tree).onClick()
    await exportDialog(harness).onConfirm()
    await harness.flush()
    const settled = harness.render()
    assert.equal(findAll(settled, node => node['data-export-result'] === 'success').length, 0, `no success for ${JSON.stringify(value)}`)
    assert.equal(textOf(findAll(settled, node => node['data-export-error'])[0]), 'decisionExportInvalidResult')
  }
})

test('the export model maps every state and rejects an incomplete result', async () => {
  const harness = await createPageHarness({ actions: {} })
  const model = harness.model
  assert.deepEqual(model.exportView({}), {
    phase: 'idle', busy: false, statusKey: null, statusVariant: 'idle', result: null, errorKey: null, canRetry: false, copied: false,
  })
  assert.equal(model.exportView({ phase: 'pending' }).busy, true)
  // The rendered action gates on `busy` alone: a successful export stays
  // startable, because the user may write a fresh file at any time.
  assert.equal(model.exportView({ phase: 'success', value: RESULT }).busy, false)
  const success = model.exportView({ phase: 'success', value: RESULT })
  assert.equal(success.result.file, RESULT.file)
  assert.equal(success.result.bytesText, '2.0 KB')
  assert.equal(success.result.sha256, RESULT.sha256)
  assert.equal(success.errorKey, null)
  assert.equal(success.copied, false)
  assert.equal(model.exportView({ phase: 'error', error: { code: 'EXPORT_TOO_LARGE' } }).errorKey, 'decisionExportTooLarge')
  assert.equal(model.exportView({ phase: 'error', error: { code: 'SOMETHING_ELSE' } }).errorKey, 'decisionExportFailed')
  const invalid = model.exportView({ phase: 'success', value: { file: RESULT.file } })
  assert.equal(invalid.result, null)
  assert.equal(invalid.errorKey, 'decisionExportInvalidResult')
  assert.equal(invalid.statusVariant, 'error')
  assert.equal(model.exportBytes(512), '512 B')
  assert.equal(model.exportBytes(3 * 1024 * 1024), '3.0 MB')
  assert.equal(model.dictionaries.en.decisionExport, 'Export decision data')
  assert.equal(typeof model.dictionaries.zh.decisionExport, 'string')
  // Every export key exists in both dictionaries.
  const enKeys = Object.keys(model.dictionaries.en).filter(key => key.startsWith('decisionExport'))
  const zhKeys = Object.keys(model.dictionaries.zh).filter(key => key.startsWith('decisionExport'))
  assert.deepEqual(zhKeys.sort(), enKeys.sort())
})
