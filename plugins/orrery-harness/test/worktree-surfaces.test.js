// Worktree lane surfaces around the service: guard decisions, the session
// projection, the tool and command adapters, the spawn-adapter lane guard,
// the delegate binding, and the Worktree mode guard.
import { describe, expect, it } from './helpers.js'
import { decideLaneCall, decideModeCall, isLaneQuery, laneGitViolation, maskLaneQueries, tokenize } from '../src/worktree/guard.js'
import { foldWorktreeState, initialWorktreeState, worktreeView } from '../src/worktree/projection.js'
import { createWorktreeTools, renderResult } from '../src/worktree/tools.js'
import { createWorktreeCommand } from '../src/worktree/command.js'
import { WorktreeError } from '../src/worktree/errors.js'
import { renderBoard, renderChildContract, renderNotice, renderWatchHit } from '../src/worktree/prompts.js'
import { worktreeSettings } from '../src/worktree/index.js'
import { oneShotLane, spawnGuardedChild, supervisedLane } from '../src/delegate/spawn-adapter.js'
import { createDelegateTool } from '../src/delegate/tool.js'
import { attachWorktreeModeGuard } from '../src/delegate/worktree-mode.js'
import { DEFAULT_ROBASH, checkBashCommand } from '../src/delegate/robash-guard.js'
import { DEFAULT_ROBASH_PWSH } from '../src/delegate/robash-guard-pwsh.js'

const LANE = '/r/.orrery/worktrees/a-001'
const spec = (overrides = {}) => ({
  laneId: 'a-001',
  lanePath: LANE,
  scope: null,
  readOnly: false,
  resolve: (path) => (path.startsWith('/') ? path : `/r/${path}`).replace(/\/+$/, ''),
  ...overrides,
})

