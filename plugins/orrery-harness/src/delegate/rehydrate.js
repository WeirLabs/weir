// Rehydration: rebuild a supervision registry from durable facts after a host
// restart. Pure logic — the mount layer feeds it parsed audit records and the
// DSH catalog; no DSH imports, no fs.

import { parseTerminalStatus, createMemberRecord, createGroupRecord, isTerminalStatus, untrackedCatalogEntries } from './group-coordinator.js'

/**
 * Rebuild supervision state by replaying structured audit facts and
 * cross-checking the DSH subagent catalog.
 *
 * @param {object} input
 * @param {string} input.parentId - the parent session id (record filter key)
 * @param {object[]} input.records - parsed audit JSONL records (already tail-read; may contain other sessions/types)
 * @param {object[]} input.catalogChildren - DSH catalog entries ({ id, label?, mode? }); best-effort
 * @returns {{ children: object[], groups: object[], untracked: object[], confidence: 'full'|'partial', factsSeen: number }}
 */
export function rehydrateSupervision({ parentId, records, catalogChildren }) {
  const children = new Map()
  const groups = new Map()
  let factsSeen = 0

  for (const record of records ?? []) {
    if (!record || typeof record !== 'object') continue
    if (record.session !== undefined && record.session !== null && record.session !== parentId) continue
    const type = typeof record.type === 'string' ? record.type : ''
    if (!type.startsWith('orrery/supervision/')) continue
    const fact = record.data
    if (!fact || typeof fact !== 'object' || typeof fact.kind !== 'string') continue
    factsSeen += 1
    applyFact(fact, children, groups)
  }

  // Recompute group settle state from member statuses (authoritative).
  for (const group of groups.values()) {
    const terminal = group.memberIds.every((id) => isTerminalStatus(children.get(id)?.status))
    group.settled = group.sealed === true && group.memberIds.length > 0 && terminal
  }

  // Catalog cross-check: continuable children the registry does not track.
  const untracked = untrackedCatalogEntries(catalogChildren, (id) => children.has(id))

  return {
    children: [...children.values()],
    groups: [...groups.values()],
    untracked,
    confidence: factsSeen > 0 ? 'full' : 'partial',
    factsSeen,
  }
}

/** Apply one structured supervision fact to the in-build registry. */
function applyFact(fact, children, groups) {
  switch (fact.kind) {
    case 'spawn': {
      if (typeof fact.childId !== 'string' || fact.childId.length === 0) return
      if (!children.has(fact.childId)) {
        children.set(fact.childId, createMemberRecord({
          id: fact.childId,
          name: typeof fact.name === 'string' && fact.name.length > 0 ? fact.name : fact.childId,
          group: typeof fact.group === 'string' && fact.group.length > 0 ? fact.group : 'unknown',
        }))
      }
      ensureGroup(groups, fact.group, fact.childId)
      return
    }
    case 'seal': {
      const entry = groups.get(fact.group)
      if (!entry) return
      entry.sealed = true
      if (Array.isArray(fact.memberIds)) entry.memberIds = [...fact.memberIds]
      return
    }
    case 'settle': {
      const child = children.get(fact.childId)
      if (!child) return
      if (fact.status === 'completed' || fact.status === 'blocked') {
        child.status = fact.status
        child.report = typeof fact.report === 'string' ? fact.report : ''
      }
      return
    }
    case 'resume': {
      const child = children.get(fact.childId)
      if (!child) return
      child.status = 'running'
      return
    }
    case 'terminate': {
      const child = children.get(fact.childId)
      if (!child) return
      child.status = 'terminated'
      child.report = typeof fact.reason === 'string' ? fact.reason : ''
      return
    }
    case 'group-settled': {
      const entry = groups.get(fact.group)
      if (!entry) return
      entry.settled = true
      return
    }
    case 'group-released': {
      groups.delete(fact.group)
      return
    }
    default:
      return
  }
}

function ensureGroup(groups, name, childId) {
  if (typeof name !== 'string' || name.length === 0) return
  let entry = groups.get(name)
  if (!entry) {
    entry = createGroupRecord(name)
    groups.set(name, entry)
  }
  if (!entry.memberIds.includes(childId)) entry.memberIds.push(childId)
}

const RECOVERED_GROUP = 'recovered'

/**
 * L3 best-effort recovery: re-parse terminal STATUS/REPORT text from child
 * session logs. Promotes untracked catalog children with a terminal report
 * into a synthetic "recovered" group, and refines registry children whose
 * settle fact was lost (still running) to their recovered terminal status.
 * Mutates and returns `state`. The reader is injected for testability.
 *
 * @param {object} state - output of rehydrateSupervision
 * @param {(childId: string) => Promise<string | null>} readChildFinalText - last assistant text of a child session, or null
 * @returns {Promise<object>} the mutated state
 */
export async function applyChildLogRecovery(state, readChildFinalText) {
  if (typeof readChildFinalText !== 'function') return state

  const remainingUntracked = []
  const recoveredIds = []
  /** Members THIS recovery pass promoted to a terminal state (the audit
   * trail's evidence tag — hydrate re-emits their settlement facts).
   * @type {Array<{ childId: string, status: string, report: string }>} */
  const recovered = []
  for (const entry of state.untracked ?? []) {
    const terminal = parseTerminalStatus(await safeRead(readChildFinalText, entry.id))
    if (terminal) {
      state.children.push(createMemberRecord({
        id: entry.id,
        name: entry.label || entry.id,
        group: RECOVERED_GROUP,
        status: terminal.status,
        report: terminal.report,
      }))
      recoveredIds.push(entry.id)
      recovered.push({ childId: entry.id, status: terminal.status, report: terminal.report })
    } else {
      remainingUntracked.push(entry)
    }
  }
  state.untracked = remainingUntracked
  if (recoveredIds.length > 0) {
    state.groups.push(createGroupRecord(RECOVERED_GROUP, { memberIds: recoveredIds, sealed: true, settled: true }))
  }

  for (const child of state.children) {
    if (child.status !== 'running') continue
    const terminal = parseTerminalStatus(await safeRead(readChildFinalText, child.id))
    if (terminal) {
      child.status = terminal.status
      child.report = terminal.report
      recovered.push({ childId: child.id, status: terminal.status, report: terminal.report })
    }
  }

  state.recovered = recovered
  recomputeGroupSettle(state)
  return state
}

async function safeRead(readChildFinalText, childId) {
  try {
    const text = await readChildFinalText(childId)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/** Recompute every group's settled flag from member statuses (post-L3). */
function recomputeGroupSettle(state) {
  const byId = new Map(state.children.map((child) => [child.id, child]))
  for (const group of state.groups) {
    const terminal = group.memberIds.every((id) => isTerminalStatus(byId.get(id)?.status))
    group.settled = group.sealed === true && group.memberIds.length > 0 && terminal
  }
}
