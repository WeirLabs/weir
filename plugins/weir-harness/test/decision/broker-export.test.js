// Decision data export: the Broker action, its audit fact and its closed failures
// (OpenSpec decision-data-export tasks 2.1/2.3).
//
// Success writes one file plus one audit fact naming counts, checksum and file —
// never content. Every failure mode returns a closed code, writes no audit line
// and leaves no file behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'
import { exportChecksum } from '../../src/decision/store/export.js'
import { publicMemoryFixture } from './public-fixtures.js'

const CLOSED = ['EXPORT_UNAVAILABLE', 'EXPORT_WRITE_FAILED', 'EXPORT_TOO_LARGE']

function exportAudits(audits) {
  return audits.filter(entry => entry.kind === 'export')
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir) : []
}

test('a successful export writes the file, one fact audit and the real result', async t => {
  const f = await publicMemoryFixture(t)
  const seeded = await f.seedDecision({
    workspaceKey: f.w1, rootSessionId: 'root1', key: 'broker-export',
    question: 'EXPORT-AUDIT-SECRET which option?', selected: 'A',
  })
  const result = await f.broker.exportData({ sessionId: 'root1' })

  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'counts', 'exportedAt', 'file', 'sha256'])
  assert.equal(result.exportedAt, 1000)
  assert.equal(result.counts.cases, 1)
  assert.equal(result.sha256.length, 64)
  const envelope = JSON.parse(readFileSync(result.file, 'utf8'))
  assert.equal(exportChecksum(envelope), result.sha256)
  assert.equal(statSync(result.file).size, result.bytes)

  // The file lives beside the authoritative store, in its own 0700 directory.
  const storeDir = join(f.dir, 'weir', 'profiles', 'test', 'decisions')
  assert.equal(f.broker.store.path, join(storeDir, 'decision.db'))
  assert.equal(join(storeDir, 'exports'), f.broker.exportsDirectory())
  assert.equal(statSync(join(storeDir, 'exports')).mode & 0o777, 0o700)
  assert.equal(statSync(result.file).mode & 0o777, 0o600)
  assert.deepEqual(filesIn(join(storeDir, 'exports')), [result.file.split('/').at(-1)])

  // Exactly one audit fact, naming counts/checksum/file and no content.
  const audits = exportAudits(f.audits)
  assert.equal(audits.length, 1)
  assert.equal(audits[0].value.sha256, result.sha256)
  assert.equal(audits[0].value.bytes, result.bytes)
  assert.equal(audits[0].value.zone, 'workspace')
  assert.equal(audits[0].value.file, result.file.split('/').at(-1), 'the audit names the file, not its absolute path')
  assert.deepEqual(audits[0].value.counts, result.counts)
  const serialized = JSON.stringify(audits[0])
  assert.equal(serialized.includes('EXPORT-AUDIT-SECRET'), false, 'the audit never carries content')
  assert.equal(serialized.includes(seeded.caseId), false, 'the audit never carries a record id')

  // The action changed nothing: the case is untouched and still readable.
  assert.equal(f.broker.cases.getCase(seeded.caseId).revision, seeded.revision)
})

test('a disabled Decision Agent surface fails closed with no audit and no file', async t => {
  const f = await publicMemoryFixture(t)
  f.config.decisionAgentsEnabled = false
  await assert.rejects(f.broker.exportData({ sessionId: 'root1' }), error => {
    assert.equal(error.code, 'EXPORT_UNAVAILABLE')
    return true
  })
  assert.deepEqual(exportAudits(f.audits), [])
  assert.deepEqual(filesIn(f.broker.exportsDirectory()), [])
})

test('an unwritable exports directory returns EXPORT_WRITE_FAILED with no residue', async t => {
  const f = await publicMemoryFixture(t)
  const exportsDir = f.broker.exportsDirectory()
  mkdirSync(exportsDir, { recursive: true })
  chmodSync(exportsDir, 0o500)
  t.after(() => { if (existsSync(exportsDir)) chmodSync(exportsDir, 0o700) })
  await assert.rejects(f.broker.exportData({ sessionId: 'root1' }), error => {
    assert.equal(error.code, 'EXPORT_WRITE_FAILED')
    assert.equal(String(error.message).includes(exportsDir), false, 'the closed error never forwards the path')
    return true
  })
  assert.deepEqual(exportAudits(f.audits), [], 'a failed export writes no audit line')
  assert.deepEqual(filesIn(exportsDir), [], 'a failed export leaves no partial file')
})

test('an unavailable store fails closed without leaking its path', async t => {
  const f = await publicMemoryFixture(t)
  const blockedRoot = join(f.dir, 'not-a-directory.db')
  await import('node:fs').then(fs => fs.writeFileSync(blockedRoot, 'occupied'))
  const broker = new DecisionBroker({
    profileContext: { home: f.dir, name: 'blocked' },
    ctx: f.ctx,
    config: () => ({ decisionAgentsEnabled: true, decisionAgentRetentionDays: 0, decisionAgentStorePath: blockedRoot }),
    now: () => 1_000,
  })
  await broker.start()
  await assert.rejects(broker.exportData({ sessionId: 'root1' }), error => {
    assert.equal(error.code, 'EXPORT_UNAVAILABLE')
    assert.equal(String(error.message).includes(blockedRoot), false, 'no store path leaks')
    return true
  })
  await broker.flush()
})

test('the export error surface is closed', async () => {
  const { EXPORT_ERROR_CODES } = await import('../../src/decision/store/export.js')
  assert.deepEqual([...EXPORT_ERROR_CODES].sort(), [...CLOSED].sort())
})
