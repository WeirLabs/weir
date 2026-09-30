import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { anchorFor } from '../src/hashline-edit/anchors.js'
import { applyOps, validateOps } from '../src/hashline-edit/apply-ops.js'
import { diffResult } from '../src/hashline-edit/diff.js'
import {
  narrowDiffFragment,
  narrowHashEditArgs,
  parseHashEditArgsRaw,
  plannedDiffFragments,
} from '../src/hashline-edit/planned-fragments.js'

/**
 * Cross-side contract test for the hash_edit planned-preview contract
 * (src/hashline-edit/planned-fragments.js). Three sections:
 * 1. src module unit corpus — narrowing boundaries, projection semantics,
 *    fragment shape table.
 * 2. chunk↔src equivalence pin — the derived copy inside
 *    lib/client.hash-edit-model.js driven over the SAME corpus.
 * 3. planned↔applied reconciliation — planned fragments against the real
 *    RESULT path (applyOps + diffResult) for shared file states.
 */

// ---------------------------------------------------------------------------
// Shared corpus (drives both section 1 and the section-2 parity pin).
// ---------------------------------------------------------------------------

/** @type {Array<{ name: string, raw: unknown, expected: unknown }>} */
const PARSE_CASES = [
  { name: 'non-string number', raw: 42, expected: null },
  { name: 'null', raw: null, expected: null },
  { name: 'undefined', raw: undefined, expected: null },
  { name: 'empty string', raw: '', expected: null },
  { name: 'whitespace-only string', raw: '   ', expected: null },
  { name: 'non-JSON', raw: 'not-json', expected: null },
  { name: 'JSON null', raw: 'null', expected: null },
  { name: 'JSON number', raw: '42', expected: null },
  { name: 'JSON array', raw: '[1,2]', expected: null },
  { name: 'missing file_path', raw: '{"edits":[]}', expected: null },
  { name: 'blank file_path', raw: '{"file_path":" ","edits":[]}', expected: null },
  { name: 'non-string file_path', raw: '{"file_path":42,"edits":[]}', expected: null },
  { name: 'missing edits', raw: '{"file_path":"/ws/a.js"}', expected: null },
  { name: 'non-array edits', raw: '{"file_path":"/ws/a.js","edits":{}}', expected: null },
  { name: 'non-object edit', raw: '{"file_path":"/ws/a.js","edits":[42]}', expected: null },
  { name: 'edit missing text', raw: '{"file_path":"/ws/a.js","edits":[{"op":"replace","pos":"1#AA"}]}', expected: null },
  { name: 'edit non-string op', raw: '{"file_path":"/ws/a.js","edits":[{"op":1,"pos":"1#AA","text":"x"}]}', expected: null },
  {
    name: 'empty edits array narrows',
    raw: '{"file_path":"/ws/a.js","edits":[]}',
    expected: { path: '/ws/a.js', ops: [] },
  },
  {
    name: 'extra fields dropped',
    raw: JSON.stringify({
      file_path: '/ws/a.js',
      extra: 'top-level',
      edits: [{ op: 'replace', pos: '2#VK', text: 'BETA', extra: 'ignored' }],
    }),
    expected: { path: '/ws/a.js', ops: [{ op: 'replace', pos: '2#VK', text: 'BETA' }] },
  },
  {
    name: 'end anchor preserved',
    raw: JSON.stringify({
      file_path: '/ws/a.js',
      edits: [{ op: 'replace', pos: '2#VK', end: '4#ZZ', text: 'B' }],
    }),
    expected: { path: '/ws/a.js', ops: [{ op: 'replace', pos: '2#VK', end: '4#ZZ', text: 'B' }] },
  },
  {
    name: 'non-string end dropped',
    raw: JSON.stringify({
      file_path: '/ws/a.js',
      edits: [{ op: 'replace', pos: '2#VK', end: 42, text: 'B' }],
    }),
    expected: { path: '/ws/a.js', ops: [{ op: 'replace', pos: '2#VK', text: 'B' }] },
  },
  {
    name: 'multi-op order preserved',
    raw: JSON.stringify({
      file_path: '/ws/a.js',
      edits: [
        { op: 'replace', pos: '2#VK', text: 'BETA' },
        { op: 'append', pos: '3#XX', text: '' },
        { op: 'prepend', pos: '1#YY', text: 'TOP', extra: 'ignored' },
      ],
    }),
    expected: {
      path: '/ws/a.js',
      ops: [
        { op: 'replace', pos: '2#VK', text: 'BETA' },
        { op: 'append', pos: '3#XX', text: '' },
        { op: 'prepend', pos: '1#YY', text: 'TOP' },
      ],
    },
  },
]

