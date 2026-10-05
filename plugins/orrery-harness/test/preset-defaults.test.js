// Tasks 9.1/9.4 of the session-capability-manager change: preset library
// lifecycle across namespaces with CAS, and the workspace-defaults
// transaction semantics (clear ≠ empty, copy snapshot, conflicts).
import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPresetLibrary, workspaceKeyOf } from '../src/capabilities/preset-library.js'
import { createDefaultsTransaction } from '../src/capabilities/defaults-transaction.js'
import { resolveInitialSelection } from '../src/capabilities/initial-selection.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'

const base = () => mkdtempSync(join(tmpdir(), 'orrery-presets-'))
const storeOf = root => openCapabilityStore({ root, platform: 'darwin' })
const alpha = createSkillIdentity({ scope: 'user', root: '/user', name: 'alpha', opaqueId: 'user-alpha' })
const doc = (name, extras = {}) => ({ name, selection: { skills: [alpha], mcpServers: [], unresolvedRefs: [], ...extras } })

test('9.1 create/load/edit/delete lifecycle across two namespaces, workspace preset invisible elsewhere', async () => {
  const root = base()
  const library = createPresetLibrary({ store: storeOf(root) })
  expect((await library.create({ scope: 'global', presetId: 'team', document: doc('Team') })).status).toBe('created')
  expect((await library.load('global', 'team')).document.name).toBe('Team')
  // Same display name in the OTHER namespace never shadows or conflicts.
  expect((await library.create({ scope: 'workspace', presetId: 'ws-p', workspaceKey: workspaceKeyOf({ cwd: '/ws/a' }), document: doc('Team') })).status).toBe('created')
  // A workspace preset is only visible in its own workspace.
  expect((await library.load('workspace', 'ws-p', workspaceKeyOf({ cwd: '/ws/b' }))).kind).toBe('absent')
  expect((await library.load('workspace', 'ws-p', workspaceKeyOf({ cwd: '/ws/a' }))).kind).toBe('ok')
  // Edit under CAS, then delete.
  const current = await library.load('workspace', 'ws-p', workspaceKeyOf({ cwd: '/ws/a' }))
  expect((await library.edit({ scope: 'workspace', presetId: 'ws-p', workspaceKey: workspaceKeyOf({ cwd: '/ws/a' }), expectedRevision: current.revision, mutate: () => doc('Team v2') })).status).toBe('edited')
  expect((await library.load('workspace', 'ws-p', workspaceKeyOf({ cwd: '/ws/a' }))).document.name).toBe('Team v2')
  const revision = (await library.load('workspace', 'ws-p', workspaceKeyOf({ cwd: '/ws/a' }))).revision
  expect((await library.remove({ scope: 'workspace', presetId: 'ws-p', workspaceKey: workspaceKeyOf({ cwd: '/ws/a' }), expectedRevision: revision })).status).toBe('deleted')
})

test('9.1 a display-name collision needs an explicit decision; unconfirmed replace is rejected', async () => {
  const library = createPresetLibrary({ store: storeOf(base()) })
  const names = new Map([['other', 'Team']])
  const allDisplayNames = async () => names
  expect((await library.create({ scope: 'global', presetId: 'new-one', document: doc('Team'), allDisplayNames })).status).toBe('name-conflict')
  expect((await library.create({ scope: 'global', presetId: 'new-one', document: doc('Team'), onNameConflict: 'rename', allDisplayNames })).status).toBe('rename-required')
  expect((await library.create({ scope: 'global', presetId: 'new-one', document: doc('Team'), onNameConflict: 'replace', allDisplayNames })).status).toBe('created')
})

