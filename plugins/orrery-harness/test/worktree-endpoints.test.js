// Read-only panel endpoints are cold-safe across a DSH restart: the GUI reads
// sessions through page/follow/projections, which never activate an agent, so
// /api/orrery-worktree/view and /api/orrery-worktree/diff must answer from the
// persisted log (a sessionQuery observation driving a pseudo session) instead
// of requiring a live session — while the live path stays byte-identical.
import { describe, expect, it } from './helpers.js'
import { apply } from '../src/worktree/index.js'
import { WORKTREE_PROJECTION_KEY } from '../src/worktree/projection.js'

// A git double behind the subprocess seam: `--version` reports a supported git
// (>= the 2.38 floor) and every repository probe exits 128 the way git does
// outside a repository, so repoFor rejects with NOT_A_REPO without ever
// touching the host's real git or filesystem.
const gitStub = {
  resolveExecutable: async () => '/stub/git',
  spawn: ({ argv }) => {
    const payload = argv.includes('--version')
      ? { code: 0, stdout: 'git version 2.43.0\n', stderr: '' }
      : { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
    return {
      stdout: { on: (event, push) => { if (event === 'data' && payload.stdout) push(Buffer.from(payload.stdout)) } },
      stderr: { on: (event, push) => { if (event === 'data' && payload.stderr) push(Buffer.from(payload.stderr)) } },
      done: Promise.resolve({ exitCode: payload.code }),
      terminate: () => {},
    }
  },
}

/**
 * Minimal plugin ctx double: captures the ['connection'] inject callback and
 * fires it with a fetch registry that records each route definition by path,
 * so the test can POST to the endpoints directly.
 * @param {{ agentsValue?: any, observeSession?: any, stateOf?: any }} [options]
 */
function fakePluginCtx({ agentsValue, observeSession, stateOf } = {}) {
  /** @type {Map<string, any>} */
  const routes = new Map()
  const ctx = {
    logger: { warn() {} },
    emit() {},
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, variable: () => () => {}, context: () => () => {} },
    get: (/** @type {string} */ key) => {
      if (key === 'sessionProjections') return { register: () => () => {}, stateOf: stateOf ?? (() => ({ mode: true })) }
      if (key === 'agents') return { get: () => agentsValue }
      if (key === 'sessions') return { get: () => undefined }
      if (key === 'sessionQuery') return { observeSession }
      if (key === 'subprocess') return gitStub
      return undefined
    },
    inject: (/** @type {string[]} */ list, /** @type {any} */ fn) => {
      if (Array.isArray(list) && list.includes('connection')) {
        fn({ connection: { fetch: { register: (/** @type {any} */ route) => { routes.set(route.path, route); return () => {} } } } })
      }
      return () => {}
    },
  }
  return { ctx, routes }
}

/** POST one JSON body to a registered route and parse the reply. */
async function call(routes, path, body) {
  const route = routes.get(path)
  expect(route, `route ${path} registered`).toBeTruthy()
  const response = await route.fetch({ json: async () => body })
  return { status: response.status, reply: await response.json() }
}

/** A cold observation lease over the persisted log of `sessionId`. */
function coldObservation({ sessionId, cwd, mode, approve, onDispose }) {
  return {
    source: 'prepared',
    header: { id: sessionId, cwd },
    projections: { values: { [WORKTREE_PROJECTION_KEY]: { mode, lanes: [], ...(approve !== undefined ? { approve } : {}) } } },
    retain() { return this },
    [Symbol.dispose]() { onDispose() },
  }
}

