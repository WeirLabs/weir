// Scenario: grouped — supervised group with a provider-error retry, settlement
// notices, and the group-settled signal. Migrated from mock-llm.js
// decideGrouped / run.mjs assertGrouped (D1/D2).
import { errorChunks, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'grouped'
const prompt = 'grouped-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Child A: first turn fails with a provider error; the coordinator's retry
  // message (RETRY_MESSAGE) then gets a clean terminal report.
  if (history.includes('GROUPED_CHILD_A') && !history.includes('grouped-probe')) {
    if (history.includes('Continue the task now, and remember to end')) {
      return textChunks('STATUS: completed\nREPORT: alpha finished after one retry')
    }
    return errorChunks('simulated provider 429')
  }
  // Child B: settles on the first try.
  if (history.includes('GROUPED_CHILD_B') && !history.includes('grouped-probe')) {
    return textChunks('STATUS: completed\nREPORT: beta finished first try')
  }
  // Parent: observe the group-settled signal.
  if (history.includes('<supervised_group_settled')) {
    return textChunks('parent observed group-settled signal')
  }
  // Parent: the group call returned — pad the busy window so the headless
  // one-shot driver does not exit before the (instant-mock) children settle,
  // then end the turn and let the notices and the signal wake us.
  // History-driven on purpose (never lastRole): runtime-context snapshots
  // can interleave as user messages between the tool result and the next
  // request, and a lastRole gate would end the turn before the wait ran.
  if (history.includes('Supervised group') && !history.includes('GROUPED_WAITED')) {
    return shellCall('echo-and-wait', { text: 'GROUPED_WAITED', seconds: 1 }, 'Let supervised children settle')
  }
  if (history.includes('GROUPED_WAITED')) {
    return textChunks('group started, waiting for the settle signal')
  }
  if (history.includes('grouped-probe') && !history.includes('Supervised group')) {
    return toolCallChunks('delegate', {
      group: 'probe-group',
      tasks: [
        { category: 'quick', prompt: 'GROUPED_CHILD_A\nTASK: probe alpha\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
        { category: 'quick', prompt: 'GROUPED_CHILD_B\nTASK: probe beta\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
      ],
    })
  }
  return textChunks('unhandled grouped turn')
}

function observe(obs) {
  return {
    sawGroupProbe: obs.transcript.includes('grouped-probe'),
    groupRetrySeen: obs.transcript.includes('Continue the task now, and remember to end'),
    mergedAlphaSeen: obs.transcript.includes('alpha finished after one retry'),
    mergedBetaSeen: obs.transcript.includes('beta finished first try'),
    groupSettledSignalSeen: obs.transcript.includes('<supervised_group_settled'),
  }
}

function assert(run) {
  const requests = run.requests
  const events = run.events
  run.check('parent delegated a supervised group', requests.some((r) => r.emitted.includes('tool-call') && r.sawGroupProbe), JSON.stringify(requests.map((r) => r.emitted)))
  run.check('provider-error retry path exercised', requests.some((r) => r.groupRetrySeen), JSON.stringify(requests.map((r) => r.groupRetrySeen)))
  run.check('built-in settlement notices reached the parent session', events.some((e) => e.type === 'user/message' && e.source === 'subagent-settled'), JSON.stringify(events.filter((e) => e.type === 'user/message').map((e) => [e.session, e.source])))
  run.check('member reports arrived via the built-in settlement notices', requests.some((r) => r.mergedAlphaSeen) && requests.some((r) => r.mergedBetaSeen), JSON.stringify(requests.map((r) => [r.mergedAlphaSeen, r.mergedBetaSeen])))
  run.check('one-line group-settled signal reached the parent', requests.some((r) => r.groupSettledSignalSeen), JSON.stringify(requests.map((r) => r.groupSettledSignalSeen)))
  run.check('parent observed the group-settled signal', run.stdout.includes('parent observed group-settled signal'), run.stdout.slice(-400))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
