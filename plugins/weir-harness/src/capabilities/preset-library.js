// Task 9.1 of the session-capability-manager change: the preset library.
// Two namespaces — `global` (this installation) and `workspace` (one stable
// workspace identity, visible only there); a stable preset ID is always
// separate from its display name; a display-name collision inside one
// namespace requires an explicit rename / replace / cancel decision and
// never silently shadows the other namespace. Every write and import goes
// through the group-2 store with expected-revision CAS — a stale revision
// is a visible conflict, never a silent overwrite.
import { createHash } from 'node:crypto'
import { isSegment } from './store/paths.js'
import { realpathSync } from 'node:fs'

export const PRESET_SCHEMA_VERSION = 1

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * The workspace identity bindings resolve against (9.4/9.1): the canonical
 * workspace root PATH, never its display name — renaming the workspace does
 * not change the binding. An explicit session workspace field wins; the
 * session cwd is the fallback, canonicalized.
 * @param {unknown} options - { scope?: { session?: { workspaceKey?: unknown, header?: { cwd?: unknown } } }, cwd?: unknown }
 */
export function workspaceKeyOf(options, deps = {}) {
  const explicit = options?.scope?.session?.workspaceKey
  if (typeof explicit === 'string' && isSegment(explicit)) return explicit
  const cwd = options?.scope?.session?.header?.cwd ?? options?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const canonicalize = deps.realpath ?? realpathSync
  let canonical
  try {
    canonical = canonicalize(cwd)
  } catch {
    canonical = cwd
  }
  // Store segments ban path characters: the binding key is the canonical
  // path's digest — stable across renames, segment-safe, never the display
  // name.
  return `ws-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`
}

/** @param {unknown} id */
export const validatePresetId = id => {
  if (!isSegment(id)) throw new TypeError(`invalid preset id: ${JSON.stringify(id)}`)
}

const validateDocument = document => {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new TypeError('preset document must be an object')
  if (typeof document.name !== 'string' || document.name.length === 0) throw new TypeError('preset document needs a non-empty display name')
  const selection = document.selection
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) throw new TypeError('preset document needs a selection object')
  if (!Array.isArray(selection.skills) || !Array.isArray(selection.mcpServers) || !Array.isArray(selection.unresolvedRefs)) {
    throw new TypeError('preset selection needs skills, mcpServers and unresolvedRefs arrays')
  }
}

/**
 * @param {{ store: { read(unit: unknown): Promise<any>, commit(unit: unknown, expectedRevision: number, mutate: (payload: unknown) => unknown, request?: unknown): Promise<any> } }} options
 */
export function createPresetLibrary({ store }) {
  const unitOf = (scope, presetId, workspaceKey) => {
    validatePresetId(presetId)
    if (scope === 'global') return { kind: 'preset', scope: 'global', presetId }
    if (scope === 'workspace') {
      if (typeof workspaceKey !== 'string' || !workspaceKey.length) throw new TypeError('workspace presets need a workspace key')
      return { kind: 'preset', scope: 'workspace', workspaceKey, presetId }
    }
    throw new TypeError(`invalid preset scope: ${JSON.stringify(scope)}`)
  }

  /** @returns {Promise<{ kind: 'absent' } | { kind: 'ok', revision: number, document: unknown } | { kind: string }>} */
  async function load(scope, presetId, workspaceKey) {
    const record = await store.read(unitOf(scope, presetId, workspaceKey))
    if (record.kind === 'absent') return { kind: 'absent' }
    if (record.kind !== 'ok') return { kind: record.kind }
    return { kind: 'ok', revision: record.revision, document: record.payload }
  }

  /**
   * Create a new preset. A display-name collision inside the SAME namespace
   * is the caller's explicit choice: 'rename' (the caller must pass a
   * different display name), 'replace' (the caller confirmed overwriting
   * that other preset) or 'cancel' (the default — reject, write nothing).
   * A same display name in the OTHER namespace never shadows or conflicts.
   * @param {{ scope: 'global'|'workspace', presetId: string, document: unknown,
   *   onNameConflict?: 'rename'|'replace'|'cancel', allDisplayNames?: (scope: string, workspaceKey?: string) => Promise<Map<string, string>> }} input
   */
  async function create({ scope, presetId, workspaceKey, document, onNameConflict = 'cancel', allDisplayNames }) {
    validateDocument(document)
    if (onNameConflict !== 'rename' && onNameConflict !== 'replace' && onNameConflict !== 'cancel') {
      throw new TypeError(`invalid name-conflict decision: ${JSON.stringify(onNameConflict)}`)
    }
    if (typeof allDisplayNames === 'function') {
      const taken = await allDisplayNames(scope, workspaceKey)
      for (const [otherId, otherName] of taken) {
        if (otherId !== presetId && otherName === document.name) {
          if (onNameConflict === 'cancel') return { status: 'name-conflict', with: otherId }
          if (onNameConflict === 'rename') return { status: 'rename-required', with: otherId }
          // 'replace' confirmed by the caller: proceed.
        }
      }
    }
    const unit = unitOf(scope, presetId, workspaceKey)
    const current = await store.read(unit)
    if (current.kind !== 'absent') return { status: 'exists', presetId }
    const result = await store.commit(unit, 0, () => document)
    return result.status === 'committed' ? { status: 'created', revision: result.revision } : { status: result.status }
  }

  /**
   * Edit an existing preset's document (whole-document replacement under CAS).
   * @param {{ scope: string, presetId: string, workspaceKey?: string, expectedRevision: number,
   *   mutate: (document: unknown) => unknown }} input
   */
  async function edit({ scope, presetId, workspaceKey, expectedRevision, mutate }) {
    const unit = unitOf(scope, presetId, workspaceKey)
    const result = await store.commit(unit, expectedRevision, payload => {
      const next = mutate(payload)
      validateDocument(next)
      return next
    })
    return result.status === 'committed' ? { status: 'edited', revision: result.revision } : { status: result.status }
  }

  /** @param {{ scope: string, presetId: string, workspaceKey?: string, expectedRevision: number }} input */
  async function remove({ scope, presetId, workspaceKey, expectedRevision }) {
    const result = await store.commit(unitOf(scope, presetId, workspaceKey), expectedRevision, () => ({ deleted: true }))
    return result.status === 'committed' ? { status: 'deleted', revision: result.revision } : { status: result.status }
  }

  /**
   * Export a preset as a portable document (the payload verbatim plus the
   * stable id and namespace — display names travel, secrets never do).
   */
  async function exportPreset(scope, presetId, workspaceKey) {
    const loaded = await load(scope, presetId, workspaceKey)
    if (loaded.kind !== 'ok') return { status: loaded.kind }
    return { status: 'ok', document: { version: PRESET_SCHEMA_VERSION, scope, presetId, ...loaded.document } }
  }

  return { load, create, edit, remove, exportPreset, unitOf, message }
}
