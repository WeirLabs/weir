// Weir LSP service manager: profile-level admin endpoints backing the
// settings-panel management UI (per-family status + one-click install over
// the community catalog). Plain ESM, ctx-only; `connection`/`subprocess`
// resolve through ctx.get so the module mounts harmlessly in compositions
// without them (headless).
import { buildRegistry, displayInstallCommand, installSpecFor, languageIdsForFamily, serverForPlatform } from './registry.js'
import { npmGlobalPrefix, resolveExecutable as extendedResolveExecutable, runBounded, spawnArgv } from '../process/index.js'
import { jsonResponse, readJsonBody } from '../shared/http-json.js'

const name = 'weir-lsp-admin'
const inject = []
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000
const VERSION_PROBE_TIMEOUT_MS = 8_000

export function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: { code: `weir-lsp/${status === 400 ? 'invalid' : 'internal'}`, message } }, status)
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

/**
 * Per-family status rows over the community catalog. `options.platform`
 * (default: the host) resolves each family's platform row first, so every
 * displayed value — command, version probe, install command, hint — belongs to
 * the platform being reported (D2/D5).
 */
export async function lspStatusFor(registry, subprocess, options = {}) {
  const probeTimeoutMs = options.probeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS
  const dirs = options.dirs ?? undefined
  const platform = options.platform ?? process.platform
  const servers = []
  for (const [family, entry] of Object.entries(registry)) {
    const resolved = serverForPlatform(entry, platform)
    let installed = false
    let version = null
    try {
      const executable = await extendedResolveExecutable(subprocess, resolved.command, dirs)
      installed = Boolean(executable)
      if (executable) {
        try {
          version = await probeVersion(subprocess, executable, resolved.versionArgs ?? ['--version'], probeTimeoutMs)
        } catch {
          version = null
        }
      }
    } catch {
      // unresolvable command = not installed
    }
    let installerAvailable = false
    const installerSpec = installSpecFor(resolved, platform)
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
      command: resolved.command,
      installed,
      version,
      installCommand: displayInstallCommand(resolved, platform),
      installHint: resolved.installHint ?? '',
      installerAvailable,
    })
  }
  return servers
}

/**
 * Run one family's install command: argv-only (no shell), output captured,
 * bounded by a timeout. Resolves `{ output, exitCode, timedOut }`; throws a
 * structured Error for unknown families, missing installers, or a missing
 * installer binary. `dirs` overrides the extra bin-directory scan (tests);
 * `platform` selects the family's platform row and its install spec (D2).
 */
export async function runInstall(registry, subprocess, family, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS, dirs = undefined, platform = process.platform) {
  const entry = registry[family]
  if (!entry) throw new Error(`lsp: unknown language family '${family}'`)
  const resolved = serverForPlatform(entry, platform)
  const spec = installSpecFor(resolved, platform)
  if (!spec) throw new Error(`lsp: no installer for '${family}' on this platform — ${resolved.installHint ?? 'see the install hint'}`)
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
    ctx.logger?.warn?.('weir-lsp-admin: connection/subprocess unavailable — LSP management endpoints not registered')
    return () => {}
  }
  // The catalog is platform-scoped: an absent provider builds the registry for
  // the running host (rows resolved), never the raw unresolved DEFAULT_SERVERS.
  const registryProvider = typeof options.registry === 'function' ? options.registry : () => buildRegistry()
  const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  const dirs = options.dirs ?? undefined
  const disposers = []
  disposers.push(
    connection.fetch.register({
      path: '/api/weir-lsp/status',
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
      path: '/api/weir-lsp/install',
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

/**
 * Wire the LSP management endpoints from a profile-level row that cannot add
 * package subpaths (S19: new exports need an app restart). The row calls this
 * once with a live servers getter; service resolution goes through ctx.inject
 * (S20: ctx.get does not see these services from a profile-row scope), so
 * nothing registers when the connection/subprocess pair is absent. The
 * registry stays live: user `lspServers` merge over the built-in catalog at
 * call time. Returns an idempotent disposer.
 */
export function wireLspAdmin(ctx, getServers) {
  let off = () => {}
  ctx.inject?.(['connection', 'subprocess'], (scope) => {
    const dispose = registerLspAdminEndpoints(scope, {
      registry: () => buildRegistry(getServers()),
    })
    off = dispose
    return dispose
  })
  return () => off()
}

function apply(ctx, config = {}) {
  return registerLspAdminEndpoints(ctx, config)
}

export { name, inject, apply }
