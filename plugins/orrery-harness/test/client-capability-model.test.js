// Client view-model for the capability Badge and manager (tasks 12.2/12.3/12.5).
import { test, expect } from './helpers.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

function loadModel() {
  const source = readFileSync(fileURLToPath(new URL('../lib/client.capability-model.js', import.meta.url)), 'utf8')
  const loaded = {}
  const sandbox = { __ModuleLoader__: { load: ({ factory }) => { loaded.exports = factory(() => { throw new Error('zero-dependency chunk') }) } } }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return loaded.exports
}

const realmless = (value) => JSON.parse(JSON.stringify(value))
const model = Object.fromEntries(Object.entries(loadModel()).map(([key, fn]) => [key, (...args) => realmless(fn(...args))]))

test('12.2 the Badge reports applied counts from the server receipt, warnings separate, draft never optimistic', () => {
  const receipt = { status: 'applied', effective: { skills: ['a', 'b'], mcpServers: ['docs'] }, warnings: ['fixture-a-unavailable'] }
  const state = model.badgeStateOf(receipt, { dirty: true })
  expect(state.applied).toEqual({ skills: 2, mcpServers: 1 })
  expect(state.unavailable).toEqual(['fixture-a-unavailable'])
  expect(state.draftDirty).toBe(true)
  expect(state.known).toBe(true)
  // A blank session (no receipt yet) is distinct from an applied-zero session.
  expect(model.badgeStateOf(null, null).known).toBe(false)
})

test('12.2 the manager partitions skills with source labels and MCP into managed/unmanaged', () => {
  const partition = model.partitionManagerListing({
    skills: [
      { name: 'deep-work', description: 'x', scope: 'orrery-builtin', status: 'parsed', selected: true },
      { name: 'tool-skill', description: 'y', scope: 'project', status: 'parsed', selected: false, conflict: true },
    ],
    mcpServers: [
      { identity: 'docs', state: 'mounted' },
      { identity: 'gamma', state: 'unmanaged' },
    ],
  })
  expect(partition.skills[0].source).toBe('Orrery builtin')
  expect(partition.skills[1].source).toBe('project')
  expect(partition.skills[1].conflict).toBe(true)
  expect(partition.mcpManaged.map((server) => server.identity)).toEqual(['docs'])
  expect(partition.mcpUnmanaged.map((server) => server.identity)).toEqual(['gamma'])
})

test('12.2 unsupported conditions stay explicit, loading and unknown stay distinct', () => {
  expect(model.managerConditionState([])).toBe('supported')
  expect(model.managerConditionState(['exec.signal unavailable'])).toBe('unsupported')
  expect(model.managerConditionState(null)).toBe('unknown')
})

test('12.3 commit states: request ID reused, failure keeps the draft, conflict shows current state', () => {
  expect(model.commitStateOf({ phase: 'submitting', requestId: 'r-1' })).toEqual({ phase: 'submitting', requestId: 'r-1' })
  const failed = model.commitStateOf({ phase: 'failed', requestId: 'r-1', error: 'revision moved' })
  expect(failed.draftKept).toBe(true)
  expect(failed.requestId).toBe('r-1')
  const conflict = model.commitStateOf({ phase: 'revision-conflict', current: { revision: 5, skills: ['a'] } })
  expect(conflict.current.revision).toBe(5)
  expect(conflict.draftKept).toBe(true)
  expect(model.commitStateOf({ phase: 'indeterminate', requestId: 'r-2' }).queryable).toBe(true)
})

test('12.3 a no-diff draft with missing warnings offers install/configure instead of a fictional Apply', () => {
  const state = model.commitStateOf({ dirty: true, hasDiff: false, missing: ['fixture-a'] })
  expect(state.phase).toBe('install-or-configure')
  expect(state.missing).toEqual(['fixture-a'])
  expect(model.commitStateOf({ dirty: true, hasDiff: true }).phase).toBe('ready')
})

test('12.3 closing a dirty draft offers discard or keep editing', () => {
  expect(model.closeDirtyDraft('discard')).toEqual({ phase: 'idle', draft: null })
  expect(model.closeDirtyDraft('keep')).toEqual({ phase: 'ready', keepEditing: true })
})

