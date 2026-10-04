// D-H 6: the bundle's skills/ directory is enumerated by the selection
// provider under the 'orrery-builtin' scope while preserving the
// pre-migration customSkillDirs semantics (source 'custom', rank 300), and
// the first-run migration check fails closed with a visible reason on any
// deviation — without throwing during preset mounting.
import { test, expect } from './helpers.js'
import * as fs from 'node:fs/promises'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { discoverSkillInventory, resolveSkillRoots } from '../src/capabilities/skill-inventory.js'
import { createSkillSelectionPlugin, skillSelectionFor } from '../src/capabilities/skill-selection-plugin.js'
import {
  ORRERY_BUILTIN_SKILLS,
  ORRERY_BUILTIN_SOURCE,
  ORRERY_BUILTIN_RANK,
  ORRERY_BUILTIN_SCOPE,
  checkBuiltinSkillMigration,
  assertBuiltinSkillMigration,
} from '../src/capabilities/skill-builtin-migration.js'

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

async function sandbox(t) {
  const base = await fs.realpath(tmpdir())
  const path = await fs.mkdtemp(join(base, 'orrery-builtin-migration-'))
  t.after(async () => {
    expect(dirname(resolve(path))).toBe(base)
    expect(basename(path).startsWith('orrery-builtin-migration-')).toBe(true)
    await fs.rm(path, { recursive: true, force: true })
  })
  return path
}

const discover = async (dir, extra = {}) => {
  const roots = await resolveSkillRoots({ includeDefaultRoots: false, orreryBuiltinDir: dir })
  return discoverSkillInventory({ roots, machineId: 'installation-a', ...extra })
}

test('the real bundle skills/ discovery is equivalent to the pre-migration contract', async () => {
  const snapshot = await discover(SKILLS_DIR)
  expect(snapshot.complete).toBe(true)
  expect(checkBuiltinSkillMigration(snapshot)).toEqual({ ok: true })
  const builtin = snapshot.candidates.filter(candidate => candidate.identity?.scope === ORRERY_BUILTIN_SCOPE)
  expect(builtin.map(candidate => candidate.name).sort()).toEqual([...ORRERY_BUILTIN_SKILLS])
  for (const candidate of builtin) {
    expect(candidate.status).toBe('parsed')
    expect(candidate.source).toBe(ORRERY_BUILTIN_SOURCE)
    expect(candidate.rank).toBe(ORRERY_BUILTIN_RANK)
    expect(candidate.identity.portable).toBe(false)
  }
})

test('a missing builtin skill fails the check and names it', async t => {
  const base = await sandbox(t)
  await fs.cp(SKILLS_DIR, join(base, 'builtin'), { recursive: true })
  await fs.rm(join(base, 'builtin', 'debugging'), { recursive: true })
  const verdict = checkBuiltinSkillMigration(await discover(join(base, 'builtin')))
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('missing skills: debugging')
  expect(() => assertBuiltinSkillMigration({ roots: [], candidates: [] })).toThrow(/exactly one orrery-builtin root/)
})

test('an unexpected extra skill or an unparsed entry fails the check', async t => {
  const base = await sandbox(t)
  await fs.cp(SKILLS_DIR, join(base, 'extra'), { recursive: true })
  await fs.mkdir(join(base, 'extra', 'stray'))
  await fs.writeFile(join(base, 'extra', 'stray', 'SKILL.md'), '---\nname: stray\ndescription: Stray\n---\nStray\n')
  const extra = checkBuiltinSkillMigration(await discover(join(base, 'extra')))
  expect(extra.ok).toBe(false)
  expect(extra.reason).toContain('unexpected skills: stray')
  await fs.cp(SKILLS_DIR, join(base, 'broken'), { recursive: true })
  await fs.writeFile(join(base, 'broken', 'debugging', 'SKILL.md'), 'not frontmatter')
  const broken = checkBuiltinSkillMigration(await discover(join(base, 'broken')))
  expect(broken.ok).toBe(false)
  expect(broken.reason).toContain('unparsed builtin entries: debugging')
})

