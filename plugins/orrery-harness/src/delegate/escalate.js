// The ESCALATE contract: a child returns `ESCALATE: <category>` as the first
// line when the decision exceeds its lane; the harness respawns once on the
// named category carrying the child's findings.

/**
 * @param {string} text - the child's result text
 * @returns {{ target: string, findings: string } | null}
 */
export function parseEscalation(text) {
  if (typeof text !== 'string') return null
  const firstLine = text.split('\n', 1)[0].trim()
  const match = /^ESCALATE:\s*([a-z][a-z0-9-]*)$/.exec(firstLine)
  if (!match) return null
  return { target: match[1], findings: text.slice(firstLine.length).trim() }
}
