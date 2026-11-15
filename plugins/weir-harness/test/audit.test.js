import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from './helpers.js'
import { createAudit } from '../src/shared/audit.js'
import { createDecisionAudit } from '../src/decision/audit.js'

describe('shared audit channel', () => {
  it('emits a cordis event and mirrors a JSONL line to .weir/audit.jsonl', () => {
    const emitted = []
    const ctx = { emit: (type, record) => emitted.push({ type, record }) }
    const cwd = mkdtempSync(join(tmpdir(), 'weir-audit-'))
    try {
      const audit = createAudit(ctx)
      audit({ id: 's1', header: { cwd } }, 'test-event', { foo: 'bar' })

      expect(emitted).toHaveLength(1)
      expect(emitted[0].type).toBe('weir/test-event')
      expect(emitted[0].record.session).toBe('s1')
      expect(emitted[0].record.data).toEqual({ foo: 'bar' })

      const lines = readFileSync(join(cwd, '.weir', 'audit.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const record = JSON.parse(lines[0])
      expect(record.type).toBe('weir/test-event')
      expect(record.session).toBe('s1')
      expect(record.data).toEqual({ foo: 'bar' })
      expect(typeof record.time).toBe('number')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('anchors the JSONL mirror at an explicit root instead of the session cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'weir-audit-root-'))
    const cwd = mkdtempSync(join(tmpdir(), 'weir-audit-cwd-'))
    try {
      const audit = createAudit({ emit: () => {} })
      audit({ id: 's9', header: { cwd } }, 'worktree/open', { lane: 'a-001' }, { root })
      const record = JSON.parse(readFileSync(join(root, '.weir', 'audit.jsonl'), 'utf8').trim())
      expect(record.type).toBe('weir/worktree/open')
      expect(record.data).toEqual({ lane: 'a-001' })
      expect(() => readFileSync(join(cwd, '.weir', 'audit.jsonl'))).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
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

describe('Decision audit privacy projection', () => {
  it('never mirrors question, evidence, answer, or profile bodies', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'weir-decision-audit-'))
    try {
      const audit = createDecisionAudit({ emit: () => {} }, { root: cwd })
      audit('case-open', {
        caseId: 'dc_1', rootSessionId: 'root', outcome: 'answered', answerCount: 1,
        question: 'PRIVATE-QUESTION', evidence: 'PRIVATE-EVIDENCE',
        userDescription: 'PRIVATE-PROFILE', answers: [{ custom: 'PRIVATE-ANSWER' }],
      })
      const raw = readFileSync(join(cwd, '.weir', 'audit.jsonl'), 'utf8')
      for (const secret of ['PRIVATE-QUESTION', 'PRIVATE-EVIDENCE', 'PRIVATE-PROFILE', 'PRIVATE-ANSWER']) expect(raw.includes(secret)).toBe(false)
      const record = JSON.parse(raw.trim())
      expect(record.type).toBe('weir/decision/case-open')
      expect(record.data).toEqual({ caseId: 'dc_1', rootSessionId: 'root', outcome: 'answered', answerCount: 1 })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps the bounded output token count of a failed verdict and drops unknown fields', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'weir-decision-route-audit-'))
    try {
      const audit = createDecisionAudit({ emit: () => {} }, { root: cwd })
      audit('case-open', {
        caseId: 'dc_route', entry: 'hook', outcome: 'no_route', reason: 'failure:truncated',
        outputTokens: 4096, outputText: 'PRIVATE-VERDICT', maxTokens: 1600,
      })
      const raw = readFileSync(join(cwd, '.weir', 'audit.jsonl'), 'utf8')
      expect(raw.includes('PRIVATE-VERDICT')).toBe(false)
      expect(JSON.parse(raw.trim()).data).toEqual({
        caseId: 'dc_route', entry: 'hook', outcome: 'no_route', reason: 'failure:truncated', outputTokens: 4096,
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
  it('keeps a candidate-update fact as zone, revisions and counts only', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'weir-decision-candidate-audit-'))
    try {
      const audit = createDecisionAudit({ emit: () => {} }, { root: cwd })
      audit('snapshot', {
        snapshotId: 'ms_1', learningRunId: 'lr_1', agentId: 'ag_1', rootSessionId: 'root', zone: 'workspace',
        action: 'candidate-update', revisionBefore: 2, revisionAfter: 3, edited: 1, removed: 1,
        principles: [{ text: 'PRIVATE-PRINCIPLE' }], text: 'PRIVATE-PRINCIPLE',
        scope: { paths: ['PRIVATE-PATH'] },
      })
      const raw = readFileSync(join(cwd, '.weir', 'audit.jsonl'), 'utf8')
      for (const secret of ['PRIVATE-PRINCIPLE', 'PRIVATE-PATH']) expect(raw.includes(secret)).toBe(false)
      expect(JSON.parse(raw.trim())).toEqual({
        type: 'weir/decision/snapshot',
        session: 'root',
        time: JSON.parse(raw.trim()).time,
        data: {
          snapshotId: 'ms_1', learningRunId: 'lr_1', agentId: 'ag_1', rootSessionId: 'root', zone: 'workspace',
          action: 'candidate-update', revisionBefore: 2, revisionAfter: 3, edited: 1, removed: 1,
        },
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('allows only learning and Snapshot metadata, counts, and SHA-256 digests', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'weir-decision-learning-audit-'))
    try {
      const audit = createDecisionAudit({ emit: () => {} }, { root: cwd })
      audit('learning-run', {
        learningRunId: 'lr_1', agentId: 'ag_1', outcome: 'candidate', revision: 2,
        operationCount: 2, sourceCount: 1, inputHash: 'a'.repeat(64),
        operations: [{ text: 'PRIVATE-PRINCIPLE' }], inputFrozen: { comment: 'PRIVATE-COMMENT' },
      })
      audit('snapshot', {
        snapshotId: 'ms_1', learningRunId: 'lr_1', state: 'draft', version: 3,
        activePrincipleCount: 1, retiredPrincipleCount: 0, contentHash: 'b'.repeat(64),
        principles: [{ text: 'PRIVATE-PRINCIPLE' }], comment: 'PRIVATE-COMMENT', finalHash: 'not-a-digest',
      })
      const raw = readFileSync(join(cwd, '.weir', 'audit.jsonl'), 'utf8')
      for (const secret of ['PRIVATE-PRINCIPLE', 'PRIVATE-COMMENT', 'not-a-digest']) expect(raw.includes(secret)).toBe(false)
      const records = raw.trim().split('\n').map(line => JSON.parse(line))
      expect(records.map(record => record.type)).toEqual(['weir/decision/learning-run', 'weir/decision/snapshot'])
      expect(records[0].data).toEqual({
        learningRunId: 'lr_1', agentId: 'ag_1', outcome: 'candidate', revision: 2,
        operationCount: 2, sourceCount: 1, inputHash: 'a'.repeat(64),
      })
      expect(records[1].data).toEqual({
        snapshotId: 'ms_1', learningRunId: 'lr_1', state: 'draft', version: 3,
        activePrincipleCount: 1, retiredPrincipleCount: 0, contentHash: 'b'.repeat(64),
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
