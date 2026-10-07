// capability-manager-ux tasks 6.1-6.3 (design D6): the version-2 preset
// package — pack (origin split), validate (atomic gate, bounds), the
// two-phase import plan, and the confirmed install discipline (temp-name →
// rename, rollback, same-name-policy collisions, audit).
import { test, expect } from './helpers.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'
import {
  PACKAGE_LIMITS, SKILL_ORIGINS, bindPackageSelection, classifySkillOrigin, packPresetPackage,
  planPackageInstall, portableRefForIdentity, validateEntryPath, validatePresetPackage,
} from '../src/capabilities/preset-package.js'
import { installBundledSkills, renameSkillContent } from '../src/capabilities/preset-package-install.js'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'weir-pkg-'))

const writeSkill = (dir, name, files = {}) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} fixture\n---\n${name}\n`)
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, ...rel.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

/** A parsed-candidate fixture matching the shape discoverSkillInventory stamps. */
const candidateOf = (identity, directory, mainFile = 'SKILL.md', description = `${identity.name} fixture`) => ({
  status: 'parsed',
  identity,
  locator: { path: join(directory, mainFile), directory },
  description,
})

// ---- 6.1 pack: the D6 origin split ----------------------------------------

test('pack splits a selection by Skill origin (remote ref / project bundled / user bundled / builtin name)', async () => {
  const root = tmp()
  const projectRoot = join(root, 'project-skills')
  const userRoot = join(root, 'user-skills')
  writeSkill(join(projectRoot, 'ws-tool'), 'ws-tool', { 'refs/data.txt': 'DATA\n' })
  writeSkill(join(userRoot, 'local-tool'), 'local-tool', { 'scripts/run.sh': '#!/bin/sh\necho hi\n' })
  writeFileSync(join(userRoot, 'local-tool', 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]))

  const wsIdentity = createSkillIdentity({ scope: 'project', root: projectRoot, name: 'ws-tool', opaqueId: 'ws-1' })
  const localIdentity = createSkillIdentity({ scope: 'custom', root: userRoot, name: 'local-tool', opaqueId: 'u-1' })
  const remoteIdentity = createSkillIdentity({ scope: 'user', root: '/installed/remote', name: 'remote-tool', provenance: { kind: 'git', repository: 'owner/repo', ref: 'v1.2.3' } })
  const builtinIdentity = createSkillIdentity({ scope: 'weir-builtin', root: join(root, 'builtin'), name: 'builtin-tool', opaqueId: 'b-1' })

  const candidates = [
    candidateOf(wsIdentity, join(projectRoot, 'ws-tool')),
    candidateOf(localIdentity, join(userRoot, 'local-tool')),
    // builtin-tool deliberately absent from the inventory → warning
  ]
  const selection = {
    skills: [remoteIdentity, wsIdentity, localIdentity, builtinIdentity],
    mcpServers: ['docs', 'ghost'],
    unresolvedRefs: [{ kind: 'mcp', ref: { identity: 'old', label: 'Old' }, reason: 'gone' }],
  }
  const packed = await packPresetPackage({ name: 'Mixed', selection }, {
    candidates,
    mcpLabels: identity => (identity === 'docs' ? 'Docs Label' : undefined),
  })
  expect(packed.ok).toBe(true)
  const pkg = packed.package
  expect(pkg.version).toBe(2)
  expect(pkg.name).toBe('Mixed')
  // remote → portable ref, no content
  expect(pkg.selection.skills).toEqual([{ kind: 'git', repository: 'owner/repo', ref: 'v1.2.3', name: 'remote-tool', targetScope: 'user' }])
  // MCP: managed identity + registry label; an unknown identity falls back to itself
  expect(pkg.selection.mcpServers).toEqual([{ identity: 'docs', label: 'Docs Label' }, { identity: 'ghost', label: 'ghost' }])
  // carried refs travel verbatim
  expect(pkg.selection.unresolvedRefs).toEqual([{ kind: 'mcp', ref: { identity: 'old', label: 'Old' }, reason: 'gone' }])
  // builtin → name reference
  expect(pkg.builtin).toEqual(['builtin-tool'])
  // workspace/local content bundled with the target scope
  const ws = pkg.bundled.find(entry => entry.name === 'ws-tool')
  expect(ws.targetScope).toBe('project')
  expect(ws.description).toBe('ws-tool fixture')
  expect(ws.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'refs/data.txt'])
  expect(ws.files.find(file => file.path === 'refs/data.txt').content).toBe('DATA\n')
  const local = pkg.bundled.find(entry => entry.name === 'local-tool')
  expect(local.targetScope).toBe('user')
  expect(local.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'scripts/run.sh'])
  // the binary file never travels; the skip is named in warnings
  expect(pkg.warnings.some(w => w.includes('binary file "logo.bin"'))).toBe(true)
  expect(pkg.warnings.some(w => w.includes('builtin skill "builtin-tool"'))).toBe(true)
  // a pack result is always a compliant document
  expect(validatePresetPackage(pkg).ok).toBe(true)
})

test('pack resolves bare name entries through the inventory and warns on unknown names', async () => {
  const root = tmp()
  const userRoot = join(root, 'user-skills')
  writeSkill(join(userRoot, 'local-tool'), 'local-tool')
  const identity = createSkillIdentity({ scope: 'custom', root: userRoot, name: 'local-tool', opaqueId: 'u-1' })
  const packed = await packPresetPackage(
    { name: 'Names', selection: { skills: ['local-tool', 'absent-tool'], mcpServers: [], unresolvedRefs: [] } },
    { candidates: [candidateOf(identity, join(userRoot, 'local-tool'))] },
  )
  expect(packed.ok).toBe(true)
  expect(packed.package.bundled.map(entry => entry.name)).toEqual(['local-tool'])
  expect(packed.package.warnings.some(w => w.includes('"absent-tool"'))).toBe(true)
})

test('pack warns and omits a remote identity whose provenance cannot form a compliant ref', async () => {
  const broken = createSkillIdentity({ scope: 'user', root: '/installed/remote', name: 'remote-tool', provenance: { note: 'no-repository' } })
  const packed = await packPresetPackage({ name: 'X', selection: { skills: [broken], mcpServers: [], unresolvedRefs: [] } })
  expect(packed.ok).toBe(true)
  expect(packed.package.selection.skills).toEqual([])
  expect(packed.package.warnings.some(w => w.includes('repository/ref'))).toBe(true)
})

test('pack normalizes a flat single-file skill to directory form', async () => {
  const root = tmp()
  const userRoot = join(root, 'user-skills')
  mkdirSync(userRoot, { recursive: true })
  writeFileSync(join(userRoot, 'flat.md'), '---\nname: flat\ndescription: flat fixture\n---\nFLAT\n')
  const identity = createSkillIdentity({ scope: 'user', root: userRoot, name: 'flat', opaqueId: 'f-1' })
  const packed = await packPresetPackage(
    { name: 'Flat', selection: { skills: [identity], mcpServers: [], unresolvedRefs: [] } },
    { candidates: [candidateOf(identity, userRoot, 'flat.md', 'flat fixture')] },
  )
  expect(packed.ok).toBe(true)
  expect(packed.package.bundled).toEqual([{
    targetScope: 'user',
    name: 'flat',
    description: 'flat fixture',
    files: [{ path: 'SKILL.md', content: '---\nname: flat\ndescription: flat fixture\n---\nFLAT\n' }],
  }])
})

test('pack refuses an oversized UTF-8 file and names it', async () => {
  const root = tmp()
  const userRoot = join(root, 'user-skills')
  writeSkill(join(userRoot, 'local-tool'), 'local-tool', { 'big.txt': 'x'.repeat(PACKAGE_LIMITS.fileBytes + 1) })
  const identity = createSkillIdentity({ scope: 'custom', root: userRoot, name: 'local-tool', opaqueId: 'u-1' })
  const packed = await packPresetPackage(
    { name: 'X', selection: { skills: [identity], mcpServers: [], unresolvedRefs: [] } },
    { candidates: [candidateOf(identity, join(userRoot, 'local-tool'))] },
  )
  expect(packed.ok).toBe(false)
  expect(packed.reason).toContain('big.txt')
})

test('pack never emits a document the import gate would reject', async () => {
  const carried = await packPresetPackage({ name: 'X', selection: { skills: [], mcpServers: [], unresolvedRefs: [42] } })
  expect(carried.ok).toBe(false)
  expect(carried.reason).toContain('unresolvedRefs[0]')
  const badMcp = await packPresetPackage({ name: 'X', selection: { skills: [], mcpServers: [42], unresolvedRefs: [] } })
  expect(badMcp.ok).toBe(false)
  const badSkill = await packPresetPackage({ name: 'X', selection: { skills: [{ scope: 'project' }], mcpServers: [], unresolvedRefs: [] } })
  expect(badSkill.ok).toBe(false)
})

// ---- 6.1 classify / portable refs ------------------------------------------

test('classifySkillOrigin buckets identities per D6', () => {
  expect(classifySkillOrigin({ scope: 'project', root: '/r', name: 'a', opaqueId: 'x' })).toBe(SKILL_ORIGINS.workspace)
  expect(classifySkillOrigin({ scope: 'user', root: '/r', name: 'a', opaqueId: 'x' })).toBe(SKILL_ORIGINS.localUser)
  expect(classifySkillOrigin({ scope: 'custom', root: '/r', name: 'a', opaqueId: 'x' })).toBe(SKILL_ORIGINS.localUser)
  expect(classifySkillOrigin({ scope: 'user', root: '/r', name: 'a', provenance: { repository: 'o/r', ref: 'main' } })).toBe(SKILL_ORIGINS.remote)
  expect(classifySkillOrigin({ scope: 'custom', root: '/r', name: 'a', provenance: { repository: 'o/r', ref: 'main' } })).toBe(SKILL_ORIGINS.remote)
  expect(classifySkillOrigin({ scope: 'weir-builtin', root: '/r', name: 'a', opaqueId: 'x' })).toBe(SKILL_ORIGINS.builtin)
})

test('portableRefForIdentity carries whitelisted provenance only', () => {
  const built = portableRefForIdentity({
    scope: 'user', root: '/r', name: 'tool',
    provenance: { kind: 'git', repository: 'o/r', ref: 'v1', subpath: 'skills/tool', commit: 'abc', digest: 'sha256:x', secret: 'nope' },
  })
  expect(built.ok).toBe(true)
  expect(built.ref).toEqual({ kind: 'git', repository: 'o/r', ref: 'v1', name: 'tool', subpath: 'skills/tool', commit: 'abc', digest: 'sha256:x', targetScope: 'user' })
  expect(portableRefForIdentity({ scope: 'user', root: '/r', name: 'tool', provenance: { note: 'local' } }).ok).toBe(false)
  expect(portableRefForIdentity({ scope: 'user', root: '/r', name: 'tool', opaqueId: 'x' }).ok).toBe(false)
})

// ---- 6.1 validate: the atomic gate -----------------------------------------

const minimalPackage = () => ({
  version: 2,
  name: 'P',
  selection: { skills: [], mcpServers: [], unresolvedRefs: [] },
  builtin: [],
  bundled: [{ targetScope: 'project', name: 'tool', files: [{ path: 'SKILL.md', content: 'x' }] }],
  warnings: [],
})

test('validate accepts a minimal package and enforces every whitelist', () => {
  expect(validatePresetPackage(minimalPackage()).ok).toBe(true)
  expect(validatePresetPackage(null).ok).toBe(false)
  expect(validatePresetPackage('x').ok).toBe(false)
  expect(validatePresetPackage([1, 2]).ok).toBe(false)
  for (const [label, mutate, reason] of [
    ['unknown document field', p => { p.extra = 1 }, 'document:unknown-field:extra'],
    ['unknown selection field', p => { p.selection.extra = 1 }, 'selection:unknown-field:extra'],
    ['version 1', p => { p.version = 1 }, 'document:unknown-version'],
    ['version 3', p => { p.version = 3 }, 'document:unknown-version'],
    ['string version', p => { p.version = '2' }, 'document:unknown-version'],
    ['missing version', p => { delete p.version }, 'document:unknown-version'],
    ['empty name', p => { p.name = '' }, 'document:invalid-name'],
    ['selection not an object', p => { p.selection = [] }, 'document:invalid-selection'],
    ['bad targetScope', p => { p.bundled[0].targetScope = 'global' }, 'bundled[0]:invalid-targetScope'],
    ['bad skill name', p => { p.bundled[0].name = 'Bad_Name' }, 'bundled[0]:invalid-name'],
    ['unknown bundled field', p => { p.bundled[0].extra = 1 }, 'bundled[0]:unknown-field:extra'],
    ['unknown file field', p => { p.bundled[0].files[0].extra = 1 }, 'bundled[0].files[0]:unknown-field:extra'],
    ['no files', p => { p.bundled[0].files = [] }, 'bundled[0]:no-files'],
    ['duplicate bundled skill', p => { p.bundled.push({ targetScope: 'project', name: 'tool', files: [{ path: 'SKILL.md', content: 'y' }] }) }, 'bundled[1]:duplicate:project/tool'],
    ['duplicate file path', p => { p.bundled[0].files.push({ path: 'SKILL.md', content: 'y' }) }, 'bundled[0]:duplicate-path:SKILL.md'],
    ['non-string content', p => { p.bundled[0].files[0].content = 42 }, 'bundled[0].files[0]:content-not-string'],
    ['bad description', p => { p.bundled[0].description = 7 }, 'bundled[0]:invalid-description'],
    ['bad builtin name', p => { p.builtin = ['Bad'] }, 'builtin[0]:invalid-name'],
    ['bad mcp ref', p => { p.selection.mcpServers = [{ identity: 'x' }] }, 'mcpServers[0]'],
    ['bad skill ref', p => { p.selection.skills = [{ kind: 'git' }] }, 'skills[0]'],
    ['bad unresolved kind', p => { p.selection.unresolvedRefs = [{ kind: 'other', ref: 'x' }] }, 'unresolvedRefs[0]:unknown-kind'],
    ['bad unresolved field', p => { p.selection.unresolvedRefs = [{ kind: 'skill', ref: 'x', extra: 1 }] }, 'unresolvedRefs[0]:unknown-field:extra'],
    ['bad warnings', p => { p.warnings = [1] }, 'document:invalid-warnings'],
  ]) {
    const pkg = minimalPackage()
    mutate(pkg)
    const verdict = validatePresetPackage(pkg)
    expect(verdict.ok, label).toBe(false)
    expect(verdict.reason, label).toContain(reason)
  }
})

test('entry paths: relative segment-only paths pass; escapes reject with a named reason', () => {
  for (const path of ['SKILL.md', 'refs/data.txt', 'a/b/c.py', 'file-name_2.test.js']) {
    expect(validateEntryPath(path).ok, path).toBe(true)
  }
  for (const [path, reason] of [
    ['../x', 'climbing-segment'], ['a/../b', 'climbing-segment'], ['..', 'climbing-segment'],
    ['.', 'climbing-segment'], ['a/./b', 'climbing-segment'],
    ['/abs', 'absolute-path'],
    ['C:/x', 'forbidden-character'], ['c:', 'forbidden-character'], ['a\\b', 'forbidden-character'],
    ['a//b', 'invalid-segment'], ['trail/', 'invalid-segment'],
    ['.hidden', 'invalid-segment'], ['a/.hidden', 'invalid-segment'], ['a..b', 'invalid-segment'],
    ['', 'not-a-string'], [42, 'not-a-string'], [null, 'not-a-string'],
  ]) {
    const verdict = validateEntryPath(path)
    expect(verdict.ok, String(path)).toBe(false)
    expect(verdict.reason, String(path)).toBe(reason)
  }
})

test('bounds: exactly-at-limit passes, one-over rejects', () => {
  // per-file 512 KiB
  const atFile = minimalPackage()
  atFile.bundled[0].files[0].content = 'x'.repeat(PACKAGE_LIMITS.fileBytes)
  expect(validatePresetPackage(atFile).ok).toBe(true)
  const overFile = minimalPackage()
  overFile.bundled[0].files[0].content = 'x'.repeat(PACKAGE_LIMITS.fileBytes + 1)
  const overFileVerdict = validatePresetPackage(overFile)
  expect(overFileVerdict.ok).toBe(false)
  expect(overFileVerdict.reason).toContain('file-too-large')
  // 256 files per skill pass; 257 reject
  const atCount = minimalPackage()
  atCount.bundled[0].files = Array.from({ length: PACKAGE_LIMITS.filesPerSkill }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }))
  expect(validatePresetPackage(atCount).ok).toBe(true)
  const overCount = minimalPackage()
  overCount.bundled[0].files = Array.from({ length: PACKAGE_LIMITS.filesPerSkill + 1 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }))
  const overCountVerdict = validatePresetPackage(overCount)
  expect(overCountVerdict.ok).toBe(false)
  expect(overCountVerdict.reason).toContain('too-many-files')
  // package exactly 8 MiB passes; one byte over rejects
  const docPkg = minimalPackage()
  docPkg.bundled[0].files = Array.from({ length: 16 }, (_, i) => ({
    path: `p${String(i).padStart(2, '0')}.txt`,
    content: 'x'.repeat(PACKAGE_LIMITS.fileBytes),
  }))
  const excess = Buffer.byteLength(JSON.stringify(docPkg)) - PACKAGE_LIMITS.documentBytes
  expect(excess > 0 && excess < PACKAGE_LIMITS.fileBytes).toBe(true)
  docPkg.bundled[0].files[15].content = 'x'.repeat(PACKAGE_LIMITS.fileBytes - excess)
  expect(Buffer.byteLength(JSON.stringify(docPkg))).toBe(PACKAGE_LIMITS.documentBytes)
  expect(validatePresetPackage(docPkg).ok).toBe(true)
  docPkg.bundled[0].files[15].content += 'x'
  const overDocVerdict = validatePresetPackage(docPkg)
  expect(overDocVerdict.ok).toBe(false)
  expect(overDocVerdict.reason).toBe('document-too-large')
})

// ---- 6.2 import binding: remote refs stay unresolved ------------------------

test('remote refs stay unresolved and only locally configured MCP identities bind', () => {
  const pkg = {
    selection: {
      skills: [{ kind: 'git', repository: 'o/r', ref: 'main', name: 'remote-tool' }],
      mcpServers: [{ identity: 'docs', label: 'Docs' }, { identity: 'ghost', label: 'Ghost' }],
      unresolvedRefs: [{ kind: 'mcp', ref: 'carried', reason: 'kept' }],
    },
  }
  const bound = bindPackageSelection(pkg, { localMcpIdentities: ['docs'] })
  expect(bound.mcpServers).toEqual(['docs'])
  expect(bound.unresolvedRefs).toEqual([
    { kind: 'mcp', ref: 'carried', reason: 'kept' },
    { kind: 'skill', ref: { kind: 'git', repository: 'o/r', ref: 'main', name: 'remote-tool' } },
    { kind: 'mcp', ref: { identity: 'ghost', label: 'Ghost' } },
  ])
})

// ---- 6.2/6.3 dry-run plan ---------------------------------------------------

test('planPackageInstall (dry-run) reports exact targets and collisions with zero writes', async () => {
  const root = tmp()
  const projectRoot = join(root, '.dsh', 'skills')
  const userRoot = join(root, 'skills')
  mkdirSync(join(projectRoot, 'existing-tool'), { recursive: true })
  const pkg = { bundled: [
    { targetScope: 'project', name: 'existing-tool', files: [{ path: 'SKILL.md', content: 'x' }] },
    { targetScope: 'project', name: 'fresh-tool', files: [{ path: 'SKILL.md', content: 'x' }, { path: 'a/b.txt', content: 'y' }] },
    { targetScope: 'user', name: 'user-tool', files: [{ path: 'SKILL.md', content: 'x' }] },
  ] }
  const before = readdirSync(projectRoot)
  const plan = await planPackageInstall(pkg, { roots: { project: projectRoot, user: userRoot } })
  expect(plan.install).toEqual([
    { targetScope: 'project', name: 'existing-tool', fileCount: 1, targetRoot: projectRoot, collision: true },
    { targetScope: 'project', name: 'fresh-tool', fileCount: 2, targetRoot: projectRoot },
    { targetScope: 'user', name: 'user-tool', fileCount: 1, targetRoot: userRoot },
  ])
  expect(plan.collisions).toEqual([{ targetScope: 'project', name: 'existing-tool' }])
  // the plan is read-only
  expect(readdirSync(projectRoot)).toEqual(before)
  expect(existsSync(userRoot)).toBe(false)
  // an unresolvable root is reported as null, never written
  const noRoots = await planPackageInstall(pkg, { roots: { project: null, user: null } })
  expect(noRoots.install[0].targetRoot).toBeNull()
  expect(noRoots.install[0].collision).toBeUndefined()
  expect(noRoots.collisions).toEqual([])
})

// ---- 6.3 install discipline -------------------------------------------------

const skillEntry = (targetScope, name, files) => ({
  targetScope,
  name,
  files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name}\n---\n${name}\n` }, ...(files ?? []).map(file => ({ path: file[0], content: file[1] }))],
})

