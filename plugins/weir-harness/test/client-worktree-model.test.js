// client.worktree-model.js: the pure view model behind every worktree surface.
import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

const model = (await loadClientChunk('lib/client.worktree-model.js')).exports

const lane = (overrides = {}) => ({
  id: 'a-001', title: 'Fix login', state: 'working', reason: null, path: '/r/.weir/worktrees/a-001', branch: 'weir/a-001',
  base: { branch: 'main' }, scope: [], ahead: 1, behind: 0, stat: { files: 2, added: 10, removed: 3 }, check: null,
  landableTree: null, baseMoved: false, boundChild: null, ownerSession: 's1', exists: true,
  next: { tool: 'worktree_check', args: { lane: 'a-001' } }, actions: { land: { enabled: false, reason: 'not yet' } }, updatedAt: 1000,
  ...overrides,
})

describe('worktree view model', () => {
  it('narrows a host view and drops unusable lanes', () => {
    const view = model.narrowView({
      available: true, mode: true, ownedBySession: ['a-001', 7], unmanaged: ['/r/x', 3],
      repo: { mainRoot: '/r', root: '.weir/worktrees', branch: 'main', gitVersion: '2.39.5', exclude: true, verification: { enabled: true, commands: ['test'] } },
      lanes: [lane(), { id: 'b' }, null, 'nope'],
    })
    expect(view.lanes).toHaveLength(1)
    expect(view.lanes[0].base).toBe('main')
    expect(view.lanes[0].actions.land).toEqual({ enabled: false, reason: 'not yet' })
    expect(view.owned).toEqual(['a-001'])
    expect(view.unmanaged).toEqual(['/r/x'])
    expect(view.repo.verification).toEqual({ enabled: true, commands: ['test'], error: null })
    expect(model.narrowView(undefined)).toBe(null)
    expect(model.narrowView({ available: true }).lanes).toEqual([])
    expect(model.narrowView({ available: true }).repo).toBe(null)
  })

  it('groups active and finished lanes, newest first', () => {
    const groups = model.groupLanes([
      lane({ id: 'a', state: 'working', updatedAt: 10 }),
      lane({ id: 'b', state: 'landed', updatedAt: 30 }),
      lane({ id: 'c', state: 'landable', updatedAt: 20 }),
      lane({ id: 'd', state: 'kept', updatedAt: 5 }),
    ])
    expect(groups.active.map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(groups.history.map((entry) => entry.id)).toEqual(['b', 'd'])
  })

  it('maps states to tone groups and theme tokens', () => {
    expect(model.toneOf('landable')).toBe('ready')
    expect(model.toneOf('awaiting-approval')).toBe('approval')
    expect(model.toneOf('branch-moved')).toBe('attention')
    expect(model.toneOf('working')).toBe('progress')
    expect(model.toneOf('kept')).toBe('done')
    expect(model.toneOf('unknown-state')).toBe('neutral')
    for (const state of ['landable', 'awaiting-approval', 'branch-moved', 'working', 'kept']) {
      expect(model.colorOf(state)).toContain('--dsw-')
    }
  })

  it('summarizes the marker: owned lanes only, attention and base-moved flags', () => {
    const view = model.narrowView({
      available: true, mode: true, ownedBySession: ['a-001'],
      lanes: [lane(), lane({ id: 'z-009', state: 'awaiting-approval', baseMoved: true }), lane({ id: 'h-003', state: 'cleaned' })],
      repo: { branch: 'main' },
    })
    const owned = model.summaryOf(view, true)
    expect(owned.active).toBe(1)
    expect(owned.awaiting).toBe(0)
    expect(owned.baseMoved).toBe(false)
    const all = model.summaryOf(view, false)
    expect(all.active).toBe(2)
    expect(all.awaiting).toBe(1)
    expect(all.baseMoved).toBe(true)
    expect(all.mode).toBe(true)
    expect(model.summaryOf(null).active).toBe(0)
  })

  it('polls only while a lane is in a host-side transition', () => {
    expect(model.needsPolling(model.narrowView({ available: true, lanes: [lane({ state: 'ready' })] }))).toBe(false)
    expect(model.needsPolling(model.narrowView({ available: true, lanes: [lane({ state: 'checking' })] }))).toBe(true)
    expect(model.needsPolling(model.narrowView({ available: true, lanes: [lane({ state: 'awaiting-approval' })] }))).toBe(true)
    expect(model.needsPolling(null)).toBe(false)
  })

  it('survives degraded endpoint shapes without throwing', () => {
    // The view endpoint's degraded replies (WORKTREE_DISABLED, SESSION_NOT_LIVE)
    // and malformed payloads must never crash a render.
    const degraded = { available: false, enabled: true, mode: false, error: { code: 'SESSION_NOT_LIVE', message: 'x' } }
    for (const value of [degraded, { lanes: 'nope', owned: 1 }, 42, 'x', undefined]) {
      const summary = model.summaryOf(value)
      expect(summary.active).toBe(0)
      expect(summary.awaiting).toBe(0)
      expect(model.needsPolling(value)).toBe(false)
    }
    const narrowed = model.narrowView(degraded)
    expect(narrowed.lanes).toEqual([])
    expect(narrowed.owned).toEqual([])
    expect(model.summaryOf(narrowed).mode).toBe(false)
    expect(model.needsPolling(narrowed)).toBe(false)
  })

  it('builds the exact command line of each panel action and flags the risky ones', () => {
    expect(model.commandFor('check', { id: 'a-001' })).toBe('check a-001')
    expect(model.commandFor('land', { id: 'a-001' })).toBe('land a-001')
    expect(model.commandFor('setup', { id: 'a-001' })).toBe('setup a-001')
    expect(model.commandFor('setup', { id: 'a-001' }, 'skip')).toBe('setup a-001 --skip')
    expect(model.commandFor('clean', { id: 'a-001' }, 'all')).toBe('clean a-001 all')
    expect(model.commandFor('clean', { id: 'a-001' }, 'nuke')).toBe(null)
    expect(model.commandFor('abandon', { id: 'a-001' }, 'keep')).toBe('abandon a-001 keep')
    expect(model.commandFor('diff', { id: 'a-001' })).toBe(null)
    expect(model.needsConfirm('land')).toBe(true)
    expect(model.needsConfirm('clean', 'all')).toBe(true)
    expect(model.needsConfirm('clean', 'worktree')).toBe(false)
    expect(model.needsConfirm('abandon', 'keep')).toBe(false)
    expect(model.needsConfirm('check')).toBe(false)
  })

  it('renders next hints for people', () => {
    expect(model.nextText({ tool: 'worktree_land', args: {} })).toBe('worktree_land')
    expect(model.nextText({ waitFor: 'child-settle', hint: 'worker running' })).toBe('child-settle — worker running')
    expect(model.nextText(null)).toBe(null)
  })

  it('narrows persisted tool meta and rejects foreign or malformed payloads', () => {
    const meta = model.narrowToolMeta({ worktree: { tool: 'worktree_land', lane: 'a-001', state: 'landed', from: 'landable', summary: 'merged', next: null, merge: { commit: 'abc', stat: { files: 1, added: 2, removed: 1 } }, check: [{ name: 't', exit: 0, ms: 5 }], diff: 'diff --git a b\n+1', cleanup: { state: 'cleaned', summary: 'removed' } } })
    expect(meta.tool).toBe('worktree_land')
    expect(meta.merge.stat).toEqual({ files: 1, added: 2, removed: 1 })
    expect(meta.check).toEqual([{ name: 't', exit: 0, ms: 5 }])
    expect(model.narrowToolMeta({ worktree: { tool: 'not_a_lane_tool', state: 'x' } })).toBe(null)
    expect(model.narrowToolMeta({ worktree: { tool: 'worktree_land' } })).toBe(null)
    expect(model.narrowToolMeta(null)).toBe(null)
    expect(model.narrowToolMeta({ worktree: { tool: 'worktree_open', lane: 'a', state: 'ready' } }).diff).toBe(null)
  })

  it('narrows worktree_watch meta: subscription, immediate hit, malformed payloads', () => {
    const watched = model.narrowToolMeta({ worktree: { tool: 'worktree_watch', lane: 'a-001', state: 'working', summary: 'watching', watch: { lane: 'a-001', states: ['landable', 7, 'conflicted'], expiresAt: 1234 } } })
    expect(watched.tool).toBe('worktree_watch')
    expect(watched.watch).toEqual({ states: ['landable', 'conflicted'], expiresAt: 1234 })
    expect(watched.hit).toBe(null)
    const hit = model.narrowToolMeta({ worktree: { tool: 'worktree_watch', lane: 'a-001', state: 'landable', summary: 'hit', hit: 'landable' } })
    expect(hit.hit).toBe('landable')
    expect(hit.watch).toBe(null)
    const noArrayStates = model.narrowToolMeta({ worktree: { tool: 'worktree_watch', lane: 'a-001', state: 'working', watch: { states: 'landable', expiresAt: 1 } } })
    expect(noArrayStates.watch).toBe(null)
    const stringExpiry = model.narrowToolMeta({ worktree: { tool: 'worktree_watch', lane: 'a-001', state: 'working', watch: { states: ['landable'], expiresAt: 'soon' } } })
    expect(stringExpiry.watch).toBe(null)
    expect(model.narrowToolMeta({ worktree: { tool: 'worktree_watch', lane: 'a-001', state: 'working', watch: 'landable' } }).watch).toBe(null)
    const noExpiry = model.narrowToolMeta({ worktree: { tool: 'worktree_watch', lane: 'a-001', state: 'working', watch: { states: ['landable'] } } })
    expect(noExpiry.watch).toEqual({ states: ['landable'], expiresAt: null })
  })

  it('narrows per-lane watch facts with safe defaults', () => {
    const narrowed = model.narrowLane(lane({ watchCount: 2, watchStates: ['landable', 9] }))
    expect(narrowed.watchCount).toBe(2)
    expect(narrowed.watchStates).toEqual(['landable'])
    const fallback = model.narrowLane(lane({ watchCount: 'x' }))
    expect(fallback.watchCount).toBe(0)
    expect(fallback.watchStates).toEqual([])
  })

  it('classifies diff lines and bounds the rendering', () => {
    const lines = model.diffLines('diff --git a b\nindex 1\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n context')
    expect(lines.map((line) => line.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'remove', 'add', 'context'])
    expect(model.diffLines('')).toEqual([])
    expect(model.diffLines(null)).toEqual([])
    const truncated = model.diffLines(Array.from({ length: 12 }, () => '+x').join('\n'), 10)
    expect(truncated).toHaveLength(11)
    expect(truncated.at(-1).text).toContain('2 more line(s)')
  })

  it('parses /worktree init output and serializes the config editor', () => {
    const parsed = model.parseInit(JSON.stringify({ file: '/r/.weir/worktrees/.config.json', error: null, current: { setup: 'pnpm i', check: [{ name: 't', run: 'npm test' }] }, suggested: { setup: 'pnpm install --frozen-lockfile', check: [{ name: 'test', run: 'npm run test' }] } }))
    expect(parsed.file).toBe('/r/.weir/worktrees/.config.json')
    expect(parsed.suggested.check[0].name).toBe('test')
    expect(model.parseInit('not json')).toBe(null)
    expect(model.parseInit('[]')).toBe(null)
    expect(model.configPayload(' pnpm i ', [{ name: ' t ', run: ' npm test ' }, { name: '', run: 'x' }, { name: 'y', run: '' }])).toBe('{"check":[{"name":"t","run":"npm test"}],"setup":"pnpm i"}')
    expect(model.configPayload('', [])).toBe('{"check":[]}')
  })

  it('exposes the projection key the host registers', () => {
    expect(model.WORKTREE_PROJECTION_KEY).toBe('weirWorktree')
    expect(model.WORKTREE_TOOLS).toEqual(['worktree_open', 'worktree_check', 'worktree_land', 'worktree_cleanup', 'worktree_abandon', 'worktree_watch'])
    expect(model.ago(0, 90_000)).toBe('2m')
    expect(model.ago(0, 45_000)).toBe('45s')
  })
})
