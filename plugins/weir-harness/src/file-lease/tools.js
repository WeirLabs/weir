// The model-facing tool surface of the file-lease feature (design D4, D5, D13).
//
// Seven pure definitions. They own no state: the arbiter is the only authority
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
//
// Normalization is lexical and it happens HERE, for every tool input: `resolve`
// folds `.`, `..`, repeated and trailing separators and keeps an absolute input
// absolute, so one file has one spelling for arbitration and for the
// subscription table. The broker deliberately does not normalize — there string
// equality IS a path (docs/features/edit-lock-protocol.md) — so a verbatim `..`
// spelling would be granted a SECOND lease on a file another session holds, and
// `edit_lock_watch` would miss the held canonical path entirely.

import { basename, relative, resolve } from 'node:path'
import { isLeaseConflict } from './client.js'
import { createWatchCoordinator } from './watch.js'

/** Retention bound in minutes; the protocol clamps here and so does the tool. */
export const MAX_HOLD_MINUTES = 60

/** The negotiation reply tool: registered only while a request is pending. */
export const REPLY_TOOL = 'edit_lock_reply'

/** The release-subscription tool: one path, one in-memory subscription. */
export const WATCH_TOOL = 'edit_lock_watch'

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
 * One file, one spelling: the lexical normalization every tool input passes
 * through before it can become a claim, a retention, a release, a transfer
 * request or a release subscription.
 *
 * `resolve` is the right instrument and no other is needed: it folds `.`,
 * `..`, repeated and trailing separators, keeps an absolute input absolute
 * (the base is then ignored) and resolves a relative one against the session
 * cwd. It touches no filesystem, so symlinks and case are left alone — the
 * protocol makes that the client's call, and it keys leases by string equality,
 * which is exactly why `/p/src/../src/a.js` and `/p/src/a.js` must never reach
 * it as two paths.
 * @param {string} raw
 * @param {string} cwd
 * @returns {string}
 */
function canonicalPath(raw, cwd) {
  return resolve(cwd, raw)
}

/**
 * Resolve the model's path batch to the canonical, de-duplicated list the
 * protocol accepts. Normalization happens before the de-duplication, so two
 * spellings of one file collapse into one entry instead of becoming two claims.
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
    const absolute = canonicalPath(raw, cwd)
    if (!out.includes(absolute)) out.push(absolute)
  }
  return out
}

/**
 * The single-path form of {@link absoluteBatch}: normalize before the path can
 * reach the arbiter or the subscription coordinator.
 * @param {unknown} filePath
 * @param {string} cwd
 * @returns {string}
 */