test('install writes bundled Skills temp-name → rename and audits the outcome', async () => {
  const root = tmp()
  const projectRoot = join(root, 'project')
  const userRoot = join(root, 'user')
  const audits = []
  const result = await installBundledSkills([
    skillEntry('project', 'ws-tool', [['refs/data.txt', 'DATA']]),
    skillEntry('user', 'user-tool'),
  ], { roots: { project: projectRoot, user: userRoot } }, { audit: data => audits.push(data) })
  expect(result.ok).toBe(true)
  expect(result.installed).toHaveLength(2)
  expect(result.collisions).toEqual([])
  expect(readFileSync(join(projectRoot, 'ws-tool', 'SKILL.md'), 'utf8')).toContain('name: ws-tool')
  expect(readFileSync(join(projectRoot, 'ws-tool', 'refs', 'data.txt'), 'utf8')).toBe('DATA')
  expect(readFileSync(join(userRoot, 'user-tool', 'SKILL.md'), 'utf8')).toContain('name: user-tool')
  // no temp artifact survives a successful install
  for (const dir of [join(projectRoot, 'ws-tool'), join(projectRoot, 'ws-tool', 'refs'), join(userRoot, 'user-tool')]) {
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  }
  expect(audits).toHaveLength(1)
  expect(audits[0].outcome).toBe('installed')
  expect(audits[0].installed).toHaveLength(2)
})

