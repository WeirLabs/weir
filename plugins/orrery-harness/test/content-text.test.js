// contentText: the one text-extraction helper for the delegate subsystem.
// These corners pin the semantics the three converged call sites relied on:
// non-array input, an empty array, mixed block types, and text blocks whose
// text is not a string.
import { describe, expect, it } from './helpers.js'
import { contentText } from '../src/shared/content-text.js'

describe('contentText', () => {
  it('returns an empty string for non-array input', () => {
    expect(contentText(undefined)).toBe('')
    expect(contentText(null)).toBe('')
    expect(contentText('plain string')).toBe('')
    expect(contentText({ type: 'text', text: 'x' })).toBe('')
  })

  it('returns an empty string for an empty array', () => {
    expect(contentText([])).toBe('')
  })

  it('joins text blocks and skips non-text blocks', () => {
    const blocks = [
      { type: 'text', text: 'first' },
      { type: 'image', data: '...' },
      null,
      { type: 'text', text: 'second' },
    ]
    expect(contentText(blocks)).toBe('first\nsecond')
  })

  it('skips text blocks whose text is not a string', () => {
    const blocks = [
      { type: 'text' },
      { type: 'text', text: 42 },
      { type: 'text', text: 'kept' },
    ]
    expect(contentText(blocks)).toBe('kept')
  })
})
