// Preset namespace mutations are serialized before a per-ID CAS. Read listing
// stays tolerant; the guarded writer scan fails closed on every unknown record.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isSegment } from './store/paths.js'
import { createSkillIdentity, skillIdentityKey } from './skill-identity.js'
import { createMcpRegistry } from './mcp-registry.js'

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

// ---- /capabilities preset verbs (capabilities-deepening D2) -----------------
// The seven preset-verb bodies of the /capabilities command, moved verbatim
// out of the handler into the module that owns the preset contract (the CAS
// read-modify-write and the created/edited/deleted/revision-conflict/
// name-conflict status values above). Per-invocation state arrives through
// the `call` argument ({ agent, options }); everything the handler used to
// close over is injected in `wiring` — including the payload builders and the
// v2 packer, so this module keeps its import graph acyclic (read-payloads.js
// and preset-package.js both import from here, never the reverse).

/** Shared scope validation for the preset verbs (command-surface text). */
export const presetScopeError = spec => (spec?.scope !== 'global' && spec?.scope !== 'workspace')
  ? { kind: 'error', text: `capabilities: scope must be "global" | "workspace", got ${JSON.stringify(spec?.scope ?? null)}` }
  : null

/** The shared no-workspace command result (the historical shape: kind error). */
export const noWorkspaceError = () => ({ kind: 'error', text: JSON.stringify({ status: 'no-workspace' }) })

/**
 * The draft branch of the save-time set resolution: the client-supplied
 * arrays, normalized. (from:'applied' never takes this branch — its sets are
 * server-authoritative.)
 */
export const draftSelectionSets = spec => ({
  skills: Array.isArray(spec.skills) ? spec.skills : [],
  mcpServers: Array.isArray(spec.mcpServers) ? spec.mcpServers : [],
  unresolvedRefs: Array.isArray(spec.unresolvedRefs) ? spec.unresolvedRefs : [],
})

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * The /capabilities preset verb bodies. `wiring` is the handler's former
 * closure surface, injected explicitly:
 * @param {{
 *   openStore: () => any,
 *   provider: any,
 *   inventory: (options: any) => Promise<any>,
 *   lifecycle: any,
 *   builders: { buildPresetsPayload: Function, buildReceiptPayload: Function },
 *   packPresetPackage: Function,
 * }} wiring
 */