test('a collision without a decision cancels: zero writes for that Skill, reported and audited', async () => {
  const root = tmp()
  const projectRoot = join(root, 'project')
  mkdirSync(join(projectRoot, 'ws-tool'), { recursive: true })
  writeFileSync(join(projectRoot, 'ws-tool', 'SKILL.md'), 'ORIGINAL')
  const audits = []
  const result = await installBundledSkills([
    skillEntry('project', 'ws-tool'),
    skillEntry('project', 'fresh-tool'),
  ], { roots: { project: projectRoot } }, { audit: data => audits.push(data) })
  expect(result.ok).toBe(true)
  expect(result.collisions).toEqual([{ targetScope: 'project', name: 'ws-tool', decision: 'cancelled' }])
  expect(result.installed.map(entry => entry.name)).toEqual(['fresh-tool'])
  expect(readFileSync(join(projectRoot, 'ws-tool', 'SKILL.md'), 'utf8')).toBe('ORIGINAL')
  expect(readFileSync(join(projectRoot, 'fresh-tool', 'SKILL.md'), 'utf8')).toContain('name: fresh-tool')
  expect(audits[0].collisions).toEqual([{ targetScope: 'project', name: 'ws-tool', decision: 'cancelled' }])
})

test('replace overwrites only because it was explicitly confirmed', async () => {
  const root = tmp()
  const projectRoot = join(root, 'project')
  mkdirSync(join(projectRoot, 'ws-tool'), { recursive: true })
  writeFileSync(join(projectRoot, 'ws-tool', 'SKILL.md'), 'ORIGINAL')
  writeFileSync(join(projectRoot, 'ws-tool', 'stale.txt'), 'STALE')
  const result = await installBundledSkills([skillEntry('project', 'ws-tool')], { roots: { project: projectRoot }, onCollision: 'replace' })
  expect(result.ok).toBe(true)
  expect(result.installed[0].status).toBe('replace-confirmed')
  expect(result.installed[0].collision).toBe(true)
  expect(readFileSync(join(projectRoot, 'ws-tool', 'SKILL.md'), 'utf8')).toContain('name: ws-tool')
  expect(existsSync(join(projectRoot, 'ws-tool', 'stale.txt'))).toBe(false)
})