/** @type {Array<{ name: string, value: unknown, expected: unknown }>} */
const NARROW_CASES = [
  { name: 'null', value: null, expected: null },
  { name: 'number', value: 42, expected: null },
  { name: 'string', value: 'x', expected: null },
  { name: 'array', value: [], expected: null },
  { name: 'edits non-array', value: { file_path: '/a', edits: 'nope' }, expected: null },
  { name: 'edit null', value: { file_path: '/a', edits: [null] }, expected: null },
  {
    name: 'valid with end',
    value: { file_path: '/a', edits: [{ op: 'replace', pos: '1#AA', end: '2#BB', text: 't' }] },
    expected: { path: '/a', ops: [{ op: 'replace', pos: '1#AA', end: '2#BB', text: 't' }] },
  },
]

/** @type {Array<{ name: string, parsed: unknown, expected: unknown }>} */
const PLANNED_CASES = [
  { name: 'null input', parsed: null, expected: null },
  { name: 'empty ops', parsed: { path: '/a', ops: [] }, expected: null },
  {
    name: 'all-empty texts',
    parsed: { path: '/a', ops: [{ op: 'replace', pos: '1#AA', text: '' }] },
    expected: null,
  },
  {
    name: 'pure deletion produces no fragment',
    parsed: {
      path: '/a',
      ops: [
        { op: 'replace', pos: '1#AA', text: '' },
        { op: 'append', pos: '2#BB', text: 'TAIL' },
      ],
    },
    expected: [{ path: '/a', oldText: null, newText: 'TAIL' }],
  },
  {
    name: 'oldText null by construction, op order kept',
    parsed: {
      path: '/a',
      ops: [
        { op: 'replace', pos: '1#AA', text: 'ONE' },
        { op: 'prepend', pos: '2#BB', text: 'TWO\nTHREE' },
      ],
    },
    expected: [
      { path: '/a', oldText: null, newText: 'ONE' },
      { path: '/a', oldText: null, newText: 'TWO\nTHREE' },
    ],
  },
]

/** @type {Array<{ name: string, value: unknown, expected: unknown }>} */
const FRAGMENT_GUARD_CASES = [
  {
    name: 'accepts a full fragment',
    value: { path: '/a', oldText: 'old', newText: 'new' },
    expected: { path: '/a', oldText: 'old', newText: 'new' },
  },
  {
    name: 'accepts null oldText and empty newText',
    value: { path: '/a', oldText: null, newText: '' },
    expected: { path: '/a', oldText: null, newText: '' },
  },
  {
    name: 'drops extra fields',
    value: { path: '/a', oldText: null, newText: 'x', extra: 1 },
    expected: { path: '/a', oldText: null, newText: 'x' },
  },
  { name: 'rejects null', value: null, expected: null },
  { name: 'rejects undefined', value: undefined, expected: null },
  { name: 'rejects number', value: 42, expected: null },
  { name: 'rejects string', value: 'str', expected: null },
  { name: 'rejects array', value: [], expected: null },
  { name: 'rejects missing path', value: { oldText: null, newText: 'x' }, expected: null },
  { name: 'rejects non-string path', value: { path: 1, oldText: null, newText: 'x' }, expected: null },
  { name: 'rejects non-string oldText', value: { path: '/a', oldText: 5, newText: 'x' }, expected: null },
  { name: 'rejects undefined oldText', value: { path: '/a', oldText: undefined, newText: 'x' }, expected: null },
  { name: 'rejects missing newText', value: { path: '/a', oldText: null }, expected: null },
]

