import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { canonicalRequestData } from './request-data.js'

/** @param {string} value */
const digest = value => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')

/** Compute historical binding only; never grants publication authority.
 * Caller supplies trusted, fully resolved policy and observed target, not model
 * assertions. Policy authorization and topology checks remain manager duties.
 * @param {{tool: 'write'|'hash_edit', filePath: string, cwd: string, args: unknown, content: string,
 * effectivePolicy: unknown, target: import('./operation-history.js').Target}} input
 * @returns {import('./operation-history.js').Binding} */
export function bindRequest(input) {
  // Validate before property reads/copying, so ordinary getters never execute.
  const data = JSON.parse(canonicalRequestData(input))
  if (typeof data.content !== 'string') throw new Error('invalid content')
  if (!['write', 'hash_edit'].includes(data.tool)) throw new Error('invalid tool')
  if (typeof data.filePath !== 'string' || !data.filePath || data.filePath.includes('\0') ||
      typeof data.cwd !== 'string' || !isAbsolute(data.cwd) || data.cwd.includes('\0')) throw new Error('invalid request path')
  if (!data.target || !['create', 'update'].includes(data.target.kind)) throw new Error('invalid target')
  if (data.target.kind === 'create' && data.tool !== 'write') throw new Error('creation requires write')
  if (!data.effectivePolicy || typeof data.effectivePolicy !== 'object' || Array.isArray(data.effectivePolicy)) throw new Error('invalid effective policy')
  const argsDigest = digest(canonicalRequestData(data.args))
  const payloadDigest = digest(data.content)
  const requestDigest = digest(canonicalRequestData({ version: 1, tool: data.tool, method: 'writeText',
    filePath: data.filePath, cwd: data.cwd, expected: data.target.policy, effectivePolicy: data.effectivePolicy,
    argsDigest, payloadDigest, target: data.target }))
  /** @param {any} value */
  function freeze(value) {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
    return value
  }
  return freeze({ tool: data.tool, filePath: data.filePath, cwd: data.cwd,
    argsDigest, payloadDigest, requestDigest, target: data.target })
}
