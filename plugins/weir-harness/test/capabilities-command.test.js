// Regression for the /capabilities command handler (group 12 client surface):
// provider.list returns { candidates, complete }, never a bare array — the
// receipt and listing verbs must unwrap it (candidates.filter is not a
// function was the user-visible failure).
import { test, expect, storePlatformSkip, pinHermeticHostRoots } from './helpers.js'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

// The store-backed command surface (receipt/list/apply/mcp-add) persists
// through the Weir capability store, whose platform matrix (C-1.10) enables
// writes only on darwin — on any other host the store fails closed as
// `unsupported` by design and these verbs cannot meet their contract. Host-
// contract skip, same pattern as the DSH-runtime skip in worktree-pkgmgr.test.js.
const skip = storePlatformSkip

test('/capabilities receipt and list unwrap provider.list candidates', { skip }, async () => {
  // Hermetic roots: the provider resolves agentsHome from DSH_AGENTS_HOME
  // (then homedir().agents) and dshHome from profileContext.home — pin every
  // host-dependent root to fresh mkdtemp dirs so user-global/workspace skills
  // on the dev machine never leak into the candidate counts.
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-'))
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
    createSkillSelectionPlugin()(ctx, {
      machineId: 'weir-it-machine',
      includeDefaultRoots: false,
      customSkillDirs: [],
      // Explicit hermetic roots (belt and braces over the env pinning above).
      agentsHome: host.agentsHome,
      dshHome: root,
    })
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
    host.restore()
  }
})

