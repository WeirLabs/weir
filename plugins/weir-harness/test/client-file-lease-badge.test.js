import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

// client.file-lease-badge.js: the read-only ownership badge (edit-lock rebuild
// task 3.7, design D13 / spec "Read-only ownership presentation").
//
// What is pinned here is the whole acceptance surface of the redesign:
//
//  - three states and no fourth (not holding / holding N / degraded);
//  - the expanded detail lists this session's claims AND the other holders in
//    the project, plus the arbiter's health line;
//  - the detail contains NO action control at all — no button, no command
//    input, no confirmation step, no clickable row. Expand/collapse is the one
//    and only interaction in the chunk, so the clickable set of the whole tree
//    must be exactly the badge;
//  - both locales ship inside the chunk data face (the entry registers them on
//    arrival; a chunk never calls ctx).

/** A hook-state stub with deps-keyed effects (the panel-chunk test pattern). */
function createReactStub() {
  const slots = []
  let cursor = 0
  return {
    slots,
    begin() {
      cursor = 0
    },
    useState(initial) {
      const at = cursor++
      if (!(at in slots)) {
        slots[at] = [initial, (next) => {
          const current = slots[at][0]
          slots[at][0] = typeof next === 'function' ? next(current) : next
        }]
      }
      return slots[at]
    },
    useEffect(fn, deps) {
      const at = cursor++
      const key = JSON.stringify(deps ?? null)
      const prev = slots[at]
      if (!prev || prev.key !== key) {
        if (typeof prev?.cleanup === 'function') prev.cleanup()
        slots[at] = { key, cleanup: fn() }
      }
    },
  }
}

/** The document-level listeners the chunk installs for dismissal. */
function createDocument() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  return {
    addEventListener(/** @type {string} */ type, /** @type {Function} */ fn) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
    },
    removeEventListener(/** @type {string} */ type, /** @type {Function} */ fn) {
      const list = listeners.get(type) ?? []
      const index = list.indexOf(fn)
      if (index >= 0) list.splice(index, 1)
    },
    /** @param {string} type @param {any} event */
    fire(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
    },
    /** @param {string} type */
    count(type) {
      return (listeners.get(type) ?? []).length
    },
  }
}

