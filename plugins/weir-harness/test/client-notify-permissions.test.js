import { readFileSync } from 'node:fs'
import { afterEach } from 'node:test'
import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.notify-permissions.js chunk test: a hook-state-preserving react stub
 * (state persists across renders; effects run once) + fake primitives +
 * scripted fetch + fake timers. The component is rendered by calling it as a
 * function, so every assertion is on the element tree it returns.
 */

const GRANTED = { supported: true, platform: 'darwin', sender: { bundleId: 'com.apple.ScriptEditor2', name: 'Script Editor' }, state: 'granted', reason: 'alerts-allowed', auth: 7, flags: 8206 }
const UNKNOWN = { ...GRANTED, state: 'unknown', reason: 'default', auth: null }

// The setup helper replaces these globals; put the real ones back after each test.
const REAL = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now }
afterEach(() => {
  globalThis.fetch = REAL.fetch
  globalThis.setTimeout = REAL.setTimeout
  globalThis.clearTimeout = REAL.clearTimeout
  Date.now = REAL.now
})

describe('client.notify-permissions chunk', () => {
  async function setup({ responses }) {
    const slots = []
    let cursor = 0
    const effects = []
    const reactStub = {
      begin() { cursor = 0 },
      useState(initial) {
        const at = cursor++
        if (!(at in slots)) {
          slots[at] = [initial, (next) => { slots[at][0] = typeof next === 'function' ? next(slots[at][0]) : next }]
        }
        return slots[at]
      },
      useEffect(fn) {
        const at = cursor++
        if (!(at in effects)) effects[at] = fn()
      },
      useRef(initial) {
        const at = cursor++
        if (!(at in slots)) slots[at] = { current: initial }
        return slots[at]
      },
      Component: class { constructor(props) { this.props = props; this.state = undefined } },
    }
    const primitivesStub = { Button: (props) => ({ __button: props }), Modal: (props) => ({ __modal: props }) }
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.notify-permissions.js', requireStub)

    const calls = []
    globalThis.fetch = (path, init) => {
      const body = init?.body ? JSON.parse(init.body) : {}
      calls.push({ path, body })
      const answer = responses(path, body)
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve({ json: async () => answer })
    }
    const timers = []
    globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
    globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null }

    const t = (key) => key
    const render = () => { reactStub.begin(); return exports.NotifyPermissionsPanel({ t }) }
    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => queueMicrotask(resolve)) }
    return { definition, exports, calls, timers, render, flush, effects, slots }
  }

  const ok = (value) => ({ ok: true, value })
  const modalOf = (tree) => tree.children[1]
  const buttonKeys = (modal) => {
    const found = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (node.__type?.name === 'Button' || (node.variant && node.onClick)) found.push(node)
      walk(node.children)
    }
    walk(modal.children)
    return found
  }
  const textOf = (node) => JSON.stringify(node)

  it('registers as a chunk of the weir-harness package', async () => {
    const { definition, exports } = await setup({ responses: () => ok({ supported: false }) })
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.notify-permissions.js')
    expect(typeof exports.NotifyPermissionsField).toBe('function')
  })

  it('renders nothing while probing, and nothing when the host is not macOS', async () => {
    const { render, flush, calls, effects } = await setup({ responses: () => ok({ supported: false, platform: 'linux' }) })
    // first render: still probing → nothing, and the probe is requested exactly once
    expect(render()).toBeNull()
    expect(calls.map((call) => call.path)).toEqual(['api/weir-notify/permissions/status'])
    await flush()
    // probe answered: not macOS → still nothing, and no second request
    expect(render()).toBeNull()
    expect(calls).toHaveLength(1)
    // exactly one effect was registered (the effects array is sparse by hook index)
    expect(Object.keys(effects)).toHaveLength(1)
  })

  it('renders nothing when the probe fails', async () => {
    const { render, flush } = await setup({ responses: () => new Error('offline') })
    render()
    await flush()
    expect(render()).toBeNull()
    const second = await setup({ responses: () => ({ ok: false, error: { message: 'x' } }) })
    second.render()
    await second.flush()
    expect(second.render()).toBeNull()
  })

  it('shows the entry on a macOS host, with the modal closed', async () => {
    const { render, flush } = await setup({ responses: () => ok(UNKNOWN) })
    render()
    await flush()
    const tree = render()
    expect(tree).toBeTruthy()
    const modal = modalOf(tree)
    expect(modal.open).toBe(false)
    expect(modal.children).toBeNull()
    expect(modal.title).toBe('notifyPermTitle')
    expect(modal.closeLabel).toBe('notifyPermClose')
    expect(textOf(tree).includes('notifyPermissionsOpen')).toBe(true)
  })

  it('opens, detects on open, and guides test → open settings → wait', async () => {
    const { render, flush, calls } = await setup({
      responses: (path, body) => (path.endsWith('/status') ? ok(UNKNOWN) : ok({ action: body.action })),
    })
    render(); await flush()
    let tree = render()
    // click the entry button
    const entry = tree.children[0].children[1]
    entry.onClick()
    expect(calls.filter((call) => call.path.endsWith('/status'))).toHaveLength(2)
    await flush()
    tree = render()
    expect(modalOf(tree).open).toBe(true)
    let body = textOf(modalOf(tree).children)
    expect(body.includes('notifyPermState_unknown')).toBe(true)
    expect(body.includes('notifyPermReason_default')).toBe(true)
    expect(body.includes('notifyPermBestEffort')).toBe(true)
    expect(body.includes('notifyPermFocusNote')).toBe(true)
    expect(body.includes('auth=-')).toBe(true)
    // step 1: only the test button is primary
    let primaries = buttonKeys(modalOf(tree)).filter((button) => button.variant === 'primary')
    expect(primaries).toHaveLength(1)
    expect(primaries[0].children).toBe('notifyPermSendTest')
    primaries[0].onClick()
    await flush()
    expect(calls.at(-2)).toEqual({ path: 'api/weir-notify/permissions/action', body: { action: 'test' } })
    tree = render()
    // step 2: open settings
    primaries = buttonKeys(modalOf(tree)).filter((button) => button.variant === 'primary')
    expect(primaries).toHaveLength(1)
    expect(primaries[0].children).toBe('notifyPermOpenSettings')
    expect(textOf(modalOf(tree).children).includes('notifyPermOpenHint')).toBe(true)
    primaries[0].onClick()
    await flush()
    expect(calls.some((call) => call.body.action === 'open-settings')).toBe(true)
    tree = render()
    // step 3: waiting for the user
    body = textOf(modalOf(tree).children)
    expect(body.includes('notifyPermWaiting')).toBe(true)
  })

  it('polls while waiting, stops when allowed, and asks for a fresh test', async () => {
    let state = UNKNOWN
    const { render, flush, calls, timers } = await setup({
      responses: (path, body) => (path.endsWith('/status') ? ok(state) : ok({ action: body.action })),
    })
    render(); await flush()
    render().children[0].children[1].onClick()
    await flush()
    let tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick() // test
    await flush()
    tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick() // open settings
    await flush()
    const statusCalls = () => calls.filter((call) => call.path.endsWith('/status')).length
    const before = statusCalls()
    expect(timers.at(-1).ms).toBe(2000)
    // one poll tick: still unknown → schedules the next tick
    timers.at(-1).fn()
    await flush()
    expect(statusCalls()).toBe(before + 1)
    expect(timers.at(-1).ms).toBe(2000)
    // the user allows it → the next tick stops polling
    state = GRANTED
    const pending = timers.length
    timers.at(-1).fn()
    await flush()
    expect(timers.length).toBe(pending)
    tree = render()
    const primaries = buttonKeys(modalOf(tree)).filter((button) => button.variant === 'primary')
    expect(primaries).toHaveLength(1)
    expect(primaries[0].children).toBe('notifyPermSendTest')
    expect(textOf(modalOf(tree).children).includes('notifyPermState_granted')).toBe(true)
  })

  it('confirms with the user after a test on an allowed sender', async () => {
    const { render, flush } = await setup({
      responses: (path, body) => (path.endsWith('/status') ? ok(GRANTED) : ok({ action: body.action })),
    })
    render(); await flush()
    render().children[0].children[1].onClick()
    await flush()
    let tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick() // test
    await flush()
    tree = render()
    expect(textOf(modalOf(tree).children).includes('notifyPermConfirm')).toBe(true)
    const yes = buttonKeys(modalOf(tree)).find((button) => button.children === 'notifyPermSeenYes')
    const no = buttonKeys(modalOf(tree)).find((button) => button.children === 'notifyPermSeenNo')
    no.onClick()
    tree = render()
    expect(textOf(modalOf(tree).children).includes('notifyPermNotSeen')).toBe(true)
    buttonKeys(modalOf(tree)).find((button) => button.children === 'notifyPermRetry').onClick()
    tree = render()
    expect(buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').children).toBe('notifyPermSendTest')
    // the happy path
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick()
    await flush()
    tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.children === 'notifyPermSeenYes').onClick()
    tree = render()
    expect(textOf(modalOf(tree).children).includes('notifyPermSeen"')).toBe(true)
    expect(typeof yes.onClick).toBe('function')
  })

  it('closing the panel stops polling', async () => {
    const { render, flush, timers } = await setup({
      responses: (path, body) => (path.endsWith('/status') ? ok(UNKNOWN) : ok({ action: body.action })),
    })
    render(); await flush()
    render().children[0].children[1].onClick()
    await flush()
    let tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick()
    await flush()
    tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick()
    await flush()
    const live = timers.at(-1)
    expect(typeof live.fn).toBe('function')
    modalOf(render()).onClose()
    expect(live.fn).toBeNull()
    expect(modalOf(render()).open).toBe(false)
  })

  it('stops polling after the time limit', async () => {
    const { render, flush, timers } = await setup({
      responses: (path, body) => (path.endsWith('/status') ? ok(UNKNOWN) : ok({ action: body.action })),
    })
    render(); await flush()
    render().children[0].children[1].onClick()
    await flush()
    let tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick()
    await flush()
    tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick()
    await flush()
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 181_000
      const pending = timers.length
      timers.at(-1).fn()
      await flush()
      expect(timers.length).toBe(pending)
    } finally {
      Date.now = realNow
    }
  })

  it('shows the host error with the manual path, and keeps the panel usable', async () => {
    const { render, flush } = await setup({
      responses: (path) => (path.endsWith('/status') ? ok(UNKNOWN) : { ok: false, error: { message: 'open failed' } }),
    })
    render(); await flush()
    render().children[0].children[1].onClick()
    await flush()
    let tree = render()
    buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').onClick()
    await flush()
    tree = render()
    const body = textOf(modalOf(tree).children)
    expect(body.includes('open failed')).toBe(true)
    expect(body.includes('notifyPermError')).toBe(true)
    expect(body.includes('notifyPermManualPath')).toBe(true)
    expect(buttonKeys(modalOf(tree)).find((button) => button.variant === 'primary').children).toBe('notifyPermSendTest')
  })

  it('the footer rechecks and closes', async () => {
    const { render, flush, calls } = await setup({ responses: () => ok(GRANTED) })
    render(); await flush()
    render().children[0].children[1].onClick()
    await flush()
    const footer = modalOf(render()).footer
    const [recheck, close] = footer.children
    expect(recheck.children).toBe('notifyPermRecheck')
    const before = calls.length
    recheck.onClick()
    expect(calls.length).toBe(before + 1)
    expect(close.children).toBe('notifyPermClose')
  })

  it('the exported field isolates failures behind an error boundary', async () => {
    const { exports } = await setup({ responses: () => ok({ supported: false }) })
    const element = exports.NotifyPermissionsField({ t: (key) => key })
    expect(element.__type).toBe(exports.NotifyPermissionsBoundary)
    const boundary = new exports.NotifyPermissionsBoundary({ t: (key) => key, children: 'child' })
    expect(boundary.render()).toBe('child')
    boundary.state = exports.NotifyPermissionsBoundary.getDerivedStateFromError()
    expect(boundary.render().children).toBe('notifyPermFailed')
  })
})

