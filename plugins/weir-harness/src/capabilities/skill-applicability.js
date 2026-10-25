// Cross-workspace preset applicability (fix-capability-fork-and-preset-workspaces
// D4): the server-side partition of Skill entries an Apply draft names but the
// CURRENT inventory did not resolve exactly.
//
// A project-scoped Skill identity is machine-local: its canonical root names
// the workspace it was discovered in. A global preset carrying such an identity
// therefore names an entry that does not exist in another workspace at all —
// the preset contract is "skip it, warn, keep the rest", never an unactionable
// same-name conflict with a local Skill that happens to share the invocation
// name, and never a silent substitution.
//
// Evidence discipline (the whole point of this module): ABSENCE IS NEVER PROOF.
// The current workspace's project Skill roots are derived from the inventory's
// own root observations (canonical `projectRoot` + the two project Skill root
// suffixes, plus each observed project root path). A skip is authorized only
// when the inventory is COMPLETE (`inventoryResult.complete === true`) and at
// least one current project root resolved. An incomplete inventory, a root set
// that cannot be resolved, and a legacy name string with no identity all keep
// the pre-existing behavior: profile-supplemental knowledge may still skip with
// its own reason, everything else stays a hard failure with the draft kept.
//
// Path comparison is by canonical exact key — never a string prefix — so a
// lexical alias of this very workspace (`/var` vs `/private/var`, a symlinked
// checkout, win32 case folding) is NOT misread as another workspace. A local
// identity whose root IS one of this workspace's project roots but which the
// inventory did not resolve stays a hard failure: it is missing, not external.
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

/** Reason reported for a project identity proven to belong to another workspace. */
export const NOT_APPLICABLE_IN_WORKSPACE = 'not applicable in this workspace'
/** Reason reported for a name known only to a profile-supplemental preset root. */
export const NOT_APPLICABLE_IN_PRESET = 'not applicable in this agent preset'

/** The two project Skill discovery roots of one workspace, relative to its project root. */
const PROJECT_SKILL_SUFFIXES = Object.freeze(['.dsh/skills', '.agents/skills'])

/**
 * Comparable form of a path: realpath when it exists, '/'-separated, and
 * case-folded on win32. A path that does not exist yet keeps its lexical form
 * with the deepest EXISTING ancestor canonicalized, so the macOS `/var` →
 * `/private/var` alias is resolved for `<root>/.dsh/skills` even before that
 * directory is created.
 * (Same contract as the worktree lane's `pathKey`; kept local so the capability
 * modules never depend on the worktree feature's internals.)
 * @param {unknown} path
 * @param {string} [platform]
 * @returns {string}
 */
export function canonicalPathKey(path, platform = process.platform) {
  const lexical = String(path)
  let real = lexical
  try {
    real = realpathSync.native(lexical)
  } catch {
    let parent = dirname(lexical)
    const tail = [basename(lexical)]
    while (parent !== dirname(parent)) {
      try {
        real = join(realpathSync.native(parent), ...tail.reverse())
        break
      } catch {
        tail.push(basename(parent))
        parent = dirname(parent)
      }
    }
  }
  const slashed = real.split(sep).join('/').replace(/\/+$/, '')
  return platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * The canonical project Skill roots of the workspace the inventory observed.
 * Empty means "this inventory proves nothing about the current workspace";
 * callers must treat that as NO skip authorization, never as a foreign verdict.
 * @param {unknown} roots inventory root observations (`inventoryResult.roots`)
 * @param {{ platform?: string }} [options]
 * @returns {Set<string>}
 */
export function workspaceProjectSkillRoots(roots, options = {}) {
  const platform = options.platform ?? process.platform
  const keys = new Set()
  for (const observation of Array.isArray(roots) ? roots : []) {
    const root = /** @type {Record<string, unknown> | undefined} */ (
      observation && typeof observation === 'object' ? (/** @type {any} */ (observation).root ?? observation) : undefined)
    if (!root || root.scope !== 'project') continue
    if (typeof root.projectRoot === 'string' && root.projectRoot.length > 0) {
      const projectRoot = canonicalPathKey(root.projectRoot, platform)
      for (const suffix of PROJECT_SKILL_SUFFIXES) keys.add(canonicalPathKey(join(projectRoot, suffix), platform))
    }
    // The observed root itself is canonicalized by discovery (a symlinked
    // project Skill root keeps ITS OWN identity), so it names this workspace
    // too: a broken local Skill must fail as missing, never read as external.
    if (typeof root.path === 'string' && root.path.length > 0) keys.add(canonicalPathKey(root.path, platform))
  }
  return keys
}

/**
 * Is this identity a project identity rooted OUTSIDE every current project root?
 * The caller must have authorized the classification (complete inventory and a
 * non-empty project root set) — this predicate only answers the path question.
 * @param {unknown} identity
 * @param {Set<string>} projectRoots
 * @param {{ platform?: string }} [options]
 * @returns {boolean}
 */
export function isForeignProjectIdentity(identity, projectRoots, options = {}) {
  const value = /** @type {Record<string, unknown> | null} */ (
    identity && typeof identity === 'object' ? identity : null)
  if (!value || value.scope !== 'project') return false
  if (typeof value.root !== 'string' || value.root.length === 0 || !isAbsolute(value.root)) return false
  return !projectRoots.has(canonicalPathKey(value.root, options.platform ?? process.platform))
}

/**
 * Partition the draft Skill entries the CURRENT inventory did not resolve
 * exactly. Order follows the draft; duplicates are preserved (the request is
 * reported as received, never silently deduplicated).
 *
 * - an identity proven to be a project identity of another workspace →
 *   `skipped` with `not applicable in this workspace`
 * - a legacy name or identity name known to a profile-supplemental preset root →
 *   `not applicable in this agent preset` (the pre-existing contract)
 * - everything else → `unknown` (the caller keeps the hard-failure contract and
 *   preserves the draft)
 * @param {unknown[]} entries unresolved draft entries (identity objects or name strings)
 * @param {{
 *   roots?: unknown,
 *   complete?: unknown,
 *   knownSupplemental?: (name: string) => boolean,
 *   platform?: string,
 * }} [options]
 * @returns {{ skipped: Array<{ name: string, reason: string }>, unknown: string[] }}
 */
export function partitionUnresolvedSkills(entries, options = {}) {
  const knownSupplemental = typeof options.knownSupplemental === 'function' ? options.knownSupplemental : () => false
  // Evidence gate: an incomplete inventory, or a current workspace whose project
  // roots did not resolve, authorizes no cross-workspace skip at all.
  const projectRoots = options.complete === true
    ? workspaceProjectSkillRoots(options.roots, options)
    : new Set()
  const canProveForeign = projectRoots.size > 0
  const skipped = []
  const unknown = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry === 'string') {
      if (knownSupplemental(entry)) skipped.push({ name: entry, reason: NOT_APPLICABLE_IN_PRESET })
      else unknown.push(entry)
      continue
    }
    const identity = /** @type {Record<string, unknown> | null} */ (
      entry && typeof entry === 'object' ? entry : null)
    if (!identity) {
      unknown.push(String(entry))
      continue
    }
    const name = typeof identity.name === 'string' && identity.name.length > 0 ? identity.name : String(entry)
    if (knownSupplemental(name)) {
      skipped.push({ name, reason: NOT_APPLICABLE_IN_PRESET })
      continue
    }
    if (canProveForeign && isForeignProjectIdentity(identity, projectRoots, options)) {
      skipped.push({ name, reason: NOT_APPLICABLE_IN_WORKSPACE })
      continue
    }
    unknown.push(name)
  }
  return { skipped, unknown }
}
