import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_SNAPSHOT_BYTES, checkedPath, errorMessage, missing, readSnapshotBytes, sameNode } from '../src/edit-lock/read-authority.js'

// Focused unit pin for src/edit-lock/read-authority.js (change
// test-surface-pinning, task 6.1), previously zero direct test imports. The
// maintenance suites cover 'valid'/'unreadable'/'not-a-file' indirectly via
// inspectAuthority (edit-lock-maintenance.test.js, edit-lock-maintenance-safety.test.js);
// this pin nails the UNCOVERED presence faces ('no-authority', 'no-snapshot'),
// byte fidelity, and the pure helpers — presence facts, never inferred.

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'weir-read-authority-')))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('readSnapshotBytes reports no-authority when a path component is absent', () => {
  const { root, cleanup } = fixture()
  try {
    assert.deepEqual(readSnapshotBytes(join(root, 'missing', 'authority')), { presence: 'no-authority' })
  } finally {
    cleanup()
  }
})

test('readSnapshotBytes reports no-snapshot when the directory stands without the leaf', () => {
  const { root, cleanup } = fixture()
  try {
    const authority = join(root, 'authority')
    mkdirSync(authority)
    assert.deepEqual(readSnapshotBytes(authority), { presence: 'no-snapshot' })
  } finally {
    cleanup()
  }
})

test('readSnapshotBytes returns the exact bytes for a standing snapshot', () => {
  const { root, cleanup } = fixture()
  try {
    const authority = join(root, 'authority')
    mkdirSync(authority)
    const payload = JSON.stringify({ schemaVersion: 1, sessions: [], locks: [], histories: [] })
    writeFileSync(join(authority, 'snapshot.json'), payload)
    const result = readSnapshotBytes(authority)
    assert.equal(result.presence, 'valid')
    assert.equal(Buffer.from(result.bytes).toString('utf8'), payload)
  } finally {
    cleanup()
  }
})

test('readSnapshotBytes refuses a symlinked authority component', () => {
  const { root, cleanup } = fixture()
  try {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(root, 'linked'))
    const result = readSnapshotBytes(join(root, 'linked', 'authority'))
    assert.equal(result.presence, 'unreadable')
    assert.match(result.message, /symlink/)
  } finally {
    cleanup()
  }
})

test('the snapshot byte ceiling is the documented 16 MiB', () => {
  assert.equal(MAX_SNAPSHOT_BYTES, 16 * 1024 * 1024)
})

test('the pure helpers: checkedPath pins ancestors, sameNode compares identities, missing/errorMessage classify', () => {
  const { root, cleanup } = fixture()
  try {
    const pins = checkedPath(root)
    assert.ok(pins.length >= 1)
    assert.equal(pins.at(-1).path, root)
    // sameNode: identity is dev+ino+mode.
    assert.equal(sameNode(pins[0].stat, pins[0].stat), true)
    assert.equal(sameNode(pins[0].stat, pins.at(-1).stat), pins.length === 1)
    assert.equal(missing(Object.assign(new Error('gone'), { code: 'ENOENT' })), true)
    assert.equal(missing(new Error('plain')), false)
    assert.equal(missing(null), false)
    assert.equal(errorMessage(new Error('boom')), 'boom')
    assert.equal(errorMessage('raw'), 'raw')
    assert.equal(errorMessage(42), '42')
  } finally {
    cleanup()
  }
})
