// Scenario: editlock-lsp-rename — REAL multi-file lsp_rename turns with the
// file-lease row enabled (WEIR_IT_EDIT_LOCK=1) in its own disposable workspace
// <ws>/editlock-lsp-rename, driven over five sequential headless boots against
// the protocol-fixture LSP server (the same mock-lsp-server.js used by lsp: a
// real stdio JSON-RPC server, so the path under test is the production
// client → server → WorkspaceEdit → lease batch claim → host fs writeText chain).
//
//   conflict   A lease held by ANOTHER PROCESS (this driver opens its own
//              broker connection and retains probe-other.ts) makes the whole
//              batch refuse before any write: zero bytes, zero claims. This
//              replaces the old retained-lock freeze/thaw boots: ownership no
//              longer survives a process exit (spec "Ownership never survives a
//              restart"), so a cross-process holder is the only honest way to
//              produce a foreign claim.
//   missing    WorkspaceEdit names only an absent target; preflight refuses.
//   mixed      Valid existing targets precede an absent target; the entire
//              batch still refuses without any publication.
//   apply      The rename fixtureSymbol → renamedSymbol succeeds: both targets
//              published through one batch claim.
//   midbatch   The turn is aborted (user stop) the moment the FIRST file's
//              write lands: file one stays published (no rollback), file two is
//              never dispatched, and the failure report is honest about which
//              list each target belongs to.
//
// Evidence channels: the mock-LLM trace caps tool text at 300 chars, so the
// full failure reports are taken from each boot's `--json` stdout stream
// (tool_call/tool_result pairs) and per-boot fixture bytes are captured by the
// driver between boots. The durable authority snapshot is gone with the
// mechanism — there is nothing to read after a boot.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'
import { createLeaseClient } from '../../../weir-harness/src/file-lease/client.js'
import { defaultLeaseEndpoint } from '../../../weir-harness/src/file-lease/singleton.js'

const id = 'editlock-lsp-rename'
const prompt = `${id}-conflict`

const WS = join(IT_ROOT, 'ws', id)
const PROBE_TS = join(WS, 'probe.ts')
const PROBE_OTHER = join(WS, 'probe-other.ts')

// The foreign holder's identity: a different lineage (the arbiter only compares
// ids), a label for the refusal text, and a session that is never live here.
const FOREIGN = Object.freeze({ id: 'foreign-lineage-lsp-rename', session: 'foreign-session-lsp-rename', label: 'foreign harness' })

// resourceId assertions compare basenames, never separators: the authority
// stores platform-native absolute paths (POSIX '/' vs Windows '\\'), so the
// former endsWith('/probe.ts') forms failed on windows-latest (CI 38109746915)
// while macOS/Ubuntu passed. Separators are folded first because node:path's
// basename is platform-specific. The comparison is a whole-basename equality:
// a bare suffix test like endsWith('probe.ts') would false-match 'xprobe.ts'.
export function baseName(resourceId) {
  if (typeof resourceId !== 'string') return null
  const parts = resourceId.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : null
}

const BOOTS = ['conflict', 'missing', 'mixed', 'apply', 'midbatch']

const ORIGINAL_TS = 'export const fixtureSymbol = 1\n'
const ORIGINAL_OTHER = 'import { fixtureSymbol } from "./probe"\r\nexport const useIt = fixtureSymbol + 1\r\n'
const RENAMED_TS = 'export const renamedSymbol = 1\n'
const RENAMED_OTHER = 'import { renamedSymbol } from "./probe"\r\nexport const useIt = renamedSymbol + 1\r\n'
const MIDBATCH_TS = 'export const midBatch = 1\n'

const env = { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_LSP_RENAME: '1' }

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

  if (history.includes(`${id}-conflict`)) {
    return lspRenameFlow(history, toolResults, 'conflictProbe', 'refused before any write', 'conflict refused')
  }
  if (history.includes(`${id}-missing`)) {
    return lspRenameFlow(history, toolResults, 'missingProbe', 'no regular file', 'missing refused')
  }
  if (history.includes(`${id}-mixed`)) {
    return lspRenameFlow(history, toolResults, 'mixedProbe', 'no regular file', 'mixed refused')
  }
  if (history.includes(`${id}-apply`)) {
    return lspRenameFlow(history, toolResults, 'renamedSymbol', 'across 2 file(s)', 'applied')
  }
  if (history.includes(`${id}-midbatch`)) {
    return lspRenameFlow(history, toolResults, 'midBatch', 'write failed for', 'midbatch settled')
  }
  return textChunks('unhandled editlock-lsp-rename turn')
}

