import { describe, expect, it } from './helpers.js'
import { injectOrWarn, isGenuineUserMessage, overlayConfig } from '../src/shared/runtime-messages.js'

// The single home of the injection-source exemption matrix: every runtime
// producer tag must be exempt in BOTH input forms (message object and
// user/message session event). Plugin-level tests keep only one behavior
// assertion each and do not repeat this matrix.
const INJECTED_SOURCES = ['orrery-todo-driver', 'orrery-context-guard', 'orrery-intent-gate', 'subagent-settled']

function userMessage(source) {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source }
}

function userMessageEvent(source) {
  return { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source } }
}

describe('isGenuineUserMessage', () => {
  it('accepts a genuine user message object', () => {
    expect(isGenuineUserMessage(userMessage({ kind: 'user' }))).toBe(true)
  })

  it('judges only source.kind — role filtering stays with callers', () => {
    expect(isGenuineUserMessage({ role: 'assistant', source: { kind: 'user' } })).toBe(true)
  })

  it('exempts every injected source in message form', () => {
    for (const kind of INJECTED_SOURCES) {
      expect(isGenuineUserMessage(userMessage({ kind }))).toBe(false)
    }
  })

  it('exempts messages without a source kind', () => {
    expect(isGenuineUserMessage(userMessage(undefined))).toBe(false)
    expect(isGenuineUserMessage(userMessage({}))).toBe(false)
    expect(isGenuineUserMessage({ id: 'x1', role: 'user', content: [] })).toBe(false)
  })

  it('accepts a genuine user/message session event', () => {
    expect(isGenuineUserMessage(userMessageEvent({ kind: 'user' }))).toBe(true)
  })

  it('exempts every injected source in event form', () => {
    for (const kind of INJECTED_SOURCES) {
      expect(isGenuineUserMessage(userMessageEvent({ kind }))).toBe(false)
    }
  })

  it('exempts user/message events without a source kind', () => {
    expect(isGenuineUserMessage(userMessageEvent(undefined))).toBe(false)
    expect(isGenuineUserMessage({ type: 'user/message' })).toBe(false)
    expect(isGenuineUserMessage({ type: 'user/message', data: {} })).toBe(false)
  })

  it('returns false for non-user/message events even with a user-looking source', () => {
    expect(isGenuineUserMessage({ type: 'turn/end', data: { source: { kind: 'user' } } })).toBe(false)
    expect(isGenuineUserMessage({ type: 'step/end', data: {} })).toBe(false)
    expect(isGenuineUserMessage({ type: 'todo/write', data: { source: { kind: 'user' } } })).toBe(false)
  })

  it('returns false for non-object input', () => {
    expect(isGenuineUserMessage(undefined)).toBe(false)
    expect(isGenuineUserMessage(null)).toBe(false)
    expect(isGenuineUserMessage('user')).toBe(false)
  })
})

