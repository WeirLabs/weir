// Regression for the /capabilities command handler (group 12 client surface):
// provider.list returns { candidates, complete }, never a bare array — the
// receipt and listing verbs must unwrap it (candidates.filter is not a
// function was the user-visible failure).
import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

test('/capabilities receipt and list unwrap provider.list candidates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orrery-cmd-'))
  let registeredCommands = []
  let provider
  const ctx = {
    skills: { registerProvider(create) { provider = create({ invalidate() {} }) }, async list(options) { return (await provider.list(options)).candidates } },
    on() {},
    effect(fn) { fn(); return () => {} },
    logger: { warn() {} },
    get(name) {
      if (name === 'profileContext') return { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  createSkillSelectionPlugin()(ctx, { machineId: 'orrery-it-machine', includeDefaultRoots: false, customSkillDirs: [] })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  expect(typeof command?.handler).toBe('function')
  const agent = { id: 'sess-1', session: { id: 'sess-1', header: { cwd: root } } }
  const receipt = await command.handler({ agent, rawInput: 'receipt' })
  expect(receipt.kind).toBe('success')
  expect(Array.isArray(receipt.value.effective.skills)).toBe(true)
  expect(Array.isArray(receipt.value.effective.mcpServers)).toBe(true)
  const listing = await command.handler({ agent, rawInput: 'list' })
  expect(listing.kind).toBe('success')
  expect(Array.isArray(listing.value.skills)).toBe(true)
  expect(Array.isArray(listing.value.mcpServers)).toBe(true)
})
