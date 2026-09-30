// Orrery LSP service manager: profile-level admin endpoints backing the
// settings-panel management UI (per-family status + one-click install over
// the community catalog). Plain ESM, ctx-only; `connection`/`subprocess`
// resolve through ctx.get so the module mounts harmlessly in compositions
// without them (headless).
import { DEFAULT_SERVERS, displayInstallCommand, installSpecFor, languageIdsForFamily } from './registry.js'
import { npmGlobalPrefix, resolveExecutable as extendedResolveExecutable, runBounded, spawnArgv } from './child-process.js'

const name = 'orrery-lsp-admin'
const inject = []
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000
const VERSION_PROBE_TIMEOUT_MS = 8_000

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: { code: `orrery-lsp/${status === 400 ? 'invalid' : 'internal'}`, message } }, status)
}

/** Read the JSON body of a connection request (Request-like or stream). */
export async function readJsonBody(request) {
  try {
    if (typeof request?.json === 'function') return await request.json()
  } catch {
    return null
  }
  try {
    const chunks = []
    for await (const chunk of request?.body ?? []) chunks.push(Buffer.from(chunk))
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/** Accept only lines that plausibly carry a version (stack traces and
 *  paths from servers without --version support are dropped). */
export function looksLikeVersion(line) {
  if (typeof line !== 'string') return false
  if (line.length === 0 || line.length > 80) return false
  if (!/\d/.test(line)) return false
  if (line.includes('node_modules')) return false
  if (/:[0-9]+$/.test(line)) return false
  if (line.startsWith('at ') || line.startsWith('Error') || line.includes('throw new Error')) return false
  return true
}

/** First plausible version line of `<executable> <versionArgs>` within the timeout. */
export async function probeVersion(subprocess, executable, args = ['--version'], timeoutMs = VERSION_PROBE_TIMEOUT_MS) {
  if (!Array.isArray(args) || args.length === 0) return null
  // unref: false — this settle is pinned to restore the host Timeout count
  // synchronously (lsp-admin-probe.test.js); a fired unref'd timer lingers
  // in getActiveResourcesInfo past the settle microtask (Node 24).
  const { output } = await runBounded(subprocess, { argv: spawnArgv(executable, args), timeoutMs, unref: false })
  const first = output.split('\n').map((line) => line.trim()).find(looksLikeVersion)
  return first ?? null
}

/** Per-family status rows over the community catalog. */
export async function lspStatusFor(registry, subprocess, options = {}) {
  const probeTimeoutMs = options.probeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS
  const dirs = options.dirs ?? undefined
  const servers = []
  for (const [family, entry] of Object.entries(registry)) {
    let installed = false
    let version = null
    try {
      const executable = await extendedResolveExecutable(subprocess, entry.command, dirs)
      installed = Boolean(executable)
      if (executable) {
        try {
          version = await probeVersion(subprocess, executable, entry.versionArgs ?? ['--version'], probeTimeoutMs)
        } catch {
          version = null
        }
      }
    } catch {
      // unresolvable command = not installed
    }
    let installerAvailable = false
    const installerSpec = installSpecFor(entry)
    if (installerSpec) {
      try {
        installerAvailable = Boolean(await extendedResolveExecutable(subprocess, installerSpec.command, dirs))
      } catch {
        installerAvailable = false
      }
    }
    servers.push({
      family,
      languageIds: languageIdsForFamily(family),
      command: entry.command,
      installed,
      version,
      installCommand: displayInstallCommand(entry),
      installHint: entry.installHint ?? '',
      installerAvailable,
    })
  }
  return servers
}

/**
 * Run one family's install command: argv-only (no shell), output captured,
 * bounded by a timeout. Resolves `{ output, exitCode, timedOut }`; throws a
 * structured Error for unknown families, missing installers, or a missing
 * installer binary. `dirs` overrides the extra bin-directory scan (tests).
 */
export async function runInstall(registry, subprocess, family, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS, dirs = undefined) {
  const entry = registry[family]
  if (!entry) throw new Error(`lsp: unknown language family '${family}'`)
  const spec = installSpecFor(entry)
  if (!spec) throw new Error(`lsp: no installer for '${family}' on this platform — ${entry.installHint ?? 'see the install hint'}`)
  const executable = await extendedResolveExecutable(subprocess, spec.command, dirs).catch(() => undefined)
  if (!executable) throw new Error(`lsp: installer '${spec.command}' not found on PATH — install it first`)
  // npm installs pin a user-writable prefix: the resolved npm may belong to
  // a root-owned global prefix (/usr/local — EACCES on install).
  // The installer is resolved the same way servers are, so it can be a `.cmd`
  // shim too: it goes through the same launch shape (unwrapped, or cmd without
  // /s) instead of being handed to CreateProcess raw.
  const prefixArgs = spec.command === 'npm' && !(spec.args ?? []).includes('--prefix')
    ? ['--prefix', npmGlobalPrefix(), ...(spec.args ?? [])]
    : (spec.args ?? [])
  // unref: true — an install promise nothing awaits must not pin the host
  // event loop for the whole deadline window (the doc :64 contract).
  const { output, exitCode, timedOut } = await runBounded(subprocess, { argv: spawnArgv(executable, prefixArgs), timeoutMs, unref: true })
  return { output: output.slice(-8000), exitCode, timedOut }
}

/**
 * Register the LSP management endpoints on a context carrying
 * `connection`/`subprocess` (direct properties from an injected scope, or
 * resolved through ctx.get). Wired from the settings row via
 * ctx.inject(['connection', 'subprocess'], ...) — ctx.get alone does not
 * resolve these services from the settings row's scope (verified live).
 * @param options.registry - function returning the live server registry
 *   (built-in catalog merged with user `lspServers`); defaults to the
 *   community catalog.
 */
export function registerLspAdminEndpoints(ctx, options = {}) {
  const connection = ctx.connection ?? ctx.get?.('connection')
  const subprocess = ctx.subprocess ?? ctx.get?.('subprocess')
  if (!connection?.fetch?.register || !subprocess) {
    ctx.logger?.warn?.('orrery-lsp-admin: connection/subprocess unavailable — LSP management endpoints not registered')
    return () => {}
  }
  const registryProvider = typeof options.registry === 'function' ? options.registry : () => DEFAULT_SERVERS
  const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  const dirs = options.dirs ?? undefined
  const disposers = []
  disposers.push(
    connection.fetch.register({
      path: '/api/orrery-lsp/status',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const servers = await lspStatusFor(registryProvider(), subprocess, { dirs })
          return jsonResponse({ ok: true, value: { servers } })
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error), 500)
        }
      },
    }),
  )
  disposers.push(
    connection.fetch.register({
      path: '/api/orrery-lsp/install',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readJsonBody(request)
        if (!body || typeof body.family !== 'string') return errorResponse('body needs { family }')
        try {
          const result = await runInstall(registryProvider(), subprocess, body.family, installTimeoutMs, dirs)
          return jsonResponse({ ok: true, value: result })
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error), 400)
        }
      },
    }),
  )
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    disposers.forEach((dispose) => {
      if (typeof dispose === 'function') dispose()
    })
  }
}

function apply(ctx, config = {}) {
  return registerLspAdminEndpoints(ctx, config)
}

export { name, inject, apply }
