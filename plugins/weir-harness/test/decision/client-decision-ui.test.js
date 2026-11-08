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

async function load(react = {}) {
  const jsx = (type, props) => ({ ...props, type, inputType: props?.type })
  const { exports } = await loadClientChunk('lib/client.decision-ui.js', name => name === 'react' ? react : { jsx, jsxs: jsx })
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
  const field = ui.Field({ id: 'preference', label: 'Decision preference', hint: 'Optional', children: { type: 'textarea', id: 'preference' } })
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
  assert.match(styles.children, /--dsw-alias-bg-overlay/)
  const source = readFileSync(new URL('../../lib/client.decision-ui.js', import.meta.url), 'utf8')
  assert.equal(/#[\da-f]{3,8}\b/i.test(source), false)
  assert.equal(source.includes('document.body'), false)
  assert.equal(source.includes('@deepseek-ai/'), false)
})

test('disclosure and confirmation close with Escape, trap dialog focus, and restore focus', async () => {
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

  const cancel = { focused: 0, focus() { this.focused += 1 } }
  const confirm = { focus() {} }
  let cancellations = 0
  const previous = { focused: 0, focus() { this.focused += 1 } }
  const oldDocument = globalThis.document
  globalThis.document = { activeElement: previous }
  try {
    const dialogRuntime = makeReact()
    dialogRuntime.begin()
    const dialogUi = await load(dialogRuntime.react)
    const dialog = dialogUi.ConfirmDialog({ id: 'discard', title: 'Discard draft?', body: 'This cannot be undone.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', onConfirm() {}, onCancel: () => { cancellations += 1 }, cancelRef: { current: cancel }, confirmRef: { current: confirm } })
    const surface = findAll(dialog, node => node.role === 'dialog')[0]
    assert.equal(surface['aria-modal'], true)
    assert.equal(surface['aria-labelledby'], 'discard-title')
    assert.equal(cancel.focused, 1)
    const buttons = findAll(surface, node => node.type === dialogUi.Button)
    assert.equal(buttons.filter(button => button.variant === 'primary').length, 1)
    surface.onKeyDown({ key: 'Tab', target: confirm, preventDefault() {} })
    surface.onKeyDown({ key: 'Escape', preventDefault() {} })
    assert.equal(cancellations, 1)
    dialogRuntime.unmount()
    assert.equal(previous.focused, 1)
  } finally {
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
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
})
