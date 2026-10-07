// Session blackboard panel (slice 2, tasks 2.3/2.4): the model chunk's wire
// channel against a mocked carrier (the panel's ctx.remote stand-in), the
// list shaping (group/filter/search), the token countdown, the contention →
// watch flow, poll-refresh staleness by updatedAt, and the editor draft —
// plus a view smoke test over the panel chunk's render states.
import { describe, expect, it, test } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

const loadModel = () => loadClientChunk('lib/client.blackboard-model.js')

/** A mocked carrier standing in for the gateway (ctx.remote): records every call and answers per method. */
function fakeRemote(handlers) {
  const calls = []
  const rawCall = (endpoint, payload) => {
    calls.push({ endpoint, payload })
    const method = endpoint.split('/')[1]
    const handler = handlers[method]
    if (!handler) return Promise.resolve({ ok: false, error: { code: 'gateway/invocation-unavailable', message: 'no active Remote method exports this endpoint' } })
    return Promise.resolve().then(() => handler(payload.args.args, payload.args.agentId))
  }
  return { calls, rawCall }
}

const okEnvelope = (value) => ({ ok: true, value })

const ROWS = [
  { key: 'alpha-map', entryType: 'map', summary: { fact: 'where things live', cost: '3 calls', reVerify: 'ls src' }, readCount: 4, subscribeCount: 1, updatedAt: 1000 },
  { key: 'beta-contract', entryType: 'contract', summary: { fact: 'what holds', cost: '1 experiment', reVerify: 'node t.js' }, readCount: 2, subscribeCount: 0, updatedAt: 2000 },
  { key: 'gamma-map', entryType: 'map', summary: { fact: 'second region', cost: '2 calls', reVerify: 'ls lib' }, readCount: 1, subscribeCount: 2, updatedAt: 3000 },
  { key: 'delta-deadend', entryType: 'deadend', summary: { fact: 'what does not work', cost: '1 spike', reVerify: 'git log' }, readCount: 7, subscribeCount: 0, updatedAt: 4000 },
]

describe('client.blackboard-model: wire channel against a mocked carrier', () => {
  it('sends every verb to POST /api/orreryBlackboard/<method> with { agentId, args } and folds the envelopes', async () => {
    const { exports: model } = await loadModel()
    const remote = fakeRemote({
      list: () => okEnvelope({ entries: [] }),
      read: () => okEnvelope({ entries: [] }),
      apply: () => okEnvelope({ acquired: true, token: 'tok-1', expiresAt: 9999 }),
      write: () => okEnvelope({ ok: true, revision: 1 }),
      remove: () => okEnvelope({ ok: true }),
    })
    const channel = model.createBlackboardChannel(remote.rawCall, 'session-1')
    await channel.list()
    await channel.list({ type: 'map', query: 'layout' })
    await channel.read(['a', 'b'])
    await channel.apply('alpha-map')
    await channel.write({ key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'body' })
    await channel.remove('k')
    expect(remote.calls.map((call) => call.endpoint)).toEqual([
      'orreryBlackboard/list', 'orreryBlackboard/list', 'orreryBlackboard/read',
      'orreryBlackboard/apply', 'orreryBlackboard/write', 'orreryBlackboard/remove',
    ])
    // the pinned wire shape: one JSON args object plus the agentId lookup,
    // wrapped in the gateway's single-args envelope
    expect(remote.calls[0].payload).toEqual({ args: { agentId: 'session-1', args: {} } })
    expect(remote.calls[1].payload).toEqual({ args: { agentId: 'session-1', args: { type: 'map', query: 'layout' } } })
    expect(remote.calls[2].payload).toEqual({ args: { agentId: 'session-1', args: { keys: ['a', 'b'] } } })
    expect(remote.calls[3].payload).toEqual({ args: { agentId: 'session-1', args: { key: 'alpha-map' } } })
    expect(remote.calls[4].payload).toEqual({ args: { agentId: 'session-1', args: { key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'body' } } })
    expect(remote.calls[5].payload).toEqual({ args: { agentId: 'session-1', args: { key: 'k' } } })
  })

  it('folds carrier failures and throws into { ok:false, error:{code,message} } — verbs never reject', async () => {
    const { exports: model } = await loadModel()
    const failing = fakeRemote({ list: () => ({ ok: false, error: { code: 'gateway/internal', message: 'blackboard remote is not offered (non-Orrery preset or unmounted bridge)' } }) })
    const channel = model.createBlackboardChannel(failing.rawCall, 's')
    const folded = await channel.list()
    expect(folded.ok).toBe(false)
    expect(folded.error.message).toContain('not offered')
    const throwing = model.createBlackboardChannel(() => Promise.reject(new Error('offline')), 's')
    expect((await throwing.list()).error.code).toBe('call-threw')
    const syncThrowing = model.createBlackboardChannel(() => { throw new Error('no connection') }, 's')
    const syncFolded = await syncThrowing.apply('k')
    expect(syncFolded).toEqual({ ok: false, error: { code: 'call-threw', message: 'no connection' } })
  })

  it('foldRemoteResult normalizes the envelope shapes defensively', async () => {
    const { exports: model } = await loadModel()
    expect(model.foldRemoteResult({ ok: true, value: 1 })).toEqual({ ok: true, value: 1 })
    expect(model.foldRemoteResult({ ok: false, error: { code: 'x', message: 'y' } })).toEqual({ ok: false, error: { code: 'x', message: 'y' } })
    expect(model.foldRemoteResult(null).ok).toBe(false)
    expect(model.foldRemoteResult({}).error.code).toBe('call-failed')
  })
})

