import { describe, expect, it } from './helpers.js'
import { mountSupervision } from '../src/delegate/supervision-mount.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Duck ctx: only the four faces the mount consumes (on / subagents / get /
// logger), plus the audit sink as a plain recorder.
function makeMount({ settings, supervisionNow, subagents = {}, onChildSettled } = {}) {
  const handlers = new Map()
  const warnings = []
  const audits = []
  const sent = []
  const interrupts = []
  const ctx = {
    on: (event, fn) => handlers.set(event, fn),
    subagents: {
      sendMessage: async (agent, childId, content, opts) => {
        sent.push({ agent, childId, content, opts })
      },
      interrupt: (childId, opts) => {
        interrupts.push({ childId, opts })
      },
      listChildren: async () => [],
      ...subagents,
    },
    get: () => undefined,
    logger: { warn: (message) => warnings.push(message) },
  }
  const audit = (session, type, payload) => audits.push({ session, type, payload })
  const mount = mountSupervision({ ctx, audit, settings, supervisionNow: supervisionNow ?? (() => ({})), onChildSettled })
  const feed = (session, event) => handlers.get('session/event')(session, event)
  return { mount, handlers, warnings, audits, sent, interrupts, feed }
}

function fakeParent({ id = 'p1', status = 'idle', steer } = {}) {
  const parent = {
    id,
    session: { id, header: {} },
    status,
    steered: [],
    followedUp: [],
    steer: steer ?? ((message) => parent.steered.push(message)),
    followup: (message) => parent.followedUp.push(message),
  }
  return parent
}

