// Task 8.2 of the session-capability-manager change: per-server runtime
// mounting. Every Orrery-managed MCP server gets its own isolated
// cordis:group — the Orrery proxy facade plus the stock
// `@deepseek-ai/dsh-mcp-client` (referenced by package-name string, never
// statically imported) — created and destroyed at runtime through the
// host-supported loader API (1.14 PASS-WITH-LIMITS):
//   loader.create(options) → await loader.await() → judge readiness by the
//   child client's fiber state (NEVER at create() return — the group's
//   children are created asynchronously, the 1.14 spike misread exactly this).
// Startup also removes `orrery-mcp-*` residue rows that a crashed previous
// run persisted into the profile config (loader.create/remove write through
// to the root tree, CITED dsh-app-boot/lib/index.js:245).
import { isSegment } from './store/paths.js'

export const MCP_GROUP_PREFIX = 'orrery-mcp-'

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * Composition-time name-ambiguity detection (8.2, first implemented here —
 * only a suggestion in G3b). Two shapes, both fail closed:
 * - one configured name is another's `__` prefix (mcp__alpha__x__echo could
 *   come from `alpha` or `alpha__x` — collide is EXECUTED in G3b);
 * - two servers declare the same public tool name.
 * @param {Array<{ identity: string, publicNames?: string[] }>} entries
 * @returns {{ kind: 'ok' } | { kind: 'conflict', conflicts: Array<{ kind: string, a: string, b: string, reason: string }> }}
 */
export function detectMcpNameAmbiguity(entries) {
  const conflicts = []
  const identities = entries.map(entry => entry.identity)
  for (let i = 0; i < identities.length; i += 1) {
    for (let j = 0; j < identities.length; j += 1) {
      if (i !== j && identities[j].startsWith(`${identities[i]}__`)) {
        conflicts.push({ kind: 'prefix', a: identities[i], b: identities[j], reason: `configured name "${identities[i]}" is a "__" prefix of "${identities[j]}"; tool-name attribution would be ambiguous` })
      }
    }
  }
  const declared = new Map()
  for (const entry of entries) {
    for (const name of entry.publicNames ?? []) {
      if (declared.has(name)) {
        conflicts.push({ kind: 'duplicate-public-name', a: declared.get(name), b: entry.identity, reason: `public tool name "${name}" is declared by both "${declared.get(name)}" and "${entry.identity}"` })
      } else {
        declared.set(name, entry.identity)
      }
    }
  }
  return conflicts.length === 0 ? { kind: 'ok' } : { kind: 'conflict', conflicts }
}

/**
 * The isolated-group options for one managed server (plain data handed to
 * loader.create — the client is named by package string so nothing
 * `@deepseek-ai/*` is statically imported).
 * @param {{ identity: string, generation: number, client: unknown }} input
 */
export function mcpGroupOptions({ identity, generation, client }) {
  if (!isSegment(identity)) throw new TypeError(`invalid MCP server identity: ${JSON.stringify(identity)}`)
  const group = `${MCP_GROUP_PREFIX}${identity}`
  return {
    id: group,
    name: 'cordis:group',
    group: true,
    isolate: { tools: true, systemPrompt: true, mcpResources: true },
    config: [
      { id: `${group}-facade`, name: 'orrery-harness/mcp-facade-plugin', config: { identity, generation } },
      { id: `${group}-client`, name: '@deepseek-ai/dsh-mcp-client', config: client },
    ],
  }
}

/** Ids of `orrery-mcp-*` group entries (crash residue or our own mounts). */
export const isMcpResidueId = id => typeof id === 'string' && id.startsWith(MCP_GROUP_PREFIX) && !id.endsWith('-facade') && !id.endsWith('-client')

/**
 * @param {{ loader: { create(options: unknown): Promise<unknown>, remove(id: string): Promise<unknown>, await(): Promise<unknown>, resolve?(id: string): unknown },
 *   onError?: (reason: string, cause?: unknown) => void }} options
 */
export function createMcpMount({ loader, onError = () => {} }) {
  /** @type {Map<string, { groupId: string, generation: number }>} */
  const mounted = new Map()

  /**
   * Remove `orrery-mcp-*` residue groups (crash leftovers that the host
   * would mount directly on the next boot). Returns the removed ids.
   * @param {string[]} candidateIds - entry ids visible in the root tree
   */
  async function sweepResidue(candidateIds) {
    const removed = []
    for (const id of candidateIds.filter(isMcpResidueId)) {
      try {
        await loader.remove(id)
        removed.push(id)
      } catch (cause) {
        onError(`residue-sweep-failed:${id}`, cause)
      }
    }
    return removed
  }

  /**
   * Mount one managed server. Readiness is judged AFTER `loader.await()` by
   * the child client's fiber state (1.14 must-fix), never at create() return.
   * @param {{ identity: string, generation: number, client: unknown, fiberOf?: (groupId: string) => { state?: string } | null }} input
   */
  async function mount({ identity, generation, client, fiberOf }) {
    const options = mcpGroupOptions({ identity, generation, client })
    await loader.create(options)
    await loader.await()
    const fiber = typeof fiberOf === 'function' ? fiberOf(options.id) : { state: 'running' }
    if (fiber === null) {
      const reason = `mcp-mount-error: client entry has no fiber after loader.await()`
      onError(reason)
      throw new Error(reason)
    }
    mounted.set(identity, { groupId: options.id, generation })
    return { groupId: options.id }
  }

  /**
   * Unmount one server WITHOUT touching the others (1.14 S3 anomaly: a
   * removal once made a sibling vanish — after remove() every remaining
   * entry is verified and remounted through remount() if missing).
   * @param {string} identity
   * @param {{ alive?: () => string[], remount?: (identity: string) => Promise<void> }} [guards]
   */
  async function unmount(identity, guards = {}) {
    const entry = mounted.get(identity)
    if (!entry) return { removed: false }
    await loader.remove(entry.groupId)
    mounted.delete(identity)
    if (typeof guards.alive === 'function' && typeof guards.remount === 'function') {
      for (const [other] of mounted) {
        const groupId = `${MCP_GROUP_PREFIX}${other}`
        if (!guards.alive().includes(groupId)) {
          onError(`sibling-vanished-after-unmount:${other}`)
          await guards.remount(other)
        }
      }
    }
    return { removed: true }
  }

  return { mount, unmount, sweepResidue, mounted, message }
}
