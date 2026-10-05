import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.capability-badge.js chunk test: the Badge is the composition root's
 * prop bridge to the lazy manager panel, and owns the panel's open state.
 * Regressions (2026-10-05):
 *  - the Badge rendered ManagerPanel with only { sessionId, model, onClose } —
 *    fetchListing never arrived and the panel sat on the perpetual loading
 *    surface;
 *  - the panel was a CHILD of the toggle button, so every click inside the
 *    panel bubbled to the toggle and closed it, while clicks outside did
 *    nothing — the panel is now the button's sibling inside a marked wrapper
 *    with the edit-lock style outside-pointerdown dismissal.
 */
describe('client.capability-badge chunk', () => {
  async function loadBadge() {
    const reactState = []
    let hookCursor = 0
    const reactStub = {
      reset() { reactState.length = 0 },
      begin() { hookCursor = 0 },
      useState(initial) {
        const at = hookCursor++
        if (!(at in reactState)) reactState[at] = [initial, (next) => { reactState[at][0] = next }]
        return reactState[at]
      },
      useEffect(fn) {
        const at = hookCursor++
        if (!(at in reactState)) reactState[at] = { cleanup: fn() }
        else reactState[at] = { cleanup: fn() }
        return undefined
      },
      useCallback(fn) { return fn },
      useRef(initial) {
        const at = hookCursor++
        if (!(at in reactState)) reactState[at] = { current: initial }
        return reactState[at]
      },
    }
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.capability-badge.js', requireStub)
    return { definition, exports, reactStub }
  }

  function baseProps() {
    const model = {
      badgeStateOf: () => ({ known: true, applied: { skills: 10, mcpServers: 0 }, unavailable: [] }),
      convergenceHintOf: () => null,
      frameRefreshesSession: () => false,
    }
    function ManagerPanel() { return null }
    return {
      model,
      ManagerPanel,
      props: {
        sessionId: 'sess-1',
        model,
        ManagerPanel,
        t: (key, fallback) => fallback,
        fetchReceipt: async () => ({ status: 'applied', effective: { skills: [], mcpServers: [] }, warnings: [] }),
        fetchListing: async () => ({ skills: [], mcpServers: [] }),
        fetchConditions: async () => ({ conditions: [] }),
        subscribeFrames: () => () => {},
      },
    }
  }

  it('forwards the composition-root verbs and translator to the manager panel', async () => {
    const { definition, exports, reactStub } = await loadBadge()
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.capability-badge.js')
    const { CapabilityBadge } = exports
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const { model, ManagerPanel, props } = baseProps()

    reactStub.reset()
    reactStub.begin()
    CapabilityBadge(props)
    await flush()
    reactStub.begin()
    const settled = CapabilityBadge(props)
    // The wrapper carries the outside-click root marker; the toggle button is
    // its first child, the (closed) panel slot the second.
    expect(settled.__type).toBe('span')
    expect(settled['data-orrery-capability-root']).toBe('')
    const button = settled.children[0]
    expect(button.__type).toBe('button')
    expect(button['aria-label']).toBe('10 skills · 0 MCP')
    expect(button['aria-expanded']).toBe(false)
    expect(settled.children.filter(Boolean)).toHaveLength(1)

    // Open the panel and re-render: the panel element is the button's SIBLING
    // (never its child — a nested panel's clicks bubbled to the toggle) and
    // carries the verbs.
    button.onClick()
    reactStub.begin()
    const opened = CapabilityBadge(props)
    const openedButton = opened.children[0]
    expect(openedButton['aria-expanded']).toBe(true)
    expect(openedButton.children.every((child) => !child || child.__type !== ManagerPanel)).toBe(true)
    const panel = opened.children.find((child) => child && child.__type === ManagerPanel)
    expect(panel).toBeTruthy()
    expect(panel.sessionId).toBe('sess-1')
    // After a successful Apply the panel pings onApplied so the Badge re-pulls
    // its receipt (counts follow the Apply immediately).
    expect(typeof panel.onApplied).toBe('function')
    expect(panel.applySelection).toBe(props.applySelection)
    expect(panel.fetchReceipt).toBe(props.fetchReceipt)
    expect(panel.model).toBe(model)
    expect(typeof panel.onClose).toBe('function')
    expect(panel.fetchListing).toBe(props.fetchListing)
    expect(panel.fetchConditions).toBe(props.fetchConditions)
    expect(panel.t).toBe(props.t)
  })

  it('closes on outside pointerdown and stays open for clicks inside', async () => {
    const { exports, reactStub } = await loadBadge()
    const { CapabilityBadge } = exports
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const { ManagerPanel, props } = baseProps()

    const listeners = []
    globalThis.document = {
      addEventListener: (type, fn) => { if (type === 'pointerdown') listeners.push(fn) },
      removeEventListener: () => {},
    }
    try {
      reactStub.reset()
      reactStub.begin()
      CapabilityBadge(props)
      await flush()
      reactStub.begin()
      const settled = CapabilityBadge(props)
      // Closed: no dismissal listener is registered.
      expect(listeners).toHaveLength(0)

      settled.children[0].onClick()
      reactStub.begin()
      CapabilityBadge(props)
      expect(listeners).toHaveLength(1)
      const onPointerDown = listeners[listeners.length - 1]

      // A click inside the entry (target.closest hits the root marker) keeps
      // the panel open.
      onPointerDown({ target: { closest: (selector) => selector === '[data-orrery-capability-root]' ? {} : null } })
      reactStub.begin()
      const afterInside = CapabilityBadge(props)
      expect(afterInside.children.some((child) => child && child.__type === ManagerPanel)).toBe(true)

      // A click outside dismisses the panel.
      onPointerDown({ target: { closest: () => null } })
      reactStub.begin()
      const afterOutside = CapabilityBadge(props)
      expect(afterOutside.children.every((child) => !child || child.__type !== ManagerPanel)).toBe(true)
      expect(afterOutside.children[0]['aria-expanded']).toBe(false)
    } finally {
      delete globalThis.document
    }
  })
})
