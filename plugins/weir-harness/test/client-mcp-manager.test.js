import { test, expect } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadModel() {
  const source = readFileSync(new URL('../lib/client.capability-model.js', import.meta.url), 'utf8')
  const loaded = {}
  const sandbox = { __ModuleLoader__: { load: ({ factory }) => { loaded.exports = factory(() => { throw new Error('zero-dependency chunk') }) } } }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return loaded.exports
}
const model = loadModel()
const requireStubFor = react => name => {
  if (name === 'react') return react
  if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
  throw new Error(`unexpected require ${name}`)
}
function makeReact() {
  const states = []
  let cursor = 0
  return {
    begin() { cursor = 0 },
    useState(initial) {
      const at = cursor++
      if (!(at in states)) states[at] = [initial, next => { states[at][0] = typeof next === 'function' ? next(states[at][0]) : next }]
      return states[at]
    },
    useRef(initial) {
      const at = cursor++
      if (!(at in states)) states[at] = { current: initial }
      return states[at]
    },
    useEffect(fn) { fn(); return undefined },
    Component: class { constructor(props) { this.props = props; this.state = undefined } },
  }
}
function findAll(node, predicate, out = []) {
  if (node == null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (predicate(node)) out.push(node)
  return findAll(node.children, predicate, out)
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const t = (_key, fallback) => fallback
const buttons = (tree, label) => findAll(tree, node => node.__type === 'button' && node.children === label)
const click = (tree, label, index = 0) => { const matches = buttons(tree, label); expect(matches.length).toBeGreaterThan(index); matches[index].onClick(); }
const input = (tree, label, index = 0) => findAll(tree, node => node.__type === 'input' && node['aria-label'] === label)[index]
const setInput = (node, value) => { expect(node, 'input exists').toBeTruthy(); node.onChange({ target: { value } }) }
const textareas = tree => findAll(tree, node => node.__type === 'textarea')

function server(overrides = {}) {
  return {
    identity: 'docs', label: 'Documentation', serverName: 'docs-public', transport: 'stdio', incarnation: 'inc-1', generation: 3,
    defaultEnabled: true, state: 'degraded', fingerprint: 'fp-docs',
    discovery: { toolCount: null, toolNamesPreview: [], truncated: false },
    lastMount: { status: 'saved-degraded', generation: 3, diagnostic: { message: 'sanitized mount failure' } },
    lastTest: { status: 'mounted', generation: 2 }, startErrors: [], liveReconnect: 'unknown',
    config: {
      identity: 'docs', label: 'Documentation', transport: { kind: 'stdio', ref: 'cmd:node' },
      client: { transport: 'stdio', serverName: 'docs-public', command: 'node', args: ['--flag', '[redacted]'], env: { LEGACY: '[redacted]' } },
      secretRefs: { env: { TOKEN: { ref: 'USER_TOKEN' } }, args: { 1: { ref: 'CLI_TOKEN' } } },
    },
    ...overrides,
  }
}

function fixture(options = {}) {
  const react = makeReact()
  const currentServer = server(options.server)
  const listing = {
    mcpRegistryRevision: 5,
    mcpServers: options.empty ? [] : [currentServer],
    mcpWarnings: [],
    mcpCapabilities: { credentials: true, ephemeral: true },
    ...(options.listing ?? {}),
  }
  const calls = { preview: [], mutate: [], batch: [], toggle: [], refresh: 0 }
  const props = {
    sessionId: 's1', model, t, listing,
    managed: options.empty ? [] : [currentServer], unmanaged: [{ serverName: 'host-gamma', state: 'unmanaged', readOnly: true }],
    draft: { mcpServers: options.empty ? [] : ['docs'] },
    selectionDisabled: false,
    toggle: (...args) => { calls.toggle.push(args) },
    refreshAll: async () => { calls.refresh += 1; return { listing } },
    mcpPreview: async (_sid, request) => {
      calls.preview.push(request)
      return options.preview?.(request) ?? {
        status: 'preview', digest: 'd'.repeat(64), plan: [], registryRevision: 5,
        targets: [{ identity: request.identity ?? 'docs', fingerprint: 'fp-docs', conflict: null, namespaceConflict: null }],
        capabilities: options.capabilities ?? { credentials: true, ephemeral: true },
      }
    },
    mcpMutate: async (_sid, request) => {
      calls.mutate.push(request)
      return options.mutate?.(request) ?? { status: 'mounted', identity: request.identity, generation: 4, incarnation: 'inc-1', discovery: { toolCount: 1 }, saved: true }
    },
    mcpBatch: async (_sid, request) => {
      calls.batch.push(request)
      return options.batch?.(request) ?? { status: 'mounted', atomic: false, items: [] }
    },
  }
  let exports
  const render = () => { react.begin(); return exports.McpManagerView(props) }
  return { react, props, calls, render, async init() { ({ exports } = await loadClientChunk('lib/client.mcp-manager.js', requireStubFor(react))); return this } }
}

test('inventory exposes real lifecycle facts without probing or unmanaged actions', async () => {
  const f = await fixture().init()
  const tree = f.render()
  expect(f.calls.preview).toEqual([])
  expect(f.calls.mutate).toEqual([])
  expect(f.calls.batch).toEqual([])
  expect(findAll(tree, node => String(node.children).includes('incarnation inc-1 · generation 3'))).toHaveLength(1)
  expect(findAll(tree, node => node.children === 'Tools: unknown')).toHaveLength(1)
  expect(findAll(tree, node => node.children === 'Live reconnect/process/stderr: unknown')).toHaveLength(1)
  expect(findAll(tree, node => String(node.children).includes('Last mount: saved-degraded'))).toHaveLength(1)
  expect(findAll(tree, node => node.children === 'sanitized mount failure')).toHaveLength(1)
  expect(buttons(tree, 'Remove')).toHaveLength(1) // only the managed row; unmanaged remains read-only
  expect(findAll(tree, node => node.children === 'unmanaged')).toHaveLength(1)
})

test('Add Basic/Advanced uses inert preview then exact mutation, with pending disabled and no automatic Select/Apply', async () => {
  let resolvePreview
  const f = await fixture({ empty: true, preview: request => new Promise(resolve => {
    resolvePreview = () => resolve({ status: 'preview', digest: 'd'.repeat(64), plan: [], registryRevision: 5, targets: [{ identity: request.identity, fingerprint: null }], capabilities: { credentials: true, ephemeral: true } })
  }) }).init()
  click(f.render(), '+ Add managed MCP server')
  let tree = f.render()
  setInput(input(tree, 'identity (e.g. my-docs)'), 'docs')
  tree = f.render()
  setInput(input(tree, 'label (display name, optional)'), 'Docs')
  tree = f.render()
  setInput(input(tree, 'command (e.g. npx)'), 'node')
  tree = f.render()
  click(tree, 'Advanced')
  tree = f.render()
  click(tree, '+ Add secret/reference')
  tree = f.render()
  setInput(input(tree, 'secret key'), 'TOKEN')
  tree = f.render()
  setInput(input(tree, 'secret value'), 'client-canary')
  tree = f.render()
  click(tree, 'Preview')
  tree = f.render()
  expect(input(tree, 'identity (e.g. my-docs)').disabled).toBe(true)
  expect(buttons(tree, 'Preview')[0].disabled).toBe(true)
  resolvePreview()
  await flush()
  tree = f.render()
  expect(JSON.parse(JSON.stringify(f.calls.preview[0].config.secretValues.env.TOKEN))).toEqual({ action: 'replace', value: 'client-canary' })
  expect(JSON.stringify(f.calls.preview[0])).not.toContain('status": "mounted"')
  expect(f.calls.mutate).toEqual([])
  click(tree, 'Confirm')
  await flush()
  expect(f.calls.mutate).toHaveLength(1)
  expect(f.calls.mutate[0].expectedRevision).toBe(5)
  expect(f.calls.mutate[0].targetFingerprint).toBeNull()
  expect(f.calls.mutate[0].config.secretValues.env.TOKEN.value).toBe('client-canary')
  expect(f.calls.toggle).toEqual([])
  expect(f.calls.refresh).toBeGreaterThan(0)
  expect(buttons(f.render(), '+ Add managed MCP server')[0].disabled).toBe(false)
})

test('failed edit preserves non-secret draft, clears replacement secrets, and offers re-preview', async () => {
  const f = await fixture({ mutate: async () => ({ status: 'revision-conflict', saved: false, error: { code: 'revision-conflict', message: 'changed elsewhere' } }) }).init()
  click(f.render(), 'Edit')
  let tree = f.render()
  setInput(input(tree, 'label (display name, optional)'), 'Edited label')
  tree = f.render()
  click(tree, 'Advanced')
  tree = f.render()
  click(tree, '+ Add secret/reference')
  tree = f.render()
  setInput(input(tree, 'secret key'), 'NEW_TOKEN')
  tree = f.render()
  setInput(input(tree, 'secret value'), 'replacement-canary')
  tree = f.render()
  click(tree, 'Preview')
  await flush()
  click(f.render(), 'Confirm')
  await flush()
  tree = f.render()
  expect(input(tree, 'label (display name, optional)').value).toBe('Edited label')
  expect(input(tree, 'secret value').value).toBe('')
  expect(findAll(tree, node => node.children === 'changed elsewhere')).toHaveLength(1)
  expect(findAll(tree, node => String(node.children).includes('replacement-canary'))).toHaveLength(0)
  click(tree, 'Preview')
  await flush()
  expect(f.calls.preview.length).toBeGreaterThan(1)
})

test('blank secret keep preserves refs; namespace change needs a separate focus-restoring confirmation', async () => {
  const f = await fixture().init()
  click(f.render(), 'Edit')
  setInput(input(f.render(), 'label (display name, optional)'), 'Only label changed')
  f.render()
  click(f.render(), 'Preview')
  await flush()
  click(f.render(), 'Confirm')
  await flush()
  expect(f.calls.mutate[0].config.secretValues).toBeUndefined()
  expect(f.calls.mutate[0].config.secretRefs).toBeUndefined()
  expect(f.calls.mutate[0].confirmNamespaceChange).toBe(false)

  const namespace = await fixture().init()
  click(namespace.render(), 'Edit')
  setInput(input(namespace.render(), 'public server name'), 'renamed-public')
  namespace.render()
  click(namespace.render(), 'Preview')
  await flush()
  const focusCalls = []
  const confirmOrigin = buttons(namespace.render(), 'Confirm')[0]
  confirmOrigin.ref({ focus: () => focusCalls.push('origin') })
  confirmOrigin.onClick()
  let tree = namespace.render()
  expect(namespace.calls.mutate).toEqual([])
  const dialog = findAll(tree, node => node.role === 'dialog')[0]
  expect(dialog).toBeTruthy()
  expect(findAll(dialog, node => String(node.children).includes('docs-public') && String(node.children).includes('renamed-public'))).toHaveLength(1)
  const cancelControl = buttons(dialog, 'Cancel')[0]
  const approveControl = buttons(dialog, 'Confirm')[0]
  cancelControl.ref.current = { focus: () => focusCalls.push('cancel') }
  approveControl.ref.current = { focus: () => focusCalls.push('approve') }
  dialog.onKeyDown({ key: 'Tab', target: approveControl, preventDefault() {} })
  expect(focusCalls).toContain('cancel')
  click(dialog, 'Cancel')
  expect(focusCalls.at(-1)).toBe('origin')
  tree = namespace.render()
  expect(findAll(tree, node => node.role === 'dialog')).toHaveLength(0)
  expect(namespace.calls.mutate).toEqual([])
  click(tree, 'Confirm')
  click(findAll(namespace.render(), node => node.role === 'dialog')[0], 'Confirm')
  await flush()
  expect(namespace.calls.mutate).toHaveLength(1)
  expect(namespace.calls.mutate[0].confirmNamespaceChange).toBe(true)
})

test('Select, default and confirmed Remove never rewrite session selection', async () => {
  const f = await fixture({ mutate: async request => ({ status: request.action === 'remove' ? 'removed' : 'saved', saved: true, defaultRemoved: request.action === 'remove', defaultEnabled: request.enabled }) }).init()
  let tree = f.render()
  const checkbox = findAll(tree, node => node.__type === 'input' && node.type === 'checkbox')[0]
  checkbox.onChange()
  expect(f.calls.toggle).toEqual([['mcpServers', 'docs']])
  expect(f.calls.mutate).toEqual([])

  click(tree, 'Disable default')
  await flush()
  expect(f.calls.mutate[0].action).toBe('setDefault')
  expect(f.calls.mutate[0].identity).toBe('docs')
  expect(f.calls.mutate[0].enabled).toBe(false)
  expect(f.calls.mutate[0].expectedRevision).toBe(5)

  tree = f.render()
  const removeFocus = []
  const removeOrigin = buttons(tree, 'Remove')[0]
  removeOrigin.ref({ focus: () => removeFocus.push('origin') })
  removeOrigin.onClick()
  tree = f.render()
  const dialog = findAll(tree, node => node.role === 'dialog')[0]
  expect(f.calls.mutate).toHaveLength(1)
  dialog.onKeyDown({ key: 'Escape', preventDefault() {} })
  expect(removeFocus).toEqual(['origin'])
  expect(f.calls.mutate).toHaveLength(1)
  expect(findAll(f.render(), node => node.role === 'dialog')).toHaveLength(0)
  click(f.render(), 'Remove')
  click(findAll(f.render(), node => node.role === 'dialog')[0], 'Remove server')
  await flush()
  expect(f.calls.mutate.at(-1).action).toBe('remove')
  expect(f.calls.mutate.at(-1).identity).toBe('docs')
  expect(f.calls.mutate.at(-1).expectedRevision).toBe(5)
  expect(f.calls.mutate.at(-1).targetFingerprint).toBe('fp-docs')
  expect(f.props.draft.mcpServers).toEqual(['docs'])
  expect(f.calls.toggle).toHaveLength(1)
})

test('JSON enforces raw byte bounds and confirms partial per-entry results with retry paths', async () => {
  const document = JSON.stringify({ mcpServers: { docs: { command: 'node' }, other: { command: 'node' } } })
  const f = await fixture({
    empty: true,
    preview: async () => ({ status: 'preview', digest: 'd'.repeat(64), plan: [{ identity: 'docs' }, { identity: 'other' }], registryRevision: 5, targets: [], capabilities: { credentials: true, ephemeral: true } }),
    batch: async () => ({ status: 'partial', atomic: false, items: [
      { identity: 'docs', status: 'saved-degraded', saved: true, error: { code: 'timeout', message: 'mount failed' } },
      { identity: 'other', status: 'not-attempted', saved: false, error: { code: 'batch-aborted', message: 'owner changed' } },
    ] }),
  }).init()
  click(f.render(), 'Paste JSON')
  let tree = f.render()
  textareas(tree)[0].onChange({ target: { value: `{"x":"${'x'.repeat(1024 * 1024 + 1)}"}` } })
  click(f.render(), 'Preview')
  expect(f.calls.preview).toEqual([])
  expect(findAll(f.render(), node => String(node.children).includes('1 MiB'))).toHaveLength(1)

  tree = f.render()
  textareas(tree)[0].onChange({ target: { value: document } })
  click(f.render(), 'Preview')
  await flush()
  expect(f.calls.preview).toHaveLength(1)
  click(f.render(), 'Confirm batch')
  expect(f.calls.batch).toEqual([])
  click(findAll(f.render(), node => node.role === 'dialog')[0], 'Confirm')
  await flush()
  expect(f.calls.batch).toHaveLength(1)
  tree = f.render()
  expect(findAll(tree, node => node.children === 'saved-degraded')).toHaveLength(1)
  expect(findAll(tree, node => node.children === 'not attempted')).toHaveLength(1)
  expect(findAll(tree, node => String(node.children).includes('no atomic rollback'))).toHaveLength(1)
  click(tree, 'Retry / edit', 1)
  tree = f.render()
  expect(textareas(tree)[0].value).toContain('"other"')
  expect(textareas(tree)[0].value).not.toContain('"docs"')
})

test('capability degradation disables secret work and saved-degraded remains failed with saved facts', async () => {
  const f = await fixture({ capabilities: { credentials: false, ephemeral: false } }).init()
  click(f.render(), 'Edit')
  click(f.render(), 'Preview')
  await flush()
  const tree = f.render()
  expect(buttons(tree, 'Confirm')[0].disabled).toBe(true)
  expect(buttons(tree, 'Test')[0].disabled).toBe(true)
  expect(findAll(tree, node => node.children === 'credentials-unavailable')).toHaveLength(1)
  expect(findAll(tree, node => node.children === 'ephemeral-loader-unavailable')).toHaveLength(1)
  expect(f.calls.mutate).toEqual([])

  const degraded = await fixture({ mutate: async () => ({ status: 'saved-degraded', saved: true, generation: 4, error: { code: 'timeout', message: 'still degraded' } }) }).init()
  click(degraded.render(), 'Edit')
  click(degraded.render(), 'Preview')
  await flush()
  click(degraded.render(), 'Confirm')
  await flush()
  const result = degraded.render()
  expect(findAll(result, node => node.children === 'saved-degraded')).toHaveLength(1)
  expect(findAll(result, node => node.children === 'saved')).toHaveLength(1)
  expect(findAll(result, node => node.children === 'still degraded')).toHaveLength(1)
  expect(buttons(result, 'Edit')).toHaveLength(1)
})

test('stale inventory and the MCP-only error boundary stay explicit', async () => {
  const f = await fixture({ listing: { stale: true, refreshError: true, mcpUnavailable: { status: 'corrupt' } } }).init()
  const tree = f.render()
  expect(findAll(tree, node => node.children === 'stale — last good inventory')).toHaveLength(1)
  expect(findAll(tree, node => String(node.children).includes('MCP registry unavailable: corrupt'))).toHaveLength(1)
  expect(findAll(tree, node => node.children === 'Documentation')).toHaveLength(1)

  const { exports } = await loadClientChunk('lib/client.mcp-manager.js', requireStubFor(makeReact()))
  const boundary = new exports.McpManagerBoundary({ t, children: null })
  boundary.state = exports.McpManagerBoundary.getDerivedStateFromError(new Error('boom'))
  const fallback = boundary.render()
  expect(fallback.role).toBe('alert')
  expect(fallback.children).toContain('Other capability controls remain available')
})

test('row lifecycle actions are disabled while an edit-mode Test is in flight', async () => {
  let resolveTest
  const f = await fixture({ mutate: request => request.action === 'test'
    ? new Promise(resolve => { resolveTest = () => resolve({ status: 'mounted', identity: 'docs', saved: false, probe: true }) })
    : undefined }).init()
  click(f.render(), 'Edit')
  click(f.render(), 'Preview')
  await flush()
  click(f.render(), 'Test')
  const busy = f.render()
  for (const label of ['Restart', 'Remove', 'Edit', 'Disable default']) expect(buttons(busy, label)[0].disabled, label).toBe(true)
  resolveTest()
  await flush()
  const idle = f.render()
  for (const label of ['Restart', 'Remove', 'Edit', 'Disable default']) expect(buttons(idle, label)[0].disabled, label).toBe(false)
})