describe('overlayConfig', () => {
  function ctxWithSettings(sections) {
    return {
      get: (name) => (name === 'orrerySettings' ? { get: (section) => sections[section] } : undefined),
    }
  }

  it('lets the settings section win over the inline config', () => {
    const ctx = ctxWithSettings({ todoDriver: { maxConsecutive: 9 } })
    const merged = overlayConfig(ctx, 'todoDriver', { maxConsecutive: 3, enabled: true })
    expect(merged.maxConsecutive).toBe(9)
    expect(merged.enabled).toBe(true)
  })

  it('is a no-op when the orrerySettings service is absent', () => {
    const config = { maxConsecutive: 3 }
    expect(overlayConfig({}, 'todoDriver', config)).toEqual({ maxConsecutive: 3 })
    const noService = { get: () => undefined }
    expect(overlayConfig(noService, 'todoDriver', config)).toEqual({ maxConsecutive: 3 })
  })

  it('is a no-op when the section is missing or not an object', () => {
    const config = { maxConsecutive: 3 }
    expect(overlayConfig(ctxWithSettings({}), 'todoDriver', config)).toEqual({ maxConsecutive: 3 })
    const weird = ctxWithSettings({ todoDriver: 'nope' })
    expect(overlayConfig(weird, 'todoDriver', config)).toEqual({ maxConsecutive: 3 })
  })

  it('sits defaults underneath the inline config and the section', () => {
    const defaults = { enabled: true, maxConsecutive: 8, baseDelayMs: 30_000 }
    const merged = overlayConfig(ctxWithSettings({ todoDriver: { maxConsecutive: 2 } }), 'todoDriver', { maxConsecutive: 5 }, { defaults })
    expect(merged).toEqual({ enabled: true, maxConsecutive: 2, baseDelayMs: 30_000 })
    const noSection = overlayConfig({}, 'todoDriver', { maxConsecutive: 5 }, { defaults })
    expect(noSection).toEqual({ enabled: true, maxConsecutive: 5, baseDelayMs: 30_000 })
  })

  it('flat-merges the whole section when no nestKeys are declared', () => {
    const ctx = ctxWithSettings({ contextGuard: { softThreshold: 0.5, hardThreshold: 0.6 } })
    const merged = overlayConfig(ctx, 'contextGuard', { softThreshold: 0.7 }, { defaults: { enabled: true } })
    expect(merged).toEqual({ enabled: true, softThreshold: 0.5, hardThreshold: 0.6 })
  })

  describe('nestKeys jev mapping', () => {
    const nestKeys = { jev: { endpoint: 'jevEndpoint', model: 'jevModel', apiKeyEnv: 'jevApiKeyEnv' } }

    it('maps a single flat key into the nested sub-object', () => {
      const ctx = ctxWithSettings({ intentGate: { jevEndpoint: 'http://jev' } })
      const merged = overlayConfig(ctx, 'intentGate', {}, { nestKeys })
      expect(merged.jev).toEqual({ endpoint: 'http://jev' })
      expect('jevEndpoint' in merged).toBe(false)
    })

    it('maps multiple keys at once', () => {
      const ctx = ctxWithSettings({
        intentGate: { jevEndpoint: 'http://jev', jevModel: 'jev-1', jevApiKeyEnv: 'JEV_KEY' },
      })
      const merged = overlayConfig(ctx, 'intentGate', {}, { nestKeys })
      expect(merged.jev).toEqual({ endpoint: 'http://jev', model: 'jev-1', apiKeyEnv: 'JEV_KEY' })
    })

    it('merges into an existing config.jev, preserving its other keys', () => {
      const ctx = ctxWithSettings({ intentGate: { jevModel: 'jev-1' } })
      const merged = overlayConfig(ctx, 'intentGate', { jev: { endpoint: 'http://old', timeoutMs: 5000 } }, { nestKeys })
      expect(merged.jev).toEqual({ endpoint: 'http://old', timeoutMs: 5000, model: 'jev-1' })
    })

    it('overrides an existing config.jev key when the flat key is defined', () => {
      const ctx = ctxWithSettings({ intentGate: { jevEndpoint: 'http://new' } })
      const merged = overlayConfig(ctx, 'intentGate', { jev: { endpoint: 'http://old' } }, { nestKeys })
      expect(merged.jev).toEqual({ endpoint: 'http://new' })
    })

    it('creates no nested object when no declared key appears', () => {
      const ctx = ctxWithSettings({ intentGate: { classifier: 'llm' } })
      const merged = overlayConfig(ctx, 'intentGate', { intents: [] }, { nestKeys })
      expect('jev' in merged).toBe(false)
      expect(merged.classifier).toBe('llm')
      expect(merged.intents).toEqual([])
    })

    it('never overrides with undefined and still strips the key from the flat merge', () => {
      const ctx = ctxWithSettings({ intentGate: { jevEndpoint: undefined, jevModel: 'jev-1' } })
      const merged = overlayConfig(ctx, 'intentGate', { jev: { endpoint: 'http://old' } }, { nestKeys })
      expect(merged.jev).toEqual({ endpoint: 'http://old', model: 'jev-1' })
      expect('jevEndpoint' in merged).toBe(false)
    })

    it('keeps flat-merging non-declared section keys alongside the nested mapping', () => {
      const ctx = ctxWithSettings({ intentGate: { disabled: ['research'], jevApiKeyEnv: 'JEV_KEY' } })
      const merged = overlayConfig(ctx, 'intentGate', { disabled: [] }, { nestKeys })
      expect(merged.disabled).toEqual(['research'])
      expect(merged.jev).toEqual({ apiKeyEnv: 'JEV_KEY' })
      expect('jevApiKeyEnv' in merged).toBe(false)
    })
  })

  it('returns a fresh object and never mutates the inputs', () => {
    const config = { jev: { endpoint: 'http://old' }, intents: [] }
    const ctx = ctxWithSettings({ intentGate: { jevModel: 'jev-1' } })
    const merged = overlayConfig(ctx, 'intentGate', config, {
      nestKeys: { jev: { model: 'jevModel' } },
    })
    expect(merged).not.toBe(config)
    expect(config).toEqual({ jev: { endpoint: 'http://old' }, intents: [] })
    expect(config.jev).toEqual({ endpoint: 'http://old' })
  })
})

describe('injectOrWarn', () => {
  function ctxWithLogger() {
    const warnings = []
    return { warnings, ctx: { logger: { warn: (text) => warnings.push(text) } } }
  }

  it('swallows a throw and warns with the caller prefix plus the error summary', () => {
    const { ctx, warnings } = ctxWithLogger()
    const result = injectOrWarn(ctx, 'todo-driver: could not steer continuation for "s1"', () => {
      throw new Error('session closed')
    })
    expect(result).toBeUndefined()
    expect(warnings).toEqual(['todo-driver: could not steer continuation for "s1": session closed'])
  })

  it('appends the raw error when it carries no message', () => {
    const { ctx, warnings } = ctxWithLogger()
    injectOrWarn(ctx, 'context-guard: advisory injection failed for "s1"', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'boom'
    })
    expect(warnings).toEqual(['context-guard: advisory injection failed for "s1": boom'])
  })

  it('warns nothing and returns the result when the injection succeeds', () => {
    const { ctx, warnings } = ctxWithLogger()
    const result = injectOrWarn(ctx, 'unused', () => 'ok')
    expect(result).toBe('ok')
    expect(warnings).toHaveLength(0)
  })

  it('never crashes when the logger is missing', () => {
    // A throw here would fail the test directly.
    const result = injectOrWarn({}, 'prefix', () => { throw new Error('x') })
    expect(result).toBeUndefined()
  })
})
