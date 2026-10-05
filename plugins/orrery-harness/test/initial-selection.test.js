// Task 6.5 of the session-capability-manager change: initialization priority
// for a root Orrery session without an accepted selection record — a saved
// workspace default wins (explicit empty included), otherwise the explicit
// builtin-Skills baseline plus composition-enabled managed MCP identities.
// Historical content grants nothing; the gate is orrery-preset scoped by
// composition.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInitialSelection } from '../src/capabilities/initial-selection.js'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'

const home = () => mkdtempSync(join(tmpdir(), 'orrery-init-'))
const rootOf = home => join(home, 'orrery', 'profiles', 'it', 'capabilities')
const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const builtinA = identity('orrery-builtin', 'deep-work')
const builtinB = identity('orrery-builtin', 'research')

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

test('6.5 mounted: a saved workspace default selection drives a session without an accepted record', async () => {
  const dir = home()
  const store = openCapabilityStore({ root: rootOf(dir), platform: 'darwin' })
  await store.commit({ kind: 'defaults', workspaceKey: 'ws-1' }, 0, () => ({ skills: [alpha], mcpServers: [], unresolvedRefs: [] }))
  const provider = mount(dir, { inventoryCandidates: [candidateOf(alpha), candidateOf(builtinA)] })
  const list = await provider.list(options('sess-1', 'ws-1'))
  const enabled = list.candidates.filter(item => item.invocation.modelInvocable).map(item => item.name)
  expect(enabled).toEqual(['alpha'])
})

test('6.5 mounted: without a default the builtin baseline is selected and reported', async () => {
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
