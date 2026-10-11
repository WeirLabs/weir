#!/usr/bin/env node
// Cross-platform dual-GUI Edit Lock acceptance driver (dev-only QA tooling).
//
// Boots TWO genuinely independent `dsh web` processes (separate DSH_HOME,
// profile, loopback web port and dedicated headless-Chrome CDP port each)
// against ONE shared disposable workspace outside any git repository, then
// drives the real browser UI over CDP and the authenticated in-page gateway
// to run the Edit Lock acceptance matrix:
//
//   core (default):
//     boot x2 -> role detection (publisher/client + reservation owner PID)
//     -> live cross-process duplicate refusal (real Retry click refused)
//     -> real edit_lock_acquire conflict (file bytes unchanged)
//     -> generation handoff (release -> next generation acquire)
//     -> graceful teardown (ports closed, reservation naturally absent)
//   heavy (DUAL_GUI_MATRIX=heavy or --heavy), adds:
//     -> nested client GUI under the same management root: real version/CAS
//        and fs sandbox-backend refusals, byte/authority deltas and screenshots
//     -> SIGKILL the verified publisher PID (owner.json checked first)
//     -> surviving client fail-closed (view unavailable, no authority gain)
//     -> restart same profile: reservation reclaimed, generation retained,
//        real Continue editing click restores the same session
//     -> old client rebinds stopped, still denied until release -> gen N+1
//     -> panel-states: real-browser presentation acceptance, each state in
//        dark AND light theme with DOM marker assertions and a zero-console-
//        exception gate per phase:
//        attention/abnormal (a genuine provider-error turn while holding a
//        lock), recovering (the cleanup-only driver's first real attempt),
//        paused (real edit_lock_pause, absolute deadline rendered), and
//        partial-write (real lsp_rename batch with the shipped writeText
//        midbatch-fault probe: written/not-written/uncertain + retained
//        locks). Theme flips ride the GUI's system-preference sensing via
//        CDP Emulation.setEmulatedMedia, proven by body[data-ds-dark-theme].
//
//   opt-out (--opt-out), runs heavy unchanged, then saves off in the RUNNING
//     enabled processes, restarts both real Web processes into effective-off,
//     proves ordinary managed write/hash_edit against retained old owner and
//     unresolved publication without changing authority bytes, screenshots
//     warning + maintenance in both themes, then re-enables and denies again.
//
// Hard invariants (learned from .weir/qa/stable-dual-gui, do not relax):
//   * managementRootFor(workspace) === realpath(workspace) before any boot;
//     a workspace inside a git checkout silently binds to the repo's own
//     authority and the whole run is a false isolation.
//   * The publisher reservation (.weir/.edit-lock.publisher-reservation) is
//     NEVER deleted by this driver — teardown only ASSERTS its absence after
//     a graceful stop.
//   * Launch tokens/cookies live only in process memory: every byte written
//     to a log file, the report, or stdout passes through the sanitizer.
//   * The QA command fixture only ever installs into the throwaway profiles
//     created under the QA root (it self-refuses otherwise).
//   * Roles are read from the reservation owner document and the live views,
//     never inferred from boot order or port numbers.
//
// Usage:
//   node plugins/weir-test-harness/src/dual-gui-qa.mjs run [--heavy | --opt-out] [--root <dir>] [--keep]
//
// Environment:
//   DUAL_GUI_DSH_EXEC   self-contained CLI launcher (macOS app runtime/cli/bin/dsh)
//   DUAL_GUI_DSH_BIN    path to @deepseek-ai/dsh/lib/bin.js (spawned with node;
//                       the CI/Windows route — no .cmd shims)
//   DUAL_GUI_NODE       node binary for DSH_BIN (default: bundled runtime node,
//                       else process.execPath)
//   DUAL_GUI_CHROME     Chrome/Chromium binary (default: per-platform candidates)
//   DUAL_GUI_WEIR       weir-harness checkout to link-install (default: sibling
//                       of this package)
//   DUAL_GUI_ROOT       QA root (default: fresh mkdtemp under os.tmpdir())
//   DUAL_GUI_MATRIX     'core' (default) | 'heavy' | 'opt-out'
//   DUAL_GUI_KEEP       '1' keeps the QA root even after a green run
//
// Exit code: 0 iff every executed matrix row is PASS and teardown is clean.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTHORITY_DIR, managementRootFor } from '../../weir-harness/src/edit-lock/domains.js'
import { endpointFor } from '../../weir-harness/src/edit-lock/remote.js'
import { RESERVATION_LEASE_MS } from '../../weir-harness/src/edit-lock/reservation.js'
import { anchorFor } from '../../weir-harness/src/hashline-edit/anchors.js'
import { inspectAuthority } from '../../weir-harness/src/edit-lock/maintenance.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.join(HERE, '..')
const REPO_ROOT = path.join(PACKAGE_ROOT, '..', '..')

// ---------------------------------------------------------------------------
// Pure, individually testable core
// ---------------------------------------------------------------------------

/** Replace every secret occurrence so no token ever reaches a log, report or
 * stdout. Non-string input is JSON-rendered first (CDP values are objects). */
export function sanitizeText(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (typeof text !== 'string') text = String(text)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('REDACTED_TOKEN')
  }
  return text
}

/** Extract the launch URL and one-time token from `dsh web` stdout. The token
 * never appears in the thrown error. */
export function parseLaunchUrl(logText) {
  const match = /dsh web: (http:\/\/\S+)/.exec(typeof logText === 'string' ? logText : '')
  if (!match) throw new Error('launch URL not found in server output (expected a "dsh web: <url>" line)')
  const url = match[1]
  return { url, token: new URL(url).searchParams.get('token') ?? '' }
}

/** Join paths for the TARGET platform (the driver can be configured for a
 * win32/linux runner from any host during tests and CI templating). */
const joinFor = (platform) => (platform === 'win32' ? path.win32.join : path.posix.join)

/** The user's home directory on the target platform; overridable through the
 * usual env vars so CI runners with custom layouts stay reachable. */
