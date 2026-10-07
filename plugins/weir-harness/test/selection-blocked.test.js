// Task 6.4 of the session-capability-manager change: fail-closed rules.
// Root/existing sessions with an unreadable selection record get an empty
// Skill view plus a classified, actionable recovery entry — never a
// full-discovery fallback, never a rewritten original file. A new accepted
// Apply is the recovery path. A disposed provider stays denial-only.
import { test, expect } from './helpers.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'
import { createSkillSelectionProvider } from '../src/capabilities/skill-selection-provider.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'

const home = () => mkdtempSync(join(tmpdir(), 'weir-blocked-'))
const rootOf = home => join(home, 'weir', 'profiles', 'it', 'capabilities')
const alpha = createSkillIdentity({ scope: 'user', root: '/user', name: 'alpha', opaqueId: 'user-alpha' })

function mount(home) {
  let registered
  const ctx = {
    skills: { registerProvider(create) { registered = create({ invalidate() {} }) } },
    on() {},
    get(name) { return name === 'profileContext' ? { home, name: 'it' } : undefined },
  }
  createSkillSelectionPlugin({
    inventory: async () => ({ complete: true, candidates: [{ status: 'parsed', name: 'alpha', identity: alpha, path: '/user/alpha/SKILL.md', digest: 'd1', invocation: { modelInvocable: true, userInvocable: true } }] }),
    office: async () => ({ complete: true, candidates: [] }),
    lifecycle: { agentCreated: () => undefined },
  })(ctx)
  return registered
}

const options = sessionId => ({ cwd: '/ws', scope: { session: { id: sessionId } } })

const seedRecord = async (root, sessionId, payload) => {
  const store = openCapabilityStore({ root, platform: 'darwin' })
  await store.commit({ kind: 'selection', sessionId }, 0, () => payload)
}

test('6.4 an unreadable record is a distinct classified failure with an actionable hint', async () => {
  const dir = home()
  mkdirSync(join(rootOf(dir), 'sessions', 's1', 'selection.json'), { recursive: true }) // EISDIR
  const provider = mount(dir)
  const list = await provider.list(options('s1'))
  expect(list.candidates.every(item => !item.invocation.modelInvocable && !item.invocation.userInvocable)).toBe(true)
  const status = provider.status(options('s1'))
  expect(status.reason ?? status.note?.reason).toBe('policy-unreadable:unreadable')
  expect(typeof (status.hint ?? status.note?.hint)).toBe('string')
})

test('6.4 corrupt, unknown-schema and torn records classify with their own reasons and never get rewritten', async () => {
  const dir = home()
  const root = rootOf(dir)
  mkdirSync(join(root, 'sessions', 'corrupt'), { recursive: true })
  writeFileSync(join(root, 'sessions', 'corrupt', 'selection.json'), '{')
  mkdirSync(join(root, 'sessions', 'schema'), { recursive: true })
  writeFileSync(join(root, 'sessions', 'schema', 'selection.json'), JSON.stringify({ schemaVersion: 99, revision: 1, payload: {}, receipts: [], digest: 'x' }))
  await seedRecord(root, 'torn', { skills: [], mcpServers: [] })
  const tornPath = join(root, 'sessions', 'torn', 'selection.json')
  const torn = JSON.parse(readFileSync(tornPath, 'utf8'))
  torn.revision = 42
  writeFileSync(tornPath, JSON.stringify(torn))
  const provider = mount(dir)
  const reasonOf = async id => {
    const status = provider.status(options(id))
    await provider.list(options(id))
    const after = provider.status(options(id))
    return after.reason ?? after.note?.reason ?? status.reason ?? status.note?.reason
  }
  expect(await reasonOf('corrupt')).toBe('policy-unreadable:corrupt')
  expect(await reasonOf('schema')).toBe('policy-unreadable:unknown-schema')
  expect(await reasonOf('torn')).toBe('policy-unreadable:torn')
  // The original files are never rewritten from any read path.
  expect(readFileSync(join(root, 'sessions', 'corrupt', 'selection.json'), 'utf8')).toBe('{')
})

test('6.4 an accepted Apply is the recovery path out of the blocked state', async () => {
  const dir = home()
  mkdirSync(join(rootOf(dir), 'sessions', 's2'), { recursive: true })
  writeFileSync(join(rootOf(dir), 'sessions', 's2', 'selection.json'), '{')
  const provider = mount(dir)
  await provider.list(options('s2'))
  expect((await provider.list(options('s2'))).candidates.every(item => !item.invocation.modelInvocable)).toBe(true)
  provider.acceptSelection([alpha], options('s2'))
  const list = await provider.list(options('s2'))
  expect(list.candidates.some(item => item.identity?.name === 'alpha' && item.invocation.modelInvocable)).toBe(true)
})

test('6.4 a disposed provider stays denial-only and never falls back to discovery', async () => {
  const provider = createSkillSelectionProvider({
    control: { invalidate() {} },
    readSelection: async () => [alpha],
    inventory: async () => ({ complete: true, candidates: [{ status: 'parsed', name: 'alpha', identity: alpha, path: '/user/alpha/SKILL.md', digest: 'd' }] }),
    denials: () => [{ name: 'shadow', invocation: { modelInvocable: false, userInvocable: false } }],
  })
  provider.dispose()
  const list = await provider.list(options('s3'))
  expect(list.complete).toBe(false)
  expect(list.candidates).toHaveLength(1)
  expect(list.candidates[0].name).toBe('shadow')
})
