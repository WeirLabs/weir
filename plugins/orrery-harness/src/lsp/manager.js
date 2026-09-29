// LSP server lifecycle manager: one server per (workspace, language family),
// lazy start, full-document sync, idle shutdown, per-session holder refcounts.
import { existsSync, readFileSync } from 'node:fs'
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
 * npm's generated `.cmd` shim: the last interpreter invocation is
 * `"%_prog%" "%dp0%\<target>" %*` where `%dp0%` is the shim's own directory.
 */
const NPM_SHIM_INVOCATION = /"(%_prog%|[^"]*)"\s+"?(%dp0%\\[^"]+?|node_modules\\[^"]+?)"?\s+%\*/gi

/** Resolve a shim path fragment to a real path (relative ones sit beside the shim). */
function resolveShimPath(fragment, shimDirectory, join) {
  const raw = fragment.replace(/%dp0%\\?/gi, '')
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) return raw
  return join(shimDirectory, raw)
}

/**
 * Arguments `subprocess.spawn` needs to actually START a resolved executable.
 *
 * POSIX needs nothing: the resolved path is directly executable. Windows has no
 * execute bit and no shebang handling in CreateProcess, so the shapes npm and
 * friends install need an interpreter in front:
 *
 * - `.cmd` / `.bat` shims are batch files — Node's spawn rejects them outright
 *   (EINVAL). They can be run by `cmd.exe /c`, but that re-parses the command
 *   line, so a shim under a path with a space (every `%APPDATA%\npm` install in
 *   a profile with a space, `C:\Program Files\nodejs\npm.cmd`, …) or an argument
 *   carrying cmd metacharacters is a startup failure or an injection. So the npm
 *   shim is READ instead: it ends in `"%_prog%" "%dp0%\node_modules\…\cli.mjs" %*`,
 *   which is unwrapped to `node <cli> <args>` — spawnable, space-safe, no shell.
 *   A malformed or unreadable shim falls back to `cmd.exe /d /c` (NOT `/s`,
 *   which disables the quote preservation that keeps such paths working).
 * - `.ps1` shims run through powershell.exe with the execution policy bypassed
 *   (the preset ships PowerShell for exactly this host).
 * Everything else (`.exe`, `.com`) launches directly.
 *
 * `platform` is injectable, mirroring `installSpecFor(entry, platform)`;
 * `binaryPath` overrides the interpreter used to unwrap a shim.
 * @param command - resolved absolute executable path
 * @param args - server arguments from the registry definition
 * @param platform - target platform (defaults to the host)
 * @param options - `{ binaryPath, readTextFile, join }` seams for tests
 */
export function spawnArgv(command, args = [], platform = process.platform, options = {}) {
  const binaryPath = options.binaryPath ?? process.execPath
  const join = options.join ?? nodeJoin
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
    const shimDirectory = dirname(command)
    // the LAST invocation is the real one (`endLocal & goto #_undefined_# …`); the
    // earlier lines are the shim's own plumbing (dp0 lookup, PATHEXT fix-ups)
    const invocations = text === undefined ? [] : [...text.matchAll(NPM_SHIM_INVOCATION)]
    const last = invocations.at(-1)
    if (last) {
      const program = last[1]
      const target = resolveShimPath(last[2], shimDirectory, join)
      // The shim picks its interpreter at RUN time: `%dp0%\node.exe` when npm
      // shipped one beside the shim, else the bare `node` the shim resolves
      // through cmd's PATH — which the child environment here does not carry
      // (it declares only our augmented PATH). So the interpreter is chosen the
      // same way, with the running Node as the guaranteed last resort: it is
      // finally just "run this .js file with node".
      const besideShim = program === '%_prog%' || program.toLowerCase() === 'node'
      let interpreter
      if (besideShim) {
        const localNode = join(shimDirectory, 'node.exe')
        const localNodeExists = options.existsFile ? options.existsFile(localNode) : existsSync(localNode)
        interpreter = localNodeExists ? localNode : binaryPath
      } else {
        interpreter = resolveShimPath(program, shimDirectory, join)
      }
      const targetExists = options.existsFile ? options.existsFile(target) : existsSync(target)
      if (targetExists) return [interpreter, target, ...args]
    }
    // Unknown shim shape: let cmd run it. `/d` skips AutoRun, `/c` runs and exits;
    // no `/s`, so cmd keeps the quotes libuv adds around a spaced path.
    return ['cmd.exe', '/d', '/c', command, ...args]
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
