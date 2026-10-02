import { reservePublisher } from './reservation.js'
import { openEditLockRuntime } from './runtime.js'

/** Open only after exclusive reservation. Failures retain the reservation for
 * operator-assisted recovery; callers never auto-promote after a disconnect.
 * `mode` may be decided only after the reservation is held.
 * @param {Omit<Parameters<typeof openEditLockRuntime>[0], 'assertExclusive'|'mode'> & {mode: 'create'|'recover'|(() => 'create'|'recover')}} options */
export async function openReservedEditLockRuntime(options) {
  const reservation = reservePublisher(options.directory)
  const mode = typeof options.mode === 'function' ? options.mode() : options.mode
  const runtime = await openEditLockRuntime({...options, mode, assertExclusive:reservation.assertExclusive})
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
