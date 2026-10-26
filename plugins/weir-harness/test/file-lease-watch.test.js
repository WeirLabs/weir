import { describe, expect, it } from './helpers.js'
import { createWatchRegistry, WATCH_STATES } from '../src/file-lease/watch.js'

// The release-subscription registry (design D2): a pure state machine, so every
// race the plugin and the tool have to survive can be driven without a socket.
//
// The contracts pinned here:
//  - one active entry per (session, path), so repeating a subscription can never
//    double-notify;
//  - consumption is one-way and happens before delivery, so a duplicate release
//    observation finds nothing;
//  - `reset` and `cancelled` are terminal and claim NOTHING about ownership;
//  - a mount can end everything it created, and nothing revives afterwards.

const SESSION = 'sess-a'
const OTHER_SESSION = 'sess-b'
const PATH = '/work/project/src/a.js'
const OTHER_PATH = '/work/project/src/b.js'

describe('watch registry', () => {
  it('keeps a closed state vocabulary', () => {
    expect([...WATCH_STATES]).toEqual(['watching', 'hit', 'reset', 'cancelled'])
  })

  it('registers one entry per session and path, idempotently', () => {
    const registry = createWatchRegistry()
    const first = registry.register(SESSION, PATH)
    const again = registry.register(SESSION, PATH)
    expect(again).toBe(first)
    expect(registry.size()).toBe(1)
    expect(registry.peek(SESSION, PATH)).toBe(first)
    expect(first.state).toBe('watching')
    expect(first.settledByTool).toBe(false)

    // A different session, or a different path, is a different subscription.
    registry.register(OTHER_SESSION, PATH)
    registry.register(SESSION, OTHER_PATH)
    expect(registry.size()).toBe(3)
    expect(registry.entries().map((entry) => `${entry.sessionId}:${entry.path}`).sort()).toEqual([
      `${SESSION}:${PATH}`,
      `${SESSION}:${OTHER_PATH}`,
      `${OTHER_SESSION}:${PATH}`,
    ])
  })

  it('consumes every subscription for a path once, in hit, before anything is delivered', () => {
    const registry = createWatchRegistry()
    registry.register(SESSION, PATH)
    registry.register(OTHER_SESSION, PATH)
    registry.register(SESSION, OTHER_PATH)

    const consumed = registry.consumePath(PATH)
    expect(consumed).toHaveLength(2)
    for (const entry of consumed) expect(entry.state).toBe('hit')
    expect(registry.size()).toBe(1)

    // A duplicate observation of the same release finds nothing to consume, so
    // no subscriber can be notified twice for one release.
    expect(registry.consumePath(PATH)).toEqual([])
  })

  it('returns the same entry object the tool holds, so a race is observable', () => {
    const registry = createWatchRegistry()
    const entry = registry.register(SESSION, PATH)
    // This is exactly the D2 race: the event callback consumes the entry while
    // the tool is still waiting for its authoritative read.
    registry.consumePath(PATH)
    expect(entry.state).toBe('hit')
    // The tool can suppress the deferred notice it no longer needs.
    entry.settledByTool = true
  })

  it('cancels one subscription, a session, or everything, terminally', () => {
    const registry = createWatchRegistry()
    const mine = registry.register(SESSION, PATH)
    const other = registry.register(OTHER_SESSION, PATH)

    expect(registry.cancel(SESSION, PATH)).toBe(mine)
    expect(mine.state).toBe('cancelled')
    expect(registry.peek(SESSION, PATH)).toBeUndefined()
    // Cancelling an unknown pair is a no-op, not an error.
    expect(registry.cancel(SESSION, PATH)).toBeUndefined()

    registry.register(SESSION, OTHER_PATH)
    expect(registry.cancelSession(SESSION).map((entry) => entry.path)).toEqual([OTHER_PATH])
    expect(registry.size()).toBe(1)
    expect(other.state).toBe('watching')

    expect(registry.clear().map((entry) => entry.state)).toEqual(['cancelled'])
    expect(registry.size()).toBe(0)
    expect(registry.peek(OTHER_SESSION, PATH)).toBeUndefined()
  })

  it('resets every active subscription with no claim about ownership', () => {
    const registry = createWatchRegistry()
    registry.register(SESSION, PATH)
    registry.register(OTHER_SESSION, PATH)

    const reset = registry.resetAll()
    expect(reset).toHaveLength(2)
    for (const entry of reset) {
      expect(entry.state).toBe('reset')
      // A reset ends a subscription; it never re-describes the path.
      expect(Object.keys(entry).sort()).toEqual(['path', 'sessionId', 'settledByTool', 'state'])
    }
    expect(registry.size()).toBe(0)
    expect(registry.resetAll()).toEqual([])
  })

  it('never hands out live objects through the projection', () => {
    const registry = createWatchRegistry()
    registry.register(SESSION, PATH)
    const snapshot = registry.entries()
    snapshot[0].state = 'hit'
    snapshot[0].path = '/mutated'
    const live = registry.entries()
    expect(live).toHaveLength(1)
    expect(live[0].state).toBe('watching')
    expect(live[0].path).toBe(PATH)
  })
})
