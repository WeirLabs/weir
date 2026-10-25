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
  let effectRan = false
  return {
    reset() { reactState.length = 0; effectRan = false },
    begin() { hookCursor = 0 },
    useState(initial) {
      counts.useState += 1
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = [initial, (next) => { reactState[at][0] = typeof next === 'function' ? next(reactState[at][0]) : next }]
      return reactState[at]
    },
    useEffect(fn) { counts.useEffect += 1; if (!effectRan) { effectRan = true; fn() } return undefined },
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
  expect(hookCounts[0]).toBe('8/1')
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
  const skillCheckbox = findAll(loaded, (node) => node.__type === 'input' && node.type === 'checkbox' && node['aria-label'] === 'a — user')[0]
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
  expect(findAll(mcp, (node) => node.children === 'Weir managed')).toHaveLength(1)
  expect(findAll(mcp, (node) => node.children === 'Unmanaged')).toHaveLength(1)
  expect(findAll(mcp, (node) => node.__type === 'span' && node.children === 'mounted')).toHaveLength(1)
})


test('same-named rows check independently and Apply carries the exact identity', async () => {
  const counts = { useState: 0, useEffect: 0 }
  const react = makeReactStub(counts)
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const model = loadModel()
  const a = { scope: 'custom', root: '/a', name: 'same', provenance: null, opaqueId: 'a', portable: false }
  const b = { ...a, root: '/b', opaqueId: 'b' }
  let applied
  const props = {
    sessionId: 'same-names', model,
    fetchListing: async () => ({ skills: [a, b].map(identity => ({ name: 'same', scope: 'custom', status: 'parsed', identity })), mcpServers: [] }),
    fetchReceipt: async () => ({ status: 'applied', revision: 1, effective: { skills: [], skillIdentities: [], mcpServers: [] }, warnings: [] }),
    fetchConditions: async () => ({ conditions: [] }),
    applySelection: async (_sessionId, draft) => { applied = draft; return { status: 'missing' } },
  }
  const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
  render()
  await new Promise(resolve => setTimeout(resolve, 0))
  const first = findAll(render(), node => node.type === 'checkbox')
  expect(first.map(row => row.checked)).toEqual([false, false])
  first[0].onChange()
  const edited = render()
  expect(findAll(edited, node => node.type === 'checkbox').map(row => row.checked)).toEqual([true, false])
  expect(findAll(edited, node => node.children === '+1 skills')).toHaveLength(1)
  findAll(edited, node => node.__type === 'button' && node.children === 'Apply')[0].onClick()
  expect(applied.skills).toEqual([a])
})

test('both manager shells block full-draft same-name conflicts despite search and preserve applied count', async () => {
  for (const shell of ['sidebar', 'popover']) {
    const react = makeReactStub({ useState: 0, useEffect: 0 })
    const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
    const model = loadModel()
    const a = { scope: 'custom', root: '/private/a', name: 'same', opaqueId: 'secret-a' }
    const b = { scope: 'custom', root: '/private/b', name: 'same', opaqueId: 'secret-b' }
    let calls = 0
    const props = { shell, sessionId: 's', model, fetchConditions: async () => ({ conditions: [] }),
      fetchListing: async () => ({ skills: [a, b].map(identity => ({ name: 'same', scope: 'custom', status: 'parsed', identity, description: identity === a ? 'one' : 'two' })), mcpServers: [] }),
      fetchReceipt: async () => ({ status: 'applied', revision: 1, effective: { skills: [], skillIdentities: [], mcpServers: [] }, warnings: [] }),
      applySelection: async () => { calls++; return { status: 'applied' } } }
    const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
    render(); await new Promise(resolve => setTimeout(resolve, 0))
    let tree = render()
    let boxes = findAll(tree, node => node.type === 'checkbox')
    expect(boxes.map(box => box['aria-label'])).toEqual(['same — custom · source 1', 'same — custom · source 2'])
    boxes[0].onChange(); tree = render()
    findAll(tree, node => node.type === 'checkbox')[1].onChange(); tree = render()
    expect(findAll(tree, node => node.type === 'checkbox').map(box => box.checked)).toEqual([true, true])
    expect(findAll(tree, node => node.type === 'checkbox').every(box => box['aria-invalid'] === true)).toBe(true)
    const apply = findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0]
    expect(apply.disabled).toBe(true); apply.onClick(); expect(calls).toBe(0)
    const warning = findAll(tree, node => node.role === 'alert')[0]
    expect(warning['aria-live']).toBe('assertive')
    expect(warning.children).toContain('custom · source 1, custom · source 2')
    expect(warning.children.includes('secret')).toBe(false)
    expect(findAll(tree, node => node.__type === 'button' && node.children === 'Discard')).toHaveLength(1)
    expect(findAll(tree, node => node.children === '0 skills · 0 MCP').length).toBe(shell === 'sidebar' ? 1 : 0)
    findAll(tree, node => node.__type === 'input' && node.placeholder === 'Search')[0].onChange({ target: { value: 'one' } })
    tree = render(); expect(findAll(tree, node => node.type === 'checkbox')).toHaveLength(1)
    expect(findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0].disabled).toBe(true)
    findAll(tree, node => node.type === 'checkbox')[0].onChange(); tree = render()
    expect(findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0].disabled).toBe(false)
  }
})

