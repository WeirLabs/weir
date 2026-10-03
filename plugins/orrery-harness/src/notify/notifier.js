// Notification delivery: runs the platform command from ./commands.js. The
// process spawner and the platform are injected so tests never touch the real
// OS notification center. Delivery is best-effort by contract: a failure is
// logged once per distinct cause and NEVER propagates into a session turn.
import { execFile as nodeExecFile } from 'node:child_process'
import { buildCommand } from './commands.js'

/** A notification command that has not finished by now is abandoned. */
const DELIVERY_TIMEOUT_MS = 10_000

/**
 * @typedef {import('./commands.js').Command} Command
 * @typedef {(file: string, args: string[], options: object, callback: (error: any) => void) => unknown} ExecFile
 */

/**
 * @param {object} options
 * @param {string} [options.platform] - defaults to process.platform
 * @param {ExecFile} [options.execFile] - defaults to node:child_process execFile
 * @param {{ warn?: (message: string) => void } | undefined} [options.logger]
 * @param {Record<string, string | undefined>} [options.env] - base environment for the command
 * @returns {{ supported: boolean, send(note: { title: string, body: string, urgent: boolean }, options: { sound: boolean }): boolean }}
 */
export function createNotifier({ platform = process.platform, execFile = /** @type {ExecFile} */ (nodeExecFile), logger, env = process.env } = {}) {
  /** Distinct failure causes already reported (one warning per cause). */
  const reported = new Set()
  /** @param {string} cause */
  const warnOnce = (cause) => {
    if (reported.has(cause)) return
    reported.add(cause)
    logger?.warn?.(`notify: ${cause}`)
  }
  const supported = buildCommand(platform, { title: '', body: '', urgent: false }, { sound: false }) !== undefined

  return {
    supported,
    /**
     * Fire one notification. Returns whether a command was started; the
     * outcome of the command itself is observed only through the warning.
     */
    send(note, { sound }) {
      const command = buildCommand(platform, note, { sound })
      if (command === undefined) {
        warnOnce(`system notifications are not supported on platform "${platform}"`)
        return false
      }
      try {
        execFile(
          command.file,
          command.args,
          { timeout: DELIVERY_TIMEOUT_MS, windowsHide: true, env: { ...env, ...command.env } },
          (/** @type {any} */ error) => {
            if (!error) return
            warnOnce(
              error.code === 'ENOENT'
                ? `"${command.file}" is not installed, so system notifications are unavailable`
                : `"${command.file}" failed: ${error.message ?? error}`,
            )
          },
        )
        return true
      } catch (/** @type {any} */ error) {
        warnOnce(`could not start "${command.file}": ${error?.message ?? error}`)
        return false
      }
    },
  }
}
