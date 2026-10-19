// The model-facing tool surface of the file-lease feature (design D4, D5, D13).
//
// Six pure definitions. They own no state: the arbiter is the only authority
// (D6/D8), so a tool translates a model intent into one protocol call and
// translates the verdict back into something a model can act on. Nothing here
// re-derives ownership, remembers it, or waits for it.
//
// Text discipline (AGENTS §3.7): every template below is English, and every
// refusal is addressed to the MODEL — name the holder, say that the claim frees
// itself, say not to retry the same edit blindly, and offer the negotiation
// path. No template may name a command, a setting, a panel or any operator
// action: ownership always resolves by turn end, by validity elapsing, or by
// model-to-model negotiation (spec: "Refusal is addressed to the model", "No
// ownership state requires a human").
//
// Path discipline: the protocol speaks absolute paths only (a relative path
// would be `invalid-path` and then degrade), so tools resolve the model's
// short paths against the session cwd on the way in and render short names
// relative to that same cwd on the way out. An absolute path never lands in a
// message body.

import { basename, isAbsolute, relative, resolve } from 'node:path'
import { isLeaseConflict } from './client.js'

/** Retention bound in minutes; the protocol clamps here and so does the tool. */
export const MAX_HOLD_MINUTES = 60

/** The negotiation reply tool: registered only while a request is pending. */
export const REPLY_TOOL = 'edit_lock_reply'

/** Default retention when the model asks for one without a length. */
export const DEFAULT_HOLD_MINUTES = MAX_HOLD_MINUTES

/**
 * Single-field text rendering, the shape every tool in this bundle uses.
 * @param {string} field
 */
function textOutput(field) {
  return {
    schema: { type: 'object' },
    render: (/** @type {any} */ _args, /** @type {any} */ result) => [{ type: 'text', text: result[field] }],
  }
}

/** @param {string} description */
function pathList(description) {
  return { type: 'array', items: { type: 'string' }, minItems: 1, description }
}

/** @param {unknown} value @returns {string | undefined} */
function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A broker refusal code, or `internal` when the failure carries none. @param {any} error */
function codeOf(error) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined
  return typeof code === 'string' ? code : 'internal'
}

/** True for the one failure class that is infrastructure, not a verdict (D7). */
function isTransport(error) {
  return codeOf(error) === 'transport'
}

/**
 * The session working directory, which is both the resolution base for short
 * paths and the opaque project scope the arbiter only ever uses for `status`.
 * @param {any} exec
 * @returns {string}
 */
function requireCwd(exec) {
  const cwd = text(exec?.agent?.session?.header?.cwd)
  if (cwd === undefined) throw new Error('the session working directory is unavailable, so paths cannot be resolved')
  return cwd
}

/**
 * Render a path the way the model thinks about it: relative to the session cwd,
 * or as a bare name when it lives outside. A resolved absolute path is accepted
 * on the way in — that symmetry is what makes the model's own absolute path
 * echo readable instead of pasted verbatim.
 * @param {string} path
 * @param {string | undefined} cwd
 * @returns {string}
 */
export function shortName(path, cwd) {
  const name = basename(path)
  if (cwd === undefined) return name
  const rel = relative(cwd, path)
  if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return name
  return rel
}

/**
 * Resolve the model's path batch to the absolute, de-duplicated list the
 * protocol accepts.
 * @param {unknown} paths
 * @param {string} cwd
 * @returns {string[]}
 */
function absoluteBatch(paths, cwd) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must list at least one path')
  /** @type {string[]} */
  const out = []
  for (const entry of paths) {
    const raw = text(entry)
    if (raw === undefined) throw new Error('every entry of paths must be a non-empty string')
    const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw)
    if (!out.includes(absolute)) out.push(absolute)
  }
  return out
}

/**
 * @param {unknown} filePath
 * @param {string} cwd
 * @returns {string}
 */