test('legacy name needs an explicit exact-source action; checkbox does not consume it', async () => {
  const react = makeReactStub({ useState: 0, useEffect: 0 })
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const model = loadModel()
  const a = { scope: 'user', root: '/a', name: 'same' }, b = { scope: 'project', root: '/b', name: 'same' }
  const props = { sessionId: 's', model, fetchConditions: async () => ({ conditions: [] }),
    fetchListing: async () => ({ skills: [a, b].map(identity => ({ name: 'same', scope: identity.scope, status: 'parsed', identity })), mcpServers: [{ identity: 'docs', state: 'mounted' }] }),
    fetchReceipt: async () => ({ revision: 1, effective: { skills: [], skillIdentities: [], mcpServers: [] } }),
    applySelection: async () => ({ status: 'missing', missing: ['same'] }) }
  const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
  render(); await new Promise(resolve => setTimeout(resolve, 0))
  let tree = render()
  tree.children[0].children[2].onClick() // Presets tab, stage the legacy document via child props
  tree = render()
  const preset = findAll(tree, node => typeof node.__type === 'function' && node.stagePreset)[0]
  preset.stagePreset({ selection: { skills: ['same'], mcpServers: ['docs'] } })
  tree = render()
  expect(findAll(tree, node => node.role === 'alert')[0].children).toContain('legacy name')
  tree.children[0].children[0].onClick(); tree = render()
  expect(findAll(tree, node => node.type === 'checkbox').map(box => box.checked)).toEqual([false, false])
  findAll(tree, node => node.type === 'checkbox')[0].onChange(); tree = render()
  expect(findAll(tree, node => node.role === 'alert')[0].children).toContain('legacy name')
  const buttons = findAll(tree, node => node.__type === 'button' && String(node.children).startsWith('Replace same'))
  expect(buttons).toHaveLength(2)
  buttons[1].onClick(); tree = render()
  expect(findAll(tree, node => node.role === 'alert')[0].children).toContain('only one source')
  expect(findAll(tree, node => node.type === 'checkbox').map(box => box.checked)).toEqual([true, true])
  expect(findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0].disabled).toBe(true)
  findAll(tree, node => node.type === 'checkbox')[0].onChange(); tree = render()
  expect(findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0].disabled).toBe(false)
  tree.children[0].children[2].onClick(); tree = render()
  findAll(tree, node => typeof node.__type === 'function' && node.stagePreset)[0].stagePreset({ selection: { skills: ['same'], mcpServers: ['docs'] } })
  tree.children[0].children[0].onClick(); tree = render()
  findAll(tree, node => node.__type === 'button' && node.children === 'Remove legacy name same')[0].onClick()
  tree = render()
  expect(findAll(tree, node => node.role === 'alert')).toHaveLength(0)
  expect(findAll(tree, node => node.type === 'checkbox').map(box => box.checked)).toEqual([false, false])
  tree.children[0].children[1].onClick(); tree = render()
  expect(findAll(tree, node => node.type === 'checkbox')[0].checked).toBe(true)
})