test('12.5 second-window frames refresh only the named session; no subscription degrades to a refresh hint', () => {
  expect(model.frameRefreshesSession({ sessionId: 's-1' }, 's-1')).toBe(true)
  expect(model.frameRefreshesSession({ sessionId: 's-2' }, 's-1')).toBe(false)
  expect(model.frameRefreshesSession(null, 's-1')).toBe(false)
  expect(model.convergenceHintOf({ subscribed: true })).toBeNull()
  expect(model.convergenceHintOf({ subscribed: false })).toBe('refresh to sync')
})

test('12.3 the draft seeds from the receipt with the CAS revision and toggles recompute dirty', () => {
  const draft = model.draftFromReceipt({ revision: 4, effective: { skills: ['a', 'b'], mcpServers: ['docs'] } })
  expect(draft.revision).toBe(4)
  expect(draft.dirty).toBe(false)
  const removed = model.draftToggle(draft, 'skills', 'a')
  expect(removed.skills).toEqual(['b'])
  expect(removed.dirty).toBe(true)
  // Toggling back restores the applied sets and clears dirty.
  const restored = model.draftToggle(removed, 'skills', 'a')
  expect(restored.dirty).toBe(false)
  const added = model.draftToggle(draft, 'mcpServers', 'gamma')
  expect(added.mcpServers).toEqual(['docs', 'gamma'])
  expect(added.dirty).toBe(true)
})

test('12.3 engine responses map onto the commit states', () => {
  expect(model.commitOutcomeOf({ status: 'applied', revision: 5 })).toEqual({ phase: 'applied', revision: 5, skipped: [] })
  // preset-skill-applicability: an applied commit carries the skipped report through.
  expect(model.commitOutcomeOf({ status: 'applied', revision: 6, skipped: [{ name: 'creative-only', reason: 'not applicable in this agent preset' }, { broken: true }] })).toEqual({
    phase: 'applied', revision: 6, skipped: [{ name: 'creative-only', reason: 'not applicable in this agent preset' }],
  })
  const conflict = model.commitOutcomeOf({ status: 'revision-conflict', current: { revision: 6 } })
  expect(conflict.phase).toBe('revision-conflict')
  expect(conflict.draftKept).toBe(true)
  expect(model.commitOutcomeOf({ status: 'indeterminate', receipt: { requestId: 'r-9' } })).toEqual({ phase: 'indeterminate', requestId: 'r-9', queryable: true })
  expect(model.commitOutcomeOf({ status: 'missing', missing: ['x'] })).toEqual({ phase: 'install-or-configure', missing: ['x'] })
  expect(model.commitOutcomeOf({ status: 'rejected', reason: 'unauthenticated:x' }).phase).toBe('failed')
  expect(model.commitOutcomeOf(null).draftKept).toBe(true)
})

// ---- Manager redesign model half (D3, lane capability-manager-panel-050) ----

test('D3 groupSkillRows orders the fixed scope groups, drops empty ones, buckets unknown scopes as other', () => {
  const groups = model.groupSkillRows([
    { scopeKey: 'project', name: 'p1' },
    { scopeKey: 'orrery-builtin', name: 'b1' },
    { scopeKey: 'weird', name: 'w1' },
    { scopeKey: 'user', name: 'u1' },
    { scopeKey: 'custom', name: 'c1' },
  ])
  expect(groups.map((group) => group.key)).toEqual(['orrery-builtin', 'user', 'project', 'custom', 'other'])
  expect(groups[0].label).toBe('Orrery builtin')
  expect(groups[1].label).toBe('user')
  expect(groups[4].label).toBe('other')
  expect(groups[4].rows[0].name).toBe('w1')
  expect(model.groupSkillRows([])).toEqual([])
  expect(model.groupSkillRows(null)).toEqual([])
})

test('D3 filterSkillRows matches name and description case-insensitively; a blank query passes everything', () => {
  const rows = [
    { name: 'deep-work', description: 'Focus blocks' },
    { name: 'api-design', description: 'REST reviews' },
  ]
  expect(model.filterSkillRows(rows, 'DEEP').map((row) => row.name)).toEqual(['deep-work'])
  expect(model.filterSkillRows(rows, 'rest').map((row) => row.name)).toEqual(['api-design'])
  expect(model.filterSkillRows(rows, '  ')).toEqual(rows)
  expect(model.filterSkillRows(rows, '').length).toBe(2)
  expect(model.filterSkillRows(null, 'x')).toEqual([])
})

