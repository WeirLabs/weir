// Git access for worktree lanes: the ONLY module that runs git. Every call is
// an explicit argv (no shell, no interpolation) through an injected runner, so
// unit tests drive it with a fake and the host drives it with ctx.subprocess.
// Nothing here ever passes --force; branch -D exists only behind an explicit
// `force: true` that the abandon flow sets after the user chose it.
import { WORKTREE_CODES, WorktreeError } from './errors.js'
import { gitAtLeast, parseGitVersion, parseMergeTree, parseStatus, parseWorktreeList } from './rules.js'

/**
 * @typedef {(argv: string[], options: { cwd: string, timeoutMs?: number }) => Promise<{ code: number, stdout: string, stderr: string }>} GitRun
 */

/** @param {GitRun} run */
export function createGit(run) {
  /** @param {string} cwd @param {string[]} args @param {{ ok?: number[], timeoutMs?: number }} [options] */
  async function git(cwd, args, options = {}) {
    const result = await run(['git', ...args], { cwd, timeoutMs: options.timeoutMs })
    const ok = options.ok ?? [0]
    if (!ok.includes(result.code)) {
      throw new WorktreeError(WORKTREE_CODES.GIT_FAILED, `git ${args.join(' ')} exited ${result.code}: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' | ')}`)
    }
    return result
  }
  const out = (/** @type {{ stdout: string }} */ result) => result.stdout.trim()

  return {
    /** @type {string | null} why the last version probe failed */
    lastVersionError: /** @type {string | null} */ (null),
    raw: git,
    /** @param {string} cwd - an absolute, existing directory (the subprocess service refuses relative cwds) */
    async version(cwd) {
      const result = await run(['git', '--version'], { cwd })
      this.lastVersionError = result.code === 0 ? null : `exit ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`
      return result.code === 0 ? parseGitVersion(result.stdout) : null
    },
    /** @param {number[] | null} version */
    supported: (version) => gitAtLeast(version),
    /** Main worktree root + common dir, or null outside a repository. @param {string} cwd */
    async repoOf(cwd) {
      const top = await run(['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd })
      if (top.code !== 0) return null
      const [toplevel, commonDir] = top.stdout.trim().split(/\r?\n/)
      // The main worktree is the one owning the common dir (first list entry).
      const list = await run(['git', 'worktree', 'list', '--porcelain'], { cwd })
      const main = list.code === 0 ? parseWorktreeList(list.stdout)[0]?.path : undefined
      return { toplevel, commonDir, mainRoot: main ?? toplevel }
    },
    /** @param {string} cwd @returns {Promise<string | null>} null when detached */
    async currentBranch(cwd) {
      const result = await run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })
      return result.code === 0 ? result.stdout.trim() : null
    },
    /** @param {string} cwd @param {string} [rev] */
    async revParse(cwd, rev = 'HEAD') {
      return out(await git(cwd, ['rev-parse', '--verify', '--quiet', rev]))
    },
    /** @param {string} cwd */
    async tree(cwd) {
      const result = await run(['git', 'rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], { cwd })
      return result.code === 0 ? result.stdout.trim() : null
    },
    /** @param {string} cwd @param {string} branch */
    async branchExists(cwd, branch) {
      const result = await run(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd })
      return result.code === 0
    },
    /** @param {string} cwd @param {string} path @param {string} branch @param {string} base */
    async worktreeAdd(cwd, path, branch, base) {
      await git(cwd, ['worktree', 'add', '-b', branch, path, base])
    },
    /** @param {string} cwd */
    async worktreeList(cwd) {
      return parseWorktreeList(out(await git(cwd, ['worktree', 'list', '--porcelain'])))
    },
    /** Never forced: a blocked removal is reported, not overridden. @param {string} cwd @param {string} path */
    async worktreeRemove(cwd, path) {
      const result = await run(['git', 'worktree', 'remove', path], { cwd })
      if (result.code !== 0) throw new WorktreeError(WORKTREE_CODES.REMOVE_BLOCKED, `git worktree remove ${path}: ${(result.stderr || result.stdout).trim()}`)
      await run(['git', 'worktree', 'prune'], { cwd })
    },
    /** @param {string} cwd */
    async status(cwd) {
      return parseStatus((await git(cwd, ['status', '--porcelain', '--untracked-files=all'])).stdout)
    },
    /** @param {string} cwd */
    async indexEmpty(cwd) {
      const result = await run(['git', 'diff', '--cached', '--quiet'], { cwd })
      return result.code === 0
    },
    /** Commits on `branch` not on `base` (ahead) and the reverse (behind). @param {string} cwd @param {string} base @param {string} branch */
    async aheadBehind(cwd, base, branch) {
      const [behind, ahead] = out(await git(cwd, ['rev-list', '--left-right', '--count', `${base}...${branch}`])).split(/\s+/).map(Number)
      return { ahead: ahead || 0, behind: behind || 0 }
    },
    /** @param {string} cwd @param {string} base @param {string} branch */
    async changedFiles(cwd, base, branch) {
      return out(await git(cwd, ['diff', '--name-only', `${base}...${branch}`])).split(/\r?\n/).filter(Boolean)
    },
    /** @param {string} cwd @param {string} base @param {string} branch */
    async diffStat(cwd, base, branch) {
      const text = out(await git(cwd, ['diff', '--numstat', `${base}...${branch}`]))
      let added = 0
      let removed = 0
      let files = 0
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const [a, r] = line.split('\t')
        files++
        added += Number(a) || 0
        removed += Number(r) || 0
      }
      return { files, added, removed }
    },
    /** @param {string} cwd @param {string} base @param {string} branch @param {number} [limit] */
    async commits(cwd, base, branch, limit = 20) {
      const text = out(await git(cwd, ['log', '--format=%h%x09%s', `-n${limit}`, `${base}..${branch}`]))
      return text.split(/\r?\n/).filter(Boolean).map((line) => {
        const tab = line.indexOf('\t')
        return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
      })
    },
    /** Unified diff for presentation (bounded). @param {string} cwd @param {string} base @param {string} branch */
    async diff(cwd, base, branch, maxBytes = 200_000) {
      const text = (await git(cwd, ['diff', '--no-color', `${base}...${branch}`])).stdout
      return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n… (diff truncated)` : text
    },
    /** Side-effect-free conflict precheck. @param {string} cwd @param {string} base @param {string} branch */
    async mergeTreeCheck(cwd, base, branch) {
      const result = await git(cwd, ['merge-tree', '--write-tree', '--name-only', base, branch], { ok: [0, 1] })
      return parseMergeTree(result.code, result.stdout)
    },
    /**
     * `--no-ff` merge into the CURRENT branch of `cwd`; a failed merge is
     * aborted so the main worktree is left as it was.
     * @param {string} cwd @param {string} branch @param {string} message
     */
    async mergeNoFf(cwd, branch, message) {
      const result = await run(['git', 'merge', '--no-ff', '--no-edit', '-m', message, branch], { cwd })
      if (result.code !== 0) {
        await run(['git', 'merge', '--abort'], { cwd })
        return { ok: false, detail: (result.stderr || result.stdout).trim() }
      }
      return { ok: true, commit: await this.revParse(cwd, 'HEAD') }
    },
    /** @param {string} cwd @param {string} branch @param {{ force?: boolean }} [options] */
    async branchDelete(cwd, branch, options = {}) {
      await git(cwd, ['branch', options.force === true ? '-D' : '-d', branch])
    },
    /** @param {string} cwd @param {string} base @param {string} branch */
    async unmergedCount(cwd, base, branch) {
      return Number(out(await git(cwd, ['rev-list', '--count', `${base}..${branch}`]))) || 0
    },
  }
}
