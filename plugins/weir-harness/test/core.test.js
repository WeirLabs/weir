import { describe, expect, it } from '../test/helpers.js'
import { apply, inject, name } from '../src/core/index.js'
import { DOCTRINE, DOCTRINE_SECTION_NAME, DOCTRINE_SECTION_ORDER, DOCTRINE_VARIABLE_NAME } from '../src/core/doctrine.js'

function fakeCtx() {
  const registrations = []
  const variables = new Map()
  return {
    registrations,
    variables,
    systemPrompt: {
      section(section) {
        registrations.push(section)
        return () => {}
      },
      variable(name, provider) {
        variables.set(name, provider)
        return () => {}
      },
    },
  }
}

describe('weir-core', () => {
  it('declares the expected plugin metadata', () => {
    expect(name).toBe('weir-core')
    expect(inject).toEqual(['systemPrompt'])
  })

  it('registers the doctrine section with its canonical placement', () => {
    const ctx = fakeCtx()
    const dispose = apply(ctx)
    expect(ctx.registrations).toHaveLength(1)
    const [section] = ctx.registrations
    expect(section.name).toBe(DOCTRINE_SECTION_NAME)
    expect(section.name).toBe('orchestrator:doctrine')
    expect(section.order).toBe(DOCTRINE_SECTION_ORDER)
    // Static bare variable reference: the suppression rides the variable
    // provider (evaluated at every assembly) — '' for a delegated child,
    // DOCTRINE (byte-identical) for main-shaped contexts.
    expect(section.text).toBe(`{{${DOCTRINE_VARIABLE_NAME}}}`)
    const doctrine = ctx.variables.get(DOCTRINE_VARIABLE_NAME)
    expect(typeof doctrine).toBe('function')
    expect(doctrine(undefined)).toBe(DOCTRINE)
    expect(doctrine({ agent: { session: { header: {} } } })).toBe(DOCTRINE)
    expect(doctrine({ agent: { session: { header: { delegationDepth: 0 } } } })).toBe(DOCTRINE)
    expect(doctrine({ agent: { session: { header: { delegationDepth: 1 } } } })).toBe('')
    expect(doctrine({ agent: { session: { header: { delegationDepth: 2 } } } })).toBe('')
    expect(typeof dispose).toBe('function')
  })

  it('doctrine covers every contracted rule', () => {
    const required = [
      'Orchestrator',
      'DIRECT', 'SINGLE', 'FAN-OUT', 'PIPELINE',
      'disjoint write scopes',
      'delegate(category=...)',
      'delegate(agent=...)',
      'finder', 'scholar', 'advisor',
      'TASK:', 'DELIVERABLE', 'SCOPE', 'VERIFY', 'STOP WHEN',
      'one-shot',
      "mode: 'continuable'",
      'only possible with continuable children',
      'end the turn',
      'job_output',
      'Evidence closes work',
      'stop_continuation',
      'compact_context',
      'hash_edit', '>>> mismatch',
    ]
    for (const phrase of required) {
      expect(DOCTRINE, `doctrine must mention ${phrase}`).toContain(phrase)
    }
  })

  it('doctrine carries no retired curated-agent name', () => {
    expect(DOCTRINE).not.toContain('explore')
    expect(DOCTRINE).not.toContain('librarian')
    expect(DOCTRINE).not.toContain('oracle')
  })

  it('doctrine scopes the follow-up promise to continuable children', () => {
    // The unscoped promise "a child gets exactly one follow-up" predated the
    // continuable lane and promised what a one-shot child can never receive;
    // the guidance now picks the mode first and scopes the follow-up to it.
    expect(DOCTRINE).toContain('Pick the delegation mode')
    expect(DOCTRINE).toContain('Default to one-shot')
    expect(DOCTRINE).not.toContain('answers with an ack only, gets exactly one follow-up')
  })
})
