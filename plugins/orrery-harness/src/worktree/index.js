// Orrery worktree-lanes plugin: wires the lane service to the runtime —
// tools, the /worktree command, the session projection, the standing prompt
// section + live board, the read-only panel endpoints, and the
// `orreryWorktreeLanes` service the delegate plugin consumes (binding, lane
// guards, settlement, Worktree mode). Plain ESM, ctx-only (no static
// @deepseek-ai imports). The service is a preset service, so the row sits in
// the `delegation` group with `orreryWorktreeLanes` isolated (S24 / S26 S-A).
import { join } from 'node:path'
import { AUDIT_TYPES, createAudit } from '../shared/audit.js'
import { userTextMessage } from '../shared/user-message.js'
import { DOCTRINE_SECTION_ORDER } from '../core/doctrine.js'
import { isDelegatedChild } from '../shared/child-scope.js'
import { createGit } from './git.js'
import { createGitRunner, createSetupResolver, createShellRunner } from './runner.js'
import { createLaneService } from './lanes.js'
import { createWorktreeTools } from './tools.js'
import { createWorktreeCommand } from './command.js'
import { DEFAULT_ROOT } from './rules.js'
import { LANES_CONTEXT_NAME, LANES_CONTEXT_ORDER, LANES_SECTION_NAME, LANES_SECTION_TEXT, LANES_VARIABLE_NAME } from './prompts.js'
import { DEFAULT_WATCH_TIMEOUT_MINUTES } from './watches.js'
import { APPROVE_MODES, WORKTREE_PROJECTION_KEY, foldWorktreeState, initialWorktreeState, worktreeStateSchema, worktreeView, worktreeViewSchema } from './projection.js'
import { readAuditTail, readChildFinalText } from '../delegate/audit-readers.js'
import { isTerminalStatus, parseTerminalStatus } from '../delegate/group-coordinator.js'

const name = 'orrery-worktree'
// subprocess is a host-plane service every composition mounts; it is a hard
// dependency (ctx.get cannot see it from a preset row — S20). shell and
// sandboxPolicy are optional and captured through ctx.inject below.
const inject = ['tools', 'systemPrompt', 'subprocess']

export const WORKTREE_SERVICE = 'orreryWorktreeLanes'
export const LANES_SECTION_ORDER_OFFSET = 20
export const DEFAULTS = Object.freeze({ enabled: true, root: DEFAULT_ROOT, maxActive: 4, autoSetup: true, watchTimeoutMinutes: DEFAULT_WATCH_TIMEOUT_MINUTES })

/**
 * The single resolver for the effective auto-approve mode (design D2): a
 * valid session override wins, then a valid global setting, then the module
 * default `auto-clean`. Pure — the wiring below feeds it the two raw reads.
 * @param {string | null | undefined} sessionApprove - the projection's `approve` (null = no session override)
 * @param {string | null | undefined} globalApprove - orrerySettings worktree.autoApprove
 * @returns {'manual' | 'auto-keep' | 'auto-clean'}
 */
export function resolveApproveMode(sessionApprove, globalApprove) {
  if (APPROVE_MODES.includes(sessionApprove)) return sessionApprove
  if (APPROVE_MODES.includes(globalApprove)) return globalApprove
  return 'auto-clean'
}

/**
 * Effective settings: module defaults ← row config ← orrerySettings section,
 * re-read at every use so a volatile commit applies to the next operation.
 * @param {any} config @param {any} section
 */
export function worktreeSettings(config, section) {
  const pick = (/** @type {keyof typeof DEFAULTS} */ key) => section?.[key] ?? config?.[key] ?? DEFAULTS[key]
  const maxActive = Number(pick('maxActive'))
  const watchTimeoutMinutes = Number(pick('watchTimeoutMinutes'))
  return {
    enabled: pick('enabled') !== false,
    root: String(pick('root')),
    maxActive: Number.isFinite(maxActive) && maxActive >= 1 ? Math.floor(maxActive) : DEFAULTS.maxActive,
    autoSetup: pick('autoSetup') !== false,
    // Frozen into each watch's expiresAt at subscribe time; an online edit
    // applies to the NEXT watch, never retroactively (design D7).
    watchTimeoutMinutes: Number.isFinite(watchTimeoutMinutes) && watchTimeoutMinutes >= 1 ? Math.floor(watchTimeoutMinutes) : DEFAULTS.watchTimeoutMinutes,
  }
}

