import { describe, expect, it } from './helpers.js'
import { apply as applySettings, Config } from '../src/settings/index.js'
import { computeSections } from '../src/settings/sections.js'
import { createWhitelistDefaultsCache } from '../src/shared/whitelist-defaults.js'
import { DEFAULT_WHITELIST_PATH, WHITELIST_KEYS } from '../src/shared/whitelist-defaults.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyIntentGate } from '../src/intent-gate/index.js'
import { apply as applyTodoDriver } from '../src/todo-driver/index.js'
import { apply as applyHashline } from '../src/hashline-edit/index.js'

describe('settings Config schema', () => {
  const validate = (value) => Config['~standard'].validate(value)

  it('accepts an empty config (all fields optional)', () => {
    const result = validate({})
    expect(result.issues).toBe(undefined)
    // The fork materializes unset volatile fields as {} wrappers; the
    // service strips them so absent sections read undefined (covered by the
    // apply-level tests below).
    expect(typeof result.value).toBe('object')
  })

  it('accepts a fully-populated config', () => {
    const result = validate({
      intentGateClassifier: 'llm',
      intentGateTimeoutMs: 900,
      jevEndpoint: 'https://jev.example',
      delegateCategoryChains: '{"quick":[{"provider":"p","model":"m"}]}',
      supervisionMaxRetries: 3,
      todoMaxConsecutive: 4,
      guardSoftThreshold: 0.6,
      hashlineHideStockEdit: false,
      robashEnabled: false,
      robashAllow: '["ls","cat"]',
      robashGitAllow: '["status"]',
      robashDeny: '["rm"]',
      robashPwshAllow: '["Get-Content"]',
      robashPwshDeny: '["iex"]',
    })
    expect(result.issues).toBe(undefined)
  })

  it('rejects bad enum and bad types', () => {
    expect(validate({ intentGateClassifier: 'bogus' }).issues).not.toBe(undefined)
    expect(validate({ todoMaxConsecutive: 'eight' }).issues).not.toBe(undefined)
    expect(validate({ hashlineHideStockEdit: 'yes' }).issues).not.toBe(undefined)
  })

  it('validates lspServers JSON structure (fail loud)', () => {
    expect(computeSections({ lspServers: '{"zig":{"command":"zls"}}' }).lsp.servers).toEqual({ zig: { command: 'zls' } })
    expect(() => computeSections({ lspServers: 'not-json' })).toThrow()
    expect(() => computeSections({ lspServers: '[1]' })).toThrow(/object map/)
    expect(() => computeSections({ lspServers: '{"zig":{}}' })).toThrow(/command/)
    expect(() => computeSections({ lspServers: '{"zig":{"command":"zls","args":"--stdio"}}' })).toThrow(/args/)
  })

  it('validates robash list JSON (fail loud, key named)', () => {
    expect(computeSections({ robashAllow: '["ls","cat"]' }).robash.allow).toEqual(['ls', 'cat'])
    expect(computeSections({ robashDeny: '[]' }).robash?.deny).toBe(undefined)
    expect(() => computeSections({ robashAllow: 'not-json' })).toThrow(/robashAllow/)
    expect(() => computeSections({ robashGitAllow: '{"a":1}' })).toThrow(/robashGitAllow/)
    expect(() => computeSections({ robashDeny: '[1,"rm"]' })).toThrow(/robashDeny/)
    expect(computeSections({ robashPwshAllow: '["Get-Content"]' }).robash.pwshAllow).toEqual(['Get-Content'])
    expect(() => computeSections({ robashPwshAllow: 'not-json' })).toThrow(/robashPwshAllow/)
    expect(() => computeSections({ robashPwshDeny: '[1]' })).toThrow(/robashPwshDeny/)
  })
})

