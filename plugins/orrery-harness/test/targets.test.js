// Tests for src/delegate/targets.js (delegate target guidance section, task
// 3.1) and the matching DELEGATE_DESCRIPTION wording fix (task 3.3).
import { describe, expect, it } from './helpers.js'
import {
  DELEGATE_TARGETS_SECTION_NAME,
  DELEGATE_TARGETS_SECTION_ORDER_OFFSET,
  DELEGATE_TARGETS_TEMPLATE,
  DELEGATE_TARGETS_VARIABLE_NAME,
  renderDelegateTargets,
} from '../src/delegate/targets.js'
import { DELEGATE_DESCRIPTION } from '../src/delegate/tool.js'

const CATEGORIES = {
  quick: { description: 'Trivial mechanical work.', guidance: 'Default for every splittable piece.', chain: [] },
  deep: { description: 'One goal, one deliverable.', guidance: 'The default deep lane.', chain: [] },
  visual: { description: 'Frontend and styling.', guidance: 'Browser-facing work routes here.', chain: [], disabled: true },
}

const AGENTS = {
  finder: { name: 'finder', description: 'Codebase search.', tools: ['read'] },
  scholar: { name: 'scholar', description: 'Docs and OSS research.', tools: ['read'], disabled: true },
  advisor: { name: 'advisor', description: 'Architecture advice.', tools: ['read'] },
}

describe('delegate target wiring constants', () => {
  it('exposes the names and order offset the composition root consumes', () => {
    expect(DELEGATE_TARGETS_SECTION_NAME).toBe('orchestrator:delegate-targets')
    expect(DELEGATE_TARGETS_VARIABLE_NAME).toBe('orrery_delegate_targets')
    expect(DELEGATE_TARGETS_SECTION_ORDER_OFFSET).toBe(10)
  })
})

describe('DELEGATE_TARGETS_TEMPLATE', () => {
  it('embeds exactly the registered variable reference and no other', () => {
    const reference = `{{${DELEGATE_TARGETS_VARIABLE_NAME}}}`
    expect(reference).toBe('{{orrery_delegate_targets}}')
    expect(DELEGATE_TARGETS_TEMPLATE).toContain(reference)
    const matches = DELEGATE_TARGETS_TEMPLATE.match(/\{\{[^{}]*\}\}/g) ?? []
    expect(matches).toEqual([reference])
  })

  it('states the calling contract: one target per item, no default category, read-only agent lane', () => {
    expect(DELEGATE_TARGETS_TEMPLATE).toContain('exactly one target per item')
    expect(DELEGATE_TARGETS_TEMPLATE).toContain('either a category or a curated agent')
    expect(DELEGATE_TARGETS_TEMPLATE).toContain('no default')
    expect(DELEGATE_TARGETS_TEMPLATE).toContain('must always be named explicitly')
    expect(DELEGATE_TARGETS_TEMPLATE).toContain('read-only research specialists')
  })
})

