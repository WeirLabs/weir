// Scenario: background — run_in_background delegation; the compact job notice
// reaches the parent while the full report stays pull-only. Migrated from
// mock-llm.js decideBackground / run.mjs assertBackground (D1/D2).
import { lastOfRole, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'background'
const prompt = 'background-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Background child brain: produce the report marker.
  if (history.includes('BACKGROUND_CHILD') && !history.includes('background-probe')) {
    return textChunks('BACKGROUND_CHILD_MARKER: background child finished its work')
  }
  // Parent: keep the turn alive until the compact job notice arrives, then
  // observe it WITHOUT pulling — the pull-only discipline is the contract.
  // (The full report must never enter the parent context.)
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('Delegated in the background')) {
      return shellCall('echo-and-wait', { text: 'WAITED_FOR_JOB', seconds: 1 }, 'Keep the turn alive until the background job settles')
    }
    if (toolText.includes('WAITED_FOR_JOB')) {
      if (history.includes('finished [status: completed]')) {
        return textChunks('parent observed the compact notice; the full report stays pull-only')
      }
      return shellCall('echo-and-wait', { text: 'WAITED_FOR_JOB', seconds: 1 }, 'Wait for the job notice')
    }
    return textChunks('unhandled background tool turn')
  }
  if (history.includes('finished [status: completed]') && history.includes('background job')) {
    return textChunks('parent observed the compact notice; the full report stays pull-only')
  }
  if (history.includes('background-probe') && !history.includes('BACKGROUND_CHILD')) {
    return toolCallChunks('delegate', { agent: 'finder', prompt: 'BACKGROUND_CHILD\nTASK: finish the background work\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done', run_in_background: true })
  }
  return textChunks('unhandled background turn')
}

function observe(obs) {
  return {
    sawBackgroundProbe: obs.transcript.includes('background-probe'),
    backgroundChildSeen: obs.transcript.includes('BACKGROUND_CHILD') && !obs.transcript.includes('background-probe'),
    backgroundMarkerInParentContext: obs.transcript.includes('BACKGROUND_CHILD_MARKER') && obs.transcript.includes('background-probe'),
  }
}

function assert(run) {
  const requests = run.requests
  const inserted = run.inboxInserted
  run.check('parent delegated with run_in_background', requests.some((r) => r.emitted.includes('tool-call') && r.sawBackgroundProbe), JSON.stringify(requests.map((r) => r.emitted)))
  run.check('background child ran and produced its marker', requests.some((r) => r.backgroundChildSeen), JSON.stringify(requests.map((r) => r.backgroundChildSeen)))
  run.check('compact job notice reached the parent', inserted.some((r) => (r.text ?? '').includes('finished [status: completed]')), JSON.stringify(inserted.map((r) => (r.text ?? '').slice(0, 80))))
  run.check('full report stayed out of the parent context (pull-only)', !requests.some((r) => r.backgroundMarkerInParentContext), JSON.stringify(requests.map((r) => r.backgroundMarkerInParentContext)))
  run.check('parent observed the compact notice', run.stdout.includes('parent observed the compact notice'), run.stdout.slice(-400))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
