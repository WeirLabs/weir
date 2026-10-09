import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import scenario from '../src/scenarios/zombie-lane.js'
import { makeRunView } from '../src/run-view.js'

const fixture = fileURLToPath(new URL('./fixtures/traces/zombie-lane/', import.meta.url))
function failing(mutate = () => {}) {
  const meta = JSON.parse(readFileSync(join(fixture, 'run.json'), 'utf8'))
  const checks = []
  const view = makeRunView({ ...meta, trace: join(fixture, 'trace.jsonl'), trace2: join(fixture, 'trace2.jsonl') }, {
    ws: join(fixture, 'ws'), check: (label, ok) => checks.push({ label, ok }),
  })
  mutate(view)
  scenario.assert(view)
  return checks.filter(check => !check.ok).map(check => check.label)
}
function blocks(messages) {
  return [...scenario.decide({ messages })].filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
}
const message = (role, text) => ({ role, content: [{ type: 'text', text }] })

describe('zombie lane cold-recovery safety oracle', () => {
  it('accepts the installed-CLI record including explicit cold-lane reconciliation', () => {
    assert.deepEqual(failing(), [])
  })

  it('rejects early freeing even though the final ledger shows a successful abandon', () => {
    for (const mutate of [
      lane => { lane.boundChild = null },
      lane => { lane.state = 'no-commits' },
      lane => { lane.history.push({ event: 'checked' }) },
    ]) {
      assert.ok(failing(view => mutate(view.records2.find(row => row.kind === 'zombie-phase2-snapshot').lane))
        .includes('phase 2 cold recovery kept the lane working and bound'))
    }
  })

  it('requires a phase-2 snapshot and a recovery fact from that boot', () => {
    for (const remove of [
      row => row.kind === 'zombie-phase2-snapshot',
      row => row.type === 'weir/supervision/settle',
    ]) {
      assert.ok(failing(view => { view.records2 = view.records2.filter(row => !remove(row)) }).length > 0)
    }
  })

  it('rejects waiting tools, repeated status reads, and missing explicit abandon', () => {
    assert.ok(failing(view => { view.requests2.push({ emittedNames: ['bash'] }) }).some(label => label.includes('without waiting')))
    assert.ok(failing(view => { view.requests2.push({ emittedNames: ['supervised_status'] }) }).some(label => label.includes('without waiting')))
    assert.ok(failing(view => { view.records2.find(row => row.kind === 'zombie-cold-abandon').requests = [] }).some(label => label.includes('explicitly abandoned')))
  })

  it('queries the adopted registry once, then reports retention without waiting', () => {
    const messages = [message('user', 'zombie-rehydrate-probe'), message('tool', 'old phase-1 result')]
    const first = blocks(messages)
    assert.equal(first[0].name, 'supervised_status')
    messages.push(message('tool', 'Supervised registry of this session'))
    assert.deepEqual(blocks(messages), [{ type: 'text', text: 'phase2 cold lane remains bound pending explicit reconciliation' }])
  })
})
