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
// Renamed-and-expanded from executable.js (design D1): one concept, three stages — resolve → launch shape → bounded run.
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, join as nodeJoin } from 'node:path'

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
 * exit 127. Spawn specs get `env: childEnvironment()` (S21 follow-up).
 */
export function augmentedPath(env = process.env, platform = process.platform) {
  const separator = platform === 'win32' ? ';' : ':'
  const existing = (env.PATH ?? '').split(separator).filter(Boolean)
  return [...new Set([...extraBinDirectories(env, platform), ...existing])].join(separator)
}

/**
 * The environment every spawned server / installer / probe gets. PATH is the
 * point of it; on Windows `SystemRoot` and `ComSpec` ride along because the
 * launch shape may hand the command to `cmd.exe`, which needs both (and the
 * scrubbed child environment otherwise has neither).
 */
export function childEnvironment(env = process.env, platform = process.platform) {
  const child = { PATH: augmentedPath(env, platform) }
  if (platform === 'win32') {
    if (env.SystemRoot) child.SystemRoot = env.SystemRoot
    if (env.ComSpec) child.ComSpec = env.ComSpec
  }
  return child
}

// ─── Stage 2 of 3: launch shape — win32 shim unwrapping machinery, moved verbatim from manager.js (the doc comments below are incident archives; do not rewrite). ───

/**
 * An interpreter invocation inside a generated `.cmd` shim: the last line that
 * forwards its arguments with `%*`. The generators this integration targets —
 * npm's bin linker (both its older `"%_prog%"` template and its own
 * `"%NODE_EXE%" "%NPM_CLI_JS%"` shim) and corepack's `%~dp0` template — put the
 * target immediately before `%*`. npm also writes the LITERAL two characters
 * `\"` around its tokens, which is why a quote-shaped match silently missed that
 * family and dropped it to the shell fallback; the shape is therefore located by
 * this marker and tokenized positionally (see `lastShimInvocation`).
 *
 * Do NOT reintroduce an extension requirement on the target here: npm emits
 * extensionless targets for packages whose bin script is spelled that way
 * (`…\typescript\bin\tsc`, `…\vscode-langservers-extracted\bin\vscode-json-language-server`).
 */
const SHIM_FORWARD = /%\*\s*$/

/**
 * A shim is only safe to hand to a shell if NEITHER the shim path NOR any
 * argument can be re-parsed by cmd. `cmd.exe /c` re-reads its command line, and
 * more than two quotes (a spaced path plus a spaced argument) or a metacharacter
 * inside the quoted text makes it strip the quotes — which is how
 * `C:\Program Files\nodejs\npm.cmd --prefix "C:\Users\John Smith\…"` dies with
 * `'C:\Program' is not recognized`. So the shell path fails closed instead.
 */
const CMD_UNSAFE = /[\s&<>()@^|"%]/

/**
 * Expand the shim's own directory spellings (`%~dp0`, `%dp0%`) to that
 * directory. cmd's `%~dp0` carries a trailing separator and `%dp0%` does not,
 * so the separator is taken from what FOLLOWS the token — testing the fragment
 * as a whole gets this wrong whenever a later backslash appears
 * (`%~dp0\node_modules\…`).
 */
function expandDp0(fragment, shimDirectory) {
  // two spellings, matched explicitly: `%~?dp0%?` would read `%dp0%` as `%d` + `p0%`
  return fragment.replace(/%~dp0([\\/]?)|%dp0%([\\/]?)/gi, (_whole, tildeSep, plainSep) => {
    const separator = tildeSep || plainSep
    return separator ? `${shimDirectory}${separator}` : shimDirectory
  })
}

/** Resolve a shim path fragment against the shim's directory (absolute ones pass through). */
function resolveShimPath(fragment, shimDirectory, join) {
  const raw = expandDp0(fragment, shimDirectory)
  if (/^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw)) return raw
  return join(shimDirectory, raw.replace(/^[\\/]+/, ''))
}

