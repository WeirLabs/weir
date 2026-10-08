// The model picker is a package-local chunk of weir-harness
// (lib/client.model-picker.js) since the standalone `weir-model-picker` package
// turned out to be undeliverable: it was private, never published, and the
// bundle patch mounted it by a bare specifier no consumer profile could
// resolve. These are the pre-move assertions of that package's client test,
// kept verbatim as behaviour pins, plus the registration contract that now
// binds the chunk to its owning package.
import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

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
        Component: class {
          constructor(props) {
            this.props = props
          }
        },
      }
    }
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
    throw new Error(`unexpected require ${name}`)
  }
}

/**
 * The model picker library (lib/client.model-picker.js) in its build-output
 * format, executed under Node with a stubbed loader and stub React/baseline
 * requires. Guards the crash that motivated the split: model-pane entries must
 * read their {id, name} shape directly (never entry.model.name). The chunk
 * requires nothing but react and react/jsx-runtime, which the stub proves by
 * throwing on anything else.
 */
describe('weir model picker client chunk', () => {
  it('registers under its owning package with its chunk name and exports the picker surface', async () => {
    const { definition, exports } = await loadClientChunk('lib/client.model-picker.js', makeRequireStub())
    // A package-local chunk registers under the package id plus its `chunk`
    // field; it is NOT a package client plugin, so it carries no inject/apply.
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.model-picker.js')
    expect(exports.inject).toBeUndefined()
    expect(exports.apply).toBeUndefined()
    expect(typeof exports.ModelPickerField).toBe('function')
    expect(typeof exports.ModelPickerBoundary).toBe('function')
  })

  it('loads and renders the trigger for every catalog state', async () => {
    const t = (key) => key
    const empty = { provider: '', model: '', reasoningEffort: '' }
    const base = { value: { provider: 'p', model: 'm', reasoningEffort: 'low' }, onChange: () => {}, getSession: () => undefined, t, disabled: false }
    // catalog ready via the stub: trigger shows "model · effort"
    const { exports: ready } = await loadClientChunk('lib/client.model-picker.js', makeRequireStub())
    const rendered = ready.ModelPickerField(base)
    expect(rendered.children[0].style.appearance).toBe('none')
    expect(rendered.children[0].children).toBe('M Name · Low')
    // catalog loading: the trigger names the state
    const { exports: loading } = await loadClientChunk('lib/client.model-picker.js', makeRequireStub({ catalog: { status: 'loading', groups: [] } }))
    expect(loading.ModelPickerField({ ...base, value: empty }).children[0].children).toBe('catalogLoading')
    // catalog failed: the failure text with nothing selected, the stored
    // selection while one exists (manual entry stays usable)
    const { exports: failed } = await loadClientChunk('lib/client.model-picker.js', makeRequireStub({ catalog: { status: 'error', groups: [] } }))
    expect(failed.ModelPickerField({ ...base, value: empty }).children[0].children).toBe('catalogFailed')
    expect(failed.ModelPickerField(base).children[0].children).toBe('p/m')
  })

  it('model-pane entries read their own name shape (regression guard)', async () => {
    const { exports: surface } = await loadClientChunk('lib/client.model-picker.js', makeRequireStub({ open: true, pane: 'model' }))
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
    expect(menu.style.maxHeight).toBe('320px')
    const [header, row] = menu.children
    expect(header.children).toBe('p')
    expect(row.children[0].children).toBe('M Name')
    expect(row.children[1]).toBeNull()
    // selection commits the full selection with the default effort
    let selected = null
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
    expect(selected).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'low' })
  })

  it('the boundary renders the caller fallback only after the picker throws', async () => {
    const { exports: surface } = await loadClientChunk('lib/client.model-picker.js', makeRequireStub())
    const boundary = new surface.ModelPickerBoundary({ fallback: 'fallback-node', children: 'picker-node' })
    expect(boundary.state.failed).toBe(false)
    expect(boundary.render()).toBe('picker-node')
    boundary.state = { failed: true }
    expect(boundary.render()).toBe('fallback-node')
  })
})
