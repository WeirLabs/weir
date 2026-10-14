// A single process owner serializes durable mutations AND volatile arbitration.
// Candidate kernels have no timers/listeners with external effects; publication
// happens only after the storage transaction commits. No async snapshot saving.
import { createBlackboardKernel } from './kernel.js'
import { createBlackboardStorage, sessionId } from './storage.js'

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
    runtime = { storage, kernel: createDurableBlackboard({ storage, warn: error => ctx.logger?.warn?.(String(error)) }), flushed: new WeakSet(), members: new Map() }
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
      // A fork (a depth-0 Session carrying parentSession) is its own board root,
      // but its board starts as a one-time snapshot of the fork source's durable
      // root board: seed before the first ensure can materialize an empty sidecar.
      // Once per runtime; the no-sidecar disk check keeps it idempotent across
      // restarts. Best-effort: a failed seed never blocks board availability.
      const parentId = header.parentSession
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
