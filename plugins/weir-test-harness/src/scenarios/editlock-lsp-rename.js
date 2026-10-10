// Scenario: editlock-lsp-rename — REAL multi-file lsp_rename turns with Edit
// Lock enabled (WEIR_IT_EDIT_LOCK=1, shared authority <ws>/.weir/edit-lock),
// driven over six sequential headless boots against the protocol-fixture LSP
// server (the same mock-lsp-server.js the lsp scenario uses: a real stdio
// JSON-RPC server speaking LSP, not a simulated rename adapter — the rename
// path under test is the production client → server → WorkspaceEdit →
// edit-lock publishBatch → host fs writeText chain).
//
//   freeze     Session A acquires probe-other.ts and keeps it (bounded hold),
//              so the lock survives process exit as user-interrupted.
//   conflict   Session B's cross-file rename hits A's retained lock: the whole
//              batch is refused atomically — zero writes, zero new locks.
//   thaw       Session A is adopted (--session-id); the message-driven
//              auto-resume confirms the retained lock, then release frees it.
//   apply      Session C's rename fixtureSymbol → renamedSymbol succeeds: both
//              targets published through one batch, temporary locks released.
//   duplicate  Session E's rename renamedSymbol → staleProbe carries the mock
//              server's same-file alias entry; under Edit Lock the '/./' alias
//              normalizes to the same canonical resource, so the batch is
//              refused BEFORE any write ('duplicate canonical rename target')
//              — the lock-off mid-write FS_STALE_VERSION hazard (lsp scenario)
//              becomes a pre-write whole-batch refusal.
//   midbatch   Session D's rename renamedSymbol → midBatch is aborted by the
//              auto-resume probe (armed purely via env, wrapping the real
//              ctx.fs.writeText) the moment the FIRST file's write lands:
//              file one stays published (no rollback), file two is never
//              dispatched, and the failed batch retains both temporary locks.
//
// Evidence channels: the mock-LLM trace caps tool text at 300 chars, so the
// full failure reports are taken from each boot's `--json` stdout stream
// (tool_call/tool_result pairs), per-boot fixture bytes are captured by the
// driver between boots, and lock/operation state is read from the durable
// authority snapshot after every boot.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'

const id = 'editlock-lsp-rename'
const prompt = `${id}-freeze`

const WS = join(IT_ROOT, 'ws')
const PROBE_TS = join(WS, 'probe.ts')
const PROBE_OTHER = join(WS, 'probe-other.ts')

const BOOTS = ['freeze', 'conflict', 'thaw', 'apply', 'duplicate', 'midbatch']

const ORIGINAL_TS = 'export const fixtureSymbol = 1\n'
const ORIGINAL_OTHER = 'import { fixtureSymbol } from "./probe"\r\nexport const useIt = fixtureSymbol + 1\r\n'
const RENAMED_TS = 'export const renamedSymbol = 1\n'
const RENAMED_OTHER = 'import { renamedSymbol } from "./probe"\r\nexport const useIt = renamedSymbol + 1\r\n'
const MIDBATCH_TS = 'export const midBatch = 1\n'

