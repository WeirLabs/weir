import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.edit-lock-maintenance.js chunk test: shared helper +
 * hook-state-preserving react stub + fetch stub (client-lsp-panel pattern).
 * The panel is the profile-wide switch status plus read-only inspection; the
 * tests pin the read-only contract (no inputs, no mutation payloads) and the
 * saved-vs-mounted state rendering.
 */

const STATUS = {
  saved: true,
  mounted: true,
  pinned: false,
  state: 'enforced',
  scope: 'profile',
  restartRequired: false,
  blocked: [],
  domains: [{ root: '/work/repo', hasAuthority: true, reservation: false, mode: 'publisher', error: null }],
}

const INSPECT = {
  root: '/work/repo',
  authorityDir: '/work/repo/.weir/edit-lock',
  reservation: false,
  endpoint: { path: '/tmp/weir-edit-lock-x.sock', exists: true },
  presence: 'valid',
  snapshot: {
    version: 4,
    revision: 12,
    counts: { sessions: 1, locks: 1, operations: 1, unresolved: 1, retainedLocks: 1 },
    unresolved: [{
      phase: 'unknown',
      outcome: 'unknown',
      scope: { kind: 'file', path: '/work/repo/a.txt' },
      fence: { kind: 'resource', resourceId: '/work/repo/a.txt' },
      target: { tool: 'write', filePath: '/work/repo/a.txt' },
      origin: { executionEpoch: 17, managerIncarnation: 'm' },
      closeouts: 0,
      key: { sessionId: 'sess-1', operationId: 'op-1' },
    }],
    retainedLocks: [{ resourceId: '/work/repo/a.txt', owner: 'sess-1', generation: 3, status: 'user-interrupted', reason: null }],
    sessions: [{ sessionId: 'sess-1', executionEpoch: 17, interrupted: true, recovery: null }],
  },
}

// Render descendants lazily, matching React's boundary traversal order. Parent
// evaluation is deliberately outside the boundary's try/catch.
function renderTree(node) {
  if (Array.isArray(node)) return node.map(renderTree)
  if (!node || typeof node !== 'object') return node
  if (typeof node.__type === 'function') {
    if (node.__type.prototype?.render) {
      const instance = new node.__type(node)
      try { return renderTree(instance.render()) }
      catch (error) {
        if (!node.__type.getDerivedStateFromError) throw error
        instance.state = node.__type.getDerivedStateFromError(error)
        return renderTree(instance.render())
      }
    }
    return renderTree(node.__type(node))
  }
  return { ...node, children: renderTree(node.children) }
}
/** Depth-first collector over the jsx-stub node tree (arrays included). */
function collect(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  collect(node.children, predicate, found)
  return found
}

