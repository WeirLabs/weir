// LSP server lifecycle manager: one server per (workspace, language family),
// lazy start, full-document sync, idle shutdown, per-session holder refcounts.
import { createLspClient, handshake, shutdownClient } from './client.js'
import { familyForLanguageId } from './registry.js'

export const LSP_DEFAULTS = {
  idleMs: 600_000,
  requestTimeoutMs: 15_000,
  diagnosticsWaitMs: 2_000,
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
  return decodeURIComponent(uri.slice('file://'.length))
}

export function createLspManager({ subprocess, fs, registry, options = {} }) {
  const opts = { ...LSP_DEFAULTS, ...options }
  /** @type {Map<string, object>} key `${cwd}:${family}` → server record */
  const servers = new Map()

  async function serverFor(family, cwd) {
    const key = `${cwd}:${family}`
    const existing = servers.get(key)
    if (existing) {
      existing.touch()
      return existing
    }
    const definition = registry[family]
    if (!definition) throw new Error(`lsp: no language server registered for '${family}'`)
    const command = await subprocess.resolveExecutable(definition.command).catch(() => undefined)
    if (!command) {
      throw new Error(`lsp: language server '${definition.command}' not found on PATH — install it first: ${definition.installHint}`)
    }
    const handle = subprocess.spawn({
      argv: [command, ...definition.args],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3_000,
    })
    const record = createServerRecord(handle, key, opts)
    servers.set(key, record)
    handle.done.then(() => servers.delete(key)).catch(() => servers.delete(key))
    record.idleTimer = setTimeout(() => void shutdownRecord(record), opts.idleMs)
    record.idleTimer.unref?.()
    await record.start(cwd)
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

  return { call, releaseSession, dispose, _servers: servers }
}
