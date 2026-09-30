import { describe, expect, it } from './helpers.js'
import { createGroupCoordinator } from '../src/delegate/group-coordinator.js'
import { rehydrateSupervision, applyChildLogRecovery } from '../src/delegate/rehydrate.js'

const record = (session, type, data) => ({ time: 1, session, type, data })

describe('rehydrateSupervision', () => {
  it('replays spawn/seal/settle/resume/terminate facts into a full-confidence registry', () => {
    const records = [
      record('parent-1', 'orrery/supervision/spawn', { kind: 'spawn', childId: 'c1', name: 'alpha', group: 'scan' }),
      record('parent-1', 'orrery/supervision/spawn', { kind: 'spawn', childId: 'c2', name: 'beta', group: 'scan' }),
      record('parent-1', 'orrery/supervision/seal', { kind: 'seal', group: 'scan', memberIds: ['c1', 'c2'] }),
      record('parent-1', 'orrery/supervision/settle', { kind: 'settle', childId: 'c1', status: 'blocked', report: 'stuck' }),
      record('parent-1', 'orrery/supervision/resume', { kind: 'resume', childId: 'c1' }),
      record('parent-1', 'orrery/supervision/settle', { kind: 'settle', childId: 'c1', status: 'completed', report: 'done' }),
      record('parent-1', 'orrery/supervision/terminate', { kind: 'terminate', childId: 'c2', reason: 'redirected' }),
    ]
    const state = rehydrateSupervision({ parentId: 'parent-1', records, catalogChildren: [] })
    expect(state.confidence).toBe('full')
    expect(state.factsSeen).toBe(7)
    const byId = Object.fromEntries(state.children.map((child) => [child.id, child]))
    expect(byId.c1.status).toBe('completed')
    expect(byId.c1.report).toBe('done')
    expect(byId.c2.status).toBe('terminated')
    expect(byId.c2.report).toBe('redirected')
    expect(state.groups).toEqual([
      { name: 'scan', memberIds: ['c1', 'c2'], sealed: true, settled: true },
    ])
    expect(state.untracked).toEqual([])
  })
  it('replays a group-released fact and drops the released group', () => {
    const records = [
      record('parent-1', 'orrery/supervision/spawn', { kind: 'spawn', childId: 'c1', name: 'alpha', group: 'scan' }),
      record('parent-1', 'orrery/supervision/terminate', { kind: 'terminate', childId: 'c1', reason: 'rollback' }),
      record('parent-1', 'orrery/supervision/group-released', { kind: 'group-released', group: 'scan' }),
    ]
    const state = rehydrateSupervision({ parentId: 'parent-1', records, catalogChildren: [] })
    expect(state.groups).toEqual([]) // not live after rebuild
    expect(state.children).toHaveLength(1)
    expect(state.children[0].status).toBe('terminated')
  })

  it('reports partial confidence with untracked catalog children when no facts exist', () => {
    const catalog = [
      { id: 'orphan-1', label: 'leftover', mode: 'continuable' },
      { id: 'job-1', label: 'one-shot', mode: 'one-shot' },
    ]
    const state = rehydrateSupervision({ parentId: 'parent-1', records: [], catalogChildren: catalog })
    expect(state.confidence).toBe('partial')
    expect(state.children).toEqual([])
    expect(state.untracked).toEqual([{ id: 'orphan-1', label: 'leftover', mode: 'continuable' }])
  })

  it('ignores records from other sessions and non-supervision types', () => {
    const records = [
      record('other-session', 'orrery/supervision/spawn', { kind: 'spawn', childId: 'x', name: 'nope', group: 'g' }),
      record('parent-1', 'orrery/intent-hit', { kind: 'spawn', childId: 'y', name: 'nope', group: 'g' }),
      record('parent-1', 'orrery/supervision/spawn', { kind: 'spawn', childId: 'c1', name: 'alpha', group: 'scan' }),
    ]
    const state = rehydrateSupervision({ parentId: 'parent-1', records, catalogChildren: [] })
    expect(state.children).toHaveLength(1)
    expect(state.children[0].id).toBe('c1')
  })

  it('recomputes group settle state from member statuses', () => {
    const records = [
      record('parent-1', 'orrery/supervision/spawn', { kind: 'spawn', childId: 'c1', name: 'alpha', group: 'scan' }),
      record('parent-1', 'orrery/supervision/seal', { kind: 'seal', group: 'scan', memberIds: ['c1'] }),
      record('parent-1', 'orrery/supervision/group-settled', { kind: 'group-settled', group: 'scan' }),
    ]
    const state = rehydrateSupervision({ parentId: 'parent-1', records, catalogChildren: [] })
    // c1 is still running: the recomputed settle state wins over the stale fact.
    expect(state.groups[0].settled).toBe(false)
  })

  it('keeps the recorded durable status for children absent from the catalog', () => {
    const records = [
      record('parent-1', 'orrery/supervision/spawn', { kind: 'spawn', childId: 'c1', name: 'alpha', group: 'scan' }),
      record('parent-1', 'orrery/supervision/settle', { kind: 'settle', childId: 'c1', status: 'completed', report: 'done' }),
    ]
    const state = rehydrateSupervision({ parentId: 'parent-1', records, catalogChildren: [] })
    expect(state.children[0].status).toBe('completed')
    expect(state.untracked).toEqual([])
  })
})
describe('coordinator.hydrate', () => {
  function plainDeps() {
    const notifications = []
    return {
      sendTo: async () => {},
      interruptChild: () => {},
      schedule: () => {},
      notifyParent: (text) => notifications.push(text),
      notifications,
    }
  }

  it('loads a rehydrated snapshot and re-emits one group-settled signal for settled groups', () => {
    const deps = plainDeps()
    const coordinator = createGroupCoordinator(deps)
    const state = {
      children: [
        { id: 'c1', name: 'alpha', group: 'scan', status: 'completed', report: 'alpha done' },
        { id: 'c2', name: 'beta', group: 'scan', status: 'terminated', report: 'redirected' },
      ],
      groups: [{ name: 'scan', memberIds: ['c1', 'c2'], sealed: true, settled: true }],
      untracked: [],
      confidence: 'full',
    }
    coordinator.hydrate(state)
    expect(coordinator.snapshot().children.length).toBe(2)
    expect(coordinator.snapshot().meta.confidence).toBe('full')
    expect(coordinator.snapshot().meta.untracked).toEqual([])
    expect(deps.notifications).toHaveLength(1)
    expect(deps.notifications[0]).toContain('supervised_group_settled')
    expect(deps.notifications[0]).toContain('group="scan"')
    expect(deps.notifications[0]).toContain('members="2"')
    expect(deps.notifications[0]).not.toContain('alpha done')
  })

  it('does not re-emit a group-settled signal for unsettled groups', () => {
    const deps = plainDeps()
    const coordinator = createGroupCoordinator(deps)
    coordinator.hydrate({
      children: [{ id: 'c1', name: 'alpha', group: 'scan', status: 'blocked', report: 'stuck' }],
      groups: [{ name: 'scan', memberIds: ['c1'], sealed: true, settled: false }],
      untracked: [],
      confidence: 'full',
    })
    expect(deps.notifications).toEqual([])
  })

  it('records partial-confidence meta with untracked rows', () => {
    const coordinator = createGroupCoordinator(plainDeps())
    coordinator.hydrate({
      children: [],
      groups: [],
      untracked: [{ id: 'orphan-1', label: 'leftover', mode: 'continuable' }],
      confidence: 'partial',
    })
    expect(coordinator.snapshot().meta).toEqual({
      confidence: 'partial',
      untracked: [{ id: 'orphan-1', label: 'leftover', mode: 'continuable' }],
      hydrated: true,
    })
  })
})