test('coexist installs under a derived distinct name and rewrites the frontmatter name', async () => {
  const root = tmp()
  const projectRoot = join(root, 'project')
  mkdirSync(join(projectRoot, 'ws-tool'), { recursive: true })
  writeFileSync(join(projectRoot, 'ws-tool', 'SKILL.md'), 'ORIGINAL')
  const result = await installBundledSkills([skillEntry('project', 'ws-tool')], { roots: { project: projectRoot }, onCollision: 'coexist' })
  expect(result.ok).toBe(true)
  expect(result.installed[0].target).toBe('ws-tool-2')
  expect(result.installed[0].status).toBe('coexist-distinct')
  expect(readFileSync(join(projectRoot, 'ws-tool-2', 'SKILL.md'), 'utf8')).toContain('name: ws-tool-2')
  expect(readFileSync(join(projectRoot, 'ws-tool', 'SKILL.md'), 'utf8')).toBe('ORIGINAL')
})

test('a failed write rolls back everything this install already wrote (fault injection)', async () => {
  const root = tmp()
  const projectRoot = join(root, 'project')
  const audits = []
  const { writeFile: realWriteFile } = await import('node:fs/promises')
  const fs = {
    writeFile: async (path, content, options) => {
      if (String(path).includes('b.txt')) throw new Error('injected write failure')
      return realWriteFile(path, content, options)
    },
  }
  const result = await installBundledSkills([
    skillEntry('project', 'first-tool'),
    skillEntry('project', 'second-tool', [['b.txt', 'B']]),
  ], { roots: { project: projectRoot } }, { fs, audit: data => audits.push(data) })
  expect(result.ok).toBe(false)
  expect(result.failedSkill).toBe('second-tool')
  expect(result.reason).toContain('injected write failure')
  expect(result.rolledBack).toBeGreaterThan(0)
  // the first Skill's completed install and the failed Skill's partial tree
  // are BOTH gone — the import leaves no half-installed content behind
  expect(existsSync(join(projectRoot, 'first-tool'))).toBe(false)
  expect(existsSync(join(projectRoot, 'second-tool'))).toBe(false)
  expect(existsSync(projectRoot)).toBe(false)
  expect(audits[0].outcome).toBe('install-failed')
  expect(audits[0].reason).toContain('injected write failure')
})

