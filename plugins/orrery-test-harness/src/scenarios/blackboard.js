// Scenario: blackboard — slice 2 end to end. A delegated child writes a board
// entry; the parent lists + reads it back (reuse evidence). The parent then
// holds the write token for contend.key IN ITS OWN TURN and delegates a
// continuable contender child, whose apply is refused and auto-subscribed.
// The parent's write consumes the token and releases the key; the subscribed
// child is between turns (its live agent handle is dropped), so the release
// notice wakes it through the subagents channel — the child's next turn sees
// the notice, re-applies successfully, and reports. Finally the parent drives
// the blackboard remote probe (the pinned panel wire contract) against the
// same board. The prompt-section assertions pin the injected contracts
// (design D7): the main agent carries the retrieval discipline, category
// children carry the write contract, and neither audience sees the other's.
import { lastOfRole, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'
import { BLACKBOARD_WRITE_CONTRACT_HEADING } from '../../../orrery-harness/src/blackboard/contracts.js'
import { RELEASE_NOTICE_PREFIX } from '../../../orrery-harness/src/blackboard/notify.js'

const id = 'blackboard'
const prompt = 'blackboard-probe'
const CONTENT = 'BB_CONTENT_PAYLOAD'
const CONTEND_CONTENT = 'BB_CONTEND_CONTENT'
const CONTINUABLE_RESULT_MARKER = 'continuable child(ren); each result arrives in a built-in settlement notice'
const RETRIEVAL_MARKER = 'Before delegating: run blackboard_list'

const WRITER_SUMMARY = { fact: 'the session runtime layout lives here', cost: 'one probe', reVerify: 'blackboard_list writer.key' }
const HOLDER_SUMMARY = { fact: 'the contended layout entry', cost: 'one probe', reVerify: 'blackboard_list contend.key' }

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')

  // Child W (one-shot writer): create writer.key, then settle with the marker.
  // The self-reply guards key on assistant-prefixed transcript lines — the
  // bare markers also appear inside the delegation prompt, which must never
  // count as a reply.
  if (history.includes('BB_WRITER') && !history.includes(prompt)) {
    if (lastTool.includes('Created entry')) return textChunks('BB_WROTE')
    if (history.includes('assistant:\nBB_WROTE')) return textChunks('BB_WROTE: writing done')
    return toolCallChunks('blackboard_write', { key: 'writer.key', entryType: 'map', summary: WRITER_SUMMARY, content: CONTENT })
  }

  // Child H (continuable contender): apply contend.key — the parent holds it,
  // so the apply fails and subscribes this child. After the release notice
  // wakes a new turn, re-apply (now granted) and report.
  if (history.includes('BB_HOLDER') && !history.includes(prompt)) {
    if (history.includes(RELEASE_NOTICE_PREFIX)) {
      if (lastTool.includes('Write authority granted')) return textChunks('BB_GOT_KEY')
      if (history.includes('assistant:\nBB_GOT_KEY')) return textChunks('BB_GOT_KEY: re-acquired')
      return toolCallChunks('blackboard_apply', { key: 'contend.key' })
    }
    if (lastTool.includes('held by another agent')) return textChunks('BB_CONTENDED')
    if (history.includes('assistant:\nBB_CONTENDED')) return textChunks('BB_CONTENDED: subscribed, waiting')
    return toolCallChunks('blackboard_apply', { key: 'contend.key' })
  }

  // Parent brain.
  if (history.includes('BB_PARENT_DONE')) return textChunks('blackboard scenario finished')
  // Phase 5: the contender re-acquired the key — drive the remote probe, then finish.
  if (history.includes('BB_GOT_KEY')) {
    if (history.includes('done BB_PROBE')) return textChunks('BB_PARENT_DONE: blackboard scenario finished')
    return toolCallChunks('blackboard_remote_probe', { op: 'remote', _marker: 'BB_PROBE' })
  }
  // Phase 4: the contender was subscribed — write the entry (this consumes the
  // parent's token and releases the key to the waiting child).
  if (history.includes('BB_CONTENDED')) {
    if (lastTool.includes('Created entry')) {
      // Keep the turn alive until the child's re-acquisition notice lands:
      // ending the turn here races the headless quiescence exit against the
      // child's deferred wake (S10.6, the continuable pattern).
      const verdict = waitForMarker(history, 'BB_GOT_KEY')
      if (verdict.state === 'wait') return verdict.chunks
      return textChunks('waiting for the contender to re-apply')
    }
    return toolCallChunks('blackboard_write', { key: 'contend.key', entryType: 'map', summary: HOLDER_SUMMARY, content: CONTEND_CONTENT })
  }
  // Phase 3: the parent holds the token — delegate the contender (continuable).
  if (lastTool.includes('Write authority granted for "contend.key"') && !history.includes(CONTINUABLE_RESULT_MARKER)) {
    return toolCallChunks('delegate', {
      category: 'quick',
      mode: 'continuable',
      prompt: 'BB_HOLDER\nTASK: acquire the write authority for the blackboard key contend.key with blackboard_apply. If the apply fails because another agent holds it, you are subscribed and will be notified when it is released — reply with the exact marker text BB_CONTENDED either way and stop.\nDELIVERABLE: the marker line\nSCOPE: nothing else\nVERIFY: the reply contains the marker\nSTOP WHEN: the marker is sent',
      task_summary: 'blackboard contender child',
    })
  }
  // Phase 2: the writer's entry is on the board — list, read, then hold the
  // token for the contention round.
  if (history.includes('BB_WROTE')) {
    if (!history.includes('- writer.key (map)')) return toolCallChunks('blackboard_list', { query: 'writer' })
    if (!history.includes(CONTENT)) return toolCallChunks('blackboard_read', { keys: ['writer.key'] })
    if (!history.includes('Write authority granted for "contend.key"')) return toolCallChunks('blackboard_apply', { key: 'contend.key' })
    // Token held and the contender delegated: one pad keeps the process
    // alive while the child's first turn runs, then end the turn — the
    // contender's settlement notice wakes the next one (the continuable
    // pattern, S10.6).
    const verdict = waitForMarker(history, 'BB_CONTENDED', 1)
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('waiting for the contender to be refused; the settlement notice will wake this turn')
  }
  // Phase 1: delegate the writer child (one-shot).
  return toolCallChunks('delegate', {
    category: 'quick',
    prompt: `BB_WRITER\nTASK: create the blackboard entry writer.key with blackboard_write (entryType map, summary fact "the session runtime layout lives here", cost "one probe", reVerify "blackboard_list writer.key", content "${CONTENT}"), then reply with the exact marker text BB_WROTE\nDELIVERABLE: the marker line\nSCOPE: nothing else\nVERIFY: the reply contains the marker\nSTOP WHEN: the marker is sent`,
    task_summary: 'blackboard writer child',
  })
}