describe('applyChildLogRecovery (L3)', () => {
  const readerOf = (texts) => async (childId) => texts[childId] ?? null

  it('promotes untracked catalog children with a terminal report into the recovered group', async () => {
    const state = {
      children: [],
      groups: [],
      untracked: [{ id: 'orphan-1', label: 'leftover', mode: 'continuable' }, { id: 'orphan-2', label: 'silent', mode: 'continuable' }],
      confidence: 'partial',
    }
    await applyChildLogRecovery(state, readerOf({ 'orphan-1': 'STATUS: completed\nREPORT: shipped before restart' }))
    expect(state.children).toHaveLength(1)
    expect(state.children[0]).toEqual({
      id: 'orphan-1',
      name: 'leftover',
      group: 'recovered',
      status: 'completed',
      report: 'shipped before restart',
      retries: 0,
      lastText: '',
    })
    expect(state.groups).toEqual([{ name: 'recovered', memberIds: ['orphan-1'], sealed: true, settled: true }])
    expect(state.untracked).toEqual([{ id: 'orphan-2', label: 'silent', mode: 'continuable' }])
  })

  it('refines running registry children whose settle fact was lost', async () => {
    const state = {
      children: [
        { id: 'c1', name: 'alpha', group: 'scan', status: 'completed', report: 'done', retries: 0, lastText: '' },
        { id: 'c2', name: 'beta', group: 'scan', status: 'running', report: '', retries: 0, lastText: '' },
      ],
      groups: [{ name: 'scan', memberIds: ['c1', 'c2'], sealed: true, settled: false }],
      untracked: [],
      confidence: 'full',
    }
    await applyChildLogRecovery(state, readerOf({ c2: 'STATUS: blocked\nREPORT: beta stuck' }))
    expect(state.children[1].status).toBe('blocked')
    expect(state.children[1].report).toBe('beta stuck')
    expect(state.groups[0].settled).toBe(false)
  })

  it('marks a group settled when recovery completes its last member', async () => {
    const state = {
      children: [
        { id: 'c1', name: 'alpha', group: 'scan', status: 'completed', report: 'done', retries: 0, lastText: '' },
        { id: 'c2', name: 'beta', group: 'scan', status: 'running', report: '', retries: 0, lastText: '' },
      ],
      groups: [{ name: 'scan', memberIds: ['c1', 'c2'], sealed: true, settled: false }],
      untracked: [],
      confidence: 'full',
    }
    await applyChildLogRecovery(state, readerOf({ c2: 'STATUS: completed\nREPORT: beta done' }))
    expect(state.groups[0].settled).toBe(true)
  })

  it('tolerates reader failures and keeps state honest', async () => {
    const state = {
      children: [{ id: 'c1', name: 'alpha', group: 'scan', status: 'running', report: '', retries: 0, lastText: '' }],
      groups: [{ name: 'scan', memberIds: ['c1'], sealed: true, settled: false }],
      untracked: [{ id: 'orphan-1', label: 'leftover', mode: 'continuable' }],
      confidence: 'partial',
    }
    await applyChildLogRecovery(state, async () => {
      throw new Error('no persistence')
    })
    expect(state.children[0].status).toBe('running')
    expect(state.untracked).toHaveLength(1)
    expect(state.groups[0].settled).toBe(false)
  })

  it('is a no-op when no reader is provided', async () => {
    const state = { children: [], groups: [], untracked: [], confidence: 'partial' }
    const out = await applyChildLogRecovery(state, undefined)
    expect(out).toBe(state)
  })
})