test('stale server conflict and missing replies show named accessible guidance while retaining the draft', async () => {
  const react = makeReactStub({ useState: 0, useEffect: 0 })
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const model = loadModel()
  const a = { scope: 'user', root: '/a', name: 'alpha' }
  let response = { status: 'rejected', reason: 'same-name-conflict', conflicts: [{ name: 'alpha', root: '/private' }] }
  const props = { sessionId: 's', model, fetchConditions: async () => ({ conditions: [] }),
    fetchListing: async () => ({ skills: [{ name: 'alpha', scope: 'user', status: 'parsed', identity: a }], mcpServers: [] }),
    fetchReceipt: async () => ({ status: 'applied', revision: 1, effective: { skills: [], skillIdentities: [], mcpServers: [] }, warnings: [] }),
    applySelection: async () => response }
  const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
  render(); await new Promise(resolve => setTimeout(resolve, 0))
  findAll(render(), node => node.type === 'checkbox')[0].onChange()
  findAll(render(), node => node.__type === 'button' && node.children === 'Apply')[0].onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  let tree = render()
  expect(findAll(tree, node => node.role === 'alert')[0].children).toContain('alpha')
  expect(findAll(tree, node => node.role === 'alert')[0].children.includes('/private')).toBe(false)
  expect(findAll(tree, node => node.type === 'checkbox')[0].checked).toBe(true)
  response = { status: 'missing', missing: ['alpha'] }
  findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0].onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  tree = render()
  expect(findAll(tree, node => node.role === 'alert')[0].children).toContain('could not resolve alpha')
  expect(findAll(tree, node => node.type === 'checkbox')[0].checked).toBe(true)
})

test('accepted Apply with degraded refresh keeps the selection, marks counts unknown and never double submits', async () => {
  const react = makeReactStub({ useState: 0, useEffect: 0 })
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const model = loadModel()
  const identity = { scope: 'user', root: '/skills', name: 'chosen' }
  const complete = { status: 'applied', revision: 9, effective: { skills: [], skillIdentities: [], mcpServers: [], digest: 'a'.repeat(64) }, warnings: [] }
  const degraded = { status: 'applied', revision: 10, effective: { skills: [], skillIdentities: [], mcpServers: [], digest: 'b'.repeat(64) }, warnings: ['selection-unavailable'] }
  let reads = 0, writes = 0
  const props = { shell: 'sidebar', sessionId: 's', model, t: key => ({ 'capability.effectiveUnknown': '已应用数量未知——请刷新并检查技能来源', 'capability.effectiveUnknownShort': '技能 ? · MCP ?', 'capability.effectiveUnknownDetail': '修订已接受，但有效能力暂无法核实。请刷新并检查技能来源。草稿已保留；只有手动应用才会更改会话。' })[key] ?? key,
    fetchListing: async () => ({ skills: [{ name: 'chosen', scope: 'user', status: 'parsed', identity }], mcpServers: [] }),
    fetchConditions: async () => ({ conditions: [] }),
    fetchReceipt: async () => ++reads === 1 ? complete : degraded,
    applySelection: async () => { writes++; return { status: 'applied', revision: 10 } } }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
  render(); await flush()
  let tree = render()
  expect(findAll(tree, node => node.children === '0 skills · 0 MCP')).toHaveLength(1)
  findAll(tree, node => node.type === 'checkbox')[0].onChange()
  tree = render()
  const apply = findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0]
  apply.onClick(); apply.onClick()
  expect(writes).toBe(1)
  await flush()
  tree = render()
  expect(findAll(tree, node => node.type === 'checkbox')[0].checked).toBe(true)
  expect(findAll(tree, node => node.children === '0 skills · 0 MCP')).toHaveLength(0)
  expect(findAll(tree, node => node.children === '技能 ? · MCP ?')).toHaveLength(1)
  expect(findAll(tree, node => node.title === '已应用数量未知——请刷新并检查技能来源')).toHaveLength(1)
  expect(findAll(tree, node => node.role === 'status' && String(node.children).includes('草稿已保留'))).toHaveLength(1)
  expect(findAll(tree, node => node.children === 'Accepted · effective count unknown')).toHaveLength(1)
  tree.children[0].children[2].onClick()
  const preset = findAll(render(), node => typeof node.__type === 'function' && node.stagePreset)[0]
  expect(preset.draft.appliedSourceIssue).toBe('unavailable')
  expect(preset.draft.appliedDigest).toBeUndefined()
  expect(preset.draft.skills).toEqual([identity])
})

