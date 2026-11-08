import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

test('management page registers left-panel and keyed main with exactly four real views', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({}));
  assert.equal(exports.PAGE_ID, 'weir-decisions');
  const production = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  assert.match(production, /name: "sidebar.panellist", id: "weir-decisions", order: 12/);
  assert.match(production, /name: "main", key: "weir-decisions", children: \{ "weir-decisions.tab": \{ kind: "list", scope: "root" \} \}/);
  const source = readFileSync(new URL('../../lib/client.decision-page.js', import.meta.url), 'utf8');
  assert.equal(/setInterval|setTimeout/.test(source), false);
  assert.equal(/consolidation|memory snapshot|auto routing/i.test(source), false);
})

test('page model exposes four views without editing or consolidation entry points', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports;
  assert.deepEqual(model.pageView({}).tabs, ['agents', 'records', 'inbox', 'metrics']);
  const record = {
    case: { caseId: 'dc', agentId: 'a', state: 'awaiting_user', feedbackState: 'disputed', scope: { paths: ['src'] }, decision: { code: 'STALE_EVIDENCE' } },
    attempts: [{ outcome: 'escalate' }],
  };
  const view = model.pageView({ tab: 'records', records: [record] });
  assert.equal(view.records.length, 1);
  assert.equal('editCase' in view, false);
  assert.equal('consolidate' in view, false);
})
test('inbox shows tentative suggestions and per-question conclusions', async () => {
  const react = { useState: initial => [initial, () => {}] }
  const { exports } = await loadClientChunk('lib/client.decision-page.js', name => name === 'react' ? react : { jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) })
  const rendered = exports.InboxItem({
    item: {
      caseId: 'dc-waiting', awaitingReason: 'partial_batch', request: { questions: [] },
      escalation: { suggestion: [{ id: 'q', selected: ['Use Short'] }], perQuestion: [{ id: 'q2', outcome: 'return', detail: 'MISSING_CONTEXT' }] },
    },
    agents: [], run: () => {}, t: key => key,
  })
  const text = JSON.stringify(rendered)
  assert.equal(text.includes('decisionSuggestions'), true)
  assert.equal(text.includes('decisionPerQuestion'), true)
  assert.equal(text.includes('Use Short'), true)
  assert.equal(text.includes('MISSING_CONTEXT'), true)
})
test('client manifest injects layout for render-time panel access', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
})
