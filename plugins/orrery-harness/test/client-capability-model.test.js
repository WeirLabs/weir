// Client view-model for the capability Badge and manager (tasks 12.2/12.3/12.5).
import { test, expect } from './helpers.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

function loadModel() {
  const source = readFileSync(fileURLToPath(new URL('../lib/client.capability-model.js', import.meta.url)), 'utf8')
  const loaded = {}
  const sandbox = { __ModuleLoader__: { load: ({ factory }) => { loaded.exports = factory(() => { throw new Error('zero-dependency chunk') }) } } }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return loaded.exports
}

const realmless = (value) => JSON.parse(JSON.stringify(value))
const model = Object.fromEntries(Object.entries(loadModel()).map(([key, fn]) => [key, (...args) => realmless(fn(...args))]))

test('12.2 the Badge reports applied counts from the server receipt, warnings separate, draft never optimistic', () => {
  const receipt = { status: 'applied', effective: { skills: ['a', 'b'], mcpServers: ['docs'] }, warnings: ['fixture-a-unavailable'] }
  const state = model.badgeStateOf(receipt, { dirty: true })
  expect(state.applied).toEqual({ skills: 2, mcpServers: 1 })
  expect(state.unavailable).toEqual(['fixture-a-unavailable'])
  expect(state.draftDirty).toBe(true)
  expect(state.known).toBe(true)
  // A blank session (no receipt yet) is distinct from an applied-zero session.
  expect(model.badgeStateOf(null, null).known).toBe(false)
})

test('12.2 the manager partitions skills with source labels and MCP into managed/unmanaged', () => {
  const partition = model.partitionManagerListing({
    skills: [
      { name: 'deep-work', description: 'x', scope: 'orrery-builtin', status: 'parsed', selected: true },
      { name: 'tool-skill', description: 'y', scope: 'project', status: 'parsed', selected: false, conflict: true },
    ],
    mcpServers: [
      { identity: 'docs', state: 'mounted' },
      { identity: 'gamma', state: 'unmanaged' },
    ],
  })
  expect(partition.skills[0].source).toBe('Orrery builtin')
  expect(partition.skills[1].source).toBe('project')
  expect(partition.skills[1].conflict).toBe(true)
  expect(partition.mcpManaged.map((server) => server.identity)).toEqual(['docs'])
  expect(partition.mcpUnmanaged.map((server) => server.identity)).toEqual(['gamma'])
})

test('12.2 unsupported conditions stay explicit, loading and unknown stay distinct', () => {
  expect(model.managerConditionState([])).toBe('supported')
  expect(model.managerConditionState(['exec.signal unavailable'])).toBe('unsupported')
  expect(model.managerConditionState(null)).toBe('unknown')
})

test('12.3 commit states: request ID reused, failure keeps the draft, conflict shows current state', () => {
  expect(model.commitStateOf({ phase: 'submitting', requestId: 'r-1' })).toEqual({ phase: 'submitting', requestId: 'r-1' })
  const failed = model.commitStateOf({ phase: 'failed', requestId: 'r-1', error: 'revision moved' })
  expect(failed.draftKept).toBe(true)
  expect(failed.requestId).toBe('r-1')
  const conflict = model.commitStateOf({ phase: 'revision-conflict', current: { revision: 5, skills: ['a'] } })
  expect(conflict.current.revision).toBe(5)
  expect(conflict.draftKept).toBe(true)
  expect(model.commitStateOf({ phase: 'indeterminate', requestId: 'r-2' }).queryable).toBe(true)
})

test('12.3 a no-diff draft with missing warnings offers install/configure instead of a fictional Apply', () => {
  const state = model.commitStateOf({ dirty: true, hasDiff: false, missing: ['fixture-a'] })
  expect(state.phase).toBe('install-or-configure')
  expect(state.missing).toEqual(['fixture-a'])
  expect(model.commitStateOf({ dirty: true, hasDiff: true }).phase).toBe('ready')
})

test('12.3 closing a dirty draft offers discard or keep editing', () => {
  expect(model.closeDirtyDraft('discard')).toEqual({ phase: 'idle', draft: null })
  expect(model.closeDirtyDraft('keep')).toEqual({ phase: 'ready', keepEditing: true })
})

test('12.5 second-window frames refresh only the named session; no subscription degrades to a refresh hint', () => {
  expect(model.frameRefreshesSession({ sessionId: 's-1' }, 's-1')).toBe(true)
  expect(model.frameRefreshesSession({ sessionId: 's-2' }, 's-1')).toBe(false)
  expect(model.frameRefreshesSession(null, 's-1')).toBe(false)
  expect(model.convergenceHintOf({ subscribed: true })).toBeNull()
  expect(model.convergenceHintOf({ subscribed: false })).toBe('refresh to sync')
})
