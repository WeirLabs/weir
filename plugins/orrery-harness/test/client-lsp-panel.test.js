import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.lsp-panel.js chunk test: shared helper + hook-state-preserving react
 * stub + fetch stub; the lsp model trio comes from the real zero-dependency
 * client.lsp-model.js chunk via the `model` prop. Assertions migrated
 * verbatim from the pre-split client.test.js LSP manager panel describe.
 */

describe('client.lsp-panel chunk', () => {
  it('loads the catalog, confirms installs, runs them, and degrades on errors', async () => {
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
    const { definition, exports } = await loadClientChunk('lib/client.lsp-panel.js', requireStub)
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.lsp-panel.js')
    const { exports: model } = await loadClientChunk('lib/client.lsp-model.js')
    const { LspManagerField } = exports
    expect(typeof LspManagerField).toBe('function')

    const SERVERS = [
      { family: 'lua', languageIds: ['lua'], command: 'lua-language-server', installed: false, version: null, installCommand: 'brew install lua-language-server', installHint: '', installerAvailable: true },
      { family: 'typescript', languageIds: ['typescript'], command: 'typescript-language-server', installed: true, version: '5.0', installCommand: 'npm install -g typescript-language-server typescript', installHint: '', installerAvailable: true },
      { family: 'cpp', languageIds: ['cpp'], command: 'clangd', installed: false, version: null, installCommand: 'brew install llvm', installHint: '', installerAvailable: false },
    ]
    const fetchCalls = []
    const fetchStub = (url, init) => {
      fetchCalls.push({ url, init })
      if (url === 'api/orrery-lsp/status') {
        return Promise.resolve({ json: async () => ({ ok: true, value: { servers: SERVERS } }) })
      }
      if (url === 'api/orrery-lsp/install') {
        return Promise.resolve({ json: async () => ({ ok: true, value: { output: 'added 2 packages', exitCode: 0, timedOut: false } }) })
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchStub
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    const props = { t: (key) => key, model }
    const renderWith = (componentProps) => {
      reactStub.begin()
      return LspManagerField(componentProps)
    }
    const render = () => renderWith(props)
    const settleWith = async (componentProps) => {
      reactStub.reset()
      reactStub.begin()
      const first = LspManagerField(componentProps)
      await flush()
      reactStub.begin()
      return { first, settled: LspManagerField(componentProps) }
    }
    const settle = async () => settleWith(props)

    try {
      // closed: a labeled row with the open button
      const initial = await settle()
      expect(initial.settled.children[0].children[1].children).toBe('chainEdit')
      // open it → status loads
      initial.settled.children[0].children[1].onClick()
      await flush()
      const opened = render()
      const body = opened.children[1].children
      expect(body.__type).toBe('div')
      expect(fetchCalls[0].url).toBe('api/orrery-lsp/status')
      // two server rows: lua missing (install button), typescript installed (version)
      const luaRow = body.children[0]
      expect(luaRow.children[1].children[0].children).toBe('lspManagerMissing')
      expect(luaRow.children[1].children[1].children).toBe('lspManagerInstall')
      const tsRow = body.children[1]
      expect(tsRow.children[1].children[0].children).toBe('5.0')
      expect(tsRow.children[1].children[1]).toBe(null)
      // install → confirm state shows the exact command first
      luaRow.children[1].children[1].onClick()
      await flush()
      const confirming = render()
      const confirmRow = confirming.children[1].children.children[0]
      expect(confirmRow.children[1].children[0].children).toBe('brew install lua-language-server')
      // an unavailable installer disables the confirm and warns
      const cppRow = confirming.children[1].children.children[2]
      cppRow.children[1].children[1].onClick()
      await flush()
      const cppConfirm = render().children[1].children.children[2]
      expect(cppConfirm.children[1].children[1].children).toBe('lspManagerInstallerMissing')
      expect(cppConfirm.children[1].children[2].children[0].disabled).toBe(true)
      cppConfirm.children[1].children[2].children[1].onClick()
      await flush()
      // run the install → the endpoint is called with the family
      confirmRow.children[1].children[2].children[0].onClick()
      await flush()
      expect(fetchCalls[1].url).toBe('api/orrery-lsp/install')
      expect(JSON.parse(fetchCalls[1].init.body)).toEqual({ family: 'lua' })
      const afterInstall = render()
      const resultBlock = afterInstall.children[1].children.children[3]
      expect(resultBlock).toBeTruthy()
      expect(resultBlock.children[0].children).toContain('lspFamily_lua')
      expect(resultBlock.children[1].children).toBe('added 2 packages')
      // fetch failure → inline error row with retry
      globalThis.fetch = () => Promise.reject(new Error('down'))
      const failed = await settle()
      failed.settled.children[0].children[1].onClick()
      await flush()
      const errored = render()
      const errorBody = errored.children[1].children
      expect(errorBody.children[0].children).toContain('lspManagerUnavailable')
      expect(errorBody.children[1].children).toBe('lspManagerRetry')
      // the boundary isolates rendering failures
      const Boundary = errored.children[1].__type
      const boundaryInstance = new Boundary({ t: (key) => key, children: 'inner' })
      expect(boundaryInstance.render()).toBe('inner')
      Boundary.getDerivedStateFromError()
      const failedBoundary = new Boundary({ t: (key) => key, children: 'inner' })
      failedBoundary.state = { failed: true }
      expect(failedBoundary.render().children).toBe('lspManagerFailed')

      // custom servers: the add form synthesizes the lspServers JSON
      globalThis.fetch = fetchStub
      const edited = []
      const customProps = { t: (key) => key, model, serversText: '{}', edit: (field, text) => edited.push({ field, text }) }
      const customRun = await settleWith(customProps)
      customRun.settled.children[0].children[1].onClick()
      await flush()
      const formRow = () => {
        const panel = renderWith(customProps)
        const panelBody = panel.children[1].children
        const section = panelBody.children[panelBody.children.length - 1]
        return section.children[section.children.length - 1]
      }
      expect(formRow()).toBeTruthy()
      formRow().children[0].onChange({ target: { value: 'zig' } })
      await flush()
      formRow().children[1].onChange({ target: { value: 'zls' } })
      await flush()
      formRow().children[2].onChange({ target: { value: '--stdio' } })
      await flush()
      formRow().children[3].onChange({ target: { value: 'npm i -g zls' } })
      await flush()
      formRow().children[4].onClick()
      expect(edited).toHaveLength(1)
      expect(edited[0].field).toBe('lspServers')
      const parsed = JSON.parse(edited[0].text)
      expect(parsed.zig.command).toBe('zls')
      expect(parsed.zig.args).toEqual(['--stdio'])
      expect(parsed.zig.install).toEqual({ command: 'npm', args: ['i', '-g', 'zls'] })
      // helper round-trips through the injected model
      expect(model.jsonToLspServers('not-json')).toEqual({})
      expect(model.jsonToLspServers(edited[0].text).zig.command).toBe('zls')
      expect(model.lspServersToJson({})).toBe('{}')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
