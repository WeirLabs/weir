import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.notify-web.js: the page half of web notification delivery. A
 * zero-dependency chunk, so every environment piece (fetch, Notification,
 * document, timers) is a fake and the loop runs deterministically.
 */

async function chunk() {
  const { definition, exports } = await loadClientChunk('lib/client.notify-web.js')
  return { definition, ...exports }
}

/** A Notification constructor whose behaviour each test scripts. */
function fakeNotification({ permission = 'granted', requestResult, fire = (note) => note.onshow?.() } = {}) {
  const created = []
  const closed = []
  class Fake {
    constructor(title, options) {
      this.title = title
      this.options = options
      created.push(this)
      if (fire) globalThis.queueMicrotask(() => fire(this))
    }
    close() { closed.push(this) }
  }
  Fake.permission = permission
  Fake.requestPermission = async () => { Fake.permission = requestResult ?? permission; return Fake.permission }
  return { Fake, created, closed }
}
const background = { visibilityState: 'hidden', hasFocus: () => false }
const foreground = { visibilityState: 'visible', hasFocus: () => true }
const note = (extra = {}) => ({ title: 'Approval needed', body: 'body', tag: 'orrery:a:approval', renotify: true, sound: true, foreground: 'skip', ...extra })
// Enough microtask turns for a multi-step retry chain (each hop is several awaits).
const flush = async () => { for (let i = 0; i < 60; i++) await new Promise((resolve) => globalThis.queueMicrotask(resolve)) }

describe('client.notify-web chunk', () => {
  it('registers as a chunk of the orrery-harness package', async () => {
    const { definition } = await chunk()
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.notify-web.js')
  })

  it('knows the host result vocabulary', async () => {
    const { RESULTS } = await chunk()
    expect([...RESULTS].sort()).toEqual(['blocked', 'error', 'pending', 'shown', 'suppressed', 'threw', 'unsupported'])
  })
})

describe('isForeground', () => {
  it('is foreground only when the window is both visible and focused', async () => {
    const { isForeground } = await chunk()
    expect(isForeground({ document: foreground })).toBe(true)
    expect(isForeground({ document: { visibilityState: 'visible', hasFocus: () => false } })).toBe(false)
    expect(isForeground({ document: { visibilityState: 'hidden', hasFocus: () => true } })).toBe(false)
    expect(isForeground({})).toBe(false)
    expect(isForeground(undefined)).toBe(false)
  })

  it('treats a missing hasFocus as focused when visible', async () => {
    const { isForeground } = await chunk()
    expect(isForeground({ document: { visibilityState: 'visible' } })).toBe(true)
  })
})

