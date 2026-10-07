// Session blackboard promotion-request delivery tests (design D6, slice 3):
// the complete UserMessage shape with the producer tag (never 'user'), the
// synchronous liveness refusal, timer deferral (never synchronous), followup
// when idle / steer when busy, the status re-check at delivery time, and the
// bounded retry with the final failure warned. Fake clock — no runtime, no
// session.append anywhere.
import { describe, expect, it } from '../helpers.js'
import { createPromotionRequester, MAX_DELIVERY_ATTEMPTS, PROMOTION_NOTICE_PREFIX, PROMOTION_SOURCE_KIND } from '../../src/blackboard/promote.js'

/** A deterministic fake clock whose advance(ms) fires due timers in order. */
function createClock(start = 1_000_000) {
  let now = start
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map()
  let seq = 0
  return {
    now: () => now,
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, timer] = due
        timers.delete(id)
        now = timer.at
        timer.fn()
      }
      now = target
    },
    setTimer(fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    pending() { return timers.size },
  }
}

/** @param {{ status?: string, deliver?: (message: object) => void | Promise<void> }} [options] */
function makeAgent({ status = 'idle', deliver } = {}) {
  const messages = []
  return {
    messages,
    status,
    steer(message) {
      messages.push({ channel: 'steer', message })
      return deliver?.(message)
    },
    followup(message) {
      messages.push({ channel: 'followup', message })
      return deliver?.(message)
    },
  }
}

function makeRequester(resolveMainAgent) {
  const clock = createClock()
  const warnings = []
  const requester = createPromotionRequester({
    resolveMainAgent,
    template: `${PROMOTION_NOTICE_PREFIX} — the full evaluation brief body`,
    logger: { warn: (message) => warnings.push(message) },
    setTimer: clock.setTimer,
  })
  return { requester, clock, warnings }
}

describe('promotion request delivery (D6: complete message, producer tag, deferral, steer/followup)', () => {
  it('deferred delivery: followup to an idle main agent, steer to a busy one', () => {
    const idle = makeAgent({ status: 'idle' })
    const busy = makeAgent({ status: 'running' })
    const { requester, clock } = makeRequester(() => idle)
    const idleRequest = requester({ id: 'root-session', session: { header: { delegationDepth: 0 } } })
    expect(idleRequest).toEqual({ requested: true, channel: 'followup' })
    // Delivery is deferred: nothing happened synchronously.
    expect(idle.messages).toHaveLength(0)
    expect(clock.pending()).toBe(1)
    clock.advance(0)
    expect(idle.messages).toHaveLength(1)
    expect(idle.messages[0].channel).toBe('followup')
    const { requester: busyRequester, clock: busyClock } = makeRequester(() => busy)
    busyRequester({ id: 'root-session', session: { header: { delegationDepth: 0 } } })
    busyClock.advance(0)
    expect(busy.messages).toHaveLength(1)
    expect(busy.messages[0].channel).toBe('steer')
  })

  it('the delivered message is a complete UserMessage with the producer tag, never "user"', () => {
    const agent = makeAgent({ status: 'idle' })
    const { requester, clock } = makeRequester(() => agent)
    requester({ id: 'root-session', session: { header: { delegationDepth: 0 } } })
    clock.advance(0)
    const { message } = agent.messages[0]
    expect(message.role).toBe('user')
    expect(typeof message.id).toBe('string')
    expect(Array.isArray(message.content)).toBe(true)
    expect(message.content[0].type).toBe('text')
    expect(message.content[0].text.startsWith(PROMOTION_NOTICE_PREFIX)).toBe(true)
    expect(message.source.kind).toBe(PROMOTION_SOURCE_KIND)
    expect(message.source.kind).not.toBe('user')
  })

  it('refuses synchronously when the main agent is not live, with no timer armed', () => {
    const { requester, clock } = makeRequester(() => undefined)
    expect(() => requester({ id: 'child-session', session: { header: { delegationDepth: 1, parentSession: 'root-session' } } })).toThrow(/main agent is not live/)
    expect(clock.pending()).toBe(0)
  })

  it('re-checks the status at delivery time: a busy flip mid-deferral steers instead of followups', () => {
    const agent = makeAgent({ status: 'idle' })
    const { requester, clock } = makeRequester(() => agent)
    requester({ id: 'root-session', session: { header: { delegationDepth: 0 } } })
    agent.status = 'running'
    clock.advance(0)
    expect(agent.messages[0].channel).toBe('steer')
  })

  it('retries a failing delivery up to the cap, then warns and stops', async () => {
    let failures = 0
    const agent = makeAgent({
      status: 'idle',
      deliver: () => {
        failures += 1
        return Promise.reject(new Error('delivery blew up'))
      },
    })
    const { requester, clock, warnings } = makeRequester(() => agent)
    requester({ id: 'root-session', session: { header: { delegationDepth: 0 } } })
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setImmediate(resolve))
      clock.advance(attempt === 0 ? 0 : 200 * attempt)
		}
		// The final rejection's catch (the give-up warning) runs on a microtask
		// after the last timer fired.
		await new Promise((resolve) => setImmediate(resolve))
    expect(failures).toBe(MAX_DELIVERY_ATTEMPTS)
    expect(agent.messages).toHaveLength(MAX_DELIVERY_ATTEMPTS)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/promotion brief delivery failed after 3 attempts/)
  })
})
