#!/usr/bin/env node
// Executable entry for `weir-editlockd`, the edit-lock lease broker.
//
// Plain Node: it knows nothing about DSH, cordis or `ctx` — the adapter that
// talks to it lives in the bundle and speaks the protocol in
// docs/features/edit-lock-protocol.md.
//
// Environment:
//   WEIR_EDITLOCKD_SOCKET    endpoint address (default: defaultSocketPath())
//   WEIR_EDITLOCKD_IDLE_MS   idle window before self-exit (default 60000)
//   WEIR_EDITLOCKD_SWEEP_MS  memory-reclaim period (default 30000)
//
// The process ends in exactly two ways: SIGTERM/SIGINT (close, then exit 0), or
// the idle window elapsing with no connected client (close, then the event loop
// simply drains). Nothing is written to disk, so both are equally recoverable.

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { PROTOCOL } from './protocol.js'
import { createBroker } from './state.js'
import { DEFAULT_IDLE_MS, DEFAULT_SWEEP_MS, defaultSocketPath, startServer } from './server.js'

const VERSION_FALLBACK = '0.0.0'

/**
 * Version reported by the handshake, read from this package's manifest.
 * @returns {string}
 */
function readDaemonVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : VERSION_FALLBACK
  } catch {
    // A missing manifest must not stop the daemon: the version is diagnostic.
    return VERSION_FALLBACK
  }
}

/**
 * Read an interval override; anything that is not a positive integer falls back
 * to the default so a typo cannot turn the daemon into a busy loop or a
 * permanent resident.
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readInterval(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const daemonVersion = readDaemonVersion()
const socketPath = process.env.WEIR_EDITLOCKD_SOCKET || defaultSocketPath()
const idleMs = readInterval('WEIR_EDITLOCKD_IDLE_MS', DEFAULT_IDLE_MS)
const sweepMs = readInterval('WEIR_EDITLOCKD_SWEEP_MS', DEFAULT_SWEEP_MS)

/** @type {Awaited<ReturnType<typeof startServer>> | null} */
let server = null

// The kernel hands events to the transport by connection id; the sink reads the
// late-bound server handle because the broker must exist before startServer can
// register connections on it.
const broker = createBroker({
  onEvent: (connectionId, event) => {
    if (server !== null) server.send(connectionId, event)
  },
})

try {
  server = await startServer({ socketPath, broker, protocol: PROTOCOL, daemonVersion, idleMs, sweepMs })
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`weir-editlockd: ${detail}\n`)
  process.exit(1)
}

process.stderr.write(`weir-editlockd ${daemonVersion} listening on ${socketPath}\n`)

let shuttingDown = false

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  const handle = server
  if (handle !== null) {
    try {
      await handle.close()
    } catch {
      // Shutting down regardless: there is no state to preserve.
    }
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
