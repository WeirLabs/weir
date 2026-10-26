import { describe, expect, it } from './helpers.js'
import { createWatchCoordinator, WATCH_STATES } from '../src/file-lease/watch.js'

// The release-subscription coordinator (design D2/D4/D5): one per lease client,
// so every race the plugin and the tool have to survive can be driven without a
// socket.
//
// The contracts pinned here:
//  - one active entry per (session, path), so repeating a subscription — from
//    the same mount or another one — can never double-notify;
//  - consumption is one-way and happens before delivery, so a duplicate release
//    observation finds nothing;
//  - `hit`, `reset`, `self` and `cancelled` are terminal and only `self` implies
//    anything about ownership;
//  - a consumed entry stays in `pendingDelivery` until its timer finishes, so a
//    disposal between the hit and the notice still cancels it;
//  - one mount leaving preserves a wait another mount still holds, and the last
//    mount leaving clears everything.

const SESSION = 'sess-a'
const OTHER_SESSION = 'sess-b'
const PATH = '/work/project/src/a.js'
const OTHER_PATH = '/work/project/src/b.js'

/** @param {number} [ms] */
function delay(ms = 5) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * A mount handle plus the notices it was asked to deliver.
 * @param {string} [name]
 * @param {Map<string, any>} [agents]
 */
function createMount(name = 'mount-a', agents = new Map()) {
  /** @type {{ mount: string, entry: any, agent: any }[] } */
  const delivered = []
  /** @type {any} */
  const mount = {
    disposed: false,
    agentFor: (/** @type {string} */ sessionId) => agents.get(sessionId),
    notify: (/** @type {any} */ entry, /** @type {any} */ agent) => {
      delivered.push({ mount: name, entry, agent })
    },
  }
  agents.set(SESSION, { id: SESSION })
  return { mount, delivered, agents }
}

