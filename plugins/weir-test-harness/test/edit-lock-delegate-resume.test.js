import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import scenario, { firstTarget, freshTarget } from '../src/scenarios/editlock-delegate-resume.js'
import { apply, inject } from '../src/edit-lock-delegate-resume-probe.js'

// The interrupted first managed write is scenario-private: the probe, the assert
// and the child's creation all key on it, never on a fixture another scenario rewrote.
const lock = (resource, status) => ({ resourceId: resource, owner: 'child', status, generation: 1 })
const session = (executionEpoch, interrupted) => ({ sessionId: 'child', executionEpoch, interrupted })
const tool = (name, fields = {}) => ({ kind: 'resume-tool-result', session: 'parent', name, isError: false, ...fields })
const request = fields => ({ purpose: 'main', tools: ['read', 'write'], authorityLocks: [], authoritySessions: [], ...fields })
function trace() {
  return [
    { kind: 'agent-created', session: 'child', origin: 'subagent' },
    tool('delegate'),
    { kind: 'resume-interrupt-before', session: 'child', lock: lock(firstTarget, 'active'), authoritySession: session(1, false), continuationBlocked: false },
    { kind: 'resume-interrupt-issued', session: 'child' },
    { kind: 'resume-child-turn-end', reason: { kind: 'aborted', reason: { kind: 'user' } } },
    { type: 'weir/supervision/settle', data: { childId: 'child', status: 'blocked' } },
    { source: 'subagent-settled', text: 'Background subagent child was stopped before it finished.' },
    request({ lockRole: 'parent', authorityLocks: [lock(firstTarget, 'user-interrupted')], authoritySessions: [session(2, true)] }),
    tool('supervised_status', { text: 'Supervised registry: r2-child — blocked —' }),
    { type: 'weir/supervision/resume', data: { childId: 'child' } },
    // Same durable child, replacement Agent incarnation is legitimate.
    { kind: 'agent-created', session: 'child', origin: 'subagent' },
    tool('resume_agent'),
    request({ lockRole: 'child', resumed: true, authorityLocks: [lock(firstTarget, 'pending-confirmation')], authoritySessions: [session(3, false)] }),
    tool('write', { session: 'child', args: { file_path: freshTarget }, text: `Created file: ${freshTarget}` }),
    request({ lockRole: 'child', freshContent: 'same child resumed managed write\n' }),
    { type: 'weir/supervision/settle', data: { childId: 'child', status: 'completed', report: 'R2_RESUMED_WRITE_DONE' } },
  ]
}
function failures(records) {
  const checks = []
  scenario.assert({ records, created: records.filter(r => r.kind === 'agent-created'), requests: records.filter(r => r.purpose), stdout: 'parent observed R2 resumed completion', stderr: '', code: 0, check: (label, ok) => checks.push({ label, ok }) })
  assert.equal(checks.length, 10)
  return checks.filter(c => !c.ok).map(c => c.label)
}
function decide(messages) {
  return [...scenario.decide({ messages })].filter(c => c.type === 'block-end').map(c => c.block)
}
const message = (role, text) => ({ role, content: [{ type: 'text', text }] })
describe('supervised Edit Lock resume reproduction', () => {
  it('accepts same-session cold replacement with explicit resume and a new publication', () => {
    assert.deepEqual(failures(trace()), [])
  })
  it('rejects authority, identity, ordering and publication regressions', () => {
    for (const mutate of [
      rows => { rows[13].isError = true },
      rows => { rows[13].session = 'other-child' },
      rows => { rows[13].text = `Updated file: ${freshTarget}` },
      rows => { rows[12].authoritySessions = [session(2, true)] },
      rows => { rows[12].authorityLocks = [lock(firstTarget, 'active')] },
      // The file interrupted in epoch 1 must be the very resource that stays
      // pending confirmation after the explicit resume.
      rows => { rows[12].authorityLocks = [lock(freshTarget, 'pending-confirmation')] },
      rows => { rows[11].name = 'send_message' },
      rows => { rows.push(rows.splice(8, 1)[0]) },
      rows => { rows.push({ kind: 'agent-created', session: 'other-child', origin: 'subagent' }) },
    ]) {
      const rows = trace(); mutate(rows)
      assert.ok(failures(rows).length > 0, `must reject ${mutate}`)
    }
  })
  it('uses installed stopped notice then reads registry before explicit resume', () => {
    const history = [message('user', scenario.prompt), message('tool', 'Supervised group r2-child completed/blocked'), message('user', 'Background subagent child was stopped before it finished.')]
    assert.equal(decide(history)[0].name, 'supervised_status')
    history.push(message('tool', 'Supervised registry: r2-child — blocked —'))
    assert.equal(decide(history)[0].name, 'resume_agent')
  })
  it('stops on first editing refusal without another write or delegation', () => {
    for (const roleMarker of [scenario.prompt, 'TASK: editlock-delegate-resume-child:']) {
      const blocks = decide([message('user', roleMarker), message('tool', 'Error: Edit Lock refused: editing stopped')])
      assert.equal(blocks[0].type, 'text')
      assert.match(blocks[0].text, /R2_EDIT_REFUSED_STOP/)
    }
  })
  it('requires both scenario environment gate and enabled config', () => {
    const old = process.env.WEIR_IT_SCENARIO
    let registrations = 0
    const ctx = { on() { registrations++ } }
    try {
      process.env.WEIR_IT_SCENARIO = 'other'
      apply(ctx, { enabled: true })
      process.env.WEIR_IT_SCENARIO = scenario.id
      apply(ctx, { enabled: false })
      assert.equal(registrations, 0)
      apply(ctx, { enabled: true })
      assert.equal(registrations, 6)
      assert.deepEqual(inject, ['subagents', 'weirEditLock'])
    } finally {
      if (old === undefined) delete process.env.WEIR_IT_SCENARIO
      else process.env.WEIR_IT_SCENARIO = old
    }
  })
})