describe('page permission helpers', () => {
  async function chunk() {
    const { exports } = await loadClientChunk('lib/client.notify-permissions.js', (name) => (name === 'react' ? { Component: class {} } : {}))
    return exports
  }
  function fakeNotification({ permission = 'granted', requestResult } = {}) {
    const asked = []
    class Fake {}
    Fake.permission = permission
    Fake.requestPermission = async () => {
      asked.push(1)
      Fake.permission = requestResult ?? permission
      return Fake.permission
    }
    return { Fake, asked }
  }

  it('reports support and the current permission without asking or sending', async () => {
    const { webNotificationSupport } = await chunk()
    const { Fake, asked } = fakeNotification({ permission: 'default' })
    expect(webNotificationSupport({ Notification: Fake })).toEqual({ supported: true, permission: 'default' })
    expect(webNotificationSupport({})).toEqual({ supported: false, permission: null })
    expect(webNotificationSupport(undefined)).toEqual({ supported: false, permission: null })
    expect(asked).toHaveLength(0)
  })

  it('asks only when the permission has not been decided yet', async () => {
    const { requestWebPermission } = await chunk()
    const undecided = fakeNotification({ permission: 'default', requestResult: 'granted' })
    expect(await requestWebPermission({ Notification: undecided.Fake })).toBe('granted')
    expect(undecided.asked).toHaveLength(1)
    const granted = fakeNotification({ permission: 'granted' })
    expect(await requestWebPermission({ Notification: granted.Fake })).toBe('granted')
    expect(granted.asked).toHaveLength(0)
    const denied = fakeNotification({ permission: 'denied' })
    expect(await requestWebPermission({ Notification: denied.Fake })).toBe('denied')
    expect(denied.asked).toHaveLength(0)
  })

  it('never throws: an unsupported page or a rejecting prompt resolves null', async () => {
    const { requestWebPermission } = await chunk()
    expect(await requestWebPermission({})).toBeNull()
    const rejecting = { Notification: Object.assign(function Notification() {}, { permission: 'default', requestPermission: async () => { throw new Error('nope') } }) }
    expect(await requestWebPermission(rejecting)).toBeNull()
  })

  it('no longer ships an in-panel send probe (delivery lives in the real path)', async () => {
    const exported = await chunk()
    expect(exported.sendWebNotification).toBeUndefined()
  })

  it('declares a label for every page permission and the denied hint', async () => {
    const { LABEL_KEYS } = await chunk()
    for (const permission of ['granted', 'denied', 'default']) expect(LABEL_KEYS.includes(`notifyWebPerm_${permission}`)).toBe(true)
    for (const key of ['notifyWebUnsupported', 'notifyWebPermission', 'notifyWebDeniedHint']) expect(LABEL_KEYS.includes(key)).toBe(true)
    // the experimental probe's labels are gone
    expect(LABEL_KEYS.some((key) => key.startsWith('notifyWebResult_') || key === 'notifyWebSend' || key === 'notifyWebTitle')).toBe(false)
  })

  it('never mentions Script Editor in either dictionary: DSH itself is the sender', async () => {
    const { exports: entry } = await loadClientChunk('lib/client.js', Object.assign(() => ({}), { async: () => Promise.reject(new Error('chunks are not loaded in a dictionary-only test')) }))
    const registrations = []
    entry.apply({
      locale: { bind: () => (key) => key, register: (ns, dicts) => registrations.push(dicts) },
      effect: (fn) => { fn(); return () => {} },
      slots: { inject: () => () => {} },
      configForms: { whileServed: () => () => {} },
      remote: {},
    })
    for (const locale of ['en', 'zh']) {
      for (const [key, value] of Object.entries(registrations[0][locale])) {
        if (!key.startsWith('notifyPerm') && !key.startsWith('notifyWeb')) continue
        expect(/Script Editor|脚本编辑器/.test(value), `${locale}.${key} still names Script Editor`).toBe(false)
      }
    }
  })
})
describe('primaryStep', () => {
  it('highlights exactly one step for every state/flow combination', async () => {
    const { exports } = await loadClientChunk('lib/client.notify-permissions.js', (name) => {
      if (name === 'react') return { Component: class {} }
      return {}
    })
    const initial = { testSent: false, settingsOpened: false, seen: null }
    expect(exports.primaryStep('unknown', initial)).toBe('test')
    expect(exports.primaryStep('denied', { ...initial, testSent: true })).toBe('open')
    expect(exports.primaryStep('denied', { testSent: true, settingsOpened: true, seen: null })).toBe('wait')
    expect(exports.primaryStep('granted', initial)).toBe('test')
    expect(exports.primaryStep('granted', { ...initial, testSent: true })).toBe('confirm')
    expect(exports.primaryStep('granted', { testSent: true, settingsOpened: true, seen: true })).toBe('seen')
    expect(exports.primaryStep('denied', { testSent: true, settingsOpened: true, seen: false })).toBe('not-seen')
  })
})

