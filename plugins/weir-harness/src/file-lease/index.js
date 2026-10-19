// Public surface of the file-lease client subtree (edit-lock-rebuild 3.1–3.5).
//
// Barrel only: importing this module must have no side effects — no socket, no
// spawn, no audit — because the adapters that use it (`hashline-edit`, `lsp`,
// the tool surface) are loaded for every session, including the ones that never
// touch a managed write. `plugin.js` exports a row (`name`/`inject`/`apply`) and
// a factory; neither connects anything until `apply` runs, and the process-wide
// client that `singleton.js` owns is created lazily on first use (D11).

export {
  createLeaseClient,
  isLeaseConflict,
  TRANSPORT_CODE,
  DEGRADED_AUDIT_WINDOW_MS,
} from './client.js'
export { createLineageResolver } from './lineage.js'
export { spawnDaemon } from './spawn.js'
export {
  createLeaseTools,
  REPLY_TOOL,
  MAX_HOLD_MINUTES,
  DEFAULT_HOLD_MINUTES,
} from './tools.js'
export { createFileLeasePlugin, name, inject, apply } from './plugin.js'
// D11 wiring: the process-wide client and the owner/scope rule the managed
// editors share.
export { getSharedLeaseClient, createEditorLease, defaultLeaseEndpoint } from './singleton.js'