test('/capabilities apply commits through the shared engine and the receipt reflects it', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-apply-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(root, 'custom-skills', 'alpha'), { recursive: true })
    writeFileSync(join(root, 'custom-skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: apply fixture\n---\nALPHA\n')
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
    // A profile-supplemental directory (preset-skill-applicability D2): holds
    // skills known to the profile but NOT enumerated into this preset.
    mkdirSync(join(root, 'supplemental', 'creative-only'), { recursive: true })
    writeFileSync(join(root, 'supplemental', 'creative-only', 'SKILL.md'), '---\nname: creative-only\ndescription: supplemental fixture\n---\nCREATIVE\n')
    createSkillSelectionPlugin()(ctx, {
      machineId: 'weir-it-machine',
      includeDefaultRoots: false,
      customSkillDirs: [join(root, 'custom-skills')],
      supplementalSkillDirs: [join(root, 'supplemental')],
      agentsHome: host.agentsHome,
      dshHome: root,
    })
    const command = registeredCommands.find(entry => entry.name === 'capabilities')
    const agent = { id: 'sess-apply', session: { id: 'sess-apply', header: { cwd: root } } }

    const alphaIdentity = JSON.parse((await command.handler({ agent, rawInput: 'list' })).text).skills.find(row => row.name === 'alpha').identity
    const applied = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-1', expectedRevision: 0, skills: ['alpha', alphaIdentity], mcpServers: [] })}` })
    expect(applied.kind).toBe('success')
    const response = JSON.parse(applied.text)
    expect(response.status).toBe('applied')

    const receipt = await command.handler({ agent, rawInput: 'receipt' })
    const payload = JSON.parse(receipt.text)
    expect(payload.effective.skills).toEqual(['alpha'])
    expect(payload.effective.skillIdentities.map(identity => identity.name)).toEqual(payload.effective.skills)
    expect(payload.revision).toBe(1)


    // An unknown name is a visible error, never silently dropped.
    const missing = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-2', expectedRevision: 1, skills: ['ghost'], mcpServers: [] })}` })
    expect(missing.kind).toBe('error')
    expect(JSON.parse(missing.text).missing).toEqual(['ghost'])

    // The Apply-path convergence emission (5.2 parity): an accepted Apply
    // re-emits the preset invalidation event so connected clients refetch.
    expect(emitted.filter(entry => entry[0] === 'agent-preset/selected')).toEqual([['agent-preset/selected', 'sess-apply', 'weir']])

    // preset-skill-applicability (D2 partition): a known-but-inapplicable name
    // is SKIPPED with a reason while the resolvable remainder commits — and the
    // record keeps only the applied identities (skipped is never written).
    const partitioned = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-3', expectedRevision: 1, skills: ['alpha', 'creative-only'], mcpServers: [] })}` })
    expect(partitioned.kind).toBe('success')
    const partitionedResponse = JSON.parse(partitioned.text)
    expect(partitionedResponse.status).toBe('applied')
    expect(partitionedResponse.skipped).toEqual([{ name: 'creative-only', reason: 'not applicable in this agent preset' }])
    const afterPartition = JSON.parse((await command.handler({ agent, rawInput: 'receipt' })).text)
    expect(afterPartition.effective.skills).toEqual(['alpha'])

    // A genuinely unknown name still hard-fails with the draft preserved; a
    // skipped entry found alongside it is reported too.
    const hardFail = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-4', expectedRevision: 2, skills: ['ghost', 'creative-only'], mcpServers: [] })}` })
    expect(hardFail.kind).toBe('error')
    const hardFailPayload = JSON.parse(hardFail.text)
    expect(hardFailPayload.status).toBe('missing')
    expect(hardFailPayload.missing).toEqual(['ghost'])
    expect(hardFailPayload.skipped).toEqual([{ name: 'creative-only', reason: 'not applicable in this agent preset' }])

    // A second root holds the same parsed name: name-only Apply must not pick
    // the last enumerated row. Exact identity Apply still chooses either row.
    mkdirSync(join(host.agentsHome, 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(host.agentsHome, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: second alpha\n---\nSECOND\n')
    const listing = JSON.parse((await command.handler({ agent, rawInput: 'list' })).text)
    const alphas = listing.skills.filter(row => row.name === 'alpha')
    expect(alphas).toHaveLength(2)
    expect(Object.keys(alphas[0]).at(-1)).toBe('identity')
    const ambiguous = JSON.parse((await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'ambiguous', expectedRevision: 2, skills: ['alpha'] })}` })).text)
    expect(ambiguous.status).toBe('missing')
    expect(ambiguous.missing).toEqual(['alpha'])
    const absentIdentity = { ...alphas[0].identity, root: '/not-in-inventory' }
    const absent = JSON.parse((await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'absent-identity', expectedRevision: 2, skills: [absentIdentity] })}` })).text)
    expect(absent).toEqual({ status: 'missing', missing: ['alpha'] })
    for (const [index, row] of alphas.entries()) {
      const exact = JSON.parse((await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: `exact-${index}`, expectedRevision: 2 + index, skills: [row.identity, row.identity] })}` })).text)
      expect(exact.status).toBe('applied')
      const receipt = JSON.parse((await command.handler({ agent, rawInput: 'receipt' })).text)
      expect(receipt.effective.skills).toEqual(['alpha'])
      expect(receipt.effective.skillIdentities).toEqual([row.identity])
    }
  } finally {
    host.restore()
  }
})

test('/capabilities list shows the FULL inventory with selection marks (user-global/workspace skills visible)', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-list-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    for (const name of ['picked', 'unpicked']) {
      mkdirSync(join(root, 'custom-skills', name), { recursive: true })
      writeFileSync(join(root, 'custom-skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: list fixture ${name}\n---\n${name}\n`)
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
    // A profile-supplemental directory (preset-skill-applicability D2): holds
    // skills known to the profile but NOT enumerated into this preset.
    mkdirSync(join(root, 'supplemental', 'creative-only'), { recursive: true })
    writeFileSync(join(root, 'supplemental', 'creative-only', 'SKILL.md'), '---\nname: creative-only\ndescription: supplemental fixture\n---\nCREATIVE\n')
    createSkillSelectionPlugin()(ctx, {
      machineId: 'weir-it-machine',
      includeDefaultRoots: false,
      customSkillDirs: [join(root, 'custom-skills')],
      supplementalSkillDirs: [join(root, 'supplemental')],
      agentsHome: host.agentsHome,
      dshHome: root,
    })
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
  } finally {
    host.restore()
  }
})

test('/capabilities list under a failed selection view keeps inventory fidelity and carries the error state (D3)', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-blocked-'))
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
    })(ctx, {
      machineId: 'weir-it-machine',
      includeDefaultRoots: false,
      customSkillDirs: [join(root, 'skills')],
      agentsHome: host.agentsHome,
      dshHome: join(root, 'profile'),
    })
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
    expect(names).toContain('debugging') // the Weir builtin root still lists
    expect(payload.skills.every(row => row.selected === false)).toBe(true)
    expect(payload.skills.every(row => row.scope !== 'unknown')).toBe(true)
    const byName = Object.fromEntries(payload.skills.map(row => [row.name, row]))
    expect(byName.picked.scope).toBe('custom')
    expect(byName.picked.identity.scope).toBe('custom')
    expect(byName.debugging.scope).toBe('weir-builtin')
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
  } finally {
    host.restore()
  }
})

