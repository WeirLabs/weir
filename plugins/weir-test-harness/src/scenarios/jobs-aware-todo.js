// A foreground outer owner keeps headless alive while the tested parent stops
// with its real background delegate still running. Only the owner drains the job.
import { shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'jobs-aware-todo'
const prompt = 'jobs-aware-todo-probe'
const childMarker = 'JOBS_AWARE_CHILD'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (history.includes('jobs-aware-outer-owner')) {
    return history.includes('jobs-aware-owner-finished') || history.includes('jobs-aware-owner-failed')
      ? textChunks('jobs-aware-outer-finished') : toolCallChunks('jobs_aware_todo_probe', {})
  }
  if (history.includes(childMarker) && !history.includes(prompt)) {
    if (obs?.lastTool) return textChunks('JOBS_AWARE_REPORT: child settled')
    return shellCall('echo-and-wait', { text: 'CHILD_WAIT_DONE', seconds: 2 }, 'Keep the background job running while the parent stops')
  }
  if (history.includes('<todo_continuation>')) {
    if (history.includes('JOBS_AWARE_DONE') || obs?.lastTool?.includes('0 pending, 0 in progress, 1 completed')) return textChunks('JOBS_AWARE_DONE: unexpected continuation')
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
  const before = run.records.find((r) => r.kind === 'jobs-aware-before-wait' && r.session === parent)
  const after = run.records.find((r) => r.kind === 'jobs-aware-after-wait' && r.session === parent)
  const settlement = run.records.find((r) => r.kind === 'jobs-aware-settlement' && r.session === parent)
  run.check('parent registered an unfinished todo', events.some((event) => event.type === 'todo/write' && event.data?.todos?.some((todo) => todo.status === 'pending')))
  run.check('parent delegated a background child', run.requests.some((r) => r.jobsAwareParent && r.emittedNames.includes('delegate')), JSON.stringify(run.requests.map((r) => r.emittedNames)))
  run.check('parent ended its turn while the child job was running', events.some((event) => event.type === 'turn/end' && event.reason === 'completed') && !events.some((event) => event.type === 'user/message' && event.text?.includes('finished [status: completed]')) && before?.completed === true && before?.todoPending === true && before?.noContinuation === true && before?.job?.status === 'running' && before?.job?.owner === parent, JSON.stringify(before))
  run.check('no todo continuation entered the parent log at all', continuations.length === 0, JSON.stringify(events))
  run.check('continuation never reached the model', !run.requests.some((r) => r.jobsAwareParent && r.continuationSeen))
  run.check('no todo continuation entered the parent inbox', !run.inboxInserted.some((r) => r.session === parent && r.text.includes('<todo_continuation>')) && before?.noInboxContinuation === true && after?.noInboxContinuation === true)
  run.check('outer owner drained the same real job to completed', after?.job?.id === before?.job?.id && after?.job?.status === 'completed' && after?.job?.owner === parent && after?.endSeq === before?.endSeq && after?.noContinuation === true && after?.todoPending === true, JSON.stringify(after))
  run.check('native job settlement was awaited, not teardown', settlement?.job?.id === before?.job?.id && settlement?.job?.status === 'completed' && settlement?.cause === 'producer' && settlement?.awaited === true && run.records.indexOf(settlement) > run.records.indexOf(before))
  run.check('outer owner completed without probe errors', run.stdout.includes('jobs-aware-outer-finished') && !run.records.some((r) => r.kind === 'jobs-aware-probe-error'))
  run.check('headless run exited cleanly', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt: 'jobs-aware-outer-owner', env: { WEIR_IT_JOBS_AWARE_TODO: '1' }, decide, observe, assert }
