import { describe, expect, it } from '../test/helpers.js'
import { apply, inject, name } from '../src/creative-guide/index.js'
import { CREATIVE_GUIDE, CREATIVE_GUIDE_SECTION_NAME, CREATIVE_GUIDE_SECTION_ORDER } from '../src/creative-guide/guide.js'
import { DOCTRINE_SECTION_ORDER } from '../src/core/doctrine.js'

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

describe('orrery-creative-guide', () => {
  it('declares the expected plugin metadata', () => {
    expect(name).toBe('orrery-creative-guide')
    expect(inject).toEqual(['systemPrompt'])
  })

  it('registers the guide section immediately after the doctrine', () => {
    const ctx = fakeCtx()
    const dispose = apply(ctx)
    expect(ctx.registrations).toHaveLength(1)
    const [section] = ctx.registrations
    expect(section.name).toBe(CREATIVE_GUIDE_SECTION_NAME)
    expect(section.name).toBe('orchestrator:creative-guide')
    expect(section.order).toBe(CREATIVE_GUIDE_SECTION_ORDER)
    expect(section.order > DOCTRINE_SECTION_ORDER, 'guide must follow the doctrine section').toBe(true)
    expect(section.text).toBe(CREATIVE_GUIDE)
    expect(typeof dispose).toBe('function')
  })

  it('covers every creative tooling domain', () => {
    const required = [
      // Runtime inspection: list-then-query order, read-only semantics.
      'cordis_inspect_list', 'cordis_inspect_query', 'read-only',
      // Plugin management discipline.
      'plugin_manager', 'set_bundle', 'install_bundle', 'version exemption',
      // The four development skills.
      'cordis-plugin-development', 'editing-cordis-compositions', 'cordis-composition-reference', 'agent-experience',
      // Composition discipline.
      '@deepseek-ai/*', "object-rooted", 'cordis:group', '!!js',
    ]
    for (const marker of required) {
      expect(CREATIVE_GUIDE.includes(marker), `creative guide must mention ${marker}`).toBe(true)
    }
  })
})
