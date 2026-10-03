// Shared fixtures for worktree tests: throwaway git repositories and a git
// runner over node:child_process with the same contract as the host runner.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** GitRun over child_process (argv[0] === 'git'). */
export function nodeGitRun(argv, { cwd }) {
  return new Promise((resolve) => {
    const [, ...args] = argv
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
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
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

/**
 * A fresh repository with one commit on `main`. Callers remove it with
 * `cleanup()`.
 */
export function makeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orrery-wt-')))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  sh(repo, 'config', 'user.email', 'test@example.com')
  sh(repo, 'config', 'user.name', 'Test')
  sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'init')
  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
