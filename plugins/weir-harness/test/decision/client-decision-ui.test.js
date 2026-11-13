import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from '../helpers/load-client-chunk.js'

function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found)
    else if (value && typeof value === 'object') findAll(value, predicate, found)
  }
  return found
}

function makeReact() {
  const hooks = []
  let cursor = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: initial }
      const set = next => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next }
      return [hooks[index].value, set]
    },
    useRef(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(fn) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { cleanup: fn() }
    },
    useId() {
      const index = cursor++
      if (!hooks[index]) hooks[index] = `id-${index}`
      return hooks[index]
    },
  }
  return { react, begin: () => { cursor = 0 }, unmount: () => { for (const hook of hooks) hook?.cleanup?.() } }
}

function makeModalReact(createElement) {
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
    useEffect(fn, deps) {
      const index = cursor++
      const previous = hooks[index]
      const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((value, at) => !Object.is(value, previous.deps[at]))
      if (changed) {
        hooks[index] = { ...previous, deps, source: fn }
        pending.add(index)
      }
    },
    useId() {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: `modal-test-${index}` }
      return hooks[index].value
    },
  }
  const mount = tree => {
    for (const node of findAll(tree, item => item.ref && typeof item.ref === 'object')) {
      const element = node.ref.current ?? (createElement?.(node) || {
        focused: 0, isConnected: true,
        focus() { this.focused += 1 },
      })
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
      let tree = Component(props)
      while (typeof tree?.type === 'function') tree = tree.type(tree)
      mount(tree)
      effects()
      return tree
    },
    unmount() { for (const hook of hooks) hook?.cleanup?.() },
  }
}

function makeScrollFixture() {
  const makeScroller = (name, parentElement, scrollTop) => ({
    name, parentElement, scrollTop, scrollLeft: scrollTop - 1, offsetWidth: 200, clientWidth: 200,
    style: {
      overflow: 'auto', overflowX: 'hidden', overflowY: 'auto',
      overscrollBehavior: 'contain', overscrollBehaviorX: 'auto', overscrollBehaviorY: 'contain', paddingRight: '7px', overflowAnchor: 'auto',
    },
    computed: { overflowY: 'auto', paddingRight: '7px' },
  })
  const root = makeScroller('root', null, 11)
  const body = makeScroller('body', root, 22)
  const page = makeScroller('page', body, 33)
  const session = makeScroller('session', page, 44)
  const composer = makeScroller('composer', session, 55)
  const origin = { isConnected: true, parentElement: composer, focused: 0, focus() { this.focused += 1 } }
  const view = {
    innerWidth: 1000, scrollX: 3, scrollY: 4, scrollCalls: 0,
    getComputedStyle: element => element.computed,
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; this.scrollCalls += 1 },
  }
  const document = {
    documentElement: root, body, activeElement: origin, defaultView: view,
    querySelectorAll(selector) { return selector === '.weir-da-page' ? [page] : [] },
  }
  return { document, view, root, body, page, session, composer, origin, targets: [root, body, page, session, composer] }
}

function assertScrollLocked(fixture) {
  for (const target of fixture.targets) {
    assert.equal(target.style.overflow, 'hidden', target.name)
    assert.equal(target.style.overflowY, 'hidden', target.name)
    assert.equal(target.style.overscrollBehavior, 'none', target.name)
    assert.equal(target.style.overflowAnchor, 'none', `${target.name} disables browser scroll anchoring while locked`)
  }
}

function assertScrollRestored(fixture) {
  for (const [index, target] of fixture.targets.entries()) {
    assert.equal(target.style.overflow, 'auto', target.name)
    assert.equal(target.style.overflowX, 'hidden', target.name)
    assert.equal(target.style.overflowY, 'auto', target.name)
    assert.equal(target.style.overscrollBehavior, 'contain', target.name)
    assert.equal(target.style.overflowAnchor, 'auto', `${target.name} restores its prior scroll anchoring`)
    assert.equal(target.style.overscrollBehaviorX, 'auto', target.name)
    assert.equal(target.style.overscrollBehaviorY, 'contain', target.name)
    assert.equal(target.style.paddingRight, '7px', target.name)
    assert.equal(target.scrollTop, (index + 1) * 11, target.name)
    assert.equal(target.scrollLeft, (index + 1) * 11 - 1, target.name)
  }
  assert.equal(fixture.view.scrollX, 3)
  assert.equal(fixture.view.scrollY, 4)
}

async function load(react = {}) {
  const jsx = (type, props) => ({ ...props, type, inputType: props?.type })
  const runtime = { cloneElement: (element, props) => ({ ...element, ...props }), ...react }
  const { exports } = await loadClientChunk('lib/client.decision-ui.js', name => name === 'react' ? runtime : { jsx, jsxs: jsx })
  return exports
}

