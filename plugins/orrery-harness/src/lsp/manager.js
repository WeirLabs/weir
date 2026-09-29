// LSP server lifecycle manager: one server per (workspace, language family),
// lazy start, full-document sync, idle shutdown, per-session holder refcounts.
import { readFileSync, statSync } from 'node:fs'
import { dirname, join as nodeJoin } from 'node:path'
import { createLspClient, handshake, shutdownClient } from './client.js'
import { familyForLanguageId } from './registry.js'
import { childEnvironment } from './executable.js'

export const LSP_DEFAULTS = {
  idleMs: 600_000,
  requestTimeoutMs: 15_000,
  diagnosticsWaitMs: 2_000,
}

/** Default resolution: the subprocess service only (manager unit tests). */
function defaultResolveExecutable(subprocess) {
  return async (command) => subprocess.resolveExecutable(command)
}

/** file:// URI for an absolute path. */
export function pathToUri(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/** Absolute path back from a file:// URI. */
export function uriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return uri
  const decoded = decodeURIComponent(uri.slice('file://'.length))
  // file:///C:/ws/a.ts decodes to /C:/ws/a.ts — strip the leading slash on
  // drive-letter paths; POSIX paths (no drive-letter shape) keep theirs.
  return decoded.replace(/^\/([A-Za-z]:[\/])/, '$1')
}

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

export function createLspManager({ subprocess, fs, registry, options = {}, resolveExecutable: resolveExec = defaultResolveExecutable(subprocess) }) {
  const opts = { ...LSP_DEFAULTS, ...options }
  let currentRegistry = registry
  /** @type {Map<string, object>} key `${cwd}:${family}` → server record */
  const servers = new Map()

  async function serverFor(family, cwd) {
    const key = `${cwd}:${family}`
    const existing = servers.get(key)
    if (existing) {
      existing.touch()
      return existing
    }
    const definition = currentRegistry[family]
    if (!definition) throw new Error(`lsp: no language server registered for '${family}'`)
    const command = await resolveExec(definition.command).catch(() => undefined)
    if (!command) {
      throw new Error(`lsp: language server '${definition.command}' not found on PATH — install it first: ${definition.installHint}`)
    }
    const handle = subprocess.spawn({
      argv: spawnArgv(command, definition.args),
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3_000,
      env: childEnvironment(),
    })
    const record = createServerRecord(handle, key, opts)
    servers.set(key, record)
    handle.done.then(() => servers.delete(key)).catch(() => servers.delete(key))
    record.idleTimer = setTimeout(() => void shutdownRecord(record), opts.idleMs)
    record.idleTimer.unref?.()
    try {
      await record.start(cwd)
    } catch (error) {
      // A failed handshake must not poison the (workspace, family) key:
      // tear the record down so the next call spawns a fresh server
      // instead of reusing one whose capabilities never arrived.
      await shutdownRecord(record)
      throw error
    }
    return record
  }

  function createServerRecord(handle, key, options) {
    const diagnostics = new Map() // uri → PublishDiagnosticsParams
    const openDocs = new Map() // uri → { version }
    const holders = new Set() // session ids using this server
    const client = createLspClient({
      stdin: handle.stdin,
      stdout: handle.stdout,
      onNotification: (method, params) => {
        if (method === 'textDocument/publishDiagnostics' && params?.uri) {
          diagnostics.set(params.uri, params)
        }
      },
      timeoutMs: options.requestTimeoutMs,
    })
    const record = {
      key,
      handle,
      client,
      diagnostics,
      openDocs,
      holders,
      idleTimer: null,
      capabilities: undefined,
      async start(cwd) {
        this.capabilities = await handshake(client, pathToUri(cwd))
      },
      touch() {
        clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(() => void shutdownRecord(this), options.idleMs)
        this.idleTimer.unref?.()
      },
    }
    return record
  }

  async function shutdownRecord(record) {
    clearTimeout(record.idleTimer)
    servers.delete(record.key)
    await shutdownClient(record.client, () => record.handle?.terminate?.())
  }

  async function syncDocument(record, target, signal) {
    const uri = pathToUri(target.processPath ?? target.displayPath)
    const text = await fs.readText(target, signal)
    const version = (record.openDocs.get(uri)?.version ?? 0) + 1
    if (record.openDocs.has(uri)) {
      record.client.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      })
    } else {
      record.client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: targetLanguageId(record, target), version, text },
      })
    }
    record.openDocs.set(uri, { version })
    return uri
  }

  function targetLanguageId(record, target) {
    return record.languageId ?? 'plaintext'
  }

  /**
   * Run one LSP operation against a synced document.
   * @param {string} languageId - LSP languageId of the target file
   * @param {string} cwd - workspace root
   * @param {object} target - resolved fs target
   * @param {string} sessionId - calling session (server holder)
   * @param {(record: object, uri: string) => Promise<unknown>} fn
   */
  async function call(languageId, cwd, target, sessionId, fn, signal) {
    const family = familyForLanguageId(languageId)
    if (!family) throw new Error(`lsp: no language server family for '${languageId}'`)
    const record = await serverFor(family, cwd)
    record.languageId = languageId
    record.holders.add(sessionId)
    record.touch()
    const uri = await syncDocument(record, target, signal)
    return fn(record, uri)
  }

  /** Release every server hold of one session; empty servers shut down. */
  async function releaseSession(sessionId) {
    for (const record of [...servers.values()]) {
      if (!record.holders.delete(sessionId)) continue
      if (record.holders.size === 0) await shutdownRecord(record)
    }
  }

  /** Terminate all servers (plugin unload). */
  async function dispose() {
    for (const record of [...servers.values()]) await shutdownRecord(record)
    servers.clear()
  }

  /** Merge tuning values in place: new values apply to later operations and new servers. */
  function setOptions(partial = {}) {
    Object.assign(opts, partial)
  }

  /** Swap the server registry in place: later operations resolve from it. */
  function setRegistry(next) {
    currentRegistry = next
  }

  return { call, releaseSession, dispose, setOptions, setRegistry, _servers: servers }
}
