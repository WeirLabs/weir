import { describe, expect, it } from '../helpers.js'
import { loadClientChunk, throwingRequire } from './load-client-chunk.js'

describe('load-client-chunk helper', () => {
  it('captures the registration of an existing-format module and drives its factory', async () => {
    // lib/client.js is authored in the build-output ModuleLoader format; the
    // helper must capture its registration and run the factory. The entry
    // requires platform seeds at factory time, so the smoke stub returns
    // inert objects instead of the default throwing require.
    const requireStub = (name) => {
      if (name === 'react') return { Component: class {} }
      if (name === 'react/jsx-runtime' || name === '@deepseek-ai/dsh-client-ui-primitives' || name === 'orrery-model-picker') return {}
      return throwingRequire(name)
    }
    const { definition, exports } = await loadClientChunk('lib/client.js', requireStub)
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBeUndefined()
    expect(exports.NS).toBe('settings.orrery')
    expect(typeof exports.apply).toBe('function')
    expect(typeof exports.inject).not.toBeUndefined()
  })

  it('defaults to a require stub that throws on any call', async () => {
    expect(() => throwingRequire('react')).toThrow(/unexpected require react/)
  })
})
