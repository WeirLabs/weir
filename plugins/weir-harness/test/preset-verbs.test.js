// capability-manager-ux task 7.1: command-level unit tests for the nine
// preset/default verbs of /capabilities (the lane-049 implementation's
// deferred test debt). Per verb: success / conflict / rejection / zero-write
// paths, through the ctx-stub pattern of capabilities-command.test.js.
import { test, expect, storePlatformSkip } from './helpers.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'weir-verbs-'))

/** Mount the plugin with hermetic roots; returns the command + agent stubs. */
const mountCapabilities = (root, config = {}, profileContext) => {
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
      if (name === 'profileContext') return profileContext ?? { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  createSkillSelectionPlugin()(ctx, {
    machineId: 'weir-it-machine',
    customSkillDirs: [],
    agentsHome: join(root, 'agents-home'),
    ...config,
  })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  const agent = { id: 'sess-verbs', session: { id: 'sess-verbs', header: { cwd: root } } }
  const call = (rawInput, payload) => command.handler({ agent, rawInput: payload === undefined ? rawInput : `${rawInput} ${JSON.stringify(payload)}` })
  const callJson = async (rawInput, payload) => {
    const result = await call(rawInput, payload)
    return { kind: result.kind, payload: (() => { try { return JSON.parse(result.text) } catch { return null } })(), text: result.text }
  }
  return { command, agent, call, callJson }
}

const identityFixture = (name = 'alpha') => ({ scope: 'custom', root: '/skills', name, opaqueId: `id-${name}`, portable: false })

// ---- presets ---------------------------------------------------------------

test('presets: lists both namespaces with counts; an unsupported store fails closed', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  const empty = await callJson('presets')
  expect(empty.kind).toBe('success')
  expect(empty.payload.presets).toEqual([])
  expect(typeof empty.payload.workspaceKey).toBe('string')

  await callJson('preset-save', { scope: 'global', name: 'G', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })
  await callJson('preset-save', { scope: 'workspace', name: 'W', from: 'draft', skills: [], mcpServers: ['docs'], unresolvedRefs: [{ kind: 'mcp', ref: { identity: 'x', label: 'x' } }] })
  const listed = await callJson('presets')
  expect(listed.payload.presets).toHaveLength(2)
  const global = listed.payload.presets.find(preset => preset.name === 'G')
  expect(global.scope).toBe('global')
  expect(global.counts).toEqual({ skills: 0, mcpServers: 0, unresolvedRefs: 0 })
  expect(global.presetId).toBe('g')
  const workspace = listed.payload.presets.find(preset => preset.name === 'W')
  expect(workspace.scope).toBe('workspace')
  expect(workspace.counts).toEqual({ skills: 0, mcpServers: 1, unresolvedRefs: 1 })

  // fail closed: an unsupported store root is an explicit error, never an
  // empty listing pretending success
  const broken = mountCapabilities(tmp(), {}, { home: 'not-absolute', name: 'it' })
  const failed = await broken.callJson('presets')
  expect(failed.kind).toBe('error')
  expect(failed.payload.status).toBe('unsupported')
})

// ---- preset-save -------------------------------------------------------------

test('preset-save: create success; name collision is zero-write unless replaced; stale revision conflicts', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { call, callJson } = mountCapabilities(root)
  const spec = { scope: 'global', name: 'My Preset', from: 'draft', skills: [identityFixture()], mcpServers: ['docs'], unresolvedRefs: [] }
  const created = await callJson('preset-save', spec)
  expect(created.kind).toBe('success')
  expect(created.payload.status).toBe('created')
  expect(created.payload.presetId).toBe('my-preset')
  expect(created.payload.revision).toBe(1)

  // same display name, default decision: a name-conflict that writes nothing
  const conflict = await callJson('preset-save', spec)
  expect(conflict.payload.status).toBe('name-conflict')
  expect(conflict.payload.with).toBe('my-preset')
  expect((await callJson('presets')).payload.presets).toHaveLength(1)

  // explicitly confirmed replace creates under a fresh id
  const replaced = await callJson('preset-save', { ...spec, onNameConflict: 'replace' })
  expect(replaced.payload.status).toBe('created')
  expect(replaced.payload.presetId).toBe('my-preset-2')
  expect((await callJson('presets')).payload.presets).toHaveLength(2)

  // edit with a stale expectedRevision is a conflict, never a silent overwrite
  const stale = await callJson('preset-save', { ...spec, presetId: 'my-preset', name: 'Renamed', expectedRevision: 5 })
  expect(stale.payload.status).toBe('revision-conflict')
  // edit with the current revision commits
  const edited = await callJson('preset-save', { ...spec, presetId: 'my-preset', name: 'Renamed', expectedRevision: 1 })
  expect(edited.payload.status).toBe('edited')

  // rejections
  expect((await callJson('preset-save', { ...spec, scope: 'elsewhere' })).kind).toBe('error')
  expect((await callJson('preset-save', { ...spec, from: 'nowhere' })).kind).toBe('error')
  expect((await callJson('preset-save', { ...spec, name: '' })).kind).toBe('error')
  expect((await callJson('preset-save', { ...spec, onNameConflict: 'merge' })).kind).toBe('error')
  expect((await call('preset-save not-json')).kind).toBe('error')
})

