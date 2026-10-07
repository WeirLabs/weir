// Scenario: deepwork — intent-gate directive injection + todo continuation.
// Migrated from mock-llm.js decideDeepwork / run.mjs assertDeepwork (D1/D2).
import { textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'deepwork'
const prompt = '深度工作：注册计划然后停住'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    // after a tool result
    if (history.includes('<todo_continuation>')) {
      return textChunks('All todos are complete now. Deep work run finished.')
    }
    return textChunks('Registered the plan and paused with one open todo.')
  }
  if (history.includes('<todo_continuation>')) {
    return toolCallChunks('todo_write', {
      todos: [
        { content: 'register the plan', status: 'completed' },
        { content: 'finish the run', status: 'completed' },
      ],
    })
  }
  if (history.includes('深度工作')) {
    return toolCallChunks('todo_write', {
      todos: [
        { content: 'register the plan', status: 'completed' },
        { content: 'finish the run', status: 'pending' },
      ],
    })
  }
  return textChunks('unhandled deepwork turn')
}

function observe(obs) {
  return {
    intentInjected: obs.transcript.includes('<intent-gate id="deep-work"'),
    continuationSeen: obs.transcript.includes('<todo_continuation>'),
  }
}

function assert(run) {
  const requests = run.requests
  const events = run.events
  run.check('intent-gate injected the deep-work directive', requests.some((r) => r.intentInjected), JSON.stringify(requests.map((r) => r.lastUser)))
  run.check('weir/intent-hit audit event in the durable log', events.some((e) => e.type === 'weir/intent-hit'))
  run.check('todo continuation message entered the session log', events.some((e) => e.type === 'user/message' && (e.text ?? '').includes('<todo_continuation>')), JSON.stringify(events.map((e) => [e.type, e.source, (e.text ?? '').slice(0, 40)])))
  run.check('todo continuation reached the model', requests.some((r) => r.continuationSeen))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
