// Scenario: delegate-parallel — two real one-shot child sessions must overlap.
// Each child publishes its arrival and cannot finish until its peer publishes.
// Either child may enter first. This causal rendezvous proves overlap; the
// bounded wait only turns the old serial order into a loud failure, and no
// assertion compares wall-clock durations.
import { shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'delegate-parallel'
const prompt = 'delegate-parallel-probe'
const HANDSHAKE = 'PARALLEL_OVERLAP_OK'
const PATH = 'delegate-parallel'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const parent = history.includes(prompt)

  if (!parent && history.includes('PARALLEL_CHILD_A')) {
    if (history.includes(`${HANDSHAKE}_TIMEOUT`)) return textChunks('PARALLEL_FIRST_TIMEOUT')
    if (history.includes(HANDSHAKE)) return textChunks('PARALLEL_FIRST_RESULT')
    return shellCall('handshake-first', { path: PATH, text: HANDSHAKE, seconds: 5 }, 'Publish child A and wait for the concurrent child B handshake')
  }
  if (!parent && history.includes('PARALLEL_CHILD_B')) {
    if (history.includes(`${HANDSHAKE}_SECOND_TIMEOUT`)) return textChunks('PARALLEL_SECOND_TIMEOUT')
    if (history.includes(`${HANDSHAKE}_SECOND`)) return textChunks('PARALLEL_SECOND_RESULT')
    return shellCall('handshake-second', { path: PATH, text: HANDSHAKE, seconds: 5 }, 'Publish child B and wait for the concurrent child A handshake')
  }

  if (history.includes('PARALLEL_FIRST_RESULT') && history.includes('PARALLEL_SECOND_RESULT')) {
    return textChunks('parent observed ordered parallel handshake results')
  }
  if (history.includes('PARALLEL_FIRST_TIMEOUT') || history.includes('PARALLEL_SECOND_TIMEOUT')) {
    return textChunks('parallel handshake failed: children did not overlap')
  }
  if (parent) {
    return toolCallChunks('delegate', {
      tasks: [
        {
          category: 'quick',
          name: 'first',
          prompt: 'PARALLEL_CHILD_A\nTASK: publish arrival, wait for child B, then report\nDELIVERABLE: a successful handshake marker\nSCOPE: only the handshake\nVERIFY: child B must publish before this child can finish\nSTOP WHEN: the handshake succeeds or reports its bounded failure',
        },
        {
          category: 'quick',
          name: 'second',
          prompt: 'PARALLEL_CHILD_B\nTASK: publish child B, wait for child A, then report\nDELIVERABLE: a successful peer handshake marker\nSCOPE: only the handshake\nVERIFY: child A must publish before this child can finish\nSTOP WHEN: the handshake succeeds or reports its bounded failure',
        },
      ],
    })
  }
  return textChunks('unhandled delegate-parallel turn')
}

function observe(obs) {
  const history = obs.transcript ?? ''
  const parent = history.includes(prompt)
  const first = history.indexOf('## first — completed')
  const second = history.indexOf('## second — completed')
  return {
    parallelProbeSeen: parent,
    parallelFirstChild: !parent && history.includes('PARALLEL_CHILD_A'),
    parallelSecondChild: !parent && history.includes('PARALLEL_CHILD_B'),
    parallelFirstHandshake: !parent && history.includes('PARALLEL_CHILD_A') && history.includes(HANDSHAKE) && !history.includes(`${HANDSHAKE}_TIMEOUT`),
    parallelSecondHandshake: !parent && history.includes('PARALLEL_CHILD_B') && history.includes(`${HANDSHAKE}_SECOND`) && !history.includes(`${HANDSHAKE}_SECOND_TIMEOUT`),
    parallelOrderedResults: parent && first >= 0 && second > first,
  }
}

function assert(run) {
  const requests = run.requests
  const children = run.created.filter((record) => record.origin === 'subagent' && record.depth === 1)
  run.check('parent emitted the ordinary two-item foreground delegate call', requests.some((record) => record.parallelProbeSeen && record.emittedNames?.includes('delegate')), JSON.stringify(requests.map((record) => record.emittedNames)))
  run.check('two real child sessions were created at depth 1', children.length === 2, JSON.stringify(run.created))
  run.check('child A completed only after the peer handshake marker arrived', requests.some((record) => record.parallelFirstHandshake), JSON.stringify(requests.map((record) => [record.parallelFirstChild, record.parallelFirstHandshake])))
  run.check('child B published and completed the peer handshake', requests.some((record) => record.parallelSecondHandshake), JSON.stringify(requests.map((record) => [record.parallelSecondChild, record.parallelSecondHandshake])))
  run.check('parent received one-shot reports in input order', requests.some((record) => record.parallelOrderedResults), JSON.stringify(requests.map((record) => record.parallelOrderedResults)))
  run.check('parent observed both successful handshake reports', run.stdout.includes('parent observed ordered parallel handshake results'), run.stdout.slice(-400))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
