// Behavior pins for src/message-text.js: the unified textOf must cover both
// input shapes (message object vs bare ContentBlock array) with identical
// semantics, and honor the truncation parameter (event-tap's 600 slice).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { textOf } from '../src/message-text.js'

const BLOCKS = [
  { type: 'text', text: 'first line' },
  { type: 'image', data: 'ignored' },
  { type: 'text', text: 'second line' },
]

describe('textOf input shapes', () => {
  it('extracts from a message object with a content array', () => {
    assert.equal(textOf({ role: 'user', content: BLOCKS }), 'first line\nsecond line')
  })

  it('extracts from a bare ContentBlock array (followup/steer inputs)', () => {
    assert.equal(textOf(BLOCKS), 'first line\nsecond line')
  })

  it('yields identical text for both shapes of the same message', () => {
    assert.equal(textOf({ role: 'user', content: BLOCKS }), textOf(BLOCKS))
  })

  it('returns an empty string for unrecognized shapes', () => {
    assert.equal(textOf(undefined), '')
    assert.equal(textOf(null), '')
    assert.equal(textOf({ role: 'user', content: 'a plain string' }), '')
    assert.equal(textOf('a bare string'), '')
  })

  it('keeps only well-formed text blocks', () => {
    const messy = [
      null,
      { type: 'text' },
      { type: 'text', text: 42 },
      { type: 'tool-call', name: 'x' },
      { type: 'text', text: 'kept' },
    ]
    assert.equal(textOf(messy), 'kept')
  })
})

describe('textOf truncation', () => {
  it('returns the full text without a limit (mock transcript semantics)', () => {
    const long = [{ type: 'text', text: 'x'.repeat(700) }]
    assert.equal(textOf(long).length, 700)
  })

  it('slices at the given limit (event-tap semantics)', () => {
    const long = [{ type: 'text', text: 'x'.repeat(700) }]
    assert.equal(textOf(long, { limit: 600 }).length, 600)
    assert.equal(textOf({ content: long }, { limit: 600 }), 'x'.repeat(600))
  })

  it('slices after joining, not per block', () => {
    const two = [
      { type: 'text', text: 'aaaa' },
      { type: 'text', text: 'bbbb' },
    ]
    assert.equal(textOf(two, { limit: 6 }), 'aaaa\nb')
  })
})
