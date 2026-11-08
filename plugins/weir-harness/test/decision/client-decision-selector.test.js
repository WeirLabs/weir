import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

async function load() {
  const state = []
  let cursor = 0
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
  const { exports } = await loadClientChunk('lib/client.decision-selector.js', name => name === 'react' ? react : { jsx: (type, props) => ({ type, ...props }), jsxs: (type, props) => ({ type, ...props }) });
  const render = props => { cursor = 0; return exports.DecisionSelector(props); };
  return { exports, state, render };
}

const selectorOptions = value => [{ value: 'off', mode: 'off', label: 'Off' }, ...(value?.agents ?? []).filter(agent => agent.state === 'enabled').map(agent => ({ value: agent.agentId, label: agent.name }))];

test('selector registration matches composer slot and filters disabled/Auto', async () => {
  const { exports } = await load();
  assert.equal(exports.SELECTOR_ID, 'weir-decision-selector');
  const production = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  assert.match(production, /name: "conversation.input.right", id: "weir-decision-selector", order: 90/);
  assert.match(production, /inject: sessionId => \{ if \(sessionId\) decisionSession.current = sessionId; return sessionId \? \{ sessionId \} : \{\}; \}/);
  const source = readFileSync(new URL('../../lib/client.decision-selector.js', import.meta.url), 'utf8');
  assert.equal(/setInterval|setTimeout/.test(source), false);
  assert.equal(source.includes('Auto'), false);
});

test('first frame is Off; data redraws and remote failure preserves the prior selection', async () => {
  const { render } = await load();
  let fail = false;
  const calls = [];
  const decisionRpc = async (_connection, method, args) => {
    calls.push([method, args]);
    if (method === 'overview') return { selector: { mode: 'agent', agentId: 'a' }, agents: [{ agentId: 'a', name: 'A', state: 'enabled' }, { agentId: 'b', name: 'B', state: 'disabled' }] };
    if (fail) throw new Error('remote offline');
    return { mode: args.mode };
  };
  const props = { sessionId: 'root', connection: {}, selectorOptions, decisionRpc, t: key => key };
  const first = render(props);
  assert.equal(first.children[0].value, 'off');
  await Promise.resolve(); await Promise.resolve();
  const loaded = render(props);
  assert.equal(loaded.children[0].value, 'a');
  assert.deepEqual(loaded.children[0].children.map(option => option.value), ['off', 'a']);

  fail = true;
  await loaded.children[0].onChange({ target: { value: 'off' } });
  const failed = render(props);
  assert.equal(failed.children[0].value, 'a');
  assert.equal(failed.children[1].role, 'alert');
  assert.match(failed.children[1].children, /remote offline/);
  assert.equal(calls.some(call => call[0] === 'setSelector'), true);
});
