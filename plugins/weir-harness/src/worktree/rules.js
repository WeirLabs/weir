// Rule-derived lane facts: identifiers, layout validation, setup/verification
// suggestions, glob scope, and git output parsing. Everything the model does
// NOT decide lives here as a pure function. Pure module (no ctx, no node:
// imports) — paths are handled as '/'-separated strings.
import { WORKTREE_CODES, WorktreeError } from './errors.js'

export const DEFAULT_ROOT = '.weir/worktrees'
export const BRANCH_PREFIX = 'weir/'
export const MIN_GIT = Object.freeze([2, 38, 0])
export const EXCLUDE_MARKER = '# weir-harness: runtime scratch and worktree lanes (local only)'

/**
 * ASCII slug of a lane title: lowercase, diacritics folded, every other run
 * of non-alphanumerics collapsed to '-', at most 32 characters; 'lane' when
 * nothing survives (a pure CJK title, for example).
 * @param {string} title
 */
export function slugify(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'lane'
}

/**
 * @param {string} title
 * @param {number} seq - per-repository sequence (1-based)
 */
export function laneIdFor(title, seq) {
  return `${slugify(title)}-${String(seq).padStart(3, '0')}`
}

/** @param {string} laneId */
export function branchFor(laneId) {
  return `${BRANCH_PREFIX}${laneId}`
}

/**
 * Normalize a repository-relative lane root ('/'-separated, no leading './',
 * no trailing '/'). A root that is absolute or climbs out of the repository
 * is refused with ROOT_OUTSIDE_REPO.
 * @param {string} root
 */
export function normalizeRoot(root) {
  const raw = String(root ?? '').replace(/\\/g, '/').trim()
  if (raw.length === 0 || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new WorktreeError(WORKTREE_CODES.ROOT_OUTSIDE_REPO, `worktreeRoot must be a relative path inside the repository, got "${root}"`)
  }
  /** @type {string[]} */
  const parts = []
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new WorktreeError(WORKTREE_CODES.ROOT_OUTSIDE_REPO, `worktreeRoot "${root}" resolves outside the repository`)
      parts.pop()
      continue
    }
    parts.push(part)
  }
  if (parts.length === 0) throw new WorktreeError(WORKTREE_CODES.ROOT_OUTSIDE_REPO, `worktreeRoot "${root}" resolves to the repository root itself`)
  if (parts[0] === '.git') throw new WorktreeError(WORKTREE_CODES.ROOT_OUTSIDE_REPO, 'worktreeRoot must not live inside .git')
  return parts.join('/')
}

/** Weir's per-repository runtime scratch (audit, Edit Lock, lanes, notes). */
export const WEIR_DIR_RULE = '/.weir/'

/** The local exclude rule for a normalized root. @param {string} root */
export function excludeRuleFor(root) {
  return `/${root}/`
}

/**
 * Every local exclude rule a repository needs: Weir's whole scratch
 * directory (never version-controlled), plus the lane root when it is
 * configured outside that directory.
 * @param {string} root - normalized lane root
 */
export function excludeRulesFor(root) {
  return root === '.weir' || root.startsWith('.weir/') ? [WEIR_DIR_RULE] : [WEIR_DIR_RULE, excludeRuleFor(root)]
}

import { bareSetupCommand } from './pkgmgr.js'

/**
 * Lockfile-derived package MANAGER, or null when the repository has none.
 * Only the manager is decided here: how it is invoked (system tool, DSH
 * bundled runtime, or nothing available) is resolved separately so a bare
 * `pnpm` is never assumed to exist on PATH (AGENTS.md §2, S21).
 * @param {Iterable<string>} fileNames - names present at the lane root
 * @returns {'pnpm' | 'bun' | 'yarn' | 'npm' | null}
 */
export function setupManagerFor(fileNames) {
  const files = new Set(fileNames)
  if (files.has('pnpm-lock.yaml')) return 'pnpm'
  if (files.has('bun.lock') || files.has('bun.lockb')) return 'bun'
  if (files.has('yarn.lock')) return 'yarn'
  if (files.has('package-lock.json')) return 'npm'
  return null
}

/**
 * Lockfile-derived setup command as a plain string (bare manager name). Used
 * only where no resolver is available; the resolved form lives in pkgmgr.js.
 * @param {Iterable<string>} fileNames
 */
export function setupCommandFor(fileNames) {
  const manager = setupManagerFor(fileNames)
  return manager ? bareSetupCommand(manager) : null
}

/**
 * Verification command SUGGESTIONS for /worktree init. Never executed or
 * written without the user's confirmation.
 * @param {{ packageJson?: any, fileNames: Iterable<string> }} input
 * @returns {Array<{ name: string, run: string }>}
 */
export function suggestChecks({ packageJson, fileNames }) {
  const files = new Set(fileNames)
  /** @type {Array<{ name: string, run: string }>} */
  const checks = []
  const scripts = packageJson && typeof packageJson.scripts === 'object' ? packageJson.scripts : {}
  const runner = files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : files.has('bun.lock') || files.has('bun.lockb') ? 'bun' : 'npm'
  for (const name of ['typecheck', 'check', 'lint', 'test']) {
    if (typeof scripts?.[name] === 'string') checks.push({ name, run: runner === 'npm' ? `npm run ${name}` : `${runner} run ${name}` })
  }
  if (files.has('Cargo.toml')) checks.push({ name: 'cargo-test', run: 'cargo test' })
  if (files.has('go.mod')) checks.push({ name: 'go-test', run: 'go test ./...' })
  return checks
}

