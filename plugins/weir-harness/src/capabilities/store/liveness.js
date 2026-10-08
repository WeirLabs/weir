// Owner liveness for capability store locks (design D2). A lock owner is
// 'dead' only on proof: same host and the pid is gone (ESRCH), the pid now
// belongs to a process with a different OS start time (pid reuse), or the pid
// is ours but carries another boot nonce. Everything else is 'alive' or
// 'unknown', and neither may ever be reclaimed automatically.
import { execFile as nodeExecFile } from 'node:child_process'
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
    nodeExecFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
      const text = error ? '' : String(stdout).trim()
      resolve(text.length > 0 ? text : null)
    })
  })
}

// Windows has no ps(1): the process start time comes from Windows PowerShell,
// present on every supported Windows host (verified: powershell.exe Get-Process
// StartTime.ToFileTimeUtc(), ~0.5s warm). The probe fails closed to null — an
// unreadable start time is 'unknown', never 'dead'. The pid is interpolated
// only after the integer check below and the callers' own validation
// (parseOwnerDoc requires a safe integer; state() re-checks before probing).
/**
 * @param {number} pid
 * @param {((file: string, args: string[], options: object, callback: (error: Error | null, stdout: string) => void) => void)} [execFileImpl]
 * @returns {Promise<string|null>}
 */
export function windowsStartTime(pid, execFileImpl = /** @type {any} */ (nodeExecFile)) {
  return new Promise(resolve => {
    if (!Number.isSafeInteger(pid) || pid <= 0) { resolve(null); return }
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
      const text = error ? '' : String(stdout).trim()
      resolve(/^[0-9]+$/.test(text) ? text : null)
    })
  })
}

/** Module-level self start-identity: the own-process start time never changes,
 * so the default configuration pays the start-time probe once per process (on
 * win32 that probe is a subprocess) instead of once per store instance.
 * Injected pids, boot nonces or probes bypass this cache.
 * @type {Promise<StartIdentity>|undefined} */
let selfIdentity

/**
 * @param {{
 *   pid?: number,
 *   host?: string,
 *   bootNonce?: string,
 *   platform?: string,
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
  const platform = options.platform ?? process.platform
  const startTime = options.startTime ?? (platform === 'win32' ? windowsStartTime : psStartTime)
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
      if (pid === process.pid && bootNonce === PROCESS_BOOT_NONCE && options.startTime === undefined) {
        selfIdentity ??= startTime(pid).then(osStart => ({ osStart, bootNonce }))
        return selfIdentity
      }
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
