// Package-manager resolution for DERIVED lane setup commands. A derived
// command must never assume a bare `pnpm`/`npm` exists on PATH: the desktop
// host runs with a minimal PATH (S21), while the Harness bundles Node and
// pnpm itself. Resolution order is explicit: the system environment first
// (a user-installed manager wins), then the DSH bundled runtime. Bundled
// pnpm runs through the bundled Node's absolute path against `pnpm.mjs`;
// bundled npm only exists when the bundled Node directory actually contains
// an `npm`; yarn and bun have no bundled offer. The returned command
// prepends the resolved Node/bin directory to PATH so install lifecycle
// scripts can spawn node, and `exec`s the manager so its exit code passes
// straight through. User-CONFIGURED setup strings never enter this module.
// Pure module (no ctx, no node: imports) — every fact arrives through seams.
import { MANAGER_INSTALL } from './rules.js'

/** Files of the bundled runtime layout, relative to one runtime root. */
export const BUNDLED_REL = Object.freeze({
  node: 'dependencies/node/bin/node',
  npm: 'dependencies/node/bin/npm',
  pnpm: 'dependencies/pnpm/bin/pnpm.mjs',
})

const BUNDLED_OFFER = Object.freeze({
  pnpm: BUNDLED_REL.pnpm,
  npm: BUNDLED_REL.npm,
})

/** Single-quote a word for POSIX sh. @param {string} word */
export function quoteSh(word) {
  const text = String(word)
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** POSIX dirname of a '/'-separated path. @param {string} path */
function dirOf(path) {
  const at = path.lastIndexOf('/')
  return at > 0 ? path.slice(0, at) : at === 0 ? '/' : '.'
}

/**
 * @typedef {object} SetupSeams
 * @property {(name: string) => string | undefined} foundOnPath - absolute path of the system executable, if any
 * @property {(dir: string) => string[]} listDirs - directory entries ([] when absent/unreadable)
 * @property {(path: string) => boolean} isFile
 * @property {string | undefined} dshHome - the deployment's DSH home
 * @property {string} [home] - user home, used as `<home>/.dsh` when dshHome is unset
 */

/**
 * Resolve how a derived setup for `manager` should be invoked.
 * @param {string} manager - 'pnpm' | 'npm' | 'yarn' | 'bun'
 * @param {SetupSeams} seams
 * @returns {{ ok: true, source: 'system' | 'bundled', command: string, display: string } | { ok: false, manager: string }}
 */
export function resolveDerivedSetup(manager, seams) {
  const args = MANAGER_INSTALL[manager]
  if (!args) return { ok: false, manager }
  const system = seams.foundOnPath(manager)
  if (system) {
    return {
      ok: true,
      source: 'system',
      display: `${manager} ${args.join(' ')}`,
      command: wrap(dirOf(system), [system, ...args]),
    }
  }
  const offer = BUNDLED_OFFER[/** @type {'pnpm' | 'npm'} */ (manager)]
  const home = seams.dshHome ?? (seams.home ? `${seams.home}/.dsh` : undefined)
  if (offer && home) {
    let runtimes = []
    try {
      runtimes = seams.listDirs(`${home}/dsh-runtimes`)
    } catch {
      runtimes = []
    }
    for (const runtime of [...runtimes].sort()) {
      const root = `${home}/dsh-runtimes/${runtime}`
      const node = `${root}/${BUNDLED_REL.node}`
      const tool = `${root}/${offer}`
      if (!seams.isFile(node) || !seams.isFile(tool)) continue
      const argv = manager === 'pnpm' ? [node, tool, ...args] : [tool, ...args]
      return {
        ok: true,
        source: 'bundled',
        display: argv.map((part) => (part === node ? 'node' : part)).join(' '),
        command: wrap(`${root}/dependencies/node/bin`, argv),
      }
    }
  }
  return { ok: false, manager }
}

/**
 * The reason a `setup-failed` lane reports when resolution found nothing.
 * The caller substitutes the lane id for `<lane>`.
 * @param {string} manager
 */
export function setupMissingReason(manager) {
  return `setup needs ${manager}, but it was found neither on PATH nor in the DSH bundled runtime. Install ${manager} yourself, set "setup" in .orrery/worktrees/.config.json, or skip with /worktree setup <lane> --skip`
}

/** @param {string} binDir @param {string[]} argv */
function wrap(binDir, argv) {
  return `export PATH=${quoteSh(binDir)}:"$PATH"; exec ${argv.map(quoteSh).join(' ')}`
}
