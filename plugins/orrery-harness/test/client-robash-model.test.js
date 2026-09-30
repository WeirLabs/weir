import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * Zero-dependency view-model chunk test: driven with the default throwing
 * require (zero stubs). Assertions migrated verbatim from the pre-split
 * client.test.js.
 */

describe('client.robash-model chunk', () => {
  it('round-trips string lists through JSON and degrades invalid values to null', async () => {
    const { definition, exports } = await loadClientChunk('lib/client.robash-model.js')
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.robash-model.js')

    // pure robash list helpers: round-trip, invalid → null, empty ↔ "[]"
    const { jsonToStringList, stringListToJson } = exports
    expect(jsonToStringList('["ls","cat"]')).toEqual(['ls', 'cat'])
    expect(jsonToStringList('[]')).toEqual([])
    expect(stringListToJson([])).toBe('[]')
    expect(jsonToStringList(stringListToJson(['ls', 'cat']))).toEqual(['ls', 'cat'])
    expect(stringListToJson([' ls ', '', '  ', 'cat'])).toBe('["ls","cat"]')
    expect(jsonToStringList('not-json')).toBe(null)
    expect(jsonToStringList('{"a":1}')).toBe(null)
    expect(jsonToStringList('[1,"ls"]')).toBe(null)
    expect(jsonToStringList('')).toBe(null)
  })

  it('decides the editor open state: blank opens empty without hint, malformed with hint', async () => {
    const { exports } = await loadClientChunk('lib/client.robash-model.js')
    // open-state decisions (robash-list-editor-recovery): blank opens empty
    // WITHOUT the hint; malformed opens empty WITH the hint; valid opens the
    // parsed list. No stored state may strand the field uneditable.
    const { robashEditorOpenState } = exports
    expect(robashEditorOpenState('')).toEqual({ list: [], invalid: false, parsed: null })
    expect(robashEditorOpenState('   ')).toEqual({ list: [], invalid: false, parsed: null })
    expect(robashEditorOpenState('not-json')).toEqual({ list: [], invalid: true, parsed: null })
    expect(robashEditorOpenState('[1,"ls"]')).toEqual({ list: [], invalid: true, parsed: null })
    expect(robashEditorOpenState('["ls","cat"]')).toEqual({ list: ['ls', 'cat'], invalid: false, parsed: ['ls', 'cat'] })
  })
})
