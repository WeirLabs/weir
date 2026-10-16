import { test, expect } from './helpers.js'
import { createHash } from 'node:crypto'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'
import { createSkillSelectionProvider, validateSkillSelection } from '../src/capabilities/skill-selection-provider.js'
import { createSkillSelectionPlugin, skillSelectionFor } from '../src/capabilities/skill-selection-plugin.js'

const text = body => `---\nname: example\ndescription: Example skill\n---\n${body}`
function candidate(scope) {
  const path = `/${scope}/example/SKILL.md`
  return { status: 'parsed', name: 'example', description: 'Example skill', rank: scope === 'project' ? 100 : 400,
    identity: createSkillIdentity({ scope, root: `/${scope}`, name: 'example', opaqueId: scope }),
    path, locator: { path }, resourceBase: { kind: 'directory', path: `/${scope}/example` },
    digest: createHash('sha256').update(text(scope)).digest('hex') }
}
const user = candidate('user')
const project = candidate('project')
function setup({ selected = [user.identity], inventory, readSelection, invalidate = () => {} } = {}) {
  let scans = 0
  const provider = createSkillSelectionProvider({
    control: { invalidate }, readSelection: readSelection ?? (async () => selected),
    inventory: inventory ?? (async () => { scans++; return { complete: true, candidates: [project, user] } }),
    fs: { realpath: async path => path, readFile: async path => text(path.includes('/user/') ? 'user' : 'project') },
  })
  return { provider, scans: () => scans }
}

test('loads only the selected user identity despite a higher-ranked unselected project name', async () => {
  const { provider } = setup()
  const listed = await provider.list()
  expect(listed.candidates.map(c => c.identity)).toEqual([user.identity])
  // The provider's candidates ARE the effective selection: selected matches
  // carry the explicit stamp the /capabilities receipt and manager rows read.
  expect(listed.candidates[0].selected).toBe(true)
  expect((await provider.get(listed.candidates[0])).content).toBe('user')
  expect(await provider.get(project)).toBeUndefined()
})

test('conflicts are visible and Apply cannot choose an arbitrary winner', async () => {
  const { provider } = setup()
  expect(validateSkillSelection([user.identity, project.identity]).conflicts).toHaveLength(1)
  expect(provider.acceptSelection([user.identity, project.identity]).accepted).toBe(false)
  expect(provider.status().conflicts[0].name).toBe('example')
  expect((await provider.list()).candidates[0].identity.scope).toBe('user')
  const conflicting = setup({ selected: [user.identity, project.identity] }).provider
  expect((await conflicting.list()).candidates).toEqual([])
  expect(conflicting.status().conflicts).toHaveLength(1)
})

test('mount performs no policy reads and unreadable policy fails closed without throwing', async () => {
  let reads = 0
  let registered
  const ctx = { skills: { registerProvider(create) { registered = create({ invalidate() {} }) } }, on() {} }
  createSkillSelectionPlugin({ readSelection: async () => { reads++; throw new Error('policy denied') }, inventory: async () => { throw new Error('must not scan') } })(ctx)
  expect(reads).toBe(0)
  expect((await registered.list()).candidates.every(item => !item.invocation.modelInvocable && !item.invocation.userInvocable)).toBe(true)
  // Denial placeholders never carry the selected stamp.
  expect((await registered.list()).candidates.every(item => item.selected !== true)).toBe(true)
  expect((await registered.list()).candidates).toHaveLength(3)
  expect(skillSelectionFor(ctx).status().error).toBe('policy denied')
})

test('registration failures are visible rather than breaking preset mounting', () => {
  const ctx = { skills: { registerProvider() { throw new Error('duplicate') } } }
  createSkillSelectionPlugin()(ctx)
  expect(skillSelectionFor(ctx).status().error).toBe('duplicate')
})

test('fake registry retains old collect cache unless control.invalidate is called', async () => {
  let cache
  let enabled = false
  const { provider } = setup({ invalidate: () => { if (enabled) cache = undefined } })
  const list = async () => cache ??= await provider.list()
  expect((await list()).candidates[0].identity.scope).toBe('user')
  provider.acceptSelection([project.identity])
  expect((await list()).candidates[0].identity.scope).toBe('user')
  enabled = true
  provider.acceptSelection([project.identity])
  expect((await list()).candidates[0].identity.scope).toBe('project')
})

