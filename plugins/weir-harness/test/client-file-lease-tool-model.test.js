import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { LEASE_META_STATES, LEASE_META_VERSION } from '../src/file-lease/tools.js'

// client.file-lease-tool-model.js: the zero-dependency view-model of the
// edit-lock conversation cards (openspec edit-lock-tool-cards, design D2),
// driven with the default throwing require (zero stubs).

const load = async () => (await loadClientChunk('lib/client.file-lease-tool-model.js')).exports

describe('client.file-lease-tool-model chunk', () => {
  it('is a weir-harness chunk whose closed state sets mirror the producer', async () => {
    const { definition, exports } = await loadClientChunk('lib/client.file-lease-tool-model.js')
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.file-lease-tool-model.js')
    expect(exports.LEASE_META_VERSION).toBe(LEASE_META_VERSION)
    // Cross-side pin: the client narrows on exactly the host's closed sets.
    expect(JSON.parse(JSON.stringify(exports.LEASE_TOOL_STATES))).toEqual(JSON.parse(JSON.stringify(LEASE_META_STATES)))
    expect([...exports.LEASE_TOOLS].sort()).toEqual([
      'edit_lock_acquire', 'edit_lock_hold', 'edit_lock_release', 'edit_lock_reply', 'edit_lock_status', 'edit_lock_try_steal', 'edit_lock_watch',
    ])
  })

  it('narrows valid metadata for every tool and state', async () => {
    const { narrowLeaseMeta, LEASE_TOOL_STATES } = await load()
    for (const [tool, states] of Object.entries(LEASE_TOOL_STATES)) {
      for (const state of states) {
        const narrowed = narrowLeaseMeta({ editLock: { v: 1, tool, state } })
        expect(narrowed, `${tool}/${state}`).toBeTruthy()
        expect(narrowed.tool).toBe(tool)
        expect(narrowed.state).toBe(state)
      }
    }
  })

  it('keeps the detail fields and drops malformed entries inside them', async () => {
    const { narrowLeaseMeta } = await load()
    const status = narrowLeaseMeta({
      editLock: {
        v: 1,
        tool: 'edit_lock_status',
        state: 'status',
        at: 5,
        mine: [{ path: 'src/a.js', until: 10, retained: true }, { path: '' }, 'bad', { path: 'src/b.js', until: 'soon' }],
        others: [{ path: 'src/c.js', label: 'reviewer', session: 'sess-b', until: 20, lapsed: false }, { label: 'no path' }],
      },
    })
    expect(status.at).toBe(5)
    expect(status.mine).toEqual([{ path: 'src/a.js', until: 10, retained: true }, { path: 'src/b.js', until: null, retained: false }])
    expect(status.others).toEqual([{ path: 'src/c.js', label: 'reviewer', session: 'sess-b', until: 20, lapsed: false }])

    const pending = narrowLeaseMeta({ editLock: { v: 1, tool: 'edit_lock_try_steal', state: 'pending', path: 'src/a.js', requestId: 'req-1', holder: { label: 'reviewer', session: 'sess-b' }, expiresAt: 99 } })
    expect(pending.path).toBe('src/a.js')
    expect(pending.requestId).toBe('req-1')
    expect(pending.holder).toEqual({ label: 'reviewer', session: 'sess-b' })
    expect(pending.expiresAt).toBe(99)
    // a half holder is no holder
    expect(narrowLeaseMeta({ editLock: { v: 1, tool: 'edit_lock_watch', state: 'watching', holder: { label: 'x' } } }).holder).toBe(null)
    const held = narrowLeaseMeta({ editLock: { v: 1, tool: 'edit_lock_hold', state: 'held', held: [{ path: 'a', holdUntil: 7 }, { path: 'b', holdUntil: null }] } })
    expect(held.held).toEqual([{ path: 'a', holdUntil: 7 }, { path: 'b', holdUntil: null }])
    const reply = narrowLeaseMeta({ editLock: { v: 1, tool: 'edit_lock_reply', state: 'declined', requestId: 'r', decision: 'maybe' } })
    expect(reply.decision).toBe(null)
  })

  it('declines absent, foreign, versioned-away and out-of-set metadata', async () => {
    const { narrowLeaseMeta } = await load()
    for (const meta of [
      undefined,
      null,
      'meta',
      [],
      {},
      { diffs: [] },
      { worktree: { tool: 'worktree_open', state: 'ready' } },
      { editLock: null },
      { editLock: { tool: 'edit_lock_acquire', state: 'claimed' } },
      { editLock: { v: 2, tool: 'edit_lock_acquire', state: 'claimed' } },
      { editLock: { v: 1, tool: 'edit_lock_pause', state: 'claimed' } },
      { editLock: { v: 1, tool: 'toString', state: 'claimed' } },
      { editLock: { v: 1, tool: 'edit_lock_acquire', state: 'watching' } },
      { editLock: { v: 1, tool: 'edit_lock_watch', state: 'pending' } },
      { editLock: { v: 1, tool: 'edit_lock_watch' } },
    ]) {
      expect(narrowLeaseMeta(meta), JSON.stringify(meta)).toBe(null)
    }
  })

  it('assigns every state a tone class', async () => {
    const { colorOf, LEASE_TOOL_STATES } = await load()
    const expected = {
      edit_lock_acquire: { claimed: 'success', degraded: 'warn' },
      edit_lock_release: { released: 'success', degraded: 'warn' },
      edit_lock_hold: { held: 'success', degraded: 'warn' },
      edit_lock_status: { status: 'neutral', degraded: 'warn' },
      edit_lock_try_steal: { pending: 'wait', free: 'neutral', self: 'neutral', degraded: 'warn' },
      edit_lock_reply: { transferred: 'success', declined: 'neutral', degraded: 'warn' },
      edit_lock_watch: { watching: 'wait', free: 'neutral', self: 'neutral', released: 'neutral', reset: 'warn', unsupported: 'warn', cancelled: 'warn', degraded: 'warn' },
    }
    for (const [tool, states] of Object.entries(LEASE_TOOL_STATES)) {
      for (const state of states) expect(colorOf(tool, state), `${tool}/${state}`).toBe(expected[tool][state])
    }
    // the fallback states share the scale: a refusal is red, never amber
    expect(colorOf('edit_lock_acquire', 'failed')).toBe('danger')
    expect(colorOf('edit_lock_watch', 'running')).toBe('wait')
    expect(colorOf('edit_lock_watch', 'stopped')).toBe('neutral')
    expect(colorOf('edit_lock_watch', 'raw')).toBe('neutral')
  })

  it('names the watch release apart from the release tool', async () => {
    const { stateKey } = await load()
    expect(stateKey('edit_lock_watch', 'released')).toBe('leaseToolState_watch_released')
    expect(stateKey('edit_lock_release', 'released')).toBe('leaseToolState_released')
    expect(stateKey('edit_lock_watch', 'watching')).toBe('leaseToolState_watching')
  })

  it('extracts the requested paths from arguments and tolerates bad JSON', async () => {
    const { argsPaths, argsRawOf, argsRequestId } = await load()
    expect(argsPaths('edit_lock_acquire', '{"paths":["src/a.js","/w/src/b.js"]}')).toEqual(['src/a.js', '/w/src/b.js'])
    expect(argsPaths('edit_lock_watch', '{"file_path":"src/a.js"}')).toEqual(['src/a.js'])
    expect(argsPaths('edit_lock_hold', { paths: ['a', 3, '', 'b'], minutes: 5 })).toEqual(['a', 'b'])
    expect(argsPaths('edit_lock_acquire', '{"paths":["src/a')).toEqual([])
    expect(argsPaths('edit_lock_acquire', 'not json')).toEqual([])
    expect(argsPaths('edit_lock_acquire', '"str"')).toEqual([])
    expect(argsPaths('edit_lock_status', '{}')).toEqual([])
    expect(argsPaths('edit_lock_status', null)).toEqual([])
    expect(argsRawOf({ argsRaw: '{"a":1}' })).toBe('{"a":1}')
    expect(argsRawOf({ call: { argsRaw: '{"b":1}' } })).toBe('{"b":1}')
    expect(argsRawOf({})).toBe(null)
    expect(argsRequestId('{"request_id":"req-9","decision":"keep"}')).toBe('req-9')
    expect(argsRequestId('{')).toBe(null)
  })

  it('reads result and error text, and classifies calls without metadata', async () => {
    const { resultText, errorText, fallbackState } = await load()
    const block = { content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }
    expect(resultText(block)).toBe('one\ntwo')
    expect(resultText({})).toBe('')
    expect(errorText({ isError: true, content: [{ type: 'text', text: 'Refused: held' }] })).toBe('Refused: held')
    expect(errorText({ isError: true, content: [], error: { message: 'boom' } })).toBe('boom')
    expect(errorText({})).toBe('')
    expect(fallbackState('preparing', {})).toBe('running')
    expect(fallbackState('start', {})).toBe('running')
    expect(fallbackState('result', { isError: true })).toBe('failed')
    expect(fallbackState('result', { isError: true, error: { code: 'interrupted' } })).toBe('stopped')
    expect(fallbackState('result', { content: [{ type: 'text', text: 'Claimed 1 path(s)' }] })).toBe('raw')
    expect(fallbackState(undefined, { content: [] })).toBe('raw')
    expect(fallbackState(undefined, {})).toBe('running')
  })

  it('shortens paths against the session cwd and orders outcome paths', async () => {
    const { shortPath, outcomePaths, narrowLeaseMeta } = await load()
    expect(shortPath('/w/p/src/a.js', '/w/p')).toBe('src/a.js')
    expect(shortPath('/w/p/src/a.js', '/w/p/')).toBe('src/a.js')
    expect(shortPath('/elsewhere/a.js', '/w/p')).toBe('/elsewhere/a.js')
    expect(shortPath('src/a.js', undefined)).toBe('src/a.js')
    expect(shortPath(undefined, '/w')).toBe('')
    const narrow = (fields) => narrowLeaseMeta({ editLock: { v: 1, ...fields } })
    expect(outcomePaths(null)).toEqual([])
    expect(outcomePaths(narrow({ tool: 'edit_lock_acquire', state: 'claimed', paths: ['a', 'b'] }))).toEqual(['a', 'b'])
    expect(outcomePaths(narrow({ tool: 'edit_lock_release', state: 'released', released: ['a'], notOwned: ['b'] }))).toEqual(['a', 'b'])
    expect(outcomePaths(narrow({ tool: 'edit_lock_hold', state: 'held', held: [{ path: 'h', holdUntil: 1 }] }))).toEqual(['h'])
    expect(outcomePaths(narrow({ tool: 'edit_lock_watch', state: 'watching', path: 'w' }))).toEqual(['w'])
    expect(outcomePaths(narrow({ tool: 'edit_lock_release', state: 'degraded', paths: ['d'] }))).toEqual(['d'])
  })
})
