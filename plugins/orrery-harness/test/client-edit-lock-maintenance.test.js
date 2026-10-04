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
  authorityDir: '/work/repo/.orrery/edit-lock',
  reservation: false,
  endpoint: { path: '/tmp/orrery-edit-lock-x.sock', exists: true },
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
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.edit-lock-maintenance.js')
    const { EditLockMaintenanceField } = exports
    expect(typeof EditLockMaintenanceField).toBe('function')

    const fetchCalls = []
    let statusPayload = { ok: true, value: STATUS }
    let inspectPayload = { ok: true, value: INSPECT }
    const fetchStub = (url, init) => {
      fetchCalls.push({ url, init })
      if (url === 'api/orrery-edit-lock/maintenance/status') return Promise.resolve({ json: async () => statusPayload })
      if (url === 'api/orrery-edit-lock/maintenance/inspect') return Promise.resolve({ json: async () => inspectPayload })
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
      expect(fetchCalls[0].url).toBe('api/orrery-edit-lock/maintenance/status')
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
      expect(fetchCalls[1].url).toBe('api/orrery-edit-lock/maintenance/inspect')
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
    ]
    for (const key of KEYS) {
      expect(typeof en[key], `en.${key}`).toBe('string')
      expect(en[key].length).toBeGreaterThan(0)
      expect(typeof zh[key], `zh.${key}`).toBe('string')
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })
})
