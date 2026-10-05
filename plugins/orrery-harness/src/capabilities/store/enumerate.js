// Read-only preset unit enumeration of the capability store
// (capability-manager-ux design D2): the `/capabilities presets` verb and the
// preset name-conflict check need a listing of the preset records in the
// `global` namespace plus one workspace namespace. This is a pure scan — it
// opens no lock and writes nothing — and one bad unit never fails the whole
// listing: unreadable, corrupt, torn or unknown-schema records are skipped,
// tombstoned (`deleted: true`) presets are dropped, and only
// `<segment>.json` record files are considered (lock, recover, candidate and
// temp artifacts never match). An unsupported store root fails CLOSED with an
// explicit kind: callers must surface it, never degrade to an empty listing.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isSegment } from './paths.js'
import { decodeRecord } from './record.js'

/** Record files are `<unit name>.json`; every other artifact is ignored. */
const RECORD_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/

/** @param {unknown} error */
const codeOf = error => /** @type {{ code?: string }} */ (error)?.code ?? ''

/**
 * @typedef {{ scope: 'global'|'workspace', workspaceKey?: string, presetId: string, revision: number, document: unknown }} PresetUnit
 */

/**
 * Scan one namespace directory. A missing directory is an empty namespace;
 * any other readdir failure propagates (the caller fails closed).
 * @param {string} dir
 * @param {(presetId: string, revision: number, document: unknown) => void} collect
 */
async function scanNamespace(dir, collect) {
  /** @type {string[]} */
  let entries
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const match = RECORD_FILE.exec(entry)
    if (!match) continue
    let text
    try {
      text = await readFile(join(dir, entry), 'utf8')
    } catch {
      continue // an unreadable unit never fails the whole listing
    }
    const record = decodeRecord(text)
    if (record.kind !== 'ok') continue // corrupt / torn / unknown-schema: skip, tolerate
    const payload = record.payload
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      && /** @type {Record<string, unknown>} */ (payload).deleted === true) continue
    collect(match[1], record.revision, payload)
  }
}

/**
 * Enumerate the preset units of the `global` namespace and, when a workspace
 * key is given, of that workspace's namespace. Read-only: zero writes.
 * @param {{ support?: unknown }} store - an openCapabilityStore face; only its
 *   published support descriptor is read, the scan itself is plain fs.
 * @param {{ workspaceKey?: string }} [options]
 * @returns {Promise<{ kind: 'ok', presets: PresetUnit[] }
 *   | { kind: 'unsupported', reason: string }
 *   | { kind: 'error', reason: string }>}
 */
export async function enumeratePresetUnits(store, options = {}) {
  const support = /** @type {{ supported?: boolean, root?: string, reason?: string }} */ (store?.support ?? {})
  if (support.supported !== true || typeof support.root !== 'string' || support.root.length === 0) {
    return { kind: 'unsupported', reason: typeof support.reason === 'string' ? support.reason : 'store-root-unavailable' }
  }
  /** @type {PresetUnit[]} */
  const presets = []
  try {
    await scanNamespace(join(support.root, 'presets', 'global'), (presetId, revision, document) => {
      presets.push({ scope: 'global', presetId, revision, document })
    })
    const workspaceKey = options.workspaceKey
    if (isSegment(workspaceKey)) {
      await scanNamespace(join(support.root, 'presets', 'workspace', /** @type {string} */ (workspaceKey)), (presetId, revision, document) => {
        presets.push({ scope: 'workspace', workspaceKey: /** @type {string} */ (workspaceKey), presetId, revision, document })
      })
    }
  } catch (error) {
    return { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
  return { kind: 'ok', presets }
}
