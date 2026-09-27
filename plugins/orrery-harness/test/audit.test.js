import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from './helpers.js'
import { createAudit } from '../src/shared/audit.js'

describe('shared audit channel', () => {
  it('emits a cordis event and mirrors a JSONL line to .orrery/audit.jsonl', () => {
    const emitted = []
    const ctx = { emit: (type, record) => emitted.push({ type, record }) }
    const cwd = mkdtempSync(join(tmpdir(), 'orrery-audit-'))
    try {
      const audit = createAudit(ctx)
      audit({ id: 's1', header: { cwd } }, 'test-event', { foo: 'bar' })

      expect(emitted).toHaveLength(1)
      expect(emitted[0].type).toBe('orrery/test-event')
      expect(emitted[0].record.session).toBe('s1')
      expect(emitted[0].record.data).toEqual({ foo: 'bar' })

      const lines = readFileSync(join(cwd, '.orrery', 'audit.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const record = JSON.parse(lines[0])
      expect(record.type).toBe('orrery/test-event')
      expect(record.session).toBe('s1')
      expect(record.data).toEqual({ foo: 'bar' })
      expect(typeof record.time).toBe('number')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('stays silent when the session has no cwd', () => {
    const emitted = []
    const audit = createAudit({ emit: (type, record) => emitted.push({ type, record }) })
    audit({ id: 's2', header: {} }, 'no-cwd', { a: 1 })
    expect(emitted).toHaveLength(1) // cordis emit still fires; file is skipped
  })

  it('never throws on emit or file failures', () => {
    const audit = createAudit({
      emit: () => {
        throw new Error('bus down')
      },
    })
    // cwd pointing at a path that cannot be created (a file as directory)
    audit({ id: 's3', header: { cwd: '/dev/null/impossible' } }, 'resilient', { b: 2 })
    audit(undefined, 'resilient-too')
  })

  it('snapshots non-JSON payloads to null instead of throwing', () => {
    const emitted = []
    const audit = createAudit({ emit: (type, record) => emitted.push({ type, record }) })
    const circular = {}
    circular.self = circular
    audit({ id: 's4', header: {} }, 'circular', circular)
    expect(emitted[0].record.data).toBeNull()
  })
})
