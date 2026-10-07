// Task 6.5 of the session-capability-manager change: initialization priority
// for a root Weir session without an accepted selection record — a saved
// workspace default wins (explicit empty included), otherwise the explicit
// builtin-Skills baseline plus composition-enabled managed MCP identities.
// Historical content grants nothing; the gate is weir-preset scoped by
// composition.
import { test, expect, storePlatformSkip } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInitialSelection, bindDefaultSkillNames } from '../src/capabilities/initial-selection.js'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'

const home = () => mkdtempSync(join(tmpdir(), 'weir-init-'))
const rootOf = home => join(home, 'weir', 'profiles', 'it', 'capabilities')
const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const builtinA = identity('weir-builtin', 'deep-work')
const builtinB = identity('weir-builtin', 'research')

test('6.5 a saved workspace default wins verbatim and reports unresolved refs', () => {
  const resolved = resolveInitialSelection({
    defaultsRecord: { kind: 'ok', payload: { skills: [alpha], mcpServers: ['docs'], unresolvedRefs: [{ ref: 'gone-skill' }] } },
    builtinIdentities: [builtinA],
  })
  expect(resolved.source).toBe('workspace-default')
  expect(resolved.selection.skills.map(s => s.name)).toEqual(['alpha'])
  expect(resolved.selection.mcpServers).toEqual(['docs'])
  expect(resolved.missing).toEqual([{ ref: 'gone-skill' }])
})

test('6.5 an explicit empty default is a real choice, not a missing one', () => {
  const resolved = resolveInitialSelection({ defaultsRecord: { kind: 'ok', payload: { skills: [], mcpServers: [] } } })
  expect(resolved.source).toBe('workspace-default')
  expect(resolved.selection).toEqual({ skills: [], mcpServers: [] })
})

test('6.5 an unreadable default fails closed, never silently treated as missing', () => {
  for (const kind of ['corrupt', 'unknown-schema', 'torn']) {
    assert.throws(() => resolveInitialSelection({ defaultsRecord: { kind } }), new RegExp(kind))
  }
})

test('6.5 no default yields the builtin baseline plus enabled managed MCP, history grants nothing', () => {
  const resolved = resolveInitialSelection({
    defaultsRecord: { kind: 'absent' },
    builtinIdentities: [builtinA, builtinB],
    enabledMcpIdentities: ['docs'],
  })
  expect(resolved.source).toBe('builtin-baseline')
  expect(resolved.selection.skills.map(s => s.name)).toEqual(['deep-work', 'research'])
  expect(resolved.selection.mcpServers).toEqual(['docs'])
  expect(resolved.missing).toEqual([])
})

const candidateOf = value => ({
  status: 'parsed', name: value.name, identity: value, path: `/${value.scope}/${value.name}/SKILL.md`,
  digest: `d-${value.name}`, invocation: { modelInvocable: true, userInvocable: true },
})

// Workspace-default name binding: a default saved from the client draft
// (default-save from:'draft') stores plain name strings; they bind against
// the live inventory by unique name, never guessed, never failing closed.
test('default binding: identity-shaped entries pass through verbatim', () => {
  const bound = bindDefaultSkillNames([alpha, builtinA], [candidateOf(alpha)])
  expect(bound.skills[0] === alpha).toBe(true)
  expect(bound.skills[1] === builtinA).toBe(true)
  expect(bound.missing).toEqual([])
})

test('default binding: a unique name binds to that candidate identity', () => {
  const bound = bindDefaultSkillNames(['deep-work'], [candidateOf(builtinA), candidateOf(builtinB)])
  expect(bound.skills[0] === builtinA).toBe(true)
  expect(bound.missing).toEqual([])
})

test('default binding: an unknown name is missing, never guessed', () => {
  const bound = bindDefaultSkillNames(['ghost-skill'], [candidateOf(builtinA)])
  expect(bound.skills).toEqual([])
  expect(bound.missing).toEqual([{ kind: 'skill', ref: 'ghost-skill', reason: 'no longer in the inventory' }])
})

test('default binding: an ambiguous name is missing, never guessed', () => {
  const dupUser = candidateOf(identity('user', 'dup'))
  const dupProject = candidateOf(identity('project', 'dup'))
  const bound = bindDefaultSkillNames(['dup'], [dupUser, dupProject])
  expect(bound.skills).toEqual([])
  expect(bound.missing).toEqual([{ kind: 'skill', ref: 'dup', reason: 'ambiguous in the inventory' }])
})

test('default binding: garbage entries are missing per entry, never throwing', () => {
  const bound = bindDefaultSkillNames([42, null, builtinB], [candidateOf(builtinB)])
  expect(bound.skills[0] === builtinB).toBe(true)
  expect(bound.missing.length).toBe(2)
  expect(bound.missing.every(entry => entry.kind === 'skill')).toBe(true)
})

test('default binding: a non-array candidates value is tolerated', () => {
  const bound = bindDefaultSkillNames(['deep-work'], null)
  expect(bound.skills).toEqual([])
  expect(bound.missing).toEqual([{ kind: 'skill', ref: 'deep-work', reason: 'no longer in the inventory' }])
})

function mount(home, { inventoryCandidates }) {
  let registered
  const ctx = {
    skills: { registerProvider(create) { registered = create({ invalidate() {} }) } },
    on() {},
    get(name) { return name === 'profileContext' ? { home, name: 'it' } : undefined },
  }
  createSkillSelectionPlugin({
    inventory: async () => ({ complete: true, candidates: inventoryCandidates }),
    office: async () => ({ complete: true, candidates: [] }),
    lifecycle: { agentCreated: () => undefined },
  })(ctx)
  return registered
}
const options = (sessionId, workspaceKey) => ({ cwd: '/ws', scope: { session: { id: sessionId, workspaceKey } } })

