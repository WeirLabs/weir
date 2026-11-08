import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found);
    else if (value && typeof value === 'object') findAll(value, predicate, found);
  }
  return found;
}

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

test('page model exposes three primary views and advanced metrics without editing or consolidation entry points', async () => {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports;
  assert.deepEqual(model.pageView({}).tabs, ['inbox', 'records', 'agents']);
  assert.deepEqual(model.pageView({}).advancedViews, ['metrics']);
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
test('Attempt Context Pack details show actual neutral sources and truthful legacy empty states', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({ jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) }));
  const render = attempt => exports.AttemptContextPack({ attempt, t: key => key });
  const actual = JSON.stringify(render({
    attemptId: 'da-new',
    packManifest: {
      layerSizes: { L2: 0, L3: 240, L5: 300 },
      memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: ['dc-neutral'] } },
      omissions: ['L3_EPISODE_OMITTED'],
    },
  }));
  assert.equal(actual.includes('decisionContextPack'), true);
  assert.equal(actual.includes('decisionNeutralEpisodes'), true);
  assert.equal(actual.includes('dc-neutral'), true);
  assert.equal(actual.includes('L3_EPISODE_OMITTED'), true);
  const legacy = JSON.stringify(render({ attemptId: 'da-p1', packManifest: { layerSizes: { L2: 0, L3: 0 }, omissions: [] } }));
  assert.equal(legacy.includes('decisionNoMemory'), true);
  assert.equal(legacy.includes('dc-neutral'), false);
})
test('Context Pack is an accessible read-only disclosure with ordered sources and exact manifest values', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({ jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) }));
  const rendered = exports.AttemptContextPack({
    attempt: {
      attemptId: 'da-ordered',
      packManifest: {
        layerSizes: { L0: 10, L1: 20, L2: 0, L3: 240, L4: 30, L5: 300 },
        memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: ['dc-new', 'dc-old'] } },
        omissions: ['L3_EPISODE_OMITTED', 'L3_EPISODE_TRUNCATED'],
      },
    },
    t: key => key,
  });
  assert.equal(rendered.type, 'details');
  assert.equal(rendered['data-attempt-context-pack'], 'da-ordered');
  assert.equal(rendered['aria-label'], 'decisionContextPack: da-ordered');
  assert.equal(findAll(rendered, node => node.type === 'summary').length, 1);
  assert.deepEqual(findAll(rendered, node => node.type === 'dt').map(node => node.children), ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
  assert.deepEqual(findAll(rendered, node => node.type === 'dd').map(node => node.children), ['10', '20', '0', '240', '30', '300']);
  const text = JSON.stringify(rendered);
  assert.equal(text.includes('decisionL2Memory'), true);
  assert.equal(text.includes('decisionMemoryEmpty'), true);
  assert.equal(text.includes('decisionNeutralEpisodes'), true);
  assert.equal(text.includes('decisionLayerSizes'), true);
  assert.equal(text.includes('decisionOmissions'), true);
  assert.ok(text.indexOf('dc-new') < text.indexOf('dc-old'));
  assert.ok(text.indexOf('L3_EPISODE_OMITTED') < text.indexOf('L3_EPISODE_TRUNCATED'));
  assert.deepEqual(findAll(rendered, node => ['button', 'input', 'select', 'textarea'].includes(node.type)), []);
});

test('Context Pack renders truthful no-L3, P1 legacy, and missing-manifest empty states', async () => {
  const { exports } = await loadClientChunk('lib/client.decision-page.js', () => ({ jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) }));
  const attempts = [
    {
      attemptId: 'da-empty',
      packManifest: {
        layerSizes: { L0: 10, L1: 20, L2: 0, L3: 0, L4: 30, L5: 40 },
        memory: { L2: { schemaVersion: 1, status: 'empty', snapshotId: null }, L3: { schemaVersion: 1, sourceCaseIds: [] } },
        omissions: [],
      },
    },
    { attemptId: 'da-p1', packManifest: { layerSizes: { L2: 0, L3: 0 }, omissions: [] } },
    { attemptId: 'da-missing' },
  ];
  for (const attempt of attempts) {
    const rendered = exports.AttemptContextPack({ attempt, t: key => key });
    const text = JSON.stringify(rendered);
    assert.equal(rendered.type, 'details');
    assert.equal(text.includes('decisionNoMemory'), true, attempt.attemptId);
    assert.equal(text.includes('decisionNeutralEpisodes'), true, attempt.attemptId);
    assert.equal(text.includes('decisionMemoryEmpty'), true, attempt.attemptId);
    assert.equal(text.includes('dc-invented'), false, attempt.attemptId);
    assert.deepEqual(findAll(rendered, node => node.type === 'ol'), [], attempt.attemptId);
  }
  const legacy = exports.AttemptContextPack({ attempt: attempts[1], t: key => key });
  assert.deepEqual(findAll(legacy, node => node.type === 'dt').map(node => node.children), ['L2', 'L3']);
  assert.deepEqual(findAll(legacy, node => node.type === 'dd').map(node => node.children), ['0', '0']);
  const missing = exports.AttemptContextPack({ attempt: attempts[2], t: key => key });
  assert.deepEqual(findAll(missing, node => node.type === 'dt' || node.type === 'dd'), []);
});

test('record detail adds one Context Pack per Attempt without replacing raw detail or record actions', async () => {
  const detail = {
    case: { caseId: 'dc-record', agentId: 'a', state: 'closed', closing: 'answered', feedbackState: 'none', scope: {} },
    attempts: [
      { attemptId: 'da-one', packManifest: { layerSizes: { L2: 0, L3: 12 }, memory: { L2: { status: 'empty' }, L3: { sourceCaseIds: ['dc-source'] } }, omissions: [] } },
      { attemptId: 'da-two', packManifest: { layerSizes: { L2: 0, L3: 0 }, omissions: [] } },
    ],
  };
  const states = ['records', [], [], [], null, null, detail, null, {}, null, '', '', ''];
  let cursor = 0;
  const react = { useState: initial => [cursor < states.length ? states[cursor++] : initial, () => {}], useEffect: () => {} };
  const { exports } = await loadClientChunk('lib/client.decision-page.js', name => name === 'react' ? react : { jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) });
  const rendered = exports.DecisionPage({
    connection: {}, decisionRpc: async () => {}, createDecisionActions: () => ({}),
    getSessionId: () => 'session', t: key => key,
  });
  const packs = findAll(rendered, node => node.type === exports.AttemptContextPack);
  assert.deepEqual(packs.map(pack => pack.attempt.attemptId), ['da-one', 'da-two']);
  assert.equal(findAll(rendered, node => node.type === 'pre' && node.children === JSON.stringify(detail, null, 2)).length, 1);
  const buttons = findAll(rendered, node => node.type === 'button').map(node => node.children);
  for (const action of ['decisionUp', 'decisionDown', 'decisionUndo', 'decisionComment', 'decisionCorrect']) assert.equal(buttons.includes(action), true);
  assert.equal(buttons.some(label => /consolidat|publish|rollback|learn|auto|export|edit memory|memory edit/i.test(String(label))), false);
});

test('client manifest injects layout for render-time panel access', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
})
