// Scenario: continuable — mode: 'continuable' delegation returns a stable
// childId immediately (no jobs wrapper); the first result arrives in a
// built-in settlement notice; a send_message follow-up starts a second turn
// with the prior context intact, and its settlement notice arrives too.
// Mirrors the grouped/background scenario conventions (D1/D2).
import { textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'

const id = 'continuable'
const prompt = 'continuable-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Child brain: the first turn answers the first marker; the follow-up turn
  // (the parent's send_message) answers with the second marker — the original
  // delegation prompt is still in its context.
  if (history.includes('CONTINUABLE_CHILD') && !history.includes('continuable-probe')) {
    if (history.includes('CONTINUABLE_FOLLOWUP')) {
      return textChunks('CONTINUABLE_SECOND_RESULT: follow-up answered with prior context intact')
    }
    return textChunks('CONTINUABLE_FIRST_RESULT: first turn done')
  }
  // Parent: both rounds observed once the second settlement notice lands.
  if (history.includes('CONTINUABLE_SECOND_RESULT')) {
    return textChunks('parent observed both continuable settlements')
  }
  // Parent: the first settlement notice arrived on the built-in channel —
  // follow up with send_message to the child id the notice names.
  if (history.includes('CONTINUABLE_FIRST_RESULT') && !history.includes('CONTINUABLE_FOLLOWUP')) {
    const match = history.match(/Background subagent ([0-9a-f-]{36}) finished/)
    if (!match) return textChunks('continuable child id not found in the settlement notice')
    return toolCallChunks('send_message', { agent_id: match[1], message: 'CONTINUABLE_FOLLOWUP: answer with the second marker' })
  }
  // Parent: the follow-up was sent — end the turn and let the second
  // settlement notice wake the session (it persists into the inbox, S10.6).
  if (history.includes('CONTINUABLE_FOLLOWUP')) {
    return textChunks('continuable follow-up sent; waiting for the second settlement notice')
  }
  // Parent: the delegation returned the child id — pad the busy window until
  // the first settlement notice lands. Bounded marker wait (design D1),
  // never lastRole: a runtime-context snapshot interleaving as a user message
  // between the tool result and the next request misaligned the old gate and
  // ended the turn while the child was still running.
  if (history.includes('continuable child')) {
    const verdict = waitForMarker(history, 'CONTINUABLE_FIRST_RESULT')
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('unhandled continuable tool turn')
  }
  if (history.includes('continuable-probe') && !history.includes('CONTINUABLE_CHILD')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      mode: 'continuable',
      prompt: 'CONTINUABLE_CHILD\nTASK: reply with the exact marker text CONTINUABLE_FIRST_RESULT\nDELIVERABLE: the marker line\nSCOPE: nothing else\nVERIFY: the reply contains the marker\nSTOP WHEN: the marker is sent',
      task_summary: 'continuable probe child',
    })
  }
  return textChunks('unhandled continuable turn')
}

function observe(obs) {
  return {
    sawContinuableProbe: obs.transcript.includes('continuable-probe'),
    // A child request carries the delegation prompt but never the parent's
    // probe prompt (the parent transcript carries both in its tool calls).
    childFirstTurnSeen: obs.transcript.includes('CONTINUABLE_CHILD') && !obs.transcript.includes('continuable-probe'),
    childFollowupSeen: obs.transcript.includes('CONTINUABLE_FOLLOWUP') && !obs.transcript.includes('continuable-probe'),
    firstResultInParentContext: obs.transcript.includes('CONTINUABLE_FIRST_RESULT') && obs.transcript.includes('continuable-probe'),
    secondResultInParentContext: obs.transcript.includes('CONTINUABLE_SECOND_RESULT') && obs.transcript.includes('continuable-probe'),
  }
}

function assert(run) {
  const requests = run.requests
  const events = run.events
  const settled = events.filter((e) => e.type === 'user/message' && e.source === 'subagent-settled')
  run.check('parent delegated with mode continuable', requests.some((r) => r.emittedNames?.includes('delegate') && r.sawContinuableProbe), JSON.stringify(requests.map((r) => r.emitted)))
  run.check('continuable child session created as subagent at depth 1', run.created.some((r) => r.origin === 'subagent' && r.depth === 1), JSON.stringify(run.created))
  run.check('child ran its first turn', requests.some((r) => r.childFirstTurnSeen), JSON.stringify(requests.map((r) => r.childFirstTurnSeen)))
  run.check('first built-in settlement notice reached the parent session', settled.length >= 1, JSON.stringify(events.filter((e) => e.type === 'user/message').map((e) => [e.session, e.source])))
  run.check('first result reached the parent through the notice', requests.some((r) => r.firstResultInParentContext), JSON.stringify(requests.map((r) => r.firstResultInParentContext)))
  run.check('parent followed up with send_message to the settled child', requests.some((r) => r.emittedNames?.includes('send_message')), JSON.stringify(requests.map((r) => r.emittedNames)))
  run.check('child answered the follow-up with its prior context intact', requests.some((r) => r.childFollowupSeen), JSON.stringify(requests.map((r) => r.childFollowupSeen)))
  run.check('second settlement notice reached the parent session', settled.length >= 2, JSON.stringify(settled.map((e) => (e.text ?? '').slice(0, 80))))
  run.check('second result reached the parent through the notice', requests.some((r) => r.secondResultInParentContext), JSON.stringify(requests.map((r) => r.secondResultInParentContext)))
  run.check('parent observed both continuable settlements', run.stdout.includes('parent observed both continuable settlements'), run.stdout.slice(-400))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
