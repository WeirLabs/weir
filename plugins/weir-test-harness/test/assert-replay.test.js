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
    home: meta.home,
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


  it('rehydrate audit and both phases belong to the same recorded session', () => {
    const { dir, run } = loadRun('rehydrate')
    const view = makeRunView(run, { ws: join(dir, 'ws'), check: () => {} })
    const audit = readFileSync(join(dir, 'ws', '.weir', 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const facts = audit.filter(row => row.session === run.sessionId)
    const spawned = facts.filter(row => row.type === 'weir/supervision/spawn').map(row => row.data.childId)
    assert.equal(spawned.length, 2)
    for (const childId of spawned) assert.ok(view.created.some(row => row.session === childId))
    const resumed = facts.find(row => row.type === 'weir/supervision/resume')
    assert.ok(spawned.includes(resumed?.data.childId))
    assert.ok(view.records2.some(row => row.kind === 'agent-created' && row.session === resumed.data.childId))
    assert.ok(view.records2.some(row => row.kind === 'agent-created' && row.session === run.sessionId))
  })

  it('worktree ledger and audit agree with the recorded open and check events', () => {
    const { dir, run } = loadRun('worktree')
    const view = makeRunView(run, { ws: join(dir, 'ws'), check: () => {} })
    const ledger = JSON.parse(readFileSync(join(dir, 'ws', '.weir', 'worktrees', 'lanes.json'), 'utf8'))
    const [lane] = ledger.lanes
    const opened = view.events.find(row => row.type === 'weir/worktree/open')
    assert.equal(lane.ownerSession, opened.session)
    assert.equal(lane.id, opened.data.lane)
    assert.deepEqual(lane.base, opened.data.base)
    const audit = readFileSync(join(dir, 'ws', '.weir', 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(audit.some(row => row.session === lane.ownerSession && row.type === opened.type && JSON.stringify(row.data) === JSON.stringify(opened.data)))
    assert.equal(lane.history.at(-1).to, 'no-commits')
  })

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: recorded checks replay to the original green conclusion`, () => {
      const { dir, run, home } = loadRun(scenario.id)
      const checks = []
      const view = makeRunView(run, { ws: join(dir, 'ws'), check: (label, ok, detail) => checks.push({ label, ok, detail }) })
      scenario.assert(view, { home })
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