describe('watch coordinator', () => {
  it('keeps a closed state vocabulary that includes the owned terminal state', () => {
    expect([...WATCH_STATES]).toEqual(['watching', 'hit', 'reset', 'self', 'cancelled'])
  })

  it('registers one entry per session and path, idempotently, across mounts', () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    const b = createMount('b')
    const first = coordinator.register(SESSION, PATH, a.mount, a.agents.get(SESSION))
    const again = coordinator.register(SESSION, PATH, b.mount, b.agents.get(SESSION))
    expect(again).toBe(first)
    expect(coordinator.size()).toBe(1)
    expect(coordinator.peek(SESSION, PATH)).toBe(first)
    expect(first.state).toBe('watching')
    expect(first.settledByTool).toBe(false)

    // A different session, or a different path, is a different subscription.
    coordinator.register(OTHER_SESSION, PATH, a.mount)
    coordinator.register(SESSION, OTHER_PATH, a.mount)
    expect(coordinator.size()).toBe(3)
    expect(coordinator.entries().map((entry) => `${entry.sessionId}:${entry.path}`).sort()).toEqual([
      `${SESSION}:${PATH}`,
      `${SESSION}:${OTHER_PATH}`,
      `${OTHER_SESSION}:${PATH}`,
    ])
    // The projection never leaks mounts, flights or timers.
    expect(Object.keys(coordinator.entries()[0]).sort()).toEqual(['path', 'sessionId', 'settledByTool', 'state'])
  })

  it('consumes every subscription for a path once, in hit, before anything is delivered', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    const b = createMount('b')
    // Both sessions must be live in this process for their notices to land.
    a.agents.set(OTHER_SESSION, { id: OTHER_SESSION })
    coordinator.join(a.mount)
    coordinator.join(b.mount)
    coordinator.register(SESSION, PATH, a.mount)
    coordinator.register(OTHER_SESSION, PATH, a.mount)
    coordinator.register(SESSION, OTHER_PATH, a.mount)

    const consumed = coordinator.consumePath(PATH)
    expect(consumed).toHaveLength(2)
    for (const entry of consumed) expect(entry.state).toBe('hit')
    expect(coordinator.size()).toBe(1)
    // Consumed but not yet delivered: this is the window a disposal must still
    // be able to close.
    expect(coordinator.pendingSize()).toBe(2)
    expect(a.delivered).toEqual([])

    // A duplicate observation of the same release finds nothing to consume.
    expect(coordinator.consumePath(PATH)).toEqual([])
    await delay()
    expect(a.delivered).toHaveLength(2)
    expect(a.delivered.map((notice) => notice.entry.state)).toEqual(['hit', 'hit'])
    expect(coordinator.pendingSize()).toBe(0)
  })

  it('never delivers a consumed notice once the entry was cancelled', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    coordinator.register(SESSION, PATH, a.mount)

    coordinator.consumePath(PATH)
    expect(coordinator.pendingSize()).toBe(1)
    expect(coordinator.cancelSession(SESSION)).toHaveLength(1)
    expect(coordinator.pendingSize()).toBe(0)

    await delay()
    expect(a.delivered).toEqual([])
  })

  it('never delivers a notice a running tool already reported', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    const entry = coordinator.register(SESSION, PATH, a.mount)

    coordinator.consumePath(PATH)
    entry.settledByTool = true
    await delay()
    expect(a.delivered).toEqual([])
    expect(coordinator.pendingSize()).toBe(0)
  })

  it('re-checks the live agent identity before delivering a notice', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    const original = a.agents.get(SESSION)
    coordinator.register(SESSION, PATH, a.mount, original)

    coordinator.consumePath(PATH)
    // A new agent now answers for the same session: the notice belonged to the
    // subscription the old one made, so it must not land on its replacement.
    a.agents.set(SESSION, { id: SESSION, replacement: true })
    await delay()
    expect(a.delivered).toEqual([])
  })

  it('resets every active subscription with no claim about ownership', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    a.agents.set(OTHER_SESSION, { id: OTHER_SESSION })
    coordinator.join(a.mount)
    coordinator.register(SESSION, PATH, a.mount)
    coordinator.register(OTHER_SESSION, PATH, a.mount)

    const reset = coordinator.resetAll()
    expect(reset).toHaveLength(2)
    for (const entry of reset) expect(entry.state).toBe('reset')
    expect(coordinator.size()).toBe(0)
    expect(coordinator.resetAll()).toEqual([])

    await delay()
    expect(a.delivered.map((notice) => notice.entry.state)).toEqual(['reset', 'reset'])
  })

  it('ends one subscription conditionally on the same entry object', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    const entry = coordinator.register(SESSION, PATH, a.mount)

    // A stale caller cannot cancel an entry it no longer owns.
    const stale = { sessionId: SESSION, path: PATH, state: 'watching' }
    expect(coordinator.cancel(SESSION, PATH, /** @type {any} */ (stale))).toBeUndefined()
    expect(coordinator.peek(SESSION, PATH)).toBe(entry)

    expect(coordinator.cancel(SESSION, PATH, entry)).toBe(entry)
    expect(entry.state).toBe('cancelled')
    expect(coordinator.peek(SESSION, PATH)).toBeUndefined()
    // Cancelling an unknown pair is a no-op, not an error.
    expect(coordinator.cancel(SESSION, PATH)).toBeUndefined()
  })

  it('marks a transferred wait as owned instead of a plain cancellation', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    const entry = coordinator.register(SESSION, PATH, a.mount)

    expect(coordinator.settleSelf(SESSION, PATH)).toBe(entry)
    expect(entry.state).toBe('self')
    expect(coordinator.size()).toBe(0)
    expect(coordinator.settleSelf(SESSION, PATH)).toBeUndefined()
  })

  it('cancels a pending notice when the same path is acquired by transfer', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    coordinator.register(SESSION, PATH, a.mount)

    coordinator.consumePath(PATH)
    expect(coordinator.pendingSize()).toBe(1)
    coordinator.settleSelf(SESSION, PATH)
    expect(coordinator.pendingSize()).toBe(0)

    await delay()
    expect(a.delivered).toEqual([])
  })

  it('shares one status flight per entry between overlapping callers', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    const entry = coordinator.register(SESSION, PATH, a.mount)

    let runs = 0
    /** @type {(value: any) => void} */
    let release = () => {}
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const run = () => {
      runs += 1
      return gate
    }
    const first = coordinator.shareStatus(entry, run)
    const second = coordinator.shareStatus(entry, run)
    expect(second).toBe(first)
    release('answer')
    expect(await first).toBe('answer')
    expect(await second).toBe('answer')
    expect(runs).toBe(1)

    // Once it settles, a new call reads again instead of reusing a stale answer.
    const third = coordinator.shareStatus(entry, () => {
      runs += 1
      return 'fresh'
    })
    expect(await third).toBe('fresh')
    expect(runs).toBe(2)
  })

  it('keeps a wait alive when one mount leaves and another still owns it', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    const b = createMount('b')
    coordinator.join(a.mount)
    coordinator.join(b.mount)
    coordinator.register(SESSION, PATH, a.mount)
    coordinator.register(SESSION, PATH, b.mount)
    expect(coordinator.size()).toBe(1)

    coordinator.leave(a.mount)
    expect(a.mount.disposed).toBe(true)
    // The entry is still wanted by b, so it survives and b delivers the notice.
    expect(coordinator.size()).toBe(1)
    expect(coordinator.mountCount()).toBe(1)
    coordinator.consumePath(PATH)
    await delay()
    expect(a.delivered).toEqual([])
    expect(b.delivered).toHaveLength(1)
  })

  it('clears everything when the last mount leaves', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    coordinator.register(SESSION, PATH, a.mount)

    coordinator.consumePath(PATH)
    expect(coordinator.pendingSize()).toBe(1)
    coordinator.leave(a.mount)
    expect(coordinator.mountCount()).toBe(0)
    expect(coordinator.size()).toBe(0)
    expect(coordinator.pendingSize()).toBe(0)

    await delay()
    expect(a.delivered).toEqual([])
  })

  it('never hands out live objects through the projections', () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    coordinator.register(SESSION, PATH, a.mount)
    const snapshot = coordinator.entries()
    snapshot[0].state = 'hit'
    snapshot[0].path = '/mutated'
    const live = coordinator.entries()
    expect(live).toHaveLength(1)
    expect(live[0].state).toBe('watching')
    expect(live[0].path).toBe(PATH)
  })

  it('holds a consumed notice until the in-flight read settles, then lets the tool win', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    const entry = coordinator.register(SESSION, PATH, a.mount, a.agents.get(SESSION))

    /** @type {(value?: any) => void} */
    let fulfil = () => {}
    const gate = new Promise((resolve) => {
      fulfil = resolve
    })
    const flight = coordinator.shareStatus(entry, () => gate)
    // The tool's own continuation: it resumes when the read settles and reports
    // the episode as a result, which must suppress the deferred notice.
    const reported = flight.then(() => {
      entry.settledByTool = true
    })
    coordinator.consumePath(PATH)
    expect(coordinator.pendingSize()).toBe(1)

    // The zero-delay timer window passes while the read is outstanding: no
    // message may be delivered before the tool had its chance to answer.
    await delay(15)
    expect(a.delivered).toEqual([])
    expect(coordinator.pendingSize()).toBe(1)

    fulfil({ ok: true })
    await reported
    await delay(15)
    // Exactly one model-facing outcome: the tool's. Nothing is left pending.
    expect(a.delivered).toEqual([])
    expect(coordinator.pendingSize()).toBe(0)
  })

  it('holds a consumed notice until a rejecting read settles, then lets the tool win', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    const entry = coordinator.register(SESSION, PATH, a.mount, a.agents.get(SESSION))

    /** @type {(error: any) => void} */
    let fail = () => {}
    const gate = new Promise((_resolve, reject) => {
      fail = reject
    })
    const flight = coordinator.shareStatus(entry, () => gate)
    // The tool's catch block reports the terminal outcome just like its success
    // path does; either way the notice must not repeat it.
    const reported = flight.catch(() => {
      entry.settledByTool = true
    })
    coordinator.consumePath(PATH)

    await delay(15)
    expect(a.delivered).toEqual([])
    expect(coordinator.pendingSize()).toBe(1)

    fail(new Error('lease broker connection closed'))
    await reported
    await delay(15)
    expect(a.delivered).toEqual([])
    expect(coordinator.pendingSize()).toBe(0)
  })

  it('drops a gated notice whose entry is cancelled before the read settles', async () => {
    const coordinator = createWatchCoordinator()
    const a = createMount('a')
    coordinator.join(a.mount)
    const entry = coordinator.register(SESSION, PATH, a.mount, a.agents.get(SESSION))

    /** @type {(value?: any) => void} */
    let fulfil = () => {}
    const gate = new Promise((resolve) => {
      fulfil = resolve
    })
    const flight = coordinator.shareStatus(entry, () => gate)
    coordinator.consumePath(PATH)
    coordinator.cancelSession(SESSION)
    expect(coordinator.pendingSize()).toBe(0)

    fulfil({ ok: true })
    await flight
    await delay(15)
    // The gate must not re-arm a cancelled entry or leak a pending record.
    expect(a.delivered).toEqual([])
    expect(coordinator.pendingSize()).toBe(0)
  })
})
