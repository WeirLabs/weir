// Preset namespace mutations are serialized before a per-ID CAS. Read listing
// stays tolerant; the guarded writer scan fails closed on every unknown record.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isSegment } from './store/paths.js'

export const PRESET_SCHEMA_VERSION = 1

export function workspaceKeyOf(options, deps = {}) {
  const explicit = options?.scope?.session?.workspaceKey
  if (typeof explicit === 'string' && isSegment(explicit)) return explicit
  const cwd = options?.scope?.session?.header?.cwd ?? options?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  let canonical
  try { canonical = (deps.realpath ?? realpathSync)(cwd) } catch { canonical = cwd }
  return `ws-${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`
}

export const validatePresetId = id => {
  if (!isSegment(id)) throw new TypeError(`invalid preset id: ${JSON.stringify(id)}`)
}

const validateDocument = document => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new TypeError('preset document must be an object')
  if (typeof document.name !== 'string' || !document.name.length) throw new TypeError('preset document needs a non-empty display name')
  const selection = document.selection
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || !Array.isArray(selection.skills) || !Array.isArray(selection.mcpServers) || !Array.isArray(selection.unresolvedRefs)) {
    throw new TypeError('preset selection needs skills, mcpServers and unresolvedRefs arrays')
  }
}
const validRevision = value => Number.isSafeInteger(value) && value > 0
const duplicateNames = view => [...view.names.entries()].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ name, ids }))
const slugOf = name => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96)
  return isSegment(slug) ? slug : 'preset'
}