describe('settings plugin apply', () => {
  function harness(config, settingsForms) {
    const provided = []
    const configured = []
    const handlers = {}
    const ctx = {
      reflect: {
        provide: (name, impl) => provided.push({ name, impl }),
      },
      get: (key) => (key === 'settings' ? settingsForms : undefined),
      on: (event, handler) => {
        handlers[event] = handler
      },
    }
    applySettings(ctx, config)
    return { provided, configured, handlers, service: provided[0]?.impl }
  }

  // Direct computeSections assertions (no fake ctx): the production wiring of
  // the defaults read, minus the plugin shell.
  function sections(config) {
    const whitelistDefaults = createWhitelistDefaultsCache({ logger: undefined })
    return computeSections(config, { readDefaults: (path) => whitelistDefaults.tables(path ?? DEFAULT_WHITELIST_PATH) })
  }


  it('provides the orrerySettings service returning user-set sections', () => {
    const { provided, service } = harness({ todoMaxConsecutive: 3 })
    expect(provided[0].name).toBe('orrerySettings')
    expect(service.get('todoDriver')).toEqual({ maxConsecutive: 3 })
    expect(service.get('intentGate')).toBe(undefined)
  })

  it('parses categoryChains JSON into a validated object map', () => {
    const delegate = sections({
      delegateCategoryChains: '{"quick":[{"provider":"p","model":"m","reasoningEffort":"low"}]}',
    }).delegate
    expect(delegate.categoryChains).toEqual({ quick: [{ provider: 'p', model: 'm', reasoningEffort: 'low' }] })
  })

  it('fails activation loud on malformed categoryChains', () => {
    expect(() => sections({ delegateCategoryChains: 'not-json' })).toThrow()
    expect(() => sections({ delegateCategoryChains: '[1,2]' })).toThrow(/object map/)
    expect(() => sections({ delegateCategoryChains: '{"quick":"nope"}' })).toThrow(/array of rungs/)
    expect(() => sections({ delegateCategoryChains: '{"quick":[{"provider":"p"}]}' })).toThrow(/provider, model/)
  })

  it('parses robash list JSON into arrays in the robash section', () => {
    const robash = sections({
      robashEnabled: true,
      robashAllow: '["ls","cat"]',
      robashGitAllow: '["status","log"]',
      robashDeny: '["rm"]',
      robashPwshAllow: '["Get-Content","Get-Date"]',
      robashPwshDeny: '["iex"]',
    }).robash
    // the user's keys are ADDITIONS, delivered as parsed arrays
    expect(robash.enabled).toBe(true)
    expect(robash.allow).toEqual(['ls', 'cat'])
    expect(robash.gitAllow).toEqual(['status', 'log'])
    expect(robash.deny).toEqual(['rm'])
    expect(robash.pwshAllow).toEqual(['Get-Content', 'Get-Date'])
    expect(robash.pwshDeny).toEqual(['iex'])
    // ...and the product defaults ride along from the plugin's own data file,
    // regardless of what the row config declares
    expect(Object.keys(robash.defaults).sort()).toEqual([...WHITELIST_KEYS].sort())
    expect(robash.defaults.robashAllow).toContain('sleep')
    for (const key of WHITELIST_KEYS) expect(robash.defaultsSource[key]).toBe('file')
  })

  it('treats a present empty array as a no-op addition, and drops absent or empty-string keys', () => {
    // Append semantics: '[]' adds nothing, so it is indistinguishable from
    // absent. It no longer means "clear this whitelist" — the product defaults
    // are always in effect and no configuration value can remove them.
    const robash = sections({ robashEnabled: true, robashAllow: '[]' }).robash
    expect(robash.enabled).toBe(true)
    expect(robash.allow).toBeUndefined()
    expect(robash.defaults.robashAllow).toContain('sleep')
    // an empty string reads as absent too
    expect(sections({ robashAllow: '  ' }).robash.allow).toBeUndefined()
    // the pwsh keys follow the same semantics
    expect(sections({ robashPwshAllow: '[]' }).robash.pwshAllow).toBeUndefined()
    expect(sections({ robashPwshDeny: '  ' }).robash.pwshDeny).toBeUndefined()
    // a config that declares no robash key at all still carries the defaults
    const none = sections({ intentGateProvider: 'mock' }).robash
    expect(none.allow).toBeUndefined()
    expect(none.defaults.robashDeny).toContain('rm')
  })

  it('fails activation loud on malformed robash lists (key named)', () => {
    expect(() => sections({ robashAllow: 'not-json' })).toThrow(/robashAllow/)
    expect(() => sections({ robashGitAllow: '{"a":1}' })).toThrow(/robashGitAllow/)
    expect(() => sections({ robashDeny: '[1]' })).toThrow(/robashDeny/)
    expect(() => sections({ robashPwshAllow: 'not-json' })).toThrow(/robashPwshAllow/)
    expect(() => sections({ robashPwshDeny: '{"a":1}' })).toThrow(/robashPwshDeny/)
  })

  it('re-parses live robash lists only when the raw string changes', () => {
    const config = { robashAllow: '["ls"]' }
    const first = sections(config).robash
    expect(first.allow).toEqual(['ls'])
    expect(sections(config).robash.allow).toBe(first.allow) // raw-cache hit: same instance
    config.robashAllow = '["ls","cat"]'
    expect(sections(config).robash.allow).toEqual(['ls', 'cat'])
    config.robashDeny = '["rm"]'
    const both = sections(config).robash
    expect(both.allow).toEqual(['ls', 'cat'])
    expect(both.deny).toEqual(['rm'])
    delete config.robashAllow
    delete config.robashDeny
    // no list left to add, but the product defaults are still published, so the
    // section survives — it is no longer "undefined means nothing configured"
    expect(sections(config).robash.defaults.robashAllow).toContain('sleep')
  })

  it('publishes the product defaults from the plugin data file, and a configured path takes over', () => {
    // The gap this pins: the defaults must NOT depend on any configuration layer,
    // because a patch row is replaced wholesale. A row that declares nothing at
    // all still gets the full shipped defaults.
    const clean = sections({ robashEnabled: true }).robash
    expect(clean.defaults.robashPwshAllow).toContain('Start-Sleep')
    expect(clean.defaults.robashAllow).toContain('sleep')
    expect(clean.defaults.robashDeny).toContain('rm')
    for (const key of WHITELIST_KEYS) expect(clean.defaultsSource[key]).toBe('file')

    // A path key TAKES OVER: the taken-over file is the complete source, and
    // entries it omits are not in effect. A table it omits falls back per table.
    const takenOver = join(mkdtempSync(join(tmpdir(), 'orrery-defaults-')), 'mine.json')
    writeFileSync(takenOver, JSON.stringify({ robashAllow: ['ls'], robashPwshAllow: ['Get-Content'] }))
    const custom = sections({ robashDefaultsPath: takenOver }).robash
    expect(custom.defaults.robashAllow).toEqual(['ls'])
    expect(custom.defaults.robashAllow).not.toContain('sleep')
    expect(custom.defaults.robashPwshAllow).toEqual(['Get-Content'])
    // omitted tables fall back to the built-in constants, not to the shipped file
    expect(custom.defaults.robashDeny).toContain('rm')
    expect(custom.defaultsSource.robashDeny).toBe('fallback')
    expect(custom.defaultsSource.robashAllow).toBe('file')
    // the configuration keys are not part of the guard's policy surface
    expect(custom.defaultsPath).toBeUndefined()
    expect(custom.defaultsReload).toBeUndefined()
  })

  it('re-reads the defaults file when the reload entry is bumped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-reload-'))
    const file = join(dir, 'defaults.json')
    const write = (allow) => writeFileSync(file, JSON.stringify({
      robashAllow: allow, robashGitAllow: ['status'], robashDeny: ['rm'],
      robashPwshAllow: ['Get-Content'], robashPwshDeny: ['iex'],
    }))
    write(['ls'])

    const config = { robashDefaultsPath: file, robashDefaultsReload: 1 }
    const { handlers, service } = harness(config)
    expect(service.get('robash').defaults.robashAllow).toEqual(['ls'])
    expect(service.get('robash').defaultsSource.robashAllow).toBe('file')

    // editing the file alone changes nothing: the read is explicit, not mtime-driven
    write(['ls', 'probe'])
    expect(service.get('robash').defaults.robashAllow).toEqual(['ls'])

    // an unrelated volatile commit changes nothing: the reload is marker-driven
    handlers['loader/volatile-update']([])
    expect(service.get('robash').defaults.robashAllow).toEqual(['ls'])

    // bumping the entry clears the cache, so the next read is the edited file
    config.robashDefaultsReload = 2
    handlers['loader/volatile-update']([])
    expect(service.get('robash').defaults.robashAllow).toEqual(['ls', 'probe'])
  })

  it('retires the drift report: it never warns about a shadowed whitelist baseline', () => {
    // The old warning existed because a profile row could freeze a baseline
    // snapshot. The defaults no longer ride the row, so there is nothing to
    // shadow and nothing to warn about — a narrowed user list is simply a list
    // of additions, and the defaults are still published beside it.
    const warnings = []
    const ctx = {
      reflect: { provide: () => {} },
      get: () => undefined,
      on: () => {},
      logger: { warn: (line) => warnings.push(line) },
    }
    applySettings(ctx, { robashPwshAllow: JSON.stringify(['Get-Content']) })
    expect(warnings).toEqual([])
  })

  it('stays silent when the composition declares no whitelist at all', () => {
    const warnings = []
    const ctx = {
      reflect: { provide: () => {} },
      get: () => undefined,
      on: () => {},
      logger: { warn: (line) => warnings.push(line) },
    }
    applySettings(ctx, { intentGateProvider: 'mock', intentGateModel: 'mock-1' })
    expect(warnings).toEqual([])
  })

  it('recomputes robash sections after a volatile commit notification', () => {
    const config = { robashAllow: '["ls"]' }
    const { handlers, service } = harness(config)
    const calls = []
    service.onChange(() => calls.push(1))
    expect(service.get('robash').allow).toEqual(['ls'])
    config.robashAllow = '[]'
    handlers['loader/volatile-update']([['robashAllow']])
    expect(calls).toHaveLength(1)
    // '[]' adds nothing, so the addition is gone; the defaults remain in effect
    expect(service.get('robash').allow).toBeUndefined()
    expect(service.get('robash').defaults.robashAllow).toContain('sleep')
  })

  it('unwraps volatile refs and drops unset fields (DSH-fork semantics)', () => {
    // the real fork materializes volatile fields as {get()} refs: validate a
    // config through the schema, then feed the RESULT through computeSections.
    const validated = Config['~standard'].validate({
      intentGateClassifier: 'llm',
      todoMaxConsecutive: 3,
    })
    expect(validated.issues).toBe(undefined)
    const computed = sections(validated.value)
    expect(computed.intentGate).toEqual({ classifier: 'llm' })
    expect(computed.todoDriver).toEqual({ maxConsecutive: 3 })
    expect(computed.contextGuard).toBe(undefined)
  })

  it('registers the auto-page policy when the forms service exists', () => {
    const calls = []
    harness({}, { configure: (policy) => calls.push(policy) })
    expect(calls).toEqual([{ auto: true }])
  })

  it('stays silent without the forms service', () => {
    harness({}, undefined) // must not throw
  })

  it('recomputes sections live from the mutated config reference (volatile commit)', () => {
    const config = { todoMaxConsecutive: 3 }
    expect(sections(config).todoDriver).toEqual({ maxConsecutive: 3 })
    config.todoMaxConsecutive = 9
    config.lspEnabled = true
    config.lspIdleMs = 123_000
    config.lspRequestTimeoutMs = 8_000
    config.lspDiagnosticsWaitMs = 500
    config.lspServers = '{"zig":{"command":"zls","args":["--stdio"]}}'
    expect(sections(config).todoDriver).toEqual({ maxConsecutive: 9 })
    expect(sections(config).lsp).toEqual({ enabled: true, idleMs: 123_000, requestTimeoutMs: 8_000, diagnosticsWaitMs: 500, servers: { zig: { command: 'zls', args: ['--stdio'] } } })
    delete config.lspEnabled
    delete config.lspIdleMs
    delete config.lspRequestTimeoutMs
    delete config.lspDiagnosticsWaitMs
    delete config.lspServers
    expect(sections(config).lsp).toBe(undefined)
  })

  it('re-parses live categoryChains only when the raw string changes', () => {
    const config = { delegateCategoryChains: '{"quick":[{"provider":"p","model":"m"}]}' }
    const first = sections(config).delegate
    const second = sections(config).delegate
    expect(second.categoryChains).toEqual(first.categoryChains)
    config.delegateCategoryChains = '{"deep":[{"provider":"q","model":"n"}]}'
    expect(sections(config).delegate.categoryChains).toEqual({ deep: [{ provider: 'q', model: 'n' }] })
  })

  it('onChange subscribers fire on loader/volatile-update', () => {
    const { handlers, service } = harness({})
    const calls = []
    const unsubscribe = service.onChange(() => calls.push(1))
    handlers['loader/volatile-update']([['lspEnabled']])
    expect(calls).toHaveLength(1)
    unsubscribe()
    handlers['loader/volatile-update']([['lspEnabled']])
    expect(calls).toHaveLength(1)
  })
})

