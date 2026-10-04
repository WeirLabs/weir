import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { managementRootFor } from '../src/edit-lock/domains.js'

function fixture(t) {
  const parent = realpathSync(tmpdir())
  const base = realpathSync(mkdtempSync(join(parent, 'discovery-')))
  t.after(() => {
    assert.equal(dirname(base), parent)
    assert.equal(realpathSync(base), base)
    rmSync(base, { recursive: true, force: true })
  })
  const ceiling = join(base, 'ceiling')
  const child = join(ceiling, 'child')
  mkdirSync(child, { recursive: true })
  mkdirSync(join(base, '.orrery', 'edit-lock'), { recursive: true })
  return { base, ceiling, child }
}

test('ancestor authority lookup cannot cross ceiling even when Git finds nothing', t => {
  const { ceiling, child } = fixture(t)
  assert.equal(managementRootFor(child, { ceiling, runGit: () => undefined }), child)
  mkdirSync(join(ceiling, '.orrery', 'edit-lock'), { recursive: true })
  assert.equal(managementRootFor(child, { ceiling, runGit: () => undefined }), ceiling)
})
test('canonical cwd and Git roots outside ceiling are rejected before ancestor scanning', t => {
  const { base, ceiling, child } = fixture(t)
  let called = false
  assert.throws(() => managementRootFor(base, { ceiling, runGit: () => { called = true } }), /cwd outside/)
  assert.equal(called, false)
  assert.throws(() => managementRootFor(child, { ceiling, runGit: () => base }), /git root outside/)
})
