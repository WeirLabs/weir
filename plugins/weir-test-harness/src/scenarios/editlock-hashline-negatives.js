// Scenario: editlock-hashline-negatives — the managed editors' refusal paths
// with the file-lease row enabled (WEIR_IT_EDIT_LOCK=1).
//
// The session starts in a narrow/ child while the sandbox policy is pinned to
// it, so one target below the scenario workspace lies outside the session's
// writable root: anchor mismatch, a non-regular target and the sandbox denial
// keep target bytes unchanged, and a stale observation version is rejected by
// the real host filesystem AFTER dispatch.
//
// What is deliberately NOT asserted any more (edit-lock-rebuild D12 removed the
// mechanism): the durable authority image and its created/updated/unknown
// phases, resource fences, retained locks, out-of-domain refusals and the
// turn-end settling notice. A claim now lives in broker memory only, and a
// refused write reports a tool error — there is no crash-outcome ledger.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock-hashline-negatives'
const prompt = `${id}-probe`

const WS = join(IT_ROOT, 'ws', 'editlock-hashline-negatives')
const NARROW = join(WS, 'narrow')
const CAS = join(NARROW, 'cas-target.txt')
const MISMATCH = join(NARROW, 'mismatch.txt')
// An existing directory is the non-regular target: no fixture is needed, and
// the refusal must happen at stat, before any claim or write.
const DIRECTORY = NARROW
const SANDBOX = join(WS, 'sandbox-target.txt')
const CHECKPOINT = join(IT_ROOT, 'sandbox-before.json')

const ANCHOR_ID = '[ZPMQVRWSNKTXJBYH]{2}'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Every gate is history-marker driven (never lastRole/lastOfRole): the
  // runtime-context snapshot arrives as a user message and can interleave with
  // tool results in either order.
  if (!history.includes(prompt)) return textChunks('unhandled editlock-hashline-negatives turn')

  // ---- positive control: managed write create + hash_edit -------------------
  if (!new RegExp(`Created file: \\S*cas-target\\.txt`).test(history)) {
    return toolCallChunks('write', { file_path: CAS, content: 'stable\n' })
  }
  if (!history.includes('hash_edit applied')) {
    const anchor = new RegExp(`1#(${ANCHOR_ID})\\| stable`).exec(history)
    if (anchor) return toolCallChunks('hash_edit', { file_path: CAS, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'revised' }] })
    return toolCallChunks('read', { file_path: CAS })
  }

  // ---- negative 1: anchor mismatch — whole-call zero-write ------------------
  if (!new RegExp(`Created file: \\S*mismatch\\.txt`).test(history)) {
    return toolCallChunks('write', { file_path: MISMATCH, content: 'alpha\nbeta\n' })
  }
  // Line 2's anchor id at line 1 is a deterministic mismatch (alpha and beta
  // hash to different ids); the whole call must be refused before publication.
  if (!history.includes('hash_edit refused the call')) {
    const anchor = new RegExp(`2#(${ANCHOR_ID})\\| beta`).exec(history)
    if (anchor) return toolCallChunks('hash_edit', { file_path: MISMATCH, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'SHOULD_NEVER_LAND' }] })
    return toolCallChunks('read', { file_path: MISMATCH })
  }

  // ---- negative 2: non-regular node (a directory) ---------------------------
  if (!history.includes('no regular file')) {
    return toolCallChunks('hash_edit', { file_path: DIRECTORY, edits: [{ op: 'replace', pos: '1#ZZ', text: 'SHOULD_NEVER_LAND' }] })
  }

  // ---- negative 3: sandbox denial on a real, in-project target --------------
  // The target exists and is readable, but it sits above the session's
  // workspace-write root, so only the backend may produce the shared marker.
  // The file-lease claim is granted first — leases do not grant filesystem
  // permission, and conflating the two is exactly what the marker proves.
  if (!history.includes('[sandbox: file access denied under workspace-write mode]')) {
    const anchor = new RegExp(`1#(${ANCHOR_ID})\\| sandbox one`).exec(history)
    if (anchor) {
      if (!existsSync(CHECKPOINT)) writeFileSync(CHECKPOINT, JSON.stringify({ bytes: readFileSync(SANDBOX).toString('base64') }))
      return toolCallChunks('hash_edit', { file_path: SANDBOX, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'SHOULD_NEVER_LAND' }] })
    }
    return toolCallChunks('read', { file_path: SANDBOX })
  }

  // ---- negative 4: version CAS rejection ------------------------------------
  // The observation guard still holds the read-time version of cas-target.txt
  // (hash_edit publishes without emitting fs/observed), so this managed write
  // reaches the backend with a stale replaceIfVersion guard and is rejected
  // AFTER dispatch — the rejected write never lands.
  if (!history.includes('file changed since it was read')) {
    return toolCallChunks('write', { file_path: CAS, content: 'changed\n' })
  }

  return textChunks('negatives exercised')
}

