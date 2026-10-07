// Git containment for integration workspaces that live INSIDE another
// repository (the default IT root is <repo>/.weir/it-root, lane-resolved).
// A `git` call whose cwd sits inside such a workspace resolves the ENCLOSING
// repository when the workspace has no .git of its own — `git add -A` then
// sweeps the enclosing repository's unstaged work into a commit (the 2026-10-05
// "fixture" pollution incident). Route every workspace repo setup through
// ensureWorkspaceRepo and re-assert containment before mutations.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const gitIn = (dir, args) =>
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })

/** Resolved toplevel of the repository governing dir, or null when none. */
export function repoToplevel(dir) {
  try {
    return realpathSync(gitIn(dir, ['rev-parse', '--show-toplevel']).trim())
  } catch {
    return null
  }
}

/** Throw unless dir itself is the toplevel of the repository governing it. */
export function assertContained(dir) {
  const top = repoToplevel(dir)
  if (top === null || top !== realpathSync(dir)) {
    throw new Error(
      `git containment violated: ${dir} is governed by enclosing repository ${top ?? '<none>'}; ` +
        'refusing to run repository mutations outside the workspace repo',
    )
  }
}

/**
 * Make dir its own repository root and return whether this call initialized it.
 * A dir already governed by an ENCLOSING repository (parent-directory traversal)
 * still gets its own .git, so later git calls stay contained; the enclosing
 * repository never sees the workspace (the IT root lives under the locally
 * excluded .weir/).
 */
export function ensureWorkspaceRepo(dir) {
  mkdirSync(dir, { recursive: true })
  if (existsSync(join(dir, '.git'))) {
    // An existing repository (or linked worktree) must be rooted exactly here.
    assertContained(dir)
    return { initialized: false }
  }
  gitIn(dir, ['init', '-q', '-b', 'main'])
  gitIn(dir, ['config', 'user.email', 'it@example.com'])
  gitIn(dir, ['config', 'user.name', 'IT'])
  assertContained(dir)
  return { initialized: true }
}
