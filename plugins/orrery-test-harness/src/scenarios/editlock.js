// Scenario: editlock — the edit-lock row mounted before hashline-edit (the
// preset order) with the feature enabled for this boot only: managed write
// creates, hash_edit publishes through the lock, owner tools work, the
// authority lands under <ws>/.orrery/edit-lock and its files are not editable.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock'
const prompt = 'editlock-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'locked.txt')

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Every gate below is history-marker driven (never lastRole/lastOfRole):
  // the turn-end settling notice and runtime-context snapshots both arrive as
  // user messages and can interleave with tool results in either order — a
  // role gate would shadow the notice or re-run the state-rewriting write.
  if (!history.includes(prompt)) return textChunks('unhandled editlock turn')

  // The turn-end settling notice: answer the FIRST one with a bounded
  // reservation ('Keeping' marks the hold result, so the hold never re-arms);
  // once reserved, surface the reservation in status and release it, so the
  // batch ends instead of being held forever.
  if (history.includes('Edit Lock: the turn ended while this session still held')) {
    if (!/Keeping \d+ file/.test(history)) return toolCallChunks('edit_lock_hold', { minutes: 30 })
    if (!history.includes('Reserved for')) return toolCallChunks('edit_lock_status', {})
    if (!history.includes('Released')) return toolCallChunks('edit_lock_release', { file_path: TARGET })
    return textChunks('editlock done')
  }

  if (!/Created file/.test(history)) return toolCallChunks('write', { file_path: TARGET, content: 'first\n' })
  if (!/1#[A-Z]{2}\|/.test(history)) return toolCallChunks('read', { file_path: TARGET })
  if (!history.includes('hash_edit applied')) {
    const anchor = /1#([ZPMQVRWSNKTXJBYH]{2})\| first/.exec(history)
    if (anchor) {
      return toolCallChunks('hash_edit', { file_path: TARGET, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'second' }] })
    }
    return textChunks('unhandled editlock turn')
  }
  if (!history.includes('owner=this session')) return toolCallChunks('edit_lock_status', {})
  // Authority files are refused as edit targets; the REFUSAL text is the
  // visible terminal marker (the write's content args never render into the
  // transcript, so keying on 'authority-probe' would re-dispatch forever).
  // Ending the turn still holding lets the turn-end settling notice take over.
  if (history.includes('not editable')) return textChunks('editlock turn ends holding')
  if (!history.includes('Keeping')) {
    return toolCallChunks('write', { file_path: join(WS, '.orrery', 'edit-lock', 'snapshot.json'), content: 'authority-probe' })
  }
  return textChunks('editlock done')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') }
}

function assert(run) {
  // Tool result text as the model saw it (the event tap carries no content).
  const text = run.requests.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`)
  const tools = run.requests.flatMap((r) => r.tools ?? [])
  run.check('edit lock owner tools advertised', run.requests.some((r) => r.editLockToolsSeen) && ['edit_lock_acquire', 'edit_lock_release', 'edit_lock_status', 'edit_lock_try_steal'].every((name) => tools.includes(name)), JSON.stringify([...new Set(tools)]))
  run.check('stock edit hidden, managed write and hash_edit present', !tools.includes('edit') && tools.includes('write') && tools.includes('hash_edit'))
  run.check('managed write then hash_edit published through the lock', existsSync(join(run.ws, 'locked.txt')) && readFileSync(join(run.ws, 'locked.txt'), 'utf8') === 'second\n', existsSync(join(run.ws, 'locked.txt')) ? readFileSync(join(run.ws, 'locked.txt'), 'utf8') : 'missing')
  run.check('status reported this session as owner', text.some((t) => t.includes('owner=this session')), text.join('\n').slice(-800))
  // The snapshot is absent from committed replay fixtures (.orrery/ is ignored).
  const snapshot = join(run.ws, '.orrery', 'edit-lock', 'snapshot.json')
  run.check('authority files refused as edit targets', text.some((t) => t.includes('not editable')) && (!existsSync(snapshot) || readFileSync(snapshot, 'utf8') !== 'authority-probe'), text.join('\n').slice(-800))
  // Retention: an explicit bounded keep is advertised, succeeds, and is visible in
  // status as the one thing the user acts on (how long the files stay reserved).
  run.check('retention tool advertised', tools.includes('edit_lock_hold'), JSON.stringify(tools))
  run.check('bounded reservation accepted', text.some((t) => /Keeping \d+ file/.test(t)), text.join('\n').slice(-800))
  run.check('status reports the reservation', text.some((t) => t.includes('Reserved for')), text.join('\n').slice(-800))
  run.check('release succeeded', text.some((t) => t.includes('Released')), text.join('\n').slice(-800))
  run.check('reservation released after headless exit', !existsSync(join(run.ws, '.orrery', '.edit-lock.publisher-reservation')))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env: { ORRERY_IT_EDIT_LOCK: '1' }, decide, observe, assert }