function observe(obs) {
  const history = obs?.transcript ?? ''
  // The agent request delivers the rendered system prompt IN-HISTORY as a
  // system-role message, while sidecar requests pass it in `system` — the
  // child-prompt scenario's concatenation precedent.
  const system = `${obs.system ?? ''}\n${history}`
  const isParentRequest = history.includes(prompt)
  return {
    writerChild: history.includes('BB_WRITER') && !history.includes(prompt),
    holderChild: history.includes('BB_HOLDER') && !history.includes(prompt),
    sawWriteContract: system.includes(BLACKBOARD_WRITE_CONTRACT_HEADING),
    sawRetrieval: system.includes(RETRIEVAL_MARKER),
    parentReusedList: isParentRequest && history.includes('- writer.key (map)'),
    parentReusedRead: isParentRequest && history.includes(CONTENT),
    parentHeldToken: isParentRequest && history.includes('Write authority granted for "contend.key"'),
    parentWroteContend: isParentRequest && history.includes('Created entry "contend.key"'),
    contended: history.includes('held by another agent'),
    sawReleaseNotice: history.includes(RELEASE_NOTICE_PREFIX),
    reacquired: history.includes(RELEASE_NOTICE_PREFIX) && history.includes('Write authority granted for "contend.key"'),
    probeOk: isParentRequest
      && /done BB_PROBE:.*"listEntries":2/.test(history)
      && /done BB_PROBE:.*"readContent":"BB_CONTENT_PAYLOAD"/.test(history)
      && /done BB_PROBE:.*"acquired":true/.test(history)
      && /done BB_PROBE:.*"tokenString":true/.test(history)
      && /done BB_PROBE:.*"writeRevision":1/.test(history)
      && /done BB_PROBE:.*"removeOk":true/.test(history)
      && /done BB_PROBE:.*"blockedWithoutAuthority":true/.test(history)
      && /done BB_PROBE:.*"entriesAfter":2/.test(history),
    childWrote: history.includes('Created entry "writer.key"'),
  }
}

