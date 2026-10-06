// Scenario: delegate — parent delegates to a category child, observes result.
// Migrated from mock-llm.js decideDelegate / run.mjs assertDelegate (D1/D2).
import { textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { DELEGATE_TARGETS_TEMPLATE } from '../../../orrery-harness/src/delegate/targets.js'

const id = 'delegate'
const prompt = 'delegate-probe'
// The guidance markers come from the product constants, so a heading rename can
// never leave this scenario asserting a stale string (task 4.1).
const GUIDANCE_HEADING = DELEGATE_TARGETS_TEMPLATE.split('\n', 1)[0]

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Parent: the child report rode the delegate result into history. History-
  // driven (never lastRole): a runtime-context snapshot interleaving after the
  // tool result misaligned the old gate into an UNGUARDED re-delegation below.
  if (history.includes('MARKER_CHILD_OK') && !history.includes('delegate-probe')) {
    return textChunks('MARKER_CHILD_OK: child finished')
  }
  if (history.includes('MARKER_CHILD_OK')) {
    return textChunks('parent observed child result')
  }
  if (history.includes('delegate-probe') && !history.includes('MARKER_CHILD_OK')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      prompt: 'TASK: reply with the exact marker text MARKER_CHILD_OK\nDELIVERABLE: the marker line\nSCOPE: nothing else\nVERIFY: the reply contains the marker\nSTOP WHEN: the marker is sent',
      task_summary: 'probe child',
    })
  }
  return textChunks('unhandled delegate turn')
}

function observe(obs) {
  // The agent request delivers the rendered system prompt IN-HISTORY as a
  // system-role message (dsh-agent-loop's `systemPrompt.project`), while the
  // sidecar requests (the intent classifier) pass it in `system`. Concatenate
  // both so the assertion holds however the request carries it.
  const system = `${obs.system ?? ''}\n${obs.transcript ?? ''}`
  return {
    sawDelegateProbe: obs.transcript.includes('delegate-probe'),
    sawChildMarker: obs.transcript.includes('MARKER_CHILD_OK'),
    sawTargetsGuidance: system.includes(GUIDANCE_HEADING),
    guidanceListsQuick: system.includes('- quick —'),
  }
}

function assert(run) {
  const requests = run.requests
  const created = run.created
  run.check('parent emitted a delegate tool call', requests.some((r) => r.emitted.includes('tool-call') && r.sawDelegateProbe))
  run.check('child session created as subagent at depth 1', created.some((r) => r.origin === 'subagent' && r.depth === 1), JSON.stringify(created))
  run.check('child session ran on the delegated prompt', requests.some((r) => r.sawChildMarker && !r.sawDelegateProbe))
  run.check('parent observed the child result', run.stdout.includes('parent observed child result'), run.stdout.slice(-400))
  const parent = requests.find((r) => r.emittedNames?.includes('delegate'))
  run.check('parent system prompt carries the delegation-target guidance', Boolean(parent?.sawTargetsGuidance))
  run.check('guidance lists the quick category', Boolean(parent?.guidanceListsQuick))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
