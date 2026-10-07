import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.chain-editor.js chunk test: shared helper + hook-state-preserving
 * react stub; the chain model trio comes from the real zero-dependency
 * client.chain-model.js chunk via the `model` prop. Covers the component
 * surface the pre-split suite pinned structurally through WeirCard.
 */

describe('client.chain-editor chunk', () => {
  async function loadEditor() {
    const reactState = []
    let hookCursor = 0
    const reactStub = {
      reset() {
        reactState.length = 0
      },
      begin() {
        hookCursor = 0
      },
      useState(initial) {
        const at = hookCursor++
        if (!(at in reactState)) reactState[at] = [initial, (next) => {
          reactState[at][0] = typeof next === 'function' ? next(reactState[at][0]) : next
        }]
        return reactState[at]
      },
      useEffect(fn) {
        const at = hookCursor++
        if (!(at in reactState)) reactState[at] = { cleanup: fn() }
        return undefined
      },
      useRef: (initial) => ({ current: initial }),
      Component: class {
        constructor(props) {
          this.props = props
        }
      },
    }
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Tag: (props) => ({ __tag: props }) }
      if (name === 'weir-model-picker') return { ModelPickerField: (props) => ({ __picker: props }), ModelPickerBoundary: class { render() { return null } } }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.chain-editor.js', requireStub)
    const { exports: model } = await loadClientChunk('lib/client.chain-model.js')
    return { definition, exports, model, reactStub }
  }

  it('renders the collapsed row and the override reset', async () => {
    const { definition, exports, model, reactStub } = await loadEditor()
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.chain-editor.js')

    const { ChainEditorField } = exports
    reactStub.begin()
    const collapsed = ChainEditorField({ text: '', overridden: false, edit: () => {}, onReset: () => {}, getSession: () => {}, t: (key) => key, disabled: false, model })
    // collapsed row: label + hint + Edit button, no override controls
    expect(collapsed.children[0].children[0].children[0].children).toBe('delegateCategoryChains')
    expect(collapsed.children[0].children[0].children[1].children).toBe('delegateCategoryChainsHint')
    expect(collapsed.children[0].children[1].children[0].children).toBe('chainEdit')
    expect(collapsed.children[0].children[1].children[1]).toBe(null)
    expect(collapsed.children[1]).toBe(null) // panel closed

    reactStub.begin()
    const overridden = ChainEditorField({ text: '', overridden: true, edit: () => {}, onReset: () => {}, getSession: () => {}, t: (key) => key, disabled: false, model })
    // overridden → Tag + reset below the Edit button
    expect(overridden.children[0].children[1].children[1].children[0].children).toBe('overridden')
    expect(typeof overridden.children[0].children[1].children[1].children[1].onClick).toBe('function')
  })

  it('opens the nine category lanes and synthesizes the stored JSON on save', async () => {
    const { exports, model, reactStub } = await loadEditor()
    const { ChainEditorField } = exports
    const edited = []
    const props = { text: '{"deep":[{"provider":"p","model":"m","reasoningEffort":"max"}]}', overridden: false, edit: (field, text) => edited.push({ field, text }), onReset: () => {}, getSession: () => ({}), t: (key) => key, disabled: false, model }

    reactStub.reset()
    reactStub.begin()
    const closed = ChainEditorField(props)
    closed.children[0].children[1].children[0].onClick() // Edit
    reactStub.begin()
    const open = ChainEditorField(props)
    const panel = open.children[1]
    expect(panel).toBeTruthy()
    // one lane per chain category from the model chunk
    const lanes = panel.children.filter((child) => child?.key && child.children)
    expect(lanes.map((lane) => lane.key)).toEqual(model.CHAIN_CATEGORIES)
    // the deep lane carries the stored rung, bound to the model picker
    const deepLane = lanes[model.CHAIN_CATEGORIES.indexOf('deep')]
    const rungRow = deepLane.children[1]
    expect(rungRow.children[0].value).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'max' })
    expect(typeof rungRow.children[0].getSession).toBe('function')

    // save → edit('delegateCategoryChains', synthesized JSON)
    const buttons = panel.children[panel.children.length - 1]
    buttons.children[1].onClick()
    expect(edited).toHaveLength(1)
    expect(edited[0].field).toBe('delegateCategoryChains')
    expect(JSON.parse(edited[0].text)).toEqual({ deep: [{ provider: 'p', model: 'm', reasoningEffort: 'max' }] })
  })

  it('serializes the category lanes byte-identically to the model chunk (derived-copy parity pin)', async () => {
    const { exports, model, reactStub } = await loadEditor()
    const { ChainEditorField } = exports
    // The editor chunk carries a row-parameterized DERIVED copy of the model's
    // chainsToJson (the model chunk is frozen). For the default category rows
    // the save output MUST equal the model original over the whole corpus.
    const corpus = [
      '',
      'not json',
      '{"deep":[{"provider":"p","model":"m","reasoningEffort":"max"}]}',
      '{"deep":[{"provider":"","model":"m"}],"quick":[{"provider":"p","model":""}]}',
      '{"quick":[{"provider":"p","model":"m","reasoningEffort":""}],"visual":[{"provider":"v","model":"m2"}],"unknown":[{"provider":"u","model":"m3"}]}',
      '{"deep":"not-an-array","artistry":[{"provider":"a","model":"m","reasoningEffort":"low"}]}',
    ]
    for (const raw of corpus) {
      const edited = []
      const props = { text: raw, overridden: false, edit: (field, text) => edited.push({ field, text }), onReset: () => {}, getSession: () => ({}), t: (key) => key, disabled: false, model }
      reactStub.reset()
      reactStub.begin()
      ChainEditorField(props).children[0].children[1].children[0].onClick() // Edit
      reactStub.begin()
      const open = ChainEditorField(props)
      const panel = open.children[1]
      panel.children[panel.children.length - 1].children[1].onClick() // Save
      expect(edited).toHaveLength(1)
      expect(edited[0].field).toBe('delegateCategoryChains')
      expect(edited[0].text).toBe(model.chainsToJson(model.jsonToChains(raw)))
    }
  })

  it('serves curated-agent lanes via props: agent dictionary stems and a field-targeted save', async () => {
    const { exports, model, reactStub } = await loadEditor()
    const { ChainEditorField } = exports
    const AGENTS = ['finder', 'scholar', 'advisor']
    const edited = []
    const props = {
      field: 'delegateAgentChains',
      rows: AGENTS,
      rowLabelPrefix: 'chainAgent_',
      panelHintKey: 'chainAgentPanelHint',
      text: '{"finder":[{"provider":"p","model":"m"}],"deep":[{"provider":"x","model":"y"}],"ghost":[{"provider":"z","model":"w"}]}',
      overridden: false,
      edit: (field, text) => edited.push({ field, text }),
      onReset: () => {},
      getSession: () => ({}),
      t: (key) => key,
      disabled: false,
      model,
    }

    reactStub.reset()
    reactStub.begin()
    const closed = ChainEditorField(props)
    // collapsed row reads the agent dictionary keys, not the category ones
    expect(closed.children[0].children[0].children[0].children).toBe('delegateAgentChains')
    expect(closed.children[0].children[0].children[1].children).toBe('delegateAgentChainsHint')
    closed.children[0].children[1].children[0].onClick() // Edit
    reactStub.begin()
    const open = ChainEditorField(props)
    const panel = open.children[1]
    // the panel hint comes from the agent stem; one lane per agent row
    expect(panel.children[0].children).toBe('chainAgentPanelHint')
    const lanes = panel.children.filter((child) => child?.key && child.children)
    expect(lanes.map((lane) => lane.key)).toEqual(AGENTS)
    expect(lanes[0].children[0].children[0].children).toBe('chainAgent_finder')
    expect(lanes[0].children[0].children[2].children).toBe('chainAgent_finder_desc')
    // the stored finder rung is staged (normalized); category/unknown JSON
    // keys never surface as lanes
    expect(lanes[0].children[1].children[0].value).toEqual({ provider: 'p', model: 'm', reasoningEffort: '' })

    // save → edit('delegateAgentChains', JSON carrying agent lanes only)
    const buttons = panel.children[panel.children.length - 1]
    buttons.children[1].onClick()
    expect(edited).toHaveLength(1)
    expect(edited[0].field).toBe('delegateAgentChains')
    expect(JSON.parse(edited[0].text)).toEqual({ finder: [{ provider: 'p', model: 'm' }] })
  })
})