describe('lane guard decisions', () => {
  it('requires a workdir inside the lane on every shell call', () => {
    expect(decideLaneCall({ name: 'bash', arguments: { command: 'ls' } }, spec())).toContain(`workdir set to the lane (${LANE})`)
    expect(decideLaneCall({ name: 'bash', arguments: { command: 'ls', workdir: '/r' } }, spec())).toContain('outside the lane')
    expect(decideLaneCall({ name: 'bash', arguments: { command: 'ls', workdir: '/r/.orrery/worktrees/a-0010' } }, spec())).toContain('outside the lane')
    expect(decideLaneCall({ name: 'bash', arguments: { command: 'ls', workdir: `${LANE}/src` } }, spec())).toBeUndefined()
    expect(decideLaneCall({ name: 'pwsh', arguments: { command: 'ls', workdir: LANE } }, spec())).toBeUndefined()
  })

  it('refuses branch-moving git and allows ordinary lane git', () => {
    for (const command of ['git checkout main', 'git switch -c x', 'git push', 'git -C /r status', 'cd x && git worktree add y', 'git branch -D orrery/a-001', 'git reset --hard origin/main', 'echo $(git checkout main)', '/usr/bin/git switch main', 'echo a | xargs git checkout', 'FOO=1 git push', 'if true; then git switch x; fi', 'sudo -n git push']) {
      expect(laneGitViolation(command), command).toBeTruthy()
    }
    for (const command of ['git status', 'git add . && git commit -m "x; git push"', 'git merge main', 'git rebase main', 'git reset --soft HEAD~1', 'git reset', 'git branch', 'git log --oneline', 'echo git checkout']) {
      expect(laneGitViolation(command), command).toBeNull()
    }
    expect(decideLaneCall({ name: 'bash', arguments: { command: 'git checkout main', workdir: LANE } }, spec())).toContain('git checkout would move or escape the lane branch')
    expect(tokenize('a "b c" d;e')).toEqual(['a', 'b c', 'd', ';', 'e'])
  })

  it('confines write paths to the lane and its scope', () => {
    expect(decideLaneCall({ name: 'write', arguments: { file_path: '/r/a.txt' } }, spec())).toContain('outside the lane')
    expect(decideLaneCall({ name: 'hash_edit', arguments: { file_path: `${LANE}/src/auth/x.js` } }, spec({ scope: ['src/auth/**'] }))).toBeUndefined()
    expect(decideLaneCall({ name: 'edit', arguments: { file_path: `${LANE}/src/billing/x.js` } }, spec({ scope: ['src/auth/**'] }))).toContain('outside the lane scope')
    expect(decideLaneCall({ name: 'write', arguments: { file_path: '.orrery/worktrees/a-001/new.txt' } }, spec())).toBeUndefined()
    expect(decideLaneCall({ name: 'read', arguments: { file_path: '/etc/hosts' } }, spec())).toBeUndefined()
  })

  it('refuses unbounded writers for lane writers only', () => {
    expect(decideLaneCall({ name: 'lsp_rename', arguments: { file_path: `${LANE}/a.ts` } }, spec())).toContain('disabled for lane workers')
    expect(decideLaneCall({ name: 'lsp_rename', arguments: {} }, spec({ readOnly: true }))).toBeUndefined()
  })

  it('Worktree mode lets the main agent inspect branches and lanes, nothing more', () => {
    for (const command of ['git branch', 'git branch -a', 'git branch -vv', 'git branch --show-current', 'git branch --list orrery/*', 'git branch --merged main', 'git worktree list', 'git worktree list --porcelain']) {
      expect(isLaneQuery(tokenize(command)), command).toBe(true)
    }
    for (const command of ['git branch new', 'git branch -D x', 'git branch -m a b', 'git branch -f x', 'git worktree add y', 'git worktree remove y', 'git -C /x branch', 'git status']) {
      expect(isLaneQuery(tokenize(command)), command).toBe(false)
    }
    expect(maskLaneQueries('git branch && git worktree list; ls -la')).toBe('true && true ; ls -la')
    expect(maskLaneQueries('git branch -D x && ls')).toBe('git branch -D x && ls')
    expect(maskLaneQueries('echo $(git branch)')).toBe('echo $(git branch)')
    const real = (command) => checkBashCommand(command, DEFAULT_ROBASH)
    const call = (command) => decideModeCall({ name: 'bash', arguments: { command } }, real)
    expect(call('git branch && git worktree list && git log --oneline -3')).toBeUndefined()
    expect(call('git branch -D orrery/x')).toContain('read-only')
    expect(call('git worktree add z && git branch')).toContain('read-only')
    expect(call("git branch --list 'orrery/*'")).toBeUndefined()
  })

  it('Worktree mode refuses main-agent writes and mutating shell commands', () => {
    const check = (command) => (command.startsWith('rm') ? 'rm is not allowed' : undefined)
    expect(decideModeCall({ name: 'write', arguments: { file_path: '/r/a' } }, check)).toContain('worktree_open')
    expect(decideModeCall({ name: 'bash', arguments: { command: 'rm -rf x' } }, check)).toContain('read-only')
    expect(decideModeCall({ name: 'bash', arguments: { command: 'git log' } }, check)).toBeUndefined()
    expect(decideModeCall({ name: 'read', arguments: {} }, check)).toBeUndefined()
  })
})

describe('worktree session projection', () => {
  it('flips the mode only when the /worktree command succeeded', () => {
    let state = initialWorktreeState()
    state = foldWorktreeState(state, { type: 'command/run', data: { commandId: 'c1', name: 'worktree', args: ' on' } })
    expect(state.mode).toBe(false)
    state = foldWorktreeState(state, { type: 'command/done', data: { commandId: 'c1', kind: 'error' } })
    expect(state.mode).toBe(false)
    state = foldWorktreeState(state, { type: 'command/run', data: { commandId: 'c2', name: 'worktree', args: 'on' } })
    state = foldWorktreeState(state, { type: 'command/done', data: { commandId: 'c2', kind: 'success' } })
    expect(state.mode).toBe(true)
    expect(state.pending).toEqual({})
    state = foldWorktreeState(state, { type: 'command/run', data: { commandId: 'c3', name: 'worktree', args: 'off' } })
    state = foldWorktreeState(state, { type: 'command/done', data: { commandId: 'c3', kind: 'success' } })
    expect(state.mode).toBe(false)
  })

  it('collects lanes from worktree_open results and ignores unrelated events by reference', () => {
    const state = initialWorktreeState()
    expect(foldWorktreeState(state, { type: 'assistant/message', data: {} })).toBe(state)
    expect(foldWorktreeState(state, { type: 'command/run', data: { commandId: 'x', name: 'worktree', args: 'land a' } })).toBe(state)
    const next = foldWorktreeState(state, { type: 'tool/result', data: { meta: { worktree: { tool: 'worktree_open', lane: 'a-001' } } } })
    expect(next.lanes).toEqual(['a-001'])
    expect(foldWorktreeState(next, { type: 'tool/result', data: { meta: { worktree: { tool: 'worktree_open', lane: 'a-001' } } } })).toBe(next)
    expect(foldWorktreeState(next, { type: 'tool/result', data: { meta: { worktree: { tool: 'worktree_land', lane: 'b-002' } } } })).toBe(next)
    expect(worktreeView(next)).toBe(worktreeView(next))
    expect(worktreeView(next)).toEqual({ mode: false, lanes: ['a-001'] })
  })
})

