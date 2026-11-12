// Real headless acceptance for the explicit decision data export
// (OpenSpec decision-data-export task 5.1).
//
// One isolated profile root, two real workspaces with real cases, a real
// published public principle, one real export through the Broker, and a
// read-only destination that must fail closed. Everything is verified from the
// file itself: counts, checksum, redaction and section shape. Usage:
//   node plugins/weir-test-harness/spikes/decision/export-acceptance.mjs
// Evidence is written to <lane>/.weir/decision-data-export/headless/.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson } from '../../../weir-harness/src/decision/contracts.js'
import { workspaceAlias } from '../../../weir-harness/src/decision/learning/namespace.js'
import { publicAdd, publicMemoryFixture } from '../../../weir-harness/test/decision/public-fixtures.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANE = join(HERE, '..', '..', '..', '..')
const OUT = process.env.WEIR_EXPORT_EVIDENCE_DIR ?? join(LANE, '.weir', 'decision-data-export', 'headless')
const ABSOLUTE_PATH = /(?:^|["'\s])(?:\/Users\/|\/home\/|\/private\/|\/var\/|[A-Za-z]:\\)/

const checks = []
const cleanups = []
let failed = 0

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) })
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}\n`)
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex')
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir) : []
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const fixture = { after: fn => cleanups.push(fn) }
  const f = await publicMemoryFixture(fixture)

  try {
    // --- a real two-workspace decision set -----------------------------------
    const w1Case = await f.seedDecision({
      workspaceKey: f.w1, rootSessionId: 'root1', key: 'acceptance-w1',
      question: `Which file under ${f.w1}/private/notes.md or /opt/other-machine/secret.txt decides the W1 wording?`, selected: 'A',
    })
    const w2Case = await f.seedDecision({
      workspaceKey: f.w2, rootSessionId: 'root2', key: 'acceptance-w2',
      question: 'ACCEPTANCE-W2-SECRET which other workspace wording?', selected: 'B',
    })
    // A real user gesture through the feedback store, so the Feedback partition is
    // exportable evidence and not an empty array.
    const feedback = await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: w1Case.caseId, kind: 'rating_up' })
    check('feedback recorded through the real feedback store', feedback.kind === 'rating_up' && /^fb_/.test(String(feedback.feedbackId)), { feedbackId: feedback.feedbackId, kind: feedback.kind })
    const publicWording = 'Prefer the documented option both workspaces agreed on.'

    // A real published public principle through the reviewed publish path.
    f.respond((_options, pack) => ({
      operations: [publicAdd(pack.sources.map(source => source.sourceId), { text: publicWording, scope: { paths: ['docs'] } })],
    }))
    const refreshed = await f.broker.publicMemoryRefresh({ sessionId: 'root1', agentId: f.profile.agentId, acknowledgedDisclosure: true })
    check('public candidate extracted from both workspaces', refreshed.status === 'candidate' && refreshed.workspaceCount === 2, refreshed)
    const published = await f.broker.snapshotPublish({
      sessionId: 'root1', snapshotId: refreshed.candidate.snapshotId, expectedRevision: refreshed.candidate.revision,
    })
    check('public principle really published', published.state === 'published' && published.version === 1, published)

    // A real private learning row for W1, so `learning` is not empty.
    f.respond(() => ({
      operations: [{ op: 'add', principleId: 'temporary-private', text: 'Prefer the W1 documented option', scope: { workspaces: [f.w1] }, sources: [w1Case.caseId] }],
    }))
    const started = await f.broker.learningStart({ sessionId: 'root1', agentId: f.profile.agentId, requestId: 'acceptance-private-run' })
    check('private learning run frozen for W1', started.outcome === 'candidate', started)

    // --- the export -----------------------------------------------------------
    const auditsBefore = f.audits.filter(entry => entry.kind === 'export').length
    const result = await f.broker.exportData({ sessionId: 'root1' })
    const text = readFileSync(result.file, 'utf8')
    const envelope = JSON.parse(text)

    check('the export file exists', existsSync(result.file), result.file)
    check('the file lives in <store dir>/exports', dirname(result.file) === f.broker.exportsDirectory(), dirname(result.file))
    check('the exports directory is 0700', (statSync(dirname(result.file)).mode & 0o777) === 0o700, statSync(dirname(result.file)).mode & 0o777)
    check('the file is 0600', (statSync(result.file).mode & 0o777) === 0o600, statSync(result.file).mode & 0o777)
    check('the reported byte count is the real file size', statSync(result.file).size === result.bytes && Buffer.byteLength(text) === result.bytes, { reported: result.bytes, real: statSync(result.file).size })
    check('the envelope is the versioned export kind', envelope.kind === 'weir-decision-export' && envelope.formatVersion === 1, envelope.kind)
    check('the checksum verifies from the file itself', envelope.integrity.algorithm === 'sha256' && (() => {
      const rest = { ...envelope }
      delete rest.integrity
      return digest(canonicalJson(rest)) === envelope.integrity.value
    })(), envelope.integrity)
    check('the returned checksum is the file checksum', result.sha256 === envelope.integrity.value, result.sha256)

    const counts = envelope.counts ?? {}
    check('counts match the entries in the file', counts.cases === envelope.cases.length
      && counts.learningRuns === envelope.learning.runs.length
      && counts.memorySnapshots === envelope.learning.snapshots.length
      && counts.publishedPrinciples === envelope.public.principles.length
      && counts.attempts === envelope.cases.reduce((sum, entry) => sum + entry.attempts.length, 0), counts)
    check('the caller workspace case is present', envelope.cases.some(entry => entry.case.caseId === w1Case.caseId), envelope.cases.map(entry => entry.case.caseId))
    const exportedW1 = envelope.cases.find(entry => entry.case.caseId === w1Case.caseId)
    check('the Feedback partition carries the real user rating', counts.feedback > 0
      && exportedW1.feedback.length === counts.feedback
      && exportedW1.feedback[0].kind === 'rating_up'
      && exportedW1.feedback[0].caseId === w1Case.caseId, { counts, feedback: exportedW1.feedback })
    check('the other workspace case is absent', envelope.cases.every(entry => entry.case.caseId !== w2Case.caseId), envelope.cases.map(entry => entry.case.caseId))
    check('the private W1 learning run is present', envelope.learning.runs.some(run => run.learningRunId === started.learningRunId), envelope.learning.runs.map(run => run.learningRunId))
    check('the public zone exports published wording and scope only', envelope.public.kind === 'published-principles-only'
      && envelope.public.principles.length === 1
      && envelope.public.principles[0].text === publicWording
      && JSON.stringify(envelope.public.principles[0].scope) === JSON.stringify({ paths: ['docs'] })
      && Object.keys(envelope.public.principles[0]).sort().join(',') === 'principleId,scope,text', envelope.public)

    // --- redaction ------------------------------------------------------------
    check('no absolute path survives', !ABSOLUTE_PATH.test(text), (text.match(ABSOLUTE_PATH) ?? [])[0])
    check('no real workspace key survives', !text.includes(f.w1) && !text.includes(f.w2), { w1: text.includes(f.w1), w2: text.includes(f.w2) })
    check('no workspaceKey field survives', !text.includes('workspaceKey'), text.includes('workspaceKey'))
    check('no other-workspace marker survives', !text.includes('ACCEPTANCE-W2-SECRET'), text.includes('ACCEPTANCE-W2-SECRET'))
    check('the opaque workspace alias is the exported identity', envelope.scope.workspaceAlias === workspaceAlias(f.w1), envelope.scope)
    check('the redaction marker replaced the foreign path', text.includes('<path>'), text.includes('<path>'))

    // --- one fact audit, no content ------------------------------------------
    const exportAudits = f.audits.filter(entry => entry.kind === 'export')
    const audit = exportAudits.at(-1)?.value ?? {}
    check('exactly one export audit fact was written', exportAudits.length === auditsBefore + 1, exportAudits.length)
    check('the audit carries counts, checksum and file name', audit.sha256 === result.sha256 && audit.bytes === result.bytes
      && typeof audit.file === 'string' && !audit.file.includes('/'), audit)
    check('the audit carries no content', !JSON.stringify(audit).includes('ACCEPTANCE-W2-SECRET')
      && !JSON.stringify(audit).includes(w1Case.caseId)
      && !JSON.stringify(audit).includes(publicWording), audit)

    // --- a read-only destination fails closed with no residue -----------------
    const exportsDir = f.broker.exportsDirectory()
    const filesBefore = filesIn(exportsDir).length
    chmodSync(exportsDir, 0o500)
    const auditsBeforeFailure = f.audits.filter(entry => entry.kind === 'export').length
    let failure = null
    try {
      await f.broker.exportData({ sessionId: 'root1' })
    } catch (error) {
      failure = { code: error?.code, message: String(error?.message).slice(0, 160) }
    } finally {
      chmodSync(exportsDir, 0o700)
    }
    check('a read-only exports directory fails closed', failure?.code === 'EXPORT_WRITE_FAILED', failure)
    check('the closed failure does not leak the path', !String(failure?.message ?? '').includes(exportsDir), failure?.message)
    check('the failed export leaves no residue', filesIn(exportsDir).length === filesBefore, filesIn(exportsDir))
    check('the failed export writes no audit fact', f.audits.filter(entry => entry.kind === 'export').length === auditsBeforeFailure, f.audits.filter(entry => entry.kind === 'export').length)

    writeFileSync(join(OUT, 'acceptance.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      storeDir: dirname(f.broker.store.path),
      exportFile: result.file,
      bytes: result.bytes,
      sha256: result.sha256,
      counts,
      workspaceAlias: envelope.scope.workspaceAlias,
      failure,
      checks,
      failed,
    }, null, 2)}\n`)
    writeFileSync(join(OUT, 'export-envelope.json'), `${JSON.stringify(envelope, null, 2)}\n`)
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
  }

  process.stdout.write(failed === 0 ? `\nACCEPTANCE PASS (${checks.length} checks)\n` : `\nACCEPTANCE FAIL (${failed}/${checks.length})\n`)
  if (failed !== 0) process.exitCode = 1
}

await main()
