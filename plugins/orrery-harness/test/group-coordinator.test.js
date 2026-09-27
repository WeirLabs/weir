import { describe, expect, it } from './helpers.js'
import { createGroupCoordinator, parseTerminalStatus, SUPERVISION_CONTRACT } from '../src/delegate/group-coordinator.js'

describe('parseTerminalStatus', () => {
  it('parses completed with a report body', () => {
    expect(parseTerminalStatus('STATUS: completed\nREPORT: shipped the fix, tests green')).toEqual({
      status: 'completed',
      report: 'shipped the fix, tests green',
    })
  })

  it('parses blocked with a multiline report', () => {
    const parsed = parseTerminalStatus('some preamble\nSTATUS: blocked\nREPORT: no access to the registry\ntried: A, B\nneed: credentials')
    expect(parsed.status).toBe('blocked')
    expect(parsed.report).toContain('no access to the registry')
    expect(parsed.report).toContain('need: credentials')
  })

  it('returns null without a STATUS marker', () => {
    expect(parseTerminalStatus('all done, no marker here')).toBeNull()
    expect(parseTerminalStatus('')).toBeNull()
    expect(parseTerminalStatus(undefined)).toBeNull()
  })

  it('is strict about the keyword casing', () => {
    expect(parseTerminalStatus('status: completed')).toBeNull()
  })
})

