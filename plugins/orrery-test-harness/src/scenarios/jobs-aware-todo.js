// A real background delegate owns the wake-up while the parent's todo waits.
import { shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'jobs-aware-todo'
const prompt = 'jobs-aware-todo-probe'
const childMarker = 'JOBS_AWARE_CHILD'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (history.includes(childMarker) && !history.includes(prompt)) {
    if (lastRole === 'tool') return textChunks('JOBS_AWARE_REPORT: child settled')
    return shellCall('echo-and-wait', { text: 'CHILD_WAIT_DONE', seconds: 2 }, 'Keep the background job running while the parent stops')
  }
  if (history.includes('<todo_continuation>')) {
    if (lastRole === 'tool') return textChunks('JOBS_AWARE_DONE: continued after settlement')
    return toolCallChunks('todo_write', { todos: [{ content: 'finish after the background job', status: 'completed' }] })
  }
  if (history.includes('finished [status: completed]')) return textChunks('Job settled; the todo is still unfinished.')
  if (history.includes('Delegated in the background')) return textChunks('Waiting for the background job settlement notice.')
  if (lastRole === 'tool') {
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
  const notice = events.findIndex((event) => event.type === 'user/message' && event.text?.includes('finished [status: completed]'))
  const continuations = events.flatMap((event, index) => event.type === 'user/message' && event.text?.includes('<todo_continuation>') ? [index] : [])
  run.check('parent registered an unfinished todo', events.some((event) => event.type === 'todo/write' && event.data?.todos?.some((todo) => todo.status === 'pending')))
  run.check('parent delegated a background child', run.requests.some((r) => r.jobsAwareParent && r.emittedNames.includes('delegate')) && run.requests.some((r) => r.jobsAwareChild))
  run.check('parent ended its turn before settlement wake-up', notice > 0 && events.slice(0, notice).some((event) => event.type === 'turn/end' && event.reason === 'completed'))
  run.check('no todo continuation entered the parent log while the job ran', notice >= 0 && !continuations.some((index) => index < notice), JSON.stringify(events))
  run.check('settlement wake-up restored exactly one continuation', continuations.length === 1 && continuations[0] > notice, JSON.stringify(events))
  run.check('continuation reached the model only after settlement', run.requests.some((r) => r.jobsAwareParent && r.continuationSeen && r.settlementSeen) && !run.requests.some((r) => r.jobsAwareParent && r.continuationSeen && !r.settlementSeen))
  run.check('todo completed after resumed work', events.some((event) => event.type === 'todo/write' && event.data?.todos?.every((todo) => todo.status === 'completed')) && run.stdout.includes('JOBS_AWARE_DONE'))
  run.check('headless run exited cleanly', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
