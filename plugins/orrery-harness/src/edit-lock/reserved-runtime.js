import { reservePublisher } from './reservation.js'
import { openEditLockRuntime } from './runtime.js'

/** Open only after exclusive reservation. A failure to OPEN releases it (nothing
 * was published); a crash or failed drain after opening retains it for
 * operator-assisted recovery. Callers never auto-promote after a disconnect.
 * `mode` may be decided only after the reservation is held.
 * @param {Omit<Parameters<typeof openEditLockRuntime>[0], 'assertExclusive'|'mode'> & {mode: 'create'|'recover'|(() => 'create'|'recover'),
 *   reservation?: Parameters<typeof reservePublisher>[1]}} options */
export async function openReservedEditLockRuntime(options) {
  const reservation = await reservePublisher(options.directory, options.reservation)
  let runtime
  try {
    const mode = typeof options.mode === 'function' ? options.mode() : options.mode
    runtime = await openEditLockRuntime({...options, mode, assertExclusive:reservation.assertExclusive})
  } catch (error) {
    // The runtime never opened, so this process published nothing under the
    // reservation: it is provably quiescent and must not strand its own claim.
    // Keeping it made the next attempt in the SAME process see EEXIST, take the
    // client path and fail closed against a socket nobody serves.
    try { reservation.releaseAfterQuiescence() } catch { /* replaced: leave it for a human */ }
    throw error
  }
  /** @type {Promise<void> | undefined} */
  let closing
  return Object.freeze({
    control: runtime.control,
    requests: runtime.requests,
    close() {
      if (!closing) closing = (async () => {
        await runtime.close()
        reservation.releaseAfterQuiescence()
      })()
      return closing
    },
  })
}
