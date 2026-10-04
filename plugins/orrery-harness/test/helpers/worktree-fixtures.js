// Shared fixtures for worktree tests: throwaway git repositories and a git
// runner over node:child_process with the same contract as the host runner.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

// Registered fixture roots are the only directories these runners may access.
// In a worktree, tmpdir() can itself live inside a real repository: Git must
// stop above the fixture, including for deliberately non-repository cwds.
const fixtureRoots = new Set()
function fixtureEnvironment(cwd) {
  const canonical = realpathSync(cwd)
  const root = [...fixtureRoots].filter(root => {
    const path = relative(root, canonical)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  }).sort((a, b) => b.length - a.length)[0]
  if (!root) throw new Error(`git fixture runner refuses unregistered cwd: ${cwd}`)
  // Never inherit GIT_DIR/GIT_WORK_TREE/config overrides from the developer's
  // shell. Tests configure identity in each disposable repository instead.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: dirname(root),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
}

/** GitRun over child_process (argv[0] === 'git'). */
export function nodeGitRun(argv, { cwd }) {
  const env = fixtureEnvironment(cwd)
  return new Promise((resolve) => {
    const [, ...args] = argv
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: String(error) }))
  })
}

/** Run git synchronously in a fixture (test setup only). */
export function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: fixtureEnvironment(cwd) }).trim()
}

/**
 * A fresh repository with one commit on `main`. Callers remove it with
 * `cleanup()`.
 */
export function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orrery-wt-')))
  const repo = join(root, 'repo')
  fixtureRoots.add(root)
  sh(root, 'init', '-q', '-b', 'main', repo)
  sh(repo, 'config', 'user.email', 'test@example.com')
  sh(repo, 'config', 'user.name', 'Test')
  sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'init')
  return { root, repo, cleanup: () => {
    if (!fixtureRoots.has(root) || realpathSync(root) !== root) throw new Error('fixture cleanup root changed')
    rmSync(root, { recursive: true, force: true })
    fixtureRoots.delete(root)
  } }
}