test('9.1 two clients editing one preset: the fresh state holds, the stale request conflicts and overwrites nothing', async () => {
  const root = base()
  const store = storeOf(root)
  const library = createPresetLibrary({ store })
  await library.create({ scope: 'global', presetId: 'team', document: doc('Team') })
  const stale = (await library.load('global', 'team')).revision
  // Client A edits successfully at the same expected revision.
  expect((await library.edit({ scope: 'global', presetId: 'team', expectedRevision: stale, mutate: () => doc('Team A') })).status).toBe('edited')
  // Client B's edit at the stale revision is a visible conflict.
  const conflict = await library.edit({ scope: 'global', presetId: 'team', expectedRevision: stale, mutate: () => doc('Team B') })
  expect(conflict.status).toBe('revision-conflict')
  expect((await library.load('global', 'team')).document.name).toBe('Team A')
})

test('9.4 save does not need an Apply, is a copy snapshot, and clearing is not an empty set', async () => {
  const root = base()
  const transaction = createDefaultsTransaction({ store: storeOf(root), now: () => 7 })
  const snapshot = { skills: [alpha], mcpServers: ['docs'], unresolvedRefs: [{ kind: 'skill', ref: { name: 'x' } }] }
  expect((await transaction.save({ workspaceKey: workspaceKeyOf({ cwd: '/ws/a' }), expectedRevision: 0, snapshot })).status).toBe('saved')
  const saved = await transaction.read(workspaceKeyOf({ cwd: '/ws/a' }))
  expect(saved.snapshot.skills[0].name).toBe('alpha')
  expect(saved.snapshot.savedAt).toBe(7)
  // The snapshot is a copy: mutating the draft afterwards changes nothing durable.
  snapshot.skills.length = 0
  expect((await transaction.read(workspaceKeyOf({ cwd: '/ws/a' }))).snapshot.skills).toHaveLength(1)
  // Explicit empty is a real savable choice.
  expect((await transaction.save({ workspaceKey: workspaceKeyOf({ cwd: '/ws/b' }), expectedRevision: 0, snapshot: { skills: [], mcpServers: [], unresolvedRefs: [] } })).status).toBe('saved')
  expect(resolveInitialSelection({ defaultsRecord: { kind: 'ok', payload: (await transaction.read(workspaceKeyOf({ cwd: '/ws/b' }))).snapshot } }).source).toBe('workspace-default')
  // Clear removes the default; a fresh session afterwards gets the baseline.
  const revision = (await transaction.read(workspaceKeyOf({ cwd: '/ws/b' }))).revision
  expect((await transaction.clear({ workspaceKey: workspaceKeyOf({ cwd: '/ws/b' }), expectedRevision: revision })).status).toBe('cleared')
  expect(resolveInitialSelection({ defaultsRecord: { kind: 'ok', payload: (await transaction.read(workspaceKeyOf({ cwd: '/ws/b' }))).snapshot }, builtinIdentities: [alpha] }).source).toBe('builtin-baseline')
})

test('9.4 concurrent saves are visible conflicts; the workspace key follows the canonical root, not the display name', async () => {
  const root = base()
  const transaction = createDefaultsTransaction({ store: storeOf(root) })
  const snapshot = { skills: [], mcpServers: [], unresolvedRefs: [] }
  await transaction.save({ workspaceKey: workspaceKeyOf({ cwd: '/ws/a' }), expectedRevision: 0, snapshot })
  const conflict = await transaction.save({ workspaceKey: workspaceKeyOf({ cwd: '/ws/a' }), expectedRevision: 0, snapshot })
  expect(conflict.status).toBe('revision-conflict')
  expect(workspaceKeyOf({ scope: { session: { header: { cwd: root } } } })).toBe(workspaceKeyOf({ cwd: root }))
  expect(workspaceKeyOf({ scope: { session: { workspaceKey: 'stable-id' } } })).toBe('stable-id')
  expect(workspaceKeyOf({ scope: { session: { header: { cwd: root } } } })).toMatch(/^ws-[0-9a-f]{24}$/)
  expect(workspaceKeyOf({ scope: { session: { header: { cwd: '/does/not/exist' } } } })).toMatch(/^ws-[0-9a-f]{24}$/)
})