describe('worktree tools and command', () => {
  const lane = { lane: 'a-001', state: 'ready', summary: 'opened', path: LANE, branch: 'orrery/a-001', next: { tool: 'delegate', args: { worktree: 'a-001' } } }
  const fakeService = (overrides = {}) => ({
    open: async () => lane,
    check: async () => ({ ...lane, state: 'landable' }),
    land: async () => ({ ...lane, state: 'landed', merge: { commit: 'abc' } }),
    askCleanup: async () => ({ ...lane, state: 'cleaned', summary: 'removed', next: null }),
    cleanup: async () => ({ ...lane, state: 'kept' }),
    abandon: async () => ({ ...lane, state: 'abandoned' }),
    view: async () => ({ available: true, mode: false, lanes: [] }),
    watch: async (_session, args) => ({ ...lane, state: 'working', summary: `watching for ${args.states.join(', ')}`, watch: { lane: args.lane, states: args.states, expiresAt: 1234 } }),
    ...overrides,
  })
  const exec = (depth = 0) => ({ agent: { session: { id: 's', header: { cwd: '/r', delegationDepth: depth } } }, signal: new AbortController().signal })

  it('declares object-rooted schemas and persists worktree meta', () => {
    const tools = createWorktreeTools(fakeService())
    expect(tools.map((tool) => tool.name)).toEqual(['worktree_open', 'worktree_check', 'worktree_land', 'worktree_cleanup', 'worktree_abandon', 'worktree_watch'])
    for (const tool of tools) {
      expect(tool.parameters.type).toBe('object')
      expect(typeof tool.output.presentationMeta).toBe('function')
    }
    const open = tools[0]
    expect(open.output.presentationMeta({}, lane)).toEqual({ worktree: { tool: 'worktree_open', lane: 'a-001', state: 'ready', summary: 'opened', next: lane.next } })
    expect(renderResult(lane)).toContain('next: delegate({"worktree":"a-001"})')
  })

  it('lands then asks for cleanup, and refuses delegated children', async () => {
    const tools = createWorktreeTools(fakeService())
    const land = tools.find((tool) => tool.name === 'worktree_land')
    const value = await land.execute({ lane: 'a-001' }, exec())
    expect(value.state).toBe('landed')
    expect(value.cleanup).toEqual({ state: 'cleaned', summary: 'removed' })
    expect(value.next).toBeNull()
    await land.execute({ lane: 'a-001' }, exec(1)).then(() => expect(1).toBe(0), (error) => expect(error.message).toContain('MAIN_AGENT_ONLY'))
  })

  it('worktree_watch: object-rooted schema without any timeout field, watch meta, main-agent only', async () => {
    const tools = createWorktreeTools(fakeService())
    const watch = tools.find((tool) => tool.name === 'worktree_watch')
    expect(watch.parameters.type).toBe('object')
    expect(watch.parameters.required).toEqual(['lane', 'states'])
    // The model can never set or override the timeout (settings-own lifetime).
    expect(Object.keys(watch.parameters.properties)).toEqual(['lane', 'states'])
    expect(watch.parameters.properties.states.type).toBe('array')
    const value = await watch.execute({ lane: 'a-001', states: ['landable'] }, exec())
    expect(value.watch).toEqual({ lane: 'a-001', states: ['landable'], expiresAt: 1234 })
    expect(watch.output.presentationMeta({}, value).worktree).toEqual({
      tool: 'worktree_watch', lane: 'a-001', state: 'working', summary: 'watching for landable', next: lane.next,
      watch: { lane: 'a-001', states: ['landable'], expiresAt: 1234 },
    })
    await watch.execute({ lane: 'a-001', states: ['landable'] }, exec(1)).then(() => expect(1).toBe(0), (error) => expect(error.message).toContain('MAIN_AGENT_ONLY'))
    // an UNWATCHABLE_STATE refusal surfaces the code and the watchable states
    const refusing = createWorktreeTools(fakeService({ watch: async () => { throw new WorktreeError('UNWATCHABLE_STATE', 'cannot watch "working"', { data: { watchable: ['landable'] } }) } }))
    await refusing.find((tool) => tool.name === 'worktree_watch').execute({ lane: 'a-001', states: ['working'] }, exec()).then(
      () => expect(1).toBe(0),
      (error) => {
        expect(error.message).toContain('UNWATCHABLE_STATE')
        expect(error.message).toContain('landable')
      },
    )
  })

  it('renders lane errors with their code and next step', async () => {
    const tools = createWorktreeTools(fakeService({ open: async () => { throw new WorktreeError('MAX_ACTIVE', 'too many', { next: { waitFor: 'user', hint: 'free one' } }) } }))
    await tools[0].execute({ title: 'x' }, exec()).then(() => expect(1).toBe(0), (error) => {
      expect(error.message).toContain('MAX_ACTIVE: too many')
      expect(error.message).toContain('next: wait for user (free one)')
    })
  })

  it('the command maps verbs to the service and treats a user land as approval', async () => {
    const calls = []
    const service = fakeService({
      land: async (_agent, id, options) => { calls.push(['land', id, options]); return { ...lane, state: 'landed' } },
      askCleanup: async () => { calls.push(['askCleanup']); return null },
      cleanup: async (_session, id, mode) => { calls.push(['clean', id, mode]); return { ...lane, state: 'cleaned' } },
    })
    const command = createWorktreeCommand(service, { modeAvailable: async () => null })
    const agent = { session: { id: 's', header: { cwd: '/r' } } }
    expect((await command.handler({ agent, rawInput: ' land a-001' })).kind).toBe('success')
    expect(calls[0]).toEqual(['land', 'a-001', { userApproved: true }])
    expect((await command.handler({ agent, rawInput: 'clean a-001 all' })).kind).toBe('success')
    expect(calls.at(-1)).toEqual(['clean', 'a-001', 'all'])
    expect((await command.handler({ agent, rawInput: 'clean a-001 nuke' })).kind).toBe('error')
    expect((await command.handler({ agent, rawInput: 'bogus' })).text).toContain('Usage: /worktree')
    const switched = await command.handler({ agent, rawInput: 'on' })
    expect(switched.kind).toBe('success')
    expect(switched.text).toContain('changes go through lanes')
    expect(switched.text).toContain('Lanes work without this mode; it is optional discipline.')
    const refusing = createWorktreeCommand(service, { modeAvailable: async () => 'not inside a git repository' })
    expect((await refusing.handler({ agent, rawInput: 'on' })).text).toContain('not inside a git repository')
  })
})

