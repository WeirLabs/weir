import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import {
  ENTRY_TYPES,
  createBlackboardKernel,
  validateEntryType,
  validateKey,
  validateSummary,
} from '../src/blackboard/kernel.js'

/**
 * Blackboard write-gate parity pin (chunk ↔ kernel).
 *
 * lib/client.blackboard-model.js carries a DERIVED copy of the kernel's write
 * gate (src/blackboard/kernel.js): same-package sync require is impossible in
 * the ModuleLoader, so the browser side keeps a copy that exists ONLY to keep
 * obviously bad writes off the wire — the kernel stays authoritative.
 * Authority direction: kernel authoritative, chunk derived (header notes in
 * the chunk name this file, per the DERIVED FROM tradition of
 * lib/client.hash-edit-model.js).
 *
 * The pin is DECISION equivalence, not textual equivalence: for one shared
 * corpus, a draft the chunk's editorErrorsOf judges invalid MUST throw
 * kernel-side, and one it judges valid MUST be accepted. The kernel is
 * driven with the value the panel would actually put on the wire (the chunk's
 * own editorWritePayload: key/summary cross trimmed), so the legitimate
 * trim-semantics difference between the two sides is part of the contract,
 * not a false red. Precedent: test/hashline-planned-fragments.test.js
 * (chunk↔src same-corpus pin), test/client-settings-page.test.js:3-5 (chunk
 * test importing src-side exports).
 */

const VALID = { key: 'alpha-map', entryType: 'map', summary: 'one line', content: 'body' }

/** A draft with the probed field swapped onto an otherwise valid draft. */
const draftWith = (field, value) => ({ ...VALID, [field]: value })