test('D3 draftDiffOf nets adds/removes per kind against the applied sets', () => {
  const draft = {
    skills: ['a', 'c'],
    mcpServers: ['docs', 'gamma'],
    applied: { skills: ['a', 'b'], mcpServers: ['docs'] },
  }
  expect(model.draftDiffOf(draft)).toEqual({ skillsAdded: 1, skillsRemoved: 1, mcpAdded: 1, mcpRemoved: 0, any: true })
  const clean = { skills: ['a'], mcpServers: [], applied: { skills: ['a'], mcpServers: [] } }
  expect(model.draftDiffOf(clean).any).toBe(false)
  expect(model.draftDiffOf(null)).toEqual({ skillsAdded: 0, skillsRemoved: 0, mcpAdded: 0, mcpRemoved: 0, any: false })
})

test('D3 mcpAddErrorsOf validates identity as a store segment and command as required', () => {
  expect(model.mcpAddErrorsOf({ identity: '', command: 'x' }).identity).toBe('required')
  expect(model.mcpAddErrorsOf({ identity: 'bad name!', command: 'x' }).identity).toBe('invalid')
  expect(model.mcpAddErrorsOf({ identity: 'ok-name_1', command: ' ' }).command).toBe('required')
  expect(model.mcpAddErrorsOf({ identity: 'ok-name_1', command: 'npx srv' })).toEqual({})
})

test('D3 draftFromPreset stages only the resolved sets, carries unresolved refs, keeps the CAS base', () => {
  const document = {
    selection: {
      skills: ['b', 'a'],
      mcpServers: ['docs'],
      unresolvedRefs: [{ kind: 'skill', ref: { name: 'gone' } }],
    },
  }
  const staged = model.draftFromPreset(document, { applied: { skills: ['a'], mcpServers: [] }, revision: 7 })
  expect(staged.skills).toEqual(['a', 'b']) // sorted staging
  expect(staged.mcpServers).toEqual(['docs'])
  expect(staged.revision).toBe(7)
  expect(staged.unresolvedRefs).toEqual([{ kind: 'skill', ref: { name: 'gone' } }])
  expect(staged.dirty).toBe(true)
  // Identical resolved sets are not dirty; a missing current draft falls back to empty applied sets.
  const clean = model.draftFromPreset({ selection: { skills: [], mcpServers: [] } }, { applied: { skills: [], mcpServers: [] }, revision: 3 })
  expect(clean.dirty).toBe(false)
  expect(clean.revision).toBe(3)
  expect(model.draftFromPreset(null, null).revision).toBe(0)
})

test('D3 presetRowOf coerces scope/name/counts; groupPresets splits and sorts namespaces', () => {
  const row = model.presetRowOf({ scope: 'workspace', presetId: 'p-1', name: '', revision: 'x', counts: { skills: 2, mcpServers: -1 } })
  expect(row.scope).toBe('workspace')
  expect(row.name).toBe('p-1') // empty display name falls back to the id
  expect(row.revision).toBe(0)
  expect(row.counts).toEqual({ skills: 2, mcpServers: 0, unresolvedRefs: 0 })
  expect(model.presetRowOf({ scope: 'other', presetId: 42 }).scope).toBe('global')

  const grouped = model.groupPresets({
    workspaceKey: 'ws-1',
    presets: [
      { scope: 'global', presetId: 'g-2', name: 'zeta', counts: {} },
      { scope: 'workspace', presetId: 'w-1', name: 'beta', counts: {} },
      { scope: 'global', presetId: 'g-1', name: 'alpha', counts: {} },
    ],
  })
  expect(grouped.workspaceKey).toBe('ws-1')
  expect(grouped.global.map((preset) => preset.name)).toEqual(['alpha', 'zeta'])
  expect(grouped.workspace.map((preset) => preset.presetId)).toEqual(['w-1'])
  expect(model.groupPresets(null)).toEqual({ workspaceKey: null, global: [], workspace: [] })
})

