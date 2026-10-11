// Scenario: editlock-hashline-negatives — with Edit Lock enabled
// (WEIR_IT_EDIT_LOCK=1, shared authority <ws>/.weir/edit-lock), the four
// negative edit classes fail BEFORE any byte is written, while a positive
// managed write + hash_edit still publishes through the lock:
//
//   positive   write creates cas-target.txt, hash_edit rewrites it through
//              the lock (durable operations created/updated).
//   mismatch   hash_edit with line 2's anchor id at line 1 is refused with
//              the >>> mismatch report before publish — zero writes; the
//              refused edit leaves no operation in the authority image (only
//              the target's earlier managed create is recorded).
//   nonregular hash_edit on the <ws>/.weir directory is refused at stat
//              ('no regular file') before publish.
//   boundary   hash_edit on the out-of-domain <root>/home/denied.txt passes
//              anchor validation and is then refused by the Edit Lock domain
//              boundary ('outside management domain') — with the lock on, the
//              refusal happens BEFORE the sandbox backend is consulted (the
//              management domain coincides with the session's writable root,
//              so the lock-off [sandbox: ...] marker is unreachable here);
//              the denied file stays byte-identical.
//   cas        hash_edit does not emit fs/observed, so the next managed write
//              carries the stale read-time version guard: the backend's
//              replaceIfVersion CAS rejects it (FS_STALE_VERSION 'file changed
//              since it was read'), the operation settles unknown with a
//              resource fence, the lock is retained, and the published bytes
//              stay exactly what hash_edit wrote.
//
// The session ends holding the fenced cas-target lock; both turn-end settling
// notices are answered with plain text so the bounded fallback runs, and the
// retained lock + unknown operation are asserted from the authority snapshot.
// No committed replay fixtures (live authority snapshot, like
// editlock-lsp-rename) — excluded from assert-replay/selfcontainment.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock-hashline-negatives'
const prompt = `${id}-probe`

const WS = join(IT_ROOT, 'ws')
const CAS = join(WS, 'cas-target.txt')
const MISMATCH = join(WS, 'mismatch.txt')
const DIRECTORY = join(WS, '.weir')
const DENIED = join(IT_ROOT, 'home', 'denied.txt')

const ANCHOR_ID = '[ZPMQVRWSNKTXJBYH]{2}'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Every gate is history-marker driven (never lastRole/lastOfRole): turn-end
  // settling notices and runtime-context snapshots arrive as user messages and
  // can interleave with tool results in either order.
  if (!history.includes(prompt)) return textChunks('unhandled editlock-hashline-negatives turn')

  // Turn-end settling: the fenced cas-target lock cannot be released (the
  // pending unknown publication requires its ownership), so both notices are
  // answered with text and the bounded fallback runs. Two notices maximum.
  if (history.includes('Edit Lock: the turn ended while this session still held')) {
    return textChunks('leaving the fenced lock for the fallback disposition')
  }

  // ---- positive control: managed write create + hash_edit through the lock --
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
  // NOTE: the doctrine quotes `>>> mismatch`, so the report's own first line is the marker.
  if (!history.includes('hash_edit refused the call')) {
    // Line 2's anchor id at line 1 is a deterministic mismatch (alpha and
    // beta hash to different ids); the whole call must be refused pre-publish.
    const anchor = new RegExp(`2#(${ANCHOR_ID})\\| beta`).exec(history)
    if (anchor) return toolCallChunks('hash_edit', { file_path: MISMATCH, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'SHOULD_NEVER_LAND' }] })
    return toolCallChunks('read', { file_path: MISMATCH })
  }
  // The mismatch target was created (and therefore owned) through the lock;
  // release it so the endgame holds only the fenced cas-target lock.
  if (!history.includes('Released')) return toolCallChunks('edit_lock_release', { file_path: MISMATCH })

  // ---- negative 2: non-regular node (a directory) -----------------------------
  if (!history.includes('no regular file')) {
    return toolCallChunks('hash_edit', { file_path: DIRECTORY, edits: [{ op: 'replace', pos: '1#ZZ', text: 'SHOULD_NEVER_LAND' }] })
  }

  // ---- negative 3: out-of-domain edit refused at the lock boundary ----------
  if (!history.includes('outside management domain')) {
    const anchor = new RegExp(`1#(${ANCHOR_ID})\\| outside one`).exec(history)
    if (anchor) return toolCallChunks('hash_edit', { file_path: DENIED, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'DENIED_EDIT_TRIED' }] })
    return toolCallChunks('read', { file_path: DENIED })
  }

  // ---- negative 4: version CAS rejection ------------------------------------
  // The observation gate still holds the read-time version of cas-target.txt
  // (hash_edit publishes through the lock without emitting fs/observed), so
  // this managed write reaches the backend with a stale replaceIfVersion guard.
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

