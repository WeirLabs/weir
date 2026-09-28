import { describe, expect, it } from './helpers.js'
import { apply as applySettings, Config } from '../src/settings/index.js'
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
      intentGate: { classifier: 'llm', classifierTimeoutMs: 900, jevEndpoint: 'https://jev.example' },
      delegate: { categoryChains: '{"quick":[{"provider":"p","model":"m"}]}', supervisionMaxRetries: 3 },
      todoDriver: { maxConsecutive: 4 },
      contextGuard: { softThreshold: 0.6 },
      hashlineEdit: { hideStockEdit: false },
      robash: { enabled: false },
    })
    expect(result.issues).toBe(undefined)
  })

  it('rejects bad enum and bad types', () => {
    expect(validate({ intentGate: { classifier: 'bogus' } }).issues).not.toBe(undefined)
    expect(validate({ todoDriver: { maxConsecutive: 'eight' } }).issues).not.toBe(undefined)
    expect(validate({ hashlineEdit: { hideStockEdit: 'yes' } }).issues).not.toBe(undefined)
  })
})

describe('settings plugin apply', () => {
  function harness(config, settingsForms) {
    const provided = []
    const configured = []
    const ctx = {
      reflect: {
        provide: (name, impl) => provided.push({ name, impl }),
      },
      get: (key) => (key === 'settings' ? settingsForms : undefined),
    }
    applySettings(ctx, config)
    return { provided, configured, service: provided[0]?.impl }
  }

  it('provides the orrerySettings service returning user-set sections', () => {
    const { provided, service } = harness({ todoDriver: { maxConsecutive: 3 } })
    expect(provided[0].name).toBe('orrerySettings')
    expect(service.get('todoDriver')).toEqual({ maxConsecutive: 3 })
    expect(service.get('intentGate')).toBe(undefined)
  })

  it('parses categoryChains JSON into a validated object map', () => {
    const { service } = harness({
      delegate: { categoryChains: '{"quick":[{"provider":"p","model":"m","reasoningEffort":"low"}]}' },
    })
    expect(service.get('delegate').categoryChains).toEqual({ quick: [{ provider: 'p', model: 'm', reasoningEffort: 'low' }] })
  })

  it('fails activation loud on malformed categoryChains', () => {
    expect(() => harness({ delegate: { categoryChains: 'not-json' } })).toThrow()
    expect(() => harness({ delegate: { categoryChains: '[1,2]' } })).toThrow(/object map/)
    expect(() => harness({ delegate: { categoryChains: '{"quick":"nope"}' } })).toThrow(/array of rungs/)
    expect(() => harness({ delegate: { categoryChains: '{"quick":[{"provider":"p"}]}' } })).toThrow(/provider, model/)
  })

  it('unwraps volatile refs and drops unset fields (DSH-fork semantics)', () => {
    // the real fork materializes volatile fields as {get()} refs: validate a
    // config through the schema, then feed the RESULT through apply.
    const validated = Config['~standard'].validate({
      intentGate: { classifier: 'llm' },
      todoDriver: { maxConsecutive: 3 },
    })
    expect(validated.issues).toBe(undefined)
    const { service } = harness(validated.value)
    expect(service.get('intentGate')).toEqual({ classifier: 'llm' })
    expect(service.get('todoDriver')).toEqual({ maxConsecutive: 3 })
    expect(service.get('contextGuard')).toBe(undefined)
  })

  it('registers the auto-page policy when the forms service exists', () => {
    const calls = []
    harness({}, { configure: (policy) => calls.push(policy) })
    expect(calls).toEqual([{ auto: true }])
  })

  it('stays silent without the forms service', () => {
    harness({}, undefined) // must not throw
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
