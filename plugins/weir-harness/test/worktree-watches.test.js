// Lane-state watches: the pure registry module (src/worktree/watches.js) and
// the English notification templates. Service-level behavior (hit delivery,
// timers, restart pruning, multi-instance races) lives in
// test/worktree-lanes.test.js.
import { describe, expect, it } from './helpers.js'
import { STATES, TRANSIENT, WATCHABLE } from '../src/worktree/state.js'
import { renderWatchExpired, renderWatchHit } from '../src/worktree/prompts.js'
import {
  DEFAULT_WATCH_TIMEOUT_MINUTES, collectWatchHits, createWatch, normalizeWatchStates,
  pruneExpiredWatches, removeWatchForExpiry, upsertWatch, watchFacts, watchTimeoutMinutesOf,
} from '../src/worktree/watches.js'

const watch = (overrides = {}) => ({
  id: 'w1', laneId: 'a-001', sessionId: 's1', states: ['landable'], createdAt: 1000, expiresAt: 2000, ...overrides,
})

describe('WATCHABLE state set', () => {
  it('is exactly STATES minus TRANSIENT, and contains no transient state', () => {
    expect(WATCHABLE).toEqual(STATES.filter((state) => !TRANSIENT.includes(state)))
    expect(WATCHABLE).toHaveLength(13)
    for (const state of TRANSIENT) expect(WATCHABLE.includes(state)).toBe(false)
    for (const state of ['landable', 'no-commits', 'landed', 'abandoned', 'ready']) expect(WATCHABLE.includes(state)).toBe(true)
    expect(Object.isFrozen(WATCHABLE)).toBe(true)
  })
})

describe('normalizeWatchStates', () => {
  it('accepts conclusion states and dedupes them', () => {
    expect(normalizeWatchStates(['landable', 'abandoned', 'landable'])).toEqual(['landable', 'abandoned'])
  })

  it('refuses an empty list and non-array input with UNWATCHABLE_STATE', () => {
    for (const input of [[], undefined, null, 'landable']) {
      try {
        normalizeWatchStates(input)
        expect('accepted').toBe('refused')
      } catch (error) {
        expect(error.code).toBe('UNWATCHABLE_STATE')
        expect(error.data.watchable).toEqual([...WATCHABLE])
      }
    }
  })

  it('refuses transient and unknown states and creates nothing', () => {
    for (const input of [['working'], ['landable', 'checking'], ['preparing'], ['awaiting-approval'], ['bogus-state']]) {
      try {
        normalizeWatchStates(input)
        expect('accepted').toBe('refused')
      } catch (error) {
        expect(error.code).toBe('UNWATCHABLE_STATE')
      }
    }
  })
})

describe('watchTimeoutMinutesOf', () => {
  it('defaults to 360, floors, enforces the 1-minute minimum, and tolerates junk', () => {
    expect(DEFAULT_WATCH_TIMEOUT_MINUTES).toBe(360)
    expect(watchTimeoutMinutesOf(undefined)).toBe(360)
    expect(watchTimeoutMinutesOf({})).toBe(360)
    expect(watchTimeoutMinutesOf({ watchTimeoutMinutes: 90 })).toBe(90)
    expect(watchTimeoutMinutesOf({ watchTimeoutMinutes: 90.9 })).toBe(90)
    expect(watchTimeoutMinutesOf({ watchTimeoutMinutes: 1 })).toBe(1)
    expect(watchTimeoutMinutesOf({ watchTimeoutMinutes: 0 })).toBe(360)
    expect(watchTimeoutMinutesOf({ watchTimeoutMinutes: -5 })).toBe(360)
    expect(watchTimeoutMinutesOf({ watchTimeoutMinutes: Number.NaN })).toBe(360)
    expect(watchTimeoutMinutesOf({ watchTimeoutMinutes: 'soon' })).toBe(360)
  })
})

describe('createWatch', () => {
  it('freezes expiresAt from the timeout current at subscribe time', () => {
    const entry = createWatch({ id: 'w', laneId: 'a-001', sessionId: 's1', states: ['landable'], now: 60_000, timeoutMinutes: 90 })
    expect(entry).toEqual({ id: 'w', laneId: 'a-001', sessionId: 's1', states: ['landable'], createdAt: 60_000, expiresAt: 60_000 + 90 * 60_000 })
  })
})

