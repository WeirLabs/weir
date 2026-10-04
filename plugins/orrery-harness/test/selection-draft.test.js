import { test, expect } from './helpers.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'
import { createSkillSelectionProvider } from '../src/capabilities/skill-selection-provider.js'
import { createSelectionDraft, normalizeEnabledSets, sameEnabledSets } from '../src/capabilities/selection-draft.js'

const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const user = identity('user', 'alpha')
const project = identity('project', 'beta')
const gamma = identity('user', 'gamma')
const sameName = identity('project', 'alpha')
const sets = (skills, mcpServers = []) => ({ skills, mcpServers })

test('Apply is hidden until the normalized enabled set substantively differs', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user], ['mcp-a']) })
  expect(draft.isDirty()).toBe(false)
  expect(draft.toggle(gamma, true)).toBe(true)
  expect(draft.toggle(gamma, false)).toBe(false)
  expect(draft.toggleServer('mcp-b', true)).toBe(true)
  expect(draft.toggleServer('mcp-b', false)).toBe(false)
})

test('toggling a Skill off and back to its original state clears Apply', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  expect(draft.toggle(user, false)).toBe(true)
  expect(draft.toggle(user, true)).toBe(false)
})

test('reordering or duplicating the same members never produces Apply', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user, project], ['mcp-a', 'mcp-b']) })
  expect(draft.setEnabled(sets([project, user, user], ['mcp-b', 'mcp-a', 'mcp-a']))).toBe(false)
  expect(sameEnabledSets(sets([user]), sets([user, user]))).toBe(true)
  expect(sameEnabledSets(sets([user]), sets([project]))).toBe(false)
})

test('search, sort, scope and layout edits are local view state and never produce Apply', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  expect(draft.setView({ search: 'alp' })).toBe(false)
  expect(draft.setView({ sort: 'scope', layout: 'grid', scope: 'user' })).toBe(false)
  expect(draft.view).toEqual({ search: 'alp', sort: 'scope', layout: 'grid', scope: 'user' })
  expect(() => draft.setView({ sort: 'random' })).toThrow(TypeError)
})

test('loading a preset stages only resolved sets and unresolved refs, never preset metadata', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  const dirty = draft.stagePreset({
    id: 'preset-1', name: 'Pretty name', revision: 9, description: 'metadata',
    resolved: sets([project]), unresolved: [{ kind: 'skill', ref: 'vendor/missing', reason: 'not-installed' }],
  })
  expect(dirty).toBe(true)
  expect(draft.enabled.skills).toEqual([project])
  expect(draft.unresolved).toEqual([{ kind: 'skill', ref: 'vendor/missing', reason: 'not-installed' }])
  const payload = draft.toApplyPayload()
  expect('id' in payload).toBe(false)
  expect('name' in payload).toBe(false)
  expect(JSON.stringify(payload)).not.toContain('Pretty name')
})

test('a preset whose resolved sets equal the applied sets does not produce Apply', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user, project]) })
  expect(draft.stagePreset({ id: 'other', resolved: sets([project, user]) })).toBe(false)
})

test('unresolved requested refs are kept for warnings but never produce Apply by themselves', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  expect(draft.stagePreset({ resolved: sets([user]), unresolved: [{ kind: 'mcp', ref: 'vendor/server', reason: 'not-configured' }] })).toBe(false)
  expect(draft.unresolved).toHaveLength(1)
  expect(draft.toApplyPayload().unresolved[0].ref).toBe('vendor/server')
})

test('installation, updates and identity-unchanged content refresh never produce Apply', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  expect(draft.noteInstall()).toBe(false)
  expect(draft.noteUpdate()).toBe(false)
  expect(draft.noteContentRefresh()).toBe(false)
  expect(draft.isDirty()).toBe(false)
  expect(draft.toggle(gamma, true)).toBe(true)
  // A pending draft is not disturbed by non-selection events either.
  expect(draft.noteInstall()).toBe(false)
  expect(draft.noteContentRefresh()).toBe(false)
  expect(draft.isDirty()).toBe(true)
})

