import { describe, expect, it } from './helpers.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditFilePathOf, readAuditTail, readChildFinalText } from '../src/delegate/audit-readers.js'

describe('auditFilePathOf', () => {
  it('returns null when the session carries no cwd', () => {
    expect(auditFilePathOf(undefined)).toBeNull()
    expect(auditFilePathOf({})).toBeNull()
    expect(auditFilePathOf({ header: {} })).toBeNull()
  })

  it('returns null for a non-string or empty cwd', () => {
    expect(auditFilePathOf({ header: { cwd: 42 } })).toBeNull()
    expect(auditFilePathOf({ header: { cwd: null } })).toBeNull()
    expect(auditFilePathOf({ header: { cwd: '' } })).toBeNull()
  })

  it('joins the audit JSONL path under the session cwd', () => {
    expect(auditFilePathOf({ header: { cwd: '/tmp/work' } })).toBe(join('/tmp/work', '.weir', 'audit.jsonl'))
  })
})

describe('readAuditTail', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audit-readers-'))

  it('returns [] when the file is missing', () => {
    expect(readAuditTail(join(tmp, 'nope.jsonl'))).toEqual([])
  })

  it('returns [] for null/empty paths', () => {
    expect(readAuditTail(null)).toEqual([])
    expect(readAuditTail('')).toEqual([])
  })

  it('returns [] for an empty file', () => {
    const file = join(tmp, 'empty.jsonl')
    writeFileSync(file, '')
    expect(readAuditTail(file)).toEqual([])
  })

  it('parses records and skips blank and malformed lines', () => {
    const file = join(tmp, 'mixed.jsonl')
    writeFileSync(file, `${JSON.stringify({ a: 1 })}\n\nnot-json\n${JSON.stringify({ b: 2 })}\n`)
    expect(readAuditTail(file)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('drops a partial first line inside the tail window', () => {
    // A record larger than the maxBytes window: the read starts mid-record, so
    // the leading partial line must be discarded rather than surfaced.
    const big = 'x'.repeat(400)
    const file = join(tmp, 'partial.jsonl')
    writeFileSync(file, `${JSON.stringify({ big })}\n${JSON.stringify({ tail: true })}\n`)
    const records = readAuditTail(file, 64)
    expect(records).toEqual([{ tail: true }])
  })

  it('truncates to the maxBytes window', () => {
    const file = join(tmp, 'window.jsonl')
    writeFileSync(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n${JSON.stringify({ n: 3 })}\n`)
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ n: 3 })}\n`)
    // Window starts 3 bytes into the middle record, so its partial head is
    // dropped and only the last record survives.
    const records = readAuditTail(file, lineBytes + 3)
    expect(records).toEqual([{ n: 3 }])
  })
})

describe('readChildFinalText', () => {
  const sessionQueryOf = (events) => ({ readSession: async () => ({ events }) })

  it('returns the last assistant/message text', async () => {
    const sessionQuery = sessionQueryOf([
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'question' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final answer' }] } } },
    ])
    expect(await readChildFinalText(sessionQuery, 'child-1')).toBe('final answer')
  })

  it('skips assistant messages with non-array content', async () => {
    const sessionQuery = sessionQueryOf([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'earlier' }] } } },
      { type: 'assistant/message', data: { message: { content: 'string-content' } } },
    ])
    expect(await readChildFinalText(sessionQuery, 'child-1')).toBe('earlier')
  })

  it('returns null when no assistant message matches', async () => {
    const sessionQuery = sessionQueryOf([
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    ])
    expect(await readChildFinalText(sessionQuery, 'child-1')).toBeNull()
  })

  it('returns null for an unreadable session', async () => {
    const sessionQuery = { readSession: async () => undefined }
    expect(await readChildFinalText(sessionQuery, 'child-1')).toBeNull()
  })
})