describe('upsertWatch (replace semantics)', () => {
  it('replaces the same (sessionId, laneId) watch and keeps every other watch', () => {
    const ledger = { watches: [watch({ id: 'old' }), watch({ id: 'other-session', sessionId: 's2' }), watch({ id: 'other-lane', laneId: 'b-002' })] }
    const entry = watch({ id: 'new', states: ['abandoned'], expiresAt: 3000 })
    const replaced = upsertWatch(ledger, entry)
    expect(replaced.id).toBe('old')
    expect(ledger.watches.map((entry) => entry.id)).toEqual(['other-session', 'other-lane', 'new'])
    expect(ledger.watches.at(-1).states).toEqual(['abandoned'])
  })

  it('inserts cleanly when there is nothing to replace', () => {
    const ledger = { watches: [] }
    expect(upsertWatch(ledger, watch())).toBe(null)
    expect(ledger.watches).toHaveLength(1)
  })
})

describe('collectWatchHits', () => {
  it('removes only the watches whose lane reached a target state', () => {
    const ledger = { watches: [
      watch({ id: 'hit', states: ['landable', 'abandoned'] }),
      watch({ id: 'state-miss', states: ['abandoned'] }),
      watch({ id: 'lane-miss', laneId: 'b-002', states: ['landable'] }),
    ] }
    const hits = collectWatchHits(ledger, { id: 'a-001', state: 'landable' })
    expect(hits.map((entry) => entry.id)).toEqual(['hit'])
    expect(ledger.watches.map((entry) => entry.id).sort()).toEqual(['lane-miss', 'state-miss'])
  })

  it('leaves the array untouched when nothing matches', () => {
    const ledger = { watches: [watch()] }
    expect(collectWatchHits(ledger, { id: 'a-001', state: 'no-commits' })).toEqual([])
    expect(ledger.watches).toHaveLength(1)
  })
})

describe('pruneExpiredWatches', () => {
  it('removes watches at or past the deadline and keeps the live ones', () => {
    const ledger = { watches: [watch({ id: 'expired', expiresAt: 2000 }), watch({ id: 'boundary', expiresAt: 3000 }), watch({ id: 'live', expiresAt: 3001 })] }
    const pruned = pruneExpiredWatches(ledger, 3000)
    expect(pruned.map((entry) => entry.id)).toEqual(['expired', 'boundary'])
    expect(ledger.watches.map((entry) => entry.id)).toEqual(['live'])
  })
})

describe('removeWatchForExpiry', () => {
  it('removes the expired watch by id, exactly once', () => {
    const ledger = { watches: [watch({ id: 'w1', expiresAt: 2000 })] }
    expect(removeWatchForExpiry(ledger, 'w1', 2000)?.id).toBe('w1')
    expect(ledger.watches).toHaveLength(0)
    // the losing instance of the race finds nothing and delivers nothing
    expect(removeWatchForExpiry(ledger, 'w1', 2000)).toBe(null)
  })

  it('does nothing for an unknown id or a watch not yet expired', () => {
    const ledger = { watches: [watch({ id: 'w1', expiresAt: 2000 })] }
    expect(removeWatchForExpiry(ledger, 'nope', 5000)).toBe(null)
    expect(removeWatchForExpiry(ledger, 'w1', 1999)).toBe(null)
    expect(ledger.watches).toHaveLength(1)
  })
})

describe('watchFacts', () => {
  it('counts the lane watches and unions their states', () => {
    const watches = [watch({ id: 'a', states: ['landable', 'abandoned'] }), watch({ id: 'b', sessionId: 's2', states: ['abandoned', 'no-commits'] }), watch({ id: 'c', laneId: 'b-002' })]
    expect(watchFacts(watches, 'a-001')).toEqual({ watchCount: 2, watchStates: ['landable', 'abandoned', 'no-commits'] })
    expect(watchFacts(watches, 'b-002')).toEqual({ watchCount: 1, watchStates: ['landable'] })
    expect(watchFacts(undefined, 'a-001')).toEqual({ watchCount: 0, watchStates: [] })
  })
})

describe('watch notification templates (English)', () => {
  it('the hit notice names the lane, the reached state, and the next-step hint', () => {
    const lane = { id: 'fix-001', state: 'landable', landableTree: 'abcdef1234', base: { branch: 'main' } }
    expect(renderWatchHit(lane)).toBe('[worktree] watch hit: lane fix-001 reached landable → next: worktree_land({"lane":"fix-001"})')
  })

  it('the expiry notice names the lane and the watched target states', () => {
    const text = renderWatchExpired(watch({ laneId: 'fix-001', states: ['landable', 'abandoned'] }))
    expect(text).toContain('lane fix-001')
    expect(text).toContain('landable, abandoned')
    expect(text).toContain('watch expired')
  })
})