describe('client.blackboard-model: wire channel slice-3 verbs', () => {
  it('sends the slice-3 verbs requestPromotion and markPromoted to the pinned endpoints', async () => {
    const { exports: model } = await loadModel()
    const remote = fakeRemote({
      requestPromotion: () => okEnvelope({ ok: true }),
      markPromoted: () => okEnvelope({ ok: true, destination: 'docs/spikes.md' }),
    })
    const channel = model.createBlackboardChannel(remote.rawCall, 'session-1')
    await channel.requestPromotion()
    await channel.markPromoted('alpha-map', 'docs/spikes.md')
    expect(remote.calls.map((call) => call.endpoint)).toEqual(['orreryBlackboard/requestPromotion', 'orreryBlackboard/markPromoted'])
    expect(remote.calls[0].payload).toEqual({ args: { agentId: 'session-1', args: {} } })
    expect(remote.calls[1].payload).toEqual({ args: { agentId: 'session-1', args: { key: 'alpha-map', destination: 'docs/spikes.md' } } })
  })
})

describe('client.blackboard-model: promotion (slice 3: button state, outcomes, promoted rows)', () => {
  it('promotionButtonState enables exactly when a non-promoted entry exists', async () => {
    const { exports: model } = await loadModel()
    expect(model.promotionButtonState([])).toEqual({ enabled: false, candidateCount: 0 })
    expect(model.promotionButtonState(ROWS)).toEqual({ enabled: true, candidateCount: 4 })
    const allPromoted = ROWS.map((row) => ({ ...row, promoted: { destination: 'docs/spikes.md', at: 1 } }))
    expect(model.promotionButtonState(allPromoted)).toEqual({ enabled: false, candidateCount: 0 })
    const mixed = [{ ...ROWS[0], promoted: { destination: 'agents-pointer', at: 2 } }, ROWS[1]]
    expect(model.promotionButtonState(mixed)).toEqual({ enabled: true, candidateCount: 1 })
  })

  it('entryRowOf normalizes the promoted marker defensively and applyOutcomeOf folds the promoted refusal', async () => {
    const { exports: model } = await loadModel()
    const row = model.entryRowOf({ ...ROWS[0], promoted: { destination: 'runtime-map', at: 42 } })
    expect(row.promoted).toEqual({ destination: 'runtime-map', at: 42 })
    expect(model.entryRowOf({ ...ROWS[0], promoted: 'garbage' }).promoted).toBeUndefined()
    expect(model.entryRowOf(ROWS[0]).promoted).toBeUndefined()
    expect(model.applyOutcomeOf(okEnvelope({ acquired: false, promoted: true, destination: 'docs/spikes.md' }))).toEqual({ kind: 'promoted', destination: 'docs/spikes.md' })
  })

  it('promotionOutcomeOf and markPromotedOutcomeOf fold the remote shapes', async () => {
    const { exports: model } = await loadModel()
    expect(model.promotionOutcomeOf(okEnvelope({ ok: true }))).toEqual({ kind: 'requested' })
    expect(model.promotionOutcomeOf({ ok: false, error: { message: 'main agent is not live' } })).toEqual({ kind: 'failed', message: 'main agent is not live' })
    expect(model.markPromotedOutcomeOf(okEnvelope({ ok: true, destination: 'docs/spikes.md' }))).toEqual({ kind: 'marked', destination: 'docs/spikes.md', already: false })
    expect(model.markPromotedOutcomeOf(okEnvelope({ ok: true, destination: 'docs/spikes.md', alreadyPromoted: true }))).toEqual({ kind: 'marked', destination: 'docs/spikes.md', already: true })
    expect(model.markPromotedOutcomeOf(okEnvelope({ ok: false, error: 'blackboard key "k" does not exist' })).kind).toBe('failed')
  })
})

