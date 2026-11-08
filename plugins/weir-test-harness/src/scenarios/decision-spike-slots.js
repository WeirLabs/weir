// Disposable Desktop S4a mock brain: call the real Client Slots inspector.
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'decision-spike-slots'
const prompt = 'decision-spike-slots-probe'

function decide(options, obs) {
  const lastTool = lastOfRole(options, 'tool')
  if (lastTool.includes('DECISION_SLOT_PROBE')) return textChunks(lastTool.includes('"completed":true') ? 'S4A_QUERY_DONE' : 'S4A_QUERY_FAILED')
  if (lastTool.startsWith('Error:')) return textChunks('S4A_QUERY_FAILED')
  const phase = obs.transcript.includes(`${prompt}-after`) ? 'after' : 'before'
  if (obs.transcript.includes(prompt)) return toolCallChunks('decision_slot_probe', { phase })
  return textChunks('unhandled decision slots turn')
}

function assert(run) {
  run.skip('Desktop-only scenario; run run-s4a.mjs for real GUI evidence', 'not a headless acceptance substitute')
}

export default { id, prompt, decide, assert }
