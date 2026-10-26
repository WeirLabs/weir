// Wire protocol for `weir-editlockd`: constants plus the frame validator.
//
// Pure module — no IO, no clock, no DSH/cordis/@deepseek-ai imports. The same
// file is the single source of truth for what crosses the socket, and
// docs/features/edit-lock-protocol.md is kept in lockstep with it by
// test/lease-broker-protocol-doc.test.js (op names and error codes must match
// in BOTH directions: a doc-only or an implementation-only entry fails).
//
// Field discipline is exact: a frame carrying any field outside the per-op
// allowlist is rejected as `bad-request`. That keeps the accepted grammar
// readable from this file alone and prevents "tolerated extras" from drifting
// into a de-facto second protocol.

/** Protocol major version. Bump only for breaking wire changes; the value is
 * part of the socket address so majors never arbitrate against each other. */
export const PROTOCOL = 1

/** Request operations accepted after the handshake (`hello` is the handshake). */
export const OPS = Object.freeze(['hello', 'acquire', 'release', 'hold', 'status', 'request', 'reply'])

/** Unsolicited events pushed by the broker. `request` and `settled` go to one
 * connection; `released` is a fact offered to every connected client. */
export const EVENTS = Object.freeze(['request', 'settled', 'released'])

/** Closed error vocabulary. No code may describe an operator action: every
 * refusal either resolves by negotiation or by validity elapsing. */
export const ERROR_CODES = Object.freeze([
  'protocol-mismatch',
  'bad-request',
  'invalid-path',
  'held',
  'not-owned',
  'free',
  'self',
  'limit',
  'expired',
  'stale',
  'not-holder',
  'internal',
])

/** Reply decisions on a pending transfer request. */
export const DECISIONS = Object.freeze(['release', 'keep'])

/**
 * @typedef {{ id: string, session: string, label: string }} Owner
 * @typedef {{ op: 'hello', protocol: number, reqId?: string }} HelloFrame
 * @typedef {{ op: 'acquire', owner: Owner, scope: string, paths: string[], ttlMs?: number, reqId?: string }} AcquireFrame
 * @typedef {{ op: 'release', owner: Owner, paths: string[], reqId?: string }} ReleaseFrame
 * @typedef {{ op: 'hold', owner: Owner, paths: string[], minutes: number, reqId?: string }} HoldFrame
 * @typedef {{ op: 'status', scope?: string, session?: string, path?: string, reqId?: string }} StatusFrame
 * @typedef {{ op: 'request', from: Owner, path: string, reqId?: string }} RequestFrame
 * @typedef {{ op: 'reply', owner: Owner, requestId: string, decision: 'release' | 'keep', reqId?: string }} ReplyFrame
 * @typedef {HelloFrame | AcquireFrame | ReleaseFrame | HoldFrame | StatusFrame | RequestFrame | ReplyFrame} Frame
 * @typedef {'hello' | 'acquire' | 'release' | 'hold' | 'status' | 'request' | 'reply'} Op
 * @typedef {{ ok: true, op: Op, value: Frame } | { ok: false, code: 'bad-request' | 'invalid-path' }} ValidationResult
 */

const OP_SET = new Set(OPS)

/** Per-op field allowlist: the accepted grammar, exactly. `reqId` is the
 * client's correlation token and is legal on every frame. */
const FIELDS = Object.freeze({
  hello: ['op', 'protocol', 'reqId'],
  acquire: ['op', 'owner', 'scope', 'paths', 'ttlMs', 'reqId'],
  release: ['op', 'owner', 'paths', 'reqId'],
  hold: ['op', 'owner', 'paths', 'minutes', 'reqId'],
  status: ['op', 'scope', 'session', 'path', 'reqId'],
  request: ['op', 'from', 'path', 'reqId'],
  reply: ['op', 'owner', 'requestId', 'decision', 'reqId'],
})

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>} true for a non-array object
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Non-empty string without NUL.
 * @param {unknown} value
 * @returns {value is string}
 */
function isText(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000')
}

/**
 * Every key of `record` is listed in `allowed` (no extras, no unknowns).
 * @param {Record<string, any>} record
 * @param {readonly string[]} allowed
 */
function onlyFields(record, allowed) {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) return false
  return true
}

/** `owner` is exactly `{id, session, label}` with three non-empty strings — the
 * broker never interprets them (D8). @param {unknown} value */
function isOwner(value) {
  if (!isRecord(value)) return false
  if (!onlyFields(value, ['id', 'session', 'label'])) return false
  return isText(value.id) && isText(value.session) && isText(value.label)
}

/** Absolute POSIX path, or a win32 drive/UNC path. @param {unknown} value */
function isAbsolutePath(value) {
  if (!isText(value)) return false
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return value.startsWith('\\\\')
}

/** Non-empty array of absolute paths. @param {unknown} value */
function isPathList(value) {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((path) => isAbsolutePath(path))
}

