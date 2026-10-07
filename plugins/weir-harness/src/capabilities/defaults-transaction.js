// Task 9.4 of the session-capability-manager change: the independent
// "save as workspace new-session default" transaction. The confirmation
// surface names the exact capabilities and scope being recorded plus every
// unresolvable item; the record is a COPY snapshot of the draft's resolved
// sets plus its unresolved refs. Saving does not require an Apply and never
// changes the current session; clearing is not saving an explicit empty set
// (an explicit empty set is a real, savable choice). The binding is the
// workspace's stable identity (canonical root path). Save and clear go
// through the group-2 CAS — a conflict never overwrites.
import { workspaceKeyOf } from './preset-library.js'

/**
 * @param {{ store: { read(unit: unknown): Promise<any>, commit(unit: unknown, expectedRevision: number, mutate: (payload: unknown) => unknown, request?: unknown): Promise<any> },
 *   now?: () => number }} options
 */
export function createDefaultsTransaction({ store, now = Date.now }) {
  const unitOf = workspaceKey => {
    if (typeof workspaceKey !== 'string' || workspaceKey.length === 0) throw new TypeError('a workspace key is required')
    return { kind: 'defaults', workspaceKey }
  }

  /** @returns {Promise<{ kind: 'absent' } | { kind: 'ok', revision: number, snapshot: unknown } | { kind: string }>} */
  async function read(workspaceKey) {
    const record = await store.read(unitOf(workspaceKey))
    if (record.kind === 'absent') return { kind: 'absent' }
    if (record.kind !== 'ok') return { kind: record.kind }
    return { kind: 'ok', revision: record.revision, snapshot: record.payload }
  }

  /**
   * Save the default for one workspace. The snapshot is a deep copy — the
   * draft keeps evolving independently after the save.
   * @param {{ workspaceKey: string, expectedRevision: number,
   *   snapshot: { skills: unknown[], mcpServers: string[], unresolvedRefs: unknown[] } }} input
   */
  async function save({ workspaceKey, expectedRevision, snapshot }) {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('the defaults snapshot must be an object')
    if (!Array.isArray(snapshot.skills) || !Array.isArray(snapshot.mcpServers) || !Array.isArray(snapshot.unresolvedRefs)) {
      throw new TypeError('the defaults snapshot needs skills, mcpServers and unresolvedRefs arrays')
    }
    const result = await store.commit(unitOf(workspaceKey), expectedRevision, () => ({
      skills: structuredClone(snapshot.skills),
      mcpServers: [...snapshot.mcpServers],
      unresolvedRefs: structuredClone(snapshot.unresolvedRefs),
      savedAt: now(),
    }))
    return result.status === 'committed' ? { status: 'saved', revision: result.revision } : { status: result.status }
  }

  /**
   * Clear the default for one workspace (absent afterwards — NOT an explicit
   * empty set, which stays a savable choice).
   */
  async function clear({ workspaceKey, expectedRevision }) {
    const result = await store.commit(unitOf(workspaceKey), expectedRevision, () => ({ cleared: true, clearedAt: now() }))
    return result.status === 'committed' ? { status: 'cleared', revision: result.revision } : { status: result.status }
  }

  return { read, save, clear, unitOf, workspaceKeyOf }
}
