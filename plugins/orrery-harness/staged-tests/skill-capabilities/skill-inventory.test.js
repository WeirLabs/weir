import { test, expect } from '../../test/helpers.js'
import * as fs from 'node:fs/promises'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseSkillText, parseFrontmatter } from '../../src/capabilities/frontmatter.js'
import { discoverSkillInventory, resolveSkillRoots, findProjectRoot } from '../../src/capabilities/skill-inventory.js'
import { sameSkillIdentity } from '../../src/capabilities/skill-identity.js'

const fixtures = fileURLToPath(new URL('./fixtures/skill-inventory/', import.meta.url))
const reference = JSON.parse(await fs.readFile(join(fixtures, 'host-reference.json'), 'utf8'))
// These accepted host inputs intentionally exceed the strict subset.
const deviations = ['metadata-scalar.md', 'sequence.md', 'block.md', 'nested.md']
for (const [file, expected] of Object.entries(reference.files)) {
  test(`host parser fixture: ${file}`, async () => {
    const raw = await fs.readFile(join(fixtures, 'corpus', file), 'utf8')
    if (expected === null || deviations.includes(file)) expect(() => parseSkillText(raw)).toThrow()
    else expect(parseSkillText(raw)).toEqual(expected)
    if (deviations.includes(file)) expect(expected).not.toBeNull()
  })
}

test('fixture corpus and reference have exactly the same files', async () => {
  expect((await fs.readdir(join(fixtures, 'corpus'))).sort()).toEqual(Object.keys(reference.files).sort())
  expect(reference.version).toBe('0.2.0-rc.2')
})

test('strict YAML rejects unsupported syntax instead of interpreting it as a string', () => {
  for (const field of ['description: &anchor text', 'description: *anchor', 'description: >\n  multiline', 'description: [one]', 'description: { a: b }', 'description: !tag text', 'description: plain\n  continuation', 'metadata:\n  child:\n    nested: value', 'description: "bad\\q"', 'metadata: null']) {
    expect(() => parseSkillText(`---\nname: sample\ndescription: initial\n${field}\n---`)).toThrow()
  }
  expect(parseSkillText('---\nname: safe\ndescription: safe\nmetadata:\n  __proto__: safe\n---').metadata.__proto__).toBe('safe')
  expect(parseFrontmatter('---\nname: sample\ndescription: text\n---\n  body  ').body).toBe('body')
})

async function sandbox(t) {
  const base = await fs.realpath(tmpdir())
  const path = await fs.mkdtemp(join(base, 'orrery-skill-inventory-'))
  t.after(async () => {
    expect(dirname(resolve(path))).toBe(base)
    expect(basename(path).startsWith('orrery-skill-inventory-')).toBe(true)
    await fs.rm(path, { recursive: true, force: true })
  })
  return path
}
const text = (name = 'shared', body = 'Body') => `---\nname: ${name}\ndescription: Description\n---\n${body}\n`
async function put(path, content) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, content) }
const discover = (roots, extra = {}) => discoverSkillInventory({ roots, machineId: 'installation-a', ...extra })

test('root paths, labels and ranks match host reference, with a separate Orrery rank-300 root', async t => {
  const base = await sandbox(t)
  await fs.mkdir(join(base, 'project/.git'), { recursive: true })
  await fs.mkdir(join(base, 'project/nested'), { recursive: true })
  const roots = await resolveSkillRoots({ cwd: join(base, 'project/nested'), dshHome: join(base, 'dsh'), agentsHome: join(base, 'agents'), customSkillDirs: [join(base, 'custom')], bundledSkillDir: join(base, 'bundled') })
  expect(roots.map(({ scope, ...root }) => ({ ...root, path: root.path.replace(base, '$ROOT'), ...(root.projectRoot ? { projectRoot: root.projectRoot.replace(base, '$ROOT') } : {}) }))).toEqual(reference.roots)
  expect(await findProjectRoot(join(base, 'outside'))).toBe(join(base, 'outside'))
  await put(join(base, 'worktree/.git'), 'gitdir: elsewhere')
  expect(await findProjectRoot(join(base, 'worktree'))).toBe(join(base, 'worktree'))
  const builtin = await resolveSkillRoots({ includeDefaultRoots: false, orreryBuiltinDir: join(base, 'builtin') })
  expect(builtin[0]).toEqual({ path: join(base, 'builtin'), source: 'custom', scope: 'orrery-builtin', rank: 300, trustedHost: true })
})

