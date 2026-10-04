import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertContained, ensureWorkspaceRepo, repoToplevel } from '../src/git-repo.js'

const git = (dir, args, allowFail = false) => {
  try {
    return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  } catch (error) {
    if (allowFail) return null
    throw error
  }
}

const base = () => realpathSync(mkdtempSync(join(tmpdir(), 'orrery-git-repo-')))

test('a plain directory outside any repository is initialized in place', () => {
  const dir = join(base(), 'ws')
  const first = ensureWorkspaceRepo(dir)
  assert.equal(first.initialized, true)
  assert.equal(repoToplevel(dir), realpathSync(dir))
  const again = ensureWorkspaceRepo(dir)
  assert.equal(again.initialized, false)
})

test('a workspace nested inside an enclosing repository gets its own .git and never touches the parent', () => {
  // Mirror the incident shape: <parent>/.orrery/it-root/ws with no .git of its own.
  const parent = join(base(), 'repo')
  mkdirSync(join(parent, '.orrery', 'it-root'), { recursive: true })
  git(parent, ['init', '-q', '-b', 'main'])
  git(parent, ['config', 'user.email', 'it@example.com'])
  git(parent, ['config', 'user.name', 'IT'])
  writeFileSync(join(parent, 'unstaged-work.txt'), 'another session\'s work\n')
  // The real repository excludes the IT root locally, like .git/info/exclude does.
  mkdirSync(join(parent, '.git', 'info'), { recursive: true })
  writeFileSync(join(parent, '.git', 'info', 'exclude'), '/.orrery/\n')

  const ws = join(parent, '.orrery', 'it-root', 'ws')
  // Before the fix this probe resolved the PARENT repo and the scenario's
  // `git add -A && git commit` swept the parent's unstaged work.
  mkdirSync(ws, { recursive: true })
  assert.equal(repoToplevel(ws), realpathSync(parent))

  const result = ensureWorkspaceRepo(ws)
  assert.equal(result.initialized, true)
  assert.equal(repoToplevel(ws), realpathSync(ws))

  // The scenario's fixture commit now stays inside ws.
  assertContained(ws)
  git(ws, ['add', '-A'])
  git(ws, ['commit', '-qm', 'fixture', '--allow-empty'])
  assert.equal(git(parent, ['log', '--oneline'], true), null, 'parent repository must stay commit-less')
  assert.equal(git(parent, ['status', '--porcelain']), '?? unstaged-work.txt', 'parent work must remain unstaged and unmodified')
})

test('an existing workspace repository is reused, not re-initialized', () => {
  const dir = join(base(), 'ws')
  ensureWorkspaceRepo(dir)
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'first'])
  const before = git(dir, ['log', '--oneline'])
  const again = ensureWorkspaceRepo(dir)
  assert.equal(again.initialized, false)
  assert.equal(git(dir, ['log', '--oneline']), before)
})

test('assertContained throws when a foreign repository governs the directory', () => {
  const parent = join(base(), 'repo')
  mkdirSync(parent, { recursive: true })
  git(parent, ['init', '-q', '-b', 'main'])
  const nested = join(parent, 'plain-subdir')
  mkdirSync(nested)
  assert.throws(() => assertContained(nested), /git containment violated/)
})