describe('worktree text and settings', () => {
  it('renders the board, the child contract, and notices', () => {
    const record = { id: 'a-001', state: 'landable', landableTree: 'abcdef1234', path: LANE, branch: 'orrery/a-001', base: { branch: 'main' }, scope: ['src/**'] }
    expect(renderBoard({ lanes: [], mode: false })).toBe('')
    expect(renderBoard({ lanes: [record], mode: true })).toContain('a-001 · landable · next: worktree_land({"lane":"a-001"})')
    expect(renderChildContract(record, { readOnly: false })).toContain('Commit your finished work on orrery/a-001')
    expect(renderChildContract(record, { readOnly: false })).toContain('src/**')
    expect(renderNotice(record)).toBe('[worktree] lane a-001 landable@abcdef1 → next: worktree_land({"lane":"a-001"})')
    // watch facts: the board appends `· N watching` only when watches exist
    expect(renderBoard({ lanes: [record], mode: false, watches: [] })).toContain('a-001 · landable · next:')
    expect(renderBoard({ lanes: [record], mode: false, watches: [] })).not.toContain('watching')
    const watched = renderBoard({ lanes: [record], mode: false, watches: [
      { id: 'w1', laneId: 'a-001', sessionId: 's1', states: ['landable'], createdAt: 1, expiresAt: 2 },
      { id: 'w2', laneId: 'a-001', sessionId: 's2', states: ['abandoned'], createdAt: 1, expiresAt: 2 },
      { id: 'w3', laneId: 'b-002', sessionId: 's3', states: ['landable'], createdAt: 1, expiresAt: 2 },
    ] })
    expect(watched).toContain('a-001 · landable · 2 watching · next:')
    expect(renderWatchHit(record)).toBe('[worktree] watch hit: lane a-001 reached landable → next: worktree_land({"lane":"a-001"})')
  })

  it('layers settings over row config over defaults', () => {
    expect(worktreeSettings({}, undefined)).toEqual({ enabled: true, root: '.orrery/worktrees', maxActive: 4, autoSetup: true, watchTimeoutMinutes: 360 })
    expect(worktreeSettings({ maxActive: 2 }, { autoSetup: false })).toEqual({ enabled: true, root: '.orrery/worktrees', maxActive: 2, autoSetup: false, watchTimeoutMinutes: 360 })
    expect(worktreeSettings({}, { watchTimeoutMinutes: 90 }).watchTimeoutMinutes).toBe(90)
    expect(worktreeSettings({ watchTimeoutMinutes: 45 }, { watchTimeoutMinutes: undefined }).watchTimeoutMinutes).toBe(45)
    expect(worktreeSettings({}, { watchTimeoutMinutes: 0 }).watchTimeoutMinutes).toBe(360)
    expect(worktreeSettings({}, { watchTimeoutMinutes: 90.9 }).watchTimeoutMinutes).toBe(90)
    expect(worktreeSettings({}, { maxActive: 0, enabled: false }).maxActive).toBe(4)
  })
})

