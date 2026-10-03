// Platform notification commands: pure builders from a note to an executable
// invocation. The host runtime is a Node-mode child process (no Electron
// `Notification` API), so system notifications go through each platform's
// stock command. User-controlled text never reaches a shell: it travels as
// argv (macOS, Linux) or environment (Windows), and each script reads it as
// DATA.

/** The name notification centers show where the platform lets us pick one. */
export const APP_NAME = 'DeepSeek Harness'

/**
 * @typedef {{ file: string, args: string[], env?: Record<string, string> }} Command
 */

/**
 * macOS: `osascript` with an argv-driven handler — title/body are `item N of
 * argv`, never interpolated into script source, so quotes and backslashes in
 * session titles are inert. The first argument is always a template title
 * (never dash-leading), so option parsing stops before user text.
 *
 * @param {{ title: string, body: string }} note
 * @param {boolean} sound
 * @returns {Command}
 */
function darwin(note, sound) {
  const display = sound
    ? 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"'
    : 'display notification (item 2 of argv) with title (item 1 of argv)'
  return {
    file: 'osascript',
    args: ['-e', 'on run argv', '-e', display, '-e', 'end run', note.title, note.body],
  }
}

/**
 * Linux: libnotify's `notify-send`. `--` ends option parsing so a body that
 * starts with a dash stays text.
 *
 * @param {{ title: string, body: string, urgent: boolean }} note
 * @param {boolean} sound
 * @returns {Command}
 */
function linux(note, sound) {
  return {
    file: 'notify-send',
    args: [
      `--app-name=${APP_NAME}`,
      `--urgency=${note.urgent ? 'normal' : 'low'}`,
      ...(sound && note.urgent ? ['--hint=string:sound-name:message-new-instant'] : []),
      '--',
      note.title,
      note.body,
    ],
  }
}

/** PowerShell source of the Windows toast; reads title/body from the environment. */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$title = [System.Security.SecurityElement]::Escape($env:DSH_NOTIFY_TITLE)',
  '$body = [System.Security.SecurityElement]::Escape($env:DSH_NOTIFY_BODY)',
  "$audio = if ($env:DSH_NOTIFY_SILENT -eq '1') { '<audio silent=\"true\"/>' } else { '' }",
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml("<toast><visual><binding template=\'ToastGeneric\'><text>$title</text><text>$body</text></binding></visual>$audio</toast>")',
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
].join('\n')

/**
 * Windows: a WinRT toast through PowerShell. The script is passed as
 * `-EncodedCommand` (base64 UTF-16LE) so no quoting layer touches it; the
 * note text arrives through environment variables.
 *
 * @param {{ title: string, body: string }} note
 * @param {boolean} sound
 * @returns {Command}
 */
function win32(note, sound) {
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    env: {
      DSH_NOTIFY_TITLE: note.title,
      DSH_NOTIFY_BODY: note.body,
      DSH_NOTIFY_SILENT: sound ? '0' : '1',
    },
  }
}

/**
 * The delivery command for a platform, or `undefined` when the platform has
 * no supported notification path.
 *
 * @param {string} platform - a `process.platform` value
 * @param {{ title: string, body: string, urgent: boolean }} note
 * @param {{ sound: boolean }} options
 * @returns {Command | undefined}
 */
export function buildCommand(platform, note, { sound }) {
  switch (platform) {
    case 'darwin':
      return darwin(note, sound)
    case 'linux':
      return linux(note, sound)
    case 'win32':
      return win32(note, sound)
    default:
      return undefined
  }
}
