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

function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  return findAll(node.children, pred, out)
}

const SKELETON_BG = 'var(--dsw-alias-bg-skeleton, rgba(127,127,127,.12))'

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

// Visual polish (capabilities-panel-visual-polish): additive structural
// assertions for the new presentation layer. Every existing pin above stays
// as-is; these only ADD coverage for the new invariants.
test('visual polish: skeleton loading, sidebar scroll wrapper, sticky group headers with counts, segmented tabs, search icon', async () => {
  const counts = { useState: 0, useEffect: 0 }
  const reactStub = makeReactStub(counts)
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(reactStub))
  const { CapabilityManagerPanel } = exports
  const model = loadModel()
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const props = {
    sessionId: 's1', model, onClose: () => {}, t: (key, fallback) => fallback, shell: 'sidebar',
    fetchListing: async () => ({ skills: [{ name: 'a', description: 'alpha skill', scope: 'user', status: 'parsed', selected: false, conflict: false }], mcpServers: [{ identity: 'docs', state: 'mounted' }, { serverName: 'gamma', state: 'unmanaged' }] }),
    fetchConditions: async () => ({ conditions: [] }),
    fetchReceipt: async () => ({ status: 'applied', revision: 1, effective: { skills: ['a'], mcpServers: ['docs'] }, warnings: [] }),
    applySelection: async () => ({ status: 'applied', revision: 2 }),
    mcpAdd: async () => ({ status: 'registered', identity: 'x', generation: 1 }),
  }

  // Loading: skeleton rows replace the plain text line (the text survives for
  // the a11y tree via the visually-hidden status span).
  reactStub.reset()
  reactStub.begin()
  const loading = CapabilityManagerPanel(props)
  expect(loading.role).toBe('status')
  expect(findAll(loading, (node) => node.style && node.style.background === SKELETON_BG).length).toBeGreaterThanOrEqual(3)
  expect(findAll(loading, (node) => node.children === 'Loading capabilities…')).toHaveLength(1)

  await flush()
  reactStub.begin()
  const loaded = CapabilityManagerPanel(props)
  const header = loaded.children[0]

  // Segmented-control tab bar: pinned children[1] is still the MCP tab; the
  // three segments share the track with 2px gutters and outer radii only.
  expect(header.children[0].__type).toBe('button')
  expect(header.children[1].__type).toBe('button')
  expect(header.children[2].__type).toBe('button')
  expect(header.children[0].style.marginLeft).toBe('0')
  expect(header.children[1].style.marginLeft).toBe('2px')
  expect(header.children[2].style.marginLeft).toBe('2px')
  expect(header.children[0].style.borderRadius).toBe('var(--dsw-radius-md, 8px) 0 0 var(--dsw-radius-md, 8px)')
  expect(header.children[1].style.borderRadius).toBe('0')
  expect(header.children[2].style.borderRadius).toBe('0 var(--dsw-radius-md, 8px) var(--dsw-radius-md, 8px) 0')
  expect(header.children[1].children).toBe('MCP')
  // The active segment is the raised layer-1 pill.
  expect(header.children[0].style.background).toBe('var(--dsw-alias-bg-layer-1, #fff)')
  expect(header.children[1].style.background).toContain('--dsw-alias-interactive-bg-hover')
  // Keyboard focus affordance on the interactive header controls.
  expect(typeof header.children[0].onFocus).toBe('function')
  expect(typeof header.children[1].onFocus).toBe('function')
  expect(typeof header.children[2].onFocus).toBe('function')

  // The sidebar header carries the session's applied-counts summary chip.
  expect(findAll(header, (node) => node.__type === 'span' && node.children === '1 skills · 1 MCP')).toHaveLength(1)

  // Search input sits in an icon wrapper with an inline SVG (no icon font).
  const searchWrap = findAll(header, (node) => node.style && node.style.position === 'relative')[0]
  expect(searchWrap).toBeTruthy()
  // (Icon is a component element in the stub tree — the inline SVG it renders
  // keeps the chunk icon-font free.)
  expect(findAll(searchWrap, (node) => typeof node.__type === 'function' && node.name === 'search')).toHaveLength(1)
  expect(findAll(searchWrap, (node) => node.__type === 'input')).toHaveLength(1)

  // The sidebar shell keeps its scroll wrapper as root children[1].
  const scroll = loaded.children[1]
  expect(scroll.style.overflowY).toBe('auto')
  expect(scroll.style.minHeight).toBe(0)

  // Sticky group headers carry the scope label plus a count badge.
  const stickyHeaders = findAll(loaded, (node) => node.style && node.style.position === 'sticky' && node.style.top === 0)
  expect(stickyHeaders).toHaveLength(1)
  expect(findAll(stickyHeaders[0], (node) => node.__type === 'span' && node.children === 'user')).toHaveLength(1)
  expect(findAll(stickyHeaders[0], (node) => node.__type === 'span' && node.children === '1')).toHaveLength(1)

  // Skill rows keep the real checkbox and gain the scope-colored source tag
  // (user → success family hue) plus the painted hover/focus handlers.
  const skillCheckbox = findAll(loaded, (node) => node.__type === 'input' && node.type === 'checkbox' && node['aria-label'] === 'a')[0]
  expect(skillCheckbox).toBeTruthy()
  expect(skillCheckbox.checked).toBe(true)
  const sourceTag = findAll(loaded, (node) => node.__type === 'span' && node.children === 'user' && node.style && typeof node.style.border === 'string' && node.style.border.includes('--dsw-alias-state-success-primary'))
  expect(sourceTag).toHaveLength(1)

  // MCP tab: managed/unmanaged groups render as cards with count badges.
  header.children[1].onClick()
  reactStub.begin()
  const mcp = CapabilityManagerPanel(props)
  const mcpScroll = mcp.children[1]
  expect(mcpScroll.style.overflowY).toBe('auto')
  const cards = findAll(mcp, (node) => node.style && node.style.background === 'var(--dsw-alias-bg-base, #fff)' && node.style.borderRadius === 'var(--dsw-radius-md, 8px)')
  expect(cards.length).toBeGreaterThanOrEqual(2)
  expect(findAll(mcp, (node) => node.children === 'Orrery managed')).toHaveLength(1)
  expect(findAll(mcp, (node) => node.children === 'Unmanaged')).toHaveLength(1)
  expect(findAll(mcp, (node) => node.__type === 'span' && node.children === 'mounted')).toHaveLength(1)
})
