// Scenario: filelease-degrade — an unusable arbiter must never block editing
// (edit-lock-rebuild tasks 5.2 / 5.5 / 5.6; design D7; spec "Degradation is
// non-blocking").
//
// The endpoint is made unreachable in the most deterministic way available: the
// socket path is an existing REGULAR FILE, so a connect fails with `ENOTSOCK`
// and a bind would fail too (`EADDRINUSE` → stale-socket probe → `ENOTSOCK`).
// That is deliberately not "delete the socket and let the spawn race": with a
// regular file the daemon can never come up, so the whole boot runs in the
// degraded state the scenario is about.
//
// What this asserts:
//   - the managed write still publishes (twice, so the second is an update of a
//     path the failed claim never covered) — infrastructure failure never
//     refuses a write;
//   - the failure is classified as unreachable, not as a conflict: the client's
//     own `edit_lock_status` answer says so, and no tool result contains a
//     refusal;
//   - the boot completes and both writes land: a path that waited out the
//     request timeout per call, or refused the write after the recovery attempt,
//     would leave no file and a red check above.
//
// D7's audit obligation is asserted here, not just reported: the mount wires the
// client's degradation sink into `src/shared/audit.js`, so the FIRST degraded
// write appends exactly one `weir/file-lease` record to
// `<workspace>/.weir/audit.jsonl` (owner + a path COUNT + the failure reason,
// never path content), and the client's own 60s window keeps the SECOND
// degradation in this same process from adding another.
import { appendFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'filelease-degrade'
const prompt = 'filelease-degrade-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'lease-degraded.txt')
const FIRST_CONTENT = 'degraded write one\n'
const SECOND_CONTENT = 'degraded write two\n'

// Short address: a unix socket path is bounded by `sun_path`, and the run root
// already spends most of that budget.
const DEAD_SOCKET = join(tmpdir(), `weir-it-dead-${createHash('sha256').update(IT_ROOT).digest('hex').slice(0, 12)}.sock`)

const env = { WEIR_IT_EDIT_LOCK: '1' }

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease turn')
  // Two managed writes, both with the arbiter unreachable: a degraded write is
  // not a one-shot exemption.
  if (!history.includes(`Created file: ${TARGET}`)) return toolCallChunks('write', { file_path: TARGET, content: FIRST_CONTENT })
  if (!history.includes(`Updated file: ${TARGET}`)) return toolCallChunks('write', { file_path: TARGET, content: SECOND_CONTENT })
  // The read-only ownership tool is the client's own degradation surface.
  if (!history.includes('ownership arbiter is unreachable')) return toolCallChunks('edit_lock_status', {})
  return textChunks('degraded writes observed')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_status') }
}

/** @param {string} path */
function readAudit(path) {
  try {
    const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return {
      path,
      rows: rows.length,
      // Any row that could be the design's degraded record, matched loosely so
      // the evidence survives a naming change (type/file-lease/degraded/…).
      degraded: rows.filter((row) => /degrad/i.test(String(row?.type ?? '')) || /degrad/i.test(String(row?.data?.kind ?? ''))),
      // The exact record D7 requires, so the assertions below pin the contract
      // instead of a lookalike.
      fileLease: rows.filter((row) => row?.type === 'weir/file-lease'),
    }
  } catch {
    return { path, rows: 0, degraded: [], fileLease: [], missing: true }
  }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  // Arm the fault BEFORE the boot: a regular file at the endpoint address.
  writeFileSync(DEAD_SOCKET, 'not a socket\n')
  /** @type {Record<string, any>} */
  const report = { kind: 'filelease-degrade-report', deadSocket: DEAD_SOCKET }
  /** @type {any} */
  let outcome = null
  try {
    const dead = lstatSync(DEAD_SOCKET)
    report.deadSocketArmed = { isFile: dead.isFile(), isSocket: dead.isSocket() }
    outcome = await spawnHeadless(['weir-it', prompt], scenarioEnv(id, trace, { ...env, WEIR_EDITLOCKD_SOCKET: DEAD_SOCKET }))
  } finally {
    rmSync(DEAD_SOCKET, { force: true })
  }
  const target = join(WS, 'lease-degraded.txt')
  report.bytes = existsSync(target) ? readFileSync(target, 'utf8') : null
  report.audit = readAudit(join(WS, '.weir', 'audit.jsonl'))
  appendFileSync(trace, JSON.stringify(report) + '\n')
  return { scenario: id, trace, ...outcome }
}

function assert(run) {
  const report = run.records.find((row) => row?.kind === 'filelease-degrade-report')
  const text = run.requests.map((request) => `${request.lastTool ?? ''}\n${request.lastUser ?? ''}`).join('\n')
  const target = join(run.ws, 'lease-degraded.txt')
  const bytes = existsSync(target) ? readFileSync(target, 'utf8') : null

  run.check(
    'the endpoint was armed as an unusable address (regular file, not a socket)',
    report?.deadSocketArmed?.isFile === true && report?.deadSocketArmed?.isSocket === false,
    JSON.stringify(report?.deadSocketArmed),
  )
  run.check(
    'the managed write published anyway, with exactly the written bytes',
    bytes === SECOND_CONTENT,
    JSON.stringify({ bytes, reportBytes: report?.bytes }),
  )
  run.check(
    'two managed writes in one process both degraded and proceeded (no one-shot exemption)',
    text.includes(`Created file: ${TARGET}`) && text.includes(`Updated file: ${TARGET}`),
    text.slice(-600),
  )
  run.check(
    'the ownership tool reported the arbiter as unreachable — infrastructure, not a conflict',
    /ownership arbiter is unreachable \(transport\)/.test(text) && text.includes('This is not a conflict'),
    text.slice(-800),
  )
  run.check('no managed write was refused while the arbiter was down', !text.includes('Refused:'), text.slice(-800))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
  // ---- D7: the degradation is audited, exactly once per process window ----
  const audit = report?.audit ?? { path: '(no report)', rows: 0, fileLease: [] }
  const leaseRows = Array.isArray(audit.fileLease) ? audit.fileLease : []
  const leaseRow = leaseRows[0]
  run.check(
    'the degradation was audited: exactly one weir/file-lease record with kind=degraded and an owner session',
    leaseRows.length === 1
      && leaseRow?.data?.kind === 'degraded'
      && typeof leaseRow?.data?.owner?.session === 'string' && leaseRow.data.owner.session.length > 0
      // A count and a reason, never path content — the record is log-only.
      && typeof leaseRow?.data?.paths === 'number' && leaseRow.data.code === 'transport',
    JSON.stringify(audit),
  )
  run.check(
    'the second degraded write in the same run added no record (one per 60s throttle window)',
    text.includes(`Updated file: ${TARGET}`) && leaseRows.length === 1,
    JSON.stringify({ total: leaseRows.length, audit }),
  )
}

export default { id, prompt, env, decide, observe, run, assert }
