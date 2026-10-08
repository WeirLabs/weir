import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync, linkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createResourceIdentity } from '../src/edit-lock/resource-identity.js'

// win32 row of the resource-identity platform matrix (openspec
// windows-platform-adaptation): native drive-letter spellings, both
// separators, NTFS dev/ino identity and junction-as-symlink traversal against
// the REAL filesystem. Junctions need no symlink privilege, so every fixture
// here is privilege-free. Registers as an explicit skip off win32.
const test = (name, body) => nodeTest(name, { skip: process.platform === 'win32' ? false : 'win32 platform row' }, body)

function fixture(t) {
  const parent = realpathSync.native(tmpdir())
  const root = mkdtempSync(join(parent, 'weir-resource-identity-win32-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('resolves a regular file from backslash, forward-slash and relative spellings', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'file.txt'), 'original', { flag: 'wx' })
  const identity = createResourceIdentity()
  const expected = realpathSync.native(join(root, 'file.txt'))
  const native = identity.resolve(join(root, 'file.txt'), { cwd: root })
  assert.deepEqual(native, { kind: 'file', resourceId: expected })
  const slashed = root.replace(/\\/g, '/')
  assert.deepEqual(identity.resolve(`${slashed}/file.txt`, { cwd: root }), native)
  assert.deepEqual(identity.resolve('./file.txt', { cwd: root }), native)
  assert.deepEqual(identity.revalidate(native), native)
})

test('missing observations retain a canonical ancestor and literal suffix', t => {
  const root = fixture(t)
  const identity = createResourceIdentity()
  const observation = identity.resolve('new/child.txt', { cwd: root })
  assert.deepEqual(observation, { kind: 'missing', ancestor: realpathSync.native(root), suffix: 'new/child.txt' })
  assert(Object.isFrozen(observation))
  assert.deepEqual(identity.revalidate(observation), observation)
})

test('rejects directories, hardlinked files and dangling links instead of classifying them', t => {
  const root = fixture(t)
  const identity = createResourceIdentity()
  mkdirSync(join(root, 'dir'))
  writeFileSync(join(root, 'file'), 'bytes')
  linkSync(join(root, 'file'), join(root, 'hardlink'))
  symlinkSync('absent', join(root, 'dangling'), 'junction')
  for (const path of ['dir', 'file', 'hardlink', 'dangling', 'file/child']) {
    assert.throws(() => identity.resolve(path, { cwd: root }), undefined, path)
  }
})

test('junction components are witnessed as links and retargeting breaks revalidation', t => {
  const root = fixture(t)
  const identity = createResourceIdentity()
  mkdirSync(join(root, 'physical', 'child'), { recursive: true })
  writeFileSync(join(root, 'physical', 'child', 'file'), 'bytes')
  symlinkSync(join(root, 'physical'), join(root, 'alias'), 'junction')
  const observed = identity.resolve('alias/child/file', { cwd: root })
  assert.equal(observed.resourceId, realpathSync.native(join(root, 'physical', 'child', 'file')))
  assert.deepEqual(identity.revalidate(observed), observed)
  rmSync(join(root, 'alias'), { force: true })
  symlinkSync(join(root, 'physical', 'child'), join(root, 'alias'), 'junction')
  assert.throws(() => identity.revalidate(observed), /topology changed/)
})

test('UNC spellings are rejected explicitly, never reinterpreted', t => {
  const root = fixture(t)
  const identity = createResourceIdentity()
  assert.throws(() => identity.resolve('//server/share/file', { cwd: root }), /unsupported path root/)
  assert.throws(() => identity.resolve('\\\\server\\share\\file', { cwd: root }), /unsupported path root/)
})

test('revalidation ignores content changes but rejects file replacement', t => {
  const root = fixture(t)
  const identity = createResourceIdentity()
  const file = join(root, 'file')
  writeFileSync(file, 'first')
  const observation = identity.resolve('file', { cwd: root })
  writeFileSync(file, 'changed content')
  assert.deepEqual(identity.revalidate(observation), observation)
  const retired = join(root, 'retired')
  renameSync(file, retired)
  writeFileSync(file, 'changed content')
  assert.throws(() => identity.revalidate(observation), /topology changed/)
})