describe('showNote', () => {
  it('shows with the tag, re-alert flag and body, and reports shown', async () => {
    const { showNote } = await chunk()
    const { Fake, created } = fakeNotification()
    const open = new Map()
    expect(await showNote({ Notification: Fake, document: background }, note(), open)).toBe('shown')
    expect(created).toHaveLength(1)
    expect(created[0].title).toBe('Approval needed')
    expect(created[0].options).toEqual({ body: 'body', silent: false, tag: 'orrery:a:approval', renotify: true })
    expect(open.get('orrery:a:approval')).toBe(created[0])
  })

  it('is silent when the host turned the sound off', async () => {
    const { showNote } = await chunk()
    const { Fake, created } = fakeNotification()
    await showNote({ Notification: Fake, document: background }, note({ sound: false }), new Map())
    expect(created[0].options.silent).toBe(true)
  })

  it('suppresses in the foreground by default and never creates a notification', async () => {
    const { showNote } = await chunk()
    const { Fake, created } = fakeNotification()
    expect(await showNote({ Notification: Fake, document: foreground }, note(), new Map())).toBe('suppressed')
    expect(created).toHaveLength(0)
  })

  it('notifies in the foreground when the host says always', async () => {
    const { showNote } = await chunk()
    const { Fake, created } = fakeNotification()
    expect(await showNote({ Notification: Fake, document: foreground }, note({ foreground: 'always' }), new Map())).toBe('shown')
    expect(created).toHaveLength(1)
  })

  it('closes the old notification of the same tag before showing the new one', async () => {
    const { showNote } = await chunk()
    const { Fake, created, closed } = fakeNotification()
    const open = new Map()
    const env = { Notification: Fake, document: background }
    await showNote(env, note(), open)
    await showNote(env, note({ body: 'second' }), open)
    expect(created).toHaveLength(2)
    expect(closed).toEqual([created[0]])
    expect(open.get('orrery:a:approval')).toBe(created[1])
  })

  it('keeps different tags open side by side', async () => {
    const { showNote } = await chunk()
    const { Fake, created, closed } = fakeNotification()
    const open = new Map()
    const env = { Notification: Fake, document: background }
    await showNote(env, note({ tag: 'orrery:a:approval' }), open)
    await showNote(env, note({ tag: 'orrery:b:approval' }), open)
    await showNote(env, note({ tag: 'orrery:a:completed' }), open)
    expect(created).toHaveLength(3)
    expect(closed).toHaveLength(0)
    expect(open.size).toBe(3)
  })

  it('forgets a notification once the user dismisses it, so a later one needs no close', async () => {
    const { showNote } = await chunk()
    const { Fake, created, closed } = fakeNotification()
    const open = new Map()
    const env = { Notification: Fake, document: background }
    await showNote(env, note(), open)
    created[0].onclose()
    expect(open.size).toBe(0)
    await showNote(env, note(), open)
    expect(closed).toHaveLength(0)
  })

  it('sends a note without a tag as an independent notification', async () => {
    const { showNote } = await chunk()
    const { Fake, created } = fakeNotification()
    const open = new Map()
    const env = { Notification: Fake, document: background }
    await showNote(env, note({ tag: undefined }), open)
    await showNote(env, note({ tag: undefined }), open)
    expect(created).toHaveLength(2)
    expect('tag' in created[0].options).toBe(false)
    expect(open.size).toBe(0)
  })

  it('asks for permission first, and reports blocked without sending when refused', async () => {
    const { showNote } = await chunk()
    const granted = fakeNotification({ permission: 'default', requestResult: 'granted' })
    expect(await showNote({ Notification: granted.Fake, document: background }, note(), new Map())).toBe('shown')
    const refused = fakeNotification({ permission: 'default', requestResult: 'denied' })
    expect(await showNote({ Notification: refused.Fake, document: background }, note(), new Map())).toBe('blocked')
    expect(refused.created).toHaveLength(0)
    const denied = fakeNotification({ permission: 'denied' })
    expect(await showNote({ Notification: denied.Fake, document: background }, note(), new Map())).toBe('blocked')
  })

  it('reports error, unsupported and threw', async () => {
    const { showNote } = await chunk()
    const failing = fakeNotification({ fire: (n) => n.onerror() })
    expect(await showNote({ Notification: failing.Fake, document: background }, note(), new Map())).toBe('error')
    expect(await showNote({ document: background }, note(), new Map())).toBe('unsupported')
    class Throwing { constructor() { throw new Error('boom') } }
    Throwing.permission = 'granted'
    expect(await showNote({ Notification: Throwing, document: background }, note(), new Map())).toBe('threw')
  })

  it('does not claim success when the browser never confirms', async () => {
    const { showNote } = await chunk()
    const { Fake } = fakeNotification({ fire: null })
    const waits = []
    const env = { Notification: Fake, document: background, setTimeout: (fn, ms) => { waits.push(ms); fn() } }
    expect(await showNote(env, note(), new Map())).toBe('pending')
    expect(waits).toEqual([2500])
  })
})

