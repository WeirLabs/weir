import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

// client.file-lease-badge.js: the read-only edit-lock Badge (edit-lock rebuild
// task 3.7, design D13 / spec "Read-only ownership presentation").
//
// What is pinned here is the PRODUCT SHAPE of the surface, not its internals:
//
//  - an idle badge is just its name. A fact is appended only when there is one
//    (how many files this session holds, or that protection is off) — never a
//    status word standing in for "nothing", and never internal vocabulary;
//  - the panel speaks only when there is something to say: ONE line when
//    nothing is held anywhere, one heading + rows per non-empty group, and the
//    protection notice only when protection is degraded. No headings over
//    empty lists, no `since` tail, no disclaimer about the absent actions;
//  - the detail contains NO action control at all — no button, no command
//    input, no confirmation step, no clickable row. Expand/collapse is the one
//    and only interaction in the chunk, so the clickable set of the whole tree
//    must be exactly the badge;
//  - both locales ship inside the chunk data face (the entry registers them on
//    arrival; a chunk never calls ctx), with the copy fixed word for word.

/** The user-facing copy, verbatim — the acceptance table of the redesign. */
const COPY = {
  en: {
    fileLeaseLabel: 'Edit Lock',
    fileLeaseTitle: 'Files in use',
    fileLeasePanelTitle: 'Files in use',
    fileLeaseState_holding: ' · {n}',
    fileLeaseState_degraded: ' · unprotected',
    fileLeaseMine: 'You are editing',
    fileLeaseOthers: 'Another session is editing',
    fileLeaseEmpty: 'No files in use.',
    fileLeaseDegradedHint: 'Protection is temporarily unavailable; editing continues.',
    fileLeaseRetainedFor: '{n} min left',
  },
  zh: {
    fileLeaseLabel: '编辑锁',
    fileLeaseTitle: '文件占用',
    fileLeasePanelTitle: '文件占用',
    fileLeaseState_holding: ' · {n}',
    fileLeaseState_degraded: ' · 未加锁',
    fileLeaseMine: '你正在编辑',
    fileLeaseOthers: '其他会话正在编辑',
    fileLeaseEmpty: '暂无文件占用。',
    fileLeaseDegradedHint: '保护暂不可用，编辑不受影响。',
    fileLeaseRetainedFor: '保留 {n} 分钟',
  },
}

/** Keys the redesign retired outright; none of them may come back. */
const RETIRED_KEYS = [
  'fileLeaseState_none',
  'fileLeaseMineEmpty',
  'fileLeaseOthersEmpty',
  'fileLeaseArbiter_ok',
  'fileLeaseArbiter_degraded',
  'fileLeaseArbiter_unavailable',
  'fileLeaseSince',
  'fileLeaseReadOnlyHint',
]

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

/** The text a reader sees in one subtree, in render order. */
function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

/** Every text run of a tree, in render order (what a reader would read). */
function textsOf(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) textsOf(item, out)
    return out
  }
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (!node || typeof node !== 'object') return out
  textsOf(node.children, out)
  return out
}

/** Every user-visible string of a tree: text runs plus the accessible names. */
function visibleStringsOf(node) {
  const strings = textsOf(node)
  for (const element of elements(node)) {
    if (typeof element.title === 'string') strings.push(element.title)
    if (typeof element['aria-label'] === 'string') strings.push(element['aria-label'])
  }
  return strings
}

const badgeOf = (/** @type {any} */ tree) => find(tree, (node) => node['data-weir-file-lease'] === '')
const panelOf = (/** @type {any} */ tree) => find(tree, (node) => node['data-weir-file-lease-panel'] !== undefined)
const blocksOf = (/** @type {any} */ panel) => (Array.isArray(panel.children) ? panel.children : [panel.children]).filter((node) => node !== null && node !== undefined)

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

/** Mount, then open the panel and hand back the settled tree. */
async function opened(options) {
  const harness = await mounted(options)
  badgeOf(harness.render()).onClick()
  await flush()
  return { ...harness, tree: harness.render() }
}

const zhOf = (/** @type {any} */ exports) => (/** @type {string} */ key) => exports.dictionaries.zh[key] ?? key

