import { readFileSync } from 'node:fs'
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
      Component: class {
        constructor(props) { this.props = props; this.state = {} }
        render() { return this.props?.children }
      },
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
    expect(definition.id).toBe('weir-harness')
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
    expect(settled['data-weir-capability-root']).toBe('')
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
    // The panel renders inside the error boundary (12.2: a panel error must
    // not take down neighboring composer controls).
    const boundary = opened.children.find((child) => child && child.__type !== ManagerPanel && child !== openedButton && child.children)
    const panel = boundary?.children
    expect(panel).toBeTruthy()
    expect(panel.__type).toBe(ManagerPanel)
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
      onPointerDown({ target: { closest: (selector) => selector === '[data-weir-capability-root]' ? {} : null } })
      reactStub.begin()
      const afterInside = CapabilityBadge(props)
      expect(afterInside.children.some((child) => child && child.children && child.children.__type === ManagerPanel)).toBe(true)

      // A click outside dismisses the panel.
      onPointerDown({ target: { closest: () => null } })
      reactStub.begin()
      const afterOutside = CapabilityBadge(props)
      expect(afterOutside.children.every((child) => !child || !(child.children && child.children.__type === ManagerPanel))).toBe(true)
      expect(afterOutside.children[0]['aria-expanded']).toBe(false)
    } finally {
      delete globalThis.document
    }
  })

  it('renders the compact label, warn dot and painted focus/hover affordances (visual polish)', async () => {
    const { exports, reactStub } = await loadBadge()
    const { CapabilityBadge } = exports
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const { props } = baseProps()
    props.model = {
      badgeStateOf: () => ({ known: true, applied: { skills: 10, mcpServers: 0 }, unavailable: ['fixture-a-unavailable'] }),
      convergenceHintOf: () => null,
      frameRefreshesSession: () => false,
    }

    reactStub.reset()
    reactStub.begin()
    CapabilityBadge(props)
    await flush()
    reactStub.begin()
    const settled = CapabilityBadge(props)
    const button = settled.children[0]
    // The pinned contract holds: children[0] stays the toggle button with the
    // full-count aria-label.
    expect(button.__type).toBe('button')
    expect(button['aria-label']).toBe('10 skills · 0 MCP')
    // The visible label is the compact pair next to the blocks icon.
    expect(button.children).toContain('10 · 0')
    // A session with warnings paints the warn dot and lists them in the tooltip.
    const dot = button.children.find((child) => child && child.style && child.style.borderRadius === '50%')
    expect(dot).toBeTruthy()
    expect(button.title).toBe('fixture-a-unavailable')
    // Inline-style chunks paint focus/hover affordances via handlers (no
    // stylesheets, no extra hooks): the toggle carries them.
    expect(typeof button.onFocus).toBe('function')
    expect(typeof button.onBlur).toBe('function')
    expect(typeof button.onPointerDown).toBe('function')
    expect(typeof button.onMouseEnter).toBe('function')
    expect(typeof button.onMouseLeave).toBe('function')
    // The ring follows :focus-visible semantics: keyboard focus paints it...
    const keyboardEl = { style: {} }
    button.onFocus({ currentTarget: keyboardEl })
    expect(keyboardEl.style.outline).toContain('2px solid')
    // ...but pointer activation suppresses it — a mouse click focuses the
    // button too and must not leave the outline painted.
    const pointerEl = { style: {} }
    button.onPointerDown({})
    button.onFocus({ currentTarget: pointerEl })
    expect(pointerEl.style.outline).toBeUndefined()
    // onBlur resets the modality: the next keyboard focus paints again.
    button.onBlur({ currentTarget: pointerEl })
    const againEl = { style: {} }
    button.onFocus({ currentTarget: againEl })
    expect(againEl.style.outline).toContain('2px solid')
    // The affordance transitions stay inside the 120-160ms hover/selection budget.
    expect(button.style.transition).toContain('120ms')
  })
})

describe('capability chunks locale contract (2026-10-05 badge slot crash)', () => {
  // The host locale's second t() parameter is an interpolation VARS object,
  // never a fallback string: translate() does placeholder lookups with the
  // `in` operator on it and a string there crashes the slot entry whenever
  // the registered template carries {placeholders}. All capability chunks
  // must call props.t(key) single-arg and keep fallbacks in code.
  it('no capability chunk passes the fallback string as the t() second argument', () => {
    for (const name of ['client.capability-badge.js', 'client.capability-manager.js', 'client.capability-presets.js']) {
      const source = readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8')
      expect(source.includes('props.t(key, fallback)')).toBe(false)
      expect(source.includes('props.t(key)')).toBe(true)
    }
  })
})