/** @param {{ store: { read(unit: unknown): Promise<any>, commit(unit: unknown, expectedRevision: number, mutate: (payload: unknown) => unknown): Promise<any>, withPresetNamespace(scope: string, workspaceKey: string|undefined, task: (guard: any) => Promise<any>): Promise<any> } }} options */
export function createPresetLibrary({ store }) {
  const unitOf = (scope, presetId, workspaceKey) => {
    validatePresetId(presetId)
    if (scope === 'global') return { kind: 'preset', scope: 'global', presetId }
    if (scope === 'workspace' && isSegment(workspaceKey)) return { kind: 'preset', scope: 'workspace', workspaceKey, presetId }
    throw new TypeError(`invalid preset scope or workspace key: ${JSON.stringify(scope)}`)
  }
  const inNamespace = (scope, workspaceKey, task) => {
    unitOf(scope, 'probe', workspaceKey)
    return store.withPresetNamespace(scope, workspaceKey, async guard => {
      const view = await guard.scan()
      return view.status === 'ok' ? task(view, guard) : view
    })
  }
  const resultOf = (result, success, presetId) => result.status === 'committed'
    ? { status: success, presetId, revision: result.revision }
    : { status: result.status, ...(result.revision !== undefined ? { revision: result.revision } : {}),
      ...(result.reason || result.error ? { reason: String(result.reason ?? result.error) } : {}) }

  async function load(scope, presetId, workspaceKey) {
    const record = await store.read(unitOf(scope, presetId, workspaceKey))
    if (record.kind === 'absent') return { kind: 'absent' }
    if (record.kind !== 'ok') return { kind: record.kind }
    if (record.payload?.deleted === true) return { kind: 'deleted', revision: record.revision }
    try { validateDocument(record.payload) } catch { return { kind: 'unreadable' } }
    return { kind: 'ok', revision: record.revision, document: record.payload }
  }

  /** A caller holding this namespace guard may prepare external side effects and
   * then call the bound create, without releasing the name reservation. */
  const withNamespace = (scope, workspaceKey, task) => inNamespace(scope, workspaceKey, (view, guard) => task({
    view,
    create: input => createLocked(input, view),
    checkCreate: input => createLocked({ ...input, dryRun: true }, view),
  }))

  async function createLocked(input, view) {
    const { scope, workspaceKey, document, onNameConflict = 'cancel', replaceTarget } = input
    validateDocument(document)
    if (!['cancel', 'rename', 'replace'].includes(onNameConflict)) throw new TypeError('invalid name-conflict decision')
    if (onNameConflict === 'replace' && (!replaceTarget || !isSegment(replaceTarget.presetId)
      || !validRevision(replaceTarget.expectedRevision) || replaceTarget.name !== document.name)) return { status: 'confirmation-required' }
    if (duplicateNames(view).length) return { status: 'duplicate-names', groups: duplicateNames(view) }
    const matches = view.names.get(document.name) ?? []
    if (onNameConflict === 'replace') {
      const target = replaceTarget.presetId
      const current = view.activeById.get(target)
      if (!current) return { status: view.occupiedIds.has(target) ? 'deleted' : 'absent' }
      if (current.revision !== replaceTarget.expectedRevision) return { status: 'revision-conflict', revision: current.revision }
      if (current.document.name !== replaceTarget.name || matches.length !== 1 || matches[0] !== target) return { status: 'confirmation-required' }
      if (input.dryRun) return { status: 'ready', presetId: target }
      const commit = async () => resultOf(await store.commit(unitOf(scope, target, workspaceKey), current.revision, () => document), 'edited', target)
      return input.withSource ? input.withSource(commit) : commit()
    }
    if (matches.length) {
      const target = matches[0]
      return { status: onNameConflict === 'rename' ? 'rename-required' : 'name-conflict', with: target, withRevision: view.activeById.get(target).revision }
    }
    let presetId = input.presetId
    if (presetId === undefined || presetId === null || presetId === '') {
      const base = slugOf(document.name)
      presetId = base
      for (let suffix = 2; view.occupiedIds.has(presetId); suffix++) presetId = `${base}-${suffix}`
    }
    validatePresetId(presetId)
    if (view.occupiedIds.has(presetId)) return { status: 'exists', presetId }
    if (input.dryRun) return { status: 'ready', presetId }
    const commit = async () => resultOf(await store.commit(unitOf(scope, presetId, workspaceKey), 0, () => document), 'created', presetId)
    return input.withSource ? input.withSource(commit) : commit()
  }
  const create = input => inNamespace(input.scope, input.workspaceKey, view => createLocked(input, view))

  async function change({ scope, presetId, workspaceKey, expectedRevision, name, selection, mutate, mode, withSource }) {
    const unit = unitOf(scope, presetId, workspaceKey)
    if (!validRevision(expectedRevision)) return { status: 'invalid-revision' }
    return inNamespace(scope, workspaceKey, async view => {
      const current = view.activeById.get(presetId)
      if (!current) return { status: view.occupiedIds.has(presetId) ? 'deleted' : 'absent' }
      if (current.revision !== expectedRevision) return { status: 'revision-conflict', revision: current.revision }
      const before = current.document
      let next
      if (mode === 'rename') {
        if (typeof name !== 'string' || !name.length) return { status: 'invalid-name' }
        next = { ...before, name }
      } else if (mode === 'resave') {
        if (!selection || !Array.isArray(selection.skills) || !Array.isArray(selection.mcpServers) || !Array.isArray(selection.unresolvedRefs)) return { status: 'invalid-selection' }
        next = { ...before, selection }
      } else {
        next = mutate(before)
      }
      try { validateDocument(next) } catch { return { status: 'invalid-selection' } }
      const duplicates = duplicateNames(view)
      if (duplicates.length) {
        const oldGroup = view.names.get(before.name) ?? []
        if (mode !== 'rename' || oldGroup.length < 2 || next.name === before.name || (view.names.get(next.name) ?? []).length) {
          return { status: 'duplicate-names', groups: duplicates }
        }
      }
      const collision = (view.names.get(next.name) ?? []).find(id => id !== presetId)
      if (collision) return { status: 'name-conflict', with: collision, withRevision: view.activeById.get(collision).revision }
      const commit = async () => resultOf(await store.commit(unit, expectedRevision, () => next), 'edited', presetId)
      return withSource ? withSource(commit) : commit()
    })
  }
  const rename = input => change({ ...input, mode: 'rename' })
  const resave = input => change({ ...input, mode: 'resave' })
  const edit = input => change({ ...input, mode: 'edit' })

  async function remove({ scope, presetId, workspaceKey, expectedRevision }) {
    const unit = unitOf(scope, presetId, workspaceKey)
    if (!validRevision(expectedRevision)) return { status: 'invalid-revision' }
    return inNamespace(scope, workspaceKey, async view => {
      const current = view.activeById.get(presetId)
      if (!current) return { status: view.occupiedIds.has(presetId) ? 'deleted' : 'absent' }
      if (current.revision !== expectedRevision) return { status: 'revision-conflict', revision: current.revision }
      const duplicates = duplicateNames(view)
      if (duplicates.length && (view.names.get(current.document.name) ?? []).length < 2) return { status: 'duplicate-names', groups: duplicates }
      const result = await store.commit(unit, expectedRevision, () => ({ deleted: true }))
      return resultOf(result, 'deleted', presetId)
    })
  }

  async function exportPreset(scope, presetId, workspaceKey) {
    const loaded = await load(scope, presetId, workspaceKey)
    if (loaded.kind !== 'ok') return { status: loaded.kind }
    return { status: 'ok', document: { version: PRESET_SCHEMA_VERSION, scope, presetId, ...loaded.document } }
  }
  return { load, create, edit, rename, resave, remove, exportPreset, withNamespace, unitOf }
}