describe('notify-permissions dictionaries', () => {
  async function dictionaries() {
    const { exports: entry } = await loadClientChunk('lib/client.js', Object.assign(() => ({}), { async: () => Promise.reject(new Error('chunks are not loaded in a dictionary-only test')) }))
    const registrations = []
    entry.apply({
      locale: { bind: () => (key) => key, register: (ns, dicts) => registrations.push(dicts) },
      effect: (fn) => { fn(); return () => {} },
      slots: { inject: () => () => {} },
      configForms: { whileServed: () => () => {} },
      remote: {},
    })
    return registrations[0]
  }

  it('resolves every label the chunk reads in both languages, never the raw key', async () => {
    const { exports } = await loadClientChunk('lib/client.notify-permissions.js', (name) => (name === 'react' ? { Component: class {} } : {}))
    const dicts = await dictionaries()
    for (const locale of ['en', 'zh']) {
      for (const key of exports.LABEL_KEYS) {
        expect(typeof dicts[locale][key], `${locale} is missing ${key}`).toBe('string')
        expect(dicts[locale][key].length).toBeGreaterThan(0)
        expect(dicts[locale][key]).not.toBe(key)
      }
    }
  })

  it('declares every literal label the chunk source reads', async () => {
    const { exports } = await loadClientChunk('lib/client.notify-permissions.js', (name) => (name === 'react' ? { Component: class {} } : {}))
    const source = readFileSync(new URL('../lib/client.notify-permissions.js', import.meta.url), 'utf8')
    const used = new Set([...source.matchAll(/\bt\("([A-Za-z_-]+)"\)/g)].map((match) => match[1]))
    expect(used.size).toBeGreaterThan(20)
    for (const key of used) expect(exports.LABEL_KEYS.includes(key), `${key} is read but not declared in LABEL_KEYS`).toBe(true)
  })

  it('covers every host state and reason code', async () => {
    const { exports } = await loadClientChunk('lib/client.notify-permissions.js', (name) => (name === 'react' ? { Component: class {} } : {}))
    for (const state of ['granted', 'denied', 'unknown']) expect(exports.LABEL_KEYS.includes(`notifyPermState_${state}`)).toBe(true)
    for (const reason of ['alerts-allowed', 'not-allowed', 'no-record', 'default', 'unreadable']) {
      expect(exports.LABEL_KEYS.includes(`notifyPermReason_${reason}`)).toBe(true)
    }
  })
})
