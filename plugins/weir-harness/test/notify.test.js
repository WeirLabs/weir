import { describe, expect, it } from './helpers.js'
import {
  attentionOfToolCall,
  classifyTurnEnd,
  createCoalescer,
  DEFAULTS,
  isChildSession,
} from '../src/notify/policy.js'
import { clean, compose, formatDuration } from '../src/notify/messages.js'
import { buildCommand } from '../src/notify/commands.js'
import { createNotifier } from '../src/notify/notifier.js'
import { apply, wire } from '../src/notify/index.js'

describe('classifyTurnEnd', () => {
  const cases = [
    { name: 'completed', reason: { kind: 'completed' }, expected: { kind: 'completed' } },
    { name: 'error carries the failure message', reason: { kind: 'error', error: { message: 'rate limited', code: 'x' } }, expected: { kind: 'failed', detail: 'rate limited' } },
    { name: 'error without a message', reason: { kind: 'error', error: {} }, expected: { kind: 'failed' } },
    { name: 'blocked', reason: { kind: 'blocked' }, expected: { kind: 'stopped', detail: 'blocked' } },
    { name: 'max-tokens', reason: { kind: 'max-tokens' }, expected: { kind: 'stopped', detail: 'max-tokens' } },
    { name: 'hook abort', reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } }, expected: { kind: 'stopped', detail: 'hook' } },
    { name: 'user abort is silent', reason: { kind: 'aborted', reason: { kind: 'user' } }, expected: { kind: 'none' } },
    { name: 'parent abort is silent', reason: { kind: 'aborted', reason: { kind: 'parent' } }, expected: { kind: 'none' } },
    { name: 'disposed abort is silent', reason: { kind: 'aborted', reason: { kind: 'disposed' } }, expected: { kind: 'none' } },
    { name: 'abort without a cause is silent', reason: { kind: 'aborted' }, expected: { kind: 'none' } },
    { name: 'interrupted is silent', reason: { kind: 'interrupted' }, expected: { kind: 'none' } },
    { name: 'forked is silent', reason: { kind: 'forked' }, expected: { kind: 'none' } },
    { name: 'unknown kind is silent', reason: { kind: 'some-new-kind' }, expected: { kind: 'none' } },
    { name: 'missing reason is silent', reason: undefined, expected: { kind: 'none' } },
  ]
  for (const { name, reason, expected } of cases) {
    it(name, () => {
      expect(classifyTurnEnd(reason)).toEqual(expected)
    })
  }
})

describe('isChildSession', () => {
  it('recognises delegated children by origin or parent', () => {
    expect(isChildSession({ header: { origin: 'subagent' } })).toBe(true)
    expect(isChildSession({ header: { parentSession: 'root' } })).toBe(true)
    expect(isChildSession({ header: {} })).toBe(false)
    expect(isChildSession(undefined)).toBe(false)
  })
})

describe('attentionOfToolCall', () => {
  it('extracts the first question of ask_user_question', () => {
    const args = JSON.stringify({ questions: [{ id: 'a', question: '  Which database?  ' }, { id: 'b', question: 'second' }] })
    expect(attentionOfToolCall('ask_user_question', args)).toEqual({ kind: 'question', question: 'Which database?' })
  })

  it('degrades to a bare question on unusable arguments', () => {
    expect(attentionOfToolCall('ask_user_question', '{not json')).toEqual({ kind: 'question' })
    expect(attentionOfToolCall('ask_user_question', '{"questions":[]}')).toEqual({ kind: 'question' })
  })

  it('maps exit_plan_mode to plan review and ignores other tools', () => {
    expect(attentionOfToolCall('exit_plan_mode', '{"plan":"# x"}')).toEqual({ kind: 'plan' })
    expect(attentionOfToolCall('bash', '{}')).toBeUndefined()
  })
})

describe('createCoalescer', () => {
  it('drops a repeat inside the window and accepts again after it', () => {
    let time = 1000
    const coalescer = createCoalescer(3000, () => time)
    expect(coalescer.accept('s:approval')).toBe(true)
    time = 2500
    expect(coalescer.accept('s:approval')).toBe(false)
    expect(coalescer.accept('s:question')).toBe(true)
    time = 4000
    expect(coalescer.accept('s:approval')).toBe(true)
  })

  it('restarts the window only from an accepted hit', () => {
    let time = 0
    const coalescer = createCoalescer(1000, () => time)
    expect(coalescer.accept('k')).toBe(true)
    time = 900
    expect(coalescer.accept('k')).toBe(false)
    time = 1100
    expect(coalescer.accept('k')).toBe(true)
  })
})

