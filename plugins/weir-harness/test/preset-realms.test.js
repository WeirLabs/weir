import { describe, expect, it } from './helpers.js'
import { readFileSync } from 'node:fs'

// Realm guard (S11 class, edit-lock acceptance incident): the preset registry
// refuses a preset whose rows publish a service into the root realm
// ("Preset services require isolate realms: weirEditLock"). The provider row
// and every consumer row must sit in ONE cordis:group that isolates the
// service. Text scan like settings-fields.test.js (the patch has !!js tags).

const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const SERVICE = 'weirEditLock'
const PROVIDER = 'weir-harness/edit-lock'
const CONSUMERS = ['weir-harness/todo-driver', 'weir-harness/hashline-edit', 'weir-harness/lsp']

/** The enclosing group block (from its `- id:` line to the next sibling at
 * the same indentation) for the row naming `pluginName`. */
function enclosingGroup(pluginName) {
  const lines = PATCH.split('\n')
  const row = lines.findIndex((line) => line.trim() === `name: '${pluginName}'`)
  if (row < 0) return undefined
  const rowIndent = lines[row - 1].search(/\S/)
  for (let start = row - 1; start >= 0; start--) {
    const indent = lines[start].search(/\S/)
    if (indent >= 0 && indent < rowIndent && lines[start].trim().startsWith('- id:')) {
      let end = start + 1
      while (end < lines.length && !(lines[end].search(/\S/) === indent && lines[end].trim().startsWith('- id:'))) end++
      return { id: lines[start].trim().slice('- id:'.length).trim(), text: lines.slice(start, end).join('\n') }
    }
  }
  return undefined
}

describe('preset realm composition for the Edit Lock service', () => {
  it('provider and every consumer share one group that isolates the service', () => {
    const group = enclosingGroup(PROVIDER)
    expect(group, 'edit-lock row must be inside a cordis:group').toBeTruthy()
    expect(group.id).toBe('delegation')
    expect(group.text).toContain('name: cordis:group')
    expect(new RegExp(`isolate:[\\s\\S]*?\\n\\s+${SERVICE}: true`).test(group.text), `group ${group.id} must isolate ${SERVICE}`).toBe(true)
    for (const consumer of CONSUMERS) {
      expect(enclosingGroup(consumer)?.id, `${consumer} must share the ${SERVICE} realm`).toBe(group.id)
    }
  })

  it('the provider row precedes its mount-time consumers', () => {
    const at = (name) => PATCH.indexOf(`name: '${name}'`)
    expect(at(PROVIDER) < at('weir-harness/hashline-edit')).toBe(true)
    expect(at(PROVIDER) < at('weir-harness/lsp')).toBe(true)
  })
})

describe('preset realm composition for the worktree lanes service', () => {
  it('worktree (provider) and delegate (consumer) share the group that isolates weirWorktreeLanes', () => {
    const group = enclosingGroup('weir-harness/worktree')
    expect(group, 'worktree row must be inside a cordis:group').toBeTruthy()
    expect(group.id).toBe('delegation')
    expect(/isolate:[\s\S]*?\n\s+weirWorktreeLanes: true/.test(group.text), 'delegation must isolate weirWorktreeLanes').toBe(true)
    expect(enclosingGroup('weir-harness/delegate')?.id).toBe(group.id)
    expect(PATCH.indexOf("name: 'weir-harness/worktree'") < PATCH.indexOf("name: 'weir-harness/delegate'")).toBe(true)
  })
})

describe('preset skill supplemental directories (preset-skill-applicability)', () => {
  it('BOTH skill-selection rows declare the same supplementalSkillDirs root for apply-missing classification', () => {
    const rows = PATCH.split(/\n(?=\s*- id: weir-skill-selection)/).filter(chunk => chunk.includes("name: 'weir-harness/skill-selection'"))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.includes('supplementalSkillDirs:'), 'every skill-selection row must carry the classification root').toBe(true)
      expect(row.includes('@deepseek-ai/dsh-agent-preset/package.json'), 'the classification root resolves the creative skills package').toBe(true)
    }
  })
})

describe('preset realm composition for the MCP manager services', () => {
  it('mcp-manager (provider) and skill-selection (consumer) share one group isolating both services', () => {
    const group = enclosingGroup('weir-harness/mcp-manager')
    expect(group, 'mcp-manager row must be inside a cordis:group').toBeTruthy()
    expect(group.text).toContain('name: cordis:group')
    for (const service of ['weirMcpGate', 'weirMcpManager']) {
      expect(new RegExp(`isolate:[\\s\\S]*?\\n\\s+${service}: true`).test(group.text), `group ${group.id} must isolate ${service}`).toBe(true)
    }
    expect(enclosingGroup('weir-harness/skill-selection')?.id, 'skill-selection must share the MCP services realm').toBe(group.id)
  })

  it('skill-selection precedes mcp-manager (the manager reads its process face at mount)', () => {
    expect(PATCH.indexOf("name: 'weir-harness/skill-selection'") < PATCH.indexOf("name: 'weir-harness/mcp-manager'")).toBe(true)
  })
})

describe('host-layer composition for the blackboard panel remote', () => {
  it('the remote row sits in the top-level insert list beside the capability remote', () => {
    // Same S27 constraint as the capability read remote: the typert gateway
    // resolves the service from the host root. A missing row is a silent
    // production 404 the test-harness mirror cannot catch (slice-2 incident:
    // the mirror had the row, the production patch did not).
    const row = PATCH.indexOf("name: 'weir-harness/blackboard-remote'")
    expect(row >= 0, 'cordis.patch.yml must mount weir-harness/blackboard-remote').toBe(true)
    expect(row > PATCH.indexOf('- id: weir-notify')).toBe(true)
    expect(row < PATCH.indexOf('- id: preset-weir')).toBe(true)
    expect(row < PATCH.indexOf('- id: preset-weir-creative')).toBe(true)
  })
})

describe('host-layer composition for the capability read remote', () => {
  it('the remote row sits in the top-level insert list, sibling of weir-notify and before every preset row', () => {
    // The typert gateway resolves the service from the host root, so a
    // preset-realm row could never be dispatched (S27, silent-capability-
    // reads). This pins the row's host-layer placement.
    const row = PATCH.indexOf("name: 'weir-harness/capability-remote'")
    expect(row >= 0, 'cordis.patch.yml must mount weir-harness/capability-remote').toBe(true)
    expect(row > PATCH.indexOf('- id: weir-notify')).toBe(true)
    expect(row < PATCH.indexOf('- id: preset-weir')).toBe(true)
    expect(row < PATCH.indexOf('- id: preset-weir-creative')).toBe(true)
  })
})
