// Session blackboard release-notification delivery tests: the message
// templates per reason, the producer-tagged user message shape, steer-while-
// busy / followup-when-idle delivery, timer deferral (never synchronous), the
// bounded retry with the final failure warned, and the skip of unknown or
// gone subscribers. Fake clock — no runtime, no session.append anywhere.
import { describe, expect, it } from '../helpers.js'
import { createReleaseNotifier, MAX_DELIVERY_ATTEMPTS, RELEASE_NOTICE_PREFIX, RELEASE_SOURCE_KIND, renderReleaseNotice } from '../../src/blackboard/notify.js'

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

/** @param {{ agents?: Map<string, any>, parentOf?: (childId: string) => string | undefined, subagents?: any }} [options] */
function makeNotifier({ agents = new Map(), parentOf, subagents } = {}) {
  const clock = createClock()
  const warnings = []
  const notifier = createReleaseNotifier({
    agents: () => ({ get: (id) => agents.get(id) }),
    parentOf,
    subagents: () => subagents,
    logger: { warn: (message) => warnings.push(message) },
    setTimer: clock.setTimer,
  })
  return { notifier, clock, warnings }
}

const EVENT = { key: 'probe.key', reason: 'write', subscriberIds: ['agent-a', 'agent-b'] }

describe('release notice templates (English, notification-framed)', () => {
  it('renders the write/expire/terminate clause with the re-apply pointer', () => {
    for (const reason of ['write', 'expire', 'terminate']) {
      const text = renderReleaseNotice({ key: 'k', reason })
      expect(text.startsWith(`${RELEASE_NOTICE_PREFIX}:`)).toBe(true)
      expect(text).toContain('"k"')
      expect(text).toContain('blackboard_apply again')
      expect(text).toContain('automatic board notification, not a user instruction')
    }
  })

  it('renders the delete clause with the key-gone framing', () => {
    const text = renderReleaseNotice({ key: 'k', reason: 'delete' })
    expect(text).toContain('was deleted')
    expect(text).toContain('blackboard_apply')
    expect(text).toContain('not a user instruction')
  })
})

