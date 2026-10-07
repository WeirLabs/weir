// Environment facts endpoint: the host half of the settings page's
// environment-gated rows (`when: { env: ... }`). Read-only and secret-free —
// it answers the process platform, nothing else. Wired from the profile-level
// settings row through ctx.inject so no new package subpath is needed (S19),
// same pattern as wireLspAdmin / wireNotifyPermissions. The platform is
// injected for tests.
import { jsonResponse } from '../lsp/admin.js'

const ENV_PATH = '/api/weir-settings/env'

/**
 * Register the env endpoint on a scope carrying `connection`. Answers
 * `{ ok: true, value: { platform } }` on every platform. Nothing registers
 * when the connection service is absent (headless compositions).
 *
 * @param {any} scope - an injected scope with `connection`, and optional `logger`
 * @param {object} [deps]
 * @param {string} [deps.platform]
 * @returns {() => void} idempotent disposer
 */
export function registerEnvEndpoints(scope, { platform = process.platform } = {}) {
  const connection = scope?.connection
  if (!connection?.fetch?.register) {
    scope?.logger?.warn?.('weir-settings: connection unavailable — env endpoint not registered')
    return () => {}
  }
  const dispose = connection.fetch.register({
    path: ENV_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse({ ok: true, value: { platform } }),
  })
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (typeof dispose === 'function') dispose()
  }
}

/**
 * Wire the env endpoint from the profile-level settings row. Returns an
 * idempotent disposer.
 *
 * @param {any} ctx
 * @param {object} [deps] - forwarded to {@link registerEnvEndpoints}
 * @returns {() => void}
 */
export function wireEnvAdmin(ctx, deps) {
  let off = () => {}
  ctx.inject?.(['connection'], (/** @type {any} */ scope) => {
    off = registerEnvEndpoints(scope, deps)
    return off
  })
  return () => off()
}
