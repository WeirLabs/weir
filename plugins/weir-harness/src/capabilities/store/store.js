// The capability Storage Module (design D2): a deep module whose Interface is
// read(unit), commit(unit, expectedRevision, mutate) and publishPointer(scope,
// next). Locking, stale-lock reclamation, temp cleanup, schema checks and the
// platform gate stay inside; the filesystem Adapter is the only seam.
import { join } from 'node:path'
import { createNodeFs } from './fs-adapter.js'
import { createLiveness } from './liveness.js'
import { createLockProtocol } from './lock.js'
import { validPresetPayload } from './enumerate.js'
import { isFileSegment, isSegment, resolveStoreRoot, unitLayout } from './paths.js'
import { decodeRecord, digestOf, encodeRecord } from './record.js'

/**
 * Platforms whose rename/fsync/link matrix row is EXECUTED (C-1.10 §6 darwin
 * row; win32 row: openspec windows-platform-adaptation — hard-link EEXIST,
 * rename-replace, file fsync and kill(pid,0) verified on NTFS with Node v24.
 * Directory fsync is skipped on win32, see fs-adapter.js).
 */
export const SUPPORTED_PLATFORMS = Object.freeze(['darwin', 'win32'])

/**
 * @typedef {import('./paths.js').Unit} Unit
 * @typedef {import('./record.js').Receipt} Receipt
 * @typedef {import('./record.js').RecordRead} RecordRead
 * @typedef {{ requestId?: string, requestDigest?: string }} RequestRef
 * @typedef {{ status: 'committed', revision: number, payload: unknown, receipt: Receipt|null }
 *   | { status: 'duplicate', revision: number, receipt: Receipt }
 *   | { status: 'revision-conflict', revision: number }
 *   | { status: 'request-conflict', receipt: Receipt }
 *   | { status: 'locked', reason: string }
 *   | { status: 'unreadable', kind: 'corrupt'|'unknown-schema'|'torn' }
 *   | { status: 'generation-exists' }
 *   | { status: 'unsupported', reason: string }
 *   | { status: 'write-failed', error: unknown }} CommitResult
 */

/** @param {unknown} error @param {...string} codes */
const hasCode = (error, ...codes) => codes.includes(/** @type {{ code?: string }} */ (error)?.code ?? '')

/**
 * @param {{
 *   profileContext?: unknown,
 *   root?: string,
 *   platform?: string,
 *   fs?: import('./fs-adapter.js').StoreFs,
 *   liveness?: import('./liveness.js').Liveness,
 *   leaseMs?: number,
 *   deadlineMs?: number,
 *   now?: () => number,
 *   token?: () => string,
 * }} options
 */
