import { describe, expect, it } from './helpers.js'
import { readFileSync } from 'node:fs'

// Creative-preset guard (orrery-creative-preset change): the bundle patch
// declares a second preset `orrery-creative` ("Orrery 创造模式") that mirrors
// the full `orrery` composition and adds exactly four creative deltas
// (creative-guide prompt section, tool-cordis, plugin-manager enabled under a
// profile context, Cordis development skills via customSkillDirs +
// baselineScopes). Text scan like preset-realms.test.js (the patch has !!js
// tags); it pins the fused rows AND the row-level sync between the two
// presets so future edits to the `orrery` composition cannot silently drift
// from its creative copy.

const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/** The text block of one `- id: <rowId>` entry at the insert-list top level
 * (from its `- id:` line to the next sibling at the same indentation). */
function presetBlock(rowId) {
  const lines = PATCH.split('\n')
  const start = lines.findIndex((line) => line.trim() === `- id: ${rowId}`)
  if (start < 0) return undefined
  const indent = lines[start].search(/\S/)
  let end = start + 1
  while (end < lines.length && !(lines[end].search(/\S/) === indent && lines[end].trim().startsWith('- id:'))) end++
  return lines.slice(start, end).join('\n')
}

/** Ordered top-level `- id:` row sequence inside a preset's plugins list. */
function topLevelRowIds(block) {
  const lines = block.split('\n')
  const pluginsLine = lines.findIndex((line) => line.trim() === 'plugins:')
  const indent = lines[pluginsLine + 1].search(/\S/)
  const ids = []
  for (let i = pluginsLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    if (lines[i].search(/\S/) !== indent || !lines[i].trim().startsWith('- id:')) break
    ids.push(lines[i].trim().slice('- id:'.length).trim())
  }
  return ids
}

const orrery = presetBlock('preset-orrery')
const creative = presetBlock('preset-orrery-creative')

describe('orrery-creative preset declaration', () => {
  it('both preset rows exist with distinct ids, names and orders', () => {
    expect(orrery, 'preset-orrery row missing').toBeTruthy()
    expect(creative, 'preset-orrery-creative row missing').toBeTruthy()
    expect(creative).toContain('id: orrery-creative')
    expect(creative).toContain('name: Orrery 创造模式')
    expect(creative).toContain('order: 6')
    expect(orrery).not.toContain('id: orrery-creative')
  })

  it('creative delta 1: tool-cordis row is present', () => {
    expect(creative).toContain("- id: tool-cordis")
    expect(creative).toContain("name: '@deepseek-ai/dsh-tool-cordis'")
    expect(orrery).not.toContain('tool-cordis')
  })

  it('creative delta 2: plugin-manager uses the creative-mode enablement expression', () => {
    expect(creative).toContain(`disabled: !!js "!ctx.get('profileContext')"`)
    expect(orrery).toContain('disabled: true')
    expect(orrery).not.toContain(`!!js "!ctx.get('profileContext')"`)
  })

  it('creative delta 3: skill-selection mounts the Cordis development skills and admits them to the baseline', () => {
    expect(creative).toContain('customSkillDirs:')
    expect(creative).toContain(`resolve('@deepseek-ai/dsh-agent-preset/package.json')`)
    // Fail-safe fallback: an unresolvable package degrades to a nonexistent
    // path, never to a profile-load failure.
    expect(creative).toContain('catch')
    expect(creative).toContain('baselineScopes:')
    expect(creative).toContain('- custom')
    expect(orrery).not.toContain('baselineScopes')
    expect(orrery).not.toContain('customSkillDirs')
  })

  it('the two presets share the same row sequence except the creative-only insertions', () => {
    const shared = topLevelRowIds(orrery)
    const mirrored = topLevelRowIds(creative).filter((id) => id !== 'tool-cordis' && id !== 'creative-guide')
    expect(mirrored).toEqual(shared)
  })

  it('the creative-guide section row is creative-only', () => {
    expect(creative).toContain('- id: creative-guide')
    expect(creative).toContain("name: 'orrery-harness/creative-guide'")
    expect(orrery).not.toContain('creative-guide')
  })

  it('the shared groups keep identical isolate tables', () => {
    for (const service of ['orreryMcpGate', 'orreryMcpManager', 'planMode', 'compaction', 'toolResultPruner', 'workflowEngine', 'orreryEditLock', 'orreryWorktreeLanes']) {
      const marker = `${service}: true`
      expect(creative.includes(marker), `creative lost isolated service ${service}`).toBe(orrery.includes(marker))
    }
  })
})
