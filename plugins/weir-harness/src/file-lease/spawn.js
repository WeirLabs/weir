// Start `weir-editlockd` as a detached child of this process.
//
// This is the only place in the client half that touches the process table, and
// it is deliberately dumb: fire, forget, never wait, never throw. A `null`
// return is a normal outcome — the binary may be gone, the socket directory may
// be unwritable, or the platform may refuse the spawn — and the caller answers
// it by degrading the write instead of blocking it (design D7).
//
// Why `ELECTRON_RUN_AS_NODE=1` (do not remove):
//
// The host CLI starts DSH as `ELECTRON_RUN_AS_NODE=1 exec "DeepSeek Harness"
// cli.js`, so inside a live session `process.execPath` is the Electron binary,
// not `node`. Launching a script with it without that variable boots a second
// Electron app instead of running our daemon. Under a plain Node binary the
// variable is a harmless no-op, which is why the tests can use this same module
// unchanged.
//
// `detached` + `unref()` (rather than `stdio: inherit`) is what makes the
// daemon outlive the caller: the client is not this daemon's supervisor, and
// the daemon's own idle window is the only thing that ends it.

import { spawn } from 'node:child_process'
import process, { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'

/** The daemon entry shipped next to this module's package. */
const DEFAULT_ENTRY_URL = new URL('../lease-broker/entry.js', import.meta.url)

/**
 * @typedef {object} SpawnDaemonOptions
 * @property {URL | string} [entryUrl] executable script; defaults to `../lease-broker/entry.js`
 * @property {Record<string, string | undefined>} [env] extra environment (socket path, idle window)
 */

/**
 * Spawn the lease broker daemon and forget about it.
 *
 * Never throws and never resolves anything: the caller learns "a daemon may now
 * be starting" (truthy) or "no daemon was started" (`null`) and re-tries the
 * socket either way. Failures are intentionally silent — an unstartable daemon
 * is an infrastructure degrade, not an error the user has to see or fix.
 *
 * @param {SpawnDaemonOptions} [options]
 * @returns {import('node:child_process').ChildProcess | null} the detached child, or `null` when the spawn failed
 */
export function spawnDaemon({ entryUrl = DEFAULT_ENTRY_URL, env } = {}) {
  try {
    const entry = fileURLToPath(entryUrl)
    const child = spawn(execPath, [entry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    // The client is not the daemon's supervisor: nothing here may keep this
    // process alive, and nothing here waits for the daemon to become reachable.
    child.unref()
    return child
  } catch {
    return null
  }
}