/**
 * Validate the repository-local config (`<root>/.config.json`). Unknown
 * keys are ignored; a malformed known key is an error (never silently run).
 * @param {any} raw
 * @returns {{ setup: string | null, check: Array<{ name: string, run: string, timeoutSec: number }> }}
 */
export function parseRepoConfig(raw) {
  if (raw === undefined || raw === null) return { setup: null, check: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('worktree config must be a JSON object')
  const setup = raw.setup === undefined || raw.setup === null ? null : raw.setup
  if (setup !== null && (typeof setup !== 'string' || setup.trim().length === 0)) throw new Error('worktree config "setup" must be a non-empty string')
  const check = raw.check === undefined ? [] : raw.check
  if (!Array.isArray(check)) throw new Error('worktree config "check" must be an array')
  return {
    setup,
    check: check.map((entry, index) => {
      if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.run !== 'string' || !entry.run.trim()) {
        throw new Error(`worktree config check[${index}] needs non-empty "name" and "run" strings`)
      }
      const timeoutSec = entry.timeoutSec === undefined ? 600 : entry.timeoutSec
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error(`worktree config check[${index}].timeoutSec must be a positive number`)
      return { name: entry.name.trim(), run: entry.run, timeoutSec }
    }),
  }
}

/** @param {string} text - `git --version` output */
export function parseGitVersion(text) {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text))
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
}

/** @param {number[] | null} version @param {readonly number[]} [minimum] */
export function gitAtLeast(version, minimum = MIN_GIT) {
  if (!version) return false
  for (let index = 0; index < 3; index++) {
    if ((version[index] ?? 0) !== minimum[index]) return (version[index] ?? 0) > minimum[index]
  }
  return true
}

/**
 * Compile a scope glob ('**' any depth, '*' one segment, '?' one char).
 * @param {string} glob
 */
export function globToRegExp(glob) {
  const source = String(glob).replace(/\\/g, '/').replace(/^\.\//, '')
  let out = ''
  for (let index = 0; index < source.length; index++) {
    const ch = source[index]
    if (ch === '*') {
      if (source[index + 1] === '*') {
        index++
        if (source[index + 1] === '/') {
          index++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * Whether a lane-relative path falls inside a scope. An empty/absent scope
 * means the whole lane.
 * @param {string} relPath - '/'-separated, relative to the lane root
 * @param {string[] | null | undefined} scope
 */
export function inScope(relPath, scope) {
  if (!scope || scope.length === 0) return true
  const path = relPath.replace(/\\/g, '/')
  return scope.some((glob) => {
    const pattern = globToRegExp(glob)
    // A directory-shaped scope entry ("src/auth") also covers its contents.
    return pattern.test(path) || (!/[*?]/.test(glob) && path.startsWith(`${glob.replace(/\/+$/, '')}/`))
  })
}

/** Literal directory prefix before the first wildcard. @param {string} glob */
export function staticPrefix(glob) {
  const normalized = String(glob).replace(/\\/g, '/').replace(/^\.\//, '')
  const wild = normalized.search(/[*?]/)
  const literal = wild === -1 ? normalized : normalized.slice(0, wild)
  return wild === -1 ? literal.replace(/\/+$/, '') : literal.slice(0, literal.lastIndexOf('/') + 1).replace(/\/+$/, '')
}

/**
 * Conservative overlap between two scopes: they overlap when either glob
 * matches the other's literal prefix region (one prefix contains the other).
 * Unscoped lanes are not compared (both must declare a scope).
 * @param {string[]} left @param {string[]} right
 */
export function scopesOverlap(left, right) {
  if (!left?.length || !right?.length) return false
  for (const a of left) {
    for (const b of right) {
      const pa = staticPrefix(a)
      const pb = staticPrefix(b)
      if (pa === '' || pb === '' || pa === pb) return true
      if (pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)) return true
      if (inScope(pa, [b]) || inScope(pb, [a])) return true
    }
  }
  return false
}

/**
 * Parse `git worktree list --porcelain`.
 * @param {string} text
 * @returns {Array<{ path: string, head: string | null, branch: string | null, detached: boolean }>}
 */
export function parseWorktreeList(text) {
  /** @type {Array<{ path: string, head: string | null, branch: string | null, detached: boolean }>} */
  const entries = []
  /** @type {{ path: string, head: string | null, branch: string | null, detached: boolean } | null} */
  let current = null
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), head: null, branch: null, detached: false }
      entries.push(current)
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '')
    } else if (current && line === 'detached') {
      current.detached = true
    }
  }
  return entries
}

/**
 * Parse `git merge-tree --write-tree --name-only` output.
 * @param {number} code - exit code (0 clean, 1 conflicts)
 * @param {string} stdout
 * @returns {{ clean: boolean, conflicts: string[] }}
 */
export function parseMergeTree(code, stdout) {
  const lines = String(stdout).split(/\r?\n/)
  if (code === 0) return { clean: true, conflicts: [] }
  /** @type {string[]} */
  const conflicts = []
  // Line 0 is the tree id; conflicted paths follow until the first blank line.
  for (const line of lines.slice(1)) {
    if (line.trim() === '') break
    conflicts.push(line)
  }
  return { clean: false, conflicts: [...new Set(conflicts)] }
}

/**
 * Paths named by `git status --porcelain` (v1), staged flag included.
 * @param {string} text
 * @returns {Array<{ path: string, staged: boolean, untracked: boolean }>}
 */
export function parseStatus(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      const x = line[0]
      const y = line[1]
      let path = line.slice(3)
      const arrow = path.indexOf(' -> ')
      if (arrow !== -1) path = path.slice(arrow + 4)
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
      return { path, staged: x !== ' ' && x !== '?', untracked: x === '?' && y === '?' }
    })
}
