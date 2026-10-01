import { realpathSync, statSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openEditLockStore } from './store.js'
import { createEditLockManager, recoverEditLockManager } from './manager.js'
import { createPublisher } from './publisher.js'

const domains = new Set()

/** Internal host lifecycle, not a model-facing service. Process-local exclusion
 * supplements, but does not replace, the caller's cross-process lifecycle lease.
 * @param {{directory: string, root: string, domainId: string, mode: 'create'|'recover',
 * fs: Parameters<typeof createPublisher>[0]['fs'],
 * assertExclusive: () => void}} options */
export async function openEditLockRuntime(options) {
  options.assertExclusive()
  const root = realpathSync.native(options.root)
  if (!statSync(root).isDirectory()) throw new Error('management root must be directory')
  if (domains.has(root)) throw new Error('management domain already open')
  // Authority files must not be writable through the managed business publisher.
  if (!isAbsolute(options.directory)) throw new Error('absolute authority directory required')
  const directory = realpathSync.native(options.directory)
  const suffix = relative(root, directory)
  if (suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix)) throw new Error('authority directory overlaps business domain')
  domains.add(root)
  /** @type {Awaited<ReturnType<typeof openEditLockStore>> | undefined} */
  let store
  try {
    store = await openEditLockStore({ directory, domainId: options.domainId, mode: options.mode })
    const openedStore = store
    const manager = options.mode === 'recover'
      ? await recoverEditLockManager({ store, managerIncarnation: randomUUID() })
      : createEditLockManager({ store, managerIncarnation: randomUUID() })
    const publisher = createPublisher({ manager, fs: options.fs, root })
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
    return Object.freeze({
      // Trusted host control only; must never be passed to a tool's arguments.
      control: manager,
      requests: Object.freeze({
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
