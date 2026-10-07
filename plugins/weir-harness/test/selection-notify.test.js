// Task 12.4 of the session-capability-manager change: the model-facing
// removal notification — net-change merging, the advisory template, the
// consumption seam, and the exclusion guarantees.
import { test, expect } from './helpers.js'
import { mergeNetChanges, notificationText, createSelectionNotifier, NOTIFY_SOURCE } from '../src/capabilities/selection-notify.js'
import { isGenuineUserMessage } from '../src/shared/runtime-messages.js'
import { userTextMessage } from '../src/shared/user-message.js'

test('12.4 net changes merge across queued applications (add-then-remove nets out both)', () => {
  expect(mergeNetChanges({ added: [], removed: [] }, { added: ['a', 'b'], removed: [] })).toEqual({ added: ['a', 'b'], removed: [] })
  expect(mergeNetChanges({ added: ['a', 'b'], removed: [] }, { added: [], removed: ['a'] })).toEqual({ added: ['b'], removed: [] })
  expect(mergeNetChanges({ added: [], removed: ['x'] }, { added: ['x'], removed: [] })).toEqual({ added: [], removed: [] })
  expect(mergeNetChanges({ added: ['a'], removed: [] }, { added: ['a'], removed: [] })).toEqual({ added: ['a'], removed: [] })
})

test('12.4 the advisory template states the change, the not-a-user-message mark, and both boundaries', () => {
  const text = notificationText({ added: ['research'], removed: ['deep-work', 'docs'] })
  expect(text).toContain('not a user message')
  expect(text).toContain('Removed: deep-work, docs.')
  expect(text).toContain('Added: research.')
  expect(text).toContain('already handed off')
  expect(text).toContain('may still complete')
  expect(text).not.toContain('retracted from history')
  expect(text).toContain('no prior turn or call is retracted or erased')
  expect(notificationText({ added: [], removed: [] })).toBeNull()
})

test('12.4 the notifier queues, merges and consumes exactly once per session', () => {
  const notifier = createSelectionNotifier()
  notifier.queue('s1', { added: ['a'] })
  notifier.queue('s1', { removed: ['b'] })
  notifier.queue('s2', { added: ['x'] })
  expect(notifier.has('s1')).toBe(true)
  const pending = notifier.consume('s1')
  expect(pending.net).toEqual({ added: ['a'], removed: ['b'] })
  expect(notifier.has('s1')).toBe(false)
  expect(notifier.consume('s1')).toBeNull()
  expect(notifier.has('s2')).toBe(true)
})

test('12.4 the injected message is excluded from genuine-user detection (intent gate / continuation by construction)', () => {
  const message = userTextMessage(notificationText({ added: [], removed: ['a'] }), NOTIFY_SOURCE)
  expect(message.role).toBe('user')
  expect(message.source.kind).toBe('weir-selection-notify')
  expect(isGenuineUserMessage(message)).toBe(false)
})
