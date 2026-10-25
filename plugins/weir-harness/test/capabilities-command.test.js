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

