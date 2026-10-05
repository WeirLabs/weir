// Orrery worktree-lanes plugin: wires the lane service to the runtime —
// tools, the /worktree command, the session projection, the standing prompt
// section + live board, the read-only panel endpoints, and the
// `orreryWorktreeLanes` service the delegate plugin consumes (binding, lane
// guards, settlement, Worktree mode). Plain ESM, ctx-only (no static
// @deepseek-ai imports). The service is a preset service, so the row sits in
// the `delegation` group with `orreryWorktreeLanes` isolated (S24 / S26 S-A).
import { AUDIT_TYPES, createAudit } from '../shared/audit.js'
import { userTextMessage } from '../shared/user-message.js'
import { DOCTRINE_SECTION_ORDER } from '../core/doctrine.js'
import { createGit } from './git.js'
import { createGitRunner, createSetupResolver, createShellRunner } from './runner.js'
import { createLaneService } from './lanes.js'
import { createWorktreeTools } from './tools.js'
import { createWorktreeCommand } from './command.js'
import { DEFAULT_ROOT } from './rules.js'
import { LANES_CONTEXT_NAME, LANES_CONTEXT_ORDER, LANES_SECTION_NAME, LANES_SECTION_TEXT } from './prompts.js'
import { DEFAULT_WATCH_TIMEOUT_MINUTES } from './watches.js'
import { WORKTREE_PROJECTION_KEY, foldWorktreeState, initialWorktreeState, worktreeStateSchema, worktreeView, worktreeViewSchema } from './projection.js'

const name = 'orrery-worktree'
// subprocess is a host-plane service every composition mounts; it is a hard
// dependency (ctx.get cannot see it from a preset row — S20). shell and
// sandboxPolicy are optional and captured through ctx.inject below.
const inject = ['tools', 'systemPrompt', 'subprocess']

export const WORKTREE_SERVICE = 'orreryWorktreeLanes'
export const LANES_SECTION_ORDER_OFFSET = 20
export const DEFAULTS = Object.freeze({ enabled: true, root: DEFAULT_ROOT, maxActive: 4, autoSetup: true, watchTimeoutMinutes: DEFAULT_WATCH_TIMEOUT_MINUTES })

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
    localeOf: (sessionId) => (sessionId ? locales.get(sessionId) : undefined) ?? locales.get('*'),
    logger: ctx.logger,
  })
  // Service API for the delegate plugin (same realm; see the row comment).
  ctx.reflect?.provide?.(WORKTREE_SERVICE, {
    enabled: () => settingsNow().enabled,
    modeOf: (/** @type {any} */ session) => settingsNow().enabled && projections?.stateOf?.(session, WORKTREE_PROJECTION_KEY)?.mode === true,
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
    disposers.push(ctx.systemPrompt.section({ name: LANES_SECTION_NAME, order: DOCTRINE_SECTION_ORDER + LANES_SECTION_ORDER_OFFSET, text: LANES_SECTION_TEXT }))
    if (ctx.systemPrompt.context) {
      disposers.push(ctx.systemPrompt.context({ name: LANES_CONTEXT_NAME, order: LANES_CONTEXT_ORDER, text: (/** @type {any} */ context) => service.board(context?.agent?.session) }))
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
      return { body, session: sessionId ? ctx.get?.('agents')?.get?.(sessionId)?.session : undefined, sessionId }
    }
    const offView = fetchRegistry.register({
      path: '/api/orrery-worktree/view',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (/** @type {any} */ request) => {
        const { session, sessionId } = await sessionOf(request)
        if (!sessionId) return reply({ ok: false, error: { code: 'orrery-worktree/invalid', message: 'body needs { sessionId }' } }, 400)
        // Degraded shapes carry the same array fields as the full view so the
        // panel's narrowing and summaries never see a lanes-less object.
        if (!settingsNow().enabled) return reply({ ok: true, value: { available: false, enabled: false, mode: false, lanes: [], ownedBySession: [], unmanaged: [], repo: null, error: { code: 'WORKTREE_DISABLED', message: 'worktree lanes are disabled' } } })
        if (!session) return reply({ ok: true, value: { available: false, enabled: true, mode: false, lanes: [], ownedBySession: [], unmanaged: [], repo: null, error: { code: 'SESSION_NOT_LIVE', message: 'open the session to load its lanes' } } })
        return reply({ ok: true, value: { enabled: true, ...(await service.view(session)) } })
      },
    })
    const offDiff = fetchRegistry.register({
      path: '/api/orrery-worktree/diff',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (/** @type {any} */ request) => {
        const { body, session } = await sessionOf(request)
        if (!session || typeof body?.lane !== 'string') return reply({ ok: false, error: { code: 'orrery-worktree/invalid', message: 'body needs { sessionId, lane } of a live session' } }, 400)
        try {
          return reply({ ok: true, value: { lane: body.lane, diff: await service.diffOf(session, body.lane) } })
        } catch (error) {
          return reply({ ok: false, error: { code: /** @type {any} */ (error)?.code ?? 'orrery-worktree/internal', message: /** @type {any} */ (error)?.reason ?? /** @type {any} */ (error)?.message ?? String(error) } }, 500)
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
