import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionCases } from '../../src/decision/store/cases.js'
import { DecisionEvidence, scopeCovers } from '../../src/decision/store/evidence.js'
import { DecisionFeedback } from '../../src/decision/store/feedback.js'

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'weir-decision-evidence-'))
  const store=openDecisionDatabase(join(dir,'decision.db'))
  const cases=new DecisionCases(store)
  const evidence=new DecisionEvidence(store)
  const feedback=new DecisionFeedback(store)
  const current=(await cases.createCase({workspaceKey:'/repo',rootSessionId:'root',entry:'hook',agentId:'agent-a',request:{questions:[]},scope:{workspaces:['/repo']},idempotencyKey:'evidence-case'})).case
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})})
  return {store,cases,evidence,feedback,current}
}

test('user decisions stay eligible without ratings; down/undo and namespaces are enforced', async t => {
  const {cases,evidence,feedback,current}=await fixture(t)
  let source=await cases.transition({caseId:current.caseId,expectedState:'received',expectedRevision:current.revision,state:'awaiting_user',awaitingReason:'authority'})
  source=await cases.transition({caseId:source.caseId,expectedState:'awaiting_user',expectedRevision:source.revision,state:'closed',closing:'escalated',decision:{kind:'user_decision',answers:[{id:'q',selected:['A']}]}})
  const ref=await evidence.add({agentId:'agent-a',source:'user_decision',locator:{kind:'case',caseId:source.caseId},scope:{workspaces:['/repo']}})
  const query={agentId:'agent-a',workspaceKey:'/repo',scope:{workspaces:['/repo']}}
  assert.deepEqual(evidence.candidates(query).map(x=>x.evidenceId),[ref.evidenceId])
  await feedback.append({actor:{kind:'user'},caseId:source.caseId,kind:'rating_down'})
  assert.equal(evidence.candidates(query).length,0)
  await feedback.append({actor:{kind:'user'},caseId:source.caseId,kind:'undo_rating_down'})
  assert.equal(evidence.candidates(query).length,1)
  assert.equal(evidence.candidates({...query,agentId:'agent-b'}).length,0)
  assert.equal(evidence.candidates({...query,workspaceKey:'/other',scope:{workspaces:['/other']}}).length,0)
})

test('Corrections outrank old evidence and supersede it; current observations require fresh hashes', async t => {
  const {cases,evidence,feedback,current}=await fixture(t)
  const old=await evidence.add({agentId:'agent-a',source:'agent_record',locator:{kind:'case',caseId:current.caseId},scope:{workspaces:['/repo']}})
  const correction=await feedback.append({actor:{kind:'user'},caseId:current.caseId,kind:'correction',payload:{direction:'Use B',scope:{workspaces:['/repo']},supersedes:[]}})
  const correctionRef=evidence.candidates({agentId:'agent-a',workspaceKey:'/repo',scope:{workspaces:['/repo']},attemptStartedAt:100}).find(x=>x.source==='user_correction')
  assert.equal(correctionRef?.locator.feedbackId,correction.feedbackId)
  const fresh=await evidence.add({agentId:'agent-a',source:'current_observation',locator:{kind:'file',path:'/repo/a',hash:'h'},observedAt:100,hash:'h',scope:{workspaces:['/repo']}})
  const query={agentId:'agent-a',workspaceKey:'/repo',scope:{workspaces:['/repo']},attemptStartedAt:100}
  assert.deepEqual(evidence.candidates(query).map(x=>x.evidenceId),[correctionRef.evidenceId,fresh.evidenceId])
  await evidence.attach('da_test',[correctionRef.evidenceId,fresh.evidenceId])
  assert.deepEqual(evidence.forAttempt('da_test').map(x=>x.evidenceId),[correctionRef.evidenceId,fresh.evidenceId])
  assert.equal(evidence.eligibilityIssues([old.evidenceId],query)[0].code,'STALE_EVIDENCE')
})
test('narrow path and tag evidence never covers a broader request', () => {
  const workspace = '/repo'
  assert.equal(scopeCovers({ workspaces: [workspace], paths: ['src'] }, { workspaces: [workspace] }, workspace), false)
  assert.equal(scopeCovers({ workspaces: [workspace], tags: ['gui'] }, { workspaces: [workspace] }, workspace), false)
  assert.equal(scopeCovers({ workspaces: [workspace], paths: ['src'], tags: ['gui'] }, { workspaces: [workspace], paths: ['src/decision'], tags: ['gui'] }, workspace), true)
  assert.equal(scopeCovers({ workspaces: [workspace] }, { workspaces: [workspace], paths: ['src'], tags: ['gui'] }, workspace), true)
})
