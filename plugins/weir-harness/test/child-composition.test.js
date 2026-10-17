// child-composition: the creation-window shim that replaces DSH 0.2.1's
// removed request-level persona/toolFilter. Pins the fresh-spawn application,
// the fail-closed spawn verdict, the cold-resume replay from the audit tail
// (the shim is runtime-only state), the deny-floor degrade when the fact is
// missing, attribution (a foreign delegated child is never touched), and the
// listener's fail-open posture on the replay path.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from './helpers.js'
import { createChildComposition, SPAWN_FACT_RECORD_TYPE, SPAWN_FACT_TYPE } from '../src/delegate/child-composition.js'
import { createAudit } from '../src/shared/audit.js'
import { CHILD_DENY_TOOLS } from '../src/shared/child-scope.js'

const KNOWN = new Set(['bash', 'read', 'write', 'delegate', 'send_message', 'workflow'])

/** Fake agent whose composition application is observable. */
function fakeAgent({ id = 'child-1', header = {}, toolsKnown = KNOWN } = {}) {
  const applied = { sections: [], restrictions: [] }
  const agent = {
    id,
    session: { header: { delegationDepth: 1, parentSession: 'parent-1', ...header } },
    ctx: {
      systemPrompt: {
        section: (section) => {
          applied.sections.push(section)
          return () => {}
        },
        getSectionOrder: () => 42,
      },
      tools: {
        view: () => ({ restrictableNames: toolsKnown }),
        restrict: (filter) => {
          applied.restrictions.push(filter)
          return () => {}
        },
      },
    },
  }
  return { agent, applied }
}

function mount({ toolsKnown = KNOWN, restrictableNames = () => toolsKnown, audit = () => {} } = {}) {
  const handlers = {}
  const warnings = []
  const ctx = {
    on: (name, handler) => {
      handlers[name] = handler
      return () => {
        if (handlers[name] === handler) delete handlers[name]
      }
    },
  }
  const composition = createChildComposition({
    ctx,
    audit,
    logger: { warn: (message) => warnings.push(message) },
    restrictableNames,
  })
  return { composition, handlers, warnings }
}

/**
 * One audit JSONL record in the shape createAudit actually writes: the sink
 * prepends `weir/` to the type it is handed, so fixtures mirror that prepend.
 * A fixture reusing the unprefixed sink argument verbatim is what hid the
 * double-prefixed `weir/weir/delegate/spawn` defect.
 */
function sinkRecord(session, type, data) {
  return { time: Date.now(), session, type: `weir/${type}`, data }
}

function sectionOf(applied) {
  return applied.sections.find((section) => section.name === 'deployment:persona-prefix')
}

describe('child-composition fresh spawn', () => {
  it('applies the persona prefix section and the deny list inside the creation window', () => {
    const { composition, handlers } = mount()
    const registration = composition.beginSpawn({
      session: { id: 'parent-1', header: {} },
      childId: 'child-1',
      lane: 'one-shot',
      label: 'child-label',
      persona: 'PERSONA-TEXT',
      toolFilter: { deny: ['send_message'] },
    })
    const { agent, applied } = fakeAgent()
    handlers['agent/created']({ agent })
    expect(registration.outcome()).toEqual({ ok: true })
    const section = sectionOf(applied)
    expect(section.order).toBe(42)
    expect(section.text).toBe('PERSONA-TEXT')
    // deny filter: requested names + CHILD_DENY_TOOLS ∩ known
    const deny = applied.restrictions[0].deny
    expect(deny).toContain('send_message')
    for (const name of CHILD_DENY_TOOLS) if (KNOWN.has(name)) expect(deny).toContain(name)
    expect(deny.every((name) => KNOWN.has(name))).toBe(true)
  })

  it('reports a failed outcome and rethrows when the application fails', () => {
    const { composition, handlers } = mount()
    const registration = composition.beginSpawn({
      session: { id: 'parent-1', header: {} },
      childId: 'child-1',
      lane: 'one-shot',
      persona: 'PERSONA',
      toolFilter: { deny: [] },
    })
    const { agent } = fakeAgent()
    agent.ctx.tools.restrict = () => {
      throw new Error('restrict exploded')
    }
    let caught
    try {
      handlers['agent/created']({ agent })
    } catch (error) {
      caught = error
    }
    expect(caught?.message).toContain('failed to apply the child composition for "child-1"')
    expect(caught?.message).toContain('restrict exploded')
    const outcome = registration.outcome()
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe(caught)
  })

  it('reports a not-applied outcome when the creation window never ran', () => {
    const { composition } = mount()
    const registration = composition.beginSpawn({ session: { id: 'p', header: {} }, childId: 'child-9', persona: 'P' })
    const outcome = registration.outcome()
    expect(outcome.ok).toBe(false)
    expect(outcome.error.message).toContain('not applied inside the creation window')
    registration.forget()
  })

  it('ignores non-delegated agents entirely', () => {
    const { composition, handlers } = mount()
    composition.beginSpawn({ session: { id: 'p', header: {} }, childId: 'main-1', persona: 'P' })
    const { agent, applied } = fakeAgent({ id: 'main-1', header: { delegationDepth: 0 } })
    handlers['agent/created']({ agent })
    expect(applied.sections).toHaveLength(0)
    expect(applied.restrictions).toHaveLength(0)
  })
})

