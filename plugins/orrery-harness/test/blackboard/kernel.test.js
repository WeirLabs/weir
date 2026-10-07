// Session blackboard kernel unit tests: storage and usage counts, the full
// arbitration paths (apply / write / delete / expire / one-shot invalidation /
// contention subscribe / terminate release), the entryType closed enum, and
// the summary testimony validation. Pure kernel — no ctx, fake clock.
import { describe, expect, it } from '../helpers.js'
import { createBlackboardKernel, ENTRY_TYPES, validateEntryType, validateKey, validateSummary } from '../../src/blackboard/kernel.js'

const TTL = 60_000

/** A deterministic fake clock whose advance() fires due timers in order. */
function createClock(start = 1_000_000) {
  let now = start
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map()
  let seq = 0
  return {
    now: () => now,
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, timer] = due
        timers.delete(id)
        now = timer.at
        timer.fn()
      }
      now = target
    },
    setTimer(fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    pending() { return timers.size },
  }
}

function makeKernel() {
  const clock = createClock()
  /** @type {object[]} */
  const events = []
  const kernel = createBlackboardKernel({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  kernel.onRelease(event => events.push(event))
  return { kernel, clock, events }
}

function entry(overrides = {}) {
  return {
    key: 'dsh-runtime-map', entryType: 'map',
    summary: { fact: 'packages live under packages/<group>/<name>', cost: 'two fs searches', reVerify: 'ls packages/*/*/package.json' },
    content: 'full layout notes',
    ...overrides,
  }
}

const A = 'agent-a'
const B = 'agent-b'
const BOARD = 'root-session-1'

describe('entryType closed enum (D4)', () => {
  it('is exactly the six design values', () => {
    expect(ENTRY_TYPES).toEqual(['map', 'contract', 'deadend', 'wiring', 'recipe', 'why'])
  })

  it('accepts every enum value and rejects anything else', () => {
    for (const value of ENTRY_TYPES) expect(validateEntryType(value)).toBe(value)
    expect(() => validateEntryType('banana')).toThrow(/entryType must be one of/)
    expect(() => validateEntryType(undefined)).toThrow(/entryType must be one of/)
    expect(() => validateEntryType('MAP')).toThrow(/entryType must be one of/)
  })
})

describe('summary testimony validation', () => {
  it('accepts a summary carrying all three elements and normalizes it', () => {
    expect(validateSummary({ fact: 'f', cost: 'c', reVerify: 'r' })).toEqual({ fact: 'f', cost: 'c', reVerify: 'r' })
    expect(validateSummary({ fact: ' f ', cost: 'c', reVerify: 'r', extra: 'ignored' })).toEqual({ fact: 'f', cost: 'c', reVerify: 'r' })
  })

  it('refuses a missing, empty or blank element (no re-verify = dogma)', () => {
    expect(() => validateSummary(undefined)).toThrow(/summary/)
    expect(() => validateSummary({ fact: 'f', cost: 'c' })).toThrow(/summary\.reVerify/)
    expect(() => validateSummary({ fact: '', cost: 'c', reVerify: 'r' })).toThrow(/summary\.fact/)
    expect(() => validateSummary({ fact: 'f', cost: '   ', reVerify: 'r' })).toThrow(/summary\.cost/)
  })
})

describe('key validation', () => {
  it('accepts short ASCII identifiers with . _ - / and rejects everything else', () => {
    expect(validateKey('dsh-runtime-map')).toBe('dsh-runtime-map')
    expect(validateKey('a.b/c_d-2')).toBe('a.b/c_d-2')
    expect(() => validateKey('')).toThrow(/non-empty/)
    expect(() => validateKey('  ')).toThrow(/non-empty/)
    expect(() => validateKey('has spaces')).toThrow(/ASCII identifier/)
    expect(() => validateKey('中文键')).toThrow(/ASCII identifier/)
    expect(() => validateKey('-starts-with-dash')).toThrow(/ASCII identifier/)
    expect(() => validateKey('x'.repeat(161))).toThrow(/ASCII identifier/)
  })
})

describe('storage and usage counts', () => {
  it('an empty board lists nothing and read misses do not throw', () => {
    const { kernel } = makeKernel()
    expect(kernel.list(BOARD)).toEqual([])
    expect(kernel.read(BOARD, ['nope'])).toEqual({ found: [], missing: ['nope'] })
  })

  it('write creates an entry; list aggregates key/type/summary/counts and NEVER carries content', () => {
    const { kernel } = makeKernel()
    const result = kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    expect(result.status).toBe('created')
    const rows = kernel.list(BOARD)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.key).toBe('dsh-runtime-map')
    expect(row.entryType).toBe('map')
    expect(row.summary).toEqual(entry().summary)
    expect(row.readCount).toBe(0)
    expect(row.subscribeCount).toBe(0)
    expect(Object.hasOwn(row, 'content')).toBe(false)
    expect(kernel.entriesOf(BOARD)[0].content).toBe('full layout notes')
  })

  it('read returns content, increments the read count once per found key, and batches', () => {
    const { kernel } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.write(BOARD, { holderId: A, ...entry({ key: 'second-key' }), ttlMs: TTL })
    const first = kernel.read(BOARD, ['dsh-runtime-map', 'second-key', 'absent'])
    expect(first.found.map((/** @type {any} */ item) => item.key)).toEqual(['dsh-runtime-map', 'second-key'])
    expect(first.missing).toEqual(['absent'])
    expect(first.found[0].content).toBe('full layout notes')
    kernel.read(BOARD, ['dsh-runtime-map'])
    expect(kernel.list(BOARD).find((/** @type {any} */ row) => row.key === 'dsh-runtime-map').readCount).toBe(2)
    expect(kernel.list(BOARD).find((/** @type {any} */ row) => row.key === 'second-key').readCount).toBe(1)
  })

  it('list filters by exact entryType and by case-insensitive query over key and summary', () => {
    const { kernel } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry({ key: 'layout-map' }), ttlMs: TTL })
    kernel.write(BOARD, { holderId: A, ...entry({ key: 'deadend-one', entryType: 'deadend', summary: { fact: 'Vite plugin X does not hot-reload', cost: 'one spike', reVerify: 'touch file, watch' } }), ttlMs: TTL })
    expect(kernel.list(BOARD, { entryType: 'deadend' }).map((/** @type {any} */ row) => row.key)).toEqual(['deadend-one'])
    expect(kernel.list(BOARD, { entryType: 'map' })).toHaveLength(1)
    expect(kernel.list(BOARD, { query: 'VITE' }).map((/** @type {any} */ row) => row.key)).toEqual(['deadend-one'])
    expect(kernel.list(BOARD, { query: 'layout' }).map((/** @type {any} */ row) => row.key)).toEqual(['layout-map'])
    expect(kernel.list(BOARD, { query: 'unheard-of' })).toEqual([])
    expect(kernel.list(BOARD, { query: 'hot-reload', entryType: 'map' })).toEqual([])
  })

  it('an update preserves the entry-lifetime usage counts', () => {
    const { kernel } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.read(BOARD, ['dsh-runtime-map'])
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    const blocker = kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    expect(blocker.status).toBe('contended')
    const updated = kernel.write(BOARD, { holderId: A, ...entry({ summary: { fact: 'updated fact', cost: 're-checked', reVerify: 'ls again' } }), ttlMs: TTL })
    expect(updated.status).toBe('updated')
    const row = kernel.list(BOARD)[0]
    expect(row.summary.fact).toBe('updated fact')
    expect(row.readCount).toBe(1)
    expect(row.subscribeCount).toBe(1)
  })

  it('boards are isolated per root session', () => {
    const { kernel } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    expect(kernel.list('other-session')).toEqual([])
    expect(kernel.entriesOf(BOARD)).toHaveLength(1)
  })
})

