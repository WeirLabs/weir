// capabilities-deepening group 1: command-level regression pins for the
// /capabilities handler. These pin CURRENT behavior verbatim — rejection
// texts, usage fallbacks, case-insensitive dispatch, no-workspace mappings,
// the mcp-add success payload and every success verb's response field list —
// so the group-2 verb-body extraction has an exact before/after comparison
// surface. Pinning CURRENT behavior is the point: several of these texts and
// mappings are historical quirks, not ideals. Mount style follows
// test/preset-verbs.test.js (ctx-stub + callJson + node:test + the local
// expect facade); store-backed cases skip off the verified platform rows.
import { test, expect, storePlatformSkip, pinHermeticHostRoots } from './helpers.js'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'weir-cmd-pin-'))

/**
 * Mount the plugin with hermetic roots; returns the command helpers.
 * Signature mirrors preset-verbs.test.js (root, config, profileContext,
 * dependencies); `manager` stubs ctx.get('weirMcpManager') (the mcp-add
 * `mounted` field). After `armCtxFailure()` every ctx.get throws — the
 * uniform trigger that lands each verb in its own catch clause (the
 * store/engine/lookup seams all resolve services through ctx.get inside the
 * verb try blocks).
 */
const mountCapabilities = (root, config = {}, profileContext, dependencies = {}, manager) => {
  const registeredCommands = []
  let provider
  let ctxArmed = false
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
      if (ctxArmed) throw new Error('injected ctx failure')
      if (name === 'profileContext') return profileContext ?? { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      if (name === 'weirMcpManager') return manager
      return undefined
    },
  }
  createSkillSelectionPlugin(dependencies)(ctx, {
    machineId: 'weir-it-machine',
    customSkillDirs: [],
    agentsHome: join(root, 'agents-home'),
    ...config,
  })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  const agent = { id: 'sess-pin', session: { id: 'sess-pin', header: { cwd: root } } }
  const agentOf = id => ({ id, session: { id, header: { cwd: root } } })
  const noCwdAgent = { id: 'sess-no-cwd', session: { id: 'sess-no-cwd', header: {} } }
  const call = (rawInput, payload, who = agent) =>
    command.handler({ agent: who, rawInput: payload === undefined ? rawInput : `${rawInput} ${JSON.stringify(payload)}` })
  const callJson = async (rawInput, payload, who) => {
    const result = await call(rawInput, payload, who)
    return { kind: result.kind, payload: (() => { try { return JSON.parse(result.text) } catch { return null } })(), text: result.text }
  }
  return { command, agent, agentOf, noCwdAgent, call, callJson, armCtxFailure: () => { ctxArmed = true } }
}

/** A workspace with one discoverable custom Skill, applied to the session. */
const plantAlpha = root => {
  mkdirSync(join(root, 'custom', 'alpha'), { recursive: true })
  writeFileSync(join(root, 'custom', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: pin fixture\n---\nALPHA\n')
}

const identityFixture = (name = 'alpha') => ({ scope: 'custom', root: '/skills', name, opaqueId: `id-${name}`, portable: false })

const v2Package = () => ({
  version: 2,
  name: 'Bundle',
  selection: { skills: [], mcpServers: [], unresolvedRefs: [] },
  builtin: [],
  bundled: [],
  warnings: [],
})

// ---- 1.7 dispatch contract -------------------------------------------------

test('pin 1.7: a missing owning agent is a fixed error, whatever the verb', async () => {
  const { command } = mountCapabilities(tmp())
  for (const rawInput of ['receipt', 'bogus-verb', '']) {
    const result = await command.handler({ rawInput })
    expect(result.kind).toBe('error')
    expect(result.text).toBe('capabilities: requires an owning agent session')
  }
  const nullAgent = await command.handler({ agent: null, rawInput: 'list' })
  expect(nullAgent.kind).toBe('error')
  expect(nullAgent.text).toBe('capabilities: requires an owning agent session')
})

test('pin 1.7: unknown and empty verbs fall through to the usage line', async () => {
  const { call } = mountCapabilities(tmp())
  const usage = 'Usage: /capabilities receipt|list|conditions|presets|preset-save|preset-load|preset-delete|preset-export|preset-import|default-get|default-save|default-clear'
  for (const rawInput of ['bogus-verb', 'receipt extra words', 'apply', 'preset-save']) {
    const result = await call(rawInput)
    expect(result.kind).toBe('error')
    expect(result.text).toBe(usage)
  }
})

test('pin 1.7: verb matching is case-insensitive; the apply payload keeps its casing', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = tmp()
    plantAlpha(root)
    const { callJson } = mountCapabilities(root, { customSkillDirs: [join(root, 'custom')], dshHome: root })

    expect((await callJson('RECEIPT')).payload.status).toBe('applied')
    expect((await callJson('List')).kind).toBe('success')
    expect((await callJson('CONDITIONS')).payload).toEqual({ conditions: [] })
    expect((await callJson('Default-Get')).payload.status).toBe('absent')
    expect((await callJson('PRESETS')).payload.presets).toEqual([])

    // Mixed-case verb + JSON payload: the payload bytes are never lowercased.
    const applied = await callJson('ApPlY', { requestId: 'MixedCase-1', expectedRevision: 0, skills: ['alpha'], mcpServers: [] })
    expect(applied.payload.status).toBe('applied')
    expect(applied.payload.receipt.requestId).toBe('MixedCase-1')

    expect((await callJson('Preset-Save', { scope: 'global', name: 'Mixed', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })).payload.status).toBe('created')
    expect((await callJson('DEFAULT-CLEAR')).payload.status).toBe('cleared')
  } finally {
    host.restore()
  }
})

