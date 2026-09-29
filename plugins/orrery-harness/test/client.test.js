import { describe, expect, it } from './helpers.js'

/**
 * The browser half (lib/client.js) is authored in the build-output
 * `window.__ModuleLoader__.load` format. This test executes it under Node
 * with a stubbed loader and stub baseline requires, then drives the factory
 * and apply against fake cordis/browser services to prove the page
 * registration chain.
 */

describe('orrery settings client half', () => {
  it('loads, exposes the plugin surface, and registers the page chain', async () => {
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load: (definition) => loaded.push(definition),
      },
    }
    await import('../lib/client.js')

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('orrery-harness')

    // stub baseline requires: jsx runtime returns marker objects; primitives
    // exposes the pieces the page consumes.
    const specsSeen = []
    const primitivesStub = {
      settingsNumberField: (field) => ({ field, kind: 'number' }),
      settingsTextField: (field) => ({ field, kind: 'text' }),
      SettingsValueField: (props) => ({ __field: props }),
      Switch: (props) => ({ __switch: props }),
      SegmentedControl: (props) => ({ __segmented: props }),
      Tag: (props) => ({ __tag: props }),
      SettingsForm: (props) => ({ __form: props }),
      SettingsFormModel: class {
        constructor(scope, specs) {
          this.scope = scope
          this.specs = specs
          specsSeen.push(...specs)
          this.store = { marker: 'store' }
        }
        bind(project) {
          this.bound = project
          this.store = { marker: 'store', set: () => {} }
          return this.store
        }
        field(name) {
          return { text: '', overridden: false, invalid: false, name }
        }
        shell() {
          return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
        }
        actions() {
          return { edit: () => {}, resetField: () => {}, save: async () => {}, discard: () => {} }
        }
        dispose() {}
      },
    }
    const requireStub = (name) => {
      if (name === 'react') {
        return {
          useState: (initial) => {
            let value = initial
            return [value, (next) => {
              value = next
            }]
          },
          useEffect: (fn) => fn(),
          useRef: (initial) => ({ current: initial }),
          Component: class {
            constructor(props) {
              this.props = props
              this.state = undefined
            }
          },
        }
      }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      if (name === 'orrery-model-picker') return { ModelPickerField: (props) => ({ __picker: props }), ModelPickerBoundary: class { constructor(props) { this.props = props } render() { return this.props.children } } }
      throw new Error(`unexpected require ${name}`)
    }
    const surface = loaded[0].factory(requireStub)

    expect(surface.inject).toEqual(['slots', 'locale', 'configForms', 'remote', 'remote.session', 'remote.commands'])
    expect(surface.NS).toBe('settings.orrery')

    // apply: locale dictionaries, form card, whileServed → slot registration
    const effects = []
    const localeRegistrations = []
    const whileServedCalls = []
    const slotInjects = []
    const slotRegistrations = []
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
        get: (ns) => ({ ns }),
        whileServed: (namespaces, register) => {
          whileServedCalls.push({ namespaces, register })
          return () => {}
        },
      },
      remote: {
        session: {
          modelCatalog: async () => ({ ok: true, value: { groups: [] } }),
        },
      },
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
    surface.apply(ctx)

    expect(localeRegistrations).toHaveLength(1)
    expect(localeRegistrations[0].dicts.en.title).toBe('Orrery')
    expect(localeRegistrations[0].dicts.zh.title).toBe('Orrery')
    expect(whileServedCalls).toHaveLength(1)
    expect(whileServedCalls[0].namespaces).toEqual(['orrery-settings'])

    // drive the whileServed registration: the LSP toggle registered at apply,
    // then three page-chain slot injects
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
    expect(sectionComponent({ renderSlot: (slot) => slot })).toBeTruthy()

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

    // the page inject(): form hooks + save/edit/discard actions
    const injected = definition.inject()
    expect(injected.hooks.orrerySettingsCard).toBeTruthy()
    expect(typeof injected.save).toBe('function')
    expect(typeof injected.edit).toBe('function')
    expect(typeof injected.discard).toBe('function')

    // the card component renders a summary for the summary view and a form otherwise
    const FIELD_NAMES = ['intentGateClassifier','intentGateProvider','intentGateModel','intentGateReasoningEffort','intentGateTimeoutMs','jevEndpoint','jevModel','jevApiKeyEnv','delegateCategoryChains','supervisionMaxRetries','supervisionInitialBackoffMs','supervisionMaxBackoffMs','todoEnabled','todoMaxConsecutive','todoErrorRetryMax','todoErrorBackoffBaseMs','todoErrorBackoffCapMs','guardEnabled','guardSoftThreshold','guardHardThreshold','hashlineHideStockEdit','robashEnabled','robashAllow','robashGitAllow','robashDeny','robashPwshAllow','robashPwshDeny','lspEnabled','lspIdleMs','lspRequestTimeoutMs','lspDiagnosticsWaitMs','lspServers']
    expect(component({ view: 'summary', t: (key) => key, useOrrerySettingsCard: (selector) => selector({ writable: true, fields: {} }), ensureCatalog: () => {} })).toBe('description')
    const rendered = component({
      view: 'form',
      t: (key) => key,
      useOrrerySettingsCard: (selector) => selector({
        writable: true,
        fields: Object.fromEntries(FIELD_NAMES.map((name) => [name, { text: '', invalid: false, overridden: false }])),
        catalog: { status: 'ready', groups: [] },
      }),
      edit: () => {},
      resetField: () => {},
      save: () => {},
      discard: () => {},
      ensureCatalog: () => {},
      retryCatalog: () => {},
    })
    // pure chain helpers: JSON synthesis round-trips through the visual model
    const { jsonToChains, chainsToJson } = surface.chainEditor
    const chains = jsonToChains('{"deep":[{"provider":"p","model":"m","reasoningEffort":"max"}],"bogus":[{"provider":"x","model":"y"}]}')
    expect(chains.deep).toEqual([{ provider: 'p', model: 'm', reasoningEffort: 'max' }])
    expect(chains.quick).toEqual([])
    expect(JSON.parse(chainsToJson({ deep: [{ provider: 'p', model: 'm', reasoningEffort: '' }, { provider: '', model: 'm2', reasoningEffort: '' }], quick: [] }))).toEqual({ deep: [{ provider: 'p', model: 'm' }] })
    expect(jsonToChains('not-json').deep).toEqual([])
    expect(chainsToJson(jsonToChains(undefined))).toBe('{}')

    expect(rendered.__type).toBeTruthy()
    // 7 group headers + 6 choice rows + 1 model picker + 17 value-field rows
    // + 1 LSP manager row + 5 robash list-editor rows
    expect(rendered.children).toHaveLength(37)
    expect(rendered.children.filter((child) => typeof child.children === 'string')).toHaveLength(7)
    expect(rendered.children.filter((child) => child.descriptor)).toHaveLength(6)
    expect(rendered.children.filter((child) => child.fallback !== undefined)).toHaveLength(1)
    expect(rendered.children.filter((child) => typeof child.id === 'string')).toHaveLength(16)
    // the LSP manager row opens the service management panel
    const managerRow = rendered.children.find((child) => child.key === 'lsp-manager')
    expect(managerRow).toBeTruthy()
    expect(typeof managerRow.__type).toBe('function')
    // the category-chains row renders the visual editor with its Edit button
    const chainsRow = rendered.children.find((child) => child.text !== undefined && child.edit !== undefined)
    expect(chainsRow).toBeTruthy()
    expect(typeof chainsRow.getSession).toBe('function')

    // the five robash whitelist rows render the list editor (GROUPS.robash):
    // bash allow/gitAllow/deny + pwsh allow/deny, reusing RobashListEditorField
    const ROBASH_LIST_FIELDS = ['robashAllow', 'robashGitAllow', 'robashDeny', 'robashPwshAllow', 'robashPwshDeny']
    const robashRows = rendered.children.filter((child) => ROBASH_LIST_FIELDS.includes(child.field))
    expect(robashRows).toHaveLength(5)
    expect(robashRows.map((row) => row.key)).toEqual(ROBASH_LIST_FIELDS)
    expect(robashRows.every((row) => typeof row.__type === 'function' && typeof row.edit === 'function' && typeof row.onReset === 'function')).toBe(true)
    // and the form model tracks them as flat text fields
    expect(specsSeen.filter((spec) => ROBASH_LIST_FIELDS.includes(spec.field))).toHaveLength(5)

    // pure robash list helpers: round-trip, invalid → null, empty ↔ "[]"
    const { jsonToStringList, stringListToJson } = surface.robashEditor
    expect(jsonToStringList('["ls","cat"]')).toEqual(['ls', 'cat'])
    expect(jsonToStringList('[]')).toEqual([])
    expect(stringListToJson([])).toBe('[]')
    expect(jsonToStringList(stringListToJson(['ls', 'cat']))).toEqual(['ls', 'cat'])
    expect(stringListToJson([' ls ', '', '  ', 'cat'])).toBe('["ls","cat"]')
    expect(jsonToStringList('not-json')).toBe(null)
    expect(jsonToStringList('{"a":1}')).toBe(null)
    expect(jsonToStringList('[1,"ls"]')).toBe(null)
    expect(jsonToStringList('')).toBe(null)

    // the collapsed robash row: label + hint + entry count + Edit button
    const collapsed = robashRows[0].__type({ field: 'robashAllow', text: '["ls","cat"]', overridden: true, edit: () => {}, onReset: () => {}, t: (key) => key, disabled: false })
    expect(collapsed.children[0].children[0].children[0].children).toBe('robashAllow')
    expect(collapsed.children[0].children[0].children[1].children).toBe('robashAllowHint')
    const collapsedRight = collapsed.children[0].children[1]
    expect(collapsedRight.children[0].children[0].children).toBe('2 robashListEntries')
    expect(collapsedRight.children[0].children[1].children).toBe('chainEdit')
    // overridden → Tag + reset below the Edit button
    expect(collapsedRight.children[2].children[0].children).toBe('overridden')
    // a bad stored value shows the invalid hint instead of the entry count
    const badRow = robashRows[0].__type({ field: 'robashAllow', text: 'not-json', overridden: false, edit: () => {}, onReset: () => {}, t: (key) => key, disabled: false })
    expect(badRow.children[0].children[1].children[1].children).toBe('robashListInvalid')

    // open-state decisions (robash-list-editor-recovery): blank opens empty
    // WITHOUT the hint; malformed opens empty WITH the hint; valid opens the
    // parsed list. No stored state may strand the field uneditable.
    const { robashEditorOpenState } = surface.robashEditor
    expect(robashEditorOpenState('')).toEqual({ list: [], invalid: false, parsed: null })
    expect(robashEditorOpenState('   ')).toEqual({ list: [], invalid: false, parsed: null })
    expect(robashEditorOpenState('not-json')).toEqual({ list: [], invalid: true, parsed: null })
    expect(robashEditorOpenState('[1,"ls"]')).toEqual({ list: [], invalid: true, parsed: null })
    expect(robashEditorOpenState('["ls","cat"]')).toEqual({ list: ['ls', 'cat'], invalid: false, parsed: ['ls', 'cat'] })
    // a blank stored value renders neither the entry count nor the invalid hint
    const blankRow = robashRows[0].__type({ field: 'robashAllow', text: '', overridden: false, edit: () => {}, onReset: () => {}, t: (key) => key, disabled: false })
    // blank: no entry count (null first control) and no invalid hint; the Edit button is still there
    expect(blankRow.children[0].children[1].children[0].children[0]).toBe(null)
    expect(blankRow.children[0].children[1].children[0].children[1].children).toBe('chainEdit')
    expect(blankRow.children[0].children[1].children[1]).toBe(null)

    // the single model picker row: the library picker inside its error boundary
    const pickerRow = rendered.children.find((child) => child.key === 'intentGateProvider')
    const boundary = pickerRow.__type
    const boundaryInstance = new boundary(pickerRow)
    expect(boundaryInstance.render()).toBe(pickerRow.children)
    // inner row renders the picker library component bound to the form fields
    const innerRow = boundaryInstance.props.children
    const picker = innerRow.children[1].children[0]
    expect(picker.value.provider).toBe('')
    expect(picker.value.model).toBe('')
    expect(picker.value.reasoningEffort).toBe('')
    expect(typeof picker.onChange).toBe('function')
    expect(typeof picker.getSession).toBe('function')

    // boolean rows render Switch; the enum row renders SegmentedControl
    const booleanRow = rendered.children.find((child) => child.descriptor?.kind === 'boolean')
    const booleanRendered = booleanRow.__type({ descriptor: booleanRow.descriptor, field: { text: 'true', overridden: false }, t: (key) => key, disabled: false, onChange: () => {}, onReset: () => {} })
    // switch on top, no reset line below
    expect(booleanRendered.children[1].children[0].checked).toBe(true)
    expect(typeof booleanRendered.children[1].children[0].onChange).toBe('function')
    expect(booleanRendered.children[1].children[1]).toBe(null)
    // overridden → the reset line appears BELOW the control (stable layout)
    const overriddenRendered = booleanRow.__type({ descriptor: booleanRow.descriptor, field: { text: 'false', overridden: true }, t: (key) => key, disabled: false, onChange: () => {}, onReset: () => {} })
    expect(overriddenRendered.children[1].children[1].children[0].children).toBe('overridden')
    const enumRow = rendered.children.find((child) => child.descriptor?.kind === 'enum')
    const enumRendered = enumRow.__type({ descriptor: enumRow.descriptor, field: { text: 'llm', overridden: true }, t: (key) => key, disabled: false, onChange: () => {}, onReset: () => {} })
    // segmented control on top, reset line below
    expect(enumRendered.children[1].children[0].value).toBe('llm')
    expect(enumRendered.children[1].children[0].options).toHaveLength(3)
    expect(enumRendered.children[1].children[1].children[0].children).toBe('overridden')
  })
})

