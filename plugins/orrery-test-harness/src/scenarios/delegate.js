// Scenario: delegate — parent delegates to a category child, observes result.
// Migrated from mock-llm.js decideDelegate / run.mjs assertDelegate (D1/D2).
import { textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'delegate'
const prompt = 'delegate-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (history.includes('MARKER_CHILD_OK') && !history.includes('delegate-probe')) {
    return textChunks('MARKER_CHILD_OK: child finished')
  }
  if (lastRole === 'tool') {
    return textChunks('parent observed child result')
  }
  if (history.includes('delegate-probe')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      prompt: 'TASK: reply with the exact marker text MARKER_CHILD_OK\nDELIVERABLE: the marker line\nSCOPE: nothing else\nVERIFY: the reply contains the marker\nSTOP WHEN: the marker is sent',
      task_summary: 'probe child',
    })
  }
  return textChunks('unhandled delegate turn')
}

function observe(obs) {
  return {
    sawDelegateProbe: obs.transcript.includes('delegate-probe'),
    sawChildMarker: obs.transcript.includes('MARKER_CHILD_OK'),
  }
}

function assert(run) {
  const requests = run.requests
  const created = run.created
  run.check('parent emitted a delegate tool call', requests.some((r) => r.emitted.includes('tool-call') && r.sawDelegateProbe))
  run.check('child session created as subagent at depth 1', created.some((r) => r.origin === 'subagent' && r.depth === 1), JSON.stringify(created))
  run.check('child session ran on the delegated prompt', requests.some((r) => r.sawChildMarker && !r.sawDelegateProbe))
  run.check('parent observed the child result', run.stdout.includes('parent observed child result'), run.stdout.slice(-400))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