describe('arbitration: apply → write → one-shot invalidation', () => {
  it('apply grants a token with the requested TTL; write consumes it', () => {
    const { kernel, clock } = makeKernel()
    const applied = kernel.apply(BOARD, { holderId: A, key: 'k', ttlMs: TTL })
    expect(applied).toEqual({ status: 'granted', key: 'k', holder: A, expiresAt: clock.now() + TTL, ttlMs: TTL, renewed: false, similarKeys: [] })
    expect(clock.pending()).toBe(1)
    expect(kernel.tokensOf(BOARD)).toEqual([{ key: 'k', holder: A, expiresAt: clock.now() + TTL }])
    const written = kernel.write(BOARD, { holderId: A, key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'c', ttlMs: TTL })
    expect(written.status).toBe('created')
    expect(kernel.tokensOf(BOARD)).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it('a write without a token is an explicit failure naming the current holder', () => {
    const { kernel, clock } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    const denied = kernel.write(BOARD, { holderId: A, ...entry({ summary: { fact: 'f2', cost: 'c2', reVerify: 'r2' } }), ttlMs: TTL })
    expect(denied).toEqual({ status: 'no-authority', key: 'dsh-runtime-map', holder: B, expiresAt: clock.now() + TTL })
    // An existing entry with no token at all: holder is null in the refusal.
    kernel.write(BOARD, { holderId: A, ...entry({ key: 'other', summary: { fact: 'f2', cost: 'c2', reVerify: 'r2' } }), ttlMs: TTL })
    const fresh = kernel.write(BOARD, { holderId: A, ...entry({ key: 'other', summary: { fact: 'f3', cost: 'c3', reVerify: 'r3' } }), ttlMs: TTL })
    expect(fresh.status).toBe('no-authority')
    expect(fresh.holder).toBeNull()
  })

  it('the token is one-shot: a second mutation requires a fresh apply', () => {
    const { kernel } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    expect(kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL }).status).toBe('updated')
    expect(kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL }).status).toBe('no-authority')
    expect(kernel.deleteKey(BOARD, { holderId: A, key: 'dsh-runtime-map' }).status).toBe('no-authority')
  })

  it('create acquires the token for the new key inside the same call', () => {
    const { kernel } = makeKernel()
    const created = kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    expect(created.status).toBe('created')
    expect(kernel.tokensOf(BOARD)).toEqual([])
    expect(kernel.entriesOf(BOARD)).toHaveLength(1)
  })

  it('re-applying a key you just released has no contention cost; self-apply renews', () => {
    const { kernel, clock } = makeKernel()
    kernel.apply(BOARD, { holderId: A, key: 'k', ttlMs: TTL })
    const renewed = kernel.apply(BOARD, { holderId: A, key: 'k', ttlMs: TTL })
    expect(renewed.status).toBe('granted')
    expect(renewed.renewed).toBe(true)
    expect(renewed.expiresAt).toBe(clock.now() + TTL)
    kernel.write(BOARD, { holderId: A, key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'c', ttlMs: TTL })
    const again = kernel.apply(BOARD, { holderId: A, key: 'k', ttlMs: TTL })
    expect(again.status).toBe('granted')
    expect(again.renewed).toBe(false)
  })

  it('apply reports similar existing keys as a hint for a new key', () => {
    const { kernel } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry({ key: 'dsh-runtime-map' }), ttlMs: TTL })
    kernel.write(BOARD, { holderId: A, ...entry({ key: 'unrelated' }), ttlMs: TTL })
    const applied = kernel.apply(BOARD, { holderId: A, key: 'runtime-map', ttlMs: TTL })
    expect(applied.similarKeys).toEqual(['dsh-runtime-map'])
    const exact = kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    expect(exact.similarKeys).toEqual([])
  })
})

