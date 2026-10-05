// capability-manager-ux task 6.1 (design D6): the version-2 preset package —
// pack (origin-split export) and validate (atomic import gate).
//
// D6 origin split at pack time:
// - remote-sourced (scope user/custom with portable:true provenance) travels
//   as a portable ref only ({kind, repository, ref, name, subpath?/commit?/
//   digest?, targetScope}); its content NEVER travels.
// - workspace-installed (scope project) travels as a bundled UTF-8 file set
//   with targetScope 'project'.
// - local user (scope user/custom with portable:false) travels bundled with
//   targetScope 'user'.
// - orrery-builtin travels as a name reference (builtin:[name]) — present on
//   any machine with the bundle; a name missing from the local inventory is
//   recorded in warnings.
// - managed MCP servers travel as {identity, label} (label from the managed
//   registry where available); import binds only locally configured
//   identities, the rest stay unresolved (v1-isomorphic semantics).
//
// Bounds (D6): package ≤ 8 MiB serialized, per file ≤ 512 KiB, ≤ 256 files
// per bundled skill; entry paths are relative, segment-only and free of
// `..`, absolute roots and drive letters; unknown fields and unknown
// versions are rejected atomically with the reason named.
//
// This module performs ZERO writes and ZERO network access: pack only READS
// skill content through the injected fs seam, and the install discipline
// (temp-name → rename, rollback, collision policy) lives in
// preset-package-install.js. Version-1 documents are portable-refs.js'
// concern, never this module's.
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createSkillIdentity, skillIdentityKey } from './skill-identity.js'
import { validateMcpRef, validateSkillRef } from './portable-refs.js'

export const PACKAGE_VERSION = 2
export const PACKAGE_LIMITS = Object.freeze({ documentBytes: 8 * 1024 * 1024, fileBytes: 512 * 1024, filesPerSkill: 256 })

/** The D6 origin classes of a selected Skill. */
export const SKILL_ORIGINS = Object.freeze({ remote: 'remote', workspace: 'workspace', localUser: 'local-user', builtin: 'builtin' })

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// Portable entry-path segments follow the capability store's FILE_SEGMENT
// house style (store/paths.js): ASCII, no leading dots, never containing
// `..`. Names outside this set cannot travel in a package.
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SKILL_SOURCE_KINDS = new Set(['git', 'registry', 'path'])

const DOCUMENT_FIELDS = new Set(['version', 'name', 'selection', 'builtin', 'bundled', 'warnings'])
const SELECTION_FIELDS = new Set(['skills', 'mcpServers', 'unresolvedRefs'])
const UNRESOLVED_FIELDS = new Set(['kind', 'ref', 'reason'])
const BUNDLED_FIELDS = new Set(['targetScope', 'name', 'description', 'files'])
const FILE_FIELDS = new Set(['path', 'content'])

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = value => typeof value === 'string' && value.length > 0
const message = error => (error instanceof Error ? error.message : String(error))

/**
 * A package entry path is relative and segment-only: '/'-separated portable
 * segments, never absolute, never climbing out (`..`/`.`), never a drive
 * letter, backslash or NUL.
 * @param {unknown} path
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateEntryPath(path) {
  if (!isNonEmptyString(path)) return { ok: false, reason: 'not-a-string' }
  if (path.startsWith('/')) return { ok: false, reason: 'absolute-path' }
  if (path.includes('\\') || path.includes(':') || path.includes('\0')) return { ok: false, reason: 'forbidden-character' }
  for (const segment of path.split('/')) {
    if (segment === '..' || segment === '.') return { ok: false, reason: 'climbing-segment' }
    if (!PATH_SEGMENT.test(segment) || segment.includes('..')) return { ok: false, reason: 'invalid-segment' }
  }
  return { ok: true }
}

/**
 * The D6 origin class of one selected Skill identity: 'remote' (portable
 * provenance — travels as a ref, content never travels), 'workspace'
 * (project scope — bundled, installs into the current workspace's project
 * root), 'local-user' (user/custom without provenance — bundled, installs
 * into the user root), 'builtin' (name reference).
 * @param {unknown} identity - SkillIdentity-shaped
 */
