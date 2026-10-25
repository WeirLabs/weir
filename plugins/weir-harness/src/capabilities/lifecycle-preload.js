// Task 6.1 preload (design D6): at plugin apply, load the EFFECTIVE selections
// of KNOWN sessions into the lifecycle memory snapshot, so the agent/created
// listener's synchronous read hits memory instead of disk. This module is the
// async boundary — it runs at mount time, NEVER inside the agent/created
// listener. A slow or failed preload costs one blocking synchronous disk read
// per agent creation (the listener's miss path), never correctness. Records
// that do not decode are pre-marked BLOCKED, so the fail-closed state is ready
// before the first agent is created.
//
// "Effective" is the same priority the synchronous read path applies: the
// accepted selection when one exists, otherwise the durable inherited snapshot
// (a fork of a fork, or a fork whose source only resolved an initial set). Both
// are loaded here, because a cold session read (Badge/manager receipt, MCP
// gate, Skill catalog) must report the inherited set rather than an empty one
// until the fork's agent is recreated. A corrupt record of EITHER unit blocks
// the session — never a fall-through to the other one.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isSegment } from './store/paths.js'
import { openCapabilityStore } from './store/store.js'

/** @param {unknown} error */
const message = error => (error instanceof Error ? error.message : String(error))

/** @param {unknown} payload @returns {number} capturedAt used by the inherited restore */
const capturedAtOf = payload => {
  const value = /** @type {Record<string, unknown>} */ (payload ?? {}).capturedAt
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * @param {{
 *   lifecycle: {
 *     publish(sessionId: string, next: { revision: number, skills?: unknown[], mcpServers?: string[],
 *       captured?: { parentSessionId: string, parentRevision: number | null, capturedAt: number } | null }): unknown,
 *     markBlocked(sessionId: string, reason: 'corrupt'|'unknown-schema'|'torn'|'unreadable'): unknown,
 *     peek(sessionId: string): unknown,
 *   },
 *   profileContext?: unknown,
 *   platform?: string,
 *   store?: { support: { supported: boolean, root?: string, reason?: string }, read(unit: unknown): Promise<any> },
 *   warn?: (text: string) => void,
 * }} options
 * @returns {Promise<{ loaded: number, blocked: number, unsupported?: string }>}
 */
export async function preloadLifecycleSnapshots({ lifecycle, profileContext, platform, store, warn = () => {} }) {
  const active = store ?? openCapabilityStore({ profileContext, ...(platform === undefined ? {} : { platform }) })
  if (!active.support.supported) return { loaded: 0, blocked: 0, unsupported: active.support.reason ?? 'unsupported' }
  let names
  try {
    names = await readdir(join(/** @type {string} */ (active.support.root), 'sessions'))
  } catch (error) {
    // No sessions directory yet — nothing accepted anywhere, nothing to load.
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return { loaded: 0, blocked: 0 }
    throw error
  }
  let loaded = 0
  let blocked = 0
  for (const name of names.sort()) {
    if (!isSegment(name)) continue
    // A fresher in-memory publication (e.g. an Apply accepted while this
    // preload was in flight) always wins over the disk record it came from.
    // Capture the exact observed object so EVERY post-await publication or
    // blocked marker can be gated on the same freshness proof.
    const observed = lifecycle.peek(name) ?? null
    if (observed) continue
    try {
      const record = await active.read({ kind: 'selection', sessionId: name })
      // The first await may have allowed an accepted Apply (or another
      // publisher) to replace the memory snapshot. Never publish/mark stale.
      if (lifecycle.peek(name) !== observed) continue
      if (record.kind === 'ok') {
        const payload = record.payload ?? {}
        lifecycle.publish(name, {
          revision: record.revision,
          skills: Array.isArray(payload.skills) ? payload.skills : [],
          mcpServers: Array.isArray(payload.mcpServers) ? payload.mcpServers : [],
        })
        loaded++
        continue
      }
      if (record.kind !== 'absent') {
        lifecycle.markBlocked(name, record.kind)
        blocked++
        continue
      }
      // No accepted record: the effective set may be the durable inherited
      // snapshot. Same fail-closed treatment for a record that exists but does
      // not decode — the session must not look uninitialized (and be handed a
      // fresh initial baseline) merely because its inheritance is damaged.
      const inherited = await active.read({ kind: 'inherited', sessionId: name })
      // A second independent read creates another interleaving window: an
      // accepted Apply here MUST outrank the older inherited unit.
      if (lifecycle.peek(name) !== observed) continue
      if (inherited.kind === 'ok') {
        const payload = /** @type {Record<string, unknown>} */ (inherited.payload ?? {})
        const parent = payload.parent && typeof payload.parent === 'object'
          ? /** @type {Record<string, unknown>} */ (payload.parent)
          : null
        lifecycle.publish(name, {
          revision: inherited.revision,
          skills: Array.isArray(payload.skills) ? payload.skills : [],
          mcpServers: Array.isArray(payload.mcpServers) ? payload.mcpServers : [],
          captured: parent && typeof parent.sessionId === 'string' && parent.sessionId.length > 0
            ? {
              parentSessionId: parent.sessionId,
              parentRevision: Number.isSafeInteger(parent.revision) ? /** @type {number} */ (parent.revision) : null,
              capturedAt: capturedAtOf(payload),
            }
            : null,
        })
        loaded++
        continue
      }
      if (inherited.kind !== 'absent') {
        lifecycle.markBlocked(name, inherited.kind)
        blocked++
      }
    } catch (error) {
      warn(`lifecycle snapshot preload skipped session "${name}": ${message(error)}`)
    }
  }
  return { loaded, blocked }
}