// Only pinned trace-record keys may be emitted (trace-extract.test.js pins the
// union); the refusal evidence lives in the transcript text channels instead.
function observe(obs) {
  return {
    editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire'),
  }
}

function assert(run) {
  // Tool result text as the model saw it (trace lastTool caps at 300 chars;
  // every marker gated on below sits well inside that window).
  const text = run.requests.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`)
  const tools = run.requests.flatMap((r) => r.tools ?? [])
  const domain = join(run.ws, 'editlock-hashline-negatives')
  const readWs = (name) => (existsSync(join(domain, 'narrow', name)) ? readFileSync(join(domain, 'narrow', name), 'utf8') : '<missing>')
  const sandboxPath = join(domain, 'sandbox-target.txt')
  const before = existsSync(CHECKPOINT) ? JSON.parse(readFileSync(CHECKPOINT, 'utf8')) : null

  run.check('file lease owner tools advertised (lease-on composition)', run.requests.some((r) => r.editLockToolsSeen) && ['edit_lock_acquire', 'edit_lock_release', 'edit_lock_status', 'edit_lock_try_steal', 'edit_lock_hold'].every((name) => tools.includes(name)), JSON.stringify([...new Set(tools)]))
  run.check('stock edit hidden, managed write and hash_edit present', !tools.includes('edit') && tools.includes('write') && tools.includes('hash_edit'))

  // Positive control: both managed verbs published.
  run.check('positive: managed write created the target', text.some((t) => /Created file: \S*cas-target\.txt/.test(t)), text.join('\n').slice(-600))
  run.check('positive: hash_edit published through the claim', text.some((t) => t.includes('hash_edit applied')), text.join('\n').slice(-600))

  // Negative 1: anchor mismatch — whole call refused, file byte-identical.
  run.check('mismatch: whole call refused with the >>> mismatch report', text.some((t) => t.includes('hash_edit refused the call')), text.join('\n').slice(-600))
  run.check('mismatch: target bytes unchanged (zero writes)', readWs('mismatch.txt') === 'alpha\nbeta\n', readWs('mismatch.txt'))

  // Negative 2: non-regular node refused at stat, before publish.
  run.check('non-regular: directory refused before any write', text.some((t) => t.includes('no regular file')), text.join('\n').slice(-600))
  run.check('non-regular: target is still a directory', existsSync(join(domain, 'narrow')) && statSync(join(domain, 'narrow')).isDirectory())

  // Negative 3: the session policy is workspace-write at <domain>/narrow; the
  // existing target is inside the project but outside that root, so the
  // backend denial marker (not a lease refusal) is the visible outcome, and
  // the bytes never move.
  run.check('sandbox: hash_edit reached the backend denial marker', text.some((t) => t.includes('[sandbox: file access denied under workspace-write mode]')), text.join('\n').slice(-600))
  run.check('sandbox: target lies outside the session workspace', dirname(sandboxPath) === domain && dirname(sandboxPath) !== join(domain, 'narrow'))
  run.check('sandbox: bytes before and after the denied publication match', !!before && before.bytes === readFileSync(sandboxPath).toString('base64'), 'checkpoint missing or bytes changed')

  // Negative 4: the stale observed version reaches the host CAS guard AFTER
  // dispatch; the rejection never lands bytes.
  run.check('cas: stale-version write rejected (FS_STALE_VERSION)', text.some((t) => t.includes('file changed since it was read')), text.join('\n').slice(-600))
  run.check('cas: published bytes are exactly what hash_edit wrote (the rejected write never landed)', readWs('cas-target.txt') === 'revised\n', readWs('cas-target.txt'))

  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_SANDBOX_NARROW: '1' }, decide, observe, assert }
