import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * Zero-dependency view-model chunk test: the factory is driven with the
 * default throwing require (zero stubs) — any require call would fail the
 * load. Assertions migrated verbatim from the pre-split client.test.js.
 */

describe('client.chain-model chunk', () => {
  it('registers as a package-local chunk and round-trips chains through JSON', async () => {
    const { definition, exports } = await loadClientChunk('lib/client.chain-model.js')
    expect(definition.id).toBe('weir-harness')
    expect(definition.chunk).toBe('client.chain-model.js')

    // pure chain helpers: JSON synthesis round-trips through the visual model
    const { jsonToChains, chainsToJson } = exports
    const chains = jsonToChains('{"deep":[{"provider":"p","model":"m","reasoningEffort":"max"}],"bogus":[{"provider":"x","model":"y"}]}')
    expect(chains.deep).toEqual([{ provider: 'p', model: 'm', reasoningEffort: 'max' }])
    expect(chains.quick).toEqual([])
    expect(JSON.parse(chainsToJson({ deep: [{ provider: 'p', model: 'm', reasoningEffort: '' }, { provider: '', model: 'm2', reasoningEffort: '' }], quick: [] }))).toEqual({ deep: [{ provider: 'p', model: 'm' }] })
    expect(jsonToChains('not-json').deep).toEqual([])
    expect(chainsToJson(jsonToChains(undefined))).toBe('{}')
  })
})