test('pin 1.7: malformed payloads land on the per-verb usage lines', async () => {
  const { call } = mountCapabilities(tmp())
  const cases = [
    ['apply {', 'Usage: /capabilities apply <json selection>'],
    ['mcp-add {', 'Usage: /capabilities mcp-add <json {identity,label,command,args?,env?,serverName?}>'],
    ['preset-save {', 'Usage: /capabilities preset-save <json>'],
    ['preset-rename {', 'Usage: /capabilities preset-rename <json>'],
    ['preset-resave {', 'Usage: /capabilities preset-resave <json>'],
    ['preset-load {', 'Usage: /capabilities preset-load <json {scope,presetId}>'],
    ['preset-delete {', 'Usage: /capabilities preset-delete <json {scope,presetId,expectedRevision}>'],
    ['preset-export {', 'Usage: /capabilities preset-export <json {scope,presetId,format?:"package"|"document"}>'],
    ['preset-import {', 'Usage: /capabilities preset-import <json {document,scope,presetId?,name?,onNameConflict?,dryRun?,onCollision?}>'],
    ['default-save {', 'Usage: /capabilities default-save <json {from:"draft"|"applied",skills?,mcpServers?,unresolvedRefs?,expectedRevision?}>'],
    ['default-clear {', 'Usage: /capabilities default-clear [json {expectedRevision?}]'],
  ]
  for (const [rawInput, text] of cases) {
    const result = await call(rawInput)
    expect(result.kind).toBe('error')
    expect(result.text).toBe(text)
  }
})

// ---- 1.6 guard texts (full-text pins, upgraded from kind-only) --------------

test('pin 1.6: the shared preset scope guard names the allowed values and the received one', async () => {
  const { callJson } = mountCapabilities(tmp())
  const expected = 'capabilities: scope must be "global" | "workspace", got "elsewhere"'
  const draft = { scope: 'elsewhere', name: 'X', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] }
  expect((await callJson('preset-save', draft)).text).toBe(expected)
  expect((await callJson('preset-load', { scope: 'elsewhere', presetId: 'p' })).text).toBe(expected)
  expect((await callJson('preset-delete', { scope: 'elsewhere', presetId: 'p', expectedRevision: 1 })).text).toBe(expected)
  expect((await callJson('preset-export', { scope: 'elsewhere', presetId: 'p' })).text).toBe(expected)
  expect((await callJson('preset-import', { scope: 'elsewhere', document: {} })).text).toBe(expected)
  // An absent scope stringifies as null.
  expect((await callJson('preset-load', { presetId: 'p' })).text)
    .toBe('capabilities: scope must be "global" | "workspace", got null')
})