describe('client.blackboard-model: outcome categorizers', () => {
  it('listOutcomeOf normalizes rows defensively and reports failures', async () => {
    const { exports: model } = await loadModel()
    const outcome = model.listOutcomeOf(okEnvelope({
      entries: [
        ...ROWS,
        { key: 'sparse' }, // missing everything else
      ],
    }))
    expect(outcome.kind).toBe('ok')
    expect(outcome.rows).toHaveLength(5)
    expect(outcome.rows[4]).toEqual({
      key: 'sparse', entryType: 'unknown',
      summary: { fact: '', cost: '', reVerify: '' },
      readCount: 0, subscribeCount: 0, updatedAt: 0,
    })
    expect(outcome.rows[0].content).toBeUndefined()
    expect(model.listOutcomeOf({ ok: false, error: { code: 'gateway/internal', message: 'down' } })).toEqual({ kind: 'failed', message: 'down' })
  })

  it('readOutcomeOf reports unknown keys by absence, never as an error', async () => {
    const { exports: model } = await loadModel()
    const withContent = { ...ROWS[0], content: 'full body' }
    const outcome = model.readOutcomeOf(okEnvelope({ entries: [withContent] }), ['alpha-map', 'ghost-key'])
    expect(outcome.kind).toBe('ok')
    expect(outcome.entries[0].content).toBe('full body')
    expect(outcome.missing).toEqual(['ghost-key'])
    expect(model.readOutcomeOf({ ok: false, error: { message: 'down' } }, ['a']).kind).toBe('failed')
  })

  it('applyOutcomeOf: acquired carries token+expiresAt, contention carries the holder and the auto-subscription', async () => {
    const { exports: model } = await loadModel()
    expect(model.applyOutcomeOf(okEnvelope({ acquired: true, token: 't', expiresAt: 1234 })))
      .toEqual({ kind: 'acquired', token: 't', expiresAt: 1234 })
    expect(model.applyOutcomeOf(okEnvelope({ acquired: false, holder: 'agent-b', subscribed: true })))
      .toEqual({ kind: 'contended', holder: 'agent-b', subscribed: true })
    expect(model.applyOutcomeOf({ ok: false, error: { message: 'down' } }).kind).toBe('failed')
  })

  it('writeOutcomeOf / removeOutcomeOf fold the remote’s { ok:false, error } domain failures into values', async () => {
    const { exports: model } = await loadModel()
    expect(model.writeOutcomeOf(okEnvelope({ ok: true, revision: 3 }))).toEqual({ kind: 'saved', revision: 3 })
    const noAuthority = model.writeOutcomeOf(okEnvelope({ ok: false, error: 'write authority for "k" is not held by this session; acquire it first' }))
    expect(noAuthority.kind).toBe('failed')
    expect(noAuthority.message).toContain('not held')
    expect(model.writeOutcomeOf({ ok: false, error: { message: 'down' } }).kind).toBe('failed')
    expect(model.removeOutcomeOf(okEnvelope({ ok: true }))).toEqual({ kind: 'removed' })
    expect(model.removeOutcomeOf(okEnvelope({ ok: false, error: 'blackboard key "k" does not exist' })).kind).toBe('failed')
  })
})

