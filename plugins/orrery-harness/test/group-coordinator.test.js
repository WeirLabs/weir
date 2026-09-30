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
    const facts = []
    const notifications = []
    return {
      sent,
      interrupted,
      scheduled,
      audits,
      facts,
      notifications,
      sendTo: async (childId, text) => sent.push({ childId, text }),
      interruptChild: (childId) => interrupted.push(childId),
      schedule: (delayMs, fn) => scheduled.push({ delayMs, fn }),
      onAudit: (note) => audits.push(note),
      onFact: (fact) => facts.push(fact),
      notifyParent: (text) => notifications.push(text),
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

  it('settles members and emits one group-settled signal once every terminal notice is observed', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: completed\nREPORT: alpha done')
    expect(await coordinator.onTurnEnd('c1', { kind: 'completed' })).toBe('settled')
    expect(deps.notifications).toHaveLength(0) // group not complete yet

    coordinator.noteAssistantText('c2', 'STATUS: completed\nREPORT: beta done')
    await coordinator.onTurnEnd('c2', { kind: 'completed' })
    expect(deps.notifications).toHaveLength(0) // ordering gate: no notices observed yet

    coordinator.noteSettlementNotice('c1')
    expect(deps.notifications).toHaveLength(0) // still missing c2's notice
    coordinator.noteSettlementNotice('c2')
    expect(deps.notifications).toHaveLength(1)
    expect(deps.notifications[0]).toContain('supervised_group_settled')
    expect(deps.notifications[0]).toContain('group="scan"')
    expect(deps.notifications[0]).toContain('members="2"')
    expect(deps.notifications[0]).not.toContain('alpha done') // bodies ride the built-in settlement notices
    expect(deps.notifications[0]).not.toContain('beta done')
  })

  it('ignores a pre-terminal notice (nudged/resumed child) for the ordering gate', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: blocked\nREPORT: stuck')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    coordinator.noteSettlementNotice('c1') // blocked-era notice: status not terminal
    expect(deps.notifications).toHaveLength(0)

    await coordinator.resume('c1', 'unblocked')
    coordinator.noteAssistantText('c1', 'STATUS: completed\nREPORT: alpha finally done')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    coordinator.noteAssistantText('c2', 'STATUS: completed\nREPORT: beta done')
    await coordinator.onTurnEnd('c2', { kind: 'completed' })
    expect(deps.notifications).toHaveLength(0) // gate still closed: c1's terminal notice missing
    coordinator.noteSettlementNotice('c2')
    expect(deps.notifications).toHaveLength(0)
    coordinator.noteSettlementNotice('c1') // terminal notice arrives last, after the signal would have fired
    expect(deps.notifications).toHaveLength(1)
  })

  it('falls back to a bounded delayed delivery when a member notice never arrives', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: completed\nREPORT: alpha done')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    coordinator.noteSettlementNotice('c1')
    coordinator.noteAssistantText('c2', 'STATUS: completed\nREPORT: beta done')
    await coordinator.onTurnEnd('c2', { kind: 'completed' })
    expect(deps.notifications).toHaveLength(0)
    const fallback = deps.scheduled.at(-1)
    expect(fallback.delayMs).toBe(1000)
    await fallback.fn()
    expect(deps.notifications).toHaveLength(1)
    expect(deps.notifications[0]).toContain('supervised_group_settled')
  })

  it('emits no parent notice on a blocked settle (the built-in settlement channel carries it)', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: blocked\nREPORT: need api key')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    expect(deps.notifications).toHaveLength(0)
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.memberOf('c1').report).toBe('need api key')
    expect(deps.facts.at(-1)).toEqual({ kind: 'settle', childId: 'c1', status: 'blocked', report: 'need api key' })
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
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.memberOf('c1').report).toContain('exhausted')
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
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.memberOf('c1').report).toContain('provider-error')
  })

  it('never auto-continues a user interruption', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    expect(await coordinator.onTurnEnd('c1', { kind: 'aborted', reason: { kind: 'user' } })).toBe('settled')
    expect(deps.sent).toHaveLength(0)
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.memberOf('c1').report).toContain('Interrupted by the user')
  })

  it('treats non-user aborts as termination', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    await coordinator.onTurnEnd('c1', { kind: 'aborted', reason: { kind: 'parent' } })
    expect(coordinator.memberOf('c1').status).toBe('terminated')
  })

  it('resumes a blocked child with context and resets its counter', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: blocked\nREPORT: stuck')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })

    const resumed = await coordinator.resume('alpha', 'the registry is back up')
    expect(resumed.status).toBe('running')
    expect(coordinator.memberOf('c1').retries).toBe(0)
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
    expect(coordinator.memberOf('c1').status).toBe('terminated')
    expect(coordinator.memberOf('c1').report).toBe('direction changed')
  })

  it('terminates a blocked child as pure bookkeeping', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: blocked\nREPORT: stuck')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })

    const outcome = coordinator.terminate('alpha')
    expect(outcome.interrupted).toBe(false)
    expect(deps.interrupted).toHaveLength(0)
    expect(coordinator.memberOf('c1').status).toBe('terminated')
  })

  it('counts termination toward group completion and emits the settle signal after both notices', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.terminate('c1', 'redirected')
    coordinator.noteAssistantText('c2', 'STATUS: completed\nREPORT: beta done')
    await coordinator.onTurnEnd('c2', { kind: 'completed' })
    expect(deps.notifications).toHaveLength(0) // ordering gate
    coordinator.noteSettlementNotice('c1')
    coordinator.noteSettlementNotice('c2')
    expect(deps.notifications).toHaveLength(1)
    expect(deps.notifications[0]).toContain('supervised_group_settled')
    expect(deps.notifications[0]).not.toContain('beta done')
  })

  it('emits structured facts across the full supervision lifecycle', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    expect(deps.facts.slice(0, 3)).toEqual([
      { kind: 'spawn', childId: 'c1', name: 'alpha', group: 'scan' },
      { kind: 'spawn', childId: 'c2', name: 'beta', group: 'scan' },
      { kind: 'seal', group: 'scan', memberIds: ['c1', 'c2'] },
    ])

    coordinator.noteAssistantText('c1', 'STATUS: completed\nREPORT: alpha done')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    expect(deps.facts.at(-1)).toEqual({ kind: 'settle', childId: 'c1', status: 'completed', report: 'alpha done' })

    coordinator.noteAssistantText('c2', 'STATUS: blocked\nREPORT: beta stuck')
    await coordinator.onTurnEnd('c2', { kind: 'completed' })
    expect(deps.facts.at(-1)).toEqual({ kind: 'settle', childId: 'c2', status: 'blocked', report: 'beta stuck' })

    await coordinator.resume('c2', 'unblocked')
    expect(deps.facts.at(-1)).toEqual({ kind: 'resume', childId: 'c2' })

    coordinator.terminate('c2', 'redirected')
    expect(deps.facts.at(-2)).toEqual({ kind: 'terminate', childId: 'c2', reason: 'redirected' })
    expect(deps.facts.at(-1)).toEqual({ kind: 'group-settled', group: 'scan' })

    coordinator.terminate('c1', 'done elsewhere')
    expect(deps.facts.at(-1)).toEqual({ kind: 'terminate', childId: 'c1', reason: 'done elsewhere' })
  })

  it('records settle facts with verbatim report bodies', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    const report = 'line one\nline two\nneeds: x'
    coordinator.noteAssistantText('c1', `STATUS: blocked\nREPORT: ${report}`)
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    const settle = deps.facts.find((fact) => fact.kind === 'settle')
    expect(settle.report).toBe(report)
  })

  it('releases a failed-batch group name: unsealed and all members terminated', async () => {
    const deps = fakeDeps()
    const coordinator = createGroupCoordinator(deps)
    coordinator.assertGroupAvailable('scan')
    coordinator.registerMember({ id: 'c1', name: 'alpha', group: 'scan' })
    coordinator.registerMember({ id: 'c2', name: 'beta', group: 'scan' })
    // no sealGroup: a failed batch never seals
    coordinator.terminate('c1', 'rollback')
    coordinator.terminate('c2', 'rollback')
    coordinator.releaseGroup('scan')
    expect(deps.facts.at(-1)).toEqual({ kind: 'group-released', group: 'scan' })
    expect(coordinator.groupLive('scan')).toBe(false)
    coordinator.assertGroupAvailable('scan') // name reusable
  })

  it('refuses to release a sealed group or a group with live members', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    expect(() => coordinator.releaseGroup('scan')).toThrow(/cannot be released/) // sealed
    const unsealed = createGroupCoordinator(deps)
    unsealed.registerMember({ id: 'c1', name: 'alpha', group: 'open' })
    expect(() => unsealed.releaseGroup('open')).toThrow(/cannot be released/) // running member
    let threw = false
    try {
      unsealed.releaseGroup('ghost') // never registered: no-op
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  it('degrades a failed nudge delivery to blocked with an audit note', async () => {
    const deps = fakeDeps()
    deps.sendTo = async () => { throw new Error('sendMessage down') }
    const coordinator = createGroupCoordinator(deps)
    coordinator.registerMember({ id: 'c1', name: 'alpha', group: 'g' })
    coordinator.sealGroup('g')
    coordinator.noteAssistantText('c1', 'chatter')
    expect(await coordinator.onTurnEnd('c1', { kind: 'completed' })).toBe('settled')
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.memberOf('c1').report).toContain('Nudge delivery failed')
    expect(deps.audits.some((note) => note.includes('nudge delivery failed'))).toBe(true)
  })

  it('degrades a failed retry delivery to blocked (scheduled timer path)', async () => {
    const deps = fakeDeps()
    deps.sendTo = async () => { throw new Error('sendMessage down') }
    const coordinator = createGroupCoordinator(deps, { maxRetries: 2 })
    coordinator.registerMember({ id: 'c1', name: 'alpha', group: 'g' })
    coordinator.sealGroup('g')
    await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '429' } })
    expect(deps.scheduled).toHaveLength(1)
    await deps.scheduled[0].fn()
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.memberOf('c1').report).toContain('Retry delivery failed')
  })

  it('reverts a failed resume delivery to blocked and throws', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    coordinator.noteAssistantText('c1', 'STATUS: blocked\nREPORT: stuck')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    deps.sendTo = async () => { throw new Error('sendMessage down') }
    await expect(async () => coordinator.resume('alpha', 'back up')).rejects.toThrow(/could not deliver resume context/)
    expect(coordinator.memberOf('c1').status).toBe('blocked')
  })

  // --- Live supervision tuning (volatile settings commit) ------------------
  // spec: category-delegation / "volatile 设置在同一进程内即提交即生效".
  // A coordinator is long-lived (one per parent session), so a settings commit
  // has to reach the running instance, not just the next one.

  it('setSupervision tightens the retry cap for an already-running child', async () => {
    const deps = fakeDeps()
    const coordinator = createGroupCoordinator(deps, { maxRetries: 5 })
    coordinator.assertGroupAvailable('g')
    coordinator.registerMember({ id: 'c1', name: 'alpha', group: 'g' })
    coordinator.sealGroup('g')

    // one provider-error retry, well under the original cap of 5
    await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    expect(coordinator.memberOf('c1').status).toBe('running')

    // the settings commit lands while the child is still running
    coordinator.setSupervision({ maxRetries: 1 })

    const outcome = await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    expect(outcome).toBe('settled')
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.memberOf('c1').report).toContain('provider-error')
  })

  it('setSupervision retunes the backoff without touching registry state', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    // settle one member so there is observable registry state to preserve
    coordinator.noteAssistantText('c1', 'STATUS: completed\nREPORT: one')
    await coordinator.onTurnEnd('c1', { kind: 'completed' })
    const before = coordinator.memberOf('c2')

    coordinator.setSupervision({ initialBackoffMs: 1000, maxBackoffMs: 2000 })

    // registry untouched: same members, same statuses, same retry counters
    expect(coordinator.memberOf('c1').status).toBe('completed')
    expect(coordinator.memberOf('c2')).toEqual(before) // copy semantics: field-deep equal, not identity

    // and the new backoff governs the next scheduled retry
    await coordinator.onTurnEnd('c2', { kind: 'error', error: { message: '500' } })
    expect(deps.scheduled.at(-1).delayMs).toBe(1000)
  })

  it('setSupervision ignores keys outside the three tuning values', async () => {
    const deps = fakeDeps()
    const coordinator = groupOfTwo(deps)
    // a caller must not be able to smuggle state in through the settings door
    coordinator.setSupervision({ maxRetries: 1, children: new Map(), groups: new Map(), meta: { hijacked: true } })
    await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    const outcome = await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    expect(outcome).toBe('settled')
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.snapshot().meta?.hijacked).toBe(undefined)
  })
  it('a tightened cap settles a mid-flight child exactly once', async () => {
    // 3.3 boundary: the new cap can land below the child's current retry count.
    // The very next decision must terminate it — and further turn ends must not
    // re-settle it (a duplicate settle would emit a second durable fact and
    // perturb group completion).
    const deps = fakeDeps()
    const coordinator = createGroupCoordinator(deps, { maxRetries: 5 })
    coordinator.assertGroupAvailable('g')
    coordinator.registerMember({ id: 'c1', name: 'alpha', group: 'g' })
    coordinator.sealGroup('g')

    // build up a retry count that the new cap will sit below
    await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    expect(coordinator.memberOf('c1').status).toBe('running')

    coordinator.setSupervision({ maxRetries: 1 })
    expect(await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })).toBe('settled')
    expect(coordinator.memberOf('c1').status).toBe('blocked')

    const settles = deps.facts.filter((fact) => fact.kind === 'settle' && fact.childId === 'c1')
    expect(settles).toHaveLength(1)
    const retriesScheduled = deps.scheduled.length

    // A late turn end can still reach a blocked child (blocked, unlike
    // completed/terminated, is not filtered out of turn-end processing). What
    // must hold is that the exhausted budget is never re-armed: no further
    // retry is scheduled and the status stays blocked. Re-settling emits an
    // extra durable fact, but applyFact is idempotent for settle, so restart
    // rehydration is unaffected.
    await coordinator.onTurnEnd('c1', { kind: 'error', error: { message: '500' } })
    expect(deps.scheduled.length).toBe(retriesScheduled)
    expect(coordinator.memberOf('c1').status).toBe('blocked')
    expect(coordinator.memberOf('c1').retries).toBe(2)
    // the blocked verdict text is the exhaustion one either way
    expect(coordinator.memberOf('c1').report).toContain('exhausted')
  })
})