test('pin 1.6: default-save from/expectedRevision and preset-delete/default-clear revision texts', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  expect((await callJson('default-save', { from: 'nowhere' })).text)
    .toBe('capabilities default-save: from must be "draft" | "applied"')
  expect((await callJson('default-save', { from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [], expectedRevision: -1 })).text)
    .toBe('capabilities default-save: expectedRevision must be a non-negative integer')
  expect((await callJson('default-save', { from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [], expectedRevision: '1' })).text)
    .toBe('capabilities default-save: expectedRevision must be a non-negative integer')
  expect((await callJson('preset-delete', { scope: 'global', presetId: 'p', expectedRevision: 'x' })).text)
    .toBe('capabilities preset-delete: expectedRevision must be a non-negative integer')
  expect((await callJson('default-clear', { expectedRevision: -2 })).text)
    .toBe('capabilities default-clear: expectedRevision must be a non-negative integer')
})

test('pin 1.6: preset-import v2 dryRun must be a boolean (full text)', async () => {
  const { callJson } = mountCapabilities(tmp())
  const result = await callJson('preset-import', { document: v2Package(), scope: 'global', dryRun: 'yes' })
  expect(result.kind).toBe('error')
  expect(result.text).toBe('capabilities preset-import: dryRun must be a boolean')
})

// ---- 1.3 default verbs: no-workspace mapping + workspaceKey fields ----------

test('pin 1.3: default verbs map a missing workspace to {status:no-workspace} with kind error', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson, noCwdAgent } = mountCapabilities(root)
  // default-get: the ONLY verb whose no-workspace mapping goes through the
  // payload builder; the command maps exactly that status to kind:error.
  const got = await callJson('default-get', undefined, noCwdAgent)
  expect(got.kind).toBe('error')
  expect(got.payload).toEqual({ status: 'no-workspace' })
  const saved = await callJson('default-save', { from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] }, noCwdAgent)
  expect(saved.kind).toBe('error')
  expect(saved.payload).toEqual({ status: 'no-workspace' })
  const cleared = await callJson('default-clear', undefined, noCwdAgent)
  expect(cleared.kind).toBe('error')
  expect(cleared.payload).toEqual({ status: 'no-workspace' })
})

test('pin 1.3: default-save and default-clear success payloads carry the workspaceKey', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  const saved = await callJson('default-save', { from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })
  expect(saved.kind).toBe('success')
  expect(Object.keys(saved.payload)).toEqual(['status', 'revision', 'workspaceKey'])
  expect(saved.payload.status).toBe('saved')
  expect(saved.payload.workspaceKey).toMatch(/^ws-[0-9a-f]{24}$/)
  const cleared = await callJson('default-clear')
  expect(Object.keys(cleared.payload)).toEqual(['status', 'revision', 'workspaceKey'])
  expect(cleared.payload.status).toBe('cleared')
  expect(cleared.payload.workspaceKey).toBe(saved.payload.workspaceKey)
  // default-get reports the cleared marker distinctly, same key.
  const got = await callJson('default-get')
  expect(Object.keys(got.payload)).toEqual(['status', 'revision', 'cleared', 'snapshot', 'workspaceKey'])
  expect(got.payload.cleared).toBe(true)
  expect(got.payload.workspaceKey).toBe(saved.payload.workspaceKey)
})

// ---- 1.2 default-save from:'applied' (the only reachable applied path) ------

test("pin 1.2: default-save from:'applied' is server-authoritative — client sets are never trusted", { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = tmp()
    plantAlpha(root)
    const { callJson } = mountCapabilities(root, { customSkillDirs: [join(root, 'custom')], dshHome: root })
    const applied = await callJson('apply', { requestId: 'r-1', expectedRevision: 0, skills: ['alpha'], mcpServers: ['docs'] })
    expect(applied.payload.status).toBe('applied')

    const saved = await callJson('default-save', {
      from: 'applied',
      skills: ['bogus-skill'], mcpServers: ['bogus-mcp'], unresolvedRefs: [{ kind: 'skill', ref: 'bogus' }],
    })
    expect(saved.kind).toBe('success')
    expect(saved.payload.status).toBe('saved')
    expect(saved.payload.revision).toBe(1)

    const got = await callJson('default-get')
    expect(got.payload.status).toBe('ok')
    // The recorded sets come from the provider/lifecycle state, not the client.
    expect(got.payload.snapshot.skills.map(identity => identity.name)).toEqual(['alpha'])
    expect(got.payload.snapshot.skills[0].scope).toBe('custom')
    expect(got.payload.snapshot.mcpServers).toEqual(['docs'])
    expect(got.payload.snapshot.unresolvedRefs).toEqual([])
  } finally {
    host.restore()
  }
})

