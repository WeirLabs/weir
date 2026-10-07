import { describe, expect, it } from './helpers.js'
import { baselineSkillIdentities } from '../src/capabilities/initial-selection.js'

// Unit tests for the row-configurable initial skill baseline scopes
// (weir-creative-preset change): the default stays builtin-only (the
// historical weir behavior), while ['weir-builtin', 'custom'] admits the
// creative preset's fused development skills. Unparsed candidates and
// non-listed scopes (project/user) never qualify.

const candidate = (scope, status = 'parsed') => ({
  status,
  identity: { scope, name: `skill-${scope}` },
})

describe('baselineSkillIdentities', () => {
  it('defaults to the builtin-only baseline (identical to the historical filter)', () => {
    const candidates = [candidate('weir-builtin'), candidate('custom'), candidate('project-dsh'), candidate('user-dsh')]
    expect(baselineSkillIdentities(candidates).map(i => i.scope)).toEqual(['weir-builtin'])
  })

  it('admits custom-scoped candidates when the row lists them', () => {
    const candidates = [candidate('weir-builtin'), candidate('custom'), candidate('user-agents')]
    expect(baselineSkillIdentities(candidates, ['weir-builtin', 'custom']).map(i => i.scope)).toEqual(['weir-builtin', 'custom'])
  })

  it('never admits unparsed candidates', () => {
    const candidates = [{ status: 'unparsed', identity: undefined }, candidate('weir-builtin', 'unparsed')]
    expect(baselineSkillIdentities(candidates)).toEqual([])
  })

  it('tolerates missing and malformed input', () => {
    expect(baselineSkillIdentities(undefined)).toEqual([])
    expect(baselineSkillIdentities(null)).toEqual([])
    expect(baselineSkillIdentities([null, 42, {}])).toEqual([])
  })
})
