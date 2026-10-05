import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { CURATED_AGENTS } from '../src/delegate/agents.js'
import { DEFAULT_CATEGORIES } from '../src/delegate/categories.js'
import { RESTART_KEYS } from '../src/settings/sections.js'

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
      Modal: (props) => ({ __modal: props }),
      Button: (props) => ({ __button: props }),
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
        plan() {
          return this.planItems ?? []
        }
        async save() {
          this.saveCalls = (this.saveCalls ?? 0) + 1
          return this.saveResult
        }
        publish() {
          this.publishCount = (this.publishCount ?? 0) + 1
        }
        shell() {
          return this.shellState ?? { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }
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
      DisabledCategoriesEditorField: (props) => ({ __disabledCategoriesEditor: props }),
      LspManagerField: (props) => ({ __lspPanel: props }),
      NotifyPermissionsField: (props) => ({ __notifyPermissions: props }),
      EditLockMaintenanceField: (props) => ({ __editLockMaintenance: props }),
    }
    return { definition, exports, editors, specsSeen, reactStub }
  }

  // Capture the entry's synchronously registered en/zh dictionaries by
  // driving lib/client.js's apply with a minimal fake ctx (slot/config
  // effects are inert stubs; only locale.register is observed).
  async function loadDictionaries() {
    const { exports: entry } = await loadClientChunk('lib/client.js', Object.assign(() => ({}), { async: () => Promise.reject(new Error('chunks are not loaded in a dictionary-only test')) }))
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

  const FIELD_NAMES = ['intentGateClassifier','intentGateProvider','intentGateModel','intentGateReasoningEffort','intentGateTimeoutMs','jevEndpoint','jevModel','jevApiKeyEnv','delegateCategoryChains','delegateAgentChains','delegateDisabledCategories','supervisionMaxRetries','supervisionInitialBackoffMs','supervisionMaxBackoffMs','todoEnabled','todoMaxConsecutive','todoErrorRetryMax','todoErrorBackoffBaseMs','todoErrorBackoffCapMs','guardEnabled','guardSoftThreshold','guardHardThreshold','hashlineHideStockEdit','editLockEnabled','editLockAutoResume','editLockHoldDefaultMinutes','editLockHoldSingleMaxMinutes','editLockHoldCumulativeMaxMinutes','editLockNudgeAttempts','editLockNudgeFallback','worktreeEnabled','worktreeAutoSetup','worktreeMaxActive','worktreeRoot','worktreeWatchTimeoutMinutes','robashEnabled','robashAllow','robashGitAllow','robashDeny','robashPwshAllow','robashPwshDeny','lspEnabled','lspIdleMs','lspRequestTimeoutMs','lspDiagnosticsWaitMs','lspServers','notifyEnabled','notifyOnComplete','notifyOnAttention','notifyMinTurnSeconds','notifySound','notifyForeground']

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
    // 9 group headers + 15 choice rows + 1 model picker + 25 value-field rows
    // + 1 LSP manager row + 5 robash list-editor rows + 2 chain-editor rows
    // + 1 disabled-categories editor row + 1 notification-permission row
    // + 1 edit-lock-maintenance row
    expect(rendered.children).toHaveLength(61)
    // the permission entry sits at the end of the notify group
    const permissionRow = rendered.children.find((child) => child.key === 'notify-permissions')
    expect(permissionRow.__type).toBe(editors.NotifyPermissionsField)
    expect(typeof permissionRow.t).toBe('function')
    expect(rendered.children.filter((child) => typeof child.children === 'string')).toHaveLength(9)
    expect(rendered.children.filter((child) => child.descriptor)).toHaveLength(15)
    expect(rendered.children.filter((child) => child.fallback !== undefined)).toHaveLength(1)
    expect(rendered.children.filter((child) => typeof child.id === 'string')).toHaveLength(25)
    // the Edit Lock maintenance row opens the profile-wide maintenance panel
    const maintenanceRow = rendered.children.find((child) => child.key === 'edit-lock-maintenance')
    expect(maintenanceRow).toBeTruthy()
    expect(maintenanceRow.__type).toBe(editors.EditLockMaintenanceField)
    expect(typeof maintenanceRow.t).toBe('function')
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

    // the disabled-categories row renders the toggle editor over the
    // parity-pinned category rows
    const disabledRow = rendered.children.find((child) => child.key === 'delegateDisabledCategories')
    expect(disabledRow).toBeTruthy()
    expect(disabledRow.__type).toBe(editors.DisabledCategoriesEditorField)
    expect(disabledRow.field).toBe('delegateDisabledCategories')
    expect(disabledRow.rows).toBe(exports.CATEGORY_NAMES)
    expect(typeof disabledRow.edit).toBe('function')
    expect(typeof disabledRow.onReset).toBe('function')

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

  it('renders the restart reminder as a centered modal when the state carries one', async () => {
    const { exports, editors } = await loadPage()
    const { OrreryCard } = exports

    const dismissals = []
    const rendered = OrreryCard({
      view: 'form',
      t: (key) => key,
      useOrrerySettingsCard: (selector) => selector({
        writable: true,
        fields: Object.fromEntries(FIELD_NAMES.map((name) => [name, { text: '', invalid: false, overridden: false }])),
        restartReminder: ['todoEnabled', 'editLockEnabled'],
      }),
      edit: () => {},
      resetField: () => {},
      save: () => {},
      discard: () => {},
      dismissRestartReminder: () => dismissals.push('dismiss'),
      getSession: () => {},
      editors,
    })

    // the modal trails the form children (61 group rows + 1 modal)
    expect(rendered.children).toHaveLength(62)
    const modal = rendered.children[61]
    expect(modal.key).toBe('restart-reminder')
    expect(modal.open).toBe(true)
    expect(modal.title).toBe('restartReminderTitle')
    expect(modal.description).toBe('restartReminderBody')
    expect(modal.closeLabel).toBe('restartReminderDismiss')
    // closing via the mask or Escape dismisses through the injected action
    modal.onClose()
    expect(dismissals).toEqual(['dismiss'])
    // body: one accent tag per affected field, labeled via t(field)
    const tags = modal.children.children
    expect(tags.map((tag) => tag.children)).toEqual(['todoEnabled', 'editLockEnabled'])
    expect(tags.every((tag) => tag.tone === 'accent')).toBe(true)
    // footer: a primary acknowledge button that dismisses too
    expect(modal.footer.variant).toBe('primary')
    expect(modal.footer.children).toBe('restartReminderAcknowledge')
    modal.footer.onClick()
    expect(dismissals).toEqual(['dismiss', 'dismiss'])
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
    expect(typeof face.dismissRestartReminder).toBe('function')
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

  // Save-flow controller tests: the stub SettingsFormModel is driven through
  // planItems / saveResult / shellState / save overrides; publish() is a
  // counter (the real model re-notifies bound stores from it).
  async function makeController() {
    const { exports } = await loadPage()
    const notifications = []
    const settingsBus = { subscribe: () => () => {}, notify: () => notifications.push('bump') }
    const controller = new exports.OrreryCardController({ ns: 'orrery-settings' }, { settingsBus, getSession: () => ({}) })
    return { controller, notifications, face: controller.inject() }
  }

  it('save flow: a landed save touching restart-required keys raises the reminder in registry order', async () => {
    const { controller, notifications, face } = await makeController()
    controller.form.planItems = [
      { field: 'editLockEnabled', op: { op: 'set', path: ['editLockEnabled'], value: true } },
      { field: 'todoEnabled', op: { op: 'set', path: ['todoEnabled'], value: false } },
      { field: 'supervisionMaxRetries', op: { op: 'set', path: ['supervisionMaxRetries'], value: 7 } },
    ]
    await face.save()
    expect(notifications).toEqual(['bump'])
    // registry order (todoEnabled precedes editLockEnabled), not plan order
    expect(controller.restartReminder).toEqual(['todoEnabled', 'editLockEnabled'])
    expect(controller.projection().restartReminder).toEqual(['todoEnabled', 'editLockEnabled'])
    expect(controller.form.publishCount).toBe(1)
  })

  it('save flow: a landed save touching only live keys raises no reminder', async () => {
    const { controller, notifications, face } = await makeController()
    controller.form.planItems = [{ field: 'supervisionMaxRetries', op: { op: 'set', path: ['supervisionMaxRetries'], value: 7 } }]
    await face.save()
    expect(controller.restartReminder).toBe(null)
    expect(notifications).toEqual(['bump'])
    expect(controller.form.publishCount).toBe(1)
  })

  it('save flow: an invalid draft refuses the save and raises no reminder', async () => {
    const { controller, notifications, face } = await makeController()
    // a plan item without op/run is an unparseable draft: the form refuses
    // the save, and a refused save must not name the field in the reminder
    controller.form.planItems = [{ field: 'todoEnabled' }]
    await face.save()
    expect(controller.restartReminder).toBe(null)
    expect(notifications).toEqual(['bump'])
    expect(controller.form.publishCount).toBe(1)
  })

  it('save flow: a failed save raises no reminder but still bumps the bus after the settle', async () => {
    const { controller, notifications, face } = await makeController()
    controller.form.planItems = [{ field: 'todoEnabled', op: { op: 'set', path: ['todoEnabled'], value: false } }]
    controller.form.shellState = { available: true, writable: true, dirty: true, invalid: false, saving: false, failed: true }
    await face.save()
    expect(controller.restartReminder).toBe(null)
    expect(notifications).toEqual(['bump'])
    expect(controller.form.publishCount).toBe(1)
  })

  it('save flow: a live-only save keeps an already-shown reminder, and a later restart save replaces it', async () => {
    const { controller, face } = await makeController()
    controller.form.planItems = [{ field: 'todoEnabled', op: { op: 'set', path: ['todoEnabled'], value: false } }]
    await face.save()
    expect(controller.restartReminder).toEqual(['todoEnabled'])
    controller.form.planItems = [{ field: 'supervisionMaxRetries', op: { op: 'set', path: ['supervisionMaxRetries'], value: 7 } }]
    await face.save()
    expect(controller.restartReminder).toEqual(['todoEnabled'])
    controller.form.planItems = [{ field: 'guardHardThreshold', op: { op: 'set', path: ['guardHardThreshold'], value: 0.9 } }]
    await face.save()
    expect(controller.restartReminder).toEqual(['guardHardThreshold'])
    expect(controller.form.publishCount).toBe(3)
  })

  it('save flow: dismiss clears the reminder and re-publishes', async () => {
    const { controller, face } = await makeController()
    controller.form.planItems = [{ field: 'guardEnabled', op: { op: 'set', path: ['guardEnabled'], value: false } }]
    await face.save()
    expect(controller.restartReminder).toEqual(['guardEnabled'])
    face.dismissRestartReminder()
    expect(controller.restartReminder).toBe(null)
    expect(controller.projection().restartReminder).toBe(null)
    expect(controller.form.publishCount).toBe(2)
  })

  it('save flow: the settings bus bumps only after the save promise settles (no save-start fire)', async () => {
    const { controller, notifications, face } = await makeController()
    controller.form.planItems = [{ field: 'todoEnabled', op: { op: 'set', path: ['todoEnabled'], value: false } }]
    let settle
    controller.form.save = () => new Promise((resolve) => { settle = resolve })
    const pending = face.save()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // save still in flight: neither the bus bump nor the reminder may fire early
    expect(notifications).toEqual([])
    expect(controller.restartReminder).toBe(null)
    settle()
    await pending
    expect(notifications).toEqual(['bump'])
    expect(controller.restartReminder).toEqual(['todoEnabled'])
    expect(controller.form.publishCount).toBe(1)
  })
  it('pins the curated agent lane names to the server registry (rename drift guard)', async () => {
    const { exports } = await loadPage()
    // The client keeps the curated agent names in ONE exported constant; the
    // server registry (src/delegate/agents.js) is the authority. A rename on
    // either side turns this red instead of drifting the settings page.
    expect(exports.CURATED_AGENT_NAMES).toEqual(Object.keys(CURATED_AGENTS))
  })

  it('pins the category names to the server registry (registry drift guard)', async () => {
    const { exports } = await loadPage()
    // The client keeps the delegation category names in ONE exported constant;
    // the server registry (src/delegate/categories.js) is the authority. A
    // registry change on either side turns this red instead of drifting the
    // disabled-categories editor rows.
    expect(exports.CATEGORY_NAMES).toEqual(Object.keys(DEFAULT_CATEGORIES))
  })

  it('pins the restart-required field list to the server schema (drift guard)', async () => {
    const { exports } = await loadPage()
    // The client keeps the restart-required keys in ONE exported constant;
    // the server schema (RESTART_KEYS, derived from the FIELDS restart
    // markers in src/settings/sections.js) is the authority. A change on
    // either side turns this red instead of drifting the restart reminder.
    expect(exports.RESTART_FIELDS).toEqual([...RESTART_KEYS])
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
      // the restart reminder banner's own keys resolve too
      for (const key of ['restartReminderTitle', 'restartReminderBody', 'restartReminderDismiss']) {
        expectResolved(dict, key)
      }
      // the disabled-categories editor's own panel keys resolve too
      for (const key of ['disabledCategoriesCount', 'disabledCategoriesPanelHint', 'disabledCategoriesInvalid']) {
        expectResolved(dict, key)
      }
    }
  })
})