describe('child-composition cold resume', () => {
  function withAudit(lines, fn) {
    const cwd = mkdtempSync(join(tmpdir(), 'weir-composition-'))
    try {
      mkdirSync(join(cwd, '.weir'), { recursive: true })
      writeFileSync(join(cwd, '.weir', 'audit.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
      return fn(cwd)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it('replays the spawn fact for a resumed child of this parent session', () => {
    const record = sinkRecord('parent-1', SPAWN_FACT_TYPE, {
      childId: 'child-1',
      lane: 'supervised',
      label: 'resumed',
      persona: 'RESUMED-PERSONA',
      toolFilter: { deny: ['send_message'] },
    })
    withAudit([record], (cwd) => {
      const { handlers, warnings } = mount()
      const { agent, applied } = fakeAgent({ header: { cwd } })
      // No pending entry (a restart): the apply lands through the replay path.
      handlers['agent/created']({ agent })
      expect(sectionOf(applied)?.text).toBe('RESUMED-PERSONA')
      expect(applied.restrictions[0].deny).toContain('send_message')
      expect(warnings).toHaveLength(0)
    })
  })

  it('applies the static deny floor and warns when the spawn fact is missing but the parent session is weir-managed', () => {
    const supervision = { time: Date.now(), session: 'parent-1', type: 'weir/supervision/spawn', data: { kind: 'spawn', childId: 'child-7', name: 'x', group: 'g' } }
    withAudit([supervision], (cwd) => {
      const { handlers, warnings } = mount()
      const { agent, applied } = fakeAgent({ header: { cwd } })
      handlers['agent/created']({ agent })
      expect(warnings[0]).toContain('no delegate/spawn fact')
      expect(applied.sections).toHaveLength(0)
      const deny = applied.restrictions[0].deny
      expect(deny).toEqual(CHILD_DENY_TOOLS.filter((name) => KNOWN.has(name)))
    })
  })

  it('never touches a delegated child of a foreign (non-weir) parent session', () => {
    // The audit tail carries weir records, but none for THIS child's parent:
    // the child belongs to another session's delegation, so it is left alone.
    const foreign = { time: Date.now(), session: 'another-parent', type: 'weir/supervision/spawn', data: { kind: 'spawn', childId: 'another-child', name: 'x', group: 'g' } }
    withAudit([foreign], (cwd) => {
      const { handlers, warnings } = mount()
      const { agent, applied } = fakeAgent({ id: 'other-child', header: { cwd, parentSession: 'other-parent' } })
      handlers['agent/created']({ agent })
      expect(applied.sections).toHaveLength(0)
      expect(applied.restrictions).toHaveLength(0)
      expect(warnings).toHaveLength(0)
    })
  })

  it('degrades fail-open (warn) when the replay application throws, still applying the deny floor', () => {
    const record = sinkRecord('parent-1', SPAWN_FACT_TYPE, {
      childId: 'child-1',
      lane: 'continuable',
      persona: 'P',
      toolFilter: { deny: ['rm'] },
    })
    withAudit([record], (cwd) => {
      const { handlers, warnings } = mount()
      const { agent, applied } = fakeAgent({ header: { cwd } })
      let throwOnce = true
      agent.ctx.systemPrompt.section = () => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('prompt service exploded')
        }
      }
      handlers['agent/created']({ agent })
      expect(warnings[0]).toContain('composition replay failed (fail-open)')
      expect(applied.restrictions[0].deny).toEqual(CHILD_DENY_TOOLS.filter((name) => KNOWN.has(name)))
    })
  })

  it('reads no audit file at all for a child without a cwd (nothing to replay)', () => {
    const { handlers, warnings } = mount()
    const { agent, applied } = fakeAgent({ header: { cwd: undefined } })
    handlers['agent/created']({ agent })
    expect(applied.sections).toHaveLength(0)
    expect(applied.restrictions).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })
})

describe('child-composition spawn-fact record shape (double-prefix regression)', () => {
  it('writes one single-prefixed weir/delegate/spawn record through the real sink and replays it after a restart', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'weir-composition-sink-'))
    try {
      // The REAL sink: createAudit prepends `weir/` to whatever beginSpawn hands
      // it, so this is the only assertion covering the write path end to end.
      const emitted = []
      const audit = createAudit({ emit: (type, record) => emitted.push({ type, record }) })
      const live = mount({ audit })
      live.composition.beginSpawn({
        session: { id: 'parent-1', header: { cwd } },
        childId: 'child-1',
        lane: 'one-shot',
        label: 'sink-shaped',
        persona: 'SINK-PERSONA',
        toolFilter: { deny: ['send_message'] },
      })
      // A host restart: the runtime shim state is gone, only the JSONL remains.
      live.composition.dispose()

      // (a) the stored record and the cordis event carry exactly ONE prefix.
      expect(SPAWN_FACT_TYPE).toBe('delegate/spawn')
      expect(SPAWN_FACT_RECORD_TYPE).toBe('weir/delegate/spawn')
      expect(emitted[0].type).toBe('weir/delegate/spawn')
      const lines = readFileSync(join(cwd, '.weir', 'audit.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]).type).toBe('weir/delegate/spawn')

      // (b) the cold-resume replay finds that record: persona + toolFilter land
      // and the deny-floor warn (the old symptom) never fires.
      const restarted = mount()
      const { agent, applied } = fakeAgent({ header: { cwd } })
      restarted.handlers['agent/created']({ agent })
      expect(restarted.warnings).toHaveLength(0)
      expect(sectionOf(applied)?.text).toBe('SINK-PERSONA')
      expect(applied.restrictions[0].deny).toContain('send_message')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('child-composition dispose', () => {
  it('unregisters the listener and clears pending entries', () => {
    const { composition, handlers } = mount()
    composition.beginSpawn({ session: { id: 'p', header: {} }, childId: 'child-1', persona: 'P' })
    expect(typeof handlers['agent/created']).toBe('function')
    composition.dispose()
    expect(handlers['agent/created']).toBe(undefined)
  })
})
