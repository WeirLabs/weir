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

test('profile scope is workspace-agnostic, keeps hints, and names stay case-insensitively unique', async t => {
  const { profiles } = fixture(t)
  const created = await profiles.createProfile({ workspaceKey: '/repo', name: 'Taste', userDescription: 'Prefer concise output' })
  assert.equal(created.state, 'enabled')
  // A profile never carries workspace membership — not even as an echo.
  assert.equal('workspaces' in created.scope, false)
  assert.deepEqual(created.scope, {})
  assert.equal('workspaceKey' in created, false)
  assert.equal('legacyOriginAlias' in created, false)

  await assert.rejects(profiles.createProfile({ workspaceKey: '/repo', name: 'taste' }), error => error.code === 'PROFILE_NAME_TAKEN')
  // The same name is refused from any other workspace too, and a legacy
  // `workspaces` array is normalized away instead of becoming a workspace lock.
  await assert.rejects(profiles.createProfile({ workspaceKey: '/other', name: 'TASTE' }), error => error.code === 'PROFILE_NAME_TAKEN')
  const hinted = await profiles.createProfile({
    workspaceKey: '/repo', name: 'other',
    scope: { workspaces: ['/other'], paths: ['src'], tags: ['copy'], authorizationClasses: ['A'] },
  })
  // A legacy A/B/C field is inert: kept out of the stored scope, never an error.
  assert.deepEqual(hinted.scope, { paths: ['src'], tags: ['copy'] })

  // A rename can never take another identity's name: both identities survive.
  await assert.rejects(profiles.updateProfile(hinted.agentId, { name: 'Taste' }), error => error.code === 'PROFILE_NAME_TAKEN')
  assert.equal(profiles.getProfile(hinted.agentId).name, 'other')
  assert.equal(profiles.getProfile(created.agentId).name, 'Taste')
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
  assert.equal(profiles.listProfiles()[0].state, 'disabled')
  await profiles.setProfileState(profile.agentId, 'archived')
  assert.equal(profiles.listProfiles().length, 0)
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

test('explicit Off persists as a row with no Agent across reopen', async t => {
  const { dir, store, profiles } = fixture(t)
  await profiles.setSelector('root', { mode: 'off' })
  assert.deepEqual({ ...store.db.prepare('SELECT mode,agent_id FROM selectors WHERE root_session_id=?').get('root') }, { mode: 'off', agent_id: null })
  const coldStore = openDecisionDatabase(join(dir, 'decision.db'))
  const cold = new DecisionProfiles(coldStore)
  assert.deepEqual(cold.selector('root'), { mode: 'off' })
  coldStore.close()
})

test('Auto selector persists without an Agent across reopen', async t => {
  const { dir, store, profiles } = fixture(t)
  assert.deepEqual(await profiles.setSelector('root', { mode: 'auto' }), { mode: 'auto' })
  assert.deepEqual({ ...store.db.prepare('SELECT mode,agent_id FROM selectors WHERE root_session_id=?').get('root') }, { mode: 'auto', agent_id: null })
  const coldStore = openDecisionDatabase(join(dir, 'decision.db'))
  const cold = new DecisionProfiles(coldStore)
  assert.deepEqual(cold.selector('root'), { mode: 'auto' })
  coldStore.close()
})

test('legacy DELETE-form Off, absent rows and unknown modes fail closed', async t => {
  const { store, profiles } = fixture(t)
  await store.write(db => {
    db.prepare("INSERT INTO selectors(root_session_id,mode,agent_id,updated_at) VALUES('legacy-off','agent','old-agent',1)").run()
    db.prepare("DELETE FROM selectors WHERE root_session_id='legacy-off'").run()
    db.prepare("INSERT INTO selectors(root_session_id,mode,agent_id,updated_at) VALUES('unknown','future-mode',NULL,1)").run()
  })
  assert.deepEqual(profiles.selector('legacy-off'), { mode: 'off' })
  assert.deepEqual(profiles.selector('resume-without-row'), { mode: 'off' })
  assert.deepEqual(profiles.selector('unknown'), { mode: 'off' })
  await assert.rejects(profiles.setSelector('root', { mode: 'future-mode' }), error => error.code === 'INVALID_SELECTOR')
})
test('archived Agent cannot be selected for new work', async t => {
  const { profiles } = fixture(t)
  const profile = await profiles.createProfile({ workspaceKey: '/repo', name: 'Taste' })
  await profiles.setProfileState(profile.agentId, 'archived')
  await assert.rejects(profiles.setSelector('root', { mode: 'agent', agentId: profile.agentId }), error => error.code === 'AGENT_UNAVAILABLE')
})