test('D3 presetWriteOutcomeOf categorizes every explicit status, never a silent overwrite', () => {
  expect(model.presetWriteOutcomeOf({ status: 'created', presetId: 'p', revision: 1 })).toEqual({ kind: 'created', presetId: 'p', revision: 1 })
  expect(model.presetWriteOutcomeOf({ status: 'edited', presetId: 'p', revision: 2 }).kind).toBe('edited')
  expect(model.presetWriteOutcomeOf({ status: 'deleted', revision: 3 })).toEqual({ kind: 'deleted', revision: 3 })
  expect(model.presetWriteOutcomeOf({ status: 'name-conflict', with: 'x' })).toEqual({ kind: 'name-conflict', with: 'x' })
  expect(model.presetWriteOutcomeOf({ status: 'rename-required' }).kind).toBe('name-conflict')
  expect(model.presetWriteOutcomeOf({ status: 'revision-conflict' })).toEqual({ kind: 'revision-conflict' })
  expect(model.presetWriteOutcomeOf({ status: 'exists', presetId: 'p' })).toEqual({ kind: 'exists', presetId: 'p' })
  expect(model.presetWriteOutcomeOf({ status: 'no-workspace' })).toEqual({ kind: 'no-workspace' })
  expect(model.presetWriteOutcomeOf({ status: 'mystery' }).kind).toBe('error')
  expect(model.presetWriteOutcomeOf(null).kind).toBe('error')
})

test('D3 importFeedbackOf categorizes created-with-counts, name conflict, rejection and failure', () => {
  expect(model.importFeedbackOf({ status: 'created', presetId: 'p', bound: { mcpServers: 2, unresolvedRefs: 1 } }))
    .toEqual({ kind: 'created', presetId: 'p', bound: 2, unresolved: 1 })
  expect(model.importFeedbackOf({ status: 'name-conflict', with: 'n' })).toEqual({ kind: 'name-conflict', with: 'n' })
  expect(model.importFeedbackOf({ status: 'rejected', reason: 'poison' })).toEqual({ kind: 'rejected', reason: 'poison' })
  expect(model.importFeedbackOf({ status: 'no-workspace' })).toEqual({ kind: 'no-workspace' })
  expect(model.importFeedbackOf({ status: 'odd' }).kind).toBe('error')
  expect(model.importFeedbackOf(null).kind).toBe('error')
  expect(model.importFeedbackOf({ error: true }).kind).toBe('error')
})

test('D3 presetExportTextOf pretty-prints the document and names every failure', () => {
  const ok = model.presetExportTextOf({ status: 'ok', format: 'package', document: { version: 2, name: 'x' } })
  expect(ok.kind).toBe('ok')
  expect(ok.text).toBe(JSON.stringify({ version: 2, name: 'x' }, null, 2))
  expect(model.presetExportTextOf({ status: 'absent' }).kind).toBe('error')
  expect(model.presetExportTextOf({ status: 'ok', document: { big: 1n } })).toEqual({ kind: 'error', status: 'unserializable' })
  expect(model.presetExportTextOf(null).kind).toBe('error')
})

test('D3 defaultStateOf distinguishes none, cleared, explicit empty and entries', () => {
  expect(model.defaultStateOf({ status: 'absent', workspaceKey: 'w' })).toEqual({ kind: 'none', cleared: false, workspaceKey: 'w' })
  expect(model.defaultStateOf({ status: 'ok', cleared: true, revision: 2 })).toEqual({ kind: 'none', cleared: true, revision: 2, workspaceKey: null })
  expect(model.defaultStateOf({ status: 'ok', revision: 1, snapshot: { skills: [], mcpServers: [] } })).toEqual({ kind: 'empty', revision: 1, unresolvedRefs: 0, workspaceKey: null })
  const entries = model.defaultStateOf({ status: 'ok', revision: 4, snapshot: { skills: ['a'], mcpServers: ['d'], unresolvedRefs: ['x'] } })
  expect(entries).toEqual({ kind: 'entries', revision: 4, skills: 1, mcpServers: 1, unresolvedRefs: 1, workspaceKey: null })
  expect(model.defaultStateOf({ status: 'no-workspace' })).toEqual({ kind: 'unsupported' })
  expect(model.defaultStateOf(null).kind).toBe('error')
})

test('D3 defaultWriteOutcomeOf categorizes saved, cleared and the conflict statuses', () => {
  expect(model.defaultWriteOutcomeOf({ status: 'saved', revision: 2 })).toEqual({ kind: 'saved', revision: 2 })
  expect(model.defaultWriteOutcomeOf({ status: 'cleared', revision: 3 })).toEqual({ kind: 'cleared', revision: 3 })
  expect(model.defaultWriteOutcomeOf({ status: 'revision-conflict' })).toEqual({ kind: 'revision-conflict' })
  expect(model.defaultWriteOutcomeOf({ status: 'no-workspace' })).toEqual({ kind: 'no-workspace' })
  expect(model.defaultWriteOutcomeOf(null).kind).toBe('error')
})

