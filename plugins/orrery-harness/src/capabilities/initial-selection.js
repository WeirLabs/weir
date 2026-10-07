// Task 6.5 of the session-capability-manager change: what a root Orrery
// session with NO accepted selection record gets — the initialization
// priority, resolved per session, never persisted by this path.
//
// 1. A saved workspace-default snapshot (unit { kind: 'defaults', workspaceKey })
//    wins — an EXPLICIT EMPTY default is a real choice, not a missing one.
//    Unresolved refs recorded with the default are reported, never resolved
//    by guessing. Name-string skill entries (the client draft's wire shape,
//    and records written by `default-save from:'draft'`) bind against the
//    live inventory by unique name; unbindable entries are reported as
//    missing, never guessed, never failing the whole default.
// 2. Otherwise the explicit builtin-Skills baseline plus the managed MCP
//    identities the composition already enables. A legacy Orrery session
//    without any policy lands here too: its configured MCP is kept (this
//    path never touches MCP) and its historical content grants NOTHING —
//    no inference from past calls or the global catalog.
// 3. The gate applies to the `orrery` preset only by composition: this
//    module is mounted by the preset's own selection row, so other presets
//    are untouched by construction.

import { createSkillIdentity } from './skill-identity.js'
/**
 * @param {{
 *   defaultsRecord: { kind: string, payload?: unknown },
 *   builtinIdentities?: unknown[],
 *   enabledMcpIdentities?: string[],
 * }} input
 * @returns {{ source: 'workspace-default' | 'builtin-baseline',
 *   selection: { skills: unknown[], mcpServers: string[] }, missing: unknown[] }}
 */
/**
 * Parsed inventory candidates admitted to the initial skill baseline: those
 * whose identity scope is listed in `scopes`. The default keeps the
 * historical builtin-only baseline; the `orrery-creative` preset row widens
 * it with 'custom' so its fused development skills are enabled from the
 * first session. Unparsed candidates never qualify.
 * @param {unknown[]} candidates @param {string[]} [scopes]
 */
export function baselineSkillIdentities(candidates, scopes = ['orrery-builtin']) {
  const admitted = new Set(scopes)
  return (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => candidate?.status === 'parsed' && admitted.has(/** @type {any} */ (candidate).identity?.scope))
    .map(candidate => /** @type {any} */ (candidate).identity)
}

/**
 * Bind the skill entries of a workspace-default snapshot against the live
 * inventory. An entry that already parses as a SkillIdentity is kept
 * verbatim (records saved `from:'applied'`); a plain name string (the client
 * draft's wire shape, records written by `default-save from:'draft'`) binds
 * to exactly ONE parsed candidate with that name — zero or multiple matches
 * are NOT authorized and degrade to a reported missing entry. Any other
 * garbage entry is missing too: fail closed PER ENTRY, never throwing,
 * never failing the whole default.
 * @param {unknown} entries @param {unknown} candidates
 * @returns {{ skills: unknown[],
 *   missing: Array<{ kind: 'skill', ref: unknown, reason: string }> }}
 */
export function bindDefaultSkillNames(entries, candidates) {
  const parsed = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => /** @type {any} */ (candidate)?.status === 'parsed'
      && /** @type {any} */ (candidate)?.identity
      && typeof /** @type {any} */ (candidate)?.name === 'string')
  const skills = []
  const missing = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      createSkillIdentity(/** @type {any} */ (entry))
      skills.push(entry)
      continue
    } catch { /* not an identity shape — try name binding below */ }
    if (typeof entry === 'string') {
      const matches = parsed.filter(candidate => /** @type {any} */ (candidate).name === entry)
      if (matches.length === 1) {
        skills.push(/** @type {any} */ (matches[0]).identity)
      } else {
        missing.push({ kind: 'skill', ref: entry, reason: matches.length === 0 ? 'no longer in the inventory' : 'ambiguous in the inventory' })
      }
      continue
    }
    missing.push({ kind: 'skill', ref: entry, reason: 'not a skill identity or name' })
  }
  return { skills, missing }
}

