// Task 6.1 preload (design D6): at plugin apply, load the accepted
// selections of KNOWN sessions into the lifecycle memory snapshot, so the
// agent/created listener's synchronous read hits memory instead of disk.
// This module is the async boundary — it runs at mount time, NEVER inside
// the agent/created listener. A slow or failed preload costs one blocking
// synchronous disk read per agent creation (the listener's miss path),
// never correctness. Records that do not decode are pre-marked BLOCKED, so
// the fail-closed state is ready before the first agent is created.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isSegment } from './store/paths.js'
import { openCapabilityStore } from './store/store.js'

/** @param {unknown} error */
const message = error => (error instanceof Error ? error.message : String(error))

/**
 * @param {{
 *   lifecycle: {
 *     publish(sessionId: string, next: { revision: number, skills?: unknown[], mcpServers?: string[] }): unknown,
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
    if (lifecycle.peek(name)) continue
    try {
      const record = await active.read({ kind: 'selection', sessionId: name })
      if (record.kind === 'ok') {
        const payload = record.payload ?? {}
        lifecycle.publish(name, {
          revision: record.revision,
          skills: Array.isArray(payload.skills) ? payload.skills : [],
          mcpServers: Array.isArray(payload.mcpServers) ? payload.mcpServers : [],
        })
        loaded++
      } else if (record.kind === 'corrupt' || record.kind === 'unknown-schema' || record.kind === 'torn') {
        lifecycle.markBlocked(name, record.kind)
        blocked++
      }
    } catch (error) {
      warn(`lifecycle snapshot preload skipped session "${name}": ${message(error)}`)
    }
  }
  return { loaded, blocked }
}