export function classifySkillOrigin(identity) {
  const value = createSkillIdentity(identity)
  if (value.scope === 'orrery-builtin') return SKILL_ORIGINS.builtin
  if (value.scope === 'project') return SKILL_ORIGINS.workspace
  if (value.portable === true) return SKILL_ORIGINS.remote
  return SKILL_ORIGINS.localUser
}

/**
 * Build the D6 portable ref for a remote-sourced identity from its trusted
 * provenance. Only credential-free whitelisted fields travel; a provenance
 * without repository/ref cannot form a compliant ref and is reported.
 * @param {unknown} identity
 * @returns {{ ok: true, ref: Record<string, string> } | { ok: false, reason: string }}
 */
export function portableRefForIdentity(identity) {
  const value = createSkillIdentity(identity)
  const provenance = value.provenance
  if (value.portable !== true || provenance === null) {
    return { ok: false, reason: `skill "${value.name}": not a remote-sourced (portable) identity` }
  }
  if (!isNonEmptyString(provenance.repository) || !isNonEmptyString(provenance.ref)) {
    return { ok: false, reason: `skill "${value.name}": provenance lacks repository/ref — no compliant portable ref is possible` }
  }
  /** @type {Record<string, string>} */
  const ref = {
    kind: SKILL_SOURCE_KINDS.has(provenance.kind) ? provenance.kind : 'git',
    repository: provenance.repository,
    ref: provenance.ref,
    name: value.name,
  }
  if (isNonEmptyString(provenance.subpath)) ref.subpath = provenance.subpath
  if (isNonEmptyString(provenance.commit)) ref.commit = provenance.commit
  if (isNonEmptyString(provenance.digest)) ref.digest = provenance.digest
  ref.targetScope = value.scope === 'project' ? 'project' : 'user'
  return { ok: true, ref }
}

