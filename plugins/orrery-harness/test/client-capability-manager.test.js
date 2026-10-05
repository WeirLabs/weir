// Regression for the panel's hook-count stability (React #310): every hook
// must run before the early returns, so the loading→loaded transition keeps
// an identical hook count.
import { test, expect } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function loadModel() {
  const source = readFileSync(new URL('../lib/client.capability-model.js', import.meta.url), 'utf8')
  const loaded = {}
  const sandbox = { __ModuleLoader__: { load: ({ factory }) => { loaded.exports = factory(() => { throw new Error('zero-dependency chunk') }) } } }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return Object.fromEntries(Object.entries(loaded.exports).map(([key, fn]) => [key, (...args) => JSON.parse(JSON.stringify(fn(...args)))]))
}

function makeReactStub(counts) {
  const reactState = []
  let hookCursor = 0
  return {
    reset() { reactState.length = 0 },
    begin() { hookCursor = 0 },
    useState(initial) {
      counts.useState += 1
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = [initial, (next) => { reactState[at][0] = next }]
      return reactState[at]
    },
    useEffect(fn) { counts.useEffect += 1; fn(); return undefined },
    useCallback(fn) { return fn },
    useRef(initial) {
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = { current: initial }
      return reactState[at]
    },
  }
}

const requireStubFor = reactStub => name => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return { jsx: (t, p) => ({ __type: t, ...(p ?? {}) }), jsxs: (t, p) => ({ __type: t, ...(p ?? {}) }) }
  throw new Error(`unexpected require ${name}`)
}

test('the panel keeps an identical hook count across the loading→loaded→mcp-tab→add-form renders', async () => {
  const counts = { useState: 0, useEffect: 0 }
  const reactStub = makeReactStub(counts)
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(reactStub))
  const { CapabilityManagerPanel } = exports
  const model = loadModel()
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const props = {
    sessionId: 's1', model, onClose: () => {}, t: (key, fallback) => fallback,
    fetchListing: async () => ({ skills: [{ name: 'a', description: '', scope: 'user', status: 'parsed', selected: false, conflict: false }], mcpServers: [{ identity: 'docs', state: 'mounted' }, { serverName: 'gamma', state: 'unmanaged' }] }),
    fetchConditions: async () => ({ conditions: [] }),
    fetchReceipt: async () => ({ status: 'applied', revision: 1, effective: { skills: ['a'], mcpServers: ['docs'] }, warnings: [] }),
    applySelection: async () => ({ status: 'applied', revision: 2 }),
    mcpAdd: async () => ({ status: 'registered', identity: 'x', generation: 1 }),
  }
  reactStub.reset()
  const renders = []
  const renderOnce = () => { counts.useState = 0; counts.useEffect = 0; reactStub.begin(); const out = CapabilityManagerPanel(props); renders.push({ useState: counts.useState, useEffect: counts.useEffect }); return out }
  renderOnce() // loading (listing null)
  await flush()
  const loaded = renderOnce() // loaded
  const header = loaded.children[0]
  header.children[1].onClick() // MCP tab
  const mcp = renderOnce()
  const addBlock = mcp.children[1]
  addBlock.children[0].onClick() // open the add form
  renderOnce()
  const hookCounts = renders.map(render => `${render.useState}/${render.useEffect}`)
  expect(new Set(hookCounts).size).toBe(1)
  expect(hookCounts[0]).toBe('7/1')
})
