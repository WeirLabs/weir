// In-process brain tests (design D6, task 4.1): construct request options and
// call each scenario's decide directly — no headless profile, no 240s boot.
// Each assertion pins a key point of the chunk sequence (first response tool
// choice, marker texts, provider-error path), not an exhaustive transcript.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extract, shellCall } from '../src/mock-kit.js'
import { shellToolName } from '../src/shell.js'
import { byId } from '../src/scenarios/index.js'

const SHELL = shellToolName()

function userOptions(text, extra = {}) {
  return { messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], ...extra }
}

/** Run a decide brain and return the materialized chunk list. */
function run(id, options) {
  return [...byId(id).decide(options, extract(options))]
}

/** The block-end payloads of a chunk list (what the model effectively said). */
function blockEnds(chunks) {
  return chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
}

describe('deepwork brain', () => {
  it('answers the probe with a todo_write call (one open todo)', () => {
    const chunks = run('deepwork', userOptions('深度工作：注册计划然后停住'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'tool-call')
    assert.equal(blocks[0].name, 'todo_write')
    const args = JSON.parse(blocks[0].arguments)
    assert.deepEqual(
      args.todos.map((todo) => todo.status),
      ['completed', 'pending'],
    )
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  })

  it('finishes after the continuation turn completes the todos', () => {
    const options = userOptions('深度工作 <todo_continuation> all done')
    const chunks = run('deepwork', options)
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].type, 'tool-call')
    assert.equal(blocks[0].name, 'todo_write')
    const args = JSON.parse(blocks[0].arguments)
    assert.ok(args.todos.every((todo) => todo.status === 'completed'))
  })
})

describe('delegate brain', () => {
  it('answers the probe with a delegate call to a quick child', () => {
    const chunks = run('delegate', userOptions('delegate-probe'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].name, 'delegate')
    const args = JSON.parse(blocks[0].arguments)
    assert.equal(args.category, 'quick')
    assert.ok(args.prompt.includes('MARKER_CHILD_OK'))
  })
})

describe('robash brain', () => {
  it('child brain leads with the echo-and-wait shellCall', () => {
    const chunks = run('robash', userOptions('ROBASH_CHILD\nTASK: prove bash works'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].type, 'tool-call')
    assert.equal(blocks[0].name, SHELL)
    const args = JSON.parse(blocks[0].arguments)
    assert.ok(args.command.includes('ROBASH_WAIT_RAN'), `command ${args.command} carries the wait marker`)
  })

  it('parent brain delegates to the finder curated agent', () => {
    const chunks = run('robash', userOptions('robash-probe'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].name, 'delegate')
    assert.equal(JSON.parse(blocks[0].arguments).agent, 'finder')
  })
})

describe('grouped brain', () => {
  it('child A fails the first turn with a provider error chunk', () => {
    const chunks = run('grouped', userOptions('GROUPED_CHILD_A\nTASK: probe alpha'))
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'MOCK_429')
  })

  it('child A reports completed after the retry message', () => {
    const chunks = run('grouped', userOptions('GROUPED_CHILD_A\nContinue the task now, and remember to end'))
    const blocks = blockEnds(chunks)
    assert.ok(blocks[0].text.includes('STATUS: completed'))
    assert.ok(blocks[0].text.includes('alpha finished after one retry'))
  })

  it('parent answers the probe with a grouped delegate call', () => {
    const chunks = run('grouped', userOptions('grouped-probe'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].name, 'delegate')
    const args = JSON.parse(blocks[0].arguments)
    assert.equal(args.group, 'probe-group')
    assert.equal(args.tasks.length, 2)
  })
})

describe('hashline brain', () => {
  it('answers the probe with a fixture read', () => {
    const chunks = run('hashline', userOptions('hashline-probe'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].name, 'read')
    assert.ok(JSON.parse(blocks[0].arguments).file_path.endsWith('fixture.txt'))
  })
})

describe('pressure brain', () => {
  it('answers the compaction purpose with the scripted summary', () => {
    const chunks = run('pressure', userOptions('ignored', { purpose: 'compaction' }))
    const blocks = blockEnds(chunks)
    assert.ok(blocks[0].text.startsWith('SUMMARY:'))
  })

  it('answers the probe with the long filler', () => {
    const chunks = run('pressure', userOptions('pressure-probe'))
    const blocks = blockEnds(chunks)
    assert.ok(blocks[0].text.length > 10000, 'filler raises context pressure')
  })
})

describe('semantic brain', () => {
  it('settles once the deep-work directive is in the transcript', () => {
    const chunks = run('semantic', userOptions('<intent-gate id="deep-work" effort="high">'))
    const blocks = blockEnds(chunks)
    assert.ok(blocks[0].text.includes('semantic mode armed'))
  })
})

describe('escalate brain', () => {
  it('deep child returns an ESCALATE marker', () => {
    const chunks = run('escalate', userOptions('ESCALATE_CHILD\nTASK: probe escalation'))
    const blocks = blockEnds(chunks)
    assert.ok(blocks[0].text.startsWith('ESCALATE: deep-plus'))
  })
})

describe('background brain', () => {
  it('answers the probe with a run_in_background delegate call', () => {
    const chunks = run('background', userOptions('background-probe'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].name, 'delegate')
    assert.equal(JSON.parse(blocks[0].arguments).run_in_background, true)
  })
})

describe('terminate brain', () => {
  it('child A stays busy via the stay-busy shellCall', () => {
    const chunks = run('terminate', userOptions('TERMINATE_CHILD_A\nTASK: stay busy'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].name, SHELL)
    const args = JSON.parse(blocks[0].arguments)
    assert.ok(args.command.includes('30'), 'busy leg holds the child')
  })
})

describe('rehydrate brain', () => {
  it('child B reports blocked in phase 1', () => {
    const chunks = run('rehydrate', userOptions('REHYDRATE_CHILD_B\nTASK: probe beta'))
    const blocks = blockEnds(chunks)
    assert.ok(blocks[0].text.includes('STATUS: blocked'))
  })

  it('parent phase 2 resumes the blocked child', () => {
    const chunks = run('rehydrate', userOptions('rehydrate-resume-probe'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].name, 'resume_agent')
    assert.equal(JSON.parse(blocks[0].arguments).agent, 'beta')
  })
})

describe('lsp brain', () => {
  it('answers the probe by toggling the tool set on', () => {
    const chunks = run('lsp', userOptions('lsp-probe'))
    const blocks = blockEnds(chunks)
    assert.equal(blocks[0].name, 'lsp')
    assert.equal(JSON.parse(blocks[0].arguments).enabled, true)
  })
})

describe('kit shellCall', () => {
  it('renders the platform command for a named operation', () => {
    const blocks = blockEnds([...shellCall('echo-only', { text: 'MARKER' }, 'desc')])
    assert.equal(blocks[0].name, SHELL)
    assert.ok(JSON.parse(blocks[0].arguments).command.includes('MARKER'))
  })
})
