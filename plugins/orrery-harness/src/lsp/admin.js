// Orrery LSP service manager: profile-level admin endpoints backing the
// settings-panel management UI (per-family status + one-click install over
// the community catalog). Plain ESM, ctx-only; `connection`/`subprocess`
// resolve through ctx.get so the module mounts harmlessly in compositions
// without them (headless).
import { DEFAULT_SERVERS, displayInstallCommand, installSpecFor, languageIdsForFamily } from './registry.js'

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

/** First output line of `<executable> <versionArgs>` within the timeout. */
export async function probeVersion(subprocess, executable, args = ['--version'], timeoutMs = VERSION_PROBE_TIMEOUT_MS) {
  const handle = subprocess.spawn({
    argv: [executable, ...args],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3_000,
  })
  let output = ''
  let timer
  const done = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        handle.terminate?.()
      } catch {
        // termination is best-effort
      }
      resolve(null)
    }, timeoutMs)
  })
  handle.stdout?.on('data', (chunk) => {
    output += chunk.toString()
  })
  handle.stderr?.on('data', (chunk) => {
    output += chunk.toString()
  })
  await Promise.race([handle.done, done])
  clearTimeout(timer)
  const first = output.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  return first ?? null
}

/** Per-family status rows over the community catalog. */
export async function lspStatusFor(registry, subprocess, options = {}) {
  const probeTimeoutMs = options.probeTimeoutMs ?? VERSION_PROBE_TIMEOUT_MS
  const servers = []
  for (const [family, entry] of Object.entries(registry)) {
    let installed = false
    let version = null
    try {
      const executable = await subprocess.resolveExecutable(entry.command)
      installed = true
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
    servers.push({
      family,
      languageIds: languageIdsForFamily(family),
      command: entry.command,
      installed,
      version,
      installCommand: displayInstallCommand(entry),
      installHint: entry.installHint ?? '',
    })
  }
  return servers
}

/**
 * Run one family's install command: argv-only (no shell), output captured,
 * bounded by a timeout. Resolves `{ output, exitCode, timedOut }`; throws a
 * structured Error for unknown families, missing installers, or a missing
 * installer binary.
 */
export async function runInstall(registry, subprocess, family, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS) {
  const entry = registry[family]
  if (!entry) throw new Error(`lsp: unknown language family '${family}'`)
  const spec = installSpecFor(entry)
  if (!spec) throw new Error(`lsp: no installer for '${family}' on this platform — ${entry.installHint ?? 'see the install hint'}`)
  const executable = await subprocess.resolveExecutable(spec.command).catch(() => undefined)
  if (!executable) throw new Error(`lsp: installer '${spec.command}' not found on PATH — install it first`)
  const handle = subprocess.spawn({
    argv: [executable, ...(spec.args ?? [])],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3_000,
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
      resolve()
    }, timeoutMs)
  })
  await Promise.race([handle.done, deadline])
  clearTimeout(timer)
  if (timedOut) {
    try {
      handle.terminate?.()
    } catch {
      // termination is best-effort
    }
  }
  let exitCode = null
  if (!timedOut) {
    try {
      const value = await handle.done
      exitCode = value?.exitCode ?? (typeof value === 'number' ? value : null)
    } catch {
      exitCode = null
    }
  }
  return { output: output.slice(-8000), exitCode, timedOut }
}

function apply(ctx, config = {}) {
  const connection = ctx.get?.('connection')
  const subprocess = ctx.get?.('subprocess')
  if (!connection?.fetch?.register || !subprocess) {
    ctx.logger?.warn?.('orrery-lsp-admin: connection/subprocess unavailable — LSP management endpoints not registered')
    return
  }
  // The panel manages the built-in community catalog; user `lsp.servers`
  // overlays live in the lsp module row config (documented).
  const registry = DEFAULT_SERVERS
  const disposers = []
  disposers.push(
    connection.fetch.register({
      path: '/api/orrery-lsp/status',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const servers = await lspStatusFor(registry, subprocess)
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
          const result = await runInstall(registry, subprocess, body.family, config.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS)
          return jsonResponse({ ok: true, value: result })
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error), 400)
        }
      },
    }),
  )
  return () => disposers.forEach((dispose) => dispose?.())
}

export { name, inject, apply }
