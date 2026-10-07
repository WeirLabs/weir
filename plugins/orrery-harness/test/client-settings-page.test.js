import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { CURATED_AGENTS } from '../src/delegate/agents.js'
import { DEFAULT_CATEGORIES } from '../src/delegate/categories.js'
import { FIELD_DEFAULTS as SERVER_FIELD_DEFAULTS, RESTART_KEYS } from '../src/settings/sections.js'

/**
 * client.settings-page.js chunk test: shared helper + react/jsx-runtime/
 * primitives/modelPicker stubs per the chunk's require face. The special
 * field editors arrive as sentinel props (composition-root injection).
 * Covers the pure exports (evaluateCondition / resolveEffectiveValue /
 * validateLayout / buildLayout), the env three-state gating, the card/tree
 * render structure, the always-on restart tag, and the save-flow contract
 * migrated from the pre-split client.test.js settings page blocks.
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
        sectionValue(name) {
          return this.savedValues?.[name]
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
    return { definition, exports, editors, specsSeen, reactStub, primitivesStub }
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

  const FIELD_NAMES = ['intentGateClassifier','intentGateProvider','intentGateModel','intentGateReasoningEffort','intentGateTimeoutMs','jevEndpoint','jevModel','jevApiKeyEnv','delegateCategoryChains','delegateAgentChains','delegateDisabledCategories','supervisionMaxRetries','supervisionInitialBackoffMs','supervisionMaxBackoffMs','todoEnabled','todoMaxConsecutive','todoErrorRetryMax','todoErrorBackoffBaseMs','todoErrorBackoffCapMs','guardEnabled','guardSoftThreshold','guardHardThreshold','hashlineHideStockEdit','editLockEnabled','editLockAutoResume','editLockStaleSweep','editLockHoldDefaultMinutes','editLockHoldSingleMaxMinutes','editLockHoldCumulativeMaxMinutes','editLockNudgeAttempts','editLockNudgeFallback','worktreeEnabled','worktreeAutoSetup','worktreeMaxActive','worktreeRoot','worktreeWatchTimeoutMinutes','robashEnabled','robashAllow','robashGitAllow','robashDeny','robashPwshAllow','robashPwshDeny','lspEnabled','lspIdleMs','lspRequestTimeoutMs','lspDiagnosticsWaitMs','lspServers','notifyEnabled','notifyOnComplete','notifyOnAttention','notifyMinTurnSeconds','notifySound','notifyForeground']

  // The six boolean product defaults shipped after BOOLEAN_DEFAULTS was first
  // written. Their module/bundle defaults are all ON (cordis.patch.yml
  // orrery-settings row; src/notify/policy.js DEFAULTS.enabled/onComplete/
  // onAttention/sound), and a profile-level row replaces the bundle row
  // wholesale — so a key the profile never saved arrives unset and must still
  // read ON for the Switch AND for the `when` conditions of its children.
  const MIRRORED_ON_BOOLEANS = ['editLockAutoResume', 'editLockStaleSweep', 'notifyEnabled', 'notifyOnComplete', 'notifyOnAttention', 'notifySound']

  /** A full fields map at rest (every text the formatted saved value). */
  function makeFields(overrides = {}) {
    const fields = Object.fromEntries(FIELD_NAMES.map((name) => [name, { text: '', invalid: false, overridden: false }]))
    // production default: the classifier arrives set from the composition layer
    fields.intentGateClassifier.text = 'regex'
    for (const [name, patch] of Object.entries(overrides)) fields[name] = { ...fields[name], ...patch }
    return fields
  }

  function renderCard(exports, editors, state, spies = {}) {
    return exports.OrreryCard({
      view: 'form',
      t: (key) => key,
      useOrrerySettingsCard: (selector) => selector({ writable: true, ...state }),
      edit: spies.edit ?? (() => {}),
      resetField: spies.resetField ?? (() => {}),
      save: () => {},
      discard: () => {},
      dismissRestartReminder: spies.dismissRestartReminder ?? (() => {}),
      getSession: () => {},
      editors,
    })
  }

  /** Card lookup: rendered.children[0] is the cards column; cards carry data-group. */
  function cardsOf(rendered) {
    const column = rendered.children[0]
    return Object.fromEntries(column.children.map((card) => [card['data-group'], card]))
  }
  /** Row keys of one card, in render order (card children minus the title). */
  function rowKeys(cards, groupId) {
    return cards[groupId].children.slice(1).map((row) => row.key)
  }
  /** Recursive element-tree search (styles are leaf objects; functions skipped). */
  function findAll(node, pred, acc = []) {
    if (node && typeof node === 'object') {
      if (pred(node)) acc.push(node)
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const item of value) findAll(item, pred, acc)
        else if (value && typeof value === 'object') findAll(value, pred, acc)
      }
    }
    return acc
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('keeps the flat FIELDS table (order unchanged) and renders the summary description', async () => {
    const { definition, exports, editors } = await loadPage()
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.settings-page.js')
    // the form-layer field table is exactly the pre-overhaul flat namespace
    expect(exports.FIELDS.map((descriptor) => descriptor.field)).toEqual(FIELD_NAMES)
    expect(exports.OrreryCard({ view: 'summary', t: (key) => key, useOrrerySettingsCard: (selector) => selector({ writable: true, fields: {} }), editors })).toBe('description')
  })

  it('renders the card-based sections and the default visible set per group', async () => {
    const { exports, editors } = await loadPage()
    const rendered = renderCard(exports, editors, {
      fields: makeFields(),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    // one child: the cards column (no restart reminder)
    expect(rendered.children).toHaveLength(1)
    const column = rendered.children[0]
    expect(column.style).toEqual({ display: 'flex', flexDirection: 'column', gap: '12px' })
    const cards = cardsOf(rendered)
    const groupIds = Object.keys(cards)
    expect(groupIds).toEqual(['intent', 'delegate', 'todo', 'guard', 'editing', 'worktree', 'robash', 'lsp', 'notify'])
    // every card: layered background, l1 border, radius, title inside the top
    for (const [id, card] of Object.entries(cards)) {
      expect(card.style.background).toBe('var(--dsw-alias-bg-layer-1)')
      expect(card.style.border).toBe('1px solid var(--dsw-alias-border-l1)')
      expect(card.style.borderRadius).toBe('12px')
      expect(card.children[0].children).toBe(`group${id.charAt(0).toUpperCase()}${id.slice(1)}`)
    }
    // the default visible set (product defaults: todo/guard/worktree/robash/
    // notify on; editLock/lsp off; classifier regex; platform darwin)
    expect(rowKeys(cards, 'intent')).toEqual(['intentGateClassifier', 'intentGateTimeoutMs'])
    expect(rowKeys(cards, 'delegate')).toEqual(['delegateCategoryChains', 'delegateAgentChains', 'delegateDisabledCategories', 'supervisionMaxRetries', 'supervisionInitialBackoffMs', 'supervisionMaxBackoffMs'])
    expect(rowKeys(cards, 'todo')).toEqual(['todoEnabled', 'todoMaxConsecutive', 'todoErrorRetryMax', 'todoErrorBackoffBaseMs', 'todoErrorBackoffCapMs'])
    expect(rowKeys(cards, 'guard')).toEqual(['guardEnabled', 'guardSoftThreshold', 'guardHardThreshold'])
    expect(rowKeys(cards, 'editing')).toEqual(['hashlineHideStockEdit', 'editLockEnabled'])
    expect(rowKeys(cards, 'worktree')).toEqual(['worktreeEnabled', 'worktreeAutoSetup', 'worktreeMaxActive', 'worktreeRoot', 'worktreeWatchTimeoutMinutes'])
    expect(rowKeys(cards, 'robash')).toEqual(['robashEnabled', 'robashAllow', 'robashGitAllow', 'robashDeny'])
    expect(rowKeys(cards, 'lsp')).toEqual(['lspEnabled'])
    expect(rowKeys(cards, 'notify')).toEqual(['notifyEnabled', 'notifyOnComplete', 'notifyMinTurnSeconds', 'notifyOnAttention', 'notifySound', 'notifyForeground', 'notifyPermissions'])
    // hairline separators: the first row in a card has none, the rest do
    const todoRows = cards.todo.children.slice(1)
    expect(todoRows[0].style.borderTop).toBe('none')
    for (const row of todoRows.slice(1)) expect(row.style.borderTop).toBe('1px solid var(--dsw-alias-border-l2)')
  })

  it('indents child rows with a guide line scaled by depth, including the two-level case', async () => {
    const { exports, editors } = await loadPage()
    const rendered = renderCard(exports, editors, {
      fields: makeFields({
        notifyEnabled: { text: 'true' },
        notifyOnComplete: { text: 'true' },
      }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    const cards = cardsOf(rendered)
    // depth 1 children in the todo card
    const todoRows = cards.todo.children.slice(1)
    expect(todoRows[0]['data-depth']).toBe(undefined)
    expect(todoRows[0].style.borderLeft).toBe(undefined)
    for (const row of todoRows.slice(1)) {
      expect(row['data-depth']).toBe(1)
      expect(row.style.borderLeft).toBe('1px solid var(--dsw-alias-border-l2)')
      expect(row.style.paddingLeft).toBe('16px')
    }
    // the two-level case: notifyMinTurnSeconds nests under notifyOnComplete
    expect(rowKeys(cards, 'notify')).toEqual(['notifyEnabled', 'notifyOnComplete', 'notifyMinTurnSeconds', 'notifyOnAttention', 'notifySound', 'notifyForeground', 'notifyPermissions'])
    const notifyRows = cards.notify.children.slice(1)
    const minTurn = notifyRows.find((row) => row.key === 'notifyMinTurnSeconds')
    expect(minTurn['data-depth']).toBe(2)
    expect(minTurn.style.paddingLeft).toBe('32px')
    // it renders directly under its parent, before the later siblings
    expect(notifyRows.indexOf(minTurn)).toBe(notifyRows.findIndex((row) => row.key === 'notifyOnComplete') + 1)
  })

  it('flips dependent rows live with the staged switch draft — no save needed', async () => {
    const { exports, editors } = await loadPage()
    // todoEnabled product default is on; a staged "false" draft hides its
    // children immediately, a staged "true" draft brings them back
    const off = renderCard(exports, editors, {
      fields: makeFields({ todoEnabled: { text: 'false' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    expect(rowKeys(cardsOf(off), 'todo')).toEqual(['todoEnabled'])
    const on = renderCard(exports, editors, {
      fields: makeFields({ todoEnabled: { text: 'true' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    expect(rowKeys(cardsOf(on), 'todo')).toHaveLength(5)
    // hiding performs no writes: the hidden rows' staged drafts and saved
    // values are untouched by the render itself
    const editCalls = []
    const hidden = renderCard(exports, editors, {
      fields: makeFields({ todoEnabled: { text: 'false' }, todoMaxConsecutive: { text: '7' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    }, { edit: (...args) => editCalls.push(args) })
    const hiddenRowKeys = Object.values(cardsOf(hidden)).flatMap((card) => card.children.slice(1).map((row) => row.key))
    expect(hiddenRowKeys).not.toContain('todoMaxConsecutive')
    expect(editCalls).toEqual([])
  })

  it('evaluates enum conditions: classifier llm shows the picker row, jev shows the jev rows', async () => {
    const { exports, editors } = await loadPage()
    const llm = renderCard(exports, editors, {
      fields: makeFields({ intentGateClassifier: { text: 'llm' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    expect(rowKeys(cardsOf(llm), 'intent')).toEqual(['intentGateClassifier', 'intentGateProvider', 'intentGateTimeoutMs'])
    const jev = renderCard(exports, editors, {
      fields: makeFields({ intentGateClassifier: { text: 'jev' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    expect(rowKeys(cardsOf(jev), 'intent')).toEqual(['intentGateClassifier', 'intentGateTimeoutMs', 'jevEndpoint', 'jevModel', 'jevApiKeyEnv'])
  })

  it('gates env-dependent rows on the env three-state: pending hides, ready evaluates, failed stays hidden', async () => {
    const { exports, editors } = await loadPage()
    const pwshRows = ['robashPwshAllow', 'robashPwshDeny']
    // pending: no flicker — env rows render nothing, the rest renders
    const pending = renderCard(exports, editors, {
      fields: makeFields(),
      env: { status: 'pending', facts: {} },
    })
    const pendingKeys = rowKeys(cardsOf(pending), 'robash')
    expect(pendingKeys).toEqual(['robashEnabled', 'robashAllow', 'robashGitAllow', 'robashDeny'])
    // ready on macOS: the Windows-only rows stay hidden
    const darwin = renderCard(exports, editors, {
      fields: makeFields(),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    expect(rowKeys(cardsOf(darwin), 'robash')).toEqual(pendingKeys)
    // ready on Windows: both pwsh rows appear under the master switch
    const win32 = renderCard(exports, editors, {
      fields: makeFields(),
      env: { status: 'ready', facts: { platform: 'win32' } },
    })
    expect(rowKeys(cardsOf(win32), 'robash')).toEqual(['robashEnabled', 'robashAllow', 'robashGitAllow', 'robashDeny', ...pwshRows])
    // failed: same as pending, the rest of the page unaffected
    const failed = renderCard(exports, editors, {
      fields: makeFields(),
      env: { status: 'failed', facts: {} },
    })
    expect(rowKeys(cardsOf(failed), 'robash')).toEqual(pendingKeys)
    expect(rowKeys(cardsOf(failed), 'todo')).toHaveLength(5)
    // ...but a disabled master switch hides even Windows-matching rows
    const win32Off = renderCard(exports, editors, {
      fields: makeFields({ robashEnabled: { text: 'false' } }),
      env: { status: 'ready', facts: { platform: 'win32' } },
    })
    expect(rowKeys(cardsOf(win32Off), 'robash')).toEqual(['robashEnabled'])
  })

  it('hides the whole subtree when a parent is hidden, whatever the children conditions say', async () => {
    const { exports, editors } = await loadPage()
    // notifyEnabled off → notifyOnComplete hidden → notifyMinTurnSeconds
    // hidden too, even with a staged "true" draft of its own condition key
    const rendered = renderCard(exports, editors, {
      fields: makeFields({
        notifyEnabled: { text: 'false' },
        notifyOnComplete: { text: 'true' },
      }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    expect(rowKeys(cardsOf(rendered), 'notify')).toEqual(['notifyEnabled', 'notifyPermissions'])
  })

  it('renders the special editors as custom tree nodes with their composition-root props', async () => {
    const { exports, editors } = await loadPage()
    const rendered = renderCard(exports, editors, {
      fields: makeFields({
        intentGateClassifier: { text: 'llm' },
        editLockEnabled: { text: 'true' },
        lspEnabled: { text: 'true' },
      }),
      env: { status: 'ready', facts: { platform: 'win32' } },
    })
    const cards = cardsOf(rendered)
    // the two chain editors (category lanes default, curated-agent lanes
    // pinned) — sentinel components arrive as element types, never invoked
    const chainRows = findAll(rendered.children, (node) => node.__type === editors.ChainEditorField)
    expect(chainRows).toHaveLength(2)
    expect(chainRows[0].field).toBe('delegateCategoryChains')
    expect(chainRows[0].rows).toBeUndefined()
    expect(typeof chainRows[0].getSession).toBe('function')
    expect(chainRows[1].field).toBe('delegateAgentChains')
    expect(chainRows[1].rows).toBe(exports.CURATED_AGENT_NAMES)
    expect(chainRows[1].rowLabelPrefix).toBe('chainAgent_')
    expect(chainRows[1].panelHintKey).toBe('chainAgentPanelHint')
    // the disabled-categories editor over the parity-pinned category rows
    const disabledRow = findAll(rendered.children, (node) => node.__type === editors.DisabledCategoriesEditorField)
    expect(disabledRow).toHaveLength(1)
    expect(disabledRow[0].rows).toBe(exports.CATEGORY_NAMES)
    // the five robash list editors (master on + Windows env facts)
    const robashRows = findAll(rendered.children, (node) => node.__type === editors.RobashListEditorField)
    expect(robashRows.map((row) => row.field)).toEqual(['robashAllow', 'robashGitAllow', 'robashDeny', 'robashPwshAllow', 'robashPwshDeny'])
    // the Edit Lock maintenance panel as a child of the editLock switch
    const maintenance = findAll(rendered.children, (node) => node.__type === editors.EditLockMaintenanceField)
    expect(maintenance).toHaveLength(1)
    expect(rowKeys(cards, 'editing')).toContain('editLockMaintenance')
    // the LSP manager as a child of the lsp switch, fed the lspServers draft
    const manager = findAll(rendered.children, (node) => node.__type === editors.LspManagerField)
    expect(manager).toHaveLength(1)
    expect(manager[0].serversText).toBe('')
    expect(rowKeys(cards, 'lsp')).toEqual(['lspEnabled', 'lspIdleMs', 'lspRequestTimeoutMs', 'lspDiagnosticsWaitMs', 'lspServers', 'lspManager'])
    // the notify permission entry stays rendered (self-gating inside)
    const permissions = findAll(rendered.children, (node) => node.__type === editors.NotifyPermissionsField)
    expect(permissions).toHaveLength(1)
    // the model picker merged row inside its error boundary
    const boundaries = findAll(rendered.children, (node) => node.fallback !== undefined)
    expect(boundaries).toHaveLength(1)
    const boundaryInstance = new boundaries[0].__type(boundaries[0])
    expect(boundaryInstance.render()).toBe(boundaries[0].children)
    const pickerRow = boundaryInstance.props.children
    const picker = pickerRow.children[1].children[0]
    expect(picker.value).toEqual({ provider: '', model: '', reasoningEffort: '' })
    expect(typeof picker.onChange).toBe('function')
    expect(typeof picker.getSession).toBe('function')
    // the folded fields never render a row of their own
    expect(rowKeys(cards, 'intent')).not.toContain('intentGateModel')
    expect(rowKeys(cards, 'intent')).not.toContain('intentGateReasoningEffort')
  })

  it('renders the always-on restart tag exactly on the visible RESTART_FIELDS rows', async () => {
    const { exports, editors, primitivesStub } = await loadPage()
    const rendered = renderCard(exports, editors, {
      fields: makeFields(),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    // the value rows carry their tags eagerly in the label prop (the
    // ChoiceField component tree only materializes when invoked — covered
    // below): timeout + todo 4 + guard 2
    const tags = findAll(rendered.children, (node) => node.__type === primitivesStub.Tag && node.children === 'restartRequired')
    expect(tags).toHaveLength(7)
    expect(tags.every((tag) => tag.tone === 'neutral')).toBe(true)
    // no other Tag elements on the page (nothing overridden by default)
    const allTags = findAll(rendered.children, (node) => node.__type === primitivesStub.Tag)
    expect(allTags).toHaveLength(7)
    // choice rows: invoking the ChoiceField element materializes the tag
    const choiceRows = findAll(rendered.children, (node) => node.descriptor && node.field && typeof node.onChange === 'function')
    const choiceByName = Object.fromEntries(choiceRows.map((el) => [el.descriptor.field, el]))
    const choiceTag = (name) => findAll(choiceByName[name].__type(choiceByName[name]), (node) => node.__type === primitivesStub.Tag && node.children === 'restartRequired')
    expect(choiceTag('intentGateClassifier')).toHaveLength(1)
    expect(choiceTag('todoEnabled')).toHaveLength(1)
    expect(choiceTag('guardEnabled')).toHaveLength(1)
    expect(choiceTag('hashlineHideStockEdit')).toHaveLength(1)
    expect(choiceTag('editLockEnabled')).toHaveLength(1)
    // non-restart choice rows carry no tag
    expect(choiceTag('notifyEnabled')).toHaveLength(0)
    expect(choiceTag('worktreeEnabled')).toHaveLength(0)
    // with the picker row visible, its merged row carries the tag too
    const llm = renderCard(exports, editors, {
      fields: makeFields({ intentGateClassifier: { text: 'llm' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    const llmTags = findAll(llm.children, (node) => node.__type === primitivesStub.Tag && node.children === 'restartRequired')
    // value rows 7 + the picker carrier = 8
    expect(llmTags).toHaveLength(8)
  })

  it('renders the restart reminder as a centered modal when the state carries one', async () => {
    const { exports, editors } = await loadPage()
    const dismissals = []
    const rendered = renderCard(exports, editors, {
      fields: makeFields(),
      env: { status: 'ready', facts: { platform: 'darwin' } },
      restartReminder: ['todoEnabled', 'editLockEnabled'],
    }, { dismissRestartReminder: () => dismissals.push('dismiss') })
    // the modal trails the cards column
    expect(rendered.children).toHaveLength(2)
    const modal = rendered.children[1]
    expect(modal.key).toBe('restart-reminder')
    expect(modal.open).toBe(true)
    expect(modal.title).toBe('restartReminderTitle')
    expect(modal.description).toBe('restartReminderBody')
    expect(modal.closeLabel).toBe('restartReminderDismiss')
    modal.onClose()
    expect(dismissals).toEqual(['dismiss'])
    const tags = modal.children.children
    expect(tags.map((tag) => tag.children)).toEqual(['todoEnabled', 'editLockEnabled'])
    expect(tags.every((tag) => tag.tone === 'accent')).toBe(true)
    expect(modal.footer.variant).toBe('primary')
    expect(modal.footer.children).toBe('restartReminderAcknowledge')
    modal.footer.onClick()
    expect(dismissals).toEqual(['dismiss', 'dismiss'])
  })

  it('renders boolean rows via the shared effective-value helper and enum rows as segmented controls', async () => {
    const { exports, editors, primitivesStub } = await loadPage()
    const rendered = renderCard(exports, editors, {
      fields: makeFields(),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    // choice rows are component elements: invoke them to read the Switch /
    // SegmentedControl props (same pattern as the pre-overhaul suite)
    const choiceRows = findAll(rendered.children, (node) => node.descriptor && node.field && typeof node.onChange === 'function')
    const choiceByName = Object.fromEntries(choiceRows.map((el) => [el.descriptor.field, el]))
    const renderChoice = (name) => choiceByName[name].__type(choiceByName[name])
    const switchOf = (name) => findAll(renderChoice(name), (node) => node.__type === primitivesStub.Switch)[0]
    // product defaults through the SAME helper the conditions use:
    // todoEnabled on, editLockEnabled off (unset texts)
    expect(switchOf('todoEnabled').checked).toBe(true)
    expect(switchOf('editLockEnabled').checked).toBe(false)
    expect(switchOf('lspEnabled').checked).toBe(false)
    expect(switchOf('worktreeEnabled').checked).toBe(true)
    // a staged draft flips the display the same way it flips the conditions
    const drafted = renderCard(exports, editors, {
      fields: makeFields({ todoEnabled: { text: 'false' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    const draftedRow = findAll(drafted.children, (node) => node.descriptor?.field === 'todoEnabled')[0]
    expect(findAll(draftedRow.__type(draftedRow), (node) => node.__type === primitivesStub.Switch)[0].checked).toBe(false)
    // the enum row renders the segmented control with the dictionary options
    const segmented = findAll(renderChoice('intentGateClassifier'), (node) => node.__type === primitivesStub.SegmentedControl)
    const classifier = segmented.find((node) => node.label === 'intentGateClassifier')
    expect(classifier.value).toBe('regex')
    expect(classifier.options).toHaveLength(3)
  })

  it('mirrors the six late boolean product defaults in the map, the helper and the conditions', async () => {
    const { exports } = await loadPage()
    const { BOOLEAN_DEFAULTS, FIELDS, resolveEffectiveValue, evaluateCondition } = exports
    const descriptorByName = Object.fromEntries(FIELDS.map((descriptor) => [descriptor.field, descriptor]))
    for (const field of MIRRORED_ON_BOOLEANS) {
      expect(BOOLEAN_DEFAULTS[field], `${field} must be a true product default`).toBe(true)
      const descriptor = descriptorByName[field]
      expect(descriptor.kind, `${field} must be a boolean row`).toBe('boolean')
      // an unset text is the clear gesture → product default: ON, never "off"
      expect(resolveEffectiveValue(descriptor, { text: '' }, undefined), `${field} unset must resolve ON`).toBe(true)
      // the absent field face behaves like an unset text
      expect(resolveEffectiveValue(descriptor, undefined, undefined), `${field} absent must resolve ON`).toBe(true)
      // the `when` conditions read the SAME helper, so an untouched key is ON
      const resolve = {
        value: (key) => resolveEffectiveValue(descriptorByName[key], { text: '' }, undefined),
        env: () => undefined,
      }
      expect(evaluateCondition({ key: field, equals: true }, resolve), `${field} must satisfy when-enabled`).toBe(true)
    }
  })

  it('mirrors FIELD_DEFAULTS from the server schema and derives BOOLEAN_DEFAULTS from it', async () => {
    const { exports } = await loadPage()
    const { FIELD_DEFAULTS, BOOLEAN_DEFAULTS } = exports
    // the hand-maintained mirror of src/settings/sections.js FIELD_DEFAULTS:
    // exact key set + values, frozen (the settings-fields suite additionally
    // pins the literal text; here the loaded export is checked)
    expect(Object.isFrozen(FIELD_DEFAULTS)).toBe(true)
    expect(Object.keys(FIELD_DEFAULTS).sort()).toEqual(Object.keys(SERVER_FIELD_DEFAULTS).sort())
    expect(FIELD_DEFAULTS).toEqual(SERVER_FIELD_DEFAULTS)
    // BOOLEAN_DEFAULTS is the derived boolean subset — exactly the previous
    // hand-maintained literal (14 entries), never a second literal
    expect(BOOLEAN_DEFAULTS).toEqual({
      todoEnabled: true,
      guardEnabled: true,
      hashlineHideStockEdit: true,
      editLockEnabled: false,
      editLockAutoResume: true,
      editLockStaleSweep: true,
      worktreeEnabled: true,
      worktreeAutoSetup: true,
      robashEnabled: true,
      lspEnabled: false,
      notifyEnabled: true,
      notifyOnComplete: true,
      notifyOnAttention: true,
      notifySound: true,
    })
    const derived = Object.fromEntries(Object.entries(FIELD_DEFAULTS).filter(([, value]) => typeof value === 'boolean'))
    expect(BOOLEAN_DEFAULTS).toEqual(derived)
  })

  it('renders the product default as the displayed value of an unset field — without overriding or staging it', async () => {
    const { exports, editors, primitivesStub } = await loadPage()
    const fields = makeFields({ intentGateClassifier: { text: '' } })
    const rendered = renderCard(exports, editors, {
      fields,
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    const valueFields = findAll(rendered.children, (node) => node.__type === primitivesStub.SettingsValueField)
    const byId = Object.fromEntries(valueFields.map((el) => [el.id, el]))
    // number input: the formatted default is the displayed text, and the
    // field stays non-overridden with no invalid marking
    const timeout = byId['plugin-config-orrery-settings-intentGateTimeoutMs']
    expect(timeout.text).toBe('1500')
    expect(timeout.overridden).toBe(false)
    expect(timeout.invalid).toBe(false)
    // text input with a default
    expect(byId['plugin-config-orrery-settings-worktreeRoot'].text).toBe('.orrery/worktrees')
    // a field WITHOUT a default stays empty (displayText pure check: the
    // lspServers row is hidden under the off-by-default lspEnabled switch)
    expect(exports.displayText({ field: 'lspServers', kind: 'text' }, { text: '' })).toBe('')
    expect(exports.displayText({ field: 'intentGateTimeoutMs', kind: 'number' }, undefined)).toBe('1500')
    // the underlying form field is untouched: nothing staged, so the save
    // plan has no entry for it and it is never written unless edited
    expect(fields.intentGateTimeoutMs.text).toBe('')
    expect(fields.intentGateTimeoutMs.overridden).toBe(false)
    // enum SegmentedControl: the default is the selected segment when unset
    const choiceRows = findAll(rendered.children, (node) => node.descriptor && node.field && typeof node.onChange === 'function')
    const choiceByName = Object.fromEntries(choiceRows.map((el) => [el.descriptor.field, el]))
    const segmentedOf = (name) => findAll(choiceByName[name].__type(choiceByName[name]), (node) => node.__type === primitivesStub.SegmentedControl)[0]
    expect(segmentedOf('intentGateClassifier').value).toBe('regex')
    expect(segmentedOf('notifyForeground').value).toBe('skip')
  })

  it('staged drafts and saved values win over the default display; clearing re-shows it', async () => {
    const { exports, editors, primitivesStub } = await loadPage()
    const valueFieldProps = (fields, name) => {
      const rendered = renderCard(exports, editors, {
        fields,
        env: { status: 'ready', facts: { platform: 'darwin' } },
      })
      return findAll(rendered.children, (node) => node.__type === primitivesStub.SettingsValueField && node.id === `plugin-config-orrery-settings-${name}`)[0]
    }
    // a staged draft text wins
    expect(valueFieldProps(makeFields({ intentGateTimeoutMs: { text: '2500' } }), 'intentGateTimeoutMs').text).toBe('2500')
    // a saved value (arrives as the formatted resting text) wins over the default
    const saved = valueFieldProps(makeFields({ intentGateTimeoutMs: { text: '2000', overridden: true } }), 'intentGateTimeoutMs')
    expect(saved.text).toBe('2000')
    expect(saved.overridden).toBe(true)
    // an invalid draft is shown as-is (the form layer owns invalid marking)
    expect(valueFieldProps(makeFields({ intentGateTimeoutMs: { text: 'abc', invalid: true } }), 'intentGateTimeoutMs').text).toBe('abc')
    // cleared back to empty → the default reappears
    expect(valueFieldProps(makeFields({ intentGateTimeoutMs: { text: '' } }), 'intentGateTimeoutMs').text).toBe('1500')
    // enum: a staged/saved selection wins over the default segment
    const rendered = renderCard(exports, editors, {
      fields: makeFields({ intentGateClassifier: { text: 'llm' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    const choiceRow = findAll(rendered.children, (node) => node.descriptor?.field === 'intentGateClassifier')[0]
    expect(findAll(choiceRow.__type(choiceRow), (node) => node.__type === primitivesStub.SegmentedControl)[0].value).toBe('llm')
  })

  it('evaluates the classifier conditions against the regex product default when unset — same visible set as before', async () => {
    const { exports, editors } = await loadPage()
    const { evaluateCondition, resolveEffectiveValue, FIELDS } = exports
    const descriptorByName = Object.fromEntries(FIELDS.map((descriptor) => [descriptor.field, descriptor]))
    const resolve = {
      value: (key) => resolveEffectiveValue(descriptorByName[key], { text: '' }, undefined),
      env: () => undefined,
    }
    // unset resolves to the concrete 'regex' default, so both alternative-
    // classifier conditions are false — exactly the rows the old undefined-
    // driven behavior hid, now via a real value
    expect(resolveEffectiveValue(descriptorByName.intentGateClassifier, { text: '' }, undefined)).toBe('regex')
    expect(evaluateCondition({ key: 'intentGateClassifier', equals: 'llm' }, resolve)).toBe(false)
    expect(evaluateCondition({ key: 'intentGateClassifier', equals: 'jev' }, resolve)).toBe(false)
    expect(evaluateCondition({ key: 'intentGateClassifier', equals: 'regex' }, resolve)).toBe(true)
    const rendered = renderCard(exports, editors, {
      fields: makeFields({ intentGateClassifier: { text: '' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    expect(rowKeys(cardsOf(rendered), 'intent')).toEqual(['intentGateClassifier', 'intentGateTimeoutMs'])
  })

  it('renders the six mirrored switches ON with their children visible when the profile never saved them', async () => {
    const { exports, editors, primitivesStub } = await loadPage()
    const rendered = renderCard(exports, editors, {
      // editLockEnabled is a false product default, so its two late children
      // are staged into view; the whole notify family is ON with no staging
      fields: makeFields({ editLockEnabled: { text: 'true' } }),
      env: { status: 'ready', facts: { platform: 'darwin' } },
    })
    const choiceRows = findAll(rendered.children, (node) => node.descriptor && node.field && typeof node.onChange === 'function')
    const choiceByName = Object.fromEntries(choiceRows.map((el) => [el.descriptor.field, el]))
    const switchOf = (name) => findAll(choiceByName[name].__type(choiceByName[name]), (node) => node.__type === primitivesStub.Switch)[0]
    for (const field of MIRRORED_ON_BOOLEANS) {
      expect(choiceByName[field], `${field} must render a choice row`).toBeTruthy()
      expect(switchOf(field).checked, `${field} renders ON while unset`).toBe(true)
    }
    // the conditional-visibility engine agrees: the children are on screen
    const cards = cardsOf(rendered)
    expect(rowKeys(cards, 'notify')).toEqual(['notifyEnabled', 'notifyOnComplete', 'notifyMinTurnSeconds', 'notifyOnAttention', 'notifySound', 'notifyForeground', 'notifyPermissions'])
    expect(rowKeys(cards, 'editing')).toContain('editLockAutoResume')
    expect(rowKeys(cards, 'editing')).toContain('editLockStaleSweep')
  })

  it('renders the section as the nested item slot', async () => {
    const { exports } = await loadPage()
    const { OrrerySection } = exports
    const section = OrrerySection({ renderSlot: (slot) => slot })
    expect(section.children).toBe('settings.orrery.item')
  })

  // ---- pure export: evaluateCondition ----

  it('evaluateCondition: key/env predicates and all/any/not combinations', async () => {
    const { exports } = await loadPage()
    const { evaluateCondition } = exports
    const resolve = {
      value: (key) => ({ classifier: 'llm', enabled: true, count: 3 })[key],
      env: (name) => ({ platform: 'darwin' })[name],
    }
    expect(evaluateCondition({ key: 'classifier', equals: 'llm' }, resolve)).toBe(true)
    expect(evaluateCondition({ key: 'classifier', equals: 'jev' }, resolve)).toBe(false)
    expect(evaluateCondition({ key: 'enabled', equals: true }, resolve)).toBe(true)
    expect(evaluateCondition({ key: 'count', in: [1, 3, 5] }, resolve)).toBe(true)
    expect(evaluateCondition({ key: 'count', in: [1, 5] }, resolve)).toBe(false)
    expect(evaluateCondition({ env: 'platform', equals: 'darwin' }, resolve)).toBe(true)
    expect(evaluateCondition({ env: 'platform', in: ['win32'] }, resolve)).toBe(false)
    // strict membership: no coercion between types
    expect(evaluateCondition({ key: 'count', in: ['3'] }, resolve)).toBe(false)
    // combinations
    expect(evaluateCondition({ all: [{ key: 'enabled', equals: true }, { env: 'platform', in: ['darwin', 'linux'] }] }, resolve)).toBe(true)
    expect(evaluateCondition({ all: [{ key: 'enabled', equals: true }, { env: 'platform', equals: 'win32' }] }, resolve)).toBe(false)
    expect(evaluateCondition({ any: [{ key: 'classifier', equals: 'jev' }, { key: 'classifier', equals: 'llm' }] }, resolve)).toBe(true)
    expect(evaluateCondition({ not: { key: 'classifier', equals: 'jev' } }, resolve)).toBe(true)
    expect(evaluateCondition({ not: { all: [{ key: 'enabled', equals: true }] } }, resolve)).toBe(false)
    // unknown keys resolve undefined and never match (except an explicit equals: undefined)
    expect(evaluateCondition({ key: 'missing', equals: 'x' }, resolve)).toBe(false)
    expect(evaluateCondition({ key: 'missing', equals: undefined }, resolve)).toBe(true)
    // malformed nodes evaluate false (validateLayout is the loud gate)
    expect(evaluateCondition({}, resolve)).toBe(false)
    expect(evaluateCondition({ key: 'count' }, resolve)).toBe(false)
  })

  it('conditionUsesEnv: detects env references through combinators', async () => {
    const { exports } = await loadPage()
    const { conditionUsesEnv } = exports
    expect(conditionUsesEnv({ env: 'platform', equals: 'win32' })).toBe(true)
    expect(conditionUsesEnv({ key: 'a', equals: 1 })).toBe(false)
    expect(conditionUsesEnv({ all: [{ key: 'a', equals: 1 }, { env: 'platform', in: ['win32'] }] })).toBe(true)
    expect(conditionUsesEnv({ any: [{ key: 'a', equals: 1 }] })).toBe(false)
    expect(conditionUsesEnv({ not: { env: 'platform', equals: 'win32' } })).toBe(true)
  })

  // ---- pure export: resolveEffectiveValue (design D3) ----

  it('resolveEffectiveValue: parseable draft → saved value → product default', async () => {
    const { exports } = await loadPage()
    const { resolveEffectiveValue } = exports
    const boolean = { field: 'todoEnabled', kind: 'boolean' }
    const offBoolean = { field: 'editLockEnabled', kind: 'boolean' }
    const number = { field: 'todoMaxConsecutive', kind: 'number' }
    const text = { field: 'worktreeRoot', kind: 'text' }
    const enumField = { field: 'intentGateClassifier', kind: 'enum', values: ['regex', 'llm', 'jev'] }
    // parseable staged draft wins over the saved value
    expect(resolveEffectiveValue(boolean, { text: 'false' }, true)).toBe(false)
    expect(resolveEffectiveValue(number, { text: '12' }, 4)).toBe(12)
    expect(resolveEffectiveValue(enumField, { text: 'llm' }, 'regex')).toBe('llm')
    expect(resolveEffectiveValue(text, { text: 'custom/dir' }, 'old')).toBe('custom/dir')
    // empty draft is the clear gesture → product default
    expect(resolveEffectiveValue(boolean, { text: '' }, false)).toBe(true)
    expect(resolveEffectiveValue(offBoolean, { text: '' }, true)).toBe(false)
    expect(resolveEffectiveValue(number, { text: '' }, 4)).toBe(8)
    expect(resolveEffectiveValue(enumField, { text: '' }, 'llm')).toBe('regex')
    // unparseable draft falls back to the saved value (no visibility flicker)
    expect(resolveEffectiveValue(number, { text: 'abc' }, 4)).toBe(4)
    expect(resolveEffectiveValue(number, { text: 'abc' }, undefined)).toBe(8)
    expect(resolveEffectiveValue(boolean, { text: 'yes' }, true)).toBe(true)
    expect(resolveEffectiveValue(enumField, { text: 'nope' }, 'regex')).toBe('regex')
    // resting state: the text IS the formatted saved value
    expect(resolveEffectiveValue(number, { text: '4' }, undefined)).toBe(4)
    expect(resolveEffectiveValue(boolean, { text: 'true' }, undefined)).toBe(true)
    // never set: every kind takes its concrete product default (booleans
    // via the derived BOOLEAN_DEFAULTS subset)
    expect(resolveEffectiveValue(boolean, { text: '' }, undefined)).toBe(true)
    expect(resolveEffectiveValue(offBoolean, { text: '' }, undefined)).toBe(false)
    expect(resolveEffectiveValue(number, { text: '' }, undefined)).toBe(8)
    expect(resolveEffectiveValue(enumField, { text: '' }, undefined)).toBe('regex')
    expect(resolveEffectiveValue(text, { text: '' }, undefined)).toBe('.orrery/worktrees')
    // absent field face behaves like an unset text
    expect(resolveEffectiveValue(boolean, undefined, undefined)).toBe(true)
  })

  // ---- pure export: validateLayout (design D4, fail-loud) ----

  it('validateLayout: accepts the real GROUPS and rejects every illegal declaration with a named error', async () => {
    const { exports } = await loadPage()
    const { validateLayout, GROUPS } = exports
    validateLayout(GROUPS) // does not throw
    const expectLayoutError = (groups, pattern) => {
      let thrown = null
      try {
        validateLayout(groups)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeTruthy()
      expect(thrown.name).toBe('SettingsLayoutError')
      expect(thrown.message).toContain(pattern)
    }
    // unknown parent
    expectLayoutError([{ id: 'g', fields: [{ field: 'a', kind: 'text' }, { field: 'b', kind: 'text', parent: 'zzz' }] }], `unknown parent 'zzz'`)
    // the error names the offending row
    expectLayoutError([{ id: 'g', fields: [{ field: 'a', kind: 'text' }, { field: 'b', kind: 'text', parent: 'zzz' }] }], `'b'`)
    // cross-group parent
    expectLayoutError([
      { id: 'g1', fields: [{ field: 'a', kind: 'text' }] },
      { id: 'g2', fields: [{ field: 'b', kind: 'text', parent: 'a' }] },
    ], `cross-group parent 'a'`)
    // parent cycle
    expectLayoutError([{ id: 'g', fields: [
      { field: 'a', kind: 'text', parent: 'b' },
      { field: 'b', kind: 'text', parent: 'a' },
    ] }], 'parent cycle')
    // self-parent cycle
    expectLayoutError([{ id: 'g', fields: [{ field: 'a', kind: 'text', parent: 'a' }] }], 'parent cycle')
    // condition on an unknown settings key
    expectLayoutError([{ id: 'g', fields: [{ field: 'a', kind: 'text', when: { key: 'zzz', equals: 1 } }] }], `unknown key 'zzz'`)
    // condition on an unknown env fact
    expectLayoutError([{ id: 'g', fields: [{ field: 'a', kind: 'text', when: { env: 'os', equals: 'x' } }] }], `unknown env fact 'os'`)
    // malformed conditions: two branches, missing predicate, empty all
    expectLayoutError([{ id: 'g', fields: [
      { field: 'a', kind: 'text' },
      { field: 'b', kind: 'text', when: { key: 'a', equals: 1, not: { key: 'a', equals: 2 } } },
    ] }], 'malformed condition')
    expectLayoutError([{ id: 'g', fields: [
      { field: 'a', kind: 'text' },
      { field: 'b', kind: 'text', when: { key: 'a' } },
    ] }], 'exactly one of equals/in')
    expectLayoutError([{ id: 'g', fields: [
      { field: 'a', kind: 'text' },
      { field: 'b', kind: 'text', when: { all: [] } },
    ] }], `empty 'all' condition`)
    // duplicate field
    expectLayoutError([{ id: 'g', fields: [{ field: 'a', kind: 'text' }, { field: 'a', kind: 'number' }] }], `duplicate field 'a'`)
    // conditions may reference keys of other groups (existence only)
    validateLayout([
      { id: 'g1', fields: [{ field: 'a', kind: 'text' }] },
      { id: 'g2', fields: [{ field: 'b', kind: 'text', when: { key: 'a', equals: 'x' } }] },
    ]) // does not throw
  })

  // ---- pure export: buildLayout (design D4) ----

  it('buildLayout: children nest under their parent regardless of declaration order, with depth', async () => {
    const { exports } = await loadPage()
    const { buildLayout } = exports
    const [layout] = buildLayout([{ id: 'g', fields: [
      { field: 'grandchild', kind: 'text', parent: 'child' },
      { field: 'root', kind: 'text' },
      { field: 'child2', kind: 'text', parent: 'root' },
      { field: 'child', kind: 'text', parent: 'root' },
      { field: 'other', kind: 'text' },
    ] }])
    // roots keep declaration order; children follow declaration order within
    // their parent
    expect(layout.roots.map((node) => node.field)).toEqual(['root', 'other'])
    const root = layout.roots[0]
    expect(root.depth).toBe(0)
    expect(root.children.map((node) => node.field)).toEqual(['child2', 'child'])
    expect(root.children.every((node) => node.depth === 1)).toBe(true)
    const child = root.children[1]
    expect(child.children.map((node) => node.field)).toEqual(['grandchild'])
    expect(child.children[0].depth).toBe(2)
    // DFS flatten: the grandchild renders inside its parent's subtree
    const flat = []
    const walk = (node) => {
      flat.push(`${node.field}@${node.depth}`)
      for (const next of node.children) walk(next)
    }
    for (const node of layout.roots) walk(node)
    expect(flat).toEqual(['root@0', 'child2@1', 'child@1', 'grandchild@2', 'other@0'])
  })

  it('the real LAYOUT nests the declared sub-settings (two-level notify case included)', async () => {
    const { exports } = await loadPage()
    const byId = Object.fromEntries(exports.LAYOUT.map((group) => [group.id, group]))
    const flatten = (group) => {
      const flat = []
      const walk = (node) => {
        flat.push({ key: node.field ?? node.slot, depth: node.depth })
        for (const child of node.children) walk(child)
      }
      for (const root of group.roots) walk(root)
      return flat
    }
    const notify = flatten(byId.notify)
    expect(notify.find((row) => row.key === 'notifyMinTurnSeconds').depth).toBe(2)
    expect(notify.find((row) => row.key === 'notifyOnComplete').depth).toBe(1)
    expect(notify.find((row) => row.key === 'notifyPermissions').depth).toBe(0)
    // the min-turn row sits directly inside its parent's subtree
    expect(notify.indexOf(notify.find((row) => row.key === 'notifyMinTurnSeconds')))
      .toBe(notify.indexOf(notify.find((row) => row.key === 'notifyOnComplete')) + 1)
    const editing = flatten(byId.editing)
    expect(editing.find((row) => row.key === 'editLockMaintenance').depth).toBe(1)
  })

  // ---- controller: inject face, env fetch, save flow ----

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
    const controller = new OrreryCardController(scope, { settingsBus, getSession, fetchEnv: () => new Promise(() => {}) })

    // the form model tracks the flat FIELDS spec list (custom rows naming a
    // field — chains, robash lists, the picker carrier — are text-backed)
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
    await flush()
    expect(notifications).toEqual(['bump'])

    controller.dispose()
  })

  it('controller: env fetch resolves to ready facts and re-projects; failure degrades to failed with one warning', async () => {
    const { exports } = await loadPage()
    const settingsBus = { subscribe: () => () => {}, notify: () => {} }
    // pending until the fetch settles
    let settleEnv
    const envPromise = new Promise((resolve) => { settleEnv = resolve })
    const pendingController = new exports.OrreryCardController({ ns: 'orrery-settings' }, { settingsBus, getSession: () => ({}), fetchEnv: () => envPromise })
    expect(pendingController.env).toEqual({ status: 'pending', facts: {} })
    expect(pendingController.projection().env.status).toBe('pending')
    settleEnv({ platform: 'darwin' })
    await flush()
    expect(pendingController.env).toEqual({ status: 'ready', facts: { platform: 'darwin' } })
    expect(pendingController.form.publishCount).toBe(1)
    pendingController.dispose()

    // failed: env failed, one console.warn total across controllers
    const warns = []
    const originalWarn = console.warn
    console.warn = (message) => warns.push(message)
    try {
      const failedOne = new exports.OrreryCardController({ ns: 'orrery-settings' }, { settingsBus, getSession: () => ({}), fetchEnv: () => Promise.reject(new Error('endpoint down')) })
      const failedTwo = new exports.OrreryCardController({ ns: 'orrery-settings' }, { settingsBus, getSession: () => ({}), fetchEnv: () => Promise.reject(new Error('endpoint down')) })
      await flush()
      expect(failedOne.env.status).toBe('failed')
      expect(failedTwo.env.status).toBe('failed')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toContain('endpoint down')
      failedOne.dispose()
      failedTwo.dispose()
    } finally {
      console.warn = originalWarn
    }
  })

  // Save-flow controller tests: the stub SettingsFormModel is driven through
  // planItems / saveResult / shellState / save overrides; publish() is a
  // counter (the real model re-notifies bound stores from it).
  async function makeController() {
    const { exports } = await loadPage()
    const notifications = []
    const settingsBus = { subscribe: () => () => {}, notify: () => notifications.push('bump') }
    const controller = new exports.OrreryCardController({ ns: 'orrery-settings' }, { settingsBus, getSession: () => ({}), fetchEnv: () => new Promise(() => {}) })
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
    await flush()
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
    // The client keeps the restart-required keys in ONE exported constant —
    // the same list driving both the post-save modal and the always-on
    // inline tag; the server schema (RESTART_KEYS, derived from the FIELDS
    // restart markers in src/settings/sections.js) is the authority.
    expect(exports.RESTART_FIELDS).toEqual([...RESTART_KEYS])
  })

  it('resolves a label and a hint for every form field in both dictionaries — never the raw key', async () => {
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
      for (const descriptor of exports.FIELDS) {
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
      // the restart reminder banner's own keys resolve too, plus the
      // always-on inline restart tag's key
      for (const key of ['restartReminderTitle', 'restartReminderBody', 'restartReminderDismiss', 'restartRequired']) {
        expectResolved(dict, key)
      }
      // the disabled-categories editor's own panel keys resolve too
      for (const key of ['disabledCategoriesCount', 'disabledCategoriesPanelHint', 'disabledCategoriesInvalid']) {
        expectResolved(dict, key)
      }
    }
  })
})
