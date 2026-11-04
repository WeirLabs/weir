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

// Independent hook buckets let the real parent and the real child share the
// chunk's React instance without resetting either component's draft/path state.
function makeReactStub() {
  const buckets = new Map()
  let current = null
  let hookCursor = 0
  const bucket = (name) => {
    if (!buckets.has(name)) buckets.set(name, { state: [], effectRan: false })
    return buckets.get(name)
  }
  return {
    begin(name) { current = name; hookCursor = 0 },
    useState(initial) {
      const target = bucket(current)
      const at = hookCursor++
      if (!(at in target.state)) target.state[at] = [initial, (next) => { target.state[at][0] = typeof next === 'function' ? next(target.state[at][0]) : next }]
      return target.state[at]
    },
    useEffect(fn) {
      const target = bucket(current)
      if (!target.effectRan) { target.effectRan = true; fn() }
    },
    useRef(initial) {
      const target = bucket(current)
      const at = hookCursor++
      if (!(at in target.state)) target.state[at] = { current: initial }
      return target.state[at]
    },
  }
}

const requireStubFor = (reactStub) => (name) => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
  throw new Error(`unexpected require ${name}`)
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  return findAll(node.children, predicate, out)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const identity = (root, name) => ({ scope: 'custom', root, name, provenance: null, opaqueId: root, portable: false })

async function createHarness(shell = 'popover') {
  const react = makeReactStub()
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const model = loadModel()
  const applied = identity('/applied', 'applied')
  const staged = identity('/staged', 'staged')
  const discovered = identity('/discovered', 'discovered')
  const receipt = {
    status: 'applied', revision: 7, warnings: [],
    effective: { skills: ['applied'], skillIdentities: [applied], mcpServers: [], digest: 'a'.repeat(64) },
  }
  const behavior = {
    pathSnapshot: { status: 'ok', revision: 2, paths: ['/canonical/a'], error: null },
    discovered: false,
    add: null,
    remove: null,
  }
  const calls = { pathReads: 0, listingReads: 0, receiptReads: 0, add: [], remove: [], apply: 0 }
  const props = {
    shell, sessionId: 'session-paths', model, t: (key, fallback) => fallback,
    fetchConditions: async () => ({ conditions: [] }),
    fetchListing: async () => {
      calls.listingReads += 1
      const rows = [applied, staged, ...(behavior.discovered ? [discovered] : [])]
      return { skills: rows.map((entry) => ({ name: entry.name, description: '', scope: 'custom', status: 'parsed', identity: entry, selected: entry === applied })), mcpServers: [] }
    },
    fetchReceipt: async () => { calls.receiptReads += 1; return receipt },
    fetchSkillPaths: async () => { calls.pathReads += 1; return behavior.pathSnapshot },
    skillPathAdd: async (_sessionId, request) => {
      calls.add.push(request)
      if (behavior.add) return behavior.add(request)
      behavior.pathSnapshot = { status: 'ok', revision: 3, paths: ['/canonical/a', '/canonical/new'], error: null }
      return { status: 'saved', saved: true, revision: 3, paths: behavior.pathSnapshot.paths, error: null }
    },
    skillPathRemove: async (_sessionId, request) => {
      calls.remove.push(request)
      if (behavior.remove) return behavior.remove(request)
      behavior.pathSnapshot = { status: 'ok', revision: 3, paths: ['/canonical/a'], error: null }
      return { status: 'removed', saved: true, revision: 3, paths: behavior.pathSnapshot.paths, error: null }
    },
    applySelection: async () => { calls.apply += 1; return { status: 'applied', revision: 8 } },
  }
  let parentTree = null
  const renderParent = () => {
    react.begin('parent')
    parentTree = exports.CapabilityManagerPanel(props)
    return parentTree
  }
  const pathElement = () => shell === 'sidebar' ? parentTree?.children[1]?.children[0] : parentTree?.children[1]
  const renderPath = () => {
    const element = pathElement()
    if (!element) return null
    react.begin('path')
    return element.__type(element)
  }
  renderParent()
  await flush()
  renderParent()
  react.begin('path')
  renderPath()
  await flush()
  renderPath()
  return {
    behavior, calls, props, applied, staged, discovered,
    renderParent, renderPath, pathElement,
    input: () => findAll(renderPath(), (node) => node.__type === 'input' && node.placeholder === '~/skills or /absolute/path')[0],
    form: () => findAll(renderPath(), (node) => node.__type === 'form')[0],
    feedback: () => findAll(renderPath(), (node) => node['data-weir-skill-path-feedback'])[0],
  }
}