/**
 * Validate a version-2 package document atomically: version, field
 * whitelists, per-entry shapes and the D6 bounds. Every rejection names the
 * reason; nothing here reads, writes, resolves or fetches anything.
 * @param {unknown} document - the parsed JSON value
 * @param {{ byteLength?: (document: unknown) => number }} [deps]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validatePresetPackage(document, deps = {}) {
  const byteLength = deps.byteLength ?? (value => Buffer.byteLength(JSON.stringify(value)))
  if (byteLength(document) > PACKAGE_LIMITS.documentBytes) return { ok: false, reason: 'document-too-large' }
  if (!isPlainObject(document)) return { ok: false, reason: 'document:not-object' }
  for (const key of Object.keys(document)) {
    if (!DOCUMENT_FIELDS.has(key)) return { ok: false, reason: `document:unknown-field:${key}` }
  }
  if (document.version !== PACKAGE_VERSION) return { ok: false, reason: 'document:unknown-version' }
  if (!isNonEmptyString(document.name)) return { ok: false, reason: 'document:invalid-name' }

  const selection = document.selection
  if (!isPlainObject(selection)) return { ok: false, reason: 'document:invalid-selection' }
  for (const key of Object.keys(selection)) {
    if (!SELECTION_FIELDS.has(key)) return { ok: false, reason: `selection:unknown-field:${key}` }
  }
  const skills = selection.skills ?? []
  const mcpServers = selection.mcpServers ?? []
  const unresolvedRefs = selection.unresolvedRefs ?? []
  if (!Array.isArray(skills) || !Array.isArray(mcpServers) || !Array.isArray(unresolvedRefs)) {
    return { ok: false, reason: 'document:invalid-selection-arrays' }
  }
  for (const [index, ref] of skills.entries()) {
    const verdict = validateSkillRef(ref)
    if (!verdict.ok) return { ok: false, reason: `skills[${index}]:${verdict.reason}` }
  }
  for (const [index, ref] of mcpServers.entries()) {
    const verdict = validateMcpRef(ref)
    if (!verdict.ok) return { ok: false, reason: `mcpServers[${index}]:${verdict.reason}` }
  }
  for (const [index, entry] of unresolvedRefs.entries()) {
    if (!isPlainObject(entry)) return { ok: false, reason: `unresolvedRefs[${index}]:not-object` }
    for (const key of Object.keys(entry)) {
      if (!UNRESOLVED_FIELDS.has(key)) return { ok: false, reason: `unresolvedRefs[${index}]:unknown-field:${key}` }
    }
    if (entry.kind !== 'skill' && entry.kind !== 'mcp') return { ok: false, reason: `unresolvedRefs[${index}]:unknown-kind` }
    if (typeof entry.ref !== 'string' && !isPlainObject(entry.ref)) return { ok: false, reason: `unresolvedRefs[${index}]:invalid-ref` }
    if (entry.reason !== undefined && typeof entry.reason !== 'string') return { ok: false, reason: `unresolvedRefs[${index}]:invalid-reason` }
  }

  const builtin = document.builtin ?? []
  if (!Array.isArray(builtin)) return { ok: false, reason: 'document:invalid-builtin' }
  for (const [index, name] of builtin.entries()) {
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) return { ok: false, reason: `builtin[${index}]:invalid-name` }
  }

  const bundled = document.bundled ?? []
  if (!Array.isArray(bundled)) return { ok: false, reason: 'document:invalid-bundled' }
  const seenSkills = new Set()
  for (const [index, entry] of bundled.entries()) {
    if (!isPlainObject(entry)) return { ok: false, reason: `bundled[${index}]:not-object` }
    for (const key of Object.keys(entry)) {
      if (!BUNDLED_FIELDS.has(key)) return { ok: false, reason: `bundled[${index}]:unknown-field:${key}` }
    }
    if (entry.targetScope !== 'project' && entry.targetScope !== 'user') return { ok: false, reason: `bundled[${index}]:invalid-targetScope` }
    if (typeof entry.name !== 'string' || !SKILL_NAME.test(entry.name)) return { ok: false, reason: `bundled[${index}]:invalid-name` }
    if (entry.description !== undefined && typeof entry.description !== 'string') return { ok: false, reason: `bundled[${index}]:invalid-description` }
    const skillKey = `${entry.targetScope}/${entry.name}`
    if (seenSkills.has(skillKey)) return { ok: false, reason: `bundled[${index}]:duplicate:${skillKey}` }
    seenSkills.add(skillKey)
    if (!Array.isArray(entry.files) || entry.files.length === 0) return { ok: false, reason: `bundled[${index}]:no-files` }
    if (entry.files.length > PACKAGE_LIMITS.filesPerSkill) return { ok: false, reason: `bundled[${index}]:too-many-files` }
    const seenPaths = new Set()
    for (const [fileIndex, file] of entry.files.entries()) {
      if (!isPlainObject(file)) return { ok: false, reason: `bundled[${index}].files[${fileIndex}]:not-object` }
      for (const key of Object.keys(file)) {
        if (!FILE_FIELDS.has(key)) return { ok: false, reason: `bundled[${index}].files[${fileIndex}]:unknown-field:${key}` }
      }
      const path = validateEntryPath(file.path)
      if (!path.ok) return { ok: false, reason: `bundled[${index}].files[${fileIndex}]:invalid-path:${path.reason}` }
      if (seenPaths.has(file.path)) return { ok: false, reason: `bundled[${index}]:duplicate-path:${file.path}` }
      seenPaths.add(file.path)
      if (typeof file.content !== 'string') return { ok: false, reason: `bundled[${index}].files[${fileIndex}]:content-not-string` }
      if (Buffer.byteLength(file.content) > PACKAGE_LIMITS.fileBytes) {
        return { ok: false, reason: `bundled[${index}].files[${fileIndex}]:file-too-large` }
      }
    }
  }

  const warnings = document.warnings ?? []
  if (!Array.isArray(warnings) || warnings.some(entry => typeof entry !== 'string')) return { ok: false, reason: 'document:invalid-warnings' }
  return { ok: true }
}

/**
 * Import binding for a version-2 package (D6, v1-isomorphic): the package's
 * carried unresolvedRefs travel through, remote-sourced Skill refs stay
 * unresolved (installing them is a separate distribution action), and
 * managed MCP refs bind ONLY to identities already configured locally.
 * Bundled and builtin outcomes are the caller's composition (they depend on
 * the confirmed install).
 * @param {{ selection?: { skills?: unknown[], mcpServers?: unknown[], unresolvedRefs?: unknown[] } }} pkg
 * @param {{ localMcpIdentities: string[] }} local
 * @returns {{ mcpServers: string[], unresolvedRefs: unknown[] }}
 */
