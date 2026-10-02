// Turn-end settling (design D2/D3): a finished turn that leaves locks behind is
// continued once, asking for each file to be released or kept explicitly. Only
// the durable `completed` reason enters here — the error and stop paths keep
// their own handling — and the disposition after the notices run out is policy.
import { expect, it } from './helpers.js'
import { createSettlementDriver, settlementPrompt } from '../src/edit-lock/settle.js'

/** `onTurnEnd` chains through the domain promise, so a test must let that chain
 * drain rather than assume a single microtask turn. */
async function settle(driver) { await driver.drain() }

const LIMITS = { holdDefaultMinutes: 30, holdSingleMaxMinutes: 30, holdCumulativeMaxMinutes: 120, nudgeAttempts: 2, nudgeFallback: 'release' }

/** A fake domain that records what the driver asked of it. */
function harness(over = {}) {
  const calls = { followup: [], notices: [], released: 0, abnormal: [] }
  /** @type {any} */
  let status = {
    state: 'active',
    locks: [{ resourceId: 'file:a', status: 'active' }],
    retention: { held: false, holdUntil: null, remainingMs: 0, holdCumulativeMs: 0 },
  }
  const domain = {
    status: async () => status,
    releaseHeld: async () => { calls.released++; return { released: status.locks.map(/** @param {any} lock */ lock => lock.resourceId) } },
    classifyAbnormal: async (/** @type {any} */ _agent, /** @type {any} */ reason) => { calls.abnormal.push(reason); return status.locks.map(/** @param {any} lock */ lock => lock.resourceId) },
  }
  const AGENT = { id: 'agent' }
  const driver = createSettlementDriver({
    domainFor: () => domain,
    followup: (_agent, text) => calls.followup.push(text),
    notify: (_agent, text) => calls.notices.push(text),
    limits: () => ({ ...LIMITS, ...over }),
  })
  return {
    calls, driver, domain, agent: AGENT,
    setStatus: (/** @type {any} */ next) => { status = next },
    /** Run one completed turn end and wait for the driver's chained work. */
    turnEnd: async (/** @type {any} */ reason = { kind: 'completed' }) => { driver.onTurnEnd(AGENT, reason); await settle(driver) },
  }
}

it('continues a finished turn that left locks behind, asking for each file', async () => {
  const { calls, turnEnd } = harness()
  await turnEnd()
  expect(calls.followup).toHaveLength(1)
  expect(calls.followup[0]).toContain('file:a')
  expect(calls.followup[0]).toContain('edit_lock_release')
  expect(calls.followup[0]).toContain('edit_lock_hold')
  expect(calls.followup[0]).toContain('notice 1 of 2')
  expect(calls.released).toBe(0)
})

it('does nothing for a clean turn, an error or a user stop', async () => {
  for (const reason of [{ kind: 'aborted' }, { kind: 'error', error: new Error('x') }]) {
    const { calls, turnEnd } = harness()
    await turnEnd(reason)
    expect(calls.followup).toHaveLength(0)
    expect(calls.released).toBe(0)
    expect(calls.abnormal).toHaveLength(0)
  }
  const clean = harness()
  clean.setStatus({ state: 'active', locks: [], retention: { held: false, holdUntil: null, remainingMs: 0, holdCumulativeMs: 0 } })
  await clean.turnEnd()
  expect(clean.calls.followup).toHaveLength(0)
})

it('asks at most the configured number of times, then applies the disposition', async () => {
  const { calls, turnEnd } = harness({ nudgeAttempts: 2 })
  await turnEnd()
  await turnEnd()
  expect(calls.followup).toHaveLength(2)
  expect(calls.followup[1]).toContain('notice 2 of 2')
  // The third finished turn does not nag again: the locks are released instead.
  await turnEnd()
  expect(calls.followup).toHaveLength(2)
  expect(calls.released).toBe(1)
  expect(calls.notices.join(' ')).toMatch(/released for other sessions/)
})

it('flags the locks for a human when the fallback is configured to abnormal', async () => {
  const { calls, turnEnd } = harness({ nudgeAttempts: 1, nudgeFallback: 'abnormal' })
  await turnEnd()
  await turnEnd()
  expect(calls.followup).toHaveLength(1)
  expect(calls.released).toBe(0)
  expect(calls.abnormal).toEqual(['unsettled-after-notices'])
  expect(calls.notices.join(' ')).toMatch(/flagged for the user to sort out/)
})