describe('arbitration: contention and auto-subscription', () => {
  it('applying an occupied key fails and auto-subscribes, counting on the entry', () => {
    const { kernel } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    const blocked = kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    expect(blocked.status).toBe('contended')
    expect(blocked.holder).toBe(A)
    expect(blocked.subscribed).toBe(true)
    expect(kernel.list(BOARD)[0].subscribeCount).toBe(1)
    expect(kernel.subscriptionsOf(BOARD)).toEqual([{ key: 'dsh-runtime-map', subscriberIds: [B] }])
  })

  it('write consuming the token notifies the subscriber and consumes the subscription', () => {
    const { kernel, events } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    expect(events).toEqual([{ boardId: BOARD, key: 'dsh-runtime-map', holder: A, reason: 'write', subscriberIds: [B], at: 1_000_000 }])
    expect(kernel.subscriptionsOf(BOARD)).toEqual([])
    // A release with no waiters stays silent: no event noise for slice 2.
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    expect(events).toHaveLength(1)
  })

  it('create on a key another agent already applied for fails and subscribes too', () => {
    const { kernel } = makeKernel()
    kernel.apply(BOARD, { holderId: A, key: 'unborn', ttlMs: TTL })
    const blocked = kernel.write(BOARD, { holderId: B, key: 'unborn', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'c', ttlMs: TTL })
    expect(blocked.status).toBe('contended')
    expect(blocked.holder).toBe(A)
    // No entry yet → no subscribeCount, but the subscriber waits for the release.
    expect(kernel.list(BOARD)).toEqual([])
    expect(kernel.subscriptionsOf(BOARD)).toEqual([{ key: 'unborn', subscriberIds: [B] }])
  })

  it('delete consumes the token and notifies with the delete reason', () => {
    const { kernel, events } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    const deleted = kernel.deleteKey(BOARD, { holderId: A, key: 'dsh-runtime-map' })
    expect(deleted.status).toBe('deleted')
    expect(events).toEqual([{ boardId: BOARD, key: 'dsh-runtime-map', holder: A, reason: 'delete', subscriberIds: [B], at: 1_000_000 }])
    expect(kernel.entriesOf(BOARD)).toEqual([])
  })

  it('delete requires a token and a live entry', () => {
    const { kernel } = makeKernel()
    expect(kernel.deleteKey(BOARD, { holderId: A, key: 'ghost' })).toEqual({ status: 'missing', key: 'ghost' })
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    expect(kernel.deleteKey(BOARD, { holderId: A, key: 'dsh-runtime-map' }).status).toBe('no-authority')
  })
})

