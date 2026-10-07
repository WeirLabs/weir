// Editor draft model of the session capability manager (design D1, tasks 4.1).
// A draft is pure manager-side editing state: baseSelectionRevision, the
// normalized enabled identity sets, unresolved requested refs and local
// filter/layout view state. It is never read by the model, by tools or by the
// Apply engine: the engine receives an explicit selection payload, never a
// draft. Apply is visible if and only if the normalized draft enabled identity
// sets differ from the applied enabled identity sets (spec: Draft-only editing
// and exact Apply visibility).
import { createSkillIdentity, skillIdentityKey } from './skill-identity.js'
import { validateSkillSelection } from './skill-selection-provider.js'

/** View state is local filter/layout only; it can never produce an Apply. */
export const DRAFT_SORTS = Object.freeze(['name', 'scope', 'source'])
export const DRAFT_LAYOUTS = Object.freeze(['list', 'grid'])
export const DEFAULT_DRAFT_VIEW = Object.freeze({ search: '', scope: null, sort: 'name', layout: 'list' })

/**
 * @typedef {{ scope: string, root: string, name: string, provenance: Record<string, string> | null, opaqueId?: string, portable: boolean }} SkillIdentity
 * @typedef {{ skills: SkillIdentity[], mcpServers: string[] }} EnabledSets
 * @typedef {{ kind: 'skill'|'mcp', ref: string, reason: string }} UnresolvedRef
 * @typedef {{ search: string, scope: string | null, sort: string, layout: string }} DraftView
 */

/** @param {unknown} value */
const isNonEmptyString = value => typeof value === 'string' && value.length > 0

/**
 * Normalize an enabled-set input into canonical form: identities validated and
 * deduplicated by identity key, both vectors sorted. An explicit empty set is
 * a concrete value `{ skills: [], mcpServers: [] }`; `undefined`/`null` is
 * missing and is rejected so an absent selection can never be confused with
 * an explicitly emptied one.
 * @param {unknown} input @returns {EnabledSets}
 */
export function normalizeEnabledSets(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Enabled sets are required; an explicit empty set must be passed as empty arrays')
  }
  const { skills, mcpServers } = /** @type {{ skills?: unknown, mcpServers?: unknown }} */ (input)
  if (!Array.isArray(skills) || !Array.isArray(mcpServers)) {
    throw new TypeError('Enabled sets require skills and mcpServers arrays; an explicit empty set uses empty arrays')
  }
  const byKey = new Map(skills.map(raw => {
    const identity = createSkillIdentity(raw)
    return [skillIdentityKey(identity), identity]
  }))
  const servers = [...new Set(mcpServers.map(server => {
    if (!isNonEmptyString(server)) throw new TypeError('Managed MCP server keys must be non-empty strings')
    return server
  }))].sort()
  return {
    skills: [...byKey.values()].sort((a, b) => skillIdentityKey(a).localeCompare(skillIdentityKey(b))),
    mcpServers: servers,
  }
}

/** Canonical comparison vector: identity keys plus managed server keys. @param {EnabledSets} sets */
const comparisonVector = sets => [
  sets.skills.map(skillIdentityKey).sort(),
  [...sets.mcpServers].sort(),
]

/** Substantive equality of enabled sets: order and duplicates never matter. @param {unknown} a @param {unknown} b */
export function sameEnabledSets(a, b) {
  return JSON.stringify(comparisonVector(normalizeEnabledSets(a))) === JSON.stringify(comparisonVector(normalizeEnabledSets(b)))
}

/** @param {unknown} refs @returns {UnresolvedRef[]} */
function normalizeUnresolved(refs) {
  if (!Array.isArray(refs)) throw new TypeError('Unresolved requested refs must be an array')
  return refs.map(raw => {
    const entry = /** @type {Record<string, unknown>} */ (raw ?? {})
    if ((entry.kind !== 'skill' && entry.kind !== 'mcp') || !isNonEmptyString(entry.ref) || typeof entry.reason !== 'string') {
      throw new TypeError('Unresolved requested refs require kind (skill|mcp), a non-empty ref and a reason')
    }
    return Object.freeze({ kind: entry.kind, ref: entry.ref, reason: entry.reason })
  })
}

/** @param {unknown} patch @param {DraftView} base @returns {DraftView} */
function normalizeView(patch, base = DEFAULT_DRAFT_VIEW) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Draft view must be an object')
  const input = /** @type {Record<string, unknown>} */ (patch)
  const view = { ...base }
  if (input.search !== undefined) {
    if (typeof input.search !== 'string') throw new TypeError('Draft search must be a string')
    view.search = input.search
  }
  if (input.scope !== undefined) {
    if (input.scope !== null && typeof input.scope !== 'string') throw new TypeError('Draft scope filter must be a string or null')
    view.scope = /** @type {string | null} */ (input.scope)
  }
  if (input.sort !== undefined) {
    if (!DRAFT_SORTS.includes(/** @type {string} */ (input.sort))) throw new TypeError(`Draft sort must be one of ${DRAFT_SORTS.join(', ')}`)
    view.sort = /** @type {string} */ (input.sort)
  }
  if (input.layout !== undefined) {
    if (!DRAFT_LAYOUTS.includes(/** @type {string} */ (input.layout))) throw new TypeError(`Draft layout must be one of ${DRAFT_LAYOUTS.join(', ')}`)
    view.layout = /** @type {string} */ (input.layout)
  }
  return view
}