/**
 * The best value a shim assigns to a variable. A generated shim assigns the same
 * name more than once (npm does: `NPM_CLI_JS` is set to its own path, to a
 * `FOR`-loop artifact `%%F\…`, and back through a variable), and only some of
 * those are resolvable at LAUNCH. So candidates are ranked: a literal path
 * beats a chain through another variable, and a `%%`-prefixed value — an
 * unexpanded FOR-loop variable — is never usable.
 */
function bestShimValue(name, text) {
  const pattern = new RegExp(`SET\\s+"?%?${name}%?=([^"\\r\\n]+)`, 'gi')
  const candidates = [...text.matchAll(pattern)]
    .map((match) => match[1].trim())
    .filter((value) => value.length > 0 && !value.includes('%%'))
  if (candidates.length === 0) return undefined
  const literal = candidates.find((value) => value.includes('%~dp0') || /^[A-Za-z]:[\\/]/.test(value))
  return literal ?? candidates[0]
}

/**
 * Expand the `%VAR%` / `%~dp0` spellings the shim itself defines. npm's own
 * shim chains them (`NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%`, which is built from
 * `%~dp0`), so the substitution iterates to a fixed point; an unresolvable token
 * stays literal and the caller treats the shim as not understood.
 */
function expandShimToken(token, text, shimDirectory, join) {
  let out = token
  for (let pass = 0; pass < 6; pass++) {
    const before = out
    // A shim directory arrives either way round: literal in the invocation
    // (`%~dp0\node_modules\…`) or via a variable the substitution just pulled in
    // (`NPM_CLI_JS=%~dp0\node_modules\…`), so both passes run per iteration.
    out = expandDp0(out, shimDirectory).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
      const value = bestShimValue(name, text)
      return value ?? whole
    })
    if (out === before) break
  }
  return out
}

/**
 * How a shim's forward line is read — shared by `tokenizeShimLine` and
 * `lastShimInvocation` right below.
 *
 * Quotes cannot simply be replaced by spaces: a quoted path may CONTAIN a space
 * (`"C:\Program Files\node.exe"`), and flattening it would split one token into
 * two and shift the positional rule. npm's literal two-character spelling `\"`
 * counts as a quote as well, while a LONE backslash is a path separator that
 * must survive for the variable pass.
 *
 * The target is the token immediately before `%*`, which is where the generators
 * this integration targets put it (`"%NODE_EXE%" "%NPM_CLI_JS%" %*`,
 * `"%~dp0\node.exe" "%~dp0\…\pnpm.js" %*`, `"%_prog%" "%dp0%\…\cli.mjs" %*`).
 * It is NOT identified by extension: npm's bin linker emits extensionless
 * targets for any package whose bin script is spelled that way, so `…\bin\tsc`
 * and `…\bin\vscode-json-language-server` are ordinary targets here.
 *
 * Known limit: corepack's generator can emit `${progArgs}%*`, which puts a flag
 * where the target is expected. No catalog server is corepack-installed today,
 * and that mis-read fails closed — the token resolves to nothing, so the shim is
 * refused or falls back instead of launching the wrong thing.
 */
