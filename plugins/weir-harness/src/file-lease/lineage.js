// Lineage resolution: which delegation chain a session belongs to, and the
// short label that chain shows to the model.
//
// The broker never interprets identity (design D8): `owner.id` is an opaque key.
// This module is the client-side rule that produces it (design D9): a root
// session is its own lineage, and a delegated child inherits its initiator's
// lineage, so a parent holding a file for the turn never refuses its own
// subagent. Two different chains still conflict — that is the whole point of
// the column being inherited rather than shared globally.
//
// Pure by construction: the only outside access is `sessions.get(id)?.header`,
// read behind a `try`. Every step that cannot be answered (missing header, a
// cycle, a hop cap, a throwing registry) degrades to the deepest ancestor we can
// name — never to a foreign conversation and never to an exception.

/** Hard stop for the ancestor walk; a chain this deep is a bug, not a tree. */
const MAX_HOPS = 16

/** Longest label handed to the model or the status panel. */
const MAX_LABEL_LENGTH = 60

/** Last-resort label: better a generic noun than an empty string. */
const FALLBACK_LABEL = 'session'

/** An absolute POSIX path, a win32 drive path, or a UNC path, at a word start. */
const ABSOLUTE_PATH_RUN = /(^|\s)((?:[A-Za-z]:[\\/]|\\\\|\/)[^\s]*)/g

/** @returns {string | undefined} the value when it is a non-empty string */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Same rule for display strings: a blank title is not a title, so it must not
 * shadow the next candidate (a whitespace-only label would collapse to the
 * generic fallback instead of naming the agent).
 * @returns {string | undefined}
 */
function visible(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * The final segment of a path-like run (`/a/b/c.js` → `c.js`). Used only to keep
 * an absolute path out of a label; the result is never used as an identifier.
 * @param {string} run
 * @returns {string}
 */
function lastSegment(run) {
  const segments = run.split(/[\\/]/)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment.length > 0) return segment
  }
  return ''
}

/**
 * Turn one raw string into a label that is safe to show: one line, no absolute
 * paths, at most `MAX_LABEL_LENGTH` characters, never empty.
 * @param {string | undefined} raw
 * @returns {string}
 */
function shorten(raw) {
  const source = text(raw)
  if (source === undefined) return FALLBACK_LABEL
  const oneLine = source.split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return FALLBACK_LABEL
  // A session title may embed the file or directory it was opened on. The label
  // is a name, not a locator, so every absolute run collapses to its basename.
  const stripped = oneLine.replace(ABSOLUTE_PATH_RUN, (_match, lead, run) => `${lead}${lastSegment(run)}`).trim()
  const label = stripped.length > 0 ? stripped : FALLBACK_LABEL
  if (label.length <= MAX_LABEL_LENGTH) return label
  return `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`
}

/**
 * @typedef {object} LineageResolverOptions
 * @property {{ get?: (id: string) => any } | undefined} [sessions] live sessions registry (`sessions.get(id)?.header`)
 * @property {Map<string, string>} [cache] session id → resolved lineage id; injectable so a caller can pre-warm or inspect it
 */

/**
 * @typedef {object} LineageResolver
 * @property {(agent: any) => string} lineageOf the opaque `owner.id` for this agent's chain
 * @property {(agent: any) => string} labelOf the short, path-free label for this agent
 */

/**
 * Create one lineage resolver.
 * @param {LineageResolverOptions} [options]
 * @returns {LineageResolver}
 */
export function createLineageResolver({ sessions, cache = new Map() } = {}) {
  /**
   * Read one session header. The registry is outside our control (it may be a
   * proxy, a settled handle, or absent entirely), so every failure reads as
   * "no header" instead of propagating into a turn.
   * @param {string} id
   * @returns {any}
   */
  function headerOf(id) {
    if (typeof id !== 'string' || id.length === 0) return undefined
    try {
      const session = sessions?.get?.(id)
      const header = session?.header
      return header !== null && typeof header === 'object' ? header : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The id this session is known by: the durable header's id, else the session's
   * own id, else the agent's id. Non-empty by construction — `owner.id` may not
   * be an empty string on the wire.
   * @param {any} agent
   * @param {any} header
   * @returns {string}
   */
  function ownIdOf(agent, header) {
    return (
      text(header?.id) ??
      text(agent?.session?.id) ??
      text(agent?.id) ??
      FALLBACK_LABEL
    )
  }

  /**
   * Resolve an agent to its lineage id.
   * @param {any} agent
   * @returns {string}
   */
  function lineageOf(agent) {
    try {
      const header = agent?.session?.header
      const own = ownIdOf(agent, header)
      // A root session is its own lineage — including a resume/fork incarnation
      // that still carries a `parentSession` header at depth 0.
      if ((header?.delegationDepth ?? 0) === 0) return own
      const cached = cache.get(own)
      if (typeof cached === 'string' && cached.length > 0) return cached
      const parentId = text(header?.parentSession)
      // A child with no parent header cannot be placed in a chain; being its own
      // lineage keeps it conflict-free against nothing at all, which is the
      // least surprising answer.
      if (parentId === undefined || parentId === own) return own
      let currentId = parentId
      /** @type {string} */
      let resolved = parentId
      let complete = false
      const seen = new Set([own, parentId])
      for (let hop = 0; hop < MAX_HOPS; hop += 1) {
        const ancestor = headerOf(currentId)
        if (ancestor === undefined) break
        if ((ancestor.delegationDepth ?? 0) === 0) {
          resolved = text(ancestor.id) ?? currentId
          complete = true
          break
        }
        const nextId = text(ancestor.parentSession)
        if (nextId === undefined || seen.has(nextId)) break
        seen.add(nextId)
        resolved = nextId
        currentId = nextId
      }
      // Only complete walks are remembered. A degraded answer (a parent that is
      // not loaded yet) stays uncached so a later lookup can still find the root
      // — a stale lineage id would silently merge two different chains.
      if (complete) cache.set(own, resolved)
      return resolved
    } catch {
      // The ugly-but-total fallback: the direct parent id, which still shares
      // one lineage across the whole subtree.
      return (
        text(agent?.session?.header?.parentSession) ??
        text(agent?.session?.id) ??
        text(agent?.id) ??
        FALLBACK_LABEL
      )
    }
  }

  /**
   * The short label for an agent: its session title, else its display name,
   * else `'session'`. Never a path, never longer than 60 characters.
   * @param {any} agent
   * @returns {string}
   */
  function labelOf(agent) {
    try {
      const header = agent?.session?.header
      const raw =
        visible(header?.title) ??
        visible(agent?.displayName) ??
        visible(agent?.name) ??
        visible(agent?.label) ??
        FALLBACK_LABEL
      return shorten(raw)
    } catch {
      return FALLBACK_LABEL
    }
  }

  return { lineageOf, labelOf }
}