describe('client.edit-lock-maintenance chunk', () => {
  async function loadPanel() {
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
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.edit-lock-maintenance.js', requireStub)
    return { definition, exports, reactStub }
  }

  it('loads, renders the switch state and domains, inspects read-only, and degrades on errors', async () => {
    const { definition, exports, reactStub } = await loadPanel()
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.edit-lock-maintenance.js')
    const { EditLockMaintenanceField } = exports
    expect(typeof EditLockMaintenanceField).toBe('function')

    const fetchCalls = []
    let statusPayload = { ok: true, value: STATUS }
    let inspectPayload = { ok: true, value: INSPECT }
    const fetchStub = (url, init) => {
      fetchCalls.push({ url, init })
      if (url === 'api/weir-edit-lock/maintenance/status') return Promise.resolve({ json: async () => statusPayload })
      if (url === 'api/weir-edit-lock/maintenance/inspect') return Promise.resolve({ json: async () => inspectPayload })
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchStub
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const props = { t: (key) => key }
    const render = () => {
      reactStub.begin()
      return renderTree(EditLockMaintenanceField(props))
    }

    try {
      // closed: the toggle row, no fetch, no inputs anywhere
      const initial = render()
      expect(initial.children[0].children[1].children).toBe('chainEdit')
      expect(fetchCalls).toHaveLength(0)
      expect(collect(initial, (node) => node.__type === 'input')).toHaveLength(0)

      // open → status loads with a read-only POST (no body, session credentials)
      initial.children[0].children[1].onClick()
      await flush()
      const opened = render()
      expect(fetchCalls[0].url).toBe('api/weir-edit-lock/maintenance/status')
      expect(fetchCalls[0].init.method).toBe('POST')
      expect(fetchCalls[0].init.credentials).toBe('include')
      expect(fetchCalls[0].init.body).toBeUndefined()
      const tree = opened
      // the enforced banner, its evidence-based hint, the profile scope note,
      // and both standing warnings
      expect(collect(tree, (node) => node.children === 'editLockMaintStateEnforced')).toHaveLength(1)
      expect(collect(tree, (node) => node.children === 'editLockMaintStateEnforcedHint')).toHaveLength(1)
      expect(collect(tree, (node) => node.children === 'editLockMaintScopeNote')).toHaveLength(1)
      expect(collect(tree, (node) => node.children === 'editLockMaintWarnKeepHistory')).toHaveLength(1)
      expect(collect(tree, (node) => node.children === 'editLockMaintWarnUnlock')).toHaveLength(1)
      // no restart banner while saved and mounted agree
      expect(collect(tree, (node) => node.children === 'editLockMaintRestart')).toHaveLength(0)
      // the domain row offers Inspect, never a path input
      expect(collect(tree, (node) => node.children === '/work/repo').length).toBeGreaterThan(0)
      const inspectButtons = collect(tree, (node) => node.children === 'editLockMaintInspect' && typeof node.onClick === 'function')
      expect(inspectButtons).toHaveLength(1)
      expect(collect(tree, (node) => node.__type === 'input')).toHaveLength(0)

      // inspect → a POST carrying only the server-listed root
      inspectButtons[0].onClick()
      await flush()
      const inspected = render()
      expect(fetchCalls[1].url).toBe('api/weir-edit-lock/maintenance/inspect')
      expect(JSON.parse(fetchCalls[1].init.body)).toEqual({ root: '/work/repo' })
      // unresolved operation: its scope in user terms, then the technical detail
      expect(collect(inspected, (node) => typeof node.children === 'string' && node.children.startsWith('editLockMaintScopeFile')).length).toBeGreaterThan(0)
      expect(collect(inspected, (node) => node.children === 'write /work/repo/a.txt · unknown/unknown')).toHaveLength(1)
      expect(collect(inspected, (node) => node.children === 'sess-1 · op-1 · epoch 17')).toHaveLength(1)
      expect(collect(inspected, (node) => node.children === '/work/repo/a.txt · sess-1 · user-interrupted · gen 3')).toHaveLength(1)
      expect(collect(inspected, (node) => node.children === 'editLockMaintUnresolved')).toHaveLength(1)

      // divergence state: saved off while mounted → the restart banner appears
      statusPayload = { ok: true, value: { ...STATUS, saved: false, state: 'disable-requested', restartRequired: true } }
      const refresh = collect(inspected, (node) => node.children === 'editLockMaintRefresh' && typeof node.onClick === 'function')
      expect(refresh).toHaveLength(1)
      refresh[0].onClick()
      await flush()
      const diverged = render()
      expect(collect(diverged, (node) => node.children === 'editLockMaintStateDisableRequested')).toHaveLength(1)
      expect(collect(diverged, (node) => node.children === 'editLockMaintRestart')).toHaveLength(1)

      // unknown: no mount evidence → never claims enforcement from the saved value
      statusPayload = { ok: true, value: { ...STATUS, mounted: null, state: 'unknown' } }
      collect(diverged, (node) => node.children === 'editLockMaintRefresh' && typeof node.onClick === 'function')[0].onClick()
      await flush()
      const unknown = render()
      expect(collect(unknown, (node) => node.children === 'editLockMaintStateUnknown')).toHaveLength(1)
      expect(collect(unknown, (node) => node.children === 'editLockMaintStateEnforced')).toHaveLength(0)

      // a corrupt authority renders the visible-corruption copy with the refusal
      inspectPayload = { ok: true, value: { ...INSPECT, presence: 'corrupt', message: 'invalid snapshot checksum' } }
      const domainRow = collect(unknown, (node) => node.key === '/work/repo')[0]
      domainRow.children[0].children[1].onClick()
      await flush()
      const corrupt = render()
      expect(collect(corrupt, (node) => typeof node.children === 'string' && node.children.includes('editLockMaintPresenceCorrupt') && node.children.includes('invalid snapshot checksum'))).toHaveLength(1)

      // status fetch failure → inline error with retry
      globalThis.fetch = () => Promise.reject(new Error('down'))
      collect(corrupt, (node) => node.children === 'editLockMaintRefresh' && typeof node.onClick === 'function')[0].onClick()
      await flush()
      await flush()
      // the failed load leaves the panel in its inline error state
      const errored = render()
      expect(collect(errored, (node) => typeof node.children === 'string' && node.children.includes('editLockMaintUnavailable') && node.children.includes('down')).length).toBeGreaterThan(0)
      expect(collect(errored, (node) => node.children === 'editLockMaintRetry').length).toBeGreaterThan(0)

      // A successful HTTP envelope can still contain malformed rendering data.
      // It must fail INSIDE the boundary, leaving the settings toggle available.
      globalThis.fetch = fetchStub
      statusPayload = { ok: true, value: { ...STATUS, domains: {} } }
      collect(errored, (node) => node.children === 'editLockMaintRetry')[0].onClick()
      await flush()
      const malformed = render()
      expect(collect(malformed, (node) => node.children === 'editLockMaintFailed')).toHaveLength(1)
      expect(collect(malformed, (node) => node.children === 'chainCancel')).toHaveLength(1)
      // the boundary isolates rendering failures from the settings page
      const Boundary = exports.EditLockMaintenanceBoundary
      const boundaryInstance = new Boundary({ t: (key) => key, children: 'inner' })
      expect(boundaryInstance.render()).toBe('inner')
      Boundary.getDerivedStateFromError()
      const failedBoundary = new Boundary({ t: (key) => key, children: 'inner' })
      failedBoundary.state = { failed: true }
      expect(failedBoundary.render().children).toBe('editLockMaintFailed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('resolves every panel key in both entry dictionaries — never the raw key', async () => {
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
    const { en, zh } = registrations[0].dicts
    const KEYS = [
      'editLockMaint', 'editLockMaintHint', 'editLockMaintFailed', 'editLockMaintLoading', 'editLockMaintUnavailable',
      'editLockMaintRetry', 'editLockMaintRefresh', 'editLockMaintInspect',
      'editLockMaintStateEnforced', 'editLockMaintStateEnforcedHint',
      'editLockMaintStateDisableRequested', 'editLockMaintStateDisableRequestedHint',
      'editLockMaintStateEnableRequested', 'editLockMaintStateEnableRequestedHint',
      'editLockMaintStateDisabled', 'editLockMaintStateDisabledHint',
      'editLockMaintStateUnknown', 'editLockMaintStateUnknownHint',
      'editLockMaintRestart', 'editLockMaintPinned', 'editLockMaintScopeNote',
      'editLockMaintWarnKeepHistory', 'editLockMaintWarnUnlock',
      'editLockMaintBlocked', 'editLockMaintDomains', 'editLockMaintNoDomains',
      'editLockMaintAuthorityYes', 'editLockMaintAuthorityNo', 'editLockMaintReservation',
      'editLockMaintPresenceNone', 'editLockMaintPresenceEmpty', 'editLockMaintPresenceJunk',
      'editLockMaintPresenceNotAFile', 'editLockMaintPresenceCorrupt', 'editLockMaintPresenceUnreadable',
      'editLockMaintCounts', 'editLockMaintUnresolved', 'editLockMaintUnresolvedNone', 'editLockMaintRetained',
      'editLockMaintScopeFile', 'editLockMaintScopeSubtree', 'editLockMaintScopeDomain', 'editLockMaintScopeNone',
      'editLockMaintRecoveries', 'editLockMaintRecoverHint', 'editLockMaintRecoverRoot', 'editLockMaintRecoverOwner',
      'editLockMaintRecoverRevision', 'editLockMaintRecoverOperations', 'editLockMaintRecoverRisk', 'editLockMaintRecoverDigest',
      'editLockMaintRecoverConfirm', 'editLockMaintRecoverBusy', 'editLockMaintRecoverDone', 'editLockMaintRecoverFailed',
    ]
    for (const key of KEYS) {
      expect(typeof en[key], `en.${key}`).toBe('string')
      expect(en[key].length).toBeGreaterThan(0)
      expect(typeof zh[key], `zh.${key}`).toBe('string')
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })

  it('computes and displays the scope, risk and digest per eligible owner; the click submits the confirmation', async () => {
    const { exports, reactStub } = await loadPanel()
    const { EditLockMaintenanceField, editLockRecovery } = exports
    const eligible = {
      ...INSPECT,
      snapshot: {
        ...INSPECT.snapshot,
        unresolved: [
          { ...INSPECT.snapshot.unresolved[0], admissionBlocked: true },
          // Already dispositioned: not eligible.
          { ...INSPECT.snapshot.unresolved[0], admissionBlocked: false, key: { sessionId: 'sess-2', operationId: 'op-2' } },
          // Owner not interrupted: not eligible.
          { ...INSPECT.snapshot.unresolved[0], admissionBlocked: true, key: { sessionId: 'sess-3', operationId: 'op-3' } },
        ],
        sessions: [
          { sessionId: 'sess-1', executionEpoch: 17, interrupted: true, recovery: null },
          { sessionId: 'sess-2', executionEpoch: 3, interrupted: true, recovery: null },
          { sessionId: 'sess-3', executionEpoch: 4, interrupted: false, recovery: null },
        ],
      },
    }
    const expectedConfirmation = editLockRecovery.recoveryConfirmation({ root: '/work/repo', owner: 'sess-1', expectedRevision: 12, operationIds: ['op-1'] })
    const fetchCalls = []
    let recoverPayload = { ok: true, value: { revision: 13, idempotent: false, record: { owner: 'sess-1' } } }
    const fetchStub = (url, init) => {
      fetchCalls.push({ url, init })
      if (url === 'api/weir-edit-lock/maintenance/status') return Promise.resolve({ json: async () => ({ ok: true, value: STATUS }) })
      if (url === 'api/weir-edit-lock/maintenance/inspect') return Promise.resolve({ json: async () => ({ ok: true, value: eligible }) })
      if (url === 'api/weir-edit-lock/maintenance/recover-online') return Promise.resolve({ json: async () => recoverPayload })
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchStub
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const props = { t: (key) => key }
    const render = () => {
      reactStub.begin()
      return renderTree(EditLockMaintenanceField(props))
    }
    try {
      const initial = render()
      initial.children[0].children[1].onClick()
      await flush()
      const opened = render()
      collect(opened, (node) => node.children === 'editLockMaintInspect' && typeof node.onClick === 'function')[0].onClick()
      await flush()
      const inspected = render()
      // Exactly one eligible owner card: the full scope, the risk verbatim,
      // the client-computed digest. The other two owners render no action.
      expect(collect(inspected, (node) => node.children === 'editLockMaintRecoveries')).toHaveLength(1)
      // The blocked zone card (auto-inspection) and the expanded detail card
      // both display the same scope/risk/digest — two surfaces, one action.
      expect(collect(inspected, (node) => node.children === `editLockMaintRecoverDigest: ${expectedConfirmation}`)).toHaveLength(2)
      expect(collect(inspected, (node) => node.children === 'editLockMaintRecoverRisk: Detached historic writers may still modify files after this override.')).toHaveLength(2)
      expect(collect(inspected, (node) => node.children === 'editLockMaintRecoverOwner: sess-1')).toHaveLength(2)
      expect(collect(inspected, (node) => node.children === 'editLockMaintRecoverRevision: 12')).toHaveLength(2)
      expect(collect(inspected, (node) => node.children === 'op-1').length).toBeGreaterThan(0)
      expect(collect(inspected, (node) => typeof node.children === 'string' && node.children.includes('sess-2') && node.children.includes('Recover'))).toHaveLength(0)
      const confirm = collect(inspected, (node) => node.children === 'editLockMaintRecoverConfirm' && typeof node.onClick === 'function')
      expect(confirm).toHaveLength(1)
      // The one explicit click submits the computed confirmation — no typing.
      confirm[0].onClick()
      await flush()
      await flush()
      const call = fetchCalls.find((entry) => entry.url === 'api/weir-edit-lock/maintenance/recover-online')
      const body = JSON.parse(call.init.body)
      expect(body.root).toBe('/work/repo')
      expect(body.owner).toBe('sess-1')
      expect(body.expectedRevision).toBe(12)
      expect(body.operationIds).toEqual(['op-1'])
      expect(typeof body.recoveryId).toBe('string')
      expect(body.recoveryId.length).toBeGreaterThan(0)
      expect(body.acceptLateWriterRisk).toBe(true)
      expect(typeof body.reason).toBe('string')
      expect(body.confirmation).toBe(expectedConfirmation)
      const settled = render()
      expect(collect(settled, (node) => node.children === 'editLockMaintRecoverDone'.replace('{revision}', '13'))).toHaveLength(1)
      // The panel re-inspected after the settle: the scope reloads. Three
      // inspection calls total: the automatic one on open, the manual expand,
      // and the post-settle reload.
      expect(fetchCalls.filter((entry) => entry.url === 'api/weir-edit-lock/maintenance/inspect').length).toBe(3)
      // A refusal is shown next to the reloaded scope, with the server's detail.
      recoverPayload = { ok: false, error: { code: 'weir-edit-lock/revision-conflict', message: 'Recovery not acknowledged.', detail: 'Authority revision changed; inspect and confirm again.' } }
      collect(settled, (node) => node.children === 'editLockMaintRecoverConfirm' && typeof node.onClick === 'function')[0].onClick()
      await flush()
      await flush()
      const refused = render()
      // The refusal surfaces in both the zone card and the expanded detail card.
      expect(collect(refused, (node) => node.children === 'editLockMaintRecoverFailed Authority revision changed; inspect and confirm again.')).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('scopes recovery state per root and owner: one root\'s settle never disables another root\'s action', async () => {
    const { exports, reactStub } = await loadPanel()
    const { EditLockMaintenanceField } = exports
    const STATUS_TWO = { ...STATUS, domains: [
      { root: '/work/repo', hasAuthority: true, reservation: false, mode: 'publisher', error: null },
      { root: '/work/other', hasAuthority: true, reservation: false, mode: 'publisher', error: null },
    ] }
    const eligibleFor = (root) => ({
      root,
      authorityDir: `${root}/.weir/edit-lock`,
      reservation: false,
      endpoint: { path: '/tmp/x.sock', exists: true },
      presence: 'valid',
      snapshot: {
        version: 4, revision: 12,
        counts: { sessions: 1, locks: 1, operations: 1, unresolved: 1, retainedLocks: 1 },
        unresolved: [{ ...INSPECT.snapshot.unresolved[0], admissionBlocked: true }],
        prepared: [],
        retainedLocks: INSPECT.snapshot.retainedLocks,
        sessions: [{ sessionId: 'sess-1', executionEpoch: 17, interrupted: true, recovery: null }],
      },
    })
    const recoverPayload = { ok: true, value: { revision: 13, idempotent: false, record: { owner: 'sess-1' } } }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (url, init) => {
      if (url === 'api/weir-edit-lock/maintenance/status') return Promise.resolve({ json: async () => ({ ok: true, value: STATUS_TWO }) })
      if (url === 'api/weir-edit-lock/maintenance/inspect') {
        const root = JSON.parse(init.body).root
        return Promise.resolve({ json: async () => ({ ok: true, value: eligibleFor(root) }) })
      }
      if (url === 'api/weir-edit-lock/maintenance/recover-online') return Promise.resolve({ json: async () => recoverPayload })
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    }
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const props = { t: (key) => key }
    const render = () => { reactStub.begin(); return renderTree(EditLockMaintenanceField(props)) }
    const confirms = (tree) => collect(tree, (node) => node.children === 'editLockMaintRecoverConfirm' && typeof node.onClick === 'function')
    const inspects = (tree) => collect(tree, (node) => node.children === 'editLockMaintInspect' && typeof node.onClick === 'function')
    const doneText = (tree) => collect(tree, (node) => node.children === 'editLockMaintRecoverDone'.replace('{revision}', '13'))
    try {
      render().children[0].children[1].onClick()
      await flush()
      // Root A: inspect, recover, settle — done shows under A.
      inspects(render())[0].onClick()
      await flush()
      confirms(render())[0].onClick()
      await flush()
      await flush()
      expect(doneText(render())).toHaveLength(1)
      // Root B carries the SAME owner id and still needs its recovery: no done,
      // and its confirm stays enabled. (A's section collapses; only B renders.)
      inspects(render()).at(-1).onClick()
      await flush()
      const treeB = render()
      expect(doneText(treeB)).toHaveLength(0)
      const confirmB = confirms(treeB)
      expect(confirmB).toHaveLength(1)
      expect(confirmB[0].disabled === true).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('chunk confirmation algorithm matches the server byte-for-byte, and eligibility mirrors the manager', async () => {
    const { exports } = await loadPanel()
    const { editLockRecovery } = exports
    const { recoveryConfirmation: serverConfirmation } = await import('../src/edit-lock/admin-recovery.js')
    const { canonical } = await import('../src/edit-lock/snapshot.js')
    const { LATE_WRITER_RISK } = await import('../src/edit-lock/admin-ledger.js')
    const { createHash } = await import('node:crypto')
    expect(editLockRecovery.LATE_WRITER_RISK).toBe(LATE_WRITER_RISK)
    const texts = ['', 'a', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'w'.repeat(119), 'q'.repeat(1000),
      '管理域/编辑锁 ✓', JSON.stringify({ envelope: [1, '中文', { nested: true }] })]
    for (const text of texts) {
      expect(editLockRecovery.sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    }
    const scopes = [
      { root: '/work/repo', owner: 'sess-1', expectedRevision: 0, operationIds: ['op-1'] },
      { root: '/work/中文 目录', owner: '会话-九', expectedRevision: 42, operationIds: ['op-长', 'op-2', 'op-10', 'a'.repeat(200)] },
      { root: '/r', owner: 'o', expectedRevision: 999999, operationIds: ['z', 'y', 'x', 'w'] },
    ]
    for (const scope of scopes) {
      const sorted = { ...scope, operationIds: [...scope.operationIds].sort() }
      expect(editLockRecovery.canonicalJson({ ...sorted, risk: LATE_WRITER_RISK })).toBe(canonical({ ...sorted, risk: LATE_WRITER_RISK }))
      expect(editLockRecovery.recoveryConfirmation(scope)).toBe(serverConfirmation(scope))
    }
    // Eligibility mirrors the manager's admission conditions exactly:
    // interrupted owner, every unresolved operation a still-blocking unknown.
    const candidates = editLockRecovery.recoveryCandidates('/work/repo', {
      revision: 7,
      sessions: [
        { sessionId: 'a', interrupted: true }, { sessionId: 'b', interrupted: false },
        { sessionId: 'c', interrupted: true }, { sessionId: 'd', interrupted: true },
        { sessionId: 'e', interrupted: true },
      ],
      unresolved: [
        { phase: 'unknown', admissionBlocked: true, key: { sessionId: 'a', operationId: 'op-2' } },
        { phase: 'unknown', admissionBlocked: true, key: { sessionId: 'a', operationId: 'op-1' } },
        { phase: 'unknown', admissionBlocked: true, key: { sessionId: 'b', operationId: 'op-3' } },
        { phase: 'publishing', admissionBlocked: true, key: { sessionId: 'c', operationId: 'op-4' } },
        { phase: 'unknown', admissionBlocked: false, key: { sessionId: 'd', operationId: 'op-5' } },
        { phase: 'unknown', admissionBlocked: true, key: { sessionId: 'e', operationId: 'op-6' } },
      ],
      // 'e' is otherwise eligible but still holds a prepared operation: the
      // online recovery can never succeed for it, so the panel must not offer it.
      prepared: [{ target: { tool: 'write', filePath: '/w/e.txt' }, key: { sessionId: 'e', operationId: 'op-7' } }],
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].owner).toBe('a')
    expect(candidates[0].scope).toEqual({ root: '/work/repo', owner: 'a', expectedRevision: 7, operationIds: ['op-1', 'op-2'] })
    expect(candidates[0].confirmation).toBe(serverConfirmation(candidates[0].scope))
  })

  it('recoveryDiagnosis classifies the blocked rows, the force-release scope and every named failing precondition', async () => {
    const { exports } = await loadPanel()
    const { editLockRecovery } = exports
    const snapshot = {
      revision: 7,
      sessions: [
        { sessionId: 'a', interrupted: true }, { sessionId: 'b', interrupted: false },
        { sessionId: 'c', interrupted: true }, { sessionId: 'd', interrupted: true },
        { sessionId: 'e', interrupted: true }, { sessionId: 'f', interrupted: true },
        { sessionId: 'x', interrupted: true },
      ],
      unresolved: [
        // Eligible owner a: lock + file fence on the same resource (the incident shape).
        { phase: 'unknown', admissionBlocked: true, scope: { kind: 'file', path: '/r/b.txt' }, fence: { kind: 'resource', resourceId: '/r/b.txt' }, key: { sessionId: 'a', operationId: 'op-2' } },
        { phase: 'unknown', admissionBlocked: true, scope: { kind: 'file', path: '/r/a.txt' }, fence: { kind: 'resource', resourceId: '/r/a.txt' }, key: { sessionId: 'a', operationId: 'op-1' } },
        // Ineligible blocking owners, one per precondition.
        { phase: 'unknown', admissionBlocked: true, scope: { kind: 'file', path: '/r/c.txt' }, fence: { kind: 'resource', resourceId: '/r/c.txt' }, key: { sessionId: 'b', operationId: 'op-3' } },
        { phase: 'publishing', admissionBlocked: true, scope: { kind: 'file', path: '/r/d.txt' }, fence: { kind: 'resource', resourceId: '/r/d.txt' }, key: { sessionId: 'c', operationId: 'op-4' } },
        { phase: 'unknown', admissionBlocked: false, scope: { kind: 'file', path: '/r/e.txt' }, fence: { kind: 'resource', resourceId: '/r/e.txt' }, key: { sessionId: 'd', operationId: 'op-5' } },
        // Eligible owner f with a subtree fence and NO file row: the candidate
        // still carries the scope (the domain detail renders its card).
        { phase: 'unknown', admissionBlocked: true, scope: { kind: 'subtree', path: '/r/sub' }, fence: { kind: 'subtree', ancestor: '/r/sub' }, key: { sessionId: 'f', operationId: 'op-6' } },
      ],
      prepared: [{ target: { tool: 'write', filePath: '/w/e.txt' }, key: { sessionId: 'e', operationId: 'op-7' } }],
      retainedLocks: [
        { resourceId: '/r/a.txt', owner: 'a', generation: 3, status: 'user-interrupted', reason: null },
        { resourceId: '/r/b.txt', owner: 'a', generation: 1, status: 'user-interrupted', reason: null },
        { resourceId: '/r/c.txt', owner: 'b', generation: 1, status: 'user-interrupted', reason: null },
        { resourceId: '/r/d.txt', owner: 'c', generation: 1, status: 'user-interrupted', reason: null },
        { resourceId: '/r/e.txt', owner: 'd', generation: 1, status: 'user-interrupted', reason: null },
        { resourceId: '/r/g.txt', owner: 'e', generation: 1, status: 'user-interrupted', reason: null },
        { resourceId: '/r/h.txt', owner: 'ghost', generation: 1, status: 'user-interrupted', reason: null },
        { resourceId: '/r/i.txt', owner: 'x', generation: 1, status: 'user-interrupted', reason: null },
      ],
    }
    const diagnosis = editLockRecovery.recoveryDiagnosis('/work/repo', snapshot)
    // Candidates: the eligible owners (a and the row-less f).
    expect(diagnosis.candidates).toHaveLength(2)
    expect(diagnosis.candidates.map((candidate) => candidate.owner).sort()).toEqual(['a', 'f'])
    expect(diagnosis.candidates.find((candidate) => candidate.owner === 'a').scope)
      .toEqual({ root: '/work/repo', owner: 'a', expectedRevision: 7, operationIds: ['op-1', 'op-2'] })
    // Blocked rows: only rows whose owner has the force-release action, sorted by resource id.
    expect(diagnosis.blocked.map((row) => row.resourceId)).toEqual(['/r/a.txt', '/r/b.txt'])
    expect(diagnosis.blocked[0].owner).toBe('a')
    expect(diagnosis.blocked[0].lockStatus).toBe('user-interrupted')
    expect(diagnosis.blocked[0].fence).toBe(true)
    expect(diagnosis.blocked[0].interrupted).toBe(true)
    // Unmet: named preconditions in the manager's refusal order, sorted by owner.
    expect(diagnosis.unmet.map((entry) => entry.owner)).toEqual(['b', 'c', 'd', 'e', 'ghost', 'x'])
    const byOwner = new Map(diagnosis.unmet.map((entry) => [entry.owner, entry]))
    expect(byOwner.get('b').reason).toBe(editLockRecovery.RECOVERY_UX.reasonNotInterrupted)
    expect(byOwner.get('c').reason).toBe(editLockRecovery.RECOVERY_UX.reasonPublishing)
    expect(byOwner.get('d').reason).toBe(editLockRecovery.RECOVERY_UX.reasonDisposition)
    expect(byOwner.get('e').reason).toBe(editLockRecovery.RECOVERY_UX.reasonPrepared)
    expect(byOwner.get('ghost').reason).toBe(editLockRecovery.RECOVERY_UX.reasonUnknownSession)
    expect(byOwner.get('x').reason).toBe(editLockRecovery.RECOVERY_UX.reasonNoUnresolved)
    expect(byOwner.get('e').rows.map((row) => row.resourceId)).toEqual(['/r/g.txt'])
  })

  it('opens with an automatic read-only inspection, renders the three zones, and the Force release click submits the computed confirmation', async () => {
    const { exports, reactStub } = await loadPanel()
    const { EditLockMaintenanceField, editLockRecovery } = exports
    const incident = {
      root: '/work/repo',
      authorityDir: '/work/repo/.weir/edit-lock',
      reservation: false,
      presence: 'valid',
      snapshot: {
        version: 4, revision: 12,
        counts: { sessions: 2, locks: 2, operations: 2, unresolved: 2, retainedLocks: 2 },
        unresolved: [
          { ...INSPECT.snapshot.unresolved[0], admissionBlocked: true },
          { ...INSPECT.snapshot.unresolved[0], admissionBlocked: true, scope: { kind: 'file', path: '/work/repo/b.txt' }, fence: { kind: 'resource', resourceId: '/work/repo/b.txt' }, target: { tool: 'write', filePath: '/work/repo/b.txt' }, key: { sessionId: 'sess-3', operationId: 'op-3' } },
        ],
        prepared: [],
        retainedLocks: [
          { resourceId: '/work/repo/a.txt', owner: 'sess-1', generation: 3, status: 'user-interrupted', reason: null },
          { resourceId: '/work/repo/b.txt', owner: 'sess-3', generation: 1, status: 'user-interrupted', reason: null },
        ],
        sessions: [
          { sessionId: 'sess-1', executionEpoch: 17, interrupted: true, recovery: null },
          { sessionId: 'sess-3', executionEpoch: 4, interrupted: false, recovery: null },
        ],
      },
    }
    const fetchCalls = []
    const fetchStub = (url, init) => {
      fetchCalls.push({ url, init })
      if (url === 'api/weir-edit-lock/maintenance/status') return Promise.resolve({ json: async () => ({ ok: true, value: STATUS }) })
      if (url === 'api/weir-edit-lock/maintenance/inspect') return Promise.resolve({ json: async () => ({ ok: true, value: incident }) })
      if (url === 'api/weir-edit-lock/maintenance/recover-online') return Promise.resolve({ json: async () => ({ ok: true, value: { revision: 13, idempotent: false, record: { owner: 'sess-1' } } }) })
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchStub
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const props = { t: (key) => key }
    const render = () => { reactStub.begin(); return renderTree(EditLockMaintenanceField(props)) }
    try {
      const initial = render()
      initial.children[0].children[1].onClick()
      await flush()
      const opened = render()
      // Opening alone runs the read-only inspection — no manual step.
      const inspectCalls = fetchCalls.filter((entry) => entry.url === 'api/weir-edit-lock/maintenance/inspect')
      expect(inspectCalls).toHaveLength(1)
      expect(JSON.parse(inspectCalls[0].init.body)).toEqual({ root: '/work/repo' })
      // Blocked zone (top): the header, the file with holder and holder state,
      // and the one primary force-release action per row.
      expect(collect(opened, (node) => node.children === 'Blocked files — one-click force release')).toHaveLength(1)
      expect(collect(opened, (node) => node.children === '/work/repo/a.txt')).toHaveLength(1)
      expect(collect(opened, (node) => node.children === 'holder sess-1 · user-interrupted · publication fence · interrupted')).toHaveLength(1)
      expect(collect(opened, (node) => typeof node.children === 'string' && node.children.startsWith('editLockMaintRecoverDigest:'))).toHaveLength(1)
      expect(collect(opened, (node) => node.children === 'editLockMaintRecoverRisk: Detached historic writers may still modify files after this override.')).toHaveLength(1)
      const force = collect(opened, (node) => node.children === 'Force release' && typeof node.onClick === 'function')
      expect(force).toHaveLength(1)
      // Unmet zone: the ineligible owner's file and the named precondition.
      expect(collect(opened, (node) => node.children === 'Blocked files — recovery preconditions not met')).toHaveLength(1)
      expect(collect(opened, (node) => typeof node.children === 'string' && node.children.includes('/work/repo/b.txt'))).toHaveLength(1)
      expect(collect(opened, (node) => node.children === editLockRecovery.RECOVERY_UX.reasonNotInterrupted)).toHaveLength(1)
      // The one explicit click submits the computed confirmation.
      force[0].onClick()
      await flush()
      await flush()
      const call = fetchCalls.find((entry) => entry.url === 'api/weir-edit-lock/maintenance/recover-online')
      const body = JSON.parse(call.init.body)
      expect(body.root).toBe('/work/repo')
      expect(body.owner).toBe('sess-1')
      expect(body.expectedRevision).toBe(12)
      expect(body.operationIds).toEqual(['op-1'])
      expect(body.acceptLateWriterRisk).toBe(true)
      expect(body.confirmation).toBe(editLockRecovery.recoveryConfirmation({ root: '/work/repo', owner: 'sess-1', expectedRevision: 12, operationIds: ['op-1'] }))
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