describe('subscription delivery (D3: timer-deferred, steer/followup, bounded retry)', () => {
  it('steers into a busy subscriber and followups an idle one, both deferred and producer-tagged', () => {
    const busy = makeAgent({ status: 'running' })
    const idle = makeAgent({ status: 'idle' })
    const { notifier, clock } = makeNotifier({ agents: new Map([['agent-a', busy], ['agent-b', idle]]) })
    notifier(EVENT)
    // Delivery is deferred: nothing happened synchronously.
    expect(busy.messages).toHaveLength(0)
    expect(idle.messages).toHaveLength(0)
    expect(clock.pending()).toBe(2)
    clock.advance(0)
    expect(busy.messages).toHaveLength(1)
    expect(busy.messages[0].channel).toBe('steer')
    expect(idle.messages).toHaveLength(1)
    expect(idle.messages[0].channel).toBe('followup')
    for (const agent of [busy, idle]) {
      const { message } = agent.messages[0]
      expect(message.role).toBe('user')
      expect(message.source.kind).toBe(RELEASE_SOURCE_KIND)
      expect(message.content[0].text).toContain(RELEASE_NOTICE_PREFIX)
    }
    expect(clock.pending()).toBe(0)
  })

  it('skips unknown, empty, and gone subscribers without delivering anything', () => {
    const { notifier, clock } = makeNotifier({ agents: new Map() })
    notifier({ key: 'k', reason: 'expire', subscriberIds: ['ghost', '', 7] })
    expect(clock.pending()).toBe(0)
  })

  it('retries a failed delivery up to MAX_DELIVERY_ATTEMPTS and warns once on the final failure', async () => {
    const failing = makeAgent({ status: 'running', deliver: () => { throw new Error('steer refused') } })
    const { notifier, clock, warnings } = makeNotifier({ agents: new Map([['agent-a', failing]]) })
    notifier({ key: 'k', reason: 'write', subscriberIds: ['agent-a'] })
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      clock.advance(attempt === 1 ? 0 : 200 * (attempt - 1))
      await tick()
      expect(failing.messages).toHaveLength(attempt)
      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        expect(warnings).toHaveLength(0)
        expect(clock.pending()).toBe(1)
      }
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/release notice delivery to "agent-a" failed after 3 attempts: steer refused/)
    expect(clock.pending()).toBe(0)
  })

  it('a rejected promise outcome retries the same way (async failures included)', async () => {
    const failing = makeAgent({ status: 'idle', deliver: () => Promise.reject(new Error('followup refused')) })
    const { notifier, clock, warnings } = makeNotifier({ agents: new Map([['agent-a', failing]]) })
    notifier({ key: 'k', reason: 'terminate', subscriberIds: ['agent-a'] })
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    clock.advance(0)
    await tick()
    clock.advance(200)
    await tick()
    clock.advance(400)
    await tick()
    expect(failing.messages).toHaveLength(MAX_DELIVERY_ATTEMPTS)
    expect(warnings).toHaveLength(1)
  })

  it('an empty subscriber list delivers nothing (the kernel already gates on waiters)', () => {
    const agent = makeAgent({ status: 'idle' })
    const { notifier, clock } = makeNotifier({ agents: new Map([['agent-a', agent]]) })
    notifier({ key: 'k', reason: 'write', subscriberIds: [] })
    clock.advance(1000)
    expect(agent.messages).toHaveLength(0)
  })

  it('a child between turns (no live agent) receives the notice through its live parent', async () => {
    const sent = []
    const parent = makeAgent({ status: 'running' })
    const { notifier, clock } = makeNotifier({
      agents: new Map([['parent', parent]]),
      parentOf: (childId) => (childId === 'child-9' ? 'parent' : undefined),
      subagents: { sendMessage: (owner, childId, blocks, options) => { sent.push({ owner, childId, blocks, options }); return Promise.resolve() } },
    })
    notifier({ key: 'k', reason: 'write', subscriberIds: ['child-9'] })
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    clock.advance(0)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0].owner).toBe(parent)
    expect(sent[0].childId).toBe('child-9')
    expect(sent[0].blocks[0].type).toBe('text')
    expect(sent[0].blocks[0].text).toContain(RELEASE_NOTICE_PREFIX)
    expect(sent[0].options.signal).toBeTruthy()
  })

  it('a child between turns whose parent is unavailable retries and warns on the final failure', async () => {
    const sent = []
    const { notifier, clock, warnings } = makeNotifier({
      parentOf: () => 'gone-parent',
      subagents: { sendMessage: (...args) => { sent.push(args); return Promise.resolve() } },
    })
    notifier({ key: 'k', reason: 'write', subscriberIds: ['child-9'] })
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    clock.advance(0)
    await tick()
    clock.advance(200)
    await tick()
    clock.advance(400)
    await tick()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/its parent agent is unavailable/)
  })

  it('a child between turns without a parentSession reference is skipped silently', async () => {
    const sent = []
    const { notifier, clock } = makeNotifier({
      parentOf: () => undefined,
      subagents: { sendMessage: (...args) => { sent.push(args); return Promise.resolve() } },
    })
    notifier({ key: 'k', reason: 'write', subscriberIds: ['child-9'] })
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    clock.advance(0)
    await tick()
    clock.advance(200)
    await tick()
    clock.advance(400)
    await tick()
    expect(sent).toHaveLength(0)
  })

  it('an unresolvable agents registry degrades to no delivery, never a throw', () => {
    const notifier = createReleaseNotifier({ agents: () => { throw new Error('no agents service') }, logger: { warn() {} } })
    let threw = false
    try { notifier(EVENT) } catch { threw = true }
    expect(threw).toBe(false)
  })
})
