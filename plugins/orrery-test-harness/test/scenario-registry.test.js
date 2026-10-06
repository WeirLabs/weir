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

const EXPECTED_ORDER = ['deepwork', 'delegate', 'hashline', 'pressure', 'robash', 'semantic', 'grouped', 'escalate', 'background', 'terminate', 'rehydrate', 'lsp', 'targets', 'editlock', 'worktree', 'capstore']
EXPECTED_ORDER.push('editlock-stop-predispatch', 'editlock-stop-staged', 'editlock-stop-publication', 'editlock-stop-update')
EXPECTED_ORDER.push('jobs-aware-todo')
EXPECTED_ORDER.push('editlock-auto-resume', 'editlock-auto-resume-off')
EXPECTED_ORDER.push('skill-composition-off', 'skill-composition-leak', 'skill-composition-host', 'skill-composition-office', 'skill-composition-migration')
EXPECTED_ORDER.push('apply-transaction')
EXPECTED_ORDER.push('cold-session')
EXPECTED_ORDER.push('lifecycle-inheritance')
EXPECTED_ORDER.push('delegate-preflight')
EXPECTED_ORDER.push('mcp-gateway')
EXPECTED_ORDER.push('preset-defaults')
EXPECTED_ORDER.push('capability-presets-surface')
EXPECTED_ORDER.push('worktree-watch')
EXPECTED_ORDER.push('notify-worktree')
EXPECTED_ORDER.push('child-prompt')
EXPECTED_ORDER.push('editlock-stale-sweep', 'editlock-stale-sweep-off')
EXPECTED_ORDER.push('capability-remote')
EXPECTED_ORDER.push('continuable')

describe('scenario registry', () => {
  it('holds exactly the registered scenarios, in the historical order (append-only)', () => {
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
      .flatMap((file) => file === 'skill-composition.js' ? ['skill-composition-off', 'skill-composition-leak', 'skill-composition-host', 'skill-composition-office', 'skill-composition-migration'] : [file.slice(0, -3)])
      .sort()
    assert.deepEqual(files.sort(), SCENARIOS.map((s) => s.id).sort())
  })

  it('byId resolves every member and returns undefined for unknown ids', () => {
    for (const scenario of SCENARIOS) {
      assert.equal(byId(scenario.id), scenario)
    }
    assert.equal(byId('no-such-scenario'), undefined)
  })

  // Scenarios whose preconditions need driver-side work: rehydrate boots twice
  // with one session id; worktree initializes a git repository in the workspace.
  const RUN_OVERRIDE = ['rehydrate', 'worktree', 'editlock-stop-predispatch', 'editlock-stop-staged', 'editlock-stop-publication', 'editlock-stop-update', 'editlock-auto-resume', 'editlock-auto-resume-off', 'editlock-stale-sweep', 'editlock-stale-sweep-off', 'cold-session', 'lifecycle-inheritance', 'mcp-gateway', 'preset-defaults', 'capability-presets-surface', 'worktree-watch', 'notify-worktree', 'capability-remote']

  it('exactly the declared scenarios carry a run override', () => {
    for (const scenario of SCENARIOS) {
      if (RUN_OVERRIDE.includes(scenario.id)) assert.equal(typeof scenario.run, 'function', `${scenario.id} must override run`)
      else assert.equal(scenario.run, undefined, `${scenario.id} unexpectedly overrides run`)
    }
  })
})