export function bindPackageSelection(pkg, { localMcpIdentities }) {
  const selection = isPlainObject(pkg?.selection) ? pkg.selection : {}
  const unresolvedRefs = Array.isArray(selection.unresolvedRefs) ? [...selection.unresolvedRefs] : []
  /** @type {string[]} */
  const boundMcp = []
  for (const ref of Array.isArray(selection.skills) ? selection.skills : []) {
    unresolvedRefs.push({ kind: 'skill', ref })
  }
  for (const ref of Array.isArray(selection.mcpServers) ? selection.mcpServers : []) {
    const identity = isPlainObject(ref) ? ref.identity : undefined
    if (typeof identity === 'string' && localMcpIdentities.includes(identity)) boundMcp.push(identity)
    else unresolvedRefs.push({ kind: 'mcp', ref })
  }
  return { mcpServers: boundMcp, unresolvedRefs }
}

/**
 * The dry-run install plan (D6 two-phase import, phase one): every bundled
 * Skill's target scope, resolved target root, file count and name-collision
 * flag. Read-only — a collision probe never writes.
 * @param {{ bundled?: unknown }} pkg - an ALREADY validated package
 * @param {{ roots: { project?: string | null, user?: string | null },
 *   exists?: (path: string) => Promise<boolean> }} deps
 * @returns {Promise<{ install: Array<{ targetScope: string, name: string, fileCount: number, targetRoot: string | null, collision?: true }>,
 *   collisions: Array<{ targetScope: string, name: string }> }>}
 */
export async function planPackageInstall(pkg, deps) {
  const exists = deps.exists ?? (async path => { try { await stat(path); return true } catch { return false } })
  const roots = deps.roots ?? {}
  /** @type {Array<{ targetScope: string, name: string, fileCount: number, targetRoot: string | null, collision?: true }>} */
  const install = []
  /** @type {Array<{ targetScope: string, name: string }>} */
  const collisions = []
  for (const raw of Array.isArray(pkg?.bundled) ? pkg.bundled : []) {
    const entry = /** @type {{ targetScope: 'project'|'user', name: string, files: unknown[] }} */ (raw)
    const root = roots[entry.targetScope] ?? null
    const collision = root !== null && (await exists(join(root, entry.name)) || await exists(join(root, `${entry.name}.md`)))
    install.push({
      targetScope: entry.targetScope,
      name: entry.name,
      fileCount: entry.files.length,
      targetRoot: root,
      ...(collision ? { collision: true } : {}),
    })
    if (collision) collisions.push({ targetScope: entry.targetScope, name: entry.name })
  }
  return { install, collisions }
}

/** A pack refusal that names its reason (bound violations, unreadable content). */
class PackRefusal extends Error {}

/**
 * Read one Skill's content for bundling: the skill root directory
 * recursively, UTF-8 text only, within the D6 bounds. `.git` is VCS
 * metadata and never content; binary files, symbolic links, non-regular
 * entries and names outside the portable segment set are skipped with a
 * warning; an oversized TEXT file or too many files refuses the pack (the
 * package could never validate, and silently dropping core content would
 * ship a broken Skill). Flat single-file skills travel in the canonical
 * directory form (their one file becomes `SKILL.md`) so a confirmed import
 * always installs a directory.
 * @param {ReturnType<typeof createSkillIdentity>} identity
 * @param {Record<string, any>} candidate - the matched inventory candidate (locator-bearing)
 * @param {{ readFile: Function, readdir: Function, realpath: Function }} fs
 * @param {string[]} warnings
 * @returns {Promise<{ ok: true, files: Array<{ path: string, content: string }> } | { ok: false, reason: string }>}
 */
