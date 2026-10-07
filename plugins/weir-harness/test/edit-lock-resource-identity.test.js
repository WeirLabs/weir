import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, lstatSync, rmSync, writeFileSync, mkdirSync, symlinkSync, linkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createResourceIdentity } from '../src/edit-lock/resource-identity.js'

function fixture(t) {
  const parent = realpathSync.native(tmpdir())
  const root = mkdtempSync(join(parent, 'weir-resource-identity-'))
  const identity = lstatSync(root, { bigint: true })
  t.after(() => {
    const resolved = realpathSync.native(root)
    const current = lstatSync(resolved, { bigint: true })
    assert(isAbsolute(resolved))
    assert.equal(resolved, root)
    assert.equal(dirname(resolved), parent)
    assert.match(basename(resolved), /^weir-resource-identity-[A-Za-z0-9]{6}$/)
    assert.equal(current.dev, identity.dev)
    assert.equal(current.ino, identity.ino)
    assert(current.isDirectory())
    rmSync(resolved, { recursive: true, force: false })
  })
  return root
}

test('resolves a regular file to its native canonical resource ID without ownership', t => {
  const cwd = fixture(t)
  writeFileSync(join(cwd, 'file.txt'), 'original', { flag: 'wx' })
  const identity = createResourceIdentity()
  const observation = identity.resolve('./file.txt', { cwd })
  assert.deepEqual(observation, { kind: 'file', resourceId: `${cwd}/file.txt` })
  assert.deepEqual(identity.resolve(`${cwd}/file.txt`, { cwd }), observation)
})


test('observations are immutable, private and local to their factory', t => {
  const cwd = fixture(t)
  writeFileSync(join(cwd, 'file.txt'), 'original')
  const identity = createResourceIdentity()
  const observation = identity.resolve('file.txt', { cwd })
  assert(Object.isFrozen(observation))
  assert.throws(() => { observation.resourceId = 'forged' }, TypeError)
  assert.deepEqual(identity.revalidate(observation), observation)
  assert.throws(() => identity.revalidate({ ...observation }), /unknown observation/)
  assert.throws(() => createResourceIdentity().revalidate(observation), /unknown observation/)
  assert.throws(() => identity.revalidate(null), /unknown observation/)
})


test('missing observations retain a canonical ancestor and literal suffix, never a resource key', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  const observation = identity.resolve('New//./cafe\u0301.txt', { cwd })
  assert.deepEqual(observation, { kind: 'missing', ancestor: cwd, suffix: 'New//./cafe\u0301.txt' })
  assert(Object.isFrozen(observation))
  assert.deepEqual(identity.revalidate(observation), observation)
  assert.throws(() => lstatSync(join(cwd, 'New')), { code: 'ENOENT' })
  assert.throws(() => identity.resolve('missing/../file', { cwd }), /missing.*\.\./)
})


test('rejects non-editable nodes instead of classifying them as files or missing', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  mkdirSync(join(cwd, 'dir'))
  writeFileSync(join(cwd, 'file'), 'bytes')
  symlinkSync('absent', join(cwd, 'dangling'))
  symlinkSync('loop', join(cwd, 'loop'))
  linkSync(join(cwd, 'file'), join(cwd, 'hardlink'))
  for (const path of ['dir', '.', 'file', 'hardlink', 'dangling', 'dangling/child', 'loop', 'file/child', 'file/../absent', '/dev/null']) {
    assert.throws(() => identity.resolve(path, { cwd }), undefined, path)
  }
})


test('revalidation ignores content and siblings but rejects file replacement and added hardlinks', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  const file = join(cwd, 'file')
  writeFileSync(file, 'first')
  const observation = identity.resolve('file', { cwd })
  writeFileSync(file, 'changed content')
  writeFileSync(join(cwd, 'sibling'), 'unrelated')
  assert.deepEqual(identity.revalidate(observation), observation)
  // Keep the old inode alive: replacement detection must not depend on inode reuse timing.
  const retired = join(cwd, 'retired')
  assert.equal(realpathSync.native(file), file)
  assert.equal(dirname(retired), cwd)
  renameSync(file, retired)
  writeFileSync(file, 'changed content')
  assert.throws(() => identity.revalidate(observation), /topology changed/)
  const replacement = identity.resolve('file', { cwd })
  linkSync(file, join(cwd, 'hardlink'))
  assert.throws(() => identity.revalidate(replacement), /not editable/)
})