describe('hashline-edit planned-fragments contract', () => {
  describe('section 1: src module unit corpus', () => {
    it('narrows raw argument strings at every boundary', () => {
      for (const { name, raw, expected } of PARSE_CASES) {
        expect(parseHashEditArgsRaw(raw), name).toEqual(expected)
      }
    })

    it('narrows decoded argument objects defensively', () => {
      for (const { name, value, expected } of NARROW_CASES) {
        expect(narrowHashEditArgs(value), name).toEqual(expected)
      }
    })

    it('projects op-shaped planned fragments (oldText null by construction)', () => {
      for (const { name, parsed, expected } of PLANNED_CASES) {
        expect(plannedDiffFragments(parsed), name).toEqual(expected)
      }
    })

    it('guards the shared fragment shape', () => {
      for (const { name, value, expected } of FRAGMENT_GUARD_CASES) {
        expect(narrowDiffFragment(value), name).toEqual(expected)
      }
    })
  })

  describe('section 2: chunk↔src equivalence pin', () => {
    it('derived chunk copy behaves identically over the same corpus', async () => {
      // Zero stubs: the default throwing require also pins the zero-dependency
      // factory discipline.
      const { definition, exports: chunk } = await loadClientChunk('lib/client.hash-edit-model.js')
      expect(definition.chunk).toBe('client.hash-edit-model.js')

      // The chunk keeps its pre-existing public export surface;
      // parseHashEditArgs aliases the derived parseHashEditArgsRaw.
      for (const { name, raw, expected } of PARSE_CASES) {
        expect(chunk.parseHashEditArgs(raw), `parse: ${name}`).toEqual(expected)
        expect(chunk.parseHashEditArgs(raw), `parse drift: ${name}`).toEqual(parseHashEditArgsRaw(raw))
      }
      // The object-level narrowing sits inside the derived region; on the
      // chunk it is reached through the string entry (public surface
      // unchanged), so JSON round-tripping must land on the same result.
      for (const { name, value, expected } of NARROW_CASES) {
        const viaChunk = chunk.parseHashEditArgs(JSON.stringify(value))
        expect(viaChunk, `narrow: ${name}`).toEqual(expected)
        expect(viaChunk, `narrow drift: ${name}`).toEqual(narrowHashEditArgs(value))
      }
      for (const { name, parsed, expected } of PLANNED_CASES) {
        expect(chunk.plannedDiffFragments(parsed), `planned: ${name}`).toEqual(expected)
        expect(chunk.plannedDiffFragments(parsed), `planned drift: ${name}`).toEqual(plannedDiffFragments(parsed))
      }
      for (const { name, value, expected } of FRAGMENT_GUARD_CASES) {
        expect(chunk.narrowDiffFragment(value), `fragment: ${name}`).toEqual(expected)
        expect(chunk.narrowDiffFragment(value), `fragment drift: ${name}`).toEqual(narrowDiffFragment(value))
      }
    })
  })

  describe('section 3: planned↔applied reconciliation', () => {
    const PATH = '/ws/notes.txt'
    const at = (lines, n) => anchorFor(n, lines[n - 1])

    /** @type {Array<{ name: string, before: string, ops: Array<Record<string, string>>, plannedNull?: boolean }>} */
    const RECONCILE_CASES = []
    {
      const before = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].join('\n')
      const lines = before.split('\n')
      RECONCILE_CASES.push({
        name: 'replace/append/prepend mix',
        before,
        ops: [
          { op: 'replace', pos: at(lines, 3), text: 'GAMMA2\nGAMMA3' },
          { op: 'append', pos: at(lines, 6), text: 'zeta-plus' },
          { op: 'prepend', pos: at(lines, 1), text: 'HEADER' },
        ],
      })
    }
    {
      const before = ['one', 'two', 'three', 'four', 'five'].join('\n')
      const lines = before.split('\n')
      RECONCILE_CASES.push({
        name: 'ranged pure deletion (end anchor) plus content op',
        before,
        ops: [
          { op: 'replace', pos: at(lines, 2), end: at(lines, 3), text: '' },
          { op: 'append', pos: at(lines, 5), text: 'TAIL' },
        ],
      })
    }
    {
      const before = Array.from({ length: 12 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`).join('\n')
      const lines = before.split('\n')
      RECONCILE_CASES.push({
        name: 'two nearby replaces merge into one hunk',
        before,
        ops: [
          { op: 'replace', pos: at(lines, 4), text: 'L4X' },
          { op: 'replace', pos: at(lines, 6), text: 'L6X' },
        ],
      })
    }
    {
      const before = ['第一行', '第二行', '第三行', '第四行'].join('\n')
      const lines = before.split('\n')
      RECONCILE_CASES.push({
        name: 'Chinese multi-line content',
        before,
        ops: [{ op: 'replace', pos: at(lines, 2), text: '第二行-改\n新增行' }],
      })
    }
    {
      const before = ['a', 'b', 'c', 'd'].join('\n')
      const lines = before.split('\n')
      RECONCILE_CASES.push({
        name: 'all ops pure deletions',
        before,
        ops: [{ op: 'replace', pos: at(lines, 2), end: at(lines, 3), text: '' }],
        plannedNull: true,
      })
    }

    it('planned fragments reconcile with the real RESULT path', () => {
      for (const { name, before, ops, plannedNull } of RECONCILE_CASES) {
        const lines = before.split('\n')
        // The corpus is self-checking: anchors must validate against `before`.
        expect(validateOps(ops, lines).ok, `${name}: corpus anchors validate`).toBe(true)
        // The real RESULT channel: apply, then the one-pass comparison.
        const after = applyOps(lines, ops).join('\n')
        const applied = diffResult(PATH, before, after).fragments
        // The START channel: project the same op list from raw JSON args.
        const planned = plannedDiffFragments(parseHashEditArgsRaw(JSON.stringify({ file_path: PATH, edits: ops })))
        if (plannedNull === true) {
          expect(planned, `${name}: pure deletions preview nothing`).toBe(null)
        }
        // ① One shared shape guard over both channels.
        for (const fragment of applied) {
          expect(narrowDiffFragment(fragment), `${name}: applied shape`).toEqual(fragment)
        }
        for (const fragment of planned ?? []) {
          expect(narrowDiffFragment(fragment), `${name}: planned shape`).toEqual(fragment)
        }
        // ② All fragment paths agree.
        for (const fragment of applied) expect(fragment.path, `${name}: applied path`).toBe(PATH)
        for (const fragment of planned ?? []) expect(fragment.path, `${name}: planned path`).toBe(PATH)
        // ③ Every content-bearing op's newText lands in the applied
        // fragments' new-side union (hunk new side = context + added lines).
        const union = applied.map((fragment) => fragment.newText).join('\n')
        for (const fragment of planned ?? []) {
          expect(union.includes(fragment.newText), `${name}: planned newText lands in applied new side`).toBe(true)
        }
      }
    })
  })
})
