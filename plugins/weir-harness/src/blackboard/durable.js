/// <reference path="./node-contracts.d.ts" />
// A single process owner serializes durable mutations AND volatile arbitration.
// Candidate kernels have no timers/listeners with external effects; publication
// happens only after the storage transaction commits. No async snapshot saving.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createBlackboardKernel } from './kernel.js'
import { createBlackboardStorage, sessionId } from './storage.js'

/**
 * @param {object} dependencies
 * @param {any} [dependencies.storage] durable store (createBlackboardStorage)
 * @param {() => number} [dependencies.now]
 * @param {(fn: () => void, ms: number) => any} [dependencies.setTimer]
 * @param {(handle: any) => void} [dependencies.clearTimer]
 * @param {(error: unknown) => void} [dependencies.warn] diagnostics sink
 */
export function createDurableBlackboard({ storage, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, warn = () => {} }) {
  const states = new Map()
  const listeners = new Set()
  const cwds = new Map()
  const tails = new Map()
  function serial(id, fn) {
    const task = (tails.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
    tails.set(id, task)
    void task.finally(() => { if (tails.get(id) === task) tails.delete(id) }).catch(() => {})
    return task
  }
  function schedule(id, state) {
    if (state.timer !== undefined) clearTimer(state.timer)
    if (!state.tokens.length) { state.timer = undefined; return }
    const delay = Math.max(1, Math.min(...state.tokens.map(t => t.expiresAt)) - now())
    state.timer = setTimer(() => {
      void ephemeral(id, 'expire').catch(warn)
    }, Math.min(delay, 2 ** 31 - 1))
    state.timer?.unref?.()
  }
  function candidate(id, entries, method, args) {
    const previous = states.get(id) ?? { tokens: [], subscriptions: [] }
    const kernel = createBlackboardKernel({ now, setTimer: () => undefined, clearTimer: () => {} })
    kernel.restore(id, entries, previous)
    const events = []
    kernel.onRelease(event => events.push(event))
    const result = ['releaseHolder', 'unsubscribeHolder'].includes(method) ? kernel[method](args[0]) : kernel[method](id, ...args)
    const next = { tokens: kernel.tokensOf(id), subscriptions: kernel.subscriptionsOf(id), timer: previous.timer }
    return {
      entries: kernel.entriesOf(id),
      publish() {
        states.set(id, next)
        schedule(id, next)
        for (const event of events) for (const listener of listeners) { try { listener(event) } catch (error) { warn(error) } }
        return result
      },
    }
  }
  function invoke(id, method, ...args) {
    return serial(id, () => storage.transact(id, cwds.get(id), entries => candidate(id, entries, method, args)))
  }
  function ephemeral(id, method, ...args) {
    // These operations cannot change entry fields. They still wait behind all
    // pending commits, but revocation must work even if the disk is unavailable.
    return serial(id, () => candidate(id, [], method, args).publish())
  }
  const api = {
    bind(id, cwd) { sessionId(id); cwds.set(id, cwd) },
    ensure: id => invoke(id, 'list'),
    onRelease(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    releaseHolder(holder) {
      return Promise.all([...new Set([...states.keys(), ...tails.keys()])].map(id => ephemeral(id, 'releaseHolder', holder)))
    },
    unsubscribeHolder(holder) {
      return Promise.all([...new Set([...states.keys(), ...tails.keys()])].map(id => ephemeral(id, 'unsubscribeHolder', holder)))
    },
    // Unmount/disposal clears authority via the same serialized path. Durable
    // entries are never dropped. The caller awaits this before reusing a root.
    clearRuntime(id, { releaseWriter = false } = {}) {
      return serial(id, async () => {
        const previous = states.get(id)
        if (previous?.timer !== undefined) clearTimer(previous.timer)
        states.delete(id)
        if (releaseWriter) await storage.releaseWriter(id, cwds.get(id))
      })
    },
    tokensOf: id => serial(id, () => structuredClone(states.get(id)?.tokens ?? [])),
    subscriptionsOf: id => serial(id, () => structuredClone(states.get(id)?.subscriptions ?? [])),
  }
  for (const method of ['list', 'read', 'apply', 'write', 'deleteKey', 'markPromoted', 'entriesOf']) api[method] = (id, ...args) => invoke(id, method, ...args)
  return api
}

// Symbol registry survives ESM reloads in the same live PID. A new module nonce
// must never reclaim a live owner or revive a second set of token authorities.
const runtimeKey = Symbol.for('weir.blackboard.runtime.v1')
const runtimes = globalThis[runtimeKey] ??= new Map()
export function runtimeBlackboard(ctx) {
  const home = ctx.get?.('profileContext')?.home
  if (typeof home !== 'string' || !home) throw new Error('blackboard: profileContext.home unavailable')
  let runtime = runtimes.get(home)
  if (!runtime) {
    const storage = createBlackboardStorage({ home })
    runtime = { storage, kernel: createDurableBlackboard({ storage, warn: error => ctx.logger?.warn?.(String(error)) }), flushed: new WeakSet(), members: new Map(), forkSources: new Map(), forkProvenance: { holders: 0, release: undefined, warned: false } }
    runtimes.set(home, runtime)
  }
  return runtime
}

// Lifecycle admission covers ancestry/ensure AND the ensuing operation. Closing
// an incarnation fences it synchronously; cleanup waits behind admitted work.
// The host-wide gate also prevents a remount racing the final writer release.
export function lifecycleSerial(runtime, action) {
  const task = (runtime.lifecycleTail ?? Promise.resolve()).catch(() => {}).then(action)
  runtime.lifecycleTail = task.catch(() => {})
  return task
}

export function createRuntimeMount(ctx, runtime) {
  const mount = { active: true }
  runtime.revoked ??= new WeakSet()
  function check(agent) {
    if (!mount.active || runtime.revoked.has(agent) || ctx.get?.('agents')?.get?.(agent.id) !== agent) {
      throw new Error('blackboard: Agent disposed or mount inactive')
    }
  }
  const run = (agent, action) => lifecycleSerial(runtime, async () => {
    check(agent)
    const previous = runtime.members.get(agent.id)
    if (previous && previous.agent !== agent) await detach(previous.agent)
    check(agent)
    const root = await resolveDurableRoot(ctx, agent, runtime, mount)
    check(agent)
    const result = await action(root)
    check(agent)
    return result
  })
  async function detach(agent, unmount = false) {
    const member = runtime.members.get(agent.id)
    if (!member || member.agent !== agent) return
    if (unmount) {
      member.mounts?.delete(mount)
      if (member.mounts?.size) return
    }
    runtime.members.delete(agent.id)
    await runtime.kernel.releaseHolder(agent.id)
    if (unmount || (agent.session?.header?.delegationDepth ?? 0) === 0) await runtime.kernel.unsubscribeHolder(agent.id)
    if (![...runtime.members.values()].some(other => other.root === member.root)) {
      await runtime.kernel.clearRuntime(member.root, { releaseWriter: true })
    }
  }
  return {
    run,
    disposed(agent) {
      runtime.revoked.add(agent)
      return lifecycleSerial(runtime, () => detach(agent))
    },
    close() {
      mount.active = false
      return lifecycleSerial(runtime, async () => {
        for (const member of [...runtime.members.values()]) {
          if (member.mounts?.has(mount)) await detach(member.agent, true)
        }
      })
    },
  }
}

/**
 * Capture the source Session of every ordinary fork the host performs.
 *
 * DSH records no provenance on an ordinary fork: the Session Controller builds
 * the seed and calls agents.create() with meta { cwd, isSeeded } only — no
 * parentSession, no replacement field (upgrade guide v0.2.1-rc.3, independent
 * session forks). The source identity therefore exists only for the duration of
 * the fork call, which makes intercepting that call the one reliable place to
 * learn it.
 *
 * The wrapper parks the source id in an AsyncLocalStorage store for the call
 * (concurrent forks never cross) and temporarily wraps agents.create to read
 * the child identity from its options — synchronously, before the host creates
 * the Session, hence before its agent/created hook can observe any board. The
 * pair lands in runtime.forkSources, which the depth-zero branch of
 * resolveDurableRoot consumes exactly once, ahead of the first ensure that
 * would materialize an empty sidecar.
 *
 * Optional by construction: both services arrive through ctx.inject, so a
 * composition without the Session Controller (headless, SDK) never runs the
 * callback and fork boards keep their current behavior. A failure inside the
 * wrapper is reported once and never changes the host's fork semantics. The
 * returned disposer is idempotent and only the last holder restores the
 * original methods (a preset remount keeps the capture installed).
 *
 * Host service methods are reached through cordis traceable proxies: every read
 * of a function property returns a NEW Proxy (createShadowMethod), so identity
 * comparison across two reads of agents.create is never true and must never
 * guard a restore. The patch tracks its own installation state instead.
 * @param {any} ctx @param {any} runtime
 * @returns {() => void}
 */
export function installForkProvenance(ctx, runtime) {
  const state = runtime.forkProvenance ??= { holders: 0, release: undefined, warned: false }
  runtime.forkSources ??= new Map()
  state.holders += 1
  const warnOnce = (message) => {
    if (state.warned) return
    state.warned = true
    ctx.logger?.warn?.(message)
  }
  let disposed = false
  let offScope = () => {}
  try {
    const off = ctx.inject?.(['sessionController', 'agents'], scope => {
      if (disposed) return undefined
      const controller = scope.sessionController
      const agents = scope.agents
      const fork = controller?.fork
      const create = agents?.create
      if (typeof fork !== 'function' || typeof create !== 'function') {
        warnOnce('blackboard fork provenance unavailable: the host Session Controller exposes no callable fork')
        return undefined
      }
      if (state.release !== undefined) return undefined
      const ownFork = Object.prototype.hasOwnProperty.call(controller, 'fork')
      const sink = new AsyncLocalStorage()
      // The create patch is reference-counted across in-flight forks and chains to
      // whatever it displaced, so another wrapper (a probe, a host decoration)
      // installed before the fork still runs and is restored afterwards.
      //
      // Restore is keyed on `installed`, never on identity: host service method
      // reads return a fresh traceable Proxy each time (createShadowMethod), so
      // `agents.create === createCapturing` is false even while our patch is the
      // value the host holds. Such a guard never restores; the next fork then
      // records its own wrapper as the displaced create and the chain collapses
      // into synchronous self-recursion. Corollary for other plugins: never
      // install or replace a third-party wrapper inside a fork window — the
      // window restores the value it displaced and preserves no patch it did not
      // make.
      let inFlight = 0
      let installed = false
      let displacedCreate
      /** @this {any} */
      const createCapturing = async function createCapturing(options, ...rest) {
        const store = sink.getStore()
        if (store !== undefined && typeof options?.sessionId === 'string' && options.sessionId.length > 0) runtime.forkSources.set(options.sessionId, store.sourceId)
        return displacedCreate.call(this, options, ...rest)
      }
      /** @this {any} */
      const forkCapturing = async function forkCapturing(request, ...rest) {
        const sourceId = typeof request?.sessionId === 'string' && request.sessionId.length > 0 ? request.sessionId : undefined
        if (sourceId === undefined) return fork.call(this, request, ...rest)
        if (inFlight === 0) {
          if (!installed) {
            displacedCreate = agents.create
            installed = true
          }
          agents.create = createCapturing
        }
        inFlight += 1
        try {
          return await sink.run({ sourceId }, () => fork.call(this, request, ...rest))
        } catch (error) {
          // Provenance is best-effort; the fork outcome belongs to the host.
          warnOnce(`blackboard fork provenance failed: ${String(error)}`)
          throw error
        } finally {
          inFlight -= 1
          if (inFlight === 0 && installed) {
            agents.create = displacedCreate
            installed = false
          }
        }
      }
      controller.fork = forkCapturing
      state.release = () => {
        if (controller.fork === forkCapturing) {
          if (ownFork) controller.fork = fork
          else delete controller.fork
        }
        if (installed) {
          agents.create = displacedCreate ?? create
          installed = false
        }
        state.release = undefined
      }
      return undefined
    })
    offScope = typeof off === 'function' ? off : () => {}
  } catch (error) {
    warnOnce(`blackboard fork provenance unavailable: ${String(error)}`)
  }
  return () => {
    if (disposed) return
    disposed = true
    state.holders = Math.max(0, state.holders - 1)
    if (state.holders === 0) state.release?.()
    try { offScope() } catch { /* disposal is best-effort */ }
  }
}

/**
 * @param {any} ctx @param {any} agent @param {any} runtime @param {{ active: boolean }} [mount]
 * @returns {Promise<string>}
 */
export async function resolveDurableRoot(ctx, agent, runtime, mount = undefined) {
  let id = sessionId(agent?.id)
  const wasLive = ctx.get?.('agents')?.get?.(id) === agent
  let session = agent?.session
  let header = session?.header
  const seen = new Set()
  for (let hop = 0; hop < 64; hop++) {
    if (seen.has(id)) throw new Error('blackboard: cyclic Session parent chain')
    seen.add(id)
    if (!header) header = (await runtime.storage.locate(id)).header
    if (header.id !== id) throw new Error('blackboard: live Session identity mismatch')
    const depth = header.delegationDepth ?? 0
    if (!Number.isSafeInteger(depth) || depth < 0) throw new Error('blackboard: invalid Session delegation depth')
    // A fork can carry parentSession while remaining a distinct depth-zero
    // root. Only delegated children inherit a board.
    if (depth === 0) {
      if (session && !runtime.flushed.has(session)) {
        const persistence = ctx.get?.('sessionPersistence')
        // A pending logical Session is visible to stat before materialization.
        // A vanished formerly materialized log is absent: never recreate it.
        if (!persistence || !await persistence.stat(id)) throw new Error('blackboard: durable Session unavailable; sidecars preserved')
        const participated = await ctx.get?.('sessions')?.flush?.(session)
        if (participated !== true) throw new Error('blackboard: Session flush has no persistence participant')
        runtime.flushed.add(session)
      }
      const where = await runtime.storage.locate(id, header.cwd)
      if (wasLive && ctx.get?.('agents')?.get?.(agent.id) !== agent) throw new Error('blackboard: Agent disposed while resolving its root')
      if (ctx.get?.('agents')?.get?.(agent.id) === agent) {
        runtime.members ??= new Map()
        const previous = runtime.members.get(agent.id)
        const mounts = previous?.agent === agent ? previous.mounts ?? new Set() : new Set()
        if (mount) mounts.add(mount)
        runtime.members.set(agent.id, { agent, root: id, mounts })
      }
      // A fork is its own board root, but its board starts as a one-time
      // snapshot of the fork source's durable root board: seed before the first
      // ensure can materialize an empty sidecar. The source arrives from either
      // the legacy header parentSession (old logs and old hosts still write it)
      // or the fork-call capture (current hosts record no provenance at all —
      // see installForkProvenance). Once per runtime; the no-sidecar disk check
      // keeps it idempotent across restarts. Best-effort: a failed seed never
      // blocks board availability.
      const legacyParent = header.parentSession
      const captured = runtime.forkSources?.get(id)
      // The capture is one-shot: consume it whatever the outcome below.
      if (captured !== undefined) runtime.forkSources?.delete(id)
      // A captured source only counts for a genuinely seeded Session: a
      // non-seeded header cannot be a fork, so a stale mapping seeds nothing.
      const parentId = typeof legacyParent === 'string' && legacyParent.length > 0
        ? legacyParent
        : header.isSeeded === true ? captured : undefined
      if (typeof parentId === 'string' && parentId.length > 0) {
        runtime.forkSeeded ??= new Set()
        if (!runtime.forkSeeded.has(id)) {
          runtime.forkSeeded.add(id)
          try { await runtime.storage.seedFork(id, parentId, where.header.cwd) } catch (error) { ctx.logger?.warn?.(`blackboard fork seeding failed: ${String(error)}`) }
        }
      }
      runtime.kernel.bind(id, where.header.cwd)
      await runtime.kernel.ensure(id)
      if (wasLive && (runtime.revoked?.has(agent) || ctx.get?.('agents')?.get?.(agent.id) !== agent)) throw new Error('blackboard: Agent disposed while resolving its root')
      return id
    }
    id = sessionId(header.parentSession)
    session = ctx.get?.('sessions')?.get?.(id)
    header = session?.header
  }
  throw new Error('blackboard: Session ancestry exceeds safety limit')
}