describe('client.blackboard-model: grouping, filter, search', () => {
  it('filters by exact entryType and by the kernel haystack (key + summary triple, case-insensitive)', async () => {
    const { exports: model } = await loadModel()
    expect(model.filterEntries(ROWS, { type: 'map' }).map((row) => row.key)).toEqual(['alpha-map', 'gamma-map'])
    expect(model.filterEntries(ROWS, { query: 'EXPERIMENT' }).map((row) => row.key)).toEqual(['beta-contract'])
    expect(model.filterEntries(ROWS, { query: 'git log' }).map((row) => row.key)).toEqual(['delta-deadend'])
    expect(model.filterEntries(ROWS, { query: 'alpha' }).map((row) => row.key)).toEqual(['alpha-map'])
    expect(model.filterEntries(ROWS, { type: 'map', query: 'second' }).map((row) => row.key)).toEqual(['gamma-map'])
    // empty/blank queries and unknown types filter nothing
    expect(model.filterEntries(ROWS, { query: '   ' })).toHaveLength(4)
    expect(model.filterEntries(ROWS, { type: 'nope' })).toHaveLength(4)
    expect(model.filterEntries(ROWS, {})).toHaveLength(4)
    expect(model.filterEntries(ROWS, { query: 'nothing matches this' })).toHaveLength(0)
  })

  it('groups by entryType in the enum order with key-sorted rows; unknown types trail', async () => {
    const { exports: model } = await loadModel()
    const exotic = { key: 'zzz-custom', entryType: 'custom-kind', summary: { fact: 'x', cost: '', reVerify: '' }, readCount: 0, subscribeCount: 0, updatedAt: 5000 }
    const groups = model.groupEntries([...ROWS, exotic])
    expect(groups.map((group) => group.type)).toEqual(['map', 'contract', 'deadend', 'custom-kind'])
    expect(groups[0].rows.map((row) => row.key)).toEqual(['alpha-map', 'gamma-map'])
    expect(groups[2].rows[0].key).toBe('delta-deadend')
    expect(model.groupEntries([])).toEqual([])
    expect(model.ENTRY_TYPES).toEqual(['map', 'contract', 'deadend', 'wiring', 'recipe', 'why'])
  })
})

describe('client.blackboard-model: token countdown', () => {
  it('held while the budget lasts, expired at zero', async () => {
    const { exports: model } = await loadModel()
    expect(model.tokenCountdownOf(10_000, 4_000)).toEqual({ phase: 'held', remainingMs: 6_000 })
    expect(model.tokenCountdownOf(10_000, 10_000)).toEqual({ phase: 'expired', remainingMs: 0 })
    expect(model.tokenCountdownOf(10_000, 10_001).phase).toBe('expired')
    expect(model.tokenCountdownOf(undefined, 0).phase).toBe('expired')
  })

  it('formats the remaining budget compactly', async () => {
    const { exports: model } = await loadModel()
    expect(model.formatRemainingMs(59_000)).toBe('59s')
    expect(model.formatRemainingMs(61_000)).toBe('1m 01s')
    expect(model.formatRemainingMs(2_520_000)).toBe('42m 00s')
    expect(model.formatRemainingMs(3_780_000)).toBe('1h 03m')
    expect(model.formatRemainingMs(0)).toBe('0s')
    expect(model.formatRemainingMs(-5)).toBe('0s')
  })
})