test('preserves physical symlink/.. traversal and rejects a replaced symlink even to the same file', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  mkdirSync(join(cwd, 'physical', 'child'), { recursive: true })
  writeFileSync(join(cwd, 'physical', 'file'), 'physical')
  writeFileSync(join(cwd, 'file'), 'lexical decoy')
  const alias = join(cwd, 'alias')
  symlinkSync('physical/child', alias)
  const observed = identity.resolve('alias/../file', { cwd })
  assert.equal(observed.resourceId, `${cwd}/physical/file`)
  assert.deepEqual(identity.resolve('alias/../absent', { cwd }), { kind: 'missing', ancestor: `${cwd}/physical`, suffix: 'absent' })
  const retired = join(cwd, 'old-alias')
  assert(lstatSync(alias).isSymbolicLink())
  assert.equal(dirname(alias), cwd)
  assert.equal(dirname(retired), cwd)
  renameSync(alias, retired)
  symlinkSync('physical/child', alias)
  assert.throws(() => identity.revalidate(observed), /topology changed/)
})


test('witnesses physical ancestors hidden inside symlink targets, not only the final inode', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  const parent = join(cwd, 'physical')
  const retired = join(cwd, 'retired')
  mkdirSync(join(parent, 'child'), { recursive: true })
  writeFileSync(join(parent, 'child', 'file'), 'bytes')
  symlinkSync('physical/child', join(cwd, 'alias'))
  const observed = identity.resolve('alias/file', { cwd })
  assert.equal(realpathSync.native(parent), parent)
  assert.equal(dirname(retired), cwd)
  renameSync(parent, retired)
  mkdirSync(parent)
  const child = join(retired, 'child')
  const destination = join(parent, 'child')
  assert.equal(realpathSync.native(child), child)
  assert.equal(dirname(destination), parent)
  renameSync(child, destination)
  assert.throws(() => identity.revalidate(observed), /topology changed/)
})


test('case and NFC aliases have no missing key and reject old observations after creation on this volume', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  for (const [stored, alias] of [['CaseWitness', 'casewitness'], ['caf\u00e9', 'cafe\u0301']]) {
    const absent = [stored, alias].map(path => identity.resolve(path, { cwd }))
    assert.deepEqual(absent, [stored, alias].map(suffix => ({ kind: 'missing', ancestor: cwd, suffix })))
    writeFileSync(join(cwd, stored), 'created', { flag: 'wx' })
    // This assertion reports this real test volume, NOT an all-filesystems equivalence rule.
    assert.equal(realpathSync.native(join(cwd, stored)), realpathSync.native(join(cwd, alias)))
    assert.equal(identity.resolve(stored, { cwd }).resourceId, identity.resolve(alias, { cwd }).resourceId)
    for (const old of absent) assert.throws(() => identity.revalidate(old), /topology changed/)
  }
})


test('new ordinary ancestors yield a fresh missing observation but new symlink ancestors are rejected', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  const original = identity.resolve('new/child/file', { cwd })
  mkdirSync(join(cwd, 'new'))
  const fresh = identity.revalidate(original)
  assert.notEqual(fresh, original)
  assert.deepEqual(fresh, { kind: 'missing', ancestor: `${cwd}/new`, suffix: 'child/file' })
  assert.deepEqual(original, { kind: 'missing', ancestor: cwd, suffix: 'new/child/file' })
  assert.deepEqual(identity.revalidate(fresh), fresh)
  mkdirSync(join(cwd, 'elsewhere'))
  symlinkSync('../elsewhere', join(cwd, 'new', 'child'))
  assert.throws(() => identity.revalidate(original), /topology changed/)
  assert.throws(() => identity.revalidate(fresh), /topology changed/)
})


test('revalidation witnesses intermediate symlinks even when retargeted to the same canonical file', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  writeFileSync(join(cwd, 'file'), 'bytes')
  symlinkSync('middle', join(cwd, 'alias'))
  const middle = join(cwd, 'middle')
  const retired = join(cwd, 'retired')
  symlinkSync('file', middle)
  const original = identity.resolve('alias', { cwd })
  assert.equal(original.resourceId, `${cwd}/file`)
  assert(lstatSync(middle).isSymbolicLink())
  assert.equal(dirname(middle), cwd)
  assert.equal(dirname(retired), cwd)
  renameSync(middle, retired)
  symlinkSync('./file', middle)
  assert.throws(() => identity.revalidate(original), /topology changed/)
})


