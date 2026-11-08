// Serialized, transactional access to the authoritative Decision Agent database.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateDecisionDatabase } from './migrate.js'

export class DecisionStoreError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DecisionStoreError'
    this.code = code
  }
}
export class StoreBusy extends DecisionStoreError {
  constructor(cause) { super('STORE_BUSY', 'decision store is locked by another writer', cause) }
}
export class AsyncTransactionError extends DecisionStoreError {
  constructor() { super('ASYNC_TRANSACTION', 'transaction callbacks must be synchronous; returning a Promise rolled back') }
}

/** @param {unknown} value @returns {value is PromiseLike<unknown>} */
function isPromiseLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function'
}

export class DecisionDatabase {
  /** @param {string} path */
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true })
    this.path = path
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA busy_timeout=3000')
    this.db.exec('PRAGMA foreign_keys=ON')
    this.inTransaction = false
    /** @type {Promise<unknown>} */
    this.tail = Promise.resolve()
  }

  /** @template T @param {(db: DatabaseSync) => T} mutate @returns {T} */
  transaction(mutate) {
    if (this.inTransaction) throw new DecisionStoreError('NESTED_TRANSACTION', 'nested BEGIN IMMEDIATE is not allowed')
    this.inTransaction = true
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const value = mutate(this.db)
      if (isPromiseLike(value)) throw new AsyncTransactionError()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original failure. */ }
      if (/** @type {{errcode?: number}} */ (error)?.errcode === 5) throw new StoreBusy(error)
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  /** @template T @param {() => T} mutate @returns {Promise<T>} */
  write(mutate) {
    const run = this.tail.then(() => this.transaction(mutate), () => this.transaction(mutate))
    this.tail = run.catch(() => {})
    return run
  }

  close() { this.db.close() }
}

/** @param {string} path @param {{ migrations?: readonly (readonly string[])[] }} [options] */
export function openDecisionDatabase(path, options = {}) {
  const store = new DecisionDatabase(path)
  try {
    migrateDecisionDatabase(store, options)
    return store
  } catch (error) {
    store.close()
    throw error
  }
}
