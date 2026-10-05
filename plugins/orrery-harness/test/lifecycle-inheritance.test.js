// Task 6.3 of the session-capability-manager change: creation-time
// inheritance. A subagent snapshot is fixed at creation / explicit resume /
// escalation; messaging a live child never recaptures; a live child's
// snapshot is never widened by the parent's later edits; an explicit
// resume recomputes child-previous ∩ current-parent, constraints only narrow.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLifecycleSnapshots } from '../src/capabilities/lifecycle-snapshot.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'

const base = () => mkdtempSync(join(tmpdir(), 'orrery-inherit-'))
const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const beta = identity('project', 'beta')
const gamma = identity('user', 'gamma')

const writeSelection = async (root, sessionId, skills, mcpServers = []) => {
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const current = await store.read({ kind: 'selection', sessionId })
  const revision = current.kind === 'ok' ? current.revision : 0
  return store.commit({ kind: 'selection', sessionId }, revision, () => ({ skills, mcpServers }))
}
const seedSelection = async (root, sessionId, revision, skills, mcpServers = []) => {
  let current
  for (let r = 0; r < revision; r += 1) current = await writeSelection(root, sessionId, skills, mcpServers)
  return current
}
const inheritedRecord = async (root, sessionId) =>
  (await openCapabilityStore({ root, platform: 'darwin' }).read({ kind: 'inherited', sessionId }))
const childPayload = (sessionId, parentSession) => ({
  agent: { session: { id: sessionId, header: { delegationDepth: 1, parentSession } } },
})
const names = skills => skills.map(s => s.name)

test('6.3 create: the child inherits the parent accepted set verbatim, constraints only narrow', async () => {
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha, beta], ['docs', 'web'])
  const lifecycle = createLifecycleSnapshots({ root })
  lifecycle.agentCreated(childPayload('child-a', 'parent'))
  expect(names((await inheritedRecord(root, 'child-a')).payload.skills)).toEqual(['alpha', 'beta'])
  // Constraints intersect: beta dropped, and gamma (not in the parent) never appears.
  const narrowed = createLifecycleSnapshots({ root })
  narrowed.captureInherited('child-b', 'parent', { allowSkills: [alpha, gamma], allowMcpServers: ['web'] })
  const record = await inheritedRecord(root, 'child-b')
  expect(names(record.payload.skills)).toEqual(['alpha'])
  expect(record.payload.mcpServers).toEqual(['web'])
})

test('6.3 resume after the parent narrowed: the removed capability never returns', async () => {
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha, beta], ['docs', 'web'])
  const lifecycle = createLifecycleSnapshots({ root })
  lifecycle.agentCreated(childPayload('child-c', 'parent'))
  // Parent narrows to alpha-only.
  await seedSelection(root, 'parent', 1, [alpha], ['docs'])
  // A fresh lifecycle (cold process) re-reads everything from disk.
  const cold = createLifecycleSnapshots({ root })
  cold.agentCreated(childPayload('child-c', 'parent'))
  const record = await inheritedRecord(root, 'child-c')
  expect(record.revision).toBe(2)
  expect(names(record.payload.skills)).toEqual(['alpha'])
  expect(record.payload.mcpServers).toEqual(['docs'])
})

test('6.3 a live child is never widened: parent additions arrive only at an explicit resume, intersected', async () => {
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha], ['docs'])
  const lifecycle = createLifecycleSnapshots({ root })
  lifecycle.agentCreated(childPayload('child-d', 'parent'))
  // Parent widens with gamma. Messaging the live child produces NO
  // agent/created, so no recapture: the durable record stays revision 1.
  await seedSelection(root, 'parent', 1, [alpha, gamma], ['docs', 'web'])
  expect((await inheritedRecord(root, 'child-d')).revision).toBe(1)
  expect(names((await inheritedRecord(root, 'child-d')).payload.skills)).toEqual(['alpha'])
  expect(lifecycle.snapshotFor('child-d')?.skills.map(s => s.name)).toEqual(['alpha'])
  // An explicit resume recomputes child-previous ∩ current-parent: gamma is
  // NOT granted (the child never had it), alpha is kept.
  const cold = createLifecycleSnapshots({ root })
  cold.agentCreated(childPayload('child-d', 'parent'))
  const record = await inheritedRecord(root, 'child-d')
  expect(record.revision).toBe(2)
  expect(names(record.payload.skills)).toEqual(['alpha'])
  expect(record.payload.mcpServers).toEqual(['docs'])
})

test('6.3 escalation follows the resume rule and constraints still apply on top', async () => {
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha, beta], ['docs'])
  const lifecycle = createLifecycleSnapshots({ root })
  lifecycle.agentCreated(childPayload('child-e', 'parent'))
  await seedSelection(root, 'parent', 1, [beta], ['docs'])
  const cold = createLifecycleSnapshots({ root })
  // Escalation re-announces agent/created: resume ∩ plus constraints.
  cold.captureInherited('child-e', 'parent', { allowSkills: [alpha] })
  const record = await inheritedRecord(root, 'child-e')
  expect(names(record.payload.skills)).toEqual([]) // previous {α,β} ∩ current {β} = {β}, ∩ allow {α} = ∅
  expect(record.payload.mcpServers).toEqual(['docs'])
})

test('6.3 a parent without any accepted record yields an empty inherited set', () => {
  const lifecycle = createLifecycleSnapshots({ root: base() })
  const snapshot = lifecycle.captureInherited('child-f', 'no-such-parent')
  expect(snapshot.state).toBe('ready')
  expect(snapshot.skills).toEqual([])
  expect(snapshot.mcpServers).toEqual([])
})