function absoluteOne(filePath, cwd) {
  const raw = text(filePath)
  if (raw === undefined) throw new Error('file_path must be a non-empty string')
  return isAbsolute(raw) ? raw : resolve(cwd, raw)
}

/** `2026-05-05T12:00:00.000Z` for a validity instant. @param {number} at epoch ms */
function instant(at) {
  return new Date(at).toISOString()
}

/**
 * Remaining validity in whole seconds, rounded up so a positive window never
 * renders as "0s" and a lapsed one never renders as still valid.
 * @param {number} target epoch ms
 * @param {number} at epoch ms
 * @returns {number}
 */
function secondsUntil(target, at) {
  return Math.max(0, Math.ceil((target - at) / 1000))
}

/** Whether a row carries a retention deadline beyond its plain validity. */
function retainedUntil(/** @type {any} */ row) {
  const expiresAt = typeof row?.expiresAt === 'number' ? row.expiresAt : 0
  const holdUntil = typeof row?.holdUntil === 'number' ? row.holdUntil : 0
  return holdUntil > expiresAt ? holdUntil : undefined
}

/**
 * The refusal text for a `held` verdict. The obligations of the spec's "Refusal
 * names the holder" and "Refusal offers no human step" scenarios are encoded
 * here and nowhere else, so the wording cannot drift between the tools that can
 * hit a conflict — including the managed editors that will acquire leases
 * instead of calling a tool, which is why this is exported.
 * @param {any} error a `held` LeaseFailure carrying `conflicts`
 * @param {string} cwd
 * @param {number} at epoch ms
 * @returns {string}
 */
export function describeConflicts(error, cwd, at) {
  const conflicts = Array.isArray(error?.conflicts) ? error.conflicts : []
  const lines = conflicts.map((/** @type {any} */ conflict) => {
    const holder = conflict?.holder ?? {}
    const label = text(holder.label) ?? 'another session'
    const session = text(holder.session) ?? 'unknown'
    const target = Math.max(typeof conflict?.expiresAt === 'number' ? conflict.expiresAt : 0, typeof conflict?.holdUntil === 'number' ? conflict.holdUntil : 0)
    return `- ${shortName(String(conflict?.path ?? ''), cwd)} is held by "${label}" (session ${session}) for about ${secondsUntil(target, at)}s more`
  })
  const headline = conflicts.length > 0
    ? `Refused: ${conflicts.length} of the requested path(s) are owned by another session.`
    : 'Refused: another session owns one or more of the requested paths.'
  return [
    headline,
    ...lines,
    'Ownership frees itself when its validity ends, so do not retry this edit blindly: the same call keeps being refused while the holder keeps the path.',
    'If you need a path now, ask for it — call edit_lock_try_steal with that path and wait for the holder\'s answer (release transfers it, keep or silence leaves it where it is).',
  ].join('\n')
}

/**
 * Create the tool definitions.
 *
 * @param {object} options
 * @param {any} options.client the lease client (or a facade with the same surface)
 * @param {(agent: any) => { id: string, session: string, label: string }} options.ownerOf
 * @param {(agent: any, text: string) => any} [options.deliverNotice] model-facing
 *   notice channel, used only where a tool result cannot carry the outcome
 * @returns {any[]} six definitions, `REPLY_TOOL` included (the plugin decides
 *   when that one becomes visible)
 */