describe('renderDelegateTargets', () => {
  it('renders the full list in the documented line format', () => {
    expect(renderDelegateTargets({ categories: CATEGORIES, agents: AGENTS })).toBe(
      [
        'Categories:',
        '- quick — Trivial mechanical work. Routing guidance: Default for every splittable piece.',
        '- deep — One goal, one deliverable. Routing guidance: The default deep lane.',
        '',
        'Curated agents:',
        '- finder — Codebase search.',
        '- advisor — Architecture advice.',
      ].join('\n'),
    )
  })

  it('lists only enabled entries: a disabled category or agent never appears', () => {
    const output = renderDelegateTargets({ categories: CATEGORIES, agents: AGENTS })
    expect(output).not.toContain('visual')
    expect(output).not.toContain('Browser-facing work routes here.')
    expect(output).not.toContain('scholar')
    expect(output).not.toContain('Docs and OSS research.')
  })

  it('preserves registry order instead of sorting', () => {
    const output = renderDelegateTargets({
      categories: {
        zeta: { description: 'Z lane.', guidance: 'Z work routes here.' },
        alpha: { description: 'A lane.', guidance: 'A work routes here.' },
      },
      agents: {
        yorick: { description: 'Y agent.' },
        beta: { description: 'B agent.' },
      },
    })
    expect(output.indexOf('- zeta —')).toBeGreaterThan(-1)
    expect(output.indexOf('- alpha —')).toBeGreaterThan(output.indexOf('- zeta —'))
    expect(output.indexOf('- yorick —')).toBeGreaterThan(output.indexOf('- alpha —'))
    expect(output.indexOf('- beta —')).toBeGreaterThan(output.indexOf('- yorick —'))
  })

  it('falls back to an explicit sentence when a set is empty', () => {
    const output = renderDelegateTargets({ categories: {}, agents: {} })
    expect(output).toContain('No categories are currently enabled.')
    expect(output).toContain('No curated agents are currently enabled.')
  })

  it('falls back to an explicit sentence when every entry in a set is disabled', () => {
    const output = renderDelegateTargets({
      categories: { quick: { description: 'Trivial mechanical work.', guidance: 'Default.', disabled: true } },
      agents: { finder: { name: 'finder', description: 'Codebase search.', disabled: true } },
    })
    expect(output).toContain('No categories are currently enabled.')
    expect(output).toContain('No curated agents are currently enabled.')
    expect(output).not.toContain('quick')
    expect(output).not.toContain('finder')
  })

  it('renders an enabled set beside the fallback sentence of the empty one', () => {
    const output = renderDelegateTargets({ categories: {}, agents: AGENTS })
    expect(output).toContain('No categories are currently enabled.')
    expect(output).toContain('- finder — Codebase search.')
  })

  it('renders partial entries with placeholder text instead of throwing', () => {
    const output = renderDelegateTargets({
      categories: { bare: {}, partial: { description: 'Only a description.' } },
      agents: { hollow: {} },
    })
    expect(output).toContain('- bare — No description provided. Routing guidance: Not specified.')
    expect(output).toContain('- partial — Only a description. Routing guidance: Not specified.')
    expect(output).toContain('- hollow — No description provided.')
  })

  it('never returns a non-string or an empty string', () => {
    const inputs = [
      undefined,
      {},
      { categories: undefined, agents: undefined },
      { categories: {}, agents: {} },
      { categories: { quick: { disabled: true } }, agents: { finder: { disabled: true } } },
      { categories: { missing: null }, agents: { alsoMissing: undefined } },
    ]
    for (const input of inputs) {
      const output = renderDelegateTargets(input)
      expect(typeof output).toBe('string')
      expect(output.length).toBeGreaterThan(0)
    }
  })
})

describe('DELEGATE_DESCRIPTION (task 3.3)', () => {
  it('drops the false doctrine/diagnostics claim and points at the injected section', () => {
    expect(DELEGATE_DESCRIPTION).not.toContain("listed in the orchestration doctrine and this tool's runtime diagnostics")
    expect(DELEGATE_DESCRIPTION).not.toContain('runtime diagnostics')
    expect(DELEGATE_DESCRIPTION).toContain(DELEGATE_TARGETS_SECTION_NAME)
  })

  it('makes the one-target rule and the missing category default explicit', () => {
    expect(DELEGATE_DESCRIPTION).toContain('exactly one of category or agent')
    expect(DELEGATE_DESCRIPTION).toContain('no default')
    expect(DELEGATE_DESCRIPTION).toContain('a category name must always be supplied')
  })

  it('names the three current curated agents and none of the retired names', () => {
    expect(DELEGATE_DESCRIPTION).toContain('finder')
    expect(DELEGATE_DESCRIPTION).toContain('scholar')
    expect(DELEGATE_DESCRIPTION).toContain('advisor')
    expect(DELEGATE_DESCRIPTION).not.toContain('explore')
    expect(DELEGATE_DESCRIPTION).not.toContain('librarian')
    expect(DELEGATE_DESCRIPTION).not.toContain('oracle')
  })
})