/** @param {any} ctx @param {any} [config] */
function apply(ctx, config = {}) {
  const audit = createAudit(ctx)
  const settings = ctx.get?.('orrerySettings')
  const settingsNow = () => worktreeSettings(config, settings?.get?.('worktree'))
  const projections = ctx.get?.('sessionProjections')
  // The auto-approve reads (design D2): the projection cell on the same
  // live/cold path as `modeOf`, the volatile global setting re-read on every
  // use. A throwing projection registry (pseudo cold sessions) resolves as
  // "no override" — the global default still answers.
  /** @param {any} session @returns {string | null | undefined} */
  const sessionApproveOf = (session) => {
    try {
      return projections?.stateOf?.(session, WORKTREE_PROJECTION_KEY)?.approve
    } catch {
      return undefined
    }
  }
  /** The resolved global default (never a raw invalid value). */
  const globalApprove = () => resolveApproveMode(undefined, settings?.get?.('worktree')?.autoApprove)
  /** GUI language last reported by the browser per session (decision-card copy). @type {Map<string, string>} */
  const locales = new Map()
  /** Optional executors, captured when (and if) they mount. @type {{ shell?: any, sandboxPolicy?: any }} */
  const shellRef = {}
  ctx.inject?.(['shell'], (/** @type {any} */ scope) => {
    shellRef.shell = scope.shell
    return () => { shellRef.shell = undefined }
  })
  ctx.inject?.(['sandboxPolicy'], (/** @type {any} */ scope) => {
    shellRef.sandboxPolicy = scope.sandboxPolicy
    return () => { shellRef.sandboxPolicy = undefined }
  })

  const service = createLaneService({
    git: createGit(createGitRunner(ctx.subprocess ?? ctx.get?.('subprocess') ?? missingSubprocess())),
    resolveSetup: createSetupResolver({ subprocess: ctx.subprocess ?? ctx.get?.('subprocess') ?? missingSubprocess() }),
    shellRun: (request) => {
      const run = createShellRunner(shellRef.shell ?? ctx.get?.('shell'), shellRef.sandboxPolicy ?? ctx.get?.('sandboxPolicy'))
      if (!run) return Promise.reject(new Error('no shell executor is available in this composition'))
      return run(request)
    },
    settings: settingsNow,
    ask: createAsk(ctx),
    notify: (sessionId, text) => deliver(ctx, audit, sessionId, text),
    audit: (kind, data, root, sessionId) => audit({ id: sessionId ?? null, header: { cwd: root } }, `${AUDIT_TYPES.worktree}/${kind}`, data, { root }),
    modeOf: (session) => projections?.stateOf?.(session, WORKTREE_PROJECTION_KEY)?.mode === true,
    approveModeOf: (session) => resolveApproveMode(sessionApproveOf(session), globalApprove()),
    approveModeSourceOf: (session) => (APPROVE_MODES.includes(sessionApproveOf(session)) ? 'session' : 'global'),
    approveGlobal: globalApprove,
    localeOf: (sessionId) => (sessionId ? locales.get(sessionId) : undefined) ?? locales.get('*'),
    bindingLiveness: createBindingLiveness(ctx),
    logger: ctx.logger,
  })
  // Service API for the delegate plugin (same realm; see the row comment).
  ctx.reflect?.provide?.(WORKTREE_SERVICE, {
    enabled: () => settingsNow().enabled,
    modeOf: (/** @type {any} */ session) => settingsNow().enabled && projections?.stateOf?.(session, WORKTREE_PROJECTION_KEY)?.mode === true,
    approveModeOf: (/** @type {any} */ session) => resolveApproveMode(sessionApproveOf(session), globalApprove()),
    approveModeSourceOf: (/** @type {any} */ session) => (APPROVE_MODES.includes(sessionApproveOf(session)) ? 'session' : 'global'),
    prepareBind: service.prepareBind,
    childSettled: service.childSettled,
    resolveArgPath: service.resolveArgPath,
  })

  // The projection is registered unconditionally: it only folds existing
  // events, and keeping it stable keeps the client marker correct across a
  // gate flip.
  const offProjection = projections?.register?.({
    key: WORKTREE_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: worktreeStateSchema,
    init: initialWorktreeState,
    apply: foldWorktreeState,
    wire: { viewSchema: worktreeViewSchema, view: worktreeView },
  })

  /** @type {null | { dispose: () => void }} */
  let surface = null
  function setupSurface() {
    if (surface) return
    /** @type {Array<() => void>} */
    const disposers = []
    for (const tool of createWorktreeTools(service)) disposers.push(ctx.tools.register(tool))
    // The lanes section and the live board are orchestrator-facing: a
    // delegated child renders '' for both (a lane-bound child already receives
    // the lane contract in its delegation prompt, so it loses nothing). Main
    // agents render both byte-identically; isDelegatedChild fails open to
    // them. The section's suppression rides a variable provider (static bare
    // reference text — a function-valued section text proved fragile in this
    // runtime); the live board keeps the context-text function this
    // registration always used, now guarded.
    disposers.push(ctx.systemPrompt.section({ name: LANES_SECTION_NAME, order: DOCTRINE_SECTION_ORDER + LANES_SECTION_ORDER_OFFSET, text: `{{${LANES_VARIABLE_NAME}}}` }))
    disposers.push(ctx.systemPrompt.variable(LANES_VARIABLE_NAME, (/** @type {any} */ context) => (isDelegatedChild(context) ? '' : LANES_SECTION_TEXT)))
    if (ctx.systemPrompt.context) {
      disposers.push(ctx.systemPrompt.context({ name: LANES_CONTEXT_NAME, order: LANES_CONTEXT_ORDER, text: (/** @type {any} */ context) => (isDelegatedChild(context) ? '' : service.board(context?.agent?.session)) }))
    }
    const commands = ctx.get?.('commands')
    if (commands?.register) {
      disposers.push(commands.register(createWorktreeCommand(service, {
        modeAvailable: async (/** @type {any} */ session) => {
          try {
            await service.repoFor(session?.header?.cwd)
            return null
          } catch (error) {
            return /** @type {any} */ (error)?.reason ?? /** @type {any} */ (error)?.message ?? String(error)
          }
        },
      })))
    }
    surface = { dispose: () => disposers.forEach((dispose) => dispose?.()) }
  }
  function applyGate() {
    if (settingsNow().enabled) setupSurface()
    else {
      surface?.dispose()
      surface = null
    }
  }
  const offSettings = settings?.onChange?.(applyGate)
  applyGate()

  // Read-only panel endpoints (S26 S-B): never written to the session log.
  /** @type {() => void} */
  let offEndpoints = () => {}
  ctx.inject?.(['connection'], (/** @type {any} */ scope) => {
    const fetchRegistry = scope.connection?.fetch
    if (!fetchRegistry?.register) return
    const reply = (/** @type {any} */ payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    const sessionOf = async (/** @type {any} */ request) => {
      let body
      try {
        body = await request.json()
      } catch {
        body = null
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      if (typeof body?.locale === 'string' && /^[a-z]{2}(?:-[A-Za-z0-9-]+)?$/.test(body.locale)) {
        if (sessionId) locales.set(sessionId, body.locale)
        // The latest GUI language also covers sessions the panel never polled.
        locales.set('*', body.locale)
      }
      // Live first: an agent's session, else an attached session with no
      // agent (still a real Session with live projection cells).
      const live = sessionId ? ctx.get?.('agents')?.get?.(sessionId)?.session ?? ctx.get?.('sessions')?.get?.(sessionId) : undefined
      if (live) return { body, session: live, cold: undefined, sessionId }
      // Cold fallback: DSH GUI session reads are cold-safe (page/follow/
      // projections) and never activate an agent, so after a restart a viewed
      // session has no live agent and the panel would stay SESSION_NOT_LIVE
      // until a remount. The lane ledger is repo-level: the read-only
      // endpoints need only header.cwd, the session id, and the cold-folded
      // mode projection — all carried by a sessionQuery observation, without
      // making the session live. Any failure (unknown session included) falls
      // through to the degraded replies below. The lease is disposed by the
      // endpoint's finally.
      let observation
      try {
        observation = sessionId ? await ctx.get?.('sessionQuery')?.observeSession?.(sessionId) : undefined
      } catch {
        observation = undefined
      }
      if (!observation) return { body, session: undefined, cold: undefined, sessionId }
      const coldState = observation.projections?.values?.[WORKTREE_PROJECTION_KEY]
      return {
        body,
        session: { id: sessionId, header: observation.header },
        cold: {
          observation,
          mode: coldState?.mode === true,
          approve: APPROVE_MODES.includes(coldState?.approve) ? coldState.approve : null,
          approveSource: APPROVE_MODES.includes(coldState?.approve) ? 'session' : 'global',
        },
        sessionId,
      }
    }
    const offView = fetchRegistry.register({
      path: '/api/orrery-worktree/view',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (/** @type {any} */ request) => {
        const { session, sessionId, cold } = await sessionOf(request)
        try {
          if (!sessionId) return reply({ ok: false, error: { code: 'orrery-worktree/invalid', message: 'body needs { sessionId }' } }, 400)
          // Degraded shapes carry the same array fields as the full view so the
          // panel's narrowing and summaries never see a lanes-less object.
          if (!settingsNow().enabled) return reply({ ok: true, value: { available: false, enabled: false, mode: false, approveMode: globalApprove(), approveModeSource: 'global', lanes: [], ownedBySession: [], unmanaged: [], repo: null, error: { code: 'WORKTREE_DISABLED', message: 'worktree lanes are disabled' } } })
          if (!session) return reply({ ok: true, value: { available: false, enabled: true, mode: false, approveMode: globalApprove(), approveModeSource: 'global', lanes: [], ownedBySession: [], unmanaged: [], repo: null, error: { code: 'SESSION_NOT_LIVE', message: 'open the session to load its lanes' } } })
          // A cold pseudo session drives the same view with the cold-folded
          // mode override; a live session keeps the exact current behavior.
          return reply({ ok: true, value: { enabled: true, ...(await service.view(session, cold ? { mode: cold.mode, approve: cold.approve, approveSource: cold.approveSource } : undefined)) } })
        } finally {
          cold?.observation?.[Symbol.dispose]?.()
        }
      },
    })
    const offDiff = fetchRegistry.register({
      path: '/api/orrery-worktree/diff',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (/** @type {any} */ request) => {
        const { body, session, cold } = await sessionOf(request)
        try {
          if (!session || typeof body?.lane !== 'string') return reply({ ok: false, error: { code: 'orrery-worktree/invalid', message: 'body needs { sessionId, lane } of a live session' } }, 400)
          try {
            return reply({ ok: true, value: { lane: body.lane, diff: await service.diffOf(session, body.lane) } })
          } catch (error) {
            return reply({ ok: false, error: { code: /** @type {any} */ (error)?.code ?? 'orrery-worktree/internal', message: /** @type {any} */ (error)?.reason ?? /** @type {any} */ (error)?.message ?? String(error) } }, 500)
          }
        } finally {
          cold?.observation?.[Symbol.dispose]?.()
        }
      },
    })
    offEndpoints = () => {
      offView?.()
      offDiff?.()
    }
    return offEndpoints
  })

  return () => {
    offSettings?.()
    offProjection?.()
    offEndpoints()
    surface?.dispose()
    surface = null
  }
}

/** Decision cards whose arrival raises a system notification (consumed by
 * orrery-notify's `worktree/question` listener). THE whitelist decision point:
 * a card id not listed here — including any future one — defaults to NOT
 * notifying. `cleanup` is deliberately absent: it always immediately follows
 * the merge approval the user just answered, or a user-typed /worktree land. */
const NOTIFY_CARD_IDS = new Set(['merge', 'abandon'])

/**
 * The lane service's ask funnel: resolve the userQuestions service, side-emit
 * the notification event for whitelisted decision cards, then ask. Split from
 * `apply` so unit tests can drive it with a mock ctx.
 * @param {any} ctx
 */
export function createAsk(ctx) {
  /** @param {any} agent @param {any[]} questions @param {AbortSignal} [signal] */
  return (agent, questions, signal) => {
    const userQuestions = ctx.get?.('userQuestions')
    if (!userQuestions?.ask) return Promise.reject(Object.assign(new Error('no user-questions service'), { code: 'NO_PROVIDER' }))
    if (NOTIFY_CARD_IDS.has(questions?.[0]?.id)) {
      // Pure notification: the event lives on the cordis bus only (never the
      // session log), and a listener failure must never break the ask.
      try {
        ctx.emit('worktree/question', agent?.session, { question: questions[0].question })
      } catch (/** @type {any} */ error) {
        ctx.logger?.warn?.(`worktree: question notify emit failed: ${error?.message ?? error}`)
      }
    }
    return userQuestions.ask({ questions, agent, ...(signal ? { signal } : {}) })
  }
}
/**
 * Read-only liveness probe for a suspected-zombie lane binding
 * (worktree-zombie-lane-reclamation D2). Live evidence is the single-process
 * agents registry (a miss proves offline, never dead); terminal evidence is
 * ironclad only — a terminate fact or a completed/terminated settle fact in
 * the audit tail, or a STATUS: completed report as the child's final word
 * (blocked never counts: a blocked member stands by for resume). Any
 * ambiguity keeps the LANE_BUSY refusal standing (064: offline is not dead).
 * Exported for tests.
 * @param {any} ctx
 */
export function createBindingLiveness(ctx) {
  /**
   * @param {string} boundChild @param {string | null} ownerSession
   * @param {{ root: string }} context - the lane repository's main root (audit anchor)
   * @returns {Promise<{ childAlive: boolean, ownerAlive: boolean, terminalEvidence: { source: string, detail: string } | null }>}
   */
  return async (boundChild, ownerSession, context) => {
    const agents = ctx.get?.('agents')
    const childAlive = typeof boundChild === 'string' && boundChild.length > 0 && agents?.get?.(boundChild) != null
    const ownerAlive = typeof ownerSession === 'string' && ownerSession.length > 0 && agents?.get?.(ownerSession) != null
    /** @type {{ source: string, detail: string } | null} */
    let terminalEvidence = null
    if (!childAlive && typeof boundChild === 'string' && boundChild.length > 0) {
      // Ironclad (a): a TERMINAL supervision fact in the audit tail (bounded
      // 256KB window — an aged-out fact degrades to "no evidence", never to a
      // wrong release; the card's force-reclaim is the escape). Terminal means
      // a terminate fact, or a settle fact whose status is completed or
      // terminated (resumable-lane-workers D6): a blocked settle is a
      // stand-by, not a death certificate — the member may still be resumed.
      const records = readAuditTail(join(context.root, '.orrery', 'audit.jsonl'))
      const fact = records.find((record) =>
        (record?.type === 'orrery/supervision/terminate'
          || (record?.type === 'orrery/supervision/settle' && isTerminalStatus(record?.data?.status)))
        && record?.data?.childId === boundChild)
      if (fact) {
        terminalEvidence = { source: 'audit', detail: `${fact.type} (childId ${boundChild})` }
      } else {
        // Ironclad (b): a STATUS: completed report as the child's final word
        // (blocked is, again, not terminal).
        const sessionQuery = ctx.get?.('sessionQuery')
        if (sessionQuery?.readSession) {
          try {
            const terminal = parseTerminalStatus(await readChildFinalText(sessionQuery, boundChild))
            if (terminal?.status === 'completed') terminalEvidence = { source: 'session-log', detail: `terminal STATUS: ${terminal.status}` }
          } catch {
            // an unreadable child log is no evidence — the refusal stands
          }
        }
      }
    }
    return { childAlive, ownerAlive, terminalEvidence }
  }
}

/** A subprocess stand-in that fails every git call with a clear reason. */
function missingSubprocess() {
  return {
    resolveExecutable: async () => undefined,
    spawn: () => {
      throw new Error('no subprocess service in this composition')
    },
  }
}

/**
 * Deliver a lane notice to the owning main agent: timer-deferred (never from
 * inside an event dispatch), steer while it works, followup wake when idle;
 * bounded retry, final failure audited.
 * @param {any} ctx @param {any} audit @param {string} sessionId @param {string} text
 */
function deliver(ctx, audit, sessionId, text) {
  const agent = ctx.get?.('agents')?.get?.(sessionId)
  if (!agent) return
  const message = userTextMessage(text, 'orrery-worktree')
  const attempt = (/** @type {number} */ count) => {
    const timer = setTimeout(() => {
      let outcome
      try {
        outcome = agent.status === 'idle' ? agent.followup(message) : agent.steer(message)
      } catch (error) {
        outcome = Promise.reject(error)
      }
      Promise.resolve(outcome).catch((error) => {
        if (count < 3) attempt(count + 1)
        else audit(agent.session, AUDIT_TYPES.worktree, { note: `lane notice delivery failed: ${String(error?.message ?? error)}` })
      })
    }, count === 1 ? 0 : 200 * (count - 1))
    timer.unref?.()
  }
  attempt(1)
}

export { name, inject, apply }
