// Task 9.2 of the session-capability-manager change: portable ref field
// whitelists and import validation. A portable preset document travels
// between machines, so its references are whitelisted to credential-free
// shapes:
// - Skill ref: source kind + canonical repository (no credentials) +
//   requested ref + subpath + logical name/target scope + optional resolved
//   commit/digest.
// - MCP ref: an Orrery-managed logical binding identity + display label —
//   never a URL, credential, command, args, headers or environment value.
// Import only BINDS identities the local Orrery already configured; it never
// creates, starts or accepts connection content. Validation is an
// object-rooted schema with hard bounds (document ≤ 1 MiB, ≤ 1000 entries,
// ≤ 4 KiB per field); unknown fields and unknown versions reject atomically.

export const PORTABLE_VERSION = 1
export const IMPORT_LIMITS = Object.freeze({ documentBytes: 1_048_576, maxEntries: 1000, fieldBytes: 4096 })

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = value => typeof value === 'string' && value.length > 0
const fieldFits = value => typeof value !== 'string' || Buffer.byteLength(value) <= IMPORT_LIMITS.fieldBytes

const SKILL_REF_FIELDS = new Set(['kind', 'repository', 'ref', 'subpath', 'name', 'targetScope', 'commit', 'digest'])
const MCP_REF_FIELDS = new Set(['identity', 'label'])
const DOCUMENT_FIELDS = new Set(['version', 'scope', 'presetId', 'name', 'selection'])

const SKILL_SOURCE_KINDS = new Set(['git', 'registry', 'path'])

/**
 * @param {unknown} value
 * @returns {{ ok: true, ref: unknown } | { ok: false, reason: string }}
 */
export function validateSkillRef(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'skill-ref:not-object' }
  for (const key of Object.keys(value)) {
    if (!SKILL_REF_FIELDS.has(key)) return { ok: false, reason: `skill-ref:unknown-field:${key}` }
  }
  if (!SKILL_SOURCE_KINDS.has(value.kind)) return { ok: false, reason: 'skill-ref:unknown-kind' }
  for (const key of ['repository', 'ref', 'name']) {
    if (!isNonEmptyString(value[key])) return { ok: false, reason: `skill-ref:missing:${key}` }
    if (!fieldFits(value[key])) return { ok: false, reason: `skill-ref:field-too-large:${key}` }
  }
  for (const key of ['subpath', 'targetScope', 'commit', 'digest']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !fieldFits(value[key]))) return { ok: false, reason: `skill-ref:invalid:${key}` }
  }
  return { ok: true, ref: value }
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, ref: unknown } | { ok: false, reason: string }}
 */
export function validateMcpRef(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'mcp-ref:not-object' }
  for (const key of Object.keys(value)) {
    if (!MCP_REF_FIELDS.has(key)) return { ok: false, reason: `mcp-ref:unknown-field:${key}` }
  }
  for (const key of ['identity', 'label']) {
    if (!isNonEmptyString(value[key])) return { ok: false, reason: `mcp-ref:missing:${key}` }
    if (!fieldFits(value[key])) return { ok: false, reason: `mcp-ref:field-too-large:${key}` }
  }
  return { ok: true, ref: value }
}

/**
 * Validate a portable preset document atomically: version, shape, bounds and
 * every entry. Nothing here resolves, fetches or starts anything.
 * @param {unknown} document - the parsed JSON value
 * @param {{ byteLength?: (document: unknown) => number }} [deps]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validatePortableDocument(document, deps = {}) {
  const byteLength = deps.byteLength ?? (value => Buffer.byteLength(JSON.stringify(value))
  )
  if (byteLength(document) > IMPORT_LIMITS.documentBytes) return { ok: false, reason: 'document-too-large' }
  if (!isPlainObject(document)) return { ok: false, reason: 'document:not-object' }
  for (const key of Object.keys(document)) {
    if (!DOCUMENT_FIELDS.has(key)) return { ok: false, reason: `document:unknown-field:${key}` }
  }
  if (document.version !== PORTABLE_VERSION) return { ok: false, reason: 'document:unknown-version' }
  if (document.scope !== 'global' && document.scope !== 'workspace') return { ok: false, reason: 'document:invalid-scope' }
  if (typeof document.name !== 'string' || document.name.length === 0 || !fieldFits(document.name)) return { ok: false, reason: 'document:invalid-name' }
  const selection = document.selection
  if (!isPlainObject(selection)) return { ok: false, reason: 'document:invalid-selection' }
  const skills = selection.skills ?? []
  const mcpServers = selection.mcpServers ?? []
  const unresolvedRefs = selection.unresolvedRefs ?? []
  if (!Array.isArray(skills) || !Array.isArray(mcpServers) || !Array.isArray(unresolvedRefs)) return { ok: false, reason: 'document:invalid-selection-arrays' }
  if (skills.length + mcpServers.length + unresolvedRefs.length > IMPORT_LIMITS.maxEntries) return { ok: false, reason: 'document:too-many-entries' }
  for (const [index, ref] of skills.entries()) {
    const verdict = validateSkillRef(ref)
    if (!verdict.ok) return { ok: false, reason: `skills[${index}]:${verdict.reason}` }
  }
  for (const [index, ref] of mcpServers.entries()) {
    const verdict = validateMcpRef(ref)
    if (!verdict.ok) return { ok: false, reason: `mcpServers[${index}]:${verdict.reason}` }
  }
  return { ok: true }
}

/**
 * Import binding (9.2/9.3): an imported selection only ever binds identities
 * that already exist locally. Imported skills become unresolved refs
 * (metadata, never enabled entries); imported MCP refs bind ONLY when the
 * identity is already configured in the local registry — anything else
 * stays unresolved. Nothing is created, started or connected here.
 * @param {{ skills?: unknown[], mcpServers?: unknown[] }} selection
 * @param {{ localMcpIdentities: string[] }} local
 */
export function bindImportedSelection(selection, { localMcpIdentities }) {
  const boundMcp = []
  const unresolvedRefs = []
  for (const ref of selection?.skills ?? []) {
    unresolvedRefs.push({ kind: 'skill', ref })
  }
  for (const ref of selection?.mcpServers ?? []) {
    if (localMcpIdentities.includes(ref.identity)) boundMcp.push(ref.identity)
    else unresolvedRefs.push({ kind: 'mcp', ref })
  }
  return { mcpServers: boundMcp, unresolvedRefs }
}
