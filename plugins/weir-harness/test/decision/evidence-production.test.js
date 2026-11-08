import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionBroker } from '../../src/decision/broker.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-evidence-production-'))
  const workspace = realpathSync(dir)
  const reads = []
  let citeAll = true
  const agent = { id: 'root', session: { header: { id: 'root', cwd: dir, delegationDepth: 0 }, requestContext: () => ({ provider: 'p', model: 'm' }) } }
  const ctx = {
    agents: { get: id => id === 'root' ? agent : undefined },
    fs: {
      resolve: async path => ({ targetKey: path, displayPath: path }),
      contains: () => true,
      stat: async () => ({ type: 'file', version: 'v1' }),
      readText: async target => { reads.push(target.displayPath); return 'The documented GUI title is Concise.' },
    },
    llm: { stream: options => (async function * () {
      const content = options.messages[0].content
      const pack = JSON.parse(typeof content === 'string' ? content : content[0].text)
      const evidenceIds = citeAll ? pack.L5.map(ref => ref.evidenceId) : pack.L5.filter(ref => ref.source === 'user_decision').slice(0, 1).map(ref => ref.evidenceId)
      yield { type: 'text-delta', text: JSON.stringify({ outcome: 'answer', claims: [{ text: 'Use the evidenced answer.', evidenceIds }], answers: [{ id: pack.L4.request.questions[0].id, selected: [pack.L4.request.questions[0].options[0].label] }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
  }
  const broker = new DecisionBroker({ profileContext: { home: dir, name: 'test' }, ctx, config: () => ({ decisionAgentsEnabled: true }) })
  await broker.start()
  const profile = await broker.profileUpsert({ workspaceKey: workspace, name: 'A' })
  await broker.setSelector('root', 'agent', profile.agentId)
  t.after(async () => { await broker.flush(); rmSync(dir, { recursive: true, force: true }) })
  return { broker, agent, profile, workspace, reads, setCiteAll: value => { citeAll = value } }
}

async function userDecision(broker, input) {
  const questionId = input.questionId ?? 'q'
  let current = (await broker.cases.createCase({ workspaceKey: input.workspaceKey, rootSessionId: 'root', entry: 'hook', agentId: input.agentId, request: { questions: [{ id: questionId, question: input.question, options: input.options }] }, scope: { workspaces: [input.workspaceKey] }, idempotencyKey: input.idempotencyKey })).case
  current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'awaiting_user' })
  current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'awaiting_user', expectedRevision: current.revision, state: 'closed', closing: 'escalated', decision: { kind: 'user_decision', answers: [{ id: questionId, selected: [input.selected] }] } })
  await broker.evidence.add({ agentId: input.agentId, source: 'user_decision', locator: { kind: 'case', caseId: current.caseId }, scope: current.scope })
  return current
}

test('candidate expansion includes the authoritative question and selected answer', async t => {
  const f = await fixture(t)
  const source = await userDecision(f.broker, { agentId: f.profile.agentId, workspaceKey: f.workspace, idempotencyKey: 'expand', question: 'Which GUI title?', options: [{ label: 'Concise' }, { label: 'Long' }], selected: 'Concise' })
  const candidates = f.broker.evidence.candidates({ agentId: f.profile.agentId, workspaceKey: f.workspace, scope: { workspaces: [f.workspace] } })
  const ref = candidates.find(item => item.locator.caseId === source.caseId)
  assert.match(ref.excerpt ?? '', /Which GUI title/)
  assert.match(ref.excerpt ?? '', /Concise/)
})

test('production G4 rejects contradictory same-scope user decisions', async t => {
  const f = await fixture(t)
  await userDecision(f.broker, { agentId: f.profile.agentId, workspaceKey: f.workspace, idempotencyKey: 'left', question: 'Which GUI title?', options: [{ label: 'Concise' }, { label: 'Long' }], selected: 'Concise' })
  await userDecision(f.broker, { agentId: f.profile.agentId, workspaceKey: f.workspace, idempotencyKey: 'right', question: 'Which GUI title?', options: [{ label: 'Concise' }, { label: 'Long' }], selected: 'Long' })
  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [{ id: 'q', question: 'Which GUI title?', options: [{ label: 'Concise' }, { label: 'Long' }] }] } })
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.code, 'CONFLICTING_EVIDENCE')
})
test('G4 covers different request-local ids and a response citing only one conflicting side', async t => {
  const f = await fixture(t)
  f.setCiteAll(false)
  await userDecision(f.broker, { agentId: f.profile.agentId, workspaceKey: f.workspace, idempotencyKey: 'local-left', questionId: 'left-local', question: 'Which GUI title?', options: [{ label: 'Concise' }, { label: 'Long' }], selected: 'Concise' })
  await userDecision(f.broker, { agentId: f.profile.agentId, workspaceKey: f.workspace, idempotencyKey: 'local-right', questionId: 'right-local', question: 'Which GUI title?', options: [{ label: 'Concise' }, { label: 'Long' }], selected: 'Long' })
  const verdict = await f.broker.hook({ agent: f.agent, request: { questions: [{ id: 'new-local', question: 'Which GUI title?', options: [{ label: 'Concise' }, { label: 'Long' }] }] } })
  assert.equal(verdict.kind, 'pass')
  assert.equal(verdict.code, 'CONFLICTING_EVIDENCE')
})

test('consult file hints become fresh current observations with bounded content', async t => {
  const f = await fixture(t)
  const result = await f.broker.consult({ agent: f.agent, args: { question: 'Choose the documented GUI title', options: [{ label: 'Concise' }, { label: 'Long' }], evidence: [{ path: 'notes.md', excerpt_hint: 'Concise' }] } })
  assert.equal(result.outcome, 'answered', JSON.stringify({ result, attempts: f.broker.attempts.forCase(result.caseId) }))
  const refs = f.broker.attempts.forCase(result.caseId).flatMap(attempt => f.broker.evidence.forAttempt(attempt.attemptId))
  const observation = refs.find(ref => ref.source === 'current_observation')
  assert.ok(observation, 'the file hint must create a current_observation ref')
  assert.match(observation.excerpt ?? '', /Concise/)
  assert.ok(observation.hash)
  assert.ok(observation.observedAt)
  assert.deepEqual(f.reads, ['notes.md'])
})

test('an upvoted answered Case gains an agent_record ref in the same feedback projection', async t => {
  const f = await fixture(t)
  let current = (await f.broker.cases.createCase({ workspaceKey: f.workspace, rootSessionId: 'root', entry: 'hook', agentId: f.profile.agentId, request: { questions: [{ id: 'q', question: 'Which GUI title?' }] }, scope: { workspaces: [f.workspace] }, idempotencyKey: 'upvote' })).case
  current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'received', expectedRevision: current.revision, state: 'evaluating' })
  current = await f.broker.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'closed', closing: 'answered', decision: { kind: 'answer', attemptId: 'da_test', answers: [{ id: 'q', selected: ['Concise'] }] } })
  await f.broker.feedbackStore.append({ actor: { kind: 'user' }, caseId: current.caseId, kind: 'rating_up' })
  const refs = f.broker.evidence.candidates({ agentId: f.profile.agentId, workspaceKey: f.workspace, scope: { workspaces: [f.workspace] } })
  assert.ok(refs.some(ref => ref.source === 'agent_record' && ref.locator.caseId === current.caseId))
})
