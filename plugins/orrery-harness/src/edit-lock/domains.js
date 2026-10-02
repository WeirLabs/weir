import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Authority location inside a management root. */
export const AUTHORITY_DIR = join('.orrery', 'edit-lock')
const EXCLUDE_LINES = ['/.orrery/edit-lock/', '/.orrery/.edit-lock.publisher-reservation/']

/** @param {string} cwd @param {string[]} args @returns {string | undefined} */
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch { return undefined }
}

/** Management root for a session working directory: the git top level when
 * inside a repository, else the directory itself; an enclosing directory that
 * already hosts an Edit Lock authority wins so nested sessions share one domain.
 * @param {string} cwd */
export function managementRootFor(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('edit lock: absolute session cwd required')
  const start = realpathSync.native(cwd)
  const top = git(start, ['rev-parse', '--show-toplevel'])
  let root = top ? realpathSync.native(top) : start
  for (let candidate = dirname(root); candidate !== dirname(candidate); candidate = dirname(candidate)) {
    if (existsSync(join(candidate, AUTHORITY_DIR))) { root = candidate; break }
  }
  return root
}

/** Keep authority state out of version control without touching tracked files:
 * append to the repository's own info/exclude (worktree aware). Best effort.
 * @param {string} root */
export function excludeFromGit(root) {
  const relativePath = git(root, ['rev-parse', '--git-path', 'info/exclude'])
  if (!relativePath) return false
  const file = resolve(root, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = new Set(current.split('\n').map(line => line.trim()))
  const missing = EXCLUDE_LINES.filter(line => !lines.has(line))
  if (missing.length === 0) return true
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# Orrery Edit Lock authority state\n${missing.join('\n')}\n`)
  return true
}

/** Per-root lazy domain registry; a failed open is retried on next demand.
 * @template T
 * @param {(root: string) => Promise<T>} open */
export function createDomainRegistry(open) {
  /** @type {Map<string, Promise<T>>} */
  const domains = new Map()
  /** @type {WeakMap<object, string>} */
  const roots = new WeakMap()
  return Object.freeze({
    /** Bind once at agent creation; the session cwd never re-binds later.
     * @param {object} agent @param {string} cwd */
    bind(agent, cwd) {
      const root = managementRootFor(cwd)
      roots.set(agent, root)
      return root
    },
    /** @param {object} agent */
    rootOf(agent) { return roots.get(agent) },
    /** @param {object} agent @returns {Promise<T>} */
    forAgent(agent) {
      const root = roots.get(agent)
      if (!root) return Promise.reject(new Error('agent has no Edit Lock domain'))
      return this.forRoot(root)
    },
    /** @param {string} root @returns {Promise<T>} */
    forRoot(root) {
      let domain = domains.get(root)
      if (!domain) {
        domain = open(root)
        domains.set(root, domain)
        domain.catch(() => { if (domains.get(root) === domain) domains.delete(root) })
      }
      return domain
    },
    /** @returns {Promise<T>[]} */
    all() { return [...domains.values()] },
  })
}

/** @param {string} path */
export function isDirectory(path) {
  try { return lstatSync(path).isDirectory() } catch { return false }
}