function homeFor(platform, env) {
  if (platform === 'win32') return env.USERPROFILE ?? os.homedir()
  return env.HOME ?? os.homedir()
}
/** Default node binary used to run a lib/bin.js style CLI entry. */
export function resolveNodeBinary({ env = process.env, platform = process.platform, fileExists = fs.existsSync } = {}) {
  if (env.DUAL_GUI_NODE && fileExists(env.DUAL_GUI_NODE)) return env.DUAL_GUI_NODE
  const join = joinFor(platform)
  const bundled = platform === 'win32'
    ? join(homeFor(platform, env), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    : join(homeFor(platform, env), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node')
  if (fileExists(bundled)) return bundled
  return process.execPath
}

/** Resolve how to spawn the DSH CLI cross-platform. Windows/CI run
 * `node lib/bin.js` directly — never a .cmd shim (spawn cannot run them
 * without a shell). Returns { command, prefixArgs, description }. */
export function resolveDshInvocation({ env = process.env, platform = process.platform, fileExists = fs.existsSync } = {}) {
  const tried = []
  const asBin = (bin) => ({ command: resolveNodeBinary({ env, platform, fileExists }), prefixArgs: [bin], description: `node ${bin}` })
  if (env.DUAL_GUI_DSH_EXEC) {
    if (!fileExists(env.DUAL_GUI_DSH_EXEC)) throw new Error(`DUAL_GUI_DSH_EXEC not found: ${env.DUAL_GUI_DSH_EXEC}`)
    if (env.DUAL_GUI_DSH_EXEC.endsWith('.js')) return asBin(env.DUAL_GUI_DSH_EXEC)
    return { command: env.DUAL_GUI_DSH_EXEC, prefixArgs: [], description: env.DUAL_GUI_DSH_EXEC }
  }
  if (env.DUAL_GUI_DSH_BIN) {
    if (!fileExists(env.DUAL_GUI_DSH_BIN)) throw new Error(`DUAL_GUI_DSH_BIN not found: ${env.DUAL_GUI_DSH_BIN}`)
    return asBin(env.DUAL_GUI_DSH_BIN)
  }
  const candidates = []
  if (platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
    candidates.push(joinFor(platform)(homeFor(platform, env), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'))
  } else if (platform === 'win32') {
    const appData = env.APPDATA ?? path.win32.join(homeFor(platform, env), 'AppData', 'Roaming')
    candidates.push(path.win32.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  } else {
    candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
    candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
    candidates.push(joinFor(platform)(homeFor(platform, env), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  for (const candidate of candidates) {
    tried.push(candidate)
    if (fileExists(candidate)) return candidate.endsWith('.js') ? asBin(candidate) : { command: candidate, prefixArgs: [], description: candidate }
  }
  throw new Error(`no DSH CLI found; set DUAL_GUI_DSH_EXEC or DUAL_GUI_DSH_BIN (tried: ${tried.join(', ')})`)
}

/** Locate a Chrome/Chromium binary for the CDP browsers. */
export function resolveChromePath({ env = process.env, platform = process.platform, fileExists = fs.existsSync } = {}) {
  if (env.DUAL_GUI_CHROME) {
    if (!fileExists(env.DUAL_GUI_CHROME)) throw new Error(`DUAL_GUI_CHROME not found: ${env.DUAL_GUI_CHROME}`)
    return env.DUAL_GUI_CHROME
  }
  const candidates = []
  if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else if (platform === 'win32') {
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files'
    const pfx86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = env.LOCALAPPDATA ?? path.win32.join(homeFor(platform, env), 'AppData', 'Local')
    candidates.push(path.win32.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    candidates.push(path.win32.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    candidates.push(path.win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    candidates.push(path.win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
  }
  for (const candidate of candidates) if (fileExists(candidate)) return candidate
  throw new Error(`no Chrome/Chromium found; set DUAL_GUI_CHROME (tried: ${candidates.join(', ')})`)
}

/** Argument vector for one `dsh web` server instance. The profile was
 * initialized from the shipped web template, so the profile IS the app:
 * `dsh --profile <name> --host ... --port ... --no-open` (a `web` positional
 * is rejected with "too many arguments"). Never carries tokens. */
export function buildServerArgs({ profile, patches = [], host = '127.0.0.1', port, prefixArgs = [] }) {
  return [...prefixArgs, '--profile', profile, ...patches.flatMap((p) => ['--patch', p]), '--host', host, '--port', String(port), '--no-open']
}

/** Argument vector for one headless Chrome instance with its own profile dir. */
export function buildChromeArgs({ cdpPort, userDataDir, headless = true, url = 'about:blank' }) {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
  ]
  if (headless) args.push('--headless=new')
  args.push(url)
  return args
}

/** `dsh plugin add` argument vector (link-installs a bundle into a profile). */
export function buildPluginAddArgs({ profile, packageDir, prefixArgs = [] }) {
  return [...prefixArgs, 'plugin', '--profile', profile, 'add', packageDir]
}

/** Argument vector that initializes a profile from the shipped web template. */
export function buildProfileInitArgs({ profile, prefixArgs = [] }) {
  return [...prefixArgs, '--profile', profile, '--from-default-profile', 'web', '--dump-config']
}

/** Allocate `count` currently-free loopback ports. Callers must tolerate the
 * inherent TOCTOU race; a losing boot fails loudly on the readiness wait. */
export async function allocateFreePorts(count, { host = '127.0.0.1' } = {}) {
  const servers = []
  try {
    for (let i = 0; i < count; i += 1) {
      const server = net.createServer()
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, host, resolve)
      })
      servers.push(server)
    }
    return servers.map((server) => server.address().port)
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))))
  }
}

/** True when something accepts TCP on 127.0.0.1:port. */
export function isPortListening(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (value) => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** Poll until the port refuses connections; false on timeout. */
export async function waitForPortClosed(port, { timeoutMs = 30000, intervalMs = 250, host = '127.0.0.1' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isPortListening(port, { host }))) return true
    await sleep(intervalMs)
  }
  return !(await isPortListening(port, { host }))
}

/** Generic predicate poll; returns the last truthy value or throws. */
export async function waitFor(label, probe, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try { last = await probe() } catch (error) { last = undefined }
    if (last) return last
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`)
    await sleep(intervalMs)
  }
}

/** Read the publisher reservation owner document for a management root.
 * Returns null when no reservation exists; throws on corrupt owner.json so a
 * torn write can never masquerade as "no publisher". */
export function readReservationOwner(root, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const dir = path.join(root, '.weir', '.edit-lock.publisher-reservation')
  if (!exists(dir)) return null
  const ownerFile = path.join(dir, 'owner.json')
  if (!exists(ownerFile)) return null
  const text = readFile(ownerFile, 'utf8')
  let doc
  try { doc = JSON.parse(text) } catch { throw new Error(`reservation owner document is corrupt: ${ownerFile}`) }
  if (!doc || typeof doc !== 'object' || !Number.isSafeInteger(doc.pid)) {
    throw new Error(`reservation owner document has no integer pid: ${ownerFile}`)
  }
  return doc
}

/** sha256 hex of one file — the byte-integrity witness for the whole matrix. */
export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Compare durable authority, not a fabricated view, around one dispatched refusal. */
export function authorityState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, AUTHORITY_DIR, 'snapshot.json'), 'utf8')).payload.state
}
export function assertRefusalDelta({ before, after, target, sessionId, cwd, beforeBytes }) {
  if (!fs.readFileSync(target).equals(beforeBytes)) throw new Error(`refusal changed target bytes: ${target}`)
  if (after.operations.length !== before.operations.length + 1 ||
      JSON.stringify(after.operations.slice(0, -1)) !== JSON.stringify(before.operations)) throw new Error('refusal did not append exactly one operation without changing history')
  const op = after.operations.at(-1)
  if (op.phase !== 'unknown' || op.fence?.kind !== 'resource' || op.fence.resourceId !== target || op.binding?.cwd !== cwd || op.sessionId !== sessionId) {
    throw new Error(`refusal was not a dispatched unknown/resource fence in the nested session: ${JSON.stringify(op)}`)
  }
  const lock = after.locks.find((row) => row.resourceId === target && row.owner === sessionId)
  const previous = before.locks.find((row) => row.resourceId === target)
  if (!lock || !Number.isSafeInteger(lock.generation) ||
      (previous && (previous.owner !== sessionId || previous.generation !== lock.generation)) ||
      !before.locks.filter((row) => row.resourceId !== target).every((row) => after.locks.some((next) => JSON.stringify(next) === JSON.stringify(row)))) {
    throw new Error(`refusal did not retain ownership and previous locks: ${JSON.stringify(after.locks)}`)
  }
  return { generation: lock.generation }
}

/** Assert the platform's real Edit Lock endpoint; no tmpdir-name guessing. */
export function assertEndpoint(authorityDir, platform = process.platform, resolve = endpointFor) {
  const endpoint = resolve(authorityDir, platform)
  if (platform === 'win32') {
    if (!/^\\\\\.\\pipe\\weir-edit-lock-[a-f0-9]{24}$/.test(endpoint)) throw new Error(`expected win32 named pipe, got ${endpoint}`)
  } else if (!endpoint.endsWith('.sock') || !path.basename(endpoint).match(/^weir-edit-lock-[a-f0-9]{24}\.sock$/) || Buffer.byteLength(endpoint) > 100) {
    throw new Error(`expected short Unix socket, got ${endpoint}`)
  }
  return endpoint
}

const PANEL_SHOTS = ['attention', 'recovering', 'paused', 'partial-write'].flatMap((state) => ['dark', 'light'].map((theme) => `panel-${state}-${theme}`))
const OPT_OUT_SHOTS = ['saved-off', 'effective-off'].flatMap((state) => ['dark', 'light'].map((theme) => `opt-out-${state}-${theme}`))
/** Verify all eight independently captured panel images, never just a directory. */
export function verifyPanelShots(shotsDir, names = PANEL_SHOTS) {
  return names.map((name) => {
    const file = path.join(shotsDir, `${name}.png`)
    const bytes = fs.readFileSync(file)
    if (bytes.length <= 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error(`screenshot ${name} missing, empty or not PNG`)
    return { name, bytes: bytes.length, sha256: sha256File(file) }
  })
}

export function verifyOptOutShots(shotsDir) { return verifyPanelShots(shotsDir, OPT_OUT_SHOTS) }

/** The QA-only user-command fixture, generated per run so the workspace root
 * and profile homes are baked in as literals. Self-refuses outside the
 * throwaway homes/root (never install into a formal profile). */
export function fixtureSources({ workspace, homes }) {
  const midbatchFiles = ['probe.ts', 'probe-other.ts'].map((name) => path.join(workspace, name))
  const manifest = {
    name: 'weir-dual-gui-qa-command-fixture',
    version: '0.0.1',
    private: true,
    type: 'module',
    exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  const patch = `# QA-only command from an authenticated browser. Never install in a formal profile.
- insert:
    - id: qa-edit-lock-operations
      name: './index.js'
`
  const index = `// QA-ONLY human command. This bundle is never part of the product profile.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'

export const name = 'weir-dual-gui-qa-command'
export const inject = ['agents', 'commands', 'tools', 'fs']

const ROOT = ${JSON.stringify(workspace)}
const QA_HOMES = ${JSON.stringify(homes)}
// Midbatch-rename fault targets (the editlock-lsp-rename probe approach: wrap
// the REAL ctx.fs.writeText, fail the second fixture-file write of an armed
// batch — the first write genuinely lands, the second is never completed).
const MIDBATCH_FILES = ${JSON.stringify(midbatchFiles)}
const HASH_ANCHORS = ${JSON.stringify({ initial: anchorFor(1, 'export const shared = 1'), written: anchorFor(1, 'export const shared = 2'), after: anchorFor(1, 'export const shared = 3') })}
const UNKNOWN_FILE = ${JSON.stringify(path.join(workspace, 'qa-unknown.ts'))}
const UNKNOWN_ANCHOR = ${JSON.stringify(anchorFor(1, 'export const unknown = 1'))}

const CAS_FILE = ${JSON.stringify(path.join(workspace, 'narrow', 'cas-target.ts'))}
const SANDBOX_FILE = ${JSON.stringify(path.join(workspace, 'sandbox-target.ts'))}
const CAS_ANCHOR = ${JSON.stringify(anchorFor(1, 'export const cas = 1'))}
const SANDBOX_ANCHOR = ${JSON.stringify(anchorFor(1, 'export const sandbox = 1'))}
const NARROW = ${JSON.stringify(path.join(workspace, 'narrow'))}
export function apply(ctx) {
  if (process.env.WEIR_QA_FIXTURE !== '1' ||
      !QA_HOMES.includes(process.env.DSH_HOME) ||
      realpathSync.native(ROOT) !== ROOT) {
    throw new Error('QA command refuses a non-isolated profile or workspace')
  }
  // One-shot midbatch fault, armed only by the rename-midbatch verb.
  let midbatch = null
  let unknownArmed = false
  const writeText = ctx.fs?.writeText
  if (typeof writeText !== 'function') throw new Error('QA fixture requires the host filesystem writeText')
  ctx.fs.writeText = async function (target, ...rest) {
    const key = target?.targetKey
    if (unknownArmed && key === UNKNOWN_FILE) {
      unknownArmed = false
      await writeText.call(this, target, ...rest)
      throw new Error('QA publisher acknowledgement lost AFTER the write')
    }
    if (midbatch && typeof key === 'string' && MIDBATCH_FILES.includes(key)) {
      midbatch.count += 1
      if (midbatch.count >= 2) {
        midbatch = null
        throw new Error('QA midbatch fault: simulated I/O failure on the second batch file')
      }
    }
    return writeText.call(this, target, ...rest)
  }
  const run = (agent, invocation, name, args) => ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    name,
    arguments: args,
    callId: \`qa-\${randomUUID()}\`,
    agent,
    signal: invocation.signal,
  }))
  const off = ctx.commands.register({
    name: 'qa-edit',
    description: 'QA-only user action exercising actual managed editors on one disposable workspace.',
    input: { hint: 'acquire [file] | read [file] | write | hash-edit [initial|written|after] | cas-hash-edit | cas-write | sandbox-hash-edit | write-unknown | release [file] | status | pause [min] | rename-midbatch' },
    async handler(invocation) {
      try {
        const agent = invocation.agent
        if (!agent || ctx.agents.get(agent.id) !== agent ||
            ![ROOT, NARROW].includes(realpathSync.native(agent.session?.header?.cwd))) {
          throw new Error('QA command requires an exact live agent in the external workspace')
        }
        const [verb, ...rest] = String(invocation.rawInput ?? '').trim().split(/\\s+/).filter(Boolean)
        // File arguments are bare fixture basenames only — no separators, no
        // escapes from the disposable workspace.
        const file = rest[0]
        if (file !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) throw new Error('Only bare fixture file names are allowed')
        if (verb === 'pause') {
          const minutes = file === undefined ? 10 : Number(file)
          const result = await run(agent, invocation, 'edit_lock_pause', { minutes })
          return result.isError
            ? { kind: 'error', text: \`QA pause refused: \${result.error?.message ?? 'unknown'}\` }
            : { kind: 'success', text: \`QA pause succeeded: \${JSON.stringify(result.value ?? {})}\` }
        }
        if (verb === 'rename-midbatch') {
          // Same genuine chain as the editlock-lsp-rename scenario: outline the
          // document (opens it), arm the one-shot fault, then run the real
          // lsp_rename — the batch fails on the SECOND file's write.
          const outline = await run(agent, invocation, 'lsp_symbols', { file_path: 'probe.ts' })
          if (outline.isError) return { kind: 'error', text: \`QA symbols refused: \${outline.error?.message ?? 'unknown'}\` }
          midbatch = { count: 0 }
          try {
            const result = await run(agent, invocation, 'lsp_rename', { file_path: 'probe.ts', line: 1, character: 14, new_name: 'qaMidBatch' })
            return result.isError
              ? { kind: 'error', text: \`QA rename refused: \${result.error?.message ?? 'unknown'}\` }
              : { kind: 'success', text: \`QA rename succeeded: \${JSON.stringify(result.value ?? {})}\` }
          } finally {
            // A fault that never fired (batch refused pre-write) must not leak
            // into a later phase.
            if (midbatch && midbatch.count === 0) midbatch = null
          }
        }
        if (verb === 'write-unknown') {
          unknownArmed = true
          try {
            const result = await run(agent, invocation, 'hash_edit', { file_path: 'qa-unknown.ts', edits: [{ op: 'replace', pos: UNKNOWN_ANCHOR, text: 'export const unknown = 2' }] })
            return result.isError
              ? { kind: 'error', text: \`QA unknown publication: \${result.error?.message ?? 'unknown'}\` }
              : { kind: 'success', text: 'QA unknown publication unexpectedly acknowledged' }
          } finally { unknownArmed = false }
        }
         if (verb === 'cas-hash-edit' || verb === 'cas-write' || verb === 'sandbox-hash-edit') {
           if (realpathSync.native(agent.session.header.cwd) !== NARROW || rest.length) throw new Error('QA refusal probes require the exact nested session and no arguments')
           const name = verb === 'cas-write' ? 'write' : 'hash_edit'
           const args = verb === 'cas-write'
             ? { file_path: CAS_FILE, content: 'export const cas = 3\\n' }
             : { file_path: verb === 'cas-hash-edit' ? CAS_FILE : SANDBOX_FILE, edits: [{ op: 'replace', pos: verb === 'cas-hash-edit' ? CAS_ANCHOR : SANDBOX_ANCHOR, text: verb === 'cas-hash-edit' ? 'export const cas = 2' : 'SHOULD_NEVER_LAND' }] }
           const result = await run(agent, invocation, name, args)
           return result.isError
             ? { kind: 'error', text: verb === 'cas-hash-edit'
               ? \`QA \${verb} refused: \${result.error?.message ?? 'unknown'}\`
               : \`QA \${verb} refused:\\n\${result.error?.message ?? 'unknown'}\` }
             : { kind: 'success', text: \`QA \${verb} succeeded: \${JSON.stringify(result.value ?? {})}\` }
         }
        if (verb === 'hash-edit') {
          const stage = rest[0] ?? 'written'
          if (!Object.hasOwn(HASH_ANCHORS, stage)) throw new Error('unknown hash-edit stage')
          const result = await run(agent, invocation, 'hash_edit', { file_path: 'qa-shared.ts', edits: [{ op: 'replace', pos: HASH_ANCHORS[stage], text: 'export const shared = 3' }] })
          return result.isError
            ? { kind: 'error', text: \`QA hash-edit refused: \${result.error?.message ?? 'unknown'}\` }
            : { kind: 'success', text: \`QA hash-edit succeeded: \${JSON.stringify(result.value ?? {})}\` }
        }
        const names = { acquire: 'edit_lock_acquire', read: 'read', write: 'write', release: 'edit_lock_release', status: 'edit_lock_status' }
        const tool = names[verb]
        if (!tool) throw new Error(\`Only acquire, read, write, hash-edit, write-unknown, release, status, pause or rename-midbatch are allowed (verb \${JSON.stringify(verb)})\`)
        const target = file ?? 'qa-shared.ts'
        const argumentsValue = verb === 'status' ? {} : verb === 'write'
          ? { file_path: 'qa-shared.ts', content: 'export const shared = 2\\n' }
          : { file_path: target }
        const result = await run(agent, invocation, tool, argumentsValue)
        return result.isError
          ? { kind: 'error', text: \`QA \${verb} refused: \${result.error?.message ?? 'unknown'}\` }
          : { kind: 'success', text: \`QA \${verb} succeeded: \${JSON.stringify(result.value ?? {})}\` }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  })
  return () => { off(); ctx.fs.writeText = writeText }
}
`
  return { 'package.json': `${JSON.stringify(manifest, null, 2)}\n`, 'cordis.patch.yml': patch, 'index.js': index }
}

/** Settings overlay: edit lock on, auto-resume off, side features quiet, and
 * the LSP capability gate open with the typescript family pointed at the mock
 * protocol server copied into the workspace (the same fixture the
 * editlock-lsp-rename scenario uses — the GUI panel-states phases drive the
 * real client → server → WorkspaceEdit → publishBatch chain). */
export function settingsPatchSource({ workspace, platform = process.platform, editable = false } = {}) {
  // A command-line override makes settings/mutate reject the entire namespace.
  // The opt-out flow uses genuine writable saved settings, not an overlay.
  if (editable) return `- id: ui-settings-general
  name: '@deepseek-ai/dsh-client-ui-settings-general'
  config:
    welcomeNoticeVersion: 2026-09-28.1
`
  const mockServer = workspace ? joinFor(platform)(workspace, 'mock-lsp-server.js') : null
  const lspOverlay = mockServer
    // Folded block scalar: the expression carries `: ` pairs that would break
    // a plain YAML scalar (boot failure: "bad indentation of a mapping entry").
    ? `    lspEnabled: true
    # !!js evaluates in the server process: process.execPath is the DSH runtime
    # node, so the mock server launches on any platform without a hardcoded path.
    lspServers: !!js >-
      JSON.stringify({ typescript: { command: process.execPath, args: [${JSON.stringify(mockServer)}], installHint: 'qa-fixture' } })
`
    : ''
  return `# Test-only overlay. Never load in the user's desktop profile.
- id: weir-settings
  name: 'weir-harness/settings'
  config:
    editLockEnabled: true
    editLockAutoResume: false
    notifyEnabled: false
    worktreeEnabled: false
    intentGateClassifier: regex
${lspOverlay}# Mark the preview welcome notice as seen so its modal never covers the panel
# in screenshots (same suppression the manual QA profiles carried).
- id: ui-settings-general
  name: '@deepseek-ai/dsh-client-ui-settings-general'
  config:
    welcomeNoticeVersion: 2026-09-28.1
`
}

/** In-page helper source: authenticated gateway RPC + edit-lock view read.
 * Evaluated once per page; fetch carries the session cookie set by the
 * token handshake, so no credential ever leaves the browser. */
export const PAGE_HELPERS_SOURCE = `(() => {
  if (window.__dualGuiQa) return true
  window.__dualGuiQa = {
    async rpc(endpoint, args) {
      const rpcId = crypto.randomUUID()
      const res = await fetch('/api/' + endpoint, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      })
      const text = await res.text()
      let body = null
      try { body = JSON.parse(text) } catch { /* non-JSON body reported raw */ }
      return { httpStatus: res.status, body: body ?? { raw: text.slice(0, 400) } }
    },
    async view(sessionId) {
      const res = await fetch('/api/weir-edit-lock/view', {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      return res.json()
    },
    async maintenance() {
      const res = await fetch('/api/weir-edit-lock/maintenance/status', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
      return res.json()
    },
    panelState() {
      const entry = document.querySelector('[data-weir-edit-lock]')
      if (!entry) return { entry: false }
      return {
        entry: true,
        state: entry.getAttribute('data-weir-edit-lock-state'),
        open: entry.getAttribute('aria-expanded') === 'true',
        panel: Boolean(document.querySelector('[data-weir-edit-lock-panel]')),
        primary: Boolean(document.querySelector('[data-weir-edit-lock-action="primary"]')),
      }
    },
    openPanel() {
      const entry = document.querySelector('[data-weir-edit-lock]')
      if (!entry) return 'no-entry'
      if (entry.getAttribute('aria-expanded') !== 'true') { entry.click(); return 'clicked' }
      // Already open: the popover only re-reads the view on toggle/action, so
      // a phase that changed the authority state must nudge the refresh button
      // or the panel keeps rendering the PREVIOUS state (panel-paused miss).
      document.querySelector('[data-weir-edit-lock-action="refresh"]')?.click()
      return 'refreshed'
    },
    clickPrimary() {
      const btn = document.querySelector('[data-weir-edit-lock-action="primary"]')
      if (!btn) return 'no-primary'
      btn.click()
      return 'clicked'
    },
    openSessionRow(sessionId, workspaceId) {
      // A session created through the gateway stays "blank" (no turn ever
      // started), and the sidebar tree only renders blank rows while they are
      // CURRENT. The deterministic open path is the workspace group's
      // new-session button: uiWorkspace.startSession -> openWorkspace ->
      // reuseOrCreateBlank adopts the workspace's NEWEST blank session, which
      // is the one this driver created last for that GUI. Adoption makes the
      // session current, its row renders, and a second poll clicks the row
      // itself. A wrong adoption is loud: the target row never appears.
      const row = document.querySelector('[data-row-key="session:' + sessionId + '"]')
      if (row) { row.click(); return 'clicked-row' }
      if (!workspaceId) return 'not-found'
      const group = document.querySelector('[data-row-key="workspace:' + workspaceId + '"]')
      if (!group) return 'no-workspace-row'
      // After a restart the group may render collapsed: its session rows (the
      // target among them) only mount once expanded. Expand before adopting.
      if (group.getAttribute('aria-expanded') === 'false') {
        (group.querySelector('button[aria-expanded]') ?? group).click()
        return 'expanded-workspace'
      }
      const button = group.querySelector('button[aria-keyshortcuts]') ?? [...group.querySelectorAll('button')].pop()
      if (!button) return 'no-adopt-button'
      button.click()
      return 'adopt-clicked'
    },
    // Read ONLY the genuine rendered command lifecycle node. The gateway
    // response and Edit Lock panel are not substitutes for conversation proof.
    commandEvidence(sessionId, exactResult, focus = false) {
      const selected = document.querySelector('[data-row-key="session:' + sessionId + '"]')?.getAttribute('aria-selected') === 'true'
      const nodes = [...document.querySelectorAll('[data-chat-flow-kind="command"]')]
      const match = nodes.find((node) => node.textContent?.includes(exactResult))
      if (focus && match) {
        match.querySelector('[aria-expanded="false"]')?.click()
        match.scrollIntoView({ block: 'center' })
      }
      const detail = match?.querySelector('pre')
      const rect = detail?.getBoundingClientRect()
      const visible = Boolean(rect && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && getComputedStyle(detail).visibility !== 'hidden')
      return { selected, commandCount: nodes.length, matched: Boolean(match), visible, detail: Boolean(detail?.textContent?.includes(exactResult)), error: Boolean(match?.querySelector('[data-state="error"]')), text: detail?.textContent?.slice(0, 600) ?? match?.textContent?.slice(0, 600) ?? null }
    },
    // Theme state. The GUI's theme switch is Settings > General > Appearance
    // (three cubes calling theme.setTheme, persisted as the ui-theme config
    // form's preference field: light | dark | system, default 'system').
    // With no override the throwaway profile follows the OS via the runtime's
    // prefers-color-scheme matchMedia sensing — the driver flips THAT genuine
    // path with CDP Emulation.setEmulatedMedia, and these markers prove the
    // palette actually applied: body[data-ds-dark-theme] selects the dark
    // token set, html[data-ds-theme-source] publishes the preference source.
    theme() {
      return {
        dark: document.body?.hasAttribute('data-ds-dark-theme') === true,
        source: document.documentElement.getAttribute('data-ds-theme-source'),
      }
    },
    // Full panel marker read: structured state + every localized text block
    // the panel can render (cleanup-only, paused deadline, recovery usage,
    // ownership honesty hint, per-file rows with status and reason).
    panelMarkers() {
      const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null
      const entry = document.querySelector('[data-weir-edit-lock]')
      return {
        state: entry?.getAttribute('data-weir-edit-lock-state') ?? null,
        open: entry?.getAttribute('aria-expanded') === 'true',
        panel: Boolean(document.querySelector('[data-weir-edit-lock-panel]')),
        summary: text('[data-weir-edit-lock-summary]'),
        cleanup: text('[data-weir-edit-lock-cleanup]'),
        pausedUntil: text('[data-weir-edit-lock-paused-until]'),
        recovery: text('[data-weir-edit-lock-recovery]'),
        pauseHint: text('[data-weir-edit-lock-pause]'),
        ownershipHint: text('[data-weir-edit-lock-ownership-hint]'),
        error: text('[data-weir-edit-lock-error]'),
        files: [...document.querySelectorAll('[data-weir-edit-lock-file]')].map((el) => ({
          path: el.getAttribute('data-weir-edit-lock-file'),
          text: (el.textContent || '').trim(),
          reason: el.querySelector('[data-weir-edit-lock-file-reason]')?.textContent ?? null,
        })),
      }
    },
    // The paused deadline must render as an absolute clock in the page's own
    // locale (the panel formats with toLocaleTimeString hour/minute).
    pausedClockMatches(ts) {
      const el = document.querySelector('[data-weir-edit-lock-paused-until]')
      if (!el || !Number.isFinite(ts)) return false
      let clock = ''
      try { clock = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return false }
      return clock.length > 0 && (el.textContent || '').includes(clock)
    },
    dismissModals() {
      // Best-effort: fresh profiles greet with a welcome/API-key modal that
      // would cover every screenshot. Known dismiss labels, both locales.
      const labels = /稍后|以后|跳过|继续|Later|Skip|Not now|Dismiss|Continue/i
      let clicked = 0
      for (const dialog of document.querySelectorAll('[role="dialog"], [data-modal-autofocus]')) {
        // Never touch the Edit Lock panel: it is also role="dialog" and its
        // 继续编辑/Continue button is a state-changing action, not a dismiss.
        if (dialog.closest('[data-weir-edit-lock-root]') || dialog.hasAttribute('data-weir-edit-lock-panel')) continue
        for (const btn of dialog.querySelectorAll('button')) {
          const text = (btn.textContent || '').trim()
          if (text && labels.test(text) && !/保存|Save/i.test(text)) { btn.click(); clicked += 1; break }
        }
      }
      return clicked
    },
    debugSidebar() {
      const keys = [...document.querySelectorAll('[data-row-key]')].map((el) => el.getAttribute('data-row-key') + (el.getAttribute('aria-expanded') === 'false' ? ' (collapsed)' : ''))
      const panels = [...document.querySelectorAll('button[aria-current]')].map((el) => ({ label: el.getAttribute('aria-label'), current: el.getAttribute('aria-current') }))
      const heroButtons = [...document.querySelectorAll('main button, [role="main"] button')].map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 20)
      return { keys, panels, heroButtons, text: (document.body?.innerText || '').slice(0, 500) }
    },
    settingsStep() {
      const group = document.querySelector('[data-group="editing"]')
      if (group) {
        group.scrollIntoView({ block: 'center' })
        const warning = group.querySelector('[role="alert"]')
        const buttons = [...group.querySelectorAll('button')]
        const maintenance = buttons.find((button) => /^(编辑|Edit|查看|View)$/.test((button.textContent || '').trim()))
        if (maintenance) maintenance.click()
        return { group: true, warning: warning?.textContent?.trim() ?? null, text: group.textContent?.slice(0, 1400), buttons: buttons.map((button) => button.textContent?.trim()) }
      }
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
      const weir = buttons.find((button) => /^(Weir|WEIR)$/.test((button.textContent || '').trim() || button.getAttribute('aria-label') || ''))
      if (weir) { weir.click(); return { clicked: 'weir' } }
      const settings = buttons.find((button) => /^(设置|Settings)$/.test((button.textContent || '').trim() || button.getAttribute('aria-label') || ''))
      if (settings) { settings.click(); return { clicked: 'settings' } }
      return { clicked: null, buttons: buttons.map((button) => (button.textContent || '').trim() || button.getAttribute('aria-label')).filter(Boolean).slice(0, 60), text: document.body?.innerText?.slice(0, 500) }
    },
    frameOptOut(state) {
      const group = document.querySelector('[data-group="editing"]')
      const warning = group?.querySelector('[role="alert"]')
      if (!warning) return { visible: false, reason: 'warning absent' }
      // Frame the switch AND its adjacent warning, not only the alert text;
      // the maintenance state must fit below in the same captured viewport.
      group.scrollIntoView({ block: 'start' })
      const label = state === 'saved-off' ? /^(已请求停用——需要重启|Disable requested — restart required)$/ : /^(强制执行已停用|Enforcement disabled)$/
      const status = [...group.querySelectorAll('span, div')].find((el) => label.test((el.textContent || '').trim()))
      const dialog = warning.closest('[role="dialog"]')
      const bounds = dialog?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight }
      const switchControl = [...group.querySelectorAll('[role="switch"]')].at(-1)
      const inFrame = (el) => { const rect = el?.getBoundingClientRect(); return Boolean(rect && rect.top >= bounds.top + 35 && rect.bottom <= bounds.bottom - 10) }
      return { visible: inFrame(warning) && inFrame(status) && inFrame(switchControl), warningTop: warning.getBoundingClientRect().top, switchTop: switchControl?.getBoundingClientRect().top ?? null, statusTop: status?.getBoundingClientRect().top ?? null, dialogTop: bounds.top, dialogBottom: bounds.bottom }
    },
  }
  return true
})()`

/** Matrix recorder: one row per phase, PASS/FAIL/SKIP with sanitized detail. */
export function createMatrix() {
  const rows = []
  return {
    rows,
    record(name, status, detail = '') {
      rows.push({ name, status, detail })
      return rows[rows.length - 1]
    },
    get failed() { return rows.filter((row) => row.status === 'FAIL') },
    get passed() { return rows.filter((row) => row.status === 'PASS') },
  }
}

/**
 * Graceful-stop one tracked child, escalating SIGINT -> SIGTERM -> SIGKILL
 * (POSIX). On win32 only SIGTERM/SIGKILL exist as TerminateProcess — the
 * caller records `graceful: false` so the reservation-absence assertion is
 * reported as not-applicable instead of silently deleted (which is forbidden).
 */
export async function stopChild(child, { platform = process.platform, graceMs = 10000, label = 'process', kill = (c, s) => c.kill(s) } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { graceful: true, alreadyExited: true }
  const waitExit = (ms) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
  if (platform !== 'win32') {
    kill(child, 'SIGINT')
    if (await waitExit(graceMs)) return { graceful: true, label }
    kill(child, 'SIGTERM')
    if (await waitExit(graceMs)) return { graceful: true, label }
  } else {
    kill(child, 'SIGTERM')
    if (await waitExit(graceMs)) return { graceful: false, label }
  }
  kill(child, 'SIGKILL')
  await waitExit(graceMs)
  return { graceful: false, forced: true, label }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A restart witness must be a dead old process and a distinct new PID. */
export function assertFreshRestart({ previousPid, nextPid, exitCode, signalCode }) {
  if (!Number.isSafeInteger(previousPid) || !Number.isSafeInteger(nextPid) || previousPid === nextPid) throw new Error('restart requires a different process PID')
  if (exitCode === null && signalCode === null) throw new Error('previous process did not exit before restart')
}

// ---------------------------------------------------------------------------
// Orchestration (side effects live below this line)
// ---------------------------------------------------------------------------

/** Sanitizing file logger: every persisted byte passes the token filter.
 * `secrets` may be a thunk so a token minted AFTER the log opened (a server
 * restart issues a fresh one) is still redacted from later writes. */
function createLog(file, secrets) {
  const stream = fs.createWriteStream(file, { flags: 'a' })
  const current = typeof secrets === 'function' ? secrets : () => secrets
  return {
    write(text) { stream.write(`${sanitizeText(text, current())}\n`) },
    end() { stream.end() },
  }
}

/** Gate that holds log chunks in memory until `arm()` is called (after the
 * launch token has been parsed and registered for redaction), then flushes
 * the backlog and streams live. Chunks are never written unarmed, so a token
 * printed before the parser saw it cannot leak into a log file. */
export function createTokenGate(write) {
  let armed = false
  const backlog = []
  return {
    push(text) {
      if (armed) return write(text)
      backlog.push(text)
    },
    arm() {
      if (armed) return
      armed = true
      for (const text of backlog) write(text)
      backlog.length = 0
    },
    get armed() { return armed },
  }
}

/** Minimal CDP client over the browser's page WebSocket (Node >=22 WebSocket). */
class Cdp {
  constructor(wsUrl, onEvent) {
    this.ws = new WebSocket(wsUrl)
    this.seq = 0
    this.pending = new Map()
    this.onEvent = onEvent
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`))
        else entry.resolve(msg.result ?? {})
      } else if (msg.method) {
        this.onEvent?.(msg.method, msg.params ?? {})
      }
    }
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = (event) => reject(new Error(`cdp websocket error ${event.message ?? ''}`))
    })
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: timeout`))
      }, timeoutMs)
      timer.unref?.()
    })
  }

  async evaluate(expression, { timeoutMs = 60000 } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    }, timeoutMs)
    if (result.exceptionDetails) {
      throw new Error(`page eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result?.value
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, 60000)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  close() { try { this.ws.close() } catch { /* already closed */ } }
}

/** One dual-GUI instance: server process + dedicated headless Chrome. */
export class GuiInstance {
  constructor(name, config) {
    this.name = name
    this.config = config
    this.token = ''
    this.launchUrl = ''
    this.server = null
    this.chrome = null
    this.cdp = null
    this.stdoutBuffer = ''
    this.serverPid = null
    this.secretList = []
    this.processes = []
    // Runtime.exceptionThrown events observed since boot; panel-states phases
    // assert a zero delta per phase (console exceptions are a gate, not noise).
    this.exceptions = 0
  }

  get secrets() { return this.secretList }

  /** The launch token is memory-only; registering it here arms redaction for
   * every log sink that reads the list lazily. */
  setToken(token) { this.token = token; if (token && !this.secretList.includes(token)) this.secretList.push(token) }

  get serverLogFile() { return path.join(this.config.paths.logs, `server-${this.name}.log`) }

  get eventsFile() { return path.join(this.config.paths.logs, `console-events-${this.name}.jsonl`) }

  logEvent(kind, data) {
    fs.appendFileSync(this.eventsFile, `${sanitizeText({ ts: new Date().toISOString(), kind, data }, this.secrets)}\n`)
  }

  /** Initialize the throwaway profile and link-install bundle + fixture. */
  provision() {
    const { dsh, paths, weirBundle } = this.config
    const env = this.processEnv()
    fs.mkdirSync(this.home, { recursive: true })
    const run = (args, logFile) => {
      const result = spawn(dsh.command, args, { env, cwd: paths.root })
      return new Promise((resolve, reject) => {
        let out = ''
        result.stdout.on('data', (chunk) => { out += chunk })
        result.stderr.on('data', (chunk) => { out += chunk })
        result.on('error', reject)
        result.on('exit', (code) => {
          fs.writeFileSync(logFile, sanitizeText(out, this.secrets))
          code === 0 ? resolve() : reject(new Error(`${this.name}: provisioning command failed (${code}): ${args.join(' ')}`))
        })
      })
    }
    return (async () => {
      await run(buildProfileInitArgs({ profile: this.profile, prefixArgs: dsh.prefixArgs }), path.join(paths.logs, `init-${this.name}.log`))
      await run(buildPluginAddArgs({ profile: this.profile, packageDir: weirBundle, prefixArgs: dsh.prefixArgs }), path.join(paths.logs, `install-weir-${this.name}.log`))
      await run(buildPluginAddArgs({ profile: this.profile, packageDir: paths.fixture, prefixArgs: dsh.prefixArgs }), path.join(paths.logs, `install-fixture-${this.name}.log`))
    })()
  }

  processEnv() {
    return {
      ...process.env,
      DSH_HOME: this.home,
      WEIR_QA_FIXTURE: '1',
    }
  }

  get home() { return path.join(this.config.paths.root, `home-${this.name}`) }

  get profile() { return `dual-gui-${this.name}` }

  /** Boot `dsh web`; resolve with the sanitized launch URL once ready. */
  async startServer() {
    const { dsh, paths } = this.config
    const args = buildServerArgs({
      profile: this.profile,
      patches: [paths.settingsPatch],
      port: this.ports.web,
      prefixArgs: dsh.prefixArgs,
    })
    this.log = createLog(this.serverLogFile, () => this.secretList)
    this.stdoutBuffer = ''
    this.server = spawn(dsh.command, args, { env: this.processEnv(), cwd: paths.root })
    this.serverPid = this.server.pid
    this.processes.push({ name: `${this.name} server`, child: this.server })
    // Token safety: stdout is buffered in memory until the launch token is
    // parsed; only then does the (now redaction-armed) log receive the
    // backlog and start streaming. A token can never reach the log file.
    const gate = createTokenGate((text) => this.log.write(text))
    const onChunk = (chunk) => {
      const text = chunk.toString('utf8')
      this.stdoutBuffer += text
      gate.push(text)
    }
    this.server.stdout.on('data', onChunk)
    this.server.stderr.on('data', onChunk)
    const ready = new Promise((resolve, reject) => {
      const deadline = Date.now() + this.config.timeouts.bootMs
      const poll = () => {
        try {
          const { url, token } = parseLaunchUrl(this.stdoutBuffer)
          this.launchUrl = url
          this.setToken(token)
          gate.arm()
          resolve()
        } catch {
          if (Date.now() > deadline) return reject(new Error(`${this.name}: server did not print a launch URL within ${this.config.timeouts.bootMs}ms`))
          if (this.server.exitCode !== null) return reject(new Error(`${this.name}: server exited (${this.server.exitCode}) before readiness`))
          setTimeout(poll, 200)
        }
      }
      poll()
    })
    this.server.on('error', (error) => { throw error })
    await ready
  }

  /** Boot the dedicated headless Chrome and connect CDP to its page. */
  async startBrowser() {
    const { chrome, paths } = this.config
    const userDataDir = path.join(paths.root, `chrome-${this.name}`)
    fs.mkdirSync(userDataDir, { recursive: true })
    this.chrome = spawn(chrome, buildChromeArgs({ cdpPort: this.ports.cdp, userDataDir }), { stdio: ['ignore', 'ignore', 'pipe'] })
    this.processes.push({ name: `${this.name} chrome`, child: this.chrome })
    this.chrome.stderr.on('data', () => { /* chrome chatter is not evidence */ })
    const list = await waitFor(`${this.name} cdp`, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${this.ports.cdp}/json/list`)
        if (!res.ok) return null
        const targets = await res.json()
        return targets.find((target) => target.type === 'page') ?? null
      } catch { return null }
    }, { timeoutMs: this.config.timeouts.bootMs })
    this.cdp = new Cdp(list.webSocketDebuggerUrl, (method, params) => {
      if (method === 'Runtime.consoleAPICalled') {
        this.logEvent('console', { type: params.type, args: (params.args ?? []).map((a) => a.value ?? a.description ?? a.type) })
      } else if (method === 'Runtime.exceptionThrown') {
        this.exceptions += 1
        const d = params.exceptionDetails ?? {}
        this.logEvent('exception', { text: d.text, description: d.exception?.description ?? null, url: d.url, line: d.lineNumber })
      }
    })
    await this.cdp.open()
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Page.enable')
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  }

  /** Navigate to the token launch URL (303 handshake sets the auth cookie) and
   * install the in-page helpers. */
  async openApp() {
    await this.cdp.send('Page.navigate', { url: this.launchUrl })
    await waitFor(`${this.name} app`, async () => {
      const ready = await this.cdp.evaluate('document.readyState === "complete" && Boolean(document.body)')
      return ready || null
    }, { timeoutMs: this.config.timeouts.bootMs })
    await waitFor(`${this.name} helpers`, async () => {
      return (await this.cdp.evaluate(PAGE_HELPERS_SOURCE)) === true || null
    }, { timeoutMs: this.config.timeouts.bootMs })
    // Fresh profiles greet with welcome/API-key modals; dismiss them so later
    // screenshots show the panel, never the overlay. Best-effort by design.
    await this.cdp.evaluate('window.__dualGuiQa.dismissModals()').catch(() => 0)
  }

  /** Authenticated gateway RPC from inside the page. */
  async rpc(endpoint, args) {
    const response = await this.cdp.evaluate(
      `window.__dualGuiQa.rpc(${JSON.stringify(endpoint)}, ${JSON.stringify(args)})`,
    )
    const result = response?.body?.result
    if (!result || typeof result !== 'object') {
      throw new Error(`${this.name}: rpc ${endpoint} returned no envelope (http ${response?.httpStatus}): ${JSON.stringify(response?.body)?.slice(0, 300)}`)
    }
    return result
  }

  async view(sessionId) {
    const payload = await this.cdp.evaluate(`window.__dualGuiQa.view(${JSON.stringify(sessionId)})`)
    if (!payload || typeof payload !== 'object') throw new Error(`${this.name}: view returned no payload`)
    return payload
  }

  async shot(name) {
    const file = path.join(this.config.paths.shots, `${name}.png`)
    await this.cdp.evaluate('window.__dualGuiQa.dismissModals()').catch(() => 0)
    await this.cdp.screenshot(file)
    const bytes = fs.readFileSync(file)
    if (bytes.length <= 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new Error(`${this.name}: screenshot ${name} is missing, empty or not PNG`)
    }
    return file
  }

  /** Read the structured panel markers (state attr + every localized block). */
  async markers() {
    const value = await this.cdp.evaluate('window.__dualGuiQa.panelMarkers()')
    if (!value || typeof value !== 'object') throw new Error(`${this.name}: panelMarkers returned no payload`)
    return value
  }

  /** Flip the OS color scheme the GUI's system-theme preference genuinely
   * follows (see the theme() helper's note for the full mechanism), and prove
   * the palette applied by waiting for the body palette attribute. */
  async setColorScheme(scheme) {
    if (scheme !== 'dark' && scheme !== 'light') throw new Error(`unknown scheme ${scheme}`)
    await this.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    return waitFor(`${this.name} ${scheme} theme`, async () => {
      const theme = await this.cdp.evaluate('window.__dualGuiQa.theme()')
      return theme?.dark === (scheme === 'dark') ? theme : null
    }, { timeoutMs: this.config.timeouts.phaseMs })
  }

  /** Stop the browser half first (cheap, no authority state). */
  async stopBrowser() {
    if (this.cdp) this.cdp.close()
    return stopChild(this.chrome, { label: `${this.name} chrome`, graceMs: this.config.timeouts.stopGraceMs })
  }

  /** Stop the server half; the publisher must drain AFTER every client has
   * disconnected, or its reservation release never reaches quiescence. */
  async stopServer() {
    const serverStop = await stopChild(this.server, { label: `${this.name} server`, graceMs: this.config.timeouts.stopGraceMs })
    this.log?.end()
    return serverStop
  }

  async stop() {
    await this.stopBrowser()
    return this.stopServer()
  }
}

