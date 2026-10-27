import { describe, expect, it } from './helpers.js'
import { createLeaseTools, LEASE_META_STATES, LEASE_META_VERSION, REPLY_TOOL, WATCH_TOOL } from '../src/file-lease/tools.js'
import { createWatchCoordinator } from '../src/file-lease/watch.js'

// The edit-lock conversation cards (openspec edit-lock-tool-cards, design D1)
// read UI-only presentation metadata, and the hard constraint is that the
// MODEL sees nothing new: the rendered text and the structured result object
// of every outcome stay byte-for-byte and field-for-field what they were.
//
// BASELINE below was recorded from the pre-change tools.js (the commit that
// introduced this file ran it against `textOutput('message')`), one entry per
// outcome — every success state, every degraded answer and every throw path.
// A clock pin makes the time-bearing messages deterministic. The parity test
// compares the current code against it; the metadata tests then pin what the
// cards receive on top.

const T0 = 1_780_000_000_000
const CWD = '/work/project'
const OWNER = Object.freeze({ id: 'lineage-a', session: 'sess-a', label: 'orchestrator' })
const OTHER = Object.freeze({ id: 'lineage-b', session: 'sess-b', label: 'reviewer' })
const A = `${CWD}/src/a.js`
const B = `${CWD}/src/b.js`

/** @param {boolean} withCwd */
function agentFor(withCwd) {
  return { id: OWNER.session, session: { id: OWNER.session, header: withCwd ? { id: OWNER.session, cwd: CWD } : { id: OWNER.session } } }
}

/** A scripted client answering from `answers` (same surface as client.js). @param {Record<string, any>} answers */
function createFakeClient(answers) {
  /** @param {string} op @param {any} payload */
  async function answer(op, payload) {
    const handler = answers[op]
    if (typeof handler === 'function') return await handler(payload)
    if (handler !== undefined) return handler
    return { ok: true }
  }
  return {
    acquire: (/** @type {any} */ owner, /** @type {any} */ paths, /** @type {any} */ scope) => answer('acquire', { owner, paths, scope }),
    hold: (/** @type {any} */ paths, /** @type {any} */ minutes, /** @type {any} */ owner) => answer('hold', { paths, minutes, owner }),
    request: (/** @type {string} */ op, /** @type {any} */ payload) => answer('request', { op, ...payload }),
    status: (/** @type {any} */ filter) => answer('status', { filter }),
    requestTransfer: (/** @type {any} */ path, /** @type {any} */ from) => answer('requestTransfer', { path, from }),
    reply: (/** @type {any} */ input) => answer('reply', { ...input }),
    supportsEvent: (/** @type {string} */ name) => (typeof answers.supportsEvent === 'function' ? answers.supportsEvent(name) : true),
  }
}

/** @param {string} code @param {string} [message] @param {Record<string, any>} [extra] */
function failure(code, message = `lease broker refused: ${code}`, extra = {}) {
  return () => {
    throw Object.assign(new Error(message), { code, ...extra })
  }
}

const transport = failure('transport', 'lease broker is unreachable')
const heldByOther = () => ({ ok: true, leases: [{ path: A, owner: { ...OTHER }, scope: CWD, acquiredAt: T0 - 1000, expiresAt: T0 + 90_000, holdUntil: null }] })

/**
 * Every outcome the seven tools can produce. `answers` receives the watch
 * coordinator so the race cases can settle the entry mid-read.
 * @type {Record<string, { tool: string, args: any, cwd?: string | undefined, noCwd?: boolean, answers?: (registry: any) => Record<string, any> }>}
 */
