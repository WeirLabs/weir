// Status view contract (design D6): the panel derives colour and controls from
// this shape, so wording can change without breaking it, and technical
// identifiers stay out of the primary fields.
import { expect, it } from './helpers.js'
import { buildView, shortName, unavailableView, VIEW_STATES } from '../src/edit-lock/view.js'

const base = (over = {}) => ({ sessionId: 's1', state: 'active', interrupted: false, executionEpoch: 2, locks: [], recovery: null, retention: null, ...over })
const lock = (resourceId, owner = 's1', status = 'active', extra = {}) => ({ resourceId, owner, generation: 3, status, ...extra })
const view = (status, locks = status.locks) => buildView({ status, locks, cwd: '/w', root: '/w', mode: 'publisher', now: 1 })

it('names files relative to the work directory and leaves outside paths whole', () => {
  expect(shortName('/w/src/a.ts', '/w')).toBe('src/a.ts')
  expect(shortName('/elsewhere/b.ts', '/w')).toBe('/elsewhere/b.ts')
  expect(shortName('/w/a.ts', undefined)).toBe('/w/a.ts')
})

it('derives one state per session, in precedence order', () => {
  expect(view(base()).state).toBe('idle')
  expect(view(base({ locks: [lock('/w/a')] })).state).toBe('editing')
  expect(view(base({ locks: [lock('/w/a')], retention: { held: true, holdUntil: 9, remainingMs: 60_000, holdCumulativeMs: 60_000 } })).state).toBe('holding')
  expect(view(base({ locks: [lock('/w/a', 's1', 'pending-confirmation')] })).state).toBe('confirm')
  expect(view(base({ state: 'recovering', locks: [lock('/w/a', 's1', 'abnormal', { reason: 'provider-error' })] })).state).toBe('attention')
  // Stopped wins over everything: the session cannot act until a human continues.
  expect(view(base({ state: 'stopped', locks: [lock('/w/a', 's1', 'abnormal', { reason: 'x' })] })).state).toBe('stopped')
  for (const state of ['idle', 'editing', 'holding', 'confirm', 'attention', 'stopped', 'unavailable']) expect(VIEW_STATES.includes(state)).toBe(true)
})

it('an expired reservation is ordinary editing, not holding', () => {
  expect(view(base({ locks: [lock('/w/a')], retention: { held: true, holdUntil: 1, remainingMs: 0, holdCumulativeMs: 60_000 } })).state).toBe('editing')
})

it('gives each row at most one action, and none for a file another session is actively editing', () => {
  const status = base({ locks: [lock('/w/mine'), lock('/w/wait', 's1', 'pending-confirmation')] })
  const files = view(status, [...status.locks, lock('/w/busy', 's2'), lock('/w/stuck', 's3', 'abnormal', { reason: 'provider-error' }), lock('/w/stopped', 's4', 'user-interrupted')]).files
  const by = Object.fromEntries(files.map(file => [file.name, file]))
  expect(by.mine.action).toBe('release')
  expect(by.wait.action).toBe('confirm')
  expect(by.busy.action).toBe(null)
  expect(by.stuck.action).toBe('unlock')
  expect(by.stopped.action).toBe('unlock')
  // Own files first, then files that need a human, then the rest.
  expect(files.map(file => file.name)).toEqual(['mine', 'wait', 'stopped', 'stuck', 'busy'])
})

it('keeps technical identifiers out of the primary fields', () => {
  const status = base({ locks: [lock('/w/a.txt')] })
  const result = view(status)
  const primary = { state: result.state, files: result.files.map(({ name, mine, status: s, action }) => ({ name, mine, s, action })) }
  expect(JSON.stringify(primary)).not.toContain('/w/a.txt')
  expect(JSON.stringify(primary)).not.toContain('generation')
  expect(result.files[0].detail).toEqual({ path: '/w/a.txt', owner: 's1', generation: 3 })
  expect(result.technical).toEqual({ sessionId: 's1', executionEpoch: 2, root: '/w', mode: 'publisher', at: 1 })
})

it('reports a reservation as minutes and an expiry, and recovery only when it ran', () => {
  const result = view(base({ locks: [lock('/w/a')], retention: { held: true, holdUntil: 5_000, remainingMs: 90_000, holdCumulativeMs: 1_800_000 }, recovery: { attempts: 0, elapsedMs: 0, pauseMs: 0 } }))
  expect(result.hold).toEqual({ until: 5_000, remainingMinutes: 2, usedMinutes: 30 })
  expect(result.recovery).toBe(null)
  const failing = view(base({ state: 'recovering', locks: [lock('/w/a', 's1', 'abnormal', { reason: 'x' })], recovery: { attempts: 2, elapsedMs: 31_000, pauseMs: 0 } }))
  expect(failing.recovery).toEqual({ attempts: 2, elapsedSeconds: 31, pauseMinutes: 0 })
})

it('an unresolvable session renders as an action-free unavailable view', () => {
  const result = unavailableView()
  expect(result.state).toBe('unavailable')
  expect(result.files).toEqual([])
  expect(result.technical).toBe(null)
})