test('/capabilities mcp-add registers a stdio server into the Weir registry', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-mcp-'))
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
    createSkillSelectionPlugin()(ctx, {
      machineId: 'weir-it-machine',
      includeDefaultRoots: false,
      customSkillDirs: [],
      agentsHome: host.agentsHome,
      dshHome: root,
    })
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
    // Direct store open pins the supported platform row (suite convention,
    // capability-store.test.js); the verb itself runs on the plugin's store.
    const registry = createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' }, platform: 'darwin' }) })
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
  } finally {
    host.restore()
  }
})

test('/capabilities apply wires the manager drain: a removal reports the real in-flight count (D3)', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-drain-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(root, 'custom-skills', 'alpha'), { recursive: true })
    writeFileSync(join(root, 'custom-skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: drain fixture\n---\nALPHA\n')
    // The manager face with the REAL (agent, server)-keyed drain — the
    // production wiring resolves ctx.get('weirMcpManager').drain lazily.
    const { createMcpDrain } = await import('../src/capabilities/mcp-drain.js')
    const managerDrain = createMcpDrain()
    let starts = 0
    const manager = { drain: managerDrain, start: async () => { starts += 1 } }
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
        if (name === 'weirMcpManager') return manager
        return undefined
      },
    }
    createSkillSelectionPlugin()(ctx, {
      machineId: 'weir-it-machine',
      includeDefaultRoots: false,
      customSkillDirs: [join(root, 'custom-skills')],
      agentsHome: host.agentsHome,
      dshHome: root,
    })
    const command = registeredCommands.find(entry => entry.name === 'capabilities')
    const agent = { id: 'sess-drain', session: { id: 'sess-drain', header: { cwd: root } } }

    // The session accepts the managed server, then has a call in flight on it
    // (the manager drain's enter/exit is the handoff ledger, mcp-admission).
    const accepted = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-1', expectedRevision: 0, skills: ['alpha'], mcpServers: ['docs'] })}` })
    expect(JSON.parse(accepted.text).status).toBe('applied')
    const token = managerDrain.enter('sess-drain', 'docs', 'slow-call')
    expect(token).not.toBeNull()

    // The removal's draining snapshot reports the REAL in-flight count — not
    // the pre-fix constant settled/0 of the engine's private coordinator.
    const removed = await command.handler({ agent, rawInput: `apply ${JSON.stringify({ requestId: 'r-2', expectedRevision: 1, skills: ['alpha'], mcpServers: [] })}` })
    const response = JSON.parse(removed.text)
    expect(response.status).toBe('applied')
    expect(response.draining).toEqual([{ server: 'docs', state: 'draining', inFlight: 1 }])
    // The accepted removal closed this session's gate on the manager drain.
    expect(managerDrain.isClosed('sess-drain', 'docs')).toBe(true)
    expect(managerDrain.enter('sess-drain', 'docs', 'late-call')).toBeNull()
    managerDrain.exit('sess-drain', 'docs', token)
  } finally {
    host.restore()
  }
})

