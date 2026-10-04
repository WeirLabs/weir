// A real background delegate owns the wake-up while the parent's todo waits.
// Headless quiescence exits the process at turn end even with the child job
// still running (S10.6), so this scenario asserts the suppression itself —
// the turn stops with an unfinished todo and NO continuation enters the log —
// which is exactly what regresses if the jobs-aware check is removed. The
// settle-and-resume half is covered by the todo-driver unit tests.
import { shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'jobs-aware-todo'
const prompt = 'jobs-aware-todo-probe'
const childMarker = 'JOBS_AWARE_CHILD'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (history.includes(childMarker) && !history.includes(prompt)) {
    if (obs?.lastTool) return textChunks('JOBS_AWARE_REPORT: child settled')
    return shellCall('echo-and-wait', { text: 'CHILD_WAIT_DONE', seconds: 2 }, 'Keep the background job running while the parent stops')
  }
  if (history.includes('<todo_continuation>')) {
    if (history.includes('JOBS_AWARE_DONE')) return textChunks('JOBS_AWARE_DONE: continued after settlement')
    return toolCallChunks('todo_write', { todos: [{ content: 'finish after the background job', status: 'completed' }] })
  }
  if (history.includes('Delegated in the background')) return textChunks('Waiting for the background job settlement notice.')
  // Marker-based dispatch: runtime-context injections can sit between the tool
  // result and this request, so the last message is not reliably the tool's.
  if (obs?.lastTool?.includes('Updated todo list')) {
    return toolCallChunks('delegate', {
      agent: 'finder',
      prompt: `TASK: Wait briefly then finish ${childMarker}\nDELIVERABLE: the report marker\nSCOPE: no file changes\nVERIFY: wait finished\nSTOP WHEN: report emitted`,
      run_in_background: true,
    })
  }
  return toolCallChunks('todo_write', { todos: [{ content: 'finish after the background job', status: 'pending' }] })
}

function observe(obs) {
  return {
    jobsAwareParent: obs.transcript.includes(prompt),
    jobsAwareChild: obs.transcript.includes(childMarker) && !obs.transcript.includes(prompt),
    continuationSeen: obs.transcript.includes('<todo_continuation>'),
    settlementSeen: obs.transcript.includes('finished [status: completed]'),
  }
}

function assert(run) {
  const parent = run.events.find((event) => event.type === 'user/message' && event.text?.includes(prompt))?.session
  const events = run.events.filter((event) => event.session === parent)
  const continuations = events.filter((event) => event.type === 'user/message' && event.text?.includes('<todo_continuation>'))
  run.check('parent registered an unfinished todo', events.some((event) => event.type === 'todo/write' && event.data?.todos?.some((todo) => todo.status === 'pending')))
  run.check('parent delegated a background child', run.requests.some((r) => r.jobsAwareParent && r.emittedNames.includes('delegate')), JSON.stringify(run.requests.map((r) => r.emittedNames)))
  run.check('parent ended its turn while the child job was running', events.some((event) => event.type === 'turn/end' && event.reason === 'completed') && !events.some((event) => event.type === 'user/message' && event.text?.includes('finished [status: completed]')), JSON.stringify(events.map((e) => [e.type, e.reason ?? e.source ?? ''])))
  run.check('no todo continuation entered the parent log at all', continuations.length === 0, JSON.stringify(events))
  run.check('continuation never reached the model', !run.requests.some((r) => r.jobsAwareParent && r.continuationSeen))
  run.check('headless run exited cleanly', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