/** Build the runtime configuration from argv + env (validated, pure paths). */
export function resolveConfig({ argv = [], env = process.env, platform = process.platform, fileExists = fs.existsSync } = {}) {
  const flag = (name) => argv.includes(name)
  const option = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const matrix = flag('--opt-out') ? 'opt-out' : (flag('--heavy') ? 'heavy' : (env.DUAL_GUI_MATRIX === 'opt-out' ? 'opt-out' : env.DUAL_GUI_MATRIX === 'heavy' ? 'heavy' : 'core'))
  const weirBundle = env.DUAL_GUI_WEIR ?? path.join(REPO_ROOT, 'plugins', 'weir-harness')
  if (!fileExists(path.join(weirBundle, 'cordis.patch.yml'))) {
    throw new Error(`weir-harness bundle not found at ${weirBundle} (set DUAL_GUI_WEIR)`)
  }
  let root = option('--root') ?? env.DUAL_GUI_ROOT
  if (root) {
    fs.mkdirSync(root, { recursive: true })
    root = fs.realpathSync.native(root)
  } else {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'weir-dual-gui-')))
  }
  return {
    matrix,
    root,
    keep: flag('--keep') || env.DUAL_GUI_KEEP === '1',
    weirBundle,
    dsh: resolveDshInvocation({ env, platform, fileExists }),
    chrome: resolveChromePath({ env, platform, fileExists }),
    timeouts: {
      bootMs: Number(env.DUAL_GUI_BOOT_TIMEOUT_MS ?? 180000),
      phaseMs: Number(env.DUAL_GUI_PHASE_TIMEOUT_MS ?? 45000),
      stopGraceMs: Number(env.DUAL_GUI_STOP_GRACE_MS ?? 10000),
    },
    platform,
  }
}