describe('orrery session LSP toggle', () => {
  it('injects the composer-bar switch, drives /lsp via commands, and reads the projection', async () => {
    // Fresh module instance (cache-busted) with a hook-state-preserving react
    // stub so the component can be re-rendered across async state updates.
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load: (definition) => loaded.push(definition),
      },
    }
    await import('../lib/client.js?lsp-toggle=1')

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
          reactState[at][0] = next
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
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
        settingsNumberField: (field) => ({ field, kind: 'number' }),
        settingsTextField: (field) => ({ field, kind: 'text' }),
        SettingsValueField: (props) => ({ __field: props }),
        Switch: (props) => ({ __switch: props }),
        SegmentedControl: (props) => ({ __segmented: props }),
        Tag: (props) => ({ __tag: props }),
        SettingsForm: (props) => ({ __form: props }),
        SettingsFormModel: class {
          bind(project) {
            return { marker: 'store', set: () => {} }
          }
          field() {
            return { text: '', overridden: false, invalid: false }
          }
          shell() {
            return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
          }
          actions() {
            return { edit: () => {}, resetField: () => {}, save: async () => {}, discard: () => {} }
          }
          dispose() {}
        },
      }
      if (name === 'orrery-model-picker') return { ModelPickerField: (props) => ({ __picker: props }), ModelPickerBoundary: class { render() { return null } } }
      throw new Error(`unexpected require ${name}`)
    }
    const surface = loaded[0].factory(requireStub)
    expect(surface.inject).toContain('remote.commands')

    const executed = []
    const slotInjects = []
    const slotRegistrations = []
    const ctx = {
      locale: {
        bind: () => (key) => key,
        register: () => {},
      },
      effect: (fn) => {
        fn()
        return () => {}
      },
      configForms: {
        get: () => ({}),
        whileServed: () => () => {},
      },
      remote: {
        session: {
          modelCatalog: async () => ({ ok: true, value: { groups: [] } }),
          projections: async ({ sessionId }) => ({ ok: true, value: sessionId === 'on-session' ? { orreryLsp: { enabled: true } } : null }),
        },
        commands: {
          execute: async (sessionId, input, args) => {
            executed.push({ sessionId, input, args })
            if (input === '/lsp on') return { ok: true, value: { kind: 'success' } }
            return { ok: false, error: { message: 'boom', code: 'X' } }
          },
          list: async (sessionId) => ({ ok: true, value: [{ name: 'lsp' }, { name: 'plan' }] }),
        },
      },
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
    surface.apply(ctx)

    expect(slotInjects.map((inject) => inject.name)).toEqual(['conversation.input.right', 'tool.call.toolview'])
    slotInjects[0].fn()
    const { definition, component } = slotRegistrations[0]
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

    // component: renders null until the command catalog confirms availability
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
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
    expect(settled['data-orrery-lsp-state']).toBe('off')

    // with useProjection the switch shows the host-folded state
    const { settled: onButton } = await settle({ ...baseProps, useProjection: (key) => (key === 'orreryLsp' ? { enabled: true } : undefined) })
    expect(onButton.__type).toBe('button')
    expect(onButton['data-orrery-lsp-toggle']).toBe('')
    expect(onButton['data-orrery-lsp-state']).toBe('on')
    expect(onButton['aria-pressed']).toBe(true)
    expect(onButton.title).toBe('lspToggleTitle')

    // without useProjection the fallback fetch seeds the local state
    const { settled: fallbackButton } = await settle({ ...baseProps, fetchLspState: async () => true })
    expect(fallbackButton['data-orrery-lsp-state']).toBe('on')

    // clicking toggles and, without the projection hook, updates optimistically
    let lastToggle = null
    const clickProps = { ...baseProps, toggleLsp: async (enabled) => {
      lastToggle = enabled
      return null
    } }
    const clickRun = await settle(clickProps)
    expect(clickRun.settled['data-orrery-lsp-state']).toBe('off')
    clickRun.settled.onClick()
    await flush()
    reactStub.begin()
    const afterClick = component(clickProps)
    expect(lastToggle).toBe(true)
    expect(afterClick['data-orrery-lsp-state']).toBe('on')

    // a failing toggle surfaces the error in the title
    const failingProps = { ...baseProps, toggleLsp: async () => 'nope' }
    const failingRun = await settle(failingProps)
    failingRun.settled.onClick()
    await flush()
    reactStub.begin()
    expect(component(failingProps).title).toBe('nope')

    // capability absent from the catalog → no switch
    const absentRun = await settle({ ...baseProps, commandsList: async () => [] })
    expect(absentRun.settled).toBe(null)
  })
})

