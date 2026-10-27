import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

// client.file-lease-tool-view.js: the read-only edit-lock conversation cards
// (openspec edit-lock-tool-cards, design D3), driven through a jsx/react stub
// and the REAL model chunk passed as `model` (composition-root prop
// injection, precedent: client-hash-edit-view.test.js).

/** Depth-first walk over the jsx-stub element tree. */
function* walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const entry of node) yield* walk(entry)
    return
  }
  yield node
  yield* walk(node.children)
}

/** Every visible string: element children and Badge labels. */
function strings(tree) {
  const out = []
  for (const node of walk(tree)) {
    if (typeof node.children === 'string' || typeof node.children === 'number') out.push(String(node.children))
    if (Array.isArray(node.children)) for (const child of node.children) if (typeof child === 'string') out.push(child)
    if (typeof node.label === 'string') out.push(node.label)
  }
  return out
}
const textOf = (tree) => strings(tree).join('\n')
const buttons = (tree) => [...walk(tree)].filter((node) => node.__type === 'button' || node.role === 'button' || node.__type === 'a' || node.__type === 'input' || node.onClick !== undefined)

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
  }
  const requireStub = (name) => {
    if (name === 'react') return reactStub
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ __type: type, ...(props ?? {}) }), jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }) }
    throw new Error(`unexpected require ${name}`)
  }
  const { definition, exports } = await loadClientChunk('lib/client.file-lease-tool-view.js', requireStub)
  const { exports: model } = await loadClientChunk('lib/client.file-lease-tool-model.js')
  return { definition, view: exports, model, reactStub }
}

const T = 1_780_000_000_000
const HOLDER = { label: 'reviewer', session: 'sess-b' }
const em = (tool, fields) => ({ editLock: { v: 1, tool, ...fields } })

/** One persisted outcome per tool state (the producer's shapes, design D1). */
const OUTCOMES = [
  ['edit_lock_acquire', 'claimed', { paths: ['src/a.js', 'src/b.js', 'src/c.js'] }],
  ['edit_lock_acquire', 'degraded', { code: 'transport', paths: ['src/a.js'] }],
  ['edit_lock_release', 'released', { released: ['src/a.js'], notOwned: ['src/b.js'] }],
  ['edit_lock_release', 'degraded', { code: 'transport', paths: ['src/a.js'] }],
  ['edit_lock_hold', 'held', { held: [{ path: 'src/a.js', holdUntil: T + 1_800_000 }] }],
  ['edit_lock_hold', 'degraded', { code: 'transport', paths: ['src/a.js'] }],
  ['edit_lock_status', 'status', { at: T, mine: [{ path: 'src/a.js', until: T + 87_000, retained: false }, { path: 'src/b.js', until: T + 1_200_000, retained: true }], others: [{ path: 'src/c.js', ...HOLDER, until: T + 42_000, lapsed: false }, { path: 'src/d.js', ...HOLDER, until: T - 1000, lapsed: true }] }],
  ['edit_lock_status', 'degraded', { code: 'transport' }],
  ['edit_lock_try_steal', 'pending', { path: 'src/a.js', requestId: 'req-1', holder: HOLDER, expiresAt: T + 60_000 }],
  ['edit_lock_try_steal', 'free', { path: 'src/a.js' }],
  ['edit_lock_try_steal', 'self', { path: 'src/a.js' }],
  ['edit_lock_try_steal', 'degraded', { code: 'transport', path: 'src/a.js' }],
  ['edit_lock_reply', 'transferred', { requestId: 'req-1', decision: 'release' }],
  ['edit_lock_reply', 'declined', { requestId: 'req-1', decision: 'keep' }],
  ['edit_lock_reply', 'degraded', { code: 'transport', requestId: 'req-1', decision: 'keep' }],
  ['edit_lock_watch', 'watching', { path: 'src/a.js', holder: HOLDER }],
  ['edit_lock_watch', 'free', { path: 'src/a.js' }],
  ['edit_lock_watch', 'self', { path: 'src/a.js' }],
  ['edit_lock_watch', 'released', { path: 'src/a.js' }],
  ['edit_lock_watch', 'reset', { path: 'src/a.js' }],
  ['edit_lock_watch', 'unsupported', { code: 'release-events-unsupported', path: 'src/a.js' }],
  ['edit_lock_watch', 'cancelled', { code: 'watch-cancelled', path: 'src/a.js' }],
  ['edit_lock_watch', 'degraded', { code: 'transport', path: 'src/a.js' }],
]