const CASES = {
  'acquire/claimed': { tool: 'edit_lock_acquire', args: { paths: ['src/a.js', `${CWD}/src/../src/b.js`] }, answers: () => ({ acquire: { ok: true, granted: [{ path: A }, { path: B }] } }) },
  'acquire/nothing': { tool: 'edit_lock_acquire', args: { paths: ['src/a.js'] }, answers: () => ({ acquire: { ok: true, granted: [] } }) },
  'acquire/conflict': {
    tool: 'edit_lock_acquire',
    args: { paths: ['src/a.js', 'src/b.js'] },
    answers: () => ({ acquire: failure('held', 'lease broker refused acquire: held', { conflicts: [{ path: A, holder: { ...OTHER }, expiresAt: T0 + 42_000, holdUntil: null }] }) }),
  },
  'acquire/degraded': { tool: 'edit_lock_acquire', args: { paths: ['src/a.js'] }, answers: () => ({ acquire: transport }) },
  'acquire/other-error': { tool: 'edit_lock_acquire', args: { paths: ['src/a.js'] }, answers: () => ({ acquire: failure('invalid-path') }) },
  'acquire/invalid-args': { tool: 'edit_lock_acquire', args: { paths: [] } },
  'acquire/no-cwd': { tool: 'edit_lock_acquire', args: { paths: ['src/a.js'] }, noCwd: true },

  'release/mixed': { tool: 'edit_lock_release', args: { paths: ['src/a.js', 'src/b.js'] }, answers: () => ({ request: { ok: true, released: [A], notOwned: [B] } }) },
  'release/nothing': { tool: 'edit_lock_release', args: { paths: ['src/a.js'] }, answers: () => ({ request: { ok: true, released: [], notOwned: [] } }) },
  'release/degraded': { tool: 'edit_lock_release', args: { paths: ['src/a.js'] }, answers: () => ({ request: transport }) },
  'release/invalid-args': { tool: 'edit_lock_release', args: { paths: [''] } },

  'hold/held': {
    tool: 'edit_lock_hold',
    args: { paths: ['src/a.js', 'src/b.js'], minutes: 30 },
    answers: () => ({ hold: { ok: true, held: [{ path: A, expiresAt: T0 + 1000, holdUntil: T0 + 30 * 60_000 }, { path: B, expiresAt: T0 + 5000, holdUntil: null }] } }),
  },
  'hold/nothing': { tool: 'edit_lock_hold', args: { paths: ['src/a.js'] }, answers: () => ({ hold: { ok: true, held: [] } }) },
  'hold/not-owned': { tool: 'edit_lock_hold', args: { paths: ['src/a.js'] }, answers: () => ({ hold: failure('not-owned') }) },
  'hold/degraded': { tool: 'edit_lock_hold', args: { paths: ['src/a.js'] }, answers: () => ({ hold: transport }) },
  'hold/invalid-minutes': { tool: 'edit_lock_hold', args: { paths: ['src/a.js'], minutes: -1 } },

  'try_steal/pending': {
    tool: 'edit_lock_try_steal',
    args: { file_path: 'src/a.js' },
    answers: () => ({ requestTransfer: { ok: true, requestId: 'req-1', holder: { ...OTHER }, expiresAt: T0 + 60_000 } }),
  },
  'try_steal/free': { tool: 'edit_lock_try_steal', args: { file_path: 'src/a.js' }, answers: () => ({ requestTransfer: failure('free') }) },
  'try_steal/self': { tool: 'edit_lock_try_steal', args: { file_path: 'src/a.js' }, answers: () => ({ requestTransfer: failure('self') }) },
  'try_steal/degraded': { tool: 'edit_lock_try_steal', args: { file_path: 'src/a.js' }, answers: () => ({ requestTransfer: transport }) },
  'try_steal/other-error': { tool: 'edit_lock_try_steal', args: { file_path: 'src/a.js' }, answers: () => ({ requestTransfer: failure('invalid-path') }) },
  'try_steal/invalid-args': { tool: 'edit_lock_try_steal', args: { file_path: '' } },

  'reply/transferred': { tool: REPLY_TOOL, args: { request_id: 'req-1', decision: 'release' }, answers: () => ({ reply: { ok: true, state: 'transferred' } }) },
  'reply/declined': { tool: REPLY_TOOL, args: { request_id: 'req-1', decision: 'keep' }, answers: () => ({ reply: { ok: true, state: 'declined' } }) },
  'reply/expired': { tool: REPLY_TOOL, args: { request_id: 'req-1', decision: 'release' }, answers: () => ({ reply: failure('expired') }) },
  'reply/stale': { tool: REPLY_TOOL, args: { request_id: 'req-1', decision: 'release' }, answers: () => ({ reply: failure('stale') }) },
  'reply/not-holder': { tool: REPLY_TOOL, args: { request_id: 'req-1', decision: 'keep' }, answers: () => ({ reply: failure('not-holder') }) },
  'reply/degraded': { tool: REPLY_TOOL, args: { request_id: 'req-1', decision: 'keep' }, answers: () => ({ reply: transport }) },
  'reply/invalid-decision': { tool: REPLY_TOOL, args: { request_id: 'req-1', decision: 'maybe' } },

  'status/full': {
    tool: 'edit_lock_status',
    args: {},
    answers: () => ({
      status: {
        ok: true,
        leases: [
          { path: A, owner: { ...OWNER }, scope: CWD, acquiredAt: T0, expiresAt: T0 + 87_000, holdUntil: null },
          { path: B, owner: { ...OWNER }, scope: CWD, acquiredAt: T0, expiresAt: T0, holdUntil: T0 + 20 * 60_000 },
          { path: `${CWD}/src/c.js`, owner: { ...OTHER }, scope: CWD, acquiredAt: T0, expiresAt: T0 + 42_000, holdUntil: null },
          { path: `${CWD}/src/d.js`, owner: { ...OTHER }, scope: CWD, acquiredAt: T0 - 9000, expiresAt: T0 - 1000, holdUntil: null },
        ],
      },
    }),
  },
  'status/empty': { tool: 'edit_lock_status', args: {}, answers: () => ({ status: { ok: true, leases: [] } }) },
  'status/degraded': { tool: 'edit_lock_status', args: {}, answers: () => ({ status: transport }) },

  'watch/watching': { tool: WATCH_TOOL, args: { file_path: 'src/a.js' }, answers: () => ({ status: heldByOther }) },
  'watch/free': { tool: WATCH_TOOL, args: { file_path: 'src/a.js' }, answers: () => ({ status: { ok: true, leases: [] } }) },
  'watch/self': {
    tool: WATCH_TOOL,
    args: { file_path: 'src/a.js' },
    answers: () => ({ status: { ok: true, leases: [{ path: A, owner: { ...OWNER }, scope: CWD, acquiredAt: T0, expiresAt: T0 + 1000, holdUntil: null }] } }),
  },
  'watch/unsupported': { tool: WATCH_TOOL, args: { file_path: 'src/a.js' }, answers: () => ({ status: heldByOther, supportsEvent: () => false }) },
  'watch/degraded': { tool: WATCH_TOOL, args: { file_path: 'src/a.js' }, answers: () => ({ status: transport }) },
  'watch/released': {
    tool: WATCH_TOOL,
    args: { file_path: 'src/a.js' },
    answers: (registry) => ({
      status: () => {
        registry.consumePath(A)
        return heldByOther()
      },
    }),
  },
  'watch/reset': {
    tool: WATCH_TOOL,
    args: { file_path: 'src/a.js' },
    answers: (registry) => ({
      status: () => {
        registry.resetAll()
        return heldByOther()
      },
    }),
  },
  'watch/cancelled': {
    tool: WATCH_TOOL,
    args: { file_path: 'src/a.js' },
    answers: (registry) => ({
      status: () => {
        registry.cancelSession(OWNER.session)
        return heldByOther()
      },
    }),
  },
  'watch/other-error': { tool: WATCH_TOOL, args: { file_path: 'src/a.js' }, answers: () => ({ status: failure('invalid-path') }) },
  'watch/invalid-args': { tool: WATCH_TOOL, args: {} },
}

