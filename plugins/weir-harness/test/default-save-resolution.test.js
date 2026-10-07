// Regression for the default-save write-path resolution (default-save-resolve-
// identities): `from:'draft'` resolves draft skill NAMES to exact
// SkillIdentity objects before persisting — a name with two parsed inventory
// candidates (e.g. `research` duplicated across builtin and user scope) must
// not be stored as a bare name, because the read side's unique-name binding
// would refuse it in every new session forever (the 15/16 bug).
import { test, expect } from './helpers.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'
import { resolveSkillNamesForSave } from '../src/capabilities/initial-selection.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'
import { discoverSkillInventory, resolveSkillRoots } from '../src/capabilities/skill-inventory.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { workspaceKeyOf } from '../src/capabilities/preset-library.js'

// ---- pure helper ------------------------------------------------------------

const builtinResearch = createSkillIdentity({ scope: 'weir-builtin', root: '/b', name: 'research', opaqueId: 'b-research' })
const userResearch = createSkillIdentity({ scope: 'user', root: '/u', name: 'research', opaqueId: 'u-research' })
const builtinDebugging = createSkillIdentity({ scope: 'weir-builtin', root: '/b', name: 'debugging', opaqueId: 'b-debugging' })
const candidateOf = (name, identity) => ({ status: 'parsed', name, identity })
const candidates = [candidateOf('research', builtinResearch), candidateOf('research', userResearch), candidateOf('debugging', builtinDebugging)]

test('resolveSkillNamesForSave: unique name binds to its single candidate identity', () => {
  const resolved = resolveSkillNamesForSave(['debugging'], candidates, [])
  expect(resolved.identities).toEqual([builtinDebugging])
  expect(resolved.missing).toEqual([])
  expect(resolved.ambiguous).toEqual([])
})

test('resolveSkillNamesForSave: identity-shaped entries pass through verbatim', () => {
  const resolved = resolveSkillNamesForSave([userResearch], candidates, [])
  expect(resolved.identities).toEqual([userResearch])
  expect(resolved.missing).toEqual([])
  expect(resolved.ambiguous).toEqual([])
})

test('resolveSkillNamesForSave: ambiguous name binds only via a unique applied identity', () => {
  // No applied evidence → refused as ambiguous, never a guess.
  const refused = resolveSkillNamesForSave(['research'], candidates, [])
  expect(refused.identities).toEqual([])
  expect(refused.ambiguous).toEqual(['research'])
  // Exactly one applied identity of that name → authoritative disambiguation.
  const bound = resolveSkillNamesForSave(['research'], candidates, [userResearch])
  expect(bound.identities).toEqual([userResearch])
  expect(bound.ambiguous).toEqual([])
})

test('resolveSkillNamesForSave: unknown names and garbage entries are missing, never thrown', () => {
  const resolved = resolveSkillNamesForSave(['nonexistent', 42, ''], candidates, [])
  expect(resolved.identities).toEqual([])
  expect(resolved.missing).toEqual(['nonexistent', 42, ''])
  expect(resolved.ambiguous).toEqual([])
  // Non-array input degrades to an empty resolution.
  expect(resolveSkillNamesForSave(null, candidates, [])).toEqual({ identities: [], missing: [], ambiguous: [] })
})

// ---- command level ----------------------------------------------------------

const tmp = () => mkdtempSync(join(tmpdir(), 'weir-save-resolution-'))

/** A user-scope duplicate of the builtin `research` skill. */
const plantUserResearch = root => {
  const dir = join(root, 'agents-home', 'skills', 'research')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: research\ndescription: User-scope duplicate research skill.\n---\nbody\n')
}