describe('message composition', () => {
  it('flattens whitespace and control characters and truncates on a code point', () => {
    expect(clean('a\n\tb\u0007  c', 20)).toBe('a b c')
    expect(clean('x'.repeat(10), 5)).toBe('xxxx…')
    expect(Array.from(clean('😀'.repeat(10), 4))).toHaveLength(4)
    expect(clean(undefined, 5)).toBe('')
  })

  it('formats durations', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(130_000)).toBe('2m 10s')
    expect(formatDuration(120_000)).toBe('2m')
    expect(formatDuration(3_900_000)).toBe('1h 5m')
  })

  it('composes each kind with the session label verbatim', () => {
    expect(compose({ type: 'completed', durationMs: 130_000 }, '修复登录')).toEqual({
      title: 'Task finished', body: '修复登录 — finished in 2m 10s', urgent: false,
    })
    expect(compose({ type: 'approval', toolName: 'bash' }, 'T').body).toBe('T — wants to use bash')
    expect(compose({ type: 'question', question: 'Which database?' }, 'T').body).toBe('T — Which database?')
    expect(compose({ type: 'plan' }, 'T').title).toBe('Plan ready for review')
    expect(compose({ type: 'failed', detail: 'boom' }, 'T')).toEqual({ title: 'Task failed', body: 'T — boom', urgent: true })
    expect(compose({ type: 'stopped', detail: 'max-tokens' }, 'T').body).toBe('T — reached the output limit')
  })

  it('omits the separator when the session has no label', () => {
    expect(compose({ type: 'approval' }, '').body).toBe('waiting for your approval')
  })

  it('bounds the body length', () => {
    const note = compose({ type: 'question', question: 'q'.repeat(500) }, 't'.repeat(500))
    expect(Array.from(note.body).length <= 160).toBe(true)
  })
})

describe('platform commands', () => {
  const note = { title: 'Approval needed', body: '-rf "quoted" $(whoami) \\ — wants bash', urgent: true }

  it('macOS passes text as argv, never inside script source', () => {
    const command = buildCommand('darwin', note, { sound: true })
    expect(command.file).toBe('osascript')
    const source = command.args.filter((_, index) => command.args[index - 1] === '-e').join('\n')
    expect(source).toContain('item 2 of argv')
    expect(source.includes('quoted')).toBe(false)
    expect(source).toContain('sound name "Glass"')
    expect(command.args.slice(-2)).toEqual([note.title, note.body])
    expect(command.args[command.args.length - 2].startsWith('-')).toBe(false)
  })

  it('macOS drops the sound clause when sound is off', () => {
    const command = buildCommand('darwin', note, { sound: false })
    expect(command.args.join(' ').includes('sound name')).toBe(false)
  })

  it('Linux ends option parsing before the text', () => {
    const command = buildCommand('linux', note, { sound: false })
    expect(command.file).toBe('notify-send')
    const dashes = command.args.indexOf('--')
    expect(command.args.slice(dashes + 1)).toEqual([note.title, note.body])
    expect(command.args).toContain('--urgency=normal')
    expect(buildCommand('linux', { ...note, urgent: false }, { sound: false }).args).toContain('--urgency=low')
  })

  it('Windows hands the text over through the environment with an encoded script', () => {
    const command = buildCommand('win32', note, { sound: false })
    expect(command.file).toBe('powershell.exe')
    expect(command.env).toEqual({ DSH_NOTIFY_TITLE: note.title, DSH_NOTIFY_BODY: note.body, DSH_NOTIFY_SILENT: '1' })
    const encoded = command.args[command.args.indexOf('-EncodedCommand') + 1]
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain('$env:DSH_NOTIFY_TITLE')
    expect(script.includes('quoted')).toBe(false)
    expect(buildCommand('win32', note, { sound: true }).env.DSH_NOTIFY_SILENT).toBe('0')
  })

  it('has no command for unsupported platforms', () => {
    expect(buildCommand('freebsd', note, { sound: true })).toBeUndefined()
  })
})

