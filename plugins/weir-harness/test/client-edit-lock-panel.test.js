import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { readFileSync } from 'node:fs'

/** client.edit-lock-panel.js: gated on the `edit-lock` command, every action is
 * an explicit /edit-lock run, and the dot colour follows the reported state. */
describe('client.edit-lock-panel chunk', () => {
  async function load() {
    const state = []
    let cursor = 0
    const reactStub = {
      begin() { cursor = 0 },
      useState(initial) {
        const at = cursor++
        if (!(at in state)) state[at] = [initial, (next) => { state[at][0] = next }]
        return state[at]
      },
      useEffect(fn, deps) {
        const at = cursor++
        const key = JSON.stringify(deps ?? null)
        const prev = state[at]
        if (!prev || prev.key !== key) {
          if (prev?.cleanup) prev.cleanup()
          state[at] = { key, cleanup: fn() }
        }
      },
    }
    const jsx = (type, props) => ({ __type: type, ...(props ?? {}) })
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.edit-lock-panel.js', requireStub)
    return { definition, exports, reactStub }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** @param {any} node @param {(node: any) => boolean} match @returns {any} */
  function find(node, match) {
    if (!node || typeof node !== 'object') return undefined
    if (match(node)) return node
    for (const child of [].concat(node.children ?? [])) { const hit = find(child, match); if (hit) return hit }
    return undefined
  }

  /** A view in the shape src/edit-lock/view.js produces. */
  const viewOf = (state, files = [], extra = {}) => ({
    state, files, ownCount: files.filter((file) => file.mine).length,
    pendingCount: files.filter((file) => file.status === 'pending-confirmation').length,
    hold: null, recovery: null, technical: { sessionId: 's1', executionEpoch: 2, root: '/w', mode: 'publisher', at: 0 }, ...extra,
  })
  const own = (name, status = 'active', action = 'release') => ({ name, mine: true, status, reason: null, action, detail: { path: `/w/${name}`, owner: 's1', generation: 3 } })

  /** Mount the panel with the command present and a scripted sequence of views. */
  async function mounted(views) {
    const { exports, reactStub } = await load()
    const runs = []
    let index = 0
    const props = {
      sessionId: 's1', t: (key) => key,
      commandsList: async () => [{ name: 'edit-lock' }],
      fetchView: async () => views[Math.min(index++, views.length - 1)],
      runEditLock: async (verb) => { runs.push(verb); return { kind: 'success', text: 'ok' } },
    }
    const render = () => { reactStub.begin(); return exports.EditLockPanel(props) }
    render(); await flush(); await flush()
    return { exports, runs, render, props }
  }
  const byAction = (tree, key) => find(tree, (node) => node['data-weir-edit-lock-action'] === key)

  it('stays hidden without the command and never parses command text', async () => {
    const { exports, reactStub } = await load()
    expect(exports.stateOf).toBeTruthy()
    const props = { sessionId: 's1', t: (key) => key, commandsList: async () => [], fetchView: async () => { throw new Error('must not read') }, runEditLock: async () => ({ kind: 'success' }) }
    reactStub.begin(); expect(exports.EditLockPanel(props)).toBe(null)
    await flush(); reactStub.begin(); expect(exports.EditLockPanel(props)).toBe(null)
    // State comes from the structured view only: text never decides the colour.
    expect(exports.stateOf({ state: 'holding' })).toBe('holding')
    expect(exports.stateOf('Edit Lock session s1: stopped')).toBe('unavailable')
    expect(exports.stateOf({ state: 'made-up' })).toBe('unavailable')
  })

  it('reads the view once on mount so the dot is right before opening, without running any command', async () => {
    const { runs, render } = await mounted([viewOf('editing', [own('a.txt')])])
    const tree = render()
    expect(find(tree, (node) => node['data-weir-edit-lock-state'] !== undefined)['data-weir-edit-lock-state']).toBe('editing')
    expect(runs).toEqual([])
  })

  it('a healthy session offers no primary action; own files offer release', async () => {
    const { runs, render } = await mounted([viewOf('editing', [own('a.txt')])])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(byAction(tree, 'primary')).toBe(undefined)
    byAction(tree, 'release:/w/a.txt').onClick(); await flush(); await flush()
    expect(runs).toEqual(['release /w/a.txt'])
  })

  it('stopped offers exactly one primary action: continue editing, which also confirms the retained files', async () => {
    const { runs, render } = await mounted([viewOf('stopped', [own('a.txt', 'user-interrupted')])])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(byAction(tree, 'primary').children).toBe('editLockResume')
    // A stopped session has nothing left to revoke.
    expect(byAction(tree, 'arm-stop')).toBe(undefined)
    byAction(tree, 'primary').onClick(); await flush(); await flush()
    expect(runs).toEqual(['resume', 'confirm --all'])
  })

  it('continuing a stopped session without retained files records no empty confirmation', async () => {
    const { runs, render } = await mounted([viewOf('stopped', [])])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    byAction(render(), 'primary').onClick(); await flush(); await flush()
    expect(runs).toEqual(['resume'])
  })

  it('waiting files are confirmed in one action', async () => {
    const files = [own('a.txt', 'pending-confirmation', 'confirm'), own('b.txt', 'pending-confirmation', 'confirm')]
    const { runs, render } = await mounted([viewOf('confirm', files)])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    byAction(render(), 'primary').onClick(); await flush(); await flush()
    expect(runs).toEqual(['confirm --all'])
  })

  it('a kept batch shows its expiry and can be released in one action', async () => {
    const files = [own('a.txt'), own('b.txt')]
    const { runs, render } = await mounted([viewOf('holding', files, { hold: { until: Date.UTC(2026, 0, 1, 9, 30), remainingMinutes: 20, usedMinutes: 30 } })])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(find(tree, (node) => node['data-weir-edit-lock-summary'] === '').children).toContain('editLockHoldUntil')
    byAction(tree, 'primary').onClick(); await flush(); await flush()
    expect(runs).toEqual(['release /w/a.txt', 'release /w/b.txt'])
  })

  it('another session\'s stuck file can be unlocked by its exact generation; an active one cannot', async () => {
    const stuck = { name: 'x.txt', mine: false, status: 'abnormal', reason: 'provider-error', action: 'unlock', detail: { path: '/w/x.txt', owner: 's2', generation: 7 } }
    const busy = { name: 'y.txt', mine: false, status: 'active', reason: null, action: null, detail: { path: '/w/y.txt', owner: 's3', generation: 2 } }
    const { runs, render } = await mounted([viewOf('idle', [stuck, busy])])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(byAction(tree, 'arm-unlock:/w/y.txt')).toBe(undefined)
    // Unlocking takes the file from another session: first click only arms it.
    byAction(tree, 'arm-unlock:/w/x.txt').onClick()
    expect(runs).toEqual([])
    byAction(render(), 'unlock:/w/x.txt').onClick(); await flush(); await flush()
    expect(runs).toEqual(['unlock /w/x.txt 7'])
  })

  it('revoking needs a second, explicit confirmation', async () => {
    const { runs, render } = await mounted([viewOf('editing', [own('a.txt')])])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    expect(byAction(render(), 'stop')).toBe(undefined)
    byAction(render(), 'arm-stop').onClick()
    expect(runs).toEqual([])
    byAction(render(), 'stop').onClick(); await flush(); await flush()
    expect(runs).toEqual(['stop'])
  })

  it('technical identifiers stay behind the details toggle', async () => {
    const { render } = await mounted([viewOf('editing', [own('a.txt')])])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    expect(find(render(), (node) => node['data-weir-edit-lock-details'] === '')).toBe(undefined)
    expect(JSON.stringify(render())).not.toContain('generation 3')
    byAction(render(), 'details').onClick()
    expect(find(render(), (node) => node['data-weir-edit-lock-details'] === '').children).toContain('generation 3')
  })

  it('an unavailable session with a reason says editing is refused and shows why', async () => {
    const { render } = await mounted([{ state: 'unavailable', reason: 'edit lock publisher unreachable', files: [], ownCount: 0, pendingCount: 0, hold: null, recovery: null, technical: null }])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(find(tree, (node) => node['data-weir-edit-lock-summary'] === '').children).toBe('editLockState_failed')
    expect(find(tree, (node) => node['data-weir-edit-lock-reason'] === '').children).toContain('unreachable')
  })

  it('a failed action is shown and the view is read again', async () => {
    const { exports, reactStub } = await load()
    let reads = 0
    const props = {
      sessionId: 's1', t: (key) => key,
      commandsList: async () => [{ name: 'edit-lock' }],
      fetchView: async () => { reads++; return viewOf('editing', [own('a.txt')]) },
      runEditLock: async () => ({ kind: 'error', text: 'edit-lock: lock not owned by this session' }),
    }
    const render = () => { reactStub.begin(); return exports.EditLockPanel(props) }
    render(); await flush(); await flush()
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const before = reads
    byAction(render(), 'release:/w/a.txt').onClick(); await flush(); await flush()
    expect(find(render(), (node) => node['data-weir-edit-lock-error'] === '').children).toContain('not owned')
    expect(reads).toBeGreaterThan(before)
  })

  it('an administratively revoked session is terminal: no resume, no stop, with an explanation', async () => {
    const { runs, render } = await mounted([viewOf('revoked', [])])
    find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(find(tree, (node) => node['data-weir-edit-lock-summary'] === '').children).toBe('editLockState_revoked')
    expect(byAction(tree, 'primary')).toBe(undefined)
    expect(byAction(tree, 'arm-stop')).toBe(undefined)
    expect(find(tree, (node) => node['data-weir-edit-lock-revoked'] !== undefined).children).toBe('editLockRevokedHint')
    expect(runs).toEqual([])
  })
	it('a cold stopped session shows activation guidance and offers no live-only action', async () => {
		const { runs, render } = await mounted([viewOf('stopped', [own('a.txt', 'user-interrupted')], { cold: true, autoResume: true })])
		find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
		const tree = render()
		// No resume primary, no per-file action, no revoke: every write needs the
		// live agent's command channel, which a cold session does not have.
		expect(byAction(tree, 'primary')).toBe(undefined)
		expect(byAction(tree, 'release:/w/a.txt')).toBe(undefined)
		expect(byAction(tree, 'arm-stop')).toBe(undefined)
		// The file list stays, read-only, and the guidance matches the auto-resume gate.
		expect(find(tree, (node) => node['data-weir-edit-lock-file'] === '/w/a.txt')).toBeTruthy()
		expect(find(tree, (node) => node['data-weir-edit-lock-cold'] !== undefined).children).toBe('editLockColdResumeAuto')
		expect(runs).toEqual([])
	})

	it('a cold stopped session with auto-resume off is told to activate, then continue by hand', async () => {
		const { render } = await mounted([viewOf('stopped', [], { cold: true, autoResume: false })])
		find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
		expect(find(render(), (node) => node['data-weir-edit-lock-cold'] !== undefined).children).toBe('editLockColdResumeManual')
	})

	it('a cold view in any other state is read-only too: no primary, no row action, no revoke, no guidance', async () => {
		const stuck = { name: 'x.txt', mine: false, status: 'abnormal', reason: 'provider-error', action: 'unlock', detail: { path: '/w/x.txt', owner: 's2', generation: 7 } }
		const { render } = await mounted([viewOf('editing', [own('a.txt'), stuck], { cold: true, autoResume: true })])
		find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
		const tree = render()
		expect(byAction(tree, 'primary')).toBe(undefined)
		expect(byAction(tree, 'release:/w/a.txt')).toBe(undefined)
		expect(byAction(tree, 'arm-unlock:/w/x.txt')).toBe(undefined)
		expect(byAction(tree, 'arm-stop')).toBe(undefined)
		expect(find(tree, (node) => node['data-weir-edit-lock-cold'] !== undefined)).toBe(undefined)
	})

  it('closes on an outside pointerdown, stays open for inside ones, and re-opens cleanly', async () => {
    const listeners = []
    globalThis.document = {
      addEventListener: (type, fn) => listeners.push([type, fn]),
      removeEventListener: (type, fn) => { const at = listeners.findIndex((entry) => entry[0] === type && entry[1] === fn); if (at >= 0) listeners.splice(at, 1) },
    }
    try {
      const { render } = await mounted([viewOf('editing', [own('a.txt')])])
      const panelOf = (tree) => find(tree, (node) => node['data-weir-edit-lock-panel'] === '')
      const pointerdown = (closest) => { for (const [type, fn] of [...listeners]) if (type === 'pointerdown') fn({ target: { closest } }) }
      expect(listeners.length).toBe(0)
      find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
      expect(panelOf(render())).toBeTruthy()
      expect(listeners.some(([type]) => type === 'pointerdown')).toBe(true)
      // A pointerdown inside this entry (button or panel) must not dismiss it.
      pointerdown(() => ({}))
      expect(panelOf(render())).toBeTruthy()
      // A pointerdown anywhere outside dismisses the panel and unregisters the listener.
      pointerdown(() => null)
      expect(panelOf(render())).toBe(undefined)
      expect(listeners.filter(([type]) => type === 'pointerdown').length).toBe(0)
      // Toggling the button again re-opens (and re-registers) normally.
      find(render(), (node) => node['data-weir-edit-lock'] === '').onClick(); await flush()
      expect(panelOf(render())).toBeTruthy()
    } finally { delete globalThis.document }
  })

  it('paints an opaque popover with theme-defined tokens only', () => {
    const source = readFileSync(new URL('../lib/client.edit-lock-panel.js', import.meta.url), 'utf8')
    // The theme's documented popover surface; an undefined token renders transparent.
    expect(source).toContain('background: "var(--dsw-alias-bg-overlay)"')
    // Tokens verified against dsh-client-ui-theme 0.2.0-rc.2 definitions.
    const DEFINED = new Set(['--dsw-alias-bg-overlay', '--dsw-alias-border-l2', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary', '--dsw-alias-state-business-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary',
      '--dsw-font-markdown-code-block-font-family', '--dsw-radius-md', '--dsw-radius-sm'])
    for (const match of source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) expect(DEFINED.has(match[1]), `undefined theme token ${match[1]}`).toBe(true)
  })
})