/**
 * Run one case under the pinned clock and capture exactly what reaches the
 * model: the rendered parts, the structured result (as JSON, so key order and
 * every field count), any delivered notice, or the thrown message.
 * @param {string} name
 */
async function runCase(name) {
  const spec = CASES[name]
  const registry = createWatchCoordinator()
  /** @type {string[]} */
  const notices = []
  const definitions = createLeaseTools({
    client: createFakeClient(spec.answers?.(registry) ?? {}),
    ownerOf: () => OWNER,
    watchCoordinator: registry,
    deliverNotice: (/** @type {any} */ _agent, /** @type {string} */ text) => {
      notices.push(text)
    },
  })
  const definition = definitions.find((entry) => entry.name === spec.tool)
  const exec = { agent: agentFor(spec.noCwd !== true) }
  const realNow = Date.now
  Date.now = () => T0
  try {
    const value = await definition.execute(spec.args, exec)
    return { definition, value, observation: { kind: 'result', render: definition.output.render(spec.args, value), json: JSON.stringify(value), notices } }
  } catch (error) {
    return { definition, value: undefined, observation: { kind: 'throw', message: String(/** @type {any} */ (error)?.message ?? error), notices } }
  } finally {
    Date.now = realNow
  }
}

/** Recorded from the pre-change tools.js — never regenerate it from new code. */
const BASELINE = {
  "acquire/claimed": {"kind":"result","render":[{"type":"text","text":"Claimed 2 path(s) for this turn: src/a.js, src/b.js."}],"json":"{\"paths\":[\"src/a.js\",\"src/b.js\"],\"message\":\"Claimed 2 path(s) for this turn: src/a.js, src/b.js.\"}","notices":[]},
  "acquire/nothing": {"kind":"result","render":[{"type":"text","text":"Nothing was claimed."}],"json":"{\"paths\":[],\"message\":\"Nothing was claimed.\"}","notices":[]},
  "acquire/conflict": {"kind":"throw","message":"Refused: 1 of the requested path(s) are owned by another session.\n- src/a.js is held by \"reviewer\" (session sess-b) for about 42s more\nOwnership frees itself when its validity ends, so do not retry this edit blindly: the same call keeps being refused while the holder keeps the path.\nIf you need a path now, ask for it — call edit_lock_try_steal with that path and wait for the holder's answer (release transfers it, keep or silence leaves it where it is).","notices":[]},
  "acquire/degraded": {"kind":"result","render":[{"type":"text","text":"The ownership arbiter is unreachable (transport), so nothing was claimed. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work."}],"json":"{\"degraded\":true,\"code\":\"transport\",\"message\":\"The ownership arbiter is unreachable (transport), so nothing was claimed. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work.\"}","notices":[]},
  "acquire/other-error": {"kind":"throw","message":"lease broker refused: invalid-path","notices":[]},
  "acquire/invalid-args": {"kind":"throw","message":"paths must list at least one path","notices":[]},
  "acquire/no-cwd": {"kind":"throw","message":"the session working directory is unavailable, so paths cannot be resolved","notices":[]},
  "release/mixed": {"kind":"result","render":[{"type":"text","text":"Released 1 path(s): src/a.js.\nNot held by this session, so there was nothing to release: src/b.js."}],"json":"{\"released\":[\"src/a.js\"],\"notOwned\":[\"src/b.js\"],\"message\":\"Released 1 path(s): src/a.js.\\nNot held by this session, so there was nothing to release: src/b.js.\"}","notices":[]},
  "release/nothing": {"kind":"result","render":[{"type":"text","text":"Released nothing."}],"json":"{\"released\":[],\"notOwned\":[],\"message\":\"Released nothing.\"}","notices":[]},
  "release/degraded": {"kind":"result","render":[{"type":"text","text":"The ownership arbiter is unreachable (transport), so the release was not confirmed. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work."}],"json":"{\"degraded\":true,\"code\":\"transport\",\"message\":\"The ownership arbiter is unreachable (transport), so the release was not confirmed. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work.\"}","notices":[]},
  "release/invalid-args": {"kind":"throw","message":"every entry of paths must be a non-empty string","notices":[]},
  "hold/held": {"kind":"result","render":[{"type":"text","text":"Kept 2 path(s) past this turn: src/a.js until 2026-05-28T20:56:40.000Z (about 30m from now), src/b.js until 2026-05-28T20:26:45.000Z (about 1m from now). At most 60 minutes per request; a deadline that passes simply makes the paths available, and the expiry is announced only to a session that explicitly subscribed to that path with edit_lock_watch — a matching subscriber gets the usual chance to claim it again, while with no subscriber nothing is announced."}],"json":"{\"held\":[{\"path\":\"src/a.js\",\"holdUntil\":1780001800000},{\"path\":\"src/b.js\",\"holdUntil\":null}],\"message\":\"Kept 2 path(s) past this turn: src/a.js until 2026-05-28T20:56:40.000Z (about 30m from now), src/b.js until 2026-05-28T20:26:45.000Z (about 1m from now). At most 60 minutes per request; a deadline that passes simply makes the paths available, and the expiry is announced only to a session that explicitly subscribed to that path with edit_lock_watch — a matching subscriber gets the usual chance to claim it again, while with no subscriber nothing is announced.\"}","notices":[]},
  "hold/nothing": {"kind":"result","render":[{"type":"text","text":"Nothing was retained."}],"json":"{\"held\":[],\"message\":\"Nothing was retained.\"}","notices":[]},
  "hold/not-owned": {"kind":"throw","message":"This session does not own src/a.js. Retention only extends ownership that already exists — claim the paths with edit_lock_acquire first.","notices":[]},
  "hold/degraded": {"kind":"result","render":[{"type":"text","text":"The ownership arbiter is unreachable (transport), so no retention was recorded. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work."}],"json":"{\"degraded\":true,\"code\":\"transport\",\"message\":\"The ownership arbiter is unreachable (transport), so no retention was recorded. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work.\"}","notices":[]},
  "hold/invalid-minutes": {"kind":"throw","message":"minutes must be a positive number of minutes","notices":[]},
  "try_steal/pending": {"kind":"result","render":[{"type":"text","text":"Request req-1 for src/a.js is pending with \"reviewer\" (session sess-b). Do not modify src/a.js until ownership is granted — a pending request is not an approval, and edits keep being refused meanwhile. The holder answers with edit_lock_reply (release hands it over, keep keeps it); an unanswered request expires in about 60s and ownership stays where it is. A message will tell you how it settled."}],"json":"{\"state\":\"pending\",\"request_id\":\"req-1\",\"holder\":{\"label\":\"reviewer\",\"session\":\"sess-b\"},\"message\":\"Request req-1 for src/a.js is pending with \\\"reviewer\\\" (session sess-b). Do not modify src/a.js until ownership is granted — a pending request is not an approval, and edits keep being refused meanwhile. The holder answers with edit_lock_reply (release hands it over, keep keeps it); an unanswered request expires in about 60s and ownership stays where it is. A message will tell you how it settled.\"}","notices":[]},
  "try_steal/free": {"kind":"result","render":[{"type":"text","text":"Nobody holds src/a.js right now: edit it directly, or claim it with edit_lock_acquire so another session cannot take it mid-work."}],"json":"{\"state\":\"free\",\"message\":\"Nobody holds src/a.js right now: edit it directly, or claim it with edit_lock_acquire so another session cannot take it mid-work.\"}","notices":[]},
  "try_steal/self": {"kind":"result","render":[{"type":"text","text":"This session already owns src/a.js; no transfer is needed."}],"json":"{\"state\":\"self\",\"message\":\"This session already owns src/a.js; no transfer is needed.\"}","notices":[]},
  "try_steal/degraded": {"kind":"result","render":[{"type":"text","text":"The ownership arbiter is unreachable (transport), so no transfer request was created. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work."}],"json":"{\"degraded\":true,\"code\":\"transport\",\"message\":\"The ownership arbiter is unreachable (transport), so no transfer request was created. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work.\"}","notices":[]},
  "try_steal/other-error": {"kind":"throw","message":"lease broker refused: invalid-path","notices":[]},
  "try_steal/invalid-args": {"kind":"throw","message":"file_path must be a non-empty string","notices":[]},
  "reply/transferred": {"kind":"result","render":[{"type":"text","text":"Request req-1: transferred. The requester owns the path now; this session no longer holds it."}],"json":"{\"request_id\":\"req-1\",\"decision\":\"release\",\"state\":\"transferred\",\"message\":\"Request req-1: transferred. The requester owns the path now; this session no longer holds it.\"}","notices":["Ownership handed over: request req-1 is settled and this session no longer holds that path. Claim it again with edit_lock_acquire if you still need it."]},
  "reply/declined": {"kind":"result","render":[{"type":"text","text":"Request req-1: declined. Ownership is unchanged and the path is still this session's."}],"json":"{\"request_id\":\"req-1\",\"decision\":\"keep\",\"state\":\"declined\",\"message\":\"Request req-1: declined. Ownership is unchanged and the path is still this session's.\"}","notices":[]},
  "reply/expired": {"kind":"throw","message":"Request req-1 has expired and ownership is unchanged. The requester can ask again later if it still needs the path.","notices":[]},
  "reply/stale": {"kind":"throw","message":"Request req-1 is stale: ownership changed before the answer arrived, so nothing was transferred.","notices":[]},
  "reply/not-holder": {"kind":"throw","message":"Request req-1 is not addressed to this session; only the current holder can answer it.","notices":[]},
  "reply/degraded": {"kind":"result","render":[{"type":"text","text":"The ownership arbiter is unreachable (transport), so the answer was not delivered. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work."}],"json":"{\"degraded\":true,\"code\":\"transport\",\"message\":\"The ownership arbiter is unreachable (transport), so the answer was not delivered. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work.\"}","notices":[]},
  "reply/invalid-decision": {"kind":"throw","message":"decision must be \"release\" or \"keep\"","notices":[]},
  "status/full": {"kind":"result","render":[{"type":"text","text":"Held by this session (2):\n- src/a.js — valid for about 87s\n- src/b.js — retained until 2026-05-28T20:46:40.000Z\nHeld by other sessions here (2):\n- src/c.js — \"reviewer\" (session sess-b), about 42s left\n- src/d.js — \"reviewer\" (session sess-b), lapsed, claimable"}],"json":"{\"mine\":[\"src/a.js\",\"src/b.js\"],\"message\":\"Held by this session (2):\\n- src/a.js — valid for about 87s\\n- src/b.js — retained until 2026-05-28T20:46:40.000Z\\nHeld by other sessions here (2):\\n- src/c.js — \\\"reviewer\\\" (session sess-b), about 42s left\\n- src/d.js — \\\"reviewer\\\" (session sess-b), lapsed, claimable\"}","notices":[]},
  "status/empty": {"kind":"result","render":[{"type":"text","text":"This session holds nothing."}],"json":"{\"mine\":[],\"message\":\"This session holds nothing.\"}","notices":[]},
  "status/degraded": {"kind":"result","render":[{"type":"text","text":"The ownership arbiter is unreachable (transport), so no ownership could be read. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work."}],"json":"{\"degraded\":true,\"code\":\"transport\",\"message\":\"The ownership arbiter is unreachable (transport), so no ownership could be read. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work.\"}","notices":[]},
  "watch/watching": {"kind":"result","render":[{"type":"text","text":"Watching src/a.js for its next release; \"reviewer\" (session sess-b) holds it now. A release notice will arrive as a message: it means only that the path is free to compete for, so call edit_lock_acquire then. It is not an ownership grant and it reserves nothing — another waiting session may claim the path first, and the ordinary holder conflict applies."}],"json":"{\"state\":\"watching\",\"file_path\":\"src/a.js\",\"holder\":{\"label\":\"reviewer\",\"session\":\"sess-b\"},\"message\":\"Watching src/a.js for its next release; \\\"reviewer\\\" (session sess-b) holds it now. A release notice will arrive as a message: it means only that the path is free to compete for, so call edit_lock_acquire then. It is not an ownership grant and it reserves nothing — another waiting session may claim the path first, and the ordinary holder conflict applies.\"}","notices":[]},
  "watch/free": {"kind":"result","render":[{"type":"text","text":"Nobody holds src/a.js right now, so no release subscription was kept. Claim it with edit_lock_acquire (or just edit it) before working on it."}],"json":"{\"state\":\"free\",\"file_path\":\"src/a.js\",\"message\":\"Nobody holds src/a.js right now, so no release subscription was kept. Claim it with edit_lock_acquire (or just edit it) before working on it.\"}","notices":[]},
  "watch/self": {"kind":"result","render":[{"type":"text","text":"This session already owns src/a.js, so no release subscription was kept and there is nothing to wait for."}],"json":"{\"state\":\"self\",\"file_path\":\"src/a.js\",\"message\":\"This session already owns src/a.js, so no release subscription was kept and there is nothing to wait for.\"}","notices":[]},
  "watch/unsupported": {"kind":"result","render":[{"type":"text","text":"The connected arbiter does not announce release events (release-events-unsupported), so no release subscription was created for src/a.js. Only this subscription is unavailable: conflicts, managed edits and negotiation behave exactly as before, and this tool can be used again once the arbiter restarts with the capability."}],"json":"{\"degraded\":true,\"code\":\"release-events-unsupported\",\"message\":\"The connected arbiter does not announce release events (release-events-unsupported), so no release subscription was created for src/a.js. Only this subscription is unavailable: conflicts, managed edits and negotiation behave exactly as before, and this tool can be used again once the arbiter restarts with the capability.\"}","notices":[]},
  "watch/degraded": {"kind":"result","render":[{"type":"text","text":"The ownership arbiter is unreachable (transport), so no release subscription was created. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work."}],"json":"{\"degraded\":true,\"code\":\"transport\",\"message\":\"The ownership arbiter is unreachable (transport), so no release subscription was created. This is not a conflict: managed edits proceed without ownership while the arbiter is down, and nothing needs clearing afterwards. Continue with the work.\"}","notices":[]},
  "watch/released": {"kind":"result","render":[{"type":"text","text":"The release of src/a.js happened while this subscription was being established, so nothing is pending. Claim it with edit_lock_acquire if you still need it — a release is an opportunity, not an ownership grant."}],"json":"{\"state\":\"released\",\"file_path\":\"src/a.js\",\"message\":\"The release of src/a.js happened while this subscription was being established, so nothing is pending. Claim it with edit_lock_acquire if you still need it — a release is an opportunity, not an ownership grant.\"}","notices":[]},
  "watch/reset": {"kind":"result","render":[{"type":"text","text":"The ownership arbiter connection was reset while this subscription was being established, so nothing is pending and nothing is known about ownership. Re-check with edit_lock_status, and call edit_lock_watch again if src/a.js is still held by another session."}],"json":"{\"state\":\"reset\",\"file_path\":\"src/a.js\",\"message\":\"The ownership arbiter connection was reset while this subscription was being established, so nothing is pending and nothing is known about ownership. Re-check with edit_lock_status, and call edit_lock_watch again if src/a.js is still held by another session.\"}","notices":[]},
  "watch/cancelled": {"kind":"result","render":[{"type":"text","text":"The release subscription for src/a.js was cancelled before it could be established (this agent or the feature was shut down), so nothing is pending. Call edit_lock_watch again in a live agent if you still need the path."}],"json":"{\"degraded\":true,\"code\":\"watch-cancelled\",\"message\":\"The release subscription for src/a.js was cancelled before it could be established (this agent or the feature was shut down), so nothing is pending. Call edit_lock_watch again in a live agent if you still need the path.\"}","notices":[]},
  "watch/other-error": {"kind":"throw","message":"lease broker refused: invalid-path","notices":[]},
  "watch/invalid-args": {"kind":"throw","message":"file_path must be a non-empty string","notices":[]},
}

