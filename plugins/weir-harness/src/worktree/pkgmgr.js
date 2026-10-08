// Package-manager resolution for DERIVED lane setup commands. A derived
// command must never assume a bare `pnpm`/`npm` exists on PATH: the desktop
// host runs with a minimal PATH (S21), while the Harness bundles Node and
// pnpm itself. Resolution order is explicit: the system environment first
// (a user-installed manager wins), then the DSH bundled runtime. Bundled
// pnpm runs through the bundled Node's absolute path against `pnpm.mjs`;
// bundled npm only exists when the bundled Node directory actually contains
// an `npm`; yarn and bun have no bundled offer. The returned command
// prepends the resolved Node/bin directory to PATH so install lifecycle
// scripts can spawn node, and hands the process over to the manager so its
// exit code passes straight through. The command text matches the host
// shell: POSIX sh (`export PATH=...; exec ...`) everywhere except win32,
// where the host shell is PowerShell (`$env:PATH = ...; & ...; exit
// $LASTEXITCODE`) — `export`/`exec` are not cmdlets and fail there.
// User-CONFIGURED setup strings never enter this module.
// Pure module (no ctx, no node: imports) — every fact arrives through seams.
/** Install arguments per package manager (frozen-lockfile semantics kept). */
export const MANAGER_INSTALL = Object.freeze({
  pnpm: ['install', '--frozen-lockfile'],
  bun: ['install', '--frozen-lockfile'],
  yarn: ['install', '--frozen-lockfile'],
  npm: ['ci'],
})

/** The legacy bare command form (`pnpm install --frozen-lockfile`). @param {string} manager */
export function bareSetupCommand(manager) {
  return `${manager} ${MANAGER_INSTALL[manager].join(' ')}`
}

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

/**
 * Single-quote a word for PowerShell: a single-quoted PowerShell string has
 * no escape semantics — the only special character inside is ' itself,
 * doubled. Every word is wrapped (there is no safe-word pass-through).
 * @param {string} word
 */
export function quotePs(word) {
  return `'${String(word).replace(/'/g, `''`)}'`
}

/**
 * dirname of a '/'- or '\'-separated path. POSIX edge semantics are kept
 * (root is '/', no separator is '.'); a win32 drive root keeps its
 * separator: dirOf('C:\\x') is 'C:\\', never 'C:'.
 * @param {string} path
 */
function dirOf(path) {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (at <= 0) return at === 0 ? '/' : '.'
  if (at === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3)
  return path.slice(0, at)
}

/**
 * @typedef {object} SetupSeams
 * @property {(name: string) => string | undefined} foundOnPath - absolute path of the named system executable, if any (called for the manager AND for 'node')
 * @property {(dir: string) => string[]} listDirs - directory entries ([] when absent/unreadable)
 * @property {(path: string) => boolean} isFile
 * @property {string | undefined} dshHome - the deployment's DSH home
 * @property {string} [home] - user home, used as `<home>/.dsh` when dshHome is unset
 * @property {string} [platform] - host platform ('win32' switches the command form, dirname separators, and the bundled node file name); defaults to process.platform
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
  // Defaulting to the HOST platform is the fail-safe choice: emitting POSIX
  // text on a Windows host is exactly the failure this seam exists to
  // prevent. Tests pin the platform explicitly.
  const platform = seams.platform ?? process.platform
  const system = seams.foundOnPath(manager)
  if (system) {
    const node = seams.foundOnPath('node')
    if (node) {
      return {
        ok: true,
        source: 'system',
        display: bareSetupCommand(manager),
        // Node's directory first: the manager's shim and every install
        // lifecycle script resolve node through PATH, and the manager's own
        // directory (e.g. ~/.npm-global/bin) need not contain one.
        command: wrap([dirOf(node), dirOf(system)], [system, ...args], platform),
      }
    }
    // A manager whose interpreter is not on PATH cannot run either — fall
    // through to the bundled offer, which guarantees a node.
  }
  const offer = BUNDLED_OFFER[/** @type {'pnpm' | 'npm'} */ (manager)]
  const home = seams.dshHome ?? (seams.home ? `${seams.home}/.dsh` : undefined)
  if (offer && home) {
    // The bundled Node executable carries the platform's file name.
    const nodeRel = platform === 'win32' ? `${BUNDLED_REL.node}.exe` : BUNDLED_REL.node
    let runtimes = []
    try {
      runtimes = seams.listDirs(`${home}/dsh-runtimes`)
    } catch {
      runtimes = []
    }
    for (const runtime of [...runtimes].sort()) {
      const root = `${home}/dsh-runtimes/${runtime}`
      const node = `${root}/${nodeRel}`
      const tool = `${root}/${offer}`
      if (!seams.isFile(node) || !seams.isFile(tool)) continue
      const argv = manager === 'pnpm' ? [node, tool, ...args] : [tool, ...args]
      return {
        ok: true,
        source: 'bundled',
        display: argv.map((part) => (part === node ? 'node' : part)).join(' '),
        command: wrap([`${root}/dependencies/node/bin`], argv, platform),
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
  return `setup needs ${manager}, but it was found neither on PATH nor in the DSH bundled runtime. Install ${manager} yourself, set "setup" in .weir/worktrees/.config.json, or skip with /worktree setup <lane> --skip`
}

/**
 * Build the derived setup command text for the host shell. POSIX keeps the
 * sh form (`export PATH=...:"$PATH"; exec ...`) byte for byte. win32 targets
 * PowerShell: the PATH prefix is one single-quoted ';'-joined string
 * prepended to $env:PATH, the argv runs through the `&` call operator with
 * every element single-quoted, and `exit $LASTEXITCODE` passes the manager's
 * exit code through (the role `exec` plays on POSIX).
 * @param {string[]} binDirs @param {string[]} argv @param {string} platform
 */
function wrap(binDirs, argv, platform) {
  if (platform === 'win32') {
    return `$env:PATH = ${quotePs(`${binDirs.join(';')};`)} + $env:PATH; & ${argv.map(quotePs).join(' ')}; exit $LASTEXITCODE`
  }
  const path = binDirs.map(quoteSh).join(':')
  return `export PATH=${path}:"$PATH"; exec ${argv.map(quoteSh).join(' ')}`
}
