import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

test('every user action maps to the same Host method with bare session args', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-actions.js');
  const calls = [];
  const rpc = async (_connection, method, args) => { calls.push({ method, args }); return { ok: true }; };
  const actions = exports.createDecisionActions('connection', 'child', rpc);
  await actions.setSelector('agent', 'a');
  await actions.decide('dc', [{ id: 'q', selected: ['A'] }]);
  await actions.reassign('dc', 'b');
  await actions.cancel('dc');
  await actions.retry('dc');
  await actions.feedback('dc', 'rating_down');
  await actions.feedback('dc', 'comment', 'nuance');
  await actions.correction('dc', 'Use B', { paths: ['src'] }, ['dc']);
  await actions.profileUpsert({ agentId: 'a', userDescription: 'v2' });
  await actions.profileSetState('a', 'disabled');
  assert.deepEqual(calls.map(call => call.method), ['setSelector', 'decide', 'reassign', 'cancel', 'retry', 'feedback', 'feedback', 'correction', 'profileUpsert', 'profileSetState']);
  for (const call of calls) assert.equal(call.args.sessionId, 'child');
  assert.deepEqual(calls[6].args.payload, { text: 'nuance' });
  assert.deepEqual(calls[7].args, { sessionId: 'child', caseId: 'dc', direction: 'Use B', scope: { paths: ['src'] }, supersedes: ['dc'] });
  assert.equal(calls.some(call => 'actor' in call.args), false);
})

test('action errors are explicit non-blocking banners and surfaces use accessible themed controls', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-actions.js');
  assert.deepEqual(exports.errorBanner(new Error('offline')), { role: 'alert', message: 'offline' });
  assert.equal(exports.errorBanner(undefined).role, 'alert');
  for (const file of ['client.decision-selector.js', 'client.decision-card.js', 'client.decision-page.js']) {
    const source = readFileSync(new URL(`../../lib/${file}`, import.meta.url), 'utf8');
    assert.equal(source.includes('commands.execute'), false, file);
    assert.equal(/#[\da-f]{3,8}\b/i.test(source), false, file);
    assert.equal(source.includes('aria-label'), true, file);
    assert.equal(source.includes('type: "button"') || source.includes('ui.Button') || file === 'client.decision-selector.js', true, file);
    assert.equal(/setInterval|setTimeout/.test(source), false, file);
  }
})
