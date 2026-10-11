// Lock-on editor negatives. A disposable headless profile pins a dedicated
// Edit Lock management root at <ws>/editlock-hashline-negatives, while this
// session starts in its narrow/ child: the sandbox root is strictly narrower.
// Anchor mismatch, directory and out-of-domain refusals occur before dispatch.
// An in-domain/out-of-sandbox hash_edit reaches the real fs backend and is
// denied there; its dispatched operation is conservatively unknown/fenced,
// not mislabeled as a pre-dispatch refusal. The stale-version CAS similarly
// fails after dispatch. Both rejected attempts leave target bytes unchanged.
// The session ends with both fenced locks retained. No committed replay fixture
// (live authority snapshot, as with editlock-lsp-rename).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock-hashline-negatives'
const prompt = `${id}-probe`

const WS = join(IT_ROOT, 'ws', 'editlock-hashline-negatives')
const NARROW = join(WS, 'narrow')
const CAS = join(NARROW, 'cas-target.txt')
const MISMATCH = join(NARROW, 'mismatch.txt')
const DIRECTORY = join(WS, '.weir')
const DENIED = join(IT_ROOT, 'home', 'denied.txt')
const SANDBOX = join(WS, 'sandbox-target.txt')
const CHECKPOINT = join(IT_ROOT, 'sandbox-before.json')

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
  // In-domain target, outside the narrower per-session workspace-write root.
  // Unlike DENIED this passes the Edit Lock domain boundary; only the real
  // SandboxedFileSystem backend may produce the shared sandbox marker.
  if (!history.includes('[sandbox: file access denied under workspace-write mode]')) {
    const anchor = new RegExp(`1#(${ANCHOR_ID})\\| sandbox one`).exec(history)
    if (anchor) {
      if (!existsSync(CHECKPOINT)) writeFileSync(CHECKPOINT, JSON.stringify({ bytes: readFileSync(SANDBOX).toString('base64'), authority: snapshotState(WS) }))
      return toolCallChunks('hash_edit', { file_path: SANDBOX, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'SHOULD_NEVER_LAND' }] })
    }
    return toolCallChunks('read', { file_path: SANDBOX })
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
  const domain = join(run.ws, 'editlock-hashline-negatives')
  const readWs = (name) => (existsSync(join(domain, 'narrow', name)) ? readFileSync(join(domain, 'narrow', name), 'utf8') : '<missing>')
  const deniedPath = join(run.ws, '..', 'home', 'denied.txt')
  const snap = snapshotState(domain)
  const before = existsSync(CHECKPOINT) ? JSON.parse(readFileSync(CHECKPOINT, 'utf8')) : null

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
  run.check('non-regular: target is still a directory', existsSync(join(domain, '.weir')) && statSync(join(domain, '.weir')).isDirectory())

  // Negative 3: out-of-domain edit refused at the Edit Lock boundary before
  // the sandbox backend is consulted; the denied file is byte-identical.
  run.check('boundary: out-of-domain hash_edit refused before any write', text.some((t) => t.includes('outside management domain')), text.join('\n').slice(-600))
  run.check('boundary: denied file bytes unchanged', existsSync(deniedPath) && readFileSync(deniedPath, 'utf8') === 'outside one\noutside two\n', existsSync(deniedPath) ? readFileSync(deniedPath, 'utf8') : 'missing')

  // The session policy is workspace-write at <domain>/narrow. The existing
  // target is inside the dedicated management root but outside this sandbox
  // root. The backend marker (not the domain error) proves the distinction.
  const sandboxPath = join(domain, 'sandbox-target.txt')
  const sandboxOp = (snap?.operations ?? []).find((o) => o.summary.includes('sandbox-target.txt'))
  run.check('sandbox: in-domain hash_edit reached the backend denial marker', text.some((t) => t.includes('[sandbox: file access denied under workspace-write mode]')), text.join('\n').slice(-600))
  run.check('sandbox: target lies within management root, outside session workspace', dirname(sandboxPath) === domain && dirname(sandboxPath) !== join(domain, 'narrow') && (sandboxOp ? JSON.parse(sandboxOp.summary).binding.cwd === join(domain, 'narrow') : false), sandboxOp?.summary ?? '<none>')
  run.check('sandbox: bytes before and after the denied publication match', !!before && before.bytes === readFileSync(sandboxPath).toString('base64'), 'checkpoint missing or bytes changed')
  run.check('sandbox: authority had no target operation or lock before dispatch', !!before && before.authority?.operations?.length === 3 && before.authority.operations.every((o) => !o.summary.includes('sandbox-target.txt')) && before.authority.locks.every((lock) => lock.resourceId !== sandboxPath), JSON.stringify(before?.authority))
  run.check('sandbox: dispatched denial is unknown with resource fence, not pre-dispatch', sandboxOp?.phase === 'unknown' && sandboxOp.fence?.kind === 'resource' && sandboxOp.fence.resourceId === sandboxPath, sandboxOp?.summary ?? '<none>')
  run.check('sandbox: previous authority operations survive unchanged', !!before && JSON.stringify(snap?.operations?.slice(0, 3)) === JSON.stringify(before.authority?.operations), JSON.stringify(snap?.operations?.map((o) => o.phase)))

  // Stale observed version reaches the backend CAS guard AFTER dispatch;
  // neither CAS nor sandbox rejection can be classified as pre-write.
  run.check('cas: stale-version write rejected (FS_STALE_VERSION)', text.some((t) => t.includes('file changed since it was read')), text.join('\n').slice(-600))
  run.check('cas: published bytes are exactly what hash_edit wrote (the rejected write never landed)', readWs('cas-target.txt') === 'revised\n', readWs('cas-target.txt'))

  const phases = (snap?.operations ?? []).map((o) => o.phase)
  run.check('authority: exactly five operations (created/updated/created/unknown/unknown)', JSON.stringify(phases) === JSON.stringify(['created', 'updated', 'created', 'unknown', 'unknown']), JSON.stringify(phases))
  const casOp = (snap?.operations ?? []).find((o) => o.phase === 'unknown' && o.summary.includes('cas-target.txt'))
  run.check('authority: the rejected CAS write settled unknown with a resource fence', casOp?.fence?.kind === 'resource' && casOp.fence.resourceId === join(domain, 'narrow', 'cas-target.txt'), casOp?.summary ?? '<none>')
  run.check('authority: mismatch/directory/domain refusals left no operation', (snap?.operations ?? []).every((o) => !o.summary.includes('denied.txt') && (!o.summary.includes('mismatch.txt') || o.phase === 'created')), JSON.stringify(phases))
  run.check('authority: both post-dispatch fenced locks retained', (snap?.locks ?? []).length === 2 && [sandboxPath, join(domain, 'narrow', 'cas-target.txt')].every((path) => snap.locks.some((lock) => lock.resourceId === path)), JSON.stringify(snap?.locks))
  run.check('settle: the turn-end notice reached the model for retained locks', text.some((t) => t.includes('the turn ended while this session still held')), text.join('\n').slice(-600))

  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_SANDBOX_NARROW: '1' }, decide, observe, assert }