/** Finite positive number (ttl overrides and retention minutes). @param {unknown} value */
function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** @returns {ValidationResult} */
function badRequest() {
  return /** @type {ValidationResult} */ ({ ok: false, code: 'bad-request' })
}

/** @type {Record<string, (frame: Record<string, any>) => ValidationResult>} */
const BUILDERS = {
  /** @returns {ValidationResult} */
  hello(frame) {
    if (!Number.isInteger(frame.protocol) || frame.protocol < 0) return badRequest()
    /** @type {HelloFrame} */
    const value = { op: 'hello', protocol: frame.protocol }
    if (frame.reqId !== undefined) value.reqId = frame.reqId
    return { ok: true, op: 'hello', value }
  },

  /** @returns {ValidationResult} */
  acquire(frame) {
    if (!isOwner(frame.owner)) return badRequest()
    if (!isText(frame.scope)) return badRequest()
    if (!isPathList(frame.paths)) return { ok: false, code: 'invalid-path' }
    if (frame.ttlMs !== undefined && !isPositiveNumber(frame.ttlMs)) return badRequest()
    /** @type {AcquireFrame} */
    const value = { op: 'acquire', owner: { ...frame.owner }, scope: frame.scope, paths: [...frame.paths] }
    if (frame.ttlMs !== undefined) value.ttlMs = frame.ttlMs
    if (frame.reqId !== undefined) value.reqId = frame.reqId
    return { ok: true, op: 'acquire', value }
  },

  /** @returns {ValidationResult} */
  release(frame) {
    if (!isOwner(frame.owner)) return badRequest()
    if (!isPathList(frame.paths)) return { ok: false, code: 'invalid-path' }
    /** @type {ReleaseFrame} */
    const value = { op: 'release', owner: { ...frame.owner }, paths: [...frame.paths] }
    if (frame.reqId !== undefined) value.reqId = frame.reqId
    return { ok: true, op: 'release', value }
  },

  /** @returns {ValidationResult} */
  hold(frame) {
    if (!isOwner(frame.owner)) return badRequest()
    if (!isPathList(frame.paths)) return { ok: false, code: 'invalid-path' }
    if (!isPositiveNumber(frame.minutes)) return badRequest()
    /** @type {HoldFrame} */
    const value = { op: 'hold', owner: { ...frame.owner }, paths: [...frame.paths], minutes: frame.minutes }
    if (frame.reqId !== undefined) value.reqId = frame.reqId
    return { ok: true, op: 'hold', value }
  },

  /** @returns {ValidationResult} */
  status(frame) {
    /** @type {StatusFrame} */
    const value = { op: 'status' }
    if (frame.scope !== undefined) {
      if (!isText(frame.scope)) return badRequest()
      value.scope = frame.scope
    }
    if (frame.session !== undefined) {
      if (!isText(frame.session)) return badRequest()
      value.session = frame.session
    }
    if (frame.path !== undefined) {
      if (!isAbsolutePath(frame.path)) return { ok: false, code: 'invalid-path' }
      value.path = frame.path
    }
    if (frame.reqId !== undefined) value.reqId = frame.reqId
    return { ok: true, op: 'status', value }
  },

  /** @returns {ValidationResult} */
  request(frame) {
    if (!isOwner(frame.from)) return badRequest()
    if (!isAbsolutePath(frame.path)) return { ok: false, code: 'invalid-path' }
    /** @type {RequestFrame} */
    const value = { op: 'request', from: { ...frame.from }, path: frame.path }
    if (frame.reqId !== undefined) value.reqId = frame.reqId
    return { ok: true, op: 'request', value }
  },

  /** @returns {ValidationResult} */
  reply(frame) {
    if (!isOwner(frame.owner)) return badRequest()
    if (!isText(frame.requestId)) return badRequest()
    if (!DECISIONS.includes(frame.decision)) return badRequest()
    /** @type {ReplyFrame} */
    const value = { op: 'reply', owner: { ...frame.owner }, requestId: frame.requestId, decision: frame.decision }
    if (frame.reqId !== undefined) value.reqId = frame.reqId
    return { ok: true, op: 'reply', value }
  },
}

/**
 * Validate one decoded frame against the per-op grammar.
 *
 * Returns `{ok:true, op, value}` with the normalized frame (copies of owner and
 * paths, `reqId` carried through when present) or `{ok:false, code}` where code
 * is `bad-request` for shape/identity/value problems and `invalid-path` for a
 * non-absolute path, a NUL byte or an empty path.
 *
 * @param {unknown} frame decoded JSON value
 * @returns {ValidationResult}
 */
export function validateFrame(frame) {
  if (!isRecord(frame)) return { ok: false, code: 'bad-request' }
  const op = frame.op
  if (typeof op !== 'string' || !OP_SET.has(op)) return { ok: false, code: 'bad-request' }
  if (!onlyFields(frame, FIELDS[op])) return { ok: false, code: 'bad-request' }
  if (frame.reqId !== undefined && !isText(frame.reqId)) return { ok: false, code: 'bad-request' }
  return BUILDERS[op](frame)
}
