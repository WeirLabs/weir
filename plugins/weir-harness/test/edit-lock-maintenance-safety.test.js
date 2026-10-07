import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, openSync, ftruncateSync, closeSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createEditLockEvidence, inspectAuthority, maintenanceStatus, MAX_INSPECTION_BYTES, wireEditLockMaintenance } from '../src/edit-lock/maintenance.js'
import { apply as applySettings } from '../src/settings/index.js'
import { apply as applyEditLock } from '../src/edit-lock/index.js'

// No temp outside the lane, discovery, runtime, reservation or service connection.
const fixtures = fileURLToPath(new URL('../../../.weir/maintenance-qa/', import.meta.url))
function fixture(t) {
  mkdirSync(fixtures, { recursive: true })
  const root = realpathSync(mkdtempSync(join(fixtures, 'safe-')))
  t.after(() => {
    assert.ok(root.startsWith(realpathSync(fixtures) + '/safe-'))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}
const status = evidence => maintenanceStatus({ evidence, savedEnabled: () => false, candidateRoots: () => [] })

test('rejects a symlinked .weir parent without interpreting outside bytes', t => {
  const base = fixture(t)
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(join(outside, 'edit-lock'), { recursive: true })
  writeFileSync(join(outside, 'edit-lock', 'snapshot.json'), 'OUTSIDE SECRET')
  symlinkSync(outside, join(root, '.weir'))
  const result = inspectAuthority(root)
  assert.equal(result.presence, 'unreadable')
  assert.match(result.message, /symlink/)
  assert.equal(result.snapshot, undefined)
})

test('later disabled mount cannot erase an earlier enabled mount', () => {
  const evidence = createEditLockEvidence()
  evidence.recordMount({ enabled: true })
  evidence.recordMount({ enabled: false })
  assert.equal(status(evidence).state, 'unknown')
  assert.equal(status(evidence).mounted, null)
})

test('disposing one mount never deletes another, and stale callbacks stay dead', () => {
  const evidence = createEditLockEvidence()
  const enabled = evidence.recordMount({ enabled: true })
  const disabled = evidence.recordMount({ enabled: false })
  disabled.dispose()
  assert.equal(status(evidence).state, 'disable-requested')
  enabled.disposing()
  assert.equal(status(evidence).state, 'unknown')
  enabled.dispose()
  enabled.recordDomain('/never-revive', { mode: 'publisher' })
  enabled.recordSessionFailure('late', 'late')
  assert.deepEqual(evidence.snapshot(), { mounts: [], domains: [], sessionFailures: [] })
})

test('installation throws leave failed rather than enforced evidence', () => {
  const evidence = createEditLockEvidence()
  const ctx = {
    get: () => ({ get: () => undefined, editLockEvidence: evidence }),
    inject() { throw new Error('installation failure') },
  }
  assert.throws(() => applyEditLock(ctx, { enabled: true }), /installation failure/)
  assert.equal(evidence.snapshot().mounts[0].phase, 'failed')
  assert.equal(status(evidence).state, 'unknown')
})

test('settings remount preserves live evidence within host but not across hosts', () => {
  function mount(root) {
    let service
    const off = applySettings({ root, logger: {}, reflect: { provide: (_, value) => { service = value } }, get() {}, on() {}, inject() {} }, {})
    return { service, off }
  }
  const root = {}
  const first = mount(root)
  const row = first.service.editLockEvidence.recordMount({ enabled: true })
  first.off()
  const second = mount(root)
  assert.equal(status(second.service.editLockEvidence).state, 'disable-requested')
  assert.equal(status(mount({}).service.editLockEvidence).state, 'unknown')
  row.dispose()
  assert.equal(status(second.service.editLockEvidence).state, 'unknown')
  second.off()
})

test('late connection injection cannot revive disposed endpoints', () => {
  let callback
  const off = wireEditLockMaintenance({ inject: (_, fn) => { callback = fn } }, {})
  off()
  callback({ connection: { fetch: { register() { throw new Error('must not register') } } } })
})

test('rejects authority and snapshot symlinks, non-files and oversized snapshots', t => {
  const base = fixture(t)
  const outside = join(base, 'outside')
  mkdirSync(outside)
  for (const kind of ['authority', 'snapshot', 'directory', 'oversize']) {
    const root = join(base, kind)
    const authority = join(root, '.weir', 'edit-lock')
    mkdirSync(join(root, '.weir'), { recursive: true })
    if (kind === 'authority') symlinkSync(outside, authority)
    else {
      mkdirSync(authority)
      const path = join(authority, 'snapshot.json')
      if (kind === 'snapshot') symlinkSync(outside, path)
      else if (kind === 'directory') mkdirSync(path)
      else {
        const fd = openSync(path, 'w')
        try { ftruncateSync(fd, MAX_INSPECTION_BYTES + 1) } finally { closeSync(fd) }
      }
    }
    const result = inspectAuthority(root)
    assert.equal(result.presence, kind === 'snapshot' || kind === 'directory' ? 'not-a-file' : 'unreadable')
    assert.equal(result.snapshot, undefined)
  }
})
