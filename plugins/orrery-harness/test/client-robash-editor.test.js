import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.robash-editor.js chunk test: shared helper + minimal react stub;
 * the robash model trio comes from the real zero-dependency
 * client.robash-model.js chunk via the `model` prop. Assertions migrated
 * verbatim from the pre-split client.test.js (the rows there reached the
 * component through OrreryCard's dispatch markers).
 */

describe('client.robash-editor chunk', () => {
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
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.robash-editor.js', requireStub)
    const { exports: model } = await loadClientChunk('lib/client.robash-model.js')
    return { definition, exports, model, reactStub }
  }

  it('renders collapsed, invalid, and blank rows like the pre-split component', async () => {
    const { definition, exports, model, reactStub } = await loadEditor()
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.robash-editor.js')

    const { RobashListEditorField } = exports
    const renderRow = (props) => {
      reactStub.begin()
      return RobashListEditorField(props)
    }

    // the collapsed robash row: label + hint + entry count + Edit button
    const collapsed = renderRow({ field: 'robashAllow', text: '["ls","cat"]', overridden: true, edit: () => {}, onReset: () => {}, t: (key) => key, disabled: false, model })
    expect(collapsed.children[0].children[0].children[0].children).toBe('robashAllow')
    expect(collapsed.children[0].children[0].children[1].children).toBe('robashAllowHint')
    const collapsedRight = collapsed.children[0].children[1]
    expect(collapsedRight.children[0].children[0].children).toBe('2 robashListEntries')
    expect(collapsedRight.children[0].children[1].children).toBe('chainEdit')
    // overridden → Tag + reset below the Edit button
    expect(collapsedRight.children[2].children[0].children).toBe('overridden')
    // a bad stored value shows the invalid hint instead of the entry count
    const badRow = renderRow({ field: 'robashAllow', text: 'not-json', overridden: false, edit: () => {}, onReset: () => {}, t: (key) => key, disabled: false, model })
    expect(badRow.children[0].children[1].children[1].children).toBe('robashListInvalid')

    // a blank stored value renders neither the entry count nor the invalid hint
    const blankRow = renderRow({ field: 'robashAllow', text: '', overridden: false, edit: () => {}, onReset: () => {}, t: (key) => key, disabled: false, model })
    // blank: no entry count (null first control) and no invalid hint; the Edit button is still there
    expect(blankRow.children[0].children[1].children[0].children[0]).toBe(null)
    expect(blankRow.children[0].children[1].children[0].children[1].children).toBe('chainEdit')
    expect(blankRow.children[0].children[1].children[1]).toBe(null)
  })
})