describe('group coordinator', () => {
  function fakeDeps() {
    const sent = []
    const interrupted = []
    const scheduled = []
    const audits = []
    return {
      sent,
      interrupted,
      scheduled,
      audits,
      sendTo: async (childId, text) => sent.push({ childId, text }),
      interruptChild: (childId) => interrupted.push(childId),
      schedule: (delayMs, fn) => scheduled.push({ delayMs, fn }),
      onAudit: (note) => audits.push(note),
    }
  }

  function groupOfTwo(deps) {
    const coordinator = createGroupCoordinator(deps)
    coordinator.assertGroupAvailable('scan')
    coordinator.registerMember({ id: 'c1', name: 'alpha', group: 'scan' })
    coordinator.registerMember({ id: 'c2', name: 'beta', group: 'scan' })
    coordinator.sealGroup('scan')
    return coordinator
  }

  it('rejects insertion into a live group but allows reuse after settlement', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    expect(() => coordinator.assertGroupAvailable('scan')).toThrow(/does not accept insertion/)

    coordinator.noteAssistantText('c1', 'STATUS: completed\nREPORT: one')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    coordinator.noteAssistantText('c2', 'STATUS: completed\nREPORT: two')
    await coordinator.onTurnEnd('c2', { kind: 'completed' })

    coordinator.assertGroupAvailable('scan') // settled group name is reusable
  })

  it('settles completed members and emits one merged report in assignment order', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: completed\nREPORT: alpha done')
    expect(await coordinator.onTurnEnd('c1', { kind: 'completed' })).toBe('settled')
    expect(coordinator.drainOutbox()).toHaveLength(0) // group not complete yet

    coordinator.noteAssistantText('c2', 'STATUS: completed\nREPORT: beta done')
    await coordinator.onTurnEnd('c2', { kind: 'completed' })
    const notices = coordinator.drainOutbox()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('supervised_group_report')
    expect(notices[0]).toContain('group="scan"')
    expect(notices[0].indexOf('alpha done') < notices[0].indexOf('beta done')).toBe(true)
  })

  it('delivers a blocked report promptly, ahead of the group merge', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: blocked\nREPORT: need api key')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    const notices = coordinator.drainOutbox()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('supervised_blocked')
    expect(notices[0]).toContain('need api key')
    expect(notices[0]).toContain('resume_agent')
    // group still open: no merged report
    expect(notices[0]).not.toContain('supervised_group_report')
  })

  it('nudges a child that ended without a STATUS marker', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'just some chatter, no status')
    expect(await coordinator.onTurnEnd('c1', { kind: 'completed' })).toBe('nudged')
    expect(deps.sent).toHaveLength(1)
    expect(deps.sent[0].childId).toBe('c1')
    expect(deps.sent[0].text).toContain('STATUS: completed')
  })

  it('schedules backoff retries on provider errors with doubling delays', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    expect(await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '429' } })).toBe('retry-scheduled')
    expect(await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '429' } })).toBe('retry-scheduled')
    expect(deps.scheduled.map((s) => s.delayMs)).toEqual([30_000, 60_000])
    // firing the timer sends the retry message
    await deps.scheduled[0].fn()
    expect(deps.sent[0].text).toContain('provider error')
  })

  it('marks blocked after exhausting nudges on missing status', async () => {
    const deps = fakeDeps()
    const coordinator = createGroupCoordinator(deps, { maxRetries: 2 })
    coordinator.assertGroupAvailable('g')
    coordinator.registerMember({ id: 'c1', name: 'alpha', group: 'g' })
    coordinator.sealGroup('g')
    for (let round = 0; round < 3; round++) {
      coordinator.noteAssistantText('c1', `chatter ${round}`)
      await coordinator.onTurnEnd('c1', { kind: 'completed' })
    }
    expect(coordinator.memberByRef('c1').status).toBe('blocked')
    expect(coordinator.memberByRef('c1').report).toContain('exhausted')
    const notices = coordinator.drainOutbox()
    expect(notices.some((n) => n.includes('supervised_blocked'))).toBe(true)
  })

  it('marks blocked after exhausting provider-error retries', async () => {
    const deps = fakeDeps()
    const coordinator = createGroupCoordinator(deps, { maxRetries: 2 })
    coordinator.assertGroupAvailable('g')
    coordinator.registerMember({ id: 'c1', name: 'alpha', group: 'g' })
    coordinator.sealGroup('g')
    await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    expect(await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })).toBe('settled')
    expect(coordinator.memberByRef('c1').status).toBe('blocked')
    expect(coordinator.memberByRef('c1').report).toContain('provider-error')
  })

  it('never auto-continues a user interruption', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    expect(await coordinator.onTurnEnd('c1', { kind: 'aborted', reason: { kind: 'user' } })).toBe('settled')
    expect(deps.sent).toHaveLength(0)
    expect(coordinator.memberByRef('c1').status).toBe('blocked')
    expect(coordinator.memberByRef('c1').report).toContain('Interrupted by the user')
  })

  it('treats non-user aborts as termination', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    await coordinator.onTurnEnd('c1', { kind: 'aborted', reason: { kind: 'parent' } })
    expect(coordinator.memberByRef('c1').status).toBe('terminated')
  })

  it('resumes a blocked child with context and resets its counter', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: blocked\nREPORT: stuck')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })

    const resumed = await coordinator.resume('alpha', 'the registry is back up')
    expect(resumed.status).toBe('running')
    expect(coordinator.memberByRef('c1').retries).toBe(0)
    expect(deps.sent.at(-1).text).toContain('the registry is back up')
    expect(deps.sent.at(-1).text).toContain('resume_context')
  })

  it('rejects resume for non-blocked or unknown children', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    await expect(async () => coordinator.resume('alpha', 'x')).rejects.toThrow(/not blocked/)
    await expect(async () => coordinator.resume('ghost', 'x')).rejects.toThrow(/no supervised child/)
  })

  it('terminates a running child with a real interrupt', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    const outcome = coordinator.terminate('alpha', 'direction changed')
    expect(outcome.interrupted).toBe(true)
    expect(deps.interrupted).toEqual(['c1'])
    expect(coordinator.memberByRef('c1').status).toBe('terminated')
    expect(coordinator.memberByRef('c1').report).toBe('direction changed')
  })

  it('terminates a blocked child as pure bookkeeping', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: blocked\nREPORT: stuck')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    coordinator.drainOutbox()

    const outcome = coordinator.terminate('alpha')
    expect(outcome.interrupted).toBe(false)
    expect(deps.interrupted).toHaveLength(0)
    expect(coordinator.memberByRef('c1').status).toBe('terminated')
  })

  it('counts termination toward group completion', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.terminate('c1', 'redirected')
    coordinator.noteAssistantText('c2', 'STATUS: completed\nREPORT: beta done')
    await coordinator.onTurnEnd('c2', { kind: 'completed' })
    const notices = coordinator.drainOutbox()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('terminated')
    expect(notices[0]).toContain('beta done')
  })
})
