import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { createNodeFs, instrumentFs } from '../src/capabilities/store/fs-adapter.js'
import { encodeRecord } from '../src/capabilities/store/record.js'
import { unitLayout } from '../src/capabilities/store/paths.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillScanPathRegistry } from '../src/capabilities/skill-scan-path-registry.js'
import { createStubLiveness } from './helpers/stub-liveness.js'

const platform = process.platform === 'win32' ? 'win32' : 'darwin'

async function fixture(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-skill-paths-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    await rm(root, { recursive: true, force: true })
  })
  const store = openCapabilityStore({ root, platform, liveness: createStubLiveness() })
  return { root, store, registry: createSkillScanPathRegistry({ store, home: root, platform }) }
}

const recordPath = root => join(root, 'skills', 'scan-paths.json')
const pathsOf = async registry => (await registry.read()).paths

test('skill scan paths have an independent Profile unit and absent means revision zero', async t => {
  const { root, store, registry } = await fixture(t)
  assert.deepEqual(unitLayout({ kind: 'skill-scan-paths' }), { key: 'skills/scan-paths', segments: ['skills'], name: 'scan-paths' })
  assert.deepEqual(await registry.read(), { status: 'ok', revision: 0, paths: [] })
  await mkdir(join(root, 'library'), { recursive: true })
  assert.equal((await registry.add('library', 0)).status, 'validation-failed')
  assert.equal(await realpath(recordPath(root)).then(() => true, () => false), false)

  const saved = await registry.add(`  ${join(root, 'library')}  `, 0)
  assert.deepEqual(saved, { status: 'saved', saved: true, revision: 1, paths: [await realpath(join(root, 'library'))], error: null })
  assert.equal(JSON.parse(await readFile(recordPath(root), 'utf8')).revision, 1)
  assert.deepEqual(await createSkillScanPathRegistry({ store, home: root, platform }).read(), {
    status: 'ok', revision: 1, paths: [await realpath(join(root, 'library'))],
  })
})

test('home expansion, symlinks and lexical aliases share one canonical registry entry', async t => {
  const { root, registry } = await fixture(t)
  await mkdir(join(root, 'library'))
  await symlink(join(root, 'library'), join(root, 'alias'))
  const canonical = await realpath(join(root, 'library'))

  assert.equal((await registry.add('~/library', 0)).status, 'saved')
  const before = await readFile(recordPath(root), 'utf8')
  for (const alias of [join(root, 'alias'), join(root, 'library', '.'), `  ~/library  `]) {
    const duplicate = await registry.add(alias, 1)
    assert.equal(duplicate.status, 'duplicate')
    assert.equal(duplicate.saved, false)
    assert.equal(duplicate.revision, 1)
    assert.deepEqual(duplicate.paths, [canonical])
    assert.equal(await readFile(recordPath(root), 'utf8'), before)
  }
  assert.deepEqual(await pathsOf(registry), [canonical])
})

test('invalid, relative, missing, non-directory and unreadable adds never write', async t => {
  const { root, store, registry } = await fixture(t)
  await writeFile(join(root, 'file'), 'not a directory')
  for (const [input, code] of [
    ['', 'path-empty'], ['   ', 'path-empty'], ['relative', 'path-not-absolute'],
    ['~someone/library', 'path-not-absolute'], ['$HOME/library', 'path-not-absolute'],
    [join(root, 'missing'), 'path-missing'], [join(root, 'file'), 'path-not-directory'],
  ]) {
    const result = await registry.add(input, 0)
    assert.equal(result.status, 'validation-failed')
    assert.equal(result.saved, false)
    assert.equal(result.error.code, code)
    assert.deepEqual(await registry.read(), { status: 'ok', revision: 0, paths: [] })
  }
  await mkdir(join(root, 'denied'))
  const unreadable = createSkillScanPathRegistry({
    store, home: root, platform,
    fs: { realpath, stat, access: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } },
  })
  const denied = await unreadable.add(join(root, 'denied'), 0)
  assert.equal(denied.status, 'validation-failed')
  assert.equal(denied.error.code, 'path-unreadable')
  assert.deepEqual(await registry.read(), { status: 'ok', revision: 0, paths: [] })
})

test('add/remove CAS reports stale current state, missing removals and canonical alias removal', async t => {
  const { root, registry } = await fixture(t)
  for (const name of ['a', 'b', 'c']) await mkdir(join(root, name))
  await symlink(join(root, 'a'), join(root, 'a-alias'))
  assert.equal((await registry.add(join(root, 'a'), 0)).status, 'saved')
  assert.equal((await registry.add(join(root, 'b'), 1)).status, 'saved')

  const stale = await registry.add(join(root, 'c'), 0)
  assert.equal(stale.status, 'revision-conflict')
  assert.equal(stale.saved, false)
  assert.equal(stale.revision, 2)
  assert.deepEqual(stale.paths, [await realpath(join(root, 'a')), await realpath(join(root, 'b'))])
  assert.deepEqual(await pathsOf(registry), stale.paths)

  const removed = await registry.remove(join(root, 'a-alias'), 2)
  assert.deepEqual(removed, { status: 'removed', saved: true, revision: 3, paths: [await realpath(join(root, 'b'))], error: null })
  const missing = await registry.remove(join(root, 'a'), 3)
  assert.equal(missing.status, 'not-found')
  assert.equal(missing.saved, false)
  assert.deepEqual(missing.paths, removed.paths)
  assert.equal((await registry.read()).revision, 3)
})