function absoluteOne(filePath, cwd) {
  const raw = text(filePath)
  if (raw === undefined) throw new Error('file_path must be a non-empty string')
  return canonicalPath(raw, cwd)
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
 * The synchronous answer for a subscription that is already over. Every await in
 * the watch tool re-reads this first (design D2): a release, a reset or a
 * transfer that landed while the authoritative read was in flight is the truth,
 * and a late read result or failure may neither overwrite it nor cancel its
 * pending notice.
 * @param {import('./watch.js').WatchEntry} entry
 * @param {string} short
 * @returns {any | undefined}
 */
function terminalOutcome(entry, short) {
  if (entry.state === 'hit') {
    entry.settledByTool = true
    return {
      state: 'released',
      file_path: short,
      message: `The release of ${short} happened while this subscription was being established, so nothing is pending. Claim it with edit_lock_acquire if you still need it — a release is an opportunity, not an ownership grant.`,
    }
  }
  if (entry.state === 'reset') {
    entry.settledByTool = true
    return {
      state: 'reset',
      file_path: short,
      message: `The ownership arbiter connection was reset while this subscription was being established, so nothing is pending and nothing is known about ownership. Re-check with edit_lock_status, and call edit_lock_watch again if ${short} is still held by another session.`,
    }
  }
  if (entry.state === 'self') {
    entry.settledByTool = true
    return {
      state: 'self',
      file_path: short,
      message: `This session already owns ${short} — ownership arrived while this subscription was being established — so no release subscription was kept and there is nothing to wait for.`,
    }
  }
  return undefined
}

/**
 * The degraded answer for a wait that ended without an ownership fact.
 * @param {string} short
 * @returns {any}
 */
function cancelledOutcome(short) {
  return {
    degraded: true,
    code: 'watch-cancelled',
    message: `The release subscription for ${short} was cancelled before it could be established (this agent or the feature was shut down), so nothing is pending. Call edit_lock_watch again in a live agent if you still need the path.`,
  }
}

/**
 * Whether one entry is still the active wait it was. `watching` may only be
 * reported for the SAME object that is currently registered (design D2): an
 * overlapping call, a transfer or a disposal can end the wait while a read is
 * in flight, and a stale entry must never come back as `watching`.
 * @param {import('./watch.js').WatchCoordinator} watches
 * @param {import('./watch.js').WatchEntry} entry
 * @returns {boolean}
 */
function stillWatching(watches, entry) {
  return entry.state === 'watching' && watches.peek(entry.sessionId, entry.path) === entry
}

/**
 * Create the tool definitions.
 *
 * @param {object} options
 * @param {any} options.client the lease client (or a facade with the same surface)
 * @param {(agent: any) => { id: string, session: string, label: string }} options.ownerOf
 * @param {(agent: any, text: string) => any} [options.deliverNotice] model-facing
 *   notice channel, used only where a tool result cannot carry the outcome
 * @param {import('./watch.js').WatchCoordinator} [options.watchCoordinator] the
 *   subscription coordinator shared with the plugin's event routing
 * @param {import('./watch.js').WatchMount} [options.mount] the mount reference
 *   that owns this call's subscription, when a mount is in play
 * @returns {any[]} seven definitions, `REPLY_TOOL` included (the plugin decides
 *   when that one becomes visible)
 */
export function createLeaseTools({ client, ownerOf, deliverNotice = () => {}, watchCoordinator = createWatchCoordinator(), mount }) {
  const watches = watchCoordinator
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
      description: `Keep paths this session already owns past the end of this turn, for up to ${MAX_HOLD_MINUTES} minutes from now. Use it when the work continues after this turn; the paths stay yours and other sessions are refused until the deadline. A longer request is clamped, not ignored. When the deadline passes the paths become available again, and the expiry is announced only to a session that explicitly subscribed to that path's release with edit_lock_watch: a matching subscriber gets the usual notice that it may claim the path again, while with no subscriber nothing is announced.`,
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
            ? `Kept ${entries.length} path(s) past this turn: ${entries.join(', ')}. At most ${MAX_HOLD_MINUTES} minutes per request; a deadline that passes simply makes the paths available, and the expiry is announced only to a session that explicitly subscribed to that path with edit_lock_watch — a matching subscriber gets the usual chance to claim it again, while with no subscriber nothing is announced.`
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

    {
      name: WATCH_TOOL,
      description:
        'Wait for the next release of one contested path without polling it. Use it after an acquisition conflict or a declined/expired transfer request. The answer says whether anything is actually pending: a path that is already free or already yours returns that immediately and keeps no subscription. While it is held by another session, this subscribes once for this session and the next release arrives as a message; a release is only an opportunity to call edit_lock_acquire, never a grant of ownership, and another waiting session may claim it first. Repeating the call is idempotent.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The contested file to watch for a release, absolute or relative to the session working directory.' },
        },
        required: ['file_path'],
      },
      output: textOutput('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const owner = ownerOf(exec?.agent)
        const cwd = requireCwd(exec)
        const path = absoluteOne(args?.file_path, cwd)
        const short = shortName(path, cwd)
        // Registration comes FIRST (D2): a release that lands between the
        // registration and the authoritative read is caught by the event
        // callback, and one that landed before it is caught by the read below.
        // The opposite order would leave a permanent hole for that release.
        const entry = watches.register(owner.session, path, mount, exec?.agent)

        /** @type {any} */
        let reply
        try {
          // ONE read per entry: an overlapping call for the same session and
          // path joins this flight instead of running its own, so both calls
          // judge the same answer and the same entry object.
          reply = await watches.shareStatus(entry, () => client.status({ path }))
        } catch (error) {
          // A terminal outcome wins over any failure (D2): a release, a reset or
          // a transfer that landed while the read was in flight IS the answer,
          // and its pending notice must survive. A late rejection may only
          // cancel a plain wait.
          const terminal = terminalOutcome(entry, short)
          if (terminal !== undefined) return terminal
          // No authoritative answer means no subscription: never leave a
          // record that could wait forever for a release nobody described.
          // The removal is conditional on THIS entry still being active, so a
          // late caller can never cancel a newer episode.
          watches.cancel(owner.session, path, entry)
          if (isTransport(error)) return unavailable(error, 'no release subscription was created')
          throw error
        }

        // Same precedence on the success path: the entry may have been consumed
        // or ended while the read was in flight, whatever the read now says.
        const terminal = terminalOutcome(entry, short)
        if (terminal !== undefined) return terminal

        const leases = Array.isArray(reply?.leases) ? reply.leases : []
        if (leases.length === 0) {
          watches.cancel(owner.session, path, entry)
          return {
            state: 'free',
            file_path: short,
            message: `Nobody holds ${short} right now, so no release subscription was kept. Claim it with edit_lock_acquire (or just edit it) before working on it.`,
          }
        }
        const holder = leases[0]?.owner ?? {}
        const mine = text(holder.id) === owner.id || text(holder.session) === owner.session
        if (mine) {
          // `self` is terminal, not merely cancelled: an overlapping call that
          // shares this entry must read the same verdict instead of reporting a
          // wait that no longer exists.
          watches.cancel(owner.session, path, entry, 'self')
          return {
            state: 'self',
            file_path: short,
            message: `This session already owns ${short}, so no release subscription was kept and there is nothing to wait for.`,
          }
        }
        if (typeof client.supportsEvent !== 'function' || client.supportsEvent('released') !== true) {
          watches.cancel(owner.session, path, entry)
          return {
            degraded: true,
            code: 'release-events-unsupported',
            message: `The connected arbiter does not announce release events (release-events-unsupported), so no release subscription was created for ${short}. Only this subscription is unavailable: conflicts, managed edits and negotiation behave exactly as before, and this tool can be used again once the arbiter restarts with the capability.`,
          }
        }
        // `watching` is only claimed while THIS entry is still the active one:
        // an overlapping call or a disposal may have ended the wait while the
        // read was in flight, and a stale entry must never read as a live wait.
        if (!stillWatching(watches, entry)) return terminalOutcome(entry, short) ?? cancelledOutcome(short)
        const label = text(holder.label) ?? 'another session'
        const session = text(holder.session) ?? 'unknown'
        return {
          state: 'watching',
          file_path: short,
          holder: { label, session },
          message: `Watching ${short} for its next release; "${label}" (session ${session}) holds it now. A release notice will arrive as a message: it means only that the path is free to compete for, so call edit_lock_acquire then. It is not an ownership grant and it reserves nothing — another waiting session may claim the path first, and the ordinary holder conflict applies.`,
        }
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