test('/capabilities receipt on a cold fork reports the inherited sets with an accepted revision of 0', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-fork-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(root, 'custom-skills', 'alpha'), { recursive: true })
    writeFileSync(join(root, 'custom-skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: fork fixture\n---\nALPHA\n')
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
    createSkillSelectionPlugin()(ctx, {
      machineId: 'weir-it-machine',
      customSkillDirs: [join(root, 'custom-skills')],
      agentsHome: host.agentsHome,
      dshHome: root,
    })
    const command = registeredCommands.find(entry => entry.name === 'capabilities')
    // A separate session resolves the fixture identity; the fork itself never
    // resolves an initial set here, so its effective state is the inheritance.
    const seedAgent = { id: 'sess-fork-seed', session: { id: 'sess-fork-seed', header: { cwd: root } } }
    const alphaIdentity = JSON.parse((await command.handler({ agent: seedAgent, rawInput: 'list' })).text).skills.find(row => row.name === 'alpha').identity
    const forkAgent = { id: 'sess-fork', session: { id: 'sess-fork', header: { cwd: root, delegationDepth: 0, parentSession: 'sess-parent' } } }
    // Exactly what a depth-0 capture writes (origin inherited + lineage metadata).
    const { openCapabilityStore } = await import('../src/capabilities/store/store.js')
    await openCapabilityStore({ profileContext: { home: root, name: 'it' }, platform: 'darwin' })
      .commit({ kind: 'inherited', sessionId: 'sess-fork' }, 0, () => ({
        skills: [alphaIdentity], mcpServers: ['docs'], origin: 'inherited', parent: { sessionId: 'sess-parent', revision: 3 }, capturedAt: 1,
      }))

    const receipt = JSON.parse((await command.handler({ agent: forkAgent, rawInput: 'receipt' })).text)
    expect(receipt.status).toBe('applied')
    expect(receipt.warnings).toEqual([])
    // The inherited unit's revision is lineage metadata, never the accepted CAS
    // token: a first explicit Apply on the fork must submit expectedRevision 0.
    expect(receipt.revision).toBe(0)
    expect(receipt.effective.skills).toEqual(['alpha'])
    expect(receipt.effective.mcpServers).toEqual(['docs'])
    const listing = JSON.parse((await command.handler({ agent: forkAgent, rawInput: 'list' })).text)
    expect(listing.skills.find(row => row.name === 'alpha')?.selected).toBe(true)
    // Manager/lifecycle/catalog agree, so the first Apply is a normal revision-0 commit.
    const applied = JSON.parse((await command.handler({
      agent: forkAgent,
      rawInput: `apply ${JSON.stringify({ requestId: 'fork-apply', expectedRevision: 0, skills: [alphaIdentity], mcpServers: ['docs'] })}`,
    })).text)
    expect(applied.status).toBe('applied')
    expect(applied.revision).toBe(1)
    const after = JSON.parse((await command.handler({ agent: forkAgent, rawInput: 'receipt' })).text)
    expect(after.revision).toBe(1)
    expect(after.effective.skills).toEqual(['alpha'])
  } finally {
    host.restore()
  }
})

// --- Cross-workspace preset applicability (fix-capability-fork-and-preset-workspaces) ---
// A global preset may carry a project-scoped Skill identity rooted in another
// workspace. That identity does not exist in this workspace at all, so the
// preset contract applies: skip it, warn, keep the rest — never an
// unactionable same-name conflict with a local Skill, never a substitution,
// never a rewrite of the stored reference. Absence alone is never proof: an
// incomplete inventory or an unresolvable current root set authorizes no skip.

