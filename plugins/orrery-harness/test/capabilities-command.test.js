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
  // Hermetic roots: the plugin resolves agentsHome from DSH_AGENTS_HOME.
  const previousAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = mkdtempSync(join(tmpdir(), 'orrery-cmd-agents-'))
  try {
  const root = mkdtempSync(join(tmpdir(), 'orrery-cmd-'))
  let registeredCommands = []
  let provider
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const officeRoot = join(root, 'office')
  const officeCandidates = []
  for (const name of ['office-docx', 'office-pptx', 'office-xlsx']) {
    mkdirSync(join(officeRoot, name), { recursive: true })
    const locator = join(officeRoot, name, 'SKILL.md')
    writeFileSync(locator, `---\nname: ${name}\ndescription: office fixture\n---\n${name}\n`)
    officeCandidates.push({ name, provider: 'dsh-office', source: 'bundled', locator, description: 'office fixture' })
  }
  const officeProvider = {
    async list() { return officeCandidates },
    get() { return 'OFFICE_CONTENT' },
  }
  const ctx = {
    skills: {
      registerProvider(create) { provider = create({ invalidate() {} }) },
      async list(options) { return (await provider.list(options)).candidates },
      // The Office adapter reads the host provider registry; the stub yields
      // the three office candidates (parsed, unselected) like the real
      // composition.
      layers: { global: { providers: new Map([['dsh-office', { provider: officeProvider }]]) } },
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
  } finally {
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
  }
})

test('/capabilities apply commits through the shared engine and the receipt reflects it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orrery-cmd-apply-'))
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(root, 'skills', 'alpha'), { recursive: true })
  writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: apply fixture\n---\nALPHA\n')
  let registeredCommands = []
  let provider
  const ctx = {
    skills: {
      registerProvider(create) { provider = create({ invalidate() {} }) },
      async list(options) { return (await provider.list(options)).candidates },
      // The Office adapter reads the layers registry; no dsh-office provider
      // is composed in these mounts, so get() returns undefined (no candidates).
      layers: { global: { providers: new Map() } },
    },
    on() {},
    effect(fn) { fn(); return () => {} },
    emit(...args) { emitted.push(args) },
    logger: { warn() {} },
    get(name) {
      if (name === 'profileContext') return { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  const emitted = []
  createSkillSelectionPlugin()(ctx, { machineId: 'orrery-it-machine', includeDefaultRoots: false, customSkillDirs: [join(root, 'skills')] })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  const agent = { id: 'sess-apply', session: { id: 'sess-apply', header: { cwd: root } } }

  const applied = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-1', expectedRevision: 0, skills: ['alpha'], mcpServers: [] })}` })
  expect(applied.kind).toBe('success')
  const response = JSON.parse(applied.text)
  expect(response.status).toBe('applied')

  const receipt = await command.handler({ agent, rawInput: 'receipt' })
  const payload = JSON.parse(receipt.text)
  expect(payload.effective.skills).toEqual(['alpha'])
  expect(payload.revision).toBe(1)

  // An unknown name is a visible error, never silently dropped.
  const missing = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-2', expectedRevision: 1, skills: ['ghost'], mcpServers: [] })}` })
  expect(missing.kind).toBe('error')
  expect(JSON.parse(missing.text).missing).toEqual(['ghost'])

  // The Apply-path convergence emission (5.2 parity): an accepted Apply
  // re-emits the preset invalidation event so connected clients refetch.
  expect(emitted).toEqual([['agent-preset/selected', 'sess-apply', 'orrery']])
})

test('/capabilities list shows the FULL inventory with selection marks (user-global/workspace skills visible)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orrery-cmd-list-'))
  const { mkdirSync, writeFileSync } = await import('node:fs')
  for (const name of ['picked', 'unpicked']) {
    mkdirSync(join(root, 'skills', name), { recursive: true })
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: list fixture ${name}\n---\n${name}\n`)
  }
  let registeredCommands = []
  let provider
  const ctx = {
    skills: {
      registerProvider(create) { provider = create({ invalidate() {} }) },
      async list(options) { return (await provider.list(options)).candidates },
      layers: { global: { providers: new Map() } },
    },
    on() {},
    effect(fn) { fn(); return () => {} },
    emit(...args) { emitted.push(args) },
    logger: { warn() {} },
    get(name) {
      if (name === 'profileContext') return { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  const emitted = []
  createSkillSelectionPlugin()(ctx, { machineId: 'orrery-it-machine', includeDefaultRoots: false, customSkillDirs: [join(root, 'skills')] })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  const agent = { id: 'sess-list', session: { id: 'sess-list', header: { cwd: root } } }
  // Apply one of the two; the OTHER must stay visible with selected:false.
  await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-1', expectedRevision: 0, skills: ['picked'], mcpServers: [] })}` })
  const listing = await command.handler({ agent, rawInput: 'list' })
  expect(listing.kind).toBe('success')
  const payload = JSON.parse(listing.text)
  const byName = Object.fromEntries(payload.skills.map(row => [row.name, row]))
  expect(byName.picked?.selected).toBe(true)
  expect(byName.unpicked?.selected).toBe(false)
})

