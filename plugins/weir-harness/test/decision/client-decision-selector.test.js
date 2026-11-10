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
      const element = node.ref.current ?? {
        focused: 0,
        focusCalls: 0,
        disabledFocusCalls: 0,
        focus() {
          this.focusCalls += 1
          if (this.disabled) {
            this.disabledFocusCalls += 1
            return
          }
          this.focused += 1
          document.activeElement = this
        },
        contains(target) { return target === this },
      }
      element.disabled = node.disabled === true
      node.ref.current = element
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
    ...selector, calls, document, props, model,
    render: () => runtime.render(selector.DecisionSelector, props),
    flush: async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) },
  }
}

const triggerOf = tree => findAll(tree, node => node.type === 'button' && node['data-weir-decision-trigger'] !== undefined)[0]
const panelOf = tree => findAll(tree, node => node.role === 'dialog')[0]
const partOf = (tree, part) => findAll(tree, node => node['data-selector-part'] === part)[0]
const radioOf = (tree, value) => findAll(tree, node => node.type === 'input' && node.inputType === 'radio' && node.value === value)[0]
const buttonOf = (tree, ui, label) => findAll(tree, node => node.type === ui.Button && node.children === label)[0]
const textOf = tree => JSON.stringify(tree)

const enabledOverview = {
  status: { available: true, enabled: true }, selector: { mode: 'off' },
  auto: { answerClasses: ['A', 'C'], shadow: true },
  agents: [
    { agentId: 'a', name: 'A very long assistant name that must remain readable', state: 'enabled' },
    { agentId: 'b', name: 'Beta', state: 'enabled' },
    { agentId: 'disabled', name: 'Disabled', state: 'disabled' },
    { agentId: 'archived', name: 'Archived', state: 'archived' },
  ],
}

test('selector opens a native modal radio panel with localized options and enabled assistants', async t => {
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
  assert.equal(panel['aria-modal'], true)
  assert.equal(panel.type, h.props.ui.DecisionModalFrame)
  assert.equal(panel.closeOnBackdrop, true)
  assert.equal(panel.restoreFocus, false)
  assert.equal(panel['aria-labelledby'], 'weir-da-selector-title')
  assert.equal(panel.initialFocus, panel.dialogRef)
  assert.deepEqual(findAll(panel, node => node.type === 'input' && node.inputType === 'radio').map(node => node.value), ['off', 'auto', 'a', 'b'])
  assert.ok(findAll(panel, node => node.type === 'input' && node.inputType === 'radio').every(node => node.name === 'weir-da-selector-choice'))
  assert.ok(findAll(panel, node => node.type === 'label' && node.className?.includes('weir-da-selector-option')).length === 4)
  assert.equal(textOf(panel).includes('Disabled'), false)
  assert.equal(textOf(panel).includes('Archived'), false)
  assert.equal(textOf(panel).includes('Auto'), true)
  assert.equal(textOf(panel).includes('decisionAutoWhitelist'), true)
  assert.equal(textOf(panel).includes('A, C'), false)
  assert.equal(textOf(panel).includes('decisionAutoShadowOn'), true)
  assert.equal(findAll(tree, node => node.type === h.props.ui.DecisionStyles).length, 1)
})

test('selector renders localized compact option labels and a real category count without technical copy', async t => {
  const h = await load(t, enabledOverview)
  h.props.t = key => h.model.dictionaries.en[key] ?? key
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  const panel = panelOf(tree)
  const text = textOf(panel)
  assert.equal(radioOf(tree, 'off')['aria-label'], 'Do not use an assistant')
  assert.equal(radioOf(tree, 'auto')['aria-label'], 'Automatically choose an assistant')
  assert.equal(text.includes('Automatic answers are currently allowed for 2 decision categories.'), true)
  assert.equal(text.includes('Selection comparison is on; it never changes the actual result.'), true)
  for (const forbidden of ['A, C', 'Auto routes', 'authorization-class whitelist', 'Shadow diagnostics']) assert.equal(text.includes(forbidden), false, forbidden)
  assert.equal(text.includes('A very long assistant name that must remain readable'), true)
})