function liveSettings(initial = {}) {
  const listeners = new Set()
  const sections = { ...initial }
  return {
    service: {
      get: (key) => sections[key],
      onChange: (callback) => {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
    },
    commit(section, value) {
      sections[section] = value
      for (const callback of listeners) callback()
    },
    listenerCount: () => listeners.size,
  }
}

describe('mountSupervision coordinator registry', () => {
  it('caches one coordinator per parent id', async () => {
    const { mount } = makeMount()
    const parent = fakeParent()
    const first = await mount.coordinatorFor(parent)
    expect(await mount.coordinatorFor(parent)).toBe(first)
    expect(await mount.coordinatorFor(fakeParent({ id: 'p1', status: 'streaming' }))).toBe(first)
    expect(await mount.coordinatorFor(fakeParent({ id: 'p2' }))).not.toBe(first)
  })

  it('maps effectors onto ctx.subagents and the audit sink', async () => {
    const { mount, sent, interrupts, audits } = makeMount()
    const parent = fakeParent()
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate({
      children: [
        { id: 'c1', name: 'c1', group: 'g', status: 'running' },
        { id: 'c2', name: 'c2', group: 'g', status: 'blocked' },
      ],
      groups: [],
      untracked: [],
      confidence: 'full',
    })

    coordinator.terminate('c1', 'stale')
    expect(interrupts).toEqual([{ childId: 'c1', opts: { kind: 'ancestor', agent: parent } }])
    expect(audits.some((a) => a.type === 'supervision/terminate' && a.session === parent.session)).toBeTruthy()

    await coordinator.resume('c2', 'cleared')
    expect(sent).toHaveLength(1)
    expect(sent[0].agent).toBe(parent)
    expect(sent[0].childId).toBe('c2')
    expect(sent[0].content[0].type).toBe('text')
    expect(sent[0].content[0].text).toContain('resume_context')
    expect(audits.some((a) => a.type === 'supervision/resume')).toBeTruthy()
  })

  it('routes onAudit notes to AUDIT_TYPES.supervision when delivery fails', async () => {
    const { mount, audits } = makeMount({
      subagents: {
        sendMessage: async () => {
          throw new Error('inbox closed')
        },
      },
    })
    const parent = fakeParent()
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate({ children: [{ id: 'c1', name: 'c1', group: 'g', status: 'blocked' }], groups: [], untracked: [], confidence: 'full' })
    await expect(async () => coordinator.resume('c1', 'go')).rejects.toThrow(/could not deliver resume context/)
    const note = audits.find((a) => a.type === 'supervision' && a.session === parent.session)
    expect(note.payload.note).toContain('resume delivery failed')
  })
})

describe('mountSupervision notifyParent policy', () => {
  const settledGroup = {
    children: [{ id: 'c1', name: 'c1', group: 'g', status: 'completed' }],
    groups: [{ name: 'g', sealed: true, settled: true, memberIds: ['c1'] }],
    untracked: [],
    confidence: 'full',
  }

  it('follows up when the parent is idle, with the orrery-delegate source tag', async () => {
    const { mount } = makeMount()
    const parent = fakeParent({ status: 'idle' })
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate(settledGroup) // re-emits the group-settled signal
    await sleep(20)
    expect(parent.followedUp).toHaveLength(1)
    expect(parent.steered).toHaveLength(0)
    expect(parent.followedUp[0].content[0].text).toContain('supervised_group_settled')
    expect(parent.followedUp[0].source.kind).toBe('orrery-delegate')
  })

  it('steers into the current turn when the parent is busy', async () => {
    const { mount } = makeMount()
    const parent = fakeParent({ status: 'streaming' })
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate(settledGroup)
    await sleep(20)
    expect(parent.steered).toHaveLength(1)
    expect(parent.followedUp).toHaveLength(0)
  })

  it('retries a failed delivery with backoff and succeeds on a later attempt', async () => {
    let failures = 1
    const parent = fakeParent({
      status: 'streaming',
      steer(message) {
        if (failures > 0) {
          failures -= 1
          return Promise.reject(new Error('turn locked'))
        }
        parent.steered.push(message)
        return undefined
      },
    })
    const { mount, warnings } = makeMount()
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate(settledGroup)
    await sleep(20) // attempt 1 (delay 0) fails
    expect(parent.steered).toHaveLength(0)
    await sleep(250) // attempt 2 lands after the 200ms backoff
    expect(parent.steered).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('attempt 1')
  })

  it('audits the final failure after three attempts', async () => {
    const parent = fakeParent({ status: 'streaming', steer: () => Promise.reject(new Error('nope')) })
    const { mount, warnings, audits } = makeMount()
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate(settledGroup)
    await sleep(700) // attempts at 0 / 200 / 400ms, then the terminal audit
    expect(warnings).toHaveLength(3)
    const note = audits.find((a) => a.type === 'supervision' && a.payload?.note?.includes('delivery failed after 3 attempts'))
    expect(note).toBeTruthy()
    expect(note.session).toBe(parent.session)
  })
})

describe('mountSupervision session/event feed', () => {
  it('drives settle from child text + turn/end and gates the signal on the parent notice', async () => {
    const { mount, feed, audits } = makeMount()
    const parent = fakeParent({ status: 'idle' })
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate({
      children: [{ id: 'c1', name: 'c1', group: 'g', status: 'running' }],
      groups: [{ name: 'g', sealed: true, memberIds: ['c1'] }],
      untracked: [],
      confidence: 'full',
    })

    feed({ id: 'c1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: shipped' }] } } })
    feed({ id: 'c1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await sleep(20)
    expect(audits.some((a) => a.type === 'supervision/settle' && a.payload?.status === 'completed')).toBeTruthy()
    // Ordering gate: the member's settlement notice has not been observed yet,
    // so the group-settled signal stays pending (fallback is 1000ms out).
    await sleep(20)
    expect(parent.followedUp).toHaveLength(0)

    feed(parent.session, { type: 'user/message', data: { source: { kind: 'subagent-settled', senderSessionId: 'c1' } } })
    await sleep(20)
    expect(parent.followedUp).toHaveLength(1)
    expect(parent.followedUp[0].content[0].text).toContain('supervised_group_settled')
  })

  it('ignores events from sessions no coordinator tracks', async () => {
    const { mount, feed, audits } = makeMount()
    await mount.coordinatorFor(fakeParent())
    feed({ id: 'stray' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
    feed({ id: 'stray' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await sleep(20)
    expect(audits).toHaveLength(0)
  })

  it('audits turn-end processing failures instead of throwing from dispatch', async () => {
    const { mount, feed, audits } = makeMount()
    const parent = fakeParent()
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate({ children: [{ id: 'c1', name: 'c1', group: 'g', status: 'running' }], groups: [], untracked: [], confidence: 'full' })
    coordinator.onTurnEnd = async () => {
      throw new Error('state machine exploded')
    }
    feed({ id: 'c1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await sleep(20)
    const note = audits.find((a) => a.type === 'supervision' && a.payload?.note?.includes('turn-end processing failed for child c1'))
    expect(note).toBeTruthy()
  })
})

describe('mountSupervision lane settlement forwarding (resumable-lane-workers D1)', () => {
  // A member reaching a TERMINAL outcome frees its worktree lane through
  // onChildSettled; a blocked member stands by for resume_agent, so its lane
  // binding must survive. The blocked fact still rides the audit channel.
  function mountWithLane() {
    const settled = []
    const kit = makeMount({ onChildSettled: (childId, parent) => settled.push({ childId, parentId: parent.id }) })
    return { ...kit, settled }
  }

  async function runningChild(mount, parent, id = 'c1') {
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate({
      children: [{ id, name: id, group: 'g', status: 'running' }],
      groups: [{ name: 'g', sealed: true, memberIds: [id] }],
      untracked: [],
      confidence: 'full',
    })
    return coordinator
  }

  async function settleTurn(feed, id, status) {
    feed({ id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `STATUS: ${status}\nREPORT: r` }] } } })
    feed({ id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await sleep(20)
  }

  it('a blocked settle writes the audit fact but does NOT free the lane', async () => {
    const { mount, feed, audits, settled } = mountWithLane()
    const parent = fakeParent()
    await runningChild(mount, parent)
    await settleTurn(feed, 'c1', 'blocked')
    expect(audits.some((a) => a.type === 'supervision/settle' && a.payload?.status === 'blocked' && a.payload?.childId === 'c1')).toBeTruthy()
    expect(settled).toHaveLength(0)
  })

  it('a completed settle frees the lane', async () => {
    const { mount, feed, settled } = mountWithLane()
    const parent = fakeParent()
    await runningChild(mount, parent)
    await settleTurn(feed, 'c1', 'completed')
    expect(settled).toEqual([{ childId: 'c1', parentId: 'p1' }])
  })

  it('terminating a blocked member frees the lane via the terminate fact', async () => {
    const { mount, feed, audits, settled } = mountWithLane()
    const parent = fakeParent()
    const coordinator = await runningChild(mount, parent)
    await settleTurn(feed, 'c1', 'blocked')
    expect(settled).toHaveLength(0)
    coordinator.terminate('c1', 'redirected')
    await sleep(20)
    expect(audits.some((a) => a.type === 'supervision/terminate' && a.payload?.childId === 'c1')).toBeTruthy()
    expect(settled).toEqual([{ childId: 'c1', parentId: 'p1' }])
  })

  it('a terminated settle (non-user abort) frees the lane', async () => {
    const { mount, feed, audits, settled } = mountWithLane()
    const parent = fakeParent()
    await runningChild(mount, parent)
    feed({ id: 'c1' }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'crash' } } } })
    await sleep(20)
    expect(audits.some((a) => a.type === 'supervision/settle' && a.payload?.status === 'terminated')).toBeTruthy()
    expect(settled).toEqual([{ childId: 'c1', parentId: 'p1' }])
  })
})