/** Mount the plugin with hermetic profile roots (preset-verbs ctx-stub pattern). */
const mountCapabilities = root => {
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
      if (name === 'profileContext') return { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  createSkillSelectionPlugin()(ctx, { machineId: 'weir-it-machine', customSkillDirs: [], agentsHome: join(root, 'agents-home') })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  const agentOf = id => ({ id, session: { id, header: { cwd: root } } })
  const callJson = async (rawInput, payload, id = 'sess-verbs') => {
    const result = await command.handler({ agent: agentOf(id), rawInput: payload === undefined ? rawInput : `${rawInput} ${JSON.stringify(payload)}` })
    return { kind: result.kind, payload: (() => { try { return JSON.parse(result.text) } catch { return null } })(), text: result.text }
  }
  return { callJson, provider, command, agentOf }
}

const storeOf = root => openCapabilityStore({ root: join(root, 'weir', 'profiles', 'it', 'capabilities'), platform: 'darwin' })

/** The inventory identities exactly as the mounted plugin discovers them. */
const discoverIdentities = async root => {
  const roots = await resolveSkillRoots({
    cwd: root,
    dshHome: root,
    agentsHome: join(root, 'agents-home'),
    customSkillDirs: [],
    bundledSkillDir: undefined,
    weirBuiltinDir: fileURLToPath(new URL('../skills/', import.meta.url)),
  })
  const snapshot = await discoverSkillInventory({ roots, machineId: 'weir-it-machine' })
  return snapshot.candidates.filter(candidate => candidate.status === 'parsed').map(candidate => candidate.identity)
}

test('default-save from:draft persists resolved identities, and a new session gets every skill (15/16 regression)', async () => {
  const root = tmp()
  plantUserResearch(root)
  const { callJson } = mountCapabilities(root)

  // The session's effective selection is the builtin baseline (it contains
  // exactly one `research` — the builtin one), so the ambiguous name
  // disambiguates to the builtin identity.
  const saved = await callJson('default-save', { from: 'draft', skills: ['debugging', 'research'], mcpServers: [], unresolvedRefs: [] })
  expect(saved.kind).toBe('success')
  expect(saved.payload.status).toBe('saved')

  // The record carries IDENTITIES, never bare names.
  const record = await storeOf(root).read({ kind: 'defaults', workspaceKey: workspaceKeyOf({ cwd: root }) })
  expect(record.kind).toBe('ok')
  expect(record.payload.skills.every(entry => typeof entry === 'object' && entry !== null)).toBe(true)
  const discovered = await discoverIdentities(root)
  const byKey = entry => JSON.stringify([entry.scope, entry.root, entry.name, entry.provenance, entry.opaqueId ?? null])
  const discoveredKeys = new Set(discovered.map(byKey))
  for (const entry of record.payload.skills) expect(discoveredKeys.has(byKey(entry))).toBe(true)
  const research = record.payload.skills.find(entry => entry.name === 'research')
  expect(research.scope).toBe('weir-builtin')

  // THE regression: a brand-new session of this workspace gets BOTH skills —
  // before the write-path resolution, the bare `research` name was ambiguous
  // and the new session silently started one skill short.
  const receipt = await callJson('receipt', undefined, 'sess-new')
  expect(receipt.kind).toBe('success')
  expect(receipt.payload.effective.skills.sort()).toEqual(['debugging', 'research'])
})

test('default-save from:draft refuses an ambiguous name without applied evidence (zero write)', async () => {
  const root = tmp()
  plantUserResearch(root)
  const { callJson } = mountCapabilities(root)

  // Pin an explicit EMPTY applied selection: no applied `research` exists, so
  // the duplicated name has no disambiguation evidence.
  await storeOf(root).commit({ kind: 'selection', sessionId: 'sess-verbs' }, 0, () => ({ skills: [], mcpServers: [] }))

  const refused = await callJson('default-save', { from: 'draft', skills: ['research'], mcpServers: [], unresolvedRefs: [] })
  expect(refused.kind).toBe('error')
  expect(refused.payload.status).toBe('ambiguous')
  expect(refused.payload.ambiguous).toEqual(['research'])
  // Zero write: the defaults record stays absent.
  expect((await storeOf(root).read({ kind: 'defaults', workspaceKey: workspaceKeyOf({ cwd: root }) })).kind).toBe('absent')
})

test('default-save from:draft refuses unknown names (zero write)', async () => {
  const root = tmp()
  plantUserResearch(root)
  const { callJson } = mountCapabilities(root)

  const refused = await callJson('default-save', { from: 'draft', skills: ['nonexistent-skill'], mcpServers: [], unresolvedRefs: [] })
  expect(refused.kind).toBe('error')
  expect(refused.payload.status).toBe('missing')
  expect(refused.payload.missing).toEqual(['nonexistent-skill'])
  expect((await storeOf(root).read({ kind: 'defaults', workspaceKey: workspaceKeyOf({ cwd: root }) })).kind).toBe('absent')
})