test('preset-save: workspace scope without a workspace is an explicit status', async () => {
  const root = tmp()
  const { command } = mountCapabilities(root)
  // an agent without a cwd has no workspace binding
  const noCwd = await command.handler({
    agent: { id: 'sess-none', session: { id: 'sess-none', header: {} } },
    rawInput: `preset-save ${JSON.stringify({ scope: 'workspace', name: 'W', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })}`,
  })
  expect(JSON.parse(noCwd.text).status).toBe('no-workspace')
})

test('preset-save from:applied is server-authoritative — client-sent sets are never trusted', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  mkdirSync(join(root, 'custom', 'alpha'), { recursive: true })
  writeFileSync(join(root, 'custom', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha fixture\n---\nALPHA\n')
  const { callJson } = mountCapabilities(root, { customSkillDirs: [join(root, 'custom')] })
  const applied = await callJson('apply', { requestId: 'r-1', expectedRevision: 0, skills: ['alpha'], mcpServers: [] })
  expect(applied.payload.status).toBe('applied')

  const saved = await callJson('preset-save', {
    scope: 'global', name: 'Applied', from: 'applied',
    skills: ['bogus'], mcpServers: ['bogus'], unresolvedRefs: [{ kind: 'skill', ref: 'bogus' }],
  })
  expect(saved.payload.status).toBe('created')
  const loaded = await callJson('preset-load', { scope: 'global', presetId: 'applied' })
  expect(loaded.payload.status).toBe('ok')
  // the recorded sets come from the receipt state, not the client payload
  expect(loaded.payload.document.selection.skills.map(identity => identity.name)).toEqual(['alpha'])
  expect(loaded.payload.document.selection.skills[0].scope).toBe('custom')
  expect(loaded.payload.document.selection.mcpServers).toEqual([])
  expect(loaded.payload.document.selection.unresolvedRefs).toEqual([])
})

// ---- preset-load -------------------------------------------------------------

test('preset-load: returns the stored document; absent and invalid ids are explicit', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  await callJson('preset-save', { scope: 'global', name: 'Keep', from: 'draft', skills: [identityFixture()], mcpServers: [], unresolvedRefs: [] })
  const loaded = await callJson('preset-load', { scope: 'global', presetId: 'keep' })
  expect(loaded.payload.status).toBe('ok')
  expect(loaded.payload.revision).toBe(1)
  expect(loaded.payload.document.name).toBe('Keep')
  expect(loaded.payload.document.selection.skills).toEqual([identityFixture()])
  expect((await callJson('preset-load', { scope: 'global', presetId: 'ghost' })).payload.status).toBe('absent')
  expect((await callJson('preset-load', { scope: 'elsewhere', presetId: 'keep' })).kind).toBe('error')
  expect((await callJson('preset-load', { scope: 'global', presetId: 'not a segment' })).kind).toBe('error')
})

// ---- preset-delete -----------------------------------------------------------

test('preset-delete: deletes under CAS; a stale revision conflicts and keeps the preset', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  await callJson('preset-save', { scope: 'global', name: 'Doomed', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })
  const stale = await callJson('preset-delete', { scope: 'global', presetId: 'doomed', expectedRevision: 9 })
  expect(stale.payload.status).toBe('revision-conflict')
  expect((await callJson('presets')).payload.presets).toHaveLength(1)
  const deleted = await callJson('preset-delete', { scope: 'global', presetId: 'doomed', expectedRevision: 1 })
  expect(deleted.payload.status).toBe('deleted')
  expect((await callJson('presets')).payload.presets).toEqual([])
  expect((await callJson('preset-delete', { scope: 'global', presetId: 'doomed', expectedRevision: 'x' })).kind).toBe('error')
})

// ---- preset-export -----------------------------------------------------------