describe('spawn adapter lane guard', () => {
  const handle = () => {
    const attached = []
    return { attached, ctx: { tools: { guard: (fn) => { attached.push(fn); return () => {} } } } }
  }

  it('attaches the lane guard to a writing one-shot child', async () => {
    const agent = handle()
    const started = { id: 'c1', localAgent: agent, result: Promise.resolve({}), dispose: () => {} }
    const deps = { subagents: { start: async () => started }, robash: () => ({ enabled: true, lists: {} }) }
    await spawnGuardedChild({ target: { persona: 'p', label: 'l' }, prompt: [], parent: {}, signal: undefined, laneGuard: spec() }, oneShotLane(), deps)
    expect(agent.attached).toHaveLength(1)
    expect(agent.attached[0]({ name: 'bash', arguments: { command: 'ls' } })).toContain('workdir')
  })

  it('tears a one-shot child down when the lane guard cannot attach', async () => {
    let disposed = 0
    const started = { id: 'c1', localAgent: { ctx: {} }, result: Promise.resolve({}), dispose: () => { disposed++ } }
    const deps = { subagents: { start: async () => started }, robash: () => ({ enabled: false, lists: {} }) }
    await spawnGuardedChild({ target: { persona: 'p', label: 'l' }, prompt: [], parent: {}, laneGuard: spec() }, oneShotLane(), deps).then(
      () => expect(1).toBe(0),
      (error) => expect(error.message).toContain('read-only bash guard'),
    )
    expect(disposed).toBe(1)
  })

  it('rethrows for supervised members so the group rollback terminates them', async () => {
    const members = []
    const lane = supervisedLane({ coordinator: { registerMember: (record) => record }, groupName: 'g', members })
    const deps = { subagents: { startContinuable: async () => ({ childId: 'm1' }) }, agents: { get: () => ({ ctx: {} }) }, robash: () => ({ enabled: false }) }
    await spawnGuardedChild({ target: { persona: 'p', label: 'l' }, prompt: [], parent: {}, laneGuard: spec() }, lane, deps).then(
      () => expect(1).toBe(0),
      (error) => expect(error.message).toContain('no tool guard'),
    )
    expect(members.map((member) => member.id)).toEqual(['m1'])
  })
})