describe('worktree panel endpoints (cold-safe)', () => {
  it('serves the view from a cold sessionQuery observation when no agent is live', async () => {
    let observed = 0
    let disposed = 0
    const { ctx, routes } = fakePluginCtx({
      agentsValue: undefined,
      // The live projection registry can only fold a real Session; a pseudo
      // session has no live cells, so a correct cold view never consults it.
      stateOf: () => { throw new Error('no live projection cells on a pseudo session') },
      observeSession: async (sessionId) => {
        observed++
        return coldObservation({ sessionId, cwd: '/nonexistent-cold', mode: true, approve: 'auto-keep', onDispose: () => { disposed++ } })
      },
    })
    const dispose = apply(ctx, {})
    const { reply } = await call(routes, '/api/orrery-worktree/view', { sessionId: 's1' })
    expect(observed).toBe(1)
    expect(reply.ok).toBe(true)
    expect(reply.value.available).toBe(false)
    // The cold cwd actually drove the repo probe: /nonexistent-cold is not a repo.
    expect(reply.value.error.code).toBe('NOT_A_REPO')
    expect(reply.value.error.message).toContain('/nonexistent-cold')
    // The cold-folded mode override reached the view (stateOf would have thrown).
    expect(reply.value.mode).toBe(true)
    // The cold-folded approve override reached the view the same way: a
    // session override wins and is reported with its source.
    expect(reply.value.approveMode).toBe('auto-keep')
    expect(reply.value.approveModeSource).toBe('session')
    expect(disposed).toBe(1)
    dispose()
  })

  it('keeps the live-session path: the agent session cwd is used and sessionQuery is never consulted', async () => {
    let observed = 0
    const { ctx, routes } = fakePluginCtx({
      agentsValue: { session: { id: 's1', header: { cwd: '/nonexistent-live' } } },
      observeSession: async () => { observed++; throw new Error('must not be called for a live session') },
    })
    const dispose = apply(ctx, {})
    const { reply } = await call(routes, '/api/orrery-worktree/view', { sessionId: 's1' })
    expect(reply.ok).toBe(true)
    expect(reply.value.available).toBe(false)
    expect(reply.value.error.code).toBe('NOT_A_REPO')
    // The LIVE cwd drove the probe.
    expect(reply.value.error.message).toContain('/nonexistent-live')
    expect(observed).toBe(0)
    dispose()
  })

  it('keeps the SESSION_NOT_LIVE degraded reply when the session is neither live nor persisted', async () => {
    const { ctx, routes } = fakePluginCtx({
      agentsValue: undefined,
      observeSession: async () => { throw Object.assign(new Error('unknown session'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }) },
    })
    const dispose = apply(ctx, {})
    const { reply } = await call(routes, '/api/orrery-worktree/view', { sessionId: 'gone' })
    expect(reply.ok).toBe(true)
    expect(reply.value.available).toBe(false)
    expect(reply.value.error.code).toBe('SESSION_NOT_LIVE')
    expect(reply.value.lanes).toEqual([])
    // No session context at all: the degraded reply falls back to the global
    // default (auto-clean without an orrerySettings service).
    expect(reply.value.approveMode).toBe('auto-clean')
    expect(reply.value.approveModeSource).toBe('global')
    dispose()
  })

  it('serves the diff route from a cold observation: the repo error surfaces as a 500 and the lease is disposed', async () => {
    let disposed = 0
    const { ctx, routes } = fakePluginCtx({
      agentsValue: undefined,
      observeSession: async (sessionId) => coldObservation({ sessionId, cwd: '/nonexistent-cold', mode: false, onDispose: () => { disposed++ } }),
    })
    const dispose = apply(ctx, {})
    const { status, reply } = await call(routes, '/api/orrery-worktree/diff', { sessionId: 's1', lane: 'a-001' })
    // /nonexistent-cold is not a repo: the lane/repo failure surfaces as a 500
    // with the WorktreeError code — not the 400 invalid shape.
    expect(status).toBe(500)
    expect(reply.ok).toBe(false)
    expect(reply.error.code).toBe('NOT_A_REPO')
    expect(reply.error.message).toContain('/nonexistent-cold')
    expect(disposed).toBe(1)
    dispose()
  })

  it('keeps the 400 invalid reply when the lane param is missing or no session resolves at all', async () => {
    const cold = fakePluginCtx({
      agentsValue: undefined,
      observeSession: async () => { throw Object.assign(new Error('unknown session'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }) },
    })
    const disposeCold = apply(cold.ctx, {})
    const missing = await call(cold.routes, '/api/orrery-worktree/diff', { sessionId: 'gone', lane: 'a-001' })
    expect(missing.status).toBe(400)
    expect(missing.reply.ok).toBe(false)
    expect(missing.reply.error.code).toBe('orrery-worktree/invalid')
    disposeCold()
    // Lane param missing, even with a live session.
    const live = fakePluginCtx({ agentsValue: { session: { id: 's1', header: { cwd: '/nonexistent-live' } } } })
    const disposeLive = apply(live.ctx, {})
    const noLane = await call(live.routes, '/api/orrery-worktree/diff', { sessionId: 's1' })
    expect(noLane.status).toBe(400)
    expect(noLane.reply.ok).toBe(false)
    expect(noLane.reply.error.code).toBe('orrery-worktree/invalid')
    disposeLive()
  })
})