describe('client.blackboard-model: contention → subscribe-and-notify flow', () => {
  it('the full watch lifecycle against the mocked carrier: contended apply → watching → acquired flip releases with the expiry', async () => {
    const { exports: model } = await loadModel()
    // The key starts held by another agent, then frees.
    let free = false
    const remote = fakeRemote({
      apply: () => free
        ? okEnvelope({ acquired: true, token: 'tok-2', expiresAt: 88_000 })
        : okEnvelope({ acquired: false, holder: 'agent-b', subscribed: true }),
    })
    const channel = model.createBlackboardChannel(remote.rawCall, 'session-1')
    // 1. the user's edit click is contended — the server auto-subscribed us
    const first = model.applyOutcomeOf(await channel.apply('alpha-map'))
    expect(first).toEqual({ kind: 'contended', holder: 'agent-b', subscribed: true })
    // 2. the panel enters the watch state
    let watch = model.watchStart('alpha-map', first.holder)
    expect(watch).toEqual({ phase: 'watching', key: 'alpha-map', holder: 'agent-b', pollErrors: 0 })
    // 3. polls while contended keep watching (holder refreshes, no error debt)
    watch = model.watchAfterPoll(watch, model.applyOutcomeOf(await channel.apply('alpha-map')))
    expect(watch.phase).toBe('watching')
    expect(watch.holder).toBe('agent-b')
    // 4. the key frees: the poll's apply itself grants the authority
    free = true
    const flip = model.applyOutcomeOf(await channel.apply('alpha-map'))
    expect(flip.kind).toBe('acquired')
    watch = model.watchAfterPoll(watch, flip)
    expect(watch).toEqual({ phase: 'released', key: 'alpha-map', expiresAt: 88_000 })
    // 5. the countdown runs from the released expiry
    expect(model.tokenCountdownOf(watch.expiresAt, 80_000)).toEqual({ phase: 'held', remainingMs: 8_000 })
  })

  it('carrier failures count toward the give-up cap, then the watch fails explicitly', async () => {
    const { exports: model } = await loadModel()
    let watch = model.watchStart('k', 'agent-b')
    const failure = { kind: 'failed', message: 'offline' }
    watch = model.watchAfterPoll(watch, failure)
    expect(watch).toEqual({ phase: 'watching', key: 'k', holder: 'agent-b', pollErrors: 1 })
    watch = model.watchAfterPoll(watch, failure)
    expect(watch.pollErrors).toBe(2)
    watch = model.watchAfterPoll(watch, failure)
    expect(watch).toEqual({ phase: 'failed', key: 'k', message: 'offline' })
    // a successful contended poll resets the error debt
    let recovered = model.watchStart('k', 'agent-b')
    recovered = model.watchAfterPoll(recovered, failure)
    recovered = model.watchAfterPoll(recovered, { kind: 'contended', holder: 'agent-c', subscribed: true })
    expect(recovered).toEqual({ phase: 'watching', key: 'k', holder: 'agent-c', pollErrors: 0 })
    // a settled watch ignores further polls
    const released = { phase: 'released', key: 'k', expiresAt: 1 }
    expect(model.watchAfterPoll(released, failure)).toBe(released)
    expect(model.WATCH_GIVE_UP_AFTER).toBe(3)
  })
})

