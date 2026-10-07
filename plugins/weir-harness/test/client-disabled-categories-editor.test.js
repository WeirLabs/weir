import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.disabled-categories-editor.js chunk test: shared helper + minimal
 * react stub. The category rows arrive as a prop (the settings-page chunk's
 * parity-pinned CATEGORY_NAMES). Pins the toggle → JSON contract: the stored
 * value is exactly the JSON array of the switched-on names in row order,
 * clearing every switch writes [], and unknown stored names never come back.
 */

describe('client.disabled-categories-editor chunk', () => {
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
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Tag: (props) => ({ __tag: props }), Switch: (props) => ({ __switch: props }) }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.disabled-categories-editor.js', requireStub)
    return { definition, exports, reactStub }
  }

  const ROWS = ['quick', 'deep', 'deep-plus', 'visual', 'writing', 'general-low', 'general-high', 'artistry', 'architect']

  const makeProps = (overrides) => ({
    field: 'delegateDisabledCategories',
    rows: ROWS,
    text: '',
    overridden: false,
    edit: () => {},
    onReset: () => {},
    t: (key) => key,
    disabled: false,
    ...overrides,
  })

  // Drive the collapsed row's Edit button, then return the open panel.
  const openPanel = ({ exports, reactStub }, props) => {
    reactStub.reset()
    reactStub.begin()
    const closed = exports.DisabledCategoriesEditorField(props)
    closed.children[0].children[1].children[0].children[1].onClick() // Edit
    reactStub.begin()
    return exports.DisabledCategoriesEditorField(props).children[1]
  }

  const panelLanes = (panel) => panel.children.filter((child) => child?.key && child.children)
  const clickSave = (panel) => panel.children[panel.children.length - 1].children[1].onClick()

  it('renders the collapsed row with the selection count, the invalid hint, and the override reset', async () => {
    const { definition, exports, reactStub } = await loadEditor()
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.disabled-categories-editor.js')

    const { DisabledCategoriesEditorField } = exports
    const renderRow = (props) => {
      reactStub.begin()
      return DisabledCategoriesEditorField(props)
    }

    // the collapsed row: label + hint + selected count + Edit button
    const collapsed = renderRow(makeProps({ text: '["artistry","deep"]', overridden: true }))
    expect(collapsed.children[0].children[0].children[0].children).toBe('delegateDisabledCategories')
    expect(collapsed.children[0].children[0].children[1].children).toBe('delegateDisabledCategoriesHint')
    const collapsedRight = collapsed.children[0].children[1]
    expect(collapsedRight.children[0].children[0].children).toBe('2 disabledCategoriesCount')
    expect(collapsedRight.children[0].children[1].children).toBe('chainEdit')
    // overridden → Tag + reset below the Edit button
    expect(collapsedRight.children[2].children[0].children).toBe('overridden')
    expect(typeof collapsedRight.children[2].children[1].onClick).toBe('function')
    expect(collapsed.children[1]).toBe(null) // panel closed

    // a bad stored value shows the invalid hint instead of the count
    const badRow = renderRow(makeProps({ text: 'not-json' }))
    expect(badRow.children[0].children[1].children[1].children).toBe('disabledCategoriesInvalid')
    expect(badRow.children[0].children[1].children[0].children[0]).toBe(null)

    // a blank stored value renders neither the count nor the invalid hint
    const blankRow = renderRow(makeProps({ text: '' }))
    expect(blankRow.children[0].children[1].children[0].children[0]).toBe(null)
    expect(blankRow.children[0].children[1].children[0].children[1].children).toBe('chainEdit')
    expect(blankRow.children[0].children[1].children[1]).toBe(null)

    // an explicit empty array is a configured zero: the count shows 0
    const emptyRow = renderRow(makeProps({ text: '[]' }))
    expect(emptyRow.children[0].children[1].children[0].children[0].children).toBe('0 disabledCategoriesCount')
  })

  it('opens with the stored selection: a stored ["artistry"] switches exactly that row on', async () => {
    const editor = await loadEditor()
    const panel = openPanel(editor, makeProps({ text: '["artistry"]' }))
    expect(panel.children[0].children).toBe('disabledCategoriesPanelHint')
    const lanes = panelLanes(panel)
    // one switch row per prop-provided category row
    expect(lanes.map((lane) => lane.key)).toEqual(ROWS)
    for (const lane of lanes) {
      expect(lane.children[1].checked).toBe(lane.key === 'artistry')
    }
    // the row labels reuse the chainCategory_ dictionary stems
    const artistry = lanes[ROWS.indexOf('artistry')]
    expect(artistry.children[0].children[0].children).toBe('chainCategory_artistry')
    expect(artistry.children[0].children[2].children).toBe('chainCategory_artistry_desc')
    expect(artistry.children[1].label).toBe('chainCategory_artistry')
  })

  it('synthesizes the JSON of the switched-on names in row order on save', async () => {
    const editor = await loadEditor()
    const edited = []
    const props = makeProps({ text: '["artistry"]', edit: (field, text) => edited.push({ field, text }) })
    const panel = openPanel(editor, props)
    // toggle deep ON after artistry was already on — the save still comes out
    // in row order, not toggle order
    panelLanes(panel)[ROWS.indexOf('deep')].children[1].onChange(true)
    editor.reactStub.begin()
    const updated = editor.exports.DisabledCategoriesEditorField(props).children[1]
    clickSave(updated)
    expect(edited).toHaveLength(1)
    expect(edited[0].field).toBe('delegateDisabledCategories')
    expect(edited[0].text).toBe('["deep","artistry"]')
  })

  it('writes [] when every switch is cleared (the server reads [] as not configured)', async () => {
    const editor = await loadEditor()
    const edited = []
    const props = makeProps({ text: '["artistry"]', edit: (field, text) => edited.push({ field, text }) })
    const panel = openPanel(editor, props)
    panelLanes(panel)[ROWS.indexOf('artistry')].children[1].onChange(false)
    editor.reactStub.begin()
    const updated = editor.exports.DisabledCategoriesEditorField(props).children[1]
    clickSave(updated)
    expect(edited).toEqual([{ field: 'delegateDisabledCategories', text: '[]' }])
  })

  it('opens an empty stored value with every switch off; toggling one produces exactly ["artistry"]', async () => {
    const editor = await loadEditor()
    const edited = []
    const props = makeProps({ text: '', edit: (field, text) => edited.push({ field, text }) })
    const panel = openPanel(editor, props)
    const lanes = panelLanes(panel)
    for (const lane of lanes) {
      expect(lane.children[1].checked).toBe(false)
    }
    lanes[ROWS.indexOf('artistry')].children[1].onChange(true)
    editor.reactStub.begin()
    const updated = editor.exports.DisabledCategoriesEditorField(props).children[1]
    clickSave(updated)
    expect(edited).toEqual([{ field: 'delegateDisabledCategories', text: '["artistry"]' }])
  })

  it('drops unknown stored names from the selection and never writes them back', async () => {
    const editor = await loadEditor()
    const edited = []
    const props = makeProps({ text: '["artistry","bogus"]', edit: (field, text) => edited.push({ field, text }) })
    // the collapsed count covers only the reachable (known) selection
    editor.reactStub.begin()
    const collapsed = editor.exports.DisabledCategoriesEditorField(props)
    expect(collapsed.children[0].children[1].children[0].children[0].children).toBe('1 disabledCategoriesCount')

    const panel = openPanel(editor, props)
    const lanes = panelLanes(panel)
    for (const lane of lanes) {
      expect(lane.children[1].checked).toBe(lane.key === 'artistry')
    }
    clickSave(panel)
    expect(edited).toEqual([{ field: 'delegateDisabledCategories', text: '["artistry"]' }])
  })

  it('opens a malformed stored value with every switch off; saving replaces it with []', async () => {
    const editor = await loadEditor()
    const edited = []
    const props = makeProps({ text: 'not-json', edit: (field, text) => edited.push({ field, text }) })
    const panel = openPanel(editor, props)
    const lanes = panelLanes(panel)
    for (const lane of lanes) {
      expect(lane.children[1].checked).toBe(false)
    }
    clickSave(panel)
    expect(edited).toEqual([{ field: 'delegateDisabledCategories', text: '[]' }])
  })
})