/** The shared lsp_on → symbols → rename flow every fresh-session boot runs. */
function lspRenameFlow(history, toolResults, newName, doneMarker, doneText) {
  if (!history.includes('LSP semantic tools enabled')) return toolCallChunks('lsp', { enabled: true })
  if (!history.includes('Document symbols:')) return toolCallChunks('lsp_symbols', { file_path: PROBE_TS })
  if (!history.includes(doneMarker)) {
    // The rename is dispatched exactly once (third tool call of the boot); if
    // the turn settles without the outcome marker — an aborted turn can drop
    // the in-flight tool result — end instead of re-dispatching forever.
    if (toolResults >= 3) return textChunks(`${doneText} (outcome marker absent)`)
    return toolCallChunks('lsp_rename', { file_path: PROBE_TS, line: 1, character: 14, new_name: newName })
  }
  return textChunks(doneText)
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const toolResults = (options.messages ?? []).filter((message) => message.role === 'tool').length

  // thaw reuses session A, so its transcript also carries the freeze markers —
  // check it first. Every other boot is a fresh session with only its marker.
  if (history.includes(`${id}-thaw`)) {
    // freeze left two tool results (acquire + hold) in this session's history.
    if (!history.includes('Released')) {
      if (toolResults >= 3) return textChunks('thaw outcome unexpected')
      return toolCallChunks('edit_lock_release', { file_path: PROBE_OTHER })
    }
    return textChunks('thawed')
  }
  if (history.includes(`${id}-conflict`)) {
    return lspRenameFlow(history, toolResults, 'conflictProbe', 'rename stopped', 'conflict refused')
  }
  if (history.includes(`${id}-apply`)) {
    return lspRenameFlow(history, toolResults, 'renamedSymbol', 'across 2 file(s)', 'applied')
  }
  if (history.includes(`${id}-duplicate`)) {
    return lspRenameFlow(history, toolResults, 'staleProbe', 'duplicate canonical rename target', 'duplicate refused')
  }
  if (history.includes(`${id}-midbatch`)) {
    return lspRenameFlow(history, toolResults, 'midBatch', 'rename stopped', 'midbatch settled')
  }
  if (history.includes(`${id}-freeze`)) {
    if (!history.includes('Acquired')) return toolCallChunks('edit_lock_acquire', { file_path: PROBE_OTHER })
    // The turn-end settling notice (turn completed while holding): answer with
    // a bounded reservation so the lock survives process exit; a plain text
    // answer would burn the notice budget and dispose would RELEASE the lock.
    if (history.includes('the turn ended while this session still held') && !history.includes('Keeping')) {
      return toolCallChunks('edit_lock_hold', { minutes: 30 })
    }
    return textChunks('freeze done')
  }
  return textChunks('unhandled editlock-lsp-rename turn')
}

function observe(obs) {
  return {
    editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire'),
    lspRenameSeen: obs.toolNames.includes('lsp_rename'),
  }
}

/** Durable authority image (<ws>/.weir/edit-lock/snapshot.json), reduced. */
function snapshotState(root) {
  const path = join(root, 'ws', '.weir', 'edit-lock', 'snapshot.json')
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null
  return state && {
    sessions: state.sessions?.map((s) => ({ sessionId: s.sessionId, interrupted: s.interrupted, epoch: s.executionEpoch })),
    locks: state.locks?.map((lock) => ({ resourceId: lock.resourceId, owner: lock.owner, status: lock.status, generation: lock.generation })),
    generations: state.generations,
    issuedRequests: state.issuedRequests,
    operations: state.operations?.map((o) => ({
      sessionId: o.sessionId,
      operationId: o.operationId,
      phase: o.phase,
      resourceId: o.binding?.target?.resourceId ?? null,
    })),
  }
}