test('selector uses fixed header/footer regions and one compact independently scrolling body', async t => {
  const h = await load(t, enabledOverview)
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  const panel = panelOf(tree)
  assert.deepEqual(findAll(panel, node => node['data-selector-part']).map(node => node['data-selector-part']), ['header', 'body', 'footer'])
  const header = partOf(panel, 'header')
  const body = partOf(panel, 'body')
  const footer = partOf(panel, 'footer')
  assert.equal(findAll(header, node => node.id === 'weir-da-selector-title').length, 1)
  assert.equal(findAll(header, node => node.id === 'weir-da-selector-safety').length, 1)
  assert.equal(findAll(body, node => node.role === 'radiogroup').length, 1)
  assert.equal(findAll(body, node => node.inputType === 'radio').length, 4)
  assert.equal(findAll(header, node => node.inputType === 'radio').length, 0)
  assert.equal(findAll(footer, node => node.inputType === 'radio').length, 0)
  assert.ok(buttonOf(footer, h.props.ui, 'decisionManageAgents'))
  const panelCss = h.props.ui.DECISION_UI_CSS.match(/\.weir-da-selector-panel \{([^}]*)\}/)?.[1] ?? ''
  assert.match(panelCss, /width: min\(360px, calc\(100vw - 32px\)\)/)
  assert.match(panelCss, /max-height: min\(560px, calc\(100dvh - 32px\)\)/)
  assert.match(panelCss, /overflow: hidden/)
  assert.match(panelCss, /grid-template-rows: auto minmax\(0, 1fr\) auto/)
  assert.doesNotMatch(panelCss, /(?:^|;)\s*height:/)
  const bodyCss = h.props.ui.DECISION_UI_CSS.match(/\.weir-da-selector-body \{([^}]*)\}/)?.[1] ?? ''
  assert.match(bodyCss, /min-height: 0/)
  assert.match(bodyCss, /overflow: auto/)
  assert.match(bodyCss, /overscroll-behavior: contain/)
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
  assert.ok(findAll(partOf(panelOf(tree), 'body'), node => node.type === h.props.ui.ErrorState).length > 0)
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
  const pendingPanel = panelOf(tree)
  assert.equal(pendingPanel.pending, true)
  pendingPanel.onRequestClose('escape')
  pendingPanel.onRequestClose('backdrop')
  assert.ok(panelOf(h.render()))
  release({ mode: 'agent', agentId: 'a' })
  await h.flush()
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.equal(triggerOf(tree)['aria-expanded'], false)
  assert.equal(textOf(triggerOf(tree)).includes('A very long assistant name'), true)
  assert.equal(triggerOf(tree).ref.current.focused, 1)
  assert.equal(findAll(tree, node => node.role === 'dialog' && node['aria-modal'] === true).length, 0)
})

