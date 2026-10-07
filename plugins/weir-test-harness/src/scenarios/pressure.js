// Scenario: pressure — context-pressure advisory, compaction, post-compaction
// continuation. Migrated from mock-llm.js decidePressure / run.mjs
// assertPressure (D1/D2). The small context window (WEIR_IT_WINDOW) travels
// with the scenario as an env overlay.
import { textChunks, transcript } from '../mock-kit.js'

const id = 'pressure'
const prompt = 'pressure-probe'
const env = { WEIR_IT_WINDOW: '2000' }

const LONG_FILLER = 'Filler line to raise pressure. '.repeat(600)

function decide(options, obs) {
  if (options.purpose === 'compaction') {
    return textChunks('SUMMARY: the probe task was in progress with no errors.')
  }
  const history = obs?.transcript ?? transcript(options)
  if (history.includes('Resume the task from the compaction summary')) {
    return textChunks('resumed after compaction')
  }
  if (history.includes('pressure-probe')) {
    return textChunks(LONG_FILLER)
  }
  return textChunks('unhandled pressure turn')
}

function observe(obs) {
  return {
    pressureAdvisorySeen: obs.transcript.includes('<context_pressure>'),
  }
}

function assert(run) {
  const requests = run.requests
  const events = run.events
  const compacted = events.some((e) => typeof e.type === 'string' && e.type.startsWith('compaction/'))
  const inboxInserted = run.inboxInserted
  const resumed =
    requests.some((r) => (r.lastUser ?? '').includes('Resume the task from the compaction summary')) ||
    inboxInserted.some((r) => (r.text ?? '').includes('Resume the task from the compaction summary'))
  run.check('pressure advisory or forced compaction fired', requests.some((r) => r.pressureAdvisorySeen) || compacted, JSON.stringify(requests.map((r) => [r.purpose, r.pressureAdvisorySeen])))
  run.check('compaction ran at the boundary (durable compaction/* events)', compacted)
  run.check('summarizer model call was served', requests.some((r) => r.purpose === 'compaction'))
  run.check('post-compaction continuation resumed the task', resumed, JSON.stringify(requests.map((r) => r.lastUser)))
}

export default { id, prompt, env, decide, observe, assert }