/** Rename-fixture files the panel-states phases need inside the workspace:
 * the mock LSP protocol server (copied from this package; it reads its two
 * fixture files as siblings of the script) plus the documents it edits and
 * the manifests the typescript server family key on. Content matches the
 * editlock-lsp-rename scenario fixtures byte for byte. */
export function renameFixtureSources() {
  return {
    'probe.ts': 'export const fixtureSymbol = 1\n',
    'probe-other.ts': 'import { fixtureSymbol } from "./probe"\r\nexport const useIt = fixtureSymbol + 1\r\n',
    'qa-attention.ts': 'export const attention = 1\n',
    'qa-unknown.ts': 'export const unknown = 1\n',
    'package.json': '{"name":"dual-gui-qa-ws","private":true}\n',
    'tsconfig.json': '{}\n',
  }
}
/** Materialize the QA root: shared workspace, fixture, settings patch, dirs. */
export function prepareQaRoot(config) {
  const paths = {
    root: config.root,
    ws: path.join(config.root, 'ws'),
    fixture: path.join(config.root, 'fixture'),
     narrow: path.join(config.root, 'ws', 'narrow'),
     casFile: path.join(config.root, 'ws', 'narrow', 'cas-target.ts'),
     sandboxFile: path.join(config.root, 'ws', 'sandbox-target.ts'),
     shots: path.join(config.root, 'shots'),
    logs: path.join(config.root, 'logs'),
    settingsPatch: path.join(config.root, 'edit-lock-on.patch.yml'),
    sharedFile: path.join(config.root, 'ws', 'qa-shared.ts'),
    attentionFile: path.join(config.root, 'ws', 'qa-attention.ts'),
    probeFile: path.join(config.root, 'ws', 'probe.ts'),
    probeOtherFile: path.join(config.root, 'ws', 'probe-other.ts'),
  }
  fs.mkdirSync(paths.ws, { recursive: true })
   fs.mkdirSync(paths.narrow, { recursive: true })
   fs.writeFileSync(paths.casFile, 'export const cas = 1\n')
   fs.writeFileSync(paths.sandboxFile, 'export const sandbox = 1\n')
  fs.mkdirSync(paths.fixture, { recursive: true })
  fs.mkdirSync(paths.shots, { recursive: true })
  fs.mkdirSync(paths.logs, { recursive: true })
  if (!fs.existsSync(paths.sharedFile)) fs.writeFileSync(paths.sharedFile, 'export const shared = 1\n')
  // Rename fixtures + mock LSP server live INSIDE the workspace (the mock reads
  // its fixture files as siblings of the script). Rewritten every run: the
  // partial-write phase mutates probe.ts, so a reused --root must restart clean.
  for (const [name, content] of Object.entries(renameFixtureSources())) fs.writeFileSync(path.join(paths.ws, name), content)
  fs.copyFileSync(path.join(HERE, 'mock-lsp-server.js'), path.join(paths.ws, 'mock-lsp-server.js'))
  // Isolation gate: the workspace must be its own management root, otherwise
  // the sessions would bind to an enclosing repository's authority and the
  // whole dual-GUI run would be a false isolation.
  const root = managementRootFor(paths.ws)
  if (root !== fs.realpathSync.native(paths.ws)) {
    throw new Error(`workspace management root escapes the disposable directory: ${root} !== ${paths.ws} — pick a DUAL_GUI_ROOT outside any git checkout`)
  }
   // The ancestor authority is created by role detection before a nested
   // session is bound. Do not invent a root override or a second authority.
  const homes = [path.join(config.root, 'home-a'), path.join(config.root, 'home-b')]
  const fixture = fixtureSources({ workspace: paths.ws, homes })
  for (const [name, content] of Object.entries(fixture)) fs.writeFileSync(path.join(paths.fixture, name), content)
  fs.writeFileSync(paths.settingsPatch, settingsPatchSource({ workspace: paths.ws, editable: config.matrix === 'opt-out' }))
  return paths
}

/** Open a session in the conversation view: expand workspace groups, click the
 * session row (stable data-row-key), wait for the Edit Lock entry. */
export async function openSessionInGui(instance, sessionId, timeouts, workspaceId) {
  // A restarted app re-shows onboarding modals, which cover the sidebar rows.
  // Keep dismissing while hunting for the row: the API-key dialog can re-render
  // after the first dismissal (async mount), so a one-shot click is not enough.
  // Safe: dismissModals never touches the Edit Lock panel's state-changing
  // buttons.
  await instance.cdp.evaluate('window.__dualGuiQa.dismissModals()').catch(() => 0)
  try {
    await waitFor(`${instance.name} session row`, async () => {
      await instance.cdp.evaluate('window.__dualGuiQa.dismissModals()').catch(() => 0)
      const outcome = await instance.cdp.evaluate(`window.__dualGuiQa.openSessionRow(${JSON.stringify(sessionId)}, ${JSON.stringify(workspaceId ?? null)})`)
      return outcome === 'clicked-row' ? true : null
    }, { timeoutMs: timeouts.phaseMs })
  } catch (error) {
    // Sidebar diagnosis is part of the failure: which rows/panels the GUI
    // actually rendered decides whether this is a driver or product bug.
    const debug = await instance.cdp.evaluate('window.__dualGuiQa.debugSidebar()').catch(() => null)
    throw new Error(`${error.message}; sidebar=${JSON.stringify(debug)}`)
  }
  await waitFor(`${instance.name} edit-lock entry`, async () => {
    const panel = await instance.cdp.evaluate('window.__dualGuiQa.panelState()')
    return panel?.entry ? panel : null
  }, { timeoutMs: timeouts.phaseMs })
}

/** Open the panel popover and click the primary action (Retry / Continue). */
async function clickPrimaryAction(instance, timeouts) {
  await instance.cdp.evaluate('window.__dualGuiQa.openPanel()')
  await waitFor(`${instance.name} primary action`, async () => {
    const panel = await instance.cdp.evaluate('window.__dualGuiQa.panelState()')
    return panel?.primary ? true : null
  }, { timeoutMs: timeouts.phaseMs })
  await instance.cdp.evaluate('window.__dualGuiQa.clickPrimary()')
}
/** Open the panel popover (refreshing an already-open one), then poll the
 * panel markers until `predicate` holds. The popover re-reads the view only on
 * toggle/action and the refresh lands asynchronously, so marker assertions
 * must POLL — a single read races the refresh and sees the previous state
 * (panel-paused missed its paused-until line exactly this way). */
async function waitPanelMarkers(instance, label, predicate, timeouts) {
  await instance.cdp.evaluate('window.__dualGuiQa.openPanel()')
  let last = null
  const result = await waitFor(`${instance.name} ${label}`, async () => {
    await instance.cdp.evaluate('window.__dualGuiQa.openPanel()').catch(() => null)
    const markers = await instance.markers()
    last = markers
    return markers?.panel === true && predicate(markers) ? markers : null
  }, { timeoutMs: timeouts.phaseMs, intervalMs: 500 }).catch((error) => {
    throw new Error(`${error.message}; last markers=${JSON.stringify(last)}`)
  })
  return result
}

/** Fail loudly unless the selected session's real command/done error is visible. */
export async function waitGuiCommand(instance, sessionId, resultText, timeouts) {
  let last = null
  try {
    return await waitFor(`${instance.name} visible command refusal`, async () => {
      last = await instance.cdp.evaluate(`window.__dualGuiQa.commandEvidence(${JSON.stringify(sessionId)}, ${JSON.stringify(resultText)}, true)`)
      return last?.selected && last?.matched && last?.visible && last?.detail && last?.error ? last : null
    }, { timeoutMs: timeouts.phaseMs, intervalMs: 500 })
  } catch (error) { throw new Error(`${error.message}; last DOM evidence=${JSON.stringify(last)}`) }
}
/** Screenshot the current view in dark theme, then light, then restore dark.
 * Theme switching rides the GUI's genuine system-preference path (see the
 * theme() page helper for the mechanism); each flip is proven by the body
 * palette attribute before the shutter fires. */