describe('createNotifier', () => {
  const note = { title: 'T', body: 'B', urgent: false }

  it('starts the platform command with a timeout and merges command env over the base env', () => {
    const calls = []
    const notifier = createNotifier({
      platform: 'win32',
      env: { PATH: 'p' },
      execFile: (file, args, options, callback) => {
        calls.push({ file, options })
        callback(null)
      },
    })
    expect(notifier.supported).toBe(true)
    expect(notifier.send(note, { sound: true })).toBe(true)
    expect(calls[0].file).toBe('powershell.exe')
    expect(calls[0].options.timeout).toBeGreaterThan(0)
    expect(calls[0].options.env.PATH).toBe('p')
    expect(calls[0].options.env.DSH_NOTIFY_TITLE).toBe('T')
  })

  it('warns once per cause when the tool is missing and never throws', () => {
    const warnings = []
    const notifier = createNotifier({
      platform: 'linux',
      logger: { warn: (message) => warnings.push(message) },
      execFile: (_file, _args, _options, callback) => callback(Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' })),
    })
    notifier.send(note, { sound: false })
    notifier.send(note, { sound: false })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('notify-send')
  })

  it('survives a synchronous spawn failure', () => {
    const warnings = []
    const notifier = createNotifier({
      platform: 'darwin',
      logger: { warn: (message) => warnings.push(message) },
      execFile: () => { throw new Error('EPERM') },
    })
    expect(notifier.send(note, { sound: false })).toBe(false)
    expect(warnings).toHaveLength(1)
  })

  it('reports an unsupported platform without starting anything', () => {
    let started = false
    const warnings = []
    const notifier = createNotifier({
      platform: 'aix',
      logger: { warn: (message) => warnings.push(message) },
      execFile: () => { started = true },
    })
    expect(notifier.supported).toBe(false)
    expect(notifier.send(note, { sound: false })).toBe(false)
    expect(started).toBe(false)
    expect(warnings).toHaveLength(1)
  })
})

describe('notify plugin wiring', () => {
  /** A controllable clock + timer so settle windows are deterministic. */
  function harness({ settings, config = {}, sessions = {} } = {}) {
    const handlers = {}
    const sent = []
    const timers = new Map()
    let nextTimer = 1
    let time = 1_000_000
    const ctx = {
      on: (name, handler) => {
        handlers[name] = handler
        return () => delete handlers[name]
      },
      get: (service) => {
        if (service === 'weirSettings' && settings) return { get: (key) => settings[key] }
        if (service === 'sessions') return { get: (id) => sessions[id] }
        return undefined
      },
      logger: { warn: () => {} },
    }
    const dispose = wire(ctx, config, {
      notifier: { send: (note, options) => { sent.push({ note, options }); return true } },
      now: () => time,
      setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id },
      clearTimer: (id) => timers.delete(id),
    })
    return {
      handlers, sent, timers, dispose,
      advance: (ms) => { time += ms },
      now: () => time,
      fire: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn() } },
      emit: (session, type, data = {}, at = time) => handlers['session/event'](session, { type, data, time: at }),
    }
  }

  const root = { id: 'root', header: { cwd: '/work/project-x' } }

  it('holds a finished long turn for the settle window, then reports its duration', () => {
    const h = harness()
    h.emit(root, 'turn/start', { turn: 1 })
    h.advance(130_000)
    h.emit(root, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.sent).toHaveLength(0)
    expect([...h.timers.values()][0].ms).toBe(DEFAULTS.settleMs)
    h.fire()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].note.title).toBe('Task finished')
    expect(h.sent[0].note.body).toBe('project-x — finished in 2m 10s')
    expect(h.sent[0].options).toEqual({ sound: true })
  })

  it('skips a turn shorter than the minimum', () => {
    const h = harness()
    h.emit(root, 'turn/start')
    h.advance(5_000)
    h.emit(root, 'turn/end', { reason: { kind: 'completed' } })
    expect(h.timers.size).toBe(0)
    expect(h.sent).toHaveLength(0)
  })

  it('retracts the held completion when the agent runs again', () => {
    const h = harness()
    h.emit(root, 'turn/start')
    h.advance(60_000)
    h.emit(root, 'turn/end', { reason: { kind: 'completed' } })
    expect(h.timers.size).toBe(1)
    h.handlers['agent/status']({ agent: { id: 'root' }, status: 'running' })
    expect(h.timers.size).toBe(0)
    h.fire()
    expect(h.sent).toHaveLength(0)
  })

  it('retracts the held completion when a new turn starts', () => {
    const h = harness()
    h.emit(root, 'turn/start')
    h.advance(60_000)
    h.emit(root, 'turn/end', { reason: { kind: 'completed' } })
    h.emit(root, 'turn/start')
    expect(h.timers.size).toBe(0)
  })

  it('never reports a delegated child turn or a user abort', () => {
    const h = harness()
    const child = { id: 'kid', header: { origin: 'subagent', parentSession: 'root' } }
    h.emit(child, 'turn/start')
    h.advance(60_000)
    h.emit(child, 'turn/end', { reason: { kind: 'completed' } })
    h.emit(root, 'turn/start')
    h.advance(60_000)
    h.emit(root, 'turn/end', { reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(h.timers.size).toBe(0)
    expect(h.sent).toHaveLength(0)
  })

  it('reports a failed turn as needing attention regardless of its length', () => {
    const h = harness()
    h.emit(root, 'turn/start')
    h.advance(1_000)
    h.emit(root, 'turn/end', { reason: { kind: 'error', error: { message: 'upstream 503', code: 'E' } } })
    h.fire()
    expect(h.sent[0].note).toEqual({ title: 'Task failed', body: 'project-x — upstream 503', urgent: true })
  })

  it('reports an approval request immediately and coalesces a burst', () => {
    const h = harness()
    h.emit(root, 'approval/asked', { id: 'a', toolName: 'bash' })
    h.emit(root, 'approval/asked', { id: 'b', toolName: 'write' })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].note.title).toBe('Approval needed')
    expect(h.sent[0].note.body).toBe('project-x — wants to use bash')
    h.advance(DEFAULTS.coalesceMs + 1)
    h.emit(root, 'approval/asked', { id: 'c', toolName: 'write' })
    expect(h.sent).toHaveLength(2)
  })

  it('attributes a child approval to its top-level session', () => {
    const titled = { id: 'root', header: { cwd: '/work/project-x' } }
    const child = { id: 'kid', header: { origin: 'subagent', parentSession: 'root' } }
    const h = harness({ sessions: { root: titled } })
    h.emit(child, 'approval/asked', { id: 'a', toolName: 'bash' })
    expect(h.sent[0].note.body).toBe('project-x — wants to use bash')
  })

  it('reports ask_user_question and exit_plan_mode as soon as the call is logged', () => {
    const h = harness()
    h.emit(root, 'tool/call', { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Which database?' }] }) })
    expect(h.sent[0].note).toEqual({ title: 'Question for you', body: 'project-x — Which database?', urgent: true })
    h.emit(root, 'tool/call', { name: 'exit_plan_mode', arguments: '{"plan":"# p"}' })
    expect(h.sent[1].note.title).toBe('Plan ready for review')
    h.emit(root, 'tool/call', { name: 'bash', arguments: '{}' })
    expect(h.sent).toHaveLength(2)
  })

  it('delivers a worktree decision-card question immediately with the trimmed text', () => {
    const h = harness()
    h.handlers['worktree/question'](root, { question: '  Merge lane "Fix login" into main?  ' })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].note).toEqual({ title: 'Question for you', body: 'project-x — Merge lane "Fix login" into main?', urgent: true })
  })

  it('degrades to a bare question when the worktree payload carries no usable text', () => {
    const h = harness()
    h.handlers['worktree/question'](root, null)
    h.handlers['worktree/question'](root, { question: '   ' })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].note).toEqual({ title: 'Question for you', body: 'project-x — waiting for your answer', urgent: true })
  })

  it('drops the worktree question when onAttention is off', () => {
    const h = harness({ settings: { notify: { onAttention: false } } })
    h.handlers['worktree/question'](root, { question: 'Abandon lane "Fix login"?' })
    expect(h.sent).toHaveLength(0)
  })

  it('a throwing notifier never escapes the worktree question listener', () => {
    const handlers = {}
    const warnings = []
    wire(
      { on: (name, handler) => { handlers[name] = handler }, get: () => undefined, logger: { warn: (message) => warnings.push(message) } },
      {},
      { notifier: { send: () => { throw new Error('boom') } } },
    )
    handlers['worktree/question']({ id: 's' }, { question: 'q' })
    expect(warnings.some((message) => message.includes('boom'))).toBe(true)
  })

  it('a delegated child cannot raise a question notification', () => {
    const h = harness()
    const child = { id: 'kid', header: { origin: 'subagent', parentSession: 'root' } }
    h.emit(child, 'tool/call', { name: 'ask_user_question', arguments: '{}' })
    expect(h.sent).toHaveLength(0)
  })

  it('ignores replayed history', () => {
    const h = harness()
    h.emit(root, 'approval/asked', { id: 'old', toolName: 'bash' }, h.now() - 10 * 60_000)
    expect(h.sent).toHaveLength(0)
  })

  it('honours the settings overlay live: master switch, kinds, sound and minimum', () => {
    const settings = { notify: { enabled: false } }
    const h = harness({ settings })
    h.emit(root, 'approval/asked', { id: 'a', toolName: 'bash' })
    expect(h.sent).toHaveLength(0)

    settings.notify = { enabled: true, onAttention: false, sound: false, minTurnSeconds: 0 }
    h.emit(root, 'approval/asked', { id: 'b', toolName: 'bash' })
    expect(h.sent).toHaveLength(0)
    h.emit(root, 'turn/start')
    h.advance(1_000)
    h.emit(root, 'turn/end', { reason: { kind: 'completed' } })
    h.fire()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].options).toEqual({ sound: false })

    settings.notify = { onComplete: false }
    h.emit(root, 'turn/start')
    h.advance(60_000)
    h.emit(root, 'turn/end', { reason: { kind: 'completed' } })
    expect(h.timers.size).toBe(0)
  })

  it('falls back to defaults for unusable setting values instead of throwing', () => {
    const h = harness({ settings: { notify: { enabled: 'yes', minTurnSeconds: -3, onAttention: 1 } } })
    h.emit(root, 'approval/asked', { id: 'a', toolName: 'bash' })
    expect(h.sent).toHaveLength(1)
  })

  it('drops pending notifications and listeners on dispose', () => {
    const h = harness()
    h.emit(root, 'turn/start')
    h.advance(60_000)
    h.emit(root, 'turn/end', { reason: { kind: 'completed' } })
    expect(h.timers.size).toBe(1)
    h.dispose()
    expect(h.timers.size).toBe(0)
    expect(Object.keys(h.handlers)).toHaveLength(0)
  })

  it('a throwing notifier never escapes the event listener', () => {
    const handlers = {}
    const warnings = []
    wire(
      { on: (name, handler) => { handlers[name] = handler }, get: () => undefined, logger: { warn: (message) => warnings.push(message) } },
      {},
      { notifier: { send: () => { throw new Error('boom') } } },
    )
    handlers['session/event']({ id: 's' }, { type: 'approval/asked', data: { toolName: 'bash' } })
    expect(warnings.some((message) => message.includes('boom'))).toBe(true)
  })

  it('apply returns a disposer and registers the four listeners', () => {
    const handlers = {}
    const dispose = apply({ on: (name, handler) => { handlers[name] = handler }, get: () => undefined, logger: { warn: () => {} } }, {})
    expect(Object.keys(handlers).sort()).toEqual(['agent/status', 'session/disposed', 'session/event', 'worktree/question'])
    expect(typeof dispose).toBe('function')
    dispose()
  })
})