describe('client.blackboard-model: poll refresh staleness by updatedAt', () => {
  it('diffs listings into changed (updatedAt moved) and removed keys', async () => {
    const { exports: model } = await loadModel()
    const prev = [
      { key: 'a', updatedAt: 100 },
      { key: 'b', updatedAt: 200 },
      { key: 'c', updatedAt: 300 },
    ]
    const next = [
      { key: 'a', updatedAt: 100 }, // untouched
      { key: 'b', updatedAt: 250 }, // written elsewhere
      { key: 'd', updatedAt: 400 }, // new elsewhere
    ]
    expect(model.staleKeysOf(prev, next)).toEqual({ changed: ['b'], removed: ['c'] })
    expect(model.staleKeysOf([], next)).toEqual({ changed: [], removed: [] })
    expect(model.staleKeysOf(prev, prev)).toEqual({ changed: [], removed: [] })
  })

  it('the open detail re-reads only when its row moved; disappearance is the gone branch', async () => {
    const { exports: model } = await loadModel()
    const detail = { key: 'b', updatedAt: 200 }
    expect(model.detailNeedsReread(detail, [{ key: 'b', updatedAt: 250 }])).toBe(true)
    expect(model.detailNeedsReread(detail, [{ key: 'b', updatedAt: 200 }])).toBe(false)
    expect(model.detailNeedsReread(detail, [])).toBe(false) // absent row → view's gone branch, not a re-read
    expect(model.detailNeedsReread(null, [{ key: 'b', updatedAt: 250 }])).toBe(false)
  })
})

describe('client.blackboard-model: editor draft', () => {
  it('seeds empty/update drafts and validates against the kernel gate', async () => {
    const { exports: model } = await loadModel()
    expect(model.emptyEditorDraft()).toEqual({ key: '', entryType: 'map', fact: '', cost: '', reVerify: '', content: '' })
    const entry = {
      key: 'alpha-map', entryType: 'map',
      summary: { fact: 'f', cost: 'c', reVerify: 'r' },
      content: 'body', readCount: 1, subscribeCount: 0, updatedAt: 1,
    }
    expect(model.editorDraftFromEntry(entry)).toEqual({ key: 'alpha-map', entryType: 'map', fact: 'f', cost: 'c', reVerify: 'r', content: 'body' })
    // every required field named
    const blank = model.editorErrorsOf(model.emptyEditorDraft())
    expect(blank).toEqual({ key: 'required', fact: 'required', cost: 'required', reVerify: 'required', content: 'required' })
    // the kernel key rule: letter/digit first, then letters digits . _ - /
    expect(model.editorErrorsOf({ ...entry, key: '-bad' }).key).toBe('invalid')
    expect(model.editorErrorsOf({ ...entry, key: 'has space' }).key).toBe('invalid')
    expect(model.editorErrorsOf({ ...entry, entryType: 'nope' }).entryType).toBe('invalid')
    expect(model.editorErrorsOf(model.editorDraftFromEntry(entry))).toEqual({})
    // the write payload trims and re-assembles the summary triple
    expect(model.editorWritePayload({ key: ' k ', entryType: 'why', fact: ' f ', cost: ' c ', reVerify: ' r ', content: 'body' }))
      .toEqual({ key: 'k', entryType: 'why', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'body' })
  })
})

// ---- view smoke test: render states over the panel chunk ----

function makeReactStub(counts) {
  const reactState = []
  let hookCursor = 0
  return {
    reset() { reactState.length = 0 },
    begin() { hookCursor = 0 },
    useState(initial) {
      counts.useState += 1
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = [initial, (next) => {
        reactState[at][0] = typeof next === 'function' ? next(reactState[at][0]) : next
      }]
      return reactState[at]
    },
    useEffect(fn) {
      counts.useEffect += 1
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = { cleanup: fn() }
      return undefined
    },
    useMemo(fn) { return fn() },
    useRef(initial) {
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = { current: initial }
      return reactState[at]
    },
  }
}

const requireStubFor = (reactStub) => (name) => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return { jsx: (t, p) => ({ __type: t, ...(p ?? {}) }), jsxs: (t, p) => ({ __type: t, ...(p ?? {}) }) }
  throw new Error(`unexpected require ${name}`)
}