test("pin 1.2: default-save from:'applied' without expectedRevision read-modify-writes; a stale revision conflicts with zero writes", { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = tmp()
    plantAlpha(root)
    const { callJson } = mountCapabilities(root, { customSkillDirs: [join(root, 'custom')], dshHome: root })
    await callJson('apply', { requestId: 'r-1', expectedRevision: 0, skills: ['alpha'], mcpServers: [] })

    // expectedRevision omitted: the verb reads the current revision itself.
    const first = await callJson('default-save', { from: 'applied' })
    expect(first.payload.status).toBe('saved')
    expect(first.payload.revision).toBe(1)
    const second = await callJson('default-save', { from: 'applied' })
    expect(second.payload.status).toBe('saved')
    expect(second.payload.revision).toBe(2)

    // A stale expectedRevision conflicts and writes nothing.
    const stale = await callJson('default-save', { from: 'applied', expectedRevision: 1 })
    expect(stale.kind).toBe('success')
    expect(stale.payload.status).toBe('revision-conflict')
    const got = await callJson('default-get')
    expect(got.payload.revision).toBe(2)
  } finally {
    host.restore()
  }
})

// ---- 1.5 mcp-add: full success payload, manager start, conflicts, texts -----

test('pin 1.5: mcp-add success payload, manager.start wiring and validation texts', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = tmp()
    let starts = 0
    const manager = { start: async () => { starts += 1 } }
    const { callJson } = mountCapabilities(root, { dshHome: root }, undefined, undefined, manager)

    const added = await callJson('mcp-add', { identity: 'docs', label: 'Docs', command: 'npx', args: ['-y', 'docs-mcp'], env: { A: '1' } })
    expect(added.kind).toBe('success')
    expect(Object.keys(added.payload)).toEqual(['status', 'identity', 'generation', 'mounted'])
    expect(added.payload).toEqual({ status: 'registered', identity: 'docs', generation: 1, mounted: true })
    expect(starts).toBe(1)

    // Without a manager face the same registration reports mounted:false.
    const bare = mountCapabilities(tmp(), { dshHome: root })
    const noManager = await bare.callJson('mcp-add', { identity: 'docs', label: 'Docs', command: 'npx' })
    expect(noManager.payload.mounted).toBe(false)

    // The identity/label/command validation text.
    for (const spec of [{ label: 'L', command: 'c' }, { identity: 'i', command: 'c' }, { identity: 'i', label: 'L' }, { identity: 'i', label: 'L', command: '' }]) {
      const refused = await callJson('mcp-add', spec)
      expect(refused.kind).toBe('error')
      expect(refused.text).toBe('mcp-add needs identity, label and command strings')
    }
  } finally {
    host.restore()
  }
})

test('pin 1.5: a non-committed registry write surfaces as {status} error payload', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  // Poison the registry record: the CAS read-modify-write fails closed as
  // 'unreadable' and the verb relays the bare status.
  const dir = join(root, 'weir', 'profiles', 'it', 'capabilities', 'mcp')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'registry.json'), '{corrupt')
  const result = await callJson('mcp-add', { identity: 'docs', label: 'Docs', command: 'npx' })
  expect(result.kind).toBe('error')
  expect(result.payload).toEqual({ status: 'unreadable' })
})

// ---- 1.4 success response field lists ---------------------------------------

