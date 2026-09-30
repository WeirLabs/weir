// Scenario: terminate — a running member is interrupted for real, the settle
// signal still arrives. Migrated from mock-llm.js decideTerminate / run.mjs
// assertTerminate (D1/D2).
import { lastOfRole, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'terminate'
const prompt = 'terminate-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Child A: stays busy so the parent can interrupt it mid-flight.
  if (history.includes('TERMINATE_CHILD_A') && !history.includes('terminate-probe')) {
    return shellCall('stay-busy', { seconds: 30 }, 'Stay busy so the parent can interrupt')
  }
  // Child B: completes immediately.
  if (history.includes('TERMINATE_CHILD_B') && !history.includes('terminate-probe')) {
    return textChunks('STATUS: completed\nREPORT: beta finished for termination count')
  }
  // Parent: wait briefly, terminate the busy member, then observe the signal.
  // Keyed off history: the child's settlement notice may interleave as a user
  // message between the sleep result and the terminate call.
  if (history.includes('<supervised_group_settled')) {
    return textChunks('parent observed the settle signal after termination')
  }
  if (history.includes('TERMINATE_WAITED') && !history.includes('interrupted while running') && !history.includes('state bookkeeping')) {
    return toolCallChunks('terminate_agent', { agent: 'alpha' })
  }
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('Supervised group')) {
      return shellCall('echo-and-wait', { text: 'TERMINATE_WAITED', seconds: 1 }, 'Let the busy child start, then interrupt it')
    }
    if (toolText.includes('interrupted while running')) {
      // Keep the turn alive: the aborted member's settlement notice and the
      // gated group-settled signal land right after the interrupt result.
      return shellCall('echo-and-wait', { text: 'TERMINATE_DONE', seconds: 1 }, 'Let the final notice and signal land')
    }
    if (toolText.includes('TERMINATE_DONE')) {
      return textChunks('parent terminated alpha; waiting for the settle signal')
    }
    return textChunks('unhandled terminate tool turn')
  }
  if (history.includes('terminate-probe') && !history.includes('Supervised group')) {
    return toolCallChunks('delegate', {
      group: 'probe-group',
      tasks: [
        { category: 'quick', name: 'alpha', prompt: 'TERMINATE_CHILD_A\nTASK: stay busy\nDELIVERABLE: nothing\nSCOPE: nothing else\nVERIFY: n/a\nSTOP WHEN: interrupted' },
        { category: 'quick', name: 'beta', prompt: 'TERMINATE_CHILD_B\nTASK: finish\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
      ],
    })
  }
  return textChunks('unhandled terminate turn')
}

function observe(obs) {
  return {
    sawTerminateProbe: obs.transcript.includes('terminate-probe'),
    groupSettledSignalSeen: obs.transcript.includes('<supervised_group_settled'),
  }
}

function assert(run) {
  const requests = run.requests
  const events = run.events
  run.check('parent delegated a supervised group', requests.some((r) => r.emitted.includes('tool-call') && r.sawTerminateProbe), JSON.stringify(requests.map((r) => r.emitted)))
  run.check('running member was interrupted for real (child turn aborted)', events.some((e) => e.type === 'turn/end' && e.reason === 'aborted'), JSON.stringify(events.filter((e) => e.type === 'turn/end').map((e) => [e.session, e.reason])))
  run.check('group-settled signal arrived after termination', requests.some((r) => r.groupSettledSignalSeen), JSON.stringify(requests.map((r) => r.groupSettledSignalSeen)))
  run.check('parent observed the settle signal after termination', run.stdout.includes('parent observed the settle signal after termination'), run.stdout.slice(-400))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