test('preset-export: package is the default v2; document is the v1 verbatim path; bad format rejected', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  await callJson('preset-save', { scope: 'global', name: 'Export Me', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })

  const asPackage = await callJson('preset-export', { scope: 'global', presetId: 'export-me' })
  expect(asPackage.kind).toBe('success')
  expect(asPackage.payload.status).toBe('ok')
  expect(asPackage.payload.format).toBe('package')
  expect(asPackage.payload.document.version).toBe(2)
  expect(asPackage.payload.document.name).toBe('Export Me')
  for (const field of ['selection', 'builtin', 'bundled', 'warnings']) {
    expect(asPackage.payload.document[field] !== undefined).toBe(true)
  }

  const asDocument = await callJson('preset-export', { scope: 'global', presetId: 'export-me', format: 'document' })
  expect(asDocument.payload.status).toBe('ok')
  expect(asDocument.payload.document.version).toBe(1)
  expect(asDocument.payload.document.scope).toBe('global')
  expect(asDocument.payload.document.presetId).toBe('export-me')
  expect(asDocument.payload.document.name).toBe('Export Me')

  expect((await callJson('preset-export', { scope: 'global', presetId: 'export-me', format: 'xml' })).kind).toBe('error')
  expect((await callJson('preset-export', { scope: 'global', presetId: 'ghost' })).payload.status).toBe('absent')
  expect((await callJson('preset-export', { scope: 'global', presetId: 'ghost', format: 'document' })).payload.status).toBe('absent')
})

test('preset-export package round-trips the applied selection through the live inventory', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  mkdirSync(join(root, 'custom', 'alpha'), { recursive: true })
  writeFileSync(join(root, 'custom', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha fixture\n---\nALPHA\n')
  const { callJson } = mountCapabilities(root, { customSkillDirs: [join(root, 'custom')] })
  await callJson('apply', { requestId: 'r-1', expectedRevision: 0, skills: ['alpha'], mcpServers: [] })
  await callJson('preset-save', { scope: 'global', name: 'Round', from: 'applied' })
  const exported = await callJson('preset-export', { scope: 'global', presetId: 'round' })
  expect(exported.payload.status).toBe('ok')
  const pkg = exported.payload.document
  expect(pkg.version).toBe(2)
  // the custom-scope local Skill travels as bundled content (targetScope user)
  expect(pkg.bundled).toHaveLength(1)
  expect(pkg.bundled[0].targetScope).toBe('user')
  expect(pkg.bundled[0].name).toBe('alpha')
  expect(pkg.bundled[0].files.find(file => file.path === 'SKILL.md').content).toContain('name: alpha')
  expect(pkg.selection.skills).toEqual([])
})

// ---- preset-import (v1 + v2 dispatch) ----------------------------------------

test('preset-import v1: binds configured MCP only; poison documents reject with zero writes', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  await callJson('mcp-add', { identity: 'docs', label: 'Docs', command: 'npx' })
  const document = {
    version: 1, scope: 'global', presetId: 'shared', name: 'Shared',
    selection: {
      skills: [{ kind: 'git', repository: 'o/r', ref: 'main', name: 'remote-tool' }],
      mcpServers: [{ identity: 'docs', label: 'Docs' }, { identity: 'ghost', label: 'Ghost' }],
      unresolvedRefs: [],
    },
  }
  const imported = await callJson('preset-import', { document, scope: 'global' })
  expect(imported.kind).toBe('success')
  expect(imported.payload.status).toBe('created')
  expect(imported.payload.presetId).toBe('shared')
  expect(imported.payload.bound).toEqual({ mcpServers: 1, unresolvedRefs: 2 })
  const loaded = await callJson('preset-load', { scope: 'global', presetId: 'shared' })
  expect(loaded.payload.document.selection.mcpServers).toEqual(['docs'])
  expect(loaded.payload.document.selection.skills).toEqual([])
  expect(loaded.payload.document.selection.unresolvedRefs).toHaveLength(2)
  // importing and loading installed nothing: the session's effective set is
  // exactly the baseline it was before (no Apply happened)
  const receipt = await callJson('receipt')
  expect(receipt.payload.status).toBe('applied')
  expect(receipt.payload.revision).toBe(0)
  expect(receipt.payload.effective.skills).not.toContain('remote-tool')
  // a name collision is zero-write unless explicitly decided
  const conflict = await callJson('preset-import', { document: { ...document, presetId: 'shared-2' }, scope: 'global' })
  expect(conflict.payload.status).toBe('name-conflict')
  expect((await callJson('presets')).payload.presets).toHaveLength(1)
  const replaced = await callJson('preset-import', { document: { ...document, presetId: 'shared-2' }, scope: 'global', onNameConflict: 'replace' })
  expect(replaced.payload.status).toBe('created')

  // poison: unknown version / unknown field — atomic rejection, zero writes
  const unknown = await callJson('preset-import', { document: { ...document, version: 99, presetId: 'poison-1' }, scope: 'global' })
  expect(unknown.kind).toBe('error')
  expect(unknown.payload.status).toBe('rejected')
  expect(unknown.payload.reason).toContain('unknown-version')
  const rogue = await callJson('preset-import', { document: { ...document, presetId: 'poison-2', rogue: true }, scope: 'global' })
  expect(rogue.kind).toBe('error')
  expect(rogue.payload.status).toBe('rejected')
  expect(rogue.payload.reason).toContain('unknown-field')
  expect((await callJson('presets')).payload.presets).toHaveLength(2)
  // a v2-shaped document does NOT take the v1 path
  const v2 = await callJson('preset-import', {
    document: { version: 2, name: 'V2', selection: { skills: [], mcpServers: [], unresolvedRefs: [] }, builtin: [], bundled: [], warnings: [] },
    scope: 'global',
  })
  expect(v2.payload.status).toBe('created')
  expect(v2.payload.installed).toEqual([])
})