test('a missing target root fails before any write', async () => {
  const result = await installBundledSkills([skillEntry('project', 'ws-tool')], { roots: { user: join(tmp(), 'user') } })
  expect(result.ok).toBe(false)
  expect(result.reason).toBe('no-target-root:project')
  expect(result.rolledBack).toBe(0)
})

test('renameSkillContent rewrites only the frontmatter name scalar', () => {
  expect(renameSkillContent('---\nname: old\ndescription: keep\n---\nBODY name: old\n', 'new'))
    .toBe('---\nname: new\ndescription: keep\n---\nBODY name: old\n')
  expect(renameSkillContent('no frontmatter', 'new')).toBe('no frontmatter')
  expect(renameSkillContent('---\ndescription: x\n---\n', 'new')).toBe('---\ndescription: x\n---\n')
  expect(renameSkillContent('---\r\nname: old\r\n---\r\nB\r\n', 'new')).toBe('---\r\nname: new\r\n---\r\nB\r\n')
})

// ---- handler level: the two-phase import through /capabilities --------------

/** The capabilities-command.test.js ctx-stub pattern, parameterized by root. */
const mountCapabilities = (root, config = {}) => {
  const registeredCommands = []
  let provider
  const ctx = {
    skills: {
      registerProvider(create) { provider = create({ invalidate() {} }) },
      async list(options) { return (await provider.list(options)).candidates },
      layers: { global: { providers: new Map() } },
    },
    on() {},
    effect(fn) { fn(); return () => {} },
    logger: { warn() {} },
    get(name) {
      if (name === 'profileContext') return { home: root, name: 'it' }
      if (name === 'commands') return { register(command) { registeredCommands.push(command); return () => {} } }
      return undefined
    },
  }
  createSkillSelectionPlugin()(ctx, {
    machineId: 'weir-it-machine',
    customSkillDirs: [],
    agentsHome: join(root, 'agents-home'),
    ...config,
  })
  const command = registeredCommands.find(entry => entry.name === 'capabilities')
  const agent = { id: 'sess-pkg', session: { id: 'sess-pkg', header: { cwd: root } } }
  return { command, agent }
}

