import { describe, expect, it } from './helpers.js'

/**
 * Channel-adapter pins for the composition root (lib/client.js).
 *
 * Two carriers, one contract each: the raw-gateway channel
 * (connection.rpc.call("/api", …) — capability reads and the blackboard
 * panel) and the HTTP channel (fetch — the weir-* admin endpoints). Both
 * resolve the folded { ok: true, value } | { ok: false, error: { code,
 * message } } shape and NEVER reject. These tests drive the REAL entry under
 * Node with sentinel chunks and a fake cordis ctx, reaching the adapters
 * through the existing inject faces (the capability Badge verbs, the
 * blackboard pane's callBoard, the Edit Lock entry's fetchView, the settings
 * controller's fetchEnv dep, and the notify-web delivery env's channel) and
 * pin the four degradation paths — missing connection / carrier throw /
 * failure envelope / the documented cold-open "unknown session" silence —
 * plus warn-once (one console.warn per shape per apply) and the wire init
 * mapping. Chunk-side call-site pins live in the per-chunk tests.
 */

describe('client channel adapters (composition root)', () => {
  function makeReactStub() {
    const reactState = []
    let hookCursor = 0
    return {
      begin() {
        hookCursor = 0
      },
      useState(initial) {
        const at = hookCursor++
        if (!(at in reactState)) reactState[at] = [initial, (next) => {
          reactState[at][0] = typeof next === 'function' ? next(reactState[at][0]) : next
        }]
        return reactState[at]
      },
      useEffect(fn) {
        const at = hookCursor++
        if (!(at in reactState)) reactState[at] = { cleanup: fn() }
        return undefined
      },
      useRef: (initial) => ({ current: initial }),
      Component: class {
        constructor(props) {
          this.props = props
          this.state = undefined
        }
      },
    }
  }

  async function loadEntry() {
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load: (definition) => loaded.push(definition),
      },
    }
    await import(`../lib/client.js?adapter-test=${Math.random()}`)

    const reactStub = makeReactStub()
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      throw new Error(`unexpected require ${name}`)
    }
    const controllerConstructed = []
    const settingsPageChunk = {
      WeirCardController: class {
        constructor(scope, deps, page) {
          this.scope = scope
          this.deps = deps
          this.page = page
          this.store = { getSnapshot: () => ({}), subscribe: () => () => {} }
          controllerConstructed.push(this)
        }

        inject() {
          return {}
        }

        dispose() {}
      },
      WeirCard: (props) => ({ __card: props }),
      WeirSection: (props) => ({ __section: props }),
    }
    const notifyWebStarts = []
    const chunkModules = {
      './client.settings-page.js': settingsPageChunk,
      './client.chain-editor.js': {},
      './client.robash-editor.js': {},
      './client.disabled-categories-editor.js': {},
      './client.lsp-panel.js': {},
      './client.chain-model.js': {},
      './client.robash-model.js': {},
      './client.lsp-model.js': {},
      './client.notify-permissions.js': {},
      './client.edit-lock-maintenance.js': {},
      './client.model-picker.js': {},
      './client.notify-web.js': { startWebDelivery: (env) => { notifyWebStarts.push(env); return { stop: () => {} } } },
    }
    requireStub.async = (spec) => {
      const module = chunkModules[spec]
      if (!module) return Promise.reject(new Error(`unexpected chunk ${spec}`))
      return Promise.resolve(module)
    }
    return { surface: loaded[0].factory(requireStub), reactStub, controllerConstructed, notifyWebStarts }
  }

  function makeCtx() {
    const slotInjects = []
    const slotRegistrations = []
    const localeRegistrations = []
    const whileServedCalls = []
    const rpcCalls = []
    const connection = {
      rpc: {
        call: async (channel, endpoint, payload) => {
          rpcCalls.push({ channel, endpoint, payload })
          if (connection.rpcBehavior) return connection.rpcBehavior(channel, endpoint, payload)
          return { ok: true, value: {} }
        },
      },
    }
    const ctx = {
      locale: {
        bind: () => (key) => key,
        register: (ns, dicts) => localeRegistrations.push({ ns, dicts }),
      },
      effect: (fn) => {
        fn()
        return () => {}
      },
      configForms: {
        get: () => ({ ns: 'weir-settings' }),
        whileServed: (namespaces, register) => {
          whileServedCalls.push({ namespaces, register })
          return () => {}
        },
      },
      get: (name) => (name === 'connection' ? connection : undefined),
      remote: {},
      slots: {
        inject: (name, fn) => {
          slotInjects.push({ name, fn })
          return () => {}
        },
        register: (definition, component) => {
          slotRegistrations.push({ definition, component })
          return () => {}
        },
      },
    }
    return { ctx, slotInjects, slotRegistrations, localeRegistrations, whileServedCalls, rpcCalls, connection }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  /** Capture console.warn for the duration of a block. */
  const captureWarns = () => {
    const warns = []
    const original = console.warn
    console.warn = (...args) => warns.push(args)
    return {
      warns,
      restore: () => {
        console.warn = original
      },
    }
  }

  /** Drive every apply-time slot inject and return the named registration. */
  const registrationById = (slotInjects, slotRegistrations, id) => {
    for (const inject of slotInjects) inject.fn()
    return slotRegistrations.find((registration) => registration.definition.id === id)
  }

  it('gateway channel (capability): the four degradation paths, warn-once per shape, and the unknown-session silence', async () => {
    const { surface } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations, connection } = makeCtx()
    const { warns, restore } = captureWarns()
    try {
      surface.apply(ctx)
      const badge = registrationById(slotInjects, slotRegistrations, 'weir-capability-badge')
      const verbs = badge.definition.inject('s1')

      // 1. missing connection: fallback + one connection-missing warn —
      // warn-once keys on the KIND, so the second call's warn is swallowed
      ctx.get = () => undefined
      expect(await verbs.fetchReceipt('s1')).toBe(null)
      expect(await verbs.fetchListing('s1')).toEqual({ error: true })
      expect(warns.map((args) => args[0])).toEqual(['[weir] capability read degraded (connection-missing, receipt)'])

      // 2. carrier throw: fallback + one call-threw warn with the stack as detail
      ctx.get = (name) => (name === 'connection' ? connection : undefined)
      connection.rpc.call = () => Promise.reject(new Error('gateway/down'))
      expect(await verbs.fetchConditions('s1')).toEqual({ error: true })
      expect(await verbs.fetchConditions('s1')).toEqual({ error: true })
      expect(warns.filter((args) => String(args[0]).includes('call-threw'))).toHaveLength(1)
      expect(warns.find((args) => String(args[0]).includes('call-threw'))[0]).toBe('[weir] capability read degraded (call-threw, conditions)')

      // 3. failure envelope: fallback + one call-failed warn with the failure as detail
      connection.rpc.call = async (channel, endpoint, payload) => ({ ok: false, error: { code: 'gateway/internal', message: 'down' } })
      expect(await verbs.fetchReceipt('s1')).toBe(null)
      expect(await verbs.fetchReceipt('s1')).toBe(null)
      const failed = warns.filter((args) => String(args[0]).includes('call-failed'))
      expect(failed).toHaveLength(1)
      expect(failed[0][0]).toBe('[weir] capability read degraded (call-failed, receipt)')
      expect(failed[0][1]).toEqual({ code: 'gateway/internal', message: 'down' })

      // 4. unknown session: the documented cold-open convergence — NO warn
      connection.rpc.call = async () => ({ ok: false, error: { code: 'gateway/internal', message: 'unknown session' } })
      expect(await verbs.fetchReceipt('s1')).toBe(null)
      expect(warns.filter((args) => String(args[0]).includes('call-failed'))).toHaveLength(1)

      // 5. an ok envelope with a null value is a failure for the capability
      // reads (requireValue): the fallback applies; its warn rides the
      // (already spent) call-failed kind slot, exactly like the hand-written site
      connection.rpc.call = async () => ({ ok: true, value: null })
      expect(await verbs.fetchReceipt('s1')).toBe(null)
      expect(warns.filter((args) => String(args[0]).includes('call-failed'))).toHaveLength(1)

      // 6. healthy envelope: the value crosses
      connection.rpc.call = async () => ({ ok: true, value: { status: 'applied' } })
      expect(await verbs.fetchReceipt('s1')).toEqual({ status: 'applied' })
    } finally {
      restore()
    }
  })

  it('gateway channel (blackboard): connection-missing warns once with the endpoint; failures fold without a warn; never rejects', async () => {
    const { surface } = await loadEntry()
    const { ctx, connection } = makeCtx()
    const sidebarSlotRegistrations = []
    const sidebarScope = {
      effect: (fn) => { fn(); return () => {} },
      sidebarRightTabs: { register: () => () => {} },
      slots: { register: (definition, component) => { sidebarSlotRegistrations.push({ definition, component }); return () => {} } },
      locale: { bind: () => (key) => key },
    }
    ctx.inject = (names, fn) => {
      if (Array.isArray(names) && names.includes('sidebarRightTabs')) fn(sidebarScope)
      return () => {}
    }
    const { warns, restore } = captureWarns()
    try {
      surface.apply(ctx)
      const pane = sidebarSlotRegistrations.find((registration) => registration.definition.key === 'weir-blackboard')
      const { callBoard } = pane.definition.inject('s1')
      expect(typeof callBoard).toBe('function')

      // missing connection: the channel-unavailable shape + one warn (kind keyed)
      ctx.get = () => undefined
      expect(await callBoard('weirBlackboard/list', { args: { agentId: 's1', args: {} } })).toEqual({
        ok: false,
        error: { code: 'channel-unavailable', message: 'the blackboard channel has no gateway connection' },
      })
      await callBoard('weirBlackboard/read', { args: { agentId: 's1', args: { keys: [] } } })
      expect(warns.map((args) => args[0])).toEqual(['[weir] blackboard call degraded (connection-missing, weirBlackboard/list)'])

      // carrier throw: folded call-threw, NO warn (the panel surfaces it)
      ctx.get = (name) => (name === 'connection' ? connection : undefined)
      connection.rpc.call = () => Promise.reject(new Error('gateway/down'))
      expect(await callBoard('weirBlackboard/list', { args: { agentId: 's1', args: {} } })).toEqual({
        ok: false,
        error: { code: 'call-threw', message: 'gateway/down' },
      })

      // failure envelope: passes code/message through, NO warn
      connection.rpc.call = async () => ({ ok: false, error: { code: 'gateway/internal', message: 'down' } })
      expect(await callBoard('weirBlackboard/list', { args: { agentId: 's1', args: {} } })).toEqual({
        ok: false,
        error: { code: 'gateway/internal', message: 'down' },
      })

      // malformed answers fold defensively (the old chunk-side foldRemoteResult contract)
      connection.rpc.call = async () => null
      expect(await callBoard('weirBlackboard/list', {})).toEqual({ ok: false, error: { code: 'call-failed', message: 'unknown' } })
      connection.rpc.call = async () => ({})
      expect((await callBoard('weirBlackboard/list', {})).error.code).toBe('call-failed')

      // an ok envelope — even with a null value — succeeds (no requireValue here)
      connection.rpc.call = async () => ({ ok: true, value: null })
      expect(await callBoard('weirBlackboard/list', {})).toEqual({ ok: true, value: null })
      expect(warns).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('HTTP channel: wire init mapping, folded failure shapes, and detail passthrough (via the notify-web delivery env)', async () => {
    const { surface, notifyWebStarts } = await loadEntry()
    const { ctx } = makeCtx()
    surface.apply(ctx)
    await flush()
    expect(notifyWebStarts).toHaveLength(1)
    const channel = notifyWebStarts[0].channel
    expect(typeof channel).toBe('function')

    const calls = []
    let answer = null
    const originalFetch = globalThis.fetch
    globalThis.fetch = (endpoint, init) => {
      calls.push({ endpoint, init })
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve(answer)
    }
    try {
      // a payload crosses as a JSON body; none sends no body and no content-type
      answer = { status: 200, json: async () => ({ ok: true, value: { matched: true } }) }
      expect(await channel('api/weir-x/a', { id: 1 })).toEqual({ ok: true, value: { matched: true } })
      expect(calls[0].init.method).toBe('POST')
      expect(calls[0].init.credentials).toBe('include')
      expect(calls[0].init.headers).toEqual({ 'content-type': 'application/json' })
      expect(calls[0].init.body).toBe('{"id":1}')
      await channel('api/weir-x/status')
      expect(calls[1].init.body).toBeUndefined()
      expect(calls[1].init.headers).toBeUndefined()

      // the abort signal crosses verbatim
      const controller = new AbortController()
      await channel('api/weir-x/b', {}, { signal: controller.signal })
      expect(calls[2].init.signal).toBe(controller.signal)

      // failure envelope: code/message structured, extra fields preserved
      answer = { status: 409, json: async () => ({ ok: false, error: { code: 'weir-x/refused', message: 'not now', detail: 'the cause', commitStatus: 'not-acknowledged' } }) }
      expect(await channel('api/weir-x/c', {})).toEqual({
        ok: false,
        error: { code: 'weir-x/refused', message: 'not now', detail: 'the cause', commitStatus: 'not-acknowledged' },
      })

      // a messageless failure envelope defaults to the HTTP status
      answer = { status: 500, json: async () => ({ ok: false }) }
      expect(await channel('api/weir-x/d', {})).toEqual({ ok: false, error: { code: 'call-failed', message: 'HTTP 500' } })

      // a non-JSON answer and a carrier throw both fold to call-threw
      answer = { status: 404, json: () => Promise.reject(new SyntaxError('Unexpected token')) }
      const malformed = await channel('api/weir-x/e', {})
      expect(malformed.ok).toBe(false)
      expect(malformed.error.code).toBe('call-threw')
      answer = new Error('connection refused')
      expect(await channel('api/weir-x/f', {})).toEqual({ ok: false, error: { code: 'call-threw', message: 'connection refused' } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('HTTP channel through the Edit Lock view face: failures throw with the folded message', async () => {
    const { surface } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations } = makeCtx()
    surface.apply(ctx)
    const lockEntry = registrationById(slotInjects, slotRegistrations, 'weir-edit-lock')
    const fetchView = lockEntry.definition.inject('s1').fetchView

    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, value: { files: [] } }) })
      expect(await fetchView()).toEqual({ files: [] })
      globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'weir-edit-lock/invalid', message: 'body needs { sessionId }' } }) })
      await expect(() => fetchView()).rejects.toThrow('body needs { sessionId }')
      globalThis.fetch = async () => ({ status: 500, json: async () => ({}) })
      await expect(() => fetchView()).rejects.toThrow('HTTP 500')
      globalThis.fetch = () => Promise.reject(new Error('socket hang up'))
      await expect(() => fetchView()).rejects.toThrow('socket hang up')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('settings env read rides the HTTP channel through the controller deps, with the malformed marker on envelope/shape failures', async () => {
    const { surface, reactStub, controllerConstructed } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations, whileServedCalls } = makeCtx()
    surface.apply(ctx)
    whileServedCalls[0].register(new Set(['weir-settings']))
    const itemInject = slotInjects.find((inject) => inject.name === 'settings.weir.item')
    itemInject.fn()
    const item = slotRegistrations.find((registration) => registration.definition.name === 'settings.weir.item')
    reactStub.begin()
    item.component({ view: 'form', t: (key) => key })
    await flush()
    expect(controllerConstructed).toHaveLength(2)
    const fetchEnv = controllerConstructed[0].deps.fetchEnv
    expect(typeof fetchEnv).toBe('function')

    const calls = []
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (endpoint, init) => {
        calls.push({ endpoint, init })
        return Promise.resolve({ status: 200, json: async () => ({ ok: true, value: { platform: 'darwin' } }) })
      }
      expect(await fetchEnv()).toEqual({ platform: 'darwin' })
      expect(calls[0].endpoint).toBe('api/weir-settings/env')
      expect(calls[0].init.body).toBe('{}')

      // envelope-level failure → the malformed marker (the pre-adapter behavior)
      globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'x', message: 'y' } }) })
      await expect(() => fetchEnv()).rejects.toThrow('malformed environment facts response')
      // shape failure (ok but no platform) → same marker
      globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, value: {} }) })
      await expect(() => fetchEnv()).rejects.toThrow('malformed environment facts response')
      // carrier failure → the carrier's own message
      globalThis.fetch = () => Promise.reject(new Error('endpoint down'))
      await expect(() => fetchEnv()).rejects.toThrow('endpoint down')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