async function shotBothThemes(instance, name) {
  await instance.setColorScheme('dark')
  await instance.shot(`${name}-dark`)
  await instance.setColorScheme('light')
  await instance.shot(`${name}-light`)
  await instance.setColorScheme('dark')
}

/** Gate: zero Runtime.exceptionThrown events inside one phase's window. */
function assertNoNewExceptions(instance, since, label) {
  if (instance.exceptions !== since) {
    throw new Error(`${label}: ${instance.name} saw ${instance.exceptions - since} Runtime.exceptionThrown event(s) (see ${instance.eventsFile})`)
  }
}
export function assertPhaseExceptions(browsers, baselines, label) {
  for (let i = 0; i < browsers.length; i += 1) assertNoNewExceptions(browsers[i], baselines[i], label)
}

/** Poll the live view until `predicate` holds; returns the matching view. */
export async function waitView(instance, sessionId, label, predicate, timeouts) {
  return waitFor(`${instance.name} ${label}`, async () => {
    const payload = await instance.view(sessionId)
    if (payload?.ok !== true) return null
    return predicate(payload.value) ? payload.value : null
  }, { timeoutMs: timeouts.phaseMs, intervalMs: 700 })
}

/** Extract the lock generation from a QA command's success text, which embeds
 * the tool result JSON. Accepts `{"generation":2`, `generation: 2` and
 * `generation=2` spellings so a result-shape tweak fails loudly (null) rather
 * than passing on a stale literal match. */