describe('delegate lane binding', () => {
  function delegateWith({ lanes, target = { persona: 'p', label: 'quick', readOnly: false }, start } = {}) {
    const spawned = []
    const agent = { ctx: { tools: { guard: () => () => {} } } }
    const tool = createDelegateTool({
      resolveTarget: async () => target,
      loadSkill: async () => '',
      subagents: {
        start: start ?? (async (_name, request) => {
          spawned.push(request)
          return { id: `child-${spawned.length}`, localAgent: agent, result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }), dispose: () => {} }
        }),
      },
      jobs: undefined,
      robash: () => ({ enabled: false, lists: {} }),
      coordinatorFor: async () => ({}),
      agents: undefined,
      lanes: () => lanes,
    })
    return { tool, spawned }
  }
  const exec = { agent: { id: 'p', session: { id: 'p', header: { cwd: '/r', delegationDepth: 0 } } }, signal: new AbortController().signal }

  function fakeLanes({ mode = false, settled = { id: 'a-001', state: 'landable', notice: '[worktree] lane a-001 landable → next: worktree_land' } } = {}) {
    const log = []
    return {
      log,
      enabled: () => true,
      modeOf: () => mode,
      resolveArgPath: (_cwd, path) => path,
      prepareBind: async (_session, laneId, options) => {
        log.push(['bind', laneId, options.readOnly])
        return {
          lane: { id: laneId },
          spec: { laneId, lanePath: LANE, scope: null, readOnly: options.readOnly },
          contract: `<lane id="${laneId}">contract</lane>`,
          commit: async (childId) => log.push(['commit', childId]),
          rollback: async () => log.push(['rollback']),
        }
      },
      childSettled: async (childId, _session, options) => {
        log.push(['settled', childId, options])
        return settled
      },
    }
  }

  it('binds, labels, adds the contract, guards, and reports the host check', async () => {
    const lanes = fakeLanes()
    const { tool, spawned } = delegateWith({ lanes })
    const value = await tool.execute({ category: 'quick', prompt: 'TASK: x', worktree: 'a-001' }, exec)
    expect(spawned[0].label).toBe('quick · lane:a-001')
    expect(spawned[0].prompt.at(-1).text).toContain('<lane id="a-001">')
    expect(lanes.log).toEqual([['bind', 'a-001', false], ['commit', 'child-1'], ['settled', 'child-1', { silent: true }]])
    expect(value.results[0].lane.notice).toContain('worktree_land')
    expect(tool.output.render({}, value)[0].text).toContain('[worktree] lane a-001 landable')
  })

  it('rolls the reservation back when the spawn fails', async () => {
    const lanes = fakeLanes()
    const { tool } = delegateWith({ lanes, start: async () => { throw new Error('spawn failed') } })
    await tool.execute({ category: 'quick', prompt: 'TASK: x', worktree: 'a-001' }, exec).then(() => expect(1).toBe(0), () => {})
    expect(lanes.log.map((entry) => entry[0])).toEqual(['bind', 'rollback'])
  })

  it('Worktree mode requires a lane for writing delegations, not for read-only ones', async () => {
    const lanes = fakeLanes({ mode: true })
    const writer = delegateWith({ lanes })
    await writer.tool.execute({ category: 'quick', prompt: 'TASK: x' }, exec).then(() => expect(1).toBe(0), (error) => expect(error.message).toContain('WORKTREE_REQUIRED'))
    expect(writer.spawned).toHaveLength(0)
    const reader = delegateWith({ lanes, target: { persona: 'p', label: 'finder', readOnly: true } })
    await reader.tool.execute({ agent: 'finder', prompt: 'TASK: find' }, exec)
    expect(reader.spawned).toHaveLength(1)
  })

  it('surfaces lane refusals with their next step and spawns nothing', async () => {
    const lanes = fakeLanes()
    lanes.prepareBind = async () => { throw new WorktreeError('LANE_BUSY', 'lane a-001 already has a bound worker', { next: { waitFor: 'child-settle' } }) }
    const { tool, spawned } = delegateWith({ lanes })
    await tool.execute({ category: 'quick', prompt: 'TASK: x', worktree: 'a-001' }, exec).then(() => expect(1).toBe(0), (error) => {
      expect(error.message).toContain('LANE_BUSY')
      expect(error.message).toContain('next: wait for child-settle')
    })
    expect(spawned).toHaveLength(0)
  })

  it('without the parameter and without Worktree mode nothing changes', async () => {
    const lanes = fakeLanes()
    const { tool, spawned } = delegateWith({ lanes })
    await tool.execute({ category: 'quick', prompt: 'TASK: x' }, exec)
    expect(spawned[0].label).toBe('quick')
    expect(lanes.log).toEqual([])
  })

  it('refuses the parameter when the capability is off', async () => {
    const { tool } = delegateWith({ lanes: undefined })
    await tool.execute({ category: 'quick', prompt: 'TASK: x', worktree: 'a-001' }, exec).then(() => expect(1).toBe(0), (error) => expect(error.message).toContain('WORKTREE_DISABLED'))
  })
})

