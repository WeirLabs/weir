import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { readFileSync } from 'node:fs'
import { buildView } from '../src/edit-lock/view.js'

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

  it('a failed status refresh withdraws stale editing state and actions', async () => {
    const { render, props } = await mounted([viewOf('editing', [own('a.txt')])])
    find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
    props.fetchView = async () => { throw Error('connection unavailable') }
    byAction(render(), 'refresh').onClick(); await flush()
    const tree = render()
    expect(find(tree, node => node['data-weir-edit-lock-state'] !== undefined)['data-weir-edit-lock-state']).toBe('unavailable')
    expect(byAction(tree, 'release:/w/a.txt')).toBe(undefined)
    expect(byAction(tree, 'primary')).toBe(undefined)
  })
  it('retryable unavailable offers connection retry only, then refreshes without Continue', async () => {
    const failure = viewOf('unavailable', [], { reason: 'holder unknown', bindingFailure: { code: 'binding-duplicate', retryable: true, inFlight: false } })
    const { runs, render } = await mounted([failure, failure, viewOf('stopped')])
    find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
    expect(byAction(render(), 'primary').children).toBe('editLockRetry')
    byAction(render(), 'primary').onClick(); await flush(); await flush()
    expect(runs).toEqual(['retry'])
    expect(byAction(render(), 'primary').children).toBe('editLockResume')
  })
  it('unavailable prose alone and an in-flight binding never offer a retry action', async () => {
    const { exports } = await load()
    expect(exports.primaryOf('unavailable', viewOf('unavailable', [], { reason: 'retry connection' }))).toBe(null)
    expect(exports.primaryOf('unavailable', viewOf('unavailable', [], { bindingFailure: { code: 'binding-duplicate', retryable: true, inFlight: true } }))).toBe(null)
  })

  for (const text of ['publisher connection lost', 'edit-lock: binding refused; durable revocation failed']) {
    it(`preserves a distinct Retry error inline: ${text}`, async () => {
      const failure = viewOf('unavailable', [], { reason: 'binding refused', bindingFailure: { code: 'binding-duplicate', holderKind: 'serving', retryable: true } })
      const { render, props } = await mounted([failure])
      props.runEditLock = async () => ({ kind: 'error', text })
      find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
      byAction(render(), 'primary').onClick(); await flush(); await flush()
      expect(find(render(), node => node['data-weir-edit-lock-error'] === '').children).toBe(text)
      expect(find(render(), node => node['data-weir-edit-lock-reason'] === '')).toBe(undefined)
      byAction(render(), 'details').onClick()
      const details = find(render(), node => node['data-weir-edit-lock-details'] === '').children
      expect(details).toContain('binding refused')
      expect(details).toContain('session s1 · epoch 2')
      expect(details).toContain('root /w (publisher)')
    })
  }

  it('deduplicates an exact unwrapped refusal but restores it inline if the refreshed reason differs', async () => {
    const failure = viewOf('unavailable', [], { reason: 'original binding refusal', bindingFailure: { code: 'binding-duplicate', retryable: true } })
    const { render, props } = await mounted([failure])
    props.runEditLock = async () => ({ kind: 'error', text: failure.reason })
    find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
    byAction(render(), 'primary').onClick(); await flush(); await flush()
    expect(find(render(), node => node['data-weir-edit-lock-error'] === '')).toBe(undefined)
    props.fetchView = async () => ({ ...failure, reason: 'different binding refusal' })
    byAction(render(), 'refresh').onClick(); await flush()
    expect(find(render(), node => node['data-weir-edit-lock-error'] === '').children).toBe(failure.reason)
  })

  it('keeps a refresh failure inline without structured binding evidence even when it repeats the reason', async () => {
    const { render, props } = await mounted([viewOf('idle')])
    find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
    props.fetchView = async () => { throw Error('publisher connection lost') }
    byAction(render(), 'refresh').onClick(); await flush()
    expect(find(render(), node => node['data-weir-edit-lock-error'] === '').children).toBe('publisher connection lost')
    expect(find(render(), node => node['data-weir-edit-lock-reason'] === '').children).toBe('publisher connection lost')
    expect(byAction(render(), 'primary')).toBe(undefined)
  })

  for (const bindingFailure of [null, { code: 'other', retryable: true }, { code: 'binding-duplicate', retryable: false }, { code: 'binding-duplicate' }, { code: 'binding-duplicate', retryable: true, inFlight: true }]) {
    it(`renders no Retry without eligible structured evidence: ${JSON.stringify(bindingFailure)}`, async () => {
      const { render, runs } = await mounted([viewOf('unavailable', [], { reason: 'retry this binding', bindingFailure })])
      find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
      expect(byAction(render(), 'primary')).toBe(undefined)
      expect(runs).toEqual([])
    })
  }

  for (const holderKind of ['cross-process', 'serving', 'unknown']) {
    it(`${holderKind} binding refusal stays localized after Retry and exposes the full reason on demand`, async () => {
      const reason = 'edit lock duplicate session binding: session s1 has a binding held by process pid 71998. Do NOT remove the publisher reservation while its process is alive.'
      const failure = viewOf('unavailable', [], { reason, technical: null, bindingFailure: { code: 'binding-duplicate', holderKind, holderPid: 71998, retryable: true } })
      const { render, props, runs } = await mounted([failure])
      const guidance = {
        'cross-process': '原持有者位于另一进程。请先断开原连接或确认其进程已退出，再重试。',
        serving: '原持有者仍在服务。请先在原会话断开，再重试；重试不等于继续编辑。',
        unknown: '无法核实原持有者。请等待原连接断开或确认其进程已退出，再重试；勿删除存活 publisher 的预约。',
      }
      props.t = key => ({ editLockState_failed: '编辑锁不可用，编辑会被拒绝', editLockRetry: '重试连接', editLockDetails: '技术细节', [`editLockBinding_${holderKind}`]: guidance[holderKind] })[key] ?? key
      props.runEditLock = async verb => { runs.push(verb); return { kind: 'error', text: `edit-lock: ${reason}` } }
      find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
      expect(find(render(), node => node['data-weir-edit-lock-summary'] === '').children).toBe('编辑锁不可用，编辑会被拒绝')
      expect(find(render(), node => node['data-weir-edit-lock-binding'] === '').children).toBe(guidance[holderKind])
      expect(JSON.stringify(render())).not.toContain(reason)
      expect(byAction(render(), 'primary').children).toBe('重试连接')
      byAction(render(), 'primary').onClick(); await flush(); await flush()
      expect(runs).toEqual(['retry'])
      expect(byAction(render(), 'primary').disabled).toBe(false)
      expect(find(render(), node => node['data-weir-edit-lock-error'] === '')).toBe(undefined)
      expect(JSON.stringify(render())).not.toContain(reason)
      expect(byAction(render(), 'details').children).toBe('技术细节')
      byAction(render(), 'details').onClick()
      expect(find(render(), node => node['data-weir-edit-lock-details'] === '').children).toContain(reason)
      byAction(render(), 'details').onClick()
      expect(JSON.stringify(render())).not.toContain(reason)
      expect(runs).toEqual(['retry'])
    })
  }

  for (const state of ['idle', 'stopped', 'attention']) {
    it(`recovery usage in ${state} is history, not evidence of an active cleanup or pause`, async () => {
      const { render } = await mounted([viewOf(state, [], { recovery: { attempts: 3, elapsedSeconds: 300, pauseMinutes: 30 } })])
      find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
      const tree = render()
      expect(find(tree, node => node['data-weir-edit-lock-recovery'] === '').children).toBe('Recorded recovery: 3 attempts · 300s elapsed · 30 min pause used.')
      expect(find(tree, node => node['data-weir-edit-lock-cleanup'] === '')).toBe(undefined)
      expect(JSON.stringify(tree)).not.toContain('editLockRecovery')
      expect(byAction(tree, 'primary')?.children).toBe(state === 'stopped' ? 'editLockResume' : undefined)
    })
  }

  it('renders the live pause as a localized absolute deadline without changing cleanup actions', async () => {
    const pausedUntil = Date.UTC(2099, 0, 1, 9, 30)
    const { render, runs, props } = await mounted([viewOf('attention', [own('a.txt', 'abnormal')], { cleanupOnly: true, pausedUntil })])
    props.t = key => key === 'editLockPausedUntil' ? 'Recovery paused until {time}.' : key
    find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(find(tree, node => node['data-weir-edit-lock-paused-until'] === '').children).toBe(`Recovery paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`)
    expect(byAction(tree, 'primary')).toBe(undefined)
    expect(byAction(tree, 'release:/w/a.txt').children).toBe('editLockRow_release')
    expect(runs).toEqual([])
  })

  for (const [label, state, extra] of [
    ['expired', 'attention', { cleanupOnly: true, pausedUntil: 1 }],
    ['historical', 'attention', { cleanupOnly: true }],
    ['stopped', 'stopped', { pausedUntil: Date.UTC(2099, 0, 1) }],
    ['idle', 'idle', { pausedUntil: Date.UTC(2099, 0, 1) }],
    ['cold', 'attention', { cleanupOnly: true, cold: true, pausedUntil: Date.UTC(2099, 0, 1) }],
  ]) {
    it(`does not label ${label} cumulative pause usage as a live pause`, async () => {
      const { render } = await mounted([viewOf(state, [], { recovery: { attempts: 2, elapsedSeconds: 31, pauseMinutes: 15 }, ...extra })])
      find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
      expect(find(render(), node => node['data-weir-edit-lock-paused-until'] === '')).toBe(undefined)
      expect(find(render(), node => node['data-weir-edit-lock-recovery'] === '').children).toContain('15 min pause used')
    })
  }

  it('retained rename locks describe ownership only and direct users to the separate tool outcome', async () => {
    // publishBatch retains all batch ownership on failure: these same rows can
    // accompany written, not-written, or uncertain outcomes. Only the tool error
    // has those lists; the panel must not classify bytes from lock status.
    const locks = ['written.ts', 'uncertain.ts', 'not-written.ts'].map(name => ({ resourceId: `/w/${name}`, owner: 's1', generation: 3, status: 'active' }))
    const projected = buildView({ status: { sessionId: 's1', state: 'active', interrupted: false, executionEpoch: 2, locks }, locks, cwd: '/w', now: 0 })
    const { render, runs } = await mounted([projected])
    find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(find(tree, node => node['data-weir-edit-lock-ownership-hint'] === '').children).toBe('Locks show ownership, not write outcomes. For failed edits, inspect the tool result; releasing locks does not undo changes.')
    expect(find(tree, node => node['data-weir-edit-lock-summary'] === '').children).toBe('editLockState_editing')
    for (const name of ['written.ts', 'uncertain.ts', 'not-written.ts']) {
      expect(byAction(tree, `release:/w/${name}`).children).toBe('editLockRow_release')
    }
    expect(byAction(tree, 'primary')).toBe(undefined)
    expect(find(tree, node => node['data-weir-edit-lock-error'] === '')).toBe(undefined)
    expect(JSON.stringify(tree)).not.toContain('filesAlreadyWritten')
    expect(JSON.stringify(tree)).not.toContain('filesNotWritten')
    expect(JSON.stringify(tree)).not.toContain('filesUncertain')
    expect(runs).toEqual([])
  })

  it('renders cleanup restrictions, visible abnormal reasons and cumulative pause usage without claiming a live pause', async () => {
    const file = { ...own('very-long-file-name.ts', 'abnormal'), reason: 'provider-error: connection lost' }
    const { runs, render } = await mounted([viewOf('attention', [file], { cleanupOnly: true, recovery: { attempts: 2, elapsedSeconds: 31, pauseMinutes: 15 } })])
    find(render(), node => node['data-weir-edit-lock'] === '').onClick(); await flush()
    const tree = render()
    expect(find(tree, node => node['data-weir-edit-lock-summary'] === '').children).toBe('editLockState_attention')
    expect(find(tree, node => node['data-weir-edit-lock-cleanup'] === '').children).toBe('Cleanup only: business edits and new ownership are blocked. Release files you no longer need; inspect the tool result before retrying edits.')
    expect(find(tree, node => node['data-weir-edit-lock-file-reason'] === '/w/very-long-file-name.ts').children).toBe('provider-error: connection lost')
    expect(find(tree, node => node['data-weir-edit-lock-recovery'] === '').children).toBe('Recorded recovery: 2 attempts · 31s elapsed · 15 min pause used.')
    expect(find(tree, node => node['data-weir-edit-lock-pause'] === '').children).toBe('Pause usage is cumulative, not a live timer. Pause expiry re-checks recovery; it does not release locks or restore editing.')
    expect(byAction(tree, 'primary')).toBe(undefined)
    expect(byAction(tree, 'confirm:/w/very-long-file-name.ts')).toBe(undefined)
    expect(byAction(tree, 'release:/w/very-long-file-name.ts').children).toBe('editLockRow_release')
    expect(JSON.stringify(tree)).not.toContain('editLockRecovery')
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
    expect(/rgba?\(|#[0-9a-f]{3,8}\b/i.test(source)).toBe(false)
    // Tokens verified against dsh-client-ui-theme 0.2.0-rc.2 definitions.
    const DEFINED = new Set(['--dsw-alias-bg-overlay', '--dsw-alias-border-l2', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary', '--dsw-alias-state-business-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary',
      '--dsw-font-markdown-code-block-font-family', '--dsw-radius-md', '--dsw-radius-sm'])
    for (const match of source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) expect(DEFINED.has(match[1]), `undefined theme token ${match[1]}`).toBe(true)
  })
})
