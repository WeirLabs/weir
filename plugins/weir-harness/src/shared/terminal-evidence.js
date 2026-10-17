// Terminal evidence — the single definition site for what proves a supervised
// child reached a terminal state: the STATUS/REPORT parser, the terminal-status
// predicate (its JSDoc carries the one blocked-vs-terminal rule every consumer
// refers to), and the two best-effort cold readers (the bounded audit-JSONL
// tail; a child log's final assistant text). Delegate supervision and worktree
// zombie-lane reconciliation both import from here, so neither subsystem
// reaches into the other for this concept.
//
// Load-bearing tolerance semantics (zombie-lane safety): readAuditTail's 256KB
// bounded window and error tolerance (missing/unreadable → [], a partial first
// line dropped, malformed lines skipped) make an aged-out fact degrade to "no
// evidence", never to a wrong release. Keep them byte-exact.
//
// Ports & adapters: the readers take their services as parameters (never ctx).
// node: imports are the src/shared precedent (audit.js);
// the node:-free constraint guards the delegate composition root, not shared.
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { contentText } from './content-text.js'

/** Parse a child's final assistant text into a terminal status, or null. */
export function parseTerminalStatus(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const match = /^STATUS:[ \t]*(completed|blocked)[ \t]*$/m.exec(text)
  if (!match) return null
  const reportMatch = /^REPORT:[ \t]*([\s\S]*)$/m.exec(text.slice(match.index))
  return { status: match[1], report: (reportMatch?.[1] ?? '').trim() }
}

/**
 * Single exit for the terminal-status predicate: statuses that count toward
 * group completion (blocked waits for a resume, so it is NOT terminal here).
 */
export function isTerminalStatus(status) {
  return status === 'completed' || status === 'terminated'
}

/** Audit JSONL location for one session (cold-safe channel; may not exist). */
export function auditFilePathOf(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  return join(cwd, '.weir', 'audit.jsonl')
}

/**
 * Tail-read the audit JSONL (best-effort): returns parsed records, or [] when
 * the file is missing/unreadable. A partial first line is dropped.
 * @param {string | null} filePath
 * @param {number} [maxBytes]
 * @returns {object[]}
 */
export function readAuditTail(filePath, maxBytes = 256 * 1024) {
  if (typeof filePath !== 'string' || filePath.length === 0) return []
  let size
  try {
    size = statSync(filePath).size
  } catch {
    return []
  }
  if (size === 0) return []
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  let buffer
  try {
    buffer = Buffer.alloc(length)
    const fd = openSync(filePath, 'r')
    try {
      readSync(fd, buffer, 0, length, start)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const lines = buffer.toString('utf8').split('\n')
  if (start > 0 && lines.length > 0) lines.shift()
  const records = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // tolerate malformed lines (best-effort tail)
    }
  }
  return records
}

/**
 * L3 reader: last assistant text of a child session, or null when unreadable.
 * @param {object} sessionQuery - DSH sessionQuery service
 * @param {string} childId
 * @returns {Promise<string | null>}
 */
export async function readChildFinalText(sessionQuery, childId) {
  const read = await sessionQuery.readSession(childId)
  const events = read?.events ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = contentText(content)
    if (text.length > 0) return text
    return null
  }
  return null
}
