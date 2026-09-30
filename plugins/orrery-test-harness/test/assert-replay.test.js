// Assert replay (design D5/D6, task 4.2): the recorded traces of one green
// integration run (test/fixtures/traces/<scenario>/) are replayed in-process
// through makeRunView + each scenario's assert. Every recorded check must be
// green — the same conclusion the original run produced, with no headless
// boot. A key-set conformance guard fails when a fixture's trace shape drifts
// from the current writer (re-record with `pnpm run record`).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRunView } from '../src/run-view.js'
import { SCENARIOS } from '../src/scenarios/index.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/traces', import.meta.url))
const GENERIC_KEYS = ['seq', 'scenario', 'purpose', 'tools', 'emitted', 'emittedNames', 'lastUser', 'lastTool']

function syntheticObs() {
  return { transcript: '', lastUser: '', lastTool: '', system: '', toolNames: [], toolDefs: [], messages: [] }
}

/** Load one scenario's recorded run as a makeRunView input. */
function loadRun(scenarioId) {
  const dir = join(FIXTURES, scenarioId)
  const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
  return {
    dir,
    run: {
      scenario: scenarioId,
      trace: join(dir, 'trace.jsonl'),
      trace2: existsSync(join(dir, 'trace2.jsonl')) ? join(dir, 'trace2.jsonl') : undefined,
      code: meta.code,
      stdout: meta.stdout,
      stderr: meta.stderr,
      sessionId: meta.sessionId ?? null,
    },
  }
}

describe('assert replay over recorded green-run traces', () => {
  it('fixtures exist for every registered scenario', () => {
    for (const scenario of SCENARIOS) {
      assert.ok(existsSync(join(FIXTURES, scenario.id, 'run.json')), `missing fixture for ${scenario.id} — re-record with \`pnpm run record\``)
      assert.ok(existsSync(join(FIXTURES, scenario.id, 'trace.jsonl')), `missing trace for ${scenario.id}`)
    }
  })

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: recorded checks replay to the original green conclusion`, () => {
      const { dir, run } = loadRun(scenario.id)
      const checks = []
      const view = makeRunView(run, { ws: join(dir, 'ws'), check: (label, ok, detail) => checks.push({ label, ok, detail }) })
      scenario.assert(view)
      assert.ok(checks.length > 0, `${scenario.id}: assert recorded no checks`)
      const failed = checks.filter((entry) => !entry.ok)
      assert.deepEqual(
        failed.map((entry) => entry.label),
        [],
        `${scenario.id}: replay disagrees with the original run — ${failed.map((entry) => `${entry.label}: ${entry.detail}`).join('; ')}`,
      )
    })

    it(`${scenario.id}: fixture trace key set matches the current writer`, () => {
      const { run } = loadRun(scenario.id)
      const view = makeRunView(run, { ws: join(FIXTURES, scenario.id, 'ws'), check: () => {} })
      assert.ok(view.requests.length > 0, `${scenario.id}: fixture has no request records`)
      const keys = new Set()
      for (const record of view.requests) for (const key of Object.keys(record)) keys.add(key)
      const expected = new Set([...GENERIC_KEYS, ...Object.keys(scenario.observe?.(syntheticObs()) ?? {})])
      assert.deepEqual([...keys].sort(), [...expected].sort(), `${scenario.id}: fixture shape drifted from the writer — re-record`)
    })
  }
})