describe('notify routing through the web channel', () => {
  /** The wire() harness again, but with a recording channel instead of the system notifier. */
  function routed({ settings, sessions = {} } = {}) {
    const handlers = {}
    const channelSent = []
    const systemSent = []
    let time = 1_000_000
    const ctx = {
      on: (name, handler) => { handlers[name] = handler; return () => delete handlers[name] },
      get: (service) => {
        if (service === 'weirSettings' && settings) return { get: (key) => settings[key] }
        if (service === 'sessions') return { get: (id) => sessions[id] }
        return undefined
      },
      logger: { warn: () => {} },
    }
    wire(ctx, {}, {
      notifier: { send: (note, options) => { systemSent.push({ note, options }); return true } },
      channel: { send: (note) => { channelSent.push(note); return 'queued' } },
      now: () => time,
      setTimer: () => 1,
      clearTimer: () => {},
    })
    return {
      channelSent, systemSent,
      advance: (ms) => { time += ms },
      emit: (session, type, data = {}) => handlers['session/event'](session, { type, data, time }),
    }
  }
  const sessionA = { id: 'a', header: { cwd: '/work/a' } }
  const sessionB = { id: 'b', header: { cwd: '/work/b' } }

  it('sends through the channel with a tag, re-alert and the foreground policy, not directly', () => {
    const r = routed()
    r.emit(sessionA, 'approval/asked', { toolName: 'bash' })
    expect(r.systemSent).toHaveLength(0)
    expect(r.channelSent).toHaveLength(1)
    const note = r.channelSent[0]
    expect(note.title).toBe('Approval needed')
    expect(note.tag).toBe('weir:a:approval')
    expect(note.renotify).toBe(true)
    expect(note.sound).toBe(true)
    expect(note.foreground).toBe('skip')
  })

  it('uses the same tag for the same session and type, and different tags otherwise', () => {
    const r = routed()
    r.emit(sessionA, 'approval/asked', { toolName: 'bash' })
    r.advance(10_000)
    r.emit(sessionA, 'approval/asked', { toolName: 'write' })
    r.emit(sessionB, 'approval/asked', { toolName: 'bash' })
    r.emit(sessionA, 'tool/call', { name: 'exit_plan_mode', arguments: '{}' })
    const tags = r.channelSent.map((note) => note.tag)
    expect(tags[0]).toBe(tags[1])
    expect(tags[2]).not.toBe(tags[0])
    expect(tags[3]).not.toBe(tags[0])
    expect(new Set(tags).size).toBe(3)
  })

  it('tags a delegated child under its top-level session, so it merges with the parent', () => {
    const r = routed({ sessions: { a: sessionA } })
    const child = { id: 'kid', header: { origin: 'subagent', parentSession: 'a' } }
    r.emit(sessionA, 'approval/asked', { toolName: 'bash' })
    r.advance(10_000)
    r.emit(child, 'approval/asked', { toolName: 'bash' })
    expect(r.channelSent[0].tag).toBe(r.channelSent[1].tag)
  })

  it('passes the foreground setting through, live, and falls back to skip on a bad value', () => {
    const settings = { notify: { foreground: 'always' } }
    const r = routed({ settings })
    r.emit(sessionA, 'approval/asked', { toolName: 'bash' })
    expect(r.channelSent[0].foreground).toBe('always')
    settings.notify = { foreground: 'sometimes' }
    r.advance(10_000)
    r.emit(sessionA, 'approval/asked', { toolName: 'bash' })
    expect(r.channelSent[1].foreground).toBe('skip')
  })

  it('still honours the master switch before reaching the channel', () => {
    const r = routed({ settings: { notify: { enabled: false } } })
    r.emit(sessionA, 'approval/asked', { toolName: 'bash' })
    expect(r.channelSent).toHaveLength(0)
    expect(r.systemSent).toHaveLength(0)
  })

  it('keeps the host-side merge window, so a burst queues one note', () => {
    const r = routed()
    r.emit(sessionA, 'approval/asked', { toolName: 'bash' })
    r.emit(sessionA, 'approval/asked', { toolName: 'write' })
    expect(r.channelSent).toHaveLength(1)
  })

  it('without a channel it behaves as before: the system notifier directly', () => {
    const handlers = {}
    const systemSent = []
    wire({ on: (name, handler) => { handlers[name] = handler; return () => {} }, get: () => undefined, logger: { warn: () => {} } }, {}, {
      notifier: { send: (note) => { systemSent.push(note); return true } },
    })
    handlers['session/event']({ id: 'a', header: {} }, { type: 'approval/asked', data: { toolName: 'bash' }, time: Date.now() })
    expect(systemSent).toHaveLength(1)
  })
})