describe('client.file-lease-badge chunk', () => {
  it('loads as one ModuleLoader chunk and ships the copy key for key in both locales', async () => {
    const { definition, exports } = await load()
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.file-lease-badge.js')
    expect(typeof exports.FileLeaseBadge).toBe('function')
    expect(typeof exports.dictionaries.en).toBe('object')
    expect(typeof exports.dictionaries.zh).toBe('object')
    // en/zh parity: the entry registers both from this one data face, so a key
    // present in one locale only would render the raw key in the other.
    expect(Object.keys(exports.dictionaries.en).sort()).toEqual(Object.keys(COPY.en).sort())
    expect(Object.keys(exports.dictionaries.zh).sort()).toEqual(Object.keys(COPY.zh).sort())
    // …and the strings are the acceptance table, word for word.
    for (const locale of ['en', 'zh']) {
      for (const [key, text] of Object.entries(COPY[locale])) {
        expect(exports.dictionaries[locale][key], `${locale}.${key}`).toBe(text)
      }
    }
    // The retired copy stays retired: no status words, no arbiter lines, no
    // empty-section guidance, no `since` tail and no read-only disclaimer.
    for (const key of RETIRED_KEYS) {
      expect(exports.dictionaries.en[key], `en.${key} must stay retired`).toBeUndefined()
      expect(exports.dictionaries.zh[key], `zh.${key} must stay retired`).toBeUndefined()
    }
  })

  it('renders exactly three states and never a status word for the idle one', async () => {
    const { exports } = await load()
    expect(exports.stateOf(viewOf())).toBe('none')
    expect(exports.stateOf(viewOf({ mine: [mineRow('a.txt'), mineRow('b.txt'), mineRow('c.txt')] }))).toBe('holding')
    expect(exports.stateOf(viewOf({ arbiter: 'degraded' }))).toBe('degraded')
    expect(exports.stateOf(viewOf({ arbiter: 'unavailable' }))).toBe('degraded')
    // An unreadable view is never "nothing held": that would state a fact the
    // panel cannot vouch for.
    expect(exports.stateOf(null)).toBe('degraded')
    expect(exports.stateOf({})).toBe('degraded')

    // Idle: the badge is just its name, with no status word and no suffix.
    const idle = await mounted({ views: [viewOf()] })
    const idleTree = idle.render()
    expect(idleTree.__type).toBe('span')
    expect(badgeOf(idleTree)['data-weir-file-lease-state']).toBe('none')
    expect(textOf(badgeOf(idleTree))).toBe('Edit Lock')
    expect(find(idleTree, (node) => node['data-weir-file-lease-summary'] !== undefined)).toBeUndefined()

    // Holding: the count, appended to the name.
    const holding = await mounted({ views: [viewOf({ mine: [mineRow('a.txt'), mineRow('b.txt')] })] })
    const holdingTree = holding.render()
    expect(badgeOf(holdingTree)['data-weir-file-lease-state']).toBe('holding')
    expect(textOf(badgeOf(holdingTree))).toBe('Edit Lock · 2')
    expect(find(holdingTree, (node) => node['data-weir-file-lease-summary'] !== undefined).children).toBe(' · 2')

    // Degraded: the one word that says protection is off.
    const degraded = await mounted({ views: [viewOf({ arbiter: 'degraded' })] })
    const degradedTree = degraded.render()
    expect(badgeOf(degradedTree)['data-weir-file-lease-state']).toBe('degraded')
    expect(textOf(badgeOf(degradedTree))).toBe('Edit Lock · unprotected')
    expect(badgeOf(degradedTree).title).toBe('Files in use')

    // The same three states in Chinese.
    const { exports: loaded } = await load()
    const zh = zhOf(loaded)
    const idleZh = await mounted({ views: [viewOf()], t: zh })
    expect(textOf(badgeOf(idleZh.render()))).toBe('编辑锁')
    const holdingZh = await mounted({ views: [viewOf({ mine: [mineRow('a.txt'), mineRow('b.txt')] })], t: zh })
    expect(textOf(badgeOf(holdingZh.render()))).toBe('编辑锁 · 2')
    const degradedZh = await mounted({ views: [viewOf({ arbiter: 'unavailable' })], t: zh })
    expect(textOf(badgeOf(degradedZh.render()))).toBe('编辑锁 · 未加锁')
    expect(badgeOf(degradedZh.render()).title).toBe('文件占用')
  })

  it('says one line — and nothing else — when no file is held anywhere', async () => {
    const { exports } = await load()
    const en = await opened({ views: [viewOf()] })
    const panel = panelOf(en.tree)
    expect(panel.__type).toBe('div')
    expect(panel.role).toBe('dialog')
    expect(panel['aria-label']).toBe('Files in use')
    // Exactly one block, and it is the plain empty line.
    const blocks = blocksOf(panel)
    expect(blocks).toHaveLength(1)
    expect(textOf(panel)).toBe('No files in use.')
    expect(blocks[0]['data-weir-file-lease-empty']).toBe('')
    // No section skeleton, no protection line, no tail, no disclaimer.
    for (const hook of ['data-weir-file-lease-section', 'data-weir-file-lease-row', 'data-weir-file-lease-arbiter', 'data-weir-file-lease-since', 'data-weir-file-lease-hint', 'data-weir-file-lease-retained', 'data-weir-file-lease-holder']) {
      expect(find(panel, (node) => node[hook] !== undefined), `${hook} is absent on an idle panel`).toBeUndefined()
    }
    expect(textsOf(panel)).toEqual(['No files in use.'])

    // The same in Chinese, with the Chinese accessible name.
    const zh = zhOf(exports)
    const zhOpened = await opened({ views: [viewOf()], t: zh })
    expect(panelOf(zhOpened.tree)['aria-label']).toBe('文件占用')
    expect(textsOf(panelOf(zhOpened.tree))).toEqual(['暂无文件占用。'])
  })

  it('lists this session\'s files under one heading, with the retention tail and no timestamp', async () => {
    const holdUntil = Date.now() + 10 * 60_000 + 30_000
    const view = viewOf({ mine: [mineRow('src/a.txt', { holdUntil }), mineRow('b.txt')] })
    const en = await opened({ views: [view] })
    const panel = panelOf(en.tree)
    // Order: heading, then the rows.
    const blocks = blocksOf(panel)
    expect(blocks).toHaveLength(2)
    expect(textOf(blocks[0])).toBe('You are editing')
    const mineSection = find(panel, (node) => node['data-weir-file-lease-section'] === 'mine')
    expect(mineSection).not.toBeUndefined()
    const rows = findAll(mineSection, (node) => node['data-weir-file-lease-row'] === 'mine')
    expect(rows).toHaveLength(2)
    // The chunk renders the server's order verbatim (the view sorts; a second
    // ordering rule here could disagree with the panel's own tests).
    expect(rows[0].children[0].children).toBe('src/a.txt')
    expect(rows[1].children[0].children).toBe('b.txt')
    // The tail is the retention only: whole minutes, no "since" clock, and the
    // plain file is bare.
    expect(find(panel, (node) => node['data-weir-file-lease-since'] !== undefined)).toBeUndefined()
    expect(textOf(rows[0])).toBe('src/a.txt11 min left')
    expect(find(rows[0], (node) => node['data-weir-file-lease-retained'] === 'src/a.txt').children).toBe('11 min left')
    expect(find(rows[1], (node) => node['data-weir-file-lease-retained'] !== undefined)).toBeUndefined()
    // Nothing else: no other-holder heading, no empty line, no disclaimer.
    expect(textOf(panel).includes('Another session is editing')).toBe(false)
    expect(find(panel, (node) => node['data-weir-file-lease-empty'] !== undefined)).toBeUndefined()
    expect(find(panel, (node) => node['data-weir-file-lease-hint'] !== undefined)).toBeUndefined()
    expect(find(panel, (node) => node['data-weir-file-lease-arbiter'] !== undefined)).toBeUndefined()

    // Chinese renders the same two strings from its own data face.
    const doneZh = await opened({ views: [view], t: zhOf(en.exports) })
    const blocksZh = blocksOf(panelOf(doneZh.tree))
    expect(textOf(blocksZh[0])).toBe('你正在编辑')
    expect(textOf(blocksZh[1])).toBe('src/a.txt保留 11 分钟b.txt')
  })

  it('lists the other holders by label, and omits the empty self section entirely', async () => {
    const view = viewOf({ others: [otherRow('c.txt'), otherRow('d.txt', { holder: { label: 'writer', session: 'sess-c' } })] })
    const en = await opened({ views: [view] })
    const panel = panelOf(en.tree)
    const blocks = blocksOf(panel)
    expect(blocks).toHaveLength(2)
    expect(textOf(blocks[0])).toBe('Another session is editing')
    const othersSection = find(panel, (node) => node['data-weir-file-lease-section'] === 'others')
    expect(othersSection).not.toBeUndefined()
    expect(findAll(othersSection, (node) => node['data-weir-file-lease-row'] === 'others')).toHaveLength(2)
    expect(find(othersSection, (node) => node['data-weir-file-lease-holder'] === 'c.txt').children).toBe('reviewer')
    expect(find(othersSection, (node) => node['data-weir-file-lease-holder'] === 'd.txt').children).toBe('writer')
    // No self section, no empty line, no disclaimer.
    expect(find(panel, (node) => node['data-weir-file-lease-section'] === 'mine')).toBeUndefined()
    expect(find(panel, (node) => node['data-weir-file-lease-empty'] !== undefined)).toBeUndefined()
    expect(find(panel, (node) => node['data-weir-file-lease-hint'] !== undefined)).toBeUndefined()

    const zh = await opened({ views: [view], t: zhOf(en.exports) })
    expect(textOf(blocksOf(panelOf(zh.tree))[0])).toBe('其他会话正在编辑')
  })

  it('shows the protection notice only when protection is degraded, and says editing continues', async () => {
    // Degraded + nothing held: the notice, then the one plain line.
    const degraded = await opened({ views: [viewOf({ arbiter: 'degraded' })] })
    const panel = panelOf(degraded.tree)
    const notice = find(panel, (node) => node['data-weir-file-lease-arbiter'] !== undefined)
    expect(notice['data-weir-file-lease-arbiter']).toBe('degraded')
    expect(notice.children).toBe('Protection is temporarily unavailable; editing continues.')
    expect(notice.onClick).toBeUndefined()
    const blocks = blocksOf(panel)
    expect(blocks).toHaveLength(2)
    expect(textOf(blocks[0])).toBe('Protection is temporarily unavailable; editing continues.')
    expect(textOf(blocks[1])).toBe('No files in use.')
    // A failed read is the same state, worded for "unavailable".
    const failing = await opened({ fetchView: async () => { throw new Error('view endpoint unreachable') } })
    expect(badgeOf(failing.tree)['data-weir-file-lease-state']).toBe('degraded')
    expect(find(panelOf(failing.tree), (node) => node['data-weir-file-lease-arbiter'] !== undefined)['data-weir-file-lease-arbiter']).toBe('unavailable')
    // Healthy protection never renders the notice at all — not even as an
    // "everything is fine" line.
    const healthy = await opened({ views: [viewOf({ mine: [mineRow('a.txt')] })] })
    expect(find(panelOf(healthy.tree), (node) => node['data-weir-file-lease-arbiter'] !== undefined)).toBeUndefined()
    expect(textOf(panelOf(healthy.tree)).includes('Protection')).toBe(false)

    // Chinese: the notice, then the empty line, and the notice sits above a
    // non-empty list too.
    const zh = await opened({ views: [viewOf({ arbiter: 'unavailable', mine: [mineRow('a.txt')] })], t: zhOf((await load()).exports) })
    const zhStrings = textsOf(panelOf(zh.tree))
    expect(zhStrings[0]).toBe('保护暂不可用，编辑不受影响。')
    expect(zhStrings[1]).toBe('你正在编辑')
    expect(zhStrings[2]).toBe('a.txt')
  })

  it('never shows internal vocabulary and never explains what cannot be clicked', async () => {
    const { exports } = await load()
    const views = [
      viewOf(),
      viewOf({ mine: [mineRow('a.txt', { holdUntil: Date.now() + 120_000 })], others: [otherRow('b.txt')] }),
      viewOf({ arbiter: 'degraded' }),
    ]
    const forbidden = ['仲裁器', '所有权', '只读', 'arbiter', 'ownership', 'read-only']
    for (const t of [null, zhOf(exports)]) {
      for (const view of views) {
        const { tree } = await opened({ views: [view], t })
        const strings = visibleStringsOf(tree)
        for (const text of strings) {
          for (const word of forbidden) {
            expect(text.toLowerCase().includes(word), `"${text}" leaks "${word}"`).toBe(false)
          }
        }
      }
    }
    // The dictionaries themselves carry no such word either.
    for (const locale of ['en', 'zh']) {
      for (const [key, text] of Object.entries(exports.dictionaries[locale])) {
        for (const word of forbidden) {
          expect(text.toLowerCase().includes(word), `${locale}.${key} leaks "${word}"`).toBe(false)
        }
      }
    }
  })

  it('renders no button, no command input and no clickable row inside the panel', async () => {
    const views = [
      viewOf(),
      viewOf({ mine: [mineRow('a.txt', { holdUntil: Date.now() + 300_000 })], others: [otherRow('b.txt')] }),
      viewOf({ arbiter: 'unavailable' }),
    ]
    for (const view of views) {
      const { tree } = await opened({ views: [view] })
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
      expect(find(tree, (node) => node['data-weir-edit-lock-action'] !== undefined)).toBeUndefined()
      expect(find(tree, (node) => node['data-weir-file-lease-action'] !== undefined)).toBeUndefined()
    }
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
    expect(panelOf(render())).toBeUndefined()
  })

  it('collapses on Escape, on the badge again, and on a pointerdown outside', async () => {
    const document = createDocument()
    try {
      const { render } = await mounted({ views: [viewOf({ mine: [mineRow('a.txt')] })], document })
      badgeOf(render()).onClick()
      await flush()
      expect(panelOf(render())).not.toBeUndefined()
      // Escape (document level): works wherever focus happens to be.
      document.fire('keydown', { key: 'Escape' })
      await flush()
      expect(panelOf(render())).toBeUndefined()
      expect(document.count('keydown')).toBe(0)
      // Escape from inside the panel as well.
      badgeOf(render()).onClick()
      await flush()
      panelOf(render()).onKeyDown({ key: 'Escape' })
      await flush()
      expect(panelOf(render())).toBeUndefined()
      // A pointerdown INSIDE the entry leaves it open …
      const doc2 = createDocument()
      globalThis.document = doc2
      badgeOf(render()).onClick()
      await flush()
      doc2.fire('pointerdown', { target: { closest: (sel) => (sel === '[data-weir-file-lease-root]' ? {} : null) } })
      await flush()
      expect(panelOf(render())).not.toBeUndefined()
      // … and one outside dismisses it.
      doc2.fire('pointerdown', { target: { closest: () => null } })
      await flush()
      expect(panelOf(render())).toBeUndefined()
      expect(doc2.count('pointerdown')).toBe(0)
      // Clicking the badge again is the third and last way out.
      badgeOf(render()).onClick()
      await flush()
      expect(panelOf(render())).not.toBeUndefined()
      badgeOf(render()).onClick()
      await flush()
      expect(panelOf(render())).toBeUndefined()
    } finally {
      delete (/** @type {any} */ (globalThis)).document
    }
  })

  it('stays idle before the first read settles, degrades without a read verb, and hides without a session', async () => {
    const { exports, reactStub } = await load()
    const en = (/** @type {string} */ key) => exports.dictionaries.en[key] ?? key
    // A composition root without the read verb cannot vouch for anything, so
    // it degrades — and it never throws.
    reactStub.begin()
    exports.FileLeaseBadge({ sessionId: 's1', t: en })
    reactStub.begin()
    const orphanTree = exports.FileLeaseBadge({ sessionId: 's1', t: en })
    expect(badgeOf(orphanTree)['data-weir-file-lease-state']).toBe('degraded')
    expect(textOf(badgeOf(orphanTree))).toBe('Edit Lock · unprotected')
    // No session: no surface at all.
    expect(exports.FileLeaseBadge({ sessionId: '', t: en })).toBe(null)
    // A read that has not settled yet must not claim an empty project on the
    // panel's behalf: the surface stays idle and says the one plain line.
    const pending = await mounted({ fetchView: () => new Promise(() => {}) })
    expect(badgeOf(pending.render())['data-weir-file-lease-state']).toBe('none')
    badgeOf(pending.render()).onClick()
    await flush()
    expect(textOf(panelOf(pending.render()))).toBe('No files in use.')
  })
})
