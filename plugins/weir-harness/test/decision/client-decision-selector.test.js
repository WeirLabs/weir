import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'ref') continue
    if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found)
    else if (value && typeof value === 'object') findAll(value, predicate, found)
  }
  return found
}

function makeReact(document) {
  const hooks = []
  const pending = new Set()
  let cursor = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const set = next => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next }
      return [hooks[index].value, set]
    },
    useRef(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useId() {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: `selector-test-${index}` }
      return hooks[index].value
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = hooks[index]
      const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((value, at) => !Object.is(value, previous.deps[at]))
      if (changed) {
        hooks[index] = { ...previous, deps, source: fn }
        pending.add(index)
      }
    },
  }
  const mount = tree => {
    for (const node of findAll(tree, item => item.ref && typeof item.ref === 'object')) {
      if (node.ref.current) continue
      node.ref.current = {
        focused: 0,
        focus() { this.focused += 1; document.activeElement = this },
        contains(target) { return target === this },
      }
    }
  }
  const effects = () => {
    for (const index of [...pending]) {
      pending.delete(index)
      const hook = hooks[index]
      hook.cleanup?.()
      hook.cleanup = hook.source()
    }
  }
  return {
    react,
    render(Component, props) {
      cursor = 0
      const tree = Component(props)
      mount(tree)
      effects()
      return tree
    },
    unmount() { for (const hook of hooks) hook?.cleanup?.() },
  }
}

async function load(t, overview, behavior = {}) {
  const listeners = new Map()
  const document = {
    activeElement: null,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    emit(type, event) { for (const listener of listeners.get(type) ?? []) listener(event) },
  }
  const previousDocument = globalThis.document
  globalThis.document = document
  const runtime = makeReact(document)
  t.after(() => {
    runtime.unmount()
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  })
  const jsx = (type, props) => ({ ...props, type, inputType: props?.type })
  const require = name => name === 'react' ? runtime.react : { jsx, jsxs: jsx }
  const ui = (await loadClientChunk('lib/client.decision-ui.js', require)).exports
  const selector = (await loadClientChunk('lib/client.decision-selector.js', require)).exports
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const calls = []
  const props = {
    sessionId: 'root', connection: {}, ui,
    selectorOptions: model.selectorOptions, selectorView: model.selectorView,
    decisionRpc: async (_connection, method, args) => {
      calls.push({ method, args })
      if (method === 'overview') return behavior.overview ? behavior.overview() : overview
      return behavior.setSelector?.(args) ?? { mode: args.mode, ...(args.agentId ? { agentId: args.agentId } : {}) }
    },
    onManage: () => calls.push({ method: 'manage' }),
    onCreate: () => calls.push({ method: 'create' }),
    t: key => key,
  }
  return {
    ...selector, calls, document, props,
    render: () => runtime.render(selector.DecisionSelector, props),
    flush: async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) },
  }
}

const triggerOf = tree => findAll(tree, node => node.type === 'button' && node['data-weir-decision-trigger'] !== undefined)[0]
const panelOf = tree => findAll(tree, node => node.role === 'dialog')[0]
const radioOf = (tree, value) => findAll(tree, node => node.type === 'input' && node.inputType === 'radio' && node.value === value)[0]
const buttonOf = (tree, ui, label) => findAll(tree, node => node.type === ui.Button && node.children === label)[0]
const textOf = tree => JSON.stringify(tree)

const enabledOverview = {
  status: { available: true, enabled: true }, selector: { mode: 'off' },
  agents: [
    { agentId: 'a', name: 'A very long assistant name that must remain readable', state: 'enabled' },
    { agentId: 'b', name: 'Beta', state: 'enabled' },
    { agentId: 'disabled', name: 'Disabled', state: 'disabled' },
    { agentId: 'archived', name: 'Archived', state: 'archived' },
  ],
}

test('selector opens a non-modal radio panel with only Off and enabled assistants', async t => {
  const h = await load(t, enabledOverview)
  let tree = h.render()
  let trigger = triggerOf(tree)
  assert.ok(trigger)
  assert.equal(trigger['aria-haspopup'], 'dialog')
  assert.equal(trigger['aria-expanded'], false)
  assert.equal(textOf(trigger).includes('decisionOff'), false)
  assert.equal(textOf(trigger).includes('decisionLoadingShort'), true)
  assert.equal(findAll(tree, node => node.type === 'select').length, 0)
  await h.flush()
  tree = h.render()
  trigger = triggerOf(tree)
  assert.equal(textOf(trigger).includes('decisionOff'), true)
  trigger.onClick()
  tree = h.render()
  const panel = panelOf(tree)
  assert.ok(panel)
  assert.equal(panel['aria-modal'], false)
  assert.equal(panel['aria-labelledby'], 'weir-da-selector-title')
  assert.equal(h.document.activeElement, panel.ref.current)
  assert.deepEqual(findAll(panel, node => node.type === 'input' && node.inputType === 'radio').map(node => node.value), ['off', 'a', 'b'])
  assert.ok(findAll(panel, node => node.type === 'input' && node.inputType === 'radio').every(node => node.name === 'weir-da-selector-choice'))
  assert.ok(findAll(panel, node => node.type === 'label' && node.className?.includes('weir-da-selector-option')).length === 3)
  assert.equal(textOf(panel).includes('Disabled'), false)
  assert.equal(textOf(panel).includes('Archived'), false)
  assert.equal(textOf(panel).includes('Auto'), false)
  assert.equal(findAll(tree, node => node.type === h.props.ui.DecisionStyles).length, 1)
})

