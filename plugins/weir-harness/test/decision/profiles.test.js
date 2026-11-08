import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDecisionDatabase } from '../../src/decision/store/db.js'
import { DecisionProfiles, resolveRootSession } from '../../src/decision/store/profiles.js'

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'weir-decision-profiles-'))
  const store = openDecisionDatabase(join(dir, 'decision.db'))
  const profiles = new DecisionProfiles(store)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, store, profiles }
}

test('profile creation validates scope and rejects case-insensitive duplicate names', async t => {
  const { profiles } = fixture(t)
  const created = await profiles.createProfile({ workspaceKey: '/repo', name: 'Taste', userDescription: 'Prefer concise output' })
  assert.equal(created.state, 'enabled')
  assert.equal(created.scope.workspaces[0], '/repo')
  await assert.rejects(profiles.createProfile({ workspaceKey: '/repo', name: 'taste' }))
  await assert.rejects(profiles.createProfile({ workspaceKey: '/repo', name: 'other', scope: { workspaces: ['/other'] } }), error => error.code === 'SCOPE_WORKSPACE_MISMATCH')
})

test('user description edits append revisions and retain old text', async t => {
  const { profiles } = fixture(t)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Taste', userDescription: 'v1 text' })
  const updated = await profiles.updateProfile(profile.agentId, { userDescription: 'v2 text' })
  assert.equal(updated.userDescription.revision, 2)
  assert.equal(updated.userDescription.text, 'v2 text')
  assert.equal(profiles.descriptionRevision(profile.agentId, 'user', 1), 'v1 text')
  assert.equal(profiles.descriptionRevision(profile.agentId, 'user', 2), 'v2 text')
  assert.equal(profiles.setGeneratedDescription, undefined)
})

test('disabled and archived profiles leave the selectable list without deleting history', async t => {
  const { profiles } = fixture(t)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Taste' })
  await profiles.setProfileState(profile.agentId, 'disabled')
  assert.equal(profiles.listProfiles('/repo')[0].state, 'disabled')
  await profiles.setProfileState(profile.agentId, 'archived')
  assert.equal(profiles.listProfiles('/repo').length, 0)
  const archived = profiles.getProfile(profile.agentId)
  assert.equal(archived.state, 'archived')
  assert.ok(archived.archivedAt)
})

test('selector persists across reopen and child lineage resolves to root', async t => {
  const { dir, profiles } = fixture(t)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Taste' })
  await profiles.setSelector('root', { mode: 'agent', agentId: profile.agentId })
  const coldStore = openDecisionDatabase(join(dir, 'decision.db'))
  const cold = new DecisionProfiles(coldStore)
  assert.deepEqual(cold.selector('root'), { mode: 'agent', agentId: profile.agentId })
  const query = { traceSession: async () => ({ complete: true, root: { header: { id: 'root' } } }) }
  assert.equal(await resolveRootSession('child', query), 'root')
  await assert.rejects(resolveRootSession('broken', { traceSession: async () => ({ complete: false }) }), error => error.code === 'INCOMPLETE_LINEAGE')
  coldStore.close()
})

test('archived Agent cannot be selected for new work', async t => {
  const { profiles } = fixture(t)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Taste' })
  await profiles.setProfileState(profile.agentId, 'archived')
  await assert.rejects(profiles.setSelector('root', { mode: 'agent', agentId: profile.agentId }), error => error.code === 'AGENT_UNAVAILABLE')
})
