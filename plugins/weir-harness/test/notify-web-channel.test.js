import { describe, expect, it } from './helpers.js'
import { tagFor, RENOTIFY } from '../src/notify/tags.js'
import { ACK_TIMEOUT_MS, createWebChannel, FALLBACK_RESULTS, FINAL_RESULTS, PULL_HOLD_MS, PULLER_FRESH_MS } from '../src/notify/web-channel.js'

describe('tagFor', () => {
  it('merges the same top-level session and type, and never different ones', () => {
    expect(tagFor('s1', 'approval')).toBe(tagFor('s1', 'approval'))
    expect(tagFor('s1', 'approval')).not.toBe(tagFor('s2', 'approval'))
    expect(tagFor('s1', 'approval')).not.toBe(tagFor('s1', 'completed'))
  })

  it('keeps distinct ids distinct and the tag printable', () => {
    expect(tagFor('a b', 'x')).not.toBe(tagFor('a_b', 'x'))
    expect(/^[\x20-\x7e]+$/.test(tagFor('会话/一', 'plan'))).toBe(true)
    expect(tagFor(undefined, 'x')).toBe('weir:unknown:x')
  })

  it('always asks to re-alert on replacement', () => {
    expect(RENOTIFY).toBe(true)
  })
})

describe('web channel', () => {
  function harness() {
    let time = 1_000_000
    const timers = new Map()
    let nextTimer = 1
    const fell = []
    const warnings = []
    const channel = createWebChannel({
      fallback: (note, options) => fell.push({ note, options }),
      now: () => time,
      setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
      clearTimer: (id) => timers.delete(id),
      logger: { warn: (message) => warnings.push(message) },
    })
    return {
      channel, fell, timers, warnings,
      advance: (ms) => { time += ms },
      /** Fire every pending timer with this exact delay. */
      fire: (ms) => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn() } },
    }
  }
  const note = (extra = {}) => ({ title: 'Approval needed', body: 'x', urgent: true, tag: 'weir:s1:approval', renotify: true, sound: true, foreground: 'skip', ...extra })

  it('falls back at once when no page is polling', () => {
    const h = harness()
    expect(h.channel.send(note())).toBe('fallback')
    expect(h.fell).toHaveLength(1)
    expect(h.fell[0].note).toEqual({ title: 'Approval needed', body: 'x', urgent: true })
    expect(h.fell[0].options).toEqual({ sound: true })
  })

  it('hands a note to a parked puller, and a final ack means no fallback', async () => {
    const h = harness()
    const parked = h.channel.pull()
    expect(h.channel.hasPuller()).toBe(true)
    expect(h.channel.send(note())).toBe('queued')
    const pulled = await parked
    expect(pulled.note.tag).toBe('weir:s1:approval')
    expect(h.channel.ack(pulled.id, 'shown')).toBe(true)
    h.fire(ACK_TIMEOUT_MS)
    expect(h.fell).toHaveLength(0)
  })

  it('queues for the next pull when the page is between polls', async () => {
    const h = harness()
    await Promise.race([h.channel.pull(0), Promise.resolve()])
    h.fire(0)
    expect(h.channel.hasPuller()).toBe(true)
    expect(h.channel.send(note())).toBe('queued')
    const pulled = await h.channel.pull()
    expect(pulled.note.title).toBe('Approval needed')
    h.channel.ack(pulled.id, 'shown')
    expect(h.fell).toHaveLength(0)
  })

  it('only the final results skip the fallback', async () => {
    for (const result of [...FINAL_RESULTS, ...FALLBACK_RESULTS]) {
      const h = harness()
      const parked = h.channel.pull()
      h.channel.send(note())
      const { id } = await parked
      h.channel.ack(id, result)
      expect(h.fell.length, `result ${result}`).toBe(FINAL_RESULTS.includes(result) ? 0 : 1)
    }
    expect([...FINAL_RESULTS].sort()).toEqual(['pending', 'shown', 'suppressed'])
  })

  it('treats an unknown result as a failure and falls back', async () => {
    const h = harness()
    const parked = h.channel.pull()
    h.channel.send(note())
    const { id } = await parked
    h.channel.ack(id, 'something-new')
    expect(h.fell).toHaveLength(1)
  })

  it('falls back when the page takes a note and never acks', async () => {
    const h = harness()
    const parked = h.channel.pull()
    h.channel.send(note())
    await parked
    expect(h.fell).toHaveLength(0)
    h.fire(ACK_TIMEOUT_MS)
    expect(h.fell).toHaveLength(1)
  })

  it('a late ack after the fallback neither throws nor delivers twice', async () => {
    const h = harness()
    const parked = h.channel.pull()
    h.channel.send(note())
    const { id } = await parked
    h.fire(ACK_TIMEOUT_MS)
    expect(h.channel.ack(id, 'shown')).toBe(false)
    expect(h.fell).toHaveLength(1)
  })

  it('an ack for an unknown id is ignored', () => {
    const h = harness()
    expect(h.channel.ack('nope', 'shown')).toBe(false)
    expect(h.fell).toHaveLength(0)
  })

  it('gives each note to exactly one of several pullers', async () => {
    const h = harness()
    const first = h.channel.pull()
    const second = h.channel.pull()
    h.channel.send(note())
    const pulled = await first
    expect(pulled).toBeTruthy()
    // the second puller is still parked and gets nothing
    h.fire(PULL_HOLD_MS)
    expect(await second).toBeNull()
    expect(h.fell).toHaveLength(0)
  })

  it('serves queued notes in order, one per pull', async () => {
    const h = harness()
    h.channel.pull(0)
    h.fire(0)
    h.channel.send(note({ title: 'one' }))
    h.channel.send(note({ title: 'two' }))
    expect((await h.channel.pull()).note.title).toBe('one')
    expect((await h.channel.pull()).note.title).toBe('two')
  })

  it('a pull with nothing to say answers null after the hold time and still counts as a live page', async () => {
    const h = harness()
    const parked = h.channel.pull()
    h.fire(PULL_HOLD_MS)
    expect(await parked).toBeNull()
    expect(h.channel.hasPuller()).toBe(true)
    h.advance(PULLER_FRESH_MS + 1)
    expect(h.channel.hasPuller()).toBe(false)
    expect(h.channel.send(note())).toBe('fallback')
  })

  it('does not wait forever for a page that stops polling after a note is queued', async () => {
    const h = harness()
    h.channel.pull(0)
    h.fire(0)
    h.channel.send(note())
    expect(h.fell).toHaveLength(0)
    h.fire(PULLER_FRESH_MS)
    expect(h.fell).toHaveLength(1)
    // and the note is gone from the queue
    h.advance(1)
    const parked = h.channel.pull()
    h.fire(PULL_HOLD_MS)
    expect(await parked).toBeNull()
  })

  it('a thrown fallback is logged and never escapes', () => {
    // a realistic clock: far past the epoch, so "no page has ever polled" holds
    const time = 1_000_000
    const warnings = []
    const channel = createWebChannel({
      fallback: () => { throw new Error('no osascript') },
      now: () => time,
      setTimer: () => 1,
      clearTimer: () => {},
      logger: { warn: (message) => warnings.push(message) },
    })
    expect(channel.send(note())).toBe('fallback')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no osascript')
  })

  it('close drops everything and delivers nothing afterwards', async () => {
    const h = harness()
    const parked = h.channel.pull()
    h.channel.close()
    expect(await parked).toBeNull()
    expect(h.channel.send(note())).toBe('fallback')
    expect(h.timers.size).toBe(0)
    expect(await h.channel.pull()).toBeNull()
  })
})
