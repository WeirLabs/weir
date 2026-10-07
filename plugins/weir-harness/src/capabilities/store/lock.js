// Per-unit exclusive file lock of the capability store (design D2).
//
// A lock is published atomically with full content: write a private candidate
// `<file>.<token>.cand`, fsync it, then link(2) it into place (EEXIST = lost the
// race). Never `wx`-then-write: a crash in between leaves a 0-byte lock that
// fail-closed rules can never reclaim. ENOENT from link means the holder's
// orphan sweep removed our candidate: lost this round, retry.
//
// A stale lock is reclaimed only when its lease expired AND its owner is proven
// dead. Reclamation is serialized by `<unit>.lock.recover` (published the same
// way); the reclaimer re-reads the lock and renames it only while it still names
// the observed dead owner, so a live lock is never renamed or removed.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

export const LOCK_SCHEMA_VERSION = 1

/**
 * @typedef {import('./fs-adapter.js').StoreFs} StoreFs
 * @typedef {import('./liveness.js').Liveness} Liveness
 * @typedef {{
 *   schemaVersion: number, ownerToken: string, pid: number, host: string,
 *   startIdentity: { osStart: string|null, bootNonce: string },
 *   acquiredAt: number, leaseUntil: number,
 * }} OwnerDoc
 * @typedef {{ kind: 'absent' } | { kind: 'ok', value: OwnerDoc } | { kind: 'corrupt' } | { kind: 'unknown-schema', schemaVersion: unknown }} DocRead
 * @typedef {{ renames: number, recheckAborts: number, attempts: number }} AcquireStats
 * @typedef {{ ok: true, token: string, reclaimed: boolean, stats: AcquireStats }
 *   | { ok: false, reason: 'locked'|'owner-unknown'|'lock-unreadable'|'lock-unknown-schema'|'recover-interrupted'|'recover-unreadable', stats: AcquireStats }} AcquireResult
 */

const TOKEN = /^[0-9a-f]{8,64}$/

/** @param {string} text @returns {DocRead} */
export function parseOwnerDoc(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'corrupt' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'corrupt' }
  if (value.schemaVersion !== LOCK_SCHEMA_VERSION) return { kind: 'unknown-schema', schemaVersion: value.schemaVersion }
  const ok = typeof value.ownerToken === 'string' && TOKEN.test(value.ownerToken)
    && Number.isSafeInteger(value.pid) && typeof value.host === 'string'
    && Number.isFinite(value.acquiredAt) && Number.isFinite(value.leaseUntil)
    && value.startIdentity !== null && typeof value.startIdentity === 'object'
  return ok ? { kind: 'ok', value } : { kind: 'corrupt' }
}

/** @param {unknown} error @param {...string} codes */
const hasCode = (error, ...codes) => codes.includes(/** @type {{ code?: string }} */ (error)?.code ?? '')

/**
 * @param {{
 *   fs: StoreFs,
 *   liveness: Liveness,
 *   leaseMs?: number,
 *   deadlineMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   token?: () => string,
 * }} options
 */