it('a notice budget of zero goes straight to the disposition', async () => {
  const { calls, turnEnd } = harness({ nudgeAttempts: 0 })
  await turnEnd()
  expect(calls.followup).toHaveLength(0)
  expect(calls.released).toBe(1)
})

it('a locked file inside its reservation period is left alone', async () => {
  const { calls, turnEnd, setStatus } = harness()
  setStatus({
    state: 'active',
    locks: [{ resourceId: 'file:a', status: 'active' }],
    retention: { held: true, holdUntil: 2_000_000, remainingMs: 60_000, holdCumulativeMs: 30 * 60_000 },
  })
  await turnEnd()
  await turnEnd()
  expect(calls.followup).toHaveLength(0)
  expect(calls.released).toBe(0)
  // The expiry timer owns what happens next, so the driver stays silent.
  expect(calls.notices).toHaveLength(0)
})

it('only ordinary ownership is settled, never abnormal or pending locks', async () => {
  const { calls, turnEnd, setStatus } = harness()
  setStatus({
    state: 'recovering',
    locks: [{ resourceId: 'file:a', status: 'abnormal', reason: 'provider-error' }, { resourceId: 'file:b', status: 'pending-confirmation' }],
    retention: { held: false, holdUntil: null, remainingMs: 0, holdCumulativeMs: 0 },
  })
  await turnEnd()
  expect(calls.followup).toHaveLength(0)
  expect(calls.released).toBe(0)
})

it('reports the remaining retention budget in the notice', async () => {
  const { calls, turnEnd, setStatus } = harness({ holdCumulativeMaxMinutes: 120, holdSingleMaxMinutes: 30 })
  setStatus({
    state: 'active',
    locks: [{ resourceId: 'file:a', status: 'active' }],
    retention: { held: false, holdUntil: null, remainingMs: 0, holdCumulativeMs: 90 * 60_000 },
  })
  await turnEnd()
  expect(calls.followup[0]).toContain('30 minutes left in this batch')
})

it('says plainly when the budget is gone, instead of offering a reservation', async () => {
  const prompt = settlementPrompt([{ resourceId: 'file:a' }], 1, 2, {
    defaultMinutes: 30, singleMaxMinutes: 30, cumulativeMaxMinutes: 120, remainingMinutes: 0,
  })
  expect(prompt).toContain('no new reservation is available')
  expect(prompt).not.toContain('edit_lock_hold')
})

it('a domain failure is reported and never releases anything', async () => {
  const warnings = []
  const driver = createSettlementDriver({
    domainFor: () => ({ status: async () => { throw new Error('boom') } }),
    followup: () => { throw new Error('must not continue') },
    notify: () => {},
    limits: () => LIMITS,
    warn: message => warnings.push(message),
  })
  driver.onTurnEnd({ id: 'agent' }, { kind: 'completed' })
  await driver.drain()
  expect(warnings.join(' ')).toMatch(/boom/)
})

it('closed driver stops settling', async () => {
  const { calls, driver, turnEnd } = harness()
  driver.close()
  await turnEnd()
  expect(calls.followup).toHaveLength(0)
})

it('the turn a notice starts does not reset the count, so the fallback really fires', async () => {
  const { calls, driver, turnEnd, agent } = harness({ nudgeAttempts: 2 })
  // completed turn -> notice 1 -> its own turn starts -> ends without acting -> ...
  await turnEnd()
  driver.turnStarted(agent)
  await turnEnd()
  driver.turnStarted(agent)
  await turnEnd()
  expect(calls.followup).toHaveLength(2)
  expect(calls.released).toBe(1)
})

it('a user turn after a notice still restarts the count', async () => {
  const { calls, driver, turnEnd, agent } = harness({ nudgeAttempts: 1 })
  await turnEnd()
  driver.turnStarted(agent) // the notice's own turn
  driver.turnStarted(agent) // the user's next turn
  await turnEnd()
  expect(calls.followup).toHaveLength(2)
  expect(calls.released).toBe(0)
})
