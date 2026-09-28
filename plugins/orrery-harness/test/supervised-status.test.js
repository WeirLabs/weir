import { describe, expect, it } from './helpers.js'
import { createGroupCoordinator } from '../src/delegate/group-coordinator.js'
import { createStatusTool, renderStatus, digestReport } from '../src/delegate/status-tool.js'

/** Build a real coordinator with stubbed effectors (no DSH imports). */
function makeCoordinator() {
  return createGroupCoordinator({
    sendTo: async () => {},
    interruptChild: () => {},
    schedule: () => {},
  })
}

function makeTool({ coordinator, listChildren }) {
  return createStatusTool({
    coordinatorFor: () => coordinator,
    listChildren: listChildren ?? (async () => []),
  })
}

const execStub = () => ({ agent: { id: 'parent-session', session: { header: { delegationDepth: 0 } } }, signal: undefined })

describe('supervised_status tool', () => {
  it('renders every member status, group assignment, and group settle state', async () => {
    const coordinator = makeCoordinator()
    coordinator.registerMember({ id: 'child-1', name: 'alpha', group: 'scan' })
    coordinator.registerMember({ id: 'child-2', name: 'beta', group: 'scan' })
    coordinator.sealGroup('scan')
    coordinator.noteAssistantText('child-1', 'STATUS: blocked\nREPORT: beta stuck on missing input')
    await coordinator.onTurnEnd('child-1', { kind: 'completed' })
    coordinator.drainOutbox() // discard the blocked notice

    const tool = makeTool({ coordinator })
    const value = await tool.execute({}, execStub())
    const text = renderStatus(value)
    expect(text).toContain('alpha (child-1) — blocked — group "scan"')
    expect(text).toContain('beta (child-2) — running — group "scan"')
    expect(text).toContain('retries 0')
    expect(text).toContain('report: beta stuck on missing input')
    expect(text).toContain('group "scan" — 2 member(s) — sealed, not settled')
    expect(text).toContain('No untracked continuable children in the DSH catalog.')
  })

  it('reports an empty registry rather than an error', async () => {
    const tool = makeTool({ coordinator: makeCoordinator() })
    const value = await tool.execute({}, execStub())
    const text = renderStatus(value)
    expect(text).toContain('No supervised children in this registry.')
    expect(text).toContain('No supervised groups in this registry.')
  })

  it('flags catalog continuable children that the registry does not track', async () => {
    const coordinator = makeCoordinator()
    const listChildren = async () => [
      { id: 'child-1', label: 'tracked', mode: 'continuable' },
      { id: 'orphan-9', label: 'leftover from before restart', mode: 'continuable' },
      { id: 'oneshot-1', label: 'one-shot job', mode: 'one-shot' },
    ]
    coordinator.registerMember({ id: 'child-1', name: 'alpha', group: 'scan' })
    coordinator.sealGroup('scan')

    const tool = makeTool({ coordinator, listChildren })
    const value = await tool.execute({}, execStub())
    const text = renderStatus(value)
    expect(text).toContain('orphan-9 — label "leftover from before restart" — mode continuable')
    expect(text).not.toContain('oneshot-1')
    expect(text).not.toContain('label "tracked"') // child-1 is tracked: never listed as untracked
  })

  it('reports the cross-check as unavailable when the catalog read fails', async () => {
    const tool = makeTool({
      coordinator: makeCoordinator(),
      listChildren: async () => {
        throw new Error('no subagents service')
      },
    })
    const value = await tool.execute({}, execStub())
    const text = renderStatus(value)
    expect(text).toContain('Untracked-catalog cross-check unavailable')
  })

  it('is depth-gated to the main agent', async () => {
    const tool = makeTool({ coordinator: makeCoordinator() })
    const childExec = () => ({ agent: { id: 'child-x', session: { header: { delegationDepth: 1 } } }, signal: undefined })
    await expect(async () => tool.execute({}, childExec())).rejects.toThrow(/only the main agent/)
  })

  it('has an object-rooted schema with no required arguments', () => {
    const tool = makeTool({ coordinator: makeCoordinator() })
    expect(tool.parameters.type).toBe('object')
    expect(tool.parameters.required).toBeUndefined()
  })

  it('surfaces the rehydration confidence marker when present', async () => {
    const coordinator = makeCoordinator()
    coordinator.meta = { confidence: 'partial' }
    const tool = makeTool({ coordinator })
    const value = await tool.execute({}, execStub())
    const text = renderStatus(value)
    expect(text).toContain('rehydration confidence: partial')
  })
})

describe('digestReport', () => {
  it('truncates long reports to one line', () => {
    const long = 'x'.repeat(500)
    const digest = digestReport(long)
    expect(digest.length).toBe(201)
    expect(digest.endsWith('…')).toBe(true)
  })

  it('returns short reports unchanged', () => {
    expect(digestReport('ok')).toBe('ok')
  })
})
