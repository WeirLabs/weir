// Scenario: editlock — the file-lease row mounted before hashline-edit (the
// preset order) with the feature enabled for this boot only (WEIR_IT_EDIT_LOCK).
//
// What this asserts after the rebuild (edit-lock-rebuild 3.8), i.e. only
// behaviour that still exists:
//   - the managed editor surface: stock `edit`/`write` are replaced, `write` and
//     `hash_edit` are the managed editors, and the six ownership tools exist;
//   - a managed edit claims its target implicitly, `edit_lock_status` reports it
//     as held by this session, `edit_lock_hold` retains it past the turn, and
//     `edit_lock_release` gives it back.
//
// What is deliberately NOT asserted any more (the mechanism is deleted, not
// merely unreachable): the durable authority image under `<ws>/.weir/edit-lock`,
// the publisher reservation file, `edit_lock_pause`, and edit-refusals for
// authority files. The claim lives in the broker's memory for one connection;
// nothing about it is written to disk.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock'
const prompt = 'editlock-probe'
const WS = join(IT_ROOT, 'ws')
const TARGET = join(WS, 'locked.txt')

const OWNER_TOOLS = ['edit_lock_acquire', 'edit_lock_hold', 'edit_lock_release', 'edit_lock_status', 'edit_lock_try_steal', 'edit_lock_watch']

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Every gate below is history-marker driven (never lastRole/lastOfRole): the
  // runtime-context snapshot arrives as a user message and can interleave with
  // tool results in either order — a role gate would re-run the write.
  if (!history.includes(prompt)) return textChunks('unhandled editlock turn')

  // Positive control: the managed writer creates the file, then hash_edit
  // rewrites it through the same per-turn claim.
  if (!/Created file/.test(history)) return toolCallChunks('write', { file_path: TARGET, content: 'first\n' })
  if (!/1#[A-Z]{2}\|/.test(history)) return toolCallChunks('read', { file_path: TARGET })
  if (!history.includes('hash_edit applied')) {
    const anchor = /1#([ZPMQVRWSNKTXJBYH]{2})\| first/.exec(history)
    if (anchor) {
      return toolCallChunks('hash_edit', { file_path: TARGET, edits: [{ op: 'replace', pos: `1#${anchor[1]}`, text: 'second' }] })
    }
    return textChunks('unhandled editlock turn')
  }

  // Ownership surface: the implicit claim is visible, can be retained, and can
  // be given back.
  if (!history.includes('Held by this session')) return toolCallChunks('edit_lock_status', {})
  if (!history.includes('Kept 1 path(s)')) return toolCallChunks('edit_lock_hold', { paths: [TARGET], minutes: 30 })
  if (!history.includes('Released 1 path(s)')) return toolCallChunks('edit_lock_release', { paths: [TARGET] })
  return textChunks('editlock done')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire') }
}

function assert(run) {
  // Tool result text as the model saw it (the event tap carries no content).
  const text = run.requests.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`)
  const tools = run.requests.flatMap((r) => r.tools ?? [])
  const target = join(run.ws, 'locked.txt')
  run.check('file lease owner tools advertised', run.requests.some((r) => r.editLockToolsSeen) && OWNER_TOOLS.every((name) => tools.includes(name)), JSON.stringify([...new Set(tools)]))
  run.check('the negotiation reply tool stays out of the catalog with nothing pending', !tools.includes('edit_lock_reply'), JSON.stringify([...new Set(tools)]))
  // The release subscription is a peer of the ownership verbs: always present,
  // and unavailable to children through the shared deny list.
  run.check('release subscription tool advertised', tools.includes('edit_lock_watch'), JSON.stringify([...new Set(tools)]))
  run.check('stock edit and write hidden, managed write and hash_edit present', !tools.includes('edit') && tools.includes('write') && tools.includes('hash_edit'))
  run.check('managed write then hash_edit published', existsSync(target) && readFileSync(target, 'utf8') === 'second\n', existsSync(target) ? readFileSync(target, 'utf8') : 'missing')
  run.check('status reported this session as the holder', text.some((t) => t.includes('Held by this session')), text.join('\n').slice(-800))
  // Retention: a bounded keep extends the claim past the turn, and the tool
  // says when it ends. No budget, no accumulated allowance, no notice.
  run.check('retention tool advertised', tools.includes('edit_lock_hold'), JSON.stringify([...new Set(tools)]))
  run.check('bounded retention accepted', text.some((t) => /Kept 1 path\(s\) past this turn/.test(t)), text.join('\n').slice(-800))
  run.check('release gave the path back', text.some((t) => t.includes('Released 1 path(s)')), text.join('\n').slice(-800))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env: { WEIR_IT_EDIT_LOCK: '1' }, decide, observe, assert }
