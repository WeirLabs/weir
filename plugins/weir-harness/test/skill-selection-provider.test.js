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