function typePath(harness, value) {
  harness.input().onChange({ target: { value } })
  harness.renderPath()
}

function submitPath(harness) {
  harness.form().onSubmit({ preventDefault() {} })
}

for (const shell of ['sidebar', 'popover']) {
  test(`${shell}: add is busy, refreshes all reads, preserves the dirty identity draft, and leaves discoveries unselected`, async () => {
    const harness = await createHarness(shell)
    const { behavior, calls } = harness

    // Stage an existing candidate before touching the path registry.
    findAll(harness.renderParent(), (node) => node.type === 'checkbox' && node['aria-label'] === 'staged — custom')[0].onChange()
    harness.renderParent()
    expect(findAll(harness.renderParent(), (node) => node.children === '+1 skills')).toHaveLength(1)
    expect(harness.pathElement()).toBeTruthy()
    expect(harness.pathElement().sessionId).toBe('session-paths')

    let finishAdd
    behavior.add = () => new Promise((resolve) => {
      finishAdd = () => {
        behavior.pathSnapshot = { status: 'ok', revision: 3, paths: ['/canonical/a', '/canonical/new'], error: null }
        behavior.discovered = true
        resolve({ status: 'saved', saved: true, revision: 3, paths: behavior.pathSnapshot.paths, error: null })
      }
    })
    typePath(harness, '~/new')
    submitPath(harness)
    expect(calls.add).toEqual([{ path: '~/new', expectedRevision: 2 }])
    expect(harness.renderPath()['aria-busy']).toBe(true)
    expect(findAll(harness.renderPath(), (node) => node.children === 'Adding…').length).toBeGreaterThanOrEqual(1)
    expect(harness.input().disabled).toBe(true)

    finishAdd()
    await flush()
    await flush()
    harness.renderParent()
    const pathTree = harness.renderPath()
    expect(harness.input().value).toBe('')
    expect(harness.feedback()['data-weir-skill-path-feedback']).toBe('success')
    expect(harness.feedback().children).toContain('Directory added')
    expect(findAll(pathTree, (node) => node['data-weir-skill-path'] === '/canonical/new')).toHaveLength(1)
    expect(calls.pathReads).toBe(2)
    expect(calls.listingReads).toBe(2)
    expect(calls.receiptReads).toBe(2)
    expect(calls.apply).toBe(0)

    const boxes = findAll(harness.renderParent(), (node) => node.type === 'checkbox')
    expect(boxes.map((node) => [node['aria-label'], node.checked])).toEqual([
      ['applied — custom', true],
      ['staged — custom', true],
      ['discovered — custom', false],
    ])
    expect(findAll(harness.renderParent(), (node) => node.children === '+1 skills')).toHaveLength(1)
    expect(findAll(harness.renderParent(), (node) => node.children === '+2 skills')).toHaveLength(0)

    // The pinned addBlock insertion point is Skills-only in this same shell.
    harness.renderParent().children[0].children[1].onClick()
    harness.renderParent()
    expect(harness.pathElement()).toBeNull()
  })
}

test('server validation keeps the exact rejected input and performs no success or capability refresh', async () => {
  const harness = await createHarness()
  const { behavior, calls } = harness
  behavior.add = async () => ({ status: 'validation-failed', saved: false, revision: 2, paths: ['/canonical/a'], error: { code: 'relative-path', message: 'relative paths are not allowed' } })
  typePath(harness, 'relative/path')
  submitPath(harness)
  await flush()
  expect(harness.input().value).toBe('relative/path')
  expect(harness.input()['aria-invalid']).toBe(true)
  expect(harness.feedback()['data-weir-skill-path-feedback']).toBe('error')
  expect(harness.feedback().children).toContain('relative paths are not allowed')
  expect(harness.feedback().children).toContain('nothing was saved')
  expect(calls.pathReads).toBe(1)
  expect(calls.listingReads).toBe(1)
  expect(calls.receiptReads).toBe(1)
  expect(calls.apply).toBe(0)
})

