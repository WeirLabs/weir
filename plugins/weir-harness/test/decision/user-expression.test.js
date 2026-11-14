import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

// User autonomy on pending decisions: bounce-to-caller (the one new state
// transition) and the read-only clarify loop (clarify-contract/1).
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-expr-'))
  const workspace = realpathSync(dir)
  const audits = []
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  let evaluation = { outcome: 'escalate', missing: ['New judgment'] }
  let clarification = 'The pack only covers the title decision; the rollout window is genuinely open.'
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    llm: { stream: options => (async function * () {
      const isClarify = options.system.includes('clarify-contract/1')
      yield { type: 'text-delta', text: isClarify ? clarification : JSON.stringify(evaluation) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
  }
  const config = { decisionAgentsEnabled: true, decisionAgentAutoAnswerClasses: ['A', 'B', 'C'] }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => config, audit: (kind, value) => audits.push({ kind, value }) })
  await broker.start()
  const a = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  await broker.setSelector('root', 'agent', a.agentId)
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  async function open(callId) {
    const request = { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], wait: { callId } }
    const verdict = await broker.hook({ agent, request })
    return { verdict, request, current: broker.cases.getCase(verdict.caseId) }
  }
  return {
    broker, agent, a, workspace, audits, open,
    respond: value => { evaluation = value },
    clarifyWith: value => { clarification = value },
  }
}

test('bounce moves awaiting_user to awaiting_revision with the note and turn-end closes returned', async t => {
  const f = await fixture(t)
  const { current } = await f.open('b1')
  assert.equal(current.state, 'awaiting_user')

  const bounced = await f.broker.mutate({ action: 'returnToCaller', caseId: current.caseId, note: '这个问题的前提是错的，请回到任务背景重新组织。' })
  assert.equal(bounced.state, 'awaiting_revision')
  assert.equal(bounced.escalation.bounce, '这个问题的前提是错的，请回到任务背景重新组织。')
  assert.ok(f.audits.some(entry => entry.kind === 'outcome' && entry.value.action === 'returnToCaller'))
  // The escalate evaluation produced one attempt; the bounce adds none.
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1)

  await assert.rejects(f.broker.mutate({ action: 'decide', caseId: current.caseId, answers: [{ id: 'q', selected: ['A'] }] }), /NOT_AWAITING_USER/)
  const closed = await f.broker.turnStopping({ agent: f.agent })
  assert.equal(closed.closed, 1)
  assert.equal(f.broker.cases.getCase(current.caseId).closing, 'returned')
})

test('bounce requires a note and a pending case', async t => {
  const f = await fixture(t)
  const { current } = await f.open('b2')
  await assert.rejects(f.broker.mutate({ action: 'returnToCaller', caseId: current.caseId, note: '' }), /MISSING_CONTEXT/)
  await f.broker.mutate({ action: 'cancel', caseId: current.caseId })
  await assert.rejects(f.broker.mutate({ action: 'returnToCaller', caseId: current.caseId, note: '太晚' }), /NOT_RECOVERABLE/)
})

test('bounced consult rereads as returned with the user note as the repair hint', async t => {
  const f = await fixture(t)
  await f.broker.consult({ agent: f.agent, args: { question: 'Bounce me?', options: [{ label: 'A' }], request_id: 'bounce-consult', authorization_class: 'A' } })
  const pending = f.broker.store.db.prepare("SELECT case_id FROM cases WHERE state='awaiting_user'").get()
  await f.broker.mutate({ action: 'returnToCaller', caseId: pending.case_id, note: '先补充受众背景再问。' })
  const reread = await f.broker.consult({ agent: f.agent, args: { question: 'Bounce me?', options: [{ label: 'A' }], request_id: 'bounce-consult', authorization_class: 'A' } })
  assert.equal(reread.outcome, 'returned')
  assert.equal(reread.hint, '先补充受众背景再问。')
})

test('clarify appends a rating-neutral read-only record and never touches gates or evidence', async t => {
  const f = await fixture(t)
  const { current } = await f.open('c1')
  const evidenceBefore = f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n
  const answered = await f.broker.clarify({ caseId: current.caseId, question: '现有依据讲了什么？' })
  assert.equal(answered.state, 'awaiting_user')
  const rows = f.broker.store.db.prepare("SELECT * FROM feedback WHERE case_id=? AND kind='clarify'").all(current.caseId)
  assert.equal(rows.length, 1)
  const payload = JSON.parse(rows[0].payload_json)
  assert.equal(payload.question, '现有依据讲了什么？')
  assert.match(payload.answer, /genuinely open/)
  assert.equal(f.broker.store.db.prepare("SELECT feedback_state FROM cases WHERE case_id=?").get(current.caseId).feedback_state, 'none')
  assert.equal(f.broker.store.db.prepare('SELECT COUNT(*) AS n FROM evidence').get().n, evidenceBefore)
  assert.ok(f.audits.some(entry => entry.kind === 'feedback' && entry.value.kind === 'clarify'))
})

test('clarify rejects unowned, non-pending, over-limit, and answer-shaped output', async t => {
  const f = await fixture(t)
  const { current } = await f.open('c2')
  f.clarifyWith('{"outcome":"answer","answers":[{"id":"q","selected":["A"]}]}')
  await assert.rejects(f.broker.clarify({ caseId: current.caseId, question: '直接告诉我选哪个？' }), /CLARIFY_FAILED/)
  f.clarifyWith('Plain clarification one.')
  await f.broker.clarify({ caseId: current.caseId, question: '问题一' })
  await f.broker.clarify({ caseId: current.caseId, question: '问题二' })
  await f.broker.clarify({ caseId: current.caseId, question: '问题三' })
  await assert.rejects(f.broker.clarify({ caseId: current.caseId, question: '问题四' }), /CLARIFY_LIMIT/)
  await f.broker.mutate({ action: 'cancel', caseId: current.caseId })
  await assert.rejects(f.broker.clarify({ caseId: current.caseId, question: '已关闭' }), /NOT_RECOVERABLE/)

  const unowned = await f.open('c3')
  await f.broker.mutate({ action: 'reassign', caseId: unowned.current.caseId, agentId: f.a.agentId })
  await f.broker.turnStopping({ agent: f.agent })
})
