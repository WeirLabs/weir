// Scenario: delegate-preflight — task 7.4 integration for the delegate
// load_skills batch preflight against the REAL mounted selection plugin.
// A parent with fixture-a accepted: a passing load_skills spawns normally
// (body prepended, maxDepth 1), while one-shot / background / supervised-
// group / three-item batches carrying an unselected skill each reject the
// whole batch with zero spawns — and the rejected supervision group's name
// is never sealed, so the SAME name spawns cleanly right after.
import { lastOfRole, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'

const id = 'delegate-preflight'
const prompt = 'preflight-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  // Transcript-based child detection (the grouped-scenario pattern): the
  // trailing catalog/reminder messages make lastUser unreliable, and this
  // scenario spawns no fork children that would share the parent history.
  const child = marker => history.includes(marker) && !history.includes(prompt)

  // ---- child brains (only reachable when the preflight passed) ----
  if (!history.includes(prompt)) {
    if (history.includes('group member alpha done')) return textChunks('STATUS: completed\nREPORT: group member alpha done')
    if (history.includes('group member beta done')) return textChunks('STATUS: completed\nREPORT: group member beta done')
    if (history.includes('MARKER_PASS')) return textChunks('MARKER_PASS')
    if (child('GROUP_CHILD_A')) return textChunks('STATUS: completed\nREPORT: group member alpha done')
    if (child('GROUP_CHILD_B')) return textChunks('STATUS: completed\nREPORT: group member beta done')
    if (child('PASS_CHILD')) return textChunks('MARKER_PASS')
    return textChunks('child idle turn')
  }

  // ---- parent brain ----
  if (lastTool.includes('LIFECYCLE_PROBE error')) return textChunks(`probe halted: ${lastTool.slice(0, 200)}`)
  if (!history.includes('done apply:[fixture-a]')) {
    return toolCallChunks('lifecycle_probe', { op: 'apply', skills: ['fixture-a'] })
  }
  if (!history.includes('MARKER_PASS')) {
    return toolCallChunks('delegate', { category: 'quick', prompt: 'PASS_CHILD\nTASK: reply with the exact marker text MARKER_PASS\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done', load_skills: ['fixture-a'] })
  }
  if (!history.includes('FAIL_ONE')) {
    return toolCallChunks('delegate', { category: 'quick', prompt: 'FAIL_ONE\nTASK: must never spawn\nDELIVERABLE: nothing\nSCOPE: nothing\nVERIFY: nothing\nSTOP WHEN: never', load_skills: ['unselected-skill'] })
  }
  if (!history.includes('FAIL_BG')) {
    return toolCallChunks('delegate', { category: 'quick', prompt: 'FAIL_BG\nTASK: must never spawn\nDELIVERABLE: nothing\nSCOPE: nothing\nVERIFY: nothing\nSTOP WHEN: never', load_skills: ['unselected-skill'], run_in_background: true })
  }
  if (!history.includes('FAIL_GROUP')) {
    return toolCallChunks('delegate', {
      group: 'preflight-g',
      tasks: [
        { category: 'quick', prompt: 'FAIL_GROUP_A\nTASK: must never spawn\nDELIVERABLE: nothing\nSCOPE: nothing\nVERIFY: nothing\nSTOP WHEN: never', load_skills: ['fixture-a'] },
        { category: 'quick', prompt: 'FAIL_GROUP_B\nTASK: must never spawn\nDELIVERABLE: nothing\nSCOPE: nothing\nVERIFY: nothing\nSTOP WHEN: never', load_skills: ['unselected-skill'] },
      ],
    })
  }
  if (!history.includes('GROUP_CHILD_A')) {
    // The rejected batch never sealed the name: the SAME group name spawns.
    return toolCallChunks('delegate', {
      group: 'preflight-g',
      tasks: [
        { category: 'quick', prompt: 'GROUP_CHILD_A\nTASK: probe alpha\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
        { category: 'quick', prompt: 'GROUP_CHILD_B\nTASK: probe beta\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
      ],
    })
  }
  if (!(history.includes('group member alpha done') && history.includes('group member beta done'))) {
    // Bounded marker wait (design D1): keep the turn alive until BOTH group
    // members settle — never an unbounded hand-rolled sleep loop, and never a
    // last-role gate an interleaved snapshot could misalign.
    const verdict = waitForMarker(history, ['group member alpha done', 'group member beta done'])
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('unhandled preflight turn')
  }
  if (!history.includes('FAIL_BATCH')) {
    return toolCallChunks('delegate', { tasks: [
      { category: 'quick', prompt: 'BATCH_A\nTASK: ok\nDELIVERABLE: nothing\nSCOPE: nothing\nVERIFY: nothing\nSTOP WHEN: never', load_skills: ['fixture-a'] },
      { category: 'quick', prompt: 'BATCH_B\nTASK: ok\nDELIVERABLE: nothing\nSCOPE: nothing\nVERIFY: nothing\nSTOP WHEN: never', load_skills: ['fixture-a'] },
      { category: 'quick', prompt: 'FAIL_BATCH\nTASK: must never spawn\nDELIVERABLE: nothing\nSCOPE: nothing\nVERIFY: nothing\nSTOP WHEN: never', load_skills: ['unselected-skill'] },
    ] })
  }
  // The FAIL_BATCH rejection rode the tool result into history (tool results
  // always precede the next request). History-driven, never lastOfRole: an
  // interleaved runtime-context user message must not skip the observation.
  if (history.includes('zero spawned')) {
    return textChunks('parent observed preflight gates')
  }
  return textChunks('unhandled preflight turn')
}

function observe(obs) {
  const system = `${obs.system ?? ''}\n${obs.transcript ?? ''}`
  return {
    preflightRejection: (obs.transcript ?? '').includes('zero spawned'),
    sawPassMarker: (obs.transcript ?? '').includes('MARKER_PASS'),
    mergedAlphaSeen: (obs.transcript ?? '').includes('group member alpha done'),
    mergedBetaSeen: (obs.transcript ?? '').includes('group member beta done'),
    skillBodyPrepended: system.includes('<skill name="fixture-a">'),
    maxDepthOne: system.includes('maxDepth: 1') || (obs.transcript ?? '').includes('maxDepth: 1'),
  }
}

function assert(run) {
  const requests = run.requests
  const created = run.created
  run.check('parent observed the preflight gates', run.stdout.includes('parent observed preflight gates'), run.stdout.slice(-400))
  run.check('the passing load_skills spawned and settled', requests.some(r => r.sawPassMarker), JSON.stringify(requests.map(r => [r.sawPassMarker])))
  run.check('the passing spawn kept the curated contract (maxDepth 1)', created.filter(r => r.origin === 'subagent').every(r => r.depth === 1), JSON.stringify(created))
  const rejections = requests.filter(r => r.preflightRejection).length
  run.check('one-shot, background, group and three-item batches each rejected with zero spawned', rejections >= 4, String(rejections))
  run.check('only the passing call and the reused group spawned children (3 total)', created.length === 3, JSON.stringify(created))
  run.check('the rejected group name spawned cleanly on reuse and settled', requests.some(r => r.mergedAlphaSeen) && requests.some(r => r.mergedBetaSeen), JSON.stringify(requests.map(r => [r.mergedAlphaSeen, r.mergedBetaSeen])))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert, env: { ORRERY_IT_LIFECYCLE: '1' } }
