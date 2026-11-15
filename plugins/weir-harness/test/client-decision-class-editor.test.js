import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.decision-class-editor.js chunk test: minimal react stub, no hooks are
 * needed by the chip editor (it is a pure function of `text`). Pins the
 * A/B/C chip contract: each chip toggles the field immediately, the stored
 * value is exactly the JSON array of the pressed classes in row order, an
 * empty selection writes [], and a malformed stored value opens with every
 * chip off plus the invalid marker (the next save replaces it).
 */

describe('client.decision-class-editor chunk', () => {
  async function loadEditor() {
    const requireStub = (name) => {
      if (name === 'react') return { useState: (initial) => [initial, () => {}], useEffect: () => {}, useRef: (initial) => ({ current: initial }) }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Tag: (props) => ({ __tag: props }) }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.decision-class-editor.js', requireStub)
    return { definition, exports }
  }

  const FIELD = 'decisionAgentAutoAnswerClasses'

  function makeProps(overrides = {}) {
    return {
      field: FIELD,
      rows: ['A', 'B', 'C'],
      text: '',
      overridden: false,
      edit: () => {},
      onReset: () => {},
      t: (key, vars) => vars === undefined ? key : `${key}:${JSON.stringify(vars)}`,
      disabled: false,
      ...overrides,
    }
  }

  /** The three chip nodes, in row order. */
  function chips(tree) {
    const set = findAll(tree, (node) => node['data-decision-class-set'] === FIELD)[0]
    expect(set).toBeTruthy()
    return findAll(set, (node) => typeof node['data-decision-class'] === 'string')
  }
  function findAll(node, predicate, found = []) {
    if (!node || typeof node !== 'object') return found
    if (predicate(node)) found.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found)
      else if (value && typeof value === 'object') findAll(value, predicate, found)
    }
    return found
  }
  const countNode = (tree) => findAll(tree, (node) => node['data-decision-class-count'] !== undefined)[0]

  it('renders the closed A/B/C chip set with aria-pressed per class', async () => {
    const { definition, exports } = await loadEditor()
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.decision-class-editor.js')
    expect(Object.keys(exports.dictionaries.en).sort()).toEqual(Object.keys(exports.dictionaries.zh).sort())
    // blank (never saved): nothing is allowed, every chip is off
    const blank = exports.ClassSetEditorField(makeProps({ text: '' }))
    expect(chips(blank).map((chip) => chip['data-decision-class'])).toEqual(['A', 'B', 'C'])
    expect(chips(blank).map((chip) => chip['aria-pressed'])).toEqual([false, false, false])
    expect(chips(blank).every((chip) => chip.type === 'button')).toBe(true)
    // the row label and hint come from the settings-page dictionary of the field
    expect(findAll(blank, (node) => node.children === FIELD)).toHaveLength(1)
    expect(findAll(blank, (node) => node.children === `${FIELD}Hint`)).toHaveLength(1)
    // a stored selection opens pressed, in the stored set
    const stored = exports.ClassSetEditorField(makeProps({ text: '["C","A"]' }))
    expect(chips(stored).map((chip) => chip['data-decision-class'])).toEqual(['A', 'B', 'C'])
    expect(chips(stored).map((chip) => chip['aria-pressed'])).toEqual([true, false, true])
    expect(countNode(stored)['data-decision-class-count']).toBe(2)
  })

  it('synthesizes the stored JSON on every toggle, in A/B/C order and without duplicates', async () => {
    const { exports } = await loadEditor()
    const edits = []
    const edit = (field, text) => edits.push([field, text])
    const press = (text, row) => {
      const tree = exports.ClassSetEditorField(makeProps({ text, edit }))
      findAll(tree, (node) => node['data-decision-class'] === row)[0].onClick()
    }
    // blank → press B: only B is written, serialized as a JSON array
    press('', 'B')
    expect(edits[0]).toEqual([FIELD, '["B"]'])
    // stored B → press A: A comes first (row order), then B — regardless of press order
    press('["B"]', 'A')
    expect(edits[1]).toEqual([FIELD, '["A","B"]'])
    // releasing B keeps A
    press('["A","B"]', 'B')
    expect(edits[2]).toEqual([FIELD, '["A"]'])
    // adding the last class keeps the canonical order
    press('["A","B"]', 'C')
    expect(edits[3]).toEqual([FIELD, '["A","B","C"]'])
    // a stored duplicate opens deduplicated (one press, one count)
    expect(chips(exports.ClassSetEditorField(makeProps({ text: '["A","A"]' })))[0]['aria-pressed']).toBe(true)
    expect(countNode(exports.ClassSetEditorField(makeProps({ text: '["A","A"]' })))['data-decision-class-count']).toBe(1)
  })

  it('writes the empty array when the last class is released', async () => {
    const { exports } = await loadEditor()
    const edits = []
    const tree = exports.ClassSetEditorField(makeProps({ text: '["A"]', edit: (field, text) => edits.push([field, text]) }))
    findAll(tree, (node) => node['data-decision-class'] === 'A')[0].onClick()
    expect(edits).toEqual([[FIELD, '[]']])
    // the empty selection says so explicitly instead of showing an empty list
    expect(countNode(exports.ClassSetEditorField(makeProps({ text: '[]' }))).children).toBe('decisionClassNone')
  })

  it('opens with every chip off plus the invalid marker for a malformed stored value', async () => {
    const { exports } = await loadEditor()
    for (const text of ['not json', '{"A":true}', '["A","D"]', '[1,2]', '"A"']) {
      const tree = exports.ClassSetEditorField(makeProps({ text }))
      expect(chips(tree).map((chip) => chip['aria-pressed']), text).toEqual([false, false, false])
      expect(findAll(tree, (node) => node['data-decision-class-invalid'] === true), text).toHaveLength(1)
      expect(countNode(tree).children, text).toBe('decisionClassNone')
    }
    // valid values carry no marker
    for (const text of ['', '[]', '["A","C"]']) {
      expect(findAll(exports.ClassSetEditorField(makeProps({ text })), (node) => node['data-decision-class-invalid'] === true), text).toHaveLength(0)
    }
  })

  it('keeps every chip inert while disabled and renders the override tag with its reset action', async () => {
    const { exports } = await loadEditor()
    const resets = []
    const disabled = exports.ClassSetEditorField(makeProps({ text: '["A"]', disabled: true }))
    expect(chips(disabled).every((chip) => chip.disabled === true)).toBe(true)
    const overridden = exports.ClassSetEditorField(makeProps({ text: '["A"]', overridden: true, onReset: () => resets.push('reset') }))
    const reset = findAll(overridden, (node) => node.children === 'reset')[0]
    expect(reset).toBeTruthy()
    expect(findAll(overridden, (node) => node.tone === 'accent' && node.children === 'overridden')).toHaveLength(1)
    reset.onClick()
    expect(resets).toEqual(['reset'])
    expect(findAll(exports.ClassSetEditorField(makeProps({ text: '["A"]' })), (node) => node.children === 'reset')).toHaveLength(0)
  })
})