describe('settings overlays in modules', () => {
  it('intent-gate maps flat jev keys into the nested jev config', () => {
    const handlers = {}
    const ctx = {
      on: (event, handler) => {
        handlers[event] = handler
      },
      get: (key) =>
        key === 'orrerySettings'
          ? { get: (section) => (section === 'intentGate' ? { classifier: 'llm', classifierProvider: 'mock', classifierModel: 'mock-1', jevEndpoint: 'https://jev.example', jevApiKeyEnv: 'JEV_KEY' } : undefined) }
          : undefined,
      emit: () => {},
      llm: { stream: async function* () {} },
    }
    applyIntentGate(ctx, {})
    // classifier built in llm mode: a keyword-free prompt triggers a sidecar call
    // (the sidecar route proof lives in the integration 'semantic' scenario)
    expect(typeof handlers['agent/pre-step']).toBe('function')
  })

  it('todo-driver lets the settings overlay win over row config', () => {
    const handlers = {}
    const ctx = {
      tools: { register: () => {} },
      agents: { get: () => undefined },
      get: (key) => (key === 'orrerySettings' ? { get: (section) => (section === 'todoDriver' ? { maxConsecutive: 1 } : undefined) } : undefined),
      on: (event, handler) => {
        handlers[event] = handler
      },
      emit: () => {},
      logger: { warn: () => {} },
    }
    applyTodoDriver(ctx, { maxConsecutive: 8 })
    // fire three completed turns with remaining todos: only one continuation allowed
    const steers = []
    const session = { id: 's1', snapshotEvents: () => [{ type: 'todo/write', data: { todos: [{ content: 'x', status: 'pending' }] } }] }
    const agent = { id: 's1', steer: (message) => steers.push(message), session }
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    handlers['agent/turn-stopping']({ agent, turn: 1, signal: new AbortController().signal })
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    handlers['agent/turn-stopping']({ agent, turn: 2, signal: new AbortController().signal })
    handlers['session/event'](session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    handlers['agent/turn-stopping']({ agent, turn: 3, signal: new AbortController().signal })
    expect(steers).toHaveLength(1)
  })

  it('hashline-edit lets the settings overlay re-enable stock edit over the row default', () => {
    const restricted = []
    const ctx = {
      tools: { register: () => {}, restrict: (filter) => restricted.push(filter) },
      fs: {},
      on: () => {},
      get: (key) => (key === 'orrerySettings' ? { get: (section) => (section === 'hashlineEdit' ? { hideStockEdit: false } : undefined) } : undefined),
    }
    applyHashline(ctx, { hideStockEdit: true })
    expect(restricted).toHaveLength(0)
  })

  it('hashline-edit without the service keeps the row config behavior', () => {
    const listeners = {}
    const restrictedBy = []
    const ctx = {
      tools: {
        register: () => {},
        get: (toolName, scope) => (toolName === 'edit' && scope ? { name: 'edit' } : undefined),
        restrict: () => {},
      },
      fs: {},
      on: (event, listener) => {
        listeners[event] = listener
      },
      get: () => undefined,
    }
    applyHashline(ctx, { hideStockEdit: true })
    expect(typeof listeners['agent/created']).toBe('function')
    listeners['agent/created']({ agent: { ctx: { tools: { restrict: (filter) => restrictedBy.push(filter) } } } })
    expect(restrictedBy).toEqual([{ deny: ['edit'] }])
  })
})