test('6.5 mounted: a saved workspace default selection drives a session without an accepted record', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const store = openCapabilityStore({ root: rootOf(dir), platform: 'darwin' })
  await store.commit({ kind: 'defaults', workspaceKey: 'ws-1' }, 0, () => ({ skills: [alpha], mcpServers: [], unresolvedRefs: [] }))
  const provider = mount(dir, { inventoryCandidates: [candidateOf(alpha), candidateOf(builtinA)] })
  const list = await provider.list(options('sess-1', 'ws-1'))
  const enabled = list.candidates.filter(item => item.invocation.modelInvocable).map(item => item.name)
  expect(enabled).toEqual(['alpha'])
})

test('regression: a default saved from the draft (name strings) drives a new session', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const store = openCapabilityStore({ root: rootOf(dir), platform: 'darwin' })
  // Exactly what `/capabilities default-save` with from:'draft' commits:
  // plain name strings, not SkillIdentity objects.
  await store.commit({ kind: 'defaults', workspaceKey: 'ws-draft' }, 0, () => ({ skills: ['deep-work', 'research'], mcpServers: [], unresolvedRefs: [] }))
  const provider = mount(dir, { inventoryCandidates: [candidateOf(builtinA), candidateOf(builtinB)] })
  const list = await provider.list(options('sess-draft', 'ws-draft'))
  const enabled = list.candidates.filter(item => item.invocation.modelInvocable).map(item => item.name)
  expect(enabled).toEqual(['deep-work', 'research'])
})

test('regression: one unbindable name degrades to missing, the default does not fail closed', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const store = openCapabilityStore({ root: rootOf(dir), platform: 'darwin' })
  await store.commit({ kind: 'defaults', workspaceKey: 'ws-part' }, 0, () => ({ skills: ['deep-work', 'ghost-skill'], mcpServers: [], unresolvedRefs: [] }))
  const provider = mount(dir, { inventoryCandidates: [candidateOf(builtinA), candidateOf(builtinB)] })
  const list = await provider.list(options('sess-part', 'ws-part'))
  const enabled = list.candidates.filter(item => item.invocation.modelInvocable).map(item => item.name)
  expect(enabled).toEqual(['deep-work'])
  expect(provider.status(options('sess-part', 'ws-part')).error ?? null).toBe(null)
})

test('6.5 mounted: without a default the builtin baseline is selected and reported', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const provider = mount(dir, { inventoryCandidates: [candidateOf(alpha), candidateOf(builtinA), candidateOf(builtinB)] })
  const list = await provider.list(options('sess-2', null))
  const enabled = list.candidates.filter(item => item.invocation.modelInvocable).map(item => item.name)
  expect(enabled).toEqual(['deep-work', 'research'])
})

test('6.5 mounted: an unreadable default fails closed with a classified reason', async () => {
  const dir = home()
  mkdirSync(join(rootOf(dir), 'workspaces', 'ws-2'), { recursive: true })
  writeFileSync(join(rootOf(dir), 'workspaces', 'ws-2', 'defaults.json'), '{')
  const provider = mount(dir, { inventoryCandidates: [candidateOf(builtinA)] })
  await provider.list(options('sess-3', 'ws-2'))
  const status = provider.status(options('sess-3', 'ws-2'))
  expect(status.reason ?? status.note?.reason ?? status.error ? true : false).toBe(true)
  expect((await provider.list(options('sess-3', 'ws-2'))).candidates.every(item => !item.invocation.modelInvocable)).toBe(true)
})

test('6.5+6.2 mounted: a captured inherited snapshot drives a subagent without an accepted record', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const store = openCapabilityStore({ root: rootOf(dir), platform: 'darwin' })
  await store.commit({ kind: 'inherited', sessionId: 'child-1' }, 0, () => ({ skills: [alpha], mcpServers: [], origin: 'inherited' }))
  const provider = mount(dir, { inventoryCandidates: [candidateOf(alpha), candidateOf(builtinA)] })
  const options = { cwd: '/ws', scope: { session: { id: 'child-1', header: { delegationDepth: 1, parentSession: 'p' } } } }
  const list = await provider.list(options)
  const enabled = list.candidates.filter(item => item.invocation.modelInvocable).map(item => item.name)
  expect(enabled).toEqual(['alpha'])
})

test('6.4 mounted: a snapshot-less subagent is refused, never granted the root baseline', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const provider = mount(dir, { inventoryCandidates: [candidateOf(builtinA)] })
  const options = { cwd: '/ws', scope: { session: { id: 'child-2', header: { delegationDepth: 1, parentSession: 'p' } } } }
  await provider.list(options)
  const status = provider.status(options)
  expect(status.reason ?? status.note?.reason).toBe('inherited-snapshot-unavailable')
  expect((await provider.list(options)).candidates.every(item => !item.invocation.modelInvocable)).toBe(true)
})

test('6.4 mounted: an undecodable inherited snapshot fails closed, never overwritten', { skip: storePlatformSkip }, async () => {
  const dir = home()
  mkdirSync(join(rootOf(dir), 'sessions', 'child-3'), { recursive: true })
  writeFileSync(join(rootOf(dir), 'sessions', 'child-3', 'inherited.json'), '{')
  const provider = mount(dir, { inventoryCandidates: [candidateOf(builtinA)] })
  const options = { cwd: '/ws', scope: { session: { id: 'child-3', header: { delegationDepth: 1, parentSession: 'p' } } } }
  await provider.list(options)
  const status = provider.status(options)
  expect(status.reason ?? status.note?.reason).toBe('inherited-snapshot-unavailable')
  expect((await provider.list(options)).candidates.every(item => !item.invocation.modelInvocable)).toBe(true)
})