/**
 * Open an editing draft from the latest applied selection snapshot.
 * `applied` is the EFFECTIVE applied enabled sets (an explicit empty set when
 * the accepted record enabled nothing, the session's initial sets when no
 * record exists yet); `baseRevision` is the accepted selection revision the
 * draft is opened from (0 when no record exists). The draft never stores
 * preset metadata, installation state or content: loading a preset stages
 * only its resolved enabled sets and unresolved refs.
 * @param {{ baseRevision: number, applied: unknown, unresolved?: unknown, view?: unknown }} options
 */
export function createSelectionDraft({ baseRevision, applied, unresolved = [], view = {} }) {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new TypeError('baseSelectionRevision must be a non-negative integer')
  const state = {
    baseRevision,
    applied: normalizeEnabledSets(applied),
    enabled: normalizeEnabledSets(applied),
    unresolved: normalizeUnresolved(unresolved),
    view: normalizeView(view),
  }

  const draft = {
    /** The accepted selection revision this draft bases on. */
    get baseSelectionRevision() { return state.baseRevision },
    /** The applied enabled sets the dirty check compares against. */
    get applied() { return structuredClone(state.applied) },
    /** The current draft enabled sets (normalized). */
    get enabled() { return structuredClone(state.enabled) },
    /** Requested refs that did not resolve locally; kept for warnings, never authorized. */
    get unresolved() { return state.unresolved.map(entry => ({ ...entry })) },
    /** Local filter/layout state. */
    get view() { return { ...state.view } },

    /** Apply is visible if and only if the normalized enabled sets differ. */
    isDirty() { return !sameEnabledSets(state.enabled, state.applied) },

    /** Toggle one exact identity. Toggling back to the applied state clears Apply. */
    toggle(identity, on) {
      const value = createSkillIdentity(identity)
      const key = skillIdentityKey(value)
      const kept = state.enabled.skills.filter(item => skillIdentityKey(item) !== key)
      state.enabled = normalizeEnabledSets({ skills: on ? [...kept, value] : kept, mcpServers: state.enabled.mcpServers })
      return draft.isDirty()
    },

    /** Toggle one managed MCP server key. */
    toggleServer(server, on) {
      const kept = state.enabled.mcpServers.filter(item => item !== server)
      state.enabled = normalizeEnabledSets({ skills: state.enabled.skills, mcpServers: on ? [...kept, server] : kept })
      return draft.isDirty()
    },

    /** Replace the enabled sets wholesale (e.g. an explicit empty set). */
    setEnabled(sets) {
      state.enabled = normalizeEnabledSets(sets)
      return draft.isDirty()
    },

    /**
     * Stage a capability preset: only its resolved enabled sets and unresolved
     * refs enter the draft. Preset metadata (id, name, revision, description)
     * is presentation data of the preset library and is deliberately not
     * retained, so preset metadata alone can never produce an Apply.
     * @param {{ resolved: unknown, unresolved?: unknown }} preset
     */
    stagePreset(preset) {
      const staged = /** @type {Record<string, unknown>} */ (preset ?? {})
      state.enabled = normalizeEnabledSets(staged.resolved)
      state.unresolved = normalizeUnresolved(staged.unresolved ?? [])
      return draft.isDirty()
    },

    /** Local filter/layout edits; these never affect Apply visibility. */
    setView(patch) {
      state.view = normalizeView(patch, state.view)
      return draft.isDirty()
    },

    /**
     * Non-selection events. Installation, update checks, successful updates
     * and content refresh with unchanged identities do not edit the draft and
     * never produce an Apply by themselves (spec: Non-selection operation).
     * They are explicit no-ops so the manager has one stable seam to report
     * them through; each returns false, meaning "no Apply was produced".
     */
    noteInstall() { return false },
    noteUpdate() { return false },
    noteContentRefresh() { return false },

    /** Same-name enabled identities the user must resolve explicitly. */
    conflicts() {
      return validateSkillSelection(state.enabled.skills).conflicts.map(conflict => structuredClone(conflict))
    },

    /**
     * Discard editing state and reopen from the latest applied snapshot
     * (spec: reopening starts from the latest applied revision after discard).
     * Local view state is kept; it is not part of the selection.
     * @param {{ baseRevision: number, applied: unknown, unresolved?: unknown }} next
     */
    discard(next) {
      if (!Number.isSafeInteger(next?.baseRevision) || next.baseRevision < 0) throw new TypeError('discard requires the latest baseSelectionRevision')
      state.baseRevision = next.baseRevision
      state.applied = normalizeEnabledSets(next.applied)
      state.enabled = normalizeEnabledSets(next.applied)
      state.unresolved = normalizeUnresolved(next.unresolved ?? [])
      return draft.isDirty()
    },

    /**
     * The explicit selection payload an Apply submits. The server re-validates
     * everything; the draft is a client convenience, never an authority.
     */
    toApplyPayload() {
      return {
        expectedRevision: state.baseRevision,
        selection: structuredClone(state.enabled),
        unresolved: state.unresolved.map(entry => ({ ...entry })),
      }
    },
  }
  return draft
}