export function generationOf(text) {
  const match = /generation["']?\s*[:=]\s*["']?(\d+)/.exec(typeof text === 'string' ? text : '')
  return match ? Number(match[1]) : null
}
/** Run one QA fixture command in a session; returns { kind, text }. */
export async function qaEdit(instance, sessionId, verb) {
  const result = await instance.rpc('commands/execute', { agentId: sessionId, line: `/qa-edit ${verb}`, submittedAttachments: [] })
  if (result.ok !== true) throw new Error(`${instance.name}: /qa-edit ${verb} rpc failed: ${JSON.stringify(result.error ?? result)}`)
  const commandResult = result.value?.result ?? result.value
  if (!commandResult || typeof commandResult.kind !== 'string') {
    throw new Error(`${instance.name}: /qa-edit ${verb} returned no command result: ${JSON.stringify(result.value)?.slice(0, 300)}`)
  }
  return commandResult
}

/** Create the workspace (idempotent) and one titled session in a GUI. */
export async function createSession(instance, workspaceId, agentPreset, title) {
  const created = await instance.rpc('session/create', { request: { workspaceId, agentPreset } })
  if (created.ok !== true || typeof created.value?.sessionId !== 'string') {
    throw new Error(`${instance.name}: session/create failed: ${JSON.stringify(created.error ?? created)}`)
  }
  const sessionId = created.value.sessionId
  const renamed = await instance.rpc('session/rename', { request: { sessionId, title } })
  if (renamed.ok !== true) throw new Error(`${instance.name}: session/rename failed: ${JSON.stringify(renamed.error ?? renamed)}`)
  return sessionId
}

/** Save the profile switch through the same authenticated settings Remote used
 * by the GUI; the running preset mount MUST NOT be hot-disposed by this save. */
async function saveEditLockSwitch(instance, enabled, extra = {}) {
  const described = await instance.rpc('settings/describe', {})
  if (described.ok !== true) throw new Error(`${instance.name}: settings/describe: ${JSON.stringify(described.error ?? described)}`)
  const candidates = described.value?.namespaces?.filter((row) => JSON.stringify(row.schema).includes('editLockEnabled')) ?? []
  if (candidates.length !== 1) throw new Error(`${instance.name}: expected one Edit Lock settings namespace; got ${candidates.map((row) => row.ns).join(', ')}`)
  const row = candidates[0]
  const ops = Object.entries({ editLockEnabled: enabled, ...extra }).map(([key, value]) => ({ op: 'set', path: [key], value }))
  const saved = await instance.rpc('settings/mutate', { ns: row.ns, ops, expectedRevision: row.revision })
  if (saved.ok !== true) throw new Error(`${instance.name}: settings/mutate: ${JSON.stringify(saved.error ?? saved)}`)
  if (saved.value?.user?.editLockEnabled !== enabled) throw new Error(`${instance.name}: switch save did not persist ${enabled}: ${JSON.stringify(saved.value?.user)}`)
  return { ns: row.ns, revision: saved.value.revision }
}

async function showOptOutSettings(instance, label, timeouts) {
  let last
  try {
    return await waitFor(`${instance.name} ${label} warning and maintenance`, async () => {
      last = await instance.cdp.evaluate('window.__dualGuiQa.settingsStep()')
      const state = label === 'saved-off' ? /已请求停用|Disable requested/ : /强制执行已停用|Enforcement disabled/
      return last?.group && /UNPROTECTED|不受保护/.test(last.warning ?? '') && /重新启用|re-enable/i.test(last.warning)
        && /维护|Maintenance/i.test(last.text ?? '') && state.test(last.text ?? '') ? last : null
    }, { timeoutMs: timeouts.phaseMs })
  } catch (error) { throw new Error(`${error.message}; last UI=${JSON.stringify(last)}`) }
}

/** The acceptance matrix. Phases mutate `state`; every row lands in `matrix`. */
async function runMatrix(config, paths, a, b, matrix) {
  const heavy = config.matrix !== 'core'
  const timeouts = config.timeouts
  const state = { initialSha: sha256File(paths.sharedFile) }
  const phase = async (name, skipped, fn) => {
    if (skipped) { matrix.record(name, 'SKIP', skipped === true ? 'not in this matrix' : skipped); return }
    const beforeA = a.exceptions
    const beforeB = b.exceptions
    try {
      const detail = await fn()
      assertPhaseExceptions([a, b], [beforeA, beforeB], name)
      matrix.record(name, 'PASS', `${detail ?? ''}; Runtime.exceptionThrown A=0 B=0`)
    } catch (error) {
      matrix.record(name, 'FAIL', sanitizeText(String(error?.stack ?? error), [...a.secrets, ...b.secrets]))
      throw error
    }
  }

  await phase('dual-boot', false, async () => {
    await a.provision()
    await b.provision()
    await a.startServer()
    await b.startServer()
    await a.startBrowser()
    await b.startBrowser()
    await a.openApp()
    await b.openApp()
    if (config.matrix === 'opt-out') {
      // The normal heavy matrix overlays weir-settings and makes the whole
      // namespace read-only. Here, save enabled and the LSP fixture into each
      // genuinely writable disposable profile, then RESTART both processes
      // before any session binds. No publisher exists yet at this stage.
      const lspServers = JSON.stringify({ typescript: { command: resolveNodeBinary(), args: [path.join(paths.ws, 'mock-lsp-server.js')], installHint: 'qa-fixture' } })
      const extra = { editLockAutoResume: false, notifyEnabled: false, worktreeEnabled: false, intentGateClassifier: 'regex', lspEnabled: true, lspServers }
      await saveEditLockSwitch(a, true, extra)
      await saveEditLockSwitch(b, true, extra)
      const old = [a.server, b.server]
      // A live browser observes the intentional connection outage as a React
      // exception. Close both CDP pages before shutdown and start fresh pages
      // after boot: zero-exception gates still apply to every running GUI.
      await a.stopBrowser()
      await b.stopBrowser()
      await b.stopServer()
      await a.stopServer()
      if (!(await waitForPortClosed(a.ports.web)) || !(await waitForPortClosed(b.ports.web))) throw new Error('initial config restart left a live Web port')
      await a.startServer()
      await b.startServer()
      assertFreshRestart({ previousPid: old[0].pid, nextPid: a.serverPid, exitCode: old[0].exitCode, signalCode: old[0].signalCode })
      assertFreshRestart({ previousPid: old[1].pid, nextPid: b.serverPid, exitCode: old[1].exitCode, signalCode: old[1].signalCode })
      await a.startBrowser()
      await b.startBrowser()
      await a.openApp()
      await b.openApp()
    }
    return `web ${a.ports.web}/${b.ports.web}, cdp ${a.ports.cdp}/${b.ports.cdp}`
  })

  await phase('role-detection', false, async () => {
    const wsA = await a.rpc('workspace/create', { request: { path: paths.ws } })
    if (wsA.ok !== true || typeof wsA.value?.workspace?.workspaceId !== 'string') throw new Error(`workspace/create A: ${JSON.stringify(wsA.error ?? wsA)}`)
    const wsB = await b.rpc('workspace/create', { request: { path: paths.ws } })
    if (wsB.ok !== true) throw new Error(`workspace/create B: ${JSON.stringify(wsB.error ?? wsB)}`)
    // A binds first and wins the publisher election; B must then read client.
    state.wsIdA = wsA.value.workspace.workspaceId
    state.wsIdB = wsB.value.workspace.workspaceId
    state.aSession = await createSession(a, state.wsIdA, 'weir', 'QA dual-gui A')
    // The restart opens this original session through the sidebar. A blank
    // session disappears when newer blanks exist; complete a real providerless
    // turn now so it remains a durable, addressable row after restart.
    const warm = await a.rpc('session/prompt', { request: { requestId: randomUUID(), sessionId: state.aSession, mode: 'queue', content: [{ type: 'text', text: 'QA: keep the original session addressable after restart' }] } })
    if (warm.ok !== true) throw new Error(`A warm prompt rejected: ${JSON.stringify(warm.error ?? warm)}`)
    await waitFor('original A warm turn settled', async () => {
      const list = await a.rpc('session/list', { _request: {} }).catch(() => null)
      const row = list?.value?.items?.find((item) => item.sessionId === state.aSession)
      return row && row.blank === false && row.running === false ? row : null
    }, { timeoutMs: timeouts.phaseMs })
    const aView = await waitView(a, state.aSession, 'publisher mode', (view) => view?.technical?.mode === 'publisher', timeouts)
    state.bSession = await createSession(b, state.wsIdB, 'weir-creative', 'QA dual-gui B')
    const bView = await waitView(b, state.bSession, 'client mode', (view) => view?.technical?.mode === 'client', timeouts)
    // Roles come from the reservation owner document, never from boot order.
    const owner = readReservationOwner(paths.ws)
    if (!owner) throw new Error('no publisher reservation after both sessions bound')
    if (owner.pid !== a.serverPid) throw new Error(`reservation owner pid ${owner.pid} != publisher server pid ${a.serverPid}`)
    const wsReal = fs.realpathSync.native(paths.ws)
    if (aView.technical.root !== wsReal || bView.technical.root !== wsReal) {
      throw new Error(`management roots diverge from the shared workspace: A=${aView.technical.root} B=${bView.technical.root} ws=${wsReal}`)
    }
    const endpoint = assertEndpoint(path.join(wsReal, AUTHORITY_DIR), config.platform)
    if (config.platform !== 'win32' && !fs.statSync(endpoint).isSocket()) throw new Error(`Edit Lock endpoint is not a Unix socket: ${endpoint}`)
    // Named pipes have no filesystem node: connect to prove the live endpoint.
    await new Promise((resolve, reject) => {
      const socket = net.connect(endpoint)
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', reject)
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error(`endpoint connection timed out: ${endpoint}`)) })
    })
    state.endpoint = endpoint
    state.publisher = a
    state.client = b
    await a.shot('role-publisher')
    await b.shot('role-client')
    return `publisher pid ${owner.pid} (A), B client; root ${wsReal}`
  })

  await phase('duplicate-refusal', false, async () => {
    // Switch B's session from weir-creative to weir through the same remote
    // endpoint the composer's preset menu calls: the session keeps its serving
    // creative-realm binding, so the weir realm bind must be refused.
    const selected = await b.rpc('agentPresets/select', { agentId: state.bSession, agentPreset: 'weir' })
    if (selected.ok !== true) throw new Error(`agentPresets/select: ${JSON.stringify(selected.error ?? selected)}`)
    const refused = await waitView(b, state.bSession, 'binding-duplicate', (view) =>
      view?.state === 'unavailable' && view?.bindingFailure?.code === 'binding-duplicate', timeouts)
    if (refused.bindingFailure.holderPid !== b.serverPid) {
      throw new Error(`duplicate holderPid ${refused.bindingFailure.holderPid} != B server pid ${b.serverPid}`)
    }
    await openSessionInGui(b, state.bSession, timeouts, state.wsIdB)
    await b.shot('duplicate-before-retry')
    await clickPrimaryAction(b, timeouts) // the real Retry connection button
    await sleep(1500)
    const after = await b.view(state.bSession)
    if (after?.ok !== true || after.value?.state !== 'unavailable' || after.value?.bindingFailure?.code !== 'binding-duplicate') {
      throw new Error(`Retry changed the refusal: ${JSON.stringify(after?.value)}`)
    }
    // A is untouched: still the live publisher.
    const aView = await a.view(state.aSession)
    if (aView?.ok !== true || aView.value?.technical?.mode !== 'publisher') throw new Error('A lost publisher mode during B duplicate')
    await b.shot('duplicate-retry-refused')
    // Restore B's session to its healthy creative binding for later phases.
    const back = await b.rpc('agentPresets/select', { agentId: state.bSession, agentPreset: 'weir-creative' })
    if (back.ok !== true) throw new Error(`agentPresets/select back: ${JSON.stringify(back.error ?? back)}`)
    await waitView(b, state.bSession, 'client again', (view) => view?.state === 'idle' && view?.technical?.mode === 'client', timeouts)
    return `binding-duplicate holderPid=${b.serverPid}; Retry refused; A publisher untouched`
  })

  await phase('acquire-conflict', false, async () => {
    const acquireA = await qaEdit(a, state.aSession, 'acquire')
    if (acquireA.kind !== 'success') throw new Error(`A acquire refused unexpectedly: ${acquireA.text}`)
    // A second session in the client process (same preset realm as a clean
    // client) asks for the same file and must be refused, naming A's session.
    const wsB2 = await b.rpc('workspace/create', { request: { path: paths.ws } })
    state.b2Session = await createSession(b, wsB2.value.workspace.workspaceId, 'weir', 'QA dual-gui B2')
    await waitView(b, state.b2Session, 'B2 client', (view) => view?.technical?.mode === 'client', timeouts)
    const acquireB2 = await qaEdit(b, state.b2Session, 'acquire')
    if (acquireB2.kind !== 'error') throw new Error(`B2 acquire unexpectedly succeeded: ${acquireB2.text}`)
    if (!acquireB2.text.includes(state.aSession)) throw new Error(`B2 refusal does not name A's session: ${acquireB2.text}`)
    const sha = sha256File(paths.sharedFile)
    if (sha !== state.initialSha) throw new Error(`shared file bytes changed during refused acquire: ${sha}`)
    const b2View = await b.view(state.b2Session)
    const foreignRow = b2View?.value?.files?.find((file) => file.mine === false)
    if (!foreignRow) throw new Error('B2 panel does not show the foreign-held file')
    await openSessionInGui(b, state.b2Session, timeouts, state.wsIdB)
    await b.shot('acquire-conflict-foreign-owner')
    return `A holds generation 1; B2 refused naming ${state.aSession}; sha256 unchanged`
  })

  await phase('generation-handoff', false, async () => {
    const releaseA = await qaEdit(a, state.aSession, 'release')
    if (releaseA.kind !== 'success') throw new Error(`A release refused: ${releaseA.text}`)
    const acquireB2 = await qaEdit(b, state.b2Session, 'acquire')
    if (acquireB2.kind !== 'success') throw new Error(`B2 acquire after release refused: ${acquireB2.text}`)
    const generation = generationOf(acquireB2.text)
    if (generation !== 2) {
      throw new Error(`B2 did not receive generation 2 (got ${generation}): ${acquireB2.text}`)
    }
    if (sha256File(paths.sharedFile) !== state.initialSha) throw new Error('shared file bytes changed during handoff')
    return 'A released generation 1; B2 holds generation 2'
  })

   await phase('version-cas-refusal', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
     if (managementRootFor(paths.narrow) !== paths.ws) throw new Error('nested session does not share the live management root')
     const nested = await b.rpc('workspace/create', { request: { path: paths.narrow } })
     if (nested.ok !== true || !nested.value?.workspace?.workspaceId) throw new Error(`nested workspace/create: ${JSON.stringify(nested)}`)
     state.narrowWorkspaceId = nested.value.workspace.workspaceId
     state.narrowSession = await createSession(b, state.narrowWorkspaceId, 'weir', 'QA nested CAS and sandbox')
     const view = await waitView(b, state.narrowSession, 'nested shared domain', (v) => v?.technical?.mode === 'client' && v.technical.root === paths.ws, timeouts)
     // Blank-session hero hides command flow nodes. A real zero-lock turn
     // makes the nested conversation durable before managed editor commands.
     const warm = await b.rpc('session/prompt', { request: { requestId: randomUUID(), sessionId: state.narrowSession, mode: 'queue', content: [{ type: 'text', text: 'QA: make nested refusal commands visible in this conversation' }] } })
     if (warm.ok !== true) throw new Error(`nested warm prompt rejected: ${JSON.stringify(warm.error ?? warm)}`)
     await waitFor('nested warm turn settled', async () => {
       const list = await b.rpc('session/list', { _request: {} }).catch(() => null)
       const row = list?.value?.items?.find((item) => item.sessionId === state.narrowSession)
       return row && row.blank === false && row.running === false ? row : null
     }, { timeoutMs: timeouts.phaseMs })
     const owner = readReservationOwner(paths.ws)
     if (!owner || owner.pid !== state.publisher.serverPid) throw new Error('CAS publisher reservation changed')
     const observed = await qaEdit(b, state.narrowSession, 'read cas-target.ts')
     if (observed.kind !== 'success') throw new Error(`CAS read did not observe version: ${observed.text}`)
     const changed = await qaEdit(b, state.narrowSession, 'cas-hash-edit')
     if (changed.kind !== 'success' || fs.readFileSync(paths.casFile, 'utf8') !== 'export const cas = 2\n') throw new Error(`positive CAS hash edit failed: ${changed.text}`)
     const beforeBytes = fs.readFileSync(paths.casFile)
     const before = authorityState(paths.ws)
     const refused = await qaEdit(b, state.narrowSession, 'cas-write')
     if (refused.kind !== 'error' || !/file changed since it was read/.test(refused.text)) throw new Error(`expected real FS_STALE_VERSION: ${JSON.stringify(refused)}`)
     const delta = assertRefusalDelta({ before, after: authorityState(paths.ws), target: paths.casFile, sessionId: state.narrowSession, cwd: paths.narrow, beforeBytes })
     await openSessionInGui(b, state.narrowSession, timeouts, state.narrowWorkspaceId)
     await waitPanelMarkers(b, 'CAS fenced file visible', (m) => m.files.some((row) => row.path === paths.casFile), timeouts)
     const dom = await waitGuiCommand(b, state.narrowSession, refused.text, timeouts)
     if (!(await b.cdp.evaluate('window.__dualGuiQa.panelState()'))?.panel) throw new Error('CAS command visible but panel closed before screenshot')
     await b.shot('version-cas-refused')
     return `pid=${owner.pid}; root=${view.technical.root}; generation=${delta.generation}; command=${refused.text}; DOM selected=${dom.selected} visible command/done error=${dom.error}; bytes sha256=${sha256File(paths.casFile)} unchanged; authority operations +1 unknown/resource fence, locks retained`
   })

   await phase('sandbox-backend-refusal', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
     const owner = readReservationOwner(paths.ws)
     if (!owner || owner.pid !== state.publisher.serverPid || managementRootFor(paths.narrow) !== paths.ws) throw new Error('sandbox target no longer in shared publisher domain')
     if (path.dirname(paths.sandboxFile) !== paths.ws || paths.sandboxFile.startsWith(`${paths.narrow}${path.sep}`)) throw new Error('sandbox target is not outside the narrow session root')
     const beforeBytes = fs.readFileSync(paths.sandboxFile)
     const before = authorityState(paths.ws)
     const refused = await qaEdit(b, state.narrowSession, 'sandbox-hash-edit')
     if (refused.kind !== 'error' || !/^QA sandbox-hash-edit refused:\ncannot write ".+": file access denied under workspace-write mode$/.test(refused.text) || refused.text.includes('outside management domain') || refused.text.includes('[sandbox:')) throw new Error(`expected raw fs sandbox backend refusal, not a domain denial or synthesized marker: ${JSON.stringify(refused)}`)
     const delta = assertRefusalDelta({ before, after: authorityState(paths.ws), target: paths.sandboxFile, sessionId: state.narrowSession, cwd: paths.narrow, beforeBytes })
     await openSessionInGui(b, state.narrowSession, timeouts, state.narrowWorkspaceId)
     await waitPanelMarkers(b, 'sandbox fenced file visible', (m) => m.files.some((row) => row.path === paths.sandboxFile), timeouts)
     const dom = await waitGuiCommand(b, state.narrowSession, refused.text, timeouts)
     if (!(await b.cdp.evaluate('window.__dualGuiQa.panelState()'))?.panel) throw new Error('sandbox command visible but panel closed before screenshot')
     await b.shot('sandbox-backend-refused')
     return `pid=${owner.pid}; root=${paths.ws}; sandboxRoot=${paths.narrow}; generation=${delta.generation}; command=${refused.text}; DOM selected=${dom.selected} visible command/done error=${dom.error}; bytes sha256=${sha256File(paths.sandboxFile)} unchanged; authority operations +1 unknown/resource fence, locks retained`
   })

  // -------------------------------------------------------------------
  // Panel-state acceptance (heavy only): the abnormal/attention, recovering,
  // paused and partial-write presentations produced through REAL authority
  // flows (a genuine provider-error turn, the real edit_lock_pause tool, the
  // real lsp_rename batch chain with the shipped writeText-fault probe
  // approach) — never injected view data. Each state is screenshotted in dark
  // AND light theme and asserted through locale-independent DOM markers.
  // Theme mechanism: the GUI's own switch is Settings > General > Appearance
  // (theme.setTheme persists ui-theme.preference light|dark|system, default
  // 'system'); the throwaway profiles carry no override, so the runtime's
  // prefers-color-scheme sensing decides — the driver flips that genuine path
  // with CDP Emulation.setEmulatedMedia and proves application via
  // body[data-ds-dark-theme] before every screenshot.
  // -------------------------------------------------------------------

  await phase('panel-states-setup', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    // A third session in the PUBLISHER process: the recovery driver and the
    // paused-until projection are owning-mount, in-memory state, so the
    // abnormal/paused states are only visible where the session lives.
    state.a3Session = await createSession(state.publisher, state.wsIdA, 'weir', 'QA panel states A3')
    const acquire = await qaEdit(state.publisher, state.a3Session, 'acquire qa-attention.ts')
    if (acquire.kind !== 'success') throw new Error(`A3 acquire refused: ${acquire.text}`)
    await openSessionInGui(state.publisher, state.a3Session, timeouts, state.wsIdA)
    return `A3 holds qa-attention.ts (generation 1) in publisher pid ${state.publisher.serverPid}`
  })

  await phase('panel-attention-abnormal', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    const exBase = state.publisher.exceptions
    // Genuine provider error: the throwaway profile has no LLM credential, so
    // a real user prompt runs a real turn that ends error{LlmFailure} while
    // A3 holds the file — the durable turn/end classification (recovery.js
    // onTurnEnd, kind 'error') marks the lock abnormal. No view injection.
    const prompt = await state.publisher.rpc('session/prompt', { request: { requestId: randomUUID(), sessionId: state.a3Session, mode: 'queue', content: [{ type: 'text', text: 'QA: provoke a provider error while holding a lock' }] } })
    if (prompt.ok !== true) throw new Error(`session/prompt rejected: ${JSON.stringify(prompt.error ?? prompt)}`)
    await waitView(state.publisher, state.a3Session, 'attention after provider error', (view) =>
      view?.state === 'attention' && view?.cleanupOnly === true
        && view?.files?.some((file) => file.mine === true && file.status === 'abnormal' && file.detail?.path === paths.attentionFile), timeouts)
    await openSessionInGui(state.publisher, state.a3Session, timeouts, state.wsIdA)
    const markers = await waitPanelMarkers(state.publisher, 'attention markers', (m) =>
      m.state === 'attention' && typeof m.cleanup === 'string' && m.cleanup.length > 0
        && m.files.some((file) => file.path === paths.attentionFile), timeouts)
    const row = markers.files.find((file) => file.path === paths.attentionFile)
    await shotBothThemes(state.publisher, 'panel-attention')
    assertNoNewExceptions(state.publisher, exBase, 'panel-attention-abnormal')
    return `attention + cleanup-only via genuine provider error; abnormal row: ${row.text.slice(0, 80)}`
  })

  await phase('panel-recovering', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    const exBase = state.publisher.exceptions
    // Immediately after classification the cleanup-only recovery driver owns
    // the session: its first attempt fires after the 15s backoff and fails
    // again (still no provider), charging attempts durably. attempts >= 1
    // proves the automatic recovery genuinely ran before any user action.
    const recovering = await waitView(state.publisher, state.a3Session, 'recovery attempt charged', (view) =>
      view?.state === 'attention' && view?.cleanupOnly === true && (view?.recovery?.attempts ?? 0) >= 1, timeouts)
    const markers = await waitPanelMarkers(state.publisher, 'recovering markers', (m) =>
      m.state === 'attention' && typeof m.cleanup === 'string' && m.cleanup.length > 0
        && typeof m.recovery === 'string' && m.recovery.length > 0, timeouts)
    await shotBothThemes(state.publisher, 'panel-recovering')
    assertNoNewExceptions(state.publisher, exBase, 'panel-recovering')
    return `cleanup-only recovery visible: attempts=${recovering.recovery.attempts}, elapsed=${recovering.recovery.elapsedSeconds}s; panel recovery line rendered`
  })

  await phase('panel-paused', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    const exBase = state.publisher.exceptions
    // edit_lock_pause through the real tool path while the recovery driver is
    // active: the owning mount projects an ABSOLUTE pausedUntil deadline.
    const pause = await qaEdit(state.publisher, state.a3Session, 'pause 10')
    if (pause.kind !== 'success' || !pause.text.includes('Paused for')) throw new Error(`pause refused: ${pause.text}`)
    const paused = await waitView(state.publisher, state.a3Session, 'pausedUntil projected', (view) =>
      view?.state === 'attention' && Number.isFinite(view?.pausedUntil) && view.pausedUntil > Date.now(), timeouts)
    const aheadMs = paused.pausedUntil - Date.now()
    if (aheadMs < 8 * 60_000 || aheadMs > 11 * 60_000) throw new Error(`pausedUntil is not the ~10 minute absolute deadline: ${aheadMs}ms ahead`)
    const markers = await waitPanelMarkers(state.publisher, 'paused markers', (m) =>
      m.state === 'attention' && typeof m.pausedUntil === 'string' && m.pausedUntil.length > 0, timeouts)
    const clockOk = await state.publisher.cdp.evaluate(`window.__dualGuiQa.pausedClockMatches(${JSON.stringify(paused.pausedUntil)})`)
    if (clockOk !== true) throw new Error(`panel paused line does not carry the absolute deadline clock: ${markers.pausedUntil}`)
    await shotBothThemes(state.publisher, 'panel-paused')
    assertNoNewExceptions(state.publisher, exBase, 'panel-paused')
    return `paused until ${new Date(paused.pausedUntil).toISOString()}; panel renders the absolute clock in both themes`
  })

  await phase('panel-partial-write', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    const exBase = state.publisher.exceptions
    // The editlock-lsp-rename midbatch approach in a real GUI session: real
    // /lsp on command, real protocol-fixture server, real lsp_rename batch —
    // with the shipped probe approach (wrap the real ctx.fs.writeText, fault
    // the second fixture-file write) armed by the QA command.
    state.a4Session = await createSession(state.publisher, state.wsIdA, 'weir', 'QA panel states A4')
    // A4 must not stay blank: the post-restart reclaim opens aSession through
    // the workspace's adopt-NEWEST-blank button, and a blank A4 (created later
    // than aSession) would hijack that path — openSessionInGui then times out
    // because aSession's row never renders. One real (providerless, failing)
    // turn with ZERO held locks flips the durable blank bit without any
    // edit-lock classification; wait for the turn to fully settle so the
    // command-driven rename below never races a running turn.
    const warm = await state.publisher.rpc('session/prompt', { request: { requestId: randomUUID(), sessionId: state.a4Session, mode: 'queue', content: [{ type: 'text', text: 'QA: warm this session so it is no longer blank' }] } })
    if (warm.ok !== true) throw new Error(`A4 warm prompt rejected: ${JSON.stringify(warm.error ?? warm)}`)
    await waitFor('A4 warm turn settled', async () => {
      // The optional request is wire-named _request (gateway/arguments-invalid
      // otherwise); the summary's durable blank bit flips at first turn start.
      const list = await state.publisher.rpc('session/list', { _request: {} }).catch(() => null)
      const row = list?.value?.items?.find((item) => item.sessionId === state.a4Session)
      return row && row.blank === false && row.running === false ? row : null
    }, { timeoutMs: timeouts.phaseMs })
    const lspOn = await state.publisher.rpc('commands/execute', { agentId: state.a4Session, line: '/lsp on', submittedAttachments: [] })
    const lspResult = lspOn.value?.result ?? lspOn.value
    if (lspOn.ok !== true || lspResult?.kind !== 'success') throw new Error(`/lsp on refused: ${JSON.stringify(lspResult ?? lspOn)}`)
    const rename = await qaEdit(state.publisher, state.a4Session, 'rename-midbatch')
    if (rename.kind !== 'error') throw new Error(`rename unexpectedly succeeded: ${rename.text}`)
    // Ownership-vs-outcome honesty: exactly the first file reported written,
    // the second reported not-written or uncertain, ownership retained, and
    // never a rollback claim.
    if (!/filesAlreadyWritten: \[[^\]]*probe\.ts/.test(rename.text)) throw new Error(`report does not name probe.ts as written: ${rename.text}`)
    if (!/files(NotWritten|Uncertain): \[[^\]]*probe-other\.ts/.test(rename.text)) throw new Error(`report does not name probe-other.ts as not-written/uncertain: ${rename.text}`)
    if (!rename.text.includes('ownership retained (no rollback)')) throw new Error(`report lacks the retained-ownership honesty line: ${rename.text}`)
    if (fs.readFileSync(paths.probeFile, 'utf8') !== 'export const qaMidBatch = 1\n') throw new Error('probe.ts does not carry the published rename (no rollback expected)')
    if (fs.readFileSync(paths.probeOtherFile, 'utf8') !== renameFixtureSources()['probe-other.ts']) throw new Error('probe-other.ts changed despite the aborted batch')
    await waitView(state.publisher, state.a4Session, 'retained batch locks', (view) =>
      [paths.probeFile, paths.probeOtherFile].every((file) =>
        view?.files?.some((row) => row.mine === true && row.detail?.path === file)), timeouts)
    await openSessionInGui(state.publisher, state.a4Session, timeouts, state.wsIdA)
    const markers = await waitPanelMarkers(state.publisher, 'partial-write markers', (m) =>
      [paths.probeFile, paths.probeOtherFile].every((file) => m.files.some((row) => row.path === file))
        && typeof m.ownershipHint === 'string' && m.ownershipHint.length > 0, timeouts)
    await shotBothThemes(state.publisher, 'panel-partial-write')
    // Honest aftermath: the cleanly-written file's lock releases normally,
    // while the UNCERTAIN file's lock is fenced — a plain release is refused
    // ('unresolved publication fence') because the byte outcome is unknown;
    // only the administrative recovery settles it. That refusal is part of the
    // acceptance, so the fenced lock stays retained into the SIGKILL phase
    // (which already tolerates retained locks on unrelated files).
    const releaseWritten = await qaEdit(state.publisher, state.a4Session, 'release probe.ts')
    if (releaseWritten.kind !== 'success') throw new Error(`written file release refused: ${releaseWritten.text}`)
    const releaseUncertain = await qaEdit(state.publisher, state.a4Session, 'release probe-other.ts')
    const uncertainFenced = releaseUncertain.kind !== 'success' && /unresolved publication fence/.test(releaseUncertain.text)
    const uncertainReleased = releaseUncertain.kind === 'success'
    if (!uncertainFenced && !uncertainReleased) throw new Error(`uncertain file release outcome unexpected: ${releaseUncertain.text}`)
    assertNoNewExceptions(state.publisher, exBase, 'panel-partial-write')
    return `midbatch fault: probe.ts written (lock released), probe-other.ts ${uncertainFenced ? 'uncertain and fence-refused on plain release' : 'released'}; bytes verified on disk`
  })

  await phase('sigkill-publisher-fail-closed', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    // Verify the reservation owner document BEFORE killing: only the recorded
    // publisher pid may be signalled, never an inferred one.
    const owner = readReservationOwner(paths.ws)
    if (!owner || owner.pid !== state.publisher.serverPid) {
      throw new Error(`owner.json pid ${owner?.pid} != publisher pid ${state.publisher.serverPid}; refusing SIGKILL`)
    }
    // The publisher's page has no acceptance role during the outage. Close it
    // before its Host is killed: otherwise React can throw while reconnecting
    // ('session-maybe' adapter unavailable), an actual console-exception FAIL.
    // Keep B's browser live to prove the surviving client's fail-closed UI.
    await state.publisher.stopBrowser()
    state.publisher.server.kill('SIGKILL')
    await waitFor('publisher exit', () => (state.publisher.server.exitCode !== null || state.publisher.server.signalCode ? true : null), { timeoutMs: 15000 })
    const lost = await waitView(state.client, state.b2Session, 'fail-closed', (view) => view?.state === 'unavailable', timeouts)
    // Fail-closed means no authority gain either: an acquire must not succeed.
    const denied = await qaEdit(state.client, state.b2Session, 'acquire')
    if (denied.kind !== 'error') throw new Error(`client acquired while publisher dead: ${denied.text}`)
    if (sha256File(paths.sharedFile) !== state.initialSha) throw new Error('shared file bytes changed after SIGKILL')
    const reservation = readReservationOwner(paths.ws)
    if (!reservation || reservation.pid !== owner.pid) throw new Error('dead publisher reservation missing or rewritten — it must be left untouched')
    await openSessionInGui(state.client, state.b2Session, timeouts, state.wsIdB)
    await state.client.shot('publisher-killed-client-unavailable')
    return `SIGKILL pid ${owner.pid}; client view unavailable (${lost.reason ?? 'no reason'}); acquire denied`
  })

  await phase('restart-reclaim-continue', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    const deadPid = state.publisher.serverPid
    const deadOwner = readReservationOwner(paths.ws)
    if (!deadOwner || deadOwner.pid !== deadPid || !Number.isFinite(deadOwner.leaseUntil)) {
      throw new Error(`dead owner doc missing/rewritten before restart (pid ${deadOwner?.pid} != ${deadPid}); refusing to drive a reclaim`)
    }
    // The dead owner's recorded lease is the deterministic reclaim clock, and
    // it must run out BEFORE the restarted server exists: the reserve attempt
    // fires during boot/session activation (creation listener / late-mount
    // catch-up), not at the driver's cue, and an early bind against a
    // still-current lease parks the process as a fail-closed client for its
    // whole lifetime (setupAgent never retries a non-duplicate startup
    // failure; retryBinding only handles binding-duplicate). Evidence: CI run
    // 38106848992 — restarted pid parked as client ('publisher unreachable'),
    // owner doc still the dead pid. So: wait first, restart second.
    const leaseWaitMs = Math.max(0, deadOwner.leaseUntil + 5000 - Date.now())
    if (leaseWaitMs > 0) await sleep(Math.min(leaseWaitMs, RESERVATION_LEASE_MS + 15000))
    await state.publisher.startServer() // same profile, same port: fresh token
    await state.publisher.startBrowser()
    await state.publisher.openApp()
    const restartedPid = state.publisher.serverPid
    // Reclaim needs a fresh bind attempt on the expired lease: nobody reserves
    // until a session activates, so open A's original session in the restarted
    // GUI (the activation binds the domain, finds the dead owner provably
    // gone, and takes over).
    await openSessionInGui(state.publisher, state.aSession, timeouts, state.wsIdA)
    // Deterministic bind trigger: a real edit-lock tool call in A's session
    // drives the shared setupAgent/lazy re-bind path even when the sidebar
    // click's activation lost a rendering race (the panel renders cold views
    // for non-live sessions, so an entry on screen proves nothing). The
    // result is diagnostic-only: a refused status still names why.
    const nudge = await qaEdit(state.publisher, state.aSession, 'status')
      .catch((error) => ({ kind: 'error', text: String(error?.message ?? error) }))
    // Poll the owner document with full diagnostics: a timeout must say what
    // the restarted publisher actually did (last observed doc, nudge result,
    // live view), and a reclaim by ANY third pid fails fast instead of
    // timing out silently on a pid-shape mismatch.
    const deadline = Date.now() + timeouts.phaseMs
    let owner = null
    let lastDoc = null
    let unexpected = null
    while (Date.now() < deadline) {
      try { lastDoc = readReservationOwner(paths.ws) } catch { lastDoc = undefined }
      if (lastDoc) {
        if (lastDoc.pid === restartedPid) { owner = lastDoc; break }
        if (lastDoc.pid !== deadPid) { unexpected = lastDoc; break }
      }
      await sleep(500)
    }
    if (unexpected) {
      throw new Error(`reservation reclaimed by unexpected pid ${unexpected.pid} (dead ${deadPid}, restarted ${restartedPid}): ${JSON.stringify(unexpected)}`)
    }
    if (!owner) {
      const view = await state.publisher.view(state.aSession).catch((error) => ({ viewError: String(error?.message ?? error) }))
      throw new Error(`timeout waiting for reservation reclaimed; restarted pid ${restartedPid} (dead ${deadPid}); last owner doc=${JSON.stringify(lastDoc ?? null)}; status nudge=${nudge.kind}: ${nudge.text}; publisher view=${JSON.stringify(view?.value ?? view ?? null)?.slice(0, 400)}`)
    }
    if (owner.pid === deadPid) throw new Error('reservation was not reclaimed by the restarted publisher')
    // B2's retained generation survives the publisher's death as stopped.
    const stopped = await waitView(state.client, state.b2Session, 'B2 stopped with retained lock', (view) =>
      view?.state === 'stopped' && view?.files?.some((file) => file.mine === true && file.status === 'user-interrupted'), timeouts)
    await openSessionInGui(state.client, state.b2Session, timeouts, state.wsIdB)
    await state.client.shot('recovered-retained-lock')
    await clickPrimaryAction(state.client, timeouts) // Continue editing (resume + confirm --all)
    const resumed = await waitView(state.client, state.b2Session, 'B2 editing after Continue', (view) =>
      // B2 lives in the client process: after the reclaim it reconnects to the
      // restarted publisher as a client realm, still holding generation 2.
      (view?.state === 'editing' || view?.state === 'idle') && view?.technical?.mode === 'client'
        && view?.files?.some((file) => file.mine === true && file.status === 'active'), timeouts)
    const epochBefore = stopped.technical?.executionEpoch ?? 0
    const epochAfter = resumed.technical?.executionEpoch ?? 0
    if (!(epochAfter > epochBefore)) throw new Error(`Continue did not advance the epoch (${epochBefore} -> ${epochAfter})`)
    await state.client.shot('recovered-continued')
    return `owner pid ${deadPid} -> ${owner.pid}; B2 retained gen2, Continue epoch ${epochBefore} -> ${epochAfter}`
  })

  await phase('post-recovery-handoff', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    // A's original session was already activated to drive the reclaim: on the
    // restarted process it is the local PUBLISHER realm, cold-restored to
    // stopped, and still holds nothing. It must not acquire while B2's
    // continued generation 2 is active.
    await waitView(state.publisher, state.aSession, 'A rebound stopped publisher', (view) =>
      view?.technical?.mode === 'publisher' && (view?.state === 'stopped' || view?.state === 'idle'), timeouts)
    // A stopped session acquires nothing: the trusted Continue comes first
    // (same as the proven manual run), and the lock refusal follows it.
    await openSessionInGui(state.publisher, state.aSession, timeouts, state.wsIdA)
    await clickPrimaryAction(state.publisher, timeouts)
    await waitView(state.publisher, state.aSession, 'A idle publisher after Continue', (view) =>
      view?.technical?.mode === 'publisher' && view?.state === 'idle', timeouts)
    const denied = await qaEdit(state.publisher, state.aSession, 'acquire')
    if (denied.kind !== 'error' || !denied.text.includes(state.b2Session)) {
      throw new Error(`A acquire while B2 holds: ${denied.kind} ${denied.text}`)
    }
    const release = await qaEdit(state.client, state.b2Session, 'release')
    if (release.kind !== 'success') throw new Error(`B2 release refused: ${release.text}`)
    const acquired = await qaEdit(state.publisher, state.aSession, 'acquire')
    if (acquired.kind !== 'success' || generationOf(acquired.text) !== 3) {
      throw new Error(`A did not receive generation 3: ${acquired.kind} ${acquired.text}`)
    }
    const finalRelease = await qaEdit(state.publisher, state.aSession, 'release')
    if (finalRelease.kind !== 'success') throw new Error(`A final release refused: ${finalRelease.text}`)
    if (sha256File(paths.sharedFile) !== state.initialSha) throw new Error('shared file bytes changed across recovery handoff')
    return 'A denied while B2 holds; release -> A gen3 -> release; bytes unchanged'
  })

  await phase('core-release', heavy ? 'covered by post-recovery-handoff in heavy' : null, async () => {
    const release = await qaEdit(b, state.b2Session, 'release')
    if (release.kind !== 'success') throw new Error(`B2 release refused: ${release.text}`)
    if (sha256File(paths.sharedFile) !== state.initialSha) throw new Error('shared file bytes changed in core matrix')
    return 'B2 released generation 2; bytes unchanged'
  })

  if (config.matrix === 'opt-out') await phase('opt-out-saved-off-running', false, async () => {
    const owner = readReservationOwner(paths.ws)
    if (!owner || owner.pid !== a.serverPid) throw new Error(`unexpected publisher reservation before opt-out: ${JSON.stringify(owner)}`)
    state.oldOwner = await createSession(a, state.wsIdA, 'weir', 'QA retained owner before opt-out')
    const acquired = await qaEdit(a, state.oldOwner, 'acquire')
    if (acquired.kind !== 'success') throw new Error(`old owner acquire: ${acquired.text}`)
    // The earlier midbatch uncertainty was correctly settled after SIGKILL
    // (proven-dead publisher). Seed a NEW lost acknowledgement now while this
    // publisher lives, so the off restart inherits a genuine unknown fence.
    state.unknownOwner = await createSession(a, state.wsIdA, 'weir', 'QA unknown publisher outcome')
    const unknown = await qaEdit(a, state.unknownOwner, 'write-unknown')
    if (unknown.kind !== 'error' || !/acknowledgement lost AFTER/.test(unknown.text) || fs.readFileSync(path.join(paths.ws, 'qa-unknown.ts'), 'utf8') !== 'export const unknown = 2\n') throw new Error(`unknown publication fixture did not dispatch: ${unknown.text}`)
    const savedA = await saveEditLockSwitch(a, false)
    const savedB = await saveEditLockSwitch(b, false)
    const status = await a.cdp.evaluate('window.__dualGuiQa.maintenance()')
    if (status?.ok !== true || status.value?.state !== 'disable-requested' || status.value.restartRequired !== true) throw new Error(`save-off was not pending restart: ${JSON.stringify(status)}`)
    const observed = await qaEdit(b, state.b2Session, 'read')
    if (observed.kind !== 'success') throw new Error(`client pre-write read refused: ${observed.text}`)
    const refusedWrite = await qaEdit(b, state.b2Session, 'write')
    const refusedHash = await qaEdit(b, state.b2Session, 'hash-edit initial')
    if (refusedWrite.kind !== 'error' || !refusedWrite.text.includes(state.oldOwner) || refusedHash.kind !== 'error' || !refusedHash.text.includes(state.oldOwner) || sha256File(paths.sharedFile) !== state.initialSha) throw new Error(`running process lost ownership protection: ${JSON.stringify({ refusedWrite, refusedHash })}`)
    state.authorityFile = path.join(paths.ws, AUTHORITY_DIR, 'snapshot.json')
    state.authorityBefore = fs.readFileSync(state.authorityFile)
    const history = inspectAuthority(paths.ws)
    const activeOwner = JSON.parse(state.authorityBefore.toString('utf8')).payload.state.locks.some((lock) => lock.owner === state.oldOwner)
    const unknownFence = history.snapshot?.unresolved.some((op) => op.key.sessionId === state.unknownOwner && op.admissionBlocked === true)
    if (history.presence !== 'valid' || !activeOwner || !unknownFence) throw new Error(`active owner and unresolved fenced unknown not durable before restart: ${JSON.stringify(history.snapshot?.counts)}`)
    const ui = await showOptOutSettings(a, 'saved-off', timeouts)
    await a.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1500, deviceScaleFactor: 1, mobile: false })
    const frame = await a.cdp.evaluate('window.__dualGuiQa.frameOptOut("saved-off")')
    if (frame?.visible !== true) throw new Error(`saved-off screenshot would clip warning or maintenance: ${JSON.stringify(frame)}`)
    await shotBothThemes(a, 'opt-out-saved-off')
    if (!/已请求停用|Disable requested/.test(ui.text)) throw new Error('saved-off maintenance state not visibly rendered')
    return `settings saved off A=${savedA.revision} B=${savedB.revision}; still protected in pid ${owner.pid}; authority sha256=${sha256File(state.authorityFile)}`
  })

  if (config.matrix === 'opt-out') await phase('opt-out-real-restart', false, async () => {
    const previous = [a.server, b.server]
    const owner = readReservationOwner(paths.ws)
    if (!owner || owner.pid !== a.serverPid) throw new Error('publisher owner changed before graceful restart')
    await a.stopBrowser()
    await b.stopBrowser()
    const bStop = await b.stopServer()
    const aStop = await a.stopServer()
    if (!bStop.graceful || !aStop.graceful) throw new Error('opt-out restart requires graceful process exits')
    if (!(await waitForPortClosed(a.ports.web)) || !(await waitForPortClosed(b.ports.web))) throw new Error('old Web process port remains live')
    if (readReservationOwner(paths.ws) !== null) throw new Error('reservation remained after graceful shutdown; never delete it')
    // Graceful shutdown may persist interrupted status/revision. Pin the exact
    // image AFTER the old processes exit; off boots/edits must not alter it.
    state.authorityBefore = fs.readFileSync(state.authorityFile)
    const history = inspectAuthority(paths.ws)
    if (history.presence !== 'valid' || !history.snapshot.retainedLocks.some((lock) => lock.owner === state.oldOwner) || !history.snapshot.unresolved.some((op) => op.key.sessionId === state.unknownOwner && op.admissionBlocked === true)) throw new Error('shutdown lost retained owner/unknown fence')
    await a.startServer()
    await b.startServer()
    assertFreshRestart({ previousPid: previous[0].pid, nextPid: a.serverPid, exitCode: previous[0].exitCode, signalCode: previous[0].signalCode })
    assertFreshRestart({ previousPid: previous[1].pid, nextPid: b.serverPid, exitCode: previous[1].exitCode, signalCode: previous[1].signalCode })
    await a.startBrowser()
    await b.startBrowser()
    await a.openApp()
    await b.openApp()
    const status = await a.cdp.evaluate('window.__dualGuiQa.maintenance()')
    if (status?.ok !== true || status.value?.state !== 'disabled' || status.value.restartRequired !== false) throw new Error(`effective-off restart not observed: ${JSON.stringify(status)}`)
    if (!fs.readFileSync(state.authorityFile).equals(state.authorityBefore)) throw new Error('restart changed durable authority bytes')
    state.offSession = await createSession(a, state.wsIdA, 'weir', 'QA ordinary off editor')
    return `A ${previous[0].pid}->${a.serverPid}; B ${previous[1].pid}->${b.serverPid}; effective-off; old snapshot unchanged; reservation naturally absent`
  })

  if (config.matrix === 'opt-out') await phase('opt-out-gui-and-editing', false, async () => {
    const before = fs.readFileSync(state.authorityFile)
    const observed = await qaEdit(a, state.offSession, 'read')
    if (observed.kind !== 'success') throw new Error(`off-period pre-write read refused: ${observed.text}`)
    const offWrite = await qaEdit(a, state.offSession, 'write')
    if (offWrite.kind !== 'success' || fs.readFileSync(paths.sharedFile, 'utf8') !== 'export const shared = 2\n') throw new Error(`ordinary off write failed: ${offWrite.text}`)
    const offHash = await qaEdit(a, state.offSession, 'hash-edit')
    if (offHash.kind !== 'success' || fs.readFileSync(paths.sharedFile, 'utf8') !== 'export const shared = 3\n') throw new Error(`ordinary off hash_edit failed: ${offHash.text}`)
    if (!fs.readFileSync(state.authorityFile).equals(before)) throw new Error('off-period edits modified durable authority snapshot')
    if (readReservationOwner(paths.ws) !== null) throw new Error('effective-off unexpectedly acquired a reservation')
    const ui = await showOptOutSettings(a, 'effective-off', timeouts)
    await a.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1500, deviceScaleFactor: 1, mobile: false })
    const frame = await a.cdp.evaluate('window.__dualGuiQa.frameOptOut("effective-off")')
    if (frame?.visible !== true) throw new Error(`effective-off screenshot would clip warning or maintenance: ${JSON.stringify(frame)}`)
    await shotBothThemes(a, 'opt-out-effective-off')
    return `write + hash_edit succeeded; sha256=${sha256File(paths.sharedFile)}; authority unchanged; warning=${ui.warning}`
  })

  if (config.matrix === 'opt-out') await phase('opt-out-reenable-fail-closed', false, async () => {
    const before = sha256File(paths.sharedFile)
    await saveEditLockSwitch(a, true)
    await saveEditLockSwitch(b, true)
    const old = [a.server, b.server]
    const owner = readReservationOwner(paths.ws)
    if (owner !== null) throw new Error(`unexpected reservation before re-enable: ${JSON.stringify(owner)}`)
    await a.stopBrowser()
    await b.stopBrowser()
    const bStop = await b.stopServer(), aStop = await a.stopServer()
    if (!bStop.graceful || !aStop.graceful || readReservationOwner(paths.ws) !== null) throw new Error('re-enable shutdown did not naturally release reservation')
    await a.startServer()
    await b.startServer()
    assertFreshRestart({ previousPid: old[0].pid, nextPid: a.serverPid, exitCode: old[0].exitCode, signalCode: old[0].signalCode })
    assertFreshRestart({ previousPid: old[1].pid, nextPid: b.serverPid, exitCode: old[1].exitCode, signalCode: old[1].signalCode })
    await a.startBrowser()
    await b.startBrowser()
    await a.openApp()
    await b.openApp()
    state.newOwner = await createSession(a, state.wsIdA, 'weir', 'QA reenabled newcomer')
    await waitView(a, state.newOwner, 're-enabled publisher', (view) => view?.technical?.mode === 'publisher', timeouts)
    const observed = await qaEdit(a, state.newOwner, 'read')
    if (observed.kind !== 'success') throw new Error(`re-enabled pre-write read refused: ${observed.text}`)
    const owned = await qaEdit(a, state.newOwner, 'write')
    const hashRefusal = await qaEdit(a, state.newOwner, 'hash-edit after')
    if (owned.kind !== 'error' || !owned.text.includes(state.oldOwner) || hashRefusal.kind !== 'error' || !hashRefusal.text.includes(state.oldOwner)) throw new Error(`re-enable did not block old owner: ${JSON.stringify({ owned, hashRefusal })}`)
    const history = inspectAuthority(paths.ws)
    const unknown = history.snapshot?.unresolved.find((op) => op.key.sessionId === state.unknownOwner)
    const recovery = history.snapshot?.adminRecoveries.find((row) => row.owner === state.unknownOwner)
    // A proven-dead former publisher is automatically recovered on enabled
    // startup. This does NOT erase its unknown outcome from history; don't
    // pretend its fence still blocks after the manager has safely settled it.
    if (history.presence !== 'valid' || !unknown || unknown.admissionBlocked !== false || !recovery || !/proven dead/.test(recovery.reason)) throw new Error(`unknown outcome missing or settled without proven-dead recovery: ${JSON.stringify({ unknown, recovery })}`)
    if (sha256File(paths.sharedFile) !== before) throw new Error('re-enable refusal changed file bytes')
    return `old owner ${state.oldOwner} blocks write/hash_edit; unknown history retained with proven-dead recovery; sha256 unchanged`
  })
  return state
}

