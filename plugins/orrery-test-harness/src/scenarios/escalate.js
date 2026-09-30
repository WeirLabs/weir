// Scenario: escalate — a deep child returns ESCALATE and is respawned at
// deep-plus with the findings. Migrated from mock-llm.js decideEscalate /
// run.mjs assertEscalate (D1/D2).
import { lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'escalate'
const prompt = 'escalate-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // First deep child returns an ESCALATE; the respawned deep-plus child settles.
  if (history.includes('ESCALATE_CHILD') && !history.includes('escalate-probe')) {
    if (history.includes('escalation_findings')) return textChunks('escalated child settled properly')
    return textChunks('ESCALATE: deep-plus\nfirst pass hit a boundary')
  }
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('escalated to deep-plus')) return textChunks('parent observed the escalation respawn')
    return textChunks('unhandled escalate tool turn')
  }
  if (history.includes('escalate-probe') && !history.includes('ESCALATE_CHILD')) {
    return toolCallChunks('delegate', { category: 'deep', prompt: 'ESCALATE_CHILD\nTASK: probe escalation\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' })
  }
  return textChunks('unhandled escalate turn')
}

function observe(obs) {
  return {
    sawEscalateProbe: obs.transcript.includes('escalate-probe'),
    escalationFindingsSeen: obs.transcript.includes('escalation_findings'),
  }
}

function assert(run) {
  const requests = run.requests
  run.check('parent delegated a deep child', requests.some((r) => r.emitted.includes('tool-call') && r.sawEscalateProbe), JSON.stringify(requests.map((r) => r.emitted)))
  run.check('respawned child received the escalation findings', requests.some((r) => r.escalationFindingsSeen), JSON.stringify(requests.map((r) => r.escalationFindingsSeen)))
  run.check('parent observed the escalation respawn', run.stdout.includes('parent observed the escalation respawn'), run.stdout.slice(-400))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
