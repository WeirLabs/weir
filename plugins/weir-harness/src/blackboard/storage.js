// Session-adjacent storage. Never creates Session directories or touches the
// host's session.lock. Missing logs preserve all sidecars (no automatic GC).
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, dirname, basename, isAbsolute } from 'node:path'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { ENTRY_TYPES, PROMOTION_DESTINATIONS, validateKey, validateSummary } from './kernel.js'

export const LOG = /^session\.v([1-9][0-9]*)\.jsonl(?:\.zstd)?$/
const SIDE = /^session\.v[1-9][0-9]*\.jsonl(?:\.zstd)?_bb$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/
const LOCK = 'weir-blackboard.lock'
const uid = () => process.getuid?.()
const code = error => error?.code
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export function sessionId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('blackboard: invalid Session identity')
  return id
}

// Recheck every ancestor; realpath alone would silently accept symlink aliases.
export async function trusted(path, kind = 'file', absent = false, allowLinks = false) {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent !== absolute) await trusted(parent, 'directory')
  let stat
  try { stat = await fs.lstat(absolute) } catch (error) {
    if (absent && code(error) === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) throw new Error(`blackboard: untrusted ${kind}: ${absolute}`)
  // System ancestors may be root-owned; Session files/directories must belong
  // to this user (checked by the caller at the session boundary).
  if (kind === 'file' && (!allowLinks && stat.nlink !== 1 || (uid() !== undefined && stat.uid !== uid()))) throw new Error(`blackboard: unsafe file ownership: ${absolute}`)
  return stat
}

export async function locateSession(home, id, expectedCwd) {
  sessionId(id)
  if (typeof home !== 'string' || !home || !home.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(home)) throw new Error('blackboard: profileContext.home unavailable')
  const root = join(home, 'sessions')
  await trusted(root, 'directory')
  const matches = []
  for (const workspace of await fs.readdir(root)) {
    const dir = join(root, workspace, id)
    let stat
    try { stat = await trusted(dir, 'directory') } catch (error) {
      if (code(error) === 'ENOENT') continue
      throw error
    }
    if (uid() !== undefined && stat.uid !== uid()) throw new Error('blackboard: foreign Session directory')
    const logs = (await fs.readdir(dir)).filter(name => LOG.test(name))
    // Highest generation is DSH's canonical selection. Same-version physical
    // encodings are ambiguous: never guess which installation owns the log.
    if (logs.some(name => !Number.isSafeInteger(Number(LOG.exec(name)[1])))) throw new Error('blackboard: unsupported canonical generation number')
    logs.sort((a, b) => Number(LOG.exec(b)[1]) - Number(LOG.exec(a)[1]))
    if (!logs.length) continue
    const name = logs[0]
    if (logs[1] && LOG.exec(logs[1])[1] === LOG.exec(name)[1]) throw new Error('blackboard: ambiguous canonical log')
    const path = join(dir, name)
    await trusted(path)
    const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let bytes
    try { bytes = await handle.readFile() } finally { await handle.close() }
    let header
    try {
      const text = name.endsWith('.zstd') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
      header = JSON.parse(text.split('\n')[0])
    } catch { throw new Error('blackboard: unreadable Session header') }
    if (header.type !== 'session' || header.id !== id || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || header.version !== Number(LOG.exec(name)[1]) || expectedCwd !== undefined && header.cwd !== expectedCwd) throw new Error('blackboard: Session header identity/cwd mismatch')
    matches.push({ id, dir, log: path, file: join(dir, name + '_bb'), header })
  }
  if (matches.length !== 1) throw new Error(`blackboard: ${matches.length ? 'ambiguous Session directories' : 'durable Session log unavailable; sidecars preserved'}`)
  return matches[0]
}

