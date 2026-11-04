// Profile-scoped, user-managed Skill discovery roots. The capability store owns
// locking, revisions and crash-safe writes; this module owns strict payload
// validation and canonical directory semantics. No mutation executes a command,
// appends to a session, or treats a failed write as a discovery change.
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'
import { canonicalPathKey } from './skill-applicability.js'

export const SKILL_SCAN_PATH_UNIT = Object.freeze({ kind: 'skill-scan-paths' })

const message = error => error instanceof Error ? error.message : String(error)
const codeOf = error => error?.code
const missing = error => ['ENOENT', 'ENOTDIR'].includes(codeOf(error))
const denied = error => ['EACCES', 'EPERM'].includes(codeOf(error))
const clone = paths => [...paths]

class SkillPathFailure extends Error {
  constructor(code, text, result = undefined) {
    super(text)
    this.name = 'SkillPathFailure'
    this.code = code
    this.result = result
  }
}

const validation = (code, text) => ({
  status: 'validation-failed', saved: false, revision: null, paths: null,
  error: { code, message: text },
})

const unavailable = (code, text, revision = null) => ({
  status: 'unavailable', saved: false, revision, paths: null,
  error: { code, message: text },
})

/**
 * Comparison of paths already canonicalized by realpath. Registry payloads never
 * store this folded key: the canonical spelling remains the display/read value.
 */
function storedPathKey(path, pathApi, platform) {
  let key = pathApi.normalize(path)
  if (platform === 'win32') key = key.replaceAll('\\', '/').toLowerCase()
  return key.replace(/\/+$/, '')
}

/** Strict payload shape: unknown or malformed records are never repaired. */
function payloadPaths(payload, pathApi, platform) {
  if (payload === undefined) return []
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).length !== 1 || !Array.isArray(payload.paths)
    || !payload.paths.every(path => typeof path === 'string' && path.length > 0 && pathApi.isAbsolute(path))) {
    throw new SkillPathFailure('invalid-payload', 'Skill scan path registry payload is invalid')
  }
  const seen = new Set()
  for (const path of payload.paths) {
    const key = storedPathKey(path, pathApi, platform)
    if (seen.has(key)) throw new SkillPathFailure('invalid-payload', 'Skill scan path registry contains duplicate paths')
    seen.add(key)
  }
  return clone(payload.paths)
}

/**
 * @param {{
 *   store: ReturnType<typeof import('./store/store.js').openCapabilityStore>,
 *   fs?: { realpath(path: string): Promise<string>, stat(path: string): Promise<{ isDirectory(): boolean }>, access(path: string, mode?: number): Promise<void> },
 *   home?: string,
 *   platform?: string,
 *   pathApi?: typeof nodePath,
 * }} options
 */
