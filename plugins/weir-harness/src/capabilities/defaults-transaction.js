// Task 9.4 of the session-capability-manager change: the independent
// "save as workspace new-session default" transaction. The confirmation
// surface names the exact capabilities and scope being recorded plus every
// unresolvable item; the record is a COPY snapshot of the draft's resolved
// sets plus its unresolved refs. Saving does not require an Apply and never
// changes the current session; clearing is not saving an explicit empty set
// (an explicit empty set is a real, savable choice). The binding is the
// workspace's stable identity (canonical root path). Save and clear go
// through the group-2 CAS — a conflict never overwrites.
import { workspaceKeyOf, draftSelectionSets, noWorkspaceError } from './preset-library.js'
import { resolveSkillNamesForSave } from './initial-selection.js'
import { isSegment } from './store/paths.js'

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

// ---- /capabilities default verbs (capabilities-deepening D2) ----------------
// The three workspace-default verb bodies of the /capabilities command, moved
// verbatim out of the handler into the module that owns the defaults CAS
// contract (read/save/clear above). Per-invocation state arrives through the
// `call` argument ({ agent, options }); the handler's former closures are
// injected in `wiring` — the payload builder included, so this module keeps
// its import graph acyclic (read-payloads.js imports this module, never the
// reverse).

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * The /capabilities default verb bodies. `wiring`:
 * @param {{
 *   openStore: () => any,
 *   provider: any,
 *   inventory: (options: any) => Promise<any>,
 *   lifecycle: any,
 *   builders: { buildDefaultGetPayload: Function },
 * }} wiring
 */
export function createDefaultsVerbs(wiring) {
  /**
   * The sets a save records. from:'applied' is server-authoritative: the sets
   * come from the same provider/lifecycle state the receipt verb reports —
   * client-sent set fields are never trusted then.
   */
  const selectionSetsOf = async (spec, call) => {
    if (spec.from === 'applied') {
      const result = await wiring.provider.list(call.options)
      const candidates = Array.isArray(result?.candidates) ? result.candidates : []
      const skills = []
      for (const candidate of candidates) {
        if (candidate?.selected && candidate.identity) skills.push(candidate.identity)
      }
      const snapshot = wiring.lifecycle?.snapshotFor?.(call.agent.id)
      return { skills, mcpServers: Array.isArray(snapshot?.mcpServers) ? [...snapshot.mcpServers] : [], unresolvedRefs: [] }
    }
    return draftSelectionSets(spec)
  }

  /**
   * default-get: thin shell over the shared builder. The no-workspace status
   * is the ONLY error mapping (the historical noWorkspace object); every
   * other status — including a non-ok record — stays success.
   */
  async function defaultGet(_spec, call) {
    try {
      const payload = await wiring.builders.buildDefaultGetPayload({ store: wiring.openStore() }, call.options)
      if (payload.status === 'no-workspace') return { kind: 'error', text: JSON.stringify(payload) }
      return { kind: 'success', text: JSON.stringify(payload) }
    } catch (cause) {
      return { kind: 'error', text: `capabilities default-get failed: ${message(cause)}` }
    }
  }

  /**
   * default-save: save this workspace's new-session default as a COPY
   * snapshot of the draft or the applied sets. Saving never changes the
   * current session; an explicit empty set is a real choice.
   */
  async function defaultSave(spec, call) {
    try {
      if (spec?.from !== 'draft' && spec?.from !== 'applied') return { kind: 'error', text: 'capabilities default-save: from must be "draft" | "applied"' }
      const workspaceKey = workspaceKeyOf(call.options)
      if (!isSegment(workspaceKey)) return noWorkspaceError()
      const transaction = createDefaultsTransaction({ store: wiring.openStore() })
      let expectedRevision = spec.expectedRevision
      if (expectedRevision === undefined) {
        const current = await transaction.read(workspaceKey)
        if (current.kind !== 'ok' && current.kind !== 'absent') return { kind: 'error', text: JSON.stringify({ status: current.kind }) }
        expectedRevision = current.kind === 'ok' ? current.revision : 0
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return { kind: 'error', text: 'capabilities default-save: expectedRevision must be a non-negative integer' }
      }
      const sets = await selectionSetsOf(spec, call)
      let skills = sets.skills
      if (spec.from === 'draft') {
        // The draft's wire shape is name strings: resolve them to exact
        // SkillIdentity objects BEFORE persisting, so the default record
        // carries the resolved-sets contract and a duplicated name never
        // lands as an unbindable string. The session's applied selection is
        // the authoritative disambiguation; unresolvable or still-ambiguous
        // names are an explicit error with ZERO writes.
        const inventoryResult = await wiring.inventory(call.options)
        const inventoryCandidates = Array.isArray(inventoryResult?.candidates) ? inventoryResult.candidates : []
        const appliedResult = await wiring.provider.list(call.options)
        const appliedCandidates = Array.isArray(appliedResult?.candidates) ? appliedResult.candidates : []
        const appliedIdentities = []
        for (const candidate of appliedCandidates) {
          if (candidate?.selected && candidate.identity) appliedIdentities.push(candidate.identity)
        }
        const resolved = resolveSkillNamesForSave(spec.skills, inventoryCandidates, appliedIdentities)
        if (resolved.missing.length > 0) return { kind: 'error', text: JSON.stringify({ status: 'missing', missing: resolved.missing }) }
        if (resolved.ambiguous.length > 0) return { kind: 'error', text: JSON.stringify({ status: 'ambiguous', ambiguous: resolved.ambiguous }) }
        skills = resolved.identities
      }
      const result = await transaction.save({ workspaceKey, expectedRevision, snapshot: { skills, mcpServers: sets.mcpServers, unresolvedRefs: sets.unresolvedRefs } })
      return { kind: 'success', text: JSON.stringify({ ...result, workspaceKey }) }
    } catch (cause) {
      return { kind: 'error', text: `capabilities default-save failed: ${message(cause)}` }
    }
  }

  /**
   * default-clear: clear this workspace's default (absent afterwards — NOT
   * an explicit empty set). The JSON payload is optional.
   */
  async function defaultClear(spec = {}, call) {
    try {
      const workspaceKey = workspaceKeyOf(call.options)
      if (!isSegment(workspaceKey)) return noWorkspaceError()
      const transaction = createDefaultsTransaction({ store: wiring.openStore() })
      let expectedRevision = spec.expectedRevision
      if (expectedRevision === undefined) {
        const current = await transaction.read(workspaceKey)
        if (current.kind !== 'ok' && current.kind !== 'absent') return { kind: 'error', text: JSON.stringify({ status: current.kind }) }
        expectedRevision = current.kind === 'ok' ? current.revision : 0
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        return { kind: 'error', text: 'capabilities default-clear: expectedRevision must be a non-negative integer' }
      }
      const result = await transaction.clear({ workspaceKey, expectedRevision })
      return { kind: 'success', text: JSON.stringify({ ...result, workspaceKey }) }
    } catch (cause) {
      return { kind: 'error', text: `capabilities default-clear failed: ${message(cause)}` }
    }
  }

  return { 'default-get': defaultGet, 'default-save': defaultSave, 'default-clear': defaultClear }
}