for (const fixture of [
  {
    name: 'duplicate', input: '/canonical/a',
    response: { status: 'duplicate', saved: false, revision: 4, paths: ['/canonical/a'], error: { message: 'canonical path already registered' } },
    snapshot: { status: 'ok', revision: 4, paths: ['/canonical/a'], error: null },
    message: 'already registered',
  },
  {
    name: 'revision conflict', input: '~/not-merged',
    response: { status: 'revision-conflict', saved: false, current: { revision: 5, paths: ['/canonical/current'] }, error: { message: 'expected revision 2, current 5' } },
    snapshot: { status: 'ok', revision: 5, paths: ['/canonical/current'], error: null },
    message: 'was not merged',
  },
]) {
  test(`${fixture.name} re-reads current paths without a success claim, silent merge, or selection refresh`, async () => {
    const harness = await createHarness()
    const { behavior, calls } = harness
    behavior.add = async () => {
      behavior.pathSnapshot = fixture.snapshot
      return fixture.response
    }
    typePath(harness, fixture.input)
    submitPath(harness)
    await flush()
    await flush()
    expect(calls.add[0]).toEqual({ path: fixture.input, expectedRevision: 2 })
    expect(harness.input().value).toBe(fixture.input)
    expect(harness.feedback()['data-weir-skill-path-feedback']).toBe('error')
    expect(harness.feedback().children).toContain(fixture.message)
    expect(calls.pathReads).toBe(2)
    expect(calls.listingReads).toBe(1)
    expect(calls.receiptReads).toBe(1)
    expect(calls.apply).toBe(0)
    for (const path of fixture.snapshot.paths) {
      expect(findAll(harness.renderPath(), (node) => node['data-weir-skill-path'] === path)).toHaveLength(1)
    }
  })
}

for (const shell of ['sidebar', 'popover']) {
test(`${shell}: remove confirmation names the exact canonical path; Cancel and Escape write nothing and restore focus`, async () => {
  const harness = await createHarness(shell)
  harness.behavior.pathSnapshot = { status: 'ok', revision: 2, paths: ['/canonical/a', '/canonical/b'], error: null }
  // Refresh through the real control so the second canonical row arrives.
  findAll(harness.renderPath(), (node) => node.__type === 'button' && node.children === 'Refresh paths')[0].onClick()
  await flush()
  const remove = () => findAll(harness.renderPath(), (node) => node['aria-label'] === 'Remove scan path /canonical/b')[0]
  remove().onClick()
  let tree = harness.renderPath()
  let group = findAll(tree, (node) => node.role === 'group' && node['aria-label'] === 'Remove this Skill scan path?')[0]
  expect(group).toBeTruthy()
  expect(JSON.stringify(group)).toContain('/canonical/b')
  const confirm = findAll(group, (node) => node.__type === 'button' && node.children === 'Remove path')[0]
  const cancel = findAll(group, (node) => node.__type === 'button' && node.children === 'Cancel')[0]
  expect(confirm.autoFocus).toBe(true)
  expect(confirm.type).toBe('button') // native Enter/Space activation
  expect(cancel.type).toBe('button')
  expect(typeof confirm.onFocus).toBe('function')
  cancel.onClick()
  expect(harness.calls.remove).toEqual([])
  expect(remove().autoFocus).toBe(true)

  remove().onClick()
  tree = harness.renderPath()
  group = findAll(tree, (node) => node.role === 'group' && node['aria-label'] === 'Remove this Skill scan path?')[0]
  let prevented = 0
  group.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  group.onKeyDown({ key: ' ', preventDefault() {}, stopPropagation() {} })
  expect(harness.calls.remove).toEqual([])
  group.onKeyDown({ key: 'Escape', preventDefault() { prevented += 1 }, stopPropagation() {} })
  expect(prevented).toBe(1)
  expect(harness.calls.remove).toEqual([])
  expect(remove().autoFocus).toBe(true)

  // A fresh confirmation performs exactly one revision-checked removal.
  remove().onClick()
  tree = harness.renderPath()
  findAll(tree, (node) => node.__type === 'button' && node.children === 'Remove path')[0].onClick()
  await flush()
  await flush()
  expect(harness.calls.remove).toEqual([{ path: '/canonical/b', expectedRevision: 2 }])
  expect(harness.calls.pathReads).toBe(3) // initial + manual refresh + post-remove
  expect(harness.calls.listingReads).toBe(2)
  expect(harness.calls.receiptReads).toBe(2)
  expect(harness.feedback().children).toContain('Directory removed')
  expect(findAll(harness.renderPath(), (node) => node['data-weir-skill-path'] === '/canonical/b')).toHaveLength(0)
  expect(harness.calls.apply).toBe(0)
})
}