test('an explicit empty set is a concrete applied state, never a missing one', () => {
  expect(() => normalizeEnabledSets(undefined)).toThrow(TypeError)
  expect(() => normalizeEnabledSets({ skills: [] })).toThrow(TypeError)
  const appliedEmpty = createSelectionDraft({ baseRevision: 3, applied: sets([]) })
  expect(appliedEmpty.isDirty()).toBe(false)
  expect(appliedEmpty.enabled).toEqual({ skills: [], mcpServers: [] })
  // No accepted record yet (baseRevision 0): emptying the initial set is a real change.
  const initial = createSelectionDraft({ baseRevision: 0, applied: sets([user]) })
  expect(initial.setEnabled(sets([]))).toBe(true)
  const payload = initial.toApplyPayload()
  expect(payload.expectedRevision).toBe(0)
  expect(payload.selection).toEqual({ skills: [], mcpServers: [] })
})

test('draft state is manager-side only: provider output ignores it and it holds no runtime seams', async () => {
  const candidateOf = value => ({ status: 'parsed', name: value.name, identity: value, path: `/${value.scope}/${value.name}/SKILL.md`,
    locator: { path: `/${value.scope}/${value.name}/SKILL.md` }, digest: 'd', resourceBase: { kind: 'directory', path: `/${value.scope}/${value.name}` } })
  const provider = createSkillSelectionProvider({
    control: { invalidate() {} },
    readSelection: async () => [user],
    inventory: async () => ({ complete: true, candidates: [candidateOf(user), candidateOf(gamma)] }),
  })
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  draft.toggle(gamma, true)
  draft.toggle(user, false)
  expect(draft.isDirty()).toBe(true)
  // The model-facing view still reflects the applied set, not the draft.
  expect((await provider.list()).candidates.map(item => item.identity)).toEqual([user])
  const seams = Object.keys(draft)
  for (const forbidden of ['ctx', 'store', 'provider', 'session', 'append']) expect(seams).not.toContain(forbidden)
})

test('same-name enabled identities surface as conflicts for explicit resolution', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  draft.toggle(sameName, true)
  const conflicts = draft.conflicts()
  expect(conflicts).toHaveLength(1)
  expect(conflicts[0].name).toBe('alpha')
  expect(draft.isDirty()).toBe(true)
})

test('discard reopens from the latest applied revision and clears editing state', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  draft.setView({ search: 'keep-me' })
  draft.toggle(gamma, true)
  expect(draft.isDirty()).toBe(true)
  expect(draft.discard({ baseRevision: 5, applied: sets([project]) })).toBe(false)
  expect(draft.baseSelectionRevision).toBe(5)
  expect(draft.enabled.skills).toEqual([project])
  expect(draft.view.search).toBe('keep-me')
  expect(() => draft.discard({ baseRevision: -1, applied: sets([]) })).toThrow(TypeError)
})

test('invalid identities and malformed unresolved refs are rejected at the boundary', () => {
  const draft = createSelectionDraft({ baseRevision: 4, applied: sets([user]) })
  expect(() => draft.toggle({ scope: 'user', root: '/user', name: 'Bad Name' }, true)).toThrow(TypeError)
  expect(() => createSelectionDraft({ baseRevision: 4, applied: sets(['alpha']) })).toThrow(TypeError)
  expect(() => draft.stagePreset({ resolved: sets([user]), unresolved: [{ kind: 'skill' }] })).toThrow(TypeError)
  expect(() => createSelectionDraft({ baseRevision: 1.5, applied: sets([]) })).toThrow(TypeError)
})

test('toApplyPayload carries the base revision, normalized selection and unresolved warnings', () => {
  const draft = createSelectionDraft({ baseRevision: 7, applied: sets([user], ['mcp-a']),
    unresolved: [{ kind: 'skill', ref: 'vendor/x', reason: 'not-installed' }] })
  draft.toggle(gamma, true)
  const payload = draft.toApplyPayload()
  expect(payload.expectedRevision).toBe(7)
  expect(payload.selection.skills).toEqual([user, gamma])
  expect(payload.selection.mcpServers).toEqual(['mcp-a'])
  expect(payload.unresolved).toEqual([{ kind: 'skill', ref: 'vendor/x', reason: 'not-installed' }])
})