test('pin 1.4: receipt/list/conditions payload field lists', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = tmp()
    plantAlpha(root)
    const { callJson } = mountCapabilities(root, { customSkillDirs: [join(root, 'custom')], dshHome: root })

    const receipt = await callJson('receipt')
    expect(receipt.kind).toBe('success')
    expect(Object.keys(receipt.payload)).toEqual(['status', 'revision', 'effective', 'warnings'])
    expect(receipt.payload.status).toBe('applied')
    expect(receipt.payload.revision).toBe(0)
    expect(Object.keys(receipt.payload.effective)).toEqual(['skills', 'skillIdentities', 'mcpServers', 'digest'])
    expect(receipt.payload.effective.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.payload.warnings).toEqual([])

    const list = await callJson('list')
    expect(Object.keys(list.payload)).toEqual(['skills', 'mcpServers'])
    const alphaRow = list.payload.skills.find(row => row.name === 'alpha')
    expect(Object.keys(alphaRow)).toEqual(['name', 'description', 'scope', 'status', 'selected', 'conflict', 'identity'])
    expect(alphaRow.selected).toBe(false)
    expect(list.payload.mcpServers).toEqual([])

    expect((await callJson('conditions')).payload).toEqual({ conditions: [] })
  } finally {
    host.restore()
  }
})

test('pin 1.4: apply success payload field list (no removal → no draining field)', { skip: storePlatformSkip }, async () => {
  const host = pinHermeticHostRoots()
  try {
    const root = tmp()
    plantAlpha(root)
    const { callJson } = mountCapabilities(root, { customSkillDirs: [join(root, 'custom')], dshHome: root })
    const applied = await callJson('apply', { requestId: 'r-1', expectedRevision: 0, skills: ['alpha'], mcpServers: [] })
    expect(applied.kind).toBe('success')
    expect(Object.keys(applied.payload)).toEqual(['status', 'revision', 'receipt', 'effective', 'unresolvedWarnings'])
    expect(applied.payload.status).toBe('applied')
    expect(applied.payload.revision).toBe(1)
    expect(Object.keys(applied.payload.receipt).sort()).toEqual(['acceptedAt', 'requestDigest', 'requestId', 'revision'])
    expect(Object.keys(applied.payload.effective)).toEqual(['skills', 'mcpServers'])
    expect(applied.payload.effective.skills.map(identity => identity.name)).toEqual(['alpha'])
    expect(applied.payload.unresolvedWarnings).toEqual([])
  } finally {
    host.restore()
  }
})

test('pin 1.4: presets payload field list', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  const empty = await callJson('presets')
  expect(Object.keys(empty.payload)).toEqual(['presets', 'workspaceKey'])
  expect(empty.payload.presets).toEqual([])
  await callJson('preset-save', { scope: 'global', name: 'G', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })
  const listed = await callJson('presets')
  expect(listed.payload.presets).toHaveLength(1)
  expect(Object.keys(listed.payload.presets[0])).toEqual(['scope', 'presetId', 'name', 'revision', 'counts'])
  expect(Object.keys(listed.payload.presets[0].counts)).toEqual(['skills', 'mcpServers', 'unresolvedRefs'])
})

test('pin 1.4: preset write verb payload field lists', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  const spec = { scope: 'global', name: 'Keep', from: 'draft', skills: [identityFixture()], mcpServers: ['docs'], unresolvedRefs: [] }

  const created = await callJson('preset-save', spec)
  expect(Object.keys(created.payload)).toEqual(['status', 'presetId', 'revision'])
  expect(created.payload).toEqual({ status: 'created', presetId: 'keep', revision: 1 })

  const renamed = await callJson('preset-rename', { scope: 'global', presetId: 'keep', expectedRevision: 1, name: 'Kept' })
  expect(Object.keys(renamed.payload)).toEqual(['status', 'presetId', 'revision'])
  expect(renamed.payload.status).toBe('edited')

  const resaved = await callJson('preset-resave', { scope: 'global', presetId: 'keep', expectedRevision: 2, from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })
  expect(Object.keys(resaved.payload)).toEqual(['status', 'presetId', 'revision'])
  expect(resaved.payload.status).toBe('edited')

  const loaded = await callJson('preset-load', { scope: 'global', presetId: 'keep' })
  expect(Object.keys(loaded.payload)).toEqual(['status', 'revision', 'document'])
  expect(loaded.payload.status).toBe('ok')
  expect(Object.keys(loaded.payload.document)).toEqual(['name', 'selection'])
  expect(Object.keys(loaded.payload.document.selection)).toEqual(['skills', 'mcpServers', 'unresolvedRefs'])
  expect((await callJson('preset-load', { scope: 'global', presetId: 'ghost' })).payload).toEqual({ status: 'absent' })

  const deleted = await callJson('preset-delete', { scope: 'global', presetId: 'keep', expectedRevision: 3 })
  expect(Object.keys(deleted.payload)).toEqual(['status', 'presetId', 'revision'])
  expect(deleted.payload.status).toBe('deleted')
})