/** Render one card collapsed, then expanded (the disclosure toggles state). */
function render(view, reactStub, props) {
  reactStub.reset()
  reactStub.begin()
  const collapsed = view.FileLeaseToolRow(props)
  const toggle = collapsed.children.find((child) => child?.__type === 'button')
  toggle.onClick()
  reactStub.begin()
  const expanded = view.FileLeaseToolRow(props)
  return { collapsed, expanded }
}

const dictT = (dict) => (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : `MISSING:${key}`)

describe('client.file-lease-tool-view chunk', () => {
  it('is a weir-harness chunk exporting the card and en/zh dictionaries with identical key sets', async () => {
    const { definition, view } = await loadView()
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.file-lease-tool-view.js')
    expect(typeof view.FileLeaseToolRow).toBe('function')
    const en = Object.keys(view.dictionaries.en).sort()
    const zh = Object.keys(view.dictionaries.zh).sort()
    expect(en).toEqual(zh)
    expect(en.length).toBeGreaterThan(40)
    for (const key of en) {
      expect(key.startsWith('leaseTool'), key).toBe(true)
      expect(view.dictionaries.zh[key].length, `zh.${key}`).toBeGreaterThan(0)
    }
    // every state badge and tool title of the closed sets is translated
    const { exports: model } = await loadClientChunk('lib/client.file-lease-tool-model.js')
    for (const [tool, states] of Object.entries(model.LEASE_TOOL_STATES)) {
      expect(en.includes(`leaseToolTitle_${tool}`), tool).toBe(true)
      for (const state of states) expect(en.includes(model.stateKey(tool, state)), `${tool}/${state}`).toBe(true)
    }
    for (const state of ['running', 'failed', 'stopped', 'raw']) expect(en.includes(`leaseToolState_${state}`), state).toBe(true)
  })

  for (const [tool, state, fields] of OUTCOMES) {
    it(`${tool}/${state}: localized collapsed row and expanded detail, disclosure as the only control`, async () => {
      const { view, model, reactStub } = await loadView()
      for (const locale of ['en', 'zh']) {
        const dict = view.dictionaries[locale]
        const block = { meta: em(tool, { state, ...fields }), content: [{ type: 'text', text: `MODEL TEXT for ${tool}` }] }
        const { collapsed, expanded } = render(view, reactStub, { phase: 'result', block, cwd: '/w', t: dictT(dict), model })
        expect(collapsed['data-weir-lease-tool']).toBe(tool)
        expect(collapsed['data-weir-lease-state']).toBe(state)
        // every key the card read exists in this locale
        expect(textOf(expanded)).not.toContain('MISSING:')
        // title + badge, in the GUI language
        const row = collapsed.children.find((child) => child?.__type === 'button')
        expect(textOf(row)).toContain(dict[`leaseToolTitle_${tool}`])
        expect(textOf(row)).toContain(dict[model.stateKey(tool, state)])
        // the model's English text is only the hover title, never visible copy
        expect(row.title).toBe(`MODEL TEXT for ${tool}`)
        expect(textOf(expanded)).not.toContain('MODEL TEXT')
        // collapsed has no body; expanded has one, ending in the snapshot note
        expect([...walk(collapsed)].some((node) => node['data-weir-lease-body'] !== undefined)).toBe(false)
        const body = [...walk(expanded)].find((node) => node['data-weir-lease-body'] !== undefined)
        expect(body.children.length).toBeGreaterThan(1)
        expect(textOf(body)).toContain(dict.leaseToolSnapshot)
        // one disclosure button with aria-expanded, and nothing else actionable
        expect(buttons(collapsed)).toHaveLength(1)
        expect(buttons(expanded)).toHaveLength(1)
        expect(row['aria-expanded']).toBe(false)
        expect(buttons(expanded)[0]['aria-expanded']).toBe(true)
        expect(row.type).toBe('button')
      }
    })
  }

  it('acquire: primary path in mono with +N for the rest', async () => {
    const { view, model, reactStub } = await loadView()
    const block = { meta: em('edit_lock_acquire', { state: 'claimed', paths: ['src/a.js', 'src/b.js', 'src/c.js'] }) }
    const { collapsed, expanded } = render(view, reactStub, { phase: 'result', block, t: dictT(view.dictionaries.zh), model })
    const path = [...walk(collapsed)].find((node) => node['data-weir-lease-path'] !== undefined)
    expect(path.children).toBe('src/a.js')
    expect(path.style.fontFamily).toContain('monospace')
    expect([...walk(collapsed)].find((node) => node['data-weir-lease-more'] !== undefined).children).toBe('+2')
    for (const p of ['src/a.js', 'src/b.js', 'src/c.js']) expect(textOf(expanded)).toContain(p)
    expect(textOf(expanded)).toContain('本轮已申请')
  })

  it('watch watching: states who and what it waits for, and that the notice is not an ownership grant', async () => {
    const { view, model, reactStub } = await loadView()
    const block = { meta: em('edit_lock_watch', { state: 'watching', path: 'src/a.js', holder: HOLDER }) }
    for (const [locale, waiting, note] of [
      ['zh', '正在等待 reviewer（会话 sess-b）释放 src/a.js。', '释放后会收到一条通知；通知只代表可以重新争取，不代表已获得锁。'],
      ['en', 'Waiting for reviewer (session sess-b) to release src/a.js.', 'A release arrives as a notice. The notice only means the path can be claimed again — it is not an ownership grant.'],
    ]) {
      const { collapsed, expanded } = render(view, reactStub, { phase: 'result', block, t: dictT(view.dictionaries[locale]), model })
      // the meaning is visible without expanding
      expect(textOf(collapsed)).toContain(note)
      expect(textOf(expanded)).toContain(waiting)
      expect(textOf(collapsed)).toContain(view.dictionaries[locale].leaseToolState_watching)
    }
  })

  it('watch terminal outcomes are distinct and never read as an active wait', async () => {
    const { view, model, reactStub } = await loadView()
    const dict = view.dictionaries.en
    const seen = new Set()
    for (const state of ['free', 'self', 'released', 'reset', 'unsupported', 'cancelled', 'degraded']) {
      const block = { meta: em('edit_lock_watch', { state, path: 'src/a.js' }) }
      const { collapsed, expanded } = render(view, reactStub, { phase: 'result', block, t: dictT(dict), model })
      const badge = [...walk(collapsed)].find((node) => node['state'] === state && typeof node.label === 'string')
      seen.add(badge.label)
      expect(badge.label).not.toBe(dict.leaseToolState_watching)
      expect(textOf(expanded)).not.toContain(dict.leaseToolWatchNote)
      expect(textOf(expanded)).not.toContain('Waiting for')
    }
    expect(seen.size).toBe(7)
  })

  it('degraded reads as protection unavailable, not as a refusal or conflict', async () => {
    const { view, model, reactStub } = await loadView()
    const dict = view.dictionaries.zh
    const block = { meta: em('edit_lock_acquire', { state: 'degraded', code: 'transport', paths: ['src/a.js'] }) }
    const { collapsed, expanded } = render(view, reactStub, { phase: 'result', block, t: dictT(dict), model })
    expect(textOf(collapsed)).toContain('保护暂不可用')
    expect(textOf(expanded)).toContain('这不是冲突')
    expect(textOf(expanded)).not.toContain(dict.leaseToolState_failed)
    expect(model.colorOf('edit_lock_acquire', 'degraded')).not.toBe(model.colorOf('edit_lock_acquire', 'failed'))
  })

  it('status: counts in the row, holder and call-time deadlines in the body', async () => {
    const { view, model, reactStub } = await loadView()
    const dict = view.dictionaries.zh
    const [, , fields] = OUTCOMES.find(([tool, state]) => tool === 'edit_lock_status' && state === 'status')
    const block = { meta: em('edit_lock_status', { state: 'status', ...fields }) }
    const { collapsed, expanded } = render(view, reactStub, { phase: 'result', block, t: dictT(dict), model })
    expect(textOf(collapsed)).toContain('本会话 2 · 其他 2')
    const body = textOf(expanded)
    expect(body).toContain('本会话持有（2）')
    expect(body).toContain('其他会话持有（2）')
    expect(body).toContain('reviewer（会话 sess-b）')
    expect(body).toContain('已过期，可申请')
    expect(body).toContain(`读取于 ${new Date(T).toLocaleString()}`)
    expect(body).toContain(`保留至 ${new Date(T + 1_200_000).toLocaleString()}`)
  })

  it('try_steal pending: request id, holder and the call-time expiry', async () => {
    const { view, model, reactStub } = await loadView()
    const block = { meta: em('edit_lock_try_steal', { state: 'pending', path: 'src/a.js', requestId: 'req-1', holder: HOLDER, expiresAt: T + 60_000 }) }
    const { expanded } = render(view, reactStub, { phase: 'result', block, t: dictT(view.dictionaries.en), model })
    expect(textOf(expanded)).toContain('Request req-1 for src/a.js is waiting for reviewer (session sess-b) to answer.')
    expect(textOf(expanded)).toContain(new Date(T + 60_000).toLocaleString())
  })

  it('falls back readably without metadata: running, refused, interrupted, old history — never blank', async () => {
    const { view, model, reactStub } = await loadView()
    const dict = view.dictionaries.zh
    const t = dictT(dict)
    const argsRaw = JSON.stringify({ paths: ['/w/src/a.js', 'src/b.js'] })

    // still running: title, the argument paths (shortened), running badge
    const running = render(view, reactStub, { phase: 'start', block: { call: { name: 'edit_lock_acquire', argsRaw } }, cwd: '/w', toolName: 'edit_lock_acquire', t, model })
    expect(running.collapsed['data-weir-lease-state']).toBe('running')
    expect(textOf(running.collapsed)).toContain('申请编辑锁')
    expect(textOf(running.collapsed)).toContain('src/a.js')
    expect(textOf(running.collapsed)).toContain('+1')
    expect(textOf(running.collapsed)).toContain('进行中')
    expect(textOf(running.expanded)).toContain('正在等待结果…')

    // a refusal (thrown conflict): red, the requested paths, the raw error — no button
    const refusal = 'Refused: 1 of the requested path(s) are owned by another session.'
    const refused = render(view, reactStub, { phase: 'result', block: { isError: true, argsRaw, content: [{ type: 'text', text: refusal }] }, cwd: '/w', toolName: 'edit_lock_acquire', t, model })
    expect(refused.collapsed['data-weir-lease-state']).toBe('failed')
    expect(textOf(refused.collapsed)).toContain('已拒绝或失败')
    expect(textOf(refused.collapsed)).toContain('src/a.js')
    expect(textOf(refused.expanded)).toContain('请求的路径')
    expect(textOf(refused.expanded)).toContain(refusal)
    expect(buttons(refused.expanded)).toHaveLength(1)
    const badge = [...walk(refused.collapsed)].find((node) => node.state === 'failed')
    expect(badge.color).toContain('--dsw-alias-state-error-primary')

    // interrupted
    const stopped = render(view, reactStub, { phase: 'result', block: { isError: true, error: { code: 'interrupted' }, argsRaw: '{"file_path":"src/a.js"}' }, toolName: 'edit_lock_watch', t, model })
    expect(stopped.collapsed['data-weir-lease-state']).toBe('stopped')
    expect(textOf(stopped.expanded)).toContain('调用已中断。')

    // recorded before the cards existed: argument paths + the raw output
    const old = render(view, reactStub, { phase: 'result', block: { argsRaw: '{"file_path":"src/a.js"}', content: [{ type: 'text', text: 'Watching src/a.js for its next release' }] }, toolName: 'edit_lock_watch', t, model })
    expect(old.collapsed['data-weir-lease-state']).toBe('raw')
    expect(textOf(old.collapsed)).toContain('订阅释放')
    expect(textOf(old.collapsed)).toContain('src/a.js')
    expect(textOf(old.expanded)).toContain('记录的输出')
    expect(textOf(old.expanded)).toContain('Watching src/a.js for its next release')

    // malformed meta degrades to the same fallback
    const malformed = render(view, reactStub, { phase: 'result', block: { meta: em('edit_lock_watch', { state: 'pending' }), argsRaw: '{"file_path":"src/a.js"}', content: [{ type: 'text', text: 'x' }] }, toolName: 'edit_lock_watch', t, model })
    expect(malformed.collapsed['data-weir-lease-state']).toBe('raw')

    // a reply without meta names its request id from the arguments
    const reply = render(view, reactStub, { phase: 'start', block: { argsRaw: '{"request_id":"req-7","decision":"keep"}' }, toolName: 'edit_lock_reply', t, model })
    expect(textOf(reply.collapsed)).toContain('req-7')

    // even with nothing at all the card has a title and a state
    const bare = render(view, reactStub, { block: {}, toolName: 'edit_lock_status', t, model })
    expect(textOf(bare.collapsed)).toContain('编辑锁状态')
    expect(textOf(bare.collapsed)).toContain('进行中')
    for (const card of [running, refused, stopped, old, malformed, reply, bare]) {
      expect(textOf(card.expanded)).not.toContain('MISSING:')
      expect(textOf(card.expanded).length).toBeGreaterThan(0)
      expect(buttons(card.expanded)).toHaveLength(1)
    }
  })

  it('is a snapshot: the same persisted outcome renders the same card, with no polling hook', async () => {
    const { view, model, reactStub } = await loadView()
    const block = { meta: em('edit_lock_hold', { state: 'held', held: [{ path: 'src/a.js', holdUntil: T }] }) }
    const t = dictT(view.dictionaries.en)
    const first = render(view, reactStub, { phase: 'result', block, t, model })
    const second = render(view, reactStub, { phase: 'result', block, t, model })
    expect(textOf(second.expanded)).toBe(textOf(first.expanded))
    // the stub has no useEffect: a card that polled or subscribed would throw here
    expect(textOf(first.expanded)).toContain(`kept until ${new Date(T).toLocaleString()}`)
  })

  it('styles only with theme tokens', async () => {
    const { view, model, reactStub } = await loadView()
    const t = dictT(view.dictionaries.en)
    for (const [tool, state, fields] of OUTCOMES) {
      const { expanded } = render(view, reactStub, { phase: 'result', block: { meta: em(tool, { state, ...fields }) }, t, model })
      for (const node of walk(expanded)) {
        for (const value of Object.values(node.style ?? {})) {
          if (typeof value !== 'string') continue
          for (const match of value.matchAll(/var\((--[\w-]+)/g)) expect(match[1].startsWith('--dsw-'), `${tool}/${state}: ${match[1]}`).toBe(true)
          expect(/#[0-9a-f]{3,6}\b/i.test(value.replace(/var\([^)]*\)/g, '')), `${tool}/${state}: raw colour ${value}`).toBe(false)
        }
      }
    }
  })
})
