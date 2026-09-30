import { describe, expect, it } from './helpers.js'

/**
 * Entry composition-root test for the browser half (lib/client.js, authored
 * in the build-output `window.__ModuleLoader__.load` format). One scaffold
 * executes the entry under Node with a stubbed loader, stub baseline
 * requires, and sentinel chunk modules behind require.async, then drives the
 * factory and apply against fake cordis/browser services to prove: the
 * synchronous apply contract (dictionaries + slot wrappers, no chunk needed),
 * the require.async specifier sequence per surface, the loading/error/
 * arrived wrapper states, the settingsBus prop threading, and the S17
 * remote.session laziness. Feature-level assertions live in the per-chunk
 * test files (client-*.test.js via test/helpers/load-client-chunk.js).
 */

describe('orrery settings client half', () => {
  // Entry composition scaffold: hook-state-preserving react stub, jsx marker
  // factory, sentinel chunk modules behind require.async, and a fake cordis
  // ctx whose remote.session getter counts dereferences (S17 laziness pin).
  async function loadEntry() {
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load: (definition) => loaded.push(definition),
      },
    }
    await import(`../lib/client.js?composition=${Math.random()}`)

    const reactState = []
    let hookCursor = 0
    const reactStub = {
      reset() {
        reactState.length = 0
      },
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
    // baseline requires: the entry's sync require face (react/jsx-runtime plus
    // the pre-split regions still in the file until the final slim-down)
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      if (name === 'orrery-model-picker') return {}
      throw new Error(`unexpected require ${name}`)
    }
    // sentinel chunk modules behind require.async
    const asyncCalls = []
    const controllerConstructed = []
    const sentinelSnapshot = { marker: 'snapshot' }
    const settingsPageChunk = {
      OrreryCardController: class {
        constructor(scope, deps) {
          this.scope = scope
          this.deps = deps
          this.store = { getSnapshot: () => sentinelSnapshot, subscribe: () => () => {} }
          controllerConstructed.push(this)
        }
        inject() {
          return { hooks: { orrerySettingsCard: this.store }, edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
        }
        dispose() {
          this.disposed = true
        }
      },
      OrreryCard: (props) => ({ __card: props }),
      OrrerySection: (props) => ({ __section: props }),
    }
    const chainEditorChunk = { ChainEditorField: (props) => ({ __chainEditor: props }) }
    const robashEditorChunk = { RobashListEditorField: (props) => ({ __robashEditor: props }) }
    const lspPanelChunk = { LspManagerField: (props) => ({ __lspPanel: props }) }
    const chainModelChunk = { marker: 'chain-model' }
    const robashModelChunk = { marker: 'robash-model' }
    const lspModelChunk = { marker: 'lsp-model' }
    const lspToggleChunk = { LspToggle: (props) => ({ __toggle: props }) }
    const hashEditViewChunk = { HashEditRow: (props) => ({ __row: props }) }
    const hashEditModelChunk = { HASH_EDIT_TOOL: 'hash_edit', marker: 'hash-edit-model' }
    const chunkModules = {
      './client.settings-page.js': settingsPageChunk,
      './client.chain-editor.js': chainEditorChunk,
      './client.robash-editor.js': robashEditorChunk,
      './client.lsp-panel.js': lspPanelChunk,
      './client.chain-model.js': chainModelChunk,
      './client.robash-model.js': robashModelChunk,
      './client.lsp-model.js': lspModelChunk,
      './client.lsp-toggle.js': lspToggleChunk,
      './client.hash-edit-view.js': hashEditViewChunk,
      './client.hash-edit-model.js': hashEditModelChunk,
    }
    let asyncFailure = null
    requireStub.async = (spec) => {
      asyncCalls.push(spec)
      if (asyncFailure) return Promise.reject(asyncFailure)
      const module = chunkModules[spec]
      if (!module) return Promise.reject(new Error(`unexpected chunk ${spec}`))
      return Promise.resolve(module)
    }
    return {
      surface: loaded[0].factory(requireStub),
      reactStub,
      asyncCalls,
      controllerConstructed,
      sentinelSnapshot,
      settingsPageChunk,
      chainEditorChunk,
      chainModelChunk,
      lspToggleChunk,
      hashEditViewChunk,
      hashEditModelChunk,
      setAsyncFailure: (error) => {
        asyncFailure = error
      },
    }
  }

  function makeCtx() {
    const effects = []
    const localeRegistrations = []
    const whileServedCalls = []
    const slotInjects = []
    const slotRegistrations = []
    const scope = { ns: 'orrery-settings' }
    let sessionAccesses = 0
    const executed = []
    const remote = {
      commands: {
        execute: async (sessionId, input, args) => {
          executed.push({ sessionId, input, args })
          if (input === '/lsp on') return { ok: true, value: { kind: 'success' } }
          return { ok: false, error: { message: 'boom', code: 'X' } }
        },
        list: async () => ({ ok: true, value: [{ name: 'lsp' }, { name: 'plan' }] }),
      },
    }
    Object.defineProperty(remote, 'session', {
      get: () => {
        sessionAccesses += 1
        return { projections: async ({ sessionId }) => ({ ok: true, value: sessionId === 'on-session' ? { orreryLsp: { enabled: true } } : null }) }
      },
    })
    const ctx = {
      locale: {
        bind: () => (key) => key,
        register: (ns, dicts) => localeRegistrations.push({ ns, dicts }),
      },
      effect: (fn) => {
        effects.push(fn)
        fn() // cordis effects run their setup synchronously at registration
        return () => {}
      },
      configForms: {
        get: () => scope,
        whileServed: (namespaces, register) => {
          whileServedCalls.push({ namespaces, register })
          return () => {}
        },
      },
      remote,
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
    return { ctx, effects, localeRegistrations, whileServedCalls, slotInjects, slotRegistrations, scope, executed, sessionAccesses: () => sessionAccesses }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const SETTINGS_CHUNK_SPECS = [
    './client.settings-page.js',
    './client.chain-editor.js',
    './client.robash-editor.js',
    './client.lsp-panel.js',
    './client.chain-model.js',
    './client.robash-model.js',
    './client.lsp-model.js',
  ]

  it('loads, exposes the plugin surface, and registers the page chain', async () => {
    const { surface, reactStub } = await loadEntry()

    expect(surface.inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.session', 'remote.commands'])
    expect(surface.NS).toBe('settings.orrery')
    // the test-only export grab-bag is gone — only the host contract remains
    expect(surface.chainEditor).toBeUndefined()
    expect(surface.lspManager).toBeUndefined()
    expect(surface.robashEditor).toBeUndefined()
    expect(surface.hashEditView).toBeUndefined()

    // apply: locale dictionaries registered synchronously, then the slot
    // registration chain — no chunk request needed for apply itself (S18)
    const { ctx, localeRegistrations, whileServedCalls, slotInjects, slotRegistrations, sessionAccesses } = makeCtx()
    surface.apply(ctx)

    expect(localeRegistrations).toHaveLength(1)
    expect(localeRegistrations[0].dicts.en.title).toBe('Orrery')
    expect(localeRegistrations[0].dicts.zh.title).toBe('Orrery')
    // the chunk arrival states carry dictionary entries (templates in English)
    expect(localeRegistrations[0].dicts.en.loading).toBe('Loading Orrery settings…')
    expect(localeRegistrations[0].dicts.en.loadFailed).toBe('Orrery settings could not be loaded:')
    expect(localeRegistrations[0].dicts.zh.loading).toBe('正在加载 Orrery 设置…')
    expect(localeRegistrations[0].dicts.zh.loadFailed).toBe('Orrery 设置加载失败：')
    expect(whileServedCalls).toHaveLength(1)
    expect(whileServedCalls[0].namespaces).toEqual(['orrery-settings'])

    // drive the whileServed registration: the composer toggle and the hash_edit
    // toolview registered at apply, then three page-chain slot injects
    whileServedCalls[0].register(new Set(['orrery-settings']))
    expect(slotInjects.map((inject) => inject.name)).toEqual(['conversation.input.right', 'tool.call.toolview', 'settings.section', 'settings.orrery.item', 'plugins.item'])

    // the per-session LSP toggle in the conversation composer bar slot
    slotInjects[0].fn()
    expect(slotRegistrations).toHaveLength(1)
    expect(slotRegistrations[0].definition.name).toBe('conversation.input.right')
    expect(slotRegistrations[0].definition.id).toBe('orrery-lsp-toggle')
    expect(slotRegistrations[0].definition.order).toBe(100)

    // the keyed hash_edit conversation view registration
    slotInjects[1].fn()
    expect(slotRegistrations).toHaveLength(2)
    const { definition: toolviewDef, component: toolviewComponent } = slotRegistrations[1]
    expect(toolviewDef.name).toBe('tool.call.toolview')
    expect(toolviewDef.key).toBe('hash_edit')
    expect(toolviewDef.locale).toBe('settings.orrery')
    expect(typeof toolviewComponent).toBe('function')

    // the top-level settings section registration
    slotInjects[2].fn()
    expect(slotRegistrations).toHaveLength(3)
    const { definition: sectionDef, component: sectionComponent } = slotRegistrations[2]
    expect(sectionDef.name).toBe('settings.section')
    expect(sectionDef.id).toBe('orrery-settings')
    expect(sectionDef.order).toBe(40)
    expect(sectionDef.children['settings.orrery.item']).toEqual({ kind: 'list', scope: 'root' })
    expect(typeof sectionDef.label).toBe('function')
    reactStub.begin()
    expect(sectionComponent({ renderSlot: (slot) => slot, t: (key) => key })).toBeTruthy()

    // the item slot registration hosting the form card
    slotInjects[3].fn()
    expect(slotRegistrations).toHaveLength(4)
    expect(slotRegistrations[3].definition.name).toBe('settings.orrery.item')
    expect(slotRegistrations[3].definition.id).toBe('orrery-config')

    // the Plugins-page entry
    slotInjects[4].fn()
    expect(slotRegistrations).toHaveLength(5)
    const { definition, component } = slotRegistrations[4]
    expect(definition.name).toBe('plugins.item')
    expect(definition.id).toBe('orrery-settings')
    expect(definition.order).toBe(30)
    expect(typeof definition.label).toBe('function')
    expect(typeof definition.inject).toBe('function')

    // the page inject(): form hooks + save/edit/discard actions (a stable
    // deferred-store face plus controller-delegating verbs)
    const injected = definition.inject()
    expect(injected.hooks.orrerySettingsCard).toBeTruthy()
    expect(typeof injected.save).toBe('function')
    expect(typeof injected.edit).toBe('function')
    expect(typeof injected.discard).toBe('function')

    // the card wrapper renders the summary description without pulling chunks
    reactStub.begin()
    expect(component({ view: 'summary', t: (key) => key })).toBe('description')

    // S17: apply and the registration chain never dereference remote.session
    expect(sessionAccesses()).toBe(0)
  })

  it('fans out the 7 settings chunks, constructs the controller on arrival, and renders loading/arrived states', async () => {
    const { surface, reactStub, asyncCalls, controllerConstructed, sentinelSnapshot, settingsPageChunk, chainEditorChunk, chainModelChunk, lspToggleChunk } = await loadEntry()
    const { ctx, whileServedCalls, slotInjects, slotRegistrations, scope, sessionAccesses } = makeCtx()
    surface.apply(ctx)
    whileServedCalls[0].register(new Set(['orrery-settings']))
    slotInjects[4].fn()
    const { definition, component } = slotRegistrations.find((registration) => registration.definition.name === 'plugins.item')
    const injected = definition.inject()

    const settle = async (props) => {
      reactStub.reset()
      reactStub.begin()
      const first = component(props)
      await flush()
      reactStub.begin()
      return { first, settled: component(props) }
    }
    const formProps = { view: 'form', t: (key) => key }

    // loading state: one parallel 7-chunk Promise.all, dictionary copy
    const { first, settled } = await settle(formProps)
    expect(first.children).toBe('loading')
    expect(asyncCalls).toEqual(SETTINGS_CHUNK_SPECS)

    // arrived: the settings-page chunk's OrreryCard with bound editors
    expect(settled.__type).toBe(settingsPageChunk.OrreryCard)
    expect(settled.view).toBe('form')
    expect(typeof settled.editors.ChainEditorField).toBe('function')
    expect(typeof settled.editors.RobashListEditorField).toBe('function')
    expect(typeof settled.editors.LspManagerField).toBe('function')
    // editors arrive pre-bound with their model chunks (stable identity)
    const boundChain = settled.editors.ChainEditorField({ text: 'x' })
    expect(boundChain.__type).toBe(chainEditorChunk.ChainEditorField)
    expect(boundChain.text).toBe('x')
    expect(boundChain.model).toBe(chainModelChunk)

    // the controller was constructed on arrival with the served scope and the
    // prop-injected deps; the deferred store now serves its snapshot
    expect(controllerConstructed).toHaveLength(1)
    expect(controllerConstructed[0].scope).toBe(scope)
    expect(typeof controllerConstructed[0].deps.getSession).toBe('function')
    expect(typeof controllerConstructed[0].deps.settingsBus.notify).toBe('function')
    expect(injected.hooks.orrerySettingsCard.getSnapshot()).toBe(sentinelSnapshot)

    // settingsBus 贯通: the composer toggle wrapper receives the same bus object
    slotInjects[0].fn()
    const composer = slotRegistrations.find((registration) => registration.definition.name === 'conversation.input.right')
    const composerSettle = async (props) => {
      reactStub.reset()
      reactStub.begin()
      composer.component(props)
      await flush()
      reactStub.begin()
      return composer.component(props)
    }
    const toggleRendered = await composerSettle({ sessionId: 'sess-1', t: (key) => key })
    expect(toggleRendered.__type).toBe(lspToggleChunk.LspToggle)
    expect(toggleRendered.settingsBus).toBe(controllerConstructed[0].deps.settingsBus)

    // S17: even a full arrival cycle never dereferences remote.session
    expect(sessionAccesses()).toBe(0)
  })

  it('renders the error state on chunk failure and retries on re-entry', async () => {
    const { surface, reactStub, setAsyncFailure, settingsPageChunk } = await loadEntry()
    const { ctx, whileServedCalls, slotInjects, slotRegistrations } = makeCtx()
    surface.apply(ctx)
    whileServedCalls[0].register(new Set(['orrery-settings']))
    slotInjects[4].fn()
    const { component } = slotRegistrations.find((registration) => registration.definition.name === 'plugins.item')

    const settle = async (props) => {
      reactStub.reset()
      reactStub.begin()
      const first = component(props)
      await flush()
      reactStub.begin()
      return { first, settled: component(props) }
    }
    const formProps = { view: 'form', t: (key) => key }

    // a failed chunk request (e.g. a stale revision URL) degrades the section
    // body to an explicit error state naming the failure
    setAsyncFailure(new Error('stale revision'))
    const failed = await settle(formProps)
    expect(failed.settled.children).toContain('loadFailed')
    expect(failed.settled.children).toContain('stale revision')

    // the failure is not memoized: re-entering the surface retries and arrives
    setAsyncFailure(null)
    const retried = await settle(formProps)
    expect(retried.settled.__type).toBe(settingsPageChunk.OrreryCard)
  })

  it('injects the composer-bar switch verbs, drives /lsp via commands, and reads the projection', async () => {
    const { surface } = await loadEntry()
    expect(surface.inject).toContain('remote.commands')
    const { ctx, slotInjects, slotRegistrations, executed } = makeCtx()
    surface.apply(ctx)
    expect(slotInjects.map((inject) => inject.name)).toEqual(['conversation.input.right', 'tool.call.toolview'])
    slotInjects[0].fn()
    const { definition } = slotRegistrations[0]
    expect(definition.id).toBe('orrery-lsp-toggle')
    expect(definition.locale).toBe('settings.orrery')

    // inject without a session id renders nothing
    expect(definition.inject(undefined)).toEqual({})

    // inject verbs: toggleLsp maps /lsp on|off through remote commands
    const injected = definition.inject('sess-1')
    expect(injected.sessionId).toBe('sess-1')
    expect(await injected.toggleLsp(true)).toBe(null)
    expect(executed).toEqual([{ sessionId: 'sess-1', input: '/lsp on', args: [] }])
    expect(await injected.toggleLsp(false)).toBe('boom (X)')
    expect(executed[1]).toEqual({ sessionId: 'sess-1', input: '/lsp off', args: [] })
    expect(await injected.commandsList('sess-1')).toEqual([{ name: 'lsp' }, { name: 'plan' }])
    expect(await injected.fetchLspState()).toBe(undefined)
    const onInjected = definition.inject('on-session')
    expect(await onInjected.fetchLspState()).toBe(true)
  })

  it('composer wrapper renders null before the toggle chunk arrives and never pulls it when the gate is absent', async () => {
    const { surface, reactStub, asyncCalls, lspToggleChunk } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations } = makeCtx()
    surface.apply(ctx)
    slotInjects[0].fn()
    const { component } = slotRegistrations[0]

    // wrapper: renders null until the toggle chunk arrives, then renders the
    // chunk's LspToggle with the entry-owned settingsBus as a prop
    const baseProps = {
      sessionId: 'sess-1',
      t: (key) => key,
      toggleLsp: async () => null,
      fetchLspState: async () => undefined,
      commandsList: async () => [{ name: 'lsp' }],
    }
    const settle = async (props) => {
      reactStub.reset()
      reactStub.begin()
      const first = component(props)
      await flush()
      reactStub.begin()
      return { first, settled: component(props) }
    }
    const { first, settled } = await settle(baseProps)
    expect(first).toBe(null)
    expect(asyncCalls).toEqual(['./client.lsp-toggle.js'])
    expect(settled.__type).toBe(lspToggleChunk.LspToggle)
    expect(settled.sessionId).toBe('sess-1')
    expect(typeof settled.settingsBus?.subscribe).toBe('function')

    // gate absent (no session id): nothing renders and the chunk is not pulled
    asyncCalls.length = 0
    const gated = await settle({ ...baseProps, sessionId: undefined })
    expect(gated.first).toBe(null)
    expect(gated.settled).toBe(null)
    expect(asyncCalls).toEqual([])
  })

  it('hash_edit toolview wrapper renders the flattened body before arrival and the diff row after', async () => {
    const { surface, reactStub, asyncCalls, hashEditViewChunk, hashEditModelChunk } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations } = makeCtx()
    surface.apply(ctx)
    slotInjects[1].fn()
    const { definition, component } = slotRegistrations.find((registration) => registration.definition.name === 'tool.call.toolview')
    // registration carries the literal key — no chunk pull just to register
    expect(definition.key).toBe('hash_edit')
    expect(asyncCalls).toEqual([])

    const block = {
      call: { name: 'hash_edit', argsRaw: '{"file_path":"/ws/a.js","edits":[]}' },
      content: [{ type: 'text', text: 'applied 1 op' }],
    }
    const props = { phase: 'result', block, cwd: '/ws', t: (key) => key }

    // pre-arrival: the generic flattened input/output body
    reactStub.begin()
    const first = component(props)
    expect(asyncCalls).toEqual(['./client.hash-edit-view.js', './client.hash-edit-model.js'])
    const body = first.__type(props)
    expect(body['data-tool']).toBe('hash_edit')
    expect(body.children[0].children[0].children).toBe('hashEditInput')
    expect(body.children[0].children[1].children).toBe(block.call.argsRaw)
    expect(body.children[1].children[0].children).toBe('hashEditOutput')
    expect(body.children[1].children[1].children).toBe('applied 1 op')

    // post-arrival: the view chunk's HashEditRow with the model exports as prop
    await flush()
    reactStub.begin()
    const settled = component(props)
    expect(settled.__type).toBe(hashEditViewChunk.HashEditRow)
    expect(settled.model).toBe(hashEditModelChunk)
    expect(settled.phase).toBe('result')
    expect(settled.block).toBe(block)
  })
})
