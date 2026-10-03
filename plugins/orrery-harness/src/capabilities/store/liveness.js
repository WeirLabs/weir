// Owner liveness for capability store locks (design D2). A lock owner is
// 'dead' only on proof: same host and the pid is gone (ESRCH), the pid now
// belongs to a process with a different OS start time (pid reuse), or the pid
// is ours but carries another boot nonce. Everything else is 'alive' or
// 'unknown', and neither may ever be reclaimed automatically.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'

/** One per process: every store in this process must recognize the others' locks as alive. */
const PROCESS_BOOT_NONCE = randomBytes(8).toString('hex')

/**
 * @typedef {{ osStart: string|null, bootNonce: string }} StartIdentity
 * @typedef {{ pid: number, host: string, startIdentity?: Partial<StartIdentity> }} Owner
 * @typedef {{
 *   pid: number,
 *   host: string,
 *   identity(): Promise<StartIdentity>,
 *   state(owner: Owner): Promise<'alive'|'dead'|'unknown'>,
 * }} Liveness
 */

/** @param {number} pid @returns {Promise<string|null>} */
export function psStartTime(pid) {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      const text = error ? '' : String(stdout).trim()
      resolve(text.length > 0 ? text : null)
    })
  })
}

/**
 * @param {{
 *   pid?: number,
 *   host?: string,
 *   bootNonce?: string,
 *   kill?: (pid: number) => void,
 *   startTime?: (pid: number) => Promise<string|null>,
 * }} [options]
 * @returns {Liveness}
 */
export function createLiveness(options = {}) {
  const pid = options.pid ?? process.pid
  const host = options.host ?? hostname()
  const bootNonce = options.bootNonce ?? PROCESS_BOOT_NONCE
  const kill = options.kill ?? (target => { process.kill(target, 0) })
  const startTime = options.startTime ?? psStartTime
  /** @type {Promise<StartIdentity>|undefined} */
  let self

  /** @param {number} target @returns {'present'|'gone'|'unknown'} */
  function probe(target) {
    try {
      kill(target)
      return 'present'
    } catch (error) {
      return /** @type {{ code?: string }} */ (error)?.code === 'ESRCH' ? 'gone' : 'unknown'
    }
  }

  return {
    pid,
    host,
    identity() {
      self ??= startTime(pid).then(osStart => ({ osStart, bootNonce }))
      return self
    },
    async state(owner) {
      if (owner === null || typeof owner !== 'object') return 'unknown'
      if (owner.host !== host || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'unknown'
      if (owner.pid === pid) return owner.startIdentity?.bootNonce === bootNonce ? 'alive' : 'dead'
      const first = probe(owner.pid)
      if (first !== 'present') return first === 'gone' ? 'dead' : 'unknown'
      const current = await startTime(owner.pid)
      if (current === null) return probe(owner.pid) === 'gone' ? 'dead' : 'unknown'
      const recorded = owner.startIdentity?.osStart
      if (typeof recorded !== 'string') return 'unknown'
      return current === recorded ? 'alive' : 'dead'
    },
  }
}