export function createLeaseTools({ client, ownerOf, deliverNotice = () => {} }) {
  return [
    {
      name: 'edit_lock_acquire',
      description:
        'Claim file paths for this session before touching them, so another session cannot take them while you analyse. Managed edits claim implicitly; call this to hold the paths up front. The whole batch is granted or refused together. A refusal names the current holder and frees itself — do not retry it blindly.',
      parameters: {
        type: 'object',
        properties: {
          paths: pathList('Paths to claim, absolute or relative to the session working directory.'),
        },
        required: ['paths'],
      },
      output: textOutput('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const owner = ownerOf(exec?.agent)
        const cwd = requireCwd(exec)
        const paths = absoluteBatch(args?.paths, cwd)
        try {
          const reply = await client.acquire(owner, paths, cwd)
          const granted = Array.isArray(reply?.granted) ? reply.granted : []
          const claimed = granted.map((/** @type {any} */ lease) => shortName(String(lease?.path ?? ''), cwd))
          return {
            paths: claimed,
            message: claimed.length > 0
              ? `Claimed ${claimed.length} path(s) for this turn: ${claimed.join(', ')}.`
              : 'Nothing was claimed.',
          }
        } catch (error) {
          if (isLeaseConflict(error)) throw new Error(describeConflicts(error, cwd, Date.now()))
          if (isTransport(error)) return unavailable(error, 'nothing was claimed')
          throw error
        }
      },
    },

    {
      name: 'edit_lock_release',
      description:
        'Release paths this session owns, retained ones included, so another session can claim them without waiting for any deadline. Releasing a path nobody owns is not an error: the answer simply says it was not held.',
      parameters: {
        type: 'object',
        properties: {
          paths: pathList('Paths to release, absolute or relative to the session working directory.'),
        },
        required: ['paths'],
      },
      output: textOutput('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const owner = ownerOf(exec?.agent)
        const cwd = requireCwd(exec)
        const paths = absoluteBatch(args?.paths, cwd)
        let reply
        try {
          reply = await client.request('release', { owner, paths })
        } catch (error) {
          if (isTransport(error)) return unavailable(error, 'the release was not confirmed')
          throw error
        }
        const released = (Array.isArray(reply?.released) ? reply.released : []).map((/** @type {any} */ path) => shortName(String(path), cwd))
        const notOwned = (Array.isArray(reply?.notOwned) ? reply.notOwned : []).map((/** @type {any} */ path) => shortName(String(path), cwd))
        const lines = []
        lines.push(released.length > 0 ? `Released ${released.length} path(s): ${released.join(', ')}.` : 'Released nothing.')
        if (notOwned.length > 0) lines.push(`Not held by this session, so there was nothing to release: ${notOwned.join(', ')}.`)
        return { released, notOwned, message: lines.join('\n') }
      },
    },

    {
      name: 'edit_lock_hold',
      description: `Keep paths this session already owns past the end of this turn, for up to ${MAX_HOLD_MINUTES} minutes from now. Use it when the work continues after this turn; the paths stay yours and other sessions are refused until the deadline. A longer request is clamped, not ignored. When the deadline passes the paths become available and nothing is announced.`,
      parameters: {
        type: 'object',
        properties: {
          paths: pathList('Paths to keep, absolute or relative to the session working directory. They must already be owned.'),
          minutes: {
            type: 'number',
            description: `How long to keep them, counted from now; clamped to ${MAX_HOLD_MINUTES}. Omit for the full ${DEFAULT_HOLD_MINUTES} minutes.`,
          },
        },
        required: ['paths'],
      },
      output: textOutput('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const owner = ownerOf(exec?.agent)
        const cwd = requireCwd(exec)
        const paths = absoluteBatch(args?.paths, cwd)
        const requested = args?.minutes === undefined || args?.minutes === null ? DEFAULT_HOLD_MINUTES : Number(args.minutes)
        if (!Number.isFinite(requested) || requested <= 0) throw new Error('minutes must be a positive number of minutes')
        const minutes = Math.min(MAX_HOLD_MINUTES, requested)
        let reply
        try {
          reply = await client.hold(paths, minutes, owner)
        } catch (error) {
          const code = codeOf(error)
          if (code === 'not-owned') {
            throw new Error(`This session does not own ${paths.map((path) => shortName(path, cwd)).join(', ')}. Retention only extends ownership that already exists — claim the paths with edit_lock_acquire first.`)
          }
          if (isTransport(error)) return unavailable(error, 'no retention was recorded')
          throw error
        }
        const held = Array.isArray(reply?.held) ? reply.held : []
        const at = Date.now()
        const entries = held.map((/** @type {any} */ row) => {
          const until = typeof row?.holdUntil === 'number' ? row.holdUntil : typeof row?.expiresAt === 'number' ? row.expiresAt : at
          return `${shortName(String(row?.path ?? ''), cwd)} until ${instant(until)} (about ${Math.ceil(secondsUntil(until, at) / 60)}m from now)`
        })
        return {
          // Short names only: an absolute path never appears in a tool result,
          // not even in a structured field the model also reads.
          held: held.map((/** @type {any} */ row) => ({ path: shortName(String(row?.path ?? ''), cwd), holdUntil: row?.holdUntil ?? null })),
          message: entries.length > 0
            ? `Kept ${entries.length} path(s) past this turn: ${entries.join(', ')}. At most ${MAX_HOLD_MINUTES} minutes per request; a deadline that passes announces nothing — the paths simply become available.`
            : 'Nothing was retained.',
        }
      },
    },

    {
      name: 'edit_lock_try_steal',
      description:
        'Ask the session that owns a file to hand it over. Returns immediately with a pending request: it never waits for the holder. The holder is told about it and answers with edit_lock_reply; release transfers ownership, keep (or silence) leaves it where it is. Do not edit the file before the transfer is granted.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The owned file you need, absolute or relative to the session working directory.' },
        },
        required: ['file_path'],
      },
      output: textOutput('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const owner = ownerOf(exec?.agent)
        const cwd = requireCwd(exec)
        const path = absoluteOne(args?.file_path, cwd)
        const short = shortName(path, cwd)
        let reply
        try {
          reply = await client.requestTransfer(path, owner)
        } catch (error) {
          const code = codeOf(error)
          if (code === 'free') return { state: 'free', message: `Nobody holds ${short} right now: edit it directly, or claim it with edit_lock_acquire so another session cannot take it mid-work.` }
          if (code === 'self') return { state: 'self', message: `This session already owns ${short}; no transfer is needed.` }
          if (isTransport(error)) return unavailable(error, 'no transfer request was created')
          throw error
        }
        const requestId = text(reply?.requestId) ?? ''
        const holder = reply?.holder ?? {}
        const label = text(holder.label) ?? 'the holder'
        const session = text(holder.session) ?? 'unknown'
        const expiresAt = typeof reply?.expiresAt === 'number' ? reply.expiresAt : Date.now()
        return {
          state: 'pending',
          request_id: requestId,
          holder: { label, session },
          message: `Request ${requestId} for ${short} is pending with "${label}" (session ${session}). Do not modify ${short} until ownership is granted — a pending request is not an approval, and edits keep being refused meanwhile. The holder answers with edit_lock_reply (release hands it over, keep keeps it); an unanswered request expires in about ${secondsUntil(expiresAt, Date.now())}s and ownership stays where it is. A message will tell you how it settled.`,
        }
      },
    },

    {
      name: REPLY_TOOL,
      description:
        'Answer a pending ownership request another session addressed to this session. Only the current holder can answer, this tool exists only while a request is pending, and stale or already-settled requests are refused. "release" hands the path over (this session stops owning it); "keep" leaves ownership unchanged. Not answering also leaves ownership unchanged.',
      parameters: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: 'The request_id from the ownership request message.' },
          decision: { type: 'string', enum: ['release', 'keep'], description: 'release to hand the path over, keep to hold on to it.' },
        },
        required: ['request_id', 'decision'],
      },
      output: textOutput('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const owner = ownerOf(exec?.agent)
        const requestId = text(args?.request_id)
        if (requestId === undefined) throw new Error('request_id must be a non-empty string')
        const decision = args?.decision === 'release' ? 'release' : args?.decision === 'keep' ? 'keep' : undefined
        if (decision === undefined) throw new Error('decision must be "release" or "keep"')
        let reply
        try {
          reply = await client.reply({ requestId, owner, decision })
        } catch (error) {
          const code = codeOf(error)
          if (code === 'expired') throw new Error(`Request ${requestId} has expired and ownership is unchanged. The requester can ask again later if it still needs the path.`)
          if (code === 'stale') throw new Error(`Request ${requestId} is stale: ownership changed before the answer arrived, so nothing was transferred.`)
          if (code === 'not-holder') throw new Error(`Request ${requestId} is not addressed to this session; only the current holder can answer it.`)
          if (isTransport(error)) return unavailable(error, 'the answer was not delivered')
          throw error
        }
        const state = text(reply?.state) ?? 'declined'
        if (state === 'transferred') {
          // Ownership moved: the caller may have more tool calls queued for that
          // path, so this reaches the model as a message rather than only as a
          // result it may have already reasoned past.
          deliverNotice(exec?.agent, `Ownership handed over: request ${requestId} is settled and this session no longer holds that path. Claim it again with edit_lock_acquire if you still need it.`)
        }
        return {
          request_id: requestId,
          decision,
          state,
          message: state === 'transferred'
            ? `Request ${requestId}: transferred. The requester owns the path now; this session no longer holds it.`
            : `Request ${requestId}: declined. Ownership is unchanged and the path is still this session's.`,
        }
      },
    },

    {
      name: 'edit_lock_status',
      description:
        'Read-only ownership report: the paths this session holds, and the sessions that currently hold paths in this working directory. Grants nothing and changes nothing. Ownership is arbitrated centrally, so the answer covers other processes too.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: textOutput('message'),
      async execute(/** @type {any} */ _args, /** @type {any} */ exec) {
        const owner = ownerOf(exec?.agent)
        const cwd = requireCwd(exec)
        let reply
        try {
          reply = await client.status({ scope: cwd })
        } catch (error) {
          if (isTransport(error)) return unavailable(error, 'no ownership could be read')
          throw error
        }
        const leases = Array.isArray(reply?.leases) ? reply.leases : []
        const at = Date.now()
        const mine = leases.filter((/** @type {any} */ lease) => text(lease?.owner?.id) === owner.id || text(lease?.owner?.session) === owner.session)
        const others = leases.filter((/** @type {any} */ lease) => !mine.includes(lease))
        const lines = []
        lines.push(mine.length > 0 ? `Held by this session (${mine.length}):` : 'This session holds nothing.')
        for (const lease of mine) {
          const until = retainedUntil(lease)
          const validity = until === undefined
            ? `valid for about ${secondsUntil(typeof lease?.expiresAt === 'number' ? lease.expiresAt : at, at)}s`
            : `retained until ${instant(until)}`
          lines.push(`- ${shortName(String(lease?.path ?? ''), cwd)} — ${validity}`)
        }
        if (others.length > 0) {
          lines.push(`Held by other sessions here (${others.length}):`)
          for (const lease of others) {
            const holder = lease?.owner ?? {}
            const label = text(holder.label) ?? 'another session'
            const session = text(holder.session) ?? 'unknown'
            const target = Math.max(typeof lease?.expiresAt === 'number' ? lease.expiresAt : 0, typeof lease?.holdUntil === 'number' ? lease.holdUntil : 0)
            lines.push(`- ${shortName(String(lease?.path ?? ''), cwd)} — "${label}" (session ${session}), ${target > at ? `about ${secondsUntil(target, at)}s left` : 'lapsed, claimable'}`)
          }
        }
        return { mine: mine.map((/** @type {any} */ lease) => shortName(String(lease?.path ?? ''), cwd)), message: lines.join('\n') }
      },
    },
  ]
}

/**
 * The one non-verdict answer: the arbiter could not be reached, so nothing was
 * decided. It is explicitly not a refusal — managed edits proceed unowned while
 * the arbiter is down (D7), and telling the model otherwise would stop work for
 * an infrastructure blip.
 * @param {any} error
 * @param {string} outcome
 * @returns {{ degraded: true, code: string, message: string }}
 */
function unavailable(error, outcome) {
  const code = codeOf(error)
  return {
    degraded: true,
    code,
    message: `The ownership arbiter is unreachable (${code}), so ${outcome}. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work.`,
  }
}
