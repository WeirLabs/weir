import { describe, expect, it } from './helpers.js'
import { readFileSync } from 'node:fs'

// Realm guard (S11 class, edit-lock acceptance incident): the preset registry
// refuses a preset whose rows publish a service into the root realm
// ("Preset services require isolate realms: orreryEditLock"). The provider row
// and every consumer row must sit in ONE cordis:group that isolates the
// service. Text scan like settings-fields.test.js (the patch has !!js tags).

const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const SERVICE = 'orreryEditLock'
const PROVIDER = 'orrery-harness/edit-lock'
const CONSUMERS = ['orrery-harness/todo-driver', 'orrery-harness/hashline-edit', 'orrery-harness/lsp']

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
    expect(at(PROVIDER) < at('orrery-harness/hashline-edit')).toBe(true)
    expect(at(PROVIDER) < at('orrery-harness/lsp')).toBe(true)
  })
})

describe('preset realm composition for the worktree lanes service', () => {
  it('worktree (provider) and delegate (consumer) share the group that isolates orreryWorktreeLanes', () => {
    const group = enclosingGroup('orrery-harness/worktree')
    expect(group, 'worktree row must be inside a cordis:group').toBeTruthy()
    expect(group.id).toBe('delegation')
    expect(/isolate:[\s\S]*?\n\s+orreryWorktreeLanes: true/.test(group.text), 'delegation must isolate orreryWorktreeLanes').toBe(true)
    expect(enclosingGroup('orrery-harness/delegate')?.id).toBe(group.id)
    expect(PATCH.indexOf("name: 'orrery-harness/worktree'") < PATCH.indexOf("name: 'orrery-harness/delegate'")).toBe(true)
  })
})

describe('preset realm composition for the MCP manager services', () => {
  it('mcp-manager (provider) and skill-selection (consumer) share one group isolating both services', () => {
    const group = enclosingGroup('orrery-harness/mcp-manager')
    expect(group, 'mcp-manager row must be inside a cordis:group').toBeTruthy()
    expect(group.text).toContain('name: cordis:group')
    for (const service of ['orreryMcpGate', 'orreryMcpManager']) {
      expect(new RegExp(`isolate:[\\s\\S]*?\\n\\s+${service}: true`).test(group.text), `group ${group.id} must isolate ${service}`).toBe(true)
    }
    expect(enclosingGroup('orrery-harness/skill-selection')?.id, 'skill-selection must share the MCP services realm').toBe(group.id)
  })

  it('skill-selection precedes mcp-manager (the manager reads its process face at mount)', () => {
    expect(PATCH.indexOf("name: 'orrery-harness/skill-selection'") < PATCH.indexOf("name: 'orrery-harness/mcp-manager'")).toBe(true)
  })
})
