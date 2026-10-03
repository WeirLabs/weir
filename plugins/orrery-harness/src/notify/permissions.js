// macOS notification permission: detection and the two guided actions behind
// the settings-page permission panel. The panel is a convenience around a
// system-owned decision, so everything here is read-only except two FIXED
// actions (a test notification, opening the Notifications settings page);
// nothing here takes user text into a command, and nothing tries to flip the
// switch on the user's behalf.
//
// Detection reads `com.apple.ncprefs` — an undocumented system preference —
// so the classification is best effort and says "unknown" rather than guess.
// Plain ESM, ctx-free: the process spawner and the platform are injected, so
// tests never touch the real system.

/**
 * Notifications are delivered by the DeepSeek Harness page, so macOS attributes
 * them to DSH itself — that is the sender whose permission matters. (The
 * osascript fallback is attributed to Script Editor, which has no entry in the
 * system's Notifications list; it is a last resort, not something to manage.)
 */
export const SENDER = Object.freeze({ bundleId: 'com.deepseek.dsh', name: 'DeepSeek Harness' })

/** The Notifications page of System Settings (macOS 13+). */
export const SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'

/** Absolute paths: a GUI process has a minimal PATH (S21). */
export const OSASCRIPT = '/usr/bin/osascript'
export const OPEN = '/usr/bin/open'

/** The only actions the endpoint accepts; no action takes an argument. */
export const ACTIONS = Object.freeze(['test', 'open-settings'])

/** The fixed text of the test notification. */
export const TEST_NOTE = Object.freeze({
  title: 'Test notification',
  body: 'If you can see this, DeepSeek Harness notifications are working.',
  urgent: true,
})

const COMMAND_TIMEOUT_MS = 8_000
/** UNAuthorizationOptions.alert: the sender may show banners/alerts. */
const AUTH_ALERT = 4

/** JXA read of the sender's entry; the only interpolation is the constant bundle id. */
const PROBE_SCRIPT = [
  "ObjC.import('Foundation');",
  "ObjC.import('CoreFoundation');",
  'function field(dict, key) { const value = dict.objectForKey(key); return value.isNil() ? null : ObjC.unwrap(value); }',
  "const live = $.CFPreferencesCopyAppValue($('apps'), $('com.apple.ncprefs'));",
  "if (!live) throw new Error('notification preferences are unreadable');",
  'const apps = ObjC.castRefToObject(live);',
  'let entry = null;',
  `for (let i = 0; i < apps.count; i++) { const app = apps.objectAtIndex(i); if (field(app, 'bundle-id') === '${SENDER.bundleId}') { entry = { auth: field(app, 'auth'), flags: field(app, 'flags') }; break; } }`,
  'JSON.stringify({ ok: true, entry: entry });',
].join('\n')

/**
 * @typedef {'granted' | 'denied' | 'unknown'} PermissionState
 * @typedef {{ state: PermissionState, reason: string, auth: number | null, flags: number | null }} Permission
 */

/**
 * Parse the probe's stdout (osascript prints a JXA result to stdout or
 * stderr depending on the version, so the caller passes whichever has text).
 *
 * @param {unknown} text
 * @returns {{ ok: true, entry: { auth: number | null, flags: number | null } | null } | { ok: false }}
 */
export function parseProbeOutput(text) {
  if (typeof text !== 'string') return { ok: false }
  const line = text.split('\n').map((part) => part.trim()).filter(Boolean).pop()
  if (line === undefined) return { ok: false }
  try {
    const parsed = JSON.parse(line)
    if (parsed?.ok !== true) return { ok: false }
    const entry = parsed.entry
    if (entry === null) return { ok: true, entry: null }
    if (typeof entry !== 'object') return { ok: false }
    const number = (/** @type {unknown} */ value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
    return { ok: true, entry: { auth: number(entry.auth), flags: number(entry.flags) } }
  } catch {
    return { ok: false }
  }
}

/**
 * Classify the sender's notification entry. Deliberately conservative:
 *
 * - `auth` carries the alert bit → granted.
 * - `auth` is a non-zero number without it, or an explicit 0 → denied.
 * - no entry, or `auth` absent (the system default — Apple's own senders sit
 *   in this state while allowed or not yet asked) → unknown. A style flag is
 *   never promoted to "granted": it does not track `auth` reliably.
 * - the read failed → unknown.
 *
 * The user's own sighting of a test notification is the final word.
 *
 * @param {ReturnType<typeof parseProbeOutput>} probe
 * @returns {Permission}
 */
export function classifyNotificationPermission(probe) {
  if (!probe?.ok) return { state: 'unknown', reason: 'unreadable', auth: null, flags: null }
  const entry = probe.entry
  if (entry === null) return { state: 'unknown', reason: 'no-record', auth: null, flags: null }
  const { auth, flags } = entry
  if (auth === null) return { state: 'unknown', reason: 'default', auth, flags }
  if (auth & AUTH_ALERT) return { state: 'granted', reason: 'alerts-allowed', auth, flags }
  return { state: 'denied', reason: 'not-allowed', auth, flags }
}

/**
 * @typedef {(file: string, args: string[], options: object, callback: (error: any, stdout?: any, stderr?: any) => void) => unknown} ExecFile
 */

/**
 * @param {ExecFile} execFile
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function run(execFile, file, args) {
  return new Promise((resolve, reject) => {
    try {
      execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Read the sender's permission. Never throws: an unreadable preference is an
 * `unknown` result, not an error.
 *
 * @param {object} deps
 * @param {ExecFile} deps.execFile
 * @returns {Promise<Permission>}
 */
export async function readNotificationPermission({ execFile }) {
  try {
    const { stdout, stderr } = await run(execFile, OSASCRIPT, ['-l', 'JavaScript', '-e', PROBE_SCRIPT])
    return classifyNotificationPermission(parseProbeOutput(stdout.trim() ? stdout : stderr))
  } catch {
    return classifyNotificationPermission({ ok: false })
  }
}

/**
 * Run one whitelisted action. Rejects an unknown action before any command
 * runs; rejects with the failure otherwise (the caller shows it).
 *
 * The test notification goes through the REAL delivery path (`sendTest`, the
 * same channel real notifications use), so what the user sees is what they
 * will get.
 *
 * @param {string} action - one of {@link ACTIONS}
 * @param {object} deps
 * @param {ExecFile} deps.execFile
 * @param {() => unknown} [deps.sendTest]
 * @returns {Promise<void>}
 */
export async function runPermissionAction(action, { execFile, sendTest }) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown permission action "${action}"`)
  if (action === 'open-settings') {
    await run(execFile, OPEN, [SETTINGS_URL])
    return
  }
  if (typeof sendTest !== 'function') throw new Error('test notifications are not available in this composition')
  await sendTest()
}
