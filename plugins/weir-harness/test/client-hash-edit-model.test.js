import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * Zero-dependency view-model chunk test: driven with the default throwing
 * require (zero stubs). Assertions migrated verbatim from the pre-split
 * client.test.js hash_edit diff view describe. The chunk's
 * parseHashEditArgs/plannedDiffFragments/narrowDiffFragment are a byte-verbatim
 * derived copy of the producer-side contract module
 * src/hashline-edit/planned-fragments.js (see the chunk's DERIVED FROM
 * marker); these assertions now pin the derived copy's behavior, and the
 * cross-side equivalence pin lives in test/hashline-planned-fragments.test.js.
 */

describe('client.hash-edit-model chunk', () => {
  it('narrows applied diff metadata defensively', async () => {
    const { definition, exports } = await loadClientChunk('lib/client.hash-edit-model.js')
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.hash-edit-model.js')
    expect(exports.HASH_EDIT_TOOL).toBe('hash_edit')

    const { appliedDiffFragments } = exports
    const fragment = { path: 'a.js', oldText: 'old', newText: 'new' }
    expect(appliedDiffFragments({ diffs: [fragment] })).toEqual([fragment])
    expect(appliedDiffFragments({ diffs: [{ path: 'a.js', oldText: null, newText: 'x' }] })).toEqual([{ path: 'a.js', oldText: null, newText: 'x' }])
    // absent / empty / malformed all decline to the generic body
    expect(appliedDiffFragments(undefined)).toBe(null)
    expect(appliedDiffFragments(null)).toBe(null)
    expect(appliedDiffFragments({})).toBe(null)
    expect(appliedDiffFragments({ diffs: [] })).toBe(null)
    expect(appliedDiffFragments({ diffs: 'nope' })).toBe(null)
    expect(appliedDiffFragments({ diffs: [{ path: 'a.js', oldText: 1, newText: 'x' }] })).toBe(null)
    expect(appliedDiffFragments({ diffs: [{ path: 'a.js', newText: 'x' }] })).toBe(null)
    expect(appliedDiffFragments({ diffs: [fragment, { bad: true }] })).toBe(null)
  })

  it('parses call arguments and derives planned fragments', async () => {
    const { exports } = await loadClientChunk('lib/client.hash-edit-model.js')
    const { parseHashEditArgs, plannedDiffFragments } = exports
    const parsed = parseHashEditArgs(JSON.stringify({
      file_path: '/ws/a.js',
      edits: [
        { op: 'replace', pos: '2#VK', text: 'BETA' },
        { op: 'append', pos: '3#XX', text: '' },
        { op: 'prepend', pos: '1#YY', text: 'TOP', extra: 'ignored' },
      ],
    }))
    expect(parsed.path).toBe('/ws/a.js')
    expect(parsed.ops).toHaveLength(3)
    // empty-text ops (pure deletions) have no planned fragment
    const planned = plannedDiffFragments(parsed)
    expect(planned).toEqual([
      { path: '/ws/a.js', oldText: null, newText: 'BETA' },
      { path: '/ws/a.js', oldText: null, newText: 'TOP' },
    ])
    // unusable argument shapes decline
    expect(parseHashEditArgs('')).toBe(null)
    expect(parseHashEditArgs('not-json')).toBe(null)
    expect(parseHashEditArgs('{"file_path":"/ws/a.js"}')).toBe(null)
    expect(parseHashEditArgs('{"file_path":" ","edits":[]}')).toBe(null)
    expect(parseHashEditArgs('{"file_path":"/ws/a.js","edits":[{"op":"replace","pos":"1#AA"}]}')).toBe(null)
    expect(parseHashEditArgs(null)).toBe(null)
    expect(plannedDiffFragments(null)).toBe(null)
    expect(plannedDiffFragments({ path: '/ws/a.js', ops: [{ op: 'replace', pos: '1#AA', text: '' }] })).toBe(null)
  })

  it('reads args from start and result blocks and derives state', async () => {
    const { exports } = await loadClientChunk('lib/client.hash-edit-model.js')
    const { hashEditArgsRaw, hashEditResultText, hashEditState, hashEditDisplayPath } = exports
    expect(hashEditArgsRaw({ argsRaw: '{"a":1}' })).toBe('{"a":1}')
    expect(hashEditArgsRaw({ call: { argsRaw: '{"b":2}' } })).toBe('{"b":2}')
    expect(hashEditArgsRaw({})).toBe(null)
    expect(hashEditResultText({ content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo')
    expect(hashEditResultText({})).toBe('')
    expect(hashEditState('preparing', undefined)).toBe('preparing')
    expect(hashEditState('start', {})).toBe('running')
    expect(hashEditState('result', { isError: false })).toBe('ok')
    expect(hashEditState('result', { isError: true })).toBe('error')
    expect(hashEditState('result', { isError: true, error: { code: 'interrupted' } })).toBe('stopped')
    expect(hashEditDisplayPath('/ws/src/a.js', '/ws', '/home/u')).toBe('src/a.js')
    expect(hashEditDisplayPath('/home/u/a.js', '/ws', '/home/u')).toBe('~/a.js')
    expect(hashEditDisplayPath('/other/a.js', '/ws', '/home/u')).toBe('/other/a.js')
  })
})
