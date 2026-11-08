import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionFeedback } from '../../src/decision/store/feedback.js'

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-feedback-'))
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const cases = new DecisionCases(store)
  const audits = []
  const feedback = new DecisionFeedback(store, { audit: (kind, value) => audits.push({ kind, value }) })
  const created = await cases.createCase({ workspaceKey:'/repo',rootSessionId:'root',entry:'consult',agentId:'agent-a',request:{questions:[]},scope:{workspaces:['/repo']},idempotencyKey:'feedback-case' })
  t.after(() => { store.close(); rmSync(dir,{recursive:true,force:true}) })
  return { store,cases,feedback,current:created.case,audits }
}

test('rating down is immediate, undo preserves both events, and comments stay neutral', async t => {
  const { store,feedback,current } = await fixture(t)
  await feedback.append({actor:{kind:'user'},caseId:current.caseId,kind:'rating_down'})
  assert.equal(casesProjection(store,current.caseId).feedback_state,'disputed')
  await feedback.append({actor:{kind:'user'},caseId:current.caseId,kind:'undo_rating_down'})
  assert.equal(casesProjection(store,current.caseId).feedback_state,'none')
  await feedback.append({actor:{kind:'user'},caseId:current.caseId,kind:'comment',payload:{text:'nuance'}})
  assert.equal(casesProjection(store,current.caseId).feedback_state,'none')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n,3)
})

test('only the user can write Feedback', async t => {
  const { feedback,current } = await fixture(t)
  await assert.rejects(feedback.append({actor:{kind:'agent'},caseId:current.caseId,kind:'rating_down'}),error=>error.code==='USER_FEEDBACK_ONLY')
})

test('Correction requires direction, scope and supersedes and becomes active immediately', async t => {
  const { store,feedback,current } = await fixture(t)
  for (const payload of [{direction:'x'},{direction:'x',scope:{workspaces:['/repo']}},{scope:{workspaces:['/repo']},supersedes:[]}]) {
    await assert.rejects(feedback.append({actor:{kind:'user'},caseId:current.caseId,kind:'correction',payload}),error=>error.code==='INVALID_CORRECTION')
  }
  await feedback.append({actor:{kind:'user'},caseId:current.caseId,kind:'correction',payload:{direction:'Use B',scope:{workspaces:['/repo']},supersedes:[current.caseId]}})
  const active = feedback.activeCorrections('agent-a','/repo')
  assert.equal(active.length,1)
  assert.equal(active[0].direction,'Use B')
  assert.deepEqual(active[0].supersedes,[current.caseId])
  const ref = store.db.prepare("SELECT evidence_id,source,excerpt,status FROM evidence WHERE agent_id='agent-a' AND json_extract(locator_json,'$.feedbackId')=?").get(active[0].feedbackId)
  assert.equal(ref?.source,'user_correction')
  assert.equal(ref?.excerpt,'Use B')
  assert.equal(ref?.status,'active')
})
test('Correction supersedes targets cannot cross Agent or workspace namespaces', async t => {
  const { store,cases,feedback,current,audits } = await fixture(t)
  const foreign = (await cases.createCase({ workspaceKey:'/other',rootSessionId:'other',entry:'consult',agentId:'agent-b',request:{questions:[]},scope:{workspaces:['/other']},idempotencyKey:'foreign-case' })).case
  await feedback.append({ actor: { kind: 'user' }, caseId: foreign.caseId, kind: 'correction', payload: { direction: 'Foreign direction', scope: { workspaces: ['/other'] }, supersedes: [] } })
  await assert.rejects(feedback.append({ actor: { kind: 'user' }, caseId: current.caseId, kind: 'correction', payload: { direction: 'Use B', scope: { workspaces: ['/repo'] }, supersedes: [foreign.caseId] } }), error => error.code === 'OUT_OF_SCOPE')
  assert.equal(store.db.prepare("SELECT status FROM evidence WHERE agent_id='agent-b' AND source='user_correction'").get().status, 'active')
  assert.equal(feedback.activeCorrections('agent-a','/repo').length, 0)
  assert.ok(audits.some(event => event.kind === 'feedback' && event.value.rejected === 'cross-namespace-target'))
})

/** @param {import('../../src/decision/store/db.js').DecisionDatabase} store @param {string} caseId */
function casesProjection(store,caseId) { return store.db.prepare('SELECT feedback_state FROM cases WHERE case_id=?').get(caseId) }