export function createPresetVerbs(wiring) {
  /**
   * Applied preset writers share one locked source proof. The library
   * enters this callback only under its namespace guard, and holds the
   * selection lock until the target unit CAS has finished.
   */
  const appliedPresetSource = (spec, sets, store, agent, options) => commit => store.withSelectionSnapshot(agent.id, async current => {
    if (!Number.isSafeInteger(spec.expectedSelectionRevision) || spec.expectedSelectionRevision < 0
      || typeof spec.expectedSelectionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(spec.expectedSelectionDigest)
      || current.revision !== spec.expectedSelectionRevision) return { status: 'source-changed', revision: current.revision }
    const receipt = await wiring.builders.buildReceiptPayload({ provider: wiring.provider, lifecycle: wiring.lifecycle, store }, options)
    const effective = receipt.effective
    const selected = effective.skillIdentities
    const raw = current.kind === 'ok' ? current.payload?.skills : null
    if (current.kind === 'ok') {
      const rawKeys = new Set()
      const effectiveKeys = new Set(selected.map(skillIdentityKey))
      const missing = []
      for (const identity of Array.isArray(raw) ? raw : []) {
        try {
          const key = skillIdentityKey(createSkillIdentity(identity))
          rawKeys.add(key)
          if (!effectiveKeys.has(key)) missing.push(identity.name)
        } catch { missing.push(String(identity?.name ?? identity ?? 'unknown')) }
      }
      if (!Array.isArray(raw) || missing.length || rawKeys.size !== selected.length || receipt.warnings.length) {
        return { status: 'source-unavailable', missing, reason: receipt.warnings[0] ?? 'Selected Skills are not completely available' }
      }
      if (!Array.isArray(current.payload?.mcpServers)
        || JSON.stringify(current.payload.mcpServers) !== JSON.stringify(effective.mcpServers)) {
        return { status: 'source-unavailable', missing: [], reason: 'Applied MCP snapshot is unavailable' }
      }
    } else if (receipt.warnings.length) return { status: 'source-unavailable', missing: [], reason: receipt.warnings[0] }
    // Provider enumeration can short-circuit an empty selection.
    const observed = await wiring.inventory(options)
    if (observed?.complete !== true) return { status: 'source-unavailable', missing: [], reason: 'Skill inventory is incomplete' }
    if (effective.digest !== spec.expectedSelectionDigest || receipt.revision !== current.revision) {
      return { status: 'source-changed', revision: current.revision }
    }
    sets.skills.push(...selected)
    sets.mcpServers.push(...effective.mcpServers)
    return commit()
  })

  /** presets: thin shell over the shared builder. */
  async function presets(_spec, call) {
    // Thin shell over the shared builder (read-payloads.js): domain failures
    // stay JSON status text (the panel categorizes them); the remote resolves
    // the same object as a plain value.
    try {
      const payload = await wiring.builders.buildPresetsPayload({ store: wiring.openStore() }, call.options)
      if (typeof payload.status === 'string') return { kind: 'error', text: JSON.stringify(payload) }
      return { kind: 'success', text: JSON.stringify(payload) }
    } catch (cause) {
      return { kind: 'error', text: `capabilities presets failed: ${message(cause)}` }
    }
  }

  /** preset-save / preset-rename / preset-resave (one shared body, per action). */
  async function presetSaveLike(action, spec, call) {
    try {
      const scopeError = presetScopeError(spec)
      if (scopeError) return scopeError
      const workspaceKey = workspaceKeyOf(call.options)
      if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspaceError()
      const library = createPresetLibrary({ store: wiring.openStore() })
      if (action === 'preset-rename' || action === 'preset-resave') {
        if (!isSegment(spec.presetId)) return { kind: 'error', text: `${action}: invalid presetId` }
        if (!Number.isSafeInteger(spec.expectedRevision) || spec.expectedRevision < 1) return { kind: 'error', text: `${action}: expectedRevision must be positive` }
        if (action === 'preset-rename') {
          const result = await library.rename({ scope: spec.scope, presetId: spec.presetId, workspaceKey, expectedRevision: spec.expectedRevision, name: spec.name })
          return { kind: 'success', text: JSON.stringify(result) }
        }
        if (spec.from !== 'draft' && spec.from !== 'applied') return { kind: 'error', text: 'preset-resave: from must be draft or applied' }
        if (spec.from === 'draft' && ![spec.skills, spec.mcpServers, spec.unresolvedRefs].every(Array.isArray)) {
          return { kind: 'error', text: JSON.stringify({ status: 'invalid-selection' }) }
        }
        const store = wiring.openStore()
        const sets = spec.from === 'applied' ? { skills: [], mcpServers: [], unresolvedRefs: [] } : draftSelectionSets(spec)
        const withSource = spec.from === 'applied' ? appliedPresetSource(spec, sets, store, call.agent, call.options) : undefined
        const result = await library.resave({
          scope: spec.scope, presetId: spec.presetId, workspaceKey, expectedRevision: spec.expectedRevision,
          selection: sets, withSource,
        })
        return { kind: 'success', text: JSON.stringify(result) }
      }
      if (spec.from !== 'draft' && spec.from !== 'applied') return { kind: 'error', text: 'preset-save: from must be draft or applied' }
      if (typeof spec.name !== 'string' || !spec.name.length) return { kind: 'error', text: 'preset-save: name must be non-empty' }
      if (spec.expectedRevision !== undefined && spec.from === 'draft' && ![spec.skills, spec.mcpServers, spec.unresolvedRefs].every(Array.isArray)) {
        return { kind: 'error', text: JSON.stringify({ status: 'invalid-selection' }) }
      }
      const store = wiring.openStore()
      const sets = spec.from === 'applied' ? { skills: [], mcpServers: [], unresolvedRefs: [] } : draftSelectionSets(spec)
      const selection = { skills: sets.skills, mcpServers: sets.mcpServers, unresolvedRefs: sets.unresolvedRefs }
      const withSource = spec.from === 'applied' ? appliedPresetSource(spec, sets, store, call.agent, call.options) : undefined
      if (spec.expectedRevision !== undefined) {
        if (!isSegment(spec.presetId)) return { kind: 'error', text: 'preset-save: edit needs presetId' }
        const result = await library.edit({ scope: spec.scope, presetId: spec.presetId, workspaceKey,
          expectedRevision: spec.expectedRevision, mutate: () => ({ name: spec.name, selection }), withSource })
        return { kind: 'success', text: JSON.stringify(result) }
      }
      const result = await library.create({ scope: spec.scope, presetId: spec.presetId, workspaceKey,
        document: { name: spec.name, selection }, onNameConflict: spec.onNameConflict ?? 'cancel', replaceTarget: spec.replaceTarget, withSource })
      return { kind: 'success', text: JSON.stringify(result) }
    } catch (cause) {
      return { kind: 'error', text: `capabilities ${action} failed: ${message(cause)}` }
    }
  }

  /** preset-load: load one preset document; the client stages its selection. */
  async function presetLoad(spec, call) {
    try {
      const scopeError = presetScopeError(spec)
      if (scopeError) return scopeError
      if (!isSegment(spec.presetId)) return { kind: 'error', text: 'capabilities preset-load: presetId must be a valid store segment' }
      const workspaceKey = workspaceKeyOf(call.options)
      if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspaceError()
      const library = createPresetLibrary({ store: wiring.openStore() })
      const loaded = await library.load(spec.scope, spec.presetId, workspaceKey)
      if (loaded.kind !== 'ok') return { kind: 'success', text: JSON.stringify({ status: loaded.kind }) }
      return { kind: 'success', text: JSON.stringify({ status: 'ok', revision: loaded.revision, document: loaded.document }) }
    } catch (cause) {
      return { kind: 'error', text: `capabilities preset-load failed: ${message(cause)}` }
    }
  }

  /** preset-delete: delete under CAS; a stale revision conflicts. */
  async function presetDelete(spec, call) {
    try {
      const scopeError = presetScopeError(spec)
      if (scopeError) return scopeError
      if (!isSegment(spec.presetId)) return { kind: 'error', text: 'capabilities preset-delete: presetId must be a valid store segment' }
      if (!Number.isSafeInteger(spec.expectedRevision) || spec.expectedRevision < 0) {
        return { kind: 'error', text: 'capabilities preset-delete: expectedRevision must be a non-negative integer' }
      }
      const workspaceKey = workspaceKeyOf(call.options)
      if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspaceError()
      const library = createPresetLibrary({ store: wiring.openStore() })
      const result = await library.remove({ scope: spec.scope, presetId: spec.presetId, workspaceKey, expectedRevision: spec.expectedRevision })
      return { kind: 'success', text: JSON.stringify(result) }
    } catch (cause) {
      return { kind: 'error', text: `capabilities preset-delete failed: ${message(cause)}` }
    }
  }

  /**
   * preset-export: format:'document' is the v1 portable document (verbatim
   * via library.exportPreset — inspect/backup); the default 'package' is the
   * D6 version-2 package: remote Skills as portable refs, workspace/local
   * Skills as bundled content, builtin Skills by name, managed MCP as
   * {identity,label}.
   */
  async function presetExport(spec, call) {
    try {
      const scopeError = presetScopeError(spec)
      if (scopeError) return scopeError
      if (!isSegment(spec.presetId)) return { kind: 'error', text: 'capabilities preset-export: presetId must be a valid store segment' }
      const format = spec.format ?? 'package'
      if (format !== 'package' && format !== 'document') {
        return { kind: 'error', text: 'capabilities preset-export: format must be "package" | "document"' }
      }
      const workspaceKey = workspaceKeyOf(call.options)
      if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspaceError()
      const library = createPresetLibrary({ store: wiring.openStore() })
      if (format === 'document') {
        const exported = await library.exportPreset(spec.scope, spec.presetId, workspaceKey)
        return { kind: 'success', text: JSON.stringify(exported) }
      }
      const loaded = await library.load(spec.scope, spec.presetId, workspaceKey)
      if (loaded.kind !== 'ok') return { kind: 'success', text: JSON.stringify({ status: loaded.kind }) }
      // Pack against the live inventory (Skill file content comes from the
      // matched candidates' locators) and the managed registry (MCP labels).
      const inventoryResult = await wiring.inventory(call.options)
      const candidates = Array.isArray(inventoryResult?.candidates) ? inventoryResult.candidates : []
      const registry = createMcpRegistry({ store: wiring.openStore() })
      const record = await registry.read()
      /** @type {Record<string, string>} */
      const labels = {}
      if (record.kind === 'ok') for (const entry of Object.values(record.servers)) labels[entry.identity] = entry.label
      const source = /** @type {Record<string, unknown>} */ (loaded.document ?? {})
      const packed = await wiring.packPresetPackage({ name: source.name, selection: source.selection }, {
        candidates,
        mcpLabels: identity => labels[identity],
      })
      if (!packed.ok) return { kind: 'error', text: JSON.stringify({ status: 'rejected', reason: packed.reason }) }
      return { kind: 'success', text: JSON.stringify({ status: 'ok', format: 'package', document: packed.package }) }
    } catch (cause) {
      return { kind: 'error', text: `capabilities preset-export failed: ${message(cause)}` }
    }
  }

  return {
    presets,
    'preset-save': (spec, call) => presetSaveLike('preset-save', spec, call),
    'preset-rename': (spec, call) => presetSaveLike('preset-rename', spec, call),
    'preset-resave': (spec, call) => presetSaveLike('preset-resave', spec, call),
    'preset-load': presetLoad,
    'preset-delete': presetDelete,
    'preset-export': presetExport,
  }
}