describe('startWebDelivery', () => {
  /** A scripted host: each pull pops the next answer; an exhausted script parks forever. */
  function host(script) {
    const calls = []
    const pending = []
    const env = {
      document: background,
      fetch: (path, init) => {
        const body = JSON.parse(init.body)
        calls.push({ path, body })
        if (path.endsWith('/pull')) {
          const next = script.shift()
          if (next === undefined) return new Promise((_resolve, reject) => { pending.push(reject); init.signal?.addEventListener('abort', () => reject(new Error('aborted'))) })
          if (next instanceof Error) return Promise.reject(next)
          return Promise.resolve({ json: async () => next })
        }
        return Promise.resolve({ json: async () => ({ ok: true, value: { matched: true } }) })
      },
      setTimeout: (fn) => { globalThis.queueMicrotask(fn); return 1 },
      clearTimeout: () => {},
    }
    return { env, calls }
  }

  it('shows a pulled note, acks the result, and pulls again', async () => {
    const { startWebDelivery } = await chunk()
    const { Fake, created } = fakeNotification()
    const { env, calls } = host([{ ok: true, value: { id: '7', note: note() } }])
    const delivery = startWebDelivery({ ...env, Notification: Fake })
    await flush()
    expect(created).toHaveLength(1)
    expect(calls.filter((call) => call.path.endsWith('/ack'))).toEqual([{ path: 'api/orrery-notify/web/ack', body: { id: '7', result: 'shown' } }])
    expect(calls.filter((call) => call.path.endsWith('/pull')).length).toBeGreaterThanOrEqual(2)
    expect(delivery.stats.shown).toBe(1)
    delivery.stop()
  })

  it('acks suppressed for a foreground note so the host does not fall back', async () => {
    const { startWebDelivery } = await chunk()
    const { Fake, created } = fakeNotification()
    const { env, calls } = host([{ ok: true, value: { id: '1', note: note() } }])
    const delivery = startWebDelivery({ ...env, document: foreground, Notification: Fake })
    await flush()
    expect(created).toHaveLength(0)
    expect(calls.find((call) => call.path.endsWith('/ack')).body).toEqual({ id: '1', result: 'suppressed' })
    delivery.stop()
  })

  it('an empty answer just polls again, without acking', async () => {
    const { startWebDelivery } = await chunk()
    const { Fake } = fakeNotification()
    const { env, calls } = host([{ ok: true, value: null }, { ok: true, value: null }])
    const delivery = startWebDelivery({ ...env, Notification: Fake })
    await flush()
    expect(calls.filter((call) => call.path.endsWith('/ack'))).toHaveLength(0)
    expect(calls.filter((call) => call.path.endsWith('/pull')).length).toBeGreaterThanOrEqual(3)
    delivery.stop()
  })

  it('backs off with a growing delay after failures and recovers', async () => {
    const { startWebDelivery, BACKOFF_MS } = await chunk()
    const { Fake, created } = fakeNotification()
    const waits = []
    const { env } = host([new Error('down'), { ok: false, error: { message: 'bad' } }, new Error('down'), { ok: true, value: { id: '3', note: note() } }])
    // Only the backoff sleeps fire; the 2.5s "browser never confirmed" timer must stay quiet.
    const delivery = startWebDelivery({ ...env, Notification: Fake, setTimeout: (fn, ms) => { if (ms !== 2500) { waits.push(ms); globalThis.queueMicrotask(fn) } return 1 } })
    await flush()
    expect(waits.slice(0, 3)).toEqual([BACKOFF_MS[0], BACKOFF_MS[1], BACKOFF_MS[2]])
    expect(created).toHaveLength(1)
    expect(delivery.stats.failures).toBe(3)
    delivery.stop()
  })

  it('never backs off past the cap', async () => {
    const { startWebDelivery, BACKOFF_MS } = await chunk()
    const { Fake } = fakeNotification()
    const waits = []
    const failures = Array.from({ length: 9 }, () => new Error('down'))
    const { env } = host(failures)
    const delivery = startWebDelivery({ ...env, Notification: Fake, setTimeout: (fn, ms) => { if (ms !== 2500) { waits.push(ms); globalThis.queueMicrotask(fn) } return 1 } })
    await flush()
    await flush()
    expect(Math.max(...waits)).toBe(BACKOFF_MS.at(-1))
    delivery.stop()
  })

  it('a failing ack cannot wedge the loop', async () => {
    const { startWebDelivery } = await chunk()
    const { Fake } = fakeNotification()
    const calls = []
    const script = [{ ok: true, value: { id: '1', note: note() } }, { ok: true, value: { id: '2', note: note({ tag: 'orrery:b:approval' }) } }]
    const env = {
      document: background,
      Notification: Fake,
      fetch: (path, init) => {
        calls.push(path)
        if (path.endsWith('/ack')) return Promise.reject(new Error('ack down'))
        const next = script.shift()
        if (next === undefined) return new Promise(() => {})
        return Promise.resolve({ json: async () => next })
      },
      setTimeout: (fn) => { globalThis.queueMicrotask(fn); return 1 },
      clearTimeout: () => {},
    }
    const delivery = startWebDelivery(env)
    await flush()
    expect(calls.filter((path) => path.endsWith('/ack'))).toHaveLength(2)
    delivery.stop()
  })

  it('stop aborts the parked poll, closes open notifications and ends the loop', async () => {
    const { startWebDelivery } = await chunk()
    const { Fake, created, closed } = fakeNotification()
    const { env, calls } = host([{ ok: true, value: { id: '1', note: note() } }])
    const delivery = startWebDelivery({ ...env, Notification: Fake })
    await flush()
    const before = calls.length
    delivery.stop()
    await flush()
    expect(closed).toEqual(created)
    expect(calls.length).toBe(before)
  })
})