// ---- default-get / default-save / default-clear ------------------------------

test('default verbs: absent → explicit empty set → stale conflict → cleared marker (clear ≠ empty set)', { skip: storePlatformSkip }, async () => {
  const root = tmp()
  const { callJson } = mountCapabilities(root)
  expect((await callJson('default-get')).payload.status).toBe('absent')

  const saved = await callJson('default-save', { from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })
  expect(saved.payload.status).toBe('saved')
  expect(saved.payload.revision).toBe(1)
  const got = await callJson('default-get')
  expect(got.payload.status).toBe('ok')
  expect(got.payload.cleared).toBe(false)
  // an explicit empty set is a real, savable value — not a cleared marker
  expect(got.payload.snapshot.skills).toEqual([])
  expect(got.payload.snapshot.mcpServers).toEqual([])

  const savedAgain = await callJson('default-save', { from: 'draft', skills: [identityFixture()], mcpServers: [], unresolvedRefs: [] })
  expect(savedAgain.payload.status).toBe('saved')
  expect(savedAgain.payload.revision).toBe(2)
  const stale = await callJson('default-save', { from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [], expectedRevision: 1 })
  expect(stale.payload.status).toBe('revision-conflict')
  const current = await callJson('default-get')
  expect(current.payload.snapshot.skills).toHaveLength(1)

  const cleared = await callJson('default-clear')
  expect(cleared.payload.status).toBe('cleared')
  const afterClear = await callJson('default-get')
  expect(afterClear.payload.status).toBe('ok')
  expect(afterClear.payload.cleared).toBe(true)
  // clearing is distinct from the explicit empty set saved earlier
  expect(afterClear.payload.snapshot.skills).toBeUndefined()

  expect((await callJson('default-save', { from: 'nowhere' })).kind).toBe('error')
  expect((await callJson('default-save', { from: 'draft', expectedRevision: -1 })).kind).toBe('error')
  expect((await callJson('default-clear', { expectedRevision: 99 })).payload.status).toBe('revision-conflict')
})

// ---- v2 round-trip across two machines ----------------------------------------

test('save → export package → dryRun → confirmed import round-trips between two isolated roots', { skip: storePlatformSkip }, async () => {
  const rootA = tmp()
  mkdirSync(join(rootA, 'custom', 'alpha'), { recursive: true })
  writeFileSync(join(rootA, 'custom', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: alpha fixture\n---\nALPHA\n')
  const machineA = mountCapabilities(rootA, { customSkillDirs: [join(rootA, 'custom')] })
  await machineA.callJson('apply', { requestId: 'r-1', expectedRevision: 0, skills: ['alpha'], mcpServers: [] })
  await machineA.callJson('preset-save', { scope: 'global', name: 'Travel', from: 'applied' })
  const exported = await machineA.callJson('preset-export', { scope: 'global', presetId: 'travel' })
  expect(exported.payload.status).toBe('ok')

  // machine B: a fresh isolated root without the custom skill
  const rootB = tmp()
  const machineB = mountCapabilities(rootB)
  const dry = await machineB.callJson('preset-import', { document: exported.payload.document, scope: 'global', dryRun: true })
  expect(dry.payload.status).toBe('dry-run')
  expect(dry.payload.install).toHaveLength(1)
  expect(dry.payload.install[0].name).toBe('alpha')
  expect(dry.payload.install[0].targetScope).toBe('user')
  expect(existsSync(join(rootB, 'skills'))).toBe(false)

  const confirmed = await machineB.callJson('preset-import', { document: exported.payload.document, scope: 'global' })
  expect(confirmed.payload.status).toBe('created')
  expect(confirmed.payload.installed).toHaveLength(1)
  expect(readFileSync(join(rootB, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('name: alpha')
  const loaded = await machineB.callJson('preset-load', { scope: 'global', presetId: 'travel' })
  expect(loaded.payload.document.selection.skills.map(identity => identity.name)).toEqual(['alpha'])
})