/**
 * Resolve the draft skill NAMES of a `default-save from:'draft'` spec into
 * exact SkillIdentity objects BEFORE persisting, so the workspace-default
 * record carries the resolved-sets contract instead of ambiguous name
 * strings (a name with two parsed candidates would otherwise be refused by
 * the read side's unique-name binding forever). An entry that ALREADY parses
 * as a SkillIdentity (an identity-shaped draft entry) passes through VERBATIM
 * — it is an already-resolved set member; an injected unresolvable identity
 * still fails closed later at session init. A name string with exactly ONE
 * parsed inventory candidate binds to that candidate's identity; a name
 * with MULTIPLE candidates binds only when the session's effective
 * (applied) selection contains exactly ONE identity of that name — the
 * applied selection is the authoritative disambiguation, never a guess.
 * Anything else (non-string non-identity garbage, unresolvable names) is
 * reported (missing/ambiguous) and the caller writes nothing. Pure: never
 * throws, never touches the store or the inventory.
 * @param {unknown} names draft skill entries (non-array treated as empty)
 * @param {unknown} candidates live inventory candidates
 * @param {unknown} appliedSkills the session's effective selection identities
 * @returns {{ identities: unknown[], missing: unknown[], ambiguous: string[] }}
 */
export function resolveSkillNamesForSave(names, candidates, appliedSkills) {
  const byName = new Map()
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (/** @type {any} */ (candidate)?.status !== 'parsed'
      || !/** @type {any} */ (candidate)?.identity
      || typeof /** @type {any} */ (candidate)?.name !== 'string') continue
    const name = /** @type {any} */ (candidate).name
    const list = byName.get(name) ?? []
    list.push(/** @type {any} */ (candidate).identity)
    byName.set(name, list)
  }
  const appliedByName = new Map()
  for (const entry of Array.isArray(appliedSkills) ? appliedSkills : []) {
    let identity
    try {
      identity = createSkillIdentity(/** @type {any} */ (entry))
    } catch { continue /* not an identity shape — not evidence */ }
    const list = appliedByName.get(identity.name) ?? []
    list.push(identity)
    appliedByName.set(identity.name, list)
  }
  const identities = []
  const missing = []
  const ambiguous = []
  for (const entry of Array.isArray(names) ? names : []) {
    try {
      createSkillIdentity(/** @type {any} */ (entry))
      identities.push(entry)
      continue
    } catch { /* not an identity shape — try name binding below */ }
    if (typeof entry !== 'string' || entry.length === 0) {
      missing.push(entry)
      continue
    }
    const matches = byName.get(entry) ?? []
    if (matches.length === 1) {
      identities.push(matches[0])
      continue
    }
    if (matches.length > 1) {
      const applied = appliedByName.get(entry) ?? []
      if (applied.length === 1) identities.push(applied[0])
      else ambiguous.push(entry)
      continue
    }
    missing.push(entry)
  }
  return { identities, missing, ambiguous }
}

export function resolveInitialSelection({ defaultsRecord, builtinIdentities = [], enabledMcpIdentities = [] }) {
  // A cleared marker is an explicit removal (9.4): it behaves as ABSENT —
  // clearing is never an explicit empty set, which stays a savable choice.
  const cleared = defaultsRecord && defaultsRecord.kind === 'ok'
    && /** @type {Record<string, unknown>} */ (defaultsRecord.payload ?? {}).cleared === true
  if (defaultsRecord && defaultsRecord.kind !== 'absent' && !cleared) {
    // A saved default that cannot be read fails closed exactly like a
    // selection record — it is never silently treated as missing.
    if (defaultsRecord.kind !== 'ok') throw new Error(`Workspace default selection is ${defaultsRecord.kind}`)
    const payload = /** @type {Record<string, unknown>} */ (defaultsRecord.payload ?? {})
    return {
      source: 'workspace-default',
      selection: {
        skills: Array.isArray(payload.skills) ? structuredClone(payload.skills) : [],
        mcpServers: Array.isArray(payload.mcpServers) ? /** @type {string[]} */ (payload.mcpServers).slice() : [],
      },
      missing: Array.isArray(payload.unresolvedRefs) ? payload.unresolvedRefs.slice() : [],
    }
  }
  return {
    source: 'builtin-baseline',
    selection: { skills: builtinIdentities.slice(), mcpServers: enabledMcpIdentities.slice() },
    missing: [],
  }
}
