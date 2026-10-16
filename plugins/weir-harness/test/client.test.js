import { describe, expect, it } from './helpers.js'
import { readdirSync, readFileSync } from 'node:fs'
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

describe('weir settings client half', () => {
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
      throw new Error(`unexpected require ${name}`)
    }
    // sentinel chunk modules behind require.async
    const asyncCalls = []
    const notifyWebStarts = []
    const notifyWebStops = []
    const controllerConstructed = []
    const sentinelSnapshot = { marker: 'snapshot' }
    // Marker data faces: the dictionary migration pins assert these arrive as
    // one merged "settings.weir.page" registration (never as duplicate pairs).
    const markerDict = (name) => ({ en: { [`pageSentinel.${name}`]: `${name} en` }, zh: { [`pageSentinel.${name}`]: `${name} zh` } })
    const settingsPageChunk = {
      WeirCardController: class {
        constructor(scope, deps, page) {
          this.scope = scope
          this.deps = deps
          this.page = page
          this.store = { getSnapshot: () => sentinelSnapshot, subscribe: () => () => {} }
          controllerConstructed.push(this)
        }
        inject() {
          return { hooks: { weirSettingsCard: this.store }, edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} }
        }
        dispose() {
          this.disposed = true
        }
      },
      WeirCard: (props) => ({ __card: props }),
      WeirSection: (props) => ({ __section: props }),
      dictionaries: markerDict('settingsPage'),
    }
    const chainEditorChunk = { ChainEditorField: (props) => ({ __chainEditor: props }) }
    const robashEditorChunk = { RobashListEditorField: (props) => ({ __robashEditor: props }) }
    const disabledCategoriesEditorChunk = { DisabledCategoriesEditorField: (props) => ({ __disabledCategoriesEditor: props }) }
    const lspPanelChunk = { LspManagerField: (props) => ({ __lspPanel: props }) }
    const modelPickerChunk = { ModelPickerField: (props) => ({ __picker: props }), ModelPickerBoundary: (props) => ({ __pickerBoundary: props }) }
    const chainModelChunk = { marker: 'chain-model', dictionaries: markerDict('chain') }
    const robashModelChunk = { marker: 'robash-model', dictionaries: markerDict('robash') }
    const lspModelChunk = { marker: 'lsp-model', dictionaries: markerDict('lsp') }
    const notifyPermissionsChunk = { NotifyPermissionsField: (props) => ({ __notifyPermissions: props }), dictionaries: markerDict('notifyPermissions') }
    const editLockMaintenanceChunk = { EditLockMaintenanceField: (props) => ({ __editLockMaintenance: props }), dictionaries: markerDict('editLockMaintenance') }
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
    const worktreeModelChunk = { WORKTREE_PROJECTION_KEY: 'weirWorktree', marker: 'worktree-model' }
    const presetChunk = { CapabilityPresetsView: () => null }
    const capabilityBadgeChunk = { CapabilityBadge: (props) => ({ __badge: props }) }
    const capabilityModelChunk = { marker: 'capability-model', dictionaries: { en: { 'capability.sentinel': 'cap en' }, zh: { 'capability.sentinel': 'cap zh' } } }
    const capabilityManagerChunk = { CapabilityManagerPanel: (props) => ({ __capabilityPanel: props }) }
    const blackboardModelChunk = { marker: 'blackboard-model', dictionaries: { en: { 'blackboard.sentinel': 'board en' }, zh: { 'blackboard.sentinel': 'board zh' } } }
    const blackboardPanelChunk = { BlackboardPanel: (props) => ({ __blackboardPanel: props }) }
    const chunkModules = {
      './client.capability-presets.js': presetChunk,
      './client.capability-badge.js': capabilityBadgeChunk,
      './client.capability-model.js': capabilityModelChunk,
      './client.capability-manager.js': capabilityManagerChunk,
      './client.blackboard-model.js': blackboardModelChunk,
      './client.blackboard-panel.js': blackboardPanelChunk,
      './client.settings-page.js': settingsPageChunk,
      './client.model-picker.js': modelPickerChunk,
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
    // Per-spec failures: the picker chunk must be failable on its own, without
    // taking the settings chunks down with it (the isolation this design buys).
    const chunkFailures = new Map()
    requireStub.async = (spec) => {
      asyncCalls.push(spec)
      if (asyncFailure) return Promise.reject(asyncFailure)
      if (chunkFailures.has(spec)) return Promise.reject(chunkFailures.get(spec))
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
      modelPickerChunk,
      chainEditorChunk,
      disabledCategoriesEditorChunk,
      chainModelChunk,
      lspToggleChunk,
      hashEditViewChunk,
      hashEditModelChunk,
      worktreeViewChunk,
      worktreeModelChunk,
      presetChunk,
      setAsyncFailure: (error) => {
        asyncFailure = error
      },
      failChunk: (spec, error) => {
        if (error === undefined) chunkFailures.delete(spec)
        else chunkFailures.set(spec, error)
      },
    }
  }

  function makeCtx() {
    const effects = []
    const localeRegistrations = []
    const whileServedCalls = []
    const slotInjects = []
    const slotRegistrations = []
    const scope = { ns: 'weir-settings' }
    let sessionAccesses = 0
    const executed = []
    const rpcCalls = []
    // The capability read channel (silent-capability-reads): raw gateway calls
    // over the shared connection — rpc.call('/api', 'weirCapabilities/<m>',
    // { args }) answered with a RemoteResult envelope. The fake records every
    // call and answers with sentinel envelopes; tests override rpcCallBehavior
    // to simulate failures.
    const connection = {
      rpc: {
        call: async (channel, endpoint, payload) => {
          rpcCalls.push({ channel, endpoint, payload })
          if (connection.rpcBehavior) return connection.rpcBehavior(channel, endpoint, payload)
          const method = endpoint.split('/')[1]
          if (method === 'receipt') return { ok: true, value: { status: 'applied', revision: 1, effective: { skills: [], mcpServers: [] }, warnings: [], sid: payload?.args?.sessionId } }
          if (method === 'list') return { ok: true, value: { skills: [], mcpServers: [] } }
          if (method === 'conditions') return { ok: true, value: { conditions: [] } }
          if (method === 'presets') return { ok: true, value: { presets: [], workspaceKey: 'ws-test' } }
          if (method === 'defaultGet') return { ok: true, value: { status: 'ok', revision: 1, cleared: false, snapshot: null, workspaceKey: 'ws-test' } }
          return { ok: false, error: { code: 'gateway/unknown', message: 'unknown endpoint' } }
        },
      },
    }
    const eventSubscriptions = []
    const remote = {
      $on: (event, listener) => {
        const subscription = { event, listener }
        eventSubscriptions.push(subscription)
        return () => { eventSubscriptions.splice(eventSubscriptions.indexOf(subscription), 1) }
      },
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
        return { projections: async ({ sessionId }) => ({ ok: true, value: sessionId === 'on-session' ? { weirLsp: { enabled: true } } : null }) }
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
      get: (name) => (name === 'connection' ? connection : undefined),
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
    return { ctx, effects, localeRegistrations, whileServedCalls, slotInjects, slotRegistrations, scope, executed, rpcCalls, connection, eventSubscriptions, sessionAccesses: () => sessionAccesses }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  // apply starts web notification delivery, which requests its own chunk.
  const NOTIFY_WEB_SPEC = './client.notify-web.js'
  const MODEL_PICKER_SPEC = './client.model-picker.js'
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

    expect(surface.inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.session', 'remote.commands', 'connection'])
    expect(surface.NS).toBe('settings.weir')
    // the test-only export grab-bag is gone — only the host contract remains
    expect(surface.chainEditor).toBeUndefined()
    expect(surface.lspManager).toBeUndefined()
    expect(surface.robashEditor).toBeUndefined()
    expect(surface.disabledCategoriesEditor).toBeUndefined()
    expect(surface.hashEditView).toBeUndefined()

    // apply: the synchronously rendered dictionaries register first, then the
    // slot registration chain — no chunk request needed for apply itself (S18)
    const { ctx, localeRegistrations, whileServedCalls, slotInjects, slotRegistrations, sessionAccesses } = makeCtx()
    surface.apply(ctx)

    // Exactly one apply-time registration: NS carries only the strings that
    // apply-time-registered synchronous faces read (tab titles, guide copy,
    // pill labels, loading states); feature dictionaries arrive with their
    // chunks (the arrival registrations are pinned further down and in the
    // dedup pin below).
    expect(localeRegistrations).toHaveLength(1)
    expect(localeRegistrations[0].ns).toBe('settings.weir')
    expect(localeRegistrations[0].dicts.en.title).toBe('Weir')
    expect(localeRegistrations[0].dicts.zh.title).toBe('Weir')
    // the chunk arrival states carry dictionary entries (templates in English)
    expect(localeRegistrations[0].dicts.en.loading).toBe('Loading Weir settings…')
    expect(localeRegistrations[0].dicts.en.loadFailed).toBe('Weir settings could not be loaded:')
    expect(localeRegistrations[0].dicts.zh.loading).toBe('正在加载 Weir 设置…')
    expect(localeRegistrations[0].dicts.zh.loadFailed).toBe('Weir 设置加载失败：')
    // the tab titles / guide copy and the pre-arrival hash_edit fallback stay sync
    for (const key of ['worktreeTabLabel', 'capabilityTabLabel', 'blackboardTabLabel', 'blackboardPillTitle', 'hashEditInput', 'hashEditOutput']) {
      expect(typeof localeRegistrations[0].dicts.en[key], `en.${key} stays in NS`).toBe('string')
      expect(typeof localeRegistrations[0].dicts.zh[key], `zh.${key} stays in NS`).toBe('string')
    }
    // Migrated (not deleted): the settings switch label and the Edit Lock
    // panel keys now live in the chunk data faces and register on arrival.
    const chunkRequire = (name) => {
      if (name === 'react') return { Component: class {} }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`unexpected require ${name}`)
    }
    const { exports: realSettingsPage } = await loadClientChunk('lib/client.settings-page.js', chunkRequire)
    expect(realSettingsPage.dictionaries.en.editLockEnabled).toBe('Edit Lock')
    expect(realSettingsPage.dictionaries.zh.editLockEnabled).toBe('编辑锁')
    const { exports: realEditLockPanel } = await loadClientChunk('lib/client.edit-lock-panel.js', chunkRequire)
    for (const key of ['editLockCleanupOnly', 'editLockRecoveryUsage', 'editLockPauseUsageHint', 'editLockPausedUntil', 'editLockOwnershipHint']) {
      expect(typeof realEditLockPanel.dictionaries.en[key], `en.${key} in the edit-lock slice`).toBe('string')
      expect(typeof realEditLockPanel.dictionaries.zh[key], `zh.${key} in the edit-lock slice`).toBe('string')
    }
    expect(whileServedCalls).toHaveLength(1)
    expect(whileServedCalls[0].namespaces).toEqual(['weir-settings'])

    // drive the whileServed registration: the composer toggle and the hash_edit
    // toolview registered at apply, then the two pages' slot injects (main +
    // model routing)
    whileServedCalls[0].register(new Set(['weir-settings']))
    expect(slotInjects.map((inject) => inject.name)).toEqual([
      'conversation.input.right', 'tool.call.toolview', 'conversation.input.right',
      // worktree surfaces (U1/U2/U6) register at apply, right after Edit Lock
      'sidebar.session.row.leading', 'conversation.session.header.utilities',
      'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview',
      // the session capability Badge (12.1): order 95, apply-level registration
      'conversation.input.right',
      // the blackboard header quick entry (order 20, after the worktree pill)
      'conversation.session.header.utilities',
      'settings.section', 'settings.weir.item',
      // the model-routing page: its own section + item slot registrations
      'settings.section', 'settings.weir-routing.item',
    ])

    // the per-session LSP toggle in the conversation composer bar slot
    slotInjects[0].fn()
    expect(slotRegistrations).toHaveLength(1)
    expect(slotRegistrations[0].definition.name).toBe('conversation.input.right')
    expect(slotRegistrations[0].definition.id).toBe('weir-lsp-toggle')
    expect(slotRegistrations[0].definition.order).toBe(100)

    // the keyed hash_edit conversation view registration
    slotInjects[1].fn()
    expect(slotRegistrations).toHaveLength(2)
    const { definition: toolviewDef, component: toolviewComponent } = slotRegistrations[1]
    expect(toolviewDef.name).toBe('tool.call.toolview')
    expect(toolviewDef.key).toBe('hash_edit')
    expect(toolviewDef.locale).toBe('settings.weir')
    expect(typeof toolviewComponent).toBe('function')

    // the Edit Lock composer entry (rendered only while /edit-lock exists)
    slotInjects[2].fn()
    const lockEntry = slotRegistrations.find((registration) => registration.definition.id === 'weir-edit-lock')
    expect(lockEntry.definition.name).toBe('conversation.input.right')
    expect(lockEntry.definition.inject()).toEqual({})
    const lockVerbs = lockEntry.definition.inject('s1')
    expect(lockVerbs.sessionId).toBe('s1')
    expect(typeof lockVerbs.runEditLock).toBe('function')

    // the worktree surfaces: session row marker, header pill, and one keyed
    // tool view per lane tool
    for (const index of [3, 4, 5, 6, 7, 8, 9, 10]) slotInjects[index].fn()
    const marker = slotRegistrations.find((registration) => registration.definition.id === 'weir-worktree-marker')
    expect(marker.definition.name).toBe('sidebar.session.row.leading')
    expect(marker.definition.inject('s1')).toEqual({ sessionId: 's1' })
    const pill = slotRegistrations.find((registration) => registration.definition.id === 'weir-worktree-pill')
    expect(pill.definition.name).toBe('conversation.session.header.utilities')
    const laneToolViews = slotRegistrations.filter((registration) => registration.definition.name === 'tool.call.toolview' && registration.definition.key !== 'hash_edit')
    expect(laneToolViews.map((registration) => registration.definition.key).sort()).toEqual([
      'worktree_abandon', 'worktree_check', 'worktree_cleanup', 'worktree_land', 'worktree_open', 'worktree_watch',
    ])

    // the top-level settings section registrations: the main page (order 40)
    // and the model-routing page (order 41)
    slotInjects[13].fn()
    slotInjects[15].fn()
    const sectionEntries = slotRegistrations.filter((registration) => registration.definition.name === 'settings.section')
    expect(sectionEntries).toHaveLength(2)
    const { definition: sectionDef, component: sectionComponent } = sectionEntries.find((registration) => registration.definition.id === 'weir-settings')
    const routingSectionEntry = sectionEntries.find((registration) => registration.definition.id === 'weir-model-routing')
    expect(routingSectionEntry).toBeTruthy()
    expect(routingSectionEntry.definition.order).toBe(41)
    expect(routingSectionEntry.definition.children['settings.weir-routing.item']).toEqual({ kind: 'list', scope: 'root' })
    expect(routingSectionEntry.definition.label()).toBe('routingTitle')
    reactStub.begin()
    expect(routingSectionEntry.component({ renderSlot: (slot) => slot, t: (key) => key })).toBeTruthy()
    expect(sectionDef.name).toBe('settings.section')
    expect(sectionDef.id).toBe('weir-settings')
    expect(sectionDef.order).toBe(40)
    expect(sectionDef.children['settings.weir.item']).toEqual({ kind: 'list', scope: 'root' })
    expect(typeof sectionDef.label).toBe('function')
    reactStub.begin()
    expect(sectionComponent({ renderSlot: (slot) => slot, t: (key) => key })).toBeTruthy()

    // the item slot registrations hosting the form cards (the single entry
    // per page: no plugins.item registration anymore)
    slotInjects[14].fn()
    slotInjects[16].fn()
    const itemEntry = slotRegistrations.find((registration) => registration.definition.name === 'settings.weir.item')
    const routingItemEntry = slotRegistrations.find((registration) => registration.definition.name === 'settings.weir-routing.item')
    expect(routingItemEntry).toBeTruthy()
    expect(routingItemEntry.definition.id).toBe('weir-routing-config')
    expect(routingItemEntry.definition.order).toBe(0)
    expect(itemEntry.definition.id).toBe('weir-config')
    expect(slotRegistrations.find((registration) => registration.definition.name === 'plugins.item')).toBeUndefined()

    // the session capability Badge slot registration (12.1)
    slotInjects[11].fn()
    const badgeEntry = slotRegistrations.find((registration) => registration.definition.id === 'weir-capability-badge')
    expect(badgeEntry.definition.name).toBe('conversation.input.right')
    expect(badgeEntry.definition.order).toBe(95)
    expect(badgeEntry.definition.inject()).toEqual({})
    const badgeVerbs = badgeEntry.definition.inject('s0')
    expect(badgeVerbs.sessionId).toBe('s0')
    expect(typeof badgeVerbs.fetchReceipt).toBe('function')

    // the page inject(): form hooks + save/edit/discard actions (a stable
    // deferred-store face plus controller-delegating verbs) — the routing
    // item carries the same face shape against its own controller
    const routingInjected = routingItemEntry.definition.inject()
    expect(routingInjected.hooks.weirSettingsCard).toBeTruthy()
    expect(typeof routingInjected.save).toBe('function')
    expect(typeof routingInjected.edit).toBe('function')
    expect(typeof routingInjected.discard).toBe('function')
    expect(typeof routingInjected.dismissRestartReminder).toBe('function')
    const injected = itemEntry.definition.inject()
    expect(injected.hooks.weirSettingsCard).toBeTruthy()
    expect(typeof injected.save).toBe('function')
    expect(typeof injected.edit).toBe('function')
    expect(typeof injected.discard).toBe('function')

    // S17: apply and the registration chain never dereference remote.session
    expect(sessionAccesses()).toBe(0)
  })

  it('fans out the settings chunks plus the picker, constructs both page controllers on arrival, and renders loading/arrived states', async () => {
    const { surface, reactStub, asyncCalls, controllerConstructed, sentinelSnapshot, settingsPageChunk, modelPickerChunk, chainEditorChunk, chainModelChunk, lspToggleChunk, disabledCategoriesEditorChunk } = await loadEntry()
    const { ctx, whileServedCalls, slotInjects, slotRegistrations, scope, sessionAccesses } = makeCtx()
    surface.apply(ctx)
    whileServedCalls[0].register(new Set(['weir-settings']))
    slotInjects[14].fn()
    const { definition, component } = slotRegistrations.find((registration) => registration.definition.name === 'settings.weir.item')
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

    // loading state: the settings Promise.all plus the picker's own arrival
    const { first, settled } = await settle(formProps)
    expect(first.children).toBe('loading')
    // apply also starts web notification delivery, which pulls its own chunk first
    expect(asyncCalls.filter((spec) => spec !== NOTIFY_WEB_SPEC)).toEqual([...SETTINGS_CHUNK_SPECS, MODEL_PICKER_SPEC])

    // arrived: the settings-page chunk's WeirCard with bound editors
    expect(settled.__type).toBe(settingsPageChunk.WeirCard)
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
    // the picker chunk arrives on its OWN arrival state and reaches the card as
    // a prop — never through the settings-chunk Promise.all
    expect(settled.modelPicker).toBe(modelPickerChunk)

    // both page controllers were constructed on arrival with the served
    // scope and the prop-injected deps; each deferred store now serves its
    // controller's snapshot
    expect(controllerConstructed).toHaveLength(2)
    expect(controllerConstructed.map((c) => c.page)).toEqual(['main', 'routing'])
    expect(controllerConstructed[0].scope).toBe(scope)
    expect(controllerConstructed[1].scope).toBe(scope)
    expect(typeof controllerConstructed[0].deps.getSession).toBe('function')
    expect(typeof controllerConstructed[0].deps.settingsBus.notify).toBe('function')
    expect(injected.hooks.weirSettingsCard.getSnapshot()).toBe(sentinelSnapshot)

    // the routing item renders the same WeirCard on the routing page against
    // the second controller's store
    slotInjects[16].fn()
    const routingItem = slotRegistrations.find((registration) => registration.definition.name === 'settings.weir-routing.item')
    expect(routingItem.definition.inject().hooks.weirSettingsCard.getSnapshot()).toBe(sentinelSnapshot)
    reactStub.reset()
    reactStub.begin()
    routingItem.component(formProps)
    await flush()
    reactStub.begin()
    const routingSettled = routingItem.component(formProps)
    expect(routingSettled.__type).toBe(settingsPageChunk.WeirCard)
    expect(routingSettled.page).toBe('routing')
    expect(routingSettled.modelPicker).toBe(modelPickerChunk)

    // settingsBus 贯通: the composer toggle wrapper receives the same bus object
    slotInjects[0].fn()
    const composer = slotRegistrations.find((registration) => registration.definition.id === 'weir-lsp-toggle')
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
    whileServedCalls[0].register(new Set(['weir-settings']))
    slotInjects[14].fn()
    const { component } = slotRegistrations.find((registration) => registration.definition.name === 'settings.weir.item')

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
    expect(retried.settled.__type).toBe(settingsPageChunk.WeirCard)
  })

  it('a failed picker chunk never blanks the card: the picker prop is simply absent, and re-entry retries', async () => {
    const { surface, reactStub, failChunk, settingsPageChunk, modelPickerChunk } = await loadEntry()
    const { ctx, whileServedCalls, slotInjects, slotRegistrations } = makeCtx()
    surface.apply(ctx)
    whileServedCalls[0].register(new Set(['weir-settings']))
    slotInjects[14].fn()
    const { component } = slotRegistrations.find((registration) => registration.definition.name === 'settings.weir.item')

    const settle = async (props) => {
      reactStub.reset()
      reactStub.begin()
      const first = component(props)
      await flush()
      reactStub.begin()
      return { first, settled: component(props) }
    }
    const formProps = { view: 'form', t: (key) => key }

    // the picker chunk fails (e.g. a stale revision URL) while the settings
    // chunks arrive: the card renders, only the picker prop is missing
    failChunk(MODEL_PICKER_SPEC, new Error('picker chunk gone'))
    const degraded = await settle(formProps)
    expect(degraded.settled.__type).toBe(settingsPageChunk.WeirCard)
    expect(degraded.settled.modelPicker).toBeUndefined()

    // the failure is not memoized: a later entry retries the picker chunk
    failChunk(MODEL_PICKER_SPEC, undefined)
    const retried = await settle(formProps)
    expect(retried.settled.modelPicker).toBe(modelPickerChunk)
  })

  it('injects the composer-bar switch verbs, drives /lsp via commands, and reads the projection', async () => {
    const { surface } = await loadEntry()
    expect(surface.inject).toContain('remote.commands')
    const { ctx, slotInjects, slotRegistrations, executed } = makeCtx()
    surface.apply(ctx)
    expect(slotInjects.map((inject) => inject.name)).toEqual(['conversation.input.right', 'tool.call.toolview', 'conversation.input.right', 'sidebar.session.row.leading', 'conversation.session.header.utilities', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'tool.call.toolview', 'conversation.input.right', 'conversation.session.header.utilities'])
    slotInjects[0].fn()
    const { definition } = slotRegistrations[0]
    expect(definition.id).toBe('weir-lsp-toggle')
    expect(definition.locale).toBe('settings.weir')

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
    const marker = slotRegistrations.find((registration) => registration.definition.id === 'weir-worktree-marker')
    // the lane tool views are registered by their own injects (indices 5..10)
    for (const index of [5, 6, 7, 8, 9, 10]) slotInjects[index].fn()
    const laneTool = slotRegistrations.find((registration) => registration.definition.key === 'worktree_land')

    // session row marker: renders nothing until the chunks arrive, then the view
    reactStub.begin()
    expect(marker.component({ sessionId: 's1', t: (key) => key })).toBe(null)
    await flush()
    reactStub.begin()
    const markerRendered = marker.component({ sessionId: 's1', t: (key) => key })
    expect(markerRendered.__type).toBe(worktreeViewChunk.WorktreeRowMarker)
    expect(markerRendered.model).toBe(worktreeModelChunk)
    expect(markerRendered.WORKTREE_PROJECTION_KEY).toBe('weirWorktree')
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
    expect(offToggle['data-weir-worktree-mode']).toBe('off')
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
    expect(onToggle['data-weir-worktree-mode']).toBe('on')
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
    // started once, on the real global environment (fetch/Notification/document
    // come from the page via the prototype) plus the composition root's channel
    expect(notifyWebStarts).toHaveLength(1)
    expect(Object.getPrototypeOf(notifyWebStarts[0])).toBe(globalThis)
    expect(typeof notifyWebStarts[0].channel).toBe('function')
    expect(notifyWebStarts[0].fetch).toBe(globalThis.fetch)
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

    // the weir-capabilities tab type registration (D1)
    const tab = sidebarTabRegistrations.find((registration) => registration.id === 'weir-capabilities')
    expect(tab).toBeTruthy()
    expect(tab.kind).toBe('weir-capabilities')
    expect(tab.priority).toBe('extension')
    expect(tab.title()).toBe('capabilityTabLabel')
    expect(tab.guide).toHaveLength(1)
    expect(tab.guide[0].id).toBe('capabilities')
    expect(tab.guide[0].order).toBe(40)
    expect(tab.guide[0].title()).toBe('capabilityGuideTitle')
    expect(tab.guide[0].description()).toBe('capabilityGuideDescription')

    // the pane tab slot: same verb face as the composer Badge, gated on a session
    const pane = sidebarSlotRegistrations.find((registration) => registration.definition.key === 'weir-capabilities')
    expect(pane).toBeTruthy()
    expect(pane.definition.name).toBe('sidebar.right.pane.tab')
    expect(pane.definition.locale).toBe('settings.weir')
    expect(pane.definition.inject()).toEqual({})
    const paneVerbs = pane.definition.inject('s9')
    expect(paneVerbs.sessionId).toBe('s9')
    for (const verb of ['fetchReceipt', 'subscribeFrames', 'applySelection', 'mcpAdd', 'fetchListing', 'fetchConditions', 'loadPresets', 'fetchPresets', 'presetSave', 'presetLoad', 'presetDelete', 'presetExport', 'presetImport', 'defaultGet', 'defaultSave', 'defaultClear']) {
      expect(typeof paneVerbs[verb]).toBe('function')
    }

    // with the tab mounted, the Badge's inject gains openPanel (D4) and it
    // opens exactly this tab
    slotInjects[11].fn()
    const badgeEntry = slotRegistrations.find((registration) => registration.definition.id === 'weir-capability-badge')
    const badgeVerbs = badgeEntry.definition.inject('s0')
    expect(typeof badgeVerbs.openPanel).toBe('function')
    badgeVerbs.openPanel()
    expect(openedTabs).toEqual(['weir-capabilities'])

    // S17: even the sidebar registration never dereferences remote.session
    expect(sessionAccesses()).toBe(0)
  })

  it('lazy Presets wrapper carries rename/re-save commands without staging or Apply', async () => {
    const { surface, presetChunk } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations, executed } = makeCtx()
    surface.apply(ctx)
    slotInjects[11].fn()
    const badge = slotRegistrations.find(row => row.definition.id === 'weir-capability-badge')
    const verbs = badge.definition.inject('s7')
    const module = await verbs.loadPresets()
    const element = module.CapabilityPresetsView({ sessionId: 's7' })
    expect(element.__type).toBe(presetChunk.CapabilityPresetsView)
    const id = { scope: 'workspace', presetId: 'p', expectedRevision: 3 }
    await element.presetRename('s7', { ...id, name: 'New' })
    await element.presetResave('s7', { ...id, from: 'applied', expectedSelectionRevision: 2 })
    expect(executed.map(call => call.input)).toEqual([
      '/capabilities preset-rename {"scope":"workspace","presetId":"p","expectedRevision":3,"name":"New"}',
      '/capabilities preset-resave {"scope":"workspace","presetId":"p","expectedRevision":3,"from":"applied","expectedSelectionRevision":2}',
    ])
  })

  it('registers ZERO capability sidebar surface when the sidebar package is absent', async () => {
    const { surface } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations } = makeCtx() // no ctx.inject: the optional block is skipped
    surface.apply(ctx)
    for (const inject of slotInjects) inject.fn()

    // no right-sidebar pane tab from any capability surface
    expect(slotRegistrations.filter((registration) => registration.definition.name === 'sidebar.right.pane.tab')).toEqual([])

    // the Badge keeps its popover fallback: no openPanel verb is injected
    const badgeEntry = slotRegistrations.find((registration) => registration.definition.id === 'weir-capability-badge')
    expect(badgeEntry).toBeTruthy()
    const badgeVerbs = badgeEntry.definition.inject('s0')
    expect(badgeVerbs.sessionId).toBe('s0')
    expect(typeof badgeVerbs.fetchReceipt).toBe('function')
    expect('openPanel' in badgeVerbs).toBe(false)
  })

  it('capability read verbs travel as raw gateway calls over the shared connection, never the command channel', async () => {
    const { surface } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations, executed, rpcCalls, connection, eventSubscriptions } = makeCtx()
    surface.apply(ctx)
    slotInjects[11].fn()
    const badgeEntry = slotRegistrations.find((registration) => registration.definition.id === 'weir-capability-badge')
    const verbs = badgeEntry.definition.inject('s7')

    // The raw channel contract: POST /api/<ns>/<method> with { args: { sessionId } },
    // answered with a RemoteResult envelope the verb unwraps (never the bare payload).
    expect(await verbs.fetchReceipt('s7')).toEqual({ status: 'applied', revision: 1, effective: { skills: [], mcpServers: [] }, warnings: [], sid: 's7' })
    expect(await verbs.fetchListing('s7')).toEqual({ skills: [], mcpServers: [] })
    expect(await verbs.fetchConditions('s7')).toEqual({ conditions: [] })
    // The Presets view's two automatic reads ride the same channel
    // (silent-preset-reads); domain statuses like no-workspace arrive as
    // VALUES, not channel fallbacks.
    expect(await verbs.fetchPresets('s7')).toEqual({ presets: [], workspaceKey: 'ws-test' })
    connection.rpcBehavior = (channel, endpoint) => (endpoint.endsWith('/defaultGet') ? { ok: true, value: { status: 'no-workspace' } } : { ok: true, value: {} })
    expect(await verbs.defaultGet('s7')).toEqual({ status: 'no-workspace' })
    connection.rpcBehavior = null
    expect(rpcCalls).toEqual([
      { channel: '/api', endpoint: 'weirCapabilities/receipt', payload: { args: { sessionId: 's7' } } },
      { channel: '/api', endpoint: 'weirCapabilities/list', payload: { args: { sessionId: 's7' } } },
      { channel: '/api', endpoint: 'weirCapabilities/conditions', payload: { args: { sessionId: 's7' } } },
      { channel: '/api', endpoint: 'weirCapabilities/presets', payload: { args: { sessionId: 's7' } } },
      { channel: '/api', endpoint: 'weirCapabilities/defaultGet', payload: { args: { sessionId: 's7' } } },
    ])
    // Frame convergence rides ctx.remote.$on('agent-preset/selected') — the
    // only API that delivers forwarded host events; the session id arg is
    // wrapped into the { sessionId } frame the Badge model matches on.
    const frames = []
    const stop = verbs.subscribeFrames((frame) => frames.push(frame))
    expect(eventSubscriptions).toHaveLength(1)
    expect(eventSubscriptions[0].event).toBe('agent-preset/selected')
    eventSubscriptions[0].listener('s7')
    expect(frames).toEqual([{ sessionId: 's7' }])
    expect(typeof stop).toBe('function')

    // Reads produced ZERO command executions (no session-log events).
    expect(executed).toEqual([])

    // Degraded: the connection is not offered (non-Weir composition) — the
    // Badge settles its unavailable state, the panel its error surface.
    const receiptPayload = { status: 'applied', revision: 2, effective: { skills: ['debugging'], mcpServers: [] }, warnings: [] }
    ctx.get = () => undefined
    expect(await verbs.fetchReceipt('s7')).toBe(null)
    expect(await verbs.fetchListing('s7')).toEqual({ error: true })
    expect(await verbs.fetchConditions('s7')).toEqual({ error: true })

    // Degraded: a failing call maps identically — production failures RESOLVE
    // { ok: false, error } (the gateway folds carrier failures into the
    // envelope); a structural rejection is covered too. Still no commands.
    ctx.get = (name) => (name === 'connection' ? connection : undefined)
    connection.rpcBehavior = (channel, endpoint) => {
      if (endpoint.endsWith('/conditions')) return Promise.reject(new Error('gateway/down'))
      return { ok: false, error: { code: 'gateway/internal', message: 'down' } }
    }
    expect(await verbs.fetchReceipt('s7')).toBe(null)
    expect(await verbs.fetchListing('s7')).toEqual({ error: true })
    expect(await verbs.fetchConditions('s7')).toEqual({ error: true })
    expect(executed).toEqual([])

    // Recovered: a healthy envelope flows through again.
    connection.rpcBehavior = (channel, endpoint) => (endpoint.endsWith('/receipt') ? { ok: true, value: receiptPayload } : { ok: true, value: {} })
    expect(await verbs.fetchReceipt('s7')).toEqual(receiptPayload)
  })

  it('a rejecting rpc channel never breaks apply, and the read path settles on its existing fallbacks', async () => {
    const { surface } = await loadEntry()
    const { ctx, localeRegistrations, slotInjects, slotRegistrations, connection } = makeCtx()
    connection.rpc.call = () => Promise.reject(new Error('gateway/down'))
    // the unhandled-rejection guard: a rejected call must be swallowed by the verb
    let unhandled = null
    const onUnhandled = (error) => { unhandled = error }
    process.once('unhandledRejection', onUnhandled)
    surface.apply(ctx) // must not throw
    await flush()
    await flush()
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toBeNull()
    // everything else still registered
    expect(localeRegistrations).toHaveLength(1)
    slotInjects[11].fn()
    const badgeEntry = slotRegistrations.find((registration) => registration.definition.id === 'weir-capability-badge')
    const verbs = badgeEntry.definition.inject('s1')
    expect(await verbs.fetchReceipt('s1')).toBe(null)
    expect(await verbs.fetchListing('s1')).toEqual({ error: true })
    expect(await verbs.fetchConditions('s1')).toEqual({ error: true })
  })

  it('Apply verb preserves structured error JSON and honestly degrades non-JSON transport errors', async () => {
    const { surface } = await loadEntry()
    const { ctx, slotInjects, slotRegistrations, executed, localeRegistrations } = makeCtx()
    ctx.remote.commands.execute = async (sid, input) => {
      executed.push({ sid, input })
      return { ok: true, value: { result: { kind: 'error', text: JSON.stringify({ status: 'rejected', reason: 'same-name-conflict', conflicts: [{ name: 'research' }] }) } } }
    }
    surface.apply(ctx)
    slotInjects[11].fn()
    const badge = slotRegistrations.find(item => item.definition.id === 'weir-capability-badge')
    const verbs = badge.definition.inject('s1')
    expect(await verbs.applySelection('s1', { skills: ['research'] })).toEqual({ status: 'rejected', reason: 'same-name-conflict', conflicts: [{ name: 'research' }] })
    expect(executed[0].input).toContain('/capabilities apply ')
    ctx.remote.commands.execute = async () => ({ ok: true, value: { kind: 'error', text: JSON.stringify({ status: 'missing', missing: ['research'] }) } })
    expect(await verbs.applySelection('s1', {})).toEqual({ status: 'missing', missing: ['research'] })
    ctx.remote.commands.execute = async () => ({ ok: true, value: { kind: 'error', text: 'not JSON' } })
    expect(await verbs.applySelection('s1', {})).toBeNull()
    // migrated to the capability chunk's data face (registered on arrival)
    const { exports: capabilityModel } = await loadClientChunk('lib/client.capability-model.js')
    expect(capabilityModel.dictionaries.en['capability.serverSameName']).toContain('{names}')
    expect(capabilityModel.dictionaries.zh['capability.serverMissing']).toContain('{names}')
  })
  it('build binds the entry to every chunk digest', () => {
    // Content binding is the red line: the entry header pins each chunk's
    // sha256, so a chunk edit without `pnpm build` fails here
    // deterministically. mtime ordering is deliberately NOT asserted: git
    // relayout (merge/checkout/clone) rewrites mtimes in arbitrary order,
    // which made the old mtime assertion a guaranteed false positive after
    // any lane merge touching lib/ (see client-module-chunking.md).
    const libDir = new URL('../lib/', import.meta.url)
    const chunks = readdirSync(libDir).filter((name) => /^client\..+\.js$/.test(name))
    expect(chunks.length).toBeGreaterThan(0)
    const firstLine = readFileSync(new URL('client.js', libDir), 'utf8').split('\n')[0]
    const manifest = JSON.parse(firstLine.replace('// Weir client chunks: ', ''))
    expect(Object.keys(manifest).sort()).toEqual([...chunks].sort())
    for (const name of chunks) {
      expect(manifest[name], `${name} differs from the manifest — run pnpm build`)
        .toBe(createHash('sha256').update(readFileSync(new URL(name, libDir))).digest('hex'))
    }
  })

  it('chunk dictionaries register per namespace on arrival, effect-owned, never duplicating a (namespace, locale) pair', async () => {
    const { surface, reactStub } = await loadEntry()
    // A fake locale service enforcing the real register contract (DSH
    // dsh-client-locale): a duplicate (namespace, locale) pair throws
    // synchronously; the disposer frees the pair.
    const occupied = new Set()
    const events = []
    const effectCleanups = []
    const base = makeCtx()
    const registrations = base.localeRegistrations
    base.ctx.locale.register = (ns, dicts) => {
      for (const locale of Object.keys(dicts)) {
        if (occupied.has(`${ns}/${locale}`)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
      }
      for (const locale of Object.keys(dicts)) occupied.add(`${ns}/${locale}`)
      events.push(`register:${ns}`)
      registrations.push({ ns, dicts })
      return () => {
        for (const locale of Object.keys(dicts)) occupied.delete(`${ns}/${locale}`)
        events.push(`dispose:${ns}`)
      }
    }
    base.ctx.effect = (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
      return () => {}
    }
    const sidebarSlotRegistrations = []
    const sidebarScope = {
      effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') effectCleanups.push(cleanup); return () => {} },
      sidebarRightTabs: { register: () => () => {} },
      slots: { register: (definition, component) => { sidebarSlotRegistrations.push({ definition, component }); return () => {} } },
      locale: { bind: () => (key) => key },
    }
    base.ctx.inject = (names, fn) => {
      if (Array.isArray(names) && names.includes('sidebarRightTabs')) fn(sidebarScope)
      return () => {}
    }

    surface.apply(base.ctx)
    expect(events).toEqual(['register:settings.weir'])

    // the settings batch arrival merges every slice into ONE page registration
    base.whileServedCalls[0].register(new Set(['weir-settings']))
    const itemInject = base.slotInjects.find((inject) => inject.name === 'settings.weir.item')
    itemInject.fn()
    const item = base.slotRegistrations.find((registration) => registration.definition.name === 'settings.weir.item')
    reactStub.begin()
    item.component({ view: 'form', t: (key) => key })
    await flush()
    expect(events).toEqual(['register:settings.weir', 'register:settings.weir.page'])
    const pageRegistration = registrations.find((registration) => registration.ns === 'settings.weir.page')
    for (const slice of ['settingsPage', 'chain', 'robash', 'lsp', 'notifyPermissions', 'editLockMaintenance']) {
      expect(pageRegistration.dicts.en[`pageSentinel.${slice}`], `page merge carries the ${slice} slice`).toBe(`${slice} en`)
      expect(pageRegistration.dicts.zh[`pageSentinel.${slice}`], `page merge carries the ${slice} zh slice`).toBe(`${slice} zh`)
    }

    // chunk re-arrival inside one apply: the badge batch and the pane batch
    // both carry the capability namespace — exactly one registration survives
    for (const inject of base.slotInjects) inject.fn()
    const badge = base.slotRegistrations.find((registration) => registration.definition.id === 'weir-capability-badge')
    // the react stub's hook state is per test: reset between different components
    reactStub.reset()
    reactStub.begin()
    badge.component({ sessionId: 's1', t: (key) => key })
    const capabilityPane = sidebarSlotRegistrations.find((registration) => registration.definition.key === 'weir-capabilities')
    reactStub.reset()
    reactStub.begin()
    capabilityPane.component({ sessionId: 's1', t: (key) => key })
    const blackboardPane = sidebarSlotRegistrations.find((registration) => registration.definition.key === 'weir-blackboard')
    reactStub.reset()
    reactStub.begin()
    blackboardPane.component({ sessionId: 's1', t: (key) => key })
    await flush()
    await flush()
    expect(events.filter((event) => event === 'register:settings.weir.capability')).toHaveLength(1)
    expect(events.filter((event) => event === 'register:settings.weir.blackboard')).toHaveLength(1)
    expect(events.filter((event) => event.startsWith('register:'))).toHaveLength(4)

    // fiber unload: the effect disposers free every pair before any
    // re-registration (the HMR/restart ordering contract)
    for (const dispose of effectCleanups) dispose()
    expect([...occupied]).toEqual([])

    // second apply (the HMR shape): registers everything again, never throws —
    // round 2's registers come strictly after round 1's disposes
    const base2 = makeCtx()
    base2.ctx.locale.register = base.ctx.locale.register
    surface.apply(base2.ctx)
    expect(registrations[registrations.length - 1].ns).toBe('settings.weir')
    const lastDispose = events.lastIndexOf('dispose:settings.weir')
    expect(lastDispose).toBeGreaterThan(-1)
    expect(events.indexOf('register:settings.weir', lastDispose)).toBeGreaterThan(lastDispose)

    // the negative witness: a second apply WITHOUT the disposal throws on the
    // duplicate pair — the contract the effect ownership defends
    expect(() => surface.apply(base2.ctx)).toThrow(/already has locale/)
  })

  it('dictionary union pin: entry NS keys ∪ chunk data-face keys reproduce the pre-move dictionaries key-for-key', async () => {
    // The frozen pre-move key set (738 keys): any key dropped in a future edit
    // of the data faces or the entry dictionary reddens here (the design's
    // 键集并集 pin), and any cross-slice duplicate inside the page merge would
    // silently shadow — pinned too.
    const GOLDEN_KEYS = [
    'blackboard.applying',
    'blackboard.back',
    'blackboard.cancel',
    'blackboard.content',
    'blackboard.contention',
    'blackboard.created',
    'blackboard.delete',
    'blackboard.deleteConfirm',
    'blackboard.deleted',
    'blackboard.deleting',
    'blackboard.dismiss',
    'blackboard.edit',
    'blackboard.editorNew',
    'blackboard.empty',
    'blackboard.emptyDesc',
    'blackboard.entries',
    'blackboard.error',
    'blackboard.filterAll',
    'blackboard.formKey',
    'blackboard.formKeyInvalid',
    'blackboard.formRequired',
    'blackboard.formSummaryPlaceholder',
    'blackboard.formType',
    'blackboard.gone',
    'blackboard.goneDesc',
    'blackboard.loading',
    'blackboard.new',
    'blackboard.noMatch',
    'blackboard.parentBoard',
    'blackboard.promote',
    'blackboard.promoteDisabled',
    'blackboard.promoted',
    'blackboard.promotedReadonly',
    'blackboard.promotedReadonlyDetail',
    'blackboard.promotedTo',
    'blackboard.promotionRequested',
    'blackboard.reacquire',
    'blackboard.refresh',
    'blackboard.released',
    'blackboard.retry',
    'blackboard.rowMeta',
    'blackboard.save',
    'blackboard.saved',
    'blackboard.saving',
    'blackboard.search',
    'blackboard.summary',
    'blackboard.title',
    'blackboard.tokenExpired',
    'blackboard.tokenExpiredShort',
    'blackboard.tokenHeld',
    'blackboard.type.contract',
    'blackboard.type.deadend',
    'blackboard.type.map',
    'blackboard.type.recipe',
    'blackboard.type.why',
    'blackboard.type.wiring',
    'blackboard.unavailable',
    'blackboard.updated',
    'blackboard.watch',
    'blackboard.watching',
    'blackboard.watchingState',
    'blackboardGuideDescription',
    'blackboardGuideTitle',
    'blackboardPillTitle',
    'blackboardTabLabel',
    'capability.acceptedUnknown',
    'capability.applied',
    'capability.appliedSkipped',
    'capability.apply',
    'capability.applying',
    'capability.badge',
    'capability.close',
    'capability.confirmUnknownOverwrite',
    'capability.conflict',
    'capability.conflictState',
    'capability.diff.addMcp',
    'capability.diff.addSkills',
    'capability.diff.removeMcp',
    'capability.diff.removeSkills',
    'capability.discard',
    'capability.effectiveUnknown',
    'capability.effectiveUnknownDetail',
    'capability.effectiveUnknownShort',
    'capability.error',
    'capability.failed',
    'capability.inventoryUnavailableName',
    'capability.loading',
    'capability.mcp.add',
    'capability.mcp.addConfirm',
    'capability.mcp.adding',
    'capability.mcp.args',
    'capability.mcp.cancel',
    'capability.mcp.command',
    'capability.mcp.errorIdentityInvalid',
    'capability.mcp.errorRequired',
    'capability.mcp.groupManaged',
    'capability.mcp.groupUnmanaged',
    'capability.mcp.identity',
    'capability.mcp.label',
    'capability.mcp.none',
    'capability.mcp.stateMounted',
    'capability.mcp.stateRegistered',
    'capability.mcp.unmanagedHint',
    'capability.missing',
    'capability.missingAction',
    'capability.noSkills',
    'capability.pending',
    'capability.presets.appliedReceiptMissing',
    'capability.presets.appliedUnavailable',
    'capability.presets.cancel',
    'capability.presets.clearing',
    'capability.presets.close',
    'capability.presets.collisionCancel',
    'capability.presets.collisionCoexist',
    'capability.presets.collisionReplace',
    'capability.presets.confirmAgain',
    'capability.presets.copied',
    'capability.presets.copy',
    'capability.presets.counts',
    'capability.presets.countsUnresolved',
    'capability.presets.currentRevision',
    'capability.presets.defaultClearConfirm',
    'capability.presets.defaultClearConfirmButton',
    'capability.presets.defaultClearFailed',
    'capability.presets.defaultClearOpen',
    'capability.presets.defaultCleared',
    'capability.presets.defaultEmpty',
    'capability.presets.defaultEntries',
    'capability.presets.defaultNone',
    'capability.presets.defaultSaveConfirm',
    'capability.presets.defaultSaveConfirmButton',
    'capability.presets.defaultSaveFailed',
    'capability.presets.defaultSaveOpen',
    'capability.presets.defaultSaved',
    'capability.presets.defaultTitle',
    'capability.presets.defaultUnavailable',
    'capability.presets.defaultUnresolved',
    'capability.presets.delete',
    'capability.presets.deleteConfirm',
    'capability.presets.deleteConfirmButton',
    'capability.presets.deleteFailed',
    'capability.presets.deleted',
    'capability.presets.deleting',
    'capability.presets.downloaded',
    'capability.presets.editConflict',
    'capability.presets.editTarget',
    'capability.presets.emptyGlobal',
    'capability.presets.emptyWorkspace',
    'capability.presets.errorName',
    'capability.presets.export',
    'capability.presets.exportDownload',
    'capability.presets.exportFailed',
    'capability.presets.exportLabel',
    'capability.presets.fromApplied',
    'capability.presets.fromDraft',
    'capability.presets.gone',
    'capability.presets.groupGlobal',
    'capability.presets.groupWorkspace',
    'capability.presets.groupWorkspaceNone',
    'capability.presets.importCollision',
    'capability.presets.importCollisionDecision',
    'capability.presets.importConfirm',
    'capability.presets.importFailed',
    'capability.presets.importFiles',
    'capability.presets.importInstallFailed',
    'capability.presets.importInstalledNote',
    'capability.presets.importInvalidJson',
    'capability.presets.importNameConflict',
    'capability.presets.importNoInstalls',
    'capability.presets.importNoTargetRoot',
    'capability.presets.importOpen',
    'capability.presets.importPartial',
    'capability.presets.importPlaceholder',
    'capability.presets.importRejected',
    'capability.presets.importResultTitle',
    'capability.presets.importSubmit',
    'capability.presets.importSummaryTitle',
    'capability.presets.importUnresolvedTitle',
    'capability.presets.imported',
    'capability.presets.importedPackage',
    'capability.presets.importing',
    'capability.presets.load',
    'capability.presets.loadFailed',
    'capability.presets.loaded',
    'capability.presets.loadedUnresolved',
    'capability.presets.loading',
    'capability.presets.locked',
    'capability.presets.missingSelection',
    'capability.presets.name',
    'capability.presets.nameConflict',
    'capability.presets.namespace',
    'capability.presets.needsReceipt',
    'capability.presets.newName',
    'capability.presets.noWorkspace',
    'capability.presets.noneKnown',
    'capability.presets.rename',
    'capability.presets.renameCollision',
    'capability.presets.renameHint',
    'capability.presets.renameRow',
    'capability.presets.renameSubmit',
    'capability.presets.renamed',
    'capability.presets.replace',
    'capability.presets.replaceTarget',
    'capability.presets.replaced',
    'capability.presets.resaveConfirm',
    'capability.presets.resaveRow',
    'capability.presets.resaveSubmit',
    'capability.presets.resaved',
    'capability.presets.revisionConflict',
    'capability.presets.save',
    'capability.presets.saveFailed',
    'capability.presets.saveOpen',
    'capability.presets.saved',
    'capability.presets.saving',
    'capability.presets.scopeGlobal',
    'capability.presets.scopeProject',
    'capability.presets.scopeUser',
    'capability.presets.scopeWorkspace',
    'capability.presets.source',
    'capability.presets.sourceChanged',
    'capability.presets.sourceUnavailable',
    'capability.presets.unavailable',
    'capability.presets.uncertain',
    'capability.presets.unreadable',
    'capability.presets.unsupported',
    'capability.removeName',
    'capability.replaceName',
    'capability.sameNameWarning',
    'capability.search',
    'capability.serverMissing',
    'capability.serverSameName',
    'capability.sourceNumber',
    'capability.sourceUnknown',
    'capability.tab.mcp',
    'capability.tab.presets',
    'capability.tab.skills',
    'capability.unavailable',
    'capability.unavailable.short',
    'capability.unknownLegacyName',
    'capability.unknownName',
    'capability.unknownOverwriteRisk',
    'capability.unmanaged',
    'capability.unresolvedNameTitle',
    'capability.unresolvedNameWarning',
    'capability.unsupported',
    'capabilityGuideDescription',
    'capabilityGuideTitle',
    'capabilityTabLabel',
    'catalogFailed',
    'catalogLoading',
    'chainAddRung',
    'chainAgentPanelHint',
    'chainAgent_advisor',
    'chainAgent_advisor_desc',
    'chainAgent_finder',
    'chainAgent_finder_desc',
    'chainAgent_scholar',
    'chainAgent_scholar_desc',
    'chainCancel',
    'chainCategory_architect',
    'chainCategory_architect_desc',
    'chainCategory_artistry',
    'chainCategory_artistry_desc',
    'chainCategory_deep',
    'chainCategory_deep-plus',
    'chainCategory_deep-plus_desc',
    'chainCategory_deep_desc',
    'chainCategory_general-high',
    'chainCategory_general-high_desc',
    'chainCategory_general-low',
    'chainCategory_general-low_desc',
    'chainCategory_quick',
    'chainCategory_quick_desc',
    'chainCategory_visual',
    'chainCategory_visual_desc',
    'chainCategory_writing',
    'chainCategory_writing_desc',
    'chainClear',
    'chainEdit',
    'chainPanelHint',
    'chainRemove',
    'chainSave',
    'delegateAgentChains',
    'delegateAgentChainsHint',
    'delegateCategoryChains',
    'delegateCategoryChainsHint',
    'delegateDisabledCategories',
    'delegateDisabledCategoriesHint',
    'description',
    'disabledCategoriesCount',
    'disabledCategoriesInvalid',
    'disabledCategoriesPanelHint',
    'discardChanges',
    'editLockAutoResume',
    'editLockAutoResumeHint',
    'editLockBinding_cross-process',
    'editLockBinding_revocation-failed',
    'editLockBinding_serving',
    'editLockBinding_transferable',
    'editLockBinding_unknown',
    'editLockCleanupOnly',
    'editLockColdResumeAuto',
    'editLockColdResumeManual',
    'editLockColdRevokedAuto',
    'editLockColdRevokedManual',
    'editLockConfirmAll',
    'editLockDetails',
    'editLockEnabled',
    'editLockEnabledHint',
    'editLockHoldUntil',
    'editLockLabel',
    'editLockLoading',
    'editLockMaint',
    'editLockMaintAuthorityNo',
    'editLockMaintAuthorityYes',
    'editLockMaintBlocked',
    'editLockMaintCounts',
    'editLockMaintDomains',
    'editLockMaintFailed',
    'editLockMaintHint',
    'editLockMaintHistory',
    'editLockMaintHistoryHint',
    'editLockMaintInspect',
    'editLockMaintLoading',
    'editLockMaintNoDomains',
    'editLockMaintOffRisk',
    'editLockMaintPinned',
    'editLockMaintPresenceCorrupt',
    'editLockMaintPresenceEmpty',
    'editLockMaintPresenceJunk',
    'editLockMaintPresenceNone',
    'editLockMaintPresenceNotAFile',
    'editLockMaintPresenceUnreadable',
    'editLockMaintRecoverBusy',
    'editLockMaintRecoverConfirm',
    'editLockMaintRecoverDigest',
    'editLockMaintRecoverDone',
    'editLockMaintRecoverFailed',
    'editLockMaintRecoverHint',
    'editLockMaintRecoverOperations',
    'editLockMaintRecoverOwner',
    'editLockMaintRecoverRevision',
    'editLockMaintRecoverRisk',
    'editLockMaintRecoverRoot',
    'editLockMaintRecoveries',
    'editLockMaintRefresh',
    'editLockMaintReservation',
    'editLockMaintRestart',
    'editLockMaintRetained',
    'editLockMaintRetry',
    'editLockMaintScopeDomain',
    'editLockMaintScopeFile',
    'editLockMaintScopeNone',
    'editLockMaintScopeNote',
    'editLockMaintScopeSubtree',
    'editLockMaintStateDisableRequested',
    'editLockMaintStateDisableRequestedHint',
    'editLockMaintStateDisabled',
    'editLockMaintStateDisabledHint',
    'editLockMaintStateEnableRequested',
    'editLockMaintStateEnableRequestedHint',
    'editLockMaintStateEnforced',
    'editLockMaintStateEnforcedHint',
    'editLockMaintStateUnknown',
    'editLockMaintStateUnknownHint',
    'editLockMaintUnavailable',
    'editLockMaintUnknownHistory',
    'editLockMaintUnknownHistoryHint',
    'editLockMaintUnknownRisk',
    'editLockMaintUnresolved',
    'editLockMaintUnresolvedNone',
    'editLockMaintWarnKeepHistory',
    'editLockMaintWarnUnlock',
    'editLockOptOutWarning',
    'editLockOwnerOther',
    'editLockOwnershipHint',
    'editLockPanelTitle',
    'editLockPauseUsageHint',
    'editLockPausedUntil',
    'editLockRecovery',
    'editLockRecoveryUsage',
    'editLockRefresh',
    'editLockReleaseAll',
    'editLockResume',
    'editLockRetry',
    'editLockRetryPending',
    'editLockRevokeConfirm',
    'editLockRevokedHint',
    'editLockRow_confirm',
    'editLockRow_release',
    'editLockRow_unlock',
    'editLockRow_unlockConfirm',
    'editLockStaleSweep',
    'editLockStaleSweepHint',
    'editLockState_attention',
    'editLockState_confirm',
    'editLockState_editing',
    'editLockState_failed',
    'editLockState_holding',
    'editLockState_idle',
    'editLockState_revoked',
    'editLockState_stopped',
    'editLockState_unavailable',
    'editLockStatus_abnormal',
    'editLockStatus_active',
    'editLockStatus_pending-confirmation',
    'editLockStatus_user-interrupted',
    'editLockStop',
    'editLockTitle',
    'effortProviderDefault',
    'groupEditing',
    'groupGuard',
    'groupIntent',
    'groupLsp',
    'groupNotify',
    'groupRobash',
    'groupRoutingAgents',
    'groupRoutingCategories',
    'groupRoutingSupervision',
    'groupTodo',
    'groupWorktree',
    'guardEnabled',
    'guardEnabledHint',
    'guardHardThreshold',
    'guardHardThresholdHint',
    'guardSoftThreshold',
    'guardSoftThresholdHint',
    'hashEditCodeLabel',
    'hashEditCollapse',
    'hashEditCollapseAria',
    'hashEditCopied',
    'hashEditCopy',
    'hashEditExpand',
    'hashEditExpandAria',
    'hashEditFailed',
    'hashEditInput',
    'hashEditOutput',
    'hashEditPlanned',
    'hashEditPreparing',
    'hashEditRunning',
    'hashEditStopped',
    'hashEditTitle',
    'hashEditUnwrap',
    'hashEditWrap',
    'hashlineHideStockEdit',
    'hashlineHideStockEditHint',
    'intentGateClassifier',
    'intentGateClassifierHint',
    'intentGateClassifierOptionJev',
    'intentGateClassifierOptionLlm',
    'intentGateClassifierOptionRegex',
    'intentGateModel',
    'intentGateModelHint',
    'intentGateProvider',
    'intentGateProviderHint',
    'intentGateReasoningEffort',
    'intentGateReasoningEffortHint',
    'intentGateTimeoutMs',
    'intentGateTimeoutMsHint',
    'invalidValue',
    'jevApiKeyEnv',
    'jevApiKeyEnvHint',
    'jevEndpoint',
    'jevEndpointHint',
    'jevModel',
    'jevModelHint',
    'loadFailed',
    'loading',
    'lspEnabled',
    'lspEnabledHint',
    'lspFamily_bash',
    'lspFamily_cpp',
    'lspFamily_css',
    'lspFamily_dockerfile',
    'lspFamily_go',
    'lspFamily_html',
    'lspFamily_json',
    'lspFamily_lua',
    'lspFamily_markdown',
    'lspFamily_python',
    'lspFamily_rust',
    'lspFamily_typescript',
    'lspFamily_yaml',
    'lspManager',
    'lspManagerAddServer',
    'lspManagerArgs',
    'lspManagerCancel',
    'lspManagerCommand',
    'lspManagerConfirmInstall',
    'lspManagerCustom',
    'lspManagerCustomHint',
    'lspManagerExitCode',
    'lspManagerFailed',
    'lspManagerFamily',
    'lspManagerHint',
    'lspManagerInstall',
    'lspManagerInstallCmd',
    'lspManagerInstalled',
    'lspManagerInstallerMissing',
    'lspManagerInstalling',
    'lspManagerInvalidJson',
    'lspManagerLoading',
    'lspManagerMissing',
    'lspManagerPendingStatus',
    'lspManagerRemove',
    'lspManagerRetry',
    'lspManagerTimedOut',
    'lspManagerUnavailable',
    'lspServers',
    'lspServersHint',
    'lspToggleLabel',
    'lspToggleTitle',
    'modelEmpty',
    'notifyEnabled',
    'notifyEnabledHint',
    'notifyForeground',
    'notifyForegroundHint',
    'notifyForegroundOptionAlways',
    'notifyForegroundOptionSkip',
    'notifyMinTurnSeconds',
    'notifyMinTurnSecondsHint',
    'notifyOnAttention',
    'notifyOnAttentionHint',
    'notifyOnComplete',
    'notifyOnCompleteHint',
    'notifyPermBestEffort',
    'notifyPermChecking',
    'notifyPermClose',
    'notifyPermConfirm',
    'notifyPermDescription',
    'notifyPermDetails',
    'notifyPermError',
    'notifyPermFailed',
    'notifyPermFocusNote',
    'notifyPermManualPath',
    'notifyPermNotSeen',
    'notifyPermOpenHint',
    'notifyPermOpenSettings',
    'notifyPermOpening',
    'notifyPermReason_alerts-allowed',
    'notifyPermReason_default',
    'notifyPermReason_no-record',
    'notifyPermReason_not-allowed',
    'notifyPermReason_unreadable',
    'notifyPermRecheck',
    'notifyPermRetry',
    'notifyPermSeen',
    'notifyPermSeenNo',
    'notifyPermSeenYes',
    'notifyPermSendAgain',
    'notifyPermSendTest',
    'notifyPermSending',
    'notifyPermState_denied',
    'notifyPermState_granted',
    'notifyPermState_unknown',
    'notifyPermTitle',
    'notifyPermWaiting',
    'notifyPermissions',
    'notifyPermissionsHint',
    'notifyPermissionsOpen',
    'notifySound',
    'notifySoundHint',
    'notifyWebDeniedHint',
    'notifyWebPerm_default',
    'notifyWebPerm_denied',
    'notifyWebPerm_granted',
    'notifyWebPermission',
    'notifyWebUnsupported',
    'overridden',
    'pendingChanges',
    'pickerEffort',
    'pickerModel',
    'pickerUnavailable',
    'providerEmpty',
    'readOnly',
    'reset',
    'restartReminderAcknowledge',
    'restartReminderBody',
    'restartReminderDismiss',
    'restartReminderTitle',
    'restartRequired',
    'robashAllow',
    'robashAllowHint',
    'robashDeny',
    'robashDenyHint',
    'robashEnabled',
    'robashEnabledHint',
    'robashGitAllow',
    'robashGitAllowHint',
    'robashListAdd',
    'robashListEntries',
    'robashListEntryPlaceholder',
    'robashListInvalid',
    'robashListPanelHint',
    'robashPwshAllow',
    'robashPwshAllowHint',
    'robashPwshDeny',
    'robashPwshDenyHint',
    'routingDescription',
    'routingTitle',
    'save',
    'saveFailed',
    'saving',
    'supervisionInitialBackoffMs',
    'supervisionInitialBackoffMsHint',
    'supervisionMaxBackoffMs',
    'supervisionMaxBackoffMsHint',
    'supervisionMaxRetries',
    'supervisionMaxRetriesHint',
    'title',
    'todoEnabled',
    'todoEnabledHint',
    'todoErrorRetryMax',
    'todoErrorRetryMaxHint',
    'todoMaxConsecutive',
    'todoMaxConsecutiveHint',
    'unavailable',
    'worktreeAbandon',
    'worktreeAbandonConfirm',
    'worktreeActionFailed',
    'worktreeActionUnavailable',
    'worktreeAheadBehind',
    'worktreeApproveLabel',
    'worktreeApproveOptionAutoClean',
    'worktreeApproveOptionAutoKeep',
    'worktreeApproveOptionManual',
    'worktreeApproveTitle',
    'worktreeAutoApprove',
    'worktreeAutoApproveHint',
    'worktreeAutoApproveOptionAuto-clean',
    'worktreeAutoApproveOptionAuto-keep',
    'worktreeAutoApproveOptionManual',
    'worktreeAutoSetup',
    'worktreeAutoSetupHint',
    'worktreeBaseMoved',
    'worktreeCancel',
    'worktreeCleanup',
    'worktreeCleanupAll',
    'worktreeCleanupAllConfirm',
    'worktreeCleanupWorktree',
    'worktreeConfigAdd',
    'worktreeConfigChecks',
    'worktreeConfigHint',
    'worktreeConfigName',
    'worktreeConfigRemove',
    'worktreeConfigRun',
    'worktreeConfigSave',
    'worktreeConfigSetup',
    'worktreeConfigure',
    'worktreeConflicts',
    'worktreeCopyPath',
    'worktreeDiffUnavailable',
    'worktreeDisabled',
    'worktreeEmpty',
    'worktreeEmptyBody',
    'worktreeEmptyTitle',
    'worktreeEnabled',
    'worktreeEnabledHint',
    'worktreeExcludeMissing',
    'worktreeExcludeOk',
    'worktreeExitCode',
    'worktreeFiles',
    'worktreeFlatInput',
    'worktreeFlatOutput',
    'worktreeGuideDescription',
    'worktreeGuideTitle',
    'worktreeHideDiff',
    'worktreeHideHistory',
    'worktreeInitParseFailed',
    'worktreeLand',
    'worktreeLandConfirm',
    'worktreeLoadFailed',
    'worktreeLoading',
    'worktreeMaxActive',
    'worktreeMaxActiveHint',
    'worktreeMergeCommit',
    'worktreeModeLabel',
    'worktreeModeTitle',
    'worktreeModeUnavailable',
    'worktreeNextLabel',
    'worktreeNext_delegate',
    'worktreeNext_worktree_check',
    'worktreeNext_worktree_cleanup',
    'worktreeNext_worktree_land',
    'worktreeNoChanges',
    'worktreePillAwaiting',
    'worktreePillBaseMoved',
    'worktreePillCount',
    'worktreePillLanes',
    'worktreePillMode',
    'worktreePillTitle',
    'worktreeRecheck',
    'worktreeRefresh',
    'worktreeRetrySetup',
    'worktreeRoot',
    'worktreeRootHint',
    'worktreeShowHistory',
    'worktreeSkipSetup',
    'worktreeStaleData',
    'worktreeState_abandoned',
    'worktreeState_awaiting_approval',
    'worktreeState_branch_moved',
    'worktreeState_check_failed',
    'worktreeState_checking',
    'worktreeState_cleaned',
    'worktreeState_conflicted',
    'worktreeState_declined',
    'worktreeState_dirty',
    'worktreeState_kept',
    'worktreeState_landable',
    'worktreeState_landed',
    'worktreeState_no_commits',
    'worktreeState_preparing',
    'worktreeState_ready',
    'worktreeState_setup_failed',
    'worktreeState_working',
    'worktreeTabLabel',
    'worktreeTool_worktree_abandon',
    'worktreeTool_worktree_check',
    'worktreeTool_worktree_cleanup',
    'worktreeTool_worktree_land',
    'worktreeTool_worktree_open',
    'worktreeTool_worktree_watch',
    'worktreeUnavailable',
    'worktreeUnmanaged',
    'worktreeVerificationOff',
    'worktreeVerificationOn',
    'worktreeViewDiff',
    'worktreeWait_check_complete',
    'worktreeWait_child_settle',
    'worktreeWait_lane_ready',
    'worktreeWait_user',
    'worktreeWatchExpires',
    'worktreeWatchHit',
    'worktreeWatchStates',
    'worktreeWatchTimeoutMinutes',
    'worktreeWatchTimeoutMinutesHint',
    'worktreeWatching',
    ]
    const chunkRequire = (name) => {
      if (name === 'react') return { Component: class {} }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`unexpected require ${name}`)
    }
    // the entry's sync registration (dictionary-only apply)
    const { exports: entry } = await loadClientChunk('lib/client.js', Object.assign(() => ({}), { async: () => Promise.reject(new Error('chunks are not loaded in a dictionary-only test')) }))
    const registrations = []
    entry.apply({
      locale: { bind: () => (key) => key, register: (ns, dicts) => registrations.push({ ns, dicts }) },
      effect: (fn) => { fn(); return () => {} },
      slots: { inject: () => () => {} },
      configForms: { whileServed: () => () => {} },
      remote: {},
    })
    expect(registrations).toHaveLength(1)
    expect(registrations[0].ns).toBe('settings.weir')

    const homes = [
      ['NS (entry)', null],
      ['lib/client.settings-page.js', chunkRequire],
      ['lib/client.chain-model.js', undefined],
      ['lib/client.robash-model.js', undefined],
      ['lib/client.lsp-model.js', undefined],
      ['lib/client.disabled-categories-editor.js', chunkRequire],
      ['lib/client.notify-permissions.js', chunkRequire],
      ['lib/client.edit-lock-maintenance.js', chunkRequire],
      ['lib/client.capability-model.js', undefined],
      ['lib/client.blackboard-model.js', undefined],
      ['lib/client.lsp-toggle.js', chunkRequire],
      ['lib/client.hash-edit-model.js', undefined],
      ['lib/client.edit-lock-panel.js', chunkRequire],
      ['lib/client.worktree-model.js', undefined],
    ]
    const seen = new Map() // key -> home name (first writer)
    const union = new Set()
    // the documented cross-namespace duplicates: a loading/fallback string a
    // second surface reads from its own namespace
    const allowedDupes = new Map([
      ['capability.loading', ['NS (entry)', 'lib/client.capability-model.js']],
      ['unavailable', ['lib/client.settings-page.js', 'lib/client.capability-model.js']],
      ['save', ['lib/client.settings-page.js', 'lib/client.capability-model.js']],
      ['blackboard.loading', ['NS (entry)', 'lib/client.blackboard-model.js']],
      ['hashEditInput', ['NS (entry)', 'lib/client.hash-edit-model.js']],
      ['hashEditOutput', ['NS (entry)', 'lib/client.hash-edit-model.js']],
      // worktreeLoading: the lanes panel's pre-arrival state resolves it from
      // NS (entry-side, sync-rendered); the chunk's own loading row reads it
      // from its feature namespace — byte-identical in both homes.
      ['worktreeLoading', ['NS (entry)', 'lib/client.worktree-model.js']],
    ])
    const entryDicts = registrations[0].dicts
    for (const [home, requireStub] of homes) {
      const dictionaries = home === 'NS (entry)'
        ? { en: entryDicts.en, zh: entryDicts.zh }
        : (await loadClientChunk(home, ...(requireStub ? [requireStub] : []))).exports.dictionaries
      expect(dictionaries, `${home} carries a data face`).toBeTruthy()
      const enKeys = Object.keys(dictionaries.en)
      const zhKeys = Object.keys(dictionaries.zh)
      expect(enKeys.sort(), `${home} en/zh key parity`).toEqual(zhKeys.sort())
      for (const key of enKeys) {
        union.add(key)
        const holder = seen.get(key)
        if (holder !== undefined) {
          const allowed = allowedDupes.get(key)
          expect(allowed, `${key} duplicated across ${holder} and ${home}`).toBeTruthy()
          expect(allowed).toContain(holder)
          expect(allowed).toContain(home)
          // a duplicated key must carry the same string in both homes
          expect(dictionaries.en[key], `${key} en text drift between homes`).toBe(seen.get(`${key}en`))
        } else {
          seen.set(key, home)
          seen.set(`${key}en`, dictionaries.en[key])
        }
      }
    }
    expect([...union].sort(), 'entry ∪ chunk data faces == the pre-move key set').toEqual([...GOLDEN_KEYS].sort())
  })
})