test('pin 1.4: preset-export package and document payload field lists', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  await callJson('preset-save', { scope: 'global', name: 'Pack', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })

  const asPackage = await callJson('preset-export', { scope: 'global', presetId: 'pack' })
  expect(Object.keys(asPackage.payload)).toEqual(['status', 'format', 'document'])
  expect(asPackage.payload.format).toBe('package')
  expect(Object.keys(asPackage.payload.document)).toEqual(['version', 'name', 'selection', 'builtin', 'bundled', 'warnings'])
  expect(asPackage.payload.document.version).toBe(2)
  expect(Object.keys(asPackage.payload.document.selection)).toEqual(['skills', 'mcpServers', 'unresolvedRefs'])

  const asDocument = await callJson('preset-export', { scope: 'global', presetId: 'pack', format: 'document' })
  expect(Object.keys(asDocument.payload)).toEqual(['status', 'document'])
  expect(Object.keys(asDocument.payload.document)).toEqual(['version', 'scope', 'presetId', 'name', 'selection'])
  expect(asDocument.payload.document.version).toBe(1)
})

test('pin 1.4: preset-import v1 and v2 payload field lists', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  await callJson('mcp-add', { identity: 'docs', label: 'Docs', command: 'npx' })

  const v1 = {
    version: 1, scope: 'global', presetId: 'shared', name: 'Shared',
    selection: { skills: [], mcpServers: [{ identity: 'docs', label: 'Docs' }], unresolvedRefs: [] },
  }
  const imported = await callJson('preset-import', { document: v1, scope: 'global' })
  expect(Object.keys(imported.payload)).toEqual(['status', 'presetId', 'revision', 'bound'])
  expect(imported.payload.status).toBe('created')
  expect(Object.keys(imported.payload.bound)).toEqual(['mcpServers', 'unresolvedRefs'])
  expect(imported.payload.bound).toEqual({ mcpServers: 1, unresolvedRefs: 0 })

  const dry = await callJson('preset-import', { document: v2Package(), scope: 'global', dryRun: true })
  expect(Object.keys(dry.payload)).toEqual(['status', 'install', 'unresolved', 'collisions', 'presetConflict'])
  expect(dry.payload.status).toBe('dry-run')
  expect(dry.payload.install).toEqual([])
  expect(dry.payload.presetConflict).toBeNull()

  const confirmed = await callJson('preset-import', { document: v2Package(), scope: 'global' })
  expect(Object.keys(confirmed.payload)).toEqual(['status', 'presetId', 'revision', 'bound', 'installed', 'collisions', 'unresolved'])
  expect(confirmed.payload.status).toBe('created')
})

test('pin 1.4: default-get field lists for absent and saved states', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  const absent = await callJson('default-get')
  expect(absent.kind).toBe('success')
  expect(Object.keys(absent.payload)).toEqual(['status', 'workspaceKey'])
  expect(absent.payload.status).toBe('absent')

  await callJson('default-save', { from: 'draft', skills: [identityFixture()], mcpServers: ['docs'], unresolvedRefs: [] })
  const got = await callJson('default-get')
  expect(Object.keys(got.payload)).toEqual(['status', 'revision', 'cleared', 'snapshot', 'workspaceKey'])
  expect(got.payload.status).toBe('ok')
  expect(got.payload.cleared).toBe(false)
  expect(Object.keys(got.payload.snapshot)).toEqual(['skills', 'mcpServers', 'unresolvedRefs', 'savedAt'])
})

// ---- 1.8 per-verb catch prefixes ---------------------------------------------

