import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createPresetLibrary } from '../src/capabilities/preset-library.js'
import { enumeratePresetUnits } from '../src/capabilities/store/enumerate.js'
import { createNodeFs } from '../src/capabilities/store/fs-adapter.js'

const fixture = () => {
  const store = openCapabilityStore({ root: mkdtempSync(join(tmpdir(), 'weir-names-')), platform: 'darwin', deadlineMs: 1000 })
  return { store, library: createPresetLibrary({ store }) }
}
const doc = name => ({ name, selection: { skills: [], mcpServers: [], unresolvedRefs: [] } })

test('legacy replace cannot create a second same-name ID', async () => {
  const { store, library } = fixture()
  assert.equal((await library.create({ scope: 'global', presetId: 'first', document: doc('Same') })).status, 'created')
  const second = await library.create({ scope: 'global', presetId: 'second', document: doc('Same'), onNameConflict: 'replace' })
  assert.equal(second.status, 'confirmation-required')
  assert.deepEqual((await enumeratePresetUnits(store)).presets.map(p => p.presetId), ['first'])
})

test('different-ID simultaneous name claims admit at most one writer', async () => {
  const { store, library } = fixture()
  const results = await Promise.all(['first', 'second'].map(presetId => library.create({ scope: 'global', presetId, document: doc('Same') })))
  assert.deepEqual(results.map(result => result.status).sort(), ['created', 'name-conflict'])
  assert.equal((await enumeratePresetUnits(store)).presets.length, 1)
})


test('strict write scan rejects unknown and damaged records while tolerant listing remains visible', async () => {
  const { store, library } = fixture()
  const dir = join(store.support.root, 'presets', 'global')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'stranger.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 999 }))
  assert.equal((await library.create({ scope: 'global', presetId: 'fresh', document: doc('New') })).status, 'unreadable')
  assert.deepEqual((await enumeratePresetUnits(store)).presets, [])
  assert.equal((await store.read({ kind: 'preset', scope: 'global', presetId: 'fresh' })).kind, 'absent')
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ schemaVersion: 999 }))
  writeFileSync(path, '{broken')
  assert.equal((await library.create({ scope: 'global', presetId: 'fresh', document: doc('New') })).status, 'unreadable')
})

test('tombstone never revives; a new ID can reuse its old display name', async () => {
  const { library } = fixture()
  await library.create({ scope: 'global', presetId: 'first', document: doc('Same') })
  assert.equal((await library.remove({ scope: 'global', presetId: 'first', expectedRevision: 1 })).status, 'deleted')
  assert.equal((await library.load('global', 'first')).kind, 'deleted')
  assert.equal((await library.resave({ scope: 'global', presetId: 'first', expectedRevision: 2, selection: doc('x').selection })).status, 'deleted')
  assert.equal((await library.create({ scope: 'global', document: doc('Same') })).presetId, 'same')
  assert.equal((await library.create({ scope: 'global', presetId: 'first', document: doc('Distinct') })).status, 'exists')
})

test('rename preserves contents and old duplicate groups permit only precise reduction', async () => {
  const { store, library } = fixture()
  const selection = { skills: [{ exact: 1 }], mcpServers: ['mcp'], unresolvedRefs: [{ ref: 'missing' }] }
  await library.create({ scope: 'global', presetId: 'one', document: { name: 'Old', selection } })
  // Fixture: old implementation could produce duplicate IDs using bare replace.
  await store.commit({ kind: 'preset', scope: 'global', presetId: 'two' }, 0, () => doc('Old'))
  assert.equal((await enumeratePresetUnits(store)).presets.length, 2)
  assert.equal((await library.resave({ scope: 'global', presetId: 'one', expectedRevision: 1, selection: doc('x').selection })).status, 'duplicate-names')
  assert.equal((await library.rename({ scope: 'global', presetId: 'one', expectedRevision: 1, name: 'Old' })).status, 'duplicate-names')
  assert.equal((await library.rename({ scope: 'global', presetId: 'one', expectedRevision: 1, name: 'Repaired' })).status, 'edited')
  assert.deepEqual((await library.load('global', 'one')).document.selection, selection)
  assert.equal((await library.load('global', 'two')).document.name, 'Old')
  assert.equal((await library.rename({ scope: 'global', presetId: 'one', expectedRevision: 2, name: 'Old' })).status, 'name-conflict')
})

