import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

async function setup() {
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports;
  const actions = (await loadClientChunk('lib/client.decision-actions.js')).exports;
  const state = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!state[index]) state[index] = [initial, null];
      const set = value => { state[index][0] = typeof value === 'function' ? value(state[index][0]) : value; };
      state[index][1] = set;
      return [state[index][0], set];
    },
    useEffect: fn => { fn(); },
  };
  const card = (await loadClientChunk('lib/client.decision-card.js', name => name === 'react' ? react : { jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) })).exports;
  const render = props => { cursor = 0; return card.DecisionCard(props); };
  return { model, actions, render };
}

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found);
    else if (value && typeof value === 'object') findAll(value, predicate, found);
  }
  return found;
}

const detail = {
  case: { caseId: 'dc', agentId: 'a', state: 'closed', closing: 'answered', revision: 2, feedbackState: 'none', request: { questions: [] }, scope: { workspaces: ['/repo'] }, decision: { answers: [{ id: 'q', selected: ['A'] }] } },
  attempts: [{ attemptId: 'da', claims: [{ text: 'Use concise wording', evidenceIds: ['ev'] }], evidence: [{ evidenceId: 'ev', source: 'user_decision', locator: { kind: 'case', caseId: 'source' } }] }], feedback: [], routeDecisions: [],
};

test('production registers both toolview keys independently at priority -10', async () => {
  const production = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  assert.match(production, /for \(const toolName of \["ask_user_question", "decision_consult"\]\)/);
  assert.match(production, /key: toolName, priority: -10/);
  assert.match(production, /ui-weir-settings: \$\{toolName\} decision card/);
  const source = readFileSync(new URL('../../lib/client.decision-card.js', import.meta.url), 'utf8');
  assert.equal(source.includes('session.append') || source.includes('commands.execute'), false);
})

test('missing Case returns null and leaves native UI untouched', async () => {
  const f = await setup();
  const props = {
    sessionId: 'root', callId: 'call', toolName: 'ask_user_question', questions: [], connection: {},
    decisionRpc: async () => null, createDecisionActions: f.actions.createDecisionActions,
    cardView: f.model.cardView, t: key => key,
  };
  const first = f.render(props);
  assert.equal(first, null);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.render(props), null);
})

test('Case card shows evidence/version, rereads record on expand and exposes action failures', async () => {
  const f = await setup();
  const calls = [];
  let failFeedback = false;
  const decisionRpc = async (_connection, method, request) => {
    calls.push([method, request]);
    if (method === 'feedback' && failFeedback) throw new Error('write rejected');
    if (method === 'caseForCall' || method === 'record') return detail;
    if (method === 'overview') return { agents: [{ agentId: 'a', name: 'Tone', state: 'enabled' }] };
    return null;
  };
  const props = {
    sessionId: 'root', callId: 'call', toolName: 'ask_user_question', questions: [], connection: {},
    decisionRpc, createDecisionActions: f.actions.createDecisionActions,
    cardView: f.model.cardView, t: key => key,
  };
  f.render(props);
  for (let index = 0; index < 6; index++) await Promise.resolve();
  const rendered = f.render(props);
  assert.equal(rendered['data-weir-decision-card'], 'dc');
  assert.equal(JSON.stringify(rendered).includes('Use concise wording'), true)
  const disclosure = findAll(rendered, node => node.type === 'details')[0];
  disclosure.onToggle();
  await Promise.resolve();
  assert.equal(calls.some(call => call[0] === 'record' && call[1].caseId === 'dc'), true);
  const down = findAll(rendered, node => node.type === 'button' && node['aria-label'] === 'decisionDown')[0];
  failFeedback = true;
  await down.onClick();
  const failed = f.render(props);
  assert.equal(findAll(failed, node => node.role === 'alert').some(node => String(node.children).includes('write rejected')), true);
})
test('escalation card renders tentative suggestions and per-question conclusions read-only', async () => {
  const f = await setup()
  const waiting = {
    ...detail,
    case: {
      ...detail.case,
      state: 'awaiting_user', closing: undefined, decision: null,
      escalation: {
        suggestion: [{ id: 'q', selected: ['Use Short'] }],
        perQuestion: [{ id: 'q2', outcome: 'return', detail: 'MISSING_CONTEXT' }],
      },
    },
  }
  const props = {
    sessionId: 'root', callId: 'call', toolName: 'ask_user_question', questions: [], connection: {},
    decisionRpc: async (_connection, method) => method === 'overview' ? { agents: [] } : waiting,
    createDecisionActions: f.actions.createDecisionActions, cardView: f.model.cardView, t: key => key,
  }
  f.render(props)
  for (let index = 0; index < 6; index++) await Promise.resolve()
  const rendered = f.render(props)
  const text = JSON.stringify(rendered)
  assert.equal(text.includes('decisionSuggestions'), true)
  assert.equal(text.includes('decisionPerQuestion'), true)
  assert.equal(text.includes('Use Short'), true)
  assert.equal(text.includes('MISSING_CONTEXT'), true)
})

test('native pending interaction refreshes an early tool-call card without polling', async () => {
  const source = readFileSync(new URL('../../lib/client.decision-card.js', import.meta.url), 'utf8');
  assert.equal(source.includes('props.useSessionStatus?.('), true);
  assert.equal(source.includes('props.refreshKey, pendingInteraction]'), true);
})