export function decodeRecord(text, id) {
  let record
  try { record = JSON.parse(text) } catch { throw new Error('blackboard: corrupt sidecar') }
  if (!record || record.schemaVersion !== 1 || record.rootSessionId !== id || !Number.isSafeInteger(record.revision) || record.revision < 0 || !Array.isArray(record.entries)) throw new Error('blackboard: unsupported/corrupt sidecar identity or schema')
  const seen = new Set()
  for (const e of record.entries) {
    validateKey(e?.key)
    validateSummary(e.summary)
    if (seen.has(e.key) || !ENTRY_TYPES.includes(e.entryType) || typeof e.content !== 'string' || !e.content.trim() || !['readCount', 'subscribeCount', 'createdAt', 'updatedAt', 'revision'].every(k => Number.isSafeInteger(e[k]) && e[k] >= (k === 'revision' ? 1 : 0)) || e.promoted && (!PROMOTION_DESTINATIONS.includes(e.promoted.destination) || !Number.isSafeInteger(e.promoted.at) || e.promoted.at < 0)) throw new Error('blackboard: invalid durable entry')
    // Explicit field projection: never revive authorization or unknown fields.
    seen.add(e.key)
  }
  return { schemaVersion: 1, rootSessionId: id, revision: record.revision, entries: record.entries.map(e => ({ key: e.key, entryType: e.entryType, summary: e.summary, content: e.content, readCount: e.readCount, subscribeCount: e.subscribeCount, revision: e.revision, createdAt: e.createdAt, updatedAt: e.updatedAt, ...(e.promoted ? { promoted: { destination: e.promoted.destination, at: e.promoted.at } } : {}) })) }
}