describe('edit-lock tools: the model-visible result is unchanged', () => {
  it('covers every recorded outcome and nothing else', () => {
    expect(Object.keys(BASELINE).sort()).toEqual(Object.keys(CASES).sort())
  })

  for (const name of Object.keys(CASES)) {
    it(`${name}: render text, structured result and notices match the baseline`, async () => {
      const { observation } = await runCase(name)
      expect(observation).toEqual(/** @type {any} */ (BASELINE)[name])
    })
  }
})

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

it('two identical concurrent answers each get their own filed entry', async () => {
  const args = CASES['try_steal/pending'].args
  // Drain what earlier tests filed without reading (the registry always reads).
  const drain = await runCase('try_steal/pending')
  while (drain.definition.output.presentationMeta(args, drain.value).editLock.expiresAt !== undefined) { /* drain */ }
  const first = await runCase('try_steal/pending')
  const second = await runCase('try_steal/pending')
  expect(first.observation.json).toBe(second.observation.json)
  expect(first.definition.output.presentationMeta(args, structuredClone(first.value)).editLock.expiresAt).toBe(T0 + 60_000)
  expect(second.definition.output.presentationMeta(args, structuredClone(second.value)).editLock.expiresAt).toBe(T0 + 60_000)
  // both entries are taken: a third read only has the result's own fields
  expect(second.definition.output.presentationMeta(args, structuredClone(second.value)).editLock.expiresAt).toBe(undefined)
})

