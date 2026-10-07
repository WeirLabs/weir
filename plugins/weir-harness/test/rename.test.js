import { describe, expect, it } from './helpers.js'
import {
  applyTextEdits,
  detectLineEndings,
  extractChanges,
  normalizeLineEndings,
  positionToIndex,
  restoreLineEndings,
} from '../src/lsp/rename.js'

const edit = (sl, sc, el, ec, newText) => ({
  range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
  newText,
})

describe('positionToIndex', () => {
  it('maps 0-based line/character to the absolute UTF-16 index', () => {
    const content = 'ab\ncde\nf'
    expect(positionToIndex(content, 0, 0)).toBe(0)
    expect(positionToIndex(content, 0, 2)).toBe(2)
    expect(positionToIndex(content, 1, 0)).toBe(3)
    expect(positionToIndex(content, 1, 3)).toBe(6)
    expect(positionToIndex(content, 2, 1)).toBe(8)
  })

  it('throws when the line is past the end of file', () => {
    expect(() => positionToIndex('ab\ncd', 2, 0)).toThrow(/out of bounds/)
  })

  it('throws when the character is past the end of the line', () => {
    expect(() => positionToIndex('ab\ncd', 1, 3)).toThrow(/out of bounds/)
    expect(() => positionToIndex('ab\ncd', 0, 3)).toThrow(/out of bounds/)
  })

  it('accepts the end-of-line and end-of-file positions', () => {
    expect(positionToIndex('ab\ncd', 0, 2)).toBe(2)
    expect(positionToIndex('ab\ncd', 1, 2)).toBe(5)
  })

  it('throws on negative or non-integer positions', () => {
    expect(() => positionToIndex('ab', -1, 0)).toThrow(/malformed/)
    expect(() => positionToIndex('ab', 0, 1.5)).toThrow(/malformed/)
  })
})

describe('applyTextEdits', () => {
  it('applies a single edit over LF-normalized CRLF-origin content', () => {
    // The tool normalizes before synthesis: positions are counted over the
    // LF form even when the file on disk is CRLF.
    const content = normalizeLineEndings('const oldName = 1\r\nexport { oldName }\r\n')
    const result = applyTextEdits(content, [edit(0, 6, 0, 13, 'newName')])
    expect(result).toBe('const newName = 1\nexport { oldName }\n')
  })

  it('applies multiple edits back-to-front without index drift', () => {
    const content = 'aa bb\ncc aa\n'
    const result = applyTextEdits(content, [edit(0, 0, 0, 2, 'zz'), edit(1, 3, 1, 5, 'zz')])
    expect(result).toBe('zz bb\ncc zz\n')
  })

  it('accepts unsorted edits and adjacent (touching) ranges', () => {
    const content = 'abcd'
    const result = applyTextEdits(content, [edit(0, 2, 0, 4, 'CD'), edit(0, 0, 0, 2, 'AB')])
    expect(result).toBe('ABCD')
  })

  it('rejects overlapping edits', () => {
    expect(() => applyTextEdits('abcd', [edit(0, 0, 0, 3, 'x'), edit(0, 1, 0, 2, 'y')])).toThrow(/overlapping/)
    expect(() => applyTextEdits('ab\ncd\nef', [edit(0, 1, 2, 0, 'x'), edit(1, 0, 1, 2, 'y')])).toThrow(/overlapping/)
  })

  it('rejects out-of-bounds edits', () => {
    expect(() => applyTextEdits('ab', [edit(1, 0, 1, 1, 'x')])).toThrow(/out of bounds/)
    expect(() => applyTextEdits('ab', [edit(0, 0, 0, 3, 'x')])).toThrow(/out of bounds/)
  })

  it('rejects an end before the start and malformed edits', () => {
    expect(() => applyTextEdits('abcd', [edit(0, 3, 0, 1, 'x')])).toThrow(/end before start/)
    expect(() => applyTextEdits('abcd', [{ newText: 'x' }])).toThrow(/malformed/)
    expect(() => applyTextEdits('abcd', [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }])).toThrow(/malformed/)
  })

  it('treats astral characters as two UTF-16 units (JS indices just work)', () => {
    // 'a💧b x💧y' = a(1) + 💧(2, surrogate pair) + b(1) + ' '(1) + x(1) + 💧(2) + y(1) = 9 units
    const content = 'a💧b x💧y'
    // replace 'b' (index 3) and 'y' (index 8)
    const result = applyTextEdits(content, [edit(0, 3, 0, 4, 'B'), edit(0, 8, 0, 9, 'Y')])
    expect(result).toBe('a💧B x💧Y')
  })

  it('supports an edit boundary in the middle of nowhere astral-free after a surrogate pair', () => {
    const content = '💧💧 end'
    // end of the second emoji is index 4; insert there (zero-width)
    const result = applyTextEdits(content, [edit(0, 4, 0, 4, '!')])
    expect(result).toBe('💧💧! end')
  })
})

