// Notification permission endpoints: the host half of the settings-page
// permission panel (macOS only). Wired from the profile-level settings row
// through ctx.inject so no new package subpath is needed (S19) and the
// connection service resolves from that scope (S20). The platform and the
// process spawner are injected for tests.
import { execFile as nodeExecFile } from 'node:child_process'
import { jsonResponse, readJsonBody } from '../lsp/admin.js'
import { ACTIONS, readNotificationPermission, runPermissionAction, SENDER } from './permissions.js'

const STATUS_PATH = '/api/weir-notify/permissions/status'
const ACTION_PATH = '/api/weir-notify/permissions/action'
const PULL_PATH = '/api/weir-notify/web/pull'
const ACK_PATH = '/api/weir-notify/web/ack'

/** @param {string} code @param {string} message @param {number} status */
function failure(code, message, status) {
  return jsonResponse({ ok: false, error: { code: `weir-notify/${code}`, message } }, status)
}

/**
 * Register the two endpoints on a scope carrying `connection`. The status
 * endpoint answers on every platform (`supported: false` hides the panel);
 * the action endpoint only runs on macOS.
 *
 * @param {any} scope - an injected scope with `connection`, and optional `logger`
 * @param {object} [deps]
 * @param {string} [deps.platform]
 * @param {import('./permissions.js').ExecFile} [deps.execFile]
 * @param {{ pull(holdMs?: number, signal?: AbortSignal): Promise<any>, ack(id: string, result: string): boolean } | undefined} [deps.channel] - the web delivery channel; absent = no page endpoints
 * @param {() => unknown} [deps.sendTest] - sends the test notification through the real delivery path
 * @returns {() => void} idempotent disposer
 */
export function registerNotifyPermissionEndpoints(scope, { platform = process.platform, execFile = /** @type {any} */ (nodeExecFile), channel, sendTest } = {}) {
  const connection = scope?.connection
  if (!connection?.fetch?.register) {
    scope?.logger?.warn?.('weir-notify: connection unavailable — permission endpoints not registered')
    return () => {}
  }
  const mac = platform === 'darwin'
  const disposers = [
    connection.fetch.register({
      path: STATUS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        if (!mac) return jsonResponse({ ok: true, value: { supported: false, platform } })
        try {
          const permission = await readNotificationPermission({ execFile })
          return jsonResponse({ ok: true, value: { supported: true, platform, sender: SENDER, ...permission } })
        } catch (/** @type {any} */ error) {
          return failure('internal', error?.message ?? String(error), 500)
        }
      },
    }),
    connection.fetch.register({
      path: ACTION_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (/** @type {any} */ request) => {
        if (!mac) return failure('unsupported', `permission actions are only available on macOS (host is ${platform})`, 400)
        const body = await readJsonBody(request)
        const action = body?.action
        if (typeof action !== 'string' || !ACTIONS.includes(action)) {
          return failure('invalid', `body needs { action } with one of: ${ACTIONS.join(', ')}`, 400)
        }
        try {
          await runPermissionAction(action, { execFile, sendTest })
          return jsonResponse({ ok: true, value: { action } })
        } catch (/** @type {any} */ error) {
          return failure('failed', error?.message ?? String(error), 500)
        }
      },
    }),
  ]
  if (channel) {
    disposers.push(
      // The page's long poll: answers a note, or null after the hold time.
      connection.fetch.register({
        path: PULL_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (/** @type {any} */ request) => {
          try {
            const pulled = await channel.pull(undefined, request?.signal)
            return jsonResponse({ ok: true, value: pulled })
          } catch (/** @type {any} */ error) {
            return failure('internal', error?.message ?? String(error), 500)
          }
        },
      }),
      // The page reports what the browser did with a note it took.
      connection.fetch.register({
        path: ACK_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (/** @type {any} */ request) => {
          const body = await readJsonBody(request)
          if (typeof body?.id !== 'string' || typeof body?.result !== 'string') return failure('invalid', 'body needs { id, result }', 400)
          return jsonResponse({ ok: true, value: { matched: channel.ack(body.id, body.result) } })
        },
      }),
    )
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }
}

/**
 * Wire the endpoints from the profile-level settings row. Nothing registers
 * when the connection service is absent (headless compositions). Returns an
 * idempotent disposer.
 *
 * @param {any} ctx
 * @param {object} [deps] - forwarded to {@link registerNotifyPermissionEndpoints}
 * @returns {() => void}
 */
export function wireNotifyPermissions(ctx, deps) {
  let off = () => {}
  ctx.inject?.(['connection'], (/** @type {any} */ scope) => {
    off = registerNotifyPermissionEndpoints(scope, deps)
    return off
  })
  return () => off()
}
