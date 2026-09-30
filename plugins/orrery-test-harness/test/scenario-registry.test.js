// Registry conformance (design D6): every member carries id/prompt/decide/
// assert of the right types; the id equals its module filename; the id set
// equals the historical 12-scenario list exactly (no scenario can be dropped
// silently); the order matches the former run.mjs SCENARIOS list.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, byId } from '../src/scenarios/index.js'

const EXPECTED_ORDER = ['deepwork', 'delegate', 'hashline', 'pressure', 'robash', 'semantic', 'grouped', 'escalate', 'background', 'terminate', 'rehydrate', 'lsp']

describe('scenario registry', () => {
  it('holds exactly the 12 historical scenarios, in the historical order', () => {
    assert.deepEqual(SCENARIOS.map((s) => s.id), EXPECTED_ORDER)
  })

  it('every member carries id/prompt/decide/assert of the right shape', () => {
    for (const scenario of SCENARIOS) {
      assert.equal(typeof scenario.id, 'string', `entry missing id`)
      assert.ok(scenario.id.length > 0, 'empty scenario id')
      assert.equal(typeof scenario.prompt, 'string', `${scenario.id}: missing prompt`)
      assert.ok(scenario.prompt.length > 0, `${scenario.id}: empty prompt`)
      assert.equal(typeof scenario.decide, 'function', `${scenario.id}: missing decide`)
      assert.equal(typeof scenario.assert, 'function', `${scenario.id}: missing assert`)
      if (scenario.observe !== undefined) assert.equal(typeof scenario.observe, 'function', `${scenario.id}: observe must be a function`)
      if (scenario.run !== undefined) assert.equal(typeof scenario.run, 'function', `${scenario.id}: run must be a function`)
    }
  })

  it('id === module filename for every scenario on disk', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(join(dir, '..', 'src', 'scenarios'))
      .filter((file) => file.endsWith('.js') && file !== 'index.js')
      .map((file) => file.slice(0, -3))
      .sort()
    assert.deepEqual(files.sort(), SCENARIOS.map((s) => s.id).sort())
  })

  it('byId resolves every member and returns undefined for unknown ids', () => {
    for (const scenario of SCENARIOS) {
      assert.equal(byId(scenario.id), scenario)
    }
    assert.equal(byId('no-such-scenario'), undefined)
  })

  it('rehydrate carries the two-phase run override; no other scenario does', () => {
    assert.equal(typeof byId('rehydrate').run, 'function')
    for (const scenario of SCENARIOS) {
      if (scenario.id !== 'rehydrate') assert.equal(scenario.run, undefined, `${scenario.id} unexpectedly overrides run`)
    }
  })
})