describe('detectLineEndings', () => {
  it('detects LF, CRLF, and no-newline samples', () => {
    expect(detectLineEndings(Buffer.from('a\nb\nc\n', 'utf8'))).toBe('LF')
    expect(detectLineEndings(Buffer.from('a\r\nb\r\nc\r\n', 'utf8'))).toBe('CRLF')
    expect(detectLineEndings(Buffer.from('no newlines at all', 'utf8'))).toBe('LF')
  })

  it('majority-votes mixed samples (CRLF majority wins; tie goes LF)', () => {
    expect(detectLineEndings(Buffer.from('a\r\nb\r\nc\n', 'utf8'))).toBe('CRLF')
    expect(detectLineEndings(Buffer.from('a\r\nb\n', 'utf8'))).toBe('LF')
  })

  it('accepts Uint8Array and string samples', () => {
    expect(detectLineEndings(new Uint8Array(Buffer.from('x\r\ny\r\n')))).toBe('CRLF')
    expect(detectLineEndings('x\ny\n')).toBe('LF')
  })
})

describe('restoreLineEndings', () => {
  it('LF returns content unchanged', () => {
    expect(restoreLineEndings('a\nb\n', 'LF')).toBe('a\nb\n')
  })

  it('CRLF joins lines with \\r\\n', () => {
    expect(restoreLineEndings('a\nb\n', 'CRLF')).toBe('a\r\nb\r\n')
  })

  it('never doubles an existing \\r (re-normalizes first)', () => {
    expect(restoreLineEndings('a\r\nb\r\n', 'CRLF')).toBe('a\r\nb\r\n')
    expect(restoreLineEndings('a\r\nb\nc', 'CRLF')).toBe('a\r\nb\r\nc')
  })
})

describe('normalizeLineEndings', () => {
  it('collapses CRLF pairs and leaves lone \\r bytes untouched', () => {
    expect(normalizeLineEndings('a\r\nb\rc\n')).toBe('a\nb\rc\n')
  })
})

describe('extractChanges', () => {
  it('maps the changes form to [{path, edits}] with decoded paths', () => {
    const edits = [edit(0, 0, 0, 1, 'x')]
    const result = extractChanges({ changes: { 'file:///ws/a%20b.ts': edits, 'file:///ws/c.ts': [] } })
    expect(result).toEqual([
      { path: '/ws/a b.ts', edits },
      { path: '/ws/c.ts', edits: [] },
    ])
  })

  it('returns null for null/undefined/absent/empty changes', () => {
    expect(extractChanges(null)).toBeNull()
    expect(extractChanges(undefined)).toBeNull()
    expect(extractChanges({})).toBeNull()
    expect(extractChanges({ changes: {} })).toBeNull()
    expect(extractChanges({ changes: null })).toBeNull()
  })

  it('rejects documentChanges explicitly', () => {
    expect(() => extractChanges({ documentChanges: [] })).toThrow(/documentChanges.*does not apply/)
    expect(() => extractChanges({ documentChanges: [{ textDocument: { uri: 'file:///ws/a.ts', version: 1 }, edits: [] }] })).toThrow(/documentChanges/)
  })
})