const packageFixture = () => ({
  version: 2,
  name: 'Bundle',
  selection: {
    skills: [{ kind: 'git', repository: 'owner/repo', ref: 'main', name: 'remote-tool' }],
    mcpServers: [{ identity: 'docs', label: 'Docs' }],
    unresolvedRefs: [],
  },
  builtin: ['debugging'],
  bundled: [
    { targetScope: 'project', name: 'ws-tool', files: [{ path: 'SKILL.md', content: '---\nname: ws-tool\ndescription: ws\n---\nWS\n' }] },
    { targetScope: 'user', name: 'user-tool', files: [{ path: 'SKILL.md', content: '---\nname: user-tool\ndescription: u\n---\nU\n' }] },
  ],
  warnings: [],
})

test('preset-import v2: a poison package is rejected atomically with zero writes', async () => {
  const root = tmp()
  const { command, agent } = mountCapabilities(root)
  const poison = packageFixture()
  poison.bundled[0].files.push({ path: '../escape.txt', content: 'x' })
  const result = await command.handler({ agent, rawInput: `preset-import ${JSON.stringify({ document: poison, scope: 'global', dryRun: true })}` })
  expect(result.kind).toBe('error')
  const payload = JSON.parse(result.text)
  expect(payload.status).toBe('rejected')
  expect(payload.reason).toContain('invalid-path')
  expect(existsSync(join(root, '.dsh', 'skills'))).toBe(false)
  expect(existsSync(join(root, 'skills'))).toBe(false)
  expect(JSON.parse((await command.handler({ agent, rawInput: 'presets' })).text).presets).toEqual([])
})