/** Durable authority image (<ws>/.weir/edit-lock/snapshot.json), reduced. */
function snapshotState(ws) {
  const path = join(ws, '.weir', 'edit-lock', 'snapshot.json')
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null
  return state && {
    locks: state.locks?.map((lock) => ({ resourceId: lock.resourceId, owner: lock.owner, status: lock.status })),
    operations: state.operations?.map((o) => ({ phase: o.phase, fence: o.fence ?? null, summary: JSON.stringify(o) })),
  }
}

function assert(run) {
  // Tool result text as the model saw it (trace lastTool caps at 300 chars;
  // every marker gated on below sits well inside that window).
  const text = run.requests.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`)
  const tools = run.requests.flatMap((r) => r.tools ?? [])
  const readWs = (name) => (existsSync(join(run.ws, name)) ? readFileSync(join(run.ws, name), 'utf8') : '<missing>')
  const deniedPath = join(run.ws, '..', 'home', 'denied.txt')
  const snap = snapshotState(run.ws)

  run.check('edit lock owner tools advertised (lock-on composition)', run.requests.some((r) => r.editLockToolsSeen) && ['edit_lock_acquire', 'edit_lock_release', 'edit_lock_status', 'edit_lock_try_steal'].every((name) => tools.includes(name)), JSON.stringify([...new Set(tools)]))
  run.check('stock edit hidden, managed write and hash_edit present', !tools.includes('edit') && tools.includes('write') && tools.includes('hash_edit'))

  // Positive control: both managed verbs published through the lock.
  run.check('positive: managed write created the target through the lock', text.some((t) => /Created file: \S*cas-target\.txt/.test(t)), text.join('\n').slice(-600))
  run.check('positive: hash_edit published through the lock', text.some((t) => t.includes('hash_edit applied')), text.join('\n').slice(-600))

  // Negative 1: anchor mismatch — whole call refused, file byte-identical.
  run.check('mismatch: whole call refused with the >>> mismatch report', text.some((t) => t.includes('hash_edit refused the call')), text.join('\n').slice(-600))
  run.check('mismatch: target bytes unchanged (zero writes)', readWs('mismatch.txt') === 'alpha\nbeta\n', readWs('mismatch.txt'))

  // Negative 2: non-regular node refused at stat, before publish.
  run.check('non-regular: directory refused before any write', text.some((t) => t.includes('no regular file')), text.join('\n').slice(-600))
  run.check('non-regular: target is still a directory', statSync(join(run.ws, '.weir')).isDirectory())

  // Negative 3: out-of-domain edit refused at the Edit Lock boundary before
  // the sandbox backend is consulted; the denied file is byte-identical.
  run.check('boundary: out-of-domain hash_edit refused before any write', text.some((t) => t.includes('outside management domain')), text.join('\n').slice(-600))
  run.check('boundary: denied file bytes unchanged', existsSync(deniedPath) && readFileSync(deniedPath, 'utf8') === 'outside one\noutside two\n', existsSync(deniedPath) ? readFileSync(deniedPath, 'utf8') : 'missing')

  // Negative 4: stale observed version rejected by the backend CAS guard.
  run.check('cas: stale-version write rejected (FS_STALE_VERSION)', text.some((t) => t.includes('file changed since it was read')), text.join('\n').slice(-600))
  run.check('cas: published bytes are exactly what hash_edit wrote (the rejected write never landed)', readWs('cas-target.txt') === 'revised\n', readWs('cas-target.txt'))

  // Authority footprint: exactly the four publication operations in
  // chronological order — create cas-target, hash_edit cas-target, create
  // mismatch-target, rejected cas-target write. The mismatch/directory/denied
  // refusals left no operation history at all (zero-write proof at the
  // authority level).
  const phases = (snap?.operations ?? []).map((o) => o.phase)
  run.check('authority: exactly the four operations in order (created/updated/created/unknown)', JSON.stringify(phases) === JSON.stringify(['created', 'updated', 'created', 'unknown']), JSON.stringify(phases))
  const unknownOp = (snap?.operations ?? []).find((o) => o.phase === 'unknown')
  run.check('authority: the rejected write settled unknown with a resource fence on cas-target', !!unknownOp && unknownOp.fence?.kind === 'resource' && unknownOp.summary.includes('cas-target.txt'), unknownOp?.summary ?? '<none>')
  run.check('authority: the only mismatch-target operation is its creation; the denied target has none', (snap?.operations ?? []).every((o) => !o.summary.includes('denied.txt') && (!o.summary.includes('mismatch.txt') || o.phase === 'created')), JSON.stringify(snap?.operations?.map((o) => o.phase)))

  // The fenced lock was retained (never silently released) — the settling
  // notices fired and the fallback could not free fence-required ownership.
  run.check('authority: the fenced cas-target lock was retained', (snap?.locks ?? []).length === 1 && snap.locks[0].resourceId.endsWith('cas-target.txt'), JSON.stringify(snap?.locks))
  run.check('settle: the turn-end notice reached the model for the retained lock', text.some((t) => t.includes('the turn ended while this session still held')), text.join('\n').slice(-600))

  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env: { WEIR_IT_EDIT_LOCK: '1' }, decide, observe, assert }
