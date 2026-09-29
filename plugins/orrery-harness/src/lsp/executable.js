// Executable resolution for LSP servers and installers. The desktop app is
// a GUI process launched by LaunchServices, so its PATH is the minimal
// `/usr/bin:/bin:/usr/sbin:/sbin` — Homebrew (/opt/homebrew, /usr/local),
// nvm, cargo, go, pipx and npm-global bins are all missing, and
// ctx.subprocess.resolveExecutable() fails for them (S21). This helper
// falls back to scanning well-known installation directories so servers and
// their installers resolve the same way they do in the user's shell.
//
// Windows resolves through the same helper with a different dialect: npm puts
// its global shims in `%APPDATA%\npm` (not `~/.npm-global/bin`), bare names
// carry a PATHEXT extension, and the PATH separator is `;`.
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Executable extensions probed for a bare name on win32 (from PATHEXT).
 * Lowercased: npm writes its shims as `.cmd`, while PATHEXT spells `.CMD` —
 * win32 matches case-insensitively, but the returned path is handed straight
 * to spawn, so it should name the file as it actually exists.
 */
function pathExtensions(env) {
  const raw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  return raw.split(';').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
}

/** Well-known bin directories scanned when the service resolver fails. */
export function extraBinDirectories(env = process.env, platform = process.platform) {
  const home = env.HOME ?? homedir()
  if (platform === 'win32') {
    // join() is the HOST dialect on purpose: platform selects which layout to
    // describe, not which separator to spell, so a test on any host can point
    // the seam at a real fixture directory.
    const roaming = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [
      // npm's own global prefix: the .cmd/.ps1 shims live directly here.
      join(roaming, 'npm'),
      // the plugin's pinned prefix (`npm --prefix <here> install -g …`):
      // POSIX puts the shims in `bin`, Windows puts them in the prefix root.
      join(home, '.npm-global'),
      join(home, '.npm-global', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, 'go', 'bin'),
      join(home, 'scoop', 'shims'),
      join(roaming, 'npm', 'node_modules', '.bin'),
    ]
  }
  const nvmBins = []
  const nvmBase = join(home, '.nvm', 'versions', 'node')
  try {
    for (const version of readdirSync(nvmBase)) {
      nvmBins.push(join(nvmBase, version, 'bin'))
    }
  } catch {
    // no nvm
  }
  return [
    // nvm first: its installs are user-writable (the /usr/local prefix is
    // root-owned on Homebrew-admin installs and fails with EACCES)
    ...nvmBins,
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/llvm/bin',
    '/usr/local/bin',
    '/usr/local/opt/llvm/bin',
    '/opt/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, 'go', 'bin'),
    join(home, 'Library', 'pnpm'),
  ]
}

/**
 * User-writable npm global prefix for panel installs: `npm --prefix <dir>
 * install -g …` lands servers here instead of a possibly root-owned global
 * prefix, and this directory is already part of the extended scan.
 */
export function npmGlobalPrefix(env = process.env, platform = process.platform) {
  const home = env.HOME ?? homedir()
  const prefix = platform === 'win32'
    ? join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')
    : join(home, '.npm-global')
  mkdirSync(prefix, { recursive: true })
  return prefix
}

/**
 * Whether a file counts as executable on `platform`: POSIX checks the execute
 * bit, Windows has none, so a regular file with an executable extension is the
 * equivalent (the extensionless file a `.cmd` shim sits next to is not what
 * CreateProcess would run).
 */
function isExecutableFile(path, platform = process.platform) {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return false
    if (platform === 'win32') return /\.(?:exe|com|bat|cmd|ps1)$/i.test(path)
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Candidate file names for a bare command in one directory: the name itself
 * on every platform, plus each PATHEXT spelling on win32 (the catalog says
 * `typescript-language-server`, the filesystem holds the `.cmd` shim).
 */
function candidatesFor(dir, command, platform, env) {
  const base = join(dir, command)
  if (platform !== 'win32') return [base]
  return [base, ...pathExtensions(env).map((extension) => `${base}${extension}`)]
}

/**
 * Whether a command string is a filesystem path rather than a bare name.
 * A backslash is a separator on Windows only, but it is never part of a bare
 * command name on POSIX either, so one check serves both dialects.
 */
function isPathLike(command) {
  return command.includes('/') || command.includes('\\')
}

/**
 * Resolve a command to an absolute executable path: the subprocess service
 * first, then the well-known directories. Returns undefined when the command
 * is nowhere to be found (callers turn that into their install hints).
 *
 * `options.platform` selects the resolution dialect and is injectable for
 * tests, mirroring `installSpecFor(entry, platform)`:
 * - PATH-LIKE ARGUMENTS are checked against the filesystem and never handed to
 *   the service resolver as a command name (`C:\bin\ls.cmd`, `C:/bin/ls`,
 *   `./ls`): on win32 that resolver searches PATH for a bare name and cannot
 *   launch a batch shim.
 * - BARE NAMES keep the service-then-scan order in both dialects, with the
 *   win32 scan probing PATHEXT.
 *
 * @param subprocess - ctx.subprocess-like service (may be absent)
 * @param command - command name or absolute path
 * @param dirs - directories to scan after the service resolver fails
 * @param options - `{ platform }`; defaults to the host platform
 */
export async function resolveExecutable(subprocess, command, dirs = extraBinDirectories(), options = {}) {
  const platform = options.platform ?? process.platform
  if (isPathLike(command)) return isExecutableFile(command, platform) ? command : undefined
  try {
    const resolved = await subprocess?.resolveExecutable(command)
    if (resolved) return resolved
  } catch {
    // fall through to the directory scan
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const candidate of candidatesFor(dir, command, platform, process.env)) {
      if (isExecutableFile(candidate, platform)) return candidate
    }
  }
  return undefined
}

/**
 * Augmented PATH string for spawned children. npm/pipx-installed servers and
 * the npm installer itself are `#!/usr/bin/env node` scripts; the scrubbed
 * child environment inherits the minimal GUI PATH, so `env node` fails with
 * exit 127. Spawn specs get `env: { PATH: augmentedPath() }` (S21 follow-up).
 */
export function augmentedPath(env = process.env, platform = process.platform) {
  const separator = platform === 'win32' ? ';' : ':'
  const existing = (env.PATH ?? '').split(separator).filter(Boolean)
  return [...new Set([...extraBinDirectories(env, platform), ...existing])].join(separator)
}