test('/capabilities list under a failed selection view keeps inventory fidelity and carries the error state (D3)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orrery-cmd-blocked-'))
  const { mkdirSync, writeFileSync } = await import('node:fs')
  for (const name of ['picked', 'unpicked']) {
    mkdirSync(join(root, 'skills', name), { recursive: true })
    writeFileSync(join(root, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: blocked fixture ${name}\n---\n${name}\n`)
  }
  let registeredCommands = []
  let provider
  const ctx = {
    skills: {
      registerProvider(create) { provider = create({ invalidate() {} }) },
      async list(options) { return (await provider.list(options)).candidates },
      layers: { global: { providers: new Map() } },
    },
    on() {},
    effect(fn) { fn(); return () => {} },
    logger: { warn() {} },
    get(name) {
      // A distinct profile home: the user-dsh root must not coincide with the custom skill dir (double discovery).
      if (name === 'profileContext') return { home: join(root, 'profile'), name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  // The selection view fails closed (the 2026-10-05 incarnation shape: the
  // inherited snapshot is absent and the read side demands it).
  createSkillSelectionPlugin({
    readSelection: async () => { throw new Error('Inherited skill snapshot is absent') },
  })(ctx, { machineId: 'orrery-it-machine', includeDefaultRoots: false, customSkillDirs: [join(root, 'skills')] })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  const agent = { id: 'sess-blocked', session: { id: 'sess-blocked', header: { cwd: root } } }

  const listing = await command.handler({ agent, rawInput: 'list' })
  expect(listing.kind).toBe('success')
  const payload = JSON.parse(listing.text)
  // Full raw inventory with real scope labels — never the 'unknown'/'other'
  // degradation — and every selection mark false.
  const names = payload.skills.map(row => row.name)
  expect(names).toContain('picked')
  expect(names).toContain('unpicked')
  expect(names).toContain('debugging') // the Orrery builtin root still lists
  expect(payload.skills.every(row => row.selected === false)).toBe(true)
  expect(payload.skills.every(row => row.scope !== 'unknown')).toBe(true)
  const byName = Object.fromEntries(payload.skills.map(row => [row.name, row]))
  expect(byName.picked.scope).toBe('custom')
  expect(byName.debugging.scope).toBe('orrery-builtin')
  // The error state rides along, distinguishable from a successful empty
  // inventory (which carries no selectionError at all).
  expect(payload.selectionError?.reason).toBe('inherited-snapshot-unavailable')
  expect(payload.selectionError?.hint).toContain('Capabilities panel')
  expect(payload.selectionError?.hint).toContain('Apply')
  expect(payload.selectionError?.error).toContain('Inherited skill snapshot is absent')
  expect(Array.isArray(payload.mcpServers)).toBe(true)

  // Apply heals from the degraded listing: the accepted record frees the
  // session from the inheritance dependency, and the next listing is the
  // healthy byte-shape again (no selectionError, real selection marks).
  const applied = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-1', expectedRevision: 0, skills: ['picked'], mcpServers: [] })}` })
  expect(applied.kind).toBe('success')
  expect(JSON.parse(applied.text).status).toBe('applied')
  const healed = JSON.parse((await command.handler({ agent, rawInput: 'list' })).text)
  expect(healed.selectionError).toBeUndefined()
  const healedByName = Object.fromEntries(healed.skills.map(row => [row.name, row]))
  expect(healedByName.picked?.selected).toBe(true)
  expect(healedByName.unpicked?.selected).toBe(false)
})

test('/capabilities mcp-add registers a stdio server into the Orrery registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orrery-cmd-mcp-'))
  let registeredCommands = []
  let provider
  const ctx = {
    skills: {
      registerProvider(create) { provider = create({ invalidate() {} }) },
      async list(options) { return (await provider.list(options)).candidates },
      layers: { global: { providers: new Map() } },
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
  const agent = { id: 'sess-mcp', session: { id: 'sess-mcp', header: { cwd: root } } }
  const added = await command.handler({ agent, rawInput: `mcp-add ${JSON.stringify({ identity: 'my-docs', label: 'My Docs', command: 'npx', args: ['-y', '@org/docs-mcp'] })}` })
  expect(added.kind).toBe('success')
  const result = JSON.parse(added.text)
  expect(result.status).toBe('registered')
  expect(result.identity).toBe('my-docs')
  expect(result.generation).toBe(1)
  // The entry is durably in the registry with the client config verbatim.
  const { openCapabilityStore } = await import('../src/capabilities/store/store.js')
  const { createMcpRegistry } = await import('../src/capabilities/mcp-registry.js')
  const registry = createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' } }) })
  const record = await registry.read()
  expect(record.kind).toBe('ok')
  const entry = record.servers['my-docs']
  expect(entry.label).toBe('My Docs')
  expect(entry.client.command).toBe('npx')
  expect(entry.client.args).toEqual(['-y', '@org/docs-mcp'])
  expect(entry.client.serverName).toBe('my-docs')
  expect(entry.owner).toEqual({ kind: 'global', key: 'installation' })
  // Malformed payloads are visible errors, never partial writes.
  const bad = await command.handler({ agent, rawInput: 'mcp-add {"identity":"x"}' })
  expect(bad.kind).toBe('error')
})