test('stale exact target cannot be replaced after its revision or name changes', async () => {
  const { library } = fixture()
  await library.create({ scope: 'global', presetId: 'target', document: doc('Same') })
  const target = { presetId: 'target', expectedRevision: 1, name: 'Same' }
  await library.rename({ scope: 'global', presetId: 'target', expectedRevision: 1, name: 'Other' })
  assert.equal((await library.create({ scope: 'global', document: doc('Same'), onNameConflict: 'replace', replaceTarget: target })).status, 'revision-conflict')
  assert.equal((await library.load('global', 'target')).document.name, 'Other')
})


test('applied-source lock stays held through the preset CAS', async () => {
  const { store, library } = fixture()
  await library.create({ scope: 'global', presetId: 'target', document: doc('Initial') })
  let apply
  let applied = false
  const result = await library.resave({ scope: 'global', presetId: 'target', expectedRevision: 1,
    selection: doc('Applied').selection,
    withSource: commit => store.withSelectionSnapshot('session-1', async current => {
      assert.equal(current.kind, 'absent')
      apply = store.commit({ kind: 'selection', sessionId: 'session-1' }, 0, () => ({ skills: [], mcpServers: [] }))
        .then(value => { applied = true; return value })
      await new Promise(resolve => setTimeout(resolve, 25))
      assert.equal(applied, false)
      return commit()
    }),
  })
  assert.equal(result.status, 'edited')
  assert.equal((await apply).status, 'committed')
  assert.equal((await library.load('global', 'target')).revision, 2)
})


test('namespace readdir error is a typed unreadable refusal with no preset write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weir-names-'))
  const fs = createNodeFs()
  const store = openCapabilityStore({ root, platform: 'darwin', fs: {
    ...fs, readdir: path => path === join(root, 'presets', 'global')
      ? Promise.reject(Object.assign(new Error('blocked'), { code: 'EACCES' })) : fs.readdir(path),
  } })
  const result = await createPresetLibrary({ store }).create({ scope: 'global', presetId: 'fresh', document: doc('Fresh') })
  assert.equal(result.status, 'unreadable')
  assert.equal((await store.read({ kind: 'preset', scope: 'global', presetId: 'fresh' })).kind, 'absent')
})


test('import installation window excludes a competing rename name claim', async () => {
  const { library } = fixture()
  await library.create({ scope: 'global', presetId: 'existing', document: doc('Old') })
  let enterInstall
  const installing = new Promise(resolve => { enterInstall = resolve })
  let finishInstall
  const installed = new Promise(resolve => { finishInstall = resolve })
  const request = { scope: 'global', presetId: 'imported', document: doc('Shared') }
  const imported = library.withNamespace('global', undefined, async guarded => {
    assert.equal((await guarded.checkCreate(request)).status, 'ready')
    enterInstall()
    await installed // models bundled Skill installation before the preset CAS
    return guarded.create(request)
  })
  await installing
  let renameSettled = false
  const renamed = library.rename({ scope: 'global', presetId: 'existing', expectedRevision: 1, name: 'Shared' })
    .then(value => { renameSettled = true; return value })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(renameSettled, false)
  finishInstall()
  assert.equal((await imported).status, 'created')
  assert.equal((await renamed).status, 'name-conflict')
  assert.equal((await library.load('global', 'existing')).document.name, 'Old')
  assert.equal((await library.load('global', 'imported')).document.name, 'Shared')
})