test('D3 unresolvedLabelOf prefers name, then ref, then hint, then JSON', () => {
  expect(model.unresolvedLabelOf('plain')).toBe('plain')
  expect(model.unresolvedLabelOf({ name: 'skill-a', ref: 'r' })).toBe('skill-a')
  expect(model.unresolvedLabelOf({ ref: 'org/repo#x' })).toBe('org/repo#x')
  expect(model.unresolvedLabelOf({ hint: 'install first' })).toBe('install first')
  // The wrapped {kind, ref:{...}} shape import binding and the v2 dry-run send.
  expect(model.unresolvedLabelOf({ kind: 'skill', ref: { name: 'remote-x', repository: 'org/repo' } })).toBe('remote-x')
  expect(model.unresolvedLabelOf({ other: 1 })).toBe('{"other":1}')
  expect(model.unresolvedLabelOf(null)).toBe('unresolved')
})

// ---- Version-2 package export/import (D6, task 6.4) ----

test('6.4 packageVersionOf routes only a real version-2 package to the two-phase flow', () => {
  expect(model.packageVersionOf({ version: 2, name: 'pack' })).toBe(2)
  expect(model.packageVersionOf({ version: 1, name: 'doc' })).toBeNull()
  expect(model.packageVersionOf({ version: '2' })).toBeNull()
  expect(model.packageVersionOf([{ version: 2 }])).toBeNull()
  expect(model.packageVersionOf(null)).toBeNull()
  expect(model.packageVersionOf('x')).toBeNull()
})

test('6.4 importDryRunOf summarizes install rows, collisions and unresolved refs (zero writes)', () => {
  const summary = model.importDryRunOf({
    status: 'dry-run',
    install: [
      { targetScope: 'project', name: 'alpha', fileCount: 3, targetRoot: '/ws/skills', collision: true },
      { targetScope: 'user', name: 'beta', fileCount: 1, targetRoot: '/u/skills' },
    ],
    collisions: [{ targetScope: 'project', name: 'alpha' }],
    unresolved: [{ kind: 'skill', ref: { name: 'remote-x' } }],
  })
  expect(summary.kind).toBe('summary')
  expect(summary.install).toEqual([
    { targetScope: 'project', name: 'alpha', fileCount: 3, targetRoot: '/ws/skills', collision: true },
    { targetScope: 'user', name: 'beta', fileCount: 1, targetRoot: '/u/skills', collision: false },
  ])
  expect(summary.collisions).toEqual([{ targetScope: 'project', name: 'alpha' }])
  expect(summary.hasCollisions).toBe(true)
  expect(summary.unresolved).toEqual([{ kind: 'skill', ref: { name: 'remote-x' } }])
  // Row flags alone (no explicit list) still arm the decision control.
  expect(model.importDryRunOf({ status: 'dry-run', install: [{ targetScope: 'user', name: 'b', fileCount: 1, targetRoot: '/u', collision: true }] }).hasCollisions).toBe(true)
  expect(model.importDryRunOf({ status: 'dry-run', install: [] }).hasCollisions).toBe(false)
})

test('6.4 importDryRunOf keeps the atomic rejection and unsupported surfaces explicit', () => {
  expect(model.importDryRunOf({ status: 'rejected', reason: 'oversized' })).toEqual({ kind: 'rejected', reason: 'oversized' })
  expect(model.importDryRunOf({ status: 'no-workspace' })).toEqual({ kind: 'no-workspace' })
  expect(model.importDryRunOf({ status: 'created' }).kind).toBe('error')
  expect(model.importDryRunOf(null).kind).toBe('error')
  expect(model.importDryRunOf({ error: true }).kind).toBe('error')
})

test('6.4 importConfirmReadyOf requires a summary and, with collisions, an explicit decision', () => {
  expect(model.importConfirmReadyOf(null, 'cancel')).toBe(false)
  const clean = { kind: 'summary', hasCollisions: false }
  expect(model.importConfirmReadyOf(clean, undefined)).toBe(true)
  const colliding = { kind: 'summary', hasCollisions: true }
  expect(model.importConfirmReadyOf(colliding, 'cancel')).toBe(true)
  expect(model.importConfirmReadyOf(colliding, 'replace')).toBe(true)
  expect(model.importConfirmReadyOf(colliding, 'coexist')).toBe(true)
  expect(model.importConfirmReadyOf(colliding, undefined)).toBe(false)
  expect(model.importConfirmReadyOf(colliding, 'overwrite')).toBe(false)
})

