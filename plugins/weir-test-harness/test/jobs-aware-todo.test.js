import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import scenario from '../src/scenarios/jobs-aware-todo.js'

function replay(change = () => {}) {
  const root = new URL('./fixtures/traces/jobs-aware-todo/', import.meta.url)
  const run = JSON.parse(readFileSync(new URL('run.json', root), 'utf8'))
  const records = readFileSync(new URL('trace.jsonl', root), 'utf8').trim().split('\n').map(JSON.parse)
  change(records, run)
  const failures = []
  scenario.assert({ ...run, records, requests: records.filter((r) => Array.isArray(r.emitted)),
    events: records.filter((r) => r.kind === 'session-event'), inboxInserted: records.filter((r) => r.kind === 'inbox-inserted'),
    check: (label, ok) => { if (!ok) failures.push(label) },
  })
  return failures
}
it('outer-owner recording proves all native lifecycle and clean-exit assertions', () => assert.deepEqual(replay(), []))
for (const [kind, key, value] of [
  ['jobs-aware-before-wait', 'completed', false],
  ['jobs-aware-before-wait', 'todoPending', false],
  ['jobs-aware-before-wait', 'noContinuation', false],
  ['jobs-aware-before-wait', 'noInboxContinuation', false],
  ['jobs-aware-after-wait', 'endSeq', -1],
  ['jobs-aware-settlement', 'awaited', false],
  ['jobs-aware-settlement', 'cause', 'teardown'],
]) it(`rejects ${kind}.${key}=${value}`, () => assert.ok(replay((r) => { r.find((x) => x.kind === kind)[key] = value }).length > 0))
for (const [kind, status] of [['jobs-aware-before-wait', 'completed'], ['jobs-aware-after-wait', 'running'], ['jobs-aware-after-wait', 'failed']]) {
  it(`rejects ${kind} status ${status} (timeout is not completion)`, () => assert.ok(replay((r) => { r.find((x) => x.kind === kind).job.status = status }).length > 0))
}
it('still rejects a nonzero headless exit even with green behavior', () => {
  assert.ok(replay((_r, run) => { run.code = 1 }).includes('headless run exited cleanly'))
})
it('rejects continuation in each observation channel independently', () => {
  for (const channel of ['log', 'inbox', 'model']) {
    assert.ok(replay((records) => {
      const session = records.find((r) => r.kind === 'jobs-aware-subject').session
      records.push(channel === 'log' ? { kind: 'session-event', session, type: 'user/message', text: '<todo_continuation>' }
        : channel === 'inbox' ? { kind: 'inbox-inserted', session, text: '<todo_continuation>' }
        : { emitted: [], jobsAwareParent: true, continuationSeen: true, emittedNames: [] })
    }).length > 0)
  }
})
it('missing probe evidence cannot silently pass', () => assert.ok(replay((records) => {
  records.splice(records.findIndex((r) => r.kind === 'jobs-aware-before-wait'), 1)
}).length > 0))