test('manager ignores an older initial receipt after a newer degraded refresh', async () => {
  const react = makeReactStub({ useState: 0, useEffect: 0 })
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const model = loadModel()
  const pending = []
  const props = { sessionId: 's', shell: 'sidebar', model,
    fetchListing: async () => ({ skills: [], mcpServers: [] }), fetchConditions: async () => ({ conditions: [] }),
    fetchReceipt: () => new Promise(resolve => pending.push(resolve)),
    mcpAdd: async () => ({ status: 'registered' }), applySelection: () => { throw new Error('no Apply expected') } }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
  render(); await flush()
  let tree = render()
  tree.children[0].children[1].onClick()
  tree = render()
  findAll(tree, node => node.__type === 'button' && node.children === '+ Add managed MCP server')[0].onClick()
  tree = render()
  findAll(tree, node => node.__type === 'input' && node.placeholder === 'identity (e.g. my-docs)')[0].onChange({ target: { value: 'docs' } })
  tree = render()
  findAll(tree, node => node.__type === 'input' && node.placeholder === 'command (e.g. npx)')[0].onChange({ target: { value: 'npx' } })
  tree = render()
  findAll(tree, node => node.__type === 'button' && node.children === 'Add')[0].onClick()
  await flush()
  expect(pending).toHaveLength(2)
  pending[1]({ status: 'applied', revision: 10, effective: { skills: [], mcpServers: [] }, warnings: ['selection-unavailable'] })
  await flush()
  expect(findAll(render(), node => node.role === 'status' && String(node.children).includes('cannot be verified'))).toHaveLength(1)
  pending[0]({ status: 'applied', revision: 9, effective: { skills: [], mcpServers: [] }, warnings: [] })
  await flush()
  expect(findAll(render(), node => node.children === '0 skills · 0 MCP')).toHaveLength(0)
})

test('popover without prior draft still announces an incomplete applied receipt', async () => {
  const react = makeReactStub({ useState: 0, useEffect: 0 })
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const props = { shell: 'popover', sessionId: 's', model: loadModel(),
    fetchListing: async () => ({ skills: [], mcpServers: [] }),
    fetchConditions: async () => ({ conditions: [] }),
    fetchReceipt: async () => ({ status: 'applied', revision: 10, effective: { skills: [], mcpServers: [] }, warnings: ['selection-unavailable'] }) }
  const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
  render(); await new Promise(resolve => setTimeout(resolve, 0))
  const tree = render()
  expect(tree.children[1]).toBeNull()
  expect(findAll(tree, node => node.role === 'status' && String(node.children).includes('cannot be verified'))).toHaveLength(1)
  expect(findAll(tree, node => node.children === '0 skills · 0 MCP')).toHaveLength(0)
  expect(findAll(tree, node => node.children === 'Apply')[0].disabled).toBe(true)
})

