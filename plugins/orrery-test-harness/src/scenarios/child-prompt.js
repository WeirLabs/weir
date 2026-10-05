// Scenario: child-prompt — a delegated child's first request carries NO
// orchestrator-facing material: the doctrine/delegate-targets/worktree-lanes
// sections render empty in child scope, the tools payload excludes every
// CHILD_DENY_TOOLS entry, and the persona carries WORKER_CONTRACT. Mirrors
// the delegate scenario's shape (parent probes, child answers a marker).
import { textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { CHILD_DENY_TOOLS, WORKER_CONTRACT } from '../../../orrery-harness/src/shared/child-scope.js'

const id = 'child-prompt'
const prompt = 'child-prompt-probe'
// The key sentence is taken from the product constant, so a contract reword
// can never leave this scenario asserting a stale string.
const CONTRACT_KEY_SENTENCE = WORKER_CONTRACT.split('\n').filter(Boolean)[0]

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (history.includes('CHILD_MARKER_OK') && !history.includes('child-prompt-probe')) {
    return textChunks('CHILD_MARKER_OK: child finished')
  }
  if (lastRole === 'tool') {
    return textChunks('parent observed child result')
  }
  if (history.includes('child-prompt-probe')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      prompt: 'TASK: reply with the exact marker text CHILD_MARKER_OK\nDELIVERABLE: the marker line\nSCOPE: nothing else\nVERIFY: the reply contains the marker\nSTOP WHEN: the marker is sent',
      task_summary: 'probe child',
    })
  }
  return textChunks('unhandled child-prompt turn')
}

function observe(obs) {
  // The agent request delivers the rendered system prompt IN-HISTORY as a
  // system-role message (dsh-agent-loop's `systemPrompt.project`), while the
  // sidecar requests pass it in `system`. Concatenate both so the assertions
  // hold however the request carries it (same precedent as delegate.js).
  const system = `${obs.system ?? ''}\n${obs.transcript ?? ''}`
  return {
    // A child request: its transcript carries the delegation prompt (which
    // mentions the marker) but never the parent's probe prompt. The intent
    // classifier's sidecar ALSO classifies the delegation prompt, so it is
    // excluded explicitly (same predicate the mock's decide dispatches on).
    isChildRequest:
      obs.transcript.includes('CHILD_MARKER_OK') &&
      !obs.transcript.includes('child-prompt-probe') &&
      !obs.system.includes('You classify a user prompt'),
    sawDoctrine: system.includes('Orchestration Doctrine'),
    sawTargets: system.includes('Delegation targets'),
    sawLanes: system.includes('Worktree lanes'),
    sawWorkerContract: system.includes(CONTRACT_KEY_SENTENCE),
  }
}

function assert(run) {
  const requests = run.requests
  run.check('parent emitted a delegate tool call', requests.some((r) => r.emittedNames?.includes('delegate')))
  run.check('child session created as subagent at depth 1', run.created.some((r) => r.origin === 'subagent' && r.depth === 1), JSON.stringify(run.created))

  // The delegated child's FIRST request is the surface under test.
  const child = requests.find((r) => r.isChildRequest)
  run.check('child first request observed', Boolean(child), JSON.stringify(requests.map((r) => ({ seq: r.seq, lastUser: r.lastUser }))))
  run.check('child system prompt has no Orchestration Doctrine section', Boolean(child) && !child.sawDoctrine)
  run.check('child system prompt has no Delegation targets section', Boolean(child) && !child.sawTargets)
  run.check('child system prompt has no Worktree lanes section or board', Boolean(child) && !child.sawLanes)
  const denied = child ? child.tools.filter((name) => CHILD_DENY_TOOLS.includes(name)) : CHILD_DENY_TOOLS
  run.check('child tools payload excludes every orchestrator-only tool', Boolean(child) && denied.length === 0, denied.join(','))
  run.check('child system prompt carries the worker contract', Boolean(child) && child.sawWorkerContract)

  // Sanity: the suppression is child-scoped only — the parent still sees the
  // orchestrator sections and keeps the delegate tool.
  const parent = requests.find((r) => r.emittedNames?.includes('delegate'))
  run.check('parent system prompt still carries the doctrine', Boolean(parent?.sawDoctrine))
  run.check('parent system prompt still carries the delegation targets', Boolean(parent?.sawTargets))
  run.check('parent still has the delegate tool', Boolean(parent?.tools.includes('delegate')))

  run.check('parent observed the child result', run.stdout.includes('parent observed child result'), run.stdout.slice(-400))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
