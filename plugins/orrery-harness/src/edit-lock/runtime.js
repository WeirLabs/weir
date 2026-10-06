import { realpathSync, statSync, constants } from 'node:fs'
import { open, rename } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openEditLockStore } from './store.js'
import { createEditLockManager, recoverEditLockManager } from './manager.js'
import { createPublisher } from './publisher.js'
import { reservationPathFor } from './reservation.js'

const domains = new Set()

/** Durable publication of one administrative backup artifact inside the
 * authority directory (temp + rename + directory sync, like the snapshot).
 * @param {string} directory @param {string} file @param {Buffer} bytes */
async function writeAuthorityFile(directory, file, bytes) {
  const temporary = join(directory, `.backup-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await rename(temporary, join(directory, file))
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await dir.sync() } finally { await dir.close() }
}

/** Internal host lifecycle, not a model-facing service. Process-local exclusion
 * supplements, but does not replace, the caller's cross-process lifecycle lease.
 * The optional process identity and Liveness adapter (design D2/D3) come from
 * the reservation layer: the incarnation is registered in the durable image,
 * and a recovery open administratively settles unknown publications of
 * provably dead incarnation processes in the recovery commit.
 * @param {{directory: string, root: string, domainId: string, mode: 'create'|'recover',
 * fs: Parameters<typeof createPublisher>[0]['fs'],
 * assertExclusive: () => void,
 * processIdentity?: import('./incarnations.js').ProcessIdentity|null,
 * liveness?: import('../capabilities/store/liveness.js').Liveness|null}} options */
export async function openEditLockRuntime(options) {
  options.assertExclusive()
  const root = realpathSync.native(options.root)
  if (!statSync(root).isDirectory()) throw new Error('management root must be directory')
  if (domains.has(root)) throw new Error('management domain already open')
  if (!isAbsolute(options.directory)) throw new Error('absolute authority directory required')
  const directory = realpathSync.native(options.directory)
  // The authority may live inside the domain, but its files and reservation
  // are never targets of the managed business publisher.
  const excluded = [directory, reservationPathFor(directory)]
  if (excluded.some(path => path === root || !relative(path, root).startsWith('..'))) throw new Error('authority directory must not contain the business domain')
  domains.add(root)
  /** @type {Awaited<ReturnType<typeof openEditLockStore>> | undefined} */
  let store
  try {
    store = await openEditLockStore({ directory, domainId: options.domainId, mode: options.mode })
    const openedStore = store
    const processIdentity = options.processIdentity ?? null
    const liveness = options.liveness ?? null
    /** @type {{records: any[], revision: number}|null} */
    let automaticRecovery = null
    const manager = options.mode === 'recover'
      ? await recoverEditLockManager({ store, managerIncarnation: randomUUID(), processIdentity, liveness,
        root: liveness && processIdentity ? options.domainId : null,
        writeBackup: liveness && processIdentity ? (file, bytes) => writeAuthorityFile(directory, file, bytes) : null,
        onAutomaticRecovery: info => { automaticRecovery = info } })
      : createEditLockManager({ store, managerIncarnation: randomUUID(), processIdentity })
    const publisher = createPublisher({ manager, fs: options.fs, root, excluded, assertExclusive: options.assertExclusive })
    let closing = false
    /** @type {Promise<void> | undefined} */
    let shutdown
    /** @type {Set<Promise<any>>} */
    const pending = new Set()
    /** @template T @param {() => Promise<T>} action */
    function run(action) {
      if (closing) throw new Error('edit lock runtime closing')
      options.assertExclusive()
      const work = action()
      pending.add(work)
      void work.then(() => pending.delete(work), () => pending.delete(work))
      return work
    }
    // Preserve synchronous cancellation overlays while sealing every public
    // control admission. Manager FIFO drain covers asynchronous control work.
    const control = new Proxy({ ...manager }, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver)
        if (typeof method !== 'function') return method
        return (/** @type {any[]} */ ...args) => {
          if (closing) throw new Error('edit lock runtime closing')
          options.assertExclusive()
          return method.apply(target, args)
        }
      },
    })
    return Object.freeze({
      // Trusted host control only; must never be passed to a tool's arguments.
      control,
      /** Dead-process unknowns settled in the recovery commit (design D3), or null. */
      automaticRecovery,
      requests: Object.freeze({
        /** @param {import('./state.js').Execution} execution @param {string[]} paths @param {string} cwd */
        acquireBatch(execution, paths, cwd) { return run(() => publisher.acquireBatch(execution, paths, cwd)) },
        /** @param {string} path @param {string} cwd */
        resource(path, cwd) {
          if (closing) throw new Error('edit lock runtime closing')
          return publisher.resource(path, cwd)
        },
        /** @param {Parameters<typeof publisher.prepare>[0]} execution
         * @param {Parameters<typeof publisher.prepare>[1]} request
         * @param {AbortSignal} signal */
        prepare(execution, request, signal) { return run(() => publisher.prepare(execution, request, signal)) },
        /** @param {object} submission */
        commit(submission) { return run(() => publisher.commit(submission)) },
      }),
      close() {
        if (shutdown) return shutdown
        closing = true
        shutdown = (async () => {
          await Promise.allSettled([...pending])
          await manager.drain()
          await manager.close()
          await openedStore.close()
          domains.delete(root)
        })()
        return shutdown
      },
    })
  } catch (error) {
    if (store) await store.close()
    domains.delete(root)
    throw error
  }
}