function sessionIdFrom(stdout) {
  return parseJsonlLines(stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
}

/** Tool call/result pairs from a boot's --json stdout (full, untruncated text). */
function toolStream(stdout) {
  const records = parseJsonlLines(stdout)
  const calls = records.filter((entry) => entry?.type === 'tool_call')
  const results = records.filter((entry) => entry?.type === 'tool_result')
  return calls.map((call, index) => ({ tool: call.tool, status: results[index]?.status ?? null, result: results[index]?.result ?? null }))
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const boots = []
  const readWs = (name) => (existsSync(join(root, 'ws', name)) ? readFileSync(join(root, 'ws', name), 'utf8') : null)
  const boot = async (label, args, extra = {}) => {
    const outcome = await spawnHeadless(args, scenarioEnv(id, trace, { ...env, ...extra }))
    appendFileSync(trace, JSON.stringify({
      kind: 'editlock-lsp-rename-boot', boot: label, code: outcome.code,
      sessionId: sessionIdFrom(outcome.stdout), stderrTail: outcome.stderr.slice(-300),
    }) + '\n')
    appendFileSync(trace, JSON.stringify({
      kind: 'editlock-lsp-rename-detail', boot: label,
      tools: toolStream(outcome.stdout),
      files: { probeTs: readWs('probe.ts'), probeOther: readWs('probe-other.ts') },
    }) + '\n')
    appendFileSync(trace, JSON.stringify({ kind: 'editlock-lsp-rename-snapshot', boot: label, state: snapshotState(root) }) + '\n')
    boots.push({ label, ...outcome })
    return outcome
  }

  const freeze = await boot('freeze', ['weir-it', '--json', `${id}-freeze`])
  const sessionA = sessionIdFrom(freeze.stdout)
  await boot('conflict', ['weir-it', '--json', `${id}-conflict`])
  if (sessionA) {
    await boot('thaw', ['weir-it', '--json', '--session-id', sessionA, `${id}-thaw`])
  } else {
    appendFileSync(trace, JSON.stringify({ kind: 'editlock-lsp-rename-boot', boot: 'thaw', code: null, sessionId: null, skipped: 'no session id from freeze' }) + '\n')
  }
  await boot('apply', ['weir-it', '--json', `${id}-apply`])
  await boot('duplicate', ['weir-it', '--json', `${id}-duplicate`])
  // The shipped auto-resume probe doubles as a deterministic mid-batch abort:
  // armed only here, it cancels the turn the moment probe.ts's write lands.
  const midbatch = await boot('midbatch', ['weir-it', '--json', `${id}-midbatch`], {
    WEIR_IT_AUTO_RESUME_PROBE: '1',
    WEIR_IT_AUTO_RESUME_TARGET: 'probe.ts',
  })
  return {
    scenario: id, trace, code: midbatch.code,
    stdout: boots.map((b) => b.stdout).join('\n'),
    stderr: boots.map((b) => b.stderr).join('\n'),
    sessionId: sessionA,
  }
}

const env = { WEIR_IT_EDIT_LOCK: '1' }

function assert(run) {
  const records = run.records
  const bootRec = (label) => records.find((r) => r.kind === 'editlock-lsp-rename-boot' && r.boot === label)
  const detail = (label) => records.find((r) => r.kind === 'editlock-lsp-rename-detail' && r.boot === label)
  const snap = (label) => records.find((r) => r.kind === 'editlock-lsp-rename-snapshot' && r.boot === label)?.state ?? null
  const bootIdx = BOOTS.map((label) => records.findIndex((r) => r.kind === 'editlock-lsp-rename-boot' && r.boot === label))
  const slice = (label) => {
    const i = BOOTS.indexOf(label)
    const from = i === 0 ? 0 : bootIdx[i - 1] + 1
    const to = bootIdx[i] === -1 ? records.length : bootIdx[i] + 1
    return records.slice(Math.max(from, 0), to)
  }
  const sliceText = (label) => slice(label)
    .filter((r) => Array.isArray(r.emitted))
    .map((r) => `${r.lastUser ?? ''}\n${r.lastTool ?? ''}`)
    .join('\n')
  const readWs = (name) => (existsSync(join(run.ws, name)) ? readFileSync(join(run.ws, name), 'utf8') : '<missing>')
  const renameResult = (label) => detail(label)?.tools?.find((tool) => tool.tool === 'lsp_rename')?.result ?? ''
  const filesAfter = (label) => detail(label)?.files ?? {}
  const locksFor = (state, owner) => (state?.locks ?? []).filter((lock) => lock.owner === owner)
  const generationOf = (state, suffix) => state?.generations?.find((g) => g.resourceId?.endsWith(suffix))?.generation ?? null

  const sessionA = bootRec('freeze')?.sessionId ?? null
  const sessionD = bootRec('midbatch')?.sessionId ?? null

  // ---- freeze: genuine retained foreign lock -------------------------------
  run.check('freeze: session id captured', typeof sessionA === 'string' && sessionA.length > 0, JSON.stringify(bootRec('freeze')))
  run.check('freeze: acquire and bounded hold went through the real owner tools', sliceText('freeze').includes('Acquired') && sliceText('freeze').includes('Keeping 1 file'), sliceText('freeze').slice(-600))
  run.check('freeze: clean exit', bootRec('freeze')?.code === 0, JSON.stringify(bootRec('freeze')))
  const freezeLock = locksFor(snap('freeze'), sessionA)
  run.check('freeze: probe-other.ts lock retained after process exit', freezeLock.length === 1 && freezeLock[0].resourceId.endsWith('probe-other.ts') && freezeLock[0].status === 'user-interrupted', JSON.stringify(snap('freeze')?.locks))

  // ---- conflict: whole batch refused, zero writes ---------------------------
  const conflictResult = renameResult('conflict')
  run.check('conflict: lsp_rename reached the lock-guarded batch and was refused', conflictResult.includes('rename stopped') && conflictResult.includes('resource owned'), conflictResult)
  run.check('conflict: honest report — nothing written, both targets listed not-written, nothing uncertain, no rollback claimed',
    conflictResult.includes('filesAlreadyWritten: []') && conflictResult.includes('probe.ts') && conflictResult.includes('probe-other.ts') &&
    conflictResult.includes('filesUncertain: []') && conflictResult.includes('no rollback'), conflictResult)
  run.check('conflict: both fixtures byte-identical after the refusal (zero writes)', filesAfter('conflict').probeTs === ORIGINAL_TS && filesAfter('conflict').probeOther === ORIGINAL_OTHER, JSON.stringify(filesAfter('conflict')))
  const conflictLocks = snap('conflict')?.locks ?? []
  run.check('conflict: refusal acquired nothing (still exactly A\u2019s one lock)', conflictLocks.length === 1 && conflictLocks[0].owner === sessionA, JSON.stringify(conflictLocks))
  run.check('conflict: clean exit', bootRec('conflict')?.code === 0, JSON.stringify(bootRec('conflict')))

  // ---- thaw: genuine resume of the interrupted owner, then release ----------
  run.check('thaw: boot ran with the frozen session id', bootRec('thaw')?.sessionId === sessionA && bootRec('thaw')?.code === 0, JSON.stringify(bootRec('thaw')))
  run.check('thaw: retained lock released through the owner tool', sliceText('thaw').includes('Released'), sliceText('thaw').slice(-600))
  run.check('thaw: message-driven auto-resume minted a server requestId', snap('thaw')?.issuedRequests?.some((r) => r.sessionId === sessionA && typeof r.requestId === 'string' && r.requestId.startsWith('auto:user-message:')) === true, JSON.stringify(snap('thaw')?.issuedRequests))
  run.check('thaw: authority holds no locks afterwards', (snap('thaw')?.locks ?? []).length === 0, JSON.stringify(snap('thaw')?.locks))

  // ---- apply: atomic acquire + per-file publish, temp locks released --------
  const applyResult = renameResult('apply')
  run.check('apply: cross-file rename summary rendered', applyResult.includes('3 edit(s) across 2 file(s)'), applyResult.slice(-400))
  run.check('apply: both fixtures rewritten on disk', filesAfter('apply').probeTs === RENAMED_TS && filesAfter('apply').probeOther === RENAMED_OTHER, JSON.stringify(filesAfter('apply')))
  run.check('apply: CRLF fixture kept its line-ending style', (filesAfter('apply').probeOther ?? '').includes('\r\n') && (filesAfter('apply').probeOther ?? '').split('\r\n').every((line) => !line.includes('\n')), JSON.stringify(filesAfter('apply').probeOther))
  const applyOps = (snap('apply')?.operations ?? []).filter((o) => o.sessionId === bootRec('apply')?.sessionId)
  run.check('apply: two durable operations, one per target, both updated', applyOps.length === 2 && applyOps.every((o) => o.phase === 'updated') && applyOps.some((o) => o.resourceId?.endsWith('/probe.ts')) && applyOps.some((o) => o.resourceId?.endsWith('/probe-other.ts')), JSON.stringify(applyOps))
  run.check('apply: batch operation ids carry the lsp_rename marker', applyOps.every((o) => typeof o.operationId === 'string' && o.operationId.startsWith('["lsp_rename"')), JSON.stringify(applyOps))
  run.check('apply: temporary batch locks released on success', (snap('apply')?.locks ?? []).length === 0, JSON.stringify(snap('apply')?.locks))
  run.check('apply: lock generations advanced exactly once per target', generationOf(snap('apply'), '/probe.ts') === 1 && generationOf(snap('apply'), '/probe-other.ts') === 2, JSON.stringify(snap('apply')?.generations))
  run.check('apply: clean exit', bootRec('apply')?.code === 0, JSON.stringify(bootRec('apply')))

  // ---- duplicate: same-file alias entry refused before any write ------------
  const duplicateResult = renameResult('duplicate')
  run.check('duplicate: alias entry refused as duplicate canonical target', duplicateResult.includes('duplicate canonical rename target'), duplicateResult)
  run.check('duplicate: honest report — nothing written, nothing uncertain, no rollback claimed', duplicateResult.includes('filesAlreadyWritten: []') && duplicateResult.includes('filesUncertain: []') && duplicateResult.includes('no rollback'), duplicateResult)
  run.check('duplicate: zero writes (renamedSymbol intact, no staleProbe bytes)', filesAfter('duplicate').probeTs === RENAMED_TS && filesAfter('duplicate').probeOther === RENAMED_OTHER, JSON.stringify(filesAfter('duplicate')))
  run.check('duplicate: refusal acquired no locks', (snap('duplicate')?.locks ?? []).length === 0, JSON.stringify(snap('duplicate')?.locks))
  run.check('duplicate: clean exit', bootRec('duplicate')?.code === 0, JSON.stringify(bootRec('duplicate')))

  // ---- midbatch: abort after file one's write — partial, honest, retained ---
  const midResult = renameResult('midbatch')
  run.check('midbatch: probe aborted the turn after the first write', records.some((r) => r.kind === 'auto-resume-stop' && r.session === sessionD) && records.some((r) => r.kind === 'auto-resume-stopped' && r.session === sessionD), JSON.stringify(records.filter((r) => r.kind?.startsWith('auto-resume'))))
  run.check('midbatch: aborted turn exits with code 1', bootRec('midbatch')?.code === 1, JSON.stringify(bootRec('midbatch')))
  run.check('midbatch: honest report — file one written, file two not, nothing uncertain, no rollback claimed',
    midResult.includes('filesAlreadyWritten: [') && midResult.includes('probe.ts') &&
    midResult.includes('filesNotWritten: [') && midResult.includes('probe-other.ts') &&
    midResult.includes('filesUncertain: []') && midResult.includes('no rollback'), midResult || '<rename result absent from aborted-turn stream>')
  run.check('midbatch: file one stayed published on disk (no rollback)', readWs('probe.ts') === MIDBATCH_TS, JSON.stringify(readWs('probe.ts')))
  run.check('midbatch: file two never written', readWs('probe-other.ts') === RENAMED_OTHER && !readWs('probe-other.ts').includes('midBatch'), JSON.stringify(readWs('probe-other.ts')))
  const midOps = (snap('midbatch')?.operations ?? []).filter((o) => o.sessionId === sessionD)
  const midWritten = midOps.filter((o) => o.phase === 'updated')
  const midOther = midOps.filter((o) => o.resourceId?.endsWith('/probe-other.ts'))
  run.check('midbatch: durable history records exactly the written file as updated', midWritten.length === 1 && midWritten[0].resourceId?.endsWith('/probe.ts'), JSON.stringify(midOps))
  run.check('midbatch: file two has no updated/unknown operation (never dispatched)', midOther.every((o) => o.phase === 'not-published'), JSON.stringify(midOther))
  const midLocks = locksFor(snap('midbatch'), sessionD)
  run.check('midbatch: failed batch retained both temporary locks', midLocks.length === 2 && midLocks.every((lock) => lock.status === 'user-interrupted'), JSON.stringify(snap('midbatch')?.locks))
  run.check('midbatch: lock generations match the full scenario history', generationOf(snap('midbatch'), '/probe.ts') === 2 && generationOf(snap('midbatch'), '/probe-other.ts') === 3, JSON.stringify(snap('midbatch')?.generations))
}

export default { id, prompt, env, decide, observe, run, assert }
