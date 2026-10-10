import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { plannedCase } from '../src/scenarios/planned-compaction.js'

function replay(mode = 'success', change = (records) => records) {
  const scenario = plannedCase(mode)
  const root = new URL(`./fixtures/traces/${scenario.id}/`, import.meta.url)
  const records = change(readFileSync(new URL('trace.jsonl', root), 'utf8').trim().split('\n').map(JSON.parse))
  const run = JSON.parse(readFileSync(new URL('run.json', root), 'utf8'))
  const failures = []
  scenario.assert({ ...run, records, requests: records.filter((r) => Array.isArray(r.emitted)), events: records.filter((r) => r.kind === 'session-event'), inboxInserted: records.filter((r) => r.kind === 'inbox-inserted'),
    check: (label, ok) => { if (!ok) failures.push(label) },
  })
  return failures
}
for (const mode of ['success', 'busy', 'wake', 'cancel', 'noop', 'hard']) {
  it(`${mode}: real native outcome recording replays green`, () => assert.deepEqual(replay(mode), []))
}
it('a queued tool result or inbox resume alone cannot pass', () => {
  assert.ok(replay('success', (records) => records.filter((r) => !(r.purpose === 'main' && r.plannedSummaryRead))).includes('subsequent main model request actually reads native summary and resume'))
})
for (const type of ['tool/result', 'turn/end', 'compaction/start', 'compaction/summary', 'compaction/end']) {
  it(`rejects absent ${type} from the commit chain`, () => assert.ok(replay('success', (records) => records.filter((r) => r.type !== type)).length > 0))
}
it('rejects an absent replacement checkpoint', () => assert.ok(replay('success', (records) => records.filter((r) => r.source !== 'compact-checkpoint')).length > 0))

it('subject dispatch ignores a parent marker present only in the runtime-context path', () => {
  const markerPath = '/workspace/qa-planned-compaction-parent-20261011-001/ws'
  const subject = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'planned-compaction-subject' }] }
  const runtime = { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: `Workspace: ${markerPath}` }] }
  const observation = { messages: [subject, runtime], transcript: `user:\nplanned-compaction-subject\n---\nuser:\nWorkspace: ${markerPath}` }
  const emitted = [...plannedCase().decide({}, observation)].filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block?.name)
  assert.deepEqual(emitted, ['todo_write'])
})