const meta = (/** @type {string} */ tool, /** @type {Record<string, any>} */ fields) => ({ editLock: { v: LEASE_META_VERSION, tool, ...fields } })

/** What the cards receive for every non-throwing outcome (design D1 table). */
const EXPECTED_META = {
  'acquire/claimed': meta('edit_lock_acquire', { state: 'claimed', paths: ['src/a.js', 'src/b.js'] }),
  'acquire/nothing': meta('edit_lock_acquire', { state: 'claimed', paths: [] }),
  'acquire/degraded': meta('edit_lock_acquire', { state: 'degraded', code: 'transport', paths: ['src/a.js'] }),
  'release/mixed': meta('edit_lock_release', { state: 'released', released: ['src/a.js'], notOwned: ['src/b.js'] }),
  'release/nothing': meta('edit_lock_release', { state: 'released', released: [], notOwned: [] }),
  'release/degraded': meta('edit_lock_release', { state: 'degraded', code: 'transport', paths: ['src/a.js'] }),
  // The deadline the message names: holdUntil, else the plain validity.
  'hold/held': meta('edit_lock_hold', { state: 'held', held: [{ path: 'src/a.js', holdUntil: T0 + 30 * 60_000 }, { path: 'src/b.js', holdUntil: T0 + 5000 }] }),
  'hold/nothing': meta('edit_lock_hold', { state: 'held', held: [] }),
  'hold/degraded': meta('edit_lock_hold', { state: 'degraded', code: 'transport', paths: ['src/a.js'] }),
  'try_steal/pending': meta('edit_lock_try_steal', { state: 'pending', path: 'src/a.js', requestId: 'req-1', holder: { label: 'reviewer', session: 'sess-b' }, expiresAt: T0 + 60_000 }),
  'try_steal/free': meta('edit_lock_try_steal', { state: 'free', path: 'src/a.js' }),
  'try_steal/self': meta('edit_lock_try_steal', { state: 'self', path: 'src/a.js' }),
  'try_steal/degraded': meta('edit_lock_try_steal', { state: 'degraded', code: 'transport', path: 'src/a.js' }),
  'reply/transferred': meta(REPLY_TOOL, { state: 'transferred', requestId: 'req-1', decision: 'release' }),
  'reply/declined': meta(REPLY_TOOL, { state: 'declined', requestId: 'req-1', decision: 'keep' }),
  'reply/degraded': meta(REPLY_TOOL, { state: 'degraded', code: 'transport', requestId: 'req-1', decision: 'keep' }),
  'status/full': meta('edit_lock_status', {
    state: 'status',
    at: T0,
    mine: [{ path: 'src/a.js', until: T0 + 87_000, retained: false }, { path: 'src/b.js', until: T0 + 20 * 60_000, retained: true }],
    others: [
      { path: 'src/c.js', label: 'reviewer', session: 'sess-b', until: T0 + 42_000, lapsed: false },
      { path: 'src/d.js', label: 'reviewer', session: 'sess-b', until: T0 - 1000, lapsed: true },
    ],
  }),
  'status/empty': meta('edit_lock_status', { state: 'status', at: T0, mine: [], others: [] }),
  'status/degraded': meta('edit_lock_status', { state: 'degraded', code: 'transport' }),
  'watch/watching': meta(WATCH_TOOL, { state: 'watching', path: 'src/a.js', holder: { label: 'reviewer', session: 'sess-b' } }),
  'watch/free': meta(WATCH_TOOL, { state: 'free', path: 'src/a.js' }),
  'watch/self': meta(WATCH_TOOL, { state: 'self', path: 'src/a.js' }),
  'watch/unsupported': meta(WATCH_TOOL, { state: 'unsupported', code: 'release-events-unsupported', path: 'src/a.js' }),
  'watch/degraded': meta(WATCH_TOOL, { state: 'degraded', code: 'transport', path: 'src/a.js' }),
  'watch/released': meta(WATCH_TOOL, { state: 'released', path: 'src/a.js' }),
  'watch/reset': meta(WATCH_TOOL, { state: 'reset', path: 'src/a.js' }),
  'watch/cancelled': meta(WATCH_TOOL, { state: 'cancelled', code: 'watch-cancelled', path: 'src/a.js' }),
}