export function openCapabilityStore(options) {
  const fs = options.fs ?? createNodeFs()
  const liveness = options.liveness ?? createLiveness()
  const now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  const located = typeof options.root === 'string' ? { supported: true, root: options.root } : resolveStoreRoot(options.profileContext)
  /** @type {{ supported: true, root: string } | { supported: false, reason: string }} */
  const support = !SUPPORTED_PLATFORMS.includes(platform)
    ? { supported: false, reason: `platform-unsupported:${platform}` }
    : /** @type {any} */ (located)
  const lock = createLockProtocol({ fs, liveness, leaseMs: options.leaseMs, deadlineMs: options.deadlineMs, now, token: options.token })
  /** @type {Map<string, Promise<unknown>>} */
  const queues = new Map()

  /** @param {Unit} unit */
  function locate(unit) {
    const layout = unitLayout(unit)
    if (!support.supported) return { layout, dir: '', record: '' }
    const dir = join(support.root, ...layout.segments)
    return { layout, dir, record: join(dir, `${layout.name}.json`) }
  }

  /** Per-unit in-process FIFO in front of the file lock. @template T @param {string} key @param {() => Promise<T>} task @returns {Promise<T>} */
  function serialize(key, task) {
    const previous = queues.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => {})
    queues.set(key, tail)
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return run
  }

  /** @param {string} path @returns {Promise<RecordRead>} */
  async function readRecord(path) {
    let text
    try {
      text = await fs.readText(path)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return { kind: 'absent', revision: 0 }
      throw error
    }
    return decodeRecord(text)
  }

  /**
   * @param {Unit} unit
   * @returns {Promise<RecordRead | { kind: 'unsupported', reason: string }>}
   */
  async function read(unit) {
    const { record } = locate(unit)
    if (!support.supported) return { kind: 'unsupported', reason: support.reason }
    return readRecord(record)
  }

  /** Hold the accepted-selection unit lock during the preset CAS. Apply takes
   * this same lock, so its revision cannot change between confirmation and
   * publication. Called only under namespace guard (namespace → selection → preset).
   * @param {string} sessionId @param {(record: RecordRead) => Promise<any>} task
   */
  async function withSelectionSnapshot(sessionId, task) {
    const { layout, dir, record } = locate({ kind: 'selection', sessionId })
    if (!support.supported) return { status: 'unsupported', reason: support.reason }
    return serialize(layout.key, async () => {
      await fs.mkdirp(dir)
      const acquired = await lock.acquire(dir, layout.name)
      if (!acquired.ok) return { status: acquired.reason.includes('unreadable') || acquired.reason.includes('unknown-schema') ? 'unreadable' : 'locked', reason: acquired.reason }
      try {
        await lock.cleanup(dir, layout.name, acquired.token)
        let current
        try { current = await readRecord(record) }
        catch (error) { return { status: 'unreadable', reason: String(error) } }
        if (current.kind !== 'ok' && current.kind !== 'absent') return { status: 'unreadable', kind: current.kind }
        return await task(current)
      } finally {
        await lock.release(dir, layout.name, acquired.token).catch(() => {})
      }
    })
  }
  /** Serialize a preset namespace before touching any per-ID lock. The reserved
   * .namespace directory cannot be a legal preset ID or a JSON record stem.
   * @param {'global'|'workspace'} scope @param {string|undefined} workspaceKey
   * @param {(view: { scan: () => Promise<any> }) => Promise<any>} task
   */
  async function withPresetNamespace(scope, workspaceKey, task) {
    const layout = unitLayout(scope === 'global'
      ? { kind: 'preset', scope, presetId: 'probe' }
      : { kind: 'preset', scope, workspaceKey, presetId: 'probe' })
    if (!support.supported) return { status: 'unsupported', reason: support.reason }
    const dir = join(support.root, ...layout.segments)
    const guardDir = join(dir, '.namespace')
    return serialize(`${layout.segments.join('/')}/.namespace`, async () => {
      let taskStarted = false
      try {
        await fs.mkdirp(guardDir)
        const acquired = await lock.acquire(guardDir, 'writer')
        if (!acquired.ok) return { status: acquired.reason.includes('unreadable') || acquired.reason.includes('unknown-schema') ? 'unreadable' : 'locked', reason: acquired.reason }
        try {
          await lock.cleanup(guardDir, 'writer', acquired.token)
          const scan = async () => {
            const activeById = new Map()
            const names = new Map()
            const occupiedIds = new Set()
            let entries
            try { entries = await fs.readdir(dir) }
            catch (error) { return { status: 'unreadable', reason: String(error) } }
            for (const entry of entries) {
              const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.exec(entry)
              if (!match) continue
              const presetId = match[1]
              occupiedIds.add(presetId)
              // ENOENT is not an empty record: only a completed deletion is a
              // tombstone. An external mutation during the scan fails closed.
              let text
              try { text = await fs.readText(join(dir, entry)) }
              catch (error) { return { status: 'unreadable', presetId, reason: String(error) } }
              const record = decodeRecord(text)
              if (record.kind !== 'ok') return { status: 'unreadable', presetId, kind: record.kind }
              const doc = record.payload
              if (doc && typeof doc === 'object' && !Array.isArray(doc) && doc.deleted === true) continue
              if (!validPresetPayload(doc)) return { status: 'unreadable', presetId, kind: 'invalid-preset' }
              activeById.set(presetId, { revision: record.revision, document: doc })
              const ids = names.get(doc.name) ?? []
              ids.push(presetId)
              names.set(doc.name, ids)
            }
            return { status: 'ok', activeById, names, occupiedIds }
          }
          taskStarted = true
          return await task({ scan })
        } finally {
          await lock.release(guardDir, 'writer', acquired.token).catch(() => {})
        }
      } catch (error) {
        if (taskStarted) throw error
        return { status: 'unreadable', reason: String(error) }
      }
    })
  }
  /**
   * @param {Unit} unit
   * @param {number} expectedRevision
   * @param {(payload: unknown, info: { revision: number }) => unknown | Promise<unknown>} mutate
   * @param {RequestRef} request
   * @param {((ctx: { dir: string, ownerToken: string }) => Promise<'ok'|'generation-exists'>) | null} prepare
   * @returns {Promise<CommitResult>}
   */
  async function transact(unit, expectedRevision, mutate, request, prepare) {
    const { layout, dir, record } = locate(unit)
    if (!support.supported) return { status: 'unsupported', reason: support.reason }
    const { requestId, requestDigest } = request
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0 || typeof requestDigest !== 'string')) {
      throw new TypeError('requestId requires a non-empty id and a requestDigest')
    }
    return serialize(layout.key, async () => {
      await fs.mkdirp(dir)
      const acquired = await lock.acquire(dir, layout.name)
      if (!acquired.ok) return { status: 'locked', reason: acquired.reason }
      try {
        await lock.cleanup(dir, layout.name, acquired.token)
        const current = await readRecord(record)
        if (current.kind !== 'ok' && current.kind !== 'absent') return { status: 'unreadable', kind: current.kind }
        const receipts = current.kind === 'ok' ? current.receipts : []
        if (requestId !== undefined) {
          const prior = receipts.find(r => r.requestId === requestId)
          if (prior) return prior.requestDigest === requestDigest ? { status: 'duplicate', revision: prior.revision, receipt: prior } : { status: 'request-conflict', receipt: prior }
        }
        if (current.revision !== expectedRevision) return { status: 'revision-conflict', revision: current.revision }
        const revision = current.revision + 1
        const payload = await mutate(current.kind === 'ok' ? current.payload : undefined, { revision: current.revision })
        if (prepare) {
          const prepared = await prepare({ dir, ownerToken: acquired.token })
          if (prepared !== 'ok') return { status: prepared }
        }
        /** @type {Receipt|null} */
        const receipt = requestId === undefined ? null : { requestId, requestDigest: /** @type {string} */ (requestDigest), revision, acceptedAt: now() }
        const next = encodeRecord(revision, payload, receipt ? [...receipts, receipt] : receipts)
        const temp = join(dir, `${layout.name}.${acquired.token}.tmp`)
        try {
          await fs.createExclusive(temp, JSON.stringify(next))
          await fs.fsyncFile(temp)
        } catch (error) {
          await fs.unlink(temp).catch(() => {})
          return { status: 'write-failed', error }
        }
        try {
          await fs.rename(temp, record)
          await fs.fsyncDir(dir)
        } catch (error) {
          await fs.unlink(temp).catch(() => {})
          if (hasCode(error, 'EXDEV')) return { status: 'unsupported', reason: 'cross-device' }
          const settled = await readRecord(record).catch(() => null)
          if (settled?.kind !== 'ok' || settled.digest !== next.digest) return { status: 'write-failed', error }
        }
        return { status: 'committed', revision, payload, receipt }
      } finally {
        await lock.release(dir, layout.name, acquired.token).catch(() => {})
      }
    })
  }

  /**
   * @param {Unit} unit @param {number} expectedRevision
   * @param {(payload: unknown, info: { revision: number }) => unknown | Promise<unknown>} mutate
   * @param {RequestRef} [request]
   */
  const commit = (unit, expectedRevision, mutate, request = {}) => transact(unit, expectedRevision, mutate, request, null)

  /**
   * Publish an immutable content generation and switch `active.json` to it.
   * The generation is written and fsynced under the unit lock after the CAS
   * check, so a conflicting publisher never leaves a generation behind; the
   * pointer, provenance and receipt live in the one renamed file.
   * @param {string} scope
   * @param {{ expectedRevision: number, generationId: string, files: Record<string, string>, provenance?: unknown } & RequestRef} next
   */
  function publishPointer(scope, next) {
    const { expectedRevision, generationId, files, provenance, requestId, requestDigest } = next
    if (!isSegment(generationId)) throw new TypeError(`invalid generation id: ${String(generationId)}`)
    const names = Object.keys(files ?? {})
    if (!names.every(isFileSegment) || !names.every(name => typeof files[name] === 'string')) throw new TypeError('invalid generation files')
    const manifest = Object.fromEntries(names.sort().map(name => [name, digestOf(files[name])]))
    return transact({ kind: 'distribution', scope }, expectedRevision, () => ({ generationId, manifest, provenance: provenance ?? null }), { requestId, requestDigest }, async ({ dir }) => {
      const generations = join(dir, 'generations')
      const target = join(generations, generationId)
      await fs.mkdirp(generations)
      if ((await fs.readdir(generations)).includes(generationId)) return 'generation-exists'
      await fs.mkdirp(target)
      for (const name of names) {
        const path = join(target, name)
        await fs.createExclusive(path, files[name])
        await fs.fsyncFile(path)
      }
      await fs.fsyncDir(target)
      await fs.fsyncDir(generations)
      return 'ok'
    })
  }

  /** @param {Unit} unit */
  async function inspect(unit) {
    const { layout, dir } = locate(unit)
    if (!support.supported) return { kind: 'unsupported', reason: support.reason }
    return lock.inspect(dir, layout.name)
  }

  /** @param {Unit} unit @param {'lock'|'recover'} which @param {string|null} ownerToken */
  async function clear(unit, which, ownerToken) {
    const { layout, dir } = locate(unit)
    if (!support.supported) return 'unsupported'
    return serialize(layout.key, () => lock.clear(dir, layout.name, which, ownerToken))
  }

  return { support, read, commit, publishPointer, inspect, clear, withPresetNamespace, withSelectionSnapshot }
}
