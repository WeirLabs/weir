// Scenario: semantic — the intent-gate semantic classifier arms deep-work.
// Migrated from mock-llm.js decideSemantic / run.mjs assertSemantic (D1/D2).
import { textChunks, transcript } from '../mock-kit.js'

const id = 'semantic'
// no intent keywords: only the semantic classifier can arm deep-work here
const prompt = '把这个任务从头到尾彻底完成，每一步都要拿出证据'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (history.includes('<intent-gate id="deep-work"')) {
    return textChunks('semantic mode armed, task done')
  }
  return textChunks('unhandled semantic turn')
}

function observe(obs) {
  return {
    sawClassifyCall: obs.system.includes('You classify a user prompt'),
    intentInjected: obs.transcript.includes('<intent-gate id="deep-work"'),
  }
}

function assert(run) {
  const requests = run.requests
  const events = run.events
  run.check('classifier sidecar call was served', requests.some((r) => r.sawClassifyCall), JSON.stringify(requests.map((r) => [r.purpose, r.sawClassifyCall])))
  run.check('semantic hit injected the deep-work directive', requests.some((r) => r.intentInjected), JSON.stringify(requests.map((r) => r.lastUser)))
  run.check('weir/intent-classify audit event names the hit', events.some((e) => e.type === 'weir/intent-classify' && e.data?.hit === 'deep-work'), JSON.stringify(events.filter((e) => e.type.startsWith('weir/')).map((e) => [e.type, e.data])))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
