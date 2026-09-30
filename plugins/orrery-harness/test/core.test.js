import { describe, expect, it } from '../test/helpers.js'
import { apply, inject, name } from '../src/core/index.js'
import { DOCTRINE, DOCTRINE_SECTION_NAME, DOCTRINE_SECTION_ORDER } from '../src/core/doctrine.js'

function fakeCtx() {
  const registrations = []
  return {
    registrations,
    systemPrompt: {
      section(section) {
        registrations.push(section)
        return () => {}
      },
    },
  }
}

describe('orrery-core', () => {
  it('declares the expected plugin metadata', () => {
    expect(name).toBe('orrery-core')
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
    expect(section.text).toBe(DOCTRINE)
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
})