async function collectSkillFiles(identity, candidate, fs, warnings) {
  const skillName = identity.name
  const locator = candidate.locator
  if (!isPlainObject(locator) || typeof locator.path !== 'string' || typeof locator.directory !== 'string') {
    return { ok: false, reason: `skill "${skillName}": no readable inventory locator` }
  }
  const asText = async path => {
    const raw = await fs.readFile(path)
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    if (buffer.includes(0)) return null
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return null
    }
  }
  try {
    // Flat form ⇔ the main file sits directly in the scope root (the
    // canonicalized parent of the locator path IS the identity root).
    const parentOfMain = await fs.realpath(dirname(locator.path)).catch(() => resolve(dirname(locator.path)))
    const scopeRoot = await fs.realpath(identity.root).catch(() => resolve(identity.root))
    if (parentOfMain === scopeRoot) {
      const content = await asText(locator.path)
      if (content === null) return { ok: false, reason: `skill "${skillName}": the skill file is not UTF-8 text` }
      return { ok: true, files: [{ path: 'SKILL.md', content }] }
    }
    /** @type {Array<{ path: string, content: string }>} */
    const files = []
    const walk = async (dir, base) => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const sorted = [...entries].sort((a, b) => String(a.name).localeCompare(String(b.name)))
      for (const entry of sorted) {
        const entryName = String(entry.name)
        if (entryName === '.git') continue // VCS metadata is never Skill content
        const rel = base === '' ? entryName : `${base}/${entryName}`
        if (entry.isSymbolicLink()) { warnings.push(`skill "${skillName}": skipped symbolic link "${rel}"`); continue }
        if (entry.isDirectory()) { await walk(join(dir, entryName), rel); continue }
        if (!entry.isFile()) { warnings.push(`skill "${skillName}": skipped non-regular entry "${rel}"`); continue }
        const valid = validateEntryPath(rel)
        if (!valid.ok) { warnings.push(`skill "${skillName}": skipped file "${rel}" (${valid.reason})`); continue }
        const content = await asText(join(dir, entryName))
        if (content === null) { warnings.push(`skill "${skillName}": skipped binary file "${rel}"`); continue }
        if (Buffer.byteLength(content) > PACKAGE_LIMITS.fileBytes) {
          throw new PackRefusal(`skill "${skillName}": file "${rel}" exceeds the 512 KiB per-file package limit`)
        }
        files.push({ path: rel, content })
        if (files.length > PACKAGE_LIMITS.filesPerSkill) {
          throw new PackRefusal(`skill "${skillName}": more than ${PACKAGE_LIMITS.filesPerSkill} files — the per-skill package limit`)
        }
      }
    }
    await walk(locator.directory, '')
    if (files.length === 0) return { ok: false, reason: `skill "${skillName}": no portable UTF-8 files to bundle` }
    return { ok: true, files }
  } catch (cause) {
    if (cause instanceof PackRefusal) return { ok: false, reason: cause.message }
    return { ok: false, reason: `skill "${skillName}": content unreadable: ${message(cause)}` }
  }
}

/**
 * Pack a preset document's selection into a version-2 package (D6 origin
 * split). The selection's skills are SkillIdentity-shaped; a bare name
 * string resolves through the live inventory candidates (a name that matches
 * nothing, or matches ambiguously, is reported in warnings and omitted).
 * The assembled package is self-validated before it returns, so a packed
 * result is always a compliant document; a bound violation fails the pack
 * with the reason named.
 * @param {{ name?: unknown, selection?: unknown }} input - preset document name + selection
 * @param {{ candidates?: Array<Record<string, any>>,
 *   mcpLabels?: (identity: string) => string | undefined,
 *   fs?: { readFile?: Function, readdir?: Function, realpath?: Function } }} [deps]
 * @returns {Promise<{ ok: true, package: Record<string, unknown> } | { ok: false, reason: string }>}
 */
