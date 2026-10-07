import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.lsp-toggle.js chunk test: loaded through the shared helper with a
 * hook-state-preserving react stub; useProjection/settingsBus and the
 * remote.commands-backed verbs are stubbed props (composition-root prop
 * injection). Assertions migrated verbatim from the pre-split client.test.js,
 * plus the settingsBus.subscribe → re-check propagation pin.
 */

describe('client.lsp-toggle chunk', () => {
  async function loadToggle() {
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
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.lsp-toggle.js', requireStub)
    return { definition, exports, reactStub }
  }

  it('renders the switch from the capability catalog, projection, and local fallback', async () => {
    const { definition, exports, reactStub } = await loadToggle()
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.lsp-toggle.js')
    expect(exports.LSP_PROJECTION_KEY).toBe('weirLsp')

    const { LspToggle } = exports
    const settingsBusStub = { subscribe: () => () => {} }
    // component: renders null until the command catalog confirms availability
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const baseProps = {
      sessionId: 'sess-1',
      t: (key) => key,
      settingsBus: settingsBusStub,
      toggleLsp: async () => null,
      fetchLspState: async () => undefined,
      commandsList: async () => [{ name: 'lsp' }],
    }
    const settle = async (props) => {
      reactStub.reset()
      reactStub.begin()
      const first = LspToggle(props)
      await flush()
      reactStub.begin()
      return { first, settled: LspToggle(props) }
    }
    const { first, settled } = await settle(baseProps)
    expect(first).toBe(null)
    expect(settled['data-weir-lsp-state']).toBe('off')

    // with useProjection the switch shows the host-folded state
    const { settled: onButton } = await settle({ ...baseProps, useProjection: (key) => (key === 'weirLsp' ? { enabled: true } : undefined) })
    expect(onButton.__type).toBe('button')
    expect(onButton['data-weir-lsp-toggle']).toBe('')
    expect(onButton['data-weir-lsp-state']).toBe('on')
    expect(onButton['aria-pressed']).toBe(true)
    expect(onButton.title).toBe('lspToggleTitle')

    // without useProjection the fallback fetch seeds the local state
    const { settled: fallbackButton } = await settle({ ...baseProps, fetchLspState: async () => true })
    expect(fallbackButton['data-weir-lsp-state']).toBe('on')

    // clicking toggles and, without the projection hook, updates optimistically
    let lastToggle = null
    const clickProps = { ...baseProps, toggleLsp: async (enabled) => {
      lastToggle = enabled
      return null
    } }
    const clickRun = await settle(clickProps)
    expect(clickRun.settled['data-weir-lsp-state']).toBe('off')
    clickRun.settled.onClick()
    await flush()
    reactStub.begin()
    const afterClick = LspToggle(clickProps)
    expect(lastToggle).toBe(true)
    expect(afterClick['data-weir-lsp-state']).toBe('on')

    // a failing toggle surfaces the error in the title
    const failingProps = { ...baseProps, toggleLsp: async () => 'nope' }
    const failingRun = await settle(failingProps)
    failingRun.settled.onClick()
    await flush()
    reactStub.begin()
    expect(LspToggle(failingProps).title).toBe('nope')

    // capability absent from the catalog → no switch
    const absentRun = await settle({ ...baseProps, commandsList: async () => [] })
    expect(absentRun.settled).toBe(null)
  })

  it('re-checks command availability when the injected settings bus notifies', async () => {
    const { exports, reactStub } = await loadToggle()
    const { LspToggle } = exports
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

    // a bus stub that captures the subscribed re-check callback
    let subscribed = null
    const settingsBusStub = {
      subscribe: (callback) => {
        subscribed = callback
        return () => {}
      },
    }
    const catalog = { calls: 0, includesLsp: true }
    const props = {
      sessionId: 'sess-1',
      t: (key) => key,
      settingsBus: settingsBusStub,
      toggleLsp: async () => null,
      fetchLspState: async () => undefined,
      commandsList: async () => {
        catalog.calls += 1
        return catalog.includesLsp ? [{ name: 'lsp' }] : []
      },
    }
    reactStub.reset()
    reactStub.begin()
    LspToggle(props)
    await flush()
    reactStub.begin()
    expect(LspToggle(props)['data-weir-lsp-state']).toBe('off')
    expect(catalog.calls).toBe(1)
    expect(typeof subscribed).toBe('function')

    // a settings save flipped the capability: the bus bump re-checks live and
    // the switch disappears without a reload
    catalog.includesLsp = false
    subscribed()
    await flush()
    reactStub.begin()
    expect(catalog.calls).toBe(2)
    expect(LspToggle(props)).toBe(null)
  })
})
