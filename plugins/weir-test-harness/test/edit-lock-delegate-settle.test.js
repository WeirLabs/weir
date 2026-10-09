import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { IT_ROOT } from '../src/mock-kit.js'
import scenario, { content } from '../src/scenarios/editlock-delegate-settle.js'

const target = join(IT_ROOT, 'ws', 'fixture.txt')
const childLock = { resourceId: target, owner: 'child', status: 'active', generation: 1 }
const parentLock = { resourceId: target, owner: 'parent', status: 'active', generation: 2 }
function request(role, toolNames, fields = {}) {
  return { lockRole: role, purpose: 'main', tools: role === 'child' ? ['read', 'write'] : ['delegate'], emitted: ['tool-call'], emittedNames: toolNames, ...fields }
}
function trace() {
  const rows = [
    { kind: 'agent-created', session: 'parent' },
    request('parent', ['delegate']),
    { kind: 'agent-created', session: 'child', origin: 'subagent', depth: 1 },
    request('child', ['read']),
    request('child', ['write'], { readSeen: true }),
    request('child', ['text'], { readSeen: true, updatedSeen: true, settleNoticeSeen: false, observedAt: 100, targetContent: content, managerIncarnation: 'manager', authorityLock: childLock, authoritySession: { interrupted: false } }),
    { kind: 'editlock-delegate-settle-boundary', session: 'child', target, lockBefore: childLock, lockAfter: childLock, stateAfter: 'active', interruptedAfter: false, holdAck: { sessionId: 'child', holding: true, lockCount: 1, holdCumulativeMs: 600_000, holdUntil: 600_200 }, retention: { sessionId: 'child', held: true, expired: false, remainingMs: 600_000, holdUntil: 600_200 }, observedAt: 150, error: null },
    { kind: 'session-event', session: 'child', type: 'turn/end', reason: 'completed' },
    request('parent', ['edit_lock_acquire'], { childResultSeen: true, authorityLock: null, observedAt: 160 }),
    request('parent', ['edit_lock_release'], { childResultSeen: true, acquiredSeen: true, authorityLock: parentLock, targetContent: content, managerIncarnation: 'manager', observedAt: 170 }),
    request('parent', ['text'], { childResultSeen: true, acquiredSeen: true, releasedSeen: true, authorityLock: null, observedAt: 180 }),
  ]
  return rows
}
function checks(rows) {
  const results = []
  scenario.assert({
    records: rows,
    requests: rows.filter(row => Array.isArray(row.emitted)),
    created: rows.filter(row => row.kind === 'agent-created'),
    stdout: 'parent acquired after child settlement', code: 0, stderr: '',
    check(label, ok) { results.push({ label, ok }) },
  })
  return results
}
function failing(rows) { return checks(rows).filter(result => !result.ok).map(result => result.label) }

describe('one-shot delegate active-lock settlement oracle', () => {
  it('accepts active ownership at final request and an independently acknowledged stopping hold', () => {
    const rows = trace()
    assert.equal('retention' in rows[5], false, 'final-request observation predates hold')
    assert.equal(checks(rows).length, 12)
    assert.deepEqual(failing(rows), [])
  })

  it('ignores a classifier sidecar even when it inherits the child prompt and emits text', () => {
    const rows = trace()
    rows.splice(6, 0, { ...request('child', ['text'], { updatedSeen: true }), tools: [], targetContent: content })
    assert.deepEqual(failing(rows), [])
  })

  it('rejects missing hold ACK, post-turn hold, early expiry, wrong generation, or cleanup notice', () => {
    const cases = [
      rows => { rows.splice(6, 1) },
      rows => { const boundary = rows.splice(6, 1)[0]; rows.splice(7, 0, boundary) },
      rows => { rows[6].holdAck = null },
      rows => { rows[6].holdAck.holdUntil = 169; rows[6].retention.holdUntil = 169 },
      rows => { rows[9].authorityLock = { ...parentLock, generation: 1 } },
      rows => { rows.splice(7, 0, { kind: 'inbox-inserted', session: 'child', text: 'Edit Lock: the turn ended while this session still held 1 file(s)' }) },
    ]
    for (const mutate of cases) {
      const rows = trace()
      mutate(rows)
      assert.ok(failing(rows).length > 0, `mutant must fail: ${mutate}`)
    }
  })

  it('requires acquire as the first post-delegate action and a genuine managed write', () => {
    const rows = trace()
    rows[8].emittedNames = ['edit_lock_status']
    assert.ok(failing(rows).some(label => label.includes('first post-delegate')))
    const unwritten = trace()
    unwritten[4].emittedNames = ['text']
    assert.ok(failing(unwritten).some(label => label.includes('managed write')))
  })

  it('fail-stops the parent when the delegate reports a stopped child', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'editlock-delegate-settle-parent' }] },
      { role: 'tool', content: [{ type: 'text', text: '## Settle child — completed\n\nDELEGATE_LOCK_PROBE_STOPPED' }] },
    ]
    const blocks = [...scenario.decide({ messages })].filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    assert.deepEqual(blocks, [{ type: 'text', text: 'DELEGATE_LOCK_PROBE_STOPPED' }])
  })
})