function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  return findAll(node.children, pred, out)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the panel renders loading → grouped list → detail → create form with a stable hook count', async () => {
  const counts = { useState: 0, useEffect: 0 }
  const reactStub = makeReactStub(counts)
  const { exports: model } = await loadModel()
  const { exports: panel } = await loadClientChunk('lib/client.blackboard-panel.js', requireStubFor(reactStub))
  const { BlackboardPanel } = panel
  const entry = { ...ROWS[0], content: 'the full evidence body' }
  const remote = fakeRemote({
    list: () => okEnvelope({ entries: ROWS }),
    read: () => okEnvelope({ entries: [entry] }),
  })
  const props = {
    sessionId: 's1',
    model,
    t: (key) => key, // every dictionary lookup "misses" → in-code fallbacks render
    callBoard: remote.rawCall,
    pollMs: 0, // no intervals under the synchronous effect stub
    watchMs: 0,
  }
  reactStub.reset()
  const renders = []
  const renderOnce = () => {
    counts.useState = 0
    counts.useEffect = 0
    reactStub.begin()
    const out = BlackboardPanel(props)
    renders.push(`${counts.useState}/${counts.useEffect}`)
    return out
  }

  // loading: the a11y status line announces the state
  renderOnce()
  await flush()
  const loaded = renderOnce()
  expect(findAll(loaded, (node) => node.children === '4 entries')).toHaveLength(1)
  // type filter chips: All + the six entry types (localizable labels → raw fallbacks here)
  expect(findAll(loaded, (node) => node['aria-pressed'] !== undefined)).toHaveLength(7)
  // group titles in enum order with counts (map ×2, contract ×1, deadend ×1)
  const groupTitles = findAll(loaded, (node) => node.style?.position === 'sticky')
  expect(groupTitles).toHaveLength(3)
  // rows carry the usage counts through the meta template
  expect(findAll(loaded, (node) => node.children === '4 reads · 1 watching')).toHaveLength(1)
  // the search input is present
  expect(findAll(loaded, (node) => node.placeholder === 'Search')).toHaveLength(1)

  // open the detail of the first row (rows render role="button")
  const row = findAll(loaded, (node) => node.role === 'button' && typeof node.onClick === 'function')[0]
  row.onClick()
  renderOnce() // mirror the detail ref before the read settles
  await flush()
  const detail = renderOnce()
  expect(findAll(detail, (node) => node.children === 'the full evidence body')).toHaveLength(1)
  expect(findAll(detail, (node) => node.children === 'Edit')).toHaveLength(1)
  expect(findAll(detail, (node) => node.children === 'Delete')).toHaveLength(1)
  // the summary triple labels render
  for (const label of ['Fact', 'Cost', 'Re-verify', 'Content']) {
    expect(findAll(detail, (node) => node.children === label).length).toBeGreaterThanOrEqual(1)
  }

  // back to the list, then open the create form
  const back = findAll(detail, (node) => node['aria-label'] === 'Back')[0]
  back.onClick()
  renderOnce()
  await flush()
  const listAgain = renderOnce()
  const createButton = findAll(listAgain, (node) => node['aria-label'] === 'New entry' && typeof node.onClick === 'function')[0]
  createButton.onClick()
  const form = renderOnce()
  // the type select offers the six enum values
  const typeSelect = findAll(form, (node) => node.__type === 'select')[0]
  expect(typeSelect.children.map((option) => option.value)).toEqual(['map', 'contract', 'deadend', 'wiring', 'recipe', 'why'])
  // saving an empty draft refuses client-side and names every required field
  const save = findAll(form, (node) => node.children === 'Save' && typeof node.onClick === 'function')[0]
  save.onClick()
  const validated = renderOnce()
  expect(findAll(validated, (node) => node.children === 'Required.').length).toBe(5)
  // no write ever hit the wire
  expect(remote.calls.filter((call) => call.endpoint === 'orreryBlackboard/write')).toHaveLength(0)

  // hook-count stability across every transition (React #310 guard)
  expect(new Set(renders).size).toBe(1)
  expect(renders[0]).toBe('14/7')
})

