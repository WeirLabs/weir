// Unit record encoding of the capability store (design D2). A record is
// `{ schemaVersion, revision, payload, receipts, digest }`, where digest is the
// sha256 of the canonical JSON of `{ revision, payload, receipts }`. Anything
// that does not decode to exactly that shape fails closed.
import { createHash } from 'node:crypto'

export const RECORD_SCHEMA_VERSION = 1

/**
 * @typedef {{ requestId: string, requestDigest: string, revision: number, acceptedAt: number }} Receipt
 * @typedef {{ schemaVersion: number, revision: number, payload: unknown, receipts: Receipt[], digest: string }} Record
 * @typedef {{ kind: 'absent', revision: 0 }
 *   | { kind: 'ok', revision: number, payload: unknown, receipts: Receipt[], digest: string }
 *   | { kind: 'corrupt' }
 *   | { kind: 'unknown-schema', schemaVersion: unknown }
 *   | { kind: 'torn' }} RecordRead
 */

/** Deterministic JSON: object keys sorted, arrays in order. @param {unknown} value @returns {string} */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value)
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  const text = JSON.stringify(value)
  if (text === undefined) throw new TypeError(`value is not JSON-serializable: ${String(value)}`)
  return text
}

/** @param {unknown} value */
export const digestOf = value => createHash('sha256').update(canonical(value)).digest('hex')

/** @param {number} revision @param {unknown} payload @param {Receipt[]} receipts @returns {Record} */
export function encodeRecord(revision, payload, receipts) {
  return { schemaVersion: RECORD_SCHEMA_VERSION, revision, payload, receipts, digest: digestOf({ revision, payload, receipts }) }
}

/** @param {unknown} value */
const isReceipt = value => {
  const r = /** @type {Record<string, unknown>} */ (value)
  return r !== null && typeof r === 'object' && typeof r.requestId === 'string' && r.requestId.length > 0
    && typeof r.requestDigest === 'string' && Number.isSafeInteger(r.revision) && Number.isFinite(r.acceptedAt)
}

/** @param {string} text @returns {RecordRead} */
export function decodeRecord(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'corrupt' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'corrupt' }
  if (value.schemaVersion !== RECORD_SCHEMA_VERSION) return { kind: 'unknown-schema', schemaVersion: value.schemaVersion }
  const { revision, payload, receipts, digest } = value
  if (!Number.isSafeInteger(revision) || revision < 1 || !('payload' in value)
    || !Array.isArray(receipts) || !receipts.every(isReceipt) || typeof digest !== 'string') {
    return { kind: 'corrupt' }
  }
  if (digestOf({ revision, payload, receipts }) !== digest) return { kind: 'torn' }
  return { kind: 'ok', revision, payload, receipts, digest }
}