test('pin 1.8: every verb catch carries the "capabilities <verb> failed: " prefix', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { call, callJson, armCtxFailure } = mountCapabilities(root)
  armCtxFailure()
  // Every verb that resolves a service inside its try block lands in its own
  // catch with the pinned prefix; ${action} covers the save/rename/resave trio.
  const cases = [
    ['receipt', undefined, 'capabilities receipt failed: injected ctx failure'],
    ['list', undefined, 'capabilities list failed: injected ctx failure'],
    ['apply', { requestId: 'r', expectedRevision: 0, skills: [], mcpServers: [] }, 'capabilities apply failed: injected ctx failure'],
    ['mcp-add', { identity: 'i', label: 'L', command: 'c' }, 'capabilities mcp-add failed: injected ctx failure'],
    ['presets', undefined, 'capabilities presets failed: injected ctx failure'],
    ['preset-save', { scope: 'global', name: 'X', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] }, 'capabilities preset-save failed: injected ctx failure'],
    ['preset-rename', { scope: 'global', presetId: 'p', expectedRevision: 1, name: 'N' }, 'capabilities preset-rename failed: injected ctx failure'],
    ['preset-resave', { scope: 'global', presetId: 'p', expectedRevision: 1, from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] }, 'capabilities preset-resave failed: injected ctx failure'],
    ['preset-load', { scope: 'global', presetId: 'p' }, 'capabilities preset-load failed: injected ctx failure'],
    ['preset-delete', { scope: 'global', presetId: 'p', expectedRevision: 1 }, 'capabilities preset-delete failed: injected ctx failure'],
    ['preset-export', { scope: 'global', presetId: 'p' }, 'capabilities preset-export failed: injected ctx failure'],
    ['preset-import', { scope: 'global', document: v2Package() }, 'capabilities preset-import failed: injected ctx failure'],
    ['default-get', undefined, 'capabilities default-get failed: injected ctx failure'],
    ['default-save', { from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] }, 'capabilities default-save failed: injected ctx failure'],
    ['default-clear', undefined, 'capabilities default-clear failed: injected ctx failure'],
  ]
  for (const [verb, payload, text] of cases) {
    const result = await call(verb, payload)
    expect(result.kind).toBe('error')
    expect(result.text).toBe(text)
  }
  // The v1 import path shares the same verb prefix.
  const v1 = await callJson('preset-import', { scope: 'global', document: { version: 1, scope: 'global', presetId: 'p', name: 'P', selection: { skills: [], mcpServers: [], unresolvedRefs: [] } } })
  expect(v1.kind).toBe('error')
  expect(v1.text).toBe('capabilities preset-import failed: injected ctx failure')
})

// ---- cross-cutting: workspace-scope preset verbs without a workspace --------

test('pin: workspace-scoped preset verbs without a workspace return the shared no-workspace error', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson, noCwdAgent } = mountCapabilities(root)
  const expected = { status: 'no-workspace' }
  for (const [verb, payload] of [
    ['preset-save', { scope: 'workspace', name: 'W', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] }],
    ['preset-load', { scope: 'workspace', presetId: 'p' }],
    ['preset-delete', { scope: 'workspace', presetId: 'p', expectedRevision: 1 }],
    ['preset-export', { scope: 'workspace', presetId: 'p' }],
    ['preset-import', { scope: 'workspace', document: { version: 1, scope: 'workspace', presetId: 'p', name: 'P', selection: { skills: [], mcpServers: [], unresolvedRefs: [] } } }],
  ]) {
    const result = await callJson(verb, payload, noCwdAgent)
    expect(result.kind).toBe('error')
    expect(result.payload).toEqual(expected)
  }
  // A v2 package import with workspace scope takes the same guard.
  const v2 = await callJson('preset-import', { scope: 'workspace', document: v2Package() }, noCwdAgent)
  expect(v2.kind).toBe('error')
  expect(v2.payload).toEqual(expected)
  // presets still lists (its workspace namespace is simply skipped) — it never
  // errors on a missing workspace.
  const listed = await callJson('presets', undefined, noCwdAgent)
  expect(listed.kind).toBe('success')
  // Zero writes anywhere: every guard returned before touching the store.
  expect(existsSync(join(root, 'weir'))).toBe(false)
})