test('same-name candidates stay separate, sorted within each root and never selected', async t => {
  const base = await sandbox(t)
  const roots = await resolveSkillRoots({ cwd: base, dshHome: join(base, 'dsh'), agentsHome: join(base, 'agents'), customSkillDirs: [join(base, 'custom')], bundledSkillDir: join(base, 'bundle') })
  for (const root of roots) await put(join(root.path, 'shared/SKILL.md'), text())
  await put(join(roots[0].path, 'a.md'), text('flat'))
  await put(join(roots[0].path, 'ignored.txt'), text())
  await put(join(roots[3].path, '.system/SKILL.md'), text('system'))
  const snapshot = await discover(roots)
  expect(snapshot.complete).toBe(true)
  expect(snapshot.candidates).toHaveLength(7)
  expect(snapshot.candidates.map(c => c.name)).toEqual(['flat', 'shared', 'shared', 'shared', 'shared', 'shared', 'shared'])
  expect(snapshot.candidates.filter(c => c.name === 'shared').map(c => [c.source, c.rank])).toEqual(reference.roots.map(c => [c.source, c.rank]))
  expect(sameSkillIdentity(snapshot.candidates[1].identity, snapshot.candidates[2].identity)).toBe(false)
  for (const candidate of snapshot.candidates) { expect(candidate.selected).toBeUndefined(); expect(candidate.identity.portable).toBe(false) }
  const flat = snapshot.candidates[0]
  expect(flat.locator.directory).toBe(roots[0].path)
  expect(flat.resourceBase).toEqual({ kind: 'directory', path: roots[0].path })
  expect(flat.path).toBe(await fs.realpath(flat.locator.path))
})

test('unparsed entries and broken links remain visible while valid symlinks use realpaths', async t => {
  const base = await sandbox(t)
  const roots = await resolveSkillRoots({ includeDefaultRoots: false, customSkillDirs: [base] })
  await put(join(base, 'invalid.md'), 'invalid')
  await fs.mkdir(join(base, 'missing'))
  await put(join(base, 'valid/SKILL.md'), text())
  await fs.symlink(join(base, 'valid'), join(base, 'alias'))
  await fs.symlink(join(base, 'absent'), join(base, 'broken'))
  const snapshot = await discover(roots)
  expect(snapshot.candidates.filter(c => c.status === 'unparsed')).toHaveLength(3)
  const parsed = snapshot.candidates.filter(c => c.status === 'parsed')
  expect(parsed).toHaveLength(2)
  expect(parsed[0].path).toBe(parsed[1].path)
})

test('root read failure retains last-good, marks incomplete and recovers without granting anything', async t => {
  const base = await sandbox(t)
  const roots = await resolveSkillRoots({ includeDefaultRoots: false, customSkillDirs: [join(base, 'a'), join(base, 'b')] })
  for (const root of roots) await put(join(root.path, 'sample.md'), text())
  const previous = await discover(roots)
  const faultyFs = { ...fs, readdir: async (path, options) => { if (path === roots[0].path) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.readdir(path, options) } }
  const failed = await discover(roots, { previous, fs: faultyFs })
  expect(failed.complete).toBe(false)
  expect(failed.roots[0].stale).toBe(true)
  expect(failed.roots[0].candidates).toEqual(previous.roots[0].candidates)
  expect(failed.candidates).toHaveLength(2)
  expect((await discover(roots, { previous: failed })).complete).toBe(true)
  const empty = await discover(roots, { fs: faultyFs })
  expect(empty.complete).toBe(false)
  expect(empty.candidates).toHaveLength(1)
})

test('trusted provenance is separate from metadata, and content revisions do not alter identity', async t => {
  const base = await sandbox(t)
  const roots = await resolveSkillRoots({ includeDefaultRoots: false, customSkillDirs: [base] })
  const file = join(base, 'sample.md')
  await put(file, text())
  const options = { provenanceFor: () => ({ repository: 'owner/repo', subpath: 'skill' }) }
  const first = (await discover(roots, options)).candidates[0]
  await put(file, text('shared', 'Changed'))
  const second = (await discover(roots, options)).candidates[0]
  expect(sameSkillIdentity(first.identity, second.identity)).toBe(true)
  expect(first.digest).not.toBe(second.digest)
  expect(second.identity.portable).toBe(true)
})