async function load() {
  const reactStub = createReactStub()
  const jsx = (/** @type {any} */ type, /** @type {any} */ props) => ({ __type: type, ...(props ?? {}) })
  const requireStub = (/** @type {string} */ name) => {
    if (name === 'react') return reactStub
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    throw new Error(`unexpected require ${name}`)
  }
  const { definition, exports } = await loadClientChunk('lib/client.file-lease-badge.js', requireStub)
  return { definition, exports, reactStub }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Every element node of a render tree, depth-first. @param {any} node @param {any[]} out */
function elements(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) elements(item, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  out.push(node)
  elements(node.children, out)
  return out
}

/** @param {any} node @param {(node: any) => boolean} match */
function find(node, match) {
  for (const element of elements(node)) if (match(element)) return element
  return undefined
}

/** @param {any} node @param {(node: any) => boolean} match */
function findAll(node, match) {
  return elements(node).filter(match)
}

const badgeOf = (/** @type {any} */ tree) => find(tree, (node) => node['data-weir-file-lease'] === '')
const panelOf = (/** @type {any} */ tree) => find(tree, (node) => node['data-weir-file-lease-panel'] !== undefined)

/** A view exactly as `src/file-lease/view.js` shapes it. */
const viewOf = (/** @type {any} */ { arbiter = 'ok', mine = [], others = [] } = {}) => ({ schemaVersion: 1, arbiter, mine, others })
const mineRow = (/** @type {string} */ path, extra = {}) => ({ path, pathFull: `/work/project/${path}`, label: 'orchestrator', heldSince: Date.now() - 60_000, holdUntil: null, ...extra })
const otherRow = (/** @type {string} */ path, extra = {}) => ({ path, pathFull: `/work/project/${path}`, holder: { label: 'reviewer', session: 'sess-b' }, expiresAt: Date.now() + 90_000, holdUntil: null, ...extra })

/** Mount the badge against a scripted read, with the entry-side translator. */
async function mounted({ views = [viewOf()], t = null, sessionId = 's1', fetchView = null, document = null, errors = [] } = {}) {
  const { exports, reactStub, definition } = await load()
  const translator = t ?? ((/** @type {string} */ key) => exports.dictionaries.en[key] ?? key)
  let index = 0
  const reads = []
  const props = {
    sessionId,
    t: translator,
    fetchView: fetchView ?? (async () => {
      reads.push(index)
      return views[Math.min(index++, views.length - 1)]
    }),
  }
  if (document !== null) globalThis.document = document
  const render = () => {
    reactStub.begin()
    try {
      return exports.FileLeaseBadge(props)
    } catch (error) {
      errors.push(error)
      throw error
    }
  }
  render()
  await flush()
  return { exports, definition, props, reads, render, reactStub }
}

describe('client.file-lease-badge chunk', () => {
  it('loads as one ModuleLoader chunk and exports the badge plus both dictionaries', async () => {
    const { definition, exports } = await load()
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.file-lease-badge.js')
    expect(typeof exports.FileLeaseBadge).toBe('function')
    expect(typeof exports.dictionaries.en).toBe('object')
    expect(typeof exports.dictionaries.zh).toBe('object')
    // en/zh parity: the entry registers both from this one data face, so a key
    // present in one locale only would render the raw key in the other.
    expect(Object.keys(exports.dictionaries.en).sort()).toEqual(Object.keys(exports.dictionaries.zh).sort())
    for (const key of ['fileLeaseLabel', 'fileLeaseTitle', 'fileLeasePanelTitle', 'fileLeaseState_none', 'fileLeaseState_holding', 'fileLeaseState_degraded', 'fileLeaseMine', 'fileLeaseMineEmpty', 'fileLeaseOthers', 'fileLeaseOthersEmpty', 'fileLeaseArbiter_ok', 'fileLeaseArbiter_degraded', 'fileLeaseArbiter_unavailable', 'fileLeaseSince', 'fileLeaseRetainedFor', 'fileLeaseReadOnlyHint']) {
      expect(typeof exports.dictionaries.en[key], `en.${key}`).toBe('string')
      expect(typeof exports.dictionaries.zh[key], `zh.${key}`).toBe('string')
    }
    expect(exports.dictionaries.zh.fileLeaseState_none).toBe('未持有')
    expect(exports.dictionaries.zh.fileLeaseState_degraded).toBe('降级')
    expect(exports.dictionaries.zh.fileLeaseState_holding).toBe('持有 {n}')
    expect(exports.dictionaries.en.fileLeaseState_holding).toBe('holding {n}')
  })

  it('renders exactly three states: not holding, holding N, degraded', async () => {
    const { exports } = await load()
    expect(exports.stateOf(viewOf())).toBe('none')
    expect(exports.stateOf(viewOf({ mine: [mineRow('a.txt'), mineRow('b.txt'), mineRow('c.txt')] }))).toBe('holding')
    expect(exports.stateOf(viewOf({ arbiter: 'degraded' }))).toBe('degraded')
    expect(exports.stateOf(viewOf({ arbiter: 'unavailable' }))).toBe('degraded')
    // An unreadable view is never "not holding": that would state a fact the
    // panel cannot vouch for.
    expect(exports.stateOf(null)).toBe('degraded')
    expect(exports.stateOf({})).toBe('degraded')

    const none = await mounted({ views: [viewOf()] })
    expect(none.render().__type).toBe('span')
    expect(badgeOf(none.render())['data-weir-file-lease-state']).toBe('none')
    expect(find(none.render(), (node) => node['data-weir-file-lease-summary'] === '')?.children).toBe('not holding')

    const holding = await mounted({ views: [viewOf({ mine: [mineRow('a.txt'), mineRow('b.txt'), mineRow('c.txt')] })] })
    expect(badgeOf(holding.render())['data-weir-file-lease-state']).toBe('holding')
    expect(find(holding.render(), (node) => node['data-weir-file-lease-summary'] === '')?.children).toBe('holding 3')

    const degraded = await mounted({ views: [viewOf({ arbiter: 'degraded' })] })
    expect(badgeOf(degraded.render())['data-weir-file-lease-state']).toBe('degraded')
    expect(find(degraded.render(), (node) => node['data-weir-file-lease-summary'] === '')?.children).toBe('degraded')
  })

  it('localizes the three states from the chunk data face (zh)', async () => {
    const { exports } = await load()
    const zh = (/** @type {string} */ key) => exports.dictionaries.zh[key] ?? key
    const none = await mounted({ views: [viewOf()], t: zh })
    expect(find(none.render(), (node) => node['data-weir-file-lease-summary'] === '')?.children).toBe('未持有')
    const holding = await mounted({ views: [viewOf({ mine: [mineRow('a.txt')] })], t: zh })
    expect(find(holding.render(), (node) => node['data-weir-file-lease-summary'] === '')?.children).toBe('持有 1')
    const degraded = await mounted({ views: [viewOf({ arbiter: 'unavailable' })], t: zh })
    expect(find(degraded.render(), (node) => node['data-weir-file-lease-summary'] === '')?.children).toBe('降级')
  })

  it('expands a read-only panel with both sections and the arbiter status line', async () => {
    const view = viewOf({
      mine: [mineRow('src/a.txt', { holdUntil: Date.now() + 10 * 60_000 + 30_000 }), mineRow('b.txt')],
      others: [otherRow('c.txt'), otherRow('d.txt', { holder: { label: 'writer', session: 'sess-c' } })],
    })
    const { render } = await mounted({ views: [view] })
    expect(panelOf(render())).toBe(undefined)
    badgeOf(render()).onClick()
    await flush()
    const tree = render()
    const panel = panelOf(tree)
    expect(panel.__type).toBe('div')
    expect(panel.role).toBe('dialog')
    expect(panel['aria-label']).toBe('File ownership (read-only)')
    // The arbiter's health, as one line.
    const arbiter = find(panel, (node) => node['data-weir-file-lease-arbiter'] !== undefined)
    expect(arbiter['data-weir-file-lease-arbiter']).toBe('ok')
    expect(arbiter.children).toBe('Arbiter: ok')
    // Section 1: this session's claims, with when the hold started and how long
    // a retention has left.
    const mineSection = find(panel, (node) => node['data-weir-file-lease-section'] === 'mine')
    const mineRows = findAll(mineSection, (node) => node['data-weir-file-lease-row'] === 'mine')
    expect(mineRows.map((node) => node['data-weir-file-lease-row'])).toHaveLength(2)
    // The chunk renders the server's order verbatim (the view sorts; a second
    // ordering rule here could disagree with the panel's own tests).
    expect(mineRows[0].children[0].children).toBe('src/a.txt')
    expect(mineRows[1].children[0].children).toBe('b.txt')
    const since = find(panel, (node) => node['data-weir-file-lease-since'] === 'src/a.txt')
    expect(since.children.startsWith('since '), `since text ${since.children}`).toBe(true)
    expect(since.children.includes('Invalid Date')).toBe(false)
    const retained = find(panel, (node) => node['data-weir-file-lease-retained'] === 'src/a.txt')
    expect(retained.children).toBe('retained for 11 more min')
    // Section 2: the other holders here, by label.
    const othersSection = find(panel, (node) => node['data-weir-file-lease-section'] === 'others')
    const otherRows = findAll(othersSection, (node) => node['data-weir-file-lease-row'] === 'others')
    expect(otherRows).toHaveLength(2)
    expect(find(othersSection, (node) => node['data-weir-file-lease-holder'] === 'c.txt').children).toBe('reviewer')
    expect(find(othersSection, (node) => node['data-weir-file-lease-holder'] === 'd.txt').children).toBe('writer')
    // And the hint that says, in words, that nothing here is an action.
    expect(find(panel, (node) => node['data-weir-file-lease-hint'] !== undefined).children).toBe("Read-only: ownership changes only through the assistant's tools. Nothing here is an action.")
  })

  it('renders no button, no command input and no clickable row inside the panel', async () => {
    const view = viewOf({
      mine: [mineRow('a.txt', { holdUntil: Date.now() + 300_000 })],
      others: [otherRow('b.txt')],
    })
    const { render } = await mounted({ views: [view] })
    badgeOf(render()).onClick()
    await flush()
    const tree = render()
    const panel = panelOf(tree)
    const controls = new Set(['button', 'input', 'textarea', 'select', 'a', 'form', 'details', 'summary'])
    for (const node of elements(panel)) {
      expect(controls.has(node.__type), `panel node <${String(node.__type)}> is not an action control`).toBe(false)
      expect(node.onClick, `panel node <${String(node.__type)}> carries no click handler`).toBeUndefined()
      expect(node.onSubmit, `panel node <${String(node.__type)}> carries no submit handler`).toBeUndefined()
      expect(node.role === 'button', 'no element pretends to be a button').toBe(false)
      expect(String(node.__type) === 'div' || String(node.__type) === 'span', `panel renders only static elements, saw <${String(node.__type)}>`).toBe(true)
    }
    // Expanded or not, the ONLY clickable thing in the whole entry is the
    // expand/collapse badge itself (the single interaction the surface allows).
    const clickable = findAll(tree, (node) => typeof node.onClick === 'function')
    expect(clickable).toHaveLength(1)
    expect(clickable[0]['data-weir-file-lease']).toBe('')
    expect(findAll(tree, (node) => node.__type === 'button')).toHaveLength(1)
    // No command bridge, no action marker, no confirmation text.
    expect(find(tree, (node) => node['data-weir-edit-lock-action'] !== undefined)).toBe(undefined)
    expect(find(tree, (node) => node['data-weir-file-lease-action'] !== undefined)).toBe(undefined)
  })

  it('reads the view on mount and re-reads each time the panel opens — never on a poll', async () => {
    const { render, reads } = await mounted({ views: [viewOf(), viewOf({ mine: [mineRow('a.txt')] })] })
    expect(reads).toHaveLength(1)
    badgeOf(render()).onClick()
    await flush()
    expect(reads).toHaveLength(2)
    expect(badgeOf(render())['data-weir-file-lease-state']).toBe('holding')
    // Collapsing does not read again; the snapshot is the panel's only input.
    badgeOf(render()).onClick()
    await flush()
    expect(reads).toHaveLength(2)
    expect(panelOf(render())).toBe(undefined)
  })

  it('collapses on Escape, on the badge again, and on a pointerdown outside', async () => {
    const document = createDocument()
    try {
      const { render } = await mounted({ views: [viewOf({ mine: [mineRow('a.txt')] })], document })
      badgeOf(render()).onClick()
      await flush()
      expect(panelOf(render())).not.toBe(undefined)
      // Escape (document level): works wherever focus happens to be.
      document.fire('keydown', { key: 'Escape' })
      await flush()
      expect(panelOf(render())).toBe(undefined)
      expect(document.count('keydown')).toBe(0)
      // Escape from inside the panel as well.
      badgeOf(render()).onClick()
      await flush()
      panelOf(render()).onKeyDown({ key: 'Escape' })
      await flush()
      expect(panelOf(render())).toBe(undefined)
      // A pointerdown INSIDE the entry leaves it open …
      const doc2 = createDocument()
      globalThis.document = doc2
      badgeOf(render()).onClick()
      await flush()
      doc2.fire('pointerdown', { target: { closest: (sel) => (sel === '[data-weir-file-lease-root]' ? {} : null) } })
      await flush()
      expect(panelOf(render())).not.toBe(undefined)
      // … and one outside dismisses it.
      doc2.fire('pointerdown', { target: { closest: () => null } })
      await flush()
      expect(panelOf(render())).toBe(undefined)
      expect(doc2.count('pointerdown')).toBe(0)
      // Clicking the badge again is the third and last way out.
      badgeOf(render()).onClick()
      await flush()
      expect(panelOf(render())).not.toBe(undefined)
      badgeOf(render()).onClick()
      await flush()
      expect(panelOf(render())).toBe(undefined)
    } finally {
      delete (/** @type {any} */ (globalThis)).document
    }
  })

  it('says "nothing held" only when it can, and degrades on an unreadable read', async () => {
    const failing = await mounted({ fetchView: async () => { throw new Error('view endpoint unreachable') } })
    const tree = failing.render()
    expect(badgeOf(tree)['data-weir-file-lease-state']).toBe('degraded')
    badgeOf(tree).onClick()
    await flush()
    const arbiter = find(panelOf(failing.render()), (node) => node['data-weir-file-lease-arbiter'] !== undefined)
    expect(arbiter['data-weir-file-lease-arbiter']).toBe('unavailable')
    // A composition root without the verb degrades too; it never throws.
    const { exports, reactStub } = await load()
    reactStub.begin()
    const orphan = exports.FileLeaseBadge({ sessionId: 's1', t: (key) => key })
    reactStub.begin()
    const orphanBadge = find(orphan, (node) => node['data-weir-file-lease-state'] !== undefined)
    expect(orphanBadge['data-weir-file-lease-state']).toBe('none')
    expect(exports.FileLeaseBadge({ sessionId: '', t: (key) => key })).toBe(null)
  })

  it('renders the empty-section guidance instead of a bare heading', async () => {
    const { render } = await mounted({ views: [viewOf()] })
    badgeOf(render()).onClick()
    await flush()
    const panel = panelOf(render())
    expect(find(panel, (node) => node['data-weir-file-lease-empty'] === 'mine').children).toBe('This session holds no files.')
    expect(find(panel, (node) => node['data-weir-file-lease-empty'] === 'others').children).toBe('No other session holds a file here.')
    expect(find(panel, (node) => node['data-weir-file-lease-section'] === 'mine')).toBe(undefined)
  })
})