describe('Worktree mode guard on main agents', () => {
  function harness(mode) {
    const handlers = {}
    const ctx = { on: (name, fn) => { handlers[name] = fn; return () => {} } }
    attachWorktreeModeGuard(ctx, { lanes: () => ({ modeOf: () => mode.on }), robash: () => ({ enabled: true, lists: { bash: DEFAULT_ROBASH, pwsh: DEFAULT_ROBASH_PWSH } }) })
    const guards = []
    const main = { id: 'm', session: { header: { delegationDepth: 0 } }, ctx: { tools: { guard: (fn) => { guards.push(fn); return () => {} } } } }
    const child = { id: 'c', session: { header: { delegationDepth: 1 } }, ctx: { tools: { guard: (fn) => { guards.push(fn); return () => {} } } } }
    handlers['agent/created']({ agent: main })
    handlers['agent/created']({ agent: child })
    return { guard: guards[0], count: guards.length, main, child }
  }

  it('covers a main agent that existed before the plugin mounted, through the scope guard and the existing roots', () => {
    const mode = { on: true }
    const scopeGuards = []
    const existingGuards = []
    const existing = { id: 'early', session: { header: { delegationDepth: 0 } }, ctx: { tools: { guard: (fn) => { existingGuards.push(fn); return () => {} } } } }
    const ctx = {
      on: () => () => {},
      tools: { guard: (fn) => { scopeGuards.push(fn); return () => {} } },
      get: (name) => (name === 'agents' ? { roots: () => [existing] } : undefined),
    }
    attachWorktreeModeGuard(ctx, { lanes: () => ({ modeOf: () => mode.on }), robash: () => ({ enabled: true, lists: { bash: DEFAULT_ROBASH, pwsh: DEFAULT_ROBASH_PWSH } }) })
    expect(scopeGuards).toHaveLength(1)
    expect(existingGuards).toHaveLength(1)
    const call = { name: 'bash', agent: existing, arguments: { command: 'git branch -D x' } }
    expect(scopeGuards[0](call)).toContain('read-only')
    expect(existingGuards[0](call)).toContain('read-only')
    expect(scopeGuards[0]({ name: 'bash', agent: existing, arguments: { command: 'git branch' } })).toBeUndefined()
    const child = { id: 'c', session: { header: { delegationDepth: 1 } } }
    expect(scopeGuards[0]({ name: 'write', agent: child, arguments: { file_path: '/r/a' } })).toBeUndefined()
    mode.on = false
    expect(scopeGuards[0](call)).toBeUndefined()
  })

  it('guards only main agents and only while the mode is on', () => {
    const mode = { on: false }
    const { guard, count, main, child } = harness(mode)
    expect(count).toBe(1)
    expect(guard({ name: 'write', agent: main, arguments: { file_path: '/r/a' } })).toBeUndefined()
    mode.on = true
    expect(guard({ name: 'write', agent: main, arguments: { file_path: '/r/a' } })).toContain('Worktree mode is on')
    expect(guard({ name: 'bash', agent: main, arguments: { command: 'git checkout -b x' } })).toContain('read-only')
    expect(guard({ name: 'bash', agent: main, arguments: { command: 'git status' } })).toBeUndefined()
    expect(guard({ name: 'write', agent: child, arguments: { file_path: '/r/a' } })).toBeUndefined()
  })
})