/** Graceful teardown: stop both servers and browsers, then verify every port
 * closed and the publisher reservation disappeared NATURALLY. Never deletes a
 * reservation — a leftover is a FAIL, not a cleanup opportunity. */
export async function teardown(instances, config, paths, matrix) {
  const problems = []
  let allGraceful = true
  // Stop order is part of the contract: browsers first (no authority state),
  // then servers in REVERSE binding order — the publisher drains last, after
  // every client realm has disconnected, so its reservation release reaches
  // quiescence instead of timing out against live client channels.
  const stopOne = async (instance, method) => {
    try {
      const stop = typeof instance[method] === 'function' ? await instance[method]() : await instance.stop()
      if (stop && stop.graceful === false) allGraceful = false
    } catch (error) {
      problems.push(`${instance.name} ${method}: ${error?.message ?? error}`)
    }
  }
  for (const instance of instances) await stopOne(instance, 'stopBrowser')
  for (const instance of [...instances].reverse()) await stopOne(instance, 'stopServer')
  for (const instance of instances) {
    for (const [kind, port] of Object.entries({ web: instance.ports.web, cdp: instance.ports.cdp })) {
      if (!(await waitForPortClosed(port, { timeoutMs: config.portTimeoutMs ?? 20000 }))) problems.push(`${instance.name} ${kind} port ${port} still listening`)
    }
  }
  if (allGraceful) {
    if (readReservationOwner(paths.ws) !== null) {
      problems.push('publisher reservation still present after graceful stop (left untouched on purpose)')
    }
  }
  // A forced stop (win32 TerminateProcess by design, or an escalated SIGKILL
  // on POSIX) legitimately strands the reservation: report the absence check
  // as not-applicable with the actual platform instead of a win32 literal.
  const forcedDetail = `forced stop (${config.platform ?? process.platform}): port checks only; reservation-absence assertion not applicable (never deleted)`
  matrix.record('teardown', problems.length === 0 ? 'PASS' : 'FAIL', problems.join('; ') || (allGraceful ? 'ports closed; reservation naturally absent' : forcedDetail))
  return problems
}

