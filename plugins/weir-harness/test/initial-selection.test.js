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
import { createLifecycleSnapshots } from '../src/capabilities/lifecycle-snapshot.js'

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

function mount(home, { inventoryCandidates, lifecycle, manager = null }) {
  let registered
  const ctx = {
    skills: { registerProvider(create) { registered = create({ invalidate() {} }) } },
    on() {},
    get(name) {
      if (name === 'profileContext') return { home, name: 'it' }
      if (name === 'weirMcpManager') return manager
      return undefined
    },
  }
  createSkillSelectionPlugin({
    inventory: async () => ({ complete: true, candidates: inventoryCandidates }),
    office: async () => ({ complete: true, candidates: [] }),
    lifecycle: lifecycle ?? { agentCreated: () => undefined },
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

// --- Resolved initial set as an inheritable lifecycle snapshot (fork group 1) ---
// A session whose initial set was resolved (workspace default or builtin
// baseline) publishes it as a revision-0 lifecycle snapshot, so a synchronous
// depth-0 fork of a still-unapplied source captures that set instead of an
// empty one. Nothing is persisted for the source; a snapshot that appeared
// while the async resolution was in flight wins; an incomplete inventory is
// never published as an inheritable set.

test('fork: a resolved initial set is published at revision 0 and never persisted', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const lifecycle = createLifecycleSnapshots({ root: rootOf(dir), platform: 'darwin' })
  const provider = mount(dir, { inventoryCandidates: [candidateOf(builtinA), candidateOf(builtinB)], lifecycle })
  await provider.list(options('sess-init', null))
  const snapshot = lifecycle.snapshotFor('sess-init')
  expect(snapshot?.state).toBe('ready')
  expect(snapshot?.revision).toBe(0)
  expect(snapshot?.skills.map(identity => identity.name)).toEqual(['deep-work', 'research'])
  expect(snapshot?.captured).toBeNull()
  const store = openCapabilityStore({ root: rootOf(dir), platform: 'darwin' })
  expect((await store.read({ kind: 'selection', sessionId: 'sess-init' })).kind).toBe('absent')
  expect((await store.read({ kind: 'inherited', sessionId: 'sess-init' })).kind).toBe('absent')
})

test('fork: the resolved initial set carries the workspace default sets, MCP included', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const store = openCapabilityStore({ root: rootOf(dir), platform: 'darwin' })
  await store.commit({ kind: 'defaults', workspaceKey: 'ws-fork' }, 0, () => ({ skills: [alpha], mcpServers: ['docs'], unresolvedRefs: [] }))
  const lifecycle = createLifecycleSnapshots({ root: rootOf(dir), platform: 'darwin' })
  const provider = mount(dir, { inventoryCandidates: [candidateOf(alpha), candidateOf(builtinA)], lifecycle })
  await provider.list(options('sess-default-fork', 'ws-fork'))
  const snapshot = lifecycle.snapshotFor('sess-default-fork')
  expect(snapshot?.revision).toBe(0)
  expect(snapshot?.skills.map(identity => identity.name)).toEqual(['alpha'])
  expect(snapshot?.mcpServers).toEqual(['docs'])
})

test('fork: a snapshot that appears during the async resolution wins (no late overwrite)', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const lifecycle = createLifecycleSnapshots({ root: rootOf(dir), platform: 'darwin' })
  let provider
  const ctx = {
    skills: { registerProvider(create) { provider = create({ invalidate() {} }) } },
    on() {},
    get(name) { return name === 'profileContext' ? { home: dir, name: 'it' } : undefined },
  }
  createSkillSelectionPlugin({
    // The Apply/inheritance publication that races the initial resolution.
    inventory: async () => {
      lifecycle.publish('sess-race', { revision: 5, skills: [alpha], mcpServers: ['web'], captured: null })
      return { complete: true, candidates: [candidateOf(builtinA)] }
    },
    office: async () => ({ complete: true, candidates: [] }),
    lifecycle,
  })(ctx)
  await provider.list(options('sess-race', null))
  const snapshot = lifecycle.snapshotFor('sess-race')
  expect(snapshot?.revision).toBe(5)
  expect(snapshot?.skills.map(identity => identity.name)).toEqual(['alpha'])
  expect(snapshot?.mcpServers).toEqual(['web'])
})

test('fork: an incomplete inventory is never published as an inheritable initial set', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const lifecycle = createLifecycleSnapshots({ root: rootOf(dir), platform: 'darwin' })
  let provider
  const ctx = {
    skills: { registerProvider(create) { provider = create({ invalidate() {} }) } },
    on() {},
    get(name) { return name === 'profileContext' ? { home: dir, name: 'it' } : undefined },
  }
  createSkillSelectionPlugin({
    inventory: async () => ({ complete: false, candidates: [candidateOf(builtinA)] }),
    office: async () => ({ complete: true, candidates: [] }),
    lifecycle,
  })(ctx)
  await provider.list(options('sess-partial', null))
  expect(lifecycle.snapshotFor('sess-partial')).toBeNull()
})

test('fork: a depth-0 fork with no effective snapshot resolves its own root initialization', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const lifecycle = createLifecycleSnapshots({ root: rootOf(dir), platform: 'darwin' })
  const provider = mount(dir, { inventoryCandidates: [candidateOf(builtinA)], lifecycle })
  const forkOptions = { cwd: '/ws', scope: { session: { id: 'fork-root-init', header: { delegationDepth: 0, parentSession: 'ghost-parent' } } } }
  const list = await provider.list(forkOptions)
  expect(list.candidates.filter(item => item.invocation.modelInvocable).map(item => item.name)).toEqual(['deep-work'])
  expect(provider.status(forkOptions).error ?? null).toBe(null)
  const snapshot = lifecycle.snapshotFor('fork-root-init')
  expect(snapshot?.revision).toBe(0)
  expect(snapshot?.skills.map(identity => identity.name)).toEqual(['deep-work'])
})

test('live visibility: initial selection syncs the current session immediately after lifecycle publication', { skip: storePlatformSkip }, async () => {
  const dir = home()
  const lifecycle = createLifecycleSnapshots({ root: rootOf(dir), platform: 'darwin' })
  const order = []
  const publish = lifecycle.publish
  lifecycle.publish = (sessionId, snapshot) => {
    order.push(`publish:${sessionId}`)
    return publish(sessionId, snapshot)
  }
  const manager = {
    syncSession(sessionId) {
      expect(lifecycle.snapshotFor(sessionId)?.state).toBe('ready')
      order.push(`sync:${sessionId}`)
    },
  }
  const provider = mount(dir, { inventoryCandidates: [candidateOf(builtinA)], lifecycle, manager })
  await provider.list(options('sess-initial-visibility', null))
  order.push('response')
  expect(order).toEqual([
    'publish:sess-initial-visibility',
    'sync:sess-initial-visibility',
    'response',
  ])
})
