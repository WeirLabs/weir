// Task 12.4 of the session-capability-manager change: the model-facing
// removal notification — net-change merging, the advisory template, the durable
// queue seam (durable-pending-notice), and the exclusion guarantees.
import { test, expect, storePlatformSkip } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mergeNetChanges, notificationText, createSelectionNotifier, selectionDelta, NOTIFY_SOURCE } from '../src/capabilities/selection-notify.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'
import { isGenuineUserMessage } from '../src/shared/runtime-messages.js'
import { userTextMessage } from '../src/shared/user-message.js'

/** A throwaway store root: the notifier's queue is a real durable unit. */
async function noticeStore(t) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'weir-notice-queue-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    await rm(root, { recursive: true, force: true })
  })
  const open = () => openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  return { root, store: open(), reopen: open }
}

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

// durable-pending-notice 5.3: the queue is durable, so "queued" means written
// to the store unit and "consumed" means cleared after delivery. A fresh
// notifier over the same root — a restarted host process — sees the obligation.
test('12.4 the notifier queues, merges and clears exactly once per session (durable)', { skip: storePlatformSkip }, async t => {
  const { store, reopen } = await noticeStore(t)
  const notifier = createSelectionNotifier({ store })
  notifier.queueSync('s1', { added: ['a'] })
  notifier.queueSync('s1', { removed: ['b'] })
  notifier.queueSync('s2', { added: ['x'] })
  expect(notifier.has('s1')).toBe(true)
  // A restarted process reports the same obligation…
  const restarted = createSelectionNotifier({ store: reopen() })
  const pending = await restarted.pending('s1')
  expect(pending).toEqual({ added: ['a'], removed: ['b'], revision: 2 })
  expect(restarted.has('s1')).toBe(true)
  // …and only delivery clears it, exactly once.
  expect((await notifier.clearDelivered('s1', pending)).status).toBe('cleared')
  expect(notifier.has('s1')).toBe(false)
  expect(await notifier.pending('s1')).toBeNull()
  expect(await createSelectionNotifier({ store: reopen() }).pending('s1')).toBeNull()
  expect(notifier.has('s2')).toBe(true)
})

test('12.4 the injected message is excluded from genuine-user detection (intent gate / continuation by construction)', () => {
  const message = userTextMessage(notificationText({ added: [], removed: ['a'] }), NOTIFY_SOURCE)
  expect(message.role).toBe('user')
  expect(message.source.kind).toBe('weir-selection-notify')
  expect(isGenuineUserMessage(message)).toBe(false)
})

// --- apply-delta-durable-basis (design D1): the pure delta function ----------
// selectionDelta(previousSets, acceptedSets) owns the exact name semantics the
// committed-apply inline diff had: skill identities map to display names, MCP
// server names pass through, both lists sort, a nameless entry never leaks.

const idOf = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })

test('selectionDelta maps skill identities to display names, passes MCP names through, sorts the combined lists', () => {
  const before = { skills: [idOf('user', 'alpha'), idOf('project', 'beta')], mcpServers: ['mcp-a'] }
  const after = { skills: [idOf('project', 'beta'), idOf('user', 'gamma')], mcpServers: ['mcp-b'] }
  expect(selectionDelta(before, after)).toEqual({ added: ['gamma', 'mcp-b'], removed: ['alpha', 'mcp-a'] })
})

test('selectionDelta returns an empty delta for equal sets (the notice suppresses it)', () => {
  const sets = { skills: [idOf('user', 'alpha')], mcpServers: ['mcp-a'] }
  expect(selectionDelta(sets, sets)).toEqual({ added: [], removed: [] })
  expect(selectionDelta({ skills: [], mcpServers: [] }, { skills: [], mcpServers: [] })).toEqual({ added: [], removed: [] })
})

test('selectionDelta tolerates missing arrays and drops nameless identities', () => {
  expect(selectionDelta({}, {})).toEqual({ added: [], removed: [] })
  expect(selectionDelta(null, undefined)).toEqual({ added: [], removed: [] })
  expect(selectionDelta({ skills: [{ name: '' }, null, {}], mcpServers: [] }, { skills: [], mcpServers: [] })).toEqual({ added: [], removed: [] })
  expect(selectionDelta({ skills: [], mcpServers: [] }, { skills: [null, idOf('user', 'alpha')], mcpServers: null })).toEqual({ added: ['alpha'], removed: [] })
})
