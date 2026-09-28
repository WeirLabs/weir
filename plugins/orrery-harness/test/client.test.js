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
        }
      }
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(`unexpected require ${name}`)
    }
    const surface = loaded[0].factory(requireStub)

    expect(surface.inject).toEqual(['slots', 'locale', 'configForms', 'remote'])
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

    // drive the whileServed registration: three slot injects
    whileServedCalls[0].register(new Set(['orrery-settings']))
    expect(slotInjects.map((inject) => inject.name)).toEqual(['settings.section', 'settings.orrery.item', 'plugins.item'])

    // the top-level settings section registration
    slotInjects[0].fn()
    expect(slotRegistrations).toHaveLength(1)
    const { definition: sectionDef, component: sectionComponent } = slotRegistrations[0]
    expect(sectionDef.name).toBe('settings.section')
    expect(sectionDef.id).toBe('orrery-settings')
    expect(sectionDef.order).toBe(40)
    expect(sectionDef.children['settings.orrery.item']).toEqual({ kind: 'list', scope: 'root' })
    expect(typeof sectionDef.label).toBe('function')
    expect(sectionComponent({ renderSlot: (slot) => slot })).toBeTruthy()

    // the item slot registration hosting the form card
    slotInjects[1].fn()
    expect(slotRegistrations).toHaveLength(2)
    expect(slotRegistrations[1].definition.name).toBe('settings.orrery.item')
    expect(slotRegistrations[1].definition.id).toBe('orrery-config')

    // the Plugins-page entry
    slotInjects[2].fn()
    expect(slotRegistrations).toHaveLength(3)
    const { definition, component } = slotRegistrations[2]
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
    const FIELD_NAMES = ['intentGateClassifier','intentGateProvider','intentGateModel','intentGateReasoningEffort','intentGateTimeoutMs','jevEndpoint','jevModel','jevApiKeyEnv','delegateCategoryChains','supervisionMaxRetries','supervisionInitialBackoffMs','supervisionMaxBackoffMs','todoEnabled','todoMaxConsecutive','todoErrorRetryMax','todoErrorBackoffBaseMs','todoErrorBackoffCapMs','guardEnabled','guardSoftThreshold','guardHardThreshold','hashlineHideStockEdit','robashEnabled','lspEnabled']
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
    expect(rendered.__type).toBeTruthy()
    // 7 group headers + 6 choice rows + 1 model picker + 14 value-field rows
    expect(rendered.children).toHaveLength(28)
    expect(rendered.children.filter((child) => typeof child.children === 'string')).toHaveLength(7)
    expect(rendered.children.filter((child) => child.descriptor && child.providerText === undefined)).toHaveLength(6)
    expect(rendered.children.filter((child) => child.descriptor && child.providerText !== undefined)).toHaveLength(1)
    expect(rendered.children.filter((child) => typeof child.id === 'string')).toHaveLength(14)

    // the single model picker row: trigger button with the current selection
    const pickerRow = rendered.children.find((child) => child.descriptor?.field === 'intentGateProvider')
    const pickerRendered = pickerRow.__type({ ...pickerRow, t: (key) => key })
    const trigger = pickerRendered.children[1].children[0]
    expect(trigger.style.appearance).toBe('none')
    expect(typeof trigger.onClick).toBe('function')
    expect(trigger.children).toBe('modelEmpty')

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
