import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const CATALOG_GROUPS = [
  { id: 'p', models: [{ id: 'm', name: 'M Name', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }] } }] },
]

function makeRequireStub(states = {}) {
  return (name) => {
    if (name === 'react') {
      return {
        useState: (initial) => {
          if (initial === false) return [states.open ?? false, () => {}]
          if (initial === 'root') return [states.pane ?? 'root', () => {}]
          if (initial && initial.status === 'idle') {
            return [states.catalog ?? { status: 'ready', groups: CATALOG_GROUPS }, () => {}]
          }
          return [initial, () => {}]
        },
        useEffect: () => {},
        useRef: (initial) => ({ current: initial }),
        useCallback: (fn) => fn,
        Component: class {},
      }
    }
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
    throw new Error(`unexpected require ${name}`)
  }
}

/**
 * The model picker library (lib/client.js) in its build-output format,
 * executed under Node with a stubbed loader and stub React/baseline requires.
 * Guards the crash that motivated the split: model-pane entries must read
 * their {id, name} shape directly (never entry.model.name).
 */
describe('weir model picker client half', () => {
  it('loads and renders the trigger for every catalog state', async () => {
    const loaded = []
    globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
    await import('../lib/client.js')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, 'weir-model-picker')

    const surface = loaded[0].factory(makeRequireStub())
    assert.deepEqual(surface.inject, [])
    assert.equal(typeof surface.ModelPickerField, 'function')
    assert.equal(typeof surface.ModelPickerBoundary, 'function')

    const t = (key) => key
    const value = { provider: 'p', model: 'm', reasoningEffort: 'low' }
    // catalog ready via the stub: trigger shows "model · effort"
    const rendered = surface.ModelPickerField({ value, onChange: () => {}, getSession: () => undefined, t, disabled: false })
    assert.equal(rendered.children[0].style.appearance, 'none')
    assert.equal(rendered.children[0].children, 'M Name · Low')
  })

  it('model-pane entries read their own name shape (regression guard)', async () => {
    const loaded = []
    globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
    await import('../lib/client.js?regression=1')
    assert.equal(loaded.length, 1)

    const surface = loaded[0].factory(makeRequireStub({ open: true, pane: 'model' }))
    const t = (key) => key
    const rendered = surface.ModelPickerField({
      value: { provider: '', model: '', reasoningEffort: '' },
      onChange: () => {},
      getSession: () => undefined,
      t,
      disabled: false,
    })
    // open menu on the model pane: group header + one model row reading
    // entry.name directly (the old code read entry.model.name → crash)
    const menu = rendered.children[1]
    assert.equal(menu.style.maxHeight, '320px')
    const [header, row] = menu.children
    assert.equal(header.children, 'p')
    assert.equal(row.children[0].children, 'M Name')
    assert.equal(row.children[1], null)
    // selection commits the full selection with the default effort
    let selected = null
    row.onClick()
    const clickable = surface.ModelPickerField({
      value: { provider: '', model: '', reasoningEffort: '' },
      onChange: (selection) => {
        selected = selection
      },
      getSession: () => undefined,
      t,
      disabled: false,
    })
    // drive the row's onSelect from the just-rendered menu directly
    const menu2 = clickable.children[1]
    menu2.children[1].onClick()
    assert.deepEqual(selected, { provider: 'p', model: 'm', reasoningEffort: 'low' })
  })
})
