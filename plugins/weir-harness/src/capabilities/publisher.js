// Tasks 11.1/11.2 of the session-capability-manager change: pre-publish
// target and reference validation, plus immutable-generation publishing with
// the universal → DSH root bridge.
//
// 11.1 — after resolution a target path must stay INSIDE its selected scope
// root; a symlink escaping the root is refused and named. Absolute paths,
// traversal paths and credential-carrying references are refused. An
// unrecognized install-lock schema stops everything — never migrated,
// rewritten, downgraded or deleted.
//
// 11.2 — staging lands on the target filesystem first; publications are
// serialized per scope/identity; the active manifest pointer, provenance and
// operation receipt switch in ONE atomic publication (the group-2
// distribution pointer). The active generation and local changes are
// re-checked with CAS before switching. A platform without supported atomic
// switch is reported unsupported — never delete-then-copy. Staging output
// maps to the DSH-recognized global / workspace skill roots; bundled paths
// are never allowed targets; the workspace root comes from the host session
// workspace resolver.
import { realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

export const LOCK_SCHEMA_VERSION = 1

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * The scope roots staging output may map to (11.2). `bundled` is present for
 * completeness of the table and is always a REFUSED target.
 * @param {{ agentsHome?: string, workspaceRoot?: string, bundledRoot?: string }} roots
 */
export function resolveScopeRoots({ agentsHome, workspaceRoot, bundledRoot } = {}) {
  const roots = {}
  if (typeof agentsHome === 'string' && agentsHome.length > 0) roots.global = join(agentsHome, 'skills')
  if (typeof workspaceRoot === 'string' && workspaceRoot.length > 0) roots.workspace = join(workspaceRoot, '.agents', 'skills')
  return {
    roots,
    /** @param {string} scope */
    rootFor(scope) {
      if (scope === 'bundled') return { allowed: false, reason: 'bundled paths are not publish targets' }
      const root = roots[scope]
      if (!root) return { allowed: false, reason: `scope root for "${scope}" is not configured` }
      return { allowed: true, root }
    },
  }
}

/** @param {unknown} ref */
export function referenceProblem(ref) {
  if (typeof ref !== 'string' || ref.length === 0) return 'reference must be a non-empty string'
  if (isAbsolute(ref)) return `absolute reference refused: ${ref}`
  if (ref.split(/[\\/]+/).includes('..')) return `traversal reference refused: ${ref}`
  if (/(token|secret|password|key|credential)[:=]/i.test(ref)) return `credential-carrying reference refused`
  return null
}

/**
 * The resolved target must stay inside the scope root; a symlink escaping
 * the root is refused and named (11.1).
 * @param {string} scopeRoot @param {string} targetPath
 * @param {{ realpath?: (path: string) => string }} [deps]
 */
export function validateTargetInsideRoot(scopeRoot, targetPath, deps = {}) {
  const realpath = deps.realpath ?? realpathSync
  const root = realpath(scopeRoot)
  let resolved
  try {
    resolved = realpath(targetPath)
  } catch {
    resolved = resolve(targetPath)
  }
  const inside = resolved === root || resolved.startsWith(`${root}${sep}`)
  if (!inside) {
    return { ok: false, reason: `target escapes the scope root: ${resolved} is outside ${root}${resolved === targetPath ? '' : ` (symlink from ${targetPath})`}` }
  }
  return { ok: true, resolved }
}

/**
 * The install lock must be schema-recognized before any write (11.1):
 * anything else stops without migrating, rewriting, downgrading or deleting.
 * @param {unknown} lockPayload
 */
export function lockVerdict(lockPayload) {
  if (lockPayload === null || typeof lockPayload !== 'object' || Array.isArray(lockPayload)) {
    return { recognized: false, reason: 'install lock payload is not an object' }
  }
  if (lockPayload.schemaVersion !== LOCK_SCHEMA_VERSION) {
    return { recognized: false, reason: `unrecognized install-lock schema version: ${JSON.stringify(lockPayload.schemaVersion)} — stopping without migrating, rewriting, downgrading or deleting` }
  }
  return { recognized: true }
}

/**
 * The pre-publish re-check (11.2): the active generation must still match
 * what the caller prepared against, and the local content must be untouched
 * since the managed digest was recorded.
 * @param {{ activeGeneration: string|null, expectedActive: string|null,
 *   localDigest: string|null, managedDigest: string|null }} input
 */
export function publishPrecondition({ activeGeneration, expectedActive, localDigest, managedDigest }) {
  if (activeGeneration !== expectedActive) {
    return { ok: false, reason: `active generation moved: expected ${expectedActive ?? 'none'}, found ${activeGeneration ?? 'none'}` }
  }
  if (typeof managedDigest === 'string' && managedDigest.length > 0 && localDigest !== managedDigest) {
    return { ok: false, reason: 'local content diverged from the last managed digest — showing the diff and pausing publication (overwrite / leave unchanged required)' }
  }
  return { ok: true }
}

/**
 * One immutable generation record (11.2): generation id, file manifest and
 * provenance — content-addressed by the manifest digest.
 * @param {{ identity: string, files: Record<string, string>, provenance: unknown, receipt: unknown }} input
 */
export function generationRecordOf({ identity, files, provenance, receipt }) {
  const manifest = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, createHash('sha256').update(String(content)).digest('hex')])
  )
  return {
    generationId: createHash('sha256').update(JSON.stringify([identity, manifest])).digest('hex').slice(0, 16),
    identity,
    manifest,
    provenance,
    receipt,
  }
}

export const __message = message