describe('orrery LSP manager panel', () => {
  it('loads the catalog, confirms installs, runs them, and degrades on errors', async () => {
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load: (definition) => loaded.push(definition),
      },
    }
    await import('../lib/client.js?lsp-manager=1')

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
          reactState[at][0] = next
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
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
        settingsNumberField: (field) => ({ field, kind: 'number' }),
        settingsTextField: (field) => ({ field, kind: 'text' }),
        SettingsValueField: (props) => ({ __field: props }),
        Switch: (props) => ({ __switch: props }),
        SegmentedControl: (props) => ({ __segmented: props }),
        Tag: (props) => ({ __tag: props }),
        SettingsForm: (props) => ({ __form: props }),
        SettingsFormModel: class {
          bind() {
            return { marker: 'store', set: () => {} }
          }
          field() {
            return { text: '', overridden: false, invalid: false }
          }
          shell() {
            return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
          }
          actions() {
            return { edit: () => {}, resetField: () => {}, save: async () => {}, discard: () => {} }
          }
          dispose() {}
        },
      }
      if (name === 'orrery-model-picker') return { ModelPickerField: (props) => ({ __picker: props }), ModelPickerBoundary: class { render() { return null } } }
      throw new Error(`unexpected require ${name}`)
    }
    const surface = loaded[0].factory(requireStub)
    const { LspManagerField } = surface.lspManager
    expect(typeof LspManagerField).toBe('function')

    const SERVERS = [
      { family: 'lua', languageIds: ['lua'], command: 'lua-language-server', installed: false, version: null, installCommand: 'brew install lua-language-server', installHint: '', installerAvailable: true },
      { family: 'typescript', languageIds: ['typescript'], command: 'typescript-language-server', installed: true, version: '5.0', installCommand: 'npm install -g typescript-language-server typescript', installHint: '', installerAvailable: true },
      { family: 'cpp', languageIds: ['cpp'], command: 'clangd', installed: false, version: null, installCommand: 'brew install llvm', installHint: '', installerAvailable: false },
    ]
    const fetchCalls = []
    const fetchStub = (url, init) => {
      fetchCalls.push({ url, init })
      if (url === 'api/orrery-lsp/status') {
        return Promise.resolve({ json: async () => ({ ok: true, value: { servers: SERVERS } }) })
      }
      if (url === 'api/orrery-lsp/install') {
        return Promise.resolve({ json: async () => ({ ok: true, value: { output: 'added 2 packages', exitCode: 0, timedOut: false } }) })
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchStub
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const props = { t: (key) => key }
    const renderWith = (componentProps) => {
      reactStub.begin()
      return LspManagerField(componentProps)
    }
    const render = () => renderWith(props)
    const settleWith = async (componentProps) => {
      reactStub.reset()
      reactStub.begin()
      const first = LspManagerField(componentProps)
      await flush()
      reactStub.begin()
      return { first, settled: LspManagerField(componentProps) }
    }
    const settle = async () => settleWith(props)

    try {
      // closed: a labeled row with the open button
      const initial = await settle()
      expect(initial.settled.children[0].children[1].children).toBe('chainEdit')
      // open it → status loads
      initial.settled.children[0].children[1].onClick()
      await flush()
      const opened = render()
      const body = opened.children[1].children
      expect(body.__type).toBe('div')
      expect(fetchCalls[0].url).toBe('api/orrery-lsp/status')
      // two server rows: lua missing (install button), typescript installed (version)
      const luaRow = body.children[0]
      expect(luaRow.children[1].children[0].children).toBe('lspManagerMissing')
      expect(luaRow.children[1].children[1].children).toBe('lspManagerInstall')
      const tsRow = body.children[1]
      expect(tsRow.children[1].children[0].children).toBe('5.0')
      expect(tsRow.children[1].children[1]).toBe(null)
      // install → confirm state shows the exact command first
      luaRow.children[1].children[1].onClick()
      await flush()
      const confirming = render()
      const confirmRow = confirming.children[1].children.children[0]
      expect(confirmRow.children[1].children[0].children).toBe('brew install lua-language-server')
      // an unavailable installer disables the confirm and warns
      const cppRow = confirming.children[1].children.children[2]
      cppRow.children[1].children[1].onClick()
      await flush()
      const cppConfirm = render().children[1].children.children[2]
      expect(cppConfirm.children[1].children[1].children).toBe('lspManagerInstallerMissing')
      expect(cppConfirm.children[1].children[2].children[0].disabled).toBe(true)
      cppConfirm.children[1].children[2].children[1].onClick()
      await flush()
      // run the install → the endpoint is called with the family
      confirmRow.children[1].children[2].children[0].onClick()
      await flush()
      expect(fetchCalls[1].url).toBe('api/orrery-lsp/install')
      expect(JSON.parse(fetchCalls[1].init.body)).toEqual({ family: 'lua' })
      const afterInstall = render()
      const resultBlock = afterInstall.children[1].children.children[3]
      expect(resultBlock).toBeTruthy()
      expect(resultBlock.children[0].children).toContain('lspFamily_lua')
      expect(resultBlock.children[1].children).toBe('added 2 packages')
      // fetch failure → inline error row with retry
      globalThis.fetch = () => Promise.reject(new Error('down'))
      const failed = await settle()
      failed.settled.children[0].children[1].onClick()
      await flush()
      const errored = render()
      const errorBody = errored.children[1].children
      expect(errorBody.children[0].children).toContain('lspManagerUnavailable')
      expect(errorBody.children[1].children).toBe('lspManagerRetry')
      // the boundary isolates rendering failures
      const Boundary = errored.children[1].__type
      const boundaryInstance = new Boundary({ t: (key) => key, children: 'inner' })
      expect(boundaryInstance.render()).toBe('inner')
      Boundary.getDerivedStateFromError()
      const failedBoundary = new Boundary({ t: (key) => key, children: 'inner' })
      failedBoundary.state = { failed: true }
      expect(failedBoundary.render().children).toBe('lspManagerFailed')

      // custom servers: the add form synthesizes the lspServers JSON
      globalThis.fetch = fetchStub
      const edited = []
      const customProps = { t: (key) => key, serversText: '{}', edit: (field, text) => edited.push({ field, text }) }
      const customRun = await settleWith(customProps)
      customRun.settled.children[0].children[1].onClick()
      await flush()
      const formRow = () => {
        const panel = renderWith(customProps)
        const panelBody = panel.children[1].children
        const section = panelBody.children[panelBody.children.length - 1]
        return section.children[section.children.length - 1]
      }
      expect(formRow()).toBeTruthy()
      formRow().children[0].onChange({ target: { value: 'zig' } })
      await flush()
      formRow().children[1].onChange({ target: { value: 'zls' } })
      await flush()
      formRow().children[2].onChange({ target: { value: '--stdio' } })
      await flush()
      formRow().children[3].onChange({ target: { value: 'npm i -g zls' } })
      await flush()
      formRow().children[4].onClick()
      expect(edited).toHaveLength(1)
      expect(edited[0].field).toBe('lspServers')
      const parsed = JSON.parse(edited[0].text)
      expect(parsed.zig.command).toBe('zls')
      expect(parsed.zig.args).toEqual(['--stdio'])
      expect(parsed.zig.install).toEqual({ command: 'npm', args: ['i', '-g', 'zls'] })
      // helper round-trips
      const { jsonToLspServers, lspServersToJson } = surface.lspManager
      expect(jsonToLspServers('not-json')).toEqual({})
      expect(jsonToLspServers(edited[0].text).zig.command).toBe('zls')
      expect(lspServersToJson({})).toBe('{}')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('orrery hash_edit diff view', () => {
  // Load a fresh module instance with hook-state-preserving stubs, returning
  // the plugin surface and the jsx marker factory.
  async function loadSurface() {
    const loaded = []
    globalThis.window = {
      __ModuleLoader__: {
        load: (definition) => loaded.push(definition),
      },
    }
    await import(`../lib/client.js?hash-edit-view=${Math.random()}`)
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
        }
      },
    }
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
        settingsNumberField: (field) => ({ field, kind: 'number' }),
        settingsTextField: (field) => ({ field, kind: 'text' }),
        DiffBlock: (props) => ({ __diff: props }),
        diffTotals: (diffs) => {
          let added = 0
          let removed = 0
          for (const diff of diffs) {
            added += diff.newText.split('\n').length
            removed += diff.oldText === null ? 0 : diff.oldText.split('\n').length
          }
          return { added, removed }
        },
        IconEditOutlineRegular: (props) => ({ __icon: 'edit', ...props }),
        IconChevronDownOutlineRegular: (props) => ({ __icon: 'chevron', ...props }),
        SettingsFormModel: class {
          bind() {
            return { marker: 'store', set: () => {} }
          }
          dispose() {}
        },
      }
      if (name === 'orrery-model-picker') return { ModelPickerField: () => null, ModelPickerBoundary: class { render() { return null } } }
      throw new Error(`unexpected require ${name}`)
    }
    return { surface: loaded[0].factory(requireStub), reactStub }
  }

  it('narrows applied diff metadata defensively', async () => {
    const { surface } = await loadSurface()
    const { appliedDiffFragments } = surface.hashEditView
    const fragment = { path: 'a.js', oldText: 'old', newText: 'new' }
    expect(appliedDiffFragments({ diffs: [fragment] })).toEqual([fragment])
    expect(appliedDiffFragments({ diffs: [{ path: 'a.js', oldText: null, newText: 'x' }] })).toEqual([{ path: 'a.js', oldText: null, newText: 'x' }])
    // absent / empty / malformed all decline to the generic body
    expect(appliedDiffFragments(undefined)).toBe(null)
    expect(appliedDiffFragments(null)).toBe(null)
    expect(appliedDiffFragments({})).toBe(null)
    expect(appliedDiffFragments({ diffs: [] })).toBe(null)
    expect(appliedDiffFragments({ diffs: 'nope' })).toBe(null)
    expect(appliedDiffFragments({ diffs: [{ path: 'a.js', oldText: 1, newText: 'x' }] })).toBe(null)
    expect(appliedDiffFragments({ diffs: [{ path: 'a.js', newText: 'x' }] })).toBe(null)
    expect(appliedDiffFragments({ diffs: [fragment, { bad: true }] })).toBe(null)
  })

  it('parses call arguments and derives planned fragments', async () => {
    const { surface } = await loadSurface()
    const { parseHashEditArgs, plannedDiffFragments } = surface.hashEditView
    const parsed = parseHashEditArgs(JSON.stringify({
      file_path: '/ws/a.js',
      edits: [
        { op: 'replace', pos: '2#VK', text: 'BETA' },
        { op: 'append', pos: '3#XX', text: '' },
        { op: 'prepend', pos: '1#YY', text: 'TOP', extra: 'ignored' },
      ],
    }))
    expect(parsed.path).toBe('/ws/a.js')
    expect(parsed.ops).toHaveLength(3)
    // empty-text ops (pure deletions) have no planned fragment
    const planned = plannedDiffFragments(parsed)
    expect(planned).toEqual([
      { path: '/ws/a.js', oldText: null, newText: 'BETA' },
      { path: '/ws/a.js', oldText: null, newText: 'TOP' },
    ])
    // unusable argument shapes decline
    expect(parseHashEditArgs('')).toBe(null)
    expect(parseHashEditArgs('not-json')).toBe(null)
    expect(parseHashEditArgs('{"file_path":"/ws/a.js"}')).toBe(null)
    expect(parseHashEditArgs('{"file_path":" ","edits":[]}')).toBe(null)
    expect(parseHashEditArgs('{"file_path":"/ws/a.js","edits":[{"op":"replace","pos":"1#AA"}]}')).toBe(null)
    expect(parseHashEditArgs(null)).toBe(null)
    expect(plannedDiffFragments(null)).toBe(null)
    expect(plannedDiffFragments({ path: '/ws/a.js', ops: [{ op: 'replace', pos: '1#AA', text: '' }] })).toBe(null)
  })

  it('reads args from start and result blocks and derives state', async () => {
    const { surface } = await loadSurface()
    const { hashEditArgsRaw, hashEditResultText, hashEditState, hashEditDisplayPath } = surface.hashEditView
    expect(hashEditArgsRaw({ argsRaw: '{"a":1}' })).toBe('{"a":1}')
    expect(hashEditArgsRaw({ call: { argsRaw: '{"b":2}' } })).toBe('{"b":2}')
    expect(hashEditArgsRaw({})).toBe(null)
    expect(hashEditResultText({ content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo')
    expect(hashEditResultText({})).toBe('')
    expect(hashEditState('preparing', undefined)).toBe('preparing')
    expect(hashEditState('start', {})).toBe('running')
    expect(hashEditState('result', { isError: false })).toBe('ok')
    expect(hashEditState('result', { isError: true })).toBe('error')
    expect(hashEditState('result', { isError: true, error: { code: 'interrupted' } })).toBe('stopped')
    expect(hashEditDisplayPath('/ws/src/a.js', '/ws', '/home/u')).toBe('src/a.js')
    expect(hashEditDisplayPath('/home/u/a.js', '/ws', '/home/u')).toBe('~/a.js')
    expect(hashEditDisplayPath('/other/a.js', '/ws', '/home/u')).toBe('/other/a.js')
  })

  it('renders preparing, applied-diff, planned-diff, and failure bodies', async () => {
    const { surface, reactStub } = await loadSurface()
    const { HashEditRow } = surface.hashEditView
    const t = (key) => key

    // preparing: one non-expandable streaming row
    const preparing = HashEditRow({ phase: 'preparing', block: { phase: 'preparing' }, t })
    expect(preparing['data-state']).toBe('preparing')
    expect(preparing.children.children[1].children).toBe('hashEditTitle')

    const renderStarted = (props) => {
      reactStub.begin()
      const row = HashEditRow(props)
      reactStub.begin()
      return row.__type(row)
    }
    const META = { diffs: [{ path: '/ws/a.js', oldText: 'beta', newText: 'BETA' }] }
    const RESULT_BLOCK = {
      kind: 'tool-result',
      call: { name: 'hash_edit', argsRaw: '{"file_path":"/ws/a.js","edits":[{"op":"replace","pos":"2#VK","text":"BETA"}]}' },
      content: [{ type: 'text', text: 'hash_edit applied 1 op(s) to /ws/a.js:\n\n-diff' }],
      isError: false,
      meta: META,
    }
    const okProps = { phase: 'result', block: RESULT_BLOCK, cwd: '/ws', home: '/home/u', openFile: () => {}, t }

    // collapsed header: title, relativized path, totals, no status text
    const collapsed = renderStarted(okProps)
    expect(collapsed['data-state']).toBe('ok')
    const header = collapsed.children[0]
    expect(header.children[1].children).toBe('hashEditTitle')
    expect(header.children[2].children).toBe('a.js')
    expect(header.children[3].children).toBe('+1 −1')
    expect(collapsed.children[1]).toBe(null) // body stays closed

    // expand → the DiffBlock body carries the applied fragments and labels
    header.onClick()
    const expanded = renderStarted(okProps)
    const body = expanded.children[1]
    const diffCard = body.children[1]
    expect(diffCard.diffs).toEqual(META.diffs)
    expect(diffCard.labels.copy).toBe('hashEditCopy')
    expect(typeof diffCard.labels.expand).toBe('function')
    expect(body.children[0]).toBe(null) // no planned hint on a settled call

    // running call: planned fragments from the arguments plus the hint
    reactStub.reset() // fresh hook state per scenario
    const startProps = { phase: 'start', block: { argsRaw: '{"file_path":"/ws/a.js","edits":[{"op":"append","pos":"2#VK","text":"NEW"}]}' }, cwd: '/ws', t }
    const running = renderStarted(startProps)
    expect(running['data-state']).toBe('running')
    running.children[0].onClick()
    const runningExpanded = renderStarted(startProps)
    const plannedHint = runningExpanded.children[1].children[0]
    expect(plannedHint.children).toBe('hashEditPlanned')
    expect(runningExpanded.children[1].children[1].diffs).toEqual([{ path: '/ws/a.js', oldText: null, newText: 'NEW' }])
    const runningStatus = running.children[0].children[4]
    expect(runningStatus.children).toBe('hashEditRunning')

    // failed call: no diff, flattened output, explicit failure status
    const failedBlock = { ...RESULT_BLOCK, isError: true, meta: META, content: [{ type: 'text', text: '>>> mismatch report' }] }
    reactStub.reset()
    const failedProps = { phase: 'result', block: failedBlock, cwd: '/ws', t }
    const failed = renderStarted(failedProps)
    expect(failed['data-state']).toBe('error')
    expect(failed.children[0].children[4].children).toBe('hashEditFailed')
    failed.children[0].onClick()
    const failedExpanded = renderStarted(failedProps)
    const failureBody = failedExpanded.children[1]
    expect(failureBody.children[1].children[1].children).toBe('>>> mismatch report')

    // legacy result without metadata falls back to the flattened body
    reactStub.reset()
    const legacyProps = { phase: 'result', block: { ...RESULT_BLOCK, meta: undefined }, cwd: '/ws', t }
    const legacy = renderStarted(legacyProps)
    legacy.children[0].onClick()
    const legacyExpanded = renderStarted(legacyProps)
    expect(legacyExpanded.children[1].children[1].children[1].children).toContain('hash_edit applied 1 op(s)')
  })
})

