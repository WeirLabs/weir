import { describe, expect, it } from './helpers.js'
import {
  ACTIONS,
  classifyNotificationPermission,
  OPEN,
  OSASCRIPT,
  parseProbeOutput,
  readNotificationPermission,
  runPermissionAction,
  SENDER,
  SETTINGS_URL,
  TEST_NOTE,
} from '../src/notify/permissions.js'
import { registerNotifyPermissionEndpoints, wireNotifyPermissions } from '../src/notify/permissions-admin.js'

/** An execFile that records calls and answers from a script. */
function fakeExec(answer = () => ({ stdout: '' })) {
  const calls = []
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options })
    const result = answer(file, args)
    if (result.error) callback(result.error)
    else callback(null, result.stdout ?? '', result.stderr ?? '')
  }
  return { execFile, calls }
}

describe('parseProbeOutput', () => {
  it('reads the last JSON line of the output', () => {
    expect(parseProbeOutput('noise\n{"ok":true,"entry":{"auth":7,"flags":8206}}\n')).toEqual({ ok: true, entry: { auth: 7, flags: 8206 } })
  })

  it('keeps a missing sender entry distinct from an unreadable result', () => {
    expect(parseProbeOutput('{"ok":true,"entry":null}')).toEqual({ ok: true, entry: null })
    expect(parseProbeOutput('')).toEqual({ ok: false })
    expect(parseProbeOutput('not json')).toEqual({ ok: false })
    expect(parseProbeOutput('{"ok":false}')).toEqual({ ok: false })
    expect(parseProbeOutput('{"ok":true,"entry":5}')).toEqual({ ok: false })
    expect(parseProbeOutput(undefined)).toEqual({ ok: false })
  })

  it('coerces non-numeric fields to null', () => {
    expect(parseProbeOutput('{"ok":true,"entry":{"auth":"7","flags":null}}')).toEqual({ ok: true, entry: { auth: null, flags: null } })
  })
})

describe('classifyNotificationPermission', () => {
  const entry = (auth, flags = 8206) => ({ ok: true, entry: { auth, flags } })
  const cases = [
    { name: 'auth with the alert bit (7)', probe: entry(7), expected: { state: 'granted', reason: 'alerts-allowed' } },
    { name: 'auth with the alert bit (4)', probe: entry(4), expected: { state: 'granted', reason: 'alerts-allowed' } },
    { name: 'auth without the alert bit (badge only)', probe: entry(1), expected: { state: 'denied', reason: 'not-allowed' } },
    { name: 'explicit auth 0', probe: entry(0), expected: { state: 'denied', reason: 'not-allowed' } },
    { name: 'auth absent is the system default, not a verdict', probe: entry(null), expected: { state: 'unknown', reason: 'default' } },
    { name: 'no record for the sender', probe: { ok: true, entry: null }, expected: { state: 'unknown', reason: 'no-record' } },
    { name: 'unreadable preferences', probe: { ok: false }, expected: { state: 'unknown', reason: 'unreadable' } },
    { name: 'undefined probe', probe: undefined, expected: { state: 'unknown', reason: 'unreadable' } },
  ]
  for (const { name, probe, expected } of cases) {
    it(name, () => {
      const result = classifyNotificationPermission(probe)
      expect(result.state).toBe(expected.state)
      expect(result.reason).toBe(expected.reason)
    })
  }

  it('never promotes a style flag to granted when auth is absent', () => {
    expect(classifyNotificationPermission(entry(null, 0x1080200e)).state).toBe('unknown')
  })

  it('reports the raw values for troubleshooting', () => {
    expect(classifyNotificationPermission(entry(7, 123))).toEqual({ state: 'granted', reason: 'alerts-allowed', auth: 7, flags: 123 })
  })
})