test('6.4 importConfirmOutcomeOf renders installed rows with the final on-disk names and collision decisions', () => {
  const outcome = model.importConfirmOutcomeOf({
    status: 'created',
    presetId: 'p-1',
    bound: { mcpServers: 1, unresolvedRefs: 2 },
    installed: [
      { targetScope: 'project', name: 'alpha', target: 'alpha', fileCount: 3, status: 'installed' },
      { targetScope: 'user', name: 'beta', target: 'beta-2', fileCount: 1, status: 'coexist-distinct' },
    ],
    collisions: [{ targetScope: 'user', name: 'beta', decision: 'coexist-distinct' }],
    unresolved: ['x', 'y'],
  })
  expect(outcome.kind).toBe('created')
  expect(outcome.presetId).toBe('p-1')
  expect(outcome.bound).toBe(1)
  expect(outcome.unresolved).toBe(2)
  expect(outcome.installed).toEqual([
    { targetScope: 'project', name: 'alpha', fileCount: 3, status: 'installed' },
    { targetScope: 'user', name: 'beta-2', fileCount: 1, status: 'coexist-distinct' },
  ])
  expect(outcome.collisions).toEqual([{ targetScope: 'user', name: 'beta', decision: 'coexist-distinct' }])
  // A missing bound block falls back to the unresolved list length.
  expect(model.importConfirmOutcomeOf({ status: 'created', unresolved: ['a'] }).unresolved).toBe(1)
})

test('6.4 importConfirmOutcomeOf names install-failed with the rollback count, missing roots and conflicts', () => {
  expect(model.importConfirmOutcomeOf({ status: 'install-failed', reason: 'disk full', rolledBack: 5 }))
    .toEqual({ kind: 'install-failed', reason: 'disk full', rolledBack: 5 })
  expect(model.importConfirmOutcomeOf({ status: 'no-target-root', targetScope: 'user' }))
    .toEqual({ kind: 'no-target-root', targetScope: 'user' })
  expect(model.importConfirmOutcomeOf({ status: 'name-conflict', with: 'n' })).toEqual({ kind: 'name-conflict', with: 'n' })
  expect(model.importConfirmOutcomeOf({ status: 'rejected', reason: 'poison' })).toEqual({ kind: 'rejected', reason: 'poison' })
  expect(model.importConfirmOutcomeOf({ status: 'no-workspace' })).toEqual({ kind: 'no-workspace' })
  expect(model.importConfirmOutcomeOf(null).kind).toBe('error')
})

test('6.4 exportFileNameOf slugs the preset name, falls back to the id, then to preset', () => {
  expect(model.exportFileNameOf('My Travel Pack!', 'p-1')).toBe('my-travel-pack.json')
  expect(model.exportFileNameOf('旅行包', 'pack-01')).toBe('pack-01.json') // no ASCII content in the name
  expect(model.exportFileNameOf('', '')).toBe('preset.json')
  expect(model.exportFileNameOf(null, null)).toBe('preset.json')
  expect(model.exportFileNameOf('  spaced   name  ', null)).toBe('spaced-name.json')
  expect(model.exportFileNameOf('x'.repeat(200), null)).toBe(`${'x'.repeat(64)}.json`)
})

// Visual polish (capabilities-panel-visual-polish): the view color-codes
// source tags by scope family — the model must keep exposing scopeKey for
// exactly the families the S table maps (orrery-builtin/user/project/custom).
test('visual polish: skillRowOf keeps exposing scopeKey for the scope→hue tag families', () => {
  const partition = model.partitionManagerListing({
    skills: [
      { name: 'b1', scope: 'orrery-builtin', status: 'parsed' },
      { name: 'u1', scope: 'user', status: 'parsed' },
      { name: 'p1', scope: 'project', status: 'parsed' },
      { name: 'c1', scope: 'custom', status: 'parsed' },
      { name: 'x1', status: 'parsed' },
    ],
    mcpServers: [],
  })
  expect(partition.skills.map((row) => row.scopeKey)).toEqual(['orrery-builtin', 'user', 'project', 'custom', 'unknown'])
  // The display label stays independent of the hue key (12.2 contract).
  expect(partition.skills[0].source).toBe('Orrery builtin')
  expect(partition.skills[4].source).toBe('unknown')
})