test('shared atoms use theme tokens, explicit action hierarchy, and readable state surfaces', async () => {
  const ui = await load()
  const button = ui.Button({ variant: 'primary', children: 'Save' })
  assert.equal(button.type, 'button')
  assert.equal(button['data-variant'], 'primary')
  assert.equal(button.className, 'weir-da-button')
  const badge = ui.Badge({ variant: 'warn', children: 'Needs attention' })
  assert.equal(badge.role, 'status')
  assert.ok(findAll(badge, node => node.type === ui.DecisionIcon).length > 0)
  const field = ui.Field({ id: 'preference', label: 'Decision preference', hint: 'Optional', children: { type: 'textarea', id: 'preference', 'aria-describedby': 'existing-help' } })
  const control = findAll(field, node => node.type === 'textarea')[0]
  assert.equal(control['aria-describedby'], 'existing-help preference-hint')
  assert.equal(findAll(field, node => node.id === 'preference-hint')[0].children, 'Optional')
  const label = findAll(field, node => node.type === 'label')[0]
  assert.equal(label.htmlFor, 'preference')
  assert.equal(label.children, 'Decision preference')
  assert.equal(ui.LoadingState({ children: 'Loading…' })['aria-busy'], true)
  assert.equal(ui.EmptyState({ children: 'No assistants' }).role, 'status')
  assert.equal(ui.ErrorState({ children: 'Try again' }).role, 'alert')
  const styles = ui.DecisionStyles()
  assert.equal(styles.type, 'style')
  assert.match(styles.children, /\.weir-da-button:hover/)
  assert.match(styles.children, /:focus-visible/)
  assert.match(styles.children, /@media \(max-width: 600px\)/)
  // Dialog and selector surfaces use the menu material, not the mid-grey overlay fill.
  assert.match(styles.children, /\.weir-da-overlay \{[^}]*background: var\(--dsw-specific-menu\)/)
  assert.match(styles.children, /\.weir-da-selector-option\[data-selected="true"\] \{[^}]*border-selected/)
  assert.match(styles.children, /\.weir-da-conversation-card \{ position: relative; \}/)
  assert.match(styles.children, /\.weir-da-candidate-review/)
  assert.match(styles.children, /\.weir-da-learning-diagnostics pre/)
  assert.match(styles.children, /\.weir-da-source-excerpt/)
  const source = readFileSync(new URL('../../lib/client.decision-ui.js', import.meta.url), 'utf8')
  assert.equal(/#[\da-f]{3,8}\b/i.test(source), false)
  assert.equal(source.includes('document.body'), false)
  assert.equal(source.includes('@deepseek-ai/'), false)
})

test('assistant master-detail styles keep compact summaries, independent regions, and narrow drill-in', async () => {
  const css = (await load()).DecisionStyles().children
  assert.match(css, /\.weir-da-agents-layout \{[^}]*display: grid;[^}]*grid-template-columns:/)
  assert.match(css, /\.weir-da-agent-list, \.weir-da-agent-detail-pane \{[^}]*min-width: 0;/)
  assert.match(css, /\.weir-da-agent-summary-preference \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/)
  assert.match(css, /\.weir-da-agent-summary\[data-selected="true"\]/)
  assert.match(css, /\.weir-da-agent-back \{ display: none; \}/)
  assert.match(css, /\.weir-da-agents-layout\[data-agent-drill-in="true"\] \.weir-da-agent-list \{ display: none; \}/)
  assert.match(css, /\.weir-da-agents-layout\[data-agent-drill-in="false"\] \.weir-da-agent-detail-pane \{ display: none; \}/)
})

test('ordinary narrow content reserves the host navigation strip while scaled containment stays unchanged', async () => {
  const css = (await load()).DecisionStyles().children
  const ordinary = css.match(/@media \(max-width: 400px\) \{\s*\.weir-da-page-inner \{([^}]*)\}/)?.[1] ?? ''
  assert.match(ordinary, /padding:\s*52px 12px 12px/, 'the h1 starts below the native host open-sidebar and new-session controls')
  assert.match(css, /\.weir-da-page\[data-visual-viewport="compact"\] \.weir-da-page-inner \{ padding: 12px; gap: 16px; \}/, 'real page-scale containment keeps its proven compact padding')
})

test('Disclosure closes with Escape and restores focus', async () => {
  const runtime = makeReact()
  const ui = await load(runtime.react)
  const trigger = { focused: 0, focus() { this.focused += 1 } }
  const disclosureProps = { id: 'evidence', label: 'Rationale', children: 'Current evidence', returnFocus: trigger }
  runtime.begin()
  let disclosure = ui.Disclosure(disclosureProps)
  let disclosureButton = findAll(disclosure, node => node.type === 'button')[0]
  assert.equal(disclosureButton['aria-expanded'], false)
  assert.equal(disclosureButton['aria-controls'], 'evidence-content')
  disclosureButton.onClick()
  runtime.begin()
  disclosure = ui.Disclosure(disclosureProps)
  disclosureButton = findAll(disclosure, node => node.type === 'button')[0]
  assert.equal(disclosureButton['aria-expanded'], true)
  assert.equal(findAll(disclosure, node => node.id === 'evidence-content').length, 1)
  disclosure.onKeyDown({ key: 'Escape', preventDefault() {} })
  assert.equal(trigger.focused, 1)
  runtime.begin()
  disclosure = ui.Disclosure(disclosureProps)
  assert.equal(findAll(disclosure, node => node.type === 'button')[0]['aria-expanded'], false)
})

