import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.capability-badge.js chunk test: the Badge is the composition root's
 * prop bridge to the lazy manager panel. Regression (2026-10-05 GUI panel
 * stuck on "Loading capabilities…"): the Badge rendered ManagerPanel with
 * only { sessionId, model, onClose } — fetchListing never arrived, the
 * panel's fetch guard stayed false and listing stayed null forever.
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
        return undefined
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

  it('forwards the composition-root verbs and translator to the manager panel', async () => {
    const { definition, exports, reactStub } = await loadBadge()
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.capability-badge.js')
    const { CapabilityBadge } = exports

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const model = {
      badgeStateOf: () => ({ known: true, applied: { skills: 10, mcpServers: 0 }, unavailable: [] }),
      convergenceHintOf: () => null,
      frameRefreshesSession: () => false,
    }
    function ManagerPanel() { return null }
    const props = {
      sessionId: 'sess-1',
      model,
      ManagerPanel,
      t: (key, fallback) => fallback,
      fetchReceipt: async () => ({ status: 'applied', effective: { skills: [], mcpServers: [] }, warnings: [] }),
      fetchListing: async () => ({ skills: [], mcpServers: [] }),
      fetchConditions: async () => ({ conditions: [] }),
      subscribeFrames: () => () => {},
    }

    reactStub.reset()
    reactStub.begin()
    CapabilityBadge(props)
    await flush()
    reactStub.begin()
    const settled = CapabilityBadge(props)
    expect(settled.__type).toBe('button')
    expect(settled['aria-label']).toBe('10 skills · 0 MCP')
    // Panel closed: no ManagerPanel element yet.
    expect(settled.children.filter(Boolean)).toHaveLength(1)

    // Open the panel and re-render: the panel element must carry the verbs.
    settled.onClick()
    reactStub.begin()
    const opened = CapabilityBadge(props)
    const panel = opened.children.find((child) => child && child.__type === ManagerPanel)
    expect(panel).toBeTruthy()
    expect(panel.sessionId).toBe('sess-1')
    expect(panel.model).toBe(model)
    expect(typeof panel.onClose).toBe('function')
    expect(panel.fetchListing).toBe(props.fetchListing)
    expect(panel.fetchConditions).toBe(props.fetchConditions)
    expect(panel.t).toBe(props.t)
  })
})