const writeSkill = (dir, name) => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: cross-workspace fixture ${name}\n---\nCONTENT_${name}\n`)
  return join(dir, name, 'SKILL.md')
}

/** Mount the /capabilities command over a hermetic two-workspace fixture. */
const mountApply = (root, { customSkillDirs = [], supplementalSkillDirs = [], agentsHome, inventory } = {}) => {
  const registeredCommands = []
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
      if (name === 'profileContext') return { home: join(root, 'profile'), name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  createSkillSelectionPlugin(inventory ? { inventory } : {})(ctx, {
    machineId: 'weir-it-machine',
    customSkillDirs,
    supplementalSkillDirs,
    agentsHome,
    dshHome: join(root, 'profile'),
  })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  const agent = { id: 'sess-ws-b', session: { id: 'sess-ws-b', header: { cwd: root } } }
  const call = async rawInput => JSON.parse((await command.handler({ agent, rawInput })).text)
  return { command, agent, call }
}

const identityOf = (listing, name, scope) =>
  listing.skills.find(row => row.name === name && row.status === 'parsed' && row.identity?.scope === scope)?.identity ?? null

test('cross-workspace: a preset entry rooted in another workspace is skipped and the rest commits', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-xws-'))
    const workspaceA = mkdtempSync(join(tmpdir(), 'weir-cmd-xws-a-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    writeSkill(join(root, '.dsh', 'skills'), 'travel')
    writeSkill(join(root, 'custom-skills'), 'local-other')
    writeSkill(join(workspaceA, '.dsh', 'skills'), 'travel')
    const { call } = mountApply(root, { customSkillDirs: [join(root, 'custom-skills')], agentsHome: host.agentsHome })
    const listing = await call('list')
    const localTravel = identityOf(listing, 'travel', 'project')
    const localOther = identityOf(listing, 'local-other', 'custom')
    expect(localTravel === null).toBe(false)
    expect(localOther === null).toBe(false)
    // The identity a global preset saved in workspace A carries: same invocation
    // name, different workspace root, machine-local opaque id.
    const foreignTravel = { scope: 'project', root: join(workspaceA, '.dsh', 'skills'), name: 'travel', provenance: null, opaqueId: 'foreign-travel', portable: false }

    // Sole foreign entry: the external reference is skipped with a warning and
    // the normal Apply contract commits the (explicitly empty) Skill set.
    const sole = await call(`apply ${JSON.stringify({ requestId: 'xws-1', expectedRevision: 0, skills: [foreignTravel], mcpServers: [] })}`)
    expect(sole.status).toBe('applied')
    expect(sole.skipped).toEqual([{ name: 'travel', reason: 'not applicable in this workspace' }])
    expect(sole.effective.skills).toEqual([])
    const afterSole = await call('receipt')
    expect(afterSole.effective.skills).toEqual([])

    // Foreign + local same-name + a resolvable remainder: all in one action,
    // no same-name conflict, no silent substitution of the local Skill.
    const mixed = await call(`apply ${JSON.stringify({ requestId: 'xws-2', expectedRevision: 1, skills: [foreignTravel, localTravel, localOther], mcpServers: [] })}`)
    expect(mixed.status).toBe('applied')
    expect(mixed.skipped).toEqual([{ name: 'travel', reason: 'not applicable in this workspace' }])
    const mixedReceipt = await call('receipt')
    expect(mixedReceipt.revision).toBe(2)
    expect(mixedReceipt.effective.skillIdentities.map(identity => identity.name).sort()).toEqual(['local-other', 'travel'])
    // Only the explicitly selected local identity was written — never swapped in
    // for the external reference, and the external reference is not stored.
    const travelIdentities = mixedReceipt.effective.skillIdentities.filter(identity => identity.name === 'travel')
    expect(travelIdentities).toEqual([localTravel])
    // The listing still shows the local candidate with its own provenance.
    const after = await call('list')
    expect(after.skills.filter(row => row.name === 'travel').map(row => row.scope)).toEqual(['project'])
  } finally {
    host.restore()
  }
})

test('cross-workspace: two locally resolvable same-name identities still hard-fail with the draft kept', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-dup-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    writeSkill(join(root, '.dsh', 'skills'), 'dup')
    writeSkill(join(root, 'custom-skills'), 'dup')
    const { call } = mountApply(root, { customSkillDirs: [join(root, 'custom-skills')], agentsHome: host.agentsHome })
    const listing = await call('list')
    const candidates = listing.skills.filter(row => row.name === 'dup').map(row => row.identity)
    expect(candidates).toHaveLength(2)
    const rejected = await call(`apply ${JSON.stringify({ requestId: 'dup-1', expectedRevision: 0, skills: candidates, mcpServers: [] })}`)
    expect(rejected.status).toBe('rejected')
    expect(rejected.reason).toBe('same-name-conflict')
    expect(rejected.conflicts.map(entry => entry.name)).toEqual(['dup'])
    // Zero writes: the previous accepted selection (none) is unchanged.
    expect((await call('receipt')).revision).toBe(0)
  } finally {
    host.restore()
  }
})

test('cross-workspace: unknown and same-workspace-missing identities keep the hard failure', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-unknown-'))
    const { mkdirSync, writeFileSync } = await import('node:fs')
    writeSkill(join(root, '.dsh', 'skills'), 'kept')
    const { call } = mountApply(root, { agentsHome: host.agentsHome })
    const unknownUser = { scope: 'user', root: '/not-in-this-inventory', name: 'ghost', provenance: null, opaqueId: 'ghost', portable: false }
    const unknown = await call(`apply ${JSON.stringify({ requestId: 'u-1', expectedRevision: 0, skills: [unknownUser], mcpServers: [] })}`)
    expect(unknown).toEqual({ status: 'missing', missing: ['ghost'] })
    // A project identity rooted in THIS workspace's project Skill root is missing,
    // not external: the workspace root set proves where it belongs.
    const localMissing = { scope: 'project', root: join(root, '.dsh', 'skills'), name: 'deleted', provenance: null, opaqueId: 'deleted', portable: false }
    const missing = await call(`apply ${JSON.stringify({ requestId: 'u-2', expectedRevision: 0, skills: [localMissing], mcpServers: [] })}`)
    expect(missing).toEqual({ status: 'missing', missing: ['deleted'] })
  } finally {
    host.restore()
  }
})

test('cross-workspace: an incomplete inventory or an unresolvable root set authorizes no skip', { skip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-partial-'))
    const workspaceA = mkdtempSync(join(tmpdir(), 'weir-cmd-partial-a-'))
    const foreign = { scope: 'project', root: join(workspaceA, '.dsh', 'skills'), name: 'travel', provenance: null, opaqueId: 'foreign-travel', portable: false }
    const projectRoot = { path: join(root, '.dsh', 'skills'), source: 'project-dsh', scope: 'project', rank: 100, projectRoot: root }
    const rootsOf = complete => [{ key: 'project-dsh', root: projectRoot, complete, stale: !complete, candidates: [] }]

    // Control: a COMPLETE inventory proves the identity belongs elsewhere.
    const completeMount = mountApply(root, {
      agentsHome: host.agentsHome,
      inventory: async () => ({ complete: true, roots: rootsOf(true), candidates: [] }),
    })
    const skipped = await completeMount.call(`apply ${JSON.stringify({ requestId: 'p-1', expectedRevision: 0, skills: [foreign], mcpServers: [] })}`)
    expect(skipped.status).toBe('applied')
    expect(skipped.skipped).toEqual([{ name: 'travel', reason: 'not applicable in this workspace' }])

    // Incomplete: absence is not proof, so the reference stays a hard failure.
    const partialRoot = mkdtempSync(join(tmpdir(), 'weir-cmd-partial-b-'))
    const partialMount = mountApply(partialRoot, {
      agentsHome: host.agentsHome,
      inventory: async () => ({ complete: false, roots: rootsOf(false), candidates: [] }),
    })
    const partial = await partialMount.call(`apply ${JSON.stringify({ requestId: 'p-2', expectedRevision: 0, skills: [foreign], mcpServers: [] })}`)
    expect(partial).toEqual({ status: 'missing', missing: ['travel'] })

    // No resolvable current project root: same conservative failure.
    const bareRoot = mkdtempSync(join(tmpdir(), 'weir-cmd-partial-c-'))
    const bareMount = mountApply(bareRoot, {
      agentsHome: host.agentsHome,
      inventory: async () => ({ complete: true, roots: [{ key: 'custom', root: { path: join(bareRoot, 'custom'), scope: 'custom', source: 'custom', rank: 300 }, complete: true, stale: false, candidates: [] }], candidates: [] }),
    })
    const bare = await bareMount.call(`apply ${JSON.stringify({ requestId: 'p-3', expectedRevision: 0, skills: [foreign], mcpServers: [] })}`)
    expect(bare).toEqual({ status: 'missing', missing: ['travel'] })
  } finally {
    host.restore()
  }
})

test('cross-workspace: a canonical path alias of this workspace is never misread as external', { skip: skip || (process.platform === 'win32' ? 'directory symlinks need privileges on Windows' : false) }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = mkdtempSync(join(tmpdir(), 'weir-cmd-alias-'))
    const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs')
    writeSkill(join(root, '.dsh', 'skills'), 'aliased')
    // A lexical alias of the SAME workspace (a symlinked checkout): the saved
    // identity spells the root through the link, discovery canonicalizes it.
    const aliasRoot = join(mkdtempSync(join(tmpdir(), 'weir-cmd-alias-link-')), 'linked-ws')
    symlinkSync(root, aliasRoot, 'dir')
    const { call } = mountApply(root, { agentsHome: host.agentsHome })
    const listing = await call('list')
    const canonical = identityOf(listing, 'aliased', 'project')
    expect(canonical === null).toBe(false)
    const aliased = { ...canonical, root: join(aliasRoot, '.dsh', 'skills') }
    // Not external: the alias resolves to this workspace's own project root, so
    // the reference is a missing local identity — a hard failure, never a skip.
    const result = await call(`apply ${JSON.stringify({ requestId: 'alias-1', expectedRevision: 0, skills: [aliased], mcpServers: [] })}`)
    expect(result).toEqual({ status: 'missing', missing: ['aliased'] })
  } finally {
    host.restore()
  }
})

test('cross-workspace partition helper: evidence gates, reasons and ordering', async () => {
  const { partitionUnresolvedSkills, canonicalPathKey, workspaceProjectSkillRoots, isForeignProjectIdentity,
    NOT_APPLICABLE_IN_WORKSPACE, NOT_APPLICABLE_IN_PRESET } = await import('../src/capabilities/skill-applicability.js')
  const roots = [
    { key: 'project-dsh', root: { path: '/ws-b/.dsh/skills', source: 'project-dsh', scope: 'project', rank: 100, projectRoot: '/ws-b' }, complete: true, stale: false, candidates: [] },
    { key: 'project-agents', root: { path: '/ws-b/.agents/skills', source: 'project-agents', scope: 'project', rank: 200, projectRoot: '/ws-b' }, complete: true, stale: false, candidates: [] },
  ]
  const foreign = { scope: 'project', root: '/ws-a/.dsh/skills', name: 'travel', opaqueId: 'foreign' }
  const local = { scope: 'project', root: '/ws-b/.dsh/skills', name: 'travel', opaqueId: 'local' }
  const unknownUser = { scope: 'user', root: '/home/skills', name: 'ghost', opaqueId: 'ghost' }

  const partitioned = partitionUnresolvedSkills([foreign, local, unknownUser, 'creative-only', 'nowhere'],
    { roots, complete: true, knownSupplemental: name => name === 'creative-only' })
  expect(partitioned).toEqual({
    skipped: [
      { name: 'travel', reason: NOT_APPLICABLE_IN_WORKSPACE },
      { name: 'creative-only', reason: NOT_APPLICABLE_IN_PRESET },
    ],
    unknown: ['travel', 'ghost', 'nowhere'],
  })

  // Absence authorizes nothing without a COMPLETE inventory and a resolvable root set.
  expect(partitionUnresolvedSkills([foreign], { roots, complete: false }).unknown).toEqual(['travel'])
  expect(partitionUnresolvedSkills([foreign], { roots: [], complete: true }).unknown).toEqual(['travel'])
  expect(partitionUnresolvedSkills([foreign], { roots: [{ key: 'c', root: { path: '/ws-b/custom', scope: 'custom', source: 'custom', rank: 300 } }], complete: true }).unknown).toEqual(['travel'])
  // Duplicates and order follow the draft: the receipt reports the request as received.
  expect(partitionUnresolvedSkills([foreign, foreign, local, foreign], { roots, complete: true }).skipped).toEqual([
    { name: 'travel', reason: NOT_APPLICABLE_IN_WORKSPACE },
    { name: 'travel', reason: NOT_APPLICABLE_IN_WORKSPACE },
    { name: 'travel', reason: NOT_APPLICABLE_IN_WORKSPACE },
  ])

  const rootKeys = workspaceProjectSkillRoots(roots)
  expect(rootKeys.size).toBe(2)
  expect(isForeignProjectIdentity(foreign, rootKeys)).toBe(true)
  expect(isForeignProjectIdentity(local, rootKeys)).toBe(false)
  expect(isForeignProjectIdentity(unknownUser, rootKeys)).toBe(false)
  // A project identity without a root cannot be proven external.
  expect(isForeignProjectIdentity({ scope: 'project', name: 'travel' }, rootKeys)).toBe(false)
  // Root observations are accepted in both shapes (bare root or observation).
  expect(workspaceProjectSkillRoots([roots[0].root]).size).toBe(2)
  // Platform normalization compares canonically — never a string prefix — so a
  // win32 case variant of this very workspace is not another workspace.
  expect(canonicalPathKey('/WS/Skills', 'win32')).toBe(canonicalPathKey('/ws/skills', 'win32'))
  expect(canonicalPathKey('/ws-b/.dsh/skills', 'darwin')).toBe('/ws-b/.dsh/skills')
  expect(canonicalPathKey('/ws-b/.dsh/skills/../skills', 'darwin')).toBe('/ws-b/.dsh/skills/../skills')
})