describe('client.blackboard-model write-gate parity (chunk derived from kernel)', () => {
  it('pins the derived constants to the kernel side', async () => {
    const { exports: chunk } = await loadClientChunk('lib/client.blackboard-model.js')
    // The closed enum is exported by both sides: exact same list, same order.
    expect([...chunk.ENTRY_TYPES]).toEqual([...ENTRY_TYPES])
    // The summary cap is private kernel-side; bridge it behaviorally: the
    // chunk's constant must sit exactly on the kernel's accept/throw boundary.
    expect(typeof chunk.SUMMARY_MAX_LENGTH).toBe('number')
    validateSummary('x'.repeat(chunk.SUMMARY_MAX_LENGTH)) // must not throw
    expect(() => validateSummary('x'.repeat(chunk.SUMMARY_MAX_LENGTH + 1)), 'kernel boundary at the chunk cap').toThrow(new RegExp(`at most ${chunk.SUMMARY_MAX_LENGTH} characters`))
    // The key rule claims to be a VERBATIM copy: pin the regex text so any
    // one-sided edit reddens here even where the corpus below would not
    // distinguish it (the corpus still pins decisions over the full printable
    // ASCII alphabet in the sweeps).
    expect(chunk.KEY_PATTERN.source).toBe('^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$')
  })

  it('editorWritePayload puts the trimmed key/summary on the wire', async () => {
    const { exports: chunk } = await loadClientChunk('lib/client.blackboard-model.js')
    expect(chunk.editorWritePayload({ key: '  alpha-map  ', entryType: 'map', summary: '  one line  ', content: '  body  ' })).toEqual({
      key: 'alpha-map',
      entryType: 'map',
      summary: 'one line',
      content: '  body  ',
    })
  })

  // ---- shared corpus ----
  // reason: the chunk-side error kind expected for illegal drafts ('required'
  // | 'invalid'); undefined means BOTH sides must accept the wire value.

  /** @type {Array<{ name: string, value: unknown, reason?: string }>} */
  const KEY_CASES = [
    { name: 'empty', value: '', reason: 'required' },
    { name: 'whitespace-only', value: '   ', reason: 'required' },
    { name: 'non-string number', value: 42, reason: 'required' },
    { name: 'undefined', value: undefined, reason: 'required' },
    { name: 'leading dot', value: '.a', reason: 'invalid' },
    { name: 'leading dash', value: '-a', reason: 'invalid' },
    { name: 'leading underscore', value: '_a', reason: 'invalid' },
    { name: 'leading slash', value: '/a', reason: 'invalid' },
    { name: 'inner space', value: 'a b', reason: 'invalid' },
    { name: 'colon', value: 'a:b', reason: 'invalid' },
    { name: 'inner tab', value: 'a\tb', reason: 'invalid' },
    { name: 'inner newline', value: 'a\nb', reason: 'invalid' },
    { name: 'non-ascii', value: '键', reason: 'invalid' },
    { name: 'length 159', value: `a${'b'.repeat(158)}` },
    { name: 'length 160 (the cap)', value: `a${'b'.repeat(159)}` },
    { name: 'length 161', value: `a${'b'.repeat(160)}`, reason: 'invalid' },
    { name: 'single letter', value: 'a' },
    { name: 'single digit', value: '0' },
    { name: 'every allowed special', value: 'a.b-c_d/e9' },
    { name: 'trailing whitespace trims to legal', value: 'alpha-map \n' },
    { name: 'surrounding whitespace trims to legal', value: '  alpha-map  ' },
  ]

  /** @type {Array<{ name: string, value: unknown, reason?: string }>} */
  const ENTRY_TYPE_CASES = [
    ...ENTRY_TYPES.map((value) => ({ name: `valid ${value}`, value })),
    { name: 'case mismatch', value: 'Map', reason: 'invalid' },
    { name: 'uppercase', value: 'MAP', reason: 'invalid' },
    { name: 'hyphenated lookalike', value: 'dead-end', reason: 'invalid' },
    { name: 'empty', value: '', reason: 'invalid' },
    { name: 'non-string number', value: 42, reason: 'invalid' },
    { name: 'undefined', value: undefined, reason: 'invalid' },
  ]

  /** @type {Array<{ name: string, value: unknown, reason?: string }>} */
  const SUMMARY_CASES = [
    { name: 'empty', value: '', reason: 'required' },
    { name: 'whitespace-only', value: '   ', reason: 'required' },
    { name: 'non-string number', value: 42, reason: 'required' },
    { name: 'undefined', value: undefined, reason: 'required' },
    { name: 'one char', value: 'x' },
    { name: 'at the cap (500)', value: 'x'.repeat(500) },
    { name: 'over the cap (501)', value: 'x'.repeat(501), reason: 'invalid' },
    { name: 'padded within the cap', value: `  ${'y'.repeat(498)}  ` },
    { name: 'padded over the cap', value: ` ${'y'.repeat(501)} `, reason: 'invalid' },
  ]

  /** @type {Array<{ name: string, value: unknown, reason?: string }>} */
  const CONTENT_CASES = [
    { name: 'empty', value: '', reason: 'required' },
    { name: 'whitespace-only', value: '   ', reason: 'required' },
    { name: 'non-string number', value: 42, reason: 'required' },
    { name: 'undefined', value: undefined, reason: 'required' },
    { name: 'non-empty', value: 'body' },
    { name: 'padded non-empty crosses verbatim', value: '  body  ' },
  ]

  it('chunk and kernel agree on every corpus case (decision equivalence)', async () => {
    const { exports: chunk } = await loadClientChunk('lib/client.blackboard-model.js')
    const kernel = createBlackboardKernel()
    let writeSeq = 0

    /** The value the wire would carry: the chunk's own payload builder for strings (which trims key/summary), the raw value otherwise. */
    const wireValue = (field, value) =>
      typeof value === 'string' ? chunk.editorWritePayload(draftWith(field, value))[field] : value

    /** Does the kernel accept this wire value for this field? (Content rides a real write call: it has no standalone validator export.) */
    const kernelAccepts = (field, value) => {
      try {
        if (field === 'key') validateKey(value)
        else if (field === 'entryType') validateEntryType(value)
        else if (field === 'summary') validateSummary(value)
        else kernel.write('board', { holderId: 'h', key: `k${++writeSeq}`, entryType: 'map', summary: 's', content: value, ttlMs: 60000 })
        return true
      } catch {
        return false
      }
    }

    const drive = (field, { name, value, reason }) => {
      const errors = chunk.editorErrorsOf(draftWith(field, value))
      const chunkIllegal = field in errors
      expect(chunkIllegal, `${field} / ${name}: chunk decision`).toBe(reason !== undefined)
      if (reason !== undefined) expect(errors[field], `${field} / ${name}: chunk reason`).toBe(reason)
      const accepted = kernelAccepts(field, wireValue(field, value))
      expect(accepted, `${field} / ${name}: kernel decision`).toBe(!chunkIllegal)
    }

    for (const testCase of KEY_CASES) drive('key', testCase)
    for (const testCase of ENTRY_TYPE_CASES) drive('entryType', testCase)
    for (const testCase of SUMMARY_CASES) drive('summary', testCase)
    for (const testCase of CONTENT_CASES) drive('content', testCase)
  })

  it('agrees over the full printable ASCII alphabet (leading and inner sweeps)', async () => {
    const { exports: chunk } = await loadClientChunk('lib/client.blackboard-model.js')
    const kernelAcceptsKey = (value) => {
      try {
        validateKey(value)
        return true
      } catch {
        return false
      }
    }
    for (let code = 0x20; code <= 0x7e; code++) {
      const ch = String.fromCharCode(code)
      for (const [position, value] of [['inner', `a${ch}b`], ['leading', `${ch}ab`]]) {
        const chunkIllegal = 'key' in chunk.editorErrorsOf(draftWith('key', value))
        const wire = chunk.editorWritePayload(draftWith('key', value)).key
        expect(kernelAcceptsKey(wire), `${position} ${JSON.stringify(ch)} (code ${code})`).toBe(!chunkIllegal)
      }
    }
  })
})
