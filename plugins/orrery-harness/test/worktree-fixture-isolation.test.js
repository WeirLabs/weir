import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo, nodeGitRun, sh } from './helpers/worktree-fixtures.js'

// An enclosing repository is disposable too. No test ever uses the real
// checkout as its contamination target, even when the ceiling regresses.
test('nested non-repository fixtures cannot discover or mutate enclosing Git state', async () => {
  const outer = makeRepo()
  const previous = process.env.TMPDIR
  let inner
  try {
    process.env.TMPDIR = outer.repo
    inner = makeRepo()
    const head = sh(outer.repo, 'rev-parse', 'HEAD')
    const config = readFileSync(join(outer.repo, '.git', 'config'), 'utf8')
    const before = readdirSync(outer.repo).sort()
    const probe = await nodeGitRun(['git', 'rev-parse', '--show-toplevel'], { cwd: inner.root })
    assert.notEqual(probe.code, 0)
    assert.equal(probe.stdout, '')
    const write = await nodeGitRun(['git', 'config', '--local', 'test.contamination', 'forbidden'], { cwd: inner.root })
    assert.notEqual(write.code, 0)
    assert.throws(() => sh(inner.root, 'rev-parse', '--show-toplevel'))
    assert.equal(sh(inner.repo, 'rev-parse', '--show-toplevel'), inner.repo)
    assert.equal(sh(outer.repo, 'rev-parse', 'HEAD'), head)
    assert.equal(readFileSync(join(outer.repo, '.git', 'config'), 'utf8'), config)
    assert.deepEqual(readdirSync(outer.repo).sort(), before)
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    inner?.cleanup()
    outer.cleanup()
  }
})

test('fixture runners reject an unregistered cwd before spawning Git', () => {
  assert.throws(() => nodeGitRun(['git', '--version'], { cwd: process.cwd() }), /unregistered cwd/)
  assert.throws(() => sh(process.cwd(), '--version'), /unregistered cwd/)
})

test('fixture Git does not inherit repository overrides', async () => {
  const fixture = makeRepo()
  const old = process.env.GIT_DIR
  try {
    process.env.GIT_DIR = join(fixture.repo, '.git')
    const probe = await nodeGitRun(['git', 'rev-parse', '--show-toplevel'], { cwd: fixture.root })
    assert.notEqual(probe.code, 0)
    assert.equal(sh(fixture.repo, 'rev-parse', '--show-toplevel'), fixture.repo)
  } finally {
    if (old === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = old
    fixture.cleanup()
  }
})