test('preset-import v2: dry-run zero writes; confirmed installs; enabled set untouched', async () => {
  const root = tmp()
  const { command, agent } = mountCapabilities(root)
  const before = JSON.parse((await command.handler({ agent, rawInput: 'receipt' })).text)
  await command.handler({ agent, rawInput: `mcp-add ${JSON.stringify({ identity: 'docs', label: 'Docs', command: 'npx' })}` })

  // phase one: the dry-run summary — exact targets, counts, unresolved refs
  const dry = await command.handler({ agent, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global', dryRun: true })}` })
  expect(dry.kind).toBe('success')
  const summary = JSON.parse(dry.text)
  expect(summary.status).toBe('dry-run')
  expect(summary.install).toHaveLength(2)
  const wsPlan = summary.install.find(entry => entry.name === 'ws-tool')
  expect(wsPlan.targetScope).toBe('project')
  expect(wsPlan.targetRoot).toBe(join(root, '.dsh', 'skills'))
  expect(wsPlan.fileCount).toBe(1)
  expect(wsPlan.collision).toBeUndefined()
  const userPlan = summary.install.find(entry => entry.name === 'user-tool')
  expect(userPlan.targetScope).toBe('user')
  expect(userPlan.targetRoot).toBe(join(root, 'skills'))
  expect(summary.collisions).toEqual([])
  // only the portable ref is unresolved ('docs' is configured locally)
  expect(summary.unresolved).toEqual([{ kind: 'skill', ref: { kind: 'git', repository: 'owner/repo', ref: 'main', name: 'remote-tool' } }])
  // dry-run wrote NOTHING: no files, no preset
  expect(existsSync(join(root, '.dsh', 'skills'))).toBe(false)
  expect(existsSync(join(root, 'skills'))).toBe(false)
  expect(JSON.parse((await command.handler({ agent, rawInput: 'presets' })).text).presets).toEqual([])

  // phase two: the confirmed import installs and CAS-creates the preset
  const confirmed = await command.handler({ agent, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global' })}` })
  expect(confirmed.kind).toBe('success')
  const payload = JSON.parse(confirmed.text)
  expect(payload.status).toBe('created')
  expect(payload.installed).toHaveLength(2)
  expect(payload.collisions).toEqual([])
  expect(payload.bound).toEqual({ mcpServers: 1, unresolvedRefs: 1 })
  expect(readFileSync(join(root, '.dsh', 'skills', 'ws-tool', 'SKILL.md'), 'utf8')).toContain('name: ws-tool')
  expect(readFileSync(join(root, 'skills', 'user-tool', 'SKILL.md'), 'utf8')).toContain('name: user-tool')

  // the preset record: installed + builtin resolved to local identities,
  // the remote ref stays unresolved
  const loaded = JSON.parse((await command.handler({ agent, rawInput: `preset-load ${JSON.stringify({ scope: 'global', presetId: 'bundle' })}` })).text)
  expect(loaded.status).toBe('ok')
  expect(loaded.document.selection.skills.map(identity => identity.name).sort()).toEqual(['debugging', 'user-tool', 'ws-tool'])
  expect(loaded.document.selection.mcpServers).toEqual(['docs'])
  expect(loaded.document.selection.unresolvedRefs).toEqual([{ kind: 'skill', ref: { kind: 'git', repository: 'owner/repo', ref: 'main', name: 'remote-tool' } }])

  // installed Skills are NOT auto-enabled: the receipt is byte-identical
  const after = JSON.parse((await command.handler({ agent, rawInput: 'receipt' })).text)
  expect(after).toEqual(before)

  // the install outcome was audited through the shared channel
  const auditLog = readFileSync(join(root, '.weir', 'audit.jsonl'), 'utf8')
  expect(auditLog).toContain('weir/capability-preset-import')
  expect(auditLog).toContain('"outcome":"installed"')
})

test('preset-import v2: a name collision without a decision cancels that Skill (zero writes for it)', async () => {
  const root = tmp()
  const { command, agent } = mountCapabilities(root)
  await command.handler({ agent, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global' })}` })
  writeFileSync(join(root, '.dsh', 'skills', 'ws-tool', 'SKILL.md'), 'MARKED')
  const result = await command.handler({ agent, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global', presetId: 'bundle-2', name: 'Bundle Two' })}` })
  expect(result.kind).toBe('success')
  const payload = JSON.parse(result.text)
  expect(payload.status).toBe('created')
  expect(payload.installed).toEqual([])
  expect(payload.collisions).toEqual([
    { targetScope: 'project', name: 'ws-tool', decision: 'cancelled' },
    { targetScope: 'user', name: 'user-tool', decision: 'cancelled' },
  ])
  // the occupied names were NOT overwritten
  expect(readFileSync(join(root, '.dsh', 'skills', 'ws-tool', 'SKILL.md'), 'utf8')).toBe('MARKED')
  // the cancelled skills are reported unresolved in the record
  expect(payload.unresolved.filter(entry => entry.ref?.source === 'bundled')).toHaveLength(2)
})

test('preset-import v2: a bad dryRun or onCollision value is an explicit rejection', async () => {
  const root = tmp()
  const { command, agent } = mountCapabilities(root)
  const badDryRun = await command.handler({ agent, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global', dryRun: 'yes' })}` })
  expect(badDryRun.kind).toBe('error')
  const badDecision = await command.handler({ agent, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global', onCollision: 'overwrite' })}` })
  expect(badDecision.kind).toBe('error')
  expect(badDecision.text).toContain('onCollision')
  expect(existsSync(join(root, '.dsh', 'skills'))).toBe(false)
})

test('preset-import v2: a package needing an unresolvable root fails before any write', async () => {
  const root = tmp()
  const { command } = mountCapabilities(root)
  // an agent without a cwd has no workspace → no project Skill root
  const noCwd = { id: 'sess-noroot', session: { id: 'sess-noroot', header: {} } }
  const result = await command.handler({ agent: noCwd, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global' })}` })
  expect(result.kind).toBe('error')
  const payload = JSON.parse(result.text)
  expect(payload.status).toBe('no-target-root')
  expect(payload.targetScope).toBe('project')
  expect(existsSync(join(root, 'skills'))).toBe(false)
  // the dry-run of the same package still summarizes, with a null root
  const dry = await command.handler({ agent: noCwd, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global', dryRun: true })}` })
  const summary = JSON.parse(dry.text)
  expect(summary.status).toBe('dry-run')
  expect(summary.install.find(entry => entry.name === 'ws-tool').targetRoot).toBeNull()
})

test('preset-import v2: a preset name conflict leaves the confirmed install in place and reports both', async () => {
  const root = tmp()
  const { command, agent } = mountCapabilities(root)
  await command.handler({ agent, rawInput: `preset-save ${JSON.stringify({ scope: 'global', name: 'Bundle', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [] })}` })
  const result = await command.handler({ agent, rawInput: `preset-import ${JSON.stringify({ document: packageFixture(), scope: 'global', presetId: 'other-id' })}` })
  expect(result.kind).toBe('success')
  const payload = JSON.parse(result.text)
  // the preset RECORD conflict is its own outcome — the explicitly confirmed
  // install was already the import's main effect and stays in place
  expect(payload.status).toBe('name-conflict')
  expect(payload.installed).toHaveLength(2)
  expect(readFileSync(join(root, '.dsh', 'skills', 'ws-tool', 'SKILL.md'), 'utf8')).toContain('name: ws-tool')
  expect(JSON.parse((await command.handler({ agent, rawInput: 'presets' })).text).presets).toHaveLength(1)
})