function assert(run) {
  const requests = run.requests
  const created = run.created
  const events = run.events
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
  run.check('the flow completed', run.stdout.includes('BB_PARENT_DONE'), run.stdout.slice(-400))

  run.check('writer and contender children created as subagents at depth 1', created.filter((r) => r.origin === 'subagent' && r.depth === 1).length >= 2, JSON.stringify(created))
  run.check('the writer child created its entry with the blackboard tool', requests.some((r) => r.writerChild && r.childWrote), JSON.stringify(requests.filter((r) => r.writerChild).map((r) => r.lastTool.slice(0, 80))))

  // Reuse chain: the parent listed and read the child's entry by key.
  run.check('the parent listed the writer entry (child writes → parent list reuse)', requests.some((r) => r.parentReusedList), '')
  run.check('the parent read the writer entry content (child writes → parent read reuse)', requests.some((r) => r.parentReusedRead), '')

  // Contention + subscription + release notification delivery.
  run.check('the parent held the write token before delegating the contender', requests.some((r) => r.parentHeldToken), '')
  run.check('the contender child was refused and auto-subscribed', requests.some((r) => r.holderChild && r.contended), '')
  run.check('the parent wrote the contended entry, consuming the token', requests.some((r) => r.parentWroteContend), '')
  run.check('the release notice reached the subscribed child between turns', requests.some((r) => r.holderChild && r.sawReleaseNotice), '')
  run.check('the child re-applied after the notice and reported the re-acquisition', requests.some((r) => r.holderChild && r.reacquired), '')

  // Cordis release channel (audit shape, no session-log write).
  const releases = events.filter((e) => e.type === 'orrery/blackboard/released' && e.data?.key === 'contend.key')
  run.check('the release was emitted on the cordis channel with the write reason', releases.length === 1 && releases[0].data?.reason === 'write', JSON.stringify(releases))
  run.check('the release named the subscribed contender child as a subscriber', releases.length === 1 && Array.isArray(releases[0].data?.subscriberIds) && releases[0].data.subscriberIds.some((entry) => typeof entry === 'string'), JSON.stringify(releases))

  // The pinned remote wire contract (design D8) against the live board.
  run.check('the remote probe returned the pinned shapes end to end', requests.some((r) => r.probeOk), '')

  // Agent contracts (design D7): the right section for each audience, never the other's.
  const parent = requests.find((r) => r.emittedNames?.includes('delegate'))
  run.check('the parent system prompt carries the retrieval discipline', Boolean(parent?.sawRetrieval))
  run.check('the parent system prompt carries no write contract', Boolean(parent) && !parent.sawWriteContract)
  run.check('the category children carry the write contract section', requests.some((r) => r.writerChild && r.sawWriteContract) && requests.some((r) => r.holderChild && r.sawWriteContract), '')
  run.check('the children carry no retrieval discipline', requests.some((r) => r.writerChild && !r.sawRetrieval) && requests.some((r) => r.holderChild && !r.sawRetrieval), '')
}

export default { id, prompt, decide, observe, assert, env: { ORRERY_IT_BLACKBOARD: '1' } }
