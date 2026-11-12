// Decision data export: the atomic, bounded file writer
// (OpenSpec decision-data-export tasks 1.3/1.4).
//
// A user-visible export is either a complete 0600 file in a 0700 directory or
// nothing at all: no temp file survives a failure, two concurrent exports never
// overwrite each other and the 32 MiB bound fails closed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXPORT_MAX_BYTES, exportFileName, writeExportFile } from '../../src/decision/store/export.js'

function envelope(overrides = {}) {
  return {
    kind: 'weir-decision-export', formatVersion: 1, exportedAt: 1000,
    generator: { name: 'weir-harness', version: 'decision-export/1' },
    scope: { workspaceAlias: 'origin_abcdef123456' },
    agents: [], cases: [], learning: { runs: [], snapshots: [] },
    public: { kind: 'published-principles-only', principles: [] },
    counts: { agents: 0, cases: 0, attempts: 0, evidence: 0, feedback: 0, routeDecisions: 0, learningRuns: 0, memorySnapshots: 0, publishedPrinciples: 0 },
    integrity: { algorithm: 'sha256', value: 'a'.repeat(64) },
    ...overrides,
  }
}

async function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-export-writer-'))
  t.after(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }) })
  return { dir, exportsDir: join(dir, 'exports') }
}

test('a successful write is a 0600 file inside a 0700 directory with the real byte count', async t => {
  const { exportsDir } = await workspace(t)
  const value = envelope()
  const written = writeExportFile(exportsDir, value)
  assert.equal(statSync(exportsDir).mode & 0o777, 0o700)
  assert.equal(statSync(written.file).mode & 0o777, 0o600)
  assert.equal(statSync(written.file).size, written.bytes)
  const text = readFileSync(written.file, 'utf8')
  assert.equal(Buffer.byteLength(text), written.bytes)
  assert.deepEqual(JSON.parse(text), value, 'the file is the envelope, self-describing')
  assert.equal(written.sha256, value.integrity.value)
  assert.deepEqual(readdirSync(exportsDir), [written.name], 'no temp file survives a success')
})

test('the file name carries the opaque alias, the timestamp and a unique suffix', async t => {
  const { exportsDir } = await workspace(t)
  const value = envelope()
  assert.match(exportFileName(value), /^decision-export-origin_abcdef123456-1000-[0-9a-f]{8}\.json$/)
  const first = writeExportFile(exportsDir, value)
  const second = writeExportFile(exportsDir, value)
  assert.notEqual(first.name, second.name, 'two exports at the same timestamp never collide')
  assert.deepEqual(readdirSync(exportsDir).sort(), [first.name, second.name].sort())
  assert.equal(readFileSync(first.file, 'utf8'), readFileSync(second.file, 'utf8'))
})

test('a write failure leaves no partial file and no temp file', async t => {
  const { exportsDir } = await workspace(t)
  const failing = {
    writeFileSync: (path, text, options) => {
      writeFileSync(path, String(text).slice(0, 12), options)
      throw Object.assign(new Error(`ENOSPC: no space left on device, write ${path}`), { code: 'ENOSPC' })
    },
  }
  assert.throws(() => writeExportFile(exportsDir, envelope(), { fs: failing }), error => {
    assert.equal(error.code, 'EXPORT_WRITE_FAILED')
    // A closed error never forwards the underlying path or errno text.
    assert.equal(String(error.message).includes(exportsDir), false)
    return true
  })
  assert.deepEqual(readdirSync(exportsDir), [], 'a failed export leaves zero files, including the temp file')
})

test('an envelope over the 32 MiB bound fails closed before any write', async t => {
  const { exportsDir } = await workspace(t)
  const tooLarge = envelope({ padding: 'x'.repeat(EXPORT_MAX_BYTES) })
  assert.throws(() => writeExportFile(exportsDir, tooLarge), error => error.code === 'EXPORT_TOO_LARGE')
  assert.equal(existsSync(exportsDir), false, 'nothing was even created')
})

test('a directory that cannot be created fails closed without residue', async t => {
  const { dir } = await workspace(t)
  const blocked = join(dir, 'blocked')
  mkdirSync(blocked)
  writeFileSync(join(blocked, 'exports'), 'not a directory')
  assert.throws(() => writeExportFile(join(blocked, 'exports'), envelope()), error => error.code === 'EXPORT_WRITE_FAILED')
})
