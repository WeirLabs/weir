import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path'

/** Authority location inside a management root. */
export const AUTHORITY_DIR = join('.weir', 'edit-lock')
const EXCLUDE_LINES = ['/.weir/edit-lock/', '/.weir/.edit-lock.publisher-reservation/']

/** @param {string} cwd @param {string[]} args @returns {string | undefined} */
function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch { return undefined }
}

/** Management root for a session working directory: the git top level when
 * inside a repository, else the directory itself; an enclosing directory that
 * already hosts an Edit Lock authority wins so nested sessions share one domain.
 * Optional discovery ceiling and Git adapter are for isolated embeddings;
 * omitted dependencies retain the normal ancestor-authority discovery.
 * @param {string} cwd
 * @param {{ ceiling?: string, runGit?: typeof git }} [dependencies] */
export function managementRootFor(cwd, { ceiling, runGit = git } = {}) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('edit lock: absolute session cwd required')
  const start = realpathSync.native(cwd)
  const limit = ceiling === undefined ? undefined : realpathSync.native(ceiling)
  const within = path => { const rel = relative(limit ?? path, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
  if (!within(start)) throw new Error('edit lock: cwd outside discovery ceiling')
  const top = runGit(start, ['rev-parse', '--show-toplevel'])
  let root = top ? realpathSync.native(top) : start
  if (!within(root)) throw new Error('edit lock: git root outside discovery ceiling')
  for (let candidate = dirname(root); candidate !== dirname(candidate); candidate = dirname(candidate)) {
    if (root === limit || !within(candidate)) break
    if (existsSync(join(candidate, AUTHORITY_DIR))) { root = candidate; break }
  }
  return root
}

/** Keep authority state out of version control without touching tracked files:
 * append to the repository's own info/exclude (worktree aware). Best effort.
 * @param {string} root
 * @param {typeof git} [runGit] */
export function excludeFromGit(root, runGit = git) {
  const relativePath = runGit(root, ['rev-parse', '--git-path', 'info/exclude'])
  if (!relativePath) return false
  const file = resolve(root, relativePath)
  mkdirSync(dirname(file), { recursive: true })
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = new Set(current.split('\n').map(line => line.trim()))
  const missing = EXCLUDE_LINES.filter(line => !lines.has(line))
  if (missing.length === 0) return true
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}# Weir Edit Lock authority state\n${missing.join('\n')}\n`)
  return true
}

/** Per-root lazy domain registry; a failed open is retried on next demand.
 * @template T
 * @param {(root: string) => Promise<T>} open
 * @param {(cwd: string) => string} [resolveRoot] */
export function createDomainRegistry(open, resolveRoot = managementRootFor) {
  /** @type {Map<string, Promise<T>>} */
  const domains = new Map()
  /** @type {WeakMap<object, string>} */
  const roots = new WeakMap()
  return Object.freeze({
    /** Bind once at agent creation; the session cwd never re-binds later.
     * @param {object} agent @param {string} cwd */
    bind(agent, cwd) {
      const root = resolveRoot(cwd)
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
    /** Membership only, never an open: the settings-plane online recovery
     * endpoint accepts only roots this registry already serves.
     * @param {string} root */
    known(root) { return domains.has(root) },
    /** @returns {Promise<T>[]} */
    all() { return [...domains.values()] },
  })
}

/** @type {WeakMap<object, Map<string, {registry: any, settled: WeakMap<object, any>, mounts: number}>>} */
const sharedRegistriesByHost = new WeakMap()

/** Process-shared domain registry container (change
 * edit-lock-shared-domain-mounts, design D1): several preset mounts of this
 * bundle coexist for the whole process, and every mount of one management
 * root must resolve the SAME domain — one runtime, one publisher reservation,
 * one lifecycle and one endpoint — instead of the second mount degrading to a
 * same-process remote client of the first.
 *
 * The container is keyed by host (`ctx.root ?? ctx`, the same key expression
 * the write-scope store uses — proven to be shared across preset mounts) plus
 * a caller-supplied configuration discriminator: mounts whose effective
 * domain configuration differs (a fixed root/authority row) NEVER share; they
 * keep today's independent-registry semantics exactly.
 *
 * Reference-counted by mount: each apply takes one count, each disposer
 * releases exactly one (idempotently); a factory that throws enters no count.
 * Only the LAST release closes every domain through the established drain
 * discipline (`registry.all() → domain.close()`), revoking sessions and
 * releasing reservations; the entry is then dropped, so a later generation
 * reopens fresh. The per-entry `settled` store shares the entry's lifetime:
 * it outlives any single mount (a preset switch lets a sibling mount's
 * listeners read the binding the first mount settled), and it dies with the
 * last release so a closed domain is never mistaken for a live binding.
 *
 * @template T
 * @param {object} host
 * @param {string} discriminator
 * @param {() => ReturnType<typeof createDomainRegistry<T>>} makeRegistry
 * @returns {{registry: ReturnType<typeof createDomainRegistry<T>>, settled: WeakMap<object, T>, release: () => Promise<void>}} */
export function sharedDomainRegistryFor(host, discriminator, makeRegistry) {
  let entries = sharedRegistriesByHost.get(host)
  if (!entries?.has(discriminator)) {
    // A throwing factory mutates nothing and enters no count.
    const created = makeRegistry()
    if (!entries) {
      entries = new Map()
      sharedRegistriesByHost.set(host, entries)
    }
    entries.set(discriminator, { registry: created, settled: new WeakMap(), mounts: 0 })
  }
  const entry = /** @type {{registry: any, settled: WeakMap<object, any>, mounts: number}} */ (entries.get(discriminator))
  entry.mounts += 1
  let released = false
  return Object.freeze({
    registry: entry.registry,
    settled: entry.settled,
    /** Idempotent: only the first call counts; only the last call closes. */
    async release() {
      if (released) return
      released = true
      entry.mounts -= 1
      if (entry.mounts > 0 || entries.get(discriminator) !== entry) return
      entries.delete(discriminator)
      const results = await Promise.allSettled(entry.registry.all().map(async domain => (await domain).close()))
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    },
  })
}

/** @param {string} path */
export function isDirectory(path) {
  try { return lstatSync(path).isDirectory() } catch { return false }
}
