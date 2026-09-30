import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { CURATED_AGENTS } from '../src/delegate/agents.js'

/**
 * client.settings-page.js chunk test: shared helper + react/jsx-runtime/
 * primitives/modelPicker stubs per the chunk's actual require face. The three
 * field editors arrive as sentinel props (composition-root injection).
 * Assertions migrated verbatim from the pre-split client.test.js settings
 * page blocks, plus the prop-injected controller dependency pins.
 */

describe('client.settings-page chunk', () => {
  async function loadPage() {
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
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      if (name === 'orrery-model-picker') return { ModelPickerField: (props) => ({ __picker: props }), ModelPickerBoundary: class { constructor(props) { this.props = props } render() { return this.props.children } } }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.settings-page.js', requireStub)
    const editors = {
      ChainEditorField: (props) => ({ __chainEditor: props }),
      RobashListEditorField: (props) => ({ __robashEditor: props }),
      LspManagerField: (props) => ({ __lspPanel: props }),
    }
    return { definition, exports, editors, specsSeen, reactStub }
  }

  // Capture the entry's synchronously registered en/zh dictionaries by
  // driving lib/client.js's apply with a minimal fake ctx (slot/config
  // effects are inert stubs; only locale.register is observed).
  async function loadDictionaries() {
    const { exports: entry } = await loadClientChunk('lib/client.js', () => ({}))
    const registrations = []
    entry.apply({
      locale: { bind: () => (key) => key, register: (ns, dicts) => registrations.push({ ns, dicts }) },
      effect: (fn) => {
        fn()
        return () => {}
      },
      slots: { inject: () => () => {} },
      configForms: { whileServed: () => () => {} },
      remote: {},
    })
    return registrations[0].dicts
  }

  const FIELD_NAMES = ['intentGateClassifier','intentGateProvider','intentGateModel','intentGateReasoningEffort','intentGateTimeoutMs','jevEndpoint','jevModel','jevApiKeyEnv','delegateCategoryChains','delegateAgentChains','delegateDisabledCategories','supervisionMaxRetries','supervisionInitialBackoffMs','supervisionMaxBackoffMs','todoEnabled','todoMaxConsecutive','todoErrorRetryMax','todoErrorBackoffBaseMs','todoErrorBackoffCapMs','guardEnabled','guardSoftThreshold','guardHardThreshold','hashlineHideStockEdit','robashEnabled','robashAllow','robashGitAllow','robashDeny','robashPwshAllow','robashPwshDeny','lspEnabled','lspIdleMs','lspRequestTimeoutMs','lspDiagnosticsWaitMs','lspServers']

  it('renders the GROUPS field table through the prop-injected editors', async () => {
    const { definition, exports, editors } = await loadPage()
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.settings-page.js')

    const { GROUPS, OrreryCard } = exports
    // the GROUPS field table is exactly the pre-split flat namespace
    expect(GROUPS.flatMap((group) => group.fields).map((descriptor) => descriptor.field)).toEqual(FIELD_NAMES)

    const component = OrreryCard
    expect(component({ view: 'summary', t: (key) => key, useOrrerySettingsCard: (selector) => selector({ writable: true, fields: {} }), editors })).toBe('description')
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
      getSession: () => {},
      editors,
    })

    expect(rendered.__type).toBeTruthy()
    // 7 group headers + 6 choice rows + 1 model picker + 17 value-field rows
    // + 1 LSP manager row + 5 robash list-editor rows + 2 chain-editor rows
    expect(rendered.children).toHaveLength(39)
    expect(rendered.children.filter((child) => typeof child.children === 'string')).toHaveLength(7)
    expect(rendered.children.filter((child) => child.descriptor)).toHaveLength(6)
    expect(rendered.children.filter((child) => child.fallback !== undefined)).toHaveLength(1)
    expect(rendered.children.filter((child) => typeof child.id === 'string')).toHaveLength(17)
    // the LSP manager row opens the service management panel
    const managerRow = rendered.children.find((child) => child.key === 'lsp-manager')
    expect(managerRow).toBeTruthy()
    expect(managerRow.__type).toBe(editors.LspManagerField)
    // the two chains rows render the visual editor: category lanes (default
    // rows) and curated-agent lanes (rows from the pinned registry list)
    const chainRows = rendered.children.filter((child) => child.__type === editors.ChainEditorField)
    expect(chainRows).toHaveLength(2)
    expect(chainRows[0].field).toBe('delegateCategoryChains')
    expect(chainRows[0].rows).toBeUndefined()
    expect(chainRows[0].key).toBe('delegateCategoryChains')
    expect(typeof chainRows[0].getSession).toBe('function')
    expect(chainRows[1].field).toBe('delegateAgentChains')
    expect(chainRows[1].rows).toBe(exports.CURATED_AGENT_NAMES)
    expect(chainRows[1].rowLabelPrefix).toBe('chainAgent_')
    expect(chainRows[1].panelHintKey).toBe('chainAgentPanelHint')
    expect(chainRows[1].key).toBe('delegateAgentChains')
    expect(typeof chainRows[1].getSession).toBe('function')

    // the five robash whitelist rows render the list editor (GROUPS.robash):
    // bash allow/gitAllow/deny + pwsh allow/deny, reusing RobashListEditorField
    const ROBASH_LIST_FIELDS = ['robashAllow', 'robashGitAllow', 'robashDeny', 'robashPwshAllow', 'robashPwshDeny']
    const robashRows = rendered.children.filter((child) => ROBASH_LIST_FIELDS.includes(child.field))
    expect(robashRows).toHaveLength(5)
    expect(robashRows.map((row) => row.key)).toEqual(ROBASH_LIST_FIELDS)
    expect(robashRows.every((row) => row.__type === editors.RobashListEditorField && typeof row.edit === 'function' && typeof row.onReset === 'function')).toBe(true)

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

  it('renders the section as the nested item slot', async () => {
    const { exports } = await loadPage()
    const { OrrerySection } = exports
    const section = OrrerySection({ renderSlot: (slot) => slot })
    expect(section.children).toBe('settings.orrery.item')
  })

  it('controller: builds the flat field specs, exposes the inject face, and bumps the prop-injected bus on save', async () => {
    const { exports, specsSeen } = await loadPage()
    const { OrreryCardController, FIELDS } = exports

    const notifications = []
    const settingsBus = { subscribe: () => () => {}, notify: () => notifications.push('bump') }
    let sessionCalls = 0
    const session = { marker: 'session' }
    const getSession = () => {
      sessionCalls += 1
      return session
    }
    const scope = { ns: 'orrery-settings' }
    const controller = new OrreryCardController(scope, { settingsBus, getSession })

    // the form model tracks the flat FIELDS spec list (robash list fields are
    // plain text fields at this layer)
    const ROBASH_LIST_FIELDS = ['robashAllow', 'robashGitAllow', 'robashDeny', 'robashPwshAllow', 'robashPwshDeny']
    expect(specsSeen).toHaveLength(FIELDS.length)
    expect(specsSeen.filter((spec) => ROBASH_LIST_FIELDS.includes(spec.field))).toHaveLength(5)

    // the inject face: hooks + edit/reset/save/discard + lazy getSession
    const face = controller.inject()
    expect(face.hooks.orrerySettingsCard).toBeTruthy()
    expect(typeof face.edit).toBe('function')
    expect(typeof face.resetField).toBe('function')
    expect(typeof face.save).toBe('function')
    expect(typeof face.discard).toBe('function')
    expect(sessionCalls).toBe(0)
    expect(face.getSession()).toBe(session)
    expect(sessionCalls).toBe(1)

    // a successful save bumps the prop-injected settings bus (the composer
    // toggle's re-check propagation)
    face.save()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notifications).toEqual(['bump'])

    controller.dispose()
  })
  it('pins the curated agent lane names to the server registry (rename drift guard)', async () => {
    const { exports } = await loadPage()
    // The client keeps the curated agent names in ONE exported constant; the
    // server registry (src/delegate/agents.js) is the authority. A rename on
    // either side turns this red instead of drifting the settings page.
    expect(exports.CURATED_AGENT_NAMES).toEqual(Object.keys(CURATED_AGENTS))
  })

  it('resolves a label and a hint for every GROUPS field in both dictionaries — never the raw key', async () => {
    const { exports } = await loadPage()
    const { exports: chainModel } = await loadClientChunk('lib/client.chain-model.js')
    const dicts = await loadDictionaries()
    // The locale service falls back to the KEY itself (lookup(...) ?? key), so
    // a missing entry renders the raw camelCase key to the user — the exact
    // gap that shipped delegateAgentChains / delegateDisabledCategories
    // invisibly. Assert the RESOLVED text exists and differs from the key.
    const expectResolved = (dict, key) => {
      expect(typeof dict[key]).toBe('string')
      expect(dict[key].length).toBeGreaterThan(0)
      expect(dict[key]).not.toBe(key)
    }
    for (const locale of ['en', 'zh']) {
      const dict = dicts[locale]
      for (const descriptor of exports.GROUPS.flatMap((group) => group.fields)) {
        expectResolved(dict, descriptor.field)
        expectResolved(dict, `${descriptor.field}Hint`)
      }
      // every chain-editor lane (categories + curated agents) has a human label
      const laneKeys = [
        ...chainModel.CHAIN_CATEGORIES.map((name) => `chainCategory_${name}`),
        ...exports.CURATED_AGENT_NAMES.map((name) => `chainAgent_${name}`),
      ]
      for (const key of laneKeys) {
        expectResolved(dict, key)
        expectResolved(dict, `${key}_desc`)
      }
    }
  })
})