describe('readNotificationPermission', () => {
  it('runs the fixed probe through the absolute osascript path and classifies stdout', async () => {
    const { execFile, calls } = fakeExec(() => ({ stdout: '{"ok":true,"entry":{"auth":7,"flags":8206}}' }))
    const permission = await readNotificationPermission({ execFile })
    expect(permission.state).toBe('granted')
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(OSASCRIPT)
    expect(calls[0].args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
    expect(calls[0].args[3]).toContain(SENDER.bundleId)
    expect(calls[0].options.timeout).toBeGreaterThan(0)
  })

  it('falls back to stderr, where some osascript versions print a JXA result', async () => {
    const { execFile } = fakeExec(() => ({ stdout: '', stderr: '{"ok":true,"entry":null}' }))
    expect((await readNotificationPermission({ execFile })).reason).toBe('no-record')
  })

  it('answers unknown instead of throwing when the command fails', async () => {
    const { execFile } = fakeExec(() => ({ error: Object.assign(new Error('boom'), { code: 'ENOENT' }) }))
    expect(await readNotificationPermission({ execFile })).toEqual({ state: 'unknown', reason: 'unreadable', auth: null, flags: null })
    const throwing = () => { throw new Error('spawn failed') }
    expect((await readNotificationPermission({ execFile: throwing })).state).toBe('unknown')
  })
})

describe('runPermissionAction', () => {
  it('opens the Notifications settings page with the fixed URL', async () => {
    const { execFile, calls } = fakeExec()
    await runPermissionAction('open-settings', { execFile })
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(OPEN)
    expect(calls[0].args).toEqual([SETTINGS_URL])
    expect(SETTINGS_URL).toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
  })

  it('sends the test notification through the real delivery path, not a command of its own', async () => {
    const { execFile, calls } = fakeExec()
    const sent = []
    await runPermissionAction('test', { execFile, sendTest: () => sent.push('test') })
    expect(sent).toEqual(['test'])
    expect(calls).toHaveLength(0)
  })

  it('refuses the test action when no delivery path is available', async () => {
    const { execFile } = fakeExec()
    let message = ''
    try { await runPermissionAction('test', { execFile }) } catch (caught) { message = caught.message }
    expect(message).toContain('not available')
  })

  it('names DeepSeek Harness as the sender, since the page delivers as DSH', () => {
    expect(SENDER).toEqual({ bundleId: 'com.deepseek.dsh', name: 'DeepSeek Harness' })
    expect(TEST_NOTE.body).toContain('DeepSeek Harness')
  })

  it('rejects an unknown action before running anything', async () => {
    const { execFile, calls } = fakeExec()
    let error
    try { await runPermissionAction('rm -rf /', { execFile }) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(Error)
    expect(calls).toHaveLength(0)
    expect([...ACTIONS]).toEqual(['test', 'open-settings'])
  })

  it('surfaces a command failure to the caller', async () => {
    const { execFile } = fakeExec(() => ({ error: new Error('open failed') }))
    let message = ''
    try { await runPermissionAction('open-settings', { execFile }) } catch (caught) { message = caught.message }
    expect(message).toBe('open failed')
  })
})

describe('permission endpoints', () => {
  function fakeScope() {
    const routes = new Map()
    const disposed = []
    const scope = {
      connection: {
        fetch: {
          register: (route) => {
            routes.set(route.path, route)
            return () => disposed.push(route.path)
          },
        },
      },
      logger: { warn: () => {} },
    }
    return { scope, routes, disposed }
  }
  const post = (body) => ({ json: async () => body })

  it('registers a status and an action route, POST only', () => {
    const { scope, routes } = fakeScope()
    registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile: fakeExec().execFile })
    expect([...routes.keys()].sort()).toEqual(['/api/orrery-notify/permissions/action', '/api/orrery-notify/permissions/status'])
    for (const route of routes.values()) expect(route.methods).toEqual(['POST'])
  })

  it('reports the permission on macOS', async () => {
    const { scope, routes } = fakeScope()
    const { execFile } = fakeExec(() => ({ stdout: '{"ok":true,"entry":{"auth":7,"flags":1}}' }))
    registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile })
    const response = await routes.get('/api/orrery-notify/permissions/status').fetch(post({}))
    const payload = await response.json()
    expect(payload.ok).toBe(true)
    expect(payload.value.supported).toBe(true)
    expect(payload.value.platform).toBe('darwin')
    expect(payload.value.sender).toEqual(SENDER)
    expect(payload.value.state).toBe('granted')
  })

  it('hides the panel on other platforms without running a command', async () => {
    const { scope, routes } = fakeScope()
    const { execFile, calls } = fakeExec()
    registerNotifyPermissionEndpoints(scope, { platform: 'linux', execFile })
    const payload = await (await routes.get('/api/orrery-notify/permissions/status').fetch(post({}))).json()
    expect(payload).toEqual({ ok: true, value: { supported: false, platform: 'linux' } })
    const action = await routes.get('/api/orrery-notify/permissions/action').fetch(post({ action: 'test' }))
    expect(action.status).toBe(400)
    expect((await action.json()).error.code).toBe('orrery-notify/unsupported')
    expect(calls).toHaveLength(0)
  })

  it('runs only whitelisted actions', async () => {
    const { scope, routes } = fakeScope()
    const { execFile, calls } = fakeExec()
    registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile })
    const action = routes.get('/api/orrery-notify/permissions/action')
    const ok = await action.fetch(post({ action: 'open-settings' }))
    expect((await ok.json())).toEqual({ ok: true, value: { action: 'open-settings' } })
    expect(calls).toHaveLength(1)
    for (const body of [{ action: 'sudo' }, { action: 5 }, {}, null]) {
      const rejected = await action.fetch(post(body))
      expect(rejected.status).toBe(400)
      expect((await rejected.json()).error.code).toBe('orrery-notify/invalid')
    }
    expect(calls).toHaveLength(1)
  })

  it('returns a structured error when the command fails', async () => {
    const { scope, routes } = fakeScope()
    const { execFile } = fakeExec(() => ({ error: new Error('open failed') }))
    registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile })
    const response = await routes.get('/api/orrery-notify/permissions/action').fetch(post({ action: 'open-settings' }))
    expect(response.status).toBe(500)
    expect((await response.json()).error).toEqual({ code: 'orrery-notify/failed', message: 'open failed' })
  })

  it('registers the page endpoints only when a channel exists', () => {
    const without = fakeScope()
    registerNotifyPermissionEndpoints(without.scope, { platform: 'darwin', execFile: fakeExec().execFile })
    expect(without.routes.has('/api/orrery-notify/web/pull')).toBe(false)
    const withChannel = fakeScope()
    registerNotifyPermissionEndpoints(withChannel.scope, { platform: 'darwin', execFile: fakeExec().execFile, channel: { pull: async () => null, ack: () => true } })
    expect(withChannel.routes.has('/api/orrery-notify/web/pull')).toBe(true)
    expect(withChannel.routes.has('/api/orrery-notify/web/ack')).toBe(true)
    for (const path of ['/api/orrery-notify/web/pull', '/api/orrery-notify/web/ack']) expect(withChannel.routes.get(path).methods).toEqual(['POST'])
  })

  it('the page endpoints work on every platform, not only macOS', async () => {
    const { scope, routes } = fakeScope()
    registerNotifyPermissionEndpoints(scope, { platform: 'linux', execFile: fakeExec().execFile, channel: { pull: async () => ({ id: '1', note: { title: 't' } }), ack: () => true } })
    const pulled = await (await routes.get('/api/orrery-notify/web/pull').fetch(post({}))).json()
    expect(pulled).toEqual({ ok: true, value: { id: '1', note: { title: 't' } } })
  })

  it('pull passes the request signal so a vanished page frees its parked poll', async () => {
    const { scope, routes } = fakeScope()
    const seen = []
    registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile: fakeExec().execFile, channel: { pull: async (hold, signal) => { seen.push({ hold, signal }); return null }, ack: () => true } })
    const signal = new AbortController().signal
    await routes.get('/api/orrery-notify/web/pull').fetch({ json: async () => ({}), signal })
    expect(seen).toHaveLength(1)
    expect(seen[0].hold).toBeUndefined()
    expect(seen[0].signal).toBe(signal)
  })

  it('ack forwards the result, reports whether it matched, and rejects a malformed body', async () => {
    const { scope, routes } = fakeScope()
    const acks = []
    registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile: fakeExec().execFile, channel: { pull: async () => null, ack: (id, result) => { acks.push({ id, result }); return id === '1' } } })
    const ack = routes.get('/api/orrery-notify/web/ack')
    expect(await (await ack.fetch(post({ id: '1', result: 'shown' }))).json()).toEqual({ ok: true, value: { matched: true } })
    expect(await (await ack.fetch(post({ id: '9', result: 'shown' }))).json()).toEqual({ ok: true, value: { matched: false } })
    expect(acks).toHaveLength(2)
    for (const body of [{}, { id: 1, result: 'shown' }, { id: '1' }, null]) {
      const rejected = await ack.fetch(post(body))
      expect(rejected.status).toBe(400)
    }
    expect(acks).toHaveLength(2)
  })

  it('a failing pull returns a structured error instead of throwing', async () => {
    const { scope, routes } = fakeScope()
    registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile: fakeExec().execFile, channel: { pull: async () => { throw new Error('boom') }, ack: () => true } })
    const response = await routes.get('/api/orrery-notify/web/pull').fetch(post({}))
    expect(response.status).toBe(500)
    expect((await response.json()).error.message).toBe('boom')
  })

  it('the test action goes through sendTest', async () => {
    const { scope, routes } = fakeScope()
    const sent = []
    registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile: fakeExec().execFile, sendTest: () => sent.push(1) })
    const response = await routes.get('/api/orrery-notify/permissions/action').fetch(post({ action: 'test' }))
    expect(await response.json()).toEqual({ ok: true, value: { action: 'test' } })
    expect(sent).toEqual([1])
  })
  it('has an idempotent disposer and tolerates a missing connection', () => {
    const { scope, disposed } = fakeScope()
    const dispose = registerNotifyPermissionEndpoints(scope, { platform: 'darwin', execFile: fakeExec().execFile })
    dispose()
    dispose()
    expect(disposed).toHaveLength(2)
    const warnings = []
    const off = registerNotifyPermissionEndpoints({ logger: { warn: (message) => warnings.push(message) } })
    off()
    expect(warnings).toHaveLength(1)
  })

  it('wires through ctx.inject and disposes with the row', () => {
    const { scope, disposed } = fakeScope()
    let injected
    const ctx = { inject: (services, callback) => { injected = { services, callback } } }
    const off = wireNotifyPermissions(ctx, { platform: 'darwin', execFile: fakeExec().execFile })
    expect(injected.services).toEqual(['connection'])
    injected.callback(scope)
    off()
    expect(disposed).toHaveLength(2)
    // a composition without ctx.inject mounts harmlessly
    wireNotifyPermissions({}, {})()
  })
})