export function createSkillScanPathRegistry(options) {
  const store = options.store
  const fs = options.fs ?? { realpath, stat, access }
  const platform = options.platform ?? process.platform
  const pathApi = options.pathApi ?? (platform === 'win32' ? nodePath.win32 : nodePath)
  const home = options.home ?? homedir()
  const unit = SKILL_SCAN_PATH_UNIT

  const pathKey = path => storedPathKey(path, pathApi, platform)

  function expanded(input) {
    if (typeof input !== 'string') throw new SkillPathFailure('path-invalid', 'Skill scan path must be a string')
    const trimmed = input.trim()
    if (!trimmed) throw new SkillPathFailure('path-empty', 'Skill scan path cannot be empty')
    let value = trimmed
    if (trimmed === '~') value = home
    else if (trimmed.startsWith('~/') || (platform === 'win32' && trimmed.startsWith('~\\'))) {
      if (typeof home !== 'string' || !pathApi.isAbsolute(home)) throw new SkillPathFailure('home-unavailable', 'Home directory is unavailable')
      value = pathApi.resolve(home, trimmed.slice(2))
    }
    if (!pathApi.isAbsolute(value)) throw new SkillPathFailure('path-not-absolute', 'Skill scan path must be absolute or start with ~')
    return value
  }

  async function canonicalForAdd(input) {
    const value = expanded(input)
    let canonical
    try { canonical = await fs.realpath(value) }
    catch (error) {
      if (missing(error)) throw new SkillPathFailure('path-missing', `Skill scan path does not exist: ${value}`)
      if (denied(error)) throw new SkillPathFailure('path-unreadable', `Skill scan path is unreadable: ${value}`)
      throw new SkillPathFailure('path-canonicalization-failed', `Cannot canonicalize Skill scan path: ${message(error)}`)
    }
    let info
    try { info = await fs.stat(canonical) }
    catch (error) {
      throw new SkillPathFailure(denied(error) ? 'path-unreadable' : 'path-missing', `Cannot inspect Skill scan path: ${message(error)}`)
    }
    if (!info.isDirectory()) throw new SkillPathFailure('path-not-directory', `Skill scan path is not a directory: ${canonical}`)
    try { await fs.access(canonical, constants.R_OK) }
    catch (error) { throw new SkillPathFailure('path-unreadable', `Skill scan path is not readable: ${message(error)}`) }
    return { path: canonical, key: pathKey(canonical) }
  }

  async function keyForRemove(input) {
    const value = expanded(input)
    try { return pathKey(await fs.realpath(value)) }
    catch (error) {
      if (!missing(error)) {
        throw new SkillPathFailure(denied(error) ? 'path-unreadable' : 'path-canonicalization-failed', `Cannot canonicalize Skill scan path: ${message(error)}`)
      }
      // Removal must remain possible after a directory disappears. The shared
      // platform key canonicalizes the deepest surviving ancestor without
      // requiring the removed directory itself to exist.
      const key = canonicalPathKey(value, platform)
      if (key === null) throw new SkillPathFailure('path-canonicalization-failed', `Cannot canonicalize Skill scan path: ${value}`)
      return key
    }
  }

  async function read() {
    let record
    try { record = await store.read(unit) }
    catch (error) { return unavailable('read-failed', `Skill scan path registry is unreadable: ${message(error)}`) }
    if (record.kind === 'absent') return { status: 'ok', revision: 0, paths: [] }
    if (record.kind !== 'ok') return unavailable(record.kind, `Skill scan path registry is ${record.kind}`)
    try {
      return { status: 'ok', revision: record.revision, paths: payloadPaths(record.payload, pathApi, platform) }
    } catch (error) {
      return unavailable(error?.code ?? 'invalid-payload', message(error), record.revision)
    }
  }

  async function currentAfterConflict(result) {
    const current = await read()
    if (current.status === 'ok') return { revision: current.revision, paths: current.paths, error: null }
    return {
      revision: result.revision ?? current.revision ?? null,
      paths: null,
      error: { code: 'current-state-unavailable', message: `Revision conflict; current registry state is unavailable: ${current.error?.message ?? current.status}` },
    }
  }

  async function mutate(kind, input, expectedRevision, options = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return validation('revision-invalid', 'expectedRevision must be a non-negative safe integer')
    }
    let candidate
    try { candidate = kind === 'add' ? await canonicalForAdd(input) : { key: await keyForRemove(input) } }
    catch (error) {
      if (error instanceof SkillPathFailure) return validation(error.code, error.message)
      return validation('path-validation-failed', message(error))
    }

    let result
    try {
      result = await store.commit(unit, expectedRevision, async payload => {
        let paths
        try { paths = payloadPaths(payload, pathApi, platform) }
        catch (error) {
          throw new SkillPathFailure(error?.code ?? 'invalid-payload', message(error), unavailable(error?.code ?? 'invalid-payload', message(error)))
        }
        const index = paths.findIndex(path => pathKey(path) === candidate.key)
        if (kind === 'add' && index >= 0) {
          throw new SkillPathFailure('duplicate', `Skill scan path is already registered: ${paths[index]}`, {
            status: 'duplicate', saved: false, revision: expectedRevision, paths: clone(paths),
            error: { code: 'duplicate', message: `Skill scan path is already registered: ${paths[index]}` },
          })
        }
        if (kind === 'remove' && index < 0) {
          throw new SkillPathFailure('not-found', `Skill scan path is not registered: ${input}`, {
            status: 'not-found', saved: false, revision: expectedRevision, paths: clone(paths),
            error: { code: 'not-found', message: `Skill scan path is not registered: ${input}` },
          })
        }
        // Ownership is rechecked under the unit lock, immediately before the
        // payload is handed to the store's atomic write phase.
        await options.assertOwner?.()
        return { paths: kind === 'add' ? [...paths, candidate.path] : paths.filter((_, i) => i !== index) }
      })
    } catch (error) {
      if (error?.code === 'owner-changed') throw error
      if (error instanceof SkillPathFailure && error.result) return error.result
      return {
        status: 'storage-failed', saved: false, revision: null, paths: null,
        error: { code: 'storage-failed', message: message(error) },
      }
    }

    if (result.status === 'committed') {
      return {
        status: kind === 'add' ? 'saved' : 'removed', saved: true,
        revision: result.revision, paths: clone(result.payload.paths), error: null,
      }
    }
    if (result.status === 'revision-conflict') {
      const current = await currentAfterConflict(result)
      return {
        status: 'revision-conflict', saved: false, revision: current.revision, paths: current.paths,
        error: current.error ?? { code: 'revision-conflict', message: `Skill scan path registry revision ${expectedRevision} is stale` },
      }
    }
    return {
      status: result.status, saved: false, revision: result.revision ?? null, paths: null,
      error: { code: result.kind ?? result.status, message: result.reason ?? message(result.error ?? `Skill scan path registry write failed: ${result.status}`) },
    }
  }

  return {
    unit,
    read,
    add: (path, expectedRevision, options) => mutate('add', path, expectedRevision, options),
    remove: (path, expectedRevision, options) => mutate('remove', path, expectedRevision, options),
  }
}

/** Registry read failures must become visible inventory/roots failures. */
export async function requireSkillScanPaths(registry) {
  const result = await registry.read()
  if (result.status !== 'ok') {
    throw new Error(`Skill scan path registry unavailable: ${result.error?.message ?? result.status}`)
  }
  return result.paths
}