test('ConfirmDialog mounts a native modal, focuses Cancel, handles native Escape, and closes before focus return', async () => {
  const previous = { focused: 0, isConnected: true, focus() { this.focused += 1 } }
  const cancel = { focused: 0, isConnected: true, focus() { this.focused += 1 } }
  const confirm = { focused: 0, isConnected: true, focus() { this.focused += 1 } }
  const native = {
    open: false, showModalCalls: 0, closeCalls: 0,
    showModal() { this.showModalCalls += 1; this.open = true },
    close() { this.closeCalls += 1; this.open = false },
  }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = { activeElement: previous }
  let cancellations = 0
  try {
    const ui = await load(runtime.react)
    const props = {
      id: 'discard', title: 'Discard draft?', body: 'Unsaved edits are lost.', confirmLabel: 'Discard', cancelLabel: 'Keep editing',
      onConfirm() {}, onCancel: () => { cancellations += 1 }, cancelRef: { current: cancel }, confirmRef: { current: confirm },
    }
    const tree = runtime.render(ui.ConfirmDialog, props)
    const dialog = findAll(tree, node => node.type === 'dialog')[0]
    assert.ok(dialog)
    assert.equal(dialog.id, 'discard')
    assert.equal(dialog['aria-modal'], true)
    assert.equal(dialog['aria-labelledby'], 'discard-title')
    assert.equal(native.showModalCalls, 1)
    assert.equal(native.open, true)
    assert.equal(cancel.focused, 1)
    const buttons = findAll(dialog, node => node.type === ui.Button)
    assert.equal(buttons.filter(button => button.variant === 'primary').length, 1)
    dialog.onKeyDown({ key: 'Tab', target: confirm, preventDefault() {} })
    assert.equal(cancel.focused, 2)
    assert.equal(findAll(tree, node => node.className === 'weir-da-dialog-shade').length, 0)
    dialog.onCancel({ preventDefault() {} })
    assert.equal(cancellations, 1)
    runtime.unmount()
    assert.equal(native.closeCalls, 1)
    assert.equal(native.open, false)
    assert.equal(previous.focused, 1)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('ConfirmDialog reports native opening failure inline without a fake modal and restores focus', async () => {
  const previous = { focused: 0, isConnected: true, focus() { this.focused += 1 } }
  const native = { open: false, closeCalls: 0, showModal() { throw new Error('top layer unavailable') }, close() { this.closeCalls += 1 } }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = { activeElement: previous }
  let cancellations = 0
  let dismissals = 0
  const failures = []
  try {
    const ui = await load(runtime.react)
    const props = {
      id: 'native-failure', title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      openErrorLabel: 'The confirmation could not be opened.', dismissLabel: 'Close',
      onConfirm() {}, onCancel: () => { cancellations += 1 }, onOpenError: error => failures.push(error), onDismissError: () => { dismissals += 1 },
    }
    runtime.render(ui.ConfirmDialog, props)
    const tree = runtime.render(ui.ConfirmDialog, props)
    assert.equal(previous.focused, 1)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].message, 'top layer unavailable')
    assert.equal(findAll(tree, node => node.type === 'dialog').length, 0)
    assert.equal(findAll(tree, node => node.className === 'weir-da-dialog-shade').length, 0)
    const alert = findAll(tree, node => node.role === 'alert')[0]
    assert.ok(alert)
    assert.equal(JSON.stringify(alert).includes('The confirmation could not be opened.'), true)
    findAll(tree, node => node.type === ui.Button && node.children === 'Close')[0].onClick()
    assert.equal(dismissals, 1)
    assert.equal(cancellations, 0)
    runtime.unmount()
    assert.equal(native.closeCalls, 0)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('native modal locks and restores root, Decision page, session, and composer scrollers without touching panel scroll', async () => {
  const fixture = makeScrollFixture()
  const native = { open: false, style: {}, showModal() { this.open = true }, close() { this.open = false } }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = fixture.document
  try {
    const ui = await load(runtime.react)
    runtime.render(ui.ConfirmDialog, {
      id: 'scroll-lock', title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      returnFocus: fixture.origin, onConfirm() {}, onCancel() {},
    })
    assertScrollLocked(fixture)
    assert.notEqual(native.style.overflow, 'hidden')
    for (const target of fixture.targets) { target.scrollTop = 999; target.scrollLeft = 999 }
    fixture.view.scrollX = 99
    fixture.view.scrollY = 99
    runtime.unmount()
    assertScrollRestored(fixture)
    assert.equal(fixture.view.scrollCalls, 1)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('native modal scroll lock resists Host programmatic auto-follow with event cleanup and no polling', async () => {
  const fixture = makeScrollFixture()
  for (const target of [...fixture.targets, fixture.view]) {
    const listeners = new Map()
    target.scrollListeners = listeners
    target.addEventListener = (type, listener) => { if (type === 'scroll') { const current = listeners.get(type) ?? new Set(); current.add(listener); listeners.set(type, current) } }
    target.removeEventListener = (type, listener) => { if (type === 'scroll') { const current = listeners.get(type); current?.delete(listener); if (current?.size === 0) listeners.delete(type) } }
    target.emitScroll = () => { for (const listener of listeners.get('scroll') ?? []) listener() }
  }
  const native = { open: false, style: {}, showModal() { this.open = true }, close() { this.open = false } }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = fixture.document
  try {
    const ui = await load(runtime.react)
    runtime.render(ui.ConfirmDialog, {
      id: 'scroll-lock-auto-follow', title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      returnFocus: fixture.origin, onConfirm() {}, onCancel() {},
    })
    const target = fixture.composer
    const before = { top: target.scrollTop, left: target.scrollLeft }
    assert.equal(target.scrollListeners.get('scroll')?.size, 1, 'the real scroller has one event-driven lock')
    target.scrollTop = before.top + 111
    target.scrollLeft = before.left + 17
    target.emitScroll()
    assert.deepEqual({ top: target.scrollTop, left: target.scrollLeft }, before, 'Host auto-follow cannot move the locked background')
    runtime.unmount()
    assertScrollRestored(fixture)
    assert.equal(target.scrollListeners.has('scroll'), false, 'release removes the scroll listener')
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('native modal preserves fractional pre-open offsets when showModal itself clamps them', async () => {
  const fixture = makeScrollFixture()
  const before = fixture.targets.map((target, index) => {
    target.scrollTop = (index + 1) * 11 + 0.5
    target.scrollLeft = (index + 1) * 11 - 0.75
    target.style.paddingBottom = '5px'
    target.computed.paddingBottom = '5px'
    return { target, scrollTop: target.scrollTop, scrollLeft: target.scrollLeft, inline: { ...target.style } }
  })
  fixture.view.scrollX = 3.5
  fixture.view.scrollY = 4.5
  const native = {
    open: false, style: {}, showModalCalls: 0,
    showModal() {
      this.showModalCalls += 1
      this.open = true
      for (const target of fixture.targets) {
        target.scrollTop = Math.floor(target.scrollTop)
        target.scrollLeft = Math.floor(target.scrollLeft)
      }
      fixture.view.scrollX = Math.floor(fixture.view.scrollX)
      fixture.view.scrollY = Math.floor(fixture.view.scrollY)
    },
    close() { this.open = false },
  }
  const assertPreOpenPositions = () => {
    for (const { target, scrollTop, scrollLeft } of before) {
      assert.equal(target.scrollTop, scrollTop, target.name)
      assert.equal(target.scrollLeft, scrollLeft, target.name)
    }
    assert.equal(fixture.view.scrollX, 3.5)
    assert.equal(fixture.view.scrollY, 4.5)
  }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = fixture.document
  try {
    const ui = await load(runtime.react)
    assertPreOpenPositions()
    runtime.render(ui.ConfirmDialog, {
      id: 'scroll-lock-fractional-open', title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      returnFocus: fixture.origin, onConfirm() {}, onCancel() {},
    })
    assert.equal(native.showModalCalls, 1)
    assertScrollLocked(fixture)
    assertPreOpenPositions()
    runtime.unmount()
    assertPreOpenPositions()
    for (const { target, inline } of before) assert.deepEqual(target.style, inline, target.name)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('native modal preserves both background offsets when scrollbar removal changes client size', async () => {
  const fixture = makeScrollFixture()
  const target = fixture.composer
  let scrollTop = 39
  let scrollLeft = 17
  target.style.paddingBottom = '3px'
  target.computed.paddingBottom = '3px'
  const originalStyle = { ...target.style }
  const padding = name => Number.parseFloat(target.style[name] || target.computed[name] || '0') || 0
  const locked = () => target.style.overflow === 'hidden'
  const clientHeight = () => 344 - (locked() ? 0 : 5)
  const clientWidth = () => 358 - (locked() ? 0 : 5)
  const scrollHeight = () => 378 + Math.max(0, padding('paddingBottom') - 3)
  const scrollWidth = () => 469 + Math.max(0, padding('paddingRight') - 7)
  Object.defineProperties(target, {
    offsetHeight: { value: 344 },
    offsetWidth: { value: 358 },
    clientHeight: { get: clientHeight },
    clientWidth: { get: clientWidth },
    scrollHeight: { get: scrollHeight },
    scrollWidth: { get: scrollWidth },
    scrollTop: {
      get: () => Math.max(0, Math.min(scrollTop, scrollHeight() - clientHeight())),
      set: value => { scrollTop = value },
    },
    scrollLeft: {
      get: () => Math.max(0, Math.min(scrollLeft, scrollWidth() - clientWidth())),
      set: value => { scrollLeft = value },
    },
  })
  const native = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = fixture.document
  try {
    const ui = await load(runtime.react)
    assert.equal(target.scrollTop, 39)
    assert.equal(target.scrollLeft, 17)
    runtime.render(ui.ConfirmDialog, {
      id: 'scroll-lock-two-axis', title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      returnFocus: fixture.origin, onConfirm() {}, onCancel() {},
    })
    assertScrollLocked(fixture)
    assert.equal(target.clientHeight, 344)
    assert.equal(target.clientWidth, 358)
    assert.equal(target.scrollTop, 39)
    assert.equal(target.scrollLeft, 17)
    runtime.unmount()
    assert.deepEqual(target.style, originalStyle)
    assert.equal(target.scrollTop, 39)
    assert.equal(target.scrollLeft, 17)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('nested native modals release shared scroll locks only once and tolerate out-of-order repeated cleanup', async () => {
  const fixture = makeScrollFixture()
  const extra = {
    name: 'extra', parentElement: fixture.body, scrollTop: 66, scrollLeft: 5, offsetWidth: 100, clientWidth: 100,
    style: { overflow: 'scroll', overflowX: '', overflowY: 'scroll', overscrollBehavior: 'auto', overscrollBehaviorX: '', overscrollBehaviorY: '', paddingRight: '' },
    computed: { overflowY: 'scroll', paddingRight: '0px' },
  }
  const secondOrigin = { isConnected: true, parentElement: extra, focus() {} }
  const firstNative = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  const secondNative = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  const first = makeModalReact(node => node.type === 'dialog' ? firstNative : undefined)
  const second = makeModalReact(node => node.type === 'dialog' ? secondNative : undefined)
  const oldDocument = globalThis.document
  globalThis.document = fixture.document
  try {
    let activeReact = first.react
    const sharedReact = {
      useState: (...args) => activeReact.useState(...args),
      useRef: (...args) => activeReact.useRef(...args),
      useEffect: (...args) => activeReact.useEffect(...args),
      useId: (...args) => activeReact.useId(...args),
    }
    const ui = await load(sharedReact)
    const props = (id, returnFocus) => ({ id, title: id, body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel', returnFocus, onConfirm() {}, onCancel() {} })
    first.render(ui.ConfirmDialog, props('first', fixture.origin))
    activeReact = second.react
    second.render(ui.ConfirmDialog, props('second', secondOrigin))
    assertScrollLocked(fixture)
    assert.equal(extra.style.overflow, 'hidden')
    second.unmount()
    second.unmount()
    assertScrollLocked(fixture)
    assert.equal(extra.style.overflow, 'hidden')
    assert.equal(fixture.view.scrollCalls, 0)
    first.unmount()
    assertScrollRestored(fixture)
    assert.equal(extra.style.overflow, 'scroll')
    assert.equal(extra.style.overflowY, 'scroll')
    assert.equal(extra.style.overscrollBehavior, 'auto')
    assert.equal(extra.scrollTop, 66)
    assert.equal(extra.scrollLeft, 5)
    assert.equal(fixture.view.scrollCalls, 1)
  } finally {
    first.unmount()
    second.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('native opening failure leaves every background scroll position and inline style untouched', async () => {
  const fixture = makeScrollFixture()
  const native = { showModal() { throw new Error('no top layer') }, close() {} }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = fixture.document
  try {
    const ui = await load(runtime.react)
    runtime.render(ui.ConfirmDialog, {
      id: 'open-failure-lock', title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      returnFocus: fixture.origin, onConfirm() {}, onCancel() {},
    })
    assertScrollRestored(fixture)
    assert.equal(fixture.view.scrollCalls, 0)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('DecisionModalFrame closes only for real backdrop clicks and blocks Escape/backdrop while pending', async () => {
  const native = {
    open: false, showModal() { this.open = true }, close() { this.open = false },
    getBoundingClientRect: () => ({ left: 10, right: 110, top: 10, bottom: 110 }),
  }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const ui = await load(runtime.react)
  let closes = 0
  const props = { id: 'frame-close', className: 'weir-da-overlay', closeOnBackdrop: true, onRequestClose: () => { closes += 1 }, children: 'Body' }
  let tree = runtime.render(ui.DecisionModalFrame, props)
  let dialog = findAll(tree, node => node.type === 'dialog')[0]
  dialog.onClick({ target: {}, clientX: 0, clientY: 0 })
  dialog.onClick({ target: native, clientX: 50, clientY: 50 })
  assert.equal(closes, 0)
  dialog.onClick({ target: native, clientX: 0, clientY: 0 })
  dialog.onCancel({ preventDefault() {} })
  assert.equal(closes, 2)
  props.pending = true
  tree = runtime.render(ui.DecisionModalFrame, props)
  dialog = findAll(tree, node => node.type === 'dialog')[0]
  dialog.onClick({ target: native, clientX: 0, clientY: 0 })
  dialog.onCancel({ preventDefault() {} })
  assert.equal(closes, 2)
  runtime.unmount()
})

test('DecisionModalFrame contains a scaled native dialog within the offset visual viewport and cleans listeners exactly', async () => {
  const listeners = new Map([['resize', new Set()], ['scroll', new Set()]])
  const visualViewport = {
    width: 180, height: 450, scale: 2, offsetLeft: 0, offsetTop: 221,
    addEventListener(type, listener) { listeners.get(type)?.add(listener) },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    emit(type) { for (const listener of listeners.get(type) ?? []) listener() },
  }
  const native = {
    open: false,
    style: { left: '', top: '', right: '', bottom: '', margin: '', maxWidth: '', maxHeight: '', color: 'red' },
    showModal() { this.open = true },
    close() { this.open = false },
    focus() {},
    getBoundingClientRect() {
      const maxWidth = Number.parseFloat(this.style.maxWidth)
      const maxHeight = Number.parseFloat(this.style.maxHeight)
      const width = Math.min(326, Number.isFinite(maxWidth) ? maxWidth : 326)
      const height = Math.min(444, Number.isFinite(maxHeight) ? maxHeight : 444)
      const left = this.style.left === '' ? 17 : Number.parseFloat(this.style.left)
      const top = this.style.top === '' ? 228 : Number.parseFloat(this.style.top)
      return { left, top, width, height, right: left + width, bottom: top + height }
    },
  }
  const originalStyle = { ...native.style }
  const root = { style: {}, scrollTop: 0, scrollLeft: 0, offsetWidth: 360, clientWidth: 360, offsetHeight: 900, clientHeight: 900 }
  const body = { style: {}, parentElement: root, scrollTop: 0, scrollLeft: 0, offsetWidth: 360, clientWidth: 360 }
  const origin = { isConnected: true, parentElement: body, getClientRects: () => [1], focus() {} }
  const view = {
    innerWidth: 360, innerHeight: 900, visualViewport, scrollX: 0, scrollY: 0,
    getComputedStyle: element => element.computed ?? {},
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y },
  }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = {
    activeElement: origin, defaultView: view, documentElement: root, body,
    querySelectorAll: () => [],
  }
  try {
    const ui = await load(runtime.react)
    runtime.render(ui.DecisionModalFrame, {
      id: 'visual-viewport', className: 'weir-da-overlay weir-da-selector-panel',
      returnFocus: origin, children: 'Selector',
    })
    assert.deepEqual(native.getBoundingClientRect(), { left: 8, top: 229, width: 164, height: 434, right: 172, bottom: 663 })
    assert.equal(native.open, true)
    assert.equal(listeners.get('resize').size, 1)
    assert.equal(listeners.get('scroll').size, 1)

    Object.assign(visualViewport, { width: 200, height: 400, offsetLeft: 12, offsetTop: 240 })
    visualViewport.emit('scroll')
    assert.deepEqual(native.getBoundingClientRect(), { left: 20, top: 248, width: 184, height: 384, right: 204, bottom: 632 })

    Object.assign(visualViewport, { width: 360, height: 900, scale: 1, offsetLeft: 0, offsetTop: 0 })
    visualViewport.emit('resize')
    assert.deepEqual(native.getBoundingClientRect(), { left: 17, top: 228, width: 326, height: 444, right: 343, bottom: 672 })

    Object.assign(visualViewport, { width: 180, height: 450, scale: 2, offsetLeft: 0, offsetTop: 221 })
    visualViewport.emit('resize')
    runtime.unmount()
    assert.equal(listeners.get('resize').size, 0)
    assert.equal(listeners.get('scroll').size, 0)
    assert.deepEqual(native.style, originalStyle)
    visualViewport.emit('resize')
    visualViewport.emit('scroll')
    assert.deepEqual(native.style, originalStyle)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('ConfirmDialog defers confirm focus until successful and failed actions settle', async () => {
  for (const outcome of ['success', 'failure']) {
    const settlements = []
    const previous = { focused: 0, isConnected: true, disabled: false, focus() { this.focused += 1 } }
    const native = { open: false, showModal() { this.open = true }, close() { this.open = false } }
    const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
    const oldDocument = globalThis.document
    globalThis.document = { activeElement: previous }
    try {
      const ui = await load(runtime.react)
      const tree = runtime.render(ui.ConfirmDialog, {
        id: `confirm-${outcome}`, title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
        onCancel() {}, onConfirm() {
          previous.disabled = true
          return new Promise((resolve, reject) => { settlements.push(() => outcome === 'success' ? resolve() : reject(new Error('action failed'))) })
        },
      })
      const confirm = findAll(tree, node => node.type === ui.Button && node.children === 'Confirm')[0]
      const action = confirm.onClick()
      confirm.onClick()
      runtime.unmount()
      assert.equal(previous.focused, 0, `${outcome} must not restore while pending`)
      previous.disabled = false
      for (const settle of settlements) settle()
      if (outcome === 'failure') await assert.rejects(action, /action failed/)
      else await action
      assert.equal(previous.focused, 1, outcome)
    } finally {
      runtime.unmount()
      if (oldDocument === undefined) delete globalThis.document
      else globalThis.document = oldDocument
    }
  }
})

test('ConfirmDialog uses a connected enabled visible fallback after confirm or immediate cancel', async () => {
  for (const invalid of ['disabled', 'removed', 'hidden']) {
    const previous = {
      focused: 0, isConnected: invalid !== 'removed', disabled: invalid === 'disabled',
      getClientRects: () => invalid === 'hidden' ? [] : [1],
      focus() { this.focused += 1 },
    }
    const fallback = { focused: 0, isConnected: true, getClientRects: () => [1], focus() { this.focused += 1 } }
    const native = { open: false, showModal() { this.open = true }, close() { this.open = false } }
    const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
    const oldDocument = globalThis.document
    globalThis.document = { activeElement: previous }
    try {
      const ui = await load(runtime.react)
      const tree = runtime.render(ui.ConfirmDialog, {
        id: `fallback-${invalid}`, title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
        returnFocusFallback: fallback, onCancel() {}, onConfirm: () => Promise.resolve(),
      })
      await findAll(tree, node => node.type === ui.Button && node.children === 'Confirm')[0].onClick()
      runtime.unmount()
      assert.equal(previous.focused, 0, invalid)
      assert.equal(fallback.focused, 1, invalid)
    } finally {
      runtime.unmount()
      if (oldDocument === undefined) delete globalThis.document
      else globalThis.document = oldDocument
    }
  }

  const previous = { isConnected: false, focus() { throw new Error('disconnected target must not receive focus') } }
  const fallback = { focused: 0, isConnected: true, focus() { this.focused += 1 } }
  const native = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const oldDocument = globalThis.document
  globalThis.document = { activeElement: previous }
  let cancellations = 0
  try {
    const ui = await load(runtime.react)
    const tree = runtime.render(ui.ConfirmDialog, {
      id: 'cancel-fallback', title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      returnFocusFallback: fallback, onConfirm() {}, onCancel: () => { cancellations += 1 },
    })
    findAll(tree, node => node.type === 'dialog')[0].onCancel({ preventDefault() {} })
    runtime.unmount()
    assert.equal(cancellations, 1)
    assert.equal(fallback.focused, 1)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
  }
})

test('ConfirmDialog chooses fallback focus after confirmation layout removes the origin', async () => {
  const previous = { focused: 0, isConnected: true, getClientRects: () => [1], focus() { this.focused += 1 } }
  const fallback = { focused: 0, isConnected: true, getClientRects: () => [1], focus() { this.focused += 1 } }
  const native = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
  const frames = []
  const oldDocument = globalThis.document
  const oldAnimationFrame = globalThis.requestAnimationFrame
  globalThis.document = { activeElement: previous }
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
  try {
    const ui = await load(runtime.react)
    const tree = runtime.render(ui.ConfirmDialog, {
      id: 'confirm-layout-focus', title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      returnFocusFallback: fallback, onCancel() {}, onConfirm: () => Promise.resolve(),
    })
    await findAll(tree, node => node.type === ui.Button && node.children === 'Confirm')[0].onClick()
    previous.isConnected = false
    for (const frame of frames) frame()
    assert.equal(previous.focused, 0)
    assert.equal(fallback.focused, 1)
  } finally {
    runtime.unmount()
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
    if (oldAnimationFrame === undefined) delete globalThis.requestAnimationFrame
    else globalThis.requestAnimationFrame = oldAnimationFrame
  }
})

test('ConfirmDialog returns focus without scrolling the Decision page after a confirmed content shrink', async () => {
  // Real regression (task 7.3, run d1XWW0): after a confirmed publish the
  // candidate region shrinks, the origin trigger is removed and the product
  // falls back to the page navigation. A plain focus() scrolls the
  // `main.weir-da-page` scroller to the top, losing the user's reading position
  // the driver measures as clamp(811.5, 193) = 193.
  const restoreAfterConfirm = async ({ engine, targetConnected }) => {
    const page = {
      name: 'page', scrollTop: 193, scrollLeft: 0, parentElement: null,
      offsetWidth: 200, clientWidth: 200, offsetHeight: 900, clientHeight: 900,
      style: {}, computed: { overflowY: 'auto' },
      addEventListener() {}, removeEventListener() {},
    }
    const focusRecorder = name => ({
      name, focused: 0, isConnected: true, parentElement: page, getClientRects: () => [1], focusOptions: null,
      focus(options) {
        this.focused += 1
        this.focusOptions = options
        if (engine === 'ignores-prevent-scroll' || options?.preventScroll !== true) page.scrollTop = 0
      },
    })
    const previous = focusRecorder('previous')
    const fallback = focusRecorder('fallback')
    const native = { open: false, showModal() { this.open = true }, close() { this.open = false } }
    const runtime = makeModalReact(node => node.type === 'dialog' ? native : undefined)
    const frames = []
    const oldDocument = globalThis.document
    const oldAnimationFrame = globalThis.requestAnimationFrame
    const view = {
      innerWidth: 1440, innerHeight: 900, scrollX: 0, scrollY: 0,
      getComputedStyle: element => element.computed ?? {},
      scrollTo(x, y) { this.scrollX = x; this.scrollY = y },
    }
    globalThis.document = {
      activeElement: previous, defaultView: view, documentElement: null, body: null,
      querySelectorAll: selector => selector === '.weir-da-page' ? [page] : [],
    }
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length }
    try {
      const ui = await load(runtime.react)
      const tree = runtime.render(ui.ConfirmDialog, {
        id: `confirm-focus-scroll-${engine}-${targetConnected}`, title: 'Confirm', body: 'Body', confirmLabel: 'Confirm', cancelLabel: 'Cancel',
        returnFocusFallback: fallback, onCancel() {}, onConfirm: () => Promise.resolve(),
      })
      await findAll(tree, node => node.type === ui.Button && node.children === 'Confirm')[0].onClick()
      if (!targetConnected) previous.isConnected = false
      runtime.unmount()
      for (const frame of frames) frame()
      const destination = targetConnected ? previous : fallback
      assert.equal(previous.focused, targetConnected ? 1 : 0, `${engine}: the connected origin wins`)
      assert.equal(fallback.focused, targetConnected ? 0 : 1, `${engine}: the fallback only receives focus when the origin is gone`)
      assert.equal(destination.focusOptions?.preventScroll, true, `${engine}: focus return never scrolls the page`)
      assert.equal(page.scrollTop, 193, `${engine}: the Decision page keeps its clamped position`)
      assert.equal(page.scrollLeft, 0, engine)
    } finally {
      runtime.unmount()
      if (oldDocument === undefined) delete globalThis.document
      else globalThis.document = oldDocument
      if (oldAnimationFrame === undefined) delete globalThis.requestAnimationFrame
      else globalThis.requestAnimationFrame = oldAnimationFrame
    }
  }
  for (const engine of ['honors-prevent-scroll', 'ignores-prevent-scroll']) {
    for (const targetConnected of [true, false]) await restoreAfterConfirm({ engine, targetConnected })
  }
})

test('DecisionAnswers fills suggestions locally and submits one complete original-shaped batch', async () => {
  const runtime = makeReact()
  const ui = await load(runtime.react)
  const submissions = []
  const changes = []
  let release
  const questions = [
    { id: 'single', question: 'Choose one', options: [{ label: 'Alpha', description: 'First choice' }, { label: 'Beta' }] },
    { id: 'multi', question: 'Choose many', multiSelect: true, options: [{ label: 'One' }, { label: 'Two' }] },
    { id: 'free', question: 'Explain why' },
  ]
  const props = {
    questions,
    suggestions: [{ id: 'single', selected: ['Alpha'] }, { id: 'multi', selected: ['One', 'Two'] }, { id: 'free', custom: 'Because' }],
    onChange: value => changes.push(value),
    onSubmit: value => { submissions.push(value); return new Promise(resolve => { release = resolve }) },
    t: key => key,
  }
  const render = () => { runtime.begin(); return ui.DecisionAnswers(props) }
  let tree = render()
  assert.equal(findAll(tree, node => node.type === 'select').length, 0)
  assert.deepEqual(findAll(tree, node => node.type === 'legend').map(node => node.children), ['Choose one', 'Choose many'])
  const actualRadios = findAll(tree, node => node.type === 'input' && node['data-question-id'] === 'single')
  assert.equal(actualRadios.length, 2)
  assert.ok(actualRadios.every(node => node.inputType === 'radio' && node.name === 'weir-da-answer-single'))
  const checkboxes = findAll(tree, node => node.type === 'input' && node['data-question-id'] === 'multi')
  assert.equal(checkboxes.length, 2)
  assert.ok(checkboxes.every(node => node.inputType === 'checkbox'))
  const textarea = findAll(tree, node => node.type === 'textarea')[0]
  const incomplete = findAll(tree, node => node.role === 'alert' && node.children === 'decisionAnswersIncomplete')[0]
  assert.equal(textarea['aria-describedby'], incomplete.id)
  for (const questionId of ['single', 'multi']) {
    const group = findAll(tree, node => node.type === 'fieldset' && node['data-question-id'] === questionId)[0]
    assert.equal(group['aria-describedby'], incomplete.id)
  }
  assert.equal(textarea['aria-label'], 'Explain why')
  assert.ok(findAll(tree, node => node.type === 'label').some(node => JSON.stringify(node.children).includes('First choice')))
  let submit = findAll(tree, node => node.type === ui.Button && node.children === 'decisionDecide')[0]
  assert.equal(submit.disabled, true)
  assert.ok(findAll(tree, node => node.role === 'alert').some(node => node.children === 'decisionAnswersIncomplete'))

  const fill = findAll(tree, node => node.type === ui.Button && node.children === 'decisionUseSuggestions')[0]
  fill.onClick()
  assert.equal(submissions.length, 0)
  assert.deepEqual(changes.at(-1), { single: { selected: ['Alpha'] }, multi: { selected: ['One', 'Two'] }, free: { selected: [], custom: 'Because' } })
  tree = render()
  assert.equal(findAll(tree, node => node.role === 'alert' && node.children === 'decisionAnswersIncomplete').length, 0)
  assert.equal(findAll(tree, node => node.type === 'textarea')[0]['aria-describedby'], undefined)
  assert.ok(findAll(tree, node => node.type === 'fieldset').every(node => node['aria-describedby'] === undefined))
  submit = findAll(tree, node => node.type === ui.Button && node.children === 'decisionDecide')[0]
  assert.equal(submit.disabled, false)
  assert.equal(tree['aria-busy'], false)
  findAll(tree, node => node.type === 'input' && node['data-question-id'] === 'single' && node.value === 'Beta')[0].onChange({ target: { checked: true } })
  tree = render()
  findAll(tree, node => node.type === 'input' && node['data-question-id'] === 'multi' && node.value === 'Two')[0].onChange({ target: { checked: false } })
  tree = render()
  findAll(tree, node => node.type === 'textarea')[0].onChange({ target: { value: 'Edited reason' } })
  tree = render()
  const formSubmit = tree.onSubmit
  formSubmit({ preventDefault() {} })
  formSubmit({ preventDefault() {} })
  assert.equal(submissions.length, 1)
  assert.deepEqual(submissions[0], [
    { id: 'single', selected: ['Beta'] },
    { id: 'multi', selected: ['One'] },
    { id: 'free', selected: [], custom: 'Edited reason' },
  ])
  tree = render()
  assert.equal(tree['aria-busy'], true)
  assert.ok(findAll(tree, node => node.type === 'input' || node.type === 'textarea').every(node => node.disabled))
  release()
  await Promise.resolve()
  await Promise.resolve()
  tree = render()
  assert.equal(tree['aria-busy'], false)
})

test('DecisionAnswers scopes accessible ids per form instance', async () => {
  const runtime = makeReact()
  const ui = await load(runtime.react)
  const props = { questions: [{ id: 'shared', question: 'Same question' }], t: key => key }
  runtime.begin()
  const first = ui.DecisionAnswers(props)
  const second = ui.DecisionAnswers(props)
  const firstInput = findAll(first, node => node.type === 'textarea')[0]
  const secondInput = findAll(second, node => node.type === 'textarea')[0]
  assert.notEqual(firstInput.id, secondInput.id)
  const firstError = findAll(first, node => node.id?.endsWith('-incomplete'))[0]
  const secondError = findAll(second, node => node.id?.endsWith('-incomplete'))[0]
  assert.notEqual(firstError.id, secondError.id)
  assert.equal(firstInput['aria-describedby'], firstError.id)
  assert.equal(secondInput['aria-describedby'], secondError.id)
})

test('Disclosure opens lazily and notifies the owner without rendering hidden diagnostic content', async () => {
  const runtime = makeReact()
  const ui = await load(runtime.react)
  let openings = 0
  let builds = 0
  const props = { id: 'diagnostic', label: 'Advanced', onOpen: () => { openings += 1 }, children: () => { builds += 1; return { type: 'pre', children: '{"raw":true}' } } }
  runtime.begin()
  let tree = ui.Disclosure(props)
  assert.equal(builds, 0)
  findAll(tree, node => node.type === 'button')[0].onClick()
  runtime.begin()
  tree = ui.Disclosure(props)
  assert.equal(openings, 1)
  assert.equal(builds, 1)
  assert.equal(findAll(tree, node => node.type === 'pre').length, 1)
  findAll(tree, node => node.type === 'button')[0].onClick()
  runtime.begin()
  tree = ui.Disclosure(props)
  assert.equal(builds, 1)
})

function makeRaf() {
  const pending = new Map()
  let next = 0
  return {
    pending,
    request(callback) { const id = ++next; pending.set(id, callback); return id },
    cancel(id) { pending.delete(id) },
    run() { for (const [id, callback] of [...pending]) { pending.delete(id); callback() } },
  }
}

test('Disclosure reveals only the first settled success or error content once per open cycle', async () => {
  for (const settled of ['success', 'error']) {
    const raf = makeRaf()
    const calls = []
    const content = {
      isConnected: true,
      scrollIntoView(options) { calls.push(options) },
      focus() { throw new Error('reveal must not move focus') },
    }
    const runtime = makeModalReact(node => node.role === 'region' ? content : undefined)
    const oldRequest = globalThis.requestAnimationFrame
    const oldCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = raf.request
    globalThis.cancelAnimationFrame = raf.cancel
    try {
      const ui = await load(runtime.react)
      const props = {
        id: `reveal-${settled}`, label: 'Evidence', revealOnOpen: 'end', revealReady: false,
        children: () => ({ type: settled === 'error' ? 'alert' : 'p', children: settled }),
      }
      let tree = runtime.render(ui.Disclosure, props)
      findAll(tree, node => node.type === 'button')[0].onClick()
      tree = runtime.render(ui.Disclosure, props)
      assert.equal(raf.pending.size, 0, 'loading placeholder must not reveal')
      props.revealReady = true
      tree = runtime.render(ui.Disclosure, props)
      tree = runtime.render(ui.Disclosure, props)
      assert.equal(raf.pending.size, 1)
      raf.run()
      assert.deepEqual(calls, [{ block: 'end', inline: 'nearest', behavior: 'instant' }])
      props.children = () => ({ type: 'p', children: 'refreshed content' })
      runtime.render(ui.Disclosure, props)
      raf.run()
      assert.equal(calls.length, 1, 'refresh and unrelated renders must not reveal again')
      findAll(tree, node => node.type === 'button')[0].onClick()
      tree = runtime.render(ui.Disclosure, props)
      findAll(tree, node => node.type === 'button')[0].onClick()
      runtime.render(ui.Disclosure, props)
      assert.equal(raf.pending.size, 1, 'a new open cycle gets one new reveal')
      raf.run()
      assert.equal(calls.length, 2)
    } finally {
      runtime.unmount()
      if (oldRequest === undefined) delete globalThis.requestAnimationFrame
      else globalThis.requestAnimationFrame = oldRequest
      if (oldCancel === undefined) delete globalThis.cancelAnimationFrame
      else globalThis.cancelAnimationFrame = oldCancel
    }
  }
})

test('Disclosure reveal frames cancel on close and unmount while ordinary disclosures never schedule them', async () => {
  const raf = makeRaf()
  const calls = []
  const content = { scrollIntoView: options => calls.push(options), focus() { throw new Error('no focus') } }
  const runtime = makeModalReact(node => node.role === 'region' ? content : undefined)
  const oldRequest = globalThis.requestAnimationFrame
  const oldCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = raf.request
  globalThis.cancelAnimationFrame = raf.cancel
  try {
    const ui = await load(runtime.react)
    const props = { id: 'static-reveal', label: 'Details', revealOnOpen: 'end', children: 'Static content' }
    let tree = runtime.render(ui.Disclosure, props)
    findAll(tree, node => node.type === 'button')[0].onClick()
    tree = runtime.render(ui.Disclosure, props)
    assert.equal(raf.pending.size, 1, 'static content is ready by default')
    findAll(tree, node => node.type === 'button')[0].onClick()
    tree = runtime.render(ui.Disclosure, props)
    raf.run()
    assert.equal(calls.length, 0, 'close cancels the pending reveal')
    findAll(tree, node => node.type === 'button')[0].onClick()
    runtime.render(ui.Disclosure, props)
    assert.equal(raf.pending.size, 1)
    runtime.unmount()
    raf.run()
    assert.equal(calls.length, 0, 'unmount cancels the pending reveal')

    const ordinaryRuntime = makeModalReact(node => node.role === 'region' ? content : undefined)
    const ordinaryUi = await load(ordinaryRuntime.react)
    const ordinary = { id: 'ordinary', label: 'Small diagnostics', children: 'Raw value' }
    tree = ordinaryRuntime.render(ordinaryUi.Disclosure, ordinary)
    findAll(tree, node => node.type === 'button')[0].onClick()
    ordinaryRuntime.render(ordinaryUi.Disclosure, ordinary)
    assert.equal(raf.pending.size, 0)
    ordinaryRuntime.unmount()
  } finally {
    runtime.unmount()
    if (oldRequest === undefined) delete globalThis.requestAnimationFrame
    else globalThis.requestAnimationFrame = oldRequest
    if (oldCancel === undefined) delete globalThis.cancelAnimationFrame
    else globalThis.cancelAnimationFrame = oldCancel
  }
})


test('RouteDecision history is named, readable, and read-only with a truthful empty state', async () => {
  const ui = await load()
  const tree = ui.DecisionRouteHistory({ t: key => key, history: [
    { routeDecisionId: 'rd-auto', mode: 'auto', modeKey: 'decisionRouteModeAuto', statusKey: 'decisionRouteStatusNone', createdAt: '2026-01-02T03:04:05.000Z' },
    { routeDecisionId: 'rd-manual', mode: 'manual_reassign', modeKey: 'decisionRouteModeManual', statusKey: 'decisionRouteStatusSelected', fromName: 'No assistant selected', toName: 'Tone', createdAt: '2026-01-02T03:05:05.000Z' },
  ] })
  const list = findAll(tree, node => node.type === 'ol' && node['aria-label'] === 'decisionRouteHistory')[0]
  assert.ok(list)
  assert.equal(findAll(list, node => node.type === 'li').length, 2)
  const text = JSON.stringify(tree)
  for (const key of ['decisionRouteModeAuto', 'decisionRouteStatusNone', 'decisionRouteModeManual', 'decisionRoutingDirection', 'No assistant selected', 'Tone']) assert.equal(text.includes(key), true, key)
  assert.equal(findAll(tree, node => ['button', 'input', 'select', 'textarea'].includes(node.type)).length, 0)
  const empty = ui.DecisionRouteHistory({ t: key => key, history: [] })
  assert.equal(empty.role, 'status')
  assert.equal(empty.children, 'decisionNoRouteHistory')
})
