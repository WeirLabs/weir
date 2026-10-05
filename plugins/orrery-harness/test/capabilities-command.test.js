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
    skills: {
      registerProvider(create) { provider = create({ invalidate() {} }) },
      async list(options) { return (await provider.list(options)).candidates },
      // The Office adapter reads the host provider registry; an empty
      // dsh-office provider keeps the inventory complete without candidates.
      layers: { global: { providers: new Map([['dsh-office', { provider: { async list() { return { candidates: [], complete: true } } } }]]) } },
    },
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
  // Structured payloads travel as JSON text (dsh-commands normalizeResult
  // strips any value field).
  const receiptPayload = JSON.parse(receipt.text)
  expect(receiptPayload.status).toBe('applied')
  expect(Array.isArray(receiptPayload.effective.skills)).toBe(true)
  expect(Array.isArray(receiptPayload.effective.mcpServers)).toBe(true)
  // Regression (2026-10-05 GUI badge "0 skills · 0 MCP"): the provider's
  // candidates ARE the effective selection — a fresh root session resolves
  // the builtin baseline (6.5), so the receipt must name those skills, not
  // filter them away on a `selected` flag the contract never carried.
  expect(receiptPayload.warnings).toEqual([])
  expect(receiptPayload.effective.skills).toHaveLength(10)
  expect(receiptPayload.effective.skills).toContain('debugging')
  const listing = await command.handler({ agent, rawInput: 'list' })
  expect(listing.kind).toBe('success')
  const listingPayload = JSON.parse(listing.text)
  expect(Array.isArray(listingPayload.skills)).toBe(true)
  expect(Array.isArray(listingPayload.mcpServers)).toBe(true)
  // Manager rows: the 10 baseline skills are selected; the 3 Office denial
  // placeholders list as unselected.
  expect(listingPayload.skills.filter(row => row.selected === true)).toHaveLength(10)
  expect(listingPayload.skills.filter(row => row.selected !== true)).toHaveLength(3)
})