test('requires an explicit absolute cwd and rejects invalid path inputs', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  assert.throws(() => identity.resolve('absent', { cwd: 'relative' }), /absolute cwd/)
  assert.throws(() => identity.resolve('absent', { cwd: '' }), /absolute cwd/)
  assert.throws(() => identity.resolve('', { cwd }), /non-empty path/)
  assert.throws(() => identity.resolve('bad\0name', { cwd }), /NUL/)
  assert.throws(() => identity.resolve('absent', { cwd: `${cwd}\0` }), /NUL/)
})


/** Platform dispatch only; filesystem behavior is always tested with real fixtures. */
test('unsupported platforms reject explicitly before POSIX traversal', async () => {
  const { spawnSync } = await import('node:child_process')
  const moduleUrl = new URL('../src/edit-lock/resource-identity.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const { createResourceIdentity } = await import(${JSON.stringify(moduleUrl)})
    assert.throws(() => createResourceIdentity(), /unsupported platform: win32/)
  `], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})


test('nested relative symlinks below a symlinked cwd resolve without false cycles', t => {
  const cwd = fixture(t)
  const identity = createResourceIdentity()
  mkdirSync(join(cwd, 'physical'))
  writeFileSync(join(cwd, 'physical', 'file'), 'bytes')
  symlinkSync('physical', join(cwd, 'alias'))
  symlinkSync('file', join(cwd, 'physical', 'inner'))
  const observation = identity.resolve('inner', { cwd: `${cwd}/alias` })
  assert.equal(observation.resourceId, `${cwd}/physical/file`)
  assert.deepEqual(identity.revalidate(observation), observation)
  const missing = identity.resolve('absent', { cwd: `${cwd}/alias` })
  const source = join(cwd, 'physical')
  const destination = join(cwd, 'retired')
  assert.equal(realpathSync.native(source), source)
  assert.equal(dirname(destination), cwd)
  renameSync(source, destination)
  mkdirSync(source)
  assert.throws(() => identity.revalidate(missing), /topology changed/)
})


test('repeated valid symlink components have bounded filesystem work for resolve and revalidate', async t => {
  const cwd = fixture(t)
  writeFileSync(join(cwd, 'file'), 'bytes')
  symlinkSync('.', join(cwd, 'self'))
  // Isolate builtin instrumentation; every counted call still uses the real FS.
  const { spawnSync } = await import('node:child_process')
  const moduleUrl = new URL('../src/edit-lock/resource-identity.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const counts = { lstatSync: 0, readlinkSync: 0 }
    for (const key of Object.keys(counts)) {
      const actual = fs[key]
      fs[key] = (...args) => { counts[key]++; return actual(...args) }
    }
    syncBuiltinESMExports()
    const { createResourceIdentity } = await import(${JSON.stringify(moduleUrl)})
    const cwd = ${JSON.stringify(cwd)}
    const identity = createResourceIdentity()
    const measurements = []
    function measure(run) {
      for (const key of Object.keys(counts)) counts[key] = 0
      const observation = run()
      assert.deepEqual(observation, { kind: 'file', resourceId: cwd + '/file' })
      return { observation, counts: { ...counts } }
    }
    for (const n of [4, 8, 12, 16]) {
      const resolved = measure(() => identity.resolve('self/'.repeat(n) + 'file', { cwd }))
      const revalidated = measure(() => identity.revalidate(resolved.observation))
      measurements.push({ n, resolve: resolved.counts, revalidate: revalidated.counts })
    }
    console.log(JSON.stringify(measurements))
    for (let i = 1; i < measurements.length; i++) {
      for (const operation of ['resolve', 'revalidate']) {
        for (const key of Object.keys(counts)) {
          // +4 components may at most triple work: generous for linear growth,
          // but rejects exponential parent replay without a wall-clock limit.
          assert(measurements[i][operation][key] <= measurements[i - 1][operation][key] * 3,
            operation + ' ' + key + ' grows too fast at ' + measurements[i].n + ' components')
        }
      }
    }
  `], { encoding: 'utf8' })
  t.diagnostic(result.stdout.trim())
  assert.equal(result.status, 0, result.stderr)
})