test('initial read failure is not Off and an explicit retry loads the real selection', async t => {
  let fail = true
  const h = await load(t, enabledOverview, { overview: () => { if (fail) throw Object.assign(new Error('read offline'), { code: 'NETWORK' }); return enabledOverview } })
  let tree = h.render()
  assert.equal(textOf(triggerOf(tree)).includes('decisionOff'), false)
  await h.flush()
  tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  assert.equal(textOf(panelOf(tree)).includes('decisionFailed'), true)
  assert.equal(textOf(panelOf(tree)).includes('read offline'), false)
  const readDiagnostics = findAll(panelOf(tree), node => node.type === h.props.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  assert.ok(readDiagnostics)
  assert.equal(textOf(readDiagnostics.children()).includes('read offline'), true)
  assert.equal(textOf(readDiagnostics.children()).includes('NETWORK'), true)
  assert.equal(findAll(panelOf(tree), node => node.inputType === 'radio').length, 0)
  fail = false
  buttonOf(panelOf(tree), h.props.ui, 'decisionRetry').onClick()
  tree = h.render()
  await h.flush()
  tree = h.render()
  assert.equal(radioOf(tree, 'off').checked, true)
  assert.equal(radioOf(tree, 'a').checked, false)
  assert.equal(h.calls.filter(call => call.method === 'overview').length, 2)
})

test('selection saves exactly once and closes without confirmation', async t => {
  let release
  const h = await load(t, enabledOverview, { setSelector: () => new Promise(resolve => { release = resolve }) })
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  const choose = radioOf(tree, 'a').onChange
  choose({ target: { value: 'a' } })
  choose({ target: { value: 'a' } })
  assert.deepEqual(h.calls.filter(call => call.method === 'setSelector'), [{ method: 'setSelector', args: { sessionId: 'root', mode: 'agent', agentId: 'a' } }])
  tree = h.render()
  assert.ok(panelOf(tree))
  assert.equal(textOf(tree).includes('decisionSaving'), true)
  assert.equal(panelOf(tree)['aria-busy'], true)
  assert.ok(findAll(tree, node => node.type === 'input' && node.inputType === 'radio').every(node => node.disabled))
  release({ mode: 'agent', agentId: 'a' })
  await h.flush()
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.equal(triggerOf(tree)['aria-expanded'], false)
  assert.equal(textOf(triggerOf(tree)).includes('A very long assistant name'), true)
  assert.equal(triggerOf(tree).ref.current.focused, 1)
  assert.equal(findAll(tree, node => node.role === 'dialog' && node['aria-modal'] === true).length, 0)
})

test('failed save preserves the prior selection and retries the requested target', async t => {
  let fail = true
  const selected = { ...enabledOverview, selector: { mode: 'agent', agentId: 'a' } }
  const h = await load(t, selected, { setSelector: () => { if (fail) throw Object.assign(new Error('remote offline'), { code: 'NETWORK' }); return { mode: 'off' } } })
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  radioOf(tree, 'off').onChange({ target: { value: 'off' } })
  await h.flush()
  tree = h.render()
  assert.ok(panelOf(tree))
  assert.equal(radioOf(tree, 'a').checked, true)
  assert.equal(radioOf(tree, 'off').checked, false)
  assert.equal(textOf(panelOf(tree)).includes('decisionFailed'), true)
  assert.equal(textOf(panelOf(tree)).includes('remote offline'), false)
  const saveDiagnostics = findAll(panelOf(tree), node => node.type === h.props.ui.Disclosure && node.label === 'decisionAdvancedDiagnostics')[0]
  assert.ok(saveDiagnostics)
  assert.equal(textOf(saveDiagnostics.children()).includes('remote offline'), true)
  assert.equal(textOf(saveDiagnostics.children()).includes('NETWORK'), true)
  fail = false
  const retry = findAll(panelOf(tree), node => (node.type === 'button' || node.type === h.props.ui.Button) && node.children === 'decisionRetry')[0]
  retry.onClick()
  await h.flush()
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.deepEqual(h.calls.filter(call => call.method === 'setSelector').map(call => call.args), [
    { sessionId: 'root', mode: 'off' }, { sessionId: 'root', mode: 'off' },
  ])
  assert.equal(textOf(triggerOf(tree)).includes('decisionOff'), true)
})

test('unavailable, zero-agent, and globally disabled views never silently reassign', async t => {
  const unavailable = {
    status: { available: true, enabled: true }, selector: { mode: 'agent', agentId: 'archived' },
    agents: [{ agentId: 'a', name: 'Available', state: 'enabled' }, { agentId: 'archived', name: 'Pinned archive', state: 'archived' }],
  }
  const h = await load(t, unavailable)
  h.render()
  await h.flush()
  let tree = h.render()
  assert.equal(textOf(triggerOf(tree)).includes('Pinned archive'), true)
  assert.equal(textOf(triggerOf(tree)).includes('decisionSelectionUnavailable'), true)
  triggerOf(tree).onClick()
  tree = h.render()
  assert.deepEqual(findAll(panelOf(tree), node => node.type === 'input' && node.inputType === 'radio').map(node => node.value), ['off', 'a'])
  assert.equal(radioOf(tree, 'archived'), undefined)
  assert.equal(textOf(panelOf(tree)).includes('Pinned archive'), true)
  assert.equal(textOf(panelOf(tree)).includes('decisionSelectionUnavailable'), true)

  const zero = await load(t, { status: { available: true, enabled: true }, selector: { mode: 'off' }, agents: [] })
  zero.render()
  await zero.flush()
  tree = zero.render()
  triggerOf(tree).onClick()
  tree = zero.render()
  assert.equal(textOf(panelOf(tree)).includes('decisionNoAgents'), true)
  buttonOf(tree, zero.props.ui, 'decisionCreateAgent').onClick()
  tree = zero.render()
  assert.equal(panelOf(tree), undefined)
  triggerOf(tree).onClick()
  tree = zero.render()
  buttonOf(tree, zero.props.ui, 'decisionManageAgents').onClick()
  assert.deepEqual(zero.calls.filter(call => ['create', 'manage'].includes(call.method)).map(call => call.method), ['create', 'manage'])

  const globalOff = await load(t, { status: { available: false, enabled: false, reason: 'disabled' }, selector: { mode: 'agent', agentId: 'a' }, agents: [{ agentId: 'a', name: 'Still pinned', state: 'enabled' }] })
  globalOff.render()
  await globalOff.flush()
  tree = globalOff.render()
  triggerOf(tree).onClick()
  tree = globalOff.render()
  assert.equal(textOf(panelOf(tree)).includes('decisionGlobalOff'), true)
  assert.equal(textOf(panelOf(tree)).includes('decisionGlobalOffHint'), true)
  assert.equal(radioOf(tree, 'a').checked, true)
})

test('outside click and Escape close without saving and return focus to the trigger', async t => {
  const h = await load(t, enabledOverview)
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  const trigger = triggerOf(tree).ref.current
  const root = findAll(tree, node => node['data-weir-decision-selector'] !== undefined)[0]
  h.document.emit('pointerdown', { target: root.ref.current })
  tree = h.render()
  assert.ok(panelOf(tree))
  h.document.emit('pointerdown', { target: {} })
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.equal(trigger.focused, 1)
  triggerOf(tree).onClick()
  tree = h.render()
  h.document.emit('keydown', { key: 'Escape', preventDefault() {} })
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.equal(trigger.focused, 2)
  assert.equal(h.calls.filter(call => call.method === 'setSelector').length, 0)
})

test('selector keeps composition ids and uses bounded responsive styles without polling or DOM escapes', async t => {
  const h = await load(t, enabledOverview)
  assert.equal(h.SELECTOR_ID, 'weir-decision-selector')
  const production = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  assert.match(production, /name: "conversation.input.right", id: "weir-decision-selector", order: 90/)
  assert.match(production, /name: "sidebar.panellist", id: "weir-decisions", order: 12/)
  const source = readFileSync(new URL('../../lib/client.decision-selector.js', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../../lib/client.decision-ui.js', import.meta.url), 'utf8')
  assert.equal(/setInterval|setTimeout|document\.body|\.closest\(|session\.append|commands\.execute/.test(source), false)
  assert.equal(/<select|jsx\.jsx\("select"|jsx\.jsxs\("select"/.test(source), false)
  assert.equal(/#[\da-f]{3,8}\b/i.test(source), false)
  assert.match(styles, /\.weir-da-selector-panel/)
  assert.match(styles, /max-height:/)
  assert.match(styles, /overflow: auto/)
  assert.match(styles, /width: min\(320px, calc\(100vw - 24px\)\)/)
  assert.match(styles, /@media \(max-width: 600px\)/)
})
