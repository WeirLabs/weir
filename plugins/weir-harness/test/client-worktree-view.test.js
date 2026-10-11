// client.worktree-view.js: the lanes panel runLine command-integrity guards,
// driven through the real model chunk and a react stub (precedent:
// client-hash-edit-view.test.js). Only the runLine-level logic is pinned —
// no whole-card-tree snapshots.

import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))

// Depth-first walk over the jsx-stub element tree (elements are plain
// objects; strings/null/style objects terminate the descent).
function* walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const entry of node) yield* walk(entry)
    return
  }
  yield node
  yield* walk(node.children)
}

const findAction = (tree, key) => [...walk(tree)].find((node) => node['data-weir-worktree-action'] === key)
const findError = (tree) => [...walk(tree)].find((node) => node['data-weir-worktree-error'] !== undefined)

describe('client.worktree-view chunk: lanes panel runLine guards', () => {
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
      throw new Error(`unexpected require ${name}`)
    }
    const { exports: view } = await loadClientChunk('lib/client.worktree-view.js', requireStub)
    const { exports: model } = await loadClientChunk('lib/client.worktree-model.js')
    return { view, model, reactStub }
  }

  const lanePayload = {
    id: 'a-001', state: 'ready', branch: 'weir/a-001', base: { branch: 'main' },
    actions: { clean: { enabled: true }, abandon: { enabled: true } },
  }
  const viewPayload = {
    available: true, mode: false, ownedBySession: ['a-001'], unmanaged: [],
    repo: { branch: 'main', root: '/r', gitVersion: '2.39.5', exclude: true, verification: { enabled: false, commands: [] } },
    lanes: [lanePayload],
  }

  // Mount LanesPanel against the fixture view, click one lane-card action,
  // and return the re-rendered tree plus the runWorktree spy. `commandFor`
  // optionally replaces the model's command construction (null-line case).
  async function clickLaneAction({ view, model, reactStub }, { commandFor, outcome }) {
    reactStub.reset()
    const calls = []
    const runWorktree = (line) => {
      calls.push(line)
      return Promise.resolve(outcome)
    }
    const effectiveModel = commandFor ? { ...model, commandFor } : model
    const props = {
      t: (key) => key,
      model: effectiveModel,
      fetchView: () => viewPayload,
      narrowView: model.narrowView,
      needsPolling: model.needsPolling,
      diffLines: model.diffLines,
      ago: model.ago,
      fetchDiff: () => '',
      runWorktree,
    }
    // Mount pass: the effect stub fires the initial view read (async).
    reactStub.begin()
    view.LanesPanel(props)
    await nextTick()
    // Populated pass: the lane card exists; render it in the same hook pass
    // (parent hooks first, then the child's) so the stub slots stay aligned.
    reactStub.begin()
    const tree = view.LanesPanel(props)
    const card = [...walk(tree)].find((node) => node.__type === view.LaneCard)
    const cardTree = card.__type(card)
    await findAction(cardTree, 'clean-worktree').onClick()
    // Error pass: the panel re-renders with the settled error state.
    reactStub.begin()
    return { tree: view.LanesPanel(props), calls }
  }

  it('refuses a null command line: no dispatch, concise localized error', async () => {
    const loaded = await loadView()
    const { tree, calls } = await clickLaneAction(loaded, {
      commandFor: () => null,
      outcome: { kind: 'success', text: '' },
    })
    expect(calls).toEqual([])
    expect(findError(tree)?.children).toBe('actionFailed')
  })

  it('maps a Usage: /worktree outcome to the same concise localized error', async () => {
    const loaded = await loadView()
    const { tree, calls } = await clickLaneAction(loaded, {
      outcome: { kind: 'error', text: 'Usage: /worktree <command> [options]\n  open <title> — open a lane' },
    })
    expect(calls).toEqual(['clean a-001 worktree'])
    expect(findError(tree)?.children).toBe('actionFailed')
  })

  it('keeps a normal error outcome text untouched', async () => {
    const loaded = await loadView()
    const { tree, calls } = await clickLaneAction(loaded, {
      outcome: { kind: 'error', text: 'lane not found: a-001' },
    })
    expect(calls).toEqual(['clean a-001 worktree'])
    expect(findError(tree)?.children).toBe('lane not found: a-001')
  })
})
