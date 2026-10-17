// Rehydration: rebuild a supervision registry from durable facts after a host
// restart. Pure logic — the mount layer feeds it parsed audit records and the
// DSH catalog; no DSH imports, no fs.

import { createMemberRecord, createGroupRecord, untrackedCatalogEntries } from './group-coordinator.js'
import { parseTerminalStatus, isTerminalStatus } from '../shared/terminal-evidence.js'

/**
 * Rebuild supervision state by replaying structured audit facts and
 * cross-checking the DSH subagent catalog.
 *
 * Two fact channels ride the same audit file: the supervision facts
 * (`weir/supervision/<kind>`) and the child-composition spawn facts
 * (`weir/delegate/spawn`, which carry the lane). The spawn facts decide which
 * catalog children are supervision orphans — DSH 0.2.1 reports every local
 * child as mode 'continuable', so the catalog mode can no longer tell a
 * one-shot child from a supervised one.
 *
 * @param {object} input
 * @param {string} input.parentId - the parent session id (record filter key)
 * @param {object[]} input.records - parsed audit JSONL records (already tail-read; may contain other sessions/types)
 * @param {object[]} input.catalogChildren - DSH catalog entries ({ id, label?, mode? }); best-effort
 * @returns {{ children: object[], groups: object[], untracked: object[], spawnFacts: object[], confidence: 'full'|'partial', factsSeen: number }}
 */
export function rehydrateSupervision({ parentId, records, catalogChildren }) {
  const children = new Map()
  const groups = new Map()
  /** @type {Map<string, { childId: string, lane?: string }>} */
  const spawnFacts = new Map()
  let factsSeen = 0

  for (const record of records ?? []) {
    if (!record || typeof record !== 'object') continue
    if (record.session !== undefined && record.session !== null && record.session !== parentId) continue
    const type = typeof record.type === 'string' ? record.type : ''
    if (type === 'weir/delegate/spawn') {
      const fact = record.data
      if (fact && typeof fact === 'object' && typeof fact.childId === 'string' && fact.childId.length > 0) {
        spawnFacts.set(fact.childId, { childId: fact.childId, lane: typeof fact.lane === 'string' ? fact.lane : undefined })
      }
      continue
    }
    if (!type.startsWith('weir/supervision/')) continue
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

  // Catalog cross-check: only fact-less orphans remain untracked (the spawn
  // facts identify the one-shot/continuable children this registry must never
  // resurrect, and keep a supervised child whose fact chain is broken visible).
  const untracked = untrackedCatalogEntries(catalogChildren, (id) => children.has(id), (id) => spawnFacts.get(id))

  return {
    children: [...children.values()],
    groups: [...groups.values()],
    untracked,
    spawnFacts: [...spawnFacts.values()],
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
