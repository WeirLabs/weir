// Scenario: filelease-hold — retention is the ONE ownership fact that survives
// a turn boundary (edit-lock-rebuild tasks 5.2 / 5.5; design D2/D5/D10).
//
// The positive/negative pair with `filelease-turn-release`: the same managed
// write claims the target, but this turn calls `edit_lock_hold` for 30 minutes
// before it ends. The in-process probe (src/file-lease-turn-probe.js) reads the
// arbiter table right after `turn/end`, while the session process is still
// alive, and must still see the path — with a deadline about 30 minutes out —
// even though the turn-boundary release just ran for every non-retained claim.
//
// A driver-side snapshot taken after the boot would prove nothing here: closing
// the connection releases retained leases too (D10), so only the in-process
// reading separates "retained past the turn" from "killed by process exit".
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'filelease-hold'
const prompt = 'filelease-hold-probe'
const TARGET = join(IT_ROOT, 'ws', 'lease-held.txt')
const CONTENT = 'retained across the turn\n'
const SNAPSHOT = 'lease-hold-snapshot.json'

const HOLD_MINUTES = 30
/** Slack for "about 30m from now": the broker counts from its own clock. */
const HOLD_SLACK_MS = 5 * 60_000

const env = {
  WEIR_IT_EDIT_LOCK: '1',
  WEIR_IT_LEASE_PROBE: '1',
  WEIR_IT_LEASE_SNAPSHOT: SNAPSHOT,
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes(prompt)) return textChunks('unhandled filelease turn')
  if (!history.includes(`Created file: ${TARGET}`) && !history.includes(`Updated file: ${TARGET}`)) {
    return toolCallChunks('write', { file_path: TARGET, content: CONTENT })
  }
  // Retention only extends ownership that already exists, so this must follow
  // the managed write (the claim it extends was taken by that write).
  if (!history.includes('Kept 1 path(s) past this turn')) {
    return toolCallChunks('edit_lock_hold', { paths: [TARGET], minutes: HOLD_MINUTES })
  }
  return textChunks('retained claim observed')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_hold') }
}

function assert(run) {
  const text = run.requests.map((request) => `${request.lastTool ?? ''}\n${request.lastUser ?? ''}`).join('\n')
  const target = join(run.ws, 'lease-held.txt')
  const bytes = existsSync(target) ? readFileSync(target, 'utf8') : null
  /** @type {any} */
  let snapshot = null
  try {
    snapshot = JSON.parse(readFileSync(join(run.ws, SNAPSHOT), 'utf8'))
  } catch {
    snapshot = null
  }
  // The FIRST turn-end observation is the one that matters: it is taken before
  // teardown can dispose the agent (which would release the retention, D10).
  const turnRuns = (snapshot?.runs ?? []).filter((entry) => /turn\/end/.test(entry?.trigger ?? ''))
  const firstRun = turnRuns[0] ?? snapshot?.runs?.[0] ?? null
  const firstReading = firstRun?.readings?.[0] ?? null
  const at = firstRun === null ? NaN : Date.parse(firstRun.at)
  const retained = (firstReading?.leases ?? []).find((lease) => lease?.path === target)
  const holdUntil = typeof retained?.holdUntil === 'number' ? retained.holdUntil : 0
  const holdRemaining = Number.isFinite(at) ? holdUntil - at : NaN
  // The whole table after the boundary, for the failure detail: an empty one
  // means turn end released the claim despite the retention.
  const table = firstReading?.leases?.map((lease) => ({ path: lease?.path, holdUntil: lease?.holdUntil, session: lease?.owner?.session })) ?? []

  run.check(
    'retention tool reported the deadline in its result',
    /Kept 1 path\(s\) past this turn/.test(text) && /until \d{4}-\d{2}-\d{2}T[0-9:.]+Z \(about 30m from now\)/.test(text),
    text.slice(-600),
  )
  run.check('the model saw the managed write succeed', text.includes(`Created file: ${TARGET}`) || text.includes(`Updated file: ${TARGET}`), text.slice(-400))
  run.check('target bytes are exactly the managed write content', bytes === CONTENT, JSON.stringify(bytes))
  run.check('in-process probe observed the turn boundary and wrote a snapshot', firstRun !== null && (firstRun?.readings?.length ?? 0) > 0, JSON.stringify(snapshot?.runs?.map((entry) => entry?.trigger)))
  run.check(
    'after turn end the session still holds the path (positive control for turn-release)',
    firstReading?.ok === true && retained !== undefined && retained?.owner?.session === firstRun?.session,
    JSON.stringify({ table, session: firstRun?.session }),
  )
  run.check(
    'the retained validity is about the requested 30 minutes out',
    holdRemaining > HOLD_MINUTES * 60_000 - HOLD_SLACK_MS && holdRemaining <= (HOLD_MINUTES + 1) * 60_000,
    JSON.stringify({ holdUntil, at: firstRun?.at, holdRemaining }),
  )
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env, decide, observe, assert }
