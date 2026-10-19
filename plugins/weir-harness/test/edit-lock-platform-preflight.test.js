import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { anchorFor } from '../src/hashline-edit/anchors.js'

for (const platform of ['darwin', 'linux', 'win32', 'freebsd']) {
  test(`${platform}: genuinely off never mounts protection or probes the filesystem`, () => {
    const get = () => ({ get: () => ({ enabled: false }) })
    assert.equal(createEditLockPlugin({ platform })({ get }), undefined)
    assert.equal(createEditLockPlugin({ platform })({ get }, { enabled: false }), undefined)
  })
}

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform}: supported mount retains the normal provider`, async () => {
    const services = new Map()
    const warnings = []
    const dispose = createEditLockPlugin({ platform })({
      get: name => services.get(name),
      reflect: { provide: (name, value) => services.set(name, value) },
      tools: { register: () => () => {} },
      on() {}, fs: {}, logger: { warn: value => warnings.push(value) },
    }, { enabled: true })
    assert.equal(typeof services.get('weirEditLock').publish, 'function')
    assert.deepEqual(warnings, [])
    await dispose()
  })
}

// Installed-runtime platform-refusal regression deleted with the mechanism
// (edit-lock-rebuild, spec REMOVED "Unsupported platform refusal before
// editing"): the preset no longer mounts weir-harness/edit-lock, so the
// shipped patch cannot be mirrored with a platform adapter any more. The
// replacement contract is degradation ("Degradation is non-blocking") and is
// covered by the file-lease/client unit suites, not by an installed boot.