// Only ESRCH proves death. A module reload/new nonce in the SAME live PID
// never grants reclamation. Unknown host/permissions fail closed.
function dead(owner) {
  if (owner?.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try { process.kill(owner.pid, 0); return false } catch (error) { return code(error) === 'ESRCH' }
}

const ownerKey = Symbol.for('weir.blackboard.storage.owner.v1')
const writerToken = globalThis[ownerKey] ??= randomUUID()

export function createBlackboardStorage({ home, hook = async (_op, _path) => {}, timeoutMs = 5000 } = {}) {
  const queue = new Map()
  async function safeRead(path) {
    await trusted(path, 'file', false, basename(path).startsWith(LOCK))
    const fd = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { return await fd.readFile('utf8') } finally { await fd.close() }
  }
  async function syncDir(dir) {
    await hook('dir-fsync', dir)
    const fd = await fs.open(dir, 'r')
    try { await fd.sync() } finally { await fd.close() }
  }
  async function publish(file, text) {
    await trusted(dirname(file), 'directory')
    await trusted(file, 'file', true)
    const temp = join(dirname(file), `weir-blackboard.${randomUUID()}.tmp`)
    let renamed = false
    try {
      await hook('create', temp)
      const fd = await fs.open(temp, 'wx', 0o600)
      try { await fd.writeFile(text); await hook('file-fsync', temp); await fd.sync() } finally { await fd.close() }
      await hook('rename', file)
      await trusted(file, 'file', true)
      await fs.rename(temp, file)
      renamed = true
      try { await syncDir(dirname(file)) } catch (error) {
        // Rename may have committed. Confirm the authoritative full bytes;
        // this is not a rollback and the token must not become usable twice.
        if (await safeRead(file) !== text) throw error
      }
    } finally {
      if (!renamed) await fs.unlink(temp).catch(() => {})
    }
  }
  async function lock(dir) {
    const path = join(dir, LOCK)
    const recover = path + '.recover'
    const owner = JSON.stringify({ schemaVersion: 1, token: randomUUID(), host: hostname(), pid: process.pid })
    const candidate = path + '.' + randomUUID() + '.candidate'
    const fd = await fs.open(candidate, 'wx', 0o600)
    try { await fd.writeFile(owner); await fd.sync() } finally { await fd.close() }
    const deadline = Date.now() + timeoutMs
    try {
      for (;;) {
        await trusted(path, 'file', true, true)
        try { await fs.link(candidate, path); break } catch (error) { if (code(error) !== 'EEXIST') throw error }
        const previous = await safeRead(path).catch(error => { if (code(error) === 'ENOENT') return null; throw error })
        if (previous === null) continue
        let doc
        try { doc = JSON.parse(previous) } catch { throw new Error('blackboard: unreadable writer lock; manual recovery required') }
        if (doc.schemaVersion !== 1) throw new Error('blackboard: unknown writer lock schema')
        if (dead(doc)) {
          // Recovery gate is never stolen: interruption fails closed and needs
          // offline cleanup. It prevents two stale observers removing a successor.
          await trusted(recover, 'file', true)
          try { await fs.link(candidate, recover) } catch (error) {
            if (code(error) !== 'EEXIST') throw error
            throw new Error('blackboard: recovery already in progress; manual recovery may be required')
          }
          try {
            if (await safeRead(path) === previous && dead(doc)) await fs.unlink(path)
          } finally { if (await safeRead(recover) === owner) await fs.unlink(recover) }
          continue
        }
        if (Date.now() >= deadline) throw new Error('blackboard: writer lock held by a live/unknown process')
        await pause(10)
      }
    } finally { await fs.unlink(candidate) }
    return async () => { if (await safeRead(path) === owner) await fs.unlink(path) }
  }
  async function transact(id, cwd, action) {
    let where = await locateSession(home, id, cwd)
    const release = await lock(where.dir)
    try {
      // Re-resolve under the version-independent lock, before reading candidates.
      where = await locateSession(home, id, cwd)
      const ownerPath = join(where.dir, 'weir-blackboard.writer')
      let owned = false
      if (await trusted(ownerPath, 'file', true)) {
        let owner
        try { owner = JSON.parse(await safeRead(ownerPath)) } catch { throw new Error('blackboard: corrupt writer authority') }
        if (owner.schemaVersion !== 1 || owner.token !== writerToken && !dead(owner)) throw new Error('blackboard: authority belongs to another live/unknown writer')
        owned = owner.token === writerToken
      }
      if (!owned) await publish(ownerPath, JSON.stringify({ schemaVersion: 1, token: writerToken, host: hostname(), pid: process.pid }))
      const records = []
      for (const name of (await fs.readdir(where.dir)).filter(name => SIDE.test(name))) {
        records.push({ path: join(where.dir, name), record: decodeRecord(await safeRead(join(where.dir, name)), id) })
      }
      if (records.some(row => JSON.stringify(row.record) !== JSON.stringify(records[0].record))) throw new Error('blackboard: conflicting sidecars; originals preserved')
      const previous = records[0]?.record ?? { schemaVersion: 1, rootSessionId: id, revision: 0, entries: [] }
      // Migrate the unchanged snapshot first, so a cleanup failure never
      // leaves a newer canonical record beside an older conflicting source.
      if (!records.some(row => row.path === where.file)) await publish(where.file, JSON.stringify(previous) + '\n')
      for (const row of records) if (row.path !== where.file) {
        if (!SIDE.test(basename(row.path)) || dirname(row.path) !== where.dir) throw new Error('blackboard: unsafe migration path')
        if (JSON.stringify(decodeRecord(await safeRead(row.path), id)) !== JSON.stringify(previous)) throw new Error('blackboard: migration source changed')
        await fs.unlink(row.path)
      }
      const result = await action(structuredClone(previous.entries))
      const entries = result.entries
      const changed = JSON.stringify(entries) !== JSON.stringify(previous.entries)
      const next = { ...previous, revision: previous.revision + (changed ? 1 : 0), entries }
      const encoded = JSON.stringify(decodeRecord(JSON.stringify(next), id)) + '\n'
      if (JSON.stringify(decodeRecord(await safeRead(where.file), id)) !== JSON.stringify(previous)) throw new Error('blackboard: revision conflict')
      const current = await locateSession(home, id, cwd)
      if (current.file !== where.file) throw new Error('blackboard: canonical log changed during commit')
      if (changed) await publish(where.file, encoded)
      return result.publish()
    } finally { await release() }
  }
  // One-time fork seeding: a forked Session is its own board root, but its
  // board starts as a snapshot of the fork source's durable root board. Both
  // directories stay under the writer lock in deterministic path order, and
  // the fork is only ever seeded while it has no sidecar of its own — a
  // re-seed can never overwrite or merge an initialized board.
  async function seedFork(id, parentId, cwd) {
    sessionId(id)
    let hopId = sessionId(parentId)
    // The source's durable root is resolved on disk: a delegated source has
    // no sidecar of its own, so ascend its parent chain to the root board it
    // actually used.
    const seen = new Set()
    let source
    for (let hop = 0; hop < 64; hop++) {
      if (seen.has(hopId)) throw new Error('blackboard: cyclic Session parent chain')
      seen.add(hopId)
      const located = await locateSession(home, hopId)
      const depth = located.header.delegationDepth ?? 0
      if (!Number.isSafeInteger(depth) || depth < 0) throw new Error('blackboard: invalid Session delegation depth')
      if (depth === 0) { source = located; break }
      hopId = sessionId(located.header.parentSession)
    }
    if (!source) throw new Error('blackboard: Session ancestry exceeds safety limit')
    const child = await locateSession(home, id, cwd)
    // Two directories need two writer locks; taking them in deterministic
    // path-string order means single-lock users (transact) can never
    // deadlock with this pair. Distinct Session ids never share a directory.
    const [first, second] = source.dir < child.dir ? [source.dir, child.dir] : [child.dir, source.dir]
    const releaseFirst = await lock(first)
    let releaseSecond
    try { releaseSecond = await lock(second) } catch (error) { await releaseFirst(); throw error }
    try {
      const records = []
      for (const name of (await fs.readdir(source.dir)).filter(name => SIDE.test(name))) {
        records.push(decodeRecord(await safeRead(join(source.dir, name)), source.id))
      }
      if (!records.length) return false
      if (records.some(record => JSON.stringify(record) !== JSON.stringify(records[0]))) throw new Error('blackboard: conflicting sidecars; originals preserved')
      // Idempotence: any existing fork sidecar means the board is already
      // initialized — never overwrite or merge.
      if ((await fs.readdir(child.dir)).some(name => SIDE.test(name))) return false
      // Volatile state (tokens/subscriptions/timers) is never persisted, so
      // the snapshot carries durable entry fields only; the fork starts at
      // revision 0 under its own root identity.
      const seeded = { schemaVersion: 1, rootSessionId: id, revision: 0, entries: structuredClone(records[0].entries) }
      const encoded = JSON.stringify(decodeRecord(JSON.stringify(seeded), id)) + '\n'
      await publish(child.file, encoded)
      return true
    } finally {
      let failure
      try { await releaseSecond() } catch (error) { failure ??= error }
      try { await releaseFirst() } catch (error) { failure ??= error }
      if (failure) throw failure
    }
  }
  return {
    locate: (id, cwd) => locateSession(home, id, cwd),
    seedFork,
    async releaseWriter(id, cwd) {
      let where
      try { where = await locateSession(home, id, cwd) } catch { return }
      const release = await lock(where.dir)
      try {
        const path = join(where.dir, 'weir-blackboard.writer')
        if (await trusted(path, 'file', true)) {
          const owner = JSON.parse(await safeRead(path))
          if (owner.schemaVersion === 1 && owner.token === writerToken) await fs.unlink(path)
        }
      } finally { await release() }
    },
    transact(id, cwd, action) {
      const previous = queue.get(id) ?? Promise.resolve()
      const next = previous.catch(() => {}).then(() => transact(id, cwd, action))
      queue.set(id, next)
      void next.finally(() => { if (queue.get(id) === next) queue.delete(id) }).catch(() => {})
      return next
    },
  }
}
