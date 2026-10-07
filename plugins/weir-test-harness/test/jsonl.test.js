// Behavior pins for src/jsonl.js: per-line fault tolerance — blank lines are
// skipped, unparseable lines are dropped (never fatal), and missing files
// read as zero records.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJsonlLines, readJsonl } from '../src/jsonl.js'

describe('parseJsonlLines', () => {
  it('parses normal multi-line JSONL in order', () => {
    const text = '{"a":1}\n{"b":2}\n[3,4]\n'
    assert.deepEqual(parseJsonlLines(text), [{ a: 1 }, { b: 2 }, [3, 4]])
  })

  it('returns [] for empty input', () => {
    assert.deepEqual(parseJsonlLines(''), [])
    assert.deepEqual(parseJsonlLines('\n'), [])
  })

  it('drops bad lines and keeps the good ones (never fatal)', () => {
    const text = '{"good":1}\nnot json at all\n{"also_good":2}\n{"truncated":\n'
    assert.deepEqual(parseJsonlLines(text), [{ good: 1 }, { also_good: 2 }])
  })

  it('skips blank and whitespace-only lines', () => {
    const text = '\n{"a":1}\n   \n\t\n{"b":2}\n'
    assert.deepEqual(parseJsonlLines(text), [{ a: 1 }, { b: 2 }])
  })

  it('parses non-string input as zero records', () => {
    assert.deepEqual(parseJsonlLines(undefined), [])
    assert.deepEqual(parseJsonlLines(null), [])
    assert.deepEqual(parseJsonlLines(42), [])
  })
})

describe('readJsonl', () => {
  it('reads and parses an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weir-jsonl-'))
    try {
      const file = join(dir, 'trace.jsonl')
      writeFileSync(file, '{"x":1}\nbad line\n{"y":2}\n')
      assert.deepEqual(readJsonl(file), [{ x: 1 }, { y: 2 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('yields [] for a missing file', () => {
    assert.deepEqual(readJsonl(join(tmpdir(), 'weir-jsonl-no-such-file.jsonl')), [])
  })
})