export function writeReport(config, paths, matrix, extra = {}) {
  const counts = { PASS: matrix.passed.length, FAIL: matrix.failed.length, SKIP: matrix.rows.filter((row) => row.status === 'SKIP').length }
  const lines = [
    '# Dual-GUI Edit Lock acceptance report',
    '',
    `date: ${new Date().toISOString()}`,
    `platform: ${config.platform ?? process.platform} ${process.arch}, node ${process.version}`,
    `runner image: ${config.runner?.image ?? 'local (not a CI image)'}`,
    `runner version: ${config.runner?.version ?? 'local (not a CI image)'}`,
    `dsh invocation: ${config.dsh?.description ?? 'unknown'}`,
    `dsh version: ${extra.dshVersion ?? 'not measured'}`,
    `matrix: ${config.matrix}`,
    `qa root: ${paths.root}`,
    `workspace: ${paths.ws}`,
    `shared file sha256: ${extra.sha ?? 'not measured'}`,
    `endpoint: ${extra.endpoint ?? 'not measured'}`,
    `phase counts: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.SKIP} SKIP`,
    ...((extra.processes ?? []).map((proc) => `process ${proc.name}: pid=${proc.pid ?? 'not started'} exit=${proc.exitCode ?? 'null'} signal=${proc.signalCode ?? 'null'}`)),
    ...((extra.panelShots ?? []).map((shot) => `screenshot ${shot.name}: ${shot.bytes} bytes sha256=${shot.sha256}`)),
    '',
    '| phase | verdict | detail |',
    '|---|---|---|',
    ...matrix.rows.map((row) => `| ${row.name} | ${row.status} | ${String(row.detail).replaceAll('|', '\\|').replaceAll('\n', '<br>').slice(0, ['version-cas-refusal', 'sandbox-backend-refusal'].includes(row.name) ? 1200 : 400)} |`),
    '',
  ]
  const file = path.join(paths.root, 'dual-gui-report.md')
  fs.writeFileSync(file, `${sanitizeText(lines.join('\n'), extra.secrets ?? [])}\n`)
  return file
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] !== 'run') {
    console.error('usage: dual-gui-qa.mjs run [--heavy | --opt-out] [--root <dir>] [--keep]')
    process.exitCode = 2
    return
  }
  const config = resolveConfig({ argv: argv.slice(1) })
  config.runner = { image: process.env.ImageOS ?? 'local (not a CI image)', version: process.env.ImageVersion ?? 'local (not a CI image)' }
  const version = spawnSync(config.dsh.command, [...config.dsh.prefixArgs, '--version'], { encoding: 'utf8', timeout: 15000 })
  if (version.error || version.status !== 0 || !version.stdout.trim()) throw new Error(`DSH CLI version probe failed: ${version.error?.message ?? version.status}`)
  const dshVersion = version.stdout.trim()
  const paths = prepareQaRoot(config)
  const ports = await allocateFreePorts(4)
  const makeInstance = (name, webPort, cdpPort) => {
    const instance = new GuiInstance(name, { ...config, paths })
    instance.ports = { web: webPort, cdp: cdpPort }
    return instance
  }
  const a = makeInstance('a', ports[0], ports[2])
  const b = makeInstance('b', ports[1], ports[3])
  const matrix = createMatrix()
  const secrets = []
  console.log(`dual-gui-qa: root ${paths.root}`)
  console.log(`dual-gui-qa: matrix ${config.matrix}; dsh: ${config.dsh.description}; chrome: ${config.chrome}`)
  let failure = null
  let endpoint = null
  let panelShots = []
  try {
    const state = await runMatrix(config, paths, a, b, matrix)
    endpoint = state.endpoint
    if (config.matrix !== 'core') {
      panelShots = verifyPanelShots(paths.shots)
      panelShots.push(...verifyPanelShots(paths.shots, ['version-cas-refused', 'sandbox-backend-refused']))
      matrix.record('panel-screenshot-evidence', 'PASS', '8/8 panel and 2/2 refusal PNG screenshots verified')
    } else matrix.record('panel-screenshot-evidence', 'SKIP', 'heavy only')
    if (config.matrix === 'opt-out') {
      panelShots.push(...verifyOptOutShots(paths.shots))
      matrix.record('opt-out-screenshot-evidence', 'PASS', '4/4 saved-off/effective-off dark/light PNG screenshots verified')
    }
  } catch (error) {
    failure = error
    if (config.matrix !== 'core' && matrix.failed.length === 0) matrix.record('panel-screenshot-evidence', 'FAIL', String(error?.message ?? error))
  }
  secrets.push(...a.secrets, ...b.secrets)
  // Teardown ALWAYS runs, green or red.
  try { await teardown([a, b], config, paths, matrix) } catch (error) { matrix.record('teardown', 'FAIL', String(error?.message ?? error)) }
  const processes = [...a.processes, ...b.processes].map(({ name, child }) => ({ name, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }))
  for (const proc of processes) if (proc.exitCode === null && proc.signalCode === null) matrix.record('process-exit', 'FAIL', `${proc.name} pid ${proc.pid} did not exit`)
  const report = writeReport(config, paths, matrix, {
    sha: sha256File(paths.sharedFile), endpoint, dshVersion, processes, panelShots, secrets,
  })
  for (const row of matrix.rows) console.log(`${row.status === 'PASS' ? 'PASS' : row.status} ${row.name}${row.detail ? ` — ${sanitizeText(row.detail, secrets)}` : ''}`)
  console.log(`dual-gui-qa: report ${report}`)
  console.log(`dual-gui-qa: ${matrix.passed.length} PASS, ${matrix.failed.length} FAIL, ${matrix.rows.length - matrix.passed.length - matrix.failed.length} SKIP`)
  if (failure || matrix.failed.length > 0) process.exitCode = 1
  if (process.exitCode !== 1 && !config.keep && process.env.DUAL_GUI_KEEP !== '1') {
    // Evidence is the deliverable: default keeps everything; only an explicit
    // DUAL_GUI_CLEAN=1 removes a green root.
    if (process.env.DUAL_GUI_CLEAN === '1') fs.rmSync(paths.root, { recursive: true, force: true })
  }
  // A CLI driver must not linger on half-closed CDP sockets: everything
  // evidence-shaped is already written synchronously, so exit explicitly.
  process.exit(process.exitCode ?? 0)
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  main().catch((error) => {
    console.error(`dual-gui-qa: fatal: ${String(error?.stack ?? error)}`)
    process.exitCode = 1
  })
}