export async function packPresetPackage(input, deps = {}) {
  const fs = { readFile, readdir, realpath, ...(deps.fs ?? {}) }
  const candidates = Array.isArray(deps.candidates) ? deps.candidates : []
  const mcpLabels = typeof deps.mcpLabels === 'function' ? deps.mcpLabels : () => undefined
  /** @type {string[]} */
  const warnings = []

  if (!isNonEmptyString(input?.name)) return { ok: false, reason: 'preset document needs a non-empty display name' }
  const selection = isPlainObject(input?.selection) ? input.selection : {}
  const rawSkills = Array.isArray(selection.skills) ? selection.skills : []
  const rawMcp = Array.isArray(selection.mcpServers) ? selection.mcpServers : []
  const rawUnresolved = Array.isArray(selection.unresolvedRefs) ? selection.unresolvedRefs : []

  /** Identity-keyed lookup of parsed candidates. */
  const byIdentityKey = new Map()
  for (const candidate of candidates) {
    if (!isPlainObject(candidate?.identity)) continue
    try { byIdentityKey.set(skillIdentityKey(candidate.identity), candidate) } catch { /* an unstamped shape carries no key */ }
  }

  /** Resolve one selection entry (identity object or bare name) to a SkillIdentity. */
  const identityFor = entry => {
    if (typeof entry === 'string') {
      const matches = candidates.filter(candidate =>
        candidate?.status === 'parsed' && isPlainObject(candidate.identity) && candidate.identity.name === entry)
      if (matches.length === 1) return { identity: matches[0].identity }
      return {
        warning: matches.length === 0
          ? `skill "${entry}" is not present in the local inventory — omitted from the package`
          : `skill name "${entry}" is ambiguous in the local inventory — omitted from the package`,
      }
    }
    try {
      return { identity: createSkillIdentity(entry) }
    } catch (cause) {
      return { error: `selection skill entry is not a valid SkillIdentity: ${message(cause)}` }
    }
  }

  /** @type {Array<Record<string, string>>} */
  const refs = []
  /** @type {string[]} */
  const builtin = []
  /** @type {Array<Record<string, unknown>>} */
  const bundled = []
  const bundledKeys = new Set()
  const builtinSeen = new Set()

  for (const entry of rawSkills) {
    const resolved = identityFor(entry)
    if (resolved.error) return { ok: false, reason: resolved.error }
    if (resolved.warning) { warnings.push(resolved.warning); continue }
    const identity = /** @type {ReturnType<typeof createSkillIdentity>} */ (resolved.identity)
    const origin = classifySkillOrigin(identity)
    if (origin === SKILL_ORIGINS.builtin) {
      if (builtinSeen.has(identity.name)) continue
      builtinSeen.add(identity.name)
      builtin.push(identity.name)
      let key = null
      try { key = skillIdentityKey(identity) } catch { key = null }
      if (key === null || !byIdentityKey.has(key)) {
        warnings.push(`builtin skill "${identity.name}" is not present in the local inventory — the package references it by name only`)
      }
      continue
    }
    if (origin === SKILL_ORIGINS.remote) {
      const built = portableRefForIdentity(identity)
      if (!built.ok) { warnings.push(built.reason); continue }
      refs.push(built.ref)
      continue
    }
    // workspace | local-user → bundle the content.
    const targetScope = origin === SKILL_ORIGINS.workspace ? 'project' : 'user'
    const bundleKey = `${targetScope}/${identity.name}`
    if (bundledKeys.has(bundleKey)) {
      warnings.push(`skill "${identity.name}" (${targetScope}) is selected more than once — bundled once`)
      continue
    }
    let key = null
    try { key = skillIdentityKey(identity) } catch { key = null }
    const candidate = key === null ? undefined : byIdentityKey.get(key)
    if (candidate === undefined) {
      warnings.push(`skill "${identity.name}" (${targetScope}) is not present in the local inventory — its content could not be bundled`)
      continue
    }
    const collected = await collectSkillFiles(identity, candidate, fs, warnings)
    if (!collected.ok) return { ok: false, reason: collected.reason }
    bundledKeys.add(bundleKey)
    const description = candidate.description
    bundled.push({
      targetScope,
      name: identity.name,
      ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
      files: collected.files,
    })
  }

  /** @type {Array<{ identity: string, label: string }>} */
  const mcpServers = []
  for (const entry of rawMcp) {
    if (!isNonEmptyString(entry)) return { ok: false, reason: 'selection.mcpServers entries must be managed identity strings' }
    mcpServers.push({ identity: entry, label: mcpLabels(entry) ?? entry })
  }

  const pkg = {
    version: PACKAGE_VERSION,
    name: input.name,
    selection: {
      skills: refs,
      mcpServers,
      unresolvedRefs: rawUnresolved.map(entry => structuredClone(entry)),
    },
    builtin,
    bundled,
    warnings,
  }
  // Self-validation is part of the pack contract: the D6 bounds (8 MiB
  // package, 512 KiB file, 256 files) are enforced here, and a pack never
  // emits a document the import gate would reject.
  const verdict = validatePresetPackage(pkg)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  return { ok: true, package: pkg }
}
