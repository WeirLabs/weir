import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * client.hash-edit-view.js chunk test: loaded through the shared helper with
 * minimal react/jsx-runtime/primitives stubs; the view-model ten-piece comes
 * from the real zero-dependency client.hash-edit-model.js chunk, passed via
 * the `model` prop (composition-root prop injection). Assertions migrated
 * verbatim from the pre-split client.test.js.
 */

describe('client.hash-edit-view chunk', () => {
  // Load the view chunk with hook-state-preserving stubs plus the real model
  // chunk, returning the chunk exports and the react stub.
  async function loadView() {
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
        }
      },
    }
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
        DiffBlock: (props) => ({ __diff: props }),
        diffTotals: (diffs) => {
          let added = 0
          let removed = 0
          for (const diff of diffs) {
            added += diff.newText.split('\n').length
            removed += diff.oldText === null ? 0 : diff.oldText.split('\n').length
          }
          return { added, removed }
        },
        IconEditOutlineRegular: (props) => ({ __icon: 'edit', ...props }),
        IconChevronDownOutlineRegular: (props) => ({ __icon: 'chevron', ...props }),
      }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.hash-edit-view.js', requireStub)
    const { exports: model } = await loadClientChunk('lib/client.hash-edit-model.js')
    return { definition, view: exports, model, reactStub }
  }

  it('renders preparing, applied-diff, planned-diff, and failure bodies', async () => {
    const { definition, view, model, reactStub } = await loadView()
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.hash-edit-view.js')

    const { HashEditRow } = view
    const t = (key) => key

    // preparing: one non-expandable streaming row
    const preparing = HashEditRow({ phase: 'preparing', block: { phase: 'preparing' }, t, model })
    expect(preparing['data-state']).toBe('preparing')
    expect(preparing.children.children[1].children).toBe('hashEditTitle')

    const renderStarted = (props) => {
      reactStub.begin()
      const row = HashEditRow(props)
      reactStub.begin()
      return row.__type(row)
    }
    const META = { diffs: [{ path: '/ws/a.js', oldText: 'beta', newText: 'BETA' }] }
    const RESULT_BLOCK = {
      kind: 'tool-result',
      call: { name: 'hash_edit', argsRaw: '{"file_path":"/ws/a.js","edits":[{"op":"replace","pos":"2#VK","text":"BETA"}]}' },
      content: [{ type: 'text', text: 'hash_edit applied 1 op(s) to /ws/a.js:\n\n-diff' }],
      isError: false,
      meta: META,
    }
    const okProps = { phase: 'result', block: RESULT_BLOCK, cwd: '/ws', home: '/home/u', openFile: () => {}, t, model }

    // collapsed header: title, relativized path, totals, no status text
    const collapsed = renderStarted(okProps)
    expect(collapsed['data-state']).toBe('ok')
    const header = collapsed.children[0]
    expect(header.children[1].children).toBe('hashEditTitle')
    expect(header.children[2].children).toBe('a.js')
    expect(header.children[3].children).toBe('+1 −1')
    expect(collapsed.children[1]).toBe(null) // body stays closed

    // expand → the DiffBlock body carries the applied fragments and labels
    header.onClick()
    const expanded = renderStarted(okProps)
    const body = expanded.children[1]
    const diffCard = body.children[1]
    expect(diffCard.diffs).toEqual(META.diffs)
    expect(diffCard.labels.copy).toBe('hashEditCopy')
    expect(typeof diffCard.labels.expand).toBe('function')
    expect(body.children[0]).toBe(null) // no planned hint on a settled call

    // running call: planned fragments from the arguments plus the hint
    reactStub.reset() // fresh hook state per scenario
    const startProps = { phase: 'start', block: { argsRaw: '{"file_path":"/ws/a.js","edits":[{"op":"append","pos":"2#VK","text":"NEW"}]}' }, cwd: '/ws', t, model }
    const running = renderStarted(startProps)
    expect(running['data-state']).toBe('running')
    running.children[0].onClick()
    const runningExpanded = renderStarted(startProps)
    const plannedHint = runningExpanded.children[1].children[0]
    expect(plannedHint.children).toBe('hashEditPlanned')
    expect(runningExpanded.children[1].children[1].diffs).toEqual([{ path: '/ws/a.js', oldText: null, newText: 'NEW' }])
    const runningStatus = running.children[0].children[4]
    expect(runningStatus.children).toBe('hashEditRunning')

    // failed call: no diff, flattened output, explicit failure status
    const failedBlock = { ...RESULT_BLOCK, isError: true, meta: META, content: [{ type: 'text', text: '>>> mismatch report' }] }
    reactStub.reset()
    const failedProps = { phase: 'result', block: failedBlock, cwd: '/ws', t, model }
    const failed = renderStarted(failedProps)
    expect(failed['data-state']).toBe('error')
    expect(failed.children[0].children[4].children).toBe('hashEditFailed')
    failed.children[0].onClick()
    const failedExpanded = renderStarted(failedProps)
    const failureBody = failedExpanded.children[1]
    expect(failureBody.children[1].children[1].children).toBe('>>> mismatch report')

    // legacy result without metadata falls back to the flattened body
    reactStub.reset()
    const legacyProps = { phase: 'result', block: { ...RESULT_BLOCK, meta: undefined }, cwd: '/ws', t, model }
    const legacy = renderStarted(legacyProps)
    legacy.children[0].onClick()
    const legacyExpanded = renderStarted(legacyProps)
    expect(legacyExpanded.children[1].children[1].children[1].children).toContain('hash_edit applied 1 op(s)')
  })
})
