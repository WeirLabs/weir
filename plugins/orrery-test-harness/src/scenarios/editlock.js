// Scenario: editlock — the edit-lock row mounted before hashline-edit (the
// preset order) with the feature enabled for this boot only: managed write
// creates, hash_edit publishes through the lock, owner tools work, the
// authority lands under <ws>/.orrery/edit-lock and its files are not editable.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock'
const prompt = 'editlock-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'locked.txt')

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if ((options.messages ?? []).at(-1)?.role !== 'tool') {
    return history.includes(prompt) ? toolCallChunks('write', { file_path: TARGET, content: 'first\n' }) : textChunks('unhandled editlock turn')
  }
  const toolText = lastOfRole(options, 'tool')
  if (!history.includes('read-done') && /Created file/.test(history) && !/1#[A-Z]{2}\|/.test(history)) {
    return toolCallChunks('read', { file_path: TARGET })
  }
  const anchor = /1#([ZPMQVRWSNKTXJBYH]{2})\| first/.exec(toolText)
  if (anchor) {
    return toolCallChunks('hash_edit', { file_path: TARGET, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'second' }] })
  }
  if (/hash_edit applied/.test(toolText)) return toolCallChunks('edit_lock_status', {})
  if (/owner=this session/.test(toolText) && !history.includes('authority-probe')) {
    return toolCallChunks('write', { file_path: join(WS, '.orrery', 'edit-lock', 'snapshot.json'), content: 'authority-probe' })
  }
  if (/not editable/.test(toolText)) return toolCallChunks('edit_lock_release', { file_path: TARGET })
  return textChunks('editlock done')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') }
}

function assert(run) {
  // Tool result text as the model saw it (the event tap carries no content).
  const text = run.requests.map((r) => r.lastTool ?? '')
  const tools = run.requests.flatMap((r) => r.tools ?? [])
  run.check('edit lock owner tools advertised', run.requests.some((r) => r.editLockToolsSeen) && ['edit_lock_acquire', 'edit_lock_release', 'edit_lock_status', 'edit_lock_try_steal'].every((name) => tools.includes(name)), JSON.stringify([...new Set(tools)]))
  run.check('stock edit hidden, managed write and hash_edit present', !tools.includes('edit') && tools.includes('write') && tools.includes('hash_edit'))
  run.check('managed write then hash_edit published through the lock', existsSync(join(run.ws, 'locked.txt')) && readFileSync(join(run.ws, 'locked.txt'), 'utf8') === 'second\n', existsSync(join(run.ws, 'locked.txt')) ? readFileSync(join(run.ws, 'locked.txt'), 'utf8') : 'missing')
  run.check('status reported this session as owner', text.some((t) => t.includes('owner=this session')), text.join('\n').slice(-800))
  // The snapshot is absent from committed replay fixtures (.orrery/ is ignored).
  const snapshot = join(run.ws, '.orrery', 'edit-lock', 'snapshot.json')
  run.check('authority files refused as edit targets', text.some((t) => t.includes('not editable')) && (!existsSync(snapshot) || readFileSync(snapshot, 'utf8') !== 'authority-probe'), text.join('\n').slice(-800))
  run.check('release succeeded', text.some((t) => t.includes('Released')), text.join('\n').slice(-800))
  run.check('reservation released after headless exit', !existsSync(join(run.ws, '.orrery', '.edit-lock.publisher-reservation')))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env: { ORRERY_IT_EDIT_LOCK: '1' }, decide, observe, assert }