function tokenizeShimLine(line) {
  const tokens = []
  let current = ''
  let quote = null
  let escaped = false
  for (const character of line) {
    if (escaped) {
      if (character === '"') current += '"'
      else current += `\\${character}`
      escaped = false
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"') {
      quote = '"'
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (/\s/.test(character)) {
      if (current.length > 0) tokens.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (escaped) current += '\\'
  if (current.length > 0) tokens.push(current)
  return tokens
}

/**
 * The last `%*` forward in a shim, as `{ program, target }`: the two tokens
 * immediately before the trailing `%*`.
 */
function lastShimInvocation(text) {
  if (typeof text !== 'string') return null
  const lines = text.split(/\r?\n/).filter((line) => SHIM_FORWARD.test(line))
  const line = lines.at(-1)
  if (!line) return null
  const tokens = tokenizeShimLine(line)
  if (tokens.length < 3) return null
  return { program: tokens[tokens.length - 3], target: tokens[tokens.length - 2] }
}

/** True when a value carries nothing cmd would re-parse. */
function shellSafe(value) {
  return value.length > 0 && !CMD_UNSAFE.test(value)
}

/**
 * Arguments `subprocess.spawn` needs to actually START a resolved executable.
 *
 * POSIX needs nothing: the resolved path is directly executable. Windows has no
 * execute bit and no shebang handling in CreateProcess, so the shapes npm and
 * friends install need an interpreter in front:
 *
 * - `.cmd` / `.bat` shims are batch files — Node's spawn rejects them outright
 *   (EINVAL). `cmd.exe /c` can run one, but it RE-PARSES its command line, and
 *   cmd's quote preservation only survives the simple case: a spaced path plus
 *   a spaced argument (four quotes) or a metacharacter inside the quoted text
 *   makes it strip the quotes, reproducing `'C:\Program' is not recognized` for
 *   `C:\Program Files\nodejs\npm.cmd --prefix "C:\Users\John Smith\…"`, and
 *   letting an `&` in an argument be read as a command separator. So the shim is
 *   READ instead: its last interpreter invocation is unwrapped to
 *   `[interpreter, target, ...args]`, which spawns directly and is inert to
 *   spaces and metacharacters.
 * - A shim that cannot be unwrapped falls back to `cmd.exe /d /c` — never `/s`
 *   — and only when the resolved paths and arguments are provably free of
 *   spaces, quotes and cmd metacharacters. Otherwise it refuses loudly: failing
 *   closed beats silently mangling a path or executing an injected command.
 * - `.ps1` shims run through powershell.exe with the execution policy bypassed
 *   (the preset ships PowerShell for exactly this host).
 * Everything else (`.exe`, `.com`) launches directly.
 *
 * `platform` is injectable, mirroring `installSpecFor(entry, platform)`;
 * `binaryPath` overrides the interpreter used to unwrap a shim.
 * @param command - resolved absolute executable path
 * @param args - server arguments from the registry definition
 * @param platform - target platform (defaults to the host)
 * @param options - `{ binaryPath, readTextFile, existsFile, join, dirname }` seams for tests
 */
export function spawnArgv(command, args = [], platform = process.platform, options = {}) {
  const binaryPath = options.binaryPath ?? process.execPath
  const join = options.join ?? nodeJoin
  // `dirname` is host-shaped on POSIX and drive-shaped on Windows, so it is a
  // seam beside `join`: the win32 shim corpus drives BOTH to read a Windows
  // command string identically on either host.
  const dirnameOf = options.dirname ?? dirname
  // a DIRECTORY must not qualify: the unwrap is accepted on this check alone
  const existsFile = options.existsFile ?? ((path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })
  if (platform !== 'win32') return [command, ...args]
  if (/\.ps1$/i.test(command)) {
    return ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args]
  }
  if (/\.(?:cmd|bat)$/i.test(command)) {
    let text
    try {
      text = options.readTextFile ? options.readTextFile(command) : readFileSync(command, 'utf8')
    } catch {
      text = undefined
    }
    const shimDirectory = dirnameOf(command)
    // the LAST line that forwards to a script is the real invocation
    // (`endLocal & goto #_undefined_# …`); earlier lines are shim plumbing
    const invocation = lastShimInvocation(text)
    if (invocation) {
      const program = expandShimToken(invocation.program, text, shimDirectory, join)
      // the expansion already produced an absolute path (`%~dp0` is expanded to
      // the shim directory), so only stray separators are collapsed here
      const target = expandShimToken(invocation.target, text, shimDirectory, join).replace(/([^:\\/])[\\/]{2,}/g, '$1\\')
      // The shim picks its interpreter at run time: one beside the shim when npm
      // shipped it, else the bare `node` it resolves through cmd's PATH — which
      // the declared child environment does not carry. So the running Node (or a
      // local one) stands in: it is finally just "run this script with node".
      // `%_prog%` is the older npm template's own variable for exactly that
      // choice, and it is NOT a path: expanding it would have to know whether
      // `<shim>\node.exe` exists, which is the same question answered here.
      const programIsNode = /^(?:node|node\.exe|%_prog%)$/i.test(program) || /node\.exe$/i.test(program)
      let interpreter = null
      if (programIsNode) {
        const localNode = join(shimDirectory, 'node.exe')
        interpreter = existsFile(localNode) ? localNode : binaryPath
      } else {
        const resolved = resolveShimPath(program, shimDirectory, join)
        interpreter = existsFile(resolved) ? resolved : null
      }
      // an unresolvable token means the shim shape is not one we understand
      const usable = interpreter && existsFile(target)
      if (usable) return [interpreter, target, ...args]
    }
    if (shellSafe(command) && args.every(shellSafe)) {
      // Unknown shim, but nothing here can be re-parsed: let cmd run it.
      return ['cmd.exe', '/d', '/c', command, ...args]
    }
    throw new Error(
      `lsp: cannot start '${command}' on Windows — its .cmd shim could not be unwrapped and the path or an argument contains characters cmd.exe would re-parse. ` +
        `Install the server as a plain .exe, or point lspServers at its node entry point.`,
    )
  }
  return [command, ...args]
}

// ─── Stage 3 of 3: bounded run — the shared spawn-to-completion skeleton of probeVersion/runInstall (design D3). ───

/**
 * Spawn argv to completion under a deadline: accumulate merged stdout+stderr,
 * race the child's `done` against the deadline, release the timer on every
 * settle path, terminate best-effort on timeout, and propagate spawn/child
 * failures as rejections as-is. stdio/cwd/graceMs/env are fixed inside
 * (identical at both call sites — env is this module's own childEnvironment());
 * result shaping (output tail-slicing, version-line picking) stays with the
 * calling adapter.
 *
 * `unref` decides whether the ARMED deadline may pin the host event loop.
 * The install path unrefs (its promise can go unawaited for the whole
 * ten-minute window — the doc contract). The probe path must NOT: its settle
 * is pinned to return the host's Timeout count to baseline synchronously
 * (lsp-admin-probe.test.js), and a fired unref'd timer still lingers in
 * getActiveResourcesInfo past the settle microtask (Node 24, verified).
 * @param subprocess - ctx.subprocess-like service
 * @param options - `{ argv, timeoutMs, unref }`: launch-shaped argv, the
 *   deadline, and whether the armed deadline is unref'd (default false)
 * @returns {Promise<{ output: string, exitCode: number|null, timedOut: boolean }>}
 */
export async function runBounded(subprocess, { argv, timeoutMs, unref = false }) {
  const handle = subprocess.spawn({
    argv,
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3_000,
    env: childEnvironment(),
  })
  let output = ''
  handle.stdout?.on('data', (chunk) => {
    output += chunk.toString()
  })
  handle.stderr?.on('data', (chunk) => {
    output += chunk.toString()
  })
  let timedOut = false
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      try {
        handle.terminate?.()
      } catch {
        // termination is best-effort
      }
      // Release the timer that fired: an armed 8s timeout would otherwise keep
      // the host process alive long after the probe settled (observed as a
      // `node --test` run that printed its summary and never exited).
      clearTimeout(timer)
      resolve()
    }, timeoutMs)
    // The deadline exists to bound a silent installer, never to keep the host
    // process alive: an install promise nothing awaits (the HTTP handler already
    // answered, or the caller gave up) would otherwise pin an event loop — and a
    // `node --test` suite — for the whole window (ten minutes by default).
    if (unref) timer.unref?.()
  })
  try {
    await Promise.race([handle.done, deadline])
  } finally {
    // Both settle paths release the probe window. The rejection path is the one
    // that matters: a launch failure (spawn EINVAL — routine on Windows before
    // shim unwrapping) throws out of the race, and the previously-armed 8s timer
    // then kept the host process (and every `node --test` run) alive until it
    // fired. Measured: 4ms of work, 8007ms of process lifetime.
    clearTimeout(timer)
  }
  // exitCode normalization unified here: the settled value may carry the code
  // on a record or BE a bare code; a timeout or an unreadable value is null.
  let exitCode = null
  if (!timedOut) {
    try {
      const value = await handle.done
      exitCode = value?.exitCode ?? (typeof value === 'number' ? value : null)
    } catch {
      exitCode = null
    }
  }
  return { output, exitCode, timedOut }
}