test('N invalidations and synchronous raw-selected echoes enter enumeration only once', async () => {
  let invalidations = 0
  const { provider, scans } = setup({ invalidate() { invalidations++; provider.sourceChanged() } })
  await provider.list()
  for (let i = 0; i < 100; i++) provider.sourceChanged()
  await Promise.resolve()
  await Promise.all(Array.from({ length: 100 }, () => provider.list()))
  expect(invalidations).toBe(1)
  expect(scans()).toBe(2)
})

test('missing or incomplete selected inventory never substitutes by name', async () => {
  for (const snapshot of [{ complete: true, candidates: [project] }, { complete: false, candidates: [user] }]) {
    const { provider } = setup({ inventory: async () => snapshot })
    expect((await provider.list()).candidates).toEqual([])
    expect(provider.status().error).toContain('missing, ambiguous or incomplete')
  }
})

test('invalid policy, disposal and content drift fail closed', async () => {
  expect((await setup({ selected: ['example'] }).provider.list()).candidates).toEqual([])
  const { provider } = setup()
  const listed = await provider.list()
  listed.candidates[0].digest = 'stale'
  expect(await provider.get(listed.candidates[0])).toBeUndefined()
  expect(provider.status().error).toContain('content changed')
  provider.dispose()
  expect((await provider.list()).candidates).toEqual([])
})


test('multiple mounted providers do not asynchronously excite each other', async () => {
  const providers = []
  let emissions = 0
  const invalidate = () => { emissions++; for (const provider of providers) provider.sourceChanged() }
  providers.push(setup({ invalidate }).provider, setup({ invalidate }).provider)
  invalidate()
  await Promise.resolve()
  await Promise.resolve()
  expect(emissions).toBe(3)
})

test('in-flight enumeration cannot republish a selection revoked by Apply', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { provider } = setup({ inventory: async () => { await gate; return { complete: true, candidates: [user] } } })
  const pending = provider.list()
  await Promise.resolve()
  provider.acceptSelection([])
  release()
  expect((await pending).candidates).toEqual([])
  expect((await provider.list()).candidates).toEqual([])
})

test('concurrent fresh reads share the in-flight collect instead of degrading each other', async () => {
  // 2026-10-12 live diagnosis (audit weir/capability-read): the Badge and the
  // manager panel fetch the receipt concurrently; the old fresh() cleared the
  // epoch again for the second caller, so the shared in-flight collect failed
  // its stale-epoch guard and BOTH receipts returned complete:false with no
  // error — the permanent "accepted but unverifiable" Badge state.
  let release
  const gate = new Promise(resolve => { release = resolve })
  let scans = 0
  const { provider } = setup({ inventory: async () => { scans++; await gate; return { complete: true, candidates: [project, user] } } })
  const first = provider.fresh()
  const second = provider.fresh()
  release()
  const [a, b] = await Promise.all([first, second])
  expect(a.complete).toBe(true)
  expect(b.complete).toBe(true)
  expect(a.candidates.length).toBe(1)
  expect(scans).toBe(1)
  expect(provider.status().error).toBe(null)
  // A later fresh read still re-enumerates (no stale cache).
  const third = await provider.fresh()
  expect(third.complete).toBe(true)
  expect(scans).toBe(2)
})

// ---- capabilities-deepening D5: the retired duplicate-admission assertions,
// retargeted. The deleted suite pinned a parallel admission implementation
// with zero production importers; the REAL blocking has always been this
// provider's production path (collect pending reuse, epoch re-checks in get,
// fail-closed empty lists). Those assertions live here now, driving
// createSkillSelectionProvider directly — no stub admission object:
//   old 'path 1' (unselected body never loaded)        -> 'unselected or malformed identities never touch the fs'
//   old 'path 2' (slash re-validation flips)           -> 'the server-side read verdict flips with the accepted selection'
//   old 'path 3' (handed-off read revoked)             -> 'an in-flight read is revoked before publication when a removal lands mid-read'
//   old 'not-handed-off loads/prompt publications refused' -> the same test's post-removal arm (no fs read after removal)
//   old 'fence refuses while an Apply commits'         -> covered by 'in-flight enumeration cannot republish a selection revoked by Apply'
//                                                         and 'concurrent fresh reads share the in-flight collect' above
//   old 'handed-off read finishes when authority unchanged' -> the removal test's control arm (read completes before the Apply)
//   old 'superseded revision revokes even when selected'    -> 'an in-flight read is revoked by a superseding Apply even when the skill stays selected'
//   old 'authority unavailable fails closed; explicit empty is distinct' -> 'an unreadable policy fails closed on reads; an explicit empty selection is a loaded empty state'
//   old 'malformed sessions/identities fail closed'    -> the malformed arm of 'unselected or malformed identities never touch the fs'