describe('mountSupervision settings lifecycle', () => {
  it('pushes committed supervision parameters into live coordinators', async () => {
    const live = liveSettings()
    let supervision = {}
    const { mount, feed, audits } = makeMount({ settings: live.service, supervisionNow: () => supervision })
    const parent = fakeParent()
    const coordinator = await mount.coordinatorFor(parent)
    coordinator.hydrate({ children: [{ id: 'c1', name: 'c1', group: 'g', status: 'running' }], groups: [], untracked: [], confidence: 'full' })

    supervision = { maxRetries: 0 }
    live.commit('delegate', { supervisionMaxRetries: 0 })
    feed({ id: 'c1' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } })
    await sleep(20)
    // maxRetries 0 (pushed on commit): the error turn settles blocked at once
    // instead of scheduling a backoff retry.
    expect(audits.some((a) => a.payload?.note?.includes('continuation exhausted (provider errors)'))).toBeTruthy()
    expect(coordinator.snapshot().children[0].status).toBe('blocked')
  })

  it('dispose unsubscribes the onChange listener', async () => {
    const live = liveSettings()
    const { mount } = makeMount({ settings: live.service })
    expect(live.listenerCount()).toBe(1)
    mount.dispose()
    expect(live.listenerCount()).toBe(0)
  })

  it('mounts and disposes cleanly without a settings service', async () => {
    const { mount } = makeMount({ settings: undefined })
    await mount.coordinatorFor(fakeParent())
    mount.dispose()
  })
})
