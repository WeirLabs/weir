// Storage location and unit layout of the Orrery-owned capability store
// (session-capability-manager design D2). The root lives under the DSH home,
// never inside a user workspace, and is resolved only from the host
// `profileContext` service; there is no fallback path.
import { isAbsolute, join } from 'node:path'

/** Unit names, ids and keys: no dots, so `<name>.<token>.tmp` parsing stays exact. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** Files inside an immutable content generation (flat; dots allowed). */
const FILE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** @param {unknown} value */
export const isSegment = value => typeof value === 'string' && SEGMENT.test(value)
/** @param {unknown} value */
export const isFileSegment = value => typeof value === 'string' && FILE_SEGMENT.test(value) && !value.includes('..')

/**
 * @param {unknown} profileContext - value of `ctx.get('profileContext')`
 * @returns {{ supported: true, root: string } | { supported: false, reason: 'profile-context-unavailable'|'profile-context-invalid' }}
 */
export function resolveStoreRoot(profileContext) {
  if (profileContext === null || typeof profileContext !== 'object') {
    return { supported: false, reason: 'profile-context-unavailable' }
  }
  const { home, name } = /** @type {{ home?: unknown, name?: unknown }} */ (profileContext)
  if (typeof home !== 'string' || !isAbsolute(home) || !isSegment(name)) {
    return { supported: false, reason: 'profile-context-invalid' }
  }
  return { supported: true, root: join(home, 'orrery', 'profiles', /** @type {string} */ (name), 'capabilities') }
}

/**
 * @typedef {{ kind: 'selection', sessionId: string }
 *   | { kind: 'content', sessionId: string }
 *   | { kind: 'defaults', workspaceKey: string }
 *   | { kind: 'preset', scope: 'global', presetId: string }
 *   | { kind: 'preset', scope: 'workspace', workspaceKey: string, presetId: string }
 *   | { kind: 'mcp-registry' }
 *   | { kind: 'distribution', scope: string }} Unit
 */

/**
 * Map a unit to its directory segments and file stem. Every unit owns its own
 * record, lock and revision; no two units share a stem in one directory.
 * @param {Unit} unit
 * @returns {{ key: string, segments: string[], name: string }}
 */
export function unitLayout(unit) {
  const u = /** @type {Record<string, unknown>} */ (unit ?? {})
  const need = (/** @type {unknown[]} */ ...values) => {
    if (!values.every(isSegment)) throw new TypeError(`invalid capability store unit: ${JSON.stringify(unit)}`)
  }
  switch (u.kind) {
    case 'selection':
    case 'content':
      need(u.sessionId)
      return layout(['sessions', /** @type {string} */ (u.sessionId)], u.kind)
    case 'defaults':
      need(u.workspaceKey)
      return layout(['workspaces', /** @type {string} */ (u.workspaceKey)], 'defaults')
    case 'preset':
      if (u.scope === 'global') {
        need(u.presetId)
        return layout(['presets', 'global'], /** @type {string} */ (u.presetId))
      }
      if (u.scope === 'workspace') {
        need(u.workspaceKey, u.presetId)
        return layout(['presets', 'workspace', /** @type {string} */ (u.workspaceKey)], /** @type {string} */ (u.presetId))
      }
      break
    case 'mcp-registry':
      return layout(['mcp'], 'registry')
    case 'distribution':
      need(u.scope)
      return layout(['distribution', /** @type {string} */ (u.scope)], 'active')
  }
  throw new TypeError(`invalid capability store unit: ${JSON.stringify(unit)}`)
}

/** @param {string[]} segments @param {string} name */
const layout = (segments, name) => ({ key: [...segments, name].join('/'), segments, name })