test('first degraded open requires explicit overwrite confirmation before recovery Apply', async () => {
  const react = makeReactStub({ useState: 0, useEffect: 0 })
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const model = loadModel()
  const identity = { scope: 'user', root: '/skills', name: 'new' }
  let writes = 0
  const props = { shell: 'popover', sessionId: 's', model,
    fetchListing: async () => ({ skills: [{ name: 'new', scope: 'user', status: 'parsed', identity }], mcpServers: [] }),
    fetchConditions: async () => ({ conditions: [] }),
    fetchReceipt: async () => ({ status: 'applied', revision: 10, effective: { skills: [], skillIdentities: [], mcpServers: [] }, warnings: ['selection-unavailable'] }),
    applySelection: async (_id, request) => { writes++; expect(request.expectedRevision).toBe(10); return { status: 'applied', revision: 11 } } }
  const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
  render(); await new Promise(resolve => setTimeout(resolve, 0))
  let tree = render()
  expect(findAll(tree, node => node.role === 'alert' && String(node.children).includes('other accepted Skills'))).toHaveLength(1)
  findAll(tree, node => node.type === 'checkbox')[0].onChange()
  tree = render()
  expect(findAll(tree, node => node.children === '+1 skills')).toHaveLength(0)
  let apply = findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0]
  expect(apply.disabled).toBe(true)
  apply.onClick(); expect(writes).toBe(0)
  findAll(tree, node => node.__type === 'button' && node.children === 'Discard')[0].onClick()
  expect(writes).toBe(0)
  findAll(render(), node => node.type === 'checkbox')[0].onChange()
  tree = render()
  findAll(tree, node => node.__type === 'button' && node.children === 'Confirm replacing unknown selection')[0].onClick()
  tree = render()
  expect(findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0].disabled).toBe(false)
  findAll(tree, node => node.type === 'checkbox')[0].onChange()
  tree = render()
  expect(findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0].disabled).toBe(true)
  findAll(tree, node => node.type === 'checkbox')[0].onChange()
  tree = render()
  expect(findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0].disabled).toBe(true)
  findAll(tree, node => node.__type === 'button' && node.children === 'Confirm replacing unknown selection')[0].onClick()
  findAll(render(), node => node.__type === 'button' && node.children === 'Apply')[0].onClick()
  expect(writes).toBe(1)
})

test('a preset reference the listing cannot resolve never disables Apply and reports the skipped set', async () => {
  const react = makeReactStub({ useState: 0, useEffect: 0 })
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const model = loadModel()
  // The local identity exists here; the workspace-A identity is the same
  // invocation name saved in another workspace and has no applicable row.
  const local = { scope: 'project', root: '/ws-b/.dsh/skills', name: 'travel', provenance: null, opaqueId: 'local-travel', portable: false }
  const foreign = { scope: 'project', root: '/ws-a/.dsh/skills', name: 'travel', provenance: null, opaqueId: 'foreign-travel', portable: false }
  let applied = null
  const props = {
    shell: 'sidebar', sessionId: 's', model,
    fetchListing: async () => ({ skills: [{ name: 'travel', scope: 'project', status: 'parsed', identity: local, selected: false }], mcpServers: [] }),
    fetchConditions: async () => ({ conditions: [] }),
    fetchReceipt: async () => ({ status: 'applied', revision: 1, effective: { skills: [], skillIdentities: [], mcpServers: [] }, warnings: [] }),
    applySelection: async (_sessionId, request) => {
      applied = request
      return { status: 'applied', revision: 2, skipped: [{ name: 'travel', reason: 'not applicable in this workspace' }] }
    },
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  const render = () => { react.begin(); return exports.CapabilityManagerPanel(props) }
  render(); await flush()
  let tree = render()
  tree.children[0].children[2].onClick() // Presets tab
  tree = render()
  findAll(tree, node => typeof node.__type === 'function' && node.stagePreset)[0]
    .stagePreset({ selection: { skills: [local, foreign], mcpServers: [] } })
  tree = render()
  // No same-name warning: only the resolvable local identity participates.
  expect(findAll(tree, node => node.role === 'alert')).toHaveLength(0)
  tree.children[0].children[0].onClick() // Skills tab
  tree = render()
  const apply = findAll(tree, node => node.__type === 'button' && node.children === 'Apply')[0]
  expect(apply.disabled).toBe(false)
  apply.onClick()
  await flush()
  // The draft travels verbatim (order is the model's identity sort): the
  // server owns the skip-vs-unknown decision.
  expect(applied.skills.map(entry => entry.root).sort()).toEqual([foreign.root, local.root])
  tree = render()
  expect(findAll(tree, node => node.children === 'skipped 1 (not applicable here)')).toHaveLength(1)
  const chip = findAll(tree, node => node.__type === 'span' && typeof node.title === 'string' && node.title.includes('not applicable in this workspace'))
  expect(chip).toHaveLength(1)
})