function observe(obs) {
  return {
    editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire'),
    lspRenameSeen: obs.toolNames.includes('lsp_rename'),
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

/**
 * Hold one path as a foreign owner for the duration of `fn`, from THIS process
 * (a separate broker connection). The client dials, spawning the run's daemon
 * on first use, and never touches the machine-level socket because the driver
 * pinned WEIR_EDITLOCKD_SOCKET to the run root.
 */
async function withForeignHolder(paths, fn) {
  const client = createLeaseClient({ socketPath: process.env.WEIR_EDITLOCKD_SOCKET ?? defaultLeaseEndpoint() })
  try {
    await client.acquire(FOREIGN, paths, WS)
    // A 30-minute retention keeps the conflict alive for the whole boot even if
    // the boot is much slower than the 120s turn lease.
    await client.hold(paths, 30, FOREIGN)
    return await fn()
  } finally {
    try {
      await client.release(FOREIGN, paths)
    } catch {
      // Connection-close releases everything anyway.
    }
    try {
      client.close()
    } catch {
      // Already gone.
    }
  }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const boots = []
  const readWs = (name) => (existsSync(join(root, 'ws', id, name)) ? readFileSync(join(root, 'ws', id, name), 'utf8') : null)
  const readBytes = (name) => (existsSync(join(root, 'ws', id, name)) ? readFileSync(join(root, 'ws', id, name)).toString('base64') : null)
  const boot = async (label, args, extra = {}) => {
    const outcome = await spawnHeadless(args, scenarioEnv(id, trace, { ...env, ...extra }))
    appendFileSync(trace, JSON.stringify({
      kind: 'editlock-lsp-rename-boot', boot: label, code: outcome.code,
      sessionId: sessionIdFrom(outcome.stdout), stderrTail: outcome.stderr.slice(-300),
    }) + '\n')
    appendFileSync(trace, JSON.stringify({
      kind: 'editlock-lsp-rename-detail', boot: label,
      tools: toolStream(outcome.stdout),
      files: { probeTs: readWs('probe.ts'), probeOther: readWs('probe-other.ts'), absent: readWs('probe-absent.ts') },
      bytes: { probeTs: readBytes('probe.ts'), probeOther: readBytes('probe-other.ts'), absent: readBytes('probe-absent.ts') },
    }) + '\n')
    boots.push({ label, ...outcome })
    return outcome
  }

  // A foreign claim on probe-other.ts refuses the whole batch before any byte.
  await withForeignHolder([PROBE_OTHER], () => boot('conflict', ['weir-it', '--json', `${id}-conflict`]))
  await boot('missing', ['weir-it', '--json', `${id}-missing`])
  await boot('mixed', ['weir-it', '--json', `${id}-mixed`])
  await boot('apply', ['weir-it', '--json', `${id}-apply`])
  // The write-boundary abort probe ends the turn the moment probe.ts's managed
  // write lands, so probe-other.ts is never dispatched.
  const midbatch = await boot('midbatch', ['weir-it', '--json', `${id}-midbatch`], {
    WEIR_IT_WRITE_ABORT_PROBE: '1',
    WEIR_IT_WRITE_ABORT_TARGET: `${id}/probe.ts`,
  })
  return {
    scenario: id, trace, code: midbatch.code,
    stdout: boots.map((b) => b.stdout).join('\n'),
    stderr: boots.map((b) => b.stderr).join('\n'),
    sessionId: sessionIdFrom(boots[0].stdout),
  }
}

function assert(run) {
  const records = run.records
  const bootRec = (label) => records.find((r) => r.kind === 'editlock-lsp-rename-boot' && r.boot === label)
  const detail = (label) => records.find((r) => r.kind === 'editlock-lsp-rename-detail' && r.boot === label)
  const readWs = (name) => (existsSync(join(run.ws, id, name)) ? readFileSync(join(run.ws, id, name), 'utf8') : '<missing>')
  const renameResult = (label) => detail(label)?.tools?.find((tool) => tool.tool === 'lsp_rename')?.result ?? ''
  const filesAfter = (label) => detail(label)?.files ?? {}
  const bytesAfter = (label) => detail(label)?.bytes ?? {}

  // ---- conflict: whole batch refused, zero writes ---------------------------
  const conflictResult = renameResult('conflict')
  run.check('conflict: a foreign lease refused the lsp_rename batch', conflictResult.includes('refused before any write') && conflictResult.includes('held'), conflictResult)
  run.check('conflict: honest report — nothing written, both targets listed not-written, nothing uncertain, no rollback claimed',
    conflictResult.includes('filesAlreadyWritten: []') && conflictResult.includes('probe.ts') && conflictResult.includes('probe-other.ts') &&
    conflictResult.includes('filesNotWritten: [') && conflictResult.includes('filesUncertain: []') && conflictResult.includes('no rollback'), conflictResult)
  run.check('conflict: both fixtures byte-identical after the refusal (zero writes)', filesAfter('conflict').probeTs === ORIGINAL_TS && filesAfter('conflict').probeOther === ORIGINAL_OTHER, JSON.stringify(filesAfter('conflict')))
  run.check('conflict: clean exit', bootRec('conflict')?.code === 0, JSON.stringify(bootRec('conflict')))

  // ---- missing / mixed: preflight refuses the WHOLE batch, zero writes ------
  for (const label of ['missing', 'mixed']) {
    const result = renameResult(label)
    run.check(`${label}: missing target rejected by lsp_rename preflight`, result.includes('no regular file') && result.includes('probe-absent.ts') && result.includes('preflight failed, no files were written'), result)
    run.check(`${label}: existing fixture bytes unchanged and absent target not created`, bytesAfter(label).probeTs === Buffer.from(ORIGINAL_TS).toString('base64') && bytesAfter(label).probeOther === Buffer.from(ORIGINAL_OTHER).toString('base64') && bytesAfter(label).absent === null, JSON.stringify(bytesAfter(label)))
    run.check(`${label}: rename was invoked and turn settled cleanly`, detail(label)?.tools?.some(t => t.tool === 'lsp_rename') && bootRec(label)?.code === 0, JSON.stringify(bootRec(label)))
  }

  // ---- apply: one batch claim, per-file publish -----------------------------
  const applyResult = renameResult('apply')
  run.check('apply: cross-file rename summary rendered', applyResult.includes('3 edit(s) across 2 file(s)'), applyResult.slice(-400))
  run.check('apply: both fixtures rewritten on disk', filesAfter('apply').probeTs === RENAMED_TS && filesAfter('apply').probeOther === RENAMED_OTHER, JSON.stringify(filesAfter('apply')))
  run.check('apply: CRLF fixture kept its line-ending style', (filesAfter('apply').probeOther ?? '').includes('\r\n') && (filesAfter('apply').probeOther ?? '').split('\r\n').every((line) => !line.includes('\n')), JSON.stringify(filesAfter('apply').probeOther))
  run.check('apply: clean exit', bootRec('apply')?.code === 0, JSON.stringify(bootRec('apply')))

  // ---- midbatch: abort after file one's write — partial, honest, no rollback -
  const midResult = renameResult('midbatch')
  run.check('midbatch: probe aborted the turn after the first write', records.some((r) => r.kind === 'write-abort-stop') && records.some((r) => r.kind === 'write-abort-stopped'), JSON.stringify(records.filter((r) => r.kind?.startsWith('write-abort'))))
  run.check('midbatch: aborted turn exits with code 1', bootRec('midbatch')?.code === 1, JSON.stringify(bootRec('midbatch')))
  // The abort happens after file one landed and before file two was dispatched,
  // but an aborted turn makes the second write unprovable: it must appear in
  // exactly one of filesNotWritten / filesUncertain — never in both, never in
  // neither — and the report must never claim a rollback.
  const classified = (list) => list.includes('probe-other.ts')
  const notWritten = classified(midResult.split('filesNotWritten: ')[1]?.split(';')[0] ?? '')
  const uncertain = classified(midResult.split('filesUncertain: ')[1]?.split(';')[0] ?? '')
  run.check('midbatch: honest report — file one written, file two classified once, no rollback claimed',
    midResult.includes('filesAlreadyWritten: [') && midResult.includes('probe.ts') &&
    notWritten !== uncertain &&
    midResult.includes('no rollback'), midResult || '<rename result absent from aborted-turn stream>')
  run.check('midbatch: file one stayed published on disk (no rollback)', readWs('probe.ts') === MIDBATCH_TS, JSON.stringify(readWs('probe.ts')))
  run.check('midbatch: file two never written', readWs('probe-other.ts') === RENAMED_OTHER && !readWs('probe-other.ts').includes('midBatch'), JSON.stringify(readWs('probe-other.ts')))
}

export default { id, prompt, env, decide, observe, run, assert }
