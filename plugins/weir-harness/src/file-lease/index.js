// Public surface of the file-lease client subtree (edit-lock-rebuild 3.1–3.3).
//
// Barrel only: importing this module must have no side effects — no socket, no
// spawn, no audit — because the adapters that will import it (`hashline-edit`,
// `lsp`, the tool surface) are loaded for every session, including the ones that
// never touch a managed write.

export {
  createLeaseClient,
  isLeaseConflict,
  TRANSPORT_CODE,
  DEGRADED_AUDIT_WINDOW_MS,
} from './client.js'
export { createLineageResolver } from './lineage.js'
export { spawnDaemon } from './spawn.js'