test('the panel settles the explicit unavailable state when the channel degrades', async () => {
  const counts = { useState: 0, useEffect: 0 }
  const reactStub = makeReactStub(counts)
  const { exports: model } = await loadModel()
  const { exports: panel } = await loadClientChunk('lib/client.blackboard-panel.js', requireStubFor(reactStub))
  const remote = fakeRemote({
    list: () => ({ ok: false, error: { code: 'gateway/internal', message: 'blackboard remote is not offered (non-Orrery preset or unmounted bridge)' } }),
  })
  const props = { sessionId: 's1', model, t: (key) => key, callBoard: remote.rawCall, pollMs: 0, watchMs: 0 }
  reactStub.reset()
  reactStub.begin()
  panel.BlackboardPanel(props)
  await flush()
  reactStub.begin()
  const rendered = panel.BlackboardPanel(props)
  // StatePanel is a function component the jsx stub never invokes — its
  // props (title/description/action) sit on the element object itself.
  const statePanels = findAll(rendered, (node) => node.title === 'Blackboard unavailable for this session.')
  expect(statePanels).toHaveLength(1)
  // the server's own failure text surfaces as the description
  expect(String(statePanels[0].description)).toContain('not offered')
  // and the retry affordance re-calls the listing
  statePanels[0].action.onClick()
  await flush()
  expect(remote.calls.filter((call) => call.endpoint === 'orreryBlackboard/list').length).toBeGreaterThanOrEqual(2)
})

test('the panel renders the promoted badge, disables editing, and gates the promotion button', async () => {
  const counts = { useState: 0, useEffect: 0 }
  const reactStub = makeReactStub(counts)
  const { exports: model } = await loadModel()
  const { exports: panel } = await loadClientChunk('lib/client.blackboard-panel.js', requireStubFor(reactStub))
  const { BlackboardPanel } = panel
  const promoted = { ...ROWS[0], promoted: { destination: 'docs/spikes.md', at: 5000 } }
  const rows = [promoted, ROWS[1]]
  const remote = fakeRemote({
    list: () => okEnvelope({ entries: rows }),
    read: () => okEnvelope({ entries: [{ ...promoted, content: 'durable copy already landed' }] }),
    requestPromotion: () => okEnvelope({ ok: true }),
  })
  const props = {
    sessionId: 's1',
    model,
    t: (key) => key,
    callBoard: remote.rawCall,
    pollMs: 0,
    watchMs: 0,
  }
  reactStub.reset()
  const renderOnce = () => {
    counts.useState = 0
    counts.useEffect = 0
    reactStub.begin()
    return BlackboardPanel(props)
  }
  renderOnce()
  await flush()
  const loaded = renderOnce()
  // The header shows the promotion button (a non-promoted entry exists) and the promoted row shows the badge.
  expect(findAll(loaded, (node) => node['aria-label'] === 'Evaluate for promotion')).toHaveLength(1)
  expect(findAll(loaded, (node) => node.children === 'promoted')).toHaveLength(1)
  // Open the promoted entry's detail: the badge renders, Edit/Delete are gone, the read-only note shows.
  const row = findAll(loaded, (node) => node.role === 'button' && typeof node.onClick === 'function')[0]
  row.onClick()
  renderOnce()
  await flush()
  const detail = renderOnce()
  expect(findAll(detail, (node) => node.children === 'promoted')).toHaveLength(1)
  expect(findAll(detail, (node) => node.children === 'Edit')).toHaveLength(0)
  expect(findAll(detail, (node) => node.children === 'Delete')).toHaveLength(0)
  expect(findAll(detail, (node) => typeof node.children === 'string' && node.children.includes('read-only'))).toHaveLength(1)
  // The promotion button works: clicking it calls requestPromotion and reports the notice.
  const promoteButton = findAll(loaded, (node) => node['aria-label'] === 'Evaluate for promotion')[0]
  promoteButton.onClick()
  await flush()
  const after = renderOnce()
  expect(findAll(after, (node) => typeof node.children === 'string' && node.children.includes('promotion-evaluation request'))).toHaveLength(1)
  expect(remote.calls.some((call) => call.endpoint === 'orreryBlackboard/requestPromotion')).toBe(true)
})
