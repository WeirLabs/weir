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
//     -> SIGKILL the verified publisher PID (owner.json checked first)
//     -> surviving client fail-closed (view unavailable, no authority gain)
//     -> restart same profile: reservation reclaimed, generation retained,
//        real Continue editing click restores the same session
//     -> old client rebinds stopped, still denied until release -> gen N+1
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
//   node plugins/weir-test-harness/src/dual-gui-qa.mjs run [--heavy] [--root <dir>] [--keep]
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
//   DUAL_GUI_MATRIX     'core' (default) | 'heavy'
//   DUAL_GUI_KEEP       '1' keeps the QA root even after a green run
//
// Exit code: 0 iff every executed matrix row is PASS and teardown is clean.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { managementRootFor } from '../../weir-harness/src/edit-lock/domains.js'
import { RESERVATION_LEASE_MS } from '../../weir-harness/src/edit-lock/reservation.js'

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

/** The QA-only user-command fixture, generated per run so the workspace root
 * and profile homes are baked in as literals. Self-refuses outside the
 * throwaway homes/root (never install into a formal profile). */
export function fixtureSources({ workspace, homes }) {
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
export const inject = ['agents', 'commands', 'tools']

const ROOT = ${JSON.stringify(workspace)}
const QA_HOMES = ${JSON.stringify(homes)}

export function apply(ctx) {
  if (process.env.WEIR_QA_FIXTURE !== '1' ||
      !QA_HOMES.includes(process.env.DSH_HOME) ||
      realpathSync.native(ROOT) !== ROOT) {
    throw new Error('QA command refuses a non-isolated profile or workspace')
  }
  const off = ctx.commands.register({
    name: 'qa-edit',
    description: 'QA-only user action exercising actual managed editors on one disposable file.',
    input: { hint: 'acquire | write | release | status' },
    async handler(invocation) {
      try {
        const agent = invocation.agent
        if (!agent || ctx.agents.get(agent.id) !== agent ||
            realpathSync.native(agent.session?.header?.cwd) !== ROOT) {
          throw new Error('QA command requires an exact live agent in the external workspace')
        }
        const verb = String(invocation.rawInput ?? '').trim()
        const names = { acquire: 'edit_lock_acquire', write: 'write', release: 'edit_lock_release', status: 'edit_lock_status' }
        const tool = names[verb]
        if (!tool) throw new Error('Only acquire, write, release or status are allowed')
        const argumentsValue = verb === 'status' ? {} : verb === 'write'
          ? { file_path: 'qa-shared.ts', content: 'export const shared = 2\\n' }
          : { file_path: 'qa-shared.ts' }
        const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
          name: tool,
          arguments: argumentsValue,
          callId: \`qa-\${randomUUID()}\`,
          agent,
          signal: invocation.signal,
        }))
        return result.isError
          ? { kind: 'error', text: \`QA \${verb} refused: \${result.error?.message ?? 'unknown'}\` }
          : { kind: 'success', text: \`QA \${verb} succeeded: \${JSON.stringify(result.value ?? {})}\` }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  })
  return () => { off() }
}
`
  return { 'package.json': `${JSON.stringify(manifest, null, 2)}\n`, 'cordis.patch.yml': patch, 'index.js': index }
}

/** Settings overlay: edit lock on, auto-resume off, side features quiet. */
export function settingsPatchSource() {
  return `# Test-only overlay. Never load in the user's desktop profile.
- id: weir-settings
  name: 'weir-harness/settings'
  config:
    editLockEnabled: true
    editLockAutoResume: false
    notifyEnabled: false
    worktreeEnabled: false
    intentGateClassifier: regex
# Mark the preview welcome notice as seen so its modal never covers the panel
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
      if (entry.getAttribute('aria-expanded') !== 'true') entry.click()
      return 'clicked'
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
class GuiInstance {
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
  }

  get secrets() { return this.secretList }

  /** The launch token is memory-only; registering it here arms redaction for
   * every log sink that reads the list lazily. */
  setToken(token) { this.token = token; this.secretList = token ? [token] : [] }

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
    try {
      await this.cdp.evaluate('window.__dualGuiQa.dismissModals()').catch(() => 0)
      await this.cdp.screenshot(file)
    } catch { /* screenshots are evidence aids, never gates */ }
    return file
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
  const matrix = flag('--heavy') ? 'heavy' : (env.DUAL_GUI_MATRIX === 'heavy' ? 'heavy' : 'core')
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

/** Materialize the QA root: shared workspace, fixture, settings patch, dirs. */
export function prepareQaRoot(config) {
  const paths = {
    root: config.root,
    ws: path.join(config.root, 'ws'),
    fixture: path.join(config.root, 'fixture'),
    shots: path.join(config.root, 'shots'),
    logs: path.join(config.root, 'logs'),
    settingsPatch: path.join(config.root, 'edit-lock-on.patch.yml'),
    sharedFile: path.join(config.root, 'ws', 'qa-shared.ts'),
  }
  fs.mkdirSync(paths.ws, { recursive: true })
  fs.mkdirSync(paths.fixture, { recursive: true })
  fs.mkdirSync(paths.shots, { recursive: true })
  fs.mkdirSync(paths.logs, { recursive: true })
  if (!fs.existsSync(paths.sharedFile)) fs.writeFileSync(paths.sharedFile, 'export const shared = 1\n')
  // Isolation gate: the workspace must be its own management root, otherwise
  // the sessions would bind to an enclosing repository's authority and the
  // whole dual-GUI run would be a false isolation.
  const root = managementRootFor(paths.ws)
  if (root !== fs.realpathSync.native(paths.ws)) {
    throw new Error(`workspace management root escapes the disposable directory: ${root} !== ${paths.ws} — pick a DUAL_GUI_ROOT outside any git checkout`)
  }
  const homes = [path.join(config.root, 'home-a'), path.join(config.root, 'home-b')]
  const fixture = fixtureSources({ workspace: paths.ws, homes })
  for (const [name, content] of Object.entries(fixture)) fs.writeFileSync(path.join(paths.fixture, name), content)
  fs.writeFileSync(paths.settingsPatch, settingsPatchSource())
  return paths
}

/** Open a session in the conversation view: expand workspace groups, click the
 * session row (stable data-row-key), wait for the Edit Lock entry. */
async function openSessionInGui(instance, sessionId, timeouts, workspaceId) {
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

/** Poll the live view until `predicate` holds; returns the matching view. */
async function waitView(instance, sessionId, label, predicate, timeouts) {
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
async function qaEdit(instance, sessionId, verb) {
  const result = await instance.rpc('commands/execute', { agentId: sessionId, line: `/qa-edit ${verb}`, submittedAttachments: [] })
  if (result.ok !== true) throw new Error(`${instance.name}: /qa-edit ${verb} rpc failed: ${JSON.stringify(result.error ?? result)}`)
  const commandResult = result.value?.result ?? result.value
  if (!commandResult || typeof commandResult.kind !== 'string') {
    throw new Error(`${instance.name}: /qa-edit ${verb} returned no command result: ${JSON.stringify(result.value)?.slice(0, 300)}`)
  }
  return commandResult
}

/** Create the workspace (idempotent) and one titled session in a GUI. */
async function createSession(instance, workspaceId, agentPreset, title) {
  const created = await instance.rpc('session/create', { request: { workspaceId, agentPreset } })
  if (created.ok !== true || typeof created.value?.sessionId !== 'string') {
    throw new Error(`${instance.name}: session/create failed: ${JSON.stringify(created.error ?? created)}`)
  }
  const sessionId = created.value.sessionId
  const renamed = await instance.rpc('session/rename', { request: { sessionId, title } })
  if (renamed.ok !== true) throw new Error(`${instance.name}: session/rename failed: ${JSON.stringify(renamed.error ?? renamed)}`)
  return sessionId
}

/** The acceptance matrix. Phases mutate `state`; every row lands in `matrix`. */
async function runMatrix(config, paths, a, b, matrix) {
  const heavy = config.matrix === 'heavy'
  const timeouts = config.timeouts
  const state = { initialSha: sha256File(paths.sharedFile) }
  const phase = async (name, skipped, fn) => {
    if (skipped) { matrix.record(name, 'SKIP', skipped === true ? 'not in this matrix' : skipped); return }
    try {
      const detail = await fn()
      matrix.record(name, 'PASS', detail ?? '')
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

  await phase('sigkill-publisher-fail-closed', heavy ? null : 'heavy only (set DUAL_GUI_MATRIX=heavy)', async () => {
    // Verify the reservation owner document BEFORE killing: only the recorded
    // publisher pid may be signalled, never an inferred one.
    const owner = readReservationOwner(paths.ws)
    if (!owner || owner.pid !== state.publisher.serverPid) {
      throw new Error(`owner.json pid ${owner?.pid} != publisher pid ${state.publisher.serverPid}; refusing SIGKILL`)
    }
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

function writeReport(config, paths, matrix, extra = {}) {
  const lines = [
    '# Dual-GUI Edit Lock acceptance report',
    '',
    `date: ${new Date().toISOString()}`,
    `platform: ${process.platform} ${process.arch}, node ${process.version}`,
    `matrix: ${config.matrix}`,
    `qa root: ${paths.root}`,
    `workspace: ${paths.ws}`,
    ...Object.entries(extra).map(([key, value]) => `${key}: ${value}`),
    '',
    '| phase | verdict | detail |',
    '|---|---|---|',
    ...matrix.rows.map((row) => `| ${row.name} | ${row.status} | ${String(row.detail).replaceAll('|', '\\|').slice(0, 400)} |`),
    '',
  ]
  const file = path.join(paths.root, 'dual-gui-report.md')
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] !== 'run') {
    console.error('usage: dual-gui-qa.mjs run [--heavy] [--root <dir>] [--keep]')
    process.exitCode = 2
    return
  }
  const config = resolveConfig({ argv: argv.slice(1) })
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
  try {
    const state = await runMatrix(config, paths, a, b, matrix)
    secrets.push(...a.secrets, ...b.secrets)
    void state
  } catch (error) {
    failure = error
    secrets.push(...a.secrets, ...b.secrets)
  }
  // Teardown ALWAYS runs, green or red.
  try { await teardown([a, b], config, paths, matrix) } catch (error) { matrix.record('teardown', 'FAIL', String(error?.message ?? error)) }
  const report = writeReport(config, paths, matrix, {
    'shared file sha256': sha256File(paths.sharedFile),
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