test('a duplicated builtin name fails the check and names it', () => {
  const root = { path: '/builtin', source: ORRERY_BUILTIN_SOURCE, scope: ORRERY_BUILTIN_SCOPE, rank: ORRERY_BUILTIN_RANK }
  const candidates = [...ORRERY_BUILTIN_SKILLS, 'research'].map(name => ({ status: 'parsed', name, source: ORRERY_BUILTIN_SOURCE, rank: ORRERY_BUILTIN_RANK, root }))
  const verdict = checkBuiltinSkillMigration({ roots: [{ root, complete: true }], candidates })
  expect(verdict.ok).toBe(false)
  expect(verdict.reason).toContain('duplicate skills: research')
})

test('divergent labels and an unreadable root fail with the divergence in the reason', () => {
  const root = { path: '/builtin', source: ORRERY_BUILTIN_SOURCE, scope: ORRERY_BUILTIN_SCOPE, rank: ORRERY_BUILTIN_RANK }
  const candidate = (name, source, rank) => ({ status: 'parsed', name, source, rank, root })
  const candidates = ORRERY_BUILTIN_SKILLS.map(name => candidate(name, ORRERY_BUILTIN_SOURCE, ORRERY_BUILTIN_RANK))
  const labeled = { roots: [{ root, complete: true }], candidates: candidates.map(item => item.name === 'research' ? candidate('research', 'bundled', 600) : item) }
  const divergent = checkBuiltinSkillMigration(labeled)
  expect(divergent.ok).toBe(false)
  expect(divergent.reason).toContain('research (source=bundled, rank=600)')
  const unreadable = checkBuiltinSkillMigration({ roots: [{ root, complete: false, error: 'denied' }], candidates: [] })
  expect(unreadable.ok).toBe(false)
  expect(unreadable.reason).toContain('unreadable')
  expect(unreadable.reason).toContain('denied')
})

function mount() {
  let registered
  const ctx = {
    skills: { registerProvider(create) { registered = create({ invalidate() {} }) } },
    on() {},
    get() { return undefined },
  }
  return { ctx, registered: () => registered }
}

test('a selected builtin skill is served with the pre-migration labels', async t => {
  const base = await sandbox(t)
  const snapshot = await discover(SKILLS_DIR)
  const identity = snapshot.candidates.find(candidate => candidate.name === 'deep-work').identity
  const { ctx, registered } = mount()
  createSkillSelectionPlugin({
    readSelection: async () => [identity],
    office: async () => ({ complete: true, candidates: [] }),
  })(ctx, { machineId: 'installation-a', dshHome: join(base, 'dsh'), agentsHome: join(base, 'agents') })
  const listed = await registered().list()
  expect(listed.complete).toBe(true)
  const served = listed.candidates.find(candidate => candidate.name === 'deep-work')
  expect(served.provider).toBe('orrery-selected')
  expect(served.source).toBe(ORRERY_BUILTIN_SOURCE)
  expect(served.rank).toBe(ORRERY_BUILTIN_RANK)
  expect(served.identity.scope).toBe(ORRERY_BUILTIN_SCOPE)
  expect(skillSelectionFor(ctx).status().error).toBeNull()
  const loaded = await registered().get(served)
  expect(loaded.name).toBe('deep-work')
  expect(loaded.content.length > 0).toBe(true)
})

test('a non-equivalent builtin discovery fails closed with a visible reason, and mounting never throws', async t => {
  const base = await sandbox(t)
  await fs.cp(SKILLS_DIR, join(base, 'builtin'), { recursive: true })
  await fs.rm(join(base, 'builtin', 'review-work'), { recursive: true })
  const snapshot = await discover(SKILLS_DIR)
  const identity = snapshot.candidates.find(candidate => candidate.name === 'deep-work').identity
  const { ctx, registered } = mount()
  // Mounting itself must not throw (the 3.4 hard contract); the failure is a
  // visible provider state once enumeration runs.
  createSkillSelectionPlugin({
    readSelection: async () => [identity],
    office: async () => ({ complete: true, candidates: [] }),
  })(ctx, { machineId: 'installation-a', dshHome: join(base, 'dsh'), agentsHome: join(base, 'agents'), orreryBuiltinDir: join(base, 'builtin') })
  const listed = await registered().list()
  expect(listed.complete).toBe(false)
  expect(listed.candidates).toHaveLength(3)
  expect(listed.candidates.every(candidate => !candidate.invocation.modelInvocable && !candidate.invocation.userInvocable)).toBe(true)
  const status = skillSelectionFor(ctx).status()
  expect(status.error).toContain('Orrery builtin skill migration check failed')
  expect(status.error).toContain('missing skills: review-work')
})
