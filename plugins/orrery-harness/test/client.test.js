import { describe, expect, it } from './helpers.js'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { loadClientChunk } from './helpers/load-client-chunk.js'

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
  // Hook-state-preserving react stub shared by the entry scaffold and the
  // real-chunk panel tests below.
  function makeReactStub() {
    const reactState = []
    let hookCursor = 0
    return {
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
  }
  async function loadEntry() {
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load: (definition) => loaded.push(definition),
      },
    }
    await import(`../lib/client.js?composition=${Math.random()}`)

    const reactStub = makeReactStub()
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
    const notifyWebStarts = []
    const notifyWebStops = []
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
    const disabledCategoriesEditorChunk = { DisabledCategoriesEditorField: (props) => ({ __disabledCategoriesEditor: props }) }
    const lspPanelChunk = { LspManagerField: (props) => ({ __lspPanel: props }) }
    const chainModelChunk = { marker: 'chain-model' }
    const robashModelChunk = { marker: 'robash-model' }
    const lspModelChunk = { marker: 'lsp-model' }
    const notifyPermissionsChunk = { NotifyPermissionsField: (props) => ({ __notifyPermissions: props }) }
    const editLockMaintenanceChunk = { EditLockMaintenanceField: (props) => ({ __editLockMaintenance: props }) }
    const notifyWebChunk = { startWebDelivery: (env) => { notifyWebStarts.push(env); return { stop: () => notifyWebStops.push(1) } } }
    const lspToggleChunk = { LspToggle: (props) => ({ __toggle: props }) }
    const hashEditViewChunk = { HashEditRow: (props) => ({ __row: props }) }
    const hashEditModelChunk = { HASH_EDIT_TOOL: 'hash_edit', marker: 'hash-edit-model' }
    const worktreeViewChunk = {
      WorktreeRowMarker: (props) => ({ __worktreeMarker: props }),
      WorktreeStatusPill: (props) => ({ __worktreePill: props }),
      LanesPanel: (props) => ({ __worktreePanel: props }),
      WorktreeToolRow: (props) => ({ __worktreeTool: props }),
    }
    const worktreeModelChunk = { WORKTREE_PROJECTION_KEY: 'orreryWorktree', marker: 'worktree-model' }
    const chunkModules = {
      './client.settings-page.js': settingsPageChunk,
      './client.chain-editor.js': chainEditorChunk,
      './client.robash-editor.js': robashEditorChunk,
      './client.disabled-categories-editor.js': disabledCategoriesEditorChunk,
      './client.lsp-panel.js': lspPanelChunk,
      './client.chain-model.js': chainModelChunk,
      './client.robash-model.js': robashModelChunk,
      './client.lsp-model.js': lspModelChunk,
      './client.notify-permissions.js': notifyPermissionsChunk,
      './client.edit-lock-maintenance.js': editLockMaintenanceChunk,
      './client.notify-web.js': notifyWebChunk,
      './client.lsp-toggle.js': lspToggleChunk,
      './client.hash-edit-view.js': hashEditViewChunk,
      './client.hash-edit-model.js': hashEditModelChunk,
      './client.worktree-view.js': worktreeViewChunk,
      './client.worktree-model.js': worktreeModelChunk,
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
      notifyWebStarts,
      notifyWebStops,
      controllerConstructed,
      sentinelSnapshot,
      settingsPageChunk,
      chainEditorChunk,
      disabledCategoriesEditorChunk,
      chainModelChunk,
      lspToggleChunk,
      hashEditViewChunk,
      hashEditModelChunk,
      worktreeViewChunk,
      worktreeModelChunk,
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
  // apply starts web notification delivery, which requests its own chunk.
  const NOTIFY_WEB_SPEC = './client.notify-web.js'
  const SETTINGS_CHUNK_SPECS = [
    './client.settings-page.js',
    './client.chain-editor.js',
    './client.robash-editor.js',
    './client.disabled-categories-editor.js',
    './client.lsp-panel.js',
    './client.chain-model.js',
    './client.robash-model.js',
    './client.lsp-model.js',
    './client.notify-permissions.js',
    './client.edit-lock-maintenance.js',
  ]

  it('loads, exposes the plugin surface, and registers the page chain', async () => {
    const { surface, reactStub } = await loadEntry()

    expect(surface.inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.session', 'remote.commands'])
    expect(surface.NS).toBe('settings.orrery')
    // the test-only export grab-bag is gone — only the host contract remains
    expect(surface.chainEditor).toBeUndefined()
    expect(surface.lspManager).toBeUndefined()
    expect(surface.robashEditor).toBeUndefined()
    expect(surface.disabledCategoriesEditor).toBeUndefined()
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
    expect(slotInjects.map((inject) => inject.name)).toEqual([
      'conversation.input.right', 'tool.call.toolview', 'conversation.input.right',
      // worktree surfaces (U1/U2/U6) register at apply, right after Edit Lock
      'sidebar.session.row.leading', 'conversation.session.header.utilities',
      'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview',
      // the session capability Badge (12.1): order 95, apply-level registration
      'conversation.input.right',
      'settings.section', 'settings.orrery.item', 'plugins.item',
    ])

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

    // the Edit Lock composer entry (rendered only while /edit-lock exists)
    slotInjects[2].fn()
    const lockEntry = slotRegistrations.find((registration) => registration.definition.id === 'orrery-edit-lock')
    expect(lockEntry.definition.name).toBe('conversation.input.right')
    expect(lockEntry.definition.inject()).toEqual({})
    const lockVerbs = lockEntry.definition.inject('s1')
    expect(lockVerbs.sessionId).toBe('s1')
    expect(typeof lockVerbs.runEditLock).toBe('function')

    // the worktree surfaces: session row marker, header pill, and one keyed
    // tool view per lane tool
    for (const index of [3, 4, 5, 6, 7, 8, 9]) slotInjects[index].fn()
    const marker = slotRegistrations.find((registration) => registration.definition.id === 'orrery-worktree-marker')
    expect(marker.definition.name).toBe('sidebar.session.row.leading')
    expect(marker.definition.inject('s1')).toEqual({ sessionId: 's1' })
    const pill = slotRegistrations.find((registration) => registration.definition.id === 'orrery-worktree-pill')
    expect(pill.definition.name).toBe('conversation.session.header.utilities')
    const laneToolViews = slotRegistrations.filter((registration) => registration.definition.name === 'tool.call.toolview' && registration.definition.key !== 'hash_edit')
    expect(laneToolViews.map((registration) => registration.definition.key).sort()).toEqual([
      'worktree_abandon', 'worktree_check', 'worktree_cleanup', 'worktree_land', 'worktree_open',
    ])

    // the top-level settings section registration
    slotInjects[11].fn()
    const { definition: sectionDef, component: sectionComponent } = slotRegistrations.find((registration) => registration.definition.name === 'settings.section')
    expect(sectionDef.name).toBe('settings.section')
    expect(sectionDef.id).toBe('orrery-settings')
    expect(sectionDef.order).toBe(40)
    expect(sectionDef.children['settings.orrery.item']).toEqual({ kind: 'list', scope: 'root' })
    expect(typeof sectionDef.label).toBe('function')
    reactStub.begin()
    expect(sectionComponent({ renderSlot: (slot) => slot, t: (key) => key })).toBeTruthy()

    // the item slot registration hosting the form card
    slotInjects[12].fn()
    const itemEntry = slotRegistrations.find((registration) => registration.definition.name === 'settings.orrery.item')
    expect(itemEntry.definition.id).toBe('orrery-config')

    // the Plugins-page entry
    slotInjects[13].fn()
    const { definition, component } = slotRegistrations.find((registration) => registration.definition.name === 'plugins.item')
    expect(definition.name).toBe('plugins.item')
    // the session capability Badge slot registration (12.1)
    slotInjects[10].fn()
    const badgeEntry = slotRegistrations.find((registration) => registration.definition.id === 'orrery-capability-badge')
    expect(badgeEntry.definition.name).toBe('conversation.input.right')
    expect(badgeEntry.definition.order).toBe(95)
    expect(badgeEntry.definition.inject()).toEqual({})
    const badgeVerbs = badgeEntry.definition.inject('s0')
    expect(badgeVerbs.sessionId).toBe('s0')
    expect(typeof badgeVerbs.fetchReceipt).toBe('function')

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

  it('fans out the 9 settings chunks, constructs the controller on arrival, and renders loading/arrived states', async () => {
    const { surface, reactStub, asyncCalls, controllerConstructed, sentinelSnapshot, settingsPageChunk, chainEditorChunk, chainModelChunk, lspToggleChunk, disabledCategoriesEditorChunk } = await loadEntry()
    const { ctx, whileServedCalls, slotInjects, slotRegistrations, scope, sessionAccesses } = makeCtx()
    surface.apply(ctx)
    whileServedCalls[0].register(new Set(['orrery-settings']))
    slotInjects[13].fn()
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
    // apply also starts web notification delivery, which pulls its own chunk first
    expect(asyncCalls.filter((spec) => spec !== NOTIFY_WEB_SPEC)).toEqual(SETTINGS_CHUNK_SPECS)

    // arrived: the settings-page chunk's OrreryCard with bound editors
    expect(settled.__type).toBe(settingsPageChunk.OrreryCard)
    expect(settled.view).toBe('form')
    expect(typeof settled.editors.ChainEditorField).toBe('function')
    expect(typeof settled.editors.RobashListEditorField).toBe('function')
    expect(typeof settled.editors.DisabledCategoriesEditorField).toBe('function')
    expect(typeof settled.editors.LspManagerField).toBe('function')
    expect(typeof settled.editors.EditLockMaintenanceField).toBe('function')
    // editors arrive pre-bound with their model chunks (stable identity)
    const boundChain = settled.editors.ChainEditorField({ text: 'x' })
    expect(boundChain.__type).toBe(chainEditorChunk.ChainEditorField)
    expect(boundChain.text).toBe('x')
    expect(boundChain.model).toBe(chainModelChunk)
    // the disabled-categories editor arrives bound to its chunk (no model)
    const boundDisabled = settled.editors.DisabledCategoriesEditorField({ text: 'x' })
    expect(boundDisabled.__type).toBe(disabledCategoriesEditorChunk.DisabledCategoriesEditorField)
    expect(boundDisabled.text).toBe('x')

    // the controller was constructed on arrival with the served scope and the
    // prop-injected deps; the deferred store now serves its snapshot
    expect(controllerConstructed).toHaveLength(1)
    expect(controllerConstructed[0].scope).toBe(scope)
    expect(typeof controllerConstructed[0].deps.getSession).toBe('function')
    expect(typeof controllerConstructed[0].deps.settingsBus.notify).toBe('function')
    expect(injected.hooks.orrerySettingsCard.getSnapshot()).toBe(sentinelSnapshot)

    // settingsBus 贯通: the composer toggle wrapper receives the same bus object
    slotInjects[0].fn()
    const composer = slotRegistrations.find((registration) => registration.definition.id === 'orrery-lsp-toggle')
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
    slotInjects[13].fn()
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
    expect(slotInjects.map((inject) => inject.name)).toEqual(['conversation.input.right', 'tool.call.toolview', 'conversation.input.right', 'sidebar.session.row.leading', 'conversation.session.header.utilities', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'conversation.input.right'])
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
    expect(asyncCalls.filter((spec) => spec !== NOTIFY_WEB_SPEC)).toEqual(['./client.lsp-toggle.js'])
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
    const { definition, component } = slotRegistrations.find((registration) => registration.definition.key === 'hash_edit')
    // registration carries the literal key — no chunk pull just to register
    expect(definition.key).toBe('hash_edit')
    expect(asyncCalls.filter((spec) => spec !== NOTIFY_WEB_SPEC)).toEqual([])

    const block = {
      call: { name: 'hash_edit', argsRaw: '{"file_path":"/ws/a.js","edits":[]}' },
      content: [{ type: 'text', text: 'applied 1 op' }],
    }
    const props = { phase: 'result', block, cwd: '/ws', t: (key) => key }

    // pre-arrival: the generic flattened input/output body
    reactStub.begin()
    const first = component(props)
    expect(asyncCalls.filter((spec) => spec !== NOTIFY_WEB_SPEC)).toEqual(['./client.hash-edit-view.js', './client.hash-edit-model.js'])
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

  it('worktree surfaces: gated arrival, one model chunk, and no host call before arrival', async () => {
    const { surface, reactStub, asyncCalls, worktreeViewChunk, worktreeModelChunk } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations } = makeCtx()
    surface.apply(ctx)
    // registration costs no chunk pull (the keyed tool views register literally)
    expect(asyncCalls.filter((spec) => spec !== NOTIFY_WEB_SPEC)).toEqual([])
    slotInjects[3].fn()
    const marker = slotRegistrations.find((registration) => registration.definition.id === 'orrery-worktree-marker')
    // the lane tool views are registered by their own injects (indices 5..9)
    for (const index of [5, 6, 7, 8, 9]) slotInjects[index].fn()
    const laneTool = slotRegistrations.find((registration) => registration.definition.key === 'worktree_land')

    // session row marker: renders nothing until the chunks arrive, then the view
    reactStub.begin()
    expect(marker.component({ sessionId: 's1', t: (key) => key })).toBe(null)
    await flush()
    reactStub.begin()
    const markerRendered = marker.component({ sessionId: 's1', t: (key) => key })
    expect(markerRendered.__type).toBe(worktreeViewChunk.WorktreeRowMarker)
    expect(markerRendered.model).toBe(worktreeModelChunk)
    expect(markerRendered.WORKTREE_PROJECTION_KEY).toBe('orreryWorktree')
    // the views' short keys resolve to the prefixed dictionary entries
    expect(markerRendered.t('abandon')).toBe('worktreeAbandon')
    expect(markerRendered.t('state_setup-failed')).toBe('worktreeState_setup_failed')
    expect(markerRendered.t('tool_worktree_land')).toBe('worktreeTool_worktree_land')

    // the lane tool view carries the model and narrows through it
    reactStub.begin()
    laneTool.component({ phase: 'result', block: { meta: null }, t: (key) => key })
    await flush()
    reactStub.begin()
    const toolRendered = laneTool.component({ phase: 'result', block: { meta: null }, t: (key) => key })
    expect(toolRendered.__type).toBe(worktreeViewChunk.WorktreeToolRow)
    expect(toolRendered.model).toBe(worktreeModelChunk)
    expect(toolRendered.t('mergeCommit')).toBe('worktreeMergeCommit')
    expect(asyncCalls).toContain('./client.worktree-view.js')
    expect(asyncCalls).toContain('./client.worktree-model.js')
  })

  it('lanes panel toolbar hosts the persistent Worktree mode toggle', async () => {
    // The composer mode switch is gone; mode toggling lives in the lanes
    // panel toolbar as a persistent toggle (off = outlined chip, on = solid
    // business badge), driven through the panel's runWorktree channel.
    const reactStub = makeReactStub()
    const jsxRuntime = { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected require ${name}`)
    }
    const { exports: viewChunk } = await loadClientChunk('lib/client.worktree-view.js', requireStub)
    const { exports: modelChunk } = await loadClientChunk('lib/client.worktree-model.js')

    const findNode = (node, pred) => {
      if (node === null || node === undefined || typeof node !== 'object') return undefined
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = findNode(child, pred)
          if (hit !== undefined) return hit
        }
        return undefined
      }
      if (pred(node)) return node
      return findNode(node.children, pred)
    }
    // The toggle element carries the chunk-internal component as __type (the
    // jsx stub records, never renders); invoke it like the hash_edit body.
    const isToggle = (node) => typeof node.__type === 'function' && typeof node.onToggle === 'function'
    const renderToggle = (tree) => {
      const element = findNode(tree, isToggle)
      return element?.__type(element)
    }

    const settle = async (props) => {
      reactStub.reset()
      reactStub.begin()
      viewChunk.LanesPanel(props)
      await flush()
      reactStub.begin()
      return viewChunk.LanesPanel(props)
    }
    const panelProps = (viewPayload, runs) => ({
      available: true,
      t: (key) => key,
      model: modelChunk,
      narrowView: modelChunk.narrowView,
      needsPolling: () => false,
      fetchView: async () => viewPayload,
      fetchDiff: async () => '',
      runWorktree: async (line) => { runs.push(line); return { kind: 'success', text: 'ok' } },
      ago: () => 'now',
      intervalMs: 60000,
    })
    const baseView = { available: true, mode: false, lanes: [], ownedBySession: [], unmanaged: [] }

    // off state: outlined chip with the mode tooltip; a click issues
    // /worktree on through the panel command channel
    const offRuns = []
    const offTree = await settle(panelProps({ ...baseView, mode: false }, offRuns))
    const offToggle = renderToggle(offTree)
    expect(offToggle['data-orrery-worktree-mode']).toBe('off')
    expect(offToggle['aria-pressed']).toBe(false)
    expect(offToggle.disabled).toBe(false)
    expect(offToggle.title).toBe('modeTitle')
    expect(offToggle.style.borderColor).toBe('var(--dsw-alias-border-l2)')
    offToggle.onClick()
    expect(offRuns).toEqual(['on'])
    await flush()

    // on state: solid business badge style; the retired static mode badge
    // no longer renders
    const onRuns = []
    const onTree = await settle(panelProps({ ...baseView, mode: true }, onRuns))
    const onToggle = renderToggle(onTree)
    expect(onToggle['data-orrery-worktree-mode']).toBe('on')
    expect(onToggle['aria-pressed']).toBe(true)
    expect(onToggle.style.background).toBe('var(--dsw-alias-state-business-primary)')
    expect(JSON.stringify(onTree)).not.toContain('modeOn')
    onToggle.onClick()
    expect(onRuns).toEqual(['off'])
    await flush()

    // unavailable: the toggle persists, disabled, its tooltip naming the reason
    const disabledTree = await settle(panelProps({ ...baseView, available: false, enabled: false }, []))
    const disabledToggle = renderToggle(disabledTree)
    expect(disabledToggle.disabled).toBe(true)
    expect(disabledToggle.title).toContain('modeUnavailable')
    expect(disabledToggle.title).toContain('disabled')
    const errorTree = await settle(panelProps({ ...baseView, available: false, error: { code: 'NOT_A_REPO', message: 'not inside a git repository' } }, []))
    const errorToggle = renderToggle(errorTree)
    expect(errorToggle.disabled).toBe(true)
    expect(errorToggle.title).toContain('not inside a git repository')
  })

  it('starts web notification delivery at apply, independent of the settings page, and stops it on dispose', async () => {
    const { surface, notifyWebStarts, notifyWebStops } = await loadEntry()
    const { ctx, effects } = makeCtx()
    // run the effects with a disposer-capturing ctx.effect
    const disposers = []
    ctx.effect = (fn) => {
      effects.push(fn)
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    }
    surface.apply(ctx)
    await flush()
    // started once, on the real global environment (fetch/Notification/document come from the page)
    expect(notifyWebStarts).toHaveLength(1)
    expect(notifyWebStarts[0]).toBe(globalThis)
    expect(notifyWebStops).toHaveLength(0)
    for (const dispose of disposers) dispose()
    expect(notifyWebStops).toHaveLength(1)
  })

  it('does not start delivery if the effect is disposed before the chunk arrives', async () => {
    const { surface, notifyWebStarts, notifyWebStops } = await loadEntry()
    const { ctx } = makeCtx()
    const disposers = []
    ctx.effect = (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    }
    surface.apply(ctx)
    // dispose synchronously, before the lazy chunk promise resolves
    for (const dispose of disposers) dispose()
    await flush()
    expect(notifyWebStarts).toHaveLength(0)
    expect(notifyWebStops).toHaveLength(0)
  })

  it('a failed delivery chunk load is harmless: apply completes, nothing starts, nothing throws', async () => {
    const { surface, setAsyncFailure, notifyWebStarts } = await loadEntry()
    const { ctx, localeRegistrations, whileServedCalls } = makeCtx()
    setAsyncFailure(new Error('stale revision'))
    // the unhandled-rejection guard: a rejected lazy chunk must be swallowed by apply
    let unhandled = null
    const onUnhandled = (error) => { unhandled = error }
    process.once('unhandledRejection', onUnhandled)
    surface.apply(ctx)
    await flush()
    await flush()
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toBeNull()
    expect(notifyWebStarts).toHaveLength(0)
    // everything else still registered
    expect(localeRegistrations).toHaveLength(1)
    expect(whileServedCalls).toHaveLength(1)
  })
  it('registers the capabilities panel as a right-sidebar tab when the sidebar package is available', async () => {
    const { surface } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations, sessionAccesses } = makeCtx()

    // A shell WITH the sidebar right package: the optional inject runs and
    // hands the composition root a sidebar scope (worktree + capabilities).
    const sidebarTabRegistrations = []
    const sidebarSlotRegistrations = []
    const sidebarScope = {
      effect: (fn) => { fn(); return () => {} },
      sidebarRightTabs: { register: (definition) => { sidebarTabRegistrations.push(definition); return () => {} } },
      slots: { register: (definition, component) => { sidebarSlotRegistrations.push({ definition, component }); return () => {} } },
      locale: { bind: () => (key) => key },
    }
    ctx.inject = (names, fn) => {
      if (Array.isArray(names) && names.includes('sidebarRightTabs')) fn(sidebarScope)
      return () => {}
    }
    const openedTabs = []
    ctx.get = (name) => (name === 'sidebarRight' ? { openTab: (id) => openedTabs.push(id) } : undefined)

    surface.apply(ctx)

    // the orrery-capabilities tab type registration (D1)
    const tab = sidebarTabRegistrations.find((registration) => registration.id === 'orrery-capabilities')
    expect(tab).toBeTruthy()
    expect(tab.kind).toBe('orrery-capabilities')
    expect(tab.priority).toBe('extension')
    expect(tab.title()).toBe('capabilityTabLabel')
    expect(tab.guide).toHaveLength(1)
    expect(tab.guide[0].id).toBe('capabilities')
    expect(tab.guide[0].order).toBe(40)
    expect(tab.guide[0].title()).toBe('capabilityGuideTitle')
    expect(tab.guide[0].description()).toBe('capabilityGuideDescription')

    // the pane tab slot: same verb face as the composer Badge, gated on a session
    const pane = sidebarSlotRegistrations.find((registration) => registration.definition.key === 'orrery-capabilities')
    expect(pane).toBeTruthy()
    expect(pane.definition.name).toBe('sidebar.right.pane.tab')
    expect(pane.definition.locale).toBe('settings.orrery')
    expect(pane.definition.inject()).toEqual({})
    const paneVerbs = pane.definition.inject('s9')
    expect(paneVerbs.sessionId).toBe('s9')
    for (const verb of ['fetchReceipt', 'subscribeFrames', 'applySelection', 'mcpAdd', 'fetchListing', 'fetchConditions', 'loadPresets', 'fetchPresets', 'presetSave', 'presetLoad', 'presetDelete', 'presetExport', 'presetImport', 'defaultGet', 'defaultSave', 'defaultClear']) {
      expect(typeof paneVerbs[verb]).toBe('function')
    }

    // with the tab mounted, the Badge's inject gains openPanel (D4) and it
    // opens exactly this tab
    slotInjects[10].fn()
    const badgeEntry = slotRegistrations.find((registration) => registration.definition.id === 'orrery-capability-badge')
    const badgeVerbs = badgeEntry.definition.inject('s0')
    expect(typeof badgeVerbs.openPanel).toBe('function')
    badgeVerbs.openPanel()
    expect(openedTabs).toEqual(['orrery-capabilities'])

    // S17: even the sidebar registration never dereferences remote.session
    expect(sessionAccesses()).toBe(0)
  })

  it('registers ZERO capability sidebar surface when the sidebar package is absent', async () => {
    const { surface } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations } = makeCtx() // no ctx.inject: the optional block is skipped
    surface.apply(ctx)
    for (const inject of slotInjects) inject.fn()

    // no right-sidebar pane tab from any capability surface
    expect(slotRegistrations.filter((registration) => registration.definition.name === 'sidebar.right.pane.tab')).toEqual([])

    // the Badge keeps its popover fallback: no openPanel verb is injected
    const badgeEntry = slotRegistrations.find((registration) => registration.definition.id === 'orrery-capability-badge')
    expect(badgeEntry).toBeTruthy()
    const badgeVerbs = badgeEntry.definition.inject('s0')
    expect(badgeVerbs.sessionId).toBe('s0')
    expect(typeof badgeVerbs.fetchReceipt).toBe('function')
    expect('openPanel' in badgeVerbs).toBe(false)
  })

  it('build binds the entry to every chunk digest and publishes the entry last', () => {
    // Host chunk URLs carry the entry revision. Both content binding and write
    // ordering matter: a timestamp-only restamp is not a client build.
    const libDir = new URL('../lib/', import.meta.url)
    const entryMtimeMs = statSync(new URL('client.js', libDir)).mtimeMs
    const chunks = readdirSync(libDir).filter((name) => /^client\..+\.js$/.test(name))
    expect(chunks.length).toBeGreaterThan(0)
    const firstLine = readFileSync(new URL('client.js', libDir), 'utf8').split('\n')[0]
    const manifest = JSON.parse(firstLine.replace('// Orrery client chunks: ', ''))
    expect(Object.keys(manifest).sort()).toEqual([...chunks].sort())
    for (const name of chunks) {
      const chunkMtimeMs = statSync(new URL(name, libDir)).mtimeMs
      expect(chunkMtimeMs <= entryMtimeMs, `${name} is newer than the entry — run pnpm build`).toBe(true)
      expect(manifest[name]).toBe(createHash('sha256').update(readFileSync(new URL(name, libDir))).digest('hex'))
    }
  })
})