export function createLockProtocol(options) {
  const { fs, liveness } = options
  const leaseMs = options.leaseMs ?? 10_000
  const deadlineMs = options.deadlineMs ?? 5_000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const token = options.token ?? (() => randomBytes(12).toString('hex'))

  /** @param {string} dir @param {string} name */
  const files = (dir, name) => ({ lock: join(dir, `${name}.lock`), recover: join(dir, `${name}.lock.recover`) })

  /** @param {string} path @returns {Promise<DocRead>} */
  async function readDoc(path) {
    let text
    try {
      text = await fs.readText(path)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return { kind: 'absent' }
      throw error
    }
    return parseOwnerDoc(text)
  }

  /** @param {string} ownerToken @returns {Promise<OwnerDoc>} */
  async function ownerDoc(ownerToken) {
    const startIdentity = await liveness.identity()
    const at = now()
    return {
      schemaVersion: LOCK_SCHEMA_VERSION, ownerToken, pid: liveness.pid, host: liveness.host,
      startIdentity, acquiredAt: at, leaseUntil: at + leaseMs,
    }
  }

  /** Atomic full-content exclusive publication. @param {string} file @param {OwnerDoc} doc */
  async function publish(file, doc) {
    const candidate = `${file}.${doc.ownerToken}.cand`
    try {
      await fs.createExclusive(candidate, JSON.stringify(doc))
      await fs.fsyncFile(candidate)
      await fs.link(candidate, file)
      return true
    } catch (error) {
      if (hasCode(error, 'EEXIST', 'ENOENT')) return false
      throw error
    } finally {
      await fs.unlink(candidate).catch(() => {})
    }
  }

  /** Remove `file` only while it still names `ownerToken`. @param {string} file @param {string} ownerToken */
  async function releaseOwned(file, ownerToken) {
    const current = await readDoc(file)
    if (current.kind !== 'ok' || current.value.ownerToken !== ownerToken) return false
    try {
      await fs.unlink(file)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
    return true
  }

  /**
   * One serialized reclamation of the dead owner `observed` (design D2 steps 2-4).
   * @param {string} dir @param {string} name @param {OwnerDoc} observed @param {AcquireStats} stats
   * @returns {Promise<{ token: string } | { outcome: 'retry'|'recover-busy'|'recover-interrupted'|'recover-unreadable'|'aborted-recheck'|'lost-to-normal' }>}
   */
  async function reclaim(dir, name, observed, stats) {
    const p = files(dir, name)
    const recoverToken = token()
    if (!(await publish(p.recover, await ownerDoc(recoverToken)))) {
      const recover = await readDoc(p.recover)
      if (recover.kind === 'absent') return { outcome: 'retry' }
      if (recover.kind !== 'ok') return { outcome: 'recover-unreadable' }
      if (recover.value.leaseUntil <= now() && (await liveness.state(recover.value)) === 'dead') {
        return { outcome: 'recover-interrupted' }
      }
      return { outcome: 'recover-busy' }
    }
    try {
      const again = await readDoc(p.lock)
      if (again.kind !== 'ok' || again.value.ownerToken !== observed.ownerToken) {
        stats.recheckAborts++
        return { outcome: 'aborted-recheck' }
      }
      await fs.rename(p.lock, `${p.lock}.stale.${recoverToken}`)
      stats.renames++
      await fs.fsyncDir(dir)
      const next = token()
      return (await publish(p.lock, await ownerDoc(next))) ? { token: next } : { outcome: 'lost-to-normal' }
    } finally {
      await releaseOwned(p.recover, recoverToken).catch(() => {})
    }
  }

  /**
   * Acquire `<dir>/<name>.lock` with bounded backoff. Never writes the unit record.
   * @param {string} dir @param {string} name @returns {Promise<AcquireResult>}
   */
  async function acquire(dir, name) {
    const p = files(dir, name)
    const deadline = now() + deadlineMs
    /** @type {AcquireStats} */
    const stats = { renames: 0, recheckAborts: 0, attempts: 0 }
    /** @type {Extract<AcquireResult, { ok: false }>['reason']} */
    let reason = 'locked'
    let delay = 2
    for (;;) {
      stats.attempts++
      const mine = token()
      if (await publish(p.lock, await ownerDoc(mine))) return { ok: true, token: mine, reclaimed: false, stats }
      let retryNow = false
      const observed = await readDoc(p.lock)
      if (observed.kind === 'absent') retryNow = true
      else if (observed.kind === 'unknown-schema') reason = 'lock-unknown-schema'
      else if (observed.kind === 'corrupt') reason = 'lock-unreadable'
      else if (observed.value.leaseUntil > now()) reason = 'locked'
      else {
        const state = await liveness.state(observed.value)
        if (state === 'dead') {
          const result = await reclaim(dir, name, observed.value, stats)
          if ('token' in result) return { ok: true, token: result.token, reclaimed: true, stats }
          if (result.outcome === 'recover-interrupted') return { ok: false, reason: 'recover-interrupted', stats }
          if (result.outcome === 'recover-unreadable') reason = 'recover-unreadable'
          else if (result.outcome === 'recover-busy') reason = 'locked'
          else retryNow = true
        } else reason = state === 'alive' ? 'locked' : 'owner-unknown'
      }
      if (now() >= deadline) return { ok: false, reason, stats }
      if (retryNow) continue
      await sleep(delay + Math.random() * delay)
      delay = Math.min(delay * 2, 40)
    }
  }

  /** @param {string} dir @param {string} name @param {string} ownerToken */
  const release = (dir, name, ownerToken) => releaseOwned(files(dir, name).lock, ownerToken)

  /**
   * Holder-only sweep of this unit: orphaned temps (any token but ours), every
   * candidate, and renamed-away dead locks. Unit names carry no dots, so the
   * `<name>.` prefix never matches another unit in the same directory.
   * @param {string} dir @param {string} name @param {string} ownerToken
   */
  async function cleanup(dir, name, ownerToken) {
    /** @type {string[]} */
    const removed = []
    for (const entry of await fs.readdir(dir)) {
      const temp = entry.startsWith(`${name}.`) && entry.endsWith('.tmp') && entry !== `${name}.${ownerToken}.tmp`
      const candidate = entry.startsWith(`${name}.lock.`) && entry.endsWith('.cand')
      const stale = entry.startsWith(`${name}.lock.stale.`)
      if (!temp && !candidate && !stale) continue
      try {
        await fs.unlink(join(dir, entry))
        removed.push(entry)
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error
      }
    }
    return removed
  }

  /**
   * What the manual recovery entry shows: the lock and recover files as read.
   * @param {string} dir @param {string} name
   */
  async function inspect(dir, name) {
    const p = files(dir, name)
    const [lock, recover] = await Promise.all([readDoc(p.lock), readDoc(p.recover)])
    /** @param {DocRead} doc */
    const describe = async doc => doc.kind === 'ok'
      ? { kind: doc.kind, ownerToken: doc.value.ownerToken, host: doc.value.host, pid: doc.value.pid, leaseUntil: doc.value.leaseUntil, owner: await liveness.state(doc.value) }
      : { kind: doc.kind }
    return { lock: await describe(lock), recover: await describe(recover) }
  }

  /**
   * Manual recovery after the user confirmed: move the lock or recover file
   * aside, but only if it is still exactly what was shown (`ownerToken`, or
   * null for an unreadable file) and its owner is not alive.
   * @param {string} dir @param {string} name @param {'lock'|'recover'} which @param {string|null} ownerToken
   * @returns {Promise<'cleared'|'changed'|'owner-alive'>}
   */
  async function clear(dir, name, which, ownerToken) {
    const file = files(dir, name)[which]
    const current = await readDoc(file)
    if (current.kind === 'absent') return 'changed'
    if (current.kind === 'ok') {
      if (current.value.ownerToken !== ownerToken) return 'changed'
      if ((await liveness.state(current.value)) === 'alive') return 'owner-alive'
    } else if (ownerToken !== null) return 'changed'
    try {
      await fs.rename(file, `${files(dir, name).lock}.stale.${token()}`)
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return 'changed'
      throw error
    }
    await fs.fsyncDir(dir)
    return 'cleared'
  }

  return { acquire, release, cleanup, inspect, clear }
}