describe('arbitration: expiry, terminate release, board disposal', () => {
  it('TTL expiry releases the token and notifies subscribers (timer-driven)', () => {
    const { kernel, clock, events } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    clock.advance(TTL)
    expect(kernel.tokensOf(BOARD)).toEqual([])
    expect(events).toEqual([{ boardId: BOARD, key: 'dsh-runtime-map', holder: A, reason: 'expire', subscriberIds: [B], at: 1_060_000 }])
    const granted = kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    expect(granted.status).toBe('granted')
    expect(granted.holder).toBe(B)
  })

  it('settlement is read-time authoritative: a lost timer still releases on the next decision', () => {
    let now = 1_000_000
    const kernel = createBlackboardKernel({ now: () => now, setTimer: () => 0, clearTimer: () => {} })
    /** @type {object[]} */
    const events = []
    kernel.onRelease(event => events.push(event))
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    now += TTL
    const granted = kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    expect(granted.status).toBe('granted')
    expect(events).toEqual([{ boardId: BOARD, key: 'dsh-runtime-map', holder: A, reason: 'expire', subscriberIds: [B], at: now }])
    // An expired token never blocks a write either; just inside the TTL it still authorizes one.
    now += TTL - 1
    expect(kernel.write(BOARD, { holderId: B, ...entry(), ttlMs: TTL }).status).toBe('updated')
  })

  it('releaseHolder (terminate path) frees every token an agent holds across boards', () => {
    const { kernel, events } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    kernel.apply(BOARD, { holderId: B, key: 'dsh-runtime-map', ttlMs: TTL })
    kernel.apply('other-board', { holderId: A, key: 'unborn', ttlMs: TTL })
    kernel.apply('other-board', { holderId: B, key: 'unborn', ttlMs: TTL })
    const released = kernel.releaseHolder(A)
    expect(released).toHaveLength(2)
    expect(kernel.tokensOf(BOARD)).toEqual([])
    expect(kernel.tokensOf('other-board')).toEqual([])
    expect(events).toEqual([
      { boardId: BOARD, key: 'dsh-runtime-map', holder: A, reason: 'terminate', subscriberIds: [B], at: 1_000_000 },
      { boardId: 'other-board', key: 'unborn', holder: A, reason: 'terminate', subscriberIds: [B], at: 1_000_000 },
    ])
    // Idempotent: the subscriber set is consumed by the notification.
    expect(kernel.releaseHolder(A)).toEqual([])
    expect(events).toHaveLength(2)
  })

  it('dropBoard clears entries, tokens and pending timers', () => {
    const { kernel, clock } = makeKernel()
    kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: TTL })
    kernel.apply(BOARD, { holderId: A, key: 'dsh-runtime-map', ttlMs: TTL })
    expect(clock.pending()).toBe(1)
    kernel.dropBoard(BOARD)
    expect(kernel.entriesOf(BOARD)).toEqual([])
    expect(kernel.tokensOf(BOARD)).toEqual([])
    expect(kernel.subscriptionsOf(BOARD)).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it('rejects unusable ttlMs and missing holder identity instead of guessing', () => {
    const { kernel } = makeKernel()
    expect(() => kernel.apply(BOARD, { holderId: A, key: 'k', ttlMs: 0 })).toThrow(/ttlMs/)
    expect(() => kernel.apply(BOARD, { holderId: '', key: 'k', ttlMs: TTL })).toThrow(/session identity/)
    expect(() => kernel.write(BOARD, { holderId: A, ...entry(), ttlMs: Number.NaN })).toThrow(/ttlMs/)
  })
})