describe('edit-lock tools: presentation metadata for the conversation cards', () => {
  const throwing = Object.keys(BASELINE).filter((name) => /** @type {any} */ (BASELINE)[name].kind === 'throw')

  it('pins metadata for exactly the outcomes that return a value', () => {
    expect([...Object.keys(EXPECTED_META), ...throwing].sort()).toEqual(Object.keys(CASES).sort())
  })

  it('covers every state of every tool, and only the closed state set', () => {
    const seen = new Map()
    for (const expected of Object.values(EXPECTED_META)) {
      const { tool, state } = expected.editLock
      expect(LEASE_META_STATES[tool], `${tool} has a closed state set`).toBeTruthy()
      expect(LEASE_META_STATES[tool].includes(state), `${tool}/${state} is in the closed set`).toBe(true)
      seen.set(tool, [...(seen.get(tool) ?? []), state])
    }
    for (const [tool, states] of Object.entries(LEASE_META_STATES)) {
      expect([...new Set(seen.get(tool))].sort(), `${tool} states covered`).toEqual([...states].sort())
    }
  })

  for (const name of Object.keys(EXPECTED_META)) {
    it(`${name}: presentationMeta carries the card data, read from the registry's frozen copy`, async () => {
      const { definition, value } = await runCase(name)
      // The tool registry hands render/presentationMeta a lossless-JSON
      // snapshot of the value, deep-frozen — never the object execute returned.
      const presented = definition.output.presentationMeta(CASES[name].args, deepFreeze(structuredClone(value)))
      expect(presented).toEqual(/** @type {any} */ (EXPECTED_META)[name])
      // Short names only: an absolute path never reaches the persisted meta.
      expect(JSON.stringify(presented)).not.toContain(CWD)
    })

    it(`${name}: with no filed entry the result still yields its own-field subset`, async () => {
      const { definition, value } = await runCase(name)
      definition.output.presentationMeta(CASES[name].args, value) // takes the one filed entry
      const fallback = definition.output.presentationMeta(CASES[name].args, value)
      const expected = /** @type {any} */ (EXPECTED_META)[name].editLock
      expect(fallback.editLock.v).toBe(LEASE_META_VERSION)
      expect(fallback.editLock.tool).toBe(expected.tool)
      expect(fallback.editLock.state).toBe(expected.state)
      expect(JSON.stringify(fallback)).not.toContain(CWD)
    })
  }

  it('throw paths stay throws: no value, so the card falls back to the call arguments', async () => {
    for (const name of throwing) {
      const { value, observation } = await runCase(name)
      expect(value, name).toBe(undefined)
      expect(observation.kind, name).toBe('throw')
    }
  })

  it('declines a value it cannot describe instead of inventing a state', () => {
    const definitions = createLeaseTools({ client: createFakeClient({}), ownerOf: () => OWNER })
    const watch = definitions.find((entry) => entry.name === WATCH_TOOL)
    const steal = definitions.find((entry) => entry.name === 'edit_lock_try_steal')
    // null, not undefined: the registry rejects a non-JSON projection.
    expect(watch.output.presentationMeta({}, null)).toBe(null)
    expect(watch.output.presentationMeta({}, 'text')).toBe(null)
    expect(watch.output.presentationMeta({}, { state: 'mystery', message: 'x' })).toBe(null)
    expect(steal.output.presentationMeta({}, { state: 'granted', message: 'x' })).toBe(null)
  })

  it('every tool declares the same output contract: object schema, message-only render, presentationMeta', () => {
    const definitions = createLeaseTools({ client: createFakeClient({}), ownerOf: () => OWNER })
    expect(definitions).toHaveLength(7)
    for (const definition of definitions) {
      expect(definition.output.schema).toEqual({ type: 'object' })
      expect(definition.output.render({}, { message: 'm', extra: 'never rendered' })).toEqual([{ type: 'text', text: 'm' }])
      expect(typeof definition.output.presentationMeta).toBe('function')
    }
  })
})