test('successful selection restores focus only after the enabled trigger commits', async t => {
  let release
  const h = await load(t, enabledOverview, { setSelector: () => new Promise(resolve => { release = resolve }) })
  let tree = h.render()
  const trigger = triggerOf(tree).ref.current
  assert.equal(trigger.focusCalls, 0, 'initial mount never steals focus')
  await h.flush()
  tree = h.render()
  assert.equal(trigger.focusCalls, 0, 'the overview render never steals focus')
  tree = h.render()
  assert.equal(trigger.focusCalls, 0, 'an unrelated render never steals focus')
  triggerOf(tree).onClick()
  tree = h.render()
  radioOf(tree, 'a').onChange({ target: { value: 'a' } })
  tree = h.render()
  assert.equal(triggerOf(tree).disabled, true)
  assert.equal(trigger.focusCalls, 0, 'pending does not focus the disabled trigger')
  release({ mode: 'agent', agentId: 'a' })
  await h.flush()
  assert.equal(trigger.focused, 0, 'focus waits for the enabled trigger to commit')
  assert.equal(trigger.disabledFocusCalls, 0, 'the pending focus attempt is not made')
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.equal(triggerOf(tree).disabled, false)
  assert.equal(trigger.focused, 1)
  assert.equal(h.document.activeElement, trigger)
  tree = h.render()
  assert.equal(trigger.focused, 1, 'later unrelated renders do not repeat focus restoration')
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
  assert.deepEqual(findAll(panelOf(tree), node => node.type === 'input' && node.inputType === 'radio').map(node => node.value), ['off', 'auto', 'a'])
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
  assert.ok(findAll(partOf(panelOf(tree), 'body'), node => node.type === zero.props.ui.EmptyState).length > 0)
  assert.ok(buttonOf(partOf(panelOf(tree), 'footer'), zero.props.ui, 'decisionCreateAgent'))
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

test('Auto selection saves once with no agent id and accepts the persisted Auto result', async t => {
  let release
  const emptyAuto = { ...enabledOverview, auto: { answerClasses: [], shadow: false } }
  const h = await load(t, emptyAuto, { setSelector: () => new Promise(resolve => { release = resolve }) })
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  assert.equal(textOf(panelOf(tree)).includes('decisionAutoEmptyWhitelist'), true)
  assert.equal(textOf(panelOf(tree)).includes('decisionAutoShadowOff'), true)
  const choose = radioOf(tree, 'auto').onChange
  choose()
  choose()
  assert.deepEqual(h.calls.filter(call => call.method === 'setSelector'), [{ method: 'setSelector', args: { sessionId: 'root', mode: 'auto' } }])
  release({ mode: 'auto', agentId: null })
  await h.flush()
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.equal(textOf(triggerOf(tree)).includes('decisionAuto'), true)
  assert.equal(textOf(triggerOf(tree)).includes('decisionSelectionUnavailable'), false)
})

test('Auto save failure preserves the prior valid mode and retries Auto without a second submit', async t => {
  let fail = true
  const h = await load(t, enabledOverview, { setSelector: () => { if (fail) throw new Error('offline'); return { mode: 'auto', agentId: null } } })
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  radioOf(tree, 'auto').onChange()
  await h.flush()
  tree = h.render()
  assert.equal(radioOf(tree, 'off').checked, true)
  assert.equal(radioOf(tree, 'auto').checked, false)
  assert.ok(panelOf(tree))
  fail = false
  buttonOf(panelOf(tree), h.props.ui, 'decisionRetry').onClick()
  await h.flush()
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.deepEqual(h.calls.filter(call => call.method === 'setSelector').map(call => call.args), [
    { sessionId: 'root', mode: 'auto' }, { sessionId: 'root', mode: 'auto' },
  ])
})

test('selector never fabricates success from an empty or mismatched save response', async t => {
  let response = {}
  const h = await load(t, enabledOverview, { setSelector: () => response })
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  radioOf(tree, 'auto').onChange()
  await h.flush()
  tree = h.render()
  assert.ok(panelOf(tree))
  assert.equal(radioOf(tree, 'off').checked, true)
  assert.equal(radioOf(tree, 'auto').checked, false)
  assert.equal(textOf(panelOf(tree)).includes('decisionFailed'), true)

  response = { mode: 'agent', agentId: 'a' }
  buttonOf(panelOf(tree), h.props.ui, 'decisionRetry').onClick()
  await h.flush()
  tree = h.render()
  assert.ok(panelOf(tree))
  assert.equal(radioOf(tree, 'off').checked, true)
  assert.equal(radioOf(tree, 'auto').checked, false)

  response = { mode: 'auto', agentId: null }
  buttonOf(panelOf(tree), h.props.ui, 'decisionRetry').onClick()
  await h.flush()
  assert.equal(panelOf(h.render()), undefined)
})

test('root and child session reads restore their own persisted Auto selection', async t => {
  const h = await load(t, enabledOverview)
  h.render()
  await h.flush()
  h.props.sessionId = 'child'
  h.props.decisionRpc = async (_connection, method, args) => {
    h.calls.push({ method, args })
    if (method === 'overview') return { ...enabledOverview, selector: { mode: 'auto', agentId: null } }
    return { mode: args.mode }
  }
  h.render()
  let tree = h.render()
  assert.equal(textOf(triggerOf(tree)).includes('decisionLoadingShort'), true)
  await h.flush()
  tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  assert.equal(radioOf(tree, 'auto').checked, true)
  assert.equal(h.calls.filter(call => call.method === 'overview').at(-1).args.sessionId, 'child')
})

test('native backdrop and Escape close without saving and return focus to the trigger', async t => {
  const h = await load(t, enabledOverview)
  h.render()
  await h.flush()
  let tree = h.render()
  triggerOf(tree).onClick()
  tree = h.render()
  const trigger = triggerOf(tree).ref.current
  panelOf(tree).onRequestClose('backdrop')
  tree = h.render()
  assert.equal(panelOf(tree), undefined)
  assert.equal(trigger.focused, 1)
  triggerOf(tree).onClick()
  tree = h.render()
  panelOf(tree).onRequestClose('escape')
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
  assert.match(styles, /width: min\(360px, calc\(100vw - 32px\)\)/)
  assert.match(styles, /\.weir-da-selector-panel::backdrop/)
  const panelCss = styles.match(/\.weir-da-selector-panel \{([^}]*)\}/)?.[1] ?? ''
  assert.doesNotMatch(panelCss, /position: absolute|bottom:|70vh|320px/)
  assert.match(panelCss, /margin: auto/)
  assert.match(styles, /@media \(max-width: 600px\)/)
})
