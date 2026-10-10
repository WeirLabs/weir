import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import scenario from '../src/scenarios/preset-delegation-surface.js'
import { extract } from '../src/mock-kit.js'

const fixture = new URL('./fixtures/traces/preset-delegation-surface/', import.meta.url)
const readTrace = file => readFileSync(new URL(file, fixture), 'utf8').trim().split('\n').map(JSON.parse)
function recordedRun() {
  return { code: 0, stderr: '', records: readTrace('trace.jsonl'), records2: readTrace('trace2.jsonl') }
}
function failures(run) {
  const failed = []
  scenario.assert({ ...run, check: (label, ok) => { if (!ok) failed.push(label) } })
  return failed
}

describe('real-preset delegation surface oracle', () => {
  it('accepts the recorded real runtime result', () => {
    assert.deepEqual(failures(recordedRun()), [])
  })
  for (const [preset, key] of [['weir', 'records'], ['weir-creative', 'records2']]) {
    for (const name of ['delegate', 'send_message', 'interrupt_agent', 'list_agents', 'resume_agent', 'terminate_agent', 'supervised_status']) {
      it(`${preset}: rejects missing ${name} even when other checks pass`, () => {
        const run = recordedRun()
        for (const row of run[key]) if (row.sawContinuableProbe && row.tools) row.tools = row.tools.filter(tool => tool !== name)
        assert.ok(failures(run).includes(`${preset}: exposes ${name}`))
      })
    }
    for (const name of ['subagent', 'subagent_fork', 'list_subagent_models', 'workflow']) {
      it(`${preset}: rejects leaked ${name}`, () => {
        const run = recordedRun()
        run[key].find(row => row.purpose === 'main' && row.sawContinuableProbe).tools.push(name)
        assert.ok(failures(run).includes(`${preset}: excludes ${name}`))
      })
    }
    it(`${preset}: rejects a rescuing host control tool`, () => {
      const run = recordedRun()
      run[key].find(row => row.kind === 'production-preset-selected').hostTools.push('send_message')
      assert.ok(failures(run).includes(`${preset}: bare host cannot rescue delegation tools`))
    })
    it(`${preset}: rejects absent second child turn and settlement`, () => {
      const run = recordedRun()
      run[key] = run[key].filter(row => !row.childFollowupSeen && !row.secondResultInParentContext)
      assert.ok(failures(run).includes(`${preset}: child follow-up retained original context`))
      assert.ok(failures(run).includes(`${preset}: both results returned to parent`))
    })
    it(`${preset}: rejects follow-up or settlement from a different child`, () => {
      const run = recordedRun()
      run[key].find(row => row.type === 'user/message' && row.source === 'agent-message').session = 'wrong-child'
      assert.ok(failures(run).includes(`${preset}: follow-up delivered to the same child session`))
      const settlement = run[key].find(row => row.source === 'subagent-settled' && row.text.includes('CONTINUABLE_SECOND_RESULT'))
      settlement.text = 'Background subagent wrong-child finished\nCONTINUABLE_SECOND_RESULT'
      assert.ok(failures(run).includes(`${preset}: both built-in settlements identify that child`))
    })
    it(`${preset}: fails closed without model requests`, () => {
      const run = recordedRun()
      run[key] = run[key].filter(row => !row.emitted)
      assert.ok(failures(run).includes(`${preset}: parent model request observed`))
    })
  }
  it('starts with one-shot delegate, then uses the continuable lane', () => {
    const options = text => ({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
    const first = options(scenario.prompt)
    const firstCall = [...scenario.decide(first, extract(first))].find(chunk => chunk.type === 'block-end').block
    assert.equal(firstCall.name, 'delegate')
    assert.equal(JSON.parse(firstCall.arguments).mode, undefined)
    const next = options(scenario.prompt + '\nSURFACE_ONESHOT_OK')
    const nextCall = [...scenario.decide(next, extract(next))].find(chunk => chunk.type === 'block-end').block
    assert.equal(nextCall.name, 'delegate')
    assert.equal(JSON.parse(nextCall.arguments).mode, 'continuable')
  })
})
