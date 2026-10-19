import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from './helpers.js'
import { ERROR_CODES, EVENTS, OPS, PROTOCOL, validateFrame } from '../src/lease-broker/protocol.js'

// Cross-check between the protocol document and the protocol module.
//
// The document is the contract clients implement, so the two must agree in BOTH
// directions: an op or error code that only exists in the doc is a contract the
// daemon does not honour, and one that only exists in code is an undocumented
// wire value. Sources of truth stay separate (prose in docs, constants in code)
// and this test is the only thing that keeps them equal.

const DOC_URL = new URL('../../../docs/features/edit-lock-protocol.md', import.meta.url)
const SOURCE_DIR = new URL('../src/lease-broker/', import.meta.url)
const DOC = readFileSync(DOC_URL, 'utf8')

/**
 * Lines of one `## <heading…>` section, excluding the heading itself.
 * @param {string} markdown
 * @param {string} heading fragment that must appear in the heading line
 * @returns {string[]}
 */
function section(markdown, heading) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^##\s/.test(line) && line.includes(heading))
  if (start < 0) throw new Error(`protocol doc is missing the "${heading}" section`)
  const collected = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) break
    collected.push(lines[index])
  }
  return collected
}

/**
 * First-column tokens of every markdown table row that names exactly one
 * backticked identifier. Header and separator rows match nothing, and the other
 * columns are ignored — the error-code column of the op table would otherwise
 * leak into the op set.
 * @param {string[]} lines
 * @returns {string[]}
 */
function firstColumnTokens(lines) {
  const tokens = []
  for (const line of lines) {
    if (!line.trimStart().startsWith('|')) continue
    const firstCell = line.split('|')[1]
    if (firstCell === undefined) continue
    const match = /^\s*`([^`]+)`\s*$/.exec(firstCell)
    if (match) tokens.push(match[1])
  }
  return tokens
}

/** @param {string[]} tokens */
function sortedUnique(tokens) {
  return [...new Set(tokens)].sort()
}

/**
 * Error codes the implementation can actually produce: every `code: '…'`
 * literal in the daemon's sources.
 * @returns {Set<string>}
 */
function codesInSources() {
  const found = new Set()
  for (const name of readdirSync(SOURCE_DIR)) {
    if (!name.endsWith('.js')) continue
    const source = readFileSync(new URL(name, SOURCE_DIR), 'utf8')
    for (const match of source.matchAll(/code:\s*'([a-z][a-z-]*)'/g)) found.add(match[1])
  }
  return found
}

describe('edit-lock protocol document vs protocol module', () => {
  it('lists exactly the implemented request operations', () => {
    const documented = firstColumnTokens(section(DOC, '操作集'))
    expect(documented).toHaveLength(OPS.length)
    expect(sortedUnique(documented)).toEqual(sortedUnique([...OPS]))
  })

  it('lists exactly the implemented events', () => {
    const documented = firstColumnTokens(section(DOC, '事件'))
    expect(documented).toHaveLength(EVENTS.length)
    expect(sortedUnique(documented)).toEqual(sortedUnique([...EVENTS]))
  })

  it('lists exactly the implemented error codes, as a closed set', () => {
    const documented = firstColumnTokens(section(DOC, '错误码闭集'))
    expect(documented).toHaveLength(ERROR_CODES.length)
    expect(sortedUnique(documented)).toEqual(sortedUnique([...ERROR_CODES]))
  })

  it('never produces an error code outside the closed set', () => {
    const produced = codesInSources()
    expect(produced.size).toBeGreaterThan(0)
    for (const code of produced) {
      expect(ERROR_CODES.includes(code), `undocumented/unknown error code in src/lease-broker: ${code}`).toBe(true)
    }
    // Nothing in the closed set is dead weight either: every listed code is
    // reachable from the implementation.
    for (const code of ERROR_CODES) {
      expect(produced.has(code), `closed-set error code never produced: ${code}`).toBe(true)
    }
  })

  it('documents the protocol major the daemon speaks', () => {
    expect(DOC).toContain(`当前为 \`${PROTOCOL}\``)
    expect(firstColumnTokens(section(DOC, '端点地址与协议版本'))).toEqual([])
  })

  it('accepts a minimal frame for every documented op except the handshake order', () => {
    // The op table is the grammar: every documented op must validate as a frame.
    /** @type {Record<string, any>} */
    const minimal = {
      hello: { op: 'hello', protocol: PROTOCOL },
      acquire: {
        op: 'acquire',
        owner: { id: 'l', session: 's', label: 'x' },
        scope: '/w',
        paths: ['/w/a'],
      },
      release: { op: 'release', owner: { id: 'l', session: 's', label: 'x' }, paths: ['/w/a'] },
      hold: { op: 'hold', owner: { id: 'l', session: 's', label: 'x' }, paths: ['/w/a'], minutes: 1 },
      status: { op: 'status' },
      request: { op: 'request', from: { id: 'l', session: 's', label: 'x' }, path: '/w/a' },
      reply: { op: 'reply', owner: { id: 'l', session: 's', label: 'x' }, requestId: 'req-1', decision: 'keep' },
    }
    for (const op of OPS) {
      const result = validateFrame(minimal[op])
      expect(result.ok, `documented op did not validate: ${op}`).toBe(true)
      expect(result.op).toBe(op)
    }
  })
})
