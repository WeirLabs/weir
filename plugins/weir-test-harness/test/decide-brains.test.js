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
function toolOptions(userText, toolText) {
  const options = userOptions(userText)
  options.messages.push({ role: 'tool', content: [{ type: 'text', text: toolText }], source: { kind: 'tool', toolCallId: 'mock-call-1' } })
  return options
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

describe('delegate-parallel brain', () => {
  it('starts an ordinary two-item foreground batch', () => {
    const [block] = blockEnds(run('delegate-parallel', userOptions('delegate-parallel-probe')))
    assert.equal(block.name, 'delegate')
    const args = JSON.parse(block.arguments)
    assert.equal(args.tasks.length, 2)
    assert.equal(args.group, undefined)
    assert.equal(args.run_in_background, undefined)
  })

  it('makes both children publish then wait for their peer', () => {
    const first = blockEnds(run('delegate-parallel', userOptions('PARALLEL_CHILD_A')))[0]
    const second = blockEnds(run('delegate-parallel', userOptions('PARALLEL_CHILD_B')))[0]
    assert.equal(first.name, SHELL)
    assert.equal(second.name, SHELL)
    assert.match(JSON.parse(first.arguments).command, /delegate-parallel-second\.ready/)
    assert.match(JSON.parse(second.arguments).command, /delegate-parallel-first\.ready/)
  })

  it('does not mistake a bounded handshake timeout for successful overlap', () => {
    const options = userOptions('PARALLEL_CHILD_A\nPARALLEL_OVERLAP_OK_TIMEOUT')
    const [block] = blockEnds(run('delegate-parallel', options))
    assert.equal(block.text, 'PARALLEL_FIRST_TIMEOUT')
    const secondOptions = userOptions('PARALLEL_CHILD_B\nPARALLEL_OVERLAP_OK_SECOND_TIMEOUT')
    const [second] = blockEnds(run('delegate-parallel', secondOptions))
    assert.equal(second.text, 'PARALLEL_SECOND_TIMEOUT')
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

describe('mcp-defer-loading brain', () => {
  it('drives Apply, deferred RPC, ordinary RPC and the protocol report in order', () => {
    const first = blockEnds(run('mcp-defer-loading', userOptions('mcp-defer-loading-probe')))[0]
    assert.equal(first.name, 'mcp_probe')
    assert.deepEqual(JSON.parse(first.arguments).mcpServers, ['deferred', 'plain'])
    const afterApply = blockEnds(run('mcp-defer-loading', userOptions('mcp-defer-loading-probe\nMCP_PROBE done apply:unsupported')))[0]
    assert.equal(afterApply.name, 'mcp__deferred__echo')
    const afterDeferred = blockEnds(run('mcp-defer-loading', userOptions('mcp-defer-loading-probe\nMCP_PROBE done apply:unsupported\nRESULT server=deferred origin=managed-unsupported')))[0]
    assert.equal(afterDeferred.name, 'mcp__plain__echo')
    const afterPlain = blockEnds(run('mcp-defer-loading', userOptions('mcp-defer-loading-probe\nMCP_PROBE done apply:unsupported\nRESULT server=deferred origin=managed-unsupported\nRESULT server=plain origin=managed-unsupported')))[0]
    assert.equal(afterPlain.name, 'mcp_probe')
    assert.equal(JSON.parse(afterPlain.arguments).op, 'deferReport')
    const final = blockEnds(run('mcp-defer-loading', userOptions('mcp-defer-loading-probe\nMCP_PROBE done apply:unsupported\nRESULT server=deferred origin=managed-unsupported\nRESULT server=plain origin=managed-unsupported\nMCP_PROBE done defer-report:unsupported')))[0]
    assert.equal(final.text, 'mcp defer protocol unsupported complete')
  })
})

describe('kit shellCall', () => {
  it('renders the platform command for a named operation', () => {
    const blocks = blockEnds([...shellCall('echo-only', { text: 'MARKER' }, 'desc')])
    assert.equal(blocks[0].name, SHELL)
    assert.ok(JSON.parse(blocks[0].arguments).command.includes('MARKER'))
  })
})


describe('capstore brain', () => {
  it('starts with the host probe', () => {
    assert.equal(blockEnds(run('capstore', userOptions('capstore-probe')))[0].name, 'capstore_probe_host')
  })

  for (const injected of [false, true]) {
    for (const label of ['host', 'realm']) {
      it(`advances after ${label} result${injected ? ' followed by runtime context' : ''}`, () => {
        const options = userOptions('capstore-probe')
        options.messages.push({ role: 'tool', content: [{ type: 'text', text: `CAPSTORE_PROBE ${label} committed` }] })
        if (injected) options.messages.push({ role: 'user', content: [{ type: 'text', text: 'Current runtime context. Worktree lanes: it-lane-001 · no-commits' }] })
        const [block] = blockEnds(run('capstore', options))
        if (label === 'host') assert.equal(block.name, 'capstore_probe_realm')
        else assert.equal(block.text, 'capstore done')
      })
    }
  }
})

// The filelease-* lease-semantics scenarios (edit-lock-rebuild 5.2/5.5/5.6) are
// driven by the SAME mock brain in a headless boot; these in-process checks pin
// the step order so a broken marker cannot silently skip a boundary (for
// example, "hold before write" would be refused by the broker, and a missing
// wait step would race the driver's fault injection).
describe('filelease brains', () => {
  const writeCall = (history) => {
    const blocks = blockEnds(run('filelease-turn-release', userOptions(history)))
    assert.equal(blocks[0].name, 'write')
    return JSON.parse(blocks[0].arguments)
  }

  it('filelease-turn-release writes first, then holds the turn open for the driver', () => {
    const first = writeCall('filelease-turn-release-probe')
    assert.equal(first.file_path.endsWith('lease-target.txt'), true)
    const afterWrite = blockEnds(run('filelease-turn-release', userOptions(
      `filelease-turn-release-probe\nCreated file: ${first.file_path}`,
    )))
    assert.equal(afterWrite[0].name, SHELL)
    assert.match(JSON.parse(afterWrite[0].arguments).command, /WEIR_LEASE_CONTENDED/)
    const done = blockEnds(run('filelease-turn-release', userOptions(
      `filelease-turn-release-probe\nCreated file: ${first.file_path}\nWEIR_LEASE_CONTENDED`,
    )))
    assert.equal(done[0].type, 'text')
  })

  it('filelease-hold writes, then retains the path it already owns', () => {
    const first = blockEnds(run('filelease-hold', userOptions('filelease-hold-probe')))[0]
    assert.equal(first.name, 'write')
    const path = JSON.parse(first.arguments).file_path
    const hold = blockEnds(run('filelease-hold', userOptions(`filelease-hold-probe\nCreated file: ${path}`)))[0]
    assert.equal(hold.name, 'edit_lock_hold')
    assert.deepEqual(JSON.parse(hold.arguments), { paths: [path], minutes: 30 })
  })

  it('filelease-degrade retries the write and then reads the degradation surface', () => {
    const first = blockEnds(run('filelease-degrade', userOptions('filelease-degrade-probe')))[0]
    assert.equal(first.name, 'write')
    const path = JSON.parse(first.arguments).file_path
    const second = JSON.parse(blockEnds(run('filelease-degrade', userOptions(`filelease-degrade-probe\nCreated file: ${path}`)))[0].arguments)
    assert.equal(second.file_path, path)
    assert.notEqual(second.content, JSON.parse(first.arguments).content)
    const status = blockEnds(run('filelease-degrade', userOptions(`filelease-degrade-probe\nCreated file: ${path}\nUpdated file: ${path}`)))[0]
    assert.equal(status.name, 'edit_lock_status')
  })

  it('filelease-fault-injection writes, waits, then writes the second target', () => {
    const first = blockEnds(run('filelease-fault-injection', userOptions('filelease-fault-injection-probe')))[0]
    assert.equal(first.name, 'write')
    const firstPath = JSON.parse(first.arguments).file_path
    const wait = blockEnds(run('filelease-fault-injection', userOptions(`filelease-fault-injection-probe\nCreated file: ${firstPath}`)))[0]
    assert.equal(wait.name, SHELL)
    assert.match(JSON.parse(wait.arguments).command, /WEIR_FAULT_INJECTED/)
    const second = blockEnds(run('filelease-fault-injection', userOptions(`filelease-fault-injection-probe\nCreated file: ${firstPath}\nWEIR_FAULT_INJECTED`)))[0]
    assert.equal(second.name, 'write')
    assert.notEqual(JSON.parse(second.arguments).file_path, firstPath)
  })

  it('filelease-negotiation claims two paths, waits once, then answers release before keep', () => {
    const probe = 'filelease-negotiation-probe'
    const pathA = JSON.parse(blockEnds(run('filelease-negotiation', userOptions(probe)))[0].arguments).file_path
    const second = JSON.parse(blockEnds(run('filelease-negotiation', userOptions(`${probe}\nCreated file: ${pathA}`)))[0].arguments)
    assert.notEqual(second.file_path, pathA)
    // One wait step is emitted after both claims; its marker is what a
    // follow-up step keys on, never a role gate.
    const wait = blockEnds(run('filelease-negotiation', userOptions(`${probe}\nCreated file: ${pathA}\nCreated file: ${second.file_path}`)))[0]
    assert.equal(wait.name, SHELL)
    assert.match(JSON.parse(wait.arguments).command, /WEIR_LEASE_NEGOTIATED_1/)
    const notice = (id, name) => `Session "Second owner (integration driver)" (session session-weir-it-negotiation-driver) is asking to take over ${name}. Answer with edit_lock_reply: request_id "${id}", decision "release" to hand it over, or "keep" to hold on to it.`
    const history = [probe, `Created file: ${pathA}`, `Created file: ${second.file_path}`, notice('req-1', 'lease-negotiation-a.txt'), notice('req-2', 'lease-negotiation-b.txt')].join('\n')
    const release = blockEnds(run('filelease-negotiation', userOptions(history)))[0]
    assert.equal(release.name, 'edit_lock_reply')
    assert.deepEqual(JSON.parse(release.arguments), { request_id: 'req-1', decision: 'release' })
    // The keep request is answered only after the first path's transfer landed.
    const afterRelease = blockEnds(run('filelease-negotiation', userOptions(`${history}\nRequest req-1: transferred.`)))[0]
    assert.equal(afterRelease.name, 'write')
    assert.equal(JSON.parse(afterRelease.arguments).file_path, pathA)
    const afterRefusal = blockEnds(run('filelease-negotiation', userOptions(`${history}\nRequest req-1: transferred.\nlease broker refused acquire: held`)))[0]
    assert.equal(afterRefusal.name, 'edit_lock_reply')
    assert.deepEqual(JSON.parse(afterRefusal.arguments), { request_id: 'req-2', decision: 'keep' })
  })
})

// The 3.3 / 3.5 / 5.6 scenarios. Same in-process step pinning as above: a
// broken marker must fail here, not as a hung headless boot.
describe('filelease lineage / wake / holder-death brains', () => {
  it('filelease-lineage writes, holds the window open, then delegates', () => {
    const probe = 'filelease-lineage-probe'
    const first = blockEnds(run('filelease-lineage', userOptions(probe)))[0]
    assert.equal(first.name, 'write')
    const path = JSON.parse(first.arguments).file_path
    const wait = blockEnds(run('filelease-lineage', userOptions(`${probe}\nCreated file: ${path}`)))[0]
    assert.equal(wait.name, SHELL)
    assert.match(JSON.parse(wait.arguments).command, /WEIR_LEASE_LINEAGE_WINDOW/)
    const delegated = blockEnds(run('filelease-lineage', userOptions(`${probe}\nCreated file: ${path}\nWEIR_LEASE_LINEAGE_WINDOW`)))[0]
    assert.equal(delegated.name, 'delegate')
    assert.equal(JSON.parse(delegated.arguments).category, 'quick')
  })

  it('filelease-lineage child reads before its managed overwrite, then reports the marker', () => {
    // A child session's history never contains the parent prompt: that absence
    // is the discriminator, exactly as in `robash`.
    const path = JSON.parse(blockEnds(run('filelease-lineage', userOptions('filelease-lineage-probe')))[0].arguments).file_path
    const task = 'filelease-lineage-child-task'
    const read = blockEnds(run('filelease-lineage', userOptions(task)))[0]
    assert.equal(read.name, 'read')
    assert.equal(JSON.parse(read.arguments).file_path, path)
    const edited = blockEnds(run('filelease-lineage', userOptions(`${task}\n1#AB| parent claim written inside the parent turn`)))[0]
    assert.equal(edited.name, 'write')
    assert.notEqual(JSON.parse(edited.arguments).content, 'parent claim written inside the parent turn\n')
    const done = blockEnds(run('filelease-lineage', userOptions(`${task}\n1#AB| parent claim written inside the parent turn\nUpdated file: ${path}`)))[0]
    assert.match(done.text, /MARKER_CHILD_LINEAGE_EDIT_OK/)
  })

  it('filelease-wake keeps the turn open, then answers the request notice with release', () => {
    const probe = 'filelease-wake-probe'
    const first = blockEnds(run('filelease-wake', userOptions(probe)))[0]
    assert.equal(first.name, 'write')
    const path = JSON.parse(first.arguments).file_path
    const wait = blockEnds(run('filelease-wake', userOptions(`${probe}\nCreated file: ${path}`)))[0]
    assert.equal(wait.name, SHELL)
    assert.match(JSON.parse(wait.arguments).command, /WEIR_LEASE_WAKE_WINDOW/)
    // No notice yet: the SAME turn stays open with the bounded marker wait.
    const stillWaiting = blockEnds(run('filelease-wake', userOptions(`${probe}\nCreated file: ${path}\nWEIR_LEASE_WAKE_WINDOW`)))[0]
    assert.equal(stillWaiting.name, SHELL)
    assert.match(JSON.parse(stillWaiting.arguments).command, /WEIR_WAIT_1/)
    const notice = 'Session "Second owner (integration driver)" (session session-weir-it-wake-driver) is asking to take over lease-wake-target.txt. Answer with edit_lock_reply: request_id "req-9", decision "release" to hand it over, or "keep" to hold on to it.'
    const reply = blockEnds(run('filelease-wake', userOptions(`${probe}\nCreated file: ${path}\nWEIR_LEASE_WAKE_WINDOW\n${notice}`)))[0]
    assert.equal(reply.name, 'edit_lock_reply')
    assert.deepEqual(JSON.parse(reply.arguments), { request_id: 'req-9', decision: 'release' })
  })

  it('filelease-holder-death only bootstraps the arbiter with one managed write', () => {
    const first = blockEnds(run('filelease-holder-death', userOptions('filelease-holder-death-probe')))[0]
    assert.equal(first.name, 'write')
    const path = JSON.parse(first.arguments).file_path
    assert.equal(path.endsWith('lease-holder-death-boot.txt'), true)
    const afterWrite = blockEnds(run('filelease-holder-death', userOptions(`filelease-holder-death-probe\nCreated file: ${path}`)))[0]
    assert.equal(afterWrite.type, 'text')
  })
})

describe('decision-agent P0 spike brains', { skip: process.env.WEIR_IT_DECISION_SPIKES !== '1' }, () => {
  it('order drives the stock ask and finishes on the prepend answer', () => {
    const first = blockEnds(run('decision-spike-order', userOptions('decision-spike-order-probe')))[0]
    assert.equal(first.name, 'ask_user_question')
    const after = blockEnds(run('decision-spike-order', toolOptions('decision-spike-order-probe', '{"answers":[{"id":"s1-order","selected":["Prepend"]}]}')))[0]
    assert.equal(after.text, 'S1_ORDER_DONE')
  })

  it('delegated child asks first, then consults only after DELEGATED_CALLER', () => {
    const first = blockEnds(run('decision-spike-delegated', userOptions('DECISION_SPIKE_CHILD')))[0]
    assert.equal(first.name, 'ask_user_question')
    const second = blockEnds(run('decision-spike-delegated', toolOptions('DECISION_SPIKE_CHILD', '{"error":{"code":"DELEGATED_CALLER"}}')))[0]
    assert.equal(second.name, 'decision_consult')
    const parent = blockEnds(run('decision-spike-delegated', userOptions('decision-spike-delegated-probe')))[0]
    assert.equal(parent.name, 'delegate')
  })

  it('JSON mock brain emits all five fixture classes', () => {
    for (const fixture of ['valid', 'fenced', 'truncated', 'non-json', 'unknown-evidence']) {
      const chunks = run('decision-spike-json', userOptions(`FIXTURE:${fixture}`, { system: 'Decision evaluator contract v1' }))
      if (fixture === 'truncated') assert.equal(chunks.at(-1).reason.kind, 'max-tokens')
      else assert.equal(chunks.at(-1).reason.kind, 'stop')
    }
    const main = blockEnds(run('decision-spike-json', userOptions('decision-spike-json-probe')))[0]
    assert.equal(main.name, 'decision_json_spike')
  })

  it('multi-mount drives the dual-preset host probe', () => {
    const block = blockEnds(run('decision-spike-multi-mount', userOptions('decision-spike-multi-mount-probe')))[0]
    assert.equal(block.name, 'decision_multi_mount_spike')
  })

  it('cancel drives the two-process probe and exposes the hang fixture', () => {
    const main = blockEnds(run('decision-spike-cancel', userOptions('decision-spike-cancel-probe')))[0]
    assert.equal(main.name, 'decision_cancel_spike')
    const sidecar = blockEnds(run('decision-spike-cancel', userOptions('FIXTURE:hang', { system: 'Decision evaluator contract v1' })))[0]
    assert.equal(sidecar.text, 'HANG')
  })
  it('slots brain selects before/after inspect phases', () => {
    assert.equal(JSON.parse(blockEnds(run('decision-spike-slots', userOptions('decision-spike-slots-probe')))[0].arguments).phase, 'before')
    assert.equal(JSON.parse(blockEnds(run('decision-spike-slots', userOptions('decision-spike-slots-probe-after')))[0].arguments).phase, 'after')
  })
  it('current-profile brain covers native, batch, and subagent flows', () => {
    assert.equal(blockEnds(run('decision-spike-current', userOptions('P0_ANSWERED')))[0].name, 'ask_user_question')
    assert.equal(JSON.parse(blockEnds(run('decision-spike-current', userOptions('P0_BATCH_ALL')))[0].arguments).questions.length, 3)
    assert.equal(blockEnds(run('decision-spike-current', userOptions('P0_SUBAGENT')))[0].name, 'decision_consult')
  })
})

describe('decision-hook P1 brain', () => {
  it('starts in Off, then creates the live Broker fixture', () => {
    const first = blockEnds(run('decision-hook', userOptions('decision-hook-probe')))[0]
    assert.equal(first.name, 'ask_user_question')
    assert.equal(JSON.parse(first.arguments).questions[0].id, 'decision-hook-off')
    const afterOff = blockEnds(run('decision-hook', toolOptions('decision-hook-probe', '{"answers":[{"id":"decision-hook-off","selected":["Native Off"]}]}')))[0]
    assert.equal(afterOff.name, 'decision_integration_probe')
    assert.equal(JSON.parse(afterOff.arguments).op, 'setup')
  })

  it('scripts an evidence-citing answer and malformed output for the evaluator dispatch', () => {
    const scenario = byId('decision-hook')
    assert.equal(typeof scenario.decideDecision, 'function')
    const options = userOptions(JSON.stringify({
      L4: { request: { questions: [{ id: 'decision-hook-answer', options: [{ label: 'Native fallback' }, { label: 'Concise' }] }] } },
      L5: [{ evidenceId: 'ev_test', source: 'user_profile' }],
    }), { system: 'Decision evaluator contract v1' })
    const answer = JSON.parse(blockEnds([...scenario.decideDecision(options, extract(options))])[0].text)
    assert.equal(answer.outcome, 'answer')
    assert.equal(answer.claims[0].evidenceIds[0], 'ev_test')
    assert.deepEqual(answer.answers, [{ id: 'decision-hook-answer', selected: ['Concise'] }])
    const invalidOptions = userOptions(JSON.stringify({ L4: { request: { questions: [{ id: 'decision-hook-invalid' }] } }, L5: [] }), { system: 'Decision evaluator contract v1' })
    assert.equal(blockEnds([...scenario.decideDecision(invalidOptions, extract(invalidOptions))])[0].text, 'this is not JSON')
  })
})

describe('decision evaluator v2 mock dispatch', () => {
  it('routes contract v2 through the scenario Decision brain', async () => {
    const previous = process.env.WEIR_IT_SCENARIO
    process.env.WEIR_IT_SCENARIO = 'decision-hook'
    try {
      const { planRequest } = await import('../src/mock-llm.js')
      const options = userOptions(JSON.stringify({
        L4: { request: { questions: [{ id: 'decision-hook-answer', options: [{ label: 'Native fallback' }, { label: 'Concise' }] }] } },
        L5: [{ evidenceId: 'ev_v2', source: 'user_profile' }],
      }), { system: 'Decision evaluator contract v2\nL3 is neutral and non-authoritative.' })
      const { out } = planRequest(options)
      const answer = JSON.parse(blockEnds(out)[0].text)
      assert.equal(answer.outcome, 'answer')
      assert.equal(answer.claims[0].evidenceIds[0], 'ev_v2')
      assert.deepEqual(answer.answers, [{ id: 'decision-hook-answer', selected: ['Concise'] }])
      const observed = byId('decision-hook').observe(extract(options))
      assert.equal(observed.decisionEvaluator, true)
      assert.deepEqual(observed.decisionQuestionIds, ['decision-hook-answer'])
      assert.deepEqual(observed.decisionEvidenceIds, ['ev_v2'])
    } finally {
      if (previous === undefined) delete process.env.WEIR_IT_SCENARIO
      else process.env.WEIR_IT_SCENARIO = previous
    }
  })
})

describe('decision-memory P2 brain', () => {
  it('registers the real scoped-memory acceptance scenario', () => {
    assert.equal(byId('decision-memory')?.id, 'decision-memory')
  })

  it('deliberately attempts an L3-only citation so the real evidence-id parser must reject it', () => {
    const scenario = byId('decision-memory')
    const options = userOptions(JSON.stringify({
      L3: [{ sourceCaseId: 'dc_neutral' }],
      L4: { request: { questions: [{ id: 'decision-memory-l3-only', question: 'Reuse neutral memory without a decisive L5', options: [{ label: 'User resolves L3 only' }, { label: 'Neutral answer' }] }] } },
      L5: [{ evidenceId: 'ev_profile', source: 'user_profile' }],
    }), { system: 'Decision evaluator contract v2' })
    const value = JSON.parse(blockEnds([...scenario.decideDecision(options, extract(options))])[0].text)
    assert.equal(value.outcome, 'answer')
    assert.deepEqual(value.claims[0].evidenceIds, ['dc_neutral'])
  })

  it('uses only the genuine user-decision L5 after the L3-only Case is resolved', () => {
    const scenario = byId('decision-memory')
    const options = userOptions(JSON.stringify({
      L3: [{ sourceCaseId: 'dc_neutral' }],
      L4: { request: { questions: [{ id: 'decision-memory-l5-after', question: 'Reuse the genuine user decision', options: [{ label: 'User resolves L3 only' }, { label: 'Neutral answer' }] }] } },
      L5: [{ evidenceId: 'ev_profile', source: 'user_profile' }, { evidenceId: 'ev_decision', source: 'user_decision', excerpt: 'User decision question: User resolves L3 only' }],
    }), { system: 'Decision evaluator contract v2' })
    const value = JSON.parse(blockEnds([...scenario.decideDecision(options, extract(options))])[0].text)
    assert.equal(value.outcome, 'answer')
    assert.deepEqual(value.claims[0].evidenceIds, ['ev_decision'])
    assert.deepEqual(value.answers, [{ id: 'decision-memory-l5-after', selected: ['User resolves L3 only'] }])
  })
})

describe('decision-consult P1 brain', () => {
  it('sets up the selected Agent before the answered consultation', () => {
    const first = blockEnds(run('decision-consult', userOptions('decision-consult-probe')))[0]
    assert.equal(first.name, 'decision_integration_probe')
    const afterSetup = blockEnds(run('decision-consult', toolOptions('decision-consult-probe', 'DECISION_TEST done setup:{"completed":true}')))[0]
    assert.equal(afterSetup.name, 'decision_consult')
    assert.equal(JSON.parse(afterSetup.arguments).request_id, 'consult-answered')
  })

  it('delegated child escalates without asking, then reads the Case once', () => {
    const first = blockEnds(run('decision-consult', userOptions('DECISION_CONSULT_CHILD_TASK')))[0]
    assert.equal(first.name, 'decision_consult')
    const result = '{"outcome":"awaiting_user","caseId":"dc_child","state":"awaiting_user"}\nDecision dc_child is awaiting user judgment.'
    const second = blockEnds(run('decision-consult', toolOptions('DECISION_CONSULT_CHILD_TASK', result)))[0]
    assert.equal(second.name, 'decision_integration_probe')
    assert.deepEqual(JSON.parse(second.arguments), { op: 'record', caseId: 'dc_child' })
  })
})

describe('decision-batch P1 brain', () => {
  it('drives a three-question batch before partial and approval controls', () => {
    const setup = blockEnds(run('decision-batch', userOptions('decision-batch-probe')))[0]
    assert.equal(setup.name, 'decision_integration_probe')
    const all = blockEnds(run('decision-batch', toolOptions('decision-batch-probe', 'DECISION_TEST done setup:{"completed":true}')))[0]
    assert.equal(all.name, 'ask_user_question')
    const args = JSON.parse(all.arguments)
    assert.equal(args.questions.length, 3)
    assert.equal(args.questions[1].multi_select, true)
  })

  it('partial evaluator output omits the unresolved middle answer', () => {
    const scenario = byId('decision-batch')
    const options = userOptions(JSON.stringify({
      L4: { request: { questions: [
        { id: 'decision-batch-partial-1' }, { id: 'decision-batch-partial-2' }, { id: 'decision-batch-partial-3' },
      ] } },
      L5: [{ evidenceId: 'ev_batch', source: 'user_profile' }],
    }), { system: 'Decision evaluator contract v1' })
    const value = JSON.parse(blockEnds([...scenario.decideDecision(options, extract(options))])[0].text)
    assert.deepEqual(value.answers.map(answer => answer.id), ['decision-batch-partial-1', 'decision-batch-partial-3'])
  })
})

describe('decision-route P1 brain', () => {
  it('pins A before disabling it, then consults explicit B without changing the selector', () => {
    const setup = blockEnds(run('decision-route', userOptions('decision-route-probe')))[0]
    assert.equal(JSON.parse(setup.arguments).op, 'route-setup')
    const pinned = blockEnds(run('decision-route', toolOptions('decision-route-probe', 'DECISION_TEST done route-setup:{"agentA":"ag_a","agentB":"ag_b"}')))[0]
    assert.equal(JSON.parse(pinned.arguments).questions[0].id, 'decision-route-pinned')
    const history = 'decision-route-probe\nDECISION_TEST done route-setup:{"agentA":"ag_a","agentB":"ag_b"}\n{"answers":[{"id":"decision-route-pinned","selected":["Pinned A"]}]}'
    const disable = blockEnds(run('decision-route', userOptions(history)))[0]
    assert.deepEqual(JSON.parse(disable.arguments), { op: 'disable-a', agentId: 'ag_a' })
  })
})

describe('decision-recovery P1 brain', () => {
  it('replays the persisted consult after restart, then verifies recovery', () => {
    const previous = process.env.WEIR_IT_DECISION_PHASE
    process.env.WEIR_IT_DECISION_PHASE = 'after'
    try {
      const replay = blockEnds(run('decision-recovery', userOptions('decision-recovery-probe')))[0]
      assert.equal(replay.name, 'decision_consult')
      assert.equal(JSON.parse(replay.arguments).request_id, 'recovery-replay')
      const verify = blockEnds(run('decision-recovery', toolOptions('decision-recovery-probe\n{"outcome":"answered","caseId":"dc_replay"}', '{"outcome":"answered","caseId":"dc_replay"}')))[0]
      assert.equal(verify.name, 'decision_recovery_probe')
      assert.equal(JSON.parse(verify.arguments).op, 'verify')
    } finally {
      if (previous === undefined) delete process.env.WEIR_IT_DECISION_PHASE
      else process.env.WEIR_IT_DECISION_PHASE = previous
    }
  })
})

describe('decision-feedback P1 brain', () => {
  it('escalates a new judgment and prefers an active Correction over old decisions', () => {
    const first = blockEnds(run('decision-feedback', userOptions('decision-feedback-probe')))[0]
    assert.equal(first.name, 'decision_integration_probe')
    const source = blockEnds(run('decision-feedback', toolOptions('decision-feedback-probe', 'DECISION_TEST done setup:{"completed":true}')))[0]
    assert.equal(source.name, 'ask_user_question')
    const scenario = byId('decision-feedback')
    const options = userOptions(JSON.stringify({
      L4: { request: { questions: [{ id: 'decision-feedback-corrected' }] } },
      L5: [{ evidenceId: 'ev_decision', source: 'user_decision', excerpt: 'User decision q: Use Short' }, { evidenceId: 'ev_correction', source: 'user_correction', excerpt: 'Use Long' }],
    }), { system: 'Decision evaluator contract v1' })
    const value = JSON.parse(blockEnds([...scenario.decideDecision(options, extract(options))])[0].text)
    assert.equal(value.answers[0].selected[0], 'Use Long')
    assert.equal(value.claims[0].evidenceIds[0], 'ev_correction')
  })
})

describe('decision-isolation P1 brain', () => {
  it('fails closed for B without evidence and W2 without W1 records', () => {
    const scenario = byId('decision-isolation')
    const bOptions = userOptions(JSON.stringify({ L4: { request: { questions: [{ id: 'decision-isolation-b' }] } }, L5: [] }), { system: 'Decision evaluator contract v1' })
    const b = JSON.parse(blockEnds([...scenario.decideDecision(bOptions, extract(bOptions))])[0].text)
    assert.equal(b.reasonCode, 'MISSING_CONTEXT')
    const crossOptions = userOptions(JSON.stringify({ L4: { request: { questions: [{ id: 'question', question: 'ISOLATION_CROSS: use W2 only' }] } }, L5: [] }), { system: 'Decision evaluator contract v1' })
    const cross = JSON.parse(blockEnds([...scenario.decideDecision(crossOptions, extract(crossOptions))])[0].text)
    assert.equal(cross.reasonCode, 'OUT_OF_SCOPE')
  })
})

describe('decision-ui-remote P1 brain', () => {
  it('runs the root remote matrix before the delegated bare-session reads', () => {
    const root = blockEnds(run('decision-ui-remote', userOptions('decision-ui-remote-probe')))[0]
    assert.equal(root.name, 'decision_remote_probe')
    assert.equal(JSON.parse(root.arguments).op, 'root')
    const after = blockEnds(run('decision-ui-remote', toolOptions('decision-ui-remote-probe', 'DECISION_REMOTE done root:{"completed":true}')))[0]
    assert.equal(after.name, 'delegate')
    const child = blockEnds(run('decision-ui-remote', userOptions('DECISION_REMOTE_CHILD_TASK')))[0]
    assert.equal(child.name, 'decision_consult')
  })
})

describe('decision-gui opt-in brain', { skip: process.env.WEIR_IT_DECISION_GUI !== '1' }, () => {
  it('emits the native structured question for GUI_A_ANSWER', () => {
    const first = blockEnds(run('decision-gui', userOptions('GUI_A_ANSWER')))[0]
    assert.equal(first.name, 'ask_user_question')
    assert.equal(JSON.parse(first.arguments).questions[0].id, 'gui-a-answer')
  })
  it('makes after-down and later turns evidence-driven instead of id-driven', () => {
    const scenario = byId('decision-gui')
    const evaluate = evidence => {
      const options = userOptions(JSON.stringify({
        L4: { request: { questions: [{ id: 'gui-b-after-down', question: 'Reuse the disputed GUI direction', options: [{ label: 'Use Short' }, { label: 'Use Long' }] }] } },
        L5: evidence,
      }), { system: 'Decision evaluator contract v1' })
      return JSON.parse(blockEnds([...scenario.decideDecision(options, extract(options))])[0].text)
    }
    assert.equal(evaluate([]).outcome, 'escalate')
    assert.equal(evaluate([{ evidenceId: 'ev_empty', source: 'user_decision' }]).outcome, 'escalate')
    const restored = evaluate([{ evidenceId: 'ev_decision', source: 'user_decision', excerpt: 'User decision q: Use Short' }])
    assert.equal(restored.outcome, 'answer')
    assert.deepEqual(restored.answers, [{ id: 'gui-b-after-down', selected: ['Use Short'] }])
    const corrected = evaluate([{ evidenceId: 'ev_correction', source: 'user_correction', excerpt: 'Use Long' }, { evidenceId: 'ev_decision', source: 'user_decision', excerpt: 'User decision q: Use Short' }])
    assert.deepEqual(corrected.answers, [{ id: 'gui-b-after-down', selected: ['Use Long'] }])
    assert.equal(corrected.claims[0].evidenceIds[0], 'ev_correction')

    const later = userOptions('GUI_A_ANSWER')
    later.messages.push({ role: 'tool', content: [{ type: 'text', text: '{"answers":[]}' }] })
    later.messages.push({ role: 'user', content: [{ type: 'text', text: 'GUI_B_NEW' }] })
    later.messages.push({ role: 'user', content: [{ type: 'text', text: '<system-reminder>Current runtime context.</system-reminder>' }] })
    const next = blockEnds([...scenario.decide(later, extract(later))])[0]
    assert.equal(next.name, 'ask_user_question')
    assert.equal(JSON.parse(next.arguments).questions[0].id, 'gui-b-new')
  })
  it('provides a real returned case for the six-dimension GUI filter matrix', () => {
    const scenario = byId('decision-gui')
    const options = userOptions(JSON.stringify({ L4: { request: { questions: [{ id: 'question', question: 'GUI_C_RETURN: needs scoped context' }] } }, L5: [] }), { system: 'Decision evaluator contract v1' })
    const value = JSON.parse(blockEnds([...scenario.decideDecision(options, extract(options))])[0].text)
    assert.equal(value.outcome, 'return')
    assert.equal(value.reasonCode, 'MISSING_CONTEXT')
    assert.ok(value.hint.includes('scope'))
  })
})