test('unselected or malformed identities read as undefined and never touch the fs', async () => {
  let reads = 0
  const fs = { realpath: async path => path, readFile: async path => { reads++; return text('user') } }
  const provider = createSkillSelectionProvider({
    control: { invalidate() {} },
    readSelection: async () => [user.identity],
    inventory: async () => ({ complete: true, candidates: [project, user] }),
    fs,
  })
  const listed = await provider.list()
  expect(listed.candidates.map(c => c.identity)).toEqual([user.identity])
  // An unselected (higher-ranked) identity: get returns undefined and the
  // content file is never read — the loader never runs.
  expect(await provider.get(project)).toBeUndefined()
  expect(reads).toBe(0)
  // A malformed identity fails closed the same way, without a read.
  expect(await provider.get({ name: 'example', identity: { scope: 'user', name: 'example' } })).toBeUndefined()
  expect(reads).toBe(0)
  // The selected identity still loads.
  expect((await provider.get(listed.candidates[0])).content).toBe('user')
  expect(reads).toBe(1)
})

test('the server-side read verdict flips with the accepted selection (never trusting client filtering)', async () => {
  const { provider } = setup()
  const listed = await provider.list()
  const selected = listed.candidates[0]
  expect((await provider.get(selected)).content).toBe('user')
  // A removal Apply lands: the same read is now refused server-side.
  provider.acceptSelection([])
  expect(await provider.get(selected)).toBeUndefined()
  expect((await provider.list()).candidates).toEqual([])
})

test('an in-flight read is revoked before publication when a removal lands mid-read', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let armed = false
  let entered = false
  const fs = {
    realpath: async path => path,
    readFile: async path => {
      if (armed) { entered = true; await gate }
      return text(path.includes('/user/') ? 'user' : 'project')
    },
  }
  const provider = createSkillSelectionProvider({
    control: { invalidate() {} },
    readSelection: async () => [user.identity],
    inventory: async () => ({ complete: true, candidates: [project, user] }),
    fs,
  })
  const listed = await provider.list()
  const selected = listed.candidates[0]
  // Control arm: a read completing before any selection change is served.
  expect((await provider.get(selected)).content).toBe('user')
  // The handed-off read: the file read is mid-flight when the removal lands.
  armed = true
  const pending = provider.get(selected)
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  provider.acceptSelection([]) // the Apply commits: epoch superseded
  release()
  expect(await pending).toBeUndefined() // revoked: no content published
  // After the removal, not-handed-off reads never touch the fs either.
  expect(await provider.get(selected)).toBeUndefined()
})

test('an in-flight read is revoked by a superseding Apply even when the skill stays selected', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered = false
  const fs = {
    realpath: async path => path,
    readFile: async path => { entered = true; await gate; return text('user') },
  }
  const provider = createSkillSelectionProvider({
    control: { invalidate() {} },
    readSelection: async () => [user.identity],
    inventory: async () => ({ complete: true, candidates: [project, user] }),
    fs,
  })
  const listed = await provider.list()
  const selected = listed.candidates[0]
  const pending = provider.get(selected)
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  // An unrelated Apply (same selection, new revision) still supersedes the
  // epoch: the in-flight read is revoked conservatively and the caller retries.
  provider.acceptSelection([user.identity])
  release()
  expect(await pending).toBeUndefined()
  // A fresh read under the new epoch serves again.
  expect((await provider.get(selected)).content).toBe('user')
})

test('an unreadable policy fails closed on reads; an explicit empty selection is a loaded empty state', async () => {
  let reads = 0
  const fs = { realpath: async path => path, readFile: async path => { reads++; return text('user') } }
  const unavailable = createSkillSelectionProvider({
    control: { invalidate() {} },
    readSelection: async () => { throw new Error('policy unreadable') },
    inventory: async () => ({ complete: true, candidates: [project, user] }),
    fs,
  })
  // Fail closed: no loaded authority means nothing is served, ever.
  expect((await unavailable.list()).candidates).toEqual([])
  expect(unavailable.status().error).toBe('policy unreadable')
  expect(await unavailable.get(user)).toBeUndefined()
  expect(reads).toBe(0)

  // An explicitly emptied selection IS a loaded authority: complete and
  // error-free, just empty — distinct from the unavailable state above.
  const emptied = setup({ selected: [] })
  const result = await emptied.provider.list()
  expect(result.complete).toBe(true)
  expect(result.candidates).toEqual([])
  expect(emptied.provider.status().error).toBe(null)
  expect(await emptied.provider.get(user)).toBeUndefined()
})
