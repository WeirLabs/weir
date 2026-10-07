import { describe, expect, it } from './helpers.js'
import { registerEnvEndpoints, wireEnvAdmin } from '../src/settings/env-admin.js'

/** A fake injected scope whose connection records fetch registrations. */
function fakeScope() {
  const registrations = []
  const warnings = []
  const scope = {
    connection: {
      fetch: {
        register: (definition) => {
          registrations.push(definition)
          return () => registrations.splice(registrations.indexOf(definition), 1)
        },
      },
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { scope, registrations, warnings }
}

describe('settings env endpoint', () => {
  it('answers { ok: true, value: { platform } } from the injected platform', async () => {
    const { scope, registrations } = fakeScope()
    const dispose = registerEnvEndpoints(scope, { platform: 'darwin' })
    expect(registrations).toHaveLength(1)
    const endpoint = registrations[0]
    expect(endpoint.path).toBe('/api/weir-settings/env')
    expect(endpoint.methods).toEqual(['POST'])

    const response = await endpoint.fetch()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: { platform: 'darwin' } })

    // the win32 answer is the same shape with the other platform value
    const second = fakeScope()
    registerEnvEndpoints(second.scope, { platform: 'win32' })
    expect(await (await second.registrations[0].fetch()).json()).toEqual({ ok: true, value: { platform: 'win32' } })

    // disposing unregisters and is idempotent
    dispose()
    dispose()
    expect(registrations).toHaveLength(0)
  })

  it('registers nothing (and warns) when the connection service is absent', () => {
    const warnings = []
    const dispose = registerEnvEndpoints({ logger: { warn: (message) => warnings.push(message) } })
    expect(warnings).toHaveLength(1)
    expect(typeof dispose).toBe('function')
    dispose()
  })

  it('wireEnvAdmin registers through ctx.inject and disposes through the returned disposer', async () => {
    const { scope, registrations } = fakeScope()
    const injected = []
    const ctx = {
      inject: (names, fn) => {
        injected.push(names)
        fn(scope)
        return () => {}
      },
    }
    const off = wireEnvAdmin(ctx, { platform: 'linux' })
    expect(injected).toEqual([['connection']])
    expect(registrations).toHaveLength(1)
    expect(await (await registrations[0].fetch()).json()).toEqual({ ok: true, value: { platform: 'linux' } })
    off()
    off()
    expect(registrations).toHaveLength(0)
  })

  it('wireEnvAdmin is a no-op without ctx.inject (headless compositions)', () => {
    const off = wireEnvAdmin({}, { platform: 'darwin' })
    expect(typeof off).toBe('function')
    off()
  })
})