test('landed-but-degraded add keeps the saved fact, forces honest reads, and never claims rollback or Apply', async () => {
  const harness = await createHarness()
  const { behavior, calls } = harness
  behavior.add = async () => {
    behavior.pathSnapshot = { status: 'ok', revision: 9, paths: ['/canonical/a', '/canonical/landed'], error: null }
    behavior.discovered = true
    return { status: 'invalidation-failed', saved: true, revision: 9, paths: behavior.pathSnapshot.paths, error: { message: 'provider invalidation failed' } }
  }
  typePath(harness, '/canonical/landed')
  submitPath(harness)
  await flush()
  await flush()
  harness.renderParent()
  expect(harness.input().value).toBe('')
  expect(harness.feedback()['data-weir-skill-path-feedback']).toBe('warning')
  expect(harness.feedback().children).toContain('was saved')
  expect(harness.feedback().children).toContain('no rollback is claimed')
  expect(harness.feedback().children).toContain('provider invalidation failed')
  expect(calls.pathReads).toBe(2)
  expect(calls.listingReads).toBe(2)
  expect(calls.receiptReads).toBe(2)
  expect(calls.apply).toBe(0)
  expect(findAll(harness.renderParent(), (node) => node.type === 'checkbox' && node['aria-label'] === 'discovered — custom')[0].checked).toBe(false)
})

test('unavailable registry is actionable and never enables a speculative mutation', async () => {
  const harness = await createHarness()
  const { behavior, calls } = harness
  behavior.pathSnapshot = { status: 'unavailable', saved: false, revision: 0, paths: [], error: { message: 'corrupt registry' } }
  findAll(harness.renderPath(), (node) => node.__type === 'button' && node.children === 'Refresh paths')[0].onClick()
  await flush()
  expect(harness.input().disabled).toBe(true)
  expect(findAll(harness.renderPath(), (node) => node.role === 'alert' && String(node.children).includes('corrupt registry')).length).toBeGreaterThanOrEqual(1)
  submitPath(harness)
  expect(calls.add).toEqual([])
  behavior.pathSnapshot = { status: 'ok', revision: 0, paths: [], error: null }
  findAll(harness.renderPath(), (node) => node.__type === 'button' && node.children === 'Refresh paths')[0].onClick()
  await flush()
  expect(harness.input().disabled).toBe(false)
  expect(findAll(harness.renderPath(), (node) => node.children === 'No custom scan paths are registered.')).toHaveLength(1)
})

test('path view dictionaries cover every used key with English and Chinese strings', async () => {
  const react = makeReactStub()
  const { exports } = await loadClientChunk('lib/client.capability-manager.js', requireStubFor(react))
  const source = readFileSync(new URL('../lib/client.capability-manager.js', import.meta.url), 'utf8')
  const used = [...new Set([...source.matchAll(/t\("([^"]*capability\.skills\.paths\.[^"]+)"/g)].map((match) => match[1]))]
  expect(used.length).toBe(28)
  expect(Object.keys(exports.dictionaries.en).sort()).toEqual(Object.keys(exports.dictionaries.zh).sort())
  for (const key of used) {
    expect(typeof exports.dictionaries.en[key], `en ${key}`).toBe('string')
    expect(typeof exports.dictionaries.zh[key], `zh ${key}`).toBe('string')
  }
  expect(exports.dictionaries.zh['capability.skills.paths.confirmTitle']).toContain('移除')
})