test('a vanished registered directory can still be removed by its canonical path', async t => {
  const { root, registry } = await fixture(t)
  const directory = join(root, 'vanished')
  await mkdir(directory)
  const canonical = await realpath(directory)
  await registry.add(directory, 0)
  await rm(directory, { recursive: true })
  const result = await registry.remove(canonical, 1)
  assert.equal(result.status, 'removed')
  assert.equal(result.saved, true)
  assert.deepEqual(result.paths, [])
})

test('corrupt, unknown, torn and invalid payload records fail without silent repair', async t => {
  const { root, registry } = await fixture(t)
  await mkdir(join(root, 'skills'), { recursive: true })
  await mkdir(join(root, 'library'))
  const variants = [
    ['not json', 'corrupt'],
    [JSON.stringify({ schemaVersion: 99, revision: 1 }), 'unknown-schema'],
    [JSON.stringify({ ...encodeRecord(1, { paths: [] }, []), payload: { paths: ['changed'] } }), 'torn'],
    [JSON.stringify(encodeRecord(1, { paths: ['relative'] }, [])), 'invalid-payload'],
    [JSON.stringify(encodeRecord(1, { paths: [], unknown: true }, [])), 'invalid-payload'],
  ]
  for (const [text, code] of variants) {
    await writeFile(recordPath(root), text)
    const read = await registry.read()
    assert.equal(read.status, 'unavailable')
    assert.equal(read.error.code, code)
    const mutation = await registry.add(join(root, 'library'), read.revision ?? 0)
    assert.equal(mutation.saved, false)
    assert.ok(['unreadable', 'unavailable'].includes(mutation.status))
    assert.equal(await readFile(recordPath(root), 'utf8'), text)
  }
})

test('read and write I/O failures are explicit storage outcomes', async t => {
  const { root, registry: freshRegistry } = await fixture(t)
  await mkdir(join(root, 'library'))
  await mkdir(join(root, 'other'))
  const canonical = await realpath(join(root, 'library'))
  assert.equal((await freshRegistry.add(canonical, 0)).status, 'saved')
  const readFailure = createSkillScanPathRegistry({
    store: { read: async () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }) } },
    home: root, platform,
  })
  assert.equal((await readFailure.read()).error.code, 'read-failed')

  const fs = instrumentFs(createNodeFs(), (op, args, phase) => {
    if (phase === 'before' && op === 'rename' && args[1] === recordPath(root)) throw Object.assign(new Error('rename denied'), { code: 'EIO' })
  })
  const store = openCapabilityStore({ root, platform, fs, liveness: createStubLiveness() })
  const registry = createSkillScanPathRegistry({ store, home: root, platform })
  const result = await registry.add(join(root, 'other'), 1)
  assert.equal(result.status, 'indeterminate')
  assert.equal(result.saved, false)
  assert.equal(result.error.code, 'write-failed')
  assert.deepEqual(await freshRegistry.read(), { status: 'ok', revision: 1, paths: [canonical] })
})

test('post-rename fsync and settle-read failures stay indeterminate for add and remove', async t => {
  const { root, registry: freshRegistry } = await fixture(t)
  await mkdir(join(root, 'library'))
  const canonical = await realpath(join(root, 'library'))
  const target = recordPath(root)
  let renames = 0
  let failFsync = false
  let failSettleRead = false
  const fs = instrumentFs(createNodeFs(), (op, args, phase) => {
    if (phase === 'after' && op === 'rename' && args[1] === target) {
      renames += 1
      failFsync = true
      failSettleRead = true
    }
    if (phase === 'before' && op === 'fsyncDir' && failFsync && args[0] === dirname(target)) {
      failFsync = false
      throw Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    }
    if (phase === 'before' && op === 'readText' && failSettleRead && args[0] === target) {
      failSettleRead = false
      throw Object.assign(new Error('settle read failed'), { code: 'EIO' })
    }
  })
  const store = openCapabilityStore({ root, platform, fs, liveness: createStubLiveness() })
  const registry = createSkillScanPathRegistry({ store, home: root, platform })

  const added = await registry.add(canonical, 0)
  assert.equal(added.status, 'indeterminate')
  assert.equal(added.saved, false)
  assert.equal(added.revision, null)
  assert.equal(added.paths, null)
  assert.equal(added.error.code, 'write-failed')
  assert.deepEqual(await freshRegistry.read(), { status: 'ok', revision: 1, paths: [canonical] })

  const removed = await registry.remove(canonical, 1)
  assert.equal(removed.status, 'indeterminate')
  assert.equal(removed.saved, false)
  assert.equal(removed.revision, null)
  assert.equal(removed.paths, null)
  assert.equal(removed.error.code, 'write-failed')
  assert.deepEqual(await freshRegistry.read(), { status: 'ok', revision: 2, paths: [] })
  assert.equal(renames, 2)
})

test('Windows home expansion and case/separator folding do not replace the stored display path', async t => {
  const { root, store } = await fixture(t)
  const canonical = 'C:\\Users\\Test\\Skills'
  const fs = {
    realpath: async () => canonical,
    stat: async () => ({ isDirectory: () => true }),
    access: async () => {},
  }
  const registry = createSkillScanPathRegistry({ store, home: 'C:\\Users\\Test', platform: 'win32', pathApi: win32, fs })
  const saved = await registry.add('~\\Skills', 0)
  assert.equal(saved.status, 'saved')
  assert.deepEqual(saved.paths, [canonical])
  const duplicate = await registry.add('c:/users/test/skills', 1)
  assert.equal(duplicate.status, 'duplicate')
  assert.deepEqual(duplicate.paths, [canonical])
})
